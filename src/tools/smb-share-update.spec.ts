import { describe, expect, it } from 'vitest';
import { Role } from '@/interfaces';
import { fakeSystem, failingSystem } from '@/testing/fake-systems';
import { smbShareUpdate } from '@/tools/index';

/**
 * `smb_share_update`'s tests live here rather than in `shares.spec.ts`, for the
 * #87 reason `smb-share-create.spec.ts` gives: the merged file would cross the
 * 1,500-line trigger. The split is by tool.
 */

/** The share being changed, as `sharing.smb.query` lists it. */
const share = {
  id: 3,
  purpose: 'DEFAULT_SHARE',
  name: 'guests',
  path: '/mnt/tank/guests',
  enabled: true,
  comment: 'guest drop box',
  readonly: false,
  browsable: true,
  locked: false,
};

/** Another share on the same system. */
const other = { id: 4, name: 'media', path: '/mnt/tank/media' };

const datasets = [
  { id: 'tank', mountpoint: '/mnt/tank' },
  { id: 'tank/guests', mountpoint: '/mnt/tank/guests' },
  { id: 'tank/public', mountpoint: '/mnt/tank/public' },
];

/** A system listing those rows, and answering the update with `updated`. */
const system = (updated: unknown = { ...share, comment: 'visitors', readonly: true }, rows: unknown = [share, other]) =>
  fakeSystem({
    'sharing.smb.query': rows,
    'pool.dataset.query': datasets,
    'sharing.smb.update': updated,
  });

const args = { id: 3, comment: 'visitors', readonly: true };

describe('smb_share_update', () => {
  it('is a reversible mutating tool needing the sharing role', () => {
    expect(smbShareUpdate).toMatchObject({
      name: 'smb_share_update',
      mutating: true,
      destructiveness: 'reversible',
      requiredRole: Role.Sharing,
    });
  });

  it('requires the id, and its schema takes no purpose, options or audit', () => {
    const schema = smbShareUpdate.inputSchema as { properties: Record<string, unknown>; required: string[] };
    expect(schema.required).toEqual(['id']);
    for (const key of ['purpose', 'options', 'audit']) {
      expect(Object.keys(schema.properties)).not.toContain(key);
    }
  });

  it('says the id is an SMB share’s and that the plan carries the values it replaces', () => {
    const description = smbShareUpdate.description;
    expect(description).toContain('PLANNING AGAINST AN id NO SMB SHARE HAS FAILS');
    expect(description).toContain("an NFS export's id is a different table");
    expect(description).toContain('THE PLAN STATES EACH VALUE SENT BESIDE THE ONE THE SHARE HOLDS NOW');
    expect(description).toContain('`changed` must not be read without it');
  });

  it('normalizes args: keeps the id and the settings passed, drops unknown keys', () => {
    expect(smbShareUpdate.normalizeArgs?.({ ...args, systems: 'all' })).toEqual(args);
  });

  describe('argument validation', () => {
    const reject = (bad: Record<string, unknown>, message: RegExp) =>
      expect(() => smbShareUpdate.normalizeArgs?.(bad)).toThrow(message);

    it('requires a whole-number id', () => {
      for (const id of [undefined, null, '3', 3.5]) {
        reject({ ...args, id }, /"id" is required and must be a whole number/);
      }
    });

    it('requires something to change', () => {
      reject({ id: 3 }, /Nothing to change: pass at least one of name, path, comment, readonly, browsable, enabled/);
    });

    it('refuses purpose, options and audit by name', () => {
      reject({ ...args, purpose: 'DEFAULT_SHARE' }, /"purpose" is not accepted by this tool: this tool leaves/);
      reject({ ...args, options: {} }, /"options" is not accepted by this tool/);
      reject({ ...args, audit: {} }, /"audit" is not accepted by this tool/);
    });

    it('validates each setting the way the create does', () => {
      reject({ id: 3, path: 'EXTERNAL' }, /"path" may not be "EXTERNAL"/);
      reject({ id: 3, path: 'relative' }, /"path" must be an absolute path/);
      reject({ id: 3, name: '' }, /"name" must be a non-empty string/);
      reject({ id: 3, enabled: 'false' }, /"enabled" must be a boolean/);
    });
  });

  describe('the plan it returns', () => {
    it('plans the read it makes and the update, sending only the fields passed', async () => {
      const steps = await smbShareUpdate.plan(system().ctx, args);
      expect(steps.map((step) => step.method)).toEqual(['sharing.smb.query', 'sharing.smb.update']);
      expect(steps[0]).toMatchObject({ params: [[['id', '=', 3]], {}] });
      expect(steps[0].description).toMatch(/Read this system's SMB share with id 3/);
      expect(steps[1].params).toEqual([3, { comment: 'visitors', readonly: true }]);
    });

    it('names the share and states each value beside the one it holds now', async () => {
      const [, update] = await smbShareUpdate.plan(system().ctx, args);
      expect(update.description).toContain(
        'Change the SMB share with name "guests", path "/mnt/tank/guests" (id 3): ' +
          'comment "visitors" (now "guest drop box"); readonly true (now false). Only these fields are sent.',
      );
    });

    it('states a value the share reported none for, rather than dropping it', async () => {
      const [, update] = await smbShareUpdate.plan(
        system(undefined, [{ ...share, readonly: 'no' }]).ctx,
        args,
      );
      expect(update.description).toContain('readonly true (now (the system reported none))');
    });

    it('fails on an id no SMB share has, comparing ids on the response', async () => {
      // A filter that did not apply answers with the whole table; its first row
      // is some other share.
      await expect(smbShareUpdate.plan(system(undefined, [other]).ctx, args)).rejects.toThrow(
        /No SMB share with id 3 on this system — ids come from `shares_list`/,
      );
      await expect(smbShareUpdate.plan(system(undefined, []).ctx, args)).rejects.toThrow(/No SMB share with id 3/);
    });

    it('says a rename loses clients connecting by the old name, and names a clash ignoring case', async () => {
      const [, update] = await smbShareUpdate.plan(system().ctx, { id: 3, name: 'Media' });
      expect(update.description).toContain(
        'Clients that connect by the name "guests" will no longer find the share under it.',
      );
      expect(update.description).toContain(
        '1 other SMB share already has this name, ignoring letter case: "media" (id 4, path "/mnt/tank/media").',
      );
    });

    it('does not count the share being renamed as a clash with itself', async () => {
      const [, update] = await smbShareUpdate.plan(system().ctx, { id: 3, name: 'GUESTS' });
      expect(update.description).toContain('No other SMB share on this system has this name in any letter case.');
    });

    it('checks a new path against the datasets, and says what it stops and starts sharing', async () => {
      const [, update] = await smbShareUpdate.plan(system().ctx, { id: 3, path: '/mnt/tank/public' });
      expect(update.description).toContain('This stops sharing "/mnt/tank/guests".');
      expect(update.description).toContain('Path "/mnt/tank/public" is the mountpoint of dataset "tank/public".');
      expect(update.description).toContain('`share_access` reports who that is');
      await expect(smbShareUpdate.plan(system().ctx, { id: 3, path: '/srv/elsewhere' })).rejects.toThrow(
        /Path "\/srv\/elsewhere" is not the mountpoint of any dataset/,
      );
    });

    it('reads nothing more for a name or path the share already has', async () => {
      const { ctx, query } = system();
      const [, update] = await smbShareUpdate.plan(ctx, { id: 3, name: 'guests', path: '/mnt/tank/guests' });
      expect(query).toHaveBeenCalledTimes(1);
      expect(update.description).toContain('The share already holds every value this sends, which is not an error.');
    });

    it('says switching it off cuts off connected clients, and only where it can', async () => {
      const [, off] = await smbShareUpdate.plan(system().ctx, { id: 3, enabled: false });
      expect(off.description).toContain('Disabling it cuts off every client connected to it now.');
      const [, already] = await smbShareUpdate.plan(
        system(undefined, [{ ...share, enabled: false }]).ctx,
        { id: 3, enabled: false },
      );
      expect(already.description).not.toContain('cuts off');
      const [, on] = await smbShareUpdate.plan(system().ctx, { id: 3, enabled: true });
      expect(on.description).not.toContain('cuts off');
    });
  });

  describe('what it reports', () => {
    it('reads, then updates with exactly what the plan named', async () => {
      const { ctx, call, query } = system();
      const [read, step] = await smbShareUpdate.plan(system().ctx, args);
      await smbShareUpdate.execute(ctx, args);
      expect(query).toHaveBeenCalledWith(read.method, (read.params as unknown[])[0]);
      expect(call).toHaveBeenCalledWith(step.method, step.params);
    });

    it('reports each field sent as a before/after pair, off the read and the response', async () => {
      const result = await smbShareUpdate.execute(system().ctx, args);
      expect(result).toMatchObject({
        id: 3,
        requested: { comment: 'visitors', readonly: true },
        lookup: 'FOUND',
        lookup_error: null,
        changes: {
          comment: { requested: 'visitors', before: 'guest drop box', after: 'visitors' },
          readonly: { requested: true, before: false, after: true },
        },
        changed: true,
        confirmed: true,
      });
      expect((result as { resulting: Record<string, unknown> }).resulting).toEqual({
        id: 3,
        name: 'guests',
        path: '/mnt/tank/guests',
        purpose: 'DEFAULT_SHARE',
        enabled: true,
        comment: 'visitors',
        readonly: true,
        browsable: true,
        locked: false,
      });
    });

    it('reports a share already holding the values as unchanged and confirmed', async () => {
      const result = await smbShareUpdate.execute(system(share).ctx, { id: 3, comment: 'guest drop box' });
      expect(result).toMatchObject({ changed: false, confirmed: true });
    });

    it('reports a call that did not apply as unchanged and NOT confirmed', async () => {
      const result = await smbShareUpdate.execute(system(share).ctx, args);
      expect(result).toMatchObject({ changed: false, confirmed: false });
    });

    it('confirms a comment cleared to ""', async () => {
      const result = await smbShareUpdate.execute(system({ ...share, comment: '' }).ctx, { id: 3, comment: '' });
      expect(result).toMatchObject({
        changes: { comment: { requested: '', before: 'guest drop box', after: '' } },
        changed: true,
        confirmed: true,
      });
    });

    it('still updates when the read fails, and says why the before half is missing', async () => {
      const failing = failingSystem(
        { 'sharing.smb.update': { ...share, comment: 'visitors', readonly: true } },
        { 'sharing.smb.query': new Error('connection reset') },
      );
      const result = await smbShareUpdate.execute(failing.ctx, args);
      expect(failing.call).toHaveBeenCalledWith('sharing.smb.update', [3, { comment: 'visitors', readonly: true }]);
      expect(result).toMatchObject({
        lookup: 'UNREADABLE',
        lookup_error: 'connection reset',
        previous: null,
        changes: { readonly: { before: null, after: true } },
        changed: null,
        confirmed: true,
      });
    });

    it('still updates when the read lists no such share', async () => {
      const result = await smbShareUpdate.execute(system(undefined, [other]).ctx, args);
      expect(result).toMatchObject({ lookup: 'NOT_FOUND', previous: null, changed: null });
    });

    it('reports nothing established where the response is not a record', async () => {
      const result = await smbShareUpdate.execute(system(true).ctx, args);
      expect(result).toMatchObject({
        resulting: null,
        changes: { comment: { before: 'guest drop box', after: null } },
        changed: null,
        confirmed: null,
      });
    });
  });
});
