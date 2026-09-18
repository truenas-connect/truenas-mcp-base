import type { JobParams } from '@truenas/api-client';
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
import { ApiSurface, MutatingTool, PlanStep, ReadOnlyTool, ToolContext } from '@/catalog/tool';
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
 * Services family: which of the system's services are meant to run, which are
 * running, and — since #164 — starting, stopping and restarting one.
 *
 * Every other tool that touches a served protocol reports the CONFIGURATION and
 * stops there — `shares_list` says an SMB share exists, `iscsi_list` says a
 * target and its extents exist, `network_config` says which addresses the box
 * answers on. None of them can say whether the daemon serving any of it is up,
 * which is the first thing "why can't I reach my share?" turns on.
 *
 * `service.query` answers exactly that and nothing else: one row per service,
 * carrying whether it starts at boot and what state it is in now. The two are
 * independent facts and the interesting reading is where they disagree, so they
 * are reported as two fields and never folded into one verdict — see the
 * description.
 *
 * WHAT THIS FAMILY DELIBERATELY DOES NOT DO:
 *
 * - **It does not remap the service names.** The middleware calls SMB `cifs`
 *   and iSCSI `iscsitarget`, which is not what a person calls them, and the
 *   description carries those examples so a caller can match. A translation
 *   table here would be a second vocabulary to keep in step with TrueNAS's
 *   own, and the allowlist convention is to report what the API reports. That
 *   holds for {@link serviceControl} too: the name it takes is the name
 *   {@link servicesStatus} reported, and nothing between them translates.
 * - **It does not read or change a service's own configuration.** `smb.config`,
 *   `nfs.config` and `ssh.config` answer a different question and are not
 *   called, and nothing here writes one. `service.update` is what sets whether
 *   a service starts at boot and is in no tool here either — RUNNING NOW AND
 *   STARTING AT BOOT ARE THE TWO INDEPENDENT FACTS THIS FAMILY IS BUILT AROUND,
 *   and only the first of them is mutable from here.
 */

/** One service, as {@link servicesStatus} reports it. */
interface ServiceStatus {
  service: string | null;
  start_on_boot: boolean | null;
  state: string | null;
}

/** One service row as `service.query` answers with one, derived from the call (#91). */
type ServiceEntry = ApiSurface['call']['service.query']['entity'];

/**
 * One service row, read through the allowlist both tools in this file share.
 *
 * ONE NORMALIZATION PER SUBJECT (#44). {@link serviceControl} reads the same
 * rows to report the state before and after its call, and reading them a second
 * way there would be a second opinion about what state a service is in — so the
 * two words it compares are the two words `services_status` reports, by
 * construction rather than by having been written to match.
 *
 * `id` is a middleware row id with nothing on the other side of it to join to,
 * and `pids` is process detail that says nothing a caller reasoning about
 * availability can use — `state` already carries that. Both are dropped by
 * being absent from this allowlist rather than by being removed from a copy, so
 * a field a later release adds cannot reach a caller without a change here.
 */
function serviceStatusOf(entry: ServiceEntry): ServiceStatus {
  return {
    service: textOrNull(entry.service),
    start_on_boot: booleanOrNull(entry.enable),
    state: textOrNull(entry.state),
  };
}

export const servicesStatus: ReadOnlyTool = {
  name: 'services_status',
  description:
    'Every service on a TrueNAS system, whether it is set to start at boot, ' +
    'and what state it is in right now. This is what says whether the daemon ' +
    'behind a configured share, export or target is actually up: `shares_list` ' +
    'and `iscsi_list` report what is configured, and neither reports whether ' +
    'anything is serving it. `service` IS THE MIDDLEWARE\'S OWN INTERNAL NAME ' +
    'FOR THE SERVICE, NOT THE NAME THE WEB UI SHOWS — SMB is `cifs` and iSCSI ' +
    'is `iscsitarget`, and NFS, SSH and the rest read `nfs`, `ssh` and so on. ' +
    'The names are reported exactly as the system spells them and are not ' +
    'translated, so match on the internal name rather than on the protocol as ' +
    'a person would say it. `service` is null where the system reported no ' +
    'name this tool could read, and such a row cannot be matched to a protocol ' +
    'from here. `start_on_boot` is the service\'s `enable` setting: true means ' +
    'the system is configured to start it at boot, false means it is not. IT ' +
    'IS NOT WHETHER THE SERVICE IS RUNNING. `state` is that — the run state ' +
    'the system reported, as the word the system itself used. `RUNNING` and ' +
    '`STOPPED` are the two words seen in practice, but THE SET IS NOT CLOSED: ' +
    'any other value is reported verbatim rather than coerced into one of ' +
    'those two, and a word not listed here means the system said something ' +
    'this tool has no reading of, not that the service is stopped. THE TWO ' +
    'FIELDS ARE INDEPENDENT AND THE MISMATCH IS THE POINT. `start_on_boot` ' +
    'true with a `state` that is not `RUNNING` is a service that is supposed ' +
    'to be up and is not, which is the finding worth acting on; ' +
    '`start_on_boot` false with `STOPPED` is just a service nobody turned on. ' +
    'Both fields are null where the system reported no value this tool could ' +
    'read, which is never the same as a service configured not to start or ' +
    'one that is not running — a null is a row to look at directly, not an ' +
    'answer about the service. AN EMPTY LIST IS A SYSTEM THAT REPORTED NO ' +
    'SERVICES AT ALL, not a failure to read them: a read that fails raises ' +
    'rather than returning nothing. This tool does not say WHY a service is ' +
    'not running, does not report its process ids, and does not report its ' +
    'configuration — `smb.config`, `nfs.config` and the like are a different ' +
    'question and are not read here. THIS TOOL CHANGES NOTHING: ' +
    '`service_control` is what starts, stops or restarts a service, and it ' +
    'takes the `service` name exactly as reported here. NOTHING IN THIS ' +
    'CATALOG CHANGES WHETHER A SERVICE STARTS AT BOOT, so `start_on_boot` is ' +
    'read-only from here and `service_control` does not move it. NO field ' +
    'beyond the three named here is returned, whatever a later TrueNAS ' +
    'release adds to a service record.',
  inputSchema: { type: 'object', properties: {} },
  requiredRole: Role.ReadOnly,
  mutating: false,
  async handler({ system }) {
    // No filters and no options: a system holds a few dozen services at most,
    // all three fields reported are part of a service row as it stands, and the
    // question this answers is about all of them rather than a named one —
    // there is nothing to bound and no option that changes how they arrive.
    const services = await firstValueFrom(system.client.api.query('service.query'));
    return services.map(serviceStatusOf);
  },
};

/**
 * `service_control`: starting, stopping and restarting one of the system's
 * services, and the first mutation this family offers.
 *
 * ONE TOOL AND NOT THREE, WHICH IS WHERE THIS DIVERGES FROM `vm_start` /
 * `vm_stop` / `vm_restart` (#161) DESPITE ANSWERING THE SAME KIND OF QUESTION.
 * The VM power tools are three because they are three METHODS: `vm.start` is a
 * plain call taking `overcommit`, `vm.stop` is a job taking two shutdown-path
 * booleans, and `vm.restart` is a job taking nothing — different params,
 * different failure shapes, different things to tell an approver. Here the three
 * verbs are literally one call, `service.control(verb, service)`, differing in
 * one enum member. Three tools would be three copies of one `plan`/`execute`
 * pair differing in a string, which is what `common.ts` was cut to stop, and it
 * is #121's test applied: the kinds differ only in which value is dialled, not
 * in what the caller is told.
 *
 * `service.start`, `service.stop` AND `service.restart` DO NOT EXIST ON THIS API
 * SURFACE. They are what an older middleware offered and what this file's own
 * comment used to name; the surface these tools are typed against carries one
 * method, `service.control`, in the JOB directory. Anything written against the
 * three-method shape is out of date rather than merely more verbose.
 *
 * `RELOAD` IS THE FOURTH VERB AND IS DELIBERATELY NOT OFFERED. The ticket's
 * subject is starting, stopping and restarting, and a reload is none of those —
 * the daemon keeps running and re-reads its configuration, so it does not change
 * the run state this tool reports on, and what it actually does differs per
 * service in ways nothing on this surface states. Refusing it in the schema is
 * #121's rule: the reachable surface is not the scope. It is named in the
 * description so a caller can tell a deliberate omission from a verb nobody saw
 * (#102).
 *
 * THE CALL ANSWERS A BOOLEAN AND THE STATE IS STILL READ BACK. `service.control`
 * declares `response: boolean`, so unlike `vm.stop` (#161) there IS a verdict on
 * the job to read, and it is reported as `control_result`. It is not what the
 * outcome is taken from: the middleware's own boolean says whether the control
 * operation reported success, and the acceptance criteria ask for the state the
 * service ended in, which is a separate reading. So both are reported and the
 * description says which is which.
 *
 * NOTHING BRANCHES ON EITHER READ, for the reason the VM power tools give one
 * family over: `execute` is contractually a pure function of (args, system),
 * since the confirmation token binds tool + args + systems rather than the plan
 * steps. The service is read before the call and again when the watch ends, the
 * call is made whatever those reads said, and the only state check that can
 * refuse anything is the plan-time one that the named service exists at all.
 */

/** Where the names this tool takes come from, in the one wording used throughout. */
const SERVICE_NAMES_FROM =
  "the names are the middleware's own internal ones, as `services_status` reports them in its " +
  '`service` field — SMB is `cifs` and iSCSI is `iscsitarget`, and nothing here translates them';

/**
 * The params `service.control` takes, typed off the JOB directory — a key space
 * disjoint from the call directory, so `CallParams` cannot name them.
 */
type ServiceControlParams = JobParams<ApiSurface, 'service.control'>;

/** Every verb the method declares, derived from the call rather than named (#91). */
type ServiceControlVerb = ServiceControlParams[0];

/**
 * The three verbs this tool offers, checked against the method's own union.
 *
 * `satisfies` rather than a bare literal so that a client release renaming or
 * dropping one of these fails to compile here, rather than leaving a schema
 * offering a verb the middleware no longer takes.
 */
const CONTROL_VERBS = ['START', 'STOP', 'RESTART'] as const satisfies readonly ServiceControlVerb[];

/** One of the three verbs this tool offers. */
type ControlVerb = (typeof CONTROL_VERBS)[number];

/**
 * The run state each verb aims to leave the service in.
 *
 * These are the two words `services_status` names as the ones seen in practice,
 * and its own description says THE SET IS NOT CLOSED — so this is what the verb
 * is aiming at rather than an enumeration of what a system may answer with. A
 * service that ends in any other word has not been shown to have reached the
 * state asked for, which is what {@link reachedStateFailure} is about.
 */
const EXPECTED_STATE: Record<ControlVerb, string> = {
  START: 'RUNNING',
  STOP: 'STOPPED',
  RESTART: 'RUNNING',
};

/**
 * The params the job is started with.
 *
 * The method's third parameter is a `ServiceOptions` record carrying
 * `ha_propagate`, `silent` and `timeout`, and THIS TOOL PASSES NONE OF THEM —
 * so the middleware's own defaults apply and this catalog asserts nothing about
 * what they are. Sending an empty record instead would look like a choice that
 * had been made. `timeout` in particular is a bare number on this surface with
 * no unit stated (#96), and offering it would mean this repository naming one.
 */
function serviceControlParams(args: ServiceControlArgs): ServiceControlParams {
  return [args.verb, args.service];
}

/** How long {@link serviceControl} watches the job it started before reporting what it has. */
const SERVICE_CONTROL_WATCH_MS = 30_000;

/** Seconds, for the result, so the bound is reported in the unit it is stated in. */
const SERVICE_CONTROL_WATCH_SECONDS = SERVICE_CONTROL_WATCH_MS / 1000;

/** What `service_control` was asked to do. */
interface ServiceControlArgs {
  service: string;
  verb: ControlVerb;
}

/** Whether a word is one of the three verbs this tool offers. */
function isControlVerb(value: string): value is ControlVerb {
  return (CONTROL_VERBS as readonly string[]).includes(value);
}

/**
 * The caller's arguments, or the error naming what is wrong with them.
 *
 * Strict on the verb rather than case-folding it: the middleware's own members
 * are upper case, a lower-case `start` is a caller working from a different
 * vocabulary, and answering it silently would leave them believing this tool
 * accepts words it does not. The message lists the three that work, which is the
 * same courtesy {@link missingServiceError} extends for a name.
 */
function parseServiceControlArgs(args: Record<string, unknown>): ServiceControlArgs {
  const service = args['service'];
  if (typeof service !== 'string' || service.length === 0) {
    throw new Error(`"service" is required and must be the name of a service — ${SERVICE_NAMES_FROM}`);
  }
  const verb = args['verb'];
  if (typeof verb !== 'string' || !isControlVerb(verb)) {
    throw new Error(
      `"verb" is required and must be one of ${CONTROL_VERBS.join(', ')}. The middleware also ` +
        'defines RELOAD and this tool does not offer it: a reload leaves the service running and ' +
        'is not a start, a stop or a restart.',
    );
  }
  return { service, verb };
}

/** What one read of the system's services established about the one named. */
interface ServiceReading {
  /** Whether the system listed a service under the name given. */
  listed: boolean;
  /** The run state, as `services_status` reports it. */
  state: string | null;
  /** Whether the service is set to start at boot, as `services_status` reports it. */
  start_on_boot: boolean | null;
  /**
   * Every service name the read listed, so that a name nothing matches can be
   * refused with the names that would have worked (#164's acceptance criteria).
   */
  names: string[];
}

/**
 * The positional params every service read reaches the middleware with, for the
 * plan step that names one.
 *
 * THE TWO EMPTIES ARE NOT PADDING, which is `vms.ts`'s reading of the same call:
 * `api.query(method, filters)` dispatches `[filters ?? [], options ?? {}]`, so
 * the read carries two positional params although this caller passes neither. A
 * step naming fewer would show an approver a call shorter than the one that runs
 * — #119's defect in the one artefact a person reads before approving.
 */
function serviceReadParams(): unknown {
  return [[], {}];
}

/**
 * What this system reports about the service with that name.
 *
 * UNFILTERED, for the reason {@link servicesStatus} gives: a system holds a few
 * dozen services at most and there is nothing to bound. That also removes the
 * dropped-filter trap (#121) rather than handling it — there is no filter to be
 * silently ignored — and it is what makes {@link ServiceReading.names} free,
 * which is what a name that matches nothing is refused with.
 *
 * The match is exact, on the middleware's own name. A fuzzy or case-folded match
 * would be the translation table this family refuses, one level down, and it
 * would be doing it in the one place where guessing wrong stops the wrong
 * daemon.
 */
async function readService(ctx: ToolContext, name: string): Promise<ServiceReading> {
  const rows = await firstValueFrom(ctx.system.client.api.query('service.query'));
  const statuses = rows.map(serviceStatusOf);
  const match = statuses.find((row) => row.service === name);
  return {
    listed: match !== undefined,
    state: match?.state ?? null,
    start_on_boot: match?.start_on_boot ?? null,
    names: statuses
      .map((row) => row.service)
      .filter((service): service is string => service !== null),
  };
}

/** A service read that completed, or the failure that stopped it. */
interface ServiceAttempt {
  reading: ServiceReading | null;
  error: string | null;
}

/**
 * One service read made by `execute`, with its failure caught and named.
 *
 * Caught rather than thrown, as the VM power tools' two reads are (#161):
 * letting the first fail the call would lose an approval already given for a
 * mutation that is still safe to make, and letting the second fail it would
 * report a mutation that HAS ALREADY LANDED as having failed.
 */
async function attemptService(ctx: ToolContext, name: string): Promise<ServiceAttempt> {
  try {
    return { reading: await readService(ctx, name), error: null };
  } catch (reason) {
    return { reading: null, error: errorText(reason) };
  }
}

/** What one of `execute`'s two reads did, where the reading alone cannot say. */
type ServiceLookup = 'FOUND' | 'NOT_FOUND' | 'UNREADABLE';

function serviceLookupOf(attempt: ServiceAttempt): ServiceLookup {
  if (attempt.error !== null) return 'UNREADABLE';
  return attempt.reading !== null && attempt.reading.listed ? 'FOUND' : 'NOT_FOUND';
}

/**
 * The error a name that matches no service is refused with, naming the ones that
 * would have worked.
 *
 * The list comes from the read that just happened rather than from anything
 * written down here, so it is this system's own services and stays right as
 * TrueNAS adds and removes them. A system that listed no service at all says so
 * instead of offering an empty list, which would read as "none of them would
 * have worked".
 */
function missingServiceError(name: string, names: string[]): string {
  return (
    `No service named "${name}" on this system. ` +
    (names.length === 0
      ? 'This system listed no services at all, so there is nothing here to name — read ' +
        '`services_status` to see what it reports.'
      : `The names that would have worked are: ${names.join(', ')}. ${SERVICE_NAMES_FROM}.`)
  );
}

/**
 * The state the service was in when the plan was made, for the plan step.
 *
 * It says outright that the reading is a plan-time one and is not re-checked,
 * because nothing this tool does at execute time branches on state — a service
 * that moves between the plan and the confirmation is handled by the middleware
 * rather than by an `execute` that reads and decides.
 */
function serviceStateSentence(reading: ServiceReading): string {
  if (reading.state === null) {
    return (
      'The state it is in could not be read when this plan was made, so what this call changes ' +
      'is NOT established here.'
    );
  }
  return (
    `Its state read as \`${reading.state}\` when this plan was made. THAT READING IS FROM PLAN ` +
    'TIME AND IS NOT RE-CHECKED when the call runs.'
  );
}

/**
 * What the plan adds where the service is already in the state the verb aims at.
 *
 * #119's convention, stated rather than acted on: already-in-the-target-state is
 * not an error here, the plan does not refuse it, and the result says which it
 * was through `previously_state` and `changed`. What the MIDDLEWARE does with
 * such a call is a separate question and is marked `(unconfirmed)` in
 * `pool_resilver_config`'s form (#141) — `vm_start` refuses a running VM because
 * `start_vm` is KNOWN to raise for one (#161), and nothing readable from this
 * repository says whether `service.control` no-ops or rejects. Guessing the
 * reassuring direction is #154's costly one, and guessing the other would refuse
 * a plan the middleware would have accepted (#154's reading of a task's
 * `enabled`).
 */
function alreadyInStateSentence(args: ServiceControlArgs, reading: ServiceReading): string {
  if (args.verb === 'RESTART' || reading.state !== EXPECTED_STATE[args.verb]) return '';
  return (
    ` IT ALREADY READ AS \`${reading.state}\` WHEN THIS PLAN WAS MADE, which is the state this ` +
    'verb aims at. THIS PLAN DOES NOT REFUSE THAT: a service already in the state asked for is ' +
    'not an error here, and the result reports it as such — `previously_state` carries the ' +
    'reading above and `changed` comes back false. Whether the middleware treats such a call as ' +
    'a no-op or rejects it is (unconfirmed) here: it was not read off a live system and this API ' +
    'surface does not say.'
  );
}

/**
 * What the boot setting means for this call, which is the reading an operator is
 * most likely to get wrong.
 *
 * `start_on_boot` and `state` are the two independent facts this family exists
 * to keep apart, and a person who has just started a service by hand is exactly
 * the person about to assume it will come back after a reboot. Nothing in this
 * catalog writes that setting, so the plan says so rather than leaving the
 * silence to be read as "both were dealt with".
 */
function bootSettingSentence(reading: ServiceReading): string {
  if (reading.start_on_boot === null) {
    return (
      'Whether this service is set to start at boot could not be read, and THIS CALL DOES NOT ' +
      'CHANGE IT EITHER WAY — nothing in this catalog does.'
    );
  }
  return reading.start_on_boot
    ? 'This service IS set to start at boot, and THIS CALL DOES NOT CHANGE THAT: stopping it now ' +
        'leaves it configured to come back at the next boot.'
    : 'This service is NOT set to start at boot, and THIS CALL DOES NOT CHANGE THAT: starting it ' +
        'now does not make it survive a reboot, and nothing in this catalog sets that flag.';
}

/** What this call does to whatever the service was serving, per verb. */
function controlEffectSentence(verb: ControlVerb): string {
  if (verb === 'START') {
    return (
      'Starting a service interrupts nothing that is already running; what it can do is expose a ' +
      'share, export or target to the network that was not reachable a moment ago.'
    );
  }
  const interrupted =
    'EVERY CLIENT CONNECTED THROUGH THIS SERVICE IS DISCONNECTED — an SMB or NFS session, an ' +
    'iSCSI or NVMe-oF initiator, an SSH login, a transfer in flight. What that costs is the ' +
    "client's to say and not this system's: an interrupted write can leave a file half written " +
    'on the far side, and NOTHING HERE RECOVERS THAT.';
  return verb === 'STOP'
    ? `STOPPING THIS SERVICE TAKES IT OFF THE NETWORK. ${interrupted}`
    : `A RESTART STOPS THE SERVICE AND STARTS IT AGAIN, so it is not a reload and not a pause. ` +
        `${interrupted} The service is expected back up afterwards, which is what makes this a ` +
        'restart rather than a stop — but the stop half happens first and happens whatever the ' +
        'start half then does.';
}

/**
 * The plan step for the read `execute` makes on either side of the call.
 *
 * ONE STEP FOR TWO CALLS, which is #156's rule rather than an exception to
 * #119's: a repeated call is not a further call to disclose, it is the same one
 * happening twice, and the step says so in words. Listing it twice would show an
 * approver two entries it has no way to tell apart.
 *
 * WHEN the second read happens is stated because it is not "immediately after
 * the call": this is a job-backed tool, so the read is made when the WATCH ends,
 * which can be the full bound later and is not when the operation finished
 * (#161).
 */
function serviceReadStep(name: string, seconds: number): PlanStep {
  return {
    method: 'service.query',
    params: serviceReadParams(),
    description:
      `Read the services this system reports, to report the state "${name}" was in before this ` +
      'call. Changes nothing, and reads every service rather than filtering for one. THIS SAME ' +
      `READ IS MADE AGAIN WHEN THE WATCH BELOW ENDS — UP TO ${seconds} SECONDS AFTER THIS CALL ` +
      'IS MADE, AND NOT WHEN THE OPERATION FINISHES — to report the state reached by then. It is ' +
      'listed once because it is one call made twice.',
  };
}

/** What the plan says about the watch, in this tool's own wording. */
function serviceWatchSentence(seconds: number): string {
  return (
    'This starts a background job; the job is then followed through the ' +
    "client's own tracking, which reads `core.get_jobs` and changes nothing, " +
    `for at most ${seconds} seconds. The operation continues after that whether ` +
    'or not it has finished.'
  );
}

/**
 * The job states this file reads as a run that worked.
 *
 * ITS OWN SET rather than one shared with `tasks.ts` or `vms.ts`, under #86's
 * line: a state VOCABULARY is a family's own and each tool states its own in its
 * own description, where a shared constant would put the words in one file and
 * the sentence about them in another.
 *
 * A terminal state this catalog does not recognise is NOT read as a success: a
 * run that cannot be shown to have worked has not been shown to have worked.
 */
const SERVICE_JOB_SUCCESS_STATES = new Set(['SUCCESS', 'FINISHED']);

/** What a bounded watch of one job established. */
interface WatchedServiceJob {
  job_id: number | null;
  ended: boolean;
  succeeded: boolean | null;
  job_state: string | null;
  error: string | null;
  finished_at: string | null;
  control_result: boolean | null;
}

/**
 * Start the control job and watch it for a bounded time, then report what there
 * is.
 *
 * THE SHAPE IS `cloudsync_run`'S (#122) AND IS COPIED RATHER THAN REDERIVED, by
 * way of the VM power tools (#161). `callAndGetJobId` and `trackJob` are called
 * apart rather than through `api.job`, so the two failure eras stay separable;
 * ending the watch does not end the job, because `trackJob` only observes;
 * `ended` is read from the tracking COMPLETING rather than from a state list
 * written down here; and `job_id` comes from the correlation and never from the
 * tracking's last emission, because it is the one thing that survives a watch
 * that established nothing else. Every reason for every one of those is written
 * out at `cloudsyncRun` in `tasks.ts` and in `CLAUDE.md`'s #122 decision, and
 * none of it is re-argued here.
 *
 * THIS IS THE FOURTH COPY OF THAT PIPE IN THIS REPOSITORY — two inline in
 * `tasks.ts`, one as `watchVmJob` in `vms.ts`, this one — and promoting it is
 * owed rather than done here: it would mean rewriting three tools this ticket
 * does not touch, and the success-state vocabulary each keeps has to stay a
 * per-family argument rather than travel with it. Proposed as its own ticket.
 *
 * WHAT IS THIS TOOL'S OWN RATHER THAN INHERITED is `control_result`.
 * `service.control` declares `response: boolean` where `cloudsync.sync` and
 * `vm.stop` declare `response: null`, so there IS a result to read — and it is
 * read only where the job was established to have ended, since a job still
 * running has not produced one.
 */
async function watchServiceJob(
  ctx: ToolContext,
  started: Observable<number>,
  watchMs: number,
): Promise<WatchedServiceJob> {
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
    succeeded: ended ? SERVICE_JOB_SUCCESS_STATES.has(state) : null,
    job_state: state,
    error: textOrNull(record?.['error']),
    // Both gated on `ended` rather than on a state list of their own, so they
    // follow the claim this tool has already made and cannot contradict it.
    finished_at: ended ? isoOrNull(jobMillis(record?.['time_finished'])) : null,
    control_result: ended ? booleanOrNull(record?.['result']) : null,
  };
}

/**
 * The failure message for a control that finished with the service somewhere
 * other than the state asked for, or null where nothing establishes that.
 *
 * THIS IS THE ONE PLACE A COMPLETED MUTATION IS REPORTED AS AN ERROR, and #164
 * asks for it in those words: a service that fails to reach the requested state
 * is an error saying which state it is in instead. It is deliberately narrow,
 * because three other outcomes look like this one and none of them is a failure:
 *
 * - **The watch ran out before the job did.** Nothing was established about
 *   where the service ended up, so a state that is not yet the one asked for is
 *   a service still on its way. Requires `ended`.
 * - **The read after the watch failed, or listed no such service.** That is this
 *   tool being unable to say, not the system saying no. Requires a `FOUND`
 *   reading.
 * - **The service reported a state this tool could not read.** There is then no
 *   word to put in the message, and "it is in null" is not an answer. Requires a
 *   non-null state.
 *
 * The message carries the job id and the job's own error text where there is
 * one, because throwing is what discards the rest of the result — a caller left
 * with only this sentence still has the number that names the run and the reason
 * the system gave.
 */
function reachedStateFailure(
  args: ServiceControlArgs,
  job: WatchedServiceJob,
  resulting: ServiceAttempt,
): string | null {
  const state = resulting.reading?.state ?? null;
  const expected = EXPECTED_STATE[args.verb];
  if (!job.ended || serviceLookupOf(resulting) !== 'FOUND' || state === null) return null;
  if (state === expected) return null;
  return (
    `The ${args.verb} of "${args.service}" on this system finished and the service did NOT reach ` +
    `\`${expected}\`: it is in \`${state}\` instead. The call was made and the job ended in ` +
    // Never null here: `ended` is only true where a state was read, so a branch
    // for the null case would be one nothing can reach.
    `state \`${job.job_state}\`` +
    (job.job_id === null ? '' : `, job id ${job.job_id}`) +
    '. ' +
    (job.error === null ? '' : `The job recorded: ${job.error}. `) +
    (job.control_result === null
      ? ''
      : `The middleware answered \`${String(job.control_result)}\` for the control itself. `) +
    'Read `services_status` for what this system says about the service now.'
  );
}

export const serviceControl: MutatingTool = {
  name: 'service_control',
  description:
    'Starts, stops or restarts one service on a TrueNAS system, and reports ' +
    'the state the service ended in. Two-phase: called without a ' +
    'confirmation_token it returns a plan for user approval; called with one it ' +
    'starts the operation. `service` IS THE MIDDLEWARE\'S OWN INTERNAL NAME FOR ' +
    'THE SERVICE, NOT THE NAME THE WEB UI SHOWS — SMB is `cifs` and iSCSI is ' +
    '`iscsitarget` — and is taken exactly as `services_status` reports it in ' +
    'its `service` field, with no translation and no fuzzy matching. PLANNING ' +
    'AGAINST A NAME NO SERVICE HAS FAILS, NAMING IT AND LISTING THE NAMES THAT ' +
    'WOULD HAVE WORKED, so an approved plan is always about a service that ' +
    'existed when it was made. `verb` is `START`, `STOP` or `RESTART`. THE ' +
    'MIDDLEWARE ALSO DEFINES `RELOAD` AND THIS TOOL DOES NOT OFFER IT: a reload ' +
    'leaves the service running and re-reads its configuration, which is not a ' +
    'start, a stop or a restart, and NOTHING IN THIS CATALOG RELOADS A SERVICE. ' +
    'A SERVICE ALREADY IN THE STATE THE VERB AIMS AT IS NOT AN ERROR HERE: ' +
    'starting a running service or stopping a stopped one is planned and made ' +
    'like any other call, and the result says it was already there through ' +
    '`previously_state` and a `changed` of false. Whether the MIDDLEWARE treats ' +
    'such a call as a no-op or rejects it is (unconfirmed) here — it was not ' +
    'read off a live system and this API surface does not say. STOPPING OR ' +
    'RESTARTING A SERVICE DISCONNECTS EVERY CLIENT USING IT: an SMB or NFS ' +
    'session, an iSCSI or NVMe-oF initiator, an SSH login, a transfer in ' +
    'flight. An interrupted write can leave a file half written on the far ' +
    'side and NOTHING HERE RECOVERS THAT. THIS TOOL DOES NOT CHANGE WHETHER A ' +
    'SERVICE STARTS AT BOOT, and nothing in this catalog does: starting a ' +
    'service that is not set to start at boot does not make it survive a ' +
    'reboot, and stopping one that is leaves it configured to come back. ' +
    '`services_status` is where that setting is read. THE RESULT IS ABOUT THE ' +
    'JOB THIS CALL STARTED, AND "STARTED" IS NOT "DONE". Stopping a service ' +
    'waits on clients and on the daemon itself, so this tool WATCHES THE JOB ' +
    'FOR AT MOST `watched_seconds` AND THEN RETURNS WHATEVER IT HAS, leaving ' +
    'the operation going. It never waits for it to finish. THE WATCH ALSO ENDS ' +
    'IF FOLLOWING THE JOB FAILS — a dropped connection, a failed read of the ' +
    'job list — and that is reported as what was established rather than as the ' +
    'operation having failed, since it was already under way. A failure BEFORE ' +
    'anything was seen of the job fails this call instead, and even then MAY ' +
    'STILL HAVE STARTED THE OPERATION: read `services_status` rather than ' +
    'assuming nothing happened. THE STATES ARE READ BACK FROM THE SYSTEM RATHER ' +
    'THAN INFERRED FROM THE CALL BEING ACCEPTED: this tool reads `service.query` ' +
    'immediately before the call and again when the watch ends, and both ' +
    'readings are the same `state` word `services_status` reports. ' +
    '`previously_state` and `resulting_state` are those two readings. ' +
    '`resulting_state` IS READ WHEN THE WATCH ENDS AND NOT WHEN THE OPERATION ' +
    'DOES, so on a service still starting or stopping it is the state part-way ' +
    'through and not the state it settles in. `expected_state` is the word this ' +
    'verb aims at — `RUNNING` for `START` and `RESTART`, `STOPPED` for `STOP`. ' +
    'IF THE JOB ENDED AND THE SERVICE WAS READ IN SOME OTHER STATE, THIS TOOL ' +
    'FAILS WITH AN ERROR NAMING THAT STATE rather than returning a result — so ' +
    'a result in hand whose `resulting_state` is not `expected_state` means the ' +
    'watch ended before the job did, or the state could not be read. THAT ' +
    'ERROR DOES NOT MEAN NOTHING HAPPENED: the call was made and the operation ' +
    'ran. `changed` IS THE TWO `state` READINGS COMPARED AND NOTHING ELSE, and ' +
    'is NULL WHERE EITHER READING IS, WHICH IS NOT "NOTHING CHANGED". A ' +
    '`changed: false` ACROSS A RESTART IS THE ORDINARY ANSWER FOR A SUCCESSFUL ' +
    'ONE, since a service that was running and is running again read the same ' +
    'both times — it is NOT a statement about whether the service was ' +
    'restarted. `previous_lookup` and `resulting_lookup` say what each read ' +
    'did: `FOUND` is a read that named this service, `NOT_FOUND` a read that ' +
    'completed and listed no service under this name, `UNREADABLE` a read that ' +
    'failed — with `previous_read_error` and `resulting_read_error` naming why ' +
    'and null otherwise. A `FOUND` beside a null state is a fourth case those ' +
    'three words do not separate: the service was listed and reported no state ' +
    'this tool could read. THE CALL IS MADE IN ALL OF THOSE CASES AND NOTHING ' +
    'BRANCHES ON EITHER READ, because what runs must be what was approved — and ' +
    'a read that failed after the call is not a failed call. `control_result` ' +
    'is the boolean the middleware answers the control itself with, REPORTED ' +
    'ONLY WHERE `ended` IS TRUE and null everywhere else. IT IS NOT WHERE THE ' +
    'OUTCOME COMES FROM: the state above is, and a `control_result` of false ' +
    'beside a `resulting_state` that IS `expected_state` is the two disagreeing ' +
    'rather than one of them being the answer. `ended` is whether the job was ' +
    'ESTABLISHED to have reached a state it will not move out of. TRUE MEANS ' +
    'THE JOB IS OVER. FALSE MEANS NOTHING WAS ESTABLISHED AND IS NOT ONE ' +
    'ANSWER — the operation is still going, or the watch was cut short by ' +
    'either of the failures above, or the job reached a state the system does ' +
    'not treat as ending a run, or the job reported a state this tool could not ' +
    'read, or no job was seen at all. `job_state` and `job_id` narrow that and ' +
    'DO NOT PARTITION IT. IN NONE OF THEM HAS ANYTHING FAILED. `succeeded` is ' +
    'true where the job ENDED in a state this catalog reads as success, false ' +
    'where it ENDED in any other state, and NULL WHERE NOTHING ESTABLISHED IT — ' +
    'which is every case where `ended` is false. A null `succeeded` IS NEITHER ' +
    'A FAILURE NOR A SUCCESS. NO STATE THIS CATALOG DOES NOT KNOW IS EVER READ ' +
    'AS A SUCCESS; `SUCCESS` and `FINISHED` are the two it counts. `job_state` ' +
    'is the state the system last reported, passed through as it spelled it. ' +
    '`error` is the text the job recorded and is null where it recorded none. ' +
    '`finished_at` is when the job ended, as an ISO 8601 UTC timestamp, ' +
    'REPORTED ONLY WHERE `ended` IS TRUE and null everywhere else even if the ' +
    'job record carries a time. `job_id` is the job\'s numeric identity, TAKEN ' +
    'FROM THE JOB EVENT THAT NAMED THIS REQUEST rather than from anything read ' +
    'about the job afterwards, so it is reported even where the watch ' +
    'established nothing else; it is null where no such event was seen within ' +
    'the watch, and also where one was seen and the id it carried was not a ' +
    'number this tool could read. NEITHER MEANS THE OPERATION DID NOT START. ' +
    '`watched_seconds` is the CEILING that applied, not how long the watch ' +
    'actually lasted. THIS TOOL CANNOT STOP A RUNNING JOB once it has started ' +
    'one, cannot reload a service, cannot change a service\'s configuration ' +
    '(`smb.config` and the like are in no tool here), cannot change whether one ' +
    'starts at boot, and does not touch applications or containers, whose ' +
    'lifecycle is a different surface entirely.',
  inputSchema: {
    type: 'object',
    properties: {
      service: {
        type: 'string',
        description:
          "The service's name as `services_status` reports it in its `service` " +
          'field, on the system being targeted — the middleware\'s own internal ' +
          'name (`cifs` for SMB, `iscsitarget` for iSCSI), not the web UI label.',
      },
      verb: {
        type: 'string',
        enum: [...CONTROL_VERBS],
        description:
          'What to do to it: `START`, `STOP` or `RESTART`. `RELOAD` is not ' +
          'offered by this tool.',
      },
    },
    required: ['service', 'verb'],
  },
  requiredRole: Role.Full,
  mutating: true,
  // The operation is reversible in the sense `Destructiveness` names — a stopped
  // service is started again, a started one stopped, and both verbs are this
  // tool. What a stop does to the clients that were connected through it is NOT
  // reversible, and this field cannot say both: it records the operation, and
  // the account of the interrupted sessions is in the description and in the
  // plan, which is where the person approving reads it. That division is #122's
  // and is stated at the field's own declaration in `catalog/tool.ts`.
  destructiveness: 'reversible',
  normalizeArgs(rawArgs) {
    const args = parseServiceControlArgs(rawArgs);
    return { service: args.service, verb: args.verb };
  },
  async plan(ctx, rawArgs): Promise<PlanStep[]> {
    const args = parseServiceControlArgs(rawArgs);
    const reading = await readService(ctx, args.service);
    if (!reading.listed) throw new Error(missingServiceError(args.service, reading.names));
    return [
      serviceReadStep(args.service, SERVICE_CONTROL_WATCH_SECONDS),
      {
        method: 'service.control',
        params: serviceControlParams(args),
        description:
          `${args.verb} the service "${args.service}" on this system. ` +
          `${serviceStateSentence(reading)}${alreadyInStateSentence(args, reading)} ` +
          `${controlEffectSentence(args.verb)} ${bootSettingSentence(reading)} ` +
          serviceWatchSentence(SERVICE_CONTROL_WATCH_SECONDS),
      },
    ];
  },
  async execute(ctx, rawArgs) {
    const args = parseServiceControlArgs(rawArgs);
    const previous = await attemptService(ctx, args.service);
    const job = await watchServiceJob(
      ctx,
      ctx.system.client.api.callAndGetJobId('service.control', serviceControlParams(args)),
      SERVICE_CONTROL_WATCH_MS,
    );
    // Read when the watch ends, not when the operation ends: the two are the
    // same only where the job ended inside the bound, which is why
    // `resulting_state` is described as the state when the watch ended.
    const resulting = await attemptService(ctx, args.service);
    const failure = reachedStateFailure(args, job, resulting);
    if (failure !== null) throw new Error(failure);
    const previouslyState = previous.reading?.state ?? null;
    const resultingState = resulting.reading?.state ?? null;
    return {
      service: args.service,
      verb: args.verb,
      expected_state: EXPECTED_STATE[args.verb],
      previous_lookup: serviceLookupOf(previous),
      previous_read_error: previous.error,
      previously_state: previouslyState,
      resulting_lookup: serviceLookupOf(resulting),
      resulting_read_error: resulting.error,
      resulting_state: resultingState,
      changed:
        previouslyState === null || resultingState === null
          ? null
          : previouslyState !== resultingState,
      watched_seconds: SERVICE_CONTROL_WATCH_SECONDS,
      ...job,
    };
  },
};
