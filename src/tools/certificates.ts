import { firstValueFrom } from 'rxjs';
import { Role } from '@/interfaces';
import { ReadOnlyTool } from '@/catalog/tool';

/**
 * Certificates family: which certificates this system holds, and when each one
 * stops being valid.
 *
 * `certificate.query` answers all of it in one call, and unlike the interface
 * and network-configuration listings the pinned client TYPES the entity it
 * returns — `certificate.query` carries an `entity` in the client's own call
 * directory for the version this is written against, so `name`, `common`,
 * `san`, `from`, `until` and `expired` are read as declared fields rather than
 * guessed off a bare record the way `network.ts` has to read one. What is read
 * defensively here is the CONTENT of those fields, not their names: a date the
 * middleware formatted is still text this file has to parse, and `issuerName`
 * below is the one field with no declaration behind it at all.
 *
 * The mapping is an allowlist, as in `pools.ts` and `network.ts`. A raw
 * certificate row carries the PEM certificate, its private key, the CSR, the
 * ACME account and authenticator configuration, the full chain, the key length
 * and type, and every component of the subject separately — on every
 * certificate on the system. Only the fields named below survive, so neither a
 * private key nor a field a later TrueNAS release adds can reach a caller
 * without a change to this file.
 */

/**
 * One string field of a row, or null where the system reported no value.
 *
 * An empty string is read as no value rather than as text of no characters: the
 * middleware sends `""` for a subject component a certificate does not carry,
 * and passing it through would put a field in the result that says nothing.
 *
 * `network.ts`, `accounts.ts`, `shares.ts`, `tasks.ts` and `block.ts` each hold
 * this same reading under their own names, and it is restated here for the
 * reason those files give for restating it: a tool file is read on its own.
 */
function textOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * The non-empty strings of a list field, or null where the field was not a list
 * at all.
 *
 * The two are kept apart for the reason `network.ts` keeps them apart: a
 * certificate that reported an empty SAN list carries no alternative name, and
 * one that reported no list said nothing about them.
 */
function textList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.flatMap((entry) => {
    const text = textOrNull(entry);
    return text === null ? [] : [text];
  });
}

/** Month names in the order the C `asctime` format abbreviates them. */
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/**
 * A timestamp that ends in an explicit zone — `Z`, or an offset in either of
 * the two spellings. `Date.parse` is well defined on these and is used for
 * them; every other form below is read here rather than handed to it.
 */
const ZONED = /(?:Z|[+-]\d{2}:?\d{2})$/i;

/** ISO 8601 carrying no zone, including the date-only form. */
const BARE_ISO = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/;

/**
 * The C library's `asctime` form, which is what the middleware's own date
 * formatting produces: `Mon Feb 24 12:00:00 2025`, with a single-digit day
 * padded by a second space.
 */
const ASCTIME = /^[A-Za-z]{3} ([A-Za-z]{3}) {1,2}(\d{1,2}) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/;

/**
 * A validity date as milliseconds since the epoch, or null where the text was
 * not a form this reads.
 *
 * The middleware sends these as formatted text rather than as a timestamp, and
 * the spelling is not guaranteed — (unconfirmed) against a live system, which
 * is why `not_before` and `not_after` are also returned verbatim beside the day
 * count computed from them rather than replaced by it.
 *
 * A ZONE-LESS timestamp is read as UTC, and that is the whole reason this is
 * not one call to `Date.parse`. An x509 validity date IS UTC — the certificate
 * encodes it that way and the middleware formats it without saying so — while
 * ECMAScript defines a zone-less date-and-time string as LOCAL time, so
 * `Date.parse` would move every expiry by the offset of whatever machine this
 * happens to run on. Up to fourteen hours, silently, in whichever direction
 * that machine's zone lies, which is enough to move a day count across a
 * boundary. `tasks.ts` refuses to read such a string at all for the same
 * reason; here it cannot refuse, because the string is the system's own answer
 * rather than a caller's argument, so it is read in the zone it was written in.
 *
 * Nothing checks that the components name a date that exists, unlike the
 * caller-supplied bound in `tasks.ts`: this value comes from a certificate the
 * system parsed rather than from something a caller typed, and a middleware
 * sending `2026-02-30` is a fault of a different kind from a user mistyping
 * one. A date that rolls over is reported as the instant it rolls to, beside
 * the text it was read from.
 */
function instantOf(text: string | null): number | null {
  if (text === null) return null;
  if (ZONED.test(text)) {
    const millis = Date.parse(text);
    return Number.isNaN(millis) ? null : millis;
  }
  const iso = BARE_ISO.exec(text);
  if (iso !== null) {
    // The time groups are absent on the date-only form, where midnight UTC is
    // what ECMAScript itself reads that form as.
    return Date.UTC(
      Number(iso[1]),
      Number(iso[2]) - 1,
      Number(iso[3]),
      Number(iso[4] ?? 0),
      Number(iso[5] ?? 0),
      Number(iso[6] ?? 0),
    );
  }
  const asctime = ASCTIME.exec(text);
  if (asctime === null) return null;
  const month = MONTHS.indexOf(asctime[1].toLowerCase());
  // A three-letter word in the month's position that is not a month name means
  // this is not the form it looked like.
  if (month < 0) return null;
  return Date.UTC(
    Number(asctime[6]),
    month,
    Number(asctime[2]),
    Number(asctime[3]),
    Number(asctime[4]),
    Number(asctime[5]),
  );
}

/** Milliseconds in a day. */
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Whole days from now until the certificate stops being valid, or null where no
 * expiry date could be read.
 *
 * Floored, so the number is days the certificate has LEFT rather than days
 * rounded to the nearest: `0` is a certificate that expires within the next
 * twenty-four hours and has not expired yet, and anything negative has already
 * expired — which is what makes an expired certificate answer a non-positive
 * number instead of dropping out of a result that is asked for the ones
 * expiring soon.
 */
function daysUntil(expiry: number | null, now: number): number | null {
  return expiry === null ? null : Math.floor((expiry - now) / DAY_MS);
}

/**
 * The issuer, as the system named it, or null where it named none.
 *
 * The one field here with no declaration behind it. The pinned client declares
 * NO `issuer` on a certificate entry — not on the version this is written
 * against and not on any of the seven others it carries — so it is read off the
 * row rather than taken from the type, the way every field in `network.ts` is
 * read.
 *
 * It is read at all because the middleware has historically added an issuer
 * when it READS a certificate, which is exactly the kind of field a type
 * generated from the stored model does not carry — `hostname_local` in
 * `network.ts` is the same shape of fact, and is read there with the same
 * reasoning. A release that sends one is reported; a release that does not
 * costs a null rather than a wrong value.
 *
 * An issuer the system names as an object rather than as text is reported by
 * that object's `name`, which is how a certificate authority is named
 * everywhere else in the API. Any other shape names no issuer this tool can
 * report.
 *
 * NULL IS THEREFORE "THIS SYSTEM REPORTED NO ISSUER" AND NEVER "SELF-SIGNED",
 * and the tool's description says so: the two are not distinguishable from
 * here, and reporting a certificate signed by a CA this tool simply could not
 * read as self-signed would be worse than reporting nothing.
 */
function issuerName(row: object): string | null {
  const issuer = (row as Record<string, unknown>)['issuer'];
  const text = textOrNull(issuer);
  if (text !== null) return text;
  if (typeof issuer !== 'object' || issuer === null || Array.isArray(issuer)) return null;
  return textOrNull((issuer as Record<string, unknown>)['name']);
}

/**
 * How far ahead the caller asked to look, in days, or null where it asked for
 * everything.
 *
 * Strict rather than lenient, as `tasks_recent_runs` is about `since` and for
 * the same reason, which is sharper here than it is there: a bound that is
 * quietly ignored returns EVERY certificate on the system under a call that
 * asked for the ones expiring soon, and a model reading that answer will report
 * every certificate as expiring within the window. Answering more than was
 * asked for is the dangerous direction, so an argument that cannot be read
 * stops the call rather than widening it. Null and undefined are the argument
 * being absent, which is a caller asking for all of them.
 */
function withinDays(raw: unknown): number | null {
  if (raw == null) return null;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    throw new Error('"expiring_within_days" must be a number of days, such as 30');
  }
  return raw;
}

export const certificatesList: ReadOnlyTool = {
  name: 'certificates_list',
  description:
    'Every certificate this system holds, with the dates it is valid between ' +
    'and how long each one has left. An expired certificate takes the web UI ' +
    'and every API client down at once, on a date that was knowable months ' +
    'earlier, so this is the tool that answers "what is about to break". ' +
    '`name` is the certificate as the system names it, which is what the ' +
    'web UI shows and what other settings refer to. `common_name` is the ' +
    "certificate's own common name and `subject_alternative_names` are the " +
    'other names it is valid for; MODERN CLIENTS MATCH ON THE ALTERNATIVE ' +
    'NAMES AND NOT ON THE COMMON NAME, so a certificate whose common name ' +
    'looks right may still not cover the hostname in use. An empty list is a ' +
    'certificate that carries no alternative name, and NULL IS ONE WHOSE ' +
    'NAMES COULD NOT BE READ. `issuer` is who signed the certificate, where ' +
    'the system reported one. NULL MEANS THIS SYSTEM REPORTED NO ISSUER AND ' +
    'IS NEVER EVIDENCE THAT A CERTIFICATE IS SELF-SIGNED — the two cannot be ' +
    'told apart from here, and not every TrueNAS release reports an issuer at ' +
    'all. `not_before` and `not_after` are the dates the certificate is valid ' +
    'between, PASSED THROUGH EXACTLY AS THE SYSTEM FORMATTED THEM rather than ' +
    'converted, so their spelling varies by release; each is null where the ' +
    'system reported none, which is ordinary on a signing request that has ' +
    'not been signed yet. `days_until_expiry` is whole days from now until ' +
    '`not_after`, so 0 means it expires within the next twenty-four hours and ' +
    'A NEGATIVE NUMBER MEANS IT HAS ALREADY EXPIRED, by that many days. It is ' +
    'null where `not_after` was absent or in a form this tool could not read, ' +
    'WHICH IS NOT "DOES NOT EXPIRE" — every certificate expires, so a null ' +
    'there is a certificate whose expiry is UNKNOWN and worth looking at ' +
    'directly. It is computed here from `not_after`, read as UTC, and is ' +
    'accurate to the day rather than to the hour. `expired` is the ' +
    "SYSTEM'S OWN verdict, and is null where it gave none. The two can " +
    'disagree — a clock that differs, or a date this tool could not read — ' +
    'and where they do, `expired` is what the system believes and ' +
    '`days_until_expiry` is what this tool computed from the date beside it. ' +
    '`expiring_within_days` restricts the result to certificates with that ' +
    'many days or fewer left, and ALREADY-EXPIRED CERTIFICATES ARE ALWAYS ' +
    'INCLUDED because their day count is negative and so below any threshold. ' +
    'Omitted, every certificate is returned. A CERTIFICATE WHOSE EXPIRY COULD ' +
    'NOT BE READ IS NOT RETURNED WHEN THIS ARGUMENT IS GIVEN, since no ' +
    'threshold can be applied to it — call without the argument to see those. ' +
    'This tool reports certificates as they are: it does not import, create, ' +
    'renew or delete a certificate or a signing request, and IT DOES NOT ' +
    'RETURN ANY CERTIFICATE OR PRIVATE KEY MATERIAL. It does not say which ' +
    'service uses which certificate. NO field beyond those named here is ' +
    'returned, whatever else a later TrueNAS release adds to a certificate ' +
    'record.',
  inputSchema: {
    type: 'object',
    properties: {
      expiring_within_days: {
        type: 'number',
        description:
          'Only report certificates with this many days or fewer left before ' +
          'they expire. Already-expired certificates are always included. ' +
          'Omitted, every certificate is reported.',
      },
    },
  },
  requiredRole: Role.ReadOnly,
  mutating: false,
  async handler({ system }, args) {
    // Read before the query is issued, so a threshold that cannot be read stops
    // the call rather than spending it.
    const threshold = withinDays(args['expiring_within_days']);
    // No filters and no options: a certificate listing is a handful of rows on
    // any system, and the threshold is applied against a day count the
    // middleware has no notion of comparing, so there is no filter that could
    // express it.
    const certificates = await firstValueFrom(system.client.api.query('certificate.query'));
    // One reading of the clock for the whole result, so that two certificates
    // expiring at the same instant cannot answer different day counts.
    const now = Date.now();
    const rows = certificates.map((certificate) => ({
      name: textOrNull(certificate.name),
      common_name: textOrNull(certificate.common),
      subject_alternative_names: textList(certificate.san),
      issuer: issuerName(certificate),
      not_before: textOrNull(certificate.from),
      not_after: textOrNull(certificate.until),
      days_until_expiry: daysUntil(instantOf(textOrNull(certificate.until)), now),
      expired: certificate.expired,
    }));
    if (threshold === null) return rows;
    // A row with no day count is dropped rather than kept: the caller asked for
    // the certificates inside a window, and one whose expiry cannot be read is
    // not known to be inside it. The description says so, and says which call
    // finds them.
    return rows.filter((row) => row.days_until_expiry !== null && row.days_until_expiry <= threshold);
  },
};
