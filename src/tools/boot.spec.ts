import { describe, expect, it } from 'vitest';
import { fakeSystem, failingSystem } from '@/testing/fake-systems';
import { bootPoolStatus } from '@/tools/index';

describe('boot_pool_status', () => {
  /** A `boot.get_state` payload, healthy and complete unless overridden. */
  const state = (over: Record<string, unknown> = {}) => ({
    name: 'boot-pool',
    status: 'ONLINE',
    path: '/',
    scan: { function: 'SCRUB', state: 'FINISHED', errors: 0 },
    expand: null,
    is_upgraded: true,
    healthy: true,
    warning: false,
    status_code: null,
    status_detail: null,
    size: 240_057_409_536,
    allocated: 12_884_901_888,
    free: 227_172_507_648,
    freeing: 0,
    ...over,
  });

  /** One `boot.environment.query` row. */
  const environment = (over: Record<string, unknown> = {}) => ({
    id: '25.10.0',
    dataset: 'boot-pool/ROOT/25.10.0',
    active: true,
    activated: true,
    created: '2026-08-01T10:00:00',
    used_bytes: 3_221_225_472,
    used: '3 GiB',
    keep: false,
    can_activate: true,
    ...over,
  });

  const reported = async (
    poolState: unknown,
    environments: unknown = [environment()],
  ): Promise<Record<string, unknown>> => {
    const { ctx } = fakeSystem({
      ['boot.get_state']: poolState,
      ['boot.environment.query']: environments,
    });
    return (await bootPoolStatus.handler(ctx, {})) as Record<string, unknown>;
  };

  const pool = async (over: Record<string, unknown> = {}) =>
    (await reported(state(over)))['pool'] as Record<string, unknown>;

  const entries = async (rows: unknown) =>
    ((await reported(state(), rows))['environments'] as Record<string, unknown>)[
      'entries'
    ] as Record<string, unknown>[];

  it('is read-only and requires no arguments', () => {
    expect(bootPoolStatus.mutating).toBe(false);
    expect(bootPoolStatus.inputSchema).toEqual({ type: 'object', properties: {} });
  });

  it('reports the boot pool, its health and its space', async () => {
    expect(await pool()).toEqual({
      unavailable: null,
      name: 'boot-pool',
      status: 'ONLINE',
      healthy: true,
      warning: false,
      status_code: null,
      status_detail: null,
      features_current: true,
      size_bytes: 240_057_409_536,
      allocated_bytes: 12_884_901_888,
      free_bytes: 227_172_507_648,
    });
  });

  it('never reports the scan or expansion record, in any form', async () => {
    const section = await pool();
    expect(section['scan']).toBeUndefined();
    expect(section['expand']).toBeUndefined();
    expect(JSON.stringify(section)).not.toContain('SCRUB');
  });

  it('reports healthy and warning independently, so a healthy pool can warn', async () => {
    expect(await pool({ healthy: true, warning: true })).toMatchObject({
      healthy: true,
      warning: true,
    });
  });

  it('reports an unhealthy pool with the code and detail the system gave', async () => {
    expect(
      await pool({
        status: 'DEGRADED',
        healthy: false,
        warning: true,
        status_code: 'FAULTED_DEV',
        status_detail: 'One or more devices has been taken offline.',
      }),
    ).toMatchObject({
      status: 'DEGRADED',
      healthy: false,
      warning: true,
      status_code: 'FAULTED_DEV',
      status_detail: 'One or more devices has been taken offline.',
    });
  });

  it('passes a status it does not recognise through as the system spelled it', async () => {
    expect(await pool({ status: 'SUSPENDED' })).toMatchObject({ status: 'SUSPENDED' });
  });

  it('reports healthy and warning as null where the system reported no boolean', async () => {
    expect(await pool({ healthy: 'yes', warning: null })).toMatchObject({
      healthy: null,
      warning: null,
    });
  });

  it('reports a pool behind on features as false, not as unreported', async () => {
    expect(await pool({ is_upgraded: false })).toMatchObject({ features_current: false });
  });

  it('distinguishes a pool that did not report its upgrade state from one that is behind', async () => {
    // Deleted rather than set to undefined: `is_upgraded` is optional in the
    // payload, and a system that is not on a version that reports it sends no
    // key at all.
    const withoutUpgradeState: Record<string, unknown> = { ...state() };
    delete withoutUpgradeState['is_upgraded'];
    const section = (await reported(withoutUpgradeState))['pool'] as Record<string, unknown>;
    expect(section['features_current']).toBeNull();
    expect(section['features_current']).not.toBe(false);
  });

  it('reports a size the system did not send as null', async () => {
    expect(await pool({ size: null, allocated: 'lots', free: undefined })).toMatchObject({
      size_bytes: null,
      allocated_bytes: null,
      free_bytes: null,
    });
  });

  it('reports the environments, naming which is active and which boots next', async () => {
    expect(await entries([environment(), environment({ id: '25.04.1', active: false, activated: false })]))
      .toEqual([
        {
          name: '25.10.0',
          active: true,
          active_on_reboot: true,
          size_bytes: 3_221_225_472,
          created_at: '2026-08-01T10:00:00',
        },
        {
          name: '25.04.1',
          active: false,
          active_on_reboot: false,
          size_bytes: 3_221_225_472,
          created_at: '2026-08-01T10:00:00',
        },
      ]);
  });

  it('keeps active and active_on_reboot apart on an environment activated but not booted', async () => {
    expect(await entries([environment({ active: false, activated: true })])).toEqual([
      expect.objectContaining({ active: false, active_on_reboot: true }),
    ]);
  });

  it('reports an environment field the system did not send as null', async () => {
    expect(
      await entries([environment({ id: '', active: 1, used_bytes: null, created: null })]),
    ).toEqual([{ name: null, active: null, active_on_reboot: true, size_bytes: null, created_at: null }]);
  });

  it('keeps an entry it cannot read at all, as a row of nulls', async () => {
    expect(await entries([environment(), 'not an environment'])).toEqual([
      expect.objectContaining({ name: '25.10.0' }),
      { name: null, active: null, active_on_reboot: null, size_bytes: null, created_at: null },
    ]);
  });

  it('reports a system holding no boot environments as an empty list, not as unread', async () => {
    const section = (await reported(state(), []))['environments'] as Record<string, unknown>;
    expect(section).toEqual({ unavailable: null, entries: [] });
  });

  it('reports the environments as unread where the system answered with no list', async () => {
    const section = (await reported(state(), { id: '25.10.0' }))['environments'] as Record<
      string,
      unknown
    >;
    expect(section['entries']).toBeNull();
    expect(section['unavailable']).toBe('the system did not answer with a list of boot environments');
  });

  it('reports the pool as unread where the system answered with no pool state', async () => {
    const section = (await reported('boot-pool'))['pool'] as Record<string, unknown>;
    expect(section).toEqual({
      unavailable: 'the system did not answer with a boot pool state',
      name: null,
      status: null,
      healthy: null,
      warning: null,
      status_code: null,
      status_detail: null,
      features_current: null,
      size_bytes: null,
      allocated_bytes: null,
      free_bytes: null,
    });
  });

  it('still answers the environments where the pool read failed', async () => {
    const { ctx } = failingSystem(
      { ['boot.environment.query']: [environment()] },
      { ['boot.get_state']: new Error('boot pool unavailable') },
    );
    const result = (await bootPoolStatus.handler(ctx, {})) as Record<string, unknown>;
    expect(result['pool']).toMatchObject({
      unavailable: 'boot pool unavailable',
      healthy: null,
      status: null,
    });
    expect((result['environments'] as Record<string, unknown>)['entries']).toEqual([
      expect.objectContaining({ name: '25.10.0' }),
    ]);
  });

  it('still answers the pool where the environment read failed', async () => {
    const { ctx } = failingSystem(
      { ['boot.get_state']: state() },
      { ['boot.environment.query']: { reason: 'no such method' } },
    );
    const result = (await bootPoolStatus.handler(ctx, {})) as Record<string, unknown>;
    expect(result['environments']).toEqual({ unavailable: 'no such method', entries: null });
    expect(result['pool']).toMatchObject({ unavailable: null, name: 'boot-pool', healthy: true });
  });

  it('names a failure that carried no text of its own rather than reporting nothing', async () => {
    const { ctx } = failingSystem(
      { ['boot.environment.query']: [] },
      { ['boot.get_state']: {} },
    );
    const result = (await bootPoolStatus.handler(ctx, {})) as Record<string, unknown>;
    expect((result['pool'] as Record<string, unknown>)['unavailable']).toBe(
      'the system reported no reason',
    );
  });
});
