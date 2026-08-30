import { describe, expect, it } from 'vitest';
import { failingSystem } from '@/testing/fake-systems';
import { automatedTasksList } from '@/tools/index';

/**
 * `automated_tasks_list` reads four unrelated methods and reports each as its
 * own section, so every case here is stated as "these methods answered, these
 * failed" — which is what `failingSystem` is for. `fakeSystem` answers every
 * method from one map and cannot make a call fail, and a failing read is most
 * of what this tool is about.
 */
const ALL_METHODS = [
  'cronjob.query',
  'rsynctask.query',
  'cloud_backup.query',
  'initshutdownscript.query',
] as const;

/** Every method answering an empty list, so a case names only what it changes. */
const empty = (): Record<string, unknown> =>
  Object.fromEntries(ALL_METHODS.map((method) => [method, []]));

type Section = { unavailable: string | null; entries: Record<string, unknown>[] | null };

/** The four sections named, so a case reads one by name rather than by index. */
interface Result {
  cron_jobs: Section;
  rsync_tasks: Section;
  cloud_backup_tasks: Section;
  init_shutdown_scripts: Section;
}

const listed = async (
  rows: Record<string, unknown>,
  failures: Record<string, unknown> = {},
): Promise<Result> => {
  const { ctx } = failingSystem({ ...empty(), ...rows }, failures);
  return (await automatedTasksList.handler(ctx, {})) as Result;
};

/** A schedule the renderer describes exactly: daily at 02:00. */
const DAILY_AT_TWO = { minute: '0', hour: '2', dom: '*', month: '*', dow: '*' };

describe('automated_tasks_list', () => {
  it('is read-only and takes no arguments', () => {
    expect(automatedTasksList.mutating).toBe(false);
    expect(automatedTasksList.inputSchema).toEqual({ type: 'object', properties: {} });
  });

  it('reports four sections, each read and empty, on a system with no tasks', async () => {
    expect(await listed({})).toEqual({
      cron_jobs: { unavailable: null, entries: [] },
      rsync_tasks: { unavailable: null, entries: [] },
      cloud_backup_tasks: { unavailable: null, entries: [] },
      init_shutdown_scripts: { unavailable: null, entries: [] },
    });
  });

  it('asks each method for its rows as they stand, with no filters or options', async () => {
    const { ctx, query } = failingSystem(empty());
    await automatedTasksList.handler(ctx, {});
    expect(query.mock.calls.map(([method]) => method)).toEqual([...ALL_METHODS]);
    for (const call of query.mock.calls) expect(call).toHaveLength(1);
  });

  describe('cron_jobs', () => {
    /**
     * A cron job as `cronjob.query` reports one. `stdout` and `stderr` are here
     * to be dropped: they are fields of the real payload the tool does not name.
     */
    const job = (over: Record<string, unknown> = {}) => ({
      id: 3,
      description: 'nightly report',
      command: '/usr/local/bin/report.sh',
      user: 'root',
      enabled: true,
      schedule: DAILY_AT_TWO,
      stdout: true,
      stderr: false,
      ...over,
    });

    const entries = async (rows: unknown[]): Promise<Record<string, unknown>[]> =>
      (await listed({ ['cronjob.query']: rows })).cron_jobs.entries ?? [];

    it('maps a job to its command, the user it runs as, and its schedule', async () => {
      expect(await entries([job()])).toEqual([
        {
          id: 3,
          description: 'nightly report',
          command: '/usr/local/bin/report.sh',
          user: 'root',
          enabled: true,
          schedule: { minute: '0', hour: '2', dom: '*', month: '*', dow: '*' },
          schedule_description: 'at 02:00, every day',
        },
      ]);
    });

    it('passes a command through unchanged rather than redacting what is in it', async () => {
      const command = 'curl -u admin:hunter2 https://example.invalid/ping';
      expect((await entries([job({ command })]))[0]['command']).toBe(command);
    });

    it('does not report whether the job output is discarded or mailed', async () => {
      const row = (await entries([job()]))[0];
      expect(row).not.toHaveProperty('stdout');
      expect(row).not.toHaveProperty('stderr');
    });

    it('surfaces no field a later release adds', async () => {
      const row = (await entries([job({ future_field: 'added by a later release' })]))[0];
      expect(row).not.toHaveProperty('future_field');
    });

    it('lists a disabled job rather than omitting it', async () => {
      expect((await entries([job({ enabled: false })]))[0]['enabled']).toBe(false);
    });

    it('reports a switch it could not read as null rather than as off', async () => {
      expect((await entries([job({ enabled: 'yes' })]))[0]['enabled']).toBeNull();
    });

    it('reports no readable schedule as a null schedule and a null description', async () => {
      const row = (await entries([job({ schedule: 'nightly' })]))[0];
      expect(row['schedule']).toBeNull();
      expect(row['schedule_description']).toBeNull();
    });

    it('reports a schedule it cannot render in words as fields without a description', async () => {
      const schedule = { ...DAILY_AT_TWO, dom: '1,15', dow: 'mon' };
      const row = (await entries([job({ schedule })]))[0];
      expect(row['schedule']).toEqual(schedule);
      expect(row['schedule_description']).toBeNull();
    });

    it('reports an empty text field as no value rather than as text', async () => {
      expect((await entries([job({ description: '' })]))[0]['description']).toBeNull();
    });

    it('keeps an entry it cannot read as a row of nulls rather than dropping it', async () => {
      expect(await entries([job(), 'not a row'])).toHaveLength(2);
      expect((await entries(['not a row']))[0]).toEqual({
        id: null,
        description: null,
        command: null,
        user: null,
        enabled: null,
        schedule: null,
        schedule_description: null,
      });
    });
  });

  describe('rsync_tasks', () => {
    /** An rsync task as `rsynctask.query` reports one. */
    const task = (over: Record<string, unknown> = {}) => ({
      id: 7,
      desc: 'offsite media',
      path: '/mnt/tank/media',
      user: 'backup',
      direction: 'PUSH',
      mode: 'SSH',
      remotehost: 'backup.example.invalid',
      remoteport: 22,
      remotemodule: null,
      remotepath: '/srv/media',
      ssh_credentials: {
        id: 4,
        name: 'offsite key',
        type: 'SSH_CREDENTIALS',
        attributes: { private_key: 'PRIVATE KEY MATERIAL' },
      },
      enabled: true,
      schedule: DAILY_AT_TWO,
      job: { state: 'SUCCESS', time_finished: { $date: 1756000000000 }, error: null },
      ...over,
    });

    const entries = async (rows: unknown[]): Promise<Record<string, unknown>[]> =>
      (await listed({ ['rsynctask.query']: rows })).rsync_tasks.entries ?? [];

    it('maps a task to both ends, its schedule and its last run', async () => {
      expect(await entries([task()])).toEqual([
        {
          id: 7,
          description: 'offsite media',
          path: '/mnt/tank/media',
          user: 'backup',
          direction: 'PUSH',
          mode: 'SSH',
          remote_host: 'backup.example.invalid',
          remote_port: 22,
          remote_module: null,
          remote_path: '/srv/media',
          ssh_credential_id: 4,
          ssh_credential_name: 'offsite key',
          enabled: true,
          schedule: { minute: '0', hour: '2', dom: '*', month: '*', dow: '*' },
          schedule_description: 'at 02:00, every day',
          state: 'SUCCESS',
          finished_at: '2025-08-24T01:46:40.000Z',
          error: null,
        },
      ]);
    });

    it('reports the SSH credential by id and name and nothing else', async () => {
      const row = (await entries([task()]))[0];
      expect(row['ssh_credential_id']).toBe(4);
      expect(row['ssh_credential_name']).toBe('offsite key');
      expect(JSON.stringify(row)).not.toContain('PRIVATE KEY MATERIAL');
      expect(row).not.toHaveProperty('ssh_credentials');
    });

    it('reads an id-only credential, and reports no credential as nulls', async () => {
      expect((await entries([task({ ssh_credentials: 9 })]))[0]['ssh_credential_id']).toBe(9);
      const none = (await entries([task({ ssh_credentials: null })]))[0];
      expect(none['ssh_credential_id']).toBeNull();
      expect(none['ssh_credential_name']).toBeNull();
    });

    it('reports the fields a task in module mode does not carry as null', async () => {
      const row = (
        await entries([
          task({ mode: 'MODULE', remotemodule: 'media', remotehost: null, remoteport: null }),
        ])
      )[0];
      expect(row['mode']).toBe('MODULE');
      expect(row['remote_module']).toBe('media');
      expect(row['remote_host']).toBeNull();
      expect(row['remote_port']).toBeNull();
    });

    it('reports a task the system has never run as NEVER_RUN, not as a failure', async () => {
      const row = (await entries([task({ job: null })]))[0];
      expect(row['state']).toBe('NEVER_RUN');
      expect(row['finished_at']).toBeNull();
      expect(row['error']).toBeNull();
    });

    it('reports a run record it could not read as a null state, not as NEVER_RUN', async () => {
      expect((await entries([task({ job: 'running' })]))[0]['state']).toBeNull();
    });

    it('withholds the finish time of a run that has not ended', async () => {
      const job = { state: 'RUNNING', time_finished: { $date: 1756000000000 }, error: null };
      const row = (await entries([task({ job })]))[0];
      expect(row['state']).toBe('RUNNING');
      expect(row['finished_at']).toBeNull();
    });

    it('reports a failure with no recorded reason as a null error', async () => {
      const job = { state: 'FAILED', time_finished: { $date: 1756000000000 }, error: '' };
      const row = (await entries([task({ job })]))[0];
      expect(row['state']).toBe('FAILED');
      expect(row['error']).toBeNull();
    });

    it('reports the error text recorded with a failed run', async () => {
      const job = { state: 'FAILED', time_finished: { $date: 1756000000000 }, error: 'no route' };
      expect((await entries([task({ job })]))[0]['error']).toBe('no route');
    });

    it('passes a state a later release adds through as the system spelled it', async () => {
      expect((await entries([task({ job: { state: 'DEFERRED' } })]))[0]['state']).toBe('DEFERRED');
    });

    it('surfaces no field a later release adds', async () => {
      const row = (await entries([task({ future_field: 'added later' })]))[0];
      expect(row).not.toHaveProperty('future_field');
    });

    it('keeps an entry it cannot read as a row of nulls rather than dropping it', async () => {
      const row = (await entries([null]))[0];
      expect(row['id']).toBeNull();
      expect(row['state']).toBeNull();
      expect(row['schedule']).toBeNull();
    });
  });

  describe('cloud_backup_tasks', () => {
    /** A cloud backup task as `cloud_backup.query` reports one. */
    const task = (over: Record<string, unknown> = {}) => ({
      id: 11,
      description: 'weekly offsite',
      path: '/mnt/tank/docs',
      attributes: { bucket: 'nas-backups', folder: '/docs', fast_list: false },
      credentials: { id: 2, name: 'b2 account', provider: { type: 'B2', key: 'SECRET KEY' } },
      keep_last: 12,
      enabled: true,
      schedule: DAILY_AT_TWO,
      password: 'REPOSITORY PASSPHRASE',
      pre_script: 'echo before',
      post_script: 'echo after',
      job: { state: 'SUCCESS', time_finished: { $date: 1756000000000 }, error: null },
      ...over,
    });

    const entries = async (rows: unknown[]): Promise<Record<string, unknown>[]> =>
      (await listed({ ['cloud_backup.query']: rows })).cloud_backup_tasks.entries ?? [];

    it('maps a task to both ends, its retention, its schedule and its last run', async () => {
      expect(await entries([task()])).toEqual([
        {
          id: 11,
          description: 'weekly offsite',
          path: '/mnt/tank/docs',
          bucket: 'nas-backups',
          folder: '/docs',
          credential_id: 2,
          credential_name: 'b2 account',
          keep_last: 12,
          enabled: true,
          schedule: { minute: '0', hour: '2', dom: '*', month: '*', dow: '*' },
          schedule_description: 'at 02:00, every day',
          state: 'SUCCESS',
          finished_at: '2025-08-24T01:46:40.000Z',
          error: null,
        },
      ]);
    });

    it('returns neither the repository passphrase nor the credential provider', async () => {
      const serialized = JSON.stringify((await entries([task()]))[0]);
      expect(serialized).not.toContain('REPOSITORY PASSPHRASE');
      expect(serialized).not.toContain('SECRET KEY');
    });

    it('returns neither the pre-run nor the post-run script', async () => {
      const row = (await entries([task()]))[0];
      expect(row).not.toHaveProperty('pre_script');
      expect(row).not.toHaveProperty('post_script');
    });

    it('reports no bucket on a provider that has none', async () => {
      const row = (await entries([task({ attributes: { folder: '/docs' } })]))[0];
      expect(row['bucket']).toBeNull();
      expect(row['folder']).toBe('/docs');
    });

    it('surfaces no field a later release adds to the open attributes record', async () => {
      const attributes = { bucket: 'nas-backups', folder: '/docs', added_later: 'x' };
      const row = (await entries([task({ attributes })]))[0];
      expect(row).not.toHaveProperty('added_later');
    });

    it('reports a task the system has never run as NEVER_RUN', async () => {
      expect((await entries([task({ job: null })]))[0]['state']).toBe('NEVER_RUN');
    });

    it('keeps an entry it cannot read as a row of nulls rather than dropping it', async () => {
      const row = (await entries([42]))[0];
      expect(row['id']).toBeNull();
      expect(row['credential_id']).toBeNull();
      expect(row['keep_last']).toBeNull();
    });
  });

  describe('init_shutdown_scripts', () => {
    /** An init/shutdown script as `initshutdownscript.query` reports one. */
    const script = (over: Record<string, unknown> = {}) => ({
      id: 2,
      comment: 'warm the cache',
      type: 'COMMAND',
      command: 'systemctl restart cache',
      script: null,
      when: 'POSTINIT',
      enabled: true,
      timeout: 30,
      ...over,
    });

    const entries = async (rows: unknown[]): Promise<Record<string, unknown>[]> =>
      (await listed({ ['initshutdownscript.query']: rows })).init_shutdown_scripts.entries ?? [];

    it('maps a script to the point in the lifecycle it runs at', async () => {
      expect(await entries([script()])).toEqual([
        {
          id: 2,
          comment: 'warm the cache',
          type: 'COMMAND',
          command: 'systemctl restart cache',
          script: null,
          when: 'POSTINIT',
          enabled: true,
          timeout_seconds: 30,
        },
      ]);
    });

    it('reports no schedule field at all, rather than one that is null', async () => {
      const row = (await entries([script()]))[0];
      expect(row).not.toHaveProperty('schedule');
      expect(row).not.toHaveProperty('schedule_description');
    });

    it('reports no run record, since the middleware does not run these as jobs', async () => {
      const row = (await entries([script()]))[0];
      expect(row).not.toHaveProperty('state');
      expect(row).not.toHaveProperty('finished_at');
      expect(row).not.toHaveProperty('error');
    });

    it('reports the path of a script entry and no command', async () => {
      const row = (
        await entries([script({ type: 'SCRIPT', command: null, script: '/mnt/tank/boot.sh' })])
      )[0];
      expect(row['type']).toBe('SCRIPT');
      expect(row['script']).toBe('/mnt/tank/boot.sh');
      expect(row['command']).toBeNull();
    });

    it('keeps an entry it cannot read as a row of nulls rather than dropping it', async () => {
      expect((await entries([['not', 'a', 'row']]))[0]).toEqual({
        id: null,
        comment: null,
        type: null,
        command: null,
        script: null,
        when: null,
        enabled: null,
        timeout_seconds: null,
      });
    });
  });

  describe('a section that could not be read', () => {
    it('names the reason and nulls that section alone', async () => {
      const result = await listed({}, { ['cronjob.query']: new Error('permission denied') });
      expect(result.cron_jobs).toEqual({ unavailable: 'permission denied', entries: null });
      expect(result.rsync_tasks).toEqual({ unavailable: null, entries: [] });
      expect(result.cloud_backup_tasks).toEqual({ unavailable: null, entries: [] });
      expect(result.init_shutdown_scripts).toEqual({ unavailable: null, entries: [] });
    });

    it('reads a middleware rejection carrying a reason', async () => {
      const result = await listed({}, { ['rsynctask.query']: { reason: 'method not found' } });
      expect(result.rsync_tasks.unavailable).toBe('method not found');
    });

    it('states an absence where the failure carried no text', async () => {
      const result = await listed({}, { ['cloud_backup.query']: {} });
      expect(result.cloud_backup_tasks.unavailable).toBe('the system reported no reason');
    });

    it('leaves the other three answering when every read but one fails', async () => {
      const result = await listed(
        {},
        {
          ['cronjob.query']: new Error('a'),
          ['rsynctask.query']: new Error('b'),
          ['cloud_backup.query']: new Error('c'),
        },
      );
      expect(result.cron_jobs.entries).toBeNull();
      expect(result.rsync_tasks.entries).toBeNull();
      expect(result.cloud_backup_tasks.entries).toBeNull();
      expect(result.init_shutdown_scripts).toEqual({ unavailable: null, entries: [] });
    });

    it('reports every section as unread when every read fails', async () => {
      const failures = Object.fromEntries(
        ALL_METHODS.map((method) => [method, new Error('unreachable')]),
      );
      const result = await listed({}, failures);
      for (const section of Object.values(result)) {
        expect(section).toEqual({ unavailable: 'unreachable', entries: null });
      }
    });

    it('reports an answer that is not a list as unread rather than as no tasks', async () => {
      const result = await listed({ ['initshutdownscript.query']: 3 });
      expect(result.init_shutdown_scripts).toEqual({
        unavailable: 'the system did not answer with a list of init/shutdown scripts',
        entries: null,
      });
    });

    it('names the task type it could not list, per section', async () => {
      const result = await listed({
        ['cronjob.query']: null,
        ['rsynctask.query']: { id: 1 },
        ['cloud_backup.query']: 'none',
      });
      expect(result.cron_jobs.unavailable).toBe('the system did not answer with a list of cron jobs');
      expect(result.rsync_tasks.unavailable).toBe(
        'the system did not answer with a list of rsync tasks',
      );
      expect(result.cloud_backup_tasks.unavailable).toBe(
        'the system did not answer with a list of cloud backup tasks',
      );
    });
  });
});
