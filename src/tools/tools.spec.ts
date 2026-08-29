import { describe, expect, it, vi } from 'vitest';
import { of } from 'rxjs';
import { SystemHandle, ToolContext } from '@/catalog/tool';
import { Role } from '@/interfaces';
import {
  alertsList,
  appsList,
  createDefaultCatalog,
  createSnapshot,
  disksList,
  listDatasets,
  poolStatus,
  poolTopology,
  quotaReport,
  replicationStatus,
  scrubHistory,
  snapshotsList,
  snapshotTasksList,
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
  it('registers the thirteen sketch tools', () => {
    expect(createDefaultCatalog().list(Role.Full).map((t) => t.name)).toEqual([
      'system_info',
      'storage_pool_status',
      'storage_pool_topology',
      'storage_scrub_history',
      'storage_list_datasets',
      'datasets_quota_report',
      'disks_list',
      'apps_list',
      'alerts_list',
      'snapshots_list',
      'replication_status',
      'snapshot_tasks_list',
      'snapshots_create',
    ]);
  });

  it('advertises alerts_list to a read-only credential', () => {
    expect(createDefaultCatalog().list(Role.ReadOnly).map((t) => t.name)).toContain('alerts_list');
  });

  it('advertises disks_list to a read-only credential', () => {
    expect(createDefaultCatalog().list(Role.ReadOnly).map((t) => t.name)).toContain('disks_list');
  });

  it('advertises apps_list to a read-only credential', () => {
    expect(createDefaultCatalog().list(Role.ReadOnly).map((t) => t.name)).toContain('apps_list');
  });

  it('advertises storage_pool_topology to a read-only credential', () => {
    expect(createDefaultCatalog().list(Role.ReadOnly).map((t) => t.name)).toContain(
      'storage_pool_topology',
    );
  });

  it('advertises storage_scrub_history to a read-only credential', () => {
    expect(createDefaultCatalog().list(Role.ReadOnly).map((t) => t.name)).toContain(
      'storage_scrub_history',
    );
  });

  it('advertises datasets_quota_report to a read-only credential', () => {
    expect(createDefaultCatalog().list(Role.ReadOnly).map((t) => t.name)).toContain(
      'datasets_quota_report',
    );
  });

  it('advertises snapshots_list to a read-only credential', () => {
    expect(createDefaultCatalog().list(Role.ReadOnly).map((t) => t.name)).toContain(
      'snapshots_list',
    );
  });

  it('advertises replication_status to a read-only credential', () => {
    expect(createDefaultCatalog().list(Role.ReadOnly).map((t) => t.name)).toContain(
      'replication_status',
    );
  });

  it('advertises snapshot_tasks_list to a read-only credential', () => {
    expect(createDefaultCatalog().list(Role.ReadOnly).map((t) => t.name)).toContain(
      'snapshot_tasks_list',
    );
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

describe('apps_list', () => {
  // Every property the middleware's app row carries, so the assertions below
  // show what the tool drops as well as what it keeps. `portals`, `metadata`
  // and `active_workloads` are the bulky ones; `config` is the install-time
  // form the user filled in, and its `plex_claim_token` is a credential. All
  // four are here to be dropped.
  const app = (over: Record<string, unknown>) => ({
    name: 'plex',
    id: 'plex',
    state: 'RUNNING',
    upgrade_available: false,
    latest_version: '1.2.3',
    latest_app_version: '1.41.0.8994',
    image_updates_available: false,
    custom_app: false,
    migrated: false,
    human_version: '1.41.0.8994_1.2.3',
    version: '1.2.3',
    metadata: { app_version: '1.41.0.8994', capabilities: [], run_as_context: [] },
    active_workloads: {
      containers: 1,
      used_ports: [{ container_port: 32400, protocol: 'tcp' }],
      container_details: [{ id: 'abc', service_name: 'plex', image: 'plexinc/pms-docker' }],
      volumes: [{ source: '/mnt/tank/plex', destination: '/config' }],
    },
    notes: null,
    action_required: false,
    portals: { 'Web UI': 'http://nas:32400' },
    version_details: null,
    config: { plex_claim_token: 'claim-abc123' },
    ...over,
  });

  it('trims app.query to the named fields', async () => {
    const { ctx, query } = fakeSystem({ ['app.query']: [app({})] });
    expect(await appsList.handler(ctx, {})).toEqual([
      {
        name: 'plex',
        version: '1.2.3',
        latest_version: '1.2.3',
        state: 'RUNNING',
        upgrade_available: false,
        image_updates_available: false,
      },
    ]);
    // The tool reads the app list and nothing else, with no filters and no
    // options: unlike disks_list there is no `extra` the rows depend on.
    expect(query.mock.calls).toEqual([['app.query']]);
  });

  it('surfaces neither the install-time config nor a field a later release adds', async () => {
    const { ctx } = fakeSystem({
      ['app.query']: [app({ future_field: 'added by a later TrueNAS release' })],
    });
    const [result] = (await appsList.handler(ctx, {})) as Record<string, unknown>[];
    expect(Object.keys(result)).toEqual([
      'name',
      'version',
      'latest_version',
      'state',
      'upgrade_available',
      'image_updates_available',
    ]);
  });

  it('includes apps that are not running, keeping stopped and crashed apart', async () => {
    const { ctx } = fakeSystem({
      ['app.query']: [
        app({ name: 'plex', state: 'RUNNING' }),
        app({ name: 'nextcloud', state: 'STOPPED' }),
        app({ name: 'jellyfin', state: 'CRASHED' }),
        app({ name: 'immich', state: 'DEPLOYING' }),
      ],
    });
    const result = (await appsList.handler(ctx, {})) as { name: string; state: string }[];
    expect(result.map((a) => [a.name, a.state])).toEqual([
      ['plex', 'RUNNING'],
      ['nextcloud', 'STOPPED'],
      ['jellyfin', 'CRASHED'],
      ['immich', 'DEPLOYING'],
    ]);
  });

  it('reports a waiting catalog upgrade and a waiting image update separately', async () => {
    // A custom app has no catalog version to move to, so `upgrade_available`
    // is permanently false and `image_updates_available` is the only signal
    // that it is out of date. Collapsing the two would report it up to date.
    const { ctx } = fakeSystem({
      ['app.query']: [
        app({
          name: 'sonarr',
          upgrade_available: true,
          latest_version: '2.0.0',
          version: '1.9.0',
          image_updates_available: false,
        }),
        app({
          name: 'my-own-thing',
          upgrade_available: false,
          latest_version: null,
          image_updates_available: true,
        }),
      ],
    });
    expect(await appsList.handler(ctx, {})).toEqual([
      {
        name: 'sonarr',
        version: '1.9.0',
        latest_version: '2.0.0',
        state: 'RUNNING',
        upgrade_available: true,
        image_updates_available: false,
      },
      {
        name: 'my-own-thing',
        version: '1.2.3',
        latest_version: null,
        state: 'RUNNING',
        upgrade_available: false,
        image_updates_available: true,
      },
    ]);
  });

  it('returns [] for a system with no apps installed', async () => {
    const { ctx } = fakeSystem({ ['app.query']: [] });
    expect(await appsList.handler(ctx, {})).toEqual([]);
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

describe('snapshots_list', () => {
  /**
   * A snapshot row as `pool.snapshot.query` reports one. `id`, `pool`,
   * `snapshot_name`, `type` and `createtxg` are here to be dropped: they are
   * fields of the real payload the tool does not name.
   */
  const snapshot = (over: Record<string, unknown> = {}) => ({
    id: 'tank/media@nightly-1',
    name: 'tank/media@nightly-1',
    dataset: 'tank/media',
    pool: 'tank',
    snapshot_name: 'nightly-1',
    type: 'SNAPSHOT',
    createtxg: '12345',
    properties: {
      creation: { value: 'Thu Aug 28 02:00 2025', rawvalue: '1756346400', parsed: 1756346400 },
      referenced: { value: '96K', rawvalue: '98304', parsed: 98304 },
    },
    ...over,
  });

  /** The tool's own envelope, for the assertions below. */
  interface Listing {
    snapshots: Record<string, unknown>[];
    truncated: boolean;
    limit: number;
  }

  const listing = async (
    snapshots: unknown[],
    args: Record<string, unknown> = {},
    datasets: unknown[] = [],
  ): Promise<Listing> => {
    const { ctx } = fakeSystem({
      ['pool.snapshot.query']: snapshots,
      ['pool.dataset.query']: datasets,
    });
    return (await snapshotsList.handler(ctx, args)) as unknown as Listing;
  };

  it('maps a snapshot to its name, dataset, creation time and referenced size', async () => {
    const result = await listing([snapshot()]);
    expect(result).toEqual({
      snapshots: [
        {
          name: 'tank/media@nightly-1',
          dataset: 'tank/media',
          created: '2025-08-28T02:00:00.000Z',
          referenced_bytes: 98304,
        },
      ],
      truncated: false,
      limit: 100,
    });
  });

  it('surfaces no field a later release adds', async () => {
    const result = await listing([snapshot({ future_field: 'added by a later TrueNAS release' })]);
    expect(Object.keys(result.snapshots[0])).toEqual([
      'name',
      'dataset',
      'created',
      'referenced_bytes',
    ]);
  });

  it('asks for one more row than the bound, and for only the two properties it reports', async () => {
    const { ctx, query } = fakeSystem({ ['pool.snapshot.query']: [snapshot()] });
    await snapshotsList.handler(ctx, {});
    // No `order_by`: the system applies the bound, so an order asked for here
    // would choose which snapshots a truncated list holds, and no field of a
    // snapshot row orders it in time soundly — `createtxg` is a string, and it
    // counts transaction groups on the system holding the snapshot rather than
    // the one that took it. The extra row is what tells a complete list from a
    // truncated one.
    expect(query).toHaveBeenCalledWith('pool.snapshot.query', [], {
      limit: 101,
      extra: { properties: ['creation', 'referenced'] },
    });
  });

  it('passes a dataset filter to the query', async () => {
    const { ctx, query } = fakeSystem({ ['pool.snapshot.query']: [snapshot()] });
    await snapshotsList.handler(ctx, { dataset: 'tank/media' });
    expect(query).toHaveBeenCalledWith('pool.snapshot.query', [['dataset', '=', 'tank/media']], {
      limit: 101,
      extra: { properties: ['creation', 'referenced'] },
    });
    // The dataset plainly exists — it has snapshots — so nothing else is asked.
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('reports a dataset that exists and holds no snapshots as an empty list', async () => {
    expect(await listing([], { dataset: 'tank/empty' }, [{ id: 'tank/empty' }])).toEqual({
      snapshots: [],
      truncated: false,
      limit: 100,
    });
  });

  it('distinguishes a dataset that does not exist from one with no snapshots', async () => {
    // Same empty snapshot list as above; the dataset query is what differs.
    await expect(listing([], { dataset: 'tank/ghost' }, [])).rejects.toThrow(
      /Dataset "tank\/ghost" does not exist/,
    );
  });

  it('does not check for the dataset when none was named', async () => {
    const { ctx, query } = fakeSystem({ ['pool.snapshot.query']: [] });
    await expect(snapshotsList.handler(ctx, {})).resolves.toEqual({
      snapshots: [],
      truncated: false,
      limit: 100,
    });
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('rejects a dataset argument that is not a dataset name', async () => {
    // Ignoring it would answer with every snapshot on the system, which is a
    // wrong answer to the question asked rather than a broad one.
    for (const bad of [123, '', true, {}]) {
      await expect(listing([snapshot()], { dataset: bad })).rejects.toThrow(
        /"dataset" must be a non-empty string/,
      );
    }
  });

  it('bounds the list and says so when the system holds more', async () => {
    // Which two come back is the system's choice — the bound is applied there,
    // and this tool orders that window rather than choosing it. `truncated` is
    // what says the list is not the whole set.
    const result = await listing(
      [snapshot({ name: 'a' }), snapshot({ name: 'b' }), snapshot({ name: 'c' })],
      { limit: 2 },
    );
    expect(result.snapshots.map((row) => row['name'])).toEqual(['a', 'b']);
    expect(result.truncated).toBe(true);
    expect(result.limit).toBe(2);
  });

  it('is not truncated when the system holds exactly the bound', async () => {
    const result = await listing([snapshot({ name: 'a' }), snapshot({ name: 'b' })], { limit: 2 });
    expect(result.snapshots).toHaveLength(2);
    expect(result.truncated).toBe(false);
  });

  it('clamps the bound, and reports the one it applied', async () => {
    const applied = async (limit: unknown): Promise<number> => {
      const { ctx, query } = fakeSystem({ ['pool.snapshot.query']: [] });
      const result = (await snapshotsList.handler(ctx, { limit })) as unknown as Listing;
      // The bound reported and the bound asked of the middleware are the same
      // number, so a caller reading `limit` is reading what actually applied.
      expect(query).toHaveBeenCalledWith('pool.snapshot.query', [], {
        limit: result.limit + 1,
        extra: { properties: ['creation', 'referenced'] },
      });
      return result.limit;
    };
    expect(await applied(5000)).toBe(1000);
    // Zero would return nothing while reporting the system as holding more.
    expect(await applied(0)).toBe(1);
    expect(await applied(-3)).toBe(1);
    expect(await applied(2.7)).toBe(2);
    // Not a number, so not a bound: the default stands.
    expect(await applied('50')).toBe(100);
    expect(await applied(Number.NaN)).toBe(100);
    expect(await applied(undefined)).toBe(100);
  });

  it('orders newest first, and puts an unreadable creation time last', async () => {
    const result = await listing([
      snapshot({ name: 'older', properties: { creation: { rawvalue: '1000' } } }),
      snapshot({ name: 'unreadable', properties: { creation: { rawvalue: 'whenever' } } }),
      snapshot({ name: 'newest', properties: { creation: { rawvalue: '3000' } } }),
      snapshot({ name: 'middle', properties: { creation: { rawvalue: '2000' } } }),
      snapshot({ name: 'also-unreadable', properties: {} }),
    ]);
    expect(result.snapshots.map((row) => row['name'])).toEqual([
      'newest',
      'middle',
      'older',
      // Both unreadable, in the order the system sent them.
      'unreadable',
      'also-unreadable',
    ]);
  });

  it('reads the creation time ZFS reports rather than the middleware rendering', async () => {
    // `parsed` disagrees with `rawvalue` here: only a tool reading the raw
    // epoch seconds answers with the second timestamp.
    const result = await listing([
      snapshot({
        properties: { creation: { rawvalue: '1756346400', parsed: 'Aug 27 2019, sometime' } },
      }),
    ]);
    expect(result.snapshots[0]['created']).toBe('2025-08-28T02:00:00.000Z');
  });

  it('reports a creation time it cannot read as null rather than as the epoch', async () => {
    const unreadable = async (creation: unknown): Promise<unknown> => {
      const result = await listing([snapshot({ properties: { creation } })]);
      return result.snapshots[0]['created'];
    };
    // `Number('')` is 0, which would date every one of these to 1970.
    expect(await unreadable({ rawvalue: '' })).toBeNull();
    expect(await unreadable({ rawvalue: 'whenever' })).toBeNull();
    expect(await unreadable({ rawvalue: '17e8' })).toBeNull();
    expect(await unreadable({ rawvalue: null })).toBeNull();
    expect(await unreadable({})).toBeNull();
    expect(await unreadable(null)).toBeNull();
    expect(await unreadable(1756346400)).toBeNull();
    // Beyond what a Date can hold, where `toISOString` throws rather than
    // answering — one absurd row must not take the whole listing down.
    expect(await unreadable({ rawvalue: '999999999999999' })).toBeNull();
    expect(await unreadable({ rawvalue: '-999999999999999' })).toBeNull();
    expect(await unreadable({ rawvalue: Number.POSITIVE_INFINITY })).toBeNull();
    // A number the system did send, in the form it sends strings in.
    expect(await unreadable({ rawvalue: 1756346400 })).toBe('2025-08-28T02:00:00.000Z');
    expect(await unreadable({ rawvalue: '-1' })).toBe('1969-12-31T23:59:59.000Z');
  });

  it('reports an unreadable referenced size as null rather than as nothing referenced', async () => {
    const referenced = async (property: unknown): Promise<unknown> => {
      const result = await listing([
        snapshot({ properties: { creation: { rawvalue: '1' }, referenced: property } }),
      ]);
      return result.snapshots[0]['referenced_bytes'];
    };
    expect(await referenced({ parsed: 0 })).toBe(0);
    expect(await referenced({ parsed: Number.NaN })).toBeNull();
    expect(await referenced({ parsed: '98304' })).toBeNull();
    expect(await referenced({})).toBeNull();
    expect(await referenced(undefined)).toBeNull();
    expect(await referenced(98304)).toBeNull();
  });

  it('reports a name or dataset that is not a string as null', async () => {
    const result = await listing([snapshot({ name: 12345, dataset: null })]);
    expect(result.snapshots[0]['name']).toBeNull();
    expect(result.snapshots[0]['dataset']).toBeNull();
  });

  it('survives a row whose properties are not an object', async () => {
    const result = await listing([snapshot({ properties: 'unset' })]);
    expect(result.snapshots[0]).toEqual({
      name: 'tank/media@nightly-1',
      dataset: 'tank/media',
      created: null,
      referenced_bytes: null,
    });
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

describe('replication_status', () => {
  /**
   * A replication task as `replication.query` reports one. `recursive`, `auto`,
   * `retention_policy`, `periodic_snapshot_tasks`, `has_encrypted_dataset_keys`
   * and `job` are here to be dropped: they are fields of the real payload the
   * tool does not name.
   */
  const task = (over: Record<string, unknown> = {}) => ({
    id: 1,
    name: 'nightly-to-backup',
    direction: 'PUSH',
    transport: 'SSH',
    enabled: true,
    source_datasets: ['tank/media'],
    target_dataset: 'backup/media',
    recursive: true,
    auto: true,
    retention_policy: 'SOURCE',
    periodic_snapshot_tasks: [],
    has_encrypted_dataset_keys: false,
    state: { state: 'FINISHED', datetime: { $date: 1756346400000 }, error: null },
    job: null,
    ...over,
  });

  const statuses = async (tasks: unknown[]): Promise<Record<string, unknown>[]> => {
    const { ctx } = fakeSystem({ ['replication.query']: tasks });
    return (await replicationStatus.handler(ctx, {})) as Record<string, unknown>[];
  };

  /** One task, differing only in the state record the system holds for it. */
  const forState = async (state: unknown): Promise<Record<string, unknown>> =>
    (await statuses([task({ state })]))[0];

  it('maps a task to its endpoints, transport and last run', async () => {
    expect(await statuses([task()])).toEqual([
      {
        id: 1,
        name: 'nightly-to-backup',
        direction: 'PUSH',
        transport: 'SSH',
        enabled: true,
        source_datasets: ['tank/media'],
        target_dataset: 'backup/media',
        state: 'FINISHED',
        finished_at: '2025-08-28T02:00:00.000Z',
        error: null,
      },
    ]);
  });

  it('surfaces no field a later release adds', async () => {
    const rows = await statuses([task({ future_field: 'added by a later TrueNAS release' })]);
    expect(Object.keys(rows[0])).toEqual([
      'id',
      'name',
      'direction',
      'transport',
      'enabled',
      'source_datasets',
      'target_dataset',
      'state',
      'finished_at',
      'error',
    ]);
  });

  it('asks for every task, with no filters and no options', async () => {
    const { ctx, query } = fakeSystem({ ['replication.query']: [task()] });
    await replicationStatus.handler(ctx, {});
    expect(query).toHaveBeenCalledWith('replication.query');
  });

  it('returns [] for a system with no replication tasks', async () => {
    expect(await statuses([])).toEqual([]);
  });

  it('marks a task that has never run rather than omitting it or failing it', async () => {
    // What the system holds for a task created and not yet run: pending, with
    // no time recorded against it.
    const row = await forState({ state: 'PENDING' });
    expect(row['state']).toBe('NEVER_RUN');
    expect(row['finished_at']).toBeNull();
    expect(row['error']).toBeNull();
  });

  it('reads a task pending again after running as PENDING, not as never run', async () => {
    // The recorded time is the evidence that something has happened to this
    // task before; it is not a finish time, so it is not reported as one.
    const row = await forState({ state: 'PENDING', datetime: { $date: 1756346400000 } });
    expect(row['state']).toBe('PENDING');
    expect(row['finished_at']).toBeNull();
  });

  it('reports a state it cannot read as null rather than as never run', async () => {
    // A task nothing can be said about must not read as one known to have
    // never replicated: that is a fact about the task, not about this tool.
    for (const unreadable of [undefined, null, 'FINISHED', 42, {}, { state: null }, { state: '' }]) {
      const row = await forState(unreadable);
      expect(row['state']).toBeNull();
      expect(row['finished_at']).toBeNull();
      expect(row['error']).toBeNull();
    }
  });

  it('distinguishes a running task from a finished one, and gives it no finish time', async () => {
    // The system records one time per task, and under RUNNING it is when the
    // current run started — reporting it as `finished_at` would name a real
    // timestamp as something it is not.
    const running = await forState({ state: 'RUNNING', datetime: { $date: 1756346400000 } });
    expect(running['state']).toBe('RUNNING');
    expect(running['finished_at']).toBeNull();
    const held = await forState({ state: 'HOLD', datetime: { $date: 1756346400000 } });
    expect(held['state']).toBe('HOLD');
    expect(held['finished_at']).toBeNull();
  });

  it('passes through a state a later release adds', async () => {
    const row = await forState({ state: 'SUSPENDED', datetime: { $date: 1756346400000 } });
    expect(row['state']).toBe('SUSPENDED');
    // Not one of the two states that describe an ended run, so no finish time.
    expect(row['finished_at']).toBeNull();
  });

  it('reports the finish time of a run that ended, in either shape the time arrives in', async () => {
    const enveloped = await forState({ state: 'ERROR', datetime: { $date: 1756346400000 } });
    expect(enveloped['state']).toBe('ERROR');
    expect(enveloped['finished_at']).toBe('2025-08-28T02:00:00.000Z');
    // The envelope only tags a number as a date; a bare one is the same instant.
    const bare = await forState({ state: 'FINISHED', datetime: 1756346400000 });
    expect(bare['finished_at']).toBe('2025-08-28T02:00:00.000Z');
  });

  it('reports a finish time it cannot read as null rather than as the epoch', async () => {
    const finished = async (datetime: unknown): Promise<unknown> =>
      (await forState({ state: 'FINISHED', datetime }))['finished_at'];
    expect(await finished('2025-08-28T02:00:00Z')).toBeNull();
    expect(await finished({ $date: '1756346400000' })).toBeNull();
    expect(await finished({})).toBeNull();
    expect(await finished(null)).toBeNull();
    expect(await finished(Number.NaN)).toBeNull();
    expect(await finished(Number.POSITIVE_INFINITY)).toBeNull();
    // Beyond what a Date can hold, where `toISOString` throws rather than
    // answering — one absurd row must not take the whole listing down.
    expect(await finished({ $date: 8.64e15 + 1 })).toBeNull();
    expect(await finished({ $date: -8.64e15 - 1 })).toBeNull();
    expect(await finished({ $date: 0 })).toBe('1970-01-01T00:00:00.000Z');
  });

  it('carries the error text of a failed run, and reads an empty one as none', async () => {
    const failed = await forState({
      state: 'ERROR',
      datetime: { $date: 1756346400000 },
      error: 'ssh connection refused',
    });
    expect(failed['error']).toBe('ssh connection refused');
    // An empty string names nothing a caller could act on; the ERROR state is
    // what says the run failed either way.
    for (const none of ['', null, undefined, 42, { message: 'nope' }]) {
      const row = await forState({ state: 'ERROR', error: none });
      expect(row['state']).toBe('ERROR');
      expect(row['error']).toBeNull();
    }
  });

  it('lists a disabled task, and reports a switch it cannot read as null', async () => {
    const [disabled] = await statuses([task({ enabled: false })]);
    expect(disabled['enabled']).toBe(false);
    // Not defaulted either way: a task whose switch is unreadable must not be
    // presented as definitely on or definitely off.
    const [unreported] = await statuses([task({ enabled: undefined })]);
    expect(unreported['enabled']).toBeNull();
  });

  it('reports the source datasets, keeping only the names among them', async () => {
    const sources = async (value: unknown): Promise<unknown> =>
      (await statuses([task({ source_datasets: value })]))[0]['source_datasets'];
    expect(await sources(['tank/media', 'tank/docs'])).toEqual(['tank/media', 'tank/docs']);
    expect(await sources(['tank/media', 7, null])).toEqual(['tank/media']);
    expect(await sources(undefined)).toEqual([]);
    expect(await sources('tank/media')).toEqual([]);
  });
});

describe('snapshot_tasks_list', () => {
  /**
   * A periodic snapshot task as `pool.snapshottask.query` reports one.
   * `exclude`, `naming_schema`, `allow_empty`, `vmware_sync` and `state` are
   * here to be dropped: they are fields of the real payload the tool does not
   * name.
   */
  const task = (over: Record<string, unknown> = {}) => ({
    id: 1,
    dataset: 'tank/media',
    recursive: true,
    enabled: true,
    lifetime_value: 2,
    lifetime_unit: 'WEEK',
    schedule: {
      minute: '0',
      hour: '2',
      dom: '*',
      month: '*',
      dow: '*',
      begin: '00:00',
      end: '23:59',
    },
    exclude: [],
    naming_schema: 'auto-%Y-%m-%d_%H-%M',
    allow_empty: true,
    vmware_sync: false,
    state: { state: 'FINISHED' },
    ...over,
  });

  const listed = async (rows: unknown[]): Promise<Record<string, unknown>[]> => {
    const { ctx } = fakeSystem({ ['pool.snapshottask.query']: rows });
    return (await snapshotTasksList.handler(ctx, {})) as Record<string, unknown>[];
  };

  /** One task, differing only in the schedule the system holds for it. */
  const forSchedule = async (schedule: unknown): Promise<Record<string, unknown>> =>
    (await listed([task({ schedule })]))[0];

  /**
   * The words one schedule is rendered into. The base is a daily 02:00 task
   * with no window, so a case names only the fields it is about.
   */
  const described = async (over: Record<string, unknown>): Promise<unknown> =>
    (await forSchedule({ minute: '0', hour: '2', dom: '*', month: '*', dow: '*', ...over }))[
      'schedule_description'
    ];

  it('maps a task to its dataset, schedule and retention', async () => {
    expect(await listed([task()])).toEqual([
      {
        id: 1,
        dataset: 'tank/media',
        enabled: true,
        recursive: true,
        schedule: {
          minute: '0',
          hour: '2',
          dom: '*',
          month: '*',
          dow: '*',
          begin: '00:00',
          end: '23:59',
        },
        schedule_description: 'at 02:00, every day',
        lifetime_value: 2,
        lifetime_unit: 'WEEK',
      },
    ]);
  });

  it('surfaces no field a later release adds, at either level', async () => {
    const rows = await listed([
      task({
        future_field: 'added by a later TrueNAS release',
        schedule: { minute: '0', hour: '2', dom: '*', month: '*', dow: '*', timezone: 'UTC' },
      }),
    ]);
    expect(Object.keys(rows[0])).toEqual([
      'id',
      'dataset',
      'enabled',
      'recursive',
      'schedule',
      'schedule_description',
      'lifetime_value',
      'lifetime_unit',
    ]);
    expect(Object.keys(rows[0]['schedule'] as object)).toEqual([
      'minute',
      'hour',
      'dom',
      'month',
      'dow',
      'begin',
      'end',
    ]);
  });

  it('asks for every task, with no filters and no options', async () => {
    const { ctx, query } = fakeSystem({ ['pool.snapshottask.query']: [task()] });
    await snapshotTasksList.handler(ctx, {});
    expect(query).toHaveBeenCalledWith('pool.snapshottask.query');
  });

  it('returns [] for a system with no snapshot tasks', async () => {
    expect(await listed([])).toEqual([]);
  });

  it('lists a disabled task, and reports a switch it cannot read as null', async () => {
    // A task that exists and is off is the case worth surfacing, so it is
    // returned and marked rather than omitted.
    const [disabled] = await listed([task({ enabled: false })]);
    expect(disabled['enabled']).toBe(false);
    // Not defaulted either way: a task whose switch is unreadable must not be
    // presented as definitely on or definitely off.
    const [unreported] = await listed([task({ enabled: undefined })]);
    expect(unreported['enabled']).toBeNull();
  });

  it('reports recursion it cannot read as null rather than as flat', async () => {
    expect((await listed([task({ recursive: false })]))[0]['recursive']).toBe(false);
    expect((await listed([task({ recursive: undefined })]))[0]['recursive']).toBeNull();
  });

  it('reports the retention, and a retention it cannot read as null', async () => {
    const [kept] = await listed([task({ lifetime_value: 6, lifetime_unit: 'MONTH' })]);
    expect(kept['lifetime_value']).toBe(6);
    expect(kept['lifetime_unit']).toBe('MONTH');
    // Null rather than absent: a task whose retention could not be read is not
    // one that keeps its snapshots forever.
    const [unreported] = await listed([
      task({ lifetime_value: undefined, lifetime_unit: undefined }),
    ]);
    expect(unreported['lifetime_value']).toBeNull();
    expect(unreported['lifetime_unit']).toBeNull();
  });

  it('reports a schedule it cannot read at all as null, with no words for it', async () => {
    for (const unreadable of [undefined, null, '0 2 * * *', 42]) {
      const row = await forSchedule(unreadable);
      expect(row['schedule']).toBeNull();
      expect(row['schedule_description']).toBeNull();
    }
  });

  it('reports a cron field it cannot read as null, and renders no words then', async () => {
    const row = await forSchedule({ minute: '', hour: 2, dom: '*', dow: null });
    expect(row['schedule']).toEqual({
      minute: null,
      hour: null,
      dom: '*',
      month: null,
      dow: null,
      begin: null,
      end: null,
    });
    expect(row['schedule_description']).toBeNull();
  });

  it('states a fixed time of day in words', async () => {
    expect(await described({ minute: '30', hour: '2' })).toBe('at 02:30, every day');
    expect(await described({ minute: '0', hour: '0,12' })).toBe('at 00:00 and 12:00, every day');
    expect(await described({ minute: '5', hour: '0,6,18' })).toBe(
      'at 00:05, 06:05 and 18:05, every day',
    );
  });

  it('states a recurring interval in words', async () => {
    expect(await described({ minute: '0', hour: '*' })).toBe('every hour at :00, every day');
    expect(await described({ minute: '15', hour: '*/4' })).toBe('every 4 hours at :15, every day');
    // A step of one is every hour; "every 1 hours" is not English.
    expect(await described({ minute: '0', hour: '*/1' })).toBe('every hour at :00, every day');
    expect(await described({ minute: '*/15', hour: '*' })).toBe('every 15 minutes, every day');
    // A step that fills its unit exactly: once a day, and once an hour.
    expect(await described({ minute: '0', hour: '*/24' })).toBe('every 24 hours at :00, every day');
    expect(await described({ minute: '*/60', hour: '*' })).toBe('every 60 minutes, every day');
  });

  it('states no interval for a step that does not divide its unit', async () => {
    // A step counts from the start of its unit and stops rather than wrapping.
    // Hours stepping by 5 run at 00, 05, 10, 15 and 20 and then wait four hours
    // for midnight, so "every 5 hours" would name an interval the task breaks
    // once a day.
    expect(await described({ minute: '0', hour: '*/5' })).toBeNull();
    expect(await described({ minute: '0', hour: '*/7' })).toBeNull();
    expect(await described({ minute: '*/7', hour: '*' })).toBeNull();
    expect(await described({ minute: '*/45', hour: '*' })).toBeNull();
    // The ones that do divide are unaffected.
    expect(await described({ minute: '0', hour: '*/8' })).toBe('every 8 hours at :00, every day');
    expect(await described({ minute: '*/20', hour: '*' })).toBe('every 20 minutes, every day');
  });

  it('states which days it runs on in words', async () => {
    expect(await described({ dow: '1' })).toBe('at 02:00, on Monday');
    expect(await described({ dow: '0,4' })).toBe('at 02:00, on Sunday and Thursday');
    // Cron numbers Sunday as both 0 and 7.
    expect(await described({ dow: '7' })).toBe('at 02:00, on Sunday');
    expect(await described({ dow: 'mon,Thu' })).toBe('at 02:00, on Monday and Thursday');
    expect(await described({ dom: '1' })).toBe('at 02:00, on day 1 of each month');
    expect(await described({ dom: '1,15' })).toBe('at 02:00, on days 1 and 15 of each month');
  });

  it('names the daily window only where one restricts the task', async () => {
    expect(await described({ begin: '09:00', end: '17:00' })).toBe(
      'at 02:00, every day, between 09:00 and 17:00',
    );
    // The window a task carries when nothing restricts it, which is worth no
    // words: it says only that the task is not restricted.
    expect(await described({ begin: '00:00', end: '23:59' })).toBe('at 02:00, every day');
    // Half a window is not a window, and the missing end must not be assumed.
    expect(await described({ begin: '09:00' })).toBe('at 02:00, every day');
    expect(await described({ end: '17:00' })).toBe('at 02:00, every day');
  });

  it('renders no words for a schedule shape it cannot state exactly', async () => {
    for (const shape of [
      // A list of minutes, which no shape here renders.
      { minute: '0,30', hour: '2' },
      // Stepped minutes against a fixed hour, which is not "every N minutes".
      { minute: '*/15', hour: '2' },
      // Out of range, so misread rather than merely unusual.
      { minute: '61', hour: '2' },
      { minute: '0', hour: '47' },
      { minute: '0', hour: '*/40' },
      { minute: '0', hour: '*/0' },
      // Ranges and names this tool does not decode.
      { minute: '0', hour: '1-5' },
      { minute: '0', hour: 'H' },
      // A month other than every month.
      { month: '3' },
      // A day of the month and a day of the week together, which cron runs on
      // the union of and every plain phrasing reads as the intersection.
      { dom: '1', dow: '1' },
      { dom: '1-5' },
      { dom: '0' },
      { dow: 'weekdays' },
      { dow: '8' },
    ]) {
      expect(await described(shape)).toBeNull();
    }
  });
});
