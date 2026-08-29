import { describe, expect, it } from 'vitest';
import { fakeSystem } from '@/testing/fake-systems';
import { poolTopology, scrubHistory } from '@/tools/index';

/** The shape `storage_pool_topology` returns, for the assertions below. */
interface MappedDevice {
  name: string | null;
  type: string | null;
  status: string | null;
  disk: string | null;
  devices: MappedDevice[];
}
interface MappedVdev extends MappedDevice {
  category: string;
}
interface MappedPool {
  name: string;
  status: string;
  vdevs: MappedVdev[];
}

describe('storage_pool_topology', () => {
  // Every property a topology node carries, so the assertions below show what
  // the tool drops as well as what it keeps. `stats` is the bulky one — the
  // middleware repeats that block on every node of a tree with one leaf per
  // disk in the system — and `path`, `guid`, `device` and `unavail_disk` are
  // here to be dropped alongside it.
  const node = (over: Record<string, unknown>) => ({
    name: 'sda2',
    type: 'DISK',
    path: '/dev/disk/by-partuuid/11111111-2222-3333-4444-555555555555',
    guid: '12345678901234567890',
    status: 'ONLINE',
    stats: {
      timestamp: 1756000000000000000,
      read_errors: 0,
      write_errors: 0,
      checksum_errors: 0,
      ops: [0, 1, 2, 3, 4, 5],
      bytes: [0, 1, 2, 3, 4, 5],
      size: 4000787030016,
      allocated: 1000000000,
      fragmentation: 3,
    },
    children: [],
    device: 'sda2',
    disk: 'sda',
    unavail_disk: null,
    ...over,
  });

  /** A vdev that groups devices: no disk of its own, members underneath. */
  const group = (over: Record<string, unknown>) =>
    node({ type: 'MIRROR', path: null, device: null, disk: null, ...over });

  /** A node from a middleware that did not send one of the keys read here. */
  const without = (key: string, row: Record<string, unknown>): Record<string, unknown> => {
    const copy = { ...row };
    delete copy[key];
    return copy;
  };

  const pool = (topology: unknown, over: Record<string, unknown> = {}) => ({
    id: 1,
    name: 'tank',
    guid: '1',
    status: 'ONLINE',
    healthy: true,
    size: 100,
    allocated: 40,
    free: 60,
    topology,
    ...over,
  });

  /** A full topology, with the five categories a plain pool leaves empty. */
  const topologyOf = (over: Record<string, unknown>) => ({
    data: [],
    special: [],
    dedup: [],
    log: [],
    cache: [],
    spare: [],
    ...over,
  });

  it('maps each vdev to its members, keeping the tree', async () => {
    const { ctx, query } = fakeSystem({
      ['pool.query']: [
        pool(
          topologyOf({
            data: [
              group({
                name: 'mirror-0',
                children: [node({ name: 'sda2', disk: 'sda' }), node({ name: 'sdb2', disk: 'sdb' })],
              }),
            ],
          }),
        ),
      ],
    });
    expect(await poolTopology.handler(ctx, {})).toEqual([
      {
        name: 'tank',
        status: 'ONLINE',
        vdevs: [
          {
            category: 'data',
            name: 'mirror-0',
            type: 'MIRROR',
            status: 'ONLINE',
            disk: null,
            devices: [
              { name: 'sda2', type: 'DISK', status: 'ONLINE', disk: 'sda', devices: [] },
              { name: 'sdb2', type: 'DISK', status: 'ONLINE', disk: 'sdb', devices: [] },
            ],
          },
        ],
      },
    ]);
    // `topology` is part of a pool row as it stands, so the tool asks for the
    // pool list with no filters and no options.
    expect(query.mock.calls).toEqual([['pool.query']]);
  });

  it('labels cache, log and spare vdevs rather than folding them in with data', async () => {
    const { ctx } = fakeSystem({
      ['pool.query']: [
        pool(
          topologyOf({
            data: [group({ name: 'raidz1-0', type: 'RAIDZ1' })],
            special: [group({ name: 'mirror-1' })],
            dedup: [group({ name: 'mirror-2' })],
            log: [node({ name: 'nvme0n1p1', disk: 'nvme0n1' })],
            cache: [node({ name: 'nvme1n1p1', disk: 'nvme1n1' })],
            // A spare that has not been called on reports AVAIL, not ONLINE.
            spare: [node({ name: 'sdz2', disk: 'sdz', status: 'AVAIL' })],
          }),
        ),
      ],
    });
    const [result] = (await poolTopology.handler(ctx, {})) as MappedPool[];
    expect(result.vdevs.map((v) => [v.category, v.name, v.status])).toEqual([
      ['data', 'raidz1-0', 'ONLINE'],
      ['special', 'mirror-1', 'ONLINE'],
      ['dedup', 'mirror-2', 'ONLINE'],
      ['log', 'nvme0n1p1', 'ONLINE'],
      ['cache', 'nvme1n1p1', 'ONLINE'],
      ['spare', 'sdz2', 'AVAIL'],
    ]);
  });

  it('names the failed device by status, on the device and on the vdev above it', async () => {
    // The question the tool exists for: the pool says DEGRADED, and the answer
    // to "which device" has to be reachable by filtering a field rather than by
    // reading prose.
    const { ctx } = fakeSystem({
      ['pool.query']: [
        pool(
          topologyOf({
            data: [
              group({
                name: 'mirror-0',
                status: 'DEGRADED',
                children: [
                  node({ name: 'sda2', disk: 'sda' }),
                  node({ name: 'sdf2', disk: 'sdf', status: 'FAULTED' }),
                ],
              }),
            ],
          }),
          { status: 'DEGRADED', healthy: false },
        ),
      ],
    });
    const [result] = (await poolTopology.handler(ctx, {})) as MappedPool[];
    expect(result.status).toBe('DEGRADED');
    const failed = result.vdevs.flatMap((v) => v.devices).filter((d) => d.status !== 'ONLINE');
    expect(failed).toEqual([
      { name: 'sdf2', type: 'DISK', status: 'FAULTED', disk: 'sdf', devices: [] },
    ]);
  });

  it('gives a null disk for a device the middleware cannot resolve, key or no key', async () => {
    // A pulled disk is reported as a leaf with `disk: null` and the identifier
    // moved to `unavail_disk`, which this tool drops; an older middleware sends
    // no `disk` key at all. Both are the state the description calls a null,
    // and an absent key would serialize to no key rather than to one — so the
    // second device is the one that fails if the mapping stops normalizing.
    const { ctx } = fakeSystem({
      ['pool.query']: [
        pool(
          topologyOf({
            data: [
              group({
                name: 'mirror-0',
                status: 'DEGRADED',
                children: [
                  node({
                    name: 'sdf2',
                    status: 'REMOVED',
                    disk: null,
                    unavail_disk: { guid: '9999', dev: 'sdf2' },
                  }),
                  without('disk', node({ name: 'sdg2', status: 'UNAVAIL' })),
                ],
              }),
            ],
          }),
          { status: 'DEGRADED', healthy: false },
        ),
      ],
    });
    const [result] = (await poolTopology.handler(ctx, {})) as MappedPool[];
    const [mirror] = result.vdevs;
    expect(mirror.devices).toEqual([
      { name: 'sdf2', type: 'DISK', status: 'REMOVED', disk: null, devices: [] },
      { name: 'sdg2', type: 'DISK', status: 'UNAVAIL', disk: null, devices: [] },
    ]);
    // Expecting null above is what enforces the normalization: `toEqual` reads
    // an absent key and an undefined one alike, so a `disk` that stopped being
    // normalized would arrive as undefined and fail against that null. These
    // two say the same thing more plainly — `Object.keys` lists a key holding
    // undefined as well, so the first is the weaker of them.
    expect(Object.keys(mirror.devices[1])).toContain('disk');
    expect(mirror.devices[1].disk).toBeNull();
  });

  it('nests a replacement beneath the mirror rather than beside its members', async () => {
    // Mid-resilver the middleware reports a `replacing` vdev holding both the
    // outgoing and the incoming disk. Flattened, the mirror would read as
    // having three members and no indication which two are the same slot.
    const { ctx } = fakeSystem({
      ['pool.query']: [
        pool(
          topologyOf({
            data: [
              group({
                name: 'mirror-0',
                status: 'DEGRADED',
                children: [
                  node({ name: 'sda2', disk: 'sda' }),
                  group({
                    name: 'replacing-1',
                    type: 'REPLACING',
                    status: 'DEGRADED',
                    children: [
                      node({ name: 'sdf2', disk: 'sdf', status: 'FAULTED' }),
                      node({ name: 'sdg2', disk: 'sdg' }),
                    ],
                  }),
                ],
              }),
            ],
          }),
        ),
      ],
    });
    const [result] = (await poolTopology.handler(ctx, {})) as MappedPool[];
    const [mirror] = result.vdevs;
    expect(mirror.devices.map((d) => [d.name, d.type, d.devices.map((c) => c.disk)])).toEqual([
      ['sda2', 'DISK', []],
      ['replacing-1', 'REPLACING', ['sdf', 'sdg']],
    ]);
  });

  it('surfaces neither the per-vdev statistics nor a field a later release adds', async () => {
    const { ctx } = fakeSystem({
      ['pool.query']: [
        pool(
          topologyOf({
            data: [
              group({
                name: 'mirror-0',
                children: [node({ future_field: 'added by a later TrueNAS release' })],
              }),
            ],
            // A vdev category a later release adds is dropped whole: the tool
            // walks the six roles it names, not the payload's own keys.
            future_category: [node({ name: 'sdx2', disk: 'sdx' })],
          }),
          { future_field: 'added by a later TrueNAS release' },
        ),
      ],
    });
    const [result] = (await poolTopology.handler(ctx, {})) as Record<string, unknown>[];
    expect(Object.keys(result)).toEqual(['name', 'status', 'vdevs']);
    const vdevs = result['vdevs'] as MappedVdev[];
    // The category a later release adds is dropped whole, rather than carried
    // through as a second vdev alongside the mirror: the tool walks the six
    // roles it names, not the payload's own keys.
    expect(vdevs.map((v) => v.category)).toEqual(['data']);
    const [vdev] = vdevs;
    expect(Object.keys(vdev)).toEqual(['category', 'name', 'type', 'status', 'disk', 'devices']);
    expect(Object.keys(vdev.devices[0])).toEqual(['name', 'type', 'status', 'disk', 'devices']);
  });

  it('reports a pool with no topology, and one whose keys are absent', async () => {
    // `topology` is null on a pool the middleware could not read the layout of;
    // a middleware older than a category omits its key, and one that reports a
    // leaf without `children` or without `status` omits those. None is an
    // error, and none may take the rest of the pools down with it: an omitted
    // field is reported as null, so the caller meets the shape the description
    // promised with a value missing rather than a key missing.
    const { ctx } = fakeSystem({
      ['pool.query']: [
        pool(null, { name: 'unimported' }),
        pool(
          { data: [without('status', without('children', node({ name: 'sda2', disk: 'sda' })))] },
          { name: 'stripe' },
        ),
      ],
    });
    const results = (await poolTopology.handler(ctx, {})) as MappedPool[];
    expect(results).toEqual([
      { name: 'unimported', status: 'ONLINE', vdevs: [] },
      {
        name: 'stripe',
        status: 'ONLINE',
        vdevs: [
          {
            category: 'data',
            name: 'sda2',
            type: 'DISK',
            status: null,
            disk: 'sda',
            devices: [],
          },
        ],
      },
    ]);
    // Expecting null rather than undefined above is what catches a dropped
    // `status`: `toEqual` reads an absent key and an undefined one alike, so
    // an unnormalized field fails against that null. This restates it in the
    // terms the caller sees — the key is present in the response object.
    expect(Object.keys(results[1].vdevs[0])).toContain('status');
  });

  it('returns [] for a system with no pools', async () => {
    const { ctx } = fakeSystem({ ['pool.query']: [] });
    expect(await poolTopology.handler(ctx, {})).toEqual([]);
  });
});

describe('storage_scrub_history', () => {
  // Every field a scan record carries, so the assertions below show what the
  // tool drops as well as what it keeps. `bytes_to_process`, `bytes_processed`,
  // `bytes_issued`, `percentage` and `total_secs_left` are the progress
  // counters, and are here to be dropped: they describe how far a scrub got,
  // where this tool answers what it found and how long ago.
  const scan = (over: Record<string, unknown>) => ({
    function: 'SCRUB',
    state: 'FINISHED',
    start_time: '2026-08-20T01:00:00+00:00',
    end_time: '2026-08-20T04:30:00+00:00',
    percentage: 100,
    bytes_to_process: 4000787030016,
    bytes_processed: 4000787030016,
    bytes_issued: 4000787030016,
    pause: null,
    errors: 0,
    total_secs_left: null,
    ...over,
  });

  const pool = (over: Record<string, unknown>) => ({
    id: 1,
    name: 'tank',
    status: 'ONLINE',
    healthy: true,
    // Present on every pool the system is reading, and null on one it is not.
    topology: { data: [{ name: 'sda2', type: 'DISK' }] },
    scan: scan({}),
    ...over,
  });

  /** A pool or scan row from a middleware that did not send one of the keys. */
  const without = (key: string, row: Record<string, unknown>): Record<string, unknown> => {
    const copy = { ...row };
    delete copy[key];
    return copy;
  };

  it('reports the outcome and age of the last finished scrub', async () => {
    const { ctx, query } = fakeSystem({ ['pool.query']: [pool({})] });
    expect(await scrubHistory.handler(ctx, {})).toEqual([
      {
        pool: 'tank',
        state: 'FINISHED',
        started_at: '2026-08-20T01:00:00+00:00',
        finished_at: '2026-08-20T04:30:00+00:00',
        duration_seconds: 12600,
        errors: 0,
      },
    ]);
    // `scan` is part of a pool row as it stands, so the tool asks for the pool
    // list with no filters and no options.
    expect(query.mock.calls).toEqual([['pool.query']]);
  });

  it('keeps a scrub that found errors apart from a clean one', async () => {
    const { ctx } = fakeSystem({
      ['pool.query']: [
        pool({ name: 'tank' }),
        pool({ name: 'vault', scan: scan({ errors: 3 }) }),
      ],
    });
    const result = (await scrubHistory.handler(ctx, {})) as Record<string, unknown>[];
    expect(result.map((p) => [p['pool'], p['errors']])).toEqual([
      ['tank', 0],
      ['vault', 3],
    ]);
  });

  it('distinguishes a scrub in progress from a finished one', async () => {
    // A running scrub has no end time, so it has no duration either — the
    // alternative is a duration measured against now, which would read as a
    // finished scrub of that length.
    const { ctx } = fakeSystem({
      ['pool.query']: [pool({ scan: scan({ state: 'SCANNING', end_time: null, percentage: 40 }) })],
    });
    expect(await scrubHistory.handler(ctx, {})).toEqual([
      {
        pool: 'tank',
        state: 'SCANNING',
        started_at: '2026-08-20T01:00:00+00:00',
        finished_at: null,
        duration_seconds: null,
        errors: 0,
      },
    ]);
  });

  it('distinguishes a paused scrub from one that is still running', async () => {
    // ZFS reports a paused scrub as SCANNING with the time it was paused, and
    // it stays that way until someone resumes it. Reported as SCANNING it
    // would read as a verification in progress when nothing is progressing.
    const { ctx } = fakeSystem({
      ['pool.query']: [
        pool({ name: 'running', scan: scan({ state: 'SCANNING', end_time: null }) }),
        pool({
          name: 'paused',
          scan: scan({
            state: 'SCANNING',
            end_time: null,
            pause: '2026-08-20T02:00:00+00:00',
          }),
        }),
      ],
    });
    const result = (await scrubHistory.handler(ctx, {})) as Record<string, unknown>[];
    expect(result.map((p) => [p['pool'], p['state']])).toEqual([
      ['running', 'SCANNING'],
      ['paused', 'PAUSED'],
    ]);
  });

  it('reports a cancelled scrub as CANCELED rather than as a completed one', async () => {
    const { ctx } = fakeSystem({
      ['pool.query']: [
        pool({
          scan: scan({ state: 'CANCELED', end_time: '2026-08-20T01:30:00+00:00', percentage: 12 }),
        }),
      ],
    });
    const [result] = (await scrubHistory.handler(ctx, {})) as Record<string, unknown>[];
    expect(result['state']).toBe('CANCELED');
    expect(result['duration_seconds']).toBe(1800);
  });

  it('reports a pool that has never been scanned instead of omitting it', async () => {
    // An absent pool reads as a pool with nothing wrong, and never-scrubbed is
    // the finding this tool exists for. `scan` is null on a pool ZFS has never
    // scanned; an older middleware sends no `scan` key at all.
    const { ctx } = fakeSystem({
      ['pool.query']: [
        pool({ name: 'fresh', scan: null }),
        without('scan', pool({ name: 'silent' })),
      ],
    });
    expect(await scrubHistory.handler(ctx, {})).toEqual([
      {
        pool: 'fresh',
        state: 'NEVER_SCRUBBED',
        started_at: null,
        finished_at: null,
        duration_seconds: null,
        errors: null,
      },
      {
        pool: 'silent',
        state: 'NEVER_SCRUBBED',
        started_at: null,
        finished_at: null,
        duration_seconds: null,
        errors: null,
      },
    ]);
  });

  it('does not present the resilver that replaced a scrub as a scrub', async () => {
    // A pool records one scan, so a resilver overwrites the scrub before it.
    // Passing its times and error count through would report a scrub that
    // never ran — and on a pool that resilvered because a disk failed, which
    // is exactly when a stale scrub matters most.
    const { ctx } = fakeSystem({
      ['pool.query']: [
        pool({
          scan: scan({
            function: 'RESILVER',
            end_time: '2026-08-27T09:00:00+00:00',
            errors: 5,
          }),
        }),
      ],
    });
    expect(await scrubHistory.handler(ctx, {})).toEqual([
      {
        pool: 'tank',
        state: 'UNKNOWN',
        started_at: null,
        finished_at: null,
        duration_seconds: null,
        errors: null,
      },
    ]);
  });

  it('does not claim a pool the system is not reading has never been scrubbed', async () => {
    // A pool that is not imported carries no topology and no scan, and the
    // missing scan is then an absence of evidence: the record it would be read
    // from is not there. Reported as NEVER_SCRUBBED it would raise the one
    // alarm this tool exists to raise, about a pool nobody can answer for.
    // The second pool is the same case carrying a stale scan anyway: the
    // record cannot be read as current, so the state and the four fields agree
    // that nothing is known rather than reporting a scrub the state denies.
    const { ctx } = fakeSystem({
      ['pool.query']: [
        pool({ name: 'exported', topology: null, scan: null }),
        pool({ name: 'stale', topology: null }),
      ],
    });
    expect(await scrubHistory.handler(ctx, {})).toEqual([
      {
        pool: 'exported',
        state: 'UNKNOWN',
        started_at: null,
        finished_at: null,
        duration_seconds: null,
        errors: null,
      },
      {
        pool: 'stale',
        state: 'UNKNOWN',
        started_at: null,
        finished_at: null,
        duration_seconds: null,
        errors: null,
      },
    ]);
  });

  it('normalizes a scan whose keys the middleware did not send', async () => {
    // An omitted field is reported as null, so the caller meets the shape the
    // description promised with a value missing rather than a key missing.
    // A scrub with no state of its own is still a scrub on record, so its
    // times and error count stand: a null state says only that ZFS's own word
    // for the outcome is missing, where UNKNOWN says the scrub is unreadable.
    const { ctx } = fakeSystem({
      ['pool.query']: [
        pool({
          scan: without('errors', without('state', without('start_time', scan({})))),
        }),
      ],
    });
    const results = (await scrubHistory.handler(ctx, {})) as Record<string, unknown>[];
    expect(results).toEqual([
      {
        pool: 'tank',
        state: null,
        started_at: null,
        finished_at: '2026-08-20T04:30:00+00:00',
        duration_seconds: null,
        errors: null,
      },
    ]);
    // Expecting null above is what enforces the normalization: `toEqual`
    // reads an absent key and an undefined one alike, so a field that stopped
    // being normalized would arrive as undefined and fail against that null.
    // The keys below restate it in the terms the caller sees, and are the
    // weaker of the two — `Object.keys` lists a key holding undefined as well.
    expect(Object.keys(results[0])).toContain('started_at');
    expect(Object.keys(results[0])).toContain('errors');
    expect(Object.keys(results[0])).toContain('state');
  });

  it('gives no duration for a timestamp it cannot read', async () => {
    // The middleware's own types call these strings, so a value that is not a
    // timestamp is a shape this tool was not told about. It yields no duration
    // rather than a NaN the caller would have to detect.
    const { ctx } = fakeSystem({
      ['pool.query']: [
        pool({ name: 'bad-start', scan: scan({ start_time: 'not a timestamp' }) }),
        pool({ name: 'bad-end', scan: scan({ end_time: 'not a timestamp' }) }),
      ],
    });
    const result = (await scrubHistory.handler(ctx, {})) as Record<string, unknown>[];
    expect(result.map((p) => [p['pool'], p['duration_seconds']])).toEqual([
      ['bad-start', null],
      ['bad-end', null],
    ]);
  });

  it('surfaces neither the progress counters nor a field a later release adds', async () => {
    const { ctx } = fakeSystem({
      ['pool.query']: [
        pool({
          scan: scan({ future_field: 'added by a later TrueNAS release' }),
          future_field: 'added by a later TrueNAS release',
        }),
      ],
    });
    const [result] = (await scrubHistory.handler(ctx, {})) as Record<string, unknown>[];
    expect(Object.keys(result)).toEqual([
      'pool',
      'state',
      'started_at',
      'finished_at',
      'duration_seconds',
      'errors',
    ]);
  });

  it('returns [] for a system with no pools', async () => {
    const { ctx } = fakeSystem({ ['pool.query']: [] });
    expect(await scrubHistory.handler(ctx, {})).toEqual([]);
  });
});
