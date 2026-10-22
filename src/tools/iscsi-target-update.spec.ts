import { describe, expect, it } from 'vitest';
import { Role } from '@/interfaces';
import { fakeSystem, failingSystem } from '@/testing/fake-systems';
import { iscsiTargetUpdate } from '@/tools/index';

/**
 * `iscsi_target_update`'s tests live here rather than in `block.spec.ts`, for
 * the #87 reason `iscsi-target-create.spec.ts` gives. The split is by tool.
 */

/** The target being changed, as `iscsi.target.query` lists it. */
const target = {
  id: 5,
  name: 'vmstore',
  alias: 'vms',
  mode: 'ISCSI',
  groups: [{ portal: 1, initiator: null, authmethod: 'NONE', auth: null }],
  auth_networks: [],
  rel_tgt_id: 5,
};

/** Another target on the same system. */
const other = { id: 6, name: 'backup' };

const portal = { id: 1, tag: 1, comment: 'lan', listen: [{ ip: '0.0.0.0', port: 3260 }] };
const chap = [{ id: 7, tag: 3, user: 'esxchap', secret: 'SEKRIT-one', peersecret: 'SEKRIT-peer' }];

/** A system listing those rows, and answering the update with `updated`. */
const system = (
  updated: unknown = { ...target, alias: null, auth_networks: ['10.0.0.0/24'] },
  rows: unknown = [target, other],
  overrides: Record<string, unknown> = {},
) =>
  fakeSystem({
    'iscsi.target.query': rows,
    'iscsi.portal.query': [portal],
    'iscsi.initiator.query': [],
    'iscsi.auth.query': chap,
    'iscsi.target.validate_name': null,
    'iscsi.target.update': updated,
    ...overrides,
  });

const args = { id: 5, alias: null, auth_networks: ['10.0.0.0/24'] };

const updateText = async (input: Record<string, unknown>, sys = system()) => {
  const [, update] = await iscsiTargetUpdate.plan(sys.ctx, input);
  return update.description;
};

describe('iscsi_target_update', () => {
  it('is a reversible mutating tool needing the sharing role', () => {
    expect(iscsiTargetUpdate).toMatchObject({
      name: 'iscsi_target_update',
      mutating: true,
      destructiveness: 'reversible',
      requiredRole: Role.Sharing,
    });
  });

  it('requires the id, and its schema has no mode or iSCSI parameters', () => {
    const schema = iscsiTargetUpdate.inputSchema as { properties: Record<string, unknown>; required: string[] };
    expect(schema.required).toEqual(['id']);
    expect(Object.keys(schema.properties)).toEqual(['id', 'name', 'alias', 'groups', 'auth_networks']);
  });

  it('says the id is a target’s, that groups replace the list, and that a rename moves the IQN', () => {
    const description = iscsiTargetUpdate.description;
    expect(description).toContain('PLANNING AGAINST AN id NO iSCSI TARGET HAS FAILS');
    expect(description).toContain('`groups` REPLACES THE WHOLE LIST');
    expect(description).toContain('RENAMING A TARGET CHANGES THE IQN INITIATORS CONNECT TO');
    expect(description).toContain('`changed` must not be read without it');
  });

  it('normalizes args: keeps the id and the settings passed, in schema order, drops unknown keys', () => {
    expect(iscsiTargetUpdate.normalizeArgs?.({ auth_networks: [], id: 5, name: 'x', systems: 'all' })).toEqual({
      id: 5,
      name: 'x',
      auth_networks: [],
    });
  });

  describe('argument validation', () => {
    const reject = (bad: Record<string, unknown>, message: RegExp) =>
      expect(() => iscsiTargetUpdate.normalizeArgs?.(bad)).toThrow(message);

    it('requires a whole-number id', () => {
      for (const id of [undefined, null, '5', 5.5]) {
        reject({ ...args, id }, /"id" is required and must be a whole number/);
      }
    });

    it('requires something to change', () => {
      reject({ id: 5 }, /Nothing to change: pass at least one of name, alias, groups, auth_networks/);
    });

    it('refuses mode and validates each setting the way the create does', () => {
      reject({ id: 5, mode: 'FC' }, /"mode" is not accepted by this tool/);
      reject({ id: 5, name: '' }, /"name" must be a non-empty string/);
      reject({ id: 5, groups: [{ portal: 1, authmethod: 'CHAP' }] }, /"groups\[0\]\.auth" is required/);
    });
  });

  describe('the plan it returns', () => {
    it('plans the read it makes and the update, sending only the fields passed', async () => {
      const steps = await iscsiTargetUpdate.plan(system().ctx, args);
      expect(steps.map((step) => step.method)).toEqual(['iscsi.target.query', 'iscsi.target.update']);
      expect(steps[0]).toMatchObject({ params: [[['id', '=', 5]], {}] });
      expect(steps[0].description).toMatch(/Read this system's iSCSI target with id 5/);
      expect(steps[1].params).toEqual([5, { alias: null, auth_networks: ['10.0.0.0/24'] }]);
    });

    it('names the target and states each value beside the one it holds now', async () => {
      expect(await updateText(args)).toContain(
        'Change the iSCSI target named "vmstore" (id 5): alias null (now "vms"); ' +
          'auth_networks ["10.0.0.0/24"] (now []). Only these fields are sent.',
      );
      expect(await updateText(args)).toContain('Only initiators connecting from "10.0.0.0/24" may connect.');
    });

    it('states an absent alias as null and an unreadable value as reported none', async () => {
      const text = await updateText(
        { id: 5, alias: 'x', auth_networks: [] },
        system(undefined, [{ ...target, name: null, alias: '', auth_networks: [3] }]),
      );
      expect(text).toContain('Change the iSCSI target named (the system reported none) (id 5)');
      expect(text).toContain('alias "x" (now null)');
      expect(text).toContain('auth_networks [] (now (the system reported none))');
      const odd = await updateText({ id: 5, alias: 'x' }, system(undefined, [{ ...target, alias: 4 }]));
      expect(odd).toContain('alias "x" (now (the system reported none))');
    });

    it('fails on an id no iSCSI target has, comparing ids on the response', async () => {
      await expect(iscsiTargetUpdate.plan(system(undefined, [other]).ctx, args)).rejects.toThrow(
        /No iSCSI target with id 5 on this system — ids come from `iscsi_list`/,
      );
      await expect(iscsiTargetUpdate.plan(system(undefined, 'nope').ctx, args)).rejects.toThrow(/No iSCSI target with id 5/);
    });

    it('says a rename moves the IQN, and runs the name check against this target', async () => {
      const sys = system();
      const text = await updateText({ id: 5, name: 'vmstore2' }, sys);
      expect(text).toContain(
        'RENAMING IT CHANGES THE IQN INITIATORS CONNECT TO: initiators configured with "vmstore" will no longer find it.',
      );
      expect(text).toContain('accepted the name');
      expect(sys.call).toHaveBeenCalledWith('iscsi.target.validate_name', ['vmstore2', 5]);
      await expect(
        updateText({ id: 5, name: 'backup' }, system(undefined, undefined, { 'iscsi.target.validate_name': 'Name in use' })),
      ).rejects.toThrow('The system refuses the target name "backup": Name in use');
      const unnamed = await updateText({ id: 5, name: 'x' }, system(undefined, [{ ...target, name: null }]));
      expect(unnamed).toContain('initiators configured with the old name will no longer find it.');
    });

    it('neither warns nor checks where the name sent is the one it has', async () => {
      const sys = system();
      const text = await updateText({ id: 5, name: 'vmstore' }, sys);
      expect(text).not.toContain('RENAMING');
      expect(sys.call).not.toHaveBeenCalled();
      expect(text).toContain('The target already holds every value this sends, which is not an error.');
    });

    it('shows the whole group list beside the one it replaces, resolved', async () => {
      const text = await updateText({ id: 5, groups: [{ portal: 1, authmethod: 'CHAP', auth: 3 }] });
      expect(text).toContain(
        'groups [{"portal":1,"authmethod":"CHAP","auth":3}] ' +
          '(now [{"portal":1,"initiator":null,"authmethod":"NONE","auth":null}])',
      );
      expect(text).toContain('`groups` REPLACES THE WHOLE LIST');
      expect(text).toContain('CHAP required with CHAP credential tag 3 (user "esxchap")');
      expect(text).toContain("`iscsi_list` does not report a target's groups");
      expect(text).not.toMatch(/SEKRIT/);
      await expect(updateText({ id: 5, groups: [{ portal: 2 }] })).rejects.toThrow(
        /groups\[0\]\.portal: no portal with id 2 in iscsi\.portal/,
      );
    });

    it('says nothing about groups where none are sent', async () => {
      const sys = system();
      const text = await updateText(args, sys);
      expect(text).not.toMatch(/REPLACES THE WHOLE LIST|does not report a target's groups/);
      expect(sys.query).toHaveBeenCalledTimes(1);
    });

    it("states the target's mode where it is not ISCSI, and where it could not be read", async () => {
      const fc = await updateText(args, system(undefined, [{ ...target, mode: 'BOTH' }]));
      expect(fc).toContain("This target's mode is BOTH, so it is served over Fibre Channel too or instead");
      const unread = await updateText(args, system(undefined, [{ ...target, mode: undefined }]));
      expect(unread).toContain("The target's mode could not be read; this tool does not change it.");
      expect(await updateText(args)).not.toContain('mode');
    });
  });

  describe('what it reports', () => {
    it('reads, then updates with exactly what the plan named', async () => {
      const { ctx, call, query } = system();
      const [read, step] = await iscsiTargetUpdate.plan(system().ctx, args);
      await iscsiTargetUpdate.execute(ctx, args);
      expect(query).toHaveBeenCalledWith(read.method, (read.params as unknown[])[0]);
      expect(call).toHaveBeenCalledWith(step.method, step.params);
    });

    it('reports each field sent as a before/after pair, off the read and the response', async () => {
      const result = await iscsiTargetUpdate.execute(system().ctx, args);
      expect(result).toMatchObject({
        id: 5,
        requested: { alias: null, auth_networks: ['10.0.0.0/24'] },
        lookup: 'FOUND',
        lookup_error: null,
        changes: {
          alias: { requested: null, before: 'vms', after: null },
          auth_networks: { requested: ['10.0.0.0/24'], before: [], after: ['10.0.0.0/24'] },
        },
        changed: true,
        confirmed: true,
      });
      expect((result as { resulting: Record<string, unknown> }).resulting).toEqual({
        id: 5,
        name: 'vmstore',
        alias: null,
        mode: 'ISCSI',
        groups: [{ portal: 1, initiator: null, authmethod: 'NONE', auth: null }],
        auth_networks: ['10.0.0.0/24'],
      });
    });

    it('reports a target already holding the values as unchanged and confirmed', async () => {
      const result = await iscsiTargetUpdate.execute(system(target).ctx, { id: 5, groups: target.groups, name: 'vmstore' });
      expect(result).toMatchObject({ changed: false, confirmed: true });
    });

    it('reports a call that did not apply as unchanged and NOT confirmed', async () => {
      const result = await iscsiTargetUpdate.execute(system(target).ctx, args);
      expect(result).toMatchObject({ changed: false, confirmed: false });
    });

    it('counts a changed group list as a change', async () => {
      const groups = [{ portal: 1, initiator: 2, authmethod: 'NONE', auth: null }];
      const result = await iscsiTargetUpdate.execute(system({ ...target, groups }).ctx, { id: 5, groups });
      expect(result).toMatchObject({ changed: true, confirmed: true });
    });

    it('still updates when the read fails, and says why the before half is missing', async () => {
      const failing = failingSystem(
        { 'iscsi.target.update': { ...target, alias: null, auth_networks: ['10.0.0.0/24'] } },
        { 'iscsi.target.query': new Error('connection reset') },
      );
      const result = await iscsiTargetUpdate.execute(failing.ctx, args);
      expect(failing.call).toHaveBeenCalledWith('iscsi.target.update', [5, { alias: null, auth_networks: ['10.0.0.0/24'] }]);
      expect(result).toMatchObject({
        lookup: 'UNREADABLE',
        lookup_error: 'connection reset',
        previous: null,
        changes: { alias: { before: null, after: null } },
        changed: null,
        confirmed: true,
      });
    });

    it('still updates when the read lists no such target', async () => {
      const result = await iscsiTargetUpdate.execute(system(undefined, [other]).ctx, args);
      expect(result).toMatchObject({ lookup: 'NOT_FOUND', previous: null, changed: null });
    });

    it('reports nothing established where the response is not a record', async () => {
      const result = await iscsiTargetUpdate.execute(system(true).ctx, args);
      expect(result).toMatchObject({
        resulting: null,
        changes: { alias: { before: 'vms', after: null } },
        changed: null,
        confirmed: null,
      });
    });
  });
});
