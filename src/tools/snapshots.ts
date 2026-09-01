import type { CallParams } from '@truenas/api-client';
import { firstValueFrom } from 'rxjs';
import { Role } from '@/interfaces';
import { ApiSurface, MutatingTool, ReadOnlyTool, ToolContext } from '@/catalog/tool';
import {
  MAX_TIME_MS,
  MiddlewareDate,
  effectiveLimit,
  errorText,
  numberOrNull,
  recordOrNull,
  textOrNull,
} from '@/tools/common';

/**
 * Snapshots family: the snapshots that exist, taking a new one, cloning one
 * into a new dataset, and protecting one from destruction.
 */

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
 * The options every dataset-existence read in this file is made with.
 *
 * Hoisted, where `storage.ts` inlines its filter and #115 requires a `select`
 * to be inlined: neither reason reaches here. The filter below is still
 * inlined, because written to a `const` it widens to `string[][]` and no longer
 * satisfies the filter tuple; `extra` is typed by the client as an open record,
 * so nothing about it is inferred from the literal and there is nothing to
 * widen. What the hoisting buys is that the options {@link datasetExists} reads
 * with and the ones its plan step names cannot drift apart. The FILTER is still
 * written twice — inlined below for the reason above, and again in
 * {@link datasetReadParams} — so that half is held by the spec instead, which
 * takes the read step back out of the plan and asserts `execute` made its call
 * with it. A plan describing a call the tool does not make is the defect #119
 * is about, and only one of these two halves is closed by construction.
 */
const DATASET_READ_OPTIONS = { extra: { retrieve_children: false, properties: ['used'] } };

/**
 * The two positional params a dataset-existence read reaches the middleware
 * with, for the plan step that names one.
 *
 * `api.query(method, filters, options)` dispatches `[filters, options]`, so a
 * step naming only the filter would show the user a call one argument shorter
 * than the one that runs.
 */
function datasetReadParams(dataset: string): unknown {
  return [[['id', '=', dataset]], DATASET_READ_OPTIONS];
}

/**
 * Whether this system lists a dataset under the name given.
 *
 * The filter is bandwidth and the check on the response is the control: an
 * unrecognised query parameter is dropped rather than refused, so a filter that
 * did not apply comes back as every dataset on the system and is
 * indistinguishable from one that matched everything. Reading the length alone
 * would then answer "it exists" for any name at all — which for the two callers
 * below means a listing that never reports a missing dataset, and a clone plan
 * that refuses every destination.
 */
async function datasetExists(ctx: ToolContext, dataset: string): Promise<boolean> {
  const matches = await firstValueFrom(
    ctx.system.client.api.query('pool.dataset.query', [['id', '=', dataset]], DATASET_READ_OPTIONS),
  );
  return matches.some((row) => stringOrNull(row['id']) === dataset);
}

/**
 * {@link datasetExists} as a failure, for the two tools that need a named
 * dataset to be there. `snapshot_clone` reads the same fact for the opposite
 * question and so calls the guard above directly.
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
  if (!(await datasetExists(ctx, dataset))) {
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
 * {@link MAX_TIME_MS} from `common.ts` is what keeps one absurd creation time
 * from taking the whole listing down with it.
 */

/**
 * A ZFS property as a snapshot row carries it. `pool.snapshot.query` declares
 * the property object it answers with — `rawvalue` as a string, `parsed` as
 * `unknown` — and both are restated `unknown` here, because a declared type is
 * a claim about what the middleware sends rather than about the value received:
 * the guards below are what decide whether either field is a number or a string
 * at all. The same way `storage.ts` restates a dataset's properties.
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
 * Guarded rather than asserted: the client declares `properties` a record, and
 * a row that sends something other than an object is exactly the case an
 * assertion resting on that declaration would have got wrong.
 */
function snapshotProperty(properties: unknown, name: string): unknown {
  return typeof properties === 'object' && properties !== null
    ? (properties as Record<string, unknown>)[name]
    : undefined;
}

/**
 * Whether TrueNAS's own hold tag is on the snapshot, or null where the system
 * reported no hold state this tool can read.
 *
 * The middleware answers `holds` as `{ truenas: 1 }` where that tag is present
 * and `{}` where it is not: a hold placed under any other tag never reaches
 * this field, and the count is normalised to 1 whatever the real refcount is.
 * So `false` is "no `truenas` tag" and NOT "no ZFS hold", which is a weaker
 * claim than the field name makes on its own and is why the description says it
 * before it says anything else about the field.
 *
 * A payload that is not a record — including the field being absent, which is
 * what a system that ignored the `holds` request answers with — is null and
 * never false. That is #93's direction rule: `false` says nothing is protecting
 * this snapshot, and a caller acting on that prunes it.
 */
function heldOf(value: unknown): boolean | null {
  const holds = recordOrNull(value);
  if (holds === null) return null;
  // `Object.hasOwn` and not `in`, which walks the prototype.
  if (!Object.hasOwn(holds, 'truenas')) return false;
  const count = numberOrNull(holds['truenas']);
  return count === null ? null : count > 0;
}

/**
 * An ISO 8601 instant carrying an explicit zone. A string with no zone in it is
 * deliberately not matched: reading one as UTC would be a guess that is
 * confidently off by hours, which is the reading `tasks.ts` refuses for the
 * same reason.
 */
const ZONED_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * When the middleware says the snapshot is due to be removed, in milliseconds
 * since the epoch, or null where it reported no time this tool can read.
 *
 * Two shapes, because the surface and the wire disagree about this one and
 * neither could be checked against a live middleware: the client declares
 * `datetime` a `string`, while a middleware time reaches this repository as the
 * `{ "$date": … }` envelope every other date-reading tool here unwraps. A
 * reading both shapes satisfy is worth more than one written to whichever
 * arrives (#102), and a bare number is accepted beside the envelope for
 * `tasks.ts`'s reason — the envelope exists only to tag a number as a date in
 * transit, and both are epoch milliseconds.
 *
 * Bounded by {@link MAX_TIME_MS} like every other instant this file reports:
 * one absurd removal date must not take the listing down through
 * `toISOString`.
 */
function removalMillis(value: unknown): number | null {
  const raw = typeof value === 'object' && value !== null ? (value as MiddlewareDate).$date : value;
  if (typeof raw === 'number') {
    return Number.isFinite(raw) && Math.abs(raw) <= MAX_TIME_MS ? raw : null;
  }
  if (typeof raw !== 'string' || !ZONED_INSTANT.test(raw)) return null;
  const millis = Date.parse(raw);
  return Number.isFinite(millis) && Math.abs(millis) <= MAX_TIME_MS ? millis : null;
}

/** What the system says is scheduled to remove a snapshot. */
interface ScheduledRemoval {
  at: string | null;
  source: string | null;
  periodic_snapshot_task_id: number | null;
}

/**
 * The removal the middleware annotated the snapshot with, or null where it
 * annotated none.
 *
 * `retention` is `null` on a snapshot no ENABLED periodic snapshot task owns,
 * which is the ordinary answer for one taken by hand, and absent where the
 * system was not asked — so null here covers "nothing will remove it", "the
 * payload could not be read" and "the argument was not passed", and the
 * description says so rather than letting a null read as the first.
 *
 * A record whose `datetime` could not be read is NOT nulled: it still says a
 * removal is scheduled and names its source, where a null would say the
 * opposite. Same direction rule as {@link heldOf}, one level in.
 *
 * `source` is passed through as the system spelled it, so a source a later
 * release adds reaches the caller rather than being flattened; the task id is
 * read by name, and is null on the arm that has none — the snapshot's own
 * removal-date property — exactly as it is on one that could not be read.
 */
function scheduledRemovalOf(value: unknown): ScheduledRemoval | null {
  const retention = recordOrNull(value);
  if (retention === null) return null;
  const millis = removalMillis(retention['datetime']);
  return {
    at: millis === null ? null : new Date(millis).toISOString(),
    // `textOrNull` rather than this file's `stringOrNull`: a source is a name,
    // and an empty one has told the caller nothing.
    source: textOrNull(retention['source']),
    periodic_snapshot_task_id: numberOrNull(retention['periodic_snapshot_task_id']),
  };
}

/**
 * Whether the caller asked for one of the two opt-in fields.
 *
 * Strict, as `snapshots_create` is about `recursive` and `tasks_recent_runs`
 * about `failed_only`. A coerced `"true"` would leave the flag false, the
 * middleware never asked, and every entry reporting null — which is exactly
 * what a system that does not report the field answers with, so the caller
 * could not tell that its argument had been dropped.
 */
function requestedField(raw: unknown, name: string): boolean {
  if (raw == null) return false;
  if (typeof raw !== 'boolean') throw new Error(`"${name}" must be a boolean`);
  return raw;
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
 * The bound this family applies, from whatever the caller asked for.
 *
 * Lenient where {@link requestedDataset} is strict, and what the argument
 * decides is the difference: a misread `dataset` would quietly answer about the
 * wrong snapshots, while a misread `limit` only changes how many of the right
 * ones come back — and the number applied is returned beside them, so a caller
 * can see that its argument was not taken. The bounding is `common.ts`'s; the
 * two numbers are this family's.
 */
function snapshotLimit(raw: unknown): number {
  return effectiveLimit(raw, DEFAULT_LIMIT, MAX_LIMIT);
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
    'references. Each of those four is null where the system reported no ' +
    'value this tool can read, and null is not zero: a snapshot referencing ' +
    'nothing reports `referenced_bytes: 0`. A snapshot with no readable `created` is ' +
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
    'exists. Two further fields say whether a snapshot is protected and ' +
    'whether anything is scheduled to remove it, and both are opt-in: `held` ' +
    'is reported only when `report_held` is true, `scheduled_removal` only ' +
    'when `report_scheduled_removal` is true, and each is null on every entry ' +
    'when its own argument was not passed. `held` REPORTS TRUENAS\'S OWN HOLD ' +
    'TAG AND NOT ANY ZFS HOLD: the system answers whether the `truenas` tag ' +
    'is on the snapshot and nothing else, so a hold placed under a different ' +
    'tag is invisible here and `held: false` means "no `truenas` tag" rather ' +
    'than "nothing is holding this". `scheduled_removal` is the system\'s own ' +
    'computation of when a snapshot is due to be removed rather than a ' +
    're-derivation from task schedules, and it carries `at`, that time as an ' +
    'ISO 8601 UTC timestamp; `source`, what schedules it, as the system ' +
    'spelled it; and `periodic_snapshot_task_id`, the owning task where the ' +
    'source is a periodic snapshot task and null where it is the snapshot\'s ' +
    'own removal-date property. ONLY ENABLED periodic snapshot tasks are ' +
    'considered — a snapshot owned solely by a disabled task reports null, ' +
    'and enabling that task changes the answer — and where several tasks own ' +
    'one snapshot the latest removal time is the one reported. IT DOES NOT ' +
    'ACCOUNT FOR HOLDS: the two fields are independent, and a held snapshot ' +
    'can report a removal time it will survive. `scheduled_removal: null` is ' +
    'the ordinary answer for a snapshot taken by hand, which parses against ' +
    "no task's naming schema and so is scheduled for removal by none, but it " +
    'is also what a snapshot whose retention the system reported unreadably ' +
    'answers with, and what every entry answers with when the argument was ' +
    'not passed — so a null does not on its own establish that nothing will ' +
    'remove the snapshot, and this tool does not separate those three. A ' +
    '`scheduled_removal` whose `at` is null is the other way round: a removal ' +
    'IS scheduled and its time could not be read. `held: null` reads the same ' +
    'way — the argument was not passed, or the hold state could not be read, ' +
    'and never "not held". Both arguments widen the read the system makes ' +
    'over every snapshot it holds, before `limit` bounds anything, so ask for ' +
    'them when they are wanted rather than by default.',
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
      report_held: {
        type: 'boolean',
        default: false,
        description:
          "Also report whether TrueNAS's own hold tag is on each snapshot. " +
          'Default false, which reports `held: null` on every entry. Widens ' +
          'the read the system makes over every snapshot it holds, before ' +
          '`limit` bounds anything.',
      },
      report_scheduled_removal: {
        type: 'boolean',
        default: false,
        description:
          'Also report when an enabled periodic snapshot task is due to ' +
          'remove each snapshot. Default false, which reports ' +
          '`scheduled_removal: null` on every entry. Widens the read the ' +
          'system makes over every snapshot it holds, before `limit` bounds ' +
          'anything.',
      },
    },
  },
  requiredRole: Role.ReadOnly,
  mutating: false,
  async handler(ctx, args) {
    const dataset = requestedDataset(args['dataset']);
    const limit = snapshotLimit(args['limit']);
    // Read before the call, so an unreadable flag is an error rather than a
    // question the system answers and this tool then discards.
    const reportHeld = requestedField(args['report_held'], 'report_held');
    const reportRemoval = requestedField(
      args['report_scheduled_removal'],
      'report_scheduled_removal',
    );
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
          //
          // The two opt-in flags are passed only where the caller asked for
          // the field they produce: each widens the read the middleware makes
          // over every snapshot on the system — `holds` reads the ZFS holds,
          // `retention` reads the user properties and runs zettarepl's
          // annotation pass — and both are applied before this tool's `limit`
          // reaches anything, so the cost is not bounded by it. Their names
          // are the middleware's own and the client types `extra` as an open
          // record, so nothing here is compiler-checked: a misspelling would
          // be dropped rather than refused, and the field would read null on
          // every entry. That is what the tests asserting them populated are
          // for.
          extra: {
            properties: ['creation', 'referenced'],
            ...(reportHeld ? { holds: true } : {}),
            ...(reportRemoval ? { retention: true } : {}),
          },
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
          // Null where the caller did not ask, rather than absent: a key that
          // is not there serializes to no key at all, and the description
          // promises both fields on every entry.
          held: reportHeld ? heldOf(snapshot['holds']) : null,
          scheduled_removal: reportRemoval ? scheduledRemovalOf(snapshot['retention']) : null,
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

/**
 * `snapshot_clone`: the additive route back to a snapshot's data.
 *
 * "Get back the version from before" is the question a snapshot exists to
 * answer, and the obvious route to it — rolling the dataset back — destroys
 * everything written since. A tool composing that is rejected at registration
 * (`catalog/catalog.ts`) and there is none here. Cloning answers the same
 * question additively: the snapshot's contents appear as a new dataset, the
 * original is untouched, and the caller copies out what it needs. This is what
 * lets the catalog decline rollback without declining recovery.
 *
 * WHAT THE PLAN NAMES IS WHAT `execute` CALLS. `pool.snapshot.clone` answers a
 * bare `true` — no entity, so there is nothing to read the outcome off — which
 * places this with `alerts_dismiss` (#119) rather than with
 * `scheduled_task_set_enabled` (#121): `execute` re-reads the destination to
 * establish that the dataset is now there, and the plan names that read as a
 * step. The read runs after the call rather than before it, and the steps are
 * in that order for the same reason they are in `alerts_dismiss` — a plan is a
 * list of the calls `execute` makes, in the order it makes them.
 *
 * PLAN-TIME VALIDATION, AND WHERE IT STOPS. The plan reads the source snapshot
 * to fail on a name no snapshot has, and the destination to fail where a
 * dataset already exists there — the middleware would refuse both, and a plan
 * naming a call certain to fail is a plan wasting an approval. It does NOT
 * check that the destination's parent exists or that the pool has room; those
 * are the middleware's to refuse, and re-implementing them here would be a
 * second opinion that drifts.
 *
 * `dataset_properties` IS DECLARED ON THE CALL AND IS NOT ACCEPTED. It is
 * `{[k: string]: unknown}` — an open record, the same shape and the same reason
 * as `app.upgrade`'s `values`: a tool cannot allowlist what it does not name,
 * and an open record forwarded from a caller is the boundary this repository
 * does not cross. The clone takes the snapshot's own properties.
 *
 * `destructiveness: 'reversible'` RECORDS THE OPERATION, per
 * {@link Destructiveness}'s own declaration. This one is the easy case — the
 * operation adds a dataset and removes nothing, so there is no account of the
 * data to come apart from the field the way `cloudsync_run`'s does. What the
 * description must not do is let that read as "undoing this is easy": undoing a
 * clone means deleting the dataset it made, and no tool here deletes one.
 */

/** The two arguments the tool takes. */
interface CloneArgs {
  snapshot: string;
  destination: string;
}

/**
 * The caller's arguments, or the error naming what is missing.
 *
 * Strict, as `snapshots_create`'s `dataset` is and `alerts_dismiss`'s `uuid`
 * is: neither of these can be read as anything else without cloning a snapshot
 * nobody named, or naming a destination nobody asked for.
 */
function parseCloneArgs(args: Record<string, unknown>): CloneArgs {
  const snapshot = args['snapshot'];
  const destination = args['destination'];
  if (typeof snapshot !== 'string' || snapshot.length === 0) {
    throw new Error('"snapshot" is required');
  }
  if (typeof destination !== 'string' || destination.length === 0) {
    throw new Error('"destination" is required');
  }
  return { snapshot, destination };
}

/**
 * The clone call's own params.
 *
 * `dataset_properties` is optional on the declared argument and is absent here
 * rather than sent empty — an empty record is a request to set nothing, and
 * omitting the key is the tool never having had an opinion.
 */
function cloneParams(args: CloneArgs): CallParams<ApiSurface, 'pool.snapshot.clone'> {
  return [{ snapshot: args.snapshot, dataset_dst: args.destination }];
}

/**
 * Whether this system lists the snapshot the caller named.
 *
 * The response is checked rather than counted, for {@link datasetExists}'s
 * reason: a dropped filter answers with every snapshot on the system, and a
 * length test would then plan a clone of a snapshot that does not exist.
 *
 * BOTH `id` AND `name` ARE COMPARED, AND THE READ ASKS BOTH WAYS. The client
 * declares them as two separate required `string` fields on a snapshot row and
 * states no relationship between them — the same shape as an alert's `uuid` and
 * `id` (#119) — so matching only one of them would fail the plan for a snapshot
 * that is plainly there on a system where they differ. WHETHER
 * `pool.snapshot.clone` ITSELF ACCEPTS EITHER SPELLING IS (unconfirmed): its
 * `snapshot` argument is a bare `string` and the surface states no relationship
 * between the two fields, which is this check's own premise. What the read
 * establishes is that the system lists something under the name given; the
 * string the caller supplied is what `execute` forwards, so a middleware that
 * takes only one of the two would reject at execute time rather than at plan
 * time.
 *
 * The FILTER has to name both fields for that to be true of a read the
 * middleware actually narrowed: filtering on `id` alone and then comparing
 * `name` rescues nothing, because on the system where the two differ and the
 * caller passes the `name` the tool's own description asks for, an honoured
 * `id` filter answers with no row at all and there is nothing left to compare.
 * The disjunction is the client's own declared filter form
 * (`['OR', QueryFilters<T>[]]`), so each arm is a filter LIST rather than a
 * bare condition.
 *
 * The two halves still do different work, and neither replaces the other. The
 * filter is bandwidth and is what a system that honours it narrows on; the
 * comparison is the control, and is what reads a dropped filter's whole-table
 * answer correctly rather than as "every snapshot matches".
 *
 * One property is asked for because this read needs none and the middleware is
 * not documented to read an empty list as "no properties"; a snapshot row
 * otherwise carries every ZFS property of the snapshot, on every row of a
 * listing this filter may not have narrowed.
 */
async function snapshotExists(ctx: ToolContext, snapshot: string): Promise<boolean> {
  const matches = await firstValueFrom(
    ctx.system.client.api.query(
      'pool.snapshot.query',
      [['OR', [[['id', '=', snapshot]], [['name', '=', snapshot]]]]],
      { extra: { properties: ['creation'] } },
    ),
  );
  return matches.some(
    (row) => stringOrNull(row['id']) === snapshot || stringOrNull(row['name']) === snapshot,
  );
}

export const snapshotClone: MutatingTool = {
  name: 'snapshot_clone',
  description:
    'Creates a new ZFS dataset from an existing snapshot, so the data in that ' +
    'snapshot can be read and copied out without altering the dataset it was ' +
    'taken of. Two-phase: called without a confirmation_token it returns a ' +
    'plan for user approval; called with one it creates the clone. THIS ' +
    'DELETES NOTHING AND CHANGES NOTHING THAT EXISTS. The source snapshot and ' +
    'the dataset it was taken of are untouched, and everything written since ' +
    'the snapshot was taken is still there — which is what makes this the ' +
    'route back to a snapshot\'s contents, since rolling a dataset back would ' +
    'discard that work and no tool here does it. THE CLONE PINS THE SNAPSHOT ' +
    'IT CAME FROM: a clone shares its blocks with that snapshot, so the ' +
    'snapshot cannot be destroyed while the clone exists and the space it ' +
    'references stays in use. That reaches retention — a snapshot ' +
    '`snapshots_list` reports a `scheduled_removal` for may still be there ' +
    'after that time once it has been cloned. Standard ZFS refuses to destroy ' +
    'a snapshot with dependent clones; HOW TRUENAS REPORTS A REMOVAL THAT ' +
    'THEN FAILS IS (unconfirmed) here, so what is claimed is the pinning and ' +
    'not the error. `snapshot` is the full `dataset@snapshot` name as ' +
    '`snapshots_list` reports it in `name`; `destination` is the full name of ' +
    'the dataset to create, in the form `storage_list_datasets` reports as ' +
    '`id`. PLANNING FAILS AND NAMES WHAT WAS WRONG in two cases: where this ' +
    'system lists no snapshot under the name given, and where a dataset ' +
    'already exists at the destination. THOSE ARE THE TWO IT CHECKS FOR, not ' +
    'the only two ways planning fails — a malformed argument, or a read that ' +
    'did not complete, fails it too and names neither. Nothing else about the ' +
    "call is checked: whether the destination's parent dataset exists, and " +
    'whether the pool has room, are the middleware\'s to refuse, and this ' +
    'tool does not offer a second opinion about either. ' +
    '`dataset_properties` IS NOT ACCEPTED and none is ' +
    'sent: the clone takes the source snapshot\'s own properties. NOTHING ' +
    'HERE TOUCHES THE CLONE AFTERWARDS — this tool does not promote it, ' +
    'delete it or set anything on it, and no other tool in this catalog does ' +
    'either. From that point it is an ordinary dataset, and ' +
    '`storage_list_datasets` is where it is visible. So `destructiveness: ' +
    "'reversible'` records that this operation removes nothing; it does not " +
    'mean the clone can be undone from here, which would mean deleting the ' +
    'dataset it made. The result reports the two arguments as they were sent, ' +
    'under `snapshot` and `destination`, and what the read immediately after ' +
    'the clone call found: `destination_found` is true where a dataset with ' +
    'that name was listed, false where that read completed and listed none, ' +
    'and NULL WHERE THE READ ITSELF FAILED, with `destination_read_error` ' +
    'naming why and null in the other two cases. A null is not a failed ' +
    'clone — the call had already been accepted by then, and this tool simply ' +
    'could not establish the outcome; `storage_list_datasets` settles it. ' +
    '`destination_found: false` is the one to act on: the call did not reject ' +
    'and the dataset was not there to read back.',
  inputSchema: {
    type: 'object',
    properties: {
      snapshot: {
        type: 'string',
        minLength: 1,
        description:
          'The snapshot to clone, as its full `dataset@snapshot` name — the ' +
          '`name` `snapshots_list` reports, e.g. "tank/media@nightly-1", on ' +
          'the system being targeted.',
      },
      destination: {
        type: 'string',
        minLength: 1,
        description:
          'Full name of the dataset to create, e.g. "tank/media-restore". ' +
          'Must not already exist; planning fails naming it if it does. Its ' +
          'parent must exist, which this tool does not check.',
      },
    },
    required: ['snapshot', 'destination'],
  },
  requiredRole: Role.Full,
  mutating: true,
  destructiveness: 'reversible',
  normalizeArgs(rawArgs) {
    const args = parseCloneArgs(rawArgs);
    // Named one by one, which is also what drops a `dataset_properties` a
    // caller supplied: an unknown key normalized away never reaches `plan`,
    // `execute` or the confirmation key.
    return { snapshot: args.snapshot, destination: args.destination };
  },
  async plan(ctx, rawArgs) {
    const args = parseCloneArgs(rawArgs);
    // Each failure names the argument the caller supplied, because that is the
    // part of it a caller can check. `assertDatasetExists` fails the same way
    // for `snapshots_create`.
    if (!(await snapshotExists(ctx, args.snapshot))) {
      throw new Error(`No snapshot named "${args.snapshot}" on this system`);
    }
    if (await datasetExists(ctx, args.destination)) {
      throw new Error(`A dataset already exists at "${args.destination}"`);
    }
    return [
      {
        method: 'pool.snapshot.clone',
        params: cloneParams(args),
        description:
          `Clone snapshot "${args.snapshot}" into a new dataset ` +
          `"${args.destination}". The snapshot and the dataset it was taken ` +
          'of are not modified and nothing is deleted. The new dataset shares ' +
          'its blocks with the snapshot, which then cannot be destroyed while ' +
          'the clone exists.',
      },
      {
        method: 'pool.dataset.query',
        params: datasetReadParams(args.destination),
        description:
          `Read "${args.destination}" back, to report whether the clone is ` +
          'there. Changes nothing.',
      },
    ];
  },
  async execute(ctx, rawArgs) {
    const args = parseCloneArgs(rawArgs);
    await firstValueFrom(ctx.system.client.api.call('pool.snapshot.clone', cloneParams(args)));
    // Caught rather than thrown: this read exists to describe the outcome, and
    // letting it fail the call would report a clone that was accepted as a
    // failure. Same seam as `alerts_dismiss`'s lookup, on the other side of
    // the mutation.
    let found: boolean | null = null;
    let readError: string | null = null;
    try {
      found = await datasetExists(ctx, args.destination);
    } catch (reason) {
      readError = errorText(reason);
    }
    return {
      snapshot: args.snapshot,
      destination: args.destination,
      destination_found: found,
      destination_read_error: readError,
    };
  },
};

/**
 * `snapshot_set_hold`: the one snapshot mutation that PREVENTS data loss.
 *
 * Deleting a snapshot and rolling a dataset back are both rejected at
 * registration (`catalog/catalog.ts`), so a hold is the only protection this
 * catalog can offer the snapshot an operator would recover from — and the
 * cheapest safety move before anything risky, since retention, a periodic
 * snapshot task or a person can otherwise destroy it while the risky work is
 * still in progress.
 *
 * ONE TOOL WITH A DISCRIMINATOR, WHICH IS #121's TEST AND NOT #97's.
 * `pool.snapshot.hold` and `pool.snapshot.release` take literally the same
 * params — `(id, { recursive })` in, `null` out — so two tools would be two
 * copies of one `plan`/`execute` pair differing in which method is dialled.
 * Nothing is missing from a mutation, so there is no section to be the finding.
 *
 * THE TWO DIRECTIONS ARE NOT SYMMETRIC, AND THAT IS THE FINDING THIS TOOL
 * CARRIES. `hold` adds the `truenas` tag and only that tag; `release` passes no
 * tag at all, which the middleware documents as removing ALL hold tags. So a
 * release removes holds this tool never placed and that `snapshots_list` never
 * reported — its `held` is the `truenas` tag alone (#155). Reporting a narrower
 * effect than the call has is this repository's most common finding pointed at
 * a mutation, so the description and the plan both say it outright.
 *
 * THE METHOD ANSWERS `null`, SO THE OUTCOME IS READ BY RE-READING. That places
 * this with `alerts_dismiss` (#119) rather than `scheduled_task_set_enabled`
 * (#121): there is no updated entity to read the result off, so `execute` reads
 * the hold state, makes the call, and reads it again. `changed` compares the
 * two READINGS — a `changed` derived from the request would report a call the
 * system accepted and did not apply as having changed something.
 *
 * THE PLAN NAMES TWO STEPS AND `execute` MAKES THREE CALLS, AND THAT IS
 * DELIBERATE. The two reads are ONE call — same method, same params, from
 * {@link holdReadParams} — made twice, so listing it twice would show an
 * approver two entries it cannot tell apart. It is named once, and the step's
 * own description says it runs again after the mutation, which is the seam
 * `cloudsync_run` uses for the `core.get_jobs` its tracking issues (#122).
 * Nothing `execute` calls is hidden from the approval, which is what #119 is
 * about.
 *
 * `destructiveness: 'reversible'` RECORDS THE OPERATION: it destroys no data,
 * and what it changes is what may destroy a snapshot later. It is #153's trap
 * one tool over — a release is NOT undoable from here, because setting the hold
 * again places the `truenas` tag and only that tag, so a foreign tag a release
 * removed is restored by nothing in this catalog. The description says so.
 */

/** The three arguments the tool takes. */
interface HoldArgs {
  snapshot: string;
  held: boolean;
  recursive: boolean;
}

/**
 * The caller's arguments, or the error naming what is wrong with them.
 *
 * `held` is required and strict for the reason it exists: it is the whole
 * difference between protecting a snapshot and removing every hold on it, and a
 * coerced `"false"` would release one the caller asked to hold. `recursive` is
 * strict for {@link parseArgs}'s reason — a silently-dropped `recursive` widens
 * or narrows a call the user approved as the other one.
 */
function parseHoldArgs(args: Record<string, unknown>): HoldArgs {
  const snapshot = args['snapshot'];
  if (typeof snapshot !== 'string' || snapshot.length === 0) {
    throw new Error('"snapshot" is required');
  }
  const held = args['held'];
  if (typeof held !== 'boolean') {
    throw new Error('"held" is required and must be a boolean');
  }
  const recursive = args['recursive'];
  if (recursive != null && typeof recursive !== 'boolean') {
    throw new Error('"recursive" must be a boolean');
  }
  return { snapshot, held, recursive: recursive === true };
}

/**
 * The options every hold-state read in this file is made with.
 *
 * Hoisted for {@link DATASET_READ_OPTIONS}'s reason, and with the same half
 * left open: the FILTER is written twice — inlined in {@link readHoldState}
 * because written to a `const` it widens out of the filter tuple, and again in
 * {@link holdReadParams} for the plan step — so a test takes the read step back
 * out of the plan and asserts `execute` made its call with it.
 *
 * `holds: true` is what makes the middleware report hold state at all, and one
 * property is asked for because this read needs none and an empty list is not
 * documented to mean "no properties" — a snapshot row otherwise carries every
 * ZFS property of the snapshot.
 */
const HOLD_READ_OPTIONS = { extra: { properties: ['creation'], holds: true } };

/**
 * The two positional params a hold-state read reaches the middleware with, for
 * the plan step that names one.
 */
function holdReadParams(snapshot: string): unknown {
  return [[['OR', [[['id', '=', snapshot]], [['name', '=', snapshot]]]]], HOLD_READ_OPTIONS];
}

/** What one hold-state read established. */
interface HoldReading {
  /** Whether the system listed a snapshot under the name given. */
  listed: boolean;
  /**
   * TrueNAS's own hold tag, as {@link heldOf} reads it — null both where the
   * snapshot was not listed and where it was listed and reported no hold state
   * this tool can read.
   */
  held: boolean | null;
}

/**
 * The hold state this system reports for the snapshot named.
 *
 * Both declared name fields are compared and the read asks both ways, for
 * {@link snapshotExists}'s reason: `id` and `name` are two separate required
 * strings with no stated relationship, and the response is checked rather than
 * counted because a dropped filter answers with every snapshot on the system.
 * Reading the first row of that would report a different snapshot's holds.
 */
async function readHoldState(ctx: ToolContext, snapshot: string): Promise<HoldReading> {
  const matches = await firstValueFrom(
    ctx.system.client.api.query(
      'pool.snapshot.query',
      [['OR', [[['id', '=', snapshot]], [['name', '=', snapshot]]]]],
      HOLD_READ_OPTIONS,
    ),
  );
  const row = matches.find(
    (candidate) =>
      stringOrNull(candidate['id']) === snapshot || stringOrNull(candidate['name']) === snapshot,
  );
  return row === undefined
    ? { listed: false, held: null }
    : { listed: true, held: heldOf(row['holds']) };
}

/** What a hold-state read did, where the reading alone cannot say. */
function lookupOf(reading: HoldReading | null, error: string | null): string {
  if (error !== null) return 'UNREADABLE';
  return reading !== null && reading.listed ? 'FOUND' : 'NOT_FOUND';
}

/**
 * What the plan says the call will do to the snapshot, given the state it is in
 * now.
 *
 * Three cases and not two, as `alerts_dismiss`'s is: a snapshot whose hold
 * state could not be read is neither already there nor about to move. The
 * already-released case carries the asymmetry rather than reading as a no-op —
 * "it is not held, so this changes nothing" would be the tool claiming to know
 * about tags it cannot see.
 *
 * `recursive` is taken here for that same reason, one scope out.
 * {@link readHoldState} reads the one snapshot named and the call reaches every
 * child of it, so an already-held snapshot rendered as "this changes nothing"
 * tells an approver a call is a no-op while it places a hold on every child
 * that carries no tag — a state read off one snapshot restated as a guarantee
 * about the operation, in the one text a person reads before approving. Each
 * sentence therefore names the snapshot it is about and says outright that the
 * children were not read; none of them can say more than that, because nothing
 * here read them.
 */
function holdEffectSentence(current: boolean | null, target: boolean, recursive: boolean): string {
  // Spelled out rather than "it" on a recursive call: the scope sentence before
  // this one has just said the call reaches more than the snapshot named, which
  // is what makes the pronoun read as the whole operation.
  const subject = recursive ? 'The snapshot named' : 'It';
  const scope = recursive ? ' for the snapshot named' : '';
  const unread = recursive
    ? " Its children's hold state was not read, so nothing here says what this does to them."
    : '';
  if (current === null) {
    return (
      `Whether TrueNAS's hold tag is on ${recursive ? 'the snapshot named' : 'it'} could not ` +
      `be read, so this may change nothing${scope}.${unread}`
    );
  }
  if (target) {
    return current
      ? `${subject} already carries that tag, so this changes nothing${scope} and is not an error.${unread}`
      : `${subject} carries no \`truenas\` tag, so this will place one.${unread}`;
  }
  return current
    ? `${subject} carries that tag, so this will remove it, along with any other hold tag on it.${unread}`
    : `${subject} carries no \`truenas\` tag, so this is not an error — but a hold placed ` +
        `under any other tag would still be removed, and this catalog cannot see one.${unread}`;
}

/** The scope a recursive call reaches, for the plan step that names it. */
function recursiveSentence(recursive: boolean): string {
  return recursive
    ? ' RECURSIVELY: this is applied to the snapshot\'s children as well as to it, ' +
        'so it reaches more than the one snapshot named.'
    : '';
}

export const snapshotSetHold: MutatingTool = {
  name: 'snapshot_set_hold',
  description:
    "Places or removes TrueNAS's hold on one ZFS snapshot, so the snapshot can " +
    'be protected from destruction or released again. Two-phase: called ' +
    'without a confirmation_token it returns a plan for user approval; called ' +
    'with one it sets the hold. A hold is the cheapest protection available ' +
    'here for the snapshot an operator would recover from — this catalog has ' +
    'no tool that deletes a named snapshot or rolls a dataset back, but ' +
    'retention, a periodic snapshot task or a person can still destroy one, ' +
    'and `snapshot_task_run` triggers a retention pass that does exactly that. ' +
    '`snapshot` is the full `dataset@snapshot` name as `snapshots_list` ' +
    'reports it in `name`, on the system being targeted. `held` says which of ' +
    'the two to do and is required: true places the hold, false removes it. ' +
    '`held: false` REMOVES EVERY HOLD TAG ON THE SNAPSHOT, NOT ONLY ' +
    "TRUENAS'S. The two directions are not symmetric — placing a hold adds the " +
    '`truenas` tag and only that tag, while removing one asks the system to ' +
    'remove all hold tags, including any placed outside TrueNAS, by another ' +
    'tool or by hand, which `snapshots_list` never reported and this tool ' +
    "cannot see. `recursive` applies the same operation to the snapshot's " +
    'children as well as to it, and a recursive release is the widest form of ' +
    'that: it can remove holds this catalog never reported, on snapshots it ' +
    'never named. Default false. PLANNING FAILS, NAMING THE SNAPSHOT, where ' +
    'this system lists no snapshot under the name given. WHETHER A HOLD ' +
    'ACTUALLY STOPS RETENTION DESTROYING THE SNAPSHOT IS (unconfirmed) HERE: a ' +
    'ZFS hold makes the destroy itself fail, and `snapshots_list`\'s ' +
    '`scheduled_removal` does not account for holds, so a held snapshot can ' +
    'report a removal time and the removal can still be attempted — but how ' +
    'TrueNAS reports or recovers from a destroy that fails was not read off a ' +
    'live system and is not claimed here. SETTING A HOLD ON AN ALREADY-HELD ' +
    'SNAPSHOT IS NOT AN ERROR, and neither is releasing one that is not held; ' +
    'the plan says which of the two it is about to do. The result reports ' +
    '`requested_held`, what was asked for; `previously_held`, the state read ' +
    'immediately before the call; `resulting_held`, the state read immediately ' +
    'after it; and `changed`, those two readings compared rather than the ' +
    'request. ALL THREE ARE READ FROM THE SNAPSHOT NAMED AND ESTABLISH NOTHING ' +
    'ABOUT ITS CHILDREN, so on a recursive call `changed` is not a statement ' +
    'about what the call reached: a recursive hold of an already-held snapshot ' +
    'reports `changed: false` having placed holds on children, and a recursive ' +
    'release reports what it removed from the snapshot named and nothing about ' +
    "the rest. EACH READING IS TRUENAS'S OWN HOLD TAG AND NOT ANY ZFS HOLD, the " +
    'same reading `snapshots_list` reports as `held`: the system answers ' +
    'whether the `truenas` tag is on the snapshot and nothing else, so ' +
    '`previously_held: false` means "no `truenas` tag" rather than "nothing ' +
    'was holding this". A `changed: false` ON A RELEASE THEREFORE DOES NOT ' +
    'MEAN NOTHING WAS REMOVED — a hold under another tag is invisible to both ' +
    'readings and would still have been removed. `previous_lookup` and ' +
    '`resulting_lookup` say what each read did: `FOUND` is a read that named ' +
    'this snapshot, `NOT_FOUND` a read that completed and listed none under ' +
    'this name, and `UNREADABLE` a read that failed, with ' +
    '`previous_read_error` and `resulting_read_error` naming why and null in ' +
    'the other two cases. EACH HAS THREE VALUES AND ITS READING HAS FOUR ' +
    'CAUSES FOR A NULL: the two failures above, and ALSO `FOUND` where the ' +
    'snapshot was listed and reported no hold state this tool could read. So a ' +
    'lookup alone does not tell them apart, and `FOUND` beside a null reading ' +
    'is that fourth case. `changed` IS NULL WHERE EITHER READING IS, WHICH IS ' +
    'NOT "NOTHING CHANGED". THE CALL IS MADE IN ALL OF THOSE CASES, because ' +
    'what runs must be what was approved — and a read that failed after it is ' +
    'not a failed call: the mutation had already landed and this tool simply ' +
    'could not establish the outcome. `snapshots_list` with `report_held` ' +
    "settles it. `destructiveness: 'reversible'` records that this operation " +
    'destroys no data; it changes what may destroy a snapshot later and ' +
    'destroys nothing itself. IT DOES NOT MEAN A RELEASE CAN BE UNDONE FROM ' +
    'HERE: setting the hold again places the `truenas` tag and only that tag, ' +
    'so any other tag a release removed is restored by nothing in this catalog.',
  inputSchema: {
    type: 'object',
    properties: {
      snapshot: {
        type: 'string',
        minLength: 1,
        description:
          'The snapshot to hold or release, as its full `dataset@snapshot` ' +
          'name — the `name` `snapshots_list` reports, e.g. ' +
          '"tank/media@nightly-1", on the system being targeted.',
      },
      held: {
        type: 'boolean',
        description:
          "True places TrueNAS's hold on the snapshot; false removes the " +
          'holds on it. FALSE REMOVES EVERY HOLD TAG, including any placed ' +
          'outside TrueNAS that this catalog never reported.',
      },
      recursive: {
        type: 'boolean',
        default: false,
        description:
          "Apply the same operation to the snapshot's children as well as to " +
          'it. Default false.',
      },
    },
    required: ['snapshot', 'held'],
  },
  requiredRole: Role.Full,
  mutating: true,
  destructiveness: 'reversible',
  normalizeArgs(rawArgs) {
    const args = parseHoldArgs(rawArgs);
    return { snapshot: args.snapshot, held: args.held, recursive: args.recursive };
  },
  async plan(ctx, rawArgs) {
    const args = parseHoldArgs(rawArgs);
    const reading = await readHoldState(ctx, args.snapshot);
    // The failure names the argument the caller supplied, because that is the
    // part of it a caller can check. `snapshot_clone` fails the same way.
    if (!reading.listed) {
      throw new Error(`No snapshot named "${args.snapshot}" on this system`);
    }
    return [
      {
        method: 'pool.snapshot.query',
        params: holdReadParams(args.snapshot),
        description:
          `Read the hold state of "${args.snapshot}", to report whether it was ` +
          'already in the state this call moves it to. Changes nothing. This ' +
          'same read is made again immediately after the call, to report the ' +
          'state that resulted.',
      },
      {
        method: args.held ? 'pool.snapshot.hold' : 'pool.snapshot.release',
        params: [args.snapshot, { recursive: args.recursive }],
        description:
          (args.held
            ? `Place TrueNAS's hold on snapshot "${args.snapshot}".`
            : `Remove the holds on snapshot "${args.snapshot}". THIS REMOVES EVERY ` +
              'HOLD TAG ON IT, including any placed outside TrueNAS that this ' +
              'catalog never reported.') +
          recursiveSentence(args.recursive) +
          ' ' +
          holdEffectSentence(reading.held, args.held, args.recursive),
      },
    ];
  },
  async execute(ctx, rawArgs) {
    const args = parseHoldArgs(rawArgs);
    // Caught rather than thrown, as `alerts_dismiss`'s lookup is: this read
    // exists to describe the outcome, and letting it fail the call would lose
    // an approval the user has already given for a mutation that is still safe
    // to make.
    let previous: HoldReading | null = null;
    let previousError: string | null = null;
    try {
      previous = await readHoldState(ctx, args.snapshot);
    } catch (reason) {
      previousError = errorText(reason);
    }
    // Unconditional, whatever the read said. Branching on state read at
    // execution time is what the confirmation token cannot bind.
    await firstValueFrom(
      args.held
        ? ctx.system.client.api.call('pool.snapshot.hold', [
            args.snapshot,
            { recursive: args.recursive },
          ])
        : ctx.system.client.api.call('pool.snapshot.release', [
            args.snapshot,
            { recursive: args.recursive },
          ]),
    );
    // The mutation has landed by here, so this read may not fail the tool
    // either — the result says the resulting state could not be established.
    let resulting: HoldReading | null = null;
    let resultingError: string | null = null;
    try {
      resulting = await readHoldState(ctx, args.snapshot);
    } catch (reason) {
      resultingError = errorText(reason);
    }
    const previouslyHeld = previous?.held ?? null;
    const resultingHeld = resulting?.held ?? null;
    return {
      snapshot: args.snapshot,
      requested_held: args.held,
      recursive: args.recursive,
      previous_lookup: lookupOf(previous, previousError),
      previous_read_error: previousError,
      previously_held: previouslyHeld,
      resulting_lookup: lookupOf(resulting, resultingError),
      resulting_read_error: resultingError,
      resulting_held: resultingHeld,
      // Both readings or nothing.
      changed:
        previouslyHeld === null || resultingHeld === null ? null : previouslyHeld !== resultingHeld,
    };
  },
};
