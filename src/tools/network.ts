import { firstValueFrom } from 'rxjs';
import { Role } from '@/interfaces';
import { ReadOnlyTool } from '@/catalog/tool';

/**
 * Networking family. Two tools split it by what is being asked about:
 * `network_interfaces` answers for the interfaces themselves, and
 * `network_config` at the foot of this file answers for the system-wide
 * settings over them — hostname, DNS servers, default gateways and static
 * routes. The guards between them are shared; each tool's own reasoning sits
 * with it.
 *
 * `network_interfaces`: what interfaces this system has, whether each one has
 * a link, and how the VLANs, bridges and link aggregations over them are
 * built.
 *
 * `interface.query` answers all of it in one call — physical interfaces, VLANs,
 * bridges and LAGGs are rows of the same listing, distinguished by `type` — so
 * the two things the catalog wants here (interface state, and the VLANs and
 * bridges above it) are one tool rather than two reads of the same rows.
 *
 * The pinned client types the query response as `Record<string, unknown>`
 * (`InterfaceEntry` is a bare record), so every field is read rather than
 * trusted, the way `storage.ts` reads a ZFS property. The field NAMES below come
 * from the client's own `InterfaceEntryInput` and `InterfaceEntryState`
 * declarations, which describe this same record on the create and event sides;
 * they are strong evidence and not a guarantee about the query response, and a
 * name that turns out wrong costs a null rather than a wrong value.
 *
 * The mapping is an allowlist rather than a trim, as in `pools.ts`. A raw
 * interface row carries the whole `state` sub-object — supported media lists,
 * capability flags, ND6 flags, queue counts, permanent and hardware link
 * addresses — beside the failover configuration and both alias lists, on every
 * interface in the system. Only the fields named here survive, so a field a
 * later TrueNAS release adds to the record cannot reach a caller without a
 * change to this file.
 */

/**
 * One string field of a row, or null where the system reported no value.
 *
 * An empty string is read as no value rather than as text of no characters: a
 * media subtype the system has nothing to say about arrives as `""`, and
 * passing it through would put a field in the result that says nothing.
 *
 * `accounts.ts`, `shares.ts`, `tasks.ts` and `block.ts` each hold this same
 * reading under their own names, and it is restated here for the reason those
 * files give for restating their own guards: a tool file is read on its own.
 */
function textOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** A number the system reported, or null where it reported anything else. */
function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * A nested object of a row, or null where the row held anything else.
 *
 * Every sub-object of an interface arrives as `unknown`, and `typeof null` is
 * `'object'`, so the null check is what stops a reported-as-null `state` being
 * indexed. An array is an object too and is excluded here: `state` and a port
 * entry are records, and reading a list as one would answer null for every
 * field rather than saying the shape was not what this tool reads.
 */
function recordOrNull(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/** The entries of a list field, or an empty list where the field was not one. */
function listOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/**
 * The negotiated link speed in megabits per second, read out of the media
 * subtype the system reports, or null where no speed can be read from it.
 *
 * There is no numeric speed field on an interface row. The middleware reports
 * the negotiated media as text, and the spellings differ by platform and by
 * driver — `1000baseT <full-duplex>`, `10Gbase-SR`, `2.5GbaseT`, `1000Mb/s`,
 * `10Gb/s` — so the leading magnitude and its optional unit are what is read: a
 * bare number is megabits, which is the older convention every `NNNbase…` form
 * follows, and `G` multiplies by a thousand.
 *
 * (unconfirmed) against a live middleware, which is why the media text itself
 * is returned beside this rather than replaced by it. A subtype naming no speed
 * at all — `autoselect`, `Unknown`, an empty string, a form this does not read —
 * yields null, and null is therefore "no speed this tool could read from what
 * the system reported" rather than "no link". `link_state` is what says whether
 * there is a link, and the tool's description says so.
 */
function linkSpeedMbps(media: string | null): number | null {
  if (media === null) return null;
  // Anchored at the start: the magnitude of a media name is its leading token,
  // and a number later in the string is a lane or channel count (`10Gbase-SR4`)
  // rather than a speed. `b` after the magnitude is what distinguishes a media
  // name from any other leading number.
  const match = /^(\d+(?:\.\d+)?)\s*([gm])?b/i.exec(media);
  if (match === null) return null;
  const magnitude = Number(match[1]);
  // Rounded because a fractional-gigabit media (`2.5GbaseT`) is a whole number
  // of megabits.
  const mbps = Math.round(match[2]?.toLowerCase() === 'g' ? magnitude * 1000 : magnitude);
  // A speed of zero is no speed rather than a link running at none, and a
  // magnitude too large to be a number at all — the regex bounds the SHAPE of
  // the leading token and not its length — is not one either.
  return Number.isFinite(mbps) && mbps > 0 ? mbps : null;
}

/** One address currently on an interface, as this tool reports it. */
interface AddressRow {
  type: string | null;
  address: string | null;
  netmask: string | number | null;
}

/**
 * The addresses the interface currently carries, from the state rather than
 * from the configuration.
 *
 * The row holds both lists: `aliases` at the top level is what is configured,
 * and `state.aliases` is what is actually on the interface. The second is the
 * one reported, because an interface addressed by DHCP has an address there and
 * nothing at all in the configured list — and an interface whose configuration
 * has not been applied has the reverse. What the interface is answering on is
 * the question this tool is asked.
 *
 * Null where no address list was read at all — the system reported no state, or
 * no alias list within it — which is not the empty list of an interface that
 * was read and is carrying no address. `members` keeps the same two apart, for
 * the same reason: an interface whose addresses could not be read must not
 * report as one that has none.
 */
function addresses(state: Record<string, unknown> | null): AddressRow[] | null {
  const aliases = state?.['aliases'];
  if (!Array.isArray(aliases)) return null;
  return aliases.map((entry) => {
    const alias = recordOrNull(entry);
    const netmask = alias?.['netmask'];
    return {
      type: textOrNull(alias?.['type']),
      address: textOrNull(alias?.['address']),
      // The client types this `string | number` — a prefix length on some
      // platforms and a dotted mask on others — so both are passed through as
      // they arrive rather than converted into one of them. An empty string is
      // no value here for the same reason it is no value in `type` and
      // `address` beside it, rather than a mask of no characters.
      netmask:
        typeof netmask === 'number' && Number.isFinite(netmask) ? netmask : textOrNull(netmask),
    };
  });
}

/** One member of a bridge or link aggregation, as this tool reports it. */
interface MemberRow {
  name: string | null;
  link_state: string | null;
  flags: string[] | null;
}

/**
 * The names the row gives for the interfaces it aggregates, or null where it
 * named no member list at all.
 *
 * A bridge names them under `bridge_members` and a link aggregation under
 * `lag_ports`. Null is therefore "the system reported no member list", and
 * `type` is what says whether that means "does not aggregate anything" or "an
 * aggregate whose members could not be read".
 *
 * Both fields are read and joined rather than one being preferred to the
 * other, because (unconfirmed) which of two shapes the middleware sends: if it
 * sends an interface record whole, a LAGG carries an empty `bridge_members`
 * beside its populated `lag_ports`, and preferring the first field that is
 * present would report a live aggregation as having no members at all — the
 * one answer worse than no answer. That same uncertainty is why a physical or
 * VLAN interface may answer either null (neither field sent) or an empty list
 * (both sent and both empty) here, and why the tool's description states both
 * rather than promising one. Nothing is double-counted by joining them: an
 * interface is a bridge or an aggregation and never both, so at most one of
 * the two lists is ever populated.
 */
function memberNames(row: Record<string, unknown>): string[] | null {
  // The predicate is written out rather than left to inference: `Array.isArray`
  // narrows to `any[]`, which would make the joined list `any` and take the
  // member names below out of the type system's reach entirely.
  const named = [row['bridge_members'], row['lag_ports']].filter(
    (list): list is unknown[] => Array.isArray(list),
  );
  // Null only where NEITHER field is a list: an aggregate that named two empty
  // ones has no members, which is not the same as naming no list at all.
  if (named.length === 0) return null;
  return named.flat().flatMap((name) => {
    const text = textOrNull(name);
    return text === null ? [] : [text];
  });
}

/**
 * The per-member view the aggregate itself holds, keyed by member name.
 *
 * `state.ports` is what the bridge or LAGG says about each interface under it,
 * and its `flags` are the aggregate's own verdict on that port. That is a
 * different fact from the member's link: a LACP member can have a link and
 * still not be carrying traffic, which is exactly the degraded aggregation this
 * tool exists to make visible.
 */
function portFlags(state: Record<string, unknown> | null): Map<string, string[]> {
  const flags = new Map<string, string[]>();
  for (const entry of listOf(state?.['ports'])) {
    const port = recordOrNull(entry);
    const name = textOrNull(port?.['name']);
    if (name === null) continue;
    // Non-string entries are dropped rather than rendered, as `memberNames`
    // drops a member the system did not name: a flag is the word for a state,
    // and anything that is not one names no state.
    flags.set(name, listOf(port?.['flags']).filter((flag) => typeof flag === 'string'));
  }
  return flags;
}

/**
 * Each member of an aggregate, with the link state that member's OWN row
 * reports and the flags the aggregate holds for it.
 *
 * The link state is resolved against the same response rather than read off the
 * aggregate, because an interface under a bridge or a LAGG is itself a row of
 * `interface.query` and that row is where its link lives.
 *
 * Null covers both ways that can fail to produce a state — the response held no
 * row for the member, and the row it held reported no link state of its own —
 * because the two are the same fact to a caller: the member's link cannot be
 * stated. Neither is a member that is DOWN, which is the distinction that
 * matters, and the tool's description draws it that way rather than promising a
 * finer one this cannot keep.
 */
function members(
  row: Record<string, unknown>,
  state: Record<string, unknown> | null,
  linkStates: Map<string, string | null>,
): MemberRow[] | null {
  const named = memberNames(row);
  if (named === null) return null;
  const flags = portFlags(state);
  return named.map((name) => ({
    name,
    link_state: linkStates.get(name) ?? null,
    // Null where the aggregate reported no port entry for this member, which is
    // distinct from the empty list it reports for a port it holds no flags on.
    flags: flags.get(name) ?? null,
  }));
}

export const networkInterfaces: ReadOnlyTool = {
  name: 'network_interfaces',
  description:
    'Every network interface on the system, whether each one has a link, and ' +
    'how the VLANs, bridges and link aggregations over them are built. `name` ' +
    'is the interface as the system names it — `eno1`, `bond0`, `vlan10` — and ' +
    'is what every other field naming an interface refers to. `type` is ' +
    '`PHYSICAL` (a real port), `VLAN`, `BRIDGE`, `LINK_AGGREGATION` (a LAGG or ' +
    'bond), or `UNKNOWN`; it is null where the system reported none. ' +
    '`link_state` is whether the interface currently has a link: ' +
    '`LINK_STATE_UP` has one, `LINK_STATE_DOWN` does not, and null means the ' +
    'system reported no state, WHICH IS NOT THE SAME AS DOWN. `link_media` is ' +
    'the media the link negotiated, as text — the form varies by platform and ' +
    'driver, and it is where duplex appears when the system reports one — and ' +
    'is null where the system named no media. `link_speed_mbps` is the speed ' +
    'read out of that text, in megabits per second, so 1000 is a gigabit link ' +
    'and 10000 a ten-gigabit one. IT IS NULL WHENEVER NO SPEED COULD BE READ ' +
    'FROM THE MEDIA TEXT, which includes an interface reporting `autoselect` ' +
    'or nothing at all, and it IS NOT EVIDENCE OF A DOWN LINK — `link_state` ' +
    'is the only field that says that, and `link_media` is what the speed was ' +
    'read from, so a null speed beside media text is this tool failing to ' +
    'parse it rather than the system failing to report it. A link that ' +
    'renegotiated below the port it sits on is visible here and nowhere else. ' +
    '`mtu` is the MTU CURRENTLY IN EFFECT rather than the configured value, ' +
    'null where the system reported none. `addresses` are the addresses the ' +
    'interface is actually carrying, not the ones configured on it, so an ' +
    'interface addressed by DHCP lists them here; each has a `type` — `INET` ' +
    'for IPv4, `INET6` for IPv6, `LINK` for the hardware address — an ' +
    '`address`, and a `netmask` that is a prefix length or a dotted mask ' +
    'depending on the platform, passed through as the system sent it. An ' +
    'empty list is an interface carrying no address, and NULL IS AN INTERFACE ' +
    'WHOSE ADDRESSES COULD NOT BE READ — the system reported no state for it, ' +
    'or no address list within that state — WHICH IS NOT THE SAME THING. Any ' +
    'of the three fields within an entry ' +
    'is null where the system reported no value for it. `vlan_parent` and ' +
    '`vlan_tag` are the interface a VLAN sits on and the tag it carries, and ' +
    'ARE BOTH NULL ON EVERY INTERFACE THAT IS NOT A VLAN, which `type` is what ' +
    'identifies. `members` are the interfaces a bridge or a link aggregation ' +
    'is built from. ON A `PHYSICAL` OR `VLAN` INTERFACE IT IS EITHER NULL OR ' +
    'AN EMPTY LIST, depending on whether the system sent member fields at all ' +
    'for a row that aggregates nothing, and NEITHER IS A FAILURE: an interface ' +
    'of those types is built from no other interface, and the two readings ' +
    'carry no distinction there. ON A `BRIDGE` OR `LINK_AGGREGATION` THEY DO: ' +
    'an empty list means the aggregate currently has no members, and null ' +
    'means its member list could not be read — `type` is what says which of ' +
    'the two readings applies. Each member carries its ' +
    'own `name`, the `link_state` FROM THAT MEMBER\'S OWN ENTRY in this same ' +
    'result — null where no entry for it was returned OR where that entry ' +
    'reported no link state, so a null there is a member whose link CANNOT BE ' +
    'STATED and is never a member that is down — and `flags`, which ' +
    'is what the aggregate itself says about that port and is a DIFFERENT FACT ' +
    'from the link: a member can have a link and still not be carrying ' +
    'traffic, which is what a degraded LAGG looks like. `flags` is null where ' +
    'the aggregate reported no entry for that member, and an empty list where ' +
    'it reported one with no flags. So a single failed port inside an ' +
    'otherwise-up bond is found by reading the members of a ' +
    '`LINK_AGGREGATION` whose own `link_state` is `LINK_STATE_UP`. This tool ' +
    'reports interfaces as they are; it does not create, change or delete an ' +
    'interface, VLAN, bridge or aggregation, and it does not report the ' +
    "system's hostname, gateway, DNS servers or routes. NO field beyond those " +
    'named here is returned, whatever else a later TrueNAS release adds to an ' +
    'interface record.',
  inputSchema: { type: 'object', properties: {} },
  requiredRole: Role.ReadOnly,
  mutating: false,
  async handler({ system }) {
    // No filters and no options: an interface listing is small — one row per
    // port, VLAN, bridge and aggregation — and every row is needed anyway,
    // because a member's link state is resolved against the rest of the
    // response.
    const interfaces = await firstValueFrom(system.client.api.query('interface.query'));

    // Built before the rows are mapped, so that a member named by an aggregate
    // resolves whether its own row comes before or after the aggregate's.
    const linkStates = new Map<string, string | null>();
    for (const row of interfaces) {
      const name = textOrNull(row['name']);
      if (name === null) continue;
      linkStates.set(name, textOrNull(recordOrNull(row['state'])?.['link_state']));
    }

    return interfaces.map((row) => {
      const state = recordOrNull(row['state']);
      const media = textOrNull(state?.['active_media_subtype']);
      const type = textOrNull(row['type']);
      return {
        name: textOrNull(row['name']),
        type,
        link_state: textOrNull(state?.['link_state']),
        link_media: media,
        link_speed_mbps: linkSpeedMbps(media),
        // From the state rather than the top-level `mtu`, which is the
        // configured value and is null on an interface left at the default —
        // an interface running at 1500 must not report as one with no MTU.
        mtu: numberOrNull(state?.['mtu']),
        addresses: addresses(state),
        // Read off the row rather than the state: the state spells them
        // `parent` and `tag`, and the row's own names are the ones the client
        // types. Null on anything that is not a VLAN, which is where the
        // fields are simply absent.
        vlan_parent: textOrNull(row['vlan_parent_interface']),
        vlan_tag: numberOrNull(row['vlan_tag']),
        // Looked for on every row rather than only on the two aggregating
        // types, so that an aggregate the system gave an unexpected `type`
        // still reports what it is built from — and so that the field means
        // "the system named a member list" throughout, which is what the
        // description says a null `members` is.
        members: members(row, state, linkStates),
      };
    });
  },
};

/**
 * The settings over the interfaces: hostname, DNS, gateways and static routes.
 *
 * Three reads, and only the first is the answer. `network.configuration.config`
 * holds what is CONFIGURED on this system; `network.general.summary` holds the
 * default routes and nameservers actually IN EFFECT; `staticroute.query` holds
 * the routes configured by hand. The first two are the same facts read from two
 * sides, and the difference between them is the question this tool exists to
 * answer: a system addressed by DHCP has a gateway and nameservers in effect
 * and nothing configured, and a system whose configuration has not been applied
 * has the reverse.
 *
 * That comparison is what distinguishes an inherited value from a configured
 * one, rather than a field on the configuration saying so. The client types the
 * configuration response as a bare `Record<string, unknown>` — nothing about it
 * is guaranteed by the types — while `NetworkGeneralSummaryResult` IS typed,
 * with `default_routes` and `nameservers` on it. So the effective side is the
 * grounded half and the configured side is read defensively, field by field,
 * the way an interface row is read above. The configured field NAMES come from
 * the client's own `NetWorkConfigurationUpdate`, which describes this same
 * record on the update side: strong evidence rather than a guarantee, and a
 * name that turns out wrong costs a null rather than a wrong value.
 *
 * Only the configuration read can fail the tool. A system whose configuration
 * read and whose routes did not still has most of an answer, and `failures` is
 * what stops the missing part reading as "none configured".
 */

/** One read that did not complete, and why. */
interface ConfigFailure {
  source: 'effective_values' | 'static_routes';
  error: string;
}

/** What a failure carrying no text of its own is reported as. */
const NO_REASON = 'the system reported no reason';

/**
 * Why a read failed, in words.
 *
 * A rejection is not necessarily an `Error` — the client rejects with whatever
 * the transport gave it — so a bare string is read too, and so are the two
 * shapes the client documents as its own: a JSON-RPC error object carrying
 * `message`, and a middleware error object carrying `reason`. `block.ts` and
 * `shares.ts` each hold this same reading under their own names, and it is
 * restated here for the reason those files give: a tool file is read on its
 * own. The result is never empty, because a failure with no text still has to
 * read as a failure.
 */
function errorText(reason: unknown): string {
  if (reason instanceof Error) return textOrNull(reason.message) ?? NO_REASON;
  if (typeof reason === 'object' && reason !== null) {
    const carrier = reason as Record<string, unknown>;
    return textOrNull(carrier['reason']) ?? textOrNull(carrier['message']) ?? NO_REASON;
  }
  return textOrNull(reason) ?? NO_REASON;
}

/** A read that produced a value, or the failure that stopped it. */
interface Attempt<T> {
  value: T | null;
  failure: ConfigFailure | null;
}

/**
 * One supplementary read, with a failure caught and named rather than thrown.
 *
 * The read is passed as a thunk so that the call is made inside the `try`,
 * which keeps this correct for a read that throws before it returns a promise
 * at all.
 */
async function attempt<T>(
  source: ConfigFailure['source'],
  read: () => Promise<T>,
): Promise<Attempt<T>> {
  try {
    return { value: await read(), failure: null };
  } catch (reason) {
    return { value: null, failure: { source, error: errorText(reason) } };
  }
}

/**
 * The non-empty strings of a list field, or null where the field was not a list
 * at all.
 *
 * The two are kept apart everywhere this is used: a system that reported an
 * empty search-domain list has none, and one that reported no list said
 * nothing. An entry that is not a string, or is the empty string the middleware
 * sends for "no value", names nothing and is dropped — the same reading
 * `textOrNull` holds above.
 */
function textList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.flatMap((entry) => {
    const text = textOrNull(entry);
    return text === null ? [] : [text];
  });
}

/** Where a value in effect came from, as far as this tool can tell. */
type ValueSource = 'STATIC' | 'AUTOMATIC';

/** What the system reports as being in effect, as far as it could be read. */
interface EffectiveValues {
  default_routes: string[] | null;
  nameservers: string[] | null;
}

/**
 * The effective side, read from the summary, with null throughout where it
 * could not be read.
 *
 * Null rather than an empty list, because every attribution below turns on the
 * difference: an empty effective list means the system is using no nameserver,
 * and a null one means nothing can be said about what it is using. Reading the
 * second as the first would report every configured server as not in use.
 */
function effectiveValues(summary: unknown): EffectiveValues {
  const record = recordOrNull(summary);
  return {
    default_routes: textList(record?.['default_routes']),
    nameservers: textList(record?.['nameservers']),
  };
}

/** A default gateway of one address family, from both sides. */
interface GatewayReport {
  configured: string | null;
  in_effect: string | null;
  source: ValueSource | null;
}

/**
 * The default gateway of one family: what is configured, what is in effect, and
 * which of the two the effective value came from.
 *
 * The summary reports default routes as one list of addresses, without saying
 * which family each belongs to, so they are split on the colon: an IPv6 address
 * always contains one and an IPv4 address never does. The first match wins —
 * a system with two default routes of one family has an equal-cost pair, and
 * either is the gateway of that family.
 *
 * `source` is `STATIC` whenever a gateway is configured here, whether or not it
 * is the one in effect; the two fields beside it are what show a configuration
 * that has not been applied. It is `AUTOMATIC` only where a gateway is in
 * effect and none is configured, which is DHCP on IPv4 and DHCPv6 or a router
 * advertisement on IPv6 — this tool cannot tell those apart, so it does not
 * name one.
 */
function gatewayReport(
  configured: string | null,
  routes: string[] | null,
  ipv6: boolean,
): GatewayReport {
  const inEffect = routes?.find((route) => route.includes(':') === ipv6) ?? null;
  return {
    configured,
    in_effect: inEffect,
    source: configured !== null ? 'STATIC' : inEffect !== null ? 'AUTOMATIC' : null,
  };
}

/** One DNS server, and what this tool can say about where it came from. */
interface NameserverReport {
  address: string;
  source: ValueSource;
  in_effect: boolean | null;
}

/**
 * Every DNS server this system is using or has been given, from both sides.
 *
 * The servers in effect come first, in the order the system reports them —
 * resolution is tried in that order, so it is a fact rather than a
 * presentation — and any configured server that is not among them follows.
 *
 * `STATIC` is decided by the configured side alone, so it is stated the same
 * way whether or not the effective list could be read. `in_effect` is the field
 * that goes null there: a configured server whose use cannot be confirmed must
 * not report as one that is definitely unused.
 */
function nameserverReports(
  config: Record<string, unknown>,
  effective: string[] | null,
): NameserverReport[] {
  // Three numbered fields rather than a list: that is the shape the middleware
  // holds them in, and a server configured in the third slot with the second
  // left empty is ordinary.
  const configured = ['nameserver1', 'nameserver2', 'nameserver3'].flatMap((key) => {
    const address = textOrNull(config[key]);
    return address === null ? [] : [address];
  });
  const isConfigured = new Set(configured);
  const seen = new Set<string>();
  const rows: NameserverReport[] = [];
  for (const address of effective ?? []) {
    if (seen.has(address)) continue;
    seen.add(address);
    rows.push({
      address,
      source: isConfigured.has(address) ? 'STATIC' : 'AUTOMATIC',
      in_effect: true,
    });
  }
  for (const address of configured) {
    if (seen.has(address)) continue;
    seen.add(address);
    // False only where the effective list was actually read and this address
    // was not in it.
    rows.push({ address, source: 'STATIC', in_effect: effective === null ? null : false });
  }
  return rows;
}

/** One route configured by hand on this system. */
interface StaticRouteRow {
  destination: string | null;
  gateway: string | null;
}

/**
 * The static routes, or null where the listing could not be read.
 *
 * Null covers the read that failed and the response that was not a list, which
 * are the same fact to a caller: the static routes cannot be stated. Neither is
 * the empty list of a system that has none, and `failures` is what names the
 * first of the two.
 */
function staticRouteRows(routes: unknown): StaticRouteRow[] | null {
  if (!Array.isArray(routes)) return null;
  return routes.map((entry) => {
    const route = recordOrNull(entry);
    return {
      destination: textOrNull(route?.['destination']),
      gateway: textOrNull(route?.['gateway']),
    };
  });
}

export const networkConfig: ReadOnlyTool = {
  name: 'network_config',
  description:
    "This system's network settings: hostname, DNS servers, default gateways " +
    'and the routes configured by hand. These are the settings OVER the ' +
    'interfaces; `network_interfaces` is what reports the interfaces ' +
    'themselves, their links and their addresses, and neither tool reports ' +
    'the other. Wherever the system can say both, a value is reported from ' +
    'BOTH SIDES: what is CONFIGURED on this system, and what is IN EFFECT ' +
    'right now. The two differ in both directions — a system addressed by ' +
    'DHCP has a gateway and nameservers in effect with nothing configured, ' +
    'and a system whose configuration has not been applied has a configured ' +
    'value that nothing is using. `source` is what states which: `STATIC` ' +
    'means the value IS CONFIGURED HERE, and `AUTOMATIC` means it is in ' +
    'effect WITHOUT being configured here — DHCP on IPv4, and DHCPv6 or a ' +
    'router advertisement on IPv6, WHICH THIS TOOL CANNOT TELL APART and so ' +
    'does not name. `hostname` and `domain` are the configured hostname and ' +
    'DNS domain of this system, each null where it reported none; the ' +
    'hostnames of an HA peer and of an HA virtual address are not reported ' +
    'here. `search_domains` are the additional domains appended when a bare ' +
    'name is resolved: an empty list is a system with none, and NULL IS A ' +
    'SYSTEM THAT REPORTED NO LIST AT ALL. `ipv4_gateway` and `ipv6_gateway` ' +
    'each carry `configured`, the gateway set on this system and null where ' +
    'none is; `in_effect`, the default route of that family the system ' +
    'reports as currently in use and null where there is none; and `source`. ' +
    'A `source` of null means neither a configured gateway nor one in effect ' +
    'was found for that family. `nameservers` lists every DNS server this ' +
    'system is using or has been given, THOSE IN USE FIRST AND IN THE ORDER ' +
    'THE SYSTEM TRIES THEM, followed by any configured server that is not in ' +
    'use. Each carries its `address`, its `source`, and `in_effect`: true ' +
    'where the system is actually using it, false where it is configured and ' +
    'NOT in use, and NULL WHERE THE EFFECTIVE LIST COULD NOT BE READ — a null ' +
    'is never "not in use". An empty list is a system with no DNS server ' +
    'configured and none in effect. `static_routes` are the routes configured ' +
    'by hand, each with its `destination` and `gateway`; the interface and ' +
    'default routes the kernel derives on its own ARE NOT ROUTES CONFIGURED ' +
    'BY HAND and are not listed here, so an empty list means no static route ' +
    'is configured rather than that the system has no routes. NULL IS A ' +
    'LISTING THAT COULD NOT BE READ. `failures` names each read that did not ' +
    'complete, with the reason the system gave; it is empty where every read ' +
    'completed, and A FIELD IT NAMES AS UNREADABLE MUST NOT BE READ AS ' +
    'ABSENT — when it names `effective_values`, every `in_effect` is null and ' +
    'no value can be reported as `AUTOMATIC`, so a `STATIC` gateway or ' +
    'nameserver is still correct there while the absence of one is not ' +
    'evidence of anything. This tool reports settings as they are: it does ' +
    'not change any network setting, and IT DOES NOT TEST whether a name ' +
    'resolves, a gateway answers or a host is reachable — a nameserver ' +
    'reported here is one the system is configured to use, not one confirmed ' +
    'to be working. NO field beyond those named here is returned, whatever ' +
    'else a later TrueNAS release adds to the network configuration.',
  inputSchema: { type: 'object', properties: {} },
  requiredRole: Role.ReadOnly,
  mutating: false,
  async handler({ system }) {
    // Every read is issued before any is awaited, so none waits on another.
    // Only the configuration is allowed to fail the tool: it is the answer,
    // and the other two sharpen it.
    const [config, summary, routes] = await Promise.all([
      firstValueFrom(system.client.api.call('network.configuration.config')),
      attempt('effective_values', () =>
        firstValueFrom(system.client.api.call('network.general.summary')),
      ),
      attempt('static_routes', () => firstValueFrom(system.client.api.query('staticroute.query'))),
    ]);

    const effective = effectiveValues(summary.value);
    const failures: ConfigFailure[] = [];
    if (summary.failure !== null) failures.push(summary.failure);
    if (routes.failure !== null) failures.push(routes.failure);

    return {
      hostname: textOrNull(config['hostname']),
      domain: textOrNull(config['domain']),
      search_domains: textList(config['domains']),
      ipv4_gateway: gatewayReport(textOrNull(config['ipv4gateway']), effective.default_routes, false),
      ipv6_gateway: gatewayReport(textOrNull(config['ipv6gateway']), effective.default_routes, true),
      nameservers: nameserverReports(config, effective.nameservers),
      static_routes: staticRouteRows(routes.value),
      failures,
    };
  },
};
