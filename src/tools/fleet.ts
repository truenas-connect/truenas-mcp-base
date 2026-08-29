import { firstValueFrom } from 'rxjs';
import { Role } from '@/interfaces';
import { ReadOnlyTool, SystemHandle } from '@/catalog/tool';
// `fleet_compliance_report` is composite: it calls these five handlers rather
// than the API, so that what it reports is by construction what those tools
// report. None of the four files imports this one, so there is no cycle.
import { directoryServicesStatus } from '@/tools/accounts';
import { certificatesList } from '@/tools/certificates';
import { sharesList } from '@/tools/shares';
import { auditLogQuery, updateStatus } from '@/tools/system';

/**
 * Fleet family: read-only inspection of how a system stands as one part of
 * something larger — the other node of its HA pair, and the fleet around it.
 */

/**
 * A string the system reported, or null where it reported anything else.
 *
 * An empty string is read as no value rather than as text of no characters: a
 * status of no characters names nothing a caller could act on, and passing it
 * through would put a field in the result that says nothing.
 *
 * `system.ts`, `accounts.ts`, `shares.ts` and `block.ts` each hold the same
 * reading under their own names, and this restates rather than shares it for the
 * reason `shares.ts` gives for restating its own guards: a tool file is read on
 * its own.
 */
function textOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** What a failure carrying no text of its own is reported as. */
const NO_REASON = 'the system reported no reason';

/**
 * Why a read failed, in words.
 *
 * A rejection is not necessarily an `Error` — the client rejects with whatever
 * the transport gave it — so a bare string is read too, and so are the two
 * shapes the client documents as its own: a JSON-RPC error object carrying
 * `message`, and a middleware error object carrying `reason`. Anything else
 * still becomes a stated absence rather than `"[object Object]"`, and the
 * result is never empty: a failure with no text still has to read as a failure.
 * The same reading `system.ts` holds of a failed version read.
 */
function errorText(reason: unknown): string {
  if (reason instanceof Error) return textOrNull(reason.message) ?? NO_REASON;
  if (typeof reason === 'object' && reason !== null) {
    const carrier = reason as Record<string, unknown>;
    return textOrNull(carrier['reason']) ?? textOrNull(carrier['message']) ?? NO_REASON;
  }
  return textOrNull(reason) ?? NO_REASON;
}

/**
 * The status a system reports when it is not one node of an HA pair.
 *
 * (unconfirmed against a live middleware) The client types `failover.status` as
 * a bare string and lists no values, so this is read from what TrueNAS reports:
 * `SINGLE` on a system with no peer — an unlicensed one, a community one, or
 * one half of a pair that was never completed — and `MASTER`, `BACKUP`,
 * `ELECTING` or `IMPORTING` on a system that is part of one. Getting this wrong
 * in the direction that matters is guarded structurally rather than by the
 * spelling: only the exact word `SINGLE` short-circuits, so a status this
 * constant does not match is treated as an HA pair and the reasons are read,
 * which is the answer that can be checked rather than the one that quietly says
 * "not applicable".
 */
const SINGLE = 'SINGLE';

/** Which node answered, or the failure that stopped it being read. */
interface NodeAttempt {
  value: string | null;
  error: string | null;
}

/**
 * Which node of the pair this call was answered by, with a failure named rather
 * than thrown.
 *
 * Reported rather than fatal for the reason `accounts.ts` gives for its
 * configuration read: the question the tool is asked — can this pair survive
 * losing a node right now — is answered by the status and the disabled reasons
 * on their own, and losing the node's identity must not lose that answer too.
 */
async function readNode(system: SystemHandle): Promise<NodeAttempt> {
  try {
    const node = await firstValueFrom(system.client.api.call('failover.node'));
    return { value: textOrNull(node), error: null };
  } catch (reason) {
    return { value: null, error: errorText(reason) };
  }
}

/** What the system says stands in the way of a failover. */
interface ReasonsAttempt {
  /** The reasons this tool could read, or null where the read itself failed. */
  value: string[] | null;
  /**
   * How many reasons the system named, readable or not — null where the read
   * failed. This rather than `value.length` is what says whether failover is
   * possible: a reason the system named and this tool could not read is still a
   * reason failover would not work, and counting only the readable ones would
   * turn an answer of "something is wrong here" into "everything is fine".
   */
  count: number | null;
  error: string | null;
}

/** What a system answering with something other than a list is reported as. */
const NOT_A_LIST = 'the system did not answer with a list of reasons';

/**
 * Everything the system says would stop a failover working, with a failure
 * named rather than thrown — the same reading as {@link readNode}, and the read
 * this tool exists for: `failover.status` says which node is active, and only
 * this says whether the other one could take over.
 */
async function readDisabledReasons(system: SystemHandle): Promise<ReasonsAttempt> {
  let answer: unknown;
  try {
    answer = await firstValueFrom(system.client.api.call('failover.disabled.reasons'));
  } catch (reason) {
    return { value: null, count: null, error: errorText(reason) };
  }
  // Fatal to the reasons rather than to the tool, and null rather than empty: a
  // system that answered something other than a list has not said that nothing
  // is in the way, and an empty list is exactly the claim that must not be made
  // on its behalf.
  if (!Array.isArray(answer)) return { value: null, count: null, error: NOT_A_LIST };
  const readable: string[] = [];
  for (const entry of answer) {
    const reason = textOrNull(entry);
    if (reason !== null) readable.push(reason);
  }
  const unreadable = answer.length - readable.length;
  return {
    value: readable,
    count: answer.length,
    // A shortfall is stated with its numbers rather than passed over, because
    // the list that comes back is then not every reason the system gave and the
    // acceptance criterion this tool is written against says it should be.
    error:
      unreadable === 0
        ? null
        : `the system named ${answer.length} reasons and ${unreadable} could not be read`,
  };
}

/**
 * Whether this pair could survive losing a node right now.
 *
 * The question is asked least and matters most, because checking it by hand is
 * tedious: a standby that has quietly stopped being able to take over is
 * invisible until the failover that needed it. So the two answers this tool
 * keeps apart are "failover works" and "nothing here has been established" —
 * never collapsing the second into the first.
 *
 * The other distinction it keeps is a single-node system from a broken one.
 * Most systems are not HA pairs at all, and a tool that reported every one of
 * them as unable to fail over would be reporting the ordinary case as a fault.
 * A system that says `SINGLE` is answered with `ha_configured: false` and
 * nothing else read, rather than with a list of reasons it cannot do something
 * it was never meant to do.
 */
export const haStatus: ReadOnlyTool = {
  name: 'ha_status',
  description:
    'Whether this TrueNAS system is one node of a high-availability pair, which ' +
    'node it is, and whether a failover would work right now. `ha_configured` ' +
    'is the marker to read first: FALSE MEANS THIS IS A SINGLE-NODE SYSTEM, ' +
    'which is the ordinary case and IS NOT A FAULT OR A DEGRADED PAIR — it has ' +
    'no second node to fail over to and was never meant to have one. It is ' +
    'true where the system reports any state other than `SINGLE`, and null ' +
    'where the system reported no state at all, which settles nothing either ' +
    'way. `status` is ' +
    "the system's own HA state verbatim — `SINGLE` on a system that is not " +
    'part of a pair, and `MASTER` (this node is the active one), `BACKUP` ' +
    '(this node is the standby), `ELECTING` or `IMPORTING` (a failover is in ' +
    'progress) on one that is; a state a later TrueNAS release adds is passed ' +
    'through as the system spelled it. `node` is which node of the pair ' +
    'answered this call, such as `A` or `B`. `failover_possible` is whether ' +
    'the pair could fail over right now: true when the system named nothing ' +
    'standing in the way, false when it named something, and NULL WHEN NOTHING ' +
    'WAS ESTABLISHED — either this is a single-node system, where the question ' +
    'does not apply, or the check could not be read. NULL IS NEVER "FAILOVER ' +
    'WORKS". `failover_disabled_reasons` lists every reason the system gives, ' +
    'in its own words — `NO_VOLUME`, `NO_VIP`, `NO_SYSTEM_READY`, `NO_PONG`, ' +
    '`NO_FAILOVER`, `NO_LICENSE`, `DISAGREE_VIP`, `MISMATCH_DISKS` and the ' +
    'like, passed through as the system spelled them. It is an empty list when ' +
    'the system named none, and null WHERE IT WAS NOT READ AT ALL — which is ' +
    'the case on a single-node system, where it is not asked for, and where the ' +
    'read failed. `node_error` and `reasons_error` name what the system said ' +
    'when a read failed, and `node` and `failover_disabled_reasons` are null ' +
    'while the matching error is non-null BECAUSE THEY COULD NOT BE READ, not ' +
    'because the system has no node or nothing in the way; `node` null with ' +
    '`node_error` null is a pair that answered the read with no node. ' +
    '`reasons_error` is ' +
    'also set, with the list still returned, where the system named a reason ' +
    'this tool could not read: the list is then shorter than what the system ' +
    'gave, and `failover_possible` is still false, because a reason that could ' +
    'not be read is still a reason. ON A SINGLE-NODE SYSTEM `node`, ' +
    '`failover_possible`, `failover_disabled_reasons`, `node_error` and ' +
    '`reasons_error` ARE ALL NULL BECAUSE NONE OF THEM WAS READ — a system ' +
    'with no pair has no node identity, no failover and nothing standing in the ' +
    'way of one. This tool only reports. IT DOES NOT INITIATE A FAILOVER, ' +
    'switch which node is active, or change anything about the pair.',
  inputSchema: { type: 'object', properties: {} },
  requiredRole: Role.ReadOnly,
  mutating: false,
  async handler({ system }) {
    // The one read that may fail the tool. Every other field describes a pair
    // this system may not be part of, so without the state there is no answer
    // for them to qualify — an error naming what the system said is more use
    // than a result of nulls that reads as a system with nothing to report.
    const status = textOrNull(await firstValueFrom(system.client.api.call('failover.status')));

    // A system with no pair has no node and no failover, so those reads are not
    // made at all rather than made and discarded. That is what keeps the
    // ordinary case out of the degraded one structurally: there is no list of
    // reasons to be misread as faults, because none was asked for. A system
    // that reported no state at all takes the same exit for the same reason —
    // nothing has placed it in a pair, and reading a pair's fields off it would
    // report about a pair that has not been shown to exist.
    if (status === null || status === SINGLE) {
      return {
        status,
        ha_configured: status === null ? null : false,
        node: null,
        failover_possible: null,
        failover_disabled_reasons: null,
        node_error: null,
        reasons_error: null,
      };
    }

    // Both reads are issued before either is awaited, so neither waits on the
    // other.
    const [node, reasons] = await Promise.all([readNode(system), readDisabledReasons(system)]);
    return {
      status,
      ha_configured: true,
      node: node.value,
      // Read from the count rather than the list, for the reason
      // `ReasonsAttempt.count` gives.
      failover_possible: reasons.count === null ? null : reasons.count === 0,
      failover_disabled_reasons: reasons.value,
      node_error: node.error,
      reasons_error: reasons.error,
    };
  },
};

/**
 * The settings an auditor asks about, one system at a time.
 *
 * The second composite in this catalog, and it follows `system_health_report`'s
 * shape — five sections, each backed by exactly one existing tool, each carrying
 * `unavailable` rather than being able to fail the report. What it deliberately
 * does NOT follow is that tool's `verdict`. A verdict is a judgement against a
 * standard, the standard being audited against is not this harness's to assert,
 * and a tool that answered `COMPLIANT` would be asserting one. So this reports
 * facts, names what it could not read, and stops there.
 *
 * The one place that is hard to hold to is auditing. The setting itself —
 * `audit.config`'s `enabled_services` — has no tool in this catalog, and a
 * composite adds no endpoint of its own, so what can be established from here is
 * narrower: the trail was read, and it either held entries or did not. That is
 * reported as what it is, under a field named for the evidence rather than for
 * the setting, because "the trail is empty" and "auditing is off" are the two
 * answers a compliance report must never merge.
 */

/**
 * How many certificates, shares and services the report names individually.
 *
 * The cap is on the DETAIL LISTS ONLY: every count and every entry in
 * `unreadable` is computed over everything the section read, so truncation can
 * drop the line describing a fact and can never drop the fact. Ten is chosen
 * against the systems this is asked about — a TrueNAS system holds a handful of
 * certificates and tens of shares, and ten of each is already more than a reader
 * checks in one sitting.
 */
const MAX_LISTED = 10;

/**
 * How close to expiry a certificate has to be for this report to call it out.
 *
 * Thirty days is the renewal horizon the ACME clients that issue most of these
 * certificates already use, so it is the window in which a certificate that has
 * NOT been renewed is a finding rather than a normal state. It is a fixed
 * constant rather than an argument: a fleet-wide report that answered a
 * different horizon per call could not be compared across systems, which is the
 * whole point of running it fleet-wide.
 */
const EXPIRY_HORIZON_DAYS = 30;

/** The five sections of the report, each backed by exactly one composed tool. */
type SectionName = 'auditing' | 'certificates' | 'directory_service' | 'shares' | 'updates';

/** A boolean the system reported, or null where it reported anything else. */
function booleanOrNull(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

/** A finite number the system reported, or null where it reported anything else. */
function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** `1 certificate` / `2 certificates`, so a detail reads as English at either count. */
function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/** A section that was read, or the reason it could not be. */
interface SectionRead<T> {
  value: T | null;
  unavailable: string | null;
}

/**
 * One composed tool's result, normalized, with a failure named rather than
 * thrown. This is the whole of why the report cannot fail because one subsystem
 * did — the same seam `system_health_report` uses, restated here for the reason
 * this file restates its own guards: a tool file is read on its own.
 *
 * The read is passed as a thunk so that the call is made inside the `try`, which
 * keeps this correct for a handler that throws before it returns a promise at
 * all — which one of these five does: `shares_list` raises when NEITHER protocol
 * could be listed, and that has to land here as an unreadable section rather
 * than as a report that never came back.
 *
 * `shape` runs inside the same `try`, deliberately. The composed handlers are
 * typed `Promise<unknown>`, so each reader below takes the container it is given
 * on the evidence of the tool it reads and reads every FIELD within it through a
 * guard. A handler that one day answers some other container makes its reader
 * throw, and it lands in this same catch and is stated as the same kind of gap.
 */
async function section<T>(
  read: () => Promise<unknown>,
  shape: (answer: unknown) => T,
): Promise<SectionRead<T>> {
  try {
    return { value: shape(await read()), unavailable: null };
  } catch (reason) {
    return { value: null, unavailable: errorText(reason) };
  }
}

/** What the audit trail itself says, as far as reading it can establish. */
interface AuditRead {
  entries_seen: number;
  by_service: { service: string | null; count: number }[];
  window_start: string | null;
  truncated: boolean | null;
}

/**
 * What `audit_log_query` reported, read back through this report's own guards.
 *
 * The entries themselves are not carried: they name people and what they did,
 * which is that tool's answer to a question this one is not asking. What is kept
 * is how many there were and which trail each came from, because that is what
 * says the trail is being written and to which services.
 */
function auditRead(answer: unknown): AuditRead {
  const row = answer as Record<string, unknown>;
  // Mapped rather than walked, so that an `entries` that is not a list throws
  // into {@link section}'s catch instead of counting as a trail with nothing in
  // it — which is the one reading of this section that must never be reached by
  // accident.
  const services = (row['entries'] as Record<string, unknown>[]).map((entry) =>
    textOrNull(entry['service']),
  );
  const counts = new Map<string | null, number>();
  for (const service of services) counts.set(service, (counts.get(service) ?? 0) + 1);
  return {
    entries_seen: services.length,
    by_service: [...counts.entries()]
      .map(([service, count]) => ({ service, count }))
      // Busiest trail first, and by name where two are level, so that two reads
      // of the same system order the same way.
      .sort((a, b) => b.count - a.count || (a.service ?? '').localeCompare(b.service ?? '')),
    window_start: textOrNull(row['since']),
    truncated: booleanOrNull(row['truncated']),
  };
}

/**
 * Whether this system is recording an audit trail, as far as READING the trail
 * can establish it.
 *
 * True only where the trail was read and held at least one entry: an entry in
 * the trail is proof the trail is being written, which is the narrow claim this
 * report can actually support. Everything else is null, and null is emphatically
 * not "auditing is off" — a system nobody touched inside the window records
 * nothing and looks identical to one that is not auditing at all. The setting
 * that would tell them apart is `audit.config`, which no tool in this catalog
 * reports and which a composite may not reach for itself.
 */
function recordingFrom(read: AuditRead | null): boolean | null {
  if (read === null || read.entries_seen === 0) return null;
  return true;
}

/** One certificate, as this report states it. */
interface CertificateEntry {
  name: string | null;
  common_name: string | null;
  not_after: string | null;
  days_until_expiry: number | null;
  expired: boolean | null;
}

/** What the walk over every certificate accumulates. */
interface CertificateRead {
  reported: number;
  expired: number;
  expiring_soon: number;
  expiry_unknown: number;
  /** Every certificate that is not comfortably valid, in the order reported. */
  notable: CertificateEntry[];
}

/**
 * Where a certificate stands, from the day count `certificates_list` computed.
 *
 * `unknown` is its own answer rather than folded into either side. A certificate
 * whose expiry could not be read is the one an auditor most wants to look at by
 * hand, and counting it as valid would be the fail-open this whole report exists
 * to avoid.
 */
function certificateState(days: number | null): 'expired' | 'expiring_soon' | 'unknown' | 'valid' {
  if (days === null) return 'unknown';
  if (days < 0) return 'expired';
  return days <= EXPIRY_HORIZON_DAYS ? 'expiring_soon' : 'valid';
}

/** What `certificates_list` reported, read back through this report's guards. */
function certificateRead(answer: unknown): CertificateRead {
  const rows = (answer as Record<string, unknown>[]).map((row) => ({
    name: textOrNull(row['name']),
    common_name: textOrNull(row['common_name']),
    not_after: textOrNull(row['not_after']),
    days_until_expiry: numberOrNull(row['days_until_expiry']),
    // The system's OWN verdict, carried beside the day count rather than
    // reconciled with it: `certificates_list` states that the two can disagree,
    // and an auditor reading a disagreement is better served than one reading
    // whichever of them this file picked.
    expired: booleanOrNull(row['expired']),
  }));
  const read: CertificateRead = {
    reported: rows.length,
    expired: 0,
    expiring_soon: 0,
    expiry_unknown: 0,
    notable: [],
  };
  for (const row of rows) {
    const state = certificateState(row.days_until_expiry);
    if (state === 'valid') continue;
    if (state === 'expired') read.expired += 1;
    else if (state === 'expiring_soon') read.expiring_soon += 1;
    else read.expiry_unknown += 1;
    read.notable.push(row);
  }
  return read;
}

/** What this system is joined to, as this report states it. */
interface DirectoryRead {
  service_type: string | null;
  status: string | null;
  status_message: string | null;
  enabled: boolean | null;
  domain: string | null;
  server_urls: string[] | null;
  kerberos_realm: string | null;
  credential_type: string | null;
  config_error: string | null;
}

/**
 * The LDAP servers the system binds to, or null where it named no list this
 * report could read.
 *
 * Reported WHOLE OR NOT AT ALL, for the reason `shares.ts` gives about its own
 * restriction lists: a list with an unreadable entry dropped out of it names a
 * different set of servers from the one the system holds, and an auditor asking
 * where identities come from would be told a narrower answer than the truth.
 * Null on Active Directory and IPA, which are identified by their domain and
 * carry no such list at all.
 */
function serverUrls(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const urls = value.filter((url): url is string => typeof url === 'string' && url.length > 0);
  return urls.length === value.length ? urls : null;
}

/**
 * What `directory_services_status` reported, read back through this report's
 * guards.
 *
 * No credential is carried and none could be: that tool takes only the
 * `credential_type` discriminant out of the payload the secret lives in, so what
 * arrives here names HOW the system binds and never with what.
 */
function directoryRead(answer: unknown): DirectoryRead {
  const row = answer as Record<string, unknown>;
  return {
    service_type: textOrNull(row['service_type']),
    status: textOrNull(row['status']),
    status_message: textOrNull(row['status_message']),
    enabled: booleanOrNull(row['enabled']),
    domain: textOrNull(row['domain']),
    server_urls: serverUrls(row['server_urls']),
    kerberos_realm: textOrNull(row['kerberos_realm']),
    credential_type: textOrNull(row['credential_type']),
    config_error: textOrNull(row['config_error']),
  };
}

/** One share, as this report states it. */
interface ShareEntry {
  protocol: string | null;
  id: number | null;
  name: string | null;
  path: string | null;
  enabled: boolean | null;
}

/** One protocol whose shares could not be listed at all. */
interface ShareFailure {
  protocol: string | null;
  error: string;
}

/** What the walk over every share accumulates. */
interface ShareRead {
  reported: number;
  enabled: number;
  disabled: number;
  enablement_unknown: number;
  by_protocol: { protocol: string | null; count: number }[];
  /** Every share, exposed ones first — see {@link exposureRank}. */
  ordered: ShareEntry[];
  failures: ShareFailure[];
}

/**
 * Where a share sorts. Switched ON first, then a switch that could not be read,
 * then switched off.
 *
 * The ordering is what makes the cap below honest: what survives it is what the
 * system is actually exposing, and a share whose state is not established sorts
 * ahead of one known to be off for the same reason it is counted separately.
 */
function exposureRank(enabled: boolean | null): number {
  if (enabled === true) return 0;
  return enabled === null ? 1 : 2;
}

/** What `shares_list` reported, read back through this report's guards. */
function shareRead(answer: unknown): ShareRead {
  const row = answer as Record<string, unknown>;
  const entries = (row['shares'] as Record<string, unknown>[]).map((share) => ({
    protocol: textOrNull(share['protocol']),
    id: numberOrNull(share['id']),
    name: textOrNull(share['name']),
    path: textOrNull(share['path']),
    enabled: booleanOrNull(share['enabled']),
  }));
  const read: ShareRead = {
    reported: entries.length,
    enabled: 0,
    disabled: 0,
    enablement_unknown: 0,
    by_protocol: [],
    // `sort` is stable, so shares at the same rank keep the order the system
    // listed them in.
    ordered: [...entries].sort((a, b) => exposureRank(a.enabled) - exposureRank(b.enabled)),
    // The reason goes through `errorText` rather than a guard of its own: it is
    // the same kind of value — why a read failed, in words — and it is never
    // empty, so a protocol that failed silently still reads as one that failed.
    failures: (row['failures'] as Record<string, unknown>[]).map((failure) => ({
      protocol: textOrNull(failure['protocol']),
      error: errorText(failure['error']),
    })),
  };
  const counts = new Map<string | null, number>();
  for (const entry of entries) {
    if (entry.enabled === true) read.enabled += 1;
    else if (entry.enabled === false) read.disabled += 1;
    else read.enablement_unknown += 1;
    counts.set(entry.protocol, (counts.get(entry.protocol) ?? 0) + 1);
  }
  read.by_protocol = [...counts.entries()]
    .map(([protocol, count]) => ({ protocol, count }))
    .sort((a, b) => (a.protocol ?? '').localeCompare(b.protocol ?? ''));
  return read;
}

/** Whether this system is behind, as this report states it. */
interface UpdateRead {
  update_available: boolean | null;
  current_version: string | null;
  new_version: string | null;
  train: string | null;
  check_error: string | null;
  version_error: string | null;
}

/** What `system_update_status` reported, read back through this report's guards. */
function updateRead(answer: unknown): UpdateRead {
  const row = answer as Record<string, unknown>;
  return {
    update_available: booleanOrNull(row['update_available']),
    current_version: textOrNull(row['current_version']),
    new_version: textOrNull(row['new_version']),
    train: textOrNull(row['train']),
    check_error: textOrNull(row['check_error']),
    version_error: textOrNull(row['version_error']),
  };
}

/**
 * One thing this report could not establish, and which system it was not
 * established on.
 *
 * `system` is on every entry rather than on the report alone, because these are
 * the lines that get collected across a fleet and read as one list — and a line
 * saying a certificate's expiry could not be read is worth nothing without the
 * system it could not be read on.
 */
interface Unreadable {
  system: string;
  section: SectionName;
  detail: string;
}

/** What a section that could not be read at all contributes. */
function sectionUnreadable(name: SectionName, unavailable: string, system: string): Unreadable {
  return {
    system,
    section: name,
    detail: `the ${name} section could not be read, so nothing in it is established: ${unavailable}`,
  };
}

/**
 * What the auditing section could not establish, which is everything it is asked
 * for whenever the trail came back empty — see {@link recordingFrom}.
 */
function auditUnreadable(read: AuditRead, system: string): Unreadable[] {
  if (read.entries_seen > 0) return [];
  return [
    {
      system,
      section: 'auditing',
      detail:
        'the audit trail was read and held no entry inside the window, so whether this system ' +
        'records one is not established: a system nobody touched looks the same here as one ' +
        'that is not auditing at all',
    },
  ];
}

/** What the certificates section could not establish. */
function certificateUnreadable(read: CertificateRead, system: string): Unreadable[] {
  if (read.expiry_unknown === 0) return [];
  return [
    {
      system,
      section: 'certificates',
      detail: `${plural(
        read.expiry_unknown,
        'certificate',
      )} reported no expiry date this report could read, so whether they are still valid is not established`,
    },
  ];
}

/** What the directory-service section could not establish. */
function directoryUnreadable(read: DirectoryRead, system: string): Unreadable[] {
  if (read.config_error === null) return [];
  return [
    {
      system,
      section: 'directory_service',
      detail: `the directory service configuration could not be read, so what this system is joined to is not established: ${read.config_error}`,
    },
  ];
}

/** How a protocol whose own name could not be read is referred to. */
const UNNAMED_PROTOCOL = 'a protocol the system did not name';

/** What the shares section could not establish — one entry per unlisted protocol. */
function shareUnreadable(read: ShareRead, system: string): Unreadable[] {
  return read.failures.map((failure) => ({
    system,
    section: 'shares' as const,
    detail: `no ${
      failure.protocol ?? UNNAMED_PROTOCOL
    } share could be listed, so what this system exposes over it is not established: ${failure.error}`,
  }));
}

/**
 * What the updates section could not establish. TWO independent channels, and
 * each is its own entry: a system can answer the update check and still fail to
 * say what it is running now.
 */
function updateUnreadable(read: UpdateRead, system: string): Unreadable[] {
  const facts: Unreadable[] = [];
  if (read.update_available === null) {
    facts.push({
      system,
      section: 'updates',
      detail: `the update check did not complete, so whether this system is up to date is not established: ${errorText(
        read.check_error,
      )}`,
    });
  }
  if (read.version_error !== null) {
    facts.push({
      system,
      section: 'updates',
      detail: `the running version could not be read, so what this system is on is not established: ${read.version_error}`,
    });
  }
  return facts;
}

export const fleetComplianceReport: ReadOnlyTool = {
  name: 'fleet_compliance_report',
  description:
    'One call that answers "generate a compliance or audit report" for a ' +
    'TrueNAS system: the configuration facts an auditor asks for, stated per ' +
    'system. Run it across the fleet and each system answers separately. It ' +
    'composes five read-only tools and adds nothing of its own — ' +
    '`audit_log_query` for the audit trail, `certificates_list` for expiry, ' +
    '`directory_services_status` for where identities come from, `shares_list` ' +
    'for what is exposed to the network, and `system_update_status` for ' +
    'whether the system is patched. Each of those reports its subject in far ' +
    'more detail; this reports the part an auditor asks about, and a fact ' +
    'worth following up is the cue to call that tool for the rest. THIS TOOL ' +
    'STATES NO COMPLIANCE VERDICT AND NEVER WILL. It does not say whether a ' +
    'system passes, and there is no field here that scores one: the standard ' +
    'being audited against — the framework, the policy, the customer ' +
    'contract — is not this tool\'s to assert, so it reports the facts and the ' +
    'auditor decides. Any pass/fail reading of this report is the READER\'s ' +
    'judgement and not the system\'s. `system` is the system every fact below ' +
    'came from, repeated on each entry of `unreadable` so that lines collected ' +
    'from several systems stay attributable one by one. `unreadable` is every ' +
    'fact this report could NOT establish, each with the `section` it belongs ' +
    'to and a `detail` stating it in words. IT IS NOT A LIST OF FAULTS — it is ' +
    'the list of holes in the report, and A HOLE IS NEVER A PASS: an empty ' +
    '`unreadable` is the narrow claim that every fact below was actually read. ' +
    'Each of the five sections carries `unavailable`: null where it was read, ' +
    'and otherwise the reason it could not be, IN WHICH CASE EVERY OTHER FIELD ' +
    'OF THAT SECTION IS NULL — null there means "not read", never "nothing to ' +
    'report" and never "nothing wrong". THIS TOOL NEVER FAILS BECAUSE ONE ' +
    'SUBSYSTEM DID. ' +
    '`auditing` REPORTS THE TRAIL AND NOT THE SETTING, and the difference ' +
    'matters here more than anywhere else in this report. `recording` is true ' +
    'ONLY where the audit trail was read and held at least one entry, which is ' +
    'proof the system is writing one. IT IS NULL EVERYWHERE ELSE AND NULL IS ' +
    'NEVER "AUDITING IS OFF": a system nobody touched inside the window records ' +
    'nothing and is indistinguishable from a system that is not auditing at ' +
    'all. WHETHER AUDITING IS CONFIGURED ON CANNOT BE ANSWERED BY THIS TOOL — ' +
    'that setting is `audit.config` on the middleware, no tool in this catalog ' +
    'reports it, and a null `recording` is a question to put to the system ' +
    'directly rather than an answer. `entries_seen` is how many entries came ' +
    'back inside the window and `by_service` counts them per trail, busiest ' +
    'first, so a trail that IS recording can be named — `MIDDLEWARE`, `SMB`, ' +
    '`SUDO`, `SYSTEM`, or a name a later TrueNAS release adds. A SERVICE ' +
    'MISSING FROM `by_service` IS NOT A SERVICE THAT IS NOT AUDITED; it is one ' +
    'that recorded nothing in the window. `window_start` is the instant the ' +
    'trail was read from — the last 24 hours — so an empty result is readable ' +
    'against the window it was taken from, and `truncated` says the system ' +
    'holds more entries than were counted, which lowers `entries_seen` and ' +
    'never raises it. NO AUDIT ENTRY ITSELF IS RETURNED: those name people and ' +
    'what they did, which is `audit_log_query`\'s answer and not this one. ' +
    '`certificates` reports expiry. `reported` is how many certificates the ' +
    'system holds; `expired` how many have already lapsed, `expiring_soon` how ' +
    `many have ${EXPIRY_HORIZON_DAYS} days or fewer left, and ` +
    '`expiry_unknown` how many reported no expiry date this report could read ' +
    '— WHICH IS NOT "DOES NOT EXPIRE", every certificate expires, and those are ' +
    'the ones to look at by hand. The three counts and `reported` are over ' +
    'EVERY certificate. `entries` lists the certificates in those three ' +
    'categories individually and lists no comfortably-valid one, each with its ' +
    '`name`, `common_name`, `not_after` exactly as the system formatted it, ' +
    '`days_until_expiry` — negative where it has already expired, by that many ' +
    'days — and `expired`, WHICH IS THE SYSTEM\'S OWN VERDICT and can disagree ' +
    'with the day count beside it, in which case both are worth reading and ' +
    'neither is corrected here. NO CERTIFICATE OR PRIVATE KEY MATERIAL IS ' +
    'RETURNED. `directory_service` reports where this system gets its ' +
    'identities. `service_type` is which of Active Directory, IPA or LDAP is ' +
    'configured and NULL MEANS NONE IS, which is the ordinary case and is not a ' +
    'fault; `status` is the live state of the join — `HEALTHY`, `FAULTED`, ' +
    '`JOINING`, `LEAVING` or `DISABLED` — and `status_message` what the system ' +
    'said about it. `enabled` is the SETTING rather than the state, and a ' +
    'service can be enabled and `FAULTED` at once. `domain`, `server_urls` and ' +
    '`kerberos_realm` name the directory: `domain` is null for LDAP, which is ' +
    'identified by `server_urls` instead, and `server_urls` is null for Active ' +
    'Directory and IPA. `credential_type` names HOW the system binds and NEVER ' +
    'WITH WHAT — NO PASSWORD, BIND PASSWORD, KEYTAB OR CERTIFICATE PASSES ' +
    'THROUGH THIS TOOL. `config_error` names what the system said when the ' +
    'configuration read failed, and while it is non-null `enabled`, `domain`, ' +
    '`server_urls`, `kerberos_realm` and `credential_type` are all null BECAUSE ' +
    'THEY COULD NOT BE READ rather than because they are unset — that is a ' +
    'separate read from the status beside it. `shares` reports WHAT IS EXPOSED ' +
    'AND OVER WHICH PROTOCOL, NOT WHO MAY REACH IT. `reported` is how many SMB ' +
    'and NFS shares the system holds, `enabled` how many are switched on, ' +
    '`disabled` how many are off, and `enablement_unknown` how many reported no ' +
    'switch this report could read — counted apart from `disabled` because a ' +
    'share not shown to be off must not be counted as one. `by_protocol` ' +
    'counts them per protocol. `entries` lists them individually, SWITCHED-ON ' +
    'SHARES FIRST so that what survives truncation is what is actually exposed, ' +
    'each with its `protocol`, its `id` — which is unique only WITHIN a ' +
    'protocol — its `name`, ALWAYS null on an NFS export, its `path`, and ' +
    '`enabled`. THE HOST RESTRICTIONS, THE SHARE ACL AND THE FILESYSTEM ACL ARE ' +
    'NOT REPORTED HERE: who may reach one share is `share_access`, called per ' +
    'share, and nothing in this section is evidence that a share is reachable ' +
    'by anyone in particular or by everyone. iSCSI and NVMe-oF export block ' +
    'devices rather than filesystem paths and are not counted as shares — see ' +
    '`iscsi_list` and `nvmeof_list`. `updates` reports whether the system is ' +
    'patched. `update_available` is true, false, or NULL WHERE THE CHECK DID ' +
    'NOT COMPLETE, which is not "no update available" — that system may have ' +
    'gone unchecked for months. `current_version` is what it runs now and comes ' +
    'from a SEPARATE read, so it survives a failed check; `new_version` and ' +
    '`train` are null while `update_available` is null, because they come from ' +
    'the status the check did not produce. `check_error` and `version_error` ' +
    'name those two failures independently. EVERY COUNT IS COMPUTED OVER ' +
    'EVERYTHING THE SECTION READ, and only the two lists — ' +
    '`certificates.entries` and `shares.entries` — are capped, at ' +
    `${MAX_LISTED} entries each with a ` +
    '`truncated` flag saying whether anything was left out. So ' +
    'truncation can drop the line describing a certificate or a share and can ' +
    'never drop it from the counts. This tool only reads. It does not change a ' +
    'setting, renew a certificate, join or leave a directory, alter a share, ' +
    'change what is audited, or install an update. NO field beyond those named ' +
    'here is returned, whatever a later TrueNAS release adds to any of the five ' +
    'underlying responses.',
  inputSchema: { type: 'object', properties: {} },
  requiredRole: Role.ReadOnly,
  mutating: false,
  async handler(ctx) {
    const name = ctx.system.name;
    // All five reads are issued before any is awaited, so none waits on the
    // others, and each is caught: no section may fail the report.
    const [auditing, certificates, directory, shares, updates] = await Promise.all([
      section(() => auditLogQuery.handler(ctx, {}), auditRead),
      section(() => certificatesList.handler(ctx, {}), certificateRead),
      section(() => directoryServicesStatus.handler(ctx, {}), directoryRead),
      section(() => sharesList.handler(ctx, {}), shareRead),
      section(() => updateStatus.handler(ctx, {}), updateRead),
    ]);

    const unreadable: Unreadable[] = [
      ...(auditing.unavailable === null
        ? []
        : [sectionUnreadable('auditing', auditing.unavailable, name)]),
      ...(auditing.value === null ? [] : auditUnreadable(auditing.value, name)),
      ...(certificates.unavailable === null
        ? []
        : [sectionUnreadable('certificates', certificates.unavailable, name)]),
      ...(certificates.value === null ? [] : certificateUnreadable(certificates.value, name)),
      ...(directory.unavailable === null
        ? []
        : [sectionUnreadable('directory_service', directory.unavailable, name)]),
      ...(directory.value === null ? [] : directoryUnreadable(directory.value, name)),
      ...(shares.unavailable === null
        ? []
        : [sectionUnreadable('shares', shares.unavailable, name)]),
      ...(shares.value === null ? [] : shareUnreadable(shares.value, name)),
      ...(updates.unavailable === null
        ? []
        : [sectionUnreadable('updates', updates.unavailable, name)]),
      ...(updates.value === null ? [] : updateUnreadable(updates.value, name)),
    ];

    return {
      system: name,
      unreadable,
      auditing: {
        unavailable: auditing.unavailable,
        recording: recordingFrom(auditing.value),
        entries_seen: auditing.value?.entries_seen ?? null,
        by_service: auditing.value?.by_service ?? null,
        window_start: auditing.value?.window_start ?? null,
        truncated: auditing.value?.truncated ?? null,
      },
      certificates: {
        unavailable: certificates.unavailable,
        reported: certificates.value?.reported ?? null,
        expired: certificates.value?.expired ?? null,
        expiring_soon: certificates.value?.expiring_soon ?? null,
        expiry_unknown: certificates.value?.expiry_unknown ?? null,
        expiring_within_days: certificates.value === null ? null : EXPIRY_HORIZON_DAYS,
        entries: certificates.value === null ? null : certificates.value.notable.slice(0, MAX_LISTED),
        truncated: certificates.value === null ? null : certificates.value.notable.length > MAX_LISTED,
      },
      directory_service: {
        unavailable: directory.unavailable,
        service_type: directory.value?.service_type ?? null,
        status: directory.value?.status ?? null,
        status_message: directory.value?.status_message ?? null,
        enabled: directory.value?.enabled ?? null,
        domain: directory.value?.domain ?? null,
        server_urls: directory.value?.server_urls ?? null,
        kerberos_realm: directory.value?.kerberos_realm ?? null,
        credential_type: directory.value?.credential_type ?? null,
        config_error: directory.value?.config_error ?? null,
      },
      shares: {
        unavailable: shares.unavailable,
        reported: shares.value?.reported ?? null,
        enabled: shares.value?.enabled ?? null,
        disabled: shares.value?.disabled ?? null,
        enablement_unknown: shares.value?.enablement_unknown ?? null,
        by_protocol: shares.value?.by_protocol ?? null,
        entries: shares.value === null ? null : shares.value.ordered.slice(0, MAX_LISTED),
        truncated: shares.value === null ? null : shares.value.ordered.length > MAX_LISTED,
      },
      updates: {
        unavailable: updates.unavailable,
        update_available: updates.value?.update_available ?? null,
        current_version: updates.value?.current_version ?? null,
        new_version: updates.value?.new_version ?? null,
        train: updates.value?.train ?? null,
        check_error: updates.value?.check_error ?? null,
        version_error: updates.value?.version_error ?? null,
      },
    };
  },
};
