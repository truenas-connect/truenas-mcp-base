import { firstValueFrom } from 'rxjs';
import { Role } from '@/interfaces';
import { ApiSurface, ReadOnlyTool, SystemHandle } from '@/catalog/tool';
import {
  booleanOrNull,
  errorText,
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
    'display or passthrough devices, and it does not create, start, stop or ' +
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
 * it" have no answer in this catalog. They are also where "why will this VM not
 * start" usually bottoms out: a missing disk, a NIC on an interface that no
 * longer exists, a passthrough device the host has claimed.
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
 * declares an eighth kind, `ISCSI_DISK`, on the shape a device is CREATED with
 * while leaving it out of the shape a query answers. A caller that treats a
 * null `attributes` as "this device has no configuration" would report an
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
 * the SPICE or VNC console is protected with, declared a plain `string` on this
 * surface, and tool arguments and results are recorded verbatim in the audit
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
 */
function readAttributes(dtype: string, held: Record<string, unknown>): DeviceAttributes | null {
  switch (dtype) {
    case 'CDROM': {
      const cdrom = held as AttributesOf<'CDROM'>;
      return { path: textOrNull(cdrom.path) };
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
      };
    }
    case 'NIC': {
      const nic = held as AttributesOf<'NIC'>;
      return {
        type: textOrNull(nic.type),
        nic_attach: textOrNull(nic.nic_attach),
        mac: textOrNull(nic.mac),
        trust_guest_rx_filters: booleanOrNull(nic.trust_guest_rx_filters),
      };
    }
    case 'PCI': {
      const pci = held as AttributesOf<'PCI'>;
      return { pptdev: textOrNull(pci.pptdev) };
    }
    case 'RAW': {
      const raw = held as AttributesOf<'RAW'>;
      return {
        ...diskFileAttributes(raw),
        path: textOrNull(raw.path),
        exists: booleanOrNull(raw.exists),
        boot: booleanOrNull(raw.boot),
        size: numberOrNull(raw.size),
      };
    }
    case 'DISK': {
      const disk = held as AttributesOf<'DISK'>;
      return {
        ...diskFileAttributes(disk),
        path: textOrNull(disk.path),
        create_zvol: booleanOrNull(disk.create_zvol),
        zvol_name: textOrNull(disk.zvol_name),
        zvol_volsize: numberOrNull(disk.zvol_volsize),
      };
    }
    case 'USB': {
      const usb = held as AttributesOf<'USB'>;
      // The identifiers are one level down, in a record the client declares
      // optional and nullable. Both are null where it held none, which is the
      // same answer this file gives for every unreadable field.
      const identifiers = recordOrNull(usb.usb) ?? {};
      return {
        controller_type: textOrNull(usb.controller_type),
        device: textOrNull(usb.device),
        vendor_id: textOrNull(identifiers['vendor_id']),
        product_id: textOrNull(identifiers['product_id']),
      };
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
  const held = recordOrNull(row.attributes);
  const dtype = held === null ? null : textOrNull(held['dtype']);
  return {
    id: numberOrNull(row.id),
    vm: numberOrNull(row.vm),
    order: numberOrNull(row.order),
    dtype,
    attributes: dtype === null || held === null ? null : readAttributes(dtype, held),
  };
}

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
    'KIND IS REPORTED THROUGH ITS OWN SET OF FIELDS and no field of one kind ' +
    'appears on another, so read `dtype` before reading `attributes`. For ' +
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
    'already defines at least one more kind (`ISCSI_DISK`) than this API ' +
    'surface answers queries with — SO A NULL `attributes` BESIDE A NON-NULL ' +
    '`dtype` IS A DEVICE THAT IS THERE AND CONFIGURED, whose configuration ' +
    'this tool does not read, and never a device with nothing configured. ' +
    '`attributes` and `dtype` are BOTH null where the device\'s configuration ' +
    'could not be read at all; such a row is still listed rather than dropped, ' +
    'because a shorter list would say the machine does not have that device, ' +
    'which is exactly the wrong answer to give about a VM that will not start. ' +
    'Every field is null where the system reported no value this tool could ' +
    'read, which is never the same as a device configured without one. AN ' +
    'EMPTY `devices` LIST IS A SYSTEM WITH NO LIBVIRT-BACKED VM DEVICES AT ' +
    'ALL, which includes a system with no libvirt-backed VMs; a machine that ' +
    'appears in `vms_list` and in no row here has no devices attached. This ' +
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
      throw new Error(`The virtual machine devices could not be listed: ${errorText(reason)}`, {
        cause: reason,
      });
    }
    // `query` types its answer as a list of rows, and that is a claim about
    // what the middleware sends rather than the value received: the call
    // directory declares this method as answering a union that also admits a
    // bare row and a count. Checked here so a non-list is that message rather
    // than a `.map` throwing out of the handler.
    if (!Array.isArray(rows)) throw new Error(NOT_A_DEVICE_LIST);
    return { devices: rows.map(readDevice) };
  },
};
