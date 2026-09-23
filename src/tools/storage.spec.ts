import { describe, expect, it, vi } from 'vitest';
import { EMPTY, Observable, of, throwError } from 'rxjs';
import { fakeSystem } from '@/testing/fake-systems';
import { SystemHandle, ToolContext } from '@/catalog/tool';
import {
  datasetPermissions,
  listDatasets,
  poolStatus,
  quotaReport,
  systemDatasetConfig,
} from '@/tools/index';

describe('storage_pool_status', () => {
  /** One row of `pool.query`, with the fields this tool reads. */
  const pool = (over: Record<string, unknown> = {}) => ({
    id: 1,
    name: 'tank',
    status: 'ONLINE',
    healthy: true,
    size: 100,
    allocated: 40,
    free: 60,
    ...over,
  });

  interface Row {
    name: string | null;
    feature_flags_current: boolean | null;
  }

  interface Options {
    pools?: unknown[];
    /** What `pool.is_upgraded` answers, per pool id. */
    upgraded?: Record<number, unknown>;
    /** Keyed `pool.is_upgraded:<id>`, for one pool's read failing on its own. */
    failures?: Record<string, unknown>;
  }

  /**
   * A SystemHandle answering `pool.is_upgraded` PER POOL ID, which neither
   * `fakeSystem` nor `failingSystem` can do: both key on the method alone, and
   * every pool's flag comes back from the same method distinguished only by the
   * id asked for.
   */
  const poolSystem = (options: Options = {}) => {
    const failures = options.failures ?? {};
    const upgraded = options.upgraded ?? {};
    const query = vi.fn(() => of(options.pools ?? [pool()]));
    // The client takes a call's parameters as one tuple, so the id arrives
    // wrapped: `call('pool.is_upgraded', [1])`.
    const call = vi.fn((method: string, params: [number]) => {
      const key = `${method}:${params[0]}`;
      return key in failures ? throwError(() => failures[key]) : of(upgraded[params[0]]);
    });
    const system = { name: 'nas', client: { api: { call, query } } } as unknown as SystemHandle;
    return { ctx: { system } as ToolContext, call, query };
  };

  const rows = async (options: Options = {}): Promise<Row[]> =>
    (await poolStatus.handler(poolSystem(options).ctx, {})) as Row[];

  const flag = async (options: Options = {}): Promise<boolean | null> =>
    (await rows(options))[0].feature_flags_current;

  it('trims pool.query to health and capacity', async () => {
    const { ctx } = fakeSystem({
      ['pool.query']: [
        {
          id: 1,
          name: 'tank',
          status: 'ONLINE',
          healthy: true,
          size: 100,
          allocated: 40,
          free: 60,
          is_upgraded: true,
        },
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
        feature_flags_current: true,
      },
    ]);
  });

  it('reports the feature-flag state the pool row carried, and asks nothing further', async () => {
    const fake = poolSystem({ pools: [pool({ is_upgraded: true })] });
    const [row] = (await poolStatus.handler(fake.ctx, {})) as Row[];
    expect(row.feature_flags_current).toBe(true);
    // The row already answered, so the separate verb is a call nothing needs.
    expect(fake.call).not.toHaveBeenCalled();
  });

  it('reports a false the pool row carried rather than reading it again', async () => {
    // `false` is the answer this tool exists to surface and it is also falsy,
    // so a fallback written as `carried || read()` would ask the middleware a
    // second question about a pool that had already answered.
    const fake = poolSystem({ pools: [pool({ is_upgraded: false })], upgraded: { 1: true } });
    const [row] = (await poolStatus.handler(fake.ctx, {})) as Row[];
    expect(row.feature_flags_current).toBe(false);
    expect(fake.call).not.toHaveBeenCalled();
  });

  it('reads the flag by the pool own id where the row did not carry one', async () => {
    const fake = poolSystem({ pools: [pool({ id: 7 })], upgraded: { 7: false } });
    const [row] = (await poolStatus.handler(fake.ctx, {})) as Row[];
    expect(row.feature_flags_current).toBe(false);
    expect(fake.call.mock.calls).toEqual([['pool.is_upgraded', [7]]]);
  });

  it('reads each pool by its own id, so two pools do not share one answer', async () => {
    const fake = poolSystem({
      pools: [pool({ id: 1 }), pool({ id: 2, name: 'vault' })],
      upgraded: { 1: true, 2: false },
    });
    const result = (await poolStatus.handler(fake.ctx, {})) as Row[];
    expect(result.map((row) => row.feature_flags_current)).toEqual([true, false]);
    expect(fake.call.mock.calls).toEqual([
      ['pool.is_upgraded', [1]],
      ['pool.is_upgraded', [2]],
    ]);
  });

  it('issues every fallback read together rather than one pool after another', async () => {
    // Nothing answers until it is released, so a sequential fan-out would have
    // subscribed to the first read and stopped there. Both being outstanding at
    // once is what says the reads were issued together.
    const release: ((value: boolean) => void)[] = [];
    const call = vi.fn(
      () =>
        new Observable<unknown>((subscriber) => {
          release.push((value) => {
            subscriber.next(value);
            subscriber.complete();
          });
        }),
    );
    const query = vi.fn(() => of([pool({ id: 1 }), pool({ id: 2, name: 'vault' })]));
    const system = { name: 'nas', client: { api: { call, query } } } as unknown as SystemHandle;
    const answered = poolStatus.handler({ system } as ToolContext, {});
    await vi.waitFor(() => expect(release).toHaveLength(2));
    release[0](true);
    release[1](false);
    expect(((await answered) as Row[]).map((row) => row.feature_flags_current)).toEqual([
      true,
      false,
    ]);
  });

  it('reports no flag, and asks nothing, for a pool with no id to ask about', async () => {
    const fake = poolSystem({ pools: [pool({ id: null })] });
    const [row] = (await poolStatus.handler(fake.ctx, {})) as Row[];
    expect(row.feature_flags_current).toBeNull();
    expect(fake.call).not.toHaveBeenCalled();
  });

  it('reports no flag where the separate read was refused', async () => {
    expect(await flag({ failures: { ['pool.is_upgraded:1']: { reason: 'no such pool' } } })).toBeNull();
  });

  it('reports no flag where the read answered with something that is not a boolean', async () => {
    expect(await flag({ upgraded: { 1: 'yes' } })).toBeNull();
  });

  it('reports no flag where the read completed without answering at all', async () => {
    // `firstValueFrom` raises on an observable that completes without emitting.
    // That is neither a refusal nor a non-boolean answer, which is why the
    // description says what a null rules out rather than listing its causes.
    const call = vi.fn(() => EMPTY);
    const query = vi.fn(() => of([pool({ id: 1 })]));
    const system = { name: 'nas', client: { api: { call, query } } } as unknown as SystemHandle;
    const [row] = (await poolStatus.handler({ system } as ToolContext, {})) as Row[];
    expect(row.feature_flags_current).toBeNull();
  });

  it('reports no flag where the row carried one that is not a boolean', async () => {
    // The row's value is unreadable rather than absent, and the verb is still
    // asked — it is the authoritative source for this question either way.
    const fake = poolSystem({ pools: [pool({ is_upgraded: 'yes' })], upgraded: { 1: true } });
    const [row] = (await poolStatus.handler(fake.ctx, {})) as Row[];
    expect(row.feature_flags_current).toBe(true);
    expect(fake.call.mock.calls).toEqual([['pool.is_upgraded', [1]]]);
  });

  it('keeps every other field of a pool whose flag could not be read', async () => {
    // This tool is composed by `system_health_report` and, through it, by
    // `fleet_health_rollup`. A flag that cannot be read must not be able to
    // take down the catalog's most load-bearing read.
    const { ctx } = poolSystem({ failures: { ['pool.is_upgraded:1']: new Error('refused') } });
    expect(await poolStatus.handler(ctx, {})).toEqual([
      {
        name: 'tank',
        status: 'ONLINE',
        healthy: true,
        size_bytes: 100,
        allocated_bytes: 40,
        free_bytes: 60,
        feature_flags_current: null,
      },
    ]);
  });

  it('does not let one pool unreadable flag reach another pool', async () => {
    const result = await rows({
      pools: [pool({ id: 1 }), pool({ id: 2, name: 'vault' })],
      upgraded: { 2: true },
      failures: { ['pool.is_upgraded:1']: new Error('refused') },
    });
    expect(result.map((row) => row.feature_flags_current)).toEqual([null, true]);
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

describe('dataset_permissions', () => {
  /** One `pool.dataset.query` row, with the three fields this tool reads. */
  const dataset = (over: Record<string, unknown> = {}) => ({
    id: 'tank/apps',
    type: 'FILESYSTEM',
    mountpoint: '/mnt/tank/apps',
    ...over,
  });

  /** One `filesystem.stat` answer, as the client declares the payload. */
  const stat = (over: Record<string, unknown> = {}) => ({
    realpath: '/mnt/tank/apps',
    type: 'DIRECTORY',
    // A directory's st_mode: the file-type bits above the permission bits.
    mode: 0o40750,
    uid: 3100,
    // Deliberately not the uid — the mistake this tool exists to make visible.
    gid: 3003,
    user: 'apps',
    group: 'appdata',
    acl: false,
    is_mountpoint: true,
    ...over,
  });

  /** One `filesystem.getacl` answer. */
  const acl = (over: Record<string, unknown> = {}) => ({
    path: '/mnt/tank/apps',
    uid: 3100,
    gid: 3003,
    user: 'apps',
    group: 'appdata',
    acltype: 'POSIX1E',
    trivial: true,
    ...over,
  });

  interface Options {
    datasets?: unknown[];
    /** What `filesystem.stat` answers, per path; anything else gets {@link stat}. */
    stats?: Record<string, unknown>;
    /** What `filesystem.getacl` answers, per path; anything else gets {@link acl}. */
    acls?: Record<string, unknown>;
    /** Keyed `<method>:<path>`, for one path's read failing on its own. */
    failures?: Record<string, unknown>;
  }

  /**
   * A SystemHandle answering the two path reads PER PATH, which neither
   * `fakeSystem` nor `failingSystem` can do: both key on the method alone, and
   * every dataset's ownership comes back from the same method distinguished
   * only by the path asked about.
   */
  const permissionSystem = (options: Options = {}) => {
    const failures = options.failures ?? {};
    const query = vi.fn(() => of(options.datasets ?? [dataset()]));
    // The client takes a call's parameters as one tuple, so the path arrives
    // wrapped: `call('filesystem.stat', ['/mnt/tank/apps'])`.
    const call = vi.fn((method: string, params: [string]) => {
      const path = params[0];
      const key = `${method}:${path}`;
      if (key in failures) return throwError(() => failures[key]);
      const answers = method === 'filesystem.stat' ? (options.stats ?? {}) : (options.acls ?? {});
      const fallback = method === 'filesystem.stat' ? stat() : acl();
      return of(path in answers ? answers[path] : fallback);
    });
    const system = { name: 'nas', client: { api: { call, query } } } as unknown as SystemHandle;
    return { ctx: { system } as ToolContext, call, query };
  };

  const readFrom = async (
    options: Options = {},
    args: Record<string, unknown> = { dataset: 'tank/apps' },
  ): Promise<Record<string, unknown>> =>
    (await datasetPermissions.handler(permissionSystem(options).ctx, args)) as Record<
      string,
      unknown
    >;

  const sectionsOf = async (options: Options = {}) => {
    const row = (await readFrom(options))['dataset'] as Record<string, unknown>;
    return {
      row,
      ownership: row['ownership'] as Record<string, unknown>,
      acl: row['acl'] as Record<string, unknown>,
    };
  };

  it('reports the owner, the mode and the ACL type of the mountpoint', async () => {
    expect(await readFrom()).toEqual({
      dataset: {
        id: 'tank/apps',
        type: 'FILESYSTEM',
        mountpoint: '/mnt/tank/apps',
        ownership: {
          unavailable: null,
          uid: 3100,
          gid: 3003,
          user: 'apps',
          group: 'appdata',
          mode_octal: '0750',
          is_mountpoint: true,
        },
        acl: { unavailable: null, acl_type: 'POSIX1E', acl_beyond_mode: false },
      },
      children: null,
      children_limit: null,
      children_truncated: null,
    });
  });

  it("reads both paths from the dataset's own mountpoint", async () => {
    const { ctx, call, query } = permissionSystem();
    await datasetPermissions.handler(ctx, { dataset: 'tank/apps' });
    // Named in the filter, so no tree walk is wanted — `snapshots.ts`'s shape
    // for the same question. The children read below is the other one.
    expect(query).toHaveBeenCalledWith('pool.dataset.query', [['id', '=', 'tank/apps']], {
      extra: { retrieve_children: false, properties: [] },
    });
    expect(call).toHaveBeenCalledWith('filesystem.stat', ['/mnt/tank/apps']);
    expect(call).toHaveBeenCalledWith('filesystem.getacl', ['/mnt/tank/apps']);
  });

  it('surfaces no field a later release adds to either payload', async () => {
    // The allowlist is what keeps one out; the exact key lists are what pin it.
    const { row, ownership, acl: aclSection } = await sectionsOf({
      stats: { ['/mnt/tank/apps']: stat({ project_id: 'added by a later release' }) },
      acls: { ['/mnt/tank/apps']: acl({ aclflags: { autoinherit: true } }) },
    });
    expect(Object.keys(row)).toEqual(['id', 'type', 'mountpoint', 'ownership', 'acl']);
    expect(Object.keys(ownership)).toEqual([
      'unavailable',
      'uid',
      'gid',
      'user',
      'group',
      'mode_octal',
      'is_mountpoint',
    ]);
    expect(Object.keys(aclSection)).toEqual(['unavailable', 'acl_type', 'acl_beyond_mode']);
  });

  it('reports the gid as its own reading rather than as the uid', async () => {
    const { ownership } = await sectionsOf({
      stats: { ['/mnt/tank/apps']: stat({ uid: 3100, gid: 3003 }) },
    });
    expect(ownership['uid']).toBe(3100);
    expect(ownership['gid']).toBe(3003);
  });

  it('reports a uid no account answers to as its number, with a null name', async () => {
    // Where the read landed, the number is the owner and the name is what the
    // system could not resolve — a name it could not resolve does not drop the
    // number with it. A null NUMBER is the separate case, covered above.
    const { ownership } = await sectionsOf({
      stats: { ['/mnt/tank/apps']: stat({ uid: 568, user: null, gid: 568, group: null }) },
    });
    expect(ownership).toMatchObject({ uid: 568, user: null, gid: 568, group: null });
  });

  it('masks the file-type bits off the mode and pads it to four octal digits', async () => {
    // `700` and `750` are distinguishable at a glance, and the leading digit is
    // not padding: it is setuid, setgid and the sticky bit.
    const modes: [number, string][] = [
      [0o40750, '0750'],
      [0o40700, '0700'],
      [0o42770, '2770'],
      [0o41777, '1777'],
      [0o750, '0750'],
      [0, '0000'],
    ];
    for (const [mode, expected] of modes) {
      const { ownership } = await sectionsOf({ stats: { ['/mnt/tank/apps']: stat({ mode }) } });
      expect(ownership['mode_octal']).toBe(expected);
    }
  });

  it('answers null for a mode that is not a mode rather than masking one out of it', async () => {
    // JavaScript's bitwise operators truncate to 32 bits, so masking any of
    // these would answer with plausible digits taken from the wrong number.
    for (const mode of [undefined, null, '0750', -1, 0.5, Number.NaN, 2 ** 40]) {
      const { ownership } = await sectionsOf({ stats: { ['/mnt/tank/apps']: stat({ mode }) } });
      expect(ownership['mode_octal']).toBeNull();
    }
  });

  it("passes the ACL type through as the system spelled it, mapping nothing", async () => {
    for (const acltype of ['NFS4', 'POSIX1E', 'DISABLED', 'SOMETHING_LATER']) {
      const { acl: section } = await sectionsOf({
        acls: { ['/mnt/tank/apps']: acl({ acltype }) },
      });
      expect(section['acl_type']).toBe(acltype);
    }
  });

  it('reads whether an ACL goes beyond the mode bits off the ACL read own trivial', async () => {
    const trivial = await sectionsOf({ acls: { ['/mnt/tank/apps']: acl({ trivial: true }) } });
    const rich = await sectionsOf({
      acls: { ['/mnt/tank/apps']: acl({ acltype: 'NFS4', trivial: false }) },
    });
    expect(trivial.acl['acl_beyond_mode']).toBe(false);
    expect(rich.acl['acl_beyond_mode']).toBe(true);
  });

  it('answers null and never false for an unreadable trivial', async () => {
    // False is the positive claim that the mode bits are the whole story, which
    // a caller acts on by trying to change them.
    for (const trivial of [undefined, null, 'true', 0]) {
      const { acl: section } = await sectionsOf({
        acls: { ['/mnt/tank/apps']: acl({ trivial }) },
      });
      expect(section['acl_beyond_mode']).toBeNull();
    }
  });

  it("ignores the stat payload's own acl boolean and the ACL read's own owner", async () => {
    // Neither reaches the result: the first has no stated meaning on the
    // surface (#102), the second is the ownership section's one derivation.
    const { ownership, acl: section } = await sectionsOf({
      stats: { ['/mnt/tank/apps']: stat({ acl: true, uid: 3100 }) },
      acls: { ['/mnt/tank/apps']: acl({ uid: 0, user: 'root', trivial: true }) },
    });
    expect(section['acl_beyond_mode']).toBe(false);
    expect(ownership['uid']).toBe(3100);
    expect(ownership['user']).toBe('apps');
  });

  it('lets each of the two reads fail without taking the other down', async () => {
    const statFailed = await sectionsOf({
      failures: { ['filesystem.stat:/mnt/tank/apps']: new Error('permission denied') },
    });
    expect(statFailed.ownership).toEqual({
      unavailable: 'permission denied',
      uid: null,
      gid: null,
      user: null,
      group: null,
      mode_octal: null,
      is_mountpoint: null,
    });
    expect(statFailed.acl).toEqual({
      unavailable: null,
      acl_type: 'POSIX1E',
      acl_beyond_mode: false,
    });

    const aclFailed = await sectionsOf({
      failures: { ['filesystem.getacl:/mnt/tank/apps']: { reason: 'ENOTSUP' } },
    });
    expect(aclFailed.acl).toEqual({
      unavailable: 'ENOTSUP',
      acl_type: null,
      acl_beyond_mode: null,
    });
    expect(aclFailed.ownership['uid']).toBe(3100);
  });

  it('reports a read that answered with something other than a record as unavailable', async () => {
    for (const answer of [undefined, null, 'denied', [stat()]]) {
      const { ownership } = await sectionsOf({ stats: { ['/mnt/tank/apps']: answer } });
      expect(ownership['unavailable']).toBe('filesystem.stat did not answer with a record');
      expect(ownership['uid']).toBeNull();
    }
    for (const answer of [undefined, null, 'denied', [acl()]]) {
      const { acl: section } = await sectionsOf({ acls: { ['/mnt/tank/apps']: answer } });
      expect(section['unavailable']).toBe('filesystem.getacl did not answer with a record');
      expect(section['acl_beyond_mode']).toBeNull();
    }
  });

  it('says the ownership read is not about the dataset where the path is not a mount point', async () => {
    // An unmounted dataset still has a directory at its mountpoint path, and a
    // stat of it comes back looking exactly like an answer about the dataset.
    const { ownership } = await sectionsOf({
      stats: { ['/mnt/tank/apps']: stat({ is_mountpoint: false, uid: 0, user: 'root' }) },
    });
    expect(ownership['is_mountpoint']).toBe(false);
    expect(ownership['uid']).toBe(0);
  });

  it('reports an unreadable is_mountpoint as null rather than as not mounted', async () => {
    const { ownership } = await sectionsOf({
      stats: { ['/mnt/tank/apps']: stat({ is_mountpoint: 'yes' }) },
    });
    expect(ownership['is_mountpoint']).toBeNull();
  });

  it('answers with the fact for a volume, which has no mountpoint at all', async () => {
    const { ctx, call } = permissionSystem({
      datasets: [dataset({ id: 'tank/vm-disk', type: 'VOLUME', mountpoint: null })],
    });
    const row = (
      (await datasetPermissions.handler(ctx, { dataset: 'tank/vm-disk' })) as Record<
        string,
        unknown
      >
    )['dataset'] as Record<string, unknown>;
    expect(row['type']).toBe('VOLUME');
    expect(row['mountpoint']).toBeNull();
    expect((row['ownership'] as Record<string, unknown>)['unavailable']).toBe(
      'the dataset reports no mountpoint, so there is no path to read',
    );
    expect((row['acl'] as Record<string, unknown>)['unavailable']).toBe(
      'the dataset reports no mountpoint, so there is no path to read',
    );
    // Nothing was asked about, rather than a call made with a path that is not
    // one and reported as a read that went wrong.
    expect(call).not.toHaveBeenCalled();
  });

  it('reads nothing from a mountpoint that is not a path, and reports it as spelled', async () => {
    // ZFS spells an unmounted filesystem `none` and an externally mounted one
    // `legacy`. Neither is a path.
    for (const mountpoint of ['none', 'legacy']) {
      const { ctx, call } = permissionSystem({ datasets: [dataset({ mountpoint })] });
      const row = (
        (await datasetPermissions.handler(ctx, { dataset: 'tank/apps' })) as Record<string, unknown>
      )['dataset'] as Record<string, unknown>;
      expect(row['mountpoint']).toBe(mountpoint);
      expect((row['ownership'] as Record<string, unknown>)['unavailable']).toBe(
        'the dataset reports a mountpoint that is not an absolute path, so there is no path to read',
      );
      expect(call).not.toHaveBeenCalled();
    }
  });

  it('fails naming a dataset the system does not list', async () => {
    const { ctx } = permissionSystem({ datasets: [] });
    await expect(datasetPermissions.handler(ctx, { dataset: 'tank/absent' })).rejects.toThrow(
      'Dataset "tank/absent" does not exist',
    );
  });

  it('fails naming the dataset where the filter did not apply and the whole table came back', async () => {
    // An unrecognised query parameter is dropped rather than refused, so a
    // filter that did not apply is indistinguishable from one that matched
    // everything — and a row count would read that as "it exists" for any name.
    const { ctx } = permissionSystem({
      datasets: [dataset({ id: 'tank' }), dataset({ id: 'tank/media' })],
    });
    await expect(datasetPermissions.handler(ctx, { dataset: 'tank/absent' })).rejects.toThrow(
      'Dataset "tank/absent" does not exist',
    );
  });

  it('answers about the dataset asked for rather than the first row that came back', async () => {
    const { ctx } = permissionSystem({
      datasets: [
        dataset({ id: 'tank', mountpoint: '/mnt/tank' }),
        dataset({ id: 'tank/apps', mountpoint: '/mnt/tank/apps' }),
      ],
    });
    const row = (
      (await datasetPermissions.handler(ctx, { dataset: 'tank/apps' })) as Record<string, unknown>
    )['dataset'] as Record<string, unknown>;
    expect(row['id']).toBe('tank/apps');
    expect(row['mountpoint']).toBe('/mnt/tank/apps');
  });

  it('reports no children unless they were asked for, and asks for one dataset', async () => {
    const { ctx, call, query } = permissionSystem({
      datasets: [dataset(), dataset({ id: 'tank/apps/postgres' })],
    });
    const result = (await datasetPermissions.handler(ctx, { dataset: 'tank/apps' })) as Record<
      string,
      unknown
    >;
    expect(result['children']).toBeNull();
    expect(result['children_limit']).toBeNull();
    expect(result['children_truncated']).toBeNull();
    expect(query).toHaveBeenCalledWith('pool.dataset.query', [['id', '=', 'tank/apps']], {
      extra: { retrieve_children: false, properties: [] },
    });
    // Two reads, over the one dataset asked about.
    expect(call).toHaveBeenCalledTimes(2);
  });

  it('reports every descendant at any depth, ordered by id, when asked', async () => {
    const { ctx, query } = permissionSystem({
      datasets: [
        dataset({ id: 'tank/apps/postgres', mountpoint: '/mnt/tank/apps/postgres' }),
        dataset({ id: 'tank/appsdata', mountpoint: '/mnt/tank/appsdata' }),
        dataset(),
        dataset({ id: 'tank/apps/nextcloud/data', mountpoint: '/mnt/tank/apps/nextcloud/data' }),
        dataset({ id: 'tank/apps/nextcloud', mountpoint: '/mnt/tank/apps/nextcloud' }),
      ],
    });
    const result = (await datasetPermissions.handler(ctx, {
      dataset: 'tank/apps',
      include_children: true,
    })) as Record<string, unknown>;
    // `tank/appsdata` shares a prefix and is NOT beneath `tank/apps`; the
    // grandchild is.
    expect((result['children'] as Record<string, unknown>[]).map((child) => child['id'])).toEqual([
      'tank/apps/nextcloud',
      'tank/apps/nextcloud/data',
      'tank/apps/postgres',
    ]);
    expect(result['children_truncated']).toBe(false);
    expect(result['children_limit']).toBe(50);
    // Every dataset, since the descendants are matched on the response — and
    // `retrieve_children` is what makes the middleware walk the tree that
    // produces that flat listing, as the two tools above pass it for.
    expect(query).toHaveBeenCalledWith('pool.dataset.query', [], {
      extra: { retrieve_children: true, properties: [] },
    });
  });

  it('leaves a row whose id could not be read out of the children', async () => {
    // It names no dataset, so nothing establishes that it is beneath this one —
    // and a caller could not tell it from a sibling of the same shape.
    const result = await readFrom(
      {
        datasets: [
          dataset(),
          { type: 'FILESYSTEM', mountpoint: '/mnt/tank/apps/nameless' },
          dataset({ id: 'tank/apps/postgres', mountpoint: '/mnt/tank/apps/postgres' }),
        ],
      },
      { dataset: 'tank/apps', include_children: true },
    );
    expect((result['children'] as Record<string, unknown>[]).map((child) => child['id'])).toEqual([
      'tank/apps/postgres',
    ]);
    // It is counted nowhere: dropped before the cap is compared, so it does not
    // set `children_truncated` either. The guidance says so rather than letting
    // a short list read as the whole of what is beneath the dataset.
    expect(result['children_truncated']).toBe(false);
  });

  it('reports an empty list where a dataset asked about children has none', async () => {
    // Empty and null are different answers: this one has no descendants, where
    // null is a caller that did not ask.
    const result = await readFrom({}, { dataset: 'tank/apps', include_children: true });
    expect(result['children']).toEqual([]);
    expect(result['children_truncated']).toBe(false);
  });

  it('caps the descendants reported and says the list is incomplete', async () => {
    const children = Array.from({ length: 60 }, (unused, index) =>
      dataset({
        id: `tank/apps/child-${String(index).padStart(2, '0')}`,
        mountpoint: `/mnt/tank/apps/child-${String(index).padStart(2, '0')}`,
      }),
    );
    const result = await readFrom(
      { datasets: [dataset(), ...children] },
      { dataset: 'tank/apps', include_children: true },
    );
    const reported = result['children'] as Record<string, unknown>[];
    expect(reported).toHaveLength(50);
    expect(reported[0]['id']).toBe('tank/apps/child-00');
    expect(reported[49]['id']).toBe('tank/apps/child-49');
    expect(result['children_truncated']).toBe(true);
    expect(result['children_limit']).toBe(50);
  });

  it('reports a child whose own reads failed beside siblings that answered', async () => {
    const result = await readFrom(
      {
        datasets: [
          dataset(),
          dataset({ id: 'tank/apps/postgres', mountpoint: '/mnt/tank/apps/postgres' }),
          dataset({ id: 'tank/apps/vol', type: 'VOLUME', mountpoint: null }),
        ],
        stats: {
          ['/mnt/tank/apps/postgres']: stat({ mode: 0o40700, uid: 999, user: 'postgres' }),
        },
        failures: { ['filesystem.getacl:/mnt/tank/apps/postgres']: new Error('ENOTSUP') },
      },
      { dataset: 'tank/apps', include_children: true },
    );
    const children = result['children'] as Record<string, unknown>[];
    expect(children.map((child) => child['id'])).toEqual(['tank/apps/postgres', 'tank/apps/vol']);
    expect(children[0]['ownership']).toMatchObject({ mode_octal: '0700', uid: 999 });
    expect(children[0]['acl']).toMatchObject({ unavailable: 'ENOTSUP', acl_beyond_mode: null });
    expect(children[1]['ownership']).toMatchObject({
      unavailable: 'the dataset reports no mountpoint, so there is no path to read',
    });
  });

  it('reports an unreadable id, type or mountpoint as null rather than as text', async () => {
    const { ctx } = permissionSystem({
      datasets: [{ id: 'tank/apps', type: 7, mountpoint: '' }],
    });
    const row = (
      (await datasetPermissions.handler(ctx, { dataset: 'tank/apps' })) as Record<string, unknown>
    )['dataset'] as Record<string, unknown>;
    expect(row['type']).toBeNull();
    expect(row['mountpoint']).toBeNull();
    expect((row['acl'] as Record<string, unknown>)['unavailable']).toBe(
      'the dataset reports no mountpoint, so there is no path to read',
    );
  });

  it('requires a dataset and refuses a non-boolean include_children', async () => {
    const { ctx } = permissionSystem();
    for (const args of [{}, { dataset: '' }, { dataset: 42 }]) {
      await expect(datasetPermissions.handler(ctx, args)).rejects.toThrow('"dataset" is required');
    }
    // Strict rather than coerced: a truthy string read as true would walk a
    // whole pool's descendants on a caller that asked about one dataset.
    for (const requested of ['true', 1, {}]) {
      await expect(
        datasetPermissions.handler(ctx, { dataset: 'tank/apps', include_children: requested }),
      ).rejects.toThrow('"include_children" must be a boolean');
    }
    // Null and undefined are "not asked for" rather than a bad argument.
    for (const requested of [null, undefined]) {
      const result = (await datasetPermissions.handler(ctx, {
        dataset: 'tank/apps',
        include_children: requested,
      })) as Record<string, unknown>;
      expect(result['children']).toBeNull();
    }
  });

  it('carries the interpretation half in both fields, and only that half', async () => {
    // One hoisted const referenced twice (#131), so no reflow can drift them.
    expect(datasetPermissions.description).toContain(datasetPermissions.resultGuidance ?? '');
    expect(datasetPermissions.description.endsWith(datasetPermissions.resultGuidance ?? '')).toBe(
      true,
    );
    // The selection half stays out of it: which id the tool takes, and that
    // nothing here changes a permission, are things a caller needs BEFORE it
    // chooses the tool.
    expect(datasetPermissions.resultGuidance).not.toContain('THIS TOOL ONLY READS');
  });
});
