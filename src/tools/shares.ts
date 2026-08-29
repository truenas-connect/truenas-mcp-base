import { firstValueFrom } from 'rxjs';
import { Role } from '@/interfaces';
import { ReadOnlyTool, SystemHandle } from '@/catalog/tool';

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

/**
 * One protocol's rows, or the failure that stopped them being read.
 *
 * Generic in the row because `shares_list` and `share_access` read the same two
 * queries for different fields: the first wants the share as it is presented,
 * the second wants the NFS restrictions alongside it. The failure half is
 * identical for both and is what this exists to share.
 */
interface Attempt<T> {
  rows: T[];
  failure: Failure | null;
}

/**
 * One string field of a share row, or null where the system reported no value.
 *
 * An empty string is read as no value rather than as text of no characters: a
 * share with no comment is what the middleware sends `""` for, and passing that
 * through would put a field in the result that says nothing.
 *
 * `tasks.ts` has the same reading of a string field under another name, and
 * this restates rather than shares it for the reason that file gives for
 * restating its own guards: a tool file is read on its own.
 */
function textOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Why a protocol's query failed, in words, for the caller to act on.
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

/** Every SMB share the system holds. */
async function smbShares(system: SystemHandle): Promise<Share[]> {
  // No filters and no options: a system holds tens of shares at most, and every
  // field this tool reads is part of a share row as it stands. No `select`
  // either — unlike a job row, a share row carries no credential and nothing
  // unbounded, and the mapping below is what decides what a caller sees.
  const shares = await firstValueFrom(system.client.api.query('sharing.smb.query'));
  return shares.map((share) => ({
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
  }));
}

/**
 * One NFS export as this family presents one.
 *
 * Split out of `nfsShares` because `share_access` reads the same rows for their
 * host restrictions and must present the share half identically — two mappings
 * of one row would drift, and the drift would show as one tool naming a share
 * differently from the other.
 */
function nfsShare(share: { id: number; path: string; enabled?: boolean; comment?: string }): Share {
  return {
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
  };
}

/** Every NFS export the system holds. */
async function nfsShares(system: SystemHandle): Promise<Share[]> {
  const shares = await firstValueFrom(system.client.api.query('sharing.nfs.query'));
  return shares.map(nfsShare);
}

/**
 * One protocol's shares, with a failure caught and named rather than thrown.
 *
 * The read is passed as a thunk so that the call is made inside the `try`,
 * which keeps this correct for a read that throws before it returns a promise
 * at all. Neither caller can: both are `async`, so a throw anywhere inside them
 * arrives as a rejection.
 */
async function attempt<T>(protocol: Protocol, read: () => Promise<T[]>): Promise<Attempt<T>> {
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
      attempt('SMB', () => smbShares(system)),
      attempt('NFS', () => nfsShares(system)),
    ]);
    const shares: Share[] = [];
    const failures: Failure[] = [];
    for (const attempted of attempts) {
      shares.push(...attempted.rows);
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
 * it, and the answer is in two different places depending on the protocol —
 * neither of them the share record on its own:
 *
 *     SMB   the filesystem ACL on the shared path, which is what decides what
 *           each user may do once a client has connected
 *     NFS   the export's own host and network restrictions, which decide which
 *           MACHINES may mount it at all, and then that same filesystem ACL,
 *           which decides what the ids arriving over the mount may do
 *
 * So the ACL is read for both and the restrictions are read for NFS, and
 * neither half is presented as the whole answer.
 */

/** One protocol's shares, with the export restrictions that only NFS carries. */
interface AccessTarget {
  share: Share;
  hosts: string[] | null;
  networks: string[] | null;
}

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

/** A finite number as the middleware reported it, or null where it reported none. */
function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
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
 * An NFS export's host or network restriction list.
 *
 * An absent list and an empty one are the same answer from the middleware — the
 * export carries no restriction of that kind — so both map to `[]` rather than
 * one of them becoming a null that would read as unreadable. Only a value that
 * is not a list at all is unreadable, and entries that are not text are dropped
 * because a restriction that cannot be read as a host or a network restricts
 * nothing this tool can report.
 */
function restrictionList(value: unknown): string[] | null {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return null;
  return value.filter((item): item is string => typeof item === 'string' && item.length > 0);
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
 * An empty list is an entry that names no permission, which is not the same as
 * a permission set that could not be read — a caller reviewing access must not
 * see the second as the first and conclude the entry grants nothing.
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
  return Object.keys(record).filter((name) => record[name] === true);
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
  return record['INHERIT_ONLY'] === true;
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

/** The ACL response, mapped to the fields this tool names. */
function mapAcl(row: Record<string, unknown>): Acl {
  const entries = row['acl'];
  return {
    type: textOrNull(row['acltype']),
    trivial: typeof row['trivial'] === 'boolean' ? row['trivial'] : null,
    owner_user: textOrNull(row['user']),
    owner_uid: numberOrNull(row['uid']),
    owner_group: textOrNull(row['group']),
    owner_gid: numberOrNull(row['gid']),
    // Null where the system reported no list at all, which is what a path with
    // ACLs switched off answers. An empty list is an ACL that holds no entry.
    entries: Array.isArray(entries) ? entries.map(accessEntry) : null,
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
    return { acl: mapAcl(acl as unknown as Record<string, unknown>), error: null };
  } catch (reason) {
    return { acl: null, error: errorText(reason) };
  }
}

/** Every SMB share, as a target. SMB carries no export restrictions of its own. */
async function smbTargets(system: SystemHandle): Promise<AccessTarget[]> {
  const shares = await smbShares(system);
  return shares.map((share) => ({ share, hosts: null, networks: null }));
}

/** Every NFS export, as a target, with the restrictions on who may mount it. */
async function nfsTargets(system: SystemHandle): Promise<AccessTarget[]> {
  const shares = await firstValueFrom(system.client.api.query('sharing.nfs.query'));
  return shares.map((share) => ({
    share: nfsShare(share),
    hosts: restrictionList(share.hosts),
    networks: restrictionList(share.networks),
  }));
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
    'so there is no single answer to give. `protocol`, `id`, `name`, `path` ' +
    'and `enabled` identify the share and mean exactly what they mean in ' +
    '`shares_list`, including that `name` is ALWAYS null on an NFS export and ' +
    'that a disabled share reaches nobody whatever the rest of this says. ' +
    '`hosts` and `networks` are the NFS export restrictions: which machines may ' +
    'mount it at all, by host and by network. THEY ARE EMPTY WHEN THE EXPORT IS ' +
    'UNRESTRICTED — an empty `hosts` and an empty `networks` together mean any ' +
    'machine that can reach this server may mount it, which is the opposite of ' +
    'nobody. Both are null on an SMB share, where the protocol has no such ' +
    'restriction, and null on an NFS export only where the system reported ' +
    'something that could not be read as a list; `protocol` tells those two ' +
    'apart. `acl` is the filesystem ACL on `path`, which is what decides what ' +
    'each principal may do once connected — over SMB it is the whole answer, ' +
    'and over NFS it applies to the ids arriving from a machine the ' +
    'restrictions already let in. EXACTLY ONE of `acl` and `acl_error` is ' +
    'non-null: `acl_error` says in words why the ACL could not be read, and an ' +
    'unread ACL is never presented as an empty one. Within `acl`, `type` is ' +
    '`NFS4`, `POSIX1E`, or `DISABLED` for a path whose ACLs are switched off — ' +
    'there `entries` is null and access is governed by the Unix mode bits, ' +
    'which this tool does not read, so it can say nothing about who has access. ' +
    '`trivial` true means the ACL grants nothing beyond the owner, the owning ' +
    'group and everyone else. `owner_user` and `owner_group` are the names of ' +
    'the path\'s owner, with `owner_uid` and `owner_gid` the raw ids, and they ' +
    'are who the `owner@` and `group@` entries refer to. Each of `entries` is ' +
    'one principal and what it holds. `tag` is `USER`, `GROUP`, or one of ' +
    '`owner@`, `group@` and `everyone@`, where the tag IS the principal and ' +
    '`name` and `id` are both null as a result rather than because nothing ' +
    'resolved. Otherwise `name` is the resolved account or group name and `id` ' +
    'is its raw numeric id; an id that resolved to no name is reported as `id` ' +
    'with a null `name` and IS NEVER DROPPED, so an entry with neither a name ' +
    'nor an id is one whose principal could not be read at all. `access` is ' +
    '`ALLOW` or `DENY` on an NFS4 ACL and null on a POSIX one, which has no ' +
    'deny entries. `permissions` names what the entry grants, in the ACL ' +
    'type\'s own vocabulary — a single preset such as `FULL_CONTROL` or ' +
    '`MODIFY`, or individual names such as `READ_DATA` and `WRITE_ACL` on NFS4 ' +
    'and `READ`, `WRITE` and `EXECUTE` on POSIX. An empty list is an entry that ' +
    'names no permission; null is one whose permissions could not be read, and ' +
    'is not evidence that it grants nothing. `children_only` true means the ' +
    'entry GRANTS NOTHING ON THIS PATH and exists to be inherited by what is ' +
    'created inside it, so its principal does not have the access it appears to ' +
    'have; null is an entry whose inheritance could not be read. This tool ' +
    'reads access and changes none of it, and it does not report Unix mode ' +
    'bits, SMB service-level restrictions, or which users are members of a ' +
    'group named here.',
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
    // Both protocols are read even when one is asked for, and the unwanted one
    // is discarded by `selects`. Issuing one query would be cheaper and would
    // report a share of the other protocol as not existing, which is the one
    // answer here that a caller would repeat as fact.
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
    const { acl, error } = await readAcl(system, target.share);
    return {
      protocol: target.share.protocol,
      id: target.share.id,
      name: target.share.name,
      path: target.share.path,
      enabled: target.share.enabled,
      hosts: target.hosts,
      networks: target.networks,
      acl,
      acl_error: error,
    };
  },
};
