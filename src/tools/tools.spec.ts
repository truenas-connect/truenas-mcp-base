import { describe, expect, it, vi } from 'vitest';
import { of } from 'rxjs';
import { TrueNasEndpoint } from '@truenas/api-client';
import { SystemHandle, ToolContext } from '@/catalog/tool';
import { Role } from '@/interfaces';
import { createDefaultCatalog, createSnapshot, listDatasets, poolStatus } from '@/tools/index';

/** A SystemHandle whose api.call answers from a canned endpoint→response map. */
function fakeSystem(responses: Partial<Record<TrueNasEndpoint, unknown>>): {
  ctx: ToolContext;
  call: ReturnType<typeof vi.fn>;
} {
  const call = vi.fn((method: TrueNasEndpoint) => of(responses[method]));
  const system = { name: 'nas', client: { api: { call } } } as unknown as SystemHandle;
  return { ctx: { system }, call };
}

describe('createDefaultCatalog', () => {
  it('registers the four sketch tools', () => {
    expect(createDefaultCatalog().list(Role.Full).map((t) => t.name)).toEqual([
      'system_info',
      'storage_pool_status',
      'storage_list_datasets',
      'snapshots_create',
    ]);
  });
});

describe('storage_pool_status', () => {
  it('trims pool.query to health and capacity', async () => {
    const { ctx } = fakeSystem({
      [TrueNasEndpoint.PoolQuery]: [
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

  it('flattens nested children', async () => {
    const { ctx } = fakeSystem({
      [TrueNasEndpoint.DatasetQuery]: [dataset('tank', [dataset('tank/media')])],
    });
    const result = (await listDatasets.handler(ctx, {})) as { id: string }[];
    expect(result.map((d) => d.id)).toEqual(['tank', 'tank/media']);
  });

  it('passes a pool filter to the query', async () => {
    const { ctx, call } = fakeSystem({ [TrueNasEndpoint.DatasetQuery]: [] });
    await listDatasets.handler(ctx, { pool: 'tank' });
    expect(call).toHaveBeenCalledWith(TrueNasEndpoint.DatasetQuery, [
      [['pool', '=', 'tank']],
      { extra: { retrieve_children: true, properties: ['used', 'available'] } },
    ]);
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
    const { ctx } = fakeSystem({ [TrueNasEndpoint.DatasetQuery]: [{ id: 'tank/media' }] });
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
    const { ctx } = fakeSystem({ [TrueNasEndpoint.DatasetQuery]: [] });
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
      [TrueNasEndpoint.SnapshotCreate]: { name: 'tank/media@before' },
    });
    const result = await createSnapshot.execute(ctx, { dataset: 'tank/media', name: 'before' });
    expect(call).toHaveBeenCalledWith(TrueNasEndpoint.SnapshotCreate, [
      { dataset: 'tank/media', name: 'before', recursive: false },
    ]);
    expect(result).toEqual({ created: 'tank/media@before' });
  });
});
