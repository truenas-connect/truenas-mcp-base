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

/** One protocol's shares, or the failure that stopped them being read. */
interface Attempt {
  shares: Share[];
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

/** Every NFS export the system holds. */
async function nfsShares(system: SystemHandle): Promise<Share[]> {
  const shares = await firstValueFrom(system.client.api.query('sharing.nfs.query'));
  return shares.map((share) => ({
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
async function attempt(protocol: Protocol, read: () => Promise<Share[]>): Promise<Attempt> {
  try {
    return { shares: await read(), failure: null };
  } catch (reason) {
    return { shares: [], failure: { protocol, error: errorText(reason) } };
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
      shares.push(...attempted.shares);
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
