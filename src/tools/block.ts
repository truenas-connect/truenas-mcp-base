import { firstValueFrom } from 'rxjs';
import { Role } from '@/interfaces';
import { ReadOnlyTool, SystemHandle } from '@/catalog/tool';

/**
 * Block-storage family: what the system serves as block devices rather than as
 * filesystem paths, over each of the two protocols that do it.
 *
 * `shares_list` deliberately excludes both, and says so: a target or a
 * subsystem exports a block device rather than a filesystem path, and its
 * vocabulary answers a different question. That question is asked here, once
 * per protocol — `iscsi_list` for iSCSI, `nvmeof_list` for NVMe-oF. They are
 * two tools rather than one because they share no vocabulary: targets, extents
 * and initiators on one side, subsystems, namespaces and hosts on the other,
 * with no field meaning the same thing in both.
 *
 * iSCSI takes four middleware namespaces to answer, and none of them nests
 * inside another. `iscsi.target.query` names the targets; `iscsi.extent.query`
 * names the backing stores; `iscsi.targetextent.query` is the join table that
 * maps an extent onto a target at a LUN; and `iscsi.global.sessions` is live
 * state from the running service rather than configuration at all — it is the
 * only one that says whether anything is actually connected. The last is the
 * reason the tool exists: a target with no session is the shape of a hypervisor
 * that quietly dropped its storage, and nothing in the first three can tell that
 * from a target nobody has ever used.
 *
 * NVMe-oF takes three, and unlike the iSCSI four they do nest: a namespace
 * carries the subsystem it belongs to, and the host/subsystem join carries both
 * sides whole. None of them is live state — the middleware exposes no
 * equivalent of `iscsi.global.sessions` for NVMe-oF in this client, so
 * `nvmeof_list` answers what is configured and cannot say what is attached.
 */

/** Which of the two secondary iSCSI reads failed. */
type IscsiSource = 'extents' | 'initiators';

/** Which of the two secondary NVMe-oF reads failed. */
type NvmeofSource = 'namespaces' | 'hosts';

/**
 * One read that failed, and why, for the caller to act on.
 *
 * Parameterised by the sources of the tool it belongs to rather than holding
 * every source in the file: the two tools read different things, and a failure
 * naming `extents` has no meaning in an NVMe-oF listing.
 */
interface Failure<S extends string> {
  source: S;
  error: string;
}

/**
 * One string field of a row, or null where the system reported no value.
 *
 * An empty string is read as no value rather than as text of no characters: a
 * target with no alias is what the middleware sends `""` for, and passing that
 * through would put a field in the result that says nothing.
 *
 * `shares.ts` and `tasks.ts` each hold the same reading under their own names,
 * and this restates rather than shares it for the reason `shares.ts` gives for
 * restating its own guards: a tool file is read on its own.
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
 * `message`, and a middleware error object carrying `reason`. Those are what a
 * failed call actually rejects with, and reading neither made every real
 * failure report as having said nothing. Anything else still becomes a stated
 * absence rather than `"[object Object]"`, and the result is never empty: a
 * failure with no text still has to read as a failure.
 */
function errorText(reason: unknown): string {
  if (reason instanceof Error) return textOrNull(reason.message) ?? NO_REASON;
  if (typeof reason === 'object' && reason !== null) {
    const carrier = reason as Record<string, unknown>;
    return textOrNull(carrier['reason']) ?? textOrNull(carrier['message']) ?? NO_REASON;
  }
  return textOrNull(reason) ?? NO_REASON;
}

/** A read that produced a value, or the failure that stopped it. */
interface Attempt<T, S extends string> {
  value: T | null;
  failure: Failure<S> | null;
}

/**
 * One read, with a failure caught and named rather than thrown.
 *
 * The read is passed as a thunk so that the call is made inside the `try`,
 * which keeps this correct for a read that throws before it returns a promise
 * at all.
 */
async function attempt<T, S extends string>(
  source: S,
  read: () => Promise<T>,
): Promise<Attempt<T, S>> {
  try {
    return { value: await read(), failure: null };
  } catch (reason) {
    return { value: null, failure: { source, error: errorText(reason) } };
  }
}

/**
 * One extent as it is mapped onto a target, which is what a caller can address.
 *
 * `id` and `lun` come from the mapping and are always known; everything else is
 * the extent record the mapping points at. `name` is null in exactly one case —
 * a mapping naming an extent the system did not report — and since a real
 * extent always carries a name, a null there is the marker that every other
 * field below it is absent for that reason rather than genuinely unset.
 */
interface Extent {
  id: number;
  lun: number;
  name: string | null;
  type: 'DISK' | 'FILE' | null;
  path: string | null;
  disk: string | null;
  enabled: boolean | null;
  locked: boolean | null;
}

/** The fields of a live session this tool reads. */
interface Session {
  initiator: string;
  initiator_addr: string;
  initiator_alias: string | null;
  target: string;
}

/** One initiator with at least one open session, and where it reaches from. */
interface Initiator {
  initiator: string;
  addresses: string[];
  alias: string | null;
}

/**
 * An initiator this tool could not attribute to any target it listed, carrying
 * the target string the system spelled so a caller can see what was not matched.
 */
interface UnattributedInitiator extends Initiator {
  target: string;
}

/**
 * The extents mapped onto each target, indexed by target id.
 *
 * Both reads are issued before either is awaited, so the second is not waiting
 * on the first. They are read as a unit — a mapping with no extent record and an
 * extent record with no mapping are each useless alone — so a failure of either
 * leaves the caller with no extent list rather than half of one.
 */
async function readExtents(system: SystemHandle): Promise<Map<number, Extent[]>> {
  const [extents, mappings] = await Promise.all([
    firstValueFrom(system.client.api.query('iscsi.extent.query')),
    firstValueFrom(system.client.api.query('iscsi.targetextent.query')),
  ]);
  const byId = new Map(extents.map((extent) => [extent.id, extent]));
  const byTarget = new Map<number, Extent[]>();
  for (const mapping of mappings) {
    // Absent rather than asserted: the two queries are separate round trips, so
    // an extent deleted between them leaves a mapping pointing at nothing, and
    // the mapping is still evidence that a LUN was configured.
    const extent = byId.get(mapping.extent);
    const row: Extent = {
      id: mapping.extent,
      lun: mapping.lunid,
      name: extent === undefined ? null : extent.name,
      type: extent?.type ?? null,
      path: extent?.path ?? null,
      disk: extent?.disk ?? null,
      // Not defaulted to true or false: an extent whose switch was not reported
      // must not read as one that is definitely serving or definitely not.
      enabled: extent?.enabled ?? null,
      locked: extent?.locked ?? null,
    };
    const mapped = byTarget.get(mapping.target);
    if (mapped === undefined) byTarget.set(mapping.target, [row]);
    else mapped.push(row);
  }
  return byTarget;
}

/**
 * One entry per initiator, rather than one per session.
 *
 * A multipathed initiator opens a session down each path — that is what
 * multipath is — and the running service reports each of them, with a different
 * address every time. Passing those through one-to-one would make a single host
 * with two NICs read as two hosts connected to the target, so the sessions are
 * grouped under the initiator name that is common to them and every address it
 * reaches the target from is kept beside it. That is also what makes the count
 * of this list the number of initiators the caller asked for.
 *
 * `alias` is taken from the first session that carries one: it is a property of
 * the initiator rather than of the path, so a service that reports it on one
 * session and not another is describing the same host either way.
 */
function groupInitiators(sessions: Session[]): Initiator[] {
  const byName = new Map<string, Initiator>();
  for (const session of sessions) {
    const seen = byName.get(session.initiator);
    if (seen === undefined) {
      byName.set(session.initiator, {
        initiator: session.initiator,
        addresses: [session.initiator_addr],
        alias: textOrNull(session.initiator_alias),
      });
      continue;
    }
    if (!seen.addresses.includes(session.initiator_addr)) {
      seen.addresses.push(session.initiator_addr);
    }
    seen.alias ??= textOrNull(session.initiator_alias);
  }
  return [...byName.values()];
}

/**
 * The unattributable sessions, grouped by the target string they named and then
 * by initiator, so that a multipathed initiator counts once here too.
 */
function groupUnattributed(sessions: Session[]): UnattributedInitiator[] {
  const byTargetString = new Map<string, Session[]>();
  for (const session of sessions) {
    const named = byTargetString.get(session.target);
    if (named === undefined) byTargetString.set(session.target, [session]);
    else named.push(session);
  }
  return [...byTargetString.entries()].flatMap(([target, group]) =>
    groupInitiators(group).map((one) => ({ ...one, target })),
  );
}

/**
 * The one target a session's `target` string names, or null where no single
 * target answers to it.
 *
 * A session names its target by a string rather than by the id the other three
 * queries join on, and which string that is has not been confirmed against a
 * live system: it is the target's own `name` beside a `target_alias` that
 * matches its `alias`, which reads as the bare name, but the running service
 * knows targets by their full IQN — `iqn.2005-10.org.freenas.ctl:<name>` — and
 * either spelling is plausible in that field. Both are therefore accepted, and
 * neither can produce a match the other would have got wrong: target names are
 * unique, so an exact match is decided before a suffix is considered at all.
 *
 * The suffix form is required to name exactly one target. A target name may
 * itself contain a colon, so `a:b` and `b` can both be suffixes of one IQN —
 * rare, and the wrong answer either way, so the session is left unattributed
 * where it happens rather than being reported against both.
 */
function targetOf(sessionTarget: string, byName: Map<string, number>): number | null {
  const exact = byName.get(sessionTarget);
  if (exact !== undefined) return exact;
  const suffixed = [...byName.entries()].filter(([name]) => sessionTarget.endsWith(`:${name}`));
  return suffixed.length === 1 ? suffixed[0][1] : null;
}

export const iscsiList: ReadOnlyTool = {
  name: 'iscsi_list',
  description:
    'Every iSCSI target the system serves, the extents mapped onto it, and the ' +
    'initiators currently connected to it. `id` is the target\'s numeric ' +
    'identity, `name` the target name clients connect to, and `alias` the ' +
    'label it was given, null where it has none. `mode` is how the target is ' +
    'served — `ISCSI`, `FC` for Fibre Channel, or `BOTH` — and is null where ' +
    'the system reported no value. READ IT BEFORE READING AN EMPTY ' +
    '`initiators` AS AN IDLE TARGET: an `FC` target is not served over iSCSI ' +
    'at all, so it holds no iSCSI session by definition and an empty list ' +
    'there says nothing about whether it is in use. Fibre Channel sessions are ' +
    'not visible to this tool. `extents` are the backing ' +
    'stores mapped onto the target: `lun` is the logical unit number the ' +
    'initiator addresses it by, `id` the extent\'s numeric identity, `name` its ' +
    'name, and `type` `DISK` or `FILE` — a zvol or a file on a dataset. `disk` ' +
    'is the backing device and applies to a `DISK` extent alone, so it is null ' +
    'on a `FILE` one. `path` is the backing store as a filesystem path and is ' +
    'NOT limited to `FILE` extents: on a `DISK` extent the system reports the ' +
    'device node there as well, so `path` being set does not make an extent ' +
    'file-backed — `type` is what says that. Both are reported as the system ' +
    'sent them, and either is null where it sent no value. ' +
    '`enabled` is whether the extent is switched on and `locked` whether its ' +
    'dataset is locked; a locked or disabled extent is mapped but serves no ' +
    'data, and both are null where the system reported no value. An extent ' +
    'whose record the system did not return at all reports its `id` and `lun` ' +
    'with EVERY OTHER FIELD null, including `name` — a real extent always ' +
    'carries a name, so a null `name` says the mapping points at an extent this ' +
    'tool could not resolve rather than one with nothing set. `initiators` are ' +
    'the initiators holding an open session on that target right now, each with ' +
    'its `initiator` name, its `alias` where it has one, and `addresses`, every ' +
    'address it is reaching the target from. There is ONE ENTRY PER INITIATOR ' +
    'rather than one per session: a multipathed initiator opens a session down ' +
    'each path, and those are reported as one initiator with several ' +
    '`addresses` rather than as several initiators, so the length of this list ' +
    'is the number of distinct initiators connected. AN EMPTY ' +
    '`initiators` AND A NULL ONE ARE DIFFERENT ANSWERS: empty means the ' +
    'sessions were read and none is on this target, which for an `ISCSI` or ' +
    '`BOTH` target is one nothing is currently using; null means the sessions ' +
    'could not be read at all, and ' +
    'says nothing about whether anything is connected. `extents` is null in the ' +
    'same way and for the same reason. `failures` names each read that failed, ' +
    'as `source` — `extents` or `initiators` — and `error`, and is empty when ' +
    'both were read. `unattributed_initiators` holds initiators whose sessions ' +
    'named a `target` matching none of the targets listed, or matching more ' +
    'than one; each carries that string as `target` so the mismatch is ' +
    'visible, and is grouped by initiator in the same way. WHILE IT IS NOT EMPTY THE ' +
    'PER-TARGET `initiators` LISTS ARE INCOMPLETE, and a target reporting an ' +
    'empty list may in fact be in use. This tool reads only iSCSI: NVMe-oF ' +
    'subsystems and Fibre Channel ports are served separately and are not ' +
    'listed here, and neither are SMB or NFS shares, which are `shares_list`.',
  inputSchema: { type: 'object', properties: {} },
  requiredRole: Role.ReadOnly,
  mutating: false,
  async handler({ system }) {
    // Every read is issued before any is awaited, so none waits on another.
    // Only the target query is allowed to fail the tool: an extent or a session
    // describes a target, and with no targets there is nothing for either to
    // describe — while a system whose targets listed and whose sessions did not
    // still has a partial answer worth returning, which is what `failures` is.
    const [targets, extents, sessions] = await Promise.all([
      firstValueFrom(system.client.api.query('iscsi.target.query')),
      attempt('extents', () => readExtents(system)),
      attempt('initiators', () =>
        firstValueFrom(system.client.api.query('iscsi.global.sessions')),
      ),
    ]);

    const byName = new Map(targets.map((target) => [target.name, target.id]));
    const byTarget = new Map<number, Session[]>();
    const unattributed: Session[] = [];
    for (const session of sessions.value ?? []) {
      const id = targetOf(session.target, byName);
      if (id === null) {
        unattributed.push(session);
        continue;
      }
      const attached = byTarget.get(id);
      if (attached === undefined) byTarget.set(id, [session]);
      else attached.push(session);
    }

    const failures: Failure<IscsiSource>[] = [];
    if (extents.failure !== null) failures.push(extents.failure);
    if (sessions.failure !== null) failures.push(sessions.failure);

    return {
      targets: targets.map((target) => ({
        id: target.id,
        name: target.name,
        alias: textOrNull(target.alias),
        // Reported because it decides whether an empty `initiators` means
        // anything: an `FC` target is not served over iSCSI at all, so it can
        // never hold a session, and without this field that reads identically
        // to an `ISCSI` target nothing is using.
        mode: target.mode ?? null,
        // Null for a read that failed, and an empty list for one that succeeded
        // and found none — the distinction the description promises, and the
        // reason neither defaults to the other.
        extents: extents.value === null ? null : (extents.value.get(target.id) ?? []),
        initiators:
          sessions.value === null ? null : groupInitiators(byTarget.get(target.id) ?? []),
      })),
      failures,
      unattributed_initiators: groupUnattributed(unattributed),
    };
  },
};

/**
 * A number the system reported, or null where it reported anything else.
 *
 * The NVMe-oF reads need this where the iSCSI ones do not: the pinned client
 * types a subsystem entry as `Record<string, unknown>`, so every field of one —
 * including the id the other two reads are joined on — arrives as `unknown` and
 * has to be read rather than trusted. Non-finite is not a number here: an id
 * that is `NaN` joins nothing and a size that is `NaN` measures nothing.
 */
function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** A boolean the system reported, or null where it reported anything else. */
function booleanOrNull(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

/** One namespace of a subsystem: a block device, as an initiator addresses it. */
interface Namespace {
  id: number | null;
  nsid: number | null;
  device_type: 'ZVOL' | 'FILE' | null;
  device_path: string | null;
  size_bytes: number | null;
  enabled: boolean | null;
  locked: boolean | null;
}

/**
 * One row of a secondary read, with the subsystem its record named.
 *
 * Both reads name their subsystem with the whole subsystem record nested inside
 * the row rather than with a bare id, so the join is on a value read out of that
 * untyped record. `subsystem_id` is that value and `subsystem` the name beside
 * it, kept because it is all there is left to report the row by where the id is
 * missing or answers to no subsystem in the listing.
 *
 * `value` is what the row says, and is null for a row that carries nothing
 * statable even where its subsystem is known — a host grant with no NQN.
 */
interface Claim<T> {
  value: T;
  subsystem_id: number | null;
  subsystem: string | null;
}

/** Rows filed under the subsystem each named, and the ones that could not be. */
interface Attribution<T> {
  bySubsystem: Map<number, T[]>;
  unattributed: Claim<T>[];
}

/**
 * The rows of one read, each filed under the subsystem it named where that can
 * be done and set aside where it cannot.
 *
 * A row is set aside where its record named no readable subsystem id, where
 * that id answers to no subsystem in the listing, or where the row itself says
 * nothing statable. Filing any of those under a subsystem anyway would report a
 * namespace on the wrong device, or a host as allowed onto one it is not — but
 * dropping them outright is the failure this exists to prevent: a subsystem's
 * empty list would then say the rows are not there, when what is true is that
 * they could not be placed. The caller reports them beside the listing instead.
 */
function attribute<T>(rows: Claim<T>[], listed: Set<number>): Attribution<T> {
  const bySubsystem = new Map<number, T[]>();
  const unattributed: Claim<T>[] = [];
  for (const row of rows) {
    const id = row.subsystem_id;
    if (row.value === null || id === null || !listed.has(id)) {
      unattributed.push(row);
      continue;
    }
    const filed = bySubsystem.get(id);
    if (filed === undefined) bySubsystem.set(id, [row.value]);
    else filed.push(row.value);
  }
  return { bySubsystem, unattributed };
}

/**
 * Every namespace the system reported, each with the subsystem its row named.
 *
 * The rows are not grouped here because grouping needs the subsystem listing to
 * decide what a named id attributes to, and this read is issued before that
 * listing has arrived.
 */
async function readNamespaces(system: SystemHandle): Promise<Claim<Namespace>[]> {
  const namespaces = await firstValueFrom(system.client.api.query('nvmet.namespace.query'));
  const claims: Claim<Namespace>[] = [];
  for (const namespace of namespaces) {
    const row: Namespace = {
      id: numberOrNull(namespace.id),
      // The identifier an initiator addresses the namespace by, which is not
      // the middleware's own record id above and does not follow it.
      nsid: numberOrNull(namespace.nsid),
      device_type: namespace.device_type ?? null,
      device_path: textOrNull(namespace.device_path),
      // The size of a FILE namespace's backing file. A ZVOL namespace takes its
      // size from the zvol and carries none here, so null is a size this read
      // did not learn rather than a namespace of no size.
      size_bytes: numberOrNull(namespace.filesize),
      // Not defaulted to true or false, as with an iSCSI extent above: a
      // namespace whose switch was not reported must not read as one that is
      // definitely serving or definitely not.
      enabled: booleanOrNull(namespace.enabled),
      locked: booleanOrNull(namespace.locked),
    };
    claims.push({
      value: row,
      subsystem_id: numberOrNull(namespace.subsys['id']),
      subsystem: textOrNull(namespace.subsys['name']),
    });
  }
  return claims;
}

/**
 * The NQN of every host grant the system reported, each with the subsystem its
 * row named.
 *
 * `nvmet.host_subsys.query` is the join table and it embeds both sides whole:
 * the host record it points at carries the NQN, so the hosts do not have to be
 * read separately and no row can point at a host that was not returned.
 *
 * A grant whose host carries no NQN is not the host any initiator connects as,
 * so its `value` is null: it cannot go in a list whose whole content is names,
 * and `attribute` sets it aside rather than putting a nameless entry there.
 */
async function readHosts(system: SystemHandle): Promise<Claim<string | null>[]> {
  const joins = await firstValueFrom(system.client.api.query('nvmet.host_subsys.query'));
  return joins.map((join) => ({
    value: textOrNull(join.host.hostnqn),
    subsystem_id: numberOrNull(join.subsys['id']),
    subsystem: textOrNull(join.subsys['name']),
  }));
}

/** The JSON-RPC code for a method the server does not have. */
const METHOD_NOT_FOUND = -32601;

/** The middleware's own name for the same thing. */
const NO_SUCH_METHOD = 'ENOMETHOD';

/**
 * Whether a rejection is the system saying it has no such method, rather than a
 * method it has and would not run.
 *
 * This is the whole basis for reporting a system as having no NVMe-oF, so it
 * recognises only the two spellings that mean exactly that — the JSON-RPC code
 * for an absent method, and the middleware's own error name for it — in the
 * four places the client documents an error arriving: the rejection itself, a
 * nested `data`, and the `reason` or `message` text either carries. It
 * deliberately does not match looser English like "not found", which is also
 * what a system says about a subsystem id that does not exist.
 *
 * (unconfirmed) Which of those shapes a TrueNAS too old for NVMe-oF actually
 * rejects with has not been observed against a live system — only read off the
 * client's own error types. Getting it wrong costs a raised error rather than a
 * wrong answer: an unrecognised rejection is raised, never reported as
 * unsupported.
 */
function isUnsupported(reason: unknown): boolean {
  if (reason instanceof Error) return namesMissingMethod(reason.message);
  if (typeof reason !== 'object' || reason === null) return namesMissingMethod(reason);
  const carrier = reason as Record<string, unknown>;
  if (carrier['code'] === METHOD_NOT_FOUND) return true;
  if (carrier['errname'] === NO_SUCH_METHOD) return true;
  if (namesMissingMethod(carrier['reason']) || namesMissingMethod(carrier['message'])) return true;
  const data = carrier['data'];
  return typeof data === 'object' && data !== null && isUnsupported(data);
}

/** Whether some text the system sent names the absent-method error. */
function namesMissingMethod(text: unknown): boolean {
  return typeof text === 'string' && text.includes(NO_SUCH_METHOD);
}

/** A read that produced rows, or the rejection that stopped it, kept whole. */
interface Read<T> {
  rows: T | null;
  reason: unknown;
}

/**
 * The subsystems, with a rejection kept as it arrived rather than reduced to
 * text.
 *
 * `attempt` is the right shape for every other read here and the wrong one for
 * this: whether this failure is raised or reported turns on what kind of
 * rejection it is, and `attempt` has already thrown that away by the time its
 * caller sees a `Failure`.
 *
 * The rows are `Record<string, unknown>[]` because that is how the pinned
 * client types a subsystem entry — untyped, unlike the namespace and join rows
 * beside it — rather than because this widens anything.
 */
function readSubsystems(system: SystemHandle): Promise<Read<Record<string, unknown>[]>> {
  return firstValueFrom(system.client.api.query('nvmet.subsys.query')).then(
    (rows) => ({ rows, reason: null }),
    (reason: unknown) => ({ rows: null, reason }),
  );
}

export const nvmeofList: ReadOnlyTool = {
  name: 'nvmeof_list',
  description:
    'Every NVMe-oF subsystem the system exports, the hosts allowed onto each, ' +
    'and the namespaces behind it. `supported` is whether this system has ' +
    'NVMe-oF at all: a TrueNAS whose version predates it answers `false`, with ' +
    '`subsystems` null and `unsupported_reason` naming what the system said. ' +
    'READING THAT AS A SYSTEM WITH NO SUBSYSTEMS IS WRONG — it is a system ' +
    'that cannot have any, which is a different answer from an empty list. ' +
    '`false` is reported ONLY where the system said it has no such method: a ' +
    'read that was denied, or that failed for any other reason, raises instead ' +
    'of answering, so an unsupported verdict is never inferred from a failure ' +
    'that said nothing about support. When `supported` is true ' +
    '`unsupported_reason` is null and `subsystems` is the list. `id` is the ' +
    "subsystem's numeric identity, `name` its short name, and `nqn` the NVMe " +
    'Qualified Name an initiator connects to, null where the system reported ' +
    'none. `allow_any_host` is whether the subsystem admits any host at all. ' +
    'READ IT BEFORE READING `hosts` AS A RESTRICTION: where it is true, hosts ' +
    'outside that list may attach, so an empty `hosts` is not a subsystem ' +
    'nobody may reach; it is null where the system reported no value, which ' +
    'settles neither. `hosts` are the NQNs of the hosts explicitly allowed ' +
    'onto the subsystem, and are CONFIGURATION RATHER THAN LIVE STATE: this ' +
    'tool reports who may attach and cannot report who is attached, because ' +
    'the middleware exposes no NVMe-oF equivalent of the iSCSI session list. ' +
    'An empty `hosts` therefore says nothing about whether the subsystem is in ' +
    'use, and neither does a full one. `namespaces` are the block devices the ' +
    'subsystem exports. `nsid` is the identifier an initiator addresses a ' +
    "namespace by and `id` the middleware's own record id — different numbers, " +
    'and neither follows the other. `device_type` is `ZVOL` or `FILE` and ' +
    '`device_path` the backing zvol or file. `size_bytes` is the size of a ' +
    'backing FILE and IS NULL ON A ZVOL NAMESPACE, which takes its size from ' +
    'the zvol rather than carrying one here: null is a size this tool did not ' +
    'learn, never a namespace of no size. `enabled` is whether the namespace ' +
    'is switched on and `locked` whether its dataset is locked; a locked or ' +
    'disabled namespace is configured but serves no data, and both are null ' +
    'where the system reported no value. AN EMPTY `namespaces` AND A NULL ONE ' +
    'ARE DIFFERENT ANSWERS: empty means the namespaces were read and none of ' +
    'them was placed on this subsystem; null means they could not be read at ' +
    'all. `hosts` is null in the same way and for the same reason. Both are ' +
    "also null where `id` is null, because the subsystem's own identity is " +
    'what each is joined on and there is then nothing to attribute to it. ' +
    '`failures` names each read that failed, as `source` — `namespaces` or ' +
    '`hosts` — and `error`, and is empty when both were read. ' +
    '`unattributed_namespaces` and `unattributed_hosts` hold the rows that ' +
    'WERE read and could not be placed on any subsystem listed here. Each ' +
    'carries the `subsystem_id` and `subsystem` name its own record named, so ' +
    'what it claimed is visible: both are null where the record named neither, ' +
    'and `subsystem_id` is set where it named an id no subsystem here answers ' +
    'to. An entry in `unattributed_hosts` whose `hostnqn` is null is a grant ' +
    'naming no host to report, which is the one kind that names a subsystem ' +
    'and still cannot be listed under it. WHILE EITHER LIST IS NOT EMPTY THE ' +
    'PER-SUBSYSTEM `namespaces` AND `hosts` LISTS ARE INCOMPLETE, and an empty ' +
    'one there is not a subsystem with nothing on it. Both are empty when a ' +
    'read failed, because nothing was read to place — `failures` is what says ' +
    'so, and is also what tells a list that could not be read from one that ' +
    'could not be attributed. This tool reads only ' +
    'NVMe-oF: iSCSI targets are `iscsi_list`, and SMB or NFS shares are ' +
    '`shares_list`. It does not report which ports a subsystem is published ' +
    'on, so a subsystem listed here is not necessarily reachable over the ' +
    'network.',
  inputSchema: { type: 'object', properties: {} },
  requiredRole: Role.ReadOnly,
  mutating: false,
  async handler({ system }) {
    // Every read is issued before any is awaited, so none waits on another, and
    // as in `iscsi_list` only the first is allowed to fail the tool: a namespace
    // and a host describe a subsystem, and with no subsystems there is nothing
    // for either to describe.
    const [subsystems, namespaces, hosts] = await Promise.all([
      readSubsystems(system),
      attempt('namespaces', () => readNamespaces(system)),
      attempt('hosts', () => readHosts(system)),
    ]);

    if (subsystems.rows === null) {
      // Raised rather than reported unless the system said the method is not
      // there: "this system has no NVMe-oF" is a claim about the system, and a
      // denied or dropped read is evidence for no such claim.
      if (!isUnsupported(subsystems.reason)) throw subsystems.reason;
      return {
        supported: false,
        unsupported_reason: errorText(subsystems.reason),
        subsystems: null,
        // The other two reads fail the same way on such a system. Naming them
        // would report one absent feature three times, as three defects — and
        // no row was read, so nothing was left out of a list either.
        failures: [],
        unattributed_namespaces: [],
        unattributed_hosts: [],
      };
    }

    const failures: Failure<NvmeofSource>[] = [];
    if (namespaces.failure !== null) failures.push(namespaces.failure);
    if (hosts.failure !== null) failures.push(hosts.failure);

    // Read rather than trusted, and read once: the id is both the reported
    // identity and what the other two reads are attributed by, so a subsystem
    // the system did not number is one nothing can be attached to.
    const identified = subsystems.rows.map((subsystem) => ({
      subsystem,
      id: numberOrNull(subsystem['id']),
    }));
    // What a namespace or host row has to name to be filed under a subsystem
    // this listing actually reports. A row naming anything else is set aside
    // rather than dropped, because a dropped row leaves an empty list behind
    // that says the subsystem has none.
    const listed = new Set(identified.flatMap(({ id }) => (id === null ? [] : [id])));
    const attributed = namespaces.value === null ? null : attribute(namespaces.value, listed);
    const allowed = hosts.value === null ? null : attribute(hosts.value, listed);

    return {
      supported: true,
      unsupported_reason: null,
      subsystems: identified.map(({ subsystem, id }) => ({
        id,
        name: textOrNull(subsystem['name']),
        nqn: textOrNull(subsystem['subnqn']),
        // Reported because it decides whether `hosts` means anything: where
        // it is true the list does not restrict, and without this field an
        // empty one reads as a subsystem nobody may attach to.
        allow_any_host: booleanOrNull(subsystem['allow_any_host']),
        // Null for a read that failed and for a subsystem with no id to join
        // on; an empty list for a read that succeeded and found none.
        hosts: allowed === null || id === null ? null : (allowed.bySubsystem.get(id) ?? []),
        namespaces:
          attributed === null || id === null ? null : (attributed.bySubsystem.get(id) ?? []),
      })),
      failures,
      // Flat rather than nested, as `iscsi_list` reports its own unattributable
      // rows: what the row said is beside what it named, so a caller reading one
      // entry sees both the namespace and why it is here rather than in a list.
      unattributed_namespaces: (attributed?.unattributed ?? []).map((row) => ({
        ...row.value,
        subsystem_id: row.subsystem_id,
        subsystem: row.subsystem,
      })),
      unattributed_hosts: (allowed?.unattributed ?? []).map((row) => ({
        hostnqn: row.value,
        subsystem_id: row.subsystem_id,
        subsystem: row.subsystem,
      })),
    };
  },
};
