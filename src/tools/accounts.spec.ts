import { describe, expect, it } from 'vitest';
import { Role } from '@/interfaces';
import { fakeSystem, failingSystem } from '@/testing/fake-systems';
import { directoryServicesStatus, privilegesList, userCreate, usersList } from '@/tools/index';

describe('users_list', () => {
  /**
   * An account as `user.query` reports one. `unixhash`, `smbhash`, `sshpubkey`,
   * `password_history` and `api_keys` are real fields of the payload, and are
   * here to be dropped: this fixture is what makes "no credential material"
   * assertable rather than assumed.
   */
  const user = (over: Record<string, unknown> = {}) => ({
    id: 41,
    uid: 3001,
    username: 'jbarnes',
    full_name: 'Jo Barnes',
    local: true,
    shell: '/usr/bin/bash',
    locked: false,
    group: { id: 101, gid: 3001, name: 'jbarnes' },
    groups: [102],
    unixhash: '$6$rounds=656000$notarealhash',
    smbhash: 'jbarnes:3001:AAD3B435B51404EE:31D6CFE0D16AE931:[U]:LCT-00000000:',
    sshpubkey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI jo@laptop',
    password_history: [{ changed: '2026-01-04' }],
    password_disabled: false,
    twofactor_auth_configured: true,
    sid: 'S-1-5-21-1004336348-1177238915-682003330-1013',
    email: 'jo@example.com',
    home: '/home/jbarnes',
    builtin: false,
    immutable: false,
    api_keys: [4],
    roles: ['READONLY_ADMIN'],
    ...over,
  });

  /** A group as `group.query` reports one. */
  const group = (over: Record<string, unknown> = {}) => ({
    id: 101,
    gid: 3001,
    name: 'jbarnes',
    group: 'jbarnes',
    local: true,
    builtin: false,
    immutable: false,
    sid: null,
    roles: [],
    users: [41],
    ...over,
  });

  type Listing = {
    users: Record<string, unknown>[];
    users_truncated: boolean;
    groups: Record<string, unknown>[] | null;
    groups_truncated: boolean;
    groups_error: string | null;
    limit: number;
  };

  const listed = async (
    rows: Partial<Record<string, unknown>> = {},
    failures: Partial<Record<string, unknown>> = {},
    args: Record<string, unknown> = {},
  ): Promise<Listing> => {
    const { ctx } = failingSystem(
      {
        ['user.query']: [user()],
        ['group.query']: [group(), group({ id: 102, gid: 4001, name: 'engineering' })],
        ...rows,
      },
      failures,
    );
    return (await usersList.handler(ctx, args)) as Listing;
  };

  /** The single account of a listing, for the cases about one's fields. */
  const onlyUser = async (
    rows: Partial<Record<string, unknown>> = {},
    failures: Partial<Record<string, unknown>> = {},
  ): Promise<Record<string, unknown>> => (await listed(rows, failures)).users[0];

  it('reports each account with its identity, its shell and its group membership', async () => {
    expect(await listed()).toEqual({
      users: [
        {
          id: 41,
          username: 'jbarnes',
          uid: 3001,
          full_name: 'Jo Barnes',
          local: true,
          shell: '/usr/bin/bash',
          locked: false,
          primary_group: { id: 101, gid: 3001, name: 'jbarnes' },
          auxiliary_groups: [{ id: 102, gid: 4001, name: 'engineering' }],
        },
      ],
      users_truncated: false,
      groups: [
        { id: 101, gid: 3001, name: 'jbarnes', local: true },
        { id: 102, gid: 4001, name: 'engineering', local: true },
      ],
      groups_truncated: false,
      groups_error: null,
      limit: 100,
    });
  });

  it('returns no credential material, and no field a later release adds', async () => {
    const listing = await listed({
      ['user.query']: [user({ future_field: 'added by a later release' })],
      ['group.query']: [group({ future_field: 'added by a later release' })],
    });
    expect(Object.keys(listing)).toEqual([
      'users',
      'users_truncated',
      'groups',
      'groups_truncated',
      'groups_error',
      'limit',
    ]);
    expect(Object.keys(listing.users[0])).toEqual([
      'id',
      'username',
      'uid',
      'full_name',
      'local',
      'shell',
      'locked',
      'primary_group',
      'auxiliary_groups',
    ]);
    expect(Object.keys((listing.groups ?? [])[0])).toEqual(['id', 'gid', 'name', 'local']);
    // Asserted against the whole serialized result rather than field by field:
    // a credential that reached a nested object would pass a key check on the
    // account and still be in front of the caller.
    const serialized = JSON.stringify(listing);
    for (const secret of [
      'notarealhash',
      '31D6CFE0D16AE931',
      'ssh-ed25519',
      'password_history',
      'api_keys',
      'twofactor',
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it('distinguishes a directory account from a local one', async () => {
    const listing = await listed({
      ['user.query']: [
        user(),
        user({ id: 42, uid: 11002, username: 'AD\\rlee', full_name: 'R Lee', local: false }),
      ],
    });
    expect(listing.users.map((one) => [one['username'], one['local']])).toEqual([
      ['jbarnes', true],
      ['AD\\rlee', false],
    ]);
  });

  it('reports an unset full name, shell or lock state as null rather than as a value', async () => {
    // A directory account is the case that carries none of the three: the
    // middleware sends `""` for a name it does not have and omits the rest.
    const bare = user({ full_name: '', shell: undefined, locked: undefined });
    expect(await onlyUser({ ['user.query']: [bare] })).toMatchObject({
      full_name: null,
      shell: null,
      locked: null,
    });
  });

  it('reports an account in no group beyond its primary one as an empty list', async () => {
    expect(await onlyUser({ ['user.query']: [user({ groups: [] })] })).toMatchObject({
      auxiliary_groups: [],
    });
  });

  it('reports an account whose membership the system did not send as null', async () => {
    // Null rather than the empty list, which would say the account belongs to
    // nothing when what is true is that nothing was said about it.
    expect(await onlyUser({ ['user.query']: [user({ groups: undefined })] })).toMatchObject({
      auxiliary_groups: null,
    });
  });

  it('keeps a membership naming a group the listing does not hold', async () => {
    // Reported with a null gid and name rather than dropped: a dropped id
    // leaves a shorter list behind that says the account is not in the group.
    expect(await onlyUser({ ['user.query']: [user({ groups: [102, 999] })] })).toMatchObject({
      auxiliary_groups: [
        { id: 102, gid: 4001, name: 'engineering' },
        { id: 999, gid: null, name: null },
      ],
    });
  });

  it('reads the primary group from the listing, and falls back to the embedded record', async () => {
    const listing = await listed({
      ['user.query']: [
        // Its embedded record disagrees with the listing about the name; the
        // listing is the typed source and the one memberships resolve against.
        user({ group: { id: 101, gid: 9, name: 'stale' } }),
        // Not in the listing at all, so the embedded record is all there is.
        user({ id: 42, username: 'svc', group: { id: 500, gid: 500, name: 'svc' } }),
        // An embedded record naming nothing readable.
        user({ id: 43, username: 'broken', group: {} }),
      ],
    });
    expect(listing.users.map((one) => one['primary_group'])).toEqual([
      { id: 101, gid: 3001, name: 'jbarnes' },
      { id: 500, gid: 500, name: 'svc' },
      { id: null, gid: null, name: null },
    ]);
  });

  it('reports the groups that could not be read as null, with the reason', async () => {
    const listing = await listed({}, { ['group.query']: new Error('group.query: access denied') });
    expect(listing.groups).toBeNull();
    expect(listing.groups_error).toBe('group.query: access denied');
    // The accounts still list, still identified, and the primary group still
    // reports from the record embedded in the account itself.
    expect(listing.users[0]).toMatchObject({
      username: 'jbarnes',
      primary_group: { id: 101, gid: 3001, name: 'jbarnes' },
      // Unresolvable, and kept as the id the account named.
      auxiliary_groups: [{ id: 102, gid: null, name: null }],
    });
  });

  it('names a failure however the client rejected', async () => {
    const reasons: [unknown, string][] = [
      [{ reason: 'group.query failed' }, 'group.query failed'],
      [{ message: 'connection reset' }, 'connection reset'],
      ['ENOTCONN', 'ENOTCONN'],
      [new Error(''), 'the system reported no reason'],
      [{ code: 42 }, 'the system reported no reason'],
      [null, 'the system reported no reason'],
    ];
    for (const [reason, expected] of reasons) {
      expect((await listed({}, { ['group.query']: reason })).groups_error).toBe(expected);
    }
  });

  it('reports a group whose name the system did not send as null', async () => {
    const listing = await listed({
      ['user.query']: [user({ groups: [101] })],
      ['group.query']: [group({ name: '' })],
    });
    expect(listing.groups).toEqual([{ id: 101, gid: 3001, name: null, local: true }]);
    expect(listing.users[0]).toMatchObject({
      // A group that is listed and has no name to give: a null name beside a
      // gid that is there, which is not the pair of nulls of an id answering to
      // no group at all.
      auxiliary_groups: [{ id: 101, gid: 3001, name: null }],
      // The primary group is the one the account record carries whole, so it
      // still has a name to fall back to where the listing has none.
      primary_group: { id: 101, gid: 3001, name: 'jbarnes' },
    });
  });

  it('reports a system with no accounts and no groups as empty lists', async () => {
    expect(await listed({ ['user.query']: [], ['group.query']: [] })).toEqual({
      users: [],
      users_truncated: false,
      groups: [],
      groups_truncated: false,
      groups_error: null,
      limit: 100,
    });
  });

  it('bounds both lists, and says which of them the system held more of', async () => {
    const listing = await listed(
      {
        // Three of each against a bound of two: the third row is what says the
        // system held more than fit, and it is dropped rather than reported.
        ['user.query']: [user(), user({ id: 42, username: 'b' }), user({ id: 43, username: 'c' })],
        ['group.query']: [group(), group({ id: 102, name: 'b' }), group({ id: 103, name: 'c' })],
      },
      {},
      { limit: 2 },
    );
    expect(listing.users.map((one) => one['username'])).toEqual(['jbarnes', 'b']);
    expect((listing.groups ?? []).map((one) => one['name'])).toEqual(['jbarnes', 'b']);
    expect(listing).toMatchObject({ users_truncated: true, groups_truncated: true, limit: 2 });
  });

  it('reports one list as truncated without the other', async () => {
    const listing = await listed(
      { ['user.query']: [user(), user({ id: 42, username: 'b' })], ['group.query']: [group()] },
      {},
      { limit: 1 },
    );
    expect(listing).toMatchObject({ users_truncated: true, groups_truncated: false });
  });

  it('asks the system for one row past the bound, on both reads', async () => {
    const { ctx, query } = failingSystem({ ['user.query']: [user()], ['group.query']: [group()] });
    await usersList.handler(ctx, { limit: 5 });
    expect(query.mock.calls).toEqual([
      ['user.query', [], { limit: 6 }],
      ['group.query', [], { limit: 6 }],
    ]);
  });

  it('applies a usable bound whatever the caller asked for', async () => {
    const applied = async (limit: unknown): Promise<number> =>
      (await listed({}, {}, { limit })).limit;
    expect(await applied(undefined)).toBe(100);
    expect(await applied('lots')).toBe(100);
    expect(await applied(Number.NaN)).toBe(100);
    // Rounded down: a fractional limit reaches the middleware as one.
    expect(await applied(2.7)).toBe(2);
    // Floored at 1 rather than returning nothing while reporting more.
    expect(await applied(0)).toBe(1);
    expect(await applied(-5)).toBe(1);
    expect(await applied(9000)).toBe(1000);
  });

  it('reports the groups as not truncated when they could not be read at all', async () => {
    // Nothing was read, so nothing was left out of a list either.
    const listing = await listed({}, { ['group.query']: new Error('denied') });
    expect(listing).toMatchObject({ groups: null, groups_truncated: false });
  });

  it('raises when the accounts themselves cannot be read', async () => {
    // The groups alone answer none of the question, so this one is fatal where
    // the group read is reported.
    await expect(listed({}, { ['user.query']: new Error('nope') })).rejects.toThrow('nope');
  });

  it('issues both reads before awaiting either of them', async () => {
    const { ctx, query } = failingSystem({
      ['user.query']: [user()],
      ['group.query']: [group()],
    });
    const listing = usersList.handler(ctx, {});
    // Asserted before the handler is awaited at all, which is what makes this
    // about concurrency rather than order.
    expect(query.mock.calls.map((one) => one[0])).toEqual(['user.query', 'group.query']);
    await listing;
  });
});

describe('directory_services_status', () => {
  /** The live join state, as `directoryservices.status` reports it. */
  const status = (over: Record<string, unknown> = {}) => ({
    type: 'ACTIVEDIRECTORY',
    status: 'HEALTHY',
    status_msg: null,
    ...over,
  });

  /**
   * The configuration, as `directoryservices.config` reports it. `credential`
   * carries a real password field, and is here to be dropped: this fixture is
   * what makes "no credential material" assertable rather than assumed.
   */
  const config = (over: Record<string, unknown> = {}) => ({
    id: 1,
    service_type: 'ACTIVEDIRECTORY',
    credential: {
      credential_type: 'KERBEROS_USER',
      username: 'administrator',
      password: 'notarealbindsecret',
    },
    enable: true,
    enable_account_cache: true,
    enable_dns_updates: false,
    timeout: 10,
    kerberos_realm: 'EXAMPLE.COM',
    configuration: {
      hostname: 'nas',
      domain: 'example.com',
      site: null,
      computer_account_ou: null,
      use_default_domain: false,
      enable_trusted_domains: false,
      trusted_domains: [],
    },
    ...over,
  });

  const reported = async (
    rows: Partial<Record<string, unknown>> = {},
    failures: Partial<Record<string, unknown>> = {},
  ): Promise<Record<string, unknown>> => {
    const { ctx } = failingSystem(
      {
        ['directoryservices.status']: status(),
        ['directoryservices.config']: config(),
        ...rows,
      },
      failures,
    );
    return (await directoryServicesStatus.handler(ctx, {})) as Record<string, unknown>;
  };

  it('reports the service, its domain and its live state', async () => {
    expect(await reported()).toEqual({
      service_type: 'ACTIVEDIRECTORY',
      status: 'HEALTHY',
      status_message: null,
      enabled: true,
      domain: 'example.com',
      server_urls: null,
      kerberos_realm: 'EXAMPLE.COM',
      credential_type: 'KERBEROS_USER',
      config_error: null,
    });
  });

  it('returns no credential material, and no field a later release adds', async () => {
    const result = await reported({
      ['directoryservices.status']: status({ future_field: 'added by a later release' }),
      ['directoryservices.config']: config({ future_field: 'added by a later release' }),
    });
    expect(Object.keys(result)).toEqual([
      'service_type',
      'status',
      'status_message',
      'enabled',
      'domain',
      'server_urls',
      'kerberos_realm',
      'credential_type',
      'config_error',
    ]);
    // Asserted against the whole serialized result rather than field by field:
    // a secret that reached a nested object would pass a key check on the top
    // level and still be in front of the caller.
    const serialized = JSON.stringify(result);
    for (const secret of ['notarealbindsecret', 'administrator', 'added by a later release']) {
      expect(serialized).not.toContain(secret);
    }
  });

  it('reports a system with no directory service as a null service type', async () => {
    // The ordinary case, and not a failure: everything the configuration would
    // have contributed is absent rather than unreadable, so `config_error` is
    // null too.
    expect(
      await reported({
        ['directoryservices.status']: status({ type: null, status: 'DISABLED' }),
        ['directoryservices.config']: config({
          service_type: null,
          credential: null,
          enable: false,
          kerberos_realm: null,
          configuration: null,
        }),
      }),
    ).toEqual({
      service_type: null,
      status: 'DISABLED',
      status_message: null,
      enabled: false,
      domain: null,
      server_urls: null,
      kerberos_realm: null,
      credential_type: null,
      config_error: null,
    });
  });

  it('distinguishes a broken join from an unconfigured system without prose', async () => {
    const faulted = await reported({
      ['directoryservices.status']: status({
        status: 'FAULTED',
        status_msg: 'kinit failed: Clock skew too great',
      }),
    });
    expect(faulted).toMatchObject({
      service_type: 'ACTIVEDIRECTORY',
      status: 'FAULTED',
      status_message: 'kinit failed: Clock skew too great',
    });
    const absent = await reported({
      ['directoryservices.status']: status({ type: null, status: 'DISABLED' }),
    });
    expect(absent).toMatchObject({ service_type: null, status: 'DISABLED' });
  });

  it('identifies an LDAP directory by its server URLs, having no domain', async () => {
    const ldap = await reported({
      ['directoryservices.status']: status({ type: 'LDAP' }),
      ['directoryservices.config']: config({
        service_type: 'LDAP',
        kerberos_realm: null,
        credential: {
          credential_type: 'LDAP_PLAIN',
          binddn: 'cn=nas,dc=example,dc=com',
          bindpw: 'notarealbindpw',
        },
        configuration: {
          server_urls: ['ldaps://ldap1.example.com', 'ldaps://ldap2.example.com'],
          basedn: 'dc=example,dc=com',
          starttls: false,
          validate_certificates: true,
        },
      }),
    });
    expect(ldap).toMatchObject({
      service_type: 'LDAP',
      // Null because an LDAP directory has no domain, not because one was
      // configured and could not be read — `config_error` is what says that.
      domain: null,
      server_urls: ['ldaps://ldap1.example.com', 'ldaps://ldap2.example.com'],
      kerberos_realm: null,
      credential_type: 'LDAP_PLAIN',
      config_error: null,
    });
    expect(JSON.stringify(ldap)).not.toContain('notarealbindpw');
  });

  it('reports an IPA domain, and no server URLs beside it', async () => {
    expect(
      await reported({
        ['directoryservices.status']: status({ type: 'IPA' }),
        ['directoryservices.config']: config({
          service_type: 'IPA',
          configuration: {
            target_server: 'ipa.example.com',
            hostname: 'nas',
            domain: 'ipa.example.com',
            basedn: 'dc=ipa,dc=example,dc=com',
          },
        }),
      }),
    ).toMatchObject({ service_type: 'IPA', domain: 'ipa.example.com', server_urls: null });
  });

  it('reports a state the system did not send as null rather than as healthy', async () => {
    expect(
      await reported({ ['directoryservices.status']: status({ status: undefined }) }),
    ).toMatchObject({ status: null, status_message: null });
  });

  it('reports an unset message or realm as null rather than as a value', async () => {
    // The middleware sends `""` for text it does not have; passing that through
    // would put a field in the result that says nothing.
    expect(
      await reported({
        ['directoryservices.status']: status({ status_msg: '' }),
        ['directoryservices.config']: config({ kerberos_realm: '' }),
      }),
    ).toMatchObject({ status_message: null, kerberos_realm: null });
  });

  it('names the failure when the configuration cannot be read, and reports the state anyway', async () => {
    // The join state is the question, and it comes from the other read — so a
    // configuration that could not be read costs the domain and nothing else.
    expect(
      await reported({}, { ['directoryservices.config']: new Error('permission denied') }),
    ).toEqual({
      service_type: 'ACTIVEDIRECTORY',
      status: 'HEALTHY',
      status_message: null,
      enabled: null,
      domain: null,
      server_urls: null,
      kerberos_realm: null,
      credential_type: null,
      config_error: 'permission denied',
    });
  });

  it('raises when the join state itself cannot be read', async () => {
    // The configuration alone answers none of the question, so this one is
    // fatal where the configuration read is reported.
    await expect(
      reported({}, { ['directoryservices.status']: new Error('nope') }),
    ).rejects.toThrow('nope');
  });

  it('issues both reads before awaiting either of them', async () => {
    const { ctx, call } = failingSystem({
      ['directoryservices.status']: status(),
      ['directoryservices.config']: config(),
    });
    const pending = directoryServicesStatus.handler(ctx, {});
    // Asserted before the handler is awaited at all, which is what makes this
    // about concurrency rather than order.
    expect(call.mock.calls.map((one) => one[0])).toEqual([
      'directoryservices.status',
      'directoryservices.config',
    ]);
    await pending;
  });
});

describe('privileges_list', () => {
  /**
   * A group as a privilege embeds one. `roles`, `users`, `sudo_commands` and
   * `sudo_commands_nopasswd` are real fields of the payload and are here to be
   * dropped: this fixture is what makes the allowlist assertable rather than
   * assumed. The group's own `roles` matter most — they are a different fact
   * from the privilege's, and forwarding them would put two role lists in one
   * result.
   */
  const group = (over: Record<string, unknown> = {}) => ({
    id: 101,
    gid: 3001,
    name: 'admins',
    group: 'admins',
    local: true,
    builtin: false,
    sid: 'S-1-5-21-1004336348-1177238915-682003330-1013',
    immutable: false,
    smb: true,
    roles: ['SHARING_ADMIN'],
    users: [41],
    sudo_commands: ['/usr/bin/systemctl'],
    sudo_commands_nopasswd: [],
    ...over,
  });

  /** A group the system could not resolve, as `privilege.query` reports one. */
  const unmapped = (over: Record<string, unknown> = {}) => ({
    gid: 5000,
    sid: null,
    group: null,
    ...over,
  });

  /** A privilege as `privilege.query` reports one. */
  const privilege = (over: Record<string, unknown> = {}) => ({
    id: 1,
    builtin_name: 'FULL_ADMIN',
    name: 'Full Admin',
    local_groups: [group()],
    ds_groups: [],
    roles: ['FULL_ADMIN'],
    web_shell: true,
    ...over,
  });

  /**
   * A fixture with one key taken away, which an override cannot do: the
   * overrides above merge onto the fixture, so a field can only be made absent
   * by building the row without it. Absence is a distinct answer from null for
   * both fields this is used on.
   */
  const without = (record: Record<string, unknown>, key: string): Record<string, unknown> => {
    const copy = { ...record };
    delete copy[key];
    return copy;
  };

  type Listing = { privileges: Record<string, unknown>[] };

  const listed = async (
    rows: Partial<Record<string, unknown>> = {},
    failures: Partial<Record<string, unknown>> = {},
  ): Promise<Listing> => {
    const { ctx } = failingSystem({ ['privilege.query']: [privilege()], ...rows }, failures);
    return (await privilegesList.handler(ctx, {})) as Listing;
  };

  /** The single privilege of a listing, for the cases about one's fields. */
  const only = async (over: Record<string, unknown> = {}): Promise<Record<string, unknown>> =>
    (await listed({ ['privilege.query']: [privilege(over)] })).privileges[0];

  it('reports each privilege with its roles, its shell access and its groups', async () => {
    expect(await listed()).toEqual({
      privileges: [
        {
          id: 1,
          name: 'Full Admin',
          builtin_name: 'FULL_ADMIN',
          operator_defined: false,
          web_shell: true,
          roles_reported: true,
          roles: ['FULL_ADMIN'],
          local_groups: [
            {
              kind: 'RESOLVED',
              group: {
                id: 101,
                gid: 3001,
                name: 'admins',
                local: true,
                builtin: false,
                sid: 'S-1-5-21-1004336348-1177238915-682003330-1013',
              },
              unmapped: null,
            },
          ],
          ds_groups: [],
        },
      ],
    });
  });

  it('returns no field of an embedded group record beyond the ones it names', async () => {
    const held = (await only())['local_groups'] as { group: Record<string, unknown> }[];
    // Asserted as the exact key set rather than field by field: what this is
    // about is the fields nobody chose, which a per-field check cannot see.
    expect(Object.keys(held[0].group).sort()).toEqual([
      'builtin',
      'gid',
      'id',
      'local',
      'name',
      'sid',
    ]);
    // The group's own roles are a different fact from the privilege's, and the
    // fixture carries both so that this says something.
    expect(JSON.stringify(await only())).not.toContain('SHARING_ADMIN');
    expect(JSON.stringify(await only())).not.toContain('systemctl');
  });

  it('reads a privilege the system named no stock name for as operator-defined', async () => {
    expect(await only({ builtin_name: null })).toMatchObject({
      builtin_name: null,
      operator_defined: true,
    });
  });

  it('refuses to call a stock name it could not read an operator-defined privilege', async () => {
    // Null for both causes would read as "somebody created this", which is a
    // claim on a field that arrived as something unreadable rather than as null.
    expect(await only({ builtin_name: 7 })).toMatchObject({
      builtin_name: null,
      operator_defined: null,
    });
    expect(await only({ builtin_name: '' })).toMatchObject({
      builtin_name: null,
      operator_defined: null,
    });
  });

  it('reports shell access the system said nothing about as null, never as false', async () => {
    expect(await only({ web_shell: 'yes' })).toMatchObject({ web_shell: null });
    expect(await only({ web_shell: false })).toMatchObject({ web_shell: false });
  });

  it('tells a version that reports no roles from a privilege that confers none', async () => {
    const listing = await listed({ ['privilege.query']: [without(privilege(), 'roles')] });
    expect(listing.privileges[0]).toMatchObject({ roles_reported: false, roles: null });
    expect(await only({ roles: [] })).toMatchObject({ roles_reported: true, roles: [] });
  });

  it('nulls the whole role list where any one name could not be read', async () => {
    // Dropping the unreadable entry would say the group holds less authority
    // than it does, which is the claim this refuses to make.
    expect(await only({ roles: ['FULL_ADMIN', 3] })).toMatchObject({
      roles_reported: true,
      roles: null,
    });
    expect(await only({ roles: 'FULL_ADMIN' })).toMatchObject({
      roles_reported: true,
      roles: null,
    });
  });

  it('reports a group the system could not resolve, with what the privilege named', async () => {
    expect(await only({ local_groups: [unmapped()], ds_groups: [unmapped({ sid: 'S-1-5-32' })] }))
      .toMatchObject({
        local_groups: [{ kind: 'UNMAPPED', group: null, unmapped: { gid: 5000, sid: null } }],
        ds_groups: [{ kind: 'UNMAPPED', group: null, unmapped: { gid: 5000, sid: 'S-1-5-32' } }],
      });
  });

  it('keeps an entry it could not read at all, rather than shortening the list', async () => {
    // A list one entry shorter understates who holds the privilege, so the
    // entry stays and says what it is.
    expect(await only({ local_groups: [group(), 'admins', null] })).toMatchObject({
      local_groups: [
        { kind: 'RESOLVED' },
        { kind: 'UNREADABLE', group: null, unmapped: null },
        { kind: 'UNREADABLE', group: null, unmapped: null },
      ],
    });
  });

  it('reads a record carrying no group alias as a group that resolved', async () => {
    // `group` is a legacy alias for the name, and only an explicit null means
    // the unmapped arm — a record without the field at all is an ordinary group.
    expect(await only({ local_groups: [without(group(), 'group')] })).toMatchObject({
      local_groups: [{ kind: 'RESOLVED', group: { id: 101, name: 'admins' } }],
    });
  });

  it('reports each unreadable field of a group that resolved as null', async () => {
    expect(
      await only({ local_groups: [group({ gid: 'x', name: '', local: 1, builtin: null, sid: '' })] }),
    ).toMatchObject({
      local_groups: [
        {
          kind: 'RESOLVED',
          group: { id: 101, gid: null, name: null, local: null, builtin: null, sid: null },
        },
      ],
    });
  });

  it('tells a group list the system did not report from a privilege granted to none', async () => {
    expect(await only({ local_groups: null, ds_groups: [] })).toMatchObject({
      local_groups: null,
      ds_groups: [],
    });
  });

  it('reports an unreadable id or name as null', async () => {
    expect(await only({ id: null, name: '' })).toMatchObject({ id: null, name: null });
  });

  it('reports a system with no privileges as an empty list', async () => {
    expect(await listed({ ['privilege.query']: [] })).toEqual({ privileges: [] });
  });

  it('reads the privileges unbounded, because an operator wrote them', async () => {
    const { ctx, query } = failingSystem({ ['privilege.query']: [privilege()] });
    await privilegesList.handler(ctx, {});
    expect(query.mock.calls).toEqual([['privilege.query']]);
  });

  it('raises when the privileges cannot be read', async () => {
    // The one read answers the whole question, so there is nothing to report a
    // failure beside.
    await expect(listed({}, { ['privilege.query']: new Error('denied') })).rejects.toThrow(
      'denied',
    );
  });
});

describe('user_create', () => {
  /** Every group as `group.query` lists it; the fake ignores the filter, as a dropped one would. */
  const groups = [
    { id: 12, gid: 3001, name: 'projects', local: true, sudo_commands: [], sudo_commands_nopasswd: [] },
    { id: 13, gid: 3002, name: 'staff', local: true },
    { id: 1, gid: 544, name: 'builtin_administrators', local: true },
    { id: 90, gid: 1500000, name: 'domain users', local: false },
    { id: 14, gid: 3003, name: 'wheelish', local: true, sudo_commands: ['ALL'] },
  ];

  /** One privilege, granted to `builtin_administrators` by gid. */
  const privileges = [
    { id: 1, name: 'Local Administrator', local_groups: [{ id: 1, gid: 544, name: 'builtin_administrators' }], ds_groups: [] },
  ];

  /**
   * What `user.create` answers with. `unixhash`, `smbhash`, `password` and
   * `sshpubkey` are real fields of the response and are here to be dropped.
   */
  const created = {
    id: 41,
    uid: 3010,
    username: 'contractor',
    full_name: 'New Contractor',
    email: null,
    group: { id: 12, gid: 3001, name: 'projects' },
    groups: [13],
    home: '/var/empty',
    shell: '/usr/bin/zsh',
    password_disabled: true,
    smb: false,
    locked: false,
    unixhash: '$6$salt$hash',
    smbhash: 'ABCDEF0123456789',
    password: 'generated-secret',
    sshpubkey: 'ssh-ed25519 AAAA key',
    password_history: ['old'],
  };

  const system = (overrides: Partial<Record<string, unknown>> = {}) =>
    fakeSystem({
      'group.query': groups,
      'privilege.query': privileges,
      'user.query': [{ id: 5, uid: 3000, username: 'someoneelse' }],
      'user.create': created,
      ...overrides,
    });

  const args = { username: 'contractor', full_name: 'New Contractor', group: 'projects', groups: ['staff'] };

  it('is a reversible mutating tool needing full access', () => {
    expect(userCreate).toMatchObject({
      name: 'user_create',
      mutating: true,
      destructiveness: 'reversible',
      requiredRole: Role.Full,
    });
  });

  it('has no password, sudo, uid or group_create argument in its schema', () => {
    const schema = userCreate.inputSchema as { properties: Record<string, unknown>; required: string[] };
    for (const key of [
      'password',
      'random_password',
      'sudo_commands',
      'sudo_commands_nopasswd',
      'uid',
      'group_create',
      'password_disabled',
    ]) {
      expect(Object.keys(schema.properties)).not.toContain(key);
    }
    expect(schema.required).toEqual(['username', 'full_name', 'group']);
  });

  it('names privileges_list as where the privileged-group boundary is read', () => {
    expect(userCreate.description).toContain('A GROUP THAT HOLDS A PRIVILEGE IS REFUSED');
    expect(userCreate.description).toContain('`privileges_list`');
    expect(userCreate.description).toContain('NO TOOL IN THIS CATALOG DELETES OR DISABLES A USER');
  });

  describe('argument validation', () => {
    const reject = (bad: Record<string, unknown>, message: RegExp) =>
      expect(() => userCreate.normalizeArgs?.(bad)).toThrow(message);

    it('refuses every password route by name rather than dropping it', () => {
      for (const key of ['password', 'random_password', 'password_disabled', 'ssh_password_enabled']) {
        reject({ ...args, [key]: key === 'password' ? 'hunter2' : false }, new RegExp(`"${key}" is not accepted by this tool: the account is always created with password login disabled`));
      }
    });

    it('refuses sudo, uid, idmap, group creation, home mode and lock by name', () => {
      for (const key of ['sudo_commands', 'sudo_commands_nopasswd', 'uid', 'userns_idmap', 'group_create', 'home_mode', 'locked']) {
        reject({ ...args, [key]: 1 }, new RegExp(`"${key}" is not accepted by this tool: out of this tool's scope`));
      }
    });

    it('refuses smb true, and normalizes an explicit false away', () => {
      reject({ ...args, smb: true }, /"smb" may only be false: SMB authenticates with a password hash/);
      reject({ ...args, smb: 'false' }, /"smb" must be a boolean/);
      expect(userCreate.normalizeArgs?.({ ...args, smb: false })).toEqual(userCreate.normalizeArgs?.(args));
    });

    it('requires username, full_name and group as non-empty strings', () => {
      reject({ full_name: 'x', group: 'projects' }, /"username" is required/);
      reject({ username: 'x', group: 'projects' }, /"full_name" is required/);
      reject({ username: 'x', full_name: 'x' }, /"group" is required/);
      reject({ ...args, username: '' }, /"username" must be a non-empty string/);
      reject({ ...args, group: 3 }, /"group" must be a non-empty string/);
    });

    it('takes groups as a list of names, each once, and not the primary group again', () => {
      reject({ ...args, groups: 'staff' }, /"groups" must be a list of group names/);
      reject({ ...args, groups: ['staff', ''] }, /"groups" must be a list of group names/);
      reject({ ...args, groups: ['staff', 'staff'] }, /"groups" names "staff" more than once/);
      reject({ ...args, groups: ['projects'] }, /"projects" is named as the primary group and again in "groups"/);
    });

    it('takes home as an absolute path, and home_create only beside it', () => {
      reject({ ...args, home: 'homes' }, /"home" must be an absolute path/);
      reject({ ...args, home_create: true }, /"home_create" needs "home"/);
      reject({ ...args, home: '/mnt/tank/homes', home_create: 'yes' }, /"home_create" must be a boolean/);
      expect(userCreate.normalizeArgs?.({ ...args, home: '/mnt/tank/homes', home_create: false })).not.toHaveProperty(
        'home_create',
      );
    });

    it('normalizes to the arguments it takes, in one order, dropping unknown keys', () => {
      expect(
        userCreate.normalizeArgs?.({ groups: ['staff'], group: 'projects', full_name: 'New Contractor', username: 'contractor', systems: 'all' }),
      ).toEqual({ username: 'contractor', full_name: 'New Contractor', group: 'projects', groups: ['staff'] });
    });

    it('executes nothing when an argument is unreadable', async () => {
      const { ctx, query, call } = system();
      await expect(userCreate.execute(ctx, { ...args, password: 'x' })).rejects.toThrow(/"password"/);
      expect(query).not.toHaveBeenCalled();
      expect(call).not.toHaveBeenCalled();
    });
  });

  describe('the plan it returns', () => {
    it('is the group lookup, the privilege read and the create, sending ids and a disabled password', async () => {
      const { ctx, query } = system();
      const steps = await userCreate.plan(ctx, args);
      expect(steps.map((step) => step.method)).toEqual(['group.query', 'privilege.query', 'user.create']);
      expect(steps[2].params).toEqual([
        {
          username: 'contractor',
          full_name: 'New Contractor',
          group: 12,
          groups: [13],
          group_create: false,
          password_disabled: true,
          smb: false,
        },
      ]);
      // The filter is written twice, once in the read and once in the step;
      // this assertion is what keeps the two in step.
      expect(query).toHaveBeenCalledWith('group.query', (steps[0].params as unknown[])[0]);
      expect(steps[0].params).toEqual([[['name', 'in', ['projects', 'staff']]], {}]);
      expect(steps[0].description).toContain('"projects" (id 12, gid 3001), "staff" (id 13, gid 3002) when this plan was made');
    });

    it('resolves groups on the response, by name, not on the first row', async () => {
      const [, , step] = await userCreate.plan(system().ctx, { ...args, group: 'staff', groups: [] });
      expect((step.params as Array<{ group: number }>)[0].group).toBe(13);
      expect(step.description).toContain('primary group "staff" (id 13, gid 3002) and in no other group');
    });

    it('fails on an unknown group, naming it', async () => {
      await expect(userCreate.plan(system().ctx, { ...args, groups: ['nosuch'] })).rejects.toThrow(
        /No group named "nosuch" on this system/,
      );
    });

    it('fails on a directory group, a group granting sudo, and an ambiguous or unreadable one', async () => {
      await expect(userCreate.plan(system().ctx, { ...args, groups: ['domain users'] })).rejects.toThrow(
        /Group "domain users" is not reported as a local group/,
      );
      await expect(userCreate.plan(system().ctx, { ...args, groups: ['wheelish'] })).rejects.toThrow(
        /Group "wheelish" grants sudo commands \(sudo_commands\)/,
      );
      await expect(
        userCreate.plan(system({ 'group.query': [...groups, { id: 15, gid: 3004, name: 'staff', local: true }] }).ctx, args),
      ).rejects.toThrow(/2 groups are named "staff"/);
      await expect(
        userCreate.plan(system({ 'group.query': [{ name: 'projects', local: true }, groups[1]] }).ctx, args),
      ).rejects.toThrow(/Group "projects" is listed with no id or gid/);
      await expect(
        userCreate.plan(system({ 'group.query': [{ ...groups[0], sudo_commands_nopasswd: [3] }, groups[1]] }).ctx, args),
      ).rejects.toThrow(/Group "projects"'s sudo_commands_nopasswd could not be read/);
    });

    it('fails when the groups could not be read at all', async () => {
      const failing = failingSystem({ 'privilege.query': privileges }, { 'group.query': { reason: 'denied' } });
      await expect(userCreate.plan(failing.ctx, args)).rejects.toThrow(
        'The groups named could not be read (group.query failed: denied)',
      );
      await expect(userCreate.plan(system({ 'group.query': {} }).ctx, args)).rejects.toThrow(
        /group.query did not answer with a list/,
      );
    });

    it('refuses a group that holds a privilege, naming the group and the privilege', async () => {
      await expect(
        userCreate.plan(system().ctx, { ...args, groups: ['builtin_administrators'] }),
      ).rejects.toThrow(
        /Group "builtin_administrators" holds privilege "Local Administrator".*`privileges_list` reports which groups hold which roles/,
      );
      // Matched on the id where the gid is not readable.
      const byId = [{ id: 2, name: 'Ops', local_groups: [{ id: 13 }], ds_groups: [] }];
      await expect(userCreate.plan(system({ 'privilege.query': byId }).ctx, args)).rejects.toThrow(
        /Group "staff" holds privilege "Ops"/,
      );
    });

    it('refuses where any privilege could not be ruled out', async () => {
      const failing = failingSystem({ 'group.query': groups }, { 'privilege.query': new Error('timeout') });
      await expect(userCreate.plan(failing.ctx, args)).rejects.toThrow(
        /Which groups hold a privilege could not be read \(privilege.query failed: timeout\)/,
      );
      await expect(userCreate.plan(system({ 'privilege.query': 'x' }).ctx, args)).rejects.toThrow(
        /privilege.query did not answer with a list/,
      );
      await expect(
        userCreate.plan(system({ 'privilege.query': [{ id: 3, name: 'Odd', local_groups: 'x' }] }).ctx, args),
      ).rejects.toThrow(/Privilege "Odd" could not be read as granting to any list of local groups/);
      await expect(userCreate.plan(system({ 'privilege.query': ['junk'] }).ctx, args)).rejects.toThrow(
        /Privilege "with id unread" could not be read/,
      );
      await expect(
        userCreate.plan(system({ 'privilege.query': [{ id: 4, name: 'Blank', local_groups: [{ name: 'x' }] }] }).ctx, args),
      ).rejects.toThrow(/Privilege "Blank" names a local group this tool could not read/);
    });

    it('fails on a username an existing account has, naming it', async () => {
      await expect(
        userCreate.plan(system({ 'user.query': [{ id: 7, uid: 3005, username: 'contractor' }] }).ctx, args),
      ).rejects.toThrow('An account named "contractor" already exists on this system (id 7, uid 3005)');
      const [, , step] = await userCreate.plan(system().ctx, args);
      expect(step.description).toContain('No account named "contractor" exists on this system now.');
    });

    it('states rather than fails when the existing accounts could not be read', async () => {
      const failing = failingSystem(
        { 'group.query': groups, 'privilege.query': privileges },
        { 'user.query': new Error('busy') },
      );
      const [, , step] = await userCreate.plan(failing.ctx, args);
      expect(step.description).toContain(
        'Whether an account named "contractor" already exists could not be read (user.query failed: busy).',
      );
      const [, , notList] = await userCreate.plan(system({ 'user.query': 1 }).ctx, args);
      expect(notList.description).toContain('(user.query did not answer with a list)');
    });

    it('says nobody can log in without a key, and how one can with a key', async () => {
      const [, , bare] = await userCreate.plan(system().ctx, args);
      expect(bare.description).toContain('NO PASSWORD AND NO SSH KEY, so NOBODY CAN LOG IN TO IT');
      expect(bare.description).toContain('That is the ordinary outcome of this tool, not a failure.');
      const [, , keyed] = await userCreate.plan(system().ctx, { ...args, sshpubkey: 'ssh-ed25519 AAAA key' });
      expect(keyed.description).toContain('It can log in over SSH with the public key given');
      expect((keyed.params as Array<Record<string, unknown>>)[0]['sshpubkey']).toBe('ssh-ed25519 AAAA key');
    });

    it('names the home directory it creates, and what it leaves to the system', async () => {
      const [, , step] = await userCreate.plan(system().ctx, args);
      expect(step.description).toContain("left to the system's defaults, which are not read here: email, home, shell.");
      const [, , made] = await userCreate.plan(system().ctx, {
        ...args,
        email: 'c@example.com',
        home: '/mnt/tank/homes',
        home_create: true,
        shell: '/usr/bin/bash',
      });
      expect(made.description).toContain('A home directory for the account is CREATED in "/mnt/tank/homes"');
      expect(made.description).toContain('(unconfirmed)');
      expect(made.description).not.toContain('Not sent');
      expect(made.params).toEqual([
        {
          username: 'contractor',
          full_name: 'New Contractor',
          email: 'c@example.com',
          group: 12,
          groups: [13],
          group_create: false,
          password_disabled: true,
          smb: false,
          home: '/mnt/tank/homes',
          home_create: true,
          shell: '/usr/bin/bash',
        },
      ]);
      const [, , recorded] = await userCreate.plan(system().ctx, { ...args, home: '/mnt/tank/homes/c' });
      expect(recorded.description).toContain('Home directory "/mnt/tank/homes/c" is recorded for the account; nothing is created there');
    });
  });

  describe('what it reports', () => {
    it('creates with exactly what the plan named, after resolving and checking again', async () => {
      const { ctx, call, query } = system();
      const steps = await userCreate.plan(system().ctx, args);
      await userCreate.execute(ctx, args);
      expect(call).toHaveBeenCalledTimes(1);
      expect(call).toHaveBeenCalledWith(steps[2].method, steps[2].params);
      expect(query.mock.calls.map((c) => c[0])).toEqual(['group.query', 'privilege.query']);
    });

    it('creates nothing where a group became privileged since the plan', async () => {
      const { ctx, call } = system({
        'privilege.query': [{ id: 9, name: 'New', local_groups: [{ gid: 3002 }], ds_groups: [] }],
      });
      await expect(userCreate.execute(ctx, args)).rejects.toThrow(/Group "staff" holds privilege "New"/);
      expect(call).not.toHaveBeenCalled();
    });

    it('reports the account through named fields, with no hash, password or key', async () => {
      const result = (await userCreate.execute(system().ctx, args)) as Record<string, unknown>;
      expect(result['user']).toEqual({
        id: 41,
        uid: 3010,
        username: 'contractor',
        full_name: 'New Contractor',
        email: null,
        primary_group: 12,
        groups: [13],
        home: '/var/empty',
        shell: '/usr/bin/zsh',
        password_disabled: true,
        smb: false,
        locked: false,
      });
      expect(result['confirmed']).toBe(true);
      const text = JSON.stringify(result);
      for (const secret of ['$6$salt$hash', 'ABCDEF0123456789', 'generated-secret', 'ssh-ed25519', 'old']) {
        expect(text).not.toContain(secret);
      }
      for (const key of ['unixhash', 'smbhash', 'password', 'sshpubkey', 'password_history']) {
        expect(text).not.toContain(`"${key}"`);
      }
    });

    it('keeps the hashes and password out of the plan too', async () => {
      const steps = await userCreate.plan(system().ctx, args);
      const text = JSON.stringify(steps);
      for (const secret of ['$6$salt$hash', 'ABCDEF0123456789', 'generated-secret']) {
        expect(text).not.toContain(secret);
      }
    });

    it('reports a value stored as something else as unconfirmed, not as a success', async () => {
      for (const over of [{ smb: true }, { password_disabled: false }, { groups: [13, 1] }, { group: { id: 1 } }]) {
        const result = (await userCreate.execute(system({ 'user.create': { ...created, ...over } }).ctx, args)) as {
          confirmed: unknown;
        };
        expect(result.confirmed).toBe(false);
      }
    });

    it('is null rather than true where a value could not be read back', async () => {
      const result = (await userCreate.execute(
        system({ 'user.create': { ...created, groups: [13, 'x'] } }).ctx,
        args,
      )) as { user: { groups: unknown }; confirmed: unknown };
      expect(result.user.groups).toBeNull();
      expect(result.confirmed).toBeNull();
    });

    it('reports no account and no confirmation where the response is not a record', async () => {
      for (const response of [null, true, [created]]) {
        const result = await userCreate.execute(system({ 'user.create': response }).ctx, args);
        expect(result).toMatchObject({ user: null, confirmed: null });
      }
    });
  });
});
