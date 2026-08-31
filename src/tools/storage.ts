import { firstValueFrom } from 'rxjs';
import { Role } from '@/interfaces';
import { ReadOnlyTool } from '@/catalog/tool';
import { booleanOrNull, recordOrNull, textOrNull } from '@/tools/common';

/** A ZFS property as the middleware reports it. The client declares the property
 * object on the dataset fields it names, but types its `parsed` value `unknown`
 * — and the one property this file asks for that the client does NOT name
 * reaches it through the row's index signature as `unknown` outright. Either
 * way the value the tools surface has to be restated to be reached. */
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
      // The value the tools surface is the property's `parsed` field, which the
      // client types `unknown` on the property object it declares. So it is
      // reached through the restatement above and passed through as it arrived
      // — this is the middleware's own value, not a number this file checked.
      used: (dataset['used'] as ZfsProperty | undefined)?.parsed,
      available: (dataset['available'] as ZfsProperty | undefined)?.parsed,
    }));
  },
};

/**
 * The numeric value of a ZFS property, or null where the middleware reported
 * none.
 *
 * Every property this tool reads is a byte count, and `parsed` arrives as
 * `unknown` whichever way it is reached — the client types that field `unknown`
 * on the property object it declares, and the property named `referenced` is
 * not a declared dataset field at all. A value that is not a finite number is
 * not a byte count, whatever else it may be. Null rather than a coerced zero,
 * because a dataset whose usage could not be read must not report as one using
 * nothing.
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
 * here. Null is read as that same "no limit" wherever it appears — as the
 * property itself, or as its `parsed` value — on the evidence that the client
 * types this field `number | (0 | null)` on the dataset create and update
 * payloads: the API treats the two as one meaning on the side it does type.
 * The query response declares `quota` and `refquota` as property objects and
 * types the `parsed` value inside each of them `unknown`, so it still settles
 * nothing either way and this is a reading rather than a guarantee. Only a
 * property that is absent, that is not an object at all, or that carries no
 * `parsed` value is unreadable.
 */
function quotaLimit(property: unknown): number | null {
  if (property === null) return 0;
  // The property is read as `unknown` — the client declares it, but a declared
  // type is a claim about what the middleware sends and not about the value
  // received — and this is the only guard between it and the `in` below, which
  // throws a TypeError on a primitive rather than answering false. A property
  // the middleware sends as a bare number or string is not the object shape
  // this tool reads, so it is unreadable rather than fatal.
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
          // `referenced` is a core ZFS property and the one `refquota` caps.
          // The client declares `used`, `quota` and `refquota` as dataset
          // fields and does NOT declare `referenced`, which reaches this file
          // through the row's index signature instead — so of the four names
          // asked for here that one is the unconfirmed one, rather than all
          // four being equally unconfirmed. A middleware that does not return
          // it leaves the refquota percentage null rather than computing a
          // wrong one against `used`, which caps nothing of the sort.
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

/**
 * Which pool holds middleware's own state, and where that state is mounted.
 *
 * The system dataset holds the audit databases, service configuration and
 * Samba's private data, and it lives on ONE pool. The consequence operators
 * meet at the wrong moment is that the pool holding it cannot be exported or
 * detached — "why will this pool not export" was a question nothing in this
 * catalog could answer, and the answer is one unread setting. It is also what
 * sharpens a reading of the rest of the catalog: a DEGRADED pool that happens to
 * hold the system dataset is a different finding from a DEGRADED pool holding
 * data alone.
 *
 * **`pool` and `pool_set` are one fact in two fields, and the second is the one
 * that carries the meaning.** A pool an administrator chose is a decision; a
 * pool middleware settled on by itself is not, and reporting `pool` alone loses
 * the whole distinction. The caution the description draws from a false —
 * that such a pool must not be relied on to stay where it is — follows from what
 * the flag RECORDS rather than from anything measured here: this tool does not
 * read middleware's selection behaviour and states nothing about where an
 * automatic choice would move to. A null is neither value, and reading it as a
 * false would report an administrator's decision as an accident.
 *
 * **`path`'s null is left unsettled, deliberately, which is #120's rule reaching
 * a field rather than a side effect.** The client declares `path: string | null`
 * and says nothing anywhere about what an explicit null indicates; no live
 * system was available here to watch one. The two readings available — the
 * dataset is not mounted, or the system reported no path — are not separable
 * from this payload, so the description says so instead of choosing. Asserting
 * either would be worse than saying nothing, because a caller cannot tell a
 * guess from a reading, and the guess that costs is "unmounted, so the pool is
 * free".
 *
 * **No companion field splits that null**, which is where this differs from
 * #134. A companion earns its place where the causes behind one null are ones a
 * caller would act on DIFFERENTLY; here the explicit null's own meaning is the
 * thing that is unknown, so separating it from an unreadable value would hand a
 * caller a distinction it still could not act on. One null, and a description
 * that names both causes.
 *
 * **Three declared fields are dropped rather than reported**, and that is #102
 * rather than tidying. `id` is a middleware row id and there is only ever one
 * system dataset. `basename` and `uuid` are middleware's own internal naming for
 * the dataset: the surface declares both and states nothing about what either
 * NAMES, so reporting one means describing it, and the only descriptions worth
 * having are readings the surface does not support — that `basename` is a
 * dataset id joinable to `storage_list_datasets`, or that `uuid` identifies the
 * node whose state lives under it. Neither answers a question about the system
 * that `pool` and `path` do not already answer. All three omissions are named in
 * the description, per #102's corollary, so a later reader can tell a decision
 * from a field nobody saw.
 *
 * The read is a single call and there are no sections: a `systemdataset.config`
 * that fails is an error naming what the system said, the same shape
 * `system_general_config` takes, and there is no second read for it to be
 * partial about.
 */
export const systemDatasetConfig: ReadOnlyTool = {
  name: 'system_dataset_config',
  description:
    'Which ZFS pool holds the TrueNAS SYSTEM DATASET, and where that dataset is ' +
    "mounted. The system dataset holds middleware's own state — the audit " +
    "databases, service configuration and Samba's private data — and it lives " +
    'on one pool. THE POOL NAMED HERE CANNOT BE EXPORTED OR DETACHED WHILE IT ' +
    'HOLDS THE SYSTEM DATASET, which is the answer to "why will this pool not ' +
    'export". That restriction is middleware behaviour this tool does NOT read ' +
    'and does not verify; what it reports is which pool the setting names. A ' +
    'system has one system dataset, so this returns a single object rather than ' +
    'a list. ' +
    '`pool` is the name of the pool holding it, as the system spelled it. IT ' +
    'JOINS TO `name` IN `storage_pool_status`, which is what connects this ' +
    "setting to that pool's health — a DEGRADED pool holding the system dataset " +
    'is a sharper finding than a DEGRADED pool holding data alone. A `pool` ' +
    'that does NOT appear in `storage_pool_status` is not evidence that the ' +
    'pool is absent: that tool reads the data pools, and the BOOT POOL is not ' +
    'among them, so a system dataset sitting on the boot pool names a pool it ' +
    'will never report. `boot_pool_status` is where the boot pool is reported. ' +
    '`pool` AND `pool_set` ARE READ TOGETHER OR NOT AT ALL, and reporting the ' +
    'pool without the flag loses the distinction the flag exists for. ' +
    '`pool_set` is whether the system records an EXPLICIT CHOICE of that pool. ' +
    'True is an administrator having chosen it, so the pool is a decision. ' +
    'False is the system recording no such choice, so the pool is one ' +
    'middleware settled on by itself — and a pool nobody committed to must not ' +
    'be relied on to stay where it is. THIS TOOL DOES NOT READ THE SELECTION ' +
    'BEHAVIOUR BEHIND THAT and does not state where an automatic choice would ' +
    'move to or when; the caution follows from what a false records, not from ' +
    'anything measured here. A NULL `pool_set` IS NOT A FALSE — it is the ' +
    'system having reported no value this tool could read as a boolean, and ' +
    "reading it as \"nobody chose\" would report an administrator's decision as " +
    'an accident. ' +
    '`path` is where the system dataset is mounted, as the system spelled it. ' +
    'WHAT A NULL `path` MEANS COULD NOT BE ESTABLISHED. The API declares the ' +
    'field nullable and states nowhere what an explicit null indicates, and no ' +
    'live system was available to settle it. The two readings it might carry — ' +
    'the dataset is not currently mounted, or the system simply reported no ' +
    'path — are NOT distinguished by anything in this result, and this tool ' +
    'will not guess between them. Null also covers a value this tool could not ' +
    'read as text, which is not separated from the explicit null either. SO A ' +
    'NULL `path` IS NOT EVIDENCE that the system dataset is absent, that it is ' +
    'unmounted, or that the pool named above is free to export. ' +
    'EVERY FIELD IS NULL WHERE THE SYSTEM REPORTED NO VALUE THIS TOOL COULD ' +
    'READ, and a null is "this was not established" rather than a default — ' +
    'never a false, never an empty string. ' +
    "WHAT IS NOT REPORTED: middleware's own internal naming for the dataset. " +
    'The row id, the dataset basename and the dataset uuid are all declared by ' +
    'the API and all left out, because the surface states nothing about what ' +
    'either name names and a meaning read off a field name is a guess a caller ' +
    'could not tell from a reading. In particular NOTHING RETURNED HERE JOINS ' +
    'TO `storage_list_datasets`, whose `id` is a dataset id this tool does not ' +
    'report — the join this tool offers is the pool one, above. ' +
    'THIS TOOL ONLY READS. It does not move the system dataset to another pool ' +
    'and it does not list the pools it could be moved to; those are ' +
    '`systemdataset.update` and `systemdataset.pool_choices`, and neither is in ' +
    'this catalog. A configuration that could not be read at all is an error ' +
    'naming what the system said, not a result of nulls.',
  inputSchema: { type: 'object', properties: {} },
  requiredRole: Role.ReadOnly,
  mutating: false,
  async handler({ system }) {
    const answer = await firstValueFrom(system.client.api.call('systemdataset.config'));
    // Guarded rather than reached into, for the reason `system_general_config`
    // gives: a system answering with something that is not a configuration
    // would otherwise throw naming a property, and the caller would be shown
    // the name of a field rather than the read that failed.
    const config = recordOrNull(answer);
    if (config === null) {
      throw new Error('systemdataset.config did not answer with a system dataset configuration');
    }
    // Named one at a time, so a field a later TrueNAS release adds to this
    // payload does not appear in the result without a change here. Every one is
    // read through a guard even though the client declares all three required
    // or explicitly nullable, which is the #91 decision: a declared type is a
    // claim about what the middleware sends and not the value received.
    return {
      pool: textOrNull(config['pool']),
      // Beside `pool` rather than folded into it: the two are one fact and the
      // flag is what says whether the pool is a decision or a default.
      pool_set: booleanOrNull(config['pool_set']),
      path: textOrNull(config['path']),
    };
  },
};
