import { describe, expect, it } from 'vitest';
import { Role } from '@/interfaces';
import { failingSystem, fakeSystem } from '@/testing/fake-systems';
import {
  poolResilverConfig,
  poolScrubTaskCreate,
  poolScrubTasksList,
  poolScrubTaskUpdate,
  poolTopology,
  scrubHistory,
} from '@/tools/index';

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

describe('pool_resilver_config', () => {
  /** The configuration as `pool.resilver.config` reports one. */
  const config = (over: Record<string, unknown> = {}) => ({
    id: 1,
    enabled: true,
    begin: '18:00',
    end: '09:00',
    weekday: [1, 2, 3, 4, 5, 6, 7],
    ...over,
  });

  const read = async (payload: unknown): Promise<Record<string, unknown>> => {
    const { ctx } = fakeSystem({ ['pool.resilver.config']: payload });
    return (await poolResilverConfig.handler(ctx, {})) as Record<string, unknown>;
  };

  it('is advertised as a read-only, non-mutating tool taking no arguments', () => {
    expect(poolResilverConfig.name).toBe('pool_resilver_config');
    expect(poolResilverConfig.mutating).toBe(false);
    expect(poolResilverConfig.requiredRole).toBe(Role.ReadOnly);
    expect(poolResilverConfig.inputSchema).toEqual({ type: 'object', properties: {} });
  });

  it('reads the one system-wide configuration, with no parameters', async () => {
    const { ctx, call } = fakeSystem({ ['pool.resilver.config']: config() });
    expect(await poolResilverConfig.handler(ctx, {})).toEqual({
      enabled: true,
      begin: '18:00',
      end: '09:00',
      weekday: [1, 2, 3, 4, 5, 6, 7],
    });
    expect(call).toHaveBeenCalledWith('pool.resilver.config');
  });

  it('reports the four fields and nothing else, whatever the payload adds', async () => {
    // `id` is dropped deliberately — there is one such configuration — and the
    // allowlist is what keeps a field a later release adds out of the result.
    const result = await read(
      config({ future_field: 'added by a later TrueNAS release', weekday: [2] }),
    );
    expect(Object.keys(result)).toEqual(['enabled', 'begin', 'end', 'weekday']);
  });

  it('keeps an unreported field distinct from a configured-off one', async () => {
    // The whole difficulty of this payload: every field is optional, so
    // `enabled` absent must not read as `enabled: false`, and a `weekday` the
    // system did not send must not read as a window applying on no day.
    const absent = await read({ id: 1 });
    expect(absent).toEqual({ enabled: null, begin: null, end: null, weekday: null });

    const off = await read(config({ enabled: false, weekday: [] }));
    expect(off).toEqual({ enabled: false, begin: '18:00', end: '09:00', weekday: [] });
  });

  it('reads a window that wraps midnight as the two times the system recorded', async () => {
    // 22:00 to 06:00 is eight hours across the night. Nothing here subtracts
    // one end from the other, so there is no way for it to read as empty or
    // negative — this test is what pins that the times are passed through.
    const result = await read(config({ begin: '22:00', end: '06:00' }));
    expect(result['begin']).toBe('22:00');
    expect(result['end']).toBe('06:00');
  });

  it('reports `enabled: true` beside an empty weekday as that combination', async () => {
    // Not resolved into either reading: nothing on this surface says what the
    // system does with a window that names no day.
    expect(await read(config({ enabled: true, weekday: [] }))).toEqual({
      enabled: true,
      begin: '18:00',
      end: '09:00',
      weekday: [],
    });
  });

  it('keeps every day number the two candidate numberings agree on', async () => {
    // 0 is cron's Sunday and 7 is Sunday under both numberings, so the whole
    // 0-7 range is readable and none of it is dropped.
    const result = await read(config({ weekday: [0, 1, 2, 3, 4, 5, 6, 7] }));
    expect(result['weekday']).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it('nulls the whole weekday list rather than returning a shorter one', async () => {
    // A list one day shorter would say the window does not apply on that day,
    // which is a claim the read did not establish (#93). Every entry that is
    // not a whole number in range takes the list with it.
    const unreadable = [[1, 8], [1, -1], [1, 2.5], [1, 'monday'], [1, null], [1, NaN]];
    for (const weekday of unreadable) {
      expect((await read(config({ weekday })))['weekday']).toBeNull();
    }
  });

  it('nulls weekday where the field is not a list at all', async () => {
    expect((await read(config({ weekday: 'MONDAY' })))['weekday']).toBeNull();
    expect((await read(config({ weekday: { 1: true } })))['weekday']).toBeNull();
  });

  it('nulls a field the system sent as something other than its declared type', async () => {
    // A declared type is a claim about what the middleware sends, not the value
    // received (#91), so each field is read through a guard even though the
    // client declares all four.
    const result = await read(config({ enabled: 'yes', begin: 18, end: '' }));
    expect(result['enabled']).toBeNull();
    expect(result['begin']).toBeNull();
    expect(result['end']).toBeNull();
  });

  it('fails naming the read when the system answers with something else', async () => {
    // Fatal rather than a result of nulls: a configuration of nulls would be
    // indistinguishable from a system that has configured no window, and only
    // one of the two was actually read.
    await expect(read('not a configuration')).rejects.toThrow(
      'pool.resilver.config did not answer with a resilver configuration',
    );
    await expect(read([config()])).rejects.toThrow(
      'pool.resilver.config did not answer with a resilver configuration',
    );
    await expect(read(null)).rejects.toThrow(
      'pool.resilver.config did not answer with a resilver configuration',
    );
  });

  it('lets a failed read fail the tool, naming what the system said', async () => {
    const { ctx } = failingSystem({}, { ['pool.resilver.config']: new Error('connection reset') });
    await expect(poolResilverConfig.handler(ctx, {})).rejects.toThrow('connection reset');
  });

  it('says in its description what `enabled: false` does and does not mean', async () => {
    // The one reading that costs an operator something: a caller taking the
    // flag for "resilvering is disabled" would conclude a replaced disk is not
    // being rebuilt. Pinned, because it lives in prose and nothing else asserts
    // it (#128).
    expect(poolResilverConfig.description).toContain(
      'IT DOES NOT MEAN RESILVERING IS DISABLED',
    );
    expect(poolResilverConfig.description).toContain('system_general_config');
    expect(poolResilverConfig.description).toContain('SPANS MIDNIGHT');
  });
});

/** Sunday at midnight, as the TrueNAS UI's default scrub schedule is spelled. */
const SUNDAYS = { minute: '0', hour: '0', dom: '*', month: '*', dow: '0' };

/** The first of the month at 03:00, for a change. */
const MONTHLY = { minute: '0', hour: '3', dom: '1', month: '*', dow: '*' };

/** A `pool.scrub.query` row, carrying a field the allowlist must drop. */
const scrubRow = (over: Record<string, unknown> = {}) => ({
  id: 1,
  pool: 7,
  pool_name: 'tank',
  threshold: 35,
  description: 'weekly',
  schedule: SUNDAYS,
  enabled: true,
  internal_note: 'not reported',
  ...over,
});

/** The row as the tools report it. */
const reported = (over: Record<string, unknown> = {}) => ({
  id: 1,
  pool_id: 7,
  pool_name: 'tank',
  enabled: true,
  threshold: 35,
  description: 'weekly',
  schedule: SUNDAYS,
  ...over,
});

const TANK = { id: 7, name: 'tank', status: 'ONLINE' };

describe('pool_scrub_tasks_list', () => {
  const list = (rows: unknown) => poolScrubTasksList.handler(fakeSystem({ ['pool.scrub.query']: rows }).ctx, {});

  it('is a read-only tool', () => {
    expect(poolScrubTasksList).toMatchObject({ mutating: false, requiredRole: Role.ReadOnly });
  });

  it('reports every task through named fields only', async () => {
    expect(await list([scrubRow(), scrubRow({ id: 2, pool: 8, pool_name: 'fast', enabled: false })])).toEqual([
      reported(),
      reported({ id: 2, pool_id: 8, pool_name: 'fast', enabled: false }),
    ]);
  });

  it('reports the five cron fields alone, whatever else the schedule carries', async () => {
    const [row] = (await list([scrubRow({ schedule: { ...SUNDAYS, begin: '00:00' } })])) as {
      schedule: Record<string, unknown>;
    }[];
    expect(row.schedule).toEqual(SUNDAYS);
  });

  it('yields [] for a system with no scrub tasks', async () => {
    expect(await list([])).toEqual([]);
  });

  it('fails, rather than answering [], when the read is not a list', async () => {
    for (const bad of [undefined, null, scrubRow(), 3]) {
      await expect(list(bad)).rejects.toThrow('pool.scrub.query did not answer with a list of scrub tasks');
    }
  });

  it('lets a failed read fail the tool, naming what the system said', async () => {
    const { ctx } = failingSystem({}, { ['pool.scrub.query']: new Error('connection reset') });
    await expect(poolScrubTasksList.handler(ctx, {})).rejects.toThrow('connection reset');
  });

  it('keeps a row it cannot read as a row of nulls rather than dropping it', async () => {
    expect(await list(['garbage'])).toEqual([
      {
        id: null,
        pool_id: null,
        pool_name: null,
        enabled: null,
        threshold: null,
        description: null,
        schedule: null,
      },
    ]);
  });

  it('reads an unreadable field as null and never as a default', async () => {
    const [row] = (await list([
      scrubRow({ enabled: 'yes', threshold: '35', description: '', schedule: { minute: 0 } }),
    ])) as Record<string, unknown>[];
    expect(row).toMatchObject({
      enabled: null,
      threshold: null,
      description: null,
      schedule: { minute: null, hour: null, dom: null, month: null, dow: null },
    });
  });

  it('says what an empty list means, and puts no unit on threshold', () => {
    const guidance = poolScrubTasksList.resultGuidance ?? '';
    expect(guidance).toContain('A POOL WITH NO ROW HERE IS NOT SCRUBBED ON A SCHEDULE BY ANY TASK');
    expect(guidance).toContain('NO UNIT IS REPORTED FOR IT AND IT IS NOT TO BE CONVERTED');
    expect(poolScrubTasksList.description.endsWith(guidance)).toBe(true);
  });
});

/**
 * Units a description of `threshold` must not carry, because none is reported.
 * Singular `hour` and `minute` are cron field names and `second` is an
 * ordinal, so only their plurals count.
 */
const UNITS = /\b(days?|hours|minutes|seconds|weeks?)\b/i;

describe('no description puts a unit on threshold', () => {
  it.each([poolScrubTasksList, poolScrubTaskCreate, poolScrubTaskUpdate].map((tool) => [tool.name, tool]))(
    '%s',
    (_name, tool) => {
      expect(tool.description).not.toMatch(UNITS);
      // The argument's own text; the cron fields beside it say "day-of-week".
      const schema = tool.inputSchema as { properties: { threshold?: unknown } };
      expect(JSON.stringify(schema.properties.threshold ?? '')).not.toMatch(UNITS);
    },
  );
});

describe('pool_scrub_task_create', () => {
  const args = (over: Record<string, unknown> = {}) => ({
    pool: 'tank',
    schedule: MONTHLY,
    threshold: 20,
    enabled: true,
    ...over,
  });
  const created = scrubRow({ id: 4, schedule: MONTHLY, threshold: 20, description: undefined });
  const system = (
    responses: Record<string, unknown> = {},
  ) =>
    fakeSystem({
      ['pool.query']: [TANK],
      ['pool.scrub.query']: [],
      ['pool.scrub.create']: created,
      ...responses,
    });

  it('is a reversible mutating tool needing the full role', () => {
    expect(poolScrubTaskCreate).toMatchObject({
      mutating: true,
      destructiveness: 'reversible',
      requiredRole: Role.Full,
    });
  });

  it('refuses a schedule missing any of the five cron fields in its schema', () => {
    const schema = poolScrubTaskCreate.inputSchema as {
      properties: { schedule: { required: string[]; additionalProperties: boolean } };
      required: string[];
    };
    expect(schema.properties.schedule.required).toEqual(['minute', 'hour', 'dom', 'month', 'dow']);
    expect(schema.properties.schedule.additionalProperties).toBe(false);
    expect(schema.required).toEqual(['pool', 'schedule', 'threshold', 'enabled']);
  });

  it('normalizes args: keeps what is sent, and drops an omitted description and unknown keys', () => {
    expect(poolScrubTaskCreate.normalizeArgs?.({ ...args(), extra: 1 })).toEqual(args());
    expect(poolScrubTaskCreate.normalizeArgs?.(args({ description: 'monthly' }))).toEqual(
      args({ description: 'monthly' }),
    );
  });

  describe('argument validation', () => {
    const plan = (over: Record<string, unknown>) => poolScrubTaskCreate.plan(system().ctx, args(over));

    it('requires a pool name', async () => {
      for (const bad of [undefined, '', 7]) {
        await expect(plan({ pool: bad })).rejects.toThrow('"pool" is required and must be a pool name');
      }
    });

    it('requires a schedule, a threshold and an enabled flag', async () => {
      for (const field of ['schedule', 'threshold', 'enabled']) {
        await expect(plan({ [field]: undefined })).rejects.toThrow(`"${field}" is required`);
      }
    });

    it('refuses a schedule missing any of the five cron fields, naming it', async () => {
      for (const field of ['minute', 'hour', 'dom', 'month', 'dow']) {
        for (const bad of [undefined, '', 0]) {
          await expect(plan({ schedule: { ...MONTHLY, [field]: bad } })).rejects.toThrow(
            new RegExp(`"schedule\\.${field}" is required`),
          );
        }
      }
    });

    it('refuses a schedule key it does not send, rather than dropping it', async () => {
      await expect(plan({ schedule: { ...MONTHLY, begin: '00:00' } })).rejects.toThrow(
        '"schedule" takes only minute, hour, dom, month, dow — not begin',
      );
      await expect(plan({ schedule: '0 3 1 * *' })).rejects.toThrow('"schedule" must be an object');
    });

    it('is strict about threshold, enabled and description', async () => {
      await expect(plan({ threshold: '20' })).rejects.toThrow('"threshold" must be a number');
      await expect(plan({ threshold: Number.NaN })).rejects.toThrow('"threshold" must be a number');
      await expect(plan({ enabled: 'false' })).rejects.toThrow('"enabled" must be a boolean');
      await expect(plan({ description: '' })).rejects.toThrow('"description" must be a non-empty string');
    });
  });

  it('fails at plan time for a name pool.query does not list, naming it', async () => {
    await expect(
      poolScrubTaskCreate.plan(system({ ['pool.query']: [] }).ctx, args({ pool: 'boot-pool' })),
    ).rejects.toThrow('No pool named "boot-pool" on this system');
  });

  it('matches the pool by name on the response, never by taking the first row', async () => {
    // A filter the middleware dropped comes back as every pool.
    const { ctx } = system({ ['pool.query']: [{ id: 3, name: 'other' }, TANK] });
    const [, create] = await poolScrubTaskCreate.plan(ctx, args());
    expect(create.params).toEqual([{ pool: 7, schedule: MONTHLY, threshold: 20, enabled: true }]);
    await expect(
      poolScrubTaskCreate.plan(system({ ['pool.query']: [{ id: 3, name: 'other' }] }).ctx, args()),
    ).rejects.toThrow('No pool named "tank"');
  });

  it('refuses a pool listed with no id it can read', async () => {
    await expect(
      poolScrubTaskCreate.plan(system({ ['pool.query']: [{ name: 'tank', id: '7' }] }).ctx, args()),
    ).rejects.toThrow('Pool "tank" is listed with no id this tool could read');
  });

  it('plans the lookup it makes and then the create, with the pool id', async () => {
    const { ctx, query } = system();
    const steps = await poolScrubTaskCreate.plan(ctx, args({ description: 'monthly' }));
    expect(steps.map((step) => step.method)).toEqual(['pool.query', 'pool.scrub.create']);
    expect(steps[0].params).toEqual([[['name', '=', 'tank']], {}]);
    expect(query).toHaveBeenCalledWith('pool.query', [['name', '=', 'tank']]);
    expect(steps[0].description).toContain('7 when this plan was made. Changes nothing.');
    expect(steps[1].params).toEqual([
      { pool: 7, schedule: MONTHLY, threshold: 20, enabled: true, description: 'monthly' },
    ]);
    expect(steps[1].description).toContain(
      'Create a scrub task for pool "tank" with schedule minute "0", hour "3", dom "1", ' +
        'month "*", dow "*", threshold 20, enabled, description "monthly".',
    );
  });

  it('says in the plan that the pool has no scrub task, when it has none', async () => {
    const [, create] = await poolScrubTaskCreate.plan(system().ctx, args());
    expect(create.description).toContain('Pool "tank" has no scrub task now.');
  });

  it('names every scrub task the pool already has, and none on other pools', async () => {
    const { ctx, query } = system({
      // The whole table, as a dropped filter would answer.
      ['pool.scrub.query']: [scrubRow(), scrubRow({ id: 2, enabled: false }), scrubRow({ id: 3, pool: 8 })],
    });
    const [, create] = await poolScrubTaskCreate.plan(ctx, args());
    expect(query).toHaveBeenCalledWith('pool.scrub.query', [['pool', '=', 7]]);
    expect(create.description).toContain('Pool "tank" already has 2 scrub tasks: ');
    expect(create.description).toContain(
      'id 1 (enabled, schedule minute "0", hour "0", dom "*", month "*", dow "0", threshold 35, description "weekly")',
    );
    expect(create.description).toContain('id 2 (disabled,');
    expect(create.description).not.toContain('id 3');
    expect(create.description).toContain('This adds another beside them, which is allowed');
  });

  it('counts a task whose pool it cannot read, rather than leaving it out', async () => {
    const [, create] = await poolScrubTaskCreate.plan(
      system({ ['pool.scrub.query']: [scrubRow({ pool: 'tank' })] }).ctx,
      args(),
    );
    expect(create.description).toContain(
      'has no scrub task now. 1 further task named no pool this tool could read, and may be on this one.',
    );
  });

  it('does not fail the plan when the existing tasks cannot be read, and says so', async () => {
    const failed = failingSystem(
      { ['pool.query']: [TANK] },
      { ['pool.scrub.query']: new Error('timed out') },
    );
    const [, create] = await poolScrubTaskCreate.plan(failed.ctx, args());
    expect(create.description).toContain(
      'Whether pool "tank" already has a scrub task could not be read (pool.scrub.query failed: timed out)',
    );
    const [, notList] = await poolScrubTaskCreate.plan(system({ ['pool.scrub.query']: 'nope' }).ctx, args());
    expect(notList.description).toContain('pool.scrub.query did not answer with a list');
  });

  it('looks the pool up again and creates the task the plan named', async () => {
    const { ctx, query, call } = system();
    expect(await poolScrubTaskCreate.execute(ctx, args())).toEqual({
      pool: 'tank',
      pool_id: 7,
      requested: { schedule: MONTHLY, threshold: 20, enabled: true },
      task: reported({ id: 4, schedule: MONTHLY, threshold: 20, description: null }),
      confirmed: true,
    });
    expect(query).toHaveBeenCalledWith('pool.query', [['name', '=', 'tank']]);
    expect(call).toHaveBeenCalledWith('pool.scrub.create', [
      { pool: 7, schedule: MONTHLY, threshold: 20, enabled: true },
    ]);
    // The existing-task read is plan-time only.
    expect(query).not.toHaveBeenCalledWith('pool.scrub.query', expect.anything());
  });

  it('creates nothing when the pool is gone by the time it runs', async () => {
    const { ctx, call } = system({ ['pool.query']: [] });
    await expect(poolScrubTaskCreate.execute(ctx, args())).rejects.toThrow('No pool named "tank"');
    expect(call).not.toHaveBeenCalled();
  });

  it('reads the outcome off the response: a value stored differently is not confirmed', async () => {
    const { ctx } = system({ ['pool.scrub.create']: { ...created, enabled: false } });
    expect(await poolScrubTaskCreate.execute(ctx, args())).toMatchObject({ confirmed: false });
    const otherPool = system({ ['pool.scrub.create']: { ...created, pool: 8 } });
    expect(await poolScrubTaskCreate.execute(otherPool.ctx, args())).toMatchObject({ confirmed: false });
  });

  it('establishes nothing where a value sent cannot be read back', async () => {
    const { ctx } = system({ ['pool.scrub.create']: { ...created, threshold: undefined } });
    expect(await poolScrubTaskCreate.execute(ctx, args())).toMatchObject({ confirmed: null });
    const notRecord = system({ ['pool.scrub.create']: true });
    expect(await poolScrubTaskCreate.execute(notRecord.ctx, args())).toMatchObject({
      task: null,
      confirmed: null,
    });
  });

  it('compares a description only where one was sent', async () => {
    const { ctx } = system({ ['pool.scrub.create']: { ...created, description: 'monthly' } });
    expect(await poolScrubTaskCreate.execute(ctx, args({ description: 'monthly' }))).toMatchObject({
      confirmed: true,
    });
    expect(await poolScrubTaskCreate.execute(ctx, args({ description: 'other' }))).toMatchObject({
      confirmed: false,
    });
  });

  it('states that no tool here deletes a scrub task', () => {
    expect(poolScrubTaskCreate.description).toContain('NO TOOL IN THIS CATALOG DELETES A SCRUB TASK');
    expect(poolScrubTaskCreate.description).toContain('THE PLAN NAMES EVERY SCRUB TASK THE POOL ALREADY HAS');
    expect(poolScrubTaskCreate.resultGuidance).toContain('FALSE IS NOT A SUCCESS');
  });
});

describe('pool_scrub_task_update', () => {
  const updated = scrubRow({ schedule: MONTHLY });
  const system = (rows: unknown = [scrubRow()], answer: unknown = updated) =>
    fakeSystem({ ['pool.scrub.query']: rows, ['pool.scrub.update']: answer });
  const toMonthly = (over: Record<string, unknown> = {}) => ({ id: 1, schedule: MONTHLY, ...over });

  it('is a reversible mutating tool needing the full role', () => {
    expect(poolScrubTaskUpdate).toMatchObject({
      mutating: true,
      destructiveness: 'reversible',
      requiredRole: Role.Full,
    });
    const schema = poolScrubTaskUpdate.inputSchema as {
      properties: { schedule: { required: string[] } };
      required: string[];
    };
    expect(schema.properties.schedule.required).toEqual(['minute', 'hour', 'dom', 'month', 'dow']);
    expect(schema.required).toEqual(['id']);
  });

  it('normalizes args: sends only what was passed', () => {
    expect(poolScrubTaskUpdate.normalizeArgs?.({ id: 1, enabled: false, extra: 1 })).toEqual({
      id: 1,
      enabled: false,
    });
  });

  describe('argument validation', () => {
    const plan = (rawArgs: Record<string, unknown>) => poolScrubTaskUpdate.plan(system().ctx, rawArgs);

    it('requires a whole-number id', async () => {
      for (const bad of [undefined, '1', 1.5]) {
        await expect(plan(toMonthly({ id: bad }))).rejects.toThrow('"id" is required and must be a whole number');
      }
    });

    it('requires at least one field to change', async () => {
      await expect(plan({ id: 1 })).rejects.toThrow('Nothing to change');
    });

    it('refuses a schedule missing any of the five cron fields', async () => {
      for (const field of ['minute', 'hour', 'dom', 'month', 'dow']) {
        await expect(plan(toMonthly({ schedule: { ...MONTHLY, [field]: undefined } }))).rejects.toThrow(
          new RegExp(`"schedule\\.${field}" is required`),
        );
      }
    });

    it('executes nothing when an argument is unreadable', async () => {
      const { ctx, query, call } = system();
      await expect(poolScrubTaskUpdate.execute(ctx, { id: 1, enabled: 'no' })).rejects.toThrow(
        '"enabled" must be a boolean',
      );
      expect(query).not.toHaveBeenCalled();
      expect(call).not.toHaveBeenCalled();
    });
  });

  it('fails at plan time for an id pool.scrub.query does not return, comparing ids on the response', async () => {
    // A dropped filter answers with the whole table; its first row is another task.
    await expect(poolScrubTaskUpdate.plan(system([scrubRow({ id: 2 })]).ctx, toMonthly())).rejects.toThrow(
      'No scrub task with id 1 on this system — ids come from `pool_scrub_tasks_list`',
    );
    const steps = await poolScrubTaskUpdate.plan(system([scrubRow({ id: 2 }), scrubRow()]).ctx, toMonthly());
    expect(steps).toHaveLength(2);
  });

  it('plans the read it makes and the update, sending only the fields passed', async () => {
    const steps = await poolScrubTaskUpdate.plan(system().ctx, toMonthly({ threshold: 6 }));
    expect(steps.map((step) => step.method)).toEqual(['pool.scrub.query', 'pool.scrub.update']);
    expect(steps[0].params).toEqual([[['id', '=', 1]], {}]);
    expect(steps[0].description).toContain('Changes nothing.');
    expect(steps[1].params).toEqual([1, { schedule: MONTHLY, threshold: 6 }]);
    expect(steps[1].description).toContain(
      'Change the scrub task with id 1 on pool "tank": schedule minute "0", hour "3", dom "1", month "*", ' +
        'dow "*" (now schedule minute "0", hour "0", dom "*", month "*", dow "0"); threshold 6 (now threshold 35).',
    );
  });

  it('states each other field beside what the task holds now', async () => {
    const [, update] = await poolScrubTaskUpdate.plan(
      system([scrubRow({ description: undefined, enabled: 'x' })]).ctx,
      { id: 1, enabled: false, description: 'off for now' },
    );
    expect(update.description).toContain('disabled (now enabled (not readable))');
    expect(update.description).toContain('description "off for now" (now none reported)');
  });

  it('says in the plan when the task already holds every value sent', async () => {
    const [, same] = await poolScrubTaskUpdate.plan(system().ctx, { id: 1, schedule: SUNDAYS });
    expect(same.description).toContain('The task already holds every value this sends, which is not an error.');
    const [, different] = await poolScrubTaskUpdate.plan(system().ctx, toMonthly());
    expect(different.description).not.toContain('already holds');
  });

  it('reports a change it made, read off the response', async () => {
    const { ctx, query, call } = system();
    expect(await poolScrubTaskUpdate.execute(ctx, toMonthly())).toEqual({
      id: 1,
      requested: { schedule: MONTHLY },
      lookup: 'FOUND',
      lookup_error: null,
      previous: reported(),
      resulting: reported({ schedule: MONTHLY }),
      changed: true,
      confirmed: true,
    });
    expect(query).toHaveBeenCalledWith('pool.scrub.query', [['id', '=', 1]]);
    expect(call).toHaveBeenCalledWith('pool.scrub.update', [1, { schedule: MONTHLY }]);
  });

  it('reports a task already holding the values as unchanged and confirmed', async () => {
    const { ctx } = system([scrubRow()], scrubRow());
    expect(await poolScrubTaskUpdate.execute(ctx, { id: 1, schedule: SUNDAYS })).toMatchObject({
      changed: false,
      confirmed: true,
    });
  });

  it('reads a response still holding the old value as not confirmed', async () => {
    const { ctx } = system([scrubRow()], scrubRow());
    expect(await poolScrubTaskUpdate.execute(ctx, toMonthly())).toMatchObject({
      changed: false,
      confirmed: false,
    });
  });

  it('compares only the fields sent', async () => {
    // The description moved and nobody asked about it.
    const { ctx } = system([scrubRow()], scrubRow({ enabled: false, description: 'renamed' }));
    expect(await poolScrubTaskUpdate.execute(ctx, { id: 1, enabled: false })).toMatchObject({
      changed: true,
      confirmed: true,
    });
  });

  it('establishes nothing where the response cannot be read', async () => {
    const { ctx } = system([scrubRow()], true);
    expect(await poolScrubTaskUpdate.execute(ctx, toMonthly())).toMatchObject({
      resulting: null,
      changed: null,
      confirmed: null,
    });
    // One field unreadable and the rest as sent: not established. `hour` read
    // back different from before, so the task did change.
    const partial = system([scrubRow()], scrubRow({ schedule: { ...MONTHLY, dow: 0 } }));
    expect(await poolScrubTaskUpdate.execute(partial.ctx, toMonthly())).toMatchObject({
      changed: true,
      confirmed: null,
    });
  });

  it('reports NOT_FOUND and still makes the update the plan named', async () => {
    const { ctx, call } = system([]);
    expect(await poolScrubTaskUpdate.execute(ctx, toMonthly())).toMatchObject({
      lookup: 'NOT_FOUND',
      previous: null,
      changed: null,
      confirmed: true,
    });
    expect(call).toHaveBeenCalledWith('pool.scrub.update', [1, { schedule: MONTHLY }]);
  });

  it('reports UNREADABLE with the reason, and still makes the update', async () => {
    const { ctx, call } = failingSystem(
      { ['pool.scrub.update']: updated },
      { ['pool.scrub.query']: new Error('websocket closed') },
    );
    expect(await poolScrubTaskUpdate.execute(ctx, toMonthly())).toMatchObject({
      lookup: 'UNREADABLE',
      lookup_error: 'websocket closed',
      previous: null,
      changed: null,
      confirmed: true,
    });
    expect(call).toHaveBeenCalledWith('pool.scrub.update', [1, { schedule: MONTHLY }]);
  });

  it('says what disabling costs, and that it cannot move a task to another pool', () => {
    expect(poolScrubTaskUpdate.description).toContain('`enabled: false` STOPS THE POOL BEING SCRUBBED');
    expect(poolScrubTaskUpdate.description).toContain('the pool a task scrubs is not changed by this tool');
    expect(poolScrubTaskUpdate.description.endsWith(poolScrubTaskUpdate.resultGuidance ?? '')).toBe(true);
  });
});
