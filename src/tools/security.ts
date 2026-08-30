import { firstValueFrom } from 'rxjs';
import { Role } from '@/interfaces';
import { ReadOnlyTool, SystemHandle } from '@/catalog/tool';
import { booleanOrNull, errorText, numberOrNull, recordOrNull, textOrNull } from '@/tools/common';

/**
 * The security posture SETTINGS of a system: FIPS and STIG mode, the password
 * policy, and whether two-factor authentication is switched on.
 *
 * `fleet_compliance_report` is asked about compliance and reports auditing,
 * certificates, directory services, shares and updates — not the settings an
 * auditor asks about first, because until this tool nothing in the catalog read
 * them. This is the settings half only. Folding it into that composite is a
 * separate deliverable and is not done here.
 *
 * THIS TOOL STATES NO VERDICT, per the #47 decision in `CLAUDE.md`. "Secure" is
 * a claim against a standard that lives outside this repository — a framework,
 * a policy, a customer's contract — and nobody has told this tool which one. It
 * reports the settings and names what it could not read; any pass/fail reading
 * of them is the caller's.
 *
 * The two calls are SEPARATE READS on unrelated middleware namespaces
 * (`system.security` and `auth.twofactor`) and either can fail on its own, so
 * each is a section carrying its own `unavailable` — the same shape `boot.ts`
 * uses, and for the same reason: half an answer about a system's posture is
 * worth more than an error. Nothing here mutates; `system.security.update` and
 * `auth.twofactor.update` both exist on the middleware and neither is in this
 * catalog.
 */

/** What a system answering `system.security.config` with something else is reported as. */
const NOT_A_SECURITY_CONFIG = 'the system did not answer with a security configuration';

/** What a system answering `auth.twofactor.config` with something else is reported as. */
const NOT_A_TWO_FACTOR_CONFIG = 'the system did not answer with a two-factor configuration';

/** The security settings as this tool reports them. */
interface SecuritySettings {
  fips_enabled: boolean | null;
  stig_enabled: boolean | null;
  min_password_age: number | null;
  max_password_age: number | null;
  min_password_length: number | null;
  password_history_length: number | null;
  password_complexity_ruleset: string[] | null;
}

/** One service the two-factor configuration named, and what it said about it. */
interface TwoFactorService {
  service: string;
  enabled: boolean | null;
}

/** The two-factor settings as this tool reports them. */
interface TwoFactorSettings {
  enabled: boolean | null;
  services: TwoFactorService[] | null;
  window: number | null;
}

/**
 * One section read, or the reason it could not be — the per-family attempt pair
 * `boot.ts`, `system.ts` and `fleet.ts` each keep, generic over this family's
 * own two payloads and no further. It stays in this file for the reason
 * `CLAUDE.md` records: what those files share is the shape, not the function,
 * and generalising over the failure type would couple every family to one
 * signature for no gain.
 */
interface Attempt<T> {
  value: T | null;
  error: string | null;
}

/**
 * The character classes the password policy requires, as names — or null where
 * the system listed something this tool cannot read as one.
 *
 * All-or-nothing rather than per-entry, which is why `textList` from
 * `common.ts` is not the guard here: that one drops an entry it cannot read,
 * and a ruleset one class shorter says the policy requires LESS than it does.
 * That is the #93 decision applied — a list that drops towards a claim must be
 * nulled, and "this system does not require special characters" is a claim a
 * dropped entry would make on no evidence. An EMPTY list is kept and is a
 * different answer: the system reported the ruleset and it names no classes.
 */
function complexityRuleset(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const classes: string[] = [];
  for (const entry of value) {
    const name = textOrNull(entry);
    if (name === null) return null;
    classes.push(name);
  }
  return classes;
}

/**
 * The services the two-factor configuration named, with what it said about
 * each — or null where the system sent no service configuration this tool could
 * read.
 *
 * Read from the payload's own keys rather than from the one field the client
 * declares, the same way `audit_config` reads `enabled_services`: a service a
 * later TrueNAS release begins covering is then answerable without a change
 * here, because these are values rather than fields and the allowlist this file
 * keeps is over the fields of the result.
 *
 * An entry whose value is not a boolean is KEPT, with `enabled` null, rather
 * than dropped. That is the other half of #93: keeping it asserts nothing —
 * the service was named and nothing was established about it — while dropping
 * it would say the system does not cover that service at all.
 *
 * A key that is not a name nulls the whole list, on the all-or-nothing reading
 * `audit_config`'s `configuredServices` takes and for the same reason: a
 * service that cannot be named cannot be reported, and a list quietly one
 * service shorter reads as a service two-factor does not cover.
 *
 * Sorted by name, because the middleware sends a keyed object and the order of
 * its keys means nothing; leaving it alone would make the result differ between
 * two reads of the same unchanged configuration.
 */
function twoFactorServices(value: unknown): TwoFactorService[] | null {
  const services = recordOrNull(value);
  if (services === null) return null;
  const names = Object.keys(services);
  if (names.some((name) => name.length === 0)) return null;
  return names.sort().map((service) => ({ service, enabled: booleanOrNull(services[service]) }));
}

/**
 * The security settings, with a failure named rather than thrown.
 *
 * `enable_fips` and `enable_gpos_stig` are declared required booleans and are
 * still read through `booleanOrNull`: a declared type is a claim about what the
 * middleware sends and not the value received, which is the #91 decision, and
 * on this subject a wrong `false` is the expensive direction — it reads as "FIPS
 * is off" rather than as "nothing was established".
 *
 * Every password-policy field is optional AND nullable in the payload, so it
 * arrives in three states: a value, an explicit null, and no key at all on a
 * version that does not report it. The last two collapse to null here, and that
 * is deliberate — both say the system stated no value, which is one answer to a
 * caller, and the distinction that matters is against a value of ZERO. A
 * `min_password_length` of null is not a minimum length of zero, and the
 * description says so per field.
 *
 * `id` is read by nothing and is deliberately absent from the result: it is a
 * middleware row id and means nothing outside the middleware.
 */
async function readSecurity(system: SystemHandle): Promise<Attempt<SecuritySettings>> {
  try {
    const answer = await firstValueFrom(system.client.api.call('system.security.config'));
    // Read through `recordOrNull` rather than reached into, for the reason
    // `audit_config` gives: a system answering the call with something that is
    // not a configuration would otherwise throw naming a property, and the
    // caller would see the name of a field rather than the read that failed.
    const settings = recordOrNull(answer);
    if (settings === null) return { value: null, error: NOT_A_SECURITY_CONFIG };
    return {
      value: {
        // Renamed off the imperative the middleware spells them with:
        // `enable_fips` reads as an instruction to turn FIPS on, and this is a
        // report of whether it is on.
        fips_enabled: booleanOrNull(settings['enable_fips']),
        stig_enabled: booleanOrNull(settings['enable_gpos_stig']),
        // These keep the middleware's own names, unit and all — which is to say
        // without one. The pinned surface declares them bare numbers and states
        // no unit, so a `_days` or `_seconds` suffix here would be this tool
        // asserting something it never read. See the decision in `CLAUDE.md`.
        min_password_age: numberOrNull(settings['min_password_age']),
        max_password_age: numberOrNull(settings['max_password_age']),
        min_password_length: numberOrNull(settings['min_password_length']),
        password_history_length: numberOrNull(settings['password_history_length']),
        password_complexity_ruleset: complexityRuleset(settings['password_complexity_ruleset']),
      },
      error: null,
    };
  } catch (reason) {
    return { value: null, error: errorText(reason) };
  }
}

/**
 * The two-factor settings, with a failure named rather than thrown.
 *
 * `window` keeps the middleware's own name and carries no unit, for the reason
 * given above: the pinned surface declares it a bare number and documents no
 * unit for it, so it is passed through as the number the system reported.
 * (unconfirmed) It is the validity window of a one-time password, read off the
 * field's name and its place in the two-factor configuration rather than off
 * anything the surface states.
 *
 * `id` is dropped here too, on the same terms as in {@link readSecurity}.
 */
async function readTwoFactor(system: SystemHandle): Promise<Attempt<TwoFactorSettings>> {
  try {
    const answer = await firstValueFrom(system.client.api.call('auth.twofactor.config'));
    const settings = recordOrNull(answer);
    if (settings === null) return { value: null, error: NOT_A_TWO_FACTOR_CONFIG };
    return {
      value: {
        enabled: booleanOrNull(settings['enabled']),
        services: twoFactorServices(settings['services']),
        window: numberOrNull(settings['window']),
      },
      error: null,
    };
  } catch (reason) {
    return { value: null, error: errorText(reason) };
  }
}

/**
 * The `security` section's fields on a read that did not happen.
 *
 * Spelled out rather than left off, because `undefined` serializes to no key at
 * all: a caller would receive an object missing fields the description promises
 * — a shape it has not been told about — rather than nulls it can see are
 * absent.
 */
const UNREAD_SECURITY: SecuritySettings = {
  fips_enabled: null,
  stig_enabled: null,
  min_password_age: null,
  max_password_age: null,
  min_password_length: null,
  password_history_length: null,
  password_complexity_ruleset: null,
};

/** The `two_factor` section's fields on a read that did not happen. */
const UNREAD_TWO_FACTOR: TwoFactorSettings = {
  enabled: null,
  services: null,
  window: null,
};

export const securityConfig: ReadOnlyTool = {
  name: 'security_config',
  description:
    'The security posture SETTINGS of a TrueNAS system: FIPS mode, STIG mode, ' +
    'the password policy, and whether two-factor authentication is switched ' +
    'on. THIS TOOL STATES NO VERDICT and has no compliant, secure or pass/fail ' +
    'field of any kind. "Secure" and "compliant" are claims against a standard ' +
    'that lives outside this system — a framework, a policy, a contract — and ' +
    'nothing has told this tool which one, so it reports the settings and names ' +
    'what it could not read. Any pass/fail reading of them is yours, and must ' +
    'be stated as being against a named standard. `fleet_compliance_report` ' +
    'does not read any of these settings; it reports auditing, certificates, ' +
    'directory services, shares and updates, so a clean answer from it says ' +
    'NOTHING about anything below. ' +
    'The result has TWO SECTIONS, `security` and `two_factor`, which come from ' +
    'SEPARATE READS ON UNRELATED PARTS OF THE MIDDLEWARE AND CAN FAIL ' +
    'INDEPENDENTLY. Each carries `unavailable`: null where that section was ' +
    'read, and otherwise what the system said about the failure — and then ' +
    'EVERY OTHER FIELD IN THAT SECTION IS NULL BECAUSE IT WAS NOT READ, not ' +
    'because the system reported nothing. A failure in one section never ' +
    'empties or falsifies the other. ' +
    'In `security`: `fips_enabled` is whether the system runs in FIPS 140 ' +
    'validated-cryptography mode. `stig_enabled` is whether it runs in STIG ' +
    'mode — the General Purpose Operating System Security Technical ' +
    'Implementation Guide hardening profile, which the middleware spells ' +
    '`enable_gpos_stig`; it is a hardening mode and NOT a statement that the ' +
    'system passes a STIG assessment. Each is true, false, or NULL WHERE THE ' +
    'SYSTEM REPORTED NO VALUE THIS TOOL COULD READ — and a null is neither ' +
    'answer, so a null must never be read as the mode being off. ' +
    'THE PASSWORD POLICY FIELDS ARE THE ONES MOST EASILY MISREAD. ' +
    '`min_password_length` is the shortest password the system accepts, ' +
    '`password_history_length` is how many previous passwords it refuses to let ' +
    'a user reuse, and `min_password_age` and `max_password_age` are how long a ' +
    'password must be kept before it may be changed and how long it may be kept ' +
    'before it must be. EACH IS NULL WHERE THE SYSTEM STATED NO VALUE FOR IT, ' +
    'which covers both a system that reported the field as unset and a TrueNAS ' +
    'version that does not report the field at all — those are one answer here, ' +
    'and that answer is "this was not established". A NULL IS NEVER A ZERO AND ' +
    'IS NEVER "NO POLICY". A null `min_password_length` does NOT mean passwords ' +
    'of any length are accepted, a null `password_history_length` does NOT mean ' +
    'reuse is allowed, and a null `max_password_age` does NOT mean passwords ' +
    'never expire. Reporting any of those as a finding on a null is reporting a ' +
    'finding that has not been established; say the setting was not reported ' +
    'instead. A ZERO, where one is reported, IS a value the system stated and ' +
    'is to be read as itself. NO UNIT IS REPORTED FOR ANY OF THESE NUMBERS: ' +
    'the API this tool reads declares `min_password_age` and `max_password_age` ' +
    'as bare numbers and states no unit for them, so this tool states none ' +
    'either — do not assume days, and do not convert them. ' +
    '`password_complexity_ruleset` is the character classes a password must ' +
    'draw from, as the system names them; `UPPER`, `LOWER`, `NUMBER` and ' +
    '`SPECIAL` are the declared values and THE SET IS NOT CLOSED, so any other ' +
    'value is passed through as the system spelled it. An EMPTY list is a real ' +
    'answer — the system reported the ruleset and it names no classes — while ' +
    'NULL means no ruleset this tool could read was reported, and null is never ' +
    'to be read as the empty one. The list is nulled WHOLE rather than shortened ' +
    'if any entry cannot be read, so a ruleset that is reported is complete. ' +
    'In `two_factor`: `enabled` is whether two-factor authentication is ' +
    'switched on at all — true, false, or null where the system reported no ' +
    'value this tool could read, and a null is not a false. `services` is one ' +
    'entry per service the two-factor configuration named, sorted by name, with ' +
    '`service` as the system spelled it and `enabled` true, false, or null ' +
    'where the system said nothing this tool could read about that service. ' +
    'THE ONLY SERVICE THIS PAYLOAD CAN REPORT IS SSH: the API surface this tool ' +
    'is pinned to declares exactly one service field, `ssh`, so a name a later ' +
    'TrueNAS release adds is passed through if it arrives but nothing here can ' +
    'be relied on to name it. THAT MAKES ABSENCE UNINFORMATIVE — this tool ' +
    'CANNOT tell you whether two-factor applies to the web UI, the API, or ' +
    'anything else that is not SSH, and a service not appearing here is not ' +
    'evidence that two-factor does not cover it. `services` is null where the ' +
    'system reported no service configuration this tool could read; an EMPTY ' +
    'list, or a list whose entries are all false, is the different and stronger ' +
    'answer that two-factor covers NOTHING THIS PAYLOAD NAMES. `enabled` true ' +
    'with such a list is two-factor switched on and applied to nothing it can ' +
    'name, which is a real state and is worth reporting as itself rather than ' +
    'as "two-factor is on". `window` is (unconfirmed) the validity window of a ' +
    'one-time password, passed through as the number the system gave; THE API ' +
    'DECLARES NO UNIT FOR IT and neither does this tool, so do not render it as ' +
    'seconds, minutes or steps. It is null where the system reported no number ' +
    'this tool could read. ' +
    'EVERYTHING HERE IS SYSTEM-WIDE SETTINGS AND NOTHING HERE IS PER-ACCOUNT. ' +
    'Whether an individual account has two-factor set up, and what any account ' +
    'is permitted to do, are reported by NO TOOL IN THIS CATALOG — `users_list` ' +
    'returns no two-factor state and says outright that it does not report what ' +
    'an account is permitted to do, so do not send a caller there for either. ' +
    'Whether the hardware is CAPABLE of FIPS, ' +
    'as opposed to whether it is on, is not reported. This tool only reports. ' +
    'It does not enable or disable FIPS or STIG mode, change any password ' +
    'policy setting, or turn two-factor authentication on or off — those are ' +
    '`system.security.update` and `auth.twofactor.update`, and neither is in ' +
    'this catalog.',
  inputSchema: { type: 'object', properties: {} },
  requiredRole: Role.ReadOnly,
  mutating: false,
  async handler({ system }) {
    // Both reads are issued before either is awaited, so neither waits on the
    // other, and neither can fail the tool: "is this box hardened" and "is
    // two-factor on" are separately useful answers, and losing one must not
    // lose the other.
    const [security, twoFactor] = await Promise.all([
      readSecurity(system),
      readTwoFactor(system),
    ]);
    return {
      security: { unavailable: security.error, ...(security.value ?? UNREAD_SECURITY) },
      two_factor: { unavailable: twoFactor.error, ...(twoFactor.value ?? UNREAD_TWO_FACTOR) },
    };
  },
};
