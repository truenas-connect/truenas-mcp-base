import { ApiCallResponse, TrueNasEndpoint } from '@truenas/api-client';
import { firstValueFrom } from 'rxjs';
import { Role } from '@/interfaces';
import { ReadOnlyTool } from '@/catalog/tool';

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
    const pools = await firstValueFrom(system.client.api.call(TrueNasEndpoint.PoolQuery));
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

type Dataset = ApiCallResponse<TrueNasEndpoint.DatasetQuery>[number];

function flatten(datasets: Dataset[]): Dataset[] {
  return datasets.flatMap((dataset) => [dataset, ...flatten(dataset.children ?? [])]);
}

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
    const filters: [string, string, string][] =
      typeof args['pool'] === 'string' ? [['pool', '=', args['pool']]] : [];
    const roots = await firstValueFrom(
      system.client.api.call(TrueNasEndpoint.DatasetQuery, [
        filters,
        { extra: { retrieve_children: true, properties: ['used', 'available'] } },
      ]),
    );
    return flatten(roots).map((dataset) => ({
      id: dataset.id,
      pool: dataset.pool,
      type: dataset.type,
      mountpoint: dataset.mountpoint,
      used: dataset.used?.parsed,
      available: dataset.available?.parsed,
    }));
  },
};
