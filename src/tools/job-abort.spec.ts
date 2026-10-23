import { describe, expect, it, vi } from 'vitest';
import { concat, NEVER, Observable, of, throwError } from 'rxjs';
import { Role } from '@/interfaces';
import type { SystemHandle, ToolContext } from '@/catalog/tool';
import { cloudsyncRun, jobAbort, snapshotTaskRun } from '@/tools/index';

/**
 * `job_abort`'s tests have their own spec, as the ticket placed them (#202):
 * `tasks.spec.ts` is over the #87 trigger with any block this size. The fake
 * system is local for the reason `snapshot-task-run.spec.ts` gives — after the
 * abort the job is followed through `trackJob`, which is a stream rather than a
 * response.
 */
describe('job_abort', () => {
  type Answer = { value: unknown } | { fails: unknown };

  const emit = (answer: Answer) => ('fails' in answer ? throwError(() => answer.fails) : of(answer.value));

  /** A running cloud sync as `core.get_jobs` lists it. */
  const running = (fields: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: 42,
    method: 'cloudsync.sync',
    state: 'RUNNING',
    abortable: true,
    description: 'Cloud sync: offsite',
    progress: { percent: 37, description: 'copying', extra: null },
    time_started: { $date: 1_756_000_000_000 },
    ...fields,
  });

  /** The job as the client's tracking emits it after the call. */
  const jobAt = (state: string): Record<string, unknown> => ({
    id: 42,
    method: 'cloudsync.sync',
    state,
    error: null,
    time_finished: { $date: 1_756_000_100_000 },
  });

  interface Options {
    jobs?: Answer;
    abort?: Answer;
    job?: Observable<unknown>;
  }

  function abortSystem(options: Options = {}): {
    ctx: ToolContext;
    query: ReturnType<typeof vi.fn>;
    call: ReturnType<typeof vi.fn>;
    track: ReturnType<typeof vi.fn>;
  } {
    const query = vi.fn((method: string) => {
      if (method !== 'core.get_jobs') throw new Error(`unexpected read ${method}`);
      return emit(options.jobs ?? { value: [running()] });
    });
    const call = vi.fn((method: string) => {
      if (method !== 'core.job_abort') throw new Error(`unexpected call ${method}`);
      return emit(options.abort ?? { value: null });
    });
    const track = vi.fn(() => options.job ?? of(jobAt('RUNNING'), jobAt('ABORTED')));
    const system = {
      name: 'nas',
      client: { api: { query, call, trackJob: track } },
    } as unknown as SystemHandle;
    return { ctx: { system }, query, call, track };
  }

  const plan = (options: Options = {}, args: Record<string, unknown> = { id: 42 }) =>
    jobAbort.plan(abortSystem(options).ctx, args);

  const run = async (options: Options = {}) =>
    (await jobAbort.execute(abortSystem(options).ctx, { id: 42 })) as Record<string, unknown>;

  it('is a reversible mutating tool needing the full role', () => {
    expect(jobAbort).toMatchObject({
      name: 'job_abort',
      mutating: true,
      destructiveness: 'reversible',
      requiredRole: Role.Full,
    });
    expect(jobAbort.resultGuidance).toBeDefined();
    expect(jobAbort.description).toContain(jobAbort.resultGuidance ?? '');
  });

  it('names every allowlisted method in the description, with what an aborted run leaves behind', () => {
    for (const method of [
      'cloudsync.sync',
      'cloud_backup.sync',
      'replication.run',
      'rsynctask.run',
      'pool.snapshottask.run',
      'vm.device.convert',
    ]) {
      expect(jobAbort.description).toContain(`\`${method}\`: `);
    }
    expect(jobAbort.description).toContain('(unconfirmed)');
    expect(jobAbort.description).toContain('WHAT THE RUN ALREADY DID IS NOT UNDONE');
  });

  it('is pointed at by cloudsync_run and snapshot_task_run as how to stop a run', () => {
    for (const tool of [cloudsyncRun, snapshotTaskRun]) {
      expect(tool.description).toContain('`job_abort`, given this result\'s `job_id`, is how a run is stopped');
    }
  });

  describe('arguments', () => {
    it('takes `id` alone, as a whole number', () => {
      const schema = jobAbort.inputSchema as { properties: Record<string, unknown>; required: string[] };
      expect(Object.keys(schema.properties)).toEqual(['id']);
      expect(schema.required).toEqual(['id']);
      for (const bad of [{}, { id: '42' }, { id: 4.5 }]) {
        expect(() => jobAbort.normalizeArgs?.(bad)).toThrow('"id" is required and must be a whole number');
      }
      expect(jobAbort.normalizeArgs?.({ id: 42, extra: 1 })).toEqual({ id: 42 });
    });

    it('refuses before reading anything, in plan and in execute', async () => {
      const { ctx, query, call } = abortSystem();
      await expect(jobAbort.plan(ctx, {})).rejects.toThrow('"id" is required');
      await expect(jobAbort.execute(ctx, { id: 'x' })).rejects.toThrow('"id" is required');
      expect(query).not.toHaveBeenCalled();
      expect(call).not.toHaveBeenCalled();
    });
  });

  describe('plan', () => {
    it('reads the job by id, naming only the fields it reports, with the params its step names', async () => {
      const { ctx, query } = abortSystem();
      const steps = await jobAbort.plan(ctx, { id: 42 });
      expect(query).toHaveBeenCalledWith('core.get_jobs', [['id', '=', 42]], {
        select: ['id', 'method', 'state', 'abortable', 'description', 'progress', 'time_started'],
      });
      // The step's params are written apart from the read; this is what holds them together.
      expect(query).toHaveBeenCalledWith('core.get_jobs', ...(steps[0]?.params as unknown[]));
    });

    it('names the re-check read, the abort call, and the read that follows the job after it', async () => {
      const steps = await plan();
      expect(steps.map((step) => step.method)).toEqual(['core.get_jobs', 'core.job_abort', 'core.get_jobs']);
      expect(steps[0]?.description).toContain('REFUSE, SENDING NOTHING');
      expect(steps[0]?.description).toContain('the confirmation binds the id, not the job');
      expect(steps[1]?.params).toEqual([42]);
      expect(steps[2]?.params).toEqual([[['id', '=', 42]]]);
      expect(steps[2]?.description).toContain('after the abort call');
      expect(steps[2]?.description).toContain('for at most 30 seconds');
      for (const read of [steps[0], steps[2]]) expect(read?.description).toContain('Changes nothing.');
    });

    it("names the job's method, description, progress and start time, and what an abort leaves", async () => {
      const description = (await plan())[1]?.description ?? '';
      expect(description).toContain(
        'Abort job 42, a `cloudsync.sync` run described as "Cloud sync: offsite", 37% through ("copying"), ' +
          `started ${new Date(1_756_000_000_000).toISOString()}.`,
      );
      expect(description).toContain('It was RUNNING when this plan was made.');
      expect(description).toContain('WHAT AN ABORTED `cloudsync.sync` RUN LEAVES BEHIND: a cloud sync stopped part-way');
      expect(description).toContain('which of the two is (unconfirmed)');
    });

    it('says so where the description, progress, start time or state were not reported', async () => {
      const bare = { id: 42, method: 'rsynctask.run', abortable: true };
      const description = (await plan({ jobs: { value: [bare] } }))[1]?.description ?? '';
      expect(description).toContain(
        'Abort job 42, a `rsynctask.run` run with no description of its own, with no progress reported, ' +
          'with no start time reported.',
      );
      expect(description).toContain('Its state could not be read, so whether it is still running is not established');
    });

    it('fails for a job the system does not list, matching the id on the response', async () => {
      await expect(plan({ jobs: { value: [] } })).rejects.toThrow('No job with id 42 on this system');
      // A filter that did not apply comes back as the whole table.
      await expect(plan({ jobs: { value: [running({ id: 7 })] } })).rejects.toThrow(
        'No job with id 42 on this system — the ids this tool takes are the `job_id`',
      );
    });

    it('fails for a method not on the list, naming it, and for one it could not read', async () => {
      await expect(plan({ jobs: { value: [running({ method: 'pool.replace' })] } })).rejects.toThrow(
        'Job 42 runs `pool.replace`, which this tool does not abort — it aborts only `cloudsync.sync`, ',
      );
      await expect(plan({ jobs: { value: [running({ method: 'constructor' })] } })).rejects.toThrow(
        'which this tool does not abort',
      );
      await expect(plan({ jobs: { value: [running({ method: undefined })] } })).rejects.toThrow(
        'Job 42 reported no method this tool could read',
      );
    });

    it('fails for a job that is not abortable, or that did not say', async () => {
      await expect(plan({ jobs: { value: [running({ abortable: false })] } })).rejects.toThrow(
        'Job 42 (`cloudsync.sync`) reports itself as not abortable',
      );
      await expect(plan({ jobs: { value: [running({ abortable: undefined })] } })).rejects.toThrow(
        'did not report whether it is abortable',
      );
    });

    it('fails for a job that has already ended, in any terminal state', async () => {
      for (const state of ['SUCCESS', 'FAILED', 'ABORTED']) {
        await expect(plan({ jobs: { value: [running({ state })] } })).rejects.toThrow(
          `Job 42 (\`cloudsync.sync\`) has already ended, in ${state}; there is nothing to abort`,
        );
      }
    });

    it('plans for a job still waiting to start', async () => {
      const steps = await plan({ jobs: { value: [running({ state: 'WAITING' })] } });
      expect(steps[1]?.description).toContain('It was WAITING when this plan was made.');
    });
  });

  describe('execute refuses, sending nothing, where the id no longer names a job in scope', () => {
    const refused = async (jobs: Answer, message: string) => {
      const { ctx, call, track } = abortSystem({ jobs });
      await expect(jobAbort.execute(ctx, { id: 42 })).rejects.toThrow(message);
      expect(call).not.toHaveBeenCalled();
      expect(track).not.toHaveBeenCalled();
    };

    it('where the id now names a job off the list', async () => {
      await refused({ value: [running({ method: 'pool.replace' })] }, 'Job 42 runs `pool.replace`');
    });

    it('where the job no longer reports itself abortable, or did not say', async () => {
      await refused({ value: [running({ abortable: false })] }, 'reports itself as not abortable');
      await refused({ value: [running({ abortable: undefined })] }, 'did not report whether it is abortable');
    });

    it('where the system lists no such job, or the read fails', async () => {
      await refused({ value: [running({ id: 7 })] }, 'No job with id 42 on this system');
      await refused({ fails: new Error('down') }, 'down');
    });

    it('but not where the job has ended since the plan', async () => {
      const { ctx, call } = abortSystem({ jobs: { value: [running({ state: 'SUCCESS' })] } });
      await jobAbort.execute(ctx, { id: 42 });
      expect(call).toHaveBeenCalledWith('core.job_abort', [42]);
    });
  });

  describe('execute', () => {
    it('aborts the job, follows it, and reports it aborted', async () => {
      const { ctx, call, track } = abortSystem();
      const result = await jobAbort.execute(ctx, { id: 42 });
      expect(call).toHaveBeenCalledWith('core.job_abort', [42]);
      expect(track).toHaveBeenCalledWith(42);
      expect(result).toEqual({
        job_id: 42,
        abort_error: null,
        watched_seconds: 30,
        ended: true,
        aborted: true,
        confirmed: true,
        state: 'ABORTED',
        error: null,
        finished_at: new Date(1_756_000_100_000).toISOString(),
      });
    });

    it('reports a job that finished first as not aborted, and not as an error', async () => {
      expect(await run({ job: of(jobAt('SUCCESS')) })).toMatchObject({
        ended: true,
        aborted: false,
        confirmed: true,
        state: 'SUCCESS',
      });
    });

    it('reports a rejected abort as data, and still reads the job', async () => {
      const { ctx, track } = abortSystem({ abort: { fails: new Error('[ENOENT] no such job') }, job: of(jobAt('SUCCESS')) });
      expect(await jobAbort.execute(ctx, { id: 42 })).toMatchObject({
        abort_error: '[ENOENT] no such job',
        ended: true,
        aborted: false,
        state: 'SUCCESS',
      });
      expect(track).toHaveBeenCalled();
    });

    it('reports a job still running when the watch runs out as not confirmed', async () => {
      vi.useFakeTimers();
      try {
        const { ctx } = abortSystem({ job: concat(of(jobAt('RUNNING')), NEVER) });
        const pending = jobAbort.execute(ctx, { id: 42 });
        await vi.advanceTimersByTimeAsync(30_000);
        expect(await pending).toMatchObject({
          ended: false,
          aborted: null,
          confirmed: false,
          state: 'RUNNING',
          finished_at: null,
        });
      } finally {
        vi.useRealTimers();
      }
    });

    it('reports nothing confirmed where following the job read no state at all', async () => {
      expect(await run({ job: throwError(() => new Error('connection closed')) })).toMatchObject({
        job_id: 42,
        ended: false,
        aborted: null,
        confirmed: null,
        state: null,
      });
      // The tracking completing with nothing is the client finding no such job.
      expect(await run({ job: of() })).toMatchObject({ ended: false, confirmed: null, state: null });
    });
  });
});
