import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Role } from '@/interfaces';
import { fakeSystem, failingSystem } from '@/testing/fake-systems';
import {
  fleetComplianceReport,
  fleetHealthRollup,
  haStatus,
  systemHealthReport,
} from '@/tools/index';

describe('ha_status', () => {
  /** An HA pair with nothing in the way of a failover. */
  const pair = (over: Partial<Record<string, unknown>> = {}) => ({
    ['failover.status']: 'MASTER',
    ['failover.node']: 'A',
    ['failover.disabled.reasons']: [],
    ...over,
  });

  const reported = async (
    rows: Partial<Record<string, unknown>> = {},
    failures: Partial<Record<string, unknown>> = {},
  ): Promise<Record<string, unknown>> => {
    const { ctx } = failingSystem(pair(rows), failures);
    return (await haStatus.handler(ctx, {})) as Record<string, unknown>;
  };

  it('reports the state, the node and that a failover would work', async () => {
    expect(await reported()).toEqual({
      status: 'MASTER',
      ha_configured: true,
      node: 'A',
      failover_possible: true,
      failover_disabled_reasons: [],
      node_error: null,
      reasons_error: null,
    });
  });

  it('reports the standby node as part of a working pair', async () => {
    expect(await reported({ ['failover.status']: 'BACKUP', ['failover.node']: 'B' })).toMatchObject({
      status: 'BACKUP',
      ha_configured: true,
      node: 'B',
      failover_possible: true,
    });
  });

  it('reports every reason the system gives for a failover not being possible', async () => {
    expect(
      await reported({
        ['failover.disabled.reasons']: ['NO_VIP', 'MISMATCH_DISKS', 'NO_PONG'],
      }),
    ).toMatchObject({
      failover_possible: false,
      failover_disabled_reasons: ['NO_VIP', 'MISMATCH_DISKS', 'NO_PONG'],
      reasons_error: null,
    });
  });

  it('passes through a state a later release adds, as an HA pair', async () => {
    // Only the exact word `SINGLE` is read as "not a pair". Anything else is
    // treated as one and the reasons are read, so a state this library has
    // never seen produces a checkable answer rather than a silent
    // "not applicable".
    expect(
      await reported({ ['failover.status']: 'RESILVERING', ['failover.disabled.reasons']: ['X'] }),
    ).toMatchObject({
      status: 'RESILVERING',
      ha_configured: true,
      failover_possible: false,
      failover_disabled_reasons: ['X'],
    });
  });

  it('reports a single-node system as not an HA pair, and never as degraded', async () => {
    expect(await reported({ ['failover.status']: 'SINGLE' })).toEqual({
      status: 'SINGLE',
      ha_configured: false,
      node: null,
      failover_possible: null,
      failover_disabled_reasons: null,
      node_error: null,
      reasons_error: null,
    });
  });

  it('never asks a single-node system about a pair it is not part of', async () => {
    // The structural half of the criterion above: the reasons a single-node
    // system would give for being unable to fail over are never read, so there
    // is nothing that could be presented as a fault.
    const { ctx, call } = fakeSystem({ ['failover.status']: 'SINGLE' });
    await haStatus.handler(ctx, {});
    expect(call).toHaveBeenCalledTimes(1);
    expect(call).toHaveBeenCalledWith('failover.status');
  });

  it('reports a system that answered with no state as settling nothing', async () => {
    // Not false: nothing has placed this system outside a pair either, so the
    // fields that describe one are left unread rather than answered about a
    // pair that has not been shown to exist.
    for (const empty of ['', undefined]) {
      expect(await reported({ ['failover.status']: empty })).toEqual({
        status: null,
        ha_configured: null,
        node: null,
        failover_possible: null,
        failover_disabled_reasons: null,
        node_error: null,
        reasons_error: null,
      });
    }
  });

  it('fails the tool when the state itself cannot be read', async () => {
    // The one read with no partial answer behind it: every other field
    // describes a pair this system has not been shown to be part of.
    await expect(reported({}, { ['failover.status']: new Error('websocket closed') })).rejects.toThrow(
      'websocket closed',
    );
  });

  it('names a failed node read and still answers about the failover', async () => {
    expect(await reported({}, { ['failover.node']: new Error('node unreachable') })).toEqual({
      status: 'MASTER',
      ha_configured: true,
      node: null,
      failover_possible: true,
      failover_disabled_reasons: [],
      node_error: 'node unreachable',
      reasons_error: null,
    });
  });

  it('reports a pair that answered the node read with no node', async () => {
    expect(await reported({ ['failover.node']: 42 })).toMatchObject({
      node: null,
      node_error: null,
    });
  });

  it('does not read an unreadable reasons check as a working failover', async () => {
    expect(
      await reported({}, { ['failover.disabled.reasons']: new Error('peer did not answer') }),
    ).toMatchObject({
      failover_possible: null,
      failover_disabled_reasons: null,
      reasons_error: 'peer did not answer',
    });
  });

  it('does not read a non-list answer as nothing standing in the way', async () => {
    expect(await reported({ ['failover.disabled.reasons']: { reasons: [] } })).toMatchObject({
      failover_possible: null,
      failover_disabled_reasons: null,
      reasons_error: 'the system did not answer with a list of reasons',
    });
  });

  it('keeps a failover impossible when a reason it named could not be read', async () => {
    // The count is what answers `failover_possible`, not the list: dropping an
    // unreadable entry and then reading the shorter list as empty would turn
    // "something is wrong here" into "everything is fine".
    expect(
      await reported({ ['failover.disabled.reasons']: ['NO_VIP', '', 'NO_PONG'] }),
    ).toMatchObject({
      failover_possible: false,
      failover_disabled_reasons: ['NO_VIP', 'NO_PONG'],
      reasons_error: 'the system named 3 reasons and 1 could not be read',
    });
  });

  it('returns only the fields it names', async () => {
    // Not phrased as the "no field a later release adds" check the tools
    // reading object payloads carry: none of the three reads here answers with
    // an object, so there is nothing a middleware field could arrive on. What
    // holds the guarantee is the flat literal the handler builds, and this is
    // the assertion on it.
    expect(Object.keys(await reported())).toEqual([
      'status',
      'ha_configured',
      'node',
      'failover_possible',
      'failover_disabled_reasons',
      'node_error',
      'reasons_error',
    ]);
  });

  it('names a failure in whatever shape the transport rejected with', async () => {
    // The client rejects with whatever it was given, so each shape it documents
    // is read, and one it does not still has to read as a failure rather than
    // as "[object Object]".
    const named = async (failure: unknown): Promise<unknown> =>
      (await reported({}, { ['failover.node']: failure }))['node_error'];
    expect(await named(new Error(''))).toBe('the system reported no reason');
    expect(await named({ reason: 'middleware refused' })).toBe('middleware refused');
    expect(await named({ message: 'json-rpc refused' })).toBe('json-rpc refused');
    expect(await named({})).toBe('the system reported no reason');
    expect(await named('the transport gave a bare string')).toBe(
      'the transport gave a bare string',
    );
    expect(await named(42)).toBe('the system reported no reason');
    expect(await named(null)).toBe('the system reported no reason');
  });

  it('is read-only and takes no arguments', () => {
    expect(haStatus.mutating).toBe(false);
    expect(haStatus.requiredRole).toBe(Role.ReadOnly);
    expect(haStatus.inputSchema).toEqual({ type: 'object', properties: {} });
  });
});

describe('fleet_compliance_report', () => {
  /**
   * A fixed present, so a certificate's day count and the audit window are fixed
   * intervals rather than ones that move with the clock. Only `Date` is faked,
   * as in `certificates_list` and `audit_log_query`, both of which this report
   * reads through: they read the clock and nothing here schedules anything.
   */
  const NOW = 1_700_000_000_000; // 2023-11-14T22:13:20.000Z
  const DAY_MS = 24 * 60 * 60 * 1000;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** A validity date exactly this many whole days from {@link NOW}. */
  const inDays = (days: number): string => new Date(NOW + days * DAY_MS).toISOString();

  /** One audit entry as `audit.query` reports one, recorded a minute ago. */
  const entry = (over: Record<string, unknown> = {}) => ({
    audit_id: '5b4b1c9e-1f1e-4a3b-9f6a-2f0f0f0f0f0f',
    message_timestamp: 1_699_999_940,
    timestamp: { $date: NOW - 60_000 },
    username: 'alice',
    service: 'MIDDLEWARE',
    event: 'METHOD_CALL',
    event_data: { method: 'user.update', params: [1, { password: 'SECRET-PARAMETER-MATERIAL' }] },
    success: true,
    ...over,
  });

  /**
   * One certificate as `certificate.query` reports one, comfortably valid.
   * `privatekey` is here to be dropped: the test that no key material reaches
   * this report is only worth anything if some was there to reach it.
   */
  const cert = (over: Record<string, unknown> = {}) => ({
    id: 1,
    name: 'truenas_default',
    certificate: '-----BEGIN CERTIFICATE-----\nSECRET-CERTIFICATE-MATERIAL\n-----END-----',
    privatekey: '-----BEGIN PRIVATE KEY-----\nSECRET-PRIVATE-KEY-MATERIAL\n-----END-----',
    common: 'truenas.local',
    san: ['DNS:truenas.local'],
    from: inDays(-165),
    until: inDays(200),
    expired: false,
    issuer: 'Lets Encrypt',
    ...over,
  });

  /** The live join state, as `directoryservices.status` reports it. */
  const status = (over: Record<string, unknown> = {}) => ({
    type: 'ACTIVEDIRECTORY',
    status: 'HEALTHY',
    status_msg: null,
    ...over,
  });

  /** The join's configuration; `credential` carries a password to be dropped. */
  const config = (over: Record<string, unknown> = {}) => ({
    id: 1,
    service_type: 'ACTIVEDIRECTORY',
    credential: {
      credential_type: 'KERBEROS_USER',
      username: 'administrator',
      password: 'notarealbindsecret',
    },
    enable: true,
    kerberos_realm: 'EXAMPLE.COM',
    configuration: { hostname: 'nas', domain: 'example.com' },
    ...over,
  });

  /** An SMB share as `sharing.smb.query` reports one. */
  const smb = (over: Record<string, unknown> = {}) => ({
    id: 3,
    name: 'media',
    path: '/mnt/tank/media',
    enabled: true,
    comment: 'Films and music',
    options: { aapl_name_mangling: false },
    ...over,
  });

  /** An NFS export as `sharing.nfs.query` reports one. */
  const nfs = (over: Record<string, unknown> = {}) => ({
    id: 3,
    path: '/mnt/tank/backups',
    enabled: true,
    comment: 'Nightly backups',
    hosts: ['10.0.0.5'],
    networks: ['10.0.0.0/24'],
    ...over,
  });

  /** An `update.status` payload for a system that is already up to date. */
  const upToDate = () => ({
    code: 'NORMAL',
    error: null,
    status: { new_version: null, current_version: { train: 'TN-25.04' } },
  });

  /** Every method the five composed tools read, answering a system with nothing missing. */
  const readable = (
    over: Partial<Record<string, unknown>> = {},
  ): Partial<Record<string, unknown>> => ({
    ['audit.query']: [entry()],
    ['certificate.query']: [cert()],
    ['directoryservices.status']: status(),
    ['directoryservices.config']: config(),
    ['sharing.smb.query']: [smb()],
    ['sharing.nfs.query']: [nfs()],
    ['update.status']: upToDate(),
    ['system.version']: 'TrueNAS-25.04.0',
    ...over,
  });

  /** One section of the report; every one of them carries `unavailable`. */
  type Section = Record<string, unknown> & { unavailable: string | null };

  /** The report, typed loosely: the tool's own contract is an opaque object. */
  interface Report {
    system: string;
    unreadable: { system: string; section: string; detail: string }[];
    auditing: Section;
    certificates: Section;
    directory_service: Section;
    shares: Section;
    updates: Section;
  }

  const report = async (
    rows: Partial<Record<string, unknown>> = {},
    failures: Partial<Record<string, unknown>> = {},
  ): Promise<Report> => {
    const { ctx } = failingSystem(readable(rows), failures);
    return (await fleetComplianceReport.handler(ctx, {})) as unknown as Report;
  };

  it('reports the five sections and states no verdict of any kind', async () => {
    const result = await report();
    // The whole key set, asserted rather than sampled: the acceptance criterion
    // is that this report states no compliance VERDICT, and the way that fails
    // is a field appearing here that scores one.
    expect(Object.keys(result)).toEqual([
      'system',
      'unreadable',
      'auditing',
      'certificates',
      'directory_service',
      'shares',
      'updates',
    ]);
    expect(result.system).toBe('nas');
    expect(result.unreadable).toEqual([]);
  });

  it('reports the audit trail as evidence of recording rather than as the setting', async () => {
    const result = await report();
    expect(result.auditing).toEqual({
      unavailable: null,
      recording: true,
      entries_seen: 1,
      by_service: [{ service: 'MIDDLEWARE', count: 1 }],
      window_start: new Date(NOW - DAY_MS).toISOString(),
      truncated: false,
    });
  });

  it('counts audit entries per trail, busiest first and by name where level', async () => {
    const result = await report({
      ['audit.query']: [
        entry({ service: 'SMB' }),
        entry({ service: 'SUDO' }),
        entry({ service: 'MIDDLEWARE' }),
        entry({ service: 'MIDDLEWARE' }),
        entry({ service: null }),
      ],
    });
    expect(result.auditing['by_service']).toEqual([
      { service: 'MIDDLEWARE', count: 2 },
      { service: null, count: 1 },
      { service: 'SMB', count: 1 },
      { service: 'SUDO', count: 1 },
    ]);
    expect(result.auditing['entries_seen']).toBe(5);
  });

  it('does not establish recording from an empty trail, and says so', async () => {
    const result = await report({ ['audit.query']: [] });
    expect(result.auditing['recording']).toBeNull();
    expect(result.auditing['entries_seen']).toBe(0);
    expect(result.unreadable).toContainEqual({
      system: 'nas',
      section: 'auditing',
      detail:
        'the audit trail was read and held no entry inside the window, so whether this system ' +
        'records one is not established: a system nobody touched looks the same here as one ' +
        'that is not auditing at all',
    });
  });

  it('returns no audit entry itself, so no parameter material reaches the report', async () => {
    const result = await report();
    expect(JSON.stringify(result)).not.toContain('SECRET-PARAMETER-MATERIAL');
    expect(JSON.stringify(result)).not.toContain('alice');
  });

  it('counts certificates by expiry and lists only the ones that are not comfortably valid', async () => {
    const result = await report({
      ['certificate.query']: [
        cert({ name: 'valid', until: inDays(200) }),
        cert({ name: 'boundary', until: inDays(30) }),
        cert({ name: 'soon', until: inDays(5) }),
        // The system has not caught up with its own date, which is the other
        // direction the two can disagree in: the day count settles it.
        cert({ name: 'gone', until: inDays(-3), expired: false }),
        cert({ name: 'unreadable', until: 'the ides of March' }),
        cert({ name: 'just-outside', until: inDays(31) }),
      ],
    });
    // Listed worst first — expired, then the expiry that would not read, then
    // the two expiring soon in the order the system reported them — rather than
    // in the order above, so that the cap drops the least alarming lines.
    expect(result.certificates).toEqual({
      unavailable: null,
      reported: 6,
      expired: 1,
      expiring_soon: 2,
      expiry_unknown: 1,
      expiring_within_days: 30,
      entries: [
        {
          name: 'gone',
          common_name: 'truenas.local',
          not_after: inDays(-3),
          days_until_expiry: -3,
          expired: false,
        },
        {
          name: 'unreadable',
          common_name: 'truenas.local',
          not_after: 'the ides of March',
          days_until_expiry: null,
          expired: false,
        },
        {
          name: 'boundary',
          common_name: 'truenas.local',
          not_after: inDays(30),
          days_until_expiry: 30,
          expired: false,
        },
        {
          name: 'soon',
          common_name: 'truenas.local',
          not_after: inDays(5),
          days_until_expiry: 5,
          expired: false,
        },
      ],
      truncated: false,
    });
  });

  it('counts a certificate the system calls expired as expired, whatever its date says', async () => {
    const result = await report({
      // The two disagree: a clock that differs, or a date read differently.
      // Classifying on the day count alone drops it from the report entirely,
      // which is the one answer this section must never give.
      ['certificate.query']: [cert({ name: 'disputed', until: inDays(200), expired: true })],
    });
    expect(result.certificates['expired']).toBe(1);
    expect(result.certificates['entries']).toEqual([
      expect.objectContaining({ name: 'disputed', days_until_expiry: 200, expired: true }),
    ]);
  });

  it('places a certificate on its day count where the system gave no verdict', async () => {
    const result = await report({
      ['certificate.query']: [cert({ until: inDays(200), expired: 'probably' })],
    });
    expect(result.certificates['expired']).toBe(0);
    expect(result.certificates['expiring_soon']).toBe(0);
    expect(result.certificates['entries']).toEqual([]);
  });

  it('returns no certificate or private key material', async () => {
    const result = await report();
    expect(JSON.stringify(result)).not.toContain('SECRET-PRIVATE-KEY-MATERIAL');
    expect(JSON.stringify(result)).not.toContain('SECRET-CERTIFICATE-MATERIAL');
  });

  it('names a certificate whose expiry it could not read, in English at either count', async () => {
    const one = await report({ ['certificate.query']: [cert({ until: null })] });
    expect(one.unreadable).toContainEqual({
      system: 'nas',
      section: 'certificates',
      detail:
        '1 certificate reported no expiry date this report could read, so whether each is ' +
        'still valid is not established',
    });

    const two = await report({
      ['certificate.query']: [cert({ until: null }), cert({ until: 'soon-ish' })],
    });
    expect(two.unreadable).toContainEqual({
      system: 'nas',
      section: 'certificates',
      detail:
        '2 certificates reported no expiry date this report could read, so whether each is ' +
        'still valid is not established',
    });
  });

  it('caps the certificate list and says it did, without capping the counts', async () => {
    const result = await report({
      ['certificate.query']: Array.from({ length: 12 }, (_, index) =>
        cert({ name: `expiring-${index}`, until: inDays(1) }),
      ),
    });
    expect(result.certificates['reported']).toBe(12);
    expect(result.certificates['expiring_soon']).toBe(12);
    expect(result.certificates['entries']).toHaveLength(10);
    expect(result.certificates['truncated']).toBe(true);
  });

  it('keeps every expired certificate through a cap that drops expiring-soon ones', async () => {
    const result = await report({
      // The three that matter are reported LAST, so listing in reported order
      // would cap them out and leave a report whose entries name only
      // certificates that have not broken anything yet.
      ['certificate.query']: [
        ...Array.from({ length: 12 }, (_, index) =>
          cert({ name: `expiring-${index}`, until: inDays(1) }),
        ),
        cert({ name: 'lapsed', until: inDays(-3) }),
        cert({ name: 'unreadable', until: 'the ides of March' }),
        // Ranked on the system's own verdict, not on the 200 days beside it —
        // the same disagreement the counts are settled on.
        cert({ name: 'disputed', until: inDays(200), expired: true }),
      ],
    });
    const entries = result.certificates['entries'] as { name: string }[];
    expect(entries.map((entry) => entry.name).slice(0, 3)).toEqual([
      'lapsed',
      'disputed',
      'unreadable',
    ]);
    expect(entries).toHaveLength(10);
    expect(result.certificates['truncated']).toBe(true);
    // The ordering moved lines, not facts: every count is still over all 15.
    expect(result.certificates['reported']).toBe(15);
    expect(result.certificates['expired']).toBe(2);
    expect(result.certificates['expiring_soon']).toBe(12);
    expect(result.certificates['expiry_unknown']).toBe(1);
  });

  it('reports where identities come from, with no bind credential', async () => {
    const result = await report();
    expect(result.directory_service).toEqual({
      unavailable: null,
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
    expect(JSON.stringify(result)).not.toContain('notarealbindsecret');
  });

  it('identifies an LDAP directory by its server URLs, which have no domain', async () => {
    const result = await report({
      ['directoryservices.status']: status({ type: 'LDAP' }),
      ['directoryservices.config']: config({
        service_type: 'LDAP',
        configuration: { server_urls: ['ldaps://dc.example.com'] },
      }),
    });
    expect(result.directory_service['domain']).toBeNull();
    expect(result.directory_service['server_urls']).toEqual(['ldaps://dc.example.com']);
  });

  it('reports no server list at all rather than a partial one', async () => {
    const result = await report({
      ['directoryservices.status']: status({ type: 'LDAP' }),
      ['directoryservices.config']: config({
        service_type: 'LDAP',
        configuration: { server_urls: ['ldaps://dc.example.com', 42] },
      }),
    });
    // Not the one readable URL: an auditor asking where identities come from
    // would be told a narrower answer than the truth.
    expect(result.directory_service['server_urls']).toBeNull();
    // And the null is named, so it can be told from the Active Directory case
    // above, where the same null means the system carries no such list at all.
    expect(result.unreadable).toEqual([
      {
        system: 'nas',
        section: 'directory_service',
        detail:
          'the system named a list of directory servers holding an entry this report could ' +
          'not read, so which servers it binds to is not established — the readable part of ' +
          'it is not reported, because a partial list names a different set of servers',
      },
    ]);
  });

  it('does not establish what a system is joined to when the configuration read failed', async () => {
    const result = await report({}, { ['directoryservices.config']: new Error('permission denied') });
    expect(result.directory_service['config_error']).toBe('permission denied');
    expect(result.directory_service['enabled']).toBeNull();
    expect(result.unreadable).toContainEqual({
      system: 'nas',
      section: 'directory_service',
      detail:
        'the directory service configuration could not be read, so what this system is joined ' +
        'to is not established: permission denied',
    });
  });

  it('does not read a join with no state as one that works', async () => {
    const result = await report({ ['directoryservices.status']: status({ status: null }) });
    expect(result.directory_service['status']).toBeNull();
    expect(result.unreadable).toEqual([
      {
        system: 'nas',
        section: 'directory_service',
        detail:
          'the system reported no state for its directory service, so whether the join works ' +
          'is not established — which is not the same as a join that works',
      },
    ]);
  });

  it('does not read a configuration that would not say whether the service is on as off', async () => {
    const result = await report({ ['directoryservices.config']: config({ enable: 'sure' }) });
    expect(result.directory_service['enabled']).toBeNull();
    expect(result.directory_service['config_error']).toBeNull();
    expect(result.unreadable).toEqual([
      {
        system: 'nas',
        section: 'directory_service',
        detail:
          'the directory service configuration was read and did not say whether the service ' +
          'is switched on, so that is not established — which is not the same as switched off',
      },
    ]);
  });

  it('names a failed configuration read once, not twice for the fields it took down', async () => {
    const result = await report({}, { ['directoryservices.config']: new Error('permission denied') });
    // `enabled` is null here too, and the entry above already says why.
    expect(result.directory_service['enabled']).toBeNull();
    expect(result.unreadable).toHaveLength(1);
  });

  it('reports what is exposed and over which protocol, switched-on shares first', async () => {
    const result = await report({
      ['sharing.smb.query']: [
        smb({ id: 1, name: 'archive', enabled: false }),
        smb({ id: 2, name: 'scratch', enabled: 'yes' }),
        smb({ id: 3, name: 'media', enabled: true }),
      ],
      ['sharing.nfs.query']: [nfs({ id: 4, enabled: true })],
    });
    expect(result.shares).toEqual({
      unavailable: null,
      reported: 4,
      enabled: 2,
      disabled: 1,
      enablement_unknown: 1,
      by_protocol: [
        { protocol: 'NFS', count: 1 },
        { protocol: 'SMB', count: 3 },
      ],
      entries: [
        { protocol: 'SMB', id: 3, name: 'media', path: '/mnt/tank/media', enabled: true },
        { protocol: 'NFS', id: 4, name: null, path: '/mnt/tank/backups', enabled: true },
        { protocol: 'SMB', id: 2, name: 'scratch', path: '/mnt/tank/media', enabled: null },
        { protocol: 'SMB', id: 1, name: 'archive', path: '/mnt/tank/media', enabled: false },
      ],
      truncated: false,
    });
  });

  it('does not establish exposure for a share whose own switch would not read', async () => {
    const result = await report({
      ['sharing.smb.query']: [smb({ enabled: 'yes' }), smb({ id: 4, enabled: undefined })],
      ['sharing.nfs.query']: [],
    });
    expect(result.shares['enablement_unknown']).toBe(2);
    // Without this the section has a hole in it and `unreadable` is empty,
    // which the tool's own description offers as "every fact below was read".
    expect(result.unreadable).toEqual([
      {
        system: 'nas',
        section: 'shares',
        detail:
          '2 shares reported no switch this report could read, so whether each is exposed is ' +
          'not established',
      },
    ]);
  });

  it('reports no id for a share whose own id the system did not report as a number', async () => {
    const result = await report({
      ['sharing.smb.query']: [smb({ id: 'three' })],
      ['sharing.nfs.query']: [nfs({ id: Number.POSITIVE_INFINITY })],
    });
    expect(result.shares['entries']).toEqual([
      expect.objectContaining({ protocol: 'SMB', id: null }),
      expect.objectContaining({ protocol: 'NFS', id: null }),
    ]);
  });

  it('caps the share list and says it did, without capping the counts', async () => {
    const result = await report({
      ['sharing.smb.query']: Array.from({ length: 11 }, (_, index) =>
        smb({ id: index, name: `share-${index}` }),
      ),
    });
    expect(result.shares['reported']).toBe(12);
    expect(result.shares['entries']).toHaveLength(10);
    expect(result.shares['truncated']).toBe(true);
  });

  it('does not establish what one protocol exposes when its listing failed', async () => {
    const result = await report({}, { ['sharing.nfs.query']: new Error('NFS service is not running') });
    expect(result.shares['reported']).toBe(1);
    expect(result.unreadable).toContainEqual({
      system: 'nas',
      section: 'shares',
      detail:
        'no NFS share could be listed, so what this system exposes over it is not established: ' +
        'NFS service is not running',
    });
  });

  it('reports whether the system is patched, from two independent reads', async () => {
    const result = await report();
    expect(result.updates).toEqual({
      unavailable: null,
      update_available: false,
      current_version: 'TrueNAS-25.04.0',
      new_version: null,
      train: 'TN-25.04',
      check_error: null,
      version_error: null,
    });
  });

  it('does not establish update currency from a check that did not complete', async () => {
    const result = await report({
      ['update.status']: { code: 'ERROR', error: { reason: 'cannot reach the update server' }, status: null },
    });
    expect(result.updates['update_available']).toBeNull();
    expect(result.updates['current_version']).toBe('TrueNAS-25.04.0');
    expect(result.unreadable).toContainEqual({
      system: 'nas',
      section: 'updates',
      detail:
        'the update check did not complete, so whether this system is up to date is not ' +
        'established: cannot reach the update server',
    });
  });

  it('names a failed version read separately from a failed check', async () => {
    const result = await report({}, { ['system.version']: new Error('no version') });
    expect(result.updates['update_available']).toBe(false);
    expect(result.updates['current_version']).toBeNull();
    expect(result.unreadable).toEqual([
      {
        system: 'nas',
        section: 'updates',
        detail:
          'the running version could not be read, so what this system is on is not established: ' +
          'no version',
      },
    ]);
  });

  it('names a version read that worked and named no version', async () => {
    const result = await report({ ['system.version']: null });
    expect(result.updates['current_version']).toBeNull();
    expect(result.updates['version_error']).toBeNull();
    // The third case: not a failure, and not an answer either. Without this it
    // is the one hole in the report with nothing naming it.
    expect(result.unreadable).toEqual([
      {
        system: 'nas',
        section: 'updates',
        detail:
          'the system answered the version read without naming a version, so what it is ' +
          'running is not established',
      },
    ]);
  });

  it('states an unreadable section as unread rather than as nothing to report', async () => {
    const result = await report(
      {},
      {
        ['audit.query']: new Error('the audit dataset is not mounted'),
        ['certificate.query']: new Error('certificate query failed'),
        ['directoryservices.status']: new Error('directory service is down'),
        ['sharing.smb.query']: new Error('SMB is off'),
        ['sharing.nfs.query']: new Error('NFS is off'),
        ['update.status']: new Error('update check exploded'),
      },
    );
    expect(result.auditing).toEqual({
      unavailable: 'the audit dataset is not mounted',
      recording: null,
      entries_seen: null,
      by_service: null,
      window_start: null,
      truncated: null,
    });
    expect(result.certificates).toEqual({
      unavailable: 'certificate query failed',
      reported: null,
      expired: null,
      expiring_soon: null,
      expiry_unknown: null,
      expiring_within_days: null,
      entries: null,
      truncated: null,
    });
    expect(result.directory_service).toEqual({
      unavailable: 'directory service is down',
      service_type: null,
      status: null,
      status_message: null,
      enabled: null,
      domain: null,
      server_urls: null,
      kerberos_realm: null,
      credential_type: null,
      config_error: null,
    });
    expect(result.shares).toEqual({
      unavailable: 'no share could be listed: SMB: SMB is off; NFS: NFS is off',
      reported: null,
      enabled: null,
      disabled: null,
      enablement_unknown: null,
      by_protocol: null,
      entries: null,
      truncated: null,
    });
    expect(result.updates).toEqual({
      unavailable: 'update check exploded',
      update_available: null,
      current_version: null,
      new_version: null,
      train: null,
      check_error: null,
      version_error: null,
    });
    expect(result.unreadable.map((fact) => fact.section)).toEqual([
      'auditing',
      'certificates',
      'directory_service',
      'shares',
      'updates',
    ]);
    // Every one of them carries the system, so the lines stay attributable when
    // they are collected from several systems into one list.
    expect(result.unreadable.every((fact) => fact.system === 'nas')).toBe(true);
    expect(result.unreadable[0].detail).toBe(
      'the auditing section could not be read, so nothing in it is established: the audit ' +
        'dataset is not mounted',
    );
  });

  it('does not fail because one subsystem did', async () => {
    const result = await report({}, { ['certificate.query']: 'no certificate store' });
    expect(result.certificates['unavailable']).toBe('no certificate store');
    expect(result.updates['update_available']).toBe(false);
    expect(result.shares['reported']).toBe(2);
  });

  it('is read-only and takes no arguments', () => {
    expect(fleetComplianceReport.mutating).toBe(false);
    expect(fleetComplianceReport.requiredRole).toBe(Role.ReadOnly);
    expect(fleetComplianceReport.inputSchema).toEqual({ type: 'object', properties: {} });
  });
});

describe('fleet_health_rollup', () => {
  /** One leaf of a vdev tree, as `pool.query` nests it under `topology`. */
  const device = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    name: 'sda1',
    type: 'DISK',
    status: 'ONLINE',
    disk: 'sda',
    children: [],
    ...over,
  });

  /** One pool as `pool.query` reports it, feeding both pool reads of the health report. */
  const pool = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    name: 'tank',
    status: 'ONLINE',
    healthy: true,
    size: 1000,
    allocated: 100,
    free: 900,
    topology: { data: [device()] },
    ...over,
  });

  /** One alert as `alert.list` reports it. */
  const alert = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: '1',
    klass: 'ZpoolCapacityWarning',
    level: 'WARNING',
    formatted: 'tank is filling up',
    datetime: { $date: 0 },
    dismissed: false,
    ...over,
  });

  /** An `update.status` payload for a system that is already up to date. */
  const upToDate = (): Record<string, unknown> => ({
    code: 'NORMAL',
    error: null,
    status: { new_version: null, current_version: { train: 'TN-25.04' } },
  });

  /** Every method the composed health report reads, answering a healthy system. */
  const healthy = (
    over: Partial<Record<string, unknown>> = {},
  ): Partial<Record<string, unknown>> => ({
    ['pool.query']: [pool()],
    ['alert.list']: [],
    ['update.status']: upToDate(),
    ['system.version']: 'TrueNAS-25.04.0',
    ...over,
  });

  /** One system's row, typed loosely: the tool's own contract is an opaque object. */
  interface Row {
    system: string;
    verdict: string | null;
    needs_attention: boolean | null;
    reason_counts: { critical: number; warning: number; unknown: number; unranked: number };
    reasons_reported: number;
    reasons: { section: string; severity: string; detail: string }[];
    reasons_truncated: boolean;
    sections_total: number;
    sections_unreadable: number;
  }

  const rollup = async (
    rows: Partial<Record<string, unknown>> = {},
    failures: Partial<Record<string, unknown>> = {},
  ): Promise<Row> => {
    const { ctx } = failingSystem(healthy(rows), failures);
    return (await fleetHealthRollup.handler(ctx, {})) as unknown as Row;
  };

  it('answers a healthy system with one verdict and no section of the report', async () => {
    // The whole object, asserted rather than sampled: what this tool is for is
    // being SMALLER than `system_health_report`, and the way that fails is a
    // section of that report appearing here.
    expect(await rollup()).toEqual({
      system: 'nas',
      verdict: 'OK',
      needs_attention: false,
      reason_counts: { critical: 0, warning: 0, unknown: 0, unranked: 0 },
      reasons_reported: 0,
      reasons: [],
      reasons_truncated: false,
      sections_total: 4,
      sections_unreadable: 0,
    });
  });

  it('needs attention where something is already broken', async () => {
    const row = await rollup({ ['pool.query']: [pool({ healthy: false, status: 'DEGRADED' })] });
    expect(row.verdict).toBe('CRITICAL');
    expect(row.needs_attention).toBe(true);
    expect(row.reason_counts).toEqual({ critical: 1, warning: 0, unknown: 0, unranked: 0 });
  });

  it('needs attention where something needs fixing before it breaks', async () => {
    const row = await rollup({ ['pool.query']: [pool({ size: 100, allocated: 85 })] });
    expect(row.verdict).toBe('WARNING');
    expect(row.needs_attention).toBe(true);
    expect(row.reason_counts).toEqual({ critical: 0, warning: 1, unknown: 0, unranked: 0 });
  });

  it('does not answer needs_attention either way where the verdict is UNKNOWN', async () => {
    const row = await rollup({ ['pool.query']: [pool({ healthy: 'yes' })] });
    expect(row.verdict).toBe('UNKNOWN');
    // Null and NOT false: nothing about this system's health was established, and
    // a fleet filtered on `needs_attention === true` would read it as fine.
    expect(row.needs_attention).toBeNull();
    expect(row.reason_counts).toEqual({ critical: 0, warning: 0, unknown: 1, unranked: 0 });
  });

  it('names the worst reasons first and counts the ones it left out', async () => {
    const row = await rollup({
      ['pool.query']: [
        pool({ name: 'tank', healthy: false, status: 'DEGRADED' }),
        pool({ name: 'slow', size: 100, allocated: 85 }),
        pool({ name: 'odd', healthy: 'yes' }),
      ],
      ['alert.list']: [alert({ level: 'CRITICAL', formatted: 'a disk failed' })],
    });
    expect(row.verdict).toBe('CRITICAL');
    expect(row.reasons_reported).toBe(4);
    expect(row.reasons_truncated).toBe(true);
    // Worst first, and stable within a severity: the pools section's critical
    // finding stays ahead of the alerts section's, as the report ordered them.
    expect(row.reasons.map((reason) => [reason.section, reason.severity])).toEqual([
      ['pools', 'critical'],
      ['alerts', 'critical'],
      ['pools', 'warning'],
    ]);
    // The `unknown` finding fell off the list and is still in the counts, which
    // is the whole of why a fixed-size row is safe to act on.
    expect(row.reason_counts).toEqual({ critical: 2, warning: 1, unknown: 1, unranked: 0 });
  });

  it('counts a section of the report that could not be read at all', async () => {
    const row = await rollup({}, { ['alert.list']: new Error('the middleware is not answering') });
    expect(row.verdict).toBe('UNKNOWN');
    expect(row.needs_attention).toBeNull();
    expect(row.sections_unreadable).toBe(1);
    expect(row.reasons).toEqual([
      {
        section: 'alerts',
        severity: 'unknown',
        detail:
          'the alerts section could not be read, so nothing about it is established: the middleware is not answering',
      },
    ]);
  });

  it('answers for a system it could not reach, rather than leaving it out', async () => {
    const row = await rollup(
      {},
      {
        ['pool.query']: new Error('unreachable'),
        ['alert.list']: new Error('unreachable'),
        ['update.status']: new Error('unreachable'),
        ['system.version']: new Error('unreachable'),
      },
    );
    expect(row.verdict).toBe('UNKNOWN');
    expect(row.needs_attention).toBeNull();
    // Every section, and every one of them a finding — so the row says the
    // verdict rests on nothing rather than looking like a system with no
    // problems.
    expect(row.sections_unreadable).toBe(row.sections_total);
    expect(row.reason_counts).toEqual({ critical: 0, warning: 0, unknown: 4, unranked: 0 });
    expect(row.reasons_reported).toBe(4);
    expect(row.reasons_truncated).toBe(true);
  });

  it('counts every section the health report actually carries', async () => {
    const { ctx } = failingSystem(healthy());
    const report = (await systemHealthReport.handler(ctx, {})) as Record<string, unknown>;
    // A section of that report is exactly a field carrying an `unavailable` of
    // its own, which is the contract its own description states. Asserted against
    // the live report rather than against a list written twice: a fifth section
    // added there and not reached by this rollup fails here.
    const sections = Object.values(report).filter(
      (value) => typeof value === 'object' && value !== null && 'unavailable' in value,
    );
    expect(sections.length).toBeGreaterThan(0);
    expect((await rollup()).sections_total).toBe(sections.length);
  });

  it('is read-only and takes no arguments', () => {
    expect(fleetHealthRollup.mutating).toBe(false);
    expect(fleetHealthRollup.requiredRole).toBe(Role.ReadOnly);
    expect(fleetHealthRollup.inputSchema).toEqual({ type: 'object', properties: {} });
  });
});

describe('fleet_compliance_report — result guidance', () => {
  /**
   * The prose split (#131) is a text edit over a 10KB literal, and the first
   * attempt at it silently dropped two lines built from template literals with
   * all four CI jobs green — nothing in the repository asserted description
   * text, so nothing could catch it. These pin the two properties that would
   * have. Fifty-three more tools take the same edit.
   */
  it('carries guidance that is a verbatim slice of the description', () => {
    // While the two overlap this is the whole integrity check: any reflow that
    // reworded, rewrapped or dropped a line breaks it. The follow-up that
    // removes the text from `description` replaces this with the assertions
    // below, which stand on their own.
    expect(fleetComplianceReport.description).toContain(
      fleetComplianceReport.resultGuidance ?? '',
    );
  });

  it('states the expiry horizon and the entry cap, both interpolated', () => {
    // Exactly the two lines round one lost: each is a template literal, so a
    // pass that handles only quoted strings drops them and leaves prose that
    // still reads as a sentence.
    const guidance = fleetComplianceReport.resultGuidance ?? '';
    expect(guidance).toContain('`expiring_soon` how many have 30 days or fewer left');
    expect(guidance).toContain('are capped, at 10 entries each');
  });

  it('keeps the readings a caller cannot take from a value it does not have', () => {
    const guidance = fleetComplianceReport.resultGuidance ?? '';
    expect(guidance).toContain('A HOLE IS NEVER A PASS');
    expect(guidance).toContain('NULL IS NEVER "AUDITING IS OFF"');
    expect(guidance).toContain('NO CERTIFICATE OR PRIVATE KEY MATERIAL IS RETURNED');
  });

  it('leaves the no-verdict claim where a caller reads it before choosing', () => {
    // The one caveat that must NOT move: someone asking "are we compliant?"
    // has already chosen this tool by the time a result exists.
    expect(fleetComplianceReport.description).toContain(
      'THIS TOOL STATES NO COMPLIANCE VERDICT AND NEVER WILL',
    );
  });

  it('renders no stray escape into either field', () => {
    // Round one double-escaped apostrophes, which `--word-diff` cannot see:
    // backslashes fall outside its word regex.
    expect(fleetComplianceReport.description).not.toContain('\\');
    expect(fleetComplianceReport.resultGuidance).not.toContain('\\');
  });
});
