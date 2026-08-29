import { firstValueFrom } from 'rxjs';
import { Role } from '@/interfaces';
import { ReadOnlyTool } from '@/catalog/tool';

/**
 * Tasks family: the work a system does to itself on a schedule, with nobody
 * asking.
 *
 * `snapshots_list` says what protection exists; this says what protection is
 * automatic. The two are not visible in each other: a dataset with a month of
 * snapshots and no periodic task is protected up to the last manual action and
 * no further, and a snapshot taken by hand looks exactly like one a schedule
 * took. The task is the only place the difference is recorded.
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

/** The seven cron fields as this tool reports them: a string, or null. */
interface Schedule {
  minute: string | null;
  hour: string | null;
  dom: string | null;
  month: string | null;
  dow: string | null;
  begin: string | null;
  end: string | null;
}

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
 * not a stepped one, or names a step outside what the unit holds.
 */
function everyStep(field: string, max: number): number | null {
  const match = /^\*\/(\d{1,2})$/.exec(field);
  if (match === null) return null;
  const step = Number(match[1]);
  return step >= 1 && step <= max ? step : null;
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
 * hours, and every N minutes. Anything else is not guessed at — a wrong
 * rendering would be restated by a model as fact, where a null sends it to
 * `schedule`, which is always there and always exact.
 */
function timePhrase(minute: string, hour: string): string | null {
  const minutes = numberList(minute, 0, 59);
  if (minutes !== null && minutes.length === 1) {
    const past = pad(minutes[0]);
    if (hour === '*') return `every hour at :${past}`;
    const step = everyStep(hour, 23);
    if (step !== null) return `${everyPhrase(step, 'hour')} at :${past}`;
    const hours = numberList(hour, 0, 23);
    return hours === null ? null : `at ${joinWords(hours.map((value) => `${pad(value)}:${past}`))}`;
  }
  const step = everyStep(minute, 59);
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
 */
function describeSchedule(schedule: Schedule): string | null {
  const { minute, hour, dom, month, dow } = schedule;
  if (minute === null || hour === null || dom === null || month === null || dow === null) {
    return null;
  }
  const time = timePhrase(minute, hour);
  const days = dayPhrase(dom, month, dow);
  if (time === null || days === null) return null;
  return `${time}, ${days}${windowPhrase(schedule.begin, schedule.end)}`;
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
      // Named field by field rather than passed through, so that a field a
      // later TrueNAS release adds to the schedule does not reach the caller
      // without a change here — the same rule the row itself is built under.
      const schedule: Schedule | null =
        cron === null
          ? null
          : {
              minute: fieldOrNull(cron.minute),
              hour: fieldOrNull(cron.hour),
              dom: fieldOrNull(cron.dom),
              month: fieldOrNull(cron.month),
              dow: fieldOrNull(cron.dow),
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
