import { firstValueFrom } from 'rxjs';
import type { QueryEntity } from '@truenas/api-client';
import { Role } from '@/interfaces';
import { ApiSurface, ReadOnlyTool, SystemHandle } from '@/catalog/tool';
import {
  booleanOrNull,
  effectiveLimit,
  errorText,
  numberOrNull,
  recordOrNull,
  strictTextList,
  textOrNull,
} from '@/tools/common';

/**
 * Accounts family: who has an account on this system, what each belongs to,
 * what the groups they belong to are permitted to do, and whether the directory
 * service the non-local ones come from is joined.
 *
 * `users_list` reads two middleware namespaces. `user.query` lists the
 * accounts, local and directory-provided alike, and each account carries its
 * primary group whole; `group.query` lists the groups. The second read is what
 * the auxiliary memberships are resolved against — an account names those by
 * group record id and by nothing else, so without the listing they are numbers
 * with no meaning.
 *
 * `privileges_list` reads `privilege.query`, which is the other half of that
 * question: `users_list` says who belongs to which group and this says what
 * holding a group is worth. The two are joined on the group, not on the
 * account, because a privilege is granted to a group and never to a user.
 *
 * `directory_services_status` reads two more. `directoryservices.status` is the
 * live join state, and it is the tool; `directoryservices.config` is where the
 * domain and the bind method are read from, and it is reported rather than
 * fatal for the reason `readConfig` gives.
 *
 * All three payloads are ones where over-returning is a hazard rather than a
 * cost. The account record holds `unixhash`, `smbhash`, `sshpubkey` and
 * `password_history`; the directory services configuration embeds the
 * credential the system binds with — a Kerberos `password`, an LDAP `bindpw`;
 * a privilege embeds whole group entities. Passing any of those rows through
 * would put every one of their fields in front of an LLM. Every field that
 * survives is named here, so a credential a later TrueNAS release adds to any
 * of those records cannot reach a caller without a change to this file.
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
 * `textOrNull` reads the account's full name, which the middleware sends as
 * `""` when it is unset; `numberOrNull` reads the primary group's id, which the
 * account record embeds as `Record<string, unknown>` so every field of it
 * arrives as `unknown`. Both come from `common.ts`, as does `errorText` for the
 * group read below.
 */

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
 * The bound this family applies, from whatever the caller asked for.
 *
 * Lenient rather than strict, as `snapshots_list` is about its own limit: a
 * misread bound only changes how many of the right rows come back, and the
 * number applied is returned beside them, so a caller can see that its argument
 * was not taken. The bounding is `common.ts`'s; the two numbers are this
 * family's.
 */
function accountLimit(raw: unknown): number {
  return effectiveLimit(raw, DEFAULT_LIMIT, MAX_LIMIT);
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
    const limit = accountLimit(args['limit']);
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
    'a departure is in progress), and `DISABLED` (no directory service is in ' +
    'effect, which is what a system with none configured reports as well as ' +
    'one that is configured and switched off — `service_type` is what tells ' +
    'those two apart); it is null where the system reported no state, WHICH ' +
    'IS NOT THE SAME AS HEALTHY. So "no directory service" is `service_type` ' +
    'null, and ' +
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

/** One privilege of the system, as the API surface in use types a row of it. */
type PrivilegeRow = QueryEntity<ApiSurface['call'], 'privilege.query'>;

/** A group the system named, as this tool reports one. */
interface ResolvedGroup {
  id: number | null;
  gid: number | null;
  name: string | null;
  local: boolean | null;
  builtin: boolean | null;
  sid: string | null;
}

/** What a privilege named where the system could not resolve it to a group. */
interface UnmappedGroup {
  gid: number | null;
  sid: string | null;
}

/**
 * One entry of a privilege's group list, under the arm it turned out to be.
 *
 * The middleware discriminates this payload — an entry is a `GroupEntry` or an
 * `UnmappedGroupEntry`, and the second carries a `group` of null where the
 * first carries the group's name — so it gets one allowlist per arm with the
 * arm reported, rather than a flattened row unioning both. The two arms share
 * no field that means the same thing: an `UnmappedGroupEntry`'s `gid` is what
 * the privilege ASKED FOR and did not get, while a `GroupEntry`'s is a fact
 * about a group that exists.
 */
interface PrivilegeGroup {
  kind: 'RESOLVED' | 'UNMAPPED' | 'UNREADABLE';
  group: ResolvedGroup | null;
  unmapped: UnmappedGroup | null;
}

/**
 * Whether somebody created this privilege on this system, from the stock name.
 *
 * Reduced to a fact rather than left to the caller to infer from a null
 * `builtin_name`, because that null has two causes and only one of them is the
 * interesting one: the system reporting no stock name, which is what an
 * operator-created privilege reports, and the field arriving as something that
 * is neither a name nor null. `textOrNull` answers null for both, so reading
 * the absence as "somebody defined this" would be a claim on the second.
 */
function operatorDefined(value: unknown): boolean | null {
  if (value === null) return true;
  return textOrNull(value) === null ? null : false;
}

/**
 * One group list of a privilege, with every entry kept.
 *
 * Null where the field was not a list at all, which is a list the system did
 * not report and never a privilege granted to no group of that kind. Nothing is
 * dropped: an entry that could not be read is reported as one, because a list
 * one entry shorter says one fewer group holds this privilege — understating
 * who has access, which is the direction the entry has to be kept in.
 */
function privilegeGroups(value: unknown): PrivilegeGroup[] | null {
  if (!Array.isArray(value)) return null;
  return value.map(privilegeGroup);
}

/**
 * One entry of a group list, read under whichever arm it is.
 *
 * `group` explicitly null is the unmapped arm, which is the discriminant the
 * client's own union declares. Anything else that is a record is read as a
 * resolved group — including a record carrying no `group` at all, since that
 * field is a legacy alias for the name and every field the resolved arm reports
 * is read through its own guard anyway. An entry that is not a record is
 * neither arm, and says so.
 */
function privilegeGroup(entry: unknown): PrivilegeGroup {
  const record = recordOrNull(entry);
  if (record === null) return { kind: 'UNREADABLE', group: null, unmapped: null };
  if (record['group'] === null) {
    return {
      kind: 'UNMAPPED',
      group: null,
      unmapped: { gid: numberOrNull(record['gid']), sid: textOrNull(record['sid']) },
    };
  }
  return {
    kind: 'RESOLVED',
    group: {
      id: numberOrNull(record['id']),
      gid: numberOrNull(record['gid']),
      name: textOrNull(record['name']),
      local: booleanOrNull(record['local']),
      builtin: booleanOrNull(record['builtin']),
      sid: textOrNull(record['sid']),
    },
    unmapped: null,
  };
}

export const privilegesList: ReadOnlyTool = {
  name: 'privileges_list',
  description:
    'Which groups hold which administrative roles on this system, and which of ' +
    'those grant web shell access. A privilege is granted to a GROUP AND NEVER ' +
    'TO A USER, so an account holds one by being a member of a group named ' +
    'here; who belongs to which group is `users_list`. `web_shell` IS THE ' +
    'FIELD TO READ FIRST: it is whether the privilege grants the web shell, ' +
    'which is a command line on the system and a different order of authority ' +
    'from any read role. It is null where the system reported no value, WHICH ' +
    'IS NOT THE SAME AS FALSE — a privilege whose shell access could not be ' +
    'read has not been shown to grant none. `name` is what the privilege is ' +
    "called and `id` the middleware's own record id; each is null where the " +
    'system reported no readable value for it. `builtin_name` is the name of ' +
    'the stock privilege this is, null BOTH where the system named none and ' +
    'where it reported something that could not be read as a name, ' +
    'and `operator_defined` is what tells those apart: TRUE where the system ' +
    'reported no stock name, so somebody created this privilege on this ' +
    "system, FALSE where it is one of the system's own, and NULL where the " +
    'field could not be read as either. An operator-defined privilege is the ' +
    'more interesting case, because nothing outside this system decided what ' +
    'it grants. `roles` are the administrative roles the privilege confers, by ' +
    'name, and `roles_reported` is whether the privilege carried that field at ' +
    'all; THE TWO ARE READ TOGETHER. `roles_reported` false with `roles` null ' +
    'is a TrueNAS version that does not report roles here. `roles_reported` ' +
    'true with `roles` an empty list is a privilege that confers no role. ' +
    '`roles_reported` true with `roles` null is a field that was there and ' +
    'would not read as a list of names — either it was not a list at all, or ' +
    'one of its names could not be read, AND THOSE TWO ARE NOT TOLD APART. ' +
    'THE WHOLE LIST IS NULLED WHERE ANY ONE NAME COULD NOT BE READ, ' +
    'deliberately, because a role list one name short says the group holds ' +
    'less authority than it does and that is a claim this tool will not make. ' +
    '`local_groups` are the groups defined on this system that hold the ' +
    'privilege and `ds_groups` those from a directory service — Active ' +
    'Directory or LDAP. Either is null where the system reported no list at ' +
    'all, which is NOT the empty list it reports for a privilege granted to no ' +
    'group of that kind. NOTHING IS EVER DROPPED FROM EITHER LIST, so its ' +
    'length is how many entries the system sent. `kind` says which of three an ' +
    'entry is. `RESOLVED` is a group the system resolved, and its `group` ' +
    'holds `id`, `gid`, `name`, whether the group is `local` in the same sense ' +
    'a user is, whether it is `builtin`, and its `sid`. EACH OF THOSE SIX IS ' +
    'NULL WHERE THE SYSTEM REPORTED NO READABLE VALUE FOR IT, so a `RESOLVED` ' +
    'entry whose `name` is null is a group the system resolved and did not ' +
    'name — `kind` is what separates that from an entry that resolved to ' +
    'nothing, and a null field never means the entry failed to resolve. ' +
    '`UNMAPPED` is a group the system could NOT name: `group` is null and ' +
    '`unmapped` holds the `gid` or `sid` the privilege named, either of which ' +
    'may itself be null. THAT IS A FINDING RATHER THAN A GAP IN THIS TOOL — ' +
    'in `ds_groups` it usually means a directory group that no longer ' +
    'resolves, so the privilege is held by something the system can no longer ' +
    'identify. `UNREADABLE` is an entry that was not a record at all, with ' +
    'both `group` and `unmapped` null. ONLY THE FIELDS NAMED HERE ARE RETURNED ' +
    'from an embedded group record, whatever else a later TrueNAS release adds ' +
    "to one: a group's own roles, its member accounts and its sudo command " +
    'lists are not reported, and the roles reported here are the ' +
    "PRIVILEGE's. Membership is `users_list`. This tool reports the role " +
    'landscape of the system; it does not say which of these privileges the ' +
    'credential it is running as holds, and it creates, edits and deletes ' +
    'nothing.',
  inputSchema: { type: 'object', properties: {} },
  requiredRole: Role.ReadOnly,
  mutating: false,
  async handler({ system }) {
    // Unbounded, unlike the account and group listings above: a privilege is
    // configuration an operator wrote, so the count is a handful whether or not
    // the system is joined to a directory with tens of thousands of groups.
    const privileges = await firstValueFrom(system.client.api.query('privilege.query'));

    return {
      privileges: privileges.map((privilege: PrivilegeRow) => ({
        id: numberOrNull(privilege.id),
        name: textOrNull(privilege.name),
        builtin_name: textOrNull(privilege.builtin_name),
        operator_defined: operatorDefined(privilege.builtin_name),
        // Not defaulted to false: a privilege whose shell access was not
        // reported must not read as one that definitely grants none.
        web_shell: booleanOrNull(privilege.web_shell),
        // `hasOwn` rather than `in`, which walks the prototype. The field is
        // optional on the surface, so its absence is a version that does not
        // report roles and is a different answer from a list that would not
        // read — which `roles` alone cannot tell apart, both being null.
        roles_reported: Object.hasOwn(privilege, 'roles'),
        // Strict rather than lenient per the direction rule: a role dropped
        // silently understates what the group may do, which is a claim.
        roles: strictTextList(privilege.roles),
        local_groups: privilegeGroups(privilege.local_groups),
        ds_groups: privilegeGroups(privilege.ds_groups),
      })),
    };
  },
};
