import { firstValueFrom } from 'rxjs';
import { Role } from '@/interfaces';
import { MutatingTool, PlanStep, ReadOnlyTool, SystemHandle, ToolContext } from '@/catalog/tool';
import {
  agreement,
  booleanOrNull,
  errorText,
  isMissingMethod,
  NONE_REPORTED,
  numberOrNull,
  plural,
  readStep,
  recordOrNull,
  rowWithId,
  strictTextList,
  switchOutcome,
  switchSentence,
  textOrNull,
} from '@/tools/common';

/**
 * Shares family: what the system offers to the network, and where from.
 *
 * SMB and NFS are two independent middleware namespaces — `sharing.smb.query`
 * and `sharing.nfs.query` — and nothing in either mentions the other. A person
 * asking what a NAS shares is not asking a question about protocols, though, so
 * the two are read together and merged into one list with a `protocol` field on
 * each entry. iSCSI and NVMe-oF are deliberately not here: they export block
 * devices rather than filesystem paths, and their vocabulary of targets,
 * extents and namespaces answers a different question.
 */

/** The protocols this tool reads. */
type Protocol = 'SMB' | 'NFS';

/**
 * One share, however it is shared. Every field is named explicitly rather than
 * spread from the row, so a field a later TrueNAS release adds to either
 * namespace does not reach the caller without a change here.
 */
interface Share {
  protocol: Protocol;
  id: number;
  name: string | null;
  path: string | null;
  enabled: boolean | null;
  comment: string | null;
}

/**
 * One protocol whose shares could not be listed, and why.
 *
 * The point of reporting rather than throwing is that the two queries fail
 * independently: an SMB service that is not running says nothing about the NFS
 * exports, and losing those as well would answer half a question as none.
 */
interface Failure {
  protocol: Protocol;
  error: string;
}

/** One protocol's shares, or the failure that stopped them being read. */
interface Attempt {
  rows: AccessTarget[];
  failure: Failure | null;
}

/**
 * `textOrNull` from `common.ts` reads a share's comment, which the middleware
 * sends as `""` when it is unset.
 *
 * `errorText` is `common.ts`'s too, and taking it changed what this file
 * reports. The copy that lived here read an `Error` and a bare string and
 * nothing else, so a rejection that arrived as a middleware error object — the
 * `{ reason }` and `{ message }` carriers the client documents, and what a
 * failed `sharing.smb.query` actually rejects with — reported as having said
 * nothing. Every sibling file read those two carriers; this one had lost the
 * branch. A `failures` entry here now names the reason where the system gave
 * one, which is what it always claimed to do.
 */

/**
 * What an NFS export says about who may reach it, beyond the ACL on its path.
 *
 * These are read from the export row rather than from a second call, and they
 * are here because each of them can make the path's ACL overstate what someone
 * actually gets: the restrictions decide which machines may mount it at all,
 * and the map fields replace the id that arrives before the ACL is ever
 * consulted.
 */
interface NfsExport {
  hosts: string[] | null;
  networks: string[] | null;
  mapall_user: string | null;
  mapall_group: string | null;
  maproot_user: string | null;
  maproot_group: string | null;
}

/**
 * What an SMB share says about which machines may reach it, beyond its ACLs.
 *
 * The SMB service applies these before either ACL is consulted, so a share
 * whose ACLs grant everyone can still be reachable by almost nobody. They live
 * under the share's `options`, whose shape differs by what the share is for —
 * the client's directory declares them on the legacy shape alone, while the
 * middleware accepts them on the others — so `options` is read as an untyped
 * record for the same reason an ACL entry is: a key one variant lacks would
 * need narrowing that the row itself is what decides.
 */
interface SmbShare {
  hosts_allow: string[] | null;
  hosts_deny: string[] | null;
}

/**
 * One share, with everything the share record itself says about reaching it.
 *
 * Both tools in this family read the same two queries, so this is what those
 * queries produce and `shares_list` takes the `share` half of it. One mapping
 * per protocol rather than two: two would drift, and the drift would show as
 * one tool naming a share differently from the other.
 */
interface AccessTarget {
  share: Share;
  /** Read-only however the ACL reads, or null where the switch was not readable. */
  readOnly: boolean | null;
  smb: SmbShare | null;
  nfs: NfsExport | null;
}

/**
 * One host, network or address-pattern restriction list, on either protocol.
 *
 * Only a list the share actually carries is reported. `[]` says the share
 * restricts nothing of that kind and ANY machine may reach it, which is the
 * strongest claim this function makes — so it is made only where the system
 * sent an empty list and said so. An absent field is not that: the field is
 * optional on the client's own types, so its absence is a middleware that did
 * not report the restriction rather than a share that has none, and reading
 * the two as one would fail open in the direction that matters here.
 *
 * The list is also reported whole or not at all: dropping the entries that
 * could not be read would answer with a narrower restriction than the share
 * carries, and dropping all of them would answer `[]`, which again means the
 * opposite.
 */
function restrictionList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const restrictions = value.filter(
    (item): item is string => typeof item === 'string' && item.length > 0,
  );
  return restrictions.length === value.length ? restrictions : null;
}

/**
 * The host rules on an SMB share, read out of its `options`.
 *
 * A share whose options could not be read reports both lists null, which by
 * the rule above is "no list this tool could read" rather than a share that
 * restricts nothing — the same reading an absent field gets, and the only one
 * that does not turn an unread gate into an open one.
 */
function smbHostRules(options: unknown): SmbShare {
  const record =
    options !== null && typeof options === 'object' ? (options as Record<string, unknown>) : {};
  return {
    hosts_allow: restrictionList(record['hostsallow']),
    hosts_deny: restrictionList(record['hostsdeny']),
  };
}

/** Every SMB share the system holds. */
async function smbTargets(system: SystemHandle): Promise<AccessTarget[]> {
  // No filters and no options: a system holds tens of shares at most, and every
  // field this tool reads is part of a share row as it stands. No `select`
  // either — unlike a job row, a share row carries no credential and nothing
  // unbounded, and the mapping below is what decides what a caller sees.
  const shares = await firstValueFrom(system.client.api.query('sharing.smb.query'));
  return shares.map((share) => ({
    share: {
      protocol: 'SMB' as const,
      id: share.id,
      name: textOrNull(share.name),
      // `EXTERNAL` is passed through as the system spelled it: an external share
      // is a redirection to another server rather than a path on this one, and
      // reporting null there would read as a path that could not be found.
      path: textOrNull(share.path),
      // Optional on the client's own type, so a middleware that omits it reports
      // null rather than a default. Not defaulted either way: a share whose
      // switch cannot be read must not be presented as definitely on or off.
      enabled: share.enabled ?? null,
      comment: textOrNull(share.comment),
    },
    readOnly: share.readonly ?? null,
    // `options` is where the SMB share's host rules moved: the row the client
    // returns declares `hostsallow`/`hostsdeny` on the legacy option shape, and
    // the middleware takes them on the others too, so they are read from the
    // object whatever the share is for rather than only where a type says to
    // expect them. Naming `options` here is what makes a rename of that field a
    // compile error; the keys inside it differ by variant and are read as data.
    smb: smbHostRules(share.options),
    // Null rather than an empty set: an NFS export's restrictions and id
    // mapping are a different protocol's record, and there is nothing on an SMB
    // share to fill them with.
    nfs: null,
  }));
}

/** Every NFS export the system holds. */
async function nfsTargets(system: SystemHandle): Promise<AccessTarget[]> {
  const shares = await firstValueFrom(system.client.api.query('sharing.nfs.query'));
  return shares.map((share) => ({
    share: {
      protocol: 'NFS' as const,
      id: share.id,
      // An NFS export has no name. The middleware identifies one by the path it
      // exports and carries no name field at all, so this is null on every NFS
      // share — a fact about the protocol rather than about this system. Not the
      // path repeated under a second key, which would read as a name somebody
      // chose.
      name: null,
      path: textOrNull(share.path),
      enabled: share.enabled ?? null,
      comment: textOrNull(share.comment),
    },
    readOnly: share.ro ?? null,
    // An NFS export is not served by the SMB service, so it has no host rules
    // of that kind rather than unread ones.
    smb: null,
    nfs: {
      hosts: restrictionList(share.hosts),
      networks: restrictionList(share.networks),
      mapall_user: textOrNull(share.mapall_user),
      mapall_group: textOrNull(share.mapall_group),
      maproot_user: textOrNull(share.maproot_user),
      maproot_group: textOrNull(share.maproot_group),
    },
  }));
}

/**
 * One protocol's shares, with a failure caught and named rather than thrown.
 *
 * The read is passed as a thunk so that the call is made inside the `try`,
 * which keeps this correct for a read that throws before it returns a promise
 * at all. Neither caller can: both are `async`, so a throw anywhere inside them
 * arrives as a rejection.
 */
async function attempt(
  protocol: Protocol,
  read: () => Promise<AccessTarget[]>,
): Promise<Attempt> {
  try {
    return { rows: await read(), failure: null };
  } catch (reason) {
    return { rows: [], failure: { protocol, error: errorText(reason) } };
  }
}

export const sharesList: ReadOnlyTool = {
  name: 'shares_list',
  description:
    'Every SMB and NFS share on the system, in one list. `protocol` is `SMB` ' +
    'or `NFS` and says which of the two the share is served by; the two are ' +
    'separate configurations in TrueNAS and a path can be shared over both at ' +
    'once, appearing here once per protocol. `id` is the share\'s numeric ' +
    'identity WITHIN ITS PROTOCOL — an SMB share and an NFS export can carry ' +
    'the same id, so a share is identified by `protocol` and `id` together. ' +
    '`name` is the SMB share name, the name clients connect to. It is ALWAYS ' +
    'null on an NFS export: NFS identifies an export by the path it exports ' +
    'and the system holds no name for one, so a null there is a fact about the ' +
    'protocol rather than a share nobody named. `path` is the filesystem path ' +
    'being shared, which matches `mountpoint` in `storage_list_datasets` where ' +
    'the share is of a dataset. On an SMB share it can instead be the literal ' +
    '`EXTERNAL`, which is a share that redirects clients to another server ' +
    'rather than serving a path on this one. It is null only where the system ' +
    'reported no path at all. `enabled` is whether the share is switched on. A ' +
    'disabled share is LISTED and reported `enabled: false` rather than ' +
    'omitted, because a share nobody switched back on is exactly the one worth ' +
    'finding; null is a switch the system reported no value for, which is not ' +
    'the same answer as false. `comment` is the description the share was ' +
    'given and is null where it has none. `failures` reports a protocol whose ' +
    'query failed, as `protocol` and `error`. It is empty when both were read. ' +
    'WHILE IT IS NOT EMPTY THE LIST IS INCOMPLETE: every share of the protocol ' +
    'named there is missing, and a share not appearing is not evidence that it ' +
    'does not exist. One protocol failing does not hide the other, which is ' +
    'why the failure is reported here instead of being raised — but if neither ' +
    'could be read this tool raises an error rather than answering with an ' +
    'empty list. This tool says what is shared and from where, not who may ' +
    'reach it: the SMB share ACL and the NFS host and network restrictions are ' +
    'not among these fields. iSCSI targets and NVMe-oF subsystems are not ' +
    'shares in this sense and are not listed.',
  inputSchema: { type: 'object', properties: {} },
  requiredRole: Role.ReadOnly,
  mutating: false,
  async handler({ system }) {
    // Both queries are issued before either is awaited, so the second is not
    // waiting on the first, and neither can take the other down.
    const attempts = await Promise.all([
      attempt('SMB', () => smbTargets(system)),
      attempt('NFS', () => nfsTargets(system)),
    ]);
    const shares: Share[] = [];
    const failures: Failure[] = [];
    for (const attempted of attempts) {
      // The share half only. What an export restricts and whom it maps is read
      // by the same query and belongs to `share_access`; this tool's own
      // description says those fields are not among the ones it returns.
      shares.push(...attempted.rows.map((target) => target.share));
      if (attempted.failure !== null) failures.push(attempted.failure);
    }
    // Nothing was read, so there is no partial answer to preserve. An empty
    // `shares` beside a `failures` a caller did not check reads as a system
    // that shares nothing, which is the one wrong answer here that a model
    // would repeat as fact — and every other tool in this catalog raises when
    // its own query fails.
    if (failures.length === attempts.length) {
      throw new Error(
        `no share could be listed: ${failures
          .map((failure) => `${failure.protocol}: ${failure.error}`)
          .join('; ')}`,
      );
    }
    return { shares, failures };
  },
};

/**
 * Who may reach one share, and with what rights.
 *
 * `shares_list` says what is shared and from where. This says who can get at
 * it, and the answer is in several places depending on the protocol — none of
 * them the share record on its own:
 *
 *     SMB   the share's own host rules, which decide which MACHINES may
 *           connect; the share-level ACL, a second gate on who may; and the
 *           filesystem ACL on the shared path, which is what decides what each
 *           user may do once a client has connected
 *     NFS   the export's own host and network restrictions, which decide which
 *           MACHINES may mount it at all, and then that same filesystem ACL,
 *           which decides what the ids arriving over the mount may do
 *
 * So the filesystem ACL is read for both, the share-level ACL and host rules
 * for SMB, and the restrictions for NFS. No half is presented as the whole
 * answer: access is the narrowest of all of them.
 */

/** Which share the caller asked about. */
interface Selector {
  share: string;
  protocol: Protocol | null;
}

/** One entry of the ACL on a share's path: a principal, and what it grants. */
interface AccessEntry {
  tag: string | null;
  name: string | null;
  id: number | null;
  access: 'ALLOW' | 'DENY' | null;
  permissions: string[] | null;
  children_only: boolean | null;
}

/** The ACL on a share's path, as this tool presents it. */
interface Acl {
  type: string | null;
  trivial: boolean | null;
  owner_user: string | null;
  owner_uid: number | null;
  owner_group: string | null;
  owner_gid: number | null;
  entries: AccessEntry[] | null;
}

/**
 * The numeric id of an ACL entry's principal, or null where the entry names no
 * principal by id.
 *
 * TrueNAS writes `-1` on an entry whose tag IS the principal — `owner@`,
 * `group@`, `everyone@` — so a negative id is an absent one rather than an
 * account nobody could resolve. Reporting it verbatim would put a uid in the
 * result that no user has.
 */
function principalId(value: unknown): number | null {
  const id = numberOrNull(value);
  return id === null || id < 0 ? null : id;
}

/**
 * The permissions one ACL entry grants, by name, or null where the entry's
 * permissions could not be read.
 *
 * Three shapes reach here and all three are the middleware's own vocabulary
 * rather than one invented in this file: an NFS4 preset (`{ BASIC:
 * 'FULL_CONTROL' }`), an NFS4 permission set (`{ READ_DATA: true, … }`), and a
 * POSIX one (`{ READ: true, WRITE: false, EXECUTE: true }`). The last two are
 * the same shape, so one pass over the true keys covers both.
 *
 * An empty list is an entry that names permissions and holds none of them —
 * `{ READ: false, WRITE: false, EXECUTE: false }`, which a POSIX `OTHER` entry
 * really does carry. That is not the same as a permission set that could not be
 * read, and a caller reviewing access must not see the second as the first and
 * conclude the entry grants nothing. So a set naming no permission this tool
 * can read AT ALL — an empty object, or one whose every value is something
 * other than a boolean — is unreadable rather than empty.
 */
function permissionNames(perms: unknown): string[] | null {
  if (perms === null || typeof perms !== 'object') return null;
  const record = perms as Record<string, unknown>;
  // A preset names one permission rather than a set of them, and a preset whose
  // name cannot be read leaves the entry unreadable rather than empty: it is
  // known to grant something, and what it grants is exactly what was lost.
  if ('BASIC' in record) {
    const basic = textOrNull(record['BASIC']);
    return basic === null ? null : [basic];
  }
  const names = Object.keys(record);
  if (names.length === 0) return null;
  // Whole or nothing, as a restriction list is: reporting the readable ones
  // alone would answer with a definite, narrower set of rights than the entry
  // carries, and a caller cannot tell that from an entry that really holds
  // only those.
  if (!names.every((name) => typeof record[name] === 'boolean')) return null;
  return names.filter((name) => record[name] === true);
}

/**
 * Whether an entry grants nothing on the path itself and exists only to be
 * inherited by what is created inside it, or null where that could not be read.
 *
 * Both ACL types have this and spell it differently: POSIX marks the entry
 * `default`, NFS4 sets `INHERIT_ONLY` among its flags. It is reported because
 * such an entry looks exactly like access to the share and is not — listing its
 * principal without saying so would answer "who can reach this" with a name
 * that cannot. An NFS4 preset flag is `INHERIT` or `NOINHERIT`, and neither is
 * inherit-only, so a preset always reads false.
 */
function childrenOnly(ace: Record<string, unknown>): boolean | null {
  if (typeof ace['default'] === 'boolean') return ace['default'];
  const flags = ace['flags'];
  if (flags === null || typeof flags !== 'object') return null;
  const record = flags as Record<string, unknown>;
  if ('BASIC' in record) return textOrNull(record['BASIC']) === null ? null : false;
  const inheritOnly = record['INHERIT_ONLY'];
  // Absent is a flag that is not set, which the middleware states by omission.
  // Present but not a boolean is a flag that could not be read, and answering
  // false there would assert the entry grants access on the path — the claim
  // this field exists to avoid making by accident.
  if (inheritOnly === undefined) return false;
  return typeof inheritOnly === 'boolean' ? inheritOnly : null;
}

/**
 * One ACL entry, mapped field by field.
 *
 * The row is read as an untyped record rather than through the client's
 * `NFS4ACE | POSIXACE` union: the two differ in which keys they carry, so every
 * read of a key one of them lacks would need narrowing that the entry itself is
 * what decides. An entry that is not an object at all is reported with every
 * field null rather than dropped — a principal this tool cannot read is still a
 * principal on the path, and dropping it would answer with a shorter list that
 * reads as complete.
 */
function accessEntry(ace: unknown): AccessEntry {
  const row = ace !== null && typeof ace === 'object' ? (ace as Record<string, unknown>) : {};
  const access = row['type'];
  return {
    tag: textOrNull(row['tag']),
    name: textOrNull(row['who']),
    id: principalId(row['id']),
    access: access === 'ALLOW' || access === 'DENY' ? access : null,
    permissions: permissionNames(row['perms']),
    children_only: childrenOnly(row),
  };
}

/**
 * The ACL response, mapped to the fields this tool names.
 *
 * The parameter names the fields it reads rather than taking a record, so that
 * a client-directory bump renaming one of them is a compile error here. The
 * three ACL result shapes the call can answer with all carry these, and the
 * runtime guards below stay because the response is still data: the type says
 * the field is there, not that the system filled it sensibly.
 */
function mapAcl(row: {
  acltype: string;
  trivial: boolean;
  user: string | null;
  group: string | null;
  uid: number | null;
  gid: number | null;
  acl: unknown;
}): Acl {
  return {
    type: textOrNull(row.acltype),
    trivial: typeof row.trivial === 'boolean' ? row.trivial : null,
    owner_user: textOrNull(row.user),
    owner_uid: numberOrNull(row.uid),
    owner_group: textOrNull(row.group),
    owner_gid: numberOrNull(row.gid),
    // Keyed on the type, not on the shape of `acl`, because the two say
    // different things and only the type is authoritative about which. A
    // `DISABLED` path has no ACL in force whatever list arrives beside it, so
    // reporting the `[]` the middleware answers empty lists with would read as
    // an ACL that grants nobody anything when access is really governed by the
    // mode bits this tool does not read. Otherwise null is a list that could
    // not be read, and an empty list is an ACL that holds no entry.
    entries:
      row.acltype === 'DISABLED' || !Array.isArray(row.acl)
        ? null
        : (row.acl as unknown[]).map(accessEntry),
  };
}

/**
 * The ACL on a share's path, or the reason there is none to report.
 *
 * A failure is returned rather than thrown because for an NFS export the host
 * and network restrictions still answer half the question, and for an SMB share
 * the share's own identity is still worth returning beside a stated reason. The
 * one thing that must not happen is an empty entry list standing in for an
 * unread one.
 */
async function readAcl(
  system: SystemHandle,
  share: Share,
): Promise<{ acl: Acl | null; error: string | null }> {
  if (share.path === null) {
    return { acl: null, error: 'the system reported no path for this share, so it has no ACL' };
  }
  if (share.path === 'EXTERNAL') {
    return {
      acl: null,
      error:
        'this share redirects clients to another server rather than serving a path on this ' +
        'system, so the rights it gives are held there and not here',
    };
  }
  try {
    // `simplified` collapses a permission set the middleware can name as a
    // preset into that preset, which is the same fact in one word instead of
    // fourteen booleans; `resolve_ids` is what turns a uid into the name the
    // result reports, and an id it cannot resolve is left for this tool to
    // report raw rather than being dropped.
    const acl = await firstValueFrom(
      system.client.api.call('filesystem.getacl', [share.path, true, true]),
    );
    return { acl: mapAcl(acl), error: null };
  } catch (reason) {
    return { acl: null, error: errorText(reason) };
  }
}

/**
 * One entry of an SMB share-level ACL: who it names, and what it does to them.
 *
 * A principal here can be named three ways and the middleware fills whichever
 * it has, so all three are reported and none stands in for another: `name` is
 * the resolved account, `id` with `kind` is the local uid or gid, and `sid` is
 * the Windows security identifier a domain principal arrives as. An entry that
 * resolved to none of them is still an entry, and is reported empty rather than
 * dropped.
 */
interface ShareAclEntry {
  name: string | null;
  id: number | null;
  kind: 'USER' | 'GROUP' | null;
  sid: string | null;
  access: 'ALLOWED' | 'DENIED' | null;
  permission: string | null;
}

/** One share-level ACL entry, mapped field by field. */
function shareAclEntry(entry: unknown): ShareAclEntry {
  const row = entry !== null && typeof entry === 'object' ? (entry as Record<string, unknown>) : {};
  const who = row['ae_who_id'];
  const identity = who !== null && typeof who === 'object' ? (who as Record<string, unknown>) : {};
  const kind = identity['id_type'];
  const access = row['ae_type'];
  return {
    name: textOrNull(row['ae_who_str']),
    id: numberOrNull(identity['id']),
    kind: kind === 'USER' || kind === 'GROUP' ? kind : null,
    sid: textOrNull(row['ae_who_sid']),
    access: access === 'ALLOWED' || access === 'DENIED' ? access : null,
    permission: textOrNull(row['ae_perm']),
  };
}

/**
 * The SMB share-level ACL, which is a second gate in front of the filesystem
 * one and can deny what the path grants.
 *
 * Read for SMB only, because it is an SMB concept: an NFS export has no such
 * layer, so both halves of the answer are null there rather than empty. As with
 * the filesystem ACL, a failure is returned rather than thrown — the rest of
 * the answer is still worth having beside a stated reason.
 */
async function readShareAcl(
  system: SystemHandle,
  share: Share,
): Promise<{ entries: ShareAclEntry[] | null; error: string | null }> {
  if (share.protocol !== 'SMB') return { entries: null, error: null };
  if (share.name === null) {
    return {
      entries: null,
      error: 'the system reported no name for this share, and the share ACL is read by name',
    };
  }
  try {
    const acl = await firstValueFrom(
      system.client.api.call('sharing.smb.getacl', [{ share_name: share.name }]),
    );
    // Named rather than read out of a record, so that a client-directory bump
    // renaming this field is a compile error rather than an answer of nulls.
    const entries: unknown = acl.share_acl;
    if (!Array.isArray(entries)) {
      // Not reported as an empty ACL: at share level an empty list of entries
      // would read as a share nobody is allowed to reach, which is the opposite
      // of what a share carrying no share-level ACL means.
      return {
        entries: null,
        error: 'the system reported no share-level ACL, so what it allows is not known here',
      };
    }
    return { entries: entries.map(shareAclEntry), error: null };
  } catch (reason) {
    return { entries: null, error: errorText(reason) };
  }
}

/** The caller's arguments, or an error naming what is wrong with them. */
function parseSelector(args: Record<string, unknown>): Selector {
  const share = textOrNull(args['share']);
  if (share === null) {
    throw new Error(
      'share is required: the name of an SMB share, or the exported path of an NFS export',
    );
  }
  const protocol = args['protocol'];
  if (protocol === undefined || protocol === null) return { share, protocol: null };
  if (protocol !== 'SMB' && protocol !== 'NFS') {
    throw new Error(`protocol must be "SMB" or "NFS", not ${JSON.stringify(protocol)}`);
  }
  return { share, protocol };
}

/**
 * Whether one share is the one asked for.
 *
 * Name or path, because the two protocols are named differently and a caller
 * asking about "the backups share" has one string either way: SMB shares carry
 * a name, and an NFS export has none at all and is identified by what it
 * exports.
 */
function selects(selector: Selector, share: Share): boolean {
  if (selector.protocol !== null && share.protocol !== selector.protocol) return false;
  return share.name === selector.share || share.path === selector.share;
}

/**
 * Why nothing matched.
 *
 * A protocol whose list could not be read is named in the message, because
 * "there is no such share" and "the share list this would have matched could
 * not be read" are different answers and only the first is a fact about the
 * system.
 */
function noMatch(selector: Selector, failures: Failure[]): Error {
  const scope = selector.protocol === null ? '' : ` ${selector.protocol}`;
  const notFound = `no${scope} share is named "${selector.share}" or exports that path`;
  if (failures.length === 0) return new Error(notFound);
  return new Error(
    `${notFound}, and it may be one that could not be looked up: ${failures
      .map((failure) => `${failure.protocol}: ${failure.error}`)
      .join('; ')}`,
  );
}

/** Why more than one share matched, and what would narrow it. */
function ambiguous(selector: Selector, matches: AccessTarget[]): Error {
  return new Error(
    `"${selector.share}" matches ${matches.length} shares — ` +
      `${matches.map((match) => `${match.share.protocol} share ${match.share.id}`).join(', ')}. ` +
      'Ask again with the protocol argument, or with the SMB share name rather than its path.',
  );
}

/**
 * The interpretation half of this tool's description (#131), hoisted so the two
 * fields cannot drift: `description` is this text appended to the selection half,
 * and `resultGuidance` is this text. One copy means a reflow cannot drop a line
 * from one of them — the round-one failure on this very literal — and the
 * follow-up that stops advertising it deletes a reference rather than 140 lines.
 *
 * **It ends at the literal's end, so it carries four sentences that are selection
 * class by `resultGuidance`'s own rule** — the pointers at `audit_config`,
 * `audit_log_query`, `share_access` and `iscsi_list`/`nvmeof_list`, plus the
 * read-only statement. A cross-tool pointer tells a caller this tool cannot
 * answer their question, which is worth knowing BEFORE choosing it. The follow-up
 * must leave those in `description` rather than deleting the whole reference.
 */
const SHARE_ACCESS_RESULT_GUIDANCE =
  '`failures` reports a protocol whose ' +
  'share list could not be read, as `protocol` and `error`, and is empty ' +
  'when both were read. WHILE IT IS NOT EMPTY THIS ANSWER MAY NOT BE THE ' +
  'ONLY ONE: the search for a second match ran over a list that was never ' +
  'read, so a share of the protocol named there may also answer to the ' +
  'string given, and the error this tool would otherwise raise is one it ' +
  'could not detect. `protocol`, `id`, `name`, `path` ' +
  'and `enabled` identify the share and mean exactly what they mean in ' +
  '`shares_list`, including that `name` is ALWAYS null on an NFS export and ' +
  'that a disabled share reaches nobody whatever the rest of this says. ' +
  'ACCESS IS THE NARROWEST OF EVERYTHING BELOW, not any one field: a share ' +
  'is reached only by a principal that every layer reporting on it allows. ' +
  '`read_only` true CAPS EVERY WRITE PERMISSION reported anywhere below — the ' +
  'share or export is served read-only whatever its ACLs say — and null is a ' +
  'switch the system reported no value for, which is not the same as false. ' +
  '`smb` is the SMB share record\'s own say in WHICH MACHINES may reach it, ' +
  'applied by the SMB service before either ACL below is consulted, and is ' +
  'null on an NFS export, which is not served by that service. Within it, ' +
  '`hosts_allow` and `hosts_deny` are the share\'s host patterns — names, ' +
  'addresses or subnets — and where both name a machine the SMB service lets ' +
  'it in, `hosts_allow` being the one it applies first. AN EMPTY LIST MEANS ' +
  'NO RULE OF THAT KIND, so two empty lists mean no machine is turned away ' +
  'here. Null is not that: it means the system reported no list this tool ' +
  'could read — the field absent, the share\'s `options` absent, or a list ' +
  'holding something that is not a host pattern — and it is NOT evidence ' +
  'that the share is unrestricted. `nfs` is the export record\'s own say in ' +
  'who may reach it, and is null on ' +
  'an SMB share, where the protocol has none of it. Within it, `hosts` and ' +
  '`networks` are which machines may mount the export at all. AN EMPTY LIST ' +
  'MEANS UNRESTRICTED — an empty `hosts` and an empty `networks` together ' +
  'mean any machine that can reach this server may mount it, which is the ' +
  'opposite of nobody. Null is neither: it means the system reported no list ' +
  'this tool could read — the field absent, or a list holding an entry that ' +
  'is not a host or a network, since a restriction reported in part is a ' +
  'different restriction — and it is NOT evidence that the export is ' +
  'unrestricted. `mapall_user` and `mapall_group`, when ' +
  'set, REPLACE THE IDENTITY OF EVERY REQUEST arriving over the export with ' +
  'that account before the ACL below is consulted, so the ACL then answers ' +
  'for that one account and not for whoever connected; `maproot_user` and ' +
  '`maproot_group` do the same for root alone. Each is null where no such ' +
  'mapping is set. `share_acl` is the SMB SHARE-LEVEL ACL, a separate gate in ' +
  'front of the filesystem one that can DENY what the path grants, so a ' +
  'principal allowed below may still be refused here. It and ' +
  '`share_acl_error` are BOTH null on an NFS export, which has no such layer; ' +
  'on an SMB share exactly one of them is non-null. Each of its entries names ' +
  'a principal in whichever of three ways the system had — `name` the ' +
  'resolved account, `id` with `kind` (`USER` or `GROUP`) the local numeric ' +
  'id, and `sid` the Windows security identifier of a domain principal — and ' +
  'an entry that resolved to none of them is reported empty rather than ' +
  'dropped. `access` is `ALLOWED` or `DENIED`, and `permission` is `FULL`, ' +
  '`CHANGE`, `READ` or `CUSTOM`. AN EMPTY `share_acl` IS A SHARE-LEVEL ACL ' +
  'THAT ALLOWS NOBODY, not a share without one — a share that carries no ' +
  'share-level ACL reports null with a reason in `share_acl_error`. `acl` is ' +
  'the filesystem ACL on `path`, which ' +
  'is what decides what each principal may do once connected: over SMB it ' +
  'applies to whoever the share ACL above already let through, and over NFS ' +
  'to the ids arriving from a machine the restrictions already let in, after ' +
  'any mapping. EXACTLY ONE of `acl` and `acl_error` is ' +
  'non-null: `acl_error` says in words why the ACL could not be read, and an ' +
  'unread ACL is never presented as an empty one. Within `acl`, `type` is ' +
  '`NFS4`, `POSIX1E`, or `DISABLED` for a path whose ACLs are switched off — ' +
  'there `entries` is ALWAYS null, whatever list the system reports beside ' +
  'it, because no ACL is in force: access is governed by the Unix mode bits, ' +
  'which this tool does not read, so it can say nothing about who has access ' +
  '— or null where the system named no type, which leaves the entries below ' +
  'readable but says nothing about which vocabulary they are in. ' +
  '`trivial` true means the ACL grants nothing beyond the owner, the owning ' +
  'group and everyone else. `owner_user` and `owner_group` are the names of ' +
  'the path\'s owner, with `owner_uid` and `owner_gid` the raw ids, and they ' +
  'are who the `owner@`, `group@`, `USER_OBJ` and `GROUP_OBJ` entries refer ' +
  'to. Each of `entries` is one entry of that ACL: an empty list is an ACL ' +
  'that holds no entry, and null is either the `DISABLED` path above or a ' +
  'list the system did not report in a form this tool could read — never ' +
  'evidence that the ACL grants nothing. `tag` says what kind, and ' +
  'the two ACL types use different words for it. On an NFS4 ACL it is `USER` ' +
  'or `GROUP`, which name a principal, or `owner@`, `group@` or `everyone@`, ' +
  'where the tag IS the principal. On a POSIX ACL it is `USER` or `GROUP`, ' +
  'or `USER_OBJ`, `GROUP_OBJ` and `OTHER` — the path\'s owner, its owning ' +
  'group, and everyone else — or `MASK`, which is NOT a principal at all but ' +
  'a ceiling on the others, described under `permissions`. `id` is ALWAYS ' +
  'null on a tag that is its own principal and on `MASK`: the system writes ' +
  '-1 there, which is reported as null because no account holds it. `name` ' +
  'is null on those tags too, since they name no separate account for the ' +
  'system to resolve — a null on one of them is the tag\'s nature rather ' +
  'than a principal that would not resolve. On a `USER` or `GROUP` ' +
  'entry `name` is the resolved account or group name and `id` is its raw ' +
  'numeric id; an id that resolved to no name is reported as `id` beside a ' +
  'null `name` and IS NEVER DROPPED, so only a `USER` or `GROUP` entry with ' +
  'neither is one whose principal could not be read. `access` is `ALLOW` or ' +
  '`DENY` on an NFS4 ACL and null on a POSIX one, which has no deny entries. ' +
  '`permissions` names what THE ENTRY ITSELF carries, in the ACL type\'s own ' +
  'vocabulary — a single preset such as `FULL_CONTROL` or `MODIFY`, or ' +
  'individual names such as `READ_DATA` and `WRITE_ACL` on NFS4 and `READ`, ' +
  '`WRITE` and `EXECUTE` on POSIX. ON A POSIX ACL CARRYING A `MASK` ENTRY ' +
  'THAT IS NOT YET THE EFFECTIVE RIGHT: a `USER`, `GROUP` or `GROUP_OBJ` ' +
  'entry grants only what it and the `MASK` entry both name, so the two are ' +
  'read together and an entry can appear to hold more than it does. NFS4 has ' +
  'no mask and no such step. An empty list is an entry that names ' +
  'permissions and holds none of them; null is one whose permissions could ' +
  'not be read, and is not evidence that it grants nothing. ' +
  '`children_only` true means the ' +
  'entry GRANTS NOTHING ON THIS PATH and exists to be inherited by what is ' +
  'created inside it, so its principal does not have the access it appears to ' +
  'have; null is an entry whose inheritance could not be read. This tool ' +
  'reads access and changes none of it. It does not report Unix mode bits, ' +
  'the SMB service\'s own bind addresses, which users are members of a group ' +
  'named here, or whether a dataset is locked by encryption — so a principal ' +
  'this reports as having access can still be stopped by something outside ' +
  'these fields, and this is an upper bound on access rather than a proof of ' +
  'it.';

export const shareAccess: ReadOnlyTool = {
  name: 'share_access',
  description:
    'Who can reach one share, and with what rights. Names the share by its SMB ' +
    'share name, or — since an NFS export has no name — by the path it ' +
    'exports; either string is accepted for either protocol, and `protocol` ' +
    'restricts the search to one of them. A string matching NO share is an ' +
    'error naming it, never an empty result: a share that does not exist and a ' +
    'share nobody can reach are opposite answers. A string matching MORE THAN ' +
    'one share is also an error, listing what it matched — one path can be ' +
    'shared over both protocols at once and the two grant access differently, ' +
    'so there is no single answer to give. ' +
    SHARE_ACCESS_RESULT_GUIDANCE,
  resultGuidance: SHARE_ACCESS_RESULT_GUIDANCE,
  inputSchema: {
    type: 'object',
    properties: {
      share: {
        type: 'string',
        description:
          'The SMB share name, or the exported path, of the share to report on, ' +
          'e.g. "media" or "/mnt/tank/backups".',
      },
      protocol: {
        type: 'string',
        enum: ['SMB', 'NFS'],
        description:
          'Only consider shares of this protocol. Omitted, both are searched, ' +
          'and a string matching one of each is an error rather than a guess.',
      },
    },
    required: ['share'],
  },
  requiredRole: Role.ReadOnly,
  mutating: false,
  async handler({ system }, args) {
    const selector = parseSelector(args);
    // Both protocols are read even when one is asked for, and `selects` then
    // discards the excluded one. The saving from skipping it is one query
    // against a list of tens of rows, and it would buy a second code path
    // through the matching and failure handling below — where the cost of a
    // mistake is a share reported as not existing.
    const attempts = await Promise.all([
      attempt('SMB', () => smbTargets(system)),
      attempt('NFS', () => nfsTargets(system)),
    ]);
    const matches: AccessTarget[] = [];
    const failures: Failure[] = [];
    for (const attempted of attempts) {
      for (const target of attempted.rows) {
        if (selects(selector, target.share)) matches.push(target);
      }
      // A failure of a protocol the caller excluded says nothing about their
      // question, so it is not carried into the message they would read.
      if (
        attempted.failure !== null &&
        (selector.protocol === null || selector.protocol === attempted.failure.protocol)
      ) {
        failures.push(attempted.failure);
      }
    }
    if (matches.length === 0) throw noMatch(selector, failures);
    if (matches.length > 1) throw ambiguous(selector, matches);
    const target = matches[0];
    // Neither read waits on the other: they are separate gates in front of the
    // same share and one failing must not cost the other.
    const [{ acl, error }, shareAcl] = await Promise.all([
      readAcl(system, target.share),
      readShareAcl(system, target.share),
    ]);
    return {
      protocol: target.share.protocol,
      id: target.share.id,
      name: target.share.name,
      path: target.share.path,
      enabled: target.share.enabled,
      read_only: target.readOnly,
      smb: target.smb,
      nfs: target.nfs,
      share_acl: shareAcl.entries,
      share_acl_error: shareAcl.error,
      acl,
      acl_error: error,
      // A protocol that could not be listed is reported even though one share
      // was found, because the check for a second match ran over a list that
      // was never read: the ambiguity this tool raises rather than guesses at
      // is exactly the thing it could not see. Dropping this would present a
      // half-searched answer as the unique one.
      failures,
    };
  },
};

/**
 * `share_set_enabled`: switching one SMB share or one NFS export on or off.
 *
 * ONE TOOL WITH A DISCRIMINATOR, NOT TWO, on #121's test: `sharing.smb.update`
 * and `sharing.nfs.update` are the same call — `(id, { enabled })` in, the
 * updated share out — so two tools would be two copies of one `plan`/`execute`
 * pair differing in a method name. The switching half that every such tool
 * shares (the read step, the per-table id check, the outcome) is `common.ts`'s.
 *
 * `protocol` IS REQUIRED, and that is a safety property. SMB shares and NFS
 * exports are separate tables, so id 3 names a different share under each, and
 * `shares_list` already says a share is identified by the two together.
 *
 * THE PLAN NAMES THE SHARE IN HUMAN TERMS, because an approver who typed the
 * wrong id can only refuse what they can recognise (#126): an SMB share by its
 * name and path, an NFS export — which has no name — by its path and aliases.
 *
 * DISABLING CUTS OFF WHOEVER IS CONNECTED NOW, and the plan says so. What it
 * can point at differs by protocol: `nfs_clients` reports who has an NFS export
 * mounted, and nothing in this catalog lists SMB sessions, which the plan states
 * rather than letting the silence read as nobody connected.
 *
 * `locked` IS REPORTED BESIDE THE OUTCOME, read off the update's response. A
 * share on a locked encrypted dataset can be switched on and still serve
 * nothing, and a result saying only `enabled: true` would read as reachable.
 *
 * THE ROLE IS `Role.Sharing`, the first mutating tool at that tier. That
 * TrueNAS's sharing-admin role grants `sharing.smb.update` and
 * `sharing.nfs.update` is the middleware's role definitions as read from its
 * source — `SHARING_ADMIN` includes the SMB and NFS write roles those methods
 * require — and is (unconfirmed) against a live system's `privilege.roles`.
 */

/** One protocol this tool switches a share of, and everything that differs by it. */
interface ShareSwitchKind {
  protocol: Protocol;
  /** What a share of this protocol is called in a plan or a failure. */
  noun: string;
  readMethod: 'sharing.smb.query' | 'sharing.nfs.query';
  updateMethod: 'sharing.smb.update' | 'sharing.nfs.update';
  /**
   * Whatever the query answered with for this id, unread. The filter is
   * bandwidth and not the control: {@link rowWithId} checks the id on the
   * response. Written inline per protocol because a filter hoisted to a `const`
   * widens out of the filter tuple (#153).
   */
  read(ctx: ToolContext, id: number): Promise<unknown>;
  update(ctx: ToolContext, id: number, enabled: boolean): Promise<unknown>;
  /** The share as the plan names it, beside the id. */
  identify(row: Record<string, unknown>): string;
  /** What the plan says about who disabling it cuts off. */
  connectedClients: string;
}

/** A label stated as the system spelled it, or as reported absent. */
function labelled(name: string, value: string | null): string {
  return `${name} ${value === null ? NONE_REPORTED : `"${value}"`}`;
}

/**
 * An SMB share as a plan names it: by its name and path. Shared with
 * `smb_share_update`, whose plan has to make the same share recognisable.
 */
function identifySmbShare(row: Record<string, unknown>): string {
  return `${labelled('name', textOrNull(row['name']))}, ${labelled('path', textOrNull(row['path']))}`;
}

/**
 * What a plan that can switch an SMB share off says about who that cuts off.
 * One text for `share_set_enabled` and `smb_share_update`, which can both send
 * `enabled: false`.
 */
const SMB_CONNECTED_CLIENTS =
  'Disabling it cuts off every client connected to it now. This catalog has no listing of ' +
  'SMB sessions, so whether anyone is connected is NOT established here.';

/**
 * An NFS export's aliases as the plan states them. An empty list is an export
 * with none, and is said so; a list that could not be read is stated as absent
 * rather than as empty, which would be a claim the read did not make.
 */
function aliasesPhrase(value: unknown): string {
  const aliases = strictTextList(value);
  if (aliases === null) return `aliases ${NONE_REPORTED}`;
  if (aliases.length === 0) return 'no aliases';
  return `aliases ${aliases.map((alias) => `"${alias}"`).join(', ')}`;
}

const SHARE_SWITCH_KINDS: readonly ShareSwitchKind[] = [
  {
    protocol: 'SMB',
    noun: 'SMB share',
    readMethod: 'sharing.smb.query',
    updateMethod: 'sharing.smb.update',
    read: (ctx, id) =>
      firstValueFrom(ctx.system.client.api.query('sharing.smb.query', [['id', '=', id]])),
    update: (ctx, id, enabled) =>
      firstValueFrom(ctx.system.client.api.call('sharing.smb.update', [id, { enabled }])),
    identify: identifySmbShare,
    connectedClients: SMB_CONNECTED_CLIENTS,
  },
  {
    protocol: 'NFS',
    noun: 'NFS export',
    readMethod: 'sharing.nfs.query',
    updateMethod: 'sharing.nfs.update',
    read: (ctx, id) =>
      firstValueFrom(ctx.system.client.api.query('sharing.nfs.query', [['id', '=', id]])),
    update: (ctx, id, enabled) =>
      firstValueFrom(ctx.system.client.api.call('sharing.nfs.update', [id, { enabled }])),
    identify: (row) => `${labelled('path', textOrNull(row['path']))}, ${aliasesPhrase(row['aliases'])}`,
    connectedClients:
      'Disabling it cuts off every client that has it mounted now; `nfs_clients` reports the ' +
      "clients connected to this system's NFS server.",
  },
];

/** The caller's arguments, or the error naming what is wrong with them. */
function parseShareSwitch(args: Record<string, unknown>): {
  kind: ShareSwitchKind;
  id: number;
  enabled: boolean;
} {
  // The protocol first, because one read loosely would act on the other
  // table's id — and it is the argument a caller is most likely to have wrong.
  const protocol = args['protocol'];
  const kind = SHARE_SWITCH_KINDS.find((one) => one.protocol === protocol);
  if (kind === undefined) {
    throw new Error('"protocol" is required and must be "SMB" or "NFS"');
  }
  // Strict on both for `scheduled_task_set_enabled`'s reason: a coerced
  // `"false"` would switch ON a share the caller asked to switch off, and `3.5`
  // is no share's primary key.
  const id = args['id'];
  if (typeof id !== 'number' || !Number.isInteger(id)) {
    throw new Error('"id" is required and must be a whole number');
  }
  const enabled = args['enabled'];
  if (typeof enabled !== 'boolean') {
    throw new Error('"enabled" is required and must be a boolean');
  }
  return { kind, id, enabled };
}

/** What the plan says about the share's dataset being locked, where it is. */
function lockedSentence(row: Record<string, unknown>): string {
  return booleanOrNull(row['locked']) === true
    ? ' THE DATASET IT SHARES IS LOCKED, so it serves nothing until that dataset is unlocked, ' +
        'whichever way it is switched.'
    : '';
}

export const shareSetEnabled: MutatingTool = {
  name: 'share_set_enabled',
  description:
    'Turns one SMB share or one NFS export on this TrueNAS system on or off, ' +
    'and changes nothing else about it. Two-phase: called without a ' +
    'confirmation_token it returns a plan for user approval; called with one it ' +
    'switches the share. THE SHARE IS NAMED BY `protocol` AND `id` TOGETHER, ' +
    'AND `id` ALONE IS NEVER ENOUGH: SMB shares and NFS exports are separate ' +
    'tables, so id 3 can name a different share under each. Both come from ' +
    '`shares_list`, which reports `protocol` and `id` on every share. ' +
    '`enabled` is the state to move the share to, true or false, and is ' +
    'required: there is no toggle, because a toggle acts on a state read after ' +
    'the plan was approved. ONLY THE `enabled` FIELD IS SENT. The path, name, ' +
    'access rules and every other setting are left exactly as they are; this ' +
    'tool cannot change them, cannot create or delete a share, and does not ' +
    'start or stop the SMB or NFS service, which `service_control` does. iSCSI ' +
    'targets and NVMe-oF subsystems are not shares in this sense and are not ' +
    'covered. THE PLAN NAMES THE SHARE IN HUMAN TERMS — an SMB share by its ' +
    'name and path, an NFS export, which has no name, by its path and aliases — ' +
    'beside the protocol and the id, so that what is approved is recognisable. ' +
    'DISABLING A SHARE CUTS OFF THE CLIENTS CONNECTED TO IT NOW, and the plan ' +
    'says so: for NFS, `nfs_clients` reports who is connected; for SMB this ' +
    'catalog has no session listing, and the plan says that rather than ' +
    'implying nobody is connected. PLANNING AGAINST AN id NO SHARE OF THAT ' +
    'PROTOCOL HAS FAILS, naming the id, the protocol searched and `shares_list` ' +
    '— so an approved plan is always a plan about a share that existed when it ' +
    'was made, and a failure here is very often the wrong `protocol` rather ' +
    'than a missing share. SWITCHING A SHARE TO THE STATE IT IS ALREADY IN IS ' +
    'NOT AN ERROR, and the result says which of the two happened. ' +
    '`requested_enabled` is what was asked for. `previously_enabled` is the ' +
    "share's state as read immediately before the call. `resulting_enabled` is " +
    'the state read back off the response the update itself answered with, ' +
    'which is the updated share. `changed` is true where those two disagree and ' +
    'false where they are the same, WHICH IS TWO OUTCOMES AND NOT ONE: either ' +
    'the share was already in the requested state, or the call did not apply ' +
    'and left it in the other one. `confirmed` is what tells those two apart, ' +
    'and `changed` must not be read without it. ALL THREE OF ' +
    '`previously_enabled`, `resulting_enabled` AND `changed` ARE NULL WHERE THE ' +
    'STATE BEHIND THEM COULD NOT BE ESTABLISHED, WHICH IS NOT "NOTHING ' +
    'CHANGED", and `changed` is null whenever either of the other two is. ' +
    '`confirmed` is whether `resulting_enabled` is what was requested: true is ' +
    'the system reporting back the state that was asked for, FALSE IS THE ' +
    'SYSTEM REPORTING THE OTHER STATE AND IS NOT A SUCCESS — the call did not ' +
    'reject and the share is not in the requested state — and null is a ' +
    'response that stated no `enabled` this tool could read, under which ' +
    'nothing here establishes what the share is now set to. `lookup` says what ' +
    'the read before the call did: `FOUND` is a read that named this share, ' +
    '`NOT_FOUND` a read that completed and listed no share of that protocol ' +
    'with that id (it was deleted between the plan and the confirmation), and ' +
    '`UNREADABLE` a read that failed, with `lookup_error` naming why. IT HAS ' +
    'THREE VALUES AND `previously_enabled` HAS FOUR CAUSES FOR ITS NULL: the ' +
    'two above, and ALSO `FOUND` where the share stated no `enabled` this tool ' +
    'could read as a boolean. So `lookup` alone does not tell them apart, and ' +
    '`FOUND` beside a null `previously_enabled` is that fourth case. THE UPDATE ' +
    'IS ATTEMPTED IN ALL THREE CASES, because what runs must be what was ' +
    'approved. `locked` is read off the same response: true is a share whose ' +
    'dataset is locked by encryption, WHICH SERVES NOTHING EVEN WHEN ENABLED ' +
    'until the dataset is unlocked, so `resulting_enabled: true` beside it is ' +
    'not a share anyone can reach; false is the system reporting it unlocked; ' +
    'null is a response that stated neither, which is not evidence that it is ' +
    'unlocked. This tool is the exact inverse of itself with `enabled` flipped.',
  inputSchema: {
    type: 'object',
    properties: {
      protocol: {
        type: 'string',
        enum: SHARE_SWITCH_KINDS.map((kind) => kind.protocol),
        description:
          'Which protocol the id names a share of, as `shares_list` reports it. ' +
          'Required: an SMB share and an NFS export can carry the same id.',
      },
      id: {
        type: 'integer',
        description:
          "The share's `id` as `shares_list` reports it, on the system being " +
          'targeted. It is unique only within its protocol.',
      },
      enabled: {
        type: 'boolean',
        description:
          'The state to move the share to: true switches it on, false switches ' +
          'it off. Required — this is not a toggle.',
      },
    },
    required: ['protocol', 'id', 'enabled'],
  },
  requiredRole: Role.Sharing,
  mutating: true,
  // A boolean on one row, and the inverse call puts it back. The clients it
  // cuts off reconnect on their own terms once it is back on, which is a cost
  // the plan states rather than a destruction this tool authors.
  destructiveness: 'reversible',
  normalizeArgs(rawArgs) {
    const { kind, id, enabled } = parseShareSwitch(rawArgs);
    return { protocol: kind.protocol, id, enabled };
  },
  async plan(ctx, rawArgs): Promise<PlanStep[]> {
    const { kind, id, enabled } = parseShareSwitch(rawArgs);
    const row = rowWithId(await kind.read(ctx, id), id);
    if (row === null) {
      throw new Error(
        `No ${kind.noun} with id ${id} on this system — the protocol searched was ` +
          `"${kind.protocol}", and the ids this tool takes come from \`shares_list\``,
      );
    }
    const current = booleanOrNull(row['enabled']);
    // Only where the call can actually switch it off: a share already read as
    // disabled has nobody connected to cut off.
    const cutsOff = !enabled && current !== false ? ` ${kind.connectedClients}` : '';
    return [
      readStep(kind.readMethod, kind.noun, id),
      {
        method: kind.updateMethod,
        params: [id, { enabled }],
        description:
          `${enabled ? 'Enable' : 'Disable'} the ${kind.noun} with ${kind.identify(row)} ` +
          `(id ${id}). Only the enabled flag is sent. ${switchSentence(current, enabled)}` +
          `${cutsOff}${lockedSentence(row)}`,
      },
    ];
  },
  async execute(ctx, rawArgs) {
    const { kind, id, enabled } = parseShareSwitch(rawArgs);
    // The response is kept for `locked` as well as handed to the shared
    // outcome, so the two are read off the one answer rather than two calls.
    let updated: unknown = null;
    const outcome = await switchOutcome(
      () => kind.read(ctx, id),
      async () => (updated = await kind.update(ctx, id, enabled)),
      id,
      enabled,
    );
    return {
      protocol: kind.protocol,
      id,
      requested_enabled: enabled,
      ...outcome,
      locked: booleanOrNull(recordOrNull(updated)?.['locked']),
    };
  },
};

/**
 * `smb_share_create` and `smb_share_update`: making one SMB share over a path
 * on this system, and changing an existing one's basic settings.
 *
 * TWO TOOLS AND NOT ONE, on #121's test read the other way: the two calls
 * differ in what the caller is TOLD, not only in which method is dialled. A
 * create names the dataset a path belongs to and every share already answering
 * to the name; an update names what each field holds now beside what it is
 * about to hold. One tool with a discriminator would carry two plans.
 *
 * THE BASIC SETTINGS AND NOTHING ELSE. `purpose` is fixed to `DEFAULT_SHARE` on
 * create and never sent on update, because each of the other seven presets
 * changes behaviour in its own way and needs its own account; `options` and
 * `audit` are refused by name rather than dropped, so a caller who passed one
 * is told it was not applied instead of finding out later.
 *
 * THE PATH MUST BELONG TO A DATASET, checked at plan time against the
 * mountpoints `pool.dataset.query` reports and never against the shape of the
 * string: `/mnt/<pool>/…` is a convention, and a dataset is what decides. A
 * directory inside a dataset is legal in TrueNAS, so the plan says which of the
 * two the path is rather than refusing the second. `EXTERNAL` is refused — it
 * belongs to the `EXTERNAL_SHARE` preset.
 *
 * WHETHER CREATING A SHARE CHANGES THE DATASET'S ACL IS NOT ESTABLISHED. The
 * webui prompts for an ACL after creating one, which suggests the method does
 * not, and that is a suggestion. So nothing here says the ACL is left
 * unchanged; what is said is that this tool does not ASK for any change (#120).
 *
 * THE ROLE IS `Role.Sharing`, with `share_set_enabled`'s caveat: that the
 * sharing-admin role grants `sharing.smb.create` and `sharing.smb.update` is
 * read from the middleware's role definitions and is (unconfirmed) against a
 * live system's `privilege.roles`.
 */

/**
 * The settings both tools send. Every one is optional on update. A `type` and
 * not an `interface` so that it can be handed to {@link agreement} as a record.
 */
type SmbShareFields = {
  name?: string;
  path?: string;
  comment?: string;
  readonly?: boolean;
  browsable?: boolean;
  enabled?: boolean;
};

/** The order the plan states the fields in, which is the schema's. */
const SMB_SHARE_FIELDS = ['name', 'path', 'comment', 'readonly', 'browsable', 'enabled'] as const;

/** The only `purpose` this catalog creates a share with. */
const DEFAULT_SHARE = 'DEFAULT_SHARE' as const;

/**
 * Arguments the API takes and these tools do not, refused by name. Silently
 * dropping one would let a caller believe it was applied.
 */
function refuseArgs(args: Record<string, unknown>, keys: readonly string[], why: string): void {
  for (const key of keys) {
    if (args[key] !== undefined) throw new Error(`"${key}" is not accepted by this tool: ${why}`);
  }
}

/** Why `options` and `audit` are refused, worded once for both tools. */
const OPTIONS_REFUSED =
  "the share's preset options and its audit settings are out of this tool's scope";

/**
 * The basic settings, each validated where it was passed and left out where it
 * was not, in the order the schema lists them — so the record this returns is
 * exactly what is sent, and is what the plan states. Strict on every type: a
 * coerced `"false"` would make a share read-only, or browsable, that the caller
 * asked to be neither.
 */
function parseSmbFields(args: Record<string, unknown>): SmbShareFields {
  const fields: SmbShareFields = {};
  const name = args['name'];
  if (name !== undefined) {
    if (textOrNull(name) === null) throw new Error('"name" must be a non-empty string');
    fields.name = name as string;
  }
  const path = args['path'];
  if (path !== undefined) {
    if (path === 'EXTERNAL') {
      throw new Error(
        '"path" may not be "EXTERNAL": that is the EXTERNAL_SHARE preset, which this tool does not create',
      );
    }
    if (typeof path !== 'string' || !path.startsWith('/')) {
      throw new Error('"path" must be an absolute path, such as "/mnt/tank/projects"');
    }
    // The dataset check compares the path to mountpoints as a string, so only
    // a path spelled one way per directory may reach it: a `..` segment would
    // let `/mnt/tank/../../etc` read as inside `tank`, and an empty one would
    // read `/mnt/tank//projects` as a directory inside `tank` when it is the
    // mountpoint of `tank/projects`. Refused rather than normalised, so what is
    // sent is what was compared — and what `confirmed` compares the stored
    // path against.
    if (path.slice(1).split('/').some((segment) => segment === '' || segment === '.' || segment === '..')) {
      throw new Error(
        '"path" must be written plainly: no empty, "." or ".." segment and no trailing slash',
      );
    }
    fields.path = path;
  }
  const comment = args['comment'];
  if (comment !== undefined) {
    // An empty comment is allowed: it is how an update clears one.
    if (typeof comment !== 'string') throw new Error('"comment" must be a string');
    fields.comment = comment;
  }
  for (const key of ['readonly', 'browsable', 'enabled'] as const) {
    const value = args[key];
    if (value === undefined) continue;
    if (typeof value !== 'boolean') throw new Error(`"${key}" must be a boolean`);
    fields[key] = value;
  }
  return fields;
}

/** What `smb_share_create` was asked to do. */
type SmbCreate = SmbShareFields & { name: string; path: string };

function parseSmbCreate(args: Record<string, unknown>): SmbCreate {
  refuseArgs(args, ['options', 'audit'], OPTIONS_REFUSED);
  const purpose = args['purpose'];
  if (purpose !== undefined && purpose !== DEFAULT_SHARE) {
    throw new Error(
      `"purpose" may only be "${DEFAULT_SHARE}": each other preset changes how the share behaves, and this tool creates none of them`,
    );
  }
  if (args['name'] === undefined) throw new Error('"name" is required');
  if (args['path'] === undefined) throw new Error('"path" is required');
  return parseSmbFields(args) as SmbCreate;
}

/** What `smb_share_update` was asked to do. */
interface SmbUpdate {
  id: number;
  fields: SmbShareFields;
}

function parseSmbUpdate(args: Record<string, unknown>): SmbUpdate {
  refuseArgs(args, ['options', 'audit'], OPTIONS_REFUSED);
  refuseArgs(args, ['purpose'], "this tool leaves an existing share's purpose as it is");
  const id = args['id'];
  if (typeof id !== 'number' || !Number.isInteger(id)) {
    throw new Error('"id" is required and must be a whole number');
  }
  const fields = parseSmbFields(args);
  if (Object.keys(fields).length === 0) {
    throw new Error(`Nothing to change: pass at least one of ${SMB_SHARE_FIELDS.join(', ')}`);
  }
  return { id, fields };
}

/** One value as a plan states it: quoted as it will be sent, so nothing is paraphrased. */
function sentValue(value: string | boolean | null): string {
  return value === null ? NONE_REPORTED : JSON.stringify(value);
}

/**
 * An SMB share as these tools report it, field by field. `comment` keeps an
 * empty string as itself rather than null, unlike `shares_list`: an update can
 * clear a comment by sending `""`, and reading that back as null would make the
 * call read as unconfirmed when it did exactly what was asked.
 */
interface SmbShareRow {
  id: number | null;
  name: string | null;
  path: string | null;
  purpose: string | null;
  enabled: boolean | null;
  comment: string | null;
  readonly: boolean | null;
  browsable: boolean | null;
  locked: boolean | null;
}

function smbShareRow(row: Record<string, unknown>): SmbShareRow {
  const comment = row['comment'];
  return {
    id: numberOrNull(row['id']),
    name: textOrNull(row['name']),
    path: textOrNull(row['path']),
    purpose: textOrNull(row['purpose']),
    enabled: booleanOrNull(row['enabled']),
    comment: typeof comment === 'string' ? comment : null,
    readonly: booleanOrNull(row['readonly']),
    browsable: booleanOrNull(row['browsable']),
    locked: booleanOrNull(row['locked']),
  };
}

/** A row's values on the fields a request sent, for {@link agreement}. */
function comparableOf(row: SmbShareRow, fields: SmbShareFields): Record<string, string | boolean | null> {
  return Object.fromEntries(Object.keys(fields).map((key) => [key, row[key as keyof SmbShareFields]]));
}

/** The dataset a share path belongs to, as the plan names it. */
interface PathOwner {
  dataset: string;
  mountpoint: string;
  /** True where the path IS the dataset's mountpoint, false where it is inside it. */
  exact: boolean;
  /** Dataset rows whose id or mountpoint could not be read, and so were not compared. */
  unreadable: number;
}

/** A path compared without trailing slashes, which name the same directory. */
function trimmedPath(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  return trimmed.length === 0 ? '/' : trimmed;
}

/**
 * The dataset whose mountpoint is the path, or the deepest one the path lies
 * inside, or the error naming the path.
 *
 * Every dataset is read, because the question is which mountpoint the path sits
 * under and a filter on the dataset id would have to guess that from the path.
 * `retrieve_children` is what lists every dataset as its own row — the walk the
 * three listings in `storage.ts` take for the same reason — and `properties` is
 * empty because `id` and `mountpoint` are fields of the entry itself.
 *
 * A row whose id or mountpoint cannot be read is COUNTED rather than silently
 * skipped: if it is the deepest mountpoint over the path, the dataset named here
 * is its parent, and the plan has to say that this may be so (#93).
 */
async function datasetOfPath(ctx: ToolContext, path: string): Promise<PathOwner> {
  let rows: unknown;
  try {
    rows = await firstValueFrom(
      ctx.system.client.api.query('pool.dataset.query', [], {
        extra: { retrieve_children: true, properties: [] },
      }),
    );
  } catch (reason) {
    throw new Error(
      `Which dataset path "${path}" belongs to could not be read (pool.dataset.query failed: ` +
        `${errorText(reason)}), so no share over it is planned`,
    );
  }
  if (!Array.isArray(rows)) {
    throw new Error(
      `Which dataset path "${path}" belongs to could not be read (pool.dataset.query did not ` +
        'answer with a list), so no share over it is planned',
    );
  }
  const wanted = trimmedPath(path);
  let owner: Omit<PathOwner, 'unreadable'> | null = null;
  let unreadable = 0;
  for (const row of rows) {
    const held = recordOrNull(row);
    const dataset = textOrNull(held?.['id']);
    if (dataset === null) {
      unreadable += 1;
      continue;
    }
    // A volume has no mountpoint and a filesystem can name `none` or `legacy`:
    // neither is a directory a share could sit under. A filesystem reporting
    // NO mountpoint is another matter — the client declares the field nullable,
    // and a locked dataset is the likely case — so it is counted as unread.
    const mountpoint = textOrNull(held?.['mountpoint']);
    if (mountpoint === null) {
      if (textOrNull(held?.['type']) !== 'VOLUME') unreadable += 1;
      continue;
    }
    if (!mountpoint.startsWith('/')) continue;
    const mount = trimmedPath(mountpoint);
    const exact = wanted === mount;
    if (!exact && !wanted.startsWith(mount === '/' ? '/' : `${mount}/`)) continue;
    if (owner === null || mount.length > owner.mountpoint.length) {
      owner = { dataset, mountpoint: mount, exact };
    }
  }
  if (owner === null) {
    throw new Error(
      `Path "${path}" is not the mountpoint of any dataset this system lists, and not inside one — ` +
        `\`storage_list_datasets\` reports each dataset's mountpoint` +
        (unreadable > 0 ? `; ${plural(unreadable, 'dataset')} could not be read, and so could not be compared` : ''),
    );
  }
  return { ...owner, unreadable };
}

/** What the plan says about which dataset a path belongs to. */
function pathSentence(path: string, owner: PathOwner): string {
  const where = owner.exact
    ? `Path "${path}" is the mountpoint of dataset "${owner.dataset}".`
    : `Path "${path}" is a directory inside dataset "${owner.dataset}", which is mounted at ` +
      `"${owner.mountpoint}" — not that dataset's own mountpoint, which TrueNAS allows; whether ` +
      'the directory exists is not checked here.';
  const unread =
    owner.unreadable > 0
      ? ` ${plural(owner.unreadable, 'dataset')} could not be read, so the path may belong to one ` +
        'of them rather than to the dataset named.'
      : '';
  return `${where}${unread}`;
}

/**
 * What the plan says about SMB shares that already answer to a name.
 *
 * Compared IGNORING LETTER CASE, because Windows clients do not tell share
 * names apart by case — whether the middleware refuses such a name is
 * (unconfirmed), so a match is named and not refused. Plan-time only and not a
 * step, since `execute` does not make this read (#119); its failure does not
 * fail the plan (#154), and is stated instead. A share whose name could not be
 * read is COUNTED, by #93's direction: leaving it out moves the sentence towards
 * "no other share has this name", which is the claim that makes a clash look
 * safe. `exceptId` is the share an update is renaming, which trivially matches
 * itself.
 */
async function nameClashSentence(ctx: ToolContext, name: string, exceptId: number | null): Promise<string> {
  let rows: unknown;
  try {
    rows = await firstValueFrom(ctx.system.client.api.query('sharing.smb.query'));
  } catch (reason) {
    return (
      ' Whether another SMB share already has this name could not be read ' +
      `(sharing.smb.query failed: ${errorText(reason)}).`
    );
  }
  if (!Array.isArray(rows)) {
    return (
      ' Whether another SMB share already has this name could not be read ' +
      '(sharing.smb.query did not answer with a list).'
    );
  }
  const folded = name.toLowerCase();
  const clashes: string[] = [];
  let unnamed = 0;
  for (const row of rows) {
    const share = smbShareRow(recordOrNull(row) ?? {});
    if (exceptId !== null && share.id === exceptId) continue;
    if (share.name === null) {
      unnamed += 1;
    } else if (share.name.toLowerCase() === folded) {
      clashes.push(`"${share.name}" (id ${share.id ?? NONE_REPORTED}, ${labelled('path', share.path)})`);
    }
  }
  const unread =
    unnamed > 0 ? ` ${plural(unnamed, 'other SMB share')} reported no name this tool could read.` : '';
  if (clashes.length === 0) {
    return ` No other SMB share on this system has this name in any letter case.${unread}`;
  }
  return (
    ` ${plural(clashes.length, 'other SMB share')} already ${clashes.length === 1 ? 'has' : 'have'} ` +
    `this name, ignoring letter case: ${clashes.join('; ')}. Windows clients do not tell share ` +
    `names apart by case, and whether the system refuses this one is (unconfirmed).${unread}`
  );
}

/**
 * The middleware's own pre-check for a new share, run at plan time.
 *
 * What it validates is (unconfirmed): it takes a share name and answers
 * `null`, and nothing on the surface says more. So a REJECTION fails the plan
 * with the system's reason — it is the system saying it would not take this
 * share — and a system with NO SUCH METHOD gets a plan saying the check was not
 * run, rather than a refusal on the strength of a check that does not exist
 * there. Any other failure is read as the check having run and refused: the
 * cost of getting that wrong is a plan to retry, where the opposite reading
 * would let a refused share through to approval.
 *
 * Plan-time only and not a step: `execute` does not call it (#119).
 */
async function precheckSentence(ctx: ToolContext, name: string): Promise<string> {
  try {
    await firstValueFrom(ctx.system.client.api.call('sharing.smb.share_precheck', [{ name }]));
  } catch (reason) {
    if (isMissingMethod(reason)) {
      return (
        " The system's own SMB share pre-check (sharing.smb.share_precheck) could not be " +
        'called — this system has no such method — so it was not run.'
      );
    }
    throw new Error(`The system's SMB share pre-check refused this share: ${errorText(reason)}`);
  }
  return (
    " The system's own SMB share pre-check (sharing.smb.share_precheck) accepted it; what that " +
    'check covers is (unconfirmed).'
  );
}

/**
 * What both plans say about the path becoming reachable. A share is an
 * EXPOSURE rather than a destruction, and the approver is told so plainly
 * rather than left to infer it from "create".
 */
function exposureSentence(path: string): string {
  return (
    ` Path "${path}" becomes reachable over SMB by whoever the dataset's ACL admits, within ` +
    "the share's own settings; `share_access` reports who that is once the share exists. This " +
    "tool does not ask for any change to the dataset's ACL or permissions; whether the " +
    'system changes them on its own is (unconfirmed).'
  );
}

/** The fields a create did NOT send, which the system then decides. */
function defaultsSentence(fields: SmbShareFields): string {
  const unsent = (['comment', 'readonly', 'browsable', 'enabled'] as const).filter(
    (key) => fields[key] === undefined,
  );
  if (unsent.length === 0) return '';
  return (
    ` Not sent, and so left to the system's defaults, which are not read here: ` +
    `${unsent.join(', ')}.`
  );
}

const SMB_CREATE_GUIDANCE =
  '`requested` is exactly what was sent, `purpose` included. `share` is the ' +
  'created share read back off the response the create itself answered with — ' +
  'never copied from the request — or null where that response was not a ' +
  'record. Its fields are `id`, which is what `smb_share_update` and ' +
  '`share_set_enabled` take; `name`; `path`; `purpose`; `enabled`; `comment`, ' +
  'which is `""` where the share has none; `readonly`; `browsable`; and ' +
  '`locked`, true where the dataset is locked by encryption and the share ' +
  'serves nothing until it is unlocked. Each is null where the response stated ' +
  'no value this tool could read. `confirmed` is whether `share` holds every ' +
  'value sent: true is the system reporting back what was asked for; FALSE IS ' +
  'NOT A SUCCESS — the call did not reject and at least one value was stored as ' +
  'something else, compared exactly as spelled; and null is a response in which ' +
  'some value sent could not be read back and none read back as different. A ' +
  'null `share` means nothing here establishes that a share was created, and is ' +
  'not evidence that none was — `shares_list` shows what the system now holds.';

export const smbShareCreate: MutatingTool = {
  name: 'smb_share_create',
  description:
    'Creates one SMB share on this TrueNAS system, over a path that belongs to ' +
    'one of its datasets. Two-phase: called without a confirmation_token it ' +
    'returns a plan for user approval; called with one it creates the share. ' +
    '`name` and `path` are required; `comment`, `readonly`, `browsable` and ' +
    '`enabled` are optional, and the system decides any that are not passed. ' +
    "THE SHARE IS CREATED WITH THE `DEFAULT_SHARE` PURPOSE AND NO OTHER: `purpose` " +
    'accepts that value alone, and `options` and `audit` are refused. `path` ' +
    "must be a dataset's mountpoint or a directory inside one, and the plan names " +
    'which dataset and which of the two; a path that is neither fails the plan, ' +
    'naming it, and `EXTERNAL` is refused. That check is made when the plan is ' +
    'made and not again. THE PLAN NAMES EVERY SMB SHARE ALREADY ANSWERING TO THE ' +
    'NAME IN ANY LETTER CASE, and runs the system\'s own pre-check, ' +
    '`sharing.smb.share_precheck`, whose refusal fails the plan with its reason. ' +
    'A SHARE IS AN EXPOSURE: the path becomes reachable over SMB by whoever the ' +
    "dataset's ACL admits, and `share_access` reports who that is. This tool does " +
    "not ask for any change to the dataset's ACL or permissions, and whether the " +
    'system changes them on its own when a share is created is (unconfirmed). It ' +
    'does not start the SMB service, which `service_control` does. ' +
    '`destructiveness` is `reversible`, but NO TOOL IN THIS CATALOG DELETES AN SMB ' +
    'SHARE: undoing this means switching it off with `share_set_enabled`, or ' +
    'deleting it outside this catalog. ' +
    SMB_CREATE_GUIDANCE,
  resultGuidance: SMB_CREATE_GUIDANCE,
  inputSchema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'The share name SMB clients connect to, e.g. "projects".',
      },
      path: {
        type: 'string',
        description:
          "The absolute path to share: a dataset's mountpoint, as `storage_list_datasets` " +
          'reports it, or a directory inside one.',
      },
      comment: { type: 'string', description: 'Optional; a description of the share.' },
      readonly: { type: 'boolean', description: 'Optional; true serves the share read-only.' },
      browsable: {
        type: 'boolean',
        description: 'Optional; whether clients browsing the server see the share listed.',
      },
      enabled: { type: 'boolean', description: 'Optional; whether the share is created switched on.' },
      purpose: {
        type: 'string',
        enum: [DEFAULT_SHARE],
        description: `Optional, and only "${DEFAULT_SHARE}", which is what is sent either way.`,
      },
    },
    required: ['name', 'path'],
  },
  requiredRole: Role.Sharing,
  mutating: true,
  // Additive: the share is a new row and nothing existing is removed. What it
  // exposes is stated in the plan rather than recorded here.
  destructiveness: 'reversible',
  normalizeArgs(rawArgs) {
    return parseSmbCreate(rawArgs);
  },
  async plan(ctx, rawArgs): Promise<PlanStep[]> {
    const fields = parseSmbCreate(rawArgs);
    const owner = await datasetOfPath(ctx, fields.path);
    const clash = await nameClashSentence(ctx, fields.name, null);
    const precheck = await precheckSentence(ctx, fields.name);
    return [
      {
        method: 'sharing.smb.create',
        params: [{ purpose: DEFAULT_SHARE, ...fields }],
        description:
          `Create an SMB share with purpose "${DEFAULT_SHARE}", ` +
          `${Object.entries(fields)
            .map(([key, value]) => `${key} ${sentValue(value as string | boolean)}`)
            .join(', ')}. ${pathSentence(fields.path, owner)}${exposureSentence(fields.path)}` +
          `${defaultsSentence(fields)}${clash}${precheck}`,
      },
    ];
  },
  async execute(ctx, rawArgs) {
    const fields = parseSmbCreate(rawArgs);
    // The path check is the plan's and is not made again here, as
    // `snapshots_create`'s dataset check is not: `execute` stays a function of
    // the arguments, and a dataset gone since the plan is the middleware's to
    // refuse.
    const requested = { purpose: DEFAULT_SHARE, ...fields };
    const created: unknown = await firstValueFrom(
      ctx.system.client.api.call('sharing.smb.create', [requested]),
    );
    const held = recordOrNull(created);
    const share = held === null ? null : smbShareRow(held);
    return {
      requested,
      share,
      confirmed:
        share === null
          ? null
          : agreement(requested, { purpose: share.purpose, ...comparableOf(share, fields) }),
    };
  },
};

/** Each field sent, beside what the share holds for it now. */
function smbChangesText(fields: SmbShareFields, share: SmbShareRow): string {
  return Object.entries(fields)
    .map(
      ([key, value]) =>
        `${key} ${sentValue(value as string | boolean)} (now ${sentValue(share[key as keyof SmbShareFields])})`,
    )
    .join('; ');
}

function readSmbShare(ctx: ToolContext, id: number): Promise<unknown> {
  return firstValueFrom(ctx.system.client.api.query('sharing.smb.query', [['id', '=', id]]));
}

const SMB_UPDATE_GUIDANCE =
  '`requested` is exactly what was sent. `previous` is the share as read ' +
  'immediately before the call, and `resulting` is the share read back off the ' +
  'response the update itself answered with — never copied from the request. ' +
  'Both carry the fields `smb_share_create` reports, `comment` being `""` where ' +
  'the share has none; `previous` is null where that read failed or listed no ' +
  'such share, and `resulting` is null where the response was not a record. ' +
  '`changes` names each field that was SENT, as `requested`, `before` (off ' +
  '`previous`) and `after` (off `resulting`), and `before` or `after` is null ' +
  'wherever the reading behind it is. `lookup` says what the read did: `FOUND`, ' +
  '`NOT_FOUND` (deleted between the plan and the confirmation), or `UNREADABLE` ' +
  'with `lookup_error` naming why; THE UPDATE IS ATTEMPTED IN ALL THREE CASES, ' +
  'because what runs must be what was approved. `changed` is true where ' +
  '`before` and `after` differ in one of the sent fields and false where they ' +
  'agree in all, WHICH IS TWO OUTCOMES AND NOT ONE: the share already held those ' +
  'values, or the call did not apply. `confirmed` is what tells those apart, and ' +
  '`changed` must not be read without it. `confirmed` is whether `resulting` ' +
  'holds every value sent: true is the system reporting back what was asked ' +
  'for; FALSE IS NOT A SUCCESS — the call did not reject and at least one value ' +
  'was stored as something else, compared exactly as spelled; null is a ' +
  'response in which some value sent could not be read back and none read back ' +
  'as different. Both are null wherever a reading they need is missing.';

export const smbShareUpdate: MutatingTool = {
  name: 'smb_share_update',
  description:
    "Changes one existing SMB share's basic settings on this TrueNAS system: its " +
    '`name`, `path`, `comment`, `readonly`, `browsable` or `enabled`. ' +
    'Two-phase: called without a confirmation_token it returns a plan for user ' +
    'approval; called with one it sends the change. `id` is the SMB share\'s id ' +
    'as `shares_list` reports it for protocol `SMB`; PLANNING AGAINST AN id NO SMB ' +
    'SHARE HAS FAILS, naming it — an NFS export\'s id is a different table and is ' +
    'never taken here. ONLY THE FIELDS PASSED ARE SENT, and at least one is ' +
    "required. The share's purpose is left as it is: `purpose`, `options` and " +
    '`audit` are refused. A new `path` is checked as `smb_share_create` checks one ' +
    "— a dataset's mountpoint or a directory inside one, never `EXTERNAL` — and " +
    'the plan names its dataset; a new `name` is compared with every other SMB ' +
    'share ignoring letter case. THE PLAN STATES EACH VALUE SENT BESIDE THE ONE ' +
    'THE SHARE HOLDS NOW, so the call that undoes it is in the plan. Changing ' +
    '`path` exposes the new path over SMB to whoever its dataset\'s ACL admits, ' +
    'and this tool does not ask for any change to an ACL; changing `name` means ' +
    'clients connecting by the old name no longer find the share; `enabled: ' +
    'false` cuts off whoever is connected, and this catalog has no listing of SMB ' +
    'sessions. SENDING A SHARE A VALUE IT ALREADY HOLDS IS NOT AN ERROR. This ' +
    'tool cannot create or delete a share; `smb_share_create` creates one, and ' +
    '`share_set_enabled` switches one on or off alone. ' +
    SMB_UPDATE_GUIDANCE,
  resultGuidance: SMB_UPDATE_GUIDANCE,
  inputSchema: {
    type: 'object',
    properties: {
      id: {
        type: 'integer',
        description:
          "The SMB share's `id`, as `shares_list` reports it for protocol `SMB` on the " +
          'system being targeted. An NFS export with the same id is a different share.',
      },
      name: { type: 'string', description: 'A new share name, non-empty.' },
      path: {
        type: 'string',
        description: "A new absolute path: a dataset's mountpoint, or a directory inside one.",
      },
      comment: { type: 'string', description: 'A new description; "" clears it.' },
      readonly: { type: 'boolean', description: 'true serves the share read-only.' },
      browsable: {
        type: 'boolean',
        description: 'Whether clients browsing the server see the share listed.',
      },
      enabled: { type: 'boolean', description: 'true switches the share on, false off.' },
    },
    required: ['id'],
  },
  requiredRole: Role.Sharing,
  mutating: true,
  // Every field it sends can be sent back, and the plan states the value each
  // held. What a rename or a new path does to connected clients is stated in
  // the plan rather than recorded here.
  destructiveness: 'reversible',
  normalizeArgs(rawArgs) {
    const { id, fields } = parseSmbUpdate(rawArgs);
    return { id, ...fields };
  },
  async plan(ctx, rawArgs): Promise<PlanStep[]> {
    const { id, fields } = parseSmbUpdate(rawArgs);
    const row = rowWithId(await readSmbShare(ctx, id), id);
    if (row === null) {
      throw new Error(
        `No SMB share with id ${id} on this system — ids come from \`shares_list\`, where an ` +
          'SMB share and an NFS export can carry the same id',
      );
    }
    const share = smbShareRow(row);
    const notes: string[] = [];
    if (fields.name !== undefined && fields.name !== share.name) {
      notes.push(
        ` Clients that connect by the name ${sentValue(share.name)} will no longer find the share under it.` +
          (await nameClashSentence(ctx, fields.name, id)),
      );
    }
    if (fields.path !== undefined && fields.path !== share.path) {
      const owner = await datasetOfPath(ctx, fields.path);
      notes.push(
        ` This stops sharing ${sentValue(share.path)}. ${pathSentence(fields.path, owner)}` +
          exposureSentence(fields.path),
      );
    }
    if (fields.enabled === false && share.enabled !== false) {
      notes.push(` ${SMB_CONNECTED_CLIENTS}`);
    }
    const already =
      agreement(fields, comparableOf(share, fields)) === true
        ? ' The share already holds every value this sends, which is not an error.'
        : '';
    return [
      readStep('sharing.smb.query', 'SMB share', id),
      {
        method: 'sharing.smb.update',
        params: [id, fields],
        description:
          `Change the SMB share with ${identifySmbShare(row)} (id ${id}): ` +
          `${smbChangesText(fields, share)}. Only these fields are sent.${notes.join('')}${already}`,
      },
    ];
  },
  async execute(ctx, rawArgs) {
    const { id, fields } = parseSmbUpdate(rawArgs);
    let previous: SmbShareRow | null = null;
    let lookupError: string | null = null;
    try {
      const row = rowWithId(await readSmbShare(ctx, id), id);
      previous = row === null ? null : smbShareRow(row);
    } catch (reason) {
      lookupError = errorText(reason);
    }
    // Issued whatever the read said: skipping it for a share the read no longer
    // lists would be `execute` branching on state the confirmation token cannot
    // bind.
    const requested = fields;
    const updated: unknown = await firstValueFrom(
      ctx.system.client.api.call('sharing.smb.update', [id, requested]),
    );
    const held = recordOrNull(updated);
    const resulting = held === null ? null : smbShareRow(held);
    const before = previous === null ? null : comparableOf(previous, fields);
    const after = resulting === null ? null : comparableOf(resulting, fields);
    const changes = Object.fromEntries(
      Object.entries(requested).map(([key, value]) => [
        key,
        { requested: value, before: before?.[key] ?? null, after: after?.[key] ?? null },
      ]),
    );
    // `changed` compares the two READINGS on the fields that were sent, never
    // the request: a response still holding the old value is a call that did
    // not apply, not one that changed nothing.
    const same = before === null || after === null ? null : agreement(before, after);
    return {
      id,
      requested,
      lookup: lookupError !== null ? 'UNREADABLE' : previous === null ? 'NOT_FOUND' : 'FOUND',
      lookup_error: lookupError,
      previous,
      resulting,
      changes,
      changed: same === null ? null : !same,
      confirmed: after === null ? null : agreement(requested, after),
    };
  },
};
