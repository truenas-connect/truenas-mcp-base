import { describe, expect, it } from 'vitest';
import { Role } from '@/interfaces';
import { fakeSystem, failingSystem } from '@/testing/fake-systems';
import { nfsShareCreate } from '@/tools/index';

/**
 * `nfs_share_create`'s tests live here rather than in `shares.spec.ts`, for the
 * #87 reason `smb-share-create.spec.ts` gives: the merged file would cross the
 * 1,500-line trigger. The split is by tool.
 */

/** Every dataset as `pool.dataset.query` lists it with the walk on. */
const datasets = [
  { id: 'tank', mountpoint: '/mnt/tank' },
  { id: 'tank/vms', mountpoint: '/mnt/tank/vms' },
];

/** One export already on the system, of an unrelated path. */
const existing = { id: 2, path: '/mnt/tank/media' };

/** What `sharing.nfs.create` answers with for the ordinary request below. */
const created = {
  id: 6,
  path: '/mnt/tank/vms',
  aliases: [],
  comment: '',
  networks: ['10.0.0.0/24'],
  hosts: [],
  ro: true,
  maproot_user: null,
  maproot_group: null,
  mapall_user: null,
  mapall_group: null,
  security: [],
  enabled: true,
  locked: false,
  expose_snapshots: false,
};

const system = (overrides: Partial<Record<string, unknown>> = {}) =>
  fakeSystem({
    'pool.dataset.query': datasets,
    'sharing.nfs.query': [existing],
    'sharing.nfs.create': created,
    ...overrides,
  });

const args = { path: '/mnt/tank/vms', networks: ['10.0.0.0/24'], hosts: [], ro: true };

describe('nfs_share_create', () => {
  it('is a reversible mutating tool needing the sharing role', () => {
    expect(nfsShareCreate).toMatchObject({
      name: 'nfs_share_create',
      mutating: true,
      destructiveness: 'reversible',
      requiredRole: Role.Sharing,
    });
  });

  it('requires path, and its schema has no aliases or expose_snapshots', () => {
    const schema = nfsShareCreate.inputSchema as { properties: Record<string, unknown>; required: string[] };
    expect(schema.required).toEqual(['path']);
    expect(Object.keys(schema.properties)).toEqual([
      'path',
      'comment',
      'networks',
      'hosts',
      'ro',
      'maproot_user',
      'maproot_group',
      'mapall_user',
      'mapall_group',
      'security',
      'enabled',
    ]);
  });

  it('says empty lists are any client, what undoing it takes, and does not claim the ACL is left unchanged', () => {
    const description = nfsShareCreate.description;
    expect(description).toContain('ANY CLIENT THAT CAN REACH THE SYSTEM');
    expect(description).toContain('NO TOOL IN THIS CATALOG DELETES AN NFS EXPORT');
    expect(description).toContain('`share_set_enabled`');
    expect(description).toContain("This tool does not ask for any change to the dataset's ACL or permissions");
    expect(description).not.toMatch(/leaves? the (dataset's )?ACL unchanged|ACL is (left )?unchanged/);
    expect(nfsShareCreate.resultGuidance).toContain('TWO EMPTY LISTS MEAN ANY CLIENT MAY MOUNT IT');
  });

  it('normalizes args: keeps the settings, drops unknown keys', () => {
    expect(nfsShareCreate.normalizeArgs?.({ ...args, systems: 'all' })).toEqual(args);
  });

  describe('argument validation', () => {
    const reject = (bad: Record<string, unknown>, message: RegExp) =>
      expect(() => nfsShareCreate.normalizeArgs?.(bad)).toThrow(message);

    it('refuses aliases and expose_snapshots by name rather than dropping them', () => {
      reject({ ...args, aliases: ['/vms'] }, /"aliases" is not accepted by this tool/);
      reject({ ...args, expose_snapshots: true }, /"expose_snapshots" is not accepted by this tool/);
    });

    it('requires an absolute path written plainly', () => {
      reject({ ro: true }, /"path" is required/);
      reject({ path: 'tank/vms' }, /"path" must be an absolute path/);
      reject({ path: '/mnt/tank/../etc' }, /"path" must be written plainly/);
      reject({ path: '/mnt/tank/vms/' }, /"path" must be written plainly/);
    });

    it('takes networks and hosts only as lists of non-empty strings', () => {
      for (const key of ['networks', 'hosts']) {
        for (const value of ['10.0.0.0/24', [''], [3], null]) {
          reject({ path: '/mnt/tank/vms', [key]: value }, new RegExp(`"${key}" must be a list of non-empty strings`));
        }
      }
    });

    it('takes a mapping as a non-empty name or null, and nothing else', () => {
      for (const key of ['maproot_user', 'maproot_group', 'mapall_user', 'mapall_group']) {
        reject({ path: '/mnt/tank/vms', [key]: '' }, new RegExp(`"${key}" must be a non-empty name, or null`));
        reject({ path: '/mnt/tank/vms', [key]: 0 }, new RegExp(`"${key}" must be a non-empty name, or null`));
        expect(nfsShareCreate.normalizeArgs?.({ path: '/mnt/tank/vms', [key]: null })).toEqual({
          path: '/mnt/tank/vms',
          [key]: null,
        });
      }
    });

    it('takes security only as a list of the four flavours', () => {
      for (const security of ['SYS', ['sys'], ['NTLM'], [1]]) {
        reject({ path: '/mnt/tank/vms', security }, /"security" must be a list of SYS, KRB5, KRB5I, KRB5P/);
      }
      expect(nfsShareCreate.normalizeArgs?.({ path: '/mnt/tank/vms', security: ['KRB5P', 'SYS'] })).toEqual({
        path: '/mnt/tank/vms',
        security: ['KRB5P', 'SYS'],
      });
    });

    it('coerces nothing into a boolean or a comment', () => {
      reject({ path: '/mnt/tank/vms', ro: 'true' }, /"ro" must be a boolean/);
      reject({ path: '/mnt/tank/vms', enabled: 1 }, /"enabled" must be a boolean/);
      reject({ path: '/mnt/tank/vms', comment: 5 }, /"comment" must be a string/);
    });

    it('executes nothing when an argument is unreadable', async () => {
      const { ctx, query, call } = system();
      await expect(nfsShareCreate.execute(ctx, { ...args, aliases: [] })).rejects.toThrow(/"aliases"/);
      expect(query).not.toHaveBeenCalled();
      expect(call).not.toHaveBeenCalled();
    });
  });

  describe('the plan it returns', () => {
    it('is the create alone, sending exactly the settings passed', async () => {
      const steps = await nfsShareCreate.plan(system().ctx, args);
      expect(steps).toHaveLength(1);
      expect(steps[0].method).toBe('sharing.nfs.create');
      expect(steps[0].params).toEqual([args]);
      expect(steps[0].description).toContain(
        'Create an NFS export, path "/mnt/tank/vms", networks ["10.0.0.0/24"], hosts [], ro true.',
      );
    });

    it('names the dataset the path belongs to, and fails on a path inside none', async () => {
      const [step] = await nfsShareCreate.plan(system().ctx, args);
      expect(step.description).toContain('Path "/mnt/tank/vms" is the mountpoint of dataset "tank/vms".');
      const [inside] = await nfsShareCreate.plan(system().ctx, { path: '/mnt/tank/vms/k8s' });
      expect(inside.description).toContain('is a directory inside dataset "tank/vms"');
      await expect(nfsShareCreate.plan(system().ctx, { path: '/srv/nfs' })).rejects.toThrow(
        /Path "\/srv\/nfs" is not the mountpoint of any dataset this system lists, and not inside one/,
      );
    });

    it('says in words that two empty lists let any client mount it', async () => {
      const [step] = await nfsShareCreate.plan(system().ctx, { path: '/mnt/tank/vms', networks: [], hosts: [] });
      expect(step.description).toContain(
        'NEITHER `networks` NOR `hosts` RESTRICTS IT, SO ANY CLIENT THAT CAN REACH THIS SYSTEM MAY MOUNT IT: ' +
          'an empty list means unrestricted, not nobody',
      );
      expect(step.description).not.toContain('A list not sent');
    });

    it('says the same where neither list is sent, and that the empty default is unconfirmed', async () => {
      const [step] = await nfsShareCreate.plan(system().ctx, { path: '/mnt/tank/vms' });
      expect(step.description).toContain('SO ANY CLIENT THAT CAN REACH THIS SYSTEM MAY MOUNT IT');
      expect(step.description).toContain(
        'A list not sent is created empty as far as this tool knows, which is (unconfirmed).',
      );
    });

    it('says a disabled export serves no client, and who may mount it once switched on', async () => {
      const [off] = await nfsShareCreate.plan(system().ctx, { path: '/mnt/tank/vms', enabled: false });
      expect(off.description).toContain(
        'THE EXPORT WILL BE DISABLED, so no client can mount it until it is switched on; who may mount it ' +
          'is stated below for when it is. NEITHER `networks` NOR `hosts` RESTRICTS IT',
      );
      expect(off.description).toContain(
        'Path "/mnt/tank/vms" becomes mountable over NFS, once the export is switched on, by the clients stated here',
      );
      for (const enabled of [true, undefined]) {
        const [on] = await nfsShareCreate.plan(system().ctx, { path: '/mnt/tank/vms', enabled });
        expect(on.description).not.toContain('WILL BE DISABLED');
        expect(on.description).toContain('becomes mountable over NFS by the clients stated here');
      }
    });

    it('names the clients a restricted export admits, an empty list as none', async () => {
      const [step] = await nfsShareCreate.plan(system().ctx, args);
      expect(step.description).toContain('Only clients these name may mount it — networks "10.0.0.0/24"; hosts none.');
      expect(step.description).not.toContain('ANY CLIENT');
      const [hostsOnly] = await nfsShareCreate.plan(system().ctx, { path: '/mnt/tank/vms', hosts: ['esx1', 'esx2'] });
      expect(hostsOnly.description).toContain('networks none; hosts "esx1", "esx2".');
      expect(hostsOnly.description).toContain('A list not sent is created empty');
    });

    it('says a root mapping to root turns root squashing off', async () => {
      const [step] = await nfsShareCreate.plan(system().ctx, { ...args, maproot_user: 'root', maproot_group: 'wheel' });
      expect(step.description).toContain(
        'Root on a client stays root on this system for this export, with group "wheel": ROOT SQUASHING IS OFF.',
      );
    });

    it('states a root mapping to another account, and a group-only one', async () => {
      const [user] = await nfsShareCreate.plan(system().ctx, { ...args, maproot_user: 'nobody' });
      expect(user.description).toContain('Requests from root on a client are treated as user "nobody".');
      const [group] = await nfsShareCreate.plan(system().ctx, { ...args, maproot_group: 'nogroup' });
      expect(group.description).toContain('Requests from root on a client are treated as group "nogroup".');
    });

    it('says a mapall replaces every request’s identity, and what mapping all to root means', async () => {
      const [step] = await nfsShareCreate.plan(system().ctx, { ...args, mapall_user: 'vmware', mapall_group: 'vmware' });
      expect(step.description).toContain(
        'EVERY REQUEST over this export, from any client user including root, is treated as user "vmware" and group "vmware".',
      );
      const [root] = await nfsShareCreate.plan(system().ctx, { ...args, mapall_user: 'root' });
      expect(root.description).toContain(
        'is treated as user "root", so every client user acts as root on this system here.',
      );
      const [group] = await nfsShareCreate.plan(system().ctx, { ...args, mapall_group: 'staff' });
      expect(group.description).toContain('is treated as group "staff".');
    });

    it('states no mapping where none is set or every one is sent as null', async () => {
      const [none] = await nfsShareCreate.plan(system().ctx, args);
      const [cleared] = await nfsShareCreate.plan(system().ctx, { ...args, maproot_user: null, mapall_user: null });
      for (const step of [none, cleared]) {
        expect(step.description).not.toMatch(/EVERY REQUEST|Root on a client|Requests from root|could not be read, so the mapping/);
      }
    });

    it('names exports of the same path, a parent and a child, and not an unrelated one', async () => {
      const rows = [
        existing,
        { id: 3, path: '/mnt/tank/vms' },
        { id: 4, path: '/mnt/tank' },
        { id: 5, path: '/mnt/tank/vms/iso/' },
        { id: 8, path: '/mnt/tank/vmsx' },
        { id: 9, path: '/' },
      ];
      const [step] = await nfsShareCreate.plan(system({ 'sharing.nfs.query': rows }).ctx, args);
      expect(step.description).toContain(
        '4 other NFS exports already cover an overlapping path: id 3, "/mnt/tank/vms" (the same path); ' +
          'id 4, "/mnt/tank" (a parent of this path); id 5, "/mnt/tank/vms/iso/" (inside this path); ' +
          'id 9, "/" (a parent of this path). Whether the system refuses an overlapping export is (unconfirmed).',
      );
      expect(step.description).not.toContain('/mnt/tank/media');
      expect(step.description).not.toContain('/mnt/tank/vmsx');
    });

    it('says nothing else exports the path, and counts an export it could not compare', async () => {
      const [clear] = await nfsShareCreate.plan(system().ctx, args);
      expect(clear.description).toContain(
        'No other NFS export on this system exports this path, a parent of it or a directory inside it.',
      );
      const [unread] = await nfsShareCreate.plan(
        system({ 'sharing.nfs.query': [{ id: 3, path: '/mnt/tank' }, { id: 4 }, 'junk', { id: 5, path: 'relative' }] }).ctx,
        args,
      );
      expect(unread.description).toContain(
        '1 other NFS export already covers an overlapping path: id 3, "/mnt/tank" (a parent of this path).',
      );
      expect(unread.description).toContain('3 other NFS exports reported no path this tool could compare.');
      const [noId] = await nfsShareCreate.plan(system({ 'sharing.nfs.query': [{ path: '/mnt/tank' }] }).ctx, args);
      expect(noId.description).toContain('id (the system reported none), "/mnt/tank" (a parent of this path)');
    });

    it('states rather than fails when the existing exports could not be read', async () => {
      const failing = failingSystem(
        { 'pool.dataset.query': datasets },
        { 'sharing.nfs.query': new Error('NFS service is not running') },
      );
      const [step] = await nfsShareCreate.plan(failing.ctx, args);
      expect(step.description).toContain(
        'Whether another NFS export already covers this path could not be read (sharing.nfs.query failed: NFS service is not running).',
      );
      const [notList] = await nfsShareCreate.plan(system({ 'sharing.nfs.query': 3 }).ctx, args);
      expect(notList.description).toContain('(sharing.nfs.query did not answer with a list)');
    });

    it('says the path becomes mountable, points at share_access, and settles nothing about the ACL', async () => {
      const [step] = await nfsShareCreate.plan(system().ctx, args);
      expect(step.description).toContain('Path "/mnt/tank/vms" becomes mountable over NFS by the clients stated here');
      expect(step.description).toContain('`share_access` reports both');
      expect(step.description).toContain('whether the system changes them on its own is (unconfirmed).');
    });

    it('names the settings it leaves to the system, and only those', async () => {
      const [step] = await nfsShareCreate.plan(system().ctx, args);
      expect(step.description).toContain(
        "Not sent, and so left to the system's defaults, which are not read here: comment, maproot_user, " +
          'maproot_group, mapall_user, mapall_group, security, enabled.',
      );
      const [all] = await nfsShareCreate.plan(system().ctx, {
        ...args,
        comment: '',
        maproot_user: null,
        maproot_group: null,
        mapall_user: null,
        mapall_group: null,
        security: ['SYS'],
        enabled: true,
      });
      expect(all.description).not.toContain('Not sent');
    });
  });

  describe('what it reports', () => {
    it('creates with exactly what the plan named, and makes no other call', async () => {
      const { ctx, call, query } = system();
      const [step] = await nfsShareCreate.plan(system().ctx, args);
      await nfsShareCreate.execute(ctx, args);
      expect(call).toHaveBeenCalledTimes(1);
      expect(call).toHaveBeenCalledWith(step.method, step.params);
      expect(query).not.toHaveBeenCalled();
    });

    it('reads the export off the response through named fields, and confirms what was sent', async () => {
      const result = await nfsShareCreate.execute(system().ctx, args);
      expect(result).toEqual({
        requested: args,
        share: {
          id: 6,
          path: '/mnt/tank/vms',
          comment: '',
          networks: ['10.0.0.0/24'],
          hosts: [],
          ro: true,
          maproot_user: null,
          maproot_group: null,
          mapall_user: null,
          mapall_group: null,
          security: [],
          enabled: true,
          locked: false,
        },
        confirmed: true,
      });
    });

    it('reports a value stored as something else as unconfirmed, a list compared as spelled', async () => {
      for (const stored of [{ ro: false }, { networks: ['10.0.0.0/16'] }, { hosts: ['esx1'] }]) {
        const result = (await nfsShareCreate.execute(
          system({ 'sharing.nfs.create': { ...created, ...stored } }).ctx,
          args,
        )) as { confirmed: unknown };
        expect(result.confirmed).toBe(false);
      }
    });

    it('confirms a mapping set, and a mapping cleared whether stored as null or ""', async () => {
      const set = await nfsShareCreate.execute(
        system({ 'sharing.nfs.create': { ...created, maproot_user: 'root' } }).ctx,
        { ...args, maproot_user: 'root' },
      );
      expect(set).toMatchObject({ share: { maproot_user: 'root' }, confirmed: true });
      for (const stored of [null, '']) {
        const cleared = await nfsShareCreate.execute(
          system({ 'sharing.nfs.create': { ...created, mapall_user: stored } }).ctx,
          { ...args, mapall_user: null },
        );
        expect(cleared).toMatchObject({ share: { mapall_user: null }, confirmed: true });
      }
      const wrong = await nfsShareCreate.execute(
        system({ 'sharing.nfs.create': { ...created, mapall_user: 'nobody' } }).ctx,
        { ...args, mapall_user: null },
      );
      expect(wrong).toMatchObject({ confirmed: false });
    });

    it('is null rather than true where a value sent could not be read back', async () => {
      for (const stored of [{ ro: 'yes' }, { networks: ['10.0.0.0/24', 7] }, { maproot_user: 0 }]) {
        const result = (await nfsShareCreate.execute(
          system({ 'sharing.nfs.create': { ...created, ...stored } }).ctx,
          { ...args, maproot_user: 'nobody' },
        )) as { confirmed: unknown };
        expect(result.confirmed).toBe(
          // Where the mapping reads back, it reads back as none — a definite
          // difference, which outranks the unreadable field beside it.
          Object.hasOwn(stored, 'maproot_user') ? null : false,
        );
      }
      const result = (await nfsShareCreate.execute(
        system({ 'sharing.nfs.create': { ...created, networks: 'all' } }).ctx,
        args,
      )) as { share: { networks: unknown }; confirmed: unknown };
      expect(result.share.networks).toBeNull();
      expect(result.confirmed).toBeNull();
    });

    it('reports no export and no confirmation where the response is not a record', async () => {
      for (const response of [null, true, [created]]) {
        const result = await nfsShareCreate.execute(system({ 'sharing.nfs.create': response }).ctx, args);
        expect(result).toMatchObject({ share: null, confirmed: null });
      }
    });
  });
});
