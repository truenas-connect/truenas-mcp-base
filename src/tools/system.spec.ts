import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeSystem, failingSystem } from '@/testing/fake-systems';
import { auditConfig, auditLogQuery, updateStatus } from '@/tools/index';

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

describe('audit_config', () => {
  /**
   * The configuration as `audit.config` sends one, carrying the fields the
   * pinned client's `AuditEntry` declares — including the several this tool
   * deliberately does not report, so that the test that they do not survive the
   * mapping is worth something.
   */
  const config = (over: Record<string, unknown> = {}) => ({
    id: 1,
    retention: 30,
    reservation: 0,
    quota: 0,
    quota_fill_warning: 70,
    quota_fill_critical: 95,
    remote_logging_enabled: false,
    space: {
      used: 1_000,
      used_by_dataset: 900,
      used_by_reservation: 0,
      used_by_snapshots: 100,
      available: 4_000_000,
    },
    enabled_services: { MIDDLEWARE: [], SMB: ['audited-share'], SUDO: [] },
    ...over,
  });

  const read = async (over: Record<string, unknown> = {}): Promise<Record<string, unknown>> => {
    const { ctx } = fakeSystem({ ['audit.config']: config(over) });
    return (await auditConfig.handler(ctx, {})) as Record<string, unknown>;
  };

  /** The services of a result, which is what most cases here are about. */
  const services = async (enabled: unknown): Promise<unknown> =>
    (await read({ enabled_services: enabled }))['services'];

  it('reports the settings through named fields and drops the rest', async () => {
    expect(await read()).toEqual({
      services: [
        { service: 'MIDDLEWARE', scope: [] },
        { service: 'SMB', scope: ['audited-share'] },
        { service: 'SUDO', scope: [] },
      ],
      remote_logging_enabled: false,
      retention_days: 30,
      space_available_bytes: 4_000_000,
    });
  });

  it('sorts services by name, so an unchanged configuration reads the same twice', async () => {
    // The middleware sends a keyed object, whose key order says nothing.
    expect(await services({ SUDO: [], MIDDLEWARE: [], SMB: [] })).toEqual([
      { service: 'MIDDLEWARE', scope: [] },
      { service: 'SMB', scope: [] },
      { service: 'SUDO', scope: [] },
    ]);
  });

  it('passes through a service name the pinned client does not know', async () => {
    // Service names are values rather than fields, so a service a later
    // TrueNAS release begins auditing is answerable without a change here.
    expect(await services({ NFS: ['export'] })).toEqual([{ service: 'NFS', scope: ['export'] }]);
  });

  it('distinguishes a configuration listing no services from one it could not read', async () => {
    // The distinction the criterion is about: an empty list is an answer, and
    // null is the absence of one.
    expect(await services({})).toEqual([]);
    for (const unreadable of [null, undefined, 'MIDDLEWARE', 42, ['MIDDLEWARE']]) {
      expect(await services(unreadable)).toBeNull();
    }
  });

  it('nulls a whole scope rather than dropping the entry it could not read', async () => {
    // A list silently missing one share reads as a share that is not audited,
    // which is the opposite of what is known about it.
    expect(await services({ SMB: ['kept', 7] })).toEqual([{ service: 'SMB', scope: null }]);
    expect(await services({ SMB: ['kept', ''] })).toEqual([{ service: 'SMB', scope: null }]);
    expect(await services({ SMB: 'audited-share' })).toEqual([{ service: 'SMB', scope: null }]);
  });

  it('nulls the whole list rather than dropping a service it could not name', async () => {
    // The same all-or-nothing reading a scope takes: a list quietly one service
    // shorter reads as a service the system does not audit.
    expect(await services({ '': [], SMB: [] })).toBeNull();
  });

  it('does not claim a listed service is audited', async () => {
    // The middleware enumerates what it CAN audit — the pinned client declares
    // all three members required — so presence is not enablement, and the
    // description says so rather than the field name implying otherwise.
    const listed = await services({ MIDDLEWARE: [], SMB: [], SUDO: [] });
    expect(listed).toEqual([
      { service: 'MIDDLEWARE', scope: [] },
      { service: 'SMB', scope: [] },
      { service: 'SUDO', scope: [] },
    ]);
    expect(auditConfig.description).toContain('BEING LISTED HERE IS NOT "THIS SERVICE IS AUDITED"');
  });

  it('reports remote logging three-valued, and never defaults it to false', async () => {
    // A system that reported no value has not been shown to be keeping its
    // audit records on the box.
    expect((await read({ remote_logging_enabled: true }))['remote_logging_enabled']).toBe(true);
    expect((await read({ remote_logging_enabled: false }))['remote_logging_enabled']).toBe(false);
    for (const unreadable of [null, undefined, 'true', 1]) {
      expect((await read({ remote_logging_enabled: unreadable }))['remote_logging_enabled']).toBe(
        null,
      );
    }
  });

  it('nulls the retention the system reported no number for', async () => {
    expect((await read({ retention: 0 }))['retention_days']).toBe(0);
    for (const unreadable of [null, undefined, '30', Number.NaN, Number.POSITIVE_INFINITY]) {
      expect((await read({ retention: unreadable }))['retention_days']).toBeNull();
    }
  });

  it('nulls the remaining space where the system reported none it could read', async () => {
    expect((await read({ space: { available: 0 } }))['space_available_bytes']).toBe(0);
    for (const unreadable of [null, undefined, {}, { available: '4000' }, []]) {
      expect((await read({ space: unreadable }))['space_available_bytes']).toBeNull();
    }
  });

  it('fails rather than answering nulls when the payload is not a configuration', async () => {
    // Reached into rather than guarded, this would throw naming a property
    // rather than the read that failed.
    for (const answer of [null, undefined, 'audit', 7, []]) {
      const { ctx } = fakeSystem({ ['audit.config']: answer });
      await expect(auditConfig.handler(ctx, {})).rejects.toThrow(
        'audit.config did not answer with an audit configuration',
      );
    }
  });

  it('fails rather than answering empty when the configuration could not be read', async () => {
    const { ctx } = failingSystem({}, { ['audit.config']: new Error('audit dataset not mounted') });
    await expect(auditConfig.handler(ctx, {})).rejects.toThrow('audit dataset not mounted');
  });

  it('never mutates: it reads the configuration and nothing else', async () => {
    const { ctx, call, query } = fakeSystem({ ['audit.config']: config() });
    await auditConfig.handler(ctx, {});
    expect(call.mock.calls.map((args) => args[0])).toEqual(['audit.config']);
    expect(query).not.toHaveBeenCalled();
  });
});
