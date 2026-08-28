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
  name: string | undefined;
  type: string | undefined;
  status: string | undefined;
  disk: string | null;
  devices: TopologyDevice[];
}

function mapNode(node: TopologyNode): TopologyDevice {
  return {
    name: node.name,
    // The vdev kind — MIRROR, RAIDZ1, DISK, and so on — not the medium. A leaf
    // is reported as type DISK, which is how a single-disk (stripe) vdev and a
    // member of a mirror end up looking alike; their depth is what separates
    // them.
    type: node.type,
    status: node.status,
    // Null on a node that groups other devices, and null again on a leaf whose
    // disk the middleware could not resolve — a pulled or dead device, where it
    // reports the identifier under `unavail_disk` instead. Normalized rather
    // than passed through, because an absent key serializes to no key at all
    // and the description promises the caller a null. Unlike `pool` in
    // `disks.ts`, there is nothing here for absent and null to keep apart: both
    // mean this node does not name a disk.
    disk: node.disk ?? null,
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
    'in the `spare` category is the exception and is not failing in either of ' +
    'its own states: AVAIL is an idle spare standing by, INUSE one that has ' +
    'been swapped in for a failed disk. `disk` names the physical device, ' +
    'matching `name` in `disks_list`. It is null on a vdev that groups other ' +
    'devices rather than sitting on one, and null again on a device the system ' +
    'can no longer resolve to a disk — one that has been pulled or has died ' +
    'outright, which is what a REMOVED or UNAVAIL status on a leaf means. So a ' +
    'null `disk` is read together with `type`: a leaf reports type DISK and ' +
    'names itself in `name`, and that name is what identifies it when there is ' +
    'no `disk` to give. `devices` nests: a mirror lists its ' +
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
