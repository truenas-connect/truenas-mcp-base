import { firstValueFrom } from 'rxjs';
import { Role } from '@/interfaces';
import { ReadOnlyTool } from '@/catalog/tool';
import {
  booleanOrNull,
  errorText,
  MAX_TIME_MS,
  MiddlewareDate,
  numberOrNull,
  recordOrNull,
  textOrNull,
} from '@/tools/common';

/**
 * Tasks family: the work a system does to itself on a schedule, with nobody
 * asking.
 *
 * `snapshots_list` says what protection exists; `snapshot_tasks_list` says what
 * protection is automatic. The two are not visible in each other: a dataset
 * with a month of snapshots and no periodic task is protected up to the last
 * manual action and no further, and a snapshot taken by hand looks exactly like
 * one a schedule took. The task is the only place the difference is recorded.
 *
 * `cloudsync_tasks_list` is the same argument one step further out. A snapshot
 * is on the same hardware as what it protects, so the copy that survives losing
 * the system is the one a cloud sync task made — and a task that stopped
 * succeeding announces itself nowhere until someone needs the copy.
 *
 * `automated_tasks_list` covers the four remaining kinds at once — cron jobs,
 * rsync tasks, cloud backup tasks and init/shutdown scripts. Those two above
 * are two of six, so before it "what runs on this system without anyone asking"
 * had a confident and incomplete answer, with nothing in the response saying
 * which categories were never looked at.
 *
 * `tasks_recent_runs` comes at all of it from the other end. The three above
 * list what is *arranged*; that one lists what actually *ran*, of every kind at
 * once — scrubs, replication, cloud sync, app upgrades, updates — because every
 * long-running operation on TrueNAS is a job and they all land in the same
 * place.
 */

/**
 * A schedule as a task row carries one, restated with every field optional and
 * untyped.
 *
 * The client types these as optional strings, and the guards below hold anyway:
 * the reading has to survive a row that does not honour the type, and a cron
 * field that is not a string is not a cron field.
 */
interface Cron {
  minute?: unknown;
  hour?: unknown;
  dom?: unknown;
  month?: unknown;
  dow?: unknown;
  begin?: unknown;
  end?: unknown;
}

/** The five cron fields every scheduled task carries: a string, or null. */
interface CronFields {
  minute: string | null;
  hour: string | null;
  dom: string | null;
  month: string | null;
  dow: string | null;
}

/**
 * The daily window a periodic snapshot task carries and a cloud sync task does
 * not — the client types the latter's schedule as the five cron fields alone.
 * Kept separate so the difference between the two is in the types rather than
 * in two null fields a cloud sync task would report on every call.
 */
interface DailyWindow {
  begin: string | null;
  end: string | null;
}

/** The seven cron fields a periodic snapshot task reports. */
type Schedule = CronFields & DailyWindow;

/**
 * The daily window a task carries when nothing restricts it. Rendering it into
 * the description would add "between 00:00 and 23:59" to every task on the
 * system, which says only that the task is not restricted — the case worth
 * naming in words is the one where it is.
 */
const FULL_DAY_BEGIN = '00:00';
const FULL_DAY_END = '23:59';

/** Sunday first, which is how cron numbers the days. */
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DAY_ABBREVIATIONS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/**
 * The task's schedule, or null where the row carries nothing to read one from.
 *
 * Guarded rather than asserted: a row that sends something other than an object
 * is exactly the case an assertion would have got wrong, as it is for a state
 * record in `replication.ts`.
 */
function cronOf(schedule: unknown): Cron | null {
  return typeof schedule === 'object' && schedule !== null ? (schedule as Cron) : null;
}

/**
 * One cron field, or null where the system reported nothing this tool can read.
 *
 * An empty string is read as no value rather than as a field of no characters:
 * it constrains nothing, and passing it through would put a value in `schedule`
 * that a caller cannot act on and that {@link describeSchedule} could not
 * render anyway.
 */
function fieldOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** `2` as `"02"`, so an hour and a minute read as a clock time. */
function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** `"a"`, `"a and b"`, `"a, b and c"`. Never called with an empty list. */
function joinWords(parts: string[]): string {
  return parts.length === 1
    ? parts[0]
    : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/**
 * The whole numbers a cron field lists, or null where it is not a plain
 * comma-separated list of numbers within range.
 *
 * Range-checked rather than passed through, because a field out of range is a
 * field this tool has misread — an hour of 47 is not an hour, and rendering it
 * as one would state a time the task never runs at.
 */
function numberList(field: string, min: number, max: number): number[] | null {
  const values: number[] = [];
  for (const part of field.split(',')) {
    if (!/^\d{1,2}$/.test(part)) return null;
    const value = Number(part);
    if (value < min || value > max) return null;
    values.push(value);
  }
  return values;
}

/**
 * The step of a stepped field — the N of `every N` — or null where the field is
 * not a stepped one, or names a step this tool will not state as an interval.
 *
 * A step counts from the start of its unit and then stops rather than wrapping,
 * so it is a true interval only where it divides the unit exactly. An hour
 * field stepping by 5 runs at 00, 05, 10, 15 and 20 and then waits four hours
 * for midnight — "every 5 hours" would name an interval the task does not keep,
 * once a day, which is worse than naming none.
 */
function everyStep(field: string, period: number): number | null {
  const match = /^\*\/(\d{1,2})$/.exec(field);
  if (match === null) return null;
  const step = Number(match[1]);
  return step >= 1 && step <= period && period % step === 0 ? step : null;
}

/** `every 4 hours`, and `every hour` rather than `every 1 hours`. */
function everyPhrase(step: number, unit: string): string {
  return step === 1 ? `every ${unit}` : `every ${step} ${unit}s`;
}

/** The full name of a cron day-of-week token, or null where it is not one. */
function dayName(token: string): string | null {
  const lower = token.toLowerCase();
  // Cron numbers Sunday as both 0 and 7.
  if (/^[0-7]$/.test(lower)) return DAY_NAMES[Number(lower) % 7];
  const index = DAY_ABBREVIATIONS.indexOf(lower);
  return index === -1 ? null : DAY_NAMES[index];
}

/**
 * When in the day the task runs, in words, or null where `minute` and `hour`
 * are in a shape this tool does not render.
 *
 * Four shapes, which are the ones the TrueNAS scheduler produces: a fixed
 * minute of every hour, a fixed minute every N hours, a fixed minute of listed
 * hours, and every N minutes — the two intervals only for an N that divides its
 * unit, per {@link everyStep}. Anything else is not guessed at: a wrong
 * rendering would be restated by a model as fact, where a null sends it to
 * `schedule`, which is always there and always exact.
 */
function timePhrase(minute: string, hour: string): string | null {
  const minutes = numberList(minute, 0, 59);
  if (minutes !== null && minutes.length === 1) {
    const past = pad(minutes[0]);
    if (hour === '*') return `every hour at :${past}`;
    const step = everyStep(hour, 24);
    if (step !== null) return `${everyPhrase(step, 'hour')} at :${past}`;
    const hours = numberList(hour, 0, 23);
    return hours === null ? null : `at ${joinWords(hours.map((value) => `${pad(value)}:${past}`))}`;
  }
  const step = everyStep(minute, 60);
  return step !== null && hour === '*' ? everyPhrase(step, 'minute') : null;
}

/**
 * Which days the task runs on, in words, or null where the three day fields are
 * in a shape this tool does not render.
 *
 * A month other than every month is not rendered, and neither is a day of the
 * month set alongside a day of the week: cron runs a task on the union of those
 * two, which reads as an intersection in every plain-English phrasing of it.
 */
function dayPhrase(dom: string, month: string, dow: string): string | null {
  if (month !== '*') return null;
  if (dow === '*') {
    if (dom === '*') return 'every day';
    const days = numberList(dom, 1, 31);
    if (days === null) return null;
    return `on ${days.length === 1 ? 'day' : 'days'} ${joinWords(days.map(String))} of each month`;
  }
  if (dom !== '*') return null;
  const names: string[] = [];
  for (const token of dow.split(',')) {
    const name = dayName(token);
    if (name === null) return null;
    names.push(name);
  }
  return `on ${joinWords(names)}`;
}

/**
 * The daily window, where there is one worth naming. Empty when either end is
 * missing — half a window is not a window, and reporting one end against an
 * assumed other would state a restriction the task does not have.
 */
function windowPhrase(begin: string | null, end: string | null): string {
  if (begin === null || end === null) return '';
  return begin === FULL_DAY_BEGIN && end === FULL_DAY_END ? '' : `, between ${begin} and ${end}`;
}

/**
 * The schedule in words, or null where any of the five cron fields is missing
 * or in a shape this tool does not render.
 *
 * A bare crontab line is a format a model has to decode before it can answer
 * with it, and one it can decode wrongly without anything saying so. This is
 * the same schedule stated so that restating it is reading rather than
 * decoding — and null wherever that cannot be done exactly.
 *
 * The window is optional because a cloud sync task has none, and a schedule
 * without one is rendered exactly as one whose window restricts nothing.
 */
function describeSchedule(schedule: CronFields & Partial<DailyWindow>): string | null {
  const { minute, hour, dom, month, dow } = schedule;
  if (minute === null || hour === null || dom === null || month === null || dow === null) {
    return null;
  }
  const time = timePhrase(minute, hour);
  const days = dayPhrase(dom, month, dow);
  if (time === null || days === null) return null;
  return `${time}, ${days}${windowPhrase(schedule.begin ?? null, schedule.end ?? null)}`;
}

/**
 * The five cron fields of a schedule, normalized. Named field by field rather
 * than spread from the row, so that a field a later TrueNAS release adds to the
 * schedule does not reach the caller without a change here — the same rule the
 * task rows themselves are built under.
 */
function cronFieldsOf(cron: Cron): CronFields {
  return {
    minute: fieldOrNull(cron.minute),
    hour: fieldOrNull(cron.hour),
    dom: fieldOrNull(cron.dom),
    month: fieldOrNull(cron.month),
    dow: fieldOrNull(cron.dow),
  };
}

export const snapshotTasksList: ReadOnlyTool = {
  name: 'snapshot_tasks_list',
  description:
    'Every periodic snapshot task on the system and the schedule it runs on. ' +
    '`id` is the task\'s numeric identity and `dataset` the dataset it ' +
    'snapshots, which matches `id` in `storage_list_datasets`. `recursive` is ' +
    "whether it snapshots that dataset's children too, and `enabled` whether " +
    'the task is switched on. A disabled task is listed and reported ' +
    '`enabled: false` rather than omitted, because a task nobody switched back ' +
    'on is exactly the one worth finding. Both are null where the system ' +
    'reported no value, which is not the same answer as false. ' +
    '`lifetime_value` and `lifetime_unit` are the retention — how long a ' +
    'snapshot this task takes is kept — as a number and one of `HOUR`, `DAY`, ' +
    '`WEEK`, `MONTH` or `YEAR`, so `2` and `WEEK` means its snapshots are ' +
    'destroyed a fortnight after they are taken. Each is null where the system ' +
    'reported no value, and a task whose retention could not be read is not a ' +
    'task that keeps its snapshots forever. `schedule` carries the cron fields ' +
    'as the system holds them: `minute`, `hour`, `dom` (day of the month), ' +
    '`month`, `dow` (day of the week), and `begin` and `end`, the daily window ' +
    'the task may run within. Each field is null where the system reported no ' +
    'value, and `schedule` itself is null where the task carries no readable ' +
    'schedule at all. `schedule_description` restates those fields in words — ' +
    '`at 02:00, every day`, or `every 4 hours at :00, every day, between 09:00 ' +
    'and 17:00`. It is null where the schedule is in a shape this tool does ' +
    'not render in words, and a null there says nothing about the task: it is ' +
    'a limit of this tool rather than a task without a schedule, and ' +
    '`schedule` is the exact account of when the task runs either way. This ' +
    'tool reports what is scheduled, not what happened — whether the last run ' +
    'of a task succeeded is not among these fields.',
  inputSchema: { type: 'object', properties: {} },
  requiredRole: Role.ReadOnly,
  mutating: false,
  async handler({ system }) {
    // No filters and no options: a system holds tens of snapshot tasks at most,
    // and every field this tool reads is part of a task row as it stands —
    // there is nothing to bound and no option that changes how it arrives.
    const tasks = await firstValueFrom(system.client.api.query('pool.snapshottask.query'));
    return tasks.map((task) => {
      const cron = cronOf(task.schedule);
      // The window is read here rather than in `cronFieldsOf`, which is shared
      // with the cloud sync task below and whose schedule carries none.
      const schedule: Schedule | null =
        cron === null
          ? null
          : {
              ...cronFieldsOf(cron),
              begin: fieldOrNull(cron.begin),
              end: fieldOrNull(cron.end),
            };
      return {
        id: task.id,
        dataset: task.dataset,
        // Optional on the client's own type, so a middleware that omits either
        // reports null rather than a default. Not defaulted to false: a task
        // whose switch cannot be read must not be presented as one that is
        // definitely off, and one whose recursion cannot be read must not be
        // presented as protecting only the dataset it names.
        enabled: task.enabled ?? null,
        recursive: task.recursive ?? null,
        schedule,
        // Rendered from the normalized fields rather than from the row, so
        // that what is described and what is reported cannot be two different
        // readings of the same schedule.
        schedule_description: schedule === null ? null : describeSchedule(schedule),
        lifetime_value: task.lifetime_value ?? null,
        lifetime_unit: task.lifetime_unit ?? null,
      };
    });
  },
};

/**
 * The job states that describe a run that has ENDED, and so the only ones under
 * which the recorded finish time is a finish time.
 *
 * This is the middleware's own terminal set, which the client spells out in
 * `isJobFinished`. Under a state outside it the job is still going or still
 * waiting, and its `time_finished` is whatever the record held before the
 * current run started — reporting that as the last finish would name a real
 * timestamp as something it is not, which is worse than reporting none.
 */
const ENDED_JOB_STATES = new Set(['SUCCESS', 'FAILED', 'ABORTED', 'ERROR', 'FINISHED']);

/**
 * {@link MAX_TIME_MS} from `common.ts` is what keeps one absurd recorded time
 * from taking the whole listing down with it, applied here to a job's
 * `time_finished`.
 */

/**
 * The job record a cloud sync task carries for its last run, restated with
 * every field optional and untyped.
 *
 * The client declares `job` as `{ [k: string]: unknown } | null` — an open
 * record naming nothing — so every field of it arrives as `unknown`, the same
 * way a replication task's state record does. Only the three fields read here
 * are named.
 *
 * A `core.get_jobs` row satisfies this too, and `tasks_recent_runs` passes one
 * straight to {@link jobFinishedAt} and {@link jobError}: it is the same job
 * record, reached by listing the jobs rather than by reading the task that
 * started one. The client types that row's fields where this does not, and
 * every field named here is optional and `unknown`, so the typed row is
 * assignable and the guards below cost it nothing.
 */
interface LastRun {
  state?: unknown;
  time_finished?: unknown;
  error?: unknown;
}

/**
 * The task's job record, or null where the row carries nothing to read one
 * from.
 *
 * Guarded rather than asserted: the record arrives as `unknown`, and a row that
 * sends something other than an object is exactly the case an assertion would
 * have got wrong.
 */
function lastRunOf(job: unknown): LastRun | null {
  return typeof job === 'object' && job !== null ? (job as LastRun) : null;
}

/**
 * An instant the job record carries, in milliseconds since the epoch, or null
 * where the system reported no time this tool can read.
 *
 * A bare number is accepted beside the `{ "$date": … }` envelope because the
 * envelope exists only to tag a number as a date in transit; both are epoch
 * milliseconds. Anything else — a formatted string, a date in another shape —
 * is not read rather than guessed at, because guessing wrong about a timezone
 * produces a timestamp that is confidently off by hours.
 */
function jobMillis(value: unknown): number | null {
  const raw =
    typeof value === 'object' && value !== null ? (value as MiddlewareDate).$date : value;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return null;
  return Math.abs(raw) <= MAX_TIME_MS ? raw : null;
}

/**
 * The state of the task's last run: the job's own state string, or
 * `NEVER_RUN`, or null.
 *
 * `job: null` is what a task carries until the system has run it. The field is
 * declared non-optional and nullable, so null is the middleware saying there is
 * no run record rather than that it could not send one — and that is the answer
 * this tool exists to keep separate from a failure.
 *
 * Null is neither of those: a job record in a shape this tool cannot read, or
 * one naming no state. It must not read as a task the system has never run,
 * which is a fact about the task rather than about this tool. A task in either
 * has not been shown to be working.
 *
 * Any other state is passed through as the system spelled it, so a state a
 * later TrueNAS release adds reaches the caller rather than being flattened
 * into one of these.
 */
function lastRunState(job: unknown): string | null {
  if (job === null) return 'NEVER_RUN';
  const reported = lastRunOf(job)?.state;
  return typeof reported === 'string' && reported.length > 0 ? reported : null;
}

/** An instant as an ISO 8601 UTC timestamp, or null where there is no instant. */
function isoOrNull(millis: number | null): string | null {
  return millis === null ? null : new Date(millis).toISOString();
}

/**
 * When the last run ended, as an ISO 8601 UTC timestamp, or null where nothing
 * this tool can read says a run ended.
 *
 * The state must be one that describes an ended run — see
 * {@link ENDED_JOB_STATES} — before the recorded time is read as a finish time
 * at all.
 */
function jobFinishedAt(run: LastRun | null, reported: string | null): string | null {
  if (run === null || reported === null || !ENDED_JOB_STATES.has(reported)) return null;
  return isoOrNull(jobMillis(run.time_finished));
}

/**
 * The error text recorded with the last run, or null where none was recorded.
 *
 * An empty string is read as no text rather than as an error message of no
 * characters: it names nothing a caller could act on, and reporting it beside a
 * `FAILED` state would suggest the reason is available when it is not.
 */
function jobError(run: LastRun | null): string | null {
  const error = run?.error;
  return typeof error === 'string' && error.length > 0 ? error : null;
}

/**
 * One named string field of a record the pinned client's types do not describe
 * field by field, or null where the record or the field is not readable.
 *
 * Each of the three places this is used needs it for its own reason. A task's
 * `attributes` is an open record — the client types it `Record<string,
 * unknown>`, so `bucket` and `folder` arrive as `unknown`. `description` is not
 * declared on the row at all: the server sends it and the generated dump omits
 * it, the same way it omits a job's own `description`, which the client
 * corrects by hand for exactly that reason. A task's credential IS declared,
 * with a `name` typed a string — but the middleware also sends the id-only
 * form, so a row that does not honour the type is the case a direct read would
 * have got wrong.
 */
function stringField(record: unknown, field: string): string | null {
  if (typeof record !== 'object' || record === null) return null;
  return fieldOrNull((record as Record<string, unknown>)[field]);
}

/**
 * The credential's numeric id, or null where the row carries nothing to read
 * one from.
 *
 * The client types `credentials` as a whole credential record, and the
 * middleware also has an id-only form, so both are read. Nothing else of the
 * credential is: its `provider` is where the access key, token or password
 * lives, and this tool never looks inside it.
 */
function credentialId(credentials: unknown): number | null {
  const id =
    typeof credentials === 'object' && credentials !== null
      ? (credentials as { id?: unknown }).id
      : credentials;
  return typeof id === 'number' && Number.isFinite(id) ? id : null;
}

export const cloudsyncTasksList: ReadOnlyTool = {
  name: 'cloudsync_tasks_list',
  description:
    'Every cloud sync task on the system: what it copies where, when it runs ' +
    "and how its last run went. `id` is the task's numeric identity and " +
    '`description` the name it was given, null where the system reported ' +
    'none. `direction` is `PUSH`, copying from this system out to the remote, ' +
    'or `PULL`, copying onto it. `path` is the local end — the source on a ' +
    '`PUSH` and the destination on a `PULL`. `bucket` and `folder` are the ' +
    'remote end; `bucket` is null on a provider that has no buckets, such as ' +
    'SFTP or WebDAV, and either is null where the system reported no value. ' +
    '`credential_id` and `credential_name` identify the stored credential the ' +
    'task authenticates with, and are the only account of it: no key, token, ' +
    'password or other secret appears anywhere in this result. `enabled` is ' +
    'whether the task is switched on and is null where the system reported no ' +
    'value; a disabled task is still listed, because a task nobody switched ' +
    'back on is exactly the one worth finding. `schedule` carries the cron ' +
    'fields as the system holds them: `minute`, `hour`, `dom` (day of the ' +
    'month), `month` and `dow` (day of the week). Each field is null where the ' +
    'system reported no value, and `schedule` itself is null where the task ' +
    'carries no readable schedule at all. A cloud sync task has no daily ' +
    'window, unlike a periodic snapshot task, so none is reported. ' +
    '`schedule_description` restates those fields in words — `at 02:00, every ' +
    'day`, or `every 4 hours at :00, on Monday and Thursday`. It is null where ' +
    'the schedule is in a shape this tool does not render in words, and a null ' +
    'there says nothing about the task: it is a limit of this tool rather than ' +
    'a task without a schedule, and `schedule` is the exact account of when ' +
    'the task runs either way. `state` is the state the system recorded for ' +
    'the last run. `SUCCESS`, `FINISHED`, `FAILED`, `ERROR` and `ABORTED` ' +
    'describe a run that ended; `RUNNING`, `WAITING`, `PENDING`, `HOLD` and ' +
    '`LOCKED` describe one that has not. `NEVER_RUN` is a task the system ' +
    'holds no run record for at all, and null is a run record this tool could ' +
    'not read — those two are different answers, and a task in either has not ' +
    'been shown to be working. A state a later TrueNAS release adds is passed ' +
    'through as the system spelled it, so `state` is not limited to that ' +
    'list. `finished_at` is when the last run ended, as an ISO 8601 UTC ' +
    'timestamp. It is reported only under the states that describe a run that ' +
    'ended, and is null under every other state including `RUNNING` — the ' +
    'system holds one job record per task, and while a run is going the time ' +
    'in it belongs to the run before. `error` is the text recorded with that ' +
    'run and is null where none was recorded, so a task in `FAILED` with a ' +
    'null `error` failed for a reason the system did not record; it has not ' +
    'succeeded. This tool reports tasks and their last run, not the contents ' +
    'of the remote — what is actually stored there is not among these fields.',
  inputSchema: { type: 'object', properties: {} },
  requiredRole: Role.ReadOnly,
  mutating: false,
  async handler({ system }) {
    // No filters and no options: a system holds tens of cloud sync tasks at
    // most, and every field this tool reads is part of a task row as it stands
    // — there is nothing to bound and no option that changes how it arrives.
    const tasks = await firstValueFrom(system.client.api.query('cloudsync.query'));
    return tasks.map((task) => {
      const cron = cronOf(task.schedule);
      const schedule = cron === null ? null : cronFieldsOf(cron);
      // Both derived from `task.job` rather than from each other, and the state
      // reported is then passed to `jobFinishedAt` — so whether the recorded
      // time counts as a finish time is decided from the state the caller is
      // given, not from a second reading of the record.
      const run = lastRunOf(task.job);
      const reported = lastRunState(task.job);
      return {
        id: task.id,
        description: stringField(task, 'description'),
        direction: task.direction,
        path: task.path,
        // Named rather than passed through: `attributes` is an open record
        // whose contents differ per provider, so a field a later TrueNAS
        // release adds to it does not reach the caller without a change here.
        bucket: stringField(task.attributes, 'bucket'),
        folder: stringField(task.attributes, 'folder'),
        // The credential by id and name and nothing else — its `provider` holds
        // the access key, token or password, and is never read.
        credential_id: credentialId(task.credentials),
        credential_name: stringField(task.credentials, 'name'),
        // Optional on the client's own type, so a middleware that omits it
        // reports null rather than a default. Not defaulted either way: a task
        // whose switch cannot be read must not be presented as one that is
        // definitely on or definitely off.
        enabled: task.enabled ?? null,
        schedule,
        // Rendered from the normalized fields rather than from the row, so that
        // what is described and what is reported cannot be two different
        // readings of the same schedule.
        schedule_description: schedule === null ? null : describeSchedule(schedule),
        state: reported,
        finished_at: jobFinishedAt(run, reported),
        error: jobError(run),
      };
    });
  },
};

/**
 * One section read, or the reason it could not be — the per-family attempt pair
 * `boot.ts`, `system.ts` and `fleet.ts` each keep, generic over a list of this
 * family's own rows and no further. It stays in this file rather than moving to
 * `common.ts`: what the files holding one of these share is the shape, not the
 * function, and generalising over the failure type would couple every family to
 * one signature. See the decision in `CLAUDE.md`.
 */
interface Attempt<T> {
  value: T | null;
  error: string | null;
}

/**
 * One task type's rows, with a failure named rather than thrown.
 *
 * `automated_tasks_list` reads four unrelated middleware methods, and a system
 * that refuses one of them — a role that cannot reach it, a release that does
 * not carry it — must still answer for the other three. So each read is a
 * section carrying its own reason, and none of them can fail the tool.
 *
 * An answer that is not a list is reported as the section being unreadable
 * rather than as the system holding none of that task type. Those are opposite
 * answers to the question this tool exists for: "nothing is arranged here" and
 * "nothing was established about what is arranged here".
 *
 * The read is a thunk rather than a promise so that a verb throwing
 * synchronously is caught here too, alongside one that rejects.
 */
async function readTasks<T>(
  read: () => Promise<unknown>,
  noun: string,
  map: (row: unknown) => T,
): Promise<Attempt<T[]>> {
  try {
    const rows = await read();
    if (!Array.isArray(rows)) {
      return { value: null, error: `the system did not answer with a list of ${noun}` };
    }
    return { value: rows.map(map), error: null };
  } catch (reason) {
    return { value: null, error: errorText(reason) };
  }
}

/**
 * The fields of a row read through guards, or an empty record where the system
 * sent something that is not a row at all.
 *
 * An unreadable entry is KEPT, as a row of nulls, rather than dropped — the
 * reading `boot.ts` gives its environments, and for the same reason one step
 * sharper here. A listing one entry shorter says the system runs one fewer
 * command on its own, which is a claim about the system rather than about this
 * tool, and it runs towards the one answer this tool must never state without
 * having established it.
 */
function rowFields(row: unknown): Record<string, unknown> {
  return recordOrNull(row) ?? {};
}

/** The five cron fields of a row's schedule, or null where it carries none. */
function scheduleOf(row: Record<string, unknown>): CronFields | null {
  const cron = cronOf(row['schedule']);
  return cron === null ? null : cronFieldsOf(cron);
}

/** One cron job as this tool reports it. */
interface CronJobRow {
  id: number | null;
  description: string | null;
  command: string | null;
  user: string | null;
  enabled: boolean | null;
  schedule: CronFields | null;
  schedule_description: string | null;
}

/**
 * One cron job: a shell command the system runs on a schedule, as a user.
 *
 * `command` and `user` together are the sharpest thing this tool reports — a
 * cron job running arbitrary commands as root is a fact an operator wants
 * surfaced, and neither is a secret this repository is handing over. A command
 * string can nonetheless CONTAIN one, because it is whatever the operator
 * typed; it is passed through rather than redacted, and the description says
 * so. The rule it is measured against is the catalog's own, which concerns
 * secrets as tool ARGUMENTS. The one place this repository does treat response
 * data as credential-shaped is a minted download URL, which is a string this
 * code produces rather than one an operator supplied — see `CLAUDE.md`.
 *
 * `stdout` and `stderr` are on the row and are not reported: they switch
 * whether the job's output is discarded or mailed, the client declares them as
 * bare booleans with no statement of which way round that is, and a field named
 * for a meaning this tool cannot state exactly is worse than an absent one.
 */
function mapCronJob(row: unknown): CronJobRow {
  const held = rowFields(row);
  const schedule = scheduleOf(held);
  return {
    id: numberOrNull(held['id']),
    description: textOrNull(held['description']),
    command: textOrNull(held['command']),
    user: textOrNull(held['user']),
    enabled: booleanOrNull(held['enabled']),
    schedule,
    // Rendered from the normalized fields rather than from the row, so that
    // what is described and what is reported cannot be two different readings
    // of the same schedule — as in the two tools above.
    schedule_description: schedule === null ? null : describeSchedule(schedule),
  };
}

/** One rsync task as this tool reports it. */
interface RsyncTaskRow {
  id: number | null;
  description: string | null;
  path: string | null;
  user: string | null;
  direction: string | null;
  mode: string | null;
  remote_host: string | null;
  remote_port: number | null;
  remote_module: string | null;
  remote_path: string | null;
  ssh_credential_id: number | null;
  ssh_credential_name: string | null;
  enabled: boolean | null;
  schedule: CronFields | null;
  schedule_description: string | null;
  state: string | null;
  finished_at: string | null;
  error: string | null;
}

/**
 * One rsync task: a scheduled copy between this system and a remote one.
 *
 * The SSH credential is read by id and name and no further, exactly as a cloud
 * sync task's is. Its `attributes` hold an SSH PRIVATE KEY, so reading anything
 * else off it would put a secret in a tool result — and tool results are
 * recorded verbatim in the audit trail.
 */
function mapRsyncTask(row: unknown): RsyncTaskRow {
  const held = rowFields(row);
  const schedule = scheduleOf(held);
  // Both derived from the row's job record rather than from each other, and the
  // state reported is then passed to `jobFinishedAt` — so whether the recorded
  // time counts as a finish time is decided from the state the caller is given.
  const run = lastRunOf(held['job']);
  const reported = lastRunState(held['job']);
  return {
    id: numberOrNull(held['id']),
    // The middleware names this one `desc` where a cloud sync task's is
    // `description`; it is reported under the sibling name so that one field
    // means one thing across the four sections.
    description: textOrNull(held['desc']),
    path: textOrNull(held['path']),
    user: textOrNull(held['user']),
    direction: textOrNull(held['direction']),
    mode: textOrNull(held['mode']),
    remote_host: textOrNull(held['remotehost']),
    remote_port: numberOrNull(held['remoteport']),
    remote_module: textOrNull(held['remotemodule']),
    remote_path: textOrNull(held['remotepath']),
    ssh_credential_id: credentialId(held['ssh_credentials']),
    ssh_credential_name: stringField(held['ssh_credentials'], 'name'),
    enabled: booleanOrNull(held['enabled']),
    schedule,
    schedule_description: schedule === null ? null : describeSchedule(schedule),
    state: reported,
    finished_at: jobFinishedAt(run, reported),
    error: jobError(run),
  };
}

/** One cloud backup task as this tool reports it. */
interface CloudBackupRow {
  id: number | null;
  description: string | null;
  path: string | null;
  bucket: string | null;
  folder: string | null;
  credential_id: number | null;
  credential_name: string | null;
  keep_last: number | null;
  enabled: boolean | null;
  schedule: CronFields | null;
  schedule_description: string | null;
  state: string | null;
  finished_at: string | null;
  error: string | null;
}

/**
 * One cloud backup task: a different backup engine from cloud sync, with its
 * own tasks and its own schedule.
 *
 * A cloud backup row carries `password` — the passphrase the backup repository
 * itself is encrypted with, declared a plain string — beside the stored
 * credential whose `provider` holds the access key. NEITHER IS READ HERE, and
 * naming the fields one by one is what keeps it that way: a row mapped by
 * trimming would have put both in a tool result, and tool results are recorded
 * verbatim in the audit trail. `pre_script` and `post_script` are left out
 * under the same rule for the same reason.
 */
function mapCloudBackup(row: unknown): CloudBackupRow {
  const held = rowFields(row);
  const schedule = scheduleOf(held);
  const run = lastRunOf(held['job']);
  const reported = lastRunState(held['job']);
  return {
    id: numberOrNull(held['id']),
    description: textOrNull(held['description']),
    path: textOrNull(held['path']),
    // Named rather than passed through: `attributes` is an open record whose
    // contents differ per provider, as in `cloudsync_tasks_list`.
    bucket: stringField(held['attributes'], 'bucket'),
    folder: stringField(held['attributes'], 'folder'),
    credential_id: credentialId(held['credentials']),
    credential_name: stringField(held['credentials'], 'name'),
    keep_last: numberOrNull(held['keep_last']),
    enabled: booleanOrNull(held['enabled']),
    schedule,
    schedule_description: schedule === null ? null : describeSchedule(schedule),
    state: reported,
    finished_at: jobFinishedAt(run, reported),
    error: jobError(run),
  };
}

/** One init/shutdown script as this tool reports it. */
interface InitShutdownScriptRow {
  id: number | null;
  comment: string | null;
  type: string | null;
  command: string | null;
  script: string | null;
  when: string | null;
  enabled: boolean | null;
  timeout: number | null;
}

/**
 * One init/shutdown script: work the system runs at a POINT IN ITS LIFECYCLE
 * rather than at a time of day.
 *
 * It carries no `schedule` field and none is invented for it. A cron rendering
 * here would be this tool's own fiction about when the work happens, and a
 * `schedule: null` beside the three sections that do carry one would read as a
 * script whose schedule could not be read rather than as one that has none by
 * construction.
 */
function mapInitShutdownScript(row: unknown): InitShutdownScriptRow {
  const held = rowFields(row);
  return {
    id: numberOrNull(held['id']),
    // The middleware's own name for the free-text label on these; there is no
    // `description` on the row.
    comment: textOrNull(held['comment']),
    type: textOrNull(held['type']),
    command: textOrNull(held['command']),
    script: textOrNull(held['script']),
    when: textOrNull(held['when']),
    enabled: booleanOrNull(held['enabled']),
    // The middleware's own name, kept unsuffixed: the pinned surface declares a
    // bare number and states no unit for it, and nothing about a timeout fixes
    // one. Suffixing it would assert a unit this tool never read — see the
    // decision in `CLAUDE.md`.
    timeout: numberOrNull(held['timeout']),
  };
}

/**
 * The four remaining kinds of work a TrueNAS system starts on its own.
 *
 * ONE TOOL RATHER THAN FOUR, and the reason is the defect being fixed rather
 * than the size of the response. What was wrong before was not that four
 * listings were missing; it was that "what runs on this system without anyone
 * asking" got a confident answer with whole categories silently absent from it.
 * Four separate tools reproduce that at a smaller scale — a caller that reaches
 * three of them still gets an answer with nothing in it saying what the fourth
 * would have added. Four sections in one response, each carrying its own
 * `unavailable`, is the shape where the gap is IN the answer.
 *
 * It is named `automated_tasks_list` and not `scheduled_…` because one of the
 * four is not scheduled: an init/shutdown script runs at a point in the
 * system's lifecycle. A name promising a schedule for a section that has none
 * is the failure `storage_scrub_history` was reviewed for, in advance.
 */
export const automatedTasksList: ReadOnlyTool = {
  name: 'automated_tasks_list',
  description:
    'Every cron job, rsync task, cloud backup task and init/shutdown script on ' +
    'the system — the four remaining kinds of work a TrueNAS system starts on ' +
    'its own. THIS TOOL DOES NOT LIST PERIODIC SNAPSHOT TASKS OR CLOUD SYNC ' +
    'TASKS: those are `snapshot_tasks_list` and `cloudsync_tasks_list`, and an ' +
    'answer here says nothing about either. CLOUD BACKUP IS A DIFFERENT ENGINE ' +
    'FROM CLOUD SYNC, with its own tasks and its own schedule, so ' +
    '`cloud_backup_tasks` here and `cloudsync_tasks_list` are two separate ' +
    'sets and neither includes the other. `tasks_recent_runs` answers the ' +
    'other half: this lists what is ARRANGED, that lists what actually RAN. ' +
    'The result has FOUR SECTIONS — `cron_jobs`, `rsync_tasks`, ' +
    '`cloud_backup_tasks` and `init_shutdown_scripts` — which come from ' +
    'SEPARATE READS AND CAN FAIL INDEPENDENTLY. Each carries `unavailable`: ' +
    'null where that section was read, and otherwise what the system said ' +
    'about the failure — and then `entries` IS NULL BECAUSE THAT TASK TYPE WAS ' +
    'NEVER LISTED, not because the system holds none of them. An EMPTY ' +
    '`entries` is the opposite answer: the system listed that task type and ' +
    'there were none. A failure in one section never empties or falsifies ' +
    'another. Across every section, `id` is the numeric identity the ' +
    'middleware holds the task under, `enabled` is whether it is switched on, ' +
    'and a DISABLED TASK IS STILL LISTED and reported `enabled: false` rather ' +
    'than omitted, because a task nobody switched back on is exactly the one ' +
    'worth finding. Any field is null where the system reported no value this ' +
    'tool could read, and a null `enabled` is neither on nor off. AN ENTRY ' +
    'WHOSE FIELDS ARE ALL NULL IS STILL A TASK THE SYSTEM LISTED: it is kept ' +
    'rather than dropped, so the number of entries stays true. ' +
    'In `cron_jobs`: `command` is the shell command the system runs and `user` ' +
    'the account it runs it as — a job running arbitrary commands as root is ' +
    'visible here and nowhere else in this catalog. `command` IS WHATEVER THE ' +
    'OPERATOR TYPED INTO IT and is passed through unchanged, so it may contain ' +
    'a password, key or token someone inlined; it is the operator\'s own text ' +
    'rather than a secret this system was asked to hold, and it is not ' +
    'redacted. `description` is the name the job was given. Whether the job\'s ' +
    'output is discarded or mailed is NOT reported. ' +
    'In `rsync_tasks`: `path` is the local end and `direction` is `PUSH`, ' +
    'copying from this system out to the remote, or `PULL`, copying onto it. ' +
    '`mode` is `SSH` or `MODULE` — how the task reaches the remote end. ' +
    '`remote_host`, `remote_port`, `remote_module` and `remote_path` are the ' +
    'remote end as the TASK ITSELF records it, and WHICH OF THEM A TASK ' +
    'CARRIES DEPENDS ON ITS MODE; each is null where the task records no ' +
    'value, which for a field its mode does not use is the normal case and is ' +
    'not a failure to read it. `ssh_credential_id` and `ssh_credential_name` ' +
    'identify the stored SSH credential and are the ONLY account of it: no ' +
    'private key, passphrase or host key appears anywhere in this result. THAT ' +
    "CREDENTIAL CAN ITSELF HOLD THE REMOTE SYSTEM'S HOSTNAME AND PORT, and " +
    'this tool does not read inside it — so a null `remote_host` on a task ' +
    'that names a credential is NOT evidence that the task has no remote host. ' +
    'NOTHING IN THIS CATALOG DESCRIBES A STORED SSH CREDENTIAL beyond the id ' +
    'and name here — `cloud_credentials_list` covers the cloud provider ' +
    'credentials a cloud sync or cloud backup task uses, which are a different ' +
    'store. `description` is the name the task was given. ' +
    'In `cloud_backup_tasks`: `path` is the local end, `bucket` and `folder` ' +
    'the remote one, and `bucket` is null on a provider that has no buckets. ' +
    '`credential_id` and `credential_name` identify the stored cloud ' +
    'credential and are the ONLY account of it. THE PASSPHRASE THE BACKUP ' +
    'REPOSITORY IS ENCRYPTED WITH IS NOT RETURNED, and neither are the access ' +
    'key, token or password inside the credential, or the scripts the task ' +
    'runs before and after itself. `keep_last` is how many backup snapshots ' +
    'the task retains. ' +
    'In `cron_jobs`, `rsync_tasks` and `cloud_backup_tasks`, `schedule` ' +
    'carries the cron fields as the system holds them: `minute`, `hour`, `dom` ' +
    '(day of the month), `month` and `dow` (day of the week). Each field is ' +
    'null where the system reported no value, and `schedule` itself is null ' +
    'where the task carries no readable schedule at all. None of these three ' +
    'has a daily window, unlike a periodic snapshot task, so none is reported. ' +
    '`schedule_description` restates those fields in words — `at 02:00, every ' +
    'day`, or `every 4 hours at :00, on Monday and Thursday`. It is null where ' +
    'the schedule is in a shape this tool does not render in words, and a null ' +
    'there says nothing about the task: it is a limit of this tool rather than ' +
    'a task without a schedule, and `schedule` is the exact account of when ' +
    'the task runs either way. ' +
    'In `rsync_tasks` and `cloud_backup_tasks` only, `state` is the state the ' +
    'system recorded for the LAST RUN. `SUCCESS`, `FINISHED`, `FAILED`, ' +
    '`ERROR` and `ABORTED` describe a run that ended; `RUNNING`, `WAITING`, ' +
    '`PENDING`, `HOLD` and `LOCKED` describe one that has not. `NEVER_RUN` is ' +
    'a task the system holds no run record for at all, and null is a run ' +
    'record this tool could not read — those two are different answers, and a ' +
    'task in either has not been shown to be working. A state a later TrueNAS ' +
    'release adds is passed through as the system spelled it, so `state` is ' +
    'not limited to that list. `finished_at` is when the last run ended, as an ' +
    'ISO 8601 UTC timestamp, reported only under the states that describe a ' +
    'run that ended and null under every other state including `RUNNING`. ' +
    '`error` is the text recorded with that run and is null where none was ' +
    'recorded, so a task in `FAILED` with a null `error` failed for a reason ' +
    'the system did not record; it has not succeeded. A CRON JOB ROW AND AN ' +
    'INIT/SHUTDOWN SCRIPT ROW CARRY NO RUN RECORD AT ALL, so those two ' +
    'sections report no `state`, `finished_at` or `error`, and NOTHING HERE ' +
    'SAYS WHETHER A CRON JOB HAS EVER SUCCEEDED — an entry in either section ' +
    'is a statement that the work is arranged and none at all about how it ' +
    'went. ' +
    'In `init_shutdown_scripts`: THESE ARE NOT SCHEDULED AND CARRY NO ' +
    'SCHEDULE. They run at a point in the system\'s lifecycle, which `when` ' +
    'names — `PREINIT` and `POSTINIT` are two points during startup and ' +
    '`SHUTDOWN` is on the way down — and no section field states a time of ' +
    'day, because there is none to state. `type` is `COMMAND` or `SCRIPT` and ' +
    'is what says which of `command` and `script` is the one in use: `command` ' +
    'is a shell command inlined into the entry, carrying the same caveat as a ' +
    'cron job\'s, and `script` is the PATH to a script file on the system, ' +
    'whose CONTENTS ARE NOT READ OR RETURNED. The one that does not apply is ' +
    'null. `comment` is the free-text label the entry was given. `timeout` is ' +
    'how long the system waits for the entry before moving on, as the bare ' +
    'number the system reports. NO UNIT IS REPORTED FOR IT — the API states ' +
    'none — so read it as itself and ask rather than converting it. ' +
    'This tool only reports. It does not create, edit, run, enable, disable or ' +
    'delete any task, and it does not report the output of one.',
  inputSchema: { type: 'object', properties: {} },
  requiredRole: Role.ReadOnly,
  mutating: false,
  async handler({ system }) {
    // All four reads are issued before any is awaited, so none waits on
    // another, and none can fail the tool. No filters and no options on any of
    // them: a system holds tens of each at most, and every field read here is
    // part of a row as it stands.
    const [cronJobs, rsyncTasks, cloudBackups, scripts] = await Promise.all([
      readTasks(
        () => firstValueFrom(system.client.api.query('cronjob.query')),
        'cron jobs',
        mapCronJob,
      ),
      readTasks(
        () => firstValueFrom(system.client.api.query('rsynctask.query')),
        'rsync tasks',
        mapRsyncTask,
      ),
      readTasks(
        () => firstValueFrom(system.client.api.query('cloud_backup.query')),
        'cloud backup tasks',
        mapCloudBackup,
      ),
      readTasks(
        () => firstValueFrom(system.client.api.query('initshutdownscript.query')),
        'init/shutdown scripts',
        mapInitShutdownScript,
      ),
    ]);
    return {
      cron_jobs: { unavailable: cronJobs.error, entries: cronJobs.value },
      rsync_tasks: { unavailable: rsyncTasks.error, entries: rsyncTasks.value },
      cloud_backup_tasks: { unavailable: cloudBackups.error, entries: cloudBackups.value },
      init_shutdown_scripts: { unavailable: scripts.error, entries: scripts.value },
    };
  },
};

/**
 * How far back `tasks_recent_runs` looks when the caller bounds nothing.
 *
 * The middleware holds every job it has run since it last started, which on a
 * system that has been up for weeks is thousands of them, nearly all of which
 * succeeded and are nobody's question. A day is the window that makes "what has
 * this system been doing, and what went wrong" answerable in one call; a longer
 * one is asked for rather than assumed.
 */
const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * The ISO 8601 forms `since` is accepted in: a date, or a date and a time
 * carrying an explicit zone.
 *
 * A zone is required for the same reason {@link jobMillis} will not read a
 * formatted string. `Date.parse('2026-08-28 09:00')` is implementation-defined
 * and Node reads it as LOCAL time, so a bound that looks exact would move the
 * window by the offset of whatever machine this happens to run on — silently,
 * and by hours. The date-only form is exempt because ECMAScript defines that
 * one as UTC.
 */
const ISO_INSTANT =
  /^(\d{4})-(\d{2})-(\d{2})(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2}))?$/;

/**
 * Whether the year, month and day are a date that exists.
 *
 * `Date.parse` does not settle this and is silent about it. A month out of
 * range, an hour of 25 and a malformed offset each answer `NaN`, but a day the
 * month does not have ROLLS OVER into the next one and answers a real instant:
 * `2026-02-30` parses as the 2nd of March, measured. So a caller that bounded a
 * report at a mistyped date would be handed a window starting two days after
 * the one it named, with nothing anywhere saying so — and every job in the gap
 * would be missing from an answer that looked complete.
 *
 * Rebuilt from the components and compared back, which needs no table of month
 * lengths to know that February has no 30th and that some Februaries have a
 * 29th. The year is not checked: the pattern above admits four digits and every
 * four-digit year exists.
 */
function isRealDate(year: number, month: number, day: number): boolean {
  const at = new Date(0);
  at.setUTCFullYear(year, month - 1, day);
  return at.getUTCMonth() === month - 1 && at.getUTCDate() === day;
}

/**
 * The instant the result is bounded at, in milliseconds since the epoch — the
 * default window back from `now` where the caller named none.
 *
 * Strict rather than lenient, as `snapshots_list` is about the dataset it is
 * asked for and for the same reason: a `since` that cannot be read is not a
 * request for the default window. Ignoring it would answer about the last day
 * while the caller believes it answered about the last month, and an empty
 * result would then read as "nothing failed" rather than as "the bound was not
 * applied". Null and undefined are the argument being absent, which is not the
 * same as unreadable and is what the default is for.
 */
function windowStart(raw: unknown, now: number): number {
  if (raw == null) return now - DEFAULT_WINDOW_MS;
  const match = typeof raw === 'string' ? ISO_INSTANT.exec(raw) : null;
  if (match === null) {
    throw new Error(
      '"since" must be an ISO 8601 timestamp with a timezone, such as ' +
        '"2026-08-28T09:00:00Z", or a date such as "2026-08-28"',
    );
  }
  // `match[0]` is the whole match, which an anchored pattern makes the whole
  // string — the same characters as `raw`, and typed where `raw` is `unknown`.
  const text = match[0];
  const millis = Date.parse(text);
  if (Number.isNaN(millis) || !isRealDate(Number(match[1]), Number(match[2]), Number(match[3]))) {
    throw new Error(`"since" is not a real date: "${text}"`);
  }
  return millis;
}

/**
 * Whether the caller asked for failures alone.
 *
 * Strict, as `snapshots_create` is about `recursive`: coercing `"false"` or `0`
 * would answer a different question from the one asked — every job the system
 * ran, where the caller asked what went wrong — and a listing that is wrong in
 * that direction is one a model will summarise as fact.
 */
function failedOnly(raw: unknown): boolean {
  if (raw == null) return false;
  if (typeof raw !== 'boolean') throw new Error('"failed_only" must be a boolean');
  return raw;
}

/**
 * The job states that describe a run that SUCCEEDED, and those that describe
 * one still under way. Between them they are every state middleware defines —
 * the client's own `JobState` — that is not a failure, and
 * {@link ENDED_JOB_STATES} above is the first of these two together with
 * `FAILED`, `ERROR` and `ABORTED`.
 *
 * Written as what `failed_only` EXCLUDES rather than as the failures it keeps,
 * and that direction is the whole point. A failure state a later TrueNAS
 * release adds is in neither set, so it survives the filter instead of being
 * dropped from the one answer this tool exists to give. The reverse — listing
 * the failures — would go quiet about exactly the runs nobody here has heard
 * of yet.
 */
const SUCCEEDED_JOB_STATES = new Set(['SUCCESS', 'FINISHED']);
const UNDER_WAY_JOB_STATES = new Set(['RUNNING', 'WAITING', 'PENDING', 'HOLD', 'LOCKED']);

/**
 * Whether `failed_only` keeps this job: one that has not succeeded and is not
 * still going.
 *
 * A state this tool could not read counts as not succeeded. A job that cannot
 * be shown to have worked has not been shown to have worked, and hiding it from
 * the failure listing is the one mistake here that matters.
 */
function notSucceeded(state: string | null): boolean {
  return state === null || !(SUCCEEDED_JOB_STATES.has(state) || UNDER_WAY_JOB_STATES.has(state));
}

/**
 * How far through the job is, as a percentage, or null where the system
 * reported none this tool can read.
 *
 * Not defaulted to zero: a job whose progress could not be read must not report
 * as one that has not started, which is a claim about the job rather than about
 * this tool.
 */
function progressPercent(progress: unknown): number | null {
  const percent =
    typeof progress === 'object' && progress !== null
      ? (progress as { percent?: unknown }).percent
      : undefined;
  return typeof percent === 'number' && Number.isFinite(percent) ? percent : null;
}

/**
 * What the system has been doing, and what went wrong doing it.
 *
 * Every long-running operation on TrueNAS is a job, so one call reaches across
 * scrubs, replication, cloud sync, app upgrades and updates at once — where the
 * per-family tools each answer for their own kind of task and none of them
 * answers for a job nothing on the board started.
 *
 * A job row is the largest payload in this catalog: it carries the full
 * arguments the job was called with, its whole result, and an excerpt of its
 * logs. None of the three is reported. `arguments` and `credentials` are
 * refused on the catalog's own rule that secrets do not pass through tools —
 * a job that mounts a share or authenticates to a remote was called with the
 * password — and `result` and `logs_excerpt` are refused for size, being
 * unbounded and per-job. The query asks for the named fields alone, so on a
 * middleware that honours `select` none of them is even fetched; the mapping
 * below is what guarantees it either way.
 */
export const tasksRecentRuns: ReadOnlyTool = {
  name: 'tasks_recent_runs',
  description:
    'Recent background jobs on the system, with failures called out. Every ' +
    'long-running operation on TrueNAS is a job — scrubs, replication, cloud ' +
    'sync, app upgrades, updates — so this answers what the system has been ' +
    'doing and what went wrong, across all of them at once. `id` is the ' +
    "job's numeric identity and `method` the API method it runs, such as " +
    '`pool.scrub.run` or `app.upgrade`; the method is what says which kind of ' +
    'operation a job is. `state` is the state the system recorded. `SUCCESS` ' +
    'and `FINISHED` describe a run that succeeded; `FAILED`, `ERROR` and ' +
    '`ABORTED` one that did not; `RUNNING`, `WAITING`, `PENDING`, `HOLD` and ' +
    '`LOCKED` one still under way. A state a later TrueNAS release adds is ' +
    'passed through as the system spelled it, so `state` is not limited to ' +
    'that list, and null is a state this tool could not read — a job in either ' +
    'has not been shown to have worked. `progress_percent` is how far through ' +
    'the job is, and `progress_description` what it says it is doing; each is ' +
    'null where the system reported no value, and a null percent is not zero. ' +
    '`started_at` is when the job started and `finished_at` when it ended, ' +
    'both as ISO 8601 UTC timestamps. `finished_at` is reported only under the ' +
    'states that describe a run that ended, and is null under every other ' +
    'state including `RUNNING`. Either is null where the system recorded no ' +
    'time this tool can read. `error` is the text recorded with a job that ' +
    'failed and is null where none was recorded, so a job in `FAILED` with a ' +
    'null `error` failed for a reason the system did not record; it has not ' +
    'succeeded. `failed_only` restricts the result to jobs that have not ' +
    'succeeded and are not still under way — the failure states above, plus ' +
    'any state this tool does not recognise or could not read, so a failure ' +
    'is never hidden by being unfamiliar. `since` bounds the result to jobs ' +
    'started at or after an ISO 8601 instant; omitted, THE LAST 24 HOURS, so ' +
    'an empty result means nothing matched within that window rather than ' +
    'that the system has never run the job in question. Pass `since` to look ' +
    'further back. A job whose start time could not be read is returned under ' +
    'any window, because nothing places it outside one. The arguments a job ' +
    'was called with, its result, its credentials and its logs are NOT ' +
    'returned: arguments and credentials can hold passwords and keys, and no ' +
    'secret passes through this tool. This lists jobs, which are operations ' +
    'the system ran; what is arranged to start some of them is ' +
    '`snapshot_tasks_list`, `cloudsync_tasks_list` and `automated_tasks_list`, ' +
    'and a task that has never run has no job here at all. Note that the ' +
    'SCHEDULED runs of a cron job, and an init/shutdown script running at boot ' +
    'or shutdown, do not go through the job system and so DO NOT APPEAR HERE ' +
    'AT ALL — an empty result says nothing about either.',
  inputSchema: {
    type: 'object',
    properties: {
      failed_only: {
        type: 'boolean',
        default: false,
        description:
          'Only report jobs that did not succeed and are not still running. ' +
          'Default false, which reports every job in the window.',
      },
      since: {
        type: 'string',
        description:
          'Only report jobs started at or after this instant, as an ISO 8601 ' +
          'timestamp carrying a timezone — "2026-08-28T09:00:00Z" — or a ' +
          'date, "2026-08-28", which is midnight UTC. Omitted, the last 24 ' +
          'hours.',
      },
    },
  },
  requiredRole: Role.ReadOnly,
  mutating: false,
  async handler({ system }, args) {
    // Both arguments are read before the call, so an unreadable one is an
    // error rather than a query the system answers and this tool then discards.
    const failed = failedOnly(args['failed_only']);
    const since = windowStart(args['since'], Date.now());
    const jobs = await firstValueFrom(
      // Options are inlined so the call's own parameter types apply, as in
      // `storage.ts`. `select` names the fields this tool reports and no
      // others, which keeps the arguments, result and logs of every job off
      // the wire entirely on a middleware that applies it. It is defence in
      // depth rather than the control: an unrecognised query option is dropped
      // rather than refused, so the mapping below is what actually decides
      // what a caller sees.
      system.client.api.query('core.get_jobs', [], {
        select: ['id', 'method', 'state', 'progress', 'time_started', 'time_finished', 'error'],
      }),
    );
    const rows = [];
    for (const job of jobs) {
      const state = fieldOrNull(job.state);
      if (failed && !notSucceeded(state)) continue;
      const startedMillis = jobMillis(job.time_started);
      // Only a job whose start time reads as older than the bound is dropped.
      // One with no readable start time is kept: it cannot be shown to fall
      // outside the window, and a failure that disappears because its
      // timestamp was unreadable is the failure mode worth avoiding here.
      if (startedMillis !== null && startedMillis < since) continue;
      rows.push({
        id: job.id,
        method: job.method,
        state,
        // Named field by field rather than passed through: `progress` also
        // carries `extra`, which is per-method and unbounded.
        progress_percent: progressPercent(job.progress),
        progress_description: stringField(job.progress, 'description'),
        started_at: isoOrNull(startedMillis),
        // The job row is the run record, so it is read as one — and the state
        // passed is the one the caller is given, not a second reading of it.
        finished_at: jobFinishedAt(job, state),
        error: jobError(job),
      });
    }
    return rows;
  },
};
