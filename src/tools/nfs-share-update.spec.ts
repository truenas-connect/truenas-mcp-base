import { describe, expect, it } from 'vitest';
import { Role } from '@/interfaces';
import { fakeSystem, failingSystem } from '@/testing/fake-systems';
import { nfsShareUpdate } from '@/tools/index';

/**
 * `nfs_share_update`'s tests live here rather than in `shares.spec.ts`, for the
 * #87 reason `smb-share-create.spec.ts` gives. The split is by tool.
 */

/** The export being changed, as `sharing.nfs.query` lists it. */
const share = {
  id: 3,
  path: '/mnt/tank/vms',
  aliases: [],
  comment: 'hypervisors',
  networks: ['10.0.0.0/24'],
  hosts: [],
  ro: false,
  maproot_user: 'root',
  maproot_group: null,
  mapall_user: null,
  mapall_group: '',
  security: ['SYS'],
  enabled: true,
  locked: false,
};

/** Another export on the same system. */
const other = { id: 4, path: '/mnt/tank/media' };

const datasets = [
  { id: 'tank', mountpoint: '/mnt/tank' },
  { id: 'tank/vms', mountpoint: '/mnt/tank/vms' },
  { id: 'tank/k8s', mountpoint: '/mnt/tank/k8s' },
];

/** A system listing those rows, and answering the update with `updated`. */
const system = (updated: unknown = { ...share, ro: true, hosts: ['esx1'] }, rows: unknown = [share, other]) =>
  fakeSystem({
    'sharing.nfs.query': rows,
    'pool.dataset.query': datasets,
    'sharing.nfs.update': updated,
  });

const args = { id: 3, ro: true, hosts: ['esx1'] };

describe('nfs_share_update', () => {
  it('is a reversible mutating tool needing the sharing role', () => {
    expect(nfsShareUpdate).toMatchObject({
      name: 'nfs_share_update',
      mutating: true,
      destructiveness: 'reversible',
      requiredRole: Role.Sharing,
    });
  });

  it('requires the id, and its schema has no aliases or expose_snapshots', () => {
    const schema = nfsShareUpdate.inputSchema as { properties: Record<string, unknown>; required: string[] };
    expect(schema.required).toEqual(['id']);
    for (const key of ['aliases', 'expose_snapshots']) {
      expect(Object.keys(schema.properties)).not.toContain(key);
    }
  });

  it('says the id is an NFS export’s and that the plan carries the values it replaces', () => {
    const description = nfsShareUpdate.description;
    expect(description).toContain('PLANNING AGAINST AN id NO NFS EXPORT HAS FAILS');
    expect(description).toContain("an SMB share's id is a different table");
    expect(description).toContain('THE PLAN STATES EACH VALUE SENT BESIDE THE ONE THE EXPORT HOLDS NOW');
    expect(description).toContain('`changed` must not be read without it');
  });

  it('normalizes args: keeps the id and the settings passed, in schema order, drops unknown keys', () => {
    expect(nfsShareUpdate.normalizeArgs?.({ ...args, systems: 'all' })).toEqual({ id: 3, hosts: ['esx1'], ro: true });
  });

  describe('argument validation', () => {
    const reject = (bad: Record<string, unknown>, message: RegExp) =>
      expect(() => nfsShareUpdate.normalizeArgs?.(bad)).toThrow(message);

    it('requires a whole-number id', () => {
      for (const id of [undefined, null, '3', 3.5]) {
        reject({ ...args, id }, /"id" is required and must be a whole number/);
      }
    });

    it('requires something to change', () => {
      reject(
        { id: 3 },
        /Nothing to change: pass at least one of path, comment, networks, hosts, ro, maproot_user, maproot_group, mapall_user, mapall_group, security, enabled/,
      );
    });

    it('refuses aliases and expose_snapshots by name', () => {
      reject({ ...args, aliases: [] }, /"aliases" is not accepted by this tool/);
      reject({ ...args, expose_snapshots: false }, /"expose_snapshots" is not accepted by this tool/);
    });

    it('validates each setting the way the create does', () => {
      reject({ id: 3, path: '/mnt/tank//k8s' }, /"path" must be written plainly/);
      reject({ id: 3, networks: '10.0.0.0/8' }, /"networks" must be a list of non-empty strings/);
      reject({ id: 3, mapall_user: '' }, /"mapall_user" must be a non-empty name, or null/);
      reject({ id: 3, ro: 'false' }, /"ro" must be a boolean/);
    });
  });

  describe('the plan it returns', () => {
    it('plans the read it makes and the update, sending only the fields passed', async () => {
      const steps = await nfsShareUpdate.plan(system().ctx, args);
      expect(steps.map((step) => step.method)).toEqual(['sharing.nfs.query', 'sharing.nfs.update']);
      expect(steps[0]).toMatchObject({ params: [[['id', '=', 3]], {}] });
      expect(steps[0].description).toMatch(/Read this system's NFS export with id 3/);
      expect(steps[1].params).toEqual([3, { hosts: ['esx1'], ro: true }]);
    });

    it('names the export and states each value beside the one it holds now', async () => {
      const [, update] = await nfsShareUpdate.plan(system().ctx, args);
      expect(update.description).toContain(
        'Change the NFS export with path "/mnt/tank/vms", no aliases (id 3): ' +
          'hosts ["esx1"] (now []); ro true (now false). Only these fields are sent.',
      );
    });

    it('states a cleared mapping as null and an unreadable value as reported none', async () => {
      const [, update] = await nfsShareUpdate.plan(
        system(undefined, [{ ...share, ro: 'no', networks: 'x' }]).ctx,
        { id: 3, ro: true, maproot_user: null, mapall_group: 'staff' },
      );
      expect(update.description).toContain('ro true (now (the system reported none))');
      expect(update.description).toContain('maproot_user null (now "root")');
      expect(update.description).toContain('mapall_group "staff" (now null)');
    });

    it('fails on an id no NFS export has, comparing ids on the response', async () => {
      await expect(nfsShareUpdate.plan(system(undefined, [other]).ctx, args)).rejects.toThrow(
        /No NFS export with id 3 on this system — ids come from `shares_list`/,
      );
      await expect(nfsShareUpdate.plan(system(undefined, 'nope').ctx, args)).rejects.toThrow(/No NFS export with id 3/);
    });

    it('states who may mount it afterwards, from what is sent and what it holds', async () => {
      const [, narrowed] = await nfsShareUpdate.plan(system().ctx, args);
      expect(narrowed.description).toContain('Only clients these name may mount it — networks "10.0.0.0/24"; hosts "esx1".');
      const [, opened] = await nfsShareUpdate.plan(system().ctx, { id: 3, networks: [] });
      expect(opened.description).toContain('SO ANY CLIENT THAT CAN REACH THIS SYSTEM MAY MOUNT IT');
      expect(opened.description).not.toContain('A list not sent');
    });

    it('says who may mount it is not established where a list it keeps could not be read', async () => {
      const [, update] = await nfsShareUpdate.plan(system(undefined, [{ ...share, hosts: [7] }]).ctx, { id: 3, networks: [] });
      expect(update.description).toContain('Which clients may mount it is not established');
      expect(update.description).not.toContain('ANY CLIENT');
    });

    it('states the mapping that will apply, from what is sent and what it holds', async () => {
      const [, kept] = await nfsShareUpdate.plan(system().ctx, args);
      expect(kept.description).toContain('ROOT SQUASHING IS OFF.');
      const [cleared] = (await nfsShareUpdate.plan(system().ctx, { id: 3, maproot_user: null })).slice(1);
      expect(cleared.description).not.toMatch(/ROOT SQUASHING|Requests from root|EVERY REQUEST/);
      const [all] = (await nfsShareUpdate.plan(system().ctx, { id: 3, maproot_user: null, mapall_user: 'nobody' })).slice(1);
      expect(all.description).toContain('is treated as user "nobody".');
    });

    it('names a mapping it could not read and did not send', async () => {
      const [, update] = await nfsShareUpdate.plan(
        system(undefined, [{ ...share, mapall_user: 5, maproot_group: undefined }]).ctx,
        args,
      );
      expect(update.description).toContain(
        'The current maproot_group, mapall_user could not be read, so the mapping stated here may be incomplete.',
      );
      const [, sent] = await nfsShareUpdate.plan(
        system(undefined, [{ ...share, mapall_user: 5 }]).ctx,
        { id: 3, mapall_user: null },
      );
      expect(sent.description).not.toContain('could not be read, so the mapping');
    });

    it('checks a new path, says what it stops exporting, and names overlaps other than itself', async () => {
      const rows = [share, other, { id: 5, path: '/mnt/tank/k8s/etcd' }];
      const [, update] = await nfsShareUpdate.plan(system(undefined, rows).ctx, { id: 3, path: '/mnt/tank/k8s' });
      expect(update.description).toContain(
        'This stops exporting "/mnt/tank/vms", and clients that mount that path will no longer find it.',
      );
      expect(update.description).toContain('Path "/mnt/tank/k8s" is the mountpoint of dataset "tank/k8s".');
      expect(update.description).toContain(
        '1 other NFS export already covers an overlapping path: id 5, "/mnt/tank/k8s/etcd" (inside this path).',
      );
      expect(update.description).toContain('`share_access` reports both');
      const [, inside] = await nfsShareUpdate.plan(system().ctx, { id: 3, path: '/mnt/tank/vms/iso' });
      // The export being moved is a parent of its own new path, and is not an overlap.
      expect(inside.description).toContain('No other NFS export on this system exports this path');
      await expect(nfsShareUpdate.plan(system().ctx, { id: 3, path: '/srv/nfs' })).rejects.toThrow(
        /Path "\/srv\/nfs" is not the mountpoint of any dataset/,
      );
      const [, unnamed] = await nfsShareUpdate.plan(
        system(undefined, [{ ...share, path: null }]).ctx,
        { id: 3, path: '/mnt/tank/k8s' },
      );
      expect(unnamed.description).toContain('This stops exporting (the system reported none)');
    });

    it('reads nothing more for a path the export already has, and says it already holds it', async () => {
      const { ctx, query } = system();
      const [, update] = await nfsShareUpdate.plan(ctx, { id: 3, path: '/mnt/tank/vms', maproot_user: 'root' });
      expect(query).toHaveBeenCalledTimes(1);
      expect(update.description).toContain('The export already holds every value this sends, which is not an error.');
      const [, cleared] = await nfsShareUpdate.plan(system().ctx, { id: 3, mapall_user: null, mapall_group: null });
      expect(cleared.description).toContain('already holds every value');
    });

    it('says switching it off cuts off clients with it mounted, and only where it can', async () => {
      const [, off] = await nfsShareUpdate.plan(system().ctx, { id: 3, enabled: false });
      expect(off.description).toContain('Disabling it cuts off every client that has it mounted now; `nfs_clients`');
      const [, already] = await nfsShareUpdate.plan(system(undefined, [{ ...share, enabled: false }]).ctx, {
        id: 3,
        enabled: false,
      });
      expect(already.description).not.toContain('cuts off');
    });
  });

  describe('what it reports', () => {
    it('reads, then updates with exactly what the plan named', async () => {
      const { ctx, call, query } = system();
      const [read, step] = await nfsShareUpdate.plan(system().ctx, args);
      await nfsShareUpdate.execute(ctx, args);
      expect(query).toHaveBeenCalledWith(read.method, (read.params as unknown[])[0]);
      expect(call).toHaveBeenCalledWith(step.method, step.params);
    });

    it('reports each field sent as a before/after pair, off the read and the response', async () => {
      const result = await nfsShareUpdate.execute(system().ctx, args);
      expect(result).toMatchObject({
        id: 3,
        requested: { hosts: ['esx1'], ro: true },
        lookup: 'FOUND',
        lookup_error: null,
        changes: {
          hosts: { requested: ['esx1'], before: [], after: ['esx1'] },
          ro: { requested: true, before: false, after: true },
        },
        changed: true,
        confirmed: true,
      });
      expect((result as { resulting: Record<string, unknown> }).resulting).toEqual({
        id: 3,
        path: '/mnt/tank/vms',
        comment: 'hypervisors',
        networks: ['10.0.0.0/24'],
        hosts: ['esx1'],
        ro: true,
        maproot_user: 'root',
        maproot_group: null,
        mapall_user: null,
        mapall_group: null,
        security: ['SYS'],
        enabled: true,
        locked: false,
      });
    });

    it('reports an export already holding the values as unchanged and confirmed', async () => {
      const result = await nfsShareUpdate.execute(system(share).ctx, { id: 3, networks: ['10.0.0.0/24'] });
      expect(result).toMatchObject({ changed: false, confirmed: true });
    });

    it('reports a call that did not apply as unchanged and NOT confirmed', async () => {
      const result = await nfsShareUpdate.execute(system(share).ctx, args);
      expect(result).toMatchObject({ changed: false, confirmed: false });
    });

    it('confirms a cleared mapping, and counts it as a change', async () => {
      const result = await nfsShareUpdate.execute(system({ ...share, maproot_user: '' }).ctx, {
        id: 3,
        maproot_user: null,
      });
      expect(result).toMatchObject({
        changes: { maproot_user: { requested: null, before: 'root', after: null } },
        changed: true,
        confirmed: true,
      });
    });

    it('still updates when the read fails, and says why the before half is missing', async () => {
      const failing = failingSystem(
        { 'sharing.nfs.update': { ...share, ro: true, hosts: ['esx1'] } },
        { 'sharing.nfs.query': new Error('connection reset') },
      );
      const result = await nfsShareUpdate.execute(failing.ctx, args);
      expect(failing.call).toHaveBeenCalledWith('sharing.nfs.update', [3, { hosts: ['esx1'], ro: true }]);
      expect(result).toMatchObject({
        lookup: 'UNREADABLE',
        lookup_error: 'connection reset',
        previous: null,
        changes: { ro: { before: null, after: true } },
        changed: null,
        confirmed: true,
      });
    });

    it('still updates when the read lists no such export', async () => {
      const result = await nfsShareUpdate.execute(system(undefined, [other]).ctx, args);
      expect(result).toMatchObject({ lookup: 'NOT_FOUND', previous: null, changed: null });
    });

    it('reports nothing established where the response is not a record', async () => {
      const result = await nfsShareUpdate.execute(system(true).ctx, args);
      expect(result).toMatchObject({
        resulting: null,
        changes: { ro: { before: false, after: null } },
        changed: null,
        confirmed: null,
      });
    });
  });
});
