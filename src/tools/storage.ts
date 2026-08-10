import type { CallParams } from '@truenas/api-client';
import { firstValueFrom } from 'rxjs';
import { asList } from '@/tools/query';
import { Role } from '@/interfaces';
import { ApiSurface, ReadOnlyTool } from '@/catalog/tool';

/** A ZFS property as the middleware reports it; the generated types flatten
 * these to `{}`, losing the parsed numeric value the tools surface. */
interface ZfsProperty {
  parsed?: unknown;
}

/** Storage-health family: read-only inspection of pools and datasets. */

export const poolStatus: ReadOnlyTool = {
  name: 'storage_pool_status',
  description:
    'Health and capacity of ZFS storage pools: status, whether the pool is ' +
    'healthy, and size/allocated/free in bytes.',
  inputSchema: { type: 'object', properties: {} },
  requiredRole: Role.ReadOnly,
  mutating: false,
  async handler({ system }) {
    const pools = asList(await firstValueFrom(system.client.api.call('pool.query')));
    return pools.map((pool) => ({
      name: pool.name,
      status: pool.status,
      healthy: pool.healthy,
      size_bytes: pool.size,
      allocated_bytes: pool.allocated,
      free_bytes: pool.free,
    }));
  },
};

export const listDatasets: ReadOnlyTool = {
  name: 'storage_list_datasets',
  description:
    'Lists ZFS datasets with type, mountpoint, and space usage. Optionally ' +
    'restricted to one pool.',
  inputSchema: {
    type: 'object',
    properties: {
      pool: {
        type: 'string',
        description: 'Only list datasets in this pool.',
      },
    },
  },
  requiredRole: Role.ReadOnly,
  mutating: false,
  async handler({ system }, args) {
    // Derived from the call's own params: QueryOperator is not exported, and
    // a hand-written [string, string, unknown] no longer satisfies it.
    const filters: NonNullable<CallParams<ApiSurface, 'pool.dataset.query'>[0]> =
      typeof args['pool'] === 'string' ? [['pool', '=', args['pool']]] : [];
    // retrieve_children makes the middleware walk the whole dataset tree; the
    // response is already a flat list (every dataset is a top-level entry) in
    // which each entry redundantly nests its descendants under `children`, so
    // it must not be flattened again.
    const datasets = asList(
      await firstValueFrom(
        system.client.api.call('pool.dataset.query', [
        filters,
          { extra: { retrieve_children: true, properties: ['used', 'available'] } },
        ]),
      ),
    );
    return datasets.map((dataset) => ({
      id: dataset['id'],
      pool: dataset['pool'],
      type: dataset['type'],
      mountpoint: dataset['mountpoint'],
      // The generated types erase the ZFS property object to `{}`, so the
      // `parsed` field the middleware returns has to be re-stated here.
      used: (dataset['used'] as ZfsProperty | undefined)?.parsed,
      available: (dataset['available'] as ZfsProperty | undefined)?.parsed,
    }));
  },
};
