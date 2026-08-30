import { firstValueFrom } from 'rxjs';
import { Role } from '@/interfaces';
import { ReadOnlyTool, SystemHandle } from '@/catalog/tool';
import {
  booleanOrNull,
  errorText,
  numberOrNull,
  recordOrNull,
  textOrNull,
} from '@/tools/common';

/**
 * The boot pool: the ZFS pool the system itself runs from, and the boot
 * environments held on it.
 *
 * `storage_pool_status` and `storage_pool_topology` read `pool.query`, which
 * lists data pools and not this one, so before this tool the device the system
 * actually boots from was invisible to the whole catalog. A boot device on its
 * way out is exactly the thing worth flagging before it strands the machine.
 *
 * The boot environments are the other half of the same question. They are what
 * a failed update falls back to, so "is it safe to update this system" partly
 * means "does it have an environment to return to".
 *
 * The two are SEPARATE READS and either can fail on its own, so each is a
 * section carrying its own `unavailable` rather than one read that can take the
 * whole answer down. Nothing here mutates: activating, cloning, destroying and
 * scrubbing all exist on the middleware and none of them is in this catalog.
 */

/** What a system answering `boot.get_state` with something else is reported as. */
const NOT_A_POOL_STATE = 'the system did not answer with a boot pool state';

/** What a system answering `boot.environment.query` with something else is reported as. */
const NOT_A_LIST = 'the system did not answer with a list of boot environments';

/** The boot pool as this tool reports it. */
interface BootPool {
  name: string | null;
  status: string | null;
  healthy: boolean | null;
  warning: boolean | null;
  status_code: string | null;
  status_detail: string | null;
  features_current: boolean | null;
  size_bytes: number | null;
  allocated_bytes: number | null;
  free_bytes: number | null;
}

/** One boot environment as this tool reports it. */
interface BootEnvironment {
  name: string | null;
  active: boolean | null;
  active_on_reboot: boolean | null;
  size_bytes: number | null;
  created_at: string | null;
}

/**
 * One section read, or the reason it could not be — the per-family attempt pair
 * `system.ts` and `fleet.ts` each keep, generic over this family's own two
 * payloads and no further. It stays in this file rather than moving to
 * `common.ts`: what the four files holding one of these share is the shape, not
 * the function, and generalising over the failure type would couple every
 * family to one signature for no gain.
 */
interface Attempt<T> {
  value: T | null;
  error: string | null;
}

/**
 * The boot pool's state, with a failure named rather than thrown.
 *
 * The payload is read through `recordOrNull` rather than reached into, for the
 * reason `audit_config` gives: a system answering the call with something that
 * is not a pool state would otherwise throw naming a property, and the caller
 * would see the name of a field rather than the read that failed. Here it is
 * not thrown at all — a boot pool that could not be read must still leave the
 * environments section answering.
 *
 * `scan` and `expand` are read by nothing here and are deliberately absent from
 * the result. Both arrive as open records the generated types do not describe,
 * and passing either through would put whatever a later TrueNAS release adds to
 * them into a tool result — the allowlist convention this repository keeps. The
 * one reading of a ZFS scan record in this repository is `pools.ts`'s, and it is
 * that family's: it carries a scrub-vs-resilver vocabulary decided for data
 * pools. See the decision in `CLAUDE.md`.
 */
async function readPool(system: SystemHandle): Promise<Attempt<BootPool>> {
  try {
    const answer = await firstValueFrom(system.client.api.call('boot.get_state'));
    const state = recordOrNull(answer);
    if (state === null) return { value: null, error: NOT_A_POOL_STATE };
    return {
      value: {
        name: textOrNull(state['name']),
        // A bare string with no declared union, so it is passed through as the
        // system spelled it and the description says the set is not closed.
        status: textOrNull(state['status']),
        // Independent, not two points on one scale: a pool can be healthy and
        // still be carrying a warning, and the two are reported side by side
        // rather than collapsed into a verdict this tool has not been given.
        healthy: booleanOrNull(state['healthy']),
        warning: booleanOrNull(state['warning']),
        status_code: textOrNull(state['status_code']),
        status_detail: textOrNull(state['status_detail']),
        // `is_upgraded` is optional in the payload, so it has three states and
        // not two — upgraded, not upgraded, and not reported at all. Read
        // through `booleanOrNull`, an absent field becomes null, which is what
        // keeps "the pool is behind" and "the system did not say" apart.
        features_current: booleanOrNull(state['is_upgraded']),
        size_bytes: numberOrNull(state['size']),
        allocated_bytes: numberOrNull(state['allocated']),
        free_bytes: numberOrNull(state['free']),
      },
      error: null,
    };
  } catch (reason) {
    return { value: null, error: errorText(reason) };
  }
}

/**
 * One boot environment, every field read through a guard.
 *
 * An entry the system sent that this tool cannot read as a record is KEPT, as a
 * row of nulls, rather than dropped. A list one entry shorter would understate
 * how many environments the pool holds — and the unreadable entry may be the
 * active one, which is why the description says an absence of `active: true` is
 * not evidence that no environment is active.
 */
function mapEnvironment(row: unknown): BootEnvironment {
  const held = recordOrNull(row);
  return {
    // `id` is what the middleware names a boot environment by; there is no
    // separate name field.
    name: held === null ? null : textOrNull(held['id']),
    active: held === null ? null : booleanOrNull(held['active']),
    // `activated` is the middleware's name for the environment marked to boot
    // next, which is a different question from `active` and one letter away
    // from it in the payload. Renamed here so the two cannot be read as each
    // other.
    active_on_reboot: held === null ? null : booleanOrNull(held['activated']),
    size_bytes: held === null ? null : numberOrNull(held['used_bytes']),
    // The creation time as the system reports it, passed through as text rather
    // than parsed: the client declares it a string, and a timestamp in a shape
    // this tool guessed at would be confidently wrong about a timezone instead
    // of absent.
    created_at: held === null ? null : textOrNull(held['created']),
  };
}

/**
 * The boot environments, with a failure named rather than thrown.
 *
 * An answer that is not a list at all is reported as this section being
 * unreadable rather than as the pool holding no environments — the difference
 * between "no fallback exists" and "nothing was established about the
 * fallbacks", which on this subject are opposite answers.
 */
async function readEnvironments(system: SystemHandle): Promise<Attempt<BootEnvironment[]>> {
  try {
    const rows = await firstValueFrom(system.client.api.query('boot.environment.query'));
    if (!Array.isArray(rows)) return { value: null, error: NOT_A_LIST };
    return { value: rows.map(mapEnvironment), error: null };
  } catch (reason) {
    return { value: null, error: errorText(reason) };
  }
}

/**
 * The `pool` section's fields on a read that did not happen.
 *
 * Spelled out rather than left off, because `undefined` serializes to no key at
 * all: a caller would receive an object missing fields the description promises
 * — a shape it has not been told about — rather than nulls it can see are
 * absent. The same reading `pools.ts` gives for a field the middleware omitted.
 */
const UNREAD_POOL: BootPool = {
  name: null,
  status: null,
  healthy: null,
  warning: null,
  status_code: null,
  status_detail: null,
  features_current: null,
  size_bytes: null,
  allocated_bytes: null,
  free_bytes: null,
};

export const bootPoolStatus: ReadOnlyTool = {
  name: 'boot_pool_status',
  description:
    'The health of the ZFS pool a TrueNAS system BOOTS FROM, and the boot ' +
    'environments held on it. NOTHING ELSE IN THIS CATALOG REPORTS THE BOOT ' +
    'POOL: `storage_pool_status`, `storage_pool_topology` and ' +
    '`storage_scrub_history` all read the data pools and none of them lists ' +
    'this one, so a healthy answer from those says nothing about the device ' +
    'the system itself runs from. The result has TWO SECTIONS, `pool` and ' +
    '`environments`, which come from SEPARATE READS AND CAN FAIL ' +
    'INDEPENDENTLY. Each carries `unavailable`: null where that section was ' +
    'read, and otherwise what the system said about the failure — and then ' +
    'EVERY OTHER FIELD IN THAT SECTION IS NULL BECAUSE IT WAS NOT READ, not ' +
    'because the system reported nothing. A failure in one section never ' +
    'empties or falsifies the other. ' +
    'In `pool`: `name` is what the boot pool is called, `status` is the ' +
    "system's own word for its state — ONLINE, DEGRADED and FAULTED are the " +
    'common ones, and THE SET IS NOT CLOSED, so any other value is passed ' +
    'through as the system spelled it and should be read as itself. `healthy` ' +
    'and `warning` are INDEPENDENT and are not two points on one scale: a boot ' +
    'pool can be healthy and still be carrying a warning. `healthy` true is ' +
    'the system reporting the pool as healthy and `healthy` FALSE IS A ' +
    'POSITIVE FINDING that it reported it as not healthy — something is wrong ' +
    'with the pool the system boots from. `warning` true is the system raising ' +
    'a warning about it and `warning` false is the system raising none, which ' +
    'is also a positive finding. EITHER IS NULL WHERE THE SYSTEM REPORTED NO ' +
    'VALUE THIS TOOL COULD READ, and a null is neither of those answers — a ' +
    'null `healthy` must never be read as healthy, and a null `warning` must ' +
    'never be read as no warning. `status_code` is a symbol to match on and ' +
    '`status_detail` is prose written for a person saying what is wrong; each ' +
    'is null where the system reported no text this tool could read, which on ' +
    'a healthy pool is the normal case and is not a finding. ' +
    '`features_current` is whether the ' +
    "pool's on-disk ZFS features have been upgraded to what the running " +
    'version supports: true where the system reported them upgraded, FALSE ' +
    'WHERE IT REPORTED THEM NOT UPGRADED — a pool that still works and is ' +
    'behind the version running on it — and NULL WHERE IT DID NOT REPORT AN ' +
    'UPGRADE STATE AT ALL. Those last two are different answers and null is ' +
    'never to be read as the false one. `size_bytes`, `allocated_bytes` and ' +
    '`free_bytes` are the pool total, what is used and what is left, in bytes, ' +
    'each null where the system reported no number this tool could read. THE ' +
    "BOOT POOL'S SCAN AND EXPANSION RECORDS ARE NOT REPORTED — no scrub " +
    'outcome, state, time or error count for the boot pool is available from ' +
    'this tool or from any other in this catalog, and `storage_scrub_history` ' +
    'covers the DATA pools only. Do not read its answer as covering this pool. ' +
    'In `environments`: `entries` is one entry per boot environment, in the ' +
    'order the system listed them, and is NULL WHENEVER `unavailable` IS ' +
    'NON-NULL. An EMPTY `entries` is a different answer — the system listed ' +
    'the environments and there were none — and null is never to be read as ' +
    'that. `name` is what the environment is called. `active` is whether it is ' +
    'the one the system is running from NOW; `active_on_reboot` is whether it ' +
    'is the one marked to be used at the NEXT boot. THOSE ARE DIFFERENT ' +
    'QUESTIONS: an environment activated but not yet booted into has ' +
    '`active_on_reboot` true and `active` false, which is a system whose next ' +
    'restart changes what it runs. `size_bytes` is what the environment ' +
    'occupies on the boot pool and `created_at` is when it was made, as the ' +
    'system reports it, in whatever format the system used. Any field is null ' +
    'where the system reported no value this tool could read. AN ENTRY WHOSE ' +
    'FIELDS ARE ALL NULL IS STILL AN ENVIRONMENT THE SYSTEM LISTED: it is ' +
    'kept rather than dropped, so the number of entries stays true — and ' +
    'because such an entry may be the active one, NO ENTRY REPORTING `active` ' +
    'TRUE IS NOT EVIDENCE THAT NONE IS ACTIVE. This tool only reports. It does ' +
    'not activate, clone, rename, destroy or keep a boot environment, it does ' +
    'not scrub the boot pool or set its scrub schedule, and it does not report ' +
    'the physical disks under the boot pool.',
  inputSchema: { type: 'object', properties: {} },
  requiredRole: Role.ReadOnly,
  mutating: false,
  async handler({ system }) {
    // Both reads are issued before either is awaited, so neither waits on the
    // other, and neither can fail the tool: the answer to "is the boot device
    // in trouble" and the answer to "is there an environment to fall back to"
    // are separately useful, and losing one must not lose the other.
    const [pool, environments] = await Promise.all([readPool(system), readEnvironments(system)]);
    return {
      pool: { unavailable: pool.error, ...(pool.value ?? UNREAD_POOL) },
      environments: { unavailable: environments.error, entries: environments.value },
    };
  },
};
