import { firstValueFrom } from 'rxjs';
import { Role } from '@/interfaces';
import { ReadOnlyTool, SystemHandle } from '@/catalog/tool';

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
 * seconds, and the unit the interface graph records. Each is read defensively —
 * a wrong reading costs a stated `unavailable` rather than a plausible wrong
 * value — except the interface unit, which is named in the result and would be
 * wrong rather than absent; see `NETWORK_UNIT`.
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
 * What a metric whose graph came back without the dimension it is derived from
 * is marked with. Not the same as {@link NO_DATA}: the system answered with a
 * series, and it is not one this reduction can be computed from.
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
type GraphName = 'cpu' | 'memory' | 'interface';

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
 * How a metric is computed from one sample's dimensions. Null where this sample
 * does not yield one — a dimension the graph did not carry, or a total of zero
 * to divide by.
 */
type Derivation = (dimensions: Dimensions) => number | null;

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
 * The count of rows in the range is kept beside them because it is what
 * separates the two ways a metric ends up with nothing — a system that recorded
 * no sample, and a graph whose samples carry no dimension this metric is derived
 * from. Both are an empty list of points and they are different facts.
 */
function points(graph: GraphAttempt, range: Range, derive: Derivation): Samples {
  const index = columns(graph.legend);
  const found: Point[] = [];
  let inRange = 0;
  for (const row of graph.rows) {
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
    const value = derive(dimensions);
    if (value !== null) found.push({ at, value });
  }
  return { found, inRange };
}

/** To one decimal place, which is the precision every metric here is reported at. */
function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/** The metrics this tool reports. */
type MetricName = 'cpu_percent' | 'memory_used_percent' | 'network_received' | 'network_sent';

/** One metric over the range, or the stated reason there is none. */
interface MetricReport {
  metric: MetricName;
  interface: string | null;
  unit: string;
  min: number | null;
  max: number | null;
  mean: number | null;
  latest: number | null;
  buckets: (number | null)[];
  unavailable: string | null;
}

/** A metric with nothing to report, and why. */
function unavailable(
  metric: MetricName,
  iface: string | null,
  unit: string,
  reason: string,
): MetricReport {
  return {
    metric,
    interface: iface,
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
function summarise(
  metric: MetricName,
  iface: string | null,
  unit: string,
  found: Point[],
  range: Range,
): MetricReport {
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
    metric,
    interface: iface,
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
const cpuPercent: Derivation = (dimensions) => {
  const idle = dimensions.get('idle');
  if (idle === undefined) return null;
  return Math.min(100, Math.max(0, 100 - idle));
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
const memoryUsedPercent: Derivation = (dimensions) => {
  const used = dimensions.get('used');
  if (used === undefined || dimensions.get('free') === undefined) return null;
  let total = 0;
  for (const part of MEMORY_PARTS) total += dimensions.get(part) ?? 0;
  if (total <= 0) return null;
  return Math.min(100, Math.max(0, (used / total) * 100));
};

/**
 * The magnitude of one direction of interface traffic.
 *
 * The magnitude rather than the value, because netdata's interface chart mirrors
 * one direction below the axis to draw it: a sent rate arrives negative on a
 * link that is sending, and passing it through would report a busy link as one
 * with less than no traffic. Direction is what the metric name says, so the sign
 * carries nothing this result needs.
 */
function throughput(dimension: string): Derivation {
  return (dimensions) => {
    const value = dimensions.get(dimension);
    return value === undefined ? null : Math.abs(value);
  };
}

/** The interfaces to report, and whether the cap left any out. */
interface Interfaces {
  names: string[];
  truncated: boolean;
  error: string | null;
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
async function interfaceNames(system: SystemHandle): Promise<Interfaces> {
  try {
    const rows = await firstValueFrom(system.client.api.query('interface.query'));
    const named = rows.flatMap((row) => {
      const name = textOrNull(row['name']);
      return name === null ? [] : [name];
    });
    // Sorted before the cap, so which interfaces a capped result covers is a
    // property of the system rather than of the order it happened to list them.
    named.sort();
    return {
      names: named.slice(0, MAX_INTERFACES),
      truncated: named.length > MAX_INTERFACES,
      error: null,
    };
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
      graphMetric('cpu_percent', null, PERCENT, cpu, range, cpuPercent),
      graphMetric('memory_used_percent', null, PERCENT, memory, range, memoryUsedPercent),
    ];
    if (interfaces.names.length === 0) {
      // Both network metrics are still reported, carrying the reason no
      // interface could be graphed — the listing failed, or it was read and
      // named none. Absent metrics would read as a system with no network at
      // all, which is the one thing a result must not imply here.
      const reason = interfaces.error ?? NO_INTERFACES;
      metrics.push(
        unavailable('network_received', null, NETWORK_UNIT, reason),
        unavailable('network_sent', null, NETWORK_UNIT, reason),
      );
    }
    interfaces.names.forEach((name, position) => {
      const graph = network[position];
      metrics.push(
        graphMetric('network_received', name, NETWORK_UNIT, graph, range, throughput('received')),
        graphMetric('network_sent', name, NETWORK_UNIT, graph, range, throughput('sent')),
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

/**
 * One metric from one graph: the summary where the graph yielded samples, and
 * the stated reason where it did not.
 *
 * The three ways there is nothing to report are kept apart, because they are
 * different facts about the system: the read failed, the graph carried no
 * series this metric is derived from, and the graph was read and held no sample
 * in the range. Only the last is "the system was not recording".
 */
function graphMetric(
  metric: MetricName,
  iface: string | null,
  unit: string,
  graph: GraphAttempt,
  range: Range,
  derive: Derivation,
): MetricReport {
  if (graph.error !== null) return unavailable(metric, iface, unit, graph.error);
  const samples = points(graph, range, derive);
  if (samples.inRange === 0) return unavailable(metric, iface, unit, NO_DATA);
  // Rows inside the range that yielded no value are a dimension this metric is
  // derived from that the graph did not carry — the samples were there.
  if (samples.found.length === 0) return unavailable(metric, iface, unit, NO_DIMENSION);
  return summarise(metric, iface, unit, samples.found, range);
}
