import { describe, expect, it } from 'vitest';
import { Role } from '@/interfaces';
import { fakeSystem, failingSystem } from '@/testing/fake-systems';
import { nfsClients } from '@/tools/index';

const V3 = 'nfs.get_nfs3_clients';
const V4 = 'nfs.get_nfs4_clients';

/** The tool's result, as a record the cases can index into. */
type Result = Record<string, unknown>;

/** An `info` record as the Linux NFS server publishes one, per this tool's guess. */
const info = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  address: '10.0.0.4:849',
  status: 'confirmed',
  'seconds from last renew': 12,
  'minor version': 2,
  ...over,
});

/** One `states` entry, of the shape the server publishes under a client. */
const state = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  type: 'open',
  access: 'rw',
  filename: 'ledger.db',
  ...over,
});

const read = async (responses: Partial<Record<string, unknown>>): Promise<Result> => {
  const { ctx } = fakeSystem(responses);
  return (await nfsClients.handler(ctx, {})) as Result;
};

/** The one NFSv4 row of a listing holding exactly one client. */
const oneV4 = async (client: unknown): Promise<Result> => {
  const result = await read({ [V3]: [], [V4]: [client] });
  return (result['nfsv4'] as Result[])[0];
};

describe('nfs_clients', () => {
  it('is a read-only tool a read-only credential may run', () => {
    expect(nfsClients.mutating).toBe(false);
    expect(nfsClients.requiredRole).toBe(Role.ReadOnly);
    expect(nfsClients.name).toBe('nfs_clients');
  });

  describe('NFSv3', () => {
    it('reports one entry per host and export, not one per host', async () => {
      // NFSv3 holds no session, so a host with two exports mounted is two
      // separate facts about it rather than one initiator seen twice — which is
      // why these are not grouped the way `iscsi_list` groups its sessions.
      const result = await read({
        [V3]: [
          { ip: '10.0.0.4', export: '/mnt/tank/ledger' },
          { ip: '10.0.0.4', export: '/mnt/tank/media' },
        ],
        [V4]: [],
      });
      expect(result['nfsv3']).toEqual([
        { ip: '10.0.0.4', export: '/mnt/tank/ledger' },
        { ip: '10.0.0.4', export: '/mnt/tank/media' },
      ]);
    });

    it('keeps a row whose ip could not be read rather than dropping it', async () => {
      // Dropping it would shorten the list towards "nobody has this mounted",
      // which is more than the read established.
      const result = await read({
        [V3]: [{ ip: 42, export: '/mnt/tank/ledger' }],
        [V4]: [],
      });
      expect(result['nfsv3']).toEqual([{ ip: null, export: '/mnt/tank/ledger' }]);
    });

    it('keeps a row whose export could not be read', async () => {
      const result = await read({ [V3]: [{ ip: '10.0.0.4', export: '' }], [V4]: [] });
      expect(result['nfsv3']).toEqual([{ ip: '10.0.0.4', export: null }]);
    });

    it('keeps a row that is not an object at all, with both fields null', async () => {
      const result = await read({ [V3]: ['10.0.0.4'], [V4]: [] });
      expect(result['nfsv3']).toEqual([{ ip: null, export: null }]);
    });

    it('carries no field the tool does not name', async () => {
      const result = await read({
        [V3]: [{ ip: '10.0.0.4', export: '/mnt/tank/ledger', protocol_version: 3 }],
        [V4]: [],
      });
      expect(Object.keys((result['nfsv3'] as Result[])[0])).toEqual(['ip', 'export']);
    });
  });

  describe('NFSv4', () => {
    it('names every field it reports out of the two open records', async () => {
      expect(await oneV4({ id: 'nfs4_client_0', info: info(), states: [state()] })).toEqual({
        id: 'nfs4_client_0',
        address: '10.0.0.4:849',
        status: 'confirmed',
        seconds_from_last_renew: 12,
        minor_version: 2,
        state_count: 1,
        state_types: ['open'],
        unreported_info_fields: [],
        unreported_state_fields: ['access', 'filename'],
      });
    });

    it('reports the status word verbatim rather than coercing it', async () => {
      const row = await oneV4({ id: 'c', info: info({ status: 'courtesy' }), states: [] });
      expect(row['status']).toBe('courtesy');
    });

    it('names an info key it does not report, by name and never by value', async () => {
      const row = await oneV4({
        id: 'c',
        info: info({ 'callback state': 'UP', 'Implementation name': 'Linux 6.1' }),
        states: [],
      });
      expect(row['unreported_info_fields']).toEqual(['Implementation name', 'callback state']);
      expect(JSON.stringify(row)).not.toContain('Linux 6.1');
      expect(JSON.stringify(row)).not.toContain('UP');
    });

    it('leaves the named fields null and the unreported list full when the keys differ', async () => {
      // The failure mode the allowlist is unconfirmed against: a middleware that
      // spells the keys differently must be visible as such rather than reading
      // as a client the server knows nothing about.
      const row = await oneV4({
        id: 'c',
        info: { addr: '10.0.0.4:849', state: 'confirmed' },
        states: [],
      });
      expect(row).toMatchObject({
        address: null,
        status: null,
        seconds_from_last_renew: null,
        minor_version: null,
        unreported_info_fields: ['addr', 'state'],
      });
    });

    it('reports a null info record as unread rather than as carrying no keys', async () => {
      const row = await oneV4({ id: 'c', info: 'not a record', states: [] });
      expect(row).toMatchObject({
        address: null,
        status: null,
        unreported_info_fields: null,
      });
    });

    it('reports an empty states list as a client holding nothing open', async () => {
      const row = await oneV4({ id: 'c', info: info(), states: [] });
      expect(row).toMatchObject({ state_count: 0, state_types: [], unreported_state_fields: [] });
    });

    it('reports states that are not a list as unread rather than as none', async () => {
      const row = await oneV4({ id: 'c', info: info(), states: 3 });
      expect(row).toMatchObject({
        state_count: null,
        state_types: null,
        unreported_state_fields: null,
      });
    });

    it('reports the distinct state types, sorted and deduplicated', async () => {
      const row = await oneV4({
        id: 'c',
        info: info(),
        states: [state({ type: 'open' }), state({ type: 'lock' }), state({ type: 'open' })],
      });
      expect(row).toMatchObject({ state_count: 3, state_types: ['lock', 'open'] });
    });

    it('unions the unreported state keys across entries', async () => {
      const row = await oneV4({
        id: 'c',
        info: info(),
        states: [state({ deny: '--' }), state({ superblock: '00:2b' })],
      });
      expect(row['unreported_state_fields']).toEqual([
        'access',
        'deny',
        'filename',
        'superblock',
      ]);
    });

    it('counts a state entry it could not read at all', async () => {
      // The count runs towards zero, and zero is the one positive claim this
      // side makes, so an unreadable entry still counts.
      const row = await oneV4({ id: 'c', info: info(), states: [state(), 'unreadable'] });
      expect(row).toMatchObject({ state_count: 2, state_types: ['open'] });
    });

    it('names no type for a state whose type could not be read', async () => {
      const row = await oneV4({ id: 'c', info: info(), states: [state({ type: 7 })] });
      expect(row).toMatchObject({ state_count: 1, state_types: [] });
    });

    it('answers with every field null for a client row that is not a record', async () => {
      expect(await oneV4('nfs4_client_0')).toEqual({
        id: null,
        address: null,
        status: null,
        seconds_from_last_renew: null,
        minor_version: null,
        state_count: null,
        state_types: null,
        unreported_info_fields: null,
        unreported_state_fields: null,
      });
    });

    it('carries no field the tool does not name', async () => {
      const row = await oneV4({ id: 'c', info: info(), states: [], name: 'hex', extra: 1 });
      expect(Object.keys(row)).toEqual([
        'id',
        'address',
        'status',
        'seconds_from_last_renew',
        'minor_version',
        'state_count',
        'state_types',
        'unreported_info_fields',
        'unreported_state_fields',
      ]);
    });
  });

  describe('reads that fail', () => {
    it('reports nothing failed when both versions answer', async () => {
      const result = await read({ [V3]: [], [V4]: [] });
      expect(result).toEqual({ nfsv3: [], nfsv4: [], failures: [] });
    });

    it('still answers for NFSv4 when the NFSv3 read is rejected', async () => {
      const { ctx } = failingSystem(
        { [V4]: [{ id: 'c', info: info(), states: [] }] },
        { [V3]: { reason: 'nfs service is not running' } },
      );
      const result = (await nfsClients.handler(ctx, {})) as Result;
      expect(result['nfsv3']).toBeNull();
      expect((result['nfsv4'] as Result[])).toHaveLength(1);
      expect(result['failures']).toEqual([
        { source: 'nfsv3', error: 'nfs service is not running' },
      ]);
    });

    it('still answers for NFSv3 when the NFSv4 read is rejected', async () => {
      const { ctx } = failingSystem(
        { [V3]: [{ ip: '10.0.0.4', export: '/mnt/tank/ledger' }] },
        { [V4]: new Error('permission denied') },
      );
      const result = (await nfsClients.handler(ctx, {})) as Result;
      expect(result['nfsv4']).toBeNull();
      expect(result['nfsv3']).toEqual([{ ip: '10.0.0.4', export: '/mnt/tank/ledger' }]);
      expect(result['failures']).toEqual([{ source: 'nfsv4', error: 'permission denied' }]);
    });

    it('names both reads when neither answers, and nulls neither into an empty list', async () => {
      const { ctx } = failingSystem({}, { [V3]: 'v3 failed', [V4]: 'v4 failed' });
      const result = (await nfsClients.handler(ctx, {})) as Result;
      expect(result).toEqual({
        nfsv3: null,
        nfsv4: null,
        failures: [
          { source: 'nfsv3', error: 'v3 failed' },
          { source: 'nfsv4', error: 'v4 failed' },
        ],
      });
    });

    it('nulls a version that answered with something other than a list, and names it', async () => {
      // The client declares both calls as answering a union that includes a
      // bare row and a count. Mapping over one of those would throw out of the
      // handler and take the other version's answer with it.
      const result = await read({ [V3]: 4, [V4]: [] });
      expect(result['nfsv3']).toBeNull();
      expect(result['nfsv4']).toEqual([]);
      expect(result['failures']).toEqual([
        { source: 'nfsv3', error: 'the system answered with something other than a list of clients' },
      ]);
    });

    it('nulls an NFSv4 answer that is not a list without disturbing NFSv3', async () => {
      const result = await read({ [V3]: [{ ip: '10.0.0.4', export: '/x' }], [V4]: { id: 'c' } });
      expect(result['nfsv3']).toEqual([{ ip: '10.0.0.4', export: '/x' }]);
      expect(result['nfsv4']).toBeNull();
      expect((result['failures'] as Result[])[0]['source']).toBe('nfsv4');
    });

    it('reports a failure that said nothing as a failure rather than as empty text', async () => {
      const { ctx } = failingSystem({ [V4]: [] }, { [V3]: {} });
      const result = (await nfsClients.handler(ctx, {})) as Result;
      expect((result['failures'] as Result[])[0]['error']).toBe('the system reported no reason');
    });
  });
});
