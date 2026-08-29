import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { of, throwError } from 'rxjs';
import { SystemHandle, ToolContext } from '@/catalog/tool';
import { reportingDiskIo } from '@/tools/index';

describe('reporting_disk_io', () => {
  /** The same fixed present as `reporting_utilisation`, for the same reason. */
  const NOW = 1_700_000_000_000; // 2023-11-14T22:13:20.000Z
  /** NOW minus the tool's one-hour default range. */
  const RANGE_START = NOW - 60 * 60 * 1000; // 2023-11-14T21:13:20.000Z

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** A sample time inside the default range, in the unix seconds a row carries. */
  const at = (offset: number): number => (RANGE_START + offset) / 1000;

  /** A graph as `reporting.netdata_get_data` answers with one. */
  const graph = (legend: unknown[], data: unknown[]): unknown => [
    { name: 'disk', identifier: 'sda', data, aggregations: {}, start: 0, end: 0, legend },
  ];

  /**
   * Two samples of a disk moving data, with the write direction mirrored below
   * the axis as netdata draws it.
   */
  const diskGraph = graph(
    ['time', 'reads', 'writes'],
    [
      [at(60_000), 100, -40],
      [at(3_600_000), 300, -80],
    ],
  );

  interface Fake {
    ctx: ToolContext;
    call: ReturnType<typeof vi.fn>;
    query: ReturnType<typeof vi.fn>;
  }

  /**
   * A SystemHandle answering per DISK: every graph comes back from the same
   * `reporting.netdata_get_data` call, distinguished only by the identifier
   * asked for, so graphs are keyed by disk name and a key present in `failures`
   * rejects instead.
   */
  const diskSystem = (
    graphs: Record<string, unknown>,
    options: { disks?: unknown; failures?: Record<string, unknown> } = {},
  ): Fake => {
    const failures = options.failures ?? {};
    const call = vi.fn((method: string, params?: unknown) => {
      const asked = (params as [{ name: string; identifier?: string }[]])[0][0];
      const key = asked.identifier ?? asked.name;
      return key in failures ? throwError(() => failures[key]) : of(graphs[key]);
    });
    const query = vi.fn(() =>
      'disk.query' in failures
        ? throwError(() => failures['disk.query'])
        : of(options.disks ?? [{ name: 'sda' }]),
    );
    const system = { name: 'nas', client: { api: { call, query } } } as unknown as SystemHandle;
    return { ctx: { system }, call, query };
  };

  /** A system with one disk that has a graph. */
  const healthy = (): Fake => diskSystem({ sda: diskGraph });

  interface Metric {
    metric: string;
    disk: string | null;
    unit: string;
    min: number | null;
    max: number | null;
    mean: number | null;
    latest: number | null;
    buckets: (number | null)[];
    unavailable: string | null;
  }

  interface Report {
    start: string;
    end: string;
    bucket_seconds: number;
    metrics: Metric[];
    truncated_disks: boolean;
  }

  const reported = async (fake: Fake, args: Record<string, unknown> = {}): Promise<Report> =>
    (await reportingDiskIo.handler(fake.ctx, args)) as Report;

  /** One metric of a result, by name and by the disk it was measured on. */
  const metric = (report: Report, name: string, disk: string | null = 'sda'): Metric =>
    report.metrics.filter((entry) => entry.metric === name && entry.disk === disk)[0];

  it('summarises each direction of throughput over the range and buckets it twelve ways', async () => {
    expect(metric(await reported(healthy()), 'read_throughput')).toEqual({
      metric: 'read_throughput',
      disk: 'sda',
      unit: 'kibibytes_per_second',
      min: 100,
      max: 300,
      mean: 200,
      latest: 300,
      // The second sample sits exactly at the end of the range and lands in the
      // last bucket rather than one past it.
      buckets: [100, null, null, null, null, null, null, null, null, null, null, 300],
      unavailable: null,
    });
  });

  it('reports the write direction as a magnitude', async () => {
    // Writes arrive negative, mirrored below the axis; a disk under write load
    // must not report as one doing less than nothing.
    expect(metric(await reported(healthy()), 'write_throughput')).toMatchObject({
      unit: 'kibibytes_per_second',
      min: 40,
      max: 80,
      mean: 60,
      latest: 80,
      unavailable: null,
    });
  });

  it('reports IOPS and latency as unavailable where the graph carries no such series', async () => {
    const report = await reported(healthy());
    const noSeries = 'the system reported no series this metric can be derived from';
    for (const name of ['read_iops', 'write_iops', 'read_latency', 'write_latency']) {
      // Present with a stated reason rather than omitted: that the system
      // records throughput only is a fact about the system, and dropping the
      // metrics would read as a disk that did no operations at all.
      expect(metric(report, name)).toMatchObject({ min: null, buckets: [], unavailable: noSeries });
    }
    expect(metric(report, 'read_iops').unit).toBe('operations_per_second');
    expect(metric(report, 'read_latency').unit).toBe('milliseconds');
  });

  it('summarises IOPS and latency from a graph that does carry them', async () => {
    const fake = diskSystem({
      sda: graph(
        ['time', 'read_ops', 'write_ops', 'read_await', 'write_await'],
        [
          [at(60_000), 20, -10, 1, 3],
          [at(3_600_000), 40, -30, 2, 5],
        ],
      ),
    });
    const report = await reported(fake);
    expect(metric(report, 'read_iops')).toMatchObject({ min: 20, max: 40, mean: 30, latest: 40 });
    expect(metric(report, 'write_iops')).toMatchObject({ min: 10, max: 30, mean: 20, latest: 30 });
    expect(metric(report, 'read_latency')).toMatchObject({ mean: 1.5, latest: 2 });
    expect(metric(report, 'write_latency')).toMatchObject({ mean: 4, latest: 5 });
  });

  it('states the range it reported on and how wide a bucket is', async () => {
    expect(await reported(healthy())).toMatchObject({
      start: '2023-11-14T21:13:20.000Z',
      end: '2023-11-14T22:13:20.000Z',
      bucket_seconds: 300,
      truncated_disks: false,
    });
  });

  it('returns only the fields it names', async () => {
    const report = await reported(healthy());
    expect(Object.keys(report)).toEqual([
      'start',
      'end',
      'bucket_seconds',
      'metrics',
      'truncated_disks',
    ]);
    expect(Object.keys(metric(report, 'read_throughput'))).toEqual([
      'metric',
      'disk',
      'unit',
      'min',
      'max',
      'mean',
      'latest',
      'buckets',
      'unavailable',
    ]);
  });

  it('asks the system for the disk graph by device name, in unix seconds', async () => {
    const fake = healthy();
    await reported(fake);
    expect(fake.call).toHaveBeenCalledWith('reporting.netdata_get_data', [
      [{ name: 'disk', identifier: 'sda' }],
      { start: RANGE_START / 1000, end: NOW / 1000 },
    ]);
    // One call per disk, not one per metric: all six come from the same graph.
    expect(fake.call).toHaveBeenCalledTimes(1);
  });

  it('reports six metrics for every disk it covers', async () => {
    const fake = diskSystem(
      { sda: diskGraph, sdb: diskGraph },
      { disks: [{ name: 'sdb' }, { name: 'sda' }] },
    );
    const report = await reported(fake);
    expect(report.metrics).toHaveLength(12);
    expect(report.metrics.map((entry) => entry.disk)).toEqual([
      ...new Array<string>(6).fill('sda'),
      ...new Array<string>(6).fill('sdb'),
    ]);
    expect(metric(report, 'read_throughput', 'sdb').mean).toBe(200);
  });

  it('marks a range the system collected nothing in, rather than returning an empty series', async () => {
    // The samples all sit after this range, so the graph answered and held
    // nothing inside it.
    const report = await reported(healthy(), { start: '2023-10-14', end: '2023-11-14' });
    expect(metric(report, 'read_throughput')).toMatchObject({
      min: null,
      latest: null,
      buckets: [],
      unavailable: 'the system collected no data for this metric in this range',
    });
  });

  it('names a failed graph read on that disk alone', async () => {
    const fake = diskSystem(
      { sdb: diskGraph },
      {
        disks: [{ name: 'sda' }, { name: 'sdb' }],
        failures: { sda: new Error('netdata is not running') },
      },
    );
    const report = await reported(fake);
    expect(metric(report, 'read_throughput')).toMatchObject({
      buckets: [],
      unavailable: 'netdata is not running',
    });
    expect(metric(report, 'read_throughput', 'sdb').unavailable).toBeNull();
  });

  it('still reports every metric when the disk listing could not be read', async () => {
    const fake = diskSystem({}, { failures: { ['disk.query']: new Error('disks unavailable') } });
    const report = await reported(fake);
    // Absent metrics would read as a system with no disks at all.
    expect(report.metrics).toHaveLength(6);
    expect(metric(report, 'read_throughput', null)).toMatchObject({
      disk: null,
      buckets: [],
      unavailable: 'disks unavailable',
    });
    expect(metric(report, 'write_latency', null).unavailable).toBe('disks unavailable');
    expect(report.truncated_disks).toBe(false);
  });

  it('still reports every metric when the system named no disk', async () => {
    const report = await reported(diskSystem({}, { disks: [] }));
    expect(metric(report, 'read_throughput', null)).toMatchObject({
      disk: null,
      unavailable: 'the system named no disk to graph',
    });
  });

  it('covers six disks in name order and says when it left some out', async () => {
    const fake = diskSystem(
      {},
      { disks: ['sdg', 'sdc', 'sda', 'sde', 'sdb', 'sdf', 'sdd'].map((name) => ({ name })) },
    );
    const report = await reported(fake);
    expect(report.truncated_disks).toBe(true);
    expect(
      report.metrics.filter((entry) => entry.metric === 'read_throughput').map((e) => e.disk),
    ).toEqual(['sda', 'sdb', 'sdc', 'sdd', 'sde', 'sdf']);
  });

  it('graphs only the disks the system actually named', async () => {
    const fake = diskSystem(
      { sda: diskGraph },
      { disks: [{ name: 'sda' }, { name: '' }, { name: 42 }, {}, null, 'sdz'] },
    );
    const report = await reported(fake);
    expect(
      report.metrics.filter((entry) => entry.metric === 'write_throughput').map((e) => e.disk),
    ).toEqual(['sda']);
  });

  it('reads the range the caller named, in the forms the catalog accepts', async () => {
    expect(await reported(healthy(), { start: '2023-11-14 21:13:20' })).toMatchObject({
      start: '2023-11-14T21:13:20.000Z',
      end: '2023-11-14T22:13:20.000Z',
    });
  });

  it('refuses a bound it cannot read rather than silently using the default', async () => {
    await expect(reportingDiskIo.handler(healthy().ctx, { start: 'last tuesday' })).rejects.toThrow(
      /must be an ISO 8601 timestamp/,
    );
  });

  it('refuses a range that does not run forwards', async () => {
    await expect(
      reportingDiskIo.handler(healthy().ctx, {
        start: '2023-11-14T12:00:00Z',
        end: '2023-11-14T11:00:00Z',
      }),
    ).rejects.toThrow('"start" must be before "end"');
  });
});
