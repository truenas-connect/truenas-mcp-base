import { firstValueFrom } from 'rxjs';
import { Role } from '@/interfaces';
import { ReadOnlyTool, SystemHandle } from '@/catalog/tool';

/**
 * Grounds the LLM on what it is talking to — version, hostname, hardware —
 * before it reasons about anything else.
 */
export const systemInfo: ReadOnlyTool = {
  name: 'system_info',
  description:
    'Basic information about a TrueNAS system: hostname, version, uptime, ' +
    'hardware model, CPU and memory.',
  inputSchema: { type: 'object', properties: {} },
  requiredRole: Role.ReadOnly,
  mutating: false,
  async handler({ system }) {
    const info = await firstValueFrom(system.client.api.call('system.info'));
    return {
      hostname: info.hostname,
      version: info.version,
      uptime: info.uptime,
      model: info.model,
      cores: info.cores,
      physical_cores: info.physical_cores,
      memory_bytes: info.physmem,
      timezone: info.timezone,
    };
  },
};

/**
 * A string the system reported, or null where it reported anything else.
 *
 * An empty string is read as no value rather than as text of no characters: a
 * version of no characters names nothing a caller could act on, and passing it
 * through would put a field in the result that says nothing.
 *
 * `accounts.ts`, `shares.ts` and `block.ts` each hold the same reading under
 * their own names, and this restates rather than shares it for the reason
 * `shares.ts` gives for restating its own guards: a tool file is read on its
 * own.
 */
function textOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** What a failure carrying no text of its own is reported as. */
const NO_REASON = 'the system reported no reason';

/** What a system answering the check with no status at all is reported as. */
const NO_STATUS = 'the system reported no update status';

/**
 * Why the version read failed, in words.
 *
 * A rejection is not necessarily an `Error` — the client rejects with whatever
 * the transport gave it — so a bare string is read too, and so are the two
 * shapes the client documents as its own: a JSON-RPC error object carrying
 * `message`, and a middleware error object carrying `reason`. Anything else
 * still becomes a stated absence rather than `"[object Object]"`, and the
 * result is never empty: a failure with no text still has to read as a failure.
 * The same reading as `accounts.ts` holds of a failed configuration read.
 */
function errorText(reason: unknown): string {
  if (reason instanceof Error) return textOrNull(reason.message) ?? NO_REASON;
  if (typeof reason === 'object' && reason !== null) {
    const carrier = reason as Record<string, unknown>;
    return textOrNull(carrier['reason']) ?? textOrNull(carrier['message']) ?? NO_REASON;
  }
  return textOrNull(reason) ?? NO_REASON;
}

/** The running version, or the failure that stopped it being read. */
interface VersionAttempt {
  value: string | null;
  error: string | null;
}

/**
 * The version the system is running now, with a failure named rather than
 * thrown.
 *
 * `update.status` reports the train and profile the system updates along and
 * the version it could move to, but never the version it is on — its
 * `current_version` names the train, the profile and whether the two agree, and
 * nothing else. So the running version is a second read, and it is reported
 * rather than fatal for the reason `accounts.ts` gives for its configuration
 * read: the question the tool is asked — is an update available, and which — is
 * answered by `update.status` on its own, and losing the version it is moving
 * from must not lose the answer as well.
 */
async function readVersion(system: SystemHandle): Promise<VersionAttempt> {
  try {
    const version = await firstValueFrom(system.client.api.call('system.version'));
    return { value: textOrNull(version), error: null };
  } catch (reason) {
    return { value: null, error: errorText(reason) };
  }
}

/**
 * The `update.status` payload, read through one seam so that its type is taken
 * from the client by inference rather than restated here — the generated types
 * suffix duplicate names, and a hand-written copy of one is a copy that can
 * drift.
 *
 * `code` is the system's own verdict on whether the check itself worked —
 * `NORMAL` or `ERROR` — and `status` carries the answer where it did.
 */
function readStatus(system: SystemHandle) {
  return firstValueFrom(system.client.api.call('update.status'));
}

/** What {@link readStatus} answers with. */
type UpdateReport = Awaited<ReturnType<typeof readStatus>>;

/**
 * Why the check could not answer, in words. Only ever called where it did not.
 *
 * The system's own error is preferred, then its error name — a reason a person
 * can read before a symbol only a machine can — and a check that failed while
 * saying nothing still has to read as one that failed. A system that reported
 * `NORMAL` and then sent no status is a third case: nothing went wrong that it
 * admits to, and there is still no answer in the payload.
 */
function checkFailure(report: UpdateReport): string {
  const error = report.error;
  if (error !== null) return textOrNull(error.reason) ?? textOrNull(error.errname) ?? NO_REASON;
  return report.code === 'ERROR' ? NO_REASON : NO_STATUS;
}

/**
 * Whether a TrueNAS update is available, and which.
 *
 * The distinction the tool exists to keep is between a system that is up to
 * date and one that could not be asked. Both have no update to report, and
 * across a fleet they are opposite answers: the first needs nothing, the second
 * has not been checked at all and may have been unchecked for months. So
 * `update_available` is a three-valued answer — false, true, or null for "not
 * established" — rather than a boolean that quietly reads an unreachable update
 * server as good news.
 */
export const updateStatus: ReadOnlyTool = {
  name: 'system_update_status',
  description:
    'Whether a TrueNAS update is available for this system, and which. ' +
    '`update_available` is true when the system has an update it could move ' +
    'to, false when it is already up to date, and NULL WHEN THE CHECK COULD ' +
    'NOT BE COMPLETED — a system that is air-gapped, that cannot reach the ' +
    'update server, or that reported no status at all. Null is not "no update ' +
    'available": nothing has been established about that system, and it may ' +
    'have been unchecked for a long time. `check_error` is what the system ' +
    'said about that failure and is null whenever `update_available` is true ' +
    'or false. `new_version` is the version the system would move to, and is ' +
    'null unless `update_available` is true. `train` is the update train the ' +
    'system follows — the channel its updates come from. `new_version` and ' +
    '`train` ARE BOTH NULL WHILE `update_available` IS NULL, because they come ' +
    'from the status the check did not produce, not because the system has no ' +
    'train. `current_version` is the version the system is running now and ' +
    'comes from a SEPARATE read, so it is unaffected by a failed check and is ' +
    'reported even where `update_available` is null. `version_error` names ' +
    'what the system said when that read failed, and `current_version` is null ' +
    'while it is non-null; `current_version` null with `version_error` null is ' +
    'a system that answered the read with no version. This tool only checks. ' +
    'It does not download, apply or schedule an update, and it does not reboot ' +
    'anything. Applications are updated separately and are not reported here — ' +
    'that is `apps_list`.',
  inputSchema: { type: 'object', properties: {} },
  requiredRole: Role.ReadOnly,
  mutating: false,
  async handler({ system }) {
    // Both reads are issued before either is awaited, so neither waits on the
    // other. Only the status read may fail the tool, for the reason
    // `readVersion` gives.
    const [report, version] = await Promise.all([readStatus(system), readVersion(system)]);

    // The check has an answer only where the system said the check itself
    // worked AND sent a status to read. A payload that reports `ERROR` and a
    // status together is not read as an answer: the system has said its own
    // check did not complete, and a stale or partial status behind that is
    // exactly what must not be reported as "up to date".
    const status = report.code === 'NORMAL' ? report.status : null;
    const candidate = status?.new_version ?? null;
    return {
      update_available: status === null ? null : candidate !== null,
      current_version: version.value,
      new_version: candidate === null ? null : textOrNull(candidate.version),
      train: status === null ? null : textOrNull(status.current_version.train),
      check_error: status === null ? checkFailure(report) : null,
      version_error: version.error,
    };
  },
};
