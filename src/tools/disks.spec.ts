import { describe, expect, it } from 'vitest';
import { fakeSystem } from '@/testing/fake-systems';
import { disksList } from '@/tools/index';

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
