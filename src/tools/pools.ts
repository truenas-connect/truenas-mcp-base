import { firstValueFrom } from 'rxjs';
import { Role } from '@/interfaces';
import { ReadOnlyTool } from '@/catalog/tool';

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
function scrubState(topology: unknown, scan: ScanRecord | null, scrub: ScanRecord | null) {
  if (!topology) return 'UNKNOWN';
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
    'count while one is still going. Those four fields are null exactly when ' +
    '`state` is `NEVER_SCRUBBED` or `UNKNOWN`, because the record then ' +
    'describes a resilver, or nothing at all, rather than a scrub; a null ' +
    '`state` still carries them, because a scrub is on record either way. ' +
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
      const scan: ScanRecord | null = pool.scan ?? null;
      // The scan is only this tool's subject when it is a scrub. A resilver's
      // times and error count are read through `null` rather than reported,
      // so that no field of a resilver is ever presented as one of a scrub.
      const scrub = scan?.function === 'SCRUB' ? scan : null;
      return {
        pool: pool.name,
        // `topology` is what says the system is reading this pool at all: it
        // is null on one that is not imported, whose absent scan record is
        // then an absence of evidence rather than evidence of no scrub.
        state: scrubState(pool.topology, scan, scrub),
        started_at: orNull(scrub?.start_time),
        finished_at: orNull(scrub?.end_time),
        duration_seconds: scrubDuration(scrub),
        errors: scrub?.errors ?? null,
      };
    });
  },
};
