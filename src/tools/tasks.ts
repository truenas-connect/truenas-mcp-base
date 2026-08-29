import { firstValueFrom } from 'rxjs';
import { Role } from '@/interfaces';
import { ReadOnlyTool } from '@/catalog/tool';

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
 * The largest instant a `Date` can hold. `toISOString` throws beyond it rather
 * than answering, so one absurd recorded time would otherwise take the whole
 * listing down with it — the same guard `replication.ts` and `snapshots.ts`
 * each apply to a time of their own, restated here for the same reason they
 * restate it rather than share it: a tool file is read on its own.
 */
const MAX_TIME_MS = 8.64e15;

/**
 * The job record a cloud sync task carries for its last run, restated with
 * every field optional and untyped.
 *
 * The client declares `job` as `{ [k: string]: unknown } | null` — an open
 * record naming nothing — so every field of it arrives as `unknown`, the same
 * way a replication task's state record does. Only the three fields read here
 * are named.
 */
interface LastRun {
  state?: unknown;
  time_finished?: unknown;
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
  const millis = jobMillis(run.time_finished);
  return millis === null ? null : new Date(millis).toISOString();
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
 * Three of the four places a cloud sync row is read from are like that: the
 * task's `attributes` and its credential are open records, and `description` is
 * not declared on the row at all — the server sends it and the generated dump
 * omits it, the same way it omits a job's own `description`, which the client
 * corrects by hand for exactly that reason. Each is read as `unknown` because
 * nothing in the pinned types vouches for it.
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
      // Read once and passed to `jobFinishedAt`, so that the state reported and
      // the decision about whether the recorded time is a finish time cannot be
      // made from two different readings of the same record.
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
