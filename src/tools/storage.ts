import { firstValueFrom } from 'rxjs';
import { Role } from '@/interfaces';
import { ReadOnlyTool, SystemHandle } from '@/catalog/tool';
import {
  booleanOrNull,
  errorText,
  numberOrNull,
  recordOrNull,
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
  'rather than empty when `include_children` was not asked for, so an empty ' +
  'list means the dataset has no descendants. `children_limit` is the cap that ' +
  'was applied and `children_truncated` says whether it was reached; all three ' +
  'are null when children were not asked for. A TRUNCATED LIST IS NOT EVIDENCE ' +
  'ABOUT THE DATASETS MISSING FROM IT — the descendants are ordered by id and ' +
  'the ones past the cap were never read. ' +
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
  'NULL NAME BESIDE A NUMBER IS NOT A MISSING OWNER — the number is the owner ' +
  'and it is always reported; the name is null both where no account or group ' +
  'on the system answers to that number and where the system reported no name ' +
  'this tool could read, and those two are NOT separated here. ' +
  '`mode_octal` is the permission bits as FOUR octal digits, so `0700` and ' +
  '`0750` are distinguishable at a glance. The leading digit is not padding: ' +
  'it carries setuid, setgid and the sticky bit, so a setgid directory reads ' +
  '`2770`. THE FILE-TYPE BITS A POSIX `stat` CARRIES IN THE SAME NUMBER ARE ' +
  'NOT REPORTED — what the dataset is, is `type`. ' +
  '`is_mountpoint` QUALIFIES EVERYTHING ELSE IN THAT SECTION. False means the ' +
  'path was read but is not a mount point, so the ownership and mode above are ' +
  "THE DIRECTORY SITTING AT THAT PATH rather than the dataset's own root — " +
  'which is what an unmounted dataset looks like from here, and is otherwise ' +
  'indistinguishable from a mounted one. Null is not a false: it is the system ' +
  'having reported no value this tool could read, and it is not evidence ' +
  'either way. ' +
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
    const rows = await firstValueFrom(
      // The filter is inlined so the call's own parameter types apply: written
      // to a `const` first it widens to string[][] and no longer satisfies the
      // filter tuple, as the two tools above note. `retrieve_children` is false
      // because the response already lists every dataset as a top-level entry;
      // what the flag adds is a redundant nesting of each row's descendants
      // underneath it, which is not what the children below are read from.
      system.client.api.query(
        'pool.dataset.query',
        wantChildren ? [] : [['id', '=', dataset]],
        { extra: { retrieve_children: false } },
      ),
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
    // IS — a parent's name followed by "/". Matched here rather than asked for,
    // for the reason above: the check on the response is the control either way,
    // so there is nothing a filter could add. A row whose id could not be read
    // is not matched: it names no dataset, so nothing establishes that it is
    // beneath this one, and including it would put a row in `children` that the
    // caller cannot tell apart from a sibling of the same shape.
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
      // empty list keeps its own meaning: the dataset has no descendants.
      children: wantChildren ? children : null,
      children_limit: wantChildren ? CHILDREN_LIMIT : null,
      // A true here is read off a listing that was itself read in full — the
      // dataset query either answered or took the whole tool down — so a false
      // is the confirmed claim that nothing was dropped rather than a read that
      // went wrong reporting completeness.
      children_truncated: wantChildren ? descendants.length > reported.length : null,
    };
  },
};
