import { describe, expect, it } from 'vitest';
import { fakeSystem, failingSystem } from '@/testing/fake-systems';
import { networkConfig, networkInterfaces } from '@/tools/index';

describe('network_interfaces', () => {
  /**
   * One row of `interface.query`. The nested `state` is spread over the default
   * rather than replaced, so a test naming one state field keeps the rest —
   * every field of the response is read out of that sub-object, and a fixture
   * that dropped it wholesale would test the absent-state path by accident.
   */
  const iface = (
    over: Record<string, unknown> = {},
    state: Record<string, unknown> | null = {},
  ) => ({
    id: 'eno1',
    name: 'eno1',
    fake: false,
    type: 'PHYSICAL',
    aliases: [],
    ipv4_dhcp: false,
    ipv6_auto: false,
    // The configured MTU, null on an interface left at the default. The
    // operational one lives in the state, and telling them apart is what the
    // fixture's two different numbers are for.
    mtu: null,
    state:
      state === null
        ? null
        : {
            name: 'eno1',
            orig_name: 'eno1',
            mtu: 1500,
            cloned: false,
            flags: ['UP', 'BROADCAST', 'RUNNING'],
            link_state: 'LINK_STATE_UP',
            media_type: 'Ethernet',
            media_subtype: 'autoselect',
            active_media_type: 'Ethernet',
            active_media_subtype: '1000baseT <full-duplex>',
            link_address: '00:11:22:33:44:55',
            permanent_link_address: '00:11:22:33:44:55',
            hardware_link_address: '00:11:22:33:44:55',
            aliases: [{ type: 'INET', address: '192.168.1.10', netmask: 24 }],
            ...state,
          },
    ...over,
  });

  const reported = async (rows: unknown[]): Promise<Record<string, unknown>[]> => {
    const { ctx } = fakeSystem({ ['interface.query']: rows });
    return (await networkInterfaces.handler(ctx, {})) as Record<string, unknown>[];
  };

  const one = async (over: Record<string, unknown> = {}, state: Record<string, unknown> | null = {}) =>
    (await reported([iface(over, state)]))[0] as Record<string, unknown>;

  it('reports the name, type, link, speed, MTU and addresses of an interface', async () => {
    expect(await one()).toEqual({
      name: 'eno1',
      type: 'PHYSICAL',
      link_state: 'LINK_STATE_UP',
      link_media: '1000baseT <full-duplex>',
      link_speed_mbps: 1000,
      mtu: 1500,
      addresses: [{ type: 'INET', address: '192.168.1.10', netmask: 24 }],
      vlan_parent: null,
      vlan_tag: null,
      members: null,
    });
  });

  it('returns no field the tool does not name, on the row or in the state', async () => {
    const result = await one(
      { future_field: 'added by a later release' },
      {
        future_state_field: 'added by a later release',
        // The state's three own link-address fields, all given one value that
        // nothing else in this fixture carries. A LINK-type alias holds a
        // hardware address too and IS returned, as the description says, so it
        // is given a different one: what must not appear below is the address
        // only the dropped fields carry, which a shared value could not show.
        link_address: 'aa:bb:cc:dd:ee:ff',
        permanent_link_address: 'aa:bb:cc:dd:ee:ff',
        hardware_link_address: 'aa:bb:cc:dd:ee:ff',
        aliases: [{ type: 'LINK', address: '00:11:22:33:44:55', netmask: null }],
      },
    );
    expect(Object.keys(result)).toEqual([
      'name',
      'type',
      'link_state',
      'link_media',
      'link_speed_mbps',
      'mtu',
      'addresses',
      'vlan_parent',
      'vlan_tag',
      'members',
    ]);
    // Against the whole serialized row rather than its top-level keys: a field
    // that reached a nested address or member entry would pass a key check and
    // still be in front of the caller. The hardware address is in the fixture's
    // state and is not a field this tool names.
    const serialized = JSON.stringify(result);
    for (const dropped of ['added by a later release', 'aa:bb:cc:dd:ee:ff', 'BROADCAST']) {
      expect(serialized).not.toContain(dropped);
    }
    // And the alias that legitimately carries a hardware address survives, so
    // the assertion above is about the fields this tool drops rather than about
    // the fixture happening to hold no LINK alias.
    expect(serialized).toContain('00:11:22:33:44:55');
  });

  it('reads the negotiated speed out of every media spelling it can', async () => {
    const speeds = await Promise.all(
      [
        '1000baseT <full-duplex>',
        '100baseTX',
        '10Gbase-SR4',
        '2.5GbaseT',
        '1000Mb/s',
        '10Gb/s',
        '40GBASE-LR4',
      ].map(async (active_media_subtype) =>
        (await one({}, { active_media_subtype }))['link_speed_mbps'],
      ),
    );
    expect(speeds).toEqual([1000, 100, 10000, 2500, 1000, 10000, 40000]);
  });

  it('reports no speed, and keeps the media text, where no speed can be read', async () => {
    // Each of these is a media name the system genuinely sends and this tool
    // cannot read a magnitude from. The text survives so that a caller can see
    // what the null was read from.
    for (const active_media_subtype of ['autoselect', 'Unknown', 'baseT', '0baseT']) {
      expect(await one({}, { active_media_subtype })).toMatchObject({
        link_media: active_media_subtype,
        link_speed_mbps: null,
      });
    }
  });

  it('reports no speed where the magnitude is too large to be a number', async () => {
    // The regex bounds the shape of the leading token and not its length, so a
    // long enough run of digits overflows to Infinity — which is not a speed,
    // and must not be reported as one.
    expect(await one({}, { active_media_subtype: `${'9'.repeat(400)}baseT` })).toMatchObject({
      link_media: expect.stringContaining('9'),
      link_speed_mbps: null,
    });
  });

  it('reports a null link state and no media where the system named neither', async () => {
    // Null rather than down: an interface whose link the system did not report
    // must not read as one that is definitely without a link.
    expect(await one({}, { link_state: null, active_media_subtype: '' })).toMatchObject({
      link_state: null,
      link_media: null,
      link_speed_mbps: null,
    });
  });

  it('reports the operational MTU rather than the configured one', async () => {
    // The row's own `mtu` is null — the fixture's default, an interface left at
    // the system default — and the state's is 9000. An interface running at a
    // jumbo MTU must not report as one with no MTU.
    expect(await one({ mtu: null }, { mtu: 9000 })).toMatchObject({ mtu: 9000 });
  });

  it('reports the VLAN parent and tag, and null for both on anything else', async () => {
    expect(
      await one({ name: 'vlan10', type: 'VLAN', vlan_parent_interface: 'eno1', vlan_tag: 10 }),
    ).toMatchObject({ type: 'VLAN', vlan_parent: 'eno1', vlan_tag: 10 });
    expect(await one()).toMatchObject({ vlan_parent: null, vlan_tag: null });
  });

  it('reports every address the interface carries, whatever the netmask is', async () => {
    expect(
      await one(
        {},
        {
          aliases: [
            { type: 'INET', address: '192.168.1.10', netmask: 24 },
            { type: 'INET', address: '10.0.0.5', netmask: '255.255.255.0' },
            { type: 'INET6', address: 'fe80::1', netmask: 64 },
          ],
        },
      ),
    ).toMatchObject({
      addresses: [
        { type: 'INET', address: '192.168.1.10', netmask: 24 },
        { type: 'INET', address: '10.0.0.5', netmask: '255.255.255.0' },
        { type: 'INET6', address: 'fe80::1', netmask: 64 },
      ],
    });
  });

  it('reports an address field the system sent nothing readable for as null', async () => {
    expect(
      await one(
        {},
        {
          aliases: [
            { type: '', address: null, netmask: { nested: true } },
            // An empty netmask is no value, exactly as it is in the two fields
            // beside it, rather than a mask of no characters.
            { type: 'INET', address: '10.0.0.5', netmask: '' },
            'not one',
          ],
        },
      ),
    ).toMatchObject({
      addresses: [
        { type: null, address: null, netmask: null },
        { type: 'INET', address: '10.0.0.5', netmask: null },
        { type: null, address: null, netmask: null },
      ],
    });
  });

  it('tells an interface carrying no address apart from one whose addresses could not be read', async () => {
    // The empty list is a state that was read and holds no address; null is a
    // state that named no address list at all. Reporting the second as the
    // first would claim an interface has no address on no evidence.
    expect(await one({}, { aliases: [] })).toMatchObject({ addresses: [] });
    expect(await one({ state: { link_state: 'LINK_STATE_UP' } })).toMatchObject({
      addresses: null,
    });
  });

  it('reports a member that is down inside an otherwise-up aggregation', async () => {
    // The acceptance criterion this tool exists for. The bond has a link, so
    // nothing at its own level says anything is wrong; the failed port is
    // visible only in `members`.
    const rows = await reported([
      iface({ name: 'eno1' }, { link_state: 'LINK_STATE_UP' }),
      iface({ name: 'eno2' }, { link_state: 'LINK_STATE_DOWN' }),
      iface(
        { name: 'bond0', type: 'LINK_AGGREGATION', lag_ports: ['eno1', 'eno2'] },
        {
          link_state: 'LINK_STATE_UP',
          ports: [
            { name: 'eno1', flags: ['ACTIVE'] },
            { name: 'eno2', flags: [] },
          ],
        },
      ),
    ]);
    expect(rows[2]).toMatchObject({
      name: 'bond0',
      link_state: 'LINK_STATE_UP',
      members: [
        { name: 'eno1', link_state: 'LINK_STATE_UP', flags: ['ACTIVE'] },
        { name: 'eno2', link_state: 'LINK_STATE_DOWN', flags: [] },
      ],
    });
  });

  it('reports the members of a bridge, resolved the same way', async () => {
    const rows = await reported([
      iface({ name: 'br0', type: 'BRIDGE', bridge_members: ['eno1'] }, { ports: [] }),
      iface({ name: 'eno1' }, { link_state: 'LINK_STATE_DOWN' }),
    ]);
    // Named before its member's own row appears, which is why the link states
    // are collected across the whole response before any row is mapped.
    expect(rows[0]).toMatchObject({
      members: [{ name: 'eno1', link_state: 'LINK_STATE_DOWN', flags: null }],
    });
  });

  it('reports a member the response holds no entry for as unresolved, not down', async () => {
    const rows = await reported([
      iface({ name: 'bond0', type: 'LINK_AGGREGATION', lag_ports: ['eno1', 'missing'] }, { ports: [] }),
    ]);
    expect(rows[0]).toMatchObject({
      members: [
        { name: 'eno1', link_state: null, flags: null },
        { name: 'missing', link_state: null, flags: null },
      ],
    });
  });

  it('reports the members of a LAGG that also carries an empty bridge member list', async () => {
    // The middleware sends an interface record whole, so an aggregation can
    // carry both fields with only one of them populated. Preferring whichever
    // is present first would report this live bond as having no members.
    const rows = await reported([
      iface({ name: 'eno1' }, { link_state: 'LINK_STATE_UP' }),
      iface(
        {
          name: 'bond0',
          type: 'LINK_AGGREGATION',
          bridge_members: [],
          lag_ports: ['eno1'],
        },
        { ports: [{ name: 'eno1', flags: ['ACTIVE'] }] },
      ),
    ]);
    expect(rows[1]).toMatchObject({
      members: [{ name: 'eno1', link_state: 'LINK_STATE_UP', flags: ['ACTIVE'] }],
    });
  });

  it('reports an aggregate carrying two empty member lists as having no members', async () => {
    // Both fields are lists, so a member list WAS named — twice, and empty
    // both times. That is an aggregate with nothing under it, not one whose
    // members could not be read.
    expect(
      await one({ type: 'BRIDGE', bridge_members: [], lag_ports: [] }),
    ).toMatchObject({ members: [] });
  });

  it('reports a member whose own entry named no link state as unstatable, not down', async () => {
    const rows = await reported([
      iface({ name: 'eno1' }, { link_state: null }),
      iface({ name: 'bond0', type: 'LINK_AGGREGATION', lag_ports: ['eno1'] }, { ports: [] }),
    ]);
    // The same null an unresolved member gets: both are a link this tool
    // cannot state, and neither is a link that is down.
    expect(rows[1]).toMatchObject({ members: [{ name: 'eno1', link_state: null }] });
  });

  it('tells an aggregate with no members apart from one that named no list', async () => {
    const [empty, none] = await reported([
      iface({ name: 'br0', type: 'BRIDGE', bridge_members: [] }),
      // A bridge whose member list the system did not report at all: an empty
      // list would claim it is built from nothing, which is a different fact.
      iface({ name: 'br1', type: 'BRIDGE' }),
    ]);
    expect(empty).toMatchObject({ type: 'BRIDGE', members: [] });
    expect(none).toMatchObject({ type: 'BRIDGE', members: null });
  });

  it('drops a member entry and a flag the system did not name', async () => {
    const rows = await reported([
      iface(
        { name: 'bond0', type: 'LINK_AGGREGATION', lag_ports: ['eno1', 7, null] },
        { ports: [{ name: 'eno1', flags: ['ACTIVE', 4] }, { name: '' }, 'not a port'] },
      ),
    ]);
    expect(rows[0]).toMatchObject({ members: [{ name: 'eno1', flags: ['ACTIVE'] }] });
  });

  it('reports a member list the system sent as something other than a list as absent', async () => {
    expect(await one({ type: 'BRIDGE', bridge_members: 'eno1' })).toMatchObject({ members: null });
  });

  it('reports every state-derived field as absent where there is no state', async () => {
    // Null rather than fatal: the row still names the interface, its type and
    // its VLAN configuration, and losing all of that to answer none of the
    // question is the trade this refuses.
    expect(await one({ name: 'eno9', type: 'PHYSICAL' }, null)).toEqual({
      name: 'eno9',
      type: 'PHYSICAL',
      link_state: null,
      link_media: null,
      link_speed_mbps: null,
      mtu: null,
      addresses: null,
      vlan_parent: null,
      vlan_tag: null,
      members: null,
    });
  });

  it('reads a state the system sent as a list as no state at all', async () => {
    // An array is an object too, so this is the case the null check alone does
    // not cover: read as a record it would answer null for every field without
    // saying the shape was not the one this tool reads.
    // Set through the row override rather than the state one, which is spread
    // over the default state and so cannot carry a value that is not a record.
    expect(await one({ state: [] })).toMatchObject({
      link_state: null,
      addresses: null,
      mtu: null,
    });
  });

  it('reports an interface the system did not name, and never resolves against it', async () => {
    const rows = await reported([
      iface({ name: null }, { link_state: 'LINK_STATE_DOWN' }),
      iface({ name: 'bond0', type: 'LINK_AGGREGATION', lag_ports: ['eno1'] }, { ports: [] }),
    ]);
    // Still reported — a nameless interface is one the caller can see exists —
    // and it contributes no entry to the map the members resolve against, so
    // its link state cannot be attributed to a member.
    expect(rows[0]).toMatchObject({ name: null, link_state: 'LINK_STATE_DOWN' });
    expect(rows[1]).toMatchObject({ members: [{ name: 'eno1', link_state: null }] });
  });

  it('reports a type the system did not name as null', async () => {
    expect(await one({ type: null })).toMatchObject({ type: null });
  });

  it('reports an empty listing as an empty result', async () => {
    expect(await reported([])).toEqual([]);
  });

  it('asks for the interfaces with no filter, so that members resolve', async () => {
    const { ctx, query } = fakeSystem({ ['interface.query']: [] });
    await networkInterfaces.handler(ctx, {});
    expect(query).toHaveBeenCalledWith('interface.query');
  });
});

describe('network_config', () => {
  /**
   * The configured side, as `network.configuration.config` sends it. The fields
   * this tool does not name are here on purpose — the middleware sends them on
   * every call, and the test that nothing beyond the named fields survives is
   * only worth anything against a fixture that carries some.
   */
  const CONFIG = {
    id: 1,
    hostname: 'nas',
    domain: 'example.com',
    domains: ['lab.example.com'],
    ipv4gateway: '192.168.1.1',
    ipv6gateway: '',
    nameserver1: '192.168.1.1',
    nameserver2: '',
    nameserver3: '',
    httpproxy: 'http://proxy.invalid:3128',
    hosts: ['10.0.0.9 buildbox'],
    service_announcement: { netbios: false, mdns: true, wsd: true },
  };

  /** The effective side, as `network.general.summary` sends it. */
  const SUMMARY = {
    ips: { eno1: { IPV4: ['192.168.1.10/24'] } },
    default_routes: ['192.168.1.1'],
    nameservers: ['192.168.1.1'],
  };

  const route = (over: Record<string, unknown> = {}) => ({
    id: 1,
    destination: '10.0.0.0/8',
    gateway: '192.168.1.254',
    ...over,
  });

  /**
   * The three reads, canned. `config` and `summary` are spread over their
   * defaults so a test naming one field keeps the rest; passing `null` for the
   * summary is how a test says the system answered with nothing this tool can
   * read, which is a different case from a summary missing one field.
   */
  const read = async (
    config: Record<string, unknown> = {},
    summary: Record<string, unknown> | null = {},
    routes: unknown = [route()],
  ): Promise<Record<string, unknown>> => {
    const { ctx } = fakeSystem({
      ['network.configuration.config']: { ...CONFIG, ...config },
      ['network.general.summary']: summary === null ? null : { ...SUMMARY, ...summary },
      ['staticroute.query']: routes,
    });
    return (await networkConfig.handler(ctx, {})) as Record<string, unknown>;
  };

  /** The same three reads, with the named ones rejecting instead. */
  const readFailing = async (
    failures: Partial<Record<string, unknown>>,
  ): Promise<Record<string, unknown>> => {
    const { ctx } = failingSystem(
      {
        ['network.configuration.config']: CONFIG,
        ['network.general.summary']: SUMMARY,
        ['staticroute.query']: [route()],
      },
      failures,
    );
    return (await networkConfig.handler(ctx, {})) as Record<string, unknown>;
  };

  it('reports the hostname, DNS, gateways and static routes from both sides', async () => {
    expect(await read()).toEqual({
      hostname: 'nas',
      domain: 'example.com',
      search_domains: ['lab.example.com'],
      ipv4_gateway: { configured: '192.168.1.1', in_effect: '192.168.1.1', source: 'STATIC' },
      // Nothing configured and no IPv6 default route in effect: the family is
      // absent rather than unreadable, which is what a null source says.
      ipv6_gateway: { configured: null, in_effect: null, source: null },
      nameservers: [{ address: '192.168.1.1', source: 'STATIC', in_effect: true }],
      static_routes: [{ destination: '10.0.0.0/8', gateway: '192.168.1.254' }],
      failures: [],
    });
  });

  it('reports the answering node of an HA pair, not the pair-wide `hostname`', async () => {
    // What node B of an HA pair sends: `hostname` stays node A's on both
    // nodes, and `hostname_local` is what the middleware resolves per node.
    // Reading `hostname` here would report the PEER under a field the
    // description defines as this system's.
    expect(
      await read({ hostname: 'nas-a', hostname_b: 'nas-b', hostname_local: 'nas-b' }),
    ).toMatchObject({ hostname: 'nas-b' });
  });

  it('falls back to `hostname` where the system reports no local one', async () => {
    // `hostname_local` is added by a read-side extend rather than stored, so a
    // response without it is not a system without a hostname. The empty string
    // is how the middleware sends "no value" and must fall back the same way.
    expect(await read({ hostname: 'nas', hostname_local: '' })).toMatchObject({ hostname: 'nas' });
    expect(await read({ hostname: 'nas' })).toMatchObject({ hostname: 'nas' });
  });

  it('reports neither the HA peer nor the HA virtual hostname', async () => {
    const result = await read({
      hostname: 'nas-a',
      hostname_b: 'nas-b',
      hostname_virtual: 'nas-ha',
      hostname_local: 'nas-a',
    });
    expect(result).toMatchObject({ hostname: 'nas-a' });
    // Against the serialized result, not the keys: either could only reach a
    // caller as a value under a field this tool does name.
    expect(JSON.stringify(result)).not.toContain('nas-b');
    expect(JSON.stringify(result)).not.toContain('nas-ha');
  });

  it('returns no field the tool does not name, from either side', async () => {
    const result = await read(
      { future_field: 'added by a later release' },
      { future_field: 'added by a later release' },
    );
    expect(Object.keys(result)).toEqual([
      'hostname',
      'domain',
      'search_domains',
      'ipv4_gateway',
      'ipv6_gateway',
      'nameservers',
      'static_routes',
      'failures',
    ]);
    // Against the whole serialized result rather than its top-level keys: a
    // field that reached a gateway, nameserver or route entry would pass a key
    // check and still be in front of the caller. The proxy, the hosts entries,
    // the service announcement and the row id are all fields the middleware
    // sends and this tool does not name.
    const serialized = JSON.stringify(result);
    for (const dropped of [
      'added by a later release',
      'proxy.invalid',
      'buildbox',
      'netbios',
      'IPV4',
    ]) {
      expect(serialized).not.toContain(dropped);
    }
  });

  it('reports a value in effect and not configured here as automatic', async () => {
    // The DHCP case: nothing set on this system, and a gateway and two
    // nameservers in use regardless.
    expect(
      await read(
        { ipv4gateway: '', nameserver1: '', nameserver2: '', nameserver3: '' },
        { default_routes: ['192.168.1.254'], nameservers: ['1.1.1.1', '8.8.8.8'] },
      ),
    ).toMatchObject({
      ipv4_gateway: { configured: null, in_effect: '192.168.1.254', source: 'AUTOMATIC' },
      // In the order the system reported them: resolution is tried in that
      // order, so it is a fact rather than a presentation.
      nameservers: [
        { address: '1.1.1.1', source: 'AUTOMATIC', in_effect: true },
        { address: '8.8.8.8', source: 'AUTOMATIC', in_effect: true },
      ],
    });
  });

  it('reports a configured value that nothing is using as static and not in effect', async () => {
    // A configuration that has not been applied: `source` is decided by the
    // configured side alone, and `in_effect` is what shows it is not the value
    // the system is actually using.
    expect(
      await read(
        { ipv4gateway: '192.168.1.1', nameserver1: '9.9.9.9' },
        { default_routes: ['10.0.0.1'], nameservers: ['1.1.1.1'] },
      ),
    ).toMatchObject({
      ipv4_gateway: { configured: '192.168.1.1', in_effect: '10.0.0.1', source: 'STATIC' },
      nameservers: [
        { address: '1.1.1.1', source: 'AUTOMATIC', in_effect: true },
        { address: '9.9.9.9', source: 'STATIC', in_effect: false },
      ],
    });
  });

  it('splits the default routes it is given by address family', async () => {
    // One list carrying both, which is how the summary reports them.
    expect(
      await read(
        { ipv4gateway: '', ipv6gateway: 'fe80::1' },
        { default_routes: ['192.168.1.254', 'fe80::1'] },
      ),
    ).toMatchObject({
      ipv4_gateway: { configured: null, in_effect: '192.168.1.254', source: 'AUTOMATIC' },
      ipv6_gateway: { configured: 'fe80::1', in_effect: 'fe80::1', source: 'STATIC' },
    });
  });

  it('reports an IPv6 gateway in effect and not configured here as automatic', async () => {
    // DHCPv6 or a router advertisement — the tool cannot tell those apart and
    // names neither.
    expect(await read({}, { default_routes: ['2001:db8::1'] })).toMatchObject({
      ipv6_gateway: { configured: null, in_effect: '2001:db8::1', source: 'AUTOMATIC' },
    });
  });

  it('cannot confirm a configured value where the effective side says nothing', async () => {
    // Null rather than false: a server whose use cannot be confirmed must not
    // report as one that is definitely unused, and a gateway that is configured
    // is still configured.
    expect(await read({ nameserver1: '9.9.9.9' }, null)).toMatchObject({
      ipv4_gateway: { configured: '192.168.1.1', in_effect: null, source: 'STATIC' },
      nameservers: [{ address: '9.9.9.9', source: 'STATIC', in_effect: null }],
    });
  });

  it('names an effective read that failed, and reports nothing as automatic', async () => {
    expect(await readFailing({ ['network.general.summary']: new Error('summary refused') })).toMatchObject(
      {
        ipv4_gateway: { configured: '192.168.1.1', in_effect: null, source: 'STATIC' },
        nameservers: [{ address: '192.168.1.1', source: 'STATIC', in_effect: null }],
        failures: [{ source: 'effective_values', error: 'summary refused' }],
      },
    );
  });

  it('names a static route read that failed, and reports the routes as unreadable', async () => {
    // Null rather than the empty list of a system with no static route: the two
    // readings are opposite and only one of them is true here.
    expect(await readFailing({ ['staticroute.query']: new Error('routes refused') })).toMatchObject({
      static_routes: null,
      failures: [{ source: 'static_routes', error: 'routes refused' }],
    });
  });

  it('reports both failures where both supplementary reads fail', async () => {
    const result = await readFailing({
      ['network.general.summary']: new Error('summary refused'),
      ['staticroute.query']: new Error('routes refused'),
    });
    expect(result['failures']).toEqual([
      { source: 'effective_values', error: 'summary refused' },
      { source: 'static_routes', error: 'routes refused' },
    ]);
    // And the configured side is still answered in full, which is the whole
    // point of not letting either failure take the tool down.
    expect(result).toMatchObject({ hostname: 'nas', domain: 'example.com' });
  });

  it('fails the tool where the configuration itself cannot be read', async () => {
    // The one read that is the answer rather than a sharpening of it.
    const { ctx } = failingSystem({}, { ['network.configuration.config']: new Error('denied') });
    await expect(networkConfig.handler(ctx, {})).rejects.toThrow('denied');
  });

  it('states a reason for a failure however the client rejected', async () => {
    // A rejection is not necessarily an Error: the client rejects with whatever
    // the transport gave it, and a middleware error carries `reason` where a
    // JSON-RPC one carries `message`.
    const reasons = await Promise.all(
      [
        new Error('an error'),
        { reason: 'a middleware error' },
        { message: 'a json-rpc error' },
        'a bare string',
        new Error(''),
        {},
        null,
      ].map(async (rejection) => {
        const result = await readFailing({ ['staticroute.query']: rejection });
        return (result['failures'] as { error: string }[])[0].error;
      }),
    );
    expect(reasons).toEqual([
      'an error',
      'a middleware error',
      'a json-rpc error',
      'a bare string',
      'the system reported no reason',
      'the system reported no reason',
      'the system reported no reason',
    ]);
  });

  it('reports no static route configured as an empty list', async () => {
    expect(await read({}, {}, [])).toMatchObject({ static_routes: [], failures: [] });
  });

  it('reports a route listing sent as something other than a list as unreadable', async () => {
    // The read completed, so there is no failure to name — it simply answered
    // nothing this tool can read, and null says exactly that.
    expect(await read({}, {}, 'not a listing')).toMatchObject({
      static_routes: null,
      failures: [],
    });
  });

  it('reports a route destination or gateway the system did not name as null', async () => {
    expect(
      await read({}, {}, [route({ destination: '', gateway: null }), 'not a route']),
    ).toMatchObject({
      static_routes: [
        { destination: null, gateway: null },
        { destination: null, gateway: null },
      ],
    });
  });

  it('keeps no search domains apart from no search domain list at all', async () => {
    expect(await read({ domains: [] })).toMatchObject({ search_domains: [] });
    expect(await read({ domains: 'lab.example.com' })).toMatchObject({ search_domains: null });
  });

  it('drops a search domain the system did not name', async () => {
    expect(await read({ domains: ['lab.example.com', '', 7, null] })).toMatchObject({
      search_domains: ['lab.example.com'],
    });
  });

  it('reports a nameserver the system named twice once', async () => {
    expect(
      await read({ nameserver1: '' }, { nameservers: ['1.1.1.1', '1.1.1.1'] }),
    ).toMatchObject({
      nameservers: [{ address: '1.1.1.1', source: 'AUTOMATIC', in_effect: true }],
    });
  });

  it('reports a system with no DNS server at all as having none', async () => {
    expect(
      await read({ nameserver1: '', nameserver2: '', nameserver3: '' }, { nameservers: [] }),
    ).toMatchObject({ nameservers: [] });
  });

  it('reads every numbered nameserver slot, whichever are filled', async () => {
    // A third slot filled with the second left empty is ordinary rather than a
    // malformed configuration.
    expect(
      await read(
        { nameserver1: '1.1.1.1', nameserver2: '', nameserver3: '9.9.9.9' },
        { nameservers: [] },
      ),
    ).toMatchObject({
      nameservers: [
        { address: '1.1.1.1', source: 'STATIC', in_effect: false },
        { address: '9.9.9.9', source: 'STATIC', in_effect: false },
      ],
    });
  });

  it('reports a hostname or domain the system did not name as null', async () => {
    expect(await read({ hostname: '', domain: null })).toMatchObject({
      hostname: null,
      domain: null,
    });
  });

  it('reports an effective list sent as something other than a list as unread', async () => {
    // The summary is a record and its two fields are not lists: nothing can be
    // said about what is in effect, which is not the same as nothing being in
    // effect.
    expect(
      await read({}, { default_routes: '192.168.1.1', nameservers: '192.168.1.1' }),
    ).toMatchObject({
      ipv4_gateway: { configured: '192.168.1.1', in_effect: null, source: 'STATIC' },
      nameservers: [{ address: '192.168.1.1', source: 'STATIC', in_effect: null }],
    });
  });

  it('asks for the configuration, the summary and the static routes', async () => {
    const { ctx, call, query } = fakeSystem({
      ['network.configuration.config']: CONFIG,
      ['network.general.summary']: SUMMARY,
      ['staticroute.query']: [],
    });
    await networkConfig.handler(ctx, {});
    expect(call).toHaveBeenCalledWith('network.configuration.config');
    expect(call).toHaveBeenCalledWith('network.general.summary');
    expect(query).toHaveBeenCalledWith('staticroute.query');
  });
});
