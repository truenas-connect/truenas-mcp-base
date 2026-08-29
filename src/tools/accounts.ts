import { firstValueFrom } from 'rxjs';
import { Role } from '@/interfaces';
import { ReadOnlyTool, SystemHandle } from '@/catalog/tool';

/**
 * Accounts family: who has an account on this system, and what each belongs to.
 *
 * Two middleware namespaces answer it. `user.query` lists the accounts, local
 * and directory-provided alike, and each account carries its primary group
 * whole; `group.query` lists the groups. The second read is what the auxiliary
 * memberships are resolved against — an account names those by group record id
 * and by nothing else, so without the listing they are numbers with no meaning.
 *
 * The account record is the one place in this library where over-returning is a
 * hazard rather than a cost: it holds `unixhash`, `smbhash`, `sshpubkey` and
 * `password_history`, and passing a row through would put every one of them in
 * front of an LLM. Every field that survives is named here, so a credential a
 * later TrueNAS release adds to the record cannot reach a caller without a
 * change to this file.
 */

/** One group of the system, as this tool reports it. */
interface GroupRow {
  id: number;
  gid: number;
  name: string | null;
  local: boolean;
}

/**
 * A group an account named, resolved against the listing where it could be.
 *
 * `id` is what the account itself said. `gid` and `name` come from the group
 * listing, and are null where that id answers to no group in it — which is a
 * membership this tool could not place, never a membership that is not there.
 */
interface GroupReference {
  id: number | null;
  gid: number | null;
  name: string | null;
}

/** The group listing, or the failure that stopped it being read. */
interface Attempt {
  rows: GroupRow[] | null;
  error: string | null;
}

/**
 * One string field of a row, or null where the system reported no value.
 *
 * An empty string is read as no value rather than as text of no characters: an
 * account with no full name set is what the middleware sends `""` for, and
 * passing that through would put a field in the result that says nothing.
 *
 * `shares.ts`, `tasks.ts` and `block.ts` each hold the same reading under their
 * own names, and this restates rather than shares it for the reason `shares.ts`
 * gives for restating its own guards: a tool file is read on its own.
 */
function textOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * A number the system reported, or null where it reported anything else.
 *
 * Needed only for the primary group, which the account record embeds as
 * `Record<string, unknown>` on the pinned client: every field of it arrives as
 * `unknown` and has to be read rather than trusted. Non-finite is not a number
 * here — a group id that is `NaN` resolves against nothing.
 */
function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** What a failure carrying no text of its own is reported as. */
const NO_REASON = 'the system reported no reason';

/**
 * Why the group read failed, in words.
 *
 * A rejection is not necessarily an `Error` — the client rejects with whatever
 * the transport gave it — so a bare string is read too, and so are the two
 * shapes the client documents as its own: a JSON-RPC error object carrying
 * `message`, and a middleware error object carrying `reason`. Anything else
 * still becomes a stated absence rather than `"[object Object]"`, and the
 * result is never empty: a failure with no text still has to read as a failure.
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
 * The groups the system knows, with a failure named rather than thrown.
 *
 * Reported rather than fatal because the two reads fail independently: a groups
 * query that fails leaves every account still listed, still identified, and
 * still carrying the primary group its own record embedded. Losing all of that
 * to answer none of the question is the trade this exists to refuse.
 *
 * The tool holds one secondary read, so this names it directly instead of
 * carrying the `failures` list that `shares.ts` and `block.ts` use for their
 * several — a list that could only ever hold zero entries or one says less than
 * the field it would be holding.
 */
async function readGroups(system: SystemHandle): Promise<Attempt> {
  try {
    const groups = await firstValueFrom(system.client.api.query('group.query'));
    return {
      rows: groups.map((group) => ({
        id: group.id,
        gid: group.gid,
        // The entry declares a legacy `group` alias beside this, holding the
        // same text; only the current name is reported.
        name: textOrNull(group.name),
        local: group.local,
      })),
      error: null,
    };
  } catch (reason) {
    return { rows: null, error: errorText(reason) };
  }
}

/** A group id an account named, with what the listing says about it. */
function reference(id: number, listing: Map<number, GroupRow>): GroupReference {
  const listed = listing.get(id);
  return { id, gid: listed?.gid ?? null, name: listed?.name ?? null };
}

/**
 * The group an account owns new files as, from the record embedded in it.
 *
 * The listing is preferred over that record, field by field, because it is the
 * typed source and the one the auxiliary memberships resolve against: a group
 * named in both is named the same way in both. The embedded record is what
 * keeps a primary group reportable at all when the group read failed, when the
 * group is not in the listing, or when the listing holds no name for it — which
 * is why this can name a group that an auxiliary membership of the same id
 * could not, and why the tool's description says so.
 *
 * (unconfirmed) The field names the embedded record spells its gid and name
 * with are not typed by the pinned client, so they are read here as `gid` and
 * `name` on the evidence of the group entry beside it. Getting them wrong costs
 * a null rather than a wrong group.
 */
function primaryGroup(
  record: Record<string, unknown>,
  listing: Map<number, GroupRow>,
): GroupReference {
  const id = numberOrNull(record['id']);
  const listed = id === null ? undefined : listing.get(id);
  return {
    id,
    gid: listed?.gid ?? numberOrNull(record['gid']),
    name: listed?.name ?? textOrNull(record['name']),
  };
}

export const usersList: ReadOnlyTool = {
  name: 'users_list',
  description:
    'Every user account the system knows, local and directory-provided, with ' +
    'the groups each belongs to, and the groups themselves. `username`, `uid` ' +
    'and `full_name` identify the account, and `full_name` is null where none ' +
    "is set. `id` is the middleware's own record id and `uid` the POSIX user " +
    'id: DIFFERENT NUMBERS, and neither follows the other — `id` is what group ' +
    'membership is expressed in, and `uid` is what a file on disk is owned by. ' +
    '`local` is whether the account is defined on this system, and FALSE MEANS ' +
    'THE ACCOUNT COMES FROM A DIRECTORY SERVICE — Active Directory or LDAP — ' +
    'rather than that it is disabled or missing. `shell` is the login shell, ' +
    'null where the system reported none, which is usual for a directory ' +
    'account. `locked` is whether the account is barred from logging in, and ' +
    'is null where the system reported no value, WHICH IS NOT THE SAME AS ' +
    'UNLOCKED. `primary_group` is the group the account owns new files as, and ' +
    '`auxiliary_groups` the other groups it is a member of. Each is reported ' +
    'as `id`, `gid` and `name`, where `id` is the group record the account ' +
    'named. For an auxiliary group the other two come from `groups`, and are ' +
    'null where that id answers to no group there — one id naming a group this ' +
    'listing does not hold, or every id when the groups could not be read at ' +
    'all. THAT IS A MEMBERSHIP THAT COULD NOT BE PLACED, never one that is ' +
    'not there. The primary group is the one the account record carries whole, ' +
    'so its `gid` and `name` come from `groups` where its id is there and from ' +
    'that embedded record otherwise: it can be named where an auxiliary group ' +
    'of the same id could not be, and all three of its fields are null only ' +
    'where the record named nothing readable. `auxiliary_groups` is ' +
    'null where the system reported no membership at all, which is not the ' +
    'empty list it reports for an account belonging to no group beyond its ' +
    'primary one. `groups` is every group the system knows, each with its ' +
    '`id`, its `gid`, its `name` and whether it is `local` in the same sense a ' +
    'user is; it is null, with `groups_error` naming what the system said, ' +
    'where the groups could not be read, and an empty list with `groups_error` ' +
    'null where they were read and there are none. NO PASSWORD HASH, SSH KEY, ' +
    'TWO-FACTOR SECRET OR OTHER CREDENTIAL MATERIAL IS RETURNED BY THIS TOOL ' +
    'under any circumstances: only the fields named here are returned, ' +
    'whatever else a later TrueNAS release adds to an account record. This is ' +
    'the account listing rather than live state — it does not say who is ' +
    'logged in — and it does not report what an account is permitted to do: ' +
    'who may reach a share is `share_access`.',
  inputSchema: { type: 'object', properties: {} },
  requiredRole: Role.ReadOnly,
  mutating: false,
  async handler({ system }) {
    // Both reads are issued before either is awaited, so neither waits on the
    // other. Only the account read may fail the tool: the groups are what the
    // memberships resolve against, and with no accounts there is nothing for
    // them to resolve for.
    const [users, groups] = await Promise.all([
      firstValueFrom(system.client.api.query('user.query')),
      readGroups(system),
    ]);

    const listing = new Map((groups.rows ?? []).map((group) => [group.id, group]));

    return {
      users: users.map((user) => ({
        id: user.id,
        username: user.username,
        uid: user.uid,
        full_name: textOrNull(user.full_name),
        local: user.local,
        shell: textOrNull(user.shell),
        // Not defaulted to false: an account whose lock state was not reported
        // must not read as one that is definitely able to log in.
        locked: user.locked ?? null,
        primary_group: primaryGroup(user.group, listing),
        // The record names auxiliary groups by record id, and the field is
        // absent altogether on a system that reported no membership — which is
        // null here, distinct from the empty list of an account in no group
        // beyond its primary one.
        auxiliary_groups:
          user.groups === undefined ? null : user.groups.map((id) => reference(id, listing)),
      })),
      groups: groups.rows,
      groups_error: groups.error,
    };
  },
};
