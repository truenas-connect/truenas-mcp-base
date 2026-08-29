import { describe, expect, it } from 'vitest';
import { fakeSystem } from '@/testing/fake-systems';
import { servicesStatus } from '@/tools/index';

describe('services_status', () => {
  /** A service row as `service.query` reports one. */
  const service = (over: Record<string, unknown> = {}) => ({
    id: 4,
    service: 'cifs',
    enable: true,
    state: 'RUNNING',
    pids: [2451, 2452],
    ...over,
  });

  const listed = async (rows: unknown[]): Promise<Record<string, unknown>[]> => {
    const { ctx } = fakeSystem({ ['service.query']: rows });
    return (await servicesStatus.handler(ctx, {})) as Record<string, unknown>[];
  };

  /** One service, differing only in the fields the case is about. */
  const one = async (over: Record<string, unknown>): Promise<Record<string, unknown>> =>
    (await listed([service(over)]))[0];

  it('maps a service to its name, boot setting and run state', async () => {
    expect(await listed([service()])).toEqual([
      { service: 'cifs', start_on_boot: true, state: 'RUNNING' },
    ]);
  });

  it('reports the middleware name rather than the protocol as a person says it', async () => {
    // The whole reason the description carries the `cifs`/`iscsitarget`
    // examples: a caller matching on "SMB" finds nothing, and a remapping here
    // would be a second vocabulary to keep in step with TrueNAS's own.
    const rows = await listed([
      service({ service: 'cifs' }),
      service({ id: 5, service: 'iscsitarget' }),
      service({ id: 6, service: 'nfs' }),
    ]);
    expect(rows.map((row) => row['service'])).toEqual(['cifs', 'iscsitarget', 'nfs']);
  });

  it('carries no field the tool does not name, including one a later release adds', async () => {
    const rows = await listed([service({ ha_propagate: true })]);
    expect(Object.keys(rows[0])).toEqual(['service', 'start_on_boot', 'state']);
  });

  it('does not report a service\'s process ids', async () => {
    const rows = await listed([service({ pids: [2451, 2452] })]);
    expect(rows[0]).not.toHaveProperty('pids');
    expect(JSON.stringify(rows)).not.toContain('2451');
  });

  it('does not report the middleware row id', async () => {
    const rows = await listed([service({ id: 4 })]);
    expect(rows[0]).not.toHaveProperty('id');
  });

  it('keeps the boot setting and the run state apart', async () => {
    // The mismatch is the finding the tool exists for, so the two fields have
    // to disagree where the system says they disagree rather than being folded
    // into one reading.
    expect(await one({ enable: true, state: 'STOPPED' })).toEqual({
      service: 'cifs',
      start_on_boot: true,
      state: 'STOPPED',
    });
    expect(await one({ enable: false, state: 'RUNNING' })).toEqual({
      service: 'cifs',
      start_on_boot: false,
      state: 'RUNNING',
    });
  });

  it('reports a state outside the known set as the word the system used', async () => {
    // `state` is typed `string` rather than a union, so a release that grows a
    // third word must not have it coerced into one of the two known ones.
    expect(await one({ state: 'STARTING' })).toMatchObject({ state: 'STARTING' });
    expect(await one({ state: 'FAILED' })).toMatchObject({ state: 'FAILED' });
  });

  it('reports a state it could not read as null rather than as stopped', async () => {
    expect(await one({ state: '' })).toMatchObject({ state: null });
    expect(await one({ state: null })).toMatchObject({ state: null });
    expect(await one({ state: 0 })).toMatchObject({ state: null });
  });

  it('reports a boot setting it could not read as null rather than as false', async () => {
    expect(await one({ enable: null })).toMatchObject({ start_on_boot: null });
    expect(await one({ enable: 'true' })).toMatchObject({ start_on_boot: null });
    expect(await one({ enable: 1 })).toMatchObject({ start_on_boot: null });
  });

  it('reports a name it could not read as null, so the row matches no protocol', async () => {
    expect(await one({ service: '' })).toMatchObject({ service: null });
    expect(await one({ service: null })).toMatchObject({ service: null });
    expect(await one({ service: 7 })).toMatchObject({ service: null });
  });

  it('returns nothing for a system that reported no services', async () => {
    expect(await listed([])).toEqual([]);
  });

  it('asks for the services', async () => {
    const { ctx, query } = fakeSystem({ ['service.query']: [] });
    await servicesStatus.handler(ctx, {});
    expect(query).toHaveBeenCalledWith('service.query');
  });
});
