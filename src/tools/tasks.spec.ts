import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeSystem } from '@/testing/fake-systems';
import { cloudsyncTasksList, snapshotTasksList, tasksRecentRuns } from '@/tools/index';

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
