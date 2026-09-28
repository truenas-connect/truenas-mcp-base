import { firstValueFrom, Observable, timer } from 'rxjs';
import type { Subscription } from 'rxjs';
import type { Container, OperationMappings } from '@truenas/api-client';
import { Role } from '@/interfaces';
import { MutatingTool, PlanStep, ReadOnlyTool, ToolContext } from '@/catalog/tool';
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
 * Containers family: the incus-backed container stack, listed and powered.
 *
 * THE SEAM IS `client.ops` AND NOT `api.call`, and this is the first family in
 * the catalog written that way. `ApiDirectoryByVersion` resolves which methods
 * EXIST; it has nothing for a method that changes SHAPE between versions, and
 * every operation here does:
 *
 * | operation          | v25.10                                    | v26+                              |
 * |--------------------|-------------------------------------------|-----------------------------------|
 * | `containerQuery`   | `virt.instance.query`, `type=CONTAINER`   | `container.query`                 |
 * | `containerStart`   | `virt.instance.start`, a job              | `container.start`, SYNCHRONOUS    |
 * | `containerStop`    | `virt.instance.stop`, a job               | `container.stop`, a job           |
 * | `containerRestart` | `virt.instance.restart`, a job            | `container.stop` then a sync start|
 *
 * The client states the trap on `containerDelete` in its own words: reaching for
 * `api.call('container.delete', …)` is the wrong verb, because the method moved
 * out of the call directory when middleware made it a job — it "does not compile
 * on v26+ and would not track the job if it did". The same reasoning covers the
 * whole family, so nothing in this file dials a middleware method by name.
 *
 * WHAT `ops` ABSORBS IS NOT EVERYTHING, WHICH IS WHY THE VERSION IS STILL
 * REPORTED. Four of `container_list`'s fields are populated by one version's
 * mapping and never set by the other's, and `force` means a different thing on
 * each. A caller cannot read either without knowing which mapping ran, so
 * `container_list` reports the negotiated version and every plan here names it.
 * That is reporting a fact, never dispatching on one: nothing in this file
 * branches on the version, which is the whole point of the seam.
 *
 * THREE VERBS ARE THREE TOOLS HERE, which is #164's test rather than an
 * inconsistency with `service_control`. That tool is one because the middleware
 * offers one method taking a verb; these are three because `ops` offers three
 * operations with three signatures — `containerStart(id)` takes no options at
 * all, and the other two take a REQUIRED `force`. A `verb` enum over them would
 * have to accept options that are meaningless for one of its values.
 *
 * `container_delete` IS ABSENT BY POLICY and is not an oversight. Its
 * `recursive` option destroys the container's dataset, its child datasets, its
 * snapshots, clones of those snapshots wherever they live in the pool, and any
 * holds on them; the client's own docstring says releasing a hold can break a
 * replication task and that none of it is recoverable. A tool exposing that
 * composes an irreversible destruction, which `catalog/tool.ts` refuses at
 * registration.
 *
 * THE TEST SEAM IS THE REAL MAPPING OVER A FAKE `api` (#173's option 2), and the
 * fixture is `src/testing/ops-systems.ts`. Faking `client.ops` instead would
 * have asserted these tools against this repository's own belief about what each
 * version emits — and the beliefs that matter here are not obvious: v26+
 * `containerStart` emits `null` and never a job, v26+ `containerRestart` emits
 * the stop job's updates and THEN a `null`, and it buffers those updates so
 * nothing is emitted at all until the stop job has finished. The fixture's own
 * comment carries the rest of the reasoning.
 */

/**
 * The two option types, derived from the operations rather than imported.
 *
 * `ContainerStopOptions` and `ContainerRestartOptions` are declared by the
 * client and are NOT on its barrel, so there is no name to import; and naming a
 * generated type is what #91 rules out anyway. Reading them off
 * `OperationMappings` is the same move `block.ts` and `network.ts` make with
 * `QueryEntity` and `CallResponse`.
 */
type StopOptions = Parameters<OperationMappings['containerStop']>[1];
type RestartOptions = Parameters<OperationMappings['containerRestart']>[1];

/**
 * The negotiated API version of the system being targeted, or null where it
 * could not be read.
 *
 * Read as an open record rather than through the declared `ApiVersion`, per #91:
 * a declared type is a claim about what a connection carries and not the value
 * received, and this one is read for a caller to act on.
 */
function negotiatedVersion(ctx: ToolContext): string | null {
  return textOrNull(recordOrNull(ctx.system.client.version)?.['version']);
}

/** How a plan names the version, in the one wording all three verbs use. */
function versionSentence(ctx: ToolContext): string {
  const version = negotiatedVersion(ctx);
  return version === null
    ? 'THE API VERSION NEGOTIATED WITH THIS SYSTEM COULD NOT BE READ, so which of the two ' +
        'readings below applies to this call is NOT established here.'
    : `The API version negotiated with this system is \`${version}\`.`;
}

/**
 * Every container this system reports, as the client's mapping normalized them.
 *
 * NO GUARD OVER THE LIST OR THE ROW SHAPE, and that is #91's rule applied
 * exactly rather than relaxed. `Container` is not a middleware payload reaching
 * this file: the mapping builds each row itself, out of object literals, over a
 * list it has already `map`ped — so a payload that is not a list of records
 * fails inside the client, with the client's own message, before anything here
 * runs. What the mapping does NOT do is narrow the VALUES it copies across, so
 * every field is read through a guard in {@link readContainerRow}. The shape is
 * the client's own construction and the contents are the middleware's.
 *
 * A read that failed is left to fail rather than reported as an empty list: a
 * listing that could not be read is not a system running no containers, and
 * `fanOut` already reports a thrown read as a per-system `ERROR`.
 */
async function queryContainers(ctx: ToolContext): Promise<Container[]> {
  return firstValueFrom(ctx.system.client.ops.containerQuery());
}

// ─── container_list ──────────────────────────────────────────────────────────

/**
 * One container, in the shape this tool reports it.
 *
 * MAPPED FIELD BY FIELD AND NOT BY TRIMMING, which here is not only the house
 * allowlist rule. `Container.image` is DECLARED as `{ description }` and the
 * v25.10 mapping spreads the whole `VirtInstanceImage` into it — architecture,
 * os, release, serial, type, variant, secureboot — so forwarding the object
 * would put seven undeclared fields into a tool result, and a field a later
 * release adds to that payload after them. `image_description` is the one field
 * read out of it.
 */
interface ContainerRow {
  id: string | null;
  name: string | null;
  status: string;
  autostart: boolean | null;
  description: string | null;
  cpu: string | null;
  memory: number | null;
  image_description: string | null;
}

/**
 * `status` IS THE ONE FIELD NOT READ THROUGH A GUARD, and the reason is that a
 * guard there would describe a case that cannot arise. The client maps the
 * middleware's state word through its own total function, which answers
 * `UNKNOWN` for anything it has no word for — so a listed container always
 * carries one of eight strings. A state the middleware sent as something other
 * than a word fails that function and takes THE WHOLE LISTING with it, rather
 * than nulling one row's status; a `textOrNull` here would have promised a null
 * this tool can never answer with.
 */
function readContainerRow(row: Container): ContainerRow {
  return {
    id: textOrNull(row.id),
    name: textOrNull(row.name),
    status: row.status,
    autostart: booleanOrNull(row.autostart),
    description: textOrNull(row.description),
    cpu: textOrNull(row.cpu),
    // No unit is asserted (#96). The middleware declares this a bare number and
    // nothing about a container's memory allowance fixes a unit the way SMART
    // fixes a drive temperature in Celsius.
    memory: numberOrNull(row.memory),
    // The one field read out of the image record, which the v25.10 mapping
    // populates with the whole `VirtInstanceImage` rather than the single
    // declared field. Read as an open record for that reason.
    image_description: textOrNull(recordOrNull(row.image)?.['description']),
  };
}

/**
 * The interpretation half of `container_list`'s description (#131), hoisted so
 * the two fields cannot drift apart.
 *
 * It carries one sentence that is selection class by `resultGuidance`'s own
 * rule — the pointer at `vms_list` for the other stack — which a caller needs
 * before choosing this tool rather than after. The follow-up that stops
 * appending this to `description` must leave that sentence there.
 */
const CONTAINER_LIST_RESULT_GUIDANCE =
  '`api_version` is the API version negotiated with this system, and FOUR OF ' +
  'THE FIELDS BELOW CANNOT BE READ WITHOUT IT. The client normalizes two ' +
  'different middleware payloads into one shape and neither fills all of it: ' +
  'on v25.10 `cpu`, `memory` and `image_description` are reported and ' +
  '`description` is NEVER SET; on v26 and later `description` is reported and ' +
  '`cpu`, `memory` and `image_description` are NEVER SET. A null in any of the ' +
  'four therefore has THREE CAUSES AND THIS TOOL SEPARATES NONE OF THEM: this ' +
  'version does not report that field at all; or it does and the container has ' +
  'no such value; or it does, the container had one, and it arrived in a form ' +
  'this tool would not read — the client copies these four across WITHOUT ' +
  'narrowing them, so a `cpu` that was not text or a `memory` that was not a ' +
  'finite number reads as null exactly like an absent one. `api_version` rules ' +
  'the FIRST cause in or out and says nothing about the other two; where it is ' +
  'null, none of the three is established. `containers` is every container on the ' +
  'system, unbounded: the operation takes no filter and no limit, so there is ' +
  'nothing to cap and nothing is dropped. An EMPTY list is a system running no ' +
  'containers; a listing that could not be read fails this tool instead and is ' +
  'reported as a failure for that system rather than as an empty list. `id` is ' +
  'the identifier the three power tools take, ON THIS SYSTEM AND AT THIS ' +
  'VERSION: it is the incus instance name on v25.10 and the decimal container ' +
  'id on v26 and later, so it is not portable between systems and must be read ' +
  'from this tool against the system being targeted. `status` is the state ' +
  'word the client normalized the payload to — `RUNNING`, `STOPPED`, ' +
  '`STOPPING`, `DEPLOYING`, `SUSPENDED`, `SUSPENDING`, `ERROR` or `UNKNOWN` — ' +
  'and `UNKNOWN` is a state the mapping had no word for, NOT a container at ' +
  'rest. `SUSPENDED` is paused with its memory retained and is not stopped ' +
  'either. IT IS NEVER NULL: the mapping is total over the state word, and a ' +
  'state it cannot read at all FAILS THE WHOLE LISTING rather than nulling one ' +
  "container's. `autostart` is whether the system brings it up at boot; on v26 and " +
  'later a container that reported no value for it reads `false`, which is the ' +
  "client's own default and not a value read off the system. `memory` is a " +
  'bare number WITH NO UNIT REPORTED — the API declares none and none is ' +
  'asserted here, so it is not to be converted. `cpu` is the CPU allowance as ' +
  'the system spelled it. `image_description` is the one field read out of the ' +
  "image record; the rest of that record is not reported. This tool reads and " +
  'changes nothing. IT DOES NOT LIST VIRTUAL MACHINES OF ANY KIND — the ' +
  'operation behind it filters to containers, and `vms_list` is what reports ' +
  'the libvirt-backed and incus-backed VMs.';

export const containerList: ReadOnlyTool = {
  name: 'container_list',
  description:
    'Lists the containers on a TrueNAS system — the incus-backed container ' +
    'stack — with the state each is in, whether it starts at boot, and what ' +
    'the system records about its size and image. THIS IS THE CONTAINER STACK ' +
    'AND NOT EITHER VM STACK: `vms_list` reports virtual machines, including ' +
    'the incus-backed ones that share this subsystem, and nothing here ' +
    'overlaps it. It reads through the version-agnostic container operation, ' +
    'so it answers on every supported TrueNAS version without the caller ' +
    'choosing a method — but the two versions populate DIFFERENT FIELDS, which ' +
    'is why the negotiated version is reported beside the containers. ' +
    'The `id` reported here is what `container_start`, `container_stop` and ' +
    '`container_restart` take, and it is per-system. ' +
    CONTAINER_LIST_RESULT_GUIDANCE,
  resultGuidance: CONTAINER_LIST_RESULT_GUIDANCE,
  inputSchema: { type: 'object', properties: {} },
  requiredRole: Role.ReadOnly,
  mutating: false,
  async handler(ctx) {
    return {
      api_version: negotiatedVersion(ctx),
      containers: (await queryContainers(ctx)).map(readContainerRow),
    };
  },
};

// ─── the three power tools ───────────────────────────────────────────────────

/**
 * `container_start`, `container_stop` and `container_restart`: power control for
 * one incus-backed container.
 *
 * THE THREE ARE ONE DELIVERABLE, as the VM power tools are (#161).
 * `destructiveness: 'reversible'` records the operation and is not a promise
 * that this catalog can undo it (#153); a `container_start` shipped alone would
 * again be a `reversible` mutation whose reversal is an obvious, already-typed
 * operation that no tool offers.
 *
 * EVERY OUTCOME IS READ BY RE-READING. None of the three operations answers with
 * an updated entity — they answer with job updates, or with nothing — so each
 * `execute` lists the containers before its call and again after its watch ends.
 * BOTH READS ARE THE SAME CALL, so the plan lists it ONCE and that step says in
 * words that it runs again (#156).
 *
 * NOTHING BRANCHES ON EITHER READ. The operation is invoked whatever the reads
 * said, including where they failed, because `execute` is contractually a pure
 * function of (args, system).
 *
 * WHAT THE `ops` SEAM COSTS IS THE JOB-ID CORRELATION, AND IT IS STATED RATHER
 * THAN HIDDEN. #122 has a job-backed tool call `callAndGetJobId` and `trackJob`
 * apart, so that a failure while FOLLOWING a job is reported as what was
 * established rather than as the call failing, and so that the job id survives
 * it. `ops` pipes those two stages together inside `api.job` and hands back a
 * single `Observable<Job | null>`, so the seam between them is not reachable
 * from here. What this file can separate is coarser: an error after at least one
 * emission ends the watch and reports what was established, and an error before
 * any emission fails the call. A failure in the window between the middleware
 * accepting the operation and the first emission therefore reports as a failed
 * call when the operation is running. That is a real cost of the route and the
 * descriptions say so; it is not a reason to dial the middleware methods
 * directly, which would not compile across the versions this family exists to
 * cover.
 *
 * THE OTHER COST IS THAT THE BOUND CANNOT CUT THE SUBSCRIPTION, and that one is
 * a correctness constraint rather than a reporting one. See
 * {@link watchOperation}: a composed operation has a stage that has NOT been
 * dialled yet when the bound expires, so unsubscribing would cancel half of it.
 */

/** Where the ids these three tools take come from, in the one wording used throughout. */
const CONTAINER_IDS_FROM =
  'the ids these tools take come from `container_list`, read against the system being targeted';

/**
 * The one identifier all three operations take, or the error naming what is
 * wrong with it.
 *
 * A STRING, and a number is refused by name. This is #161's trap in the
 * opposite direction: `vm_start`, `vm_stop` and `vm_restart` take a NUMBER, and
 * a caller holding a VM's numeric id has an identifier these tools cannot take.
 * Refusing it here is clearer than letting it reach an operation that would
 * coerce it — on v26 and later the id is parsed as a decimal integer, so a
 * number arriving as one would name a container rather than fail.
 */
function parseContainerId(args: Record<string, unknown>): string {
  const id = args['id'];
  if (typeof id !== 'string' || id.length === 0) {
    throw new Error(
      '"id" is required and must be a non-empty STRING — the `id` `container_list` reports, ' +
        'which is the incus instance name on TrueNAS 25.10 and the decimal container id on 26 ' +
        'and later. A NUMBER is the id the `vm_start`/`vm_stop`/`vm_restart` tools take for a ' +
        'libvirt-backed virtual machine, which is a different stack these tools cannot reach.',
    );
  }
  return id;
}

/**
 * The `force` a caller must choose, or the error naming what is wrong with it.
 *
 * REQUIRED AND NEVER DEFAULTED, because the client's own option type declares it
 * required and because it decides what happens to a guest that does not go. A
 * coerced `"false"` would force a container down under an approval given for the
 * opposite, which is not a narrower answer to the question asked but a different
 * one.
 */
function parseForce(args: Record<string, unknown>): boolean {
  const force = args['force'];
  if (typeof force !== 'boolean') {
    throw new Error(
      '"force" is required and must be a boolean — this operation has no default for it, and ' +
        'what each value does to a running container is stated in the plan.',
    );
  }
  return force;
}

/**
 * The optional `timeout`, or the error naming what is wrong with it.
 *
 * Null is the caller naming none, which is NOT the same as zero: the option is
 * then omitted from the operation's arguments entirely and the system's own
 * default applies. Refused rather than rounded, for {@link parseForce}'s reason.
 */
function parseTimeout(args: Record<string, unknown>): number | null {
  const timeout = args['timeout'];
  if (timeout == null) return null;
  if (typeof timeout !== 'number' || !Number.isInteger(timeout) || timeout < 0) {
    throw new Error('"timeout" must be a whole number of zero or more');
  }
  return timeout;
}

/**
 * What one read of a container established, where it found one.
 *
 * A read that completed and listed no such container is the ABSENCE of this
 * rather than a shape with a flag in it, which is what keeps `status` a string:
 * every container the mapping lists carries a state word, so there is no listed
 * container whose state is unknown to this tool.
 */
interface ContainerReading {
  /** The name it is configured under, for the plan a person reads. */
  name: string | null;
  /** The normalized state word, exactly as `container_list` reports it. */
  status: string;
}

/**
 * The container with that id, as this system reports it, or null where the read
 * completed and listed none.
 *
 * The id is checked on the RESPONSE, which here is the only place it can be:
 * `containerQuery` takes no filter at all, so the read is the whole list and
 * finding the row is this function's own work.
 */
async function readContainer(ctx: ToolContext, id: string): Promise<ContainerReading | null> {
  const rows = await queryContainers(ctx);
  const row = rows.find((candidate) => textOrNull(candidate.id) === id);
  if (row === undefined) return null;
  const mapped = readContainerRow(row);
  return { name: mapped.name, status: mapped.status };
}

/** A read that completed, or the failure that stopped it. */
interface ContainerAttempt {
  reading: ContainerReading | null;
  error: string | null;
}

/**
 * One read made by `execute`, with its failure caught and named.
 *
 * Caught rather than thrown: letting the first fail would throw away an approval
 * already given for a mutation that is still safe to make, and letting the
 * second fail would report a mutation that HAS ALREADY LANDED as having failed.
 */
async function attemptContainer(ctx: ToolContext, id: string): Promise<ContainerAttempt> {
  try {
    return { reading: await readContainer(ctx, id), error: null };
  } catch (reason) {
    return { reading: null, error: errorText(reason) };
  }
}

/** What one of `execute`'s reads did, where the reading alone cannot say. */
type ContainerLookup = 'FOUND' | 'NOT_FOUND' | 'UNREADABLE';

function containerLookupOf(attempt: ContainerAttempt): ContainerLookup {
  if (attempt.error !== null) return 'UNREADABLE';
  return attempt.reading !== null ? 'FOUND' : 'NOT_FOUND';
}

/**
 * The half of every result that is about the container rather than about the
 * call: the state before, the state after, and whether they differ.
 *
 * `changed` is two readings or nothing. There is one state vocabulary here, so
 * unlike the VM tools' pair (#161) there is no second field to keep out of the
 * comparison.
 */
function containerOutcome(
  id: string,
  ctx: ToolContext,
  previous: ContainerAttempt,
  resulting: ContainerAttempt,
): Record<string, unknown> {
  const previouslyStatus = previous.reading?.status ?? null;
  const resultingStatus = resulting.reading?.status ?? null;
  return {
    container_id: id,
    api_version: negotiatedVersion(ctx),
    previous_lookup: containerLookupOf(previous),
    previous_read_error: previous.error,
    previously_status: previouslyStatus,
    resulting_lookup: containerLookupOf(resulting),
    resulting_read_error: resulting.error,
    resulting_status: resultingStatus,
    changed:
      previouslyStatus === null || resultingStatus === null
        ? null
        : previouslyStatus !== resultingStatus,
  };
}

/**
 * The container as a person approving the plan can recognise it.
 *
 * Named as well as identified, for #126's reason: a caller that reached here
 * with the wrong id can check the id and cannot check anything else.
 */
function describeContainer(reading: ContainerReading, id: string): string {
  return `the container ${
    reading.name === null ? '(the system reported no name)' : `"${reading.name}"`
  } (id \`${id}\`)`;
}

/** The state the container was in when the plan was made, for the plan step. */
function containerStateSentence(reading: ContainerReading): string {
  return (
    `Its state read as \`${reading.status}\` when this plan was made. THAT READING IS FROM PLAN ` +
    'TIME AND IS NOT RE-CHECKED when the call runs.'
  );
}

/**
 * The plan step for the read `execute` makes on either side of the operation.
 *
 * ONE STEP FOR TWO CALLS, which is #156's rule: a repeated call is not a further
 * call to disclose, and listing it twice would show an approver two entries it
 * cannot tell apart.
 *
 * `method` NAMES THE OPERATION AND NOT A MIDDLEWARE METHOD, which is this
 * family's one deviation from `PlanStep.method`'s usual content and is what
 * keeps the plan TRUE under #119. Which middleware method runs is decided by the
 * version negotiated at connect time; naming one of the two would show an
 * approver a call that may not be the one made, and this file does not read the
 * version in order to choose. The description names both.
 */
function containerReadStep(seconds: number): PlanStep {
  return {
    method: 'ops.containerQuery',
    params: [],
    description:
      'List every container on this system, to report the state this one was in before the ' +
      'call. Changes nothing. This is the version-agnostic container query: it reaches ' +
      '`virt.instance.query` filtered to containers on TrueNAS 25.10 and `container.query` on ' +
      '26 and later, and it takes no filter, so the whole list is read and the container is ' +
      `found in it. THIS SAME READ IS MADE AGAIN WHEN THE WATCH BELOW ENDS — UP TO ${seconds} ` +
      'SECONDS AFTER THE CALL IS MADE, AND NOT WHEN THE OPERATION FINISHES — to report the ' +
      'state reached by then. It is listed once because it is one call made twice.',
  };
}

/**
 * The job states this family reads as a run that worked.
 *
 * ITS OWN SET rather than one shared with `vms.ts` or `tasks.ts`, under #86's
 * line: a state VOCABULARY is a family's own and each tool states its own in its
 * own description. A terminal state this catalog does not recognise is NOT read
 * as a success.
 */
const CONTAINER_JOB_SUCCESS_STATES = new Set(['SUCCESS', 'FINISHED']);

/** What kind of answer an operation gave, which differs by version and by verb. */
type OperationDispatch = 'JOB' | 'SYNCHRONOUS' | 'UNREADABLE' | 'UNESTABLISHED';

/** What a bounded watch of one container operation established. */
interface WatchedOperation {
  dispatch: OperationDispatch;
  job_id: number | null;
  job_state: string | null;
  job_succeeded: boolean | null;
  job_error: string | null;
  job_finished_at: string | null;
  operation_ended: boolean;
}

/**
 * Watch one container operation for a bounded time and report what there is.
 *
 * THE SHAPE IS `watchJob`'S (#166) AND IT IS NOT `watchJob`. That helper takes
 * the two stages apart — a `callAndGetJobId` observable and `api.trackJob` — and
 * neither is reachable through `ops`, which hands back one observable with both
 * inside it. So this is a different pipe over a different input, and it answers
 * one question `watchJob` never has to: whether there was a job at all.
 *
 * IT IS NOT PROMOTED TO `common.ts`, and #86's line is why. There is one family
 * over the `ops` seam; the copies that earned `watchJob` its place there were
 * four. The moment a second `ops`-backed family needs this, it is the promotion
 * to make rather than a fifth copy.
 *
 * WHAT THE FOUR DISPATCH VALUES MEAN, and why three would not do:
 *
 * - `JOB` — a job record arrived. The operation is long-running on this version.
 * - `SYNCHRONOUS` — the operation emitted `null` and nothing else, which is what
 *   a version that performs it inline answers with. There is no job, so a null
 *   `job_id` here is the expected answer rather than a correlation that failed.
 * - `UNREADABLE` — something arrived that was neither. Kept separate for #101's
 *   reason: a shape this mapping has no word for must be an honest answer rather
 *   than a branch presumed unreachable.
 * - `UNESTABLISHED` — nothing arrived inside the bound. The operation may well be
 *   running; nothing about it was seen.
 *
 * THE BOUND MUST NOT UNSUBSCRIBE THE OPERATION, AND THAT IS THE ONE PLACE THIS
 * MUST NOT COPY `watchJob`. That helper ends its watch with
 * `takeUntil(timer(...))`, which is safe there because both of its stages are
 * already in flight when the bound expires: the request was sent by
 * `callAndGetJobId` and `trackJob` only observes, so unsubscribing sends nothing
 * and stops nothing.
 *
 * THAT IS NOT TRUE OF A COMPOSED OPERATION. On v26+ `containerRestart` is
 * `api.job('container.stop', …).pipe(toArray(), switchMap(… api.call(
 * 'container.start', …)))`, and `toArray()` emits only on COMPLETION. Unsubscribing
 * at the bound is not a completion, so the projection never runs — and
 * `api.call` is a `defer`, so the start is not merely unobserved, IT IS NEVER
 * SENT. A `takeUntil` here turned a restart whose stop outlived thirty seconds
 * into a stop, and told the caller the operation was still going. So the
 * subscription is made once, read from, and DELIBERATELY NOT TORN DOWN when the
 * bound expires; the bound races it rather than cutting it.
 *
 * WHAT THAT LEAVES BEHIND IS ONE SUBSCRIPTION PER CALL, and it is not a leak in
 * the ordinary case: the operation ends when its job reaches a terminal state,
 * or errors, and takes the subscription with it. An operation that never
 * terminates holds one for the life of the client, which is the exposure any
 * `api.job` consumer already has. An error arriving after the bound reaches the
 * handler below and is dropped there, which is what keeps it from surfacing as
 * an unhandled rejection.
 *
 * AN ERROR BEFORE ANY EMISSION STILL FAILS THE CALL, and one after it does not:
 * by then the operation is under way, and rejecting would report a failure that
 * did not happen. That is `watchJob`'s split made coarser — see the family
 * comment above on what this seam costs.
 *
 * `operation_ended` REQUIRES BOTH COMPLETION AND AN EMISSION, as `watchJob`'s
 * `ended` does: a completion carrying nothing establishes nothing.
 */
async function watchOperation(
  operation: Observable<unknown>,
  options: { watchMs: number; successStates: ReadonlySet<string> },
): Promise<WatchedOperation> {
  let completed = false;
  let sawEmission = false;
  let sawUnreadable = false;
  let lastJob: Record<string, unknown> | null = null;
  let failed = false;
  let failure: unknown = null;
  await new Promise<void>((resolve) => {
    let settled = false;
    let expiry: Subscription | undefined;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      expiry?.unsubscribe();
      resolve();
    };
    operation.subscribe({
      next: (emitted: unknown) => {
        sawEmission = true;
        const record = recordOrNull(emitted);
        if (record !== null) lastJob = record;
        else if (emitted !== null) sawUnreadable = true;
      },
      error: (reason: unknown) => {
        // Only the first era's failure is the call's. After the bound this
        // records nothing and `finish` is a no-op, which is what stops a late
        // error becoming an unhandled rejection.
        if (!sawEmission && !settled) {
          failed = true;
          failure = reason;
        }
        finish();
      },
      complete: () => {
        completed = true;
        finish();
      },
    });
    // Only where the operation did not already settle synchronously, so nothing
    // schedules a timer it would immediately have to cancel.
    if (!settled) expiry = timer(options.watchMs).subscribe(finish);
  });
  if (failed) throw failure;
  const job: Record<string, unknown> | null = lastJob;
  const dispatch: OperationDispatch =
    job !== null
      ? 'JOB'
      : sawUnreadable
        ? 'UNREADABLE'
        : sawEmission
          ? 'SYNCHRONOUS'
          : 'UNESTABLISHED';
  const ended = completed && sawEmission;
  const state = textOrNull(job?.['state']);
  return {
    dispatch,
    job_id: numberOrNull(job?.['id']),
    job_state: state,
    // Gated on the operation having been established to be over, so a job whose
    // last seen state merely LOOKS terminal is not read as a success.
    job_succeeded: ended && state !== null ? options.successStates.has(state) : null,
    job_error: textOrNull(job?.['error']),
    job_finished_at: ended ? isoOrNull(jobMillis(job?.['time_finished'])) : null,
    operation_ended: ended,
  };
}

/** What every one of these three plans says about the watch, in one wording. */
function watchSentence(seconds: number): string {
  return (
    `This tool then follows the operation for at most ${seconds} seconds and reports what it ` +
    'has; the operation continues after that whether or not it has finished, and following it ' +
    'changes nothing.'
  );
}

/**
 * The account of the result every one of the three shares.
 *
 * One text because every clause of it is true of all three, and because the
 * shape it describes is one shape. What differs between them — what the
 * operation does, and what `force` selects — is written per tool.
 */
const CONTAINER_OUTCOME_GUIDANCE =
  '`api_version` is the API version negotiated with this system, and it is what ' +
  'makes `dispatch` readable. `dispatch` says WHAT KIND OF ANSWER the operation ' +
  'gave, which differs by version: `JOB` means it started a background job and ' +
  'a job record was seen, `SYNCHRONOUS` means this version performs the ' +
  'operation inline and there is NO JOB TO CORRELATE — a null `job_id` beside ' +
  'it is the expected answer and not a failure — `UNREADABLE` means something ' +
  'arrived that was neither, and `UNESTABLISHED` means nothing at all was seen ' +
  'inside the watch, which is NOT evidence that nothing happened. `job_id`, ' +
  '`job_state`, `job_succeeded`, `job_error` and `job_finished_at` are all ' +
  'about a job and are ALL NULL unless `dispatch` is `JOB`. `job_id` is the ' +
  "job's numeric identity as the last job record reported it; it is null where " +
  'no job record carried a number this tool could read, WHICH IS NOT EVIDENCE ' +
  'THE OPERATION DID NOT START. `job_state` is the state the system last ' +
  'reported, passed through as it spelled it. `operation_ended` is whether the ' +
  'operation was ESTABLISHED to be over. TRUE MEANS IT IS OVER. FALSE IS NOT ' +
  'ONE ANSWER — the operation is still going, or the watch was cut short by a ' +
  'failure while following it, or nothing was seen of it at all — AND IN NONE ' +
  'OF THEM HAS ANYTHING FAILED. `job_succeeded` is true where the operation ' +
  'ended and the job ended in a state this catalog reads as success, false ' +
  'where it ended in any other state, and NULL WHERE NOTHING ESTABLISHED IT, ' +
  'which is every case where `operation_ended` is false. A state that looks ' +
  'like a success does not make one: `job_succeeded` is null beside a ' +
  '`job_state` of `SUCCESS` where the operation was not established to be over. ' +
  '`SUCCESS` and `FINISHED` are the two states counted; no other is ever read ' +
  'as a success. `job_error` is the text the job recorded and is null where it ' +
  'recorded none. `job_finished_at` is when the job ended, as an ISO 8601 UTC ' +
  'timestamp, REPORTED ONLY WHERE `operation_ended` IS TRUE. `watched_seconds` ' +
  'is the CEILING that applied, not how long the watch lasted. THE CONTAINER ' +
  'STATES ARE READ RATHER THAN ASSUMED: the operation answers with no updated ' +
  'container, so this tool lists the containers immediately before the call and ' +
  'again WHEN THE WATCH ENDS — which is not when the operation ends, so a ' +
  'container part-way through reports the state it was part-way to. ' +
  '`previously_status` and `resulting_status` are those two readings of the ' +
  'same state word `container_list` reports. `changed` is the two compared, and ' +
  'is NULL WHERE EITHER IS, WHICH IS NOT "NOTHING CHANGED". `previous_lookup` ' +
  'and `resulting_lookup` say what each read did: `FOUND` named this container, ' +
  '`NOT_FOUND` completed and listed none under this id, `UNREADABLE` failed — ' +
  'with `previous_read_error` and `resulting_read_error` naming why and null ' +
  'otherwise. THOSE THREE PARTITION IT, unlike the equivalent on the VM tools: ' +
  'a container that was `FOUND` ALWAYS carries a status, because the state word ' +
  'is produced by a total mapping that answers `UNKNOWN` where it has no word, ' +
  'and a state that mapping cannot read at all fails the whole read and is ' +
  'reported as `UNREADABLE`. A null status therefore means `NOT_FOUND` or ' +
  '`UNREADABLE` and nothing else. THE CALL IS MADE IN ALL OF THOSE CASES AND ' +
  'NOTHING BRANCHES ON EITHER READ — a read that failed after the call is not a ' +
  'failed call.';

/** What every one of the three says about which stack it is for and where ids come from. */
const CONTAINER_VERB_PREAMBLE =
  'THIS IS THE INCUS-BACKED CONTAINER STACK AND NOT EITHER VM STACK: `vm_start`, ' +
  '`vm_stop` and `vm_restart` power the libvirt-backed virtual machines and ' +
  'take a NUMERIC id, and nothing in this catalog powers an incus-backed VM at ' +
  'all. `id` is the STRING `container_list` reports for this container on the ' +
  'system being targeted — the incus instance name on TrueNAS 25.10 and the ' +
  'decimal container id on 26 and later — so it is per-system and per-version, ' +
  'and a number is refused with an error saying which tools take one. PLANNING ' +
  'AGAINST AN id NO CONTAINER HAS FAILS naming that id, so an approved plan is ' +
  'always about a container that existed when it was made. WHETHER THE ' +
  'MIDDLEWARE ACCEPTS THIS CALL FOR A CONTAINER ALREADY IN THE STATE IT AIMS ' +
  'AT IS (unconfirmed) HERE — it is not on the API surface and was not run ' +
  'against a live system — so the plan neither refuses such a container nor ' +
  'promises the call will be accepted. THE CALL IS MADE THROUGH THE ' +
  "VERSION-AGNOSTIC CONTAINER OPERATION rather than a named middleware method, " +
  'because the method these operations reach changes between versions; the plan ' +
  'names both, and names the version this system negotiated. A FAILURE BEFORE ' +
  'ANYTHING WAS SEEN OF THE OPERATION FAILS THIS CALL, and even then MAY STILL ' +
  'HAVE STARTED IT: read `container_list` rather than assuming nothing ' +
  'happened.';

// ─── container_start ─────────────────────────────────────────────────────────

/**
 * `container_start`: powering one container on.
 *
 * ITS RESULT SHAPE IS VERSION-DEPENDENT AND THAT IS WHAT THE `dispatch` FIELD IS
 * FOR. `containerStart` emits job updates on TrueNAS 25.10 and a single `null`
 * on 26 and later, where `container.start` is synchronous. A `job_id` that is
 * null because the operation was performed inline is not the same fact as one
 * that is null because no job record was seen, and flattening the two would make
 * one field mean two things (#120). `dispatch` separates them and `api_version`
 * says which to expect.
 */

/** How long {@link containerStart} follows the operation before reporting. */
const CONTAINER_START_WATCH_MS = 30_000;
const CONTAINER_START_WATCH_SECONDS = CONTAINER_START_WATCH_MS / 1000;

const CONTAINER_START_GUIDANCE =
  'A START IS NOT AN INSTANT even where `dispatch` is `SYNCHRONOUS`: the ' +
  'operation returns once the container has been asked to start, so ' +
  '`resulting_status` can still read `STOPPED` or a transitional word on a ' +
  'container that comes up moments later — call `container_list` again to ' +
  'settle it. ' +
  CONTAINER_OUTCOME_GUIDANCE +
  ' THIS TOOL CANNOT STOP OR RESTART A CONTAINER (`container_stop` and ' +
  '`container_restart` do), cannot resume a suspended one, and cannot create, ' +
  'change or delete one — NOTHING IN THIS CATALOG DELETES A CONTAINER.';

export const containerStart: MutatingTool = {
  name: 'container_start',
  description:
    'Powers on one container on a TrueNAS system. Two-phase: called without a ' +
    'confirmation_token it returns a plan for user approval; called with one it ' +
    'starts the container. It takes the id and nothing else. ' +
    CONTAINER_VERB_PREAMBLE +
    ' WHETHER THIS STARTS A BACKGROUND JOB DEPENDS ON THE VERSION, and the ' +
    'result says which happened rather than assuming: TrueNAS 25.10 runs it as ' +
    'a job, and 26 and later perform it inline and report no job at all. ' +
    CONTAINER_START_GUIDANCE,
  resultGuidance: CONTAINER_START_GUIDANCE,
  inputSchema: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description:
          "The container's `id` as `container_list` reports it, on the system " +
          'being targeted. A string, never a number.',
      },
    },
    required: ['id'],
  },
  requiredRole: Role.Full,
  mutating: true,
  // Starting a container destroys nothing and the named reversal is in this
  // catalog: `container_stop`.
  destructiveness: 'reversible',
  normalizeArgs(rawArgs) {
    return { id: parseContainerId(rawArgs) };
  },
  async plan(ctx, rawArgs): Promise<PlanStep[]> {
    const id = parseContainerId(rawArgs);
    const reading = await readContainer(ctx, id);
    if (reading === null) {
      throw new Error(`No container with id \`${id}\` on this system — ${CONTAINER_IDS_FROM}`);
    }
    return [
      containerReadStep(CONTAINER_START_WATCH_SECONDS),
      {
        method: 'ops.containerStart',
        params: [id],
        description:
          `Start ${describeContainer(reading, id)}. ${containerStateSentence(reading)} ` +
          `${versionSentence(ctx)} This reaches \`virt.instance.start\` — a background job — on ` +
          'TrueNAS 25.10, and `container.start` on 26 and later, where it is performed inline ' +
          `and starts no job. ${watchSentence(CONTAINER_START_WATCH_SECONDS)}`,
      },
    ];
  },
  async execute(ctx, rawArgs) {
    const id = parseContainerId(rawArgs);
    const previous = await attemptContainer(ctx, id);
    const watched = await watchOperation(ctx.system.client.ops.containerStart(id), {
      watchMs: CONTAINER_START_WATCH_MS,
      successStates: CONTAINER_JOB_SUCCESS_STATES,
    });
    const resulting = await attemptContainer(ctx, id);
    return {
      ...containerOutcome(id, ctx, previous, resulting),
      watched_seconds: CONTAINER_START_WATCH_SECONDS,
      ...watched,
    };
  },
};

// ─── container_stop ──────────────────────────────────────────────────────────

/**
 * `container_stop`: powering one container off.
 *
 * `force` MEANS A DIFFERENT THING ON EACH VERSION AND THE PLAN STATES BOTH. On
 * TrueNAS 25.10 it is passed to `virt.instance.stop` as that API's own `force`.
 * On 26 and later the operation sets `container.stop`'s `force` AND its
 * `force_after_timeout` from this one boolean, so `force: true` there both
 * refuses to wait and destroys the container if the graceful path is somehow
 * still running. There is NO WAY through this seam to ask for "graceful, then
 * force" on 26 and later, and no way to ask for "graceful, and never force" and
 * have it mean something different from the default.
 *
 * `timeout` IS HONOURED ON 25.10 AND IS NOT SENT AT ALL ON 26 AND LATER, and
 * that is a property of the API rather than an oversight in the mapping:
 * `container.stop`'s options are `force` and `force_after_timeout` and there is
 * no timeout among them. A caller that passed one and was silently not given it
 * would have been told something false about how long its guest was given, so
 * the plan says which of the two applies.
 *
 * NO UNIT IS ASSERTED FOR `timeout` (#96). It is a bare number on the client's
 * option type, nothing there states what it counts, and an approver acts on "10
 * seconds" differently from "10 minutes".
 */

/**
 * How long {@link containerStop} follows the operation before reporting.
 *
 * ITS OWN NUMBER although the three are equal: a bound is a ceiling on one
 * tool's patience rather than an estimate of its operation (#122), so sharing a
 * constant would assert that the three must move together. Share a sentence
 * ({@link watchSentence}), not a number.
 */
const CONTAINER_STOP_WATCH_MS = 30_000;
const CONTAINER_STOP_WATCH_SECONDS = CONTAINER_STOP_WATCH_MS / 1000;

/** What `container_stop` was asked to do. */
interface ContainerStopArgs {
  id: string;
  force: boolean;
  timeout: number | null;
}

function parseContainerStopArgs(args: Record<string, unknown>): ContainerStopArgs {
  return { id: parseContainerId(args), force: parseForce(args), timeout: parseTimeout(args) };
}

/**
 * The options the operation is called with.
 *
 * `timeout` is OMITTED rather than sent as `undefined` where the caller named
 * none, because the plan shows these arguments to a person and a
 * `timeout: undefined` in that text says nothing a reader can act on. The two
 * shapes are what the caller actually chose between, and the step's description
 * says what the absent one means.
 */
function stopOptions(args: ContainerStopArgs): StopOptions {
  return args.timeout === null ? { force: args.force } : { force: args.force, timeout: args.timeout };
}

/**
 * How the OLDER version takes `force`, which is not the same method for the two
 * tools that ask for one.
 *
 * On 25.10 a stop is `virt.instance.stop` and a restart is
 * `virt.instance.restart` — one middleware job that brings the container down
 * and starts it again, taking the same options object under the name
 * `stop_args`. A shared sentence naming the stop's method would put a method
 * the call does not dial into the restart's approval text, which is #161's rule
 * about a step description shared by several tools: parameterise the clause
 * that differs rather than writing the one true of the tool written first.
 */
const STOP_FORCE_ON_2510 =
  "On TrueNAS 25.10 that is `virt.instance.stop`'s own force, which takes the container down " +
  'without waiting for it.';
const RESTART_FORCE_ON_2510 =
  "On TrueNAS 25.10 that is `virt.instance.restart`'s own `stop_args.force`: the restart is one " +
  'job there, and this is how that job takes the container down, without waiting for it, before ' +
  'starting it again.';

/** What `force` and `timeout` select, in the words both stop and restart use. */
function forceSentence(force: boolean, timeout: number | null, olderForce: string): string {
  const chosen = force
    ? `FORCE IS TRUE FOR THIS CALL. ${olderForce} On 26 and later this one ` +
      'argument sets BOTH `container.stop`\'s `force` and its `force_after_timeout`, so the ' +
      'container is brought down whether or not it goes on its own. EITHER WAY, ANYTHING THE ' +
      'CONTAINER HAD NOT WRITTEN TO DISK CAN BE LOST.'
    : 'Force is false for this call, so the container is asked to stop and is given the chance ' +
      'to go on its own. WHAT THE SYSTEM DOES WITH A CONTAINER THAT HAS NOT STOPPED BY THEN IS ' +
      '(unconfirmed) here — it is not on this API surface and was not run against a live ' +
      'system — so a container still reading as running afterwards is not evidence this call ' +
      'failed.';
  const wait =
    timeout === null
      ? 'No timeout was named, so none is sent and the system\'s own default applies.'
      : `A timeout of ${timeout} was named. THE API DECLARES NO UNIT FOR THAT NUMBER and none ` +
        'is asserted here. IT IS HONOURED ONLY ON TrueNAS 25.10: `container.stop` on 26 and ' +
        'later has no timeout parameter at all, so on those versions THIS NUMBER IS NOT SENT ' +
        'and the system\'s own default applies instead.';
  return `${chosen} ${wait}`;
}

const CONTAINER_STOP_GUIDANCE =
  CONTAINER_OUTCOME_GUIDANCE +
  ' THIS TOOL CANNOT STOP A RUNNING JOB once it has started one, cannot start ' +
  'a container (`container_start` does) or restart one (`container_restart` ' +
  'does), cannot suspend or resume one, and CANNOT RECOVER DATA A FORCED STOP ' +
  'LOST — starting the container again brings it up from what reached the disk.';

export const containerStop: MutatingTool = {
  name: 'container_stop',
  description:
    'Powers off one container on a TrueNAS system and reports how far it got. ' +
    'Two-phase: called without a confirmation_token it returns a plan for user ' +
    'approval; called with one it starts the stop. ' +
    CONTAINER_VERB_PREAMBLE +
    ' `force` IS REQUIRED AND HAS NO DEFAULT — the operation declares it ' +
    'required, and which of two shutdown paths runs is your choice. `force: ' +
    'true` brings the container down without waiting for it and ANYTHING IT HAD ' +
    'NOT WRITTEN TO DISK CAN BE LOST; `force: false` asks it to stop and lets ' +
    'it go on its own. WHAT `force` REACHES DIFFERS BY VERSION: on TrueNAS ' +
    "25.10 it is `virt.instance.stop`'s own force, and on 26 and later this one " +
    "argument sets BOTH `container.stop`'s `force` and its " +
    '`force_after_timeout`, so there is no way here to ask for "graceful, then ' +
    'force" on those versions. `timeout` is optional and IS NOT SENT AT ALL ON ' +
    '26 AND LATER, where `container.stop` has no timeout parameter — a number ' +
    'given there is silently not applied by the API, which is why this tool ' +
    'says so rather than implying the guest was given that long. NO UNIT IS ' +
    'ASSERTED for it: the API declares none and it is not to be converted. ' +
    'Omitted, no timeout is sent and the system\'s own default applies. ' +
    'THE RESULT IS ABOUT THE OPERATION THIS CALL STARTED, AND "STARTED" IS NOT ' +
    '"STOPPED". ' +
    CONTAINER_STOP_GUIDANCE,
  resultGuidance: CONTAINER_STOP_GUIDANCE,
  inputSchema: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description:
          "The container's `id` as `container_list` reports it, on the system " +
          'being targeted. A string, never a number.',
      },
      force: {
        type: 'boolean',
        description:
          'Bring the container down without waiting for it to stop on its own. ' +
          'Required — there is no default. Unwritten data can be lost. On ' +
          'TrueNAS 26 and later this also sets `force_after_timeout`.',
      },
      timeout: {
        type: 'integer',
        minimum: 0,
        description:
          'How long the system waits for the container to stop, in the unit ' +
          'the API declares for it, which is none. HONOURED ONLY ON TrueNAS ' +
          '25.10: it is not sent on 26 and later, which have no such ' +
          "parameter. Omitted, the system's own default applies.",
      },
    },
    required: ['id', 'force'],
  },
  requiredRole: Role.Full,
  mutating: true,
  // The operation is reversible in the sense the field records — the container
  // can be started again, and `container_start` is in this catalog. What a
  // forced stop does to data the container had not written is not, and this
  // field cannot say both: it records the operation, and the account of the
  // data is in the description and in the plan (#153).
  destructiveness: 'reversible',
  normalizeArgs(rawArgs) {
    const args = parseContainerStopArgs(rawArgs);
    return args.timeout === null
      ? { id: args.id, force: args.force }
      : { id: args.id, force: args.force, timeout: args.timeout };
  },
  async plan(ctx, rawArgs): Promise<PlanStep[]> {
    const args = parseContainerStopArgs(rawArgs);
    const reading = await readContainer(ctx, args.id);
    if (reading === null) {
      throw new Error(`No container with id \`${args.id}\` on this system — ${CONTAINER_IDS_FROM}`);
    }
    return [
      containerReadStep(CONTAINER_STOP_WATCH_SECONDS),
      {
        method: 'ops.containerStop',
        params: [args.id, stopOptions(args)],
        description:
          `Stop ${describeContainer(reading, args.id)}. ${containerStateSentence(reading)} ` +
          `${versionSentence(ctx)} This reaches \`virt.instance.stop\` on TrueNAS 25.10 and ` +
          '`container.stop` on 26 and later, a background job on both. ' +
          `${forceSentence(args.force, args.timeout, STOP_FORCE_ON_2510)} ` +
          watchSentence(CONTAINER_STOP_WATCH_SECONDS),
      },
    ];
  },
  async execute(ctx, rawArgs) {
    const args = parseContainerStopArgs(rawArgs);
    const previous = await attemptContainer(ctx, args.id);
    const watched = await watchOperation(
      ctx.system.client.ops.containerStop(args.id, stopOptions(args)),
      { watchMs: CONTAINER_STOP_WATCH_MS, successStates: CONTAINER_JOB_SUCCESS_STATES },
    );
    const resulting = await attemptContainer(ctx, args.id);
    return {
      ...containerOutcome(args.id, ctx, previous, resulting),
      requested_force: args.force,
      requested_timeout: args.timeout,
      watched_seconds: CONTAINER_STOP_WATCH_SECONDS,
      ...watched,
    };
  },
};

// ─── container_restart ───────────────────────────────────────────────────────

/**
 * `container_restart`: stopping and starting one container.
 *
 * ON TrueNAS 26 AND LATER THERE IS NO `container.restart` AND THE OPERATION
 * COMPOSES ONE, which has three consequences the description states because none
 * of them is on the API surface:
 *
 * - The start half runs when the stop JOB COMPLETES, including where it
 *   completed in a failed state. Only a stop that errors outright stops it.
 * - Nothing at all is emitted until the stop job has finished, because the
 *   composition buffers the stop's updates before re-emitting them. A watch that
 *   expires while the stop is still running therefore sees NOTHING and reports
 *   `dispatch: UNESTABLISHED` — where the same watch against `container_stop`
 *   would have been reporting progress all along.
 * - `force` reaches the stop half alone, on the same doubled reading
 *   {@link forceSentence} describes.
 *
 * On 25.10 the middleware's own `virt.instance.restart` does all of it as one
 * job and none of the three applies.
 */

/** How long {@link containerRestart} follows the operation before reporting. */
const CONTAINER_RESTART_WATCH_MS = 30_000;
const CONTAINER_RESTART_WATCH_SECONDS = CONTAINER_RESTART_WATCH_MS / 1000;

/** What `container_restart` was asked to do — the same three as a stop. */
type ContainerRestartArgs = ContainerStopArgs;

function parseContainerRestartArgs(args: Record<string, unknown>): ContainerRestartArgs {
  return parseContainerStopArgs(args);
}

function restartOptions(args: ContainerRestartArgs): RestartOptions {
  return stopOptions(args);
}

/**
 * What a restart is on each version, in the plan's own words.
 *
 * One string because it is one text and every clause is load-bearing: a plan
 * reading "stop then start" would omit that the start half runs after a FAILED
 * stop on the newer versions, which is #154's shape reached through a
 * composition.
 */
const RESTART_COMPOSITION =
  'A RESTART IS ONE MIDDLEWARE JOB ON TrueNAS 25.10 AND TWO CALLS ON 26 AND LATER, and the ' +
  'difference is not cosmetic. On 25.10 this is `virt.instance.restart`, which the middleware ' +
  'performs as a single job. On 26 and later THERE IS NO SUCH METHOD and the operation composes ' +
  'one: it runs `container.stop` as a job and then calls `container.start` inline once that job ' +
  'COMPLETES — INCLUDING WHERE THE STOP JOB COMPLETED IN A FAILED STATE, so a failed stop does ' +
  'not prevent the start being attempted; only a stop that errors outright does. On those ' +
  'versions NOTHING IS REPORTED ABOUT THE OPERATION UNTIL THE STOP HAS FINISHED, so a watch ' +
  'that runs out while the container is still shutting down reports having seen nothing rather ' +
  'than reporting progress. NONE OF THAT IS ON THE API SURFACE — it is read from the client\'s ' +
  'own composition and is NOT something this catalog can check.';

const CONTAINER_RESTART_GUIDANCE =
  'A `changed: false` ACROSS A RESTART IS THE ORDINARY ANSWER FOR ONE THAT ' +
  'WORKED, since a container that was running and is running again read the ' +
  'same both times — `changed` is the two status readings compared and is NOT a ' +
  'statement about whether the container was restarted. A restart also passes ' +
  'THROUGH being stopped on its way back up, so a `resulting_status` of ' +
  '`STOPPED` is as likely to be a container part-way through as one that failed ' +
  'to come back, AND THIS TOOL DOES NOT SEPARATE THE TWO. ' +
  CONTAINER_OUTCOME_GUIDANCE +
  ' Where the operation was composed from a stop and a start, `job_state`, ' +
  '`job_succeeded` and `job_error` are ALL ABOUT THE STOP HALF — the start half ' +
  'runs inline and reports no job — so a `job_succeeded` of true says the ' +
  'container was stopped and says nothing about whether it came back; ' +
  '`resulting_status` is what speaks to that. THIS TOOL CANNOT STOP A RUNNING ' +
  'JOB once it has started one, cannot start or stop a container without the ' +
  'other half (`container_start` and `container_stop` do), cannot suspend or ' +
  'resume one, and CANNOT RECOVER DATA A FORCED STOP LOST.';

export const containerRestart: MutatingTool = {
  name: 'container_restart',
  description:
    'Restarts one container on a TrueNAS system — stopping it and starting it ' +
    'again — and reports how far it got. Two-phase: called without a ' +
    'confirmation_token it returns a plan for user approval; called with one it ' +
    'starts the restart. ' +
    CONTAINER_VERB_PREAMBLE +
    ' ' +
    RESTART_COMPOSITION +
    ' `force` IS REQUIRED AND HAS NO DEFAULT, and it governs how the container ' +
    'is BROUGHT DOWN — `virt.instance.restart`\'s own `stop_args` on TrueNAS ' +
    '25.10, where the restart is one job, and the stopping half\'s ' +
    '`container.stop` options on 26 and later, where it is two calls. `force: ' +
    'true` brings the container down without waiting for it and ' +
    'ANYTHING IT HAD NOT WRITTEN TO DISK CAN BE LOST; `force: false` asks it to ' +
    'stop and lets it go on its own. On TrueNAS 26 and later this one argument ' +
    'sets BOTH the stop\'s `force` and its `force_after_timeout`. `timeout` is ' +
    'optional, IS NOT SENT AT ALL ON 26 AND LATER — those versions have no such ' +
    'parameter — and NO UNIT IS ASSERTED for it. Omitted, the system\'s own ' +
    'default applies. THE RESULT IS ABOUT THE OPERATION THIS CALL STARTED, AND ' +
    '"STARTED" IS NOT "RESTARTED". ' +
    CONTAINER_RESTART_GUIDANCE,
  resultGuidance: CONTAINER_RESTART_GUIDANCE,
  inputSchema: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description:
          "The container's `id` as `container_list` reports it, on the system " +
          'being targeted. A string, never a number.',
      },
      force: {
        type: 'boolean',
        description:
          'Bring the container down without waiting for it to stop on its own, ' +
          'in the stopping half of the restart. Required — there is no ' +
          'default. Unwritten data can be lost. On TrueNAS 26 and later this ' +
          'also sets `force_after_timeout`.',
      },
      timeout: {
        type: 'integer',
        minimum: 0,
        description:
          'How long the system waits for the container to stop, in the unit ' +
          'the API declares for it, which is none. HONOURED ONLY ON TrueNAS ' +
          '25.10: it is not sent on 26 and later, which have no such ' +
          "parameter. Omitted, the system's own default applies.",
      },
    },
    required: ['id', 'force'],
  },
  requiredRole: Role.Full,
  mutating: true,
  // {@link containerStop}'s reading exactly: the operation is reversible in the
  // sense the field records — the container is started again by the call itself
  // — while what a forced stop does to data it had not written is not.
  destructiveness: 'reversible',
  normalizeArgs(rawArgs) {
    const args = parseContainerRestartArgs(rawArgs);
    return args.timeout === null
      ? { id: args.id, force: args.force }
      : { id: args.id, force: args.force, timeout: args.timeout };
  },
  async plan(ctx, rawArgs): Promise<PlanStep[]> {
    const args = parseContainerRestartArgs(rawArgs);
    const reading = await readContainer(ctx, args.id);
    if (reading === null) {
      throw new Error(`No container with id \`${args.id}\` on this system — ${CONTAINER_IDS_FROM}`);
    }
    return [
      containerReadStep(CONTAINER_RESTART_WATCH_SECONDS),
      {
        method: 'ops.containerRestart',
        params: [args.id, restartOptions(args)],
        description:
          `Restart ${describeContainer(reading, args.id)}. ${containerStateSentence(reading)} ` +
          `${versionSentence(ctx)} ${RESTART_COMPOSITION} ` +
          `${forceSentence(args.force, args.timeout, RESTART_FORCE_ON_2510)} ` +
          watchSentence(CONTAINER_RESTART_WATCH_SECONDS),
      },
    ];
  },
  async execute(ctx, rawArgs) {
    const args = parseContainerRestartArgs(rawArgs);
    const previous = await attemptContainer(ctx, args.id);
    const watched = await watchOperation(
      ctx.system.client.ops.containerRestart(args.id, restartOptions(args)),
      { watchMs: CONTAINER_RESTART_WATCH_MS, successStates: CONTAINER_JOB_SUCCESS_STATES },
    );
    const resulting = await attemptContainer(ctx, args.id);
    return {
      ...containerOutcome(args.id, ctx, previous, resulting),
      requested_force: args.force,
      requested_timeout: args.timeout,
      watched_seconds: CONTAINER_RESTART_WATCH_SECONDS,
      ...watched,
    };
  },
};
