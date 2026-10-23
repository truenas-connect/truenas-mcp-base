import type { JobParams } from '@truenas/api-client';
import { firstValueFrom } from 'rxjs';
import { Role } from '@/interfaces';
import type { ApiSurface, MutatingTool, PlanStep, ToolContext } from '@/catalog/tool';
import { ReadOnlyTool } from '@/catalog/tool';
import {
  errorText,
  numberOrNull,
  recordOrNull,
  refuseArgs,
  textList,
  textOrNull,
  watchJob,
  type WatchedJob,
} from '@/tools/common';

/**
 * Certificates family: which certificates this system holds, and when each one
 * stops being valid — and, through `certificate_csr_create`, a signing request
 * whose private key the system generates and keeps.
 *
 * `certificate.query` answers all of it in one call and carries an `entity` in
 * the client's own call directory for the version this is written against, so
 * `name`, `common`, `san`, `from`, `until` and `expired` are read as declared
 * fields — as the interface and network-configuration payloads are in
 * `network.ts`. What is read defensively here is the CONTENT of those fields,
 * not their names: a date the middleware formatted is still text this file has
 * to parse, and `issuerName` below is the one field with no declaration behind
 * it at all.
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
 * Two guards come from `common.ts` and both matter here. `textOrNull` reads the
 * subject components, which the middleware sends as `""` where a certificate
 * does not carry them. `textList` keeps an empty SAN list distinct from a
 * missing one: a certificate that reported an empty list carries no alternative
 * name, and one that reported no list said nothing about them.
 */

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
    'many days or fewer left. An already-expired certificate has a NEGATIVE ' +
    'day count, so ANY THRESHOLD OF ZERO OR MORE INCLUDES IT, which is what ' +
    'makes one call answer "what is about to break, and what already has". A ' +
    'NEGATIVE THRESHOLD asks the narrower question instead — the certificates ' +
    'that expired at least that many days ago — and returns only those. ' +
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
          'they expire. An already-expired certificate counts as a negative ' +
          'number of days, so any threshold of zero or more includes it. ' +
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

/** The create's argument, typed off the job method (#91). */
type CertificateCreateArgs = JobParams<ApiSurface, 'certificate.create'>[0];

/**
 * The values `certificate_csr_create` accepts for its enumerated fields, as a
 * `Record` over the create's declared unions (#190): a value the client adds or
 * drops fails to compile rather than being silently refused or accepted.
 */
const KEY_TYPES: Record<NonNullable<CertificateCreateArgs['key_type']>, true> = { RSA: true, EC: true };
const KEY_LENGTHS: Record<NonNullable<CertificateCreateArgs['key_length']>, true> = { 2048: true, 4096: true };
const EC_CURVES: Record<NonNullable<CertificateCreateArgs['ec_curve']>, true> = {
  SECP256R1: true,
  SECP384R1: true,
  SECP521R1: true,
  ed25519: true,
};
const DIGESTS: Record<NonNullable<CertificateCreateArgs['digest_algorithm']>, true> = {
  SHA224: true,
  SHA256: true,
  SHA384: true,
  SHA512: true,
};

/** The subject fields, by argument name, in the order the plan states them. */
const SUBJECT_FIELDS = ['country', 'state', 'city', 'organization', 'organizational_unit', 'email'] as const;

type SubjectField = (typeof SUBJECT_FIELDS)[number];

/** How the create's arguments are named in the plan, which an approver reads. */
const SUBJECT_LABELS: Record<SubjectField, string> = {
  country: 'country',
  state: 'state or province',
  city: 'city',
  organization: 'organization',
  organizational_unit: 'organizational unit',
  email: 'email',
};

interface CsrRequest {
  name: string;
  common: string | null;
  san: string[] | null;
  keyType: NonNullable<CertificateCreateArgs['key_type']> | null;
  keyLength: NonNullable<CertificateCreateArgs['key_length']> | null;
  ecCurve: NonNullable<CertificateCreateArgs['ec_curve']> | null;
  digest: NonNullable<CertificateCreateArgs['digest_algorithm']> | null;
  /** Only the subject fields passed; one not passed is absent and is not sent. */
  subject: Partial<Record<SubjectField, string>>;
}

/** A text argument that is optional, and non-empty where given. */
function optionalText(args: Record<string, unknown>, key: string): string | null {
  const value = args[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value === '') throw new Error(`"${key}" must be non-empty text`);
  return value;
}

/** An enumerated argument, checked against the `Record` of the values the create declares. */
function optionalChoice<T extends string | number>(
  args: Record<string, unknown>,
  key: string,
  choices: Record<T, true>,
): T | null {
  const value = args[key];
  if (value === undefined || value === null) return null;
  if ((typeof value !== 'string' && typeof value !== 'number') || !Object.hasOwn(choices, value)) {
    throw new Error(`"${String(value)}" is not a value of \`${key}\`; it accepts ${Object.keys(choices).join(', ')}`);
  }
  return value as T;
}

function parseCsrRequest(args: Record<string, unknown>): CsrRequest {
  refuseArgs(
    args,
    ['privatekey', 'passphrase'],
    'a private key or its passphrase is a secret argument, which this catalog does not take; the system ' +
      'generates the key for the request and keeps it',
  );
  refuseArgs(
    args,
    ['create_type', 'certificate', 'CSR', 'csr_id', 'add_to_trusted_store'],
    'this tool only creates a certificate signing request, and always sends CERTIFICATE_CREATE_CSR',
  );
  refuseArgs(
    args,
    ['acme_directory_uri', 'tos', 'dns_mapping', 'renew_days', 'cert_extensions'],
    'ACME and certificate extensions are not sent by this tool',
  );
  const name = args['name'];
  if (typeof name !== 'string' || name === '') {
    throw new Error('"name" is required and must be the name the system will hold the signing request under');
  }
  const rawSan = args['san'];
  let san: string[] | null = null;
  if (rawSan !== undefined && rawSan !== null) {
    if (!Array.isArray(rawSan) || rawSan.some((entry) => typeof entry !== 'string' || entry === '')) {
      throw new Error('"san" must be a list of names, such as ["nas.example.com"], each one non-empty');
    }
    san = rawSan as string[];
  }
  const keyType = optionalChoice(args, 'key_type', KEY_TYPES);
  const keyLength = optionalChoice(args, 'key_length', KEY_LENGTHS);
  const ecCurve = optionalChoice(args, 'ec_curve', EC_CURVES);
  // Refused rather than left to the middleware, which would otherwise pick a
  // default for whichever of the two it ignores. Each is accepted only beside
  // the key type it describes, NAMED — the default key type is not stated by
  // the surface, so an omitted one cannot be read as either.
  if (keyLength !== null && keyType !== 'RSA') {
    throw new Error('"key_length" applies to an RSA key only, and is accepted only beside "key_type": "RSA"');
  }
  if (ecCurve !== null && keyType !== 'EC') {
    throw new Error('"ec_curve" applies to an EC key only, and is accepted only beside "key_type": "EC"');
  }
  const subject: CsrRequest['subject'] = {};
  for (const field of SUBJECT_FIELDS) {
    const value = optionalText(args, field);
    if (value !== null) subject[field] = value;
  }
  return {
    name,
    common: optionalText(args, 'common'),
    san,
    keyType,
    keyLength,
    ecCurve,
    digest: optionalChoice(args, 'digest_algorithm', DIGESTS),
    subject,
  };
}

/** The arguments as passed, under their own names, for the confirmation token and the result. */
function csrArgs(request: CsrRequest): Record<string, unknown> {
  const args: Record<string, unknown> = { name: request.name };
  if (request.common !== null) args['common'] = request.common;
  if (request.san !== null) args['san'] = request.san;
  if (request.keyType !== null) args['key_type'] = request.keyType;
  if (request.keyLength !== null) args['key_length'] = request.keyLength;
  if (request.ecCurve !== null) args['ec_curve'] = request.ecCurve;
  if (request.digest !== null) args['digest_algorithm'] = request.digest;
  return { ...args, ...request.subject };
}

/**
 * The create's params, built in one place so the plan step names exactly the
 * call `execute` makes. `create_type` is always `CERTIFICATE_CREATE_CSR`, and
 * nothing but the fields named here is ever sent.
 */
function csrParams(request: CsrRequest): JobParams<ApiSurface, 'certificate.create'> {
  const create: CertificateCreateArgs = { name: request.name, create_type: 'CERTIFICATE_CREATE_CSR' };
  if (request.common !== null) create.common = request.common;
  if (request.san !== null) create.san = request.san;
  if (request.keyType !== null) create.key_type = request.keyType;
  if (request.keyLength !== null) create.key_length = request.keyLength;
  if (request.ecCurve !== null) create.ec_curve = request.ecCurve;
  if (request.digest !== null) create.digest_algorithm = request.digest;
  return [{ ...create, ...request.subject }];
}

/**
 * Whether the system already holds a certificate under this name, read through
 * an allowlist of the two fields this check needs.
 *
 * A `certificate.query` row carries the private key of every certificate on the
 * system, so `select` asks for `id` and `name` alone — and the row is still read
 * by name rather than forwarded, because a projected row comes back padded where
 * the system is a version ahead of the client (#115). The name is checked on the
 * response and not only asked for in the filter, since a filter that did not
 * apply comes back as the whole table (#121).
 */
async function nameInUse(ctx: ToolContext, name: string): Promise<boolean> {
  const rows: unknown = await firstValueFrom(
    ctx.system.client.api.query('certificate.query', [['name', '=', name]], { select: ['id', 'name'] }),
  );
  if (!Array.isArray(rows)) throw new Error('the response was not a list');
  return rows.some((row) => textOrNull(recordOrNull(row)?.['name']) === name);
}

/** What the plan says the request will carry, field by field, claiming nothing for what is not sent. */
function subjectSentence(request: CsrRequest): string {
  const parts = [
    `common name ${request.common === null ? 'not set' : JSON.stringify(request.common)}`,
    ...SUBJECT_FIELDS.map((field) => {
      const value = request.subject[field];
      return `${SUBJECT_LABELS[field]} ${value === undefined ? 'not set' : JSON.stringify(value)}`;
    }),
  ];
  const san =
    request.san === null
      ? 'No subject alternative name is sent.'
      : request.san.length === 0
        ? 'An empty subject alternative name list is sent.'
        : `Subject alternative names: ${request.san.map((entry) => JSON.stringify(entry)).join(', ')}.`;
  return ` Subject: ${parts.join('; ')}. ${san}`;
}

/** What the plan says about the key and digest, naming the default only as unstated. */
function keySentence(request: CsrRequest): string {
  const unstated = "not sent, so the system's default applies, which this API surface does not state";
  const key =
    request.keyType === null
      ? `Key type ${unstated}.`
      : request.keyType === 'RSA'
        ? `An RSA key, ${request.keyLength === null ? `length ${unstated}` : `${request.keyLength} bits`}.`
        : `An EC key, ${request.ecCurve === null ? `curve ${unstated}` : `curve ${request.ecCurve}`}.`;
  const digest = request.digest === null ? `Digest ${unstated}.` : `Digest ${request.digest}.`;
  return ` ${key} ${digest}`;
}

/**
 * The states this tool reads as a job having succeeded. Its own, as every
 * job-backed tool's is (#161), and passed to `watchJob` rather than shared.
 */
const CSR_JOB_SUCCESS_STATES = new Set(['SUCCESS', 'FINISHED']);

/** How long `certificate_csr_create` watches its job: a ceiling on its patience, not an estimate (#122). */
const CSR_WATCH_MS = 30_000;

/** The same bound in the unit the result reports it in. */
const CSR_WATCH_SECONDS = CSR_WATCH_MS / 1000;

/**
 * What the result reads off the job's answer. THE ENTRY IS READ BY NAMED FIELD
 * AND NEVER SPREAD: the job answers with the whole new certificate entry, and
 * that entry carries `privatekey` — the key this tool exists to keep on the
 * system — and `privatekey_path` beside the CSR.
 */
interface CsrResult {
  certificate_id: number | null;
  certificate_name: string | null;
  csr: string | null;
}

type WatchedCsrJob = WatchedJob & CsrResult;

/** The three fields, read only where the job was established to have ended. */
function csrResult(record: Record<string, unknown> | null, ended: boolean): CsrResult {
  const entry = ended ? recordOrNull(record?.['result']) : null;
  return {
    certificate_id: numberOrNull(entry?.['id']),
    certificate_name: textOrNull(entry?.['name']),
    csr: textOrNull(entry?.['CSR']),
  };
}

const CERTIFICATE_CSR_CREATE_GUIDANCE =
  '`name` is the name passed and `requested` is exactly what was passed, under the arguments\' own names. ' +
  '`csr` is the certificate signing request in PEM form, as the system produced it, and is what to send to a ' +
  'certificate authority. It is public material. `certificate_id` and `certificate_name` are the new entry ' +
  'as the job\'s own answer names it. ALL THREE ARE READ ONLY WHERE `ended` IS TRUE, and are null everywhere ' +
  'else; each is also null where the job ended and its answer did not carry that field in a form this tool ' +
  'reads, which is NOT evidence the request was not created. THE PRIVATE KEY IS NEVER IN THIS RESULT, in ' +
  'any form, and neither is its path on the system. `ended` is whether the job was ESTABLISHED to have ' +
  'reached a state it will not move out of. FALSE MEANS NOTHING WAS ESTABLISHED: the job may still be ' +
  'running, the watch may have been cut short by a dropped connection, or no job was seen at all — ' +
  '`job_state` and `job_id` narrow that and do not partition it. `succeeded` is true where the job ended in ' +
  '`SUCCESS` or `FINISHED`, false where it ended in any other state, and null wherever `ended` is false. ' +
  '`error` is the text the job recorded, null where it recorded none. `finished_at` is when the job ended, ' +
  'as an ISO 8601 UTC timestamp, and null wherever `ended` is false. `job_id` is the job\'s numeric ' +
  'identity, taken from the job event that named this request; null there does not mean nothing started. ' +
  '`watched_seconds` is the ceiling that applied, not how long the watch lasted. WHERE THE WATCH ENDED ' +
  'FIRST, THE CSR IS NOT IN HAND AND NO TOOL IN THIS CATALOG RETURNS IT LATER: `certificates_list` lists ' +
  'the entry by name once it exists, with null validity dates, and does not say it is a signing request or ' +
  'return its PEM. The web UI is where it is read then.';

export const certificateCsrCreate: MutatingTool = {
  name: 'certificate_csr_create',
  description:
    'Has this TrueNAS system generate a private key and a certificate signing request (CSR) for it, and ' +
    'returns the CSR to send to a certificate authority. Two-phase: called without a confirmation_token it ' +
    'returns a plan for user approval; called with one it starts the job. THE PRIVATE KEY NEVER LEAVES THE ' +
    'SYSTEM: it is generated there, it is not returned, and no key, passphrase or certificate is taken as an ' +
    'argument — importing a key or a signed certificate, and ACME, are not done here. This is the first step ' +
    'in replacing a self-signed certificate. `name` is what the system holds the request under; A NAME ' +
    'ALREADY IN USE BY ANY CERTIFICATE FAILS THE PLAN, as does one whose use could not be read. `common` and ' +
    '`san` are the names the certificate will be valid for — modern clients match on `san` — and `country`, ' +
    '`state`, `city`, `organization`, `organizational_unit` and `email` are the rest of the subject; each ' +
    'one not passed is not set. `key_type` is RSA or EC; `key_length` (2048 or 4096) is accepted only beside ' +
    'RSA and `ec_curve` only beside EC, both named explicitly, and `digest_algorithm` is one of SHA224, ' +
    'SHA256, SHA384 and SHA512. Any of those not passed is the system\'s default, which this API surface does ' +
    'not state, and the plan says so. The plan states the subject and every alternative name the request ' +
    'will carry. THE RESULT IS ABOUT THE JOB THIS CALL STARTED: the tool watches it for at most ' +
    '`watched_seconds` and then returns what it has, leaving the job going. `destructiveness` is ' +
    '`reversible`: nothing is deleted or changed. BUT NO TOOL IN THIS CATALOG DELETES A CERTIFICATE OR A ' +
    'SIGNING REQUEST, so undoing this is a deletion a person makes in the web UI. ' +
    CERTIFICATE_CSR_CREATE_GUIDANCE,
  resultGuidance: CERTIFICATE_CSR_CREATE_GUIDANCE,
  inputSchema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'The name the system will hold the signing request under; it must not already be in use.',
      },
      common: { type: 'string', description: "The certificate's common name, e.g. nas.example.com." },
      san: {
        type: 'array',
        items: { type: 'string' },
        description: 'Subject alternative names: every hostname or address the certificate must be valid for.',
      },
      key_type: { type: 'string', enum: Object.keys(KEY_TYPES), description: 'RSA or EC.' },
      key_length: {
        type: 'integer',
        enum: Object.keys(KEY_LENGTHS).map(Number),
        description: 'The RSA key length in bits. Only beside key_type RSA.',
      },
      ec_curve: { type: 'string', enum: Object.keys(EC_CURVES), description: 'The EC curve. Only beside key_type EC.' },
      digest_algorithm: { type: 'string', enum: Object.keys(DIGESTS), description: 'The signature digest.' },
      country: { type: 'string', description: 'Two-letter country code, e.g. US.' },
      state: { type: 'string', description: 'State or province.' },
      city: { type: 'string', description: 'City or locality.' },
      organization: { type: 'string', description: 'Organization.' },
      organizational_unit: { type: 'string', description: 'Organizational unit.' },
      email: { type: 'string', description: 'Contact email address carried in the subject.' },
    },
    required: ['name'],
  },
  requiredRole: Role.Full,
  mutating: true,
  // One new entry, and nothing existing is deleted or changed. Undoing it is a
  // deletion no tool here makes, which the description says (#153).
  destructiveness: 'reversible',
  normalizeArgs(rawArgs) {
    return csrArgs(parseCsrRequest(rawArgs));
  },
  async plan(ctx, rawArgs): Promise<PlanStep[]> {
    const request = parseCsrRequest(rawArgs);
    let inUse: boolean;
    try {
      inUse = await nameInUse(ctx, request.name);
    } catch (reason) {
      throw new Error(
        `Whether a certificate named "${request.name}" already exists could not be read (certificate.query ` +
          `failed: ${errorText(reason)}), so nothing is planned`,
      );
    }
    if (inUse) {
      throw new Error(
        `A certificate named "${request.name}" already exists on this system; \`certificates_list\` reports ` +
          'every name in use',
      );
    }
    return [
      {
        method: 'certificate.create',
        params: csrParams(request),
        description:
          `Generate a private key and a certificate signing request named "${request.name}" on this system.` +
          `${subjectSentence(request)}${keySentence(request)} The private key stays on the system and is not ` +
          `returned. The job is watched for at most ${CSR_WATCH_SECONDS} seconds; where it has not ended by ` +
          'then, the CSR is not returned and no tool here returns it later. Whether the name is free was read ' +
          'when this plan was made and is not read again. No tool here deletes the request once made.',
      },
    ];
  },
  async execute(ctx, rawArgs) {
    const request = parseCsrRequest(rawArgs);
    const api = ctx.system.client.api;
    const job: WatchedCsrJob = await watchJob(api, api.callAndGetJobId('certificate.create', csrParams(request)), {
      watchMs: CSR_WATCH_MS,
      successStates: CSR_JOB_SUCCESS_STATES,
      extra: csrResult,
    });
    return {
      name: request.name,
      requested: csrArgs(request),
      watched_seconds: CSR_WATCH_SECONDS,
      ...job,
    };
  },
};
