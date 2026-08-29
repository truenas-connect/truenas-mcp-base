import { firstValueFrom } from 'rxjs';
import { Role } from '@/interfaces';
import { ReadOnlyTool } from '@/catalog/tool';

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
    const pools = await firstValueFrom(system.client.api.query('pool.query'));
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
    // retrieve_children makes the middleware walk the whole dataset tree; the
    // response is already a flat list (every dataset is a top-level entry) in
    // which each entry redundantly nests its descendants under `children`, so
    // it must not be flattened again.
    const datasets = await firstValueFrom(
      // Filters are inlined so the call's own parameter types apply: written
      // to a `const` first they widen to string[][] and no longer satisfy the
      // filter tuple, and the naming types are not exported to annotate with.
      system.client.api.query(
        'pool.dataset.query',
        typeof args['pool'] === 'string' ? [['pool', '=', args['pool']]] : [],
        {
          extra: { retrieve_children: true, properties: ['used', 'available'] },
        },
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

/**
 * The numeric value of a ZFS property, or null where the middleware reported
 * none.
 *
 * Every property this tool reads is a byte count, and the generated types erase
 * the property object to `{}`, so `parsed` arrives as `unknown`: a value that
 * is not a finite number is not a byte count, whatever else it may be. Null
 * rather than a coerced zero, because a dataset whose usage could not be read
 * must not report as one using nothing.
 */
function propertyBytes(property: unknown): number | null {
  const parsed = (property as ZfsProperty | undefined)?.parsed;
  return typeof parsed === 'number' && Number.isFinite(parsed) ? parsed : null;
}

/**
 * A quota as ZFS reports it: the limit in bytes, `0` where no limit of that
 * kind is set, or null where the property could not be read at all.
 *
 * The last two are the distinction this tool exists to keep. A dataset with no
 * quota is unconstrained; one whose quota could not be read may already be over
 * a limit nobody can see, and reporting either as the other is the failure
 * worth avoiding.
 *
 * `0` is what ZFS itself reports for "no limit" rather than a sentinel chosen
 * here, and the client types the same field `number | (0 | null)` on the
 * dataset payload. So a null is that same spelling wherever it appears — as
 * the property itself, or as its `parsed` value — and both report as `0`. Only
 * a property that is absent, that is not an object at all, or that carries no
 * `parsed` value is unreadable.
 */
function quotaLimit(property: unknown): number | null {
  if (property === null) return 0;
  // The row arrives as `unknown` and this is the only guard between it and the
  // `in` below, which throws a TypeError on a primitive rather than answering
  // false. A property the middleware sends as a bare number or string is not
  // the object shape this tool reads, so it is unreadable rather than fatal.
  if (typeof property !== 'object') return null;
  if (!('parsed' in property)) return null;
  return (property as ZfsProperty).parsed === null ? 0 : propertyBytes(property);
}

/**
 * Usage as a percentage of a limit, to one decimal place, or null where no
 * percentage can be stated — an unreadable usage, an unreadable limit, or no
 * limit at all, since nothing is a percentage of unlimited.
 *
 * Not capped at 100: a refquota can be lowered below what a dataset already
 * references, and a dataset past its limit is precisely the one a caller
 * asking this question is looking for.
 */
function usedPercent(used: number | null, limit: number | null): number | null {
  if (used === null || limit === null || limit <= 0) return null;
  return Math.round((used / limit) * 1000) / 10;
}

/**
 * How close each dataset is to a limit it has been given.
 *
 * `storage_list_datasets` reports used and available bytes, which describe a
 * dataset's share of its pool rather than its own ceiling: a dataset can sit in
 * a pool that is nearly empty and still be one write away from a quota. Those
 * are different questions and only the second is asked here.
 *
 * ZFS enforces two limits, against two different measurements, and pairing
 * either limit with the other measurement gives a percentage that is wrong
 * rather than merely imprecise:
 *
 *     quota     caps `used`       — the dataset with its descendants and snapshots
 *     refquota  caps `referenced` — the data the dataset itself holds, alone
 *
 * A parent whose children are large can therefore sit at its quota while its
 * refquota is barely touched, which is why each limit is reported beside the
 * usage it actually caps rather than both against one number.
 */
export const quotaReport: ReadOnlyTool = {
  name: 'datasets_quota_report',
  description:
    'Quota limits on each ZFS dataset and how close it is to them. ZFS ' +
    'enforces two separate limits, and each is reported beside the usage it ' +
    'caps: `quota` caps `used_bytes`, the dataset together with its ' +
    'descendants and snapshots, while `refquota` caps `referenced_bytes`, the ' +
    'data the dataset itself holds alone. A parent with large children can ' +
    'therefore sit at its quota while its refquota is barely touched. ' +
    '`quota_bytes` and `refquota_bytes` are the limits in bytes. `0` means no ' +
    'limit of that kind is set, which is what ZFS itself reports and is not ' +
    'the same as null: null means the limit could not be read, so an ' +
    'unconstrained dataset stays distinct from one that may already be over a ' +
    'limit that cannot be seen. `quota_used_percent` and ' +
    '`refquota_used_percent` are the usage as a percentage of the matching ' +
    'limit, to one decimal place, and each is null whenever no percentage can ' +
    'be stated — no limit set, a limit that could not be read, or a usage ' +
    'that could not be read. Neither is capped at 100: a limit lowered below ' +
    'what a dataset already holds reads above it, and that is the dataset ' +
    'worth finding. `threshold_percent` restricts the result to datasets at ' +
    'or above that percentage of either limit; a dataset with no percentage ' +
    'at all is not returned when it is given. `id` and `pool` match the ' +
    'fields of the same names in `storage_list_datasets`.',
  inputSchema: {
    type: 'object',
    properties: {
      threshold_percent: {
        type: 'number',
        description:
          'Only report datasets using at least this percentage of a quota or ' +
          'refquota. Omitted, every dataset is reported.',
      },
    },
  },
  requiredRole: Role.ReadOnly,
  mutating: false,
  async handler({ system }, args) {
    const datasets = await firstValueFrom(
      // Filters and options are inlined so the call's own parameter types
      // apply, as above.
      system.client.api.query('pool.dataset.query', [], {
        extra: {
          retrieve_children: true,
          // `referenced` is a core ZFS property and the one `refquota` caps,
          // but the generated entry type does not declare it — that type is an
          // allowlist of the fields the generator saw, with an index signature
          // for everything else. It is requested by name like the others, and
          // a middleware that does not return it leaves the refquota
          // percentage null rather than computing a wrong one against `used`.
          properties: ['used', 'referenced', 'quota', 'refquota'],
        },
      }),
    );
    // Top-level entries only, as in `storage_list_datasets`: every dataset is
    // already one, and each additionally nests its descendants under
    // `children`, so walking those would report every dataset twice or more.
    const rows = datasets.map((dataset) => {
      const quota = quotaLimit(dataset['quota']);
      const refquota = quotaLimit(dataset['refquota']);
      const used = propertyBytes(dataset['used']);
      const referenced = propertyBytes(dataset['referenced']);
      return {
        id: dataset['id'],
        pool: dataset['pool'],
        quota_bytes: quota,
        used_bytes: used,
        quota_used_percent: usedPercent(used, quota),
        refquota_bytes: refquota,
        referenced_bytes: referenced,
        refquota_used_percent: usedPercent(referenced, refquota),
      };
    });
    // Filtered here rather than in the query: the percentage is computed from
    // two properties the middleware has no notion of comparing, so there is no
    // filter that could express it.
    const threshold = args['threshold_percent'];
    if (typeof threshold !== 'number') return rows;
    return rows.filter(
      (row) =>
        (row.quota_used_percent !== null && row.quota_used_percent >= threshold) ||
        (row.refquota_used_percent !== null && row.refquota_used_percent >= threshold),
    );
  },
};
