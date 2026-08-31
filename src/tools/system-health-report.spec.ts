import { describe, expect, it } from 'vitest';
import { Role } from '@/interfaces';
import { fakeSystem, failingSystem } from '@/testing/fake-systems';
import { systemHealthReport } from '@/tools/index';

describe('system_health_report', () => {
  /** One leaf of a vdev tree, as `pool.query` nests it under `topology`. */
  function device(over: Record<string, unknown> = {}): Record<string, unknown> {
    return { name: 'sda1', type: 'DISK', status: 'ONLINE', disk: 'sda', children: [], ...over };
  }

  /**
   * One pool as `pool.query` reports it. The same rows feed both
   * `storage_pool_status` and `storage_pool_topology`, which is how the tool
   * itself reads them: two calls of the same verb.
   */
  function pool(over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      name: 'tank',
      status: 'ONLINE',
      healthy: true,
      size: 1000,
      allocated: 100,
      free: 900,
      topology: { data: [device()] },
      ...over,
    };
  }

  /** One alert as `alert.list` reports it. */
  function alert(over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: '1',
      klass: 'ZpoolCapacityWarning',
      level: 'WARNING',
      formatted: 'tank is filling up',
      datetime: { $date: 0 },
      dismissed: false,
      ...over,
    };
  }

  /** An `update.status` payload for a system that is already up to date. */
  function upToDate(): Record<string, unknown> {
    return {
      code: 'NORMAL',
      error: null,
      status: { new_version: null, current_version: { train: 'TN-25.04' } },
    };
  }

  /** Every method the four composed tools read, answering a healthy system. */
  function healthy(over: Partial<Record<string, unknown>> = {}): Partial<Record<string, unknown>> {
    return {
      ['pool.query']: [pool()],
      ['alert.list']: [],
      ['update.status']: upToDate(),
      ['system.version']: 'TrueNAS-25.04.0',
      ...over,
    };
  }

  /** The report, typed loosely: the tool's own contract is an opaque object. */
  type Report = Record<string, Record<string, unknown> & { unavailable: string | null }> & {
    verdict: string;
    reasons: { section: string; severity: string; detail: string }[];
  };

  async function report(responses: Partial<Record<string, unknown>>): Promise<Report> {
    const { ctx } = fakeSystem(responses);
    return (await systemHealthReport.handler(ctx, {})) as Report;
  }

  it('is OK only when every section was read and none of them raised anything', async () => {
    const result = await report(healthy());
    expect(result.verdict).toBe('OK');
    expect(result.reasons).toEqual([]);
    expect(result['pools']).toEqual({
      unavailable: null,
      reported: 1,
      entries: [
        {
          name: 'tank',
          status: 'ONLINE',
          healthy: true,
          size_bytes: 1000,
          allocated_bytes: 100,
          used_percent: 10,
        },
      ],
      truncated: false,
    });
    expect(result['alerts']).toEqual({
      unavailable: null,
      total: 0,
      by_level: [],
      most_severe: [],
      truncated: false,
    });
    expect(result['disks']).toEqual({
      unavailable: null,
      total: 1,
      healthy: 1,
      unhealthy: 0,
      unranked: 0,
      worst: [],
      truncated: false,
    });
    expect(result['updates']).toEqual({
      unavailable: null,
      update_available: false,
      current_version: 'TrueNAS-25.04.0',
      new_version: null,
      check_error: null,
      version_error: null,
    });
  });

  it('raises nothing for a pool still on an older set of ZFS feature flags', async () => {
    // `storage_pool_status` reports `feature_flags_current`, and this report
    // neither carries it nor scores it. That is a decision rather than an
    // omission: the verdict here is about HEALTH, and a pool that has not been
    // upgraded is a NOTICE-level configuration fact — it keeps working, and
    // upgrading it is one-way. #46's rule is to summarise by dropping fields
    // and never by re-judging them, so the field stops at the composed tool.
    const result = await report(healthy({ ['pool.query']: [pool({ is_upgraded: false })] }));
    expect(result.verdict).toBe('OK');
    expect(result.reasons).toEqual([]);
    // Asserted as the exact key list rather than as an absence. Nothing can
    // arrive here on its own — `poolEntries` names its six fields by hand,
    // which is #44's guard and is what kept the new field out without a line
    // changing there — so what this pins is the DECISION: an edit that added
    // the field to the composite would have to fail a test to land.
    expect(Object.keys((result['pools']['entries'] as object[])[0])).toEqual([
      'name',
      'status',
      'healthy',
      'size_bytes',
      'allocated_bytes',
      'used_percent',
    ]);
  });

  it('states how full a pool is to one decimal place', async () => {
    const result = await report(
      healthy({ ['pool.query']: [pool({ size: 3000, allocated: 1000 })] }),
    );
    expect(result['pools']['entries']).toEqual([
      expect.objectContaining({ used_percent: 33.3 }),
    ]);
  });

  it('is CRITICAL for an unhealthy pool, naming the status the system gave', async () => {
    const result = await report(
      healthy({ ['pool.query']: [pool({ healthy: false, status: 'DEGRADED' })] }),
    );
    expect(result.verdict).toBe('CRITICAL');
    expect(result.reasons).toContainEqual({
      section: 'pools',
      severity: 'critical',
      detail: 'pool tank is not healthy; the system reports its status as DEGRADED',
    });
  });

  it('names an unhealthy pool that reported no status, and one with no name', async () => {
    const result = await report(
      healthy({
        ['pool.query']: [pool({ name: null, healthy: false, status: null, topology: null })],
      }),
    );
    expect(result.reasons).toContainEqual({
      section: 'pools',
      severity: 'critical',
      detail:
        'pool a pool the system did not name is not healthy; the system reports its status as nothing this report could read',
    });
  });

  it('warns at 80% full and is critical at 90%', async () => {
    const warned = await report(
      healthy({ ['pool.query']: [pool({ size: 100, allocated: 85 })] }),
    );
    expect(warned.verdict).toBe('WARNING');
    expect(warned.reasons).toEqual([
      { section: 'pools', severity: 'warning', detail: 'pool tank is 85% full' },
    ]);

    const critical = await report(
      healthy({ ['pool.query']: [pool({ size: 100, allocated: 95 })] }),
    );
    expect(critical.verdict).toBe('CRITICAL');
    expect(critical.reasons).toEqual([
      { section: 'pools', severity: 'critical', detail: 'pool tank is 95% full' },
    ]);
  });

  it('does not establish capacity for a pool whose size it could not read', async () => {
    const result = await report(healthy({ ['pool.query']: [pool({ size: 'lots' })] }));
    expect(result.verdict).toBe('UNKNOWN');
    expect(result['pools']['entries']).toEqual([
      expect.objectContaining({ size_bytes: null, used_percent: null }),
    ]);
    expect(result.reasons).toEqual([
      {
        section: 'pools',
        severity: 'unknown',
        detail:
          'pool tank reported no size and allocation this report could read, so how full it is is not established',
      },
    ]);
  });

  it('does not establish capacity for a pool of no size, rather than reading it as empty', async () => {
    const result = await report(healthy({ ['pool.query']: [pool({ size: 0, allocated: 0 })] }));
    expect(result['pools']['entries']).toEqual([
      expect.objectContaining({ size_bytes: 0, used_percent: null }),
    ]);
    expect(result.verdict).toBe('UNKNOWN');
  });

  it('does not establish health for a pool that did not say whether it is healthy', async () => {
    const result = await report(healthy({ ['pool.query']: [pool({ healthy: 'yes' })] }));
    expect(result.verdict).toBe('UNKNOWN');
    expect(result.reasons).toContainEqual({
      section: 'pools',
      severity: 'unknown',
      detail: 'pool tank did not report whether it is healthy',
    });
  });

  it('counts alerts per level over all of them, most severe first', async () => {
    const result = await report(
      healthy({
        ['alert.list']: [
          alert({ level: 'INFO' }),
          alert({ level: 'CRITICAL' }),
          alert({ level: 'WARNING' }),
          alert({ level: 'CRITICAL' }),
        ],
      }),
    );
    expect(result['alerts']['total']).toBe(4);
    expect(result['alerts']['by_level']).toEqual([
      { level: 'CRITICAL', count: 2 },
      { level: 'WARNING', count: 1 },
      { level: 'INFO', count: 1 },
    ]);
  });

  it('ranks ERROR and above as critical, WARNING as a warning, and INFO and NOTICE as neither', async () => {
    const result = await report(
      healthy({
        ['alert.list']: [
          alert({ level: 'ERROR' }),
          alert({ level: 'WARNING' }),
          alert({ level: 'NOTICE' }),
          alert({ level: 'INFO' }),
        ],
      }),
    );
    expect(result.verdict).toBe('CRITICAL');
    expect(result.reasons).toEqual([
      { section: 'alerts', severity: 'critical', detail: 'the system has raised 1 ERROR alert' },
      { section: 'alerts', severity: 'warning', detail: 'the system has raised 1 WARNING alert' },
    ]);
  });

  it('counts more than one alert at a level in English', async () => {
    const result = await report(
      healthy({ ['alert.list']: [alert({ level: 'EMERGENCY' }), alert({ level: 'EMERGENCY' })] }),
    );
    expect(result.reasons).toEqual([
      {
        section: 'alerts',
        severity: 'critical',
        detail: 'the system has raised 2 EMERGENCY alerts',
      },
    ]);
  });

  it('reports an alert level it does not rank at unknown rather than ignoring it', async () => {
    const result = await report(healthy({ ['alert.list']: [alert({ level: 'SPICY' })] }));
    expect(result.verdict).toBe('UNKNOWN');
    expect(result.reasons).toEqual([
      {
        section: 'alerts',
        severity: 'unknown',
        detail: 'the system has raised 1 alert at SPICY, a severity this report does not rank',
      },
    ]);
  });

  it('reports an alert whose level the system did not name', async () => {
    const result = await report(healthy({ ['alert.list']: [alert({ level: null })] }));
    expect(result['alerts']['by_level']).toEqual([{ level: null, count: 1 }]);
    expect(result.reasons).toEqual([
      {
        section: 'alerts',
        severity: 'unknown',
        detail:
          'the system has raised 1 alert at a severity the system did not name, a severity this report does not rank',
      },
    ]);
  });

  it('orders equally severe levels by name, so two calls answer alike', async () => {
    const result = await report(
      healthy({
        ['alert.list']: [
          alert({ level: 'ZED' }),
          alert({ level: null }),
          alert({ level: 'ABLE' }),
        ],
      }),
    );
    expect(result['alerts']['by_level']).toEqual([
      { level: null, count: 1 },
      { level: 'ABLE', count: 1 },
      { level: 'ZED', count: 1 },
    ]);
  });

  it('lists the worst alerts first and caps the list while counting every one', async () => {
    const alerts = [
      ...Array.from({ length: 11 }, () => alert({ level: 'INFO', klass: 'Info' })),
      alert({ level: 'EMERGENCY', klass: 'Fire' }),
    ];
    const result = await report(healthy({ ['alert.list']: alerts }));
    expect(result['alerts']['total']).toBe(12);
    expect(result['alerts']['truncated']).toBe(true);
    const listed = result['alerts']['most_severe'] as { klass: string }[];
    expect(listed).toHaveLength(10);
    expect(listed[0]).toEqual({
      level: 'EMERGENCY',
      klass: 'Fire',
      formatted: 'tank is filling up',
      dismissed: false,
    });
    // The finding survives the cap even when its alert does not: the eleven
    // INFO alerts are counted in full and the one EMERGENCY still reasons.
    expect(result['alerts']['by_level']).toEqual([
      { level: 'EMERGENCY', count: 1 },
      { level: 'INFO', count: 11 },
    ]);
  });

  it('counts leaf devices only, so one failed disk is not two problems', async () => {
    const result = await report(
      healthy({
        ['pool.query']: [
          pool({
            healthy: false,
            status: 'DEGRADED',
            topology: {
              data: [
                {
                  name: 'mirror-0',
                  type: 'MIRROR',
                  status: 'DEGRADED',
                  disk: null,
                  children: [device(), device({ name: 'sdb1', status: 'FAULTED', disk: 'sdb' })],
                },
              ],
            },
          }),
        ],
      }),
    );
    expect(result['disks']).toEqual({
      unavailable: null,
      total: 2,
      healthy: 1,
      unhealthy: 1,
      unranked: 0,
      worst: [{ pool: 'tank', name: 'sdb1', disk: 'sdb', status: 'FAULTED' }],
      truncated: false,
    });
    expect(result.reasons).toContainEqual({
      section: 'disks',
      severity: 'critical',
      detail: 'ZFS reports 1 device beneath the pools in a state it treats as a failure',
    });
  });

  it('treats AVAIL and INUSE as healthy on a spare and nowhere else', async () => {
    const result = await report(
      healthy({
        ['pool.query']: [
          pool({
            topology: {
              spare: [
                device({ name: 'sdy', status: 'AVAIL', disk: 'sdy' }),
                device({ name: 'sdz', status: 'INUSE', disk: 'sdz' }),
              ],
              data: [device({ name: 'sdc1', status: 'AVAIL', disk: 'sdc' })],
            },
          }),
        ],
      }),
    );
    expect(result['disks']).toEqual(
      expect.objectContaining({ total: 3, healthy: 2, unhealthy: 0, unranked: 1 }),
    );
    expect(result['disks']['worst']).toEqual([
      { pool: 'tank', name: 'sdc1', disk: 'sdc', status: 'AVAIL' },
    ]);
  });

  it('reports a device state it does not rank as unranked rather than as healthy', async () => {
    const result = await report(
      healthy({ ['pool.query']: [pool({ topology: { data: [device({ status: 'SPICY' })] } })] }),
    );
    expect(result.verdict).toBe('UNKNOWN');
    expect(result.reasons).toContainEqual({
      section: 'disks',
      severity: 'unknown',
      detail: '1 device beneath the pools reported a state this report does not rank',
    });
  });

  it('reports a device the system reported no state for', async () => {
    const result = await report(
      healthy({ ['pool.query']: [pool({ topology: { data: [device({ status: null })] } })] }),
    );
    expect(result['disks']['worst']).toEqual([
      { pool: 'tank', name: 'sda1', disk: 'sda', status: null },
    ]);
  });

  it('reports a device it can no longer resolve to a disk, by its place in the tree', async () => {
    const result = await report(
      healthy({
        ['pool.query']: [
          pool({ topology: { data: [device({ status: 'REMOVED', disk: null })] } }),
        ],
      }),
    );
    expect(result['disks']['worst']).toEqual([
      { pool: 'tank', name: 'sda1', disk: null, status: 'REMOVED' },
    ]);
  });

  it('counts every failed device while capping the list that names them', async () => {
    const result = await report(
      healthy({
        ['pool.query']: [
          pool({
            topology: {
              data: Array.from({ length: 12 }, (_unused, index) =>
                device({ name: `sd${index}`, status: 'FAULTED', disk: `sd${index}` }),
              ),
            },
          }),
        ],
      }),
    );
    expect(result['disks']).toEqual(
      expect.objectContaining({ total: 12, unhealthy: 12, truncated: true }),
    );
    expect(result['disks']['worst']).toHaveLength(10);
    expect(result.reasons).toContainEqual({
      section: 'disks',
      severity: 'critical',
      detail: 'ZFS reports 12 devices beneath the pools in a state it treats as a failure',
    });
  });

  it('counts every pool while capping the list that names them', async () => {
    const pools = Array.from({ length: 12 }, (_unused, index) => pool({ name: `tank${index}` }));
    const result = await report(healthy({ ['pool.query']: pools }));
    expect(result['pools']['reported']).toBe(12);
    expect(result['pools']['entries']).toHaveLength(10);
    expect(result['pools']['truncated']).toBe(true);
  });

  it('reports an available update without moving the verdict', async () => {
    const result = await report(
      healthy({
        ['update.status']: {
          code: 'NORMAL',
          error: null,
          status: {
            new_version: { version: '25.04.1' },
            current_version: { train: 'TN-25.04' },
          },
        },
      }),
    );
    expect(result.verdict).toBe('OK');
    expect(result.reasons).toEqual([]);
    expect(result['updates']).toEqual({
      unavailable: null,
      update_available: true,
      current_version: 'TrueNAS-25.04.0',
      new_version: '25.04.1',
      check_error: null,
      version_error: null,
    });
  });

  it('is UNKNOWN when the running version could not be read, though the check worked', async () => {
    // `system_update_status` reads the version separately from the check, so
    // this system answers one and not the other. Without a reason of its own
    // the null `current_version` would sit in an OK report saying nothing.
    const { ctx } = failingSystem(healthy(), {
      ['system.version']: new Error('the system did not answer'),
    });
    const result = (await systemHealthReport.handler(ctx, {})) as Report;
    expect(result.verdict).toBe('UNKNOWN');
    expect(result['updates']).toEqual({
      unavailable: null,
      update_available: false,
      current_version: null,
      new_version: null,
      check_error: null,
      version_error: 'the system did not answer',
    });
    expect(result.reasons).toEqual([
      {
        section: 'updates',
        severity: 'unknown',
        detail:
          'the running version could not be read, so what this system is on is not established: the system did not answer',
      },
    ]);
  });

  it('names both update failures when neither read answered', async () => {
    const { ctx } = failingSystem(
      {
        ...healthy(),
        ['update.status']: { code: 'ERROR', error: { reason: 'no route to host' }, status: null },
      },
      { ['system.version']: new Error('the system did not answer') },
    );
    const result = (await systemHealthReport.handler(ctx, {})) as Report;
    expect(result.reasons.map((reason) => reason.detail)).toEqual([
      'the update check did not complete, so whether this system is up to date is not established: no route to host',
      'the running version could not be read, so what this system is on is not established: the system did not answer',
    ]);
  });

  it('is UNKNOWN when the update check did not complete, naming what the system said', async () => {
    const result = await report(
      healthy({
        ['update.status']: {
          code: 'ERROR',
          error: { reason: 'the update server could not be reached', errname: 'ENETUNREACH' },
          status: null,
        },
      }),
    );
    expect(result.verdict).toBe('UNKNOWN');
    expect(result['updates']).toEqual(
      expect.objectContaining({
        update_available: null,
        check_error: 'the update server could not be reached',
      }),
    );
    expect(result.reasons).toEqual([
      {
        section: 'updates',
        severity: 'unknown',
        detail:
          'the update check did not complete, so whether this system is up to date is not established: the update server could not be reached',
      },
    ]);
  });

  it('marks the sections a failed read took out, and still reports the rest', async () => {
    const { ctx } = failingSystem(healthy(), {
      ['pool.query']: new Error('the middleware is not listening'),
    });
    const result = (await systemHealthReport.handler(ctx, {})) as Report;
    expect(result.verdict).toBe('UNKNOWN');
    // One read, and both sections that stand on it say so independently.
    expect(result['pools']).toEqual({
      unavailable: 'the middleware is not listening',
      reported: null,
      entries: null,
      truncated: null,
    });
    expect(result['disks']).toEqual({
      unavailable: 'the middleware is not listening',
      total: null,
      healthy: null,
      unhealthy: null,
      unranked: null,
      worst: null,
      truncated: null,
    });
    expect(result.reasons).toEqual([
      {
        section: 'pools',
        severity: 'unknown',
        detail:
          'the pools section could not be read, so nothing about it is established: the middleware is not listening',
      },
      {
        section: 'disks',
        severity: 'unknown',
        detail:
          'the disks section could not be read, so nothing about it is established: the middleware is not listening',
      },
    ]);
    // The sections that did not depend on it are unaffected.
    expect(result['alerts']['unavailable']).toBeNull();
    expect(result['updates']['update_available']).toBe(false);
  });

  it('does not reject when every read failed, and says so section by section', async () => {
    const { ctx } = failingSystem(
      {},
      {
        ['pool.query']: new Error('pools are gone'),
        ['alert.list']: 'alerts are gone',
        ['update.status']: { reason: 'updates are gone' },
      },
    );
    const result = (await systemHealthReport.handler(ctx, {})) as Report;
    expect(result.verdict).toBe('UNKNOWN');
    expect(result['pools']['unavailable']).toBe('pools are gone');
    expect(result['alerts']['unavailable']).toBe('alerts are gone');
    expect(result['disks']['unavailable']).toBe('pools are gone');
    expect(result['updates']['unavailable']).toBe('updates are gone');
    expect(result.reasons).toHaveLength(4);
  });

  it('keeps a CRITICAL verdict while still naming the parts it could not read', async () => {
    const { ctx } = failingSystem(
      { ...healthy(), ['pool.query']: [pool({ healthy: false, status: 'FAULTED' })] },
      { ['alert.list']: new Error('alerts are gone') },
    );
    const result = (await systemHealthReport.handler(ctx, {})) as Report;
    expect(result.verdict).toBe('CRITICAL');
    expect(result.reasons.map((reason) => reason.severity)).toEqual(['critical', 'unknown']);
  });

  it('states a failure the transport gave no words for', async () => {
    const { ctx } = failingSystem(healthy(), { ['alert.list']: 42 });
    const result = (await systemHealthReport.handler(ctx, {})) as Report;
    expect(result['alerts']['unavailable']).toBe('the system reported no reason');
  });

  it('stays small enough to be read in full on a system of ordinary size', async () => {
    // Two pools of twelve disks each, one of them degraded with a failed
    // member, and a dozen alerts — a system with plenty to say. The report is a
    // fixed shape plus three capped lists, so this is close to its ceiling.
    const bay = (prefix: string, status: string) =>
      Array.from({ length: 12 }, (_unused, index) => ({
        name: `${prefix}-${index}`,
        type: 'DISK',
        status: index === 0 ? status : 'ONLINE',
        disk: `${prefix}${index}`,
        children: [],
      }));
    const result = await report(
      healthy({
        ['pool.query']: [
          pool({ name: 'tank', size: 1e12, allocated: 9.2e11, topology: { data: bay('a', 'FAULTED') } }),
          pool({ name: 'vault', size: 4e12, allocated: 1e12, topology: { data: bay('b', 'ONLINE') } }),
        ],
        ['alert.list']: Array.from({ length: 12 }, (_unused, index) =>
          alert({
            level: index % 2 === 0 ? 'WARNING' : 'CRITICAL',
            klass: 'ZpoolCapacityWarning',
            formatted: `Pool tank is consuming 92% of its capacity (alert ${index})`,
          }),
        ),
      }),
    );
    expect(result.verdict).toBe('CRITICAL');
    // A ceiling, not a measurement: it fails if a later change makes the report
    // materially larger, which is the property the ticket asks for.
    expect(JSON.stringify(result).length).toBeLessThan(4096);
  });

  it('is read-only and takes no arguments', () => {
    expect(systemHealthReport.mutating).toBe(false);
    expect(systemHealthReport.requiredRole).toBe(Role.ReadOnly);
    expect(systemHealthReport.inputSchema).toEqual({ type: 'object', properties: {} });
  });
});
