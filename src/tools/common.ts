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
