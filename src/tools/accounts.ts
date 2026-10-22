import { firstValueFrom } from 'rxjs';
import type { QueryEntity } from '@truenas/api-client';
import { Role } from '@/interfaces';
import {
  ApiSurface,
  MutatingTool,
  PlanStep,
  ReadOnlyTool,
  SystemHandle,
  ToolContext,
} from '@/catalog/tool';
import {
  agreement,
  booleanOrNull,
  effectiveLimit,
  errorText,
  NONE_REPORTED,
  numberOrNull,
  plural,
  readStep,
  recordOrNull,
  refuseArgs,
  rowWithId,
  strictTextList,
  switchOutcome,
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
 * `user_create` is the family's first mutation, and it reads the same three
 * namespaces from the other side: `group.query` to resolve the groups it is
 * given by name, `privilege.query` to refuse any of them that holds a
 * privilege, and `user.query` for an account already under the username.
 *
 * `user_set_locked` is the second. It reads `user.query` for the account it is
 * given by id, `auth.me` to refuse locking the account the catalog itself is
 * signed in as, and `privilege.query` to name what the account's groups hold.
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
    'membership is expressed in and what `user_set_locked` takes, and `uid` is ' +
    'what a file on disk is owned by. ' +
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
    'who may reach a share is `share_access`, and which groups hold which ' +
    'ADMINISTRATIVE ROLES is `privileges_list`. A privilege is granted to a ' +
    'GROUP AND NEVER TO AN ACCOUNT, so what a named account may administer is ' +
    'this tool read together with that one — the memberships here, the roles ' +
    'there. BOTH LISTS ARE BOUNDED: `users` ' +
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

/** Why every password route is refused, worded once. */
const PASSWORD_REFUSED =
  'the account is always created with password login disabled and no password. A password ' +
  'is a secret, tool arguments are recorded verbatim in the audit trail, and setting one is ' +
  'not something this catalog does';

/** Why the remaining `user.create` arguments are refused. */
const USER_SCOPE_REFUSED = "out of this tool's scope";

/**
 * What `user_create` was asked to do, with groups still by NAME. Built in a
 * fixed key order and only from what was passed, so it is what `normalizeArgs`
 * returns and what the confirmation token binds.
 *
 * `smb` is not here: the only value it accepts is `false`, which is sent
 * whether or not it was passed, so the two spellings normalize to one.
 * `home_create` is kept only where it is `true`, for the same reason.
 */
interface UserCreateArgs {
  username: string;
  full_name: string;
  email?: string;
  group: string;
  groups: string[];
  home?: string;
  home_create?: true;
  shell?: string;
  sshpubkey?: string;
}

/** A non-empty string argument, or the error naming it. */
function requiredText(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (value === undefined) throw new Error(`"${key}" is required`);
  if (textOrNull(value) === null) throw new Error(`"${key}" must be a non-empty string`);
  return value as string;
}

/** The auxiliary group names: none where omitted, each named once. */
function groupNames(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((name) => textOrNull(name) === null)) {
    throw new Error('"groups" must be a list of group names');
  }
  const names = value as string[];
  const repeated = names.find((name, index) => names.indexOf(name) !== index);
  if (repeated !== undefined) throw new Error(`"groups" names "${repeated}" more than once`);
  return names;
}

function parseUserCreate(args: Record<string, unknown>): UserCreateArgs {
  refuseArgs(
    args,
    ['password', 'random_password', 'password_disabled', 'ssh_password_enabled'],
    PASSWORD_REFUSED,
  );
  refuseArgs(
    args,
    [
      'sudo_commands',
      'sudo_commands_nopasswd',
      'uid',
      'userns_idmap',
      'group_create',
      'home_mode',
      'locked',
    ],
    USER_SCOPE_REFUSED,
  );
  const smb = args['smb'];
  if (smb !== undefined) {
    if (typeof smb !== 'boolean') throw new Error('"smb" must be a boolean');
    if (smb) {
      throw new Error(
        '"smb" may only be false: SMB authenticates with a password hash, and this tool ' +
          'creates the account with password login disabled and no password',
      );
    }
  }
  const parsed: UserCreateArgs = {
    username: requiredText(args, 'username'),
    full_name: requiredText(args, 'full_name'),
    group: '',
    groups: [],
  };
  if (args['email'] !== undefined) parsed.email = requiredText(args, 'email');
  parsed.group = requiredText(args, 'group');
  parsed.groups = groupNames(args['groups']);
  if (parsed.groups.includes(parsed.group)) {
    throw new Error(
      `"${parsed.group}" is named as the primary group and again in "groups": name it once, as "group"`,
    );
  }
  const home = args['home'];
  if (home !== undefined) {
    if (typeof home !== 'string' || !home.startsWith('/')) {
      throw new Error('"home" must be an absolute path, such as "/mnt/tank/homes"');
    }
    parsed.home = home;
  }
  const homeCreate = args['home_create'];
  if (homeCreate !== undefined) {
    if (typeof homeCreate !== 'boolean') throw new Error('"home_create" must be a boolean');
    if (homeCreate) {
      if (parsed.home === undefined) {
        throw new Error('"home_create" needs "home", the directory the home directory is made in');
      }
      parsed.home_create = true;
    }
  }
  if (args['shell'] !== undefined) parsed.shell = requiredText(args, 'shell');
  if (args['sshpubkey'] !== undefined) parsed.sshpubkey = requiredText(args, 'sshpubkey');
  return parsed;
}

/** A group an account is to be put in, resolved from its name. */
interface MemberGroup {
  name: string;
  id: number;
  gid: number;
}

/** How a plan names a group: by name, and by both numbers it was resolved to. */
function groupText(group: MemberGroup): string {
  return `"${group.name}" (id ${group.id}, gid ${group.gid})`;
}

/**
 * Every group named, resolved by name to the ids `user.create` takes, or the
 * error naming the first that cannot be.
 *
 * Matched on the RESPONSE, by name, and never on the row count: an
 * unrecognised filter is dropped rather than refused, and the first row of a
 * filter that did not apply is a different group (#121, #153). A read that
 * failed fails the create rather than being stated (#185): an approver would
 * otherwise be shown a number they cannot check.
 *
 * Refused as well as unresolved:
 * - a group that is not LOCAL, because this tool creates a local account in
 *   local groups, and a directory group's membership is the directory's;
 * - a group carrying sudo commands, read here because they are a group's own
 *   field and not a privilege — membership in such a group is administrative
 *   authority exactly as a privilege is, and `sudo_commands` is refused as an
 *   argument for that reason. A list that is present and unreadable is refused
 *   too, since it cannot be ruled out; an absent one is a version that does not
 *   report it.
 */
async function resolveGroups(ctx: ToolContext, names: string[]): Promise<MemberGroup[]> {
  let rows: unknown;
  try {
    rows = await firstValueFrom(ctx.system.client.api.query('group.query', [['name', 'in', names]]));
  } catch (reason) {
    throw new Error(
      `The groups named could not be read (group.query failed: ${errorText(reason)}), so no ` +
        'account is created in them',
    );
  }
  if (!Array.isArray(rows)) {
    throw new Error(
      'The groups named could not be read (group.query did not answer with a list), so no ' +
        'account is created in them',
    );
  }
  const records = rows.map((row) => recordOrNull(row));
  return names.map((name) => {
    const matches = records.filter(
      (row): row is Record<string, unknown> => row !== null && textOrNull(row['name']) === name,
    );
    if (matches.length === 0) {
      throw new Error(
        `No group named "${name}" on this system — \`users_list\` reports every group by name, ` +
          'and this tool creates none',
      );
    }
    if (matches.length > 1) {
      throw new Error(`${matches.length} groups are named "${name}", so which one is meant cannot be told`);
    }
    const [row] = matches;
    const id = numberOrNull(row['id']);
    const gid = numberOrNull(row['gid']);
    if (id === null || gid === null) {
      throw new Error(`Group "${name}" is listed with no id or gid this tool could read, so no account is put in it`);
    }
    if (row['local'] !== true) {
      throw new Error(
        `Group "${name}" is not reported as a local group, and this tool puts a local account ` +
          'in local groups only',
      );
    }
    for (const key of ['sudo_commands', 'sudo_commands_nopasswd']) {
      if (row[key] === undefined) continue;
      const commands = strictTextList(row[key]);
      if (commands === null) {
        throw new Error(
          `Group "${name}"'s ${key} could not be read, so whether membership grants sudo cannot ` +
            'be ruled out, and no account is put in it',
        );
      }
      if (commands.length > 0) {
        throw new Error(
          `Group "${name}" grants sudo commands (${key}), which makes membership administrative ` +
            'authority, and this tool puts no account in such a group',
        );
      }
    }
    return { name, id, gid };
  });
}

/**
 * Refuses the create if any group named holds a privilege — option 1 of the
 * ticket's privileged-group decision.
 *
 * A privilege is granted to a group and never to an account (`privileges_list`),
 * so an account put in a privileged group holds that privilege's roles from the
 * moment it exists. Refusing names the group and the privilege, and is
 * checkable by the caller from `privileges_list`; allowing it with the roles
 * stated would leave the catalog creating new administrators on an approval.
 *
 * Only `local_groups` is read: every group this tool accepts is local, and a
 * local group is granted a privilege there and nowhere else. An entry is matched
 * on its `gid` OR its `id`, either agreeing with the group's — matching on more
 * refuses more, which is the direction to be wrong in here. Anything that stops
 * the answer being read — the read failing, a privilege that is not a record, a
 * `local_groups` that is not a list, an entry with neither number readable —
 * refuses too, because a privilege that could not be ruled out has not been.
 */
async function refusePrivilegedGroups(ctx: ToolContext, groups: MemberGroup[]): Promise<void> {
  const where = '`privileges_list` reports which groups hold which roles';
  let rows: unknown;
  try {
    rows = await firstValueFrom(ctx.system.client.api.query('privilege.query'));
  } catch (reason) {
    throw new Error(
      `Which groups hold a privilege could not be read (privilege.query failed: ` +
        `${errorText(reason)}), so no account is created — ${where}`,
    );
  }
  if (!Array.isArray(rows)) {
    throw new Error(
      'Which groups hold a privilege could not be read (privilege.query did not answer with a ' +
        `list), so no account is created — ${where}`,
    );
  }
  for (const row of rows) {
    const privilege = recordOrNull(row);
    const label =
      textOrNull(privilege?.['name']) ?? `with id ${numberOrNull(privilege?.['id']) ?? 'unread'}`;
    const entries = privilege?.['local_groups'];
    if (privilege === null || !Array.isArray(entries)) {
      throw new Error(
        `Privilege "${label}" could not be read as granting to any list of local groups, so ` +
          `whether it covers a group named cannot be ruled out, and no account is created — ${where}`,
      );
    }
    for (const entry of entries) {
      const held = recordOrNull(entry);
      const gid = numberOrNull(held?.['gid']);
      const id = numberOrNull(held?.['id']);
      if (gid === null && id === null) {
        throw new Error(
          `Privilege "${label}" names a local group this tool could not read, so it may be a ` +
            `group named here, and no account is created — ${where}`,
        );
      }
      const match = groups.find((group) => group.gid === gid || group.id === id);
      if (match !== undefined) {
        throw new Error(
          `Group "${match.name}" holds privilege "${label}", so an account in it would hold ` +
            "that privilege's administrative roles, and this tool puts no account in a " +
            `privileged group — ${where}`,
        );
      }
    }
  }
}

/**
 * What the plan says about an account already answering to the username.
 *
 * An exact match fails the plan, naming it. Plan-time only and not a step,
 * since `execute` does not make this read (#119), and a failed read is stated
 * rather than failing the plan (#154): the middleware is where a duplicate is
 * finally refused.
 */
async function usernameSentence(ctx: ToolContext, username: string): Promise<string> {
  let rows: unknown;
  try {
    rows = await firstValueFrom(ctx.system.client.api.query('user.query', [['username', '=', username]]));
  } catch (reason) {
    return (
      ` Whether an account named "${username}" already exists could not be read ` +
      `(user.query failed: ${errorText(reason)}).`
    );
  }
  if (!Array.isArray(rows)) {
    return (
      ` Whether an account named "${username}" already exists could not be read ` +
      '(user.query did not answer with a list).'
    );
  }
  const clash = rows
    .map((row) => recordOrNull(row))
    .find((row) => row !== null && textOrNull(row['username']) === username);
  if (clash !== undefined && clash !== null) {
    throw new Error(
      `An account named "${username}" already exists on this system (id ` +
        `${numberOrNull(clash['id']) ?? 'unread'}, uid ${numberOrNull(clash['uid']) ?? 'unread'}) — ` +
        '`users_list` reports it',
    );
  }
  return ` No account named "${username}" exists on this system now.`;
}

/** How the account can be logged in to, which is the question a password-less account raises. */
function loginSentence(sshpubkey: string | undefined): string {
  const unset = 'Setting a password is not something this catalog does.';
  if (sshpubkey !== undefined) {
    return (
      ' The account has NO PASSWORD and cannot log in with one. It can log in over SSH with ' +
      'the public key given, where the SSH service is running and admits it — which is not ' +
      `read here. ${unset}`
    );
  }
  return (
    ' The account has NO PASSWORD AND NO SSH KEY, so NOBODY CAN LOG IN TO IT until one is set ' +
    `outside this catalog. That is the ordinary outcome of this tool, not a failure. ${unset}`
  );
}

/** What the plan says about the home directory. */
function homeSentence(parsed: UserCreateArgs): string {
  if (parsed.home === undefined) return '';
  if (parsed.home_create === true) {
    return (
      ` A home directory for the account is CREATED in "${parsed.home}", on whatever dataset ` +
      'that path is in; whether the system names it after the user inside that path is ' +
      '(unconfirmed), so the path actually used is read back into the result.'
    );
  }
  return (
    ` Home directory "${parsed.home}" is recorded for the account; nothing is created there ` +
    'and whether it exists is not checked here.'
  );
}

/** The optional settings a create did NOT send, which the system then decides. */
function userDefaultsSentence(parsed: UserCreateArgs): string {
  const unsent = (['email', 'home', 'shell'] as const).filter((key) => parsed[key] === undefined);
  if (unsent.length === 0) return '';
  return ` Not sent, and so left to the system's defaults, which are not read here: ${unsent.join(', ')}.`;
}

/** Exactly what `user.create` is sent, in one fixed order. */
function userCreateRequest(parsed: UserCreateArgs, primary: MemberGroup, auxiliary: MemberGroup[]) {
  return {
    username: parsed.username,
    full_name: parsed.full_name,
    ...(parsed.email === undefined ? {} : { email: parsed.email }),
    group: primary.id,
    groups: auxiliary.map((group) => group.id),
    group_create: false,
    password_disabled: true,
    // Sent rather than left out because whether the middleware's own default
    // is SMB on — which it would then refuse beside a disabled password — is
    // read from the TrueNAS implementation and not from this surface.
    smb: false,
    ...(parsed.home === undefined ? {} : { home: parsed.home }),
    ...(parsed.home_create === undefined ? {} : { home_create: parsed.home_create }),
    ...(parsed.shell === undefined ? {} : { shell: parsed.shell }),
    ...(parsed.sshpubkey === undefined ? {} : { sshpubkey: parsed.sshpubkey }),
  };
}

/** Every name the create resolves, the primary group first. */
function allGroupNames(parsed: UserCreateArgs): string[] {
  return [parsed.group, ...parsed.groups];
}

/**
 * The membership list off the response, all of it or none: a list one id
 * shorter says the account is in one fewer group, which understates what it
 * may do (#93).
 */
function idList(value: unknown): number[] | null {
  if (!Array.isArray(value)) return null;
  const ids: number[] = [];
  for (const entry of value) {
    const id = numberOrNull(entry);
    if (id === null) return null;
    ids.push(id);
  }
  return ids;
}

/**
 * The created account, field by field. NAMED, NEVER TRIMMED: the response
 * carries `unixhash` and `smbhash`, which are password hashes, and `password`,
 * which is where a generated password would be returned — none of which may
 * reach a result, since results are recorded verbatim in the audit trail.
 */
interface CreatedUser {
  id: number | null;
  uid: number | null;
  username: string | null;
  full_name: string | null;
  email: string | null;
  primary_group: number | null;
  groups: number[] | null;
  home: string | null;
  shell: string | null;
  password_disabled: boolean | null;
  smb: boolean | null;
  locked: boolean | null;
}

function createdUser(row: Record<string, unknown>): CreatedUser {
  return {
    id: numberOrNull(row['id']),
    uid: numberOrNull(row['uid']),
    username: textOrNull(row['username']),
    full_name: textOrNull(row['full_name']),
    email: textOrNull(row['email']),
    primary_group: numberOrNull(recordOrNull(row['group'])?.['id']),
    groups: idList(row['groups']),
    home: textOrNull(row['home']),
    shell: textOrNull(row['shell']),
    password_disabled: booleanOrNull(row['password_disabled']),
    smb: booleanOrNull(row['smb']),
    locked: booleanOrNull(row['locked']),
  };
}

/** A membership list as one comparable value, independent of order. */
function membershipToken(ids: number[] | null): string | null {
  return ids === null ? null : JSON.stringify([...ids].sort((a, b) => a - b));
}

const USER_CREATE_GUIDANCE =
  '`requested` is exactly what was sent, with the groups as the ids they ' +
  'resolved to when the call was made. `user` is the created account read back ' +
  'off the response the create itself answered with — never copied from the ' +
  'request — or null where that response was not a record. Its fields are `id`, ' +
  "the middleware's record id; `uid`, the POSIX user id; `username`; " +
  '`full_name`; `email`; `primary_group`, the record id of the group it owns new ' +
  'files as; `groups`, the record ids of its other groups, null where the list ' +
  'was absent or any entry of it could not be read; `home`, which is the path ' +
  'the system actually stored and may differ from the one sent where a home ' +
  'directory was created; `shell`; `password_disabled`; `smb`; and `locked`. ' +
  'Each is null where the response stated no value this tool could read. NO ' +
  'PASSWORD HASH, GENERATED PASSWORD OR SSH KEY IS RETURNED. `confirmed` is ' +
  'whether `user` holds the username, full name, primary group, other groups, ' +
  'disabled password and SMB setting that were sent: true is the system reporting ' +
  'back what was asked for; FALSE IS NOT A SUCCESS — the call did not reject and ' +
  'at least one of those was stored as something else; and null is a response in ' +
  'which one could not be read back and none read back as different. A null ' +
  '`user` means nothing here establishes that an account was created, and is ' +
  'not evidence that none was — `users_list` shows what the system now holds.';

export const userCreate: MutatingTool = {
  name: 'user_create',
  description:
    'Creates one local user account on this TrueNAS system, with NO PASSWORD, in ' +
    'groups that already exist. Two-phase: called without a confirmation_token it ' +
    'returns a plan for user approval; called with one it creates the account. ' +
    '`username`, `full_name` and `group`, the primary group, are required; ' +
    '`groups`, `email`, `home` with `home_create`, `shell` and `sshpubkey` are ' +
    'optional. Groups are named, as `users_list` reports them, and resolved to the ' +
    'ids the system holds them under; a name no local group has fails the plan, ' +
    'naming it, and this tool creates no group. THE ACCOUNT IS ALWAYS CREATED WITH ' +
    'PASSWORD LOGIN DISABLED: `password` and `random_password` are refused, because ' +
    'a password is a secret and tool arguments and results are recorded verbatim ' +
    'in the audit trail. With no `sshpubkey` NOBODY CAN LOG IN TO THE ACCOUNT ' +
    'until a password or key is set outside this catalog, and the plan says so. ' +
    '`smb` accepts only false and false is always sent, since SMB authenticates ' +
    'with a password hash. A GROUP THAT HOLDS A PRIVILEGE IS REFUSED, naming the ' +
    'group and the privilege, as is a group granting sudo commands: membership in ' +
    'either is administrative authority, and `privileges_list` is where which ' +
    'groups hold which roles is read. Both checks are made when the plan is made ' +
    'and again when the account is created, and nothing is created if either ' +
    'fails then. `sudo_commands`, `uid` and `group_create` are refused. A username ' +
    'an existing account already has fails the plan, naming it. ' +
    '`destructiveness` is `reversible`, but NO TOOL IN THIS CATALOG DELETES A ' +
    'USER: undoing this means deleting the account outside this catalog, and ' +
    'the most this catalog can do is lock it with `user_set_locked`. ' +
    USER_CREATE_GUIDANCE,
  resultGuidance: USER_CREATE_GUIDANCE,
  inputSchema: {
    type: 'object',
    properties: {
      username: { type: 'string', description: 'The login name of the new account.' },
      full_name: { type: 'string', description: "The account holder's full name." },
      group: {
        type: 'string',
        description:
          'The name of the existing local group the account owns new files as, as ' +
          '`users_list` reports it.',
      },
      groups: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional; names of further existing local groups the account is a member of.',
      },
      email: { type: 'string', description: 'Optional; the account holder\'s email address.' },
      home: {
        type: 'string',
        description: 'Optional; the absolute path recorded as the home directory, or made in with `home_create`.',
      },
      home_create: {
        type: 'boolean',
        description: 'Optional, and only with `home`; true creates a home directory for the account in that path.',
      },
      shell: { type: 'string', description: 'Optional; the login shell, e.g. "/usr/bin/bash".' },
      smb: {
        type: 'boolean',
        enum: [false],
        description: 'Optional, and only false, which is what is sent either way.',
      },
      sshpubkey: {
        type: 'string',
        description: 'Optional; an SSH PUBLIC key the account may log in with. Never a private key.',
      },
    },
    required: ['username', 'full_name', 'group'],
  },
  requiredRole: Role.Full,
  mutating: true,
  // Additive: the account is a new row and nothing existing is removed. What it
  // can do is stated in the plan rather than recorded here.
  destructiveness: 'reversible',
  normalizeArgs(rawArgs) {
    return { ...parseUserCreate(rawArgs) };
  },
  async plan(ctx, rawArgs): Promise<PlanStep[]> {
    const parsed = parseUserCreate(rawArgs);
    const names = allGroupNames(parsed);
    const [primary, ...auxiliary] = await resolveGroups(ctx, names);
    await refusePrivilegedGroups(ctx, [primary, ...auxiliary]);
    const clash = await usernameSentence(ctx, parsed.username);
    const memberships =
      auxiliary.length === 0
        ? 'and in no other group'
        : `and also in ${plural(auxiliary.length, 'group')} ${auxiliary.map(groupText).join(', ')}`;
    return [
      {
        method: 'group.query',
        params: [[['name', 'in', names]], {}],
        description:
          `Look up ${plural(names.length, 'group')} by name, to send the ids the system holds ` +
          `them under — ${[primary, ...auxiliary].map(groupText).join(', ')} when this plan was ` +
          'made. Changes nothing. If any of them is not listed, not local, or grants sudo ' +
          'commands when this runs, nothing is created.',
      },
      {
        method: 'privilege.query',
        params: [[], {}],
        description:
          'Read every privilege, to refuse the create if a group named above holds one — ' +
          'none did when this plan was made. Changes nothing. If one does when this runs, ' +
          'nothing is created.',
      },
      {
        method: 'user.create',
        params: [userCreateRequest(parsed, primary, auxiliary)],
        description:
          `Create local user "${parsed.username}", full name ${JSON.stringify(parsed.full_name)}` +
          `${parsed.email === undefined ? '' : `, email ${JSON.stringify(parsed.email)}`}, with ` +
          `primary group ${groupText(primary)} ${memberships}. Password login is disabled ` +
          '(password_disabled true) and SMB access is off (smb false); no group is created ' +
          `(group_create false).${loginSentence(parsed.sshpubkey)}${homeSentence(parsed)}` +
          `${parsed.shell === undefined ? '' : ` Login shell ${JSON.stringify(parsed.shell)}.`}` +
          `${userDefaultsSentence(parsed)} No group named holds a privilege or grants sudo ` +
          `commands.${clash}`,
      },
    ];
  },
  async execute(ctx, rawArgs) {
    const parsed = parseUserCreate(rawArgs);
    // Read again rather than taken from the plan: the confirmation token binds
    // the arguments and not the plan, and the arguments are NAMES. A group gone,
    // or privileged since, fails here, before anything is created (#181).
    const [primary, ...auxiliary] = await resolveGroups(ctx, allGroupNames(parsed));
    await refusePrivilegedGroups(ctx, [primary, ...auxiliary]);
    const requested = userCreateRequest(parsed, primary, auxiliary);
    const created: unknown = await firstValueFrom(
      ctx.system.client.api.call('user.create', [requested]),
    );
    const held = recordOrNull(created);
    const user = held === null ? null : createdUser(held);
    return {
      requested,
      user,
      confirmed:
        user === null
          ? null
          : agreement(
              {
                username: requested.username,
                full_name: requested.full_name,
                primary_group: requested.group,
                groups: membershipToken(requested.groups),
                password_disabled: true,
                smb: false,
              },
              {
                username: user.username,
                full_name: user.full_name,
                primary_group: user.primary_group,
                groups: membershipToken(user.groups),
                password_disabled: user.password_disabled,
                smb: user.smb,
              },
            ),
    };
  },
};

/** The caller's arguments to `user_set_locked`, or the error naming what is wrong with them. */
function parseUserSetLocked(args: Record<string, unknown>): { id: number; locked: boolean } {
  // Strict on both, as `share_set_enabled` is: a coerced `"false"` would lock
  // an account the caller asked to unlock, and `3.5` is no account's record id.
  const id = args['id'];
  if (typeof id !== 'number' || !Number.isInteger(id)) {
    throw new Error("\"id\" is required and must be a whole number: the account's `id` as `users_list` reports it");
  }
  const locked = args['locked'];
  if (typeof locked !== 'boolean') throw new Error('"locked" is required and must be a boolean');
  return { id, locked };
}

/**
 * Whatever `user.query` answered for this id, unread. The filter is bandwidth
 * and not the control: {@link rowWithId} checks the id on the response.
 */
function readAccount(ctx: ToolContext, id: number): Promise<unknown> {
  return firstValueFrom(ctx.system.client.api.query('user.query', [['id', '=', id]]));
}

/** An account as a plan or a refusal names it: by username and full name, beside the id. */
function accountText(row: Record<string, unknown>, id: number): string {
  const username = textOrNull(row['username']);
  const fullName = textOrNull(row['full_name']);
  return (
    `${username === null ? `username ${NONE_REPORTED}` : `"${username}"`} ` +
    `(full name ${fullName === null ? NONE_REPORTED : JSON.stringify(fullName)}, id ${id})`
  );
}

/**
 * Refuses an account this tool does not lock or unlock: one that is not local,
 * and one that is `builtin` or `immutable`, naming the field. A field that
 * cannot be read refuses too, since an account that could not be ruled out has
 * not been — the same direction `user_create`'s privilege check takes.
 */
function refuseProtectedAccount(row: Record<string, unknown>, label: string): void {
  if (row['local'] !== true) {
    throw new Error(
      `Account ${label} is not reported as a local account, and this tool locks local accounts ` +
        'only — a directory-service account is disabled in its directory',
    );
  }
  for (const field of ['builtin', 'immutable'] as const) {
    const value = booleanOrNull(row[field]);
    if (value === true) {
      throw new Error(`Account ${label} is ${field} (${field} true), and this tool does not lock or unlock it`);
    }
    if (value === null) {
      throw new Error(
        `Account ${label}'s ${field} could not be read, so whether it is ${field} cannot be ruled ` +
          'out, and this tool does not lock or unlock it',
      );
    }
  }
}

/**
 * Refuses to lock the account the catalog is signed in as, which `auth.me`
 * names by `pw_name` and `pw_uid` — not by the record id this tool takes, so
 * the account is matched on its username OR its uid, and matching more refuses
 * more. Whether a lock ends the session already using it is (unconfirmed), and
 * that is exactly why this is refused rather than warned about: if it does, the
 * catalog loses the system part-way through, with nothing left to unlock it.
 *
 * A read that fails or names no user refuses too: the one thing it exists to
 * rule out has not been. Only a lock is checked — unlocking the catalog's own
 * account cannot lock it out.
 */
async function refuseOwnAccount(ctx: ToolContext, row: Record<string, unknown>, label: string): Promise<void> {
  const unread = (why: string) =>
    new Error(
      `Which account this catalog is signed in as could not be read (${why}), so locking ` +
        `${label} cannot be ruled out as locking the catalog out of this system, and nothing is planned`,
    );
  let me: unknown;
  try {
    me = await firstValueFrom(ctx.system.client.api.call('auth.me'));
  } catch (reason) {
    throw unread(`auth.me failed: ${errorText(reason)}`);
  }
  const session = recordOrNull(me);
  const name = textOrNull(session?.['pw_name']);
  const uid = numberOrNull(session?.['pw_uid']);
  if (name === null && uid === null) throw unread('auth.me named no user');
  if (
    (name !== null && name === textOrNull(row['username'])) ||
    (uid !== null && uid === numberOrNull(row['uid']))
  ) {
    throw new Error(
      `Account ${label} is the account this catalog is signed in to this system as (auth.me), and ` +
        'the catalog will not lock its own account: whether a lock ends the session it is using is ' +
        '(unconfirmed), and if it did, nothing here could unlock it again',
    );
  }
}

/**
 * What the plan says about the privileges the account's groups hold, since
 * locking the last account holding one is a lockout an approver should see.
 *
 * Plan-time only and not a step, since `execute` does not make this read
 * (#119), and every failure is stated rather than failing the plan (#154).
 * The account's groups are its primary group and the ids in `groups`; a
 * privilege's `local_groups` entry is matched on its `id` against those, or
 * on its `gid` against the primary group's — matching on more names more. Where
 * anything stops that from being read in full, the sentence says so rather
 * than claiming none: a shorter list says the account holds less authority.
 */
async function privilegeSentence(ctx: ToolContext, row: Record<string, unknown>, locked: boolean): Promise<string> {
  const where = '`privileges_list` reports which groups hold which roles.';
  const primary = recordOrNull(row['group']);
  const primaryId = numberOrNull(primary?.['id']);
  const primaryGid = numberOrNull(primary?.['gid']);
  // Absent is not "no other group": `users_list` reads it as no membership
  // reported, and a list not reported cannot rule a privilege out.
  const auxiliary = idList(row['groups']);
  let partial = primaryId === null || auxiliary === null;
  const ids = [...(primaryId === null ? [] : [primaryId]), ...(auxiliary ?? [])];
  let rows: unknown;
  try {
    rows = await firstValueFrom(ctx.system.client.api.query('privilege.query'));
  } catch (reason) {
    return ` Whether its groups hold a privilege could not be read (privilege.query failed: ${errorText(reason)}); ${where}`;
  }
  if (!Array.isArray(rows)) {
    return ` Whether its groups hold a privilege could not be read (privilege.query did not answer with a list); ${where}`;
  }
  const held: string[] = [];
  for (const entry of rows) {
    const privilege = recordOrNull(entry);
    const groups = privilege?.['local_groups'];
    if (privilege === null || !Array.isArray(groups)) {
      partial = true;
      continue;
    }
    const label =
      textOrNull(privilege['name']) ?? `with id ${numberOrNull(privilege['id']) ?? 'unread'}`;
    const holds = groups.some((group) => {
      const record = recordOrNull(group);
      const id = numberOrNull(record?.['id']);
      const gid = numberOrNull(record?.['gid']);
      if (id === null && gid === null) partial = true;
      return (id !== null && ids.includes(id)) || (gid !== null && gid === primaryGid);
    });
    if (holds) held.push(`"${label}"`);
  }
  const caveat = partial
    ? ' Not every group or privilege could be read, so others may be held too.'
    : '';
  if (held.length === 0) {
    return partial
      ? ` Whether its groups hold a privilege could not be read in full, so this plan does not say they hold none; ${where}`
      : ' None of its groups holds a privilege.';
  }
  const effect = locked
    ? 'LOCKING IT BARS THAT ADMINISTRATIVE ACCESS, and whether any other account still holds ' +
      'it is not read here — if this is the last such account, no account that can log in holds it afterwards.'
    : 'Unlocking it restores that administrative access.';
  return ` Its groups hold ${plural(held.length, 'privilege')} ${held.join(', ')}. ${effect}${caveat}`;
}

/** What the plan says the call will do, given the lock state read now. */
function lockSentence(current: boolean | null, target: boolean): string {
  if (current === null) return 'Whether it is locked now could not be read, so this may change nothing.';
  if (current === target) {
    return `It is already ${current ? 'locked' : 'unlocked'}, so this changes nothing and is not an error.`;
  }
  return `It is ${current ? 'locked' : 'unlocked'}, so this will ${target ? 'lock' : 'unlock'} it.`;
}

/** How many API keys the account has, off a row or a response; null where the list could not be read. */
function apiKeyCount(row: Record<string, unknown> | null): number | null {
  const keys = idList(row?.['api_keys']);
  return keys === null ? null : keys.length;
}

/**
 * What a lock is and is not shown to do — one text for the description and the
 * plan, so neither can promise more than the other.
 */
const LOCK_REACH =
  'A lock is understood to bar the account from logging in with a password (unconfirmed). ' +
  "WHETHER IT REVOKES THE ACCOUNT'S API KEYS OR ENDS ITS OPEN SESSIONS IS NOT ESTABLISHED, and " +
  'this tool does neither: a locked account\'s existing API keys and sessions have not been ' +
  'shown to stop working.';

const USER_SET_LOCKED_GUIDANCE =
  '`requested_locked` is what was asked for. `previously_locked` is the ' +
  "account's lock state as read immediately before the call. " +
  '`resulting_locked` is the state read back off the response the update ' +
  'itself answered with, which is the updated account. `changed` is true where ' +
  'those two disagree and false where they are the same, WHICH IS TWO OUTCOMES ' +
  'AND NOT ONE: either the account was already in the requested state, or the ' +
  'call did not apply and left it in the other one. `confirmed` is what tells ' +
  'those two apart, and `changed` must not be read without it. ALL THREE OF ' +
  '`previously_locked`, `resulting_locked` AND `changed` ARE NULL WHERE THE ' +
  'STATE BEHIND THEM COULD NOT BE ESTABLISHED, WHICH IS NOT "NOTHING CHANGED", ' +
  'and `changed` is null whenever either of the other two is. `confirmed` is ' +
  'whether `resulting_locked` is what was requested: true is the system ' +
  'reporting back the state that was asked for, FALSE IS NOT A SUCCESS — the ' +
  'call did not reject and the account is not in the requested state — and ' +
  'null is a response that stated no `locked` this tool could read. `lookup` ' +
  'says what the read before the call did: `FOUND`, `NOT_FOUND` (no account ' +
  'with that id was listed — it was deleted between the plan and the ' +
  'confirmation) or `UNREADABLE`, with `lookup_error` naming why; `FOUND` ' +
  'beside a null `previously_locked` is an account that stated no `locked` ' +
  'this tool could read. THE UPDATE IS ATTEMPTED IN ALL THREE CASES, because ' +
  'what runs must be what was approved. `api_key_count` is how many API keys ' +
  'the updated account has, off the same response, and null where that list ' +
  'could not be read: A LOCK HAS NOT BEEN SHOWN TO STOP THEM WORKING, so a ' +
  'non-zero count beside `resulting_locked: true` is access that may well ' +
  'remain. No password hash, generated password or SSH key is returned.';

export const userSetLocked: MutatingTool = {
  name: 'user_set_locked',
  description:
    'Locks or unlocks one local user account on this TrueNAS system, and ' +
    'changes nothing else about it. Two-phase: called without a ' +
    'confirmation_token it returns a plan for user approval; called with one it ' +
    "sends the lock. `id` is the account's `id` as `users_list` reports it — " +
    "the middleware's record id, NOT the `uid`. `locked` is the state to move " +
    'it to, true or false, and is required: there is no toggle. ONLY THE ' +
    '`locked` FIELD IS SENT. ' +
    LOCK_REACH +
    ' Revoking API keys, ending sessions, disabling the password or SSH login ' +
    'and deleting the account are not done by any tool here. THE PLAN FAILS ' +
    '— naming why — for an id `users_list` does not report, compared on the ' +
    'response; for an account that is not local, which is disabled in its ' +
    'directory; for a `builtin` or `immutable` account, naming which; and, when ' +
    'locking, FOR THE ACCOUNT THIS CATALOG IS ITSELF SIGNED IN AS (`auth.me`), ' +
    'since whether a lock ends the session in use is (unconfirmed) and nothing ' +
    'could unlock it afterwards. Where whether the account is builtin, ' +
    'immutable or the catalog\'s own cannot be read, the plan fails rather than ' +
    'guessing. These checks are made when the plan is made and not again. The ' +
    'plan names the account by username and full name, says how many API keys ' +
    'it has, and names every privilege its groups hold — locking the last ' +
    'account holding an administrative privilege is a lockout, and whether ' +
    'another account holds it is not read. LOCKING AN ACCOUNT ALREADY LOCKED, ' +
    'OR UNLOCKING ONE ALREADY UNLOCKED, IS NOT AN ERROR, and the result says ' +
    'which happened. `destructiveness` is `reversible`: the call with `locked` ' +
    'flipped is the inverse. ' +
    USER_SET_LOCKED_GUIDANCE,
  resultGuidance: USER_SET_LOCKED_GUIDANCE,
  inputSchema: {
    type: 'object',
    properties: {
      id: {
        type: 'integer',
        description:
          "The account's `id` as `users_list` reports it, on the system being targeted. " +
          'Not the `uid`.',
      },
      locked: {
        type: 'boolean',
        description: 'The state to move the account to: true locks it, false unlocks it. Required — this is not a toggle.',
      },
    },
    required: ['id', 'locked'],
  },
  requiredRole: Role.Full,
  mutating: true,
  // One boolean on one row, and the call with it flipped puts it back.
  destructiveness: 'reversible',
  normalizeArgs(rawArgs) {
    return { ...parseUserSetLocked(rawArgs) };
  },
  async plan(ctx, rawArgs): Promise<PlanStep[]> {
    const { id, locked } = parseUserSetLocked(rawArgs);
    let rows: unknown;
    try {
      rows = await readAccount(ctx, id);
    } catch (reason) {
      throw new Error(`The account with id ${id} could not be read (user.query failed: ${errorText(reason)}), so nothing is planned`);
    }
    const row = rowWithId(rows, id);
    if (row === null) {
      throw new Error(
        `No user account with id ${id} on this system — \`users_list\` reports each account's ` +
          '`id`, which is the record id and not the `uid`',
      );
    }
    const label = accountText(row, id);
    refuseProtectedAccount(row, label);
    if (locked) await refuseOwnAccount(ctx, row, label);
    const privileges = await privilegeSentence(ctx, row, locked);
    const keys = apiKeyCount(row);
    const keyText =
      keys === null
        ? ' How many API keys it has could not be read.'
        : ` It has ${plural(keys, 'API key')}.`;
    return [
      readStep('user.query', 'user account', id),
      {
        method: 'user.update',
        params: [id, { locked }],
        description:
          `${locked ? 'Lock' : 'Unlock'} local user ${label}. Only the locked flag is sent. ` +
          `${lockSentence(booleanOrNull(row['locked']), locked)}${keyText}` +
          `${locked ? ` ${LOCK_REACH}` : ''}${privileges}`,
      },
    ];
  },
  async execute(ctx, rawArgs) {
    const { id, locked } = parseUserSetLocked(rawArgs);
    // The response is kept for the API keys as well as handed to the shared
    // outcome, so the two are read off the one answer rather than two calls.
    let updated: unknown = null;
    const outcome = await switchOutcome(
      () => readAccount(ctx, id),
      async () => (updated = await firstValueFrom(ctx.system.client.api.call('user.update', [id, { locked }]))),
      id,
      locked,
      'locked',
    );
    return {
      id,
      requested_locked: locked,
      ...outcome,
      api_key_count: apiKeyCount(recordOrNull(updated)),
    };
  },
};
