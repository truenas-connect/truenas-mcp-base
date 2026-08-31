import { describe, expect, it } from 'vitest';
import { fakeSystem } from '@/testing/fake-systems';
import { listDatasets, poolStatus, quotaReport, systemDatasetConfig } from '@/tools/index';

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

describe('datasets_quota_report', () => {
  // Deliberately asymmetric: `used` against `quota` and `referenced` against
  // `refquota` give 25% and 50%, and every other pairing of the four gives
  // neither — so a test that passes has paired each limit with the usage ZFS
  // actually caps with it rather than with the other one.
  const dataset = (over: Record<string, unknown> = {}) => ({
    id: 'tank/media',
    pool: 'tank',
    type: 'FILESYSTEM',
    mountpoint: '/mnt/tank/media',
    used: { parsed: 75 },
    referenced: { parsed: 20 },
    quota: { parsed: 300 },
    refquota: { parsed: 40 },
    children: [],
    ...over,
  });

  /** A row from a system that did not report one of the properties at all. */
  const without = (row: Record<string, unknown>, key: string): Record<string, unknown> => {
    const copy = { ...row };
    delete copy[key];
    return copy;
  };

  const rowsFrom = async (
    datasets: unknown[],
    args: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>[]> => {
    const { ctx } = fakeSystem({ ['pool.dataset.query']: datasets });
    return (await quotaReport.handler(ctx, args)) as Record<string, unknown>[];
  };

  it('pairs each limit with the usage it caps', async () => {
    expect(await rowsFrom([dataset()])).toEqual([
      {
        id: 'tank/media',
        pool: 'tank',
        quota_bytes: 300,
        used_bytes: 75,
        quota_used_percent: 25,
        refquota_bytes: 40,
        referenced_bytes: 20,
        refquota_used_percent: 50,
      },
    ]);
  });

  it('surfaces no field a later release adds', async () => {
    const [row] = await rowsFrom([
      dataset({ future_field: 'added by a later TrueNAS release' }),
    ]);
    expect(Object.keys(row)).toEqual([
      'id',
      'pool',
      'quota_bytes',
      'used_bytes',
      'quota_used_percent',
      'refquota_bytes',
      'referenced_bytes',
      'refquota_used_percent',
    ]);
  });

  it('reports a dataset with no quota as 0, and one whose quota is unreadable as null', async () => {
    // The distinction the tool exists for: the first is unconstrained, the
    // second may already be over a limit that cannot be seen.
    const [none, unreadable] = await rowsFrom([
      dataset({ id: 'tank/none', quota: { parsed: 0 } }),
      without(dataset({ id: 'tank/unreadable' }), 'quota'),
    ]);
    expect(none['quota_bytes']).toBe(0);
    expect(unreadable['quota_bytes']).toBeNull();
    // Neither yields a percentage, and for different reasons — nothing is a
    // percentage of unlimited, and nothing is a percentage of unknown.
    expect(none['quota_used_percent']).toBeNull();
    expect(unreadable['quota_used_percent']).toBeNull();
  });

  it('reads an explicitly null limit as no limit rather than as unreadable', async () => {
    // The client types the same field `number | (0 | null)`, so null is ZFS
    // spelling "no limit" the other of its two ways — in either position.
    const [nullParsed, nullProperty] = await rowsFrom([
      dataset({ id: 'tank/a', refquota: { parsed: null } }),
      dataset({ id: 'tank/b', refquota: null }),
    ]);
    expect(nullParsed['refquota_bytes']).toBe(0);
    expect(nullProperty['refquota_bytes']).toBe(0);
    expect(nullParsed['refquota_used_percent']).toBeNull();
    expect(nullProperty['refquota_used_percent']).toBeNull();
  });

  it('treats a property carrying no parsed value as unreadable', async () => {
    const [row] = await rowsFrom([dataset({ quota: {}, refquota: { parsed: 'unlimited' } })]);
    expect(row['quota_bytes']).toBeNull();
    expect(row['refquota_bytes']).toBeNull();
  });

  it('survives a limit the middleware sends as a bare value rather than a property', async () => {
    // The row is `unknown` at this seam, and a primitive would throw on the
    // `in` test that looks for `parsed` — taking the whole report down with it
    // rather than losing the one field it could not read.
    const [row] = await rowsFrom([dataset({ quota: 12345, refquota: 'none' })]);
    expect(row['quota_bytes']).toBeNull();
    expect(row['refquota_bytes']).toBeNull();
    // The rest of the row still stands.
    expect(row['used_bytes']).toBe(75);
  });

  it('reports an unreadable usage as null rather than as nothing used', async () => {
    const [row] = await rowsFrom([dataset({ used: { parsed: Number.NaN }, referenced: {} })]);
    expect(row['used_bytes']).toBeNull();
    expect(row['referenced_bytes']).toBeNull();
    expect(row['quota_used_percent']).toBeNull();
    expect(row['refquota_used_percent']).toBeNull();
  });

  it('states a percentage to one decimal place', async () => {
    const [row] = await rowsFrom([dataset({ used: { parsed: 1 }, quota: { parsed: 3 } })]);
    expect(row['quota_used_percent']).toBe(33.3);
  });

  it('does not cap a percentage at 100', async () => {
    // A refquota lowered below what the dataset already references. Capping it
    // would hide exactly the dataset this tool is asked to find.
    const [row] = await rowsFrom([dataset({ referenced: { parsed: 60 }, refquota: { parsed: 40 } })]);
    expect(row['refquota_used_percent']).toBe(150);
  });

  it('does not duplicate datasets nested under children of other entries', async () => {
    // pool.dataset.query returns every dataset as a top-level entry while each
    // entry also nests its descendants under `children`.
    const child = dataset({ id: 'tank/media/movies' });
    const rows = await rowsFrom([dataset({ id: 'tank/media', children: [child] }), child]);
    expect(rows.map((row) => row['id'])).toEqual(['tank/media', 'tank/media/movies']);
  });

  it('returns every dataset when no threshold is given', async () => {
    const rows = await rowsFrom([
      dataset({ id: 'tank/idle' }),
      dataset({ id: 'tank/none', quota: { parsed: 0 }, refquota: { parsed: 0 } }),
    ]);
    expect(rows.map((row) => row['id'])).toEqual(['tank/idle', 'tank/none']);
  });

  it('keeps a dataset at or above the threshold on either limit', async () => {
    const rows = await rowsFrom(
      [
        // 25% of quota, 50% of refquota — kept on the refquota alone.
        dataset({ id: 'tank/refquota-only' }),
        // 90% of quota, no refquota — kept on the quota alone.
        dataset({ id: 'tank/quota-only', used: { parsed: 90 }, quota: { parsed: 100 }, refquota: { parsed: 0 } }),
        // Exactly at the threshold, which is "at or above".
        dataset({ id: 'tank/exact', used: { parsed: 50 }, quota: { parsed: 100 }, refquota: { parsed: 0 } }),
        // Below on both.
        dataset({ id: 'tank/quiet', used: { parsed: 1 }, referenced: { parsed: 1 } }),
        // No percentage at all, on either limit.
        without(dataset({ id: 'tank/unreadable', refquota: { parsed: 0 } }), 'quota'),
      ],
      { threshold_percent: 50 },
    );
    expect(rows.map((row) => row['id'])).toEqual([
      'tank/refquota-only',
      'tank/quota-only',
      'tank/exact',
    ]);
  });

  it('ignores a threshold that is not a number', async () => {
    // Both percentages sit below the threshold — 0.3% of quota and 2.5% of
    // refquota — so the dataset survives only because the filter never runs.
    // A comparison against the string would coerce it and keep any dataset at
    // or above 50 on either limit, which is what makes this row the one that
    // tells the two paths apart.
    const rows = await rowsFrom([dataset({ used: { parsed: 1 }, referenced: { parsed: 1 } })], {
      threshold_percent: '50',
    });
    expect(rows.map((row) => row['id'])).toEqual(['tank/media']);
  });

  it('asks the middleware for the two limits and the two usages they cap', async () => {
    const { ctx, query } = fakeSystem({ ['pool.dataset.query']: [] });
    await quotaReport.handler(ctx, {});
    // `referenced` is requested by name because it is the property `refquota`
    // caps; without it the refquota percentage could only be computed against
    // `used`, which caps nothing of the sort.
    expect(query).toHaveBeenCalledWith('pool.dataset.query', [], {
      extra: {
        retrieve_children: true,
        properties: ['used', 'referenced', 'quota', 'refquota'],
      },
    });
  });
});

describe('system_dataset_config', () => {
  const config = (over: Record<string, unknown> = {}) => ({
    id: 1,
    pool: 'tank',
    pool_set: true,
    uuid: '2b3c4d5e6f708192a3b4c5d6e7f80912',
    basename: 'tank/.system',
    path: '/var/db/system',
    ...over,
  });

  const readFrom = async (answer: unknown): Promise<Record<string, unknown>> => {
    const { ctx } = fakeSystem({ ['systemdataset.config']: answer });
    return (await systemDatasetConfig.handler(ctx, {})) as Record<string, unknown>;
  };

  it('reports the pool, whether it was chosen, and where the dataset is mounted', async () => {
    expect(await readFrom(config())).toEqual({
      pool: 'tank',
      pool_set: true,
      path: '/var/db/system',
    });
  });

  it('reads systemdataset.config through the plain call seam', async () => {
    const { ctx, call } = fakeSystem({ ['systemdataset.config']: config() });
    await systemDatasetConfig.handler(ctx, {});
    expect(call).toHaveBeenCalledWith('systemdataset.config');
  });

  it("drops middleware's internal naming and surfaces no field a later release adds", async () => {
    // `id`, `uuid` and `basename` are declared on the payload and deliberately
    // absent from the result (#102), and the allowlist is what keeps a field a
    // later TrueNAS release adds out of it.
    const row = await readFrom(config({ dataset_quota: 'added by a later TrueNAS release' }));
    expect(Object.keys(row)).toEqual(['pool', 'pool_set', 'path']);
  });

  it('keeps a pool middleware selected distinct from one an administrator chose', async () => {
    // The distinction the tool exists for: the first is a decision, the second
    // is a default that need not stay where it is.
    const chosen = await readFrom(config({ pool_set: true }));
    const automatic = await readFrom(config({ pool: 'boot-pool', pool_set: false }));
    expect(chosen['pool_set']).toBe(true);
    expect(automatic['pool_set']).toBe(false);
    expect(automatic['pool']).toBe('boot-pool');
  });

  it('reports an unreadable pool_set as null rather than as nobody having chosen', async () => {
    // Reading a value that is not a boolean as `false` would report an
    // administrator's decision as an accident.
    for (const unreadable of [undefined, null, 'true', 1]) {
      const row = await readFrom(config({ pool_set: unreadable }));
      expect(row['pool_set']).toBeNull();
    }
  });

  it('reports an unreadable pool as null rather than as a pool named nothing', async () => {
    const row = await readFrom(config({ pool: '' }));
    expect(row['pool']).toBeNull();
  });

  it('answers null for a path the system reported as null and for one it could not read', async () => {
    // Both land on one null on purpose: what the explicit null MEANS could not
    // be established, so separating it from an unreadable value would hand a
    // caller a distinction it still could not act on. The description names
    // both causes instead.
    const explicit = await readFrom(config({ path: null }));
    const unreadable = await readFrom(config({ path: 42 }));
    expect(explicit['path']).toBeNull();
    expect(unreadable['path']).toBeNull();
    // The rest of the row still stands — a null path is not the read failing.
    expect(explicit['pool']).toBe('tank');
    expect(unreadable['pool']).toBe('tank');
  });

  it('fails naming the read where the system did not answer with a configuration', async () => {
    // A list, a bare value or nothing at all is the read failing rather than a
    // configuration of nulls, and the caller is shown the read rather than the
    // name of a property that could not be indexed.
    for (const answer of [undefined, null, 'unavailable', [config()]]) {
      const { ctx } = fakeSystem({ ['systemdataset.config']: answer });
      await expect(systemDatasetConfig.handler(ctx, {})).rejects.toThrow(
        'systemdataset.config did not answer with a system dataset configuration',
      );
    }
  });
});
