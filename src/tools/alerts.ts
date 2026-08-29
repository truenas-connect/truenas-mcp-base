import { firstValueFrom } from 'rxjs';
import { Role } from '@/interfaces';
import { ReadOnlyTool } from '@/catalog/tool';
import { booleanOrNull, errorText, recordOrNull, textOrNull } from '@/tools/common';

/**
 * The system's own health verdict. `system_info` and the storage tools describe
 * what a system *is*; this reports what it is *complaining about*, already
 * computed by the middleware rather than inferred from capacity numbers.
 */
export const alertsList: ReadOnlyTool = {
  name: 'alerts_list',
  description:
    'Active alerts a TrueNAS system has raised: severity level, alert class, ' +
    'the message, when it fired, and whether it has been dismissed. Dismissed ' +
    'alerts are still active conditions and are included.',
  inputSchema: { type: 'object', properties: {} },
  requiredRole: Role.ReadOnly,
  mutating: false,
  async handler({ system }) {
    const alerts = await firstValueFrom(system.client.api.call('alert.list'));
    return alerts.map((alert) => ({
      id: alert.id,
      // The middleware's own class identifier, e.g. `ZpoolCapacityWarning`.
      klass: alert.klass,
      level: alert.level,
      // The rendered message. Null when the middleware could not format it;
      // the raw `text` template it falls back from carries unsubstituted
      // placeholders, so it is not a useful substitute and is not surfaced.
      formatted: alert.formatted,
      datetime: alert.datetime,
      dismissed: alert.dismissed,
    }));
  },
};

/**
 * `alert_settings`: where this system sends its alerts, and which alert classes
 * have been configured away from their defaults.
 *
 * `alerts_list` above says what the system is complaining about. This says
 * whether anyone would ever hear it — a system whose only destination was
 * removed months ago, or whose noisiest class was set to `NEVER`, is
 * indistinguishable through `alerts_list` from one that is simply quiet.
 *
 * Two reads, and only the first is the answer. `alertservice.query` holds the
 * destinations; `alertclasses.config` holds the per-class settings and is
 * supplementary, because a system whose class settings could not be read still
 * has the half of the answer that says whether an alert leaves the machine at
 * all. `failures` is what stops the missing half reading as "nothing
 * overridden", the way it does in `network.ts` and `block.ts`.
 *
 * BOTH METHODS ARE IN THE PINNED CLIENT'S CALL DIRECTORY, against the ticket's
 * (unconfirmed) design note that `alertservice.query` was absent from it — that
 * note read an endpoint enum, and the directory is the wider list. What the note
 * got wrong in the other direction is `alert.list_policies`, offered there as
 * the per-class read: it is present, and it answers `string[]` — the vocabulary
 * of valid policy names, the same four this tool's description names, and
 * nothing about any particular class. `alertclasses.config` is the per-class
 * one, and it is not called for the vocabulary because the vocabulary is not a
 * per-system fact and a caller cannot act on it.
 *
 * A DESTINATION'S `attributes` IS ALMOST ENTIRELY SECRET MATERIAL. The client's
 * own type names ten destination shapes carrying, between them, an SNS access
 * key and secret key, an InfluxDB password, Mattermost and Slack webhook URLs, a
 * PagerDuty service key, OpsGenie and VictorOps API keys and a Telegram bot
 * token. So the mapping below is an ALLOWLIST, as in `credentials.ts` and
 * `certificates.ts`, and for the same sharper reason those files give: a copy
 * with the known secret fields removed would leak the next destination type's
 * secret the day TrueNAS adds one. `attributes` is read for exactly one string,
 * its `type`, and nothing else within it can reach a caller without a change to
 * this file.
 */

/**
 * `recordOrNull` from `common.ts` is what stops a reported-as-null `attributes`
 * being indexed, and what keeps a list from being read as a record: the two
 * things read through it here — a destination's `attributes` and the per-class
 * settings map — are records, and reading a list as one would answer null for
 * every field rather than saying the shape was not what this tool reads.
 */

/** The one supplementary read of this tool, named for the field it fills. */
interface SettingsFailure {
  source: 'class_overrides';
  error: string;
}

/** A read that produced a value, or the failure that stopped it. */
interface Attempt<T> {
  value: T | null;
  failure: SettingsFailure | null;
}

/**
 * The supplementary read, with a failure caught and named rather than thrown.
 *
 * The read is passed as a thunk so that the call is made inside the `try`, which
 * keeps this correct for a read that throws before it returns a promise at all.
 */
async function attempt<T>(
  source: SettingsFailure['source'],
  read: () => Promise<T>,
): Promise<Attempt<T>> {
  try {
    return { value: await read(), failure: null };
  } catch (reason) {
    return { value: null, failure: { source, error: errorText(reason) } };
  }
}

/**
 * The destination's type as the system spells it — `Mail`, `Slack`,
 * `PagerDuty` — or null where it named none this tool could read.
 *
 * Read off the row rather than taken from the client's type, because its PLACE
 * has moved across releases while its spelling has not: the version the pinned
 * client describes carries it inside `attributes`, and releases before it carry
 * a top-level `type` beside a separately named attribute object. Both are read,
 * in that order, and neither reading carries anything else out of `attributes`.
 *
 * `type__title` is deliberately not read. It is the DISPLAY title of this same
 * fact in a different vocabulary, so falling back to it would put two spellings
 * in one field with nothing on the row to say which of them arrived.
 *
 * NULL IS "THIS SYSTEM NAMED NO TYPE THIS TOOL COULD READ" AND NEVER "A
 * DESTINATION WITH NO TYPE". Every alert service has one — it is what decides
 * where the alert goes — so a null here is a destination worth looking at
 * directly rather than one that is somehow typeless.
 */
function destinationType(row: object): string | null {
  const record = row as Record<string, unknown>;
  return (
    textOrNull(recordOrNull(record['attributes'])?.['type']) ?? textOrNull(record['type'])
  );
}

/** One alert class the system holds a per-class setting for. */
interface ClassOverrideRow {
  class: string;
  policy: string | null;
  level: string | null;
  proactive_support: boolean | null;
}

/**
 * Every alert class carrying a stored per-class setting, or null where the
 * settings could not be read at all.
 *
 * Null covers the read that failed and the response that held no settings map,
 * which are the same fact to a caller: the per-class settings cannot be stated.
 * Neither is the empty list of a system that has overridden nothing, and
 * `failures` is what names the first of the two — the same split `network.ts`
 * keeps for its static routes.
 *
 * The map holds only the classes something has been changed on; a class absent
 * from it is at its defaults, which is nearly all of them. That is why the three
 * fields are read individually and each may be null: a class whose severity was
 * lowered and whose policy was left alone is stored here with a `level` and no
 * `policy`, and reporting a missing policy as anything other than null would
 * invent a suppression that is not configured.
 *
 * Sorted by class name so that two calls against an unchanged system answer in
 * the same order — the settings arrive as an object, whose key order is whatever
 * the middleware serialised and is not a fact about the system.
 */
function classOverrides(config: unknown): ClassOverrideRow[] | null {
  const classes = recordOrNull(recordOrNull(config)?.['classes']);
  if (classes === null) return null;
  return Object.keys(classes)
    .sort()
    .map((name) => {
      const setting = recordOrNull(classes[name]);
      return {
        class: name,
        policy: textOrNull(setting?.['policy']),
        level: textOrNull(setting?.['level']),
        proactive_support: booleanOrNull(setting?.['proactive_support']),
      };
    });
}

export const alertSettings: ReadOnlyTool = {
  name: 'alert_settings',
  description:
    'Where this TrueNAS system sends its alerts, and which alert classes have ' +
    'been configured away from their defaults. This is the settings behind ' +
    '`alerts_list`, which is what reports the alerts themselves; neither tool ' +
    'reports the other. `destinations` is every alert service configured on ' +
    'this system. Each has the `name` a person gave it, null where the system ' +
    'reported none; its `type` as the system spells it in the destination ' +
    'record — `Mail`, `Slack`, `Mattermost`, `PagerDuty`, `OpsGenie`, ' +
    '`VictorOps`, `AWSSNS`, `InfluxDB`, `SNMPTrap`, `Telegram` — and null ' +
    'where the system named no type this tool could read, WHICH IS NOT A ' +
    'DESTINATION WITHOUT ONE; `enabled`, true where the destination is ' +
    'switched on and false where it is switched off, and NULL WHERE THE ' +
    'SYSTEM REPORTED NO ENABLED STATE, WHICH IS NOT THE SAME AS DISABLED; and ' +
    '`minimum_level`, the lowest severity an alert must reach before it is ' +
    'sent there, one of `INFO`, `NOTICE`, `WARNING`, `ERROR`, `CRITICAL`, ' +
    '`ALERT`, `EMERGENCY` — least severe first — and null where the system ' +
    'reported none. AN EMPTY `destinations` LIST IS A SYSTEM THAT SENDS ITS ' +
    'ALERTS NOWHERE, and that is the finding rather than a missing answer: ' +
    'alerts are still raised and `alerts_list` still reports them, but nothing ' +
    'leaves the machine. THIS TOOL RETURNS NO PART OF A DESTINATION\'S ' +
    'CONFIGURATION BEYOND ITS TYPE. The stored record holds the webhook URL, ' +
    'API key, service key, OAuth or bot token, SNS access key and secret key, ' +
    'mailbox address, host, username or password the destination authenticates ' +
    'with; NONE of that appears here, and no field a later TrueNAS release ' +
    'adds to a destination — including a whole new destination type spelling ' +
    'its secret some new way — can appear without a code change, because the ' +
    'four fields above are named explicitly rather than copied with the known ' +
    'secrets removed. It follows that this tool cannot say WHICH mailbox, ' +
    'channel, room or account a destination actually reaches, only that one of ' +
    'that type is configured: the NAME is the only account of that, and a name ' +
    'is whatever a person typed. It also does not say whether a destination ' +
    'still works — nothing here sends a test message — and it does not create, ' +
    'change, delete or test one. `class_overrides` is every alert class this ' +
    'system holds a per-class setting for, sorted by `class`. A CLASS THAT IS ' +
    'NOT LISTED IS AT ITS DEFAULTS, which is the ordinary case and is why this ' +
    'list is short: only classes someone has changed appear at all. `class` is ' +
    "the middleware's own class identifier — `ZpoolCapacityWarning`, " +
    '`SMARTError` — and is the same vocabulary as `klass` on an alert from ' +
    '`alerts_list`, so the two join. `policy` is how often that class is sent: ' +
    '`IMMEDIATELY`, `HOURLY`, `DAILY` or `NEVER`, AND `NEVER` IS THE ' +
    'SUPPRESSED CASE — a class whose alerts are still raised and still ' +
    'reported by `alerts_list`, and are sent to no destination at all. `policy` ' +
    'is null where the stored setting named no policy this tool could read — ' +
    'either the class is at the DEFAULT policy and was changed some other way, ' +
    'or its setting named one in a shape this tool does not read. A NULL ' +
    'POLICY IS NEVER SUPPRESSION. `level` is the severity that class is raised ' +
    'at where it has ' +
    'been changed from that class\'s own default, in the same vocabulary as ' +
    '`minimum_level` above, and null where the stored setting names none. ' +
    '`proactive_support` is whether that class is included in proactive ' +
    'support reporting, null where the stored setting names none. An entry ' +
    'whose `policy`, `level` and `proactive_support` are ALL null is a class ' +
    'the system holds a setting for that names none of these three. ' +
    '`class_overrides` IS NULL WHERE THE PER-CLASS SETTINGS COULD NOT BE READ ' +
    'AT ALL, WHICH IS NOT THE EMPTY LIST OF A SYSTEM THAT HAS OVERRIDDEN ' +
    'NOTHING. `failures` names each read that did not complete, with the ' +
    'reason the system gave, and is empty where every read completed — SO IT ' +
    'DOES NOT NAME A READ THAT COMPLETED AND ANSWERED A SHAPE THIS TOOL COULD ' +
    'NOT READ, which shows as a null instead. Whether an alert is actually ' +
    'delivered depends on both halves: a class set to `NEVER` reaches no ' +
    'destination however many are configured, and a class at its default ' +
    'reaches none when `destinations` is empty. This tool reports the settings ' +
    'as they are and changes none of them. NO field beyond those named here is ' +
    'returned, whatever else a later TrueNAS release adds to a destination or ' +
    'to a class setting.',
  inputSchema: { type: 'object', properties: {} },
  requiredRole: Role.ReadOnly,
  mutating: false,
  async handler({ system }) {
    // Both reads are issued before either is awaited, so neither waits on the
    // other. No filters and no options on the destinations: a system holds a
    // handful of them at most, and all four reported fields are part of the row
    // as it stands.
    const [services, classes] = await Promise.all([
      firstValueFrom(system.client.api.query('alertservice.query')),
      attempt('class_overrides', () =>
        firstValueFrom(system.client.api.call('alertclasses.config')),
      ),
    ]);

    return {
      destinations: services.map((service) => ({
        name: textOrNull(service.name),
        type: destinationType(service),
        enabled: booleanOrNull(service.enabled),
        // The client names this `level`; it is reported as `minimum_level`
        // because that is what it does — an alert below it is not sent here —
        // and because a class override in the same result carries a `level`
        // that is a different fact, the severity the alert is raised at.
        minimum_level: textOrNull(service.level),
      })),
      class_overrides: classOverrides(classes.value),
      failures: classes.failure === null ? [] : [classes.failure],
    };
  },
};
