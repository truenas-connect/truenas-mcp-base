import { describe, expect, it, vi } from 'vitest';
import { of, throwError } from 'rxjs';
import { SystemHandle, ToolContext } from '@/catalog/tool';
import { reportingAppVmUsage } from '@/tools/index';

describe('reporting_app_vm_usage', () => {
  /**
   * An app as `app.query` reports one. `config` is the install-time form the
   * user filled in and routinely holds a credential; it is on the fixture so
   * that the test that it does not survive the mapping is worth something.
   */
  const app = (over: Record<string, unknown> = {}) => ({
    id: 'plex',
    name: 'plex',
    state: 'RUNNING',
    version: '1.2.3',
    active_workloads: { containers: 1 },
    config: { plex_claim_token: 'SECRET-CLAIM-TOKEN' },
    ...over,
  });

  /** A libvirt-backed VM as `vm.query` reports one: the state nested in `status`. */
  const vm = (over: Record<string, unknown> = {}) => ({
    id: 1,
    name: 'buildbox',
    memory: 4096,
    autostart: true,
    status: { state: 'RUNNING', pid: 1234, domain_state: 'RUNNING' },
    devices: [{ dtype: 'DISK', attributes: { path: '/dev/zvol/tank/buildbox' } }],
    ...over,
  });

  /** An incus-backed VM as `virt.instance.query` reports one: one flat status word. */
  const instance = (over: Record<string, unknown> = {}) => ({
    id: 'web',
    name: 'web',
    type: 'VM',
    status: 'RUNNING',
    cpu: '4',
    memory: 8589934592,
    environment: { API_TOKEN: 'SECRET-GUEST-TOKEN' },
    ...over,
  });

  interface Entry {
    kind: string;
    source: string;
    id: string | number | null;
    name: string | null;
    state: string | null;
    cpu_percent: number | null;
    cpu_unavailable: string | null;
    memory_used_bytes: number | null;
    memory_unavailable: string | null;
  }

  interface Report {
    entries: Entry[];
    failures: { source: string; error: string }[];
  }

  interface Fake {
    ctx: ToolContext;
    call: ReturnType<typeof vi.fn>;
    query: ReturnType<typeof vi.fn>;
  }

  interface Options {
    apps?: unknown[];
    vms?: unknown[];
    instances?: unknown[];
    /** What `vm.get_memory_usage` answers, per VM id. */
    memory?: Record<number, unknown>;
    /** Keyed by method, or by `vm.get_memory_usage:<id>` for one VM's read. */
    failures?: Record<string, unknown>;
  }

  /**
   * A SystemHandle answering per listing, and per VM ID for the memory read —
   * which neither `fakeSystem` nor `failingSystem` can do: they key on the
   * method alone, and every VM's memory comes back from the same method
   * distinguished only by the id asked for.
   */
  const usageSystem = (options: Options = {}): Fake => {
    const failures = options.failures ?? {};
    const memory = options.memory ?? { 1: 2147483648 };
    const listings: Record<string, unknown> = {
      ['app.query']: options.apps ?? [app()],
      ['vm.query']: options.vms ?? [vm()],
      ['virt.instance.query']: options.instances ?? [instance()],
    };
    const query = vi.fn((method: string) =>
      method in failures ? throwError(() => failures[method]) : of(listings[method]),
    );
    // The client takes a call's parameters as one tuple, so the id arrives
    // wrapped: `call('vm.get_memory_usage', [1])`.
    const call = vi.fn((method: string, params: [number]) => {
      const key = `${method}:${params[0]}`;
      return key in failures ? throwError(() => failures[key]) : of(memory[params[0]]);
    });
    const system = { name: 'nas', client: { api: { call, query } } } as unknown as SystemHandle;
    return { ctx: { system }, call, query };
  };

  const reported = async (fake: Fake): Promise<Report> =>
    (await reportingAppVmUsage.handler(fake.ctx, {})) as Report;

  /** The entries a system of these listings reports. */
  const entries = async (options: Options = {}): Promise<Entry[]> =>
    (await reported(usageSystem(options))).entries;

  /** The one entry a system holding a single workload of that kind reports. */
  const oneApp = async (over: Record<string, unknown>): Promise<Entry> =>
    (await entries({ apps: [app(over)], vms: [], instances: [] }))[0];

  const oneVm = async (
    over: Record<string, unknown>,
    memory?: Record<number, unknown>,
  ): Promise<Entry> => (await entries({ apps: [], vms: [vm(over)], instances: [], memory }))[0];

  const oneInstance = async (over: Record<string, unknown>): Promise<Entry> =>
    (await entries({ apps: [], vms: [], instances: [instance(over)] }))[0];

  it('reports every app and virtual machine in one list, each tagged with its kind', async () => {
    expect(await reported(usageSystem())).toEqual({
      entries: [
        {
          kind: 'app',
          source: 'app',
          id: 'plex',
          name: 'plex',
          state: 'RUNNING',
          cpu_percent: null,
          cpu_unavailable: expect.stringContaining('subscription'),
          memory_used_bytes: null,
          memory_unavailable: expect.stringContaining('subscription'),
        },
        {
          kind: 'vm',
          source: 'vm',
          id: 1,
          name: 'buildbox',
          state: 'RUNNING',
          cpu_percent: null,
          cpu_unavailable: expect.stringContaining('no per-virtual-machine CPU'),
          memory_used_bytes: 2147483648,
          memory_unavailable: null,
        },
        {
          kind: 'vm',
          source: 'virt_instance',
          id: 'web',
          name: 'web',
          state: 'RUNNING',
          cpu_percent: null,
          cpu_unavailable: expect.stringContaining('no per-virtual-machine CPU'),
          memory_used_bytes: null,
          memory_unavailable: expect.stringContaining('incus-backed'),
        },
      ],
      failures: [],
    });
  });

  it('asks the app listing for the three fields it reports, and nothing else', async () => {
    // Neither figure this tool reports is readable from an app row, so an app
    // contributes an identifier, a name and a state and nothing more — while
    // the row it comes from is the bulkiest in the catalog. The other two
    // listings are unprojected: a VM row's `status` and `devices` are read, and
    // narrowing them is not this ticket's subject.
    const fake = usageSystem();
    await reported(fake);
    expect(fake.query.mock.calls).toContainEqual([
      'app.query',
      [],
      { select: ['id', 'name', 'state'] },
    ]);
  });

  it('reads an app row carrying none of the projected fields as nulls, not as absent keys', async () => {
    // A projection honoured against a release that does not carry one of the
    // names — dropped or renamed since — arrives as a row without the key.
    // The entry still has to answer with every field the description promises.
    const [entry] = await entries({ apps: [{}], vms: [], instances: [] });
    expect(entry).toEqual({
      kind: 'app',
      source: 'app',
      id: null,
      name: null,
      state: null,
      cpu_percent: null,
      cpu_unavailable: expect.stringContaining('subscription'),
      memory_used_bytes: null,
      memory_unavailable: expect.stringContaining('subscription'),
    });
  });

  it('reads a running libvirt VM by its own id, so two VMs do not share one figure', async () => {
    const fake = usageSystem({
      apps: [],
      instances: [],
      vms: [vm(), vm({ id: 2, name: 'mailer' })],
      memory: { 1: 2147483648, 2: 536870912 },
    });
    expect((await reported(fake)).entries.map((entry) => entry.memory_used_bytes)).toEqual([
      2147483648, 536870912,
    ]);
    expect(fake.call.mock.calls).toEqual([
      ['vm.get_memory_usage', [1]],
      ['vm.get_memory_usage', [2]],
    ]);
  });

  it('reports a stopped VM as stopped rather than as consuming nothing', async () => {
    const fake = usageSystem({
      apps: [],
      instances: [],
      vms: [vm({ status: { state: 'STOPPED', domain_state: 'SHUTOFF' } })],
    });
    const [entry] = (await reported(fake)).entries;
    expect(entry.state).toBe('STOPPED');
    expect(entry.memory_used_bytes).toBeNull();
    expect(entry.memory_unavailable).toMatch(/not RUNNING/);
    expect(entry.memory_unavailable).toMatch(/stopped machine is consuming none/);
    // Nothing is asked about a VM that is not running: the call would fail on a
    // domain that does not exist, and that error text would be a worse answer
    // than the reason there is no figure.
    expect(fake.call).not.toHaveBeenCalled();
  });

  it('reports the reason the system gave when a memory read fails', async () => {
    const [entry] = await entries({
      apps: [],
      instances: [],
      failures: { ['vm.get_memory_usage:1']: { reason: 'domain not found' } },
    });
    expect(entry.memory_used_bytes).toBeNull();
    expect(entry.memory_unavailable).toBe('domain not found');
  });

  it('reports no figure where the system answered with something that is not one', async () => {
    const entry = await oneVm({}, { 1: 'a lot' });
    expect(entry.memory_used_bytes).toBeNull();
    expect(entry.memory_unavailable).toMatch(/no memory figure/);
  });

  it('reports no figure, and asks nothing, where a VM has no identifier to ask by', async () => {
    const fake = usageSystem({ apps: [], instances: [], vms: [vm({ id: null })] });
    const [entry] = (await reported(fake)).entries;
    expect(entry.id).toBeNull();
    expect(entry.memory_unavailable).toMatch(/no identifier/);
    expect(fake.call).not.toHaveBeenCalled();
  });

  it('reports a state it could not read as null rather than as a state', async () => {
    expect(await oneApp({ state: 42 })).toMatchObject({ state: null });
    // A row whose `status` is not a record at all: the type declares it present
    // and non-null, and a system that sent neither must answer null.
    expect(await oneVm({ status: null })).toMatchObject({ state: null });
    expect(await oneInstance({ status: '' })).toMatchObject({ state: null });
  });

  it('does not report a VM whose state it could not read as one that is stopped', async () => {
    const fake = usageSystem({ apps: [], instances: [], vms: [vm({ status: null })] });
    const [entry] = (await reported(fake)).entries;
    expect(entry.memory_unavailable).toMatch(/reported no state/);
    // An unreadable state is not evidence the machine is stopped, so nothing
    // here may say it is consuming nothing.
    expect(entry.memory_unavailable).not.toMatch(/consuming none/);
    expect(fake.call).not.toHaveBeenCalled();
  });

  it('does not claim a suspended VM is consuming nothing', async () => {
    const entry = await oneVm({ status: { state: 'SUSPENDED', domain_state: 'PAUSED' } });
    expect(entry.state).toBe('SUSPENDED');
    expect(entry.memory_used_bytes).toBeNull();
    // The marker is the same one a stopped machine carries, and it states both
    // readings rather than asserting the wrong one: `state` says which this is.
    expect(entry.memory_unavailable).toMatch(/suspended one may still be holding/);
  });

  it('excludes incus containers even where the middleware kept them', async () => {
    const fake = usageSystem({
      apps: [],
      vms: [],
      instances: [instance(), instance({ id: 'dns', name: 'dns', type: 'CONTAINER' })],
    });
    expect((await reported(fake)).entries.map((entry) => entry.id)).toEqual(['web']);
    // The filter is asked of the middleware too; an unrecognised one is dropped
    // rather than refused, which is what the re-check above is for.
    expect(fake.query).toHaveBeenCalledWith('virt.instance.query', [['type', '=', 'VM']]);
  });

  it('surfaces neither the install-time config nor a field a later release adds', async () => {
    const report = await reported(
      usageSystem({
        apps: [app({ future_field: 'added by a later TrueNAS release' })],
        vms: [vm({ future_field: 'added by a later TrueNAS release' })],
        instances: [instance({ future_field: 'added by a later TrueNAS release' })],
      }),
    );
    expect(JSON.stringify(report)).not.toMatch(/SECRET|future_field/);
    expect(Object.keys(report.entries[0])).toEqual([
      'kind',
      'source',
      'id',
      'name',
      'state',
      'cpu_percent',
      'cpu_unavailable',
      'memory_used_bytes',
      'memory_unavailable',
    ]);
  });

  it('reports the listings that answered when another one fails', async () => {
    const report = await reported(
      usageSystem({ failures: { ['app.query']: new Error('apps are not installed') } }),
    );
    expect(report.entries.map((entry) => entry.source)).toEqual(['vm', 'virt_instance']);
    expect(report.failures).toEqual([{ source: 'app', error: 'apps are not installed' }]);
  });

  it('names every listing that failed rather than reporting an empty system', async () => {
    const report = await reported(
      usageSystem({
        failures: {
          ['app.query']: 'apps unavailable',
          ['vm.query']: 'vm stack absent',
          ['virt.instance.query']: 'virt stack absent',
        },
      }),
    );
    expect(report.entries).toEqual([]);
    expect(report.failures).toEqual([
      { source: 'app', error: 'apps unavailable' },
      { source: 'vm', error: 'vm stack absent' },
      { source: 'virt_instance', error: 'virt stack absent' },
    ]);
  });

  it('reports a system running nothing as empty, with nothing to explain', async () => {
    expect(await reported(usageSystem({ apps: [], vms: [], instances: [] }))).toEqual({
      entries: [],
      failures: [],
    });
  });
});
