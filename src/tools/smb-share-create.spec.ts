import { describe, expect, it } from 'vitest';
import { Role } from '@/interfaces';
import { fakeSystem, failingSystem } from '@/testing/fake-systems';
import { smbShareCreate } from '@/tools/index';

/**
 * `smb_share_create`'s tests live here rather than in `shares.spec.ts`, which is
 * the #87 split exception, checked: `shares.spec.ts` is 1,149 lines and this
 * block is several hundred more, so the merged file would cross 1,500. The split
 * is by tool, as `share-set-enabled.spec.ts` is.
 */

/** Every dataset as `pool.dataset.query` lists it with the walk on. */
const datasets = [
  { id: 'tank', mountpoint: '/mnt/tank' },
  { id: 'tank/projects', mountpoint: '/mnt/tank/projects' },
  { id: 'tank/vol', mountpoint: null },
  { id: 'tank/legacy', mountpoint: 'legacy' },
];

/** One SMB share already on the system. */
const existing = { id: 7, name: 'archive', path: '/mnt/tank/archive', enabled: true };

/** What `sharing.smb.create` answers with for the ordinary request below. */
const created = {
  id: 9,
  purpose: 'DEFAULT_SHARE',
  name: 'projects',
  path: '/mnt/tank/projects',
  enabled: true,
  comment: '',
  readonly: true,
  browsable: true,
  locked: false,
  audit: { enable: false },
  options: { hostsallow: [] },
};

const system = (overrides: Partial<Record<string, unknown>> = {}) =>
  fakeSystem({
    'pool.dataset.query': datasets,
    'sharing.smb.query': [existing],
    'sharing.smb.share_precheck': null,
    'sharing.smb.create': created,
    ...overrides,
  });

const args = { name: 'projects', path: '/mnt/tank/projects', readonly: true };

describe('smb_share_create', () => {
  it('is a reversible mutating tool needing the sharing role', () => {
    expect(smbShareCreate).toMatchObject({
      name: 'smb_share_create',
      mutating: true,
      destructiveness: 'reversible',
      requiredRole: Role.Sharing,
    });
  });

  it('requires name and path, and its schema takes DEFAULT_SHARE alone and no options or audit', () => {
    const schema = smbShareCreate.inputSchema as {
      properties: Record<string, { enum?: unknown[] }>;
      required: string[];
    };
    expect(schema.required).toEqual(['name', 'path']);
    expect(schema.properties['purpose'].enum).toEqual(['DEFAULT_SHARE']);
    expect(Object.keys(schema.properties)).not.toContain('options');
    expect(Object.keys(schema.properties)).not.toContain('audit');
  });

  it('says what undoing it takes, and does not claim the ACL is left unchanged', () => {
    const description = smbShareCreate.description;
    expect(description).toContain('NO TOOL IN THIS CATALOG DELETES AN SMB SHARE');
    expect(description).toContain('`share_set_enabled`');
    expect(description).toContain('`share_access`');
    expect(description).toContain(
      "This tool does not ask for any change to the dataset's ACL or permissions",
    );
    expect(description).toContain('(unconfirmed)');
    expect(description).not.toMatch(/leaves? the (dataset's )?ACL unchanged|ACL is (left )?unchanged/);
  });

  it('normalizes args: keeps the settings, drops purpose and unknown keys', () => {
    expect(
      smbShareCreate.normalizeArgs?.({ ...args, purpose: 'DEFAULT_SHARE', systems: 'all' }),
    ).toEqual(args);
  });

  describe('argument validation', () => {
    const reject = (bad: Record<string, unknown>, message: RegExp) =>
      expect(() => smbShareCreate.normalizeArgs?.(bad)).toThrow(message);

    it('refuses options and audit by name rather than dropping them', () => {
      reject({ ...args, options: {} }, /"options" is not accepted by this tool/);
      reject({ ...args, audit: { enable: true } }, /"audit" is not accepted by this tool/);
    });

    it('refuses every purpose but DEFAULT_SHARE', () => {
      for (const purpose of ['LEGACY_SHARE', 'TIMEMACHINE_SHARE', 'EXTERNAL_SHARE', 'default_share', 1]) {
        reject({ ...args, purpose }, /"purpose" may only be "DEFAULT_SHARE"/);
      }
    });

    it('requires a non-empty name and an absolute path', () => {
      reject({ path: args.path }, /"name" is required/);
      reject({ name: 'projects' }, /"path" is required/);
      reject({ ...args, name: '' }, /"name" must be a non-empty string/);
      reject({ ...args, name: 3 }, /"name" must be a non-empty string/);
      reject({ ...args, path: 'tank/projects' }, /"path" must be an absolute path/);
      reject({ ...args, path: 7 }, /"path" must be an absolute path/);
    });

    it('refuses a path not written plainly, which would be compared to the wrong mountpoint', () => {
      for (const path of [
        '/mnt/tank/../../etc',
        '/mnt/tank/../other/data',
        '/mnt/tank/./projects',
        '/mnt/tank/..',
        '/mnt/tank//projects',
        '/mnt//tank/projects',
        '/mnt/tank/projects/',
        '/',
      ]) {
        reject({ ...args, path }, /"path" must be written plainly: no empty, "." or ".." segment and no trailing slash/);
      }
      // A dot inside a name is an ordinary directory name.
      expect(smbShareCreate.normalizeArgs?.({ ...args, path: '/mnt/tank/projects/.hidden..x' })).toMatchObject({
        path: '/mnt/tank/projects/.hidden..x',
      });
    });

    it('refuses EXTERNAL, which belongs to a preset this tool does not create', () => {
      reject({ ...args, path: 'EXTERNAL' }, /"path" may not be "EXTERNAL"/);
    });

    it('coerces nothing into a boolean or a comment', () => {
      for (const key of ['readonly', 'browsable', 'enabled']) {
        reject({ ...args, [key]: 'false' }, new RegExp(`"${key}" must be a boolean`));
      }
      reject({ ...args, comment: 5 }, /"comment" must be a string/);
    });

    it('executes nothing when an argument is unreadable', async () => {
      const { ctx, query, call } = system();
      await expect(smbShareCreate.execute(ctx, { ...args, purpose: 'LEGACY_SHARE' })).rejects.toThrow(
        /"purpose" may only be/,
      );
      expect(query).not.toHaveBeenCalled();
      expect(call).not.toHaveBeenCalled();
    });
  });

  describe('the plan it returns', () => {
    it('is the create alone, sending DEFAULT_SHARE and exactly the settings passed', async () => {
      const steps = await smbShareCreate.plan(system().ctx, args);
      expect(steps).toHaveLength(1);
      expect(steps[0].method).toBe('sharing.smb.create');
      expect(steps[0].params).toEqual([
        { purpose: 'DEFAULT_SHARE', name: 'projects', path: '/mnt/tank/projects', readonly: true },
      ]);
      expect(steps[0].description).toContain(
        'Create an SMB share with purpose "DEFAULT_SHARE", name "projects", path "/mnt/tank/projects", readonly true.',
      );
    });

    it("names the dataset whose mountpoint the path is", async () => {
      const [step] = await smbShareCreate.plan(system().ctx, args);
      expect(step.description).toContain('Path "/mnt/tank/projects" is the mountpoint of dataset "tank/projects".');
      // A mountpoint the system reports with a trailing slash names the same directory.
      const [slashed] = await smbShareCreate.plan(
        system({ 'pool.dataset.query': [{ id: 'tank/projects', mountpoint: '/mnt/tank/projects/' }] }).ctx,
        args,
      );
      expect(slashed.description).toContain('is the mountpoint of dataset "tank/projects"');
    });

    it('names the deepest dataset a subdirectory sits inside, and does not refuse it', async () => {
      const [step] = await smbShareCreate.plan(system().ctx, { ...args, path: '/mnt/tank/projects/q3' });
      expect(step.description).toContain(
        'Path "/mnt/tank/projects/q3" is a directory inside dataset "tank/projects", which is mounted at "/mnt/tank/projects"',
      );
      expect(step.description).toContain('whether the directory exists is not checked here');
    });

    it('fails on a path that is no dataset’s mountpoint and inside none, naming it', async () => {
      for (const path of ['/srv/data', '/mnt/tankette', '/mnt']) {
        await expect(smbShareCreate.plan(system().ctx, { ...args, path })).rejects.toThrow(
          new RegExp(`Path "${path}" is not the mountpoint of any dataset this system lists, and not inside one`),
        );
      }
    });

    it('compares the mountpoint on the response, so a dropped filter cannot answer for another dataset', async () => {
      const { ctx, query } = system();
      await smbShareCreate.plan(ctx, args);
      expect(query).toHaveBeenCalledWith('pool.dataset.query', [], {
        extra: { retrieve_children: true, properties: [] },
      });
    });

    it('counts a dataset row it could not read, rather than letting the parent stand unqualified', async () => {
      const rows = [{ id: 'tank', mountpoint: '/mnt/tank' }, { mountpoint: '/mnt/tank/projects' }, 'junk'];
      const [step] = await smbShareCreate.plan(system({ 'pool.dataset.query': rows }).ctx, args);
      expect(step.description).toContain('is a directory inside dataset "tank"');
      expect(step.description).toContain(
        '2 datasets could not be read, so the path may belong to one of them rather than to the dataset named.',
      );
      await expect(
        smbShareCreate.plan(system({ 'pool.dataset.query': [{ mountpoint: '/mnt/x' }] }).ctx, {
          ...args,
          path: '/srv/x',
        }),
      ).rejects.toThrow(/1 dataset could not be read, and so could not be compared/);
    });

    it('fails, naming why, when the datasets could not be read at all', async () => {
      const failing = failingSystem(
        { 'sharing.smb.query': [], 'sharing.smb.share_precheck': null },
        { 'pool.dataset.query': { reason: 'pool is exporting' } },
      );
      await expect(smbShareCreate.plan(failing.ctx, args)).rejects.toThrow(
        /Which dataset path "\/mnt\/tank\/projects" belongs to could not be read \(pool.dataset.query failed: pool is exporting\)/,
      );
      await expect(
        smbShareCreate.plan(system({ 'pool.dataset.query': { rows: [] } }).ctx, args),
      ).rejects.toThrow(/pool.dataset.query did not answer with a list/);
    });

    it('says the path becomes reachable, points at share_access, and settles nothing about the ACL', async () => {
      const [step] = await smbShareCreate.plan(system().ctx, args);
      expect(step.description).toContain(
        "Path \"/mnt/tank/projects\" becomes reachable over SMB by whoever the dataset's ACL admits",
      );
      expect(step.description).toContain('`share_access` reports who that is');
      expect(step.description).toContain(
        "does not ask for any change to the dataset's ACL or permissions; whether the system changes them on its own is (unconfirmed).",
      );
    });

    it('names the settings it leaves to the system, and only those', async () => {
      const [step] = await smbShareCreate.plan(system().ctx, args);
      expect(step.description).toContain(
        "Not sent, and so left to the system's defaults, which are not read here: comment, browsable, enabled.",
      );
      const [all] = await smbShareCreate.plan(system().ctx, {
        ...args,
        comment: '',
        browsable: false,
        enabled: true,
      });
      expect(all.description).not.toContain('Not sent');
      expect(all.description).toContain('comment "", readonly true, browsable false, enabled true.');
    });

    it('names an existing share whose name matches ignoring case', async () => {
      const clash = { id: 4, name: 'Projects', path: '/mnt/tank/old' };
      const [step] = await smbShareCreate.plan(
        system({ 'sharing.smb.query': [existing, clash] }).ctx,
        args,
      );
      expect(step.description).toContain(
        '1 other SMB share already has this name, ignoring letter case: "Projects" (id 4, path "/mnt/tank/old").',
      );
      expect(step.description).toContain('whether the system refuses this one is (unconfirmed)');
      expect(step.description).not.toContain('"archive"');
    });

    it('says no other share has the name, and counts one whose name it could not read', async () => {
      const [clear] = await smbShareCreate.plan(system().ctx, args);
      expect(clear.description).toContain('No other SMB share on this system has this name in any letter case.');
      const [unread] = await smbShareCreate.plan(
        system({ 'sharing.smb.query': [existing, { id: 5, name: '' }, 'junk'] }).ctx,
        args,
      );
      expect(unread.description).toContain('2 other SMB shares reported no name this tool could read.');
    });

    it('states rather than fails when the existing shares could not be read', async () => {
      const failing = failingSystem(
        { 'pool.dataset.query': datasets, 'sharing.smb.share_precheck': null },
        { 'sharing.smb.query': new Error('SMB service is not running') },
      );
      const [step] = await smbShareCreate.plan(failing.ctx, args);
      expect(step.description).toContain(
        'Whether another SMB share already has this name could not be read (sharing.smb.query failed: SMB service is not running).',
      );
      const [notList] = await smbShareCreate.plan(system({ 'sharing.smb.query': 3 }).ctx, args);
      expect(notList.description).toContain('(sharing.smb.query did not answer with a list)');
    });

    it('runs the pre-check with the share name and says it accepted', async () => {
      const { ctx, call } = system();
      const [step] = await smbShareCreate.plan(ctx, args);
      expect(call).toHaveBeenCalledWith('sharing.smb.share_precheck', [{ name: 'projects' }]);
      expect(step.description).toContain(
        "The system's own SMB share pre-check (sharing.smb.share_precheck) accepted it; what that check covers is (unconfirmed).",
      );
    });

    it('fails the plan with the reason when the pre-check refuses', async () => {
      const failing = failingSystem(
        { 'pool.dataset.query': datasets, 'sharing.smb.query': [] },
        { 'sharing.smb.share_precheck': { reason: 'a share with this name already exists' } },
      );
      await expect(smbShareCreate.plan(failing.ctx, args)).rejects.toThrow(
        "The system's SMB share pre-check refused this share: a share with this name already exists",
      );
    });

    it('does not fail the plan when the pre-check cannot be called, and says it was not run', async () => {
      const failing = failingSystem(
        { 'pool.dataset.query': datasets, 'sharing.smb.query': [] },
        { 'sharing.smb.share_precheck': { errname: 'ENOMETHOD', reason: 'Method does not exist' } },
      );
      const [step] = await smbShareCreate.plan(failing.ctx, args);
      expect(step.description).toContain(
        'could not be called — this system has no such method — so it was not run.',
      );
    });
  });

  describe('what it reports', () => {
    it('creates with exactly what the plan named, and makes no other call', async () => {
      const { ctx, call, query } = system();
      const [step] = await smbShareCreate.plan(system().ctx, args);
      await smbShareCreate.execute(ctx, args);
      expect(call).toHaveBeenCalledTimes(1);
      expect(call).toHaveBeenCalledWith(step.method, step.params);
      // The path check and the pre-check are the plan's, not made again.
      expect(query).not.toHaveBeenCalled();
    });

    it('reads the share off the response through named fields, and confirms what was sent', async () => {
      const result = await smbShareCreate.execute(system().ctx, args);
      expect(result).toEqual({
        requested: { purpose: 'DEFAULT_SHARE', name: 'projects', path: '/mnt/tank/projects', readonly: true },
        share: {
          id: 9,
          name: 'projects',
          path: '/mnt/tank/projects',
          purpose: 'DEFAULT_SHARE',
          enabled: true,
          comment: '',
          readonly: true,
          browsable: true,
          locked: false,
        },
        confirmed: true,
      });
    });

    it('reports a value stored as something else as unconfirmed, not as a success', async () => {
      const result = (await smbShareCreate.execute(
        system({ 'sharing.smb.create': { ...created, readonly: false } }).ctx,
        args,
      )) as { confirmed: unknown };
      expect(result.confirmed).toBe(false);
      const renamed = (await smbShareCreate.execute(
        system({ 'sharing.smb.create': { ...created, name: 'Projects' } }).ctx,
        args,
      )) as { confirmed: unknown };
      expect(renamed.confirmed).toBe(false);
      const otherPurpose = (await smbShareCreate.execute(
        system({ 'sharing.smb.create': { ...created, purpose: 'LEGACY_SHARE' } }).ctx,
        args,
      )) as { confirmed: unknown };
      expect(otherPurpose.confirmed).toBe(false);
    });

    it('reads a comment cleared to "" back as itself, so clearing one is confirmable', async () => {
      const result = (await smbShareCreate.execute(system().ctx, { ...args, comment: '' })) as {
        share: { comment: unknown };
        confirmed: unknown;
      };
      expect(result.share.comment).toBe('');
      expect(result.confirmed).toBe(true);
    });

    it('is null rather than true where a value sent could not be read back', async () => {
      const result = (await smbShareCreate.execute(
        system({ 'sharing.smb.create': { ...created, readonly: 'yes' } }).ctx,
        args,
      )) as { share: { readonly: unknown }; confirmed: unknown };
      expect(result.share.readonly).toBeNull();
      expect(result.confirmed).toBeNull();
    });

    it('reports no share and no confirmation where the response is not a record', async () => {
      for (const response of [null, true, [created]]) {
        const result = await smbShareCreate.execute(system({ 'sharing.smb.create': response }).ctx, args);
        expect(result).toMatchObject({ share: null, confirmed: null });
      }
    });
  });
});
