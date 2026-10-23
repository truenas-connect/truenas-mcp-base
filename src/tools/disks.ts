import { firstValueFrom } from 'rxjs';
import { Role } from '@/interfaces';
import { MutatingTool, PlanStep, ReadOnlyTool, SystemHandle, ToolContext } from '@/catalog/tool';
import {
  booleanOrNull,
  effectiveLimit,
  errorText,
  numberOrNull,
  recordOrNull,
  textOrNull,
  unreportedKeys,
} from '@/tools/common';

/** Hardware inventory: the physical disks under the pools.
 *
 * `storage_pool_status` reports pools as units and says nothing about the
 * devices beneath them, so "which disks are there", "what is unassigned" and
 * "which model and size is each" have no inventory to reason over without this.
 *
 * Physical placement is not among them: `enclosure` (the shelf and slot a disk
 * sits in) is dropped, so this cannot answer "do I have a spare bay". It
 * answers the weaker "do I have an unassigned disk", via `pool`.
 *
 * The mapping below is an allowlist rather than a trim, which matters more here
 * than for the other read-only tools: a `disk.query` row carries the SED
 * passphrase (`passwd`) and its KMIP key id, and naming the output fields
 * explicitly is what keeps them out of the tool result and so out of the
 * conversation. Serial numbers are identifying but not secret, and are response
 * data rather than arguments, so the "no secrets as arguments" rule in
 * `catalog/tool.ts` is not in play.
 */

export const disksList: ReadOnlyTool = {
  name: 'disks_list',
  description:
    'Physical disks attached to a TrueNAS system: device name, model, serial ' +
    'number, size in bytes, media type (HDD/SSD) and transfer mode, plus which ' +
    'ZFS pool each disk belongs to. `pool` is null when the disk belongs to no ' +
    'pool; the field is absent entirely when the system did not report pool ' +
    'membership, which is not the same as the disk being unassigned.',
  inputSchema: { type: 'object', properties: {} },
  requiredRole: Role.ReadOnly,
  mutating: false,
  async handler({ system }) {
    const disks = await firstValueFrom(
      // Filters and options are inlined so the call's own parameter types
      // apply, as in storage.ts. `extra.pools` is what makes the middleware
      // attach each disk's owning pool; the client types `extra` as an open
      // `Record<string, unknown>`, so it carries the key without confirming
      // it — which is why the mapping below treats an absent `pool` as its
      // own state rather than assuming the request was honoured.
      system.client.api.query('disk.query', [], { extra: { pools: true } }),
    );
    return disks.map((disk) => ({
      name: disk['name'],
      model: disk['model'],
      serial: disk['serial'],
      size_bytes: disk['size'],
      // Two distinct fields the middleware happens to name similarly: `type`
      // is the medium (HDD/SSD), `transfermode` is the link mode (e.g. Auto,
      // SATA300).
      type: disk['type'],
      transfermode: disk['transfermode'],
      // Spread rather than assigned: `pool: undefined` and no `pool` key are
      // the same after JSON serialization but not to a caller reading the
      // object, and the two states this has to keep apart are "in no pool"
      // (null) and "membership not reported" (absent).
      ...('pool' in disk ? { pool: disk['pool'] } : {}),
    }));
  },
};

/**
 * How hot the disks are running, and how that has moved.
 *
 * `storage_pool_status` reports a pool as DEGRADED once a device has already
 * failed, and `alerts_list` reports a temperature threshold that has already
 * been crossed. Neither answers "which disk is running hot but has not tripped
 * anything yet", which is the question with time still on it and is the whole
 * of why this tool exists.
 *
 * IT REPORTS TEMPERATURE AND NOTHING ELSE FROM SMART. No test results, no error
 * history, no power-on hours: there is no `smart.*` method anywhere in the eight
 * version directories the pinned client ships, so those are not reachable from
 * this repository at all. The name says `temperature` for that reason — a
 * `disks_smart_status` reporting only a temperature would be a name promising
 * what the data cannot hold, which is `storage_scrub_history`'s review finding
 * (#97's first bullet) made on purpose rather than by accident.
 *
 * THREE THINGS ABOUT THE CURRENT-TEMPERATURE READ ARE UNCONFIRMED, and each is
 * handled by saying so rather than by assuming:
 *
 * - **The per-disk value shape.** `disk.temperatures` is declared
 *   `Record<string, unknown>` — once, in the oldest directory, with no later
 *   one narrowing it — so the client says a record keyed by something is there
 *   and nothing whatever about what the values are. Both plausible shapes are
 *   read: a bare number is the temperature, and a record is read through
 *   `TEMPERATURE_KEYS`. Neither is forwarded.
 * - **The key names inside that record**, which are a considered guess in the
 *   #98 sense. `unreported_fields` names every key a record actually carried
 *   whose value is not reported, built from the keys that produced a value and
 *   never from the allowlist, so a caller seeing three nulls beside a full list
 *   is looking at an allowlist that does not fit this system rather than at a
 *   disk reporting nothing.
 * - **Whether reading a temperature wakes a spun-down disk.** THIS COULD NOT BE
 *   ESTABLISHED. The client's types say nothing about it — `standby`,
 *   `smartctl` and `powermode` appear nowhere near these methods — and no live
 *   system was available to watch. It is stated as unestablished in the
 *   description, with the consequence named, rather than settled by a guess in
 *   either direction: asserting "this does not wake disks" is exactly the
 *   description-promising-more-than-the-read-delivers defect, and asserting the
 *   opposite would be it too. The unbounded default (no `disks`, every disk)
 *   is kept because the ticket's scope names it and the risk is unestablished
 *   rather than established; a caller that has deliberately parked disks is
 *   told to name the ones it wants.
 *
 * THE AGGREGATE IS THE OPPOSITE CASE and is behind an argument for it. Its keys
 * ARE declared (`DiskTemperatureAggEntry` is `{ min, max, avg }`), so nothing
 * about it is guessed — but it is a second call per invocation for history most
 * callers do not want, all three of its fields are nullable, and it answers a
 * different question from the rest of the tool: how a temperature has MOVED, out
 * of the recorded metrics, rather than what it IS right now, off the device. So
 * it is read only when `history_days` asks for it, and `history` says whether it
 * was asked for and whether it could be read. Leaving it out of this tool was
 * the other defensible answer; it is in because the question "is this disk
 * getting hotter" is the one a current reading cannot answer on its own.
 *
 * `disk.temperature_alerts` is deliberately not read. It answers `Alert[]`,
 * which `alerts_list` already normalizes, and reading it here would be a second
 * drifting opinion about an alert's shape. The description points at that tool.
 */

/**
 * The keys this tool reads out of one disk's temperature record, in one place
 * because they are used twice — once to read the value, once to work out which
 * keys were left unreported.
 *
 * THESE NAMES ARE THE UNCONFIRMED PART OF THIS TOOL, in the same way and for
 * the same reason as `nfs.ts`'s `INFO_KEYS`: the record's contents are not
 * described anywhere in the client, and no live system was available to read
 * them off. Guessing wrong costs nulls rather than wrong answers, and
 * `unreported_fields` is what makes the guess visible from outside.
 */
const TEMPERATURE_KEYS = {
  temperature: 'temp',
  warning: 'warn',
  critical: 'crit',
} as const;

/** The keys of one aggregate entry. Declared by the client, so not a guess. */
const AGGREGATE_KEYS = { min: 'min', max: 'max', avg: 'avg' } as const;

/** How many days of history a bare `history_days` that could not be read asks for. */
const DEFAULT_HISTORY_DAYS = 7;

/**
 * The longest history this tool will ask for.
 *
 * The aggregate is three numbers however wide the window is, so the bound is
 * about what the system is asked to scan rather than about the response size.
 */
const MAX_HISTORY_DAYS = 90;

/** What a read that answered with something other than a record is reported as. */
const NOT_A_RECORD = 'the system answered with something other than a record of temperatures';

/** What a listing that answered with something other than a list is reported as. */
const NOT_A_LIST = 'the system answered with something other than a list of disks';

/** One disk's temperature, the thresholds it is judged against, and its history. */
interface DiskTemperature {
  name: string;
  temperature_reported: boolean;
  temperature_celsius: number | null;
  warning_celsius: number | null;
  critical_celsius: number | null;
  unreported_fields: string[] | null;
  recent: {
    min_celsius: number | null;
    max_celsius: number | null;
    avg_celsius: number | null;
  } | null;
}

/** A record the system answered with, or the reason there is none. */
interface Read {
  record: Record<string, unknown> | null;
  error: string | null;
}

/**
 * The disks the caller asked about, or null for "every disk on the system".
 *
 * A malformed argument throws rather than being read past, as `vm_logs` and
 * `audit_log_query` do with theirs: silently dropping an unreadable entry would
 * answer about fewer disks than were asked for while looking like a complete
 * answer, and a caller naming devices is making a claim about which ones it
 * wants rather than describing what it found.
 */
function requestedDisks(raw: unknown): string[] | null {
  if (raw == null) return null;
  if (!Array.isArray(raw)) throw new Error('"disks" must be a list of device names');
  return raw.map((entry) => {
    const name = textOrNull(entry);
    if (name === null) throw new Error('"disks" must hold non-empty device names');
    return name;
  });
}

/** How many days of history to read, or null where none was asked for. */
function requestedHistoryDays(raw: unknown): number | null {
  if (raw == null) return null;
  return effectiveLimit(raw, DEFAULT_HISTORY_DAYS, MAX_HISTORY_DAYS);
}

/**
 * Every disk the system lists, by the name `disks_list` reports.
 *
 * The call is inlined rather than shared with `disks_list` above, for the reason
 * `reporting.ts` gives for inlining its two: the client types `query` per
 * method, so a method name reaching it through a variable widens to `string` and
 * no longer selects an overload.
 *
 * `extra.pools` is not asked for here — pool membership is `disks_list`'s
 * answer and this tool reports none of it, so asking would be asking the
 * middleware to do work whose result is dropped.
 *
 * A listing that cannot be read is fatal rather than reported beside an answer:
 * both reads below need the names, so there is no partial answer left to give.
 *
 * A rejection is not the only way it can fail to produce names. `query` types
 * its answer as a plain array of rows, and that is a claim about what the
 * middleware sends rather than the value received — the call directory declares
 * `disk.query` as answering a union that also admits a bare row and a count. So
 * a non-list answer is raised exactly like a rejection, and NOT read as a system
 * that lists no disks: an empty result is defined as "the system lists none",
 * which is a claim this read did not establish.
 */
async function allDiskNames(system: SystemHandle): Promise<string[]> {
  const rows: unknown = await firstValueFrom(system.client.api.query('disk.query'));
  if (!Array.isArray(rows)) throw new Error(NOT_A_LIST);
  return rows.flatMap((row) => {
    const name = textOrNull(recordOrNull(row)?.['name']);
    return name === null ? [] : [name];
  });
}

/** One read that answers with a record, with a failure caught and named. */
async function readRecord(read: () => Promise<unknown>): Promise<Read> {
  try {
    const answer = await read();
    const record = recordOrNull(answer);
    if (record === null) return { record: null, error: NOT_A_RECORD };
    return { record, error: null };
  } catch (reason) {
    return { record: null, error: errorText(reason) };
  }
}

/** What one disk's aggregate entry says, or null where there was none to read. */
function readRecent(value: unknown): DiskTemperature['recent'] {
  const entry = recordOrNull(value);
  if (entry === null) return null;
  return {
    min_celsius: numberOrNull(entry[AGGREGATE_KEYS.min]),
    max_celsius: numberOrNull(entry[AGGREGATE_KEYS.max]),
    avg_celsius: numberOrNull(entry[AGGREGATE_KEYS.avg]),
  };
}

/**
 * One disk's row, read out of whatever the two records held under its name.
 *
 * `Object.hasOwn` rather than `in`, which walks the prototype: a disk named
 * `constructor` would otherwise report as present in every response.
 */
function readDiskTemperature(
  name: string,
  temperatures: Record<string, unknown>,
  aggregates: Record<string, unknown> | null,
): DiskTemperature {
  const recent = aggregates === null ? null : readRecent(aggregates[name]);
  if (!Object.hasOwn(temperatures, name)) {
    return {
      name,
      temperature_reported: false,
      temperature_celsius: null,
      warning_celsius: null,
      critical_celsius: null,
      unreported_fields: null,
      recent,
    };
  }

  const value = temperatures[name];
  const record = recordOrNull(value);
  // A value that is not a record is read as the temperature itself, which is
  // the shape a system carrying no thresholds is expected to answer with. It
  // names no keys, so there is nothing for `unreported_fields` to hold — null
  // there says "this entry was not a record", not "every key is reported".
  if (record === null) {
    return {
      name,
      temperature_reported: true,
      temperature_celsius: numberOrNull(value),
      warning_celsius: null,
      critical_celsius: null,
      unreported_fields: null,
      recent,
    };
  }

  // Which allowlisted keys the record actually answered with a value for,
  // accumulated as the fields are read rather than restated from
  // `TEMPERATURE_KEYS`: a key whose value the guard rejected is not reported and
  // has to reach `unreportedKeys` as such, which is what covers the second way
  // an unconfirmed allowlist is wrong.
  const reported: string[] = [];
  const fromRecord = (key: string): number | null => {
    const read = numberOrNull(record[key]);
    if (read !== null) reported.push(key);
    return read;
  };

  return {
    name,
    temperature_reported: true,
    temperature_celsius: fromRecord(TEMPERATURE_KEYS.temperature),
    warning_celsius: fromRecord(TEMPERATURE_KEYS.warning),
    critical_celsius: fromRecord(TEMPERATURE_KEYS.critical),
    unreported_fields: unreportedKeys(record, reported),
    recent,
  };
}

export const disksTemperature: ReadOnlyTool = {
  name: 'disks_temperature',
  description:
    'How hot each disk in a TrueNAS system is running right now, the ' +
    'thresholds the system judges it against, and — when asked for — how that ' +
    'temperature has moved over recent days. `storage_pool_status` reports a ' +
    'pool as degraded only once a device has already failed and `alerts_list` ' +
    'reports a threshold that has already been crossed; this is what answers ' +
    '"which disk is running hot but has not tripped anything yet". ' +
    'THIS TOOL REPORTS TEMPERATURE AND NOTHING ELSE FROM SMART: no self-test ' +
    'results, no error or reallocation counts, no power-on hours. None of ' +
    'those is reachable through the client this server uses, so their absence ' +
    'is not something a caller can work around by asking differently. ' +
    '`disks` names the devices to report on, using the same names `disks_list` ' +
    'reports; omitted, every disk the system lists is reported. A name that ' +
    'the system does not answer for is still listed, with ' +
    '`temperature_reported` false. A DISK THE LISTING GAVE NO READABLE NAME ' +
    'FOR IS NOT REPORTED AT ALL, because there is no name to ask about or to ' +
    'match an answer back to; `disks_list` is the inventory and is what says ' +
    'how many disks there are. ' +
    'IT IS NOT ESTABLISHED WHETHER READING A TEMPERATURE WAKES A SPUN-DOWN ' +
    'DISK. Nothing in the client says, and this has not been checked against a ' +
    'live system. If it does, calling this with no `disks` argument would spin ' +
    'up every parked drive on the system — so on a system where disks are ' +
    'deliberately kept in standby, NAME THE DISKS YOU WANT rather than asking ' +
    'for all of them. This does not make the tool mutating: it changes no ' +
    'configuration and no data. ' +
    'TEMPERATURES AND THRESHOLDS ARE IN DEGREES CELSIUS. The API declares no ' +
    'unit for them; the unit is carried in the field names because SMART and ' +
    'ATA define a drive temperature in Celsius and nothing else is an ordinary ' +
    'answer for one. ' +
    '`temperature_reported` says whether the system answered for that disk at ' +
    'all, and IS THE FIELD THAT SEPARATES THE THREE WAYS A TEMPERATURE CAN BE ' +
    'MISSING. False means the temperature read did not mention this disk. True ' +
    'with a null `temperature_celsius` means it did mention it and reported no ' +
    'temperature this tool could read — WHICH COVERS AN SSD THAT PUBLISHES NO ' +
    'TEMPERATURE AND A DISK THAT WAS ASLEEP OR UNREADABLE, and those are NOT ' +
    'distinguishable from each other here; do not read either as a cold disk. ' +
    'A read that failed outright is the third: `disks` is then null and ' +
    '`unavailable` says why, rather than every disk reporting null. ' +
    '`warning_celsius` and `critical_celsius` are the thresholds the system ' +
    'reported for that disk, and are null where it reported none this tool ' +
    'could read — a null threshold is not "no threshold is set", it is "none ' +
    'was reported"; `alert_settings` is where the alert policy itself lives. ' +
    'THE FIELD NAMES ABOVE ARE READ OUT OF AN OPEN RECORD AND ARE ' +
    'UNCONFIRMED. The client types this response as a record of unknown ' +
    'content, so the keys this tool looks for are a considered guess and have ' +
    'not been checked against a live system. Nothing from the record is passed ' +
    'through: `unreported_fields` names — by key name only, never by value — ' +
    'every key the record actually carried whose value is not reported above, ' +
    'which covers a key this tool does not look for and equally a key it does ' +
    'look for whose value was not a number. IF ALL THREE FIELDS ARE NULL AND ' +
    '`unreported_fields` IS FULL, the values are in the record under the names ' +
    'listed and this tool did not read them; report that rather than reading ' +
    'the nulls as a disk with no temperature. An EMPTY `unreported_fields` is ' +
    'the other answer: the record was read and every key it carried is ' +
    'reported. It is NULL where the entry was not a record at all — either ' +
    'because the system reported the temperature as a bare number, which is ' +
    'what a system carrying no thresholds is expected to answer with, or ' +
    'because there was no entry for this disk. ' +
    '`recent` is the history and is READ ONLY WHEN `history_days` ASKS FOR IT. ' +
    'It comes from the metrics the system records for itself rather than from ' +
    'the device, so it answers how a temperature has moved and never what it ' +
    'is now. `history` is null when no history was asked for, and every ' +
    '`recent` is then null too. Otherwise `history.days` is the window ' +
    'actually used — the request is rounded down and bounded to between 1 and ' +
    '90 days — and `history.unavailable` names the reason where that read ' +
    'failed, in which case every `recent` is null as well. With `history` ' +
    'present and `unavailable` null, a null `recent` is a disk the aggregate ' +
    'held no readable entry for. `min_celsius`, `max_celsius` and ' +
    '`avg_celsius` are each null where the system reported no value for them, ' +
    'and a `recent` whose three fields are all null is an entry that was there ' +
    'and said nothing. ' +
    '`disks` IS NULL WHEN THE TEMPERATURES COULD NOT BE READ and empty when ' +
    'the system lists no disks — never the same answer — and `unavailable` ' +
    'carries the reason for the first. This tool states no verdict: whether a ' +
    'temperature is a problem depends on the drive and the room, and the ' +
    'thresholds reported beside it are the system\'s own judgement rather than ' +
    'this tool\'s. It does not report which disks have already tripped a ' +
    'temperature alert, which is `alerts_list`; does not report disk model, ' +
    'size or pool membership, which is `disks_list`; does not report disk I/O ' +
    'error counters; and changes no threshold, standby policy or anything ' +
    'else.',
  inputSchema: {
    type: 'object',
    properties: {
      disks: {
        type: 'array',
        items: { type: 'string' },
        description:
          'The devices to report on, named as `disks_list` names them — ' +
          '["sda", "sdb"]. Omitted, every disk the system lists. Naming them ' +
          'is the safer call on a system with disks deliberately in standby; ' +
          'see the tool description.',
      },
      history_days: {
        type: 'number',
        description:
          'How many days of recorded history to summarise into `recent`. ' +
          'Omitted, no history is read at all and every `recent` is null. ' +
          'Rounded down, and bounded to between 1 and 90.',
      },
    },
  },
  requiredRole: Role.ReadOnly,
  mutating: false,
  async handler({ system }, args) {
    // Both arguments are resolved before anything is read, so a malformed one
    // is an error rather than a read issued over the wrong devices.
    const requested = requestedDisks(args['disks']);
    const days = requestedHistoryDays(args['history_days']);

    // `disk.temperature_agg` requires names where `disk.temperatures` takes
    // them optionally, so the "all disks" path needs the listing first. Both
    // reads are then issued together rather than one after the other.
    const names = requested ?? (await allDiskNames(system));
    // Nothing to ask about, so nothing is asked: a system with no disks answers
    // with an empty list rather than with a read over every disk, which is what
    // an empty `names` would otherwise become.
    if (names.length === 0) {
      return {
        disks: [],
        unavailable: null,
        history: days === null ? null : { days, unavailable: null },
      };
    }

    // The names are passed explicitly even where the caller asked for all of
    // them, so the disks reported on are the ones this tool resolved rather
    // than whatever the middleware would have chosen for an omitted argument.
    const [temperatures, aggregates] = await Promise.all([
      readRecord(() =>
        firstValueFrom(system.client.api.call('disk.temperatures', [names, true])),
      ),
      days === null
        ? Promise.resolve<Read>({ record: null, error: null })
        : readRecord(() =>
            firstValueFrom(system.client.api.call('disk.temperature_agg', [names, days])),
          ),
    ]);

    const history = days === null ? null : { days, unavailable: aggregates.error };

    const held = temperatures.record;
    if (held === null) {
      return { disks: null, unavailable: temperatures.error, history };
    }

    return {
      disks: names.map((name) => readDiskTemperature(name, held, aggregates.record)),
      unavailable: null,
      history,
    };
  },
};

/**
 * `disk_identify`: turning one disk's enclosure locate light on or off.
 *
 * THE SLOT IS FOUND BY THE DISK'S DEVICE NAME IN `enclosure2.query`, NOT
 * THROUGH `disk.query`'s `enclosure`. The ticket's route was `disk.query`'s
 * `enclosure: { number, slot }` mapped to an enclosure id. That route does not
 * exist, read from the middleware source (`truenas/middleware` master,
 * 2026-10-22). `enclosure` is computed from a database column,
 * `disk_enclosure_slot`, as `number * 1000 + slot`, and neither `disk.py` nor
 * `disk_/sync.py` writes that column. And no `enclosure2.query` entry has a
 * `number`: its top-level keys are `id`, `name`, `model`, `controller`,
 * `elements` and `label`. So there is no number to map from. `set_slot_status`
 * looks the enclosure up by `id` and the slot by its key under
 * `elements['Array Device Slot']`, and every slot element there carries `dev`,
 * the device name sysfs maps into it. Finding that `dev` gives the two values
 * the call takes, read from the same record it validates against.
 *
 * KEYS READ, ALL CONFIRMED FROM THE SAME SOURCE rather than guessed, so this
 * is a plain allowlist and not #98's form: the enclosure's `id` and `label`
 * (the middleware sets `label` to the user's label or else `name`), and per
 * slot `dev`, `supports_identify_light` and `drive_bay_light_status`. The last
 * is `"ON"`, `"OFF"` or null, read from the slot's sysfs `locate` attribute,
 * and is null where the slot does not support reading it. Not checked against a
 * live system with a shelf.
 *
 * WHAT CAN BE READ BACK IS THE KERNEL'S `locate` STATE, NOT THE LED. A result
 * reading `ON` is sysfs saying the slot's locate bit is set. No read says the
 * light is physically lit, and the guidance says so.
 */

/** The element type, under an enclosure's `elements`, that holds disk slots. */
const DISK_SLOT_ELEMENT = 'Array Device Slot';

/** Where a caller gets a disk name from. */
const DISK_NAMES_FROM = 'names come from `disks_list`';

/** What `disk_identify` was asked to do. */
interface IdentifyArgs {
  disk: string;
  on: boolean;
}

function parseIdentifyArgs(args: Record<string, unknown>): IdentifyArgs {
  const disk = textOrNull(args['disk']);
  if (disk === null) {
    throw new Error('"disk" is required and must be a disk name, as `disks_list` reports it');
  }
  const on = args['on'];
  if (typeof on !== 'boolean') throw new Error('"on" is required and must be a boolean');
  return { disk, on };
}

/** The disk as `disk.query` describes it, for the approver and the person at the rack. */
interface IdentifiedDisk {
  serial: string | null;
  model: string | null;
  /** The pool's name, null for "in no pool", undefined for "membership not reported". */
  pool: string | null | undefined;
}

/**
 * Reads the disk by name, or fails naming it. Plan-time only and not a step:
 * `execute` does not make this call (#192).
 *
 * The row is found by `name` rather than taken first, because a filter that did
 * not apply comes back as every disk (#121).
 */
async function readIdentifiedDisk(ctx: ToolContext, disk: string): Promise<IdentifiedDisk> {
  const rows: unknown = await firstValueFrom(
    ctx.system.client.api.query('disk.query', [['name', '=', disk]], { extra: { pools: true } }),
  );
  if (!Array.isArray(rows)) throw new Error(NOT_A_LIST);
  const row = rows.map(recordOrNull).find((entry) => textOrNull(entry?.['name']) === disk);
  if (row == null) throw new Error(`No disk named "${disk}" on this system — ${DISK_NAMES_FROM}`);
  return {
    serial: textOrNull(row['serial']),
    model: textOrNull(row['model']),
    pool: 'pool' in row ? textOrNull(row['pool']) : undefined,
  };
}

/** The slot a disk sits in, as one `enclosure2.query` entry reports it. */
interface DiskSlot {
  enclosureId: string;
  enclosureLabel: string | null;
  slot: number;
  /** `supports_identify_light`, or null where it could not be read. */
  supportsIdentify: boolean | null;
  /** `drive_bay_light_status`: `ON`, `OFF`, or null where none was reported. */
  light: string | null;
}

/** Every slot element in one enclosure entry, with its key, or null where they could not be read. */
function slotElements(enclosure: Record<string, unknown>): [string, Record<string, unknown> | null][] | null {
  const elements = recordOrNull(enclosure['elements']);
  const slots = elements === null ? null : recordOrNull(elements[DISK_SLOT_ELEMENT]);
  if (slots === null) return null;
  return Object.entries(slots).map(([key, value]) => [key, recordOrNull(value)]);
}

/** A slot key read as the number `set_slot_status` takes, or null where it is not one. */
function slotNumber(key: string): number | null {
  return /^\d+$/.test(key) ? Number(key) : null;
}

function slotOf(enclosure: Record<string, unknown>, key: string, element: Record<string, unknown>): DiskSlot | string {
  const enclosureId = textOrNull(enclosure['id']);
  const slot = slotNumber(key);
  if (enclosureId === null || slot === null) {
    return enclosureId === null ? 'an enclosure whose id could not be read' : `a slot keyed "${key}"`;
  }
  return {
    enclosureId,
    enclosureLabel: textOrNull(enclosure['label']),
    slot,
    supportsIdentify: booleanOrNull(element['supports_identify_light']),
    light: textOrNull(element['drive_bay_light_status']),
  };
}

/**
 * The enclosure entries the system listed, null for one that was not a record,
 * or a throw where the answer was not a list. An unreadable entry is kept as a
 * null so that it is counted: it could be the one holding the disk (#93).
 */
async function readEnclosures(ctx: ToolContext): Promise<(Record<string, unknown> | null)[]> {
  const rows: unknown = await firstValueFrom(ctx.system.client.api.query('enclosure2.query'));
  if (!Array.isArray(rows)) {
    throw new Error('the system answered `enclosure2.query` with something other than a list of enclosures');
  }
  return rows.map(recordOrNull);
}

/**
 * Finds the one slot whose `dev` is the disk, or fails saying why there is none
 * to send. Made at plan time AND again by `execute`, because the token binds the
 * disk's name and not the enclosure and slot the plan found it in (#181).
 *
 * A disk listed in two slots is refused, not resolved: lighting one of them
 * could light the wrong bay, which is the outcome this tool exists to prevent.
 */
async function findDiskSlot(ctx: ToolContext, disk: string): Promise<DiskSlot> {
  const enclosures = await readEnclosures(ctx);
  const found: (DiskSlot | string)[] = [];
  let unread = 0;
  for (const enclosure of enclosures) {
    const elements = enclosure === null ? null : slotElements(enclosure);
    if (enclosure === null || elements === null) {
      unread += 1;
      continue;
    }
    for (const [key, element] of elements) {
      if (element !== null && textOrNull(element['dev']) === disk) found.push(slotOf(enclosure, key, element));
    }
  }
  if (found.length > 1) {
    throw new Error(
      `Disk "${disk}" is listed in ${found.length} enclosure slots on this system, so which bay to light is not ` +
        'established; nothing is sent',
    );
  }
  const [slot] = found;
  if (slot === undefined) {
    throw new Error(
      `The system reports no managed enclosure slot for disk "${disk}"` +
        (unread > 0
          ? `, but ${unread} enclosure entr${unread === 1 ? 'y' : 'ies'} could not be read in full, so it may ` +
            'be in one of those. '
          : '. ') +
        'A system or disk without a managed enclosure has no locate light this tool can reach',
    );
  }
  if (typeof slot === 'string') {
    throw new Error(`Disk "${disk}" is listed in ${slot}, so the call cannot name its slot; nothing is sent`);
  }
  return slot;
}

/** The middleware refuses a slot that does not support identification, so the plan refuses first (#161). */
function identifyRefusal(disk: string, slot: DiskSlot): string | null {
  if (slot.supportsIdentify !== false) return null;
  return (
    `Slot ${slot.slot} of enclosure "${slot.enclosureId}", which holds disk "${disk}", reports that it does not ` +
    'support an identify light, and the middleware refuses the call for such a slot'
  );
}

function setSlotParams(slot: DiskSlot, on: boolean): [{ enclosure_id: string; slot: number; status: 'ON' | 'OFF' }] {
  return [{ enclosure_id: slot.enclosureId, slot: slot.slot, status: on ? 'ON' : 'OFF' }];
}

function describeSlot(slot: DiskSlot): string {
  const label = slot.enclosureLabel === null ? '' : ` ("${slot.enclosureLabel}")`;
  return `slot ${slot.slot} of enclosure "${slot.enclosureId}"${label}`;
}

function poolSentence(pool: string | null | undefined): string {
  if (pool === undefined) return 'the system did not report its pool membership';
  if (pool === null) return 'it is in no pool';
  return `it is a member of pool "${pool}"`;
}

function lightSentence(slot: DiskSlot, on: boolean): string {
  const target = on ? 'ON' : 'OFF';
  if (slot.light === null) {
    return 'The slot reported no locate state, so whether the light is on now was not read.';
  }
  if (slot.light === target) return `Its locate state already reads ${target}, which is not an error.`;
  return `Its locate state reads ${slot.light} now.`;
}

const IDENTIFY_GUIDANCE =
  '`enclosure_id` and `slot` are what the call was sent, found immediately before ' +
  'it by the slot whose device is `disk`. `requested` is `ON` or `OFF`. ' +
  '`previous_light` is the slot\'s `drive_bay_light_status` read immediately ' +
  'before the call, and `resulting_light` the same field read again immediately ' +
  'after it, finding the slot by enclosure id and slot number. Each is `ON`, ' +
  '`OFF`, or null where the slot reported no state: SOME SLOTS DO NOT REPORT ONE, ' +
  'and then NO STATE WAS READ AND NOTHING HERE SAYS THE LIGHT IS ON. Both are the ' +
  'kernel\'s `locate` setting for the slot, not an observation of the LED: ' +
  '`ON` means the system accepted that the light should be lit, not that anyone ' +
  'saw it. `confirmed` is true where `resulting_light` equals `requested`, false ' +
  'where it reads the other value, and null where no state was read — `confirmed: ' +
  'null` is a request that was accepted and not checked, never a lit light. ' +
  '`resulting_lookup` says what the read after the call did: `FOUND`; `NOT_FOUND`, ' +
  'where no enclosure listed that slot; or `UNREADABLE`, the read failing, with ' +
  '`resulting_read_error` naming why and null otherwise. A read after the call ' +
  'that failed is not a failed call: the call had already been made.';

export const diskIdentify: MutatingTool = {
  name: 'disk_identify',
  description:
    'Turns the locate (identify) light of the enclosure slot one disk sits in on ' +
    'or off, on this TrueNAS system, so the person at the rack pulls the right ' +
    'drive. Two-phase: called without a confirmation_token it returns a plan for ' +
    'user approval; called with one it sends the change. `disk` is the device ' +
    'name as `disks_list` reports it, and `on` is required: true lights the ' +
    'slot, false turns it off. A disk this system does not list fails the plan, ' +
    'naming it. The slot is the one `enclosure2.query` lists the disk\'s device ' +
    'in; A DISK NO ENCLOSURE SLOT LISTS FAILS THE PLAN, saying the system ' +
    'reports no managed enclosure slot for it — that is a system or a disk ' +
    'without a managed enclosure, and not something the caller did wrong. A ' +
    'disk listed in more than one slot fails ' +
    'too, and so does a slot that reports it does not support an identify ' +
    'light, which the middleware refuses. The plan names the disk\'s serial, ' +
    'model and pool membership beside the enclosure and slot, so the approver ' +
    'and the person at the rack agree on which disk it is. Whether the light ' +
    'actually lit can be read back only as far as the slot reports a locate ' +
    'state; the result never reports the light as on from the request alone. ' +
    'The `CLEAR` status and fault lights are not covered, and nothing here ' +
    'lists enclosures or empty slots. `destructiveness` is `reversible`: the ' +
    'reverse call turns the light back, and no data or configuration is ' +
    'touched. ' +
    IDENTIFY_GUIDANCE,
  resultGuidance: IDENTIFY_GUIDANCE,
  inputSchema: {
    type: 'object',
    properties: {
      disk: {
        type: 'string',
        description: 'The disk, as `disks_list` reports it in `name`, e.g. "sdb".',
      },
      on: {
        type: 'boolean',
        description: 'true turns the slot\'s locate light on; false turns it off.',
      },
    },
    required: ['disk', 'on'],
  },
  requiredRole: Role.Full,
  mutating: true,
  destructiveness: 'reversible',
  normalizeArgs(rawArgs) {
    const { disk, on } = parseIdentifyArgs(rawArgs);
    return { disk, on };
  },
  async plan(ctx, rawArgs): Promise<PlanStep[]> {
    const args = parseIdentifyArgs(rawArgs);
    const identified = await readIdentifiedDisk(ctx, args.disk);
    const slot = await findDiskSlot(ctx, args.disk);
    const refusal = identifyRefusal(args.disk, slot);
    if (refusal !== null) throw new Error(refusal);
    const support =
      slot.supportsIdentify === null
        ? ' Whether the slot supports an identify light could not be read, so the middleware may refuse the call.'
        : '';
    return [
      {
        method: 'enclosure2.query',
        params: [],
        description:
          `Read the enclosures, to find the slot whose device is "${args.disk}" — ${describeSlot(slot)} when this ` +
          'plan was made. Changes nothing. If no slot lists the disk when this runs, nothing is sent. This same read ' +
          'is made again immediately after the call, to report the locate state that resulted.',
      },
      {
        method: 'enclosure2.set_slot_status',
        params: setSlotParams(slot, args.on),
        description:
          `Turn the locate light of ${describeSlot(slot)} ${args.on ? 'ON' : 'OFF'}. That slot holds disk ` +
          `"${args.disk}", serial ${identified.serial ?? '(not reported)'}, model ` +
          `${identified.model ?? '(not reported)'}; ${poolSentence(identified.pool)}. ` +
          `${lightSentence(slot, args.on)}${support}`,
      },
    ];
  },
  async execute(ctx, rawArgs) {
    const args = parseIdentifyArgs(rawArgs);
    // Not caught: this read is what the call's params come from, so where it
    // fails there is nothing to send — a refusal, not a branch (#181).
    const slot = await findDiskSlot(ctx, args.disk);
    const refusal = identifyRefusal(args.disk, slot);
    if (refusal !== null) throw new Error(refusal);
    const requested = args.on ? 'ON' : 'OFF';
    await firstValueFrom(ctx.system.client.api.call('enclosure2.set_slot_status', setSlotParams(slot, args.on)));
    // The call has landed by here, so this read may not fail the tool.
    let lookup: 'FOUND' | 'NOT_FOUND' | 'UNREADABLE' = 'NOT_FOUND';
    let readError: string | null = null;
    let resultingLight: string | null = null;
    try {
      const enclosure = (await readEnclosures(ctx)).find((entry) => textOrNull(entry?.['id']) === slot.enclosureId);
      const element = enclosure == null ? undefined : slotElements(enclosure)?.find(
        ([key]) => slotNumber(key) === slot.slot,
      );
      if (element !== undefined) {
        lookup = 'FOUND';
        resultingLight = element[1] === null ? null : textOrNull(element[1]['drive_bay_light_status']);
      }
    } catch (reason) {
      lookup = 'UNREADABLE';
      readError = errorText(reason);
    }
    return {
      disk: args.disk,
      enclosure_id: slot.enclosureId,
      slot: slot.slot,
      requested,
      previous_light: slot.light,
      resulting_light: resultingLight,
      resulting_lookup: lookup,
      resulting_read_error: readError,
      confirmed: resultingLight === null ? null : resultingLight === requested,
    };
  },
};
