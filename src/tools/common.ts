/**
 * The guards and constants the tool files share, in one place rather than one
 * copy per family.
 *
 * Every tool in `src/tools/` reads middleware payloads whose fields arrive as
 * `unknown`, so each of them needs the same handful of narrowings — is this a
 * string, a finite number, a record — and each of them needs the same reading
 * of a rejection. Those grew as a private copy per file, on the stated ground
 * that a tool file is read on its own. They did not all stay identical: by the
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
 */

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
 * A caller's requested row limit, bounded into what a listing will actually ask
 * the middleware for.
 *
 * `fallback` and `max` are the calling family's own policy and are passed in —
 * what is shared is the bounding, not the numbers. Rounded down because a
 * fractional limit reaches the middleware as one, and floored at 1 because a
 * limit of zero or less would return nothing while reporting the system as
 * holding more — true, and not an answer.
 */
export function effectiveLimit(raw: unknown, fallback: number, max: number): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return fallback;
  return Math.min(max, Math.max(1, Math.floor(raw)));
}
