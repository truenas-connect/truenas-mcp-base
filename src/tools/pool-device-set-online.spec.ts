import { describe, expect, it } from 'vitest';
import { of, throwError } from 'rxjs';
import { Role } from '@/interfaces';
import { fakeSystem } from '@/testing/fake-systems';
import { poolDeviceSetOnline } from '@/tools/pools';

const leaf = (disk: string, status: string | null = 'ONLINE', over: Record<string, unknown> = {}) => ({
  type: 'DISK',
  name: `${disk}2`,
  disk,
  status,
  guid: `guid-${disk}`,
  children: [],
  ...over,
});

const vdev = (type: string, children: unknown[], name = `${type.toLowerCase()}-0`) => ({
  type,
  name,
  status: 'ONLINE',
  guid: `guid-${name}`,
  disk: null,
  children,
});

const pool = (topology: Record<string, unknown>, over: Record<string, unknown> = {}) => ({
  id: 7,
  name: 'tank',
  status: 'ONLINE',
  topology: { data: [], log: [], cache: [], spare: [], special: [], dedup: [], ...topology },
  ...over,
});

const MIRROR = pool({ data: [vdev('MIRROR', [leaf('sda'), leaf('sdb')])] });

const args = (over: Record<string, unknown> = {}) => ({ pool: 'tank', disk: 'sdb', online: false, ...over });

const system = (rows: unknown[] = [MIRROR]) =>
  fakeSystem({ ['pool.query']: rows, ['pool.offline']: true, ['pool.online']: true });

const plan = (rows: unknown[], over: Record<string, unknown> = {}) =>
  poolDeviceSetOnline.plan(system(rows).ctx, args(over));

describe('pool_device_set_online', () => {
  it('is a reversible mutating tool needing the full role', () => {
    expect(poolDeviceSetOnline).toMatchObject({
      mutating: true,
      destructiveness: 'reversible',
      requiredRole: Role.Full,
    });
    expect((poolDeviceSetOnline.inputSchema as { required: string[] }).required).toEqual([
      'pool',
      'disk',
      'online',
    ]);
  });

  it('normalizes args to the three it takes', () => {
    expect(poolDeviceSetOnline.normalizeArgs?.({ ...args(), extra: 1 })).toEqual(args());
  });

  describe('argument validation', () => {
    it('requires a pool name, a disk name and an online flag', async () => {
      for (const bad of [undefined, '', 7]) {
        await expect(plan([MIRROR], { pool: bad })).rejects.toThrow('"pool" is required and must be a pool name');
        await expect(plan([MIRROR], { disk: bad })).rejects.toThrow('"disk" is required and must be a disk name');
      }
      for (const bad of [undefined, 'false', 0]) {
        await expect(plan([MIRROR], { online: bad })).rejects.toThrow('"online" is required and must be a boolean');
      }
    });
  });

  describe('finding the device', () => {
    it('fails naming the pool where no pool of that name is listed', async () => {
      await expect(plan([])).rejects.toThrow('No pool named "tank" on this system');
    });

    it('matches the pool by name on the response, never by taking the first row', async () => {
      const other = pool({ data: [vdev('MIRROR', [leaf('sdb'), leaf('sdc')])] }, { id: 3, name: 'other' });
      const [, call] = await plan([other, MIRROR]);
      expect(call.params).toEqual([7, { label: 'guid-sdb' }]);
    });

    it('refuses a pool listed with no id it can read', async () => {
      await expect(plan([{ ...MIRROR, id: '7' }])).rejects.toThrow(
        'Pool "tank" is listed with no id this tool could read',
      );
    });

    it('fails naming the disk where the topology lists no such disk', async () => {
      await expect(plan([MIRROR], { disk: 'sdz' })).rejects.toThrow(
        'No disk "sdz" in pool "tank"\'s topology',
      );
    });

    it('refuses a topology it could not read in full, in either direction', async () => {
      const unreadable = [
        pool({}, { topology: null }),
        pool({ log: 'nope' }),
        pool({ data: [vdev('MIRROR', [leaf('sda'), leaf('sdb')]), 'nope'] }),
        pool({ data: [vdev('MIRROR', [leaf('sda'), leaf('sdb', 'ONLINE', { children: 'nope' })])] }),
        pool({ data: [vdev('MIRROR', [leaf('sda'), leaf('sdb'), 7])] }),
      ];
      for (const row of unreadable) {
        for (const online of [true, false]) {
          await expect(plan([row], { online })).rejects.toThrow(
            'The topology of pool "tank" could not be read in full',
          );
        }
      }
    });

    it('reads an absent category as empty, as an older middleware may not carry it', async () => {
      const topology: Record<string, unknown> = { ...MIRROR.topology };
      delete topology['dedup'];
      await expect(plan([{ ...MIRROR, topology }])).resolves.toHaveLength(2);
    });

    it('refuses a disk listed twice — a spare in use — rather than choosing one', async () => {
      const inUse = pool({
        data: [vdev('MIRROR', [leaf('sda'), vdev('SPARE', [leaf('sdb', 'FAULTED'), leaf('sdc')])])],
        spare: [leaf('sdc', 'INUSE')],
      });
      await expect(plan([inUse], { disk: 'sdc', online: true })).rejects.toThrow(
        'Disk "sdc" is listed 2 times in pool "tank"\'s topology (data, spare)',
      );
    });

    it('refuses a disk that reported no GUID, since that is what the call names it by', async () => {
      const row = pool({ data: [vdev('MIRROR', [leaf('sda'), leaf('sdb', 'ONLINE', { guid: 12 })])] });
      await expect(plan([row])).rejects.toThrow('Disk "sdb" in pool "tank" reported no GUID this tool could read');
    });
  });

  describe('the offline redundancy check', () => {
    const refused = (row: unknown, disk: string) =>
      expect(plan([row], { disk })).rejects.toThrow(`Refusing to take disk "${disk}" offline in pool "tank": `);

    it('refuses a striped data, special or dedup device', async () => {
      for (const category of ['data', 'special', 'dedup']) {
        await expect(plan([pool({ [category]: [leaf('sdb')] })])).rejects.toThrow(
          `it is a \`${category}\` vdev on its own — a stripe — so taking it offline faults the pool`,
        );
      }
    });

    it('refuses the last ONLINE member of a mirror, and allows one with another ONLINE', async () => {
      for (const other of ['FAULTED', 'OFFLINE', 'DEGRADED', 'UNAVAIL']) {
        const row = pool({ data: [vdev('MIRROR', [leaf('sda', other), leaf('sdb')])] });
        await expect(plan([row])).rejects.toThrow('no other member of its mirror is ONLINE');
      }
      const threeWay = pool({ data: [vdev('MIRROR', [leaf('sda', 'FAULTED'), leaf('sdb'), leaf('sdc')])] });
      await expect(plan([threeWay])).resolves.toHaveLength(2);
    });

    it('refuses a RAIDZ member where the members not ONLINE would exceed the parity', async () => {
      const raidz1 = pool({ data: [vdev('RAIDZ1', [leaf('sda', 'FAULTED'), leaf('sdb'), leaf('sdc')])] });
      await expect(plan([raidz1])).rejects.toThrow(
        "2 of its RAIDZ1's 3 members would be not ONLINE, more than its parity of 1 covers",
      );
      const healthy = pool({ data: [vdev('RAIDZ1', [leaf('sda'), leaf('sdb'), leaf('sdc')])] });
      await expect(plan([healthy])).resolves.toHaveLength(2);
      const raidz2 = pool({
        data: [vdev('RAIDZ2', [leaf('sda', 'FAULTED'), leaf('sdb'), leaf('sdc'), leaf('sdd')])],
      });
      await expect(plan([raidz2])).resolves.toHaveLength(2);
      const raidz2Down = pool({
        data: [vdev('RAIDZ2', [leaf('sda', 'FAULTED'), leaf('sdb'), leaf('sdc', 'REMOVED'), leaf('sdd')])],
      });
      await refused(raidz2Down, 'sdb');
    });

    it('reads dRAID parity off the type, or off the name where the type is bare', async () => {
      const members = [leaf('sda', 'FAULTED'), leaf('sdb'), leaf('sdc'), leaf('sdd')];
      await expect(plan([pool({ data: [vdev('DRAID2', members)] })])).resolves.toHaveLength(2);
      await expect(plan([pool({ data: [vdev('DRAID', members, 'draid2:2d:4c:0s-0')] })])).resolves.toHaveLength(2);
      await expect(plan([pool({ data: [vdev('DRAID', members, 'draid1:2d:4c:0s-0')] })])).rejects.toThrow(
        'more than its parity of 1 covers',
      );
    });

    it('refuses where the vdev type or its parity cannot be read', async () => {
      const members = [leaf('sda'), leaf('sdb'), leaf('sdc')];
      for (const row of [
        pool({ data: [vdev('DRAID', members, 'draid-0')] }),
        pool({ data: [vdev('SOMETHING_NEW', members)] }),
        pool({ data: [{ ...vdev('MIRROR', members), type: undefined }] }),
      ]) {
        await expect(plan([row])).rejects.toThrow('is not one whose redundancy this tool can read');
      }
    });

    it('refuses where another member\'s state cannot be read', async () => {
      const row = pool({ data: [vdev('MIRROR', [leaf('sda', null), leaf('sdb'), leaf('sdc')])] });
      await expect(plan([row])).rejects.toThrow('the state of another member of its vdev could not be read');
    });

    it('refuses a device nested beneath another inside its vdev', async () => {
      const row = pool({
        data: [vdev('RAIDZ1', [leaf('sda'), vdev('REPLACING', [leaf('sdb'), leaf('sdc')]), leaf('sdd')])],
      });
      await expect(plan([row])).rejects.toThrow('it sits beneath another device inside its vdev');
    });

    it('does not refuse a log, cache or spare device, and names which it is', async () => {
      for (const category of ['log', 'cache', 'spare']) {
        const [, call] = await plan([pool({ [category]: [leaf('sdb', category === 'spare' ? 'AVAIL' : 'ONLINE')] })]);
        expect(call.description).toContain(
          `It is a \`${category}\` device, which holds no data the pool depends on, so no data redundancy is lost`,
        );
      }
    });

    it('does not refuse a device that is already OFFLINE, and says so', async () => {
      const [, call] = await plan([pool({ data: [leaf('sdb', 'OFFLINE')] })]);
      expect(call.description).toContain('It is already OFFLINE, which is not an error.');
      expect(call.description).not.toContain('less redundancy');
    });

    it('is not made for bringing a device online', async () => {
      const row = pool({ data: [leaf('sdb', 'OFFLINE')] });
      await expect(plan([row], { online: true })).resolves.toHaveLength(2);
    });
  });

  describe('the plan', () => {
    it('names the read it makes, once, and then the call with the pool id and the GUID', async () => {
      const { ctx, query } = system();
      const steps = await poolDeviceSetOnline.plan(ctx, args());
      expect(steps.map((step) => step.method)).toEqual(['pool.query', 'pool.offline']);
      expect(steps[0].params).toEqual([[['name', '=', 'tank']], {}]);
      expect(query).toHaveBeenCalledWith('pool.query', [['name', '=', 'tank']]);
      expect(steps[0].description).toContain('pool 7, GUID guid-sdb when this plan was made. Changes nothing.');
      expect(steps[0].description).toContain('the redundancy check is made again on what it reads');
      expect(steps[0].description).toContain('This same read is made again immediately after the call');
      expect(steps[1].params).toEqual([7, { label: 'guid-sdb' }]);
    });

    it("states the vdev's type and every member's current state", async () => {
      const row = pool({ data: [vdev('MIRROR', [leaf('sda'), leaf('sdb'), leaf('sdc', 'FAULTED')])] });
      const [, call] = await plan([row]);
      expect(call.description).toContain(
        'Disk "sdb" is in a MIRROR vdev in the `data` category, now ONLINE; its members are ' +
          'sda ONLINE, sdb ONLINE, sdc FAULTED.',
      );
      expect(call.description).toContain('less redundancy than it has now');
      const [, stripe] = await plan([pool({ data: [leaf('sdb', 'OFFLINE')] })], { online: true });
      expect(stripe.description).toContain('Disk "sdb" is a `data` vdev on its own, and is now OFFLINE.');
    });

    it('names a member with no disk by its slot, and an unreadable type or state as such', async () => {
      const row = pool({
        data: [{ ...vdev('MIRROR', [leaf('sda', 'ONLINE', { disk: null }), leaf('sdb', null)]), type: null }],
      });
      const [, call] = await plan([row], { online: true });
      expect(call.description).toContain(
        'Disk "sdb" is in a vdev of a type not readable in the `data` category, now state not readable; ' +
          'its members are sda2 ONLINE, sdb state not readable.',
      );
    });

    it('says that bringing a device online starts a resilver and does not repair it', async () => {
      const row = pool({ data: [vdev('MIRROR', [leaf('sda'), leaf('sdb', 'OFFLINE')])] });
      const [read, call] = await plan([row], { online: true });
      expect(call.method).toBe('pool.online');
      expect(call.description).toContain('A RESILVER FOLLOWS');
      expect(call.description).toContain('does not repair it');
      expect(read.description).not.toContain('redundancy check');
    });

    it('says a device already ONLINE is not an error', async () => {
      const [, call] = await plan([MIRROR], { online: true });
      expect(call.description).toContain('It is already ONLINE, which is not an error.');
      expect(call.description).not.toContain('RESILVER');
    });

    it('states that the GUID being what the call takes is unconfirmed', async () => {
      const [, call] = await plan([MIRROR]);
      expect(call.description).toContain('(unconfirmed) that the call takes the GUID rather than a device path');
    });
  });

  describe('execute', () => {
    const after = (status: string) => pool({ data: [vdev('MIRROR', [leaf('sda'), leaf('sdb', status)])] });

    it('reads, sends the call, and reads the outcome again by GUID', async () => {
      const { ctx, query, call } = system();
      query.mockReturnValueOnce(of([MIRROR])).mockReturnValueOnce(of([after('OFFLINE')]));
      expect(await poolDeviceSetOnline.execute(ctx, args())).toEqual({
        pool: 'tank',
        disk: 'sdb',
        requested_online: false,
        pool_id: 7,
        guid: 'guid-sdb',
        category: 'data',
        previous_status: 'ONLINE',
        resulting_lookup: 'FOUND',
        resulting_read_error: null,
        resulting_status: 'OFFLINE',
        changed: true,
      });
      expect(call).toHaveBeenCalledWith('pool.offline', [7, { label: 'guid-sdb' }]);
      expect(query).toHaveBeenCalledTimes(2);
    });

    it('finds the device after the call by its GUID, not by its disk name', async () => {
      const { ctx, query } = system();
      const renamed = pool({ data: [vdev('MIRROR', [leaf('sda'), leaf('sdb', 'OFFLINE', { disk: 'sdq' })])] });
      query.mockReturnValueOnce(of([MIRROR])).mockReturnValueOnce(of([renamed]));
      expect(await poolDeviceSetOnline.execute(ctx, args())).toMatchObject({
        resulting_lookup: 'FOUND',
        resulting_status: 'OFFLINE',
      });
      // A device that faulted can lose its resolved disk, and is still found.
      const lost = system();
      const unresolved = pool({ data: [vdev('MIRROR', [leaf('sda'), leaf('sdb', 'UNAVAIL', { disk: null })])] });
      lost.query.mockReturnValueOnce(of([MIRROR])).mockReturnValueOnce(of([unresolved]));
      expect(await poolDeviceSetOnline.execute(lost.ctx, args({ online: true }))).toMatchObject({
        resulting_lookup: 'FOUND',
        resulting_status: 'UNAVAIL',
      });
    });

    it('never infers the outcome from the call returning', async () => {
      const { ctx, query, call } = system();
      query.mockReturnValueOnce(of([after('OFFLINE')])).mockReturnValueOnce(of([after('FAULTED')]));
      expect(await poolDeviceSetOnline.execute(ctx, args({ online: true }))).toMatchObject({
        previous_status: 'OFFLINE',
        resulting_status: 'FAULTED',
        changed: true,
      });
      expect(call).toHaveBeenCalledWith('pool.online', [7, { label: 'guid-sdb' }]);
      const unchanged = system();
      expect(await poolDeviceSetOnline.execute(unchanged.ctx, args())).toMatchObject({
        resulting_status: 'ONLINE',
        changed: false,
      });
    });

    it('refuses and sends nothing where the vdev lost a member since the plan', async () => {
      const { ctx, call } = system([pool({ data: [vdev('MIRROR', [leaf('sda', 'FAULTED'), leaf('sdb')])] })]);
      await expect(poolDeviceSetOnline.execute(ctx, args())).rejects.toThrow('no other member of its mirror is ONLINE');
      expect(call).not.toHaveBeenCalled();
    });

    it('sends nothing where the pool or the disk is gone by the time it runs', async () => {
      for (const rows of [[], [pool({ data: [vdev('MIRROR', [leaf('sda'), leaf('sdc')])] })]]) {
        const { ctx, call } = system(rows);
        await expect(poolDeviceSetOnline.execute(ctx, args())).rejects.toThrow(/No (pool|disk)/);
        expect(call).not.toHaveBeenCalled();
      }
    });

    it('reports a read after the call that found nothing as NOT_FOUND, not as a failed call', async () => {
      for (const later of [[], [pool({ data: [vdev('MIRROR', [leaf('sda'), leaf('sdc')])] })], [pool({}, { topology: null })]]) {
        const { ctx, query } = system();
        query.mockReturnValueOnce(of([MIRROR])).mockReturnValueOnce(of(later));
        expect(await poolDeviceSetOnline.execute(ctx, args())).toMatchObject({
          resulting_lookup: 'NOT_FOUND',
          resulting_read_error: null,
          resulting_status: null,
          changed: null,
        });
      }
    });

    it('passes over a part of the topology it cannot read when finding the device after the call', async () => {
      const { ctx, query } = system();
      const ragged = pool({ log: 'nope', data: [7, vdev('MIRROR', [leaf('sda'), leaf('sdb', 'OFFLINE')])] });
      query.mockReturnValueOnce(of([MIRROR])).mockReturnValueOnce(of([ragged]));
      expect(await poolDeviceSetOnline.execute(ctx, args())).toMatchObject({
        resulting_lookup: 'FOUND',
        resulting_status: 'OFFLINE',
      });
    });

    it('reports a read after the call that failed as UNREADABLE, naming why', async () => {
      const { ctx, query } = system();
      query.mockReturnValueOnce(of([MIRROR])).mockReturnValueOnce(throwError(() => new Error('timed out')));
      expect(await poolDeviceSetOnline.execute(ctx, args())).toMatchObject({
        resulting_lookup: 'UNREADABLE',
        resulting_read_error: 'timed out',
        resulting_status: null,
        changed: null,
      });
    });

    it('leaves changed null where a reading is null, which is not "nothing changed"', async () => {
      const { ctx, query } = system();
      query
        .mockReturnValueOnce(of([MIRROR]))
        .mockReturnValueOnce(of([pool({ data: [vdev('MIRROR', [leaf('sda'), leaf('sdb', null)])] })]));
      expect(await poolDeviceSetOnline.execute(ctx, args())).toMatchObject({
        resulting_lookup: 'FOUND',
        resulting_status: null,
        changed: null,
      });
    });
  });

  it('states what it refuses, and that onlining is not repairing', () => {
    expect(poolDeviceSetOnline.description).toContain(
      'TAKING A DEVICE OFFLINE IS REFUSED, AT PLAN TIME AND AGAIN WHEN THE CALL IS MADE',
    );
    expect(poolDeviceSetOnline.description).toContain('BRINGING A DEVICE ONLINE DOES NOT REPAIR IT');
    expect(poolDeviceSetOnline.resultGuidance).toContain('IS NEVER INFERRED FROM THE CALL RETURNING');
  });
});
