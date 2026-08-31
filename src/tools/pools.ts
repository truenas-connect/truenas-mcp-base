import { firstValueFrom } from 'rxjs';
import { Role } from '@/interfaces';
import { ReadOnlyTool } from '@/catalog/tool';
import { booleanOrNull, numberOrNull, recordOrNull, textOrNull } from '@/tools/common';

/** Pool internals: the vdev tree beneath each pool, the state of every device
 * in it, and the outcome of the last scrub that verified it.
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
