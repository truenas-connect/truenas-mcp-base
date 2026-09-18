import type { CallParams, JobParams } from '@truenas/api-client';
import {
  catchError,
  EMPTY,
  firstValueFrom,
  lastValueFrom,
  Observable,
  switchMap,
  takeUntil,
  tap,
  throwError,
  timer,
} from 'rxjs';
import { Role } from '@/interfaces';
import {
  ApiSurface,
  MutatingTool,
  PlanStep,
  ReadOnlyTool,
  SystemHandle,
  ToolContext,
} from '@/catalog/tool';
import {
  booleanOrNull,
  errorText,
  isoOrNull,
  jobMillis,
  numberOrNull,
  recordOrNull,
  textOrNull,
} from '@/tools/common';

/**
 * Virtual machines a system runs, with the state each is in and the CPU and
 * memory it has been given.
 *
 * `apps_list` covers half of what runs on a modern TrueNAS. This is the other
 * half, and without it an assistant asked what a system is doing answers from
 * the apps alone and reports an incomplete picture as a complete one.
 *
 * TWO STACKS, BOTH PRESENT ON THE VERSION THE CLIENT IS TYPED AGAINST. TrueNAS
 * carries the older libvirt-backed VMs under `vm.*` and the newer
 * incus-backed instances under `virt.*`, and both `vm.query` and
 * `virt.instance.query` are in the pinned client's call directory for the
 * default (oldest supported) API surface. Which one a given system's VMs
 * actually live in is a per-system fact this cannot know in advance, so both
 * are read and every row says which stack it came from. Reading one alone
 * would answer "no virtual machines" on a system whose VMs are all in the
 * other, which is the failure this tool exists to prevent.
 *
 * `virt.instance.query` also returns containers. They are filtered out: this
 * tool is about virtual machines, and an incus container is closer to what
 * `apps_list` already reports than to a VM.
 *
 * The mapping is an allowlist rather than a trim, as in `apps.ts` and
 * `disks.ts`. Size is the reason here rather than secrecy: a `virt.instance`
 * row carries the whole `raw` incus configuration, its `environment` map, its
 * image metadata and its aliases, and a `vm.query` row carries every device
 * attached to the VM. Naming the output fields is what keeps all of that out of
 * the tool result, and what stops a field a later TrueNAS release adds
 * appearing without a change to this file.
 */

/** Which of the two stacks a row was read from. */
type VmSource = 'vm' | 'virt_instance';

/**
 * `recordOrNull` from `common.ts` is what stops a reported-as-null `status`
 * being indexed, and its exclusion of arrays matters here: the one thing read
 * through it is a VM's status record, and reading a list as one would answer
 * null for every field rather than saying the shape was not what this tool
 * reads.
 */

/** A read that did not complete, named by the stack it was against. */
interface VmFailure {
  source: VmSource;
  error: string;
}

/** A read that produced rows, or the failure that stopped it. */
interface Attempt<T> {
  value: T | null;
  failure: VmFailure | null;
}

/**
 * One stack's read, with a failure caught and named rather than thrown.
 *
 * The read is passed as a thunk so that the call is made inside the `try`, which
 * keeps this correct for a read that throws before it returns a promise at all.
 *
 * NEITHER READ IS ALLOWED TO FAIL THE TOOL, which is the difference from
 * `block.ts`, where the subsystems read is primary and a denied read is raised.
 * Here there is no primary: a system may legitimately have only one of the two
 * stacks, so a stack that could not be read is reported as a failure beside
 * whatever the other stack answered rather than losing that answer too.
 */
async function attempt<T>(source: VmSource, read: () => Promise<T>): Promise<Attempt<T>> {
  try {
    return { value: await read(), failure: null };
  } catch (reason) {
    return { value: null, failure: { source, error: errorText(reason) } };
  }
}

/** MiB to bytes, the one unit conversion this file makes. */
const BYTES_PER_MIB = 1024 * 1024;

/**
 * The row each stack answers with, taken from the API surface the tools are
 * typed against rather than named or restated here.
 *
 * Derived rather than declared so that the field names below are checked
 * against the generated client. Reading a row as a bare `Record<string,
 * unknown>` would compile whatever it was asked for, so a regenerated client
 * that renames a field — which is how these types have moved before — would
 * turn every value read under the old name into a null, with no build error
 * and with tests that pass because their fixtures are written by hand against
 * the same old names.
 *
 * The values are still read through the guards below rather than trusted. The
 * types describe what the middleware is documented to send, and a tool that
 * throws because a system sent something else is worse than one that reports
 * the field it could not read.
 */
type VmEntry = ApiSurface['call']['vm.query']['entity'];
type VirtInstanceEntry = ApiSurface['call']['virt.instance.query']['entity'];

/** One virtual machine, in the shape this tool reports it, whichever stack it
 * was read from. */
interface VmRow {
  source: VmSource;
  id: string | number | null;
  name: string | null;
  state: string | null;
  domain_state: string | null;
  vcpus: number | null;
  cpu_set: string | null;
  memory_bytes: number | null;
  min_memory_bytes: number | null;
  autostart: boolean | null;
}

/**
 * The total number of virtual CPUs a libvirt-backed VM has been given.
 *
 * TrueNAS stores the allocation as three numbers and the VM sees their product:
 * `vcpus` virtual sockets, each of `cores` cores, each of `threads` threads.
 * Reporting `vcpus` alone would understate a VM configured 1 × 2 × 2 by a
 * factor of four, and that field's name makes the understatement look like the
 * answer, so the product is what is reported.
 *
 * All three have to be readable numbers. A missing component is not treated as
 * one: a defaulted-to-1 guess is indistinguishable in the result from a value
 * the system actually reported, and a null says plainly that the count could
 * not be stated.
 */
function totalVcpus(sockets: unknown, cores: unknown, threads: unknown): number | null {
  const values = [numberOrNull(sockets), numberOrNull(cores), numberOrNull(threads)];
  if (values.some((value) => value === null)) return null;
  return (values as number[]).reduce((product, value) => product * value, 1);
}

/**
 * A libvirt-backed VM as `vm.query` reports it.
 *
 * `memory` and `min_memory` are MiB on this stack and bytes on the other, which
 * is the one place the two disagree about what a number means. Both are
 * reported here in bytes so that a caller comparing two VMs is comparing the
 * same quantity. THE MiB READING IS TrueNAS'S DOCUMENTED UNIT FOR THIS FIELD
 * AND IS NOT CARRIED BY THE PINNED CLIENT'S TYPES, which describe it as a bare
 * `number`; it is unconfirmed against a live middleware.
 *
 * `min_memory` is the floor of a memory range: where it is set the VM is
 * guaranteed that much and may be given up to `memory`, so reporting the
 * maximum alone would overstate what the VM is actually holding.
 */
function fromVmStack(entry: VmEntry): VmRow {
  // The type declares `status` present and non-null; a system that reported
  // neither must answer null states rather than throw. Read back as a partial
  // of its own type so that the two names below are checked too.
  const status = (recordOrNull(entry.status) ?? {}) as Partial<VmEntry['status']>;
  const memory = numberOrNull(entry.memory);
  const minMemory = numberOrNull(entry.min_memory);
  return {
    source: 'vm',
    id: numberOrNull(entry.id),
    name: textOrNull(entry.name),
    // The middleware's own word for the state. `domain_state` beside it is
    // libvirt's, and the two are reported separately rather than merged
    // because they are different vocabularies and a caller cannot tell which
    // one arrived once they share a field.
    state: textOrNull(status.state),
    domain_state: textOrNull(status.domain_state),
    vcpus: totalVcpus(entry.vcpus, entry.cores, entry.threads),
    // This stack has a `cpuset` of its own, and it is deliberately not
    // reported here: on this stack pinning is a separate fact from the vCPU
    // count, which `vcpus` above always states, whereas `cpu_set` exists to
    // say that a count could not be stated BECAUSE a set was given instead.
    // Filling it from `cpuset` would make the column mean two things. Which
    // host CPUs a VM is pinned to is a question this tool does not answer.
    cpu_set: null,
    memory_bytes: memory === null ? null : memory * BYTES_PER_MIB,
    min_memory_bytes: minMemory === null ? null : minMemory * BYTES_PER_MIB,
    autostart: booleanOrNull(entry.autostart),
  };
}

/**
 * An incus-backed VM as `virt.instance.query` reports it.
 *
 * `cpu` is a single string covering two different facts: a plain count
 * (`"4"`), or a set of host CPUs the instance is pinned to (`"0-3"`, `"1,3"`).
 * Only the first is a vCPU count, so only the first fills `vcpus`; a set is
 * reported verbatim as `cpu_set` and leaves `vcpus` null rather than having its
 * members counted here, because that count is an inference about how the host
 * expands the range and not something the system said.
 *
 * `memory` is already bytes on this stack and is passed through. There is no
 * memory floor in this record, so `min_memory_bytes` is null — which is the
 * absence of a range rather than an unreadable one, and the description says so.
 */
function fromVirtStack(entry: VirtInstanceEntry): VmRow {
  const cpu = textOrNull(entry.cpu);
  const plainCount = cpu !== null && /^\d+$/.test(cpu) ? Number(cpu) : null;
  return {
    source: 'virt_instance',
    id: textOrNull(entry.id),
    name: textOrNull(entry.name),
    state: textOrNull(entry.status),
    // libvirt's domain state has no counterpart on this stack; `status` above
    // already distinguishes ERROR from STOPPED on its own.
    domain_state: null,
    vcpus: plainCount,
    cpu_set: plainCount === null ? cpu : null,
    memory_bytes: numberOrNull(entry.memory),
    min_memory_bytes: null,
    autostart: booleanOrNull(entry.autostart),
  };
}

export const vmsList: ReadOnlyTool = {
  name: 'vms_list',
  description:
    'Virtual machines configured on a TrueNAS system, with the state each is ' +
    'in and the CPU and memory it has been given. TrueNAS runs VMs under two ' +
    'stacks and both are read: `source` is `vm` for the older libvirt-backed ' +
    'VMs and `virt_instance` for the newer incus-backed instances. A system ' +
    'normally uses one or the other, and `vm` entries are listed before ' +
    '`virt_instance` ones. `id` is the identifier that stack uses — a number ' +
    'on `vm`, a string on `virt_instance` — and is null where the system ' +
    'reported none; it is unique only within its own `source`, so two entries ' +
    'may share a `name` or an `id` while being different machines. `state` is ' +
    "the state word the system itself used: on `virt_instance` one of " +
    '`RUNNING`, `STOPPED`, `STARTING`, `STOPPING`, `FROZEN`, `FREEZING`, ' +
    '`THAWED`, `ABORTING`, `ERROR` or `UNKNOWN`, so A STOPPED VM AND A FAILED ' +
    'ONE ARE DIFFERENT WORDS THERE. On `vm` the vocabulary is the ' +
    "middleware's own and is narrower — a VM that is not running commonly " +
    'reads `STOPPED` whether it was shut down or died — and `domain_state` is ' +
    "beside it carrying libvirt's own state for the same machine, where " +
    '`CRASHED` or `SHUTOFF` is what separates the two cases. `domain_state` is ' +
    'null on `virt_instance`, which has no such second state, and null on `vm` ' +
    'where the system reported none. NEITHER STATE IS TRANSLATED OR COMPARED ' +
    'ACROSS THE TWO STACKS: the words come from different systems and this ' +
    'tool reports them as they arrived. `vcpus` is the total number of virtual ' +
    'CPUs allocated. On `vm` that is the product of the virtual sockets, cores ' +
    'and threads TrueNAS stores separately, which is what the guest sees, and ' +
    'is null where the system did not report all three. On `virt_instance` it ' +
    'is the CPU allocation where that is a plain count, and NULL WHERE THE ' +
    'INSTANCE IS PINNED TO A SET OF HOST CPUS INSTEAD — `cpu_set` then carries ' +
    'that set verbatim, as the system spelled it (`0-3`, `1,3`), and the ' +
    'number of CPUs it comes to is not counted here. `cpu_set` is null on `vm` ' +
    'and null wherever `vcpus` is a count. `memory_bytes` is the memory the VM ' +
    'is allocated, IN BYTES ON BOTH STACKS: the `vm` stack stores this figure ' +
    'in MiB and it is converted here, so the two are directly comparable. ' +
    '`min_memory_bytes` is the floor of a memory range where one is set — the ' +
    'VM is guaranteed that much and may be given up to `memory_bytes` — and is ' +
    'null on `virt_instance`, which has no such floor, and null on a `vm` ' +
    'entry with no range set, where `memory_bytes` is simply what the VM has. ' +
    'Every one of these fields is null where the system reported no value this ' +
    'tool could read, which is never the same as a VM configured with none. ' +
    '`autostart` is whether the VM starts with the system. AN EMPTY `vms` ' +
    'LIST WITH AN EMPTY `failures` LIST IS A SYSTEM WITH NO VIRTUAL MACHINES ' +
    'CONFIGURED IN EITHER STACK. `failures` names each stack that could not be ' +
    'read at all, as `source` and the `error` the system gave, and WHILE IT IS ' +
    'NOT EMPTY THE LIST IS INCOMPLETE — a system whose VMs all live in the ' +
    'stack that failed reports no VMs and a failure, which is not a system ' +
    'without any. A stack that is simply absent from a given TrueNAS release ' +
    'appears here as a failure for that reason. This tool reports only virtual ' +
    'machines: incus containers are excluded and applications are ' +
    "`apps_list`. A VM's log output is `vm_logs`, which reads one machine on " +
    'the `vm` stack. This does not report a VM\'s disks, network interfaces, ' +
    'display or passthrough devices, which are `vm_devices` and are likewise ' +
    'only reported for the `vm` stack, and it does not create, start, stop or ' +
    'change one. NO field beyond those named here ' +
    'is returned, whatever a later TrueNAS release adds to either record.',
  inputSchema: { type: 'object', properties: {} },
  requiredRole: Role.ReadOnly,
  mutating: false,
  async handler({ system }) {
    // Both reads are issued before either is awaited, so neither waits on the
    // other, and each is caught: see `attempt` for why neither may fail the
    // tool.
    const [vms, instances] = await Promise.all([
      attempt('vm', () => firstValueFrom(system.client.api.query('vm.query'))),
      attempt('virt_instance', () =>
        firstValueFrom(
          // The filter is inlined so the call's own parameter types apply:
          // written to a `const` first it widens and no longer satisfies the
          // filter tuple, as in `storage.ts`.
          system.client.api.query('virt.instance.query', [['type', '=', 'VM']]),
        ),
      ),
    ]);

    const failures: VmFailure[] = [];
    if (vms.failure !== null) failures.push(vms.failure);
    if (instances.failure !== null) failures.push(instances.failure);

    return {
      vms: [
        ...(vms.value ?? []).map(fromVmStack),
        // The `type` filter above is asked of the middleware; this re-checks
        // it on what came back. A query parameter a release does not
        // recognise is dropped rather than refused, and the result of that is
        // containers in a list of virtual machines — indistinguishable from a
        // filter that matched everything.
        ...(instances.value ?? []).filter((instance) => instance.type === 'VM').map(fromVirtStack),
      ],
      failures,
    };
  },
};

/**
 * The recent log output of one libvirt-backed virtual machine.
 *
 * "The VM will not boot" is unanswerable without its log, and the log is the
 * one thing `vms_list` deliberately does not carry.
 *
 * ONE STACK, NOT TWO. `vms_list` reads both of the stacks TrueNAS runs VMs
 * under; this reads only the older libvirt-backed one. `vm.log_file_path` is
 * the only endpoint on the API surface that names a VM's log and there is no
 * counterpart under `virt.*`, so an incus-backed instance has no retrievable
 * log here at all. A name matching one of those is an error saying so rather
 * than an empty log: only one of those two answers means the VM has written
 * nothing.
 *
 * THE CONTENT COMES THROUGH THE FILE SEAM, NOT THE API. `vm.log_file_path`
 * answers a path and nothing else, and every content-bearing endpoint on this
 * surface is a job whose payload leaves out of band. `SystemHandle.files` is
 * how a tool reads bytes (route (a) of #72; `CLAUDE.md` carries the decision).
 * It is optional, and a deployment that wired none is told so rather than
 * answered with an empty log.
 *
 * A LOG IS UNBOUNDED AND A CONTEXT WINDOW IS NOT, which is why the line count
 * is a requirement of this tool rather than a refinement. The seam bounds the
 * bytes it will read, this bounds the lines it will return, and `truncated`
 * says when the pair of them left something out.
 *
 * The audit trail records a tool's arguments and, per system, `ok` or the
 * error message — never the result (`AuditEvent`). So log content does not
 * reach it, and nothing thrown here quotes a line of the file: a failure names
 * the VM and the path, which the caller either supplied or can already see.
 *
 * `log_error` is the seam's own message and is safe to return for the same
 * reason. `FileContentError` never quotes the download URL, which carries a
 * single-use token, and puts the adapter's own message — which can name that
 * URL — on `cause` instead. `errorText` reads `message` and never `cause`, so
 * the token cannot arrive in a result through here. That guard now lives in
 * `common.ts` rather than in this file, so it is a reader of `cause` added
 * THERE that would break this, not merely a test — and it would break it for
 * every tool at once.
 */

/** Lines returned when the caller names no bound. */
const DEFAULT_LOG_LINES = 100;

/** The most lines a caller may ask for. */
const MAX_LOG_LINES = 1000;

/**
 * How far the read got, so that an empty `lines` cannot be read as a VM that
 * logged nothing when it is a log this tool never saw.
 *
 * THERE IS NO STATE HERE FOR "THE FILE IS NOT THERE YET", and that is a
 * property of what reaches this tool rather than a distinction not worth
 * drawing. `FileContentError` separates an absent path from an unreadable one
 * on `errname`, and `SystemError.errname` is null for every API failure today —
 * the client flattens a JSON-RPC error to a plain message before it reaches the
 * core, and restoring it is an upstream change. So a log file that does not
 * exist arrives here as indistinguishable from one that could not be opened,
 * and both are `UNREADABLE` carrying what the system said. Splitting them on
 * the text of that message would be a guess, and the wrong half of it would
 * report a permission failure as a machine that has never logged anything.
 */
type VmLogStatus = 'READ' | 'NO_LOG_PATH' | 'UNREADABLE';

/** One VM's log, in the shape this tool reports it. */
interface VmLog {
  source: 'vm';
  id: number;
  name: string | null;
  log_path: string | null;
  log_status: VmLogStatus;
  /** What the system said about a log it would not give up, or null. */
  log_error: string | null;
  requested_lines: number;
  lines: string[];
  truncated: boolean;
}

/**
 * The line bound the caller asked for, or the default where they asked for
 * none.
 *
 * Strict, as `audit_log_query` is about its own `since` and for the same
 * reason: a bound that cannot be read is not a request for the default one. A
 * caller who asks for 1000 lines and is quietly given 100 has no way to tell
 * that from a log holding only 100, and a bound above the maximum is a request
 * this tool cannot honour rather than one it can round down. Null and undefined
 * are the argument being absent, which is what the default is for.
 */
function requestedLines(raw: unknown): number {
  if (raw == null) return DEFAULT_LOG_LINES;
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1 || raw > MAX_LOG_LINES) {
    throw new Error(`"lines" must be a whole number between 1 and ${MAX_LOG_LINES}`);
  }
  return raw;
}

/**
 * The VM the caller named, as text to match on.
 *
 * A number is accepted as well as a string because the id of a VM on this stack
 * IS a number and a caller reading one out of `vms_list` will send it as one;
 * it is matched as text either way, against both the name and the id, since a
 * caller has no way to say which of the two they meant.
 */
function requestedVm(raw: unknown): string {
  if (typeof raw === 'number' && Number.isInteger(raw)) return String(raw);
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new Error('"vm" must be the name of a virtual machine, or its numeric id');
  }
  return raw;
}

/** Whether a row is the one asked for, by name or by id. */
function matchesVm(row: VmRow, selector: string): boolean {
  return row.name === selector || (row.id !== null && String(row.id) === selector);
}

/** How a match is named in a message about several of them. */
function describeMatch(row: VmRow): string {
  return `${row.name ?? 'an unnamed VM'} (id ${row.id === null ? 'unknown' : String(row.id)})`;
}

/**
 * Every libvirt-backed VM on the system.
 *
 * Unlike `vms_list`, a read that fails is fatal here rather than reported
 * beside an answer: this tool has one question and a list it could not read is
 * not evidence that the VM asked about does not exist. The message says which
 * it was, because the two are indistinguishable to a caller who only sees a
 * name they gave being rejected.
 */
async function libvirtVms(system: SystemHandle, selector: string): Promise<VmRow[]> {
  try {
    const rows = await firstValueFrom(system.client.api.query('vm.query'));
    return rows.map(fromVmStack);
  } catch (reason) {
    throw new Error(
      `The virtual machines on this system could not be listed, so "${selector}" could not be ` +
        `found: ${errorText(reason)}`,
      { cause: reason },
    );
  }
}

/**
 * Whether the name belongs to an incus-backed instance instead.
 *
 * Read only once the libvirt stack has already answered without a match, so
 * that the ordinary case costs one query rather than two. Its own failure is
 * caught and reported in the not-found message rather than raised: not finding
 * the VM is still the answer, and the failure is what stops that answer being
 * "it does not exist anywhere".
 */
async function incusMatch(
  system: SystemHandle,
  selector: string,
): Promise<Attempt<VmRow | undefined>> {
  const read = await attempt('virt_instance', () =>
    firstValueFrom(
      // Inlined for the reason `vms_list` gives, and re-checked below for the
      // reason it re-checks: a filter a release does not recognise is dropped
      // rather than refused, and a container is not a virtual machine.
      system.client.api.query('virt.instance.query', [['type', '=', 'VM']]),
    ),
  );
  return {
    value: (read.value ?? [])
      .filter((instance) => instance.type === 'VM')
      .map(fromVirtStack)
      .find((row) => matchesVm(row, selector)),
    failure: read.failure,
  };
}

/** Where the system keeps this VM's log, or null where it names none. */
async function logFilePath(
  system: SystemHandle,
  id: number,
  selector: string,
): Promise<string | null> {
  try {
    return textOrNull(await firstValueFrom(system.client.api.call('vm.log_file_path', [id])));
  } catch (reason) {
    throw new Error(
      `The log file path for "${selector}" could not be read: ${errorText(reason)}`,
      { cause: reason },
    );
  }
}

export const vmLogs: ReadOnlyTool = {
  name: 'vm_logs',
  description:
    'The recent log output of one virtual machine — the last lines of the log ' +
    'file TrueNAS keeps for it. `vm` names the machine: its name, or its ' +
    'numeric id. ONLY THE OLDER LIBVIRT-BACKED VMs HAVE A LOG HERE, the ones ' +
    '`vms_list` reports with `source` `vm`, and `source` is always `vm` in ' +
    'this result for that reason. TrueNAS also runs newer incus-backed ' +
    'instances — `source` `virt_instance` — and NOTHING ON THIS API CAN ' +
    'RETRIEVE A LOG FOR ONE, so naming one is an error saying so rather than ' +
    'an empty log. A name matching no virtual machine at all is an error ' +
    'naming it, and one matching more than one machine is an error rather ' +
    'than a guess at which was meant. `lines` is the most lines to return: 100 ' +
    'by default, 1000 at most, and a value outside that range is an error ' +
    'rather than a quietly smaller answer. `requested_lines` is the bound ' +
    'actually applied. The `lines` list is OLDEST FIRST, so the newest line of ' +
    'the log is the last element. THEY ARE THE LAST LINES OF THE FILE ON A ' +
    'BEST EFFORT: reaching the end depends on the size the system reports for ' +
    'the file, and a log being written to while it is read can yield lines ' +
    'from further forward instead. `truncated` is true whenever what came back ' +
    'is not the whole log — more lines than the bound, or content skipped to ' +
    'reach the end — and it does not say WHICH end was missed, so a caller ' +
    'watching a live problem should read again rather than treat one answer ' +
    'as final. `log_status` says how far the read got, and ONLY `READ` MEANS ' +
    'AN EMPTY `lines` IS SOMETHING THE VM DID. `READ` is the log file read, ' +
    'with `lines` holding what it had; an empty `lines` there means no whole ' +
    'line was in what was read, which is an empty log where `truncated` is ' +
    'false and, where it is true, a window that held no line end — a line ' +
    "longer than the reader's byte ceiling, or a file that changed size while " +
    'it was being read, among others. ' +
    '`NO_LOG_PATH` is a system that names no log file for this VM at all, ' +
    'which is usually a machine that has never been started. `UNREADABLE` is a ' +
    'log file this tool was told about and could not read, with `log_error` ' +
    'carrying what the system said about it. THAT COVERS A FILE THAT IS NOT ' +
    'THERE YET AS WELL AS ONE THAT COULD NOT BE OPENED, and this API does not ' +
    'separate the two: the error name that would is not carried through to ' +
    'this tool, so reading `log_error` is the only way to tell, and a VM that ' +
    'has simply never logged anything cannot be asserted from this state ' +
    'alone. `lines` is empty and `truncated` false under both of those states. ' +
    '`log_error` is null under every state but `UNREADABLE`. `log_path` is ' +
    'where the log file lives on the system, and is null exactly when ' +
    '`log_status` is `NO_LOG_PATH`. `id` is the machine\'s numeric id on this ' +
    'stack and `name` is the name it is configured under, or null where the ' +
    'system reported none — both are the machine this matched, as `vms_list` ' +
    'reports them, so a name given here can be checked against what it ' +
    'resolved to. A machine that could not be identified at all IS an error ' +
    'rather than any of these states: no match, several matches, a stack that ' +
    'could not be listed, or a system that could not be asked where the log ' +
    'lives. This tool reads recorded log output ' +
    'and nothing else. It is NOT console access — a console is a live socket ' +
    'and is not in this catalog — it does not report application or container ' +
    'logs, WHICH NOTHING IN THIS CATALOG REPORTS, and it does not start, stop ' +
    'or change a VM. NO field beyond those named here is returned.',
  inputSchema: {
    type: 'object',
    properties: {
      vm: {
        // `oneOf` rather than a type list, as the catalog's own `systems`
        // argument spells the same union: an array-valued `type` is valid JSON
        // Schema and is outside the subset several provider APIs accept.
        oneOf: [{ type: 'string' }, { type: 'integer' }],
        description:
          'The virtual machine to read, by name or by numeric id, as ' +
          '`vms_list` reports them for `source` `vm`.',
      },
      lines: {
        type: 'integer',
        minimum: 1,
        maximum: MAX_LOG_LINES,
        description:
          `The most log lines to return, newest last. Omitted, ${DEFAULT_LOG_LINES}.`,
      },
    },
    required: ['vm'],
  },
  requiredRole: Role.ReadOnly,
  mutating: false,
  async handler({ system }, args) {
    // Both arguments are read before anything is called, so an unreadable one
    // is an error rather than a system asked a question this tool then throws
    // the answer to.
    const wanted = requestedLines(args['lines']);
    const selector = requestedVm(args['vm']);
    const files = system.files;
    // Checked before the first call, because it is a fact about how this
    // deployment was assembled rather than about the VM asked for — and a
    // missing reader would otherwise be discovered only after the VM had been
    // found, which is a slower way to say the same thing.
    if (files === undefined) {
      throw new Error(
        'This deployment cannot read file content from a system, so no VM log can be ' +
          'retrieved. `vm_logs` reads the log file through the content reader the adapter ' +
          'supplies when it connects a system; without one there is no way to reach it.',
      );
    }

    const matches = (await libvirtVms(system, selector)).filter((row) => matchesVm(row, selector));
    if (matches.length === 0) {
      const other = await incusMatch(system, selector);
      if (other.value !== undefined) {
        throw new Error(
          `"${selector}" is an incus-backed instance, and TrueNAS keeps no log this API can ` +
            'retrieve for that stack. Only the libvirt-backed virtual machines `vms_list` ' +
            'reports with `source` `vm` have one.',
        );
      }
      throw new Error(
        `No libvirt-backed virtual machine matching "${selector}" exists on this system` +
          // Said only where it is true: an incus stack that could not be read
          // is why "it exists nowhere" is not what was established here.
          (other.failure === null
            ? ''
            : `, and the incus stack could not be read to say whether it holds one: ${other.failure.error}`),
      );
    }
    if (matches.length > 1) {
      throw new Error(
        `"${selector}" matches ${matches.length} virtual machines on this system — ` +
          `${matches.map(describeMatch).join(', ')}. Ask again with the id of the one ` +
          'you mean.',
      );
    }
    const target = matches[0];
    // `VmRow.id` spans both stacks and is a string on the other one; on this
    // one it is a number or nothing at all. Reaching here without one is a
    // match made on the name alone, and the log can only be asked for by id.
    const id = target.id;
    if (typeof id !== 'number') {
      throw new Error(
        `The system reported no id for the virtual machine matching "${selector}", and its log ` +
          'file can only be located by id.',
      );
    }
    /** Every answer this tool gives, so that all three carry the same fields. */
    const answer = (
      log_path: string | null,
      log_status: VmLogStatus,
      lines: string[],
      truncated: boolean,
      log_error: string | null = null,
    ): VmLog => ({
      source: 'vm',
      id,
      name: target.name,
      log_path,
      log_status,
      log_error,
      requested_lines: wanted,
      lines,
      truncated,
    });

    const path = await logFilePath(system, id, selector);
    if (path === null) return answer(null, 'NO_LOG_PATH', [], false);
    try {
      const tail = await files.readTail(path, wanted);
      return answer(path, 'READ', tail.lines, tail.truncated);
    } catch (reason) {
      // Reported rather than raised, because the commonest reason a named log
      // file will not open is that the VM has not written one yet — which is an
      // answer about the machine and not a fault. It is not raised as an empty
      // log either: `log_status` is what stops an empty `lines` here being read
      // as a VM that logged nothing, since this cannot tell an absent file from
      // an unreadable one (see `VmLogStatus`). Identifying the machine is the
      // part that still throws: a system that could not be asked its VMs, or
      // where its log lives, was never in a position to answer at all.
      return answer(path, 'UNREADABLE', [], false, errorText(reason));
    }
  },
};

/**
 * The virtual hardware attached to each VM: disks, network interfaces, display
 * devices and passthrough hardware.
 *
 * `vms_list` reports what a VM has been given — its state, its CPUs, its memory
 * — and nothing about what is attached to it, so "what disk is it booting
 * from", "which bridge is its NIC on" and "what PCI device is passed through to
 * it" are what this answers and `vms_list` cannot. They are also where "why
 * will this VM not start" usually bottoms out: a missing disk, a NIC on an
 * interface that no longer exists, a passthrough device the host has claimed.
 *
 * ONE STACK, NOT TWO, which is the same split `vm_logs` has and for the same
 * reason. `vm.device.query` is the libvirt surface, so this reports devices for
 * the machines `vms_list` reports with `source` `vm`. The incus-backed
 * instances keep their devices inside the `virt.instance` record this catalog
 * deliberately does not forward, and nothing here reports them.
 *
 * EACH DEVICE KIND IS MAPPED THROUGH ITS OWN ALLOWLIST rather than through one
 * flattened row unioning every kind's fields. A flattened row would be mostly
 * nulls on every device — a NIC has none of a disk's fields — and would absorb
 * a field a later TrueNAS release adds to any one of the kinds. So the `dtype`
 * the middleware discriminates on survives into the result, and `attributes`
 * carries only the fields that kind actually has.
 *
 * `attributes` is null for a `dtype` this tool has no mapping for, and that is
 * a case to expect rather than a defensive branch: the pinned client already
 * declares an eighth kind, `ISCSI_DISK`, on the device shape the `vm.device`
 * added and changed events carry, while leaving it out of the one
 * `vm.device.query` answers with. A caller that treats a null
 * `attributes` as "this device has no configuration" would report an
 * iSCSI-backed disk as an empty device.
 */

/** One device as `vm.device.query` reports it, derived from the call (#91). */
type VmDeviceEntry = ApiSurface['call']['vm.device.query']['entity'];

/** The discriminated union of everything a device's `attributes` can be. */
type VmDeviceAttributes = VmDeviceEntry['attributes'];

/**
 * One member of that union, as a partial.
 *
 * Partial because the declared shape is what the middleware is documented to
 * send rather than the value received, and every field below is read through a
 * guard anyway. Derived rather than named because the generator suffixes a
 * colliding interface `$1`/`$2`/`$N` and the suffix a type carries in one
 * release is not the one it carries in the next (#91) — but the FIELD names
 * still want checking against the generated client, which is what this gives
 * the seven readers below.
 */
type AttributesOf<D extends VmDeviceAttributes['dtype']> = Partial<
  Extract<VmDeviceAttributes, { dtype: D }>
>;

/** A CD-ROM image attached to the VM. */
interface CdromAttributes {
  path: string | null;
}

/**
 * A display device — the graphical console the VM is reachable on.
 *
 * `password` IS DELIBERATELY NOT REPORTED, IN ANY FORM. It is the passphrase
 * the SPICE or VNC console is protected with, declared `string | null` beside
 * the display's ordinary settings with nothing in the type saying it is a
 * credential, and tool arguments and results are recorded verbatim in the audit
 * trail (S3.3) — the same reasoning that keeps a cloud backup's passphrase and
 * an rsync task's private key out of `automated_tasks_list` (#97). Naming the
 * fields one by one rather than trimming the record is what keeps it out, and
 * a later release adding a second credential-shaped field here is kept out by
 * the same mechanism rather than by anyone noticing.
 *
 * This is not the console access path either: `vm.get_display_devices` and
 * `vm.get_display_web_uri` mint access to a running console and are in no tool
 * here. What this reports is where the console is configured to listen.
 */
interface DisplayAttributes {
  type: string | null;
  bind: string | null;
  port: number | null;
  web_port: number | null;
  web: boolean | null;
  resolution: string | null;
}

/** A virtual network interface. */
interface NicAttributes {
  type: string | null;
  nic_attach: string | null;
  mac: string | null;
  trust_guest_rx_filters: boolean | null;
}

/** A host PCI device passed through to the VM. */
interface PciAttributes {
  pptdev: string | null;
}

/**
 * The fields a RAW file and a zvol-backed disk describe identically.
 *
 * Shared because these five say the same thing on both kinds and are read the
 * same way, not because the two kinds share a row: each still has its own
 * allowlist below and its own fields beside these. `type` is the emulated
 * controller (`AHCI`, `VIRTIO`) and is unrelated to `dtype`.
 */
interface DiskFileAttributes {
  type: string | null;
  logical_sectorsize: number | null;
  physical_sectorsize: number | null;
  iotype: string | null;
  serial: string | null;
}

/** A raw disk image file on the host's filesystem. */
interface RawAttributes extends DiskFileAttributes {
  path: string | null;
  exists: boolean | null;
  boot: boolean | null;
  size: number | null;
}

/** A disk backed by a zvol or a device path. */
interface DiskAttributes extends DiskFileAttributes {
  path: string | null;
  create_zvol: boolean | null;
  zvol_name: string | null;
  zvol_volsize: number | null;
}

/** The nested record a USB device names its host hardware in. */
type UsbIdentifiers = NonNullable<AttributesOf<'USB'>['usb']>;

/** A USB device passed through to the VM. */
interface UsbAttributes {
  controller_type: string | null;
  device: string | null;
  vendor_id: string | null;
  product_id: string | null;
}

/** Whatever kind of device this row turned out to be. */
type DeviceAttributes =
  | CdromAttributes
  | DisplayAttributes
  | NicAttributes
  | PciAttributes
  | RawAttributes
  | DiskAttributes
  | UsbAttributes;

/** One attached device, in the shape this tool reports it. */
interface VmDeviceRow {
  id: number | null;
  vm: number | null;
  order: number | null;
  dtype: string | null;
  attributes: DeviceAttributes | null;
}

/** The five fields a RAW file and a DISK describe the same way. */
function diskFileAttributes(held: AttributesOf<'RAW'> | AttributesOf<'DISK'>): DiskFileAttributes {
  return {
    type: textOrNull(held.type),
    logical_sectorsize: numberOrNull(held.logical_sectorsize),
    physical_sectorsize: numberOrNull(held.physical_sectorsize),
    iotype: textOrNull(held.iotype),
    serial: textOrNull(held.serial),
  };
}

/**
 * One device's configuration, read through the allowlist for its own kind.
 *
 * Null for a `dtype` this tool has no mapping for — see the file comment above
 * for why that is an expected answer rather than an unreachable branch. The
 * `dtype` itself is reported beside it either way, so a caller can tell a kind
 * that was not mapped from a device whose configuration could not be read at
 * all.
 *
 * Each arm states the kind it is building, which is what makes the allowlists
 * separate to the compiler rather than only in the reading: returned into the
 * bare union, a field belonging to another kind would satisfy that kind's
 * member and compile, which is exactly the flattened row this is written to
 * avoid.
 */
function readAttributes(dtype: string, held: Record<string, unknown>): DeviceAttributes | null {
  switch (dtype) {
    case 'CDROM': {
      const cdrom = held as AttributesOf<'CDROM'>;
      return { path: textOrNull(cdrom.path) } satisfies CdromAttributes;
    }
    case 'DISPLAY': {
      const display = held as AttributesOf<'DISPLAY'>;
      return {
        type: textOrNull(display.type),
        bind: textOrNull(display.bind),
        port: numberOrNull(display.port),
        web_port: numberOrNull(display.web_port),
        web: booleanOrNull(display.web),
        resolution: textOrNull(display.resolution),
      } satisfies DisplayAttributes;
    }
    case 'NIC': {
      const nic = held as AttributesOf<'NIC'>;
      return {
        type: textOrNull(nic.type),
        nic_attach: textOrNull(nic.nic_attach),
        mac: textOrNull(nic.mac),
        trust_guest_rx_filters: booleanOrNull(nic.trust_guest_rx_filters),
      } satisfies NicAttributes;
    }
    case 'PCI': {
      const pci = held as AttributesOf<'PCI'>;
      return { pptdev: textOrNull(pci.pptdev) } satisfies PciAttributes;
    }
    case 'RAW': {
      const raw = held as AttributesOf<'RAW'>;
      return {
        ...diskFileAttributes(raw),
        path: textOrNull(raw.path),
        exists: booleanOrNull(raw.exists),
        boot: booleanOrNull(raw.boot),
        size: numberOrNull(raw.size),
      } satisfies RawAttributes;
    }
    case 'DISK': {
      const disk = held as AttributesOf<'DISK'>;
      return {
        ...diskFileAttributes(disk),
        path: textOrNull(disk.path),
        create_zvol: booleanOrNull(disk.create_zvol),
        zvol_name: textOrNull(disk.zvol_name),
        zvol_volsize: numberOrNull(disk.zvol_volsize),
      } satisfies DiskAttributes;
    }
    case 'USB': {
      const usb = held as AttributesOf<'USB'>;
      // The identifiers are one level down, in a record the client declares
      // optional and nullable. Read back as a partial of that record's own
      // declared type for the reason the envelope is: read by string index
      // instead, a regenerated client renaming either key would null both
      // silently, with no build error and with fixtures written by hand
      // against the same old names. Both are null where the record held none,
      // which is the same answer this file gives for every unreadable field.
      const identifiers = (recordOrNull(usb.usb) ?? {}) as Partial<UsbIdentifiers>;
      return {
        controller_type: textOrNull(usb.controller_type),
        device: textOrNull(usb.device),
        vendor_id: textOrNull(identifiers.vendor_id),
        product_id: textOrNull(identifiers.product_id),
      } satisfies UsbAttributes;
    }
    default:
      return null;
  }
}

/**
 * One device row.
 *
 * The envelope is read back as a partial of the derived entity so the four
 * field names are checked against the generated client, and through
 * `recordOrNull` first so a row that is not an object at all reports four nulls
 * rather than throwing and taking every other device down with it.
 *
 * A row this tool could not read is still listed. Dropping it would shorten the
 * list towards "the VM has no such device", which is a claim about the VM's
 * hardware that the read never established (#93) — and on this tool it is the
 * claim most likely to be acted on, since an absent device is exactly what a
 * caller is looking for when a VM will not start.
 */
function readDevice(entry: unknown): VmDeviceRow {
  const row = (recordOrNull(entry) ?? {}) as Partial<VmDeviceEntry>;
  // An `attributes` that was not a record reads as an empty one, which answers
  // no `dtype` and so no attributes — the same answer, without a second
  // unreachable branch saying it.
  const held = recordOrNull(row.attributes) ?? {};
  const dtype = textOrNull(held['dtype']);
  return {
    id: numberOrNull(row.id),
    vm: numberOrNull(row.vm),
    order: numberOrNull(row.order),
    dtype,
    attributes: dtype === null ? null : readAttributes(dtype, held),
  };
}

/**
 * What every failure of this read is named as, so that a rejection and an
 * answer of the wrong shape reach the caller in the same words. Both are the
 * device list not having been read, and a message that says so only in one of
 * the two cases leaves the other looking like a fault somewhere else.
 */
const DEVICES_UNREAD = 'The virtual machine devices could not be listed: ';

/** What a read that answered with something other than a list is reported as. */
const NOT_A_DEVICE_LIST = 'the system answered with something other than a list of devices';

export const vmDevices: ReadOnlyTool = {
  name: 'vm_devices',
  description:
    'The virtual hardware attached to each virtual machine on a TrueNAS ' +
    'system: disks, CD-ROMs, network interfaces, display devices, and USB and ' +
    'PCI hardware passed through from the host. `vms_list` reports what a VM ' +
    'has been given — its state, its CPUs, its memory — and nothing about what ' +
    'is attached to it, which is what this answers. ONE DEVICE PER ENTRY, ' +
    'ACROSS EVERY VM ON THE SYSTEM: this is not grouped by machine, and `vm` ' +
    'is the numeric id of the machine the device belongs to, WHICH IS THE `id` ' +
    "`vms_list` REPORTS FOR AN ENTRY WHOSE `source` IS `vm` — that is how a " +
    'device is attributed to a machine, and there is no other join. `vm` is ' +
    'null where the system reported no id this tool could read, and such a ' +
    'device cannot be attributed to any machine. ONLY THE OLDER LIBVIRT-BACKED ' +
    'VMs HAVE DEVICES HERE, the ones `vms_list` reports with `source` `vm`. ' +
    'TrueNAS also runs newer incus-backed instances — `source` `virt_instance` ' +
    '— and THIS TOOL REPORTS NO DEVICE FOR ANY OF THEM, because the devices of ' +
    'those machines are not on this API surface at all. An empty result on a ' +
    'system whose VMs are all incus-backed is that, and not a fleet of ' +
    'machines with no hardware attached. `id` is the device\'s own identifier ' +
    'and `order` the position TrueNAS attaches it in, both null where the ' +
    'system reported none this tool could read. `dtype` IS WHAT KIND OF DEVICE ' +
    'IT IS and decides which fields `attributes` carries: `DISK` and `RAW` are ' +
    'disks, `CDROM` an image, `NIC` a network interface, `DISPLAY` the ' +
    'graphical console, `PCI` and `USB` host hardware passed through. EACH ' +
    'KIND IS REPORTED THROUGH ITS OWN SET OF FIELDS, and a name two kinds ' +
    'share MEANS WHATEVER THAT KIND\'S OWN ENTRY BELOW SAYS IT MEANS — `type` ' +
    'is on four of them and is the emulated network card on `NIC`, the ' +
    'display protocol on `DISPLAY`, and the emulated disk controller on `DISK` ' +
    'and `RAW` — so read `dtype` before reading `attributes`. For ' +
    '`DISK`: `path` is what backs it, `zvol_name` and `zvol_volsize` the zvol ' +
    'where one does, `create_zvol` whether TrueNAS made that zvol itself. For ' +
    '`RAW`: `path` is the image file, `exists` whether the system says that ' +
    'file is there, `boot` whether the VM boots from it, `size` how big it is. ' +
    'Both also carry `type`, the emulated controller (`AHCI`, `VIRTIO`), which ' +
    'IS NOT `dtype`; `logical_sectorsize` and `physical_sectorsize`, which the ' +
    'API declares as 512 or 4096; `iotype`; and `serial`, the serial number ' +
    'the guest sees. NO UNIT IS ASSERTED FOR `size` OR `zvol_volsize`: this API ' +
    'declares them as bare numbers, nothing in it states what they count, and ' +
    'they are reported under the names the system uses and must not be ' +
    'converted. For `CDROM`: `path` is the image. For `NIC`: `nic_attach` is ' +
    'the host interface or bridge it is attached to — A NIC WHOSE ' +
    '`nic_attach` NAMES AN INTERFACE `network_interfaces` DOES NOT LIST IS A ' +
    'COMMON REASON A VM WILL NOT START — `mac` its MAC address, `type` the ' +
    'emulated card (`E1000`, `VIRTIO`), `trust_guest_rx_filters` whether the ' +
    'guest may set receive filters. For `DISPLAY`: `type` is `SPICE` or `VNC`, ' +
    '`bind` the address the console listens on, `port` and `web_port` where, ' +
    '`web` whether the browser console is offered, `resolution` the configured ' +
    'size. THE CONSOLE PASSWORD IS NOT REPORTED IN ANY FORM, not even as ' +
    'whether one is set, and this tool gives no way to reach a running ' +
    'console. For `PCI`: `pptdev` is the host device passed through. For ' +
    '`USB`: `device` is the host device, `vendor_id` and `product_id` identify ' +
    'it, `controller_type` is the emulated USB controller. `attributes` IS ' +
    'NULL WHERE `dtype` IS A KIND THIS TOOL HAS NO MAPPING FOR — TrueNAS ' +
    'already defines at least one more kind (`ISCSI_DISK`) elsewhere than the ' +
    'ones this query answers with — SO A NULL `attributes` BESIDE A NON-NULL ' +
    '`dtype` IS A DEVICE THAT IS THERE AND CONFIGURED, whose configuration ' +
    'this tool does not read, and never a device with nothing configured. ' +
    '`attributes` and `dtype` are BOTH null where the device\'s configuration ' +
    'could not be read at all; such a row is still listed rather than dropped, ' +
    'because a shorter list would say the machine does not have that device, ' +
    'which is exactly the wrong answer to give about a VM that will not start. ' +
    'Every field is null where the system reported no value this tool could ' +
    'read, AND FOR NEARLY ALL OF THEM THAT IS ALSO WHAT THE DEVICE ITSELF ' +
    'RECORDS WHEN NOTHING IS CONFIGURED — this API declares almost every field ' +
    'of every kind optional or nullable — SO THIS TOOL DOES NOT SEPARATE THE ' +
    'TWO: a null `nic_attach` is a NIC attached to no interface, or one whose ' +
    'attachment could not be read, and nothing here says which. FOUR FIELDS ' +
    'ARE THE EXCEPTION, because the API declares them present and non-null on ' +
    'their kind: `dtype`, a `CDROM` `path`, a `PCI` `pptdev` and a `RAW` ' +
    '`path`. A null in one of those is a value that did not reach this tool as ' +
    'something it could read — WHICH INCLUDES ONE THE SYSTEM SENT AS EMPTY ' +
    'TEXT, and this surface does send empty strings for required fields — and ' +
    'is not the device recording an absence, since the API gives those four no ' +
    'way to record one. AN ' +
    'EMPTY `devices` LIST IS A SYSTEM WITH NO LIBVIRT-BACKED VM DEVICES AT ' +
    'ALL, which includes a system with no libvirt-backed VMs. A machine ' +
    '`vms_list` reports with `source` `vm` AND NO ROW HERE NAMING IT HAS NO ' +
    'DEVICES ATTACHED — except that a row whose `vm` is null names no machine ' +
    'and could be its, so that reading holds only while every row carries a ' +
    '`vm`. One `vms_list` reports with `source` `virt_instance` HAS NO ROW HERE ' +
    'WHATEVER IS ATTACHED TO IT, so the same absence means opposite things for ' +
    'the two stacks and `source` is what tells them apart. This ' +
    'tool reports configuration and not liveness: it does not say whether a ' +
    'device is currently in use, whether the host still has the hardware, or ' +
    'why a VM failed to start — `vm_logs` is what carries that. It does not ' +
    'attach, detach or reconfigure anything. NO field beyond those named here ' +
    'is returned, whatever a later TrueNAS release adds to any device kind.',
  inputSchema: { type: 'object', properties: {} },
  requiredRole: Role.ReadOnly,
  mutating: false,
  async handler({ system }) {
    let rows: unknown;
    try {
      rows = await firstValueFrom(system.client.api.query('vm.device.query'));
    } catch (reason) {
      // Raised rather than reported beside an empty list, which is the
      // difference from `vms_list`: there is one read here and no second
      // answer to preserve, and an empty `devices` list means something
      // definite — no VM on this system has any device attached — that a read
      // which never happened has not established.
      throw new Error(`${DEVICES_UNREAD}${errorText(reason)}`, { cause: reason });
    }
    // `query` types its answer as a list of rows, and that is a claim about
    // what the middleware sends rather than the value received: the call
    // directory declares this method as answering a union that also admits a
    // bare row and a count. Checked here so a non-list is that message rather
    // than a `.map` throwing out of the handler.
    if (!Array.isArray(rows)) throw new Error(`${DEVICES_UNREAD}${NOT_A_DEVICE_LIST}`);
    return { devices: rows.map(readDevice) };
  },
};

/**
 * `vm_start`, `vm_stop` and `vm_restart`: power control for one libvirt-backed
 * virtual machine, and the first mutations this catalog offers over the `vm`
 * stack.
 *
 * THE THREE ARE ONE DELIVERABLE. `destructiveness: 'reversible'` records the
 * operation and must not be read as "the catalog can undo this" (#153), and a
 * `vm_start` shipped alone would be the first `reversible` mutation whose
 * reversal is an obvious, already-typed API call that no tool here offers.
 * Together they make the field true in the strong sense.
 *
 * ONE STACK, NOT TWO, the same split {@link vmLogs} and {@link vmDevices} have.
 * All three methods are `vm.*`; the incus-backed instances `vms_list` reports
 * with `source` `virt_instance` have no counterpart reachable from here, and
 * their `id` is a STRING where these three take a number — which is what makes
 * a mis-aimed id refusable by argument check rather than at the middleware.
 *
 * ALL THREE ANSWER `null`, SO EVERY OUTCOME IS READ BY RE-READING. There is no
 * updated entity to take a result off, which is `alerts_dismiss`'s position
 * (#119) and `snapshot_set_hold`'s (#156) rather than
 * `scheduled_task_set_enabled`'s (#121). Each `execute` reads `vm.query` before
 * the call and again after it. BOTH READS ARE THE SAME CALL from
 * {@link readVmPower}, so the plan lists it ONCE and that step's description
 * says in words that it runs again — #156's rule exactly. WHEN it runs again
 * differs between these three and the step says which; see {@link vmReadStep}.
 *
 * NOTHING BRANCHES ON EITHER READ. The mutating call is made whatever the reads
 * said, including where they failed, because `execute` is contractually a pure
 * function of (args, system): the confirmation token binds tool + args +
 * systems rather than the plan steps, so an `execute` that re-read and dispatched
 * elsewhere would weaken "what you approved is what runs". That is why
 * {@link vmStart} refuses a running or suspended VM at PLAN time and never at
 * execute time, and why it calls `vm.start` and only `vm.start` where the webui
 * dispatches to `vm.resume`.
 */

/** Where the ids these three tools take come from, in the one wording used throughout. */
const VM_IDS_FROM =
  'the ids these tools take come from `vms_list`, from an entry whose `source` is `vm`';

/**
 * The one identifier all three methods take, or the error naming what is wrong
 * with it.
 *
 * Strict, as `cloudsync_run`'s is: the middleware holds these machines under
 * integer primary keys, and a coerced `"4"` or a `4.5` names no VM.
 *
 * The message names the OTHER stack, because that is the mistake this check
 * actually catches. `vms_list` reports both stacks under one `id` field whose
 * type differs between them, so a caller holding a `virt_instance` row has an
 * identifier these tools cannot take — and refusing it by name here is cheaper,
 * and far clearer, than letting it reach an API that would reject it for a
 * reason about types.
 */
function parseVmId(args: Record<string, unknown>): number {
  const id = args['id'];
  if (typeof id !== 'number' || !Number.isInteger(id)) {
    throw new Error(
      '"id" is required and must be a whole number — the numeric `id` `vms_list` reports for an ' +
        'entry whose `source` is `vm`. An entry whose `source` is `virt_instance` carries a ' +
        'STRING id and is the other stack, which these tools cannot reach at all.',
    );
  }
  return id;
}

/** What one read of a virtual machine's power state established. */
interface VmPowerReading {
  /** Whether the system listed a VM under the id given. */
  listed: boolean;
  /** The name the VM is configured under, for the plan a person reads. */
  name: string | null;
  /** The middleware's own state word, as `vms_list` reports it. */
  state: string | null;
  /** libvirt's own state for the same machine, as `vms_list` reports it. */
  domain_state: string | null;
  /**
   * How long an ACPI shutdown is waited for before `force_after_timeout`
   * decides, as the entity records it. Optional on the entity, so null is
   * "the system reported no value this tool could read".
   */
  shutdown_timeout: number | null;
}

/**
 * The positional params every power-state read reaches the middleware with, for
 * the plan step that names one.
 *
 * Written here AND inlined in {@link readVmPower}, because written to a `const`
 * the filter widens out of the client's filter tuple and the call no longer
 * type-checks — the half #153 says to name rather than leave implied. A test
 * takes the read step back out of the plan and asserts `execute` made its query
 * with it, and that assertion is what holds the two copies in step.
 */
function vmReadParams(id: number): unknown {
  return [[['id', '=', id]]];
}

/**
 * The power state this system reports for the VM with that id.
 *
 * The id is checked on the RESPONSE and not only asked for in the filter (#121,
 * #153): an unrecognised query parameter is dropped rather than refused, so a
 * filter that did not apply comes back as the whole table and the first row of
 * that is a different machine. The filter is still sent — it bounds what
 * crosses the wire, and it is not what decides.
 *
 * `state` and `domain_state` come through {@link fromVmStack}, so they are the
 * same two readings `vms_list` reports and not a second opinion about them.
 */
async function readVmPower(ctx: ToolContext, id: number): Promise<VmPowerReading> {
  const rows = await firstValueFrom(
    // Inlined for the reason {@link vmReadParams} gives.
    ctx.system.client.api.query('vm.query', [['id', '=', id]]),
  );
  const row = rows.find((candidate) => numberOrNull(candidate.id) === id);
  if (row === undefined) {
    return { listed: false, name: null, state: null, domain_state: null, shutdown_timeout: null };
  }
  const mapped = fromVmStack(row);
  return {
    listed: true,
    name: mapped.name,
    state: mapped.state,
    domain_state: mapped.domain_state,
    shutdown_timeout: numberOrNull(row.shutdown_timeout),
  };
}

/** A power-state read that completed, or the failure that stopped it. */
interface VmPowerAttempt {
  reading: VmPowerReading | null;
  error: string | null;
}

/**
 * One power-state read made by `execute`, with its failure caught and named.
 *
 * Caught rather than thrown, as `snapshot_set_hold`'s two reads are: these
 * exist to describe the outcome. Letting the first fail the call would lose an
 * approval already given for a mutation that is still safe to make, and letting
 * the second fail it would report a mutation that has ALREADY LANDED as having
 * failed.
 */
async function attemptVmPower(ctx: ToolContext, id: number): Promise<VmPowerAttempt> {
  try {
    return { reading: await readVmPower(ctx, id), error: null };
  } catch (reason) {
    return { reading: null, error: errorText(reason) };
  }
}

/** What one of `execute`'s two reads did, where the reading alone cannot say. */
type VmLookup = 'FOUND' | 'NOT_FOUND' | 'UNREADABLE';

function vmLookupOf(attempt: VmPowerAttempt): VmLookup {
  if (attempt.error !== null) return 'UNREADABLE';
  return attempt.reading !== null && attempt.reading.listed ? 'FOUND' : 'NOT_FOUND';
}

/**
 * The half of every one of these three results that is about the VM rather than
 * about the call: the state before, the state after, and whether they differ.
 *
 * `changed` compares the two `state` readings ALONE and is null where either is
 * — two readings or nothing, as `snapshot_set_hold`'s is. `domain_state` is
 * reported beside each but is deliberately not part of the comparison: it is a
 * second vocabulary from a different system (`vms_list` reports them separately
 * for that reason), and a `changed` derived from both would be true for a VM
 * whose `state` never moved. The descriptions say so, since side-by-side fields
 * are what an implied relationship looks like from the outside (#138).
 */
function vmPowerOutcome(
  id: number,
  previous: VmPowerAttempt,
  resulting: VmPowerAttempt,
): Record<string, unknown> {
  const previouslyState = previous.reading?.state ?? null;
  const resultingState = resulting.reading?.state ?? null;
  return {
    vm_id: id,
    previous_lookup: vmLookupOf(previous),
    previous_read_error: previous.error,
    previously_state: previouslyState,
    previously_domain_state: previous.reading?.domain_state ?? null,
    resulting_lookup: vmLookupOf(resulting),
    resulting_read_error: resulting.error,
    resulting_state: resultingState,
    resulting_domain_state: resulting.reading?.domain_state ?? null,
    changed:
      previouslyState === null || resultingState === null
        ? null
        : previouslyState !== resultingState,
  };
}

/**
 * The VM as a person approving the plan can recognise it.
 *
 * Named as well as numbered for #126's reason: ids are the middleware's own
 * integers and a caller that reached here with the wrong one can check the id
 * and cannot check anything else. A name the system did not report is stated as
 * that rather than left out.
 */
function describeVm(reading: VmPowerReading, id: number): string {
  return `the virtual machine ${
    reading.name === null ? '(the system reported no name)' : `"${reading.name}"`
  } (id ${id})`;
}

/**
 * The state the VM was in when the plan was made, for the plan step.
 *
 * It says outright that the reading is a plan-time one and is not re-checked,
 * because every one of these tools makes its state check at plan time only — a
 * machine that moves between the plan and the confirmation is refused, or not,
 * by the middleware rather than by an `execute` that branches.
 */
function vmStateSentence(reading: VmPowerReading): string {
  if (reading.state === null) {
    return (
      'The state it is in could not be read when this plan was made, so what this call changes ' +
      'is NOT established here.'
    );
  }
  const domain =
    reading.domain_state === null
      ? ', and the system reported no libvirt `domain_state` beside it'
      : `, with libvirt's own \`domain_state\` \`${reading.domain_state}\``;
  return (
    `Its state read as \`${reading.state}\`${domain} when this plan was made. THAT READING IS ` +
    'FROM PLAN TIME AND IS NOT RE-CHECKED when the call runs.'
  );
}

/**
 * The plan step for the read `execute` makes on either side of the mutation.
 *
 * ONE STEP FOR TWO CALLS, which is #156's rule rather than an exception to
 * #119's. The rule is that nothing `execute` calls may be missing from the
 * approval; a repeated call is not a further call to disclose, it is the same
 * one happening twice, and the step says so in words. Listing it twice would
 * show an approver two entries it has no way to tell apart.
 *
 * WHEN THE SECOND READ HAPPENS IS THE CALLER'S TO STATE, and it is not the same
 * answer for all three tools — which is why it is a parameter rather than one
 * sentence written here. {@link vmStart} calls a plain method and reads back on
 * the next line; the two job-backed tools read back when their WATCH ends,
 * which can be the full bound after the call was dispatched and is not when the
 * operation finished. One shared "immediately after the call" would be true of
 * one tool and false of two, in the text a person reads before approving, and
 * it would contradict those tools' own descriptions.
 */
function vmReadStep(id: number, secondRead: string): PlanStep {
  return {
    method: 'vm.query',
    params: vmReadParams(id),
    description:
      `Read the power state of the virtual machine with id ${id}, to report the state it was ` +
      `in before this call. Changes nothing. THIS SAME READ IS MADE AGAIN ${secondRead} — it ` +
      'is listed once because it is one call made twice.',
  };
}

/** When {@link vmStart}'s second read happens: on the next line after the call. */
const READ_AGAIN_AFTER_CALL =
  'IMMEDIATELY AFTER THE CALL, to report the state that resulted';

/**
 * When a job-backed tool's second read happens: when the watch ends, which is
 * not when the operation ends.
 *
 * Stated in the plan and not only in the description, because an approver told
 * "immediately after" reads a machine part-way through as the state it settled
 * in — and on a `vm_restart`, which passes through stopped on its way back up,
 * that is the reading that looks like a failure.
 */
function readAgainAfterWatch(seconds: number): string {
  return (
    `WHEN THE WATCH BELOW ENDS — UP TO ${seconds} SECONDS AFTER THIS CALL IS MADE, AND NOT ` +
    'WHEN THE OPERATION FINISHES — to report the state reached by then'
  );
}

/**
 * The job states this file reads as a run that worked.
 *
 * ITS OWN SET rather than one shared with `tasks.ts`, under #86's line: a state
 * VOCABULARY is a family's own, and each tool states its own in its own
 * description — where a shared constant would put the words in one file and the
 * sentence about them in another. What IS shared is the reading of the
 * middleware's date envelope ({@link jobMillis}), which says the same thing
 * everywhere.
 *
 * A terminal state this catalog does not recognise is NOT read as a success:
 * a run that cannot be shown to have worked has not been shown to have worked.
 */
const VM_JOB_SUCCESS_STATES = new Set(['SUCCESS', 'FINISHED']);

/** What a bounded watch of one job established. */
interface WatchedVmJob {
  job_id: number | null;
  ended: boolean;
  succeeded: boolean | null;
  job_state: string | null;
  error: string | null;
  finished_at: string | null;
}

/**
 * Start a job and watch it for a bounded time, then report what there is.
 *
 * THE SHAPE IS `cloudsync_run`'S (#122) AND IS COPIED RATHER THAN REDERIVED.
 * `callAndGetJobId` and `trackJob` are called apart rather than through
 * `api.job`, so the two failure eras stay separable; ending the watch does not
 * end the job, because `trackJob` only observes; `ended` is read from the
 * tracking COMPLETING rather than from a state list written down here; and
 * `job_id` comes from the correlation and never from the tracking's last
 * emission, because it is the one thing that survives a watch that established
 * nothing else. Every reason for every one of those is written out at
 * `cloudsyncRun` in `tasks.ts` and in `CLAUDE.md`'s #122 decision, and none of
 * it is re-argued here.
 *
 * `started` is the caller's own `callAndGetJobId` call, passed in rather than
 * dialled here, because the method and its params are the tool's and the
 * watching is not. It is cold: nothing is sent until this subscribes, which is
 * what lets a caller build it before the pre-call read without starting
 * anything.
 */
async function watchVmJob(
  ctx: ToolContext,
  started: Observable<number>,
  watchMs: number,
): Promise<WatchedVmJob> {
  const api = ctx.system.client.api;
  let completed = false;
  let sawJob = false;
  let jobId: number | null = null;
  const watched = await lastValueFrom(
    started.pipe(
      tap((correlated) => {
        sawJob = true;
        jobId = numberOrNull(correlated);
      }),
      switchMap((correlated) => api.trackJob(correlated)),
      tap({
        complete: () => {
          completed = true;
        },
      }),
      // An error raised once a job event has named this request is not the call
      // failing: the operation is under way, and rejecting here would report a
      // failure that did not happen AND take the job id with it. Before that
      // event there is nothing to report and no id to keep, so an error there
      // still fails.
      catchError((error: unknown) => (sawJob ? EMPTY : throwError(() => error))),
      takeUntil(timer(watchMs)),
    ),
    { defaultValue: null },
  );
  const record = recordOrNull(watched);
  const state = textOrNull(record?.['state']);
  // A completion carrying no emission is the client having found no such job,
  // which establishes nothing; both halves are required.
  const ended = completed && state !== null;
  return {
    job_id: jobId,
    ended,
    succeeded: ended ? VM_JOB_SUCCESS_STATES.has(state) : null,
    job_state: state,
    error: textOrNull(record?.['error']),
    // Gated on `ended` rather than on a state list of its own, so the finish
    // time follows the claim this tool has already made and cannot contradict
    // it.
    finished_at: ended ? isoOrNull(jobMillis(record?.['time_finished'])) : null,
  };
}

/** What the plan says about the watch, in the one wording both job-backed tools use. */
function vmWatchSentence(seconds: number): string {
  return (
    'This starts a background job; the job is then followed through the ' +
    "client's own tracking, which reads `core.get_jobs` and changes nothing, " +
    `for at most ${seconds} seconds. The operation continues after that whether ` +
    'or not it has finished.'
  );
}

/**
 * `vm_start`: powering one libvirt-backed virtual machine on.
 *
 * IT MUST NOT DISPATCH ON STATE, AND `SUSPENDED` IS WHY THAT BITES. The
 * middleware's `ACTIVE_STATES` is `('RUNNING', 'SUSPENDED')` and `start_vm`
 * raises `VM <name> is already running` for anything in it — so `vm.start`
 * refuses a SUSPENDED VM with a message that says it is running, and the route
 * back for one is `vm.resume`, which is not in this catalog.
 *
 * The webui dispatches: `VmService.doStartResume` calls `vm.resume` when the
 * state is `Suspended` and `vm.start` otherwise. THIS TOOL MUST NOT COPY THAT.
 * Branching to a different API method on state read at execution time is
 * exactly what `MutatingTool.execute`'s contract forbids, since the
 * confirmation token binds tool + args + systems rather than the plan steps. So
 * it calls `vm.start` and only `vm.start`, refuses a suspended VM AT PLAN TIME
 * with an accurate message, and names `vm.resume` as the thing that is absent.
 * Passing middleware's own wording through instead would tell a caller their
 * suspended VM is running.
 *
 * ALREADY-RUNNING IS AN ERROR HERE, AGAINST THE HOUSE CONVENTION. #119
 * established that already-in-the-target-state is not an error and that saying
 * which it was is the tool's job; the middleware refuses to hold that line for
 * `vm.start`, which raises rather than no-opping. So the plan refuses, naming
 * the VM and its state, as `snapshot_task_run` refuses a disabled task — and
 * the check is plan-time only, so a VM started between plan and confirmation is
 * refused by the middleware rather than by an `execute` that re-reads.
 */

/** What `vm_start` was asked to do. */
interface VmStartArgs {
  id: number;
  overcommit: boolean;
}

/**
 * The caller's arguments, or the error naming what is wrong with them.
 *
 * Strict on `overcommit` for `cloudsync_run`'s reason: coercing `"false"` to
 * true would start a VM the system has no memory headroom for under an approval
 * given for the opposite, which is not a narrower answer to the question asked
 * but a different one.
 */
function parseVmStartArgs(args: Record<string, unknown>): VmStartArgs {
  const id = parseVmId(args);
  const overcommit = args['overcommit'];
  if (overcommit != null && typeof overcommit !== 'boolean') {
    throw new Error('"overcommit" must be a boolean');
  }
  return { id, overcommit: overcommit === true };
}

/**
 * The params the call is made with.
 *
 * The options object is always sent rather than omitted when `overcommit` is
 * false, for `cloudsync_run`'s reason: the plan shows the params, and a plan
 * whose second argument appears only sometimes would be showing two different
 * call shapes for one tool.
 */
function vmStartParams(args: VmStartArgs): CallParams<ApiSurface, 'vm.start'> {
  return [args.id, { overcommit: args.overcommit }];
}

/**
 * The VM states `vm.start` will not accept, with why each is refused.
 *
 * Both are `ACTIVE_STATES` to the middleware, and only one of them reads that
 * way to a person — which is the whole reason the suspended case gets its own
 * sentence rather than inheriting the running one.
 */
function vmStartRefusal(state: string, reading: VmPowerReading, id: number): string | null {
  if (state === 'RUNNING') {
    return (
      `${describeVm(reading, id)} is already in state \`RUNNING\` on this system, and the ` +
      'middleware REFUSES to start a VM that is already active rather than treating it as a ' +
      'no-op — so this call would fail.'
    );
  }
  if (state === 'SUSPENDED') {
    return (
      `${describeVm(reading, id)} is in state \`SUSPENDED\` on this system. The middleware ` +
      'counts SUSPENDED as ACTIVE, so `vm.start` refuses it — AND THE MESSAGE IT REFUSES WITH ' +
      'SAYS THE VM IS ALREADY RUNNING, WHICH IT IS NOT. What a suspended VM needs is ' +
      '`vm.resume`, and THERE IS NO TOOL IN THIS CATALOG THAT RESUMES ONE; the TrueNAS web ' +
      'interface is where that can be done.'
    );
  }
  return null;
}

/** What the plan says this call does to the VM, given the state read at plan time. */
function vmStartEffectSentence(reading: VmPowerReading): string {
  if (reading.state === null) {
    return (
      'Because that state could not be read, whether the middleware will accept this call is ' +
      'NOT established here — it refuses a VM that is already running or suspended.'
    );
  }
  return 'It was neither running nor suspended, so the middleware had no reason to refuse it.';
}

/** What the plan says `overcommit` does to the system, rather than to the error. */
function overcommitSentence(overcommit: boolean): string {
  return overcommit
    ? 'OVERCOMMIT IS ON FOR THIS CALL: the VM is started even where this system does not have ' +
        'enough free memory to hold every VM configured on it at once, so the memory this one ' +
        'is given is OVERSUBSCRIBED against the rest. That is a choice about the system and ' +
        'not a way of retrying a failed start.'
    : 'Overcommit is off, so the middleware starts this VM only where the memory for every ' +
        'VM configured on this system is available; short of that the call fails with an ' +
        'out-of-memory error rather than starting the VM.';
}

export const vmStart: MutatingTool = {
  name: 'vm_start',
  description:
    'Powers on one virtual machine on a TrueNAS system. Two-phase: called ' +
    'without a confirmation_token it returns a plan for user approval; called ' +
    'with one it starts the VM. ONLY THE OLDER LIBVIRT-BACKED VMs CAN BE ' +
    'STARTED HERE — the ones `vms_list` reports with `source` `vm`. `id` is ' +
    "that entry's numeric `id` on the system being targeted; AN ENTRY WHOSE " +
    '`source` IS `virt_instance` HAS A STRING id AND IS A DIFFERENT STACK THIS ' +
    'TOOL CANNOT REACH, and passing one is an error saying so. PLANNING ' +
    'AGAINST AN id NO VIRTUAL MACHINE HAS FAILS naming that id, so an approved ' +
    'plan is always about a machine that existed when it was made. PLANNING ' +
    'ALSO FAILS, NAMING THE STATE, WHERE THE VM IS ALREADY `RUNNING` OR IS ' +
    '`SUSPENDED`. Already-running is an error here rather than a no-op because ' +
    'THE MIDDLEWARE MAKES IT ONE — it raises instead of accepting the call. ' +
    'SUSPENDED IS REFUSED FOR A DIFFERENT REASON AND IT IS THE ONE WORTH ' +
    'READING: the middleware counts SUSPENDED as active, so `vm.start` rejects ' +
    'a suspended VM WITH A MESSAGE SAYING IT IS ALREADY RUNNING, WHICH IS NOT ' +
    'TRUE. A suspended VM needs `vm.resume`, and NOTHING IN THIS CATALOG ' +
    'RESUMES ONE — this tool does not, and will not silently do it for you. ' +
    'Both checks are made when the plan is made and ARE NOT REPEATED at ' +
    'execute time, so a VM whose state changes between the plan and the ' +
    'confirmation is refused by the middleware instead; and a VM whose state ' +
    'could not be READ is not refused, because an unreadable state is not a ' +
    'state that was read as running. `overcommit` DOES NOT RETRY A FAILED ' +
    'START AND IS NOT AN ERROR-SUPPRESSING FLAG: without it the middleware ' +
    'starts the VM only where this system has enough free memory to hold every ' +
    'VM configured on it, and fails out-of-memory short of that; with it the VM ' +
    'is started anyway and the memory is OVERSUBSCRIBED against the other VMs ' +
    'on the system. Default false. THE RESULT REPORTS THE STATE BEFORE AND ' +
    'AFTER, READ RATHER THAN ASSUMED: `vm.start` answers nothing at all, so ' +
    'this tool reads `vm.query` immediately before the call and again ' +
    'immediately after it. `previously_state` and `resulting_state` are those ' +
    "two readings of the middleware's own state word, and " +
    '`previously_domain_state` and `resulting_domain_state` are ' +
    "libvirt's own state beside each, exactly as `vms_list` reports the pair — " +
    'on the `vm` stack a machine that is not running commonly reads `STOPPED` ' +
    'whether it was shut down or died, and `domain_state` is where `CRASHED` ' +
    'or `SHUTOFF` separates those. `changed` IS THE TWO `state` READINGS ' +
    'COMPARED AND NOTHING ELSE — the `domain_state` pair is reported beside ' +
    'them and is NOT part of it, so a machine whose `state` did not move ' +
    'reports `changed: false` however its `domain_state` read. `changed` is ' +
    'NULL WHERE EITHER READING IS, WHICH IS NOT "NOTHING CHANGED". ' +
    '`previous_lookup` and `resulting_lookup` say what each read did: `FOUND` ' +
    'is a read that named this machine, `NOT_FOUND` a read that completed and ' +
    'listed none under this id, `UNREADABLE` a read that failed — with ' +
    '`previous_read_error` and `resulting_read_error` naming why and null ' +
    'otherwise. A `FOUND` beside a null state is a fourth case those three ' +
    'words do not separate: the machine was listed and reported no state this ' +
    'tool could read. THE CALL IS MADE IN ALL OF THOSE CASES AND NOTHING ' +
    'BRANCHES ON EITHER READ, because what runs must be what was approved — ' +
    'and a read that failed after the call is not a failed call: the VM was ' +
    'started and this tool simply could not establish the outcome. A START IS ' +
    'NOT AN INSTANT: `vm.start` returns once the domain has been asked to ' +
    'start, so `resulting_state` can still read `STOPPED` or report a ' +
    'transitional word on a machine that comes up moments later — call ' +
    '`vms_list` again to settle it, and `vm_logs` is where a machine that ' +
    "will not boot says why. THIS TOOL CANNOT STOP OR RESTART A VM (`vm_stop` " +
    'and `vm_restart` do), cannot resume a suspended one, and cannot create, ' +
    'change, clone or delete one.',
  inputSchema: {
    type: 'object',
    properties: {
      id: {
        type: 'integer',
        description:
          "The virtual machine's numeric `id` as `vms_list` reports it for an " +
          'entry whose `source` is `vm`, on the system being targeted.',
      },
      overcommit: {
        type: 'boolean',
        default: false,
        description:
          'Start the VM even where this system does not have enough free ' +
          'memory for every VM configured on it, oversubscribing the memory. ' +
          'This is not a retry flag. Default false.',
      },
    },
    required: ['id'],
  },
  requiredRole: Role.Full,
  mutating: true,
  // Starting a VM destroys nothing and the named reversal is in this catalog:
  // `vm_stop`. This is the case `Destructiveness` describes at its own
  // declaration, and — unlike `cloudsync_run` or `snapshot_clone` — there is no
  // account of the data that comes apart from the field.
  destructiveness: 'reversible',
  normalizeArgs(rawArgs) {
    const args = parseVmStartArgs(rawArgs);
    return { id: args.id, overcommit: args.overcommit };
  },
  async plan(ctx, rawArgs): Promise<PlanStep[]> {
    const args = parseVmStartArgs(rawArgs);
    const reading = await readVmPower(ctx, args.id);
    if (!reading.listed) {
      throw new Error(
        `No virtual machine with id ${args.id} on the \`vm\` stack of this system — ${VM_IDS_FROM}`,
      );
    }
    // Only a state that was actually read refuses the plan. An unreadable state
    // is not a state that was read as active, and failing on it would refuse a
    // plan the middleware would have accepted — `snapshot_task_run`'s reading of
    // a task's `enabled`, one family over.
    const refusal = reading.state === null ? null : vmStartRefusal(reading.state, reading, args.id);
    if (refusal !== null) throw new Error(refusal);
    return [
      vmReadStep(args.id, READ_AGAIN_AFTER_CALL),
      {
        method: 'vm.start',
        params: vmStartParams(args),
        description:
          `Start ${describeVm(reading, args.id)}. ${vmStateSentence(reading)} ` +
          `${vmStartEffectSentence(reading)} ${overcommitSentence(args.overcommit)}`,
      },
    ];
  },
  async execute(ctx, rawArgs) {
    const args = parseVmStartArgs(rawArgs);
    const previous = await attemptVmPower(ctx, args.id);
    // Unconditional, whatever the read said and whether or not it succeeded.
    // Branching on state read at execution time is what the confirmation token
    // cannot bind — and it is what would turn this into the webui's dispatch.
    await firstValueFrom(ctx.system.client.api.call('vm.start', vmStartParams(args)));
    const resulting = await attemptVmPower(ctx, args.id);
    return {
      ...vmPowerOutcome(args.id, previous, resulting),
      requested_overcommit: args.overcommit,
    };
  },
};

/**
 * `vm_stop`: powering one libvirt-backed virtual machine off, over a job.
 *
 * WHICH OF THE TWO SHUTDOWN PATHS RUNS IS THE CALLER'S CHOICE AND MUST BE
 * STATED AS SUCH. `force: true` destroys the domain immediately — the power
 * cord, with whatever the guest has not flushed to disk. `force: false` sends
 * an ACPI shutdown and waits the VM's own `shutdown_timeout`, after which
 * `force_after_timeout` decides whether the domain is destroyed anyway. A plan
 * reading "stop this VM" would be true of all three combinations and would hide
 * the one that loses data, which is `transferModeSentence`'s defect in a third
 * family.
 *
 * `shutdown_timeout` IS NAMED IN THE PLAN SO AN APPROVER KNOWS HOW LONG
 * "GRACEFUL" LASTS, and WITH NO UNIT ASSERTED. It is a bare number on the
 * pinned surface, which declares no unit for it, and #96's rule is that a
 * suffix is a claim: an approver acts on "90 seconds" differently from "90
 * minutes", and this repository has read neither. It is optional on the entity,
 * so the unreadable case says so rather than substituting a number.
 */

/** How long {@link vmStop} watches the job it started before reporting what it has. */
const VM_STOP_WATCH_MS = 30_000;

/** Seconds, for the result, so the bound is reported in the unit it is stated in. */
const VM_STOP_WATCH_SECONDS = VM_STOP_WATCH_MS / 1000;

/** What `vm_stop` was asked to do. */
interface VmStopArgs {
  id: number;
  force: boolean;
  forceAfterTimeout: boolean;
}

/**
 * The caller's arguments, or the error naming what is wrong with them.
 *
 * Strict on both booleans for {@link parseVmStartArgs}'s reason, and here the
 * cost of a coercion is a guest destroyed under an approval given for a
 * graceful shutdown.
 */
function parseVmStopArgs(args: Record<string, unknown>): VmStopArgs {
  const id = parseVmId(args);
  const force = args['force'];
  if (force != null && typeof force !== 'boolean') {
    throw new Error('"force" must be a boolean');
  }
  const forceAfterTimeout = args['force_after_timeout'];
  if (forceAfterTimeout != null && typeof forceAfterTimeout !== 'boolean') {
    throw new Error('"force_after_timeout" must be a boolean');
  }
  return { id, force: force === true, forceAfterTimeout: forceAfterTimeout === true };
}

/**
 * The params the job is started with, typed off the job directory — a disjoint
 * key space from the call directory, so `CallParams` cannot name them.
 *
 * Both options are always sent, for {@link vmStartParams}'s reason.
 */
function vmStopParams(args: VmStopArgs): JobParams<ApiSurface, 'vm.stop'> {
  return [args.id, { force: args.force, force_after_timeout: args.forceAfterTimeout }];
}

/**
 * The VM's own ACPI grace period, named and not converted.
 *
 * No unit is asserted, per #96: the surface declares this as a bare number and
 * nothing about a shutdown timeout fixes a unit the way SMART fixes a drive
 * temperature in Celsius.
 */
function shutdownTimeoutPhrase(reading: VmPowerReading): string {
  return reading.shutdown_timeout === null
    ? 'how long it waits is the VM\'s own `shutdown_timeout`, WHICH THIS SYSTEM REPORTED NO ' +
        'VALUE FOR that this tool could read — so how long "graceful" lasts here is NOT ' +
        'established'
    : `how long it waits is the VM's own \`shutdown_timeout\`, which this system records as ` +
        `${reading.shutdown_timeout} — THE API DECLARES NO UNIT FOR THAT NUMBER and none is ` +
        'asserted here, so it is not to be converted';
}

/**
 * Which of the two shutdown paths these arguments select, and what it does.
 *
 * One function because the three combinations are one decision, and every
 * clause in each is load-bearing: the forcing case has to name what is lost,
 * and the graceful cases have to say what happens when the guest does not go.
 */
function stopPathSentence(args: VmStopArgs, reading: VmPowerReading): string {
  if (args.force) {
    return (
      'THIS DESTROYS THE DOMAIN IMMEDIATELY — `force` is true, which is the power-cord case: ' +
      'the guest is not asked to shut down, is given no chance to flush anything it is holding, ' +
      'and WHATEVER IT HAD NOT WRITTEN TO DISK IS LOST. No ACPI shutdown is attempted and the ' +
      "VM's `shutdown_timeout` does not apply. `force_after_timeout` is not reached and makes " +
      'no difference here.'
    );
  }
  const graceful = `This asks the guest to shut down over ACPI and waits for it to go: ${shutdownTimeoutPhrase(
    reading,
  )}.`;
  return args.forceAfterTimeout
    ? `${graceful} IF THE GUEST HAS NOT STOPPED BY THEN THE DOMAIN IS DESTROYED ANYWAY, because ` +
        '`force_after_timeout` is true — so a guest that is slow to shut down, or that ignores ' +
        'ACPI entirely, loses whatever it had not written by that point.'
    : `${graceful} \`force_after_timeout\` is false, so the domain is NOT destroyed when that ` +
        'time runs out. WHAT THE SYSTEM DOES WITH A GUEST THAT HAS NOT STOPPED BY THEN IS ' +
        '(unconfirmed) HERE — it was not read off a live system and the API surface does not ' +
        'say — so a VM still reading as running afterwards is not evidence this call failed.';
}

/**
 * What the plan adds about the state the VM is already in, for a stop.
 *
 * Empty for every state but one, INCLUDING an unreadable one:
 * {@link vmStateSentence} has already said the state could not be read, and a
 * second sentence about it here would be that one restated.
 */
function vmStopEffectSentence(reading: VmPowerReading): string {
  if (reading.state === 'STOPPED') {
    return (
      ' IT ALREADY READ AS `STOPPED` WHEN THIS PLAN WAS MADE, and this plan does not refuse ' +
      'that: whether the middleware treats stopping an already-stopped VM as a no-op or ' +
      'rejects it is (unconfirmed) here.'
    );
  }
  return '';
}

export const vmStop: MutatingTool = {
  name: 'vm_stop',
  description:
    'Powers off one virtual machine on a TrueNAS system and reports how far it ' +
    'got. Two-phase: called without a confirmation_token it returns a plan for ' +
    'user approval; called with one it starts the stop. ONLY THE OLDER ' +
    'LIBVIRT-BACKED VMs CAN BE STOPPED HERE — the ones `vms_list` reports with ' +
    "`source` `vm`. `id` is that entry's numeric `id` on the system being " +
    'targeted; AN ENTRY WHOSE `source` IS `virt_instance` HAS A STRING id AND ' +
    'IS A DIFFERENT STACK THIS TOOL CANNOT REACH. PLANNING AGAINST AN id NO ' +
    'VIRTUAL MACHINE HAS FAILS naming that id. WHICH OF TWO SHUTDOWN PATHS ' +
    'RUNS IS YOUR CHOICE AND THE ARGUMENTS ARE HOW IT IS MADE. `force: true` ' +
    'DESTROYS THE DOMAIN IMMEDIATELY — the power-cord case: the guest is never ' +
    'asked to shut down and ANYTHING IT HAD NOT WRITTEN TO DISK IS LOST. ' +
    '`force: false` (the default) sends an ACPI shutdown and waits the VM\'s ' +
    "own `shutdown_timeout`, and then `force_after_timeout` decides: true " +
    'DESTROYS THE DOMAIN ANYWAY when that time runs out, false does not. Both ' +
    'default false, so the default is the graceful path that never forces. THE ' +
    "PLAN NAMES THE VM'S OWN `shutdown_timeout` so an approver knows how long " +
    'that wait is, AND NO UNIT IS ASSERTED FOR IT: this API declares it as a ' +
    'bare number, nothing in it states what the number counts, and it must not ' +
    'be converted. It is optional on the machine, and the plan says outright ' +
    'where the system reported none. THE RESULT IS ABOUT THE JOB THIS CALL ' +
    'STARTED, AND "STARTED" IS NOT "STOPPED". A graceful shutdown waits on a ' +
    'guest operating system and need not be quick, so this tool WATCHES THE ' +
    'JOB FOR AT MOST `watched_seconds` AND THEN RETURNS WHATEVER IT HAS, ' +
    'leaving the stop going. It never waits for the stop to finish. THE WATCH ' +
    'ALSO ENDS IF FOLLOWING THE JOB FAILS — a dropped connection, a failed ' +
    'read of the job list — and that is reported as what was established ' +
    'rather than as the stop having failed, since it was already under way. A ' +
    'failure BEFORE anything was seen of the job fails this call instead, and ' +
    'even then MAY STILL HAVE STARTED THE STOP: read `vms_list` rather than ' +
    'assuming nothing happened. `ended` is whether the job was ESTABLISHED to ' +
    'have reached a state it will not move out of. TRUE MEANS THE JOB IS OVER. ' +
    'FALSE MEANS NOTHING WAS ESTABLISHED AND IS NOT ONE ANSWER — the stop is ' +
    'still going, or the watch was cut short by either of the failures above, ' +
    'or the job reached a state the system does not treat as ending a run, or ' +
    'the job reported a state this tool could not read, or no job was seen at ' +
    'all. `job_state` and `job_id` narrow that and DO NOT PARTITION IT. IN ' +
    'NONE OF THEM HAS ANYTHING FAILED. `succeeded` is true where the job ENDED ' +
    'in a state this catalog reads as success, false where it ENDED in any ' +
    'other state, and NULL WHERE NOTHING ESTABLISHED IT — which is every case ' +
    'where `ended` is false. A null `succeeded` IS NEITHER A FAILURE NOR A ' +
    'SUCCESS, and A STATE THAT LOOKS LIKE A SUCCESS DOES NOT MAKE ONE: it is ' +
    'null beside a `job_state` of `SUCCESS` where the job was not established ' +
    'to be over. NO STATE THIS CATALOG DOES NOT KNOW IS EVER READ AS A ' +
    'SUCCESS; `SUCCESS` and `FINISHED` are the two it counts. `job_state` is ' +
    'the state the system last reported, passed through as it spelled it. The ' +
    "job's `result` is NOT read and could not settle any of this: `vm.stop` " +
    'returns nothing, so a finished job carries a null result whether it ' +
    'worked or failed. `error` is the text the job recorded and is null where ' +
    'it recorded none. `finished_at` is when the job ended, as an ISO 8601 UTC ' +
    'timestamp, REPORTED ONLY WHERE `ended` IS TRUE and null everywhere else ' +
    'even if the job record carries a time. `job_id` is the job\'s numeric ' +
    'identity, TAKEN FROM THE JOB EVENT THAT NAMED THIS REQUEST rather than ' +
    'from anything read about the job afterwards, so it is reported even where ' +
    'the watch established nothing else; it is null where no such event was ' +
    'seen within the watch, and also where one was seen and the id it carried ' +
    'was not a number this tool could read. NEITHER MEANS THE STOP DID NOT ' +
    'START. `watched_seconds` is the CEILING that applied, not how long the ' +
    'watch actually lasted. THE VM STATES ARE READ RATHER THAN ASSUMED: ' +
    '`vm.stop` answers nothing, so this tool reads `vm.query` immediately ' +
    'before the call and again after the watch ends. `previously_state` and ' +
    "`resulting_state` are those two readings of the middleware's own state " +
    'word, with `previously_domain_state` and `resulting_domain_state` ' +
    "carrying libvirt's own state beside each, exactly as `vms_list` reports " +
    'the pair — a machine that is not running commonly reads `STOPPED` ' +
    'whether it was shut down or died, and `domain_state` is where `CRASHED` ' +
    'or `SHUTOFF` separates those. `resulting_state` IS READ WHEN THE WATCH ' +
    'ENDS AND NOT WHEN THE STOP DOES, so on a VM that is still shutting down ' +
    'it is the state part-way through and not the state it settles in. ' +
    '`changed` IS THE TWO `state` READINGS COMPARED AND NOTHING ELSE — the ' +
    '`domain_state` pair is reported beside them and is NOT part of it — and ' +
    'is NULL WHERE EITHER READING IS, WHICH IS NOT "NOTHING CHANGED". ' +
    '`previous_lookup` and `resulting_lookup` say what each read did: `FOUND`, ' +
    '`NOT_FOUND`, or `UNREADABLE` with `previous_read_error` and ' +
    '`resulting_read_error` naming why. A `FOUND` beside a null state is a ' +
    'fourth case those words do not separate: the machine was listed and ' +
    'reported no state this tool could read. THE CALL IS MADE IN ALL OF THOSE ' +
    'CASES AND NOTHING BRANCHES ON EITHER READ. THIS TOOL CANNOT STOP A ' +
    'RUNNING JOB once it has started one, cannot start a VM (`vm_start` does) ' +
    'or restart one (`vm_restart` does), cannot suspend or resume one, and ' +
    'CANNOT RECOVER DATA A FORCED STOP LOST — starting the VM again boots it ' +
    'from what reached the disk.',
  inputSchema: {
    type: 'object',
    properties: {
      id: {
        type: 'integer',
        description:
          "The virtual machine's numeric `id` as `vms_list` reports it for an " +
          'entry whose `source` is `vm`, on the system being targeted.',
      },
      force: {
        type: 'boolean',
        default: false,
        description:
          'Destroy the domain immediately instead of asking the guest to shut ' +
          'down. The guest is given no chance to flush anything it holds and ' +
          'unwritten data is lost. Default false.',
      },
      force_after_timeout: {
        type: 'boolean',
        default: false,
        description:
          'Destroy the domain if the guest has not shut down within the VM\'s ' +
          'own `shutdown_timeout`. Ignored when `force` is true, which ' +
          'destroys it at once. Default false.',
      },
    },
    required: ['id'],
  },
  requiredRole: Role.Full,
  mutating: true,
  // The operation is reversible in the sense `Destructiveness` names — the VM
  // can be started again, and `vm_start` is in this catalog. What a forced stop
  // does to data the guest had not written is NOT reversible, and this field
  // cannot say both: it records the operation, and the account of the data is
  // in the description and in the plan, which is where the person approving
  // reads it. That division is #122's and is stated at the field's own
  // declaration in `catalog/tool.ts`.
  destructiveness: 'reversible',
  normalizeArgs(rawArgs) {
    const args = parseVmStopArgs(rawArgs);
    return { id: args.id, force: args.force, force_after_timeout: args.forceAfterTimeout };
  },
  async plan(ctx, rawArgs): Promise<PlanStep[]> {
    const args = parseVmStopArgs(rawArgs);
    const reading = await readVmPower(ctx, args.id);
    if (!reading.listed) {
      throw new Error(
        `No virtual machine with id ${args.id} on the \`vm\` stack of this system — ${VM_IDS_FROM}`,
      );
    }
    return [
      vmReadStep(args.id, readAgainAfterWatch(VM_STOP_WATCH_SECONDS)),
      {
        method: 'vm.stop',
        params: vmStopParams(args),
        description:
          `Stop ${describeVm(reading, args.id)}. ${vmStateSentence(reading)}` +
          `${vmStopEffectSentence(reading)} ${stopPathSentence(args, reading)} ` +
          vmWatchSentence(VM_STOP_WATCH_SECONDS),
      },
    ];
  },
  async execute(ctx, rawArgs) {
    const args = parseVmStopArgs(rawArgs);
    const previous = await attemptVmPower(ctx, args.id);
    const job = await watchVmJob(
      ctx,
      ctx.system.client.api.callAndGetJobId('vm.stop', vmStopParams(args)),
      VM_STOP_WATCH_MS,
    );
    // Read after the watch, not after the stop: the two are the same only where
    // the job ended inside the bound, which is why `resulting_state` is
    // described as the state when the watch ended.
    const resulting = await attemptVmPower(ctx, args.id);
    return {
      ...vmPowerOutcome(args.id, previous, resulting),
      requested_force: args.force,
      requested_force_after_timeout: args.forceAfterTimeout,
      watched_seconds: VM_STOP_WATCH_SECONDS,
      ...job,
    };
  },
};

/**
 * `vm_restart`: stopping and starting one libvirt-backed virtual machine, over
 * a job.
 *
 * IT HIDES TWO DECISIONS THE CALLER DOES NOT GET TO MAKE, AND ITS API SURFACE
 * STATES NEITHER. `vm.restart` takes `[id]` and nothing else; the middleware's
 * `restart_vm` is `vm.stop` with `force_after_timeout=True` HARD-CODED,
 * followed by `start_vm` with `overcommit=True` HARD-CODED. So:
 *
 * - A guest that does not shut down within its own `shutdown_timeout` IS
 *   DESTROYED. A caller who would have chosen `force_after_timeout: false` on
 *   {@link vmStop} gets the opposite here and cannot say otherwise.
 * - The start half OVERSUBSCRIBES MEMORY, so a restart starts a VM that
 *   {@link vmStart} would have refused out-of-memory.
 *
 * THE PLAN MUST NOT READ AS "STOP THEN START", because that is the account that
 * omits the forced destruction — #154's shape, reached through a composition
 * rather than through a retention pass.
 *
 * NONE OF THAT IS ON THE API SURFACE, AND THE DESCRIPTION SAYS SO. It is read
 * from the TrueNAS implementation, which is #120's rule pointed the other way:
 * an effect established somewhere this repository cannot check is stated AS
 * THAT, rather than settled. Silence would be read as "a restart is a stop and
 * a start with the defaults", which is the reading that costs a guest's
 * unwritten data.
 *
 * WHAT A RESTART DOES TO AN ALREADY-STOPPED VM IS (unconfirmed). `restart_vm`
 * raises `Failed to stop <name> vm` if its stop half fails, and whether
 * stopping an inactive domain fails depends on `truenas_pylibvirt`'s behaviour
 * against one, which is not readable from this repository and was not run
 * against a live system. So NO already-in-target-state sentence is written for
 * this tool: #119's convention is that saying which it was is the tool's job,
 * and a sentence guessing at it would be exactly the reassurance #154 names as
 * the costly direction to be wrong in.
 */

/**
 * How long {@link vmRestart} watches the job it started before reporting what it
 * has.
 *
 * ITS OWN NUMBER rather than {@link VM_STOP_WATCH_MS}, although the two are
 * equal: the bound is a ceiling on a TOOL's patience and not an estimate of its
 * job (#122), so one shared constant would assert that the two ceilings must
 * move together, which nothing requires. Share a sentence
 * ({@link vmWatchSentence}), not a number.
 */
const VM_RESTART_WATCH_MS = 30_000;

/** Seconds, for the result, so the bound is reported in the unit it is stated in. */
const VM_RESTART_WATCH_SECONDS = VM_RESTART_WATCH_MS / 1000;

/**
 * The params the job is started with, typed off the job directory.
 *
 * One argument, which is the whole problem this tool's description exists to
 * state: there is nowhere in these params for either of the two decisions the
 * middleware makes on the caller's behalf.
 */
function vmRestartParams(id: number): JobParams<ApiSurface, 'vm.restart'> {
  return [id];
}

/**
 * What a restart actually does, in the plan's own words.
 *
 * One string because it is one text: it says the same thing whatever the VM is,
 * and every clause is load-bearing. The forcing clause is what stops an
 * approver reading this as two calls with their defaults; the overcommit clause
 * is what stops "it just comes back up" reading as a start that checked the
 * memory; and the last sentence is what keeps both from reading as something
 * this catalog verified.
 */
const RESTART_COMPOSITION =
  'A RESTART IS NOT A `vm_stop` FOLLOWED BY A `vm_start` WITH THEIR DEFAULTS, and the two ' +
  'differences are both decisions the middleware makes for you and this call has no argument ' +
  'for. FIRST, THE STOP HALF FORCES AFTER THE TIMEOUT: it runs with ' +
  '`force_after_timeout` set, so a guest that has not shut down within its own ' +
  '`shutdown_timeout` IS DESTROYED, losing whatever it had not written to disk — `vm_stop` ' +
  'offers that as a choice and this does not. SECOND, THE START HALF OVERCOMMITS: it runs ' +
  'with `overcommit` set, so the VM is started even where this system does not have enough ' +
  'free memory for every VM configured on it, and a machine `vm_start` would have refused ' +
  'out-of-memory comes back up here. If the stop half fails the start half does not run, so a ' +
  'failed restart can leave the VM stopped. NONE OF THAT IS ON THIS API: `vm.restart` takes ' +
  'the id and nothing else and states none of it — the account is read from the TrueNAS ' +
  'implementation and is NOT something this catalog can check.';

export const vmRestart: MutatingTool = {
  name: 'vm_restart',
  description:
    'Restarts one virtual machine on a TrueNAS system — stopping it and ' +
    'starting it again — and reports how far it got. Two-phase: called ' +
    'without a confirmation_token it returns a plan for user approval; called ' +
    'with one it starts the restart. ONLY THE OLDER LIBVIRT-BACKED VMs CAN BE ' +
    'RESTARTED HERE — the ones `vms_list` reports with `source` `vm`. `id` is ' +
    "that entry's numeric `id` on the system being targeted; AN ENTRY WHOSE " +
    '`source` IS `virt_instance` HAS A STRING id AND IS A DIFFERENT STACK THIS ' +
    'TOOL CANNOT REACH. It takes no other argument. PLANNING AGAINST AN id NO ' +
    'VIRTUAL MACHINE HAS FAILS naming that id. A RESTART IS NOT A `vm_stop` ' +
    'FOLLOWED BY A `vm_start` WITH THEIR DEFAULTS, and the two differences are ' +
    'decisions this call gives you no way to make. THE STOP HALF FORCES AFTER ' +
    "THE TIMEOUT: a guest that has not shut down within the VM's own " +
    '`shutdown_timeout` IS DESTROYED and loses whatever it had not written to ' +
    'disk — `vm_stop` offers that as a choice through `force_after_timeout` ' +
    'and this tool does not. THE START HALF OVERCOMMITS MEMORY: the VM is ' +
    'started even where this system has not got enough free memory for every ' +
    'VM configured on it, so a machine `vm_start` would have refused ' +
    'out-of-memory comes back up here. If the stop half fails the start half ' +
    'does not run, so a failed restart can leave the VM stopped. NEITHER OF ' +
    'THOSE IS ON THIS API SURFACE — `vm.restart` takes the id and nothing else ' +
    'and states none of it — SO THE ACCOUNT ABOVE IS READ FROM THE TRUENAS ' +
    'IMPLEMENTATION AND IS NOT SOMETHING THIS CATALOG CAN CHECK. WHAT A ' +
    'RESTART DOES TO A VM THAT IS ALREADY STOPPED IS (unconfirmed) HERE: it ' +
    'depends on how the stop half behaves against an inactive domain, which is ' +
    'not readable from this repository and was not run against a live system. ' +
    'The plan does not refuse an already-stopped VM and it does not promise ' +
    'the call will be accepted either; use `vm_start` where the machine is ' +
    'known to be off. THE RESULT IS ABOUT THE JOB THIS CALL STARTED, AND ' +
    '"STARTED" IS NOT "RESTARTED". A restart waits on a guest operating system ' +
    'shutting down, so this tool WATCHES THE JOB FOR AT MOST `watched_seconds` ' +
    'AND THEN RETURNS WHATEVER IT HAS, leaving the restart going. It never ' +
    'waits for the restart to finish. THE WATCH ALSO ENDS IF FOLLOWING THE JOB ' +
    'FAILS — a dropped connection, a failed read of the job list — and that is ' +
    'reported as what was established rather than as the restart having ' +
    'failed, since it was already under way. A failure BEFORE anything was ' +
    'seen of the job fails this call instead, and even then MAY STILL HAVE ' +
    'STARTED THE RESTART: read `vms_list` rather than assuming nothing ' +
    'happened. `ended` is whether the job was ESTABLISHED to have reached a ' +
    'state it will not move out of. TRUE MEANS THE JOB IS OVER. FALSE MEANS ' +
    'NOTHING WAS ESTABLISHED AND IS NOT ONE ANSWER — the restart is still ' +
    'going, or the watch was cut short by either of the failures above, or the ' +
    'job reached a state the system does not treat as ending a run, or the job ' +
    'reported a state this tool could not read, or no job was seen at all. ' +
    '`job_state` and `job_id` narrow that and DO NOT PARTITION IT. IN NONE OF ' +
    'THEM HAS ANYTHING FAILED. `succeeded` is true where the job ENDED in a ' +
    'state this catalog reads as success, false where it ENDED in any other ' +
    'state, and NULL WHERE NOTHING ESTABLISHED IT — which is every case where ' +
    '`ended` is false. A null `succeeded` IS NEITHER A FAILURE NOR A SUCCESS, ' +
    'and A STATE THAT LOOKS LIKE A SUCCESS DOES NOT MAKE ONE: it is null ' +
    'beside a `job_state` of `SUCCESS` where the job was not established to be ' +
    'over. NO STATE THIS CATALOG DOES NOT KNOW IS EVER READ AS A SUCCESS; ' +
    '`SUCCESS` and `FINISHED` are the two it counts. `job_state` is the state ' +
    "the system last reported, passed through as it spelled it. The job's " +
    '`result` is NOT read and could not settle any of this: `vm.restart` ' +
    'returns nothing, so a finished job carries a null result whether it ' +
    'worked or failed. `error` is the text the job recorded and is null where ' +
    'it recorded none. `finished_at` is when the job ended, as an ISO 8601 UTC ' +
    'timestamp, REPORTED ONLY WHERE `ended` IS TRUE and null everywhere else ' +
    'even if the job record carries a time. `job_id` is the job\'s numeric ' +
    'identity, TAKEN FROM THE JOB EVENT THAT NAMED THIS REQUEST rather than ' +
    'from anything read about the job afterwards, so it is reported even where ' +
    'the watch established nothing else; it is null where no such event was ' +
    'seen within the watch, and also where one was seen and the id it carried ' +
    'was not a number this tool could read. NEITHER MEANS THE RESTART DID NOT ' +
    'START. `watched_seconds` is the CEILING that applied, not how long the ' +
    'watch actually lasted. THE VM STATES ARE READ RATHER THAN ASSUMED: ' +
    '`vm.restart` answers nothing, so this tool reads `vm.query` immediately ' +
    'before the call and again after the watch ends. `previously_state` and ' +
    "`resulting_state` are those two readings of the middleware's own state " +
    'word, with `previously_domain_state` and `resulting_domain_state` ' +
    "carrying libvirt's own state beside each, exactly as `vms_list` reports " +
    'the pair. `resulting_state` IS READ WHEN THE WATCH ENDS AND NOT WHEN THE ' +
    'RESTART DOES, and a restart passes THROUGH being stopped on its way back ' +
    'up — so a `resulting_state` of `STOPPED` is as likely to be a machine ' +
    'part-way through as one that failed to come back, AND THIS TOOL DOES NOT ' +
    'SEPARATE THE TWO. A `changed: false` ACROSS A RESTART IS THE ORDINARY ' +
    'ANSWER FOR A SUCCESSFUL ONE, since a VM that was running and is running ' +
    'again read the same both times: `changed` IS THE TWO `state` READINGS ' +
    'COMPARED AND NOTHING ELSE — the `domain_state` pair is reported beside ' +
    'them and is NOT part of it — SO IT IS NOT A STATEMENT ABOUT WHETHER THE ' +
    'MACHINE WAS RESTARTED. It is NULL WHERE EITHER READING IS, WHICH IS NOT ' +
    '"NOTHING CHANGED". `previous_lookup` and `resulting_lookup` say what each ' +
    'read did: `FOUND`, `NOT_FOUND`, or `UNREADABLE` with ' +
    '`previous_read_error` and `resulting_read_error` naming why. A `FOUND` ' +
    'beside a null state is a fourth case those words do not separate: the ' +
    'machine was listed and reported no state this tool could read. THE CALL ' +
    'IS MADE IN ALL OF THOSE CASES AND NOTHING BRANCHES ON EITHER READ. THIS ' +
    'TOOL CANNOT STOP A RUNNING JOB once it has started one, cannot start or ' +
    'stop a VM without the other half (`vm_start` and `vm_stop` do), cannot ' +
    'suspend or resume one, and CANNOT RECOVER DATA THE FORCED STOP LOST.',
  inputSchema: {
    type: 'object',
    properties: {
      id: {
        type: 'integer',
        description:
          "The virtual machine's numeric `id` as `vms_list` reports it for an " +
          'entry whose `source` is `vm`, on the system being targeted.',
      },
    },
    required: ['id'],
  },
  requiredRole: Role.Full,
  mutating: true,
  // {@link vmStop}'s reading exactly: the operation is reversible in the sense
  // the field records — the VM is started again by the call itself, and
  // `vm_start` is in this catalog — while what the forced half of the stop does
  // to data the guest had not written is not. The field records the operation
  // and the description carries the account of the data (#122).
  destructiveness: 'reversible',
  normalizeArgs(rawArgs) {
    return { id: parseVmId(rawArgs) };
  },
  async plan(ctx, rawArgs): Promise<PlanStep[]> {
    const id = parseVmId(rawArgs);
    const reading = await readVmPower(ctx, id);
    if (!reading.listed) {
      throw new Error(
        `No virtual machine with id ${id} on the \`vm\` stack of this system — ${VM_IDS_FROM}`,
      );
    }
    return [
      vmReadStep(id, readAgainAfterWatch(VM_RESTART_WATCH_SECONDS)),
      {
        method: 'vm.restart',
        params: vmRestartParams(id),
        description:
          `Restart ${describeVm(reading, id)}. ${vmStateSentence(reading)} ` +
          `${RESTART_COMPOSITION} ` +
          vmWatchSentence(VM_RESTART_WATCH_SECONDS),
      },
    ];
  },
  async execute(ctx, rawArgs) {
    const id = parseVmId(rawArgs);
    const previous = await attemptVmPower(ctx, id);
    const job = await watchVmJob(
      ctx,
      ctx.system.client.api.callAndGetJobId('vm.restart', vmRestartParams(id)),
      VM_RESTART_WATCH_MS,
    );
    // After the watch, not after the restart — and a restart passes through
    // stopped on its way back up, which is why the description refuses to read
    // a `STOPPED` here as a machine that did not come back.
    const resulting = await attemptVmPower(ctx, id);
    return {
      ...vmPowerOutcome(id, previous, resulting),
      watched_seconds: VM_RESTART_WATCH_SECONDS,
      ...job,
    };
  },
};
