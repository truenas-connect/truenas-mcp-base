import type { QueryEntity } from '@truenas/api-client';
import { firstValueFrom } from 'rxjs';
import { Role } from '@/interfaces';
import { ApiSurface, MutatingTool, PlanStep, ReadOnlyTool, SystemHandle, ToolContext } from '@/catalog/tool';
import {
  agreement,
  booleanOrNull,
  errorText,
  isMissingMethod,
  NONE_REPORTED,
  numberOrNull,
  readStep,
  recordOrNull,
  refuseArgs,
  rowWithId,
  strictTextList,
  textOrNull,
  unreportedKeys,
} from '@/tools/common';

/**
 * Block-storage family: what the system serves as block devices rather than as
 * filesystem paths, over each of the three protocols that do it.
 *
 * `shares_list` deliberately excludes all of them, and says so: a target, a
 * subsystem or an FC port exports a block device rather than a filesystem path,
 * and its vocabulary answers a different question. That question is asked here,
 * once per protocol — `iscsi_list` for iSCSI, `nvmeof_list` for NVMe-oF,
 * `fc_list` for Fibre Channel. They are three tools rather than one because
 * they share no vocabulary: targets, extents and initiators on the first side,
 * subsystems, namespaces and hosts on the second, host adapters, ports and
 * WWPNs on the third, with no field meaning the same thing in any two.
 *
 * iSCSI takes five middleware namespaces to answer, and none of them nests
 * inside another. `iscsi.target.query` names the targets; `iscsi.extent.query`
 * names the backing stores; `iscsi.targetextent.query` is the join table that
 * maps an extent onto a target at a LUN; `iscsi.portal.query` names the
 * addresses the service listens on; and `iscsi.global.sessions` is live
 * state from the running service rather than configuration at all — it is the
 * only one that says whether anything is actually connected. The last is the
 * reason the tool exists: a target with no session is the shape of a hypervisor
 * that quietly dropped its storage, and nothing in the others can tell that
 * from a target nobody has ever used.
 *
 * NVMe-oF takes five, and unlike the iSCSI five three of them nest: a namespace
 * carries the subsystem it belongs to, and the host/subsystem and
 * port/subsystem joins carry both sides whole. None of them is live state — the
 * middleware exposes no equivalent of `iscsi.global.sessions` for NVMe-oF in
 * this client, so `nvmeof_list` answers what is configured and cannot say what
 * is attached.
 *
 * Both families read where the service listens, and neither read is allowed to
 * fail its tool: a portal and a port are facts about the protocol rather than
 * parts of a target or a subsystem, which is #135's test answered the way
 * `fc_list` answers it. A target's own record carries the portal group it is
 * published in and this tool does not read it, so where a system has more than
 * one portal, which target is reachable at which address is not answered here.
 *
 * Fibre Channel takes three that do not nest at all, and unlike the other two
 * families one of them is untyped: `fc.fc_host.query` and `fcport.query` are
 * declared entities, while `fcport.status` takes and answers open records and
 * is the one read that says whether a link is up. So the FC tool is the only one
 * here carrying an unconfirmed allowlist and the `unreported_fields` list that
 * makes it checkable (#98), and the only one whose three reads are ALL caught:
 * no one of them names the others' subjects, so none is entitled to fail the
 * tool.
 */

/** Which of the three secondary iSCSI reads failed. */
type IscsiSource = 'extents' | 'initiators' | 'portals';

/** Which of the four secondary NVMe-oF reads failed. */
type NvmeofSource = 'namespaces' | 'hosts' | 'ports' | 'port_subsystems';

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
 * `textOrNull` from `common.ts` is what reads a target's alias, which the
 * middleware sends as `""` when it is unset — passing that through would put a
 * field in the result that says nothing.
 */

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
 * One address a portal accepts connections on, and the TCP port on it.
 *
 * Both fields are read rather than trusted, and either is null on its own: an
 * address with no readable port still says which interface the service is bound
 * to, which is the half of the answer a caller most often needs.
 */
interface Listen {
  ip: string | null;
  port: number | null;
}

/**
 * One portal: the set of addresses the iSCSI service accepts connections on,
 * under its id — which is what a target's portal group names it by — and its
 * tag.
 *
 * `listen` is null where the portal reported no list at all and an empty list
 * where it reported one naming nothing — a portal listening nowhere, which is a
 * real configuration and not a failed read. An entry inside a list that could
 * not be read is KEPT as a row of nulls rather than dropped, per #93's direction
 * rule: a listen list one entry shorter says the service is not reachable at an
 * address it is in fact bound to, which is a claim, while the kept row of nulls
 * says only that this tool could not read one of them.
 */
interface Portal {
  id: number | null;
  tag: number | null;
  comment: string | null;
  listen: Listen[] | null;
}

/** Every portal the system reported, each reduced to named fields. */
async function readPortals(system: SystemHandle): Promise<Portal[]> {
  const portals = await firstValueFrom(system.client.api.query('iscsi.portal.query'));
  return portals.map((portal) => ({
    id: numberOrNull(portal.id),
    // The portal group number the system knows the portal by. A target's
    // `groups[].portal` names the portal by `id` instead, which is what
    // `iscsi_target_create` resolves it against; this tool does not make that
    // join, and says so in its description.
    tag: numberOrNull(portal.tag),
    comment: textOrNull(portal.comment),
    listen: Array.isArray(portal.listen)
      ? portal.listen.map((entry) => {
          const record = recordOrNull(entry);
          return {
            ip: record === null ? null : textOrNull(record['ip']),
            port: record === null ? null : numberOrNull(record['port']),
          };
        })
      : null,
  }));
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
    'not visible to this tool, and are not visible to `fc_list` either — the ' +
    'middleware exposes no FC equivalent of the iSCSI session list, so nothing ' +
    'in this catalog reports who is attached over FC. `extents` are the backing ' +
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
    'same way and for the same reason. `portals` are the portals the iSCSI ' +
    'service listens on, and are reported BESIDE the targets rather than under ' +
    'them: THIS TOOL DOES NOT SAY WHICH PORTAL SERVES WHICH TARGET, so on a ' +
    'system with more than one portal, which address a given target is reachable ' +
    'at is not answered here. `id` is the portal\'s numeric identity, `tag` the ' +
    'portal group number the system knows it by, and `comment` the label it was ' +
    'given; EVERY ONE OF THE THREE IS NULL WHERE THE SYSTEM REPORTED NO ' +
    'READABLE VALUE, which for `comment` is also a portal that was never ' +
    'labelled, and a portal with a null `id` or `tag` is one this tool could ' +
    'not identify rather than one that is not there. `listen` is where that portal accepts ' +
    'connections, one entry per address, with `ip` the address and `port` the ' +
    'TCP port; either is null where the system reported no readable value. A ' +
    'LISTEN ADDRESS OF `0.0.0.0` IS NOT AN ADDRESS: it is the wildcard, and ' +
    'means the portal accepts connections on EVERY IPv4 address the system has, ' +
    'as `::` does for IPv6. A specific address is the opposite claim — the ' +
    'service is bound to that address alone, and an initiator pointed at any ' +
    'other address of the same appliance will not connect, which is the shape ' +
    'that reads as a working configuration and is not. An entry the system sent ' +
    'that could not be read is KEPT as a row of nulls rather than dropped, ' +
    'because a shorter list would say the service is unreachable at an address ' +
    'it is bound to. AN EMPTY `listen` AND A NULL ONE ARE DIFFERENT ANSWERS: ' +
    'empty is a portal that listens nowhere, which is a real configuration; ' +
    'null is a portal that reported no list. AN EMPTY `portals` AND A NULL ONE ' +
    'ARE DIFFERENT ANSWERS in the same way: empty means the portals were read ' +
    'and the system has none, so the iSCSI service accepts nothing wherever its ' +
    'targets point; null means the read failed, which `failures` names, and ' +
    'says nothing about where the service listens. `failures` names each read ' +
    'that failed, as `source` — `extents`, `initiators` or `portals` — and ' +
    '`error`, and is empty when all three were read. NONE OF THOSE THREE FAILS ' +
    'THE TOOL — the target read is the one that does, and a tool that answered ' +
    'at all read the targets. `unattributed_initiators` holds initiators whose sessions ' +
    'named a `target` matching none of the targets listed, or matching more ' +
    'than one; each carries that string as `target` so the mismatch is ' +
    'visible, and is grouped by initiator in the same way. WHILE IT IS NOT EMPTY THE ' +
    'PER-TARGET `initiators` LISTS ARE INCOMPLETE, and a target reporting an ' +
    'empty list may in fact be in use. This tool reads only iSCSI: NVMe-oF ' +
    'subsystems are `nvmeof_list` and Fibre Channel host adapters and ports are ' +
    '`fc_list`, and neither is listed here; nor are SMB or NFS shares, which ' +
    'are `shares_list`. A target whose `mode` is `FC` or `BOTH` is served over ' +
    'Fibre Channel, and `fc_list` is what reports the ports carrying it.',
  inputSchema: { type: 'object', properties: {} },
  requiredRole: Role.ReadOnly,
  mutating: false,
  async handler({ system }) {
    // Every read is issued before any is awaited, so none waits on another.
    // Only the target query is allowed to fail the tool: an extent or a session
    // describes a target, and with no targets there is nothing for either to
    // describe — while a system whose targets listed and whose sessions did not
    // still has a partial answer worth returning, which is what `failures` is.
    const [targets, extents, sessions, portals] = await Promise.all([
      firstValueFrom(system.client.api.query('iscsi.target.query')),
      attempt('extents', () => readExtents(system)),
      attempt('initiators', () =>
        firstValueFrom(system.client.api.query('iscsi.global.sessions')),
      ),
      // A portal is where the service listens rather than a fact about any one
      // target, so it is caught like the other two: a system whose portals did
      // not read still has targets and sessions worth reporting.
      attempt('portals', () => readPortals(system)),
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
    if (portals.failure !== null) failures.push(portals.failure);

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
      // Null for a read that failed and a list for one that succeeded, as the
      // per-target lists above are — a system with no portal accepts no
      // connection anywhere, and that must not read the same as a portal read
      // that did not happen.
      portals: portals.value,
      failures,
      unattributed_initiators: groupUnattributed(unattributed),
    };
  },
};

/**
 * The NVMe-oF reads below need `numberOrNull` where the iSCSI ones do not: a
 * subsystem's id is what the other two reads are joined on, and the client
 * declaring it `number` is a claim about what the middleware sends rather than
 * about the value received, so it is read rather than trusted. Non-finite is
 * excluded there for a reason this family feels directly: an id that is `NaN`
 * joins nothing and a size that is `NaN` measures nothing.
 */

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

/**
 * One subsystem a port publishes, reduced from the record the join embeds.
 *
 * Named for what it is rather than for the entity it came from, and carrying
 * the same pair the unattributable rows above carry, so the two accounts of a
 * subsystem cannot be read as two facts. The NQN an initiator connects to is
 * NOT repeated here: it is reported once, on the subsystem itself, and a caller
 * reaches it through `subsystem_id`.
 */
interface PortSubsystem {
  subsystem_id: number | null;
  subsystem: string | null;
}

/** One row of the port/subsystem join, with the port its record named. */
interface PortClaim {
  value: PortSubsystem;
  port_id: number | null;
}

/**
 * The service identifier a port answers on, as the system spelled it.
 *
 * `addr_trsvcid` is declared `number | string | null`, which is the surface
 * refusing to fix a meaning: it is a TCP port number on a TCP port and
 * something else on an FC one. Both spellings are passed through as themselves
 * and NEITHER IS COERCED — reading a string as a number would be this
 * repository asserting a meaning it never read, which is #96's rule about a
 * unit reaching a value.
 */
function serviceId(value: unknown): string | number | null {
  return typeof value === 'number' ? numberOrNull(value) : textOrNull(value);
}

/** The transports a port can be carried over, as the pinned surface declares them. */
const TRANSPORTS = ['TCP', 'RDMA', 'FC'] as const;

/** The address families a port's address can be in, on the same surface. */
const ADDRESS_FAMILIES = ['IPV4', 'IPV6', 'FC'] as const;

/**
 * One member of a declared string union, or null for anything else.
 *
 * The union is read rather than passed through, which is #101's rule about a
 * mapping keyed off `ApiSurface`: that surface is the OLDEST supported TrueNAS
 * directory, so a later release can send a transport these three do not name
 * with nothing failing to compile. Passing the value through would put a fourth
 * value in a field whose type says it holds one of three, and a caller
 * switching on it would fall through every arm. Null is the honest answer, and
 * the description says it covers a value this catalog does not recognise as
 * well as one the system did not report.
 */
function oneOf<T extends string>(allowed: readonly T[], value: unknown): T | null {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : null;
}

/**
 * One NVMe-oF port: an address the system accepts NVMe-oF connections on, and
 * the subsystems published through it.
 *
 * `enabled` is optional on the declared entity, so `enabled_reported` splits
 * its null the way `npiv_reported` splits an FC adapter's (#134) — a release
 * that does not report the field at all from one that reported something this
 * tool could not read as a boolean. Both read the row's own key, so a value can
 * never sit beside a `false` there.
 */
interface Port {
  id: number | null;
  index: number | null;
  transport: 'TCP' | 'RDMA' | 'FC' | null;
  address_family: 'IPV4' | 'IPV6' | 'FC' | null;
  address: string | null;
  service_id: string | number | null;
  enabled: boolean | null;
  enabled_reported: boolean;
  subsystems: PortSubsystem[] | null;
}

/** Every port the system reported, before any join row has been attributed. */
async function readPorts(system: SystemHandle): Promise<Omit<Port, 'subsystems'>[]> {
  const ports = await firstValueFrom(system.client.api.query('nvmet.port.query'));
  return ports.map((port) => {
    const reported = Object.hasOwn(port, 'enabled');
    return {
      id: numberOrNull(port.id),
      // The system's own ordinal for the port, which is not its record id and
      // does not follow it — the same pairing a namespace's `nsid` and `id`
      // have above.
      index: numberOrNull(port.index),
      transport: oneOf(TRANSPORTS, port.addr_trtype),
      address_family: oneOf(ADDRESS_FAMILIES, port.addr_adrfam),
      address: textOrNull(port.addr_traddr),
      service_id: serviceId(port.addr_trsvcid),
      enabled: reported ? booleanOrNull(port.enabled) : null,
      enabled_reported: reported,
    };
  });
}

/**
 * Every port/subsystem publication the system reported, each with the port its
 * record named.
 *
 * `nvmet.port_subsys.query` embeds BOTH sides whole — a full port record and a
 * full subsystem record on every row — and neither is forwarded (#100): each is
 * reduced to the identifiers that let a caller attach one to the other, which
 * is what keeps a field a later release adds to either entity out of a tool
 * result. Both are read through `recordOrNull` first, so a row that embedded
 * something other than a record is a row that names nothing rather than a read
 * that throws and takes the whole publication list with it.
 */
async function readPortSubsystems(system: SystemHandle): Promise<PortClaim[]> {
  const joins = await firstValueFrom(system.client.api.query('nvmet.port_subsys.query'));
  return joins.map((join) => {
    const port = recordOrNull(join.port);
    const subsys = recordOrNull(join.subsys);
    return {
      value: {
        subsystem_id: subsys === null ? null : numberOrNull(subsys['id']),
        subsystem: subsys === null ? null : textOrNull(subsys['name']),
      },
      port_id: port === null ? null : numberOrNull(port['id']),
    };
  });
}

/** Publications filed under the port each named, and the ones that could not be. */
interface PortAttribution {
  byPort: Map<number, PortSubsystem[]>;
  unattributed: (PortSubsystem & { port_id: number | null })[];
}

/**
 * The join rows filed under the port each named, where that names a port this
 * listing reports, and set aside where it does not.
 *
 * Set aside rather than dropped, for `attribute`'s reason one read over: a
 * dropped row leaves an empty `subsystems` behind that says the port publishes
 * nothing, which is a claim this read did not make. A row naming a port and no
 * readable subsystem is KEPT UNDER THAT PORT as a pair of nulls, because
 * dropping it moves the same list towards empty and says the same wrong thing;
 * what it costs is a row a caller cannot join against `subsystems[]`, which the
 * description states.
 */
function attributePorts(rows: PortClaim[], listed: Set<number>): PortAttribution {
  const byPort = new Map<number, PortSubsystem[]>();
  const unattributed: PortAttribution['unattributed'] = [];
  for (const row of rows) {
    const id = row.port_id;
    if (id === null || !listed.has(id)) {
      unattributed.push({ ...row.value, port_id: id });
      continue;
    }
    const filed = byPort.get(id);
    if (filed === undefined) byPort.set(id, [row.value]);
    else filed.push(row.value);
  }
  return { byPort, unattributed };
}

/** A read that produced rows, or the rejection that stopped it, kept whole. */
interface Read<T> {
  rows: T | null;
  reason: unknown;
}

/** One NVMe-oF subsystem, as the API surface in use types a row of it. */
type SubsystemRow = QueryEntity<ApiSurface['call'], 'nvmet.subsys.query'>;

/**
 * The subsystems, with a rejection kept as it arrived rather than reduced to
 * text.
 *
 * `attempt` is the right shape for every other read here and the wrong one for
 * this: whether this failure is raised or reported turns on what kind of
 * rejection it is, and `attempt` has already thrown that away by the time its
 * caller sees a `Failure`.
 *
 * The rows are named off the call through the client's own `QueryEntity` rather
 * than by importing the generated entity: the surface decides which version's
 * shape that is, and a regeneration that renames the interface does not reach
 * this file. It is a claim about what the middleware sends and not one this
 * tool acts on — every field below is still read through a guard, because a
 * declared type is not a received value.
 */
function readSubsystems(system: SystemHandle): Promise<Read<SubsystemRow[]>> {
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
    '`ports` are the addresses the system accepts NVMe-oF connections on, ' +
    'reported beside the subsystems rather than under them. `id` is the ' +
    "port's numeric identity and `index` the system's own ordinal for it — " +
    'different numbers, and neither follows the other. `transport` is `TCP`, ' +
    '`RDMA` or `FC` (the payload\'s `addr_trtype`), `address_family` `IPV4`, ' +
    '`IPV6` or `FC` (`addr_adrfam`), and `address` the address it listens on ' +
    '(`addr_traddr`). EITHER OF THE FIRST TWO IS NULL WHERE THE SYSTEM ' +
    'REPORTED NO VALUE OR ONE THIS CATALOG DOES NOT RECOGNISE, and those are ' +
    'not distinguished: the three values each can take are read off the oldest ' +
    'supported TrueNAS, so a later release adding a fourth reports null here ' +
    'rather than a word a caller cannot switch on — and a null transport is ' +
    'never a port carried over nothing. `service_id` is what it answers on (`addr_trsvcid`): a ' +
    'TCP port number on a TCP port and something else on an FC one, REPORTED ' +
    'AS THE SYSTEM SPELLED IT — as a number or as text — and never converted ' +
    'between the two, because the payload declares both and fixing one would ' +
    'assert a meaning it does not state. `enabled` is whether the port is ' +
    'switched on, and `enabled_reported` whether the system reported that field ' +
    'at all: false there means this TrueNAS does not report it, and A PORT THAT ' +
    'DID NOT REPORT `enabled` IS NOT A DISABLED PORT. True beside a null ' +
    '`enabled` means it reported something that could not be read as a boolean. ' +
    'A NULL `address` IS NOT EVIDENCE THAT A PORT LISTENS NOWHERE: the ' +
    'middleware accepts an empty address on a TCP or RDMA port, this catalog ' +
    'does not establish what an empty one means there, and an empty address and ' +
    'a field that could not be read are both reported as null. A port whose ' +
    '`transport` is `FC` is an NVMe-oF port carried over Fibre Channel, and ' +
    'THAT IS THE PORT\'S TRANSPORT AND NOT A STATEMENT ABOUT THE FC HARDWARE — ' +
    'the host adapters, the FC ports and their link state are `fc_list`, and ' +
    'nothing here reports them. This tool does not report a port\'s tuning ' +
    'fields — `inline_data_size`, `max_queue_size` and `pi_enable` — which the ' +
    'system carries and which say nothing about where it listens. ' +
    '`subsystems` on a port names which subsystems are published through it, ' +
    'each as the `subsystem_id` and `subsystem` name the join\'s own record ' +
    'spelled. THEY ARE WHAT THE PUBLICATION CLAIMED RATHER THAN A LOOKUP: an ' +
    'entry is reported here whether or not its `subsystem_id` answers to an ' +
    'entry in this result\'s top-level `subsystems` list, so a caller joining ' +
    'the two can find nothing under it — the reads are separate round trips, ' +
    'and a subsystem deleted between them leaves a publication naming it. Such ' +
    'an entry is KEPT, because dropping it would say the port publishes less ' +
    'than it does. An entry whose `subsystem_id` is null is a publication ' +
    'naming a subsystem this tool could not identify at all, and is kept for ' +
    'the same reason. WHERE THE JOIN DOES LAND, the top-level entry is where ' +
    'the NQN an initiator connects to is reported, rather than repeated here. ' +
    'AN EMPTY `subsystems` AND A NULL ONE ARE DIFFERENT ANSWERS: empty ' +
    'means the publications were read and none names this port, so nothing is ' +
    'reachable through it; null means they could not be read at all, or that ' +
    'this port carries no `id` for a publication to be joined on. AN EMPTY ' +
    '`ports` AND A NULL ONE ARE DIFFERENT ANSWERS in the same way: empty is a ' +
    'system with no NVMe-oF port configured, which is a system whose subsystems ' +
    'are unreachable however they are configured. NULL HAS TWO CAUSES, and ' +
    '`supported` is what separates them: where it is false the system has no ' +
    'NVMe-oF at all and nothing was read, so `failures` is empty; where it is ' +
    'true the port read failed, and `failures` names it. ' +
    '`failures` names each read that failed, as `source` — `namespaces`, ' +
    '`hosts`, `ports` or `port_subsystems` — and `error`, and is empty when all ' +
    'four were read. ' +
    '`unattributed_namespaces` and `unattributed_hosts` hold the rows that ' +
    'WERE read and could not be placed on any subsystem listed here. Each ' +
    'carries the `subsystem_id` and `subsystem` name its own record named, so ' +
    'what it claimed is visible: both are null where the record named neither, ' +
    'and `subsystem_id` is set where it named an id no subsystem here answers ' +
    'to. An entry in `unattributed_hosts` whose `hostnqn` is null is a grant ' +
    'naming no host to report, which is the one kind that names a subsystem ' +
    'and still cannot be listed under it. WHILE EITHER LIST IS NOT EMPTY THE ' +
    'PER-SUBSYSTEM `namespaces` AND `hosts` LISTS ARE INCOMPLETE, and an empty ' +
    'one there is not a subsystem with nothing on it. EACH list is empty when ' +
    'the read that would fill it failed, because nothing was read to place, ' +
    'and the other list is unaffected — `failures` names which read that was, ' +
    'and is also what tells a list that could not be read from one that could ' +
    'not be attributed. `unattributed_port_subsystems` holds publications that ' +
    'name a port not listed here, each carrying the `port_id` its record named ' +
    'and null where it named none. WHILE IT IS NOT EMPTY THE PER-PORT ' +
    '`subsystems` LISTS ARE INCOMPLETE, and an empty one there is not a port ' +
    'publishing nothing. Where the port read itself failed there is nothing to ' +
    'attribute against and every publication lands in it; where the ' +
    'PUBLICATION read failed it is EMPTY, because nothing was read to place, ' +
    'and every port\'s `subsystems` is null instead. This tool reads only ' +
    'NVMe-oF: iSCSI targets are `iscsi_list`, Fibre Channel host adapters and ' +
    'ports are `fc_list`, and SMB or NFS shares are ' +
    '`shares_list`. WHICH PORTS A SUBSYSTEM IS PUBLISHED ON IS READ FROM ' +
    '`ports[].subsystems` AND NOT FROM THE SUBSYSTEM ROW, which carries no port ' +
    'field: a subsystem named in no port\'s `subsystems` is one nothing ' +
    'publishes and so is not reachable over the network — but ONLY WHERE EVERY ' +
    'PUBLICATION WAS READ, PLACED AND IDENTIFIED, which is four conditions a ' +
    'caller has to check together: `failures` names neither `ports` nor ' +
    '`port_subsystems`, `unattributed_port_subsystems` is empty, and no ' +
    '`subsystems` entry anywhere carries a null `subsystem_id`. ANY ONE OF ' +
    'THOSE IS A PUBLICATION THAT COULD HAVE BEEN THIS SUBSYSTEM\'S, and the ' +
    'absence then establishes nothing.',
  inputSchema: { type: 'object', properties: {} },
  requiredRole: Role.ReadOnly,
  mutating: false,
  async handler({ system }) {
    // Every read is issued before any is awaited, so none waits on another, and
    // as in `iscsi_list` only the first is allowed to fail the tool: a namespace
    // and a host describe a subsystem, and with no subsystems there is nothing
    // for either to describe.
    const [subsystems, namespaces, hosts, ports, publications] = await Promise.all([
      readSubsystems(system),
      attempt('namespaces', () => readNamespaces(system)),
      attempt('hosts', () => readHosts(system)),
      // Caught like the other three, and for `iscsi_list`'s reason: a port is
      // where the service listens rather than a part of any one subsystem, so a
      // system whose ports did not read still has subsystems worth reporting.
      attempt('ports', () => readPorts(system)),
      attempt('port_subsystems', () => readPortSubsystems(system)),
    ]);

    if (subsystems.rows === null) {
      // Raised rather than reported unless the system said the method is not
      // there: "this system has no NVMe-oF" is a claim about the system, and a
      // denied or dropped read is evidence for no such claim.
      if (!isMissingMethod(subsystems.reason)) throw subsystems.reason;
      return {
        supported: false,
        unsupported_reason: errorText(subsystems.reason),
        subsystems: null,
        ports: null,
        // The other four reads fail the same way on such a system. Naming them
        // would report one absent feature five times, as five defects — and
        // no row was read, so nothing was left out of a list either.
        failures: [],
        unattributed_namespaces: [],
        unattributed_hosts: [],
        unattributed_port_subsystems: [],
      };
    }

    const failures: Failure<NvmeofSource>[] = [];
    if (namespaces.failure !== null) failures.push(namespaces.failure);
    if (hosts.failure !== null) failures.push(hosts.failure);
    if (ports.failure !== null) failures.push(ports.failure);
    if (publications.failure !== null) failures.push(publications.failure);

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

    // What a publication has to name to be filed under a port. Built from the
    // ports that were read: where the port read failed there is nothing to file
    // against, and every publication is reported unattributed instead — the
    // same shape `fc_list` gives an unattributable status row.
    const listedPorts = new Set(
      (ports.value ?? []).flatMap((port) => (port.id === null ? [] : [port.id])),
    );
    const published =
      publications.value === null ? null : attributePorts(publications.value, listedPorts);

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
      ports:
        ports.value === null
          ? null
          : ports.value.map((port) => ({
              ...port,
              // Null for a publication read that failed and for a port the
              // system did not number, which is what a publication is joined
              // on; an empty list for a read that succeeded and placed nothing
              // here.
              subsystems:
                published === null || port.id === null
                  ? null
                  : (published.byPort.get(port.id) ?? []),
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
      unattributed_port_subsystems: published?.unattributed ?? [],
    };
  },
};

/** Which of the three Fibre Channel reads failed. */
type FcSource = 'hosts' | 'ports' | 'port_status';

/**
 * One Fibre Channel host adapter.
 *
 * `wwpn` and `wwpn_b` are the two CONTROLLERS' port names on an HA appliance,
 * not two ports of one adapter: `wwpn` is this controller's and `wwpn_b` the
 * peer's, and a single-controller system carries none for a peer it does not
 * have. That is why both are reported and why the description says which is
 * which — an operator shown one null would otherwise read a correctly
 * configured adapter as half-configured.
 */
interface FcHost {
  id: number | null;
  alias: string | null;
  wwpn: string | null;
  wwpn_b: string | null;
  npiv: number | null;
  npiv_reported: boolean;
}

/**
 * The keys of an `fcport.status` row whose values this tool reports.
 *
 * **(unconfirmed) in its entirety.** `fcport.status` takes and answers open
 * records — `QueryFilters<Record<string, unknown>>` in, `unknown[]` out — so
 * unlike every other read in this file there is no declared shape to name
 * fields off, and no live system with FC hardware was available to read the real
 * keys from. These four are taken from what a Linux FC host publishes per port
 * (`/sys/class/fc_host/<host>/`), plus the port name the other two reads are
 * spelled with, and they are a considered guess rather than a reading.
 *
 * #98 is what makes the guess checkable instead of hidden: every key a row
 * actually carried whose value is not reported lands in `unreported_fields`,
 * built from the keys that PRODUCED A VALUE and never from this list. A wrong
 * key name and a right key over an unexpected value type then look different
 * from the outside, and the second is the likelier failure here — a status
 * record assembled from a sysfs tree sends numbers as text about as readily as
 * it sends them as numbers.
 */
const PORT_STATUS_KEYS = ['port', 'port_type', 'port_state', 'speed'] as const;

/** One row of `fcport.status`, read through the allowlist above. */
interface FcPortStatus {
  port: string | null;
  port_type: string | null;
  port_state: string | null;
  speed: string | null;
  unreported_fields: string[] | null;
}

/**
 * One status row, or a row of nulls for an entry that was not a record.
 *
 * An unreadable entry is KEPT rather than dropped, per #93's direction rule: the
 * per-port `status` lists are what a caller reads to find a link that is down,
 * so a list one entry shorter says a port reported nothing about its link when
 * what is true is that this tool could not read what it reported. It carries no
 * `port`, so it is reported beside the listing rather than under a port, and its
 * null `unreported_fields` is what tells it from a record that named no port.
 */
function readPortStatus(entry: unknown): FcPortStatus {
  const record = recordOrNull(entry);
  if (record === null) {
    return { port: null, port_type: null, port_state: null, speed: null, unreported_fields: null };
  }
  const read = {
    port: textOrNull(record['port']),
    port_type: textOrNull(record['port_type']),
    port_state: textOrNull(record['port_state']),
    speed: textOrNull(record['speed']),
  };
  return {
    ...read,
    unreported_fields: unreportedKeys(
      record,
      PORT_STATUS_KEYS.filter((key) => read[key] !== null),
    ),
  };
}

/** Status rows filed under the port each named, and the ones that could not be. */
interface StatusAttribution {
  byPort: Map<string, FcPortStatus[]>;
  unattributed: FcPortStatus[];
}

/**
 * The status rows filed under the port each named, where that names a port this
 * listing actually reports, and set aside where it does not.
 *
 * Set aside rather than dropped, for `attribute`'s reason one family over: a
 * dropped row leaves an empty `status` behind that says the port reported no
 * link state, which is a claim this read did not make. A row is set aside where
 * it named no readable `port` and where it named one no listed port answers to.
 *
 * The join is on the port NAME because that is the only field the two reads
 * plausibly share — and it is part of the same unconfirmed guess as the
 * allowlist above. Getting it wrong empties every `status` list and fills
 * `unattributed_status`, which is the one shape that says so rather than
 * reading as ports with nothing to report.
 */
function attributeStatus(rows: FcPortStatus[], listed: Set<string>): StatusAttribution {
  const byPort = new Map<string, FcPortStatus[]>();
  const unattributed: FcPortStatus[] = [];
  for (const row of rows) {
    if (row.port === null || !listed.has(row.port)) {
      unattributed.push(row);
      continue;
    }
    const filed = byPort.get(row.port);
    if (filed === undefined) byPort.set(row.port, [row]);
    else filed.push(row);
  }
  return { byPort, unattributed };
}

/**
 * Every host adapter the system reported.
 *
 * `npiv` is optional on the declared entity, so its null covers a release that
 * does not report the field at all as well as one that reported something this
 * tool could not read as a count. `npiv_reported` separates the first from the
 * second, which is #134's companion-field shape over the same `field?: T`
 * signature — `Object.hasOwn` and not `in`, which walks the prototype (#101).
 *
 * BOTH FIELDS READ THE ROW'S OWN KEY, and that pairing is the point rather than
 * a flourish. Plain property access walks the prototype too, so reading the
 * value that way beside a membership test that does not would let a non-null
 * `npiv` sit beside `npiv_reported: false` — a value presented as one the
 * system did not report. No JSON payload carries such a chain, which is exactly
 * why the two would be trusted to agree and never checked.
 */
async function readFcHosts(system: SystemHandle): Promise<FcHost[]> {
  const hosts = await firstValueFrom(system.client.api.query('fc.fc_host.query'));
  return hosts.map((host) => {
    const reported = Object.hasOwn(host, 'npiv');
    return {
      id: numberOrNull(host.id),
      alias: textOrNull(host.alias),
      wwpn: textOrNull(host.wwpn),
      wwpn_b: textOrNull(host.wwpn_b),
      npiv: reported ? numberOrNull(host.npiv) : null,
      npiv_reported: reported,
    };
  });
}

/**
 * One Fibre Channel port, and the iSCSI target it is mapped to reduced to that
 * target's id.
 *
 * `target` is an open record on the declared entity, so it is REDUCED rather
 * than forwarded (#102): a caller gets the one fact reading it establishes and
 * nothing a later release adds to that record reaches a tool result.
 * `target_mapped` is the companion that splits the reduction's null — a port
 * mapped to no target at all is a different answer from one whose target record
 * could not be read, and only the first says the port serves nothing.
 */
interface FcPort {
  id: number | null;
  port: string | null;
  wwpn: string | null;
  wwpn_b: string | null;
  target_mapped: boolean | null;
  target_id: number | null;
  status: FcPortStatus[] | null;
}

/** Every port the system reported, before any status row has been attributed. */
async function readFcPorts(system: SystemHandle): Promise<Omit<FcPort, 'status'>[]> {
  const ports = await firstValueFrom(system.client.api.query('fcport.query'));
  return ports.map((port) => {
    const target = port.target;
    const record = recordOrNull(target);
    return {
      id: numberOrNull(port.id),
      port: textOrNull(port.port),
      wwpn: textOrNull(port.wwpn),
      wwpn_b: textOrNull(port.wwpn_b),
      // Three answers rather than two: a record is a mapping, an explicit null
      // is the system saying there is none, and anything else established
      // neither — `recordOrNull` alone answers null for the last two alike,
      // which is the reading this field exists to separate (#102).
      target_mapped: record !== null ? true : target === null ? false : null,
      target_id: record === null ? null : numberOrNull(record['id']),
    };
  });
}

/** Every `fcport.status` row the system reported, each read through #98's allowlist. */
async function readPortStatuses(system: SystemHandle): Promise<FcPortStatus[]> {
  const rows = await firstValueFrom(system.client.api.call('fcport.status'));
  return rows.map(readPortStatus);
}

export const fcList: ReadOnlyTool = {
  name: 'fc_list',
  description:
    'Every Fibre Channel host adapter the system has, every FC port and the ' +
    'iSCSI target it is mapped to, and each port\'s link status. `hosts` are ' +
    'the adapters: `id` is the numeric identity, `alias` the label the adapter ' +
    'records for itself, and `npiv` the number of virtual ports configured on ' +
    'it. `npiv` ' +
    'IS OPTIONAL ON THIS PAYLOAD, so `npiv_reported` says whether the system ' +
    'reported the field at all — false means this TrueNAS does not report NPIV, ' +
    'while true beside a null `npiv` means it reported something that could not ' +
    'be read as a count. A reported `0` is a real count of none and is not ' +
    'either of those. `ports` are the FC ports: `id` is the numeric identity ' +
    'and `port` the port name, which is also what a `status` row names. ' +
    'THIS TOOL DOES NOT RELATE AN ADAPTER TO A PORT and offers no field that ' +
    'does: `hosts[].alias` and `ports[].port` are separate names the payloads ' +
    'report separately, nothing in the API says they are drawn from one ' +
    'namespace, and an adapter carrying NPIV virtual ports is precisely the ' +
    'case where they need not coincide. Matching them by text is a guess, and ' +
    'not one this tool makes on a caller\'s behalf. ' +
    '`wwpn` AND `wwpn_b` ON BOTH LISTS ARE UNDERSTOOD TO BE THE TWO ' +
    'CONTROLLERS OF AN HA PAIR rather than two ports of one adapter: `wwpn` is ' +
    'this controller\'s World Wide Port Name and `wwpn_b` its peer\'s. THAT ' +
    'READING IS NOT STATED BY THE API — both are plain nullable strings on the ' +
    'payload, which says nothing about what the `_b` names — so it is reported ' +
    'here as the reading it is. Under it, a single-controller appliance has no ' +
    'peer and a null `wwpn_b` there is the expected answer rather than a ' +
    'misconfiguration; but that is also what a system reporting no value sends, ' +
    'and nothing in this tool tells those two apart. `ha_status` is what says ' +
    'whether this system is an HA pair at all, and it is what a caller needs ' +
    'before reading anything into a null `wwpn_b`. ' +
    '`target_id` is the iSCSI target the port is mapped to, ' +
    'reduced to that target\'s identity and joinable against `iscsi_list`\'s ' +
    '`targets[].id`; the target\'s name and its extents are reported there and ' +
    'not here. `target_mapped` is whether the port named a target at all: false ' +
    'is a port mapped to nothing, which serves no data; true beside a null ' +
    '`target_id` is a mapping whose target this tool could not identify; and ' +
    'null is a field that was neither. `status` is what `fcport.status` said ' +
    'about that port, and it is THE ONLY READ HERE THAT SAYS WHETHER A LINK IS ' +
    'ACTUALLY UP — `port_state` is the system\'s own word for the link state, ' +
    '`port_type` the topology it negotiated, and `speed` the negotiated speed. ' +
    'THE FIELD NAMES IN A STATUS ROW ARE UNCONFIRMED: this read answers an open ' +
    'record the middleware declares nothing about, so the four names above are ' +
    'taken from what a Linux FC host publishes and have not been checked ' +
    'against a live system. `unreported_fields` names every key a row actually ' +
    'carried whose value is not reported here, so an allowlist that does not ' +
    'fit this system is visible rather than silent: the four fields all null ' +
    'beside a full `unreported_fields` is a wrong allowlist, and all null ' +
    'beside an EMPTY one is a row that genuinely carried nothing under those ' +
    'names. `unreported_fields` is null for an entry that was not a record at ' +
    'all, whose other fields are then all null for that reason. Values are ' +
    'reported ONLY AS TEXT, so a system sending a numeric `speed` reports null ' +
    'there and names `speed` in `unreported_fields`. AN EMPTY `status` AND A ' +
    'NULL ONE ARE DIFFERENT ANSWERS: empty means the status read succeeded and ' +
    'no row named this port. NULL HAS TWO CAUSES AND ONLY ONE OF THEM IS A ' +
    'FAILED READ — either the status read failed, which `failures` names, or ' +
    'this port carries a null `port` and so has no name for a status row to be ' +
    'joined on, which leaves `failures` empty. Read `port` and `failures` ' +
    'together to tell them apart. Neither says anything about the link. ' +
    '`hosts` and `ports` are null only in the first way. ' +
    '`unattributed_status` holds status rows that could not ' +
    'be placed on any port listed here — one naming a `port` no listed port ' +
    'answers to carries that name, one that named no readable port carries a ' +
    'null `port` beside a non-null `unreported_fields`, and one that was not a ' +
    'record at all carries null for both. WHILE IT IS NOT EMPTY THE PER-PORT ' +
    '`status` LISTS ARE INCOMPLETE. WHAT A FULL ONE RULES OUT IS PORTS WITH ' +
    'NOTHING TO REPORT — every row in it was read, and none was dropped. IT IS ' +
    'NOT A PARTITION BEYOND THAT and this tool does not offer one: a null ' +
    '`ports` says the port read failed and there was nothing to attribute ' +
    'against, but where `ports` was read the same shape covers a system whose ' +
    'status rows name ports it has not mapped, and a port-name join that does ' +
    'not hold on this system at all — and NOTHING HERE SEPARATES THOSE TWO. ' +
    'Comparing the `port` names in this list against `ports[].port` is what ' +
    'tells them apart, and it is the caller\'s to do. ' +
    '`failures` names each read that failed, as ' +
    '`source` — `hosts`, `ports` or `port_status` — and `error`, and is empty ' +
    'when all three were read. NONE OF THE THREE FAILS THE TOOL, so a system ' +
    'with no Fibre Channel hardware answers cleanly: it reports empty lists ' +
    'where the reads succeed and names them in `failures` where they do not. ' +
    'THERE IS NO `supported` FIELD AND NO CATALOG ANSWER TO "does this system ' +
    'have FC at all" — empty `hosts` and empty `ports` are the closest thing to ' +
    'one, and they do not distinguish an appliance with no FC hardware from one ' +
    'whose hardware is present and unconfigured. This tool reports ' +
    'CONFIGURATION AND LINK STATE AND NOT SESSIONS: the middleware exposes no ' +
    'FC equivalent of the iSCSI session list, so nothing here says which hosts ' +
    'are attached, and a port whose link is up may have nothing talking to it. ' +
    'It reads only Fibre Channel: iSCSI targets are `iscsi_list`, NVMe-oF ' +
    'subsystems are `nvmeof_list`, and SMB or NFS shares are `shares_list`.',
  inputSchema: { type: 'object', properties: {} },
  requiredRole: Role.ReadOnly,
  mutating: false,
  async handler({ system }) {
    // Every read is issued before any is awaited, so none waits on another —
    // and unlike the two tools above, ALL THREE are caught. There is no primary
    // read here: an adapter, a port and a link state are three separate facts
    // about a protocol rather than three parts of one entity, so no one of them
    // failing leaves the others with nothing to describe.
    const [hosts, ports, status] = await Promise.all([
      attempt('hosts', () => readFcHosts(system)),
      attempt('ports', () => readFcPorts(system)),
      attempt('port_status', () => readPortStatuses(system)),
    ]);

    const failures: Failure<FcSource>[] = [];
    if (hosts.failure !== null) failures.push(hosts.failure);
    if (ports.failure !== null) failures.push(ports.failure);
    if (status.failure !== null) failures.push(status.failure);

    // What a status row has to name to be filed under a port. Built from the
    // ports that were read: where the port read itself failed there is nothing
    // to file against, and every status row is reported unattributed instead.
    const listed = new Set(
      (ports.value ?? []).flatMap((port) => (port.port === null ? [] : [port.port])),
    );
    const attributed = status.value === null ? null : attributeStatus(status.value, listed);

    return {
      hosts: hosts.value,
      ports:
        ports.value === null
          ? null
          : ports.value.map((port) => ({
              ...port,
              // Null for a read that failed and for a port the system did not
              // name, which is what a status row is joined on; an empty list
              // for a read that succeeded and placed nothing here.
              status:
                attributed === null || port.port === null
                  ? null
                  : (attributed.byPort.get(port.port) ?? []),
            })),
      failures,
      // Named for the concept the two tools above already use: an entity that
      // was read and could not be placed under the thing it named.
      unattributed_status: attributed?.unattributed ?? [],
    };
  },
};

/**
 * `iscsi_target_create` and `iscsi_target_update`: making one iSCSI target, and
 * changing an existing one's name, alias, portal groups and authorised networks.
 *
 * TWO TOOLS AND NOT ONE, for the reason the share pairs are two (#183, #184): a
 * create says what the new target will and will not serve; an update names each
 * value beside the one it replaces.
 *
 * A GROUP IS THREE REFERENCES, AND EACH IS RESOLVED AT PLAN TIME. `portal` and
 * `initiator` are ROW IDS into `iscsi.portal` and `iscsi.initiator`; `auth` is a
 * CHAP credential TAG in `iscsi.auth`, not a row id — several credentials can
 * share one tag, and the middleware validates `auth` by querying on `tag`.
 * That reading is from the TrueNAS implementation rather than the API surface,
 * which types all three as bare numbers. A reference that does not resolve
 * fails the plan naming its table, and every resolved one is named in human
 * terms: an approver cannot check a number.
 *
 * A CHAP CREDENTIAL ROW CARRIES `secret` AND `peersecret`, and is read through
 * an allowlist of `tag` and `user` and nothing else (#97, #100). Nothing that
 * reaches a plan or a result is built from the row itself.
 *
 * ACCESS IS STATED IN WORDS, NEVER LEFT TO A NULL. `initiator: null` admits any
 * initiator, `authmethod: NONE` is no CHAP, and an empty `auth_networks` is
 * read here as unrestricted — each one reads as "restricted" to an approver
 * who sees nothing, which is #154's costly direction.
 *
 * THE RESOLUTION READS ARE PLAN-TIME ONLY AND NOT STEPS (#119), and so is
 * `iscsi.target.validate_name`: `execute` makes none of them. The confirmation
 * token binds the arguments, and the ids are the arguments, so what runs is
 * the call the plan named; a portal deleted between the two is the
 * middleware's to refuse.
 *
 * THE ROLE IS `Role.Sharing`, with `share_set_enabled`'s caveat: that the
 * sharing-admin role grants `iscsi.target.create` and `iscsi.target.update` is
 * (unconfirmed) against a live system's `privilege.roles`.
 */

/** The authentication methods a group accepts. */
const ISCSI_AUTHMETHODS = ['NONE', 'CHAP', 'CHAP_MUTUAL'] as const;
type IscsiAuthmethod = (typeof ISCSI_AUTHMETHODS)[number];

/** One portal group as sent: the keys passed, in this order and no others. */
interface TargetGroup {
  portal: number;
  initiator?: number | null;
  authmethod?: IscsiAuthmethod;
  auth?: number | null;
}

/** The keys a group may carry, in the order a parsed group holds them. */
const GROUP_KEYS = ['portal', 'initiator', 'authmethod', 'auth'] as const;

/** The settings both tools send. Every one is optional on update. */
type TargetFields = {
  name?: string;
  alias?: string | null;
  groups?: TargetGroup[];
  auth_networks?: string[];
};

/** The order the plan states the fields in, which is the schema's. */
const TARGET_FIELDS = ['name', 'alias', 'groups', 'auth_networks'] as const;

/** Why `mode` and `iscsi_parameters` are refused, worded once for both tools. */
const TARGET_REFUSED =
  "a target's mode and its iSCSI parameters are out of this tool's scope; a target is created " +
  'with mode ISCSI';

/** The one mode this catalog creates a target with. */
const ISCSI_MODE = 'ISCSI' as const;

function isWholeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}

/**
 * The groups as sent, refused whole where any entry is not one. An unknown key
 * inside a group is refused rather than dropped, for `refuseArgs`'s reason: a
 * key silently dropped reads as applied.
 */
function parseGroups(value: unknown): TargetGroup[] {
  if (!Array.isArray(value)) {
    throw new Error('"groups" must be a list of { portal, initiator, authmethod, auth }');
  }
  return value.map((entry, index) => {
    const at = `"groups[${index}]`;
    const group = recordOrNull(entry);
    if (group === null) throw new Error(`${at}" must be an object`);
    const stray = Object.keys(group).find((key) => !(GROUP_KEYS as readonly string[]).includes(key));
    if (stray !== undefined) {
      throw new Error(`${at}.${stray}" is not accepted: a group takes ${GROUP_KEYS.join(', ')}`);
    }
    const portal = group['portal'];
    if (!isWholeNumber(portal)) {
      throw new Error(`${at}.portal" is required and must be a whole number: a portal's id`);
    }
    const parsed: TargetGroup = { portal };
    const initiator = group['initiator'];
    if (initiator !== undefined) {
      if (initiator !== null && !isWholeNumber(initiator)) {
        throw new Error(`${at}.initiator" must be an initiator group's id, or null for any initiator`);
      }
      parsed.initiator = initiator;
    }
    const authmethod = group['authmethod'];
    if (authmethod !== undefined) {
      if (!(ISCSI_AUTHMETHODS as readonly unknown[]).includes(authmethod)) {
        throw new Error(`${at}.authmethod" must be one of ${ISCSI_AUTHMETHODS.join(', ')}`);
      }
      parsed.authmethod = authmethod as IscsiAuthmethod;
    }
    const auth = group['auth'];
    if (auth !== undefined) {
      if (auth !== null && !isWholeNumber(auth)) {
        throw new Error(`${at}.auth" must be a CHAP credential's tag, or null for none`);
      }
      parsed.auth = auth;
    }
    // The middleware refuses CHAP with no credential, so the plan does too
    // rather than promising a call that will be rejected (#161).
    if (parsed.authmethod !== undefined && parsed.authmethod !== 'NONE' && (parsed.auth ?? null) === null) {
      throw new Error(`${at}.auth" is required where authmethod is ${parsed.authmethod}: a CHAP credential's tag`);
    }
    return parsed;
  });
}

/**
 * The target settings, each validated where it was passed and left out where
 * it was not, in the schema's order — so the record is exactly what is sent.
 */
function parseTargetFields(args: Record<string, unknown>): TargetFields {
  refuseArgs(args, ['mode', 'iscsi_parameters'], TARGET_REFUSED);
  const fields: TargetFields = {};
  const name = args['name'];
  if (name !== undefined) {
    if (textOrNull(name) === null) throw new Error('"name" must be a non-empty string');
    fields.name = name as string;
  }
  const alias = args['alias'];
  if (alias !== undefined) {
    // Null is how an alias is cleared; an empty one is refused rather than read
    // as null, so a caller who meant one is not told the other happened.
    if (alias !== null && textOrNull(alias) === null) {
      throw new Error('"alias" must be a non-empty string, or null for no alias');
    }
    fields.alias = alias as string | null;
  }
  if (args['groups'] !== undefined) fields.groups = parseGroups(args['groups']);
  const networks = args['auth_networks'];
  if (networks !== undefined) {
    if (!Array.isArray(networks) || !networks.every((entry) => textOrNull(entry) !== null)) {
      throw new Error('"auth_networks" must be a list of networks in CIDR form, such as "10.0.0.0/24"');
    }
    fields.auth_networks = networks as string[];
  }
  return fields;
}

/** What `iscsi_target_create` was asked to do. */
type TargetCreateArgs = TargetFields & { name: string };

/** What `iscsi_target_create` sends: the settings passed, with mode ISCSI. */
type TargetCreate = TargetCreateArgs & { mode: typeof ISCSI_MODE };

/** The create's arguments, without the mode it adds — which it would refuse. */
function parseTargetCreateArgs(args: Record<string, unknown>): TargetCreateArgs {
  const fields = parseTargetFields(args);
  if (fields.name === undefined) throw new Error('"name" is required');
  return { ...fields, name: fields.name };
}

function parseTargetCreate(args: Record<string, unknown>): TargetCreate {
  return { ...parseTargetCreateArgs(args), mode: ISCSI_MODE };
}

/** What `iscsi_target_update` was asked to do. */
interface TargetUpdate {
  id: number;
  fields: TargetFields;
}

function parseTargetUpdate(args: Record<string, unknown>): TargetUpdate {
  const fields = parseTargetFields(args);
  const id = args['id'];
  if (!isWholeNumber(id)) throw new Error('"id" is required and must be a whole number');
  if (Object.keys(fields).length === 0) {
    throw new Error(`Nothing to change: pass at least one of ${TARGET_FIELDS.join(', ')}`);
  }
  return { id, fields };
}

/** One group as these tools report it off a target row. */
interface TargetGroupRow {
  portal: number;
  initiator: number | null;
  authmethod: string | null;
  auth: number | null;
}

/**
 * A target's groups, all of them or none. Null where the field was not a list,
 * AND where any one group could not be read — #93's direction: a group list one
 * entry shorter says the target is not published through that portal, and a
 * group whose `initiator` would not read cannot be told from one admitting any
 * initiator, which is the reading that costs. An absent `initiator` or `auth`
 * is read as null, which is what the system stores for none.
 */
function readGroups(value: unknown): TargetGroupRow[] | null {
  if (!Array.isArray(value)) return null;
  const groups: TargetGroupRow[] = [];
  for (const entry of value) {
    const group = recordOrNull(entry);
    const portal = numberOrNull(group?.['portal']);
    const initiator = group?.['initiator'] ?? null;
    const auth = group?.['auth'] ?? null;
    const authmethod = group?.['authmethod'] ?? null;
    if (
      portal === null ||
      (initiator !== null && numberOrNull(initiator) === null) ||
      (auth !== null && numberOrNull(auth) === null) ||
      (authmethod !== null && textOrNull(authmethod) === null)
    ) {
      return null;
    }
    groups.push({
      portal,
      initiator: initiator as number | null,
      authmethod: authmethod as string | null,
      auth: auth as number | null,
    });
  }
  return groups;
}

/**
 * An iSCSI target as these tools report it, field by field. `iscsi_parameters`
 * and `rel_tgt_id` are not reported: the first is out of these tools' scope
 * and the second is the system's own bookkeeping.
 */
interface TargetRow {
  id: number | null;
  name: string | null;
  alias: string | null;
  mode: string | null;
  groups: TargetGroupRow[] | null;
  auth_networks: string[] | null;
}

function targetRow(row: Record<string, unknown>): TargetRow {
  return {
    id: numberOrNull(row['id']),
    name: textOrNull(row['name']),
    alias: textOrNull(row['alias']),
    mode: textOrNull(row['mode']),
    groups: readGroups(row['groups']),
    // Whole or not at all: a network list one entry shorter is a narrower
    // restriction than the one the target holds.
    auth_networks: strictTextList(row['auth_networks']),
  };
}

/**
 * An alias as stored: the alias, `''` where the target has none — which the
 * system may spell as null or as an empty string — and null where it could not
 * be read. #184's `storedMapping`, for the same reason: a cleared alias could
 * otherwise never be confirmed.
 */
function storedAlias(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return '';
  return typeof value === 'string' ? value : null;
}

/** What `agreement` compares a group list as, where the comparison holds. */
const AS_SENT = 'as sent';

/**
 * Whether a stored group list holds the groups sent, in order: false where a
 * group is missing, extra or differs in a key that was SENT, null where the
 * stored list could not be read, true otherwise. A key a group did not send is
 * the system's to fill and is not compared.
 */
function groupsMatch(sent: TargetGroup[], stored: TargetGroupRow[] | null): boolean | null {
  if (stored === null) return null;
  if (stored.length !== sent.length) return false;
  return sent.every((group, index) =>
    GROUP_KEYS.every((key) => group[key] === undefined || group[key] === stored[index][key]),
  );
}

/** What a request sent, in the terms {@link targetComparable} reads a row in. */
function targetSent(fields: TargetFields & { mode?: string }): Record<string, string | null> {
  return Object.fromEntries(
    Object.entries(fields).map(([key, value]) => [
      key,
      key === 'groups' ? AS_SENT : key === 'auth_networks' ? JSON.stringify(value) : ((value as string | null) ?? ''),
    ]),
  );
}

/**
 * A row's values for the fields sent, as {@link agreement} compares them
 * against {@link targetSent}: a list of networks by its exact spelling, the
 * alias through {@link storedAlias}, and the groups as whether they hold the
 * groups sent.
 */
function targetComparable(
  raw: Record<string, unknown>,
  fields: TargetFields & { mode?: string },
): Record<string, string | null> {
  const row = targetRow(raw);
  return Object.fromEntries(
    Object.keys(fields).map((key) => {
      if (key === 'alias') return [key, storedAlias(raw['alias'])];
      if (key === 'groups') {
        const match = groupsMatch(fields.groups ?? [], row.groups);
        return [key, match === null ? null : match ? AS_SENT : 'different'];
      }
      if (key === 'auth_networks') return [key, row.auth_networks === null ? null : JSON.stringify(row.auth_networks)];
      return [key, row[key as 'name' | 'mode']];
    }),
  );
}

/** Two readings of a target, for the fields sent, compared as themselves. */
function targetReading(raw: Record<string, unknown>, keys: readonly string[]): Record<string, string | null> {
  const row = targetRow(raw);
  return Object.fromEntries(
    keys.map((key) => {
      if (key === 'alias') return [key, storedAlias(raw['alias'])];
      const value = row[key as keyof TargetRow];
      return [key, value === null ? null : typeof value === 'string' ? value : JSON.stringify(value)];
    }),
  );
}

/** One field as the target holds it now, as a plan states it. */
function storedTargetValue(raw: Record<string, unknown>, key: string): string {
  if (key === 'alias') {
    const alias = storedAlias(raw['alias']);
    return alias === '' ? 'null' : alias === null ? NONE_REPORTED : JSON.stringify(alias);
  }
  const value = targetRow(raw)[key as keyof TargetRow];
  return value === null ? NONE_REPORTED : JSON.stringify(value);
}

/**
 * A CHAP credential as a plan may name it: its tag and its user, and nothing
 * else. THIS IS THE CREDENTIAL BOUNDARY — the row carries `secret` and
 * `peersecret`, and only these two keys are ever read off it.
 */
interface ChapLabel {
  tag: number | null;
  user: string | null;
}

/** A portal as a plan names it: its tag, its comment and where it listens. */
function portalLabel(row: Record<string, unknown>): string {
  const listen = Array.isArray(row['listen'])
    ? row['listen'].map((entry) => {
        const held = recordOrNull(entry);
        const ip = textOrNull(held?.['ip']);
        const port = numberOrNull(held?.['port']);
        const where = `${ip ?? NONE_REPORTED}:${port ?? NONE_REPORTED}`;
        // The wildcard reads as a placeholder and is the opposite (#138).
        return ip === '0.0.0.0'
          ? `${where} (every IPv4 address)`
          : ip === '::'
            ? `${where} (every IPv6 address)`
            : where;
      })
    : null;
  const comment = textOrNull(row['comment']);
  return (
    `tag ${numberOrNull(row['tag']) ?? NONE_REPORTED}` +
    `${comment === null ? '' : `, "${comment}"`}, listening on ` +
    `${listen === null ? NONE_REPORTED : listen.length === 0 ? 'no address' : listen.join(', ')}`
  );
}

/** One table a group refers into, read once per plan and only where needed. */
interface Lookup {
  table: string;
  rows: unknown[] | null;
  error: string | null;
}

async function readTable(read: () => Promise<unknown>, table: string): Promise<Lookup> {
  try {
    const rows = await read();
    return Array.isArray(rows)
      ? { table, rows, error: null }
      : { table, rows: null, error: `${table}.query did not answer with a list` };
  } catch (reason) {
    return { table, rows: null, error: `${table}.query failed: ${errorText(reason)}` };
  }
}

/** Why a reference could not be resolved, naming the table it was looked up in. */
function unresolved(at: string, what: string, lookup: Lookup, hint: string): Error {
  return new Error(
    lookup.error === null
      ? `${at}: no ${what} in ${lookup.table} on this system — ${hint}`
      : `${at}: ${what} could not be resolved, because ${lookup.error}`,
  );
}

/**
 * Every group sent, resolved against the tables it names and described in
 * words — or a refusal naming the first reference that does not resolve.
 *
 * Each table is read only where some group refers into it, and once. A table
 * that could not be read fails the plan exactly as a missing row does: the
 * plan cannot name what it cannot read, and an approver shown a bare id is
 * approving something they cannot check.
 */
async function groupsSentence(ctx: ToolContext, groups: TargetGroup[]): Promise<string> {
  if (groups.length === 0) {
    return (
      ' IT NAMES NO PORTAL GROUP; whether a target with none is reachable through any portal is ' +
      '(unconfirmed), and `iscsi_list` reports the portals this system has.'
    );
  }
  const api = ctx.system.client.api;
  const tables = new Map<string, Promise<Lookup>>();
  const table = (name: string, read: () => Promise<unknown>): Promise<Lookup> => {
    let lookup = tables.get(name);
    if (lookup === undefined) {
      lookup = readTable(read, name);
      tables.set(name, lookup);
    }
    return lookup;
  };
  const tableOf: Tables = {
    portals: () => table('iscsi.portal', () => firstValueFrom(api.query('iscsi.portal.query'))),
    initiators: () => table('iscsi.initiator', () => firstValueFrom(api.query('iscsi.initiator.query'))),
    auths: () => table('iscsi.auth', () => firstValueFrom(api.query('iscsi.auth.query'))),
  };
  const parts: string[] = [];
  for (const [index, group] of groups.entries()) {
    const at = `groups[${index}]`;
    const portals = await tableOf.portals();
    const portal = rowWithId(portals.rows, group.portal);
    if (portal === null) {
      throw unresolved(`${at}.portal`, `portal with id ${group.portal}`, portals, "ids come from `iscsi_list`'s portals");
    }
    parts.push(
      `through portal id ${group.portal} (${portalLabel(portal)}): ` +
        `${await initiatorPhrase(group, tableOf, at)}; ${await authPhrase(group, tableOf, at)}`,
    );
  }
  return ` It is published ${parts.join('; and ')}.`;
}

/** The three tables a group refers into, each read at most once per plan. */
interface Tables {
  portals: () => Promise<Lookup>;
  initiators: () => Promise<Lookup>;
  auths: () => Promise<Lookup>;
}

/** Who a group admits, in words. */
async function initiatorPhrase(group: TargetGroup, tables: Tables, at: string): Promise<string> {
  const id = group.initiator;
  if (id === undefined) {
    return (
      'initiator not sent, so the system decides which initiators it admits, which is not read ' +
      'here — (unconfirmed) that this is any initiator'
    );
  }
  if (id === null) return 'ANY INITIATOR MAY CONNECT (initiator null)';
  const lookup = await tables.initiators();
  const row = rowWithId(lookup.rows, id);
  if (row === null) {
    throw unresolved(`${at}.initiator`, `initiator group with id ${id}`, lookup, 'the system lists its initiator groups there');
  }
  const comment = textOrNull(row['comment']);
  const names = strictTextList(row['initiators']);
  const label = `initiator group id ${id}${comment === null ? '' : ` ("${comment}")`}`;
  if (names === null) return `${label}, whose initiator list could not be read, so who it admits is not established`;
  if (names.length === 0) {
    return `${label}, which lists no initiator — read here as admitting ANY initiator, which is (unconfirmed)`;
  }
  return `only the initiators ${label} lists: ${names.map((name) => `"${name}"`).join(', ')}`;
}

/** What authentication a group asks for, in words. */
async function authPhrase(group: TargetGroup, tables: Tables, at: string): Promise<string> {
  const method = group.authmethod;
  const credential = await chapPhrase(group.auth, tables, at);
  if (method === undefined) {
    return (
      `authmethod not sent, so the system's default applies, which is not read here — ` +
      `(unconfirmed) that this is NONE, no CHAP${credential}`
    );
  }
  if (method === 'NONE') return `NO CHAP (authmethod NONE)${credential}`;
  return `${method === 'CHAP' ? 'CHAP' : 'mutual CHAP'} required${credential}`;
}

/**
 * The CHAP credentials a group's `auth` tag names, by tag and user, or nothing
 * where it names none. Matched on TAG, not id: several credential rows can
 * share one tag, and the middleware validates `auth` against the tag.
 */
async function chapPhrase(tag: number | null | undefined, tables: Tables, at: string): Promise<string> {
  if (!isWholeNumber(tag)) return '';
  const lookup = await tables.auths();
  const labels: ChapLabel[] = (lookup.rows ?? []).flatMap((entry) => {
    const held = recordOrNull(entry);
    if (held === null || numberOrNull(held['tag']) !== tag) return [];
    return [{ tag, user: textOrNull(held['user']) }];
  });
  if (labels.length === 0) {
    throw unresolved(`${at}.auth`, `CHAP credential with tag ${tag}`, lookup, 'it is matched on `tag`, not `id`');
  }
  return (
    ` with CHAP credential tag ${tag} ` +
    `(${labels.map((label) => `user ${label.user === null ? NONE_REPORTED : `"${label.user}"`}`).join(', ')})`
  );
}

/** Which networks initiators may connect from, in words, given what is sent. */
function networksSentence(networks: string[] | undefined): string {
  if (networks === undefined) {
    return (
      ' `auth_networks` is not sent, so the system decides which networks initiators may connect ' +
      'from; (unconfirmed) that this is none, which is read here as any network.'
    );
  }
  if (networks.length === 0) {
    return (
      ' `auth_networks` IS EMPTY, WHICH IS READ HERE AS INITIATORS FROM ANY NETWORK MAY CONNECT — ' +
      'not as nobody; that empty means unrestricted is (unconfirmed).'
    );
  }
  return ` Only initiators connecting from ${networks.map((network) => `"${network}"`).join(', ')} may connect.`;
}

/**
 * What the system's own name check said, which is a refusal where it names a
 * problem. Plan-time only and not a step (#119). A check that could not be
 * called is stated, never read as either answer.
 */
async function nameCheckSentence(ctx: ToolContext, name: string, id: number | null): Promise<string> {
  let answer: unknown;
  try {
    answer = await firstValueFrom(
      ctx.system.client.api.call('iscsi.target.validate_name', id === null ? [name] : [name, id]),
    );
  } catch (reason) {
    return (
      " The system's own name check (iscsi.target.validate_name) could not be called " +
      `(${isMissingMethod(reason) ? 'this system has no such method' : errorText(reason)}), so it was not run.`
    );
  }
  if (typeof answer === 'string' && answer.length > 0) {
    throw new Error(`The system refuses the target name "${name}": ${answer}`);
  }
  if (answer !== null) {
    return (
      " The system's own name check (iscsi.target.validate_name) answered with nothing this tool " +
      'could read, so whether it accepts the name is not established.'
    );
  }
  return (
    " The system's own name check (iscsi.target.validate_name) accepted the name; what that " +
    'check covers is (unconfirmed).'
  );
}

/** What both plans say about where a target's portal relationship can be seen. */
const GROUPS_UNLISTED =
  ' `iscsi_list` does not report a target\'s groups, so which portal serves this target is ' +
  "visible in this tool's own result and not in that listing.";

/** The JSON schema for each target setting, shared by both tools. */
const TARGET_FIELD_SCHEMA = {
  alias: {
    oneOf: [{ type: 'string' }, { type: 'null' }],
    description: 'A label for the target. null for none, which clears it on update.',
  },
  groups: {
    type: 'array',
    description:
      'The portal groups the target is published through. Each names a portal by its `id`, an ' +
      'initiator group by its `id` (null for ANY initiator), an `authmethod`, and a CHAP ' +
      'credential by its `tag` — NOT its id — in `auth`.',
    items: {
      type: 'object',
      properties: {
        portal: { type: 'integer', description: "A portal's `id`, as `iscsi_list` reports it." },
        initiator: {
          oneOf: [{ type: 'integer' }, { type: 'null' }],
          description: "An initiator group's `id`; null admits ANY initiator.",
        },
        authmethod: {
          type: 'string',
          enum: [...ISCSI_AUTHMETHODS],
          description: 'NONE is no CHAP; CHAP and CHAP_MUTUAL require `auth`.',
        },
        auth: {
          oneOf: [{ type: 'integer' }, { type: 'null' }],
          description: "A CHAP credential's `tag`, which several credentials may share. null for none.",
        },
      },
      required: ['portal'],
    },
  },
  auth_networks: {
    type: 'array',
    items: { type: 'string' },
    description:
      'Networks, in CIDR form, initiators may connect from. Empty is read as ANY network, which ' +
      'is (unconfirmed).',
  },
} as const;

const TARGET_ROW_FIELDS =
  '`id`, which is what `iscsi_target_update` takes; `name`; `alias`, null where the target has ' +
  'none AND where it could not be read; `mode`; `groups`, each `portal` and `initiator` an id ' +
  'and `auth` a CHAP credential TAG, with `initiator` null meaning ANY initiator, and the whole ' +
  'list null where any group could not be read, which is not evidence of either; and ' +
  '`auth_networks`, null where it could not be read whole. A target\'s iSCSI parameters are not ' +
  'reported. Every other field is null where the response stated no value this tool could read.';

const TARGET_CREATE_GUIDANCE =
  '`requested` is exactly what was sent. `target` is the created target read back off the ' +
  'response the create itself answered with — never copied from the request — or null where ' +
  `that response was not a record. Its fields are ${TARGET_ROW_FIELDS} ` +
  '`confirmed` is whether `target` holds every value sent: true is the system reporting back ' +
  'what was asked for; FALSE IS NOT A SUCCESS — the call did not reject and at least one value ' +
  'was stored as something else, the networks compared exactly as spelled and in order and the ' +
  'groups in order, on the keys each group sent; and null is a response in which some value ' +
  'sent could not be read back and none read back as different. A null `target` means nothing ' +
  'here establishes that a target was created, and is not evidence that none was — `iscsi_list` ' +
  'shows what the system now holds.';

export const iscsiTargetCreate: MutatingTool = {
  name: 'iscsi_target_create',
  description:
    'Creates one iSCSI target on this TrueNAS system, served over iSCSI. Two-phase: called ' +
    'without a confirmation_token it returns a plan for user approval; called with one it ' +
    'creates the target. `name` is required; `alias`, `groups` and `auth_networks` are ' +
    'optional, and the system decides any that are not passed. `mode` is not taken — the ' +
    'target is created with mode ISCSI — and `mode` and `iscsi_parameters` are refused. EVERY ' +
    'PORTAL, INITIATOR GROUP AND CHAP CREDENTIAL A GROUP NAMES IS RESOLVED WHEN THE PLAN IS ' +
    'MADE, and one that does not resolve fails the plan, naming the table; `auth` is a CHAP ' +
    "credential's TAG, not its id. THE PLAN SAYS IN WORDS WHO MAY CONNECT: `initiator` null is " +
    'ANY INITIATOR, `authmethod` NONE is no CHAP, and an empty `auth_networks` is read as any ' +
    "network. A CHAP credential is named by its tag and user only; its secrets are never read " +
    "into a plan or a result. The system's own name check runs at plan time where it can. A " +
    'NEW TARGET HAS NO EXTENT MAPPED AND SERVES NO STORAGE: no tool in this catalog maps an ' +
    "extent, and `iscsi_list` reports a target's extents once one is mapped. `iscsi_list` does " +
    "not report a target's groups. `destructiveness` is `reversible`, but NO TOOL IN THIS " +
    'CATALOG DELETES AN iSCSI TARGET: undoing this means deleting it outside this catalog. ' +
    TARGET_CREATE_GUIDANCE,
  resultGuidance: TARGET_CREATE_GUIDANCE,
  inputSchema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'The target name; the IQN initiators connect to is built from it.',
      },
      ...TARGET_FIELD_SCHEMA,
    },
    required: ['name'],
  },
  requiredRole: Role.Sharing,
  mutating: true,
  // Additive: the target is a new row and nothing existing is removed. What it
  // admits is stated in the plan rather than recorded here.
  destructiveness: 'reversible',
  normalizeArgs(rawArgs) {
    return parseTargetCreateArgs(rawArgs);
  },
  async plan(ctx, rawArgs): Promise<PlanStep[]> {
    const body = parseTargetCreate(rawArgs);
    const named = await nameCheckSentence(ctx, body.name, null);
    const groups =
      body.groups === undefined
        ? ' `groups` is not sent, so the target is created with whatever groups the system defaults to, which is (unconfirmed) none.'
        : await groupsSentence(ctx, body.groups);
    const unsent = TARGET_FIELDS.filter((key) => key !== 'name' && body[key] === undefined);
    const defaults =
      unsent.length === 0
        ? ''
        : ` Not sent, and so left to the system's defaults, which are not read here: ${unsent.join(', ')}.`;
    return [
      {
        method: 'iscsi.target.create',
        params: [body],
        description:
          `Create an iSCSI target, ${Object.entries(body)
            .map(([key, value]) => `${key} ${JSON.stringify(value)}`)
            .join(', ')}.${named}${groups}${networksSentence(body.auth_networks)}` +
          ' A NEW TARGET HAS NO EXTENT MAPPED AND SERVES NO STORAGE: no tool in this catalog maps ' +
          "an extent onto it, and `iscsi_list` reports a target's extents once one is mapped." +
          `${GROUPS_UNLISTED}${defaults}`,
      },
    ];
  },
  async execute(ctx, rawArgs) {
    const body = parseTargetCreate(rawArgs);
    // The resolution and the name check are the plan's and are not made again
    // here, as `nfs_share_create`'s path check is not.
    const created: unknown = await firstValueFrom(ctx.system.client.api.call('iscsi.target.create', [body]));
    const held = recordOrNull(created);
    return {
      requested: body,
      target: held === null ? null : targetRow(held),
      confirmed: held === null ? null : agreement(targetSent(body), targetComparable(held, body)),
    };
  },
};

const TARGET_UPDATE_GUIDANCE =
  '`requested` is exactly what was sent. `previous` is the target as read immediately before ' +
  'the call, and `resulting` is the target read back off the response the update itself ' +
  'answered with — never copied from the request. Both carry the fields `iscsi_target_create` ' +
  'reports; `previous` is null where that read failed or listed no such target, and ' +
  '`resulting` is null where the response was not a record. `changes` names each field that ' +
  'was SENT, as `requested`, `before` (off `previous`) and `after` (off `resulting`), and ' +
  '`before` or `after` is null wherever the reading behind it is — or, for `alias`, where the ' +
  'target has none. `lookup` says what the read did: `FOUND`, `NOT_FOUND` (deleted between the ' +
  'plan and the confirmation), or `UNREADABLE` with `lookup_error` naming why; THE UPDATE IS ' +
  'ATTEMPTED IN ALL THREE CASES, because what runs must be what was approved. `changed` is true ' +
  'where the target before and after differ in one of the sent fields and false where they ' +
  'agree in all, WHICH IS TWO OUTCOMES AND NOT ONE: the target already held those values, or ' +
  'the call did not apply. `confirmed` is what tells those apart, and `changed` must not be ' +
  'read without it. `confirmed` is whether `resulting` holds every value sent: true is the ' +
  'system reporting back what was asked for; FALSE IS NOT A SUCCESS — the call did not reject ' +
  'and at least one value was stored as something else, the networks compared exactly as ' +
  'spelled and in order and the groups in order, on the keys each group sent; null is a ' +
  'response in which some value sent could not be read back and none read back as different. ' +
  'Both are null wherever a reading they need is missing.';

export const iscsiTargetUpdate: MutatingTool = {
  name: 'iscsi_target_update',
  description:
    "Changes one existing iSCSI target's `name`, `alias`, `groups` or `auth_networks` on this " +
    'TrueNAS system. Two-phase: called without a confirmation_token it returns a plan for user ' +
    "approval; called with one it sends the change. `id` is the target's id as `iscsi_list` " +
    'reports it; PLANNING AGAINST AN id NO iSCSI TARGET HAS FAILS, naming it. ONLY THE FIELDS ' +
    'PASSED ARE SENT, and at least one is required; `alias` passed as null clears it. `mode` and ' +
    '`iscsi_parameters` are refused, and the plan states the target\'s mode where it is not ISCSI. ' +
    '`groups` REPLACES THE WHOLE LIST, and the plan shows it whole beside the list it replaces; ' +
    'every portal, initiator group and CHAP credential it names is resolved when the plan is ' +
    "made, as `iscsi_target_create` resolves them, `auth` being a CHAP credential's TAG. THE " +
    'PLAN STATES EACH VALUE SENT BESIDE THE ONE THE TARGET HOLDS NOW, so the call that undoes it ' +
    'is in the plan, AND SAYS IN WORDS WHO MAY CONNECT through the groups and networks it sends. ' +
    'RENAMING A TARGET CHANGES THE IQN INITIATORS CONNECT TO, so initiators configured with the ' +
    'old name will no longer find it. SENDING A TARGET A VALUE IT ALREADY HOLDS IS NOT AN ERROR. ' +
    "`iscsi_list` does not report a target's groups. This tool cannot create or delete a target; " +
    '`iscsi_target_create` creates one. ' +
    TARGET_UPDATE_GUIDANCE,
  resultGuidance: TARGET_UPDATE_GUIDANCE,
  inputSchema: {
    type: 'object',
    properties: {
      id: {
        type: 'integer',
        description: "The iSCSI target's `id`, as `iscsi_list` reports it on the system being targeted.",
      },
      name: {
        type: 'string',
        description: 'A new target name. The IQN initiators connect to is built from it.',
      },
      ...TARGET_FIELD_SCHEMA,
    },
    required: ['id'],
  },
  requiredRole: Role.Sharing,
  mutating: true,
  // Every field it sends can be sent back, and the plan states the value each
  // held. What a rename or a narrower group does to connected initiators is
  // stated in the plan rather than recorded here.
  destructiveness: 'reversible',
  normalizeArgs(rawArgs) {
    const { id, fields } = parseTargetUpdate(rawArgs);
    return { id, ...fields };
  },
  async plan(ctx, rawArgs): Promise<PlanStep[]> {
    const { id, fields } = parseTargetUpdate(rawArgs);
    const row = rowWithId(await readTarget(ctx, id), id);
    if (row === null) {
      throw new Error(`No iSCSI target with id ${id} on this system — ids come from \`iscsi_list\``);
    }
    const target = targetRow(row);
    const notes: string[] = [];
    if (target.mode !== ISCSI_MODE) {
      notes.push(
        target.mode === null
          ? " The target's mode could not be read; this tool does not change it."
          : ` This target's mode is ${target.mode}, so it is served over Fibre Channel too or instead; this tool does not change it.`,
      );
    }
    if (fields.name !== undefined && fields.name !== target.name) {
      notes.push(
        ` RENAMING IT CHANGES THE IQN INITIATORS CONNECT TO: initiators configured with ` +
          `${target.name === null ? 'the old name' : `"${target.name}"`} will no longer find it.` +
          (await nameCheckSentence(ctx, fields.name, id)),
      );
    }
    if (fields.groups !== undefined) {
      notes.push(
        ' `groups` REPLACES THE WHOLE LIST: the target is published through exactly the groups ' +
          'sent, and an initiator connected through a portal no longer listed loses that path; ' +
          'whether the system merges a partial list instead is (unconfirmed).' +
          (await groupsSentence(ctx, fields.groups)),
      );
    }
    if (fields.auth_networks !== undefined) notes.push(networksSentence(fields.auth_networks));
    const already =
      agreement(targetSent(fields), targetComparable(row, fields)) === true
        ? ' The target already holds every value this sends, which is not an error.'
        : '';
    const changes = Object.entries(fields)
      .map(([key, value]) => `${key} ${JSON.stringify(value)} (now ${storedTargetValue(row, key)})`)
      .join('; ');
    return [
      readStep('iscsi.target.query', 'iSCSI target', id),
      {
        method: 'iscsi.target.update',
        params: [id, fields],
        description:
          `Change the iSCSI target named ${target.name === null ? NONE_REPORTED : `"${target.name}"`} ` +
          `(id ${id}): ${changes}. Only these fields are sent.${notes.join('')}${already}` +
          (fields.groups === undefined ? '' : GROUPS_UNLISTED),
      },
    ];
  },
  async execute(ctx, rawArgs) {
    const { id, fields } = parseTargetUpdate(rawArgs);
    let previous: Record<string, unknown> | null = null;
    let lookupError: string | null = null;
    try {
      previous = rowWithId(await readTarget(ctx, id), id);
    } catch (reason) {
      lookupError = errorText(reason);
    }
    // Issued whatever the read said: skipping it for a target the read no
    // longer lists would be `execute` branching on state the confirmation
    // token cannot bind.
    const updated: unknown = await firstValueFrom(ctx.system.client.api.call('iscsi.target.update', [id, fields]));
    const resulting = recordOrNull(updated);
    const keys = Object.keys(fields);
    const before = previous === null ? null : targetRow(previous);
    const after = resulting === null ? null : targetRow(resulting);
    const changes = Object.fromEntries(
      Object.entries(fields).map(([key, value]) => [
        key,
        {
          requested: value,
          before: before?.[key as keyof TargetRow] ?? null,
          after: after?.[key as keyof TargetRow] ?? null,
        },
      ]),
    );
    // `changed` compares the two READINGS on the fields that were sent, never
    // the request: a response still holding the old value is a call that did
    // not apply, not one that changed nothing.
    const same =
      previous === null || resulting === null
        ? null
        : agreement(targetReading(previous, keys), targetReading(resulting, keys));
    return {
      id,
      requested: fields,
      lookup: lookupError !== null ? 'UNREADABLE' : previous === null ? 'NOT_FOUND' : 'FOUND',
      lookup_error: lookupError,
      previous: before,
      resulting: after,
      changes,
      changed: same === null ? null : !same,
      confirmed: resulting === null ? null : agreement(targetSent(fields), targetComparable(resulting, fields)),
    };
  },
};

function readTarget(ctx: ToolContext, id: number): Promise<unknown> {
  return firstValueFrom(ctx.system.client.api.query('iscsi.target.query', [['id', '=', id]]));
}

/**
 * `nvmeof_subsystem_create` and `nvmeof_subsystem_update`: making one NVMe-oF
 * subsystem, and changing an existing one's name, NQN and whether it admits any
 * host.
 *
 * TWO TOOLS AND NOT ONE, for the iSCSI pair's reason above.
 *
 * WHETHER THE METHODS EXIST DEPENDS ON THE SYSTEM. `nvmeof_list` reports
 * `supported: false` off an absent-method rejection of `nvmet.subsys.query`, and
 * both plans read that same call and fail on that same rejection, saying NVMe-oF
 * is not supported there — rather than letting an approver approve a call the
 * system has no method for. Any other rejection is not read as unsupported, for
 * `nvmeof_list`'s reason.
 *
 * `subnqn` OMITTED IS THE MIDDLEWARE'S TO DERIVE, by a rule the surface does not
 * state, so the create plan does not predict it and the result reads it back off
 * the response (#170's rule for an identifier the middleware invents). `serial`
 * is always the middleware's, and is read back the same way.
 *
 * `allow_any_host` TRUE ADMITS EVERY HOST THAT CAN REACH A PUBLISHED PORT, and
 * both plans say so in words wherever it would be true after the call. Hosts,
 * namespaces and port publication are out of scope, so a subsystem created here
 * serves nothing until something outside this catalog gives it a namespace and
 * publishes it on a port — which the create plan says.
 *
 * `pi_enable`, `qid_max`, `ieee_oui` and `ana` are refused by name: tuning fields
 * whose meaning the surface does not state (#102).
 *
 * THE ROLE IS `Role.Sharing`, with the iSCSI pair's caveat: that the
 * sharing-admin role grants `nvmet.subsys.create` and `nvmet.subsys.update` is
 * (unconfirmed) against a live system's `privilege.roles`.
 */

/** The settings both tools send. Every one is optional on update. */
type SubsystemFields = {
  name?: string;
  subnqn?: string;
  allow_any_host?: boolean;
};

/** The order the plan states the fields in, which is the schema's. */
const SUBSYSTEM_FIELDS = ['name', 'subnqn', 'allow_any_host'] as const;

/** Why the tuning fields are refused, worded once for both tools. */
const SUBSYSTEM_REFUSED =
  "a subsystem's tuning fields are out of this tool's scope, because the surface does not state what they mean";

/**
 * The subsystem settings, each validated where it was passed and left out where
 * it was not, in the schema's order — so the record is exactly what is sent.
 */
function parseSubsystemFields(args: Record<string, unknown>): SubsystemFields {
  refuseArgs(args, ['pi_enable', 'qid_max', 'ieee_oui', 'ana'], SUBSYSTEM_REFUSED);
  const fields: SubsystemFields = {};
  const name = args['name'];
  if (name !== undefined) {
    if (textOrNull(name) === null) throw new Error('"name" must be a non-empty string');
    fields.name = name as string;
  }
  const subnqn = args['subnqn'];
  if (subnqn !== undefined) {
    // Omitting it is how the system is asked to derive one; an empty or null one
    // is refused rather than read as that, so a caller who meant one is not told
    // the other happened.
    if (textOrNull(subnqn) === null) {
      throw new Error('"subnqn" must be a non-empty string, an NVMe Qualified Name; omit it to let the system derive one');
    }
    fields.subnqn = subnqn as string;
  }
  const anyHost = args['allow_any_host'];
  if (anyHost !== undefined) {
    if (typeof anyHost !== 'boolean') throw new Error('"allow_any_host" must be true or false');
    fields.allow_any_host = anyHost;
  }
  return fields;
}

/** What `nvmeof_subsystem_create` sends: the settings passed, with a name. */
type SubsystemCreate = SubsystemFields & { name: string };

function parseSubsystemCreate(args: Record<string, unknown>): SubsystemCreate {
  const fields = parseSubsystemFields(args);
  if (fields.name === undefined) throw new Error('"name" is required');
  return { ...fields, name: fields.name };
}

/** What `nvmeof_subsystem_update` was asked to do. */
interface SubsystemUpdate {
  id: number;
  fields: SubsystemFields;
}

function parseSubsystemUpdate(args: Record<string, unknown>): SubsystemUpdate {
  const fields = parseSubsystemFields(args);
  const id = args['id'];
  if (!isWholeNumber(id)) throw new Error('"id" is required and must be a whole number');
  if (Object.keys(fields).length === 0) {
    throw new Error(`Nothing to change: pass at least one of ${SUBSYSTEM_FIELDS.join(', ')}`);
  }
  return { id, fields };
}

/**
 * An NVMe-oF subsystem as these tools report it, field by field. The tuning
 * fields are not reported, for the reason they are refused, and neither are the
 * host, namespace and port id lists — `nvmeof_list` reports what those name.
 */
interface SubsystemResult {
  id: number | null;
  name: string | null;
  subnqn: string | null;
  serial: string | null;
  allow_any_host: boolean | null;
}

function subsystemResult(row: Record<string, unknown>): SubsystemResult {
  return {
    id: numberOrNull(row['id']),
    name: textOrNull(row['name']),
    subnqn: textOrNull(row['subnqn']),
    serial: textOrNull(row['serial']),
    allow_any_host: booleanOrNull(row['allow_any_host']),
  };
}

/** A row's values for the fields named, as {@link agreement} compares them. */
function subsystemReading(row: Record<string, unknown>, keys: readonly string[]): Record<string, string | boolean | null> {
  const read = subsystemResult(row);
  return Object.fromEntries(keys.map((key) => [key, read[key as keyof SubsystemFields]]));
}

/** One field as the subsystem holds it now, as a plan states it. */
function storedSubsystemValue(row: Record<string, unknown>, key: string): string {
  const value = subsystemReading(row, [key])[key];
  return value === null ? NONE_REPORTED : JSON.stringify(value);
}

/** What a plan says where the system has no NVMe-oF, as `nvmeof_list` would. */
function unsupported(reason: unknown): Error {
  return new Error(
    `NVMe-oF is not supported on this system: it has no nvmet.subsys methods (${errorText(reason)}), ` +
      'which `nvmeof_list` reports as `supported: false`.',
  );
}

/** The words for a subsystem that admits any host. */
const ANY_HOST =
  'ANY HOST THAT CAN REACH A PORT THIS SUBSYSTEM IS PUBLISHED ON CAN CONNECT (allow_any_host true)';

/** The words for a subsystem that admits only the hosts allowed onto it. */
const LISTED_HOSTS =
  'only hosts explicitly allowed onto it may connect (allow_any_host false); `nvmeof_list` reports which ' +
  'hosts those are, and no tool in this catalog allows one';

/** Who the new subsystem admits, in words, given what is sent. */
function createHostSentence(anyHost: boolean | undefined): string {
  if (anyHost === true) return ` ${ANY_HOST}.`;
  if (anyHost === false) return ` It admits ${LISTED_HOSTS}.`;
  return (
    " `allow_any_host` is not sent, so the system's default applies, which is not read here — " +
    `(unconfirmed) that this is false. Where it is true, ${ANY_HOST}; the result reports which it is.`
  );
}

/** Who the subsystem will admit after the update, in words. */
function updateHostSentence(sent: boolean | undefined, now: boolean | null): string {
  if (sent === true) return ` ${ANY_HOST}.`;
  if (sent === false) {
    return (
      ` After this it admits ${LISTED_HOSTS}` +
      (now === true ? '. A host that could connect only because it allowed any host loses access.' : '.')
    );
  }
  if (now === true) return ` It allows any host now and this does not change that: ${ANY_HOST}.`;
  if (now === null) return ' Whether it admits any host could not be read; this does not change it.';
  return '';
}

const SUBSYSTEM_ROW_FIELDS =
  "`id`, which is what `nvmeof_subsystem_update` takes; `name`; `subnqn`, the NVMe Qualified Name " +
  "hosts connect to — what `nvmeof_list` reports as `nqn`; `serial`, the system's own; and " +
  '`allow_any_host`. Each is null where the response stated no value this tool could read. The ' +
  "subsystem's tuning fields and its host, namespace and port lists are not reported.";

const SUBSYSTEM_CREATE_GUIDANCE =
  '`requested` is exactly what was sent. `subsystem` is the created subsystem read back off the ' +
  'response the create itself answered with — never copied from the request — or null where that ' +
  `response was not a record. Its fields are ${SUBSYSTEM_ROW_FIELDS} WHERE \`subnqn\` WAS NOT SENT ` +
  'THE ONE REPORTED IS THE ONE THE SYSTEM DERIVED, and is the NQN to give a host. `confirmed` is ' +
  'whether `subsystem` holds every value sent: true is the system reporting back what was asked ' +
  'for; FALSE IS NOT A SUCCESS — the call did not reject and at least one value was stored as ' +
  'something else; and null is a response in which some value sent could not be read back and none ' +
  'read back as different. A null `subsystem` means nothing here establishes that a subsystem was ' +
  'created, and is not evidence that none was — `nvmeof_list` shows what the system now holds.';

export const nvmeofSubsystemCreate: MutatingTool = {
  name: 'nvmeof_subsystem_create',
  description:
    'Creates one NVMe-oF subsystem on this TrueNAS system. Two-phase: called without a ' +
    'confirmation_token it returns a plan for user approval; called with one it creates the ' +
    'subsystem. `name` is required; `subnqn` and `allow_any_host` are optional. `subnqn` OMITTED ' +
    'IS DERIVED BY THE SYSTEM, by a rule this catalog does not know, and the result reports the one ' +
    'it chose. `pi_enable`, `qid_max`, `ieee_oui` and `ana` are refused. ON A SYSTEM WITHOUT ' +
    "NVMe-oF THE PLAN FAILS, saying so, where `nvmeof_list` reports `supported: false`. " +
    '`allow_any_host` true admits ANY HOST THAT CAN REACH A PORT THE SUBSYSTEM IS PUBLISHED ON, and ' +
    'the plan says so in words wherever it may be true. A NEW SUBSYSTEM HAS NO NAMESPACE AND IS ' +
    'PUBLISHED ON NO PORT, SO IT SERVES NOTHING AND IS UNREACHABLE: no tool in this catalog adds a ' +
    'namespace, allows a host or publishes a subsystem on a port, and `nvmeof_list` reports where ' +
    'one is published under `ports[].subsystems`. `destructiveness` is `reversible`, but NO TOOL IN ' +
    'THIS CATALOG DELETES AN NVMe-oF SUBSYSTEM: undoing this means deleting it outside this catalog. ' +
    SUBSYSTEM_CREATE_GUIDANCE,
  resultGuidance: SUBSYSTEM_CREATE_GUIDANCE,
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: "The subsystem's short name." },
      subnqn: {
        type: 'string',
        description: 'The NVMe Qualified Name hosts connect to. Omit it and the system derives one.',
      },
      allow_any_host: {
        type: 'boolean',
        description: 'true admits ANY host that can reach a port the subsystem is published on.',
      },
    },
    required: ['name'],
  },
  requiredRole: Role.Sharing,
  mutating: true,
  // Additive: the subsystem is a new row and nothing existing is removed. Who it
  // admits is stated in the plan rather than recorded here.
  destructiveness: 'reversible',
  normalizeArgs(rawArgs) {
    return parseSubsystemCreate(rawArgs);
  },
  async plan(ctx, rawArgs): Promise<PlanStep[]> {
    const body = parseSubsystemCreate(rawArgs);
    // Plan-time only and not a step (#119): it is read for whether the method
    // exists, and no row of it is used, so one row is all it asks for.
    let support = '';
    try {
      await firstValueFrom(ctx.system.client.api.query('nvmet.subsys.query', [], { limit: 1 }));
    } catch (reason) {
      if (isMissingMethod(reason)) throw unsupported(reason);
      support =
        ' Whether this system supports NVMe-oF could not be checked: nvmet.subsys.query failed ' +
        `(${errorText(reason)}).`;
    }
    const subnqn =
      body.subnqn === undefined
        ? ' `subnqn` is not sent, so the system derives the NQN hosts connect to, by a rule this ' +
          'catalog does not know; the result reports the one it chose.'
        : '';
    return [
      {
        method: 'nvmet.subsys.create',
        params: [body],
        description:
          `Create an NVMe-oF subsystem, ${Object.entries(body)
            .map(([key, value]) => `${key} ${JSON.stringify(value)}`)
            .join(', ')}.${subnqn}${createHostSentence(body.allow_any_host)}` +
          ' A NEW SUBSYSTEM HAS NO NAMESPACE AND IS PUBLISHED ON NO PORT, SO IT SERVES NOTHING: no ' +
          'tool in this catalog adds a namespace or publishes a subsystem on a port, and ' +
          '`nvmeof_list` reports where one is published under `ports[].subsystems`.' +
          support,
      },
    ];
  },
  async execute(ctx, rawArgs) {
    const body = parseSubsystemCreate(rawArgs);
    const created: unknown = await firstValueFrom(ctx.system.client.api.call('nvmet.subsys.create', [body]));
    const held = recordOrNull(created);
    return {
      requested: body,
      subsystem: held === null ? null : subsystemResult(held),
      confirmed: held === null ? null : agreement(body, subsystemReading(held, Object.keys(body))),
    };
  },
};

const SUBSYSTEM_UPDATE_GUIDANCE =
  '`requested` is exactly what was sent. `previous` is the subsystem as read immediately before the ' +
  'call, and `resulting` is the subsystem read back off the response the update itself answered ' +
  'with — never copied from the request. Both carry the fields `nvmeof_subsystem_create` reports; ' +
  '`previous` is null where that read failed or listed no such subsystem, and `resulting` is null ' +
  'where the response was not a record. `changes` names each field that was SENT, as `requested`, ' +
  '`before` (off `previous`) and `after` (off `resulting`), and `before` or `after` is null wherever ' +
  'the reading behind it is. `lookup` says what the read did: `FOUND`, `NOT_FOUND` (deleted between ' +
  'the plan and the confirmation), or `UNREADABLE` with `lookup_error` naming why; THE UPDATE IS ' +
  'ATTEMPTED IN ALL THREE CASES, because what runs must be what was approved. `changed` is true where ' +
  'the subsystem before and after differ in one of the sent fields and false where they agree in ' +
  'all, WHICH IS TWO OUTCOMES AND NOT ONE: the subsystem already held those values, or the call did ' +
  'not apply. `confirmed` is what tells those apart, and `changed` must not be read without it. ' +
  '`confirmed` is whether `resulting` holds every value sent: true is the system reporting back what ' +
  'was asked for; FALSE IS NOT A SUCCESS — the call did not reject and at least one value was stored ' +
  'as something else; null is a response in which some value sent could not be read back and none ' +
  'read back as different. Both are null wherever a reading they need is missing.';

export const nvmeofSubsystemUpdate: MutatingTool = {
  name: 'nvmeof_subsystem_update',
  description:
    "Changes one existing NVMe-oF subsystem's `name`, `subnqn` or `allow_any_host` on this TrueNAS " +
    'system. Two-phase: called without a confirmation_token it returns a plan for user approval; ' +
    "called with one it sends the change. `id` is the subsystem's id as `nvmeof_list` reports it; " +
    'PLANNING AGAINST AN id NO NVMe-oF SUBSYSTEM HAS FAILS, naming it, and on a system without ' +
    'NVMe-oF the plan fails saying so. ONLY THE FIELDS PASSED ARE SENT, and at least one is ' +
    'required; `pi_enable`, `qid_max`, `ieee_oui` and `ana` are refused. THE PLAN STATES EACH VALUE ' +
    'SENT BESIDE THE ONE THE SUBSYSTEM HOLDS NOW, so the call that undoes it is in the plan, AND SAYS ' +
    'IN WORDS WHERE IT WILL ADMIT ANY HOST. CHANGING `subnqn` CHANGES WHAT HOSTS CONNECT TO, so hosts ' +
    'configured with the old NQN will no longer find it; whether renaming it changes the NQN too is ' +
    '(unconfirmed), and the result reports the NQN read back. SENDING A SUBSYSTEM A VALUE IT ALREADY ' +
    'HOLDS IS NOT AN ERROR. This tool cannot create or delete a subsystem; `nvmeof_subsystem_create` ' +
    'creates one. ' +
    SUBSYSTEM_UPDATE_GUIDANCE,
  resultGuidance: SUBSYSTEM_UPDATE_GUIDANCE,
  inputSchema: {
    type: 'object',
    properties: {
      id: {
        type: 'integer',
        description: "The subsystem's `id`, as `nvmeof_list` reports it on the system being targeted.",
      },
      name: { type: 'string', description: 'A new short name for the subsystem.' },
      subnqn: {
        type: 'string',
        description: 'A new NVMe Qualified Name. Hosts configured with the old one will no longer find it.',
      },
      allow_any_host: {
        type: 'boolean',
        description: 'true admits ANY host that can reach a port the subsystem is published on.',
      },
    },
    required: ['id'],
  },
  requiredRole: Role.Sharing,
  mutating: true,
  // Every field it sends can be sent back, and the plan states the value each
  // held. What a new NQN or a narrower admission does to connected hosts is
  // stated in the plan rather than recorded here.
  destructiveness: 'reversible',
  normalizeArgs(rawArgs) {
    const { id, fields } = parseSubsystemUpdate(rawArgs);
    return { id, ...fields };
  },
  async plan(ctx, rawArgs): Promise<PlanStep[]> {
    const { id, fields } = parseSubsystemUpdate(rawArgs);
    let rows: unknown;
    try {
      rows = await readSubsystem(ctx, id);
    } catch (reason) {
      if (isMissingMethod(reason)) throw unsupported(reason);
      throw reason;
    }
    const row = rowWithId(rows, id);
    if (row === null) {
      throw new Error(`No NVMe-oF subsystem with id ${id} on this system — ids come from \`nvmeof_list\``);
    }
    const now = subsystemResult(row);
    const notes: string[] = [];
    if (fields.subnqn !== undefined && fields.subnqn !== now.subnqn) {
      notes.push(
        ' CHANGING THE NQN CHANGES WHAT HOSTS CONNECT TO: hosts configured with ' +
          `${now.subnqn === null ? 'the old NQN' : `"${now.subnqn}"`} will no longer find this subsystem.`,
      );
    } else if (fields.name !== undefined && fields.name !== now.name && fields.subnqn === undefined) {
      notes.push(' Whether renaming it also changes the NQN hosts connect to is (unconfirmed); the result reports the NQN read back.');
    }
    notes.push(updateHostSentence(fields.allow_any_host, now.allow_any_host));
    const already =
      agreement(fields, subsystemReading(row, Object.keys(fields))) === true
        ? ' The subsystem already holds every value this sends, which is not an error.'
        : '';
    const changes = Object.entries(fields)
      .map(([key, value]) => `${key} ${JSON.stringify(value)} (now ${storedSubsystemValue(row, key)})`)
      .join('; ');
    return [
      readStep('nvmet.subsys.query', 'NVMe-oF subsystem', id),
      {
        method: 'nvmet.subsys.update',
        params: [id, fields],
        description:
          `Change the NVMe-oF subsystem named ${now.name === null ? NONE_REPORTED : `"${now.name}"`} ` +
          `(id ${id}): ${changes}. Only these fields are sent.${notes.join('')}${already}`,
      },
    ];
  },
  async execute(ctx, rawArgs) {
    const { id, fields } = parseSubsystemUpdate(rawArgs);
    let previous: Record<string, unknown> | null = null;
    let lookupError: string | null = null;
    try {
      previous = rowWithId(await readSubsystem(ctx, id), id);
    } catch (reason) {
      lookupError = errorText(reason);
    }
    // Issued whatever the read said: skipping it for a subsystem the read no
    // longer lists would be `execute` branching on state the confirmation token
    // cannot bind.
    const updated: unknown = await firstValueFrom(ctx.system.client.api.call('nvmet.subsys.update', [id, fields]));
    const resulting = recordOrNull(updated);
    const keys = Object.keys(fields);
    const before = previous === null ? null : subsystemResult(previous);
    const after = resulting === null ? null : subsystemResult(resulting);
    const changes = Object.fromEntries(
      Object.entries(fields).map(([key, value]) => [
        key,
        {
          requested: value,
          before: before?.[key as keyof SubsystemFields] ?? null,
          after: after?.[key as keyof SubsystemFields] ?? null,
        },
      ]),
    );
    // `changed` compares the two READINGS on the fields that were sent, never
    // the request: a response still holding the old value is a call that did
    // not apply, not one that changed nothing.
    const same =
      previous === null || resulting === null
        ? null
        : agreement(subsystemReading(previous, keys), subsystemReading(resulting, keys));
    return {
      id,
      requested: fields,
      lookup: lookupError !== null ? 'UNREADABLE' : previous === null ? 'NOT_FOUND' : 'FOUND',
      lookup_error: lookupError,
      previous: before,
      resulting: after,
      changes,
      changed: same === null ? null : !same,
      confirmed: resulting === null ? null : agreement(fields, subsystemReading(resulting, keys)),
    };
  },
};

function readSubsystem(ctx: ToolContext, id: number): Promise<unknown> {
  return firstValueFrom(ctx.system.client.api.query('nvmet.subsys.query', [['id', '=', id]]));
}
