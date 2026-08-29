import { describe, expect, it } from 'vitest';
import { failingSystem } from '@/testing/fake-systems';
import { iscsiList, nvmeofList } from '@/tools/index';

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
        ...rows,
      },
      failures,
    );
    return (await iscsiList.handler(ctx, {})) as Listing;
  };

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
    });
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

  it('reports both reads failing without losing the targets themselves', async () => {
    const listing = await listed(
      {},
      {
        ['iscsi.extent.query']: new Error('denied'),
        ['iscsi.global.sessions']: new Error('service not running'),
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
    expect(listing.failures).toEqual([
      { source: 'extents', error: 'denied' },
      { source: 'initiators', error: 'service not running' },
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
      await listed({ ['iscsi.target.query']: [], ['iscsi.global.sessions']: [] }),
    ).toEqual({
      targets: [],
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
    ]);
    await listing;
  });
});

describe('nvmeof_list', () => {
  /**
   * A subsystem as `nvmet.subsys.query` reports one. `serial`, `pi_enable`,
   * `ana` and the three id lists are real fields of the payload the tool does
   * not name, and are here to be dropped — `hosts` and `namespaces` especially,
   * which the tool answers with the joined records rather than with these ids.
   */
  const subsystem = (over: Record<string, unknown> = {}) => ({
    id: 1,
    name: 'nvme0',
    subnqn: 'nqn.2011-06.com.truenas.ctl:nvme0',
    serial: 'a1b2c3d4e5f6',
    allow_any_host: false,
    pi_enable: false,
    qid_max: null,
    ieee_oui: null,
    ana: null,
    hosts: [3],
    namespaces: [7],
    ports: [1],
    ...over,
  });

  /**
   * A namespace as `nvmet.namespace.query` reports one: a ZVOL, which is the
   * kind that carries no `filesize` of its own.
   */
  const namespace = (over: Record<string, unknown> = {}) => ({
    id: 7,
    nsid: 1,
    subsys: { id: 1, name: 'nvme0' },
    device_type: 'ZVOL',
    device_path: 'zvol/tank/nvme0',
    filesize: null,
    device_uuid: '3fa85f64-5717-4562-b3fc-2c963f66afa6',
    device_nguid: 'e2b4c1a05f9d4c7e',
    enabled: true,
    locked: false,
    ...over,
  });

  /** A row of the join table allowing one host onto one subsystem. */
  const hostJoin = (over: Record<string, unknown> = {}) => ({
    id: 2,
    host: { id: 3, hostnqn: 'nqn.2014-08.org.nvmexpress:uuid:esx1', dhchap_key: null },
    subsys: { id: 1, name: 'nvme0' },
    ...over,
  });

  type Listing = {
    supported: boolean;
    unsupported_reason: string | null;
    subsystems: Record<string, unknown>[] | null;
    failures: Record<string, unknown>[];
    unattributed_namespaces: Record<string, unknown>[];
    unattributed_hosts: Record<string, unknown>[];
  };

  const listed = async (
    rows: Partial<Record<string, unknown>> = {},
    failures: Partial<Record<string, unknown>> = {},
  ): Promise<Listing> => {
    const { ctx } = failingSystem(
      {
        ['nvmet.subsys.query']: [subsystem()],
        ['nvmet.namespace.query']: [namespace()],
        ['nvmet.host_subsys.query']: [hostJoin()],
        ...rows,
      },
      failures,
    );
    return (await nvmeofList.handler(ctx, {})) as Listing;
  };

  /** The single subsystem of a listing, for the cases about one's fields. */
  const onlySubsystem = async (
    rows: Partial<Record<string, unknown>> = {},
    failures: Partial<Record<string, unknown>> = {},
  ): Promise<Record<string, unknown>> => ((await listed(rows, failures)).subsystems ?? [])[0];

  it('reports each subsystem with its allowed hosts and its namespaces', async () => {
    expect(await listed()).toEqual({
      supported: true,
      unsupported_reason: null,
      subsystems: [
        {
          id: 1,
          name: 'nvme0',
          nqn: 'nqn.2011-06.com.truenas.ctl:nvme0',
          allow_any_host: false,
          hosts: ['nqn.2014-08.org.nvmexpress:uuid:esx1'],
          namespaces: [
            {
              id: 7,
              nsid: 1,
              device_type: 'ZVOL',
              device_path: 'zvol/tank/nvme0',
              size_bytes: null,
              enabled: true,
              locked: false,
            },
          ],
        },
      ],
      failures: [],
      unattributed_namespaces: [],
      unattributed_hosts: [],
    });
  });

  it('surfaces no field a later release adds', async () => {
    const listing = await listed({
      ['nvmet.subsys.query']: [subsystem({ future_field: 'added by a later release' })],
      ['nvmet.namespace.query']: [namespace({ future_field: 'added by a later release' })],
      ['nvmet.host_subsys.query']: [hostJoin({ future_field: 'added by a later release' })],
    });
    expect(Object.keys(listing)).toEqual([
      'supported',
      'unsupported_reason',
      'subsystems',
      'failures',
      'unattributed_namespaces',
      'unattributed_hosts',
    ]);
    const only = (listing.subsystems ?? [])[0];
    expect(Object.keys(only)).toEqual([
      'id',
      'name',
      'nqn',
      'allow_any_host',
      'hosts',
      'namespaces',
    ]);
    expect(Object.keys((only['namespaces'] as Record<string, unknown>[])[0])).toEqual([
      'id',
      'nsid',
      'device_type',
      'device_path',
      'size_bytes',
      'enabled',
      'locked',
    ]);
  });

  it('reports a subsystem with no namespaces as an empty list, not omitted', async () => {
    expect(await onlySubsystem({ ['nvmet.namespace.query']: [] })).toMatchObject({
      name: 'nvme0',
      namespaces: [],
    });
  });

  it('reports a subsystem no host is allowed onto as an empty list', async () => {
    expect(await onlySubsystem({ ['nvmet.host_subsys.query']: [] })).toMatchObject({ hosts: [] });
  });

  it('reports whether any host is admitted, so an empty list is not read as a bar', async () => {
    // With `allow_any_host` true the host list restricts nothing, and without
    // this field an empty one reads as a subsystem nobody may attach to.
    const listing = await listed({
      ['nvmet.subsys.query']: [
        subsystem({ allow_any_host: true }),
        subsystem({ id: 2, name: 'nvme1', allow_any_host: 'yes' }),
      ],
      ['nvmet.host_subsys.query']: [],
    });
    expect(
      (listing.subsystems ?? []).map((one) => [one['name'], one['allow_any_host'], one['hosts']]),
    ).toEqual([
      ['nvme0', true, []],
      // Present but not a boolean settles neither, so it is null rather than
      // the false that would assert the list is the whole of who may attach.
      ['nvme1', null, []],
    ]);
  });

  it('reports the backing device of a ZVOL namespace and of a FILE one', async () => {
    const namespaces = (
      await onlySubsystem({
        ['nvmet.namespace.query']: [
          namespace(),
          namespace({
            id: 8,
            nsid: 2,
            device_type: 'FILE',
            device_path: '/mnt/tank/nvme/logs.img',
            filesize: 10737418240,
          }),
        ],
      })
    )['namespaces'] as Record<string, unknown>[];
    // A ZVOL takes its size from the zvol and reports none here. Null is that
    // unlearned size — reporting 0 would say the namespace holds nothing.
    expect(namespaces[0]).toMatchObject({ device_type: 'ZVOL', size_bytes: null });
    expect(namespaces[1]).toMatchObject({
      device_type: 'FILE',
      device_path: '/mnt/tank/nvme/logs.img',
      size_bytes: 10737418240,
    });
  });

  it('reports a namespace field the system omitted or garbled as null', async () => {
    const namespaces = (
      await onlySubsystem({
        ['nvmet.namespace.query']: [
          { subsys: { id: 1 }, device_uuid: 'u', nsid: 'first', filesize: Number.NaN },
        ],
      })
    )['namespaces'] as Record<string, unknown>[];
    // `enabled` and `locked` especially: false would say the namespace is
    // definitely not serving, which the system did not report either way.
    expect(namespaces[0]).toEqual({
      id: null,
      nsid: null,
      device_type: null,
      device_path: null,
      size_bytes: null,
      enabled: null,
      locked: null,
    });
  });

  it('reads a subsystem field the system omitted as having none', async () => {
    expect(
      await onlySubsystem({ ['nvmet.subsys.query']: [{ id: 1, serial: 'a1b2c3' }] }),
    ).toMatchObject({ name: null, nqn: null, allow_any_host: null });
    for (const missing of [null, undefined, '']) {
      expect(
        await onlySubsystem({ ['nvmet.subsys.query']: [subsystem({ subnqn: missing })] }),
      ).toMatchObject({ nqn: null });
    }
  });

  it('groups namespaces and hosts under the subsystem each names', async () => {
    const listing = await listed({
      ['nvmet.subsys.query']: [subsystem(), subsystem({ id: 2, name: 'nvme1' })],
      ['nvmet.namespace.query']: [
        namespace(),
        namespace({ id: 8, nsid: 1, subsys: { id: 2 }, device_path: 'zvol/tank/nvme1' }),
        namespace({ id: 9, nsid: 2, device_path: 'zvol/tank/nvme0b' }),
      ],
      ['nvmet.host_subsys.query']: [
        hostJoin(),
        hostJoin({
          id: 5,
          subsys: { id: 2 },
          host: { id: 4, hostnqn: 'nqn.2014-08.org.nvmexpress:uuid:esx2' },
        }),
        hostJoin({ id: 6, host: { id: 4, hostnqn: 'nqn.2014-08.org.nvmexpress:uuid:esx2' } }),
      ],
    });
    expect(
      (listing.subsystems ?? []).map((one) => [
        one['name'],
        one['hosts'],
        (one['namespaces'] as Record<string, unknown>[]).map((each) => each['device_path']),
      ]),
    ).toEqual([
      [
        'nvme0',
        ['nqn.2014-08.org.nvmexpress:uuid:esx1', 'nqn.2014-08.org.nvmexpress:uuid:esx2'],
        ['zvol/tank/nvme0', 'zvol/tank/nvme0b'],
      ],
      ['nvme1', ['nqn.2014-08.org.nvmexpress:uuid:esx2'], ['zvol/tank/nvme1']],
    ]);
  });

  it('reports a row the system did not attribute to a subsystem rather than dropping it', async () => {
    // Filing it under a subsystem it may not belong to would report a namespace
    // on the wrong device, and a host as allowed onto one it is not. Dropping
    // it instead leaves an empty list saying the subsystem has none, which is
    // the answer that gets acted on — so it is reported beside the listing.
    const listing = await listed({
      ['nvmet.namespace.query']: [namespace({ subsys: { name: 'nvme0' } })],
      ['nvmet.host_subsys.query']: [hostJoin({ subsys: {} })],
    });
    expect((listing.subsystems ?? [])[0]).toMatchObject({ namespaces: [], hosts: [] });
    expect(listing.unattributed_namespaces).toEqual([
      {
        id: 7,
        nsid: 1,
        device_type: 'ZVOL',
        device_path: 'zvol/tank/nvme0',
        size_bytes: null,
        enabled: true,
        locked: false,
        // The record named a name and no id, so the name is what is left to
        // report it by. Both are null where it named neither, as here for the
        // host row.
        subsystem_id: null,
        subsystem: 'nvme0',
      },
    ]);
    expect(listing.unattributed_hosts).toEqual([
      {
        hostnqn: 'nqn.2014-08.org.nvmexpress:uuid:esx1',
        subsystem_id: null,
        subsystem: null,
      },
    ]);
    expect(listing.failures).toEqual([]);
  });

  it('reports a row naming a subsystem the listing does not contain', async () => {
    // The id is readable and answers to nothing, which drops the row as surely
    // as an unreadable one: it is filed under a key no subsystem ever reads.
    const listing = await listed({
      ['nvmet.namespace.query']: [namespace({ subsys: { id: 99, name: 'nvme9' } })],
      ['nvmet.host_subsys.query']: [hostJoin({ subsys: { id: 99, name: 'nvme9' } })],
    });
    expect((listing.subsystems ?? [])[0]).toMatchObject({ namespaces: [], hosts: [] });
    expect(listing.unattributed_namespaces).toMatchObject([
      { id: 7, subsystem_id: 99, subsystem: 'nvme9' },
    ]);
    expect(listing.unattributed_hosts).toEqual([
      {
        hostnqn: 'nqn.2014-08.org.nvmexpress:uuid:esx1',
        subsystem_id: 99,
        subsystem: 'nvme9',
      },
    ]);
    expect(listing.failures).toEqual([]);
  });

  it('reports a host row carrying no NQN rather than listing a nameless entry', async () => {
    for (const missing of [null, '', undefined]) {
      const listing = await listed({
        ['nvmet.host_subsys.query']: [hostJoin({ host: { id: 3, hostnqn: missing } })],
      });
      expect((listing.subsystems ?? [])[0]).toMatchObject({ hosts: [] });
      // The one kind that names a subsystem and still cannot be listed under
      // it: the grant is real, and there is no name to put in a list of names.
      expect(listing.unattributed_hosts).toEqual([
        { hostnqn: null, subsystem_id: 1, subsystem: 'nvme0' },
      ]);
    }
  });

  it('attributes nothing to a subsystem the system did not number', async () => {
    const listing = await listed({ ['nvmet.subsys.query']: [subsystem({ id: 'nvme0' })] });
    // Null as for a read that failed, because there is no id to join on — and
    // an empty `failures` is what tells this apart from that.
    expect((listing.subsystems ?? [])[0]).toEqual({
      id: null,
      name: 'nvme0',
      nqn: 'nqn.2011-06.com.truenas.ctl:nvme0',
      allow_any_host: false,
      hosts: null,
      namespaces: null,
    });
    expect(listing.failures).toEqual([]);
    // The rows named a subsystem this listing cannot answer to, so they are
    // reported rather than lost with the id that would have placed them.
    expect(listing.unattributed_namespaces).toMatchObject([{ id: 7, subsystem_id: 1 }]);
    expect(listing.unattributed_hosts).toMatchObject([{ subsystem_id: 1 }]);
  });

  it('reports nothing as unattributed where the read that would fill it failed', async () => {
    // Empty because no row was read to place, not because every row was placed.
    // `failures` is what carries the difference.
    const listing = await listed(
      {},
      {
        ['nvmet.namespace.query']: new Error('denied'),
        ['nvmet.host_subsys.query']: new Error('denied'),
      },
    );
    expect(listing.unattributed_namespaces).toEqual([]);
    expect(listing.unattributed_hosts).toEqual([]);
    expect(listing.failures).toHaveLength(2);
  });

  it('distinguishes namespaces that could not be read from a subsystem with none', async () => {
    const listing = await listed({}, { ['nvmet.namespace.query']: new Error('denied') });
    // Null rather than empty: an empty list would say the subsystem exports
    // nothing, which is the one answer this tool must not invent.
    expect((listing.subsystems ?? [])[0]).toMatchObject({ namespaces: null });
    expect((listing.subsystems ?? [])[0]).not.toMatchObject({ hosts: null });
    expect(listing.failures).toEqual([{ source: 'namespaces', error: 'denied' }]);
  });

  it('distinguishes hosts that could not be read from a subsystem with none', async () => {
    const listing = await listed({}, { ['nvmet.host_subsys.query']: new Error('denied') });
    expect((listing.subsystems ?? [])[0]).toMatchObject({ hosts: null });
    expect((listing.subsystems ?? [])[0]).not.toMatchObject({ namespaces: null });
    expect(listing.failures).toEqual([{ source: 'hosts', error: 'denied' }]);
  });

  it('reports both reads failing without losing the subsystems themselves', async () => {
    const listing = await listed(
      {},
      {
        ['nvmet.namespace.query']: new Error('denied'),
        ['nvmet.host_subsys.query']: new Error('service not running'),
      },
    );
    expect(listing.subsystems).toEqual([
      {
        id: 1,
        name: 'nvme0',
        nqn: 'nqn.2011-06.com.truenas.ctl:nvme0',
        allow_any_host: false,
        hosts: null,
        namespaces: null,
      },
    ]);
    expect(listing.failures).toEqual([
      { source: 'namespaces', error: 'denied' },
      { source: 'hosts', error: 'service not running' },
    ]);
  });

  it('names a failure the system sent as an object rather than an Error', async () => {
    // What a failed call actually rejects with: the client's own error types
    // are a middleware object carrying `reason` and a JSON-RPC one carrying
    // `message`. Reading neither reported every real failure as silent.
    for (const [reason, error] of [
      ['connection reset', 'connection reset'],
      [{ reason: 'Not authorized' }, 'Not authorized'],
      [{ code: 500, message: 'Internal error' }, 'Internal error'],
      [new Error(''), 'the system reported no reason'],
      [{ code: 500 }, 'the system reported no reason'],
      [504, 'the system reported no reason'],
    ] as [unknown, string][]) {
      expect((await listed({}, { ['nvmet.host_subsys.query']: reason })).failures).toEqual([
        { source: 'hosts', error },
      ]);
    }
  });

  it('reports a system whose version has no NVMe-oF as unsupported, not as empty', async () => {
    // Every spelling of "no such method" the client's error types allow: the
    // JSON-RPC code, the middleware's error name, either text field, and the
    // nested `data` a JSON-RPC error wraps a middleware one in.
    for (const reason of [
      new Error('[ENOMETHOD] Method "nvmet.subsys.query" not found'),
      '[ENOMETHOD] no such method',
      { code: -32601, message: 'Method not found' },
      { errname: 'ENOMETHOD', reason: 'Method does not exist' },
      { reason: '[ENOMETHOD] Method does not exist' },
      { message: '[ENOMETHOD] Method does not exist' },
      { code: -32000, message: 'call failed', data: { errname: 'ENOMETHOD', reason: 'gone' } },
    ]) {
      expect(await listed({}, { ['nvmet.subsys.query']: reason })).toMatchObject({
        supported: false,
        subsystems: null,
        // The other two reads fail the same way on such a system; naming them
        // would report one absent feature three times, as three defects. No row
        // was read either, so nothing was left out of a list.
        failures: [],
        unattributed_namespaces: [],
        unattributed_hosts: [],
      });
    }
    expect(
      (await listed({}, { ['nvmet.subsys.query']: { code: -32601, message: 'Method not found' } }))
        .unsupported_reason,
    ).toBe('Method not found');
  });

  it('raises rather than calling a read it could not make unsupported', async () => {
    // "This system has no NVMe-oF" is a claim about the system, and a denied or
    // dropped read is evidence for no such claim.
    await expect(listed({}, { ['nvmet.subsys.query']: new Error('denied') })).rejects.toThrow(
      'denied',
    );
    await expect(
      listed({}, { ['nvmet.subsys.query']: { code: -32000, message: 'connection reset' } }),
    ).rejects.toEqual({ code: -32000, message: 'connection reset' });
    await expect(listed({}, { ['nvmet.subsys.query']: 'connection reset' })).rejects.toBe(
      'connection reset',
    );
    await expect(listed({}, { ['nvmet.subsys.query']: null })).rejects.toBeNull();
  });

  it('reports a system that has NVMe-oF and no subsystems as an empty list', async () => {
    expect(
      await listed({
        ['nvmet.subsys.query']: [],
        ['nvmet.namespace.query']: [],
        ['nvmet.host_subsys.query']: [],
      }),
    ).toEqual({
      supported: true,
      unsupported_reason: null,
      subsystems: [],
      failures: [],
      unattributed_namespaces: [],
      unattributed_hosts: [],
    });
  });

  it('issues every read before awaiting any of them', async () => {
    const { ctx, query } = failingSystem({
      ['nvmet.subsys.query']: [subsystem()],
      ['nvmet.namespace.query']: [namespace()],
      ['nvmet.host_subsys.query']: [hostJoin()],
    });
    const listing = nvmeofList.handler(ctx, {});
    // Asserted before the handler is awaited at all, which is what makes this
    // about concurrency rather than order: a handler that awaited one read
    // before starting the next would have made one call by this point.
    expect(query.mock.calls.map((one) => one[0])).toEqual([
      'nvmet.subsys.query',
      'nvmet.namespace.query',
      'nvmet.host_subsys.query',
    ]);
    await listing;
  });
});
