import { firstValueFrom } from 'rxjs';
import { Role } from '@/interfaces';
import { ReadOnlyTool } from '@/catalog/tool';

/**
 * Networking family: what interfaces this system has, whether each one has a
 * link, and how the VLANs, bridges and link aggregations over them are built.
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
 */
function addresses(state: Record<string, unknown> | null): AddressRow[] {
  return listOf(state?.['aliases']).map((entry) => {
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
 * `lag_ports`; a physical or VLAN interface holds neither, which is the
 * ordinary case rather than a fault. Null is therefore "the system reported no
 * member list", and `type` is what says whether that means "does not aggregate
 * anything" or "an aggregate whose members could not be read".
 *
 * Both fields are read and joined rather than one being preferred to the
 * other. The middleware sends an interface record whole, so a LAGG can carry an
 * empty `bridge_members` beside its populated `lag_ports` — and preferring the
 * first field that is present would then report a live aggregation as having no
 * members at all, which is the one answer worse than no answer. Nothing is
 * double-counted by joining them: an interface is a bridge or an aggregation
 * and never both, so at most one of the two lists is ever populated.
 */
function memberNames(row: Record<string, unknown>): string[] | null {
  const named = [row['bridge_members'], row['lag_ports']].filter((list) => Array.isArray(list));
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
    'empty list is an interface carrying no address; any of the three fields ' +
    'is null where the system reported no value for it. `vlan_parent` and ' +
    '`vlan_tag` are the interface a VLAN sits on and the tag it carries, and ' +
    'ARE BOTH NULL ON EVERY INTERFACE THAT IS NOT A VLAN, which `type` is what ' +
    'identifies. `members` are the interfaces a bridge or a link aggregation ' +
    'is built from. IT IS NULL WHERE THE SYSTEM REPORTED NO MEMBER LIST, which ' +
    'is the ordinary case for a `PHYSICAL` or `VLAN` interface and is not a ' +
    'failure; on a `BRIDGE` or `LINK_AGGREGATION` an empty list means the ' +
    'aggregate currently has no members, and null means its member list could ' +
    'not be read — `type` is what tells those apart. Each member carries its ' +
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
