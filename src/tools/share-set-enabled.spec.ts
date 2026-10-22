import { describe, expect, it } from 'vitest';
import { Role } from '@/interfaces';
import { fakeSystem, failingSystem } from '@/testing/fake-systems';
import { shareSetEnabled } from '@/tools/index';

/**
 * `share_set_enabled`'s tests live here rather than in `shares.spec.ts`, which
 * is the #87 split exception and is CHECKED rather than felt: `shares.spec.ts`
 * is 1,149 lines and this block is about 400 more, so the merged file crosses
 * the 1,500-line trigger. The split is by tool, as
 * `scheduled-task-set-enabled.spec.ts` is; the two listing tools stay where
 * they are.
 */

/** One SMB share as `sharing.smb.query` answers with it. */
const smbShare = {
  id: 3,
  name: 'guests',
  path: '/mnt/tank/guests',
  enabled: true,
  comment: 'guest drop box',
  locked: false,
};

/** One NFS export as `sharing.nfs.query` answers with it. */
const nfsExport = {
  id: 3,
  path: '/mnt/tank/media',
  aliases: ['/media'],
  enabled: true,
  comment: '',
  locked: false,
};

/**
 * A system listing those rows and answering each update with the row as it
 * would be after switching it off — which is what both update methods answer
 * with.
 */
const system = (
  smbRows: unknown = [smbShare],
  nfsRows: unknown = [nfsExport],
  updates: { smb?: unknown; nfs?: unknown } = {},
) =>
  fakeSystem({
    'sharing.smb.query': smbRows,
    'sharing.nfs.query': nfsRows,
    'sharing.smb.update': 'smb' in updates ? updates.smb : { ...smbShare, enabled: false },
    'sharing.nfs.update': 'nfs' in updates ? updates.nfs : { ...nfsExport, enabled: false },
  });

/** The args for the ordinary cases: switch share 3 off. */
const smbOff = { protocol: 'SMB', id: 3, enabled: false };
const nfsOff = { protocol: 'NFS', id: 3, enabled: false };

describe('share_set_enabled', () => {
  it('is a reversible mutating tool needing the sharing role', () => {
    expect(shareSetEnabled).toMatchObject({
      name: 'share_set_enabled',
      mutating: true,
      destructiveness: 'reversible',
      requiredRole: Role.Sharing,
    });
  });

  it('requires the protocol, the id and the state', () => {
    const schema = shareSetEnabled.inputSchema as {
      properties: Record<string, { enum?: unknown[] }>;
      required: string[];
    };
    expect(schema.required).toEqual(['protocol', 'id', 'enabled']);
    expect(schema.properties['protocol'].enum).toEqual(['SMB', 'NFS']);
  });

  it('says the id is per protocol and where both come from', () => {
    const description = shareSetEnabled.description;
    expect(description).toContain('`id` ALONE IS NEVER ENOUGH');
    expect(description).toContain('`shares_list`');
    expect(description).toContain('ONLY THE `enabled` FIELD IS SENT');
    expect(description).toContain('`service_control`');
  });

  it('says disabling cuts off connected clients, and where each protocol reports them', () => {
    const description = shareSetEnabled.description;
    expect(description).toContain('DISABLING A SHARE CUTS OFF THE CLIENTS CONNECTED TO IT NOW');
    expect(description).toContain('`nfs_clients`');
    expect(description).toContain('for SMB this catalog has no session listing');
  });

  it('does not let `changed: false` claim the share was already in the requested state', () => {
    const description = shareSetEnabled.description;
    expect(description).toContain('WHICH IS TWO OUTCOMES AND NOT ONE');
    expect(description).toContain('`changed` must not be read without it');
  });

  it('says a locked share serves nothing even when enabled', () => {
    expect(shareSetEnabled.description).toContain('WHICH SERVES NOTHING EVEN WHEN ENABLED');
  });

  it('normalizes args: keeps the three and drops unknown keys', () => {
    expect(
      shareSetEnabled.normalizeArgs?.({
        protocol: 'NFS',
        id: 3,
        enabled: true,
        extra: 1,
        systems: 'all',
      }),
    ).toEqual({ protocol: 'NFS', id: 3, enabled: true });
  });

  describe('argument validation', () => {
    const ctx = system().ctx;

    it('requires a protocol of SMB or NFS', async () => {
      // Case matters: the enum is what `shares_list` reports, and a loosely
      // read protocol would act on the other table's id.
      for (const bad of [undefined, null, 'smb', 'ISCSI', 1]) {
        expect(() =>
          shareSetEnabled.normalizeArgs?.({ protocol: bad, id: 3, enabled: false }),
        ).toThrow(/"protocol" is required and must be "SMB" or "NFS"/);
        await expect(
          shareSetEnabled.plan(ctx, { protocol: bad, id: 3, enabled: false }),
        ).rejects.toThrow(/"protocol" is required/);
      }
    });

    it('requires a whole-number id', async () => {
      for (const bad of [undefined, null, '3', 3.5, Number.NaN]) {
        expect(() => shareSetEnabled.normalizeArgs?.({ ...smbOff, id: bad })).toThrow(
          /"id" is required and must be a whole number/,
        );
        await expect(shareSetEnabled.plan(ctx, { ...smbOff, id: bad })).rejects.toThrow(
          /"id" is required/,
        );
      }
    });

    it('requires a boolean enabled and coerces nothing into one', async () => {
      // Coercing "false" to true would switch ON a share the caller asked to
      // switch off.
      for (const bad of [undefined, null, 'false', 0, 1]) {
        expect(() => shareSetEnabled.normalizeArgs?.({ ...smbOff, enabled: bad })).toThrow(
          /"enabled" is required and must be a boolean/,
        );
        await expect(shareSetEnabled.plan(ctx, { ...smbOff, enabled: bad })).rejects.toThrow(
          /"enabled" is required/,
        );
      }
    });

    it('executes nothing when an argument is unreadable', async () => {
      const { ctx: own, query, call } = system();
      await expect(shareSetEnabled.execute(own, { ...smbOff, protocol: 'smb' })).rejects.toThrow(
        /"protocol" is required/,
      );
      expect(query).not.toHaveBeenCalled();
      expect(call).not.toHaveBeenCalled();
    });
  });

  describe('the plan it returns', () => {
    it('plans the read it makes as well as the mutation, on the protocol asked for', async () => {
      const smb = await shareSetEnabled.plan(system().ctx, smbOff);
      expect(smb.map((step) => step.method)).toEqual(['sharing.smb.query', 'sharing.smb.update']);
      expect(smb[0]).toMatchObject({ params: [[['id', '=', 3]], {}] });
      expect(smb[0].description).toMatch(/Read this system's SMB share with id 3/);
      expect(smb[0].description).toMatch(/Changes nothing/);
      const nfs = await shareSetEnabled.plan(system().ctx, nfsOff);
      expect(nfs.map((step) => step.method)).toEqual(['sharing.nfs.query', 'sharing.nfs.update']);
      expect(nfs[0].description).toMatch(/Read this system's NFS export with id 3/);
    });

    it('sends only the enabled field, and sends the state that was asked for', async () => {
      const [, off] = await shareSetEnabled.plan(system().ctx, smbOff);
      expect(off.params).toEqual([3, { enabled: false }]);
      expect(off.description).toContain('Only the enabled flag is sent');
      const disabled = { ...smbShare, enabled: false };
      const [, on] = await shareSetEnabled.plan(system([disabled]).ctx, {
        ...smbOff,
        enabled: true,
      });
      expect(on.params).toEqual([3, { enabled: true }]);
    });

    it('names an SMB share by its name and path', async () => {
      const [, mutation] = await shareSetEnabled.plan(system().ctx, smbOff);
      expect(mutation.description).toContain(
        'Disable the SMB share with name "guests", path "/mnt/tank/guests" (id 3).',
      );
    });

    it('names an NFS export by its path and aliases', async () => {
      const [, mutation] = await shareSetEnabled.plan(system().ctx, nfsOff);
      expect(mutation.description).toContain(
        'Disable the NFS export with path "/mnt/tank/media", aliases "/media" (id 3).',
      );
    });

    it('says an NFS export with an empty alias list has none', async () => {
      const [, mutation] = await shareSetEnabled.plan(
        system(undefined, [{ ...nfsExport, aliases: [] }]).ctx,
        nfsOff,
      );
      expect(mutation.description).toContain('path "/mnt/tank/media", no aliases (id 3)');
    });

    it('states an unreadable label rather than dropping it or reading it as empty', async () => {
      const smb = await shareSetEnabled.plan(
        system([{ ...smbShare, name: '', path: null }]).ctx,
        smbOff,
      );
      expect(smb[1].description).toContain(
        'name (the system reported none), path (the system reported none)',
      );
      // One alias that is not text makes the list unreadable, not shorter: a
      // shorter list would name the export by fewer paths than it answers to.
      for (const aliases of [undefined, 'one', ['/media', 7]]) {
        const nfs = await shareSetEnabled.plan(
          system(undefined, [{ ...nfsExport, aliases }]).ctx,
          nfsOff,
        );
        expect(nfs[1].description).toContain('aliases (the system reported none)');
        expect(nfs[1].description).not.toContain('no aliases');
      }
    });

    it('says disabling an SMB share cuts off its clients, and that nobody listed them', async () => {
      const [, mutation] = await shareSetEnabled.plan(system().ctx, smbOff);
      expect(mutation.description).toContain(
        'Disabling it cuts off every client connected to it now.',
      );
      expect(mutation.description).toContain(
        'This catalog has no listing of SMB sessions, so whether anyone is connected is NOT established here.',
      );
    });

    it('says disabling an NFS export cuts off its clients, and points at nfs_clients', async () => {
      const [, mutation] = await shareSetEnabled.plan(system().ctx, nfsOff);
      expect(mutation.description).toContain(
        'Disabling it cuts off every client that has it mounted now; `nfs_clients` reports',
      );
    });

    it('says nothing about cutting clients off where there is nobody to cut off', async () => {
      // Enabling cuts nobody off, and a share already read as disabled has
      // nobody connected to it.
      const disabled = { ...smbShare, enabled: false };
      const [, enabling] = await shareSetEnabled.plan(system([disabled]).ctx, {
        ...smbOff,
        enabled: true,
      });
      expect(enabling.description).not.toContain('cuts off');
      const [, already] = await shareSetEnabled.plan(system([disabled]).ctx, smbOff);
      expect(already.description).not.toContain('cuts off');
      expect(already.description).toContain(
        'It is already disabled, so this changes nothing and is not an error.',
      );
    });

    it('still warns about clients where the current state could not be read', async () => {
      const [, mutation] = await shareSetEnabled.plan(
        system([{ ...smbShare, enabled: 'yes' }]).ctx,
        smbOff,
      );
      expect(mutation.description).toContain(
        'Whether it is enabled could not be read, so this may change nothing.',
      );
      expect(mutation.description).toContain('Disabling it cuts off every client');
    });

    it('says which way the switch will move', async () => {
      const [, disabling] = await shareSetEnabled.plan(system().ctx, smbOff);
      expect(disabling.description).toContain('It is enabled, so this will disable it.');
      const [, enabling] = await shareSetEnabled.plan(
        system(undefined, [{ ...nfsExport, enabled: false }]).ctx,
        { ...nfsOff, enabled: true },
      );
      expect(enabling.description).toContain('Enable the NFS export');
      expect(enabling.description).toContain('It is disabled, so this will enable it.');
    });

    it('says so when the share sits on a locked dataset, and only then', async () => {
      const [, locked] = await shareSetEnabled.plan(
        system([{ ...smbShare, locked: true }]).ctx,
        { ...smbOff, enabled: true },
      );
      expect(locked.description).toContain('THE DATASET IT SHARES IS LOCKED');
      for (const value of [false, null, undefined]) {
        const [, mutation] = await shareSetEnabled.plan(
          system([{ ...smbShare, locked: value }]).ctx,
          smbOff,
        );
        expect(mutation.description).not.toContain('LOCKED');
      }
    });

    it('fails when no share of that protocol has the id, naming both and shares_list', async () => {
      await expect(
        shareSetEnabled.plan(system([{ ...smbShare, id: 4 }]).ctx, smbOff),
      ).rejects.toThrow(
        /No SMB share with id 3 on this system — the protocol searched was "SMB", and the ids this tool takes come from `shares_list`/,
      );
      await expect(shareSetEnabled.plan(system(undefined, []).ctx, nfsOff)).rejects.toThrow(
        /No NFS export with id 3 on this system — the protocol searched was "NFS"/,
      );
    });
  });

  describe('the id it acts on', () => {
    it('reads only the protocol asked for', async () => {
      // The same id under the other protocol is a different share, so it must
      // not be the one the plan describes.
      const { ctx, query } = system();
      await shareSetEnabled.plan(ctx, nfsOff);
      expect(query).toHaveBeenCalledWith('sharing.nfs.query', [['id', '=', 3]]);
      expect(query).not.toHaveBeenCalledWith('sharing.smb.query', expect.anything());
    });

    it('re-checks the id on the response rather than trusting the filter', async () => {
      // An unrecognised query parameter is dropped rather than refused, so a
      // filter that did not apply comes back as the whole table — and its first
      // row is a different share.
      const whole = [{ ...smbShare, id: 1, name: 'first' }, { ...smbShare, id: 2 }, smbShare];
      const [, mutation] = await shareSetEnabled.plan(system(whole).ctx, smbOff);
      expect(mutation.params).toEqual([3, { enabled: false }]);
      expect(mutation.description).toContain('name "guests"');
      expect(mutation.description).not.toContain('name "first"');
    });

    it('treats an answer that is not a list as no share with that id', async () => {
      await expect(shareSetEnabled.plan(system(7).ctx, smbOff)).rejects.toThrow(
        /No SMB share with id 3/,
      );
    });
  });

  describe('the outcome it reports', () => {
    it('executes the read and then the update the plan named', async () => {
      const { ctx, query, call } = system();
      await shareSetEnabled.execute(ctx, nfsOff);
      expect(query).toHaveBeenCalledWith('sharing.nfs.query', [['id', '=', 3]]);
      expect(call).toHaveBeenCalledWith('sharing.nfs.update', [3, { enabled: false }]);
      expect(call).not.toHaveBeenCalledWith('sharing.smb.update', expect.anything());
    });

    it('reports a share it actually changed', async () => {
      expect(await shareSetEnabled.execute(system().ctx, smbOff)).toEqual({
        protocol: 'SMB',
        id: 3,
        requested_enabled: false,
        lookup: 'FOUND',
        lookup_error: null,
        previously_enabled: true,
        resulting_enabled: false,
        changed: true,
        confirmed: true,
        locked: false,
      });
    });

    it('reports a share already in the requested state as changing nothing', async () => {
      const already = { ...smbShare, enabled: false };
      const result = await shareSetEnabled.execute(system([already], undefined, { smb: already }).ctx, smbOff);
      expect(result).toMatchObject({
        previously_enabled: false,
        resulting_enabled: false,
        changed: false,
        confirmed: true,
      });
    });

    it('reports locked off the update response', async () => {
      // A share on a locked dataset can be enabled and still serve nothing.
      const { ctx } = system([{ ...smbShare, enabled: false }], undefined, {
        smb: { ...smbShare, enabled: true, locked: true },
      });
      expect(await shareSetEnabled.execute(ctx, { ...smbOff, enabled: true })).toMatchObject({
        resulting_enabled: true,
        confirmed: true,
        locked: true,
      });
    });

    it('reports locked as null where the response states no boolean for it', async () => {
      for (const smb of [{ ...smbShare, enabled: false, locked: null }, { id: 3, enabled: false }]) {
        const { ctx } = system(undefined, undefined, { smb });
        expect(await shareSetEnabled.execute(ctx, smbOff)).toMatchObject({ locked: null });
      }
    });

    it('reports NOT_FOUND and still makes the update the plan named', async () => {
      const { ctx, call } = system([]);
      expect(await shareSetEnabled.execute(ctx, smbOff)).toMatchObject({
        lookup: 'NOT_FOUND',
        lookup_error: null,
        previously_enabled: null,
        resulting_enabled: false,
        changed: null,
        confirmed: true,
      });
      expect(call).toHaveBeenCalledWith('sharing.smb.update', [3, { enabled: false }]);
    });

    it('reports UNREADABLE with the reason, and still makes the update', async () => {
      const { ctx, call } = failingSystem(
        { 'sharing.nfs.update': { ...nfsExport, enabled: false } },
        { 'sharing.nfs.query': new Error('websocket closed') },
      );
      expect(await shareSetEnabled.execute(ctx, nfsOff)).toMatchObject({
        lookup: 'UNREADABLE',
        lookup_error: 'websocket closed',
        previously_enabled: null,
        changed: null,
      });
      expect(call).toHaveBeenCalledWith('sharing.nfs.update', [3, { enabled: false }]);
    });

    it('does not report success when the response disagrees with the request', async () => {
      const { ctx } = system(undefined, undefined, { smb: smbShare });
      expect(await shareSetEnabled.execute(ctx, smbOff)).toMatchObject({
        requested_enabled: false,
        previously_enabled: true,
        resulting_enabled: true,
        changed: false,
        confirmed: false,
      });
    });

    it('establishes nothing about the result when the response is not a record', async () => {
      const { ctx } = system(undefined, undefined, { smb: true });
      expect(await shareSetEnabled.execute(ctx, smbOff)).toMatchObject({
        resulting_enabled: null,
        changed: null,
        confirmed: null,
        locked: null,
      });
    });

    it('fails the call when the update itself rejects', async () => {
      const { ctx } = failingSystem(
        { 'sharing.smb.query': [smbShare] },
        { 'sharing.smb.update': { reason: 'share path does not exist' } },
      );
      await expect(shareSetEnabled.execute(ctx, smbOff)).rejects.toEqual({
        reason: 'share path does not exist',
      });
    });
  });
});
