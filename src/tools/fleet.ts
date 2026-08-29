import { firstValueFrom } from 'rxjs';
import { Role } from '@/interfaces';
import { ReadOnlyTool, SystemHandle } from '@/catalog/tool';

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
    'true where the system reports any HA state at all, and null where the ' +
    'system reported no state, which settles nothing either way. `status` is ' +
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
