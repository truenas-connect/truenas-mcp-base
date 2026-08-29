import { firstValueFrom } from 'rxjs';
import { Role } from '@/interfaces';
import { ReadOnlyTool } from '@/catalog/tool';

/**
 * Replication family: the replication tasks that exist and how their last run
 * went.
 *
 * `snapshots_list` shows the snapshots a system holds, which is what a task
 * replicates and not whether it did. Replication is the difference between a
 * snapshot and a backup, and a task that has been failing quietly for weeks
 * looks, from the source system alone, exactly like one that is working — the
 * snapshots are all there either way. The task's own state record is the only
 * place that difference is visible.
 */

/**
 * The two states that describe a run that has ENDED, and so the only two under
 * which the recorded time is a finish time.
 *
 * The system holds one state record per task, carrying the state and the
 * instant that state was recorded. Under `RUNNING` that instant is when the
 * current run began, and under `PENDING` or `HOLD` it is when the task entered
 * that state — reporting any of them as `finished_at` would name a real
 * timestamp as something it is not, which is worse than reporting none.
 */
const ENDED_STATES = new Set(['FINISHED', 'ERROR']);

/**
 * The largest instant a `Date` can hold. `toISOString` throws beyond it rather
 * than answering, so one absurd recorded time would otherwise take the whole
 * listing down with it — the same guard `snapshots.ts` applies to a creation
 * time.
 */
const MAX_TIME_MS = 8.64e15;

/**
 * The state record a replication task carries, restated with every field
 * optional and untyped.
 *
 * The client declares `state` as `{ [k: string]: unknown }` — an open record
 * naming nothing — so every field of it arrives as `unknown`, the same way a
 * ZFS property does in `storage.ts` and a scan record does in `pools.ts`. Only
 * the three fields read here are named.
 */
interface RunState {
  state?: unknown;
  datetime?: unknown;
  error?: unknown;
}

/**
 * A time as the middleware sends one: `{ "$date": <epoch milliseconds> }`,
 * which is the only date representation the client's own types declare
 * (`TrueNasDate`). Restated with `$date` untyped because it arrives inside an
 * open record.
 */
interface MiddlewareDate {
  $date?: unknown;
}

/**
 * The task's state record, or null where the row carries nothing to read it
 * from.
 *
 * Guarded rather than asserted: the record arrives as `unknown`, and a row that
 * sends something other than an object is exactly the case an assertion would
 * have got wrong.
 */
function runState(state: unknown): RunState | null {
  return typeof state === 'object' && state !== null ? (state as RunState) : null;
}

/**
 * The instant a state was recorded, in milliseconds since the epoch, or null
 * where the system reported no time this tool can read.
 *
 * A bare number is accepted beside the `{ "$date": … }` envelope because the
 * envelope exists only to tag a number as a date in transit; both are epoch
 * milliseconds. Anything else — a formatted string, a date in another shape —
 * is not read rather than guessed at, because guessing wrong about a timezone
 * produces a timestamp that is confidently off by hours.
 */
function stateMillis(datetime: unknown): number | null {
  const raw =
    typeof datetime === 'object' && datetime !== null
      ? (datetime as MiddlewareDate).$date
      : datetime;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return null;
  return Math.abs(raw) <= MAX_TIME_MS ? raw : null;
}

/**
 * The state of the task's last run: the system's own state string, or
 * `NEVER_RUN`, or null.
 *
 * `NEVER_RUN` is what the tool exists to keep separate from a failure. A task
 * the system has never run reports `PENDING` with no time recorded against it,
 * because the state record is created with the task and nothing has replaced it
 * — so the absence of a recorded time is the evidence, and a task that is
 * pending *again* after running carries the time it entered that state. That is
 * a reading of what the system sends rather than a guarantee it makes: the
 * field is untyped, so `PENDING` with a time is reported as plain `PENDING`,
 * which is true either way.
 *
 * Null is neither of those. It is a task whose state could not be read at all —
 * no record, or a record naming no state — and it must not read as a task that
 * has never run, which is a fact about the task rather than about this tool.
 *
 * Any other state is passed through as the system spelled it, so a state a
 * later TrueNAS release adds reaches the caller rather than being flattened
 * into one of these.
 */
function lastRunState(state: RunState | null): string | null {
  if (state === null) return null;
  const reported = state.state;
  if (typeof reported !== 'string' || reported.length === 0) return null;
  return reported === 'PENDING' && state.datetime == null ? 'NEVER_RUN' : reported;
}

/**
 * When the last run ended, as an ISO 8601 UTC timestamp, or null where nothing
 * this tool can read says a run ended.
 *
 * The state must be one that describes an ended run — see {@link ENDED_STATES}
 * — before the recorded time is read as a finish time at all.
 */
function finishedAt(state: RunState | null, reported: string | null): string | null {
  if (state === null || reported === null || !ENDED_STATES.has(reported)) return null;
  const millis = stateMillis(state.datetime);
  return millis === null ? null : new Date(millis).toISOString();
}

/**
 * The error text recorded with the state, or null where none was recorded.
 *
 * An empty string is read as no text rather than as an error message of no
 * characters: it names nothing a caller could act on, and reporting it beside
 * an `ERROR` state would suggest the reason is available when it is not.
 */
function errorText(state: RunState | null): string | null {
  const error = state?.error;
  return typeof error === 'string' && error.length > 0 ? error : null;
}

/**
 * The datasets a task replicates from, as the strings among whatever the system
 * sent.
 *
 * The client types this a non-empty tuple of strings, which the middleware
 * enforces on creation; the guard is for a row that does not honour it, where
 * an entry that is not a dataset name is not a dataset and an absent list
 * leaves nothing to report rather than taking the listing down.
 */
function sourceDatasets(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry) => typeof entry === 'string') : [];
}

export const replicationStatus: ReadOnlyTool = {
  name: 'replication_status',
  description:
    'Every replication task on the system and how its last run went. `name` ' +
    "is the task's own name and `id` its numeric identity. `direction` is " +
    '`PUSH`, replicating from this system outwards, or `PULL`, replicating ' +
    'onto it; `source_datasets` are the datasets replicated from and ' +
    '`target_dataset` the one replicated to, so on a `PUSH` the sources are ' +
    'local and on a `PULL` the target is. `transport` is how the data travels ' +
    '— `SSH`, `SSH+NETCAT` or `LOCAL`. `enabled` is whether the task is ' +
    'switched on, and is null where the system reported no value; a disabled ' +
    'task is still listed, because a task nobody switched back on is exactly ' +
    'the one worth finding. `state` is one of: `FINISHED`, a run that ' +
    'completed; `ERROR`, one that failed; `RUNNING`, one going on now; ' +
    '`PENDING`, one waiting to run; `HOLD`, one the system is holding back; ' +
    '`NEVER_RUN`, a task the system holds no record of having run; and null, ' +
    'a task whose state could not be read at all. Those last two are ' +
    'different answers and neither is a failure: `NEVER_RUN` is a task that ' +
    'has not replicated anything yet, while null says only that this tool ' +
    'could not tell — a task in either state has not been shown to be ' +
    'working. A state a later TrueNAS release adds is passed through as the ' +
    'system spelled it, so `state` is not limited to that list. `finished_at` ' +
    'is when the last run ended, as an ISO 8601 UTC timestamp. It is reported ' +
    'only under `FINISHED` and `ERROR`, the two states that describe a run ' +
    'that ended, and is null under every other state including `RUNNING` — ' +
    'the system records one time per task, and under `RUNNING` that time is ' +
    'when the current run started rather than when anything finished. ' +
    '`error` is the error text recorded with the state and is null where none ' +
    'was recorded, so it carries the reason a task in `ERROR` failed. A task ' +
    'in `ERROR` with a null `error` failed for a reason the system did not ' +
    'record; it has not succeeded.',
  inputSchema: { type: 'object', properties: {} },
  requiredRole: Role.ReadOnly,
  mutating: false,
  async handler({ system }) {
    // No filters and no options: a system holds tens of replication tasks at
    // most, and the state record this tool reads is part of a task row as it
    // stands — there is no option that changes how it is nested and no volume
    // to bound.
    const tasks = await firstValueFrom(system.client.api.query('replication.query'));
    return tasks.map((task) => {
      const state = runState(task.state);
      // Read once and passed to `finishedAt`, so that the state reported and
      // the decision about whether the recorded time is a finish time cannot
      // be made from two different readings of the same record.
      const reported = lastRunState(state);
      return {
        id: task.id,
        name: task.name,
        direction: task.direction,
        transport: task.transport,
        // Optional on the client's own type, so a middleware that omits it
        // reports null rather than handing the caller an object missing a
        // field the description promises — as `orNull` does in `pools.ts`.
        // Not defaulted to true or false: a task whose switch cannot be read
        // must not be presented as one that is definitely on or definitely
        // off.
        enabled: task.enabled ?? null,
        source_datasets: sourceDatasets(task.source_datasets),
        target_dataset: task.target_dataset,
        state: reported,
        finished_at: finishedAt(state, reported),
        error: errorText(state),
      };
    });
  },
};
