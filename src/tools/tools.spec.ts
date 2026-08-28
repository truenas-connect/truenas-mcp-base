import { describe, expect, it, vi } from 'vitest';
import { of } from 'rxjs';
import { SystemHandle, ToolContext } from '@/catalog/tool';
import { Role } from '@/interfaces';
import {
  alertsList,
  createDefaultCatalog,
  createSnapshot,
  disksList,
  listDatasets,
  poolStatus,
} from '@/tools/index';

/**
 * A SystemHandle answering from a canned method→response map. Both seams are
 * stubbed from the same map: `call` for plain verbs, `query` for the client's
 * query helpers, which return the list directly rather than the union `call`
 * would. Tools pick whichever fits the verb, so a test asserts on whichever
 * spy that tool used.
 */
function fakeSystem(responses: Partial<Record<string, unknown>>): {
  ctx: ToolContext;
  call: ReturnType<typeof vi.fn>;
  query: ReturnType<typeof vi.fn>;
} {
  const call = vi.fn((method: string) => of(responses[method]));
  const query = vi.fn((method: string) => of(responses[method]));
  const system = { name: 'nas', client: { api: { call, query } } } as unknown as SystemHandle;
  return { ctx: { system }, call, query };
}

describe('createDefaultCatalog', () => {
  it('registers the six sketch tools', () => {
    expect(createDefaultCatalog().list(Role.Full).map((t) => t.name)).toEqual([
      'system_info',
      'storage_pool_status',
      'storage_list_datasets',
      'disks_list',
      'alerts_list',
      'snapshots_create',
    ]);
  });

  it('advertises alerts_list to a read-only credential', () => {
    expect(createDefaultCatalog().list(Role.ReadOnly).map((t) => t.name)).toContain('alerts_list');
  });

  it('advertises disks_list to a read-only credential', () => {
    expect(createDefaultCatalog().list(Role.ReadOnly).map((t) => t.name)).toContain('disks_list');
  });
});

describe('storage_pool_status', () => {
  it('trims pool.query to health and capacity', async () => {
    const { ctx } = fakeSystem({
      ['pool.query']: [
        { name: 'tank', status: 'ONLINE', healthy: true, size: 100, allocated: 40, free: 60 },
      ],
    });
    expect(await poolStatus.handler(ctx, {})).toEqual([
      {
        name: 'tank',
        status: 'ONLINE',
        healthy: true,
        size_bytes: 100,
        allocated_bytes: 40,
        free_bytes: 60,
      },
    ]);
  });
});

describe('storage_list_datasets', () => {
  const dataset = (id: string, children: unknown[] = []) => ({
    id,
    pool: 'tank',
    type: 'FILESYSTEM',
    mountpoint: `/mnt/${id}`,
    used: { parsed: 10 },
    available: { parsed: 90 },
    children,
  });

  it('does not duplicate datasets nested under children of other entries', async () => {
    // pool.dataset.query returns every dataset as a top-level entry while each
    // entry also nests its descendants under `children`.
    const { ctx } = fakeSystem({
      ['pool.dataset.query']: [
        dataset('tank', [dataset('tank/media', [dataset('tank/media/movies')])]),
        dataset('tank/media', [dataset('tank/media/movies')]),
        dataset('tank/media/movies'),
      ],
    });
    const result = (await listDatasets.handler(ctx, {})) as { id: string }[];
    expect(result.map((d) => d.id)).toEqual(['tank', 'tank/media', 'tank/media/movies']);
  });

  it('passes a pool filter to the query', async () => {
    const { ctx, query } = fakeSystem({ ['pool.dataset.query']: [] });
    await listDatasets.handler(ctx, { pool: 'tank' });
    // The query helper takes filters and options as separate arguments, where
    // `call` took one positional params tuple.
    expect(query).toHaveBeenCalledWith(
      'pool.dataset.query',
      [['pool', '=', 'tank']],
      { extra: { retrieve_children: true, properties: ['used', 'available'] } },
    );
  });
});

describe('disks_list', () => {
  // Every property the middleware's disk row carries, so the assertions below
  // show what the tool drops as well as what it keeps. `passwd` and `kmip_uid`
  // are the SED credential fields, and are here to be dropped.
  const disk = (over: Record<string, unknown>) => ({
    identifier: '{serial}ABC123',
    name: 'sda',
    subsystem: 'scsi',
    number: 2048,
    serial: 'ABC123',
    lunid: null,
    size: 4000787030016,
    transfermode: 'Auto',
    hddstandby: 'ALWAYS ON',
    advpowermgmt: 'DISABLED',
    expiretime: null,
    model: 'WDC_WD40EFRX',
    rotationrate: 5400,
    type: 'HDD',
    zfs_guid: '12345678901234567890',
    bus: 'SCSI',
    devname: 'sda',
    enclosure: { number: 0, slot: 3 },
    pool: 'tank',
    passwd: 'the-sed-passphrase',
    kmip_uid: null,
    sed: false,
    sed_status: null,
    ...over,
  });

  /** A row from a system that did not answer the pool question at all. */
  const withoutPool = (row: Record<string, unknown>): Record<string, unknown> => {
    const copy = { ...row };
    delete copy['pool'];
    return copy;
  };

  it('trims disk.query to the named fields', async () => {
    const { ctx } = fakeSystem({ ['disk.query']: [disk({})] });
    expect(await disksList.handler(ctx, {})).toEqual([
      {
        name: 'sda',
        model: 'WDC_WD40EFRX',
        serial: 'ABC123',
        size_bytes: 4000787030016,
        type: 'HDD',
        transfermode: 'Auto',
        pool: 'tank',
      },
    ]);
  });

  it('asks the middleware to attach pool membership', async () => {
    const { ctx, query } = fakeSystem({ ['disk.query']: [] });
    await disksList.handler(ctx, {});
    // Without `extra.pools` the rows carry no membership at all, which the
    // handler would then have to report as unknown for every disk.
    expect(query).toHaveBeenCalledWith('disk.query', [], { extra: { pools: true } });
  });

  it('surfaces neither the SED passphrase nor a field a later release adds', async () => {
    const { ctx } = fakeSystem({
      ['disk.query']: [disk({ future_field: 'added by a later TrueNAS release' })],
    });
    const [result] = (await disksList.handler(ctx, {})) as Record<string, unknown>[];
    expect(Object.keys(result)).toEqual([
      'name',
      'model',
      'serial',
      'size_bytes',
      'type',
      'transfermode',
      'pool',
    ]);
  });

  it('distinguishes a disk in no pool from one whose membership was not reported', async () => {
    // `pool: null` is the middleware saying "this disk belongs to no pool". A
    // row with no `pool` key at all is a system that did not answer the
    // question — an older middleware, or one that ignored `extra.pools`.
    const { ctx } = fakeSystem({
      ['disk.query']: [
        disk({ name: 'sda', pool: 'tank' }),
        disk({ name: 'sdb', pool: null }),
        withoutPool(disk({ name: 'sdc' })),
      ],
    });
    const result = (await disksList.handler(ctx, {})) as Record<string, unknown>[];
    expect(result.map((d) => [d['name'], 'pool' in d, d['pool']])).toEqual([
      ['sda', true, 'tank'],
      ['sdb', true, null],
      ['sdc', false, undefined],
    ]);
  });

  it('returns [] for a system with no disks', async () => {
    const { ctx } = fakeSystem({ ['disk.query']: [] });
    expect(await disksList.handler(ctx, {})).toEqual([]);
  });
});

describe('alerts_list', () => {
  // Every property the middleware's Alert carries, so the assertions below show
  // what the tool drops as well as what it keeps.
  const alert = (over: Record<string, unknown>) => ({
    uuid: 'u1',
    source: 'AlertSource',
    klass: 'ZpoolCapacityWarning',
    args: { pool: 'tank' },
    node: 'A',
    key: '[]',
    datetime: '2026-08-28T12:00:00+00:00',
    last_occurrence: '2026-08-28T13:00:00+00:00',
    dismissed: false,
    mail: null,
    text: 'Pool %(pool)s is low on space.',
    id: 'a1',
    level: 'WARNING',
    formatted: 'Pool tank is low on space.',
    one_shot: false,
    ...over,
  });

  it('trims alert.list to the named fields', async () => {
    const { ctx, call } = fakeSystem({ ['alert.list']: [alert({})] });
    expect(await alertsList.handler(ctx, {})).toEqual([
      {
        id: 'a1',
        klass: 'ZpoolCapacityWarning',
        level: 'WARNING',
        formatted: 'Pool tank is low on space.',
        datetime: '2026-08-28T12:00:00+00:00',
        dismissed: false,
      },
    ]);
    // The tool reads the alert list and nothing else.
    expect(call.mock.calls).toEqual([['alert.list']]);
  });

  it('does not surface a field the middleware adds later', async () => {
    const { ctx } = fakeSystem({
      ['alert.list']: [alert({ future_field: 'added by a later TrueNAS release' })],
    });
    const [result] = (await alertsList.handler(ctx, {})) as Record<string, unknown>[];
    expect(Object.keys(result)).toEqual([
      'id',
      'klass',
      'level',
      'formatted',
      'datetime',
      'dismissed',
    ]);
  });

  it('returns dismissed alerts, distinguishable by the boolean', async () => {
    const { ctx } = fakeSystem({
      ['alert.list']: [alert({ id: 'a1' }), alert({ id: 'a2', dismissed: true })],
    });
    const result = (await alertsList.handler(ctx, {})) as { id: string; dismissed: boolean }[];
    expect(result.map((a) => [a.id, a.dismissed])).toEqual([
      ['a1', false],
      ['a2', true],
    ]);
  });

  it('returns [] for a system with no alerts', async () => {
    const { ctx } = fakeSystem({ ['alert.list']: [] });
    expect(await alertsList.handler(ctx, {})).toEqual([]);
  });
});

describe('snapshots_create', () => {
  it('normalizes args: applies defaults and drops unknown keys', () => {
    expect(
      createSnapshot.normalizeArgs?.({ dataset: 'tank/media', name: 'before', extra: 1 }),
    ).toEqual({ dataset: 'tank/media', name: 'before', recursive: false });
  });

  it('rejects non-boolean recursive instead of silently coercing', () => {
    for (const bad of ['true', 1, 'yes', 0]) {
      expect(() =>
        createSnapshot.normalizeArgs?.({ dataset: 'tank/media', name: 'x', recursive: bad }),
      ).toThrow(/"recursive" must be a boolean/);
    }
    expect(
      createSnapshot.normalizeArgs?.({ dataset: 'tank/media', name: 'x', recursive: null }),
    ).toEqual({ dataset: 'tank/media', name: 'x', recursive: false });
  });

  it('plans the exact pool.snapshot.create call after verifying the dataset exists', async () => {
    const { ctx } = fakeSystem({ ['pool.dataset.query']: [{ id: 'tank/media' }] });
    const steps = await createSnapshot.plan(ctx, { dataset: 'tank/media', name: 'before' });
    expect(steps).toEqual([
      {
        method: 'pool.snapshot.create',
        params: [{ dataset: 'tank/media', name: 'before', recursive: false }],
        description: 'Create snapshot "tank/media@before"',
      },
    ]);
  });

  it('fails the plan when the dataset does not exist', async () => {
    const { ctx } = fakeSystem({ ['pool.dataset.query']: [] });
    await expect(
      createSnapshot.plan(ctx, { dataset: 'tank/nope', name: 'before' }),
    ).rejects.toThrow(/does not exist/);
  });

  it('requires dataset and name', async () => {
    const { ctx } = fakeSystem({});
    await expect(createSnapshot.plan(ctx, { name: 'x' })).rejects.toThrow(/"dataset"/);
    await expect(createSnapshot.plan(ctx, { dataset: 'tank' })).rejects.toThrow(/"name"/);
  });

  it('executes the same call the plan described', async () => {
    const { ctx, call } = fakeSystem({
      ['pool.snapshot.create']: { name: 'tank/media@before' },
    });
    const result = await createSnapshot.execute(ctx, { dataset: 'tank/media', name: 'before' });
    expect(call).toHaveBeenCalledWith('pool.snapshot.create', [
      { dataset: 'tank/media', name: 'before', recursive: false },
    ]);
    expect(result).toEqual({ created: 'tank/media@before' });
  });
});
