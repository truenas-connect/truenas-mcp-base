import type { CallResponse, JobParams } from '@truenas/api-client';
import { firstValueFrom } from 'rxjs';
import { Role } from '@/interfaces';
import type { MutatingTool, PlanStep, ToolContext } from '@/catalog/tool';
import { ApiSurface, ReadOnlyTool, SystemHandle } from '@/catalog/tool';
import {
  booleanOrNull,
  errorText,
  recordOrNull,
  refuseArgs,
  strictTextList,
  textOrNull,
  watchJob,
  type WatchedJob,
} from '@/tools/common';

/**
 * The applications family. Three tools, and they are three rather than one
 * because they answer three questions: `apps_list` is what is installed,
 * `app_engine_status` is whether the layer they run on is up at all, and
 * `apps_update_summary` is what a waiting update would actually change.
 *
 * **Why the engine and the updates are not one tool.** They arrived on one
 * ticket and both exist to make `apps_list` interpretable, which is the case
 * for folding them together. The case against is the one `CLAUDE.md` records
 * for `automated_tasks_list`: sections belong in one tool when the subject is
 * COMPLETENESS ACROSS KINDS — when a caller reaching only some of them gets a
 * confident answer with a category silently missing from it. That is not this.
 * A caller reading only the engine status is not given a wrong answer about
 * updates, and a caller reading only the updates is not given a wrong answer
 * about the engine; neither completes the other, and the two are read by
 * different calls over different subjects — one host-wide record with no
 * arguments, and one read per application. The name settles what is left: a
 * single tool over both would have to be named for the engine or for the apps,
 * and either name promises what only the other half delivers.
 *
 * What they do owe each other is a POINTER, and both descriptions carry one.
 * Twelve applications reporting as stopped because the engine is down is the
 * misreading this family is most likely to produce, and it is only avoidable if
 * a caller reading one tool knows the other exists.
 *
 * Two tools here mutate: `app_upgrade` and `app_rollback` move one application
 * between catalog versions, and ship together so the upgrade's reversal is a
 * tool rather than a call a reader has to go elsewhere for (#197). Installing,
 * starting and stopping an app exist on the middleware and are not in this
 * catalog.
 */

/** Applications installed on a system: what is deployed, what is running, and
 * what has an update waiting.
 *
 * Nothing else in the catalog knows an application exists, so "what is running
 * on this box" and "is anything out of date" are unanswerable without it — and
 * apps are where a home or small-business TrueNAS spends most of its
 * operational attention.
 *
 * The mapping is an allowlist rather than a trim, and it is doing two jobs at
 * once. Size is the loud one: an `app.query` row carries the app's full chart
 * metadata, its rendered portals and `active_workloads` — every container, port
 * and volume — so passing it through would make this the most expensive
 * response in the catalog. Secrecy is the quiet one: `config` holds the values
 * the user filled in at install time, which routinely include an API key or a
 * claim token, so naming the output fields is what keeps them out of the tool
 * result and so out of the conversation, exactly as in `disks.ts`. Trimming is
 * the point of the tool rather than a nicety, on both counts.
 *
 * The query also names those fields, so the size job now starts at the wire
 * rather than at the mapping (#115). THAT DOES NOT RETIRE THE ALLOWLIST, and
 * the reason is in the client's own types: middleware honours `select` on its
 * CURRENT api version, and a client talking to a newer appliance over an older
 * version gets every non-required field's default filled back in. So a
 * projected row can arrive padded — with `config` on it — and the allowlist is
 * what keeps it out of the result either way. `select` narrows the read; only
 * the mapping bounds what a caller sees.
 */

export const appsList: ReadOnlyTool = {
  name: 'apps_list',
  description:
    'Applications installed on a TrueNAS system: name, installed version, ' +
    'running state, and whether an update is waiting. Apps that are not ' +
    'running are included — `state` distinguishes STOPPED from CRASHED, and ' +
    'from the transient DEPLOYING and STOPPING. `upgrade_available` means a ' +
    'newer catalog version exists (`latest_version` names it); ' +
    '`image_updates_available` is the separate question of whether the ' +
    'containers the app already runs have newer images, which is the only ' +
    'kind of update a custom app can have. EVERY FIELD IS NULL WHERE THE ' +
    'SYSTEM REPORTED NO VALUE FOR IT, and A NULL IS NEVER TO BE READ AS THE ' +
    'NEGATIVE. A null `upgrade_available` or `image_updates_available` means ' +
    'NOTHING WAS ESTABLISHED about that kind of update; it is not the claim ' +
    'that none is waiting, which is FALSE. `latest_version` is null both ' +
    'where the system knows of no newer version and where it reported none, ' +
    'and this tool does not tell those two apart. A null `name`, `version` ' +
    'or `state` is the system having reported no value under that name, and ' +
    'a null `state` is NOT an app that is stopped. An app is never left out ' +
    'of the list for carrying one, so a null never shortens this list. THERE ' +
    'IS NO PARTIAL ANSWER HERE: the listing either succeeds or this tool ' +
    'fails, so a null is always about one field of one app rather than about ' +
    'a read that did not happen.',
  inputSchema: { type: 'object', properties: {} },
  requiredRole: Role.ReadOnly,
  mutating: false,
  async handler({ system }) {
    // The options object is written INLINE, as the filter in
    // `reporting_app_vm_usage` is: the client infers the result type from the
    // options *literal*, so a `select` hoisted to a `const` widens and the rows
    // degrade from `Pick<AppEntry, …>` to `Partial<AppEntry>`. Imprecise rather
    // than unsound, but it would stop the compiler catching a field this
    // mapping reads and the select forgot.
    const apps = await firstValueFrom(
      system.client.api.query('app.query', [], {
        select: [
          'name',
          'version',
          'latest_version',
          'state',
          'upgrade_available',
          'image_updates_available',
        ],
      }),
    );
    return apps.map((app) => ({
      // `?? null` on every field, because a projection is the one read where a
      // field this tool names can be absent from the row rather than null on
      // it: middleware HONOURING the select returns those fields and no
      // others, so a name that is not a field on the release answering — one a
      // later release drops, or renames — comes back as no key at all. Not
      // honouring it is the opposite failure and needs no fallback: an
      // unrecognised parameter is dropped rather than refused, and the row
      // arrives whole.
      //
      // `undefined` serializes to no key, so without the fallback a caller
      // would get an object missing fields the description promises instead of
      // nulls it can see are absent — the reason `boot.ts` spells out an
      // unread section's fields rather than leaving them off.
      //
      // It is `?? null` and not `textOrNull`: this ticket is bandwidth, and a
      // guard would additionally change what a malformed value reports, which
      // is a change to what the tool says.
      name: app.name ?? null,
      // The catalog version of the app as installed. `human_version` is the
      // middleware's display string for the same thing and is deliberately
      // not surfaced: it splices the upstream software's version onto this
      // one, so the two read as disagreeing, and only `version` is comparable
      // with `latest_version`.
      version: app.version ?? null,
      latest_version: app.latest_version ?? null,
      state: app.state ?? null,
      upgrade_available: app.upgrade_available ?? null,
      image_updates_available: app.image_updates_available ?? null,
    }));
  },
};

/**
 * The app engine's status words, as the pinned client declares them, derived
 * from the call rather than imported by name — the route `CLAUDE.md` records
 * for a generated type, since the `$N` suffix a colliding interface carries in
 * one release is not the one it carries in the next.
 */
type EngineStatus = CallResponse<ApiSurface, 'docker.status'>['status'];

/**
 * Which of the engine's status words mean applications can run, one entry per
 * member the PINNED surface declares.
 *
 * Typed as a total `Record` over the union ON PURPOSE, so that a member added to
 * the surface this reads cannot be left unmapped silently. What it does NOT do
 * is bound what a live system can send, and the client already shows why:
 * `ApiSurface` is `DefaultApiDirectory`, the OLDEST supported directory (seven
 * words), while a later one declares `MIGRATING` and `MIGRATION_FAILED` too. A
 * system running that release can send either of them TODAY.
 *
 * That is the reason the lookup below answers null for an unmapped word rather
 * than false. The exhaustiveness is a check on this file against the surface it
 * compiles against; the null is what keeps the answer honest about every
 * surface it does not.
 */
const ENGINE_RUNNING: Record<EngineStatus, boolean> = {
  PENDING: false,
  RUNNING: true,
  STOPPED: false,
  INITIALIZING: false,
  STOPPING: false,
  UNCONFIGURED: false,
  FAILED: false,
};

/** What a system answering `docker.status` with something else is reported as. */
const NOT_A_STATUS = 'the system did not answer with an app engine status';

/** What a system answering `app.query` with something else is reported as. */
const NOT_A_LIST = 'the system did not answer with a list of applications';

/** What an application the system named nothing is reported as. */
const NO_APP_NAME =
  'the system reported no name for this application, so no update summary was read';

/** What an application whose `upgrade_available` could not be read is reported as. */
const UPDATE_UNKNOWN =
  'the system did not report whether an update is waiting for this application, so no ' +
  'update summary was read';

/** What a system answering `app.upgrade_summary` with something else is reported as. */
const NOT_A_SUMMARY = 'the system did not answer with an upgrade summary';

/** The app engine as this tool reports it. */
interface Engine {
  running: boolean | null;
  status: string | null;
  description: string | null;
}

/**
 * The engine's fields on a read that did not happen.
 *
 * Spelled out rather than left off, for the reason `boot.ts` gives: `undefined`
 * serializes to no key at all, so a caller would receive an object missing
 * fields the description promises rather than nulls it can see are absent.
 */
const UNREAD_ENGINE: Engine = { running: null, status: null, description: null };

/**
 * Whether a status word means applications can run — and null where it means
 * nothing this catalog has read.
 *
 * A word that is not a declared member is UNKNOWN rather than not-running. That
 * is the direction rule `CLAUDE.md` records for an unreadable list entry,
 * applied to a boolean: `false` here says the app engine is down, which is more
 * than "the system used a word added after this was written" established.
 *
 * The membership test is `Object.hasOwn` and not `status in ENGINE_RUNNING`,
 * because `in` walks the prototype: `'toString'` and `'constructor'` are `in`
 * every object literal, and either would have been answered `undefined` — read
 * back as a boolean the field's type says cannot be one.
 */
function engineRunning(status: string | null): boolean | null {
  if (status === null) return null;
  if (!Object.hasOwn(ENGINE_RUNNING, status)) return null;
  return ENGINE_RUNNING[status as EngineStatus];
}

export const appEngineStatus: ReadOnlyTool = {
  name: 'app_engine_status',
  description:
    'Whether the CONTAINER ENGINE that TrueNAS applications run on is up. This ' +
    'is the one call that tells "these applications are stopped" apart from ' +
    '"nothing on this system can run": when the engine is down every ' +
    'application reports as not running, and `apps_list` alone presents that as ' +
    'a list of independently broken applications. READ THIS BEFORE CONCLUDING ' +
    'ANYTHING FROM SEVERAL STOPPED APPLICATIONS. `running` is the answer: TRUE ' +
    'where the system reported a status meaning applications can run, FALSE ' +
    'WHERE IT REPORTED ONE MEANING THEY CANNOT — which is a positive finding, ' +
    'the engine is down — and NULL WHERE NOTHING WAS ESTABLISHED, which is any ' +
    'of three: the read failed, the system used a status word this catalog does ' +
    'not know, or it reported no status this tool could read at all. THOSE LAST ' +
    'TWO BOTH ANSWER WITH `unavailable` NULL, since the engine was read and only ' +
    'its status was not understood; they are told apart by `status`, which ' +
    'carries the unknown word in the second case and is null in the third. ' +
    'A NULL `running` IS NEVER TO BE READ AS THE FALSE ' +
    'ONE. `status` is the system\'s own word, passed through as it spelled it: ' +
    'RUNNING means the engine is up, STOPPED and FAILED mean it is not, ' +
    'PENDING, INITIALIZING and STOPPING are transient, and UNCONFIGURED means ' +
    'the applications feature has never been set up on this system — commonly ' +
    'because no pool has been chosen to hold it, which is a configuration ' +
    'answer rather than a fault. THE SET IS NOT CLOSED and any other value is ' +
    'to be read as itself. `description` is the prose the system offered about ' +
    'that status, written for a person, and is null where it offered none. ' +
    '`unavailable` is null where the engine was read, and otherwise what the ' +
    'system said about the failure — AND THEN EVERY OTHER FIELD IS NULL ' +
    'BECAUSE NOTHING WAS READ, not because the system reported nothing. A ' +
    'system with no applications support at all answers here rather than ' +
    'failing. This tool reports the ENGINE and NOT the applications on it: ' +
    '`apps_list` is what is installed and what state each one is in, and ' +
    '`apps_update_summary` is what a waiting update would change. It does not ' +
    "report the engine's settings — its address pools, its dataset or its " +
    'network configuration are in no tool in this catalog — it does not report ' +
    'how many containers are running, and it starts, stops and configures ' +
    'nothing.',
  inputSchema: { type: 'object', properties: {} },
  requiredRole: Role.ReadOnly,
  mutating: false,
  async handler({ system }) {
    try {
      const answer = await firstValueFrom(system.client.api.call('docker.status'));
      // Read through `recordOrNull` rather than reached into, as `boot.ts`
      // does: a system answering this call with something that is not a status
      // would otherwise throw naming a property, and the caller would see the
      // name of a field rather than the read that failed.
      const held = recordOrNull(answer);
      if (held === null) return { unavailable: NOT_A_STATUS, ...UNREAD_ENGINE };
      const status = textOrNull(held['status']);
      return {
        unavailable: null,
        running: engineRunning(status),
        status,
        description: textOrNull(held['description']),
      };
    } catch (reason) {
      // An engine that is not installed rejects here rather than answering, and
      // that is an answer about the system rather than a fault of the tool.
      return { unavailable: errorText(reason), ...UNREAD_ENGINE };
    }
  },
};

/**
 * An application as `app.query` reports it, narrowed to the fields
 * {@link candidateOf} reads — which are the fields the call's `select` names.
 *
 * The two are kept in step by the compiler rather than by hand: the handler
 * passes these rows straight to `candidateOf`, so a `select` that stops naming
 * one of them stops type-checking. The other direction — a `select` naming more
 * than this reads — is wasted bytes rather than a wrong answer, and nothing
 * catches it.
 */
type AppEntry = Pick<
  ApiSurface['call']['app.query']['entity'],
  'name' | 'version' | 'human_version' | 'upgrade_available'
>;

/**
 * One application's waiting update, or the stated reason none was read.
 *
 * `installed_*` come from the listing and are filled in even where the summary
 * could not be read: they are what the system already told us, and dropping
 * them with the summary would lose a fact that did not fail.
 */
interface UpdateEntry {
  app: string | null;
  unavailable: string | null;
  installed_version: string | null;
  installed_human_version: string | null;
  upgrade_version: string | null;
  upgrade_human_version: string | null;
  latest_version: string | null;
  latest_human_version: string | null;
}

/** What the listing said about one application, whatever the summary adds. */
interface Listed {
  app: string | null;
  installed_version: string | null;
  installed_human_version: string | null;
}

/**
 * One listed application, and either the name to ask by or the reason no call
 * will be made.
 *
 * A UNION rather than two nullable fields, so that "there is a reason not to
 * ask" and "there is no name to ask by" cannot disagree. Written as one shape
 * it needed a fallback name on a branch nothing can reach — a guard no test can
 * observe, which is a review finding this repository has already paid for once.
 *
 * `skip` holds a fact about the APPLICATION rather than about a read that
 * failed, which is the distinction `reporting_app_vm_usage` keeps when it
 * declines to ask a stopped VM for its memory.
 */
type Candidate =
  | { listed: Listed; name: string; skip: null }
  | { listed: Listed; name: null; skip: string };

/**
 * The applications whose update is worth asking about, and the reason for each
 * one that is listed but will not be asked.
 *
 * An application the system reported as having NO update waiting is left out
 * entirely — that is this tool's subject, and its absence is a claim the read
 * established. One whose `upgrade_available` could not be read is KEPT, because
 * dropping it would make the same claim without having established it: the
 * direction rule `CLAUDE.md` records, where a shorter list must not say more
 * than the read did.
 *
 * `app.upgrade_summary` is not called for such an application either. Whether
 * it rejects for one with no update waiting is unconfirmed against a live
 * system, and asking would turn "we do not know" into either a false answer or
 * an error reported as a failed read.
 */
function candidateOf(entry: AppEntry): Candidate | null {
  const waiting = booleanOrNull(entry.upgrade_available);
  if (waiting === false) return null;
  const name = textOrNull(entry.name);
  const listed: Listed = {
    app: name,
    installed_version: textOrNull(entry.version),
    // The upstream software's own version, which `apps_list` deliberately does
    // not surface: there it would sit beside a catalog `version` it is not
    // comparable with, and the two read as disagreeing. Here it has something
    // to be compared WITH — the human version the upgrade moves to — and that
    // pair is the only part of this result that says what the application
    // itself changes rather than what its packaging does.
    installed_human_version: textOrNull(entry.human_version),
  };
  if (waiting === null) return { listed, name: null, skip: UPDATE_UNKNOWN };
  if (name === null) return { listed, name: null, skip: NO_APP_NAME };
  return { listed, name, skip: null };
}

/**
 * An entry for an application that was listed and not read, or not asked about.
 *
 * The fields are named in the same order the read path names them rather than
 * spread, so every entry in `entries` carries its keys in one order whichever
 * branch produced it.
 */
function unread(listed: Listed, reason: string): UpdateEntry {
  return {
    app: listed.app,
    unavailable: reason,
    installed_version: listed.installed_version,
    installed_human_version: listed.installed_human_version,
    upgrade_version: null,
    upgrade_human_version: null,
    latest_version: null,
    latest_human_version: null,
  };
}

/**
 * One application's upgrade summary, with a failure named rather than thrown.
 *
 * NO SUMMARY MAY FAIL THE TOOL. Each is a separate call and one application's
 * catalog being unreachable must not take the rest of the report down with it —
 * the same seam `reporting_app_vm_usage` uses for its per-VM memory reads.
 */
async function readSummary(system: SystemHandle, candidate: Candidate): Promise<UpdateEntry> {
  // `skip` is the discriminant: non-null on exactly the shape whose `name` is
  // null, so the call below has a name to ask by without a fallback.
  if (candidate.skip !== null) return unread(candidate.listed, candidate.skip);
  const { listed } = candidate;
  try {
    const answer = await firstValueFrom(
      system.client.api.call('app.upgrade_summary', [candidate.name]),
    );
    const held = recordOrNull(answer);
    if (held === null) return unread(listed, NOT_A_SUMMARY);
    return {
      app: listed.app,
      unavailable: null,
      installed_version: listed.installed_version,
      installed_human_version: listed.installed_human_version,
      upgrade_version: textOrNull(held['upgrade_version']),
      upgrade_human_version: textOrNull(held['upgrade_human_version']),
      latest_version: textOrNull(held['latest_version']),
      latest_human_version: textOrNull(held['latest_human_version']),
    };
  } catch (reason) {
    return unread(listed, errorText(reason));
  }
}

export const appsUpdateSummary: ReadOnlyTool = {
  name: 'apps_update_summary',
  description:
    'For each installed application with a CATALOG UPDATE WAITING, what version ' +
    'it would move to. `apps_list` reports THAT an update exists; this reports ' +
    'WHAT IT IS, which is what an operator needs to decide whether to take it. ' +
    '`entries` is one entry per such application, in the order the system ' +
    'listed them, and is NULL WHENEVER `unavailable` IS NON-NULL. An EMPTY ' +
    '`entries` is a different answer — the applications were listed and none ' +
    'has an update waiting — and null is never to be read as that. ' +
    '`unavailable` at the top level is why the application listing could not be ' +
    'read; each ENTRY carries its own `unavailable` for why that one ' +
    "application's summary could not be, and one failing there never empties or " +
    'falsifies another. AN APPLICATION IS ABSENT FROM `entries` ONLY WHERE THE ' +
    'SYSTEM REPORTED THAT NO CATALOG UPDATE IS WAITING FOR IT. One whose update ' +
    'state could not be read is PRESENT with `unavailable` saying so, so a ' +
    'short list never quietly means "everything else is up to date". ' +
    '`app` is the application name, null where the system reported none — and ' +
    'an application with no name cannot be looked up, which is what that ' +
    "entry's `unavailable` says. `installed_version` and " +
    '`installed_human_version` come from the LISTING rather than the summary, ' +
    'so they are reported even for an entry whose summary failed. ' +
    '`upgrade_version` is the catalog version this upgrade would move to and ' +
    '`latest_version` is the newest the system knows of; THEY ARE NOT ALWAYS ' +
    'THE SAME, and where they differ the upgrade stops short of the newest. ' +
    'The `*_human_version` pair is the version of the SOFTWARE INSIDE the ' +
    'application rather than of its TrueNAS packaging, and the two vocabularies ' +
    'are not comparable: compare a human version only with another human ' +
    'version, and a plain version only with another plain version. Every field ' +
    'is null where the system reported no value this tool could read. ON AN ' +
    'ENTRY WHOSE `unavailable` IS NON-NULL, the four version fields above are ' +
    'ALL NULL and the three that came from the LISTING — `app`, ' +
    '`installed_version` and `installed_human_version` — still carry whatever ' +
    'the listing reported, because that read did not fail. A null among those ' +
    'three is the listing having reported no value, not the summary having ' +
    'failed. ' +
    'THE RELEASE NOTES ARE NOT REPORTED. The middleware offers a changelog and ' +
    'it is deliberately dropped: it is unbounded upstream prose returned once ' +
    'per application, and a cap on it could drop the very line naming a ' +
    'breaking change while still presenting itself as the answer to what the ' +
    'update alters. Neither is the list of OTHER versions available to upgrade ' +
    'to; every entry here is fixed in size, so this response grows only with ' +
    'the number of applications that have an update. NO OTHER KIND OF UPDATE IS ' +
    "COVERED: `apps_list`'s `image_updates_available` — whether the containers " +
    'an application already runs have newer images — is a separate question ' +
    'this tool says nothing about, and a custom application, which has no ' +
    'catalog version at all, never appears here even when its images are out of ' +
    'date. If several applications also report as not running, read ' +
    '`app_engine_status` before concluding anything about them. This tool ' +
    'upgrades nothing and changes nothing.',
  inputSchema: { type: 'object', properties: {} },
  requiredRole: Role.ReadOnly,
  mutating: false,
  async handler({ system }) {
    let candidates: Candidate[];
    try {
      // Four fields, and NOT the six `apps_list` asks for. The lists overlap
      // without either containing the other: `candidateOf` never reads
      // `latest_version` or `image_updates_available` — the newest catalog
      // version this tool reports comes from `app.upgrade_summary` rather than
      // from the listing — and it does read `human_version`, which `apps_list`
      // deliberately drops. A `select` shared between the two paths would ask
      // each of them for fields it has no mapping for.
      //
      // Written inline for the reason `apps_list` gives above.
      const rows = await firstValueFrom(
        system.client.api.query('app.query', [], {
          select: ['name', 'version', 'human_version', 'upgrade_available'],
        }),
      );
      if (!Array.isArray(rows)) return { unavailable: NOT_A_LIST, entries: null };
      // Chosen inside the `try` with the read that produced them, so a row that
      // cannot be reached into at all — a null or an undefined in the list — is
      // the LISTING being unreadable, which is an answer, rather than an
      // exception out of a tool that promises never to throw.
      //
      // That is narrower than "any row this cannot read". A string or a number
      // IS reached into successfully and answers `undefined` to every field, so
      // it becomes an entry saying the system did not report whether an update
      // is waiting for it. That is the direction rule again and it is the
      // intended answer: the system listed something, and dropping it would say
      // one fewer application has an update waiting than was established.
      candidates = rows.flatMap((row) => {
        const candidate = candidateOf(row);
        return candidate === null ? [] : [candidate];
      });
    } catch (reason) {
      return { unavailable: errorText(reason), entries: null };
    }
    // One read per application with an update waiting, all issued together.
    // Only those are asked at all, which is what keeps this bounded by the
    // applications that have an update rather than by every one installed.
    const entries = await Promise.all(
      candidates.map((candidate) => readSummary(system, candidate)),
    );
    return { unavailable: null, entries };
  },
};

/*
 * `app_upgrade` and `app_rollback`: moving one installed application between
 * catalog versions (#197).
 *
 * THEY SHIP TOGETHER for the reason #161 gave `vm_start` and `vm_stop`: an
 * upgrade whose reversal is an obvious, already-typed API call that no tool
 * offers would be a `reversible` mutation the catalog cannot reverse. Together
 * they make the field true for the VERSION — and only for the version, which is
 * the account of the data both descriptions and both plans carry (#122, #153):
 * an upgrade can migrate the application's own data, and rolling the version
 * back does not migrate it back.
 *
 * WHAT IS NOT SENT. `values` on an upgrade routinely carries passwords and
 * tokens, held on #179; `rollback_snapshot: true` restores the app's ix-volume
 * snapshot and discards data written since the upgrade, which is a destruction
 * this tool would author (#122, #128), held on #178. Both are refused by name,
 * and the rollback SENDS `rollback_snapshot: false` rather than leaving it out,
 * because the surface does not state the middleware's default and an omitted
 * field would hand that decision to it.
 *
 * THE JOB ANSWERS WITH AN `AppEntry`, AND ITS `config` HOLDS INSTALL-TIME
 * VALUES THAT ROUTINELY INCLUDE SECRETS (#115). It is read by named field, in
 * `extra`, as `certificate_csr_create` reads its entry (#195); so is the
 * listing read after the watch, since a projected row can arrive padded.
 */

/** The middleware's name for one application, as both tools take it. */
function parseAppName(args: Record<string, unknown>): string {
  const name = args['app_name'];
  if (typeof name !== 'string' || name === '') {
    throw new Error('"app_name" is required and must be the application\'s `name` as `apps_list` reports it');
  }
  return name;
}

/** One application as these two tools read it, by named field. */
interface AppReading {
  name: string | null;
  version: string | null;
  human_version: string | null;
  state: string | null;
  upgrade_available: boolean | null;
}

/** An application's fields where nothing was read, spelled out for `boot.ts`'s reason. */
const UNREAD_APP: AppReading = {
  name: null,
  version: null,
  human_version: null,
  state: null,
  upgrade_available: null,
};

/** One `AppEntry`-shaped record read through the allowlist, and nothing else of it. */
function appReading(record: Record<string, unknown> | null): AppReading {
  if (record === null) return UNREAD_APP;
  return {
    name: textOrNull(record['name']),
    version: textOrNull(record['version']),
    human_version: textOrNull(record['human_version']),
    state: textOrNull(record['state']),
    upgrade_available: booleanOrNull(record['upgrade_available']),
  };
}

/**
 * The params the listing read reaches the middleware with, for the plan step
 * that names it. The filter and the `select` are written here AND inlined in
 * {@link readApp}, because hoisted to a `const` they widen out of the client's
 * tuple and the rows degrade (#115, #153); a test asserts each half against the
 * literal it expects.
 */
function appReadParams(name: string): unknown {
  return [
    [['name', '=', name]],
    { select: ['name', 'version', 'human_version', 'state', 'upgrade_available'] },
  ];
}

/**
 * The application the system lists under this name, or null where it lists
 * none that is. Matched on the RESPONSE, not only in the filter: a dropped
 * filter returns every application, and the first of those is another one
 * (#121).
 */
async function readApp(ctx: ToolContext, name: string): Promise<AppReading | null> {
  const rows: unknown = await firstValueFrom(
    ctx.system.client.api.query('app.query', [['name', '=', name]], {
      select: ['name', 'version', 'human_version', 'state', 'upgrade_available'],
    }),
  );
  if (!Array.isArray(rows)) throw new Error(NOT_A_LIST);
  for (const row of rows) {
    const reading = appReading(recordOrNull(row));
    if (reading.name === name) return reading;
  }
  return null;
}

/**
 * The checks both plans make before anything is planned: the application is
 * listed, and the app engine is not reported as down.
 *
 * An engine whose status could not be read, or whose word this catalog does not
 * know, does NOT refuse — a state that could not be read refuses nothing (#161)
 * — and the returned sentence says the call may be rejected instead. An engine
 * READ as not running refuses, because the middleware cannot deploy an app
 * there and a plan promising the call would promise more than it delivers.
 */
async function planPreconditions(ctx: ToolContext, name: string): Promise<{ app: AppReading; engine: string }> {
  let app: AppReading | null;
  try {
    app = await readApp(ctx, name);
  } catch (reason) {
    throw new Error(
      `Whether an application named "${name}" is installed could not be read (app.query failed: ` +
        `${errorText(reason)}), so nothing is planned`,
    );
  }
  if (app === null) {
    throw new Error(`No application named "${name}" is installed on this system; \`apps_list\` reports every name`);
  }
  let status: string | null = null;
  let failure: string | null = null;
  try {
    status = textOrNull(recordOrNull(await firstValueFrom(ctx.system.client.api.call('docker.status')))?.['status']);
  } catch (reason) {
    failure = errorText(reason);
  }
  const running = engineRunning(status);
  if (running === false) {
    throw new Error(
      `The app engine on this system reports ${status}, not RUNNING, so no application can be deployed; ` +
        '`app_engine_status` reports it',
    );
  }
  const engine =
    running === true
      ? 'The app engine reads as RUNNING.'
      : failure !== null
        ? `Whether the app engine is running could not be read (${failure}), so the call may be rejected; ` +
          '`app_engine_status` reports it.'
        : `The app engine reported ${status === null ? 'no status this tool could read' : `the status ${status}, which this catalog does not know`}, ` +
          'so the call may be rejected; `app_engine_status` reports it.';
  return { app, engine };
}

/** A version as a plan states it, naming an absence rather than dropping it. */
function versionPhrase(version: string | null, human: string | null): string {
  if (version === null) return 'a version the system reported no value for';
  return human === null ? `version ${version}` : `version ${version} (${human})`;
}

/**
 * The account of the data, in the one wording both descriptions and both plans
 * carry (#122): `reversible` is about the version, and this is the half the
 * field cannot say.
 */
const DATA_CAVEAT =
  'AN UPGRADE CAN MIGRATE THE APPLICATION\'S OWN DATA, AND A ROLLBACK RESTORES THE VERSION AND NOT THE ' +
  'DATA: an application whose new version migrated its data may not start on the old one. This catalog never ' +
  "restores the application's ix-volume snapshot on rollback, which would discard data written since the upgrade.";

/** The step for the read `execute` makes after the watch, in one wording for both tools. */
function appReadStep(name: string, seconds: number): PlanStep {
  return {
    method: 'app.query',
    params: appReadParams(name),
    description:
      `Read the application "${name}" again WHEN THE WATCH ENDS — UP TO ${seconds} SECONDS AFTER THE CALL IS ` +
      'MADE, AND NOT WHEN THE OPERATION FINISHES — to report the version and state reached by then. A ' +
      '`DEPLOYING` state there is an application still coming up, not a failed call. Changes nothing.',
  };
}

/** What the plan says about the watch, in the one wording both tools use. */
function appWatchSentence(seconds: number): string {
  return (
    "This starts a background job; the job is then followed through the client's own tracking, which reads " +
    `\`core.get_jobs\` and changes nothing, for at most ${seconds} seconds. The operation continues after that ` +
    'whether or not it has finished.'
  );
}

/**
 * The job states these two tools read as a run that worked. This family's own
 * (#86, #161), passed to `watchJob` rather than shared.
 */
const APP_JOB_SUCCESS_STATES = new Set(['SUCCESS', 'FINISHED']);

/** How long `app_upgrade` watches its job: a ceiling on its patience, not an estimate (#122). */
const APP_UPGRADE_WATCH_MS = 30_000;
const APP_UPGRADE_WATCH_SECONDS = APP_UPGRADE_WATCH_MS / 1000;

/** How long `app_rollback` watches its job. Its own number, equal though they are (#154). */
const APP_ROLLBACK_WATCH_MS = 30_000;
const APP_ROLLBACK_WATCH_SECONDS = APP_ROLLBACK_WATCH_MS / 1000;

/** The job's answer, through the allowlist, read only where the job ended (#195). */
interface AppJobAnswer {
  answered: AppReading | null;
}

function appJobAnswer(record: Record<string, unknown> | null, ended: boolean): AppJobAnswer {
  if (!ended) return { answered: null };
  const entry = recordOrNull(record?.['result']);
  return { answered: entry === null ? null : appReading(entry) };
}

/**
 * The listing read after the watch, with its failure caught: the call has
 * already been made, and a failed read must not report it as a failed call
 * (#161).
 */
async function resultingApp(ctx: ToolContext, name: string): Promise<Record<string, unknown>> {
  let reading: AppReading | null = null;
  let error: string | null = null;
  try {
    reading = await readApp(ctx, name);
  } catch (reason) {
    error = errorText(reason);
  }
  const held = reading ?? UNREAD_APP;
  return {
    resulting_lookup: error !== null ? 'UNREADABLE' : reading === null ? 'NOT_FOUND' : 'FOUND',
    resulting_read_error: error,
    resulting_version: held.version,
    resulting_human_version: held.human_version,
    resulting_state: held.state,
    resulting_upgrade_available: held.upgrade_available,
  };
}

/** The half of both results' guidance that is about the job and the read after it. */
const APP_JOB_GUIDANCE =
  '`ended` is whether the job was ESTABLISHED to have reached a state it will not move out of. FALSE MEANS ' +
  'NOTHING WAS ESTABLISHED: the job may still be running, the watch may have been cut short by a dropped ' +
  'connection, or no job was seen at all — `job_state` and `job_id` narrow that and do not partition it, and ' +
  'in none of them has anything failed. `succeeded` is true where the job ended in `SUCCESS` or `FINISHED`, ' +
  'false where it ended in any other state, and null wherever `ended` is false. `error` is the text the job ' +
  'recorded, null where it recorded none. `finished_at` is when the job ended, as an ISO 8601 UTC timestamp, ' +
  "and null wherever `ended` is false. `job_id` is the job's numeric identity, taken from the job event that " +
  'named this request; it is null where no such event was seen, which does not mean nothing started. ' +
  '`watched_seconds` is the ceiling that applied, not how long the watch lasted. `answered` is the ' +
  "application as the job's own answer describes it — `name`, `version`, `human_version`, `state` and " +
  '`upgrade_available` and nothing else — read only where `ended` is true and null everywhere else, and also ' +
  'null where the job ended without answering with an application. THE APPLICATION\'S `config` IS NEVER IN ' +
  'THIS RESULT, in any form. `resulting_version`, `resulting_human_version`, `resulting_state` and ' +
  '`resulting_upgrade_available` are a fresh read of `app.query` made WHEN THE WATCH ENDS, NOT WHEN THE ' +
  'OPERATION DOES, so a `DEPLOYING` state there is an application still coming up and not a failed call. ' +
  '`resulting_lookup` says what that read did: `FOUND`, `NOT_FOUND`, or `UNREADABLE` with ' +
  '`resulting_read_error` naming why, and the four fields are null under the last two. A `FOUND` beside a null ' +
  'field is the system having reported no value for it. `answered` and the `resulting_*` fields are two ' +
  'readings at two moments and may disagree; neither is the other corrected.';

/** `app_upgrade`'s arguments. */
interface AppUpgradeArgs {
  name: string;
  version: string | null;
  snapshotHostpaths: boolean;
}

function parseAppUpgradeArgs(args: Record<string, unknown>): AppUpgradeArgs {
  refuseArgs(
    args,
    ['values'],
    "an application's values routinely carry passwords and tokens, which this catalog does not take as " +
      'arguments; the upgrade keeps the values the application already has',
  );
  const name = parseAppName(args);
  const version = args['app_version'];
  if (version != null && (typeof version !== 'string' || version === '')) {
    throw new Error('"app_version" must be a catalog version, such as one `apps_update_summary` names');
  }
  const snapshot = args['snapshot_hostpaths'];
  if (snapshot != null && typeof snapshot !== 'boolean') {
    throw new Error('"snapshot_hostpaths" must be a boolean');
  }
  return { name, version: version ?? null, snapshotHostpaths: snapshot !== false };
}

/** The upgrade's params, in one place so the plan names exactly the call `execute` makes. */
function appUpgradeParams(args: AppUpgradeArgs): JobParams<ApiSurface, 'app.upgrade'> {
  return args.version === null
    ? [args.name, { snapshot_hostpaths: args.snapshotHostpaths }]
    : [args.name, { app_version: args.version, snapshot_hostpaths: args.snapshotHostpaths }];
}

/**
 * What the plan says the upgrade moves to, read off `app.upgrade_summary`.
 *
 * A supporting read (#154): a failure is stated, not refused, since the
 * middleware decides the target and the summary only describes it. No
 * changelog is quoted, for `apps_update_summary`'s reason (#101).
 */
async function upgradeTargetSentence(ctx: ToolContext, args: AppUpgradeArgs): Promise<string> {
  const asked = args.version === null ? 'the version the system treats as latest' : `version ${args.version}`;
  try {
    const answer: unknown = await firstValueFrom(
      args.version === null
        ? ctx.system.client.api.call('app.upgrade_summary', [args.name])
        : ctx.system.client.api.call('app.upgrade_summary', [args.name, { app_version: args.version }]),
    );
    const summary = recordOrNull(answer);
    const target = textOrNull(summary?.['upgrade_version']);
    if (target === null) {
      return `It moves to ${asked}; the upgrade summary named no target version this tool could read.`;
    }
    return (
      `It moves to ${versionPhrase(target, textOrNull(summary?.['upgrade_human_version']))}, as the system's ` +
      'upgrade summary names it. `apps_update_summary` reports the same summary; no changelog is quoted here.'
    );
  } catch (reason) {
    return (
      `It moves to ${asked}; the upgrade summary could not be read (${errorText(reason)}), so the target ` +
      'version is not established here, and the call may be rejected.'
    );
  }
}

/** Whether host paths are snapshotted, in the plan's words. */
function hostpathSentence(snapshot: boolean): string {
  return snapshot
    ? "A snapshot of the application's host-path volumes is taken before upgrading (`snapshot_hostpaths` is " +
        'true); exactly which paths it covers is (unconfirmed) here, and no tool in this catalog restores it.'
    : 'NO SNAPSHOT OF HOST-PATH VOLUMES IS TAKEN (`snapshot_hostpaths` is false), so data a migration changes ' +
        'there has no copy made by this call.';
}

const APP_UPGRADE_GUIDANCE =
  '`app_name` is the application named, and `requested_version` and `requested_snapshot_hostpaths` are what ' +
  'was sent — a null `requested_version` is the version the system treats as latest. ' +
  APP_JOB_GUIDANCE;

export const appUpgrade: MutatingTool = {
  name: 'app_upgrade',
  description:
    'Upgrades one installed application on a TrueNAS system to a named catalog version, or to the one the ' +
    'system treats as latest. Two-phase: called without a confirmation_token it returns a plan for user ' +
    'approval; called with one it starts the upgrade. `app_name` is the `name` `apps_list` reports; AN ' +
    'APPLICATION THE SYSTEM DOES NOT LIST FAILS THE PLAN, naming it, and so does an app engine reported as ' +
    'not running, naming `app_engine_status`. `app_version` is optional; `apps_update_summary` names the ' +
    'version an upgrade would move to. `snapshot_hostpaths` defaults to TRUE: a snapshot of the ' +
    "application's host-path volumes is taken first, though exactly which paths it covers is (unconfirmed). " +
    'The plan states the current version, the target version as the system\'s upgrade summary names it, and ' +
    "whether host paths will be snapshotted. NO `values` ARE TAKEN — the application's install-time values " +
    'routinely hold secrets — so the upgrade keeps the values it has. `destructiveness` is `reversible`: ' +
    '`app_rollback` moves the application back to a version it previously ran. ' +
    DATA_CAVEAT +
    ' THE RESULT IS ABOUT THE JOB THIS CALL STARTED: the tool watches it for at most `watched_seconds` and ' +
    'then returns what it has, leaving the upgrade going. ' +
    APP_UPGRADE_GUIDANCE,
  resultGuidance: APP_UPGRADE_GUIDANCE,
  inputSchema: {
    type: 'object',
    properties: {
      app_name: { type: 'string', description: "The application's `name` as `apps_list` reports it." },
      app_version: {
        type: 'string',
        description: 'The catalog version to move to. Omitted, the system chooses its latest.',
      },
      snapshot_hostpaths: {
        type: 'boolean',
        default: true,
        description: "Snapshot the application's host-path volumes before upgrading. Default true.",
      },
    },
    required: ['app_name'],
  },
  requiredRole: Role.Full,
  mutating: true,
  // The version can be moved back, and `app_rollback` is in this catalog. What
  // a migration did to the data cannot, and the description says so (#122, #153).
  destructiveness: 'reversible',
  normalizeArgs(rawArgs) {
    const args = parseAppUpgradeArgs(rawArgs);
    return { app_name: args.name, app_version: args.version, snapshot_hostpaths: args.snapshotHostpaths };
  },
  async plan(ctx, rawArgs): Promise<PlanStep[]> {
    const args = parseAppUpgradeArgs(rawArgs);
    const { app, engine } = await planPreconditions(ctx, args.name);
    const waiting =
      args.version === null && app.upgrade_available === false
        ? ' THE SYSTEM REPORTS NO UPGRADE WAITING for it; whether the middleware rejects this call or does ' +
          'nothing is (unconfirmed) here.'
        : '';
    return [
      {
        method: 'app.upgrade',
        params: appUpgradeParams(args),
        description:
          `Upgrade the application "${args.name}", now at ${versionPhrase(app.version, app.human_version)}. ` +
          `${await upgradeTargetSentence(ctx, args)}${waiting} ${hostpathSentence(args.snapshotHostpaths)} ` +
          `${engine} ${DATA_CAVEAT} ${appWatchSentence(APP_UPGRADE_WATCH_SECONDS)} What was read for this ` +
          'plan is not read again before the call.',
      },
      appReadStep(args.name, APP_UPGRADE_WATCH_SECONDS),
    ];
  },
  async execute(ctx, rawArgs) {
    const args = parseAppUpgradeArgs(rawArgs);
    const api = ctx.system.client.api;
    const job: WatchedJob & AppJobAnswer = await watchJob(
      api,
      api.callAndGetJobId('app.upgrade', appUpgradeParams(args)),
      { watchMs: APP_UPGRADE_WATCH_MS, successStates: APP_JOB_SUCCESS_STATES, extra: appJobAnswer },
    );
    return {
      app_name: args.name,
      requested_version: args.version,
      requested_snapshot_hostpaths: args.snapshotHostpaths,
      watched_seconds: APP_UPGRADE_WATCH_SECONDS,
      ...job,
      ...(await resultingApp(ctx, args.name)),
    };
  },
};

/** `app_rollback`'s arguments. */
interface AppRollbackArgs {
  name: string;
  version: string;
}

function parseAppRollbackArgs(args: Record<string, unknown>): AppRollbackArgs {
  refuseArgs(
    args,
    ['rollback_snapshot'],
    "restoring the application's ix-volume snapshot discards data written since the upgrade, which this " +
      'catalog does not author; this tool always sends rollback_snapshot false',
  );
  const name = parseAppName(args);
  const version = args['app_version'];
  if (typeof version !== 'string' || version === '') {
    throw new Error('"app_version" is required and must be one of the versions `app.rollback_versions` lists');
  }
  return { name, version };
}

/** The rollback's params. `rollback_snapshot` is SENT as false, never left out. */
function appRollbackParams(args: AppRollbackArgs): JobParams<ApiSurface, 'app.rollback'> {
  return [args.name, { app_version: args.version, rollback_snapshot: false }];
}

const APP_ROLLBACK_GUIDANCE =
  '`app_name` is the application named and `requested_version` the version it was asked to move back to. ' +
  APP_JOB_GUIDANCE;

export const appRollback: MutatingTool = {
  name: 'app_rollback',
  description:
    'Moves one installed application on a TrueNAS system back to a catalog version it previously ran. ' +
    'Two-phase: called without a confirmation_token it returns a plan for user approval; called with one it ' +
    'starts the rollback. `app_name` is the `name` `apps_list` reports and `app_version` is required; AN ' +
    'APPLICATION THE SYSTEM DOES NOT LIST FAILS THE PLAN, naming it, as does an app engine reported as not ' +
    'running, naming `app_engine_status`, and A VERSION THE SYSTEM DOES NOT LIST AMONG THE ONES IT CAN ROLL ' +
    'BACK TO FAILS IT TOO, naming the ones it does — as does a list that could not be read. ' +
    DATA_CAVEAT +
    ' This tool always sends `rollback_snapshot: false` and takes no argument to change that, so the ' +
    "application's data is left as the newer version left it. `destructiveness` is `reversible`: `app_upgrade` " +
    'moves the version forward again. THE RESULT IS ABOUT THE JOB THIS CALL STARTED: the tool watches it for ' +
    'at most `watched_seconds` and then returns what it has, leaving the rollback going. ' +
    APP_ROLLBACK_GUIDANCE,
  resultGuidance: APP_ROLLBACK_GUIDANCE,
  inputSchema: {
    type: 'object',
    properties: {
      app_name: { type: 'string', description: "The application's `name` as `apps_list` reports it." },
      app_version: {
        type: 'string',
        description: 'The catalog version to move back to; the plan fails on one the system cannot roll back to.',
      },
    },
    required: ['app_name', 'app_version'],
  },
  requiredRole: Role.Full,
  mutating: true,
  // The version can be moved forward again with `app_upgrade`. The data is the
  // newer version's and is not rolled back, which the description says (#153).
  destructiveness: 'reversible',
  normalizeArgs(rawArgs) {
    const args = parseAppRollbackArgs(rawArgs);
    return { app_name: args.name, app_version: args.version };
  },
  async plan(ctx, rawArgs): Promise<PlanStep[]> {
    const args = parseAppRollbackArgs(rawArgs);
    const { app, engine } = await planPreconditions(ctx, args.name);
    let versions: string[] | null;
    try {
      versions = strictTextList(
        await firstValueFrom(ctx.system.client.api.call('app.rollback_versions', [args.name])),
      );
    } catch (reason) {
      throw new Error(
        `The versions "${args.name}" can roll back to could not be read (app.rollback_versions failed: ` +
          `${errorText(reason)}), so nothing is planned`,
      );
    }
    // Unreadable refuses as well as failed, so a version never reaches approval
    // unchecked (#190).
    if (versions === null) {
      throw new Error(
        `The system did not answer with a list of versions "${args.name}" can roll back to, so nothing is planned`,
      );
    }
    if (!versions.includes(args.version)) {
      throw new Error(
        `"${args.name}" cannot roll back to version ${args.version}; the system lists ` +
          (versions.length === 0 ? 'no version it can roll back to' : versions.join(', ')),
      );
    }
    return [
      {
        method: 'app.rollback',
        params: appRollbackParams(args),
        description:
          `Roll the application "${args.name}" back from ${versionPhrase(app.version, app.human_version)} to ` +
          `version ${args.version}, which the system lists among the versions it can roll back to. ` +
          "`rollback_snapshot` is sent as false: the application's ix-volume snapshot is NOT restored, so its " +
          `data stays as the newer version left it. ${engine} ${DATA_CAVEAT} ` +
          `${appWatchSentence(APP_ROLLBACK_WATCH_SECONDS)} What was read for this plan is not read again before ` +
          'the call.',
      },
      appReadStep(args.name, APP_ROLLBACK_WATCH_SECONDS),
    ];
  },
  async execute(ctx, rawArgs) {
    const args = parseAppRollbackArgs(rawArgs);
    const api = ctx.system.client.api;
    const job: WatchedJob & AppJobAnswer = await watchJob(
      api,
      api.callAndGetJobId('app.rollback', appRollbackParams(args)),
      { watchMs: APP_ROLLBACK_WATCH_MS, successStates: APP_JOB_SUCCESS_STATES, extra: appJobAnswer },
    );
    return {
      app_name: args.name,
      requested_version: args.version,
      watched_seconds: APP_ROLLBACK_WATCH_SECONDS,
      ...job,
      ...(await resultingApp(ctx, args.name)),
    };
  },
};
