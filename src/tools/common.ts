/**
 * The guards and constants the tool files share, in one place rather than one
 * copy per family.
 *
 * Every tool in `src/tools/` reads middleware payloads whose declared shape it
 * does not take as given, so each of them needs the same handful of narrowings
 * — is this a string, a finite number, a record — and each of them needs the
 * same reading of a rejection. The pinned client typed many of these payloads
 * as `unknown` outright; `@truenas/api-client` 4.x declares nearly all of them,
 * which changed what the compiler knows and not what a system sends, so nothing
 * below was retired by the bump.
 *
 * Those narrowings grew as a private copy per file, on the stated ground that a
 * tool file is read on its own. They did not all stay identical: by the
 * time this module was cut, `shares.ts`'s `errorText` had lost the branch that
 * reads a middleware error object, so a real rejection there reported as having
 * said nothing while every sibling file reported its reason.
 *
 * That is the trade this file settles: one definition a fix reaches, against a
 * file that can no longer be read entirely on its own. Nothing here is a tool,
 * a family, or part of the public surface — `src/index.ts` exports named tools
 * and this module is not among them, and must not become one.
 *
 * What belongs here is a guard or a constant that says the same thing for every
 * family. What does not is anything whose meaning is a family's own: a limit's
 * default, a state vocabulary, a field name. Those stay in the file that
 * defines them and are passed in.
 *
 * {@link watchJob} is the one thing here that is not a narrowing, and it is here
 * for the same reason the narrowings are: four tool families had copied it (#166).
 */

import type { TrueNasApiClient } from '@truenas/api-client';
import {
  catchError,
  EMPTY,
  lastValueFrom,
  Observable,
  switchMap,
  takeUntil,
  tap,
  throwError,
  timer,
} from 'rxjs';
import type { ApiSurface } from '@/catalog/tool';

/**
 * One string field of a row, or null where the system reported no value.
 *
 * An empty string is read as no value rather than as text of no characters: a
 * field the middleware sent as `''` has told the caller nothing, and a tool
 * that surfaced it would report an unnamed thing as being named.
 */
export function textOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * A finite number the system reported, or null where it reported anything else.
 *
 * Non-finite is not a number here: `NaN` and the infinities are not counts, byte
 * totals or ids, whatever else they are, and one arriving in a field a tool
 * arithmetics over would propagate rather than fail.
 */
export function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** A boolean the system reported, or null where it reported anything else. */
export function booleanOrNull(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

/**
 * A nested object of a row, or null where the row held anything else.
 *
 * `typeof null` is `'object'`, so the null check is what stops a reported-as-null
 * sub-object being indexed. An array is an object too and is excluded: the
 * things read through this are records, and reading a list as one would answer
 * null for every field rather than saying the shape was not what was expected.
 */
export function recordOrNull(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/**
 * The non-empty strings of a list field, or null where the field was not a list
 * at all.
 *
 * The two are kept apart because they are different answers: a field that
 * reported an empty list said there are none, and a field that reported no list
 * said nothing about them. Entries that are not non-empty strings are dropped
 * rather than surfaced as null, so the result is a list of names.
 */
export function textList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.flatMap((entry) => {
    const text = textOrNull(entry);
    return text === null ? [] : [text];
  });
}

/**
 * The names of a list field, all of them or none — null where the field was not
 * a list at all, AND null where any one entry could not be read as a name.
 *
 * The all-or-nothing counterpart to {@link textList}, and which of the two a
 * caller wants is decided by the direction a shorter list moves the answer, not
 * by taste. `textList` drops what it cannot read, so the list it returns is
 * shorter than the one the system sent and nothing says so; that is right where
 * a shorter list understates a fact the tool asserts, and wrong where a shorter
 * list makes a CLAIM — a ruleset one class shorter says the policy requires
 * less, an audit scope one name shorter says a share is not audited, an
 * allowlist one entry shorter says an address may not reach the system. Nulling
 * the whole list refuses the claim instead of quietly making it.
 *
 * An EMPTY list is not the same answer and is returned as itself: the system
 * reported the list and it names nothing.
 */
export function strictTextList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const names: string[] = [];
  for (const entry of value) {
    const name = textOrNull(entry);
    if (name === null) return null;
    names.push(name);
  }
  return names;
}

/**
 * The keys of a record whose values a tool does not report, by name and never
 * by value.
 *
 * `reported` IS THE KEYS THAT ACTUALLY PRODUCED A VALUE, NOT THE ALLOWLIST, and
 * that is the whole of what makes such a list say what it claims to. A key a
 * tool looks for whose value a guard rejected has not been reported either, and
 * it belongs here for exactly the reason a key nobody looked for does: the
 * caller is left with a null field, and this list is the only thing that says
 * the record held something under that name. Filtering by the allowlist instead
 * would answer "every key is reported" while a named field beside it was null —
 * the one reading this list exists to prevent.
 *
 * A key name is not a value: forwarding the record would put a field a later
 * TrueNAS release adds into a tool result unannounced, which is what the
 * allowlist convention exists to stop, while naming the keys tells a caller
 * what was there without saying what it said. That is the whole of what makes
 * an unconfirmed allowlist checkable from the outside (#98).
 *
 * Sorted so two systems reporting the same keys in a different order answer
 * identically.
 */
export function unreportedKeys(
  record: Record<string, unknown>,
  reported: readonly string[],
): string[] {
  return Object.keys(record)
    .filter((key) => !reported.includes(key))
    .sort();
}

/** What a failure carrying no text of its own is reported as. */
export const NO_REASON = 'the system reported no reason';

/**
 * Why a read failed, in words.
 *
 * A rejection is not necessarily an `Error` — the client rejects with whatever
 * the transport gave it — so a bare string is read too, and so are the two
 * shapes the client documents as its own: a JSON-RPC error object carrying
 * `message`, and a middleware error object carrying `reason`. Those are what a
 * failed call actually rejects with, and reading neither made every real
 * failure report as having said nothing. Anything else still becomes a stated
 * absence rather than `"[object Object]"`, and the result is never empty: a
 * failure with no text still has to read as a failure.
 *
 * IT READS `message` AND NEVER `cause`, AND THAT IS A CREDENTIAL BOUNDARY.
 * `FileContentError` keeps the minted download URL — which carries a single-use
 * auth token — off its own message and puts the adapter's message, which can
 * name that URL, on `cause`. `vm_logs` returns what this function produces, and
 * tool results are recorded verbatim in the audit trail. Adding a `cause`
 * reader here would put that token in a result, for every tool at once.
 */
export function errorText(reason: unknown): string {
  if (reason instanceof Error) return textOrNull(reason.message) ?? NO_REASON;
  if (typeof reason === 'object' && reason !== null) {
    const carrier = reason as Record<string, unknown>;
    return textOrNull(carrier['reason']) ?? textOrNull(carrier['message']) ?? NO_REASON;
  }
  return textOrNull(reason) ?? NO_REASON;
}

/** `1 alert` / `2 alerts`, so a rendered reason reads as English at either count. */
export function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/**
 * The largest instant `Date` accepts, in milliseconds since the epoch.
 *
 * A time beyond it makes `new Date(...).toISOString()` throw rather than
 * answer, so one absurd timestamp in a row would otherwise take the whole
 * listing down with it. Every tool that turns a middleware time into ISO text
 * bounds it against this first.
 */
export const MAX_TIME_MS = 8.64e15;

/**
 * A time as the middleware sends one: `{ "$date": <epoch milliseconds> }`,
 * which is the date representation the client's own types declare
 * (`TrueNasDate`). Restated with `$date` untyped because the rows carrying it
 * arrive as open records, so the field has to be read rather than trusted.
 */
export interface MiddlewareDate {
  $date?: unknown;
}

/**
 * An instant a job record carries, in milliseconds since the epoch, or null
 * where the system reported no time this can be read from.
 *
 * A bare number is accepted beside the `{ "$date": … }` envelope because the
 * envelope exists only to tag a number as a date in transit; both are epoch
 * milliseconds. Anything else — a formatted string, a date in another shape —
 * is not read rather than guessed at, because guessing wrong about a timezone
 * produces a timestamp that is confidently off by hours.
 *
 * Bounded by {@link MAX_TIME_MS}, which is what keeps one absurd recorded time
 * from taking a whole listing down with it.
 *
 * Shared rather than copied per family: this is a type narrowing over the
 * middleware's own date envelope, which says the same thing wherever it is
 * read, and {@link MAX_TIME_MS} and {@link MiddlewareDate} were already here
 * for it. What is NOT shared is any family's reading of a job's STATE — which
 * states count as success, which as ended — since those are vocabularies each
 * tool states in its own description.
 */
export function jobMillis(value: unknown): number | null {
  const raw = typeof value === 'object' && value !== null ? (value as MiddlewareDate).$date : value;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return null;
  return Math.abs(raw) <= MAX_TIME_MS ? raw : null;
}

/** An instant as an ISO 8601 UTC timestamp, or null where there is no instant. */
export function isoOrNull(millis: number | null): string | null {
  return millis === null ? null : new Date(millis).toISOString();
}

/**
 * A caller's requested bound — a row limit, a number of days — brought into
 * what a read will actually ask the middleware for.
 *
 * `fallback` and `max` are the calling family's own policy and are passed in —
 * what is shared is the bounding, not the numbers. Rounded down because a
 * fractional limit reaches the middleware as one, and floored at 1 because a
 * bound of zero or less would return nothing while reporting the system as
 * holding more — true, and not an answer.
 */
export function effectiveLimit(raw: unknown, fallback: number, max: number): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return fallback;
  return Math.min(max, Math.max(1, Math.floor(raw)));
}

/**
 * The one client method {@link watchJob} calls: following a job it did not
 * start.
 *
 * Named as a `Pick` rather than as the whole `api` so the watch's reach is
 * readable from its signature — it observes a job and dials nothing. The call
 * that STARTS the job is the tool's own and is passed in already built.
 */
type JobTracker = Pick<TrueNasApiClient<ApiSurface>['api'], 'trackJob'>;

/**
 * What a bounded watch of one job established, in the fields every job-backed
 * tool reports.
 *
 * `job_state` is the state the tracking last reported, passed through as the
 * system spelled it. A tool reporting it under another name maps it rather than
 * having this say two things.
 */
export interface WatchedJob {
  job_id: number | null;
  ended: boolean;
  succeeded: boolean | null;
  job_state: string | null;
  error: string | null;
  finished_at: string | null;
}

/**
 * Start nothing, watch a job someone else started for a bounded time, and
 * report what there is.
 *
 * THE SHAPE IS `cloudsync_run`'S (#122). It was copied four times — twice
 * inline in `tasks.ts`, as `watchVmJob` in `vms.ts`, as `watchServiceJob` in
 * `services.ts` — before it was promoted here (#166), and this file exists
 * because eleven copies of `textOrNull` had stopped being identical. This pipe
 * is load-bearing in a way `textOrNull` is not: a divergence here reports a
 * mutation that LANDED as having failed, or ends a watch in a way that loses
 * the only number naming the run. Every reason for every property below is
 * written out at `cloudsyncRun` in `tasks.ts` and in `CLAUDE.md`'s #122
 * decision, and none of it is re-argued here:
 *
 * - `callAndGetJobId` and `trackJob` are called apart rather than through
 *   `api.job`, so the two failure eras stay separable. `started` is the
 *   caller's own `callAndGetJobId` call, passed in rather than dialled here,
 *   because the method and its params are the tool's and the watching is not.
 *   It is cold: nothing is sent until this subscribes.
 * - An error raised once a job event has named the request is not the call
 *   failing, so it ends the watch and the result says what was established.
 *   Before that event there is nothing to report and no id to keep, so an error
 *   there still fails.
 * - Ending the watch does not end the job: `trackJob` only observes, and
 *   unsubscribing sends nothing to the middleware.
 * - `ended` is read from the tracking COMPLETING rather than from a state list
 *   written down here, and a completion carrying no emission is the client
 *   having found no such job — which establishes nothing, so both halves are
 *   required.
 * - `job_id` comes from the correlation and never from the tracking's last
 *   emission, because it is the one thing that survives a watch that
 *   established nothing else.
 *
 * WHAT MUST NOT TRAVEL WITH THE PIPE IS EACH FAMILY'S OWN VOCABULARY, which is
 * why both numbers a caller supplies are arguments in the way
 * {@link effectiveLimit}'s bounds are. `successStates` is a state VOCABULARY,
 * which #86's line makes a family's own — a shared constant would put the words
 * in one file and the sentence describing them to a caller in another — and
 * `watchMs` is a ceiling on one tool's patience rather than an estimate of any
 * job, which #154 states as sharing a sentence and not a number.
 *
 * `extra` IS HOW A METHOD THAT DECLARES A RESULT REPORTS ONE, and it exists so
 * that a job's `result` is NOT in the shape above. `cloudsync.sync`,
 * `pool.snapshottask.run`, `vm.stop` and `vm.restart` all declare
 * `response: null`, so a shared `result` field would be null on four of the five
 * call sites while presenting itself as something to read; `service.control` declares
 * `response: boolean` and reads it as `control_result`. The callback is handed
 * the record and `ended` rather than being given the result outright, because
 * what the result MEANS — its type, its name, and that it is only read where
 * the job was established to have ended — is that tool's own. Nothing raw
 * reaches a caller by this route: the record is not in the returned shape, and
 * tool results are recorded verbatim in the audit trail.
 */
export async function watchJob<Extra extends object = Record<never, never>>(
  api: JobTracker,
  started: Observable<number>,
  options: {
    watchMs: number;
    successStates: ReadonlySet<string>;
    extra?: (record: Record<string, unknown> | null, ended: boolean) => Extra;
  },
): Promise<WatchedJob & Extra> {
  // Set from the tracking observable COMPLETING rather than from comparing the
  // state against a list, because completion is the client's own
  // `isJobFinished` and so moves with the middleware's terminal set rather than
  // with a set written down here. The bound cuts the stream by unsubscribing,
  // which is not a completion, so a job still running when the watch ends
  // leaves this false.
  let completed = false;
  // Whether the client ever reported on the job. Once it has, the job exists
  // and the run is under way, which is what the guard below turns on.
  let sawJob = false;
  // The job's id, held from the moment the client correlates it.
  let jobId: number | null = null;
  const watched = await lastValueFrom(
    started.pipe(
      tap((correlated) => {
        sawJob = true;
        // Read through the same guard every other middleware number goes
        // through: the client declares it a number, and a declared type is a
        // claim about what is sent rather than about the value received.
        jobId = numberOrNull(correlated);
      }),
      switchMap((correlated) => api.trackJob(correlated)),
      tap({
        complete: () => {
          completed = true;
        },
      }),
      // An error raised once a job event has named this request is not the call
      // failing: the operation is under way, and rejecting here would report a
      // failure that did not happen AND take the job id with it. Before that
      // event there is nothing to report and no id to keep, so an error there
      // still fails.
      catchError((error: unknown) => (sawJob ? EMPTY : throwError(() => error))),
      takeUntil(timer(options.watchMs)),
    ),
    // No emission at all: the request went out and nothing the tool can see
    // came back about the job, which is reported rather than thrown — the
    // operation may well be running, and where an event named it `jobId` says
    // so even though this is null.
    { defaultValue: null },
  );
  const record = recordOrNull(watched);
  const state = textOrNull(record?.['state']);
  // A completion carrying no emission is the client having found no such job,
  // which establishes nothing; both halves are required.
  const ended = completed && state !== null;
  const reported: WatchedJob = {
    job_id: jobId,
    ended,
    succeeded: ended ? options.successStates.has(state) : null,
    job_state: state,
    error: textOrNull(record?.['error']),
    // Gated on `ended` rather than on a state list of its own, so the finish
    // time follows the claim already made and cannot contradict it.
    finished_at: ended ? isoOrNull(jobMillis(record?.['time_finished'])) : null,
  };
  return { ...reported, ...options.extra?.(record, ended) } as WatchedJob & Extra;
}
