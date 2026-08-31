import { firstValueFrom } from 'rxjs';
import { Role } from '@/interfaces';
import { ReadOnlyTool, SystemHandle } from '@/catalog/tool';
import {
  MAX_TIME_MS,
  MiddlewareDate,
  errorText as failureText,
  numberOrNull,
  recordOrNull,
  strictTextList,
  textOrNull,
} from '@/tools/common';

/**
 * Replication family: the replication tasks that exist, how their last run went,
 * and which peer each of them replicates with.
 *
 * `snapshots_list` shows the snapshots a system holds, which is what a task
 * replicates and not whether it did. Replication is the difference between a
 * snapshot and a backup, and a task that has been failing quietly for weeks
 * looks, from the source system alone, exactly like one that is working — the
 * snapshots are all there either way. The task's own state record is the only
 * place that difference is visible.
 *
 * `replication_topology` answers the other half: WHO the other end is. A task's
 * state says a replication is working and never says what it is working
 * towards, so "is anything still replicating to the decommissioned box" and
 * "which node holds the offsite copy" are questions neither this system's
 * snapshots nor its task states can answer.
 */

/**
 * The two states that describe a run that has ENDED, and so the only two under
 * which the recorded time is a finish time.
 *
 * The system holds one state record per task, carrying the state and the
 * instant that state was recorded. Under `RUNNING` that instant is when the
 * current run began, and under `PENDING` or `HOLD` it is when the task entered
 * that state — reporting any of them as `finished_at` would name a real
 * timestamp as something it is not, which is worse than reporting none.
 */
const ENDED_STATES = new Set(['FINISHED', 'ERROR']);

/**
 * {@link MAX_TIME_MS} from `common.ts` is what keeps one absurd recorded time
 * from taking the whole listing down with it, applied here to the instant a
 * task's state was recorded.
 */

/**
 * The state record a replication task carries, restated with every field
 * optional and untyped.
 *
 * The client declares `state` as `{ [k: string]: unknown }` — an open record
 * naming nothing — so every field of it arrives as `unknown`, the same way a
 * ZFS property does in `storage.ts` and a scan record does in `pools.ts`. Only
 * the three fields read here are named.
 */
interface RunState {
  state?: unknown;
  datetime?: unknown;
  error?: unknown;
}

/**
 * The task's state record, or null where the row carries nothing to read it
 * from.
 *
 * Guarded rather than asserted: the record arrives as `unknown`, and a row that
 * sends something other than an object is exactly the case an assertion would
 * have got wrong.
 */
function runState(state: unknown): RunState | null {
  return typeof state === 'object' && state !== null ? (state as RunState) : null;
}

/**
 * The instant a state was recorded, in milliseconds since the epoch, or null
 * where the system reported no time this tool can read.
 *
 * A bare number is accepted beside the `{ "$date": … }` envelope because the
 * envelope exists only to tag a number as a date in transit; both are epoch
 * milliseconds. Anything else — a formatted string, a date in another shape —
 * is not read rather than guessed at, because guessing wrong about a timezone
 * produces a timestamp that is confidently off by hours.
 */
function stateMillis(datetime: unknown): number | null {
  const raw =
    typeof datetime === 'object' && datetime !== null
      ? (datetime as MiddlewareDate).$date
      : datetime;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return null;
  return Math.abs(raw) <= MAX_TIME_MS ? raw : null;
}

/**
 * The state of the task's last run: the system's own state string, or
 * `NEVER_RUN`, or null.
 *
 * `NEVER_RUN` is what the tool exists to keep separate from a failure. A task
 * the system has never run reports `PENDING` with no time recorded against it,
 * because the state record is created with the task and nothing has replaced it
 * — so the absence of a recorded time is the evidence, and a task that is
 * pending *again* after running carries the time it entered that state. That is
 * a reading of what the system sends rather than a guarantee it makes: the
 * field is untyped, so `PENDING` with a time is reported as plain `PENDING`,
 * which is true either way.
 *
 * Null is neither of those. It is a task whose state could not be read at all —
 * no record, or a record naming no state — and it must not read as a task that
 * has never run, which is a fact about the task rather than about this tool.
 *
 * Any other state is passed through as the system spelled it, so a state a
 * later TrueNAS release adds reaches the caller rather than being flattened
 * into one of these.
 */
function lastRunState(state: RunState | null): string | null {
  if (state === null) return null;
  const reported = state.state;
  if (typeof reported !== 'string' || reported.length === 0) return null;
  return reported === 'PENDING' && state.datetime == null ? 'NEVER_RUN' : reported;
}

/**
 * When the last run ended, as an ISO 8601 UTC timestamp, or null where nothing
 * this tool can read says a run ended.
 *
 * The state must be one that describes an ended run — see {@link ENDED_STATES}
 * — before the recorded time is read as a finish time at all.
 */
function finishedAt(state: RunState | null, reported: string | null): string | null {
  if (state === null || reported === null || !ENDED_STATES.has(reported)) return null;
  const millis = stateMillis(state.datetime);
  return millis === null ? null : new Date(millis).toISOString();
}

/**
 * The error text recorded with the state, or null where none was recorded.
 *
 * An empty string is read as no text rather than as an error message of no
 * characters: it names nothing a caller could act on, and reporting it beside
 * an `ERROR` state would suggest the reason is available when it is not.
 */
function errorText(state: RunState | null): string | null {
  const error = state?.error;
  return typeof error === 'string' && error.length > 0 ? error : null;
}

/**
 * The datasets a task replicates from, as the strings among whatever the system
 * sent.
 *
 * The client types this a non-empty tuple of strings, which the middleware
 * enforces on creation; the guard is for a row that does not honour it, where
 * an entry that is not a dataset name is not a dataset and an absent list
 * leaves nothing to report rather than taking the listing down.
 */
function sourceDatasets(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry) => typeof entry === 'string') : [];
}

export const replicationStatus: ReadOnlyTool = {
  name: 'replication_status',
  description:
    'Every replication task on the system and how its last run went. `name` ' +
    "is the task's own name and `id` its numeric identity. `direction` is " +
    '`PUSH`, replicating from this system outwards, or `PULL`, replicating ' +
    'onto it; `source_datasets` are the datasets replicated from and ' +
    '`target_dataset` the one replicated to, so on a `PUSH` the sources are ' +
    'local and on a `PULL` the target is. `transport` is how the data travels ' +
    '— `SSH`, `SSH+NETCAT` or `LOCAL`. `enabled` is whether the task is ' +
    'switched on, and is null where the system reported no value; a disabled ' +
    'task is still listed, because a task nobody switched back on is exactly ' +
    'the one worth finding. `state` is one of: `FINISHED`, a run that ' +
    'completed; `ERROR`, one that failed; `RUNNING`, one going on now; ' +
    '`PENDING`, one waiting to run; `HOLD`, one the system is holding back; ' +
    '`NEVER_RUN`, a task the system holds no record of having run; and null, ' +
    'a task whose state could not be read at all. Those last two are ' +
    'different answers and neither is a failure: `NEVER_RUN` is a task that ' +
    'has not replicated anything yet, while null says only that this tool ' +
    'could not tell — a task in either state has not been shown to be ' +
    'working. A state a later TrueNAS release adds is passed through as the ' +
    'system spelled it, so `state` is not limited to that list. `finished_at` ' +
    'is when the last run ended, as an ISO 8601 UTC timestamp. It is reported ' +
    'only under `FINISHED` and `ERROR`, the two states that describe a run ' +
    'that ended, and is null under every other state including `RUNNING` — ' +
    'the system records one time per task, and under `RUNNING` that time is ' +
    'when the current run started rather than when anything finished. ' +
    '`error` is the error text recorded with the state and is null where none ' +
    'was recorded, so it carries the reason a task in `ERROR` failed. A task ' +
    'in `ERROR` with a null `error` failed for a reason the system did not ' +
    'record; it has not succeeded.',
  inputSchema: { type: 'object', properties: {} },
  requiredRole: Role.ReadOnly,
  mutating: false,
  async handler({ system }) {
    // No filters and no options: a system holds tens of replication tasks at
    // most, and the state record this tool reads is part of a task row as it
    // stands — there is no option that changes how it is nested and no volume
    // to bound.
    const tasks = await firstValueFrom(system.client.api.query('replication.query'));
    return tasks.map((task) => {
      const state = runState(task.state);
      // Read once and passed to `finishedAt`, so that the state reported and
      // the decision about whether the recorded time is a finish time cannot
      // be made from two different readings of the same record.
      const reported = lastRunState(state);
      return {
        id: task.id,
        name: task.name,
        direction: task.direction,
        transport: task.transport,
        // Optional on the client's own type, so a middleware that omits it
        // reports null rather than handing the caller an object missing a
        // field the description promises — as `orNull` does in `pools.ts`.
        // Not defaulted to true or false: a task whose switch cannot be read
        // must not be presented as one that is definitely on or definitely
        // off.
        enabled: task.enabled ?? null,
        source_datasets: sourceDatasets(task.source_datasets),
        target_dataset: task.target_dataset,
        state: reported,
        finished_at: finishedAt(state, reported),
        error: errorText(state),
      };
    });
  },
};

/**
 * The one transport that has no peer: the task replicates within this system,
 * so there is no remote end to name and no credential to look one up with.
 *
 * Matched against what the system actually spelled, never defaulted to. A task
 * whose transport could not be read is NOT reported as local — that would be
 * the claim "this task has no peer", made from a field that said nothing.
 */
const LOCAL_TRANSPORT = 'LOCAL';

/** What a system answering `keychaincredential.query` with something else is reported as. */
const NOT_A_CREDENTIAL_LIST = 'the system did not answer with a list of credentials';

/**
 * Why a task's peer is named, or which of the ways it could not be.
 *
 * These are five separate causes rather than one absence, and the caller acts
 * differently on each: a task replicating locally has no peer to find, a task
 * whose credential was deleted has one nobody can name any more, and a task
 * this tool could not look up has one that is probably fine. Collapsing them
 * into a null `peer_host` would make "there is no remote end" and "this tool
 * did not manage to say" the same answer.
 */
type PeerStatus =
  /** `transport` is `LOCAL`: the task replicates within this system. */
  | 'LOCAL'
  /** A host was read off the task's SSH credential. */
  | 'NAMED'
  /** The task is not local and named no SSH credential this tool could read. */
  | 'CREDENTIAL_NOT_REPORTED'
  /** The task named a credential by id and the system lists no credential with it. */
  | 'CREDENTIAL_MISSING'
  /** The task named a credential by id and the credential listing could not be read. */
  | 'CREDENTIAL_UNREADABLE'
  /** A credential was reached and it records no host this tool could read. */
  | 'HOST_NOT_REPORTED';

/**
 * A stored SSH credential reduced to the peer it names, AND NOTHING ELSE.
 *
 * THIS IS THE CREDENTIAL BOUNDARY, and it is an allowlist for a sharper reason
 * than most in this repository. The client types a keychain credential's
 * `attributes` as `SSHKeyPair | SSHCredentials` — an UNTAGGED union, so the
 * compiler cannot tell which arm a row is, and one of the two arms is
 * `{ private_key?: string, public_key?: string }`. On the arm a replication
 * task actually uses, `private_key` is a NUMBER: the id of the separate
 * `SSH_KEY_PAIR` credential holding the key, so naming `host` and `port` never
 * brings key material with it. Reading the two fields BY NAME is what makes
 * that true whichever arm arrives, and what keeps the key out if a release ever
 * moves it. Tool results are recorded verbatim in the audit trail (S3.3);
 * forwarding `attributes`, or trimming known secrets out of it, would put an
 * SSH private key in one. `username`, `connect_timeout` and `remote_host_key`
 * are not read either — they are not the peer, and the description says so.
 */
interface Peer {
  name: string | null;
  host: string | null;
  port: number | null;
}

/** The peer half of a reported task: the status and the four fields under it. */
interface PeerReading {
  peer_status: PeerStatus;
  peer_host: string | null;
  peer_port: number | null;
  credential_id: number | null;
  credential_name: string | null;
}

/** A stored credential row, reduced to the peer it names the moment it is read. */
function peerOf(record: Record<string, unknown>): Peer {
  const attributes = recordOrNull(record['attributes']);
  return {
    name: textOrNull(record['name']),
    host: attributes === null ? null : textOrNull(attributes['host']),
    // Reported as the credential records it, with no comparison against 22.
    // The pinned surface declares `port?: number` and states no default, so
    // "the port differs from the default" is not a fact this tool has read —
    // asserting one would be a unit-suffix on a number nobody named (#96),
    // one field over.
    port: attributes === null ? null : numberOrNull(attributes['port']),
  };
}

/** A peer that could not be named, under the status saying which way. */
function unnamed(status: PeerStatus, credentialId: number | null = null): PeerReading {
  return {
    peer_status: status,
    peer_host: null,
    peer_port: null,
    credential_id: credentialId,
    credential_name: null,
  };
}

/**
 * A credential that was reached, read as the task's peer.
 *
 * `NAMED` is the narrow claim that a host was read — a credential reached with
 * no readable host is `HOST_NOT_REPORTED` and not a peer named as nothing.
 * `peer_port` is reported either way, because the port is a fact the credential
 * recorded and dropping it would not make the missing host any clearer.
 */
function named(peer: Peer, credentialId: number | null): PeerReading {
  return {
    peer_status: peer.host === null ? 'HOST_NOT_REPORTED' : 'NAMED',
    peer_host: peer.host,
    peer_port: peer.port,
    credential_id: credentialId,
    credential_name: peer.name,
  };
}

/**
 * What a task's own row already says about its peer, or the id a second read
 * has to resolve.
 *
 * `ssh_credentials` arrives in two shapes and the difference decides whether a
 * second call is needed at all. The pinned client declares it as a whole
 * `KeychainCredentialEntry` — so the common case carries the host inside the
 * task row and NOTHING needs looking up — while the middleware also sends the
 * id-only form, which `tasks.ts` reads for a cloud sync task's `credentials`
 * and an rsync task's `ssh_credentials` for the same reason. Reading both is
 * the move `system_general_config` makes for `ui_certificate` (#102): where a
 * payload can arrive in more than one shape, a reading both shapes satisfy is
 * worth more than a guard written to the pinned one.
 */
type PeerSource = { kind: 'read'; reading: PeerReading } | { kind: 'lookup'; id: number };

function peerSource(transport: string | null, credentials: unknown): PeerSource {
  if (transport === LOCAL_TRANSPORT) return { kind: 'read', reading: unnamed('LOCAL') };
  const embedded = recordOrNull(credentials);
  if (embedded !== null) {
    return { kind: 'read', reading: named(peerOf(embedded), numberOrNull(embedded['id'])) };
  }
  const id = numberOrNull(credentials);
  if (id === null) return { kind: 'read', reading: unnamed('CREDENTIAL_NOT_REPORTED') };
  return { kind: 'lookup', id };
}

/** The credential listing, by id — or the reason it could not be read. */
interface CredentialLookup {
  peers: Map<number, Peer> | null;
  error: string | null;
}

/**
 * Every stored credential, reduced to a peer and keyed by id, with a failure
 * named rather than thrown.
 *
 * Caught because this is the SECOND read: the tasks were listed successfully,
 * and a credential listing that fails must leave every task still reported —
 * including the ones whose peer the task row already named. That is the section
 * seam `boot.ts` and `automated_tasks_list` use, with one supporting read
 * rather than several independent ones, so the reason is reported once beside
 * the list instead of repeated on every row.
 *
 * A row whose id cannot be read is dropped: it can never be the answer to a
 * lookup by id, and keeping it under some substitute key would make a task
 * match a credential that is not its own.
 */
async function readCredentials(system: SystemHandle): Promise<CredentialLookup> {
  try {
    // No filters: a system holds a handful of stored credentials, and a filter
    // is bandwidth rather than a control — an unrecognised query parameter is
    // dropped rather than refused, so a filter that did not apply comes back as
    // the whole table and is indistinguishable from one that matched
    // everything (#121). The match by id below is what decides either way.
    const answer = await firstValueFrom(system.client.api.query('keychaincredential.query'));
    if (!Array.isArray(answer)) return { peers: null, error: NOT_A_CREDENTIAL_LIST };
    const peers = new Map<number, Peer>();
    for (const row of answer) {
      const record = recordOrNull(row);
      if (record === null) continue;
      const id = numberOrNull(record['id']);
      if (id !== null) peers.set(id, peerOf(record));
    }
    return { peers, error: null };
  } catch (reason) {
    return { peers: null, error: failureText(reason) };
  }
}

/** One task's peer, once the lookup (where one was needed) has been made. */
function resolvePeer(source: PeerSource, lookup: CredentialLookup): PeerReading {
  if (source.kind === 'read') return source.reading;
  if (lookup.peers === null) return unnamed('CREDENTIAL_UNREADABLE', source.id);
  const found = lookup.peers.get(source.id);
  // Absent from a listing that WAS read is the deleted credential: the task
  // still references an id, and nothing on the system answers to it. That is a
  // different answer from the listing being unreadable, and the task is
  // reported under either rather than dropped.
  return found === undefined ? unnamed('CREDENTIAL_MISSING', source.id) : named(found, source.id);
}

export const replicationTopology: ReadOnlyTool = {
  name: 'replication_topology',
  description:
    'Which peer each replication task on this system replicates with — the ' +
    'remote host on the far end — beside the direction and datasets ' +
    '`replication_status` reports. THIS REPORTS ONE NODE\'S EDGES AND ONLY ' +
    'ITS OWN. It reads the replication tasks configured on the system it is ' +
    'called against; it does not connect to any peer and cannot see a task ' +
    'configured on one. A fleet-wide replication topology is assembled BY THE ' +
    'CALLER, by calling this tool on each node and joining the results — a ' +
    'peer named here is a host this system points at, not evidence that the ' +
    'host exists, is reachable, or holds what the task says it sends. ' +
    '`tasks` lists every replication task, local ones included. `id` is the ' +
    "task's numeric identity and `name` its own name. `direction` is `PUSH`, " +
    'replicating from this system outwards, or `PULL`, replicating onto it, ' +
    'and it says which end the peer is: on a `PUSH` the peer holds ' +
    '`target_dataset` and `source_datasets` are local, and on a `PULL` the ' +
    'peer holds `source_datasets` and `target_dataset` is local. `transport` ' +
    'is how the data travels — `SSH`, `SSH+NETCAT` or `LOCAL`. ' +
    '`source_datasets` is the datasets replicated from and `target_dataset` ' +
    'the one replicated to. `source_datasets` is null, rather than a shorter ' +
    'list, where any entry could not be read as a dataset name: a list one ' +
    'name short would say that dataset is not replicated to this peer, which ' +
    'is the claim this tool exists to answer and must not make by accident. ' +
    'An empty list is a different answer and is returned as itself. ' +
    '`peer_status` says whether the peer is named and, where it is not, why: ' +
    '`NAMED`, a host was read and is in `peer_host`; `LOCAL`, the task ' +
    'replicates within this system and has no remote end at all; ' +
    '`CREDENTIAL_NOT_REPORTED`, the task is not local and named no SSH ' +
    'credential this tool could read; `CREDENTIAL_MISSING`, the task names a ' +
    'credential by id and the system lists no credential with that id, which ' +
    'is what a deleted credential looks like — the task is still reported, ' +
    'with `credential_id` naming the id nothing answers to; ' +
    '`CREDENTIAL_UNREADABLE`, the task names a credential by id and the ' +
    'credential listing could not be read, so this is a limit of this call ' +
    'rather than anything about the task, and `credentials_unavailable` ' +
    'carries the reason; and `HOST_NOT_REPORTED`, a credential was reached ' +
    'and records no host this tool could read. `LOCAL` is reported only where ' +
    'the system spelled the transport `LOCAL`: a task whose transport could ' +
    'not be read is never presented as having no peer. `peer_host` is the ' +
    'host as the credential records it — a hostname or an address, whichever ' +
    'was configured — and is null under every status but `NAMED`. `peer_port` ' +
    'is the port the credential records, and is null where it records none, ' +
    "which means SSH's own default applies; this tool does not assert what " +
    'that default is and does not compare against it, so a null port is not a ' +
    'port of 22 and a reported port is not necessarily a non-default one. A ' +
    'port beside a null host is a credential that recorded one and no ' +
    'readable host. `credential_id` and `credential_name` identify the stored ' +
    'SSH credential the peer was read from. Either is null where the ' +
    'credential was not reached AND where it was reached and recorded no ' +
    'value this tool could read, so both can be null beside a `NAMED` peer ' +
    'whose host was read perfectly well; the two causes are not separable ' +
    'from these fields, and `peer_status` is what says whether a credential ' +
    'was reached at all. NO KEY MATERIAL APPEARS IN THIS ' +
    'RESULT UNDER ANY INPUT. The stored credential holds an SSH private key ' +
    'or a reference to one, and this tool reads four fields off it — id, ' +
    'name, host and port — by name; nothing else of the credential, and no ' +
    'field a later TrueNAS release adds to one, can reach a caller without a ' +
    'change to this file. The username, connect timeout and remote host key it ' +
    'also records are not reported. `credentials_unavailable` is why the ' +
    'credential listing could not be read, and is null both where it was read ' +
    'and where no task needed it — the listing is read only when at least one ' +
    'task names its credential by id alone, and a system whose tasks all ' +
    'carry their credential in full never calls it. This tool reports nothing ' +
    'about how replication is GOING: `replication_status` is where a task\'s ' +
    'state, last run, error and enabled switch are, for the same tasks under ' +
    'the same `id`. The netcat listen and connect addresses an `SSH+NETCAT` ' +
    "task also carries are not reported; the peer above is the SSH credential's " +
    'host either way.',
  inputSchema: { type: 'object', properties: {} },
  requiredRole: Role.ReadOnly,
  mutating: false,
  async handler({ system }) {
    // No filters and no options, as `replication_status` reads the same method:
    // a system holds tens of replication tasks at most, and every field read
    // here is part of a task row as it stands.
    const tasks = await firstValueFrom(system.client.api.query('replication.query'));
    const sources = tasks.map((task) => {
      // Read once and passed to `peerSource`, so that the transport reported
      // and the decision that a task is local cannot be two different readings
      // of the same field.
      const transport = textOrNull(task.transport);
      return {
        task: {
          id: numberOrNull(task.id),
          name: textOrNull(task.name),
          direction: textOrNull(task.direction),
          transport,
          source_datasets: strictTextList(task.source_datasets),
          target_dataset: textOrNull(task.target_dataset),
        },
        peer: peerSource(transport, task.ssh_credentials),
      };
    });
    // The second read is made only where a task actually needs it. The pinned
    // client embeds the whole credential in the task row, so on most systems
    // there is nothing to look up and this tool is one call — and a listing
    // that was never read reports no reason for not having been.
    const lookup: CredentialLookup = sources.some((source) => source.peer.kind === 'lookup')
      ? await readCredentials(system)
      : { peers: new Map(), error: null };
    return {
      credentials_unavailable: lookup.error,
      tasks: sources.map(({ task, peer }) => ({ ...task, ...resolvePeer(peer, lookup) })),
    };
  },
};
