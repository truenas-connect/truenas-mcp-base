import { firstValueFrom } from 'rxjs';
import { Role } from '@/interfaces';
import { ReadOnlyTool } from '@/catalog/tool';

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

/** One string field of a row, or null where the system reported no value.
 *
 * An empty string is read as no value rather than as text of no characters, the
 * same reading `alerts.ts`, `credentials.ts`, `network.ts`, `block.ts` and
 * `shares.ts` each hold under their own names — and restated here for the
 * reason those files give for restating it: a tool file is read on its own. */
function textOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** A finite number the system reported, or null where it reported anything
 * else. Infinite and NaN are not counts or byte totals, whatever else they
 * are. */
function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** A boolean the system reported, or null where it reported anything else. */
function booleanOrNull(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

/** A nested object of a row, or null where the row held anything else.
 *
 * `typeof null` is `'object'`, so the null check is what stops a reported-as-null
 * `status` being indexed. An array is an object too and is excluded: the one
 * thing read through this is a VM's status record, and reading a list as one
 * would answer null for every field rather than saying the shape was not what
 * this tool reads. */
function recordOrNull(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/** What a failure carrying no text of its own is reported as. */
const NO_REASON = 'the system reported no reason';

/**
 * Why a read failed, in words.
 *
 * A rejection is not necessarily an `Error` — the client rejects with whatever
 * the transport gave it — so a bare string is read too, and so are the two
 * shapes the client documents as its own: a JSON-RPC error object carrying
 * `message`, and a middleware error object carrying `reason`. `alerts.ts`,
 * `block.ts`, `network.ts` and `shares.ts` each hold this same reading under
 * their own names. The result is never empty, because a failure with no text
 * still has to read as a failure.
 */
function errorText(reason: unknown): string {
  if (reason instanceof Error) return textOrNull(reason.message) ?? NO_REASON;
  if (typeof reason === 'object' && reason !== null) {
    const carrier = reason as Record<string, unknown>;
    return textOrNull(carrier['reason']) ?? textOrNull(carrier['message']) ?? NO_REASON;
  }
  return textOrNull(reason) ?? NO_REASON;
}

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
function fromVmStack(entry: object): VmRow {
  const row = entry as Record<string, unknown>;
  const status = recordOrNull(row['status']);
  const memory = numberOrNull(row['memory']);
  const minMemory = numberOrNull(row['min_memory']);
  return {
    source: 'vm',
    id: numberOrNull(row['id']),
    name: textOrNull(row['name']),
    // The middleware's own word for the state. `domain_state` beside it is
    // libvirt's, and the two are reported separately rather than merged
    // because they are different vocabularies and a caller cannot tell which
    // one arrived once they share a field.
    state: textOrNull(status?.['state']),
    domain_state: textOrNull(status?.['domain_state']),
    vcpus: totalVcpus(row['vcpus'], row['cores'], row['threads']),
    // A CPU set is a `virt.instance` notion; this stack pins with `cpuset`,
    // which is a different field and is not reported. Null keeps the column
    // meaning one thing across both stacks.
    cpu_set: null,
    memory_bytes: memory === null ? null : memory * BYTES_PER_MIB,
    min_memory_bytes: minMemory === null ? null : minMemory * BYTES_PER_MIB,
    autostart: booleanOrNull(row['autostart']),
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
function fromVirtStack(entry: object): VmRow {
  const row = entry as Record<string, unknown>;
  const cpu = textOrNull(row['cpu']);
  const plainCount = cpu !== null && /^\d+$/.test(cpu) ? Number(cpu) : null;
  return {
    source: 'virt_instance',
    id: textOrNull(row['id']),
    name: textOrNull(row['name']),
    state: textOrNull(row['status']),
    // libvirt's domain state has no counterpart on this stack; `status` above
    // already distinguishes ERROR from STOPPED on its own.
    domain_state: null,
    vcpus: plainCount,
    cpu_set: plainCount === null ? cpu : null,
    memory_bytes: numberOrNull(row['memory']),
    min_memory_bytes: null,
    autostart: booleanOrNull(row['autostart']),
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
    'machines: incus containers are excluded, applications are `apps_list`, ' +
    'and the log output of one VM is `vm_logs`. It does not report a VM\'s ' +
    'disks, network interfaces, display or passthrough devices, and it does ' +
    'not create, start, stop or change one. NO field beyond those named here ' +
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
