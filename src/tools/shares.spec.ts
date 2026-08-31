import { describe, expect, it, vi } from 'vitest';
import { of, throwError } from 'rxjs';
import { SystemHandle, ToolContext } from '@/catalog/tool';
import { shareAccess, sharesList } from '@/tools/index';

describe('shares_list', () => {
  /**
   * A SystemHandle whose two share queries answer independently, either with
   * rows or by failing. `fakeSystem` answers every method from one canned map
   * and has no way to make a call fail, which is what half of these tests are
   * about.
   *
   * A failure is a second map rather than a sentinel value in the first, so a
   * test can say what the query rejected WITH — including a rejection that is
   * not an `Error` at all, which a sentinel could not tell from a response.
   */
  const fakeShares = (
    rows: Partial<Record<string, unknown>>,
    failures: Partial<Record<string, unknown>> = {},
  ): { ctx: ToolContext; query: ReturnType<typeof vi.fn> } => {
    const query = vi.fn((method: string) =>
      method in failures ? throwError(() => failures[method]) : of(rows[method]),
    );
    const system = { name: 'nas', client: { api: { query } } } as unknown as SystemHandle;
    return { ctx: { system }, query };
  };

  /**
   * An SMB share as `sharing.smb.query` reports one. `options`, `audit`,
   * `purpose` and `locked` are real fields of the payload that this tool does
   * not name, and are here to be dropped.
   */
  const smb = (over: Record<string, unknown> = {}) => ({
    id: 3,
    name: 'media',
    path: '/mnt/tank/media',
    enabled: true,
    comment: 'Films and music',
    purpose: 'DEFAULT_SHARE',
    locked: false,
    browsable: true,
    audit: { enable: false },
    options: { aapl_name_mangling: false },
    ...over,
  });

  /**
   * An NFS export as `sharing.nfs.query` reports one. `hosts`, `networks`,
   * `security` and `maproot_user` are fields the tool does not name — who may
   * reach the export is `share_access`, not this tool.
   */
  const nfs = (over: Record<string, unknown> = {}) => ({
    id: 3,
    path: '/mnt/tank/backups',
    enabled: true,
    comment: 'Nightly backups',
    hosts: ['10.0.0.5'],
    networks: ['10.0.0.0/24'],
    security: ['SYS'],
    maproot_user: 'root',
    locked: null,
    ...over,
  });

  const listed = async (
    rows: Partial<Record<string, unknown>>,
    failures: Partial<Record<string, unknown>> = {},
  ): Promise<{ shares: Record<string, unknown>[]; failures: Record<string, unknown>[] }> => {
    const { ctx } = fakeShares(rows, failures);
    return (await sharesList.handler(ctx, {})) as {
      shares: Record<string, unknown>[];
      failures: Record<string, unknown>[];
    };
  };

  /** Both protocols answering, with only the fields a case is about differing. */
  const both = async (
    smbOver: Record<string, unknown> = {},
    nfsOver: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>[]> =>
    (
      await listed({
        ['sharing.smb.query']: [smb(smbOver)],
        ['sharing.nfs.query']: [nfs(nfsOver)],
      })
    ).shares;

  it('merges SMB and NFS into one list, each tagged with its protocol', async () => {
    expect(
      await listed({
        ['sharing.smb.query']: [smb()],
        ['sharing.nfs.query']: [nfs()],
      }),
    ).toEqual({
      shares: [
        {
          protocol: 'SMB',
          id: 3,
          name: 'media',
          path: '/mnt/tank/media',
          enabled: true,
          comment: 'Films and music',
        },
        {
          protocol: 'NFS',
          id: 3,
          // NFS identifies an export by its path and holds no name for one.
          name: null,
          path: '/mnt/tank/backups',
          enabled: true,
          comment: 'Nightly backups',
        },
      ],
      failures: [],
    });
  });

  it('surfaces no field a later release adds', async () => {
    const shares = await both(
      { future_field: 'added by a later TrueNAS release' },
      { future_field: 'added by a later TrueNAS release' },
    );
    for (const share of shares) {
      expect(Object.keys(share)).toEqual([
        'protocol',
        'id',
        'name',
        'path',
        'enabled',
        'comment',
      ]);
    }
  });

  it('asks each protocol for every share', async () => {
    const { ctx, query } = fakeShares({
      ['sharing.smb.query']: [smb()],
      ['sharing.nfs.query']: [nfs()],
    });
    await sharesList.handler(ctx, {});
    expect(query).toHaveBeenCalledWith('sharing.smb.query');
    expect(query).toHaveBeenCalledWith('sharing.nfs.query');
  });

  it('returns an empty list for a system sharing nothing', async () => {
    expect(await listed({ ['sharing.smb.query']: [], ['sharing.nfs.query']: [] })).toEqual({
      shares: [],
      failures: [],
    });
  });

  it('returns a disabled share, marked disabled, rather than omitting it', async () => {
    // A share nobody switched back on is exactly the one worth finding.
    const shares = await both({ enabled: false }, { enabled: false });
    expect(shares.map((share) => share['enabled'])).toEqual([false, false]);
  });

  it('reports a switch it could not read as null, which is not false', async () => {
    for (const unreadable of [undefined, null]) {
      const shares = await both({ enabled: unreadable }, { enabled: unreadable });
      expect(shares.map((share) => share['enabled'])).toEqual([null, null]);
    }
  });

  it('passes an SMB EXTERNAL share through as the system spelled it', async () => {
    // Not a path on this system, and not a path that could not be found.
    expect((await both({ path: 'EXTERNAL' }))[0]['path']).toBe('EXTERNAL');
  });

  it('reports a name, path or comment the system did not give as null', async () => {
    for (const absent of [undefined, null, '', 42]) {
      const shares = await both(
        { name: absent, path: absent, comment: absent },
        { path: absent, comment: absent },
      );
      expect(shares.map((share) => share['name'])).toEqual([null, null]);
      expect(shares.map((share) => share['path'])).toEqual([null, null]);
      expect(shares.map((share) => share['comment'])).toEqual([null, null]);
    }
  });

  it('keeps one protocol’s shares when the other’s query fails', async () => {
    const smbOnly = await listed(
      { ['sharing.smb.query']: [smb()] },
      { ['sharing.nfs.query']: new Error('nfs service is not running') },
    );
    expect(smbOnly.shares.map((share) => share['protocol'])).toEqual(['SMB']);
    expect(smbOnly.failures).toEqual([{ protocol: 'NFS', error: 'nfs service is not running' }]);

    const nfsOnly = await listed(
      { ['sharing.nfs.query']: [nfs()] },
      { ['sharing.smb.query']: new Error('smb service is not running') },
    );
    expect(nfsOnly.shares.map((share) => share['protocol'])).toEqual(['NFS']);
    expect(nfsOnly.failures).toEqual([{ protocol: 'SMB', error: 'smb service is not running' }]);
  });

  it('names a failure however the rejection arrived', async () => {
    for (const [reason, text] of [
      ['nfs is down', 'nfs is down'],
      // The two carrier shapes the client documents. This file used to read
      // neither, so a real middleware rejection reported as having said
      // nothing; it now reads them the way every other tool family does.
      [{ reason: 'nfs service is not running' }, 'nfs service is not running'],
      [{ message: 'connection reset' }, 'connection reset'],
      [new Error(''), 'the system reported no reason'],
      [{ code: 500 }, 'the system reported no reason'],
      [undefined, 'the system reported no reason'],
    ] as const) {
      const result = await listed(
        { ['sharing.smb.query']: [smb()] },
        { ['sharing.nfs.query']: reason },
      );
      expect(result.failures).toEqual([{ protocol: 'NFS', error: text }]);
    }
  });

  it('raises rather than answering with an empty list when neither could be read', async () => {
    // An empty `shares` beside a `failures` nobody checked reads as a system
    // that shares nothing, which is the one wrong answer that gets repeated.
    const { ctx } = fakeShares(
      {},
      {
        ['sharing.smb.query']: new Error('smb is down'),
        ['sharing.nfs.query']: new Error('nfs is down'),
      },
    );
    await expect(sharesList.handler(ctx, {})).rejects.toThrow(
      'no share could be listed: SMB: smb is down; NFS: nfs is down',
    );
  });
});

describe('share_access', () => {
  /**
   * A SystemHandle whose share lists and ACL read answer from one canned map,
   * or fail. Both seams read that map because this tool uses `query` for the
   * two share lists and `call` for the ACL, and half of these tests are about
   * one of the three failing while the others answer.
   */
  const fakeAccess = (
    rows: Partial<Record<string, unknown>>,
    failures: Partial<Record<string, unknown>> = {},
  ): { ctx: ToolContext; query: ReturnType<typeof vi.fn>; call: ReturnType<typeof vi.fn> } => {
    const answer = (method: string) =>
      method in failures ? throwError(() => failures[method]) : of(rows[method]);
    const query = vi.fn(answer);
    const call = vi.fn(answer);
    const system = { name: 'nas', client: { api: { query, call } } } as unknown as SystemHandle;
    return { ctx: { system }, query, call };
  };

  const smbShare = (over: Record<string, unknown> = {}) => ({
    id: 3,
    name: 'media',
    path: '/mnt/tank/media',
    enabled: true,
    comment: 'Films and music',
    readonly: false,
    // The host rules live under `options`, whose other keys differ by what the
    // share is for and are not read here.
    options: { purpose: 'LEGACY_SHARE', hostsallow: ['10.0.0.5'], hostsdeny: ['ALL'] },
    ...over,
  });

  const nfsExport = (over: Record<string, unknown> = {}) => ({
    id: 7,
    path: '/mnt/tank/backups',
    enabled: true,
    comment: 'Nightly backups',
    ro: false,
    hosts: ['10.0.0.5'],
    networks: ['10.0.0.0/24'],
    mapall_user: null,
    mapall_group: null,
    maproot_user: null,
    maproot_group: null,
    ...over,
  });

  /** One entry of an SMB share-level ACL as `sharing.smb.getacl` reports one. */
  const shareAce = (over: Record<string, unknown> = {}) => ({
    ae_who_str: 'alice',
    ae_who_id: { id_type: 'USER', id: 1001 },
    ae_who_sid: 'S-1-5-21-1-1001',
    ae_type: 'ALLOWED',
    ae_perm: 'FULL',
    ...over,
  });

  const shareAclOf = (over: Record<string, unknown> = {}) => ({
    share_name: 'media',
    share_acl: [shareAce()],
    ...over,
  });

  /** The default NFS export's own say in who may reach it, once mapped. */
  const nfs = {
    hosts: ['10.0.0.5'],
    networks: ['10.0.0.0/24'],
    mapall_user: null,
    mapall_group: null,
    maproot_user: null,
    maproot_group: null,
  };

  /** The default SMB share ACL, once mapped. */
  const shareAcl = [
    {
      name: 'alice',
      id: 1001,
      kind: 'USER',
      sid: 'S-1-5-21-1-1001',
      access: 'ALLOWED',
      permission: 'FULL',
    },
  ];

  /** One ACL entry as `filesystem.getacl` reports one, resolved. */
  const ace = (over: Record<string, unknown> = {}) => ({
    tag: 'USER',
    id: 1001,
    who: 'alice',
    type: 'ALLOW',
    perms: { BASIC: 'FULL_CONTROL' },
    flags: { BASIC: 'INHERIT' },
    ...over,
  });

  const aclOf = (over: Record<string, unknown> = {}) => ({
    path: '/mnt/tank/media',
    user: 'root',
    uid: 0,
    group: 'wheel',
    gid: 0,
    acltype: 'NFS4',
    trivial: false,
    acl: [ace()],
    ...over,
  });

  /** The one entry the default ACL holds, once mapped. */
  const entry = {
    tag: 'USER',
    name: 'alice',
    id: 1001,
    access: 'ALLOW',
    permissions: ['FULL_CONTROL'],
    children_only: false,
  };

  /** The default ACL, once mapped. */
  const acl = {
    type: 'NFS4',
    trivial: false,
    owner_user: 'root',
    owner_uid: 0,
    owner_group: 'wheel',
    owner_gid: 0,
    entries: [entry],
  };

  const answered = async (
    args: Record<string, unknown>,
    rows: Partial<Record<string, unknown>> = {},
    failures: Partial<Record<string, unknown>> = {},
  ): Promise<Record<string, unknown>> => {
    const { ctx } = fakeAccess(
      {
        ['sharing.smb.query']: [smbShare()],
        ['sharing.nfs.query']: [nfsExport()],
        ['filesystem.getacl']: aclOf(),
        ['sharing.smb.getacl']: shareAclOf(),
        ...rows,
      },
      failures,
    );
    return (await shareAccess.handler(ctx, args)) as Record<string, unknown>;
  };

  const entriesOf = (result: Record<string, unknown>): Record<string, unknown>[] =>
    (result['acl'] as { entries: Record<string, unknown>[] }).entries;

  /** The SMB share's single ACL entry, with only the fields a case is about differing. */
  const oneEntry = async (over: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const result = await answered(
      { share: 'media' },
      { ['filesystem.getacl']: aclOf({ acl: [ace(over)] }) },
    );
    return entriesOf(result)[0];
  };

  it('reports an SMB share by name, with both gates in front of its path', async () => {
    expect(await answered({ share: 'media' })).toEqual({
      protocol: 'SMB',
      id: 3,
      name: 'media',
      path: '/mnt/tank/media',
      enabled: true,
      read_only: false,
      smb: { hosts_allow: ['10.0.0.5'], hosts_deny: ['ALL'] },
      // An NFS export's restrictions and id mapping are a different protocol's.
      nfs: null,
      share_acl: shareAcl,
      share_acl_error: null,
      acl,
      acl_error: null,
      failures: [],
    });
  });

  it('reports an NFS export by the path it exports, with who may mount it', async () => {
    expect(await answered({ share: '/mnt/tank/backups' })).toEqual({
      protocol: 'NFS',
      id: 7,
      // NFS identifies an export by its path and holds no name for one.
      name: null,
      path: '/mnt/tank/backups',
      enabled: true,
      read_only: false,
      // An NFS export is not served by the SMB service, so it has no host
      // rules of that kind rather than unread ones.
      smb: null,
      nfs,
      // NFS has no share-level ACL, so neither half of that answer is present.
      share_acl: null,
      share_acl_error: null,
      acl,
      acl_error: null,
      failures: [],
    });
  });

  it('does not read the SMB share ACL for an NFS export', async () => {
    const { ctx, call } = fakeAccess({
      ['sharing.smb.query']: [],
      ['sharing.nfs.query']: [nfsExport()],
      ['filesystem.getacl']: aclOf(),
    });
    await shareAccess.handler(ctx, { share: '/mnt/tank/backups' });
    expect(call).not.toHaveBeenCalledWith('sharing.smb.getacl', expect.anything());
  });

  it('reads the SMB share ACL by the share name', async () => {
    const { ctx, call } = fakeAccess({
      ['sharing.smb.query']: [smbShare()],
      ['sharing.nfs.query']: [],
      ['filesystem.getacl']: aclOf(),
      ['sharing.smb.getacl']: shareAclOf(),
    });
    await shareAccess.handler(ctx, { share: 'media' });
    expect(call).toHaveBeenCalledWith('sharing.smb.getacl', [{ share_name: 'media' }]);
  });

  it('reports a read-only share as read-only, and an unreadable switch as null', async () => {
    // It caps every write permission reported anywhere else in the answer.
    expect((await answered({ share: 'media' }, { ['sharing.smb.query']: [smbShare({ readonly: true })] }))['read_only']).toBe(true);
    expect(
      (
        await answered(
          { share: '/mnt/tank/backups' },
          { ['sharing.nfs.query']: [nfsExport({ ro: true })] },
        )
      )['read_only'],
    ).toBe(true);
    for (const unreadable of [undefined, null]) {
      const result = await answered(
        { share: 'media' },
        { ['sharing.smb.query']: [smbShare({ readonly: unreadable })] },
      );
      expect(result['read_only']).toBeNull();
    }
  });

  it('reports the mapping that replaces who arrives over an NFS export', async () => {
    // The ACL then answers for that one account rather than for whoever
    // connected, so an answer that omitted this would be about the wrong user.
    const result = await answered(
      { share: '/mnt/tank/backups' },
      {
        ['sharing.nfs.query']: [
          nfsExport({ mapall_user: 'nobody', mapall_group: '', maproot_user: 'root' }),
        ],
      },
    );
    expect(result['nfs']).toEqual({
      ...nfs,
      mapall_user: 'nobody',
      mapall_group: null,
      maproot_user: 'root',
      maproot_group: null,
    });
  });

  it('names a share ACL principal every way the system had, and keeps one it did not', async () => {
    const result = await answered(
      { share: 'media' },
      {
        ['sharing.smb.getacl']: shareAclOf({
          share_acl: [
            shareAce({ ae_who_str: null, ae_who_id: null, ae_type: 'DENIED', ae_perm: 'READ' }),
            shareAce({ ae_who_id: { id_type: 'GROUP', id: 2002 }, ae_who_sid: null }),
            // Neither an object nor an entry with anything readable in it.
            null,
            shareAce({ ae_who_str: '', ae_who_id: { id_type: 'ALIAS', id: 'x' }, ae_who_sid: '', ae_type: 'MAYBE', ae_perm: '' }),
          ],
        }),
      },
    );
    expect(result['share_acl']).toEqual([
      {
        name: null,
        id: null,
        kind: null,
        sid: 'S-1-5-21-1-1001',
        access: 'DENIED',
        permission: 'READ',
      },
      { name: 'alice', id: 2002, kind: 'GROUP', sid: null, access: 'ALLOWED', permission: 'FULL' },
      { name: null, id: null, kind: null, sid: null, access: null, permission: null },
      { name: null, id: null, kind: null, sid: null, access: null, permission: null },
    ]);
  });

  it('does not present an unread share ACL as a share nobody may reach', async () => {
    // An empty share-level ACL would read as everyone denied, which is the
    // opposite of a share that carries no share-level ACL at all.
    const missing = await answered(
      { share: 'media' },
      { ['sharing.smb.getacl']: shareAclOf({ share_acl: undefined }) },
    );
    expect(missing['share_acl']).toBeNull();
    expect(missing['share_acl_error']).toBe(
      'the system reported no share-level ACL, so what it allows is not known here',
    );

    const failed = await answered(
      { share: 'media' },
      {},
      { ['sharing.smb.getacl']: new Error('smb is down') },
    );
    expect(failed['share_acl']).toBeNull();
    expect(failed['share_acl_error']).toBe('smb is down');
    // The rest of the answer survives it.
    expect(failed['acl']).toEqual(acl);

    const nameless = await answered(
      { share: '/mnt/tank/media' },
      { ['sharing.smb.query']: [smbShare({ name: null })] },
    );
    expect(nameless['share_acl_error']).toBe(
      'the system reported no name for this share, and the share ACL is read by name',
    );
  });

  it('reports a share ACL that allows nobody as empty, which is not unread', async () => {
    const result = await answered(
      { share: 'media' },
      { ['sharing.smb.getacl']: shareAclOf({ share_acl: [] }) },
    );
    expect(result['share_acl']).toEqual([]);
    expect(result['share_acl_error']).toBeNull();
  });

  it('surfaces no field a later release adds', async () => {
    const result = await answered(
      { share: 'media' },
      {
        ['sharing.smb.query']: [
          smbShare({
            future_field: 'added later',
            // `options` is read key by key, so a later release adding one
            // there must not reach the caller either.
            options: { purpose: 'LEGACY_SHARE', hostsallow: [], future_field: 'added later' },
          }),
        ],
        ['filesystem.getacl']: aclOf({
          future_field: 'added later',
          acl: [ace({ future_field: 'added later' })],
        }),
        ['sharing.smb.getacl']: shareAclOf({
          future_field: 'added later',
          share_acl: [shareAce({ future_field: 'added later' })],
        }),
      },
    );
    expect(Object.keys(result)).toEqual([
      'protocol',
      'id',
      'name',
      'path',
      'enabled',
      'read_only',
      'smb',
      'nfs',
      'share_acl',
      'share_acl_error',
      'acl',
      'acl_error',
      'failures',
    ]);
    expect(Object.keys(result['smb'] as object)).toEqual(['hosts_allow', 'hosts_deny']);
    expect(Object.keys((result['share_acl'] as object[])[0])).toEqual([
      'name',
      'id',
      'kind',
      'sid',
      'access',
      'permission',
    ]);
    expect(Object.keys(result['acl'] as object)).toEqual([
      'type',
      'trivial',
      'owner_user',
      'owner_uid',
      'owner_group',
      'owner_gid',
      'entries',
    ]);
    expect(Object.keys(entriesOf(result)[0])).toEqual([
      'tag',
      'name',
      'id',
      'access',
      'permissions',
      'children_only',
    ]);
  });

  it('reads the ACL of the path the share serves, resolving ids to names', async () => {
    const { ctx, call } = fakeAccess({
      ['sharing.smb.query']: [smbShare()],
      ['sharing.nfs.query']: [],
      ['filesystem.getacl']: aclOf(),
    });
    await shareAccess.handler(ctx, { share: 'media' });
    expect(call).toHaveBeenCalledWith('filesystem.getacl', ['/mnt/tank/media', true, true]);
  });

  it('matches an SMB share by its path as well as by its name', async () => {
    expect((await answered({ share: '/mnt/tank/media' }))['id']).toBe(3);
  });

  it('searches only the protocol asked for', async () => {
    // The path is an SMB share's, so restricting to NFS must find nothing
    // rather than answering with the SMB share.
    await expect(answered({ share: '/mnt/tank/media', protocol: 'NFS' })).rejects.toThrow(
      'no NFS share is named "/mnt/tank/media" or exports that path',
    );
  });

  it('treats an omitted or null protocol as both', async () => {
    for (const protocol of [undefined, null]) {
      expect((await answered({ share: '/mnt/tank/backups', protocol }))['protocol']).toBe('NFS');
    }
  });

  it('errors naming the share when nothing matches, rather than answering empty', async () => {
    // A share that does not exist and a share nobody can reach are opposite
    // answers, and an empty result would read as the second.
    await expect(answered({ share: 'ghost' })).rejects.toThrow(
      'no share is named "ghost" or exports that path',
    );
  });

  it('says so when the share it did not find is one it could not have seen', async () => {
    await expect(
      answered({ share: 'ghost' }, {}, { ['sharing.nfs.query']: new Error('nfs is down') }),
    ).rejects.toThrow(
      'no share is named "ghost" or exports that path, and it may be one that could not be ' +
        'looked up: NFS: nfs is down',
    );
  });

  it('names both protocols when neither share list could be read', async () => {
    await expect(
      answered(
        { share: 'ghost' },
        {},
        {
          ['sharing.smb.query']: new Error('smb is down'),
          ['sharing.nfs.query']: new Error('nfs is down'),
        },
      ),
    ).rejects.toThrow(
      'no share is named "ghost" or exports that path, and it may be one that could not be ' +
        'looked up: SMB: smb is down; NFS: nfs is down',
    );
  });

  it('leaves out a failure of a protocol the caller excluded', async () => {
    // The NFS list failing says nothing about a question restricted to SMB, so
    // reporting it would make a complete answer read as a doubtful one.
    await expect(
      answered(
        { share: 'ghost', protocol: 'SMB' },
        {},
        { ['sharing.nfs.query']: new Error('nfs is down') },
      ),
    ).rejects.toThrow('no SMB share is named "ghost" or exports that path');
  });

  it('says the answer may not be the only one when a protocol could not be searched', async () => {
    // The check for a second match ran over a list that was never read, so the
    // error this tool would otherwise raise is one it could not detect —
    // presenting this as the unique answer would be a guess.
    const result = await answered(
      { share: '/mnt/tank/backups' },
      {},
      { ['sharing.smb.query']: new Error('smb is down') },
    );
    expect(result['protocol']).toBe('NFS');
    expect(result['failures']).toEqual([{ protocol: 'SMB', error: 'smb is down' }]);
  });

  it('leaves failures empty when the caller excluded the protocol that failed', async () => {
    const result = await answered(
      { share: '/mnt/tank/backups', protocol: 'NFS' },
      {},
      { ['sharing.smb.query']: new Error('smb is down') },
    );
    expect(result['failures']).toEqual([]);
  });

  it('errors rather than guessing when one string matches more than one share', async () => {
    // A path shared over both protocols grants access differently through each,
    // so there is no single answer to give.
    await expect(
      answered(
        { share: '/mnt/tank/media' },
        { ['sharing.nfs.query']: [nfsExport({ path: '/mnt/tank/media' })] },
      ),
    ).rejects.toThrow(
      '"/mnt/tank/media" matches 2 shares — SMB share 3, NFS share 7. Ask again with the ' +
        'protocol argument, or with the SMB share name rather than its path.',
    );
  });

  it('resolves a two-share match by the protocol the error advertises', async () => {
    const rows = { ['sharing.nfs.query']: [nfsExport({ path: '/mnt/tank/media' })] };
    expect((await answered({ share: '/mnt/tank/media', protocol: 'SMB' }, rows))['id']).toBe(3);
    expect((await answered({ share: '/mnt/tank/media', protocol: 'NFS' }, rows))['id']).toBe(7);
  });

  it('rejects a call that names no share', async () => {
    for (const missing of [undefined, null, '', 42]) {
      await expect(answered({ share: missing })).rejects.toThrow('share is required');
    }
  });

  it('rejects a protocol that is neither SMB nor NFS', async () => {
    await expect(answered({ share: 'media', protocol: 'iSCSI' })).rejects.toThrow(
      'protocol must be "SMB" or "NFS", not "iSCSI"',
    );
  });

  it('reports an unrestricted NFS export as empty, which is not nobody', async () => {
    // No host restriction and no network restriction together mean any machine
    // that can reach the server may mount it.
    const result = await answered(
      { share: '/mnt/tank/backups' },
      { ['sharing.nfs.query']: [nfsExport({ hosts: [], networks: [] })] },
    );
    expect(result['nfs']).toMatchObject({ hosts: [], networks: [] });
  });

  it('does not read an absent restriction as an unrestricted export', async () => {
    // The field is optional on the client's own type, so its absence is a
    // middleware that did not report the restriction rather than an export
    // that has none — and `[]` would claim any machine may mount it.
    for (const absent of [undefined, null]) {
      const result = await answered(
        { share: '/mnt/tank/backups' },
        { ['sharing.nfs.query']: [nfsExport({ hosts: absent, networks: absent })] },
      );
      expect(result['nfs']).toMatchObject({ hosts: null, networks: null });
    }
  });

  it('reports a restriction list it could not read whole as null, never in part', async () => {
    // Reporting the readable entries alone would answer with a narrower
    // restriction than the export carries, and dropping all of them would
    // answer `[]` — which here means the opposite, that nothing is restricted.
    const result = await answered(
      { share: '/mnt/tank/backups' },
      { ['sharing.nfs.query']: [nfsExport({ hosts: ['10.0.0.5', '', 42], networks: 'everyone' })] },
    );
    expect(result['nfs']).toMatchObject({ hosts: null, networks: null });

    const allDropped = await answered(
      { share: '/mnt/tank/backups' },
      { ['sharing.nfs.query']: [nfsExport({ hosts: [42], networks: [''] })] },
    );
    expect(allDropped['nfs']).toMatchObject({ hosts: null, networks: null });
  });

  it('reports the host rules an SMB share carries, which run before both ACLs', async () => {
    // A share whose ACLs grant everyone is still reached by nobody the SMB
    // service turns away here, so an answer without these overstates access.
    const result = await answered(
      { share: 'media' },
      {
        ['sharing.smb.query']: [
          smbShare({
            options: {
              purpose: 'LEGACY_SHARE',
              hostsallow: ['10.0.0.0/24', 'trusted.example'],
              hostsdeny: [],
            },
          }),
        ],
      },
    );
    expect(result['smb']).toEqual({
      hosts_allow: ['10.0.0.0/24', 'trusted.example'],
      // Empty is a rule the share does not have, and turns nobody away.
      hosts_deny: [],
    });
  });

  it('does not read an absent SMB host rule as a share that turns nobody away', async () => {
    // The keys are optional, and every option shape but the legacy one omits
    // them, so their absence is a rule this tool could not read rather than
    // one the share does not have. `[]` would say the opposite.
    for (const options of [undefined, null, 'DEFAULT_SHARE', { purpose: 'DEFAULT_SHARE' }]) {
      const result = await answered(
        { share: 'media' },
        { ['sharing.smb.query']: [smbShare({ options })] },
      );
      expect(result['smb']).toEqual({ hosts_allow: null, hosts_deny: null });
    }
  });

  it('reports an SMB host rule it could not read whole as null, never in part', async () => {
    // Same reading as the NFS lists above: a rule reported in part is a
    // different rule, and here a narrower one lets machines in.
    const result = await answered(
      { share: 'media' },
      {
        ['sharing.smb.query']: [
          smbShare({ options: { hostsallow: ['10.0.0.5', 42], hostsdeny: 'ALL' } }),
        ],
      },
    );
    expect(result['smb']).toEqual({ hosts_allow: null, hosts_deny: null });
  });

  it('states why a share that serves no path here has no ACL', async () => {
    const external = await answered(
      { share: 'media' },
      { ['sharing.smb.query']: [smbShare({ path: 'EXTERNAL' })] },
    );
    expect(external['acl']).toBeNull();
    expect(external['acl_error']).toContain('redirects clients to another server');

    const pathless = await answered(
      { share: 'media' },
      { ['sharing.smb.query']: [smbShare({ path: null })] },
    );
    expect(pathless['acl']).toBeNull();
    expect(pathless['acl_error']).toBe(
      'the system reported no path for this share, so it has no ACL',
    );
  });

  it('keeps the share and its restrictions when the ACL read fails', async () => {
    // Over NFS the host restrictions still answer half the question, and an
    // unread ACL must never arrive as an empty one.
    for (const [reason, text] of [
      [new Error('permission denied'), 'permission denied'],
      [{ code: 500 }, 'the system reported no reason'],
    ] as const) {
      const result = await answered(
        { share: '/mnt/tank/backups' },
        {},
        { ['filesystem.getacl']: reason },
      );
      expect(result['nfs']).toEqual(nfs);
      expect(result['acl']).toBeNull();
      expect(result['acl_error']).toBe(text);
    }
  });

  it.each([
    ['no list at all', null],
    // The shape every other empty ACL arrives in. Reporting it as an empty
    // entry list would say this ACL grants nobody anything, when in fact no
    // ACL is in force and the mode bits this tool does not read decide.
    ['an empty list', []],
    // Nothing here is in force, so reporting it would name principals as
    // having access the path does not give them.
    ['a list of entries', [ace()]],
  ])('reports a path with ACLs switched off as holding no entry list, given %s', async (
    _shape,
    acl,
  ) => {
    const result = await answered(
      { share: 'media' },
      { ['filesystem.getacl']: aclOf({ acltype: 'DISABLED', acl, trivial: true }) },
    );
    expect(result['acl']).toEqual({
      type: 'DISABLED',
      trivial: true,
      owner_user: 'root',
      owner_uid: 0,
      owner_group: 'wheel',
      owner_gid: 0,
      entries: null,
    });
  });

  it('reports an entry list it could not read as null on a live ACL type', async () => {
    // The other direction of the same tie: `entries` null is not the exclusive
    // property of a DISABLED path, so an NFS4 ACL whose list did not arrive as
    // one reports null rather than an empty list that would read as granting
    // nobody anything.
    expect(
      (await answered({ share: 'media' }, { ['filesystem.getacl']: aclOf({ acl: null }) }))['acl'],
    ).toEqual({ ...acl, entries: null });
  });

  it('reports an ACL field it could not read as null', async () => {
    const result = await answered(
      { share: 'media' },
      {
        ['filesystem.getacl']: aclOf({
          acltype: '',
          trivial: 'yes',
          user: null,
          uid: 'nobody',
          group: '',
          gid: Number.NaN,
        }),
      },
    );
    expect(result['acl']).toEqual({
      type: null,
      trivial: null,
      owner_user: null,
      owner_uid: null,
      owner_group: null,
      owner_gid: null,
      entries: [entry],
    });
  });

  it('reports an ACL that holds no entry as empty, which the mode bits do not', async () => {
    expect(
      (await answered({ share: 'media' }, { ['filesystem.getacl']: aclOf({ acl: [] }) }))['acl'],
    ).toEqual({ ...acl, entries: [] });
  });

  it('maps a POSIX ACL, whose tags and shape are not the NFS4 ones', async () => {
    // POSIX has its own tag vocabulary, no `type` at all, and a MASK entry
    // that is a ceiling on the named entries rather than a principal. Every
    // other ACL fixture here is NFS4, which shares the mapping but not the
    // shape, so nothing else in this file would notice POSIX arriving wrong.
    const posix = (over: Record<string, unknown>) => ({
      perms: { READ: true, WRITE: false, EXECUTE: true },
      default: false,
      id: -1,
      who: null,
      ...over,
    });
    const result = await answered(
      { share: 'media' },
      {
        ['filesystem.getacl']: aclOf({
          acltype: 'POSIX1E',
          acl: [
            posix({ tag: 'USER_OBJ', perms: { READ: true, WRITE: true, EXECUTE: true } }),
            posix({ tag: 'USER', id: 1001, who: 'alice' }),
            posix({ tag: 'MASK' }),
            posix({ tag: 'OTHER', perms: { READ: false, WRITE: false, EXECUTE: false } }),
            posix({ tag: 'GROUP', id: 2002, who: null, default: true }),
          ],
        }),
      },
    );
    expect(entriesOf(result)).toEqual([
      // The tag is its own principal, so neither a name nor an id is missing.
      {
        tag: 'USER_OBJ',
        name: null,
        id: null,
        access: null,
        permissions: ['READ', 'WRITE', 'EXECUTE'],
        children_only: false,
      },
      {
        tag: 'USER',
        name: 'alice',
        id: 1001,
        access: null,
        permissions: ['READ', 'EXECUTE'],
        children_only: false,
      },
      // Not a principal: a ceiling on what the named entries above grant.
      {
        tag: 'MASK',
        name: null,
        id: null,
        access: null,
        permissions: ['READ', 'EXECUTE'],
        children_only: false,
      },
      {
        tag: 'OTHER',
        name: null,
        id: null,
        access: null,
        permissions: [],
        children_only: false,
      },
      // A group whose gid resolved to no name, on an entry that grants nothing
      // on the path itself.
      {
        tag: 'GROUP',
        name: null,
        id: 2002,
        access: null,
        permissions: ['READ', 'EXECUTE'],
        children_only: true,
      },
    ]);
  });

  it('reports a principal by name where it resolves and by raw id where it does not', async () => {
    expect(await oneEntry({ who: null })).toMatchObject({ name: null, id: 1001 });
    expect(await oneEntry({ who: 'alice', id: 1001 })).toMatchObject({ name: 'alice', id: 1001 });
  });

  it('reports the tags that are their own principal with neither a name nor an id', async () => {
    // TrueNAS writes -1 on an entry whose tag IS the principal; reporting it
    // verbatim would put a uid in the result that no account has.
    expect(await oneEntry({ tag: 'owner@', who: null, id: -1 })).toMatchObject({
      tag: 'owner@',
      name: null,
      id: null,
    });
  });

  it('keeps an entry it could not read at all rather than dropping it', async () => {
    // A shorter list of principals reads as a complete one.
    const result = await answered(
      { share: 'media' },
      { ['filesystem.getacl']: aclOf({ acl: [null, 'nonsense'] }) },
    );
    expect(entriesOf(result)).toEqual([
      { tag: null, name: null, id: null, access: null, permissions: null, children_only: null },
      { tag: null, name: null, id: null, access: null, permissions: null, children_only: null },
    ]);
  });

  it('reports ALLOW and DENY, and anything else as null', async () => {
    expect((await oneEntry({ type: 'DENY' }))['access']).toBe('DENY');
    for (const unreadable of [undefined, null, 'PERMIT']) {
      expect((await oneEntry({ type: unreadable }))['access']).toBeNull();
    }
  });

  it('names a preset permission, an NFS4 permission set, and a POSIX one', async () => {
    expect((await oneEntry({ perms: { BASIC: 'MODIFY' } }))['permissions']).toEqual(['MODIFY']);
    expect(
      (await oneEntry({ perms: { READ_DATA: true, WRITE_DATA: false, EXECUTE: true } }))[
        'permissions'
      ],
    ).toEqual(['READ_DATA', 'EXECUTE']);
    expect(
      (await oneEntry({ perms: { READ: true, WRITE: false, EXECUTE: true } }))['permissions'],
    ).toEqual(['READ', 'EXECUTE']);
  });

  it('keeps an entry naming no permission apart from one whose permissions it could not read', async () => {
    // A POSIX `OTHER` entry really does carry an all-false permission set, and
    // that is what an empty list means. The second is not evidence that the
    // entry grants nothing.
    expect(
      (await oneEntry({ perms: { READ: false, WRITE: false, EXECUTE: false } }))['permissions'],
    ).toEqual([]);
    for (const unreadable of [null, undefined, 'FULL_CONTROL']) {
      expect((await oneEntry({ perms: unreadable }))['permissions']).toBeNull();
    }
    // A set naming no permission this tool can read at all is unreadable, not
    // an entry that holds nothing. So is a partly readable one: reporting
    // ['READ'] for the last of these would answer with a definite, narrower
    // set of rights than the entry carries.
    for (const unreadable of [{}, { READ: 'yes' }, { READ: true, WRITE: 'yes' }]) {
      expect((await oneEntry({ perms: unreadable }))['permissions']).toBeNull();
    }
    // A preset is known to grant something, and what it grants is exactly what
    // an unreadable preset name loses.
    for (const unreadable of [{ BASIC: '' }, { BASIC: 42 }]) {
      expect((await oneEntry({ perms: unreadable }))['permissions']).toBeNull();
    }
  });

  it('marks an entry that grants nothing on the path itself', async () => {
    // POSIX says it outright; NFS4 says it among its flags.
    expect((await oneEntry({ default: true }))['children_only']).toBe(true);
    expect((await oneEntry({ default: false }))['children_only']).toBe(false);
    expect((await oneEntry({ flags: { INHERIT_ONLY: true } }))['children_only']).toBe(true);
    expect((await oneEntry({ flags: { FILE_INHERIT: true } }))['children_only']).toBe(false);
    expect((await oneEntry({ flags: {} }))['children_only']).toBe(false);
    // Neither preset flag is inherit-only.
    for (const preset of ['INHERIT', 'NOINHERIT']) {
      expect((await oneEntry({ flags: { BASIC: preset } }))['children_only']).toBe(false);
    }
  });

  it('reports inheritance it could not read as null, not as access to the path', async () => {
    for (const unreadable of [undefined, null, 'inherited']) {
      expect((await oneEntry({ flags: unreadable }))['children_only']).toBeNull();
    }
    expect((await oneEntry({ flags: { BASIC: 42 } }))['children_only']).toBeNull();
    // Present but not a boolean: answering false would assert the entry grants
    // access on the path, which is the claim this field exists to avoid.
    expect((await oneEntry({ flags: { INHERIT_ONLY: 'yes' } }))['children_only']).toBeNull();
  });
});

describe('share_access — result guidance', () => {
  it('carries guidance that is a verbatim slice of the description', () => {
    expect(shareAccess.description).toContain(shareAccess.resultGuidance ?? '');
  });

  it('keeps the inversion that makes an empty list mean its opposite', () => {
    // The reading most costly to lose: two empty NFS lists are unrestricted
    // access, not none.
    const guidance = shareAccess.resultGuidance ?? '';
    expect(guidance).toContain('AN EMPTY LIST MEANS UNRESTRICTED');
  });

  it('leaves how to name the share where a caller reads it before choosing', () => {
    // Selection text: which string to pass, and that a non-match or an
    // ambiguous match is an error rather than an empty result.
    const description = shareAccess.description;
    expect(description).toContain('A string matching NO share is an error');
    expect(description).toContain('A string matching MORE THAN one share is also an error');
  });

  it('renders no stray escape into either field', () => {
    expect(shareAccess.description).not.toContain('\\');
    expect(shareAccess.resultGuidance).not.toContain('\\');
  });
});
