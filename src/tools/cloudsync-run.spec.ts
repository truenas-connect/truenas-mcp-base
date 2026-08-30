import { describe, expect, it, vi } from 'vitest';
import { concat, EMPTY, NEVER, Observable, of, throwError } from 'rxjs';
import { Role } from '@/interfaces';
import { PlanStep, SystemHandle, ToolContext } from '@/catalog/tool';
import { cloudsyncRun } from '@/tools/index';

/**
 * `cloudsync_run`'s tests live here rather than in `tasks.spec.ts` under the
 * #87 split trigger, checked rather than felt: `tasks.spec.ts` is 1,352 lines
 * and this block is several hundred more, so the merged file would cross 1,500
 * exactly as it did at #121. The four listing tools stay where they are.
 *
 * The fake system is local to this file rather than added to
 * `src/testing/fake-systems.ts`. That fixture stubs `call` and `query` from one
 * method→response map, and a job is not one response: it is a stream, and half
 * of what is tested here is what happens when that stream does NOT complete.
 * One caller is not enough to know what shape a shared job fixture should have
 * — the second job-backed tool is when to promote it, the way `strictTextList`
 * was promoted at #102 after two copies existed.
 */

/** A cloud sync task row as `cloudsync.query` answers with one. */
const task = {
  id: 4,
  description: 'Nightly Backblaze',
  path: '/mnt/tank/media',
  direction: 'PUSH',
  transfer_mode: 'COPY',
  enabled: true,
  attributes: { bucket: 'nas-offsite', folder: '/media' },
  // The provider is where the access key lives, and nothing may reach a plan
  // from inside it — asserted below rather than assumed.
  credentials: { id: 2, name: 'Backblaze B2', provider: { pass: 'hunter2' } },
};

/** A second task, to catch a filter that did not apply coming back as the table. */
const otherTask = { ...task, id: 9, description: 'Weekly S3', path: '/mnt/tank/docs' };

/** A job as the client's tracking emits one. */
const jobAt = (state: string, extra: Record<string, unknown> = {}) => ({
  id: 77,
  method: 'cloudsync.sync',
  state,
  // Null on this method whether the run worked or failed — which is the whole
  // reason the outcome is read from `state`.
  result: null,
  error: null,
  time_finished: { $date: 1_756_000_000_000 },
  ...extra,
});

/**
 * A system listing `rows` for `cloudsync.query`, correlating a started job's id
 * through `callAndGetJobId` and following it through `trackJob`.
 *
 * Those are the two halves `api.job` pipes together, and the tool uses them
 * apart so that the id is in hand before anything is read about the job — so
 * the fake has to be able to move them independently. `started` is the id
 * stream and `job` the tracking that follows it.
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
  const steps = await cloudsyncRun.plan(ctx, args);
  expect(steps).toHaveLength(1);
  return steps[0];
};

describe('cloudsync_run', () => {
  it('is a reversible mutating tool needing the full role', () => {
    expect(cloudsyncRun).toMatchObject({
      name: 'cloudsync_run',
      mutating: true,
      destructiveness: 'reversible',
      requiredRole: Role.Full,
    });
  });

  it('takes the task id and nothing but an optional dry run', () => {
    const schema = cloudsyncRun.inputSchema as {
      properties: Record<string, unknown>;
      required: string[];
    };
    expect(Object.keys(schema.properties)).toEqual(['id', 'dry_run']);
    expect(schema.required).toEqual(['id']);
  });

  describe('normalizeArgs', () => {
    it('defaults dry_run to false and drops anything else', () => {
      expect(cloudsyncRun.normalizeArgs?.({ id: 4, systems: 'all' })).toEqual({
        id: 4,
        dry_run: false,
      });
    });

    it('keeps an explicit dry run, so the token binds the two calls apart', () => {
      expect(cloudsyncRun.normalizeArgs?.({ id: 4, dry_run: true })).toEqual({
        id: 4,
        dry_run: true,
      });
    });

    it.each([
      ['a missing id', {}],
      ['an id that is not a number', { id: '4' }],
      ['an id that is not whole', { id: 4.5 }],
    ])('rejects %s', (_name, args) => {
      expect(() => cloudsyncRun.normalizeArgs?.(args)).toThrow('"id" is required');
    });

    it('rejects a dry_run that is not a boolean rather than coercing it', () => {
      // "false" is truthy, so a coercing read would move real data under an
      // approval given for a dry run.
      expect(() => cloudsyncRun.normalizeArgs?.({ id: 4, dry_run: 'false' })).toThrow(
        '"dry_run" must be a boolean',
      );
    });
  });

  describe('plan', () => {
    it('names one call: the job, with the params it will run with', async () => {
      const { ctx } = jobSystem();
      const step = await planStep(ctx, { id: 4 });
      expect(step.method).toBe('cloudsync.sync');
      expect(step.params).toEqual([4, { dry_run: false }]);
    });

    it('sends the options object on an ordinary run too, so the shape is one shape', async () => {
      const { ctx } = jobSystem();
      expect((await planStep(ctx, { id: 4, dry_run: true })).params).toEqual([
        4,
        { dry_run: true },
      ]);
    });

    it('names the task the way cloudsync_tasks_list does, remote end included', async () => {
      const { ctx } = jobSystem();
      const { description } = await planStep(ctx, { id: 4 });
      expect(description).toContain('description "Nightly Backblaze"');
      expect(description).toContain('path "/mnt/tank/media"');
      expect(description).toContain('direction "PUSH"');
      expect(description).toContain('transfer mode "COPY"');
      expect(description).toContain('remote bucket "nas-offsite"');
      expect(description).toContain('remote folder "/media"');
      expect(description).toContain('credential name "Backblaze B2"');
      expect(description).toContain('credential id "2"');
      expect(description).toContain('(id 4)');
    });

    it('names the credential and never what is inside it', async () => {
      const { ctx } = jobSystem();
      expect((await planStep(ctx, { id: 4 })).description).not.toContain('hunter2');
    });

    it('identifies a credential sent in the id-only form the middleware also has', async () => {
      // `credentials` is declared a whole record and also arrives as a bare id,
      // which is why `credentialId` reads both. A plan reading only the name
      // would say the system reported no credential for a task that reported
      // one — a stated absence, in the text a person approves.
      const { ctx } = jobSystem({ rows: [{ ...task, credentials: 2 }] });
      const { description } = await planStep(ctx, { id: 4 });
      expect(description).toContain('credential id "2"');
      expect(description).toContain('credential name (the system reported none)');
    });

    it('states that a field the system reported nothing for is exactly that', async () => {
      const { ctx } = jobSystem({ rows: [{ id: 4 }] });
      const { description } = await planStep(ctx, { id: 4 });
      expect(description).toContain('description (the system reported none)');
      expect(description).toContain('transfer mode (the system reported none)');
      expect(description).toContain('remote bucket (the system reported none)');
      expect(description).toContain('credential name (the system reported none)');
      expect(description).toContain('credential id (the system reported none)');
    });

    it('says a COPY deletes nothing, and which end is which', async () => {
      const { ctx } = jobSystem();
      const { description } = await planStep(ctx, { id: 4 });
      expect(description).toContain(
        'Transfer mode COPY: new and changed files are copied to the destination, and nothing ' +
          'is deleted at either end.',
      );
      expect(description).toContain(
        'On a PUSH this system is the source and the remote the destination',
      );
      expect(description).toContain('This run does all of that for real.');
    });

    it('says outright that a SYNC deletes at the destination', async () => {
      const { ctx } = jobSystem({ rows: [{ ...task, transfer_mode: 'SYNC' }] });
      expect((await planStep(ctx, { id: 4 })).description).toContain(
        'Transfer mode SYNC: the destination is made to match the source, so anything at the ' +
          'destination that is not at the source IS DELETED.',
      );
    });

    it('says outright that a MOVE deletes the source', async () => {
      const { ctx } = jobSystem({ rows: [{ ...task, transfer_mode: 'MOVE' }] });
      expect((await planStep(ctx, { id: 4 })).description).toContain(
        'Transfer mode MOVE: files are copied to the destination and are then DELETED FROM THE ' +
          'SOURCE.',
      );
    });

    it.each([
      ['a mode this tool does not know', 'REPLICATE', '"REPLICATE"'],
      // `in` walks the prototype and would have found a function here.
      ['a mode named after a prototype member', 'constructor', '"constructor"'],
    ])('refuses to guess the effect of %s', async (_name, mode, quoted) => {
      const { ctx } = jobSystem({ rows: [{ ...task, transfer_mode: mode }] });
      expect((await planStep(ctx, { id: 4 })).description).toContain(
        `Transfer mode ${quoted}: whether this run DELETES anything, at either end, is not ` +
          'established here',
      );
    });

    it('does not read an unreadable transfer mode as the harmless one', async () => {
      const { ctx } = jobSystem({ rows: [{ ...task, transfer_mode: 7 }] });
      const { description } = await planStep(ctx, { id: 4 });
      expect(description).toContain(
        'Transfer mode (the system reported none): whether this run DELETES anything',
      );
      expect(description).not.toContain('nothing is deleted at either end');
    });

    it('says a dry run transfers and deletes nothing', async () => {
      const { ctx } = jobSystem({ rows: [{ ...task, transfer_mode: 'MOVE' }] });
      const dry = await planStep(ctx, { id: 4, dry_run: true });
      expect(dry.description).toContain('Dry-run the cloud sync task');
      expect(dry.description).toContain(
        'This is a dry run: it transfers and deletes nothing, and still contacts the remote.',
      );
      // The mode is still stated: what a dry run is a dry run OF is the point.
      expect(dry.description).toContain('DELETED FROM THE SOURCE');
    });

    it('says the job is followed for a bounded time and then left running', async () => {
      const { ctx } = jobSystem();
      const { description } = await planStep(ctx, { id: 4 });
      expect(description).toContain('for at most 30 seconds');
      expect(description).toContain('The sync continues after that whether or not it has finished');
      // The client's tracking read is named in the step rather than being a
      // step of its own: its params are not knowable until the job exists.
      expect(description).toContain('core.get_jobs');
    });

    it('filters the read by id', async () => {
      const { ctx, query } = jobSystem();
      await planStep(ctx, { id: 4 });
      expect(query).toHaveBeenCalledWith('cloudsync.query', [['id', '=', 4]]);
    });

    it('finds the task by id in the response, never by taking the first row', async () => {
      // What a filter that was dropped rather than refused comes back as.
      const { ctx } = jobSystem({ rows: [otherTask, task] });
      expect((await planStep(ctx, { id: 4 })).description).toContain('Nightly Backblaze');
    });

    it('fails when the read lists no task with that id, naming the listing tool', async () => {
      const { ctx } = jobSystem({ rows: [otherTask] });
      await expect(cloudsyncRun.plan(ctx, { id: 4 })).rejects.toThrow(
        'No cloud sync task with id 4 on this system — the ids this tool takes come from ' +
          '`cloudsync_tasks_list`',
      );
    });

    it('fails when the read answers with something that is not a list', async () => {
      const { ctx } = jobSystem({ rows: { id: 4 } });
      await expect(cloudsyncRun.plan(ctx, { id: 4 })).rejects.toThrow('No cloud sync task with id');
    });

    it('starts nothing', async () => {
      const { ctx, start } = jobSystem();
      await planStep(ctx, { id: 4 });
      expect(start).not.toHaveBeenCalled();
    });

    it('lets a failed read fail the plan, since nothing has been approved yet', async () => {
      const { ctx } = jobSystem({ queryFails: new Error('middleware is down') });
      await expect(cloudsyncRun.plan(ctx, { id: 4 })).rejects.toThrow('middleware is down');
    });
  });

  describe('execute', () => {
    it('starts the job through the job surface, with the params the plan named', async () => {
      const { ctx, start, track } = jobSystem();
      await cloudsyncRun.execute(ctx, { id: 4 });
      expect(start).toHaveBeenCalledWith('cloudsync.sync', [4, { dry_run: false }]);
      // And follows the job the client correlated, rather than one it named.
      expect(track).toHaveBeenCalledWith(77);
    });

    it('passes a dry run through as asked, and reports what was sent', async () => {
      const { ctx, start } = jobSystem();
      const result = await cloudsyncRun.execute(ctx, { id: 4, dry_run: true });
      expect(start).toHaveBeenCalledWith('cloudsync.sync', [4, { dry_run: true }]);
      expect(result).toMatchObject({ task_id: 4, dry_run: true });
    });

    it('re-reads nothing: the plan-time read is not repeated', async () => {
      const { ctx, query } = jobSystem();
      await cloudsyncRun.execute(ctx, { id: 4 });
      expect(query).not.toHaveBeenCalled();
    });

    it('reports a job that succeeded, with its id and the bound that applied', async () => {
      const { ctx } = jobSystem({ job: of(jobAt('RUNNING'), jobAt('SUCCESS')) });
      expect(await cloudsyncRun.execute(ctx, { id: 4 })).toEqual({
        task_id: 4,
        dry_run: false,
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
      expect(await cloudsyncRun.execute(ctx, { id: 4 })).toMatchObject({ succeeded: true });
    });

    it('reports a failed job as a failure from its state, never from a null result', async () => {
      const { ctx } = jobSystem({
        job: of(jobAt('FAILED', { error: 'remote refused the credential' })),
      });
      expect(await cloudsyncRun.execute(ctx, { id: 4 })).toMatchObject({
        ended: true,
        succeeded: false,
        state: 'FAILED',
        error: 'remote refused the credential',
      });
    });

    // The tracking completing on a state neither this file nor the pinned
    // client calls terminal is a stream that client CANNOT currently produce:
    // its `terminalStates` holds the same five as `ENDED_JOB_STATES`, so a
    // SUPERSEDED job runs on until the bound expires. What this fixture models
    // is a client release that widens that set — the one case where the two
    // lists come apart — and it is written as a test because both fields have
    // to stay honest when it happens, not because the state is reachable today.
    it('reads a terminal state neither list names as ended and not as a success', async () => {
      const { ctx } = jobSystem({ job: of(jobAt('SUPERSEDED')) });
      expect(await cloudsyncRun.execute(ctx, { id: 4 })).toMatchObject({
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
      expect(await cloudsyncRun.execute(ctx, { id: 4 })).toMatchObject({
        ended: true,
        succeeded: true,
        finished_at: null,
      });
    });

    it('reports no error text where the job recorded none, and none for an empty string', async () => {
      const { ctx } = jobSystem({ job: of(jobAt('FAILED', { error: '' })) });
      expect(await cloudsyncRun.execute(ctx, { id: 4 })).toMatchObject({ error: null });
    });

    it('reports a sync still running when the watch runs out, and leaves it running', async () => {
      vi.useFakeTimers();
      try {
        const { ctx } = jobSystem({ job: concat(of(jobAt('RUNNING')), NEVER) });
        const pending = cloudsyncRun.execute(ctx, { id: 4 });
        await vi.advanceTimersByTimeAsync(30_000);
        expect(await pending).toMatchObject({
          job_id: 77,
          ended: false,
          // Still running is neither a success nor a failure.
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
      expect(await cloudsyncRun.execute(ctx, { id: 4 })).toMatchObject({
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
      // The event correlated the id — the sync IS running — and the tracking
      // said nothing readable. `ended` is false and the caller still gets the
      // one thing that can name the run.
      const { ctx } = jobSystem({ job: EMPTY });
      expect(await cloudsyncRun.execute(ctx, { id: 4 })).toMatchObject({
        job_id: 77,
        ended: false,
        succeeded: null,
        state: null,
      });
    });

    it('establishes nothing from an emission carrying no readable state', async () => {
      const { ctx } = jobSystem({ job: of(jobAt('SUCCESS', { state: 42 })) });
      expect(await cloudsyncRun.execute(ctx, { id: 4 })).toMatchObject({
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
      expect(await cloudsyncRun.execute(ctx, { id: 4 })).toMatchObject({
        job_id: null,
        succeeded: true,
      });
    });

    it('lets a rejected call fail, since there is then no run to report on', async () => {
      const { ctx } = jobSystem({ started: throwError(() => new Error('not authorised')) });
      await expect(cloudsyncRun.execute(ctx, { id: 4 })).rejects.toThrow('not authorised');
    });

    it('does not fail the call when the FOLLOW-UP READ fails before it reports anything', async () => {
      // `trackJob` starts by dispatching `core.get_jobs`, which can fail on its
      // own — after the event correlated the id, so the sync is running. Through
      // `api.job` this would reject with nothing: the id is consumed inside that
      // method's `switchMap` and never reaches the tool.
      const { ctx } = jobSystem({ job: throwError(() => new Error('core.get_jobs failed')) });
      expect(await cloudsyncRun.execute(ctx, { id: 4 })).toMatchObject({
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
      // The sync is running and this is the only call that ever knew its id, so
      // rejecting here would tell the caller the mutation failed and lose the
      // one thing that could still name the run.
      expect(await cloudsyncRun.execute(ctx, { id: 4 })).toMatchObject({
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
      expect(await cloudsyncRun.execute(ctx, { id: 4 })).toMatchObject({
        state: 'SUCCESS',
        ended: false,
        succeeded: null,
        finished_at: null,
      });
    });

    it('rejects arguments it cannot read before making any call', async () => {
      const { ctx, start } = jobSystem();
      await expect(cloudsyncRun.execute(ctx, { id: 'four' })).rejects.toThrow('"id" is required');
      expect(start).not.toHaveBeenCalled();
    });
  });
});
