import type { JobParams } from '@truenas/api-client';
import {
  catchError,
  EMPTY,
  firstValueFrom,
  lastValueFrom,
  takeUntil,
  tap,
  throwError,
  timer,
} from 'rxjs';
import { Role } from '@/interfaces';
import { ApiSurface, MutatingTool, PlanStep, ReadOnlyTool, ToolContext } from '@/catalog/tool';
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
 *
 * `scheduled_task_set_enabled` is the first tool here that changes anything, and
 * it is the only one that acts on a kind another family lists: reading a task
 * and then switching it off is one question, and which file the listing lives
 * in is not part of it. It is written beside the schedule rendering above
 * because a plan naming a task has to name it the way its listing tool does.
 *
 * `cloudsync_run` is the second, and it is here for the same reason one step
 * on: it starts one of the tasks `cloudsync_tasks_list` reports, and its plan
 * names that task in the terms that listing already uses — description, path,
 * direction, the remote end and the credential by name.
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
 * One named string field of a record this file reads without leaning on the
 * client's type for it, or null where the record or the field is not readable.
 *
 * Each of the places this is used needs it for its own reason, and the reason
 * is not that the client describes nothing: it declares a cloud sync task's
 * `description`, and declares `bucket` and `folder` on the attributes object
 * beside it. Every one of those is optional on its own declaration, and a
 * declared type is a claim about what the middleware sends rather than about
 * the value received — so a row that carries something else reads as
 * unreadable here rather than as a string it is not. The cloud backup and
 * rsync sections reach the same kind of field through a row this file reads as
 * `unknown`, which puts whatever the client declares for those rows out of
 * reach at that seam. A task's credential IS declared, with a `name` typed a
 * string — but the middleware
 * also sends the id-only form, so a row that does not honour the type is the
 * case a direct read would have got wrong.
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
        // Named rather than passed through: `attributes` holds whatever the
        // provider a task uses needs, and the client declares one object
        // covering every provider, so a field a later TrueNAS release adds to
        // it does not reach the caller without a change here.
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
    // Named rather than passed through, as in `cloudsync_tasks_list`:
    // `attributes` holds whatever the provider a task uses needs, and it is
    // reached here through a row this function reads as `unknown`.
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

/**
 * `scheduled_task_set_enabled`: turning one scheduled task on or off, and the
 * fourth mutating tool in the catalog.
 *
 * ONE TOOL OVER SIX KINDS, and unlike `automated_tasks_list` the reason is that
 * the shape really is identical rather than that the missing kind is the
 * finding. All six methods take `(id, { enabled })` and answer with the updated
 * entity, so six tools would be six copies of one `plan`/`execute` pair
 * differing in two strings — the eleven copies of `textOrNull` behind
 * `common.ts` are what that becomes.
 *
 * THE KIND IS A REQUIRED ARGUMENT AND IS NEVER INFERRED. Task ids are
 * per-table integers, so id `3` exists in all six tables and names six
 * different things; a tool taking only an id would be ambiguous in the one way
 * that matters, silently disabling the wrong task. Every kind's enum value
 * names the tool its ids come from, in the description and in the failure.
 *
 * INIT/SHUTDOWN SCRIPTS ARE NOT A KIND HERE, and that is the #97 naming rule
 * rather than a limit of the API — `InitShutdownScriptUpdate` carries `enabled`
 * exactly as the six below do, and was checked. An init/shutdown script is not
 * scheduled: it runs at a point in the system's lifecycle, carries no cron
 * fields and reports no `schedule` at all, which is why `automated_tasks_list`
 * is not called `scheduled_tasks_list`. Accepting one under a tool named
 * `scheduled_task_set_enabled` would put that promise back one level down. It
 * needs a tool whose name does not claim a schedule, which is its own ticket.
 *
 * ONLY `enabled` IS SENT. These are partial updates, so a tool that round-trips
 * more of the row than it was asked to change can silently revert a concurrent
 * edit — and every one of these update types declares fields this repository
 * has no business writing.
 *
 * WHAT THE PLAN NAMES IS WHAT `execute` CALLS, INCLUDING THE READ, which is
 * `alerts_dismiss`'s seam (#119) reached for the same reason: the prior state
 * is only readable immediately before the call, and a plan naming only the
 * mutation would omit a call the user is approving. The read is issued
 * unconditionally and nothing branches on it, so `execute` stays a pure
 * function of (args, system).
 */

/**
 * One kind of scheduled task, and everything that differs between them.
 *
 * The two methods are literal strings inside {@link TaskKind.read} and
 * {@link TaskKind.update} rather than fields the caller passes to `api.query`,
 * so the client's own parameter and response types apply at each call site —
 * the same reason `storage.ts` inlines its filters. `readMethod` and
 * `updateMethod` restate them for the plan, which shows the caller what will
 * run.
 */
interface TaskKind {
  /** The `kind` argument's value, which is also what the failure names. */
  kind: string;
  /** What one of these is, in words, for the plan and for the failure. */
  noun: string;
  /** The catalog tool whose rows carry the `id` this tool takes. */
  listedBy: string;
  /**
   * The catalog tool that reports this kind's cron fields, or null where no
   * tool here reports them.
   *
   * It is {@link TaskKind.listedBy} for five of the six and null for
   * `replication`: `replication_status` answers about a task's state and its
   * last run and carries no `schedule` at all, so the fallback in
   * {@link schedulePhrase} pointing at it would send the person approving the
   * plan to a field that is not there. Listing a kind's id and reporting its
   * schedule are two different promises, and only the first is what `listedBy`
   * makes.
   */
  cronFieldsListedBy: string | null;
  /** The middleware method the plan's read step names. */
  readMethod: string;
  /** The middleware method the plan's mutation step names. */
  updateMethod: string;
  /** Whatever the listing method answered with, unread. */
  read(ctx: ToolContext, id: number): Promise<unknown>;
  /** The updated entity the update method answered with, unread. */
  update(ctx: ToolContext, id: number, enabled: boolean): Promise<unknown>;
  /**
   * The task in the terms its listing tool names it, label by label. A null
   * value is stated as absent rather than dropped, as `describeAlert`'s three
   * fields are: a plan that silently omits the description reads as a task
   * without one, and the person approving cannot tell which.
   */
  label(row: Record<string, unknown>): [string, string | null][];
}

/**
 * The task's schedule with its daily window where it has one, ready for
 * {@link describeSchedule}.
 *
 * The window is read for every kind rather than only for the two that carry
 * one: a kind whose schedule has no `begin` reads it as null, and
 * {@link windowPhrase} renders nothing for a half window — so one reading
 * covers all six without claiming a restriction a task does not have.
 */
function taskSchedule(row: Record<string, unknown>): (CronFields & Partial<DailyWindow>) | null {
  const cron = cronOf(row['schedule']);
  if (cron === null) return null;
  return { ...cronFieldsOf(cron), begin: fieldOrNull(cron.begin), end: fieldOrNull(cron.end) };
}

/** What a label the system named no value for is stated as. */
const NONE_REPORTED = '(the system reported none)';

/**
 * The schedule for the plan, in words.
 *
 * A schedule this tool does not render in words is stated as exactly that,
 * never as one the system reported none of: `describeSchedule` answers null for
 * both a missing field and a shape it will not put into English, and the two
 * are a limit of this tool rather than a task without a schedule.
 *
 * Where a tool here does report the cron fields exactly, the caller is pointed
 * at it — and that is {@link TaskKind.cronFieldsListedBy} rather than
 * {@link TaskKind.listedBy}, because for `replication` no tool does. A pointer
 * naming a tool that answers nothing about the schedule is worse than no
 * pointer: it reads as the exact account being one call away, and the approver
 * who makes that call finds no such field and cannot tell a tool that omits it
 * from a task that has none.
 */
function schedulePhrase(spec: TaskKind, row: Record<string, unknown>): string {
  const schedule = taskSchedule(row);
  const words = schedule === null ? null : describeSchedule(schedule);
  if (words !== null) return `schedule ${words}`;
  return `schedule ${
    spec.cronFieldsListedBy === null
      ? '(not rendered in words here, and no tool in this catalog reports its cron fields)'
      : `(not rendered in words here; \`${spec.cronFieldsListedBy}\` reports its cron fields)`
  }`;
}

/**
 * The task in the terms its listing tool shows it, for the human approving the
 * plan.
 *
 * An integer is not a thing anyone recognises, so the plan step names the task
 * the way the tool that listed it does — its description or name, its dataset
 * or path, and its schedule in the same English `tasks.ts` already produces.
 */
function describeTask(spec: TaskKind, row: Record<string, unknown>, id: number): string {
  const labelled = spec
    .label(row)
    .map(([name, value]) => `${name} ${value === null ? NONE_REPORTED : `"${value}"`}`);
  return `the ${spec.noun} with ${[...labelled, schedulePhrase(spec, row)].join(', ')} (id ${id})`;
}

/**
 * The six kinds, in the order the `kind` enum advertises them: the three with a
 * listing tool of their own first, then the three `automated_tasks_list` covers
 * in the order its sections are returned in. It is not the order
 * `createDefaultCatalog` registers those tools in, and nothing depends on
 * either — the enum is a set, and the order is only what a caller reads.
 *
 * Every one of the six update methods is on `DefaultApiDirectory`, checked
 * there rather than on a later directory, since that is the surface these tools
 * are written against (#91).
 */
const TASK_KINDS: TaskKind[] = [
  {
    kind: 'periodic_snapshot',
    noun: 'periodic snapshot task',
    listedBy: 'snapshot_tasks_list',
    cronFieldsListedBy: 'snapshot_tasks_list',
    readMethod: 'pool.snapshottask.query',
    updateMethod: 'pool.snapshottask.update',
    read: (ctx, id) =>
      firstValueFrom(ctx.system.client.api.query('pool.snapshottask.query', [['id', '=', id]])),
    update: (ctx, id, enabled) =>
      firstValueFrom(ctx.system.client.api.call('pool.snapshottask.update', [id, { enabled }])),
    label: (row) => [['dataset', textOrNull(row['dataset'])]],
  },
  {
    kind: 'cloud_sync',
    noun: 'cloud sync task',
    listedBy: 'cloudsync_tasks_list',
    cronFieldsListedBy: 'cloudsync_tasks_list',
    readMethod: 'cloudsync.query',
    updateMethod: 'cloudsync.update',
    read: (ctx, id) =>
      firstValueFrom(ctx.system.client.api.query('cloudsync.query', [['id', '=', id]])),
    update: (ctx, id, enabled) =>
      firstValueFrom(ctx.system.client.api.call('cloudsync.update', [id, { enabled }])),
    label: (row) => [
      ['description', textOrNull(row['description'])],
      ['path', textOrNull(row['path'])],
      ['direction', textOrNull(row['direction'])],
    ],
  },
  {
    kind: 'replication',
    noun: 'replication task',
    listedBy: 'replication_status',
    // The one kind whose listing tool reports no schedule: `replication_status`
    // answers what the task's last run did, not when the next one is due.
    cronFieldsListedBy: null,
    readMethod: 'replication.query',
    updateMethod: 'replication.update',
    read: (ctx, id) =>
      firstValueFrom(ctx.system.client.api.query('replication.query', [['id', '=', id]])),
    update: (ctx, id, enabled) =>
      firstValueFrom(ctx.system.client.api.call('replication.update', [id, { enabled }])),
    label: (row) => [
      ['name', textOrNull(row['name'])],
      ['target dataset', textOrNull(row['target_dataset'])],
    ],
  },
  {
    kind: 'cron',
    noun: 'cron job',
    listedBy: 'automated_tasks_list',
    cronFieldsListedBy: 'automated_tasks_list',
    readMethod: 'cronjob.query',
    updateMethod: 'cronjob.update',
    read: (ctx, id) =>
      firstValueFrom(ctx.system.client.api.query('cronjob.query', [['id', '=', id]])),
    update: (ctx, id, enabled) =>
      firstValueFrom(ctx.system.client.api.call('cronjob.update', [id, { enabled }])),
    // The `command` is deliberately NOT among these. `automated_tasks_list`
    // passes it through and says so, but it is whatever the operator typed and
    // can hold a password someone inlined — and a plan is shown to a person and
    // then recorded. The description and the user identify the job without
    // repeating it, and the listing tool is where the command is read.
    label: (row) => [
      ['description', textOrNull(row['description'])],
      ['user', textOrNull(row['user'])],
    ],
  },
  {
    kind: 'rsync',
    noun: 'rsync task',
    listedBy: 'automated_tasks_list',
    cronFieldsListedBy: 'automated_tasks_list',
    readMethod: 'rsynctask.query',
    updateMethod: 'rsynctask.update',
    read: (ctx, id) =>
      firstValueFrom(ctx.system.client.api.query('rsynctask.query', [['id', '=', id]])),
    update: (ctx, id, enabled) =>
      firstValueFrom(ctx.system.client.api.call('rsynctask.update', [id, { enabled }])),
    // `desc` is the middleware's own name for this one, reported under the
    // sibling label so that one word means one thing across the six kinds — as
    // `mapRsyncTask` already does for the listing.
    label: (row) => [
      ['description', textOrNull(row['desc'])],
      ['path', textOrNull(row['path'])],
      ['direction', textOrNull(row['direction'])],
    ],
  },
  {
    kind: 'cloud_backup',
    noun: 'cloud backup task',
    listedBy: 'automated_tasks_list',
    cronFieldsListedBy: 'automated_tasks_list',
    readMethod: 'cloud_backup.query',
    updateMethod: 'cloud_backup.update',
    read: (ctx, id) =>
      firstValueFrom(ctx.system.client.api.query('cloud_backup.query', [['id', '=', id]])),
    update: (ctx, id, enabled) =>
      firstValueFrom(ctx.system.client.api.call('cloud_backup.update', [id, { enabled }])),
    label: (row) => [
      ['description', textOrNull(row['description'])],
      ['path', textOrNull(row['path'])],
    ],
  },
];

/** The kinds by name, which is also what the argument is validated against. */
const TASK_KINDS_BY_NAME = new Map(TASK_KINDS.map((spec) => [spec.kind, spec]));

/**
 * The three arguments this tool takes, with the kind already resolved to the
 * definition behind it — so nothing downstream has to look one up again and
 * decide what to do if it is not there.
 */
interface TaskSwitch {
  spec: TaskKind;
  id: number;
  enabled: boolean;
}

/**
 * The caller's arguments, or the error naming what is wrong with them.
 *
 * Strict on all three, as `snapshots_create` is about `recursive` and for a
 * sharper version of the same reason: coercing `"false"` to true would switch
 * ON a backup task the caller asked to switch off, and a kind read loosely
 * would act on a different table's id `3`. There is nothing here a wrong
 * reading answers a narrower question — it answers a different one.
 *
 * `id` must be a whole number: the middleware holds these under integer
 * primary keys, and `3.5` is not one of them.
 */
function parseSwitch(args: Record<string, unknown>): TaskSwitch {
  const kind = args['kind'];
  const spec = typeof kind === 'string' ? TASK_KINDS_BY_NAME.get(kind) : undefined;
  if (spec === undefined) {
    throw new Error(
      `"kind" is required and must be one of ${TASK_KINDS.map((one) => one.kind).join(', ')}`,
    );
  }
  const id = args['id'];
  if (typeof id !== 'number' || !Number.isInteger(id)) {
    throw new Error('"id" is required and must be a whole number');
  }
  const enabled = args['enabled'];
  if (typeof enabled !== 'boolean') {
    throw new Error('"enabled" is required and must be a boolean');
  }
  return { spec, id, enabled };
}

/**
 * The row the system listed under this id, or null where it listed none that
 * did.
 *
 * The id is checked on the RESPONSE and not only asked for in the filter. An
 * unrecognised query parameter is dropped rather than refused, so a filter that
 * did not apply comes back as the whole table and looks exactly like one that
 * matched everything — and the first row of that is a different task, which is
 * the one mistake this tool must not make. The filter is still sent, for the
 * same reason `select` is sent in `tasks_recent_runs`: it bounds what crosses
 * the wire, and it is not what decides.
 */
function rowWithId(rows: unknown, id: number): Record<string, unknown> | null {
  if (!Array.isArray(rows)) return null;
  for (const row of rows) {
    const held = recordOrNull(row);
    if (held !== null && numberOrNull(held['id']) === id) return held;
  }
  return null;
}

/**
 * What the plan says the call will do, given the state the task is in now.
 *
 * Three cases and not two, as `alerts_dismiss`'s is: a task whose `enabled`
 * could not be read as a boolean is neither already there nor about to move,
 * and saying either would be a claim the read did not establish.
 */
function switchSentence(current: boolean | null, target: boolean): string {
  if (current === null) {
    return 'Whether it is enabled could not be read, so this may change nothing.';
  }
  if (current === target) {
    return `It is already ${current ? 'enabled' : 'disabled'}, so this changes nothing and is not an error.`;
  }
  return `It is ${current ? 'enabled' : 'disabled'}, so this will ${target ? 'enable' : 'disable'} it.`;
}

/**
 * The params the read step actually reaches the middleware with.
 *
 * The empty options object is not padding: `api.query(method, filters)`
 * dispatches `[filters ?? [], options ?? {}]`, so the call carries two
 * positional params whether or not the caller passed the second. A plan step
 * naming only the filter would be showing the user a call one argument shorter
 * than the one that runs — which is the same defect as a plan naming only the
 * mutation, one level down.
 */
function readParams(id: number): unknown {
  return [[['id', '=', id]], {}];
}

export const scheduledTaskSetEnabled: MutatingTool = {
  name: 'scheduled_task_set_enabled',
  description:
    'Turns one scheduled task on this TrueNAS system on or off, and changes ' +
    'nothing else about it. Two-phase: called without a confirmation_token it ' +
    'returns a plan for user approval; called with one it switches the task. ' +
    'THE TASK IS NAMED BY `kind` AND `id` TOGETHER, AND `id` ALONE IS NEVER ' +
    'ENOUGH: task ids are per-table integers, so id 3 exists under every kind ' +
    'and means a different task under each. `kind` is one of ' +
    '`periodic_snapshot`, whose ids come from `snapshot_tasks_list`; ' +
    '`cloud_sync`, from `cloudsync_tasks_list`; `replication`, from ' +
    '`replication_status`; `cron`, from the `cron_jobs` section of ' +
    '`automated_tasks_list`; `rsync`, from its `rsync_tasks` section; and ' +
    '`cloud_backup`, from its `cloud_backup_tasks` section. Every one of those ' +
    'listing tools reports the `id` this tool takes, so no second lookup is ' +
    'needed. INIT/SHUTDOWN SCRIPTS ARE NOT COVERED: they are not scheduled — ' +
    'they run at a point in the system\'s lifecycle — and no tool here ' +
    'switches one on or off. `enabled` is the state to move the task to, true ' +
    'or false, and is required: there is no toggle, because a toggle acts on a ' +
    'state read after the plan was approved. ONLY THE `enabled` FIELD IS SENT. ' +
    'The schedule, paths, retention, credentials and every other setting are ' +
    'left exactly as they are, and this tool cannot change them, cannot create ' +
    'or delete a task, and cannot run one now. THE PLAN NAMES THE TASK IN ' +
    'HUMAN TERMS — its description or name, its dataset or path, and its ' +
    'schedule in words — beside the kind and the id, so that what is approved ' +
    'is recognisable. A cron job\'s `command` is NOT repeated in the plan, ' +
    'because it is whatever an operator typed and can contain a secret; ' +
    '`automated_tasks_list` is where it is reported. PLANNING AGAINST AN id NO ' +
    'TASK OF THAT KIND HAS FAILS, naming the id, the kind searched and the ' +
    'tool that lists it — so an approved plan is always a plan about a task ' +
    'that existed when it was made, and a failure here is very often the wrong ' +
    '`kind` rather than a missing task. SWITCHING A TASK TO THE STATE IT IS ' +
    'ALREADY IN IS NOT AN ERROR, and the result says which of the two ' +
    'happened. `requested_enabled` is what was asked for. ' +
    '`previously_enabled` is the task\'s state as read immediately before the ' +
    'call. `resulting_enabled` is the state read back off the response the ' +
    'update itself answered with, which is the updated task. `changed` is true ' +
    'where those two disagree and false where they are the same, WHICH IS TWO ' +
    'OUTCOMES AND NOT ONE: either the task was already in the requested state, ' +
    'or the call did not apply and left it in the other one. `confirmed` is ' +
    'what tells those two apart, and `changed` must not be read without it. ' +
    'ALL THREE OF ' +
    '`previously_enabled`, `resulting_enabled` AND `changed` ARE NULL WHERE ' +
    'THE STATE BEHIND THEM COULD NOT BE ESTABLISHED, WHICH IS NOT "NOTHING ' +
    'CHANGED", and `changed` is null whenever either of the other two is. ' +
    '`confirmed` is whether `resulting_enabled` is what was requested: true is ' +
    'the system reporting back the state that was asked for, FALSE IS THE ' +
    'SYSTEM REPORTING THE OTHER STATE AND IS NOT A SUCCESS — the call did not ' +
    'reject and the task is not in the requested state — and null is a ' +
    'response that stated no `enabled` this tool could read, under which ' +
    'nothing here establishes what the task is now set to. `lookup` says what ' +
    'the read before the call did: `FOUND` is a read that named this task, ' +
    '`NOT_FOUND` a read that completed and listed no task of that kind with ' +
    'that id (it was deleted between the plan and the confirmation), and ' +
    '`UNREADABLE` a read that failed, with `lookup_error` naming why. IT HAS ' +
    'THREE VALUES AND `previously_enabled` HAS FOUR CAUSES FOR ITS NULL: the ' +
    'two above, and ALSO `FOUND` where the task stated no `enabled` this tool ' +
    'could read as a boolean. So `lookup` alone does not tell them apart, and ' +
    '`FOUND` beside a null `previously_enabled` is that fourth case. THE ' +
    'UPDATE IS ATTEMPTED IN ALL THREE CASES, because what runs must be what ' +
    'was approved. DISABLING A TASK IS CHEAP TO DO AND EXPENSIVE TO FORGET: a ' +
    'disabled backup, replication or snapshot task stops protecting anything ' +
    'and announces that nowhere — the listing tools report it as ' +
    '`enabled: false` and nothing raises an alert. This tool is the exact ' +
    'inverse of itself with `enabled` flipped.',
  inputSchema: {
    type: 'object',
    properties: {
      kind: {
        type: 'string',
        enum: TASK_KINDS.map((spec) => spec.kind),
        description:
          'Which kind of scheduled task the id names. `periodic_snapshot` ' +
          '(ids from `snapshot_tasks_list`), `cloud_sync` (from ' +
          '`cloudsync_tasks_list`), `replication` (from `replication_status`), ' +
          '`cron`, `rsync` and `cloud_backup` (from the matching sections of ' +
          '`automated_tasks_list`). Required: an id alone names a different ' +
          'task under every kind.',
      },
      id: {
        type: 'integer',
        description:
          "The task's `id` as its listing tool reports it, on the system being " +
          'targeted. It is unique only within its own kind.',
      },
      enabled: {
        type: 'boolean',
        description:
          'The state to move the task to: true switches it on, false switches ' +
          'it off. Required — this is not a toggle.',
      },
    },
    required: ['kind', 'id', 'enabled'],
  },
  requiredRole: Role.Full,
  mutating: true,
  destructiveness: 'reversible',
  normalizeArgs(rawArgs) {
    const { spec, id, enabled } = parseSwitch(rawArgs);
    return { kind: spec.kind, id, enabled };
  },
  async plan(ctx, rawArgs): Promise<PlanStep[]> {
    const { spec, id, enabled } = parseSwitch(rawArgs);
    const row = rowWithId(await spec.read(ctx, id), id);
    // The failure names the kind as well as the id, because a caller that
    // reached here with the right id and the wrong kind sees an id it can
    // check and a kind it cannot. `assertDatasetExists` fails the same way for
    // `snapshots_create`, with one fewer thing to get wrong.
    if (row === null) {
      throw new Error(
        `No ${spec.noun} with id ${id} on this system — the kind searched was ` +
          `"${spec.kind}", whose ids come from \`${spec.listedBy}\``,
      );
    }
    return [
      {
        method: spec.readMethod,
        params: readParams(id),
        description:
          `Read this system's ${spec.noun} with id ${id}, to report whether it was ` +
          'already in the state this call moves it to. Changes nothing.',
      },
      {
        method: spec.updateMethod,
        params: [id, { enabled }],
        description:
          `${enabled ? 'Enable' : 'Disable'} ${describeTask(spec, row, id)}. ` +
          `Only the enabled flag is sent. ${switchSentence(booleanOrNull(row['enabled']), enabled)}`,
      },
    ];
  },
  async execute(ctx, rawArgs) {
    const { spec, id, enabled } = parseSwitch(rawArgs);
    // Caught rather than thrown: this read exists to describe the outcome, and
    // letting it fail the call would lose an approval the user has already
    // given for a mutation that is still safe to make. The result then says the
    // prior state could not be established.
    let row: Record<string, unknown> | null = null;
    let lookupError: string | null = null;
    try {
      row = rowWithId(await spec.read(ctx, id), id);
    } catch (reason) {
      lookupError = errorText(reason);
    }
    // Unconditional, whatever the read said. Skipping the update for a task the
    // read no longer lists would be `execute` branching on state read at
    // execution time, which is what the confirmation token cannot bind.
    const updated = await spec.update(ctx, id, enabled);
    const previous = row === null ? null : booleanOrNull(row['enabled']);
    // The method answers with the updated task, so what it says about `enabled`
    // is the state that actually resulted — read back through the same guard
    // rather than echoing what was asked for.
    const resulting = booleanOrNull(recordOrNull(updated)?.['enabled']);
    return {
      kind: spec.kind,
      id,
      requested_enabled: enabled,
      lookup: lookupError !== null ? 'UNREADABLE' : row === null ? 'NOT_FOUND' : 'FOUND',
      lookup_error: lookupError,
      previously_enabled: previous,
      resulting_enabled: resulting,
      // Both readings or nothing. A `changed` derived from the request rather
      // than from the response would report a call the system did not apply as
      // having changed something.
      changed: previous === null || resulting === null ? null : previous !== resulting,
      confirmed: resulting === null ? null : resulting === enabled,
    };
  },
};

/**
 * `cloudsync_run`: starting one cloud sync task now, and the catalog's first
 * job-backed tool.
 *
 * THE JOB SEAM NEEDED NOTHING NEW IN THIS REPOSITORY. `ApiSurface` is
 * `DefaultApiDirectory`, whose shape is `{ call, job, event }`, so
 * `system.client.api.job(...)` was already available to every handler and typed
 * off the job directory — the client sends the request, correlates the job id
 * off the job events, tracks the job and completes the observable at a terminal
 * state. Earlier discussion here treated job support as a core prerequisite;
 * it is not, and that framing was wrong.
 *
 * TERMINAL DOES NOT MEAN SUCCEEDED, and on this method there is nothing else to
 * read. `cloudsync.sync` declares `response: null`, so the job's `result` is
 * null on success and on failure alike and cannot tell them apart — the client
 * says so itself, that "reaching a terminal state is not on its own enough to
 * assume a result". The outcome is read from `state`, against the same
 * {@link SUCCEEDED_JOB_STATES} the rest of this family reads a run's state
 * against, and `result` is not read at all. A tool that awaited completion and
 * reported success would have reported every failed sync as a success.
 *
 * THE DURATION DECISION IS ROUTE 3 OF THE THREE THE TICKET NAMED: watch the job
 * for a bounded time, then report either how it ended or that it is still
 * going — with the job id either way. Why not the other two:
 *
 * - AWAITING COMPLETION holds the tool call open for as long as the copy takes,
 *   which is minutes for a delta and hours for a first upload. The host times
 *   out, and the call it times out on is the only one that ever knew the job
 *   id, so the sync runs on with nothing able to name it afterwards.
 * - STARTING AND RETURNING THE ID is what this degrades to when the bound
 *   passes, so it is the floor rather than an alternative — and it is not the
 *   bound-free route it looks like: the id itself arrives from the first job
 *   event carrying this request's id, so that route waits on the network too
 *   and needs a bound of its own, spent before any outcome could be known.
 *   Route 3 spends the same wait on an answer that is sometimes complete.
 *
 * THE BOUND IS THE ONE NUMBER THIS TOOL HAS TO DEFEND. It must sit comfortably
 * inside the MCP host's own timeout, because a bound that outlives the host's
 * never gets to report anything at all; the host's is not readable from here —
 * `src/interfaces.ts` is the whole environment boundary and carries no deadline
 * — so {@link SYNC_WATCH_MS} is chosen to be shorter than the shortest in
 * ordinary use rather than tuned to any one of them. It is returned as
 * `watched_seconds`, so a caller never has to infer which bound applied, the
 * same way `snapshots_list` returns the `limit` it actually used.
 *
 * ENDING THE WATCH DOES NOT END THE SYNC, and that is read off the client
 * rather than assumed: `api.job` is `callAndGetJobId` piped into `trackJob`,
 * and `trackJob` only observes — it filters the job event stream and reads
 * `core.get_jobs`. Unsubscribing from it sends nothing to the middleware. A
 * bound that silently aborted a half-finished upload would be the worst defect
 * this tool could have, so it is the one property here established before the
 * route was taken rather than after.
 *
 * THE PLAN NAMES ONE CALL, WHICH IS #119'S DISTINCTION RATHER THAN A LAPSE.
 * `scheduled_task_set_enabled` names its read as a step because `execute` makes
 * that read; this tool reads only at plan time — to name the task, and to fail
 * on an id no task has — and `execute` re-reads nothing, exactly as
 * `snapshots_create` does not re-check its dataset. The `core.get_jobs` the
 * client's own tracking issues while following the job is named in the step's
 * description instead of as a step, because a step's `params` are the exact
 * params a call runs with and the job id does not exist until the approved call
 * has been made.
 */

/**
 * How long {@link cloudsyncRun} watches the job it started before reporting
 * what it has and returning. Thirty seconds; see the note above for why the
 * number is a ceiling on this tool's own patience rather than an estimate of
 * how long a sync takes.
 */
const SYNC_WATCH_MS = 30_000;

/** Seconds, for the result, so the bound is reported in the unit it is stated in. */
const SYNC_WATCH_SECONDS = SYNC_WATCH_MS / 1000;

/** The two arguments this tool takes, with `dry_run` already defaulted. */
interface SyncRun {
  id: number;
  dryRun: boolean;
}

/**
 * The caller's arguments, or the error naming what is wrong with them.
 *
 * Strict on both, as {@link parseSwitch} is and for the same reason: coercing
 * `"false"` to true would move real data to a remote under an approval given
 * for a dry run, which is not a narrower answer to the question asked but a
 * different one. `id` must be a whole number, since the middleware holds these
 * tasks under integer primary keys.
 */
function parseRun(args: Record<string, unknown>): SyncRun {
  const id = args['id'];
  if (typeof id !== 'number' || !Number.isInteger(id)) {
    throw new Error('"id" is required and must be a whole number');
  }
  const dryRun = args['dry_run'];
  if (dryRun != null && typeof dryRun !== 'boolean') {
    throw new Error('"dry_run" must be a boolean');
  }
  return { id, dryRun: dryRun === true };
}

/**
 * The params the job is started with, typed off the job directory — a disjoint
 * key space from the call directory, so `CallParams` cannot name them.
 *
 * The options object is always sent rather than omitted when `dry_run` is
 * false: the plan shows the params, and a plan whose second argument appears
 * only on a dry run would be showing two different call shapes for one tool.
 */
function syncParams(run: SyncRun): JobParams<ApiSurface, 'cloudsync.sync'> {
  return [run.id, { dry_run: run.dryRun }];
}

/**
 * The task in the terms `cloudsync_tasks_list` reports it, for the human
 * approving the plan.
 *
 * The remote end is named because that is what makes the approval meaningful —
 * "run cloud sync task 4" says nothing about where the data is about to go. The
 * credential is named and nothing more: its `provider` holds the access key,
 * token or password, exactly as in the listing this borrows its terms from.
 */
function describeCloudSyncTask(task: Record<string, unknown>, id: number): string {
  const labelled: [string, string | null][] = [
    ['description', stringField(task, 'description')],
    ['path', stringField(task, 'path')],
    ['direction', stringField(task, 'direction')],
    ['transfer mode', stringField(task, 'transfer_mode')],
    ['remote bucket', stringField(task['attributes'], 'bucket')],
    ['remote folder', stringField(task['attributes'], 'folder')],
    ['credential', stringField(task['credentials'], 'name')],
  ];
  const named = labelled.map(
    ([name, value]) => `${name} ${value === null ? NONE_REPORTED : `"${value}"`}`,
  );
  return `the cloud sync task with ${named.join(', ')} (id ${id})`;
}

/**
 * What each transfer mode does to the data, in the plan's own words.
 *
 * `transfer_mode` is declared REQUIRED on the pinned cloud sync entity and it
 * decides whether the run deletes anything: `COPY` deletes nothing, `SYNC`
 * makes the destination match the source and so removes whatever is not at the
 * source, and `MOVE` removes the source once the copy has landed. A plan that
 * said "this copies data" for all three would hide a deletion behind the word
 * the tool's name uses — a plan is what a person approves, so that is the same
 * defect as a description promising more than the normalization delivers,
 * pointed the other way.
 */
const TRANSFER_MODE_EFFECT: Record<string, string> = {
  COPY: 'new and changed files are copied to the destination, and nothing is deleted at either end.',
  SYNC:
    'the destination is made to match the source, so anything at the destination that is ' +
    'not at the source IS DELETED.',
  MOVE: 'files are copied to the destination and are then DELETED FROM THE SOURCE.',
};

/**
 * Which end is which, since every sentence above is written in terms of source
 * and destination.
 *
 * This is `cloudsync_tasks_list`'s own reading of `direction`, restated rather
 * than re-derived — that tool's description already says `path` is the local
 * end, the source on a `PUSH` and the destination on a `PULL`.
 */
const TRANSFER_ENDS =
  'On a PUSH this system is the source and the remote the destination; on a PULL it is the ' +
  'other way round.';

/**
 * The effect sentence for this task's mode, or the statement that the effect
 * was not established.
 *
 * A mode this tool cannot read is said to be exactly that, and NOT defaulted to
 * the harmless one: an approver told nothing about deletion would read the
 * absence as "nothing is deleted", which is the one reading that costs data.
 *
 * `Object.hasOwn` rather than `in`, which walks the prototype — `'constructor'`
 * is `in` every object literal and would come back as a function where a
 * sentence is expected (#101).
 */
function transferModeSentence(task: Record<string, unknown>): string {
  const mode = stringField(task, 'transfer_mode');
  const effect =
    mode !== null && Object.hasOwn(TRANSFER_MODE_EFFECT, mode)
      ? TRANSFER_MODE_EFFECT[mode]
      : undefined;
  if (effect !== undefined) return `Transfer mode ${mode}: ${effect} ${TRANSFER_ENDS}`;
  return (
    `Transfer mode ${mode === null ? NONE_REPORTED : `"${mode}"`}: whether this run DELETES ` +
    'anything, at either end, is not established here — read the task\'s transfer mode before ' +
    'approving.'
  );
}

export const cloudsyncRun: MutatingTool = {
  name: 'cloudsync_run',
  description:
    'Starts one cloud sync task on this TrueNAS system now, without waiting ' +
    'for its schedule, and reports how far it got. Two-phase: called without a ' +
    'confirmation_token it returns a plan for user approval; called with one it ' +
    'starts the sync. `id` is the task\'s `id` as `cloudsync_tasks_list` ' +
    'reports it, on the system being targeted, and PLANNING AGAINST AN id NO ' +
    'CLOUD SYNC TASK HAS FAILS naming that id — so an approved plan is always ' +
    'about a task that existed when it was made. The plan names the task the ' +
    'way that listing does: its description, its local path, its direction, the ' +
    'remote bucket and folder, and the stored credential by name. No key, ' +
    'token or password appears in the plan or in the result. `dry_run` reports ' +
    'what the sync would do without moving any data, and DEFAULTS TO FALSE, so ' +
    'an omitted `dry_run` copies for real. A DRY RUN STILL STARTS A JOB AND ' +
    'STILL CONTACTS THE REMOTE — it is not a local simulation, and it costs ' +
    'whatever listing the remote costs. THE RESULT IS ABOUT THE JOB THIS CALL ' +
    'STARTED, AND "STARTED" IS NOT "SUCCEEDED". A cloud sync is unbounded — ' +
    'minutes for a small delta, hours for a first upload — so this tool ' +
    'WATCHES THE JOB FOR AT MOST `watched_seconds` AND THEN RETURNS WHATEVER ' +
    'IT HAS, leaving the sync running. It never waits for the copy to finish. ' +
    'THE WATCH ALSO ENDS IF FOLLOWING THE JOB FAILS — a dropped connection, a ' +
    'failed read of the job list — and that is reported as what was ' +
    'established rather than as the sync having failed, since the run was ' +
    'already under way. A failure BEFORE anything was seen of the job fails ' +
    'this call instead, and even then MAY STILL HAVE STARTED THE SYNC: check ' +
    '`cloudsync_tasks_list` rather than assuming nothing ran. ' +
    '`ended` is whether the job was ESTABLISHED to have reached a state it ' +
    'will not move out of. TRUE MEANS THE RUN IS OVER. FALSE MEANS NOTHING WAS ' +
    'ESTABLISHED AND IS NOT ONE ANSWER — the sync is still going, or the watch ' +
    'was cut short by either of the failures above, or the job reached a state ' +
    'the system does not treat as ending a run and so may or may not be over, ' +
    'or the job reported a state this tool could not read, or no job was seen ' +
    'at all. `state` and `job_id` narrow that and DO NOT PARTITION IT: a ' +
    'non-null `state` beside `ended: false` is any of the first three and this ' +
    'tool cannot say which, a null `state` beside a `job_id` is a job whose ' +
    'state was unreadable, and both null is a job this tool never saw OR one ' +
    'whose state and id were both unreadable. IN NONE OF THEM HAS ANYTHING ' +
    'FAILED. `succeeded` is the answer to "did it work": true where the run ' +
    'ENDED in a state this catalog reads as success, false where it ENDED in ' +
    'any other state, and NULL WHERE NOTHING ESTABLISHED IT — which is every ' +
    'case above where `ended` is false. A null `succeeded` IS NOT A FAILURE ' +
    'AND IS NOT A SUCCESS, and A STATE THAT LOOKS LIKE A SUCCESS DOES NOT MAKE ' +
    'ONE: `succeeded` is null beside a `state` of `SUCCESS` where the run was ' +
    'not established to be over, since a job can still move out of a state ' +
    'this tool merely saw. NO STATE THIS CATALOG DOES NOT KNOW IS EVER READ AS ' +
    'A SUCCESS, whether the run ended in it or the watch ended without the run ' +
    'ending — so a state a later TrueNAS release adds reports as itself and ' +
    'never as a success. `state` is the state the system last ' +
    'reported, passed through as the system spelled it and null where none was ' +
    'read; `SUCCESS` and `FINISHED` are the two this tool counts as success. ' +
    'The job\'s `result` is NOT read and could not settle any of this: ' +
    '`cloudsync.sync` returns nothing, so a finished job carries a null result ' +
    'whether it worked or failed. `error` is the text the job recorded and is ' +
    'null where it recorded none, so a job that ended without succeeding and ' +
    'with a null `error` failed for a reason the system did not record — it ' +
    'has not succeeded. `finished_at` is when the job ended, as an ISO 8601 ' +
    'UTC timestamp, REPORTED ONLY WHERE `ended` IS TRUE — so it moves with ' +
    '`ended` and never contradicts it — and NULL EVERYWHERE ELSE EVEN IF THE ' +
    'JOB RECORD CARRIES A TIME, since a run that was not established to be ' +
    'over has not been established to have ended then. It is also null where ' +
    'the job ended and recorded no time this tool could read. `job_id` is the ' +
    'job\'s numeric identity and ' +
    'MATCHES `id` IN `tasks_recent_runs`, WHICH IS HOW A SYNC THAT WAS STILL ' +
    'RUNNING IS FOLLOWED UP — this tool reports no progress percentage and no ' +
    'live status, and that tool reports both. `job_id` is null where no job ' +
    'event named the job within the watch, and ALSO where a job event was seen ' +
    'and the id it carried was not a number this tool could read — so a null ' +
    '`job_id` beside a non-null `state` is the second of those. NEITHER MEANS ' +
    'THE SYNC DID ' +
    'NOT START: the call was made, and `cloudsync_tasks_list` will report the ' +
    'run against the task. `task_id` is the `id` that was asked for and ' +
    '`dry_run` what was actually sent. `watched_seconds` is the CEILING that ' +
    'applied to the watch and not how long it actually lasted — a job that ' +
    'ended in two seconds still reports the full bound. THIS TOOL CANNOT STOP ' +
    'A RUNNING SYNC, ' +
    'cannot change, create or delete a task, and cannot sync anything that is ' +
    'not already a task on the system. WHAT THE RUN DOES TO THE DATA IS THE ' +
    "TASK'S OWN `transfer_mode`, WHICH THE PLAN NAMES AND THIS TOOL DOES NOT " +
    'CHANGE: `COPY` deletes nothing, `SYNC` makes the destination match the ' +
    'source and so DELETES whatever at the destination is not at the source, ' +
    'and `MOVE` DELETES THE SOURCE once the copy lands — with `direction` ' +
    'saying which end is which, this system being the source on a `PUSH` and ' +
    'the destination on a `PULL`. NOTHING HERE UNDOES ANY OF THAT. The run ' +
    'itself can be stopped from the TrueNAS UI, which is all this tool\'s ' +
    "`destructiveness` records; the bytes it has already written or deleted " +
    'stay written or deleted.',
  inputSchema: {
    type: 'object',
    properties: {
      id: {
        type: 'integer',
        description:
          "The cloud sync task's `id` as `cloudsync_tasks_list` reports it, on " +
          'the system being targeted.',
      },
      dry_run: {
        type: 'boolean',
        default: false,
        description:
          'Report what the sync would do without moving data. Default false, ' +
          'which copies for real. A dry run still starts a job and still ' +
          'contacts the remote.',
      },
    },
    required: ['id'],
  },
  requiredRole: Role.Full,
  mutating: true,
  // THIS TOOL TRIGGERS AN OPERATION IT DOES NOT AUTHOR, which is the case
  // `Destructiveness` names at its own declaration in `catalog/tool.ts`:
  // everything a run deletes was decided by
  // whoever configured the task — the mode, the paths, the direction — and the
  // system does the same thing on its own at the next scheduled window. What
  // this changes is WHEN, not WHAT. The account of what the run does to the
  // data is in the description above and named in the plan, which is where the
  // person approving it reads it, and where that declaration says it belongs.
  destructiveness: 'reversible',
  normalizeArgs(rawArgs) {
    const run = parseRun(rawArgs);
    return { id: run.id, dry_run: run.dryRun };
  },
  async plan(ctx, rawArgs): Promise<PlanStep[]> {
    const run = parseRun(rawArgs);
    // The id is checked on the response and not only asked for in the filter,
    // for the reason {@link rowWithId} gives: a filter that did not apply comes
    // back as the whole table, and the first row of that is a different task.
    const rows = await firstValueFrom(
      ctx.system.client.api.query('cloudsync.query', [['id', '=', run.id]]),
    );
    const task = rowWithId(rows, run.id);
    if (task === null) {
      throw new Error(
        `No cloud sync task with id ${run.id} on this system — the ids this ` +
          'tool takes come from `cloudsync_tasks_list`',
      );
    }
    return [
      {
        method: 'cloudsync.sync',
        params: syncParams(run),
        description:
          `${run.dryRun ? 'Dry-run' : 'Run'} ${describeCloudSyncTask(task, run.id)} now. ` +
          `${transferModeSentence(task)} ` +
          `${
            run.dryRun
              ? 'This is a dry run: it transfers and deletes nothing, and still contacts the remote.'
              : 'This run does all of that for real.'
          } ` +
          'This starts a background job; the job is then followed through the ' +
          "client's own tracking, which reads `core.get_jobs` and changes " +
          `nothing, for at most ${SYNC_WATCH_SECONDS} seconds. The sync ` +
          'continues after that whether or not it has finished.',
      },
    ];
  },
  async execute(ctx, rawArgs) {
    const run = parseRun(rawArgs);
    // Set from the tracking observable COMPLETING rather than from comparing
    // the state against a list, because completion is the client's own
    // `isJobFinished` and so moves with the middleware's terminal set rather
    // than with a set written down here. The bound below cuts the stream by
    // unsubscribing, which is not a completion, so a job still running when the
    // watch ends leaves this false.
    let completed = false;
    // Whether the client ever reported on the job. Once it has, the job exists
    // and its id is in hand, which is what the guard below turns on.
    let sawJob = false;
    const watched = await lastValueFrom(
      ctx.system.client.api
        .job('cloudsync.sync', syncParams(run))
        .pipe(
          tap({
            next: () => {
              sawJob = true;
            },
            complete: () => {
              completed = true;
            },
          }),
          // An error raised while FOLLOWING a job the client has already
          // reported on is not the call failing. `trackJob` reads
          // `core.get_jobs` and listens on a socket that can drop; the sync is
          // running whatever either of those does. Rejecting here would tell the
          // caller the mutation failed AND take the job id with it, leaving a
          // running sync that nothing can name — which is the failure the bound
          // above exists to prevent, reached from the other side. So the watch
          // ends and the result reports what was established, `ended` false.
          //
          // Before the first emission there is no id to keep and nothing to
          // report, and the likeliest cause is the call itself being rejected —
          // so that still fails, as it must.
          catchError((error: unknown) => (sawJob ? EMPTY : throwError(() => error))),
          takeUntil(timer(SYNC_WATCH_MS)),
        ),
      // No emission at all: the request went out and nothing this tool can see
      // came back about a job, which is reported rather than thrown — the sync
      // may well be running.
      { defaultValue: null },
    );
    const record = lastRunOf(watched);
    // Read through the same guards the listings read a job record with, and
    // deliberately NOT through `lastRunState`, whose null case means "the task
    // has never run" — an answer about a task, where this is an answer about
    // one job that has just been started.
    const state = stringField(watched, 'state');
    // A completion with no emission is the client having found no such job,
    // which establishes nothing about the run; both halves are required.
    const ended = completed && state !== null;
    return {
      task_id: run.id,
      dry_run: run.dryRun,
      job_id: numberOrNull(recordOrNull(watched)?.['id']),
      watched_seconds: SYNC_WATCH_SECONDS,
      ended,
      // The state and nothing else. `result` is null on this method whatever
      // happened, so reading it could only ever have produced a wrong answer.
      // The direction is `notSucceeded`'s: a terminal state this catalog does
      // not recognise is not read as a success.
      succeeded: ended ? SUCCEEDED_JOB_STATES.has(state) : null,
      state,
      error: jobError(record),
      // Gated on `ended` and NOT through {@link jobFinishedAt}, which reads
      // {@link ENDED_JOB_STATES}. The two agree on the PINNED client and are
      // not the same reading: the client's `terminalStates` — what
      // `isJobFinished` tests, and so what completes the tracking — holds
      // exactly these five, checked in its `dist/index.js` rather than assumed,
      // while the set here is this repository's own. Two independently
      // maintained lists that happen to be equal today, and a client release
      // that widens its own would leave this result calling a run ended and
      // refusing to say when. `ended` is the claim this tool has already made,
      // so the finish time follows it and cannot contradict it. The listings
      // keep reading the set: none of them carries an `ended` to disagree with.
      finished_at: ended ? isoOrNull(jobMillis(record?.time_finished)) : null,
    };
  },
};
