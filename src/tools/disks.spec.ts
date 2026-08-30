import { describe, expect, it } from 'vitest';
import { Role } from '@/interfaces';
import { failingSystem, fakeSystem } from '@/testing/fake-systems';
import { disksList, disksTemperature } from '@/tools/index';

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

describe('disks_temperature', () => {
  /** The listing shape the "all disks" path reads names out of. */
  const listing = (...names: string[]) => names.map((name) => ({ name, size: 1, pool: null }));

  /** One row of the result, by device name. */
  const rowFor = (result: unknown, name: string): Record<string, unknown> => {
    const rows = (result as { disks: Record<string, unknown>[] }).disks;
    return rows.find((row) => row['name'] === name) as Record<string, unknown>;
  };

  it('reads temperature and thresholds out of a per-disk record', async () => {
    const { ctx } = fakeSystem({
      ['disk.query']: listing('sda'),
      ['disk.temperatures']: { sda: { temp: 34, warn: 50, crit: 60 } },
    });
    expect(await disksTemperature.handler(ctx, {})).toEqual({
      disks: [
        {
          name: 'sda',
          temperature_reported: true,
          temperature_celsius: 34,
          warning_celsius: 50,
          critical_celsius: 60,
          unreported_fields: [],
          recent: null,
        },
      ],
      unavailable: null,
      history: null,
    });
  });

  it('reads a bare number as the temperature, with no thresholds', async () => {
    // The shape a system that carries no thresholds is expected to answer with.
    // `unreported_fields` is null rather than empty: the entry named no keys, so
    // there is nothing for the list to have read and reported.
    const { ctx } = fakeSystem({
      ['disk.query']: listing('sda'),
      ['disk.temperatures']: { sda: 41 },
    });
    expect(rowFor(await disksTemperature.handler(ctx, {}), 'sda')).toEqual({
      name: 'sda',
      temperature_reported: true,
      temperature_celsius: 41,
      warning_celsius: null,
      critical_celsius: null,
      unreported_fields: null,
      recent: null,
    });
  });

  it('separates a disk the read did not mention from one it reported nothing for', async () => {
    const { ctx } = fakeSystem({
      ['disk.query']: listing('sda', 'sdb', 'sdc'),
      // `sda` answered, `sdb` answered with an explicit null — an SSD that
      // publishes nothing, or a disk that was asleep — and `sdc` was not
      // mentioned at all.
      ['disk.temperatures']: { sda: 34, sdb: null },
    });
    const result = await disksTemperature.handler(ctx, {});
    expect(
      (result as { disks: Record<string, unknown>[] }).disks.map((row) => [
        row['name'],
        row['temperature_reported'],
        row['temperature_celsius'],
      ]),
    ).toEqual([
      ['sda', true, 34],
      ['sdb', true, null],
      ['sdc', false, null],
    ]);
  });

  it('names a key it could not read as unreported, beside the null field', async () => {
    // The likelier of the two ways the unconfirmed allowlist is wrong: the key
    // is spelled as expected and carries a value of another type. It has to
    // land in the list exactly as an unlooked-for key does, or the caller sees
    // "every key is reported" beside a null.
    const { ctx } = fakeSystem({
      ['disk.query']: listing('sda'),
      ['disk.temperatures']: { sda: { temp: '34', crit: 60, powered_on_hours: 9000 } },
    });
    expect(rowFor(await disksTemperature.handler(ctx, {}), 'sda')).toMatchObject({
      temperature_celsius: null,
      critical_celsius: 60,
      // `temp` is listed because the record carried it and the guard rejected
      // it; `warn` is NOT, because the record carried nothing under that name —
      // a null field beside a list that does not name it is the separate answer
      // "there was nothing there", and the two must not read alike.
      unreported_fields: ['powered_on_hours', 'temp'],
    });
  });

  it('reports no value from an unread key, only its name', async () => {
    const { ctx } = fakeSystem({
      ['disk.query']: listing('sda'),
      ['disk.temperatures']: { sda: { temp: 34, serial_number: 'ABC123' } },
    });
    const row = rowFor(await disksTemperature.handler(ctx, {}), 'sda');
    expect(row['unreported_fields']).toEqual(['serial_number']);
    expect(JSON.stringify(row)).not.toContain('ABC123');
  });

  it('reads every disk the system lists when no disks are named', async () => {
    const { ctx, query, call } = fakeSystem({
      ['disk.query']: listing('sda', 'sdb'),
      ['disk.temperatures']: { sda: 34, sdb: 35 },
    });
    await disksTemperature.handler(ctx, {});
    expect(query).toHaveBeenCalledWith('disk.query');
    // The resolved names are passed explicitly rather than the argument being
    // omitted, so the disks reported on are the ones this tool named.
    expect(call).toHaveBeenCalledWith('disk.temperatures', [['sda', 'sdb'], true]);
  });

  it('reads only the named disks, without listing them first', async () => {
    const { ctx, query, call } = fakeSystem({ ['disk.temperatures']: { sdb: 35 } });
    const result = await disksTemperature.handler(ctx, { disks: ['sdb'] });
    expect(query).not.toHaveBeenCalled();
    expect(call).toHaveBeenCalledWith('disk.temperatures', [['sdb'], true]);
    expect((result as { disks: unknown[] }).disks).toHaveLength(1);
  });

  it('rejects a malformed disks argument rather than reading past it', async () => {
    const { ctx } = fakeSystem({ ['disk.temperatures']: {} });
    await expect(disksTemperature.handler(ctx, { disks: 'sda' })).rejects.toThrow(
      '"disks" must be a list of device names',
    );
    await expect(disksTemperature.handler(ctx, { disks: ['sda', 7] })).rejects.toThrow(
      '"disks" must hold non-empty device names',
    );
  });

  it('returns [] for a system with no disks, and reads no temperature', async () => {
    const { ctx, call } = fakeSystem({ ['disk.query']: [] });
    expect(await disksTemperature.handler(ctx, {})).toEqual({
      disks: [],
      unavailable: null,
      history: null,
    });
    expect(call).not.toHaveBeenCalled();
  });

  it('still reports the history window it was asked for when there are no disks', async () => {
    // `history` says what was asked for, not what was read, so a system with no
    // disks does not read as one where no history was requested.
    const { ctx } = fakeSystem({ ['disk.query']: [] });
    expect(await disksTemperature.handler(ctx, { history_days: 5 })).toEqual({
      disks: [],
      unavailable: null,
      history: { days: 5, unavailable: null },
    });
  });

  it('reads no names from a listing that is not a list, or from an unnamed row', async () => {
    const notAList = fakeSystem({ ['disk.query']: { sda: {} } });
    expect(await disksTemperature.handler(notAList.ctx, {})).toMatchObject({ disks: [] });

    // A row the listing carried whose name could not be read names no device,
    // so it is not asked about — there is nothing to ask the temperature read
    // for, and a row keyed by nothing could not be matched back to an answer.
    const unnamed = fakeSystem({
      ['disk.query']: [{ name: 'sda' }, { name: null }, 'not a row'],
      ['disk.temperatures']: { sda: 34 },
    });
    const result = await disksTemperature.handler(unnamed.ctx, {});
    expect((result as { disks: Record<string, unknown>[] }).disks.map((row) => row['name'])).toEqual(
      ['sda'],
    );
  });

  it('reports the temperatures as unavailable rather than every disk as null', async () => {
    const { ctx } = failingSystem(
      { ['disk.query']: listing('sda') },
      { ['disk.temperatures']: new Error('connection reset') },
    );
    expect(await disksTemperature.handler(ctx, {})).toEqual({
      disks: null,
      unavailable: 'connection reset',
      history: null,
    });
  });

  it('reports an answer that is not a record as unavailable', async () => {
    const { ctx } = fakeSystem({
      ['disk.query']: listing('sda'),
      ['disk.temperatures']: ['sda', 34],
    });
    expect(await disksTemperature.handler(ctx, {})).toMatchObject({
      disks: null,
      unavailable: 'the system answered with something other than a record of temperatures',
    });
  });

  it('does not read history unless it is asked for', async () => {
    const { ctx, call } = fakeSystem({
      ['disk.query']: listing('sda'),
      ['disk.temperatures']: { sda: 34 },
    });
    const result = await disksTemperature.handler(ctx, {});
    expect(call.mock.calls.map((args) => args[0])).toEqual(['disk.temperatures']);
    expect((result as { history: unknown }).history).toBeNull();
    expect(rowFor(result, 'sda')['recent']).toBeNull();
  });

  it('summarises the aggregate when history is asked for', async () => {
    const { ctx, call } = fakeSystem({
      ['disk.query']: listing('sda', 'sdb'),
      ['disk.temperatures']: { sda: 34, sdb: 35 },
      // `sdb` has no entry: the aggregate held nothing readable for it, which
      // is not the same answer as the aggregate not having been read.
      ['disk.temperature_agg']: { sda: { min: 30, max: 40, avg: 34.5 } },
    });
    const result = await disksTemperature.handler(ctx, { history_days: 14 });
    expect(call).toHaveBeenCalledWith('disk.temperature_agg', [['sda', 'sdb'], 14]);
    expect((result as { history: unknown }).history).toEqual({ days: 14, unavailable: null });
    expect(rowFor(result, 'sda')['recent']).toEqual({
      min_celsius: 30,
      max_celsius: 40,
      avg_celsius: 34.5,
    });
    expect(rowFor(result, 'sdb')['recent']).toBeNull();
  });

  it('reports an aggregate entry that said nothing as three nulls', async () => {
    const { ctx } = fakeSystem({
      ['disk.query']: listing('sda'),
      ['disk.temperatures']: { sda: 34 },
      ['disk.temperature_agg']: { sda: { min: null, max: null, avg: null } },
    });
    expect(rowFor(await disksTemperature.handler(ctx, { history_days: 3 }), 'sda')['recent']).toEqual(
      { min_celsius: null, max_celsius: null, avg_celsius: null },
    );
  });

  it('keeps the current temperatures when only the aggregate fails', async () => {
    const { ctx } = failingSystem(
      { ['disk.query']: listing('sda'), ['disk.temperatures']: { sda: 34 } },
      { ['disk.temperature_agg']: { reason: 'reporting database unavailable' } },
    );
    const result = await disksTemperature.handler(ctx, { history_days: 7 });
    expect((result as { history: unknown }).history).toEqual({
      days: 7,
      unavailable: 'reporting database unavailable',
    });
    expect(rowFor(result, 'sda')['temperature_celsius']).toBe(34);
    expect(rowFor(result, 'sda')['recent']).toBeNull();
  });

  it('bounds the history window and reports the window it used', async () => {
    const { ctx, call } = fakeSystem({
      ['disk.query']: listing('sda'),
      ['disk.temperatures']: { sda: 34 },
      ['disk.temperature_agg']: {},
    });
    const tooLong = await disksTemperature.handler(ctx, { history_days: 400 });
    expect((tooLong as { history: { days: number } }).history.days).toBe(90);
    const tooShort = await disksTemperature.handler(ctx, { history_days: 0 });
    expect((tooShort as { history: { days: number } }).history.days).toBe(1);
    const fractional = await disksTemperature.handler(ctx, { history_days: 2.7 });
    expect((fractional as { history: { days: number } }).history.days).toBe(2);
    // A history_days that cannot be read still asks for history — it is a
    // request for it, malformed — rather than silently reading none.
    const unreadable = await disksTemperature.handler(ctx, { history_days: 'a week' });
    expect((unreadable as { history: { days: number } }).history.days).toBe(7);
    expect(call.mock.calls.filter((args) => args[0] === 'disk.temperature_agg')).toHaveLength(4);
  });

  it('is read-only and needs only a read-only credential', () => {
    expect(disksTemperature.mutating).toBe(false);
    expect(disksTemperature.requiredRole).toBe(Role.ReadOnly);
  });

  it('claims no SMART result, error history or power-on hours', () => {
    // #48's objection to a temperature-only tool was the NAME promising SMART,
    // so the name is half of what this asserts and the disclaimer is the other.
    expect(disksTemperature.name).toBe('disks_temperature');
    expect(disksTemperature.description).toContain(
      'THIS TOOL REPORTS TEMPERATURE AND NOTHING ELSE FROM SMART: no self-test ' +
        'results, no error or reallocation counts, no power-on hours.',
    );
  });

  it('states that waking a standby disk is unestablished, rather than either answer', () => {
    expect(disksTemperature.description).toContain(
      'IT IS NOT ESTABLISHED WHETHER READING A TEMPERATURE WAKES A SPUN-DOWN DISK',
    );
  });
});
