import { describe, expect, it, vi } from 'vitest';
import { concat, EMPTY, NEVER, Observable, of, throwError } from 'rxjs';
import { Role } from '@/interfaces';
import { PlanStep, SystemHandle, ToolContext } from '@/catalog/tool';
import { vmStop } from '@/tools/index';

/**
 * `vm_stop`'s tests live here rather than in `vms.spec.ts` under the #87 split
 * trigger — see `vm-start.spec.ts` for the measurement. The fake system is
 * local for the reason `snapshot-task-run.spec.ts` gives about its own: a job is
 * a stream rather than a response, and `src/testing/fake-systems.ts` stubs
 * `call` and `query` off one method→response map. This one has to move the
 * correlation and the tracking independently AND answer two reads of `vm.query`
 * differently, which is a third caller for a shared job fixture rather than a
 * reason to design one here.
 */

/** A libvirt-backed VM row as `vm.query` answers with one. */
const vm = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 4,
  name: 'builder',
  status: { state: 'RUNNING', domain_state: 'RUNNING' },
  vcpus: 1,
  cores: 2,
  threads: 1,
  memory: 4096,
  min_memory: null,
  autostart: true,
  shutdown_timeout: 90,
  ...extra,
});

/** A job as the client's tracking emits one. */
const jobAt = (state: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 77,
  method: 'vm.stop',
  state,
  // Null on this method whether the stop worked or failed — which is the whole
  // reason the outcome is read from `state`.
  result: null,
  error: null,
  time_finished: { $date: 1_756_000_000_000 },
  ...extra,
});

/** One answer to a `vm.query` read: the rows it listed, or the failure that stopped it. */
type Read = { rows: unknown[] } | { fails: unknown };

/**
 * A system answering `vm.query` from a queue, correlating a started job's id
 * through `callAndGetJobId` and following it through `trackJob`.
 *
 * Those are the two halves `api.job` pipes together, and the tool uses them
 * apart so the id is in hand before anything is read about the job — so the
 * fake has to be able to move them independently.
 */
function jobSystem(
  options: { reads?: Read[]; started?: Observable<number>; job?: Observable<unknown> } = {},
): {
  ctx: ToolContext;
  query: ReturnType<typeof vi.fn>;
  start: ReturnType<typeof vi.fn>;
  track: ReturnType<typeof vi.fn>;
} {
  const reads = options.reads ?? [{ rows: [vm()] }];
  let index = 0;
  const query = vi.fn(() => {
    const read = reads[Math.min(index, reads.length - 1)];
    index += 1;
    return 'fails' in read ? throwError(() => read.fails) : of(read.rows);
  });
  const start = vi.fn(() => options.started ?? of(77));
  const track = vi.fn(() => options.job ?? of(jobAt('SUCCESS')));
  const system = {
    name: 'nas',
    client: { api: { query, callAndGetJobId: start, trackJob: track } },
  } as unknown as SystemHandle;
  return { ctx: { system }, query, start, track };
}

/** The two steps the plan returns, typed. */
const planSteps = async (
  ctx: ToolContext,
  args: Record<string, unknown> = { id: 4 },
): Promise<PlanStep[]> => {
  const steps = await vmStop.plan(ctx, args);
  expect(steps).toHaveLength(2);
  return steps;
};

/** The mutation step's description, which is what most of the plan tests read. */
const planText = async (
  rows: unknown[],
  args: Record<string, unknown> = { id: 4 },
): Promise<string> => (await planSteps(jobSystem({ reads: [{ rows }] }).ctx, args))[1].description;

describe('vm_stop', () => {
  it('is a reversible mutating tool needing the full role', () => {
    expect(vmStop).toMatchObject({
      name: 'vm_stop',
      mutating: true,
      // The operation is undone by `vm_start`, which is in this catalog. What a
      // forced stop does to the guest's unwritten data is not, and this field
      // cannot say both: the description carries that account.
      destructiveness: 'reversible',
      requiredRole: Role.Full,
    });
  });

  it('takes the id and the two shutdown-path booleans', () => {
    const schema = vmStop.inputSchema as {
      properties: Record<string, unknown>;
      required: string[];
    };
    expect(Object.keys(schema.properties)).toEqual(['id', 'force', 'force_after_timeout']);
    expect(schema.required).toEqual(['id']);
  });

  describe('description', () => {
    it('says a forced stop loses whatever the guest had not written', () => {
      expect(vmStop.description).toContain('DESTROYS THE DOMAIN IMMEDIATELY');
      expect(vmStop.description).toContain('ANYTHING IT HAD NOT WRITTEN TO DISK IS LOST');
    });

    it('asserts no unit for shutdown_timeout', () => {
      // A `_seconds` on a number the system meant as something else is worse
      // than no suffix at all: an unsuffixed number is asked about, a suffixed
      // one is converted.
      expect(vmStop.description).toContain('NO UNIT IS ASSERTED FOR IT');
      expect(vmStop.description).toContain('must not be converted');
    });

    it('says the resulting state is read when the watch ends, not when the stop does', () => {
      expect(vmStop.description).toContain(
        '`resulting_state` IS READ WHEN THE WATCH ENDS AND NOT WHEN THE STOP DOES',
      );
    });

    it('does not partition a false ended', () => {
      expect(vmStop.description).toContain('FALSE MEANS NOTHING WAS ESTABLISHED');
      expect(vmStop.description).toContain('DO NOT PARTITION IT');
    });
  });

  describe('normalizeArgs', () => {
    it('drops the executor arguments and defaults both booleans to false', () => {
      expect(vmStop.normalizeArgs?.({ id: 4, systems: 'all' })).toEqual({
        id: 4,
        force: false,
        force_after_timeout: false,
      });
    });

    it('keeps the booleans the caller asked for', () => {
      expect(vmStop.normalizeArgs?.({ id: 4, force: true, force_after_timeout: true })).toEqual({
        id: 4,
        force: true,
        force_after_timeout: true,
      });
    });

    it.each([{}, { id: '4' }, { id: 4.5 }])('refuses an id it cannot read: %o', (args) => {
      expect(() => vmStop.normalizeArgs?.(args)).toThrow('"id" is required');
    });

    it('refuses a force it cannot read rather than coercing it', () => {
      // Coercing `"false"` to true destroys a guest under an approval given for
      // a graceful shutdown, which is a different answer and not a narrower one.
      expect(() => vmStop.normalizeArgs?.({ id: 4, force: 'false' })).toThrow(
        '"force" must be a boolean',
      );
    });

    it('refuses a force_after_timeout it cannot read', () => {
      expect(() => vmStop.normalizeArgs?.({ id: 4, force_after_timeout: 1 })).toThrow(
        '"force_after_timeout" must be a boolean',
      );
    });
  });

  describe('plan', () => {
    it('names the read and the mutation, in the order execute makes them', async () => {
      const steps = await planSteps(jobSystem().ctx);
      expect(steps.map((step) => step.method)).toEqual(['vm.query', 'vm.stop']);
      expect(steps[1].params).toEqual([4, { force: false, force_after_timeout: false }]);
    });

    it('says the second read happens when the watch ends, not immediately', async () => {
      // The read step's text is shared by all three power tools and only
      // `vm_start` reads back on the next line. An approver told "immediately
      // after the call" would read a machine part-way through a shutdown as the
      // state it settled in.
      const [read] = await planSteps(jobSystem().ctx);
      expect(read.description).toContain('Changes nothing');
      expect(read.description).toContain(
        'WHEN THE WATCH BELOW ENDS — UP TO 30 SECONDS AFTER THIS CALL IS MADE, AND NOT WHEN THE OPERATION FINISHES',
      );
      expect(read.description).not.toContain('IMMEDIATELY AFTER THE CALL');
    });

    it("makes every read with the params the plan's read step named", async () => {
      // Two halves, each against its own literal: the step names the two
      // positional params the call reaches the middleware with, since
      // `api.query(method, filters)` dispatches `[filters ?? [], options ?? {}]`,
      // and the JS call passes the filter alone.
      const { ctx, query } = jobSystem();
      const [read] = await planSteps(ctx);
      await vmStop.execute(ctx, { id: 4 });
      expect(read.params).toEqual([[['id', '=', 4]], {}]);
      expect(query.mock.calls).toEqual([
        ['vm.query', [['id', '=', 4]]],
        ['vm.query', [['id', '=', 4]]],
        ['vm.query', [['id', '=', 4]]],
      ]);
    });

    it('fails naming the id where no machine has it', async () => {
      const { ctx } = jobSystem({ reads: [{ rows: [] }] });
      await expect(vmStop.plan(ctx, { id: 4 })).rejects.toThrow(
        'No virtual machine with id 4 on the `vm` stack',
      );
    });

    it('checks the id on the response rather than acting on the first row', async () => {
      const { ctx } = jobSystem({ reads: [{ rows: [vm({ id: 9 })] }] });
      await expect(vmStop.plan(ctx, { id: 4 })).rejects.toThrow('No virtual machine with id 4');
    });

    it('states the graceful path and names the timeout without a unit', async () => {
      const text = await planText([vm()]);
      expect(text).toContain('asks the guest to shut down over ACPI');
      expect(text).toContain('`shutdown_timeout`, which this system records as 90');
      expect(text).toContain('THE API DECLARES NO UNIT FOR THAT NUMBER');
    });

    it('says the timeout could not be read rather than substituting a number', async () => {
      expect(await planText([vm({ shutdown_timeout: null })])).toContain(
        'WHICH THIS SYSTEM REPORTED NO VALUE FOR',
      );
    });

    it('states what a forced stop destroys, and that the timeout does not apply', async () => {
      const text = await planText([vm()], { id: 4, force: true });
      expect(text).toContain('THIS DESTROYS THE DOMAIN IMMEDIATELY');
      expect(text).toContain('WHATEVER IT HAD NOT WRITTEN TO DISK IS LOST');
      expect(text).toContain("VM's `shutdown_timeout` does not apply");
    });

    it('says force_after_timeout makes no difference under force', async () => {
      // Two arguments that look like a pair, where one disables the other — the
      // approver is the one who has to know that.
      expect(await planText([vm()], { id: 4, force: true, force_after_timeout: true })).toContain(
        '`force_after_timeout` is not reached and makes no difference here',
      );
    });

    it('states the forced destruction where only force_after_timeout is set', async () => {
      expect(await planText([vm()], { id: 4, force_after_timeout: true })).toContain(
        'IF THE GUEST HAS NOT STOPPED BY THEN THE DOMAIN IS DESTROYED ANYWAY',
      );
    });

    it('marks what happens to a guest that will not go as unconfirmed', async () => {
      // The honest answer: not read off a live system, and not on the surface.
      const text = await planText([vm()]);
      expect(text).toContain('the domain is NOT destroyed when that time runs out');
      expect(text).toContain('(unconfirmed)');
    });

    it('does not refuse an already-stopped machine, and says the outcome is unconfirmed', async () => {
      expect(await planText([vm({ status: { state: 'STOPPED' } })])).toContain(
        'IT ALREADY READ AS `STOPPED` WHEN THIS PLAN WAS MADE',
      );
    });

    it('names the watch and says the stop continues past it', async () => {
      expect(await planText([vm()])).toContain(
        'for at most 30 seconds. The operation continues after that',
      );
    });

    it('lets a plan-time read failure fail the plan', async () => {
      const { ctx } = jobSystem({ reads: [{ fails: new Error('middleware is down') }] });
      await expect(vmStop.plan(ctx, { id: 4 })).rejects.toThrow('middleware is down');
    });

    it('rejects arguments it cannot read before making any call', async () => {
      const { ctx, query } = jobSystem();
      await expect(vmStop.plan(ctx, { id: 'four' })).rejects.toThrow('"id" is required');
      expect(query).not.toHaveBeenCalled();
    });
  });

  describe('execute', () => {
    it('starts the job through the job surface, with the params the plan named', async () => {
      const { ctx, start, track } = jobSystem();
      await vmStop.execute(ctx, { id: 4 });
      expect(start).toHaveBeenCalledWith('vm.stop', [
        4,
        { force: false, force_after_timeout: false },
      ]);
      // And follows the job the client correlated, rather than one it named.
      expect(track).toHaveBeenCalledWith(77);
    });

    it('reports the job, the two readings and the bound that applied', async () => {
      const { ctx } = jobSystem({
        reads: [
          { rows: [vm()] },
          { rows: [vm({ status: { state: 'STOPPED', domain_state: 'SHUTOFF' } })] },
        ],
      });
      expect(await vmStop.execute(ctx, { id: 4 })).toEqual({
        vm_id: 4,
        previous_lookup: 'FOUND',
        previous_read_error: null,
        previously_state: 'RUNNING',
        previously_domain_state: 'RUNNING',
        resulting_lookup: 'FOUND',
        resulting_read_error: null,
        resulting_state: 'STOPPED',
        resulting_domain_state: 'SHUTOFF',
        changed: true,
        requested_force: false,
        requested_force_after_timeout: false,
        watched_seconds: 30,
        job_id: 77,
        ended: true,
        succeeded: true,
        job_state: 'SUCCESS',
        error: null,
        finished_at: '2025-08-24T01:46:40.000Z',
      });
    });

    it('counts FINISHED as success too', async () => {
      const { ctx } = jobSystem({ job: of(jobAt('FINISHED')) });
      expect(await vmStop.execute(ctx, { id: 4 })).toMatchObject({ succeeded: true });
    });

    it('reports a failed job from its state, never from a null result', async () => {
      const { ctx } = jobSystem({ job: of(jobAt('FAILED', { error: 'domain is not running' })) });
      expect(await vmStop.execute(ctx, { id: 4 })).toMatchObject({
        ended: true,
        succeeded: false,
        job_state: 'FAILED',
        error: 'domain is not running',
      });
    });

    it('reads a terminal state this catalog does not know as ended and not a success', async () => {
      const { ctx } = jobSystem({ job: of(jobAt('SUPERSEDED')) });
      expect(await vmStop.execute(ctx, { id: 4 })).toMatchObject({
        ended: true,
        succeeded: false,
        job_state: 'SUPERSEDED',
      });
    });

    it('reports no finish time for an ended job that recorded none it can read', async () => {
      const { ctx } = jobSystem({ job: of(jobAt('SUCCESS', { time_finished: 'yesterday' })) });
      expect(await vmStop.execute(ctx, { id: 4 })).toMatchObject({
        ended: true,
        finished_at: null,
      });
    });

    it('reports no error text where the job recorded an empty one', async () => {
      const { ctx } = jobSystem({ job: of(jobAt('FAILED', { error: '' })) });
      expect(await vmStop.execute(ctx, { id: 4 })).toMatchObject({ error: null });
    });

    it('reports a stop still going when the watch runs out, and leaves it going', async () => {
      vi.useFakeTimers();
      try {
        const { ctx } = jobSystem({ job: concat(of(jobAt('RUNNING')), NEVER) });
        const pending = vmStop.execute(ctx, { id: 4 });
        await vi.advanceTimersByTimeAsync(30_000);
        expect(await pending).toMatchObject({
          job_id: 77,
          ended: false,
          succeeded: null,
          job_state: 'RUNNING',
          // The record carries a time and it is still not a finish time.
          finished_at: null,
        });
      } finally {
        vi.useRealTimers();
      }
    });

    it('still reads the resulting state after a watch that timed out', async () => {
      // Which is why `resulting_state` is described as the state when the WATCH
      // ended rather than when the stop did.
      vi.useFakeTimers();
      try {
        const { ctx } = jobSystem({
          reads: [{ rows: [vm()] }, { rows: [vm({ status: { state: 'STOPPING' } })] }],
          job: concat(of(jobAt('RUNNING')), NEVER),
        });
        const pending = vmStop.execute(ctx, { id: 4 });
        await vi.advanceTimersByTimeAsync(30_000);
        expect(await pending).toMatchObject({
          ended: false,
          resulting_state: 'STOPPING',
          changed: true,
        });
      } finally {
        vi.useRealTimers();
      }
    });

    it('establishes nothing from a job it never saw, and does not call that a failure', async () => {
      const { ctx, track } = jobSystem({ started: EMPTY });
      expect(await vmStop.execute(ctx, { id: 4 })).toMatchObject({
        job_id: null,
        ended: false,
        succeeded: null,
        job_state: null,
      });
      expect(track).not.toHaveBeenCalled();
    });

    it('keeps the id of a job the client named and then reported nothing about', async () => {
      const { ctx } = jobSystem({ job: EMPTY });
      expect(await vmStop.execute(ctx, { id: 4 })).toMatchObject({
        job_id: 77,
        ended: false,
        job_state: null,
      });
    });

    it('establishes nothing from an emission carrying no readable state', async () => {
      const { ctx } = jobSystem({ job: of(jobAt('SUCCESS', { state: 42 })) });
      expect(await vmStop.execute(ctx, { id: 4 })).toMatchObject({
        job_id: 77,
        ended: false,
        succeeded: null,
        job_state: null,
      });
    });

    it('reports no job id where the event carried none this tool can read', async () => {
      const { ctx } = jobSystem({ started: of('seventy-seven' as unknown as number) });
      expect(await vmStop.execute(ctx, { id: 4 })).toMatchObject({
        job_id: null,
        succeeded: true,
      });
    });

    it('lets a rejected call fail, since there is then no stop to report on', async () => {
      const { ctx } = jobSystem({ started: throwError(() => new Error('not authorised')) });
      await expect(vmStop.execute(ctx, { id: 4 })).rejects.toThrow('not authorised');
    });

    it('does not fail the call when the FOLLOW-UP READ fails before reporting anything', async () => {
      // `trackJob` starts by dispatching `core.get_jobs`, which can fail on its
      // own — after the event correlated the id, so the stop is going. Through
      // `api.job` this would reject carrying nothing.
      const { ctx } = jobSystem({ job: throwError(() => new Error('core.get_jobs failed')) });
      expect(await vmStop.execute(ctx, { id: 4 })).toMatchObject({
        job_id: 77,
        ended: false,
        job_state: null,
      });
    });

    it('keeps the job id when following the job fails after it has been seen', async () => {
      const { ctx } = jobSystem({
        job: concat(of(jobAt('RUNNING')), throwError(() => new Error('connection dropped'))),
      });
      expect(await vmStop.execute(ctx, { id: 4 })).toMatchObject({
        job_id: 77,
        ended: false,
        succeeded: null,
        job_state: 'RUNNING',
      });
    });

    it('does not report a job as ended because following it stopped', async () => {
      const { ctx } = jobSystem({
        job: concat(of(jobAt('SUCCESS')), throwError(() => new Error('connection dropped'))),
      });
      expect(await vmStop.execute(ctx, { id: 4 })).toMatchObject({
        job_state: 'SUCCESS',
        ended: false,
        succeeded: null,
        finished_at: null,
      });
    });

    it('starts the job where the read before it failed, and reports why', async () => {
      const { ctx, start } = jobSystem({
        reads: [{ fails: new Error('read refused') }, { rows: [vm()] }],
      });
      expect(await vmStop.execute(ctx, { id: 4 })).toMatchObject({
        previous_lookup: 'UNREADABLE',
        previous_read_error: 'read refused',
        changed: null,
      });
      expect(start).toHaveBeenCalledTimes(1);
    });

    it('does not fail the tool when the read AFTER the watch fails', async () => {
      const { ctx } = jobSystem({
        reads: [{ rows: [vm()] }, { fails: new Error('connection dropped') }],
      });
      expect(await vmStop.execute(ctx, { id: 4 })).toMatchObject({
        resulting_lookup: 'UNREADABLE',
        resulting_read_error: 'connection dropped',
        changed: null,
        // And the job it started is still reported.
        ended: true,
      });
    });

    it('rejects arguments it cannot read before making any call', async () => {
      const { ctx, start } = jobSystem();
      await expect(vmStop.execute(ctx, { id: 'four' })).rejects.toThrow('"id" is required');
      expect(start).not.toHaveBeenCalled();
    });
  });
});
