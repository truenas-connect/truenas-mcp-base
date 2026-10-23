import { describe, expect, it, vi } from 'vitest';
import { of, throwError } from 'rxjs';
import { SystemHandle, ToolContext } from '@/catalog/tool';
import { diskIdentify } from '@/tools/disks';

/** One `enclosure2.query` slot element, in the keys the middleware source sets. */
function slotElement(dev: string | null, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    descriptor: 'slot03',
    status: 'OK',
    dev,
    supports_identify_light: true,
    drive_bay_light_status: 'OFF',
    original: { enclosure_id: '5003048001c1043f', slot: 3 },
    ...extra,
  };
}

function enclosure(id: string, slots: Record<string, unknown>, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, name: 'CELESTIC P3215-O', label: 'Front shelf', model: 'M50', elements: { 'Array Device Slot': slots }, ...extra };
}

const DISKS = [
  { name: 'sda', serial: 'ZA1A', model: 'ST4000', pool: 'tank', enclosure: null },
  { name: 'sdb', serial: 'ZB2B', model: 'ST8000', pool: 'tank', enclosure: { number: 7, slot: 99 } },
];

const ENCLOSURES = [
  enclosure('5003048001c1043f', { '1': slotElement('sda'), '3': slotElement('sdb'), '4': slotElement(null) }),
];

/**
 * A system whose `disk.query` honours the `name =` filter and whose
 * `enclosure2.query` answers from a queue, so the read before the call and the
 * read after it can differ.
 */
function identifySystem(
  options: {
    disks?: unknown;
    enclosures?: unknown[];
    ignoreFilter?: boolean;
    enclosureFailure?: (attempt: number) => unknown;
    callFailure?: unknown;
  } = {},
): { ctx: ToolContext; call: ReturnType<typeof vi.fn>; query: ReturnType<typeof vi.fn> } {
  const disks = options.disks ?? DISKS;
  const answers = options.enclosures ?? [ENCLOSURES];
  let attempt = 0;
  const call = vi.fn(() => (options.callFailure === undefined ? of(null) : throwError(() => options.callFailure)));
  const query = vi.fn((method: string, filters: unknown[] = []) => {
    if (method === 'disk.query') {
      const [filter] = filters as [string, string, unknown][];
      if (options.ignoreFilter || filter === undefined || !Array.isArray(disks)) return of(disks);
      return of(disks.filter((row: Record<string, unknown>) => row['name'] === filter[2]));
    }
    const failure = options.enclosureFailure?.(attempt);
    const answer = answers[Math.min(attempt, answers.length - 1)];
    attempt += 1;
    return failure === undefined ? of(answer) : throwError(() => failure);
  });
  const system = { name: 'nas', client: { api: { call, query } } } as unknown as SystemHandle;
  return { ctx: { system }, call, query };
}

const ARGS = { disk: 'sdb', on: true };

describe('disk_identify', () => {
  const plan = (args: Record<string, unknown> = {}, system = identifySystem()) =>
    diskIdentify.plan(system.ctx, { ...ARGS, ...args });
  const execute = (args: Record<string, unknown> = {}, system = identifySystem()) =>
    diskIdentify.execute(system.ctx, { ...ARGS, ...args });

  describe('arguments', () => {
    it('takes disk and on, both required, and on strictly boolean', () => {
      const schema = diskIdentify.inputSchema['properties'] as Record<string, unknown>;
      expect(Object.keys(schema)).toEqual(['disk', 'on']);
      expect(diskIdentify.inputSchema['required']).toEqual(['disk', 'on']);
      expect(diskIdentify.normalizeArgs?.({ disk: 'sdb', on: false, extra: 1 })).toEqual({ disk: 'sdb', on: false });
      expect(() => diskIdentify.normalizeArgs?.({ on: true })).toThrow('"disk" is required');
      expect(() => diskIdentify.normalizeArgs?.({ disk: 'sdb' })).toThrow('"on" is required and must be a boolean');
      expect(() => diskIdentify.normalizeArgs?.({ disk: 'sdb', on: 'true' })).toThrow('"on" is required');
    });

    it('is a full-access, reversible mutation carrying its result guidance', () => {
      expect(diskIdentify.mutating).toBe(true);
      expect(diskIdentify.destructiveness).toBe('reversible');
      expect(diskIdentify.description).toContain(diskIdentify.resultGuidance as string);
      expect(diskIdentify.description).toContain('A DISK NO ENCLOSURE SLOT LISTS FAILS THE PLAN');
    });
  });

  describe('plan', () => {
    it('reads the enclosures, then sets the slot the disk sits in', async () => {
      const steps = await plan();
      expect(steps.map((step) => step.method)).toEqual(['enclosure2.query', 'enclosure2.set_slot_status']);
      expect(steps[0]?.params).toEqual([]);
      expect(steps[0]?.description).toContain('made again immediately after the call');
      expect(steps[1]?.params).toEqual([{ enclosure_id: '5003048001c1043f', slot: 3, status: 'ON' }]);
      expect(diskIdentify.normalizeArgs).toBeDefined();
      const off = await plan({ on: false });
      expect(off[1]?.params).toEqual([{ enclosure_id: '5003048001c1043f', slot: 3, status: 'OFF' }]);
    });

    /**
     * The mapping the ticket asked to be pinned. `disk.query`'s `enclosure` is a
     * database column nothing in the middleware's disk sync writes, and no
     * `enclosure2.query` entry has a `number` to map it from — so the slot is the
     * one whose `dev` is the disk, and the id is that entry's `id`. `sdb`'s
     * `enclosure` above says number 7, slot 99, and is not what is sent.
     */
    it('finds the slot by the device name in enclosure2.query, not by disk.query enclosure', async () => {
      const steps = await plan();
      expect(steps[1]?.params).toEqual([{ enclosure_id: '5003048001c1043f', slot: 3, status: 'ON' }]);
      // A disk whose `enclosure` is null is still found where a slot lists it.
      const sda = await plan({ disk: 'sda' });
      expect(sda[1]?.params).toEqual([{ enclosure_id: '5003048001c1043f', slot: 1, status: 'ON' }]);
    });

    it('names the serial, model, pool membership, enclosure and slot', async () => {
      const description = (await plan())[1]?.description as string;
      expect(description).toContain('slot 3 of enclosure "5003048001c1043f" ("Front shelf")');
      expect(description).toContain('disk "sdb", serial ZB2B, model ST8000; it is a member of pool "tank"');
      expect(description).toContain('Its locate state reads OFF now.');
    });

    it('keeps "in no pool" apart from "membership not reported"', async () => {
      const inNoPool = identifySystem({ disks: [{ name: 'sdb', serial: null, model: null, pool: null }] });
      const description = (await plan({}, inNoPool))[1]?.description as string;
      expect(description).toContain('serial (not reported), model (not reported); it is in no pool');
      const unreported = identifySystem({ disks: [{ name: 'sdb', serial: 'ZB2B', model: 'ST8000' }] });
      expect((await plan({}, unreported))[1]?.description).toContain('the system did not report its pool membership');
    });

    it('fails naming a disk the system does not list, and never takes the first row of an unfiltered answer', async () => {
      await expect(plan({ disk: 'sdz' })).rejects.toThrow('No disk named "sdz" on this system');
      await expect(plan({ disk: 'sdz' }, identifySystem({ ignoreFilter: true }))).rejects.toThrow('No disk named "sdz"');
      const unfiltered = await plan({}, identifySystem({ ignoreFilter: true }));
      expect(unfiltered[1]?.description).toContain('serial ZB2B');
      await expect(plan({}, identifySystem({ disks: { name: 'sdb' } }))).rejects.toThrow(
        'something other than a list of disks',
      );
    });

    it('fails where no enclosure slot lists the disk, saying the system reports none', async () => {
      const bare = identifySystem({ enclosures: [[]] });
      await expect(plan({}, bare)).rejects.toThrow(
        'The system reports no managed enclosure slot for disk "sdb". A system or disk without a managed enclosure',
      );
      const partly = identifySystem({ enclosures: [[enclosure('x', {}), { id: 'y', elements: null }, 'junk']] });
      await expect(plan({}, partly)).rejects.toThrow('but 2 enclosure entries could not be read in full');
      const onePart = identifySystem({ enclosures: [[{ id: 'y', elements: {} }]] });
      await expect(plan({}, onePart)).rejects.toThrow('but 1 enclosure entry could not be read in full');
      await expect(plan({}, identifySystem({ enclosures: [{}] }))).rejects.toThrow(
        'something other than a list of enclosures',
      );
    });

    it('refuses a disk listed in two slots rather than choosing one', async () => {
      const twice = identifySystem({
        enclosures: [[...ENCLOSURES, enclosure('rear', { '0': slotElement('sdb') })]],
      });
      await expect(plan({}, twice)).rejects.toThrow('listed in 2 enclosure slots');
    });

    it('refuses a slot it cannot name', async () => {
      const noId = identifySystem({ enclosures: [[enclosure('x', { '3': slotElement('sdb') }, { id: null })]] });
      await expect(plan({}, noId)).rejects.toThrow('listed in an enclosure whose id could not be read');
      const badKey = identifySystem({ enclosures: [[enclosure('x', { front3: slotElement('sdb') })]] });
      await expect(plan({}, badKey)).rejects.toThrow('listed in a slot keyed "front3"');
    });

    it('refuses a slot that reports no identify support, and only says so where support is unread', async () => {
      const unsupported = identifySystem({
        enclosures: [[enclosure('x', { '3': slotElement('sdb', { supports_identify_light: false }) })]],
      });
      await expect(plan({}, unsupported)).rejects.toThrow('does not support an identify light');
      const unknown = identifySystem({
        enclosures: [[enclosure('x', { '3': slotElement('sdb', { supports_identify_light: null }) })]],
      });
      expect((await plan({}, unknown))[1]?.description).toContain('the middleware may refuse the call');
    });

    it('says when the light already reads the target, and when no state was reported', async () => {
      const lit = identifySystem({
        enclosures: [[enclosure('x', { '3': slotElement('sdb', { drive_bay_light_status: 'ON' }) })]],
      });
      expect((await plan({}, lit))[1]?.description).toContain('already reads ON, which is not an error');
      const silent = identifySystem({
        enclosures: [[enclosure('x', { '3': slotElement('sdb', { drive_bay_light_status: null }) })]],
      });
      expect((await plan({}, silent))[1]?.description).toContain('whether the light is on now was not read');
      const unlabelled = identifySystem({ enclosures: [[enclosure('x', { '3': slotElement('sdb') }, { label: null })]] });
      expect((await plan({}, unlabelled))[1]?.description).toContain('slot 3 of enclosure "x" ON. That slot');
    });
  });

  describe('execute', () => {
    const lit = [enclosure('5003048001c1043f', { '3': slotElement('sdb', { drive_bay_light_status: 'ON' }) })];

    it('sends the call the plan named and confirms it from the read after', async () => {
      const system = identifySystem({ enclosures: [ENCLOSURES, lit] });
      const result = await execute({}, system);
      expect(system.call).toHaveBeenCalledWith('enclosure2.set_slot_status', [
        { enclosure_id: '5003048001c1043f', slot: 3, status: 'ON' },
      ]);
      expect(system.query).not.toHaveBeenCalledWith('disk.query', expect.anything(), expect.anything());
      expect(result).toEqual({
        disk: 'sdb',
        enclosure_id: '5003048001c1043f',
        slot: 3,
        requested: 'ON',
        previous_light: 'OFF',
        resulting_light: 'ON',
        resulting_lookup: 'FOUND',
        resulting_read_error: null,
        confirmed: true,
      });
      const off = identifySystem({ enclosures: [lit, ENCLOSURES] });
      expect(await execute({ on: false }, off)).toMatchObject({
        requested: 'OFF',
        previous_light: 'ON',
        resulting_light: 'OFF',
        confirmed: true,
      });
      expect(off.call).toHaveBeenCalledWith('enclosure2.set_slot_status', [
        { enclosure_id: '5003048001c1043f', slot: 3, status: 'OFF' },
      ]);
    });

    it('never confirms from the request alone', async () => {
      const silent = [enclosure('5003048001c1043f', { '3': slotElement('sdb', { drive_bay_light_status: null }) })];
      const unread = await execute({}, identifySystem({ enclosures: [ENCLOSURES, silent] }));
      expect(unread).toMatchObject({ resulting_light: null, resulting_lookup: 'FOUND', confirmed: null });
      const otherWay = await execute({}, identifySystem({ enclosures: [ENCLOSURES, ENCLOSURES] }));
      expect(otherWay).toMatchObject({ resulting_light: 'OFF', confirmed: false });
      const unreadable = [enclosure('5003048001c1043f', { '3': null })];
      expect(await execute({}, identifySystem({ enclosures: [ENCLOSURES, unreadable] }))).toMatchObject({
        resulting_lookup: 'FOUND',
        confirmed: null,
      });
    });

    it('reports a read after the call that failed or found nothing, without failing the call', async () => {
      const failing = identifySystem({ enclosureFailure: (attempt) => (attempt === 1 ? new Error('socket closed') : undefined) });
      expect(await execute({}, failing)).toMatchObject({
        resulting_lookup: 'UNREADABLE',
        resulting_read_error: 'socket closed',
        confirmed: null,
      });
      const gone = await execute({}, identifySystem({ enclosures: [ENCLOSURES, []] }));
      expect(gone).toMatchObject({ resulting_lookup: 'NOT_FOUND', resulting_light: null, confirmed: null });
      const slotGone = await execute({}, identifySystem({ enclosures: [ENCLOSURES, [enclosure('5003048001c1043f', {})]] }));
      expect(slotGone).toMatchObject({ resulting_lookup: 'NOT_FOUND' });
    });

    it('resolves the slot again and sends nothing where the disk is no longer listed or no longer supported', async () => {
      const moved = identifySystem({ enclosures: [[]] });
      await expect(execute({}, moved)).rejects.toThrow('no managed enclosure slot');
      expect(moved.call).not.toHaveBeenCalled();
      const unsupported = identifySystem({
        enclosures: [[enclosure('x', { '3': slotElement('sdb', { supports_identify_light: false }) })]],
      });
      await expect(execute({}, unsupported)).rejects.toThrow('does not support an identify light');
      expect(unsupported.call).not.toHaveBeenCalled();
    });

    it('lets a rejected call fail the tool', async () => {
      await expect(execute({}, identifySystem({ callFailure: new Error('Slot 3 not found in enclosure') }))).rejects.toThrow(
        'Slot 3 not found in enclosure',
      );
    });
  });
});
