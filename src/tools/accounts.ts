import { firstValueFrom } from 'rxjs';
import { Role } from '@/interfaces';
import { ReadOnlyTool, SystemHandle } from '@/catalog/tool';

/**
 * Accounts family: who has an account on this system, what each belongs to, and
 * whether the directory service the non-local ones come from is joined.
 *
 * `users_list` reads two middleware namespaces. `user.query` lists the
 * accounts, local and directory-provided alike, and each account carries its
 * primary group whole; `group.query` lists the groups. The second read is what
 * the auxiliary memberships are resolved against — an account names those by
 * group record id and by nothing else, so without the listing they are numbers
 * with no meaning.
 *
 * `directory_services_status` reads two more. `directoryservices.status` is the
 * live join state, and it is the tool; `directoryservices.config` is where the
 * domain and the bind method are read from, and it is reported rather than
 * fatal for the reason `readConfig` gives.
 *
 * Both payloads are ones where over-returning is a hazard rather than a cost.
 * The account record holds `unixhash`, `smbhash`, `sshpubkey` and
 * `password_history`; the directory services configuration embeds the
 * credential the system binds with — a Kerberos `password`, an LDAP `bindpw`.
 * Passing either row through would put every one of them in front of an LLM.
 * Every field that survives is named here, so a credential a later TrueNAS
 * release adds to either record cannot reach a caller without a change to this
 * file.
 */

/**
 * How many accounts and how many groups `users_list` returns when the caller
 * names no bound, and the most it returns however large a bound is asked for.
 *
 * A TrueNAS joined to a directory service answers `user.query` with the
 * directory's accounts as well as its own — tens of thousands of them on a real
 * domain, and `group.query` in proportion. The whole set is neither answerable
 * inside a model's context nor useful once it is there. The same bound is
 * applied to each list separately, both numbers are stated in the tool's
 * description, and the bound actually applied comes back with the result, so a
 * caller never has to infer which one was in force.
 *
 * `snapshots.ts` bounds `pool.snapshot.query` the same way and for the same
 * reason; the numbers are restated here rather than shared for the reason that
 * file gives for restating its own guards: a tool file is read on its own.
 */
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;

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
  truncated: boolean;
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
async function readGroups(system: SystemHandle, limit: number): Promise<Attempt> {
  try {
    // One more row than the bound, as `snapshots.ts` does: that extra row is
    // what says the system held more than fit, and it is counted and dropped.
    // No `order_by` — the system applies the bound, so what it is asked to sort
    // on would decide WHICH groups a truncated listing holds, and no field of a
    // group orders it by relevance to the accounts being listed.
    const groups = await firstValueFrom(
      // Options are inlined so the call's own parameter types apply: written to
      // a `const` first they widen and the result degrades to `Partial<Entry>`.
      system.client.api.query('group.query', [], { limit: limit + 1 }),
    );
    return {
      rows: groups.slice(0, limit).map((group) => ({
        id: group.id,
        gid: group.gid,
        // The entry declares a legacy `group` alias beside this, holding the
        // same text; only the current name is reported.
        name: textOrNull(group.name),
        local: group.local,
      })),
      truncated: groups.length > limit,
      error: null,
    };
  } catch (reason) {
    // Not truncated: nothing was read, so nothing was left out of a list.
    return { rows: null, truncated: false, error: errorText(reason) };
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

/**
 * The bound actually applied, from whatever the caller asked for.
 *
 * Lenient rather than strict, as `snapshots_list` is about its own limit: a
 * misread bound only changes how many of the right rows come back, and the
 * number applied is returned beside them, so a caller can see that its argument
 * was not taken.
 */
function effectiveLimit(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return DEFAULT_LIMIT;
  // Rounded down because a fractional limit reaches the middleware as one, and
  // floored at 1 because a limit of zero or less would return nothing while
  // reporting the system as holding more — true, and not an answer.
  return Math.min(MAX_LIMIT, Math.max(1, Math.floor(raw)));
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
    'so its `gid` and `name` are taken from `groups` and EACH FALLS BACK, ' +
    'SEPARATELY, to that embedded record wherever the listing holds no value ' +
    'for it — a group in `groups` with no name still reports the name its ' +
    'account record gave. The primary group can therefore be named where an ' +
    'auxiliary membership of the same id could not be, and all three of its ' +
    'fields are null only where the account record named nothing readable. ' +
    '`auxiliary_groups` is ' +
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
    'who may reach a share is `share_access`. BOTH LISTS ARE BOUNDED: `users` ' +
    'holds at most `limit` accounts and `groups` at most `limit` groups — 100 ' +
    'by default and 1000 at most, and the `limit` returned is the bound ' +
    'actually applied. `users_truncated` and `groups_truncated` are true where ' +
    'the system holds more than were returned, which a system joined to a ' +
    'directory service usually does. Which accounts or groups a truncated list ' +
    "holds is the system's own choice, so it is evidence about the entries it " +
    'names and about nothing else: IT CANNOT SHOW THAT AN ACCOUNT IS ABSENT. ' +
    'While `groups_truncated` is true, a null `gid` and `name` on a membership ' +
    'may mean only that its group fell outside the bound rather than that the ' +
    'id answers to no group on the system. Raise `limit` until both are false, ' +
    'and only then read either list as everything that exists.',
  inputSchema: {
    type: 'object',
    properties: {
      limit: {
        type: 'number',
        minimum: 1,
        maximum: 1000,
        default: 100,
        description:
          'Return at most this many accounts, and at most this many groups. ' +
          'Default 100, maximum 1000.',
      },
    },
  },
  requiredRole: Role.ReadOnly,
  mutating: false,
  async handler({ system }, args) {
    const limit = effectiveLimit(args['limit']);
    // Both reads are issued before either is awaited, so neither waits on the
    // other. Only the account read may fail the tool: the groups are what the
    // memberships resolve against, and with no accounts there is nothing for
    // them to resolve for.
    const [users, groups] = await Promise.all([
      // Options inlined, and one row past the bound, for the reasons
      // `readGroups` gives.
      firstValueFrom(system.client.api.query('user.query', [], { limit: limit + 1 })),
      readGroups(system, limit),
    ]);

    const listing = new Map((groups.rows ?? []).map((group) => [group.id, group]));

    return {
      users: users.slice(0, limit).map((user) => ({
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
      users_truncated: users.length > limit,
      groups: groups.rows,
      groups_truncated: groups.truncated,
      groups_error: groups.error,
      limit,
    };
  },
};

/** What `directoryservices.config` contributes, when it could be read. */
interface DirectoryConfig {
  enabled: boolean;
  domain: string | null;
  server_urls: string[] | null;
  kerberos_realm: string | null;
  credential_type: string | null;
}

/** The directory services configuration, or the failure that stopped it. */
interface ConfigAttempt {
  values: DirectoryConfig | null;
  error: string | null;
}

/**
 * What the system is configured to join, with a failure named rather than
 * thrown.
 *
 * Reported rather than fatal for the reason `readGroups` is: the two reads fail
 * independently, and the question the tool is asked — is the directory service
 * joined and healthy — is answered by `directoryservices.status` on its own.
 * The status read is the one that may fail the tool, because a domain with no
 * state beside it says nothing about whether the join works.
 *
 * NO CREDENTIAL IS TAKEN OUT OF THIS PAYLOAD. `credential` embeds the secret
 * the system binds with — `password` on a Kerberos user, `bindpw` on an LDAP
 * plain bind — and only its `credential_type` discriminant is read, which names
 * HOW the system binds and never WITH WHAT.
 */
async function readConfig(system: SystemHandle): Promise<ConfigAttempt> {
  try {
    const entry = await firstValueFrom(system.client.api.call('directoryservices.config'));
    // The per-service configuration is a union carrying no discriminant of its
    // own, so each field is narrowed by the presence of the field itself: an
    // Active Directory or IPA configuration holds `domain` and an LDAP one does
    // not; an LDAP one holds `server_urls` and the other two do not.
    const configuration = entry.configuration ?? null;
    return {
      values: {
        enabled: entry.enable,
        domain:
          configuration !== null && 'domain' in configuration
            ? textOrNull(configuration.domain)
            : null,
        server_urls:
          configuration !== null && 'server_urls' in configuration
            ? configuration.server_urls
            : null,
        kerberos_realm: textOrNull(entry.kerberos_realm),
        credential_type: entry.credential?.credential_type ?? null,
      },
      error: null,
    };
  } catch (reason) {
    return { values: null, error: errorText(reason) };
  }
}

export const directoryServicesStatus: ReadOnlyTool = {
  name: 'directory_services_status',
  description:
    'Whether this system is joined to a directory service — Active Directory, ' +
    'IPA or LDAP — and whether that join is currently working. `service_type` ' +
    'is which one is configured, and NULL MEANS NONE IS: a system with no ' +
    'directory service is the ordinary case and is not a failure. `status` is ' +
    'the live state of the join, one of `HEALTHY` (joined and working), ' +
    '`FAULTED` (configured and NOT working), `JOINING` or `LEAVING` (a join or ' +
    'a departure is in progress), and `DISABLED` (configured but switched ' +
    'off); it is null where the system reported no state, WHICH IS NOT THE ' +
    'SAME AS HEALTHY. So "no directory service" is `service_type` null, and ' +
    '"a directory service that is not working" is `service_type` set with ' +
    '`status` `FAULTED` — the two never have to be told apart by reading ' +
    'prose. `status_message` is what the system said about that state, which ' +
    'is where the reason for a `FAULTED` join appears, and is null where it ' +
    'said nothing. `enabled` is whether the configured service is switched on, ' +
    'which is the setting rather than the state: a service can be enabled and ' +
    '`FAULTED` at the same time. `domain` is the Active Directory or IPA ' +
    'domain, and IS NULL FOR AN LDAP SERVICE, WHICH HAS NO DOMAIN — an LDAP ' +
    'directory is identified by `server_urls` instead, which is in turn null ' +
    'for Active Directory and IPA. `kerberos_realm` is the realm the join ' +
    'authenticates against, null where none is set. `credential_type` names ' +
    'HOW the system binds — a Kerberos user or principal, an anonymous, plain ' +
    'or certificate LDAP bind — and is null where no credential is ' +
    'configured. NO PASSWORD, BIND PASSWORD, KEYTAB OR CERTIFICATE IS ' +
    'RETURNED BY THIS TOOL under any circumstances: only the fields named here ' +
    'are returned, whatever else a later TrueNAS release adds to the ' +
    'configuration. `config_error` names what the system said when the ' +
    'configuration could not be read at all, and WHILE IT IS NON-NULL ' +
    '`enabled`, `domain`, `server_urls`, `kerberos_realm` and ' +
    '`credential_type` ARE ALL NULL BECAUSE THEY COULD NOT BE READ, not ' +
    'because they are unset — `service_type`, `status` and `status_message` ' +
    'come from a separate read and are unaffected. This tool reports the join; ' +
    'it does not join, leave or reconfigure anything, and it does not list the ' +
    'accounts the directory provides — that is `users_list`.',
  inputSchema: { type: 'object', properties: {} },
  requiredRole: Role.ReadOnly,
  mutating: false,
  async handler({ system }) {
    // Both reads are issued before either is awaited, so neither waits on the
    // other. Only the status read may fail the tool, for the reason
    // `readConfig` gives.
    const [status, config] = await Promise.all([
      firstValueFrom(system.client.api.call('directoryservices.status')),
      readConfig(system),
    ]);

    return {
      service_type: status.type,
      // Not defaulted to a state: a status the system did not report must not
      // read as one it did.
      status: status.status ?? null,
      status_message: textOrNull(status.status_msg),
      enabled: config.values?.enabled ?? null,
      domain: config.values?.domain ?? null,
      server_urls: config.values?.server_urls ?? null,
      kerberos_realm: config.values?.kerberos_realm ?? null,
      credential_type: config.values?.credential_type ?? null,
      config_error: config.error,
    };
  },
};
