import { describe, expect, it, vi } from 'vitest';
import { of, throwError } from 'rxjs';
import { Role } from '@/interfaces';
import type { PlanStep, SystemHandle, ToolContext } from '@/catalog/tool';
import { vmClone } from '@/tools/index';

/**
 * `vm_clone`'s tests live here rather than in `vms.spec.ts` under the #87 split
 * trigger, measured rather than felt: `vms.spec.ts` is 840 lines and this block
 * is 671, so the merged file comes to 1,511 and crosses 1,500 as it did at #121
 * and when the three power tools arrived. They were written in `vms.spec.ts`
 * first, on an estimate of the block's size that came in 11 lines under the
 * trigger — the number is what decides and it was re-checked once the block was
 * written. The three listing tools stay in `vms.spec.ts`; re-homing tests this
 * ticket did not touch is a separate change.
 *
 * The fake system is local to this file, as `vm-start.spec.ts`'s is:
 * `src/testing/fake-systems.ts` stubs `query` off one method→response map, and
 * most of what is tested here is two reads of `vm.query` answering DIFFERENTLY —
 * before the clone and after it — which one map cannot express.
 */
describe('vm_clone', () => {
  /** A libvirt-backed VM as `vm.query` answers with one. */
  const vm = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: 4,
    name: 'builder',
    status: { state: 'STOPPED', domain_state: 'SHUTOFF' },
    vcpus: 1,
    cores: 2,
    threads: 1,
    memory: 4096,
    min_memory: null,
    autostart: true,
    ...over,
  });

  /** A device row as `vm.device.query` answers with one. */
  const device = (
    dtype: string,
    attributes: Record<string, unknown>,
    over: Record<string, unknown> = {},
  ): Record<string, unknown> => ({ id: 11, vm: 4, order: 1001, attributes: { dtype, ...attributes }, ...over });

  /** A zvol-backed disk of a given declared size. */
  const zvol = (zvol_name: string, zvol_volsize: unknown): Record<string, unknown> =>
    device('DISK', { zvol_name, zvol_volsize, path: `/dev/zvol/${zvol_name}` });

  /** One answer to a read: the rows it listed, or the failure that stopped it. */
  type Answer = { rows: unknown } | { fails: unknown };

  const emit = (answer: Answer) =>
    'fails' in answer ? throwError(() => answer.fails) : of(answer.rows);

  /**
   * A system answering `vm.query` from a queue, `vm.device.query` once, and
   * `vm.clone` with whatever the test asked for.
   *
   * A queue shorter than the number of reads repeats its last answer, so a test
   * that does not care about the difference between the two listings gives one
   * entry and stops there.
   */
  function cloneSystem(
    options: {
      reads?: Answer[];
      devices?: Answer;
      answer?: unknown;
      callFails?: unknown;
    } = {},
  ): { ctx: ToolContext; query: ReturnType<typeof vi.fn>; call: ReturnType<typeof vi.fn> } {
    const reads = options.reads ?? [{ rows: [vm()] }];
    let index = 0;
    const query = vi.fn((method: string) => {
      if (method === 'vm.device.query') return emit(options.devices ?? { rows: [] });
      const read = reads[Math.min(index, reads.length - 1)];
      index += 1;
      return emit(read);
    });
    const call = vi.fn(() =>
      'callFails' in options
        ? throwError(() => options.callFails)
        : of('answer' in options ? options.answer : true),
    );
    const system = { name: 'nas', client: { api: { query, call } } } as unknown as SystemHandle;
    return { ctx: { system }, query, call };
  }

  /** The two steps the plan returns, typed. */
  const planSteps = async (
    ctx: ToolContext,
    args: Record<string, unknown> = { id: 4 },
  ): Promise<PlanStep[]> => {
    const steps = await vmClone.plan(ctx, args);
    expect(steps).toHaveLength(2);
    return steps;
  };

  /** The mutation step's description, which is what most of the plan tests read. */
  const planText = async (
    options: Parameters<typeof cloneSystem>[0] = {},
    args: Record<string, unknown> = { id: 4 },
  ): Promise<string> => (await planSteps(cloneSystem(options).ctx, args))[1].description;

  /** One `execute` result. */
  const run = async (
    options: Parameters<typeof cloneSystem>[0] = {},
    args: Record<string, unknown> = { id: 4 },
  ): Promise<Record<string, unknown>> =>
    (await vmClone.execute(cloneSystem(options).ctx, args)) as Record<string, unknown>;

  it('is a reversible mutating tool needing the full role', () => {
    expect(vmClone).toMatchObject({
      name: 'vm_clone',
      mutating: true,
      // It adds a machine and destroys nothing, which is the easy case for the
      // field — and the value must not be read as "this catalog can undo it",
      // which is what the description assertion below pins.
      destructiveness: 'reversible',
      requiredRole: Role.Full,
    });
  });

  it('takes the id and an optional name, and nothing else', () => {
    const schema = vmClone.inputSchema as {
      properties: Record<string, unknown>;
      required: string[];
    };
    expect(Object.keys(schema.properties)).toEqual(['id', 'name']);
    expect(schema.required).toEqual(['id']);
  });

  describe('description', () => {
    it('says nothing in this catalog deletes the clone', () => {
      // #153's trap: `reversible` beside an operation that plainly removes
      // nothing invites the reading "undoing this is easy", and undoing a clone
      // means deleting a VM and its zvols, which no tool here does.
      expect(vmClone.description).toContain(
        'NOTHING IN THIS CATALOG DELETES THE CLONE, OR ITS ZVOLS, OR THE SOURCE MACHINE',
      );
      expect(vmClone.description).toContain('can undo it');
    });

    it('says the zvols behind the disks are copied and the pool pays for them', () => {
      expect(vmClone.description).toContain('ZVOLS OF ITS OWN BEHIND ITS DISKS');
      expect(vmClone.description).toContain('CONSUMES POOL SPACE');
    });

    it('says that account is read from the implementation and is not checkable here', () => {
      expect(vmClone.description).toContain(
        'ARE READ FROM THE TRUENAS IMPLEMENTATION AND ARE NOT SOMETHING THIS CATALOG CAN CHECK',
      );
    });

    it('marks the derived name unconfirmed rather than stating a rule it did not read', () => {
      expect(vmClone.description).toContain('WHAT IT DERIVES IS (unconfirmed) HERE');
    });

    it('says the clone is identified by re-reading and not by the boolean', () => {
      expect(vmClone.description).toContain(
        'THE RESULT IDENTIFIES THE CLONE BY RE-READING AND NOT BY TRUSTING THE ANSWER',
      );
      expect(vmClone.description).toContain('IT IS NOT WHERE ANY OF THE ABOVE COMES FROM');
    });

    it('says an empty new_vm_ids is not proof the clone was not made', () => {
      // The reading that costs data here is the opposite one — "no new machine,
      // so nothing happened" — on a call that has already run.
      expect(vmClone.description).toContain('NOT proof the clone was not made');
    });
  });

  describe('normalizeArgs', () => {
    it('drops the executor arguments and carries no name as an explicit null', () => {
      expect(vmClone.normalizeArgs?.({ id: 4, systems: 'all' })).toEqual({ id: 4, name: null });
    });

    it('keeps a name the caller asked for', () => {
      expect(vmClone.normalizeArgs?.({ id: 4, name: 'builder-copy' })).toEqual({
        id: 4,
        name: 'builder-copy',
      });
    });

    it.each([{}, { id: '4' }, { id: 4.5 }])('refuses an id it cannot read: %o', (args) => {
      expect(() => vmClone.normalizeArgs?.(args)).toThrow('"id" is required');
    });

    it('names the other stack in that refusal, which is the mistake it catches', () => {
      expect(() => vmClone.normalizeArgs?.({ id: 'incus-vm' })).toThrow('`virt_instance`');
    });

    it.each([{ id: 4, name: 7 }, { id: 4, name: '' }])(
      'refuses a name it cannot read rather than coercing it: %o',
      (args) => {
        expect(() => vmClone.normalizeArgs?.(args)).toThrow('"name" must be a non-empty string');
      },
    );
  });

  describe('plan', () => {
    it('names the read and the mutation, in the order execute makes them', async () => {
      const steps = await planSteps(cloneSystem().ctx);
      expect(steps.map((step) => step.method)).toEqual(['vm.query', 'vm.clone']);
      expect(steps[1].params).toEqual([4, null]);
    });

    it('sends the name the caller chose as the second positional argument', async () => {
      const steps = await planSteps(cloneSystem().ctx, { id: 4, name: 'builder-copy' });
      expect(steps[1].params).toEqual([4, 'builder-copy']);
    });

    it('says the read changes nothing, runs again, and is what identifies the clone', async () => {
      const [read] = await planSteps(cloneSystem().ctx);
      expect(read.description).toContain('Changes nothing');
      expect(read.description).toContain('THIS SAME READ IS MADE AGAIN IMMEDIATELY AFTER THE CALL');
      expect(read.description).toContain(
        'THE CLONE IS IDENTIFIED AS THE MACHINE THE SECOND LISTING NAMES AND THE FIRST DID NOT',
      );
    });

    it("makes every listing read with the params the plan's read step named", async () => {
      // Each half is asserted against its own literal rather than the step's
      // params being spread into the expected JS arguments: the step names the
      // two positional params the call reaches the middleware with, where the JS
      // call passes the filter and the options, so a spread would compare the
      // step against itself.
      const { ctx, query } = cloneSystem();
      const [read] = await planSteps(ctx);
      await vmClone.execute(ctx, { id: 4 });
      expect(read.params).toEqual([[], { select: ['id', 'name'] }]);
      expect(query.mock.calls.filter(([method]) => method === 'vm.query').slice(1)).toEqual([
        ['vm.query', [], { select: ['id', 'name'] }],
        ['vm.query', [], { select: ['id', 'name'] }],
      ]);
    });

    it('names the machine and says it is read and copied rather than changed', async () => {
      const text = await planText();
      expect(text).toContain('Clone the virtual machine "builder" (id 4)');
      expect(text).toContain('READ AND COPIED AND NOT CHANGED');
      expect(text).toContain('Its state read as `STOPPED`');
    });

    it('fails naming the id where no machine has it', async () => {
      await expect(vmClone.plan(cloneSystem({ reads: [{ rows: [] }] }).ctx, { id: 4 })).rejects.toThrow(
        'No virtual machine with id 4 on the `vm` stack',
      );
    });

    it('checks the id on the response rather than acting on the first row', async () => {
      // An unrecognised query parameter is dropped rather than refused, so a
      // filter that did not apply comes back as the whole table.
      const { ctx } = cloneSystem({ reads: [{ rows: [vm({ id: 9, name: 'other' })] }] });
      await expect(vmClone.plan(ctx, { id: 4 })).rejects.toThrow('No virtual machine with id 4');
    });

    it('lets a plan-time state read failure fail the plan', async () => {
      const { ctx } = cloneSystem({ reads: [{ fails: new Error('middleware is down') }] });
      await expect(vmClone.plan(ctx, { id: 4 })).rejects.toThrow('middleware is down');
    });

    it('states what a clone copies, and that none of it is on this API', async () => {
      const text = await planText();
      expect(text).toContain('A CLONE IS NOT ONLY A COPY OF THE CONFIGURATION');
      expect(text).toContain('THE ZVOLS BEHIND ITS DISK DEVICES');
      expect(text).toContain('read from the TrueNAS implementation');
    });

    it('says outright that nothing here deletes the machine it makes', async () => {
      expect(await planText()).toContain(
        'NOTHING IN THIS CATALOG DELETES THE MACHINE THIS MAKES, OR THE ZVOLS BEHIND ITS DISKS',
      );
    });

    describe('the space the copy will occupy', () => {
      it('names each disk and what they come to', async () => {
        const text = await planText({
          devices: { rows: [zvol('tank/builder-0', 20), zvol('tank/builder-1', 30)] },
        });
        expect(text).toContain('tank/builder-0 (`zvol_volsize` 20)');
        expect(text).toContain('tank/builder-1 (`zvol_volsize` 30)');
        expect(text).toContain('Together they come to 50.');
      });

      it('does not call a DISK zvol-backed where the system named no zvol for it', async () => {
        // A `DISK` can be a host block device attached to the machine, which
        // this API declares the same way — `zvol_name` and `zvol_volsize` are
        // both optional. Calling every one of them zvol-backed is a description
        // promising more than the read delivers.
        const text = await planText({
          devices: {
            rows: [device('DISK', { path: '/dev/disk/by-id/wwn-0x5000c500', zvol_name: null })],
          },
        });
        expect(text).toContain('/dev/disk/by-id/wwn-0x5000c500');
        expect(text).toContain('AND IT NAMED NO ZVOL');
        expect(text).toContain('a `DISK` device NEED NOT BE ZVOL-BACKED');
        expect(text).toContain('WHETHER A CLONE COPIES ANYTHING FOR ONE IS (unconfirmed) HERE');
        expect(text).not.toContain('zvol-backed `DISK` device for it');
      });

      it('adds no such caveat where every disk named its zvol', async () => {
        const text = await planText({ devices: { rows: [zvol('tank/builder-0', 20)] } });
        expect(text).not.toContain('AND IT NAMED NO ZVOL');
        expect(text).not.toContain('NEED NOT BE ZVOL-BACKED');
      });

      it('asserts no unit for those numbers', async () => {
        // `vm_devices` reports `zvol_volsize` unsuffixed on the same ground: the
        // API declares a bare number and a suffix would be a claim (#96).
        expect(await planText({ devices: { rows: [zvol('tank/builder-0', 20)] } })).toContain(
          'THE API DECLARES NO UNIT FOR THOSE NUMBERS',
        );
      });

      it('refuses a total where one disk reported no size it could read', async () => {
        // A total over the rest would understate what the copy can come to
        // occupy, which is the reassuring direction to be wrong in.
        const text = await planText({
          devices: { rows: [zvol('tank/builder-0', 20), zvol('tank/builder-1', null)] },
        });
        expect(text).toContain('THEY DO NOT ADD UP TO A TOTAL HERE');
        expect(text).toContain('this system reported no `zvol_volsize` this tool could read');
        expect(text).not.toContain('Together they come to');
      });

      it('says whether the space is taken at once is unconfirmed', async () => {
        expect(await planText({ devices: { rows: [zvol('tank/builder-0', 20)] } })).toContain(
          'WHETHER THE COPY TAKES THAT SPACE AT ONCE OR TAKES IT AS IT DIVERGES FROM THE SOURCE ' +
            'IS (unconfirmed) HERE',
        );
      });

      it('names a raw file-backed disk separately and does not count it', async () => {
        const text = await planText({
          devices: {
            rows: [zvol('tank/builder-0', 20), device('RAW', { path: '/mnt/tank/disk.img', size: 99 })],
          },
        });
        expect(text).toContain('Together they come to 20.');
        expect(text).toContain('/mnt/tank/disk.img (`size` 99)');
        expect(text).toContain('WHAT A CLONE DOES WITH ONE IS (unconfirmed) HERE');
        expect(text).toContain('its size is NOT counted above');
      });

      it('says no zvol is expected where every disk it has is file-backed', async () => {
        // The RAW caveat alone would leave a reader inferring a zvol they were
        // never told about; "no zvol of its own is expected to be copied" is the
        // half that says what the pool is NOT being asked for.
        const text = await planText({
          devices: { rows: [device('RAW', { path: '/mnt/tank/disk.img', size: 99 })] },
        });
        expect(text).toContain('The system listed no `DISK` device');
        expect(text).toContain('/mnt/tank/disk.img (`size` 99)');
        expect(text).toContain('WHAT A CLONE DOES WITH ONE IS (unconfirmed) HERE');
      });

      it('names a raw disk the system gave no path for', async () => {
        expect(await planText({ devices: { rows: [device('RAW', { size: 99 })] } })).toContain(
          '(the system named no zvol or path for it) (`size` 99)',
        );
      });

      it('will not read a device row that is not a record as a machine with no disks', async () => {
        // The row answers no `vm` and no `dtype`, so it is a device that could
        // not be read rather than one ruled out.
        expect(await planText({ devices: { rows: [7] } })).toContain(
          'NEITHER BE READ AS ONE NOR RULED OUT AS ONE',
        );
      });

      it('says a raw disk reported no size it could read rather than leaving it out', async () => {
        expect(
          await planText({ devices: { rows: [device('RAW', { path: '/mnt/tank/disk.img' })] } }),
        ).toContain('/mnt/tank/disk.img (this system reported no `size` this tool could read)');
      });

      it('says the disks could not be read where the device read failed', async () => {
        // Which is not the same answer as a machine with no disks, and reporting
        // it as one would describe a clone as free that fills a pool.
        const text = await planText({ devices: { fails: new Error('denied') } });
        expect(text).toContain('WHAT THE COPY WILL OCCUPY IS NOT ESTABLISHED HERE');
        expect(text).toContain('denied');
        expect(text).toContain('not the same answer as a machine with no disks');
      });

      it('says the same where the device read answered something other than a list', async () => {
        expect(await planText({ devices: { rows: 3 } })).toContain(
          'the system answered with something other than a list of devices',
        );
      });

      it('does not let a failed device read fail the plan', async () => {
        const steps = await planSteps(cloneSystem({ devices: { fails: new Error('denied') } }).ctx);
        expect(steps.map((step) => step.method)).toEqual(['vm.query', 'vm.clone']);
      });

      it('says the system listed no disk device where it listed none', async () => {
        expect(await planText({ devices: { rows: [] } })).toContain(
          'THE SYSTEM LISTED NO DISK DEVICE FOR THIS VIRTUAL MACHINE',
        );
      });

      it('ignores a device row the response attributes to another machine', async () => {
        // The filter is bandwidth; the check on the response is the control, and
        // without it a dropped filter would name another machine's disks here.
        const text = await planText({
          devices: { rows: [zvol('tank/other-0', 99), { ...zvol('tank/builder-0', 20), vm: 9 }] },
        });
        expect(text).toContain('Together they come to 99.');
        expect(text).not.toContain('tank/builder-0');
      });

      it('names a disk the system gave neither a zvol nor a path for', async () => {
        expect(await planText({ devices: { rows: [device('DISK', { zvol_volsize: 20 })] } })).toContain(
          '(the system named no zvol or path for it) (`zvol_volsize` 20, AND IT NAMED NO ZVOL)',
        );
      });

      it('rules out a device kind this API declares with no zvol in it', async () => {
        // Ruled out rather than unread: none of the five declares a zvol field,
        // which is checkable against the client rather than assumed.
        const text = await planText({ devices: { rows: [device('NIC', { mac: 'aa:bb' })] } });
        expect(text).toContain('THE SYSTEM LISTED NO DISK DEVICE FOR THIS VIRTUAL MACHINE');
        expect(text).not.toContain('FLOOR');
      });

      it.each([
        ['an unmapped disk kind', device('ISCSI_DISK', { iscsi_target: 'tgt' })],
        ['a configuration that was not a record', { id: 11, vm: 4, attributes: 'nope' }],
        ['a row the system attributed to no machine', { ...device('DISK', {}), vm: null }],
      ])('will not read %s as a machine with no disks', async (_case, row) => {
        // TrueNAS already defines a disk kind this tool does not map, so a
        // silently shorter list is a clone described as free that fills a pool.
        const text = await planText({ devices: { rows: [row] } });
        expect(text).toContain('WHAT THE COPY WILL OCCUPY IS NOT ESTABLISHED HERE');
        expect(text).toContain('NEITHER BE READ AS ONE NOR RULED OUT AS ONE');
        expect(text).toContain('NOT THE SAME ANSWER AS A MACHINE WITH NO DISKS');
      });

      it('will not claim there is no DISK device beside a device it could not read', async () => {
        // The branch a first fix missed: a RAW device keeps the both-empty
        // branch from running, and the "listed no `DISK` device" claim then sat
        // unguarded beside an `ISCSI_DISK` that may well be a zvol-backed disk.
        const text = await planText({
          devices: {
            rows: [
              device('RAW', { path: '/mnt/tank/disk.img', size: 99 }),
              device('ISCSI_DISK', { iscsi_target: 'tgt' }),
            ],
          },
        });
        expect(text).toContain('WHETHER THIS MACHINE HAS ONE IS NOT ESTABLISHED HERE');
        expect(text).not.toContain('The system listed no `DISK` device');
        expect(text).not.toContain('no zvol of its own is expected to be copied');
      });

      it('still says so plainly where every device it did not read was ruled out', async () => {
        const text = await planText({
          devices: {
            rows: [
              device('RAW', { path: '/mnt/tank/disk.img', size: 99 }),
              device('NIC', { mac: 'aa:bb' }),
            ],
          },
        });
        expect(text).toContain('no zvol of its own is expected to be copied');
        expect(text).not.toContain('NOT ESTABLISHED HERE');
      });

      it('makes a figure beside an unreadable device a floor rather than a total', async () => {
        const text = await planText({
          devices: { rows: [zvol('tank/builder-0', 20), device('ISCSI_DISK', { iscsi_target: 't' })] },
        });
        expect(text).toContain('Together they come to 20.');
        expect(text).toContain('1 device on this machine could be NEITHER READ AS A DISK');
        expect(text).toContain('SO ANY FIGURE ABOVE IS A FLOOR AND NOT A TOTAL');
      });

      it('counts each unreadable device rather than reporting only that there was one', async () => {
        expect(
          await planText({
            devices: {
              rows: [
                zvol('tank/builder-0', 20),
                device('ISCSI_DISK', { iscsi_target: 't' }),
                { ...device('DISK', {}), vm: undefined },
              ],
            },
          }),
        ).toContain('2 devices on this machine');
      });
    });

    describe('the name the clone gets', () => {
      it('names the one the caller chose and does not check it is free', async () => {
        const text = await planText({}, { id: 4, name: 'builder-copy' });
        expect(text).toContain('under the name you gave, "builder-copy"');
        expect(text).toContain('THIS PLAN DOES NOT CHECK whether a virtual machine of that name');
      });

      it('marks the derivation unconfirmed where the caller chose none', async () => {
        const text = await planText();
        expect(text).toContain('NO NAME WAS GIVEN, SO THE MIDDLEWARE DERIVES ONE');
        expect(text).toContain('WHAT IT DERIVES IS (unconfirmed) HERE');
        expect(text).toContain('is NOT predictable from this plan');
      });
    });

    it('marks a running machine unconfirmed rather than refusing or reassuring', async () => {
      // #154's finding: a reassuring guess is the costly direction, and the
      // reverse would refuse a plan the middleware would have accepted.
      const text = await planText({ reads: [{ rows: [vm({ status: { state: 'RUNNING' } })] }] });
      expect(text).toContain('IT READ AS `RUNNING` WHEN THIS PLAN WAS MADE');
      expect(text).toContain('neither refuses such a machine nor promises the call is accepted');
    });

    it('adds no running sentence to a machine that read as stopped', async () => {
      expect(await planText()).not.toContain('IT READ AS `RUNNING`');
    });
  });

  describe('execute', () => {
    /** A listing answer: the two fields the projection asks for. */
    const listed = (...rows: Record<string, unknown>[]): Answer => ({ rows });

    it('identifies the clone as the id the second listing named and the first did not', async () => {
      const result = await run({
        reads: [
          listed({ id: 4, name: 'builder' }),
          listed({ id: 4, name: 'builder' }, { id: 7, name: 'builder_clone' }),
        ],
      });
      expect(result).toMatchObject({
        clone_id: 7,
        clone_name: 'builder_clone',
        new_vm_ids: [7],
        source_vm_id: 4,
        source_vm_name: 'builder',
        source_lookup: 'FOUND',
        requested_name: null,
        call_result: true,
        previous_read_error: null,
        resulting_read_error: null,
      });
    });

    it('reports the name the caller asked for beside the one it was listed under', async () => {
      const result = await run(
        {
          reads: [
            listed({ id: 4, name: 'builder' }),
            listed({ id: 4, name: 'builder' }, { id: 7, name: 'builder-copy' }),
          ],
        },
        { id: 4, name: 'builder-copy' },
      );
      expect(result).toMatchObject({ requested_name: 'builder-copy', clone_name: 'builder-copy' });
    });

    it('calls vm.clone with the id and an explicit null where no name was given', async () => {
      const { ctx, call } = cloneSystem();
      await vmClone.execute(ctx, { id: 4 });
      expect(call).toHaveBeenCalledWith('vm.clone', [4, null]);
    });

    it('does not take the identification off the boolean the call answered', async () => {
      // A `true` beside a null `clone_id` is the call reporting success and this
      // tool being unable to say what it made — which is the pair the result
      // exists to keep apart.
      const result = await run({ reads: [listed({ id: 4, name: 'builder' })], answer: true });
      expect(result).toMatchObject({ call_result: true, clone_id: null, new_vm_ids: [] });
    });

    it('reports a false answer without inventing a clone', async () => {
      const result = await run({ reads: [listed({ id: 4, name: 'builder' })], answer: false });
      expect(result).toMatchObject({ call_result: false, clone_id: null });
    });

    it('reads the answer through a guard rather than trusting the declared boolean', async () => {
      expect(await run({ answer: 'yes' })).toMatchObject({ call_result: null });
    });

    it('will not guess which machine is the clone where more than one appeared', async () => {
      const result = await run({
        reads: [
          listed({ id: 4, name: 'builder' }),
          listed({ id: 4, name: 'builder' }, { id: 7, name: 'a' }, { id: 8, name: 'b' }),
        ],
      });
      expect(result).toMatchObject({ clone_id: null, clone_name: null, new_vm_ids: [7, 8] });
    });

    it('nulls new_vm_ids where the first listing could not be read, rather than emptying it', async () => {
      // An empty list there would say no machine appeared, which a difference
      // taken against a listing that does not exist has not established.
      const result = await run({
        reads: [{ fails: new Error('denied') }, listed({ id: 7, name: 'c' })],
      });
      expect(result).toMatchObject({
        new_vm_ids: null,
        clone_id: null,
        source_lookup: 'UNREADABLE',
        source_vm_name: null,
        previous_read_error: 'denied',
        resulting_read_error: null,
      });
    });

    it('nulls new_vm_ids where the listing after the call could not be read', async () => {
      const result = await run({
        reads: [listed({ id: 4, name: 'builder' }), { fails: new Error('socket closed') }],
      });
      expect(result).toMatchObject({
        new_vm_ids: null,
        clone_id: null,
        source_lookup: 'FOUND',
        resulting_read_error: 'socket closed',
      });
    });

    it('makes the call even where the first listing failed', async () => {
      // Branching on a read made at execution time is what the confirmation
      // token cannot bind, and a read that failed is not an approval withdrawn.
      const { ctx, call } = cloneSystem({ reads: [{ fails: new Error('denied') }] });
      await vmClone.execute(ctx, { id: 4 });
      expect(call).toHaveBeenCalledTimes(1);
    });

    it('does not report a clone it could not describe as a failed call', async () => {
      const { ctx } = cloneSystem({ reads: [{ fails: new Error('denied') }] });
      await expect(vmClone.execute(ctx, { id: 4 })).resolves.toBeDefined();
    });

    it('says the source was not listed where the first listing did not name it', async () => {
      const result = await run({ reads: [listed({ id: 9, name: 'other' })] });
      expect(result).toMatchObject({ source_lookup: 'NOT_FOUND', source_vm_name: null });
    });

    it('reports a source the system named nothing for as null rather than empty', async () => {
      const result = await run({ reads: [listed({ id: 4, name: '' })] });
      expect(result).toMatchObject({ source_lookup: 'FOUND', source_vm_name: null });
    });

    it('leaves a row whose id it could not read out of both listings', async () => {
      // Such a row cannot be told from any other row missing an id, so it can
      // neither be the clone nor rule one out.
      const result = await run({
        reads: [listed({ id: 4, name: 'builder' }), listed({ id: 4, name: 'builder' }, { name: 'x' })],
      });
      expect(result).toMatchObject({ new_vm_ids: [], clone_id: null });
    });

    it('reports a clone the system named nothing for as a null name, not a missing one', async () => {
      const result = await run({
        reads: [listed({ id: 4, name: 'builder' }), listed({ id: 4, name: 'builder' }, { id: 7 })],
      });
      expect(result).toMatchObject({ clone_id: 7, clone_name: null });
    });

    it('fails the call where the clone itself was rejected', async () => {
      const { ctx } = cloneSystem({ callFails: new Error('name in use') });
      await expect(vmClone.execute(ctx, { id: 4 })).rejects.toThrow('name in use');
    });

    it('reads and clones on the seams a tool picks per verb', async () => {
      // A tool picks `call` or `query` per verb, so checking one alone would let
      // a read through the other go unnoticed.
      const { ctx, query, call } = cloneSystem();
      await vmClone.execute(ctx, { id: 4 });
      expect(query).toHaveBeenCalledTimes(2);
      expect(call).toHaveBeenCalledTimes(1);
    });
  });
});
