import { describe, expect, it } from 'vitest';
import { Role } from '@/interfaces';
import { fakeSystem, failingSystem } from '@/testing/fake-systems';
import { nvmeofSubsystemCreate } from '@/tools/index';

/**
 * `nvmeof_subsystem_create`'s tests live here rather than in `block.spec.ts`,
 * for the #87 reason `iscsi-target-create.spec.ts` gives. The split is by tool.
 */

/** The subsystem the create answers with, carrying fields neither tool reports. */
const created = {
  id: 3,
  name: 'vmstore',
  subnqn: 'nqn.2011-06.com.truenas:uuid:abc:vmstore',
  serial: 'f00dcafe',
  allow_any_host: false,
  pi_enable: null,
  qid_max: null,
  ieee_oui: null,
  ana: null,
  hosts: [],
  namespaces: [],
  ports: [],
};

const system = (response: unknown = created) =>
  fakeSystem({ 'nvmet.subsys.query': [], 'nvmet.subsys.create': response });

const args = { name: 'vmstore', allow_any_host: false };

const planText = async (input: Record<string, unknown>, sys = system()) => {
  const [step] = await nvmeofSubsystemCreate.plan(sys.ctx, input);
  return step.description;
};

describe('nvmeof_subsystem_create', () => {
  it('is a reversible mutating tool needing the sharing role', () => {
    expect(nvmeofSubsystemCreate).toMatchObject({
      name: 'nvmeof_subsystem_create',
      mutating: true,
      destructiveness: 'reversible',
      requiredRole: Role.Sharing,
    });
  });

  it('requires the name, and its schema has none of the tuning fields', () => {
    const schema = nvmeofSubsystemCreate.inputSchema as { properties: Record<string, unknown>; required: string[] };
    expect(schema.required).toEqual(['name']);
    expect(Object.keys(schema.properties)).toEqual(['name', 'subnqn', 'allow_any_host']);
  });

  it('says the NQN may be derived, that the subsystem serves nothing, and that nothing here deletes one', () => {
    const description = nvmeofSubsystemCreate.description;
    expect(description).toContain('`subnqn` OMITTED IS DERIVED BY THE SYSTEM');
    expect(description).toContain('ON A SYSTEM WITHOUT NVMe-oF THE PLAN FAILS');
    expect(description).toContain('A NEW SUBSYSTEM HAS NO NAMESPACE AND IS PUBLISHED ON NO PORT');
    expect(description).toContain('NO TOOL IN THIS CATALOG DELETES AN NVMe-oF SUBSYSTEM');
  });

  it('normalizes args: the settings passed in schema order, unknown keys dropped', () => {
    expect(
      nvmeofSubsystemCreate.normalizeArgs?.({ allow_any_host: true, subnqn: 'nqn.x', name: 'a', systems: 'all' }),
    ).toEqual({ name: 'a', subnqn: 'nqn.x', allow_any_host: true });
  });

  describe('argument validation', () => {
    const reject = (bad: Record<string, unknown>, message: RegExp) =>
      expect(() => nvmeofSubsystemCreate.normalizeArgs?.(bad)).toThrow(message);

    it('requires a non-empty name', () => {
      reject({}, /"name" is required/);
      reject({ name: '' }, /"name" must be a non-empty string/);
      reject({ name: 7 }, /"name" must be a non-empty string/);
    });

    it('refuses every tuning field by name', () => {
      for (const key of ['pi_enable', 'qid_max', 'ieee_oui', 'ana']) {
        reject({ name: 'a', [key]: null }, new RegExp(`"${key}" is not accepted by this tool`));
      }
    });

    it('refuses an empty or null NQN rather than reading it as derive', () => {
      for (const subnqn of ['', null, 4]) {
        reject({ name: 'a', subnqn }, /"subnqn" must be a non-empty string.*omit it to let the system derive one/);
      }
    });

    it('takes allow_any_host as a boolean only', () => {
      reject({ name: 'a', allow_any_host: 'yes' }, /"allow_any_host" must be true or false/);
    });
  });

  describe('the plan it returns', () => {
    it('plans one call, sending exactly what was passed', async () => {
      const steps = await nvmeofSubsystemCreate.plan(system().ctx, args);
      expect(steps).toHaveLength(1);
      expect(steps[0].method).toBe('nvmet.subsys.create');
      expect(steps[0].params).toEqual([args]);
      expect(steps[0].description).toMatch(/^Create an NVMe-oF subsystem, name "vmstore", allow_any_host false\./);
    });

    it('checks for NVMe-oF with a read that is not a step', async () => {
      const sys = system();
      await nvmeofSubsystemCreate.plan(sys.ctx, args);
      expect(sys.query).toHaveBeenCalledWith('nvmet.subsys.query', [], { limit: 1 });
      expect(sys.call).not.toHaveBeenCalled();
    });

    it('fails where the system has no NVMe-oF, as nvmeof_list reports it', async () => {
      const missing = failingSystem({}, { 'nvmet.subsys.query': { errname: 'ENOMETHOD', reason: 'ENOMETHOD nvmet.subsys.query' } });
      await expect(nvmeofSubsystemCreate.plan(missing.ctx, args)).rejects.toThrow(
        'NVMe-oF is not supported on this system: it has no nvmet.subsys methods (ENOMETHOD nvmet.subsys.query), ' +
          'which `nvmeof_list` reports as `supported: false`.',
      );
    });

    it('does not read any other failure as unsupported, and says the check was not established', async () => {
      const denied = failingSystem({}, { 'nvmet.subsys.query': new Error('Not authorized') });
      const text = await planText(args, denied);
      expect(text).toContain(
        'Whether this system supports NVMe-oF could not be checked: nvmet.subsys.query failed (Not authorized).',
      );
      expect(await planText(args)).not.toContain('could not be checked');
    });

    it('says an omitted NQN is derived and read back, and says nothing of it when one is sent', async () => {
      expect(await planText(args)).toContain(
        '`subnqn` is not sent, so the system derives the NQN hosts connect to, by a rule this catalog does not know',
      );
      const sent = await planText({ ...args, subnqn: 'nqn.2014-08.org.example:vm' });
      expect(sent).toContain('subnqn "nqn.2014-08.org.example:vm"');
      expect(sent).not.toContain('`subnqn` is not sent');
    });

    it('says in words where any host may connect', async () => {
      expect(await planText({ name: 'a', allow_any_host: true })).toContain(
        'ANY HOST THAT CAN REACH A PORT THIS SUBSYSTEM IS PUBLISHED ON CAN CONNECT (allow_any_host true).',
      );
      const listed = await planText(args);
      expect(listed).toContain('It admits only hosts explicitly allowed onto it may connect (allow_any_host false)');
      expect(listed).not.toContain('ANY HOST');
      const unsent = await planText({ name: 'a' });
      expect(unsent).toContain("`allow_any_host` is not sent, so the system's default applies");
      expect(unsent).toContain('Where it is true, ANY HOST THAT CAN REACH A PORT THIS SUBSYSTEM IS PUBLISHED ON CAN CONNECT');
    });

    it('says the new subsystem serves nothing until it has a namespace and a port', async () => {
      expect(await planText(args)).toContain(
        'A NEW SUBSYSTEM HAS NO NAMESPACE AND IS PUBLISHED ON NO PORT, SO IT SERVES NOTHING',
      );
    });
  });

  describe('what it reports', () => {
    it('creates with exactly what the plan named, and nothing else', async () => {
      const sys = system();
      const [step] = await nvmeofSubsystemCreate.plan(system().ctx, args);
      await nvmeofSubsystemCreate.execute(sys.ctx, args);
      expect(sys.call).toHaveBeenCalledWith(step.method, step.params);
      expect(sys.call).toHaveBeenCalledTimes(1);
      expect(sys.query).not.toHaveBeenCalled();
    });

    it('reports the subnqn and serial off the response, confirmed', async () => {
      const result = await nvmeofSubsystemCreate.execute(system().ctx, args);
      expect(result).toEqual({
        requested: args,
        subsystem: {
          id: 3,
          name: 'vmstore',
          subnqn: 'nqn.2011-06.com.truenas:uuid:abc:vmstore',
          serial: 'f00dcafe',
          allow_any_host: false,
        },
        confirmed: true,
      });
      expect(JSON.stringify(result)).not.toMatch(/pi_enable|qid_max|ieee_oui|ana|namespaces|ports/);
    });

    it('reports a value stored as something else as NOT confirmed', async () => {
      for (const stored of [{ allow_any_host: true }, { name: 'other' }, { subnqn: 'nqn.other' }]) {
        const result = await nvmeofSubsystemCreate.execute(system({ ...created, ...stored }).ctx, {
          ...args,
          subnqn: created.subnqn,
        });
        expect(result).toMatchObject({ confirmed: false });
      }
    });

    it('reports confirmation as unestablished where a value sent could not be read back', async () => {
      const result = await nvmeofSubsystemCreate.execute(system({ ...created, allow_any_host: 'no' }).ctx, args);
      expect(result).toMatchObject({ subsystem: { allow_any_host: null }, confirmed: null });
    });

    it('reports nothing established where the response is not a record', async () => {
      expect(await nvmeofSubsystemCreate.execute(system(true).ctx, args)).toEqual({
        requested: args,
        subsystem: null,
        confirmed: null,
      });
    });
  });
});
