import { describe, expect, it, vi } from 'vitest';
import { concat, NEVER, Observable, of, throwError } from 'rxjs';
import { Role } from '@/interfaces';
import type { SystemHandle, ToolContext } from '@/catalog/tool';
import { systemReboot } from '@/tools/index';

/**
 * `system_reboot`'s tests have their own spec, as the ticket placed them (#201),
 * beside `system-update-apply.spec.ts`. The fake system is local for the reason
 * that one gives: the reboot is a job, so the correlation and the tracking move
 * independently. The plan composes four listings, so `query` answers each of
 * their methods.
 */
describe('system_reboot', () => {
  type Answer = { value: unknown } | { fails: unknown };

  const emit = (answer: Answer) => ('fails' in answer ? throwError(() => answer.fails) : of(answer.value));

  /** A job as the client's tracking emits one. */
  const jobAt = (state: string): Record<string, unknown> => ({
    id: 91,
    method: 'system.reboot',
    state,
    result: null,
    error: null,
    time_finished: { $date: 1_756_000_000_000 },
  });

  interface Options {
    licensed?: Answer;
    bootId?: Answer;
    vms?: Answer;
    instances?: Answer;
    apps?: Answer;
    nfs3?: Answer;
    nfs4?: Answer;
    jobs?: Answer;
    started?: Observable<number>;
    job?: Observable<unknown>;
  }

  function rebootSystem(options: Options = {}): {
    ctx: ToolContext;
    call: ReturnType<typeof vi.fn>;
    start: ReturnType<typeof vi.fn>;
  } {
    const query = vi.fn((method: string) => {
      switch (method) {
        case 'vm.query':
          return emit(options.vms ?? { value: [{ id: 1, name: 'web', status: { state: 'RUNNING' } }] });
        case 'virt.instance.query':
          return emit(options.instances ?? { value: [] });
        case 'app.query':
          return emit(
            options.apps ?? {
              value: [
                { name: 'plex', state: 'RUNNING' },
                { name: 'old', state: 'STOPPED' },
                { name: 'broken', state: 'CRASHED' },
              ],
            },
          );
        case 'nfs.get_nfs3_clients':
          return emit(options.nfs3 ?? { value: [{ ip: '10.0.0.5', export: '/mnt/tank' }] });
        case 'nfs.get_nfs4_clients':
          return emit(options.nfs4 ?? { value: [] });
        case 'core.get_jobs':
          return emit(
            options.jobs ?? {
              value: [
                { id: 12, method: 'pool.scrub.run', state: 'RUNNING', time_started: { $date: 0 } },
                { id: 13, method: 'cloudsync.sync', state: 'SUCCESS', time_started: { $date: 0 } },
              ],
            },
          );
        default:
          throw new Error(`unexpected read ${method}`);
      }
    });
    const call = vi.fn((method: string) => {
      switch (method) {
        case 'failover.licensed':
          return emit(options.licensed ?? { value: false });
        case 'system.boot_id':
          return emit(options.bootId ?? { value: 'boot-a' });
        default:
          throw new Error(`unexpected call ${method}`);
      }
    });
    const start = vi.fn(() => options.started ?? of(91));
    const track = vi.fn(() => options.job ?? of(jobAt('SUCCESS')));
    const system = {
      name: 'nas',
      client: { api: { query, call, callAndGetJobId: start, trackJob: track } },
    } as unknown as SystemHandle;
    return { ctx: { system }, call, start };
  }

  const reason = { reason: 'kernel update' };

  const rebootStep = async (options: Options = {}) => {
    const steps = await systemReboot.plan(rebootSystem(options).ctx, reason);
    return steps[1]?.description ?? '';
  };

  const run = async (options: Options = {}) =>
    (await systemReboot.execute(rebootSystem(options).ctx, reason)) as Record<string, unknown>;

  it('is a reversible mutating tool needing the full role', () => {
    expect(systemReboot).toMatchObject({
      name: 'system_reboot',
      mutating: true,
      destructiveness: 'reversible',
      requiredRole: Role.Full,
    });
    expect(systemReboot.resultGuidance).toBeDefined();
  });

  it('says selecting several systems reboots them together under one confirmation', () => {
    expect(systemReboot.description).toContain(
      'SELECTING SEVERAL SYSTEMS REBOOTS THEM TOGETHER, AT ONCE, UNDER ONE CONFIRMATION',
    );
  });

  it('says `ended` false is the ordinary answer and names the tool that confirms the reboot', () => {
    expect(systemReboot.resultGuidance).toContain('FALSE IS THE ORDINARY ANSWER AND IS NOT A FAILED REBOOT');
    expect(systemReboot.resultGuidance).toContain('call `system_reboot_info` once the system is back');
    expect(systemReboot.resultGuidance).toContain('THAT HOLDS ONLY WHERE THE SAME NODE ANSWERS BOTH READS');
  });

  it('says in the description and the plan which sessions it does not read', async () => {
    const unread = 'SMB sessions, iSCSI initiators, NVMe-oF hosts and Fibre Channel clients are NOT READ';
    expect(systemReboot.description).toContain(unread);
    expect(await rebootStep()).toContain(`THIS IS NOT EVERYTHING THE REBOOT INTERRUPTS: ${unread}`);
  });

  describe('arguments', () => {
    it('requires a non-empty reason, and passes it through unmodified', () => {
      const schema = systemReboot.inputSchema as { properties: Record<string, unknown>; required: string[] };
      expect(Object.keys(schema.properties)).toEqual(['reason']);
      expect(schema.required).toEqual(['reason']);
      for (const bad of [{}, { reason: '' }, { reason: '   ' }, { reason: 3 }]) {
        expect(() => systemReboot.normalizeArgs?.(bad)).toThrow('"reason" is required');
      }
      expect(systemReboot.normalizeArgs?.({ reason: '  patch  ', extra: 1 })).toEqual({ reason: '  patch  ' });
    });

    it('refuses a delay', () => {
      expect(() => systemReboot.normalizeArgs?.({ reason: 'x', delay: 60 })).toThrow('"delay" is not accepted');
    });

    it('refuses before reading anything, in plan and in execute', async () => {
      const { ctx, call, start } = rebootSystem();
      await expect(systemReboot.plan(ctx, {})).rejects.toThrow('"reason" is required');
      await expect(systemReboot.execute(ctx, { reason: 'x', delay: 1 })).rejects.toThrow('"delay"');
      expect(call).not.toHaveBeenCalled();
      expect(start).not.toHaveBeenCalled();
    });
  });

  describe('plan', () => {
    it('names the boot id read and then the reboot, with the reason unmodified', async () => {
      const steps = await systemReboot.plan(rebootSystem().ctx, { reason: '  kernel update ' });
      expect(steps.map((step) => step.method)).toEqual(['system.boot_id', 'system.reboot']);
      expect(steps[0]?.params).toEqual([]);
      expect(steps[0]?.description).toContain('IMMEDIATELY BEFORE THE REBOOT CALL');
      expect(steps[1]?.params).toEqual(['  kernel update ']);
    });

    it('lists running VMs, running apps, NFS clients and running jobs', async () => {
      const description = await rebootStep();
      expect(description).toContain('1 virtual machine not reported STOPPED will be interrupted: web (RUNNING)');
      expect(description).toContain('1 application not reported STOPPED or CRASHED will be interrupted: plex (RUNNING)');
      expect(description).not.toContain('old (');
      expect(description).not.toContain('broken (');
      expect(description).toContain('NFS: 1 NFSv3 mount; 0 registered NFSv4 clients');
      expect(description).toContain('1 job not reported as ended will be interrupted: pool.scrub.run (job 12, RUNNING)');
      expect(description).not.toContain('cloudsync.sync');
      expect(description).toContain('The boot id when this plan was made was boot-a.');
      expect(description).toContain('for at most 30 seconds');
    });

    it('names a running job started long before the listing’s default day', async () => {
      const longAgo = Date.now() - 3 * 24 * 60 * 60 * 1000;
      const description = await rebootStep({
        jobs: { value: [{ id: 40, method: 'replication.run', state: 'RUNNING', time_started: { $date: longAgo } }] },
      });
      expect(description).toContain('replication.run (job 40, RUNNING)');
    });

    it('keeps an entry whose state could not be read, and counts past the named ones', async () => {
      const many = Array.from({ length: 12 }, (_, n) => ({ name: `app${n}`, state: 'RUNNING' }));
      const description = await rebootStep({
        apps: { value: [...many, { name: 'mystery' }] },
        jobs: { value: [{ id: 5, method: 'x.run' }] },
        vms: { value: [{ id: 2, status: { state: 'SUSPENDED' } }] },
      });
      expect(description).toContain('13 applications not reported STOPPED or CRASHED');
      expect(description).toContain('app9 (RUNNING) and 3 more');
      expect(description).toContain('one the system reported no name for (SUSPENDED)');
      expect(description).toContain('x.run (job 5, state not read)');
    });

    it('says nothing was found where every read succeeded and found nothing', async () => {
      const description = await rebootStep({
        vms: { value: [] },
        apps: { value: [] },
        nfs3: { value: [] },
        jobs: { value: [] },
      });
      expect(description).toContain('No virtual machine was read in a state other than STOPPED.');
      expect(description).toContain('No application was read in a state other than STOPPED or CRASHED.');
      expect(description).toContain('No job was read in a state other than SUCCESS');
    });

    it('names each read that failed as not established, and still plans', async () => {
      const down = { fails: new Error('down') };
      const description = await rebootStep({ apps: down, jobs: down, nfs3: down, nfs4: down, bootId: down });
      expect(description).toContain('Applications were NOT READ (apps_list failed: down)');
      expect(description).toContain('Running jobs were NOT READ (tasks_recent_runs failed: down)');
      expect(description).toContain('NFSv3 mounts were NOT READ (down), so none is not established');
      expect(description).toContain('NFSv4 clients were NOT READ (down)');
      expect(description).toContain('The boot id could not be read when this plan was made (down).');
      expect(description).not.toContain('No application');
    });

    it('says so where the boot id came back empty, and where a job names no method or id', async () => {
      const description = await rebootStep({ bootId: { value: '' }, jobs: { value: [{ state: 'RUNNING' }] } });
      expect(description).toContain(
        'The boot id could not be read when this plan was made (the system reported no boot id this tool could read).',
      );
      expect(description).toContain('a job naming no method (no id, RUNNING)');
    });

    it('says a VM list is incomplete where one stack could not be read', async () => {
      const description = await rebootStep({ instances: { fails: new Error('no incus') } });
      expect(description).toContain('THAT LIST IS INCOMPLETE: the virt_instance stack could not be read (no incus)');
    });

    it('says the connected node reboots on an HA system, and where that could not be read', async () => {
      expect(await rebootStep({ licensed: { value: true } })).toContain(
        'THIS SYSTEM IS LICENSED FOR HA: this reboots the node the catalog is connected to',
      );
      expect(await rebootStep({ licensed: { value: true } })).toContain('`ha_status`');
      expect(await rebootStep({ licensed: { fails: new Error('down') } })).toContain(
        'Whether this system is an HA pair could not be read (failover.licensed failed: down)',
      );
      expect(await rebootStep({ licensed: { value: null } })).toContain('it did not answer true or false');
      expect(await rebootStep()).not.toContain('ha_status');
    });
  });

  describe('execute', () => {
    it('reads the boot id, sends the reason unmodified, and reports the job', async () => {
      const { ctx, start, call } = rebootSystem();
      const result = await systemReboot.execute(ctx, { reason: ' kernel update' });
      expect(call).toHaveBeenCalledWith('system.boot_id');
      expect(start).toHaveBeenCalledWith('system.reboot', [' kernel update']);
      expect(result).toEqual({
        watched_seconds: 30,
        job_id: 91,
        ended: true,
        succeeded: true,
        job_state: 'SUCCESS',
        error: null,
        finished_at: new Date(1_756_000_000_000).toISOString(),
        boot_id_before: 'boot-a',
        boot_id_read_error: null,
      });
    });

    it('yields ended false with the job id and boot id where tracking errors after correlation', async () => {
      const dropped = concat(of(jobAt('RUNNING')), throwError(() => new Error('connection closed')));
      expect(await run({ job: dropped })).toMatchObject({
        job_id: 91,
        ended: false,
        succeeded: null,
        boot_id_before: 'boot-a',
      });
    });

    it('reports a boot id it could not read as data, and still reboots', async () => {
      const { ctx, start } = rebootSystem({ bootId: { fails: new Error('down') } });
      expect(await systemReboot.execute(ctx, reason)).toMatchObject({
        boot_id_before: null,
        boot_id_read_error: 'down',
        ended: true,
      });
      expect(start).toHaveBeenCalled();
      expect(await run({ bootId: { value: '' } })).toMatchObject({
        boot_id_before: null,
        boot_id_read_error: 'the system reported no boot id this tool could read',
      });
    });

    it('fails where the call is refused before any job names it', async () => {
      await expect(run({ started: throwError(() => new Error('[EPERM] not allowed')) })).rejects.toThrow(
        '[EPERM] not allowed',
      );
    });

    it('reports a reboot still going when the watch runs out', async () => {
      vi.useFakeTimers();
      try {
        const { ctx } = rebootSystem({ job: concat(of(jobAt('RUNNING')), NEVER) });
        const pending = systemReboot.execute(ctx, reason);
        await vi.advanceTimersByTimeAsync(30_000);
        expect(await pending).toMatchObject({ job_id: 91, ended: false, job_state: 'RUNNING', finished_at: null });
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
