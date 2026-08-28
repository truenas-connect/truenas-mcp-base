import { firstValueFrom } from 'rxjs';
import { Role } from '@/interfaces';
import { ReadOnlyTool } from '@/catalog/tool';

/** Pool internals: the vdev tree beneath each pool, and the state of every
 * device in it.
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
 * topology node: each field has one intended meaning, and "not reported" is it.
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
