import { describe, expect, it } from 'vitest';
import { failingSystem } from '@/testing/fake-systems';
import { fcList, nvmeofList } from '@/tools/index';

/**
 * `iscsi_list` was split out to `iscsi-list.spec.ts` under #87's exception when
 * #138 grew two of this module's three tools past the 1,500-line trigger this
 * file already sat three lines under. The two below stay here: the split is by
 * tool, and the module's own spec keeping the tools a split did not have to
 * move is #121's shape rather than a half-finished state to tidy.
 */
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

  /**
   * A port as `nvmet.port.query` reports one. `inline_data_size`,
   * `max_queue_size` and `pi_enable` are real fields of the payload the tool
   * does not name, and are here to be dropped.
   */
  const port = (over: Record<string, unknown> = {}) => ({
    id: 1,
    index: 1,
    addr_trtype: 'TCP',
    addr_trsvcid: 4420,
    addr_traddr: '10.0.0.10',
    addr_adrfam: 'IPV4',
    inline_data_size: null,
    max_queue_size: null,
    pi_enable: null,
    enabled: true,
    ...over,
  });

  /**
   * A row of the join table publishing one subsystem on one port. It embeds
   * BOTH entities whole, and neither may be forwarded.
   */
  const portJoin = (over: Record<string, unknown> = {}) => ({
    id: 5,
    port: port(),
    subsys: subsystem(),
    ...over,
  });

  type Listing = {
    supported: boolean;
    unsupported_reason: string | null;
    subsystems: Record<string, unknown>[] | null;
    ports: Record<string, unknown>[] | null;
    failures: Record<string, unknown>[];
    unattributed_namespaces: Record<string, unknown>[];
    unattributed_hosts: Record<string, unknown>[];
    unattributed_port_subsystems: Record<string, unknown>[];
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
        ['nvmet.port.query']: [port()],
        ['nvmet.port_subsys.query']: [portJoin()],
        ...rows,
      },
      failures,
    );
    return (await nvmeofList.handler(ctx, {})) as Listing;
  };

  /** The single port of a listing, for the cases about one port's fields. */
  const onlyPort = async (
    rows: Partial<Record<string, unknown>> = {},
    failures: Partial<Record<string, unknown>> = {},
  ): Promise<Record<string, unknown>> => ((await listed(rows, failures)).ports ?? [])[0];

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
      ports: [
        {
          id: 1,
          index: 1,
          transport: 'TCP',
          address_family: 'IPV4',
          address: '10.0.0.10',
          service_id: 4420,
          enabled: true,
          enabled_reported: true,
          subsystems: [{ subsystem_id: 1, subsystem: 'nvme0' }],
        },
      ],
      failures: [],
      unattributed_namespaces: [],
      unattributed_hosts: [],
      unattributed_port_subsystems: [],
    });
  });

  it('surfaces no field a later release adds', async () => {
    const listing = await listed({
      ['nvmet.subsys.query']: [subsystem({ future_field: 'added by a later release' })],
      ['nvmet.namespace.query']: [namespace({ future_field: 'added by a later release' })],
      ['nvmet.host_subsys.query']: [hostJoin({ future_field: 'added by a later release' })],
      ['nvmet.port.query']: [port({ future_field: 'added by a later release' })],
      ['nvmet.port_subsys.query']: [
        portJoin({
          future_field: 'added by a later release',
          // Both embedded entities carry one, and forwarding either is what
          // this assertion exists to catch (#100).
          port: port({ future_field: 'added by a later release' }),
          subsys: subsystem({ future_field: 'added by a later release' }),
        }),
      ],
    });
    expect(Object.keys(listing)).toEqual([
      'supported',
      'unsupported_reason',
      'subsystems',
      'ports',
      'failures',
      'unattributed_namespaces',
      'unattributed_hosts',
      'unattributed_port_subsystems',
    ]);
    const onePort = (listing.ports ?? [])[0];
    expect(Object.keys(onePort)).toEqual([
      'id',
      'index',
      'transport',
      'address_family',
      'address',
      'service_id',
      'enabled',
      'enabled_reported',
      'subsystems',
    ]);
    expect(Object.keys((onePort['subsystems'] as Record<string, unknown>[])[0])).toEqual([
      'subsystem_id',
      'subsystem',
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
        // Null here for the OTHER of the two causes the description names:
        // nothing was read, rather than a port read that failed.
        ports: null,
        // The other four reads fail the same way on such a system; naming them
        // would report one absent feature five times, as five defects. No row
        // was read either, so nothing was left out of a list.
        failures: [],
        unattributed_namespaces: [],
        unattributed_hosts: [],
        unattributed_port_subsystems: [],
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
        ['nvmet.port.query']: [],
        ['nvmet.port_subsys.query']: [],
      }),
    ).toEqual({
      supported: true,
      unsupported_reason: null,
      subsystems: [],
      ports: [],
      failures: [],
      unattributed_namespaces: [],
      unattributed_hosts: [],
      unattributed_port_subsystems: [],
    });
  });

  it('issues every read before awaiting any of them', async () => {
    const { ctx, query } = failingSystem({
      ['nvmet.subsys.query']: [subsystem()],
      ['nvmet.namespace.query']: [namespace()],
      ['nvmet.host_subsys.query']: [hostJoin()],
      ['nvmet.port.query']: [port()],
      ['nvmet.port_subsys.query']: [portJoin()],
    });
    const listing = nvmeofList.handler(ctx, {});
    // Asserted before the handler is awaited at all, which is what makes this
    // about concurrency rather than order: a handler that awaited one read
    // before starting the next would have made one call by this point.
    expect(query.mock.calls.map((one) => one[0])).toEqual([
      'nvmet.subsys.query',
      'nvmet.namespace.query',
      'nvmet.host_subsys.query',
      'nvmet.port.query',
      'nvmet.port_subsys.query',
    ]);
    await listing;
  });

  describe('where the service listens', () => {
    it('reports each port with the subsystems published through it', async () => {
      const listing = await listed({
        ['nvmet.subsys.query']: [subsystem(), subsystem({ id: 2, name: 'nvme1' })],
        ['nvmet.port.query']: [port(), port({ id: 2, index: 2, addr_traddr: '10.0.1.10' })],
        ['nvmet.port_subsys.query']: [
          portJoin(),
          portJoin({ id: 6, port: port({ id: 2 }), subsys: subsystem({ id: 2, name: 'nvme1' }) }),
          portJoin({ id: 7, port: port({ id: 2 }) }),
        ],
      });
      expect((listing.ports ?? []).map((one) => [one['id'], one['subsystems']])).toEqual([
        [1, [{ subsystem_id: 1, subsystem: 'nvme0' }]],
        [
          2,
          [
            { subsystem_id: 2, subsystem: 'nvme1' },
            { subsystem_id: 1, subsystem: 'nvme0' },
          ],
        ],
      ]);
      expect(listing.unattributed_port_subsystems).toEqual([]);
    });

    it('reports the service id as the system spelled it, without coercing it', async () => {
      // `addr_trsvcid` is declared `number | string | null`: a TCP port number
      // on a TCP port and something else on an FC one. Converting either way
      // would assert a meaning the surface does not state.
      for (const [sent, reported] of [
        [4420, 4420],
        ['4420', '4420'],
        ['none', 'none'],
        [null, null],
        ['', null],
        [Number.NaN, null],
        [{ port: 4420 }, null],
      ] as [unknown, unknown][]) {
        expect(
          await onlyPort({ ['nvmet.port.query']: [port({ addr_trsvcid: sent })] }),
        ).toMatchObject({ service_id: reported });
      }
    });

    it('tells a port that did not report `enabled` from a disabled one', async () => {
      expect(await onlyPort({ ['nvmet.port.query']: [port({ enabled: false })] })).toMatchObject({
        enabled: false,
        enabled_reported: true,
      });
      // The field is optional on the payload, so its absence is a TrueNAS that
      // does not report it rather than a port that is switched off.
      const without = port();
      delete (without as Record<string, unknown>)['enabled'];
      expect(await onlyPort({ ['nvmet.port.query']: [without] })).toMatchObject({
        enabled: null,
        enabled_reported: false,
      });
      // Reported, and not a boolean: the system said something this tool could
      // not read, which is a third answer again.
      expect(await onlyPort({ ['nvmet.port.query']: [port({ enabled: 'yes' })] })).toMatchObject({
        enabled: null,
        enabled_reported: true,
      });
    });

    it('does not read `enabled` off the prototype chain', async () => {
      // Plain property access walks the prototype and `Object.hasOwn` does not,
      // so a value read that way could sit beside `enabled_reported: false`.
      const inherited = Object.assign(Object.create({ enabled: true }), port());
      delete (inherited as Record<string, unknown>)['enabled'];
      expect(await onlyPort({ ['nvmet.port.query']: [inherited] })).toMatchObject({
        enabled: null,
        enabled_reported: false,
      });
    });

    it('reports a port field the system did not report as null', async () => {
      expect(await onlyPort({ ['nvmet.port.query']: [{ addr_traddr: '' }] })).toEqual({
        id: null,
        index: null,
        transport: null,
        address_family: null,
        // An empty address is reported as null, as a field that could not be
        // read is: the catalog does not establish what an empty one means.
        address: null,
        service_id: null,
        enabled: null,
        enabled_reported: false,
        // Null rather than empty, because the port carries no id for a
        // publication to be joined on — the case below.
        subsystems: null,
      });
    });

    it('reports a transport this catalog does not recognise as null', async () => {
      // The three values are read off the OLDEST supported directory (#101), so
      // a later TrueNAS can send a fourth. Passing it through would put a word
      // in a field whose type holds three, and a caller switching on it would
      // fall through every arm.
      expect(
        await onlyPort({
          ['nvmet.port.query']: [port({ addr_trtype: 'ROCE', addr_adrfam: 'IB' })],
        }),
      ).toMatchObject({ transport: null, address_family: null });
    });

    it('reports an FC port as a transport rather than as FC hardware', async () => {
      expect(
        await onlyPort({
          ['nvmet.port.query']: [
            port({ addr_trtype: 'FC', addr_adrfam: 'FC', addr_trsvcid: null }),
          ],
        }),
      ).toMatchObject({ transport: 'FC', address_family: 'FC', service_id: null });
      expect(nvmeofList.description).toContain('NOT A STATEMENT ABOUT THE FC HARDWARE');
    });

    it('keeps a publication naming a subsystem it could not identify', async () => {
      // Dropping it would say the port publishes less than it does; keeping it
      // costs a row that cannot be joined against the listing, which the
      // description states (#93).
      const only = await onlyPort({
        ['nvmet.port_subsys.query']: [
          portJoin({ subsys: { id: 'one', name: 42 } }),
          // The whole embedded record being something else answers the same
          // way, rather than throwing and taking every publication with it.
          portJoin({ id: 6, subsys: 'nvme0' }),
        ],
      });
      expect(only['subsystems']).toEqual([
        { subsystem_id: null, subsystem: null },
        { subsystem_id: null, subsystem: null },
      ]);
    });

    it('reports a publication naming a subsystem this listing does not report', async () => {
      // The two are separate round trips, so a subsystem deleted between them
      // leaves a publication naming it. It is kept under its port — dropping it
      // would say the port publishes less than it does — and the description
      // says outright that these fields are the publication's claim rather
      // than a lookup, so a caller joining them can find nothing.
      const only = await onlyPort({
        ['nvmet.port_subsys.query']: [portJoin({ subsys: subsystem({ id: 9, name: 'gone' }) })],
      });
      expect(only['subsystems']).toEqual([{ subsystem_id: 9, subsystem: 'gone' }]);
      expect(nvmeofList.description).toContain('RATHER THAN A LOOKUP');
    });

    it('sets aside a publication naming a port this listing does not report', async () => {
      const listing = await listed({
        ['nvmet.port_subsys.query']: [
          portJoin({ port: port({ id: 9 }) }),
          portJoin({ id: 6, port: 'not a record' }),
        ],
      });
      // Dropped, both would leave the port reading as publishing nothing.
      expect((listing.ports ?? [])[0]['subsystems']).toEqual([]);
      expect(listing.unattributed_port_subsystems).toEqual([
        { subsystem_id: 1, subsystem: 'nvme0', port_id: 9 },
        { subsystem_id: 1, subsystem: 'nvme0', port_id: null },
      ]);
    });

    it('sets every publication aside when the ports themselves could not be read', async () => {
      const listing = await listed({}, { ['nvmet.port.query']: new Error('denied') });
      expect(listing.ports).toBeNull();
      expect(listing.unattributed_port_subsystems).toEqual([
        { subsystem_id: 1, subsystem: 'nvme0', port_id: 1 },
      ]);
      expect(listing.failures).toEqual([{ source: 'ports', error: 'denied' }]);
    });

    it('distinguishes publications that could not be read from a port with none', async () => {
      const listing = await listed({}, { ['nvmet.port_subsys.query']: new Error('denied') });
      // Null rather than empty: empty would say nothing is reachable through
      // the port, which is the answer this tool must not invent.
      expect((listing.ports ?? [])[0]['subsystems']).toBeNull();
      expect(listing.unattributed_port_subsystems).toEqual([]);
      expect(listing.failures).toEqual([{ source: 'port_subsystems', error: 'denied' }]);
      expect((listing.subsystems ?? [])[0]['namespaces']).not.toBeNull();
    });

    it('reports no publications for a port the system did not number', async () => {
      const listing = await listed({ ['nvmet.port.query']: [port({ id: null })] });
      // There is nothing for a publication to be joined on, which is not the
      // same answer as a read that failed.
      expect((listing.ports ?? [])[0]['subsystems']).toBeNull();
      expect(listing.unattributed_port_subsystems).toEqual([
        { subsystem_id: 1, subsystem: 'nvme0', port_id: 1 },
      ]);
      expect(listing.failures).toEqual([]);
    });

    it('distinguishes a system with no port from one whose ports failed', async () => {
      expect((await listed({ ['nvmet.port.query']: [] })).ports).toEqual([]);
      expect((await listed({}, { ['nvmet.port.query']: 'connection reset' })).ports).toBeNull();
    });

    it('keeps the subsystems when both listener reads failed', async () => {
      const listing = await listed(
        {},
        {
          ['nvmet.port.query']: new Error('denied'),
          ['nvmet.port_subsys.query']: new Error('service not running'),
        },
      );
      expect((listing.subsystems ?? [])[0]).toMatchObject({ id: 1, name: 'nvme0' });
      expect(listing.failures).toEqual([
        { source: 'ports', error: 'denied' },
        { source: 'port_subsystems', error: 'service not running' },
      ]);
    });
  });

  describe('its description', () => {
    it('says where a subsystem\'s ports are read from, now that they are reported', () => {
      // The tool used to say outright that it did not report this. A caller
      // reading that sentence beside the field it denies is the failure the
      // reconciliation prevents.
      expect(nvmeofList.description).toContain('READ FROM `ports[].subsystems`');
      expect(nvmeofList.description).not.toContain('does not report which ports');
    });

    it('says that a service id is not converted between its two spellings', () => {
      expect(nvmeofList.description).toContain('AS THE SYSTEM SPELLED IT');
    });
  });
});

/**
 * Here rather than in a spec of its own, under #87's default: the split
 * exception is checked each time this file grows, and the margin it recorded —
 * three lines — is what #138 spent. That ticket grew `iscsi_list` and
 * `nvmeof_list`, so `iscsi_list` took the spec named for it and this block did
 * not move: the trigger is a file size, and moving either of the two blocks
 * that ticket had open brought this one back under it. A tool added to this family now
 * measures again against what is left rather than against the old number.
 */
describe('fc_list', () => {
  /**
   * A host adapter as `fc.fc_host.query` reports one. `npiv` is optional on the
   * declared entity and is present here; the cases about it absent build a row
   * without it rather than overriding it to undefined, since the tool reads
   * whether the KEY is there.
   */
  const host = (over: Record<string, unknown> = {}) => ({
    id: 1,
    alias: 'fc0',
    wwpn: '0x21000024ff0a1b2c',
    wwpn_b: '0x21000024ff0a1b2d',
    npiv: 2,
    ...over,
  });

  /**
   * A port as `fcport.query` reports one. `target` is an open record on the
   * declared entity and carries more than the id this tool reduces it to, which
   * is what the reduction has to drop.
   */
  const port = (over: Record<string, unknown> = {}) => ({
    id: 3,
    port: 'fc0',
    wwpn: '0x21000024ff0a1b2c',
    wwpn_b: '0x21000024ff0a1b2d',
    target: { id: 11, name: 'tgt0', alias: 'VMware datastore', mode: 'FC' },
    ...over,
  });

  /**
   * A status row as `fcport.status` might report one. Every key here is a guess
   * — the payload is an open record the middleware declares nothing about — so
   * `extra` stands for the keys a real system carries that the allowlist does
   * not name, which is what `unreported_fields` is for.
   */
  const status = (over: Record<string, unknown> = {}) => ({
    port: 'fc0',
    port_type: 'NPort (fabric via point-to-point)',
    port_state: 'Online',
    speed: '16 Gbit',
    ...over,
  });

  type Listing = {
    hosts: Record<string, unknown>[] | null;
    ports: Record<string, unknown>[] | null;
    failures: Record<string, unknown>[];
    unattributed_status: Record<string, unknown>[];
  };

  const listed = async (
    rows: Partial<Record<string, unknown>> = {},
    failures: Partial<Record<string, unknown>> = {},
  ): Promise<Listing> => {
    const { ctx } = failingSystem(
      {
        ['fc.fc_host.query']: [host()],
        ['fcport.query']: [port()],
        ['fcport.status']: [status()],
        ...rows,
      },
      failures,
    );
    return (await fcList.handler(ctx, {})) as Listing;
  };

  /** The single host of a listing, for the cases about one adapter's fields. */
  const onlyHost = async (over: Record<string, unknown> = {}) => {
    const listing = await listed({ ['fc.fc_host.query']: [host(over)] });
    return (listing.hosts ?? [])[0];
  };

  /** The single port of a listing, for the cases about one port's fields. */
  const onlyPort = async (
    over: Record<string, unknown> = {},
    rows: Partial<Record<string, unknown>> = {},
  ) => {
    const listing = await listed({ ['fcport.query']: [port(over)], ...rows });
    return (listing.ports ?? [])[0];
  };

  /** The single status row attributed to the single port. */
  const onlyStatus = async (over: Record<string, unknown> = {}) => {
    const listing = await listed({ ['fcport.status']: [status(over)] });
    return ((listing.ports ?? [])[0]['status'] as Record<string, unknown>[])[0];
  };

  it('is advertised as read-only and non-mutating', () => {
    expect(fcList.mutating).toBe(false);
    expect(fcList.name).toBe('fc_list');
  });

  it('reads the three FC methods and nothing else', async () => {
    const { ctx, query, call } = failingSystem({
      ['fc.fc_host.query']: [host()],
      ['fcport.query']: [port()],
      ['fcport.status']: [status()],
    });
    await fcList.handler(ctx, {});
    expect(query.mock.calls.map(([method]) => method)).toEqual([
      'fc.fc_host.query',
      'fcport.query',
    ]);
    expect(call.mock.calls.map(([method]) => method)).toEqual(['fcport.status']);
  });

  describe('host adapters', () => {
    it('reports the adapter and both controllers’ WWPNs', async () => {
      expect(await onlyHost()).toEqual({
        id: 1,
        alias: 'fc0',
        wwpn: '0x21000024ff0a1b2c',
        wwpn_b: '0x21000024ff0a1b2d',
        npiv: 2,
        npiv_reported: true,
      });
    });

    it('reports a single-controller appliance’s absent peer WWPN as null', async () => {
      expect((await onlyHost({ wwpn_b: null }))['wwpn_b']).toBeNull();
    });

    it('reports an empty alias as no value rather than as a name', async () => {
      expect((await onlyHost({ alias: '' }))['alias']).toBeNull();
    });

    it('reports an id that did not read as a number as null', async () => {
      expect((await onlyHost({ id: 'first' }))['id']).toBeNull();
    });

    // The companion field #134 established over the same `field?: T` signature:
    // one null, two causes, and only this separates them.
    it('reports npiv_reported false where the system omitted the field', async () => {
      const { ctx } = failingSystem({
        ['fc.fc_host.query']: [{ id: 1, alias: 'fc0', wwpn: null, wwpn_b: null }],
        ['fcport.query']: [],
        ['fcport.status']: [],
      });
      const listing = (await fcList.handler(ctx, {})) as Listing;
      expect((listing.hosts ?? [])[0]).toMatchObject({ npiv: null, npiv_reported: false });
    });

    it('reports npiv_reported true beside a null npiv where the value did not read', async () => {
      expect(await onlyHost({ npiv: 'two' })).toMatchObject({
        npiv: null,
        npiv_reported: true,
      });
    });

    it('reports a zero npiv as a count rather than as an absence', async () => {
      expect(await onlyHost({ npiv: 0 })).toMatchObject({ npiv: 0, npiv_reported: true });
    });

    // `Object.hasOwn` rather than `in`, which walks the prototype (#101). Only
    // the flag is asserted: reading `host.npiv` walks the chain like any
    // property access, so an inherited key still produces a value — what must
    // not happen is that value being ADVERTISED as one the system reported.
    it('does not read an inherited key as a reported field', async () => {
      const inherited = Object.create({ npiv: 4 }) as Record<string, unknown>;
      Object.assign(inherited, { id: 1, alias: 'fc0', wwpn: null, wwpn_b: null });
      const { ctx } = failingSystem({
        ['fc.fc_host.query']: [inherited],
        ['fcport.query']: [],
        ['fcport.status']: [],
      });
      const listing = (await fcList.handler(ctx, {})) as Listing;
      expect((listing.hosts ?? [])[0]['npiv_reported']).toBe(false);
    });
  });

  describe('ports and the target they are mapped to', () => {
    it('reduces the target record to its id and drops the rest of it', async () => {
      expect(await onlyPort()).toEqual({
        id: 3,
        port: 'fc0',
        wwpn: '0x21000024ff0a1b2c',
        wwpn_b: '0x21000024ff0a1b2d',
        target_mapped: true,
        target_id: 11,
        status: [
          {
            port: 'fc0',
            port_type: 'NPort (fabric via point-to-point)',
            port_state: 'Online',
            speed: '16 Gbit',
            unreported_fields: [],
          },
        ],
      });
    });

    it('reports a port mapped to no target as target_mapped false', async () => {
      expect(await onlyPort({ target: null })).toMatchObject({
        target_mapped: false,
        target_id: null,
      });
    });

    it('separates an unreadable target record from a port mapped to nothing', async () => {
      expect(await onlyPort({ target: 'tgt0' })).toMatchObject({
        target_mapped: null,
        target_id: null,
      });
    });

    it('does not read a list as a target record', async () => {
      expect(await onlyPort({ target: [{ id: 11 }] })).toMatchObject({
        target_mapped: null,
        target_id: null,
      });
    });

    it('reports a mapping whose target carried no readable id as mapped anyway', async () => {
      expect(await onlyPort({ target: { name: 'tgt0' } })).toMatchObject({
        target_mapped: true,
        target_id: null,
      });
    });

    it('reports a port name the system did not send as null', async () => {
      expect((await onlyPort({ port: '' }))['port']).toBeNull();
    });
  });

  describe('the unconfirmed status allowlist', () => {
    it('names every key a row carried whose value it does not report', async () => {
      expect((await onlyStatus({ physical_port_state: 'Online', node_name: '0x2000' }))[
        'unreported_fields'
      ]).toEqual(['node_name', 'physical_port_state']);
    });

    // The likelier failure of an unconfirmed allowlist is a right key over an
    // unexpected value type, and a list built from the ALLOWLIST would hide it:
    // it would answer "every key is reported" beside a null field.
    it('names a key whose value the guard rejected, not only one nobody looked for', async () => {
      const row = await onlyStatus({ speed: 16 });
      expect(row['speed']).toBeNull();
      expect(row['unreported_fields']).toEqual(['speed']);
    });

    it('reports an empty unreported_fields where every key it carried is reported', async () => {
      expect((await onlyStatus())['unreported_fields']).toEqual([]);
    });

    it('sorts the names so two systems reporting the same keys answer alike', async () => {
      expect((await onlyStatus({ zeta: 1, alpha: 2 }))['unreported_fields']).toEqual([
        'alpha',
        'zeta',
      ]);
    });

    it('keeps an entry that was not a record at all, as a row of nulls', async () => {
      const listing = await listed({ ['fcport.status']: ['Online'] });
      expect(listing.unattributed_status).toEqual([
        {
          port: null,
          port_type: null,
          port_state: null,
          speed: null,
          unreported_fields: null,
        },
      ]);
    });

    it('tells a non-record entry from a record that named no port', async () => {
      const listing = await listed({ ['fcport.status']: [{ port_state: 'Online' }] });
      expect(listing.unattributed_status).toEqual([
        {
          port: null,
          port_type: null,
          port_state: 'Online',
          speed: null,
          unreported_fields: [],
        },
      ]);
    });
  });

  describe('attributing a status row to a port', () => {
    it('files every row naming one port under it', async () => {
      const listing = await listed({
        ['fcport.status']: [status(), status({ port_state: 'Linkdown' })],
      });
      const rows = (listing.ports ?? [])[0]['status'] as Record<string, unknown>[];
      expect(rows.map((row) => row['port_state'])).toEqual(['Online', 'Linkdown']);
      expect(listing.unattributed_status).toEqual([]);
    });

    it('sets aside a row naming a port no listed port answers to', async () => {
      const listing = await listed({ ['fcport.status']: [status({ port: 'fc9' })] });
      expect((listing.ports ?? [])[0]['status']).toEqual([]);
      expect(listing.unattributed_status).toHaveLength(1);
      expect(listing.unattributed_status[0]['port']).toBe('fc9');
    });

    it('reports an empty status where the read succeeded and named no port here', async () => {
      const listing = await listed({ ['fcport.status']: [] });
      expect((listing.ports ?? [])[0]['status']).toEqual([]);
      expect(listing.failures).toEqual([]);
    });

    // The second cause of a null `status`, and the one `failures` cannot show:
    // a port with no name has nothing for a status row to be joined on, and the
    // read that would have filled it succeeded.
    it('reports a null status for a port the system did not name, with no failure', async () => {
      const listing = await listed({ ['fcport.query']: [port({ port: '' })] });
      expect((listing.ports ?? [])[0]).toMatchObject({ port: null, status: null });
      expect(listing.failures).toEqual([]);
      expect(listing.unattributed_status).toHaveLength(1);
    });

    it('sets aside every row where the port read failed', async () => {
      const listing = await listed({}, { ['fcport.query']: new Error('down') });
      expect(listing.ports).toBeNull();
      expect(listing.unattributed_status).toHaveLength(1);
      expect(listing.failures).toEqual([{ source: 'ports', error: 'down' }]);
    });

    // The third shape a full `unattributed_status` takes, and the reason the
    // description refuses to partition it: an adapter with no port mapped reads
    // both lists successfully and still attributes nothing. It is neither a
    // failed read nor a join key that does not hold.
    it('sets aside every row where the ports read succeeded and listed none', async () => {
      const listing = await listed({ ['fcport.query']: [] });
      expect(listing.ports).toEqual([]);
      expect(listing.failures).toEqual([]);
      expect(listing.unattributed_status).toHaveLength(1);
    });
  });

  describe('a read that failed', () => {
    it('names the host read and still answers the other two', async () => {
      const listing = await listed({}, { ['fc.fc_host.query']: new Error('no such method') });
      expect(listing.hosts).toBeNull();
      expect(listing.ports).toHaveLength(1);
      expect(listing.failures).toEqual([{ source: 'hosts', error: 'no such method' }]);
    });

    it('names the port read and still answers the other two', async () => {
      const listing = await listed({}, { ['fcport.query']: { reason: 'denied' } });
      expect(listing.ports).toBeNull();
      expect(listing.hosts).toHaveLength(1);
      expect(listing.failures).toEqual([{ source: 'ports', error: 'denied' }]);
    });

    // Null rather than empty: an empty `status` says the read placed nothing on
    // this port, which is a claim about the link a failed read never made.
    it('names the status read and reports a null status rather than an empty one', async () => {
      const listing = await listed({}, { ['fcport.status']: new Error('timed out') });
      expect((listing.ports ?? [])[0]['status']).toBeNull();
      expect(listing.unattributed_status).toEqual([]);
      expect(listing.failures).toEqual([{ source: 'port_status', error: 'timed out' }]);
    });

    it('names all three in read order where none of them answered', async () => {
      const listing = await listed(
        {},
        {
          ['fc.fc_host.query']: new Error('a'),
          ['fcport.query']: new Error('b'),
          ['fcport.status']: new Error('c'),
        },
      );
      expect(listing).toEqual({
        hosts: null,
        ports: null,
        failures: [
          { source: 'hosts', error: 'a' },
          { source: 'ports', error: 'b' },
          { source: 'port_status', error: 'c' },
        ],
        unattributed_status: [],
      });
    });
  });

  // The common case the ticket names: an appliance with no FC hardware. It must
  // answer rather than throw, and an empty answer is not a failure.
  it('answers cleanly on a system with no Fibre Channel hardware', async () => {
    const listing = await listed({
      ['fc.fc_host.query']: [],
      ['fcport.query']: [],
      ['fcport.status']: [],
    });
    expect(listing).toEqual({ hosts: [], ports: [], failures: [], unattributed_status: [] });
  });

  describe('its description', () => {
    // The load-bearing readings, pinned so a later edit cannot quietly drop
    // them: each is a claim the normalization actually delivers and a caller
    // acts on differently for having read it.
    it('says which WWPN is which controller and what a null second one means', () => {
      expect(fcList.description).toContain('UNDERSTOOD TO BE THE TWO ');
      expect(fcList.description).toContain('`ha_status`');
    });

    // The reading is the ticket's and not the API's, and saying so is what
    // keeps it from being a description promising more than the read delivers.
    it('says the HA reading of the _b fields is not stated by the API', () => {
      expect(fcList.description).toContain('THAT READING IS NOT STATED BY THE API');
    });

    it('says the status field names are unconfirmed', () => {
      expect(fcList.description).toContain('THE FIELD NAMES IN A STATUS ROW ARE UNCONFIRMED');
    });

    it('says an empty status and a null one are different answers', () => {
      expect(fcList.description).toContain(
        'AN EMPTY `status` AND A NULL ONE ARE DIFFERENT ANSWERS',
      );
    });

    // One null, two causes, and only one of them is in `failures`.
    it('enumerates both causes of a null status rather than only the failed read', () => {
      expect(fcList.description).toContain(
        'NULL HAS TWO CAUSES AND ONLY ONE OF THEM IS A FAILED READ',
      );
    });

    // A not-established list is not a status enum: say what it rules out and
    // name what cannot be told apart, rather than offering a partition the
    // shapes do not support.
    it('does not partition a full unattributed_status', () => {
      expect(fcList.description).toContain('IT IS NOT A PARTITION BEYOND THAT');
      expect(fcList.description).toContain('NOTHING HERE SEPARATES THOSE TWO');
    });

    it('refuses to relate an adapter to a port', () => {
      expect(fcList.description).toContain('THIS TOOL DOES NOT RELATE AN ADAPTER TO A PORT');
    });

    it('refuses to answer whether the system has FC at all', () => {
      expect(fcList.description).toContain('THERE IS NO `supported` FIELD');
    });

    it('says it reports no sessions', () => {
      expect(fcList.description).toContain('CONFIGURATION AND LINK STATE AND NOT SESSIONS');
    });
  });
});
