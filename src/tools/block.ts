import { firstValueFrom } from 'rxjs';
import { Role } from '@/interfaces';
import { ReadOnlyTool, SystemHandle } from '@/catalog/tool';

/**
 * Block-storage family: what the system serves over iSCSI, and who is attached
 * to it.
 *
 * `shares_list` deliberately excludes iSCSI, and says so: a target exports a
 * block device rather than a filesystem path, and its vocabulary of targets,
 * extents and initiators answers a different question. That question is asked
 * here.
 *
 * It takes four middleware namespaces to answer, and none of them nests inside
 * another. `iscsi.target.query` names the targets; `iscsi.extent.query` names
 * the backing stores; `iscsi.targetextent.query` is the join table that maps an
 * extent onto a target at a LUN; and `iscsi.global.sessions` is live state from
 * the running service rather than configuration at all — it is the only one
 * that says whether anything is actually connected. The last is the reason the
 * tool exists: a target with no session is the shape of a hypervisor that quietly
 * dropped its storage, and nothing in the first three can tell that from a
 * target nobody has ever used.
 */

/** Which of the two secondary reads failed. */
type Source = 'extents' | 'initiators';

/** One read that failed, and why, for the caller to act on. */
interface Failure {
  source: Source;
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

/**
 * Why a read failed, in words.
 *
 * A rejection is not necessarily an `Error` — the client rejects with whatever
 * the transport gave it — so a bare string is read too, and anything else
 * becomes a stated absence rather than `"[object Object]"`. Never empty: a
 * failure with no text still has to read as a failure.
 */
function errorText(reason: unknown): string {
  if (reason instanceof Error) return textOrNull(reason.message) ?? 'the system reported no reason';
  return textOrNull(reason) ?? 'the system reported no reason';
}

/** A read that produced a value, or the failure that stopped it. */
interface Attempt<T> {
  value: T | null;
  failure: Failure | null;
}

/**
 * One read, with a failure caught and named rather than thrown.
 *
 * The read is passed as a thunk so that the call is made inside the `try`,
 * which keeps this correct for a read that throws before it returns a promise
 * at all.
 */
async function attempt<T>(source: Source, read: () => Promise<T>): Promise<Attempt<T>> {
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

    const failures: Failure[] = [];
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
