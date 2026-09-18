import { describe, expect, it } from 'vitest';
import { vi } from 'vitest';
import { of, throwError } from 'rxjs';
import { Role } from '@/interfaces';
import { PlanStep, SystemHandle, ToolContext } from '@/catalog/tool';
import { vmStart } from '@/tools/index';

/**
 * `vm_start`'s tests live here rather than in `vms.spec.ts` under the #87 split
 * trigger, measured rather than felt: `vms.spec.ts` is 840 lines and the three
 * power tools' blocks come to several hundred each, so the merged file would
 * cross 1,500 as it did at #121 and at `snapshot_task_run`. The three listing
 * tools stay in `vms.spec.ts`; re-homing tests this ticket did not touch is a
 * separate change.
 *
 * The fake system is local to this file, as `cloudsync-run.spec.ts`'s and
 * `snapshot-task-run.spec.ts`'s are: `src/testing/fake-systems.ts` stubs `call`
 * and `query` off one method→response map, and half of what is tested here is
 * two reads of the SAME method answering differently — before the mutation and
 * after it — which one map cannot express.
 */

/** A libvirt-backed VM row as `vm.query` answers with one. */
const vm = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 4,
  name: 'builder',
  status: { state: 'STOPPED', domain_state: 'SHUTOFF' },
  vcpus: 1,
  cores: 2,
  threads: 1,
  memory: 4096,
  min_memory: null,
  autostart: true,
  shutdown_timeout: 90,
  ...extra,
});

/** One answer to a `vm.query` read: the rows it listed, or the failure that stopped it. */
type Read = { rows: unknown[] } | { fails: unknown };

/**
 * A system answering `vm.query` from a queue and `vm.start` with `null`.
 *
 * The queue is what lets one test give `execute` a different answer before the
 * call and after it, which is the whole of what the result's two readings are
 * about. A queue shorter than the number of reads repeats its last answer, so a
 * test that does not care says `[{ rows: [vm()] }]` and stops there.
 */
function vmSystem(options: { reads?: Read[]; callFails?: unknown } = {}): {
  ctx: ToolContext;
  query: ReturnType<typeof vi.fn>;
  call: ReturnType<typeof vi.fn>;
} {
  const reads = options.reads ?? [{ rows: [vm()] }];
  let index = 0;
  const query = vi.fn(() => {
    const read = reads[Math.min(index, reads.length - 1)];
    index += 1;
    return 'fails' in read ? throwError(() => read.fails) : of(read.rows);
  });
  const call = vi.fn(() =>
    'callFails' in options ? throwError(() => options.callFails) : of(null),
  );
  const system = { name: 'nas', client: { api: { query, call } } } as unknown as SystemHandle;
  return { ctx: { system }, query, call };
}

/** The two steps the plan returns, typed. */
const planSteps = async (
  ctx: ToolContext,
  args: Record<string, unknown> = { id: 4 },
): Promise<PlanStep[]> => {
  const steps = await vmStart.plan(ctx, args);
  expect(steps).toHaveLength(2);
  return steps;
};

/** The mutation step's description, which is what most of the plan tests read. */
const planText = async (rows: unknown[], args: Record<string, unknown> = { id: 4 }): Promise<string> =>
  (await planSteps(vmSystem({ reads: [{ rows }] }).ctx, args))[1].description;

describe('vm_start', () => {
  it('is a reversible mutating tool needing the full role', () => {
    expect(vmStart).toMatchObject({
      name: 'vm_start',
      mutating: true,
      // It destroys nothing and its named reversal is in this catalog —
      // `vm_stop` — so there is no account of the data to come apart from the
      // field the way `cloudsync_run`'s does.
      destructiveness: 'reversible',
      requiredRole: Role.Full,
    });
  });

  it('takes the id and an optional overcommit, and nothing else', () => {
    const schema = vmStart.inputSchema as {
      properties: Record<string, unknown>;
      required: string[];
    };
    expect(Object.keys(schema.properties)).toEqual(['id', 'overcommit']);
    expect(schema.required).toEqual(['id']);
  });

  describe('description', () => {
    it('says overcommit oversubscribes memory rather than retrying a failed start', () => {
      expect(vmStart.description).toContain('DOES NOT RETRY A FAILED START');
      expect(vmStart.description).toContain('OVERSUBSCRIBED against the other VMs');
    });

    it('says a suspended VM is refused and that nothing here resumes one', () => {
      // The reading that costs a cycle is "it said the VM is running, so it is
      // running", so both halves are pinned: that the message is wrong, and
      // that the tool which would be right is absent.
      expect(vmStart.description).toContain(
        'WITH A MESSAGE SAYING IT IS ALREADY RUNNING, WHICH IS NOT TRUE',
      );
      expect(vmStart.description).toContain('NOTHING IN THIS CATALOG RESUMES ONE');
    });

    it('says the state checks are plan-time only and are not repeated', () => {
      expect(vmStart.description).toContain('ARE NOT REPEATED at execute time');
    });

    it('keeps changed about the state pair alone, not the domain_state pair', () => {
      expect(vmStart.description).toContain(
        '`changed` IS THE TWO `state` READINGS COMPARED AND NOTHING ELSE',
      );
    });
  });

  describe('normalizeArgs', () => {
    it('drops the executor arguments and defaults overcommit to false', () => {
      expect(vmStart.normalizeArgs?.({ id: 4, systems: 'all' })).toEqual({
        id: 4,
        overcommit: false,
      });
    });

    it('keeps an overcommit the caller asked for', () => {
      expect(vmStart.normalizeArgs?.({ id: 4, overcommit: true })).toEqual({
        id: 4,
        overcommit: true,
      });
    });

    it.each([{}, { id: '4' }, { id: 4.5 }])('refuses an id it cannot read: %o', (args) => {
      expect(() => vmStart.normalizeArgs?.(args)).toThrow('"id" is required');
    });

    it('names the other stack in that refusal, which is the mistake it catches', () => {
      // A `virt_instance` row's id is a string, so a caller holding one reaches
      // exactly this error — and "must be a whole number" alone would not say
      // why the id they are reading off `vms_list` is not one.
      expect(() => vmStart.normalizeArgs?.({ id: 'incus-vm' })).toThrow('`virt_instance`');
    });

    it('refuses an overcommit it cannot read rather than coercing it', () => {
      expect(() => vmStart.normalizeArgs?.({ id: 4, overcommit: 'true' })).toThrow(
        '"overcommit" must be a boolean',
      );
    });
  });

  describe('plan', () => {
    it('names the read and the mutation, in the order execute makes them', async () => {
      const steps = await planSteps(vmSystem().ctx);
      expect(steps.map((step) => step.method)).toEqual(['vm.query', 'vm.start']);
      expect(steps[1].params).toEqual([4, { overcommit: false }]);
    });

    it('says the read changes nothing and runs again after the call', async () => {
      const [read] = await planSteps(vmSystem().ctx);
      expect(read.description).toContain('Changes nothing');
      expect(read.description).toContain('THIS SAME READ IS MADE AGAIN IMMEDIATELY AFTER THE CALL');
    });

    it("makes every read with the params the plan's read step named", async () => {
      // The filter is written twice — inlined in the read because a `const`
      // widens out of the client's filter tuple, and again for this step — so
      // this assertion, and not a shared helper, is what holds the two in step.
      const { ctx, query } = vmSystem();
      const [read] = await planSteps(ctx);
      await vmStart.execute(ctx, { id: 4 });
      expect(query.mock.calls).toEqual([
        ['vm.query', ...(read.params as unknown[])],
        ['vm.query', ...(read.params as unknown[])],
        ['vm.query', ...(read.params as unknown[])],
      ]);
    });

    it('names the machine and the state it read', async () => {
      const text = await planText([vm()]);
      expect(text).toContain('Start the virtual machine "builder" (id 4)');
      expect(text).toContain('Its state read as `STOPPED`');
      expect(text).toContain("libvirt's own `domain_state` `SHUTOFF`");
    });

    it('says so where the machine reported no name, rather than leaving it out', async () => {
      expect(await planText([vm({ name: '' })])).toContain(
        'the virtual machine (the system reported no name) (id 4)',
      );
    });

    it('says so where the machine reported no libvirt state', async () => {
      expect(await planText([vm({ status: { state: 'STOPPED' } })])).toContain(
        'the system reported no libvirt `domain_state` beside it',
      );
    });

    it('fails naming the id where no machine has it', async () => {
      const { ctx } = vmSystem({ reads: [{ rows: [] }] });
      await expect(vmStart.plan(ctx, { id: 4 })).rejects.toThrow(
        'No virtual machine with id 4 on the `vm` stack',
      );
    });

    it('checks the id on the response rather than acting on the first row', async () => {
      // An unrecognised query parameter is dropped rather than refused, so a
      // filter that did not apply comes back as the whole table — and the first
      // row of that is a different machine.
      const { ctx } = vmSystem({ reads: [{ rows: [vm({ id: 9, name: 'other' })] }] });
      await expect(vmStart.plan(ctx, { id: 4 })).rejects.toThrow('No virtual machine with id 4');
    });

    it('fails naming the state where the machine is already running', async () => {
      const { ctx } = vmSystem({ reads: [{ rows: [vm({ status: { state: 'RUNNING' } })] }] });
      await expect(vmStart.plan(ctx, { id: 4 })).rejects.toThrow(
        'is already in state `RUNNING` on this system',
      );
    });

    it('fails a suspended machine, saying what the middleware would claim instead', async () => {
      const { ctx } = vmSystem({ reads: [{ rows: [vm({ status: { state: 'SUSPENDED' } })] }] });
      await expect(vmStart.plan(ctx, { id: 4 })).rejects.toThrow(
        'THE MESSAGE IT REFUSES WITH SAYS THE VM IS ALREADY RUNNING, WHICH IT IS NOT',
      );
    });

    it('names vm.resume as the absent tool for a suspended machine', async () => {
      const { ctx } = vmSystem({ reads: [{ rows: [vm({ status: { state: 'SUSPENDED' } })] }] });
      await expect(vmStart.plan(ctx, { id: 4 })).rejects.toThrow(
        'THERE IS NO TOOL IN THIS CATALOG THAT RESUMES ONE',
      );
    });

    it('does not refuse a machine whose state could not be read, and says so', async () => {
      // An unreadable state is not a state that was read as active, and failing
      // on it would refuse a plan the middleware would have accepted.
      const text = await planText([vm({ status: { state: 42 } })]);
      expect(text).toContain('The state it is in could not be read');
      expect(text).toContain('whether the middleware will accept this call is NOT established');
    });

    it('says the middleware had no reason to refuse a machine that read as stopped', async () => {
      expect(await planText([vm()])).toContain('It was neither running nor suspended');
    });

    it('states what overcommit does to the system rather than to the error', async () => {
      const on = await planText([vm()], { id: 4, overcommit: true });
      expect(on).toContain('OVERCOMMIT IS ON FOR THIS CALL');
      expect(on).toContain('OVERSUBSCRIBED against the rest');
      // And says outright what it is not, since "start it anyway" is exactly
      // what a reader reaches for when a start has just failed.
      expect(on).toContain('not a way of retrying a failed start');
    });

    it('states the memory the middleware checks where overcommit is off', async () => {
      expect(await planText([vm()])).toContain(
        'the middleware starts this VM only where the memory for every VM configured',
      );
    });

    it('lets a plan-time read failure fail the plan', async () => {
      // There is no answer to give: a list that could not be read is not
      // evidence the machine is absent, and an approval must be about a machine
      // that was seen.
      const { ctx } = vmSystem({ reads: [{ fails: new Error('middleware is down') }] });
      await expect(vmStart.plan(ctx, { id: 4 })).rejects.toThrow('middleware is down');
    });

    it('rejects arguments it cannot read before making any call', async () => {
      const { ctx, query } = vmSystem();
      await expect(vmStart.plan(ctx, { id: 'four' })).rejects.toThrow('"id" is required');
      expect(query).not.toHaveBeenCalled();
    });
  });

  describe('execute', () => {
    it('calls vm.start with the params the plan named, and only vm.start', async () => {
      const { ctx, call } = vmSystem();
      await vmStart.execute(ctx, { id: 4 });
      expect(call.mock.calls).toEqual([['vm.start', [4, { overcommit: false }]]]);
    });

    it('sends the options object even where overcommit is false', async () => {
      // A plan whose second argument appeared only sometimes would be showing
      // two different call shapes for one tool.
      const { ctx, call } = vmSystem();
      await vmStart.execute(ctx, { id: 4, overcommit: true });
      expect(call).toHaveBeenCalledWith('vm.start', [4, { overcommit: true }]);
    });

    it('reports both readings, whether they differ, and what was asked for', async () => {
      const { ctx } = vmSystem({
        reads: [
          { rows: [vm()] },
          { rows: [vm({ status: { state: 'RUNNING', domain_state: 'RUNNING' } })] },
        ],
      });
      expect(await vmStart.execute(ctx, { id: 4 })).toEqual({
        vm_id: 4,
        previous_lookup: 'FOUND',
        previous_read_error: null,
        previously_state: 'STOPPED',
        previously_domain_state: 'SHUTOFF',
        resulting_lookup: 'FOUND',
        resulting_read_error: null,
        resulting_state: 'RUNNING',
        resulting_domain_state: 'RUNNING',
        changed: true,
        requested_overcommit: false,
      });
    });

    it('compares the state pair alone and not the domain_state pair', async () => {
      // A machine whose `state` did not move reports `changed: false` however
      // its `domain_state` read — the two are different vocabularies and only
      // one of them is being compared.
      const { ctx } = vmSystem({
        reads: [
          { rows: [vm({ status: { state: 'STOPPED', domain_state: 'SHUTOFF' } })] },
          { rows: [vm({ status: { state: 'STOPPED', domain_state: 'CRASHED' } })] },
        ],
      });
      expect(await vmStart.execute(ctx, { id: 4 })).toMatchObject({
        changed: false,
        previously_domain_state: 'SHUTOFF',
        resulting_domain_state: 'CRASHED',
      });
    });

    it('makes the call even where the machine already reads as running', async () => {
      // The plan refuses that; `execute` does not re-check it. Branching on
      // state read at execution time is what the confirmation token cannot bind.
      const { ctx, call } = vmSystem({ reads: [{ rows: [vm({ status: { state: 'RUNNING' } })] }] });
      await vmStart.execute(ctx, { id: 4 });
      expect(call).toHaveBeenCalledTimes(1);
    });

    it('makes the call where the read before it failed, and reports why', async () => {
      const { ctx, call } = vmSystem({
        reads: [{ fails: new Error('read refused') }, { rows: [vm()] }],
      });
      expect(await vmStart.execute(ctx, { id: 4 })).toMatchObject({
        previous_lookup: 'UNREADABLE',
        previous_read_error: 'read refused',
        previously_state: null,
        changed: null,
      });
      expect(call).toHaveBeenCalledTimes(1);
    });

    it('does not fail the tool when the read AFTER the call fails', async () => {
      // The mutation has landed by then, so reporting it as a failed call would
      // be the one answer that is certainly wrong.
      const { ctx } = vmSystem({
        reads: [{ rows: [vm()] }, { fails: new Error('connection dropped') }],
      });
      expect(await vmStart.execute(ctx, { id: 4 })).toMatchObject({
        resulting_lookup: 'UNREADABLE',
        resulting_read_error: 'connection dropped',
        resulting_state: null,
        changed: null,
      });
    });

    it('reports a read that completed and listed no such machine as NOT_FOUND', async () => {
      const { ctx } = vmSystem({ reads: [{ rows: [] }] });
      expect(await vmStart.execute(ctx, { id: 4 })).toMatchObject({
        previous_lookup: 'NOT_FOUND',
        previous_read_error: null,
        previously_state: null,
        resulting_lookup: 'NOT_FOUND',
        changed: null,
      });
    });

    it('reports FOUND beside a null state where the machine named no state', async () => {
      // The fourth case the three lookup words do not separate.
      const { ctx } = vmSystem({ reads: [{ rows: [vm({ status: {} })] }] });
      expect(await vmStart.execute(ctx, { id: 4 })).toMatchObject({
        previous_lookup: 'FOUND',
        previously_state: null,
        changed: null,
      });
    });

    it('lets a rejected call fail, since the machine was not started', async () => {
      const { ctx } = vmSystem({ callFails: new Error('not authorised') });
      await expect(vmStart.execute(ctx, { id: 4 })).rejects.toThrow('not authorised');
    });

    it('rejects arguments it cannot read before making any call', async () => {
      const { ctx, call } = vmSystem();
      await expect(vmStart.execute(ctx, { id: 'four' })).rejects.toThrow('"id" is required');
      expect(call).not.toHaveBeenCalled();
    });
  });
});
