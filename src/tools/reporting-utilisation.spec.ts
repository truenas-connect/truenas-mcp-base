import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { of, throwError } from 'rxjs';
import { SystemHandle, ToolContext } from '@/catalog/tool';
import { reportingUtilisation } from '@/tools/index';

describe('reporting_utilisation', () => {
  /**
   * A fixed present, so the default range is a fixed interval rather than one
   * that moves with the clock. Only `Date` is faked, as in `audit_log_query`:
   * the tool reads the clock and nothing here schedules anything.
   */
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
    { name: 'graph', identifier: null, data, aggregations: {}, start: 0, end: 0, legend },
  ];

  /** Three CPU samples: 10%, 20% and 30% busy, the last exactly at the range end. */
  const cpuGraph = graph(
    ['time', 'user', 'system', 'idle'],
    [
      [at(60_000), 5, 5, 90],
      [at(360_000), 10, 10, 80],
      [at(3_600_000), 20, 10, 70],
    ],
  );

  /** Two memory samples, 50% and 60% of a thousand accounted-for units. */
  const memoryGraph = graph(
    ['time', 'free', 'used', 'cached', 'buffers'],
    [
      [at(60_000), 250, 500, 200, 50],
      [at(3_600_000), 200, 600, 150, 50],
    ],
  );

  /** Two interface samples, with the sent direction mirrored below the axis. */
  const netGraph = graph(
    ['time', 'received', 'sent'],
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
   * A SystemHandle answering per GRAPH rather than per method, which neither
   * `fakeSystem` nor `failingSystem` can do: every graph this tool reads comes
   * back from the same `reporting.netdata_get_data` call, distinguished only by
   * the name and identifier asked for. Graphs are keyed `cpu`, `memory` and
   * `interface:<name>`, and a key present in `failures` rejects instead.
   */
  const reportingSystem = (
    graphs: Record<string, unknown>,
    options: { interfaces?: unknown; failures?: Record<string, unknown> } = {},
  ): Fake => {
    const failures = options.failures ?? {};
    const call = vi.fn((method: string, params?: unknown) => {
      const asked = (params as [{ name: string; identifier?: string }[]])[0][0];
      const key = asked.identifier === undefined ? asked.name : `${asked.name}:${asked.identifier}`;
      return key in failures ? throwError(() => failures[key]) : of(graphs[key]);
    });
    const query = vi.fn(() =>
      'interface.query' in failures
        ? throwError(() => failures['interface.query'])
        : of(options.interfaces ?? [{ name: 'eno1' }]),
    );
    const system = { name: 'nas', client: { api: { call, query } } } as unknown as SystemHandle;
    return { ctx: { system }, call, query };
  };

  /** A system with all three graphs and one interface. */
  const healthy = (): Fake =>
    reportingSystem({ cpu: cpuGraph, memory: memoryGraph, ['interface:eno1']: netGraph });

  interface Metric {
    metric: string;
    interface: string | null;
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
    truncated_interfaces: boolean;
  }

  const reported = async (fake: Fake, args: Record<string, unknown> = {}): Promise<Report> =>
    (await reportingUtilisation.handler(fake.ctx, args)) as Report;

  /** One metric of a result, by name and by the interface it was measured on. */
  const metric = (report: Report, name: string, iface: string | null = null): Metric =>
    report.metrics.filter((entry) => entry.metric === name && entry.interface === iface)[0];

  /** The whole default-range result of a system carrying just this one CPU graph. */
  const cpuOnly = async (legend: unknown[], data: unknown[]): Promise<Metric> =>
    metric(await reported(reportingSystem({ cpu: graph(legend, data) })), 'cpu_percent');

  it('summarises CPU over the range and buckets it twelve ways', async () => {
    expect(metric(await reported(healthy()), 'cpu_percent')).toEqual({
      metric: 'cpu_percent',
      interface: null,
      unit: 'percent',
      min: 10,
      max: 30,
      mean: 20,
      latest: 30,
      // The third sample sits exactly at the end of the range and lands in the
      // last bucket rather than one past it.
      buckets: [10, 20, null, null, null, null, null, null, null, null, null, 30],
      unavailable: null,
    });
  });

  it('reports memory in use as a percentage of the memory the graph accounts for', async () => {
    expect(metric(await reported(healthy()), 'memory_used_percent')).toMatchObject({
      unit: 'percent',
      min: 50,
      max: 60,
      mean: 55,
      latest: 60,
      unavailable: null,
    });
  });

  it('reports each direction of interface traffic as a magnitude', async () => {
    const report = await reported(healthy());
    expect(metric(report, 'network_received', 'eno1')).toMatchObject({
      unit: 'kilobits_per_second',
      min: 100,
      max: 300,
      mean: 200,
      latest: 300,
    });
    // Sent arrives negative, mirrored below the axis; a busy link must not
    // report as one carrying less than nothing.
    expect(metric(report, 'network_sent', 'eno1')).toMatchObject({
      min: 40,
      max: 80,
      mean: 60,
      latest: 80,
    });
  });

  it('states the range it reported on and how wide a bucket is', async () => {
    expect(await reported(healthy())).toMatchObject({
      start: '2023-11-14T21:13:20.000Z',
      end: '2023-11-14T22:13:20.000Z',
      bucket_seconds: 300,
      truncated_interfaces: false,
    });
  });

  it('returns only the fields it names', async () => {
    const report = await reported(healthy());
    expect(Object.keys(report)).toEqual([
      'start',
      'end',
      'bucket_seconds',
      'metrics',
      'truncated_interfaces',
    ]);
    expect(Object.keys(metric(report, 'cpu_percent'))).toEqual([
      'metric',
      'interface',
      'unit',
      'min',
      'max',
      'mean',
      'latest',
      'buckets',
      'unavailable',
    ]);
  });

  it('asks the system for the range in unix seconds, per graph', async () => {
    const fake = healthy();
    await reported(fake);
    const bounds = { start: RANGE_START / 1000, end: NOW / 1000 };
    expect(fake.call).toHaveBeenCalledWith('reporting.netdata_get_data', [[{ name: 'cpu' }], bounds]);
    expect(fake.call).toHaveBeenCalledWith('reporting.netdata_get_data', [
      [{ name: 'memory' }],
      bounds,
    ]);
    expect(fake.call).toHaveBeenCalledWith('reporting.netdata_get_data', [
      [{ name: 'interface', identifier: 'eno1' }],
      bounds,
    ]);
  });

  it('returns twelve buckets however long the range is', async () => {
    const report = await reported(healthy(), { start: '2023-10-14', end: '2023-11-15' });
    expect(report.metrics.every((entry) => entry.buckets.length <= 12)).toBe(true);
    expect(metric(report, 'cpu_percent').buckets).toHaveLength(12);
    expect(report.bucket_seconds).toBe(230400);
  });

  it('marks a range the system collected nothing in, rather than returning an empty series', async () => {
    // The samples all sit after this range, so the graph answered and held
    // nothing inside it.
    const report = await reported(healthy(), { start: '2023-10-14', end: '2023-11-14' });
    expect(metric(report, 'cpu_percent')).toMatchObject({
      min: null,
      max: null,
      mean: null,
      latest: null,
      buckets: [],
      unavailable: 'the system collected no data for this metric in this range',
    });
  });

  it('marks a graph carrying no series the metric can be derived from', async () => {
    // Rows were returned, and none of them names the idle time CPU utilisation
    // is the complement of — which is a different fact from collecting nothing.
    expect(await cpuOnly(['time', 'user', 'system'], [[at(60_000), 5, 5]])).toMatchObject({
      buckets: [],
      unavailable: 'the system reported no series this metric can be derived from',
    });
  });

  it('marks a gap in collection as no data, not as a graph carrying no such series', async () => {
    // Netdata stamps a second it collected nothing in with a row of nulls, so
    // these rows are inside the range and the legend does name `idle`. Deciding
    // this from the rows rather than from the legend would answer "this system
    // reports no series CPU utilisation can be derived from" — that it does not
    // record CPU at all — for what is a gap at 3am.
    expect(
      await cpuOnly(
        ['time', 'user', 'system', 'idle'],
        [
          [at(60_000), null, null, null],
          [at(360_000), null, null, null],
        ],
      ),
    ).toMatchObject({
      buckets: [],
      unavailable: 'the system collected no data for this metric in this range',
    });
  });

  it('names a failed graph read on that metric alone', async () => {
    const fake = reportingSystem(
      { memory: memoryGraph, ['interface:eno1']: netGraph },
      { failures: { cpu: new Error('netdata is not running') } },
    );
    const report = await reported(fake);
    expect(metric(report, 'cpu_percent')).toMatchObject({
      min: null,
      buckets: [],
      unavailable: 'netdata is not running',
    });
    expect(metric(report, 'memory_used_percent').unavailable).toBeNull();
    expect(metric(report, 'network_received', 'eno1').unavailable).toBeNull();
  });

  it('names the failure however the system reported it', async () => {
    const reasons: [unknown, string][] = [
      [new Error('netdata is not running'), 'netdata is not running'],
      [new Error(''), 'the system reported no reason'],
      [{ reason: 'no such graph' }, 'no such graph'],
      [{ message: 'transport closed' }, 'transport closed'],
      ['reporting is disabled', 'reporting is disabled'],
      [{}, 'the system reported no reason'],
      [null, 'the system reported no reason'],
    ];
    for (const [thrown, expected] of reasons) {
      const fake = reportingSystem({}, { failures: { cpu: thrown } });
      expect(metric(await reported(fake), 'cpu_percent').unavailable).toBe(expected);
    }
  });

  it('still reports both network metrics when the interface listing could not be read', async () => {
    const fake = reportingSystem(
      { cpu: cpuGraph, memory: memoryGraph },
      { failures: { ['interface.query']: new Error('interfaces unavailable') } },
    );
    const report = await reported(fake);
    // Absent metrics would read as a system with no network at all.
    expect(metric(report, 'network_received')).toMatchObject({
      interface: null,
      buckets: [],
      unavailable: 'interfaces unavailable',
    });
    expect(metric(report, 'network_sent').unavailable).toBe('interfaces unavailable');
    expect(metric(report, 'cpu_percent').unavailable).toBeNull();
    expect(report.truncated_interfaces).toBe(false);
  });

  it('still reports both network metrics when the system named no interface', async () => {
    const fake = reportingSystem({ cpu: cpuGraph, memory: memoryGraph }, { interfaces: [] });
    const report = await reported(fake);
    // Dropping them would be indistinguishable from a system with no network.
    expect(metric(report, 'network_received')).toMatchObject({
      interface: null,
      buckets: [],
      unavailable: 'the system named no interface to graph',
    });
    expect(metric(report, 'network_sent').unavailable).toBe('the system named no interface to graph');
  });

  it('covers six interfaces in name order and says when it left some out', async () => {
    const fake = reportingSystem(
      { cpu: cpuGraph, memory: memoryGraph },
      { interfaces: ['eth7', 'eth3', 'eth1', 'eth5', 'eth2', 'eth6', 'eth4'].map((name) => ({ name })) },
    );
    const report = await reported(fake);
    expect(report.truncated_interfaces).toBe(true);
    expect(
      report.metrics.filter((entry) => entry.metric === 'network_received').map((e) => e.interface),
    ).toEqual(['eth1', 'eth2', 'eth3', 'eth4', 'eth5', 'eth6']);
  });

  it('graphs only the interfaces the system actually named', async () => {
    const fake = reportingSystem(
      { cpu: cpuGraph, memory: memoryGraph, ['interface:eno1']: netGraph },
      { interfaces: [{ name: 'eno1' }, { name: '' }, { name: 42 }, {}] },
    );
    const report = await reported(fake);
    expect(
      report.metrics.filter((entry) => entry.metric === 'network_sent').map((e) => e.interface),
    ).toEqual(['eno1']);
  });

  it('marks one direction unavailable while the other reports', async () => {
    const fake = reportingSystem({
      ['interface:eno1']: graph(['time', 'received'], [[at(60_000), 100]]),
    });
    const report = await reported(fake);
    expect(metric(report, 'network_received', 'eno1').mean).toBe(100);
    expect(metric(report, 'network_sent', 'eno1').unavailable).toBe(
      'the system reported no series this metric can be derived from',
    );
  });

  it('reads a legend that does not name the timestamp column', async () => {
    expect(await cpuOnly(['user', 'system', 'idle'], [[at(60_000), 5, 5, 90]])).toMatchObject({
      mean: 10,
    });
  });

  it('keeps the first column of a duplicated legend name', async () => {
    // Taking the later column would read this graph as 90% busy.
    expect(await cpuOnly(['time', 'idle', 'idle'], [[at(60_000), 90, 10]])).toMatchObject({
      mean: 10,
    });
  });

  it('keeps every column in place through a legend entry that is not a name', async () => {
    expect(await cpuOnly(['time', 42, 'idle'], [[at(60_000), 5, 90]])).toMatchObject({ mean: 10 });
  });

  it('reads a row timestamp sent as milliseconds', async () => {
    expect(
      await cpuOnly(['time', 'idle'], [[RANGE_START + 60_000, 90]]),
    ).toMatchObject({ mean: 10, buckets: [10, ...new Array<null>(11).fill(null)] });
  });

  it('drops a row it cannot read a time or a value from', async () => {
    expect(
      await cpuOnly(
        ['time', 'idle'],
        ['not a row', [null, 90], [at(60_000), 'unreadable'], [at(360_000), 90]],
      ),
    ).toMatchObject({ min: 10, max: 10, mean: 10, latest: 10 });
  });

  it('takes the latest value from the newest sample, not the last one sent', async () => {
    expect(
      await cpuOnly(
        ['time', 'idle'],
        [
          [at(3_600_000), 70],
          [at(60_000), 90],
        ],
      ),
    ).toMatchObject({ latest: 30 });
  });

  it('clamps CPU utilisation into nought to a hundred', async () => {
    expect(
      await cpuOnly(
        ['time', 'idle'],
        [
          [at(60_000), 110],
          [at(360_000), -20],
        ],
      ),
    ).toMatchObject({ min: 0, max: 100 });
  });

  it('reports no memory percentage where nothing accounts for the total', async () => {
    const noSeries = 'the system reported no series this metric can be derived from';
    const noData = 'the system collected no data for this metric in this range';
    const cases: [unknown[], unknown[], string][] = [
      // No `used` to report: the graph carries no series this is derived from.
      [['time', 'free', 'cached'], [[at(60_000), 100, 20]], noSeries],
      // `used` alone is its own total, and dividing it by itself would report
      // every system as fully out of memory.
      [['time', 'used'], [[at(60_000), 500]], noSeries],
      // The graph carries both series and this sample has nothing to take a
      // share of — a property of the sample rather than of the graph, so it
      // reads as a range that yielded no measurement.
      [['time', 'free', 'used'], [[at(60_000), 0, 0]], noData],
    ];
    for (const [legend, data, expected] of cases) {
      const fake = reportingSystem({ memory: graph(legend, data) });
      expect(metric(await reported(fake), 'memory_used_percent').unavailable).toBe(expected);
    }
  });

  it('clamps a memory percentage the parts do not support', async () => {
    const fake = reportingSystem({ memory: graph(['time', 'free', 'used'], [[at(60_000), 100, -50]]) });
    expect(metric(await reported(fake), 'memory_used_percent').mean).toBe(0);
  });

  it('reports nothing, with a stated reason, for a graph in a shape it cannot use', async () => {
    const shapes: unknown[] = [
      'not a list',
      [],
      [null],
      [{ legend: 'not a list', data: 'not a list' }],
      graph([], [[at(60_000), 90]]),
    ];
    for (const answer of shapes) {
      const fake = reportingSystem({ cpu: answer });
      const reading = metric(await reported(fake), 'cpu_percent');
      expect(reading.min).toBeNull();
      // Which marker it is depends on whether any row survived — the last shape
      // holds one, under a legend naming nothing. What every shape must do is
      // say why there is nothing, rather than report a measurement.
      expect(reading.unavailable).not.toBeNull();
    }
  });

  it('reads every timestamp form the catalog accepts, as UTC', async () => {
    const starts = [
      '2023-11-14T21:13:20Z',
      '2023-11-14 21:13:20',
      '2023-11-14T23:13:20+02:00',
      '2023-11-14T19:13:20-02:00',
    ];
    for (const start of starts) {
      expect((await reported(healthy(), { start })).start).toBe('2023-11-14T21:13:20.000Z');
    }
    expect((await reported(healthy(), { start: '2023-11-14T21:13:20.123456Z' })).start).toBe(
      '2023-11-14T21:13:20.123Z',
    );
    expect((await reported(healthy(), { start: '2023-11-14' })).start).toBe(
      '2023-11-14T00:00:00.000Z',
    );
  });

  it('defaults each end of the range from the other', async () => {
    // An end alone covers the hour before it, rather than an hour that may lie
    // outside the range asked about at all.
    expect(await reported(healthy(), { end: '2023-11-14T12:00:00Z' })).toMatchObject({
      start: '2023-11-14T11:00:00.000Z',
      end: '2023-11-14T12:00:00.000Z',
    });
    // A start alone runs to now.
    expect(await reported(healthy(), { start: '2023-11-14T12:00:00Z', end: null })).toMatchObject({
      start: '2023-11-14T12:00:00.000Z',
      end: '2023-11-14T22:13:20.000Z',
    });
  });

  it('refuses a bound it cannot read rather than silently using the default', async () => {
    const unreadable = [
      { start: 'last tuesday' },
      { end: 1_700_000_000 },
      { start: '2023-02-30' },
      { start: '2023-13-01' },
      { start: '0000-01-01' },
      { start: '2023-11-14T25:00:00Z' },
      { start: '2023-11-14T09:99:00Z' },
      { start: '2023-11-14T09:00:00+25:00' },
      { start: '2023-11-14T09:00:00+02:99' },
    ];
    for (const args of unreadable) {
      await expect(reportingUtilisation.handler(healthy().ctx, args)).rejects.toThrow(
        /must be an ISO 8601 timestamp/,
      );
    }
  });

  it('refuses a range that does not run forwards', async () => {
    await expect(
      reportingUtilisation.handler(healthy().ctx, {
        start: '2023-11-14T12:00:00Z',
        end: '2023-11-14T11:00:00Z',
      }),
    ).rejects.toThrow('"start" must be before "end"');
  });
});
