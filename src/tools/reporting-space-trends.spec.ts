import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { of, throwError } from 'rxjs';
import { SystemHandle, ToolContext } from '@/catalog/tool';
import { reportingSpaceTrends } from '@/tools/index';

describe('reporting_space_trends', () => {
  /** The same fixed present as the two graph tools, for the same reason. */
  const NOW = 1_700_000_000_000; // 2023-11-14T22:13:20.000Z

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** An instant that many days before the fixed present. */
  const day = (before: number): number => NOW - before * 24 * 60 * 60 * 1000;

  /**
   * A range wide enough to hold every fixture below. The default range is one
   * hour, which no snapshot in these tests falls in — which is itself the point
   * the tool's description makes about its own default.
   */
  const RANGE = { start: '2023-10-01', end: '2023-12-01' };

  /** A snapshot row as `pool.snapshot.query` answers with one. */
  const snap = (at: number, bytes: number): unknown => ({
    name: `tank/x@${at}`,
    dataset: 'tank/x',
    // Seconds as a string, which is how ZFS states `creation`'s raw value.
    properties: { creation: { rawvalue: String(at / 1000) }, referenced: { parsed: bytes } },
  });

  /** A dataset row as `pool.dataset.query` answers with one. */
  const dataset = (id: string, pool: string, used: number | null): unknown => ({
    id,
    pool,
    used: used === null ? undefined : { parsed: used },
  });

  interface Fake {
    ctx: ToolContext;
    query: ReturnType<typeof vi.fn>;
  }

  /**
   * A SystemHandle answering the three listings this tool reads. Snapshots are
   * keyed by the dataset the call filtered on, since every dataset's history
   * comes back from the same method; a key present in `failures` — a method name
   * or a dataset name — rejects instead.
   */
  const spaceSystem = (
    options: {
      datasets?: unknown[];
      pools?: unknown[];
      snapshots?: Record<string, unknown[]>;
      failures?: Record<string, unknown>;
    } = {},
  ): Fake => {
    const failures = options.failures ?? {};
    const query = vi.fn((method: string, filters?: unknown) => {
      if (method === 'pool.snapshot.query') {
        const asked = (filters as [string, string, string][])[0][2];
        return asked in failures
          ? throwError(() => failures[asked])
          : of(options.snapshots?.[asked] ?? []);
      }
      if (method in failures) return throwError(() => failures[method]);
      if (method === 'pool.query') {
        return of(options.pools ?? [{ name: 'tank', size: 10e9, allocated: 6e9, free: 4e9 }]);
      }
      return of(
        options.datasets ?? [dataset('tank/media', 'tank', 5e9), dataset('tank/vm', 'tank', 1e9)],
      );
    });
    const system = { name: 'nas', client: { api: { query } } } as unknown as SystemHandle;
    return { ctx: { system }, query };
  };

  /** Two datasets with histories: one growing over twenty days, one shrinking over ten. */
  const healthy = (): Fake =>
    spaceSystem({
      snapshots: {
        'tank/media': [snap(day(30), 1e9), snap(day(10), 3e9)],
        'tank/vm': [snap(day(30), 5e8), snap(day(20), 3e8)],
      },
    });

  interface Trend {
    referenced_start_bytes: number | null;
    referenced_end_bytes: number | null;
    change_bytes: number | null;
    change_bytes_per_day: number | null;
    observed_start: string | null;
    observed_end: string | null;
    snapshots_observed: number;
    unavailable: string | null;
  }

  interface DatasetEntry extends Trend {
    dataset: string;
    pool: string;
    used_bytes: number | null;
  }

  interface PoolEntry {
    pool: string;
    used_bytes: number | null;
    free_bytes: number | null;
    total_bytes: number | null;
    used_percent: number | null;
    levels_unavailable: string | null;
    referenced_change_bytes: number | null;
    referenced_change_bytes_per_day: number | null;
    observed_start: string | null;
    observed_end: string | null;
    datasets_observed: number;
    datasets_total: number | null;
    unavailable: string | null;
  }

  interface Report {
    start: string;
    end: string;
    as_of: string;
    pools: PoolEntry[];
    datasets: DatasetEntry[];
    truncated_datasets: boolean;
    truncated_snapshots: boolean;
  }

  const reported = async (fake: Fake, args: Record<string, unknown> = RANGE): Promise<Report> =>
    (await reportingSpaceTrends.handler(fake.ctx, args)) as Report;

  /** One dataset of a result, by name. */
  const entry = (report: Report, name: string): DatasetEntry =>
    report.datasets.filter((row) => row.dataset === name)[0];

  it('reports what a dataset referenced at each end of its history and the rate between', async () => {
    expect(entry(await reported(healthy()), 'tank/media')).toEqual({
      dataset: 'tank/media',
      pool: 'tank',
      used_bytes: 5e9,
      referenced_start_bytes: 1e9,
      referenced_end_bytes: 3e9,
      change_bytes: 2e9,
      // Two gibibytes over the twenty days actually observed, not over the two
      // months asked about.
      change_bytes_per_day: 1e8,
      observed_start: '2023-10-15T22:13:20.000Z',
      observed_end: '2023-11-04T22:13:20.000Z',
      snapshots_observed: 2,
      unavailable: null,
    });
  });

  it('reports a dataset that shrank as a negative change', async () => {
    expect(entry(await reported(healthy()), 'tank/vm')).toMatchObject({
      change_bytes: -2e8,
      change_bytes_per_day: -2e7,
    });
  });

  it('states the range it was asked about and when the levels were read', async () => {
    expect(await reported(healthy())).toMatchObject({
      start: '2023-10-01T00:00:00.000Z',
      end: '2023-12-01T00:00:00.000Z',
      as_of: '2023-11-14T22:13:20.000Z',
      truncated_datasets: false,
      truncated_snapshots: false,
    });
  });

  it('returns only the fields it names', async () => {
    const report = await reported(healthy());
    expect(Object.keys(report)).toEqual([
      'start',
      'end',
      'as_of',
      'pools',
      'datasets',
      'truncated_datasets',
      'truncated_snapshots',
    ]);
    expect(Object.keys(entry(report, 'tank/media'))).toEqual([
      'dataset',
      'pool',
      'used_bytes',
      'referenced_start_bytes',
      'referenced_end_bytes',
      'change_bytes',
      'change_bytes_per_day',
      'observed_start',
      'observed_end',
      'snapshots_observed',
      'unavailable',
    ]);
    expect(Object.keys(report.pools[0])).toEqual([
      'pool',
      'used_bytes',
      'free_bytes',
      'total_bytes',
      'used_percent',
      'levels_unavailable',
      'referenced_change_bytes',
      'referenced_change_bytes_per_day',
      'observed_start',
      'observed_end',
      'datasets_observed',
      'datasets_total',
      'unavailable',
    ]);
  });

  it("sums the pool's change over the datasets it reported, and says how far that reaches", async () => {
    expect((await reported(healthy())).pools[0]).toEqual({
      pool: 'tank',
      used_bytes: 6e9,
      free_bytes: 4e9,
      total_bytes: 10e9,
      used_percent: 60,
      levels_unavailable: null,
      referenced_change_bytes: 1.8e9,
      referenced_change_bytes_per_day: 8e7,
      // The widest window any contributing dataset was observed over.
      observed_start: '2023-10-15T22:13:20.000Z',
      observed_end: '2023-11-04T22:13:20.000Z',
      datasets_observed: 2,
      datasets_total: 2,
      unavailable: null,
    });
  });

  it('drops samples outside the range rather than measuring against them', async () => {
    const fake = spaceSystem({
      snapshots: { 'tank/media': [snap(day(300), 1e6), snap(day(30), 1e9), snap(day(10), 3e9)] },
    });
    expect(entry(await reported(fake), 'tank/media')).toMatchObject({
      referenced_start_bytes: 1e9,
      snapshots_observed: 2,
    });
  });

  it('marks a dataset the system holds no snapshot of in the range', async () => {
    const report = await reported(spaceSystem({}));
    expect(entry(report, 'tank/media')).toMatchObject({
      used_bytes: 5e9,
      change_bytes: null,
      change_bytes_per_day: null,
      observed_start: null,
      snapshots_observed: 0,
      unavailable: 'the system holds no snapshot of this dataset in this range',
    });
  });

  it('marks a dataset snapshotted only at one instant as a level rather than a change', async () => {
    // Two snapshots, one instant: there is something to read and it is not a
    // change, and reporting zero would say the dataset held still.
    const fake = spaceSystem({
      snapshots: { 'tank/media': [snap(day(30), 1e9), snap(day(30), 2e9)] },
    });
    expect(entry(await reported(fake), 'tank/media')).toMatchObject({
      change_bytes: null,
      snapshots_observed: 2,
      unavailable:
        'the system holds no two snapshots of this dataset taken at different times in this range',
    });
  });

  it('names a failed snapshot read on that dataset alone', async () => {
    const fake = spaceSystem({
      snapshots: { 'tank/vm': [snap(day(30), 5e8), snap(day(20), 3e8)] },
      failures: { 'tank/media': new Error('dataset is locked') },
    });
    const report = await reported(fake);
    expect(entry(report, 'tank/media')).toMatchObject({
      change_bytes: null,
      snapshots_observed: 0,
      unavailable: 'dataset is locked',
    });
    expect(entry(report, 'tank/vm').unavailable).toBeNull();
    // The pool still reports the dataset that did answer, over one of two.
    expect(report.pools[0]).toMatchObject({ datasets_observed: 1, datasets_total: 2 });
  });

  it('reports a failure carrying no text of its own rather than an empty reason', async () => {
    const fake = spaceSystem({ failures: { 'tank/media': { reason: 'ENOENT' } } });
    expect(entry(await reported(fake), 'tank/media').unavailable).toBe('ENOENT');
    const bare = spaceSystem({ failures: { 'tank/media': '' } });
    expect(entry(await reported(bare), 'tank/media').unavailable).toBe(
      'the system reported no reason',
    );
  });

  it('ignores a snapshot whose time or size it cannot read', async () => {
    const fake = spaceSystem({
      snapshots: {
        'tank/media': [
          snap(day(30), 1e9),
          { name: 'x', properties: { creation: { rawvalue: 'yesterday' }, referenced: {} } },
          { name: 'y', properties: { creation: { rawvalue: '' }, referenced: { parsed: 5 } } },
          { name: 'z', properties: { creation: { rawvalue: 1e15 }, referenced: { parsed: 5 } } },
          { name: 'w' },
          snap(day(10), 3e9),
        ],
      },
    });
    expect(entry(await reported(fake), 'tank/media')).toMatchObject({
      snapshots_observed: 2,
      change_bytes: 2e9,
    });
  });

  it('takes the ends of the history whatever order the system listed it in', async () => {
    // No order is asked for, so none is assumed: the same two snapshots listed
    // newest first must give the same change rather than its negation.
    const fake = spaceSystem({
      snapshots: { 'tank/media': [snap(day(10), 3e9), snap(day(20), 2e9), snap(day(30), 1e9)] },
    });
    expect(entry(await reported(fake), 'tank/media')).toMatchObject({
      referenced_start_bytes: 1e9,
      referenced_end_bytes: 3e9,
      change_bytes: 2e9,
      observed_start: '2023-10-15T22:13:20.000Z',
      observed_end: '2023-11-04T22:13:20.000Z',
    });
  });

  it('reads the creation time whether the system states it as digits or as a number', async () => {
    const fake = spaceSystem({
      snapshots: {
        'tank/media': [
          { properties: { creation: { rawvalue: day(30) / 1000 }, referenced: { parsed: 1e9 } } },
          snap(day(10), 3e9),
        ],
      },
    });
    expect(entry(await reported(fake), 'tank/media').observed_start).toBe(
      '2023-10-15T22:13:20.000Z',
    );
  });

  it('reports the ten largest datasets and says when it left some out', async () => {
    const many = Array.from({ length: 12 }, (_, index) =>
      dataset(`tank/d${index}`, 'tank', index * 1e9),
    );
    const report = await reported(spaceSystem({ datasets: many }));
    expect(report.truncated_datasets).toBe(true);
    // Largest first, and the two smallest left out — not the alphabetical ten.
    expect(report.datasets.map((row) => row.dataset)).toEqual([
      'tank/d11',
      'tank/d10',
      'tank/d9',
      'tank/d8',
      'tank/d7',
      'tank/d6',
      'tank/d5',
      'tank/d4',
      'tank/d3',
      'tank/d2',
    ]);
    // Every dataset the system named counts towards the pool's coverage, not
    // only the ten reported.
    expect(report.pools[0].datasets_total).toBe(12);
  });

  it('breaks a tie on the dataset name and orders an unreadable size last', async () => {
    const report = await reported(
      spaceSystem({
        datasets: [
          dataset('tank/b', 'tank', 1e9),
          dataset('tank/unknown', 'tank', null),
          dataset('tank/a', 'tank', 1e9),
        ],
      }),
    );
    expect(report.datasets.map((row) => row.dataset)).toEqual([
      'tank/a',
      'tank/b',
      'tank/unknown',
    ]);
    expect(entry(report, 'tank/unknown').used_bytes).toBeNull();
  });

  it('says when a dataset held more snapshots than it read', async () => {
    const many = Array.from({ length: 1001 }, (_, index) =>
      snap(day(30) + index * 60_000, 1000 + index),
    );
    const report = await reported(spaceSystem({ snapshots: { 'tank/media': many } }));
    expect(report.truncated_snapshots).toBe(true);
    // The thousand it read, and the ends of those rather than of the range.
    expect(entry(report, 'tank/media')).toMatchObject({
      snapshots_observed: 1000,
      referenced_start_bytes: 1000,
      referenced_end_bytes: 1999,
    });
  });

  it('does not claim a dataset holds no snapshot when it read only some of them', async () => {
    // A thousand snapshots read, all of them before the range, and no order was
    // asked for — so what lies inside the range is exactly what was not read.
    const many = Array.from({ length: 1001 }, (_, index) =>
      snap(day(300) + index * 60_000, 1000 + index),
    );
    const report = await reported(spaceSystem({ snapshots: { 'tank/media': many } }));
    expect(report.truncated_snapshots).toBe(true);
    expect(entry(report, 'tank/media')).toMatchObject({
      snapshots_observed: 0,
      change_bytes: null,
      unavailable:
        'the system holds more snapshots of this dataset than were read, and no two of ' +
        'the ones read fall at different times in this range',
    });
  });

  it('says the same of a truncated read that found only one instant', async () => {
    // Every snapshot read is at one instant inside the range, so what would
    // have given a second instant is exactly what was left unread.
    const many = Array.from({ length: 1001 }, (_, index) => snap(day(30), 1000 + index));
    const report = await reported(spaceSystem({ snapshots: { 'tank/media': many } }));
    expect(entry(report, 'tank/media')).toMatchObject({
      snapshots_observed: 1000,
      change_bytes: null,
      unavailable:
        'the system holds more snapshots of this dataset than were read, and no two of ' +
        'the ones read fall at different times in this range',
    });
  });

  it('marks a pool no dataset of which could be measured', async () => {
    const report = await reported(spaceSystem({}));
    expect(report.pools[0]).toMatchObject({
      used_percent: 60,
      referenced_change_bytes: null,
      referenced_change_bytes_per_day: null,
      observed_start: null,
      observed_end: null,
      datasets_observed: 0,
      datasets_total: 2,
      unavailable:
        'no dataset reported for this pool yielded a change in this range; each of them names why',
    });
  });

  it('does not blame a pool whose datasets the cap left out entirely', async () => {
    // The cap is over the whole system, so one pool's large datasets can crowd
    // another's out. Nothing of `spare` was looked at, and saying its datasets
    // yielded no change would read as a finding about it.
    const report = await reported(
      spaceSystem({
        datasets: [
          ...Array.from({ length: 10 }, (_, index) =>
            dataset(`tank/d${index}`, 'tank', (index + 2) * 1e9),
          ),
          dataset('spare/small', 'spare', 1e9),
        ],
        pools: [
          { name: 'tank', size: 10e9, allocated: 6e9, free: 4e9 },
          { name: 'spare', size: 2e9, allocated: 1e9, free: 1e9 },
        ],
      }),
    );
    expect(report.datasets.map((row) => row.pool)).not.toContain('spare');
    expect(report.pools.filter((row) => row.pool === 'spare')[0]).toMatchObject({
      used_percent: 50,
      datasets_observed: 0,
      datasets_total: 1,
      unavailable:
        'no dataset of this pool is among the ones reported, so nothing was measured for it',
    });
  });

  it('names a pool the system did not list, in place of its levels', async () => {
    const report = await reported(spaceSystem({ pools: [] }));
    expect(report.pools[0]).toMatchObject({
      pool: 'tank',
      used_bytes: null,
      free_bytes: null,
      total_bytes: null,
      used_percent: null,
      levels_unavailable: 'the system did not list this pool',
    });
  });

  it('reports levels it cannot read as null rather than as an empty pool', async () => {
    const report = await reported(
      spaceSystem({ pools: [{ name: 'tank' }, { name: '' }, { size: 1 }] }),
    );
    expect(report.pools).toHaveLength(1);
    expect(report.pools[0]).toMatchObject({
      used_bytes: null,
      total_bytes: null,
      used_percent: null,
      levels_unavailable: null,
    });
  });

  it('states no percentage of a pool whose size the system reported as zero', async () => {
    const report = await reported(
      spaceSystem({ pools: [{ name: 'tank', size: 0, allocated: 0, free: 0 }] }),
    );
    expect(report.pools[0]).toMatchObject({ total_bytes: 0, used_percent: null });
  });

  it('still reports the trends when the pool listing could not be read', async () => {
    const fake = spaceSystem({
      snapshots: { 'tank/media': [snap(day(30), 1e9), snap(day(10), 3e9)] },
      failures: { 'pool.query': new Error('pools unavailable') },
    });
    const report = await reported(fake);
    expect(report.pools[0]).toMatchObject({
      used_bytes: null,
      levels_unavailable: 'pools unavailable',
      referenced_change_bytes: 2e9,
      datasets_total: 2,
      unavailable: null,
    });
    expect(entry(report, 'tank/media').change_bytes).toBe(2e9);
  });

  it('still reports the pools when the dataset listing could not be read', async () => {
    const fake = spaceSystem({ failures: { 'pool.dataset.query': new Error('datasets unavailable') } });
    const report = await reported(fake);
    expect(report.datasets).toEqual([]);
    expect(report.pools[0]).toMatchObject({
      pool: 'tank',
      used_percent: 60,
      // Not zero: "this pool has no datasets" is a claim, and nothing looked.
      datasets_total: null,
      unavailable: 'datasets unavailable',
    });
  });

  it('fails with the system\'s own reason when neither listing could be read', async () => {
    const fake = spaceSystem({
      failures: {
        'pool.dataset.query': new Error('datasets unavailable'),
        'pool.query': new Error('pools unavailable'),
      },
    });
    // An empty result would read as a system holding no storage at all.
    await expect(reportingSpaceTrends.handler(fake.ctx, RANGE)).rejects.toThrow(
      'datasets unavailable',
    );
  });

  it('fails rather than hiding a failed listing behind a listing that named nothing', async () => {
    // The pool read succeeded and named no pool, so there is no entry to carry
    // the dataset read's failure — which is the same silence as both failing.
    const fake = spaceSystem({
      pools: [],
      failures: { 'pool.dataset.query': new Error('datasets unavailable') },
    });
    await expect(reportingSpaceTrends.handler(fake.ctx, RANGE)).rejects.toThrow(
      'datasets unavailable',
    );
  });

  it('fails when the pool listing failed and the system listed no dataset either', async () => {
    const fake = spaceSystem({
      datasets: [],
      failures: { 'pool.query': new Error('pools unavailable') },
    });
    await expect(reportingSpaceTrends.handler(fake.ctx, RANGE)).rejects.toThrow(
      'pools unavailable',
    );
  });

  it('answers a system that holds nothing, which is not a failure', async () => {
    const report = await reported(spaceSystem({ datasets: [], pools: [] }));
    expect(report).toMatchObject({ pools: [], datasets: [], truncated_datasets: false });
  });

  it('reports on what the system named a dataset, and attributes one whose pool it did not', async () => {
    const report = await reported(
      spaceSystem({
        datasets: [
          dataset('tank/media', 'tank', 5e9),
          { id: 'other/vm', used: { parsed: 2e9 } },
          { pool: 'tank', used: { parsed: 9e9 } },
          null,
          'tank/nope',
        ],
      }),
    );
    expect(report.datasets.map((row) => row.dataset)).toEqual(['tank/media', 'other/vm']);
    expect(entry(report, 'other/vm').pool).toBe('other');
    expect(report.pools.map((row) => row.pool)).toEqual(['other', 'tank']);
  });

  it('asks the system for each dataset\'s snapshots by name, bounded, with two properties', async () => {
    const fake = healthy();
    await reported(fake);
    expect(fake.query).toHaveBeenCalledWith(
      'pool.snapshot.query',
      [['dataset', '=', 'tank/media']],
      { limit: 1001, extra: { properties: ['creation', 'referenced'] } },
    );
    expect(fake.query).toHaveBeenCalledWith('pool.dataset.query', [], {
      extra: { retrieve_children: true, properties: ['used'] },
    });
  });

  it('refuses a bound it cannot read rather than silently using the default', async () => {
    await expect(
      reportingSpaceTrends.handler(healthy().ctx, { start: 'last month' }),
    ).rejects.toThrow(/must be an ISO 8601 timestamp/);
  });

  it('refuses a range that does not run forwards', async () => {
    await expect(
      reportingSpaceTrends.handler(healthy().ctx, { start: '2023-11-14', end: '2023-10-14' }),
    ).rejects.toThrow('"start" must be before "end"');
  });
});
