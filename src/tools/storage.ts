import type { CallParams } from '@truenas/api-client';
import { firstValueFrom } from 'rxjs';
import { Role } from '@/interfaces';
import { ApiSurface, MutatingTool, PlanStep, ReadOnlyTool, SystemHandle, ToolContext } from '@/catalog/tool';
import {
  agreement,
  booleanOrNull,
  errorText,
  numberOrNull,
  recordOrNull,
  refuseArgs,
  textList,
  textOrNull,
} from '@/tools/common';

/** A ZFS property as the middleware reports it. The client declares the property
 * object on the dataset fields it names, but types its `parsed` value `unknown`
 * — and the one property this file asks for that the client does NOT name
 * reaches it through the row's index signature as `unknown` outright. Either
 * way the value the tools surface has to be restated to be reached. */
interface ZfsProperty {
  parsed?: unknown;
}

/** Storage-health family: read-only inspection of pools and datasets. */

/**
 * Whether a pool's ZFS feature flags match what the running TrueNAS version
 * offers — read from wherever the system actually answered it.
 *
 * The question has two sources on the pinned surface, and they are the same
 * fact. A `pool.query` row declares `is_upgraded?: boolean`, OPTIONAL, so a
 * system may or may not send it; `pool.is_upgraded` is a separate verb taking
 * one pool id and answering a bare boolean. The row is read first and the verb
 * is called only where the row carried no boolean this file could read — #102's
 * rule that a reading both shapes satisfy is worth more than a guard written to
 * one of them, and #132's lazily-made fallback, since a supporting read nothing
 * needed should not be issued at all.
 *
 * **Null is "not established", and it is never read as either verdict.** A pool
 * reported current when the read failed understates a finding and the reverse
 * invents one, which is the direction #93 turns on. Several causes reach it and
 * this result separates none of them: a row carrying no readable flag beside no
 * readable pool id, so there was nothing to aim the verb at; a verb that
 * rejected; a verb that answered with something that is not a boolean; and a
 * verb whose observable completed without emitting at all, which `firstValueFrom`
 * raises as an error and this catch takes with the rest. The description says
 * what a null RULES OUT rather than enumerating a partition it does not have.
 *
 * **The rejection is caught here rather than reported.** `storage_pool_status`
 * is composed by `system_health_report` and, through it, by
 * `fleet_health_rollup`, so a flag this tool cannot read must not be able to
 * take down every other field of the catalog's most load-bearing read. The
 * reason text is dropped rather than carried in a companion field: #134's bar
 * is that a companion earns its place where the causes behind one null are ones
 * a caller would act on differently, and every cause above leaves the same
 * course of action — read the pool's flag some other way.
 */
async function featureFlagsCurrent(
  system: SystemHandle,
  id: unknown,
  stated: unknown,
): Promise<boolean | null> {
  const carried = booleanOrNull(stated);
  if (carried !== null) return carried;
  const poolId = numberOrNull(id);
  if (poolId === null) return null;
  try {
    const answer = await firstValueFrom(system.client.api.call('pool.is_upgraded', [poolId]));
    return booleanOrNull(answer);
  } catch {
    return null;
  }
}

export const poolStatus: ReadOnlyTool = {
  name: 'storage_pool_status',
  description:
    'Health and capacity of ZFS storage pools: status, whether the pool is ' +
    'healthy, and size/allocated/free in bytes. ' +
    "`feature_flags_current` is whether the pool's ZFS FEATURE FLAGS match " +
    'what the running TrueNAS version offers. True is a pool holding every ' +
    'feature this release has. False is a pool still on an older set, which ' +
    'keeps working — nothing fails, which is why an un-upgraded pool goes ' +
    'unnoticed — and simply never gets whatever the newer features were for. ' +
    "UPGRADING A POOL'S FEATURE FLAGS IS ONE-WAY AND CANNOT BE UNDONE. An " +
    'upgraded pool can no longer be read by an older ZFS, so upgrading it can ' +
    'PREVENT ROLLING THE SYSTEM BACK to an earlier TrueNAS version — which is ' +
    'why a false here is a fact to report and never a defect to fix ' +
    'implicitly. NOTHING IN THIS CATALOG UPGRADES A POOL: `pool.upgrade` is ' +
    'not a tool here, and the decision belongs to a person in the UI. ' +
    'A NULL `feature_flags_current` IS NOT A FALSE. Null is "this was not ' +
    'established", and SEVERAL causes reach it that this result separates ' +
    'NONE of: the system reported no flag on the pool row and no pool id to ' +
    'ask about separately, a separate read that was refused, a separate read ' +
    'that answered with something this tool could not take as a boolean, and ' +
    'any other way that read ended without producing one. What a null DOES ' +
    'rule out is that this tool read a boolean: it is not evidence that the ' +
    'pool is behind, and not evidence that it is current. ' +
    '`system_health_report` DOES NOT RAISE A FINDING FOR THIS, and its verdict ' +
    'says nothing about it either way: feature-flag currency is a ' +
    'configuration fact rather than a health problem. The system also reports ' +
    'it as a NOTICE-level `PoolUpgraded` alert, which `alerts_list` carries as ' +
    'prose — dismissed or not, since that tool includes dismissed alerts — for ' +
    'as long as the system raises it; this field is the same fact as a state ' +
    'per pool. A pool that is behind is therefore not a reason that report is ' +
    'anything other than OK, and this field is where the answer lives.',
  inputSchema: { type: 'object', properties: {} },
  requiredRole: Role.ReadOnly,
  mutating: false,
  async handler({ system }) {
    const pools = await firstValueFrom(system.client.api.query('pool.query'));
    // One read per pool whose row did not already carry the flag, and all of
    // them issued together — the listing is what supplies the ids, so the whole
    // fan-out costs one further round trip rather than one per pool.
    const current = await Promise.all(
      pools.map((pool) => featureFlagsCurrent(system, pool.id, pool.is_upgraded)),
    );
    return pools.map((pool, position) => ({
      name: pool.name,
      status: pool.status,
      healthy: pool.healthy,
      size_bytes: pool.size,
      allocated_bytes: pool.allocated,
      free_bytes: pool.free,
      feature_flags_current: current[position],
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
    'The same name is the `pool` field `storage_list_datasets` reports and the ' +
    'value its `pool` argument takes, so it narrows that listing to the ' +
    'datasets on the pool holding the system dataset — see below for what it ' +
    'does not do there. ' +
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
    'could not tell from a reading. In particular NOTHING HERE NAMES THE SYSTEM ' +
    'DATASET AS A DATASET: `storage_list_datasets` keys its rows by `id`, no ' +
    'dataset id is reported here, and so the system dataset cannot be picked ' +
    'out of that listing from this result. The `pool` above narrows that ' +
    'listing to the right pool and no further. ' +
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

/**
 * The most descendants `dataset_permissions` reports when asked for children.
 *
 * Each dataset reported costs TWO further middleware calls — `filesystem.stat`
 * and `filesystem.getacl` — so this is #155's question answered the other way
 * round: the opt-in flag is where the cost of walking children is decided, and
 * the cap is what stops an explicit yes on a pool holding hundreds of datasets
 * turning into hundreds of round trips. It is a constant rather than an
 * argument because the ticket asks for an opt-in and not for a bound, and the
 * bound that is actually applied comes back with the result as
 * `children_limit`, so a caller never has to infer which number was in force —
 * the same shape `snapshots_list` takes.
 *
 * Truncation drops a dataset whose permissions might have been the answer, so
 * `children_truncated` says outright that the list is incomplete and the
 * description says what a truncated list is not evidence of.
 */
const CHILDREN_LIMIT = 50;

/** What a section says when the dataset names no path to read from. */
const NO_MOUNTPOINT = 'the dataset reports no mountpoint, so there is no path to read';

/**
 * What a section says when the dataset names a mountpoint that is not a path.
 *
 * ZFS spells a filesystem that is not mounted anywhere `none`, and one mounted
 * by the operating system rather than by ZFS `legacy`. Neither is a path, so
 * neither is asked about — a call made with one would fail in the middleware
 * and report as a read that went wrong, when what actually happened is that
 * there was nothing to read. The value itself is still reported as `mountpoint`,
 * as the system spelled it.
 */
const MOUNTPOINT_NOT_A_PATH =
  'the dataset reports a mountpoint that is not an absolute path, so there is ' +
  'no path to read';

/** What `filesystem.stat` establishes about a mountpoint, or nulls. */
interface OwnershipSection {
  unavailable: string | null;
  uid: number | null;
  gid: number | null;
  user: string | null;
  group: string | null;
  mode_octal: string | null;
  is_mountpoint: boolean | null;
}

/** What `filesystem.getacl` establishes about a mountpoint, or nulls. */
interface AclSection {
  unavailable: string | null;
  acl_type: string | null;
  acl_beyond_mode: boolean | null;
}

/** One dataset's answer: what it is, where it is, and the two reads over it. */
interface DatasetPermissions {
  id: string | null;
  type: string | null;
  mountpoint: string | null;
  ownership: OwnershipSection;
  acl: AclSection;
}

/**
 * A section that was not read, carrying every field it promises as a null.
 *
 * `undefined` serializes to no key at all, so a caller would otherwise be
 * handed a shape it was never told about — `boot.ts`'s reason for spelling an
 * unread section's fields out rather than omitting them (#95).
 */
function unreadOwnership(reason: string): OwnershipSection {
  return {
    unavailable: reason,
    uid: null,
    gid: null,
    user: null,
    group: null,
    mode_octal: null,
    is_mountpoint: null,
  };
}

/** {@link unreadOwnership} for the ACL half. */
function unreadAcl(reason: string): AclSection {
  return { unavailable: reason, acl_type: null, acl_beyond_mode: null };
}

/**
 * The permission bits of a mode, as four octal digits, or null.
 *
 * FOUR digits rather than three, and the leading one is not padding: it carries
 * setuid, setgid and the sticky bit, and a setgid app directory reads `2770`
 * where an ordinary one reads `0770`. Both are permission bits and dropping the
 * first would report two different directories identically.
 *
 * The low twelve bits are taken and anything above them is not reported. Those
 * higher bits are the file type a POSIX `stat` carries in the same number, and
 * they are what would make a directory read as `40750` rather than `0750` —
 * `type` reports what the dataset is, separately and from the dataset's own row.
 * Masking is safe whichever the middleware sent: a number already holding only
 * permission bits is unchanged by it.
 *
 * A value that is not a whole number, that is negative, or that is larger than
 * a 32-bit mode can be is not a mode, and is null rather than masked — JavaScript's
 * bitwise operators truncate to 32 bits, so masking such a number would answer
 * with plausible-looking digits taken from the wrong end of it.
 */
function modeOctal(value: unknown): string | null {
  const raw = numberOrNull(value);
  if (raw === null || !Number.isInteger(raw) || raw < 0 || raw > 0xffffffff) return null;
  return (raw & 0o7777).toString(8).padStart(4, '0');
}

/**
 * Who owns a mountpoint and what its mode bits are, read from `filesystem.stat`.
 *
 * Every field is read through a guard by name even though the client declares
 * the whole payload: a declared type is a claim about what the middleware sends
 * and not the value received (#91), and here the direction the guards fail in
 * is the whole point — an unread mode is null and never a permissive default,
 * because a caller acts on a permission answer by writing to the dataset (#93).
 *
 * A read that fails becomes this section's `unavailable` rather than the tool's
 * error: the ACL read below is a separate call that fails separately, and a
 * dataset whose ownership could not be read still has an ACL type worth
 * reporting (#95).
 */
async function ownershipOf(system: SystemHandle, path: string): Promise<OwnershipSection> {
  try {
    const answer = await firstValueFrom(system.client.api.call('filesystem.stat', [path]));
    const stat = recordOrNull(answer);
    if (stat === null) return unreadOwnership('filesystem.stat did not answer with a record');
    return {
      unavailable: null,
      uid: numberOrNull(stat['uid']),
      // Read on its own and never derived from the uid: a TrueNAS local user
      // made for an app is routinely uid 3100 with gid 3003, which is the
      // mistake this tool exists to make visible.
      gid: numberOrNull(stat['gid']),
      user: textOrNull(stat['user']),
      group: textOrNull(stat['group']),
      mode_octal: modeOctal(stat['mode']),
      // What qualifies everything above it. A dataset that is not mounted still
      // has a directory sitting at its mountpoint path, and a `stat` of that
      // path answers about the directory rather than about the dataset — the
      // two are indistinguishable in the fields above.
      is_mountpoint: booleanOrNull(stat['is_mountpoint']),
    };
  } catch (reason) {
    return unreadOwnership(errorText(reason));
  }
}

/**
 * Which kind of ACL a mountpoint carries, and whether it says anything the mode
 * bits do not.
 *
 * `acl_type` is the system's own word, passed through exactly as spelled and
 * mapped onto nothing — the vocabulary is the middleware's, and a second
 * account of it written here is the drift `common.ts` was cut to stop (#126).
 *
 * `acl_beyond_mode` is the ACL read's own `trivial`, negated. A trivial ACL is
 * one the mode bits already express in full, so its negation is exactly the
 * question the ticket asks: does this dataset carry an ACL beyond its mode. It
 * is null and never false wherever nothing was read, because false is the
 * positive claim that the mode bits are the whole story — which a caller acts
 * on by trying to change them (#93).
 *
 * `filesystem.stat` ALSO carries a boolean named `acl`, and this tool does not
 * report it: the surface declares the field and states nowhere what it means,
 * and reporting a guessed meaning is worse than omitting the field because a
 * caller cannot tell a reading from a guess (#102). The answer here comes from
 * the ACL read's own `trivial`, which the ACL vocabulary does define. The ACL's
 * own `uid`, `gid`, `user` and `group` are left out for the other reason: they
 * are the same fact the ownership section already reports, and one fact gets
 * one derivation (#122).
 */
async function aclOf(system: SystemHandle, path: string): Promise<AclSection> {
  try {
    const answer = await firstValueFrom(system.client.api.call('filesystem.getacl', [path]));
    const acl = recordOrNull(answer);
    if (acl === null) return unreadAcl('filesystem.getacl did not answer with a record');
    const trivial = booleanOrNull(acl['trivial']);
    return {
      unavailable: null,
      acl_type: textOrNull(acl['acltype']),
      acl_beyond_mode: trivial === null ? null : !trivial,
    };
  } catch (reason) {
    return unreadAcl(errorText(reason));
  }
}

/**
 * A dataset row's id, or the empty string where the system reported none this
 * file could read.
 *
 * The empty string is a sentinel for matching and ordering ONLY, and never
 * reaches a result: `id` there is read through `textOrNull` and stays null. It
 * matches no descendant prefix, so a row naming no dataset sorts out of the
 * children rather than into them.
 */
function datasetId(row: Record<string, unknown>): string {
  return textOrNull(row['id']) ?? '';
}

/**
 * One dataset row turned into its permissions answer.
 *
 * A dataset naming no path to read is criterion 8 rather than a failure: a
 * volume has no mountpoint at all, and a filesystem can name `none` or
 * `legacy`. Both answer with the fact — `mountpoint` as the system spelled it,
 * and both sections saying why nothing was read — and neither throws. `type`
 * is what tells a volume apart from a filesystem that is simply not mounted.
 *
 * The two reads go out together: they are independent calls over one path, so
 * nothing is gained by serialising them.
 */
async function permissionsOf(
  system: SystemHandle,
  row: Record<string, unknown>,
): Promise<DatasetPermissions> {
  const id = textOrNull(row['id']);
  const type = textOrNull(row['type']);
  const mountpoint = textOrNull(row['mountpoint']);
  const path = mountpoint !== null && mountpoint.startsWith('/') ? mountpoint : null;
  if (path === null) {
    const reason = mountpoint === null ? NO_MOUNTPOINT : MOUNTPOINT_NOT_A_PATH;
    return { id, type, mountpoint, ownership: unreadOwnership(reason), acl: unreadAcl(reason) };
  }
  const [ownership, acl] = await Promise.all([ownershipOf(system, path), aclOf(system, path)]);
  return { id, type, mountpoint, ownership, acl };
}

/**
 * The interpretation half of this tool's description (#131), hoisted so the two
 * fields cannot drift: `description` is this text appended to the selection
 * half, and `resultGuidance` is this text.
 *
 * It carries one sentence that is selection class by `resultGuidance`'s own
 * rule — the pointer at `storage_list_datasets` for the `id` these rows join
 * on. A cross-tool pointer tells a caller where the other half of an answer
 * lives, which is worth knowing before the call, so the follow-up that stops
 * appending this to `description` must leave that one in place.
 */
const DATASET_PERMISSIONS_RESULT_GUIDANCE =
  '`dataset` is the dataset that was asked about. `children` is every dataset ' +
  'beneath it — at ANY depth, not just its immediate children — and is NULL ' +
  'rather than empty when `include_children` was not asked for. ' +
  '`children_limit` is the cap that was applied and `children_truncated` says ' +
  'whether it was reached; all three are null when children were not asked ' +
  'for. A TRUNCATED LIST IS NOT EVIDENCE ABOUT THE DATASETS MISSING FROM IT — ' +
  'the descendants are ordered by id and the ones past the cap were never ' +
  'read. A DESCENDANT WHOSE OWN ID COULD NOT BE READ IS LEFT OUT AND COUNTED ' +
  'NOWHERE: nothing establishes that such a row is beneath this dataset, it ' +
  'does not reach `children`, and it does NOT set `children_truncated`. So an ' +
  'empty list rules out only that this tool matched a descendant — it is not ' +
  'proof that the dataset has none. ' +
  '`id` is the dataset id, and it is the same `id` `storage_list_datasets` ' +
  'reports. `type` is what the dataset is, as the system spelled it. ' +
  '`mountpoint` is the path the permissions below were read FROM, as the ' +
  'system spelled it. ' +
  '`ownership` and `acl` ARE TWO SEPARATE READS OF THAT PATH AND THEY FAIL ' +
  'SEPARATELY. Each carries its own `unavailable`: null means the read was ' +
  'made, and any other value is why it was not, in which case EVERY OTHER ' +
  'FIELD OF THAT SECTION IS NULL. A dataset that names no path to read — a ' +
  'volume, or a filesystem whose mountpoint is `none` or `legacy` — has both ' +
  'sections unavailable saying so, and that is an answer rather than a ' +
  'failure; `type` is what tells a volume apart from an unmounted filesystem. ' +
  '`uid` and `gid` are the numeric owner and owning group. THE GID IS READ ON ' +
  'ITS OWN AND IS NEVER DERIVED FROM THE UID: they routinely differ, and a ' +
  'TrueNAS local user created for an app can be uid 3100 with gid 3003. ' +
  '`user` and `group` are the names the system resolved those numbers to. A ' +
  'NULL NAME BESIDE A NUMBER IS NOT A MISSING OWNER — the number is the owner, ' +
  'and the name is null both where no account or group on the system answers ' +
  'to that number and where the system reported no name this tool could read, ' +
  'which are NOT separated here. A null NUMBER is the separate case that the ' +
  'read did not establish an owner at all, and it says nothing about who owns ' +
  'the path. ' +
  '`mode_octal` is the permission bits as FOUR octal digits, so `0700` and ' +
  '`0750` are distinguishable at a glance. The leading digit is not padding: ' +
  'it carries setuid, setgid and the sticky bit, so a setgid directory reads ' +
  '`2770`. THE FILE-TYPE BITS A POSIX `stat` CARRIES IN THE SAME NUMBER ARE ' +
  'NOT REPORTED — what the dataset is, is `type`. ' +
  '`is_mountpoint` QUALIFIES BOTH SECTIONS, not just the one it sits in. False ' +
  'means the path was read but is not a mount point, so everything reported ' +
  'from it is THE DIRECTORY SITTING AT THAT PATH rather than the root of the ' +
  'dataset — which is what an unmounted dataset looks like from here, and is ' +
  'otherwise indistinguishable from a mounted one. THAT REACHES THE ACL ' +
  'ANSWER TOO: the ACL is read from the same path, so `acl_type` and ' +
  '`acl_beyond_mode` beside a false here describe that directory and not the ' +
  'dataset. Null is not a false: it is the system having reported no value ' +
  'this tool could read, and it is not evidence either way — including about ' +
  'the ACL. ' +
  '`acl_type` is the system\'s OWN WORD for the kind of ACL, passed through ' +
  'exactly as spelled and mapped onto nothing. At the time of writing the ' +
  'surface names `NFS4`, `POSIX1E` and `DISABLED`; a word not among those is ' +
  'still reported as it arrived rather than being translated or dropped. ' +
  '`acl_beyond_mode` is whether the path carries an ACL saying anything the ' +
  'mode bits do not. False means the mode bits are the whole story. A NULL IS ' +
  'NEVER A FALSE: it is "this was not established", and reading it as false ' +
  'would report an unread ACL as an absent one. ' +
  'NO NULL IN THIS RESULT IS A PERMISSIVE ANSWER. Every field is null where ' +
  'nothing was read, and a null mode is not `0777`, a null `acl_beyond_mode` ' +
  'is not "no ACL", and a null owner name is not "unowned". ' +
  'WHAT IS NOT REPORTED, all of it deliberately: the ACL ENTRIES themselves — ' +
  'this tool reports which kind of ACL is in force and whether one is there, ' +
  'and never who it grants what; the `acl` boolean `filesystem.stat` also ' +
  'carries, because the surface states nowhere what it means and the answer ' +
  'above comes from the ACL read\'s own `trivial` instead; the owner fields ' +
  'the ACL read repeats, since `ownership` is the one derivation of those; and ' +
  "the dataset's own `acltype` and `aclmode` ZFS PROPERTIES, which are the " +
  'dataset\'s configuration rather than what the path actually reports. ' +
  'Nothing here says the times, size, inode or ZFS attributes of the path.';

/**
 * Who owns a dataset's mountpoint, what its mode bits are, and which kind of
 * ACL it carries.
 *
 * Permissions are where self-hosted deployments on TrueNAS fail, and the
 * failure never names itself: a container that cannot read its own directory
 * reports something else entirely. Three facts decide most of them — the owner
 * uid and gid, the mode bits, and whether an ACL is in force beyond those bits
 * — and none of them was readable through this catalog. `storage_list_datasets`
 * reports space and mountpoints, which says nothing about any of it.
 *
 * **Both halves of the question are on the pinned surface, checked before
 * anything was designed around them.** `filesystem.stat` and
 * `filesystem.getacl` are both declared on `ApiCallDirectoryBase`, so neither
 * is #133's shape — unlike `filesystem.file_tail_follow` next door (#72), there
 * is nothing here that a tool in this repository could not compose.
 *
 * **The two reads are two sections and they fail separately** (#95). A
 * `getacl` that rejects must not take the ownership down with it: a caller
 * holding uid, gid and mode still has most of what it came for, and a caller
 * holding neither needs to be told which read went wrong.
 *
 * **Every unreadable field runs in the same direction, and that is the whole
 * safety argument.** A permission answer is acted on by WRITING — a mode
 * reported as `0777` that was never read invites a caller to leave it alone; an
 * `acl_beyond_mode` reported false that was never read invites a `chmod` the
 * system will refuse. So every one of them is null, and the description says
 * outright that no null here is a permissive answer (#93).
 *
 * **`is_mountpoint` is a companion field under #134's bar rather than an extra
 * fact.** A dataset that is not mounted still has a directory at its mountpoint
 * path, and `filesystem.stat` of that path answers about the directory: the
 * uid, gid and mode come back looking exactly like an answer about the dataset.
 * The two causes are ones a caller acts on differently — one is the dataset's
 * own root and the other is not the dataset at all — and nothing else in the
 * result separates them, which is exactly when a companion earns its place.
 *
 * **Children are opt-in because of where the cost lands** (#155). Each dataset
 * reported costs two further calls, and a pool can hold hundreds; the flag
 * defaults false, and an explicit yes is capped by {@link CHILDREN_LIMIT} with
 * the cap and whether it was reached both reported. The argument-not-passed
 * cause of a null `children` gets no companion field: the caller set the flag
 * itself and already knows.
 *
 * **A dataset that does not exist is an error naming it** (criterion 7), and
 * the existence check reads the response rather than the row count — an
 * unrecognised query parameter is dropped rather than refused, so a filter that
 * did not apply comes back as every dataset on the system and a count would
 * read that as "it exists" for any name at all (#153, #121).
 */
export const datasetPermissions: ReadOnlyTool = {
  name: 'dataset_permissions',
  description:
    "Who owns a dataset's mountpoint, what its permission bits are, and which " +
    'kind of ACL it carries — the three facts that decide whether a service ' +
    'running as a given uid can actually read and write there, without needing ' +
    'a shell. `storage_list_datasets` reports space and mountpoints and says ' +
    'nothing about any of this. ' +
    'Takes ONE dataset, named by the `id` `storage_list_datasets` reports, e.g. ' +
    '"tank/apps/postgres". A DATASET THAT DOES NOT EXIST IS AN ERROR NAMING ' +
    'IT, never an empty result: a dataset that is not there and a dataset ' +
    'nobody can write to are opposite answers. ' +
    'THE DATASET\'S OWN MOUNTPOINT IS THE UNIT. This tool does not report the ' +
    'permissions of arbitrary paths inside a dataset, and a file written under ' +
    'the mountpoint can be owned by someone else entirely. ' +
    '`include_children` also reports every dataset beneath it, and defaults ' +
    'FALSE because each dataset reported costs two further reads on the system ' +
    'being asked. When it is given, at most a fixed number of descendants are ' +
    'reported and the result says which number and whether it was reached. ' +
    'THIS TOOL ONLY READS. It does not change ownership, permissions or ACLs, ' +
    'and NO TOOL IN THIS CATALOG DOES — `filesystem.chown`, `filesystem.setperm` ' +
    'and `filesystem.setacl` are not tools here, and a change belongs to a ' +
    'person in the UI or a shell. ' +
    'IT ALSO STATES NO VERDICT. Whether a mode or an owner is CORRECT for a ' +
    'given application is the caller\'s judgement; this tool reports what is ' +
    'there. In particular it does NOT say whether a `chmod` would be accepted: ' +
    "that depends on the dataset's `aclmode` property, which this tool does " +
    'not report and nothing in this catalog does — so an NFSv4 ACL reported ' +
    'here is a reason to check, not a proof that the mode is fixed. Share-level ' +
    'permissions are a different question again and `share_access` is what ' +
    'answers it. ' +
    DATASET_PERMISSIONS_RESULT_GUIDANCE,
  resultGuidance: DATASET_PERMISSIONS_RESULT_GUIDANCE,
  inputSchema: {
    type: 'object',
    properties: {
      dataset: {
        type: 'string',
        description:
          'The dataset to report on, by the `id` `storage_list_datasets` ' +
          'reports, e.g. "tank/apps/postgres".',
      },
      include_children: {
        type: 'boolean',
        description:
          'Also report every dataset beneath it, at any depth. Default false. ' +
          'Each dataset reported costs two further reads on the system, so ' +
          'the number of descendants reported is capped; the cap and whether ' +
          'it was reached come back with the result.',
      },
    },
    required: ['dataset'],
  },
  requiredRole: Role.ReadOnly,
  mutating: false,
  async handler({ system }, args) {
    const dataset = args['dataset'];
    if (typeof dataset !== 'string' || dataset.length === 0) {
      throw new Error('"dataset" is required');
    }
    // Strict rather than coerced: a truthy string quietly read as true would
    // walk a whole pool's descendants on a caller that asked for one dataset.
    const requested = args['include_children'];
    if (requested != null && typeof requested !== 'boolean') {
      throw new Error('"include_children" must be a boolean');
    }
    const wantChildren = requested === true;
    // THE TWO READS DIFFER IN `retrieve_children`, AND THAT IS THE WHOLE
    // DIFFERENCE BETWEEN THEM.
    //
    // `retrieve_children` is what makes the middleware WALK the dataset tree,
    // and the flat list of every dataset is the product of that walk — which is
    // why `storage_list_datasets`, `datasets_quota_report` and
    // `reporting_space_trends` all pass true and are the three reads in this
    // repository that need every dataset. The one call that passes false is
    // `snapshots.ts`'s existence read, which names its dataset in the filter and
    // so wants no walk at all.
    //
    // Both shapes are needed here and for those same two reasons: asking about
    // one dataset is the second, and the descendants below are the first. A
    // single read with the walk off would rely on an unfiltered query answering
    // with more than the pool roots, which is the claim those three call sites
    // are evidence against.
    //
    // Filter and options are inlined so the call's own parameter types apply:
    // written to a `const` first the filter widens to string[][] and no longer
    // satisfies the filter tuple, as the two tools above note.
    //
    // `properties` is empty because this tool reads no ZFS property. `id`,
    // `type` and `mountpoint` are declared as fields of the entry itself rather
    // than as the `PoolDatasetEntryProperty` objects this list selects among, so
    // nothing the mapping reads is narrowed away by it.
    const rows = await firstValueFrom(
      wantChildren
        ? system.client.api.query('pool.dataset.query', [], {
            extra: { retrieve_children: true, properties: [] },
          })
        : system.client.api.query('pool.dataset.query', [['id', '=', dataset]], {
            extra: { retrieve_children: false, properties: [] },
          }),
    );
    // The filter is bandwidth and this is the control: an unrecognised query
    // parameter is dropped rather than refused, so a filter that did not apply
    // comes back as the whole table — which a row count would read as "the
    // dataset exists" for any name at all, and whose first row is some other
    // dataset entirely (#121, #153).
    const named = rows.find((row) => textOrNull(row['id']) === dataset);
    if (named === undefined) {
      throw new Error(`Dataset "${dataset}" does not exist`);
    }
    // Descendants are matched on the id prefix, which is what a ZFS dataset id
    // IS — a parent's name followed by "/". Matched here rather than asked for:
    // the check on the response is the control either way (#121, #153), so
    // there is nothing a filter could add.
    //
    // TOP-LEVEL ROWS ONLY, as in the two tools above: every dataset is already
    // one, and each additionally nests its descendants under `children`, so
    // walking those would report every descendant twice or more.
    //
    // A row whose id could not be read is not matched: it names no dataset, so
    // nothing establishes that it is beneath this one, and including it would
    // put a row in `children` the caller cannot tell from a sibling of the same
    // shape. It then leaves no trace in the result — the guidance says so
    // rather than letting an empty list read as "no descendants" (#98).
    const descendants = wantChildren
      ? rows
          .filter((row) => datasetId(row).startsWith(`${dataset}/`))
          .sort((left, right) => datasetId(left).localeCompare(datasetId(right)))
      : [];
    const reported = descendants.slice(0, CHILDREN_LIMIT);
    const [self, children] = await Promise.all([
      permissionsOf(system, named),
      Promise.all(reported.map((row) => permissionsOf(system, row))),
    ]);
    return {
      dataset: self,
      // Null rather than an empty list where the caller did not ask, so an
      // empty list keeps a meaning of its own: this tool matched no descendant.
      // That is weaker than "the dataset has none" — a row whose id could not
      // be read was dropped above — and the guidance says which.
      children: wantChildren ? children : null,
      children_limit: wantChildren ? CHILDREN_LIMIT : null,
      // A true here is read off a listing that was itself read in full — the
      // dataset query either answered or took the whole tool down — so a false
      // is never a read that went wrong reporting completeness. What it does
      // NOT cover is a descendant whose id could not be read, which is dropped
      // before this count is taken; the guidance names that separately.
      children_truncated: wantChildren ? descendants.length > reported.length : null,
    };
  },
};

/** The two limits `dataset_set_quota` sets, by the argument that names each. */
const QUOTA_ARGS = { quota: 'quota_bytes', refquota: 'refquota_bytes' } as const;

type QuotaKind = keyof typeof QUOTA_ARGS;

/**
 * What `dataset_set_quota` was asked to do. A limit not passed is absent, never
 * null: null is a value the caller sends, and it means "no limit" exactly as `0`
 * does — the client types both fields `number | (0 | null)` on the update.
 */
interface QuotaRequest {
  dataset: string;
  limits: Partial<Record<QuotaKind, number | null>>;
}

function parseQuotaRequest(args: Record<string, unknown>): QuotaRequest {
  const dataset = args['dataset'];
  if (typeof dataset !== 'string' || dataset === '') {
    throw new Error('"dataset" is required and must be a dataset name, such as "tank/media"');
  }
  const limits: QuotaRequest['limits'] = {};
  for (const kind of Object.keys(QUOTA_ARGS) as QuotaKind[]) {
    const key = QUOTA_ARGS[kind];
    const value = args[key];
    if (value === undefined) continue;
    if (value !== null && (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)) {
      throw new Error(`"${key}" must be a whole number of bytes, 0 or more, or null`);
    }
    limits[kind] = value;
  }
  if (Object.keys(limits).length === 0) {
    throw new Error('Nothing to change: pass at least one of quota_bytes, refquota_bytes');
  }
  return { dataset, limits };
}

/**
 * The update's params, typed off the call (#91) and built in one place, so the
 * plan step names exactly the call `execute` makes.
 */
function quotaUpdateParams(request: QuotaRequest): CallParams<ApiSurface, 'pool.dataset.update'> {
  return [request.dataset, { ...request.limits }];
}

/** The arguments as passed, under their own names, for the confirmation token and the result. */
function quotaArgs(limits: QuotaRequest['limits']): Record<string, number | null> {
  return Object.fromEntries(
    (Object.keys(limits) as QuotaKind[]).map((kind) => [QUOTA_ARGS[kind], limits[kind] ?? null]),
  );
}

const BYTE_UNITS = ['KiB', 'MiB', 'GiB', 'TiB', 'PiB', 'EiB'];

/**
 * A byte count as the plan states it: the exact number, then the same size in
 * binary units so an approver does not have to count digits. The exact number
 * comes first because it is what is sent; the rendering is marked "about"
 * wherever rounding it to two places changed it.
 */
function bytesText(bytes: number): string {
  const exact = `${bytes} ${bytes === 1 ? 'byte' : 'bytes'}`;
  if (bytes < 1024) return exact;
  let value = bytes;
  let unit = -1;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = Number(value.toFixed(2));
  const approximate = rounded * 1024 ** (unit + 1) === bytes ? '' : 'about ';
  return `${exact} (${approximate}${rounded} ${BYTE_UNITS[unit]})`;
}

/** A limit as {@link quotaLimit} reads it, in words: `0` is no limit, null unreadable. */
function limitText(limit: number | null): string {
  if (limit === null) return 'a value that could not be read';
  return limit === 0 ? 'no limit' : bytesText(limit);
}

/** What each limit caps, in `datasets_quota_report`'s own words, and the usage read beside it. */
const QUOTA_CAPS: Record<QuotaKind, { caps: string; usage: 'used' | 'referenced' }> = {
  quota: { caps: '`used`, the dataset together with its descendants and snapshots', usage: 'used' },
  refquota: { caps: '`referenced`, the data the dataset itself holds alone', usage: 'referenced' },
};

/**
 * Where ZFS's own refusal of a limit below usage is read from. It is not on the
 * API surface, so every sentence that relies on it says so.
 */
const BELOW_USAGE_SOURCE = 'read from the OpenZFS implementation, not from this API surface';

/**
 * One limit's sentence in the plan: what it caps, what it is now, what it will
 * be, and the usage it caps.
 *
 * **A limit BELOW current usage fails the plan**, because ZFS refuses it: the
 * quota and refquota set-checks answer `ENOSPC` for a new value under `used` or
 * `referenced` respectively. That is #161's rule — a plan-time refusal is owed
 * where the middleware refuses — and the ticket's premise that ZFS accepts such
 * a limit was wrong. A limit EQUAL to usage is accepted and leaves no room, so
 * it is warned about: that is the "stop a runaway writer" case, and it is the
 * one thing an approver must not miss. Where the usage could not be read the
 * plan says the comparison was not made rather than staying silent, since
 * silence reads as "there is room".
 */
function limitSentence(
  dataset: string,
  kind: QuotaKind,
  sent: number | null,
  row: Record<string, unknown>,
): string {
  const { caps, usage } = QUOTA_CAPS[kind];
  const current = quotaLimit(row[kind]);
  const used = propertyBytes(row[usage]);
  const wanted = sent ?? 0;
  if (wanted > 0 && used !== null && wanted < used) {
    throw new Error(
      `The new ${kind} for dataset "${dataset}", ${bytesText(wanted)}, is below its current \`${usage}\` ` +
        `of ${bytesText(used)}, and ZFS refuses a ${kind} below what the dataset already holds ` +
        `(${BELOW_USAGE_SOURCE}). To stop further writes, set it to the current \`${usage}\` or above`,
    );
  }
  const spelled = sent === null ? 'null' : String(sent);
  const usageText = used === null ? `its current \`${usage}\` could not be read` : `it currently has ${bytesText(used)} \`${usage}\``;
  let effect = '';
  if (current === wanted) {
    effect = ' It already holds that limit, so this changes nothing for it and is not an error.';
  }
  if (wanted > 0 && used === null) {
    effect +=
      ` ZFS refuses a ${kind} below what the dataset already holds (${BELOW_USAGE_SOURCE}), and that ` +
      'usage could not be read, so the call may be rejected.';
  } else if (wanted > 0 && wanted === used) {
    effect +=
      ` THE NEW ${kind.toUpperCase()} IS EXACTLY WHAT THE DATASET ALREADY HOLDS, SO WRITES THAT ADD ` +
      `TO ITS \`${usage}\` WILL FAIL` +
      `${kind === 'quota' ? ', in the dataset and in every descendant,' : ''} until space is freed or ` +
      'the limit is raised. If the dataset has grown by the time this is confirmed, ZFS refuses ' +
      `the change instead (${BELOW_USAGE_SOURCE}).`;
  }
  return (
    ` \`${kind}\` (caps ${caps}): now ${limitText(current)}; will be ` +
    `${wanted === 0 ? `no limit (sent as ${spelled})` : bytesText(wanted)}; ${usageText}.${effect}`
  );
}

/**
 * The options a one-dataset read is sent with: named by id, so the walk is off —
 * `snapshots.ts`'s existence read — and only the properties the caller reports.
 * One function for the read and for any plan step naming it, so the two cannot
 * drift apart.
 */
function datasetReadOptions(properties: string[]): { extra: Record<string, unknown> } {
  return { extra: { retrieve_children: false, properties } };
}

/**
 * The one dataset named, matched by id on the response (#153), or null where
 * the system listed none that was. A failed read rejects.
 */
async function datasetRow(
  ctx: ToolContext,
  dataset: string,
  properties: string[],
): Promise<Record<string, unknown> | null> {
  const rows = await firstValueFrom(
    // The filter is inlined so the call's own parameter types apply, as above.
    ctx.system.client.api.query('pool.dataset.query', [['id', '=', dataset]], datasetReadOptions(properties)),
  );
  return rows.map(recordOrNull).find((held) => held !== null && textOrNull(held['id']) === dataset) ?? null;
}

/**
 * The dataset row as a plan reads it, failing the plan where it could not be
 * read or is not there.
 */
async function readPlannedDataset(
  ctx: ToolContext,
  dataset: string,
  properties: string[],
): Promise<Record<string, unknown>> {
  let row: Record<string, unknown> | null;
  try {
    row = await datasetRow(ctx, dataset, properties);
  } catch (reason) {
    throw new Error(
      `Dataset "${dataset}" could not be read (pool.dataset.query failed: ${errorText(reason)}), so nothing is planned`,
    );
  }
  if (row === null) {
    throw new Error(
      `Dataset "${dataset}" does not exist on this system — \`storage_list_datasets\` reports each ` +
        "dataset's `id`, which is the name this takes",
    );
  }
  return row;
}

const DATASET_SET_QUOTA_GUIDANCE =
  '`dataset` is the dataset named. `requested` is exactly what was passed, under the ' +
  "arguments' own names. `quota_bytes` and `refquota_bytes` are both limits as the " +
  'response the update itself answered with states them — never copied from the request ' +
  '— read the way `datasets_quota_report` reads them: `0` is no limit of that kind, and ' +
  'null is a limit that could not be read, which is NOT "no limit". Both are reported ' +
  'whichever was sent. `used_bytes` and `referenced_bytes` are the usage each limit caps, ' +
  'off the same response, and null where it carried no value this tool could read; ' +
  '`referenced` is not a field the API declares, so a null there is ordinary and is not ' +
  'evidence of anything about the dataset. `confirmed` is whether every limit sent reads ' +
  'back as sent, a null sent comparing as `0`: true is the system reporting back what was ' +
  'asked for; FALSE IS NOT A SUCCESS — the call did not reject and a limit was stored as ' +
  'something else; and null is a response in which a limit sent could not be read back ' +
  'and none read back as different.';

export const datasetSetQuota: MutatingTool = {
  name: 'dataset_set_quota',
  description:
    "Sets, changes or removes one ZFS dataset's `quota`, its `refquota`, or both, on " +
    'this TrueNAS system. Two-phase: called without a confirmation_token it returns a plan ' +
    'for user approval; called with one it sends the change. `dataset` is the dataset\'s ' +
    'full name, as `storage_list_datasets` and `datasets_quota_report` report it in `id`; ' +
    'a name the system does not list fails the plan, naming it. `quota_bytes` and ' +
    '`refquota_bytes` are limits in bytes, and at least one is required; ONLY THE LIMITS ' +
    'PASSED ARE SENT. `0` and null both REMOVE that limit. The two limits cap different ' +
    'things, as `datasets_quota_report` describes: `quota` caps `used`, the dataset with ' +
    'its descendants and snapshots, and `refquota` caps `referenced`, the data the dataset ' +
    'itself holds alone. THE PLAN STATES EACH LIMIT AS IT IS NOW, AS IT WILL BE, AND THE ' +
    'USAGE IT CAPS, in bytes and in binary units, so wherever the current limit could be ' +
    'read the call that undoes this is in the plan. A VOLUME FAILS THE PLAN: `quota` and ' +
    '`refquota` are filesystem properties, and a dataset whose type could not be read is ' +
    'planned with a sentence saying the call may be rejected. A LIMIT BELOW THE USAGE IT ' +
    'CAPS FAILS THE PLAN, naming both, because ZFS refuses one (read from the OpenZFS ' +
    'implementation, not from this API surface); where that usage could not be read, the ' +
    'plan says instead that the call may be rejected. A LIMIT EXACTLY AT THAT USAGE IS ACCEPTED ' +
    'AND THE PLAN SAYS WRITES WILL THEN FAIL — that is how a quota stops a runaway writer. ' +
    "ZFS also refuses a `quota` below the dataset's reservation, and a `refquota` below its " +
    'refreservation, neither of which this tool reads; the call is then rejected. The ' +
    'current values are read when the plan is made and not ' +
    'again, so a dataset that grows before confirmation can still have the change ' +
    'refused. Setting a limit the dataset already holds is not an error, unless its usage ' +
    'has already passed that limit, which fails the plan as above. This tool does ' +
    'not set the quota warning or critical alert thresholds, per-user or per-group ' +
    "quotas, reservations, or a volume's size. `destructiveness` is `reversible`: nothing " +
    'is deleted, and sending back the old values the plan names puts the limits back — ' +
    'BUT ONLY WHILE THE USAGE EACH CAPS IS STILL AT OR BELOW THE OLD VALUE. A dataset that ' +
    'grows past an old limit after it was raised or removed cannot be given it back, by ' +
    'this tool or by ZFS. ' +
    DATASET_SET_QUOTA_GUIDANCE,
  resultGuidance: DATASET_SET_QUOTA_GUIDANCE,
  inputSchema: {
    type: 'object',
    properties: {
      dataset: {
        type: 'string',
        description: 'The dataset\'s full name, e.g. "tank/media", as `storage_list_datasets` reports it in `id`.',
      },
      quota_bytes: {
        oneOf: [{ type: 'integer', minimum: 0 }, { type: 'null' }],
        description:
          'The new `quota`, in bytes: caps the dataset with its descendants and snapshots. 0 or null removes it.',
      },
      refquota_bytes: {
        oneOf: [{ type: 'integer', minimum: 0 }, { type: 'null' }],
        description: 'The new `refquota`, in bytes: caps the data the dataset itself holds. 0 or null removes it.',
      },
    },
    // "At least one limit" is enforced by the parse, as every sibling update
    // tool's "at least one field" is: a combinator at the root of a tool's
    // input schema is refused by some hosts, which would take down the whole
    // catalog rather than this tool.
    required: ['dataset'],
  },
  requiredRole: Role.Full,
  mutating: true,
  // Two numbers on one dataset, and the plan names the values to send back.
  // A limit at usage stops writes and deletes nothing.
  destructiveness: 'reversible',
  normalizeArgs(rawArgs) {
    const { dataset, limits } = parseQuotaRequest(rawArgs);
    return { dataset, ...quotaArgs(limits) };
  },
  async plan(ctx, rawArgs): Promise<PlanStep[]> {
    const request = parseQuotaRequest(rawArgs);
    const { dataset, limits } = request;
    // The four properties are `datasets_quota_report`'s.
    const row = await readPlannedDataset(ctx, dataset, ['used', 'referenced', 'quota', 'refquota']);
    // The middleware refuses these limits on a volume, so the plan does too
    // (#161). An unreadable type does not refuse anything (#154); it is stated.
    const type = textOrNull(row['type']);
    if (type === 'VOLUME') {
      throw new Error(
        `Dataset "${dataset}" is a volume, and \`quota\` and \`refquota\` are filesystem properties ` +
          "that ZFS does not set on one — a volume's size is its `volsize`, which this tool does not change",
      );
    }
    const typeNote =
      type === null
        ? ' Whether this dataset is a filesystem could not be read; ZFS does not set these limits on a ' +
          'volume, so the call may be rejected.'
        : '';
    const sentences = (Object.keys(limits) as QuotaKind[])
      .map((kind) => limitSentence(dataset, kind, limits[kind] ?? null, row))
      .join('');
    return [
      {
        method: 'pool.dataset.update',
        params: quotaUpdateParams(request),
        description:
          `Set limits on dataset "${dataset}". Only ${Object.keys(limits).join(' and ')} ` +
          `${Object.keys(limits).length === 1 ? 'is' : 'are'} sent.${typeNote}${sentences} The current values ` +
          'and usage were read when this plan was made and are not read again.',
      },
    ];
  },
  async execute(ctx, rawArgs) {
    const request = parseQuotaRequest(rawArgs);
    const { dataset, limits } = request;
    const updated: unknown = await firstValueFrom(
      ctx.system.client.api.call('pool.dataset.update', quotaUpdateParams(request)),
    );
    // The update answers with the updated dataset, so the limits are read off
    // that rather than echoed from the request (#121), through the same reading
    // `datasets_quota_report` gives them.
    const held = recordOrNull(updated);
    const quota = held === null ? null : quotaLimit(held['quota']);
    const refquota = held === null ? null : quotaLimit(held['refquota']);
    const sent = Object.fromEntries(
      (Object.keys(limits) as QuotaKind[]).map((kind) => [kind, limits[kind] ?? 0]),
    );
    return {
      dataset,
      requested: quotaArgs(limits),
      quota_bytes: quota,
      used_bytes: held === null ? null : propertyBytes(held['used']),
      refquota_bytes: refquota,
      referenced_bytes: held === null ? null : propertyBytes(held['referenced']),
      confirmed: agreement(sent, { quota, refquota }),
    };
  },
};

/** The update's data argument, typed off the call (#91). */
type DatasetUpdate = CallParams<ApiSurface, 'pool.dataset.update'>[1];

/**
 * The properties `dataset_set_property` sets. The test for a place here is that
 * changing it loses no data, and setting it back undoes it. `readonly` is
 * disruptive — writers start failing — and passes, so it is in. `snapdir`
 * passes and still EXPOSES data: anything but DISABLED leaves every snapshot's
 * copy readable under the mountpoint, so the description and its plan say so,
 * as they say `readonly` ON fails writes. `sync`, `deduplication`, `checksum`,
 * `copies`, `acltype` and `aclmode` are excluded for the reasons the
 * description names (#102).
 */
const SETTABLE_PROPERTIES = [
  'compression',
  'atime',
  'recordsize',
  'snapdir',
  'exec',
  'readonly',
] as const satisfies readonly (keyof DatasetUpdate)[];

type SettableProperty = (typeof SETTABLE_PROPERTIES)[number];

/** The properties whose values are a declared union rather than a system's list. */
type EnumProperty = Exclude<SettableProperty, 'recordsize'>;

/**
 * Every value the update declares for each enumerated property, `INHERIT`
 * included. A `Record` over the declared union, so a value the client adds or
 * drops fails to compile here rather than being refused or accepted silently —
 * and the union is the OLDEST surface's (#101), so a newer system may accept a
 * value this list refuses. That is the conservative direction for a write.
 */
const DECLARED_VALUES: { [P in EnumProperty]: Record<NonNullable<DatasetUpdate[P]>, true> } = {
  compression: {
    'ON': true,
    'OFF': true,
    'LZ4': true,
    'GZIP': true,
    'GZIP-1': true,
    'GZIP-9': true,
    'ZSTD': true,
    'ZSTD-FAST': true,
    'ZLE': true,
    'LZJB': true,
    'ZSTD-1': true,
    'ZSTD-2': true,
    'ZSTD-3': true,
    'ZSTD-4': true,
    'ZSTD-5': true,
    'ZSTD-6': true,
    'ZSTD-7': true,
    'ZSTD-8': true,
    'ZSTD-9': true,
    'ZSTD-10': true,
    'ZSTD-11': true,
    'ZSTD-12': true,
    'ZSTD-13': true,
    'ZSTD-14': true,
    'ZSTD-15': true,
    'ZSTD-16': true,
    'ZSTD-17': true,
    'ZSTD-18': true,
    'ZSTD-19': true,
    'ZSTD-FAST-1': true,
    'ZSTD-FAST-2': true,
    'ZSTD-FAST-3': true,
    'ZSTD-FAST-4': true,
    'ZSTD-FAST-5': true,
    'ZSTD-FAST-6': true,
    'ZSTD-FAST-7': true,
    'ZSTD-FAST-8': true,
    'ZSTD-FAST-9': true,
    'ZSTD-FAST-10': true,
    'ZSTD-FAST-20': true,
    'ZSTD-FAST-30': true,
    'ZSTD-FAST-40': true,
    'ZSTD-FAST-50': true,
    'ZSTD-FAST-60': true,
    'ZSTD-FAST-70': true,
    'ZSTD-FAST-80': true,
    'ZSTD-FAST-90': true,
    'ZSTD-FAST-100': true,
    'ZSTD-FAST-500': true,
    'ZSTD-FAST-1000': true,
    'INHERIT': true,
  },
  atime: { ON: true, OFF: true, INHERIT: true },
  snapdir: { DISABLED: true, VISIBLE: true, HIDDEN: true, INHERIT: true },
  exec: { ON: true, OFF: true, INHERIT: true },
  readonly: { ON: true, OFF: true, INHERIT: true },
};

/** ZFS sets these on a filesystem only; a volume has none of them. */
const FILESYSTEM_ONLY: ReadonlySet<SettableProperty> = new Set(['atime', 'recordsize', 'snapdir', 'exec']);

/** The two properties whose change reaches only blocks written afterwards. */
const NEW_WRITES_ONLY: ReadonlySet<SettableProperty> = new Set(['compression', 'recordsize']);

/**
 * The sources ZFS reports for a value this dataset does not set itself. These
 * are ZFS's own source names, not something this API surface declares — the
 * client types `source` a plain string — so the reading is (unconfirmed).
 */
const NOT_LOCAL_SOURCES: ReadonlySet<string> = new Set(['INHERITED', 'DEFAULT']);

interface PropertyRequest {
  dataset: string;
  property: SettableProperty;
  value: string;
}

function parsePropertyRequest(args: Record<string, unknown>): PropertyRequest {
  const dataset = args['dataset'];
  if (typeof dataset !== 'string' || dataset === '') {
    throw new Error('"dataset" is required and must be a dataset name, such as "tank/media"');
  }
  const property = args['property'];
  if (typeof property !== 'string' || !(SETTABLE_PROPERTIES as readonly string[]).includes(property)) {
    throw new Error(
      `"property" must be one of ${SETTABLE_PROPERTIES.join(', ')}; sync, deduplication, checksum, copies, ` +
        'acltype and aclmode are deliberately not set by this tool',
    );
  }
  const value = args['value'];
  if (typeof value !== 'string' || value === '') {
    throw new Error('"value" is required and must be a value for the property, or INHERIT');
  }
  const settable = property as SettableProperty;
  if (settable === 'recordsize') {
    if (value === 'INHERIT') {
      throw new Error(
        '`recordsize` is override-only here: the API declares it a plain string and does not state that it ' +
          'accepts INHERIT, so pass a size from the system\'s own record size choices',
      );
    }
  } else if (!Object.hasOwn(DECLARED_VALUES[settable], value)) {
    throw new Error(
      `"${value}" is not a value of \`${settable}\`; it accepts ${Object.keys(DECLARED_VALUES[settable]).join(', ')}`,
    );
  }
  return { dataset, property: settable, value };
}

/**
 * The update's params. The value was checked against the property's declared
 * union by the parse, or against the system's own list by the plan, and a
 * computed key cannot carry that to the compiler — hence the one cast.
 */
function propertyUpdateParams(request: PropertyRequest): CallParams<ApiSurface, 'pool.dataset.update'> {
  return [request.dataset, { [request.property]: request.value } as DatasetUpdate];
}

/** A property's value and source as the system spelled them; null where either could not be read. */
interface PropertyReading {
  value: string | null;
  source: string | null;
}

/**
 * The value is the property object's `value`, not its `parsed`: it is a string
 * on every property here, and passed through as the system spelled it, so a
 * value this catalog does not list is still reported rather than nulled.
 */
function propertyReading(row: Record<string, unknown> | null, property: SettableProperty): PropertyReading {
  const held = row === null ? null : recordOrNull(row[property]);
  return {
    value: held === null ? null : textOrNull(held['value']),
    source: held === null ? null : textOrNull(held['source']),
  };
}

/**
 * Whether a reading is the state a request asks for: the value set on this
 * dataset itself, or, for INHERIT, a value it does not set. False wherever what
 * was read says otherwise; null where it does not settle it either way.
 */
function readingMatches(requested: string, reading: PropertyReading): boolean | null {
  const source = reading.source?.toUpperCase() ?? null;
  if (requested === 'INHERIT') {
    if (source === null) return null;
    if (NOT_LOCAL_SOURCES.has(source)) return true;
    return source === 'LOCAL' ? false : null;
  }
  // ZFS reports these values in lower case where the API takes upper case, so
  // the comparison ignores letter case; the value is still reported as spelled.
  if (reading.value !== null && reading.value.toUpperCase() !== requested.toUpperCase()) return false;
  if (source !== null && NOT_LOCAL_SOURCES.has(source)) return false;
  // Any other source — `RECEIVED`, `TEMPORARY` — is neither the setting landing
  // nor plainly its absence, so it settles nothing.
  return reading.value === null || source !== 'LOCAL' ? null : true;
}

function readingText(reading: PropertyReading): string {
  const value = reading.value ?? 'a value that could not be read';
  const source = reading.source === null ? 'a source that could not be read' : `source ${reading.source}`;
  return `${value} (${source})`;
}

/**
 * Refuses a `recordsize` the system does not offer, reading the system's own
 * list rather than one written here. Plan-time only and not a step (#119). A
 * list that could not be read refuses too: the size would otherwise reach
 * approval unchecked, and nothing is lost by planning again. `row` is the
 * dataset whose pool is asked about — for `dataset_create`, the parent.
 */
async function checkRecordsize(
  ctx: ToolContext,
  row: Record<string, unknown>,
  request: { dataset: string; value: string },
): Promise<void> {
  const pool = textOrNull(row['pool']);
  let choices: string[] | null;
  try {
    choices = textList(
      await firstValueFrom(ctx.system.client.api.call('pool.dataset.recordsize_choices', pool === null ? [] : [pool])),
    );
  } catch (reason) {
    throw new Error(
      `The record sizes this system accepts could not be read (pool.dataset.recordsize_choices failed: ` +
        `${errorText(reason)}), so "${request.value}" was not checked and nothing is planned`,
    );
  }
  if (choices === null) {
    throw new Error(
      'The record sizes this system accepts could not be read (pool.dataset.recordsize_choices answered with ' +
        `something that is not a list), so "${request.value}" was not checked and nothing is planned`,
    );
  }
  if (!choices.includes(request.value)) {
    throw new Error(
      `"${request.value}" is not a record size this system accepts for dataset "${request.dataset}"; it accepts ` +
        `${choices.length === 0 ? 'none it listed' : choices.join(', ')}`,
    );
  }
}

/**
 * What a `snapdir` other than DISABLED makes readable. One text, so the
 * description and every plan sentence say the same thing about it.
 */
const SNAPDIR_EXPOSURE =
  "`.zfs/snapshot` under the dataset's mountpoint, and so through any SMB or NFS share of it, holds every " +
  "snapshot's copy of the data — files deleted since the snapshot was taken, and files as they were before a " +
  'later `chmod` or ACL change, since a snapshot keeps the permissions a file had when it was taken. That is ' +
  'ZFS behaviour, not stated by this API surface.';

/** What the plan says the change does, beyond setting the value. */
function propertyEffect(request: PropertyRequest, current: PropertyReading): string {
  const { property, value } = request;
  let effect = '';
  const unchanged = readingMatches(value, current) === true;
  if (unchanged) {
    effect +=
      value === 'INHERIT'
        ? ' It already inherits, so this changes nothing and is not an error.'
        : ' It is already set to that on this dataset, so this changes nothing and is not an error.';
  }
  if (property === 'recordsize' && current.source !== null && NOT_LOCAL_SOURCES.has(current.source.toUpperCase())) {
    effect +=
      ` NOTHING IN THIS CATALOG CAN PUT BACK ITS SOURCE ${current.source}: INHERIT is refused for \`recordsize\`, ` +
      'and setting the old size again sets it on this dataset.';
  }
  if (NEW_WRITES_ONLY.has(property)) {
    effect +=
      ` EXISTING DATA IS NOT REWRITTEN: only blocks written after the change use the new \`${property}\`, and ` +
      'what is already on the dataset keeps the one it was written with.';
  }
  // The `readonly` and `snapdir` warnings below are not given for a change the
  // plan has just said does nothing: the two read as contradicting. The
  // not-rewritten sentence above is still given, and is about the property.
  if (unchanged) return effect;
  if (property === 'readonly' && value === 'ON') {
    effect +=
      ' WRITES TO THE DATASET WILL FAIL once this is applied — every application, share and client writing to ' +
      'it gets an error — until `readonly` is set back.';
  } else if (property === 'readonly' && value === 'INHERIT') {
    effect +=
      ' If the parent is read-only, WRITES TO THE DATASET WILL FAIL once this is applied; the parent\'s ' +
      'value is not read here.';
  }
  if (property === 'snapdir' && value === 'VISIBLE') {
    effect += ` SNAPSHOT CONTENTS BECOME BROWSABLE once this is applied: ${SNAPDIR_EXPOSURE}`;
  } else if (property === 'snapdir' && value === 'HIDDEN') {
    effect += ` SNAPSHOT CONTENTS STAY REACHABLE BY PATH while HIDDEN — \`.zfs\` is not listed, but opening it by name works: ${SNAPDIR_EXPOSURE}`;
  } else if (property === 'snapdir' && value === 'INHERIT') {
    effect +=
      " If the parent's `snapdir` is VISIBLE or HIDDEN, SNAPSHOT CONTENTS BECOME REACHABLE once this is applied; " +
      `the parent's value is not read here. ${SNAPDIR_EXPOSURE}`;
  }
  return effect;
}

const DATASET_SET_PROPERTY_GUIDANCE =
  '`dataset` and `property` are as named, and `requested` is the value passed, `INHERIT` included. ' +
  '`previous_value` and `previous_source` are the property as a read made immediately before the call ' +
  'reported it; `resulting_value` and `resulting_source` are as the response the update itself answered ' +
  'with states it — never copied from the request. A value is passed through as the system spelled it, ' +
  'including one this catalog does not list, and null is a value that could not be read, NEVER "unset". ' +
  'A source is where ZFS says the value comes from — `LOCAL` set on this dataset, `INHERITED` from an ' +
  'ancestor, `DEFAULT` from ZFS itself — as the system spelled it; those names are ZFS\'s, not declared ' +
  'by this API surface (unconfirmed). `lookup` is what the read before the call did: `FOUND`, `NOT_FOUND` ' +
  '(it listed no such dataset) or `UNREADABLE`, with the reason in `lookup_error`; the call is made ' +
  'whichever it was. `changed` compares the value and source before with the value and source after, ' +
  'and is null where any of the four could not be read. `confirmed` is whether the response shows the ' +
  'state asked for — the value, compared ignoring letter case, with source `LOCAL`; or for INHERIT, a ' +
  'source of `INHERITED` or `DEFAULT`. FALSE IS NOT A SUCCESS: the call did not reject and the property ' +
  'is not in the state asked for. Null is a response that settles it neither way — a value or source ' +
  'that could not be read, or a source other than those three.';

export const datasetSetProperty: MutatingTool = {
  name: 'dataset_set_property',
  description:
    'Sets one ZFS property on one dataset to a value, or back to inheriting it, on this TrueNAS system. ' +
    'Two-phase: called without a confirmation_token it returns a plan for user approval; called with one ' +
    "it sends the change. `dataset` is the dataset's full name, as `storage_list_datasets` reports it in " +
    '`id`; a name the system does not list fails the plan, naming it. `property` is one of `compression`, ' +
    '`atime`, `recordsize`, `snapdir`, `exec` and `readonly` — properties whose change loses no data, and ' +
    'is undone by setting it back. `snapdir` CAN EXPOSE DATA: VISIBLE lists `.zfs/snapshot` and HIDDEN ' +
    'leaves it reachable by name, so anything but DISABLED makes snapshot contents readable — ' +
    SNAPDIR_EXPOSURE +
    ' Its plan says so. DELIBERATELY NOT SETTABLE HERE: `sync` (DISABLED ' +
    'acknowledges writes before they are on stable storage, so a power loss loses data a client was told ' +
    'was written), `deduplication` (its memory cost, and data written while it was on stays deduplicated ' +
    'after it is turned off), `checksum` (OFF disables ZFS\'s integrity check), `copies` (it affects new ' +
    'writes only), and `acltype` and `aclmode` (they change how every permission on the dataset is ' +
    'interpreted). Quotas are `dataset_set_quota`; reservations and user properties are set by no tool ' +
    'here. `value` is one of the values the API declares for that property, or `INHERIT`, which clears ' +
    "this dataset's own setting so the value comes from its nearest ancestor that sets one, or from ZFS's " +
    'default; anything else fails the plan, naming the accepted values. `recordsize` takes a size from ' +
    "the system's own record size choices, checked when the plan is made, and IS OVERRIDE-ONLY: the API " +
    'declares it a plain string and does not state that it accepts INHERIT, so INHERIT is refused for it. ' +
    '`atime`, `recordsize`, `snapdir` and `exec` are filesystem properties, and a volume fails the plan ' +
    'for them. THE PLAN STATES THE CURRENT VALUE AND SOURCE AND THE VALUE REQUESTED, so wherever the ' +
    'current value could be read the call that undoes this is in the plan — a value whose source was ' +
    'INHERITED or DEFAULT is put back by INHERIT, not by setting that value, which would set it locally — ' +
    'EXCEPT FOR `recordsize`, where INHERIT is refused, so a record size that was inherited or default ' +
    'CANNOT BE PUT BACK TO INHERITING BY ANY TOOL HERE, and its plan says so. ' +
    '`compression` and `recordsize` DO NOT REWRITE EXISTING DATA: only blocks written afterwards use the ' +
    'new setting. `readonly` ON MAKES EVERY WRITE TO THE DATASET FAIL until it is set back. The current ' +
    'value is read when the plan is made and again immediately before the call, for the result; the ' +
    'call is made whatever that second read finds. Setting a value the dataset already holds locally, or ' +
    'INHERIT on one that already inherits, is not an error. `destructiveness` is `reversible`: nothing is ' +
    'deleted, and setting the property back undoes the setting, `recordsize`\'s source aside — but blocks written while a ' +
    '`compression` or `recordsize` was in force keep it, and nothing here rewrites them. ' +
    DATASET_SET_PROPERTY_GUIDANCE,
  resultGuidance: DATASET_SET_PROPERTY_GUIDANCE,
  inputSchema: {
    type: 'object',
    properties: {
      dataset: {
        type: 'string',
        description: 'The dataset\'s full name, e.g. "tank/media", as `storage_list_datasets` reports it in `id`.',
      },
      property: {
        type: 'string',
        enum: [...SETTABLE_PROPERTIES],
        description: 'The one ZFS property to set.',
      },
      value: {
        type: 'string',
        description:
          'The new value as the API spells it — e.g. LZ4, ZSTD or OFF for `compression`; ON or OFF for ' +
          '`atime`, `exec` and `readonly`; DISABLED, VISIBLE or HIDDEN for `snapdir`; a size such as 128K ' +
          'for `recordsize` — or INHERIT, which every property here but `recordsize` accepts.',
      },
    },
    required: ['dataset', 'property', 'value'],
  },
  requiredRole: Role.Full,
  mutating: true,
  // One property on one dataset, and the plan names the value to send back.
  // Nothing is deleted; what a setting does to blocks already written is the
  // description's to state (#122).
  destructiveness: 'reversible',
  normalizeArgs(rawArgs) {
    const { dataset, property, value } = parsePropertyRequest(rawArgs);
    return { dataset, property, value };
  },
  async plan(ctx, rawArgs): Promise<PlanStep[]> {
    const request = parsePropertyRequest(rawArgs);
    const { dataset, property, value } = request;
    const row = await readPlannedDataset(ctx, dataset, [property]);
    // The middleware refuses filesystem properties on a volume, so the plan
    // does too (#161). An unreadable type does not refuse anything (#154).
    const type = textOrNull(row['type']);
    let typeNote = '';
    if (FILESYSTEM_ONLY.has(property)) {
      if (type === 'VOLUME') {
        throw new Error(
          `Dataset "${dataset}" is a volume, and \`${property}\` is a filesystem property that ZFS does not ` +
            'set on one',
        );
      }
      if (type === null) {
        typeNote =
          ` Whether this dataset is a filesystem could not be read; ZFS does not set \`${property}\` on a ` +
          'volume, so the call may be rejected.';
      }
    }
    if (property === 'recordsize') await checkRecordsize(ctx, row, request);
    const current = propertyReading(row, property);
    const target =
      value === 'INHERIT'
        ? "INHERIT: clear this dataset's own setting, so the value comes from its nearest ancestor that sets " +
          "one, or from ZFS's default, which this plan does not read"
        : value;
    return [
      {
        method: 'pool.dataset.query',
        params: [[['id', '=', dataset]], datasetReadOptions([property])],
        description:
          `Read dataset "${dataset}"'s \`${property}\`, to report its value and source as they were ` +
          'immediately before the change. Changes nothing.',
      },
      {
        method: 'pool.dataset.update',
        params: propertyUpdateParams(request),
        description:
          `Set \`${property}\` on dataset "${dataset}". Now: ${readingText(current)}. Will be: ${target}.` +
          `${typeNote}${propertyEffect(request, current)} The current value was read when this plan was made.`,
      },
    ];
  },
  async execute(ctx, rawArgs) {
    const request = parsePropertyRequest(rawArgs);
    const { dataset, property, value } = request;
    // The read is caught rather than thrown and nothing branches on it: it
    // describes the outcome, and failing here would throw away an approval
    // already given for a change that is still safe to make (#119).
    let before: Record<string, unknown> | null = null;
    let lookupError: string | null = null;
    try {
      before = await datasetRow(ctx, dataset, [property]);
    } catch (reason) {
      lookupError = errorText(reason);
    }
    const updated: unknown = await firstValueFrom(
      ctx.system.client.api.call('pool.dataset.update', propertyUpdateParams(request)),
    );
    const previous = propertyReading(before, property);
    // The update answers with the updated dataset, so the outcome is read off
    // that rather than echoed from the request (#121).
    const resulting = propertyReading(recordOrNull(updated), property);
    const readings = [previous.value, previous.source, resulting.value, resulting.source];
    return {
      dataset,
      property,
      requested: value,
      lookup: lookupError !== null ? 'UNREADABLE' : before === null ? 'NOT_FOUND' : 'FOUND',
      lookup_error: lookupError,
      previous_value: previous.value,
      previous_source: previous.source,
      resulting_value: resulting.value,
      resulting_source: resulting.source,
      changed: readings.includes(null)
        ? null
        : previous.value !== resulting.value || previous.source !== resulting.source,
      confirmed: readingMatches(value, resulting),
    };
  },
};

/** The create's argument, typed off the call (#91) and narrowed to the filesystem arm. */
type FilesystemCreate = Exclude<CallParams<ApiSurface, 'pool.dataset.create'>[0], { volsize: number }>;

/**
 * The values `dataset_create` accepts for its two enumerated properties, typed
 * over the CREATE's declared unions. They are `dataset_set_property`'s lists:
 * a value the create declares and the update does not fails to compile here,
 * and one the update declares and the create does not would be accepted and
 * left to the middleware to refuse.
 */
const CREATE_VALUES: { [P in 'compression' | 'atime']: Record<NonNullable<FilesystemCreate[P]>, true> } = {
  compression: DECLARED_VALUES.compression,
  atime: DECLARED_VALUES.atime,
};

/**
 * The `share_type`s this tool sends. The API also declares MULTIPROTOCOL and
 * APPS, which prepare a dataset for an SMB-and-NFS share and for an
 * application's storage; what either changes is not stated by the surface, and
 * no tool here serves either purpose, so they are refused rather than guessed
 * at.
 */
const SHARE_TYPES = ['GENERIC', 'SMB', 'NFS'] as const satisfies readonly NonNullable<
  FilesystemCreate['share_type']
>[];

type ShareType = (typeof SHARE_TYPES)[number];

/** ZFS's dataset-name character set: letters, digits, `_`, `-`, `.`, `:` and space. */
const DATASET_NAME_CHARS = /^[A-Za-z0-9_.: -]+$/;

/**
 * Names TrueNAS keeps for its own datasets. Whether the middleware refuses a
 * new one is (unconfirmed), so this tool refuses them regardless.
 */
const RESERVED_DATASET_NAMES: readonly string[] = ['ix-applications', '.system'];

/** The properties `dataset_create` sets, by API name, and the argument that names each. */
const CREATE_SETTINGS = {
  comments: 'comments',
  compression: 'compression',
  atime: 'atime',
  recordsize: 'recordsize',
  quota: 'quota_bytes',
  refquota: 'refquota_bytes',
} as const satisfies Partial<Record<keyof FilesystemCreate, string>>;

type CreateSetting = keyof typeof CREATE_SETTINGS;

interface CreateRequest {
  name: string;
  parent: string;
  /** Only the settings passed; one not passed is absent and is not sent. */
  settings: Partial<Record<CreateSetting, string | number>>;
  shareType: ShareType | null;
}

function parseCreateRequest(args: Record<string, unknown>): CreateRequest {
  refuseArgs(args, ['type', 'volsize'], 'this tool creates a filesystem dataset only');
  refuseArgs(
    args,
    ['encryption', 'encryption_options', 'inherit_encryption'],
    "encryption is inherited from the parent; a passphrase or key of the caller's own is a secret argument, " +
      'which this catalog does not take',
  );
  refuseArgs(args, ['create_ancestors'], 'the parent must already exist, so nothing is created that was not named');
  const name = args['name'];
  if (typeof name !== 'string' || name === '') {
    throw new Error('"name" is required and must be the new dataset\'s full name, such as "tank/projects/new"');
  }
  const segments = name.split('/');
  if (segments.length < 2 || segments.includes('')) {
    throw new Error(
      `"${name}" is not a dataset name under a parent: write the parent's full name, a slash and the new name, ` +
        'with no empty part, such as "tank/projects/new"',
    );
  }
  const leaf = segments[segments.length - 1] as string;
  if (!DATASET_NAME_CHARS.test(leaf)) {
    throw new Error(
      `"${leaf}" has a character ZFS does not accept in a dataset name; it accepts letters, digits, "_", "-", ` +
        '".", ":" and space',
    );
  }
  if (RESERVED_DATASET_NAMES.includes(leaf)) {
    throw new Error(`"${leaf}" is a name TrueNAS reserves for its own datasets, so this tool does not create one`);
  }
  const settings: CreateRequest['settings'] = {};
  const comments = args['comments'];
  if (comments !== undefined) {
    if (typeof comments !== 'string') throw new Error('"comments" must be text');
    settings.comments = comments;
  }
  for (const property of ['compression', 'atime'] as const) {
    const value = args[property];
    if (value === undefined) continue;
    if (typeof value !== 'string' || !Object.hasOwn(CREATE_VALUES[property], value)) {
      throw new Error(
        `"${String(value)}" is not a value of \`${property}\`; it accepts ${Object.keys(CREATE_VALUES[property]).join(', ')}`,
      );
    }
    settings[property] = value;
  }
  const recordsize = args['recordsize'];
  if (recordsize !== undefined) {
    if (typeof recordsize !== 'string' || recordsize === '') {
      throw new Error('"recordsize" must be a size from the system\'s own record size choices, such as "128K"');
    }
    settings.recordsize = recordsize;
  }
  for (const kind of ['quota', 'refquota'] as const) {
    const key = CREATE_SETTINGS[kind];
    const value = args[key];
    if (value === undefined) continue;
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
      throw new Error(`"${key}" must be a whole number of bytes, 0 or more`);
    }
    settings[kind] = value;
  }
  const shareType = args['share_type'];
  if (shareType !== undefined && !(SHARE_TYPES as readonly unknown[]).includes(shareType)) {
    throw new Error(
      `"share_type" must be one of ${SHARE_TYPES.join(', ')}; MULTIPROTOCOL and APPS are not sent by this tool`,
    );
  }
  return {
    name,
    parent: segments.slice(0, -1).join('/'),
    settings,
    shareType: (shareType as ShareType | undefined) ?? null,
  };
}

/** The arguments as passed, under their own names, for the confirmation token and the result. */
function createArgs(request: CreateRequest): Record<string, string | number> {
  const args: Record<string, string | number> = { name: request.name };
  for (const setting of Object.keys(request.settings) as CreateSetting[]) {
    args[CREATE_SETTINGS[setting]] = request.settings[setting] as string | number;
  }
  if (request.shareType !== null) args['share_type'] = request.shareType;
  return args;
}

/**
 * The create's params, built in one place so the plan step names exactly the
 * call `execute` makes. `type` is sent explicitly. The enumerated values were
 * checked against the create's declared unions by the parse, and `recordsize`
 * against the system's own list by the plan; spreading a record of them cannot
 * carry that to the compiler, hence the one cast.
 */
function createParams(request: CreateRequest): CallParams<ApiSurface, 'pool.dataset.create'> {
  return [
    {
      name: request.name,
      type: 'FILESYSTEM',
      ...request.settings,
      ...(request.shareType === null ? {} : { share_type: request.shareType }),
    } as FilesystemCreate,
  ];
}

/**
 * The ZFS properties the parent is read with. The `encrypted`,
 * `encryption_root` and `locked` fields the plan reads are fields of the entry
 * rather than properties, and are asked for by the properties they describe so
 * that a read narrowed to a property list cannot leave them unfilled; whether
 * the middleware needs that is not stated by the surface.
 */
const PARENT_PROPERTIES = ['encryption', 'encryptionroot', 'keystatus'];

/** What the plan says about the new dataset's encryption, read off its parent. */
function encryptionSentence(parent: string, row: Record<string, unknown>): string {
  const encrypted = booleanOrNull(row['encrypted']);
  if (encrypted === false) {
    return ` It will NOT be encrypted: encryption is inherited from the parent, and "${parent}" is not encrypted.`;
  }
  if (encrypted === null) {
    return (
      ` Whether "${parent}" is encrypted could not be read, so whether the new dataset will be is not stated; ` +
      'it inherits the parent\'s encryption either way.'
    );
  }
  const root = textOrNull(row['encryption_root']);
  let text =
    ` It WILL BE ENCRYPTED, inheriting the encryption of "${parent}" under ` +
    `${root === null ? 'an encryption root that could not be read' : `encryption root "${root}"`}.`;
  const locked = booleanOrNull(row['locked']);
  if (locked === true) {
    text +=
      ` "${parent}" IS LOCKED. Whether a dataset can be created under a locked encryption root is ` +
      '(unconfirmed), so the call may be rejected.';
  } else if (locked === null) {
    text += ` Whether "${parent}" is locked could not be read.`;
  }
  return text;
}

/** What the plan says about `share_type`, claiming nothing the surface does not state. */
function shareTypeSentence(shareType: ShareType | null): string {
  switch (shareType) {
    case null:
      return ' No `share_type` is sent; the default is understood to be GENERIC (unconfirmed).';
    case 'GENERIC':
      return ' `share_type` GENERIC is sent, which is understood to be the default (unconfirmed).';
    case 'SMB':
      return (
        ' `share_type` SMB is sent. It is understood to set the dataset\'s ACL type and mode for SMB ' +
        '(unconfirmed: the API declares only the name).'
      );
    case 'NFS':
      return ' `share_type` NFS is sent. What it changes is not stated by the API (unconfirmed).';
  }
}

/** The properties the plan says are set, in words; every one not passed is inherited. */
function settingsSentence(settings: CreateRequest['settings']): string {
  const parts = (Object.keys(settings) as CreateSetting[]).map((setting) => {
    const value = settings[setting];
    if (setting === 'quota' || setting === 'refquota') {
      return `\`${setting}\` ${value === 0 ? 'no limit (sent as 0)' : bytesText(value as number)}`;
    }
    return setting === 'comments' ? `\`comments\` ${JSON.stringify(value)}` : `\`${setting}\` ${String(value)}`;
  });
  if (parts.length === 0) {
    return " No property is set, so every property is inherited from the parent or is ZFS's default.";
  }
  return ` Set on it: ${parts.join('; ')}. Every other property is inherited from the parent or is ZFS's default.`;
}

/**
 * The created dataset, through `storage_list_datasets`' allowlist — the same
 * six fields, read the same way, and never the entry forwarded. A field the
 * response did not carry is null rather than absent, so the shape is the one
 * the guidance describes; the spec holds the key list against the listing's.
 */
function createdDataset(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: row['id'] ?? null,
    pool: row['pool'] ?? null,
    type: row['type'] ?? null,
    mountpoint: row['mountpoint'] ?? null,
    used: (row['used'] as ZfsProperty | undefined)?.parsed ?? null,
    available: (row['available'] as ZfsProperty | undefined)?.parsed ?? null,
  };
}

const DATASET_CREATE_GUIDANCE =
  '`name` is the dataset named, and `requested` is exactly what was passed, under the arguments\' own ' +
  'names. `created` is the dataset as the response the create itself answered with states it — never ' +
  'copied from the request — through the fields `storage_list_datasets` reports: `id`, `pool`, `type`, ' +
  '`mountpoint`, `used` and `available`, each as the system sent it and null where the response carried ' +
  'none. `created` is null where the response was not a dataset at all, which is NOT evidence that ' +
  'nothing was created: `storage_list_datasets` is how to check.';

export const datasetCreate: MutatingTool = {
  name: 'dataset_create',
  description:
    'Creates one ZFS filesystem dataset under an existing parent on this TrueNAS system. Two-phase: called ' +
    'without a confirmation_token it returns a plan for user approval; called with one it sends the create. ' +
    '`name` is the new dataset\'s full name — the parent\'s full name as `storage_list_datasets` reports it in ' +
    '`id`, a slash, and the new name. THE PARENT MUST EXIST: one the system does not list fails the plan, ' +
    'naming it, and no intermediate dataset is ever created. A name that already exists fails the plan. The ' +
    'new name may hold only letters, digits, `_`, `-`, `.`, `:` and space, and `ix-applications` and ' +
    '`.system`, which TrueNAS reserves, are refused. ONLY FILESYSTEMS: volumes (zvols) are not created here. ' +
    'ENCRYPTION IS INHERITED FROM THE PARENT and is not chosen here — no encryption setting, passphrase or ' +
    'key is taken — and THE PLAN STATES WHETHER THE NEW DATASET WILL BE ENCRYPTED, and under which ' +
    'encryption root, as read from the parent. Optional settings: `comments`; `compression` and `atime`, ' +
    'each one of the values the API declares; `recordsize`, a size from the system\'s own record size ' +
    'choices, checked when the plan is made; `quota_bytes` and `refquota_bytes`, limits in bytes, `0` being ' +
    'no limit; and `share_type`, one of GENERIC, SMB and NFS. MULTIPROTOCOL and APPS are refused: what they ' +
    'change is not stated by the API and no tool here serves them. What `share_type` changes is not stated ' +
    'by the API either: SMB is understood to set the dataset\'s ACL type and mode for SMB, and GENERIC to be ' +
    'the default, both (unconfirmed). Every setting not passed is inherited from the parent or is ZFS\'s ' +
    'default. The plan states the `share_type` and every setting it sends. The parent and the name are read ' +
    'when the plan is made and not again. `destructiveness` is `reversible`: nothing is deleted or changed. ' +
    'BUT NO TOOL IN THIS CATALOG DELETES A DATASET, so undoing this is a deletion a person makes elsewhere. ' +
    DATASET_CREATE_GUIDANCE,
  resultGuidance: DATASET_CREATE_GUIDANCE,
  inputSchema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'The new dataset\'s full name, e.g. "tank/projects/new"; its parent must already exist.',
      },
      comments: { type: 'string', description: 'A comment stored on the dataset.' },
      compression: {
        type: 'string',
        description:
          'The compression algorithm, as the API spells it, e.g. LZ4, ZSTD or OFF; any other value fails the ' +
          'plan, naming the accepted ones.',
      },
      atime: {
        type: 'string',
        enum: Object.keys(CREATE_VALUES.atime),
        description: 'Whether reads update access times.',
      },
      recordsize: {
        type: 'string',
        description: "A record size from the system's own record size choices, e.g. 128K or 1M.",
      },
      quota_bytes: {
        type: 'integer',
        minimum: 0,
        description: 'A `quota` in bytes: caps the dataset with its descendants and snapshots. 0 is no limit.',
      },
      refquota_bytes: {
        type: 'integer',
        minimum: 0,
        description: 'A `refquota` in bytes: caps the data the dataset itself holds. 0 is no limit.',
      },
      share_type: {
        type: 'string',
        enum: [...SHARE_TYPES],
        description: 'What the dataset is prepared for. Omitted, the system\'s default is used.',
      },
    },
    required: ['name'],
  },
  requiredRole: Role.Full,
  mutating: true,
  // One new dataset, and nothing existing is deleted or changed. Undoing it is
  // a deletion no tool here makes, which the description says (#153).
  destructiveness: 'reversible',
  normalizeArgs(rawArgs) {
    return createArgs(parseCreateRequest(rawArgs));
  },
  async plan(ctx, rawArgs): Promise<PlanStep[]> {
    const request = parseCreateRequest(rawArgs);
    const { name, parent } = request;
    let parentRow: Record<string, unknown> | null;
    try {
      parentRow = await datasetRow(ctx, parent, PARENT_PROPERTIES);
    } catch (reason) {
      throw new Error(
        `Parent dataset "${parent}" could not be read (pool.dataset.query failed: ${errorText(reason)}), so ` +
          'nothing is planned',
      );
    }
    if (parentRow === null) {
      throw new Error(
        `Parent dataset "${parent}" does not exist on this system, and this tool does not create it — ` +
          "`storage_list_datasets` reports each dataset's `id`",
      );
    }
    // A volume holds no datasets, so the middleware refuses one under it
    // (#161). An unreadable type does not refuse anything (#154); it is stated.
    const parentType = textOrNull(parentRow['type']);
    if (parentType === 'VOLUME') {
      throw new Error(`Parent dataset "${parent}" is a volume, and ZFS does not create a dataset under one`);
    }
    const typeNote =
      parentType === null
        ? ` Whether "${parent}" is a filesystem could not be read; ZFS does not create a dataset under a volume, ` +
          'so the call may be rejected.'
        : '';
    let existing: Record<string, unknown> | null;
    try {
      existing = await datasetRow(ctx, name, []);
    } catch (reason) {
      throw new Error(
        `Whether dataset "${name}" already exists could not be read (pool.dataset.query failed: ` +
          `${errorText(reason)}), so nothing is planned`,
      );
    }
    if (existing !== null) {
      throw new Error(`Dataset "${name}" already exists on this system`);
    }
    const recordsize = request.settings.recordsize;
    if (typeof recordsize === 'string') await checkRecordsize(ctx, parentRow, { dataset: name, value: recordsize });
    return [
      {
        method: 'pool.dataset.create',
        params: createParams(request),
        description:
          `Create filesystem dataset "${name}" under "${parent}".${typeNote}` +
          `${encryptionSentence(parent, parentRow)}${shareTypeSentence(request.shareType)}` +
          `${settingsSentence(request.settings)} The parent and the name were read when this plan was made ` +
          'and are not read again.',
      },
    ];
  },
  async execute(ctx, rawArgs) {
    const request = parseCreateRequest(rawArgs);
    const created: unknown = await firstValueFrom(
      ctx.system.client.api.call('pool.dataset.create', createParams(request)),
    );
    // The create answers with the new dataset, so what was created is read off
    // that rather than echoed from the request (#121).
    const held = recordOrNull(created);
    return {
      name: request.name,
      requested: createArgs(request),
      created: held === null ? null : createdDataset(held),
    };
  },
};
