import { describe, expect, it } from 'vitest';
import { Role } from '@/interfaces';
import { fakeSystem, failingSystem } from '@/testing/fake-systems';
import { iscsiTargetCreate } from '@/tools/index';

/**
 * `iscsi_target_create`'s tests live here rather than in `block.spec.ts`, which
 * is near #87's 1,500-line trigger. The split is by tool.
 */

/** A portal on every IPv4 address. */
const portal = { id: 1, tag: 1, comment: 'lan', listen: [{ ip: '0.0.0.0', port: 3260 }] };

/** A second portal, bound to one address and labelled with nothing. */
const storagePortal = { id: 6, tag: 2, comment: '', listen: [{ ip: '10.0.0.5', port: 3260 }] };

/** An initiator group naming one initiator, and one naming none. */
const esx = { id: 2, comment: 'esx', initiators: ['iqn.1998-01.com.vmware:esx1'] };
const open = { id: 4, comment: 'open', initiators: [] };

/**
 * Two CHAP credentials sharing tag 3, each carrying secrets that must reach
 * neither the plan nor the result. Their ids are deliberately not 3.
 */
const chap = [
  { id: 7, tag: 3, user: 'esxchap', secret: 'SEKRIT-one', peeruser: 'peer', peersecret: 'SEKRIT-peer' },
  { id: 8, tag: 3, user: 'second', secret: 'SEKRIT-two', peersecret: 'SEKRIT-peer-two' },
];

const created = {
  id: 5,
  name: 'vmstore',
  alias: null,
  mode: 'ISCSI',
  groups: [{ portal: 1, initiator: 2, authmethod: 'CHAP', auth: 3 }],
  auth_networks: ['10.0.0.0/24'],
  rel_tgt_id: 5,
  iscsi_parameters: null,
};

const tables = {
  'iscsi.portal.query': [portal, storagePortal],
  'iscsi.initiator.query': [esx, open],
  'iscsi.auth.query': chap,
  'iscsi.target.validate_name': null,
};

const system = (response: unknown = created, overrides: Record<string, unknown> = {}) =>
  fakeSystem({ ...tables, 'iscsi.target.create': response, ...overrides });

const args = {
  name: 'vmstore',
  groups: [{ portal: 1, initiator: 2, authmethod: 'CHAP', auth: 3 }],
  auth_networks: ['10.0.0.0/24'],
};

const planText = async (input: Record<string, unknown>, sys = system()) => {
  const [step] = await iscsiTargetCreate.plan(sys.ctx, input);
  return step.description;
};

describe('iscsi_target_create', () => {
  it('is a reversible mutating tool needing the sharing role', () => {
    expect(iscsiTargetCreate).toMatchObject({
      name: 'iscsi_target_create',
      mutating: true,
      destructiveness: 'reversible',
      requiredRole: Role.Sharing,
    });
  });

  it('requires the name, and its schema has no mode or iSCSI parameters', () => {
    const schema = iscsiTargetCreate.inputSchema as { properties: Record<string, unknown>; required: string[] };
    expect(schema.required).toEqual(['name']);
    expect(Object.keys(schema.properties)).toEqual(['name', 'alias', 'groups', 'auth_networks']);
  });

  it('says what a group refers to, who it admits, and that the target serves no storage yet', () => {
    const description = iscsiTargetCreate.description;
    expect(description).toContain("`auth` is a CHAP credential's TAG, not its id");
    expect(description).toContain('`initiator` null is ANY INITIATOR');
    expect(description).toContain('A NEW TARGET HAS NO EXTENT MAPPED AND SERVES NO STORAGE');
    expect(description).toContain("`iscsi_list` does not report a target's groups");
    expect(description).toContain('NO TOOL IN THIS CATALOG DELETES AN iSCSI TARGET');
  });

  it('normalizes args: the settings passed in schema order, no mode, unknown keys dropped', () => {
    expect(
      iscsiTargetCreate.normalizeArgs?.({
        auth_networks: [],
        groups: [{ auth: null, portal: 1 }],
        name: 'vmstore',
        systems: 'all',
      }),
    ).toEqual({ name: 'vmstore', groups: [{ portal: 1, auth: null }], auth_networks: [] });
  });

  describe('argument validation', () => {
    const reject = (bad: Record<string, unknown>, message: RegExp) =>
      expect(() => iscsiTargetCreate.normalizeArgs?.(bad)).toThrow(message);

    it('requires a non-empty name', () => {
      reject({}, /"name" is required/);
      reject({ name: '' }, /"name" must be a non-empty string/);
      reject({ name: 7 }, /"name" must be a non-empty string/);
    });

    it('refuses mode and iscsi_parameters by name', () => {
      reject({ name: 'a', mode: 'ISCSI' }, /"mode" is not accepted by this tool/);
      reject({ name: 'a', iscsi_parameters: null }, /"iscsi_parameters" is not accepted by this tool/);
    });

    it('takes null to mean no alias and refuses an empty one', () => {
      expect(iscsiTargetCreate.normalizeArgs?.({ name: 'a', alias: null })).toEqual({ name: 'a', alias: null });
      reject({ name: 'a', alias: '' }, /"alias" must be a non-empty string, or null/);
    });

    it('refuses a group that is not one, whole', () => {
      reject({ name: 'a', groups: { portal: 1 } }, /"groups" must be a list/);
      reject({ name: 'a', groups: ['x'] }, /"groups\[0\]" must be an object/);
      reject({ name: 'a', groups: [{ initiator: 2 }] }, /"groups\[0\]\.portal" is required and must be a whole number/);
      reject({ name: 'a', groups: [{ portal: 1.5 }] }, /"groups\[0\]\.portal" is required/);
      reject({ name: 'a', groups: [{ portal: 1, initiator: '2' }] }, /"groups\[0\]\.initiator" must be an initiator group's id/);
      reject({ name: 'a', groups: [{ portal: 1, authmethod: 'chap' }] }, /"groups\[0\]\.authmethod" must be one of NONE, CHAP, CHAP_MUTUAL/);
      reject({ name: 'a', groups: [{ portal: 1, auth: 'x' }] }, /"groups\[0\]\.auth" must be a CHAP credential's tag/);
      reject({ name: 'a', groups: [{ portal: 1, tag: 1 }] }, /"groups\[0\]\.tag" is not accepted: a group takes portal, initiator, authmethod, auth/);
    });

    it('refuses CHAP without a credential, as the middleware does', () => {
      reject({ name: 'a', groups: [{ portal: 1, authmethod: 'CHAP' }] }, /"groups\[0\]\.auth" is required where authmethod is CHAP/);
      reject(
        { name: 'a', groups: [{ portal: 1, authmethod: 'CHAP_MUTUAL', auth: null }] },
        /"groups\[0\]\.auth" is required where authmethod is CHAP_MUTUAL/,
      );
    });

    it('refuses networks that are not a list of names', () => {
      reject({ name: 'a', auth_networks: '10.0.0.0/8' }, /"auth_networks" must be a list of networks in CIDR form/);
      reject({ name: 'a', auth_networks: [''] }, /"auth_networks" must be a list/);
    });
  });

  describe('the plan it returns', () => {
    it('plans one call, sending what was passed with mode ISCSI', async () => {
      const steps = await iscsiTargetCreate.plan(system().ctx, args);
      expect(steps).toHaveLength(1);
      expect(steps[0].method).toBe('iscsi.target.create');
      expect(steps[0].params).toEqual([{ ...args, mode: 'ISCSI' }]);
      expect(steps[0].description).toMatch(/^Create an iSCSI target, name "vmstore", groups \[/);
      expect(steps[0].description).toContain('mode "ISCSI"');
    });

    it('names every reference in a group in human terms', async () => {
      const text = await planText(args);
      expect(text).toContain(
        'It is published through portal id 1 (tag 1, "lan", listening on 0.0.0.0:3260 (every IPv4 address)): ' +
          'only the initiators initiator group id 2 ("esx") lists: "iqn.1998-01.com.vmware:esx1"; ' +
          'CHAP required with CHAP credential tag 3 (user "esxchap", user "second").',
      );
    });

    it('never puts a CHAP secret in the plan', async () => {
      const text = await planText({ ...args, groups: [{ portal: 1, authmethod: 'CHAP_MUTUAL', auth: 3 }] });
      expect(text).toContain('mutual CHAP required with CHAP credential tag 3');
      expect(text).not.toMatch(/SEKRIT|peer/);
    });

    it('says in words where a group admits any initiator or uses no CHAP', async () => {
      const text = await planText({
        name: 'vmstore',
        groups: [
          { portal: 1, initiator: null, authmethod: 'NONE' },
          { portal: 6, initiator: 4 },
        ],
      });
      expect(text).toContain('ANY INITIATOR MAY CONNECT (initiator null); NO CHAP (authmethod NONE)');
      expect(text).toContain(
        'through portal id 6 (tag 2, listening on 10.0.0.5:3260): initiator group id 4 ("open"), which ' +
          'lists no initiator — read here as admitting ANY initiator, which is (unconfirmed)',
      );
      expect(text).toContain("authmethod not sent, so the system's default applies");
    });

    it('says what it cannot read about a group rather than guessing', async () => {
      const text = await planText(
        { name: 'vmstore', groups: [{ portal: 1 }] },
        system(undefined, { 'iscsi.portal.query': [{ id: 1, tag: 'x', listen: 'nope' }] }),
      );
      expect(text).toContain(
        'through portal id 1 (tag (the system reported none), listening on (the system reported none)): ' +
          'initiator not sent, so the system decides which initiators it admits',
      );
      const unread = await planText(
        { name: 'vmstore', groups: [{ portal: 1, initiator: 2 }] },
        system(undefined, { 'iscsi.initiator.query': [{ id: 2, initiators: [9] }] }),
      );
      expect(unread).toContain('initiator group id 2, whose initiator list could not be read, so who it admits is not established');
      const quiet = await planText(
        { name: 'vmstore', groups: [{ portal: 1, authmethod: 'NONE', auth: 3 }] },
        system(undefined, {
          'iscsi.portal.query': [{ id: 1, tag: 1, listen: [{ ip: '::', port: 3260 }, null] }],
          'iscsi.auth.query': [{ tag: 3 }],
        }),
      );
      expect(quiet).toContain(
        'listening on :::3260 (every IPv6 address), (the system reported none):(the system reported none)',
      );
      expect(quiet).toContain('NO CHAP (authmethod NONE) with CHAP credential tag 3 (user (the system reported none))');
      const silent = await planText(
        { name: 'vmstore', groups: [{ portal: 1 }] },
        system(undefined, { 'iscsi.portal.query': [{ id: 1, tag: 1, listen: [] }] }),
      );
      expect(silent).toContain('listening on no address');
    });

    it('reads only the tables a group refers into, once each', async () => {
      const sys = system();
      await iscsiTargetCreate.plan(sys.ctx, {
        name: 'vmstore',
        groups: [
          { portal: 1, initiator: null },
          { portal: 6, initiator: null },
        ],
      });
      expect(sys.query.mock.calls.map(([method]) => method)).toEqual(['iscsi.portal.query']);
    });

    it('fails on a reference that does not resolve, naming the table', async () => {
      await expect(planText({ name: 'a', groups: [{ portal: 9 }] })).rejects.toThrow(
        /groups\[0\]\.portal: no portal with id 9 in iscsi\.portal on this system/,
      );
      await expect(planText({ name: 'a', groups: [{ portal: 1 }, { portal: 1, initiator: 99 }] })).rejects.toThrow(
        /groups\[1\]\.initiator: no initiator group with id 99 in iscsi\.initiator/,
      );
      await expect(planText({ name: 'a', groups: [{ portal: 1, authmethod: 'CHAP', auth: 42 }] })).rejects.toThrow(
        /groups\[0\]\.auth: no CHAP credential with tag 42 in iscsi\.auth/,
      );
    });

    it('matches a CHAP credential on its tag, never its id', async () => {
      await expect(planText({ name: 'a', groups: [{ portal: 1, authmethod: 'CHAP', auth: 7 }] })).rejects.toThrow(
        /no CHAP credential with tag 7 in iscsi\.auth on this system — it is matched on `tag`, not `id`/,
      );
    });

    it('fails where a table it needs could not be read, saying why', async () => {
      const failing = failingSystem(tables, { 'iscsi.portal.query': new Error('connection reset') });
      await expect(iscsiTargetCreate.plan(failing.ctx, args)).rejects.toThrow(
        /groups\[0\]\.portal: portal with id 1 could not be resolved, because iscsi\.portal\.query failed: connection reset/,
      );
      await expect(
        planText(args, system(undefined, { 'iscsi.auth.query': 'nope' })),
      ).rejects.toThrow(/because iscsi\.auth\.query did not answer with a list/);
    });

    it('says a target with no groups names no portal, and one not sent is left to the system', async () => {
      expect(await planText({ name: 'a', groups: [] })).toContain('IT NAMES NO PORTAL GROUP');
      const unsent = await planText({ name: 'a' });
      expect(unsent).toContain('`groups` is not sent');
      expect(unsent).toContain("Not sent, and so left to the system's defaults, which are not read here: alias, groups, auth_networks.");
      expect(await planText({ ...args, alias: 'vms' })).not.toContain('Not sent');
    });

    it('states which networks initiators may connect from', async () => {
      expect(await planText(args)).toContain('Only initiators connecting from "10.0.0.0/24" may connect.');
      expect(await planText({ name: 'a', auth_networks: [] })).toContain(
        '`auth_networks` IS EMPTY, WHICH IS READ HERE AS INITIATORS FROM ANY NETWORK MAY CONNECT',
      );
      expect(await planText({ name: 'a' })).toContain('`auth_networks` is not sent');
    });

    it('says the new target serves no storage and where its groups can be seen', async () => {
      const text = await planText(args);
      expect(text).toContain('A NEW TARGET HAS NO EXTENT MAPPED AND SERVES NO STORAGE');
      expect(text).toContain("`iscsi_list` does not report a target's groups");
    });

    it("runs the system's name check, and refuses a name it refuses", async () => {
      const sys = system();
      expect(await planText(args, sys)).toContain(
        "The system's own name check (iscsi.target.validate_name) accepted the name",
      );
      expect(sys.call).toHaveBeenCalledWith('iscsi.target.validate_name', ['vmstore']);
      await expect(
        planText(args, system(undefined, { 'iscsi.target.validate_name': 'Target name vmstore already exists' })),
      ).rejects.toThrow('The system refuses the target name "vmstore": Target name vmstore already exists');
      expect(await planText(args, system(undefined, { 'iscsi.target.validate_name': 7 }))).toContain(
        'answered with nothing this tool could read',
      );
    });

    it('says the name check was not run where it could not be called', async () => {
      const missing = failingSystem(tables, { 'iscsi.target.validate_name': { errname: 'ENOMETHOD' } });
      const [step] = await iscsiTargetCreate.plan(missing.ctx, args);
      expect(step.description).toContain('could not be called (this system has no such method), so it was not run.');
      const broken = failingSystem(tables, { 'iscsi.target.validate_name': new Error('timeout') });
      const [other] = await iscsiTargetCreate.plan(broken.ctx, args);
      expect(other.description).toContain('could not be called (timeout), so it was not run.');
    });
  });

  describe('what it reports', () => {
    it('creates with exactly what the plan named', async () => {
      const sys = system();
      const [step] = await iscsiTargetCreate.plan(system().ctx, args);
      await iscsiTargetCreate.execute(sys.ctx, args);
      expect(sys.call).toHaveBeenCalledWith(step.method, step.params);
      expect(sys.call).toHaveBeenCalledTimes(1);
      expect(sys.query).not.toHaveBeenCalled();
    });

    it('reports the created target off the response, confirmed', async () => {
      const result = await iscsiTargetCreate.execute(system().ctx, args);
      expect(result).toEqual({
        requested: { ...args, mode: 'ISCSI' },
        target: {
          id: 5,
          name: 'vmstore',
          alias: null,
          mode: 'ISCSI',
          groups: [{ portal: 1, initiator: 2, authmethod: 'CHAP', auth: 3 }],
          auth_networks: ['10.0.0.0/24'],
        },
        confirmed: true,
      });
      expect(JSON.stringify(result)).not.toMatch(/SEKRIT|rel_tgt_id|iscsi_parameters/);
    });

    it('compares only the keys a group sent, and confirms a cleared alias', async () => {
      const result = await iscsiTargetCreate.execute(
        system({ ...created, alias: '', groups: [{ portal: 1, initiator: null, authmethod: 'NONE', auth: null }] }).ctx,
        { name: 'vmstore', alias: null, groups: [{ portal: 1 }], auth_networks: ['10.0.0.0/24'] },
      );
      expect(result).toMatchObject({ confirmed: true });
    });

    it('reports a group stored as something else as NOT confirmed', async () => {
      for (const groups of [
        [{ portal: 1, initiator: null, authmethod: 'CHAP', auth: 3 }],
        [],
        [created.groups[0], created.groups[0]],
      ]) {
        const result = await iscsiTargetCreate.execute(system({ ...created, groups }).ctx, args);
        expect(result).toMatchObject({ confirmed: false });
      }
    });

    it('reports confirmation as unestablished where the groups could not be read back', async () => {
      for (const groups of [undefined, [{ portal: 1, initiator: 'x' }], [{ portal: 1, auth: 'x' }], [{ portal: 1, authmethod: 4 }], [null]]) {
        const result = await iscsiTargetCreate.execute(system({ ...created, groups }).ctx, args);
        expect(result).toMatchObject({ target: { groups: null }, confirmed: null });
      }
    });

    it('reports nothing established where the response is not a record', async () => {
      expect(await iscsiTargetCreate.execute(system(true).ctx, args)).toEqual({
        requested: { ...args, mode: 'ISCSI' },
        target: null,
        confirmed: null,
      });
    });
  });
});
