import { firstValueFrom } from 'rxjs';
import { Role } from '@/interfaces';
import { ApiSurface, ReadOnlyTool, SystemHandle } from '@/catalog/tool';

/**
 * Reporting family: how busy a system was over a time range, rather than how
 * busy it is now.
 *
 * `system_info` answers the instant. Every "is it busy?" and "was it busy at
 * 3am?" question needs a series, and the series is where the cost is: the
 * middleware records a sample every few seconds, so an hour is hundreds of
 * points per metric and a week is tens of thousands. A raw series is therefore
 * never returned. What comes back is, per metric, four numbers over the whole
 * range and a fixed twelve buckets across it — bounded by construction, so the
 * result of a one-week question is the same size as the result of a one-hour
 * one.
 *
 * The metrics are DERIVED rather than passed through. `reporting.netdata_get_data`
 * answers with the graph's own dimensions — the CPU graph has one series per
 * scheduler state, the memory graph one per kind of page — and handing those to
 * a caller would be both unbounded and unanswerable. So each graph is reduced to
 * the one number the catalog asks for, the reduction is stated in the tool's
 * description, and a graph the reduction cannot be computed from is an explicit
 * marker rather than a wrong number.
 *
 * (unconfirmed) against a live middleware, and each is noted where it is relied
 * on: which dimensions each graph carries, that a data row is
 * `[timestamp, ...values]` aligned to `legend`, that the query bounds are unix
 * seconds, and the units the interface and disk graphs record. Each is read
 * defensively — a wrong reading costs a stated `unavailable` rather than a
 * plausible wrong value — except those two units, which are named in the result
 * and would be wrong rather than absent; see `NETWORK_UNIT` and
 * `DISK_THROUGHPUT_UNIT`.
 *
 * The range, the bucketing, the markers and the summary are shared by every
 * tool here, so a caller who has learned one of them has learned the family.
 * What differs per tool is the label a metric carries — the interface it was
 * measured on, or the disk — and which dimension each metric is derived from.
 *
 * Everything above holds of the two tools that read graphs. `reporting_space_trends`
 * is in this family for the question it answers and shares its range grammar,
 * and shares neither the source nor the bucketing: the system records no space
 * graph to read. What it reads instead, and why, is at {@link reportingSpaceTrends}.
 */

/**
 * How long a range covers when the caller bounds neither end.
 *
 * An hour is the window in which "is it busy?" is a question about now. A
 * longer one is asked for rather than assumed: the buckets are a fixed count,
 * so widening the range coarsens every bucket in it, and a caller who wanted
 * the last hour would get twelve two-hour averages instead.
 */
const DEFAULT_RANGE_MS = 60 * 60 * 1000;

/**
 * How many buckets the range is divided into, whatever its length.
 *
 * Fixed rather than derived from the range, which is the whole point: the
 * result of a question about a month costs the same tokens as one about an
 * hour. Twelve is enough to see a shape — a spike, a ramp, a plateau — and
 * small enough that a metric costs roughly a line.
 */
const BUCKETS = 12;

/**
 * How many interfaces the network metrics cover.
 *
 * The graph is per-interface and a system's interface listing is unbounded —
 * every port, VLAN, bridge and aggregation is a row — so without a cap a system
 * with forty of them would answer with eighty metrics. Interfaces are taken in
 * name order so the choice is deterministic rather than whichever the system
 * listed first, and `truncated_interfaces` says when the cap removed any.
 */
const MAX_INTERFACES = 6;

/**
 * How many disks the disk metrics cover.
 *
 * The same cap as {@link MAX_INTERFACES}, and for the same reason: a disk
 * shelf is unbounded, and six is a number a caller can read. It bites harder
 * here — a shelf of twenty-four disks is ordinary where twenty-four interfaces
 * are not, and this tool reports six metrics per disk rather than two — so
 * `truncated_disks` matters more than its network counterpart, and the
 * description says plainly that the answer covers the first six disks IN NAME
 * ORDER rather than the six most interesting ones.
 */
const MAX_DISKS = 6;

/** What a failure carrying no text of its own is reported as. */
const NO_REASON = 'the system reported no reason';

/** What a metric the system collected nothing for in the range is marked with. */
const NO_DATA = 'the system collected no data for this metric in this range';

/**
 * What the network metrics are marked with where the interface listing was read
 * and named nothing to graph.
 */
const NO_INTERFACES = 'the system named no interface to graph';

/**
 * What the disk metrics are marked with where the disk listing was read and
 * named nothing to graph.
 */
const NO_DISKS = 'the system named no disk to graph';

/**
 * What a metric whose graph's LEGEND did not name the dimension it is derived
 * from is marked with. Not the same as {@link NO_DATA}: the system answered
 * with a series, and it is not one this reduction can be computed from.
 *
 * Decided from the legend rather than from the samples, which is what keeps the
 * two apart — see {@link graphMetric}.
 */
const NO_DIMENSION = 'the system reported no series this metric can be derived from';

/**
 * A string a row reported, or null where it reported anything else.
 *
 * An empty string is read as no value rather than as text of no characters: an
 * interface of no characters names nothing that could be graphed. `network.ts`,
 * `system.ts` and `shares.ts` each hold this same reading under their own names,
 * and it is restated here for the reason those files give: a tool file is read
 * on its own.
 */
function textOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Why a read failed, in words.
 *
 * A rejection is not necessarily an `Error` — the client rejects with whatever
 * the transport gave it — so a bare string is read too, and so are the two
 * shapes the client documents as its own: a JSON-RPC error object carrying
 * `message`, and a middleware error object carrying `reason`. Restated from
 * `network.ts` and `system.ts` for the reason they restate it from each other.
 * The result is never empty, because a failure with no text still has to read
 * as a failure.
 */
function errorText(reason: unknown): string {
  if (reason instanceof Error) return textOrNull(reason.message) ?? NO_REASON;
  if (typeof reason === 'object' && reason !== null) {
    const carrier = reason as Record<string, unknown>;
    return textOrNull(carrier['reason']) ?? textOrNull(carrier['message']) ?? NO_REASON;
  }
  return textOrNull(reason) ?? NO_REASON;
}

/**
 * A date, or a date and a time, in the forms this tool reads: `2026-08-29`,
 * `2026-08-29T09:00:00Z`, `2026-08-29T09:00:00+02:00`, and the same with a
 * space instead of the `T` and with no zone at all.
 *
 * Groups: year, month, day, hour, minute, second, fractional second, zone.
 */
const RANGE_TIME =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,6}))?)?(Z|[+-]\d{2}:\d{2})?)?$/;

/**
 * The instant a timestamp names, in milliseconds since the epoch, or null where
 * it is not one of the forms above or does not name a real instant.
 *
 * The same grammar and the same reading as `audit_log_query`'s `since`, restated
 * here deliberately rather than shared: the two tools are read on their own, and
 * a caller who has learned one timestamp grammar for this catalog should not
 * meet a second. Built from the components rather than handed to `Date.parse`,
 * because `Date.parse('2026-08-29 09:00:00')` is implementation-defined and Node
 * reads it as LOCAL time — the same range would then cover different instants on
 * two machines, silently and by hours. Composed here it is read as UTC,
 * explicitly and identically everywhere.
 *
 * The result is checked back against the components it was built from, which
 * settles what nothing else here would: a day the month does not have ROLLS OVER
 * rather than failing — `2026-02-30` composes as the 2nd of March — and so does
 * an hour of 25.
 */
function utcMillis(text: string): number | null {
  const match = RANGE_TIME.exec(text);
  if (match === null) return null;
  const [, year, month, day, hour, minute, second, fraction, zone] = match;
  // A `Date` holds milliseconds and a timestamp may carry microseconds, so the
  // digits past the third are dropped rather than rounded: that moves an instant
  // by less than a millisecond and never across a bucket boundary of any range
  // this tool can be asked for.
  const millis = fraction === undefined ? 0 : Number(fraction.slice(0, 3).padEnd(3, '0'));
  const at = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    hour === undefined ? 0 : Number(hour),
    minute === undefined ? 0 : Number(minute),
    second === undefined ? 0 : Number(second),
    millis,
  );
  const composed = new Date(at);
  if (
    composed.getUTCFullYear() !== Number(year) ||
    composed.getUTCMonth() !== Number(month) - 1 ||
    composed.getUTCDate() !== Number(day) ||
    (hour !== undefined && composed.getUTCHours() !== Number(hour)) ||
    (minute !== undefined && composed.getUTCMinutes() !== Number(minute))
  ) {
    return null;
  }
  if (zone === undefined || zone === 'Z') return at;
  const zoneHours = Number(zone.slice(1, 3));
  const zoneMinutes = Number(zone.slice(4, 6));
  // An offset outside the range a zone can have is a malformed one, and reading
  // it would shift the instant by the amount it is wrong by.
  if (zoneHours > 23 || zoneMinutes > 59) return null;
  // Ahead of UTC is earlier in UTC, so the offset is subtracted.
  const offset = (zoneHours * 60 + zoneMinutes) * 60_000;
  return zone.startsWith('-') ? at + offset : at - offset;
}

/**
 * One end of the range the caller named, in milliseconds since the epoch, or
 * null where the caller named none.
 *
 * Strict rather than lenient, as `audit_log_query` is about its own `since`: a
 * bound that cannot be read is not a request for the default one. Ignoring it
 * would answer about the last hour while the caller believes it answered about
 * last Tuesday, and the numbers would look exactly as real either way. Null and
 * undefined are the argument being absent, which is not the same as unreadable
 * and is what the default is for.
 */
function rangeBound(raw: unknown, name: string): number | null {
  if (raw == null) return null;
  const millis = typeof raw === 'string' ? utcMillis(raw) : null;
  if (millis === null) {
    throw new Error(
      `"${name}" must be an ISO 8601 timestamp such as "2026-08-29T09:00:00Z", or a date ` +
        'such as "2026-08-29". A time given without a timezone is read as UTC.',
    );
  }
  return millis;
}

/** The range a call covers, in milliseconds since the epoch. */
interface Range {
  start: number;
  end: number;
}

/**
 * The range to report over: what the caller named, defaulted at either end.
 *
 * The default start hangs off the END rather than off `now`, so a caller who
 * names only an end gets the hour before it rather than an hour that may lie
 * entirely outside the range they asked about.
 */
function resolveRange(args: Record<string, unknown>, now: number): Range {
  const end = rangeBound(args['end'], 'end') ?? now;
  const start = rangeBound(args['start'], 'start') ?? end - DEFAULT_RANGE_MS;
  if (start >= end) {
    throw new Error('"start" must be before "end"');
  }
  return { start, end };
}

/**
 * The graphs this tool reads, spelled as the middleware's reporting graph names.
 * `interface` is per-interface and carries an identifier; the other two are
 * system-wide and carry none.
 */
type GraphName = 'cpu' | 'memory' | 'interface' | 'disk';

/** What one graph read produced, with a failure named rather than thrown. */
interface GraphAttempt {
  /**
   * The legend as the system sent it, entry for entry. Not filtered to the
   * strings in it: an entry's POSITION is what maps it to a column, so dropping
   * one would shift every series after it onto its neighbour's numbers.
   */
  legend: unknown[];
  rows: unknown[];
  error: string | null;
}

/**
 * One reporting graph over the range, with a failure caught and named.
 *
 * Read per graph rather than all graphs in one call, which the method would
 * accept. Each graph is then independent: a system that keeps no interface
 * graph, or that rejects one identifier, still answers for CPU and memory
 * instead of taking the whole result down. The cost is a call per graph, and
 * they are all issued together.
 *
 * (unconfirmed) the query bounds are unix SECONDS, which is what netdata records
 * in and what the response's own `start` and `end` are read as below.
 */
async function readGraph(
  system: SystemHandle,
  name: GraphName,
  identifier: string | null,
  range: Range,
): Promise<GraphAttempt> {
  try {
    const answer = await firstValueFrom(
      // The request is inlined so the call's own parameter types apply, as in
      // `storage.ts`: written to a `const` first, the graph name widens to
      // `string` and no longer satisfies the graph-name union.
      system.client.api.call('reporting.netdata_get_data', [
        [identifier === null ? { name } : { name, identifier }],
        { start: Math.floor(range.start / 1000), end: Math.ceil(range.end / 1000) },
      ]),
    );
    // One graph was asked for, so one is expected back. Anything else — no
    // list, an empty one, an entry that is not a record — is a system that did
    // not answer the question, and it reads as no data rather than as an error:
    // the other graphs in the same result are unaffected by it.
    const graph = Array.isArray(answer) ? (answer[0] as unknown) : undefined;
    if (typeof graph !== 'object' || graph === null) return { legend: [], rows: [], error: null };
    const held = graph as Record<string, unknown>;
    const legend = held['legend'];
    const rows = held['data'];
    return {
      legend: Array.isArray(legend) ? legend : [],
      rows: Array.isArray(rows) ? rows : [],
      error: null,
    };
  } catch (reason) {
    return { legend: [], rows: [], error: errorText(reason) };
  }
}

/**
 * The instant a data row is stamped with, in milliseconds since the epoch, or
 * null where the row's first column is not a time this tool can read.
 *
 * (unconfirmed) the stamp is unix seconds, as netdata records them. A value too
 * large to be a plausible second — 1e11 seconds is the year 5138 — is read as
 * milliseconds instead, so a middleware that sends milliseconds places its
 * samples correctly rather than putting every one of them in 1970 and reporting
 * an empty range.
 */
function rowMillis(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.abs(value) > 1e11 ? value : value * 1000;
}

/**
 * Which column of a data row each legend entry describes.
 *
 * (unconfirmed) a row is `[timestamp, ...values]`. The legend either names that
 * timestamp column as its own first entry or describes only the values after it,
 * and which of the two a release sends is exactly the kind of detail that turns
 * every series into its neighbour if it is assumed. So it is READ: a legend that
 * opens with `time` is aligned column-for-column, and one that does not is
 * shifted by the timestamp the row carries anyway.
 */
function columns(legend: unknown[]): Map<string, number> {
  const first = legend[0];
  const offset = typeof first === 'string' && first.toLowerCase() === 'time' ? 0 : 1;
  const index = new Map<string, number>();
  legend.forEach((name, position) => {
    // Position is preserved through an entry that is not a name at all, for the
    // reason `GraphAttempt` gives for not filtering the legend.
    if (typeof name !== 'string') return;
    const key = name.toLowerCase();
    // The timestamp column is not a series, and a duplicate name keeps its
    // first column: a second column of the same name is a graph this tool
    // cannot tell apart, and taking the later one would silently prefer it.
    if (key === 'time' || index.has(key)) return;
    index.set(key, position + offset);
  });
  return index;
}

/** The dimensions of one sample, keyed by the lowercased legend name. */
type Dimensions = Map<string, number>;

/** One sample of a derived metric: when it was taken, and its value there. */
interface Point {
  at: number;
  value: number;
}

/**
 * How a metric is computed from a graph.
 *
 * The dimension names travel WITH the computation rather than being inferred
 * from it, because they are what tells a graph that carries no such series
 * apart from a graph that carries it and collected nothing — a distinction the
 * samples alone cannot make, for the reason {@link graphMetric} gives.
 */
interface Derivation {
  /**
   * The legend names, lowercased, without which the metric cannot be derived
   * from this graph at all. A name here missing from the legend is
   * {@link NO_DIMENSION}; every other reason a sample yields nothing is a
   * property of that sample rather than of the graph.
   */
  requires: string[];
  /**
   * The value at one sample, or null where this sample does not yield one — a
   * dimension the row reported as null, or a total of zero to divide by.
   */
  from: (dimensions: Dimensions) => number | null;
}

/** What a graph yielded for one metric. */
interface Samples {
  /** The samples the metric could be derived from. */
  found: Point[];
  /** How many rows the graph held inside the range at all, derivable or not. */
  inRange: number;
}

/**
 * The samples of a graph that fall inside the range, reduced to one metric.
 *
 * Samples outside the range are dropped rather than clamped into the nearest
 * bucket: the system is asked for the range and is not obliged to answer with
 * exactly it, and a sample from before the start belongs in no bucket of it.
 *
 * The count of rows in the range is kept beside them because it is what says
 * whether the system recorded anything here at all, which an empty list of
 * points on its own does not.
 *
 * The column index is passed in rather than read from the legend here, because
 * {@link graphMetric} needs the same index to decide which marker an empty
 * result is.
 */
function points(
  rows: unknown[],
  index: Map<string, number>,
  range: Range,
  derive: Derivation,
): Samples {
  const found: Point[] = [];
  let inRange = 0;
  for (const row of rows) {
    if (!Array.isArray(row)) continue;
    const at = rowMillis(row[0]);
    if (at === null || at < range.start || at > range.end) continue;
    inRange += 1;
    const dimensions: Dimensions = new Map();
    for (const [name, column] of index) {
      const value = row[column] as unknown;
      // A dimension the system reported as null — netdata's own marker for a
      // second it collected nothing in — is absent rather than zero, which is
      // what stops a gap in collection reading as an idle system.
      if (typeof value === 'number' && Number.isFinite(value)) dimensions.set(name, value);
    }
    const value = derive.from(dimensions);
    if (value !== null) found.push({ at, value });
  }
  return { found, inRange };
}

/** To one decimal place, which is the precision every metric here is reported at. */
function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/** The metrics `reporting_utilisation` reports. */
type MetricName = 'cpu_percent' | 'memory_used_percent' | 'network_received' | 'network_sent';

/** The metrics `reporting_disk_io` reports. */
type DiskMetricName =
  | 'read_throughput'
  | 'write_throughput'
  | 'read_iops'
  | 'write_iops'
  | 'read_latency'
  | 'write_latency';

/**
 * What names one of `reporting_utilisation`'s metrics: which of the four it is,
 * and the interface a network metric was measured on.
 */
interface UtilisationLabel {
  metric: MetricName;
  interface: string | null;
}

/**
 * What names one of `reporting_disk_io`'s metrics: which of the six it is, and
 * the disk it was measured on.
 */
interface DiskLabel {
  metric: DiskMetricName;
  disk: string | null;
}

/**
 * What every metric carries beyond the label naming it — the summary, or the
 * stated reason there is none.
 *
 * Split from the label because the two tools here name their metrics
 * differently (an interface, or a disk) and summarise them identically. The
 * label is SPREAD FIRST into the result, so a metric reads with its identity
 * ahead of its numbers whichever tool produced it.
 */
interface MetricBody {
  unit: string;
  min: number | null;
  max: number | null;
  mean: number | null;
  latest: number | null;
  buckets: (number | null)[];
  unavailable: string | null;
}

/** One of `reporting_utilisation`'s metrics over the range. */
type MetricReport = UtilisationLabel & MetricBody;

/** One of `reporting_disk_io`'s metrics over the range. */
type DiskMetricReport = DiskLabel & MetricBody;

/** A metric with nothing to report, and why. */
function unavailable<L extends object>(label: L, unit: string, reason: string): L & MetricBody {
  return {
    ...label,
    unit,
    min: null,
    max: null,
    mean: null,
    latest: null,
    // Empty rather than twelve nulls: `unavailable` is what says there is
    // nothing here, and a list of nulls would invite reading it as twelve
    // buckets that each happened to be empty.
    buckets: [],
    unavailable: reason,
  };
}

/**
 * The four numbers and the twelve buckets, from the samples that yielded a
 * value.
 *
 * `latest` is the value at the NEWEST sample rather than the last one the system
 * sent, because nothing here guarantees the order it sent them in. A bucket with
 * no sample in it is null rather than zero, for the reason a missing dimension
 * is absent above: an interval the system collected nothing in is not an
 * interval in which nothing happened.
 *
 * Only ever called with at least one sample — {@link graphMetric} is what
 * decides that an empty list is a marker rather than a summary, and which of the
 * markers it is.
 */
function summarise<L extends object>(
  label: L,
  unit: string,
  found: Point[],
  range: Range,
): L & MetricBody {
  const width = (range.end - range.start) / BUCKETS;
  const sums = new Array<number>(BUCKETS).fill(0);
  const counts = new Array<number>(BUCKETS).fill(0);
  let min = found[0].value;
  let max = found[0].value;
  let total = 0;
  let latest = found[0];
  for (const point of found) {
    if (point.value < min) min = point.value;
    if (point.value > max) max = point.value;
    total += point.value;
    if (point.at > latest.at) latest = point;
    // Clamped at the last bucket so that a sample exactly at the end of the
    // range lands in it rather than one past the end.
    const bucket = Math.min(BUCKETS - 1, Math.floor((point.at - range.start) / width));
    sums[bucket] += point.value;
    counts[bucket] += 1;
  }
  return {
    ...label,
    unit,
    min: round1(min),
    max: round1(max),
    mean: round1(total / found.length),
    latest: round1(latest.value),
    buckets: sums.map((sum, bucket) => (counts[bucket] === 0 ? null : round1(sum / counts[bucket]))),
    unavailable: null,
  };
}

/** The unit CPU and memory are reported in. */
const PERCENT = 'percent';

/**
 * The unit the network metrics are reported in.
 *
 * (unconfirmed) against a live middleware, and the one assumption in this file
 * that would be WRONG rather than absent if it is: the interface graph's values
 * are passed through, so a release recording bytes per second would be reported
 * as kilobits per second. It is stated rather than omitted because a throughput
 * with no unit is a number a caller cannot compare with anything — and the
 * reading is netdata's own, which records the interface chart in kilobits per
 * second.
 */
const NETWORK_UNIT = 'kilobits_per_second';

/**
 * The share of CPU time that was not idle, as a percentage.
 *
 * Derived rather than read: the graph carries one dimension per scheduler state
 * — user, system, nice, iowait, steal and the rest — and "utilisation" is the
 * complement of the one that means the CPU had nothing to do. Taken as
 * `100 - idle` rather than as the sum of the others because the set of the
 * others differs by release and by kernel, and a release that adds a state would
 * quietly under-report a sum while leaving the complement exact.
 *
 * Clamped into 0..100: the dimensions are percentages that add to a hundred, so
 * anything outside that is a graph this reading does not hold of, and a
 * utilisation of -3% would be read as a real measurement.
 */
const cpuPercent: Derivation = {
  requires: ['idle'],
  from: (dimensions) => {
    const idle = dimensions.get('idle');
    if (idle === undefined) return null;
    return Math.min(100, Math.max(0, 100 - idle));
  },
};

/**
 * The dimensions of the memory graph that partition physical memory.
 *
 * (unconfirmed) the graph carries these four and they sum to the memory
 * installed, which is what makes a percentage of their total meaningful. Named
 * as a closed list rather than summing every dimension the graph carries: a
 * release adding a derived dimension — an `available` that overlaps `free` and
 * `cached` — would inflate the total and shrink every percentage, silently and
 * plausibly.
 */
const MEMORY_PARTS = ['free', 'used', 'cached', 'buffers'];

/**
 * Memory in use, as a percentage of the memory the graph accounts for.
 *
 * A percentage rather than a byte count deliberately: the graph's unit is not
 * stated anywhere this tool can read, and a ratio of two values in the same
 * unit is right whatever that unit turns out to be.
 *
 * BOTH `used` and `free` are required, and the second is what stops the answer
 * being a tautology. `used` is itself one of the parts summed into the total, so
 * a graph carrying `used` and nothing else divides a number by itself and
 * reports 100% — a system at three percent of its memory presented as one out of
 * it, which is worse than no answer. `free` is the dimension that makes the
 * total account for memory nothing is using; `cached` and `buffers` refine it
 * and are optional, because a release that folds them into `free` is still
 * partitioning the same memory. Null where either is missing, and null where the
 * parts sum to nothing to take a share of.
 */
const memoryUsedPercent: Derivation = {
  requires: ['used', 'free'],
  from: (dimensions) => {
    const used = dimensions.get('used');
    if (used === undefined || dimensions.get('free') === undefined) return null;
    let total = 0;
    for (const part of MEMORY_PARTS) total += dimensions.get(part) ?? 0;
    if (total <= 0) return null;
    return Math.min(100, Math.max(0, (used / total) * 100));
  },
};

/**
 * The magnitude of one dimension, whatever it measures.
 *
 * The magnitude rather than the value, because netdata mirrors one direction of
 * a two-way chart below the axis to draw it — on the interface chart and on the
 * disk one alike: a sent rate arrives negative on a link that is sending, and a
 * write rate negative on a disk that is writing. Passing that through would
 * report a busy link, or a busy disk, as one doing less than nothing. Direction
 * is what the metric NAME says, so the sign carries nothing the result needs.
 */
function magnitude(dimension: string): Derivation {
  return {
    requires: [dimension],
    from: (dimensions) => {
      const value = dimensions.get(dimension);
      return value === undefined ? null : Math.abs(value);
    },
  };
}

/**
 * The unit the disk throughput metrics are reported in.
 *
 * (unconfirmed), and the same kind of assumption as {@link NETWORK_UNIT}: the
 * disk graph's values are passed through, so a release recording bytes per
 * second would be reported as kibibytes per second. Stated rather than omitted
 * because a throughput with no unit cannot be compared with anything, and the
 * reading is netdata's own, which records the disk chart in KiB/s.
 */
const DISK_THROUGHPUT_UNIT = 'kibibytes_per_second';

/** The unit the disk IOPS metrics are reported in. */
const IOPS_UNIT = 'operations_per_second';

/** The unit the disk latency metrics are reported in. */
const LATENCY_UNIT = 'milliseconds';

/** One of the six measurements `reporting_disk_io` reports per disk. */
interface DiskMeasurement {
  metric: DiskMetricName;
  unit: string;
  derive: Derivation;
}

/**
 * The six measurements, and the dimension of the disk graph each is derived
 * from.
 *
 * All six come from the ONE `disk` graph, because there is no second one to
 * read: the client types `reporting.netdata_get_data`'s graph name as a closed
 * union — `cpu`, `cputemp`, `disk`, `disktemp`, `interface`, `load`, `memory`,
 * `processes`, `uptime`, `arcsize` and the UPS graphs — and `disk` is the only
 * member of it that is per-disk I/O. So whether this system can report IOPS and
 * latency at all is a question about that graph's LEGEND, and it is asked as
 * one: each metric names the dimension it needs, and a graph that does not
 * carry it answers {@link NO_DIMENSION} rather than a number.
 *
 * (unconfirmed) every dimension name below. `reads` and `writes` are netdata's
 * own for the disk chart's throughput. The other four are what a release that
 * recorded operation counts and I/O wait times would plausibly call them, and
 * on every release this was written against the graph carries neither — which
 * is why the tool's description says those two are commonly unavailable rather
 * than promising them. A name that no release carries costs a stated
 * `unavailable` rather than a number, which is the whole reason the dimension
 * travels with the derivation; see {@link Derivation}. What that does NOT cover
 * is a name a release carries under other semantics — the value would then be
 * reported under the unit asserted here — so the four guessed names are ones
 * netdata uses for these quantities and nothing else.
 */
const DISK_MEASUREMENTS: DiskMeasurement[] = [
  { metric: 'read_throughput', unit: DISK_THROUGHPUT_UNIT, derive: magnitude('reads') },
  { metric: 'write_throughput', unit: DISK_THROUGHPUT_UNIT, derive: magnitude('writes') },
  { metric: 'read_iops', unit: IOPS_UNIT, derive: magnitude('read_ops') },
  { metric: 'write_iops', unit: IOPS_UNIT, derive: magnitude('write_ops') },
  { metric: 'read_latency', unit: LATENCY_UNIT, derive: magnitude('read_await') },
  { metric: 'write_latency', unit: LATENCY_UNIT, derive: magnitude('write_await') },
];

/** The things to graph, and whether the cap left any out. */
interface Graphed {
  names: string[];
  truncated: boolean;
  error: string | null;
}

/**
 * The `name` of every row that has one, in name order, up to the cap.
 *
 * Sorted BEFORE the cap, so which of them a capped result covers is a property
 * of the system rather than of the order it happened to list them.
 *
 * A row that is not a record, or whose name is not a non-empty string, names
 * nothing that could be graphed and is dropped: the identifier is what the
 * graph is asked for by, so a row without one has no graph to read.
 */
function graphedNames(rows: unknown[], cap: number): Omit<Graphed, 'error'> {
  const named = rows.flatMap((row) => {
    if (typeof row !== 'object' || row === null) return [];
    const name = textOrNull((row as Record<string, unknown>)['name']);
    return name === null ? [] : [name];
  });
  named.sort();
  return { names: named.slice(0, cap), truncated: named.length > cap };
}

/**
 * The interfaces to graph: every one the system lists, in name order, up to the
 * cap.
 *
 * Bridges, VLANs and aggregations are listed alongside physical ports and are
 * kept, because traffic over a bridge is traffic. That does mean an aggregation
 * and its members can both appear, and their throughputs then overlap — the
 * description says so rather than this guessing which of them the caller meant.
 *
 * A listing that could not be read is named rather than thrown: CPU and memory
 * are still an answer, and the network metrics say why they are not one.
 */
async function interfaceNames(system: SystemHandle): Promise<Graphed> {
  try {
    // The call is inlined rather than shared with `diskNames` below, as the
    // graph reads are inlined above: the client types `query` per method, so a
    // method name reaching it through a variable widens to `string` and no
    // longer selects an overload. Only the sort-and-cap step is shared.
    const rows = await firstValueFrom(system.client.api.query('interface.query'));
    return { ...graphedNames(rows, MAX_INTERFACES), error: null };
  } catch (reason) {
    return { names: [], truncated: false, error: errorText(reason) };
  }
}

/**
 * The disks to graph: every one the system lists, in name order, up to the cap.
 *
 * The device name rather than the serial, because the name is what the disk
 * graph is identified by. Every disk the system knows is kept, whether or not
 * it belongs to a pool: a disk being hammered while in no pool is exactly the
 * kind of thing this tool is asked about, and `disks_list` is where pool
 * membership is answered.
 *
 * A listing that could not be read is named rather than thrown, as the
 * interface listing is: the metrics then say why there is nothing rather than
 * the whole call failing.
 */
async function diskNames(system: SystemHandle): Promise<Graphed> {
  try {
    const rows = await firstValueFrom(system.client.api.query('disk.query'));
    return { ...graphedNames(rows, MAX_DISKS), error: null };
  } catch (reason) {
    return { names: [], truncated: false, error: errorText(reason) };
  }
}

export const reportingUtilisation: ReadOnlyTool = {
  name: 'reporting_utilisation',
  description:
    'CPU, memory and network utilisation of a TrueNAS system OVER A TIME ' +
    'RANGE, from the metrics the system records for itself. `system_info` ' +
    'reports the instant; this reports the interval, and is what answers ' +
    '"was it busy at 3am?". `metrics` holds one entry per measurement, each ' +
    'with: `metric`, which of the four it is; `interface`, the interface a ' +
    'network metric was measured on and NULL ON CPU AND MEMORY; `unit`, what ' +
    'the numbers are in; `min`, `max` and `mean` over the whole range; ' +
    '`latest`, the value at the most recent sample IN THE RANGE, which is not ' +
    'the value now unless the range ends now; and `buckets`. `cpu_percent` is ' +
    'the percentage of CPU time that was NOT IDLE, across all cores together, ' +
    'so 100 is every core fully busy and it does not say which core or which ' +
    'workload. `memory_used_percent` is memory in use as a percentage of the ' +
    'memory the system accounts for; CACHED AND BUFFERED MEMORY COUNT AS FREE ' +
    'in that reading, because they are reclaimable, so a healthy system running ' +
    'a large cache reports low. `network_received` and `network_sent` are ' +
    'throughput in each direction on ONE INTERFACE, reported as a magnitude, ' +
    'and they cover at most six interfaces IN NAME ORDER — ' +
    '`truncated_interfaces` is true when the system has more than that and some ' +
    'were left out. Bridges, VLANs and link aggregations are reported ' +
    'alongside the physical ports beneath them, so ADDING THE INTERFACES ' +
    'TOGETHER DOUBLE-COUNTS traffic that crossed both; compare interfaces ' +
    'rather than summing them. `buckets` is twelve entries on every metric that ' +
    'was measured: the ' +
    'range is divided into twelve equal intervals and each entry is the MEAN of ' +
    'the samples inside its interval, oldest first, so the width of one is a ' +
    'twelfth of the range and is given as `bucket_seconds`. A bucket the system ' +
    'collected nothing in is NULL, WHICH IS NOT ZERO — no measurement was ' +
    'taken, and the metric may have been at any value. Raw samples are never ' +
    'returned: an hour is hundreds of them per metric, so the summary and the ' +
    'twelve buckets are the whole answer and the result is the same size ' +
    'whatever range is asked for. `unavailable` is null on a metric that was ' +
    'measured, and otherwise names why there is nothing to report — the system ' +
    'collected no data in the range, its graph carried no series this metric ' +
    'could be derived from, the read itself failed with the reason the ' +
    'system gave, or — on the network metrics, which then carry a null ' +
    '`interface` — the system named no interface to graph at all. WHERE IT IS ' +
    'NON-NULL, `min`, `max`, `mean` and `latest` ARE ' +
    'ALL NULL AND `buckets` IS EMPTY, and that is never a system that was idle: ' +
    'nothing was measured. Metrics fail independently, so a result can report ' +
    'CPU and memory while every network metric is unavailable. `start` and ' +
    '`end` are the range actually reported on, as ISO 8601 UTC timestamps, so ' +
    'an unavailable metric is readable against the window it was asked for. ' +
    'Give `start` and `end` to bound the range; OMITTED, THE LAST HOUR ending ' +
    'now, and a `start` with no `end` runs to now while an `end` with no ' +
    '`start` covers the hour before it. This tool reads recorded metrics. It ' +
    'does not report per-process, per-app or per-VM usage, per-disk throughput, ' +
    'or per-share traffic, and it changes nothing about what the system records.',
  inputSchema: {
    type: 'object',
    properties: {
      start: {
        type: 'string',
        description:
          'The beginning of the range, as an ISO 8601 timestamp — ' +
          '"2026-08-29T09:00:00Z" — or a date, "2026-08-29", which is ' +
          'midnight. A time given without a timezone is read as UTC. Omitted, ' +
          'one hour before the end of the range.',
      },
      end: {
        type: 'string',
        description:
          'The end of the range, in the same forms as `start`. Omitted, now.',
      },
    },
  },
  requiredRole: Role.ReadOnly,
  mutating: false,
  async handler({ system }, args) {
    // The range is resolved before anything is read, so an unreadable bound is
    // an error rather than a query the system answers over the wrong interval.
    const range = resolveRange(args, Date.now());
    // The interface listing is what decides which graphs are read, so it is the
    // one read that cannot be issued alongside the others.
    const interfaces = await interfaceNames(system);
    const [cpu, memory, ...network] = await Promise.all([
      readGraph(system, 'cpu', null, range),
      readGraph(system, 'memory', null, range),
      ...interfaces.names.map((name) => readGraph(system, 'interface', name, range)),
    ]);

    const metrics: MetricReport[] = [
      graphMetric<UtilisationLabel>({ metric: 'cpu_percent', interface: null }, PERCENT, cpu, range, cpuPercent),
      graphMetric<UtilisationLabel>(
        { metric: 'memory_used_percent', interface: null },
        PERCENT,
        memory,
        range,
        memoryUsedPercent,
      ),
    ];
    if (interfaces.names.length === 0) {
      // Both network metrics are still reported, carrying the reason no
      // interface could be graphed — the listing failed, or it was read and
      // named none. Absent metrics would read as a system with no network at
      // all, which is the one thing a result must not imply here.
      const reason = interfaces.error ?? NO_INTERFACES;
      metrics.push(
        unavailable<UtilisationLabel>(
          { metric: 'network_received', interface: null },
          NETWORK_UNIT,
          reason,
        ),
        unavailable<UtilisationLabel>(
          { metric: 'network_sent', interface: null },
          NETWORK_UNIT,
          reason,
        ),
      );
    }
    interfaces.names.forEach((name, position) => {
      const graph = network[position];
      metrics.push(
        graphMetric<UtilisationLabel>(
          { metric: 'network_received', interface: name },
          NETWORK_UNIT,
          graph,
          range,
          magnitude('received'),
        ),
        graphMetric<UtilisationLabel>(
          { metric: 'network_sent', interface: name },
          NETWORK_UNIT,
          graph,
          range,
          magnitude('sent'),
        ),
      );
    });

    return {
      start: new Date(range.start).toISOString(),
      end: new Date(range.end).toISOString(),
      bucket_seconds: round1((range.end - range.start) / BUCKETS / 1000),
      metrics,
      truncated_interfaces: interfaces.truncated,
    };
  },
};

export const reportingDiskIo: ReadOnlyTool = {
  name: 'reporting_disk_io',
  description:
    'Per-disk throughput, IOPS and latency on a TrueNAS system OVER A TIME ' +
    'RANGE, from the metrics the system records for itself. This is what ' +
    'answers "which disk is slow" and "was that disk slow at 3am" — latency ' +
    'is how a failing disk announces itself before SMART does, and it is what ' +
    'explains a slow pool when every capacity and health figure looks fine. ' +
    '`metrics` holds one entry per measurement per disk, each with: `metric`, ' +
    'which of the six it is; `disk`, the device name it was measured on; ' +
    '`unit`, what the numbers are in; `min`, `max` and `mean` over the whole ' +
    'range; `latest`, the value at the most recent sample IN THE RANGE, which ' +
    'is not the value now unless the range ends now; and `buckets`. ' +
    '`read_throughput` and `write_throughput` are data moved per second in ' +
    'each direction, reported as a magnitude. `read_iops` and `write_iops` are ' +
    'operations per second, and `read_latency` and `write_latency` the average ' +
    'wait per operation in milliseconds. THE IOPS AND LATENCY METRICS ARE ' +
    'COMMONLY UNAVAILABLE: they come from the same per-disk graph as ' +
    'throughput, and a system whose graph records throughput only reports them ' +
    'with `unavailable` set rather than omitting them — that is a fact about ' +
    'what the system records, NOT about the disk, and it is not worth ' +
    'retrying. At most six disks are covered, IN NAME ORDER — not the six ' +
    'busiest — and `truncated_disks` is true when the system has more than ' +
    'that and some were left out, so on a large shelf this reports a slice ' +
    'chosen alphabetically. Every disk the system knows is eligible whether or ' +
    'not it is in a pool; `disks_list` is what says which pool a disk belongs ' +
    'to, and this tool does not say. `buckets` is twelve entries on every ' +
    'metric that was measured: the range is divided into twelve equal ' +
    'intervals and each entry is the MEAN of the samples inside its interval, ' +
    'oldest first, so the width of one is a twelfth of the range and is given ' +
    'as `bucket_seconds`. A bucket the system collected nothing in is NULL, ' +
    'WHICH IS NOT ZERO — no measurement was taken, and the disk may have been ' +
    'at any rate. Raw samples are never returned: an hour is hundreds of them ' +
    'per metric, so the summary and the twelve buckets are the whole answer ' +
    'and the result is the same size whatever range is asked for. ' +
    '`unavailable` is null on a metric that was measured, and otherwise names ' +
    'why there is nothing to report — the system collected no data for that ' +
    'disk in the range, its graph carried no series this metric could be ' +
    'derived from, the read itself failed with the reason the system gave, or ' +
    '— on entries that then carry a null `disk` — the system named no disk to ' +
    'graph at all. WHERE IT IS NON-NULL, `min`, `max`, `mean` and `latest` ARE ' +
    'ALL NULL AND `buckets` IS EMPTY, and that is never a disk that was idle: ' +
    'nothing was measured. Metrics fail independently, so one disk can report ' +
    'while another is unavailable, and a disk can report throughput while its ' +
    'own IOPS and latency are not. `start` and `end` are the range actually ' +
    'reported on, as ISO 8601 UTC timestamps, so an unavailable metric is ' +
    'readable against the window it was asked for. Give `start` and `end` to ' +
    'bound the range; OMITTED, THE LAST HOUR ending now, and a `start` with no ' +
    '`end` runs to now while an `end` with no `start` covers the hour before ' +
    'it. This tool reads recorded metrics. It does not report SMART attributes ' +
    'or disk temperature, per-pool or per-dataset activity, or which workload ' +
    'caused the I/O, and it changes nothing about what the system records.',
  inputSchema: {
    type: 'object',
    properties: {
      start: {
        type: 'string',
        description:
          'The beginning of the range, as an ISO 8601 timestamp — ' +
          '"2026-08-29T09:00:00Z" — or a date, "2026-08-29", which is ' +
          'midnight. A time given without a timezone is read as UTC. Omitted, ' +
          'one hour before the end of the range.',
      },
      end: {
        type: 'string',
        description: 'The end of the range, in the same forms as `start`. Omitted, now.',
      },
    },
  },
  requiredRole: Role.ReadOnly,
  mutating: false,
  async handler({ system }, args) {
    // The range is resolved before anything is read, so an unreadable bound is
    // an error rather than a query the system answers over the wrong interval.
    const range = resolveRange(args, Date.now());
    // The disk listing is what decides which graphs are read, so it is the one
    // read that cannot be issued alongside the others.
    const disks = await diskNames(system);
    const graphs = await Promise.all(
      disks.names.map((name) => readGraph(system, 'disk', name, range)),
    );

    const metrics: DiskMetricReport[] = [];
    if (disks.names.length === 0) {
      // All six metrics are still reported, carrying the reason no disk could
      // be graphed — the listing failed, or it was read and named none. Absent
      // metrics would read as a system with no disks at all, which is the one
      // thing a result must not imply here.
      const reason = disks.error ?? NO_DISKS;
      for (const measurement of DISK_MEASUREMENTS) {
        metrics.push(
          unavailable<DiskLabel>({ metric: measurement.metric, disk: null }, measurement.unit, reason),
        );
      }
    }
    disks.names.forEach((name, position) => {
      const graph = graphs[position];
      for (const measurement of DISK_MEASUREMENTS) {
        metrics.push(
          graphMetric<DiskLabel>(
            { metric: measurement.metric, disk: name },
            measurement.unit,
            graph,
            range,
            measurement.derive,
          ),
        );
      }
    });

    return {
      start: new Date(range.start).toISOString(),
      end: new Date(range.end).toISOString(),
      bucket_seconds: round1((range.end - range.start) / BUCKETS / 1000),
      metrics,
      truncated_disks: disks.truncated,
    };
  },
};

/**
 * One metric from one graph: the summary where the graph yielded samples, and
 * the stated reason where it did not.
 *
 * The three ways there is nothing to report are kept apart, because they are
 * different facts about the system: the read failed, the graph carried no
 * series this metric is derived from, and the graph was read and held no sample
 * in the range. Only the last is "the system was not recording".
 *
 * Which of the last two an empty result is is decided from the LEGEND, and it
 * has to be: a row whose dimensions are all null — netdata's own marker for a
 * second it collected nothing in — is indistinguishable from a row missing the
 * dimension once {@link points} has dropped the non-numeric values. Counting
 * rows would therefore report a collection GAP inside retention, which is
 * exactly the "was it busy at 3am?" case this tool is built for, as a graph
 * that carries no such series at all.
 *
 * A graph holding no row in the range at all is {@link NO_DATA} whatever its
 * legend named, which is the weaker of the two claims and the only one the
 * system's answer supports: nothing was collected here, and a legend alone says
 * nothing about whether the series would have been derivable had it been.
 */
function graphMetric<L extends object>(
  label: L,
  unit: string,
  graph: GraphAttempt,
  range: Range,
  derive: Derivation,
): L & MetricBody {
  if (graph.error !== null) return unavailable(label, unit, graph.error);
  const carried = columns(graph.legend);
  const samples = points(graph.rows, carried, range, derive);
  if (samples.found.length > 0) return summarise(label, unit, samples.found, range);
  if (samples.inRange > 0 && derive.requires.some((name) => !carried.has(name))) {
    return unavailable(label, unit, NO_DIMENSION);
  }
  return unavailable(label, unit, NO_DATA);
}

/**
 * Space trends: how much data a dataset held, over time.
 *
 * Not netdata, and not bucketed — which is why this tool sits apart from the two
 * above rather than sharing their shape. `reporting.netdata_get_data` types its
 * graph name as a CLOSED UNION — cpu, cputemp, disk, disktemp, interface, load,
 * processes, memory, uptime, the ARC graphs and the UPS ones — and not one of
 * them is pool or dataset space. `reporting.get_data` takes the same union. So
 * there is no recorded space series on this API surface at all, and a tool that
 * bucketed one would be inventing it.
 *
 * What the system does retain is ZFS's own record. Every snapshot carries the
 * instant it was taken and the bytes the dataset REFERENCED at that instant, and
 * `snapshots_list` already reads exactly those two properties. A dataset that is
 * snapshotted therefore has a space history, sampled at whatever times its
 * snapshot task happens to run; one that is not has none, and says so.
 *
 * Three consequences follow, and each is stated in the description rather than
 * smoothed over, because each is a way this answer is narrower than its name:
 * the samples are not evenly spaced and are not the range's own ends; `used` —
 * the dataset with its descendants and its snapshots — has no history, because a
 * snapshot's own `used` is the space unique to that snapshot rather than the
 * dataset's; and a pool's free space has none either, which is why the pool
 * levels here are current readings carrying their own timestamp instead of a
 * value at each end of the range.
 */

/**
 * How many datasets are reported.
 *
 * The same kind of cap as {@link MAX_DISKS} and for the same reason — a dataset
 * listing is unbounded — but chosen ON SIZE rather than in name order, which is
 * the one place this tool departs from its siblings. Space is what is being
 * reported, the largest datasets are where a pool's space goes, and an
 * alphabetical slice of a hundred datasets would answer a capacity question with
 * whichever ones happen to sort first. `truncated_datasets` says when the cap
 * removed any, and ties break on the dataset name so the choice stays
 * deterministic.
 */
const MAX_DATASETS = 10;

/**
 * How many snapshots are read per dataset.
 *
 * A nightly task holds a thousand snapshots within three years and an hourly one
 * within six weeks, so this bites on real systems. What it costs when it does is
 * a NARROWER observed window rather than a wrong number: the two ends actually
 * used are reported as `observed_start` and `observed_end`, and every figure
 * beside them is a true statement about that window. `truncated_snapshots` says
 * when some dataset held more than were read.
 *
 * The same bound `snapshots_list` applies to its own listing, deliberately: two
 * tools reading the same rows should not disagree about how many of them are too
 * many.
 */
const MAX_SNAPSHOTS = 1000;

/** What a rate is stated per, in milliseconds. */
const MILLIS_PER_DAY = 24 * 60 * 60 * 1000;

/** What a dataset the system holds no snapshot of in the range is marked with. */
const NO_SNAPSHOTS = 'the system holds no snapshot of this dataset in this range';

/**
 * What a dataset whose snapshots in the range were all taken at one instant is
 * marked with. Distinct from {@link NO_SNAPSHOTS}: the dataset IS snapshotted
 * and there is a level to be had, and what is missing is the second instant that
 * would make it a change.
 */
const ONE_INSTANT =
  'the system holds no two snapshots of this dataset taken at different times in this range';

/**
 * What a dataset whose snapshot listing was CUT SHORT, and that yielded no
 * change from the part of it that was read, is marked with.
 *
 * Neither {@link NO_SNAPSHOTS} nor {@link ONE_INSTANT} may be used there, and
 * this is the whole reason this constant exists: no order is asked for, so the
 * thousand snapshots read are an arbitrary thousand, and every one of them
 * falling outside the range says nothing whatever about the ones that were not
 * read. Claiming the system holds no snapshot in the range would be a statement
 * about the system made from evidence that does not reach it.
 */
const TRUNCATED_READ =
  'the system holds more snapshots of this dataset than were read, and no two of ' +
  'the ones read fall at different times in this range';

/**
 * What a pool none of whose reported datasets yielded a change is marked with.
 *
 * A statement about what was OBTAINED rather than about the pool's snapshots,
 * and that is the whole distinction: the datasets that yielded nothing may have
 * yielded nothing because their reads failed or were cut short, and a pool-level
 * "these datasets have no snapshots at two different times" would then be
 * asserting the same thing {@link TRUNCATED_READ} exists to stop each dataset
 * asserting. Each of them names its own reason, so this points there.
 */
const NO_CHANGE_MEASURED =
  'no dataset reported for this pool yielded a change in this range; each of them names why';

/**
 * What a pool none of whose datasets are among the ones reported is marked with.
 *
 * Distinct from {@link NO_CHANGE_MEASURED}, which would be vacuously true here
 * and would read as a finding about this pool. Nothing of it was looked at:
 * `MAX_DATASETS` is a cap over the whole system rather than per pool, so a pool
 * holding only small datasets can be crowded out of the reporting entirely by
 * another pool's large ones.
 */
const NO_DATASETS_REPORTED =
  'no dataset of this pool is among the ones reported, so nothing was measured for it';

/** What a pool the system did not list is marked with, in place of its levels. */
const NOT_LISTED = 'the system did not list this pool';

/**
 * A ZFS property as the middleware reports it. `pool.dataset.query` and
 * `pool.snapshot.query` both answer rows typed `Record<string, unknown>`, so the
 * parsed value has to be restated — as `storage.ts` and `snapshots.ts` each
 * restate it, and local here for the reason those files give: a tool file is
 * read on its own.
 */
interface ZfsProperty {
  parsed?: unknown;
  rawvalue?: unknown;
}

/**
 * The numeric value of a byte-count property, or null where the middleware
 * reported none. Null rather than a coerced zero: a dataset whose size could not
 * be read must not report as one holding nothing.
 */
function propertyBytes(property: unknown): number | null {
  const parsed = (property as ZfsProperty | undefined)?.parsed;
  return typeof parsed === 'number' && Number.isFinite(parsed) ? parsed : null;
}

/** A finite number, or null where the system reported anything else. */
function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * One entry of a row's `properties` map, or undefined where the row carries no
 * map to read it from. Guarded rather than asserted, because a row that sends
 * something other than an object is exactly what the assertion would get wrong.
 */
function property(properties: unknown, name: string): unknown {
  return typeof properties === 'object' && properties !== null
    ? (properties as Record<string, unknown>)[name]
    : undefined;
}

/**
 * When a snapshot was taken, in milliseconds since the epoch, or null where the
 * system reported no time this tool can read.
 *
 * ZFS reports `creation` as whole seconds since the epoch and `rawvalue` is that
 * number as ZFS itself states it, which is why the raw value is read here rather
 * than `parsed` — the middleware's own rendering of the same instant has changed
 * format between releases. The same reading `snapshots_list` applies.
 */
function creationMillis(properties: unknown): number | null {
  const raw = (property(properties, 'creation') as ZfsProperty | undefined)?.rawvalue;
  // Digits or nothing: `Number('')` is 0, which would place a snapshot whose
  // creation time is an empty string at the epoch.
  const seconds =
    typeof raw === 'number' ? raw : typeof raw === 'string' && /^-?\d+$/.test(raw) ? Number(raw) : null;
  if (seconds === null || !Number.isFinite(seconds)) return null;
  const millis = seconds * 1000;
  // Beyond what a `Date` can hold, `toISOString` throws rather than answering,
  // and one absurd creation time would take the whole result down with it.
  return Number.isFinite(millis) && Math.abs(millis) <= 8.64e15 ? millis : null;
}

/** A dataset the system listed, reduced to what this tool needs of it. */
interface DatasetRow {
  id: string;
  pool: string;
  used: number | null;
}

/** What the dataset listing produced, with a failure named rather than thrown. */
interface DatasetListing {
  /** Every dataset the system named, which is what `datasets_total` counts. */
  all: DatasetRow[];
  /** The ones actually reported on: the largest, up to the cap. */
  reported: DatasetRow[];
  truncated: boolean;
  error: string | null;
}

/** Largest first, and by name where two are the same size or neither is readable. */
function byLargestFirst(a: DatasetRow, b: DatasetRow): number {
  if (a.used !== b.used) {
    // A dataset whose size could not be read is ordered last rather than as
    // empty: it may be the largest one there is, and nothing here can say.
    if (a.used === null) return 1;
    if (b.used === null) return -1;
    return b.used - a.used;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Every dataset the system lists, and the largest of them up to the cap.
 *
 * A row without a readable `id` names nothing that could be asked about, so it
 * is dropped — the id is what the snapshot listing is filtered by. A row whose
 * `pool` is unreadable is kept and attributed by the first segment of its id,
 * which is what a ZFS dataset name means; dropping it would lose a large dataset
 * from a pool's total over a field this tool only groups by.
 */
async function datasetListing(system: SystemHandle): Promise<DatasetListing> {
  try {
    // Filters and options are inlined so the call's own parameter types apply,
    // as in `storage.ts`. `retrieve_children` walks the whole tree and the
    // response is already flat, each entry additionally nesting its descendants
    // under `children` — so the top-level entries are every dataset exactly
    // once, and walking `children` would count each of them again.
    const rows = await firstValueFrom(
      system.client.api.query('pool.dataset.query', [], {
        extra: { retrieve_children: true, properties: ['used'] },
      }),
    );
    const all = rows.flatMap((row) => {
      if (typeof row !== 'object' || row === null) return [];
      const held = row as Record<string, unknown>;
      const id = textOrNull(held['id']);
      if (id === null) return [];
      return [{ id, pool: textOrNull(held['pool']) ?? id.split('/')[0], used: propertyBytes(held['used']) }];
    });
    const largest = [...all].sort(byLargestFirst);
    return {
      all,
      reported: largest.slice(0, MAX_DATASETS),
      truncated: largest.length > MAX_DATASETS,
      error: null,
    };
  } catch (reason) {
    return { all: [], reported: [], truncated: false, error: errorText(reason) };
  }
}

/** A pool's space as the system reports it right now. */
interface PoolLevels {
  used: number | null;
  free: number | null;
  total: number | null;
}

/** What the pool listing produced, with a failure named rather than thrown. */
interface PoolListing {
  levels: Map<string, PoolLevels>;
  error: string | null;
}

/**
 * Each pool's current space, keyed by pool name.
 *
 * Current rather than historical, because there is no historical: this is the
 * one place a caller can read the LEVEL a change should be judged against, and
 * it is stamped with `as_of` rather than presented as either end of the range.
 */
async function poolListing(system: SystemHandle): Promise<PoolListing> {
  try {
    const pools = await firstValueFrom(system.client.api.query('pool.query'));
    const levels = new Map<string, PoolLevels>();
    for (const pool of pools) {
      const name = textOrNull(pool.name);
      if (name === null) continue;
      levels.set(name, {
        used: numberOrNull(pool.allocated),
        free: numberOrNull(pool.free),
        total: numberOrNull(pool.size),
      });
    }
    return { levels, error: null };
  } catch (reason) {
    return { levels: new Map(), error: errorText(reason) };
  }
}

/** One snapshot's contribution to a dataset's history. */
interface Sample {
  at: number;
  bytes: number;
}

/** What the snapshot listing for one dataset produced. */
interface History {
  /** The samples inside the range, in whatever order the system listed them. */
  samples: Sample[];
  truncated: boolean;
  error: string | null;
}

/**
 * One dataset's space history over the range, from its snapshots.
 *
 * Read per dataset rather than in one listing of every snapshot, and the bound
 * is why: a single bounded listing would hold whichever snapshots the system
 * returned first, so one heavily snapshotted dataset could crowd out every other
 * one's history entirely. Per dataset the bound applies per dataset, and they
 * are all issued together.
 *
 * No `order_by`, for the reason `snapshots_list` gives at length: no field of a
 * snapshot row orders it in time soundly — `createtxg` is a string and is the
 * receiving system's on a replication target, and the creation time itself is
 * nested inside `properties`. Asking for an order that is wrong on those systems
 * would decide WHICH snapshots a truncated listing holds, which is worse than
 * asking for none, since the ends actually observed are reported either way.
 */
async function snapshotHistory(
  system: SystemHandle,
  dataset: string,
  range: Range,
): Promise<History> {
  try {
    const rows = await firstValueFrom(
      system.client.api.query('pool.snapshot.query', [['dataset', '=', dataset]], {
        // One more row than the bound. That extra row is what says the system
        // held more than fit; it is counted and then dropped.
        limit: MAX_SNAPSHOTS + 1,
        // Only the two properties this tool reads. A snapshot row otherwise
        // carries every ZFS property of the snapshot, on every row.
        extra: { properties: ['creation', 'referenced'] },
      }),
    );
    const samples: Sample[] = [];
    for (const row of rows.slice(0, MAX_SNAPSHOTS)) {
      const properties = row['properties'];
      const at = creationMillis(properties);
      const bytes = propertyBytes(property(properties, 'referenced'));
      // Both or neither: a snapshot with no readable size places nothing, and
      // one with no readable time cannot be placed. Either way it is not a
      // sample, and counting it would report a history it does not carry.
      if (at === null || bytes === null) continue;
      if (at < range.start || at > range.end) continue;
      samples.push({ at, bytes });
    }
    return { samples, truncated: rows.length > MAX_SNAPSHOTS, error: null };
  } catch (reason) {
    return { samples: [], truncated: false, error: errorText(reason) };
  }
}

/** What one dataset's history says, as the result states it. */
interface Trend {
  referenced_start_bytes: number | null;
  referenced_end_bytes: number | null;
  change_bytes: number | null;
  change_bytes_per_day: number | null;
  observed_start: string | null;
  observed_end: string | null;
  snapshots_observed: number;
  unavailable: string | null;
}

/** The same change, kept in the numbers a pool's aggregate is summed from. */
interface Measured {
  pool: string;
  change: number;
  perDay: number;
  startAt: number;
  endAt: number;
}

/** A dataset with no change to report, and why. Its sample count is still stated. */
function noTrend(reason: string, observed: number): Trend {
  return {
    referenced_start_bytes: null,
    referenced_end_bytes: null,
    change_bytes: null,
    change_bytes_per_day: null,
    observed_start: null,
    observed_end: null,
    snapshots_observed: observed,
    unavailable: reason,
  };
}

/**
 * The change between the ends of one dataset's history, and the rate it implies.
 *
 * The ends are the earliest and latest samples IN THE RANGE rather than the
 * range's own bounds, and they are reported, because they are what the numbers
 * beside them are true of: a range of a month over a dataset snapshotted twice
 * on its first day describes that day.
 *
 * The rate is taken over the observed window rather than over the range, for the
 * same reason. Dividing by the range would report a dataset that grew 10 GiB in
 * an hour as growing 10 GiB a month, which is the projection a caller would then
 * make from it.
 */
function trendOf(row: DatasetRow, history: History): { trend: Trend; measured: Measured | null } {
  if (history.error !== null) return { trend: noTrend(history.error, 0), measured: null };
  // A cut-short listing supports neither of the claims below, for the reason
  // {@link TRUNCATED_READ} gives. It still supports a change where one was
  // found: that is a statement about the two snapshots named beside it.
  if (history.samples.length === 0) {
    const reason = history.truncated ? TRUNCATED_READ : NO_SNAPSHOTS;
    return { trend: noTrend(reason, 0), measured: null };
  }
  let first = history.samples[0];
  let last = history.samples[0];
  for (const sample of history.samples) {
    if (sample.at < first.at) first = sample;
    if (sample.at > last.at) last = sample;
  }
  if (first.at === last.at) {
    const reason = history.truncated ? TRUNCATED_READ : ONE_INSTANT;
    return { trend: noTrend(reason, history.samples.length), measured: null };
  }
  const change = last.bytes - first.bytes;
  const perDay = Math.round(change / ((last.at - first.at) / MILLIS_PER_DAY));
  return {
    trend: {
      referenced_start_bytes: first.bytes,
      referenced_end_bytes: last.bytes,
      change_bytes: change,
      change_bytes_per_day: perDay,
      observed_start: new Date(first.at).toISOString(),
      observed_end: new Date(last.at).toISOString(),
      snapshots_observed: history.samples.length,
      unavailable: null,
    },
    measured: { pool: row.pool, change, perDay, startAt: first.at, endAt: last.at },
  };
}

/** Why a pool has no change to report, or null where it has one. */
function poolReason(measured: number, reportedDatasets: number): string | null {
  if (measured > 0) return null;
  return reportedDatasets === 0 ? NO_DATASETS_REPORTED : NO_CHANGE_MEASURED;
}

/** Usage as a percentage of a pool's size, to one decimal place. */
function percentOf(used: number | null, total: number | null): number | null {
  if (used === null || total === null || total <= 0) return null;
  return round1((used / total) * 100);
}

export const reportingSpaceTrends: ReadOnlyTool = {
  name: 'reporting_space_trends',
  description:
    'How pool and dataset space usage has MOVED over a time range, which is a ' +
    'different question from how full something is now — a pool at 60% that ' +
    'gained 30 points this month is a problem, and one that has sat at 85% for ' +
    'two years is not. THE HISTORY COMES FROM ZFS SNAPSHOTS, not from a ' +
    'recorded space graph: the system keeps no space series of any kind, so ' +
    'what is available is the bytes each snapshot records its dataset as ' +
    'REFERENCING at the instant it was taken. Everything about the answer ' +
    'follows from that. `datasets` holds one entry per dataset, each with: ' +
    '`dataset` and `pool`, matching `id` and `pool` in `storage_list_datasets`; ' +
    '`used_bytes`, the CURRENT size of the dataset with its descendants and ' +
    'snapshots; `referenced_start_bytes` and `referenced_end_bytes`, what the ' +
    'dataset itself referenced at the first and last snapshot found in the ' +
    'range; `change_bytes`, the second minus the first, NEGATIVE where the ' +
    'dataset shrank; `change_bytes_per_day`, that change as a rate, so a ' +
    'projection needs no arithmetic over a series; `observed_start` and ' +
    '`observed_end`, the instants those two snapshots were actually taken; and ' +
    '`snapshots_observed`, how many snapshots of it were read that fell in the ' +
    'range AND carried a readable time and size — one the system reported ' +
    'neither of is not counted, because it places nothing. THE ' +
    'OBSERVED WINDOW IS NOT THE RANGE, and the rate is per day of that window ' +
    'rather than of the range: a month-long range over a dataset snapshotted ' +
    'twice on its first day describes that day. `referenced` is the data the ' +
    'dataset itself holds, which is what ZFS records at snapshot time; `used` ' +
    'has no history at all, and neither does free space, so `used_bytes` is a ' +
    'reading taken now and stamped `as_of` rather than a value at either end ' +
    'of the range. At most ten datasets are reported, THE LARGEST BY CURRENT ' +
    '`used_bytes` — not the fastest growing, which cannot be known before ' +
    'reading them — and `truncated_datasets` is true when the system has more. ' +
    'At most a thousand snapshots are read per dataset, and no order is asked ' +
    'for, so they are an arbitrary thousand; `truncated_snapshots` is true ' +
    'when some dataset had more, and the window observed for it may then be ' +
    'narrower than the range — how much narrower is not knowable, since which ' +
    'thousand were read is not. Such a dataset that yielded no change SAYS SO IN ' +
    '`unavailable` rather than reporting that the system holds no snapshot of ' +
    'it — the part not read cannot be spoken for. `pools` holds one entry per ' +
    'pool, each ' +
    'with: `used_bytes`, `free_bytes`, `total_bytes` and `used_percent`, the ' +
    "pool's space AS OF NOW rather than over the range, with " +
    '`levels_unavailable` naming why where they could not be read; ' +
    '`referenced_change_bytes` and `referenced_change_bytes_per_day`, the SUM ' +
    'of those figures over the datasets reported for that pool; ' +
    '`observed_start` and `observed_end`, the earliest and latest instants any ' +
    'of them was observed at, which means the summed figures cover windows ' +
    'that may differ between datasets; and `datasets_observed` against ' +
    '`datasets_total`, which is how far the sum covers the pool at all. THAT ' +
    'SUM IS NOT THE CHANGE IN THE POOL\'S USED SPACE, and is not a bound on it ' +
    'in either direction: it omits every dataset not reported and every dataset ' +
    'with too few snapshots — EACH OF WHICH MAY HAVE GROWN OR SHRUNK, so the ' +
    'sum can fall on either side of the pool\'s own change — and it omits space ' +
    'held only by snapshots of data since deleted. Read it as the direction the ' +
    'datasets it names are moving in, against `datasets_observed`, and read ' +
    '`used_percent` for how full the pool is now. `unavailable` is null on an ' +
    'entry with a change to report and otherwise names why there is none — the ' +
    'system holds no snapshot of that dataset in the range, or none at two ' +
    'different times, or the read was cut short, or it failed with the reason ' +
    'the system gave. On a POOL it says instead that none of the datasets ' +
    'reported for it yielded a change — each of those names its own reason — ' +
    'or that none of its datasets is among the ones reported at all, which the ' +
    'ten-dataset cap can do to a pool holding only small ones. ' +
    'WHERE IT IS NON-NULL EVERY MEASUREMENT IS NULL — the two referenced ' +
    'figures, the change, the rate and both instants — and that is never a ' +
    'dataset that did not change: nothing was measured. `snapshots_observed` ' +
    'is still reported there, and is what says whether the reason was none at ' +
    'all or too few. ' +
    '`used_bytes` and the pool levels are read separately and are reported ' +
    'whatever `unavailable` says. Entries fail independently, so one dataset ' +
    'can report while another cannot. `start` and `end` are the range asked ' +
    'about, as ISO 8601 UTC timestamps. Give them to bound it; OMITTED, THE ' +
    'LAST HOUR ending now, which for this tool is almost never what is wanted ' +
    '— snapshots are hours or days apart, so ask for weeks or months. This ' +
    'tool reads what snapshots record. It does not report which files grew, ' +
    'per-share or per-app usage, quota headroom — `datasets_quota_report` ' +
    'answers that — or what a pool held before its oldest surviving snapshot, ' +
    'and it changes nothing.',
  inputSchema: {
    type: 'object',
    properties: {
      start: {
        type: 'string',
        description:
          'The beginning of the range, as an ISO 8601 timestamp — ' +
          '"2026-08-29T09:00:00Z" — or a date, "2026-08-29", which is ' +
          'midnight. A time given without a timezone is read as UTC. Omitted, ' +
          'one hour before the end of the range.',
      },
      end: {
        type: 'string',
        description: 'The end of the range, in the same forms as `start`. Omitted, now.',
      },
    },
  },
  requiredRole: Role.ReadOnly,
  mutating: false,
  async handler({ system }, args) {
    // The range is resolved before anything is read, so an unreadable bound is
    // an error rather than a query the system answers over the wrong interval.
    const now = Date.now();
    const range = resolveRange(args, now);
    const [datasets, pools] = await Promise.all([datasetListing(system), poolListing(system)]);
    // Every pool either listing named. A pool with no dataset listed still
    // reports its levels, and a pool whose datasets were listed still reports
    // its coverage, which is what keeps one failed read from hiding the other's
    // answer.
    const names = [...new Set([...datasets.all.map((row) => row.pool), ...pools.levels.keys()])];
    names.sort();
    // A failure with nowhere to be reported is thrown instead. Every failure
    // this tool catches is carried by a pool entry, so no pool entries means no
    // pool named it — and answering an empty result would read as a system
    // holding no storage at all. The test is what the result CAN carry rather
    // than which read failed: a dataset listing that failed beside a pool one
    // that answered nothing leaves the same silence as both of them failing.
    const failure = datasets.error ?? pools.error;
    if (names.length === 0 && failure !== null) throw new Error(failure);

    const histories = await Promise.all(
      datasets.reported.map((row) => snapshotHistory(system, row.id, range)),
    );
    const measured: Measured[] = [];
    const reported = datasets.reported.map((row, position) => {
      const answer = trendOf(row, histories[position]);
      if (answer.measured !== null) measured.push(answer.measured);
      return { dataset: row.id, pool: row.pool, used_bytes: row.used, ...answer.trend };
    });

    return {
      start: new Date(range.start).toISOString(),
      end: new Date(range.end).toISOString(),
      as_of: new Date(now).toISOString(),
      pools: names.map((name) => {
        const levels = pools.levels.get(name);
        const mine = measured.filter((entry) => entry.pool === name);
        const ours = reported.filter((row) => row.pool === name);
        return {
          pool: name,
          used_bytes: levels?.used ?? null,
          free_bytes: levels?.free ?? null,
          total_bytes: levels?.total ?? null,
          used_percent: percentOf(levels?.used ?? null, levels?.total ?? null),
          levels_unavailable: levels === undefined ? (pools.error ?? NOT_LISTED) : null,
          referenced_change_bytes:
            mine.length === 0 ? null : mine.reduce((total, entry) => total + entry.change, 0),
          referenced_change_bytes_per_day:
            mine.length === 0 ? null : mine.reduce((total, entry) => total + entry.perDay, 0),
          observed_start:
            mine.length === 0
              ? null
              : new Date(Math.min(...mine.map((entry) => entry.startAt))).toISOString(),
          observed_end:
            mine.length === 0
              ? null
              : new Date(Math.max(...mine.map((entry) => entry.endAt))).toISOString(),
          datasets_observed: mine.length,
          // Null rather than zero where the listing failed: "this pool has no
          // datasets" is a claim, and nothing here looked.
          datasets_total:
            datasets.error === null
              ? datasets.all.filter((row) => row.pool === name).length
              : null,
          unavailable: datasets.error ?? poolReason(mine.length, ours.length),
        };
      }),
      datasets: reported,
      truncated_datasets: datasets.truncated,
      truncated_snapshots: histories.some((history) => history.truncated),
    };
  },
};

/**
 * App and VM usage: what each application and virtual machine is consuming,
 * attributed to the workload rather than summed over the host.
 *
 * "What is eating my memory" is the question, and nothing else in the catalog
 * answers it: `reporting_utilisation` reports the host's totals over a range,
 * and `apps_list` and `vms_list` report what each workload IS — its state, and
 * the CPU and memory it was GIVEN — rather than what it is using.
 *
 * WHAT THIS API SURFACE CAN BE ASKED FOR IS NARROWER THAN THE QUESTION, and the
 * shape of this tool is that fact rather than a choice. Three listings name the
 * workloads — `app.query`, `vm.query` and `virt.instance.query` — and not one of
 * those rows carries a consumption figure of any kind. What the middleware does
 * expose is, for the most part, not reachable through the pinned client:
 *
 * - Per-app CPU and memory are in the `app.stats` EVENT SOURCE, which takes a
 *   subscribe-time `interval`. The client excludes every event source from
 *   `api.events` deliberately, and says why: `core.subscribe` is typed as one
 *   string with no documented encoding for the arguments, so subscribing would
 *   send the name with the arguments dropped and the server would not honour it.
 *   There is no supported way to read it from here.
 * - Per-VM memory on the libvirt stack is `vm.get_memory_usage`, an ordinary
 *   call. It is the ONE consumption figure this tool can obtain.
 * - Per-VM CPU has no method on this surface at all, and the incus stack has
 *   neither figure: a `virt.instance.query` row carries the instance's
 *   allocation and its status, and `container.metrics` is another event source.
 *
 * So every entry carries both figures, and one that could not be obtained is
 * null beside a marker naming why — never a zero, and never omitted. A tool that
 * dropped the fields it cannot fill would read as a complete answer to the
 * attribution question, and one that reported the ALLOCATION under a name
 * meaning consumption would answer it wrongly. The markers are per figure and
 * per entry because the reasons differ that finely: on the same system a
 * running libvirt VM reports its memory, a stopped one has none to report, and
 * an app has none that can be read at all.
 */

/** What kind of workload an entry describes. */
type WorkloadKind = 'app' | 'vm';

/** Which listing an entry was read from. */
type WorkloadSource = 'app' | 'vm' | 'virt_instance';

/**
 * The state word both VM stacks use for a machine that is running. Only the
 * libvirt stack is tested against it — it is what decides whether there is a
 * memory figure to ask for — and the incus stack uses the same word, which is
 * why this is not spelled per stack.
 */
const RUNNING = 'RUNNING';

/**
 * What an app's figures are marked with. The reason is a fact about the API
 * surface rather than about the app, so it is the same on a running app as on a
 * stopped one: neither has a figure that can be read.
 */
const NO_APP_STATS =
  'this system exposes per-app CPU and memory only through a subscription, which this tool does not open';

/** What an incus-backed instance's figures are marked with, for the same kind of reason. */
const NO_INSTANCE_STATS =
  'this system exposes no CPU or memory consumption for an incus-backed instance that this tool can read';

/** What every virtual machine's CPU figure is marked with, on both stacks. */
const NO_VM_CPU =
  'this system exposes no per-virtual-machine CPU consumption that this tool can read';

/**
 * What a libvirt VM the system reported a state for that is not `RUNNING` is
 * marked with.
 *
 * It says what was done rather than what the machine is consuming, because "not
 * RUNNING" covers two different facts on this stack: a STOPPED machine is
 * consuming nothing, and a SUSPENDED one may still be holding everything it
 * had. Nothing here can say which of the two a given state word is, so both are
 * stated and `state` beside it is what tells them apart.
 */
const VM_NOT_RUNNING =
  'the system reports this virtual machine as not RUNNING, so no memory was read for it — a ' +
  'stopped machine is consuming none, and a suspended one may still be holding what it had';

/**
 * What a libvirt VM the system reported no readable state for is marked with.
 *
 * Kept apart from {@link VM_NOT_RUNNING}: an unreadable state is not evidence
 * that the machine is stopped, and reporting one as the other turns a read that
 * failed into a claim about a machine that may well be running.
 */
const NO_VM_STATE =
  'the system reported no state for this virtual machine, so its memory was not read';

/**
 * What a libvirt VM the system named no identifier for is marked with. The
 * memory read is by id, so a row without one cannot be asked about at all —
 * which is not the same as a VM that is not running.
 */
const NO_VM_ID = 'the system reported no identifier for this virtual machine to read its memory by';

/** What a memory read that answered something other than a number is marked with. */
const NO_MEMORY_FIGURE = 'the system answered with no memory figure this tool could read';

/**
 * The rows each listing answers with, taken from the API surface the tools are
 * typed against rather than restated here — for the reason `vms.ts` gives: read
 * as bare records the field names below would compile whatever they were asked
 * for, so a regenerated client that renames one would turn its value into a null
 * with no build error and with hand-written fixtures that still pass.
 */
type AppEntry = ApiSurface['call']['app.query']['entity'];
type VmEntry = ApiSurface['call']['vm.query']['entity'];
type VirtInstanceEntry = ApiSurface['call']['virt.instance.query']['entity'];

/** One app or virtual machine, in the shape this tool reports it. */
interface UsageRow {
  kind: WorkloadKind;
  source: WorkloadSource;
  id: string | number | null;
  name: string | null;
  state: string | null;
  cpu_percent: number | null;
  cpu_unavailable: string | null;
  memory_used_bytes: number | null;
  memory_unavailable: string | null;
}

/** A listing that could not be read at all, named by the source it was against. */
interface UsageFailure {
  source: WorkloadSource;
  error: string;
}

/** A listing that produced rows, or the failure that stopped it. */
interface Listing<T> {
  rows: T[];
  failure: UsageFailure | null;
}

/**
 * One listing, with a failure caught and named rather than thrown.
 *
 * NO LISTING IS ALLOWED TO FAIL THE TOOL, as in `vms_list`: a system may
 * legitimately have only one of the two VM stacks, and an app listing that fails
 * must not take the VMs down with it. The read is passed as a thunk so the call
 * is made inside the `try`, which keeps this correct for one that throws before
 * it returns a promise at all.
 */
async function listing<T>(source: WorkloadSource, read: () => Promise<T[]>): Promise<Listing<T>> {
  try {
    return { rows: await read(), failure: null };
  } catch (reason) {
    return { rows: [], failure: { source, error: errorText(reason) } };
  }
}

/** One VM's memory consumption, or the stated reason there is no figure. */
interface MemoryRead {
  bytes: number | null;
  unavailable: string | null;
}

/**
 * One libvirt VM's memory consumption, or the stated reason none was read.
 *
 * (unconfirmed) THE FIGURE IS BYTES. It is passed through under a name that says
 * bytes, so a release reporting it in kibibytes would be reported a thousandfold
 * small — wrong rather than absent, which is the same kind of assumption
 * {@link NETWORK_UNIT} carries and is stated in the description for the same
 * reason: a memory figure with no unit cannot be compared with anything.
 *
 * Only a machine the system reported AS RUNNING is asked about. The call would
 * fail on a domain that is not there, and the state is a better answer than the
 * error text that would come back: it is the reason there is no figure, and it
 * is a fact about the machine rather than about the read.
 *
 * The three reasons for not asking are kept apart because they are different
 * facts, and only one of them is about the machine's consumption: no identifier
 * to ask by, no state to decide from, and a state that is not RUNNING.
 */
async function vmMemory(
  system: SystemHandle,
  id: number | null,
  state: string | null,
): Promise<MemoryRead> {
  if (id === null) return { bytes: null, unavailable: NO_VM_ID };
  if (state === null) return { bytes: null, unavailable: NO_VM_STATE };
  if (state !== RUNNING) return { bytes: null, unavailable: VM_NOT_RUNNING };
  try {
    const answer = await firstValueFrom(system.client.api.call('vm.get_memory_usage', [id]));
    const bytes = numberOrNull(answer);
    return bytes === null ? { bytes: null, unavailable: NO_MEMORY_FIGURE } : { bytes, unavailable: null };
  } catch (reason) {
    return { bytes: null, unavailable: errorText(reason) };
  }
}

/** An application as `app.query` reports it. Neither figure is readable here. */
function fromApp(entry: AppEntry): UsageRow {
  return {
    kind: 'app',
    source: 'app',
    id: textOrNull(entry.id),
    name: textOrNull(entry.name),
    state: textOrNull(entry.state),
    cpu_percent: null,
    cpu_unavailable: NO_APP_STATS,
    memory_used_bytes: null,
    memory_unavailable: NO_APP_STATS,
  };
}

/**
 * What a libvirt VM's row says about itself: the identifier its memory is read
 * by, and the middleware's own state word.
 *
 * Derived ONCE and then used both to decide the memory read and to fill the
 * entry. Deriving it twice would let the state a result reports drift from the
 * state that decided whether to read its memory, so an entry could say RUNNING
 * beside a marker saying it is not.
 */
interface VmReading {
  id: number | null;
  state: string | null;
}

/**
 * `status` read back as a partial of ITS OWN TYPE, which is how `vms_list` reads
 * it and is what checks the field name below against the generated client.
 * Reached through {@link property} instead it would be an unchecked string key:
 * a client that renamed the field would null every VM's state here and skip
 * every memory read with it, silently and with the fixtures still passing.
 *
 * The type declares `status` present and non-null; a system that sent neither
 * must still answer a null state rather than throw, so it is read through the
 * optional chain rather than trusted.
 */
function vmReading(entry: VmEntry): VmReading {
  const status = entry.status as Partial<VmEntry['status']> | null | undefined;
  return { id: numberOrNull(entry.id), state: textOrNull(status?.state) };
}

/**
 * A libvirt-backed VM as `vm.query` reports it, with its reading and the memory
 * figure already taken from it.
 */
function fromVm(entry: VmEntry, reading: VmReading, memory: MemoryRead): UsageRow {
  return {
    kind: 'vm',
    source: 'vm',
    id: reading.id,
    name: textOrNull(entry.name),
    state: reading.state,
    cpu_percent: null,
    cpu_unavailable: NO_VM_CPU,
    memory_used_bytes: memory.bytes,
    memory_unavailable: memory.unavailable,
  };
}

/** An incus-backed VM as `virt.instance.query` reports it. Neither figure is readable. */
function fromInstance(entry: VirtInstanceEntry): UsageRow {
  return {
    kind: 'vm',
    source: 'virt_instance',
    id: textOrNull(entry.id),
    name: textOrNull(entry.name),
    state: textOrNull(entry.status),
    cpu_percent: null,
    cpu_unavailable: NO_VM_CPU,
    memory_used_bytes: null,
    memory_unavailable: NO_INSTANCE_STATS,
  };
}

export const reportingAppVmUsage: ReadOnlyTool = {
  name: 'reporting_app_vm_usage',
  description:
    'What each application and virtual machine on a TrueNAS system is ' +
    'consuming right now, attributed per workload. This is what answers "which ' +
    'app is eating my memory" — `reporting_utilisation` reports the host TOTAL ' +
    'over a range and cannot attribute any of it, and `apps_list` and ' +
    '`vms_list` report what each workload was GIVEN rather than what it is ' +
    'using. `entries` holds one entry per app and per virtual machine, in one ' +
    'list: `kind` is `app` or `vm`, and `source` is which listing it came from ' +
    '— `app`, `vm` for the older libvirt-backed VMs, or `virt_instance` for the ' +
    'newer incus-backed ones. Apps are listed first, then `vm` entries, then ' +
    '`virt_instance` ones, each in the order the system listed them. `id` is ' +
    'the identifier that listing uses and is unique only within its own ' +
    '`source`, so two entries may share a `name` or an `id` while being ' +
    'different things. `state` is the state word the system itself used, ' +
    'untranslated: an app is `RUNNING`, `STOPPED`, `CRASHED`, `DEPLOYING` or ' +
    '`STOPPING`; an incus instance one of `RUNNING`, `STOPPED`, `STARTING`, ' +
    '`STOPPING`, `FROZEN`, `FREEZING`, `THAWED`, `ABORTING`, `ERROR` or ' +
    '`UNKNOWN`; a libvirt VM the middleware\'s own narrower vocabulary, in ' +
    'which a VM that died commonly reads `STOPPED` — `vms_list` is what carries ' +
    'libvirt\'s own state beside it. `memory_used_bytes` is the memory the ' +
    'workload is actually using, IN BYTES, and `cpu_percent` its share of CPU. ' +
    'MOST OF THOSE FIGURES CANNOT BE READ ON THIS API, AND WHERE ONE CANNOT IT ' +
    'IS NULL WITH `memory_unavailable` OR `cpu_unavailable` NAMING WHY — WHICH ' +
    'IS NEVER A WORKLOAD CONSUMING NOTHING. Specifically: no CPU figure is ' +
    'available for any workload; memory is available only for a RUNNING ' +
    'libvirt-backed VM; and per-app CPU and memory are exposed by the system ' +
    'only through a subscription this tool does not open, so an app reports its ' +
    'name and state and no consumption at all. A libvirt VM the system reports ' +
    'as anything other than RUNNING is not asked about, and `memory_unavailable` ' +
    'says so: A STOPPED MACHINE IS CONSUMING NOTHING, WHILE A SUSPENDED ONE MAY ' +
    'STILL BE HOLDING WHAT IT HAD, and `state` is what tells those apart. A VM ' +
    'whose state could not be read says that instead, and is not reported as ' +
    'stopped. A memory read that failed carries the reason the system gave. ' +
    'Entries fail independently, so one VM can report its memory while another ' +
    'cannot. AN EMPTY `entries` LIST WITH AN EMPTY `failures` LIST IS A SYSTEM ' +
    'RUNNING NO APPS AND NO VMs. `failures` names each listing that could not ' +
    'be read at all, as `source` and the `error` the system gave, and WHILE IT ' +
    'IS NOT EMPTY THE LIST IS INCOMPLETE — a system whose VMs all live in the ' +
    'stack that failed reports none of them. A stack absent from a given ' +
    'TrueNAS release appears here as a failure for that reason. Incus ' +
    'containers are excluded, as in `vms_list`. This tool reports consumption ' +
    'now, not over a range: `reporting_utilisation` is the host over time, ' +
    '`reporting_disk_io` is per-disk activity, and `vms_list` and `apps_list` ' +
    'are what a workload is allocated and what version it runs. It does not ' +
    'report per-process usage, per-container or per-device breakdowns, disk or ' +
    'network traffic per workload, and it starts, stops and changes nothing. NO ' +
    'field beyond those named here is returned, whatever a later TrueNAS ' +
    'release adds to any of the three records.',
  inputSchema: { type: 'object', properties: {} },
  requiredRole: Role.ReadOnly,
  mutating: false,
  async handler({ system }) {
    // All three listings are issued before any is awaited, and each is caught:
    // see `listing` for why none of them may fail the tool.
    const [apps, vms, instances] = await Promise.all([
      listing('app', () => firstValueFrom(system.client.api.query('app.query'))),
      listing('vm', () => firstValueFrom(system.client.api.query('vm.query'))),
      listing('virt_instance', () =>
        firstValueFrom(
          // The filter is inlined so the call's own parameter types apply, as
          // in `vms_list`: written to a `const` first it widens and no longer
          // satisfies the filter tuple.
          system.client.api.query('virt.instance.query', [['type', '=', 'VM']]),
        ),
      ),
    ]);

    // Read once, and used both to decide the memory read and to fill the entry:
    // see {@link VmReading}.
    const readings = vms.rows.map(vmReading);
    // One read per VM, all issued together. Only a running VM with a readable
    // id is actually asked about; the rest resolve to their stated reason
    // without a call, which is what keeps this bounded by the RUNNING VMs
    // rather than by every row the stack holds.
    const memories = await Promise.all(
      readings.map((reading) => vmMemory(system, reading.id, reading.state)),
    );

    return {
      entries: [
        ...apps.rows.map(fromApp),
        ...vms.rows.map((entry, position) => fromVm(entry, readings[position], memories[position])),
        // The `type` filter above is asked of the middleware; this re-checks it
        // on what came back, as `vms_list` does. A query parameter a release
        // does not recognise is dropped rather than refused, and the result of
        // that is containers in a list of virtual machines.
        ...instances.rows.filter((entry) => entry.type === 'VM').map(fromInstance),
      ],
      failures: [apps.failure, vms.failure, instances.failure].filter(
        (failure): failure is UsageFailure => failure !== null,
      ),
    };
  },
};
