import { firstValueFrom } from 'rxjs';
import { Role } from '@/interfaces';
import { ReadOnlyTool } from '@/catalog/tool';
import { errorText, numberOrNull, recordOrNull, textOrNull } from '@/tools/common';

/**
 * NFS family: who is reaching the system over NFS right now.
 *
 * This is live state from the running service, not configuration. `shares_list`
 * says an NFS export exists and `share_access` says who is permitted to reach
 * it; neither can say whether anything is actually mounted. That asymmetry is
 * the reason this file exists: `iscsi_list` reads `iscsi.global.sessions` and
 * reports the initiators connected to each target, and NFS had no equivalent —
 * "is anyone using this?" was answerable for one protocol and not the other.
 *
 * It is its own family rather than a third tool in `shares.ts` because the
 * subject is different. `shares.ts` merges SMB and NFS into one list of what is
 * offered, on the ground that a person asking what a NAS shares is not asking a
 * question about protocols. This asks the opposite kind of question, and the
 * protocol is the whole of the answer: the two NFS versions do not share a row
 * shape, do not mean the same thing by "client", and are read from two separate
 * middleware calls that fail independently.
 *
 * THE TWO VERSIONS ANSWER DIFFERENT QUESTIONS, AND THAT IS NOT A DEFECT IN THE
 * MAPPING. NFSv3 is stateless: the server holds no session, so the most it can
 * report is which host has which export, and `NFSGetNfs3ClientsEntry` is
 * exactly `{ ip, export }`. NFSv4 is not: a client registers with the server,
 * is given an identity, and holds open state against it, which is what
 * `NFSGetNfs4ClientsEntry`'s `id`, `info` and `states` describe. Merging them
 * into one row type would have to drop one side's vocabulary or invent the
 * other's, so they are two lists.
 *
 * WHAT THIS FAMILY DELIBERATELY DOES NOT DO:
 *
 * - **It states no verdict.** A live-session list states facts and draws no
 *   conclusion (#47): "safe to take this share offline" is a reading of these
 *   rows, not a field in them.
 * - **It does not read whether the NFS service is running.** `service.query` is
 *   `services_status`, and reading it here would be a second opinion about a
 *   subject another tool already owns. The description points a caller at it,
 *   which is what the null/empty distinction below cannot settle on its own.
 * - **It does not read `nfs.config`, `nfs.client_count` or the exports.** The
 *   settings are a different question, a total is not attributable to a client,
 *   and the exports are `shares_list`.
 * - **It does not disconnect anything.** No tool here is mutating.
 */

/** Which of the two independent reads a failure came from. */
type Source = 'nfsv3' | 'nfsv4';

/**
 * One read that failed, and why.
 *
 * Reported rather than thrown because the two reads fail independently: a
 * system serving NFSv4 alone can reject the v3 call, and losing the v4 clients
 * with it would answer half a question as none.
 */
interface Failure {
  source: Source;
  error: string;
}

/** A read that produced rows, or the failure that stopped it. */
interface Attempt<T> {
  value: T[] | null;
  failure: Failure | null;
}

/** What a read that answered with something other than a list is reported as. */
const NOT_A_LIST = 'the system answered with something other than a list of clients';

/**
 * One read, with a failure caught and named rather than thrown.
 *
 * The read is passed as a thunk so the call is made inside the `try`, which
 * keeps this correct for a read that throws before it returns a promise at all.
 *
 * A rejection is not the only way a read can fail to produce clients: the
 * client's own types declare both of these calls as answering a union that
 * includes a bare row and a count, and a declared type is a claim about what the
 * middleware sends rather than the value received. So an answer that is not a
 * list is caught here and reported exactly like a rejection — the alternative is
 * a `.map` throwing out of the handler, which would take THE OTHER VERSION'S
 * ANSWER DOWN WITH IT and is the one thing the two reads being independent is
 * meant to prevent.
 */
async function readClients<T>(source: Source, read: () => Promise<T[]>): Promise<Attempt<T>> {
  try {
    const rows: unknown = await read();
    if (!Array.isArray(rows)) return { value: null, failure: { source, error: NOT_A_LIST } };
    return { value: rows as T[], failure: null };
  } catch (reason) {
    return { value: null, failure: { source, error: errorText(reason) } };
  }
}

/**
 * One NFSv3 mount the server reported: a host, and the export it has.
 *
 * One entry per pair rather than one grouped entry per host. `iscsi_list`
 * groups its sessions because multipath reports one logical initiator several
 * times and the duplicates are an artefact; here they are not duplicates — a
 * host with three exports mounted has three separate facts about it, each of
 * which a caller acting on one export needs on its own.
 *
 * Both fields are declared `string` and required by the client, and both are
 * read through a guard anyway — as is the row itself, which is why this reads
 * an `unknown` rather than the declared entity: a declared type is a claim
 * about what the middleware sends, not the value received, and a row that is
 * not an object at all would otherwise throw on the first field and take the
 * NFSv4 answer with it. Neither field is dropped when the other is unreadable,
 * because a row leaving this list entirely would shorten it towards "nobody has
 * this mounted", which is more than the read established (#93).
 */
interface Nfsv3Client {
  ip: string | null;
  export: string | null;
}

/** One NFSv3 row, read through the same guards its NFSv4 sibling uses. */
function readNfsv3Client(client: unknown): Nfsv3Client {
  const record = recordOrNull(client) ?? {};
  return { ip: textOrNull(record['ip']), export: textOrNull(record['export']) };
}

/**
 * One NFSv4 client the server has registered, and what it is holding.
 *
 * `id` is the server's own identifier for the client, and is the only field
 * whose CONTENT the client's types describe: `info` and `states` are declared
 * too, as a record of unknown content and a list of them, which says a shape
 * and nothing about what is inside. Everything below `id` is read out of those
 * two — see `INFO_KEYS` for why the key names are the risk in this file.
 */
interface Nfsv4Client {
  id: string | null;
  address: string | null;
  status: string | null;
  seconds_from_last_renew: number | null;
  minor_version: number | null;
  state_count: number | null;
  state_types: string[] | null;
  unreported_info_fields: string[] | null;
  unreported_state_fields: string[] | null;
}

/**
 * The `info` keys this tool reads, in one place because they are used twice —
 * once to read the value, once to work out which keys were left unreported.
 *
 * THESE KEY NAMES ARE THE UNCONFIRMED PART OF THIS FILE. `info` arrives as
 * `Record<string, unknown>`: the client's types say a record is there and
 * nothing whatever about what is in it, and no live system was available to
 * read one off. The names below are the labels the Linux NFS server publishes
 * per client, which is where the middleware's record comes from, spaces and
 * all — they are a considered guess and not an observation.
 *
 * Guessing wrong costs nulls rather than wrong answers, and it is visible:
 * every key the record actually carried and this tool does not read is reported
 * by name in `unreported_info_fields`, so a caller seeing four nulls beside a
 * full list of unreported names is looking at an allowlist that needs the real
 * names, not at a client the server knows nothing about. That is what makes
 * this safe to ship without a live system to check it against — and correcting
 * the names later is a change here and in nothing else.
 */
const INFO_KEYS = {
  address: 'address',
  status: 'status',
  renew: 'seconds from last renew',
  minorVersion: 'minor version',
} as const;

/** The one key of a state entry this tool reads, held for the same two uses. */
const STATE_TYPE_KEY = 'type';

/**
 * The keys of a record that this tool does not report, by name and never by
 * value.
 *
 * A key name is not a value: forwarding the record would put a field a later
 * TrueNAS release adds into a tool result unannounced, which is what the
 * allowlist convention exists to stop, while naming the keys tells a caller
 * what was there without saying what it said. That is the whole of what makes
 * an unconfirmed allowlist checkable from the outside.
 *
 * Sorted so two systems reporting the same keys in a different order answer
 * identically.
 */
function unreportedKeys(record: Record<string, unknown>, read: readonly string[]): string[] {
  return Object.keys(record)
    .filter((key) => !read.includes(key))
    .sort();
}

/** Every `info` key this tool reads, derived from the map rather than restated. */
const READ_INFO_KEYS: readonly string[] = Object.values(INFO_KEYS);

/**
 * The `states` half of one client: how much state it holds, of what kinds, and
 * which keys of a state entry went unread.
 *
 * `count` is every entry, including one this tool could not read at all —
 * dropping such an entry would run the count towards zero, and zero is the one
 * positive claim this side makes ("registered, holding nothing"), so an entry
 * that could not be read still counts (#93). `types` is the other way round: it
 * is descriptive rather than the claim, so an entry whose type could not be
 * read simply does not name a type, and a non-zero `count` beside an empty
 * `types` is a client holding state this tool could not name.
 */
interface States {
  count: number | null;
  types: string[] | null;
  unreported: string[] | null;
}

/** What a client's `states` field says, or three nulls where it was not a list. */
function readStates(value: unknown): States {
  if (!Array.isArray(value)) return { count: null, types: null, unreported: null };
  const types = new Set<string>();
  const unreported = new Set<string>();
  for (const entry of value) {
    const record = recordOrNull(entry);
    if (record === null) continue;
    const type = textOrNull(record[STATE_TYPE_KEY]);
    if (type !== null) types.add(type);
    for (const key of unreportedKeys(record, [STATE_TYPE_KEY])) unreported.add(key);
  }
  return {
    count: value.length,
    types: [...types].sort(),
    unreported: [...unreported].sort(),
  };
}

/** One NFSv4 row, with both open records read through the allowlist above. */
function readNfsv4Client(client: unknown): Nfsv4Client {
  const record = recordOrNull(client) ?? {};
  const info = recordOrNull(record['info']);
  const states = readStates(record['states']);
  return {
    id: textOrNull(record['id']),
    address: textOrNull(info?.[INFO_KEYS.address]),
    // Reported as the word the server used. The vocabulary is the NFS server's
    // and is not closed, so it is not coerced into a set this file invented.
    status: textOrNull(info?.[INFO_KEYS.status]),
    // The unit is in the field name because the server's own key states it
    // (#96); where that key is absent this is null and no unit is asserted
    // about anything.
    seconds_from_last_renew: numberOrNull(info?.[INFO_KEYS.renew]),
    minor_version: numberOrNull(info?.[INFO_KEYS.minorVersion]),
    state_count: states.count,
    state_types: states.types,
    // Null rather than empty where `info` was not a record at all: empty says
    // the record was read and every key it carried is reported above, which is
    // a different answer from not having read it.
    unreported_info_fields: info === null ? null : unreportedKeys(info, READ_INFO_KEYS),
    unreported_state_fields: states.unreported,
  };
}

export const nfsClients: ReadOnlyTool = {
  name: 'nfs_clients',
  description:
    'The clients reaching this system over NFS right now, read from the ' +
    'running service rather than from configuration. `shares_list` says which ' +
    'NFS exports exist and `share_access` says who is permitted to reach ' +
    'them; neither says whether anything is mounted, which is what this ' +
    'answers. THE TWO NFS VERSIONS ARE REPORTED AS TWO SEPARATE LISTS AND MEAN ' +
    'DIFFERENT THINGS BY "CLIENT" — read the one that applies rather than ' +
    'adding their lengths. `nfsv3` is a list of MOUNTS, not of sessions: ' +
    'NFSv3 is stateless and the server holds no session for a client, so each ' +
    'entry is a host `ip` and one `export` it has, and A HOST WITH SEVERAL ' +
    'EXPORTS MOUNTED APPEARS ONCE PER EXPORT — the length of this list is a ' +
    'number of mounts, never a number of hosts. Because there is no session, ' +
    'an entry is not evidence that the host is doing anything right now, and ' +
    'this tool cannot say how recently it was used. Either field is null where ' +
    'the system reported no value this tool could read; such a row is still ' +
    'listed rather than dropped, because a shorter list would say the mount is ' +
    'not there. `nfsv4` is the registered clients, which the server does track. ' +
    '`id` is the identifier the server knows the client by, and is null where ' +
    'the system reported none this tool could read — a row whose `id` is null ' +
    'is a client the server did not name, not one with no identity. `address` ' +
    'is where it connects from and `status` the word the server used, ' +
    'reported verbatim — THE SET OF WORDS IS NOT CLOSED and one not recognised ' +
    'means the server said something this tool has no reading of. ' +
    '`seconds_from_last_renew` is how long ago the client last renewed its ' +
    'lease, in seconds because the server names that unit itself. ' +
    '`minor_version` is the NFSv4 minor version it negotiated. `state_count` ' +
    'is how many pieces of open state the client holds — opens, locks, ' +
    'delegations — and `state_types` the distinct kinds among them. A ' +
    '`state_count` of 0 is a client that is registered and holding nothing ' +
    'open, which is a different answer from the client not being listed; a ' +
    'non-zero `state_count` beside an empty `state_types` is state this tool ' +
    'could not name rather than state of no kind. BOTH ARE NULL, RATHER THAN 0 ' +
    'AND EMPTY, where the system reported the state list as something other ' +
    'than a list: that is a client whose open state was not read at all, and ' +
    'reading it as one holding nothing open is the one wrong answer here. THE ' +
    'NFSv4 FIELD NAMES ABOVE ' +
    'ARE READ OUT OF TWO OPEN RECORDS AND ARE UNCONFIRMED. The client library ' +
    'types `info` and `states` as records of unknown content, so the keys this ' +
    'tool looks for were taken from what the Linux NFS server publishes and ' +
    'have not been checked against a live system. Nothing from either record ' +
    'is passed through: `unreported_info_fields` and `unreported_state_fields` ' +
    'name — by key name only, never by value — every key the records actually ' +
    'carried that this tool does not report. IF THE NAMED FIELDS ARE ALL NULL ' +
    'AND THOSE LISTS ARE FULL, the keys are spelled differently on this system ' +
    'and the values are in there under the names listed; report that rather ' +
    'than reading the nulls as a client the server knows nothing about. Both ' +
    'are null where the record was not a record at all, and empty where it was ' +
    'read and every key it carried is reported. `nfsv3` AND `nfsv4` ARE NULL ' +
    'WHEN THAT VERSION COULD NOT BE READ and empty when it was read and no ' +
    'client was found — never the same answer. The two reads are independent, ' +
    'so a failure of one does not stop the other answering — including a row ' +
    'this tool could not read, which is reported with its fields null rather ' +
    'than raised. `failures` names each read that did not produce a list of ' +
    'clients, as `source` (`nfsv3` or `nfsv4`) and `error`: a read that was ' +
    'rejected carries the reason the system gave, and one that answered with ' +
    'something other than a list says so. ' +
    'ON A SYSTEM WITH THE NFS SERVICE STOPPED THIS TOOL ANSWERS RATHER THAN ' +
    'FAILING, but which answer it gives depends on the middleware and has not ' +
    'been confirmed: where the call is rejected, that list is null with the ' +
    'reason in `failures`; where the call instead succeeds with no rows, the ' +
    'list is empty AND IS INDISTINGUISHABLE HERE FROM A RUNNING SERVICE NOBODY ' +
    'IS CONNECTED TO. `services_status` reports whether the `nfs` service is ' +
    'running and is what to read before treating an empty list as "nobody is ' +
    'using this". This tool states facts and no verdict: whether a share can ' +
    'be taken offline or a service restarted is a reading of these rows and is ' +
    'not a field in them. It does not report NFS export configuration, which ' +
    'is `shares_list`, does not report the NFS service settings, does not ' +
    'report SMB or iSCSI sessions — those are `iscsi_list` for iSCSI and are ' +
    'not available for SMB — and does not disconnect anything.',
  inputSchema: { type: 'object', properties: {} },
  requiredRole: Role.ReadOnly,
  mutating: false,
  async handler({ system }) {
    // Both reads are issued before either is awaited, so neither waits on the
    // other, and neither is allowed to fail the tool: they are two independent
    // answers rather than one answer and its detail, so a system that reports
    // its NFSv4 clients and rejects the NFSv3 call has half an answer worth
    // returning — which is what `failures` names.
    const [v3, v4] = await Promise.all([
      readClients('nfsv3', () => firstValueFrom(system.client.api.query('nfs.get_nfs3_clients'))),
      readClients('nfsv4', () => firstValueFrom(system.client.api.query('nfs.get_nfs4_clients'))),
    ]);

    const failures: Failure[] = [];
    if (v3.failure !== null) failures.push(v3.failure);
    if (v4.failure !== null) failures.push(v4.failure);

    return {
      nfsv3: v3.value === null ? null : v3.value.map(readNfsv3Client),
      nfsv4: v4.value === null ? null : v4.value.map(readNfsv4Client),
      failures,
    };
  },
};
