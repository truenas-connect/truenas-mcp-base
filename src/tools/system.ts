import { firstValueFrom } from 'rxjs';
import { Role } from '@/interfaces';
import { ReadOnlyTool, SystemHandle } from '@/catalog/tool';
import {
  MAX_TIME_MS,
  MiddlewareDate,
  NO_REASON,
  errorText,
  numberOrNull,
  recordOrNull,
  textOrNull,
} from '@/tools/common';

/**
 * Grounds the LLM on what it is talking to — version, hostname, hardware —
 * before it reasons about anything else.
 */
export const systemInfo: ReadOnlyTool = {
  name: 'system_info',
  description:
    'Basic information about a TrueNAS system: hostname, version, uptime, ' +
    'hardware model, CPU and memory.',
  inputSchema: { type: 'object', properties: {} },
  requiredRole: Role.ReadOnly,
  mutating: false,
  async handler({ system }) {
    const info = await firstValueFrom(system.client.api.call('system.info'));
    return {
      hostname: info.hostname,
      version: info.version,
      uptime: info.uptime,
      model: info.model,
      cores: info.cores,
      physical_cores: info.physical_cores,
      memory_bytes: info.physmem,
      timezone: info.timezone,
    };
  },
};

/**
 * `textOrNull` from `common.ts` reads the version, where a string of no
 * characters names nothing a caller could act on. {@link NO_REASON} is imported
 * beside `errorText` because `checkFailure` below reports it directly, for an
 * update check that failed carrying no text of its own.
 */

/** What a system answering the check with no status at all is reported as. */
const NO_STATUS = 'the system reported no update status';

/** The running version, or the failure that stopped it being read. */
interface VersionAttempt {
  value: string | null;
  error: string | null;
}

/**
 * The version the system is running now, with a failure named rather than
 * thrown.
 *
 * `update.status` reports the train and profile the system updates along and
 * the version it could move to, but never the version it is on — its
 * `current_version` names the train, the profile and whether the two agree, and
 * nothing else. So the running version is a second read, and it is reported
 * rather than fatal for the reason `accounts.ts` gives for its configuration
 * read: the question the tool is asked — is an update available, and which — is
 * answered by `update.status` on its own, and losing the version it is moving
 * from must not lose the answer as well.
 */
async function readVersion(system: SystemHandle): Promise<VersionAttempt> {
  try {
    const version = await firstValueFrom(system.client.api.call('system.version'));
    return { value: textOrNull(version), error: null };
  } catch (reason) {
    return { value: null, error: errorText(reason) };
  }
}

/**
 * The `update.status` payload, read through one seam so that its type is taken
 * from the client by inference rather than restated here — the generated types
 * suffix duplicate names, and a hand-written copy of one is a copy that can
 * drift.
 *
 * `code` is the system's own verdict on whether the check itself worked —
 * `NORMAL` or `ERROR` — and `status` carries the answer where it did.
 */
function readStatus(system: SystemHandle) {
  return firstValueFrom(system.client.api.call('update.status'));
}

/** What {@link readStatus} answers with. */
type UpdateReport = Awaited<ReturnType<typeof readStatus>>;

/**
 * Why the check could not answer, in words. Only ever called where it did not.
 *
 * The system's own error is preferred, then its error name — a reason a person
 * can read before a symbol only a machine can — and a check that failed while
 * saying nothing still has to read as one that failed. A system that reported
 * `NORMAL` and then sent no status is a third case: nothing went wrong that it
 * admits to, and there is still no answer in the payload.
 */
function checkFailure(report: UpdateReport): string {
  const error = report.error;
  if (error !== null) return textOrNull(error.reason) ?? textOrNull(error.errname) ?? NO_REASON;
  return report.code === 'ERROR' ? NO_REASON : NO_STATUS;
}

/**
 * Whether a TrueNAS update is available, and which.
 *
 * The distinction the tool exists to keep is between a system that is up to
 * date and one that could not be asked. Both have no update to report, and
 * across a fleet they are opposite answers: the first needs nothing, the second
 * has not been checked at all and may have been unchecked for months. So
 * `update_available` is a three-valued answer — false, true, or null for "not
 * established" — rather than a boolean that quietly reads an unreachable update
 * server as good news.
 */
export const updateStatus: ReadOnlyTool = {
  name: 'system_update_status',
  description:
    'Whether a TrueNAS update is available for this system, and which. ' +
    '`update_available` is true when the system has an update it could move ' +
    'to, false when it is already up to date, and NULL WHEN THE CHECK COULD ' +
    'NOT BE COMPLETED — a system that is air-gapped, that cannot reach the ' +
    'update server, or that reported no status at all. Null is not "no update ' +
    'available": nothing has been established about that system, and it may ' +
    'have been unchecked for a long time. `check_error` is what the system ' +
    'said about that failure and is null whenever `update_available` is true ' +
    'or false. `new_version` is the version the system would move to, and is ' +
    'null unless `update_available` is true. `train` is the update train the ' +
    'system follows — the channel its updates come from. `new_version` and ' +
    '`train` ARE BOTH NULL WHILE `update_available` IS NULL, because they come ' +
    'from the status the check did not produce, not because the system has no ' +
    'train. `current_version` is the version the system is running now and ' +
    'comes from a SEPARATE read, so it is unaffected by a failed check and is ' +
    'reported even where `update_available` is null. `version_error` names ' +
    'what the system said when that read failed, and `current_version` is null ' +
    'while it is non-null; `current_version` null with `version_error` null is ' +
    'a system that answered the read with no version. This tool only checks. ' +
    'It does not download, apply or schedule an update, and it does not reboot ' +
    'anything. Applications are updated separately and are not reported here — ' +
    'that is `apps_list`.',
  inputSchema: { type: 'object', properties: {} },
  requiredRole: Role.ReadOnly,
  mutating: false,
  async handler({ system }) {
    // Both reads are issued before either is awaited, so neither waits on the
    // other. Only the status read may fail the tool, for the reason
    // `readVersion` gives.
    const [report, version] = await Promise.all([readStatus(system), readVersion(system)]);

    // The check has an answer only where the system said the check itself
    // worked AND sent a status to read. A payload that reports `ERROR` and a
    // status together is not read as an answer: the system has said its own
    // check did not complete, and a stale or partial status behind that is
    // exactly what must not be reported as "up to date".
    const status = report.code === 'NORMAL' ? report.status : null;
    const candidate = status?.new_version ?? null;
    return {
      update_available: status === null ? null : candidate !== null,
      current_version: version.value,
      new_version: candidate === null ? null : textOrNull(candidate.version),
      train: status === null ? null : textOrNull(status.current_version.train),
      check_error: status === null ? checkFailure(report) : null,
      version_error: version.error,
    };
  },
};

/**
 * An audit row arrives as an open record, so the fields below are read through
 * `common.ts`'s guards. `recordOrNull` excludes an array, which is an object
 * and is never one of the keyed payloads it is used to read here.
 */

/**
 * How far back `audit_log_query` reaches when the caller bounds nothing.
 *
 * The audit trail records every API call the middleware serves, so a system a
 * few people administer holds thousands of entries a day and one nobody touches
 * still holds the ones its own services made. A day is the window that makes
 * "what changed, and who changed it" answerable in one call; a longer one is
 * asked for rather than assumed.
 */
const AUDIT_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * How many audit entries one call returns at most.
 *
 * Fixed rather than a `limit` argument, unlike `snapshots_list` and
 * `users_list`. Those bound a set that is finite and slowly changing, where a
 * caller raising the bound eventually sees all of it; the audit trail grows
 * without limit and no bound reaches the end of it, so the way to see more here
 * is a narrower question — a shorter window, a named user, one service — rather
 * than a bigger page.
 */
const AUDIT_LIMIT = 100;

/**
 * {@link MAX_TIME_MS} is the guard that keeps one absurd recorded time from
 * taking the whole listing down with it, and {@link MiddlewareDate} is the
 * shape an audit row's timestamp arrives in. Both are `common.ts`'s, applied
 * here to an entry's `message_timestamp`.
 */

/**
 * A date, or a date and a time, in the forms this tool reads: `2026-08-29`,
 * `2026-08-29T09:00:00Z`, `2026-08-29T09:00:00+02:00`, and the same with a
 * space instead of the `T` and with no zone at all.
 *
 * Groups: year, month, day, hour, minute, second, fractional second, zone.
 */
const AUDIT_TIME =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,6}))?)?(Z|[+-]\d{2}:\d{2})?)?$/;

/**
 * The instant a timestamp names, in milliseconds since the epoch, or null where
 * it is not one of the forms above or does not name a real instant.
 *
 * Built from the components rather than handed to `Date.parse`, and that is the
 * whole reason a zoneless time is read at all here where `tasks.ts` refuses one.
 * `Date.parse('2026-08-29 09:00:00')` is implementation-defined and Node reads
 * it as LOCAL time, so the same recorded instant would come back different on
 * two machines — silently, and by hours. Composed here it is read as UTC,
 * explicitly and identically everywhere, which is (unconfirmed) how the
 * middleware records audit times; the cost of that reading being wrong is a
 * timestamp offset by the middleware's own zone, against a certainty of one
 * offset by whatever zone this process happens to run in.
 *
 * The result is checked back against the components it was built from, which
 * settles two things at once that nothing else here would: a day the month does
 * not have ROLLS OVER rather than failing — `2026-02-30` composes as the 2nd of
 * March — and so does an hour of 25, while a year below 100 would be read as
 * 19xx by `Date.UTC`'s two-digit-year rule.
 */
function utcMillis(text: string): number | null {
  const match = AUDIT_TIME.exec(text);
  if (match === null) return null;
  const [, year, month, day, hour, minute, second, fraction, zone] = match;
  // A `Date` holds milliseconds and the audit table records microseconds, so
  // the digits past the third are dropped rather than rounded: that moves an
  // instant by less than a millisecond and never across the bound it is
  // compared at.
  const millis = fraction === undefined ? 0 : Number(fraction.slice(0, 3).padEnd(3, '0'));
  const at = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    hour === undefined ? 0 : Number(hour),
    minute === undefined ? 0 : Number(minute),
    second === undefined ? 0 : Number(second),
    millis,
  );
  const composed = new Date(at);
  if (
    composed.getUTCFullYear() !== Number(year) ||
    composed.getUTCMonth() !== Number(month) - 1 ||
    composed.getUTCDate() !== Number(day) ||
    (hour !== undefined && composed.getUTCHours() !== Number(hour)) ||
    (minute !== undefined && composed.getUTCMinutes() !== Number(minute))
  ) {
    return null;
  }
  if (zone === undefined || zone === 'Z') return at;
  const zoneHours = Number(zone.slice(1, 3));
  const zoneMinutes = Number(zone.slice(4, 6));
  // An offset outside the range a zone can have is a malformed one, and reading
  // it would shift the instant by the amount it is wrong by.
  if (zoneHours > 23 || zoneMinutes > 59) return null;
  // Ahead of UTC is earlier in UTC, so the offset is subtracted.
  const offset = (zoneHours * 60 + zoneMinutes) * 60_000;
  return zone.startsWith('-') ? at + offset : at - offset;
}

/**
 * When an audit entry was recorded, in milliseconds since the epoch, or null
 * where the system reported no time this tool can read.
 *
 * Three forms, because the pinned client describes this field two different
 * ways and neither has been checked against a live middleware: the oldest
 * directory types an audit row as an open record, and a later one types
 * `timestamp` as a string. A bare number is accepted beside the
 * `{ "$date": … }` envelope for the reason `tasks.ts` accepts one — the
 * envelope exists to tag a number as a date in transit, and both are epoch
 * milliseconds.
 *
 * `message_timestamp` is deliberately not read as a fallback. It is the column
 * this tool asks the system to order by, and it is a number whose unit the
 * client does not state; reading it as milliseconds where it is seconds would
 * date every entry to 1970 while looking exactly like a real answer.
 */
function entryMillis(value: unknown): number | null {
  const raw = typeof value === 'object' && value !== null ? (value as MiddlewareDate).$date : value;
  if (typeof raw === 'number') {
    return Number.isFinite(raw) && Math.abs(raw) <= MAX_TIME_MS ? raw : null;
  }
  return typeof raw === 'string' ? utcMillis(raw) : null;
}

/**
 * The instant the window starts at, in milliseconds since the epoch — the
 * default window back from `now` where the caller named none.
 *
 * Strict rather than lenient, as `tasks_recent_runs` is about its own `since`
 * and for the same reason: a bound that cannot be read is not a request for the
 * default one. Ignoring it would answer about the last day while the caller
 * believes it answered about the last month, and an empty result would then
 * read as "nobody did anything" rather than as "the bound was not applied".
 * Null and undefined are the argument being absent, which is not the same as
 * unreadable and is what the default is for.
 */
function windowStart(raw: unknown, now: number): number {
  if (raw == null) return now - AUDIT_WINDOW_MS;
  const millis = typeof raw === 'string' ? utcMillis(raw) : null;
  if (millis === null) {
    throw new Error(
      '"since" must be an ISO 8601 timestamp such as "2026-08-29T09:00:00Z", or a date ' +
        'such as "2026-08-29". A time given without a timezone is read as UTC.',
    );
  }
  return millis;
}

/**
 * A filter the caller named, or null where it named none.
 *
 * Strict, as `snapshots_list` is about the dataset it is asked for: a filter
 * this tool could not read must not be dropped, because the result would then
 * answer a wider question than the one asked while looking like the answer to
 * it — every user's activity presented as one person's.
 */
function requestedText(raw: unknown, name: string): string | null {
  if (raw == null) return null;
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new Error(`"${name}" must be a non-empty string`);
  }
  return raw;
}

/**
 * The services the middleware keeps a separate trail for, as the pinned client
 * spells them.
 *
 * Used only to narrow the query: `audit.query` takes the trails to search as a
 * closed list of names, and a service outside it cannot be passed there. A name
 * this list does not hold is still filtered on — through `query-filters`, which
 * is untyped, and again on the response — so a service a later TrueNAS release
 * adds is answerable rather than refused.
 */
const AUDIT_SERVICES = ['MIDDLEWARE', 'SMB', 'SUDO', 'SYSTEM'] as const;

/** The named service as `audit.query` spells it, or undefined where it is not one. */
function namedService(service: string | null): (typeof AUDIT_SERVICES)[number] | undefined {
  return AUDIT_SERVICES.find((known) => known === service);
}

/**
 * The API method an audit entry records a call to, or null where the entry is
 * not a call or does not name one.
 *
 * (unconfirmed) `event_data` is an open record whose contents differ per event,
 * and the pinned client types it `{ [k: string]: unknown } | null`, so the key
 * holding the method name is read as `method` on the evidence of the middleware
 * event it belongs to. Getting it wrong costs a null rather than a wrong
 * method, and `event` still says what kind of entry it is either way.
 *
 * Nothing else of `event_data` is read, and that is a rule rather than an
 * omission: it carries the PARAMETERS the call was made with, which for an
 * account or a share or a credential is where the password, key or token is.
 * The same refusal `tasks_recent_runs` applies to a job's arguments.
 */
function auditMethod(eventData: unknown): string | null {
  if (typeof eventData !== 'object' || eventData === null) return null;
  return textOrNull((eventData as Record<string, unknown>)['method']);
}

/** Newest first; an entry whose timestamp could not be read goes last. */
function byNewestFirst(a: { at: number | null }, b: { at: number | null }): number {
  if (a.at === null) return b.at === null ? 0 : 1;
  if (b.at === null) return -1;
  return b.at - a.at;
}

/**
 * What changed, and who changed it.
 *
 * The audit trail is the first question of every incident and every compliance
 * review, and it is also how a user checks up on the assistant itself: an MCP
 * tool reaches the system through the same middleware API as a person at the
 * console, so what this tool does lands in the same trail this tool reads. That
 * is the point rather than a side effect — it makes the model auditable through
 * the model.
 *
 * Reads records that name people, and so returns the fields that answer the
 * question and no others. The acting user, when, which service, which method
 * and whether it worked; not the address the call came from, not the session it
 * belonged to, and not the parameters it carried.
 */
export const auditLogQuery: ReadOnlyTool = {
  name: 'audit_log_query',
  description:
    'Recent entries from the TrueNAS audit trail — what was done on this ' +
    'system, by whom, and whether it worked. Each entry carries `timestamp`, ' +
    'when it was recorded, as an ISO 8601 UTC timestamp; `user`, the account ' +
    'that acted; `service`, which trail it came from — `MIDDLEWARE` for the ' +
    'API the web UI, the CLI and this tool all call, `SMB` for file share ' +
    'access, `SUDO` for commands run as another user, `SYSTEM` for the system ' +
    'itself, and a name a later TrueNAS release adds is passed through as the ' +
    'system spelled it; `event`, the kind of entry, such as `METHOD_CALL` or ' +
    '`AUTHENTICATION`; `method`, the API method a call names, which is null on ' +
    'an entry that is not a call or that did not name one; and `success`, ' +
    'whether the action succeeded. Every one of the six is null where the ' +
    'system reported no value this tool could read, and a null `success` IS ' +
    'NOT A FAILURE — it is an outcome that was not recorded. The parameters an ' +
    'action was called with are NOT returned: they hold passwords, keys and ' +
    'tokens for anything that creates an account, a share or a credential, and ' +
    'no secret passes through this tool. Neither is the network address or the ' +
    'session, which are not needed to answer what was done and by whom. ' +
    '`since` bounds the result to entries recorded at or after an ISO 8601 ' +
    'instant; omitted, THE LAST 24 HOURS, so an empty result means nothing ' +
    'matched inside that window rather than that the system has never recorded ' +
    'the action in question. An entry whose own timestamp could not be read is ' +
    'returned under any window, because nothing places it outside one. `since` ' +
    'NARROWS WHAT CAME BACK RATHER THAN REACHING PAST IT: the system is asked ' +
    'for its most recent entries and the window is applied to those, so on a ' +
    'system busy enough to fill the bound inside an hour, an older `since` ' +
    'returns the same recent entries and says `truncated`. Narrow with `user` ' +
    'or `service` to see further back than the bound reaches. `user` and ' +
    '`service` narrow it to one account or one trail, matched exactly, and an ' +
    'entry whose own `user` or `service` could not be read is NOT returned ' +
    'when the matching argument is given — it has not been shown to be that ' +
    "account's. The `since` that comes back is the bound actually applied, so " +
    'an empty result can be read against the window it was taken from. The ' +
    'result is bounded: `entries` holds at most `limit` — 100, which is not ' +
    'adjustable — and `truncated` is true when more matched than were ' +
    'returned, and when this tool cannot rule that out. NARROW THE QUESTION ' +
    'UNTIL `truncated` IS FALSE before reading ' +
    'the entries as everything that happened. Entries are newest first, and ' +
    'one whose timestamp could not be read is ordered last, so it is the first ' +
    'to be dropped from a truncated result. AN EMPTY `entries` MEANS THE TRAIL ' +
    'WAS READ AND NOTHING IN IT MATCHED — never that nothing happened. A ' +
    'service the system is not auditing records nothing at all and so returns ' +
    'nothing here, which is indistinguishable from a quiet system: this tool ' +
    'reads the trail and cannot say whether a service is being written to it. ' +
    '`audit_config` reads the settings behind that question. A trail that ' +
    'could not be read at all is an error naming what the system said, not an ' +
    'empty list. This tool reads the audit trail. It does not change what is ' +
    'audited, how long entries are kept, or anything else — that is ' +
    'configuration, and `audit_config` reads it without changing it either.',
  inputSchema: {
    type: 'object',
    properties: {
      since: {
        type: 'string',
        description:
          'Only report entries recorded at or after this instant, as an ISO ' +
          '8601 timestamp — "2026-08-29T09:00:00Z" — or a date, "2026-08-29", ' +
          'which is midnight. A time given without a timezone is read as UTC. ' +
          'Omitted, the last 24 hours.',
      },
      user: {
        type: 'string',
        minLength: 1,
        description: 'Only report entries whose acting user is exactly this account.',
      },
      service: {
        type: 'string',
        minLength: 1,
        description:
          'Only report entries from exactly this trail, spelled as the system ' +
          'spells it. `MIDDLEWARE`, `SMB`, `SUDO` and `SYSTEM` are the trails ' +
          'TrueNAS keeps today; a name a later release adds works here too.',
      },
    },
  },
  requiredRole: Role.ReadOnly,
  mutating: false,
  async handler({ system }, args) {
    // Every argument is read before the call, so an unreadable one is an error
    // rather than a query the system answers and this tool then discards.
    const user = requestedText(args['user'], 'user');
    const service = requestedText(args['service'], 'service');
    const since = windowStart(args['since'], Date.now());
    const filters: unknown[] = [];
    if (user !== null) filters.push(['username', '=', user]);
    if (service !== null) filters.push(['service', '=', service]);
    const named = namedService(service);
    const answer = await firstValueFrom(
      // The request is inlined so the call's own parameter types apply, as in
      // `storage.ts`. `audit.query` is not one of the client's query helpers —
      // it takes one object rather than filters and options as arguments — so
      // it goes through `call`, whose second argument is the whole parameter
      // tuple the method declares rather than the first parameter of it.
      system.client.api.call('audit.query', [
        {
          // Omitted rather than passed empty where the caller named a service
          // the client does not list, which would otherwise search no trail at
          // all.
          ...(named === undefined ? {} : { services: [named] }),
          'query-filters': filters,
          'query-options': {
            // One more entry than the bound, as `snapshots_list` asks for: that
            // extra entry is what says more matched than fit, and it is counted
            // and then dropped.
            limit: AUDIT_LIMIT + 1,
            // Unlike `snapshots_list`, which asks for no order because no field
            // of a snapshot orders it in time soundly. Here the bound is the
            // whole question — "recent" — so which entries a truncated result
            // holds has to be the most recent ones, and `message_timestamp` is
            // the one field of an audit row the client types as the time the
            // system recorded it under. The window below is applied to what
            // comes back, so an ordering the system did not apply costs entries
            // that fall outside it rather than wrong ones.
            order_by: ['-message_timestamp'],
          },
        },
      ]),
    );
    // `count: true` answers a number and `get: true` a single entry; neither is
    // asked for here, so anything but a list is a system answering a question
    // this tool did not ask. Fatal rather than empty: an empty result is an
    // answer about the trail, and this is not one.
    if (!Array.isArray(answer)) {
      throw new Error('audit.query did not answer with a list of audit entries');
    }
    const kept = [];
    // Whether the re-check below removed anything, which is the only evidence
    // this tool gets that the system did not apply a filter it was given.
    let unfiltered = false;
    for (const row of answer) {
      const at = entryMillis(row['timestamp']);
      // Only an entry whose timestamp reads as older than the bound is dropped.
      // One with no readable timestamp is kept: nothing places it outside the
      // window, and an action disappearing because the time it was recorded at
      // was unreadable is the failure worth avoiding here.
      if (at !== null && at < since) continue;
      const entry = {
        timestamp: at === null ? null : new Date(at).toISOString(),
        user: textOrNull(row['username']),
        service: textOrNull(row['service']),
        event: textOrNull(row['event']),
        method: auditMethod(row['event_data']),
        // Not defaulted to false: an outcome the system did not record must not
        // be presented as an action that failed, or as one that worked.
        success: typeof row['success'] === 'boolean' ? row['success'] : null,
      };
      // Both filters are asked of the system above and checked again here. An
      // unrecognised query parameter is dropped rather than refused, so a
      // middleware that did not apply one would otherwise answer about every
      // account while looking exactly like an answer about the one asked for.
      if (user !== null && entry.user !== user) {
        unfiltered = true;
        continue;
      }
      if (service !== null && entry.service !== service) {
        unfiltered = true;
        continue;
      }
      kept.push({ at, entry });
    }
    return {
      // Sorted before the bound is applied, so the entries dropped are the
      // oldest of what matched rather than whichever the system sent last.
      entries: kept
        .sort(byNewestFirst)
        .slice(0, AUDIT_LIMIT)
        .map((held) => held.entry),
      // Two ways the system can hold more than came back, and the second is
      // the one this tool cannot see past. Where the system applied the
      // filters, what it sent IS what matched, so more matched than fit
      // exactly when more came back than fit. Where it did not — the re-check
      // above removed something, so the filters reached it and did nothing —
      // the entries it dropped instead of the system stand between this result
      // and however many further matches lie beyond the bound, and nothing
      // here can count them. That is reported as truncated rather than
      // guessed at: the description tells a caller to narrow the question
      // until it is false, and the failure worth avoiding is a partial answer
      // that says it is whole.
      //
      // The window is not read that way. It is applied here rather than by the
      // system, but entries fall outside it in the same order the system was
      // asked to sort by, so what it removed is the tail — and there is
      // nothing further inside the window behind it.
      truncated: kept.length > AUDIT_LIMIT || (unfiltered && answer.length > AUDIT_LIMIT),
      limit: AUDIT_LIMIT,
      // The bound actually applied, so that an empty result is readable against
      // the window it was taken from rather than against an assumed one.
      since: new Date(since).toISOString(),
    };
  },
};

/**
 * The things the system listed beside one service, as names — or null where it
 * listed something this tool cannot read as one.
 *
 * All-or-nothing rather than per-entry: an entry that could not be read is
 * dropped from a list only by making the whole list null, because a list
 * silently missing one share reads as a share that is not audited, which is the
 * opposite of what is known about it. The same reading `audit_log_query` applies
 * to a filter it could not check.
 */
function scopeNames(value: unknown): string[] | null {
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
 * The services the system keeps audit configuration for, with what it listed
 * beside each — or null where it sent no service configuration this tool could
 * read.
 *
 * This is deliberately NOT read as "the services being audited", and the field
 * it becomes is not named that way. The pinned client declares `MIDDLEWARE`,
 * `SMB` and `SUDO` as required members of `enabled_services`, so all three are
 * present on a system auditing none of them: presence is the middleware
 * enumerating what it can audit, and it does not establish that any of it is
 * switched on. Naming the field for the setting would state exactly the
 * guarantee the read cannot deliver, which is what `app/CLAUDE.md` records as
 * this repository's most common defect — and what `fleet_compliance_report`
 * avoided by naming its own field `recording` after the evidence.
 *
 * A service is reported under the name the system spelled it with, so a service
 * a later TrueNAS release begins auditing is answerable here without a change —
 * these are values rather than fields, and the allowlist this file keeps is over
 * the fields of the result.
 *
 * A name the system sent that this tool cannot read nulls the whole list, on
 * the same all-or-nothing reading {@link scopeNames} takes of a scope and for
 * the same reason: a list quietly one service shorter reads as a service the
 * system does not audit, which is more than the read established.
 *
 * Sorted by name, because the middleware sends a keyed object and the order of
 * its keys means nothing; leaving it alone would make the result differ between
 * two reads of the same unchanged configuration.
 */
function configuredServices(value: unknown): { service: string; scope: string[] | null }[] | null {
  const services = recordOrNull(value);
  if (services === null) return null;
  const names = Object.keys(services);
  if (names.some((name) => name.length === 0)) return null;
  return names.sort().map((service) => ({ service, scope: scopeNames(services[service]) }));
}

/**
 * What the system is auditing, rather than what it audited.
 *
 * The counterpart to `audit_log_query`, and the distinction between them is the
 * whole point: the trail says what was recorded, and reading it can never
 * establish that a service is NOT being audited — a service nobody is auditing
 * and a service nobody has used both record nothing. `fleet_compliance_report`
 * says exactly that about its own `auditing` section, which is why this tool
 * exists. The setting is the only place the answer is stated rather than
 * inferred.
 *
 * Reads the configuration and does not change it. `audit.update` is the
 * mutating counterpart and is not in this catalog.
 */
export const auditConfig: ReadOnlyTool = {
  name: 'audit_config',
  description:
    'The audit SETTINGS of a TrueNAS system — what it is configured to audit, ' +
    'whether audit records are also shipped off the box, how long they are ' +
    'kept, and how much room the audit dataset has left. This is the ' +
    'configuration, NOT the trail: for what was actually recorded, and by ' +
    'whom, that is `audit_log_query`. The two answer different questions and ' +
    'reading one for the other is the mistake this tool exists to prevent — an ' +
    'empty trail cannot establish that a service is unaudited, because a ' +
    'service nobody audits and a service nobody has used both record nothing. ' +
    '`services` is one entry per service the system keeps audit configuration ' +
    'for, sorted by name. `service` is the name as the system spelled it — ' +
    '`MIDDLEWARE` for the API the web UI, the CLI and this tool all call, ' +
    '`SMB` for file share access, `SUDO` for commands run as another user, and ' +
    'a name a later TrueNAS release adds is passed through as the system ' +
    'spelled it. BEING LISTED HERE IS NOT "THIS SERVICE IS AUDITED": the ' +
    'system enumerates every service it CAN audit, and reports all of them ' +
    'whether or not any is switched on, so this tool cannot tell you from this ' +
    'field alone that a service is being audited. `scope` is what the system ' +
    'listed beside that service, such as the SMB shares being audited. A ' +
    'NON-EMPTY `scope` IS THE ONE POSITIVE ANSWER HERE — it names things the ' +
    'system says it audits for that service. An empty `scope` is the system ' +
    'listing nothing beside it, and (unconfirmed) that establishes neither ' +
    'that the service audits everything nor that it audits nothing. `scope` is ' +
    'null where the system listed something this tool could not read as names, ' +
    'which is not an empty scope. `services` ITSELF IS NULL WHERE THE SYSTEM ' +
    'REPORTED NO SERVICE CONFIGURATION THIS TOOL COULD READ, and an empty list ' +
    'means the system reported the configuration and named no services in it — ' +
    'those are different answers and null is never to be read as the empty ' +
    'one. ' +
    '`remote_logging_enabled` is whether audit records are also sent to a ' +
    'remote destination, and it is THREE-VALUED: true, false, or null where ' +
    'the system reported no value this tool could read. Null is NOT false — ' +
    'nothing has been established about off-box logging. Where the remote ' +
    'destination is, and whether it is reachable, are not reported here. ' +
    '`retention_days` is how many days audit entries are kept before the ' +
    'system removes them, and is null where the system reported no number this ' +
    'tool could read. `space_available_bytes` is how much room the audit ' +
    'dataset has left, in bytes, and is null on the same terms. It does not ' +
    'say how long that room lasts: that depends on how busy the system is, ' +
    'which this tool does not read. This tool reads configuration. It does not ' +
    'change what is audited, how long entries are kept, or anything else — ' +
    'that is `audit.update`, and it is not in this catalog. A configuration ' +
    'that could not be read at all is an error naming what the system said, ' +
    'not a result of nulls.',
  inputSchema: { type: 'object', properties: {} },
  requiredRole: Role.ReadOnly,
  mutating: false,
  async handler({ system }) {
    const config = await firstValueFrom(system.client.api.call('audit.config'));
    // The payload is read through this guard rather than reached into, because
    // a system answering the call with something that is not a configuration
    // would otherwise throw on the first property access — and the error a
    // caller then sees names a property rather than the read that failed.
    const settings = recordOrNull(config);
    if (settings === null) {
      throw new Error('audit.config did not answer with an audit configuration');
    }
    // Named one at a time, so a field a later TrueNAS release adds to the audit
    // configuration does not appear in this result without a change here.
    const space = recordOrNull(settings['space']);
    return {
      services: configuredServices(settings['enabled_services']),
      // Not defaulted to false: a system that reported no value has not been
      // shown to be keeping its audit records on the box.
      remote_logging_enabled:
        typeof settings['remote_logging_enabled'] === 'boolean'
          ? settings['remote_logging_enabled']
          : null,
      retention_days: numberOrNull(settings['retention']),
      space_available_bytes: space === null ? null : numberOrNull(space['available']),
    };
  },
};
