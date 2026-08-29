import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { of, throwError } from 'rxjs';
import { SystemHandle, ToolContext } from '@/catalog/tool';
import { FileContentError } from '@/content/file-content';
import { Role } from '@/interfaces';
import type { FileTail } from '@/interfaces';
import {
  alertSettings,
  alertsList,
  appsList,
  auditLogQuery,
  certificatesList,
  cloudCredentialsList,
  cloudsyncTasksList,
  createDefaultCatalog,
  createSnapshot,
  directoryServicesStatus,
  disksList,
  fleetComplianceReport,
  haStatus,
  iscsiList,
  listDatasets,
  networkConfig,
  networkInterfaces,
  nvmeofList,
  poolStatus,
  poolTopology,
  quotaReport,
  replicationStatus,
  reportingAppVmUsage,
  reportingDiskIo,
  reportingSpaceTrends,
  reportingUtilisation,
  scrubHistory,
  shareAccess,
  sharesList,
  snapshotsList,
  snapshotTasksList,
  systemHealthReport,
  tasksRecentRuns,
  updateStatus,
  usersList,
  vmLogs,
  vmsList,
} from '@/tools/index';

/**
 * A SystemHandle answering from a canned method→response map. Both seams are
 * stubbed from the same map: `call` for plain verbs, `query` for the client's
 * query helpers, which return the list directly rather than the union `call`
 * would. Tools pick whichever fits the verb, so a test asserts on whichever
 * spy that tool used.
 */
function fakeSystem(responses: Partial<Record<string, unknown>>): {
  ctx: ToolContext;
  call: ReturnType<typeof vi.fn>;
  query: ReturnType<typeof vi.fn>;
} {
  const call = vi.fn((method: string) => of(responses[method]));
  const query = vi.fn((method: string) => of(responses[method]));
  const system = { name: 'nas', client: { api: { call, query } } } as unknown as SystemHandle;
  return { ctx: { system }, call, query };
}

/**
 * A SystemHandle whose methods answer independently, either with rows or by
 * failing — `fakeSystem` answers every method from one map and has no way to
 * make a call fail, which the tools that read several methods and return a
 * partial answer are largely about.
 *
 * Both seams are stubbed from the same two maps, as `fakeSystem` stubs both
 * from its one: a tool picks `call` or `query` per verb, so a test asserts on
 * whichever spy its tool used and names its failures under the same method
 * either way.
 */
function failingSystem(
  rows: Partial<Record<string, unknown>>,
  failures: Partial<Record<string, unknown>> = {},
): { ctx: ToolContext; query: ReturnType<typeof vi.fn>; call: ReturnType<typeof vi.fn> } {
  const answer = (method: string) =>
    method in failures ? throwError(() => failures[method]) : of(rows[method]);
  const query = vi.fn(answer);
  const call = vi.fn(answer);
  const system = { name: 'nas', client: { api: { query, call } } } as unknown as SystemHandle;
  return { ctx: { system }, query, call };
}

describe('createDefaultCatalog', () => {
  it('registers the thirty-seven sketch tools', () => {
    expect(createDefaultCatalog().list(Role.Full).map((t) => t.name)).toEqual([
      'system_info',
      'system_update_status',
      'audit_log_query',
      'storage_pool_status',
      'storage_pool_topology',
      'storage_scrub_history',
      'storage_list_datasets',
      'datasets_quota_report',
      'disks_list',
      'apps_list',
      'vms_list',
      'vm_logs',
      'alerts_list',
      'snapshots_list',
      'replication_status',
      'snapshot_tasks_list',
      'cloudsync_tasks_list',
      'tasks_recent_runs',
      'shares_list',
      'share_access',
      'iscsi_list',
      'nvmeof_list',
      'users_list',
      'directory_services_status',
      'network_interfaces',
      'network_config',
      'certificates_list',
      'cloud_credentials_list',
      'alert_settings',
      'reporting_utilisation',
      'reporting_disk_io',
      'reporting_space_trends',
      'reporting_app_vm_usage',
      'ha_status',
      'system_health_report',
      'fleet_compliance_report',
      'snapshots_create',
    ]);
  });

  it('advertises fleet_compliance_report to a read-only credential', () => {
    expect(createDefaultCatalog().list(Role.ReadOnly).map((t) => t.name)).toContain(
      'fleet_compliance_report',
    );
  });

  it('advertises system_health_report to a read-only credential', () => {
    expect(createDefaultCatalog().list(Role.ReadOnly).map((t) => t.name)).toContain(
      'system_health_report',
    );
  });

  it('advertises ha_status to a read-only credential', () => {
    expect(createDefaultCatalog().list(Role.ReadOnly).map((t) => t.name)).toContain('ha_status');
  });

  it('advertises reporting_utilisation to a read-only credential', () => {
    expect(createDefaultCatalog().list(Role.ReadOnly).map((t) => t.name)).toContain(
      'reporting_utilisation',
    );
  });

  it('advertises reporting_disk_io to a read-only credential', () => {
    expect(createDefaultCatalog().list(Role.ReadOnly).map((t) => t.name)).toContain(
      'reporting_disk_io',
    );
  });

  it('advertises reporting_space_trends to a read-only credential', () => {
    expect(createDefaultCatalog().list(Role.ReadOnly).map((t) => t.name)).toContain(
      'reporting_space_trends',
    );
  });

  it('advertises reporting_app_vm_usage to a read-only credential', () => {
    expect(createDefaultCatalog().list(Role.ReadOnly).map((t) => t.name)).toContain(
      'reporting_app_vm_usage',
    );
  });

  it('advertises system_update_status to a read-only credential', () => {
    expect(createDefaultCatalog().list(Role.ReadOnly).map((t) => t.name)).toContain(
      'system_update_status',
    );
  });

  it('advertises audit_log_query to a read-only credential', () => {
    expect(createDefaultCatalog().list(Role.ReadOnly).map((t) => t.name)).toContain(
      'audit_log_query',
    );
  });

  it('advertises alert_settings to a read-only credential', () => {
    expect(createDefaultCatalog().list(Role.ReadOnly).map((t) => t.name)).toContain(
      'alert_settings',
    );
  });

  it('advertises cloud_credentials_list to a read-only credential', () => {
    expect(createDefaultCatalog().list(Role.ReadOnly).map((t) => t.name)).toContain(
      'cloud_credentials_list',
    );
  });

  it('advertises certificates_list to a read-only credential', () => {
    expect(createDefaultCatalog().list(Role.ReadOnly).map((t) => t.name)).toContain(
      'certificates_list',
    );
  });

  it('advertises alerts_list to a read-only credential', () => {
    expect(createDefaultCatalog().list(Role.ReadOnly).map((t) => t.name)).toContain('alerts_list');
  });

  it('advertises disks_list to a read-only credential', () => {
    expect(createDefaultCatalog().list(Role.ReadOnly).map((t) => t.name)).toContain('disks_list');
  });

  it('advertises vms_list to a read-only credential', () => {
    expect(createDefaultCatalog().list(Role.ReadOnly).map((t) => t.name)).toContain('vms_list');
  });

  it('advertises vm_logs to a read-only credential', () => {
    expect(createDefaultCatalog().list(Role.ReadOnly).map((t) => t.name)).toContain('vm_logs');
  });

  it('advertises apps_list to a read-only credential', () => {
    expect(createDefaultCatalog().list(Role.ReadOnly).map((t) => t.name)).toContain('apps_list');
  });

  it('advertises storage_pool_topology to a read-only credential', () => {
    expect(createDefaultCatalog().list(Role.ReadOnly).map((t) => t.name)).toContain(
      'storage_pool_topology',
    );
  });

  it('advertises storage_scrub_history to a read-only credential', () => {
    expect(createDefaultCatalog().list(Role.ReadOnly).map((t) => t.name)).toContain(
      'storage_scrub_history',
    );
  });

  it('advertises datasets_quota_report to a read-only credential', () => {
    expect(createDefaultCatalog().list(Role.ReadOnly).map((t) => t.name)).toContain(
      'datasets_quota_report',
    );
  });

  it('advertises snapshots_list to a read-only credential', () => {
    expect(createDefaultCatalog().list(Role.ReadOnly).map((t) => t.name)).toContain(
      'snapshots_list',
    );
  });

  it('advertises replication_status to a read-only credential', () => {
    expect(createDefaultCatalog().list(Role.ReadOnly).map((t) => t.name)).toContain(
      'replication_status',
    );
  });

  it('advertises snapshot_tasks_list to a read-only credential', () => {
    expect(createDefaultCatalog().list(Role.ReadOnly).map((t) => t.name)).toContain(
      'snapshot_tasks_list',
    );
  });

  it('advertises cloudsync_tasks_list to a read-only credential', () => {
    expect(createDefaultCatalog().list(Role.ReadOnly).map((t) => t.name)).toContain(
      'cloudsync_tasks_list',
    );
  });

  it('advertises tasks_recent_runs to a read-only credential', () => {
    expect(createDefaultCatalog().list(Role.ReadOnly).map((t) => t.name)).toContain(
      'tasks_recent_runs',
    );
  });

  it('advertises shares_list to a read-only credential', () => {
    expect(createDefaultCatalog().list(Role.ReadOnly).map((t) => t.name)).toContain('shares_list');
  });

  it('advertises share_access to a read-only credential', () => {
    expect(createDefaultCatalog().list(Role.ReadOnly).map((t) => t.name)).toContain('share_access');
  });

  it('advertises iscsi_list to a read-only credential', () => {
    expect(createDefaultCatalog().list(Role.ReadOnly).map((t) => t.name)).toContain('iscsi_list');
  });

  it('advertises nvmeof_list to a read-only credential', () => {
    expect(createDefaultCatalog().list(Role.ReadOnly).map((t) => t.name)).toContain('nvmeof_list');
  });

  it('advertises users_list to a read-only credential', () => {
    expect(createDefaultCatalog().list(Role.ReadOnly).map((t) => t.name)).toContain('users_list');
  });

  it('advertises directory_services_status to a read-only credential', () => {
    expect(createDefaultCatalog().list(Role.ReadOnly).map((t) => t.name)).toContain(
      'directory_services_status',
    );
  });

  it('advertises network_interfaces to a read-only credential', () => {
    expect(createDefaultCatalog().list(Role.ReadOnly).map((t) => t.name)).toContain(
      'network_interfaces',
    );
  });

  it('advertises network_config to a read-only credential', () => {
    expect(createDefaultCatalog().list(Role.ReadOnly).map((t) => t.name)).toContain(
      'network_config',
    );
  });
});

describe('system_update_status', () => {
  /** `update.status` as the middleware sends it on a system with an update. */
  const report = (over: Record<string, unknown> = {}) => ({
    code: 'NORMAL',
    status: {
      current_version: {
        train: 'TrueNAS-SCALE-Fangtooth',
        profile: 'GENERAL',
        matches_profile: true,
      },
      new_version: {
        version: '25.04.1',
        manifest: {},
        release_notes: null,
        release_notes_url: 'https://example.invalid/notes',
      },
    },
    error: null,
    update_download_progress: null,
    ...over,
  });

  /** The status of a check that reached the update server and found nothing. */
  const upToDate = () => report({ status: { ...report().status, new_version: null } });

  const reported = async (
    rows: Partial<Record<string, unknown>> = {},
    failures: Partial<Record<string, unknown>> = {},
  ): Promise<Record<string, unknown>> => {
    const { ctx } = failingSystem(
      {
        ['update.status']: report(),
        ['system.version']: 'TrueNAS-SCALE-25.04.0',
        ...rows,
      },
      failures,
    );
    return (await updateStatus.handler(ctx, {})) as Record<string, unknown>;
  };

  it('reports the candidate version, the train and the running version', async () => {
    expect(await reported()).toEqual({
      update_available: true,
      current_version: 'TrueNAS-SCALE-25.04.0',
      new_version: '25.04.1',
      train: 'TrueNAS-SCALE-Fangtooth',
      check_error: null,
      version_error: null,
    });
  });

  it('reports a system already up to date as an explicit no', async () => {
    // Not an empty result: false is an answer, and it is the answer that has to
    // stay distinct from the null below.
    expect(await reported({ ['update.status']: upToDate() })).toEqual({
      update_available: false,
      current_version: 'TrueNAS-SCALE-25.04.0',
      new_version: null,
      train: 'TrueNAS-SCALE-Fangtooth',
      check_error: null,
      version_error: null,
    });
  });

  it('distinguishes a check that could not run from a system with no update', async () => {
    expect(
      await reported({
        ['update.status']: report({
          code: 'ERROR',
          status: null,
          error: { errname: 'ENETUNREACH', reason: 'could not reach the update server' },
        }),
      }),
    ).toEqual({
      // Null rather than false: nothing has been established about this system.
      update_available: null,
      // The version read is separate and is unaffected by the failed check.
      current_version: 'TrueNAS-SCALE-25.04.0',
      new_version: null,
      train: null,
      check_error: 'could not reach the update server',
      version_error: null,
    });
  });

  it('does not read a status the system sent beside its own error', async () => {
    // `code` is the system's verdict on its own check. A status behind an
    // `ERROR` may be stale, and reporting it would answer "up to date" for a
    // system that was never successfully asked.
    expect(await reported({ ['update.status']: report({ code: 'ERROR' }) })).toMatchObject({
      update_available: null,
      new_version: null,
      train: null,
      check_error: 'the system reported no reason',
    });
  });

  it('names the error name where the failure carried no reason', async () => {
    expect(
      await reported({
        ['update.status']: report({
          code: 'ERROR',
          status: null,
          error: { errname: 'ENOTCONN', reason: '' },
        }),
      }),
    ).toMatchObject({ update_available: null, check_error: 'ENOTCONN' });
  });

  it('reports a check that failed while saying nothing as a failure', async () => {
    expect(
      await reported({
        ['update.status']: report({
          code: 'ERROR',
          status: null,
          error: { errname: '', reason: '' },
        }),
      }),
    ).toMatchObject({ update_available: null, check_error: 'the system reported no reason' });
  });

  it('reports a system that answered normally with no status at all', async () => {
    // Nothing went wrong that the system admits to, and there is still no
    // answer in the payload — which is not "no update available".
    expect(await reported({ ['update.status']: report({ status: null }) })).toMatchObject({
      update_available: null,
      check_error: 'the system reported no update status',
    });
  });

  it('reports a train the system sent as empty as null', async () => {
    expect(
      await reported({
        ['update.status']: report({
          status: { ...report().status, current_version: { train: '' } },
        }),
      }),
    ).toMatchObject({ update_available: true, train: null });
  });

  it('reports a candidate the system named with no version as null', async () => {
    // Still an update available: the system said there is one, and only its
    // name is missing.
    expect(
      await reported({
        ['update.status']: report({
          status: { ...report().status, new_version: { version: '' } },
        }),
      }),
    ).toMatchObject({ update_available: true, new_version: null });
  });

  it('keeps the update answer when the running version could not be read', async () => {
    expect(
      await reported({}, { ['system.version']: new Error('connection reset') }),
    ).toMatchObject({
      update_available: true,
      new_version: '25.04.1',
      current_version: null,
      version_error: 'connection reset',
    });
  });

  it('names a version failure however the client rejected', async () => {
    const reasons: [unknown, string][] = [
      [{ reason: 'system.version failed' }, 'system.version failed'],
      [{ message: 'connection reset' }, 'connection reset'],
      ['ENOTCONN', 'ENOTCONN'],
      [new Error(''), 'the system reported no reason'],
      [{ code: 42 }, 'the system reported no reason'],
      [null, 'the system reported no reason'],
    ];
    for (const [reason, expected] of reasons) {
      expect((await reported({}, { ['system.version']: reason }))['version_error']).toBe(expected);
    }
  });

  it('reports a version the system sent as empty as null, and not as a failure', async () => {
    expect(await reported({ ['system.version']: '' })).toMatchObject({
      current_version: null,
      version_error: null,
    });
  });

  it('returns no field a later release adds', async () => {
    const result = await reported({
      ['update.status']: report({
        future_field: 'added by a later release',
        status: {
          ...report().status,
          future_field: 'added by a later release',
        },
      }),
    });
    expect(Object.keys(result)).toEqual([
      'update_available',
      'current_version',
      'new_version',
      'train',
      'check_error',
      'version_error',
    ]);
    expect(JSON.stringify(result)).not.toContain('added by a later release');
  });

  it('never mutates: it checks for an update and does not apply one', async () => {
    const { ctx, call } = failingSystem({
      ['update.status']: report(),
      ['system.version']: 'TrueNAS-SCALE-25.04.0',
    });
    await updateStatus.handler(ctx, {});
    expect(call.mock.calls.map((args) => args[0])).toEqual(['update.status', 'system.version']);
  });
});

describe('audit_log_query', () => {
  /**
   * A fixed present, so the default window is a fixed interval rather than one
   * that moves with the clock. Only `Date` is faked, as in `tasks_recent_runs`:
   * the tool reads the clock and nothing here schedules anything.
   */
  const NOW = 1_700_000_000_000; // 2023-11-14T22:13:20.000Z
  /** NOW minus the tool's 24-hour default window. */
  const WINDOW_START = NOW - 24 * 60 * 60 * 1000; // 2023-11-13T22:13:20.000Z

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * An audit entry as `audit.query` reports one, recorded a minute ago.
   *
   * `address`, `session`, `service_data` and the whole of `event_data` beyond
   * the method are here to be dropped, and the password among the parameters is
   * a real string for the same reason a job's arguments carry one in
   * `tasks_recent_runs`: the test that no secret survives is only worth
   * anything if one was there to survive.
   */
  const entry = (over: Record<string, unknown> = {}) => ({
    audit_id: '5b4b1c9e-1f1e-4a3b-9f6a-2f0f0f0f0f0f',
    message_timestamp: 1_699_999_940,
    timestamp: { $date: NOW - 60_000 },
    address: '10.0.0.5',
    username: 'alice',
    session: 'a5f0c2d1',
    service: 'MIDDLEWARE',
    service_data: { vers: { major: 25, minor: 4 }, origin: '10.0.0.5:54321' },
    event: 'METHOD_CALL',
    event_data: {
      method: 'user.update',
      params: [1, { password: 'SECRET-PARAMETER-MATERIAL' }],
      description: 'Update user alice',
      authenticated: true,
      authorized: true,
    },
    success: true,
    ...over,
  });

  /** The whole result, for the fields around the entries. */
  const queried = async (
    rows: unknown,
    args: Record<string, unknown> = {},
  ): Promise<{
    entries: Record<string, unknown>[];
    truncated: boolean;
    limit: number;
    since: string;
  }> => {
    const { ctx } = fakeSystem({ ['audit.query']: rows });
    return (await auditLogQuery.handler(ctx, args)) as {
      entries: Record<string, unknown>[];
      truncated: boolean;
      limit: number;
      since: string;
    };
  };

  /** Just the entries. */
  const listed = async (
    rows: unknown[],
    args: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>[]> => (await queried(rows, args)).entries;

  /** One entry, differing only in the fields the case is about. */
  const one = async (over: Record<string, unknown>): Promise<Record<string, unknown>> =>
    (await listed([entry(over)]))[0];

  it('reports when, who, which service, which method and whether it worked', async () => {
    expect(await listed([entry()])).toEqual([
      {
        timestamp: '2023-11-14T22:12:20.000Z',
        user: 'alice',
        service: 'MIDDLEWARE',
        event: 'METHOD_CALL',
        method: 'user.update',
        success: true,
      },
    ]);
  });

  it('states the bound and the window it applied', async () => {
    expect(await queried([entry()])).toMatchObject({
      truncated: false,
      limit: 100,
      since: '2023-11-13T22:13:20.000Z',
    });
  });

  it('returns an empty list, not an error, when nothing matched', async () => {
    // The window it was taken from comes back with it, so an empty result is
    // readable as "nothing in the last day" rather than as "nothing ever".
    expect(await queried([])).toEqual({
      entries: [],
      truncated: false,
      limit: 100,
      since: '2023-11-13T22:13:20.000Z',
    });
  });

  it('returns no address, session, parameters or field a later release adds', async () => {
    const result = await one({ future_field: 'added by a later release' });
    expect(Object.keys(result)).toEqual([
      'timestamp',
      'user',
      'service',
      'event',
      'method',
      'success',
    ]);
    expect(JSON.stringify(result)).not.toContain('added by a later release');
    expect(JSON.stringify(result)).not.toContain('10.0.0.5');
    expect(JSON.stringify(result)).not.toContain('a5f0c2d1');
  });

  it('never returns the parameters an audited call was made with', async () => {
    expect(JSON.stringify(await listed([entry()]))).not.toContain('SECRET-PARAMETER-MATERIAL');
  });

  it('reads the method out of the event data, and nothing else of it', async () => {
    expect(await one({ event_data: { method: 'pool.dataset.delete' } })).toMatchObject({
      method: 'pool.dataset.delete',
    });
    // An event that is not a call, one whose data names no method, and one
    // whose data is not a record at all: each is a null method beside an
    // `event` that still says what kind of entry it is.
    expect(await one({ event: 'AUTHENTICATION', event_data: null })).toMatchObject({
      event: 'AUTHENTICATION',
      method: null,
    });
    expect(await one({ event_data: { description: 'no method here' } })).toMatchObject({
      method: null,
    });
    expect(await one({ event_data: { method: '' } })).toMatchObject({ method: null });
    expect(await one({ event_data: 'METHOD_CALL' })).toMatchObject({ method: null });
  });

  it('reports an outcome the system did not record as null, not as a failure', async () => {
    expect(await one({ success: false })).toMatchObject({ success: false });
    expect(await one({ success: null })).toMatchObject({ success: null });
    expect(await one({ success: 'true' })).toMatchObject({ success: null });
  });

  it('reports a user, service or event the system sent as empty as null', async () => {
    expect(await one({ username: '', service: null, event: 42 })).toMatchObject({
      user: null,
      service: null,
      event: null,
    });
  });

  it('reads a recorded time however the middleware spelled it', async () => {
    const spellings: [unknown, string | null][] = [
      [{ $date: NOW - 60_000 }, '2023-11-14T22:12:20.000Z'],
      [NOW - 60_000, '2023-11-14T22:12:20.000Z'],
      ['2023-11-14T22:12:20Z', '2023-11-14T22:12:20.000Z'],
      ['2023-11-14T22:12Z', '2023-11-14T22:12:00.000Z'],
      ['2023-11-14T22:12:20.123456', '2023-11-14T22:12:20.123Z'],
      ['2023-11-14 22:12:20', '2023-11-14T22:12:20.000Z'],
      ['2023-11-15T00:12:20+02:00', '2023-11-14T22:12:20.000Z'],
      ['2023-11-14T20:12:20-02:00', '2023-11-14T22:12:20.000Z'],
      ['2023-11-14', '2023-11-14T00:00:00.000Z'],
      // Not a time this tool reads, and each would be a confidently wrong
      // instant if it were guessed at.
      ['14/11/2023 22:12', null],
      ['2023-11-31T00:00:00Z', null],
      ['2023-11-14T25:00:00Z', null],
      ['2023-11-14T22:99:00Z', null],
      ['2023-11-14T22:12:99Z', null],
      ['2023-11-14T22:12:20+99:00', null],
      ['2023-11-14T22:12:20-00:99', null],
      ['0050-11-14T22:12:20Z', null],
      [Number.NaN, null],
      [8.64e15 + 1, null],
      [{ $date: 'yesterday' }, null],
      [true, null],
      [null, null],
    ];
    for (const [timestamp, expected] of spellings) {
      // Every case is inside the default window or unreadable, so none is
      // dropped by it and each reaches the assertion.
      expect((await one({ timestamp }))['timestamp']).toBe(expected);
    }
  });

  it('bounds the result to the last 24 hours when nothing is asked for', async () => {
    const rows = [
      entry({ timestamp: { $date: WINDOW_START + 1 }, event_data: { method: 'inside' } }),
      entry({ timestamp: { $date: WINDOW_START - 1 }, event_data: { method: 'outside' } }),
      // Exactly at the bound is inside it: the window is "at or after".
      entry({ timestamp: { $date: WINDOW_START }, event_data: { method: 'at-the-bound' } }),
    ];
    expect((await listed(rows)).map((row) => row['method'])).toEqual(['inside', 'at-the-bound']);
  });

  it('keeps an entry whose recorded time could not be read, under any window', async () => {
    // Nothing places it outside the window, and an action disappearing because
    // its timestamp was unreadable is the failure worth avoiding.
    expect(await listed([entry({ timestamp: 'not a time' })], { since: '2023-11-14' })).toEqual([
      expect.objectContaining({ timestamp: null }),
    ]);
  });

  it('takes the window from `since` when it is given', async () => {
    const rows = [
      entry({ timestamp: { $date: WINDOW_START - 1000 }, event_data: { method: 'older' } }),
      entry({ timestamp: { $date: NOW - 1000 }, event_data: { method: 'newer' } }),
    ];
    // A day before the default window start, so the older entry is now inside.
    expect((await listed(rows, { since: '2023-11-12' })).map((row) => row['method'])).toEqual([
      'newer',
      'older',
    ]);
    expect((await listed(rows, { since: '2023-11-14T22:00:00Z' })).map((row) => row['method'])).toEqual(
      ['newer'],
    );
  });

  it('reads a `since` given without a timezone as UTC, not as this machine\'s zone', async () => {
    expect((await queried([], { since: '2023-11-14 22:00:00' })).since).toBe(
      '2023-11-14T22:00:00.000Z',
    );
    expect((await queried([], { since: '2023-11-14T22:00:00+02:00' })).since).toBe(
      '2023-11-14T20:00:00.000Z',
    );
  });

  it('refuses a `since` it cannot read rather than falling back to the default', async () => {
    // Ignoring it would answer about the last day while the caller believes it
    // asked about the last month.
    for (const since of ['', 'yesterday', '2023-02-30', '2023-11-14T25:00:00Z', 1_700_000_000]) {
      await expect(queried([], { since })).rejects.toThrow('"since" must be an ISO 8601');
    }
  });

  it('narrows to one user, and asks the system to narrow too', async () => {
    const { ctx, call } = fakeSystem({ ['audit.query']: [entry()] });
    await auditLogQuery.handler(ctx, { user: 'alice' });
    expect(call.mock.calls[0][0]).toBe('audit.query');
    expect(call.mock.calls[0][1][0]).toMatchObject({
      'query-filters': [['username', '=', 'alice']],
      'query-options': { limit: 101, order_by: ['-message_timestamp'] },
    });
  });

  it('checks the user filter again on what came back', async () => {
    // An unrecognised query parameter is dropped rather than refused, so a
    // middleware that did not apply the filter would otherwise answer about
    // every account while looking exactly like an answer about one.
    const rows = [entry(), entry({ username: 'bob' }), entry({ username: '' })];
    expect((await listed(rows, { user: 'alice' })).map((row) => row['user'])).toEqual(['alice']);
  });

  it('checks the service filter again on what came back', async () => {
    const rows = [entry(), entry({ service: 'SMB' }), entry({ service: null })];
    expect((await listed(rows, { service: 'SMB' })).map((row) => row['service'])).toEqual(['SMB']);
  });

  it('names the trail to search only where the client lists it', async () => {
    const { ctx, call } = fakeSystem({ ['audit.query']: [] });
    await auditLogQuery.handler(ctx, { service: 'SMB' });
    expect(call.mock.calls[0][1][0]).toMatchObject({
      services: ['SMB'],
      'query-filters': [['service', '=', 'SMB']],
    });
    // A service a later release adds is still asked for through the filter,
    // which is untyped, rather than refused.
    const later = fakeSystem({ ['audit.query']: [] });
    await auditLogQuery.handler(later.ctx, { service: 'NFS' });
    expect(later.call.mock.calls[0][1][0]).not.toHaveProperty('services');
    expect(later.call.mock.calls[0][1][0]).toMatchObject({
      'query-filters': [['service', '=', 'NFS']],
    });
  });

  it('refuses a filter it cannot read', async () => {
    await expect(queried([], { user: '' })).rejects.toThrow('"user" must be a non-empty string');
    await expect(queried([], { service: 7 })).rejects.toThrow(
      '"service" must be a non-empty string',
    );
    // Absent is not unreadable, and is what the unfiltered result is for.
    expect(await listed([entry()], { user: null, service: undefined })).toHaveLength(1);
  });

  it('orders the entries newest first, with an unreadable time last', async () => {
    const rows = [
      entry({ timestamp: { $date: NOW - 3000 }, event_data: { method: 'middle' } }),
      entry({ timestamp: 'not a time', event_data: { method: 'unplaced' } }),
      entry({ timestamp: { $date: NOW - 1000 }, event_data: { method: 'newest' } }),
      entry({ timestamp: null, event_data: { method: 'also-unplaced' } }),
      entry({ timestamp: { $date: NOW - 5000 }, event_data: { method: 'oldest' } }),
    ];
    // Two entries neither of which can be placed keep the order the system sent
    // them in, rather than being reordered against each other on nothing.
    expect((await listed(rows)).map((row) => row['method'])).toEqual([
      'newest',
      'middle',
      'oldest',
      'unplaced',
      'also-unplaced',
    ]);
  });

  it('bounds the result at 100 and says so, dropping the oldest of what matched', async () => {
    // 101 entries, a second apart and shuffled, so the bound has to be applied
    // after the ordering for the oldest to be the one that goes.
    const rows = Array.from({ length: 101 }, (unused, index) =>
      entry({
        timestamp: { $date: NOW - index * 1000 },
        event_data: { method: `call-${index}` },
      }),
    ).reverse();
    const result = await queried(rows);
    expect(result.truncated).toBe(true);
    expect(result.entries).toHaveLength(100);
    expect(result.entries[0]['method']).toBe('call-0');
    expect(result.entries.map((row) => row['method'])).not.toContain('call-100');
  });

  it('is not truncated by entries the window itself removed', async () => {
    // 101 entries, all but two of them older than the window: the system held
    // more than fit, and no more MATCHED than fit.
    const rows = Array.from({ length: 101 }, (unused, index) =>
      entry({ timestamp: { $date: index < 2 ? NOW - index * 1000 : WINDOW_START - 1000 } }),
    );
    const result = await queried(rows);
    expect(result.truncated).toBe(false);
    expect(result.entries).toHaveLength(2);
  });

  it('reports truncation it cannot rule out when the system ignored a filter', async () => {
    // 101 entries in the window, of which the system should have returned only
    // the two matching ones and returned every one instead: the entries it
    // sent in place of the ones it filtered out stand between this result and
    // however many further matches lie beyond the bound, and nothing here can
    // count them.
    const rows = Array.from({ length: 101 }, (unused, index) =>
      entry({ timestamp: { $date: NOW - index * 1000 }, username: index < 2 ? 'alice' : 'bob' }),
    );
    const result = await queried(rows, { user: 'alice' });
    expect(result.entries).toHaveLength(2);
    expect(result.truncated).toBe(true);
    // The same ignored filter over a trail that fitted whole is not truncated:
    // everything the system holds was seen, whoever it belonged to.
    expect((await queried(rows.slice(0, 100), { user: 'alice' })).truncated).toBe(false);
  });

  it('refuses an answer that is not a list of entries', async () => {
    // `count: true` answers a number and `get: true` a single entry. Neither is
    // asked for, and an empty result would read as an answer about the trail.
    for (const answer of [3, entry(), null, undefined]) {
      await expect(queried(answer)).rejects.toThrow(
        'audit.query did not answer with a list of audit entries',
      );
    }
  });

  it('fails rather than answering empty when the trail could not be read', async () => {
    // An empty list is an answer about the trail — nothing matched — and a
    // trail that could not be read is not that answer.
    const { ctx } = failingSystem({}, { ['audit.query']: new Error('audit dataset not mounted') });
    await expect(auditLogQuery.handler(ctx, {})).rejects.toThrow('audit dataset not mounted');
  });

  it('never mutates: it reads the trail and nothing else', async () => {
    const { ctx, call, query } = fakeSystem({ ['audit.query']: [entry()] });
    await auditLogQuery.handler(ctx, {});
    expect(call.mock.calls.map((args) => args[0])).toEqual(['audit.query']);
    expect(query).not.toHaveBeenCalled();
  });
});

describe('storage_pool_status', () => {
  it('trims pool.query to health and capacity', async () => {
    const { ctx } = fakeSystem({
      ['pool.query']: [
        { name: 'tank', status: 'ONLINE', healthy: true, size: 100, allocated: 40, free: 60 },
      ],
    });
    expect(await poolStatus.handler(ctx, {})).toEqual([
      {
        name: 'tank',
        status: 'ONLINE',
        healthy: true,
        size_bytes: 100,
        allocated_bytes: 40,
        free_bytes: 60,
      },
    ]);
  });
});

/** The shape `storage_pool_topology` returns, for the assertions below. */
interface MappedDevice {
  name: string | null;
  type: string | null;
  status: string | null;
  disk: string | null;
  devices: MappedDevice[];
}
interface MappedVdev extends MappedDevice {
  category: string;
}
interface MappedPool {
  name: string;
  status: string;
  vdevs: MappedVdev[];
}

describe('storage_pool_topology', () => {
  // Every property a topology node carries, so the assertions below show what
  // the tool drops as well as what it keeps. `stats` is the bulky one — the
  // middleware repeats that block on every node of a tree with one leaf per
  // disk in the system — and `path`, `guid`, `device` and `unavail_disk` are
  // here to be dropped alongside it.
  const node = (over: Record<string, unknown>) => ({
    name: 'sda2',
    type: 'DISK',
    path: '/dev/disk/by-partuuid/11111111-2222-3333-4444-555555555555',
    guid: '12345678901234567890',
    status: 'ONLINE',
    stats: {
      timestamp: 1756000000000000000,
      read_errors: 0,
      write_errors: 0,
      checksum_errors: 0,
      ops: [0, 1, 2, 3, 4, 5],
      bytes: [0, 1, 2, 3, 4, 5],
      size: 4000787030016,
      allocated: 1000000000,
      fragmentation: 3,
    },
    children: [],
    device: 'sda2',
    disk: 'sda',
    unavail_disk: null,
    ...over,
  });

  /** A vdev that groups devices: no disk of its own, members underneath. */
  const group = (over: Record<string, unknown>) =>
    node({ type: 'MIRROR', path: null, device: null, disk: null, ...over });

  /** A node from a middleware that did not send one of the keys read here. */
  const without = (key: string, row: Record<string, unknown>): Record<string, unknown> => {
    const copy = { ...row };
    delete copy[key];
    return copy;
  };

  const pool = (topology: unknown, over: Record<string, unknown> = {}) => ({
    id: 1,
    name: 'tank',
    guid: '1',
    status: 'ONLINE',
    healthy: true,
    size: 100,
    allocated: 40,
    free: 60,
    topology,
    ...over,
  });

  /** A full topology, with the five categories a plain pool leaves empty. */
  const topologyOf = (over: Record<string, unknown>) => ({
    data: [],
    special: [],
    dedup: [],
    log: [],
    cache: [],
    spare: [],
    ...over,
  });

  it('maps each vdev to its members, keeping the tree', async () => {
    const { ctx, query } = fakeSystem({
      ['pool.query']: [
        pool(
          topologyOf({
            data: [
              group({
                name: 'mirror-0',
                children: [node({ name: 'sda2', disk: 'sda' }), node({ name: 'sdb2', disk: 'sdb' })],
              }),
            ],
          }),
        ),
      ],
    });
    expect(await poolTopology.handler(ctx, {})).toEqual([
      {
        name: 'tank',
        status: 'ONLINE',
        vdevs: [
          {
            category: 'data',
            name: 'mirror-0',
            type: 'MIRROR',
            status: 'ONLINE',
            disk: null,
            devices: [
              { name: 'sda2', type: 'DISK', status: 'ONLINE', disk: 'sda', devices: [] },
              { name: 'sdb2', type: 'DISK', status: 'ONLINE', disk: 'sdb', devices: [] },
            ],
          },
        ],
      },
    ]);
    // `topology` is part of a pool row as it stands, so the tool asks for the
    // pool list with no filters and no options.
    expect(query.mock.calls).toEqual([['pool.query']]);
  });

  it('labels cache, log and spare vdevs rather than folding them in with data', async () => {
    const { ctx } = fakeSystem({
      ['pool.query']: [
        pool(
          topologyOf({
            data: [group({ name: 'raidz1-0', type: 'RAIDZ1' })],
            special: [group({ name: 'mirror-1' })],
            dedup: [group({ name: 'mirror-2' })],
            log: [node({ name: 'nvme0n1p1', disk: 'nvme0n1' })],
            cache: [node({ name: 'nvme1n1p1', disk: 'nvme1n1' })],
            // A spare that has not been called on reports AVAIL, not ONLINE.
            spare: [node({ name: 'sdz2', disk: 'sdz', status: 'AVAIL' })],
          }),
        ),
      ],
    });
    const [result] = (await poolTopology.handler(ctx, {})) as MappedPool[];
    expect(result.vdevs.map((v) => [v.category, v.name, v.status])).toEqual([
      ['data', 'raidz1-0', 'ONLINE'],
      ['special', 'mirror-1', 'ONLINE'],
      ['dedup', 'mirror-2', 'ONLINE'],
      ['log', 'nvme0n1p1', 'ONLINE'],
      ['cache', 'nvme1n1p1', 'ONLINE'],
      ['spare', 'sdz2', 'AVAIL'],
    ]);
  });

  it('names the failed device by status, on the device and on the vdev above it', async () => {
    // The question the tool exists for: the pool says DEGRADED, and the answer
    // to "which device" has to be reachable by filtering a field rather than by
    // reading prose.
    const { ctx } = fakeSystem({
      ['pool.query']: [
        pool(
          topologyOf({
            data: [
              group({
                name: 'mirror-0',
                status: 'DEGRADED',
                children: [
                  node({ name: 'sda2', disk: 'sda' }),
                  node({ name: 'sdf2', disk: 'sdf', status: 'FAULTED' }),
                ],
              }),
            ],
          }),
          { status: 'DEGRADED', healthy: false },
        ),
      ],
    });
    const [result] = (await poolTopology.handler(ctx, {})) as MappedPool[];
    expect(result.status).toBe('DEGRADED');
    const failed = result.vdevs.flatMap((v) => v.devices).filter((d) => d.status !== 'ONLINE');
    expect(failed).toEqual([
      { name: 'sdf2', type: 'DISK', status: 'FAULTED', disk: 'sdf', devices: [] },
    ]);
  });

  it('gives a null disk for a device the middleware cannot resolve, key or no key', async () => {
    // A pulled disk is reported as a leaf with `disk: null` and the identifier
    // moved to `unavail_disk`, which this tool drops; an older middleware sends
    // no `disk` key at all. Both are the state the description calls a null,
    // and an absent key would serialize to no key rather than to one — so the
    // second device is the one that fails if the mapping stops normalizing.
    const { ctx } = fakeSystem({
      ['pool.query']: [
        pool(
          topologyOf({
            data: [
              group({
                name: 'mirror-0',
                status: 'DEGRADED',
                children: [
                  node({
                    name: 'sdf2',
                    status: 'REMOVED',
                    disk: null,
                    unavail_disk: { guid: '9999', dev: 'sdf2' },
                  }),
                  without('disk', node({ name: 'sdg2', status: 'UNAVAIL' })),
                ],
              }),
            ],
          }),
          { status: 'DEGRADED', healthy: false },
        ),
      ],
    });
    const [result] = (await poolTopology.handler(ctx, {})) as MappedPool[];
    const [mirror] = result.vdevs;
    expect(mirror.devices).toEqual([
      { name: 'sdf2', type: 'DISK', status: 'REMOVED', disk: null, devices: [] },
      { name: 'sdg2', type: 'DISK', status: 'UNAVAIL', disk: null, devices: [] },
    ]);
    // Expecting null above is what enforces the normalization: `toEqual` reads
    // an absent key and an undefined one alike, so a `disk` that stopped being
    // normalized would arrive as undefined and fail against that null. These
    // two say the same thing more plainly — `Object.keys` lists a key holding
    // undefined as well, so the first is the weaker of them.
    expect(Object.keys(mirror.devices[1])).toContain('disk');
    expect(mirror.devices[1].disk).toBeNull();
  });

  it('nests a replacement beneath the mirror rather than beside its members', async () => {
    // Mid-resilver the middleware reports a `replacing` vdev holding both the
    // outgoing and the incoming disk. Flattened, the mirror would read as
    // having three members and no indication which two are the same slot.
    const { ctx } = fakeSystem({
      ['pool.query']: [
        pool(
          topologyOf({
            data: [
              group({
                name: 'mirror-0',
                status: 'DEGRADED',
                children: [
                  node({ name: 'sda2', disk: 'sda' }),
                  group({
                    name: 'replacing-1',
                    type: 'REPLACING',
                    status: 'DEGRADED',
                    children: [
                      node({ name: 'sdf2', disk: 'sdf', status: 'FAULTED' }),
                      node({ name: 'sdg2', disk: 'sdg' }),
                    ],
                  }),
                ],
              }),
            ],
          }),
        ),
      ],
    });
    const [result] = (await poolTopology.handler(ctx, {})) as MappedPool[];
    const [mirror] = result.vdevs;
    expect(mirror.devices.map((d) => [d.name, d.type, d.devices.map((c) => c.disk)])).toEqual([
      ['sda2', 'DISK', []],
      ['replacing-1', 'REPLACING', ['sdf', 'sdg']],
    ]);
  });

  it('surfaces neither the per-vdev statistics nor a field a later release adds', async () => {
    const { ctx } = fakeSystem({
      ['pool.query']: [
        pool(
          topologyOf({
            data: [
              group({
                name: 'mirror-0',
                children: [node({ future_field: 'added by a later TrueNAS release' })],
              }),
            ],
            // A vdev category a later release adds is dropped whole: the tool
            // walks the six roles it names, not the payload's own keys.
            future_category: [node({ name: 'sdx2', disk: 'sdx' })],
          }),
          { future_field: 'added by a later TrueNAS release' },
        ),
      ],
    });
    const [result] = (await poolTopology.handler(ctx, {})) as Record<string, unknown>[];
    expect(Object.keys(result)).toEqual(['name', 'status', 'vdevs']);
    const vdevs = result['vdevs'] as MappedVdev[];
    // The category a later release adds is dropped whole, rather than carried
    // through as a second vdev alongside the mirror: the tool walks the six
    // roles it names, not the payload's own keys.
    expect(vdevs.map((v) => v.category)).toEqual(['data']);
    const [vdev] = vdevs;
    expect(Object.keys(vdev)).toEqual(['category', 'name', 'type', 'status', 'disk', 'devices']);
    expect(Object.keys(vdev.devices[0])).toEqual(['name', 'type', 'status', 'disk', 'devices']);
  });

  it('reports a pool with no topology, and one whose keys are absent', async () => {
    // `topology` is null on a pool the middleware could not read the layout of;
    // a middleware older than a category omits its key, and one that reports a
    // leaf without `children` or without `status` omits those. None is an
    // error, and none may take the rest of the pools down with it: an omitted
    // field is reported as null, so the caller meets the shape the description
    // promised with a value missing rather than a key missing.
    const { ctx } = fakeSystem({
      ['pool.query']: [
        pool(null, { name: 'unimported' }),
        pool(
          { data: [without('status', without('children', node({ name: 'sda2', disk: 'sda' })))] },
          { name: 'stripe' },
        ),
      ],
    });
    const results = (await poolTopology.handler(ctx, {})) as MappedPool[];
    expect(results).toEqual([
      { name: 'unimported', status: 'ONLINE', vdevs: [] },
      {
        name: 'stripe',
        status: 'ONLINE',
        vdevs: [
          {
            category: 'data',
            name: 'sda2',
            type: 'DISK',
            status: null,
            disk: 'sda',
            devices: [],
          },
        ],
      },
    ]);
    // Expecting null rather than undefined above is what catches a dropped
    // `status`: `toEqual` reads an absent key and an undefined one alike, so
    // an unnormalized field fails against that null. This restates it in the
    // terms the caller sees — the key is present in the response object.
    expect(Object.keys(results[1].vdevs[0])).toContain('status');
  });

  it('returns [] for a system with no pools', async () => {
    const { ctx } = fakeSystem({ ['pool.query']: [] });
    expect(await poolTopology.handler(ctx, {})).toEqual([]);
  });
});

describe('storage_scrub_history', () => {
  // Every field a scan record carries, so the assertions below show what the
  // tool drops as well as what it keeps. `bytes_to_process`, `bytes_processed`,
  // `bytes_issued`, `percentage` and `total_secs_left` are the progress
  // counters, and are here to be dropped: they describe how far a scrub got,
  // where this tool answers what it found and how long ago.
  const scan = (over: Record<string, unknown>) => ({
    function: 'SCRUB',
    state: 'FINISHED',
    start_time: '2026-08-20T01:00:00+00:00',
    end_time: '2026-08-20T04:30:00+00:00',
    percentage: 100,
    bytes_to_process: 4000787030016,
    bytes_processed: 4000787030016,
    bytes_issued: 4000787030016,
    pause: null,
    errors: 0,
    total_secs_left: null,
    ...over,
  });

  const pool = (over: Record<string, unknown>) => ({
    id: 1,
    name: 'tank',
    status: 'ONLINE',
    healthy: true,
    // Present on every pool the system is reading, and null on one it is not.
    topology: { data: [{ name: 'sda2', type: 'DISK' }] },
    scan: scan({}),
    ...over,
  });

  /** A pool or scan row from a middleware that did not send one of the keys. */
  const without = (key: string, row: Record<string, unknown>): Record<string, unknown> => {
    const copy = { ...row };
    delete copy[key];
    return copy;
  };

  it('reports the outcome and age of the last finished scrub', async () => {
    const { ctx, query } = fakeSystem({ ['pool.query']: [pool({})] });
    expect(await scrubHistory.handler(ctx, {})).toEqual([
      {
        pool: 'tank',
        state: 'FINISHED',
        started_at: '2026-08-20T01:00:00+00:00',
        finished_at: '2026-08-20T04:30:00+00:00',
        duration_seconds: 12600,
        errors: 0,
      },
    ]);
    // `scan` is part of a pool row as it stands, so the tool asks for the pool
    // list with no filters and no options.
    expect(query.mock.calls).toEqual([['pool.query']]);
  });

  it('keeps a scrub that found errors apart from a clean one', async () => {
    const { ctx } = fakeSystem({
      ['pool.query']: [
        pool({ name: 'tank' }),
        pool({ name: 'vault', scan: scan({ errors: 3 }) }),
      ],
    });
    const result = (await scrubHistory.handler(ctx, {})) as Record<string, unknown>[];
    expect(result.map((p) => [p['pool'], p['errors']])).toEqual([
      ['tank', 0],
      ['vault', 3],
    ]);
  });

  it('distinguishes a scrub in progress from a finished one', async () => {
    // A running scrub has no end time, so it has no duration either — the
    // alternative is a duration measured against now, which would read as a
    // finished scrub of that length.
    const { ctx } = fakeSystem({
      ['pool.query']: [pool({ scan: scan({ state: 'SCANNING', end_time: null, percentage: 40 }) })],
    });
    expect(await scrubHistory.handler(ctx, {})).toEqual([
      {
        pool: 'tank',
        state: 'SCANNING',
        started_at: '2026-08-20T01:00:00+00:00',
        finished_at: null,
        duration_seconds: null,
        errors: 0,
      },
    ]);
  });

  it('distinguishes a paused scrub from one that is still running', async () => {
    // ZFS reports a paused scrub as SCANNING with the time it was paused, and
    // it stays that way until someone resumes it. Reported as SCANNING it
    // would read as a verification in progress when nothing is progressing.
    const { ctx } = fakeSystem({
      ['pool.query']: [
        pool({ name: 'running', scan: scan({ state: 'SCANNING', end_time: null }) }),
        pool({
          name: 'paused',
          scan: scan({
            state: 'SCANNING',
            end_time: null,
            pause: '2026-08-20T02:00:00+00:00',
          }),
        }),
      ],
    });
    const result = (await scrubHistory.handler(ctx, {})) as Record<string, unknown>[];
    expect(result.map((p) => [p['pool'], p['state']])).toEqual([
      ['running', 'SCANNING'],
      ['paused', 'PAUSED'],
    ]);
  });

  it('reports a cancelled scrub as CANCELED rather than as a completed one', async () => {
    const { ctx } = fakeSystem({
      ['pool.query']: [
        pool({
          scan: scan({ state: 'CANCELED', end_time: '2026-08-20T01:30:00+00:00', percentage: 12 }),
        }),
      ],
    });
    const [result] = (await scrubHistory.handler(ctx, {})) as Record<string, unknown>[];
    expect(result['state']).toBe('CANCELED');
    expect(result['duration_seconds']).toBe(1800);
  });

  it('reports a pool that has never been scanned instead of omitting it', async () => {
    // An absent pool reads as a pool with nothing wrong, and never-scrubbed is
    // the finding this tool exists for. `scan` is null on a pool ZFS has never
    // scanned; an older middleware sends no `scan` key at all.
    const { ctx } = fakeSystem({
      ['pool.query']: [
        pool({ name: 'fresh', scan: null }),
        without('scan', pool({ name: 'silent' })),
      ],
    });
    expect(await scrubHistory.handler(ctx, {})).toEqual([
      {
        pool: 'fresh',
        state: 'NEVER_SCRUBBED',
        started_at: null,
        finished_at: null,
        duration_seconds: null,
        errors: null,
      },
      {
        pool: 'silent',
        state: 'NEVER_SCRUBBED',
        started_at: null,
        finished_at: null,
        duration_seconds: null,
        errors: null,
      },
    ]);
  });

  it('does not present the resilver that replaced a scrub as a scrub', async () => {
    // A pool records one scan, so a resilver overwrites the scrub before it.
    // Passing its times and error count through would report a scrub that
    // never ran — and on a pool that resilvered because a disk failed, which
    // is exactly when a stale scrub matters most.
    const { ctx } = fakeSystem({
      ['pool.query']: [
        pool({
          scan: scan({
            function: 'RESILVER',
            end_time: '2026-08-27T09:00:00+00:00',
            errors: 5,
          }),
        }),
      ],
    });
    expect(await scrubHistory.handler(ctx, {})).toEqual([
      {
        pool: 'tank',
        state: 'UNKNOWN',
        started_at: null,
        finished_at: null,
        duration_seconds: null,
        errors: null,
      },
    ]);
  });

  it('does not claim a pool the system is not reading has never been scrubbed', async () => {
    // A pool that is not imported carries no topology and no scan, and the
    // missing scan is then an absence of evidence: the record it would be read
    // from is not there. Reported as NEVER_SCRUBBED it would raise the one
    // alarm this tool exists to raise, about a pool nobody can answer for.
    // The second pool is the same case carrying a stale scan anyway: the
    // record cannot be read as current, so the state and the four fields agree
    // that nothing is known rather than reporting a scrub the state denies.
    const { ctx } = fakeSystem({
      ['pool.query']: [
        pool({ name: 'exported', topology: null, scan: null }),
        pool({ name: 'stale', topology: null }),
      ],
    });
    expect(await scrubHistory.handler(ctx, {})).toEqual([
      {
        pool: 'exported',
        state: 'UNKNOWN',
        started_at: null,
        finished_at: null,
        duration_seconds: null,
        errors: null,
      },
      {
        pool: 'stale',
        state: 'UNKNOWN',
        started_at: null,
        finished_at: null,
        duration_seconds: null,
        errors: null,
      },
    ]);
  });

  it('normalizes a scan whose keys the middleware did not send', async () => {
    // An omitted field is reported as null, so the caller meets the shape the
    // description promised with a value missing rather than a key missing.
    // A scrub with no state of its own is still a scrub on record, so its
    // times and error count stand: a null state says only that ZFS's own word
    // for the outcome is missing, where UNKNOWN says the scrub is unreadable.
    const { ctx } = fakeSystem({
      ['pool.query']: [
        pool({
          scan: without('errors', without('state', without('start_time', scan({})))),
        }),
      ],
    });
    const results = (await scrubHistory.handler(ctx, {})) as Record<string, unknown>[];
    expect(results).toEqual([
      {
        pool: 'tank',
        state: null,
        started_at: null,
        finished_at: '2026-08-20T04:30:00+00:00',
        duration_seconds: null,
        errors: null,
      },
    ]);
    // Expecting null above is what enforces the normalization: `toEqual`
    // reads an absent key and an undefined one alike, so a field that stopped
    // being normalized would arrive as undefined and fail against that null.
    // The keys below restate it in the terms the caller sees, and are the
    // weaker of the two — `Object.keys` lists a key holding undefined as well.
    expect(Object.keys(results[0])).toContain('started_at');
    expect(Object.keys(results[0])).toContain('errors');
    expect(Object.keys(results[0])).toContain('state');
  });

  it('gives no duration for a timestamp it cannot read', async () => {
    // The middleware's own types call these strings, so a value that is not a
    // timestamp is a shape this tool was not told about. It yields no duration
    // rather than a NaN the caller would have to detect.
    const { ctx } = fakeSystem({
      ['pool.query']: [
        pool({ name: 'bad-start', scan: scan({ start_time: 'not a timestamp' }) }),
        pool({ name: 'bad-end', scan: scan({ end_time: 'not a timestamp' }) }),
      ],
    });
    const result = (await scrubHistory.handler(ctx, {})) as Record<string, unknown>[];
    expect(result.map((p) => [p['pool'], p['duration_seconds']])).toEqual([
      ['bad-start', null],
      ['bad-end', null],
    ]);
  });

  it('surfaces neither the progress counters nor a field a later release adds', async () => {
    const { ctx } = fakeSystem({
      ['pool.query']: [
        pool({
          scan: scan({ future_field: 'added by a later TrueNAS release' }),
          future_field: 'added by a later TrueNAS release',
        }),
      ],
    });
    const [result] = (await scrubHistory.handler(ctx, {})) as Record<string, unknown>[];
    expect(Object.keys(result)).toEqual([
      'pool',
      'state',
      'started_at',
      'finished_at',
      'duration_seconds',
      'errors',
    ]);
  });

  it('returns [] for a system with no pools', async () => {
    const { ctx } = fakeSystem({ ['pool.query']: [] });
    expect(await scrubHistory.handler(ctx, {})).toEqual([]);
  });
});

describe('storage_list_datasets', () => {
  const dataset = (id: string, children: unknown[] = []) => ({
    id,
    pool: 'tank',
    type: 'FILESYSTEM',
    mountpoint: `/mnt/${id}`,
    used: { parsed: 10 },
    available: { parsed: 90 },
    children,
  });

  it('does not duplicate datasets nested under children of other entries', async () => {
    // pool.dataset.query returns every dataset as a top-level entry while each
    // entry also nests its descendants under `children`.
    const { ctx } = fakeSystem({
      ['pool.dataset.query']: [
        dataset('tank', [dataset('tank/media', [dataset('tank/media/movies')])]),
        dataset('tank/media', [dataset('tank/media/movies')]),
        dataset('tank/media/movies'),
      ],
    });
    const result = (await listDatasets.handler(ctx, {})) as { id: string }[];
    expect(result.map((d) => d.id)).toEqual(['tank', 'tank/media', 'tank/media/movies']);
  });

  it('passes a pool filter to the query', async () => {
    const { ctx, query } = fakeSystem({ ['pool.dataset.query']: [] });
    await listDatasets.handler(ctx, { pool: 'tank' });
    // The query helper takes filters and options as separate arguments, where
    // `call` took one positional params tuple.
    expect(query).toHaveBeenCalledWith(
      'pool.dataset.query',
      [['pool', '=', 'tank']],
      { extra: { retrieve_children: true, properties: ['used', 'available'] } },
    );
  });
});

describe('datasets_quota_report', () => {
  // Deliberately asymmetric: `used` against `quota` and `referenced` against
  // `refquota` give 25% and 50%, and every other pairing of the four gives
  // neither — so a test that passes has paired each limit with the usage ZFS
  // actually caps with it rather than with the other one.
  const dataset = (over: Record<string, unknown> = {}) => ({
    id: 'tank/media',
    pool: 'tank',
    type: 'FILESYSTEM',
    mountpoint: '/mnt/tank/media',
    used: { parsed: 75 },
    referenced: { parsed: 20 },
    quota: { parsed: 300 },
    refquota: { parsed: 40 },
    children: [],
    ...over,
  });

  /** A row from a system that did not report one of the properties at all. */
  const without = (row: Record<string, unknown>, key: string): Record<string, unknown> => {
    const copy = { ...row };
    delete copy[key];
    return copy;
  };

  const rowsFrom = async (
    datasets: unknown[],
    args: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>[]> => {
    const { ctx } = fakeSystem({ ['pool.dataset.query']: datasets });
    return (await quotaReport.handler(ctx, args)) as Record<string, unknown>[];
  };

  it('pairs each limit with the usage it caps', async () => {
    expect(await rowsFrom([dataset()])).toEqual([
      {
        id: 'tank/media',
        pool: 'tank',
        quota_bytes: 300,
        used_bytes: 75,
        quota_used_percent: 25,
        refquota_bytes: 40,
        referenced_bytes: 20,
        refquota_used_percent: 50,
      },
    ]);
  });

  it('surfaces no field a later release adds', async () => {
    const [row] = await rowsFrom([
      dataset({ future_field: 'added by a later TrueNAS release' }),
    ]);
    expect(Object.keys(row)).toEqual([
      'id',
      'pool',
      'quota_bytes',
      'used_bytes',
      'quota_used_percent',
      'refquota_bytes',
      'referenced_bytes',
      'refquota_used_percent',
    ]);
  });

  it('reports a dataset with no quota as 0, and one whose quota is unreadable as null', async () => {
    // The distinction the tool exists for: the first is unconstrained, the
    // second may already be over a limit that cannot be seen.
    const [none, unreadable] = await rowsFrom([
      dataset({ id: 'tank/none', quota: { parsed: 0 } }),
      without(dataset({ id: 'tank/unreadable' }), 'quota'),
    ]);
    expect(none['quota_bytes']).toBe(0);
    expect(unreadable['quota_bytes']).toBeNull();
    // Neither yields a percentage, and for different reasons — nothing is a
    // percentage of unlimited, and nothing is a percentage of unknown.
    expect(none['quota_used_percent']).toBeNull();
    expect(unreadable['quota_used_percent']).toBeNull();
  });

  it('reads an explicitly null limit as no limit rather than as unreadable', async () => {
    // The client types the same field `number | (0 | null)`, so null is ZFS
    // spelling "no limit" the other of its two ways — in either position.
    const [nullParsed, nullProperty] = await rowsFrom([
      dataset({ id: 'tank/a', refquota: { parsed: null } }),
      dataset({ id: 'tank/b', refquota: null }),
    ]);
    expect(nullParsed['refquota_bytes']).toBe(0);
    expect(nullProperty['refquota_bytes']).toBe(0);
    expect(nullParsed['refquota_used_percent']).toBeNull();
    expect(nullProperty['refquota_used_percent']).toBeNull();
  });

  it('treats a property carrying no parsed value as unreadable', async () => {
    const [row] = await rowsFrom([dataset({ quota: {}, refquota: { parsed: 'unlimited' } })]);
    expect(row['quota_bytes']).toBeNull();
    expect(row['refquota_bytes']).toBeNull();
  });

  it('survives a limit the middleware sends as a bare value rather than a property', async () => {
    // The row is `unknown` at this seam, and a primitive would throw on the
    // `in` test that looks for `parsed` — taking the whole report down with it
    // rather than losing the one field it could not read.
    const [row] = await rowsFrom([dataset({ quota: 12345, refquota: 'none' })]);
    expect(row['quota_bytes']).toBeNull();
    expect(row['refquota_bytes']).toBeNull();
    // The rest of the row still stands.
    expect(row['used_bytes']).toBe(75);
  });

  it('reports an unreadable usage as null rather than as nothing used', async () => {
    const [row] = await rowsFrom([dataset({ used: { parsed: Number.NaN }, referenced: {} })]);
    expect(row['used_bytes']).toBeNull();
    expect(row['referenced_bytes']).toBeNull();
    expect(row['quota_used_percent']).toBeNull();
    expect(row['refquota_used_percent']).toBeNull();
  });

  it('states a percentage to one decimal place', async () => {
    const [row] = await rowsFrom([dataset({ used: { parsed: 1 }, quota: { parsed: 3 } })]);
    expect(row['quota_used_percent']).toBe(33.3);
  });

  it('does not cap a percentage at 100', async () => {
    // A refquota lowered below what the dataset already references. Capping it
    // would hide exactly the dataset this tool is asked to find.
    const [row] = await rowsFrom([dataset({ referenced: { parsed: 60 }, refquota: { parsed: 40 } })]);
    expect(row['refquota_used_percent']).toBe(150);
  });

  it('does not duplicate datasets nested under children of other entries', async () => {
    // pool.dataset.query returns every dataset as a top-level entry while each
    // entry also nests its descendants under `children`.
    const child = dataset({ id: 'tank/media/movies' });
    const rows = await rowsFrom([dataset({ id: 'tank/media', children: [child] }), child]);
    expect(rows.map((row) => row['id'])).toEqual(['tank/media', 'tank/media/movies']);
  });

  it('returns every dataset when no threshold is given', async () => {
    const rows = await rowsFrom([
      dataset({ id: 'tank/idle' }),
      dataset({ id: 'tank/none', quota: { parsed: 0 }, refquota: { parsed: 0 } }),
    ]);
    expect(rows.map((row) => row['id'])).toEqual(['tank/idle', 'tank/none']);
  });

  it('keeps a dataset at or above the threshold on either limit', async () => {
    const rows = await rowsFrom(
      [
        // 25% of quota, 50% of refquota — kept on the refquota alone.
        dataset({ id: 'tank/refquota-only' }),
        // 90% of quota, no refquota — kept on the quota alone.
        dataset({ id: 'tank/quota-only', used: { parsed: 90 }, quota: { parsed: 100 }, refquota: { parsed: 0 } }),
        // Exactly at the threshold, which is "at or above".
        dataset({ id: 'tank/exact', used: { parsed: 50 }, quota: { parsed: 100 }, refquota: { parsed: 0 } }),
        // Below on both.
        dataset({ id: 'tank/quiet', used: { parsed: 1 }, referenced: { parsed: 1 } }),
        // No percentage at all, on either limit.
        without(dataset({ id: 'tank/unreadable', refquota: { parsed: 0 } }), 'quota'),
      ],
      { threshold_percent: 50 },
    );
    expect(rows.map((row) => row['id'])).toEqual([
      'tank/refquota-only',
      'tank/quota-only',
      'tank/exact',
    ]);
  });

  it('ignores a threshold that is not a number', async () => {
    // Both percentages sit below the threshold — 0.3% of quota and 2.5% of
    // refquota — so the dataset survives only because the filter never runs.
    // A comparison against the string would coerce it and keep any dataset at
    // or above 50 on either limit, which is what makes this row the one that
    // tells the two paths apart.
    const rows = await rowsFrom([dataset({ used: { parsed: 1 }, referenced: { parsed: 1 } })], {
      threshold_percent: '50',
    });
    expect(rows.map((row) => row['id'])).toEqual(['tank/media']);
  });

  it('asks the middleware for the two limits and the two usages they cap', async () => {
    const { ctx, query } = fakeSystem({ ['pool.dataset.query']: [] });
    await quotaReport.handler(ctx, {});
    // `referenced` is requested by name because it is the property `refquota`
    // caps; without it the refquota percentage could only be computed against
    // `used`, which caps nothing of the sort.
    expect(query).toHaveBeenCalledWith('pool.dataset.query', [], {
      extra: {
        retrieve_children: true,
        properties: ['used', 'referenced', 'quota', 'refquota'],
      },
    });
  });
});

describe('disks_list', () => {
  // Every property the middleware's disk row carries, so the assertions below
  // show what the tool drops as well as what it keeps. `passwd` and `kmip_uid`
  // are the SED credential fields, and are here to be dropped.
  const disk = (over: Record<string, unknown>) => ({
    identifier: '{serial}ABC123',
    name: 'sda',
    subsystem: 'scsi',
    number: 2048,
    serial: 'ABC123',
    lunid: null,
    size: 4000787030016,
    transfermode: 'Auto',
    hddstandby: 'ALWAYS ON',
    advpowermgmt: 'DISABLED',
    expiretime: null,
    model: 'WDC_WD40EFRX',
    rotationrate: 5400,
    type: 'HDD',
    zfs_guid: '12345678901234567890',
    bus: 'SCSI',
    devname: 'sda',
    enclosure: { number: 0, slot: 3 },
    pool: 'tank',
    passwd: 'the-sed-passphrase',
    kmip_uid: null,
    sed: false,
    sed_status: null,
    ...over,
  });

  /** A row from a system that did not answer the pool question at all. */
  const withoutPool = (row: Record<string, unknown>): Record<string, unknown> => {
    const copy = { ...row };
    delete copy['pool'];
    return copy;
  };

  it('trims disk.query to the named fields', async () => {
    const { ctx } = fakeSystem({ ['disk.query']: [disk({})] });
    expect(await disksList.handler(ctx, {})).toEqual([
      {
        name: 'sda',
        model: 'WDC_WD40EFRX',
        serial: 'ABC123',
        size_bytes: 4000787030016,
        type: 'HDD',
        transfermode: 'Auto',
        pool: 'tank',
      },
    ]);
  });

  it('asks the middleware to attach pool membership', async () => {
    const { ctx, query } = fakeSystem({ ['disk.query']: [] });
    await disksList.handler(ctx, {});
    // Without `extra.pools` the rows carry no membership at all, which the
    // handler would then have to report as unknown for every disk.
    expect(query).toHaveBeenCalledWith('disk.query', [], { extra: { pools: true } });
  });

  it('surfaces neither the SED passphrase nor a field a later release adds', async () => {
    const { ctx } = fakeSystem({
      ['disk.query']: [disk({ future_field: 'added by a later TrueNAS release' })],
    });
    const [result] = (await disksList.handler(ctx, {})) as Record<string, unknown>[];
    expect(Object.keys(result)).toEqual([
      'name',
      'model',
      'serial',
      'size_bytes',
      'type',
      'transfermode',
      'pool',
    ]);
  });

  it('distinguishes a disk in no pool from one whose membership was not reported', async () => {
    // `pool: null` is the middleware saying "this disk belongs to no pool". A
    // row with no `pool` key at all is a system that did not answer the
    // question — an older middleware, or one that ignored `extra.pools`.
    const { ctx } = fakeSystem({
      ['disk.query']: [
        disk({ name: 'sda', pool: 'tank' }),
        disk({ name: 'sdb', pool: null }),
        withoutPool(disk({ name: 'sdc' })),
      ],
    });
    const result = (await disksList.handler(ctx, {})) as Record<string, unknown>[];
    expect(result.map((d) => [d['name'], 'pool' in d, d['pool']])).toEqual([
      ['sda', true, 'tank'],
      ['sdb', true, null],
      ['sdc', false, undefined],
    ]);
  });

  it('returns [] for a system with no disks', async () => {
    const { ctx } = fakeSystem({ ['disk.query']: [] });
    expect(await disksList.handler(ctx, {})).toEqual([]);
  });
});

describe('apps_list', () => {
  // Every property the middleware's app row carries, so the assertions below
  // show what the tool drops as well as what it keeps. `portals`, `metadata`
  // and `active_workloads` are the bulky ones; `config` is the install-time
  // form the user filled in, and its `plex_claim_token` is a credential. All
  // four are here to be dropped.
  const app = (over: Record<string, unknown>) => ({
    name: 'plex',
    id: 'plex',
    state: 'RUNNING',
    upgrade_available: false,
    latest_version: '1.2.3',
    latest_app_version: '1.41.0.8994',
    image_updates_available: false,
    custom_app: false,
    migrated: false,
    human_version: '1.41.0.8994_1.2.3',
    version: '1.2.3',
    metadata: { app_version: '1.41.0.8994', capabilities: [], run_as_context: [] },
    active_workloads: {
      containers: 1,
      used_ports: [{ container_port: 32400, protocol: 'tcp' }],
      container_details: [{ id: 'abc', service_name: 'plex', image: 'plexinc/pms-docker' }],
      volumes: [{ source: '/mnt/tank/plex', destination: '/config' }],
    },
    notes: null,
    action_required: false,
    portals: { 'Web UI': 'http://nas:32400' },
    version_details: null,
    config: { plex_claim_token: 'claim-abc123' },
    ...over,
  });

  it('trims app.query to the named fields', async () => {
    const { ctx, query } = fakeSystem({ ['app.query']: [app({})] });
    expect(await appsList.handler(ctx, {})).toEqual([
      {
        name: 'plex',
        version: '1.2.3',
        latest_version: '1.2.3',
        state: 'RUNNING',
        upgrade_available: false,
        image_updates_available: false,
      },
    ]);
    // The tool reads the app list and nothing else, with no filters and no
    // options: unlike disks_list there is no `extra` the rows depend on.
    expect(query.mock.calls).toEqual([['app.query']]);
  });

  it('surfaces neither the install-time config nor a field a later release adds', async () => {
    const { ctx } = fakeSystem({
      ['app.query']: [app({ future_field: 'added by a later TrueNAS release' })],
    });
    const [result] = (await appsList.handler(ctx, {})) as Record<string, unknown>[];
    expect(Object.keys(result)).toEqual([
      'name',
      'version',
      'latest_version',
      'state',
      'upgrade_available',
      'image_updates_available',
    ]);
  });

  it('includes apps that are not running, keeping stopped and crashed apart', async () => {
    const { ctx } = fakeSystem({
      ['app.query']: [
        app({ name: 'plex', state: 'RUNNING' }),
        app({ name: 'nextcloud', state: 'STOPPED' }),
        app({ name: 'jellyfin', state: 'CRASHED' }),
        app({ name: 'immich', state: 'DEPLOYING' }),
      ],
    });
    const result = (await appsList.handler(ctx, {})) as { name: string; state: string }[];
    expect(result.map((a) => [a.name, a.state])).toEqual([
      ['plex', 'RUNNING'],
      ['nextcloud', 'STOPPED'],
      ['jellyfin', 'CRASHED'],
      ['immich', 'DEPLOYING'],
    ]);
  });

  it('reports a waiting catalog upgrade and a waiting image update separately', async () => {
    // A custom app has no catalog version to move to, so `upgrade_available`
    // is permanently false and `image_updates_available` is the only signal
    // that it is out of date. Collapsing the two would report it up to date.
    const { ctx } = fakeSystem({
      ['app.query']: [
        app({
          name: 'sonarr',
          upgrade_available: true,
          latest_version: '2.0.0',
          version: '1.9.0',
          image_updates_available: false,
        }),
        app({
          name: 'my-own-thing',
          upgrade_available: false,
          latest_version: null,
          image_updates_available: true,
        }),
      ],
    });
    expect(await appsList.handler(ctx, {})).toEqual([
      {
        name: 'sonarr',
        version: '1.9.0',
        latest_version: '2.0.0',
        state: 'RUNNING',
        upgrade_available: true,
        image_updates_available: false,
      },
      {
        name: 'my-own-thing',
        version: '1.2.3',
        latest_version: null,
        state: 'RUNNING',
        upgrade_available: false,
        image_updates_available: true,
      },
    ]);
  });

  it('returns [] for a system with no apps installed', async () => {
    const { ctx } = fakeSystem({ ['app.query']: [] });
    expect(await appsList.handler(ctx, {})).toEqual([]);
  });
});

describe('alerts_list', () => {
  // Every property the middleware's Alert carries, so the assertions below show
  // what the tool drops as well as what it keeps.
  const alert = (over: Record<string, unknown>) => ({
    uuid: 'u1',
    source: 'AlertSource',
    klass: 'ZpoolCapacityWarning',
    args: { pool: 'tank' },
    node: 'A',
    key: '[]',
    datetime: '2026-08-28T12:00:00+00:00',
    last_occurrence: '2026-08-28T13:00:00+00:00',
    dismissed: false,
    mail: null,
    text: 'Pool %(pool)s is low on space.',
    id: 'a1',
    level: 'WARNING',
    formatted: 'Pool tank is low on space.',
    one_shot: false,
    ...over,
  });

  it('trims alert.list to the named fields', async () => {
    const { ctx, call } = fakeSystem({ ['alert.list']: [alert({})] });
    expect(await alertsList.handler(ctx, {})).toEqual([
      {
        id: 'a1',
        klass: 'ZpoolCapacityWarning',
        level: 'WARNING',
        formatted: 'Pool tank is low on space.',
        datetime: '2026-08-28T12:00:00+00:00',
        dismissed: false,
      },
    ]);
    // The tool reads the alert list and nothing else.
    expect(call.mock.calls).toEqual([['alert.list']]);
  });

  it('does not surface a field the middleware adds later', async () => {
    const { ctx } = fakeSystem({
      ['alert.list']: [alert({ future_field: 'added by a later TrueNAS release' })],
    });
    const [result] = (await alertsList.handler(ctx, {})) as Record<string, unknown>[];
    expect(Object.keys(result)).toEqual([
      'id',
      'klass',
      'level',
      'formatted',
      'datetime',
      'dismissed',
    ]);
  });

  it('returns dismissed alerts, distinguishable by the boolean', async () => {
    const { ctx } = fakeSystem({
      ['alert.list']: [alert({ id: 'a1' }), alert({ id: 'a2', dismissed: true })],
    });
    const result = (await alertsList.handler(ctx, {})) as { id: string; dismissed: boolean }[];
    expect(result.map((a) => [a.id, a.dismissed])).toEqual([
      ['a1', false],
      ['a2', true],
    ]);
  });

  it('returns [] for a system with no alerts', async () => {
    const { ctx } = fakeSystem({ ['alert.list']: [] });
    expect(await alertsList.handler(ctx, {})).toEqual([]);
  });
});

describe('snapshots_list', () => {
  /**
   * A snapshot row as `pool.snapshot.query` reports one. `id`, `pool`,
   * `snapshot_name`, `type` and `createtxg` are here to be dropped: they are
   * fields of the real payload the tool does not name.
   */
  const snapshot = (over: Record<string, unknown> = {}) => ({
    id: 'tank/media@nightly-1',
    name: 'tank/media@nightly-1',
    dataset: 'tank/media',
    pool: 'tank',
    snapshot_name: 'nightly-1',
    type: 'SNAPSHOT',
    createtxg: '12345',
    properties: {
      creation: { value: 'Thu Aug 28 02:00 2025', rawvalue: '1756346400', parsed: 1756346400 },
      referenced: { value: '96K', rawvalue: '98304', parsed: 98304 },
    },
    ...over,
  });

  /** The tool's own envelope, for the assertions below. */
  interface Listing {
    snapshots: Record<string, unknown>[];
    truncated: boolean;
    limit: number;
  }

  const listing = async (
    snapshots: unknown[],
    args: Record<string, unknown> = {},
    datasets: unknown[] = [],
  ): Promise<Listing> => {
    const { ctx } = fakeSystem({
      ['pool.snapshot.query']: snapshots,
      ['pool.dataset.query']: datasets,
    });
    return (await snapshotsList.handler(ctx, args)) as unknown as Listing;
  };

  it('maps a snapshot to its name, dataset, creation time and referenced size', async () => {
    const result = await listing([snapshot()]);
    expect(result).toEqual({
      snapshots: [
        {
          name: 'tank/media@nightly-1',
          dataset: 'tank/media',
          created: '2025-08-28T02:00:00.000Z',
          referenced_bytes: 98304,
        },
      ],
      truncated: false,
      limit: 100,
    });
  });

  it('surfaces no field a later release adds', async () => {
    const result = await listing([snapshot({ future_field: 'added by a later TrueNAS release' })]);
    expect(Object.keys(result.snapshots[0])).toEqual([
      'name',
      'dataset',
      'created',
      'referenced_bytes',
    ]);
  });

  it('asks for one more row than the bound, and for only the two properties it reports', async () => {
    const { ctx, query } = fakeSystem({ ['pool.snapshot.query']: [snapshot()] });
    await snapshotsList.handler(ctx, {});
    // No `order_by`: the system applies the bound, so an order asked for here
    // would choose which snapshots a truncated list holds, and no field of a
    // snapshot row orders it in time soundly — `createtxg` is a string, and it
    // counts transaction groups on the system holding the snapshot rather than
    // the one that took it. The extra row is what tells a complete list from a
    // truncated one.
    expect(query).toHaveBeenCalledWith('pool.snapshot.query', [], {
      limit: 101,
      extra: { properties: ['creation', 'referenced'] },
    });
  });

  it('passes a dataset filter to the query', async () => {
    const { ctx, query } = fakeSystem({ ['pool.snapshot.query']: [snapshot()] });
    await snapshotsList.handler(ctx, { dataset: 'tank/media' });
    expect(query).toHaveBeenCalledWith('pool.snapshot.query', [['dataset', '=', 'tank/media']], {
      limit: 101,
      extra: { properties: ['creation', 'referenced'] },
    });
    // The dataset plainly exists — it has snapshots — so nothing else is asked.
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('reports a dataset that exists and holds no snapshots as an empty list', async () => {
    expect(await listing([], { dataset: 'tank/empty' }, [{ id: 'tank/empty' }])).toEqual({
      snapshots: [],
      truncated: false,
      limit: 100,
    });
  });

  it('distinguishes a dataset that does not exist from one with no snapshots', async () => {
    // Same empty snapshot list as above; the dataset query is what differs.
    await expect(listing([], { dataset: 'tank/ghost' }, [])).rejects.toThrow(
      /Dataset "tank\/ghost" does not exist/,
    );
  });

  it('does not check for the dataset when none was named', async () => {
    const { ctx, query } = fakeSystem({ ['pool.snapshot.query']: [] });
    await expect(snapshotsList.handler(ctx, {})).resolves.toEqual({
      snapshots: [],
      truncated: false,
      limit: 100,
    });
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('rejects a dataset argument that is not a dataset name', async () => {
    // Ignoring it would answer with every snapshot on the system, which is a
    // wrong answer to the question asked rather than a broad one.
    for (const bad of [123, '', true, {}]) {
      await expect(listing([snapshot()], { dataset: bad })).rejects.toThrow(
        /"dataset" must be a non-empty string/,
      );
    }
  });

  it('bounds the list and says so when the system holds more', async () => {
    // Which two come back is the system's choice — the bound is applied there,
    // and this tool orders that window rather than choosing it. `truncated` is
    // what says the list is not the whole set.
    const result = await listing(
      [snapshot({ name: 'a' }), snapshot({ name: 'b' }), snapshot({ name: 'c' })],
      { limit: 2 },
    );
    expect(result.snapshots.map((row) => row['name'])).toEqual(['a', 'b']);
    expect(result.truncated).toBe(true);
    expect(result.limit).toBe(2);
  });

  it('is not truncated when the system holds exactly the bound', async () => {
    const result = await listing([snapshot({ name: 'a' }), snapshot({ name: 'b' })], { limit: 2 });
    expect(result.snapshots).toHaveLength(2);
    expect(result.truncated).toBe(false);
  });

  it('clamps the bound, and reports the one it applied', async () => {
    const applied = async (limit: unknown): Promise<number> => {
      const { ctx, query } = fakeSystem({ ['pool.snapshot.query']: [] });
      const result = (await snapshotsList.handler(ctx, { limit })) as unknown as Listing;
      // The bound reported and the bound asked of the middleware are the same
      // number, so a caller reading `limit` is reading what actually applied.
      expect(query).toHaveBeenCalledWith('pool.snapshot.query', [], {
        limit: result.limit + 1,
        extra: { properties: ['creation', 'referenced'] },
      });
      return result.limit;
    };
    expect(await applied(5000)).toBe(1000);
    // Zero would return nothing while reporting the system as holding more.
    expect(await applied(0)).toBe(1);
    expect(await applied(-3)).toBe(1);
    expect(await applied(2.7)).toBe(2);
    // Not a number, so not a bound: the default stands.
    expect(await applied('50')).toBe(100);
    expect(await applied(Number.NaN)).toBe(100);
    expect(await applied(undefined)).toBe(100);
  });

  it('orders newest first, and puts an unreadable creation time last', async () => {
    const result = await listing([
      snapshot({ name: 'older', properties: { creation: { rawvalue: '1000' } } }),
      snapshot({ name: 'unreadable', properties: { creation: { rawvalue: 'whenever' } } }),
      snapshot({ name: 'newest', properties: { creation: { rawvalue: '3000' } } }),
      snapshot({ name: 'middle', properties: { creation: { rawvalue: '2000' } } }),
      snapshot({ name: 'also-unreadable', properties: {} }),
    ]);
    expect(result.snapshots.map((row) => row['name'])).toEqual([
      'newest',
      'middle',
      'older',
      // Both unreadable, in the order the system sent them.
      'unreadable',
      'also-unreadable',
    ]);
  });

  it('reads the creation time ZFS reports rather than the middleware rendering', async () => {
    // `parsed` disagrees with `rawvalue` here: only a tool reading the raw
    // epoch seconds answers with the second timestamp.
    const result = await listing([
      snapshot({
        properties: { creation: { rawvalue: '1756346400', parsed: 'Aug 27 2019, sometime' } },
      }),
    ]);
    expect(result.snapshots[0]['created']).toBe('2025-08-28T02:00:00.000Z');
  });

  it('reports a creation time it cannot read as null rather than as the epoch', async () => {
    const unreadable = async (creation: unknown): Promise<unknown> => {
      const result = await listing([snapshot({ properties: { creation } })]);
      return result.snapshots[0]['created'];
    };
    // `Number('')` is 0, which would date every one of these to 1970.
    expect(await unreadable({ rawvalue: '' })).toBeNull();
    expect(await unreadable({ rawvalue: 'whenever' })).toBeNull();
    expect(await unreadable({ rawvalue: '17e8' })).toBeNull();
    expect(await unreadable({ rawvalue: null })).toBeNull();
    expect(await unreadable({})).toBeNull();
    expect(await unreadable(null)).toBeNull();
    expect(await unreadable(1756346400)).toBeNull();
    // Beyond what a Date can hold, where `toISOString` throws rather than
    // answering — one absurd row must not take the whole listing down.
    expect(await unreadable({ rawvalue: '999999999999999' })).toBeNull();
    expect(await unreadable({ rawvalue: '-999999999999999' })).toBeNull();
    expect(await unreadable({ rawvalue: Number.POSITIVE_INFINITY })).toBeNull();
    // A number the system did send, in the form it sends strings in.
    expect(await unreadable({ rawvalue: 1756346400 })).toBe('2025-08-28T02:00:00.000Z');
    expect(await unreadable({ rawvalue: '-1' })).toBe('1969-12-31T23:59:59.000Z');
  });

  it('reports an unreadable referenced size as null rather than as nothing referenced', async () => {
    const referenced = async (property: unknown): Promise<unknown> => {
      const result = await listing([
        snapshot({ properties: { creation: { rawvalue: '1' }, referenced: property } }),
      ]);
      return result.snapshots[0]['referenced_bytes'];
    };
    expect(await referenced({ parsed: 0 })).toBe(0);
    expect(await referenced({ parsed: Number.NaN })).toBeNull();
    expect(await referenced({ parsed: '98304' })).toBeNull();
    expect(await referenced({})).toBeNull();
    expect(await referenced(undefined)).toBeNull();
    expect(await referenced(98304)).toBeNull();
  });

  it('reports a name or dataset that is not a string as null', async () => {
    const result = await listing([snapshot({ name: 12345, dataset: null })]);
    expect(result.snapshots[0]['name']).toBeNull();
    expect(result.snapshots[0]['dataset']).toBeNull();
  });

  it('survives a row whose properties are not an object', async () => {
    const result = await listing([snapshot({ properties: 'unset' })]);
    expect(result.snapshots[0]).toEqual({
      name: 'tank/media@nightly-1',
      dataset: 'tank/media',
      created: null,
      referenced_bytes: null,
    });
  });
});

describe('snapshots_create', () => {
  it('normalizes args: applies defaults and drops unknown keys', () => {
    expect(
      createSnapshot.normalizeArgs?.({ dataset: 'tank/media', name: 'before', extra: 1 }),
    ).toEqual({ dataset: 'tank/media', name: 'before', recursive: false });
  });

  it('rejects non-boolean recursive instead of silently coercing', () => {
    for (const bad of ['true', 1, 'yes', 0]) {
      expect(() =>
        createSnapshot.normalizeArgs?.({ dataset: 'tank/media', name: 'x', recursive: bad }),
      ).toThrow(/"recursive" must be a boolean/);
    }
    expect(
      createSnapshot.normalizeArgs?.({ dataset: 'tank/media', name: 'x', recursive: null }),
    ).toEqual({ dataset: 'tank/media', name: 'x', recursive: false });
  });

  it('plans the exact pool.snapshot.create call after verifying the dataset exists', async () => {
    const { ctx } = fakeSystem({ ['pool.dataset.query']: [{ id: 'tank/media' }] });
    const steps = await createSnapshot.plan(ctx, { dataset: 'tank/media', name: 'before' });
    expect(steps).toEqual([
      {
        method: 'pool.snapshot.create',
        params: [{ dataset: 'tank/media', name: 'before', recursive: false }],
        description: 'Create snapshot "tank/media@before"',
      },
    ]);
  });

  it('fails the plan when the dataset does not exist', async () => {
    const { ctx } = fakeSystem({ ['pool.dataset.query']: [] });
    await expect(
      createSnapshot.plan(ctx, { dataset: 'tank/nope', name: 'before' }),
    ).rejects.toThrow(/does not exist/);
  });

  it('requires dataset and name', async () => {
    const { ctx } = fakeSystem({});
    await expect(createSnapshot.plan(ctx, { name: 'x' })).rejects.toThrow(/"dataset"/);
    await expect(createSnapshot.plan(ctx, { dataset: 'tank' })).rejects.toThrow(/"name"/);
  });

  it('executes the same call the plan described', async () => {
    const { ctx, call } = fakeSystem({
      ['pool.snapshot.create']: { name: 'tank/media@before' },
    });
    const result = await createSnapshot.execute(ctx, { dataset: 'tank/media', name: 'before' });
    expect(call).toHaveBeenCalledWith('pool.snapshot.create', [
      { dataset: 'tank/media', name: 'before', recursive: false },
    ]);
    expect(result).toEqual({ created: 'tank/media@before' });
  });
});

describe('replication_status', () => {
  /**
   * A replication task as `replication.query` reports one. `recursive`, `auto`,
   * `retention_policy`, `periodic_snapshot_tasks`, `has_encrypted_dataset_keys`
   * and `job` are here to be dropped: they are fields of the real payload the
   * tool does not name.
   */
  const task = (over: Record<string, unknown> = {}) => ({
    id: 1,
    name: 'nightly-to-backup',
    direction: 'PUSH',
    transport: 'SSH',
    enabled: true,
    source_datasets: ['tank/media'],
    target_dataset: 'backup/media',
    recursive: true,
    auto: true,
    retention_policy: 'SOURCE',
    periodic_snapshot_tasks: [],
    has_encrypted_dataset_keys: false,
    state: { state: 'FINISHED', datetime: { $date: 1756346400000 }, error: null },
    job: null,
    ...over,
  });

  const statuses = async (tasks: unknown[]): Promise<Record<string, unknown>[]> => {
    const { ctx } = fakeSystem({ ['replication.query']: tasks });
    return (await replicationStatus.handler(ctx, {})) as Record<string, unknown>[];
  };

  /** One task, differing only in the state record the system holds for it. */
  const forState = async (state: unknown): Promise<Record<string, unknown>> =>
    (await statuses([task({ state })]))[0];

  it('maps a task to its endpoints, transport and last run', async () => {
    expect(await statuses([task()])).toEqual([
      {
        id: 1,
        name: 'nightly-to-backup',
        direction: 'PUSH',
        transport: 'SSH',
        enabled: true,
        source_datasets: ['tank/media'],
        target_dataset: 'backup/media',
        state: 'FINISHED',
        finished_at: '2025-08-28T02:00:00.000Z',
        error: null,
      },
    ]);
  });

  it('surfaces no field a later release adds', async () => {
    const rows = await statuses([task({ future_field: 'added by a later TrueNAS release' })]);
    expect(Object.keys(rows[0])).toEqual([
      'id',
      'name',
      'direction',
      'transport',
      'enabled',
      'source_datasets',
      'target_dataset',
      'state',
      'finished_at',
      'error',
    ]);
  });

  it('asks for every task, with no filters and no options', async () => {
    const { ctx, query } = fakeSystem({ ['replication.query']: [task()] });
    await replicationStatus.handler(ctx, {});
    expect(query).toHaveBeenCalledWith('replication.query');
  });

  it('returns [] for a system with no replication tasks', async () => {
    expect(await statuses([])).toEqual([]);
  });

  it('marks a task that has never run rather than omitting it or failing it', async () => {
    // What the system holds for a task created and not yet run: pending, with
    // no time recorded against it.
    const row = await forState({ state: 'PENDING' });
    expect(row['state']).toBe('NEVER_RUN');
    expect(row['finished_at']).toBeNull();
    expect(row['error']).toBeNull();
  });

  it('reads a task pending again after running as PENDING, not as never run', async () => {
    // The recorded time is the evidence that something has happened to this
    // task before; it is not a finish time, so it is not reported as one.
    const row = await forState({ state: 'PENDING', datetime: { $date: 1756346400000 } });
    expect(row['state']).toBe('PENDING');
    expect(row['finished_at']).toBeNull();
  });

  it('reports a state it cannot read as null rather than as never run', async () => {
    // A task nothing can be said about must not read as one known to have
    // never replicated: that is a fact about the task, not about this tool.
    for (const unreadable of [undefined, null, 'FINISHED', 42, {}, { state: null }, { state: '' }]) {
      const row = await forState(unreadable);
      expect(row['state']).toBeNull();
      expect(row['finished_at']).toBeNull();
      expect(row['error']).toBeNull();
    }
  });

  it('distinguishes a running task from a finished one, and gives it no finish time', async () => {
    // The system records one time per task, and under RUNNING it is when the
    // current run started — reporting it as `finished_at` would name a real
    // timestamp as something it is not.
    const running = await forState({ state: 'RUNNING', datetime: { $date: 1756346400000 } });
    expect(running['state']).toBe('RUNNING');
    expect(running['finished_at']).toBeNull();
    const held = await forState({ state: 'HOLD', datetime: { $date: 1756346400000 } });
    expect(held['state']).toBe('HOLD');
    expect(held['finished_at']).toBeNull();
  });

  it('passes through a state a later release adds', async () => {
    const row = await forState({ state: 'SUSPENDED', datetime: { $date: 1756346400000 } });
    expect(row['state']).toBe('SUSPENDED');
    // Not one of the two states that describe an ended run, so no finish time.
    expect(row['finished_at']).toBeNull();
  });

  it('reports the finish time of a run that ended, in either shape the time arrives in', async () => {
    const enveloped = await forState({ state: 'ERROR', datetime: { $date: 1756346400000 } });
    expect(enveloped['state']).toBe('ERROR');
    expect(enveloped['finished_at']).toBe('2025-08-28T02:00:00.000Z');
    // The envelope only tags a number as a date; a bare one is the same instant.
    const bare = await forState({ state: 'FINISHED', datetime: 1756346400000 });
    expect(bare['finished_at']).toBe('2025-08-28T02:00:00.000Z');
  });

  it('reports a finish time it cannot read as null rather than as the epoch', async () => {
    const finished = async (datetime: unknown): Promise<unknown> =>
      (await forState({ state: 'FINISHED', datetime }))['finished_at'];
    expect(await finished('2025-08-28T02:00:00Z')).toBeNull();
    expect(await finished({ $date: '1756346400000' })).toBeNull();
    expect(await finished({})).toBeNull();
    expect(await finished(null)).toBeNull();
    expect(await finished(Number.NaN)).toBeNull();
    expect(await finished(Number.POSITIVE_INFINITY)).toBeNull();
    // Beyond what a Date can hold, where `toISOString` throws rather than
    // answering — one absurd row must not take the whole listing down.
    expect(await finished({ $date: 8.64e15 + 1 })).toBeNull();
    expect(await finished({ $date: -8.64e15 - 1 })).toBeNull();
    expect(await finished({ $date: 0 })).toBe('1970-01-01T00:00:00.000Z');
  });

  it('carries the error text of a failed run, and reads an empty one as none', async () => {
    const failed = await forState({
      state: 'ERROR',
      datetime: { $date: 1756346400000 },
      error: 'ssh connection refused',
    });
    expect(failed['error']).toBe('ssh connection refused');
    // An empty string names nothing a caller could act on; the ERROR state is
    // what says the run failed either way.
    for (const none of ['', null, undefined, 42, { message: 'nope' }]) {
      const row = await forState({ state: 'ERROR', error: none });
      expect(row['state']).toBe('ERROR');
      expect(row['error']).toBeNull();
    }
  });

  it('lists a disabled task, and reports a switch it cannot read as null', async () => {
    const [disabled] = await statuses([task({ enabled: false })]);
    expect(disabled['enabled']).toBe(false);
    // Not defaulted either way: a task whose switch is unreadable must not be
    // presented as definitely on or definitely off.
    const [unreported] = await statuses([task({ enabled: undefined })]);
    expect(unreported['enabled']).toBeNull();
  });

  it('reports the source datasets, keeping only the names among them', async () => {
    const sources = async (value: unknown): Promise<unknown> =>
      (await statuses([task({ source_datasets: value })]))[0]['source_datasets'];
    expect(await sources(['tank/media', 'tank/docs'])).toEqual(['tank/media', 'tank/docs']);
    expect(await sources(['tank/media', 7, null])).toEqual(['tank/media']);
    expect(await sources(undefined)).toEqual([]);
    expect(await sources('tank/media')).toEqual([]);
  });
});

describe('snapshot_tasks_list', () => {
  /**
   * A periodic snapshot task as `pool.snapshottask.query` reports one.
   * `exclude`, `naming_schema`, `allow_empty`, `vmware_sync` and `state` are
   * here to be dropped: they are fields of the real payload the tool does not
   * name.
   */
  const task = (over: Record<string, unknown> = {}) => ({
    id: 1,
    dataset: 'tank/media',
    recursive: true,
    enabled: true,
    lifetime_value: 2,
    lifetime_unit: 'WEEK',
    schedule: {
      minute: '0',
      hour: '2',
      dom: '*',
      month: '*',
      dow: '*',
      begin: '00:00',
      end: '23:59',
    },
    exclude: [],
    naming_schema: 'auto-%Y-%m-%d_%H-%M',
    allow_empty: true,
    vmware_sync: false,
    state: { state: 'FINISHED' },
    ...over,
  });

  const listed = async (rows: unknown[]): Promise<Record<string, unknown>[]> => {
    const { ctx } = fakeSystem({ ['pool.snapshottask.query']: rows });
    return (await snapshotTasksList.handler(ctx, {})) as Record<string, unknown>[];
  };

  /** One task, differing only in the schedule the system holds for it. */
  const forSchedule = async (schedule: unknown): Promise<Record<string, unknown>> =>
    (await listed([task({ schedule })]))[0];

  /**
   * The words one schedule is rendered into. The base is a daily 02:00 task
   * with no window, so a case names only the fields it is about.
   */
  const described = async (over: Record<string, unknown>): Promise<unknown> =>
    (await forSchedule({ minute: '0', hour: '2', dom: '*', month: '*', dow: '*', ...over }))[
      'schedule_description'
    ];

  it('maps a task to its dataset, schedule and retention', async () => {
    expect(await listed([task()])).toEqual([
      {
        id: 1,
        dataset: 'tank/media',
        enabled: true,
        recursive: true,
        schedule: {
          minute: '0',
          hour: '2',
          dom: '*',
          month: '*',
          dow: '*',
          begin: '00:00',
          end: '23:59',
        },
        schedule_description: 'at 02:00, every day',
        lifetime_value: 2,
        lifetime_unit: 'WEEK',
      },
    ]);
  });

  it('surfaces no field a later release adds, at either level', async () => {
    const rows = await listed([
      task({
        future_field: 'added by a later TrueNAS release',
        schedule: { minute: '0', hour: '2', dom: '*', month: '*', dow: '*', timezone: 'UTC' },
      }),
    ]);
    expect(Object.keys(rows[0])).toEqual([
      'id',
      'dataset',
      'enabled',
      'recursive',
      'schedule',
      'schedule_description',
      'lifetime_value',
      'lifetime_unit',
    ]);
    expect(Object.keys(rows[0]['schedule'] as object)).toEqual([
      'minute',
      'hour',
      'dom',
      'month',
      'dow',
      'begin',
      'end',
    ]);
  });

  it('asks for every task, with no filters and no options', async () => {
    const { ctx, query } = fakeSystem({ ['pool.snapshottask.query']: [task()] });
    await snapshotTasksList.handler(ctx, {});
    expect(query).toHaveBeenCalledWith('pool.snapshottask.query');
  });

  it('returns [] for a system with no snapshot tasks', async () => {
    expect(await listed([])).toEqual([]);
  });

  it('lists a disabled task, and reports a switch it cannot read as null', async () => {
    // A task that exists and is off is the case worth surfacing, so it is
    // returned and marked rather than omitted.
    const [disabled] = await listed([task({ enabled: false })]);
    expect(disabled['enabled']).toBe(false);
    // Not defaulted either way: a task whose switch is unreadable must not be
    // presented as definitely on or definitely off.
    const [unreported] = await listed([task({ enabled: undefined })]);
    expect(unreported['enabled']).toBeNull();
  });

  it('reports recursion it cannot read as null rather than as flat', async () => {
    expect((await listed([task({ recursive: false })]))[0]['recursive']).toBe(false);
    expect((await listed([task({ recursive: undefined })]))[0]['recursive']).toBeNull();
  });

  it('reports the retention, and a retention it cannot read as null', async () => {
    const [kept] = await listed([task({ lifetime_value: 6, lifetime_unit: 'MONTH' })]);
    expect(kept['lifetime_value']).toBe(6);
    expect(kept['lifetime_unit']).toBe('MONTH');
    // Null rather than absent: a task whose retention could not be read is not
    // one that keeps its snapshots forever.
    const [unreported] = await listed([
      task({ lifetime_value: undefined, lifetime_unit: undefined }),
    ]);
    expect(unreported['lifetime_value']).toBeNull();
    expect(unreported['lifetime_unit']).toBeNull();
  });

  it('reports a schedule it cannot read at all as null, with no words for it', async () => {
    for (const unreadable of [undefined, null, '0 2 * * *', 42]) {
      const row = await forSchedule(unreadable);
      expect(row['schedule']).toBeNull();
      expect(row['schedule_description']).toBeNull();
    }
  });

  it('reports a cron field it cannot read as null, and renders no words then', async () => {
    const row = await forSchedule({ minute: '', hour: 2, dom: '*', dow: null });
    expect(row['schedule']).toEqual({
      minute: null,
      hour: null,
      dom: '*',
      month: null,
      dow: null,
      begin: null,
      end: null,
    });
    expect(row['schedule_description']).toBeNull();
  });

  it('states a fixed time of day in words', async () => {
    expect(await described({ minute: '30', hour: '2' })).toBe('at 02:30, every day');
    expect(await described({ minute: '0', hour: '0,12' })).toBe('at 00:00 and 12:00, every day');
    expect(await described({ minute: '5', hour: '0,6,18' })).toBe(
      'at 00:05, 06:05 and 18:05, every day',
    );
  });

  it('states a recurring interval in words', async () => {
    expect(await described({ minute: '0', hour: '*' })).toBe('every hour at :00, every day');
    expect(await described({ minute: '15', hour: '*/4' })).toBe('every 4 hours at :15, every day');
    // A step of one is every hour; "every 1 hours" is not English.
    expect(await described({ minute: '0', hour: '*/1' })).toBe('every hour at :00, every day');
    expect(await described({ minute: '*/15', hour: '*' })).toBe('every 15 minutes, every day');
    // A step that fills its unit exactly: once a day, and once an hour.
    expect(await described({ minute: '0', hour: '*/24' })).toBe('every 24 hours at :00, every day');
    expect(await described({ minute: '*/60', hour: '*' })).toBe('every 60 minutes, every day');
  });

  it('states no interval for a step that does not divide its unit', async () => {
    // A step counts from the start of its unit and stops rather than wrapping.
    // Hours stepping by 5 run at 00, 05, 10, 15 and 20 and then wait four hours
    // for midnight, so "every 5 hours" would name an interval the task breaks
    // once a day.
    expect(await described({ minute: '0', hour: '*/5' })).toBeNull();
    expect(await described({ minute: '0', hour: '*/7' })).toBeNull();
    expect(await described({ minute: '*/7', hour: '*' })).toBeNull();
    expect(await described({ minute: '*/45', hour: '*' })).toBeNull();
    // The ones that do divide are unaffected.
    expect(await described({ minute: '0', hour: '*/8' })).toBe('every 8 hours at :00, every day');
    expect(await described({ minute: '*/20', hour: '*' })).toBe('every 20 minutes, every day');
  });

  it('states which days it runs on in words', async () => {
    expect(await described({ dow: '1' })).toBe('at 02:00, on Monday');
    expect(await described({ dow: '0,4' })).toBe('at 02:00, on Sunday and Thursday');
    // Cron numbers Sunday as both 0 and 7.
    expect(await described({ dow: '7' })).toBe('at 02:00, on Sunday');
    expect(await described({ dow: 'mon,Thu' })).toBe('at 02:00, on Monday and Thursday');
    expect(await described({ dom: '1' })).toBe('at 02:00, on day 1 of each month');
    expect(await described({ dom: '1,15' })).toBe('at 02:00, on days 1 and 15 of each month');
  });

  it('names the daily window only where one restricts the task', async () => {
    expect(await described({ begin: '09:00', end: '17:00' })).toBe(
      'at 02:00, every day, between 09:00 and 17:00',
    );
    // The window a task carries when nothing restricts it, which is worth no
    // words: it says only that the task is not restricted.
    expect(await described({ begin: '00:00', end: '23:59' })).toBe('at 02:00, every day');
    // Half a window is not a window, and the missing end must not be assumed.
    expect(await described({ begin: '09:00' })).toBe('at 02:00, every day');
    expect(await described({ end: '17:00' })).toBe('at 02:00, every day');
  });

  it('renders no words for a schedule shape it cannot state exactly', async () => {
    for (const shape of [
      // A list of minutes, which no shape here renders.
      { minute: '0,30', hour: '2' },
      // Stepped minutes against a fixed hour, which is not "every N minutes".
      { minute: '*/15', hour: '2' },
      // Out of range, so misread rather than merely unusual.
      { minute: '61', hour: '2' },
      { minute: '0', hour: '47' },
      { minute: '0', hour: '*/40' },
      { minute: '0', hour: '*/0' },
      // Ranges and names this tool does not decode.
      { minute: '0', hour: '1-5' },
      { minute: '0', hour: 'H' },
      // A month other than every month.
      { month: '3' },
      // A day of the month and a day of the week together, which cron runs on
      // the union of and every plain phrasing reads as the intersection.
      { dom: '1', dow: '1' },
      { dom: '1-5' },
      { dom: '0' },
      { dow: 'weekdays' },
      { dow: '8' },
    ]) {
      expect(await described(shape)).toBeNull();
    }
  });
});

describe('cloudsync_tasks_list', () => {
  /**
   * A cloud sync task as `cloudsync.query` reports one.
   *
   * `credentials` carries a `provider` because a real row does, and it is here
   * to be dropped: it is where the access key lives, and the test that no
   * secret survives is only worth anything if one was there to survive.
   * `transfer_mode`, `snapshot`, `include`, `exclude`, `locked` and
   * `pre_script` are here to be dropped too — fields of the real payload the
   * tool does not name.
   */
  const task = (over: Record<string, unknown> = {}) => ({
    id: 3,
    description: 'Nightly offsite',
    direction: 'PUSH',
    path: '/mnt/tank/media',
    attributes: { bucket: 'offsite-backups', folder: '/media', region: 'us-east-1' },
    credentials: {
      id: 7,
      name: 'Backblaze B2',
      provider: { type: 'B2', account: '00abc', key: 'SECRET-KEY-MATERIAL' },
    },
    enabled: true,
    schedule: { minute: '0', hour: '2', dom: '*', month: '*', dow: '*' },
    job: {
      id: 91,
      state: 'SUCCESS',
      time_started: { $date: 1_700_000_000_000 },
      time_finished: { $date: 1_700_000_600_000 },
      error: null,
    },
    transfer_mode: 'SYNC',
    snapshot: false,
    include: [],
    exclude: [],
    locked: false,
    pre_script: 'echo hello',
    ...over,
  });

  const listed = async (rows: unknown[]): Promise<Record<string, unknown>[]> => {
    const { ctx } = fakeSystem({ ['cloudsync.query']: rows });
    return (await cloudsyncTasksList.handler(ctx, {})) as Record<string, unknown>[];
  };

  /** One task, differing only in the fields the case is about. */
  const one = async (over: Record<string, unknown>): Promise<Record<string, unknown>> =>
    (await listed([task(over)]))[0];

  it('maps a task to its remote, credential, schedule and last run', async () => {
    expect(await listed([task()])).toEqual([
      {
        id: 3,
        description: 'Nightly offsite',
        direction: 'PUSH',
        path: '/mnt/tank/media',
        bucket: 'offsite-backups',
        folder: '/media',
        credential_id: 7,
        credential_name: 'Backblaze B2',
        enabled: true,
        schedule: { minute: '0', hour: '2', dom: '*', month: '*', dow: '*' },
        schedule_description: 'at 02:00, every day',
        state: 'SUCCESS',
        finished_at: '2023-11-14T22:23:20.000Z',
        error: null,
      },
    ]);
  });

  it('surfaces no field a later release adds, at either level', async () => {
    const rows = await listed([
      task({
        future_field: 'added by a later TrueNAS release',
        schedule: { minute: '0', hour: '2', dom: '*', month: '*', dow: '*', timezone: 'UTC' },
      }),
    ]);
    expect(Object.keys(rows[0])).toEqual([
      'id',
      'description',
      'direction',
      'path',
      'bucket',
      'folder',
      'credential_id',
      'credential_name',
      'enabled',
      'schedule',
      'schedule_description',
      'state',
      'finished_at',
      'error',
    ]);
    // No daily window: a cloud sync schedule carries none, and reporting two
    // permanently null fields would say it does.
    expect(Object.keys(rows[0]['schedule'] as object)).toEqual([
      'minute',
      'hour',
      'dom',
      'month',
      'dow',
    ]);
  });

  it('never lets key material out, whatever the credential carries', async () => {
    const rows = await listed([task()]);
    expect(JSON.stringify(rows)).not.toContain('SECRET-KEY-MATERIAL');
    expect(JSON.stringify(rows)).not.toContain('provider');
    // The credential is still identified — dropping the secret must not cost
    // the caller the ability to say which credential a task uses.
    expect(rows[0]['credential_id']).toBe(7);
    expect(rows[0]['credential_name']).toBe('Backblaze B2');
  });

  it('reads an id-only credential, and reports one it cannot read as null', async () => {
    expect((await one({ credentials: 11 }))['credential_id']).toBe(11);
    // Named on an id-only credential is nothing this tool can invent.
    expect((await one({ credentials: 11 }))['credential_name']).toBeNull();
    for (const unreadable of [undefined, null, 'B2', Number.NaN, {}]) {
      const row = await one({ credentials: unreadable });
      expect(row['credential_id']).toBeNull();
      expect(row['credential_name']).toBeNull();
    }
  });

  it('asks for every task, with no filters and no options', async () => {
    const { ctx, query } = fakeSystem({ ['cloudsync.query']: [task()] });
    await cloudsyncTasksList.handler(ctx, {});
    expect(query).toHaveBeenCalledWith('cloudsync.query');
  });

  it('returns [] for a system with no cloud sync tasks', async () => {
    expect(await listed([])).toEqual([]);
  });

  it('lists a disabled task, and reports a switch it cannot read as null', async () => {
    // A task that exists and is off is the case worth surfacing: the offsite
    // copy stops either way, and only one of the two announces itself.
    expect((await one({ enabled: false }))['enabled']).toBe(false);
    expect((await one({ enabled: undefined }))['enabled']).toBeNull();
  });

  it('reports a description it cannot read as null', async () => {
    for (const unreadable of [undefined, '', 42, null]) {
      expect((await one({ description: unreadable }))['description']).toBeNull();
    }
  });

  it('names the remote end, and reports either part it cannot read as null', async () => {
    // A provider with no buckets — SFTP, WebDAV — carries a folder alone.
    const sftp = await one({ attributes: { folder: '/backups' } });
    expect(sftp['bucket']).toBeNull();
    expect(sftp['folder']).toBe('/backups');
    for (const unreadable of [undefined, null, 'offsite-backups', 42]) {
      const row = await one({ attributes: unreadable });
      expect(row['bucket']).toBeNull();
      expect(row['folder']).toBeNull();
    }
  });

  it('reports a schedule it cannot read at all as null, with no words for it', async () => {
    for (const unreadable of [undefined, null, '0 2 * * *', 42]) {
      const row = await one({ schedule: unreadable });
      expect(row['schedule']).toBeNull();
      expect(row['schedule_description']).toBeNull();
    }
  });

  it('reports a cron field it cannot read as null, and renders no words then', async () => {
    const row = await one({ schedule: { minute: '', hour: 2, dom: '*', dow: null } });
    expect(row['schedule']).toEqual({
      minute: null,
      hour: null,
      dom: '*',
      month: null,
      dow: null,
    });
    expect(row['schedule_description']).toBeNull();
  });

  it('renders a schedule in words without a window to name', async () => {
    // The same renderer as a periodic snapshot task, which reaches it with a
    // window; a cloud sync schedule reaches it with none and reads the same.
    expect(
      (await one({ schedule: { minute: '15', hour: '*/4', dom: '*', month: '*', dow: '1,4' } }))[
        'schedule_description'
      ],
    ).toBe('every 4 hours at :15, on Monday and Thursday');
  });

  it('separates a task that has never run from one it cannot read', async () => {
    // `job: null` is the middleware saying there is no run record, which is
    // what this tool exists to keep apart from a failure.
    const never = await one({ job: null });
    expect(never['state']).toBe('NEVER_RUN');
    expect(never['finished_at']).toBeNull();
    expect(never['error']).toBeNull();
    // Null is not that: a record in a shape this tool could not read, or one
    // naming no state. Neither has been shown to be working.
    for (const unreadable of [undefined, 42, 'SUCCESS', {}, { state: '' }, { state: 7 }]) {
      const row = await one({ job: unreadable });
      expect(row['state']).toBeNull();
      expect(row['finished_at']).toBeNull();
    }
  });

  it('passes a state through as the system spelled it', async () => {
    for (const state of ['FAILED', 'RUNNING', 'WAITING', 'ABORTED', 'A_LATER_RELEASE_STATE']) {
      expect((await one({ job: { state } }))['state']).toBe(state);
    }
  });

  it('reports a finish time only for a run that ended', async () => {
    const at = { $date: 1_700_000_600_000 };
    for (const state of ['SUCCESS', 'FINISHED', 'FAILED', 'ERROR', 'ABORTED']) {
      expect((await one({ job: { state, time_finished: at } }))['finished_at']).toBe(
        '2023-11-14T22:23:20.000Z',
      );
    }
    // The system holds one job record per task, so while a run is going the
    // time in it belongs to the run before — naming it as this run's finish
    // would state a real timestamp as something it is not.
    for (const state of ['RUNNING', 'WAITING', 'PENDING', 'HOLD', 'LOCKED']) {
      expect((await one({ job: { state, time_finished: at } }))['finished_at']).toBeNull();
    }
  });

  it('reads a bare epoch beside the $date envelope, and nothing else', async () => {
    const finishedAt = async (time_finished: unknown): Promise<unknown> =>
      (await one({ job: { state: 'SUCCESS', time_finished } }))['finished_at'];
    // The envelope exists only to tag a number as a date in transit.
    expect(await finishedAt(1_700_000_600_000)).toBe('2023-11-14T22:23:20.000Z');
    for (const unreadable of [
      undefined,
      null,
      // A formatted string is not guessed at: guessing wrong about a timezone
      // produces a timestamp confidently off by hours.
      '2023-11-14T22:23:20Z',
      { $date: '1700000600000' },
      Number.NaN,
      Number.POSITIVE_INFINITY,
      // Beyond what a Date can hold, where `toISOString` throws rather than
      // answering — one absurd time must not take the whole listing down.
      8.64e15 + 1,
      -(8.64e15 + 1),
    ]) {
      expect(await finishedAt(unreadable)).toBeNull();
    }
  });

  it('carries the reason a run failed, and reports no reason as null', async () => {
    expect((await one({ job: { state: 'FAILED', error: 'rclone exited 1' } }))['error']).toBe(
      'rclone exited 1',
    );
    // A task in FAILED with a null error failed for a reason the system did
    // not record; it has not succeeded.
    for (const unreadable of [undefined, null, '', 42]) {
      expect((await one({ job: { state: 'FAILED', error: unreadable } }))['error']).toBeNull();
    }
    expect((await one({ job: null }))['error']).toBeNull();
  });
});

describe('tasks_recent_runs', () => {
  /**
   * A fixed present, so the default window is a fixed interval rather than one
   * that moves with the clock. Only `Date` is faked: the tool reads the clock
   * and nothing here schedules anything, and faking timers wholesale would put
   * the promise machinery under the same control for no reason.
   */
  const NOW = 1_700_000_000_000; // 2023-11-14T22:13:20.000Z
  /** NOW minus the tool's 24-hour default window. */
  const WINDOW_START = NOW - 24 * 60 * 60 * 1000; // 2023-11-13T22:13:20.000Z

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * A job as `core.get_jobs` reports one, started ten minutes ago and finished
   * five.
   *
   * `arguments`, `result`, `logs_excerpt`, `logs_path`, `exc_info` and
   * `credentials` are here to be dropped, and the secrets among them are real
   * strings for the same reason the cloud sync credential carries a key: the
   * test that no secret survives is only worth anything if one was there to
   * survive. `transient` and `abortable` are fields of the real payload the
   * tool does not name.
   */
  const job = (over: Record<string, unknown> = {}) => ({
    id: 412,
    method: 'pool.scrub.run',
    state: 'SUCCESS',
    progress: { percent: 100, description: 'Scrubbing tank', extra: { pool: 'tank' } },
    time_started: { $date: NOW - 600_000 },
    time_finished: { $date: NOW - 300_000 },
    error: null,
    arguments: ['tank', { password: 'SECRET-ARGUMENT-MATERIAL' }],
    result: { detail: 'SECRET-RESULT-MATERIAL' },
    logs_path: '/var/log/jobs/412.log',
    logs_excerpt: 'SECRET-LOG-MATERIAL',
    exc_info: null,
    credentials: { type: 'API_KEY', data: { key: 'SECRET-CREDENTIAL-MATERIAL' } },
    transient: false,
    abortable: true,
    ...over,
  });

  const listed = async (
    rows: unknown[],
    args: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>[]> => {
    const { ctx } = fakeSystem({ ['core.get_jobs']: rows });
    return (await tasksRecentRuns.handler(ctx, args)) as Record<string, unknown>[];
  };

  /** One job, differing only in the fields the case is about. */
  const one = async (over: Record<string, unknown>): Promise<Record<string, unknown>> =>
    (await listed([job(over)]))[0];

  /** The states a job reaches, grouped as `failed_only` reads them. */
  const SUCCEEDED = ['SUCCESS', 'FINISHED'];
  const UNDER_WAY = ['RUNNING', 'WAITING', 'PENDING', 'HOLD', 'LOCKED'];
  const FAILED = ['FAILED', 'ERROR', 'ABORTED'];

  it('maps a job to its method, state, progress, times and error', async () => {
    expect(await listed([job()])).toEqual([
      {
        id: 412,
        method: 'pool.scrub.run',
        state: 'SUCCESS',
        progress_percent: 100,
        progress_description: 'Scrubbing tank',
        started_at: '2023-11-14T22:03:20.000Z',
        finished_at: '2023-11-14T22:08:20.000Z',
        error: null,
      },
    ]);
  });

  it('surfaces no field a later release adds', async () => {
    const rows = await listed([
      job({
        future_field: 'added by a later TrueNAS release',
        progress: { percent: 100, description: 'Scrubbing tank', future_progress_field: 'x' },
      }),
    ]);
    expect(Object.keys(rows[0])).toEqual([
      'id',
      'method',
      'state',
      'progress_percent',
      'progress_description',
      'started_at',
      'finished_at',
      'error',
    ]);
  });

  it('never lets a job’s arguments, result, credentials or logs out', async () => {
    const serialized = JSON.stringify(await listed([job()]));
    for (const secret of [
      'SECRET-ARGUMENT-MATERIAL',
      'SECRET-RESULT-MATERIAL',
      'SECRET-LOG-MATERIAL',
      'SECRET-CREDENTIAL-MATERIAL',
    ]) {
      expect(serialized).not.toContain(secret);
    }
    for (const field of ['arguments', 'result', 'credentials', 'logs_excerpt', 'logs_path']) {
      expect(serialized).not.toContain(field);
    }
  });

  it('asks for every job, naming the fields it reports and no others', async () => {
    const { ctx, query } = fakeSystem({ ['core.get_jobs']: [job()] });
    await tasksRecentRuns.handler(ctx, {});
    expect(query).toHaveBeenCalledWith('core.get_jobs', [], {
      select: ['id', 'method', 'state', 'progress', 'time_started', 'time_finished', 'error'],
    });
  });

  it('returns [] for a system holding no jobs', async () => {
    expect(await listed([])).toEqual([]);
  });

  it('reports the last 24 hours when nothing is asked for', async () => {
    const rows = await listed([
      job({ id: 1, time_started: { $date: WINDOW_START } }),
      job({ id: 2, time_started: { $date: WINDOW_START - 1 } }),
      job({ id: 3, time_started: { $date: NOW } }),
    ]);
    // Inclusive at the bound: a job started exactly 24 hours ago is in.
    expect(rows.map((row) => row['id'])).toEqual([1, 3]);
  });

  it('keeps a job whose start time it cannot read, under any window', async () => {
    for (const unreadable of [undefined, null, '2023-11-14T22:03:20Z', { $date: 'x' }]) {
      // Nothing places it outside the window, and a failure that vanishes
      // because its timestamp was unreadable is the outcome worth avoiding.
      const rows = await listed([job({ time_started: unreadable })], { since: '2023-11-14' });
      expect(rows).toHaveLength(1);
      expect(rows[0]['started_at']).toBeNull();
    }
  });

  it('bounds the result at a `since` the caller names', async () => {
    const rows = await listed(
      [
        job({ id: 1, time_started: { $date: Date.parse('2023-11-01T00:00:00Z') } }),
        job({ id: 2, time_started: { $date: Date.parse('2023-11-10T00:00:00Z') } }),
      ],
      { since: '2023-11-05T00:00:00Z' },
    );
    expect(rows.map((row) => row['id'])).toEqual([2]);
  });

  it('accepts a bare date, an offset and a fractional second', async () => {
    // Every accepted form names one instant unambiguously; a bare date is UTC
    // midnight, which ECMAScript defines rather than leaves to the host.
    for (const since of [
      '2023-11-10',
      '2023-11-10T00:00Z',
      '2023-11-10T00:00:00Z',
      '2023-11-10T00:00:00.000Z',
      '2023-11-09T19:00:00-05:00',
    ]) {
      const rows = await listed(
        [
          job({ id: 1, time_started: { $date: Date.parse('2023-11-09T00:00:00Z') } }),
          job({ id: 2, time_started: { $date: Date.parse('2023-11-11T00:00:00Z') } }),
        ],
        { since },
      );
      expect(rows.map((row) => row['id'])).toEqual([2]);
    }
  });

  it('refuses a `since` it cannot read rather than falling back to the default', async () => {
    // Ignoring it would answer about the last day while the caller believes it
    // answered about the last month, and an empty result would then read as
    // "nothing failed".
    for (const since of [
      '',
      'yesterday',
      42,
      true,
      // No zone: Node reads this as local time, so the window would move by
      // the offset of whatever machine happens to run it.
      '2023-11-10 00:00:00',
      '2023-11-10T00:00:00',
      '2023-11-10T00:00:00+0500',
    ]) {
      await expect(listed([job()], { since })).rejects.toThrow('"since" must be an ISO 8601');
    }
    // The right shape and not a real date. The last three are the ones
    // `Date.parse` does not catch: a day the month does not have rolls over
    // into the next month and answers a real instant, so `2023-02-30` would
    // otherwise bound the report at the 2nd of March without saying so.
    for (const since of [
      '2023-13-01',
      '2023-11-10T25:00:00Z',
      '2023-11-10T00:00:00+25:00',
      '2023-02-30',
      '2023-11-31',
      '2023-02-29',
    ]) {
      await expect(listed([job()], { since })).rejects.toThrow('is not a real date');
    }
    // A leap day that exists is not caught with them — the check knows which
    // Februaries have a 29th rather than that none does.
    expect(await listed([job()], { since: '2020-02-29' })).toHaveLength(1);
  });

  it('treats an absent `since` as the default, and null as absent', async () => {
    for (const since of [undefined, null]) {
      const rows = await listed([job({ time_started: { $date: WINDOW_START - 1 } })], { since });
      expect(rows).toEqual([]);
    }
  });

  it('keeps every job when `failed_only` is not asked for', async () => {
    for (const state of [...SUCCEEDED, ...UNDER_WAY, ...FAILED]) {
      expect(await listed([job({ state })])).toHaveLength(1);
      expect(await listed([job({ state })], { failed_only: false })).toHaveLength(1);
    }
  });

  it('keeps only what has not succeeded when `failed_only` is set', async () => {
    for (const state of [...FAILED, 'A_LATER_RELEASE_STATE', '']) {
      // An unfamiliar state survives the filter: written as what to exclude,
      // so a failure state a later release adds is never silently dropped.
      expect(await listed([job({ state })], { failed_only: true })).toHaveLength(1);
    }
    for (const state of [...SUCCEEDED, ...UNDER_WAY]) {
      expect(await listed([job({ state })], { failed_only: true })).toEqual([]);
    }
  });

  it('refuses a `failed_only` that is not a boolean', async () => {
    // Coercing would answer a different question — every job the system ran,
    // where the caller asked what went wrong.
    for (const failed_only of ['true', 'false', 0, 1, '']) {
      await expect(listed([job()], { failed_only })).rejects.toThrow(
        '"failed_only" must be a boolean',
      );
    }
    // Absent is absent, and the default is false.
    for (const failed_only of [undefined, null]) {
      expect(await listed([job({ state: 'SUCCESS' })], { failed_only })).toHaveLength(1);
    }
  });

  it('passes a state through as the system spelled it, and an unreadable one as null', async () => {
    for (const state of [...SUCCEEDED, ...UNDER_WAY, ...FAILED, 'A_LATER_RELEASE_STATE']) {
      expect((await one({ state }))['state']).toBe(state);
    }
    expect((await one({ state: '' }))['state']).toBeNull();
  });

  it('reports a finish time only for a run that ended', async () => {
    for (const state of [...SUCCEEDED, ...FAILED]) {
      expect((await one({ state }))['finished_at']).toBe('2023-11-14T22:08:20.000Z');
    }
    // A job still going has not ended, so the time in its record is not a
    // finish time — and a state this tool could not read has not been shown to
    // be one either.
    for (const state of [...UNDER_WAY, '']) {
      expect((await one({ state }))['finished_at']).toBeNull();
    }
  });

  it('reports a progress it cannot read as null, and a null percent is not zero', async () => {
    expect((await one({ progress: { percent: 0, description: 'Starting' } }))[
      'progress_percent'
    ]).toBe(0);
    for (const unreadable of [undefined, null, 42, 'Scrubbing', {}, { percent: '50' }]) {
      const row = await one({ progress: unreadable });
      expect(row['progress_percent']).toBeNull();
      expect(row['progress_description']).toBeNull();
    }
    for (const percent of [Number.NaN, Number.POSITIVE_INFINITY]) {
      expect((await one({ progress: { percent } }))['progress_percent']).toBeNull();
    }
    for (const description of [undefined, null, '', 42]) {
      expect((await one({ progress: { percent: 10, description } }))[
        'progress_description'
      ]).toBeNull();
    }
  });

  it('carries the reason a job failed, and reports no reason as null', async () => {
    expect((await one({ state: 'FAILED', error: 'pool is unavailable' }))['error']).toBe(
      'pool is unavailable',
    );
    // A job in FAILED with a null error failed for a reason the system did not
    // record; it has not succeeded.
    for (const unreadable of [undefined, null, '', 42]) {
      expect((await one({ state: 'FAILED', error: unreadable }))['error']).toBeNull();
    }
  });
});

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

  it('names a failure that arrived as neither an Error nor any text', async () => {
    for (const [reason, text] of [
      ['nfs is down', 'nfs is down'],
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

describe('iscsi_list', () => {
  /**
   * A target as `iscsi.target.query` reports one. `rel_tgt_id`, `mode`,
   * `groups` and `auth_networks` are real fields of the payload the tool does
   * not name, and are here to be dropped.
   */
  const target = (over: Record<string, unknown> = {}) => ({
    id: 1,
    name: 'tgt0',
    alias: 'VMware datastore',
    rel_tgt_id: 1,
    mode: 'ISCSI',
    groups: [{ portal: 1, initiator: 1 }],
    auth_networks: [],
    ...over,
  });

  /**
   * An extent as `iscsi.extent.query` reports one. A `DISK` extent carries
   * BOTH `disk` and `path` — the system reports the device node in `path` too,
   * so `path` is not evidence that an extent is file-backed.
   */
  const extent = (over: Record<string, unknown> = {}) => ({
    id: 7,
    name: 'vmstore',
    type: 'DISK',
    disk: 'zvol/tank/vmstore',
    path: '/dev/zvol/tank/vmstore',
    enabled: true,
    locked: false,
    naa: '0x6589cfc000000',
    vendor: 'TrueNAS',
    serial: 'abc123',
    ...over,
  });

  /** A row of the join table mapping an extent onto a target at a LUN. */
  const mapping = (over: Record<string, unknown> = {}) => ({
    id: 4,
    target: 1,
    extent: 7,
    lunid: 0,
    ...over,
  });

  /** A live session as `iscsi.global.sessions` reports one. */
  const session = (over: Record<string, unknown> = {}) => ({
    initiator: 'iqn.1998-01.com.vmware:esx1',
    initiator_addr: '10.0.0.20',
    initiator_alias: 'esx1',
    target: 'tgt0',
    target_alias: 'VMware datastore',
    header_digest: null,
    data_digest: null,
    immediate_data: true,
    iser: false,
    offload: false,
    ...over,
  });

  type Listing = {
    targets: Record<string, unknown>[];
    failures: Record<string, unknown>[];
    unattributed_initiators: Record<string, unknown>[];
  };

  const listed = async (
    rows: Partial<Record<string, unknown>> = {},
    failures: Partial<Record<string, unknown>> = {},
  ): Promise<Listing> => {
    const { ctx } = failingSystem(
      {
        ['iscsi.target.query']: [target()],
        ['iscsi.extent.query']: [extent()],
        ['iscsi.targetextent.query']: [mapping()],
        ['iscsi.global.sessions']: [session()],
        ...rows,
      },
      failures,
    );
    return (await iscsiList.handler(ctx, {})) as Listing;
  };

  /** The single target of a listing, for the cases about one target's fields. */
  const onlyTarget = async (
    rows: Partial<Record<string, unknown>> = {},
    failures: Partial<Record<string, unknown>> = {},
  ): Promise<Record<string, unknown>> => (await listed(rows, failures)).targets[0];

  it('reports each target with its extents and connected initiators', async () => {
    expect(await listed()).toEqual({
      targets: [
        {
          id: 1,
          name: 'tgt0',
          alias: 'VMware datastore',
          mode: 'ISCSI',
          extents: [
            {
              id: 7,
              lun: 0,
              name: 'vmstore',
              type: 'DISK',
              path: '/dev/zvol/tank/vmstore',
              disk: 'zvol/tank/vmstore',
              enabled: true,
              locked: false,
            },
          ],
          initiators: [
            {
              initiator: 'iqn.1998-01.com.vmware:esx1',
              addresses: ['10.0.0.20'],
              alias: 'esx1',
            },
          ],
        },
      ],
      failures: [],
      unattributed_initiators: [],
    });
  });

  it('surfaces no field a later release adds', async () => {
    const listing = await listed({
      ['iscsi.target.query']: [target({ future_field: 'added by a later release' })],
      ['iscsi.extent.query']: [extent({ future_field: 'added by a later release' })],
      ['iscsi.targetextent.query']: [mapping({ future_field: 'added by a later release' })],
      ['iscsi.global.sessions']: [session({ future_field: 'added by a later release' })],
    });
    expect(Object.keys(listing.targets[0])).toEqual([
      'id',
      'name',
      'alias',
      'mode',
      'extents',
      'initiators',
    ]);
    expect(Object.keys((listing.targets[0]['extents'] as Record<string, unknown>[])[0])).toEqual([
      'id',
      'lun',
      'name',
      'type',
      'path',
      'disk',
      'enabled',
      'locked',
    ]);
    expect(Object.keys((listing.targets[0]['initiators'] as Record<string, unknown>[])[0])).toEqual(
      ['initiator', 'addresses', 'alias'],
    );
  });

  it('reads a target with no alias as having none', async () => {
    for (const missing of [null, undefined, '']) {
      expect(await onlyTarget({ ['iscsi.target.query']: [target({ alias: missing })] })).toMatchObject(
        { alias: null },
      );
    }
  });

  it('reads an initiator with no alias as having none', async () => {
    for (const missing of [null, '']) {
      const initiators = (
        await onlyTarget({ ['iscsi.global.sessions']: [session({ initiator_alias: missing })] })
      )['initiators'] as Record<string, unknown>[];
      expect(initiators[0]['alias']).toBeNull();
    }
  });

  it('maps every extent of a target, each at its own LUN', async () => {
    const extents = (
      await onlyTarget({
        ['iscsi.extent.query']: [extent(), extent({ id: 8, name: 'logs', type: 'FILE' })],
        ['iscsi.targetextent.query']: [mapping(), mapping({ id: 5, extent: 8, lunid: 1 })],
      })
    )['extents'] as Record<string, unknown>[];
    expect(extents.map((mapped) => [mapped['lun'], mapped['name']])).toEqual([
      [0, 'vmstore'],
      [1, 'logs'],
    ]);
  });

  it('reports the backing store of a DISK extent and of a FILE one', async () => {
    const extents = (
      await onlyTarget({
        ['iscsi.extent.query']: [
          extent(),
          extent({ id: 8, type: 'FILE', disk: null, path: '/mnt/tank/iscsi/logs' }),
        ],
        ['iscsi.targetextent.query']: [mapping(), mapping({ id: 5, extent: 8, lunid: 1 })],
      })
    )['extents'] as Record<string, unknown>[];
    // `path` is set on both kinds, so it is `disk` and `type` that separate
    // them — a caller reading a set `path` as "file-backed" would be wrong.
    expect(extents[0]).toMatchObject({
      type: 'DISK',
      disk: 'zvol/tank/vmstore',
      path: '/dev/zvol/tank/vmstore',
    });
    expect(extents[1]).toMatchObject({ type: 'FILE', disk: null, path: '/mnt/tank/iscsi/logs' });
  });

  it('reports an extent field the system omitted as null, not as a value', async () => {
    const extents = (
      await onlyTarget({
        ['iscsi.extent.query']: [{ id: 7, name: 'vmstore', naa: '0x1', vendor: 'TrueNAS' }],
      })
    )['extents'] as Record<string, unknown>[];
    // `enabled` and `locked` especially: false would say the extent is
    // definitely not serving, which the system did not report either way.
    expect(extents[0]).toEqual({
      id: 7,
      lun: 0,
      name: 'vmstore',
      type: null,
      path: null,
      disk: null,
      enabled: null,
      locked: null,
    });
  });

  it('keeps a mapping whose extent record is missing, marked by a null name', async () => {
    const extents = (await onlyTarget({ ['iscsi.extent.query']: [] }))[
      'extents'
    ] as Record<string, unknown>[];
    // The LUN was configured, and that is worth reporting; a real extent always
    // carries a name, so the null name is what says the record was not found.
    expect(extents).toEqual([
      {
        id: 7,
        lun: 0,
        name: null,
        type: null,
        path: null,
        disk: null,
        enabled: null,
        locked: null,
      },
    ]);
  });

  it('reports a target with nothing mapped to it as an empty extent list', async () => {
    expect(await onlyTarget({ ['iscsi.targetextent.query']: [] })).toMatchObject({ extents: [] });
  });

  it('reports a target with no session as an empty initiator list', async () => {
    expect(await onlyTarget({ ['iscsi.global.sessions']: [] })).toMatchObject({ initiators: [] });
  });

  it('distinguishes sessions that could not be read from a target with none', async () => {
    const listing = await listed({}, { ['iscsi.global.sessions']: new Error('service not running') });
    // Null rather than empty: an empty list would say nothing is connected,
    // which is the one answer this tool must not invent.
    expect(listing.targets[0]['initiators']).toBeNull();
    expect(listing.failures).toEqual([
      { source: 'initiators', error: 'service not running' },
    ]);
  });

  it('distinguishes extents that could not be read from a target with none', async () => {
    for (const method of ['iscsi.extent.query', 'iscsi.targetextent.query']) {
      const listing = await listed({}, { [method]: new Error('denied') });
      expect(listing.targets[0]['extents']).toBeNull();
      expect(listing.failures).toEqual([{ source: 'extents', error: 'denied' }]);
      // The other read is unaffected, which is why they are separate failures.
      expect(listing.targets[0]['initiators']).not.toBeNull();
    }
  });

  it('reports both reads failing without losing the targets themselves', async () => {
    const listing = await listed(
      {},
      {
        ['iscsi.extent.query']: new Error('denied'),
        ['iscsi.global.sessions']: new Error('service not running'),
      },
    );
    expect(listing.targets).toEqual([
      {
        id: 1,
        name: 'tgt0',
        alias: 'VMware datastore',
        mode: 'ISCSI',
        extents: null,
        initiators: null,
      },
    ]);
    expect(listing.failures).toEqual([
      { source: 'extents', error: 'denied' },
      { source: 'initiators', error: 'service not running' },
    ]);
  });

  it('names a failure that is not an Error, and one that says nothing', async () => {
    expect(
      (await listed({}, { ['iscsi.global.sessions']: 'connection reset' })).failures,
    ).toEqual([{ source: 'initiators', error: 'connection reset' }]);
    for (const silent of [new Error(''), { code: 500 }]) {
      expect((await listed({}, { ['iscsi.global.sessions']: silent })).failures).toEqual([
        { source: 'initiators', error: 'the system reported no reason' },
      ]);
    }
  });

  it('raises rather than reporting a system that serves nothing when targets fail', async () => {
    await expect(
      listed({}, { ['iscsi.target.query']: new Error('denied') }),
    ).rejects.toThrow('denied');
  });

  it('attributes a session naming its target by the full IQN', async () => {
    expect(
      await onlyTarget({
        ['iscsi.global.sessions']: [session({ target: 'iqn.2005-10.org.freenas.ctl:tgt0' })],
      }),
    ).toMatchObject({ initiators: [{ initiator: 'iqn.1998-01.com.vmware:esx1' }] });
  });

  it('groups each session under the one target it is on', async () => {
    const listing = await listed({
      ['iscsi.target.query']: [target(), target({ id: 2, name: 'tgt1', alias: null })],
      ['iscsi.global.sessions']: [
        session(),
        session({ initiator: 'iqn.1998-01.com.vmware:esx2', target: 'tgt1' }),
        session({ initiator: 'iqn.1998-01.com.vmware:esx3', target: 'tgt1' }),
      ],
    });
    expect(
      listing.targets.map((entry) => [
        entry['name'],
        (entry['initiators'] as Record<string, unknown>[]).map((one) => one['initiator']),
      ]),
    ).toEqual([
      ['tgt0', ['iqn.1998-01.com.vmware:esx1']],
      ['tgt1', ['iqn.1998-01.com.vmware:esx2', 'iqn.1998-01.com.vmware:esx3']],
    ]);
  });

  it('counts a multipathed initiator once, keeping every path it reaches from', async () => {
    // Two sessions, one initiator down two paths. Two entries would make one
    // host with two NICs read as two hosts attached to the target.
    const initiators = (
      await onlyTarget({
        ['iscsi.global.sessions']: [
          session(),
          session({ initiator_addr: '10.0.1.20' }),
          session({ initiator_addr: '10.0.0.20' }),
        ],
      })
    )['initiators'] as Record<string, unknown>[];
    expect(initiators).toEqual([
      {
        initiator: 'iqn.1998-01.com.vmware:esx1',
        addresses: ['10.0.0.20', '10.0.1.20'],
        alias: 'esx1',
      },
    ]);
  });

  it('takes an initiator alias from whichever session carries one', async () => {
    const initiators = (
      await onlyTarget({
        ['iscsi.global.sessions']: [
          session({ initiator_alias: null }),
          session({ initiator_addr: '10.0.1.20', initiator_alias: 'esx1' }),
        ],
      })
    )['initiators'] as Record<string, unknown>[];
    expect(initiators[0]).toMatchObject({ alias: 'esx1' });
  });

  it('keeps two different initiators on one target apart', async () => {
    const initiators = (
      await onlyTarget({
        ['iscsi.global.sessions']: [
          session(),
          session({ initiator: 'iqn.1998-01.com.vmware:esx2', initiator_addr: '10.0.0.21' }),
        ],
      })
    )['initiators'] as Record<string, unknown>[];
    expect(initiators.map((one) => one['initiator'])).toEqual([
      'iqn.1998-01.com.vmware:esx1',
      'iqn.1998-01.com.vmware:esx2',
    ]);
  });

  it('reports how a target is served, so an FC target is not read as idle', async () => {
    // An FC target holds no iSCSI session by definition, so without `mode` its
    // empty initiator list is indistinguishable from an idle iSCSI target.
    const listing = await listed({
      ['iscsi.target.query']: [
        target({ id: 2, name: 'fctgt', mode: 'FC' }),
        target({ id: 3, name: 'bothtgt', mode: 'BOTH' }),
        target({ mode: undefined }),
      ],
      ['iscsi.global.sessions']: [],
    });
    expect(listing.targets.map((entry) => [entry['name'], entry['mode'], entry['initiators']])).toEqual(
      [
        ['fctgt', 'FC', []],
        ['bothtgt', 'BOTH', []],
        ['tgt0', null, []],
      ],
    );
  });

  it('groups mappings under the target each names', async () => {
    const listing = await listed({
      ['iscsi.target.query']: [target(), target({ id: 2, name: 'tgt1' })],
      ['iscsi.extent.query']: [extent(), extent({ id: 8, name: 'logs' })],
      ['iscsi.targetextent.query']: [
        mapping(),
        mapping({ id: 5, target: 2, extent: 8, lunid: 0 }),
      ],
    });
    expect(
      listing.targets.map((entry) => [
        entry['name'],
        (entry['extents'] as Record<string, unknown>[]).map((one) => one['name']),
      ]),
    ).toEqual([
      ['tgt0', ['vmstore']],
      ['tgt1', ['logs']],
    ]);
  });

  it('reports a session it could not attribute rather than dropping it', async () => {
    const listing = await listed({
      ['iscsi.global.sessions']: [session({ target: 'some-other-spelling' })],
    });
    // Silently dropping it would leave the target reading as unused, which is
    // exactly the answer this tool exists to be trusted on.
    expect(listing.targets[0]['initiators']).toEqual([]);
    expect(listing.unattributed_initiators).toEqual([
      {
        initiator: 'iqn.1998-01.com.vmware:esx1',
        addresses: ['10.0.0.20'],
        alias: 'esx1',
        target: 'some-other-spelling',
      },
    ]);
  });

  it('groups unattributed sessions by target and initiator, as attributed ones are', async () => {
    const listing = await listed({
      ['iscsi.global.sessions']: [
        session({ target: 'unknown-a' }),
        session({ target: 'unknown-a', initiator_addr: '10.0.1.20' }),
        session({ target: 'unknown-b' }),
        session({ target: 'unknown-a', initiator: 'iqn.1998-01.com.vmware:esx2' }),
      ],
    });
    expect(
      listing.unattributed_initiators.map((one) => [
        one['target'],
        one['initiator'],
        one['addresses'],
      ]),
    ).toEqual([
      ['unknown-a', 'iqn.1998-01.com.vmware:esx1', ['10.0.0.20', '10.0.1.20']],
      ['unknown-a', 'iqn.1998-01.com.vmware:esx2', ['10.0.0.20']],
      ['unknown-b', 'iqn.1998-01.com.vmware:esx1', ['10.0.0.20']],
    ]);
  });

  it('leaves a session unattributed where two targets answer to its IQN', async () => {
    const listing = await listed({
      ['iscsi.target.query']: [target({ id: 2, name: 'a:tgt0' }), target()],
      ['iscsi.global.sessions']: [session({ target: 'iqn.2005-10.org.freenas.ctl:a:tgt0' })],
    });
    // Both `a:tgt0` and `tgt0` are colon-anchored suffixes of that IQN.
    // Reporting it against both would invent a connection to one of them.
    expect(listing.targets.map((entry) => entry['initiators'])).toEqual([[], []]);
    expect(listing.unattributed_initiators).toHaveLength(1);
  });

  it('prefers an exact target name over a suffix that also matches', async () => {
    const listing = await listed({
      ['iscsi.target.query']: [target({ id: 2, name: 'x:tgt0' }), target()],
      ['iscsi.global.sessions']: [session({ target: 'x:tgt0' })],
    });
    expect(listing.targets.map((entry) => [entry['name'], entry['initiators']])).toEqual([
      [
        'x:tgt0',
        [{ initiator: 'iqn.1998-01.com.vmware:esx1', addresses: ['10.0.0.20'], alias: 'esx1' }],
      ],
      ['tgt0', []],
    ]);
    expect(listing.unattributed_initiators).toEqual([]);
  });

  it('reports a system with no targets as an empty list', async () => {
    expect(
      await listed({ ['iscsi.target.query']: [], ['iscsi.global.sessions']: [] }),
    ).toEqual({
      targets: [],
      failures: [],
      unattributed_initiators: [],
    });
  });

  it('does not lose a live session on a system whose targets listed as none', async () => {
    // A session with no target to hang it on is the one case where the tool
    // has evidence of block storage in use and nothing to attribute it to.
    const listing = await listed({ ['iscsi.target.query']: [] });
    expect(listing.targets).toEqual([]);
    expect(listing.unattributed_initiators).toMatchObject([{ target: 'tgt0' }]);
  });

  it('issues every read before awaiting any of them', async () => {
    const { ctx, query } = failingSystem({
      ['iscsi.target.query']: [target()],
      ['iscsi.extent.query']: [extent()],
      ['iscsi.targetextent.query']: [mapping()],
      ['iscsi.global.sessions']: [session()],
    });
    const listing = iscsiList.handler(ctx, {});
    // Asserted before the handler is awaited at all, which is what makes this
    // about concurrency rather than order: every read is subscribed while the
    // handler still holds the thread, so a handler that awaited one read
    // before starting the next would have made one call by this point. The
    // same assertion after the await passes either way.
    expect(query.mock.calls.map((one) => one[0])).toEqual([
      'iscsi.target.query',
      'iscsi.extent.query',
      'iscsi.targetextent.query',
      'iscsi.global.sessions',
    ]);
    await listing;
  });
});

describe('nvmeof_list', () => {
  /**
   * A subsystem as `nvmet.subsys.query` reports one. `serial`, `pi_enable`,
   * `ana` and the three id lists are real fields of the payload the tool does
   * not name, and are here to be dropped — `hosts` and `namespaces` especially,
   * which the tool answers with the joined records rather than with these ids.
   */
  const subsystem = (over: Record<string, unknown> = {}) => ({
    id: 1,
    name: 'nvme0',
    subnqn: 'nqn.2011-06.com.truenas.ctl:nvme0',
    serial: 'a1b2c3d4e5f6',
    allow_any_host: false,
    pi_enable: false,
    qid_max: null,
    ieee_oui: null,
    ana: null,
    hosts: [3],
    namespaces: [7],
    ports: [1],
    ...over,
  });

  /**
   * A namespace as `nvmet.namespace.query` reports one: a ZVOL, which is the
   * kind that carries no `filesize` of its own.
   */
  const namespace = (over: Record<string, unknown> = {}) => ({
    id: 7,
    nsid: 1,
    subsys: { id: 1, name: 'nvme0' },
    device_type: 'ZVOL',
    device_path: 'zvol/tank/nvme0',
    filesize: null,
    device_uuid: '3fa85f64-5717-4562-b3fc-2c963f66afa6',
    device_nguid: 'e2b4c1a05f9d4c7e',
    enabled: true,
    locked: false,
    ...over,
  });

  /** A row of the join table allowing one host onto one subsystem. */
  const hostJoin = (over: Record<string, unknown> = {}) => ({
    id: 2,
    host: { id: 3, hostnqn: 'nqn.2014-08.org.nvmexpress:uuid:esx1', dhchap_key: null },
    subsys: { id: 1, name: 'nvme0' },
    ...over,
  });

  type Listing = {
    supported: boolean;
    unsupported_reason: string | null;
    subsystems: Record<string, unknown>[] | null;
    failures: Record<string, unknown>[];
    unattributed_namespaces: Record<string, unknown>[];
    unattributed_hosts: Record<string, unknown>[];
  };

  const listed = async (
    rows: Partial<Record<string, unknown>> = {},
    failures: Partial<Record<string, unknown>> = {},
  ): Promise<Listing> => {
    const { ctx } = failingSystem(
      {
        ['nvmet.subsys.query']: [subsystem()],
        ['nvmet.namespace.query']: [namespace()],
        ['nvmet.host_subsys.query']: [hostJoin()],
        ...rows,
      },
      failures,
    );
    return (await nvmeofList.handler(ctx, {})) as Listing;
  };

  /** The single subsystem of a listing, for the cases about one's fields. */
  const onlySubsystem = async (
    rows: Partial<Record<string, unknown>> = {},
    failures: Partial<Record<string, unknown>> = {},
  ): Promise<Record<string, unknown>> => ((await listed(rows, failures)).subsystems ?? [])[0];

  it('reports each subsystem with its allowed hosts and its namespaces', async () => {
    expect(await listed()).toEqual({
      supported: true,
      unsupported_reason: null,
      subsystems: [
        {
          id: 1,
          name: 'nvme0',
          nqn: 'nqn.2011-06.com.truenas.ctl:nvme0',
          allow_any_host: false,
          hosts: ['nqn.2014-08.org.nvmexpress:uuid:esx1'],
          namespaces: [
            {
              id: 7,
              nsid: 1,
              device_type: 'ZVOL',
              device_path: 'zvol/tank/nvme0',
              size_bytes: null,
              enabled: true,
              locked: false,
            },
          ],
        },
      ],
      failures: [],
      unattributed_namespaces: [],
      unattributed_hosts: [],
    });
  });

  it('surfaces no field a later release adds', async () => {
    const listing = await listed({
      ['nvmet.subsys.query']: [subsystem({ future_field: 'added by a later release' })],
      ['nvmet.namespace.query']: [namespace({ future_field: 'added by a later release' })],
      ['nvmet.host_subsys.query']: [hostJoin({ future_field: 'added by a later release' })],
    });
    expect(Object.keys(listing)).toEqual([
      'supported',
      'unsupported_reason',
      'subsystems',
      'failures',
      'unattributed_namespaces',
      'unattributed_hosts',
    ]);
    const only = (listing.subsystems ?? [])[0];
    expect(Object.keys(only)).toEqual([
      'id',
      'name',
      'nqn',
      'allow_any_host',
      'hosts',
      'namespaces',
    ]);
    expect(Object.keys((only['namespaces'] as Record<string, unknown>[])[0])).toEqual([
      'id',
      'nsid',
      'device_type',
      'device_path',
      'size_bytes',
      'enabled',
      'locked',
    ]);
  });

  it('reports a subsystem with no namespaces as an empty list, not omitted', async () => {
    expect(await onlySubsystem({ ['nvmet.namespace.query']: [] })).toMatchObject({
      name: 'nvme0',
      namespaces: [],
    });
  });

  it('reports a subsystem no host is allowed onto as an empty list', async () => {
    expect(await onlySubsystem({ ['nvmet.host_subsys.query']: [] })).toMatchObject({ hosts: [] });
  });

  it('reports whether any host is admitted, so an empty list is not read as a bar', async () => {
    // With `allow_any_host` true the host list restricts nothing, and without
    // this field an empty one reads as a subsystem nobody may attach to.
    const listing = await listed({
      ['nvmet.subsys.query']: [
        subsystem({ allow_any_host: true }),
        subsystem({ id: 2, name: 'nvme1', allow_any_host: 'yes' }),
      ],
      ['nvmet.host_subsys.query']: [],
    });
    expect(
      (listing.subsystems ?? []).map((one) => [one['name'], one['allow_any_host'], one['hosts']]),
    ).toEqual([
      ['nvme0', true, []],
      // Present but not a boolean settles neither, so it is null rather than
      // the false that would assert the list is the whole of who may attach.
      ['nvme1', null, []],
    ]);
  });

  it('reports the backing device of a ZVOL namespace and of a FILE one', async () => {
    const namespaces = (
      await onlySubsystem({
        ['nvmet.namespace.query']: [
          namespace(),
          namespace({
            id: 8,
            nsid: 2,
            device_type: 'FILE',
            device_path: '/mnt/tank/nvme/logs.img',
            filesize: 10737418240,
          }),
        ],
      })
    )['namespaces'] as Record<string, unknown>[];
    // A ZVOL takes its size from the zvol and reports none here. Null is that
    // unlearned size — reporting 0 would say the namespace holds nothing.
    expect(namespaces[0]).toMatchObject({ device_type: 'ZVOL', size_bytes: null });
    expect(namespaces[1]).toMatchObject({
      device_type: 'FILE',
      device_path: '/mnt/tank/nvme/logs.img',
      size_bytes: 10737418240,
    });
  });

  it('reports a namespace field the system omitted or garbled as null', async () => {
    const namespaces = (
      await onlySubsystem({
        ['nvmet.namespace.query']: [
          { subsys: { id: 1 }, device_uuid: 'u', nsid: 'first', filesize: Number.NaN },
        ],
      })
    )['namespaces'] as Record<string, unknown>[];
    // `enabled` and `locked` especially: false would say the namespace is
    // definitely not serving, which the system did not report either way.
    expect(namespaces[0]).toEqual({
      id: null,
      nsid: null,
      device_type: null,
      device_path: null,
      size_bytes: null,
      enabled: null,
      locked: null,
    });
  });

  it('reads a subsystem field the system omitted as having none', async () => {
    expect(
      await onlySubsystem({ ['nvmet.subsys.query']: [{ id: 1, serial: 'a1b2c3' }] }),
    ).toMatchObject({ name: null, nqn: null, allow_any_host: null });
    for (const missing of [null, undefined, '']) {
      expect(
        await onlySubsystem({ ['nvmet.subsys.query']: [subsystem({ subnqn: missing })] }),
      ).toMatchObject({ nqn: null });
    }
  });

  it('groups namespaces and hosts under the subsystem each names', async () => {
    const listing = await listed({
      ['nvmet.subsys.query']: [subsystem(), subsystem({ id: 2, name: 'nvme1' })],
      ['nvmet.namespace.query']: [
        namespace(),
        namespace({ id: 8, nsid: 1, subsys: { id: 2 }, device_path: 'zvol/tank/nvme1' }),
        namespace({ id: 9, nsid: 2, device_path: 'zvol/tank/nvme0b' }),
      ],
      ['nvmet.host_subsys.query']: [
        hostJoin(),
        hostJoin({
          id: 5,
          subsys: { id: 2 },
          host: { id: 4, hostnqn: 'nqn.2014-08.org.nvmexpress:uuid:esx2' },
        }),
        hostJoin({ id: 6, host: { id: 4, hostnqn: 'nqn.2014-08.org.nvmexpress:uuid:esx2' } }),
      ],
    });
    expect(
      (listing.subsystems ?? []).map((one) => [
        one['name'],
        one['hosts'],
        (one['namespaces'] as Record<string, unknown>[]).map((each) => each['device_path']),
      ]),
    ).toEqual([
      [
        'nvme0',
        ['nqn.2014-08.org.nvmexpress:uuid:esx1', 'nqn.2014-08.org.nvmexpress:uuid:esx2'],
        ['zvol/tank/nvme0', 'zvol/tank/nvme0b'],
      ],
      ['nvme1', ['nqn.2014-08.org.nvmexpress:uuid:esx2'], ['zvol/tank/nvme1']],
    ]);
  });

  it('reports a row the system did not attribute to a subsystem rather than dropping it', async () => {
    // Filing it under a subsystem it may not belong to would report a namespace
    // on the wrong device, and a host as allowed onto one it is not. Dropping
    // it instead leaves an empty list saying the subsystem has none, which is
    // the answer that gets acted on — so it is reported beside the listing.
    const listing = await listed({
      ['nvmet.namespace.query']: [namespace({ subsys: { name: 'nvme0' } })],
      ['nvmet.host_subsys.query']: [hostJoin({ subsys: {} })],
    });
    expect((listing.subsystems ?? [])[0]).toMatchObject({ namespaces: [], hosts: [] });
    expect(listing.unattributed_namespaces).toEqual([
      {
        id: 7,
        nsid: 1,
        device_type: 'ZVOL',
        device_path: 'zvol/tank/nvme0',
        size_bytes: null,
        enabled: true,
        locked: false,
        // The record named a name and no id, so the name is what is left to
        // report it by. Both are null where it named neither, as here for the
        // host row.
        subsystem_id: null,
        subsystem: 'nvme0',
      },
    ]);
    expect(listing.unattributed_hosts).toEqual([
      {
        hostnqn: 'nqn.2014-08.org.nvmexpress:uuid:esx1',
        subsystem_id: null,
        subsystem: null,
      },
    ]);
    expect(listing.failures).toEqual([]);
  });

  it('reports a row naming a subsystem the listing does not contain', async () => {
    // The id is readable and answers to nothing, which drops the row as surely
    // as an unreadable one: it is filed under a key no subsystem ever reads.
    const listing = await listed({
      ['nvmet.namespace.query']: [namespace({ subsys: { id: 99, name: 'nvme9' } })],
      ['nvmet.host_subsys.query']: [hostJoin({ subsys: { id: 99, name: 'nvme9' } })],
    });
    expect((listing.subsystems ?? [])[0]).toMatchObject({ namespaces: [], hosts: [] });
    expect(listing.unattributed_namespaces).toMatchObject([
      { id: 7, subsystem_id: 99, subsystem: 'nvme9' },
    ]);
    expect(listing.unattributed_hosts).toEqual([
      {
        hostnqn: 'nqn.2014-08.org.nvmexpress:uuid:esx1',
        subsystem_id: 99,
        subsystem: 'nvme9',
      },
    ]);
    expect(listing.failures).toEqual([]);
  });

  it('reports a host row carrying no NQN rather than listing a nameless entry', async () => {
    for (const missing of [null, '', undefined]) {
      const listing = await listed({
        ['nvmet.host_subsys.query']: [hostJoin({ host: { id: 3, hostnqn: missing } })],
      });
      expect((listing.subsystems ?? [])[0]).toMatchObject({ hosts: [] });
      // The one kind that names a subsystem and still cannot be listed under
      // it: the grant is real, and there is no name to put in a list of names.
      expect(listing.unattributed_hosts).toEqual([
        { hostnqn: null, subsystem_id: 1, subsystem: 'nvme0' },
      ]);
    }
  });

  it('attributes nothing to a subsystem the system did not number', async () => {
    const listing = await listed({ ['nvmet.subsys.query']: [subsystem({ id: 'nvme0' })] });
    // Null as for a read that failed, because there is no id to join on — and
    // an empty `failures` is what tells this apart from that.
    expect((listing.subsystems ?? [])[0]).toEqual({
      id: null,
      name: 'nvme0',
      nqn: 'nqn.2011-06.com.truenas.ctl:nvme0',
      allow_any_host: false,
      hosts: null,
      namespaces: null,
    });
    expect(listing.failures).toEqual([]);
    // The rows named a subsystem this listing cannot answer to, so they are
    // reported rather than lost with the id that would have placed them.
    expect(listing.unattributed_namespaces).toMatchObject([{ id: 7, subsystem_id: 1 }]);
    expect(listing.unattributed_hosts).toMatchObject([{ subsystem_id: 1 }]);
  });

  it('reports nothing as unattributed where the read that would fill it failed', async () => {
    // Empty because no row was read to place, not because every row was placed.
    // `failures` is what carries the difference.
    const listing = await listed(
      {},
      {
        ['nvmet.namespace.query']: new Error('denied'),
        ['nvmet.host_subsys.query']: new Error('denied'),
      },
    );
    expect(listing.unattributed_namespaces).toEqual([]);
    expect(listing.unattributed_hosts).toEqual([]);
    expect(listing.failures).toHaveLength(2);
  });

  it('distinguishes namespaces that could not be read from a subsystem with none', async () => {
    const listing = await listed({}, { ['nvmet.namespace.query']: new Error('denied') });
    // Null rather than empty: an empty list would say the subsystem exports
    // nothing, which is the one answer this tool must not invent.
    expect((listing.subsystems ?? [])[0]).toMatchObject({ namespaces: null });
    expect((listing.subsystems ?? [])[0]).not.toMatchObject({ hosts: null });
    expect(listing.failures).toEqual([{ source: 'namespaces', error: 'denied' }]);
  });

  it('distinguishes hosts that could not be read from a subsystem with none', async () => {
    const listing = await listed({}, { ['nvmet.host_subsys.query']: new Error('denied') });
    expect((listing.subsystems ?? [])[0]).toMatchObject({ hosts: null });
    expect((listing.subsystems ?? [])[0]).not.toMatchObject({ namespaces: null });
    expect(listing.failures).toEqual([{ source: 'hosts', error: 'denied' }]);
  });

  it('reports both reads failing without losing the subsystems themselves', async () => {
    const listing = await listed(
      {},
      {
        ['nvmet.namespace.query']: new Error('denied'),
        ['nvmet.host_subsys.query']: new Error('service not running'),
      },
    );
    expect(listing.subsystems).toEqual([
      {
        id: 1,
        name: 'nvme0',
        nqn: 'nqn.2011-06.com.truenas.ctl:nvme0',
        allow_any_host: false,
        hosts: null,
        namespaces: null,
      },
    ]);
    expect(listing.failures).toEqual([
      { source: 'namespaces', error: 'denied' },
      { source: 'hosts', error: 'service not running' },
    ]);
  });

  it('names a failure the system sent as an object rather than an Error', async () => {
    // What a failed call actually rejects with: the client's own error types
    // are a middleware object carrying `reason` and a JSON-RPC one carrying
    // `message`. Reading neither reported every real failure as silent.
    for (const [reason, error] of [
      ['connection reset', 'connection reset'],
      [{ reason: 'Not authorized' }, 'Not authorized'],
      [{ code: 500, message: 'Internal error' }, 'Internal error'],
      [new Error(''), 'the system reported no reason'],
      [{ code: 500 }, 'the system reported no reason'],
      [504, 'the system reported no reason'],
    ] as [unknown, string][]) {
      expect((await listed({}, { ['nvmet.host_subsys.query']: reason })).failures).toEqual([
        { source: 'hosts', error },
      ]);
    }
  });

  it('reports a system whose version has no NVMe-oF as unsupported, not as empty', async () => {
    // Every spelling of "no such method" the client's error types allow: the
    // JSON-RPC code, the middleware's error name, either text field, and the
    // nested `data` a JSON-RPC error wraps a middleware one in.
    for (const reason of [
      new Error('[ENOMETHOD] Method "nvmet.subsys.query" not found'),
      '[ENOMETHOD] no such method',
      { code: -32601, message: 'Method not found' },
      { errname: 'ENOMETHOD', reason: 'Method does not exist' },
      { reason: '[ENOMETHOD] Method does not exist' },
      { message: '[ENOMETHOD] Method does not exist' },
      { code: -32000, message: 'call failed', data: { errname: 'ENOMETHOD', reason: 'gone' } },
    ]) {
      expect(await listed({}, { ['nvmet.subsys.query']: reason })).toMatchObject({
        supported: false,
        subsystems: null,
        // The other two reads fail the same way on such a system; naming them
        // would report one absent feature three times, as three defects. No row
        // was read either, so nothing was left out of a list.
        failures: [],
        unattributed_namespaces: [],
        unattributed_hosts: [],
      });
    }
    expect(
      (await listed({}, { ['nvmet.subsys.query']: { code: -32601, message: 'Method not found' } }))
        .unsupported_reason,
    ).toBe('Method not found');
  });

  it('raises rather than calling a read it could not make unsupported', async () => {
    // "This system has no NVMe-oF" is a claim about the system, and a denied or
    // dropped read is evidence for no such claim.
    await expect(listed({}, { ['nvmet.subsys.query']: new Error('denied') })).rejects.toThrow(
      'denied',
    );
    await expect(
      listed({}, { ['nvmet.subsys.query']: { code: -32000, message: 'connection reset' } }),
    ).rejects.toEqual({ code: -32000, message: 'connection reset' });
    await expect(listed({}, { ['nvmet.subsys.query']: 'connection reset' })).rejects.toBe(
      'connection reset',
    );
    await expect(listed({}, { ['nvmet.subsys.query']: null })).rejects.toBeNull();
  });

  it('reports a system that has NVMe-oF and no subsystems as an empty list', async () => {
    expect(
      await listed({
        ['nvmet.subsys.query']: [],
        ['nvmet.namespace.query']: [],
        ['nvmet.host_subsys.query']: [],
      }),
    ).toEqual({
      supported: true,
      unsupported_reason: null,
      subsystems: [],
      failures: [],
      unattributed_namespaces: [],
      unattributed_hosts: [],
    });
  });

  it('issues every read before awaiting any of them', async () => {
    const { ctx, query } = failingSystem({
      ['nvmet.subsys.query']: [subsystem()],
      ['nvmet.namespace.query']: [namespace()],
      ['nvmet.host_subsys.query']: [hostJoin()],
    });
    const listing = nvmeofList.handler(ctx, {});
    // Asserted before the handler is awaited at all, which is what makes this
    // about concurrency rather than order: a handler that awaited one read
    // before starting the next would have made one call by this point.
    expect(query.mock.calls.map((one) => one[0])).toEqual([
      'nvmet.subsys.query',
      'nvmet.namespace.query',
      'nvmet.host_subsys.query',
    ]);
    await listing;
  });
});

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

describe('network_interfaces', () => {
  /**
   * One row of `interface.query`. The nested `state` is spread over the default
   * rather than replaced, so a test naming one state field keeps the rest —
   * every field of the response is read out of that sub-object, and a fixture
   * that dropped it wholesale would test the absent-state path by accident.
   */
  const iface = (
    over: Record<string, unknown> = {},
    state: Record<string, unknown> | null = {},
  ) => ({
    id: 'eno1',
    name: 'eno1',
    fake: false,
    type: 'PHYSICAL',
    aliases: [],
    ipv4_dhcp: false,
    ipv6_auto: false,
    // The configured MTU, null on an interface left at the default. The
    // operational one lives in the state, and telling them apart is what the
    // fixture's two different numbers are for.
    mtu: null,
    state:
      state === null
        ? null
        : {
            name: 'eno1',
            orig_name: 'eno1',
            mtu: 1500,
            cloned: false,
            flags: ['UP', 'BROADCAST', 'RUNNING'],
            link_state: 'LINK_STATE_UP',
            media_type: 'Ethernet',
            media_subtype: 'autoselect',
            active_media_type: 'Ethernet',
            active_media_subtype: '1000baseT <full-duplex>',
            link_address: '00:11:22:33:44:55',
            permanent_link_address: '00:11:22:33:44:55',
            hardware_link_address: '00:11:22:33:44:55',
            aliases: [{ type: 'INET', address: '192.168.1.10', netmask: 24 }],
            ...state,
          },
    ...over,
  });

  const reported = async (rows: unknown[]): Promise<Record<string, unknown>[]> => {
    const { ctx } = fakeSystem({ ['interface.query']: rows });
    return (await networkInterfaces.handler(ctx, {})) as Record<string, unknown>[];
  };

  const one = async (over: Record<string, unknown> = {}, state: Record<string, unknown> | null = {}) =>
    (await reported([iface(over, state)]))[0] as Record<string, unknown>;

  it('reports the name, type, link, speed, MTU and addresses of an interface', async () => {
    expect(await one()).toEqual({
      name: 'eno1',
      type: 'PHYSICAL',
      link_state: 'LINK_STATE_UP',
      link_media: '1000baseT <full-duplex>',
      link_speed_mbps: 1000,
      mtu: 1500,
      addresses: [{ type: 'INET', address: '192.168.1.10', netmask: 24 }],
      vlan_parent: null,
      vlan_tag: null,
      members: null,
    });
  });

  it('returns no field the tool does not name, on the row or in the state', async () => {
    const result = await one(
      { future_field: 'added by a later release' },
      {
        future_state_field: 'added by a later release',
        // The state's three own link-address fields, all given one value that
        // nothing else in this fixture carries. A LINK-type alias holds a
        // hardware address too and IS returned, as the description says, so it
        // is given a different one: what must not appear below is the address
        // only the dropped fields carry, which a shared value could not show.
        link_address: 'aa:bb:cc:dd:ee:ff',
        permanent_link_address: 'aa:bb:cc:dd:ee:ff',
        hardware_link_address: 'aa:bb:cc:dd:ee:ff',
        aliases: [{ type: 'LINK', address: '00:11:22:33:44:55', netmask: null }],
      },
    );
    expect(Object.keys(result)).toEqual([
      'name',
      'type',
      'link_state',
      'link_media',
      'link_speed_mbps',
      'mtu',
      'addresses',
      'vlan_parent',
      'vlan_tag',
      'members',
    ]);
    // Against the whole serialized row rather than its top-level keys: a field
    // that reached a nested address or member entry would pass a key check and
    // still be in front of the caller. The hardware address is in the fixture's
    // state and is not a field this tool names.
    const serialized = JSON.stringify(result);
    for (const dropped of ['added by a later release', 'aa:bb:cc:dd:ee:ff', 'BROADCAST']) {
      expect(serialized).not.toContain(dropped);
    }
    // And the alias that legitimately carries a hardware address survives, so
    // the assertion above is about the fields this tool drops rather than about
    // the fixture happening to hold no LINK alias.
    expect(serialized).toContain('00:11:22:33:44:55');
  });

  it('reads the negotiated speed out of every media spelling it can', async () => {
    const speeds = await Promise.all(
      [
        '1000baseT <full-duplex>',
        '100baseTX',
        '10Gbase-SR4',
        '2.5GbaseT',
        '1000Mb/s',
        '10Gb/s',
        '40GBASE-LR4',
      ].map(async (active_media_subtype) =>
        (await one({}, { active_media_subtype }))['link_speed_mbps'],
      ),
    );
    expect(speeds).toEqual([1000, 100, 10000, 2500, 1000, 10000, 40000]);
  });

  it('reports no speed, and keeps the media text, where no speed can be read', async () => {
    // Each of these is a media name the system genuinely sends and this tool
    // cannot read a magnitude from. The text survives so that a caller can see
    // what the null was read from.
    for (const active_media_subtype of ['autoselect', 'Unknown', 'baseT', '0baseT']) {
      expect(await one({}, { active_media_subtype })).toMatchObject({
        link_media: active_media_subtype,
        link_speed_mbps: null,
      });
    }
  });

  it('reports no speed where the magnitude is too large to be a number', async () => {
    // The regex bounds the shape of the leading token and not its length, so a
    // long enough run of digits overflows to Infinity — which is not a speed,
    // and must not be reported as one.
    expect(await one({}, { active_media_subtype: `${'9'.repeat(400)}baseT` })).toMatchObject({
      link_media: expect.stringContaining('9'),
      link_speed_mbps: null,
    });
  });

  it('reports a null link state and no media where the system named neither', async () => {
    // Null rather than down: an interface whose link the system did not report
    // must not read as one that is definitely without a link.
    expect(await one({}, { link_state: null, active_media_subtype: '' })).toMatchObject({
      link_state: null,
      link_media: null,
      link_speed_mbps: null,
    });
  });

  it('reports the operational MTU rather than the configured one', async () => {
    // The row's own `mtu` is null — the fixture's default, an interface left at
    // the system default — and the state's is 9000. An interface running at a
    // jumbo MTU must not report as one with no MTU.
    expect(await one({ mtu: null }, { mtu: 9000 })).toMatchObject({ mtu: 9000 });
  });

  it('reports the VLAN parent and tag, and null for both on anything else', async () => {
    expect(
      await one({ name: 'vlan10', type: 'VLAN', vlan_parent_interface: 'eno1', vlan_tag: 10 }),
    ).toMatchObject({ type: 'VLAN', vlan_parent: 'eno1', vlan_tag: 10 });
    expect(await one()).toMatchObject({ vlan_parent: null, vlan_tag: null });
  });

  it('reports every address the interface carries, whatever the netmask is', async () => {
    expect(
      await one(
        {},
        {
          aliases: [
            { type: 'INET', address: '192.168.1.10', netmask: 24 },
            { type: 'INET', address: '10.0.0.5', netmask: '255.255.255.0' },
            { type: 'INET6', address: 'fe80::1', netmask: 64 },
          ],
        },
      ),
    ).toMatchObject({
      addresses: [
        { type: 'INET', address: '192.168.1.10', netmask: 24 },
        { type: 'INET', address: '10.0.0.5', netmask: '255.255.255.0' },
        { type: 'INET6', address: 'fe80::1', netmask: 64 },
      ],
    });
  });

  it('reports an address field the system sent nothing readable for as null', async () => {
    expect(
      await one(
        {},
        {
          aliases: [
            { type: '', address: null, netmask: { nested: true } },
            // An empty netmask is no value, exactly as it is in the two fields
            // beside it, rather than a mask of no characters.
            { type: 'INET', address: '10.0.0.5', netmask: '' },
            'not one',
          ],
        },
      ),
    ).toMatchObject({
      addresses: [
        { type: null, address: null, netmask: null },
        { type: 'INET', address: '10.0.0.5', netmask: null },
        { type: null, address: null, netmask: null },
      ],
    });
  });

  it('tells an interface carrying no address apart from one whose addresses could not be read', async () => {
    // The empty list is a state that was read and holds no address; null is a
    // state that named no address list at all. Reporting the second as the
    // first would claim an interface has no address on no evidence.
    expect(await one({}, { aliases: [] })).toMatchObject({ addresses: [] });
    expect(await one({ state: { link_state: 'LINK_STATE_UP' } })).toMatchObject({
      addresses: null,
    });
  });

  it('reports a member that is down inside an otherwise-up aggregation', async () => {
    // The acceptance criterion this tool exists for. The bond has a link, so
    // nothing at its own level says anything is wrong; the failed port is
    // visible only in `members`.
    const rows = await reported([
      iface({ name: 'eno1' }, { link_state: 'LINK_STATE_UP' }),
      iface({ name: 'eno2' }, { link_state: 'LINK_STATE_DOWN' }),
      iface(
        { name: 'bond0', type: 'LINK_AGGREGATION', lag_ports: ['eno1', 'eno2'] },
        {
          link_state: 'LINK_STATE_UP',
          ports: [
            { name: 'eno1', flags: ['ACTIVE'] },
            { name: 'eno2', flags: [] },
          ],
        },
      ),
    ]);
    expect(rows[2]).toMatchObject({
      name: 'bond0',
      link_state: 'LINK_STATE_UP',
      members: [
        { name: 'eno1', link_state: 'LINK_STATE_UP', flags: ['ACTIVE'] },
        { name: 'eno2', link_state: 'LINK_STATE_DOWN', flags: [] },
      ],
    });
  });

  it('reports the members of a bridge, resolved the same way', async () => {
    const rows = await reported([
      iface({ name: 'br0', type: 'BRIDGE', bridge_members: ['eno1'] }, { ports: [] }),
      iface({ name: 'eno1' }, { link_state: 'LINK_STATE_DOWN' }),
    ]);
    // Named before its member's own row appears, which is why the link states
    // are collected across the whole response before any row is mapped.
    expect(rows[0]).toMatchObject({
      members: [{ name: 'eno1', link_state: 'LINK_STATE_DOWN', flags: null }],
    });
  });

  it('reports a member the response holds no entry for as unresolved, not down', async () => {
    const rows = await reported([
      iface({ name: 'bond0', type: 'LINK_AGGREGATION', lag_ports: ['eno1', 'missing'] }, { ports: [] }),
    ]);
    expect(rows[0]).toMatchObject({
      members: [
        { name: 'eno1', link_state: null, flags: null },
        { name: 'missing', link_state: null, flags: null },
      ],
    });
  });

  it('reports the members of a LAGG that also carries an empty bridge member list', async () => {
    // The middleware sends an interface record whole, so an aggregation can
    // carry both fields with only one of them populated. Preferring whichever
    // is present first would report this live bond as having no members.
    const rows = await reported([
      iface({ name: 'eno1' }, { link_state: 'LINK_STATE_UP' }),
      iface(
        {
          name: 'bond0',
          type: 'LINK_AGGREGATION',
          bridge_members: [],
          lag_ports: ['eno1'],
        },
        { ports: [{ name: 'eno1', flags: ['ACTIVE'] }] },
      ),
    ]);
    expect(rows[1]).toMatchObject({
      members: [{ name: 'eno1', link_state: 'LINK_STATE_UP', flags: ['ACTIVE'] }],
    });
  });

  it('reports an aggregate carrying two empty member lists as having no members', async () => {
    // Both fields are lists, so a member list WAS named — twice, and empty
    // both times. That is an aggregate with nothing under it, not one whose
    // members could not be read.
    expect(
      await one({ type: 'BRIDGE', bridge_members: [], lag_ports: [] }),
    ).toMatchObject({ members: [] });
  });

  it('reports a member whose own entry named no link state as unstatable, not down', async () => {
    const rows = await reported([
      iface({ name: 'eno1' }, { link_state: null }),
      iface({ name: 'bond0', type: 'LINK_AGGREGATION', lag_ports: ['eno1'] }, { ports: [] }),
    ]);
    // The same null an unresolved member gets: both are a link this tool
    // cannot state, and neither is a link that is down.
    expect(rows[1]).toMatchObject({ members: [{ name: 'eno1', link_state: null }] });
  });

  it('tells an aggregate with no members apart from one that named no list', async () => {
    const [empty, none] = await reported([
      iface({ name: 'br0', type: 'BRIDGE', bridge_members: [] }),
      // A bridge whose member list the system did not report at all: an empty
      // list would claim it is built from nothing, which is a different fact.
      iface({ name: 'br1', type: 'BRIDGE' }),
    ]);
    expect(empty).toMatchObject({ type: 'BRIDGE', members: [] });
    expect(none).toMatchObject({ type: 'BRIDGE', members: null });
  });

  it('drops a member entry and a flag the system did not name', async () => {
    const rows = await reported([
      iface(
        { name: 'bond0', type: 'LINK_AGGREGATION', lag_ports: ['eno1', 7, null] },
        { ports: [{ name: 'eno1', flags: ['ACTIVE', 4] }, { name: '' }, 'not a port'] },
      ),
    ]);
    expect(rows[0]).toMatchObject({ members: [{ name: 'eno1', flags: ['ACTIVE'] }] });
  });

  it('reports a member list the system sent as something other than a list as absent', async () => {
    expect(await one({ type: 'BRIDGE', bridge_members: 'eno1' })).toMatchObject({ members: null });
  });

  it('reports every state-derived field as absent where there is no state', async () => {
    // Null rather than fatal: the row still names the interface, its type and
    // its VLAN configuration, and losing all of that to answer none of the
    // question is the trade this refuses.
    expect(await one({ name: 'eno9', type: 'PHYSICAL' }, null)).toEqual({
      name: 'eno9',
      type: 'PHYSICAL',
      link_state: null,
      link_media: null,
      link_speed_mbps: null,
      mtu: null,
      addresses: null,
      vlan_parent: null,
      vlan_tag: null,
      members: null,
    });
  });

  it('reads a state the system sent as a list as no state at all', async () => {
    // An array is an object too, so this is the case the null check alone does
    // not cover: read as a record it would answer null for every field without
    // saying the shape was not the one this tool reads.
    // Set through the row override rather than the state one, which is spread
    // over the default state and so cannot carry a value that is not a record.
    expect(await one({ state: [] })).toMatchObject({
      link_state: null,
      addresses: null,
      mtu: null,
    });
  });

  it('reports an interface the system did not name, and never resolves against it', async () => {
    const rows = await reported([
      iface({ name: null }, { link_state: 'LINK_STATE_DOWN' }),
      iface({ name: 'bond0', type: 'LINK_AGGREGATION', lag_ports: ['eno1'] }, { ports: [] }),
    ]);
    // Still reported — a nameless interface is one the caller can see exists —
    // and it contributes no entry to the map the members resolve against, so
    // its link state cannot be attributed to a member.
    expect(rows[0]).toMatchObject({ name: null, link_state: 'LINK_STATE_DOWN' });
    expect(rows[1]).toMatchObject({ members: [{ name: 'eno1', link_state: null }] });
  });

  it('reports a type the system did not name as null', async () => {
    expect(await one({ type: null })).toMatchObject({ type: null });
  });

  it('reports an empty listing as an empty result', async () => {
    expect(await reported([])).toEqual([]);
  });

  it('asks for the interfaces with no filter, so that members resolve', async () => {
    const { ctx, query } = fakeSystem({ ['interface.query']: [] });
    await networkInterfaces.handler(ctx, {});
    expect(query).toHaveBeenCalledWith('interface.query');
  });
});

describe('network_config', () => {
  /**
   * The configured side, as `network.configuration.config` sends it. The fields
   * this tool does not name are here on purpose — the middleware sends them on
   * every call, and the test that nothing beyond the named fields survives is
   * only worth anything against a fixture that carries some.
   */
  const CONFIG = {
    id: 1,
    hostname: 'nas',
    domain: 'example.com',
    domains: ['lab.example.com'],
    ipv4gateway: '192.168.1.1',
    ipv6gateway: '',
    nameserver1: '192.168.1.1',
    nameserver2: '',
    nameserver3: '',
    httpproxy: 'http://proxy.invalid:3128',
    hosts: ['10.0.0.9 buildbox'],
    service_announcement: { netbios: false, mdns: true, wsd: true },
  };

  /** The effective side, as `network.general.summary` sends it. */
  const SUMMARY = {
    ips: { eno1: { IPV4: ['192.168.1.10/24'] } },
    default_routes: ['192.168.1.1'],
    nameservers: ['192.168.1.1'],
  };

  const route = (over: Record<string, unknown> = {}) => ({
    id: 1,
    destination: '10.0.0.0/8',
    gateway: '192.168.1.254',
    ...over,
  });

  /**
   * The three reads, canned. `config` and `summary` are spread over their
   * defaults so a test naming one field keeps the rest; passing `null` for the
   * summary is how a test says the system answered with nothing this tool can
   * read, which is a different case from a summary missing one field.
   */
  const read = async (
    config: Record<string, unknown> = {},
    summary: Record<string, unknown> | null = {},
    routes: unknown = [route()],
  ): Promise<Record<string, unknown>> => {
    const { ctx } = fakeSystem({
      ['network.configuration.config']: { ...CONFIG, ...config },
      ['network.general.summary']: summary === null ? null : { ...SUMMARY, ...summary },
      ['staticroute.query']: routes,
    });
    return (await networkConfig.handler(ctx, {})) as Record<string, unknown>;
  };

  /** The same three reads, with the named ones rejecting instead. */
  const readFailing = async (
    failures: Partial<Record<string, unknown>>,
  ): Promise<Record<string, unknown>> => {
    const { ctx } = failingSystem(
      {
        ['network.configuration.config']: CONFIG,
        ['network.general.summary']: SUMMARY,
        ['staticroute.query']: [route()],
      },
      failures,
    );
    return (await networkConfig.handler(ctx, {})) as Record<string, unknown>;
  };

  it('reports the hostname, DNS, gateways and static routes from both sides', async () => {
    expect(await read()).toEqual({
      hostname: 'nas',
      domain: 'example.com',
      search_domains: ['lab.example.com'],
      ipv4_gateway: { configured: '192.168.1.1', in_effect: '192.168.1.1', source: 'STATIC' },
      // Nothing configured and no IPv6 default route in effect: the family is
      // absent rather than unreadable, which is what a null source says.
      ipv6_gateway: { configured: null, in_effect: null, source: null },
      nameservers: [{ address: '192.168.1.1', source: 'STATIC', in_effect: true }],
      static_routes: [{ destination: '10.0.0.0/8', gateway: '192.168.1.254' }],
      failures: [],
    });
  });

  it('reports the answering node of an HA pair, not the pair-wide `hostname`', async () => {
    // What node B of an HA pair sends: `hostname` stays node A's on both
    // nodes, and `hostname_local` is what the middleware resolves per node.
    // Reading `hostname` here would report the PEER under a field the
    // description defines as this system's.
    expect(
      await read({ hostname: 'nas-a', hostname_b: 'nas-b', hostname_local: 'nas-b' }),
    ).toMatchObject({ hostname: 'nas-b' });
  });

  it('falls back to `hostname` where the system reports no local one', async () => {
    // `hostname_local` is added by a read-side extend rather than stored, so a
    // response without it is not a system without a hostname. The empty string
    // is how the middleware sends "no value" and must fall back the same way.
    expect(await read({ hostname: 'nas', hostname_local: '' })).toMatchObject({ hostname: 'nas' });
    expect(await read({ hostname: 'nas' })).toMatchObject({ hostname: 'nas' });
  });

  it('reports neither the HA peer nor the HA virtual hostname', async () => {
    const result = await read({
      hostname: 'nas-a',
      hostname_b: 'nas-b',
      hostname_virtual: 'nas-ha',
      hostname_local: 'nas-a',
    });
    expect(result).toMatchObject({ hostname: 'nas-a' });
    // Against the serialized result, not the keys: either could only reach a
    // caller as a value under a field this tool does name.
    expect(JSON.stringify(result)).not.toContain('nas-b');
    expect(JSON.stringify(result)).not.toContain('nas-ha');
  });

  it('returns no field the tool does not name, from either side', async () => {
    const result = await read(
      { future_field: 'added by a later release' },
      { future_field: 'added by a later release' },
    );
    expect(Object.keys(result)).toEqual([
      'hostname',
      'domain',
      'search_domains',
      'ipv4_gateway',
      'ipv6_gateway',
      'nameservers',
      'static_routes',
      'failures',
    ]);
    // Against the whole serialized result rather than its top-level keys: a
    // field that reached a gateway, nameserver or route entry would pass a key
    // check and still be in front of the caller. The proxy, the hosts entries,
    // the service announcement and the row id are all fields the middleware
    // sends and this tool does not name.
    const serialized = JSON.stringify(result);
    for (const dropped of [
      'added by a later release',
      'proxy.invalid',
      'buildbox',
      'netbios',
      'IPV4',
    ]) {
      expect(serialized).not.toContain(dropped);
    }
  });

  it('reports a value in effect and not configured here as automatic', async () => {
    // The DHCP case: nothing set on this system, and a gateway and two
    // nameservers in use regardless.
    expect(
      await read(
        { ipv4gateway: '', nameserver1: '', nameserver2: '', nameserver3: '' },
        { default_routes: ['192.168.1.254'], nameservers: ['1.1.1.1', '8.8.8.8'] },
      ),
    ).toMatchObject({
      ipv4_gateway: { configured: null, in_effect: '192.168.1.254', source: 'AUTOMATIC' },
      // In the order the system reported them: resolution is tried in that
      // order, so it is a fact rather than a presentation.
      nameservers: [
        { address: '1.1.1.1', source: 'AUTOMATIC', in_effect: true },
        { address: '8.8.8.8', source: 'AUTOMATIC', in_effect: true },
      ],
    });
  });

  it('reports a configured value that nothing is using as static and not in effect', async () => {
    // A configuration that has not been applied: `source` is decided by the
    // configured side alone, and `in_effect` is what shows it is not the value
    // the system is actually using.
    expect(
      await read(
        { ipv4gateway: '192.168.1.1', nameserver1: '9.9.9.9' },
        { default_routes: ['10.0.0.1'], nameservers: ['1.1.1.1'] },
      ),
    ).toMatchObject({
      ipv4_gateway: { configured: '192.168.1.1', in_effect: '10.0.0.1', source: 'STATIC' },
      nameservers: [
        { address: '1.1.1.1', source: 'AUTOMATIC', in_effect: true },
        { address: '9.9.9.9', source: 'STATIC', in_effect: false },
      ],
    });
  });

  it('splits the default routes it is given by address family', async () => {
    // One list carrying both, which is how the summary reports them.
    expect(
      await read(
        { ipv4gateway: '', ipv6gateway: 'fe80::1' },
        { default_routes: ['192.168.1.254', 'fe80::1'] },
      ),
    ).toMatchObject({
      ipv4_gateway: { configured: null, in_effect: '192.168.1.254', source: 'AUTOMATIC' },
      ipv6_gateway: { configured: 'fe80::1', in_effect: 'fe80::1', source: 'STATIC' },
    });
  });

  it('reports an IPv6 gateway in effect and not configured here as automatic', async () => {
    // DHCPv6 or a router advertisement — the tool cannot tell those apart and
    // names neither.
    expect(await read({}, { default_routes: ['2001:db8::1'] })).toMatchObject({
      ipv6_gateway: { configured: null, in_effect: '2001:db8::1', source: 'AUTOMATIC' },
    });
  });

  it('cannot confirm a configured value where the effective side says nothing', async () => {
    // Null rather than false: a server whose use cannot be confirmed must not
    // report as one that is definitely unused, and a gateway that is configured
    // is still configured.
    expect(await read({ nameserver1: '9.9.9.9' }, null)).toMatchObject({
      ipv4_gateway: { configured: '192.168.1.1', in_effect: null, source: 'STATIC' },
      nameservers: [{ address: '9.9.9.9', source: 'STATIC', in_effect: null }],
    });
  });

  it('names an effective read that failed, and reports nothing as automatic', async () => {
    expect(await readFailing({ ['network.general.summary']: new Error('summary refused') })).toMatchObject(
      {
        ipv4_gateway: { configured: '192.168.1.1', in_effect: null, source: 'STATIC' },
        nameservers: [{ address: '192.168.1.1', source: 'STATIC', in_effect: null }],
        failures: [{ source: 'effective_values', error: 'summary refused' }],
      },
    );
  });

  it('names a static route read that failed, and reports the routes as unreadable', async () => {
    // Null rather than the empty list of a system with no static route: the two
    // readings are opposite and only one of them is true here.
    expect(await readFailing({ ['staticroute.query']: new Error('routes refused') })).toMatchObject({
      static_routes: null,
      failures: [{ source: 'static_routes', error: 'routes refused' }],
    });
  });

  it('reports both failures where both supplementary reads fail', async () => {
    const result = await readFailing({
      ['network.general.summary']: new Error('summary refused'),
      ['staticroute.query']: new Error('routes refused'),
    });
    expect(result['failures']).toEqual([
      { source: 'effective_values', error: 'summary refused' },
      { source: 'static_routes', error: 'routes refused' },
    ]);
    // And the configured side is still answered in full, which is the whole
    // point of not letting either failure take the tool down.
    expect(result).toMatchObject({ hostname: 'nas', domain: 'example.com' });
  });

  it('fails the tool where the configuration itself cannot be read', async () => {
    // The one read that is the answer rather than a sharpening of it.
    const { ctx } = failingSystem({}, { ['network.configuration.config']: new Error('denied') });
    await expect(networkConfig.handler(ctx, {})).rejects.toThrow('denied');
  });

  it('states a reason for a failure however the client rejected', async () => {
    // A rejection is not necessarily an Error: the client rejects with whatever
    // the transport gave it, and a middleware error carries `reason` where a
    // JSON-RPC one carries `message`.
    const reasons = await Promise.all(
      [
        new Error('an error'),
        { reason: 'a middleware error' },
        { message: 'a json-rpc error' },
        'a bare string',
        new Error(''),
        {},
        null,
      ].map(async (rejection) => {
        const result = await readFailing({ ['staticroute.query']: rejection });
        return (result['failures'] as { error: string }[])[0].error;
      }),
    );
    expect(reasons).toEqual([
      'an error',
      'a middleware error',
      'a json-rpc error',
      'a bare string',
      'the system reported no reason',
      'the system reported no reason',
      'the system reported no reason',
    ]);
  });

  it('reports no static route configured as an empty list', async () => {
    expect(await read({}, {}, [])).toMatchObject({ static_routes: [], failures: [] });
  });

  it('reports a route listing sent as something other than a list as unreadable', async () => {
    // The read completed, so there is no failure to name — it simply answered
    // nothing this tool can read, and null says exactly that.
    expect(await read({}, {}, 'not a listing')).toMatchObject({
      static_routes: null,
      failures: [],
    });
  });

  it('reports a route destination or gateway the system did not name as null', async () => {
    expect(
      await read({}, {}, [route({ destination: '', gateway: null }), 'not a route']),
    ).toMatchObject({
      static_routes: [
        { destination: null, gateway: null },
        { destination: null, gateway: null },
      ],
    });
  });

  it('keeps no search domains apart from no search domain list at all', async () => {
    expect(await read({ domains: [] })).toMatchObject({ search_domains: [] });
    expect(await read({ domains: 'lab.example.com' })).toMatchObject({ search_domains: null });
  });

  it('drops a search domain the system did not name', async () => {
    expect(await read({ domains: ['lab.example.com', '', 7, null] })).toMatchObject({
      search_domains: ['lab.example.com'],
    });
  });

  it('reports a nameserver the system named twice once', async () => {
    expect(
      await read({ nameserver1: '' }, { nameservers: ['1.1.1.1', '1.1.1.1'] }),
    ).toMatchObject({
      nameservers: [{ address: '1.1.1.1', source: 'AUTOMATIC', in_effect: true }],
    });
  });

  it('reports a system with no DNS server at all as having none', async () => {
    expect(
      await read({ nameserver1: '', nameserver2: '', nameserver3: '' }, { nameservers: [] }),
    ).toMatchObject({ nameservers: [] });
  });

  it('reads every numbered nameserver slot, whichever are filled', async () => {
    // A third slot filled with the second left empty is ordinary rather than a
    // malformed configuration.
    expect(
      await read(
        { nameserver1: '1.1.1.1', nameserver2: '', nameserver3: '9.9.9.9' },
        { nameservers: [] },
      ),
    ).toMatchObject({
      nameservers: [
        { address: '1.1.1.1', source: 'STATIC', in_effect: false },
        { address: '9.9.9.9', source: 'STATIC', in_effect: false },
      ],
    });
  });

  it('reports a hostname or domain the system did not name as null', async () => {
    expect(await read({ hostname: '', domain: null })).toMatchObject({
      hostname: null,
      domain: null,
    });
  });

  it('reports an effective list sent as something other than a list as unread', async () => {
    // The summary is a record and its two fields are not lists: nothing can be
    // said about what is in effect, which is not the same as nothing being in
    // effect.
    expect(
      await read({}, { default_routes: '192.168.1.1', nameservers: '192.168.1.1' }),
    ).toMatchObject({
      ipv4_gateway: { configured: '192.168.1.1', in_effect: null, source: 'STATIC' },
      nameservers: [{ address: '192.168.1.1', source: 'STATIC', in_effect: null }],
    });
  });

  it('asks for the configuration, the summary and the static routes', async () => {
    const { ctx, call, query } = fakeSystem({
      ['network.configuration.config']: CONFIG,
      ['network.general.summary']: SUMMARY,
      ['staticroute.query']: [],
    });
    await networkConfig.handler(ctx, {});
    expect(call).toHaveBeenCalledWith('network.configuration.config');
    expect(call).toHaveBeenCalledWith('network.general.summary');
    expect(query).toHaveBeenCalledWith('staticroute.query');
  });
});

describe('certificates_list', () => {
  /**
   * A fixed present, so a day count is a fixed number rather than one that
   * moves with the clock. Only `Date` is faked, as in `tasks_recent_runs`: the
   * tool reads the clock and nothing here schedules anything.
   */
  const NOW = 1_700_000_000_000; // 2023-11-14T22:13:20.000Z

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * A certificate as `certificate.query` reports one, valid until five days
   * after {@link NOW}.
   *
   * `certificate`, `privatekey` and `chain_list` carry real-looking material
   * for the reason the job fixture's arguments carry a password: the test that
   * no key material survives the mapping is only worth anything if some was
   * there to survive. `renew_days`, `key_length`, `DN`, `serial` and
   * `fingerprint` are fields of the real payload that the tool does not name.
   */
  const cert = (over: Record<string, unknown> = {}) => ({
    id: 1,
    type: 8,
    name: 'truenas_default',
    certificate: '-----BEGIN CERTIFICATE-----\nSECRET-CERTIFICATE-MATERIAL\n-----END-----',
    privatekey: '-----BEGIN PRIVATE KEY-----\nSECRET-PRIVATE-KEY-MATERIAL\n-----END-----',
    CSR: null,
    acme_uri: null,
    domains_authenticators: null,
    renew_days: 10,
    acme: null,
    add_to_trusted_store: false,
    root_path: '/etc/certificates',
    certificate_path: '/etc/certificates/truenas_default.crt',
    privatekey_path: '/etc/certificates/truenas_default.key',
    csr_path: null,
    cert_type: 'CERTIFICATE',
    cert_type_existing: true,
    cert_type_CSR: false,
    cert_type_CA: false,
    chain_list: ['-----BEGIN CERTIFICATE-----\nSECRET-CHAIN-MATERIAL\n-----END-----'],
    key_length: 2048,
    key_type: 'RSA',
    country: 'US',
    state: 'Tennessee',
    city: 'Maryville',
    organization: 'iXsystems',
    organizational_unit: '',
    common: 'truenas.local',
    san: ['DNS:truenas.local', 'DNS:nas.local'],
    email: 'info@example.invalid',
    DN: '/C=US/ST=Tennessee/CN=truenas.local',
    subject_name_hash: 123456,
    extensions: {},
    digest_algorithm: 'SHA256',
    lifetime: 397,
    from: 'Tue Nov 14 12:00:00 2023',
    until: 'Mon Nov 20 12:00:00 2023',
    serial: 1,
    chain: false,
    fingerprint: 'AA:BB:CC',
    expired: false,
    parsed: true,
    issuer: 'Lets Encrypt',
    ...over,
  });

  const listed = async (
    rows: unknown[],
    args: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>[]> => {
    const { ctx } = fakeSystem({ ['certificate.query']: rows });
    return (await certificatesList.handler(ctx, args)) as Record<string, unknown>[];
  };

  /** One certificate, differing only in the fields the case is about. */
  const one = async (over: Record<string, unknown>): Promise<Record<string, unknown>> =>
    (await listed([cert(over)]))[0];

  /** The day count of one certificate expiring at `until`. */
  const days = async (until: unknown): Promise<unknown> =>
    (await one({ until }))['days_until_expiry'];

  it('maps a certificate to its names, issuer, validity dates and days left', async () => {
    expect(await listed([cert()])).toEqual([
      {
        name: 'truenas_default',
        common_name: 'truenas.local',
        subject_alternative_names: ['DNS:truenas.local', 'DNS:nas.local'],
        issuer: 'Lets Encrypt',
        not_before: 'Tue Nov 14 12:00:00 2023',
        not_after: 'Mon Nov 20 12:00:00 2023',
        days_until_expiry: 5,
        expired: false,
      },
    ]);
  });

  it('returns no certificate or private key material, and no field a later release adds', async () => {
    const rows = await listed([
      cert({ renewable: true, signed_certificates: 3, extensions_thing: 'new' }),
    ]);
    expect(Object.keys(rows[0])).toEqual([
      'name',
      'common_name',
      'subject_alternative_names',
      'issuer',
      'not_before',
      'not_after',
      'days_until_expiry',
      'expired',
    ]);
    expect(JSON.stringify(rows)).not.toContain('SECRET');
  });

  it('reports a certificate with no alternative name as having none', async () => {
    expect(await one({ san: [] })).toMatchObject({ subject_alternative_names: [] });
  });

  it('reports alternative names the system did not send as a list as unread', async () => {
    // Null rather than the empty list of a certificate that was read and
    // carries no alternative name.
    expect(await one({ san: null })).toMatchObject({ subject_alternative_names: null });
  });

  it('drops an alternative name the system named with nothing', async () => {
    expect(await one({ san: ['DNS:nas.local', '', 7] })).toMatchObject({
      subject_alternative_names: ['DNS:nas.local'],
    });
  });

  it('reports an issuer the system named as an object by that object name', async () => {
    expect(await one({ issuer: { id: 4, name: 'internal-ca' } })).toMatchObject({
      issuer: 'internal-ca',
    });
  });

  it('reports an issuer object that names nothing as no issuer', async () => {
    expect(await one({ issuer: { id: 4 } })).toMatchObject({ issuer: null });
  });

  it('reports an issuer the system sent in a shape this tool cannot read as none', async () => {
    // A list is an object too, and reading one as a record would answer null
    // for its `name` anyway — this states that it is the null of "no issuer
    // reported" rather than an accident.
    expect(await one({ issuer: ['internal-ca'] })).toMatchObject({ issuer: null });
  });

  it('reports a release that sends no issuer at all as reporting none', async () => {
    const without: Record<string, unknown> = { ...cert() };
    delete without['issuer'];
    expect((await listed([without]))[0]).toMatchObject({ issuer: null });
  });

  it('reports a name, common name or validity date the system left empty as null', async () => {
    expect(await one({ name: '', common: '', from: '', until: '' })).toMatchObject({
      name: null,
      common_name: null,
      not_before: null,
      not_after: null,
      days_until_expiry: null,
    });
  });

  it('passes the validity dates through as the system formatted them', async () => {
    expect(await one({ from: '2023-11-14T12:00:00Z', until: '2023-11-20T12:00:00Z' })).toMatchObject(
      { not_before: '2023-11-14T12:00:00Z', not_after: '2023-11-20T12:00:00Z' },
    );
  });

  it('counts the days left from an expiry carrying an explicit zone', async () => {
    expect(await days('2023-11-15T22:13:20+00:00')).toBe(1);
  });

  it('reads an expiry carrying no zone as UTC rather than as local time', async () => {
    // Exactly thirty days after NOW when read as UTC. Read as local time it
    // would move by this machine's offset, which is what the test pins.
    expect(await days('2023-12-14 22:13:20')).toBe(30);
  });

  it('reads a date with no time at all as midnight UTC', async () => {
    // Under two hours away, which is nought whole days rather than one.
    expect(await days('2023-11-15')).toBe(0);
  });

  it('reads the padded single-digit day of the middleware date format', async () => {
    expect(await days('Sun Nov  5 12:00:00 2023')).toBe(-10);
  });

  it('reports an expiry in a form it cannot read as unknown', async () => {
    expect(await days('whenever')).toBeNull();
  });

  it('reports an expiry whose month is not a month as unknown', async () => {
    expect(await days('Mon Foo 20 12:00:00 2023')).toBeNull();
  });

  it('reports an unreadable expiry that ends in a zone as unknown', async () => {
    // The zone is what sends this one to Date.parse, which answers NaN.
    expect(await days('whenever+01:00')).toBeNull();
  });

  it('reports a certificate with no expiry date as unknown rather than as unexpiring', async () => {
    expect(await days(null)).toBeNull();
  });

  it('reports an expired certificate with a negative day count', async () => {
    expect(await one({ until: 'Fri Nov 10 12:00:00 2023', expired: true })).toMatchObject({
      days_until_expiry: -5,
      expired: true,
    });
  });

  it("reports the system's own expiry verdict where it gave none as null", async () => {
    expect(await one({ expired: null })).toMatchObject({ expired: null });
  });

  it('returns every certificate when no window is asked for', async () => {
    const rows = await listed([
      cert({ name: 'soon' }),
      cert({ name: 'later', until: '2024-11-20 12:00:00' }),
      cert({ name: 'unknown', until: null }),
    ]);
    expect(rows.map((row) => row['name'])).toEqual(['soon', 'later', 'unknown']);
  });

  it('restricts the result to certificates inside the window, expired ones included', async () => {
    const rows = await listed(
      [
        cert({ name: 'expired', until: 'Fri Nov 10 12:00:00 2023' }),
        cert({ name: 'five-days' }),
        cert({ name: 'on-the-boundary', until: '2023-12-14 22:13:20' }),
        cert({ name: 'past-the-boundary', until: '2023-12-15 22:13:20' }),
      ],
      { expiring_within_days: 30 },
    );
    expect(rows.map((row) => row['name'])).toEqual(['expired', 'five-days', 'on-the-boundary']);
  });

  it('leaves a certificate whose expiry could not be read out of a window', async () => {
    const rows = await listed([cert({ name: 'unknown', until: null })], {
      expiring_within_days: 30,
    });
    expect(rows).toEqual([]);
  });

  it('treats an absent window as no window rather than as zero days', async () => {
    expect(await listed([cert()], { expiring_within_days: null })).toHaveLength(1);
  });

  it('refuses a window it cannot read rather than answering about every certificate', async () => {
    const { ctx, query } = fakeSystem({ ['certificate.query']: [cert()] });
    await expect(certificatesList.handler(ctx, { expiring_within_days: '30' })).rejects.toThrow(
      'must be a number of days',
    );
    // Refused before the call is spent, not after.
    expect(query).not.toHaveBeenCalled();
  });

  it('refuses a window that is a number naming no quantity', async () => {
    await expect(listed([cert()], { expiring_within_days: Number.NaN })).rejects.toThrow(
      'must be a number of days',
    );
  });

  it('asks for the certificates', async () => {
    const { ctx, query } = fakeSystem({ ['certificate.query']: [] });
    await certificatesList.handler(ctx, {});
    expect(query).toHaveBeenCalledWith('certificate.query');
  });
});

describe('cloud_credentials_list', () => {
  /**
   * A cloud credential as `cloudsync.credentials.query` reports one on the
   * version the client's types describe: `provider` an object whose `type`
   * names the provider and whose other fields are the secret.
   *
   * The secret fields carry real-looking material for the reason the
   * certificate fixture carries a private key — the test that no secret
   * survives the mapping is only worth anything if some was there to survive.
   */
  const credential = (over: Record<string, unknown> = {}) => ({
    id: 3,
    name: 'offsite-backups',
    provider: {
      type: 'S3',
      access_key_id: 'SECRET-ACCESS-KEY-ID',
      secret_access_key: 'SECRET-SECRET-ACCESS-KEY',
      endpoint: 's3.example.invalid',
      region: 'us-east-1',
    },
    ...over,
  });

  const listed = async (rows: unknown[]): Promise<Record<string, unknown>[]> => {
    const { ctx } = fakeSystem({ ['cloudsync.credentials.query']: rows });
    return (await cloudCredentialsList.handler(ctx, {})) as Record<string, unknown>[];
  };

  /** One credential, differing only in the fields the case is about. */
  const one = async (over: Record<string, unknown>): Promise<Record<string, unknown>> =>
    (await listed([credential(over)]))[0];

  it('maps a credential to its id, name and provider type', async () => {
    expect(await listed([credential()])).toEqual([
      { id: 3, name: 'offsite-backups', provider: 'S3' },
    ]);
  });

  it('returns no key, token or other secret material, whatever the provider is', async () => {
    const rows = await listed([
      credential({
        provider: {
          type: 'SFTP',
          host: 'sftp.example.invalid',
          user: 'backup',
          pass: 'SECRET-PASSWORD',
          private_key: 'SECRET-PRIVATE-KEY',
        },
      }),
      credential({
        id: 4,
        provider: { type: 'AZUREBLOB', account: 'acct', key: 'SECRET-ACCOUNT-KEY' },
      }),
    ]);
    expect(JSON.stringify(rows)).not.toContain('SECRET');
    expect(rows.map((row) => row['provider'])).toEqual(['SFTP', 'AZUREBLOB']);
  });

  it('carries no field the tool does not name, including one a later release adds', async () => {
    const rows = await listed([
      credential({
        attributes: { token: 'SECRET-OAUTH-TOKEN' },
        // A provider TrueNAS has not shipped yet, spelling its secret a way
        // this file has never seen. An allowlist keeps it out; a copy with the
        // known secrets removed would not.
        provider: { type: 'FUTURE_PROVIDER', unheard_of_secret: 'SECRET-NEW-SHAPE' },
        renewable: true,
      }),
    ]);
    expect(Object.keys(rows[0])).toEqual(['id', 'name', 'provider']);
    expect(JSON.stringify(rows)).not.toContain('SECRET');
  });

  it('reads a provider the system named as a bare string, as older releases send it', async () => {
    expect(
      await one({ provider: 'GOOGLE_DRIVE', attributes: { token: 'SECRET-OAUTH-TOKEN' } }),
    ).toEqual({ id: 3, name: 'offsite-backups', provider: 'GOOGLE_DRIVE' });
  });

  it('reports a provider it could not read as null rather than as no provider', async () => {
    expect(await one({ provider: null })).toMatchObject({ provider: null });
    expect(await one({ provider: 42 })).toMatchObject({ provider: null });
    expect(await one({ provider: ['S3'] })).toMatchObject({ provider: null });
    expect(await one({ provider: {} })).toMatchObject({ provider: null });
    expect(await one({ provider: { type: '' } })).toMatchObject({ provider: null });
    expect(await one({ provider: { type: 7 } })).toMatchObject({ provider: null });
  });

  it('reports a name the system gave no value for as null', async () => {
    expect(await one({ name: '' })).toMatchObject({ name: null });
    expect(await one({ name: null })).toMatchObject({ name: null });
  });

  it('reports an id it could not read as null, so no task can be joined to it', async () => {
    expect(await one({ id: null })).toMatchObject({ id: null });
    expect(await one({ id: '3' })).toMatchObject({ id: null });
    expect(await one({ id: Number.NaN })).toMatchObject({ id: null });
  });

  it('reads the same id cloudsync_tasks_list joins on', async () => {
    // The point of the tool: a task names its credential by id, and this is
    // what that id is looked up in. A test that only asserted the shape of each
    // result separately would not notice the two reading that id differently.
    const { ctx } = fakeSystem({
      ['cloudsync.query']: [
        {
          id: 1,
          description: 'Nightly offsite',
          direction: 'PUSH',
          path: '/mnt/tank/media',
          attributes: {},
          credentials: { id: 3, name: 'offsite-backups' },
          schedule: null,
          job: null,
        },
      ],
      ['cloudsync.credentials.query']: [credential({ id: 3 })],
    });
    const tasks = (await cloudsyncTasksList.handler(ctx, {})) as Record<string, unknown>[];
    const credentials = (await cloudCredentialsList.handler(ctx, {})) as Record<
      string,
      unknown
    >[];
    expect(tasks[0]['credential_id']).toBe(3);
    expect(credentials.map((row) => row['id'])).toContain(tasks[0]['credential_id']);
  });

  it('returns nothing for a system holding no cloud credentials', async () => {
    expect(await listed([])).toEqual([]);
  });

  it('asks for the cloud credentials', async () => {
    const { ctx, query } = fakeSystem({ ['cloudsync.credentials.query']: [] });
    await cloudCredentialsList.handler(ctx, {});
    expect(query).toHaveBeenCalledWith('cloudsync.credentials.query');
  });
});

describe('alert_settings', () => {
  /**
   * A destination as `alertservice.query` reports one on the version the
   * client's types describe: the type inside `attributes`, beside the secret
   * the destination authenticates with.
   *
   * The secret fields carry real-looking material for the reason the cloud
   * credential fixture does — the test that no secret survives the mapping is
   * only worth anything if some was there to survive.
   */
  const destination = (over: Record<string, unknown> = {}) => ({
    id: 1,
    name: 'ops-mail',
    level: 'WARNING',
    enabled: true,
    type__title: 'Email',
    attributes: { type: 'Mail', email: 'ops@example.invalid' },
    ...over,
  });

  /** The per-class settings, as `alertclasses.config` sends them. */
  const CLASSES = {
    id: 1,
    classes: {
      ZpoolCapacityWarning: { policy: 'NEVER' },
      SMARTError: { level: 'CRITICAL', proactive_support: true },
    },
  };

  const read = async (
    services: unknown[] = [destination()],
    classes: unknown = CLASSES,
  ): Promise<Record<string, unknown>> => {
    const { ctx } = fakeSystem({
      ['alertservice.query']: services,
      ['alertclasses.config']: classes,
    });
    return (await alertSettings.handler(ctx, {})) as Record<string, unknown>;
  };

  /** The destinations of a result, which is what most cases are about. */
  const destinations = async (services: unknown[]): Promise<Record<string, unknown>[]> =>
    (await read(services))['destinations'] as Record<string, unknown>[];

  /** One destination, differing only in the fields the case is about. */
  const one = async (over: Record<string, unknown>): Promise<Record<string, unknown>> =>
    (await destinations([destination(over)]))[0];

  /** The same two reads, with `alertclasses.config` rejecting instead. */
  const readFailing = async (reason: unknown): Promise<Record<string, unknown>> => {
    const { ctx } = failingSystem(
      { ['alertservice.query']: [destination()], ['alertclasses.config']: CLASSES },
      { ['alertclasses.config']: reason },
    );
    return (await alertSettings.handler(ctx, {})) as Record<string, unknown>;
  };

  it('reports each destination and each overridden class', async () => {
    expect(await read()).toEqual({
      destinations: [
        { name: 'ops-mail', type: 'Mail', enabled: true, minimum_level: 'WARNING' },
      ],
      class_overrides: [
        { class: 'SMARTError', policy: null, level: 'CRITICAL', proactive_support: true },
        {
          class: 'ZpoolCapacityWarning',
          policy: 'NEVER',
          level: null,
          proactive_support: null,
        },
      ],
      failures: [],
    });
  });

  it('returns no webhook URL, key or token, whatever the destination type is', async () => {
    const rows = await destinations([
      destination({
        name: 'pager',
        attributes: { type: 'PagerDuty', service_key: 'SECRET-SERVICE-KEY' },
      }),
      destination({
        name: 'chat',
        attributes: { type: 'Slack', url: 'https://hooks.invalid/SECRET-WEBHOOK' },
      }),
      destination({
        name: 'sns',
        attributes: {
          type: 'AWSSNS',
          region: 'us-east-1',
          topic_arn: 'arn:aws:sns:us-east-1:1:alerts',
          aws_access_key_id: 'SECRET-ACCESS-KEY-ID',
          aws_secret_access_key: 'SECRET-SECRET-ACCESS-KEY',
        },
      }),
    ]);
    expect(JSON.stringify(rows)).not.toContain('SECRET');
    expect(rows.map((row) => row['type'])).toEqual(['PagerDuty', 'Slack', 'AWSSNS']);
  });

  it('carries no field the tool does not name, including one a later release adds', async () => {
    const rows = await destinations([
      destination({
        // A destination type TrueNAS has not shipped yet, spelling its secret a
        // way this file has never seen. An allowlist keeps it out; a copy with
        // the known secrets removed would not.
        attributes: { type: 'FUTURE_SERVICE', unheard_of_secret: 'SECRET-NEW-SHAPE' },
        send_test_alert: true,
      }),
    ]);
    expect(Object.keys(rows[0])).toEqual(['name', 'type', 'enabled', 'minimum_level']);
    expect(JSON.stringify(rows)).not.toContain('SECRET');
  });

  it('reads a type an older release sent beside the attributes rather than inside them', async () => {
    expect(
      await one({ type: 'Mattermost', attributes: { url: 'https://chat.invalid/SECRET-HOOK' } }),
    ).toMatchObject({ type: 'Mattermost' });
  });

  it('does not fall back to the display title, which is a different vocabulary', async () => {
    // `type__title` is on the fixture throughout; a null type has to stay null
    // rather than becoming `Email`, because a caller cannot tell the two
    // spellings apart once they share a field.
    expect(await one({ attributes: {} })).toMatchObject({ type: null });
  });

  it('reports a type it could not read as null rather than as no type', async () => {
    expect(await one({ attributes: null })).toMatchObject({ type: null });
    expect(await one({ attributes: ['Mail'] })).toMatchObject({ type: null });
    expect(await one({ attributes: 'Mail' })).toMatchObject({ type: null });
    expect(await one({ attributes: { type: '' } })).toMatchObject({ type: null });
    expect(await one({ attributes: { type: 7 } })).toMatchObject({ type: null });
  });

  it('reports an enabled state the system did not send as null rather than as disabled', async () => {
    expect(await one({ enabled: false })).toMatchObject({ enabled: false });
    expect(await one({ enabled: undefined })).toMatchObject({ enabled: null });
    expect(await one({ enabled: null })).toMatchObject({ enabled: null });
    expect(await one({ enabled: 'true' })).toMatchObject({ enabled: null });
  });

  it('reports a name or a minimum severity the system gave no value for as null', async () => {
    expect(await one({ name: '', level: '' })).toMatchObject({
      name: null,
      minimum_level: null,
    });
    expect(await one({ name: null, level: null })).toMatchObject({
      name: null,
      minimum_level: null,
    });
  });

  it('returns an empty destination list for a system that sends its alerts nowhere', async () => {
    expect(await read([])).toMatchObject({ destinations: [] });
  });

  it('returns an empty override list for a system that has changed no class', async () => {
    expect(await read([destination()], { id: 1, classes: {} })).toMatchObject({
      class_overrides: [],
      failures: [],
    });
  });

  it('reports a class setting it could not read as nulls rather than dropping the class', async () => {
    const result = await read([destination()], {
      id: 1,
      classes: { UPSBatteryLow: null, ZpoolCapacityWarning: { policy: 7, level: [] } },
    });
    expect(result['class_overrides']).toEqual([
      { class: 'UPSBatteryLow', policy: null, level: null, proactive_support: null },
      { class: 'ZpoolCapacityWarning', policy: null, level: null, proactive_support: null },
    ]);
  });

  it('reports settings it could not read at all as null, which is not "nothing overridden"', async () => {
    // Distinct from the empty list above: an unreadable response must not read
    // as a system whose classes are all at their defaults.
    expect(await read([destination()], { id: 1 })).toMatchObject({ class_overrides: null });
    expect(await read([destination()], { id: 1, classes: [] })).toMatchObject({
      class_overrides: null,
    });
    expect(await read([destination()], null)).toMatchObject({ class_overrides: null });
  });

  it('names the class settings read when it fails, and still reports the destinations', async () => {
    const result = await readFailing(new Error('connection reset'));
    expect(result['class_overrides']).toBeNull();
    expect(result['failures']).toEqual([
      { source: 'class_overrides', error: 'connection reset' },
    ]);
    expect(result['destinations']).toEqual([
      { name: 'ops-mail', type: 'Mail', enabled: true, minimum_level: 'WARNING' },
    ]);
  });

  it('names why a read failed from whatever the client rejected with', async () => {
    const reasons = async (reason: unknown): Promise<unknown> =>
      (await readFailing(reason))['failures'];
    expect(await reasons({ reason: 'method not found' })).toEqual([
      { source: 'class_overrides', error: 'method not found' },
    ]);
    expect(await reasons({ message: 'not authorised' })).toEqual([
      { source: 'class_overrides', error: 'not authorised' },
    ]);
    expect(await reasons('timed out')).toEqual([
      { source: 'class_overrides', error: 'timed out' },
    ]);
    // A failure with no text of its own still has to read as a failure.
    expect(await reasons(new Error(''))).toEqual([
      { source: 'class_overrides', error: 'the system reported no reason' },
    ]);
    expect(await reasons({})).toEqual([
      { source: 'class_overrides', error: 'the system reported no reason' },
    ]);
    expect(await reasons(42)).toEqual([
      { source: 'class_overrides', error: 'the system reported no reason' },
    ]);
  });

  it('joins the class identifier alerts_list reports', async () => {
    // The point of pairing the two: an alert names its class, and this is what
    // says whether that class is being sent anywhere.
    const { ctx } = fakeSystem({
      ['alert.list']: [
        {
          uuid: 'a',
          id: 'a',
          klass: 'ZpoolCapacityWarning',
          level: 'WARNING',
          formatted: 'Pool tank is 85% full.',
          datetime: { $date: 1 },
          dismissed: false,
        },
      ],
      ['alertservice.query']: [destination()],
      ['alertclasses.config']: CLASSES,
    });
    const alerts = (await alertsList.handler(ctx, {})) as Record<string, unknown>[];
    const settings = (await alertSettings.handler(ctx, {})) as Record<string, unknown>;
    const overrides = settings['class_overrides'] as Record<string, unknown>[];
    expect(overrides.map((row) => row['class'])).toContain(alerts[0]['klass']);
  });

  it('asks for the destinations and the class settings', async () => {
    const { ctx, call, query } = fakeSystem({
      ['alertservice.query']: [],
      ['alertclasses.config']: CLASSES,
    });
    await alertSettings.handler(ctx, {});
    expect(query).toHaveBeenCalledWith('alertservice.query');
    expect(call).toHaveBeenCalledWith('alertclasses.config');
  });
});

describe('vms_list', () => {
  /**
   * A libvirt-backed VM as `vm.query` reports one: memory in MiB, the vCPU
   * allocation split across three fields, and the state nested in `status`
   * beside libvirt's own.
   *
   * The devices are on the fixture because they are the bulk of a real row and
   * the allowlist is what keeps them out.
   */
  const vm = (over: Record<string, unknown> = {}) => ({
    id: 1,
    name: 'buildbox',
    vcpus: 1,
    cores: 2,
    threads: 2,
    memory: 4096,
    min_memory: null,
    autostart: true,
    status: { state: 'RUNNING', pid: 1234, domain_state: 'RUNNING' },
    devices: [{ dtype: 'DISK', attributes: { path: '/dev/zvol/tank/buildbox' } }],
    ...over,
  });

  /**
   * An incus-backed VM as `virt.instance.query` reports one: memory already in
   * bytes, the CPU allocation a single string, and one flat status word.
   *
   * `environment` carries real-looking material for the reason the alert
   * destination fixture does — the test that it does not survive the mapping is
   * only worth anything if some was there to survive.
   */
  const instance = (over: Record<string, unknown> = {}) => ({
    id: 'web',
    name: 'web',
    type: 'VM',
    status: 'STOPPED',
    cpu: '4',
    memory: 8589934592,
    autostart: false,
    environment: { API_TOKEN: 'SECRET-GUEST-TOKEN' },
    raw: { config: { 'limits.memory': '8GiB' } },
    aliases: [],
    image: { os: 'Debian' },
    ...over,
  });

  const read = async (
    vms: unknown[] = [vm()],
    instances: unknown[] = [instance()],
  ): Promise<Record<string, unknown>> => {
    const { ctx } = fakeSystem({ ['vm.query']: vms, ['virt.instance.query']: instances });
    return (await vmsList.handler(ctx, {})) as Record<string, unknown>;
  };

  const rows = async (vms?: unknown[], instances?: unknown[]): Promise<Record<string, unknown>[]> =>
    (await read(vms, instances))['vms'] as Record<string, unknown>[];

  /** One libvirt VM, differing only in the fields the case is about. */
  const oneVm = async (over: Record<string, unknown>): Promise<Record<string, unknown>> =>
    (await rows([vm(over)], []))[0];

  /** One incus VM, the same way. */
  const oneInstance = async (over: Record<string, unknown>): Promise<Record<string, unknown>> =>
    (await rows([], [instance(over)]))[0];

  /** The same two reads, with one of them rejecting instead. */
  const readFailing = async (
    failures: Record<string, unknown>,
  ): Promise<Record<string, unknown>> => {
    const { ctx } = failingSystem(
      { ['vm.query']: [vm()], ['virt.instance.query']: [instance()] },
      failures,
    );
    return (await vmsList.handler(ctx, {})) as Record<string, unknown>;
  };

  it('reports a VM from each stack, tagged with the stack it came from', async () => {
    expect(await read()).toEqual({
      vms: [
        {
          source: 'vm',
          id: 1,
          name: 'buildbox',
          state: 'RUNNING',
          domain_state: 'RUNNING',
          vcpus: 4,
          cpu_set: null,
          memory_bytes: 4294967296,
          min_memory_bytes: null,
          autostart: true,
        },
        {
          source: 'virt_instance',
          id: 'web',
          name: 'web',
          state: 'STOPPED',
          domain_state: null,
          vcpus: 4,
          cpu_set: null,
          memory_bytes: 8589934592,
          min_memory_bytes: null,
          autostart: false,
        },
      ],
      failures: [],
    });
  });

  it('reports memory in bytes from both stacks, converting the MiB the vm stack stores', async () => {
    // 4096 MiB and 8 GiB, which is the whole point of converting: without it
    // the smaller VM reports the larger number.
    expect(await oneVm({ memory: 4096 })).toMatchObject({ memory_bytes: 4294967296 });
    expect(await oneInstance({ memory: 8589934592 })).toMatchObject({
      memory_bytes: 8589934592,
    });
    // Unreadable stays unreadable rather than being converted into a zero the
    // caller would read as a VM with no memory.
    expect(await oneVm({ memory: null })).toMatchObject({ memory_bytes: null });
    expect(await oneInstance({ memory: null })).toMatchObject({ memory_bytes: null });
  });

  it('reports a memory floor where the vm stack has one, in the same unit', async () => {
    expect(await oneVm({ min_memory: 1024 })).toMatchObject({ min_memory_bytes: 1073741824 });
  });

  it('counts vCPUs as sockets times cores times threads', async () => {
    // The guest sees four CPUs; `vcpus` alone says one.
    expect(await oneVm({ vcpus: 1, cores: 2, threads: 2 })).toMatchObject({ vcpus: 4 });
  });

  it('states no vCPU count where the vm stack did not report all three', async () => {
    // Not defaulted to 1: a guessed component is indistinguishable in the
    // result from one the system reported.
    expect(await oneVm({ threads: undefined })).toMatchObject({ vcpus: null });
    expect(await oneVm({ cores: 'two' })).toMatchObject({ vcpus: null });
  });

  it('reports a pinned CPU set verbatim and states no count for it', async () => {
    // How many CPUs `0-3` comes to is an inference about the host, not
    // something the system said.
    expect(await oneInstance({ cpu: '0-3' })).toMatchObject({ vcpus: null, cpu_set: '0-3' });
    expect(await oneInstance({ cpu: '1,3' })).toMatchObject({ vcpus: null, cpu_set: '1,3' });
    expect(await oneInstance({ cpu: '4' })).toMatchObject({ vcpus: 4, cpu_set: null });
    expect(await oneInstance({ cpu: null })).toMatchObject({ vcpus: null, cpu_set: null });
  });

  it('distinguishes a stopped VM from one in an error state', async () => {
    // On the incus stack the state word does it on its own.
    expect(await oneInstance({ status: 'ERROR' })).toMatchObject({ state: 'ERROR' });
    expect(await oneInstance({ status: 'STOPPED' })).toMatchObject({ state: 'STOPPED' });
    // On the libvirt stack both VMs read STOPPED and only the domain state
    // separates them, which is why it is reported beside rather than merged.
    const shutdown = await oneVm({ status: { state: 'STOPPED', domain_state: 'SHUTOFF' } });
    const crashed = await oneVm({ status: { state: 'STOPPED', domain_state: 'CRASHED' } });
    expect(shutdown).toMatchObject({ state: 'STOPPED', domain_state: 'SHUTOFF' });
    expect(crashed).toMatchObject({ state: 'STOPPED', domain_state: 'CRASHED' });
  });

  it('reports a state it could not read as null rather than as a state', async () => {
    expect(await oneVm({ status: null })).toMatchObject({ state: null, domain_state: null });
    expect(await oneVm({ status: ['RUNNING'] })).toMatchObject({ state: null });
    expect(await oneVm({ status: {} })).toMatchObject({ state: null, domain_state: null });
    expect(await oneVm({ name: '', id: null, autostart: 'yes' })).toMatchObject({
      name: null,
      id: null,
      autostart: null,
    });
  });

  it('returns no VMs and no failures on a system with none in either stack', async () => {
    expect(await read([], [])).toEqual({ vms: [], failures: [] });
  });

  it('reports a stack it could not read as a failure rather than as no VMs', async () => {
    // The distinction the empty list cannot carry: a system whose VMs all live
    // in the stack that failed is not a system without any.
    expect(await readFailing({ ['virt.instance.query']: new Error('unknown method') })).toEqual({
      vms: [expect.objectContaining({ source: 'vm', name: 'buildbox' })],
      failures: [{ source: 'virt_instance', error: 'unknown method' }],
    });
  });

  it('keeps the VMs of the stack that answered when the other one fails', async () => {
    const result = await readFailing({ ['vm.query']: new Error('service not running') });
    expect(result['vms']).toEqual([expect.objectContaining({ source: 'virt_instance' })]);
    expect(result['failures']).toEqual([{ source: 'vm', error: 'service not running' }]);
  });

  it('returns no VMs and both failures where neither stack could be read', async () => {
    const result = await readFailing({
      ['vm.query']: new Error('down'),
      ['virt.instance.query']: new Error('down'),
    });
    expect(result['vms']).toEqual([]);
    expect(result['failures']).toEqual([
      { source: 'vm', error: 'down' },
      { source: 'virt_instance', error: 'down' },
    ]);
  });

  it('names the reason whatever shape the client rejected with', async () => {
    const error = async (reason: unknown): Promise<unknown> =>
      ((await readFailing({ ['vm.query']: reason }))['failures'] as Record<string, unknown>[])[0][
        'error'
      ];
    expect(await error(new Error('an Error'))).toBe('an Error');
    expect(await error({ reason: 'a middleware error' })).toBe('a middleware error');
    expect(await error({ message: 'a JSON-RPC error' })).toBe('a JSON-RPC error');
    expect(await error('a bare string')).toBe('a bare string');
    // A failure with no text still has to read as a failure.
    expect(await error({})).toBe('the system reported no reason');
    expect(await error(new Error(''))).toBe('the system reported no reason');
    expect(await error(null)).toBe('the system reported no reason');
  });

  it('excludes containers, whether or not the middleware applied the filter', async () => {
    // An unrecognised filter is dropped rather than refused, and the result of
    // that is containers in a list of virtual machines.
    const listed = await rows([], [instance(), instance({ id: 'plex', type: 'CONTAINER' })]);
    expect(listed.map((row) => row['id'])).toEqual(['web']);
  });

  it('carries no field the tool does not name, including one a later release adds', async () => {
    const [libvirt, incus] = await rows(
      [vm({ enable_secure_boot: true })],
      [instance({ vnc_password: 'SECRET-VNC-PASSWORD', unheard_of_field: 'SECRET-NEW-SHAPE' })],
    );
    const named = [
      'source',
      'id',
      'name',
      'state',
      'domain_state',
      'vcpus',
      'cpu_set',
      'memory_bytes',
      'min_memory_bytes',
      'autostart',
    ];
    expect(Object.keys(libvirt)).toEqual(named);
    expect(Object.keys(incus)).toEqual(named);
    expect(JSON.stringify([libvirt, incus])).not.toContain('SECRET');
  });

  it('asks each stack for its own VMs', async () => {
    const { ctx, query } = fakeSystem({ ['vm.query']: [], ['virt.instance.query']: [] });
    await vmsList.handler(ctx, {});
    expect(query).toHaveBeenCalledWith('vm.query');
    expect(query).toHaveBeenCalledWith('virt.instance.query', [['type', '=', 'VM']]);
  });
});

describe('vm_logs', () => {
  const LOG_PATH = '/var/log/libvirt/qemu/1_buildbox.log';

  /** A libvirt VM as `vm.query` reports one; only the id and name are read here. */
  const vm = (over: Record<string, unknown> = {}) => ({
    id: 1,
    name: 'buildbox',
    vcpus: 1,
    cores: 1,
    threads: 1,
    memory: 4096,
    min_memory: null,
    autostart: true,
    status: { state: 'RUNNING', domain_state: 'RUNNING' },
    ...over,
  });

  /** An incus instance as `virt.instance.query` reports one. */
  const instance = (over: Record<string, unknown> = {}) => ({
    id: 'web',
    name: 'web',
    type: 'VM',
    status: 'RUNNING',
    cpu: '4',
    memory: 8589934592,
    autostart: false,
    ...over,
  });

  /** What the content seam answers a bounded read with. */
  const tail = (over: Partial<FileTail> = {}): FileTail => ({
    path: LOG_PATH,
    lines: ['starting up', 'ready'],
    truncated: false,
    ...over,
  });

  /**
   * A system with a content reader on it, which `fakeSystem` does not build:
   * the reader is the seam this tool reads through, and most of these cases
   * turn on what it answers.
   */
  const wired = (
    responses: Partial<Record<string, unknown>> = {
      ['vm.query']: [vm()],
      ['vm.log_file_path']: LOG_PATH,
    },
    readTail: (path: string, maxLines: number) => Promise<FileTail> = () => Promise.resolve(tail()),
  ) => {
    const { ctx, call, query } = fakeSystem(responses);
    const reader = vi.fn(readTail);
    ctx.system.files = { readTail: reader };
    return { ctx, call, query, reader };
  };

  /** The same, with one method rejecting instead. */
  const wiredFailing = (
    rows: Partial<Record<string, unknown>>,
    failures: Partial<Record<string, unknown>>,
  ) => {
    const { ctx, call, query } = failingSystem(rows, failures);
    ctx.system.files = { readTail: () => Promise.resolve(tail()) };
    return { ctx, call, query };
  };

  const read = async (
    args: Record<string, unknown> = { vm: 'buildbox' },
  ): Promise<Record<string, unknown>> =>
    (await vmLogs.handler(wired().ctx, args)) as Record<string, unknown>;

  it('reports the tail of the log of the VM it was asked for', async () => {
    expect(await read()).toEqual({
      source: 'vm',
      id: 1,
      name: 'buildbox',
      log_path: LOG_PATH,
      log_status: 'READ',
      log_error: null,
      requested_lines: 100,
      lines: ['starting up', 'ready'],
      truncated: false,
    });
  });

  it('matches a VM by its id, written as a number or as text', async () => {
    const { ctx, call } = wired({ ['vm.query']: [vm({ id: 7 })], ['vm.log_file_path']: LOG_PATH });
    expect(await vmLogs.handler(ctx, { vm: 7 })).toMatchObject({ id: 7, log_status: 'READ' });
    expect(await vmLogs.handler(ctx, { vm: '7' })).toMatchObject({ id: 7, log_status: 'READ' });
    // The path is asked for by id, whichever way the caller named the machine.
    expect(call).toHaveBeenCalledWith('vm.log_file_path', [7]);
  });

  it('bounds the lines it asks the reader for, and says which bound it applied', async () => {
    const { ctx, reader } = wired();
    expect(await vmLogs.handler(ctx, { vm: 'buildbox' })).toMatchObject({ requested_lines: 100 });
    expect(reader).toHaveBeenCalledWith(LOG_PATH, 100);
    expect(await vmLogs.handler(ctx, { vm: 'buildbox', lines: 5 })).toMatchObject({
      requested_lines: 5,
    });
    expect(reader).toHaveBeenCalledWith(LOG_PATH, 5);
  });

  it('refuses a line bound it cannot honour rather than quietly applying another', async () => {
    // A caller given 100 lines after asking for 1001 cannot tell that from a
    // log holding 100.
    for (const lines of [0, -1, 1001, 1.5, '10', true]) {
      await expect(read({ vm: 'buildbox', lines })).rejects.toThrow(
        /"lines" must be a whole number between 1 and 1000/,
      );
    }
    // Null and undefined are the argument not being given, which is what the
    // default is for — as `audit_log_query` reads its own `since`.
    for (const lines of [null, undefined]) {
      expect(await read({ vm: 'buildbox', lines })).toMatchObject({ requested_lines: 100 });
    }
  });

  it('refuses a vm argument that names no machine', async () => {
    // `vm` is required, so null is a caller naming nothing rather than a
    // default to fall back to — there is none.
    for (const named of ['', 1.5, true, {}, undefined, null]) {
      await expect(read({ vm: named })).rejects.toThrow(
        /"vm" must be the name of a virtual machine, or its numeric id/,
      );
    }
  });

  it('reports a VM that does not exist as an error naming it', async () => {
    const { ctx } = wired({ ['vm.query']: [], ['virt.instance.query']: [] });
    await expect(vmLogs.handler(ctx, { vm: 'ghost' })).rejects.toThrow(
      /No libvirt-backed virtual machine matching "ghost" exists on this system$/,
    );
  });

  it('says an incus instance has no retrievable log, rather than reporting an empty one', async () => {
    // The two answers mean different things: only one of them says the machine
    // has written nothing.
    const { ctx } = wired({ ['vm.query']: [], ['virt.instance.query']: [instance()] });
    await expect(vmLogs.handler(ctx, { vm: 'web' })).rejects.toThrow(/is an incus-backed instance/);
  });

  it('does not read a container as the instance asked about', async () => {
    // The `type` filter is asked of the middleware and re-checked here: an
    // unrecognised filter is dropped rather than refused.
    const { ctx } = wired({
      ['vm.query']: [],
      ['virt.instance.query']: [instance({ id: 'plex', name: 'plex', type: 'CONTAINER' })],
    });
    await expect(vmLogs.handler(ctx, { vm: 'plex' })).rejects.toThrow(
      /No libvirt-backed virtual machine matching "plex"/,
    );
  });

  it('says the incus stack could not be read rather than that the VM exists nowhere', async () => {
    const { ctx } = wiredFailing(
      { ['vm.query']: [] },
      { ['virt.instance.query']: new Error('virt is not installed') },
    );
    await expect(vmLogs.handler(ctx, { vm: 'web' })).rejects.toThrow(
      /the incus stack could not be read to say whether it holds one: virt is not installed/,
    );
  });

  it('reports a stack that could not be listed as that, not as a VM that does not exist', async () => {
    const { ctx } = wiredFailing({}, { ['vm.query']: new Error('connection reset') });
    await expect(vmLogs.handler(ctx, { vm: 'buildbox' })).rejects.toThrow(
      /could not be listed, so "buildbox" could not be found: connection reset/,
    );
  });

  it('refuses to guess between machines the name matches', async () => {
    const { ctx } = wired({
      ['vm.query']: [vm({ id: null }), vm({ id: 2 })],
      ['vm.log_file_path']: LOG_PATH,
    });
    await expect(vmLogs.handler(ctx, { vm: 'buildbox' })).rejects.toThrow(
      /matches 2 virtual machines on this system — buildbox \(id unknown\), buildbox \(id 2\)/,
    );
  });

  it('names an unreadable name in the machines a selector matched', async () => {
    // One matched by its id and one by a name that is another machine's id, so
    // asking again by id would not separate them either.
    const { ctx } = wired({
      ['vm.query']: [vm({ id: 1, name: null }), vm({ id: 2, name: '1' })],
      ['vm.log_file_path']: LOG_PATH,
    });
    await expect(vmLogs.handler(ctx, { vm: 1 })).rejects.toThrow(
      /an unnamed VM \(id 1\), 1 \(id 2\)/,
    );
  });

  it('refuses a VM whose id the system did not report', async () => {
    const { ctx } = wired({ ['vm.query']: [vm({ id: null })], ['vm.log_file_path']: LOG_PATH });
    await expect(vmLogs.handler(ctx, { vm: 'buildbox' })).rejects.toThrow(
      /reported no id for the virtual machine matching "buildbox"/,
    );
  });

  it('reports a system naming no log file as no log yet, not as an empty one', async () => {
    for (const path of [null, '']) {
      const { ctx, reader } = wired({ ['vm.query']: [vm()], ['vm.log_file_path']: path });
      expect(await vmLogs.handler(ctx, { vm: 'buildbox' })).toMatchObject({
        log_path: null,
        log_status: 'NO_LOG_PATH',
        log_error: null,
        lines: [],
        truncated: false,
      });
      // Nothing to read, so nothing is read.
      expect(reader).not.toHaveBeenCalled();
    }
  });

  it('reports a log it could not read as unreadable, never as an empty one', async () => {
    // Including the absent file this cannot tell from an unreadable one: the
    // error name that separates them is not carried through to the tool, so
    // both arrive here and `log_error` is what tells them apart. Reporting
    // either as `lines: []` under `READ` would say the VM logged nothing on
    // the strength of a read that never happened.
    const failures = [
      new FileContentError('NOT_FOUND', LOG_PATH, `Could not read "${LOG_PATH}": ENOENT`),
      new FileContentError('TRANSPORT', LOG_PATH, 'Downloading it failed'),
      new FileContentError('UNREADABLE', LOG_PATH, 'Permission denied'),
      new FileContentError('NOT_A_FILE', LOG_PATH, 'It is a directory'),
      new Error('the reader broke'),
    ];
    for (const failure of failures) {
      const { ctx } = wired(undefined, () => Promise.reject(failure));
      expect(await vmLogs.handler(ctx, { vm: 'buildbox' })).toMatchObject({
        log_path: LOG_PATH,
        log_status: 'UNREADABLE',
        log_error: failure.message,
        lines: [],
        truncated: false,
      });
    }
  });

  it('does not carry the seam\'s cause into a result, where a download URL can be', async () => {
    // `FileContentError` keeps the adapter's own message — which names the URL
    // it fetched, token and all — on `cause` rather than in `message`.
    const failure = new FileContentError('TRANSPORT', LOG_PATH, `Downloading "${LOG_PATH}" failed`, {
      cause: new Error('request to https://nas.local/_download?auth_token=SECRET-TOKEN failed'),
    });
    const { ctx } = wired(undefined, () => Promise.reject(failure));
    const answer = await vmLogs.handler(ctx, { vm: 'buildbox' });
    expect(JSON.stringify(answer)).not.toContain('SECRET-TOKEN');
  });

  it('reports a log file path that could not be read', async () => {
    const { ctx } = wiredFailing(
      { ['vm.query']: [vm()] },
      { ['vm.log_file_path']: new Error('no such VM') },
    );
    await expect(vmLogs.handler(ctx, { vm: 'buildbox' })).rejects.toThrow(
      /The log file path for "buildbox" could not be read: no such VM/,
    );
  });

  it('reports a deployment with no content reader rather than an empty log', async () => {
    const { ctx, query } = fakeSystem({ ['vm.query']: [vm()] });
    await expect(vmLogs.handler(ctx, { vm: 'buildbox' })).rejects.toThrow(
      /cannot read file content from a system/,
    );
    // Said before anything is asked of the system: it is a fact about how the
    // deployment was assembled rather than about the VM.
    expect(query).not.toHaveBeenCalled();
  });

  it('carries the truncation the reader reported', async () => {
    const { ctx } = wired(undefined, () =>
      Promise.resolve(tail({ lines: ['ready'], truncated: true })),
    );
    expect(await vmLogs.handler(ctx, { vm: 'buildbox' })).toMatchObject({
      lines: ['ready'],
      truncated: true,
    });
  });

  it('reads the log of a VM it has already found without reading the other stack', async () => {
    const { ctx, query } = wired();
    await vmLogs.handler(ctx, { vm: 'buildbox' });
    expect(query).toHaveBeenCalledWith('vm.query');
    expect(query).not.toHaveBeenCalledWith('virt.instance.query', [['type', '=', 'VM']]);
  });

  it('carries no field the tool does not name', async () => {
    const { ctx } = wired({
      ['vm.query']: [vm({ vnc_password: 'SECRET-VNC-PASSWORD' })],
      ['vm.log_file_path']: LOG_PATH,
    });
    const answer = (await vmLogs.handler(ctx, { vm: 'buildbox' })) as Record<string, unknown>;
    expect(Object.keys(answer)).toEqual([
      'source',
      'id',
      'name',
      'log_path',
      'log_status',
      'log_error',
      'requested_lines',
      'lines',
      'truncated',
    ]);
    expect(JSON.stringify(answer)).not.toContain('SECRET');
  });

  it('advertises the same bound its description states', () => {
    expect(vmLogs.inputSchema).toMatchObject({
      required: ['vm'],
      properties: { lines: { minimum: 1, maximum: 1000 } },
    });
  });
});

describe('reporting_utilisation', () => {
  /**
   * A fixed present, so the default range is a fixed interval rather than one
   * that moves with the clock. Only `Date` is faked, as in `audit_log_query`:
   * the tool reads the clock and nothing here schedules anything.
   */
  const NOW = 1_700_000_000_000; // 2023-11-14T22:13:20.000Z
  /** NOW minus the tool's one-hour default range. */
  const RANGE_START = NOW - 60 * 60 * 1000; // 2023-11-14T21:13:20.000Z

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** A sample time inside the default range, in the unix seconds a row carries. */
  const at = (offset: number): number => (RANGE_START + offset) / 1000;

  /** A graph as `reporting.netdata_get_data` answers with one. */
  const graph = (legend: unknown[], data: unknown[]): unknown => [
    { name: 'graph', identifier: null, data, aggregations: {}, start: 0, end: 0, legend },
  ];

  /** Three CPU samples: 10%, 20% and 30% busy, the last exactly at the range end. */
  const cpuGraph = graph(
    ['time', 'user', 'system', 'idle'],
    [
      [at(60_000), 5, 5, 90],
      [at(360_000), 10, 10, 80],
      [at(3_600_000), 20, 10, 70],
    ],
  );

  /** Two memory samples, 50% and 60% of a thousand accounted-for units. */
  const memoryGraph = graph(
    ['time', 'free', 'used', 'cached', 'buffers'],
    [
      [at(60_000), 250, 500, 200, 50],
      [at(3_600_000), 200, 600, 150, 50],
    ],
  );

  /** Two interface samples, with the sent direction mirrored below the axis. */
  const netGraph = graph(
    ['time', 'received', 'sent'],
    [
      [at(60_000), 100, -40],
      [at(3_600_000), 300, -80],
    ],
  );

  interface Fake {
    ctx: ToolContext;
    call: ReturnType<typeof vi.fn>;
    query: ReturnType<typeof vi.fn>;
  }

  /**
   * A SystemHandle answering per GRAPH rather than per method, which neither
   * `fakeSystem` nor `failingSystem` can do: every graph this tool reads comes
   * back from the same `reporting.netdata_get_data` call, distinguished only by
   * the name and identifier asked for. Graphs are keyed `cpu`, `memory` and
   * `interface:<name>`, and a key present in `failures` rejects instead.
   */
  const reportingSystem = (
    graphs: Record<string, unknown>,
    options: { interfaces?: unknown; failures?: Record<string, unknown> } = {},
  ): Fake => {
    const failures = options.failures ?? {};
    const call = vi.fn((method: string, params?: unknown) => {
      const asked = (params as [{ name: string; identifier?: string }[]])[0][0];
      const key = asked.identifier === undefined ? asked.name : `${asked.name}:${asked.identifier}`;
      return key in failures ? throwError(() => failures[key]) : of(graphs[key]);
    });
    const query = vi.fn(() =>
      'interface.query' in failures
        ? throwError(() => failures['interface.query'])
        : of(options.interfaces ?? [{ name: 'eno1' }]),
    );
    const system = { name: 'nas', client: { api: { call, query } } } as unknown as SystemHandle;
    return { ctx: { system }, call, query };
  };

  /** A system with all three graphs and one interface. */
  const healthy = (): Fake =>
    reportingSystem({ cpu: cpuGraph, memory: memoryGraph, ['interface:eno1']: netGraph });

  interface Metric {
    metric: string;
    interface: string | null;
    unit: string;
    min: number | null;
    max: number | null;
    mean: number | null;
    latest: number | null;
    buckets: (number | null)[];
    unavailable: string | null;
  }

  interface Report {
    start: string;
    end: string;
    bucket_seconds: number;
    metrics: Metric[];
    truncated_interfaces: boolean;
  }

  const reported = async (fake: Fake, args: Record<string, unknown> = {}): Promise<Report> =>
    (await reportingUtilisation.handler(fake.ctx, args)) as Report;

  /** One metric of a result, by name and by the interface it was measured on. */
  const metric = (report: Report, name: string, iface: string | null = null): Metric =>
    report.metrics.filter((entry) => entry.metric === name && entry.interface === iface)[0];

  /** The whole default-range result of a system carrying just this one CPU graph. */
  const cpuOnly = async (legend: unknown[], data: unknown[]): Promise<Metric> =>
    metric(await reported(reportingSystem({ cpu: graph(legend, data) })), 'cpu_percent');

  it('summarises CPU over the range and buckets it twelve ways', async () => {
    expect(metric(await reported(healthy()), 'cpu_percent')).toEqual({
      metric: 'cpu_percent',
      interface: null,
      unit: 'percent',
      min: 10,
      max: 30,
      mean: 20,
      latest: 30,
      // The third sample sits exactly at the end of the range and lands in the
      // last bucket rather than one past it.
      buckets: [10, 20, null, null, null, null, null, null, null, null, null, 30],
      unavailable: null,
    });
  });

  it('reports memory in use as a percentage of the memory the graph accounts for', async () => {
    expect(metric(await reported(healthy()), 'memory_used_percent')).toMatchObject({
      unit: 'percent',
      min: 50,
      max: 60,
      mean: 55,
      latest: 60,
      unavailable: null,
    });
  });

  it('reports each direction of interface traffic as a magnitude', async () => {
    const report = await reported(healthy());
    expect(metric(report, 'network_received', 'eno1')).toMatchObject({
      unit: 'kilobits_per_second',
      min: 100,
      max: 300,
      mean: 200,
      latest: 300,
    });
    // Sent arrives negative, mirrored below the axis; a busy link must not
    // report as one carrying less than nothing.
    expect(metric(report, 'network_sent', 'eno1')).toMatchObject({
      min: 40,
      max: 80,
      mean: 60,
      latest: 80,
    });
  });

  it('states the range it reported on and how wide a bucket is', async () => {
    expect(await reported(healthy())).toMatchObject({
      start: '2023-11-14T21:13:20.000Z',
      end: '2023-11-14T22:13:20.000Z',
      bucket_seconds: 300,
      truncated_interfaces: false,
    });
  });

  it('returns only the fields it names', async () => {
    const report = await reported(healthy());
    expect(Object.keys(report)).toEqual([
      'start',
      'end',
      'bucket_seconds',
      'metrics',
      'truncated_interfaces',
    ]);
    expect(Object.keys(metric(report, 'cpu_percent'))).toEqual([
      'metric',
      'interface',
      'unit',
      'min',
      'max',
      'mean',
      'latest',
      'buckets',
      'unavailable',
    ]);
  });

  it('asks the system for the range in unix seconds, per graph', async () => {
    const fake = healthy();
    await reported(fake);
    const bounds = { start: RANGE_START / 1000, end: NOW / 1000 };
    expect(fake.call).toHaveBeenCalledWith('reporting.netdata_get_data', [[{ name: 'cpu' }], bounds]);
    expect(fake.call).toHaveBeenCalledWith('reporting.netdata_get_data', [
      [{ name: 'memory' }],
      bounds,
    ]);
    expect(fake.call).toHaveBeenCalledWith('reporting.netdata_get_data', [
      [{ name: 'interface', identifier: 'eno1' }],
      bounds,
    ]);
  });

  it('returns twelve buckets however long the range is', async () => {
    const report = await reported(healthy(), { start: '2023-10-14', end: '2023-11-15' });
    expect(report.metrics.every((entry) => entry.buckets.length <= 12)).toBe(true);
    expect(metric(report, 'cpu_percent').buckets).toHaveLength(12);
    expect(report.bucket_seconds).toBe(230400);
  });

  it('marks a range the system collected nothing in, rather than returning an empty series', async () => {
    // The samples all sit after this range, so the graph answered and held
    // nothing inside it.
    const report = await reported(healthy(), { start: '2023-10-14', end: '2023-11-14' });
    expect(metric(report, 'cpu_percent')).toMatchObject({
      min: null,
      max: null,
      mean: null,
      latest: null,
      buckets: [],
      unavailable: 'the system collected no data for this metric in this range',
    });
  });

  it('marks a graph carrying no series the metric can be derived from', async () => {
    // Rows were returned, and none of them names the idle time CPU utilisation
    // is the complement of — which is a different fact from collecting nothing.
    expect(await cpuOnly(['time', 'user', 'system'], [[at(60_000), 5, 5]])).toMatchObject({
      buckets: [],
      unavailable: 'the system reported no series this metric can be derived from',
    });
  });

  it('marks a gap in collection as no data, not as a graph carrying no such series', async () => {
    // Netdata stamps a second it collected nothing in with a row of nulls, so
    // these rows are inside the range and the legend does name `idle`. Deciding
    // this from the rows rather than from the legend would answer "this system
    // reports no series CPU utilisation can be derived from" — that it does not
    // record CPU at all — for what is a gap at 3am.
    expect(
      await cpuOnly(
        ['time', 'user', 'system', 'idle'],
        [
          [at(60_000), null, null, null],
          [at(360_000), null, null, null],
        ],
      ),
    ).toMatchObject({
      buckets: [],
      unavailable: 'the system collected no data for this metric in this range',
    });
  });

  it('names a failed graph read on that metric alone', async () => {
    const fake = reportingSystem(
      { memory: memoryGraph, ['interface:eno1']: netGraph },
      { failures: { cpu: new Error('netdata is not running') } },
    );
    const report = await reported(fake);
    expect(metric(report, 'cpu_percent')).toMatchObject({
      min: null,
      buckets: [],
      unavailable: 'netdata is not running',
    });
    expect(metric(report, 'memory_used_percent').unavailable).toBeNull();
    expect(metric(report, 'network_received', 'eno1').unavailable).toBeNull();
  });

  it('names the failure however the system reported it', async () => {
    const reasons: [unknown, string][] = [
      [new Error('netdata is not running'), 'netdata is not running'],
      [new Error(''), 'the system reported no reason'],
      [{ reason: 'no such graph' }, 'no such graph'],
      [{ message: 'transport closed' }, 'transport closed'],
      ['reporting is disabled', 'reporting is disabled'],
      [{}, 'the system reported no reason'],
      [null, 'the system reported no reason'],
    ];
    for (const [thrown, expected] of reasons) {
      const fake = reportingSystem({}, { failures: { cpu: thrown } });
      expect(metric(await reported(fake), 'cpu_percent').unavailable).toBe(expected);
    }
  });

  it('still reports both network metrics when the interface listing could not be read', async () => {
    const fake = reportingSystem(
      { cpu: cpuGraph, memory: memoryGraph },
      { failures: { ['interface.query']: new Error('interfaces unavailable') } },
    );
    const report = await reported(fake);
    // Absent metrics would read as a system with no network at all.
    expect(metric(report, 'network_received')).toMatchObject({
      interface: null,
      buckets: [],
      unavailable: 'interfaces unavailable',
    });
    expect(metric(report, 'network_sent').unavailable).toBe('interfaces unavailable');
    expect(metric(report, 'cpu_percent').unavailable).toBeNull();
    expect(report.truncated_interfaces).toBe(false);
  });

  it('still reports both network metrics when the system named no interface', async () => {
    const fake = reportingSystem({ cpu: cpuGraph, memory: memoryGraph }, { interfaces: [] });
    const report = await reported(fake);
    // Dropping them would be indistinguishable from a system with no network.
    expect(metric(report, 'network_received')).toMatchObject({
      interface: null,
      buckets: [],
      unavailable: 'the system named no interface to graph',
    });
    expect(metric(report, 'network_sent').unavailable).toBe('the system named no interface to graph');
  });

  it('covers six interfaces in name order and says when it left some out', async () => {
    const fake = reportingSystem(
      { cpu: cpuGraph, memory: memoryGraph },
      { interfaces: ['eth7', 'eth3', 'eth1', 'eth5', 'eth2', 'eth6', 'eth4'].map((name) => ({ name })) },
    );
    const report = await reported(fake);
    expect(report.truncated_interfaces).toBe(true);
    expect(
      report.metrics.filter((entry) => entry.metric === 'network_received').map((e) => e.interface),
    ).toEqual(['eth1', 'eth2', 'eth3', 'eth4', 'eth5', 'eth6']);
  });

  it('graphs only the interfaces the system actually named', async () => {
    const fake = reportingSystem(
      { cpu: cpuGraph, memory: memoryGraph, ['interface:eno1']: netGraph },
      { interfaces: [{ name: 'eno1' }, { name: '' }, { name: 42 }, {}] },
    );
    const report = await reported(fake);
    expect(
      report.metrics.filter((entry) => entry.metric === 'network_sent').map((e) => e.interface),
    ).toEqual(['eno1']);
  });

  it('marks one direction unavailable while the other reports', async () => {
    const fake = reportingSystem({
      ['interface:eno1']: graph(['time', 'received'], [[at(60_000), 100]]),
    });
    const report = await reported(fake);
    expect(metric(report, 'network_received', 'eno1').mean).toBe(100);
    expect(metric(report, 'network_sent', 'eno1').unavailable).toBe(
      'the system reported no series this metric can be derived from',
    );
  });

  it('reads a legend that does not name the timestamp column', async () => {
    expect(await cpuOnly(['user', 'system', 'idle'], [[at(60_000), 5, 5, 90]])).toMatchObject({
      mean: 10,
    });
  });

  it('keeps the first column of a duplicated legend name', async () => {
    // Taking the later column would read this graph as 90% busy.
    expect(await cpuOnly(['time', 'idle', 'idle'], [[at(60_000), 90, 10]])).toMatchObject({
      mean: 10,
    });
  });

  it('keeps every column in place through a legend entry that is not a name', async () => {
    expect(await cpuOnly(['time', 42, 'idle'], [[at(60_000), 5, 90]])).toMatchObject({ mean: 10 });
  });

  it('reads a row timestamp sent as milliseconds', async () => {
    expect(
      await cpuOnly(['time', 'idle'], [[RANGE_START + 60_000, 90]]),
    ).toMatchObject({ mean: 10, buckets: [10, ...new Array<null>(11).fill(null)] });
  });

  it('drops a row it cannot read a time or a value from', async () => {
    expect(
      await cpuOnly(
        ['time', 'idle'],
        ['not a row', [null, 90], [at(60_000), 'unreadable'], [at(360_000), 90]],
      ),
    ).toMatchObject({ min: 10, max: 10, mean: 10, latest: 10 });
  });

  it('takes the latest value from the newest sample, not the last one sent', async () => {
    expect(
      await cpuOnly(
        ['time', 'idle'],
        [
          [at(3_600_000), 70],
          [at(60_000), 90],
        ],
      ),
    ).toMatchObject({ latest: 30 });
  });

  it('clamps CPU utilisation into nought to a hundred', async () => {
    expect(
      await cpuOnly(
        ['time', 'idle'],
        [
          [at(60_000), 110],
          [at(360_000), -20],
        ],
      ),
    ).toMatchObject({ min: 0, max: 100 });
  });

  it('reports no memory percentage where nothing accounts for the total', async () => {
    const noSeries = 'the system reported no series this metric can be derived from';
    const noData = 'the system collected no data for this metric in this range';
    const cases: [unknown[], unknown[], string][] = [
      // No `used` to report: the graph carries no series this is derived from.
      [['time', 'free', 'cached'], [[at(60_000), 100, 20]], noSeries],
      // `used` alone is its own total, and dividing it by itself would report
      // every system as fully out of memory.
      [['time', 'used'], [[at(60_000), 500]], noSeries],
      // The graph carries both series and this sample has nothing to take a
      // share of — a property of the sample rather than of the graph, so it
      // reads as a range that yielded no measurement.
      [['time', 'free', 'used'], [[at(60_000), 0, 0]], noData],
    ];
    for (const [legend, data, expected] of cases) {
      const fake = reportingSystem({ memory: graph(legend, data) });
      expect(metric(await reported(fake), 'memory_used_percent').unavailable).toBe(expected);
    }
  });

  it('clamps a memory percentage the parts do not support', async () => {
    const fake = reportingSystem({ memory: graph(['time', 'free', 'used'], [[at(60_000), 100, -50]]) });
    expect(metric(await reported(fake), 'memory_used_percent').mean).toBe(0);
  });

  it('reports nothing, with a stated reason, for a graph in a shape it cannot use', async () => {
    const shapes: unknown[] = [
      'not a list',
      [],
      [null],
      [{ legend: 'not a list', data: 'not a list' }],
      graph([], [[at(60_000), 90]]),
    ];
    for (const answer of shapes) {
      const fake = reportingSystem({ cpu: answer });
      const reading = metric(await reported(fake), 'cpu_percent');
      expect(reading.min).toBeNull();
      // Which marker it is depends on whether any row survived — the last shape
      // holds one, under a legend naming nothing. What every shape must do is
      // say why there is nothing, rather than report a measurement.
      expect(reading.unavailable).not.toBeNull();
    }
  });

  it('reads every timestamp form the catalog accepts, as UTC', async () => {
    const starts = [
      '2023-11-14T21:13:20Z',
      '2023-11-14 21:13:20',
      '2023-11-14T23:13:20+02:00',
      '2023-11-14T19:13:20-02:00',
    ];
    for (const start of starts) {
      expect((await reported(healthy(), { start })).start).toBe('2023-11-14T21:13:20.000Z');
    }
    expect((await reported(healthy(), { start: '2023-11-14T21:13:20.123456Z' })).start).toBe(
      '2023-11-14T21:13:20.123Z',
    );
    expect((await reported(healthy(), { start: '2023-11-14' })).start).toBe(
      '2023-11-14T00:00:00.000Z',
    );
  });

  it('defaults each end of the range from the other', async () => {
    // An end alone covers the hour before it, rather than an hour that may lie
    // outside the range asked about at all.
    expect(await reported(healthy(), { end: '2023-11-14T12:00:00Z' })).toMatchObject({
      start: '2023-11-14T11:00:00.000Z',
      end: '2023-11-14T12:00:00.000Z',
    });
    // A start alone runs to now.
    expect(await reported(healthy(), { start: '2023-11-14T12:00:00Z', end: null })).toMatchObject({
      start: '2023-11-14T12:00:00.000Z',
      end: '2023-11-14T22:13:20.000Z',
    });
  });

  it('refuses a bound it cannot read rather than silently using the default', async () => {
    const unreadable = [
      { start: 'last tuesday' },
      { end: 1_700_000_000 },
      { start: '2023-02-30' },
      { start: '2023-13-01' },
      { start: '0000-01-01' },
      { start: '2023-11-14T25:00:00Z' },
      { start: '2023-11-14T09:99:00Z' },
      { start: '2023-11-14T09:00:00+25:00' },
      { start: '2023-11-14T09:00:00+02:99' },
    ];
    for (const args of unreadable) {
      await expect(reportingUtilisation.handler(healthy().ctx, args)).rejects.toThrow(
        /must be an ISO 8601 timestamp/,
      );
    }
  });

  it('refuses a range that does not run forwards', async () => {
    await expect(
      reportingUtilisation.handler(healthy().ctx, {
        start: '2023-11-14T12:00:00Z',
        end: '2023-11-14T11:00:00Z',
      }),
    ).rejects.toThrow('"start" must be before "end"');
  });
});

describe('reporting_disk_io', () => {
  /** The same fixed present as `reporting_utilisation`, for the same reason. */
  const NOW = 1_700_000_000_000; // 2023-11-14T22:13:20.000Z
  /** NOW minus the tool's one-hour default range. */
  const RANGE_START = NOW - 60 * 60 * 1000; // 2023-11-14T21:13:20.000Z

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** A sample time inside the default range, in the unix seconds a row carries. */
  const at = (offset: number): number => (RANGE_START + offset) / 1000;

  /** A graph as `reporting.netdata_get_data` answers with one. */
  const graph = (legend: unknown[], data: unknown[]): unknown => [
    { name: 'disk', identifier: 'sda', data, aggregations: {}, start: 0, end: 0, legend },
  ];

  /**
   * Two samples of a disk moving data, with the write direction mirrored below
   * the axis as netdata draws it.
   */
  const diskGraph = graph(
    ['time', 'reads', 'writes'],
    [
      [at(60_000), 100, -40],
      [at(3_600_000), 300, -80],
    ],
  );

  interface Fake {
    ctx: ToolContext;
    call: ReturnType<typeof vi.fn>;
    query: ReturnType<typeof vi.fn>;
  }

  /**
   * A SystemHandle answering per DISK: every graph comes back from the same
   * `reporting.netdata_get_data` call, distinguished only by the identifier
   * asked for, so graphs are keyed by disk name and a key present in `failures`
   * rejects instead.
   */
  const diskSystem = (
    graphs: Record<string, unknown>,
    options: { disks?: unknown; failures?: Record<string, unknown> } = {},
  ): Fake => {
    const failures = options.failures ?? {};
    const call = vi.fn((method: string, params?: unknown) => {
      const asked = (params as [{ name: string; identifier?: string }[]])[0][0];
      const key = asked.identifier ?? asked.name;
      return key in failures ? throwError(() => failures[key]) : of(graphs[key]);
    });
    const query = vi.fn(() =>
      'disk.query' in failures
        ? throwError(() => failures['disk.query'])
        : of(options.disks ?? [{ name: 'sda' }]),
    );
    const system = { name: 'nas', client: { api: { call, query } } } as unknown as SystemHandle;
    return { ctx: { system }, call, query };
  };

  /** A system with one disk that has a graph. */
  const healthy = (): Fake => diskSystem({ sda: diskGraph });

  interface Metric {
    metric: string;
    disk: string | null;
    unit: string;
    min: number | null;
    max: number | null;
    mean: number | null;
    latest: number | null;
    buckets: (number | null)[];
    unavailable: string | null;
  }

  interface Report {
    start: string;
    end: string;
    bucket_seconds: number;
    metrics: Metric[];
    truncated_disks: boolean;
  }

  const reported = async (fake: Fake, args: Record<string, unknown> = {}): Promise<Report> =>
    (await reportingDiskIo.handler(fake.ctx, args)) as Report;

  /** One metric of a result, by name and by the disk it was measured on. */
  const metric = (report: Report, name: string, disk: string | null = 'sda'): Metric =>
    report.metrics.filter((entry) => entry.metric === name && entry.disk === disk)[0];

  it('summarises each direction of throughput over the range and buckets it twelve ways', async () => {
    expect(metric(await reported(healthy()), 'read_throughput')).toEqual({
      metric: 'read_throughput',
      disk: 'sda',
      unit: 'kibibytes_per_second',
      min: 100,
      max: 300,
      mean: 200,
      latest: 300,
      // The second sample sits exactly at the end of the range and lands in the
      // last bucket rather than one past it.
      buckets: [100, null, null, null, null, null, null, null, null, null, null, 300],
      unavailable: null,
    });
  });

  it('reports the write direction as a magnitude', async () => {
    // Writes arrive negative, mirrored below the axis; a disk under write load
    // must not report as one doing less than nothing.
    expect(metric(await reported(healthy()), 'write_throughput')).toMatchObject({
      unit: 'kibibytes_per_second',
      min: 40,
      max: 80,
      mean: 60,
      latest: 80,
      unavailable: null,
    });
  });

  it('reports IOPS and latency as unavailable where the graph carries no such series', async () => {
    const report = await reported(healthy());
    const noSeries = 'the system reported no series this metric can be derived from';
    for (const name of ['read_iops', 'write_iops', 'read_latency', 'write_latency']) {
      // Present with a stated reason rather than omitted: that the system
      // records throughput only is a fact about the system, and dropping the
      // metrics would read as a disk that did no operations at all.
      expect(metric(report, name)).toMatchObject({ min: null, buckets: [], unavailable: noSeries });
    }
    expect(metric(report, 'read_iops').unit).toBe('operations_per_second');
    expect(metric(report, 'read_latency').unit).toBe('milliseconds');
  });

  it('summarises IOPS and latency from a graph that does carry them', async () => {
    const fake = diskSystem({
      sda: graph(
        ['time', 'read_ops', 'write_ops', 'read_await', 'write_await'],
        [
          [at(60_000), 20, -10, 1, 3],
          [at(3_600_000), 40, -30, 2, 5],
        ],
      ),
    });
    const report = await reported(fake);
    expect(metric(report, 'read_iops')).toMatchObject({ min: 20, max: 40, mean: 30, latest: 40 });
    expect(metric(report, 'write_iops')).toMatchObject({ min: 10, max: 30, mean: 20, latest: 30 });
    expect(metric(report, 'read_latency')).toMatchObject({ mean: 1.5, latest: 2 });
    expect(metric(report, 'write_latency')).toMatchObject({ mean: 4, latest: 5 });
  });

  it('states the range it reported on and how wide a bucket is', async () => {
    expect(await reported(healthy())).toMatchObject({
      start: '2023-11-14T21:13:20.000Z',
      end: '2023-11-14T22:13:20.000Z',
      bucket_seconds: 300,
      truncated_disks: false,
    });
  });

  it('returns only the fields it names', async () => {
    const report = await reported(healthy());
    expect(Object.keys(report)).toEqual([
      'start',
      'end',
      'bucket_seconds',
      'metrics',
      'truncated_disks',
    ]);
    expect(Object.keys(metric(report, 'read_throughput'))).toEqual([
      'metric',
      'disk',
      'unit',
      'min',
      'max',
      'mean',
      'latest',
      'buckets',
      'unavailable',
    ]);
  });

  it('asks the system for the disk graph by device name, in unix seconds', async () => {
    const fake = healthy();
    await reported(fake);
    expect(fake.call).toHaveBeenCalledWith('reporting.netdata_get_data', [
      [{ name: 'disk', identifier: 'sda' }],
      { start: RANGE_START / 1000, end: NOW / 1000 },
    ]);
    // One call per disk, not one per metric: all six come from the same graph.
    expect(fake.call).toHaveBeenCalledTimes(1);
  });

  it('reports six metrics for every disk it covers', async () => {
    const fake = diskSystem(
      { sda: diskGraph, sdb: diskGraph },
      { disks: [{ name: 'sdb' }, { name: 'sda' }] },
    );
    const report = await reported(fake);
    expect(report.metrics).toHaveLength(12);
    expect(report.metrics.map((entry) => entry.disk)).toEqual([
      ...new Array<string>(6).fill('sda'),
      ...new Array<string>(6).fill('sdb'),
    ]);
    expect(metric(report, 'read_throughput', 'sdb').mean).toBe(200);
  });

  it('marks a range the system collected nothing in, rather than returning an empty series', async () => {
    // The samples all sit after this range, so the graph answered and held
    // nothing inside it.
    const report = await reported(healthy(), { start: '2023-10-14', end: '2023-11-14' });
    expect(metric(report, 'read_throughput')).toMatchObject({
      min: null,
      latest: null,
      buckets: [],
      unavailable: 'the system collected no data for this metric in this range',
    });
  });

  it('names a failed graph read on that disk alone', async () => {
    const fake = diskSystem(
      { sdb: diskGraph },
      {
        disks: [{ name: 'sda' }, { name: 'sdb' }],
        failures: { sda: new Error('netdata is not running') },
      },
    );
    const report = await reported(fake);
    expect(metric(report, 'read_throughput')).toMatchObject({
      buckets: [],
      unavailable: 'netdata is not running',
    });
    expect(metric(report, 'read_throughput', 'sdb').unavailable).toBeNull();
  });

  it('still reports every metric when the disk listing could not be read', async () => {
    const fake = diskSystem({}, { failures: { ['disk.query']: new Error('disks unavailable') } });
    const report = await reported(fake);
    // Absent metrics would read as a system with no disks at all.
    expect(report.metrics).toHaveLength(6);
    expect(metric(report, 'read_throughput', null)).toMatchObject({
      disk: null,
      buckets: [],
      unavailable: 'disks unavailable',
    });
    expect(metric(report, 'write_latency', null).unavailable).toBe('disks unavailable');
    expect(report.truncated_disks).toBe(false);
  });

  it('still reports every metric when the system named no disk', async () => {
    const report = await reported(diskSystem({}, { disks: [] }));
    expect(metric(report, 'read_throughput', null)).toMatchObject({
      disk: null,
      unavailable: 'the system named no disk to graph',
    });
  });

  it('covers six disks in name order and says when it left some out', async () => {
    const fake = diskSystem(
      {},
      { disks: ['sdg', 'sdc', 'sda', 'sde', 'sdb', 'sdf', 'sdd'].map((name) => ({ name })) },
    );
    const report = await reported(fake);
    expect(report.truncated_disks).toBe(true);
    expect(
      report.metrics.filter((entry) => entry.metric === 'read_throughput').map((e) => e.disk),
    ).toEqual(['sda', 'sdb', 'sdc', 'sdd', 'sde', 'sdf']);
  });

  it('graphs only the disks the system actually named', async () => {
    const fake = diskSystem(
      { sda: diskGraph },
      { disks: [{ name: 'sda' }, { name: '' }, { name: 42 }, {}, null, 'sdz'] },
    );
    const report = await reported(fake);
    expect(
      report.metrics.filter((entry) => entry.metric === 'write_throughput').map((e) => e.disk),
    ).toEqual(['sda']);
  });

  it('reads the range the caller named, in the forms the catalog accepts', async () => {
    expect(await reported(healthy(), { start: '2023-11-14 21:13:20' })).toMatchObject({
      start: '2023-11-14T21:13:20.000Z',
      end: '2023-11-14T22:13:20.000Z',
    });
  });

  it('refuses a bound it cannot read rather than silently using the default', async () => {
    await expect(reportingDiskIo.handler(healthy().ctx, { start: 'last tuesday' })).rejects.toThrow(
      /must be an ISO 8601 timestamp/,
    );
  });

  it('refuses a range that does not run forwards', async () => {
    await expect(
      reportingDiskIo.handler(healthy().ctx, {
        start: '2023-11-14T12:00:00Z',
        end: '2023-11-14T11:00:00Z',
      }),
    ).rejects.toThrow('"start" must be before "end"');
  });
});

describe('reporting_space_trends', () => {
  /** The same fixed present as the two graph tools, for the same reason. */
  const NOW = 1_700_000_000_000; // 2023-11-14T22:13:20.000Z

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** An instant that many days before the fixed present. */
  const day = (before: number): number => NOW - before * 24 * 60 * 60 * 1000;

  /**
   * A range wide enough to hold every fixture below. The default range is one
   * hour, which no snapshot in these tests falls in — which is itself the point
   * the tool's description makes about its own default.
   */
  const RANGE = { start: '2023-10-01', end: '2023-12-01' };

  /** A snapshot row as `pool.snapshot.query` answers with one. */
  const snap = (at: number, bytes: number): unknown => ({
    name: `tank/x@${at}`,
    dataset: 'tank/x',
    // Seconds as a string, which is how ZFS states `creation`'s raw value.
    properties: { creation: { rawvalue: String(at / 1000) }, referenced: { parsed: bytes } },
  });

  /** A dataset row as `pool.dataset.query` answers with one. */
  const dataset = (id: string, pool: string, used: number | null): unknown => ({
    id,
    pool,
    used: used === null ? undefined : { parsed: used },
  });

  interface Fake {
    ctx: ToolContext;
    query: ReturnType<typeof vi.fn>;
  }

  /**
   * A SystemHandle answering the three listings this tool reads. Snapshots are
   * keyed by the dataset the call filtered on, since every dataset's history
   * comes back from the same method; a key present in `failures` — a method name
   * or a dataset name — rejects instead.
   */
  const spaceSystem = (
    options: {
      datasets?: unknown[];
      pools?: unknown[];
      snapshots?: Record<string, unknown[]>;
      failures?: Record<string, unknown>;
    } = {},
  ): Fake => {
    const failures = options.failures ?? {};
    const query = vi.fn((method: string, filters?: unknown) => {
      if (method === 'pool.snapshot.query') {
        const asked = (filters as [string, string, string][])[0][2];
        return asked in failures
          ? throwError(() => failures[asked])
          : of(options.snapshots?.[asked] ?? []);
      }
      if (method in failures) return throwError(() => failures[method]);
      if (method === 'pool.query') {
        return of(options.pools ?? [{ name: 'tank', size: 10e9, allocated: 6e9, free: 4e9 }]);
      }
      return of(
        options.datasets ?? [dataset('tank/media', 'tank', 5e9), dataset('tank/vm', 'tank', 1e9)],
      );
    });
    const system = { name: 'nas', client: { api: { query } } } as unknown as SystemHandle;
    return { ctx: { system }, query };
  };

  /** Two datasets with histories: one growing over twenty days, one shrinking over ten. */
  const healthy = (): Fake =>
    spaceSystem({
      snapshots: {
        'tank/media': [snap(day(30), 1e9), snap(day(10), 3e9)],
        'tank/vm': [snap(day(30), 5e8), snap(day(20), 3e8)],
      },
    });

  interface Trend {
    referenced_start_bytes: number | null;
    referenced_end_bytes: number | null;
    change_bytes: number | null;
    change_bytes_per_day: number | null;
    observed_start: string | null;
    observed_end: string | null;
    snapshots_observed: number;
    unavailable: string | null;
  }

  interface DatasetEntry extends Trend {
    dataset: string;
    pool: string;
    used_bytes: number | null;
  }

  interface PoolEntry {
    pool: string;
    used_bytes: number | null;
    free_bytes: number | null;
    total_bytes: number | null;
    used_percent: number | null;
    levels_unavailable: string | null;
    referenced_change_bytes: number | null;
    referenced_change_bytes_per_day: number | null;
    observed_start: string | null;
    observed_end: string | null;
    datasets_observed: number;
    datasets_total: number | null;
    unavailable: string | null;
  }

  interface Report {
    start: string;
    end: string;
    as_of: string;
    pools: PoolEntry[];
    datasets: DatasetEntry[];
    truncated_datasets: boolean;
    truncated_snapshots: boolean;
  }

  const reported = async (fake: Fake, args: Record<string, unknown> = RANGE): Promise<Report> =>
    (await reportingSpaceTrends.handler(fake.ctx, args)) as Report;

  /** One dataset of a result, by name. */
  const entry = (report: Report, name: string): DatasetEntry =>
    report.datasets.filter((row) => row.dataset === name)[0];

  it('reports what a dataset referenced at each end of its history and the rate between', async () => {
    expect(entry(await reported(healthy()), 'tank/media')).toEqual({
      dataset: 'tank/media',
      pool: 'tank',
      used_bytes: 5e9,
      referenced_start_bytes: 1e9,
      referenced_end_bytes: 3e9,
      change_bytes: 2e9,
      // Two gibibytes over the twenty days actually observed, not over the two
      // months asked about.
      change_bytes_per_day: 1e8,
      observed_start: '2023-10-15T22:13:20.000Z',
      observed_end: '2023-11-04T22:13:20.000Z',
      snapshots_observed: 2,
      unavailable: null,
    });
  });

  it('reports a dataset that shrank as a negative change', async () => {
    expect(entry(await reported(healthy()), 'tank/vm')).toMatchObject({
      change_bytes: -2e8,
      change_bytes_per_day: -2e7,
    });
  });

  it('states the range it was asked about and when the levels were read', async () => {
    expect(await reported(healthy())).toMatchObject({
      start: '2023-10-01T00:00:00.000Z',
      end: '2023-12-01T00:00:00.000Z',
      as_of: '2023-11-14T22:13:20.000Z',
      truncated_datasets: false,
      truncated_snapshots: false,
    });
  });

  it('returns only the fields it names', async () => {
    const report = await reported(healthy());
    expect(Object.keys(report)).toEqual([
      'start',
      'end',
      'as_of',
      'pools',
      'datasets',
      'truncated_datasets',
      'truncated_snapshots',
    ]);
    expect(Object.keys(entry(report, 'tank/media'))).toEqual([
      'dataset',
      'pool',
      'used_bytes',
      'referenced_start_bytes',
      'referenced_end_bytes',
      'change_bytes',
      'change_bytes_per_day',
      'observed_start',
      'observed_end',
      'snapshots_observed',
      'unavailable',
    ]);
    expect(Object.keys(report.pools[0])).toEqual([
      'pool',
      'used_bytes',
      'free_bytes',
      'total_bytes',
      'used_percent',
      'levels_unavailable',
      'referenced_change_bytes',
      'referenced_change_bytes_per_day',
      'observed_start',
      'observed_end',
      'datasets_observed',
      'datasets_total',
      'unavailable',
    ]);
  });

  it("sums the pool's change over the datasets it reported, and says how far that reaches", async () => {
    expect((await reported(healthy())).pools[0]).toEqual({
      pool: 'tank',
      used_bytes: 6e9,
      free_bytes: 4e9,
      total_bytes: 10e9,
      used_percent: 60,
      levels_unavailable: null,
      referenced_change_bytes: 1.8e9,
      referenced_change_bytes_per_day: 8e7,
      // The widest window any contributing dataset was observed over.
      observed_start: '2023-10-15T22:13:20.000Z',
      observed_end: '2023-11-04T22:13:20.000Z',
      datasets_observed: 2,
      datasets_total: 2,
      unavailable: null,
    });
  });

  it('drops samples outside the range rather than measuring against them', async () => {
    const fake = spaceSystem({
      snapshots: { 'tank/media': [snap(day(300), 1e6), snap(day(30), 1e9), snap(day(10), 3e9)] },
    });
    expect(entry(await reported(fake), 'tank/media')).toMatchObject({
      referenced_start_bytes: 1e9,
      snapshots_observed: 2,
    });
  });

  it('marks a dataset the system holds no snapshot of in the range', async () => {
    const report = await reported(spaceSystem({}));
    expect(entry(report, 'tank/media')).toMatchObject({
      used_bytes: 5e9,
      change_bytes: null,
      change_bytes_per_day: null,
      observed_start: null,
      snapshots_observed: 0,
      unavailable: 'the system holds no snapshot of this dataset in this range',
    });
  });

  it('marks a dataset snapshotted only at one instant as a level rather than a change', async () => {
    // Two snapshots, one instant: there is something to read and it is not a
    // change, and reporting zero would say the dataset held still.
    const fake = spaceSystem({
      snapshots: { 'tank/media': [snap(day(30), 1e9), snap(day(30), 2e9)] },
    });
    expect(entry(await reported(fake), 'tank/media')).toMatchObject({
      change_bytes: null,
      snapshots_observed: 2,
      unavailable:
        'the system holds no two snapshots of this dataset taken at different times in this range',
    });
  });

  it('names a failed snapshot read on that dataset alone', async () => {
    const fake = spaceSystem({
      snapshots: { 'tank/vm': [snap(day(30), 5e8), snap(day(20), 3e8)] },
      failures: { 'tank/media': new Error('dataset is locked') },
    });
    const report = await reported(fake);
    expect(entry(report, 'tank/media')).toMatchObject({
      change_bytes: null,
      snapshots_observed: 0,
      unavailable: 'dataset is locked',
    });
    expect(entry(report, 'tank/vm').unavailable).toBeNull();
    // The pool still reports the dataset that did answer, over one of two.
    expect(report.pools[0]).toMatchObject({ datasets_observed: 1, datasets_total: 2 });
  });

  it('reports a failure carrying no text of its own rather than an empty reason', async () => {
    const fake = spaceSystem({ failures: { 'tank/media': { reason: 'ENOENT' } } });
    expect(entry(await reported(fake), 'tank/media').unavailable).toBe('ENOENT');
    const bare = spaceSystem({ failures: { 'tank/media': '' } });
    expect(entry(await reported(bare), 'tank/media').unavailable).toBe(
      'the system reported no reason',
    );
  });

  it('ignores a snapshot whose time or size it cannot read', async () => {
    const fake = spaceSystem({
      snapshots: {
        'tank/media': [
          snap(day(30), 1e9),
          { name: 'x', properties: { creation: { rawvalue: 'yesterday' }, referenced: {} } },
          { name: 'y', properties: { creation: { rawvalue: '' }, referenced: { parsed: 5 } } },
          { name: 'z', properties: { creation: { rawvalue: 1e15 }, referenced: { parsed: 5 } } },
          { name: 'w' },
          snap(day(10), 3e9),
        ],
      },
    });
    expect(entry(await reported(fake), 'tank/media')).toMatchObject({
      snapshots_observed: 2,
      change_bytes: 2e9,
    });
  });

  it('takes the ends of the history whatever order the system listed it in', async () => {
    // No order is asked for, so none is assumed: the same two snapshots listed
    // newest first must give the same change rather than its negation.
    const fake = spaceSystem({
      snapshots: { 'tank/media': [snap(day(10), 3e9), snap(day(20), 2e9), snap(day(30), 1e9)] },
    });
    expect(entry(await reported(fake), 'tank/media')).toMatchObject({
      referenced_start_bytes: 1e9,
      referenced_end_bytes: 3e9,
      change_bytes: 2e9,
      observed_start: '2023-10-15T22:13:20.000Z',
      observed_end: '2023-11-04T22:13:20.000Z',
    });
  });

  it('reads the creation time whether the system states it as digits or as a number', async () => {
    const fake = spaceSystem({
      snapshots: {
        'tank/media': [
          { properties: { creation: { rawvalue: day(30) / 1000 }, referenced: { parsed: 1e9 } } },
          snap(day(10), 3e9),
        ],
      },
    });
    expect(entry(await reported(fake), 'tank/media').observed_start).toBe(
      '2023-10-15T22:13:20.000Z',
    );
  });

  it('reports the ten largest datasets and says when it left some out', async () => {
    const many = Array.from({ length: 12 }, (_, index) =>
      dataset(`tank/d${index}`, 'tank', index * 1e9),
    );
    const report = await reported(spaceSystem({ datasets: many }));
    expect(report.truncated_datasets).toBe(true);
    // Largest first, and the two smallest left out — not the alphabetical ten.
    expect(report.datasets.map((row) => row.dataset)).toEqual([
      'tank/d11',
      'tank/d10',
      'tank/d9',
      'tank/d8',
      'tank/d7',
      'tank/d6',
      'tank/d5',
      'tank/d4',
      'tank/d3',
      'tank/d2',
    ]);
    // Every dataset the system named counts towards the pool's coverage, not
    // only the ten reported.
    expect(report.pools[0].datasets_total).toBe(12);
  });

  it('breaks a tie on the dataset name and orders an unreadable size last', async () => {
    const report = await reported(
      spaceSystem({
        datasets: [
          dataset('tank/b', 'tank', 1e9),
          dataset('tank/unknown', 'tank', null),
          dataset('tank/a', 'tank', 1e9),
        ],
      }),
    );
    expect(report.datasets.map((row) => row.dataset)).toEqual([
      'tank/a',
      'tank/b',
      'tank/unknown',
    ]);
    expect(entry(report, 'tank/unknown').used_bytes).toBeNull();
  });

  it('says when a dataset held more snapshots than it read', async () => {
    const many = Array.from({ length: 1001 }, (_, index) =>
      snap(day(30) + index * 60_000, 1000 + index),
    );
    const report = await reported(spaceSystem({ snapshots: { 'tank/media': many } }));
    expect(report.truncated_snapshots).toBe(true);
    // The thousand it read, and the ends of those rather than of the range.
    expect(entry(report, 'tank/media')).toMatchObject({
      snapshots_observed: 1000,
      referenced_start_bytes: 1000,
      referenced_end_bytes: 1999,
    });
  });

  it('does not claim a dataset holds no snapshot when it read only some of them', async () => {
    // A thousand snapshots read, all of them before the range, and no order was
    // asked for — so what lies inside the range is exactly what was not read.
    const many = Array.from({ length: 1001 }, (_, index) =>
      snap(day(300) + index * 60_000, 1000 + index),
    );
    const report = await reported(spaceSystem({ snapshots: { 'tank/media': many } }));
    expect(report.truncated_snapshots).toBe(true);
    expect(entry(report, 'tank/media')).toMatchObject({
      snapshots_observed: 0,
      change_bytes: null,
      unavailable:
        'the system holds more snapshots of this dataset than were read, and no two of ' +
        'the ones read fall at different times in this range',
    });
  });

  it('says the same of a truncated read that found only one instant', async () => {
    // Every snapshot read is at one instant inside the range, so what would
    // have given a second instant is exactly what was left unread.
    const many = Array.from({ length: 1001 }, (_, index) => snap(day(30), 1000 + index));
    const report = await reported(spaceSystem({ snapshots: { 'tank/media': many } }));
    expect(entry(report, 'tank/media')).toMatchObject({
      snapshots_observed: 1000,
      change_bytes: null,
      unavailable:
        'the system holds more snapshots of this dataset than were read, and no two of ' +
        'the ones read fall at different times in this range',
    });
  });

  it('marks a pool no dataset of which could be measured', async () => {
    const report = await reported(spaceSystem({}));
    expect(report.pools[0]).toMatchObject({
      used_percent: 60,
      referenced_change_bytes: null,
      referenced_change_bytes_per_day: null,
      observed_start: null,
      observed_end: null,
      datasets_observed: 0,
      datasets_total: 2,
      unavailable:
        'no dataset reported for this pool yielded a change in this range; each of them names why',
    });
  });

  it('does not blame a pool whose datasets the cap left out entirely', async () => {
    // The cap is over the whole system, so one pool's large datasets can crowd
    // another's out. Nothing of `spare` was looked at, and saying its datasets
    // yielded no change would read as a finding about it.
    const report = await reported(
      spaceSystem({
        datasets: [
          ...Array.from({ length: 10 }, (_, index) =>
            dataset(`tank/d${index}`, 'tank', (index + 2) * 1e9),
          ),
          dataset('spare/small', 'spare', 1e9),
        ],
        pools: [
          { name: 'tank', size: 10e9, allocated: 6e9, free: 4e9 },
          { name: 'spare', size: 2e9, allocated: 1e9, free: 1e9 },
        ],
      }),
    );
    expect(report.datasets.map((row) => row.pool)).not.toContain('spare');
    expect(report.pools.filter((row) => row.pool === 'spare')[0]).toMatchObject({
      used_percent: 50,
      datasets_observed: 0,
      datasets_total: 1,
      unavailable:
        'no dataset of this pool is among the ones reported, so nothing was measured for it',
    });
  });

  it('names a pool the system did not list, in place of its levels', async () => {
    const report = await reported(spaceSystem({ pools: [] }));
    expect(report.pools[0]).toMatchObject({
      pool: 'tank',
      used_bytes: null,
      free_bytes: null,
      total_bytes: null,
      used_percent: null,
      levels_unavailable: 'the system did not list this pool',
    });
  });

  it('reports levels it cannot read as null rather than as an empty pool', async () => {
    const report = await reported(
      spaceSystem({ pools: [{ name: 'tank' }, { name: '' }, { size: 1 }] }),
    );
    expect(report.pools).toHaveLength(1);
    expect(report.pools[0]).toMatchObject({
      used_bytes: null,
      total_bytes: null,
      used_percent: null,
      levels_unavailable: null,
    });
  });

  it('states no percentage of a pool whose size the system reported as zero', async () => {
    const report = await reported(
      spaceSystem({ pools: [{ name: 'tank', size: 0, allocated: 0, free: 0 }] }),
    );
    expect(report.pools[0]).toMatchObject({ total_bytes: 0, used_percent: null });
  });

  it('still reports the trends when the pool listing could not be read', async () => {
    const fake = spaceSystem({
      snapshots: { 'tank/media': [snap(day(30), 1e9), snap(day(10), 3e9)] },
      failures: { 'pool.query': new Error('pools unavailable') },
    });
    const report = await reported(fake);
    expect(report.pools[0]).toMatchObject({
      used_bytes: null,
      levels_unavailable: 'pools unavailable',
      referenced_change_bytes: 2e9,
      datasets_total: 2,
      unavailable: null,
    });
    expect(entry(report, 'tank/media').change_bytes).toBe(2e9);
  });

  it('still reports the pools when the dataset listing could not be read', async () => {
    const fake = spaceSystem({ failures: { 'pool.dataset.query': new Error('datasets unavailable') } });
    const report = await reported(fake);
    expect(report.datasets).toEqual([]);
    expect(report.pools[0]).toMatchObject({
      pool: 'tank',
      used_percent: 60,
      // Not zero: "this pool has no datasets" is a claim, and nothing looked.
      datasets_total: null,
      unavailable: 'datasets unavailable',
    });
  });

  it('fails with the system\'s own reason when neither listing could be read', async () => {
    const fake = spaceSystem({
      failures: {
        'pool.dataset.query': new Error('datasets unavailable'),
        'pool.query': new Error('pools unavailable'),
      },
    });
    // An empty result would read as a system holding no storage at all.
    await expect(reportingSpaceTrends.handler(fake.ctx, RANGE)).rejects.toThrow(
      'datasets unavailable',
    );
  });

  it('fails rather than hiding a failed listing behind a listing that named nothing', async () => {
    // The pool read succeeded and named no pool, so there is no entry to carry
    // the dataset read's failure — which is the same silence as both failing.
    const fake = spaceSystem({
      pools: [],
      failures: { 'pool.dataset.query': new Error('datasets unavailable') },
    });
    await expect(reportingSpaceTrends.handler(fake.ctx, RANGE)).rejects.toThrow(
      'datasets unavailable',
    );
  });

  it('fails when the pool listing failed and the system listed no dataset either', async () => {
    const fake = spaceSystem({
      datasets: [],
      failures: { 'pool.query': new Error('pools unavailable') },
    });
    await expect(reportingSpaceTrends.handler(fake.ctx, RANGE)).rejects.toThrow(
      'pools unavailable',
    );
  });

  it('answers a system that holds nothing, which is not a failure', async () => {
    const report = await reported(spaceSystem({ datasets: [], pools: [] }));
    expect(report).toMatchObject({ pools: [], datasets: [], truncated_datasets: false });
  });

  it('reports on what the system named a dataset, and attributes one whose pool it did not', async () => {
    const report = await reported(
      spaceSystem({
        datasets: [
          dataset('tank/media', 'tank', 5e9),
          { id: 'other/vm', used: { parsed: 2e9 } },
          { pool: 'tank', used: { parsed: 9e9 } },
          null,
          'tank/nope',
        ],
      }),
    );
    expect(report.datasets.map((row) => row.dataset)).toEqual(['tank/media', 'other/vm']);
    expect(entry(report, 'other/vm').pool).toBe('other');
    expect(report.pools.map((row) => row.pool)).toEqual(['other', 'tank']);
  });

  it('asks the system for each dataset\'s snapshots by name, bounded, with two properties', async () => {
    const fake = healthy();
    await reported(fake);
    expect(fake.query).toHaveBeenCalledWith(
      'pool.snapshot.query',
      [['dataset', '=', 'tank/media']],
      { limit: 1001, extra: { properties: ['creation', 'referenced'] } },
    );
    expect(fake.query).toHaveBeenCalledWith('pool.dataset.query', [], {
      extra: { retrieve_children: true, properties: ['used'] },
    });
  });

  it('refuses a bound it cannot read rather than silently using the default', async () => {
    await expect(
      reportingSpaceTrends.handler(healthy().ctx, { start: 'last month' }),
    ).rejects.toThrow(/must be an ISO 8601 timestamp/);
  });

  it('refuses a range that does not run forwards', async () => {
    await expect(
      reportingSpaceTrends.handler(healthy().ctx, { start: '2023-11-14', end: '2023-10-14' }),
    ).rejects.toThrow('"start" must be before "end"');
  });
});

describe('reporting_app_vm_usage', () => {
  /**
   * An app as `app.query` reports one. `config` is the install-time form the
   * user filled in and routinely holds a credential; it is on the fixture so
   * that the test that it does not survive the mapping is worth something.
   */
  const app = (over: Record<string, unknown> = {}) => ({
    id: 'plex',
    name: 'plex',
    state: 'RUNNING',
    version: '1.2.3',
    active_workloads: { containers: 1 },
    config: { plex_claim_token: 'SECRET-CLAIM-TOKEN' },
    ...over,
  });

  /** A libvirt-backed VM as `vm.query` reports one: the state nested in `status`. */
  const vm = (over: Record<string, unknown> = {}) => ({
    id: 1,
    name: 'buildbox',
    memory: 4096,
    autostart: true,
    status: { state: 'RUNNING', pid: 1234, domain_state: 'RUNNING' },
    devices: [{ dtype: 'DISK', attributes: { path: '/dev/zvol/tank/buildbox' } }],
    ...over,
  });

  /** An incus-backed VM as `virt.instance.query` reports one: one flat status word. */
  const instance = (over: Record<string, unknown> = {}) => ({
    id: 'web',
    name: 'web',
    type: 'VM',
    status: 'RUNNING',
    cpu: '4',
    memory: 8589934592,
    environment: { API_TOKEN: 'SECRET-GUEST-TOKEN' },
    ...over,
  });

  interface Entry {
    kind: string;
    source: string;
    id: string | number | null;
    name: string | null;
    state: string | null;
    cpu_percent: number | null;
    cpu_unavailable: string | null;
    memory_used_bytes: number | null;
    memory_unavailable: string | null;
  }

  interface Report {
    entries: Entry[];
    failures: { source: string; error: string }[];
  }

  interface Fake {
    ctx: ToolContext;
    call: ReturnType<typeof vi.fn>;
    query: ReturnType<typeof vi.fn>;
  }

  interface Options {
    apps?: unknown[];
    vms?: unknown[];
    instances?: unknown[];
    /** What `vm.get_memory_usage` answers, per VM id. */
    memory?: Record<number, unknown>;
    /** Keyed by method, or by `vm.get_memory_usage:<id>` for one VM's read. */
    failures?: Record<string, unknown>;
  }

  /**
   * A SystemHandle answering per listing, and per VM ID for the memory read —
   * which neither `fakeSystem` nor `failingSystem` can do: they key on the
   * method alone, and every VM's memory comes back from the same method
   * distinguished only by the id asked for.
   */
  const usageSystem = (options: Options = {}): Fake => {
    const failures = options.failures ?? {};
    const memory = options.memory ?? { 1: 2147483648 };
    const listings: Record<string, unknown> = {
      ['app.query']: options.apps ?? [app()],
      ['vm.query']: options.vms ?? [vm()],
      ['virt.instance.query']: options.instances ?? [instance()],
    };
    const query = vi.fn((method: string) =>
      method in failures ? throwError(() => failures[method]) : of(listings[method]),
    );
    // The client takes a call's parameters as one tuple, so the id arrives
    // wrapped: `call('vm.get_memory_usage', [1])`.
    const call = vi.fn((method: string, params: [number]) => {
      const key = `${method}:${params[0]}`;
      return key in failures ? throwError(() => failures[key]) : of(memory[params[0]]);
    });
    const system = { name: 'nas', client: { api: { call, query } } } as unknown as SystemHandle;
    return { ctx: { system }, call, query };
  };

  const reported = async (fake: Fake): Promise<Report> =>
    (await reportingAppVmUsage.handler(fake.ctx, {})) as Report;

  /** The entries a system of these listings reports. */
  const entries = async (options: Options = {}): Promise<Entry[]> =>
    (await reported(usageSystem(options))).entries;

  /** The one entry a system holding a single workload of that kind reports. */
  const oneApp = async (over: Record<string, unknown>): Promise<Entry> =>
    (await entries({ apps: [app(over)], vms: [], instances: [] }))[0];

  const oneVm = async (
    over: Record<string, unknown>,
    memory?: Record<number, unknown>,
  ): Promise<Entry> => (await entries({ apps: [], vms: [vm(over)], instances: [], memory }))[0];

  const oneInstance = async (over: Record<string, unknown>): Promise<Entry> =>
    (await entries({ apps: [], vms: [], instances: [instance(over)] }))[0];

  it('reports every app and virtual machine in one list, each tagged with its kind', async () => {
    expect(await reported(usageSystem())).toEqual({
      entries: [
        {
          kind: 'app',
          source: 'app',
          id: 'plex',
          name: 'plex',
          state: 'RUNNING',
          cpu_percent: null,
          cpu_unavailable: expect.stringContaining('subscription'),
          memory_used_bytes: null,
          memory_unavailable: expect.stringContaining('subscription'),
        },
        {
          kind: 'vm',
          source: 'vm',
          id: 1,
          name: 'buildbox',
          state: 'RUNNING',
          cpu_percent: null,
          cpu_unavailable: expect.stringContaining('no per-virtual-machine CPU'),
          memory_used_bytes: 2147483648,
          memory_unavailable: null,
        },
        {
          kind: 'vm',
          source: 'virt_instance',
          id: 'web',
          name: 'web',
          state: 'RUNNING',
          cpu_percent: null,
          cpu_unavailable: expect.stringContaining('no per-virtual-machine CPU'),
          memory_used_bytes: null,
          memory_unavailable: expect.stringContaining('incus-backed'),
        },
      ],
      failures: [],
    });
  });

  it('reads a running libvirt VM by its own id, so two VMs do not share one figure', async () => {
    const fake = usageSystem({
      apps: [],
      instances: [],
      vms: [vm(), vm({ id: 2, name: 'mailer' })],
      memory: { 1: 2147483648, 2: 536870912 },
    });
    expect((await reported(fake)).entries.map((entry) => entry.memory_used_bytes)).toEqual([
      2147483648, 536870912,
    ]);
    expect(fake.call.mock.calls).toEqual([
      ['vm.get_memory_usage', [1]],
      ['vm.get_memory_usage', [2]],
    ]);
  });

  it('reports a stopped VM as stopped rather than as consuming nothing', async () => {
    const fake = usageSystem({
      apps: [],
      instances: [],
      vms: [vm({ status: { state: 'STOPPED', domain_state: 'SHUTOFF' } })],
    });
    const [entry] = (await reported(fake)).entries;
    expect(entry.state).toBe('STOPPED');
    expect(entry.memory_used_bytes).toBeNull();
    expect(entry.memory_unavailable).toMatch(/not RUNNING/);
    expect(entry.memory_unavailable).toMatch(/stopped machine is consuming none/);
    // Nothing is asked about a VM that is not running: the call would fail on a
    // domain that does not exist, and that error text would be a worse answer
    // than the reason there is no figure.
    expect(fake.call).not.toHaveBeenCalled();
  });

  it('reports the reason the system gave when a memory read fails', async () => {
    const [entry] = await entries({
      apps: [],
      instances: [],
      failures: { ['vm.get_memory_usage:1']: { reason: 'domain not found' } },
    });
    expect(entry.memory_used_bytes).toBeNull();
    expect(entry.memory_unavailable).toBe('domain not found');
  });

  it('reports no figure where the system answered with something that is not one', async () => {
    const entry = await oneVm({}, { 1: 'a lot' });
    expect(entry.memory_used_bytes).toBeNull();
    expect(entry.memory_unavailable).toMatch(/no memory figure/);
  });

  it('reports no figure, and asks nothing, where a VM has no identifier to ask by', async () => {
    const fake = usageSystem({ apps: [], instances: [], vms: [vm({ id: null })] });
    const [entry] = (await reported(fake)).entries;
    expect(entry.id).toBeNull();
    expect(entry.memory_unavailable).toMatch(/no identifier/);
    expect(fake.call).not.toHaveBeenCalled();
  });

  it('reports a state it could not read as null rather than as a state', async () => {
    expect(await oneApp({ state: 42 })).toMatchObject({ state: null });
    // A row whose `status` is not a record at all: the type declares it present
    // and non-null, and a system that sent neither must answer null.
    expect(await oneVm({ status: null })).toMatchObject({ state: null });
    expect(await oneInstance({ status: '' })).toMatchObject({ state: null });
  });

  it('does not report a VM whose state it could not read as one that is stopped', async () => {
    const fake = usageSystem({ apps: [], instances: [], vms: [vm({ status: null })] });
    const [entry] = (await reported(fake)).entries;
    expect(entry.memory_unavailable).toMatch(/reported no state/);
    // An unreadable state is not evidence the machine is stopped, so nothing
    // here may say it is consuming nothing.
    expect(entry.memory_unavailable).not.toMatch(/consuming none/);
    expect(fake.call).not.toHaveBeenCalled();
  });

  it('does not claim a suspended VM is consuming nothing', async () => {
    const entry = await oneVm({ status: { state: 'SUSPENDED', domain_state: 'PAUSED' } });
    expect(entry.state).toBe('SUSPENDED');
    expect(entry.memory_used_bytes).toBeNull();
    // The marker is the same one a stopped machine carries, and it states both
    // readings rather than asserting the wrong one: `state` says which this is.
    expect(entry.memory_unavailable).toMatch(/suspended one may still be holding/);
  });

  it('excludes incus containers even where the middleware kept them', async () => {
    const fake = usageSystem({
      apps: [],
      vms: [],
      instances: [instance(), instance({ id: 'dns', name: 'dns', type: 'CONTAINER' })],
    });
    expect((await reported(fake)).entries.map((entry) => entry.id)).toEqual(['web']);
    // The filter is asked of the middleware too; an unrecognised one is dropped
    // rather than refused, which is what the re-check above is for.
    expect(fake.query).toHaveBeenCalledWith('virt.instance.query', [['type', '=', 'VM']]);
  });

  it('surfaces neither the install-time config nor a field a later release adds', async () => {
    const report = await reported(
      usageSystem({
        apps: [app({ future_field: 'added by a later TrueNAS release' })],
        vms: [vm({ future_field: 'added by a later TrueNAS release' })],
        instances: [instance({ future_field: 'added by a later TrueNAS release' })],
      }),
    );
    expect(JSON.stringify(report)).not.toMatch(/SECRET|future_field/);
    expect(Object.keys(report.entries[0])).toEqual([
      'kind',
      'source',
      'id',
      'name',
      'state',
      'cpu_percent',
      'cpu_unavailable',
      'memory_used_bytes',
      'memory_unavailable',
    ]);
  });

  it('reports the listings that answered when another one fails', async () => {
    const report = await reported(
      usageSystem({ failures: { ['app.query']: new Error('apps are not installed') } }),
    );
    expect(report.entries.map((entry) => entry.source)).toEqual(['vm', 'virt_instance']);
    expect(report.failures).toEqual([{ source: 'app', error: 'apps are not installed' }]);
  });

  it('names every listing that failed rather than reporting an empty system', async () => {
    const report = await reported(
      usageSystem({
        failures: {
          ['app.query']: 'apps unavailable',
          ['vm.query']: 'vm stack absent',
          ['virt.instance.query']: 'virt stack absent',
        },
      }),
    );
    expect(report.entries).toEqual([]);
    expect(report.failures).toEqual([
      { source: 'app', error: 'apps unavailable' },
      { source: 'vm', error: 'vm stack absent' },
      { source: 'virt_instance', error: 'virt stack absent' },
    ]);
  });

  it('reports a system running nothing as empty, with nothing to explain', async () => {
    expect(await reported(usageSystem({ apps: [], vms: [], instances: [] }))).toEqual({
      entries: [],
      failures: [],
    });
  });
});

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

describe('system_health_report', () => {
  /** One leaf of a vdev tree, as `pool.query` nests it under `topology`. */
  function device(over: Record<string, unknown> = {}): Record<string, unknown> {
    return { name: 'sda1', type: 'DISK', status: 'ONLINE', disk: 'sda', children: [], ...over };
  }

  /**
   * One pool as `pool.query` reports it. The same rows feed both
   * `storage_pool_status` and `storage_pool_topology`, which is how the tool
   * itself reads them: two calls of the same verb.
   */
  function pool(over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      name: 'tank',
      status: 'ONLINE',
      healthy: true,
      size: 1000,
      allocated: 100,
      free: 900,
      topology: { data: [device()] },
      ...over,
    };
  }

  /** One alert as `alert.list` reports it. */
  function alert(over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: '1',
      klass: 'ZpoolCapacityWarning',
      level: 'WARNING',
      formatted: 'tank is filling up',
      datetime: { $date: 0 },
      dismissed: false,
      ...over,
    };
  }

  /** An `update.status` payload for a system that is already up to date. */
  function upToDate(): Record<string, unknown> {
    return {
      code: 'NORMAL',
      error: null,
      status: { new_version: null, current_version: { train: 'TN-25.04' } },
    };
  }

  /** Every method the four composed tools read, answering a healthy system. */
  function healthy(over: Partial<Record<string, unknown>> = {}): Partial<Record<string, unknown>> {
    return {
      ['pool.query']: [pool()],
      ['alert.list']: [],
      ['update.status']: upToDate(),
      ['system.version']: 'TrueNAS-25.04.0',
      ...over,
    };
  }

  /** The report, typed loosely: the tool's own contract is an opaque object. */
  type Report = Record<string, Record<string, unknown> & { unavailable: string | null }> & {
    verdict: string;
    reasons: { section: string; severity: string; detail: string }[];
  };

  async function report(responses: Partial<Record<string, unknown>>): Promise<Report> {
    const { ctx } = fakeSystem(responses);
    return (await systemHealthReport.handler(ctx, {})) as Report;
  }

  it('is OK only when every section was read and none of them raised anything', async () => {
    const result = await report(healthy());
    expect(result.verdict).toBe('OK');
    expect(result.reasons).toEqual([]);
    expect(result['pools']).toEqual({
      unavailable: null,
      reported: 1,
      entries: [
        {
          name: 'tank',
          status: 'ONLINE',
          healthy: true,
          size_bytes: 1000,
          allocated_bytes: 100,
          used_percent: 10,
        },
      ],
      truncated: false,
    });
    expect(result['alerts']).toEqual({
      unavailable: null,
      total: 0,
      by_level: [],
      most_severe: [],
      truncated: false,
    });
    expect(result['disks']).toEqual({
      unavailable: null,
      total: 1,
      healthy: 1,
      unhealthy: 0,
      unranked: 0,
      worst: [],
      truncated: false,
    });
    expect(result['updates']).toEqual({
      unavailable: null,
      update_available: false,
      current_version: 'TrueNAS-25.04.0',
      new_version: null,
      check_error: null,
      version_error: null,
    });
  });

  it('states how full a pool is to one decimal place', async () => {
    const result = await report(
      healthy({ ['pool.query']: [pool({ size: 3000, allocated: 1000 })] }),
    );
    expect(result['pools']['entries']).toEqual([
      expect.objectContaining({ used_percent: 33.3 }),
    ]);
  });

  it('is CRITICAL for an unhealthy pool, naming the status the system gave', async () => {
    const result = await report(
      healthy({ ['pool.query']: [pool({ healthy: false, status: 'DEGRADED' })] }),
    );
    expect(result.verdict).toBe('CRITICAL');
    expect(result.reasons).toContainEqual({
      section: 'pools',
      severity: 'critical',
      detail: 'pool tank is not healthy; the system reports its status as DEGRADED',
    });
  });

  it('names an unhealthy pool that reported no status, and one with no name', async () => {
    const result = await report(
      healthy({
        ['pool.query']: [pool({ name: null, healthy: false, status: null, topology: null })],
      }),
    );
    expect(result.reasons).toContainEqual({
      section: 'pools',
      severity: 'critical',
      detail:
        'pool a pool the system did not name is not healthy; the system reports its status as nothing this report could read',
    });
  });

  it('warns at 80% full and is critical at 90%', async () => {
    const warned = await report(
      healthy({ ['pool.query']: [pool({ size: 100, allocated: 85 })] }),
    );
    expect(warned.verdict).toBe('WARNING');
    expect(warned.reasons).toEqual([
      { section: 'pools', severity: 'warning', detail: 'pool tank is 85% full' },
    ]);

    const critical = await report(
      healthy({ ['pool.query']: [pool({ size: 100, allocated: 95 })] }),
    );
    expect(critical.verdict).toBe('CRITICAL');
    expect(critical.reasons).toEqual([
      { section: 'pools', severity: 'critical', detail: 'pool tank is 95% full' },
    ]);
  });

  it('does not establish capacity for a pool whose size it could not read', async () => {
    const result = await report(healthy({ ['pool.query']: [pool({ size: 'lots' })] }));
    expect(result.verdict).toBe('UNKNOWN');
    expect(result['pools']['entries']).toEqual([
      expect.objectContaining({ size_bytes: null, used_percent: null }),
    ]);
    expect(result.reasons).toEqual([
      {
        section: 'pools',
        severity: 'unknown',
        detail:
          'pool tank reported no size and allocation this report could read, so how full it is is not established',
      },
    ]);
  });

  it('does not establish capacity for a pool of no size, rather than reading it as empty', async () => {
    const result = await report(healthy({ ['pool.query']: [pool({ size: 0, allocated: 0 })] }));
    expect(result['pools']['entries']).toEqual([
      expect.objectContaining({ size_bytes: 0, used_percent: null }),
    ]);
    expect(result.verdict).toBe('UNKNOWN');
  });

  it('does not establish health for a pool that did not say whether it is healthy', async () => {
    const result = await report(healthy({ ['pool.query']: [pool({ healthy: 'yes' })] }));
    expect(result.verdict).toBe('UNKNOWN');
    expect(result.reasons).toContainEqual({
      section: 'pools',
      severity: 'unknown',
      detail: 'pool tank did not report whether it is healthy',
    });
  });

  it('counts alerts per level over all of them, most severe first', async () => {
    const result = await report(
      healthy({
        ['alert.list']: [
          alert({ level: 'INFO' }),
          alert({ level: 'CRITICAL' }),
          alert({ level: 'WARNING' }),
          alert({ level: 'CRITICAL' }),
        ],
      }),
    );
    expect(result['alerts']['total']).toBe(4);
    expect(result['alerts']['by_level']).toEqual([
      { level: 'CRITICAL', count: 2 },
      { level: 'WARNING', count: 1 },
      { level: 'INFO', count: 1 },
    ]);
  });

  it('ranks ERROR and above as critical, WARNING as a warning, and INFO and NOTICE as neither', async () => {
    const result = await report(
      healthy({
        ['alert.list']: [
          alert({ level: 'ERROR' }),
          alert({ level: 'WARNING' }),
          alert({ level: 'NOTICE' }),
          alert({ level: 'INFO' }),
        ],
      }),
    );
    expect(result.verdict).toBe('CRITICAL');
    expect(result.reasons).toEqual([
      { section: 'alerts', severity: 'critical', detail: 'the system has raised 1 ERROR alert' },
      { section: 'alerts', severity: 'warning', detail: 'the system has raised 1 WARNING alert' },
    ]);
  });

  it('counts more than one alert at a level in English', async () => {
    const result = await report(
      healthy({ ['alert.list']: [alert({ level: 'EMERGENCY' }), alert({ level: 'EMERGENCY' })] }),
    );
    expect(result.reasons).toEqual([
      {
        section: 'alerts',
        severity: 'critical',
        detail: 'the system has raised 2 EMERGENCY alerts',
      },
    ]);
  });

  it('reports an alert level it does not rank at unknown rather than ignoring it', async () => {
    const result = await report(healthy({ ['alert.list']: [alert({ level: 'SPICY' })] }));
    expect(result.verdict).toBe('UNKNOWN');
    expect(result.reasons).toEqual([
      {
        section: 'alerts',
        severity: 'unknown',
        detail: 'the system has raised 1 alert at SPICY, a severity this report does not rank',
      },
    ]);
  });

  it('reports an alert whose level the system did not name', async () => {
    const result = await report(healthy({ ['alert.list']: [alert({ level: null })] }));
    expect(result['alerts']['by_level']).toEqual([{ level: null, count: 1 }]);
    expect(result.reasons).toEqual([
      {
        section: 'alerts',
        severity: 'unknown',
        detail:
          'the system has raised 1 alert at a severity the system did not name, a severity this report does not rank',
      },
    ]);
  });

  it('orders equally severe levels by name, so two calls answer alike', async () => {
    const result = await report(
      healthy({
        ['alert.list']: [
          alert({ level: 'ZED' }),
          alert({ level: null }),
          alert({ level: 'ABLE' }),
        ],
      }),
    );
    expect(result['alerts']['by_level']).toEqual([
      { level: null, count: 1 },
      { level: 'ABLE', count: 1 },
      { level: 'ZED', count: 1 },
    ]);
  });

  it('lists the worst alerts first and caps the list while counting every one', async () => {
    const alerts = [
      ...Array.from({ length: 11 }, () => alert({ level: 'INFO', klass: 'Info' })),
      alert({ level: 'EMERGENCY', klass: 'Fire' }),
    ];
    const result = await report(healthy({ ['alert.list']: alerts }));
    expect(result['alerts']['total']).toBe(12);
    expect(result['alerts']['truncated']).toBe(true);
    const listed = result['alerts']['most_severe'] as { klass: string }[];
    expect(listed).toHaveLength(10);
    expect(listed[0]).toEqual({
      level: 'EMERGENCY',
      klass: 'Fire',
      formatted: 'tank is filling up',
      dismissed: false,
    });
    // The finding survives the cap even when its alert does not: the eleven
    // INFO alerts are counted in full and the one EMERGENCY still reasons.
    expect(result['alerts']['by_level']).toEqual([
      { level: 'EMERGENCY', count: 1 },
      { level: 'INFO', count: 11 },
    ]);
  });

  it('counts leaf devices only, so one failed disk is not two problems', async () => {
    const result = await report(
      healthy({
        ['pool.query']: [
          pool({
            healthy: false,
            status: 'DEGRADED',
            topology: {
              data: [
                {
                  name: 'mirror-0',
                  type: 'MIRROR',
                  status: 'DEGRADED',
                  disk: null,
                  children: [device(), device({ name: 'sdb1', status: 'FAULTED', disk: 'sdb' })],
                },
              ],
            },
          }),
        ],
      }),
    );
    expect(result['disks']).toEqual({
      unavailable: null,
      total: 2,
      healthy: 1,
      unhealthy: 1,
      unranked: 0,
      worst: [{ pool: 'tank', name: 'sdb1', disk: 'sdb', status: 'FAULTED' }],
      truncated: false,
    });
    expect(result.reasons).toContainEqual({
      section: 'disks',
      severity: 'critical',
      detail: 'ZFS reports 1 device beneath the pools in a state it treats as a failure',
    });
  });

  it('treats AVAIL and INUSE as healthy on a spare and nowhere else', async () => {
    const result = await report(
      healthy({
        ['pool.query']: [
          pool({
            topology: {
              spare: [
                device({ name: 'sdy', status: 'AVAIL', disk: 'sdy' }),
                device({ name: 'sdz', status: 'INUSE', disk: 'sdz' }),
              ],
              data: [device({ name: 'sdc1', status: 'AVAIL', disk: 'sdc' })],
            },
          }),
        ],
      }),
    );
    expect(result['disks']).toEqual(
      expect.objectContaining({ total: 3, healthy: 2, unhealthy: 0, unranked: 1 }),
    );
    expect(result['disks']['worst']).toEqual([
      { pool: 'tank', name: 'sdc1', disk: 'sdc', status: 'AVAIL' },
    ]);
  });

  it('reports a device state it does not rank as unranked rather than as healthy', async () => {
    const result = await report(
      healthy({ ['pool.query']: [pool({ topology: { data: [device({ status: 'SPICY' })] } })] }),
    );
    expect(result.verdict).toBe('UNKNOWN');
    expect(result.reasons).toContainEqual({
      section: 'disks',
      severity: 'unknown',
      detail: '1 device beneath the pools reported a state this report does not rank',
    });
  });

  it('reports a device the system reported no state for', async () => {
    const result = await report(
      healthy({ ['pool.query']: [pool({ topology: { data: [device({ status: null })] } })] }),
    );
    expect(result['disks']['worst']).toEqual([
      { pool: 'tank', name: 'sda1', disk: 'sda', status: null },
    ]);
  });

  it('reports a device it can no longer resolve to a disk, by its place in the tree', async () => {
    const result = await report(
      healthy({
        ['pool.query']: [
          pool({ topology: { data: [device({ status: 'REMOVED', disk: null })] } }),
        ],
      }),
    );
    expect(result['disks']['worst']).toEqual([
      { pool: 'tank', name: 'sda1', disk: null, status: 'REMOVED' },
    ]);
  });

  it('counts every failed device while capping the list that names them', async () => {
    const result = await report(
      healthy({
        ['pool.query']: [
          pool({
            topology: {
              data: Array.from({ length: 12 }, (_unused, index) =>
                device({ name: `sd${index}`, status: 'FAULTED', disk: `sd${index}` }),
              ),
            },
          }),
        ],
      }),
    );
    expect(result['disks']).toEqual(
      expect.objectContaining({ total: 12, unhealthy: 12, truncated: true }),
    );
    expect(result['disks']['worst']).toHaveLength(10);
    expect(result.reasons).toContainEqual({
      section: 'disks',
      severity: 'critical',
      detail: 'ZFS reports 12 devices beneath the pools in a state it treats as a failure',
    });
  });

  it('counts every pool while capping the list that names them', async () => {
    const pools = Array.from({ length: 12 }, (_unused, index) => pool({ name: `tank${index}` }));
    const result = await report(healthy({ ['pool.query']: pools }));
    expect(result['pools']['reported']).toBe(12);
    expect(result['pools']['entries']).toHaveLength(10);
    expect(result['pools']['truncated']).toBe(true);
  });

  it('reports an available update without moving the verdict', async () => {
    const result = await report(
      healthy({
        ['update.status']: {
          code: 'NORMAL',
          error: null,
          status: {
            new_version: { version: '25.04.1' },
            current_version: { train: 'TN-25.04' },
          },
        },
      }),
    );
    expect(result.verdict).toBe('OK');
    expect(result.reasons).toEqual([]);
    expect(result['updates']).toEqual({
      unavailable: null,
      update_available: true,
      current_version: 'TrueNAS-25.04.0',
      new_version: '25.04.1',
      check_error: null,
      version_error: null,
    });
  });

  it('is UNKNOWN when the running version could not be read, though the check worked', async () => {
    // `system_update_status` reads the version separately from the check, so
    // this system answers one and not the other. Without a reason of its own
    // the null `current_version` would sit in an OK report saying nothing.
    const { ctx } = failingSystem(healthy(), {
      ['system.version']: new Error('the system did not answer'),
    });
    const result = (await systemHealthReport.handler(ctx, {})) as Report;
    expect(result.verdict).toBe('UNKNOWN');
    expect(result['updates']).toEqual({
      unavailable: null,
      update_available: false,
      current_version: null,
      new_version: null,
      check_error: null,
      version_error: 'the system did not answer',
    });
    expect(result.reasons).toEqual([
      {
        section: 'updates',
        severity: 'unknown',
        detail:
          'the running version could not be read, so what this system is on is not established: the system did not answer',
      },
    ]);
  });

  it('names both update failures when neither read answered', async () => {
    const { ctx } = failingSystem(
      {
        ...healthy(),
        ['update.status']: { code: 'ERROR', error: { reason: 'no route to host' }, status: null },
      },
      { ['system.version']: new Error('the system did not answer') },
    );
    const result = (await systemHealthReport.handler(ctx, {})) as Report;
    expect(result.reasons.map((reason) => reason.detail)).toEqual([
      'the update check did not complete, so whether this system is up to date is not established: no route to host',
      'the running version could not be read, so what this system is on is not established: the system did not answer',
    ]);
  });

  it('is UNKNOWN when the update check did not complete, naming what the system said', async () => {
    const result = await report(
      healthy({
        ['update.status']: {
          code: 'ERROR',
          error: { reason: 'the update server could not be reached', errname: 'ENETUNREACH' },
          status: null,
        },
      }),
    );
    expect(result.verdict).toBe('UNKNOWN');
    expect(result['updates']).toEqual(
      expect.objectContaining({
        update_available: null,
        check_error: 'the update server could not be reached',
      }),
    );
    expect(result.reasons).toEqual([
      {
        section: 'updates',
        severity: 'unknown',
        detail:
          'the update check did not complete, so whether this system is up to date is not established: the update server could not be reached',
      },
    ]);
  });

  it('marks the sections a failed read took out, and still reports the rest', async () => {
    const { ctx } = failingSystem(healthy(), {
      ['pool.query']: new Error('the middleware is not listening'),
    });
    const result = (await systemHealthReport.handler(ctx, {})) as Report;
    expect(result.verdict).toBe('UNKNOWN');
    // One read, and both sections that stand on it say so independently.
    expect(result['pools']).toEqual({
      unavailable: 'the middleware is not listening',
      reported: null,
      entries: null,
      truncated: null,
    });
    expect(result['disks']).toEqual({
      unavailable: 'the middleware is not listening',
      total: null,
      healthy: null,
      unhealthy: null,
      unranked: null,
      worst: null,
      truncated: null,
    });
    expect(result.reasons).toEqual([
      {
        section: 'pools',
        severity: 'unknown',
        detail:
          'the pools section could not be read, so nothing about it is established: the middleware is not listening',
      },
      {
        section: 'disks',
        severity: 'unknown',
        detail:
          'the disks section could not be read, so nothing about it is established: the middleware is not listening',
      },
    ]);
    // The sections that did not depend on it are unaffected.
    expect(result['alerts']['unavailable']).toBeNull();
    expect(result['updates']['update_available']).toBe(false);
  });

  it('does not reject when every read failed, and says so section by section', async () => {
    const { ctx } = failingSystem(
      {},
      {
        ['pool.query']: new Error('pools are gone'),
        ['alert.list']: 'alerts are gone',
        ['update.status']: { reason: 'updates are gone' },
      },
    );
    const result = (await systemHealthReport.handler(ctx, {})) as Report;
    expect(result.verdict).toBe('UNKNOWN');
    expect(result['pools']['unavailable']).toBe('pools are gone');
    expect(result['alerts']['unavailable']).toBe('alerts are gone');
    expect(result['disks']['unavailable']).toBe('pools are gone');
    expect(result['updates']['unavailable']).toBe('updates are gone');
    expect(result.reasons).toHaveLength(4);
  });

  it('keeps a CRITICAL verdict while still naming the parts it could not read', async () => {
    const { ctx } = failingSystem(
      { ...healthy(), ['pool.query']: [pool({ healthy: false, status: 'FAULTED' })] },
      { ['alert.list']: new Error('alerts are gone') },
    );
    const result = (await systemHealthReport.handler(ctx, {})) as Report;
    expect(result.verdict).toBe('CRITICAL');
    expect(result.reasons.map((reason) => reason.severity)).toEqual(['critical', 'unknown']);
  });

  it('states a failure the transport gave no words for', async () => {
    const { ctx } = failingSystem(healthy(), { ['alert.list']: 42 });
    const result = (await systemHealthReport.handler(ctx, {})) as Report;
    expect(result['alerts']['unavailable']).toBe('the system reported no reason');
  });

  it('stays small enough to be read in full on a system of ordinary size', async () => {
    // Two pools of twelve disks each, one of them degraded with a failed
    // member, and a dozen alerts — a system with plenty to say. The report is a
    // fixed shape plus three capped lists, so this is close to its ceiling.
    const bay = (prefix: string, status: string) =>
      Array.from({ length: 12 }, (_unused, index) => ({
        name: `${prefix}-${index}`,
        type: 'DISK',
        status: index === 0 ? status : 'ONLINE',
        disk: `${prefix}${index}`,
        children: [],
      }));
    const result = await report(
      healthy({
        ['pool.query']: [
          pool({ name: 'tank', size: 1e12, allocated: 9.2e11, topology: { data: bay('a', 'FAULTED') } }),
          pool({ name: 'vault', size: 4e12, allocated: 1e12, topology: { data: bay('b', 'ONLINE') } }),
        ],
        ['alert.list']: Array.from({ length: 12 }, (_unused, index) =>
          alert({
            level: index % 2 === 0 ? 'WARNING' : 'CRITICAL',
            klass: 'ZpoolCapacityWarning',
            formatted: `Pool tank is consuming 92% of its capacity (alert ${index})`,
          }),
        ),
      }),
    );
    expect(result.verdict).toBe('CRITICAL');
    // A ceiling, not a measurement: it fails if a later change makes the report
    // materially larger, which is the property the ticket asks for.
    expect(JSON.stringify(result).length).toBeLessThan(4096);
  });

  it('is read-only and takes no arguments', () => {
    expect(systemHealthReport.mutating).toBe(false);
    expect(systemHealthReport.requiredRole).toBe(Role.ReadOnly);
    expect(systemHealthReport.inputSchema).toEqual({ type: 'object', properties: {} });
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
    expect(result.certificates).toEqual({
      unavailable: null,
      reported: 6,
      expired: 1,
      expiring_soon: 2,
      expiry_unknown: 1,
      expiring_within_days: 30,
      entries: [
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
