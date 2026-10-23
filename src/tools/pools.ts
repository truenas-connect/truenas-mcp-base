import { firstValueFrom } from 'rxjs';
import { Role } from '@/interfaces';
import { MutatingTool, PlanStep, ReadOnlyTool, ToolContext } from '@/catalog/tool';
import {
  agreement,
  booleanOrNull,
  errorText,
  numberOrNull,
  plural,
  recordOrNull,
  textOrNull,
} from '@/tools/common';

/** Pool internals: the vdev tree beneath each pool, the state of every device
 * in it, and the outcome of the last scrub that verified it — and, since #181,
 * the periodic scrub tasks that decide when the next one runs.
 *
 * `storage_pool_status` reports a pool as one unit, so it can say a pool is
 * DEGRADED and not which device made it so. The vdev tree is where that answer
 * lives, and it is the difference between "your pool is unhealthy" and "disk
 * sdf in mirror-1 has faulted".
 *
 * The mapping is an allowlist rather than a trim, as in `disks.ts` and
 * `apps.ts`, and here the volume is the reason: a raw topology node carries per
 * vdev I/O statistics, a GUID, device paths and the middleware's own
 * `unavail_disk` block, on every node of a tree that has one leaf per disk in
 * the system. Passed through, a 24-bay system's topology would dwarf every
 * other response in the catalog.
 */

/**
 * The vdev roles a pool's topology is divided into, ordered for a reader
 * rather than after the payload: `PoolTopology` declares them data, log,
 * cache, spare, special, dedup, and the two storage roles are grouped up
 * beside `data` here because they hold pool data and the other three do not.
 * Iterating a fixed list rather than the payload's own keys is what
 * keeps a category a later TrueNAS release adds out of the response — the same
 * guarantee the per-node field list gives, one level up.
 */
const VDEV_CATEGORIES = ['data', 'special', 'dedup', 'log', 'cache', 'spare'] as const;

/**
 * A node of the vdev tree as the middleware reports it. The generated types
 * erase every topology category to `unknown[]`, so the fields read here are
 * re-stated, the same way `storage.ts` re-states a ZFS property.
 */
interface TopologyNode {
  name?: string;
  type?: string;
  status?: string;
  disk?: string | null;
  children?: TopologyNode[];
}

/** One vdev, or one device beneath it: the same shape at every depth. */
interface TopologyDevice {
  name: string | null;
  type: string | null;
  status: string | null;
  disk: string | null;
  devices: TopologyDevice[];
}

/**
 * A field the middleware did not send, reported as null rather than dropped.
 *
 * `undefined` serializes to no key at all, so a middleware that omits a field
 * would hand the caller an object missing one the description promises — a
 * shape it has not been told about, rather than a value it can see is absent.
 * Unlike `pool` in `disks.ts`, absent and null have nothing to keep apart on a
 * topology node or a scan record: each field has one intended meaning, and
 * "not reported" is it.
 */
const orNull = (value: string | null | undefined): string | null => value ?? null;

function mapNode(node: TopologyNode): TopologyDevice {
  return {
    name: orNull(node.name),
    // The vdev kind — MIRROR, RAIDZ1, DISK, and so on — not the medium. A leaf
    // is reported as type DISK, which is how a single-disk (stripe) vdev and a
    // member of a mirror end up looking alike; their depth is what separates
    // them.
    type: orNull(node.type),
    status: orNull(node.status),
    // Null on a node that groups other devices, and null again on a leaf whose
    // disk the middleware could not resolve — a pulled or dead device, for
    // which it sends `unavail_disk` in place of a disk. That block is dropped
    // with the rest of the per-node detail, so a device in that state is
    // located by its position in the tree rather than named.
    disk: orNull(node.disk),
    // Nested rather than flattened. A disk being replaced is reported as a
    // `replacing` vdev holding the outgoing and incoming disks, and a draid's
    // distributed spare nests the same way; flattening would present both
    // members as peers of the mirror they sit under.
    devices: (node.children ?? []).map(mapNode),
  };
}

export const poolTopology: ReadOnlyTool = {
  name: 'storage_pool_topology',
  description:
    'The vdev layout of each ZFS pool and the state of every device in it. ' +
    'Each vdev carries a `category` naming the role it serves in the pool — ' +
    '`data`, `special`, `dedup`, `log`, `cache` or `spare` — so a cache or ' +
    'spare device is never read as one holding data. `status` is the ZFS ' +
    'state of that vdev or device: ONLINE is healthy, and FAULTED, DEGRADED, ' +
    'OFFLINE, UNAVAIL and REMOVED are the states that make a pool unhealthy, ' +
    'so they are what identifies the device behind a degraded pool. A device ' +
    'in the `spare` category has two states of its own that are not failures: ' +
    'AVAIL is an idle spare standing by, INUSE one that has been swapped in ' +
    'for a failed disk. Any other status on a spare is a failing spare, and is ' +
    'read like any other. `disk` names the physical device, matching `name` in ' +
    '`disks_list`. It is null on a vdev that groups other devices rather than ' +
    'sitting on one, and null again on a device the system can no longer ' +
    'resolve to a disk — one pulled or dead outright, which is what a REMOVED ' +
    'or UNAVAIL status on a leaf usually means. Such a device is still ' +
    'reported, in its place in the tree, and `name` is what ZFS calls that ' +
    'slot; there is simply no disk left to name, so it cannot be matched ' +
    'against `disks_list`. `devices` nests: a mirror lists its ' +
    'members, and a member being replaced lists the outgoing and incoming ' +
    'disks beneath it.',
  inputSchema: { type: 'object', properties: {} },
  requiredRole: Role.ReadOnly,
  mutating: false,
  async handler({ system }) {
    // No filters and no options: `topology` is part of a pool row as it stands,
    // and the client exposes no option that changes how it is nested.
    const pools = await firstValueFrom(system.client.api.query('pool.query'));
    return pools.map((pool) => ({
      name: pool.name,
      // The pool's own verdict, repeated from `storage_pool_status` so that a
      // caller reaching for the tree does not have to make a second call to
      // learn whether the tree is worth reading.
      status: pool.status,
      vdevs: VDEV_CATEGORIES.flatMap((category) =>
        // A pool that has never been imported reports `topology: null`, and an
        // older middleware may not carry every category.
        ((pool.topology?.[category] ?? []) as TopologyNode[]).map((vdev) => ({
          category,
          ...mapNode(vdev),
        })),
      ),
    }));
  },
};

/**
 * The scan record a pool row carries, restated with every field optional.
 *
 * ZFS records one scan per pool — the last one that ran, of either kind — and
 * the middleware reports it as `scan` on the pool row. The generated types
 * declare its fields required, which is what the current middleware sends; an
 * older one that omits a key would then hand the mapping an `undefined` typed
 * as present, which is precisely the case the normalization below exists for.
 * Only the fields read here are named.
 */
interface ScanRecord {
  function?: string;
  state?: string;
  start_time?: string | null;
  end_time?: string | null;
  errors?: number | null;
  pause?: string | null;
}

/**
 * The state of a pool's last scrub: ZFS's own state for it, or one of the two
 * states ZFS does not have, or null.
 *
 * Those two are what the tool is for. A pool the system can read and holds no
 * scan for has never been scanned, and "never verified" is an answer rather
 * than a gap to leave blank. `UNKNOWN` is every way the last scrub cannot be
 * read at all: a pool whose last scan was a RESILVER, which overwrote the
 * record of whatever scrub preceded it, and a pool the system reports no
 * layout for — one it is not currently reading, whose scan record is absent
 * because there is nothing to read it from rather than because none was ever
 * made. Neither may report as a pool that has never been scrubbed, and neither
 * may report as a clean one.
 *
 * Null is the third case and is not one of those: a scrub IS on record and the
 * system reported no state for it, so its times and error count still stand.
 * `orNull` is what says that, here as everywhere else in this file.
 *
 * `scrub` is the scan once it is known to be one — the single place that
 * decision is made is the handler, so that a row's state and its fields cannot
 * disagree about whether they are describing a scrub.
 */
function scrubState(
  readable: boolean,
  scan: ScanRecord | null,
  scrub: ScanRecord | null,
): string | null {
  if (!readable) return 'UNKNOWN';
  if (!scan) return 'NEVER_SCRUBBED';
  if (!scrub) return 'UNKNOWN';
  // A paused scrub reports SCANNING with the time it was paused, and stays
  // that way indefinitely. Read as SCANNING it would look like progress.
  if (scrub.state === 'SCANNING' && scrub.pause) return 'PAUSED';
  return orNull(scrub.state);
}

/**
 * How long the scrub took, in seconds, or null if that cannot be said: a scrub
 * still running has no end time, and a timestamp in a format `Date.parse` does
 * not accept yields no duration rather than a `NaN` the caller has to detect.
 */
function scrubDuration(scan: ScanRecord | null): number | null {
  if (!scan?.start_time || !scan.end_time) return null;
  const started = Date.parse(scan.start_time);
  const finished = Date.parse(scan.end_time);
  if (Number.isNaN(started) || Number.isNaN(finished)) return null;
  return Math.round((finished - started) / 1000);
}

export const scrubHistory: ReadOnlyTool = {
  name: 'storage_scrub_history',
  description:
    'The outcome and age of the most recent scrub on each ZFS pool, one entry ' +
    'per pool. A scrub is what reads every block back and checks it against ' +
    'its checksum, so a pool whose last scrub is old or absent is one whose ' +
    'data has not been verified recently, however healthy it reports ' +
    'elsewhere. `state` is one of: `FINISHED`, a scrub that ran to ' +
    'completion; `SCANNING`, one running now; `PAUSED`, one started and ' +
    'paused before it finished, which stays paused until it is resumed; ' +
    '`CANCELED`, one stopped before it completed; `NEVER_SCRUBBED`, a pool ' +
    'the system holds no scan of any kind for; `UNKNOWN`, a pool whose last ' +
    'scrub cannot be read; and null, a scrub the system reported no state ' +
    'for. `UNKNOWN` covers a pool whose most recent scan was a resilver, ' +
    'which replaces the record of the scrub before it, and a pool the system ' +
    'reports no layout for — one it is not currently reading, so that no ' +
    'scan record is available to read. Neither is evidence that the pool has ' +
    'never been scrubbed, and neither is evidence that it is clean. ' +
    '`started_at` and `finished_at` are timestamps as the system reports ' +
    'them; `finished_at` is null for a scrub that has not ended. ' +
    '`duration_seconds` is the difference between the two, and is null ' +
    'whenever either is missing or is not a timestamp this tool can read. ' +
    '`errors` is the number of errors that scrub found, and is a running ' +
    'count while one is still going. All four are null whenever `state` is ' +
    '`NEVER_SCRUBBED` or `UNKNOWN`, because the record then describes a ' +
    'resilver, or nothing at all, rather than a scrub; a null `state` still ' +
    'carries them, because a scrub is on record either way. ' +
    '`pool` matches `name` in `storage_pool_status`.',
  inputSchema: { type: 'object', properties: {} },
  requiredRole: Role.ReadOnly,
  mutating: false,
  async handler({ system }) {
    // `scan` is part of a pool row as it stands. `pool.scrub.query` is a
    // neighbouring verb and not this one: it lists the periodic scrub tasks a
    // pool is scheduled under, and carries no outcome, no time and no errors.
    const pools = await firstValueFrom(system.client.api.query('pool.query'));
    return pools.map((pool) => {
      // `topology` is what says the system is reading this pool at all: it is
      // null on one that is not imported, whose absent scan record is then an
      // absence of evidence rather than evidence of no scrub. Whatever such a
      // pool does carry is dropped here rather than below, so that the state
      // and the four fields under it cannot tell different stories.
      const readable = Boolean(pool.topology);
      const scan: ScanRecord | null = (readable ? pool.scan : null) ?? null;
      // The scan is only this tool's subject when it is a scrub. A resilver's
      // times and error count are read through `null` rather than reported,
      // so that no field of a resilver is ever presented as one of a scrub.
      const scrub = scan?.function === 'SCRUB' ? scan : null;
      return {
        pool: pool.name,
        state: scrubState(readable, scan, scrub),
        started_at: orNull(scrub?.start_time),
        finished_at: orNull(scrub?.end_time),
        duration_seconds: scrubDuration(scrub),
        errors: scrub?.errors ?? null,
      };
    });
  },
};

/**
 * The days a `weekday` list can name, as numbers.
 *
 * The surface declares `weekday?: number[]` and states no numbering for it. Two
 * numberings are in ordinary use for such a field and THEY AGREE ON EVERY VALUE
 * BOTH DEFINE: cron's — which this catalog already reads a `dow` field under,
 * in `tasks.ts` — runs 0 and 7 for Sunday with 1 Monday through 6 Saturday, and
 * ISO-8601's runs 1 Monday through 7 Sunday with no 0. So a number in this
 * range names one day whichever of the two the middleware means, and a number
 * outside it names none under either.
 *
 * That agreement is the whole of what is established here, and it is why this
 * file states the numbering without reaching into the tasks family for its
 * rendering: the cron vocabulary — `dayName`, `describeSchedule` and the
 * helpers under them — is that family's own (#95), and matching a convention is
 * not the same act as re-siting the code that implements it.
 */
const WEEKDAY_RANGE = { min: 0, max: 7 } as const;

/**
 * The days a resilver window applies on, all of them or none.
 *
 * All-or-nothing for #93's reason rather than for symmetry with any sibling:
 * this list is read for which days the window is in force, so a list one entry
 * shorter says the window does not apply on that day — a CLAIM, and one made
 * silently. Nulling the whole list refuses it. An entry outside
 * {@link WEEKDAY_RANGE} is not a day this file can name under either numbering,
 * so it is a list this tool has misread rather than a day to report, which is
 * the same reading `numberList` gives an out-of-range cron field in `tasks.ts`.
 *
 * An EMPTY list is not that answer and is returned as itself: the system
 * reported a list and it names no day.
 */
function weekdayList(value: unknown): number[] | null {
  if (!Array.isArray(value)) return null;
  const days: number[] = [];
  for (const entry of value) {
    const day = numberOrNull(entry);
    if (
      day === null ||
      !Number.isInteger(day) ||
      day < WEEKDAY_RANGE.min ||
      day > WEEKDAY_RANGE.max
    ) {
      return null;
    }
    days.push(day);
  }
  return days;
}

/**
 * When ZFS resilvering is given priority over other I/O, which is one
 * system-wide setting rather than a per-pool one.
 *
 * `pool.resilver.config` takes no parameters and answers with one entity, so
 * there is nothing here to key on a pool — unlike every other tool in this
 * file, which maps `pool.query` one row at a time. The middleware row `id` is
 * dropped: there is one such configuration, and an id names nothing outside the
 * middleware, the same omission `ups_config` and `system_ntp_status` make.
 *
 * WHAT `enabled: false` MEANS IS THE WHOLE RISK IN THIS TOOL. It says the
 * priority window is not in force; it does not say resilvering is off, and a
 * system reporting it still rebuilds redundancy after a disk is replaced, at
 * its ordinary priority. A name promising more than the data holds is this
 * repository's most common review finding — `storage_scrub_history` promising
 * history one scan record cannot hold is the same shape — and here the field
 * name is the middleware's, so the description carries the correction rather
 * than the name.
 *
 * EVERY FIELD IS OPTIONAL ON THE DECLARED ENTRY, and that is what the
 * normalization is for: `enabled` absent is not `enabled: false`, and a window
 * with no `begin` is not one starting at midnight. Each is read through a guard
 * and answers null where the system reported no value this file could read,
 * which keeps "unreported" distinct from "configured off" per field — for
 * `weekday` that distinction is null against `[]`, and for `enabled` it is null
 * against `false`.
 *
 * WHAT THIS TOOL DELIBERATELY DOES NOT DO:
 *
 * - **It does not say whether a resilver is running, ever ran, or how far
 *   along one is.** That is the measured half of the question and this read is
 *   the configured half (#133). A device being replaced is visible in
 *   `storage_pool_topology`, which nests the outgoing and incoming disks
 *   beneath the member being replaced.
 * - **It does not parse, compare or convert `begin` and `end`.** They are
 *   passed through as the system spelled them. A window whose `end` is earlier
 *   than its `begin` spans midnight and is a real window; anything here that
 *   subtracted one from the other would have to decide that, and deciding it
 *   would assert a time format the surface does not state (#96).
 * - **It does not resolve `enabled: true` beside an empty `weekday`.** Nothing
 *   on this surface says what the middleware does with a window that names no
 *   day, so the combination is reported as the combination it is rather than
 *   smoothed into either reading (#120).
 * - **It does not change the window.** `pool.resilver.update` is mutating and
 *   is not in this catalog.
 */
export const poolResilverConfig: ReadOnlyTool = {
  name: 'pool_resilver_config',
  description:
    'When ZFS resilvering on this system is given priority over other I/O. A ' +
    'resilver is what rebuilds redundancy after a disk is replaced or comes ' +
    'back, and until it finishes the pool is running without the redundancy ' +
    'it is configured for — so how quickly it finishes is the thing this ' +
    'setting is about. Inside the configured window resilvering is prioritised ' +
    'over other I/O and finishes sooner, at the cost of contending with ' +
    'production work; outside it, the other work is prioritised instead. THIS ' +
    'IS ONE SYSTEM-WIDE SETTING AND NOT A PER-POOL ONE: it governs every ' +
    'resilver on the system, and no field below is about any particular pool. ' +
    '`enabled` is whether that priority window is in force. It is ' +
    'THREE-VALUED — true, false, or null where the system reported no value ' +
    'this tool could read — and A NULL IS NOT A FALSE. `enabled: false` MEANS ' +
    'THE PRIORITY WINDOW IS NOT IN FORCE. IT DOES NOT MEAN RESILVERING IS ' +
    'DISABLED, and it is NOT evidence that a replaced disk will not be rebuilt: ' +
    'a system with the window off still resilvers, at its ordinary priority. ' +
    'Reporting `enabled: false` as "resilvering is off" is the misreading this ' +
    'sentence exists to prevent. ' +
    '`begin` and `end` are the start and end of the window as the system ' +
    'recorded them, passed through exactly as spelled and NOT parsed, ' +
    'converted or compared here. THEY CARRY NO TIMEZONE AND MUST NOT BE READ ' +
    'AS UTC: the strings name a clock time and nothing in them says which zone ' +
    'that clock is in, so the instant either one names is not established by ' +
    'this read. (unconfirmed) They are the system\'s own local time, as every ' +
    'other schedule the catalog reports is, and `system_general_config` is ' +
    'where that `timezone` is reported — the API states the zone for none of ' +
    'them, so confirm it there before converting either value or comparing it ' +
    'against a time from anywhere else. AN `end` EARLIER THAN `begin` IS A ' +
    'WINDOW THAT SPANS MIDNIGHT and is never an empty or a negative one — ' +
    '`begin` 22:00 with `end` 06:00 is eight hours across the night. Each is ' +
    'null where the system reported no value this tool could read; a null is ' +
    'not midnight and is not "no restriction", and a null in one end says ' +
    'nothing about when the other end applies from or to. ' +
    '`weekday` is the days of the week the window applies on, as NUMBERS the ' +
    'system sent and not converted to names here. THE API STATES NO NUMBERING ' +
    'FOR THIS FIELD. What is established is that the two numberings in ' +
    'ordinary use for a day-of-the-week field agree on every value both ' +
    'define: cron numbers Sunday as 0 and again as 7 with 1 Monday through 6 ' +
    'Saturday, ISO-8601 numbers 1 Monday through 7 Sunday and has no 0, so 1 ' +
    'to 7 name the same days under both. That is the same numbering this ' +
    'catalog reads a cron day-of-the-week field under, which ' +
    '`automated_tasks_list` reports as `dow`. Read a number in 0 to 7 as that ' +
    'day and do not go further than the agreement above. ' +
    '`weekday` is null where the system reported no list this tool could read ' +
    '— no such field, a value that is not a list, or a list holding an entry ' +
    'that is not a whole number from 0 to 7 — AND NOTHING HERE SEPARATES THOSE ' +
    'CAUSES. A partial list is never returned, because a list one day shorter ' +
    'would say the window does not apply on that day, which is a claim this ' +
    'read did not establish. AN EMPTY `weekday` IS A DIFFERENT ANSWER and is ' +
    'reported as itself: the system sent a list and it names no day. ' +
    '`enabled: true` BESIDE AN EMPTY `weekday` IS REPORTED AS THAT ' +
    'COMBINATION AND IS NOT RESOLVED. Nothing on this surface says what the ' +
    'system does with a window that names no day, so do not report such a ' +
    'system as one where resilvering is prioritised, and do not report it as ' +
    'one where the window is off. ' +
    'THIS IS THE CONFIGURATION AND NOTHING ELSE. It does NOT establish that a ' +
    'resilver is running, that one ever ran, how far along one is, or how long ' +
    'one took, and no field above is evidence about any of that. A device ' +
    'being replaced right now is visible in `storage_pool_topology`, which ' +
    'lists the outgoing and incoming disks beneath the member being replaced. ' +
    '`storage_scrub_history` covers the sibling operation and reports scrubs ' +
    'rather than resilvers — a pool whose most recent scan was a resilver ' +
    'reports `UNKNOWN` there, which is that tool refusing to read a resilver ' +
    'as a scrub and is not a report on the resilver. ' +
    'THIS TOOL ONLY READS. It does not change the window, does not start, ' +
    'pause or stop a resilver, and does not replace a disk — ' +
    '`pool.resilver.update` is the mutating counterpart and is not in this ' +
    'catalog. The middleware row id is not reported: there is one such ' +
    'configuration, and an id names nothing outside the middleware. NO field ' +
    'beyond `enabled`, `begin`, `end` and `weekday` is returned, whatever a ' +
    'later TrueNAS release adds to this payload. A configuration that could ' +
    'not be read at all is an error naming what the system said, not a result ' +
    'of nulls.',
  inputSchema: { type: 'object', properties: {} },
  requiredRole: Role.ReadOnly,
  mutating: false,
  async handler({ system }) {
    const config = await firstValueFrom(system.client.api.call('pool.resilver.config'));
    // Guarded rather than reached into, for the reason `ups_config` gives: a
    // system answering with something that is not a configuration would
    // otherwise throw naming a property, and the caller would see the name of a
    // field rather than the read that failed. Fatal rather than mapped to
    // nulls, because a result of nulls is indistinguishable from a system that
    // has configured no window and only one of the two was read.
    const settings = recordOrNull(config);
    if (settings === null) {
      throw new Error('pool.resilver.config did not answer with a resilver configuration');
    }
    // Named one at a time rather than trimmed, and read through a guard even
    // where the client declares the field, which is #91: a declared type is a
    // claim about what the middleware sends and not the value received. Every
    // one of these is optional on the declared entry besides.
    return {
      enabled: booleanOrNull(settings['enabled']),
      begin: textOrNull(settings['begin']),
      end: textOrNull(settings['end']),
      weekday: weekdayList(settings['weekday']),
    };
  },
};

/**
 * The periodic scrub tasks: `pool_scrub_tasks_list`, `pool_scrub_task_create`
 * and `pool_scrub_task_update` (#181).
 *
 * `storage_scrub_history` says when a pool last scrubbed; these say when it
 * will scrub next, and change that. The listing ships with the two mutations
 * because a mutating tool keyed on an id nothing lists is unreachable (#119) —
 * `pool.scrub.query` is the neighbouring verb `storage_scrub_history`
 * deliberately does not read, and nothing else in the catalog reports a scrub
 * task's id.
 *
 * THE SCHEDULE IS STATED AS ITS FIVE CRON FIELDS AND IS NOT PUT INTO WORDS. The
 * cron rendering — `describeSchedule` and the helpers under it — is the tasks
 * family's own vocabulary (#95), and importing it here is re-siting another
 * family's code rather than matching its convention (#141). What is matched
 * instead is the reading: these are the same five fields, spelled the way cron
 * spells them and the way `automated_tasks_list` reports them, and every plan
 * here quotes them exactly as they will be sent. A plan that said "every
 * Sunday at 00:00" through a second rendering would be a second opinion about
 * what a cron expression means, which is the drift worth avoiding most.
 *
 * `threshold` HAS NO DECLARED UNIT (#96). It keeps the middleware's name, is
 * passed through as the number sent, and no description here puts a unit on
 * it.
 *
 * `pool` IS THE POOL'S NUMERIC ID on this API, and every other tool names a
 * pool by its name. So the listing reports both, the id as `pool_id` — a field
 * named `pool` holding a number would read as a name in a catalog where `pool`
 * always is one — and creation takes the name and resolves it.
 */

/** The five cron fields a scrub task's schedule carries, in crontab order. */
const SCRUB_CRON_FIELDS = ['minute', 'hour', 'dom', 'month', 'dow'] as const;

type ScrubCronField = (typeof SCRUB_CRON_FIELDS)[number];

/** A schedule as these tools send one: all five fields, never fewer. */
type ScrubSchedule = Record<ScrubCronField, string>;

/** A schedule as read off a row: each field a string, or null where none was readable. */
type ScrubScheduleReading = Record<ScrubCronField, string | null>;

/** One scrub task, through the allowlist. */
interface ScrubTaskRow {
  id: number | null;
  pool_id: number | null;
  pool_name: string | null;
  enabled: boolean | null;
  threshold: number | null;
  description: string | null;
  schedule: ScrubScheduleReading | null;
}

/**
 * The five cron fields of a stored schedule, named one by one so a field a
 * later release adds to `PoolScrubCron` does not reach a caller. Null where
 * the row's `schedule` is not a record at all, which is a different answer
 * from a record with a field missing.
 */
function scrubScheduleOf(value: unknown): ScrubScheduleReading | null {
  const held = recordOrNull(value);
  if (held === null) return null;
  return {
    minute: textOrNull(held['minute']),
    hour: textOrNull(held['hour']),
    dom: textOrNull(held['dom']),
    month: textOrNull(held['month']),
    dow: textOrNull(held['dow']),
  };
}

/**
 * One `pool.scrub.query` row, or a create/update response, through the
 * allowlist. A row that is not a record becomes a row of nulls rather than
 * being dropped: under #93 a list one task shorter says a pool scrubs less
 * often than it does, which is a claim this read did not establish.
 */
function scrubTaskRow(value: unknown): ScrubTaskRow {
  const row = recordOrNull(value) ?? {};
  return {
    id: numberOrNull(row['id']),
    pool_id: numberOrNull(row['pool']),
    pool_name: textOrNull(row['pool_name']),
    enabled: booleanOrNull(row['enabled']),
    threshold: numberOrNull(row['threshold']),
    description: textOrNull(row['description']),
    schedule: scrubScheduleOf(row['schedule']),
  };
}

/** What a field the system reported no readable value for is stated as, in a plan. */
const NOT_READ = '(not readable)';

/** A schedule as the plan states it: the five fields, quoted exactly. */
function scheduleText(schedule: ScrubSchedule | ScrubScheduleReading | null): string {
  if (schedule === null) return `schedule ${NOT_READ}`;
  return `schedule ${SCRUB_CRON_FIELDS.map(
    (name) => `${name} ${schedule[name] === null ? NOT_READ : `"${schedule[name]}"`}`,
  ).join(', ')}`;
}

/** `enabled`, `disabled`, or the stated absence of a reading. */
function enabledText(enabled: boolean | null): string {
  return enabled === null ? `enabled ${NOT_READ}` : enabled ? 'enabled' : 'disabled';
}

/** A threshold as the plan states it: the number, with no unit, because none is reported. */
function thresholdText(threshold: number | null): string {
  return `threshold ${threshold === null ? NOT_READ : threshold}`;
}

/** One existing task, in the plan's words. */
function describeScrubTask(task: ScrubTaskRow): string {
  return (
    `id ${task.id ?? NOT_READ} (${enabledText(task.enabled)}, ${scheduleText(task.schedule)}, ` +
    `${thresholdText(task.threshold)}, description ` +
    `${task.description === null ? '(none reported)' : `"${task.description}"`})`
  );
}

/** Where the ids `pool_scrub_task_update` takes come from, worded once. */
const SCRUB_TASK_IDS_FROM = '`pool_scrub_tasks_list`';

/**
 * The account of a scrub task row, shared by all three tools' results because
 * all three report rows through {@link scrubTaskRow}.
 */
const SCRUB_TASK_FIELDS =
  'A scrub task row carries `id`, the task\'s own id, which is what ' +
  '`pool_scrub_task_update` takes; `pool_id`, the numeric id the system holds the ' +
  'pool under, which is what the middleware stores and names nothing outside it; ' +
  '`pool_name`, which matches `name` in `storage_pool_status`; `enabled`; ' +
  '`threshold`, as the number the system reported — NO UNIT IS REPORTED FOR IT AND ' +
  'IT IS NOT TO BE CONVERTED; `description`; and `schedule`, the five cron fields ' +
  '`minute`, `hour`, `dom`, `month` and `dow` exactly as stored, read the way cron ' +
  'reads them and the way `automated_tasks_list` reports them (0 and 7 are both ' +
  'Sunday in `dow`), and not rendered in words here. Each is null where the system ' +
  'reported no value this tool could read — a null `enabled` IS NOT `false`, and a ' +
  'null `description` is either none set or one that could not be read, which are ' +
  'not separated. `schedule` is null where the row carried no schedule record at ' +
  'all, and a field inside it is null where the record lacked that field.';

const SCRUB_LIST_GUIDANCE =
  `One row per scrub task on the system. ${SCRUB_TASK_FIELDS} A row the system ` +
  'sent that was not a record is kept as a row of nulls rather than dropped, ' +
  'because dropping it would say a pool has one task fewer than it does. AN EMPTY ' +
  'LIST IS THE SYSTEM REPORTING NO SCRUB TASKS AT ALL — every data pool on it is ' +
  'then not scrubbed on a schedule by a task — and is never what a failed read ' +
  'returns: a read that failed, or that answered with anything other than a list, ' +
  'is an error. A POOL WITH NO ROW HERE IS NOT SCRUBBED ON A SCHEDULE BY ANY TASK, ' +
  'and a pool whose every row is `enabled: false` is not either; that is the ' +
  'finding, not a gap — UNLESS A ROW WITH A NULL `pool_name` IS PRESENT, which is ' +
  'a task whose pool could not be named and may be that pool\'s (its `pool_id`, ' +
  'where readable, names nothing another tool reports), so the finding is then ' +
  'not established for any pool. Every row is reported ' +
  'whichever pool it names; whether the system allows more than one task on a ' +
  'pool is (unconfirmed). (unconfirmed) TrueNAS ' +
  'uses `threshold` to skip a scheduled scrub when the pool was scrubbed recently ' +
  'enough, so a schedule firing does not by itself mean a scrub ran — ' +
  '`storage_scrub_history` reports when the last one actually did.';

export const poolScrubTasksList: ReadOnlyTool = {
  name: 'pool_scrub_tasks_list',
  description:
    'The periodic scrub tasks on this system: which pool each one scrubs, on ' +
    'what schedule, with what threshold, and whether it is enabled. This is ' +
    'when the next scrub is ARRANGED to run; `storage_scrub_history` is when ' +
    'the last one DID, and the two answer different questions. The `id` ' +
    'reported here is what `pool_scrub_task_update` takes, and ' +
    '`pool_scrub_task_create` adds a task. This reads `pool.scrub.query`, which ' +
    'covers the data pools; the boot pool\'s scrub interval is a different ' +
    'setting this catalog does not read. THIS TOOL ONLY READS: it does not start ' +
    'a scrub now and does not delete a task, and nothing in this catalog does ' +
    'either. ' +
    SCRUB_LIST_GUIDANCE,
  resultGuidance: SCRUB_LIST_GUIDANCE,
  inputSchema: { type: 'object', properties: {} },
  requiredRole: Role.ReadOnly,
  mutating: false,
  async handler({ system }) {
    const rows: unknown = await firstValueFrom(system.client.api.query('pool.scrub.query'));
    // Fatal rather than `[]`: an empty list is this tool's one positive finding
    // — no pool is scrubbed on a schedule — and a read that answered with
    // anything else has established nothing of the kind (#133).
    if (!Array.isArray(rows)) {
      throw new Error('pool.scrub.query did not answer with a list of scrub tasks');
    }
    return rows.map(scrubTaskRow);
  },
};

/**
 * The `schedule` argument as it will be sent, or the error naming what is
 * wrong with it.
 *
 * ALL FIVE FIELDS ARE REQUIRED, for #180's reason: whether the middleware
 * fills a partial schedule with defaults or merges it with the stored one is
 * not established, and either way a caller who said "2am" and sent only
 * `hour` gets a schedule nobody showed them. An unknown key is refused rather
 * than dropped, which is what the schema's `additionalProperties: false`
 * advertises.
 */
function parseScrubSchedule(raw: unknown): ScrubSchedule {
  const given = recordOrNull(raw);
  if (given === null) {
    throw new Error('"schedule" must be an object');
  }
  const unknownKeys = Object.keys(given).filter(
    (key) => !(SCRUB_CRON_FIELDS as readonly string[]).includes(key),
  );
  if (unknownKeys.length > 0) {
    throw new Error(
      `"schedule" takes only ${SCRUB_CRON_FIELDS.join(', ')} — not ${unknownKeys.join(', ')}`,
    );
  }
  const schedule: Partial<ScrubSchedule> = {};
  for (const name of SCRUB_CRON_FIELDS) {
    const value = given[name];
    if (typeof value !== 'string' || value.length === 0) {
      throw new Error(
        `"schedule.${name}" is required and must be a non-empty string — all five cron ` +
          'fields are sent together, because what the system does with a missing one is ' +
          'not established',
      );
    }
    schedule[name] = value;
  }
  return schedule as ScrubSchedule;
}

/** A threshold as sent: any finite number, passed through, since no unit or range is declared. */
function parseThreshold(raw: unknown): number {
  if (numberOrNull(raw) === null) {
    throw new Error('"threshold" must be a number');
  }
  return raw as number;
}

/** Strict, as `scheduled_task_set_enabled` is: coercing `"false"` would enable a task asked to be off. */
function parseEnabled(raw: unknown): boolean {
  if (typeof raw !== 'boolean') {
    throw new Error('"enabled" must be a boolean');
  }
  return raw;
}

/** A non-empty description; an empty one would be stored as a description of nothing. */
function parseDescription(raw: unknown): string {
  if (textOrNull(raw) === null) {
    throw new Error('"description" must be a non-empty string');
  }
  return raw as string;
}

/** The fields a create or an update sends, besides the pool. */
interface ScrubTaskFields {
  schedule?: ScrubSchedule;
  threshold?: number;
  enabled?: boolean;
  description?: string;
}

/**
 * The optional fields of either mutation, parsed, with an absent one left out
 * entirely — so the object is both what is sent and what the confirmation key
 * is computed over, and an omitted field cannot reach either as `undefined`.
 */
function parseScrubFields(args: Record<string, unknown>): ScrubTaskFields {
  const fields: ScrubTaskFields = {};
  if (args['schedule'] !== undefined) fields.schedule = parseScrubSchedule(args['schedule']);
  if (args['threshold'] !== undefined) fields.threshold = parseThreshold(args['threshold']);
  if (args['enabled'] !== undefined) fields.enabled = parseEnabled(args['enabled']);
  if (args['description'] !== undefined) fields.description = parseDescription(args['description']);
  return fields;
}

/**
 * The flat set of values a row or a request is compared on: the five cron
 * fields, threshold, enabled and description. Only the keys a request SENT are
 * ever compared, so a field nobody asked about cannot make a call read as
 * unconfirmed.
 */
type ScrubComparable = Record<string, string | number | boolean | null>;

function comparableOfRow(row: ScrubTaskRow): ScrubComparable {
  return {
    ...(row.schedule ?? { minute: null, hour: null, dom: null, month: null, dow: null }),
    threshold: row.threshold,
    enabled: row.enabled,
    description: row.description,
  };
}

function comparableOfFields(fields: ScrubTaskFields): ScrubComparable {
  return {
    ...(fields.schedule ?? {}),
    ...(fields.threshold === undefined ? {} : { threshold: fields.threshold }),
    ...(fields.enabled === undefined ? {} : { enabled: fields.enabled }),
    ...(fields.description === undefined ? {} : { description: fields.description }),
  };
}

/** The fields sent, in the plan's words, in the order the schema lists them. */
function fieldsText(fields: ScrubTaskFields): string[] {
  return [
    ...(fields.schedule === undefined ? [] : [scheduleText(fields.schedule)]),
    ...(fields.threshold === undefined ? [] : [thresholdText(fields.threshold)]),
    ...(fields.enabled === undefined ? [] : [enabledText(fields.enabled)]),
    ...(fields.description === undefined ? [] : [`description "${fields.description}"`]),
  ];
}

/** The input schema's `schedule`, written once for both mutations. */
const SCHEDULE_SCHEMA = {
  type: 'object',
  description:
    'When the scrub task runs, as the five cron fields. All five are required ' +
    'and are sent together; no other key is accepted.',
  properties: {
    minute: { type: 'string', description: 'Cron minute field, e.g. "0".' },
    hour: { type: 'string', description: 'Cron hour field, e.g. "0" or "*".' },
    dom: { type: 'string', description: 'Cron day-of-month field, e.g. "*" or "1".' },
    month: { type: 'string', description: 'Cron month field, e.g. "*".' },
    dow: {
      type: 'string',
      description: 'Cron day-of-week field, e.g. "*" or "0"; 0 and 7 are both Sunday.',
    },
  },
  required: [...SCRUB_CRON_FIELDS],
  additionalProperties: false,
};

const THRESHOLD_SCHEMA = {
  type: 'number',
  description:
    'Passed to the system as given. NO UNIT IS REPORTED FOR THIS FIELD and none ' +
    'is applied here, so do not convert a value into it.',
};

/** What a read step's params are when `execute` dispatches `api.query(method, filters)`: `[filters, {}]`. */
function queryParams(filters: unknown): unknown {
  return [filters, {}];
}

/** A pool `pool.query` listed under the name asked for, with the id the middleware holds it under. */
interface ResolvedPool {
  name: string;
  id: number;
}

/**
 * The row `pool.query` listed under `name`, or null where it listed none.
 *
 * The match is made on the RESPONSE, by name, and never on the row count: an
 * unrecognised filter is dropped rather than refused, and the first row of a
 * filter that did not apply is a different pool (#121, #153).
 */
function poolRowNamed(rows: unknown, name: string): Record<string, unknown> | null {
  const match = (Array.isArray(rows) ? rows : [])
    .map((row) => recordOrNull(row))
    .find((row) => row !== null && textOrNull(row['name']) === name);
  return match ?? null;
}

/** The data pool named `name` as `pool.query` lists it, or the error naming it. */
async function readPoolNamed(ctx: ToolContext, name: string): Promise<Record<string, unknown>> {
  const rows: unknown = await firstValueFrom(
    ctx.system.client.api.query('pool.query', [['name', '=', name]]),
  );
  const match = poolRowNamed(rows, name);
  if (match === null) {
    throw new Error(
      `No pool named "${name}" on this system — \`storage_pool_status\` lists the data ` +
        'pools by name, and the boot pool is not one of them',
    );
  }
  return match;
}

/**
 * The data pool named `name`, or the error naming it. A pool listed under that
 * name with no id this tool can read is refused too — creating a task needs
 * the id, and guessing one is not an option.
 */
async function resolvePool(ctx: ToolContext, name: string): Promise<ResolvedPool> {
  const match = await readPoolNamed(ctx, name);
  const id = numberOrNull(match['id']);
  if (id === null) {
    throw new Error(`Pool "${name}" is listed with no id this tool could read, so no task can name it`);
  }
  return { name, id };
}

/** The sentence {@link existingTasksSentence} ends on wherever a task may already exist, worded once. */
const SECOND_TASK_UNCONFIRMED =
  'Whether the system accepts a second scrub task on one pool is (unconfirmed); if it ' +
  'refuses, nothing is created and `pool_scrub_task_update` changes the task that is there.';

/**
 * What the create plan says about the scrub tasks the pool already has.
 *
 * Plan-time only and not a step, because `execute` does not make this read
 * (#119), and its failure does not fail the plan (#154): not knowing whether
 * there is a first task is something to state rather than a reason to refuse.
 *
 * WHETHER THE SYSTEM ACCEPTS A SECOND TASK ON ONE POOL IS NOT ESTABLISHED. The
 * ticket calls it legal; nothing on the client surface says either way, and the
 * middleware may refuse it. So the plan names what is there and states the
 * question as `(unconfirmed)` rather than calling the duplicate allowed — and
 * does not refuse on the strength of a rule it cannot read either (#120).
 *
 * Every task whose `pool` reads as this pool's id is named. A row whose pool
 * could not be read at all is COUNTED and said to be unattributed rather than
 * left out, by #93's direction — leaving it out moves the sentence towards
 * "this pool has no task", which is the claim that makes a duplicate look safe.
 */
async function existingTasksSentence(ctx: ToolContext, pool: ResolvedPool): Promise<string> {
  let rows: unknown;
  try {
    rows = await firstValueFrom(ctx.system.client.api.query('pool.scrub.query', [['pool', '=', pool.id]]));
  } catch (reason) {
    return (
      `Whether pool "${pool.name}" already has a scrub task could not be read ` +
      `(pool.scrub.query failed: ${errorText(reason)}). ${SECOND_TASK_UNCONFIRMED}`
    );
  }
  if (!Array.isArray(rows)) {
    return (
      `Whether pool "${pool.name}" already has a scrub task could not be read ` +
      `(pool.scrub.query did not answer with a list). ${SECOND_TASK_UNCONFIRMED}`
    );
  }
  const tasks = rows.map(scrubTaskRow);
  const own = tasks.filter((task) => task.pool_id === pool.id);
  const unattributed = tasks.filter((task) => task.pool_id === null).length;
  const extra =
    unattributed > 0
      ? ` ${plural(unattributed, 'further task')} named no pool this tool could read, and may be on this one.`
      : '';
  if (own.length === 0) {
    return `Pool "${pool.name}" has no scrub task now.${extra}`;
  }
  return (
    `Pool "${pool.name}" already has ${plural(own.length, 'scrub task')}: ` +
    `${own.map(describeScrubTask).join('; ')}. This asks for another beside ` +
    `${own.length === 1 ? 'it' : 'them'}, and whether that is what was meant is the ` +
    `approver's call. ${SECOND_TASK_UNCONFIRMED}${extra}`
  );
}

/** What `pool_scrub_task_create` was asked to do. */
interface ScrubCreate {
  pool: string;
  fields: Required<Pick<ScrubTaskFields, 'schedule' | 'threshold' | 'enabled'>> &
    Pick<ScrubTaskFields, 'description'>;
}

function parseScrubCreate(args: Record<string, unknown>): ScrubCreate {
  const pool = textOrNull(args['pool']);
  if (pool === null) {
    throw new Error('"pool" is required and must be a pool name');
  }
  for (const required of ['schedule', 'threshold', 'enabled']) {
    if (args[required] === undefined) throw new Error(`"${required}" is required`);
  }
  const fields = parseScrubFields(args) as ScrubCreate['fields'];
  return { pool, fields };
}

const SCRUB_CREATE_GUIDANCE =
  '`pool` is the name asked for and `pool_id` the id it resolved to when the ' +
  'call was made. `requested` is exactly what was sent besides the pool. `task` ' +
  'is the created task read back off the response the create itself answered ' +
  `with — never copied from the request — or null where that response was not a ` +
  `record. ${SCRUB_TASK_FIELDS} Its \`id\` is what \`pool_scrub_task_update\` ` +
  'takes. `confirmed` is whether `task` holds the pool and every value sent: ' +
  'true is the system reporting back what was asked for; FALSE IS NOT A SUCCESS — ' +
  'the call did not reject and at least one value was stored as something else, ' +
  'compared as the strings were spelled, so a cron field the system stored under ' +
  'a different spelling reads as false; and null is a response in which some ' +
  'value sent could not be read back and none read back as different, under ' +
  'which nothing here establishes what the task holds. A null `task` means ' +
  'nothing here establishes that a task was created, and is not evidence that ' +
  'none was — `pool_scrub_tasks_list` shows what the system now holds.';

export const poolScrubTaskCreate: MutatingTool = {
  name: 'pool_scrub_task_create',
  description:
    'Creates one periodic scrub task for a named data pool on this TrueNAS ' +
    'system. Two-phase: called without a confirmation_token it returns a plan ' +
    'for user approval; called with one it creates the task. A scrub reads ' +
    'every block of the pool and checks it, and destroys nothing. `pool` is the ' +
    'pool\'s NAME, as `storage_pool_status` reports it, and is resolved to the ' +
    'id the system stores; a name no data pool has fails the plan, naming it, ' +
    'and the boot pool is not covered. `schedule` takes ALL FIVE cron fields — ' +
    '`minute`, `hour`, `dom`, `month`, `dow`, as cron spells them — and refuses ' +
    'a schedule missing any of them, because what the system would do with a ' +
    'missing one is not established. `threshold` is required and is passed ' +
    'through as given: NO UNIT IS REPORTED FOR IT AND NONE IS APPLIED HERE. ' +
    '(unconfirmed) TrueNAS uses it to skip a scheduled scrub when the pool was ' +
    'scrubbed recently enough. `enabled` is required; `description` is ' +
    'optional. THE PLAN NAMES EVERY SCRUB TASK THE POOL ALREADY HAS, or says it ' +
    'has none, or that this could not be read. WHETHER THE SYSTEM ACCEPTS A ' +
    'SECOND TASK ON ONE POOL IS (unconfirmed): where the pool already has one, ' +
    '`pool_scrub_task_update` changing that task may be what was wanted, and a ' +
    'refused create creates nothing. The pool is ' +
    'looked up by name again when the task is created, and nothing is created ' +
    'if no pool of that name is listed then. `destructiveness` is `reversible`, ' +
    'but NO TOOL IN THIS CATALOG DELETES A SCRUB TASK: undoing this means ' +
    'disabling the task with `pool_scrub_task_update`, or deleting it outside ' +
    'this catalog. ' +
    SCRUB_CREATE_GUIDANCE,
  resultGuidance: SCRUB_CREATE_GUIDANCE,
  inputSchema: {
    type: 'object',
    properties: {
      pool: {
        type: 'string',
        description: 'The data pool\'s name, as `storage_pool_status` reports it.',
      },
      schedule: SCHEDULE_SCHEMA,
      threshold: THRESHOLD_SCHEMA,
      enabled: { type: 'boolean', description: 'Whether the task is created enabled.' },
      description: { type: 'string', description: 'Optional; a non-empty label for the task.' },
    },
    required: ['pool', 'schedule', 'threshold', 'enabled'],
  },
  requiredRole: Role.Full,
  mutating: true,
  destructiveness: 'reversible',
  normalizeArgs(rawArgs) {
    const { pool, fields } = parseScrubCreate(rawArgs);
    return { pool, ...fields };
  },
  async plan(ctx, rawArgs): Promise<PlanStep[]> {
    const { pool: name, fields } = parseScrubCreate(rawArgs);
    const pool = await resolvePool(ctx, name);
    const existing = await existingTasksSentence(ctx, pool);
    return [
      {
        method: 'pool.query',
        params: queryParams([['name', '=', name]]),
        description:
          `Look up pool "${name}" by name, to send the id the system holds it under — ` +
          `${pool.id} when this plan was made. Changes nothing. If no pool of that name ` +
          'is listed when this runs, nothing is created.',
      },
      {
        method: 'pool.scrub.create',
        params: [{ pool: pool.id, ...fields }],
        description:
          `Create a scrub task for pool "${name}" with ${fieldsText(fields).join(', ')}. ` +
          `No unit is reported for the threshold and none is applied. ${existing}`,
      },
    ];
  },
  async execute(ctx, rawArgs) {
    const { pool: name, fields } = parseScrubCreate(rawArgs);
    // Read again rather than taken from the plan: the confirmation token binds
    // the arguments and not the plan, and the argument is a NAME. A pool that
    // is gone fails here, before anything is created; one exported and
    // re-imported under the same name is the pool that was approved, under the
    // id it now has.
    const pool = await resolvePool(ctx, name);
    const created: unknown = await firstValueFrom(
      ctx.system.client.api.call('pool.scrub.create', [{ pool: pool.id, ...fields }]),
    );
    const task = recordOrNull(created) === null ? null : scrubTaskRow(created);
    return {
      pool: name,
      pool_id: pool.id,
      requested: fields,
      task,
      confirmed:
        task === null
          ? null
          : agreement(
              { pool_id: pool.id, ...comparableOfFields(fields) },
              { pool_id: task.pool_id, ...comparableOfRow(task) },
            ),
    };
  },
};

/** What `pool_scrub_task_update` was asked to do. */
interface ScrubUpdate {
  id: number;
  fields: ScrubTaskFields;
}

function parseScrubUpdate(args: Record<string, unknown>): ScrubUpdate {
  const id = args['id'];
  if (typeof id !== 'number' || !Number.isInteger(id)) {
    throw new Error('"id" is required and must be a whole number');
  }
  const fields = parseScrubFields(args);
  if (Object.keys(fields).length === 0) {
    throw new Error('Nothing to change: pass at least one of schedule, threshold, enabled, description');
  }
  return { id, fields };
}

/**
 * The task the system listed under this id, or null where it listed none that
 * did. The id is compared on the RESPONSE and the first row is never taken,
 * because a filter that did not apply comes back as the whole table (#121).
 */
function scrubTaskWithId(rows: unknown, id: number): ScrubTaskRow | null {
  if (!Array.isArray(rows)) return null;
  for (const row of rows) {
    const held = recordOrNull(row);
    if (held !== null && numberOrNull(held['id']) === id) return scrubTaskRow(held);
  }
  return null;
}

function readScrubTask(ctx: ToolContext, id: number): Promise<unknown> {
  return firstValueFrom(ctx.system.client.api.query('pool.scrub.query', [['id', '=', id]]));
}

/** Each field sent, beside what the task holds for it now. */
function changesText(fields: ScrubTaskFields, task: ScrubTaskRow): string[] {
  return [
    ...(fields.schedule === undefined
      ? []
      : [`${scheduleText(fields.schedule)} (now ${scheduleText(task.schedule)})`]),
    ...(fields.threshold === undefined
      ? []
      : [`${thresholdText(fields.threshold)} (now ${thresholdText(task.threshold)})`]),
    ...(fields.enabled === undefined
      ? []
      : [`${enabledText(fields.enabled)} (now ${enabledText(task.enabled)})`]),
    ...(fields.description === undefined
      ? []
      : [
          `description "${fields.description}" (now ${
            task.description === null ? 'none reported' : `"${task.description}"`
          })`,
        ]),
  ];
}

const SCRUB_UPDATE_GUIDANCE =
  '`requested` is exactly what was sent. `previous` is the task as read ' +
  'immediately before the call, and `resulting` is the task read back off the ' +
  'response the update itself answered with — never copied from the request. ' +
  `${SCRUB_TASK_FIELDS} \`previous\` is null where that read failed or listed no ` +
  'such task, and `resulting` is null where the response was not a record. ' +
  '`lookup` says what the read did: `FOUND`, `NOT_FOUND` (deleted between the ' +
  'plan and the confirmation), or `UNREADABLE` with `lookup_error` naming why; ' +
  'THE UPDATE IS ATTEMPTED IN ALL THREE CASES, because what runs must be what was ' +
  'approved. Only the fields that were SENT are compared. `changed` is true where ' +
  '`previous` and `resulting` differ in one of them and false where they agree in ' +
  'all, WHICH IS TWO OUTCOMES AND NOT ONE: the task already held those values, or ' +
  'the call did not apply. `confirmed` is what tells those apart, and `changed` ' +
  'must not be read without it. `confirmed` is whether `resulting` holds every ' +
  'value sent: true is the system reporting back what was asked for; FALSE IS NOT ' +
  'A SUCCESS — the call did not reject and at least one value was stored as ' +
  'something else, compared as the strings were spelled; null is a response in ' +
  'which some value sent could not be read back and none read back as different. ' +
  'Both are null wherever a reading they need is missing — `changed` is null ' +
  'whenever `previous` or `resulting` is, or where no compared field differs and ' +
  'one could not be read on either side.';

export const poolScrubTaskUpdate: MutatingTool = {
  name: 'pool_scrub_task_update',
  description:
    'Changes one periodic scrub task on this TrueNAS system: its schedule, ' +
    'threshold, description or whether it is enabled. Two-phase: called without ' +
    'a confirmation_token it returns a plan for user approval; called with one ' +
    'it sends the change. `id` is the task\'s id as `pool_scrub_tasks_list` ' +
    'reports it; PLANNING AGAINST AN id NO SCRUB TASK HAS FAILS, naming it. ONLY ' +
    'THE FIELDS PASSED ARE SENT, and at least one is required; the pool a task ' +
    'scrubs is not changed by this tool. `schedule`, when passed, takes ALL FIVE ' +
    'cron fields — `minute`, `hour`, `dom`, `month`, `dow` — and refuses a ' +
    'schedule missing any of them, because what the system would do with a ' +
    'missing one is not established. `threshold` is passed through as given: NO ' +
    'UNIT IS REPORTED FOR IT AND NONE IS APPLIED HERE. `description`, when passed, ' +
    'must be non-empty, so this tool cannot clear one. `enabled: false` STOPS THE ' +
    'POOL BEING SCRUBBED ON THAT SCHEDULE AND ANNOUNCES THAT NOWHERE — a pool whose ' +
    'every task is disabled is not scrubbed on a schedule at all. THE PLAN STATES ' +
    'EACH VALUE SENT BESIDE THE ONE THE TASK HOLDS NOW, with the schedule as its ' +
    'five cron fields exactly. SENDING A TASK A VALUE IT ALREADY HOLDS IS NOT AN ' +
    'ERROR. This tool cannot create, delete or run a task; `pool_scrub_task_create` ' +
    'creates one. ' +
    SCRUB_UPDATE_GUIDANCE,
  resultGuidance: SCRUB_UPDATE_GUIDANCE,
  inputSchema: {
    type: 'object',
    properties: {
      id: {
        type: 'integer',
        description: `The scrub task's \`id\`, as ${SCRUB_TASK_IDS_FROM} reports it on the system being targeted.`,
      },
      schedule: SCHEDULE_SCHEMA,
      threshold: THRESHOLD_SCHEMA,
      enabled: { type: 'boolean', description: 'true enables the task, false disables it.' },
      description: { type: 'string', description: 'A non-empty label for the task.' },
    },
    required: ['id'],
  },
  requiredRole: Role.Full,
  mutating: true,
  destructiveness: 'reversible',
  normalizeArgs(rawArgs) {
    const { id, fields } = parseScrubUpdate(rawArgs);
    return { id, ...fields };
  },
  async plan(ctx, rawArgs): Promise<PlanStep[]> {
    const { id, fields } = parseScrubUpdate(rawArgs);
    const task = scrubTaskWithId(await readScrubTask(ctx, id), id);
    if (task === null) {
      throw new Error(`No scrub task with id ${id} on this system — ids come from ${SCRUB_TASK_IDS_FROM}`);
    }
    const already =
      agreement(comparableOfFields(fields), comparableOfRow(task)) === true
        ? ' The task already holds every value this sends, which is not an error.'
        : '';
    return [
      {
        method: 'pool.scrub.query',
        params: queryParams([['id', '=', id]]),
        description:
          `Read this system's scrub task with id ${id}, to report what it held before ` +
          'the change. Changes nothing.',
      },
      {
        method: 'pool.scrub.update',
        params: [id, fields],
        description:
          `Change the scrub task with id ${id} on pool ` +
          `${task.pool_name === null ? NOT_READ : `"${task.pool_name}"`}: ` +
          `${changesText(fields, task).join('; ')}. Only these fields are sent, and no unit ` +
          `is reported for the threshold.${already}`,
      },
    ];
  },
  async execute(ctx, rawArgs) {
    const { id, fields } = parseScrubUpdate(rawArgs);
    let previous: ScrubTaskRow | null = null;
    let lookupError: string | null = null;
    try {
      previous = scrubTaskWithId(await readScrubTask(ctx, id), id);
    } catch (reason) {
      lookupError = errorText(reason);
    }
    // Issued whatever the read said: skipping it for a task the read no longer
    // lists would be `execute` branching on state the confirmation token cannot
    // bind.
    const updated: unknown = await firstValueFrom(
      ctx.system.client.api.call('pool.scrub.update', [id, fields]),
    );
    const resulting = recordOrNull(updated) === null ? null : scrubTaskRow(updated);
    const wanted = comparableOfFields(fields);
    // `changed` compares the two READINGS on the fields that were sent, never
    // the request: a response still holding the old value is a call that did
    // not apply, not one that changed nothing.
    let same: boolean | null = null;
    if (previous !== null && resulting !== null) {
      const before = comparableOfRow(previous);
      same = agreement(
        Object.fromEntries(Object.keys(wanted).map((key) => [key, before[key]])),
        comparableOfRow(resulting),
      );
    }
    return {
      id,
      requested: fields,
      lookup: lookupError !== null ? 'UNREADABLE' : previous === null ? 'NOT_FOUND' : 'FOUND',
      lookup_error: lookupError,
      previous,
      resulting,
      changed: same === null ? null : !same,
      confirmed: resulting === null ? null : agreement(wanted, comparableOfRow(resulting)),
    };
  },
};

/**
 * The categories whose vdevs hold pool data, so losing one faults the pool.
 * `log`, `cache` and `spare` hold nothing the pool cannot run without, which is
 * why the redundancy check is made for these three alone.
 */
const DATA_CATEGORIES: readonly string[] = ['data', 'special', 'dedup'];

/** One leaf of a pool's topology, found under the disk name asked for. */
interface LocatedDevice {
  category: (typeof VDEV_CATEGORIES)[number];
  device: Record<string, unknown>;
  /** The top-level vdev the leaf is in, which IS the leaf where it stands alone. */
  vdev: Record<string, unknown>;
  /** The vdev's members, every one of them a record — `[]` for a leaf on its own. */
  members: Record<string, unknown>[];
  /** The node the leaf sits directly beneath — the vdev for a direct member, the leaf itself on its own. */
  parent: Record<string, unknown>;
  /** 0 for a vdev on its own, 1 for a direct member, more for one nested deeper. */
  depth: number;
}

/**
 * A node's children as records, or null where they are not a list of them.
 * Absent and null are a leaf, as `mapNode` reads them.
 */
function childNodes(node: Record<string, unknown>): Record<string, unknown>[] | null {
  const children = node['children'] ?? [];
  if (!Array.isArray(children)) return null;
  const records = children.map((child) => recordOrNull(child));
  return records.every((child) => child !== null) ? (records as Record<string, unknown>[]) : null;
}

/**
 * The one leaf in `row`'s topology whose `disk` is `disk`, or the error saying
 * why there is not exactly one.
 *
 * A topology any part of which could not be read refuses, whichever direction
 * was asked for: the part not read could hold a second listing of the disk,
 * and a second listing is what the ambiguity refusal below exists for.
 *
 * A disk listed TWICE is refused rather than resolved. That is a spare in use,
 * which ZFS lists in `spare` and again inside the vdev it stands in for, and
 * which of the two roles an offline would reach is not something the two
 * listings say.
 */
function locateDevice(pool: string, row: Record<string, unknown>, disk: string): LocatedDevice {
  const topology = recordOrNull(row['topology']);
  const unreadable = new Error(
    `The topology of pool "${pool}" could not be read in full, so where disk "${disk}" sits in it ` +
      'cannot be established',
  );
  if (topology === null) throw unreadable;
  const found: LocatedDevice[] = [];
  let complete = true;
  const walk = (
    category: LocatedDevice['category'],
    vdev: Record<string, unknown>,
    members: Record<string, unknown>[],
    parent: Record<string, unknown>,
    node: Record<string, unknown>,
    depth: number,
  ): void => {
    if (textOrNull(node['disk']) === disk) found.push({ category, device: node, vdev, members, parent, depth });
    const children = childNodes(node);
    if (children === null) {
      complete = false;
      return;
    }
    for (const child of children) walk(category, vdev, members, node, child, depth + 1);
  };
  for (const category of VDEV_CATEGORIES) {
    // An older middleware may not carry every category; a category it does
    // carry that is not a list is a part of the topology not read.
    const vdevs: unknown = topology[category] ?? [];
    if (!Array.isArray(vdevs)) {
      complete = false;
      continue;
    }
    for (const value of vdevs) {
      const vdev = recordOrNull(value);
      if (vdev === null) {
        complete = false;
        continue;
      }
      walk(category, vdev, childNodes(vdev) ?? [], vdev, vdev, 0);
    }
  }
  if (!complete) throw unreadable;
  if (found.length > 1) {
    throw new Error(
      `Disk "${disk}" is listed ${found.length} times in pool "${pool}"'s topology ` +
        `(${found.map((entry) => entry.category).join(', ')}) — a spare in use is listed as a ` +
        'spare and again inside the vdev it stands in for — so which role a change would reach ' +
        'cannot be said, and nothing is planned',
    );
  }
  if (found.length === 0) {
    throw new Error(
      `No disk "${disk}" in pool "${pool}"'s topology — \`storage_pool_topology\` names each ` +
        'device by `disk`',
    );
  }
  return found[0];
}

/** What a device is called in a sentence: its disk, else the name ZFS gives its slot. */
function memberName(node: Record<string, unknown>): string {
  return textOrNull(node['disk']) ?? textOrNull(node['name']) ?? '(unnamed)';
}

function statusText(node: Record<string, unknown>): string {
  return textOrNull(node['status']) ?? 'state not readable';
}

/**
 * A RAIDZ or dRAID vdev's parity, or null where it cannot be read.
 *
 * RAIDZ carries it in its type. Whether a dRAID's type does is (unconfirmed),
 * so a bare `DRAID` falls back to the vdev's ZFS name, which spells the parity
 * first (`draid2:…`); where neither does, there is no parity to check against.
 */
function parityOf(vdev: Record<string, unknown>): number | null {
  const type = textOrNull(vdev['type']) ?? '';
  const spelled =
    /^(?:RAIDZ|DRAID)([1-3])$/.exec(type) ??
    (type === 'DRAID' ? /^draid([1-3]):/.exec(textOrNull(vdev['name']) ?? '') : null);
  return spelled === null ? null : Number(spelled[1]);
}

/** The vdev's type and every member's state now, as the plan states them. */
function vdevSentence(disk: string, located: LocatedDevice): string {
  const { category, device, vdev, members, depth } = located;
  if (depth === 0) {
    return `Disk "${disk}" is a \`${category}\` vdev on its own, and is now ${statusText(device)}.`;
  }
  const states = (nodes: Record<string, unknown>[]) =>
    nodes.map((member) => `${memberName(member)} ${statusText(member)}`).join(', ');
  const type = textOrNull(vdev['type']);
  // A device nested deeper is named inside the node it sits beneath, whose own
  // members are listed too: the vdev's list names that node and not them.
  const nested =
    depth > 1
      ? ` It sits beneath ${memberName(located.parent)} (${textOrNull(located.parent['type']) ?? 'type not readable'}), ` +
        `whose members are ${states(childNodes(located.parent) ?? [])}.`
      : '';
  return (
    `Disk "${disk}" is in a ${type === null ? 'vdev of a type not readable' : `${type} vdev`} in ` +
    `the \`${category}\` category, now ${statusText(device)}; its members are ${states(members)}.${nested}`
  );
}

/**
 * Why taking the device offline is refused, or null where it is not.
 *
 * Computed over what was read, and every case it cannot read refuses: a
 * redundancy check that defaults to "safe" is #154's costly direction. A device
 * already OFFLINE is not refused, because sending it offline again takes
 * nothing more away.
 *
 * A running resilver refuses whatever the count says, and so does a scan that
 * could not be read: the count reads member STATES, and a member being
 * resilvered reads ONLINE before it holds what it is being resilvered with. It
 * is pool-wide rather than per vdev because the scan record is.
 */
function offlineRefusal(pool: string, disk: string, found: DeviceFound): string | null {
  const { category, device, vdev, members, depth } = found.located;
  if (!DATA_CATEGORIES.includes(category) || textOrNull(device['status']) === 'OFFLINE') return null;
  const refuse = (reason: string) => `Refusing to take disk "${disk}" offline in pool "${pool}": ${reason}`;
  if (depth === 0) {
    return refuse(`it is a \`${category}\` vdev on its own — a stripe — so taking it offline faults the pool`);
  }
  if (depth > 1) {
    return refuse(
      'it sits beneath another device inside its vdev (one being replaced, or covered by a spare), ' +
        'which the redundancy check here does not cover, so the check could not be made',
    );
  }
  if (found.resilvering !== false) {
    return refuse(
      found.resilvering
        ? 'a resilver is running on the pool, and a member being resilvered reads ONLINE before it ' +
            'holds all of its data, so how many members can serve the vdev cannot be counted'
        : 'whether a resilver is running on the pool could not be read, and a member being ' +
            'resilvered reads ONLINE before it holds all of its data, so the check could not be made',
    );
  }
  const others = members.filter((member) => member !== device);
  if (others.some((member) => textOrNull(member['status']) === null)) {
    return refuse('the state of another member of its vdev could not be read, so the check could not be made');
  }
  const othersOnline = others.filter((member) => textOrNull(member['status']) === 'ONLINE').length;
  const type = textOrNull(vdev['type']);
  if (type === 'MIRROR') {
    return othersOnline === 0 ? refuse('no other member of its mirror is ONLINE') : null;
  }
  const parity = parityOf(vdev);
  if (parity === null) {
    return refuse(
      `its vdev's type (${type ?? 'not readable'}) is not one whose redundancy this tool can read, so ` +
        'the check could not be made',
    );
  }
  const notOnline = others.length - othersOnline + 1;
  return notOnline > parity
    ? refuse(
        `${notOnline} of its ${type}'s ${members.length} members would be not ONLINE, more than ` +
          `its parity of ${parity} covers`,
      )
    : null;
}

/**
 * What bringing the device back does, by what it is. Only a member of a vdev
 * that holds pool data has a rest-of-vdev to be resilvered from; a `cache` or
 * `spare` device holds nothing the pool needs, and a vdev on its own has no
 * other copy beside it. Claiming a resilver for those would put an effect in
 * the plan that does not happen.
 */
function onlineEffect(located: LocatedDevice): string {
  if (located.category === 'cache' || located.category === 'spare') {
    return ` It is a \`${located.category}\` device, which holds no data the pool depends on, so ` +
      'nothing the pool needs is resilvered onto it.';
  }
  if (located.depth === 0) {
    return ' It is a vdev on its own, so there is no other copy beside it in its vdev to resilver from.';
  }
  return ' A RESILVER FOLLOWS: ZFS rewrites onto the device what it missed while it was away, ' +
    'reading it from the rest of its vdev, which takes time.';
}

/** What `pool_device_set_online` was asked to do. */
interface DeviceArgs {
  pool: string;
  disk: string;
  online: boolean;
}

function parseDeviceArgs(args: Record<string, unknown>): DeviceArgs {
  const pool = textOrNull(args['pool']);
  if (pool === null) throw new Error('"pool" is required and must be a pool name');
  const disk = textOrNull(args['disk']);
  if (disk === null) {
    throw new Error('"disk" is required and must be a disk name, as `storage_pool_topology` reports it');
  }
  const online = args['online'];
  if (typeof online !== 'boolean') throw new Error('"online" is required and must be a boolean');
  return { pool, disk, online };
}

/** The device as read immediately before a call: what to send, and where it sits. */
interface DeviceFound {
  poolId: number;
  guid: string;
  located: LocatedDevice;
  /** Whether the pool's scan is a resilver still running, or null where that could not be read. */
  resilvering: boolean | null;
}

/**
 * Whether a resilver is running on the pool, or null where its scan could not
 * be read. A pool that holds no scan has never had one, which is `scrubState`'s
 * reading of the same null.
 *
 * This is what the redundancy count cannot see on its own: a member being
 * resilvered reads ONLINE before it holds all of its vdev's data, so counting
 * it as a working copy would let the one complete member be taken offline.
 */
function resilverRunning(row: Record<string, unknown>): boolean | null {
  if (row['scan'] === null) return false;
  const scan = recordOrNull(row['scan']);
  const operation = scan === null ? null : textOrNull(scan['function']);
  const state = scan === null ? null : textOrNull(scan['state']);
  if (operation === null || state === null) return null;
  return operation === 'RESILVER' && state === 'SCANNING';
}

/**
 * Reads the pool by name and finds the device in it, or fails naming which of
 * them it could not find. Made at plan time AND again by `execute`, because the
 * token binds the names and not the ids the plan resolved them to (#181).
 */
async function readDevice(ctx: ToolContext, args: DeviceArgs): Promise<DeviceFound> {
  const row = await readPoolNamed(ctx, args.pool);
  const poolId = numberOrNull(row['id']);
  if (poolId === null) {
    throw new Error(`Pool "${args.pool}" is listed with no id this tool could read, so no device in it can be named`);
  }
  const located = locateDevice(args.pool, row, args.disk);
  const guid = textOrNull(located.device['guid']);
  if (guid === null) {
    throw new Error(
      `Disk "${args.disk}" in pool "${args.pool}" reported no GUID this tool could read, and the GUID is ` +
        'what the call names it by',
    );
  }
  return { poolId, guid, located, resilvering: resilverRunning(row) };
}

/**
 * The node of `row`'s topology carrying `guid`, or null; a part not readable is
 * passed over. Matched on the GUID alone and not on `disk`, which a device that
 * faulted or was pulled can lose — the very outcome this read may be reporting.
 */
function deviceWithGuid(row: Record<string, unknown>, guid: string): Record<string, unknown> | null {
  const topology = recordOrNull(row['topology']);
  const search = (nodes: unknown): Record<string, unknown> | null => {
    for (const value of Array.isArray(nodes) ? nodes : []) {
      const node = recordOrNull(value);
      if (node === null) continue;
      if (textOrNull(node['guid']) === guid) return node;
      const nested = search(node['children']);
      if (nested !== null) return nested;
    }
    return null;
  };
  for (const category of VDEV_CATEGORIES) {
    const node = topology === null ? null : search(topology[category]);
    if (node !== null) return node;
  }
  return null;
}

const DEVICE_GUIDANCE =
  '`pool_id` and `guid` are what the call was sent, read immediately before it, ' +
  'and `category` is the role the device serves in the pool, as ' +
  '`storage_pool_topology` names it. `previous_status` is the device\'s ZFS state ' +
  'read immediately before the call, null where it reported none this tool ' +
  'could read. `resulting_status` is its state read again immediately after the ' +
  'call, finding the device by its GUID, and IS NEVER INFERRED FROM THE CALL ' +
  'RETURNING. AN ONLINE THAT WORKED IS NOT A DEVICE THAT IS REPAIRED: it can read ' +
  '`ONLINE` while the resilver of what it missed is still running — the pool\'s ' +
  'scan, which `storage_scrub_history` reports — or still read `FAULTED` or ' +
  '`UNAVAIL` for a disk that has failed. `resulting_lookup` says what that read ' +
  'did: `FOUND`; `NOT_FOUND`, where the pool was not listed under its name or no ' +
  'device in its topology carried that GUID, which includes a topology that ' +
  'could not be read; or `UNREADABLE`, the read failing, with ' +
  '`resulting_read_error` naming why and null otherwise. `resulting_status` is ' +
  'null under the last two AND under `FOUND` where the device reported no state ' +
  'this tool could read, so the lookup alone does not separate them. A read ' +
  'after the call that failed is not a failed call: the call had already been ' +
  'made. `changed` compares the two readings, never the request, and is null ' +
  'wherever either reading is, which is not "nothing changed".';

export const poolDeviceSetOnline: MutatingTool = {
  name: 'pool_device_set_online',
  description:
    'Takes one device in a data pool offline, or brings it back online, on this ' +
    'TrueNAS system. Two-phase: called without a confirmation_token it returns a ' +
    'plan for user approval; called with one it sends the change. `pool` is the ' +
    'pool\'s NAME as `storage_pool_status` reports it, and `disk` the device as ' +
    '`storage_pool_topology` reports it in `disk`; the boot pool is not covered. ' +
    '`online` is required: false takes the device offline, true brings it back. A ' +
    'pool or disk this system does not list fails the plan, naming which; so does ' +
    'a disk listed more than once — a spare in use is listed as a spare and again ' +
    'inside the vdev it stands in for — and a topology that could not be read in ' +
    'full. TAKING A DEVICE OFFLINE IS REFUSED, AT PLAN TIME AND AGAIN WHEN THE CALL ' +
    'IS MADE, wherever its vdev would be left unable to serve its data: a `data`, ' +
    '`special` or `dedup` device that is a vdev on its own (a stripe); the last ' +
    'ONLINE member of a mirror; a RAIDZ or dRAID member where the members not ' +
    'ONLINE, counting this one, would exceed the parity; and any device whose vdev ' +
    'type or member states could not be read, or that sits beneath another device ' +
    'inside its vdev (one being replaced, or covered by a spare). Those are also ' +
    'refused WHILE A RESILVER IS RUNNING ON THE POOL, or where whether one is ' +
    'could not be read, because a member being resilvered reads ONLINE before it ' +
    'holds all of its data and the count would take it for a working copy. A ' +
    'device already OFFLINE is not refused. A `log`, `cache` or `spare` device is not refused, ' +
    'and the plan names which it is. The plan states the vdev\'s type and every ' +
    'member\'s current state. dRAID parity is read from the vdev\'s type, or from ' +
    'its name where the type does not carry it, (unconfirmed) that either does; ' +
    'where neither does, the device is refused. Whether the system itself refuses ' +
    'an offline that would fault the pool is (unconfirmed), and this tool does not ' +
    'rely on it. The device is named to the system by its vdev GUID, ' +
    '(unconfirmed) that the call takes the GUID rather than a device path. ' +
    'BRINGING A DEVICE ONLINE DOES NOT REPAIR IT: a member of a mirror or a ' +
    'parity vdev is then resilvered with what it missed, and a disk that has failed stays ' +
    'failed; the plan says which applies. A device already in the ' +
    'state asked for is not an error. `destructiveness` is `reversible`: the ' +
    'reverse call brings the device back, and destroys no data either way — but a ' +
    'device left offline leaves its vdev with less redundancy than it had until it ' +
    'is back and resilvered. ' +
    DEVICE_GUIDANCE,
  resultGuidance: DEVICE_GUIDANCE,
  inputSchema: {
    type: 'object',
    properties: {
      pool: {
        type: 'string',
        description: 'The data pool\'s name, as `storage_pool_status` reports it.',
      },
      disk: {
        type: 'string',
        description: 'The device, as `storage_pool_topology` reports it in `disk`, e.g. "sdb".',
      },
      online: {
        type: 'boolean',
        description: 'false takes the device offline; true brings it back online.',
      },
    },
    required: ['pool', 'disk', 'online'],
  },
  requiredRole: Role.Full,
  mutating: true,
  destructiveness: 'reversible',
  normalizeArgs(rawArgs) {
    const { pool, disk, online } = parseDeviceArgs(rawArgs);
    return { pool, disk, online };
  },
  async plan(ctx, rawArgs): Promise<PlanStep[]> {
    const args = parseDeviceArgs(rawArgs);
    const found = await readDevice(ctx, args);
    const { category, device } = found.located;
    if (!args.online) {
      const refusal = offlineRefusal(args.pool, args.disk, found);
      if (refusal !== null) throw new Error(refusal);
    }
    // A device already in the state asked for is not an error (#119), and the
    // effect sentence would then describe a change that is not being made.
    const status = textOrNull(device['status']);
    const target = args.online ? 'ONLINE' : 'OFFLINE';
    const already = status === target ? ` It is already ${target}, which is not an error.` : '';
    const effect = already !== ''
      ? ''
      : args.online
      ? onlineEffect(found.located) +
        ' Bringing it online does not repair it, and a disk that has failed stays failed.'
      : DATA_CATEGORIES.includes(category)
        ? ' Its vdev runs with less redundancy than it has now until the device is back ' +
          'online and resilvered.'
        : ` It is a \`${category}\` device, which holds no data the pool depends on, so ` +
          'no data redundancy is lost; the pool runs without it until it is back.';
    return [
      {
        method: 'pool.query',
        params: queryParams([['name', '=', args.pool]]),
        description:
          `Read pool "${args.pool}" and its topology, to find disk "${args.disk}" and the ids the ` +
          `call is sent — pool ${found.poolId}, GUID ${found.guid} when this plan was made. ` +
          'Changes nothing. If the pool or the disk is not listed when this runs, nothing is sent' +
          (args.online
            ? '.'
            : ', and the redundancy check is made again on what it reads: a vdev that would now ' +
              'be left unable to serve its data refuses the call rather than sending it.') +
          ' This same read is made again immediately after the call, to report the state that ' +
          'resulted.',
      },
      {
        method: args.online ? 'pool.online' : 'pool.offline',
        params: [found.poolId, { label: found.guid }],
        description:
          `${args.online ? 'Bring' : 'Take'} disk "${args.disk}" ${args.online ? 'online' : 'offline'} ` +
          `in pool "${args.pool}", naming it by its vdev GUID — (unconfirmed) that the call takes ` +
          `the GUID rather than a device path. ${vdevSentence(args.disk, found.located)}` +
          `${effect}${already}`,
      },
    ];
  },
  async execute(ctx, rawArgs) {
    const args = parseDeviceArgs(rawArgs);
    // Not caught: this read is what the call's params come from, so where it
    // fails there is nothing to send. A device whose vdev has lost a member
    // since the plan is refused here too — a refusal, not a branch to another
    // call (#187).
    const found = await readDevice(ctx, args);
    if (!args.online) {
      const refusal = offlineRefusal(args.pool, args.disk, found);
      if (refusal !== null) throw new Error(refusal);
    }
    const params: [number, { label: string }] = [found.poolId, { label: found.guid }];
    await firstValueFrom(
      args.online
        ? ctx.system.client.api.call('pool.online', params)
        : ctx.system.client.api.call('pool.offline', params),
    );
    // The call has landed by here, so this read may not fail the tool.
    let lookup: 'FOUND' | 'NOT_FOUND' | 'UNREADABLE' = 'NOT_FOUND';
    let readError: string | null = null;
    let resultingStatus: string | null = null;
    try {
      const rows: unknown = await firstValueFrom(
        ctx.system.client.api.query('pool.query', [['name', '=', args.pool]]),
      );
      const row = poolRowNamed(rows, args.pool);
      const device = row === null ? null : deviceWithGuid(row, found.guid);
      if (device !== null) {
        lookup = 'FOUND';
        resultingStatus = textOrNull(device['status']);
      }
    } catch (reason) {
      lookup = 'UNREADABLE';
      readError = errorText(reason);
    }
    const previousStatus = textOrNull(found.located.device['status']);
    return {
      pool: args.pool,
      disk: args.disk,
      requested_online: args.online,
      pool_id: found.poolId,
      guid: found.guid,
      category: found.located.category,
      previous_status: previousStatus,
      resulting_lookup: lookup,
      resulting_read_error: readError,
      resulting_status: resultingStatus,
      changed:
        previousStatus === null || resultingStatus === null ? null : previousStatus !== resultingStatus,
    };
  },
};
