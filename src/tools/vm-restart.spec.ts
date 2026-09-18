import { describe, expect, it, vi } from 'vitest';
import { concat, EMPTY, NEVER, Observable, of, throwError } from 'rxjs';
import { Role } from '@/interfaces';
import { PlanStep, SystemHandle, ToolContext } from '@/catalog/tool';
import { vmRestart } from '@/tools/index';

/**
 * `vm_restart`'s tests live here rather than in `vms.spec.ts` under the #87
 * split trigger — see `vm-start.spec.ts` for the measurement — and the fake
 * system is local for the reason `vm-stop.spec.ts` gives about its own.
 *
 * What this file is mostly about is the two decisions the middleware makes on
 * the caller's behalf and `vm.restart`'s own params do not mention. Nothing in
 * the client says a restart forces after the timeout or overcommits, so no test
 * here can observe either — what CAN be pinned is that both are stated, in the
 * description and in the plan, and that neither text reduces to "stop then
 * start". That is the point of the assertions below that read prose: the
 * account is unverifiable from this repository, so its presence is the only
 * thing there is to hold.
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
  method: 'vm.restart',
  state,
  // Null on this method whether the restart worked or failed.
  result: null,
  error: null,
  time_finished: { $date: 1_756_000_000_000 },
  ...extra,
});

/** One answer to a `vm.query` read: the rows it listed, or the failure that stopped it. */
type Read = { rows: unknown[] } | { fails: unknown };

/** A system answering `vm.query` from a queue and running the job halves apart. */
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
  const steps = await vmRestart.plan(ctx, args);
  expect(steps).toHaveLength(2);
  return steps;
};

/** The mutation step's description, which is what most of the plan tests read. */
const planText = async (rows: unknown[] = [vm()]): Promise<string> =>
  (await planSteps(jobSystem({ reads: [{ rows }] }).ctx))[1].description;

describe('vm_restart', () => {
  it('is a reversible mutating tool needing the full role', () => {
    expect(vmRestart).toMatchObject({
      name: 'vm_restart',
      mutating: true,
      destructiveness: 'reversible',
      requiredRole: Role.Full,
    });
  });

  it('takes the id and nothing else, because the method does', () => {
    const schema = vmRestart.inputSchema as {
      properties: Record<string, unknown>;
      required: string[];
    };
    expect(Object.keys(schema.properties)).toEqual(['id']);
    expect(schema.required).toEqual(['id']);
  });

  describe('description', () => {
    it('refuses the reading that a restart is a stop and a start with their defaults', () => {
      // That reading is the one that omits the forced destruction, so it is
      // denied outright rather than merely qualified elsewhere.
      expect(vmRestart.description).toContain(
        'A RESTART IS NOT A `vm_stop` FOLLOWED BY A `vm_start` WITH THEIR DEFAULTS',
      );
    });

    it('states both hidden decisions and that neither is the caller\'s', () => {
      expect(vmRestart.description).toContain('THE STOP HALF FORCES AFTER THE TIMEOUT');
      expect(vmRestart.description).toContain('IS DESTROYED and loses whatever it had not written');
      expect(vmRestart.description).toContain('THE START HALF OVERCOMMITS MEMORY');
      expect(vmRestart.description).toContain('this call gives you no way to make');
    });

    it('says the account is read from the implementation and is not checkable here', () => {
      // #120: an effect established somewhere this repository cannot check is
      // stated AS THAT, never settled.
      expect(vmRestart.description).toContain('NEITHER OF THOSE IS ON THIS API SURFACE');
      expect(vmRestart.description).toContain('NOT SOMETHING THIS CATALOG CAN CHECK');
    });

    it('marks the already-stopped case unconfirmed rather than writing a no-op sentence', () => {
      expect(vmRestart.description).toContain(
        'WHAT A RESTART DOES TO A VM THAT IS ALREADY STOPPED IS (unconfirmed) HERE',
      );
      // And says outright what it does NOT do about it, since a plan that
      // neither refuses nor promises is easy to read as one that checked.
      expect(vmRestart.description).toContain('The plan does not refuse an already-stopped VM');
    });

    it('says a changed: false across a restart is the ordinary successful answer', () => {
      // Side-by-side fields are what an implied relationship looks like from the
      // outside, and here the implication would be "nothing happened".
      expect(vmRestart.description).toContain(
        'A `changed: false` ACROSS A RESTART IS THE ORDINARY ANSWER FOR A SUCCESSFUL ONE',
      );
      expect(vmRestart.description).toContain(
        'NOT A STATEMENT ABOUT WHETHER THE MACHINE WAS RESTARTED',
      );
    });

    it('says a resulting STOPPED is not separable from a machine part-way through', () => {
      expect(vmRestart.description).toContain('THIS TOOL DOES NOT SEPARATE THE TWO');
    });
  });

  describe('normalizeArgs', () => {
    it('drops the executor arguments and keeps the id', () => {
      expect(vmRestart.normalizeArgs?.({ id: 4, systems: 'all' })).toEqual({ id: 4 });
    });

    it.each([{}, { id: '4' }, { id: 4.5 }])('refuses an id it cannot read: %o', (args) => {
      expect(() => vmRestart.normalizeArgs?.(args)).toThrow('"id" is required');
    });
  });

  describe('plan', () => {
    it('names the read and the mutation, in the order execute makes them', async () => {
      const steps = await planSteps(jobSystem().ctx);
      expect(steps.map((step) => step.method)).toEqual(['vm.query', 'vm.restart']);
      expect(steps[1].params).toEqual([4]);
    });

    it("makes every read with the params the plan's read step named", async () => {
      const { ctx, query } = jobSystem();
      const [read] = await planSteps(ctx);
      await vmRestart.execute(ctx, { id: 4 });
      expect(query.mock.calls).toEqual([
        ['vm.query', ...(read.params as unknown[])],
        ['vm.query', ...(read.params as unknown[])],
        ['vm.query', ...(read.params as unknown[])],
      ]);
    });

    it('fails naming the id where no machine has it', async () => {
      const { ctx } = jobSystem({ reads: [{ rows: [] }] });
      await expect(vmRestart.plan(ctx, { id: 4 })).rejects.toThrow(
        'No virtual machine with id 4 on the `vm` stack',
      );
    });

    it('checks the id on the response rather than acting on the first row', async () => {
      const { ctx } = jobSystem({ reads: [{ rows: [vm({ id: 9 })] }] });
      await expect(vmRestart.plan(ctx, { id: 4 })).rejects.toThrow('No virtual machine with id 4');
    });

    it('names the machine and the state it read', async () => {
      const text = await planText();
      expect(text).toContain('Restart the virtual machine "builder" (id 4)');
      expect(text).toContain('Its state read as `RUNNING`');
    });

    it('states both hidden decisions in the plan, not only in the description', async () => {
      // A person approving reads the plan and may never read the description,
      // so the account has to be in both — and it is one text so that no later
      // edit can keep half of it.
      const text = await planText();
      expect(text).toContain('FIRST, THE STOP HALF FORCES AFTER THE TIMEOUT');
      expect(text).toContain('SECOND, THE START HALF OVERCOMMITS');
      expect(text).toContain('IS DESTROYED, losing whatever it had not written to disk');
    });

    it('says the plan does not read as stop-then-start', async () => {
      expect(await planText()).toContain(
        'A RESTART IS NOT A `vm_stop` FOLLOWED BY A `vm_start` WITH THEIR DEFAULTS',
      );
    });

    it('says a failed stop half leaves the machine stopped', async () => {
      expect(await planText()).toContain(
        'If the stop half fails the start half does not run, so a failed restart can leave the VM stopped',
      );
    });

    it('says the account is not on the API surface', async () => {
      expect(await planText()).toContain('NONE OF THAT IS ON THIS API');
    });

    it('does not write an already-in-target-state sentence for a stopped machine', async () => {
      // The one thing a plan must not do here: `restart_vm`'s behaviour against
      // an inactive domain was not established, and a reassuring guess about it
      // is the costly direction to be wrong in.
      const text = await planText([vm({ status: { state: 'STOPPED' } })]);
      expect(text).toContain('Its state read as `STOPPED`');
      // No claim about what an already-stopped machine does, in either
      // direction. `changes nothing` alone would match the watch sentence's
      // account of `core.get_jobs`, which is about the READ and not about this.
      expect(text).not.toMatch(/already/i);
      expect(text).not.toContain('so this changes nothing');
      expect(text).not.toContain('is not an error');
    });

    it('names the watch and says the restart continues past it', async () => {
      expect(await planText()).toContain(
        'for at most 30 seconds. The operation continues after that',
      );
    });

    it('lets a plan-time read failure fail the plan', async () => {
      const { ctx } = jobSystem({ reads: [{ fails: new Error('middleware is down') }] });
      await expect(vmRestart.plan(ctx, { id: 4 })).rejects.toThrow('middleware is down');
    });

    it('rejects arguments it cannot read before making any call', async () => {
      const { ctx, query } = jobSystem();
      await expect(vmRestart.plan(ctx, { id: 'four' })).rejects.toThrow('"id" is required');
      expect(query).not.toHaveBeenCalled();
    });
  });

  describe('execute', () => {
    it('starts the job through the job surface, with the one param the method takes', async () => {
      const { ctx, start, track } = jobSystem();
      await vmRestart.execute(ctx, { id: 4 });
      expect(start).toHaveBeenCalledWith('vm.restart', [4]);
      expect(track).toHaveBeenCalledWith(77);
    });

    it('reports the job, the two readings and the bound that applied', async () => {
      const { ctx } = jobSystem();
      expect(await vmRestart.execute(ctx, { id: 4 })).toEqual({
        vm_id: 4,
        previous_lookup: 'FOUND',
        previous_read_error: null,
        previously_state: 'RUNNING',
        previously_domain_state: 'RUNNING',
        resulting_lookup: 'FOUND',
        resulting_read_error: null,
        resulting_state: 'RUNNING',
        resulting_domain_state: 'RUNNING',
        // The ordinary answer for a restart that worked: the machine was
        // running before and is running again.
        changed: false,
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
      expect(await vmRestart.execute(ctx, { id: 4 })).toMatchObject({ succeeded: true });
    });

    it('reports a failed job from its state, never from a null result', async () => {
      const { ctx } = jobSystem({
        job: of(jobAt('FAILED', { error: 'Failed to stop builder vm' })),
      });
      expect(await vmRestart.execute(ctx, { id: 4 })).toMatchObject({
        ended: true,
        succeeded: false,
        job_state: 'FAILED',
        error: 'Failed to stop builder vm',
      });
    });

    it('reads a terminal state this catalog does not know as ended and not a success', async () => {
      const { ctx } = jobSystem({ job: of(jobAt('SUPERSEDED')) });
      expect(await vmRestart.execute(ctx, { id: 4 })).toMatchObject({
        ended: true,
        succeeded: false,
        job_state: 'SUPERSEDED',
      });
    });

    it('reports no finish time for an ended job that recorded none it can read', async () => {
      const { ctx } = jobSystem({ job: of(jobAt('SUCCESS', { time_finished: 'yesterday' })) });
      expect(await vmRestart.execute(ctx, { id: 4 })).toMatchObject({ finished_at: null });
    });

    it('reports no error text where the job recorded an empty one', async () => {
      const { ctx } = jobSystem({ job: of(jobAt('FAILED', { error: '' })) });
      expect(await vmRestart.execute(ctx, { id: 4 })).toMatchObject({ error: null });
    });

    it('reports a machine part-way through as stopped, without calling the restart failed', async () => {
      // The reading the description refuses to make for the caller: a restart
      // passes THROUGH stopped on its way back up.
      vi.useFakeTimers();
      try {
        const { ctx } = jobSystem({
          reads: [{ rows: [vm()] }, { rows: [vm({ status: { state: 'STOPPED' } })] }],
          job: concat(of(jobAt('RUNNING')), NEVER),
        });
        const pending = vmRestart.execute(ctx, { id: 4 });
        await vi.advanceTimersByTimeAsync(30_000);
        expect(await pending).toMatchObject({
          ended: false,
          succeeded: null,
          resulting_state: 'STOPPED',
          changed: true,
        });
      } finally {
        vi.useRealTimers();
      }
    });

    it('establishes nothing from a job it never saw, and does not call that a failure', async () => {
      const { ctx, track } = jobSystem({ started: EMPTY });
      expect(await vmRestart.execute(ctx, { id: 4 })).toMatchObject({
        job_id: null,
        ended: false,
        succeeded: null,
        job_state: null,
      });
      expect(track).not.toHaveBeenCalled();
    });

    it('keeps the id of a job the client named and then reported nothing about', async () => {
      const { ctx } = jobSystem({ job: EMPTY });
      expect(await vmRestart.execute(ctx, { id: 4 })).toMatchObject({
        job_id: 77,
        ended: false,
        job_state: null,
      });
    });

    it('establishes nothing from an emission carrying no readable state', async () => {
      const { ctx } = jobSystem({ job: of(jobAt('SUCCESS', { state: 42 })) });
      expect(await vmRestart.execute(ctx, { id: 4 })).toMatchObject({
        ended: false,
        succeeded: null,
        job_state: null,
      });
    });

    it('reports no job id where the event carried none this tool can read', async () => {
      const { ctx } = jobSystem({ started: of('seventy-seven' as unknown as number) });
      expect(await vmRestart.execute(ctx, { id: 4 })).toMatchObject({
        job_id: null,
        succeeded: true,
      });
    });

    it('lets a rejected call fail, since there is then no restart to report on', async () => {
      const { ctx } = jobSystem({ started: throwError(() => new Error('not authorised')) });
      await expect(vmRestart.execute(ctx, { id: 4 })).rejects.toThrow('not authorised');
    });

    it('does not fail the call when the FOLLOW-UP READ fails before reporting anything', async () => {
      const { ctx } = jobSystem({ job: throwError(() => new Error('core.get_jobs failed')) });
      expect(await vmRestart.execute(ctx, { id: 4 })).toMatchObject({
        job_id: 77,
        ended: false,
        job_state: null,
      });
    });

    it('keeps the job id when following the job fails after it has been seen', async () => {
      const { ctx } = jobSystem({
        job: concat(of(jobAt('RUNNING')), throwError(() => new Error('connection dropped'))),
      });
      expect(await vmRestart.execute(ctx, { id: 4 })).toMatchObject({
        job_id: 77,
        ended: false,
        job_state: 'RUNNING',
      });
    });

    it('does not report a job as ended because following it stopped', async () => {
      const { ctx } = jobSystem({
        job: concat(of(jobAt('SUCCESS')), throwError(() => new Error('connection dropped'))),
      });
      expect(await vmRestart.execute(ctx, { id: 4 })).toMatchObject({
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
      expect(await vmRestart.execute(ctx, { id: 4 })).toMatchObject({
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
      expect(await vmRestart.execute(ctx, { id: 4 })).toMatchObject({
        resulting_lookup: 'UNREADABLE',
        resulting_read_error: 'connection dropped',
        changed: null,
        ended: true,
      });
    });

    it('reports a read that completed and listed no such machine as NOT_FOUND', async () => {
      const { ctx } = jobSystem({ reads: [{ rows: [] }] });
      expect(await vmRestart.execute(ctx, { id: 4 })).toMatchObject({
        previous_lookup: 'NOT_FOUND',
        resulting_lookup: 'NOT_FOUND',
        changed: null,
      });
    });

    it('rejects arguments it cannot read before making any call', async () => {
      const { ctx, start } = jobSystem();
      await expect(vmRestart.execute(ctx, { id: 'four' })).rejects.toThrow('"id" is required');
      expect(start).not.toHaveBeenCalled();
    });
  });
});
