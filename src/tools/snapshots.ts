import type { CallParams } from '@truenas/api-client';
import { firstValueFrom } from 'rxjs';
import { Role } from '@/interfaces';
import { ApiSurface, MutatingTool, ReadOnlyTool, ToolContext } from '@/catalog/tool';

/** Snapshots family: the snapshots that exist, and taking a new one. */

/**
 * The one mutating tool in the sketch — exists to exercise the two-phase
 * plan/confirm flow end to end. Snapshot creation is cheap and reversible
 * (snapshots can be deleted), making it the safest possible mutation.
 */

interface SnapshotArgs {
  dataset: string;
  name: string;
  recursive: boolean;
}

function parseArgs(args: Record<string, unknown>): SnapshotArgs {
  const dataset = args['dataset'];
  const name = args['name'];
  if (typeof dataset !== 'string' || dataset.length === 0) {
    throw new Error('"dataset" is required');
  }
  if (typeof name !== 'string' || name.length === 0) {
    throw new Error('"name" is required');
  }
  // Strict: silently coercing "true" or 1 to false would create a flat
  // snapshot the user approved as recursive (or vice versa) — the plan and
  // the execution must stay honestly aligned.
  const recursive = args['recursive'];
  if (recursive != null && typeof recursive !== 'boolean') {
    throw new Error('"recursive" must be a boolean');
  }
  return { dataset, name, recursive: recursive === true };
}

function createParams(args: SnapshotArgs): CallParams<ApiSurface, 'pool.snapshot.create'> {
  return [{ dataset: args.dataset, name: args.name, recursive: args.recursive }];
}

/**
 * Existence check for a dataset the caller named. Both tools in this family
 * use it, for different reasons.
 *
 * For `snapshots_create` it is a plan-time check and advisory by design:
 * execute deliberately does not re-check (the "pure function of (args,
 * system)" contract), so a dataset deleted between approval and confirm
 * surfaces as a safe API error at execute time.
 *
 * For `snapshots_list` it is what separates a dataset that does not exist from
 * one that simply holds no snapshots, and it runs only once the listing has
 * come back empty.
 */
async function assertDatasetExists(ctx: ToolContext, dataset: string): Promise<void> {
  const matches = await firstValueFrom(
    ctx.system.client.api.query('pool.dataset.query', [['id', '=', dataset]], {
      extra: { retrieve_children: false, properties: ['used'] },
    }),
  );
  if (matches.length === 0) {
    throw new Error(`Dataset "${dataset}" does not exist`);
  }
}

export const createSnapshot: MutatingTool = {
  name: 'snapshots_create',
  description:
    'Creates a ZFS snapshot of a dataset. Two-phase: called without a ' +
    'confirmation_token it returns a plan for user approval; called with one ' +
    'it creates the snapshot.',
  inputSchema: {
    type: 'object',
    properties: {
      dataset: {
        type: 'string',
        description: 'Dataset to snapshot, e.g. "tank/media".',
      },
      name: {
        type: 'string',
        description: 'Snapshot name, e.g. "before-cleanup".',
      },
      recursive: {
        type: 'boolean',
        description: 'Also snapshot child datasets. Default false.',
      },
    },
    required: ['dataset', 'name'],
  },
  requiredRole: Role.Full,
  mutating: true,
  destructiveness: 'reversible',
  normalizeArgs(rawArgs) {
    const args = parseArgs(rawArgs);
    return { dataset: args.dataset, name: args.name, recursive: args.recursive };
  },
  async plan(ctx, rawArgs) {
    const args = parseArgs(rawArgs);
    await assertDatasetExists(ctx, args.dataset);
    return [
      {
        method: 'pool.snapshot.create',
        params: createParams(args),
        description:
          `Create snapshot "${args.dataset}@${args.name}"` +
          (args.recursive ? ' recursively (including child datasets)' : ''),
      },
    ];
  },
  async execute(ctx, rawArgs) {
    const args = parseArgs(rawArgs);
    const snapshot = await firstValueFrom(
      ctx.system.client.api.call('pool.snapshot.create', createParams(args)),
    );
    return { created: snapshot['name'] };
  },
};

/**
 * How many snapshots `snapshots_list` returns when the caller names no bound,
 * and the most it returns however large a bound is asked for.
 *
 * A nightly task on a dozen datasets holds tens of thousands of snapshots
 * within a year, and the whole set is neither answerable inside a model's
 * context nor useful once it is there. Both numbers are stated in the tool's
 * description, and the bound actually applied comes back with the result, so a
 * caller never has to infer which one was in force.
 */
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;

/**
 * The largest instant a `Date` can hold. `toISOString` throws beyond it rather
 * than answering, so one absurd creation time would otherwise take the whole
 * listing down with it.
 */
const MAX_TIME_MS = 8.64e15;

/**
 * A ZFS property as a snapshot row carries it. `pool.snapshot.query` answers
 * rows typed `Record<string, unknown>`, so every field of a property arrives as
 * `unknown` and is restated here — the same way `storage.ts` restates a
 * dataset's properties.
 */
interface SnapshotProperty {
  rawvalue?: unknown;
  parsed?: unknown;
}

/**
 * When the snapshot was taken, in milliseconds since the epoch, or null where
 * the system reported no time this tool can read.
 *
 * ZFS reports `creation` as whole seconds since the epoch and `rawvalue` is
 * that number as ZFS itself states it, so the raw value is what is read here.
 * `parsed` is the middleware's own rendering of the same instant, whose format
 * has differed between releases; converting the raw seconds once is what lets
 * the description promise one timestamp format rather than pass a string
 * through.
 *
 * Milliseconds rather than the formatted string, because this is also what
 * orders the result — a snapshot has no second field that places it in time.
 */
function creationMillis(property: unknown): number | null {
  const raw = (property as SnapshotProperty | undefined)?.rawvalue;
  // Digits or nothing: `Number('')` is 0, which would report a snapshot whose
  // creation time is an empty string as one taken at the epoch.
  const seconds =
    typeof raw === 'number'
      ? raw
      : typeof raw === 'string' && /^-?\d+$/.test(raw)
        ? Number(raw)
        : null;
  if (seconds === null || !Number.isFinite(seconds)) return null;
  const millis = seconds * 1000;
  return Number.isFinite(millis) && Math.abs(millis) <= MAX_TIME_MS ? millis : null;
}

/**
 * The numeric value of a byte-count property, or null where the middleware
 * reported none.
 *
 * The same reading `storage.ts` applies to a dataset's properties, and null for
 * the same reason: a snapshot whose size could not be read must not report as
 * one holding nothing. Local to this file, as `orNull` is to `pools.ts` — the
 * two families read different payloads that happen to share ZFS's property
 * shape, and sharing two lines would couple them.
 */
function propertyBytes(property: unknown): number | null {
  const parsed = (property as SnapshotProperty | undefined)?.parsed;
  return typeof parsed === 'number' && Number.isFinite(parsed) ? parsed : null;
}

/**
 * A field the middleware sent as a string, or null where it sent something
 * else. Both fields read this way name the snapshot rather than measure it, so
 * there is nothing to coerce: a name that is not a string is not a name.
 *
 * Named for what it does rather than `orNull`, which `pools.ts` already uses
 * for a different reading — that one takes an already-typed `string | null |
 * undefined` and defaults it, where this one is the guard that decides whether
 * an `unknown` is a string at all.
 */
function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/**
 * One entry of a snapshot's `properties` map, or undefined where the row
 * carries no map to read it from.
 *
 * Guarded rather than asserted: `properties` arrives as `unknown` and a row
 * that sends something other than an object is exactly the case the assertion
 * would have got wrong.
 */
function snapshotProperty(properties: unknown, name: string): unknown {
  return typeof properties === 'object' && properties !== null
    ? (properties as Record<string, unknown>)[name]
    : undefined;
}

/**
 * The dataset to restrict the listing to, or null for every dataset.
 *
 * Strict where {@link effectiveLimit} is lenient. A `dataset` argument that is
 * not a dataset name cannot be read as "all of them" without answering a
 * question nobody asked — the caller asked about one dataset, and a system-wide
 * list is a wrong answer rather than a broad one.
 */
function requestedDataset(raw: unknown): string | null {
  if (raw == null) return null;
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new Error('"dataset" must be a non-empty string');
  }
  return raw;
}

/**
 * The bound actually applied, from whatever the caller asked for.
 *
 * Lenient where {@link requestedDataset} is strict, and what the argument
 * decides is the difference: a misread `dataset` would quietly answer about the
 * wrong snapshots, while a misread `limit` only changes how many of the right
 * ones come back — and the number applied is returned beside them, so a caller
 * can see that its argument was not taken.
 */
function effectiveLimit(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return DEFAULT_LIMIT;
  // Rounded down because a fractional limit reaches the middleware as one, and
  // floored at 1 because a limit of zero or less would return nothing while
  // reporting the system as holding more — true, and not an answer.
  return Math.min(MAX_LIMIT, Math.max(1, Math.floor(raw)));
}

/** Newest first; a snapshot whose creation time could not be read goes last. */
function byNewestFirst(a: { created: number | null }, b: { created: number | null }): number {
  if (a.created === null) return b.created === null ? 0 : 1;
  if (b.created === null) return -1;
  return b.created - a.created;
}

/**
 * The snapshots that exist.
 *
 * `snapshots_create` can make a snapshot and nothing in the catalog could see
 * one, which is a safety gap as much as a capability gap: the plan/confirm flow
 * shows the call about to run, and neither the user nor the model could check
 * whether last night's snapshot is there or whether the name collides with one
 * already taken.
 */
export const snapshotsList: ReadOnlyTool = {
  name: 'snapshots_list',
  description:
    'Lists the ZFS snapshots that exist, optionally for one dataset, newest ' +
    'first. Each entry carries `name`, the full `dataset@snapshot` name; ' +
    '`dataset`, the dataset the snapshot was taken of, which matches `id` in ' +
    '`storage_list_datasets`; `created`, when it was taken, as an ISO 8601 ' +
    'UTC timestamp; and `referenced_bytes`, the data that snapshot ' +
    'references. Each of the four is null where the system reported no value ' +
    'this tool can read, and null is not zero: a snapshot referencing nothing ' +
    'reports `referenced_bytes: 0`. A snapshot with no readable `created` is ' +
    'ordered last rather than first. Pass `dataset` to list only that ' +
    "dataset's snapshots; a dataset that does not exist is an error naming " +
    'it, so an empty list always means that dataset has no snapshots rather ' +
    'than that it is not there. The result is bounded: `snapshots` holds at ' +
    'most `limit` entries — 100 by default and 1000 at most, and the `limit` ' +
    'returned is the bound actually applied — while `truncated` is true when ' +
    'the system holds more snapshots than were returned. The newest-first ' +
    'order applies to the entries returned. Which snapshots those are, when ' +
    '`truncated` is true, is the system\'s own choice and is not necessarily ' +
    'the newest ones it holds — so a truncated list is evidence about the ' +
    'snapshots it names and about nothing else: it cannot show that a ' +
    'snapshot is absent. Narrow it with `dataset`, or raise `limit`, until ' +
    '`truncated` is false, and only then read the list as everything that ' +
    'exists.',
  inputSchema: {
    type: 'object',
    properties: {
      dataset: {
        type: 'string',
        minLength: 1,
        description: 'Only list snapshots of this dataset, e.g. "tank/media".',
      },
      limit: {
        type: 'number',
        minimum: 1,
        maximum: 1000,
        default: 100,
        description: 'Return at most this many snapshots. Default 100, maximum 1000.',
      },
    },
  },
  requiredRole: Role.ReadOnly,
  mutating: false,
  async handler(ctx, args) {
    const dataset = requestedDataset(args['dataset']);
    const limit = effectiveLimit(args['limit']);
    const snapshots = await firstValueFrom(
      // Filters and options are inlined so the call's own parameter types
      // apply, as in `storage.ts`.
      ctx.system.client.api.query(
        'pool.snapshot.query',
        dataset === null ? [] : [['dataset', '=', dataset]],
        {
          // No `order_by`, deliberately. The system applies the bound, so what
          // it is asked to sort on would decide WHICH snapshots a truncated
          // list holds — and no field of a snapshot row orders it in time
          // soundly. `createtxg` is a string, so a pool whose transaction
          // groups have crossed a digit boundary sorts 999999 after 1000000;
          // it is also the transaction group on the system holding the
          // snapshot, so on a replication target it orders by when each
          // snapshot was RECEIVED rather than when it was taken. The creation
          // time itself is nested inside `properties` behind a dotted path.
          // Asking for an order that is wrong in those cases would be worse
          // than asking for none: the description could then claim a truncated
          // list holds the newest snapshots, and on those systems it would not.
          //
          // One more row than the bound. That extra row is what says the system
          // held more than fit; it is counted and then dropped.
          limit: limit + 1,
          // Only the two properties this tool reports. A snapshot row
          // otherwise carries every ZFS property of the snapshot, on every row.
          extra: { properties: ['creation', 'referenced'] },
        },
      ),
    );
    // Only when the listing is empty, and only when a dataset was named: the
    // query answers an empty list for a dataset that does not exist exactly as
    // it does for one that has never been snapshotted, and those are different
    // answers. A dataset that has snapshots still costs one call.
    if (snapshots.length === 0 && dataset !== null) {
      await assertDatasetExists(ctx, dataset);
    }
    const rows = snapshots.slice(0, limit).map((snapshot) => {
      const properties = snapshot['properties'];
      const created = creationMillis(snapshotProperty(properties, 'creation'));
      return {
        created,
        row: {
          name: stringOrNull(snapshot['name']),
          dataset: stringOrNull(snapshot['dataset']),
          created: created === null ? null : new Date(created).toISOString(),
          referenced_bytes: propertyBytes(snapshotProperty(properties, 'referenced')),
        },
      };
    });
    return {
      // The order is this tool's own, taken on the creation time it reports,
      // so that what a caller reads is ordered by a field it can see. It
      // orders the window rather than choosing it — which is why the
      // description scopes the ordering to the entries returned.
      snapshots: rows.sort(byNewestFirst).map((entry) => entry.row),
      truncated: snapshots.length > limit,
      limit,
    };
  },
};
