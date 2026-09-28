import { describe, expect, it, vi } from 'vitest';
import { of, throwError } from 'rxjs';
import { FileContentError } from '@/content/file-content';
import { Role } from '@/interfaces';
import type { FileTail } from '@/interfaces';
import type { PlanStep, SystemHandle, ToolContext } from '@/catalog/tool';
import { fakeSystem, failingSystem } from '@/testing/fake-systems';
import { vmClone, vmDevices, vmLogs, vmsList } from '@/tools/index';

describe('vms_list', () => {
  /**
   * A libvirt-backed VM as `vm.query` reports one: memory in MiB, the vCPU
   * allocation split across three fields, and the state nested in `status`
   * beside libvirt's own.
   *
   * The devices are on the fixture because they are the bulk of a real row and
   * the allowlist is what keeps them out.
   */
  const vm = (over: Record<string, unknown> = {}) => ({
    id: 1,
    name: 'buildbox',
    vcpus: 1,
    cores: 2,
    threads: 2,
    memory: 4096,
    min_memory: null,
    autostart: true,
    status: { state: 'RUNNING', pid: 1234, domain_state: 'RUNNING' },
    devices: [{ dtype: 'DISK', attributes: { path: '/dev/zvol/tank/buildbox' } }],
    ...over,
  });

  /**
   * An incus-backed VM as `virt.instance.query` reports one: memory already in
   * bytes, the CPU allocation a single string, and one flat status word.
   *
   * `environment` carries real-looking material for the reason the alert
   * destination fixture does — the test that it does not survive the mapping is
   * only worth anything if some was there to survive.
   */
  const instance = (over: Record<string, unknown> = {}) => ({
    id: 'web',
    name: 'web',
    type: 'VM',
    status: 'STOPPED',
    cpu: '4',
    memory: 8589934592,
    autostart: false,
    environment: { API_TOKEN: 'SECRET-GUEST-TOKEN' },
    raw: { config: { 'limits.memory': '8GiB' } },
    aliases: [],
    image: { os: 'Debian' },
    ...over,
  });

  const read = async (
    vms: unknown[] = [vm()],
    instances: unknown[] = [instance()],
  ): Promise<Record<string, unknown>> => {
    const { ctx } = fakeSystem({ ['vm.query']: vms, ['virt.instance.query']: instances });
    return (await vmsList.handler(ctx, {})) as Record<string, unknown>;
  };

  const rows = async (vms?: unknown[], instances?: unknown[]): Promise<Record<string, unknown>[]> =>
    (await read(vms, instances))['vms'] as Record<string, unknown>[];

  /** One libvirt VM, differing only in the fields the case is about. */
  const oneVm = async (over: Record<string, unknown>): Promise<Record<string, unknown>> =>
    (await rows([vm(over)], []))[0];

  /** One incus VM, the same way. */
  const oneInstance = async (over: Record<string, unknown>): Promise<Record<string, unknown>> =>
    (await rows([], [instance(over)]))[0];

  /** The same two reads, with one of them rejecting instead. */
  const readFailing = async (
    failures: Record<string, unknown>,
  ): Promise<Record<string, unknown>> => {
    const { ctx } = failingSystem(
      { ['vm.query']: [vm()], ['virt.instance.query']: [instance()] },
      failures,
    );
    return (await vmsList.handler(ctx, {})) as Record<string, unknown>;
  };

  it('reports a VM from each stack, tagged with the stack it came from', async () => {
    expect(await read()).toEqual({
      vms: [
        {
          source: 'vm',
          id: 1,
          name: 'buildbox',
          state: 'RUNNING',
          domain_state: 'RUNNING',
          vcpus: 4,
          cpu_set: null,
          memory_bytes: 4294967296,
          min_memory_bytes: null,
          autostart: true,
        },
        {
          source: 'virt_instance',
          id: 'web',
          name: 'web',
          state: 'STOPPED',
          domain_state: null,
          vcpus: 4,
          cpu_set: null,
          memory_bytes: 8589934592,
          min_memory_bytes: null,
          autostart: false,
        },
      ],
      failures: [],
    });
  });

  it('reports memory in bytes from both stacks, converting the MiB the vm stack stores', async () => {
    // 4096 MiB and 8 GiB, which is the whole point of converting: without it
    // the smaller VM reports the larger number.
    expect(await oneVm({ memory: 4096 })).toMatchObject({ memory_bytes: 4294967296 });
    expect(await oneInstance({ memory: 8589934592 })).toMatchObject({
      memory_bytes: 8589934592,
    });
    // Unreadable stays unreadable rather than being converted into a zero the
    // caller would read as a VM with no memory.
    expect(await oneVm({ memory: null })).toMatchObject({ memory_bytes: null });
    expect(await oneInstance({ memory: null })).toMatchObject({ memory_bytes: null });
  });

  it('reports a memory floor where the vm stack has one, in the same unit', async () => {
    expect(await oneVm({ min_memory: 1024 })).toMatchObject({ min_memory_bytes: 1073741824 });
  });

  it('counts vCPUs as sockets times cores times threads', async () => {
    // The guest sees four CPUs; `vcpus` alone says one.
    expect(await oneVm({ vcpus: 1, cores: 2, threads: 2 })).toMatchObject({ vcpus: 4 });
  });

  it('states no vCPU count where the vm stack did not report all three', async () => {
    // Not defaulted to 1: a guessed component is indistinguishable in the
    // result from one the system reported.
    expect(await oneVm({ threads: undefined })).toMatchObject({ vcpus: null });
    expect(await oneVm({ cores: 'two' })).toMatchObject({ vcpus: null });
  });

  it('reports a pinned CPU set verbatim and states no count for it', async () => {
    // How many CPUs `0-3` comes to is an inference about the host, not
    // something the system said.
    expect(await oneInstance({ cpu: '0-3' })).toMatchObject({ vcpus: null, cpu_set: '0-3' });
    expect(await oneInstance({ cpu: '1,3' })).toMatchObject({ vcpus: null, cpu_set: '1,3' });
    expect(await oneInstance({ cpu: '4' })).toMatchObject({ vcpus: 4, cpu_set: null });
    expect(await oneInstance({ cpu: null })).toMatchObject({ vcpus: null, cpu_set: null });
  });

  it('distinguishes a stopped VM from one in an error state', async () => {
    // On the incus stack the state word does it on its own.
    expect(await oneInstance({ status: 'ERROR' })).toMatchObject({ state: 'ERROR' });
    expect(await oneInstance({ status: 'STOPPED' })).toMatchObject({ state: 'STOPPED' });
    // On the libvirt stack both VMs read STOPPED and only the domain state
    // separates them, which is why it is reported beside rather than merged.
    const shutdown = await oneVm({ status: { state: 'STOPPED', domain_state: 'SHUTOFF' } });
    const crashed = await oneVm({ status: { state: 'STOPPED', domain_state: 'CRASHED' } });
    expect(shutdown).toMatchObject({ state: 'STOPPED', domain_state: 'SHUTOFF' });
    expect(crashed).toMatchObject({ state: 'STOPPED', domain_state: 'CRASHED' });
  });

  it('reports a state it could not read as null rather than as a state', async () => {
    expect(await oneVm({ status: null })).toMatchObject({ state: null, domain_state: null });
    expect(await oneVm({ status: ['RUNNING'] })).toMatchObject({ state: null });
    expect(await oneVm({ status: {} })).toMatchObject({ state: null, domain_state: null });
    expect(await oneVm({ name: '', id: null, autostart: 'yes' })).toMatchObject({
      name: null,
      id: null,
      autostart: null,
    });
  });

  it('returns no VMs and no failures on a system with none in either stack', async () => {
    expect(await read([], [])).toEqual({ vms: [], failures: [] });
  });

  it('reports a stack it could not read as a failure rather than as no VMs', async () => {
    // The distinction the empty list cannot carry: a system whose VMs all live
    // in the stack that failed is not a system without any.
    expect(await readFailing({ ['virt.instance.query']: new Error('unknown method') })).toEqual({
      vms: [expect.objectContaining({ source: 'vm', name: 'buildbox' })],
      failures: [{ source: 'virt_instance', error: 'unknown method' }],
    });
  });

  it('keeps the VMs of the stack that answered when the other one fails', async () => {
    const result = await readFailing({ ['vm.query']: new Error('service not running') });
    expect(result['vms']).toEqual([expect.objectContaining({ source: 'virt_instance' })]);
    expect(result['failures']).toEqual([{ source: 'vm', error: 'service not running' }]);
  });

  it('returns no VMs and both failures where neither stack could be read', async () => {
    const result = await readFailing({
      ['vm.query']: new Error('down'),
      ['virt.instance.query']: new Error('down'),
    });
    expect(result['vms']).toEqual([]);
    expect(result['failures']).toEqual([
      { source: 'vm', error: 'down' },
      { source: 'virt_instance', error: 'down' },
    ]);
  });

  it('names the reason whatever shape the client rejected with', async () => {
    const error = async (reason: unknown): Promise<unknown> =>
      ((await readFailing({ ['vm.query']: reason }))['failures'] as Record<string, unknown>[])[0][
        'error'
      ];
    expect(await error(new Error('an Error'))).toBe('an Error');
    expect(await error({ reason: 'a middleware error' })).toBe('a middleware error');
    expect(await error({ message: 'a JSON-RPC error' })).toBe('a JSON-RPC error');
    expect(await error('a bare string')).toBe('a bare string');
    // A failure with no text still has to read as a failure.
    expect(await error({})).toBe('the system reported no reason');
    expect(await error(new Error(''))).toBe('the system reported no reason');
    expect(await error(null)).toBe('the system reported no reason');
  });

  it('excludes containers, whether or not the middleware applied the filter', async () => {
    // An unrecognised filter is dropped rather than refused, and the result of
    // that is containers in a list of virtual machines.
    const listed = await rows([], [instance(), instance({ id: 'plex', type: 'CONTAINER' })]);
    expect(listed.map((row) => row['id'])).toEqual(['web']);
  });

  it('carries no field the tool does not name, including one a later release adds', async () => {
    const [libvirt, incus] = await rows(
      [vm({ enable_secure_boot: true })],
      [instance({ vnc_password: 'SECRET-VNC-PASSWORD', unheard_of_field: 'SECRET-NEW-SHAPE' })],
    );
    const named = [
      'source',
      'id',
      'name',
      'state',
      'domain_state',
      'vcpus',
      'cpu_set',
      'memory_bytes',
      'min_memory_bytes',
      'autostart',
    ];
    expect(Object.keys(libvirt)).toEqual(named);
    expect(Object.keys(incus)).toEqual(named);
    expect(JSON.stringify([libvirt, incus])).not.toContain('SECRET');
  });

  it('asks each stack for its own VMs', async () => {
    const { ctx, query } = fakeSystem({ ['vm.query']: [], ['virt.instance.query']: [] });
    await vmsList.handler(ctx, {});
    expect(query).toHaveBeenCalledWith('vm.query');
    expect(query).toHaveBeenCalledWith('virt.instance.query', [['type', '=', 'VM']]);
  });
});

describe('vm_logs', () => {
  const LOG_PATH = '/var/log/libvirt/qemu/1_buildbox.log';

  /** A libvirt VM as `vm.query` reports one; only the id and name are read here. */
  const vm = (over: Record<string, unknown> = {}) => ({
    id: 1,
    name: 'buildbox',
    vcpus: 1,
    cores: 1,
    threads: 1,
    memory: 4096,
    min_memory: null,
    autostart: true,
    status: { state: 'RUNNING', domain_state: 'RUNNING' },
    ...over,
  });

  /** An incus instance as `virt.instance.query` reports one. */
  const instance = (over: Record<string, unknown> = {}) => ({
    id: 'web',
    name: 'web',
    type: 'VM',
    status: 'RUNNING',
    cpu: '4',
    memory: 8589934592,
    autostart: false,
    ...over,
  });

  /** What the content seam answers a bounded read with. */
  const tail = (over: Partial<FileTail> = {}): FileTail => ({
    path: LOG_PATH,
    lines: ['starting up', 'ready'],
    truncated: false,
    ...over,
  });

  /**
   * A system with a content reader on it, which `fakeSystem` does not build:
   * the reader is the seam this tool reads through, and most of these cases
   * turn on what it answers.
   */
  const wired = (
    responses: Partial<Record<string, unknown>> = {
      ['vm.query']: [vm()],
      ['vm.log_file_path']: LOG_PATH,
    },
    readTail: (path: string, maxLines: number) => Promise<FileTail> = () => Promise.resolve(tail()),
  ) => {
    const { ctx, call, query } = fakeSystem(responses);
    const reader = vi.fn(readTail);
    ctx.system.files = { readTail: reader };
    return { ctx, call, query, reader };
  };

  /** The same, with one method rejecting instead. */
  const wiredFailing = (
    rows: Partial<Record<string, unknown>>,
    failures: Partial<Record<string, unknown>>,
  ) => {
    const { ctx, call, query } = failingSystem(rows, failures);
    ctx.system.files = { readTail: () => Promise.resolve(tail()) };
    return { ctx, call, query };
  };

  const read = async (
    args: Record<string, unknown> = { vm: 'buildbox' },
  ): Promise<Record<string, unknown>> =>
    (await vmLogs.handler(wired().ctx, args)) as Record<string, unknown>;

  it('reports the tail of the log of the VM it was asked for', async () => {
    expect(await read()).toEqual({
      source: 'vm',
      id: 1,
      name: 'buildbox',
      log_path: LOG_PATH,
      log_status: 'READ',
      log_error: null,
      requested_lines: 100,
      lines: ['starting up', 'ready'],
      truncated: false,
    });
  });

  it('matches a VM by its id, written as a number or as text', async () => {
    const { ctx, call } = wired({ ['vm.query']: [vm({ id: 7 })], ['vm.log_file_path']: LOG_PATH });
    expect(await vmLogs.handler(ctx, { vm: 7 })).toMatchObject({ id: 7, log_status: 'READ' });
    expect(await vmLogs.handler(ctx, { vm: '7' })).toMatchObject({ id: 7, log_status: 'READ' });
    // The path is asked for by id, whichever way the caller named the machine.
    expect(call).toHaveBeenCalledWith('vm.log_file_path', [7]);
  });

  it('bounds the lines it asks the reader for, and says which bound it applied', async () => {
    const { ctx, reader } = wired();
    expect(await vmLogs.handler(ctx, { vm: 'buildbox' })).toMatchObject({ requested_lines: 100 });
    expect(reader).toHaveBeenCalledWith(LOG_PATH, 100);
    expect(await vmLogs.handler(ctx, { vm: 'buildbox', lines: 5 })).toMatchObject({
      requested_lines: 5,
    });
    expect(reader).toHaveBeenCalledWith(LOG_PATH, 5);
  });

  it('refuses a line bound it cannot honour rather than quietly applying another', async () => {
    // A caller given 100 lines after asking for 1001 cannot tell that from a
    // log holding 100.
    for (const lines of [0, -1, 1001, 1.5, '10', true]) {
      await expect(read({ vm: 'buildbox', lines })).rejects.toThrow(
        /"lines" must be a whole number between 1 and 1000/,
      );
    }
    // Null and undefined are the argument not being given, which is what the
    // default is for — as `audit_log_query` reads its own `since`.
    for (const lines of [null, undefined]) {
      expect(await read({ vm: 'buildbox', lines })).toMatchObject({ requested_lines: 100 });
    }
  });

  it('refuses a vm argument that names no machine', async () => {
    // `vm` is required, so null is a caller naming nothing rather than a
    // default to fall back to — there is none.
    for (const named of ['', 1.5, true, {}, undefined, null]) {
      await expect(read({ vm: named })).rejects.toThrow(
        /"vm" must be the name of a virtual machine, or its numeric id/,
      );
    }
  });

  it('reports a VM that does not exist as an error naming it', async () => {
    const { ctx } = wired({ ['vm.query']: [], ['virt.instance.query']: [] });
    await expect(vmLogs.handler(ctx, { vm: 'ghost' })).rejects.toThrow(
      /No libvirt-backed virtual machine matching "ghost" exists on this system$/,
    );
  });

  it('says an incus instance has no retrievable log, rather than reporting an empty one', async () => {
    // The two answers mean different things: only one of them says the machine
    // has written nothing.
    const { ctx } = wired({ ['vm.query']: [], ['virt.instance.query']: [instance()] });
    await expect(vmLogs.handler(ctx, { vm: 'web' })).rejects.toThrow(/is an incus-backed instance/);
  });

  it('does not read a container as the instance asked about', async () => {
    // The `type` filter is asked of the middleware and re-checked here: an
    // unrecognised filter is dropped rather than refused.
    const { ctx } = wired({
      ['vm.query']: [],
      ['virt.instance.query']: [instance({ id: 'plex', name: 'plex', type: 'CONTAINER' })],
    });
    await expect(vmLogs.handler(ctx, { vm: 'plex' })).rejects.toThrow(
      /No libvirt-backed virtual machine matching "plex"/,
    );
  });

  it('says the incus stack could not be read rather than that the VM exists nowhere', async () => {
    const { ctx } = wiredFailing(
      { ['vm.query']: [] },
      { ['virt.instance.query']: new Error('virt is not installed') },
    );
    await expect(vmLogs.handler(ctx, { vm: 'web' })).rejects.toThrow(
      /the incus stack could not be read to say whether it holds one: virt is not installed/,
    );
  });

  it('reports a stack that could not be listed as that, not as a VM that does not exist', async () => {
    const { ctx } = wiredFailing({}, { ['vm.query']: new Error('connection reset') });
    await expect(vmLogs.handler(ctx, { vm: 'buildbox' })).rejects.toThrow(
      /could not be listed, so "buildbox" could not be found: connection reset/,
    );
  });

  it('refuses to guess between machines the name matches', async () => {
    const { ctx } = wired({
      ['vm.query']: [vm({ id: null }), vm({ id: 2 })],
      ['vm.log_file_path']: LOG_PATH,
    });
    await expect(vmLogs.handler(ctx, { vm: 'buildbox' })).rejects.toThrow(
      /matches 2 virtual machines on this system — buildbox \(id unknown\), buildbox \(id 2\)/,
    );
  });

  it('names an unreadable name in the machines a selector matched', async () => {
    // One matched by its id and one by a name that is another machine's id, so
    // asking again by id would not separate them either.
    const { ctx } = wired({
      ['vm.query']: [vm({ id: 1, name: null }), vm({ id: 2, name: '1' })],
      ['vm.log_file_path']: LOG_PATH,
    });
    await expect(vmLogs.handler(ctx, { vm: 1 })).rejects.toThrow(
      /an unnamed VM \(id 1\), 1 \(id 2\)/,
    );
  });

  it('refuses a VM whose id the system did not report', async () => {
    const { ctx } = wired({ ['vm.query']: [vm({ id: null })], ['vm.log_file_path']: LOG_PATH });
    await expect(vmLogs.handler(ctx, { vm: 'buildbox' })).rejects.toThrow(
      /reported no id for the virtual machine matching "buildbox"/,
    );
  });

  it('reports a system naming no log file as no log yet, not as an empty one', async () => {
    for (const path of [null, '']) {
      const { ctx, reader } = wired({ ['vm.query']: [vm()], ['vm.log_file_path']: path });
      expect(await vmLogs.handler(ctx, { vm: 'buildbox' })).toMatchObject({
        log_path: null,
        log_status: 'NO_LOG_PATH',
        log_error: null,
        lines: [],
        truncated: false,
      });
      // Nothing to read, so nothing is read.
      expect(reader).not.toHaveBeenCalled();
    }
  });

  it('reports a log it could not read as unreadable, never as an empty one', async () => {
    // Including the absent file this cannot tell from an unreadable one: the
    // error name that separates them is not carried through to the tool, so
    // both arrive here and `log_error` is what tells them apart. Reporting
    // either as `lines: []` under `READ` would say the VM logged nothing on
    // the strength of a read that never happened.
    const failures = [
      new FileContentError('NOT_FOUND', LOG_PATH, `Could not read "${LOG_PATH}": ENOENT`),
      new FileContentError('TRANSPORT', LOG_PATH, 'Downloading it failed'),
      new FileContentError('UNREADABLE', LOG_PATH, 'Permission denied'),
      new FileContentError('NOT_A_FILE', LOG_PATH, 'It is a directory'),
      new Error('the reader broke'),
    ];
    for (const failure of failures) {
      const { ctx } = wired(undefined, () => Promise.reject(failure));
      expect(await vmLogs.handler(ctx, { vm: 'buildbox' })).toMatchObject({
        log_path: LOG_PATH,
        log_status: 'UNREADABLE',
        log_error: failure.message,
        lines: [],
        truncated: false,
      });
    }
  });

  it('does not carry the seam\'s cause into a result, where a download URL can be', async () => {
    // `FileContentError` keeps the adapter's own message — which names the URL
    // it fetched, token and all — on `cause` rather than in `message`.
    const failure = new FileContentError('TRANSPORT', LOG_PATH, `Downloading "${LOG_PATH}" failed`, {
      cause: new Error('request to https://nas.local/_download?auth_token=SECRET-TOKEN failed'),
    });
    const { ctx } = wired(undefined, () => Promise.reject(failure));
    const answer = await vmLogs.handler(ctx, { vm: 'buildbox' });
    expect(JSON.stringify(answer)).not.toContain('SECRET-TOKEN');
  });

  it('reports a log file path that could not be read', async () => {
    const { ctx } = wiredFailing(
      { ['vm.query']: [vm()] },
      { ['vm.log_file_path']: new Error('no such VM') },
    );
    await expect(vmLogs.handler(ctx, { vm: 'buildbox' })).rejects.toThrow(
      /The log file path for "buildbox" could not be read: no such VM/,
    );
  });

  it('reports a deployment with no content reader rather than an empty log', async () => {
    const { ctx, query } = fakeSystem({ ['vm.query']: [vm()] });
    await expect(vmLogs.handler(ctx, { vm: 'buildbox' })).rejects.toThrow(
      /cannot read file content from a system/,
    );
    // Said before anything is asked of the system: it is a fact about how the
    // deployment was assembled rather than about the VM.
    expect(query).not.toHaveBeenCalled();
  });

  it('carries the truncation the reader reported', async () => {
    const { ctx } = wired(undefined, () =>
      Promise.resolve(tail({ lines: ['ready'], truncated: true })),
    );
    expect(await vmLogs.handler(ctx, { vm: 'buildbox' })).toMatchObject({
      lines: ['ready'],
      truncated: true,
    });
  });

  it('reads the log of a VM it has already found without reading the other stack', async () => {
    const { ctx, query } = wired();
    await vmLogs.handler(ctx, { vm: 'buildbox' });
    expect(query).toHaveBeenCalledWith('vm.query');
    expect(query).not.toHaveBeenCalledWith('virt.instance.query', [['type', '=', 'VM']]);
  });

  it('carries no field the tool does not name', async () => {
    const { ctx } = wired({
      ['vm.query']: [vm({ vnc_password: 'SECRET-VNC-PASSWORD' })],
      ['vm.log_file_path']: LOG_PATH,
    });
    const answer = (await vmLogs.handler(ctx, { vm: 'buildbox' })) as Record<string, unknown>;
    expect(Object.keys(answer)).toEqual([
      'source',
      'id',
      'name',
      'log_path',
      'log_status',
      'log_error',
      'requested_lines',
      'lines',
      'truncated',
    ]);
    expect(JSON.stringify(answer)).not.toContain('SECRET');
  });

  it('advertises the same bound its description states', () => {
    expect(vmLogs.inputSchema).toMatchObject({
      required: ['vm'],
      properties: { lines: { minimum: 1, maximum: 1000 } },
    });
  });
});

describe('vm_devices', () => {
  /** One device row as `vm.device.query` reports one, around its attributes. */
  const device = (attributes: unknown, over: Record<string, unknown> = {}) => ({
    id: 7,
    vm: 1,
    order: 1002,
    attributes,
    ...over,
  });

  const read = async (devices: unknown[]): Promise<Record<string, unknown>> => {
    const { ctx } = fakeSystem({ ['vm.device.query']: devices });
    return (await vmDevices.handler(ctx, {})) as Record<string, unknown>;
  };

  const rows = async (devices: unknown[]): Promise<Record<string, unknown>[]> =>
    (await read(devices))['devices'] as Record<string, unknown>[];

  /** One device's mapped row. */
  const one = async (attributes: unknown): Promise<Record<string, unknown>> =>
    (await rows([device(attributes)]))[0];

  /** One device's mapped `attributes`. */
  const mapped = async (attributes: unknown): Promise<unknown> =>
    (await one(attributes))['attributes'];

  it('reports a device with the envelope that attributes it to a VM', async () => {
    expect(await read([device({ dtype: 'PCI', pptdev: '0000:01:00.0' })])).toEqual({
      devices: [
        {
          id: 7,
          // The join to `vms_list`: this is the `id` it reports for a `source`
          // `vm` entry, and there is no other way to attribute the device.
          vm: 1,
          order: 1002,
          dtype: 'PCI',
          attributes: { pptdev: '0000:01:00.0' },
        },
      ],
    });
  });

  it('maps a DISK through its own fields', async () => {
    expect(
      await mapped({
        dtype: 'DISK',
        path: '/dev/zvol/tank/buildbox',
        type: 'VIRTIO',
        create_zvol: false,
        zvol_name: 'tank/buildbox',
        zvol_volsize: 42949672960,
        logical_sectorsize: 512,
        physical_sectorsize: 4096,
        iotype: 'THREADS',
        serial: 'BUILDBOX01',
      }),
    ).toEqual({
      type: 'VIRTIO',
      logical_sectorsize: 512,
      physical_sectorsize: 4096,
      iotype: 'THREADS',
      serial: 'BUILDBOX01',
      path: '/dev/zvol/tank/buildbox',
      create_zvol: false,
      zvol_name: 'tank/buildbox',
      // Reported under the name the system uses, with no unit asserted: this
      // API declares it as a bare number (#96).
      zvol_volsize: 42949672960,
    });
  });

  it('maps a RAW through its own fields, which are not a DISK’s', async () => {
    expect(
      await mapped({
        dtype: 'RAW',
        path: '/mnt/tank/images/win.img',
        type: 'AHCI',
        exists: true,
        boot: true,
        size: 21474836480,
        logical_sectorsize: null,
        physical_sectorsize: null,
        iotype: 'NATIVE',
        serial: null,
      }),
    ).toEqual({
      type: 'AHCI',
      logical_sectorsize: null,
      physical_sectorsize: null,
      iotype: 'NATIVE',
      serial: null,
      path: '/mnt/tank/images/win.img',
      exists: true,
      boot: true,
      size: 21474836480,
    });
  });

  it('maps a NIC through its own fields', async () => {
    expect(
      await mapped({
        dtype: 'NIC',
        type: 'VIRTIO',
        nic_attach: 'br0',
        mac: '00:a0:98:11:22:33',
        trust_guest_rx_filters: false,
      }),
    ).toEqual({
      type: 'VIRTIO',
      nic_attach: 'br0',
      // Identifying but not secret, and response data rather than an argument
      // — the same reading `disks_list` applies to a serial number.
      mac: '00:a0:98:11:22:33',
      trust_guest_rx_filters: false,
    });
  });

  it('maps a CDROM and a USB through their own fields', async () => {
    expect(await mapped({ dtype: 'CDROM', path: '/mnt/tank/iso/debian.iso' })).toEqual({
      path: '/mnt/tank/iso/debian.iso',
    });
    expect(
      await mapped({
        dtype: 'USB',
        controller_type: 'nec-xhci',
        device: 'usb_device_0781_5583_0',
        usb: { vendor_id: '0x0781', product_id: '0x5583' },
      }),
    ).toEqual({
      controller_type: 'nec-xhci',
      device: 'usb_device_0781_5583_0',
      vendor_id: '0x0781',
      product_id: '0x5583',
    });
    // The identifiers are one level down and the record is declared nullable.
    expect(await mapped({ dtype: 'USB', device: 'usb_device_0781_5583_0', usb: null })).toEqual({
      controller_type: null,
      device: 'usb_device_0781_5583_0',
      vendor_id: null,
      product_id: null,
    });
  });

  it('reports where a display listens and never its password', async () => {
    expect(
      await mapped({
        dtype: 'DISPLAY',
        type: 'SPICE',
        bind: '0.0.0.0',
        port: 5900,
        web_port: 5901,
        web: true,
        wait: false,
        resolution: '1920x1080',
        password: 'SECRET-CONSOLE-PASSWORD',
      }),
    ).toEqual({
      type: 'SPICE',
      bind: '0.0.0.0',
      port: 5900,
      web_port: 5901,
      web: true,
      resolution: '1920x1080',
    });
  });

  it('keeps the console password out of the result in every form', async () => {
    // Not redacted and not reported as whether one is set: a tool result is
    // recorded verbatim in the audit trail, so the passphrase must not reach
    // one at all. `wait` is here to check the allowlist drops an ordinary
    // unnamed field the same way it drops the credential.
    const answer = await read([
      device({
        dtype: 'DISPLAY',
        port: 5900,
        wait: true,
        password: 'SECRET-CONSOLE-PASSWORD',
      }),
    ]);
    expect(JSON.stringify(answer)).not.toContain('SECRET');
    expect(JSON.stringify(answer)).not.toContain('password');
    expect(JSON.stringify(answer)).not.toContain('wait');
  });

  it('carries no field a device kind does not name, including one a later release adds', async () => {
    expect(
      await mapped({ dtype: 'PCI', pptdev: '0000:01:00.0', unheard_of_field: 'SECRET-NEW-SHAPE' }),
    ).toEqual({ pptdev: '0000:01:00.0' });
    const [row] = await rows([device({ dtype: 'PCI', pptdev: 'x' }, { unheard_of: 'SECRET' })]);
    expect(Object.keys(row)).toEqual(['id', 'vm', 'order', 'dtype', 'attributes']);
  });

  it('names a device kind it cannot map and states no configuration for it', async () => {
    // TrueNAS defines ISCSI_DISK on the device shape the `vm.device` events
    // carry and not on the one `vm.device.query` answers with, so an unmapped
    // kind is a case to expect rather than a defensive branch. The
    // kind is still reported: a null `attributes` beside it is a device that is
    // there and configured, not one with nothing configured.
    expect(
      await one({ dtype: 'ISCSI_DISK', portal_address: '10.0.0.1', initiator_iqn: 'iqn.2005' }),
    ).toMatchObject({ dtype: 'ISCSI_DISK', attributes: null });
  });

  it('lists a device it could not read at all rather than dropping it', async () => {
    // A shorter list would say the machine does not have that device, which is
    // the wrong answer to give about a VM that will not start (#93).
    expect(await rows([device(null), device(['DISK']), device({}), 'not a row'])).toEqual([
      { id: 7, vm: 1, order: 1002, dtype: null, attributes: null },
      { id: 7, vm: 1, order: 1002, dtype: null, attributes: null },
      { id: 7, vm: 1, order: 1002, dtype: null, attributes: null },
      { id: null, vm: null, order: null, dtype: null, attributes: null },
    ]);
  });

  it('reports an unreadable field as null rather than as a configured value', async () => {
    expect(await mapped({ dtype: 'NIC', nic_attach: null, mac: '', type: 7 })).toEqual({
      type: null,
      nic_attach: null,
      mac: null,
      trust_guest_rx_filters: null,
    });
    expect(await one(device({ dtype: 'PCI' })['attributes'])).toMatchObject({
      attributes: { pptdev: null },
    });
  });

  it('states no VM for a device it could not attribute to one', async () => {
    expect(await rows([device({ dtype: 'PCI', pptdev: 'x' }, { vm: null, id: '7' })])).toEqual([
      { id: null, vm: null, order: 1002, dtype: 'PCI', attributes: { pptdev: 'x' } },
    ]);
  });

  it('returns no devices on a system with none', async () => {
    // Which includes a system with no libvirt-backed VMs at all: neither
    // throws, and both answer the empty list.
    expect(await read([])).toEqual({ devices: [] });
  });

  it('raises a read it could not make rather than reporting no devices', async () => {
    // An empty list means something definite — no VM on this system has any
    // device attached — that a read which never happened has not established.
    const { ctx } = failingSystem({}, { ['vm.device.query']: new Error('unknown method') });
    await expect(vmDevices.handler(ctx, {})).rejects.toThrow(
      'The virtual machine devices could not be listed: unknown method',
    );
  });

  it('raises an answer that was not a list of devices', async () => {
    // The call directory declares this method as answering a union that also
    // admits a bare row and a count, so this is a shape the client's own types
    // say the middleware has.
    await expect(vmDevices.handler(fakeSystem({ ['vm.device.query']: 3 }).ctx, {})).rejects.toThrow(
      'The virtual machine devices could not be listed: the system answered with something ' +
        'other than a list of devices',
    );
  });

  it('reads the libvirt device surface and nothing from the incus stack', async () => {
    // Both seams are asserted on: a tool picks `call` or `query` per verb, so
    // checking one alone would let a read through the other go unnoticed.
    const { ctx, query, call } = fakeSystem({ ['vm.device.query']: [] });
    await vmDevices.handler(ctx, {});
    expect(query).toHaveBeenCalledWith('vm.device.query');
    expect(query).toHaveBeenCalledTimes(1);
    expect(call).not.toHaveBeenCalled();
  });
});

/**
 * `vm_clone`'s tests live here and not in a `vm-clone.spec.ts` of their own,
 * which is #87's default rather than an oversight, and the trigger was checked
 * rather than felt: `vms.spec.ts` was 840 lines before this block and the block
 * is several hundred, so the merged file does not cross 1,500 the way it did
 * when the three power tools were added at once. That is #97's case exactly — a
 * spec that is merely long is not a spec that has to split — and the next tool
 * over the line takes its own spec the same way `vm-start.spec.ts` did.
 *
 * The fake system is local to this block, as `vm-start.spec.ts`'s is:
 * `src/testing/fake-systems.ts` stubs `query` off one method→response map, and
 * most of what is tested here is two reads of `vm.query` answering DIFFERENTLY —
 * before the clone and after it — which one map cannot express.
 */
describe('vm_clone', () => {
  /** A libvirt-backed VM as `vm.query` answers with one. */
  const vm = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: 4,
    name: 'builder',
    status: { state: 'STOPPED', domain_state: 'SHUTOFF' },
    vcpus: 1,
    cores: 2,
    threads: 1,
    memory: 4096,
    min_memory: null,
    autostart: true,
    ...over,
  });

  /** A device row as `vm.device.query` answers with one. */
  const device = (
    dtype: string,
    attributes: Record<string, unknown>,
    over: Record<string, unknown> = {},
  ): Record<string, unknown> => ({ id: 11, vm: 4, order: 1001, attributes: { dtype, ...attributes }, ...over });

  /** A zvol-backed disk of a given declared size. */
  const zvol = (zvol_name: string, zvol_volsize: unknown): Record<string, unknown> =>
    device('DISK', { zvol_name, zvol_volsize, path: `/dev/zvol/${zvol_name}` });

  /** One answer to a read: the rows it listed, or the failure that stopped it. */
  type Answer = { rows: unknown } | { fails: unknown };

  const emit = (answer: Answer) =>
    'fails' in answer ? throwError(() => answer.fails) : of(answer.rows);

  /**
   * A system answering `vm.query` from a queue, `vm.device.query` once, and
   * `vm.clone` with whatever the test asked for.
   *
   * A queue shorter than the number of reads repeats its last answer, so a test
   * that does not care about the difference between the two listings gives one
   * entry and stops there.
   */
  function cloneSystem(
    options: {
      reads?: Answer[];
      devices?: Answer;
      answer?: unknown;
      callFails?: unknown;
    } = {},
  ): { ctx: ToolContext; query: ReturnType<typeof vi.fn>; call: ReturnType<typeof vi.fn> } {
    const reads = options.reads ?? [{ rows: [vm()] }];
    let index = 0;
    const query = vi.fn((method: string) => {
      if (method === 'vm.device.query') return emit(options.devices ?? { rows: [] });
      const read = reads[Math.min(index, reads.length - 1)];
      index += 1;
      return emit(read);
    });
    const call = vi.fn(() =>
      'callFails' in options
        ? throwError(() => options.callFails)
        : of('answer' in options ? options.answer : true),
    );
    const system = { name: 'nas', client: { api: { query, call } } } as unknown as SystemHandle;
    return { ctx: { system }, query, call };
  }

  /** The two steps the plan returns, typed. */
  const planSteps = async (
    ctx: ToolContext,
    args: Record<string, unknown> = { id: 4 },
  ): Promise<PlanStep[]> => {
    const steps = await vmClone.plan(ctx, args);
    expect(steps).toHaveLength(2);
    return steps;
  };

  /** The mutation step's description, which is what most of the plan tests read. */
  const planText = async (
    options: Parameters<typeof cloneSystem>[0] = {},
    args: Record<string, unknown> = { id: 4 },
  ): Promise<string> => (await planSteps(cloneSystem(options).ctx, args))[1].description;

  /** One `execute` result. */
  const run = async (
    options: Parameters<typeof cloneSystem>[0] = {},
    args: Record<string, unknown> = { id: 4 },
  ): Promise<Record<string, unknown>> =>
    (await vmClone.execute(cloneSystem(options).ctx, args)) as Record<string, unknown>;

  it('is a reversible mutating tool needing the full role', () => {
    expect(vmClone).toMatchObject({
      name: 'vm_clone',
      mutating: true,
      // It adds a machine and destroys nothing, which is the easy case for the
      // field — and the value must not be read as "this catalog can undo it",
      // which is what the description assertion below pins.
      destructiveness: 'reversible',
      requiredRole: Role.Full,
    });
  });

  it('takes the id and an optional name, and nothing else', () => {
    const schema = vmClone.inputSchema as {
      properties: Record<string, unknown>;
      required: string[];
    };
    expect(Object.keys(schema.properties)).toEqual(['id', 'name']);
    expect(schema.required).toEqual(['id']);
  });

  describe('description', () => {
    it('says nothing in this catalog deletes the clone', () => {
      // #153's trap: `reversible` beside an operation that plainly removes
      // nothing invites the reading "undoing this is easy", and undoing a clone
      // means deleting a VM and its zvols, which no tool here does.
      expect(vmClone.description).toContain(
        'NOTHING IN THIS CATALOG DELETES THE CLONE, OR ITS ZVOLS, OR THE SOURCE MACHINE',
      );
      expect(vmClone.description).toContain('can undo it');
    });

    it('says the zvols behind the disks are copied and the pool pays for them', () => {
      expect(vmClone.description).toContain('ZVOLS OF ITS OWN BEHIND ITS DISKS');
      expect(vmClone.description).toContain('CONSUMES POOL SPACE');
    });

    it('says that account is read from the implementation and is not checkable here', () => {
      expect(vmClone.description).toContain(
        'ARE READ FROM THE TRUENAS IMPLEMENTATION AND ARE NOT SOMETHING THIS CATALOG CAN CHECK',
      );
    });

    it('marks the derived name unconfirmed rather than stating a rule it did not read', () => {
      expect(vmClone.description).toContain('WHAT IT DERIVES IS (unconfirmed) HERE');
    });

    it('says the clone is identified by re-reading and not by the boolean', () => {
      expect(vmClone.description).toContain(
        'THE RESULT IDENTIFIES THE CLONE BY RE-READING AND NOT BY TRUSTING THE ANSWER',
      );
      expect(vmClone.description).toContain('IT IS NOT WHERE ANY OF THE ABOVE COMES FROM');
    });

    it('says an empty new_vm_ids is not proof the clone was not made', () => {
      // The reading that costs data here is the opposite one — "no new machine,
      // so nothing happened" — on a call that has already run.
      expect(vmClone.description).toContain('NOT proof the clone was not made');
    });
  });

  describe('normalizeArgs', () => {
    it('drops the executor arguments and carries no name as an explicit null', () => {
      expect(vmClone.normalizeArgs?.({ id: 4, systems: 'all' })).toEqual({ id: 4, name: null });
    });

    it('keeps a name the caller asked for', () => {
      expect(vmClone.normalizeArgs?.({ id: 4, name: 'builder-copy' })).toEqual({
        id: 4,
        name: 'builder-copy',
      });
    });

    it.each([{}, { id: '4' }, { id: 4.5 }])('refuses an id it cannot read: %o', (args) => {
      expect(() => vmClone.normalizeArgs?.(args)).toThrow('"id" is required');
    });

    it('names the other stack in that refusal, which is the mistake it catches', () => {
      expect(() => vmClone.normalizeArgs?.({ id: 'incus-vm' })).toThrow('`virt_instance`');
    });

    it.each([{ id: 4, name: 7 }, { id: 4, name: '' }])(
      'refuses a name it cannot read rather than coercing it: %o',
      (args) => {
        expect(() => vmClone.normalizeArgs?.(args)).toThrow('"name" must be a non-empty string');
      },
    );
  });

  describe('plan', () => {
    it('names the read and the mutation, in the order execute makes them', async () => {
      const steps = await planSteps(cloneSystem().ctx);
      expect(steps.map((step) => step.method)).toEqual(['vm.query', 'vm.clone']);
      expect(steps[1].params).toEqual([4, null]);
    });

    it('sends the name the caller chose as the second positional argument', async () => {
      const steps = await planSteps(cloneSystem().ctx, { id: 4, name: 'builder-copy' });
      expect(steps[1].params).toEqual([4, 'builder-copy']);
    });

    it('says the read changes nothing, runs again, and is what identifies the clone', async () => {
      const [read] = await planSteps(cloneSystem().ctx);
      expect(read.description).toContain('Changes nothing');
      expect(read.description).toContain('THIS SAME READ IS MADE AGAIN IMMEDIATELY AFTER THE CALL');
      expect(read.description).toContain(
        'THE CLONE IS IDENTIFIED AS THE MACHINE THE SECOND LISTING NAMES AND THE FIRST DID NOT',
      );
    });

    it("makes every listing read with the params the plan's read step named", async () => {
      // Each half is asserted against its own literal rather than the step's
      // params being spread into the expected JS arguments: the step names the
      // two positional params the call reaches the middleware with, where the JS
      // call passes the filter and the options, so a spread would compare the
      // step against itself.
      const { ctx, query } = cloneSystem();
      const [read] = await planSteps(ctx);
      await vmClone.execute(ctx, { id: 4 });
      expect(read.params).toEqual([[], { select: ['id', 'name'] }]);
      expect(query.mock.calls.filter(([method]) => method === 'vm.query').slice(1)).toEqual([
        ['vm.query', [], { select: ['id', 'name'] }],
        ['vm.query', [], { select: ['id', 'name'] }],
      ]);
    });

    it('names the machine and says it is read and copied rather than changed', async () => {
      const text = await planText();
      expect(text).toContain('Clone the virtual machine "builder" (id 4)');
      expect(text).toContain('READ AND COPIED AND NOT CHANGED');
      expect(text).toContain('Its state read as `STOPPED`');
    });

    it('fails naming the id where no machine has it', async () => {
      await expect(vmClone.plan(cloneSystem({ reads: [{ rows: [] }] }).ctx, { id: 4 })).rejects.toThrow(
        'No virtual machine with id 4 on the `vm` stack',
      );
    });

    it('checks the id on the response rather than acting on the first row', async () => {
      // An unrecognised query parameter is dropped rather than refused, so a
      // filter that did not apply comes back as the whole table.
      const { ctx } = cloneSystem({ reads: [{ rows: [vm({ id: 9, name: 'other' })] }] });
      await expect(vmClone.plan(ctx, { id: 4 })).rejects.toThrow('No virtual machine with id 4');
    });

    it('lets a plan-time state read failure fail the plan', async () => {
      const { ctx } = cloneSystem({ reads: [{ fails: new Error('middleware is down') }] });
      await expect(vmClone.plan(ctx, { id: 4 })).rejects.toThrow('middleware is down');
    });

    it('states what a clone copies, and that none of it is on this API', async () => {
      const text = await planText();
      expect(text).toContain('A CLONE IS NOT ONLY A COPY OF THE CONFIGURATION');
      expect(text).toContain('THE ZVOLS BEHIND ITS DISK DEVICES');
      expect(text).toContain('read from the TrueNAS implementation');
    });

    it('says outright that nothing here deletes the machine it makes', async () => {
      expect(await planText()).toContain(
        'NOTHING IN THIS CATALOG DELETES THE MACHINE THIS MAKES, OR THE ZVOLS BEHIND ITS DISKS',
      );
    });

    describe('the space the copy will occupy', () => {
      it('names each disk and what they come to', async () => {
        const text = await planText({
          devices: { rows: [zvol('tank/builder-0', 20), zvol('tank/builder-1', 30)] },
        });
        expect(text).toContain('tank/builder-0 (`zvol_volsize` 20)');
        expect(text).toContain('tank/builder-1 (`zvol_volsize` 30)');
        expect(text).toContain('Together they come to 50.');
      });

      it('does not call a DISK zvol-backed where the system named no zvol for it', async () => {
        // A `DISK` can be a host block device attached to the machine, which
        // this API declares the same way — `zvol_name` and `zvol_volsize` are
        // both optional. Calling every one of them zvol-backed is a description
        // promising more than the read delivers.
        const text = await planText({
          devices: {
            rows: [device('DISK', { path: '/dev/disk/by-id/wwn-0x5000c500', zvol_name: null })],
          },
        });
        expect(text).toContain('/dev/disk/by-id/wwn-0x5000c500');
        expect(text).toContain('AND IT NAMED NO ZVOL');
        expect(text).toContain('a `DISK` device NEED NOT BE ZVOL-BACKED');
        expect(text).toContain('WHETHER A CLONE COPIES ANYTHING FOR ONE IS (unconfirmed) HERE');
        expect(text).not.toContain('zvol-backed `DISK` device for it');
      });

      it('adds no such caveat where every disk named its zvol', async () => {
        const text = await planText({ devices: { rows: [zvol('tank/builder-0', 20)] } });
        expect(text).not.toContain('AND IT NAMED NO ZVOL');
        expect(text).not.toContain('NEED NOT BE ZVOL-BACKED');
      });

      it('asserts no unit for those numbers', async () => {
        // `vm_devices` reports `zvol_volsize` unsuffixed on the same ground: the
        // API declares a bare number and a suffix would be a claim (#96).
        expect(await planText({ devices: { rows: [zvol('tank/builder-0', 20)] } })).toContain(
          'THE API DECLARES NO UNIT FOR THOSE NUMBERS',
        );
      });

      it('refuses a total where one disk reported no size it could read', async () => {
        // A total over the rest would understate what the copy can come to
        // occupy, which is the reassuring direction to be wrong in.
        const text = await planText({
          devices: { rows: [zvol('tank/builder-0', 20), zvol('tank/builder-1', null)] },
        });
        expect(text).toContain('THEY DO NOT ADD UP TO A TOTAL HERE');
        expect(text).toContain('this system reported no `zvol_volsize` this tool could read');
        expect(text).not.toContain('Together they come to');
      });

      it('says whether the space is taken at once is unconfirmed', async () => {
        expect(await planText({ devices: { rows: [zvol('tank/builder-0', 20)] } })).toContain(
          'WHETHER THE COPY TAKES THAT SPACE AT ONCE OR TAKES IT AS IT DIVERGES FROM THE SOURCE ' +
            'IS (unconfirmed) HERE',
        );
      });

      it('names a raw file-backed disk separately and does not count it', async () => {
        const text = await planText({
          devices: {
            rows: [zvol('tank/builder-0', 20), device('RAW', { path: '/mnt/tank/disk.img', size: 99 })],
          },
        });
        expect(text).toContain('Together they come to 20.');
        expect(text).toContain('/mnt/tank/disk.img (`size` 99)');
        expect(text).toContain('WHAT A CLONE DOES WITH ONE IS (unconfirmed) HERE');
        expect(text).toContain('its size is NOT counted above');
      });

      it('says no zvol is expected where every disk it has is file-backed', async () => {
        // The RAW caveat alone would leave a reader inferring a zvol they were
        // never told about; "no zvol of its own is expected to be copied" is the
        // half that says what the pool is NOT being asked for.
        const text = await planText({
          devices: { rows: [device('RAW', { path: '/mnt/tank/disk.img', size: 99 })] },
        });
        expect(text).toContain('The system listed no `DISK` device');
        expect(text).toContain('/mnt/tank/disk.img (`size` 99)');
        expect(text).toContain('WHAT A CLONE DOES WITH ONE IS (unconfirmed) HERE');
      });

      it('names a raw disk the system gave no path for', async () => {
        expect(await planText({ devices: { rows: [device('RAW', { size: 99 })] } })).toContain(
          '(the system named no zvol or path for it) (`size` 99)',
        );
      });

      it('will not read a device row that is not a record as a machine with no disks', async () => {
        // The row answers no `vm` and no `dtype`, so it is a device that could
        // not be read rather than one ruled out.
        expect(await planText({ devices: { rows: [7] } })).toContain(
          'NEITHER BE READ AS ONE NOR RULED OUT AS ONE',
        );
      });

      it('says a raw disk reported no size it could read rather than leaving it out', async () => {
        expect(
          await planText({ devices: { rows: [device('RAW', { path: '/mnt/tank/disk.img' })] } }),
        ).toContain('/mnt/tank/disk.img (this system reported no `size` this tool could read)');
      });

      it('says the disks could not be read where the device read failed', async () => {
        // Which is not the same answer as a machine with no disks, and reporting
        // it as one would describe a clone as free that fills a pool.
        const text = await planText({ devices: { fails: new Error('denied') } });
        expect(text).toContain('WHAT THE COPY WILL OCCUPY IS NOT ESTABLISHED HERE');
        expect(text).toContain('denied');
        expect(text).toContain('not the same answer as a machine with no disks');
      });

      it('says the same where the device read answered something other than a list', async () => {
        expect(await planText({ devices: { rows: 3 } })).toContain(
          'the system answered with something other than a list of devices',
        );
      });

      it('does not let a failed device read fail the plan', async () => {
        const steps = await planSteps(cloneSystem({ devices: { fails: new Error('denied') } }).ctx);
        expect(steps.map((step) => step.method)).toEqual(['vm.query', 'vm.clone']);
      });

      it('says the system listed no disk device where it listed none', async () => {
        expect(await planText({ devices: { rows: [] } })).toContain(
          'THE SYSTEM LISTED NO DISK DEVICE FOR THIS VIRTUAL MACHINE',
        );
      });

      it('ignores a device row the response attributes to another machine', async () => {
        // The filter is bandwidth; the check on the response is the control, and
        // without it a dropped filter would name another machine's disks here.
        const text = await planText({
          devices: { rows: [zvol('tank/other-0', 99), { ...zvol('tank/builder-0', 20), vm: 9 }] },
        });
        expect(text).toContain('Together they come to 99.');
        expect(text).not.toContain('tank/builder-0');
      });

      it('names a disk the system gave neither a zvol nor a path for', async () => {
        expect(await planText({ devices: { rows: [device('DISK', { zvol_volsize: 20 })] } })).toContain(
          '(the system named no zvol or path for it) (`zvol_volsize` 20, AND IT NAMED NO ZVOL)',
        );
      });

      it('rules out a device kind this API declares with no zvol in it', async () => {
        // Ruled out rather than unread: none of the five declares a zvol field,
        // which is checkable against the client rather than assumed.
        const text = await planText({ devices: { rows: [device('NIC', { mac: 'aa:bb' })] } });
        expect(text).toContain('THE SYSTEM LISTED NO DISK DEVICE FOR THIS VIRTUAL MACHINE');
        expect(text).not.toContain('FLOOR');
      });

      it.each([
        ['an unmapped disk kind', device('ISCSI_DISK', { iscsi_target: 'tgt' })],
        ['a configuration that was not a record', { id: 11, vm: 4, attributes: 'nope' }],
        ['a row the system attributed to no machine', { ...device('DISK', {}), vm: null }],
      ])('will not read %s as a machine with no disks', async (_case, row) => {
        // TrueNAS already defines a disk kind this tool does not map, so a
        // silently shorter list is a clone described as free that fills a pool.
        const text = await planText({ devices: { rows: [row] } });
        expect(text).toContain('WHAT THE COPY WILL OCCUPY IS NOT ESTABLISHED HERE');
        expect(text).toContain('NEITHER BE READ AS ONE NOR RULED OUT AS ONE');
        expect(text).toContain('NOT THE SAME ANSWER AS A MACHINE WITH NO DISKS');
      });

      it('will not claim there is no DISK device beside a device it could not read', async () => {
        // The branch a first fix missed: a RAW device keeps the both-empty
        // branch from running, and the "listed no `DISK` device" claim then sat
        // unguarded beside an `ISCSI_DISK` that may well be a zvol-backed disk.
        const text = await planText({
          devices: {
            rows: [
              device('RAW', { path: '/mnt/tank/disk.img', size: 99 }),
              device('ISCSI_DISK', { iscsi_target: 'tgt' }),
            ],
          },
        });
        expect(text).toContain('WHETHER THIS MACHINE HAS ONE IS NOT ESTABLISHED HERE');
        expect(text).not.toContain('The system listed no `DISK` device');
        expect(text).not.toContain('no zvol of its own is expected to be copied');
      });

      it('still says so plainly where every device it did not read was ruled out', async () => {
        const text = await planText({
          devices: {
            rows: [
              device('RAW', { path: '/mnt/tank/disk.img', size: 99 }),
              device('NIC', { mac: 'aa:bb' }),
            ],
          },
        });
        expect(text).toContain('no zvol of its own is expected to be copied');
        expect(text).not.toContain('NOT ESTABLISHED HERE');
      });

      it('makes a figure beside an unreadable device a floor rather than a total', async () => {
        const text = await planText({
          devices: { rows: [zvol('tank/builder-0', 20), device('ISCSI_DISK', { iscsi_target: 't' })] },
        });
        expect(text).toContain('Together they come to 20.');
        expect(text).toContain('1 device on this machine could be NEITHER READ AS A DISK');
        expect(text).toContain('SO ANY FIGURE ABOVE IS A FLOOR AND NOT A TOTAL');
      });

      it('counts each unreadable device rather than reporting only that there was one', async () => {
        expect(
          await planText({
            devices: {
              rows: [
                zvol('tank/builder-0', 20),
                device('ISCSI_DISK', { iscsi_target: 't' }),
                { ...device('DISK', {}), vm: undefined },
              ],
            },
          }),
        ).toContain('2 devices on this machine');
      });
    });

    describe('the name the clone gets', () => {
      it('names the one the caller chose and does not check it is free', async () => {
        const text = await planText({}, { id: 4, name: 'builder-copy' });
        expect(text).toContain('under the name you gave, "builder-copy"');
        expect(text).toContain('THIS PLAN DOES NOT CHECK whether a virtual machine of that name');
      });

      it('marks the derivation unconfirmed where the caller chose none', async () => {
        const text = await planText();
        expect(text).toContain('NO NAME WAS GIVEN, SO THE MIDDLEWARE DERIVES ONE');
        expect(text).toContain('WHAT IT DERIVES IS (unconfirmed) HERE');
        expect(text).toContain('is NOT predictable from this plan');
      });
    });

    it('marks a running machine unconfirmed rather than refusing or reassuring', async () => {
      // #154's finding: a reassuring guess is the costly direction, and the
      // reverse would refuse a plan the middleware would have accepted.
      const text = await planText({ reads: [{ rows: [vm({ status: { state: 'RUNNING' } })] }] });
      expect(text).toContain('IT READ AS `RUNNING` WHEN THIS PLAN WAS MADE');
      expect(text).toContain('neither refuses such a machine nor promises the call is accepted');
    });

    it('adds no running sentence to a machine that read as stopped', async () => {
      expect(await planText()).not.toContain('IT READ AS `RUNNING`');
    });
  });

  describe('execute', () => {
    /** A listing answer: the two fields the projection asks for. */
    const listed = (...rows: Record<string, unknown>[]): Answer => ({ rows });

    it('identifies the clone as the id the second listing named and the first did not', async () => {
      const result = await run({
        reads: [
          listed({ id: 4, name: 'builder' }),
          listed({ id: 4, name: 'builder' }, { id: 7, name: 'builder_clone' }),
        ],
      });
      expect(result).toMatchObject({
        clone_id: 7,
        clone_name: 'builder_clone',
        new_vm_ids: [7],
        source_vm_id: 4,
        source_vm_name: 'builder',
        source_lookup: 'FOUND',
        requested_name: null,
        call_result: true,
        previous_read_error: null,
        resulting_read_error: null,
      });
    });

    it('reports the name the caller asked for beside the one it was listed under', async () => {
      const result = await run(
        {
          reads: [
            listed({ id: 4, name: 'builder' }),
            listed({ id: 4, name: 'builder' }, { id: 7, name: 'builder-copy' }),
          ],
        },
        { id: 4, name: 'builder-copy' },
      );
      expect(result).toMatchObject({ requested_name: 'builder-copy', clone_name: 'builder-copy' });
    });

    it('calls vm.clone with the id and an explicit null where no name was given', async () => {
      const { ctx, call } = cloneSystem();
      await vmClone.execute(ctx, { id: 4 });
      expect(call).toHaveBeenCalledWith('vm.clone', [4, null]);
    });

    it('does not take the identification off the boolean the call answered', async () => {
      // A `true` beside a null `clone_id` is the call reporting success and this
      // tool being unable to say what it made — which is the pair the result
      // exists to keep apart.
      const result = await run({ reads: [listed({ id: 4, name: 'builder' })], answer: true });
      expect(result).toMatchObject({ call_result: true, clone_id: null, new_vm_ids: [] });
    });

    it('reports a false answer without inventing a clone', async () => {
      const result = await run({ reads: [listed({ id: 4, name: 'builder' })], answer: false });
      expect(result).toMatchObject({ call_result: false, clone_id: null });
    });

    it('reads the answer through a guard rather than trusting the declared boolean', async () => {
      expect(await run({ answer: 'yes' })).toMatchObject({ call_result: null });
    });

    it('will not guess which machine is the clone where more than one appeared', async () => {
      const result = await run({
        reads: [
          listed({ id: 4, name: 'builder' }),
          listed({ id: 4, name: 'builder' }, { id: 7, name: 'a' }, { id: 8, name: 'b' }),
        ],
      });
      expect(result).toMatchObject({ clone_id: null, clone_name: null, new_vm_ids: [7, 8] });
    });

    it('nulls new_vm_ids where the first listing could not be read, rather than emptying it', async () => {
      // An empty list there would say no machine appeared, which a difference
      // taken against a listing that does not exist has not established.
      const result = await run({
        reads: [{ fails: new Error('denied') }, listed({ id: 7, name: 'c' })],
      });
      expect(result).toMatchObject({
        new_vm_ids: null,
        clone_id: null,
        source_lookup: 'UNREADABLE',
        source_vm_name: null,
        previous_read_error: 'denied',
        resulting_read_error: null,
      });
    });

    it('nulls new_vm_ids where the listing after the call could not be read', async () => {
      const result = await run({
        reads: [listed({ id: 4, name: 'builder' }), { fails: new Error('socket closed') }],
      });
      expect(result).toMatchObject({
        new_vm_ids: null,
        clone_id: null,
        source_lookup: 'FOUND',
        resulting_read_error: 'socket closed',
      });
    });

    it('makes the call even where the first listing failed', async () => {
      // Branching on a read made at execution time is what the confirmation
      // token cannot bind, and a read that failed is not an approval withdrawn.
      const { ctx, call } = cloneSystem({ reads: [{ fails: new Error('denied') }] });
      await vmClone.execute(ctx, { id: 4 });
      expect(call).toHaveBeenCalledTimes(1);
    });

    it('does not report a clone it could not describe as a failed call', async () => {
      const { ctx } = cloneSystem({ reads: [{ fails: new Error('denied') }] });
      await expect(vmClone.execute(ctx, { id: 4 })).resolves.toBeDefined();
    });

    it('says the source was not listed where the first listing did not name it', async () => {
      const result = await run({ reads: [listed({ id: 9, name: 'other' })] });
      expect(result).toMatchObject({ source_lookup: 'NOT_FOUND', source_vm_name: null });
    });

    it('reports a source the system named nothing for as null rather than empty', async () => {
      const result = await run({ reads: [listed({ id: 4, name: '' })] });
      expect(result).toMatchObject({ source_lookup: 'FOUND', source_vm_name: null });
    });

    it('leaves a row whose id it could not read out of both listings', async () => {
      // Such a row cannot be told from any other row missing an id, so it can
      // neither be the clone nor rule one out.
      const result = await run({
        reads: [listed({ id: 4, name: 'builder' }), listed({ id: 4, name: 'builder' }, { name: 'x' })],
      });
      expect(result).toMatchObject({ new_vm_ids: [], clone_id: null });
    });

    it('reports a clone the system named nothing for as a null name, not a missing one', async () => {
      const result = await run({
        reads: [listed({ id: 4, name: 'builder' }), listed({ id: 4, name: 'builder' }, { id: 7 })],
      });
      expect(result).toMatchObject({ clone_id: 7, clone_name: null });
    });

    it('fails the call where the clone itself was rejected', async () => {
      const { ctx } = cloneSystem({ callFails: new Error('name in use') });
      await expect(vmClone.execute(ctx, { id: 4 })).rejects.toThrow('name in use');
    });

    it('reads and clones on the seams a tool picks per verb', async () => {
      // A tool picks `call` or `query` per verb, so checking one alone would let
      // a read through the other go unnoticed.
      const { ctx, query, call } = cloneSystem();
      await vmClone.execute(ctx, { id: 4 });
      expect(query).toHaveBeenCalledTimes(2);
      expect(call).toHaveBeenCalledTimes(1);
    });
  });
});
