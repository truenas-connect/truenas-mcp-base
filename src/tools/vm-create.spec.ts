import { describe, expect, it, vi } from 'vitest';
import { of, throwError } from 'rxjs';
import { Role } from '@/interfaces';
import type { SystemHandle, ToolContext } from '@/catalog/tool';
import { vmCreate } from '@/tools/index';

/**
 * `vm_create`'s tests have their own spec, as the ticket asked and as
 * `vm-clone.spec.ts` does: `vms.spec.ts` holds the listing tools, and each VM
 * mutation already sits in a file named for it.
 *
 * The fake system is local. `fakeSystem` answers every read of a method from one
 * response, and the plan reads `pool.dataset.query` twice with different
 * questions — the parent, which must exist, and the zvol, which must not — so
 * the fake here honours the `id =` filter. `call` answers by method, and the
 * device calls answer from a queue so one can fail beside the others.
 */
describe('vm_create', () => {
  type Answer = { value: unknown } | { fails: unknown };

  const emit = (answer: Answer) => ('fails' in answer ? throwError(() => answer.fails) : of(answer.value));

  const pool = { name: 'tank', size: 1000 * 2 ** 30, free: 600 * 2 ** 30 };

  interface Options {
    datasets?: Answer;
    interfaces?: Answer;
    pools?: Answer;
    stat?: Answer;
    created?: Answer;
    devices?: Answer[];
    /** Answer `pool.dataset.query` with every row, as a middleware that dropped the filter would. */
    dropFilter?: boolean;
  }

  function createSystem(options: Options = {}): {
    ctx: ToolContext;
    query: ReturnType<typeof vi.fn>;
    call: ReturnType<typeof vi.fn>;
  } {
    const datasets = options.datasets ?? { value: [{ id: 'tank/vms', type: 'FILESYSTEM' }] };
    const query = vi.fn((method: string, filters: unknown[][] = []) => {
      switch (method) {
        case 'pool.dataset.query': {
          if ('fails' in datasets || options.dropFilter === true) return emit(datasets);
          const wanted = filters[0]?.[2];
          return of((datasets.value as Record<string, unknown>[]).filter((row) => row['id'] === wanted));
        }
        case 'interface.query':
          return emit(options.interfaces ?? { value: [{ name: 'eno1' }, { name: 'br0' }] });
        case 'pool.query':
          return emit(options.pools ?? { value: [pool] });
        default:
          throw new Error(`unexpected read ${method}`);
      }
    });
    const deviceAnswers = options.devices ?? [];
    let device = 0;
    const call = vi.fn((method: string, params: unknown[]) => {
      if (method === 'filesystem.stat') return emit(options.stat ?? { value: { type: 'FILE' } });
      if (method === 'vm.create') return emit(options.created ?? { value: { id: 7, name: 'runner', autostart: false } });
      if (method === 'vm.device.create') {
        const answer = deviceAnswers[device];
        device += 1;
        if (answer !== undefined) return emit(answer);
        const attributes = (params[0] as { attributes: Record<string, unknown> }).attributes;
        return of({ id: 20 + device, vm: 7, attributes: { ...attributes, mac: '00:a0:98:11:22:33' } });
      }
      throw new Error(`unexpected call ${method}`);
    });
    const system = { name: 'nas', client: { api: { query, call } } } as unknown as SystemHandle;
    return { ctx: { system }, query, call };
  }

  const args = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    name: 'runner',
    vcpus: 1,
    cores: 4,
    memory: 8192,
    zvol_name: 'tank/vms/runner-disk',
    zvol_volsize: 64 * 2 ** 30,
    nic_attach: 'br0',
    iso_path: '/mnt/tank/isos/installer.iso',
    ...over,
  });

  const plan = (options: Options = {}, over: Record<string, unknown> = {}) =>
    vmCreate.plan(createSystem(options).ctx, args(over));

  const run = async (options: Options = {}, over: Record<string, unknown> = {}) =>
    (await vmCreate.execute(createSystem(options).ctx, args(over))) as Record<string, unknown>;

  it('is a reversible mutating tool needing the full role, whose description says nothing here undoes it', () => {
    expect(vmCreate).toMatchObject({
      name: 'vm_create',
      mutating: true,
      destructiveness: 'reversible',
      requiredRole: Role.Full,
    });
    expect(vmCreate.description).toContain('NO TOOL HERE DOES EITHER');
    expect(vmCreate.resultGuidance).toBeDefined();
  });

  it('has no autostart, cpu_mode, command_line_args, passthrough, display or existing-disk field', () => {
    const schema = vmCreate.inputSchema as { properties: Record<string, unknown>; required: string[] };
    expect(Object.keys(schema.properties)).toEqual([
      'name',
      'description',
      'vcpus',
      'cores',
      'threads',
      'memory',
      'bootloader',
      'zvol_name',
      'zvol_volsize',
      'nic_attach',
      'iso_path',
    ]);
    expect(schema.required).toEqual(['name', 'vcpus', 'memory', 'zvol_name', 'zvol_volsize', 'nic_attach']);
  });

  it.each([
    ['autostart', true],
    ['ensure_display_device', true],
    ['cpu_mode', 'HOST-PASSTHROUGH'],
    ['command_line_args', '-x'],
    ['pptdev', 'pci_0000_01_00_0'],
    ['display', {}],
    ['path', '/dev/zvol/tank/old'],
  ])('refuses %s by name rather than dropping it', (key, value) => {
    expect(() => vmCreate.normalizeArgs?.(args({ [key]: value }))).toThrow(`"${key}" is not accepted`);
  });

  it.each([
    [{ name: '' }, '"name" is required'],
    [{ name: undefined }, '"name" is required'],
    [{ description: '' }, '"description" must be non-empty'],
    [{ vcpus: 0 }, '"vcpus" is required and must be a whole number'],
    [{ cores: 1.5 }, '"cores" must be a whole number'],
    [{ memory: '8192' }, '"memory" is required'],
    [{ zvol_volsize: -1 }, '"zvol_volsize" is required'],
    [{ nic_attach: undefined }, '"nic_attach" is required'],
    [{ zvol_name: 'runner-disk' }, 'is not a zvol name under a parent'],
    [{ zvol_name: 'tank//runner' }, 'is not a zvol name under a parent'],
    [{ zvol_name: 'tank/vms/runner@disk' }, 'has a character ZFS does not accept'],
    [{ bootloader: 'BIOS' }, '"bootloader" must be one of UEFI, UEFI_CSM'],
    [{ iso_path: 'isos/installer.iso' }, '"iso_path" must be an absolute path'],
  ])('refuses %o', (over, message) => {
    expect(() => vmCreate.normalizeArgs?.(args(over))).toThrow(message);
  });

  it('normalizes to every argument under its own name, with the defaults and the omissions spelled out', () => {
    expect(vmCreate.normalizeArgs?.(args({ iso_path: null, cores: undefined }))).toEqual({
      name: 'runner',
      description: null,
      vcpus: 1,
      cores: 1,
      threads: 1,
      memory: 8192,
      bootloader: null,
      zvol_name: 'tank/vms/runner-disk',
      zvol_volsize: 64 * 2 ** 30,
      nic_attach: 'br0',
      iso_path: null,
    });
  });

  describe('plan', () => {
    it('names every call execute makes, in order, with autostart and ensure_display_device sent as false', async () => {
      const steps = await plan({}, { bootloader: 'UEFI', description: 'test runner' });
      expect(steps.map((step) => step.method)).toEqual([
        'vm.create',
        'vm.device.create',
        'vm.device.create',
        'vm.device.create',
      ]);
      expect(steps[0].params).toEqual([
        {
          name: 'runner',
          description: 'test runner',
          vcpus: 1,
          cores: 4,
          threads: 1,
          memory: 8192,
          bootloader: 'UEFI',
          autostart: false,
          ensure_display_device: false,
        },
      ]);
      expect(steps.slice(1).map((step) => (step.params as { attributes: unknown }[])[0].attributes)).toEqual([
        { dtype: 'DISK', create_zvol: true, zvol_name: 'tank/vms/runner-disk', zvol_volsize: 64 * 2 ** 30 },
        { dtype: 'NIC', nic_attach: 'br0' },
        { dtype: 'CDROM', path: '/mnt/tank/isos/installer.iso' },
      ]);
      expect(steps[1].params).toEqual([expect.objectContaining({ vm: '(the id the vm.create call answers with)' })]);
      expect(steps[0].description).toContain('4 vCPUs');
      expect(steps[0].description).toContain('NOTHING IS ROLLED BACK');
      expect(steps[0].description).toContain('`bootloader` UEFI.');
    });

    it('leaves out the description, the bootloader and the CDROM where none was asked for', async () => {
      const steps = await plan({}, { iso_path: undefined });
      expect(steps).toHaveLength(3);
      expect(steps[0].params).toEqual([expect.not.objectContaining({ bootloader: expect.anything() })]);
      expect(steps[0].params).toEqual([expect.not.objectContaining({ description: expect.anything() })]);
      expect(steps[0].description).toContain("the system's default is used");
    });

    it('states memory with no unit asserted', async () => {
      const [create] = await plan();
      expect(create.description).toContain('`memory` 8192, sent as given');
      expect(create.description).toContain('(unconfirmed)');
    });

    it('fails on a parent dataset that does not exist, naming it', async () => {
      await expect(plan({ datasets: { value: [] } })).rejects.toThrow(
        'Parent dataset "tank/vms" of zvol "tank/vms/runner-disk" does not exist',
      );
    });

    it('fails on a parent that is a volume', async () => {
      await expect(plan({ datasets: { value: [{ id: 'tank/vms', type: 'VOLUME' }] } })).rejects.toThrow(
        'is a volume',
      );
    });

    it('fails on a zvol name that already exists, naming it', async () => {
      await expect(
        plan({ datasets: { value: [{ id: 'tank/vms' }, { id: 'tank/vms/runner-disk', type: 'VOLUME' }] } }),
      ).rejects.toThrow('A dataset named "tank/vms/runner-disk" already exists');
    });

    it('matches the dataset by id on the response, not by the filter alone', async () => {
      // A filter the middleware dropped answers with every dataset; a row count
      // would read the zvol as taken.
      await expect(
        plan({ datasets: { value: [{ id: 'tank/vms' }, { id: 'tank/other' }] }, dropFilter: true }),
      ).resolves.toHaveLength(4);
    });

    it('fails where the datasets could not be read', async () => {
      await expect(plan({ datasets: { fails: new Error('denied') } })).rejects.toThrow(
        'Parent dataset "tank/vms" could not be read (pool.dataset.query failed: denied)',
      );
    });

    it('fails on a NIC interface the system does not list, naming it', async () => {
      await expect(plan({}, { nic_attach: 'eth9' })).rejects.toThrow(
        'The system lists no network interface named "eth9"',
      );
    });

    it('fails where the interfaces could not be listed', async () => {
      await expect(plan({ interfaces: { fails: new Error('timeout') } })).rejects.toThrow(
        'interface.query failed: timeout',
      );
      await expect(plan({ interfaces: { value: { name: 'br0' } } })).rejects.toThrow(
        'something other than a list',
      );
    });

    it('fails on an ISO path that does not stat, naming it', async () => {
      await expect(plan({ stat: { fails: new Error('No such file') } })).rejects.toThrow(
        'The ISO path "/mnt/tank/isos/installer.iso" could not be read (filesystem.stat failed: No such file)',
      );
    });

    it('fails on an ISO path that is a directory', async () => {
      await expect(plan({ stat: { value: { type: 'DIRECTORY' } } })).rejects.toThrow('is a directory');
    });

    it('states the type the stat read, or that it stated none', async () => {
      expect((await plan())[3].description).toContain('read as `FILE`');
      expect((await plan({ stat: { value: {} } }))[3].description).toContain('without stating its type');
    });

    it('states the zvol size against the pool free space', async () => {
      const disk = (await plan())[1].description;
      expect(disk).toContain('The zvol is 68719476736 bytes (64 GiB), against 644245094400 bytes (600 GiB) free');
      expect(disk).toContain('leave 575525617664 bytes (536 GiB) free of the pool');
      expect(disk).not.toContain('UNDER 20%');
    });

    it('warns where the zvol would leave under 20% of the pool free', async () => {
      const disk = (await plan({}, { zvol_volsize: 500 * 2 ** 30 }))[1].description;
      expect(disk).toContain('UNDER 20% OF THE POOL');
    });

    it('warns where the zvol is larger than the free space, and says what a refusal would cost', async () => {
      const disk = (await plan({}, { zvol_volsize: 700 * 2 ** 30 }))[1].description;
      expect(disk).toContain("LARGER THAN THE POOL'S FREE SPACE");
      expect(disk).toContain('without its disk');
    });

    it('states the free space where the pool size could not be read', async () => {
      const disk = (await plan({ pools: { value: [{ ...pool, size: null }] } }))[1].description;
      expect(disk).toContain("the pool's own size could not be read");
    });

    it('does not fail the plan where the pool could not be read, and says so', async () => {
      expect((await plan({ pools: { fails: new Error('busy') } }))[1].description).toContain(
        'THE FREE SPACE OF POOL "tank" COULD NOT BE READ (busy)',
      );
      expect((await plan({ pools: { value: [] } }))[1].description).toContain('listed no pool named "tank"');
      expect((await plan({ pools: { value: [{ ...pool, free: null }] } }))[1].description).toContain(
        'reported no `free`',
      );
    });
  });

  describe('execute', () => {
    it('creates the machine then each device, and reports ids and the MAC read from the answers', async () => {
      const { ctx, call } = createSystem();
      const result = (await vmCreate.execute(ctx, args())) as Record<string, unknown>;
      expect(call.mock.calls.map(([method]) => method)).toEqual([
        'vm.create',
        'vm.device.create',
        'vm.device.create',
        'vm.device.create',
      ]);
      expect(call.mock.calls[1][1]).toEqual([
        {
          vm: 7,
          attributes: {
            dtype: 'DISK',
            create_zvol: true,
            zvol_name: 'tank/vms/runner-disk',
            zvol_volsize: 64 * 2 ** 30,
          },
        },
      ]);
      expect(result).toMatchObject({
        vm_id: 7,
        vm_name: 'runner',
        autostart: false,
        complete: true,
        failed_devices: [],
      });
      expect(result['created_devices']).toEqual([
        {
          kind: 'DISK',
          device_id: 21,
          zvol_name: 'tank/vms/runner-disk',
          zvol_volsize: 64 * 2 ** 30,
          path: null,
        },
        { kind: 'NIC', device_id: 22, nic_attach: 'br0', mac: '00:a0:98:11:22:33' },
        { kind: 'CDROM', device_id: 23, path: '/mnt/tank/isos/installer.iso' },
      ]);
    });

    it('reports a device that failed after the machine was made, without throwing, and still makes the rest', async () => {
      const result = await run({ devices: [{ fails: new Error('insufficient space') }] });
      expect(result['vm_id']).toBe(7);
      expect(result['complete']).toBe(false);
      expect(result['failed_devices']).toEqual([{ kind: 'DISK', error: 'insufficient space' }]);
      expect((result['created_devices'] as { kind: string }[]).map((device) => device.kind)).toEqual([
        'NIC',
        'CDROM',
      ]);
    });

    it('reads every device field as null where the answer carried none', async () => {
      const result = await run({ devices: [{ value: null }, { value: { id: 'x' } }] }, { iso_path: undefined });
      expect(result['created_devices']).toEqual([
        { kind: 'DISK', device_id: null, zvol_name: null, zvol_volsize: null, path: null },
        { kind: 'NIC', device_id: null, nic_attach: null, mac: null },
      ]);
      expect(result['complete']).toBe(true);
    });

    it('attempts no device where the machine answered with no id, and says it may still exist', async () => {
      const { ctx, call } = createSystem({ created: { value: { name: 'runner' } } });
      const result = (await vmCreate.execute(ctx, args())) as Record<string, unknown>;
      expect(call).toHaveBeenCalledTimes(1);
      expect(result['vm_id']).toBeNull();
      expect(result['complete']).toBe(false);
      expect(result['failed_devices']).toHaveLength(3);
      expect((result['failed_devices'] as { error: string }[])[0].error).toContain('may still exist');
    });

    it('fails only where vm.create itself is refused, and then makes nothing else', async () => {
      const { ctx, call } = createSystem({ created: { fails: new Error('name in use') } });
      await expect(vmCreate.execute(ctx, args())).rejects.toThrow('name in use');
      expect(call).toHaveBeenCalledTimes(1);
    });

    it('deletes nothing on any path', async () => {
      const { ctx, call } = createSystem({ devices: [{ fails: new Error('x') }, { fails: new Error('y') }] });
      await vmCreate.execute(ctx, args());
      expect(call.mock.calls.map(([method]) => method)).not.toContain('vm.delete');
      expect(call.mock.calls.map(([method]) => method)).not.toContain('vm.device.delete');
      expect(call.mock.calls.map(([method]) => method)).not.toContain('pool.dataset.delete');
    });

    it('makes no read: every check is plan-time only', async () => {
      const { ctx, query } = createSystem();
      await vmCreate.execute(ctx, args());
      expect(query).not.toHaveBeenCalled();
    });
  });
});
