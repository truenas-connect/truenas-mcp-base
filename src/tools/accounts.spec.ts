import { describe, expect, it } from 'vitest';
import { failingSystem } from '@/testing/fake-systems';
import { directoryServicesStatus, usersList } from '@/tools/index';

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
