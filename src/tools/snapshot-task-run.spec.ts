import { describe, expect, it, vi } from 'vitest';
import { concat, EMPTY, NEVER, Observable, of, throwError } from 'rxjs';
import { Role } from '@/interfaces';
import { PlanStep, SystemHandle, ToolContext } from '@/catalog/tool';
import { snapshotTaskRun } from '@/tools/index';

/**
 * `snapshot_task_run`'s tests live here rather than in `tasks.spec.ts` under
 * the #87 split trigger, measured rather than felt: `tasks.spec.ts` is 1,352
 * lines and this block is several hundred more, so the merged file would cross
 * 1,500 exactly as it did at #121 and at `cloudsync_run`. The four listing
 * tools stay where they are.
 *
 * The fake system is local to this file for the reason `cloudsync-run.spec.ts`
 * gives about its own: `src/testing/fake-systems.ts` stubs `call` and `query`
 * from one method→response map, and a job is not one response — it is a stream,
 * and half of what is tested here is what happens when that stream does NOT
 * complete. Two callers now exist, which is the point at which a shared job
 * fixture could be designed from evidence rather than guessed at; promoting it
 * is a change to `src/testing/` that this ticket did not ask for, and the two
 * fixtures differ in the method they read and in nothing else.
 */

/** A periodic snapshot task row as `pool.snapshottask.query` answers with one. */
const task = {
  id: 4,
  dataset: 'tank/media',
  recursive: true,
  enabled: true,
  lifetime_value: 2,
  lifetime_unit: 'WEEK',
  schedule: { minute: '0', hour: '2', dom: '*', month: '*', dow: '*' },
};

/** A second task, to catch a filter that did not apply coming back as the table. */
const otherTask = { ...task, id: 9, dataset: 'tank/docs' };

/** A job as the client's tracking emits one. */
const jobAt = (state: string, extra: Record<string, unknown> = {}) => ({
  id: 77,
  method: 'pool.snapshottask.run',
  state,
  // Null on this method whether the run worked or failed — which is the whole
  // reason the outcome is read from `state`.
  result: null,
  error: null,
  time_finished: { $date: 1_756_000_000_000 },
  ...extra,
});

/**
 * A system listing `rows` for `pool.snapshottask.query`, correlating a started
 * job's id through `callAndGetJobId` and following it through `trackJob`.
 *
 * Those are the two halves `api.job` pipes together, and the tool uses them
 * apart so that the id is in hand before anything is read about the job — so
 * the fake has to be able to move them independently.
 */
function jobSystem(
  options: {
    rows?: unknown;
    started?: Observable<number>;
    job?: Observable<unknown>;
    queryFails?: unknown;
  } = {},
): {
  ctx: ToolContext;
  query: ReturnType<typeof vi.fn>;
  start: ReturnType<typeof vi.fn>;
  track: ReturnType<typeof vi.fn>;
} {
  const query = vi.fn(() =>
    'queryFails' in options ? throwError(() => options.queryFails) : of(options.rows ?? [task]),
  );
  const start = vi.fn(() => options.started ?? of(77));
  const track = vi.fn(() => options.job ?? of(jobAt('SUCCESS')));
  const system = {
    name: 'nas',
    client: { api: { query, callAndGetJobId: start, trackJob: track } },
  } as unknown as SystemHandle;
  return { ctx: { system }, query, start, track };
}

/** The one step the plan returns, typed. */
const planStep = async (ctx: ToolContext, args: Record<string, unknown>): Promise<PlanStep> => {
  const steps = await snapshotTaskRun.plan(ctx, args);
  expect(steps).toHaveLength(1);
  return steps[0];
};

/** The plan's description for a task row, which is what most of these read. */
const planText = async (rows?: unknown): Promise<string> =>
  (await planStep(jobSystem(rows === undefined ? {} : { rows }).ctx, { id: 4 })).description;

describe('snapshot_task_run', () => {
  it('is a reversible mutating tool needing the full role', () => {
    expect(snapshotTaskRun).toMatchObject({
      name: 'snapshot_task_run',
      mutating: true,
      // The task's dataset, recursion, naming schema and retention were all
      // authored by whoever configured it, and the system does exactly this at
      // the next window; this tool moves the moment, not the effect.
      destructiveness: 'reversible',
      requiredRole: Role.Full,
    });
  });

  it('takes the task id and nothing else', () => {
    const schema = snapshotTaskRun.inputSchema as {
      properties: Record<string, unknown>;
      required: string[];
    };
    expect(Object.keys(schema.properties)).toEqual(['id']);
    expect(schema.required).toEqual(['id']);
  });

  describe('description', () => {
    it('says the run applies retention and that the pass is system-wide', () => {
      // The reading that costs data is "this only takes a snapshot", so both
      // halves are pinned: that it prunes at all, and that what it prunes is
      // not limited to the task being run.
      expect(snapshotTaskRun.description).toContain('IT ALSO APPLIES RETENTION');
      expect(snapshotTaskRun.description).toContain(
        'it considers every periodic snapshot task on the system, not only the one being run',
      );
    });

    it('points at snapshots_list for what is due to be destroyed, and enumerates nothing', () => {
      expect(snapshotTaskRun.description).toContain('DOES NOT ENUMERATE WHAT A RUN WILL DESTROY');
      expect(snapshotTaskRun.description).toContain(
        'call `snapshots_list` with `report_scheduled_removal`',
      );
    });

    it('says the account of the pruning is not something this catalog can check', () => {
      // The API surface declares nothing about the retention pass, so the
      // account comes from the TrueNAS implementation — stated, not settled.
      expect(snapshotTaskRun.description).toContain(
        'READ FROM THE TRUENAS IMPLEMENTATION AND IS NOT SOMETHING THIS CATALOG CAN CHECK',
      );
    });

    it('points at tasks_recent_runs for following a run past the bound', () => {
      expect(snapshotTaskRun.description).toContain(
        'MATCHES `id` IN `tasks_recent_runs`, WHICH IS HOW A RUN THAT WAS STILL GOING IS ' +
          'FOLLOWED UP',
      );
    });

    it('says ended false is not one answer and does not partition it', () => {
      expect(snapshotTaskRun.description).toContain(
        'FALSE MEANS NOTHING WAS ESTABLISHED AND IS NOT ONE ANSWER',
      );
      expect(snapshotTaskRun.description).toContain('DO NOT PARTITION IT');
    });
  });

  describe('normalizeArgs', () => {
    it('keeps the id and drops anything else', () => {
      expect(snapshotTaskRun.normalizeArgs?.({ id: 4, systems: 'all' })).toEqual({ id: 4 });
    });

    it.each([
      ['a missing id', {}],
      ['an id that is not a number', { id: '4' }],
      ['an id that is not whole', { id: 4.5 }],
    ])('rejects %s', (_name, args) => {
      expect(() => snapshotTaskRun.normalizeArgs?.(args)).toThrow('"id" is required');
    });
  });

  describe('plan', () => {
    it('names one call: the job, with the params it will run with', async () => {
      const step = await planStep(jobSystem().ctx, { id: 4 });
      expect(step.method).toBe('pool.snapshottask.run');
      expect(step.params).toEqual([4]);
    });

    it('names the task the way snapshot_tasks_list does', async () => {
      expect(await planText()).toContain(
        'Run the periodic snapshot task with dataset "tank/media", schedule at 02:00, every ' +
          'day (id 4) now.',
      );
    });

    it('states a dataset the system reported nothing for as exactly that', async () => {
      expect(await planText([{ id: 4 }])).toContain(
        'the periodic snapshot task with dataset (the system reported none)',
      );
    });

    it('sends an unrenderable schedule to the tool that reports the cron fields', async () => {
      // Not "the system reported no schedule": a shape this file will not put
      // into English is a limit of this file rather than a task without one.
      expect(await planText([{ ...task, schedule: { minute: '*/7', hour: '3' } }])).toContain(
        'schedule (not rendered in words here; `snapshot_tasks_list` reports its cron fields)',
      );
    });

    it('says outright when the run also snapshots the children', async () => {
      expect(await planText()).toContain('It snapshots that dataset AND ITS CHILDREN.');
    });

    it('says outright when it does not', async () => {
      expect(await planText([{ ...task, recursive: false }])).toContain(
        'It snapshots that dataset only, not its children.',
      );
    });

    it('does not read an unreadable recursion as the narrow case', async () => {
      const text = await planText([{ ...task, recursive: 'yes' }]);
      expect(text).toContain(
        "Whether it also snapshots that dataset's children could not be read, so how much of " +
          'the tree this run snapshots is not established here.',
      );
      expect(text).not.toContain('that dataset only');
    });

    it("states the task's own retention as the listing reports it", async () => {
      expect(await planText()).toContain(
        'Its own retention is 2 WEEK, as `snapshot_tasks_list` reports it, so the snapshot ' +
          'this run takes is destroyed that long after it is taken.',
      );
    });

    it.each([
      ['no value', { ...task, lifetime_value: undefined }],
      ['no unit', { ...task, lifetime_unit: undefined }],
      ['a value that is not a number', { ...task, lifetime_value: 'two' }],
    ])('states rather than omits a retention it could not read: %s', async (_name, row) => {
      // A value with no unit names no duration, and a unit with no value names
      // none either — and neither is a task that keeps its snapshots forever.
      const text = await planText([row]);
      expect(text).toContain(
        "This task's own retention could not be read here, so how long the snapshot this run " +
          'takes will be kept is NOT established',
      );
      expect(text).not.toContain('Its own retention is');
    });

    it('states that the retention pass is system-wide, not this task alone', async () => {
      const text = await planText();
      expect(text).toContain('RUNNING THIS DOES NOT ONLY TAKE A SNAPSHOT.');
      expect(text).toContain(
        'THAT PASS IS SYSTEM-WIDE: it considers EVERY periodic snapshot task on this system ' +
          'rather than only the one being run, so snapshots belonging to OTHER tasks whose ' +
          'retention had already lapsed can be destroyed by this run.',
      );
    });

    it('states both protections, which is what bounds the alarm above', async () => {
      const text = await planText();
      expect(text).toContain(
        "a snapshot whose name matches no task's naming schema is skipped entirely, so a " +
          'snapshot taken by hand — through `snapshots_create` or otherwise — is not at risk',
      );
      expect(text).toContain(
        'the newest snapshot for a naming schema is kept where destroying it would leave that ' +
          'schema with none',
      );
    });

    it('refuses to say which snapshots go, and points at where that is reported', async () => {
      expect(await planText()).toContain(
        'THIS PLAN DOES NOT SAY WHICH SNAPSHOTS WILL BE DESTROYED and this tool does not ' +
          'compute it: call `snapshots_list` with `report_scheduled_removal` first, which ' +
          'reports the removal the middleware itself works out per snapshot.',
      );
    });

    it('says the job is followed for a bounded time and then left running', async () => {
      const text = await planText();
      expect(text).toContain('for at most 30 seconds');
      expect(text).toContain('The run continues after that whether or not it has finished.');
      // The client's tracking read is named in the step rather than being a
      // step of its own: its params are not knowable until the job exists.
      expect(text).toContain('core.get_jobs');
    });

    it('says the task was enabled when the plan was made', async () => {
      expect(await planText()).toContain('The task was enabled when this plan was made.');
    });

    it('fails, naming the task and the tool that switches it on, where it is disabled', async () => {
      const { ctx } = jobSystem({ rows: [{ ...task, enabled: false }] });
      await expect(snapshotTaskRun.plan(ctx, { id: 4 })).rejects.toThrow(
        'The periodic snapshot task with id 4 on this system is disabled, and the middleware ' +
          'refuses to run a disabled task — switch it on with `scheduled_task_set_enabled` ' +
          'with `kind` `periodic_snapshot` first',
      );
    });

    it.each([
      ['a missing enabled', { ...task, enabled: undefined }],
      ['an enabled that is not a boolean', { ...task, enabled: 'yes' }],
    ])('does not read %s as a disabled task, and says the call may be refused', async (_n, row) => {
      // `enabled: false` is a positive claim and null is not, so failing on an
      // unreadable one would refuse a plan the middleware would have accepted.
      expect(await planText([row])).toContain(
        'Whether the task is enabled could not be read, and the middleware REFUSES to run a ' +
          'disabled task — so this call may be rejected; `scheduled_task_set_enabled` with ' +
          '`kind` `periodic_snapshot` is what switches one on.',
      );
    });

    it('filters the read by id', async () => {
      const { ctx, query } = jobSystem();
      await planStep(ctx, { id: 4 });
      expect(query).toHaveBeenCalledWith('pool.snapshottask.query', [['id', '=', 4]]);
    });

    it('finds the task by id in the response, never by taking the first row', async () => {
      // What a filter that was dropped rather than refused comes back as — and
      // the first row of it is a different task, on a different dataset.
      expect(await planText([otherTask, task])).toContain('dataset "tank/media"');
    });

    it('fails when the read lists no task with that id, naming the listing tool', async () => {
      const { ctx } = jobSystem({ rows: [otherTask] });
      await expect(snapshotTaskRun.plan(ctx, { id: 4 })).rejects.toThrow(
        'No periodic snapshot task with id 4 on this system — the ids this tool takes come ' +
          'from `snapshot_tasks_list`',
      );
    });

    it('fails when the read answers with something that is not a list', async () => {
      const { ctx } = jobSystem({ rows: { id: 4 } });
      await expect(snapshotTaskRun.plan(ctx, { id: 4 })).rejects.toThrow(
        'No periodic snapshot task with id 4',
      );
    });

    it('starts nothing', async () => {
      const { ctx, start } = jobSystem();
      await planStep(ctx, { id: 4 });
      expect(start).not.toHaveBeenCalled();
    });

    it('lets a failed read fail the plan, since nothing has been approved yet', async () => {
      const { ctx } = jobSystem({ queryFails: new Error('middleware is down') });
      await expect(snapshotTaskRun.plan(ctx, { id: 4 })).rejects.toThrow('middleware is down');
    });

    it('rejects arguments it cannot read before making any call', async () => {
      const { ctx, query } = jobSystem();
      await expect(snapshotTaskRun.plan(ctx, { id: 'four' })).rejects.toThrow('"id" is required');
      expect(query).not.toHaveBeenCalled();
    });
  });

  describe('execute', () => {
    it('starts the job through the job surface, with the params the plan named', async () => {
      const { ctx, start, track } = jobSystem();
      await snapshotTaskRun.execute(ctx, { id: 4 });
      expect(start).toHaveBeenCalledWith('pool.snapshottask.run', [4]);
      // And follows the job the client correlated, rather than one it named.
      expect(track).toHaveBeenCalledWith(77);
    });

    it('re-reads nothing: the plan-time read is not repeated', async () => {
      // Which is also why a task disabled between the plan and the
      // confirmation is refused by the middleware rather than here.
      const { ctx, query } = jobSystem();
      await snapshotTaskRun.execute(ctx, { id: 4 });
      expect(query).not.toHaveBeenCalled();
    });

    it('reports a run that succeeded, with its id and the bound that applied', async () => {
      const { ctx } = jobSystem({ job: of(jobAt('RUNNING'), jobAt('SUCCESS')) });
      expect(await snapshotTaskRun.execute(ctx, { id: 4 })).toEqual({
        task_id: 4,
        job_id: 77,
        watched_seconds: 30,
        ended: true,
        succeeded: true,
        state: 'SUCCESS',
        error: null,
        finished_at: '2025-08-24T01:46:40.000Z',
      });
    });

    it('counts FINISHED as success, as the rest of this family does', async () => {
      const { ctx } = jobSystem({ job: of(jobAt('FINISHED')) });
      expect(await snapshotTaskRun.execute(ctx, { id: 4 })).toMatchObject({ succeeded: true });
    });

    it('reports a failed job as a failure from its state, never from a null result', async () => {
      const { ctx } = jobSystem({
        job: of(jobAt('FAILED', { error: 'dataset is locked' })),
      });
      expect(await snapshotTaskRun.execute(ctx, { id: 4 })).toMatchObject({
        ended: true,
        succeeded: false,
        state: 'FAILED',
        error: 'dataset is locked',
      });
    });

    // The tracking completing on a state neither this file nor the pinned
    // client calls terminal is a stream that client CANNOT currently produce:
    // its `terminalStates` holds the same five as `ENDED_JOB_STATES`. What this
    // fixture models is a client release that widens that set — the one case
    // where the two lists come apart — and it is written as a test because both
    // fields have to stay honest when it happens.
    it('reads a terminal state neither list names as ended and not as a success', async () => {
      const { ctx } = jobSystem({ job: of(jobAt('SUPERSEDED')) });
      expect(await snapshotTaskRun.execute(ctx, { id: 4 })).toMatchObject({
        ended: true,
        succeeded: false,
        state: 'SUPERSEDED',
        // And the finish time follows `ended`. Reading `ENDED_JOB_STATES` here
        // instead would have one result call the run over and refuse to say
        // when it ended.
        finished_at: '2025-08-24T01:46:40.000Z',
      });
    });

    it('reports no finish time for an ended job that recorded none it can read', async () => {
      const { ctx } = jobSystem({ job: of(jobAt('SUCCESS', { time_finished: 'yesterday' })) });
      expect(await snapshotTaskRun.execute(ctx, { id: 4 })).toMatchObject({
        ended: true,
        succeeded: true,
        finished_at: null,
      });
    });

    it('reports no error text where the job recorded none, and none for an empty string', async () => {
      const { ctx } = jobSystem({ job: of(jobAt('FAILED', { error: '' })) });
      expect(await snapshotTaskRun.execute(ctx, { id: 4 })).toMatchObject({ error: null });
    });

    it('reports a run still going when the watch runs out, and leaves it going', async () => {
      vi.useFakeTimers();
      try {
        const { ctx } = jobSystem({ job: concat(of(jobAt('RUNNING')), NEVER) });
        const pending = snapshotTaskRun.execute(ctx, { id: 4 });
        await vi.advanceTimersByTimeAsync(30_000);
        expect(await pending).toMatchObject({
          job_id: 77,
          ended: false,
          // Still going is neither a success nor a failure.
          succeeded: null,
          state: 'RUNNING',
          // The record carries a time and it is still not a finish time: a run
          // that was not established to be over was not established to have
          // ended then.
          finished_at: null,
        });
      } finally {
        vi.useRealTimers();
      }
    });

    it('establishes nothing from a job it never saw, and does not call that a failure', async () => {
      // No job event named the request, so there is no id and nothing to track.
      const { ctx, track } = jobSystem({ started: EMPTY });
      expect(await snapshotTaskRun.execute(ctx, { id: 4 })).toMatchObject({
        job_id: null,
        ended: false,
        succeeded: null,
        state: null,
        error: null,
        finished_at: null,
      });
      expect(track).not.toHaveBeenCalled();
    });

    it('keeps the id of a job the client named and then reported nothing about', async () => {
      // The event correlated the id — the run IS going — and the tracking said
      // nothing readable. `ended` is false and the caller still gets the one
      // thing that can name the run.
      const { ctx } = jobSystem({ job: EMPTY });
      expect(await snapshotTaskRun.execute(ctx, { id: 4 })).toMatchObject({
        job_id: 77,
        ended: false,
        succeeded: null,
        state: null,
      });
    });

    it('establishes nothing from an emission carrying no readable state', async () => {
      const { ctx } = jobSystem({ job: of(jobAt('SUCCESS', { state: 42 })) });
      expect(await snapshotTaskRun.execute(ctx, { id: 4 })).toMatchObject({
        job_id: 77,
        ended: false,
        succeeded: null,
        state: null,
      });
    });

    it('reports no job id where the event carried none this tool can read', async () => {
      // The client declares the id a number; a declared type is a claim about
      // what is sent rather than about the value received.
      const { ctx } = jobSystem({ started: of('seventy-seven' as unknown as number) });
      expect(await snapshotTaskRun.execute(ctx, { id: 4 })).toMatchObject({
        job_id: null,
        succeeded: true,
      });
    });

    it('lets a rejected call fail, since there is then no run to report on', async () => {
      const { ctx } = jobSystem({ started: throwError(() => new Error('not authorised')) });
      await expect(snapshotTaskRun.execute(ctx, { id: 4 })).rejects.toThrow('not authorised');
    });

    it('does not fail the call when the FOLLOW-UP READ fails before it reports anything', async () => {
      // `trackJob` starts by dispatching `core.get_jobs`, which can fail on its
      // own — after the event correlated the id, so the run is going. Through
      // `api.job` this would reject with nothing: the id is consumed inside
      // that method's `switchMap` and never reaches the tool.
      const { ctx } = jobSystem({ job: throwError(() => new Error('core.get_jobs failed')) });
      expect(await snapshotTaskRun.execute(ctx, { id: 4 })).toMatchObject({
        job_id: 77,
        ended: false,
        succeeded: null,
        state: null,
      });
    });

    it('keeps the job id when following the job fails after it has been seen', async () => {
      const { ctx } = jobSystem({
        job: concat(of(jobAt('RUNNING')), throwError(() => new Error('connection dropped'))),
      });
      // The run is going and this is the only call that ever knew its id, so
      // rejecting here would tell the caller the mutation failed and lose the
      // one thing that could still name the run.
      expect(await snapshotTaskRun.execute(ctx, { id: 4 })).toMatchObject({
        job_id: 77,
        ended: false,
        succeeded: null,
        state: 'RUNNING',
        finished_at: null,
      });
    });

    it('does not report a job as ended because following it stopped', async () => {
      const { ctx } = jobSystem({
        job: concat(of(jobAt('SUCCESS')), throwError(() => new Error('connection dropped'))),
      });
      // The state read is SUCCESS and the stream did not complete, so nothing
      // established that the run is over — `ended` is what says so and it is
      // false, which is what keeps `succeeded` from being read off a state the
      // job may still move out of.
      expect(await snapshotTaskRun.execute(ctx, { id: 4 })).toMatchObject({
        state: 'SUCCESS',
        ended: false,
        succeeded: null,
        finished_at: null,
      });
    });

    it('rejects arguments it cannot read before making any call', async () => {
      const { ctx, start } = jobSystem();
      await expect(snapshotTaskRun.execute(ctx, { id: 'four' })).rejects.toThrow(
        '"id" is required',
      );
      expect(start).not.toHaveBeenCalled();
    });
  });
});
