import { describe, expect, it } from 'vitest';
import { Role } from '@/interfaces';
import { fakeSystem, failingSystem } from '@/testing/fake-systems';
import { nvmeofSubsystemUpdate } from '@/tools/index';

/**
 * `nvmeof_subsystem_update`'s tests live here rather than in `block.spec.ts`,
 * for the #87 reason `iscsi-target-create.spec.ts` gives. The split is by tool.
 */

/** The subsystem being changed, as `nvmet.subsys.query` lists it. */
const subsystem = {
  id: 3,
  name: 'vmstore',
  subnqn: 'nqn.2011-06.com.truenas:uuid:abc:vmstore',
  serial: 'f00dcafe',
  allow_any_host: false,
  qid_max: 128,
};

/** Another subsystem on the same system. */
const other = { id: 4, name: 'backup' };

/** A system listing those rows, and answering the update with `updated`. */
const system = (updated: unknown = { ...subsystem, allow_any_host: true }, rows: unknown = [subsystem, other]) =>
  fakeSystem({ 'nvmet.subsys.query': rows, 'nvmet.subsys.update': updated });

const args = { id: 3, allow_any_host: true };

const updateText = async (input: Record<string, unknown>, sys = system()) => {
  const [, update] = await nvmeofSubsystemUpdate.plan(sys.ctx, input);
  return update.description;
};

describe('nvmeof_subsystem_update', () => {
  it('is a reversible mutating tool needing the sharing role', () => {
    expect(nvmeofSubsystemUpdate).toMatchObject({
      name: 'nvmeof_subsystem_update',
      mutating: true,
      destructiveness: 'reversible',
      requiredRole: Role.Sharing,
    });
  });

  it('requires the id, and its schema has none of the tuning fields', () => {
    const schema = nvmeofSubsystemUpdate.inputSchema as { properties: Record<string, unknown>; required: string[] };
    expect(schema.required).toEqual(['id']);
    expect(Object.keys(schema.properties)).toEqual(['id', 'name', 'subnqn', 'allow_any_host']);
  });

  it('says the id is a subsystem’s, that a new NQN strands hosts, and how to read changed', () => {
    const description = nvmeofSubsystemUpdate.description;
    expect(description).toContain('PLANNING AGAINST AN id NO NVMe-oF SUBSYSTEM HAS FAILS');
    expect(description).toContain('CHANGING `subnqn` CHANGES WHAT HOSTS CONNECT TO');
    expect(description).toContain('`changed` must not be read without it');
  });

  it('normalizes args: keeps the id and the settings passed, in schema order, drops unknown keys', () => {
    expect(nvmeofSubsystemUpdate.normalizeArgs?.({ allow_any_host: false, id: 3, name: 'x', systems: 'all' })).toEqual({
      id: 3,
      name: 'x',
      allow_any_host: false,
    });
  });

  describe('argument validation', () => {
    const reject = (bad: Record<string, unknown>, message: RegExp) =>
      expect(() => nvmeofSubsystemUpdate.normalizeArgs?.(bad)).toThrow(message);

    it('requires a whole-number id', () => {
      for (const id of [undefined, null, '3', 3.5]) {
        reject({ ...args, id }, /"id" is required and must be a whole number/);
      }
    });

    it('requires something to change', () => {
      reject({ id: 3 }, /Nothing to change: pass at least one of name, subnqn, allow_any_host/);
    });

    it('refuses the tuning fields and validates each setting the way the create does', () => {
      reject({ id: 3, qid_max: 4 }, /"qid_max" is not accepted by this tool/);
      reject({ id: 3, name: '' }, /"name" must be a non-empty string/);
      reject({ id: 3, subnqn: null }, /"subnqn" must be a non-empty string/);
    });
  });

  describe('the plan it returns', () => {
    it('plans the read it makes and the update, sending only the fields passed', async () => {
      const steps = await nvmeofSubsystemUpdate.plan(system().ctx, args);
      expect(steps.map((step) => step.method)).toEqual(['nvmet.subsys.query', 'nvmet.subsys.update']);
      expect(steps[0]).toMatchObject({ params: [[['id', '=', 3]], {}] });
      expect(steps[0].description).toMatch(/Read this system's NVMe-oF subsystem with id 3/);
      expect(steps[1].params).toEqual([3, { allow_any_host: true }]);
    });

    it('names the subsystem and states each value beside the one it holds now', async () => {
      expect(await updateText({ id: 3, name: 'vms', allow_any_host: true })).toContain(
        'Change the NVMe-oF subsystem named "vmstore" (id 3): name "vms" (now "vmstore"); ' +
          'allow_any_host true (now false). Only these fields are sent.',
      );
      const unread = await updateText(args, system(undefined, [{ id: 3, allow_any_host: 'x' }]));
      expect(unread).toContain('named (the system reported none) (id 3): allow_any_host true (now (the system reported none))');
    });

    it('fails on an id no subsystem has, comparing ids on the response', async () => {
      await expect(nvmeofSubsystemUpdate.plan(system(undefined, [other]).ctx, args)).rejects.toThrow(
        /No NVMe-oF subsystem with id 3 on this system — ids come from `nvmeof_list`/,
      );
      await expect(nvmeofSubsystemUpdate.plan(system(undefined, 'nope').ctx, args)).rejects.toThrow(/No NVMe-oF subsystem with id 3/);
    });

    it('fails where the system has no NVMe-oF, and raises any other failed read', async () => {
      const missing = failingSystem({}, { 'nvmet.subsys.query': { code: -32601, message: 'Method not found' } });
      await expect(nvmeofSubsystemUpdate.plan(missing.ctx, args)).rejects.toThrow(
        /NVMe-oF is not supported on this system: it has no nvmet.subsys methods \(Method not found\)/,
      );
      const denied = failingSystem({}, { 'nvmet.subsys.query': new Error('Not authorized') });
      await expect(nvmeofSubsystemUpdate.plan(denied.ctx, args)).rejects.toThrow('Not authorized');
    });

    it('says a new NQN strands hosts configured with the old one', async () => {
      expect(await updateText({ id: 3, subnqn: 'nqn.new' })).toContain(
        'CHANGING THE NQN CHANGES WHAT HOSTS CONNECT TO: hosts configured with ' +
          '"nqn.2011-06.com.truenas:uuid:abc:vmstore" will no longer find this subsystem.',
      );
      const unread = await updateText({ id: 3, subnqn: 'nqn.new' }, system(undefined, [{ ...subsystem, subnqn: null }]));
      expect(unread).toContain('hosts configured with the old NQN will no longer find this subsystem.');
      expect(await updateText({ id: 3, subnqn: subsystem.subnqn, name: 'vms' })).not.toMatch(/CHANGING THE NQN|renaming/);
    });

    it('says whether a rename moves the NQN is unconfirmed, only where it is a rename', async () => {
      expect(await updateText({ id: 3, name: 'vms' })).toContain(
        'Whether renaming it also changes the NQN hosts connect to is (unconfirmed)',
      );
      expect(await updateText({ id: 3, name: 'vmstore' })).not.toContain('renaming');
    });

    it('says in words where any host may connect after the call', async () => {
      expect(await updateText(args)).toContain(
        'ANY HOST THAT CAN REACH A PORT THIS SUBSYSTEM IS PUBLISHED ON CAN CONNECT (allow_any_host true).',
      );
      const open = system(undefined, [{ ...subsystem, allow_any_host: true }]);
      const narrowed = await updateText({ id: 3, allow_any_host: false }, open);
      expect(narrowed).toContain('After this it admits only hosts explicitly allowed onto it may connect (allow_any_host false)');
      expect(narrowed).toContain('A host that could connect only because it allowed any host loses access.');
      expect(await updateText({ id: 3, allow_any_host: false })).not.toContain('loses access');
      expect(await updateText({ id: 3, name: 'vms' }, open)).toContain(
        'It allows any host now and this does not change that: ANY HOST THAT CAN REACH A PORT',
      );
      expect(await updateText({ id: 3, name: 'vms' }, system(undefined, [{ ...subsystem, allow_any_host: 1 }]))).toContain(
        'Whether it admits any host could not be read; this does not change it.',
      );
      expect(await updateText({ id: 3, name: 'vms' })).not.toMatch(/ANY HOST|admits/);
    });

    it('says where the subsystem already holds every value sent', async () => {
      expect(await updateText({ id: 3, allow_any_host: false })).toContain(
        'The subsystem already holds every value this sends, which is not an error.',
      );
      expect(await updateText(args)).not.toContain('already holds');
    });
  });

  describe('what it reports', () => {
    it('reads, then updates with exactly what the plan named', async () => {
      const { ctx, call, query } = system();
      const [read, step] = await nvmeofSubsystemUpdate.plan(system().ctx, args);
      await nvmeofSubsystemUpdate.execute(ctx, args);
      expect(query).toHaveBeenCalledWith(read.method, (read.params as unknown[])[0]);
      expect(call).toHaveBeenCalledWith(step.method, step.params);
    });

    it('reports each field sent as a before/after pair, off the read and the response', async () => {
      const result = await nvmeofSubsystemUpdate.execute(system().ctx, args);
      expect(result).toEqual({
        id: 3,
        requested: { allow_any_host: true },
        lookup: 'FOUND',
        lookup_error: null,
        previous: {
          id: 3,
          name: 'vmstore',
          subnqn: subsystem.subnqn,
          serial: 'f00dcafe',
          allow_any_host: false,
        },
        resulting: {
          id: 3,
          name: 'vmstore',
          subnqn: subsystem.subnqn,
          serial: 'f00dcafe',
          allow_any_host: true,
        },
        changes: { allow_any_host: { requested: true, before: false, after: true } },
        changed: true,
        confirmed: true,
      });
    });

    it('reports a subsystem already holding the values as unchanged and confirmed', async () => {
      const result = await nvmeofSubsystemUpdate.execute(system(subsystem).ctx, { id: 3, name: 'vmstore', allow_any_host: false });
      expect(result).toMatchObject({ changed: false, confirmed: true });
    });

    it('reports a call that did not apply as unchanged and NOT confirmed', async () => {
      const result = await nvmeofSubsystemUpdate.execute(system(subsystem).ctx, args);
      expect(result).toMatchObject({ changed: false, confirmed: false });
    });

    it('still updates when the read fails, and says why the before half is missing', async () => {
      const failing = failingSystem(
        { 'nvmet.subsys.update': { ...subsystem, allow_any_host: true } },
        { 'nvmet.subsys.query': new Error('connection reset') },
      );
      const result = await nvmeofSubsystemUpdate.execute(failing.ctx, args);
      expect(failing.call).toHaveBeenCalledWith('nvmet.subsys.update', [3, { allow_any_host: true }]);
      expect(result).toMatchObject({
        lookup: 'UNREADABLE',
        lookup_error: 'connection reset',
        previous: null,
        changes: { allow_any_host: { before: null, after: true } },
        changed: null,
        confirmed: true,
      });
    });

    it('still updates when the read lists no such subsystem', async () => {
      const result = await nvmeofSubsystemUpdate.execute(system(undefined, [other]).ctx, args);
      expect(result).toMatchObject({ lookup: 'NOT_FOUND', previous: null, changed: null });
    });

    it('reports nothing established where the response is not a record', async () => {
      const result = await nvmeofSubsystemUpdate.execute(system(true).ctx, args);
      expect(result).toMatchObject({
        resulting: null,
        changes: { allow_any_host: { before: false, after: null } },
        changed: null,
        confirmed: null,
      });
    });
  });
});
