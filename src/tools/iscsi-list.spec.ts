import { describe, expect, it } from 'vitest';
import { failingSystem } from '@/testing/fake-systems';
import { iscsiList } from '@/tools/index';

/**
 * Split out of `block.spec.ts` under #87's exception rather than for tidiness.
 * That file was 1,497 lines with a stated margin of three, and #138 grows two
 * of its three tools — so the merged file would be well over the 1,500-line
 * trigger and the split is by tool, this one taking the spec named for it.
 * `nvmeof_list` and `fc_list` stay in the module's own spec: re-homing tests a
 * ticket did not have to touch is a separate change (#121), and a part-split is
 * not a half-finished state to tidy.
 */
describe('iscsi_list', () => {
  /**
   * A target as `iscsi.target.query` reports one. `rel_tgt_id`, `mode`,
   * `groups` and `auth_networks` are real fields of the payload the tool does
   * not name, and are here to be dropped.
   */
  const target = (over: Record<string, unknown> = {}) => ({
    id: 1,
    name: 'tgt0',
    alias: 'VMware datastore',
    rel_tgt_id: 1,
    mode: 'ISCSI',
    groups: [{ portal: 1, initiator: 1 }],
    auth_networks: [],
    ...over,
  });

  /**
   * An extent as `iscsi.extent.query` reports one. A `DISK` extent carries
   * BOTH `disk` and `path` — the system reports the device node in `path` too,
   * so `path` is not evidence that an extent is file-backed.
   */
  const extent = (over: Record<string, unknown> = {}) => ({
    id: 7,
    name: 'vmstore',
    type: 'DISK',
    disk: 'zvol/tank/vmstore',
    path: '/dev/zvol/tank/vmstore',
    enabled: true,
    locked: false,
    naa: '0x6589cfc000000',
    vendor: 'TrueNAS',
    serial: 'abc123',
    ...over,
  });

  /** A row of the join table mapping an extent onto a target at a LUN. */
  const mapping = (over: Record<string, unknown> = {}) => ({
    id: 4,
    target: 1,
    extent: 7,
    lunid: 0,
    ...over,
  });

  /**
   * A portal as `iscsi.portal.query` reports one, listening on one address.
   * `tag` is the portal group number a target's `groups[].portal` names.
   */
  const portal = (over: Record<string, unknown> = {}) => ({
    id: 1,
    tag: 1,
    comment: 'VMware network',
    listen: [{ ip: '10.0.0.10', port: 3260 }],
    ...over,
  });

  /** A live session as `iscsi.global.sessions` reports one. */
  const session = (over: Record<string, unknown> = {}) => ({
    initiator: 'iqn.1998-01.com.vmware:esx1',
    initiator_addr: '10.0.0.20',
    initiator_alias: 'esx1',
    target: 'tgt0',
    target_alias: 'VMware datastore',
    header_digest: null,
    data_digest: null,
    immediate_data: true,
    iser: false,
    offload: false,
    ...over,
  });

  type Listing = {
    targets: Record<string, unknown>[];
    portals: Record<string, unknown>[] | null;
    failures: Record<string, unknown>[];
    unattributed_initiators: Record<string, unknown>[];
  };

  const listed = async (
    rows: Partial<Record<string, unknown>> = {},
    failures: Partial<Record<string, unknown>> = {},
  ): Promise<Listing> => {
    const { ctx } = failingSystem(
      {
        ['iscsi.target.query']: [target()],
        ['iscsi.extent.query']: [extent()],
        ['iscsi.targetextent.query']: [mapping()],
        ['iscsi.global.sessions']: [session()],
        ['iscsi.portal.query']: [portal()],
        ...rows,
      },
      failures,
    );
    return (await iscsiList.handler(ctx, {})) as Listing;
  };

  /** The single portal of a listing, for the cases about one portal's fields. */
  const onlyPortal = async (
    rows: Partial<Record<string, unknown>> = {},
  ): Promise<Record<string, unknown>> => ((await listed(rows)).portals ?? [])[0];

  /** The single target of a listing, for the cases about one target's fields. */
  const onlyTarget = async (
    rows: Partial<Record<string, unknown>> = {},
    failures: Partial<Record<string, unknown>> = {},
  ): Promise<Record<string, unknown>> => (await listed(rows, failures)).targets[0];

  it('reports each target with its extents and connected initiators', async () => {
    expect(await listed()).toEqual({
      targets: [
        {
          id: 1,
          name: 'tgt0',
          alias: 'VMware datastore',
          mode: 'ISCSI',
          extents: [
            {
              id: 7,
              lun: 0,
              name: 'vmstore',
              type: 'DISK',
              path: '/dev/zvol/tank/vmstore',
              disk: 'zvol/tank/vmstore',
              enabled: true,
              locked: false,
            },
          ],
          initiators: [
            {
              initiator: 'iqn.1998-01.com.vmware:esx1',
              addresses: ['10.0.0.20'],
              alias: 'esx1',
            },
          ],
        },
      ],
      portals: [
        {
          id: 1,
          tag: 1,
          comment: 'VMware network',
          listen: [{ ip: '10.0.0.10', port: 3260 }],
        },
      ],
      failures: [],
      unattributed_initiators: [],
    });
  });

  it('surfaces no field a later release adds', async () => {
    const listing = await listed({
      ['iscsi.target.query']: [target({ future_field: 'added by a later release' })],
      ['iscsi.extent.query']: [extent({ future_field: 'added by a later release' })],
      ['iscsi.targetextent.query']: [mapping({ future_field: 'added by a later release' })],
      ['iscsi.global.sessions']: [session({ future_field: 'added by a later release' })],
      ['iscsi.portal.query']: [
        portal({
          future_field: 'added by a later release',
          listen: [{ ip: '10.0.0.10', port: 3260, future_field: 'added by a later release' }],
        }),
      ],
    });
    expect(Object.keys(listing)).toEqual([
      'targets',
      'portals',
      'failures',
      'unattributed_initiators',
    ]);
    expect(Object.keys((listing.portals ?? [])[0])).toEqual(['id', 'tag', 'comment', 'listen']);
    expect(
      Object.keys(
        (((listing.portals ?? [])[0]['listen'] as Record<string, unknown>[]) ?? [])[0],
      ),
    ).toEqual(['ip', 'port']);
    expect(Object.keys(listing.targets[0])).toEqual([
      'id',
      'name',
      'alias',
      'mode',
      'extents',
      'initiators',
    ]);
    expect(Object.keys((listing.targets[0]['extents'] as Record<string, unknown>[])[0])).toEqual([
      'id',
      'lun',
      'name',
      'type',
      'path',
      'disk',
      'enabled',
      'locked',
    ]);
    expect(Object.keys((listing.targets[0]['initiators'] as Record<string, unknown>[])[0])).toEqual(
      ['initiator', 'addresses', 'alias'],
    );
  });

  it('reads a target with no alias as having none', async () => {
    for (const missing of [null, undefined, '']) {
      expect(await onlyTarget({ ['iscsi.target.query']: [target({ alias: missing })] })).toMatchObject(
        { alias: null },
      );
    }
  });

  it('reads an initiator with no alias as having none', async () => {
    for (const missing of [null, '']) {
      const initiators = (
        await onlyTarget({ ['iscsi.global.sessions']: [session({ initiator_alias: missing })] })
      )['initiators'] as Record<string, unknown>[];
      expect(initiators[0]['alias']).toBeNull();
    }
  });

  it('maps every extent of a target, each at its own LUN', async () => {
    const extents = (
      await onlyTarget({
        ['iscsi.extent.query']: [extent(), extent({ id: 8, name: 'logs', type: 'FILE' })],
        ['iscsi.targetextent.query']: [mapping(), mapping({ id: 5, extent: 8, lunid: 1 })],
      })
    )['extents'] as Record<string, unknown>[];
    expect(extents.map((mapped) => [mapped['lun'], mapped['name']])).toEqual([
      [0, 'vmstore'],
      [1, 'logs'],
    ]);
  });

  it('reports the backing store of a DISK extent and of a FILE one', async () => {
    const extents = (
      await onlyTarget({
        ['iscsi.extent.query']: [
          extent(),
          extent({ id: 8, type: 'FILE', disk: null, path: '/mnt/tank/iscsi/logs' }),
        ],
        ['iscsi.targetextent.query']: [mapping(), mapping({ id: 5, extent: 8, lunid: 1 })],
      })
    )['extents'] as Record<string, unknown>[];
    // `path` is set on both kinds, so it is `disk` and `type` that separate
    // them — a caller reading a set `path` as "file-backed" would be wrong.
    expect(extents[0]).toMatchObject({
      type: 'DISK',
      disk: 'zvol/tank/vmstore',
      path: '/dev/zvol/tank/vmstore',
    });
    expect(extents[1]).toMatchObject({ type: 'FILE', disk: null, path: '/mnt/tank/iscsi/logs' });
  });

  it('reports an extent field the system omitted as null, not as a value', async () => {
    const extents = (
      await onlyTarget({
        ['iscsi.extent.query']: [{ id: 7, name: 'vmstore', naa: '0x1', vendor: 'TrueNAS' }],
      })
    )['extents'] as Record<string, unknown>[];
    // `enabled` and `locked` especially: false would say the extent is
    // definitely not serving, which the system did not report either way.
    expect(extents[0]).toEqual({
      id: 7,
      lun: 0,
      name: 'vmstore',
      type: null,
      path: null,
      disk: null,
      enabled: null,
      locked: null,
    });
  });

  it('keeps a mapping whose extent record is missing, marked by a null name', async () => {
    const extents = (await onlyTarget({ ['iscsi.extent.query']: [] }))[
      'extents'
    ] as Record<string, unknown>[];
    // The LUN was configured, and that is worth reporting; a real extent always
    // carries a name, so the null name is what says the record was not found.
    expect(extents).toEqual([
      {
        id: 7,
        lun: 0,
        name: null,
        type: null,
        path: null,
        disk: null,
        enabled: null,
        locked: null,
      },
    ]);
  });

  it('reports a target with nothing mapped to it as an empty extent list', async () => {
    expect(await onlyTarget({ ['iscsi.targetextent.query']: [] })).toMatchObject({ extents: [] });
  });

  it('reports a target with no session as an empty initiator list', async () => {
    expect(await onlyTarget({ ['iscsi.global.sessions']: [] })).toMatchObject({ initiators: [] });
  });

  it('distinguishes sessions that could not be read from a target with none', async () => {
    const listing = await listed({}, { ['iscsi.global.sessions']: new Error('service not running') });
    // Null rather than empty: an empty list would say nothing is connected,
    // which is the one answer this tool must not invent.
    expect(listing.targets[0]['initiators']).toBeNull();
    expect(listing.failures).toEqual([
      { source: 'initiators', error: 'service not running' },
    ]);
  });

  it('distinguishes extents that could not be read from a target with none', async () => {
    for (const method of ['iscsi.extent.query', 'iscsi.targetextent.query']) {
      const listing = await listed({}, { [method]: new Error('denied') });
      expect(listing.targets[0]['extents']).toBeNull();
      expect(listing.failures).toEqual([{ source: 'extents', error: 'denied' }]);
      // The other read is unaffected, which is why they are separate failures.
      expect(listing.targets[0]['initiators']).not.toBeNull();
    }
  });

  it('reports every read failing without losing the targets themselves', async () => {
    const listing = await listed(
      {},
      {
        ['iscsi.extent.query']: new Error('denied'),
        ['iscsi.global.sessions']: new Error('service not running'),
        ['iscsi.portal.query']: new Error('no such method'),
      },
    );
    expect(listing.targets).toEqual([
      {
        id: 1,
        name: 'tgt0',
        alias: 'VMware datastore',
        mode: 'ISCSI',
        extents: null,
        initiators: null,
      },
    ]);
    expect(listing.portals).toBeNull();
    expect(listing.failures).toEqual([
      { source: 'extents', error: 'denied' },
      { source: 'initiators', error: 'service not running' },
      { source: 'portals', error: 'no such method' },
    ]);
  });

  it('names a failure that is not an Error, and one that says nothing', async () => {
    expect(
      (await listed({}, { ['iscsi.global.sessions']: 'connection reset' })).failures,
    ).toEqual([{ source: 'initiators', error: 'connection reset' }]);
    for (const silent of [new Error(''), { code: 500 }]) {
      expect((await listed({}, { ['iscsi.global.sessions']: silent })).failures).toEqual([
        { source: 'initiators', error: 'the system reported no reason' },
      ]);
    }
  });

  it('raises rather than reporting a system that serves nothing when targets fail', async () => {
    await expect(
      listed({}, { ['iscsi.target.query']: new Error('denied') }),
    ).rejects.toThrow('denied');
  });

  it('attributes a session naming its target by the full IQN', async () => {
    expect(
      await onlyTarget({
        ['iscsi.global.sessions']: [session({ target: 'iqn.2005-10.org.freenas.ctl:tgt0' })],
      }),
    ).toMatchObject({ initiators: [{ initiator: 'iqn.1998-01.com.vmware:esx1' }] });
  });

  it('groups each session under the one target it is on', async () => {
    const listing = await listed({
      ['iscsi.target.query']: [target(), target({ id: 2, name: 'tgt1', alias: null })],
      ['iscsi.global.sessions']: [
        session(),
        session({ initiator: 'iqn.1998-01.com.vmware:esx2', target: 'tgt1' }),
        session({ initiator: 'iqn.1998-01.com.vmware:esx3', target: 'tgt1' }),
      ],
    });
    expect(
      listing.targets.map((entry) => [
        entry['name'],
        (entry['initiators'] as Record<string, unknown>[]).map((one) => one['initiator']),
      ]),
    ).toEqual([
      ['tgt0', ['iqn.1998-01.com.vmware:esx1']],
      ['tgt1', ['iqn.1998-01.com.vmware:esx2', 'iqn.1998-01.com.vmware:esx3']],
    ]);
  });

  it('counts a multipathed initiator once, keeping every path it reaches from', async () => {
    // Two sessions, one initiator down two paths. Two entries would make one
    // host with two NICs read as two hosts attached to the target.
    const initiators = (
      await onlyTarget({
        ['iscsi.global.sessions']: [
          session(),
          session({ initiator_addr: '10.0.1.20' }),
          session({ initiator_addr: '10.0.0.20' }),
        ],
      })
    )['initiators'] as Record<string, unknown>[];
    expect(initiators).toEqual([
      {
        initiator: 'iqn.1998-01.com.vmware:esx1',
        addresses: ['10.0.0.20', '10.0.1.20'],
        alias: 'esx1',
      },
    ]);
  });

  it('takes an initiator alias from whichever session carries one', async () => {
    const initiators = (
      await onlyTarget({
        ['iscsi.global.sessions']: [
          session({ initiator_alias: null }),
          session({ initiator_addr: '10.0.1.20', initiator_alias: 'esx1' }),
        ],
      })
    )['initiators'] as Record<string, unknown>[];
    expect(initiators[0]).toMatchObject({ alias: 'esx1' });
  });

  it('keeps two different initiators on one target apart', async () => {
    const initiators = (
      await onlyTarget({
        ['iscsi.global.sessions']: [
          session(),
          session({ initiator: 'iqn.1998-01.com.vmware:esx2', initiator_addr: '10.0.0.21' }),
        ],
      })
    )['initiators'] as Record<string, unknown>[];
    expect(initiators.map((one) => one['initiator'])).toEqual([
      'iqn.1998-01.com.vmware:esx1',
      'iqn.1998-01.com.vmware:esx2',
    ]);
  });

  it('reports how a target is served, so an FC target is not read as idle', async () => {
    // An FC target holds no iSCSI session by definition, so without `mode` its
    // empty initiator list is indistinguishable from an idle iSCSI target.
    const listing = await listed({
      ['iscsi.target.query']: [
        target({ id: 2, name: 'fctgt', mode: 'FC' }),
        target({ id: 3, name: 'bothtgt', mode: 'BOTH' }),
        target({ mode: undefined }),
      ],
      ['iscsi.global.sessions']: [],
    });
    expect(listing.targets.map((entry) => [entry['name'], entry['mode'], entry['initiators']])).toEqual(
      [
        ['fctgt', 'FC', []],
        ['bothtgt', 'BOTH', []],
        ['tgt0', null, []],
      ],
    );
  });

  it('groups mappings under the target each names', async () => {
    const listing = await listed({
      ['iscsi.target.query']: [target(), target({ id: 2, name: 'tgt1' })],
      ['iscsi.extent.query']: [extent(), extent({ id: 8, name: 'logs' })],
      ['iscsi.targetextent.query']: [
        mapping(),
        mapping({ id: 5, target: 2, extent: 8, lunid: 0 }),
      ],
    });
    expect(
      listing.targets.map((entry) => [
        entry['name'],
        (entry['extents'] as Record<string, unknown>[]).map((one) => one['name']),
      ]),
    ).toEqual([
      ['tgt0', ['vmstore']],
      ['tgt1', ['logs']],
    ]);
  });

  it('reports a session it could not attribute rather than dropping it', async () => {
    const listing = await listed({
      ['iscsi.global.sessions']: [session({ target: 'some-other-spelling' })],
    });
    // Silently dropping it would leave the target reading as unused, which is
    // exactly the answer this tool exists to be trusted on.
    expect(listing.targets[0]['initiators']).toEqual([]);
    expect(listing.unattributed_initiators).toEqual([
      {
        initiator: 'iqn.1998-01.com.vmware:esx1',
        addresses: ['10.0.0.20'],
        alias: 'esx1',
        target: 'some-other-spelling',
      },
    ]);
  });

  it('groups unattributed sessions by target and initiator, as attributed ones are', async () => {
    const listing = await listed({
      ['iscsi.global.sessions']: [
        session({ target: 'unknown-a' }),
        session({ target: 'unknown-a', initiator_addr: '10.0.1.20' }),
        session({ target: 'unknown-b' }),
        session({ target: 'unknown-a', initiator: 'iqn.1998-01.com.vmware:esx2' }),
      ],
    });
    expect(
      listing.unattributed_initiators.map((one) => [
        one['target'],
        one['initiator'],
        one['addresses'],
      ]),
    ).toEqual([
      ['unknown-a', 'iqn.1998-01.com.vmware:esx1', ['10.0.0.20', '10.0.1.20']],
      ['unknown-a', 'iqn.1998-01.com.vmware:esx2', ['10.0.0.20']],
      ['unknown-b', 'iqn.1998-01.com.vmware:esx1', ['10.0.0.20']],
    ]);
  });

  it('leaves a session unattributed where two targets answer to its IQN', async () => {
    const listing = await listed({
      ['iscsi.target.query']: [target({ id: 2, name: 'a:tgt0' }), target()],
      ['iscsi.global.sessions']: [session({ target: 'iqn.2005-10.org.freenas.ctl:a:tgt0' })],
    });
    // Both `a:tgt0` and `tgt0` are colon-anchored suffixes of that IQN.
    // Reporting it against both would invent a connection to one of them.
    expect(listing.targets.map((entry) => entry['initiators'])).toEqual([[], []]);
    expect(listing.unattributed_initiators).toHaveLength(1);
  });

  it('prefers an exact target name over a suffix that also matches', async () => {
    const listing = await listed({
      ['iscsi.target.query']: [target({ id: 2, name: 'x:tgt0' }), target()],
      ['iscsi.global.sessions']: [session({ target: 'x:tgt0' })],
    });
    expect(listing.targets.map((entry) => [entry['name'], entry['initiators']])).toEqual([
      [
        'x:tgt0',
        [{ initiator: 'iqn.1998-01.com.vmware:esx1', addresses: ['10.0.0.20'], alias: 'esx1' }],
      ],
      ['tgt0', []],
    ]);
    expect(listing.unattributed_initiators).toEqual([]);
  });

  it('reports a system with no targets as an empty list', async () => {
    expect(
      await listed({
        ['iscsi.target.query']: [],
        ['iscsi.global.sessions']: [],
        ['iscsi.portal.query']: [],
      }),
    ).toEqual({
      targets: [],
      portals: [],
      failures: [],
      unattributed_initiators: [],
    });
  });

  it('does not lose a live session on a system whose targets listed as none', async () => {
    // A session with no target to hang it on is the one case where the tool
    // has evidence of block storage in use and nothing to attribute it to.
    const listing = await listed({ ['iscsi.target.query']: [] });
    expect(listing.targets).toEqual([]);
    expect(listing.unattributed_initiators).toMatchObject([{ target: 'tgt0' }]);
  });

  it('issues every read before awaiting any of them', async () => {
    const { ctx, query } = failingSystem({
      ['iscsi.target.query']: [target()],
      ['iscsi.extent.query']: [extent()],
      ['iscsi.targetextent.query']: [mapping()],
      ['iscsi.global.sessions']: [session()],
      ['iscsi.portal.query']: [portal()],
    });
    const listing = iscsiList.handler(ctx, {});
    // Asserted before the handler is awaited at all, which is what makes this
    // about concurrency rather than order: every read is subscribed while the
    // handler still holds the thread, so a handler that awaited one read
    // before starting the next would have made one call by this point. The
    // same assertion after the await passes either way.
    expect(query.mock.calls.map((one) => one[0])).toEqual([
      'iscsi.target.query',
      'iscsi.extent.query',
      'iscsi.targetextent.query',
      'iscsi.global.sessions',
      'iscsi.portal.query',
    ]);
    await listing;
  });

  describe('where the service listens', () => {
    it('reports each portal with every address it accepts connections on', async () => {
      const listing = await listed({
        ['iscsi.portal.query']: [
          portal({ listen: [{ ip: '10.0.0.10', port: 3260 }, { ip: '10.0.1.10', port: 3261 }] }),
          portal({ id: 2, tag: 2, comment: '', listen: [{ ip: '0.0.0.0', port: 3260 }] }),
        ],
      });
      expect(listing.portals).toEqual([
        {
          id: 1,
          tag: 1,
          comment: 'VMware network',
          listen: [
            { ip: '10.0.0.10', port: 3260 },
            { ip: '10.0.1.10', port: 3261 },
          ],
        },
        // `0.0.0.0` is passed through as the system spelled it: it is the
        // wildcard, and it is the description's job to say so rather than this
        // tool's to translate it into an address the system does not have.
        { id: 2, tag: 2, comment: null, listen: [{ ip: '0.0.0.0', port: 3260 }] },
      ]);
    });

    it('reads a listen entry it could not read as a row of nulls, not as absent', async () => {
      // Dropping it would say the service is unreachable at an address it is
      // bound to, which is a claim this read did not make (#93).
      const listen = (
        await onlyPortal({
          ['iscsi.portal.query']: [
            portal({ listen: [{ ip: 10, port: '3260' }, 'not a record', { ip: '10.0.0.10' }] }),
          ],
        })
      )['listen'];
      expect(listen).toEqual([
        { ip: null, port: null },
        { ip: null, port: null },
        { ip: '10.0.0.10', port: null },
      ]);
    });

    it('distinguishes a portal that listens nowhere from one that reported no list', async () => {
      expect(await onlyPortal({ ['iscsi.portal.query']: [portal({ listen: [] })] })).toMatchObject({
        listen: [],
      });
      for (const missing of [null, undefined, 'everywhere']) {
        expect(
          await onlyPortal({ ['iscsi.portal.query']: [portal({ listen: missing })] }),
        ).toMatchObject({ listen: null });
      }
    });

    it('reports a portal field the system did not report as null', async () => {
      expect(
        await onlyPortal({ ['iscsi.portal.query']: [{ listen: [], comment: '' }] }),
      ).toEqual({ id: null, tag: null, comment: null, listen: [] });
    });

    it('distinguishes a system with no portal from one whose portals failed', async () => {
      // Empty is an iSCSI service that accepts nothing wherever its targets
      // point; null is a read that says nothing about where it listens.
      expect((await listed({ ['iscsi.portal.query']: [] })).portals).toEqual([]);
      const failed = await listed({}, { ['iscsi.portal.query']: new Error('denied') });
      expect(failed.portals).toBeNull();
      expect(failed.failures).toEqual([{ source: 'portals', error: 'denied' }]);
      // The other reads are unaffected, which is why it is its own failure.
      expect(failed.targets[0]['extents']).not.toBeNull();
      expect(failed.targets[0]['initiators']).not.toBeNull();
    });

    it('keeps reporting the portals when a target read succeeded and the others did not', async () => {
      const listing = await listed(
        {},
        {
          ['iscsi.extent.query']: new Error('denied'),
          ['iscsi.global.sessions']: new Error('service not running'),
        },
      );
      expect(listing.portals).toEqual([
        { id: 1, tag: 1, comment: 'VMware network', listen: [{ ip: '10.0.0.10', port: 3260 }] },
      ]);
    });
  });

  describe('its description', () => {
    it('says what a wildcard listen address means', () => {
      // The one field a caller is most likely to misread as a misconfiguration:
      // a portal on `0.0.0.0` is bound to every address rather than to none.
      expect(iscsiList.description).toContain('`0.0.0.0` IS NOT AN ADDRESS');
      expect(iscsiList.description).toContain('EVERY IPv4 address');
      expect(iscsiList.description).toContain('`::`');
    });

    it('says that a target is not related to a portal here', () => {
      // The tool reports both and joins neither, which a caller reading two
      // lists side by side would otherwise assume it had done.
      expect(iscsiList.description).toContain('DOES NOT SAY WHICH PORTAL SERVES WHICH TARGET');
    });
  });
});
