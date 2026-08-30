import type { CallResponse } from '@truenas/api-client';
import { firstValueFrom } from 'rxjs';
import { Role } from '@/interfaces';
import { ApiSurface, MutatingTool, ReadOnlyTool, ToolContext } from '@/catalog/tool';
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
    'alerts are still active conditions and are included. `uuid` is the ' +
    'identifier `alerts_dismiss` and `alerts_restore` take, and IT IS ' +
    'PER-SYSTEM: it names one alert on the one system it was read from, so a ' +
    'uuid read from one system must not be passed to a tool call targeting ' +
    'another. `id` is the alert\'s own class-and-key identifier, is what ' +
    '`klass` groups with, and IS NOT THAT ARGUMENT: nothing states that it ' +
    "names one system's alert instance, so acting on it would be ambiguous " +
    'wherever the same condition is raised on more than one system.',
  inputSchema: { type: 'object', properties: {} },
  requiredRole: Role.ReadOnly,
  mutating: false,
  async handler({ system }) {
    const alerts = await firstValueFrom(system.client.api.call('alert.list'));
    return alerts.map((alert) => ({
      // The identifier `alert.dismiss` and `alert.restore` take, added by #119
      // so that a caller can name the alert those tools want. It is reported
      // beside `id` rather than instead of it: the two are separate required
      // fields of the middleware's own alert, and only this one addresses an
      // alert on one system.
      uuid: alert.uuid,
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

/**
 * `alerts_dismiss` and `alerts_restore`: the mutating pair, and the first
 * mutation in the catalog that is not a snapshot.
 *
 * They flip one boolean on one notification record. No data, configuration or
 * storage changes, no job runs, and `alert.restore` is the exact inverse of
 * `alert.dismiss` in the same API — so `destructiveness: 'reversible'` is a
 * literal statement here rather than a judgement about how hard the undo is.
 *
 * THE IDENTIFIER IS `uuid` AND NOT `id`. `alert.dismiss` and `alert.restore`
 * both take a `uuid`, and the middleware's alert declares `uuid` and `id` as two
 * separate required fields. `alerts_list` reported only `id` until #119, so
 * there was no way for a caller to name the alert the API wants; it now reports
 * both. The ticket's live reading — the same `id` coming back from two
 * different systems for one `CertificateExpired`/`freenas_default` condition —
 * is why `id` is not accepted here: a tool keyed on it would be ambiguous under
 * the fan-out, which is the normal way these tools run. That reading was not
 * reproducible from this repository (there is no live system in the test
 * environment), so what is CONFIRMED is the surface — two declared fields, and a
 * method whose parameter is the first of them — and what is not is the account
 * of why they differ.
 *
 * WHAT THE PLAN NAMES IS WHAT `execute` CALLS, INCLUDING THE READ. Both plans
 * return two steps, `alert.list` then the mutation, because `execute` makes both
 * calls: the read is what lets the result say whether the alert had already been
 * dismissed, which `snapshots_create` needs no equivalent of. `snapshots_create`
 * reads at PLAN time and deliberately does not re-read at execute time, so its
 * one plan step is the whole of what it calls; a plan here that named only the
 * mutation would be a plan that is not true. The read is issued unconditionally
 * and nothing branches on it — the mutating call is made whatever it says — so
 * `execute` is still a pure function of (args, system) in the sense the
 * confirmation token depends on.
 *
 * ALREADY-DISMISSED IS NOT AN ERROR. Most alerts on a running system are
 * already dismissed, and dismissing one again is a no-op the middleware accepts.
 * The plan says which of the two it is about to do, and the result reports the
 * state read immediately before the call, so a caller can tell "this call
 * dismissed it" from "it was dismissed already".
 */

/** The one argument either tool takes. */
interface AlertTarget {
  uuid: string;
}

/**
 * The caller's argument, or the error naming what is missing.
 *
 * Strict, as `snapshots_create`'s `dataset` is: an identifier that is not a
 * non-empty string cannot be read as anything else without acting on an alert
 * nobody named.
 */
function parseTarget(args: Record<string, unknown>): AlertTarget {
  const uuid = args['uuid'];
  if (typeof uuid !== 'string' || uuid.length === 0) {
    throw new Error('"uuid" is required');
  }
  return { uuid };
}

/** One alert as `alert.list` sends it, named off the call rather than the entity (#91). */
type AlertRow = CallResponse<ApiSurface, 'alert.list'>[number];

/** The two methods this pair calls, which differ only in direction. */
type AlertStateMethod = 'alert.dismiss' | 'alert.restore';

/** The alert carrying this uuid, or null where the system listed none that did. */
async function findAlert(ctx: ToolContext, uuid: string): Promise<AlertRow | null> {
  const alerts = await firstValueFrom(ctx.system.client.api.call('alert.list'));
  return alerts.find((alert) => alert.uuid === uuid) ?? null;
}

/**
 * The alert in the terms `alerts_list` shows it, for the human approving the
 * plan. A uuid is not a thing anyone recognises, so the plan step has to name
 * the level, the class and the message.
 *
 * Each of the three is stated as absent rather than dropped where the system
 * reported none: a plan that silently omits the message reads as an alert
 * without one, and the person approving cannot tell which.
 */
function describeAlert(alert: AlertRow): string {
  const level = textOrNull(alert.level);
  const klass = textOrNull(alert.klass);
  const formatted = textOrNull(alert.formatted);
  const none = '(the system reported none)';
  return (
    `level ${level ?? none}, class ${klass ?? none}, ` +
    `message ${formatted === null ? none : `"${formatted}"`}`
  );
}

/** What one of the pair is, beyond the wording it presents itself with. */
interface AlertStateAction {
  name: string;
  description: string;
  method: AlertStateMethod;
  /** The `dismissed` state this tool moves an alert to. */
  target: boolean;
  /** Imperative for the plan step — `Dismiss`, `Restore`. */
  verb: string;
}

/**
 * What the plan says the call will do, given the state the alert is in now.
 *
 * Three cases and not two: an alert whose `dismissed` could not be read as a
 * boolean is neither already there nor about to move, and saying either would
 * be a claim the read did not establish.
 */
function effectSentence(action: AlertStateAction, current: boolean | null): string {
  if (current === null) {
    return 'Whether it is dismissed could not be read, so this may change nothing.';
  }
  if (current === action.target) {
    return `It is ${current ? 'already dismissed' : 'not dismissed'}, so this changes ` +
      'nothing and is not an error.';
  }
  return `It is ${current ? 'dismissed' : 'not dismissed'}, so this will ` +
    `${action.verb.toLowerCase()} it.`;
}

/**
 * One of the pair. Written once because the two differ only in the method they
 * call, the state they move an alert to and the words they say — the eleven
 * copies of `textOrNull` behind `common.ts` are what a second hand-written copy
 * of this would become.
 */
function alertStateTool(action: AlertStateAction): MutatingTool {
  return {
    name: action.name,
    description: action.description,
    inputSchema: {
      type: 'object',
      properties: {
        uuid: {
          type: 'string',
          minLength: 1,
          description:
            "The alert's `uuid` as `alerts_list` reports it, on the system " +
            'being targeted. Not its `id`, which does not name one system\'s alert.',
        },
      },
      required: ['uuid'],
    },
    requiredRole: Role.Full,
    mutating: true,
    destructiveness: 'reversible',
    normalizeArgs(rawArgs) {
      return { uuid: parseTarget(rawArgs).uuid };
    },
    async plan(ctx, rawArgs) {
      const { uuid } = parseTarget(rawArgs);
      const alert = await findAlert(ctx, uuid);
      // The failure names the identifier the caller supplied, because that is
      // the only part of it the caller can check. `assertDatasetExists` fails
      // the same way for `snapshots_create`.
      if (alert === null) {
        throw new Error(`No alert with uuid "${uuid}" on this system`);
      }
      return [
        {
          method: 'alert.list',
          params: [],
          description:
            'Read this system\'s alerts, to report whether the alert was already ' +
            'in the state this call moves it to. Changes nothing.',
        },
        {
          method: action.method,
          params: [uuid],
          description:
            `${action.verb} the alert with ${describeAlert(alert)} (uuid ${uuid}). ` +
            effectSentence(action, booleanOrNull(alert.dismissed)),
        },
      ];
    },
    async execute(ctx, rawArgs) {
      const { uuid } = parseTarget(rawArgs);
      // Caught rather than thrown: this read exists to describe the outcome,
      // and letting it fail the call would lose an approval the user has
      // already given for a mutation that is still perfectly safe to make.
      // The result then says the prior state could not be established.
      let alert: AlertRow | null = null;
      let lookupError: string | null = null;
      try {
        alert = await findAlert(ctx, uuid);
      } catch (reason) {
        lookupError = errorText(reason);
      }
      // Unconditional, whatever the read said. Skipping the call for an alert
      // the read no longer lists would be `execute` branching on state read at
      // execution time, which is what the confirmation token cannot bind.
      await firstValueFrom(ctx.system.client.api.call(action.method, [uuid]));
      const previous = alert === null ? null : booleanOrNull(alert.dismissed);
      return {
        uuid,
        lookup: lookupError !== null ? 'UNREADABLE' : alert === null ? 'NOT_FOUND' : 'FOUND',
        lookup_error: lookupError,
        previously_dismissed: previous,
        changed: previous === null ? null : previous !== action.target,
      };
    },
  };
}

export const alertsDismiss: MutatingTool = alertStateTool({
  name: 'alerts_dismiss',
  method: 'alert.dismiss',
  target: true,
  verb: 'Dismiss',
  description:
    'Dismisses one active alert on one TrueNAS system: the acknowledgement an ' +
    'operator makes in the UI, and nothing more. Two-phase: called without a ' +
    'confirmation_token it returns a plan for user approval; called with one it ' +
    'dismisses the alert. DISMISSING AN ALERT DOES NOT FIX WHAT RAISED IT — the ' +
    'condition is still active, `alerts_list` still reports the alert with ' +
    '`dismissed: true`, and the middleware may raise it again. `uuid` is the ' +
    'alert\'s `uuid` as `alerts_list` reports it, ON THE SYSTEM BEING TARGETED: ' +
    'it names one alert on one system, so read it from that system rather than ' +
    'reusing one read elsewhere. The `id` `alerts_list` also reports is NOT this ' +
    'argument and must not be passed as it. Planning against a uuid no alert on ' +
    'that system matches FAILS, naming the uuid supplied, so an approved plan is ' +
    'always a plan about an alert that existed when it was made. DISMISSING AN ' +
    'ALREADY-DISMISSED ALERT IS NOT AN ERROR, and is the ordinary case — most ' +
    'alerts on a running system are already dismissed. The plan says which of ' +
    'the two it is about to do, and the result reports it: `previously_dismissed` ' +
    'is the alert\'s state as read immediately before the call, `changed` is ' +
    'true where that state was the other one and the call did not reject, and ' +
    'false where the alert was already dismissed and this call therefore moved ' +
    'nothing. BOTH ARE NULL WHERE THE PRIOR STATE COULD NOT BE ESTABLISHED, ' +
    'WHICH IS NOT "NOTHING CHANGED". `lookup` says what the read did: `FOUND` ' +
    'is a read that named this alert, `NOT_FOUND` a read that completed and ' +
    'listed no alert with this uuid (it cleared between the plan and the ' +
    'confirmation), and `UNREADABLE` a read that failed, with `lookup_error` ' +
    'naming why. IT HAS THREE VALUES AND THE NULL PAIR HAS FOUR CAUSES: the two ' +
    'above, and ALSO `FOUND` where the alert reported no `dismissed` this tool ' +
    'could read as a boolean — an alert that was there and did not state ' +
    'whether it had been dismissed. So `lookup` alone does not tell them apart, ' +
    'and `FOUND` beside a null `previously_dismissed` is that fourth case. THE ' +
    'DISMISSAL IS ATTEMPTED IN ALL THREE CASES, because what runs must be what ' +
    'was approved; wherever `previously_dismissed` is null this tool cannot say ' +
    'whether anything was dismissed, only that the call did not reject. ' +
    '`alerts_restore` is the exact inverse and un-dismisses an alert this tool ' +
    'dismissed. It changes no data, no configuration and no storage, it starts ' +
    'no job, and it silences nothing for the future — `alert_settings` reports ' +
    'the per-class policies that do that, and no tool here changes them.',
});

export const alertsRestore: MutatingTool = alertStateTool({
  name: 'alerts_restore',
  method: 'alert.restore',
  target: false,
  verb: 'Restore',
  description:
    'Un-dismisses one active alert on one TrueNAS system, the exact inverse of ' +
    '`alerts_dismiss`: the alert goes back to reporting `dismissed: false`, as ' +
    'though it had never been acknowledged. Two-phase: called without a ' +
    'confirmation_token it returns a plan for user approval; called with one it ' +
    'restores the alert. RESTORING AN ALERT CHANGES NOTHING ABOUT THE CONDITION ' +
    'THAT RAISED IT — a dismissed alert was already an active condition that ' +
    '`alerts_list` reported, and this only clears the acknowledgement. `uuid` is ' +
    'the alert\'s `uuid` as `alerts_list` reports it, ON THE SYSTEM BEING ' +
    'TARGETED: it names one alert on one system, so read it from that system ' +
    'rather than reusing one read elsewhere. The `id` `alerts_list` also reports ' +
    'is NOT this argument and must not be passed as it. Planning against a uuid ' +
    'no alert on that system matches FAILS, naming the uuid supplied, so an ' +
    'approved plan is always a plan about an alert that existed when it was ' +
    'made. RESTORING AN ALERT THAT WAS NEVER DISMISSED IS NOT AN ERROR. The plan ' +
    'says which of the two it is about to do, and the result reports it: ' +
    '`previously_dismissed` is the alert\'s state as read immediately before the ' +
    'call, `changed` is true where the alert was dismissed and the call did not ' +
    'reject, and false where it was not dismissed and this call therefore moved ' +
    'nothing. BOTH ARE NULL WHERE THE PRIOR STATE COULD NOT BE ESTABLISHED, ' +
    'WHICH IS NOT "NOTHING CHANGED". `lookup` says what the read did: `FOUND` ' +
    'is a read that named this alert, `NOT_FOUND` a read that completed and ' +
    'listed no alert with this uuid (it cleared between the plan and the ' +
    'confirmation), and `UNREADABLE` a read that failed, with `lookup_error` ' +
    'naming why. IT HAS THREE VALUES AND THE NULL PAIR HAS FOUR CAUSES: the two ' +
    'above, and ALSO `FOUND` where the alert reported no `dismissed` this tool ' +
    'could read as a boolean — an alert that was there and did not state ' +
    'whether it had been dismissed. So `lookup` alone does not tell them apart, ' +
    'and `FOUND` beside a null `previously_dismissed` is that fourth case. THE ' +
    'RESTORE IS ATTEMPTED IN ALL THREE CASES, because what runs must be what was ' +
    'approved; wherever `previously_dismissed` is null this tool cannot say ' +
    'whether anything was restored, only that the call did not reject. It ' +
    'changes no ' +
    'data, no configuration and no storage, and it starts no job.',
});
