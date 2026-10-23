import { describe, expect, it, vi } from 'vitest';
import { concat, NEVER, Observable, of, throwError } from 'rxjs';
import { Role } from '@/interfaces';
import type { SystemHandle, ToolContext } from '@/catalog/tool';
import { vmDiskImageImport } from '@/tools/index';

/**
 * `vm_disk_image_import`'s tests have their own spec, as every VM mutation's
 * does. The fake system is local for `vm-create.spec.ts`'s reason — the plan
 * reads `pool.dataset.query` twice with different questions, so the fake
 * honours the `id =` filter — and for `vm-stop.spec.ts`'s: the conversion is a
 * job, so the correlation and the tracking move independently.
 */
describe('vm_disk_image_import', () => {
  type Answer = { value: unknown } | { fails: unknown };

  const emit = (answer: Answer) => ('fails' in answer ? throwError(() => answer.fails) : of(answer.value));

  const pool = { name: 'tank', size: 1000 * 2 ** 30, free: 600 * 2 ** 30 };

  /** A job as the client's tracking emits one. */
  const jobAt = (state: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: 91,
    method: 'vm.device.convert',
    state,
    result: state === 'SUCCESS' ? true : null,
    error: null,
    time_finished: { $date: 1_756_000_000_000 },
    ...extra,
  });

  interface Options {
    datasets?: Answer;
    pools?: Answer;
    stat?: Answer;
    created?: Answer;
    started?: Observable<number>;
    job?: Observable<unknown>;
  }

  function importSystem(options: Options = {}): {
    ctx: ToolContext;
    call: ReturnType<typeof vi.fn>;
    start: ReturnType<typeof vi.fn>;
  } {
    const datasets = options.datasets ?? { value: [{ id: 'tank/vms', type: 'FILESYSTEM' }] };
    const query = vi.fn((method: string, filters: unknown[][] = []) => {
      switch (method) {
        case 'pool.dataset.query': {
          if ('fails' in datasets) return emit(datasets);
          const wanted = filters[0]?.[2];
          return of((datasets.value as Record<string, unknown>[]).filter((row) => row['id'] === wanted));
        }
        case 'pool.query':
          return emit(options.pools ?? { value: [pool] });
        default:
          throw new Error(`unexpected read ${method}`);
      }
    });
    const call = vi.fn((method: string) => {
      if (method === 'filesystem.stat') return emit(options.stat ?? { value: { type: 'FILE', size: 2 * 2 ** 30 } });
      if (method === 'pool.dataset.create') return emit(options.created ?? { value: { id: 'tank/vms/imported' } });
      throw new Error(`unexpected call ${method}`);
    });
    const start = vi.fn(() => options.started ?? of(91));
    const track = vi.fn(() => options.job ?? of(jobAt('SUCCESS')));
    const system = {
      name: 'nas',
      client: { api: { query, call, callAndGetJobId: start, trackJob: track } },
    } as unknown as SystemHandle;
    return { ctx: { system }, call, start };
  }

  const args = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    image_path: '/mnt/tank/images/disk.qcow2',
    zvol: 'tank/vms/imported',
    zvol_volsize: 32 * 2 ** 30,
    ...over,
  });

  const plan = (options: Options = {}, over: Record<string, unknown> = {}) =>
    vmDiskImageImport.plan(importSystem(options).ctx, args(over));

  const run = async (options: Options = {}, over: Record<string, unknown> = {}) =>
    (await vmDiskImageImport.execute(importSystem(options).ctx, args(over))) as Record<string, unknown>;

  it('is a reversible mutating tool needing the full role, whose description says nothing here undoes it', () => {
    expect(vmDiskImageImport).toMatchObject({
      name: 'vm_disk_image_import',
      mutating: true,
      destructiveness: 'reversible',
      requiredRole: Role.Full,
    });
    expect(vmDiskImageImport.description).toContain('NO TOOL HERE DOES THAT');
    expect(vmDiskImageImport.resultGuidance).toBeDefined();
  });

  it('takes the image, the zvol and its size, and no source or destination', () => {
    const schema = vmDiskImageImport.inputSchema as { properties: Record<string, unknown>; required: string[] };
    expect(Object.keys(schema.properties)).toEqual(['image_path', 'zvol', 'zvol_volsize']);
    expect(schema.required).toEqual(['image_path', 'zvol', 'zvol_volsize']);
    for (const key of ['source', 'destination']) {
      expect(() => vmDiskImageImport.normalizeArgs?.(args({ [key]: '/mnt/tank/x.raw' }))).toThrow(
        `"${key}" is not accepted`,
      );
    }
  });

  it.each([
    [{ image_path: '' }, '"image_path" is required'],
    [{ image_path: 'tank/images/disk.qcow2' }, "under a pool's mountpoint"],
    [{ image_path: '/mnt/disk.qcow2' }, "under a pool's mountpoint"],
    [{ image_path: '/mnt//disk.qcow2' }, "under a pool's mountpoint"],
    [{ image_path: '/mnt/tank/images/disk.iso' }, 'does not end in qcow2, qed, raw, vdi, vhdx, vmdk'],
    [{ image_path: '/mnt/tank/images/disk.QCOW2' }, 'does not end in'],
    [{ zvol: 'imported' }, 'is not a zvol name under a parent'],
    [{ zvol: 'tank//imported' }, 'is not a zvol name under a parent'],
    [{ zvol: 'tank/vms/bad*name' }, 'a character ZFS does not accept'],
    [{ zvol: 'tank/vms/disk.RAW' }, 'ends like a disk image file'],
    [{ zvol_volsize: 0 }, '"zvol_volsize" is required and must be a whole number'],
    [{ zvol_volsize: undefined }, '"zvol_volsize" is required'],
  ])('refuses %o', (over, message) => {
    expect(() => vmDiskImageImport.normalizeArgs?.(args(over))).toThrow(message);
  });

  it('normalizes to the arguments under their own names', () => {
    expect(vmDiskImageImport.normalizeArgs?.(args())).toEqual({
      image_path: '/mnt/tank/images/disk.qcow2',
      zvol: 'tank/vms/imported',
      zvol_volsize: 32 * 2 ** 30,
    });
  });

  describe('plan', () => {
    it('names the create and then the conversion, with the source and destination built here', async () => {
      const steps = await plan();
      expect(steps.map((step) => step.method)).toEqual(['pool.dataset.create', 'vm.device.convert']);
      expect(steps[0]?.params).toEqual([{ name: 'tank/vms/imported', type: 'VOLUME', volsize: 32 * 2 ** 30 }]);
      expect(steps[1]?.params).toEqual([
        { source: '/mnt/tank/images/disk.qcow2', destination: '/dev/zvol/tank/vms/imported' },
      ]);
    });

    it('states the zvol against the pool, the race, and that nothing is rolled back', async () => {
      const [create] = await plan();
      expect(create?.description).toContain('Its parent "tank/vms" exists');
      expect(create?.description).toContain('(600 GiB) free on pool "tank"');
      expect(create?.description).toContain('a dataset of that name made since makes this call fail');
      expect(create?.description).toContain('NO TOOL IN THIS CATALOG DELETES A ZVOL');
    });

    it("says the file's size is not the virtual size for a format other than raw", async () => {
      const [, convert] = await plan();
      expect(convert?.description).toContain('2147483648 bytes (2 GiB) long');
      expect(convert?.description).toContain('NOT the virtual size');
      expect(convert?.description).toContain('AFTER THE ZVOL ABOVE HAS BEEN MADE');
      expect(convert?.description).toContain('vm_device_convert.py');
      expect(convert?.description).toContain('for at most 30 seconds');
      expect(convert?.description).toContain('`tasks_recent_runs`');
    });

    it('says a raw image is its virtual size, and refuses a zvol smaller than it', async () => {
      const [, convert] = await plan({}, { image_path: '/mnt/tank/images/disk.raw' });
      expect(convert?.description).toContain("A raw image's virtual size is its file size");
      await expect(plan({}, { image_path: '/mnt/tank/images/disk.raw', zvol_volsize: 2 ** 30 })).rejects.toThrow(
        'is smaller: the middleware refuses a zvol smaller than the image',
      );
    });

    it('does not refuse a small zvol for a compressed format, or a raw image whose size was not read', async () => {
      await expect(plan({}, { zvol_volsize: 2 ** 30 })).resolves.toHaveLength(2);
      const steps = await plan(
        { stat: { value: { type: 'FILE' } } },
        { image_path: '/mnt/tank/images/disk.raw', zvol_volsize: 1 },
      );
      expect(steps[1]?.description).toContain('as `FILE` and without a size this tool could read');
      const [, convert] = await plan({ stat: { value: {} } });
      expect(convert?.description).toContain('without stating its type');
    });

    it('fails naming a zvol that already exists', async () => {
      const datasets = { value: [{ id: 'tank/vms', type: 'FILESYSTEM' }, { id: 'tank/vms/imported' }] };
      await expect(plan({ datasets })).rejects.toThrow(
        'A dataset named "tank/vms/imported" already exists on this system. This tool converts into a NEW zvol',
      );
    });

    it('fails naming a parent that does not exist, and one that cannot be read', async () => {
      await expect(plan({ datasets: { value: [] } })).rejects.toThrow('Parent dataset "tank/vms"');
      await expect(plan({ datasets: { fails: new Error('down') } })).rejects.toThrow(
        'Parent dataset "tank/vms" could not be read',
      );
    });

    it('fails naming an image that does not stat, or is a directory', async () => {
      await expect(plan({ stat: { fails: new Error('[ENOENT] no such file') } })).rejects.toThrow(
        'The image "/mnt/tank/images/disk.qcow2" could not be read',
      );
      await expect(plan({ stat: { value: { type: 'DIRECTORY' } } })).rejects.toThrow('is a directory');
    });

    it('does not refuse where the free space could not be read, and says so', async () => {
      const [create] = await plan({ pools: { fails: new Error('down') } });
      expect(create?.description).toContain('COULD NOT BE READ');
    });

    it('says what a zvol larger than the free space would cost', async () => {
      const [create] = await plan({}, { zvol_volsize: 700 * 2 ** 30 });
      expect(create?.description).toContain('THIS CALL IS REFUSED, and nothing is made.');
    });
  });

  describe('execute', () => {
    it('makes the zvol, converts into it and reports a job that ended', async () => {
      const { ctx, call, start } = importSystem();
      const result = (await vmDiskImageImport.execute(ctx, args())) as Record<string, unknown>;
      expect(call).toHaveBeenCalledWith('pool.dataset.create', [
        { name: 'tank/vms/imported', type: 'VOLUME', volsize: 32 * 2 ** 30 },
      ]);
      expect(start).toHaveBeenCalledWith('vm.device.convert', [
        { source: '/mnt/tank/images/disk.qcow2', destination: '/dev/zvol/tank/vms/imported' },
      ]);
      expect(result).toMatchObject({
        zvol: 'tank/vms/imported',
        zvol_created: true,
        zvol_id: 'tank/vms/imported',
        convert_error: null,
        job_id: 91,
        ended: true,
        succeeded: true,
        job_state: 'SUCCESS',
        convert_result: true,
        watched_seconds: 30,
        complete: true,
      });
    });

    it('fails, converting nothing, where the zvol could not be made', async () => {
      const { ctx, start } = importSystem({ created: { fails: new Error('dataset already exists') } });
      await expect(vmDiskImageImport.execute(ctx, args())).rejects.toThrow('dataset already exists');
      expect(start).not.toHaveBeenCalled();
    });

    it('reports a conversion refused before any job, naming the zvol, rather than throwing', async () => {
      const result = await run({ started: throwError(() => new Error('[ENOSPC] too small')) });
      expect(result).toMatchObject({
        zvol: 'tank/vms/imported',
        zvol_created: true,
        convert_error: '[ENOSPC] too small',
        job_id: null,
        ended: false,
        succeeded: null,
        convert_result: null,
        complete: false,
      });
    });

    it('reports a job that failed as data, with the outcome from its state and not its boolean', async () => {
      const result = await run({ job: of(jobAt('FAILED', { error: 'qemu-img failed', result: true })) });
      expect(result).toMatchObject({
        zvol_created: true,
        ended: true,
        succeeded: false,
        error: 'qemu-img failed',
        convert_result: true,
        complete: false,
      });
    });

    it('reads a zvol id it cannot read as null', async () => {
      expect(await run({ created: { value: null } })).toMatchObject({ zvol_id: null, zvol_created: true });
    });

    it('reports a conversion still going when the watch runs out', async () => {
      vi.useFakeTimers();
      try {
        const { ctx } = importSystem({ job: concat(of(jobAt('RUNNING')), NEVER) });
        const pending = vmDiskImageImport.execute(ctx, args());
        await vi.advanceTimersByTimeAsync(30_000);
        expect(await pending).toMatchObject({
          job_id: 91,
          ended: false,
          succeeded: null,
          job_state: 'RUNNING',
          convert_result: null,
          complete: false,
        });
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
