import { describe, expect, it, vi } from 'vitest';
import { concat, NEVER, Observable, of, throwError } from 'rxjs';
import { Role } from '@/interfaces';
import type { SystemHandle, ToolContext } from '@/catalog/tool';
import { systemUpdateApply } from '@/tools/index';

/**
 * `system_update_apply`'s tests have their own spec, as the ticket placed them
 * (#200): `system.ts` holds the read-only system tools, and this is its only
 * mutation. The fake system is local because the install is a job, so the
 * correlation and the tracking move independently, as in
 * `vm-disk-image-import.spec.ts`.
 */
describe('system_update_apply', () => {
  type Answer = { value: unknown } | { fails: unknown };

  const emit = (answer: Answer) => ('fails' in answer ? throwError(() => answer.fails) : of(answer.value));

  const available = {
    code: 'NORMAL',
    status: {
      current_version: { train: 'TrueNAS-SCALE-Goldeye', profile: 'GENERAL', matches_profile: true },
      new_version: { version: '25.10.1', manifest: {}, release_notes: null, release_notes_url: '' },
    },
    error: null,
    update_download_progress: null,
  };

  /** A job as the client's tracking emits one. */
  const jobAt = (state: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: 77,
    method: 'update.run',
    state,
    result: state === 'SUCCESS' ? true : null,
    error: null,
    time_finished: { $date: 1_756_000_000_000 },
    ...extra,
  });

  /** The two boot environments an install that marked its own leaves behind. */
  const installed = [
    { id: '25.10.0', active: true, activated: false },
    { id: '25.10.1', active: false, activated: true },
  ];

  interface Options {
    licensed?: Answer;
    status?: Answer;
    version?: Answer;
    environments?: Answer;
    started?: Observable<number>;
    job?: Observable<unknown>;
  }

  function updateSystem(options: Options = {}): {
    ctx: ToolContext;
    call: ReturnType<typeof vi.fn>;
    start: ReturnType<typeof vi.fn>;
  } {
    const query = vi.fn((method: string) => {
      if (method === 'boot.environment.query') return emit(options.environments ?? { value: installed });
      throw new Error(`unexpected read ${method}`);
    });
    const call = vi.fn((method: string) => {
      switch (method) {
        case 'failover.licensed':
          return emit(options.licensed ?? { value: false });
        case 'update.status':
          return emit(options.status ?? { value: available });
        case 'system.version':
          return emit(options.version ?? { value: 'TrueNAS-25.10.0' });
        default:
          throw new Error(`unexpected call ${method}`);
      }
    });
    const start = vi.fn(() => options.started ?? of(77));
    const track = vi.fn(() => options.job ?? of(jobAt('SUCCESS')));
    const system = {
      name: 'nas',
      client: { api: { query, call, callAndGetJobId: start, trackJob: track } },
    } as unknown as SystemHandle;
    return { ctx: { system }, call, start };
  }

  const plan = (options: Options = {}, args: Record<string, unknown> = {}) =>
    systemUpdateApply.plan(updateSystem(options).ctx, args);

  const run = async (options: Options = {}) =>
    (await systemUpdateApply.execute(updateSystem(options).ctx, {})) as Record<string, unknown>;

  it('is a reversible mutating tool needing the full role, whose description says nothing here undoes it', () => {
    expect(systemUpdateApply).toMatchObject({
      name: 'system_update_apply',
      mutating: true,
      destructiveness: 'reversible',
      requiredRole: Role.Full,
    });
    expect(systemUpdateApply.description).toContain('NO TOOL HERE ACTIVATES A BOOT ENVIRONMENT');
    expect(systemUpdateApply.resultGuidance).toBeDefined();
  });

  it('says pool feature flags are not changed and points at storage_pool_status', () => {
    expect(systemUpdateApply.description).toContain('does NOT upgrade pool ZFS feature flags');
    expect(systemUpdateApply.description).toContain('`storage_pool_status` reports as `feature_flags_current`');
  });

  it('takes no arguments, and refuses each one update.run would take', () => {
    const schema = systemUpdateApply.inputSchema as { properties: Record<string, unknown> };
    expect(Object.keys(schema.properties)).toEqual([]);
    for (const key of ['reboot', 'train', 'version', 'dataset_name', 'resume']) {
      expect(() => systemUpdateApply.normalizeArgs?.({ [key]: false })).toThrow(`"${key}" is not accepted`);
    }
    expect(systemUpdateApply.normalizeArgs?.({})).toEqual({});
  });

  describe('plan', () => {
    it('names the install with reboot false, then the read after the watch', async () => {
      const steps = await plan();
      expect(steps.map((step) => step.method)).toEqual(['update.run', 'boot.environment.query']);
      expect(steps[0]?.params).toEqual([{ reboot: false }]);
      expect(steps[1]?.description).toContain('WHEN THE WATCH ENDS');
    });

    it('states the current version, the target, the train, and that it will not reboot', async () => {
      const [install] = await plan();
      expect(install?.description).toContain('update 25.10.1 on the train "TrueNAS-SCALE-Goldeye"');
      expect(install?.description).toContain('the system is running version TrueNAS-25.10.0');
      expect(install?.description).toContain('THE SYSTEM WILL NOT REBOOT');
      expect(install?.description).toContain('pool ZFS feature flags are not upgraded');
      expect(install?.description).toContain('for at most 30 seconds');
    });

    it('says so where the current version or the train could not be read, and still plans', async () => {
      const status = {
        value: { ...available, status: { ...available.status, current_version: null } },
      };
      const [install] = await plan({ version: { fails: new Error('down') }, status });
      expect(install?.description).toContain('a version that could not be read (down)');
      expect(install?.description).toContain('on a train the system reported no name for');
    });

    it('fails naming ha_status on an HA system, and where the licence could not be read', async () => {
      await expect(plan({ licensed: { value: true } })).rejects.toThrow('licensed for HA');
      await expect(plan({ licensed: { value: true } })).rejects.toThrow('`ha_status`');
      await expect(plan({ licensed: { fails: new Error('down') } })).rejects.toThrow(
        'Whether this system is an HA pair could not be read (failover.licensed failed: down)',
      );
      await expect(plan({ licensed: { value: null } })).rejects.toThrow('did not answer true or false');
    });

    it('fails saying no update is available', async () => {
      const status = { value: { ...available, status: { ...available.status, new_version: null } } };
      await expect(plan({ status })).rejects.toThrow(
        'No update is available on the train "TrueNAS-SCALE-Goldeye": the system reports it is up to date',
      );
    });

    it('fails saying availability could not be established, which is not "no update"', async () => {
      const status = {
        value: { code: 'ERROR', status: null, error: { errname: 'ENONET', reason: 'unreachable' } },
      };
      await expect(plan({ status })).rejects.toThrow(
        'Whether an update is available could not be established (unreachable). That is not "no update"',
      );
      await expect(plan({ status: { fails: new Error('down') } })).rejects.toThrow(
        'Whether an update is available could not be read (update.status failed: down)',
      );
    });

    it('fails where the update names no version it could read', async () => {
      const status = {
        value: { ...available, status: { ...available.status, new_version: { version: '' } } },
      };
      await expect(plan({ status })).rejects.toThrow('names no version this tool could read');
    });

    it('refuses an argument before reading anything', async () => {
      const { ctx, call } = updateSystem();
      await expect(systemUpdateApply.plan(ctx, { reboot: true })).rejects.toThrow('"reboot" is not accepted');
      expect(call).not.toHaveBeenCalled();
    });
  });

  describe('execute', () => {
    it('sends reboot false, reports the job, and reads the boot environments back', async () => {
      const { ctx, start } = updateSystem();
      const result = (await systemUpdateApply.execute(ctx, {})) as Record<string, unknown>;
      expect(start).toHaveBeenCalledWith('update.run', [{ reboot: false }]);
      expect(result).toEqual({
        watched_seconds: 30,
        job_id: 77,
        ended: true,
        succeeded: true,
        job_state: 'SUCCESS',
        error: null,
        finished_at: new Date(1_756_000_000_000).toISOString(),
        environments_read_error: null,
        running_environment: '25.10.0',
        active_on_reboot: '25.10.1',
        next_boot_changes_environment: true,
      });
    });

    it('reports a next boot that does not change environment as false, and two marked as unknown', async () => {
      const unchanged = [
        { id: '25.10.0', active: true, activated: true },
        { id: '25.10.1', active: false, activated: false },
      ];
      expect(await run({ environments: { value: unchanged } })).toMatchObject({
        active_on_reboot: '25.10.0',
        next_boot_changes_environment: false,
      });
      const twoMarked = [{ id: '25.10.0', active: true, activated: true }, installed[1]];
      expect(await run({ environments: { value: twoMarked } })).toMatchObject({
        active_on_reboot: null,
        next_boot_changes_environment: null,
      });
    });

    it('does not name an environment where one could not be read, and reports a failed read as data', async () => {
      expect(await run({ environments: { value: [installed[0], { id: '25.10.1', active: false }] } })).toMatchObject({
        running_environment: '25.10.0',
        active_on_reboot: null,
        next_boot_changes_environment: null,
      });
      expect(await run({ environments: { fails: new Error('down') } })).toMatchObject({
        environments_read_error: 'down',
        running_environment: null,
        active_on_reboot: null,
        next_boot_changes_environment: null,
        ended: true,
      });
    });

    it('reports a job that failed as data', async () => {
      expect(await run({ job: of(jobAt('FAILED', { error: 'No update available' })) })).toMatchObject({
        ended: true,
        succeeded: false,
        error: 'No update available',
      });
    });

    it('fails where the call is refused before any job names it', async () => {
      const { ctx } = updateSystem({ started: throwError(() => new Error('[EPERM] not allowed')) });
      await expect(systemUpdateApply.execute(ctx, {})).rejects.toThrow('[EPERM] not allowed');
    });

    it('refuses an argument rather than sending it', async () => {
      const { ctx, start } = updateSystem();
      await expect(systemUpdateApply.execute(ctx, { reboot: true })).rejects.toThrow('"reboot" is not accepted');
      expect(start).not.toHaveBeenCalled();
    });

    it('reports an install still going when the watch runs out', async () => {
      vi.useFakeTimers();
      try {
        const { ctx } = updateSystem({ job: concat(of(jobAt('RUNNING')), NEVER) });
        const pending = systemUpdateApply.execute(ctx, {});
        await vi.advanceTimersByTimeAsync(30_000);
        expect(await pending).toMatchObject({
          job_id: 77,
          ended: false,
          succeeded: null,
          job_state: 'RUNNING',
          finished_at: null,
        });
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
