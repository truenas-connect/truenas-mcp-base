# @truenas/mcp-base

Shared core library for TrueNAS MCP: the tool catalog, system registry, safety
model and multi-system fan-out. A plain TypeScript library with **no
environment assumptions** — no filesystem, no process, no DOM, no network API
called directly. Everything environment-specific enters through an injected
interface in `src/interfaces.ts`. It must run in Node and in a browser.

`README.md` is the user-facing description of the same thing; this file is what
a change to the repository needs to know.

## Commands

```bash
yarn typecheck        # tsc --noEmit, over src and the specs
yarn lint             # eslint
yarn test             # vitest
yarn test:coverage    # vitest with the coverage floors CI gates on
yarn build            # tsup, to dist/ (ESM + CJS + .d.ts)
```

CI (`.github/workflows/ci.yml`) runs typecheck, lint, `test:coverage` and build
on Node 22 and 24. The coverage floors live in `vitest.config.ts`: global
branches 96 / statements 97, plus per-file floors on the files where an
invariant lives. They are raised in the PR that raises the coverage and never
lowered.

## Layout

```
src/interfaces.ts     the injected interfaces — the whole environment boundary
src/catalog/          Tool, SystemHandle, ToolContext; the catalog and its policy
src/registry/         SystemRegistry, connectSystems, the client factory
src/execution/        the executor, fan-out, and plan/confirm
src/content/          bounded file content (see the decision below)
src/tools/            one file per family; all registered by createDefaultCatalog()
src/tools/common.ts   the guards every family shares; not a family, not exported
src/testing/          fixtures the specs import; not the library, not covered
src/index.ts          the public barrel — an export here is a contract
```

A spec sits beside the module it covers and is named for it — `src/tools/pools.spec.ts`
covers `src/tools/pools.ts`. See the decision below for where a tool's tests go.

## Decisions

### Reading bounded file content: `core.download`, not the event source (#72)

**The route taken.** `SystemHandle.files` is an optional `FileContentReader`
(`src/interfaces.ts`), and `createDownloadContentReader`
(`src/content/file-content.ts`) implements it over `core.download`: the system
mints a one-shot download URL for `filesystem.get`, and an injected
`ContentFetcher` GETs it. A tool asks for a path and a line count and receives
lines.

**Why not the event source.** `filesystem.file_tail_follow` takes
`{ path, tail_lines }` — exactly the bounded tail wanted, with the server doing
the bounding — and would have been the cheaper route here. It is unreachable:
the client maps every event carrying `subscriptionParams` to `never`, on the
stated grounds that subscribe-time argument encoding is not documented and it
will not guess. Unblocking it is an upstream `@truenas/api-client` change plus
a version bump, **not completable in this repository**, so it was not taken.
Revisit it if a client release widens `EventName` — the server-side bound is
better than the one below, and this seam's shape would survive being
reimplemented on top of it.

Three consequences of the route that are properties of the design rather than
of the implementation, and are why the code reads the way it does:

- **The bound is enforced here, not requested.** `filesystem.get` takes a path
  and nothing else — no offset, no line count — so the server always offers the
  whole file. `readWindow` discards the front of the body, keeps at most
  `maxBytes`, and stops reading there. A server that ignores what was expected
  of it can make the result `truncated`; it cannot make it bigger.
- **The whole file crosses the network up to the window.** The front of the
  file is discarded rather than never sent, because there is no way to ask for
  a range. That is the price of this route and it is why `maxBytes` is the
  seam's own ceiling rather than a caller's argument.
- **The minted URL never leaves `src/content/file-content.ts`.** It carries a
  single-use auth token in its query string, and tool arguments and results are
  recorded verbatim in the audit trail (S3.3). Nothing thrown from that file
  quotes it — only the path the caller already supplied. A change there that
  puts a URL into a message or a result breaks the credential boundary, not
  just a test.

**The adapter wires it up, or nothing does.** The core will not reach for the
global `fetch`: TrueNAS appliances routinely present self-signed certificates,
so TLS trust is the adapter's policy to hold. `connectSystems` takes an
optional `ContentReaderFactory`; without one every `SystemHandle.files` is
`undefined` and a tool that needs content must say so rather than assume. The
factory is handed the system's name and hostnames and not its `SystemSpec` —
the content seam has no business holding the API key.

The `baseUrl` a factory builds must name the host the client actually
connected to, which `client.connection.hostname$` reports; the configured
`hostnames` list does not say which of them won a failover, and a download
fetched from a host that did not mint the token fails.

### A composite tool calls handlers, not the API (#44)

`system_health_report` is the first tool that answers from other tools rather
than from the middleware: it calls `poolStatus.handler`, `alertsList.handler`,
`poolTopology.handler` and `updateStatus.handler` and adds no endpoint of its
own. That is what keeps it from being a second, drifting opinion about what a
pool's health *is* — there is one normalization per subject and composites read
through it.

Three things follow, and they are the shape any later composite should take:

- **Every read is caught and its section says why it is empty.** A report that
  throws because one subsystem is unreachable is useless exactly when it is
  needed, so each section carries `unavailable`, and null in a section that
  could not be read means "not read" rather than "nothing to report".
- **Counts and findings are computed over everything; only the detail lists are
  capped.** A cap can drop the line describing a finding; it must never drop the
  finding. That is what makes a fixed-size response safe to act on.
- **A verdict has a fourth value.** `OK` is the narrow claim that every section
  was read and none raised anything; anything not established is `UNKNOWN`, not
  `OK`. This is the null/empty/unreadable convention below, applied one level up
  to a summary.

A composed handler is typed `Promise<unknown>`, so a composite re-reads every
field through its own guard and names it explicitly — which is also what keeps a
field one of those tools grows later out of the composite's result.

### A composite states a verdict only about something it defines (#47)

`fleet_compliance_report` is the second composite and it deliberately has **no
`verdict` field**, where `system_health_report` leads with one. The difference is
not style. "Healthy" is a claim this repository defines — the thresholds, the
device states and the alert bands are all in `reporting.ts` and are all
checkable, so a verdict follows from the sections. "Compliant" is a claim against
a standard that lives outside this repository, in a framework or a policy or a
customer's contract, and no tool here has been told which. So the compliance
report states facts and names what it could not read, and any pass/fail reading
of it is the reader's.

**Ask which of the two a new composite is before designing its response.** A
report over a subject the code defines gets a verdict, `UNKNOWN` and all; a
report over a subject someone else defines gets facts and an `unreadable` list,
and adding a verdict to the second is asserting a standard nobody supplied.

The other half of the same rule is where a fact's real source is a setting the
composite may not read. `fleet_compliance_report` is asked for "whether auditing
is enabled"; the setting is `audit.config`, and a composite adds no endpoint. So
it reports what reading the trail can actually establish, under
`auditing.recording`, named for the evidence rather than for the setting, true
only where entries were seen and null everywhere else. **Name the field after
what was measured, not after the question it was asked** — a `recording` that is
null is honest, an `enabled` that is null reads as "off".

`audit_config` reports that setting directly since #83, and the composite still
does not read it: the caller is pointed at the tool rather than having its answer
folded into `recording`, which would make one field mean two things. **A later
tool answering the question a field was named around does not license renaming
the field** — `recording` is still what this report measured.

The same rule reaches the new tool, one level down. `audit.config`'s
`enabled_services` names every service the middleware CAN audit whether or not
any is switched on — the client declares all three members required — so
`audit_config` reports it as `services`, and the one positive claim in that
section is a non-empty `scope`. **A field named for the API field it came from
inherits that field's promise**, which here is a promise the payload does not
keep.

### A fleet-wide tool is still written single-system (#46)

`fleet_health_rollup` answers "which of my systems needs attention" across the
whole registry, and its handler takes one `SystemHandle` like every other. The
fleet dimension is the executor's fan-out: it runs a handler once per target,
labels each result with the system it came from, and reports a call it could not
run at all as an `ERROR` entry rather than dropping it. **A tool whose name says
"fleet" is not a reason to reach for the registry or to start its own
concurrency** — that would duplicate `fanOut` and lose the partial-failure
reporting that comes with it.

What such a tool owes instead is a row that is worth collecting: small, fixed in
size regardless of how big the system is, and carrying the system's own name so
rows stay attributable once flattened. Measured on the bundle, over a registry of
eight-pool systems: 573 bytes a row against 4,642 for the full
`system_health_report`, and flat as the system grows.

The second half is what it drops. `fleet_health_rollup` composes
`system_health_report` — a composite over a composite — and keeps the verdict,
the counts behind it and the worst three reasons, discarding every section. It
re-judges nothing: no threshold, band or severity is read a second time, because
a rollup that scored health its own way would be the drifting second opinion
composites exist to prevent. **Summarise by dropping fields, never by
recomputing them**, and point the caller at the composed tool for the detail.

### Name a payload type off the call, never off the entity (#91)

`@truenas/api-client` 4.x declares a concrete interface for payloads 2.x typed
as `Record<string, unknown>` — `network.configuration.config`, `disk.query`,
`interface.query`, `nvmet.subsys.query` and `pool.dataset.query` among them. A
tool that now needs to name one of those payloads has two routes, and only one
of them survives the next regeneration:

- **Derive it from the method**, through the client's own `QueryEntity` and
  `CallResponse` over `ApiSurface` — `QueryEntity<ApiSurface['call'],
  'nvmet.subsys.query'>`, `CallResponse<ApiSurface, 'network.configuration.config'>`.
  This is what `block.ts` and `network.ts` do, and it is the same move
  `snapshots.ts` already made for arguments with `CallParams`.
- **Do not import the generated entity by name.** The generator suffixes a
  colliding interface `$1`/`$2`/`$N`, and the suffix a type carries in one
  release is not the one it carries in the next: `AppEntry$1` became
  `AppEntry$2` across this bump, and `ReplicationEntry.transport`'s enum was
  renamed `Transport` → `ReplicationCountEligibleManualSnapshotsTransport` with
  identical members. Importing either name would have broken on a rename that
  changed nothing.

**A declared type is a claim about what the middleware sends, not the value
received, so it does not retire a guard.** Every field named through one of
these aliases is still read through `common.ts` — the bump did not delete a
single `textOrNull`. Where a type says a field is required and the code falls
back anyway, the fallback is the load-bearing half: `network.ts`'s
`hostname_local` is declared `string` and is an extend rather than a stored
field, so a release that does not add it still answers.

### The shared guards live in `src/tools/common.ts` (#86)

Every tool file reads middleware payloads whose declared shape it does not take
as given, so each needed the same narrowings — `textOrNull`, `numberOrNull`,
`booleanOrNull`, `recordOrNull`, `textList`, `strictTextList` — and the same
reading of a rejection, `errorText`. The pinned client left many of those payloads as
`unknown` outright; 4.x declares nearly all of them, which changed what the
compiler knows and not what a system sends (#91).
Each file grew a private copy, on the stated ground that a tool file is read on
its own. Eleven copies of `textOrNull` later, they had not all stayed identical:
`shares.ts`'s `errorText` had lost the branch that reads the `{ reason }` and
`{ message }` carriers the client documents, so a real middleware rejection
there reported as having said nothing while every sibling reported its reason.
**That is the cost this file was cut to stop — a fix applied to one copy is not
a fix applied to the rest, and nothing makes the divergence visible.**

Where the line falls, since "shared" is not the same as "generic":

- **What belongs there says the same thing for every family** — a type
  narrowing, the wording of a stated absence, the `Date` bound.
- **What does not is anything whose meaning is a family's own**: a limit's
  default, a state vocabulary, a field name. `effectiveLimit` is shared and
  takes its two bounds as arguments precisely because the bounding is common
  and the numbers are not.
- **A per-family `Attempt`/`attempt` pair is NOT this.** Four files hold one and
  they look alike, but each is typed by its own failure shape and names its own
  sources — the overlap is the shape, not the function. Sharing it would mean
  generalising over the failure type, which buys nothing and couples five
  families to one signature.
- **`common.ts` is internal.** It is not a family, `createDefaultCatalog()` does
  not know about it, and it must not reach `src/index.ts` — an export there is
  a contract, and none of this is one.

**The two list guards are a pair, and picking between them is the #93 decision
rather than taste.** `textList` DROPS an entry it cannot read; `strictTextList`
nulls the WHOLE list instead. Reach for the second wherever a shorter list would
make a claim — a password ruleset one class shorter says the policy requires
less, an audit scope one name shorter says a share is unaudited, a TLS protocol
list one entry shorter hides the old version the field is read for — and for the
first only where a shorter list understates a fact the tool itself asserts.
`strictTextList` was promoted in #102, after `audit_config` and `security_config`
had each grown their own identical copy of it and a third tool was about to.

Reaching for a private copy of something already in `common.ts` is the thing to
notice in review. The comment that used to justify each copy — *a tool file is
read on its own* — is what produced the drift, and is no longer the rule.

### A tool's tests live in the spec named for its module (#87)

`src/tools/tools.spec.ts` held every tool's tests and had grown to 11,834 lines —
87% of the repository's test code, and growing by a block per tool with no
stopping size. It is now one spec per tool module, named for it, sitting beside
the source: `pools.spec.ts` covers `pools.ts`, `shares.spec.ts` covers
`shares.ts`. **A new tool's tests go in its module's spec**, which is also the
file a reviewer of that tool will open.

Two things that rule does not decide on its own:

- **A module whose spec would exceed 1,500 lines splits by tool, not by
  bin-packing.** `reporting.ts` is the only one: its five blocks come to 2,405
  lines, so each takes a spec named for the tool — `reporting-utilisation.spec.ts`,
  `system-health-report.spec.ts`, and so on. Every filename then still says
  exactly what is in it, which a `reporting-2.spec.ts` would not.

  **1,500 is the trigger, and it is checked rather than felt.** #97 added a
  fourth tool to `tasks.ts` and started by giving it its own spec, which read as
  following this bullet and was not: `tasks.spec.ts` was 816 lines and the new
  block 495, so the merged file is about 1,311 and the exception was never met.
  The tests went back into `tasks.spec.ts`. A spec that is merely long is not a
  spec that has to split, and the default above — a new tool's tests go in its
  module's spec — is what governs until the number says otherwise.

  **The number said otherwise at #121.** `tasks.spec.ts` was 1,352 lines and
  that tool's block is around 460, so the merged file would be about 1,810 and
  the exception is met where #97's was not. The block took
  `scheduled-task-set-enabled.spec.ts`; the four listing tools stayed in
  `tasks.spec.ts`, because the split is by tool and re-homing tests a ticket did
  not touch is a separate change. So a module can be part-split, and that is not
  a half-finished state to tidy — the next tool over the line takes its own spec
  the same way.

  **The trigger can also be met by GROWING tools rather than by adding one, and
  then there is no new tool whose block is the one to move.** #138 grew two of `block.ts`'s three
  tools past the three-line margin `block.spec.ts` had recorded for itself, so
  `iscsi_list` — one of the two blocks it had open — took `iscsi-list.spec.ts`
  and the other two stayed. What decides which block moves is that it is one the
  ticket already has open and that moving it brings the file back under 1,500:
  moving a block the ticket did not touch is the re-homing #121 rules out, and
  moving every block is a rewrite where a move was owed. **Move a block the
  ticket touched, and stop as soon as the file is under the number** — which
  block, where more than one qualifies and either would do it, is not a decision
  this rule makes. It is not the largest: the block moved here is the smaller of
  the two, and the file is under the trigger either way.
- **The catalog-wide test is not any tool's.** The exact-list assertion over
  `createDefaultCatalog()` is about `src/tools/index.ts`, so it lives in
  `index.spec.ts` under the same rule as everything else. Registering a tool
  means editing `src/tools/index.ts` and that spec, the module's own source and
  its spec, and `src/index.ts` — which this bullet used to leave out, and a tool
  duly shipped registered and unexported. See #151 for what pins it now.

**`src/testing/` is test support, and is neither the library nor code under
test.** `fakeSystem` and `failingSystem` were declared once at the top of the
old file and used throughout it; they are now `src/testing/fake-systems.ts`, and
the directory is excluded from `tsconfig.json` (the library project must not
compile a file importing `vitest`) and from the coverage report. Counting it
would report 100% for fixtures and move the global percentages without a line of
the library being tested any better — the same reason `src/index.ts` is already
excluded there.

### An unreadable list entry is nulled or kept by which way it moves the summary (#93)

`audit_config`'s scope nulls its WHOLE list when one entry cannot be read — it
reads through `strictTextList`, which is what that guard is for;
`system_reboot_info`'s `rebootReasons` KEEPS such an entry, as a pair of nulls.
Both are the null/empty/unreadable convention below, and they disagree because
the convention alone does not decide this — what decides it is the direction the
shorter list moves the answer.

Ask what an entry silently disappearing would make the result say. A scope one
name shorter says the system does not audit that share, which is more than the
read established, so the list is nulled to refuse the claim. A reason list one
entry shorter runs towards EMPTY, and empty is `system_reboot_info`'s one
positive finding — "nothing is pending" — so the entry stays and still counts
towards `reboot_required`. **Drop towards a claim and you must null; drop towards
a fact the tool asserts and you must keep.** Neither answer is the safe default,
and a tool that copies whichever sibling it read first will land on the wrong one
about half the time.

### The boot pool is a separate read, and its scan record is unreported (#95)

`pool.query` — which `storage_pool_status`, `storage_pool_topology` and
`storage_scrub_history` all read — **does not list the boot pool**. The device
the system runs from has its own verb, `boot.get_state`, and `boot_pool_status`
(`src/tools/boot.ts`) is the only tool that reads it. A tool answering a question
about "every pool" from `pool.query` is answering about the data pools, and its
description has to say so — `boot_pool_status`'s says it from the other side,
and the three above still read as covering every pool.

`boot.get_state` carries `scan` and `expand` as open records, and this tool
reports **neither**, in any form. The alternative was to reuse `pools.ts`'s
`ScanRecord` reading, and the reason not to is where the line in `common.ts`
falls: the *shape* of a ZFS scan record is common, but everything that reading
does with it — `SCRUB` vs `RESILVER`, `NEVER_SCRUBBED`, `UNKNOWN` — is a
vocabulary decided for data pools and is that family's own. Copying it into a
second family is the drift `common.ts` was cut to stop; moving it there would
move the vocabulary with it. So the boot pool's scrub outcome is a gap, it is
named as one in the tool's description, and closing it means promoting the
reading deliberately rather than as a side effect of this tool.

**Two independent reads are two sections, each with its own `unavailable`.**
`boot.get_state` and `boot.environment.query` fail separately, so neither may
fail the tool — the same seam `system_health_report` and `fleet_compliance_report`
use, and the reason `boot.ts` catches rather than throws. A section that could
not be read still carries every field it promises, as nulls: `undefined`
serializes to no key at all, and a caller would otherwise get a shape it was
never told about.

### A unit goes in a field name only where the unit was established (#96)

`security_config` reports `min_password_age`, `max_password_age` and `window`
with no unit in the name, where `audit_config` reports `retention_days` and
`boot_pool_status` reports `size_bytes`. The difference is not style either. A
suffix is carried where the unit was established, and there are two ways it can
have been: the payload's own field name states it — the boot *environment*
`size_bytes`, which reads `held['used_bytes']` (`src/tools/boot.ts:146`) — or the
domain fixes it, as it does for the boot *pool*'s `size_bytes`,
`allocated_bytes` and `free_bytes`, which read the bare `size`, `allocated` and
`free` of a ZFS pool (`src/tools/boot.ts:114-116`) and could not be counted in
anything but bytes. The three fields above have neither: they are bare numbers on
the pinned surface, which declares no unit for any of them, and nothing about a
password age or a one-time-password window fixes one — days and seconds are both
ordinary answers for the first, seconds and steps for the second. Suffixing them
would have been this repository asserting a unit it never read — the same defect
as a description promising more than the normalization delivers, one level down
in the name.

**A suffix is a claim, and a caller acts on it.** A `_days` on a number the
system meant as seconds is worse than no suffix at all: an unsuffixed number is
read as itself and asked about, and a wrongly suffixed one is converted. So
carry the unit when the API states it, and otherwise keep the middleware's own
name and say in the description that no unit is reported and the number is not
to be converted.

`retention_days` predates this and is not being renamed here — it is on a
public barrel export and out of this ticket's scope. Treat it as the shape to
check rather than the shape to copy.

### One tool with four sections, where the defect was the missing category (#97)

`automated_tasks_list` reads `cronjob.query`, `rsynctask.query`,
`cloud_backup.query` and `initshutdownscript.query` and returns **one result with
four sections**, where every sibling in the tasks family is one tool per task
type. The open question the ticket left was one tool or four, and what decides it
is the defect rather than the response size.

What was wrong before was not that four listings were missing. It was that "what
runs on this system without anyone asking" got a **confident answer with whole
categories silently absent from it** — nothing in a `cloudsync_tasks_list`
response says that cloud *backup* is a different engine that was never looked at.
Four separate tools reproduce that one level down: a caller that reaches three of
them still gets an answer with nothing in it saying what the fourth would have
added. Four sections in one response, each carrying its own `unavailable`, is the
shape where the gap is **in** the answer.

**Ask which of those two a new multi-read tool is.** A tool whose subject is a
list of one kind of thing is one tool per kind, as `snapshot_tasks_list` and
`cloudsync_tasks_list` are. A tool whose subject is *completeness across kinds*
has to return the kinds together, because the missing kind is the finding.

Three things follow, and the first is the one a later tool is most likely to get
wrong:

- **The name may not promise what one section cannot deliver.** It is
  `automated_tasks_list` and not `scheduled_tasks_list` because an init/shutdown
  script is not scheduled — it runs at a point in the system's lifecycle, carries
  no cron fields, and reports no `schedule` key at all rather than a null one. A
  null there would read as a schedule that could not be read. This is
  `storage_scrub_history`'s review finding — a tool *name* promising more than
  the data holds — avoided in advance.
- **The section seam is `boot.ts`'s, and it is now the shape for any tool over
  independent reads.** Each section is `{ unavailable, entries }`; `entries` is
  null whenever `unavailable` is non-null and `[]` where the system listed none,
  and a read answering with something that is not a list is that section being
  unreadable rather than the system holding none of that type. An unreadable
  *entry* inside a readable list is kept as a row of nulls, per the direction rule
  in #93: dropping it would say the system runs one fewer command on its own,
  which is the claim this tool must not make without having established it.
- **Naming the fields one by one is a credential boundary here, not a
  convention.** A `cloud_backup` row carries `password` — the passphrase the
  backup repository is encrypted with, declared a plain `string` — beside a
  credential whose `provider` holds the access key, and an rsync task's
  `ssh_credentials.attributes` holds an SSH **private key**. A row mapped by
  trimming would have put all three in a tool result, and tool results are
  recorded verbatim in the audit trail (S3.3). Both credentials are read by `id`
  and `name` and no further, as a cloud sync task's already is.

The one thing this tool *does* pass through unredacted is a cron job's `command`
and an init/shutdown entry's, which can contain a credential an operator inlined.
That is the operator's own text rather than a secret the repository was asked to
hold, and the catalog's "no secrets as arguments" rule in `catalog/tool.ts`
concerns arguments rather than response data. The description says so instead.
The one place this repository *does* treat response data as credential-shaped is
the minted download URL in #72, which is a string this code produces.

**Everything stays in the tasks family, source and spec alike.** The cron
rendering (`describeSchedule` and the helpers under it) and the last-run reading
(`lastRunState`, `jobFinishedAt`, `jobError`) are this family's own vocabulary,
not `common.ts`'s, and re-deriving a second opinion about what a cron expression
means was the failure mode most worth avoiding — so the tool is written beside
them and calls them in place. The tests are in `tasks.spec.ts` under #87's
default; the merged file is about 1,311 lines, so the split exception there does
not apply and was not taken.

**One field this tool does NOT group is the rsync remote end.** A task carries
`remotehost`, `remoteport`, `remotemodule` and `remotepath` beside a `mode` of
`SSH` or `MODULE`, and the obvious description — "mode says which of these
describe the far end" — is a claim the pinned surface does not make: nothing in
`RsyncTaskEntry` ties a field to a mode, and an SSH task's hostname and port can
instead live inside the `SSHCredentials` this tool deliberately does not read.
So each field is described as what the TASK ITSELF records, a null is "the task
records no value", and the description says outright that a null `remote_host`
beside a named credential is not evidence the task has no remote host.
**Grouping fields under a discriminator is the same defect as a description
promising more than the normalization delivers** — check that the payload states
the grouping before writing one.

### An unconfirmed allowlist over an open record names the keys it did not read (#98)

`nfs_clients` reads `nfs.get_nfs4_clients`, whose row is `{ id, info, states }`
with `info` typed `Record<string, unknown>` and `states` a list of them — the
client declares that the records are there and says nothing whatever about what
is in either, which is a shape and not a content. The
allowlist convention still applies and the record must not be forwarded, so the
tool has to name keys; but no live system was available to read the real ones
off, so the names in `INFO_KEYS` are taken from what the Linux NFS server
publishes per client and are a considered guess.

**The guess is made checkable rather than hidden.** Every key the record
actually carried whose value is not reported is named, in
`unreported_info_fields` and `unreported_state_fields`. A key name is not a
value, so nothing a later TrueNAS release adds reaches a caller — but a caller
seeing the named fields all null beside a full list of unreported names is
looking at an allowlist that does not fit this system, not at a client the
server knows nothing about. Those two readings are otherwise identical, and only
one of them is a defect.

**Such a list is built from the keys that produced a value, never from the
allowlist.** There are two ways an unconfirmed allowlist is wrong and only one
of them is a wrong key name: the other is a right key over a value of an
unexpected type, which here is the likelier, since `info` is published per
client as a text file and a middleware that parses it without coercing sends
every value as a string. A list filtered by key name shows the first and hides
the second — it would answer "every key it carried is reported" beside a null
field, which is the reading the list exists to prevent. So a key whose guard
rejected the value lands in the list exactly as an unlooked-for key does, and
the field's description says a null field beside an empty list is the separate
answer "the record carried nothing under that name".

**Reach for this only where the key names themselves are unconfirmed.** A record
whose shape the client declares, or that has been read off a live system, gets a
plain allowlist and no such list — the extra fields are the price of not being
able to check, not a default. Null there means the record was not a record;
empty means it was read and every key it carried is reported.

**Over a LIST of such records that rule moves up a level and stops being the
same rule.** `unreported_state_fields` is null where `states` was not a list at
all, and its empty case covers two answers rather than one: every entry's keys
were reported, and no entry was a record in the first place. It is a union
across entries, so a key can be both reported for one entry and named because
another did not report it. What follows is the part a description is most
likely to overpromise: **an entry that could not be read is counted and leaves
no other trace** — it names no key, adds no type, and neither list has a length
that can be compared against the count to find it, because one holds distinct
kinds and the other key names. Say that outright, or report a count of the
unreadable entries and make a comparison true; offering the caller an
arithmetic that does not work is the same defect as any other description
promising more than the normalization delivers.

### A live-session tool is its own family, not a third tool in `shares.ts` (#98)

`shares.ts` merges SMB and NFS into one list on the stated ground that a person
asking what a NAS shares is not asking a question about protocols. `nfs.ts` asks
the opposite kind of question — who is connected — and there the protocol is the
whole of the answer: NFSv3 is stateless and reports `{ ip, export }` mounts,
NFSv4 registers a client with an id and open state, the two share no vocabulary,
and they come from two middleware calls that fail independently. So they are two
lists in a file of their own, the same way `block.ts` keeps iSCSI and NVMe-oF
apart rather than folding them into one row type.

**A row shape is what decides which file a tool goes in, not the protocol it
names.** A second NFS tool answering a question about exports would belong in
`shares.ts` despite this file existing.

### A discriminated payload gets one allowlist per arm, and an arm for none (#100)

`vm_devices` is the first tool over a payload the middleware discriminates: a
`vm.device.query` row's `attributes` is a union of seven interfaces keyed on
`dtype`, and a NIC shares no field with a disk. It reports `dtype` in the
envelope and the arm's own fields nested under `attributes`, mapped by a
`switch` with one allowlist per arm. **A flattened row unioning every arm's
fields is the shape to refuse** — it is mostly nulls on every device, it cannot
say whether a null is "this kind has no such field" or "unreadable", and it
absorbs a field a later release adds to any one arm.

**Write the `default` arm as a case you expect, not as a defensive branch.** The
pinned client declares an eighth kind, `ISCSI_DISK`, on the device shape the
`vm.device` added and changed events carry, and leaves it out of the one
`vm.device.query` answers with — so a `dtype` an allowlist
does not map is what this surface already does, before any release moves. The
union a method answers with is not the union the same entity has elsewhere in
the client, and deriving the type off the call (#91) is what makes that visible.
`attributes` is null there and `dtype` is still reported, which is what lets a
caller tell an unmapped kind from a device whose configuration could not be read
at all (both null). Both readings have to be in the description: a null
`attributes` is a device that is there and configured, never one configured with
nothing.

The other half is where #97's credential rule lands when the credential is
inside an arm. `VMDisplayDevice.password` is the SPICE/VNC console passphrase —
declared `string | null` beside the display's ordinary settings, with nothing in
the type saying it is a credential, and the DISPLAY allowlist omits it: **not
redacted, and not reported as whether one is set**,
since a tool result is recorded verbatim in the audit trail (S3.3). Naming the
arm's fields one by one is what keeps it out, and what keeps out a second
credential-shaped field a later release adds to any arm.

### Two tools that make a third interpretable are still two tools (#101)

`app_engine_status` and `apps_update_summary` arrived on one ticket, land in one
file, and exist for the same reason — `apps_list` alone is misread without them.
That is the whole case for folding them into one tool with two sections, and it
is not enough.

**The section test is #97's, and it is about the CALLER's answer rather than
about where the tools came from.** `automated_tasks_list` returns four sections
because a caller reaching three of them gets a confident answer with a category
silently missing — the missing kind is the finding. Neither of these completes
the other that way: a caller reading only the engine status is not given a wrong
answer about updates, and a caller reading only the updates is not given a wrong
answer about the engine. Shared motivation, one file and one pull request are
not the test. **Ask whether a caller who reads only one of them is misled by
what the other would have said.**

What settles the remainder is the name, under #97's first bullet. A single tool
over both would have to be named for the engine or for the applications, and
either name promises what only the other half delivers.

**What they owe each other instead is a POINTER, and both descriptions carry
one.** Twelve applications reporting as stopped because the engine is down is
the misreading this family is most likely to produce, and splitting the tools is
only safe because each description names the other. A split that leaves a caller
unable to discover the second tool reintroduces the defect the section seam
exists to prevent.

**A CAP can be worse than an omission, which is #44's rule deciding against
truncation rather than for it.** `apps_update_summary` reports no changelog: it
is unbounded upstream prose returned once per application, and the cap that
would bound it could drop the line naming a breaking change while the field
still presented itself as the answer to what the update alters — a cap dropping
the finding rather than the line describing it. The list of other versions
available to upgrade to goes for the same reason at lower stakes. What that buys
is an entry fixed in size, so the response grows only with the number of
applications that have an update; both omissions are named in the description,
as `boot_pool_status` names the boot pool's scan record.

**A status word this catalog has not read is UNKNOWN, never the negative.**
`app_engine_status`'s `running` is derived through a total `Record` over the
status union, which is exhaustiveness-checked against the surface and answers
null for anything not in it — `false` there is the positive claim that nothing
on the system can run.

**The exhaustiveness check is not a bound on what a system can send, and
reading it as one is the trap.** `ApiSurface` is `DefaultApiDirectory`, the
OLDEST supported directory (#91), so a total `Record` over a union taken from it
is total over the oldest surface only: `docker.status` declares seven status
words there and nine on a later one, and a system on that release can send
`MIGRATING` today with nothing failing to compile. **Every mapping keyed off a
union derived from `ApiSurface` needs the unmapped case to be an honest answer
rather than a branch presumed unreachable** — which is the same reading #100
gives its `default` arm, arrived at from the version skew instead of from a
method's union differing from an event's.

The membership test is `Object.hasOwn` and not `in`, which walks the prototype:
`'constructor'` is `in` every object literal and would have been read back as a
boolean the field cannot hold.

### A declared field whose meaning the surface does not state is left out (#102)

`system_general_config` reads a payload the client declares in full — seventeen
named fields, every one of them typed — and reports fourteen. `ds_auth` is the
one this rule is about: a boolean the pinned surface declares and documents
nowhere, omitted rather than passed through under a name this repository made up
for it. (`wizardshown` is dropped for the simpler reason beside it — it is the
setup wizard's own bookkeeping and answers no question anyone would ask a NAS.
Two omissions, two different reasons, and only the first is a decision.)
**A declared type says what arrives, never what it means**, and the two
are separate questions: #91 settled the first, and a field that survives it can
still fail this one. Reporting a guessed meaning is worse than omitting the
field, because a caller cannot tell a reading from a guess — the same argument
`nfs_clients` makes about unconfirmed KEY NAMES (#98), one level up, about a
confirmed key whose SEMANTICS are unconfirmed.

The corollary is the cheap one to get wrong: **an omission a caller might notice
is named in the description**, as `boot_pool_status` names the boot pool's scan
record. This tool says outright that it does not report the setup wizard state or
the directory-service authentication flag, so a later reader can tell a
deliberate omission from a field nobody saw.

`ui_certificate` is omitted differently and for the other reason: it is an open
record, so it is REDUCED — to `ui_certificate_configured`, the one fact reading
it establishes — rather than forwarded, and `certificates_list` is where the
detail lives. Note that `recordOrNull` alone cannot do that reduction: it answers
null both for the explicit null that means "no certificate" and for a payload
that could not be read, and those are different answers.

**Reducing a field to a fact is also what lets it survive the shape changing,
and that is worth reaching for deliberately.** `ui_certificate` is an embedded
record on `DefaultApiDirectory` and a certificate ID — a bare `number` — on a
later directory in the same client. `certificateConfigured` reads BOTH as
"configured", because at the resolution this tool reports the two payloads say
the same thing; a guard written to the pinned shape alone would have answered
"could not be read" for every system on the newer release, which is the reading
that means the opposite of the truth. #91 says a declared type is a claim about
what arrives rather than the value received — the version skew behind it is
readable in the client, and **where two directories declare one field
differently, a reduction that both shapes satisfy is worth more than a guard
that matches the pinned one exactly.**

### `select` narrows the read; only the allowlist bounds the result (#115)

Every `app.query` call in `src/tools/` now passes a `select` naming the fields
its mapping reads — six for `apps_list`, four for `apps_update_summary`, three
for `reporting_app_vm_usage`. Three different lists on one method, because the
list belongs to the CALL SITE's mapping rather than to the method: a shared one
would ask each path for fields it has no mapping for, which is the cost this is
removing.

**It does not retire the allowlist, and reading it as a replacement is a
credential-boundary regression.** The client's own types state why: middleware
honours `select` on its CURRENT api version, and a client talking to a newer
appliance over an older one gets the version-adaptation step filling in every
non-required field's default — so a projected row comes back PADDED. Measured by
the client's authors on a 27.0.0 appliance: over `/api/v26.0.0`, 25 of 44 query
methods returned unrequested fields; over `/api/v27.0.0`, none did. The client's
`MAX_SUPPORTED_VERSION` lags on purpose. An `app.query` row's `config` holds
install-time values that routinely include an API key or a claim token, and
padding can put it back on the wire. `select` is a bandwidth measure and the
allowlist is the boundary; the second is not optional because the first is
present.

Two things that follow for any later projection:

- **Write the options object INLINE.** The client infers the result type from
  the options *literal* (`const O extends QueryListOptions<…>`), so a `select`
  hoisted to a `const` widens and the rows degrade from `Pick<E, …>` to
  `Partial<E>`. Imprecise rather than unsound — but the precision is what makes
  the compiler catch a mapping reading a field the `select` forgot, which is the
  only thing keeping the two in step. Same reason `reporting_app_vm_usage`
  inlines its `virt.instance.query` filter.
- **A projected field can be ABSENT from the row rather than null on it**, which
  is a shape no unprojected read produces. `undefined` serializes to no key, so
  a mapping that passes it through answers with an object missing fields the
  description promises — see `boot.ts` on why an unread section spells its
  fields out. `apps_list` uses `?? null` and not the `common.ts` guards on
  purpose: the guards would additionally change what a malformed value reports,
  and that is a change to what the tool says rather than to what it reads.

**Confirm `select` against the declared type before relying on it, never against
a passing test.** An unrecognised query parameter is dropped rather than refused,
so a tool that silently received every field looks identical to one that worked.
The confirmation here was `QueryOptions<T>` in the pinned client's
`dist/index.d.ts`, reached through `DefaultApiDirectory`.

### A plan names the read `execute` makes, or the plan is not true (#119)

`alerts_dismiss` and `alerts_restore` are the second and third mutating tools,
and their plans return **two** steps — `alert.list`, then the mutation — where
`snapshots_create` returns one. The difference is not the tool being more
careful. It is where the read happens: `snapshots_create` reads at PLAN time
(`assertDatasetExists`) and deliberately does not re-read at execute time, so its
one step is the whole of what `execute` calls. These two must report whether the
alert had ALREADY been dismissed, which is a fact only readable immediately
before the call — so `execute` reads, and a plan naming only the mutation would
be a plan that omits a call the user is approving.

**A `PlanStep` is a call `execute` will make, not a summary of the change.** Ask
what `execute` calls and name all of it; a read step says outright that it
changes nothing.

**The read is issued unconditionally and nothing branches on it.** The mutating
call is made whatever the read said — including where the read failed, and where
it completed and listed no alert with that uuid. That is what keeps `execute` a
pure function of (args, system), which is the property the confirmation token
depends on: skipping the mutation for an alert the read no longer lists would be
branching on state the token cannot bind. The alternative — failing the call
when the reporting read fails — would throw away an approval the user has
already given for a mutation that is still safe.

**A three-valued account of a read does not enumerate a four-valued outcome, and
the description has to say so.** `lookup` reports what the read did — `FOUND`,
`NOT_FOUND`, `UNREADABLE` — while `previously_dismissed` and `changed` are null
under the last two AND under `FOUND` where the alert stated no `dismissed` this
tool could read as a boolean. Three values, four causes: the descriptions name
the fourth explicitly and say that `lookup` alone does not tell them apart. A
status field named for one half of an outcome will not partition the other half,
and claiming it does is the house's most common review finding wearing a
different hat.

**Already-in-the-target-state is not an error, and saying which it was is the
tool's job.** Most alerts on a running system are already dismissed; the plan
says which of the two it is about to do, and the result reports the state read
immediately before the call. A mutating tool whose no-op is indistinguishable
from its effect gives a caller nothing to act on.

### The identifier a mutating tool takes is the one its method takes (#119)

`alert.dismiss` and `alert.restore` take a `uuid`; the middleware's alert
declares `uuid` and `id` as two separate required fields; and `alerts_list`
reported only `id`, so **there was no way for a caller to name the alert the API
wants**. The fix was to grow `alerts_list` a field, deliberately rather than as a
side effect: it is reported BESIDE `id` and not instead of it, and the
description states what it is for and that it is per-system.

**Growing a read-only tool a field to make a mutating tool reachable is a change
to that tool's contract**, so it is stated in that tool's description and tested
there. What made it safe to do was #44's rule holding in the other direction:
`system_health_report` composes `alertsList.handler` and re-reads every field
through its own guard by name, so a field `alerts_list` grows does not reach the
composite — checked rather than assumed before the field was added.

**Do not key a tool on an identifier that is not per-system.** The ticket's live
reading — the same `id` coming back from two different systems for one
`CertificateExpired`/`freenas_default` condition — is why `id` is refused here: a
tool keyed on it is ambiguous under the fan-out, which is the normal way these
tools run. That reading was **not reproducible from this repository** (no live
system in the test environment). What is confirmed is the surface: two declared
fields, and a method whose parameter is the first of them. The description states
the rule the surface supports — `uuid` is what these tools take, read it from the
system being targeted — rather than an account of why the two differ.

### A physical side effect that could not be established is stated, not settled (#120)

`disks_temperature` reads a disk's current temperature off the device, and
whether that read WAKES A SPUN-DOWN DISK could not be established here: nothing
in the client says, and no live system was available to watch. The tool's
description says exactly that — not "this does not wake disks", which is a
description promising more than the read delivers, and not the reverse either,
which would be the same defect pointing the other way. It names the consequence
(a caller with disks deliberately parked should name the ones it wants) and
leaves the judgement with the caller.

**The unbounded default was kept, deliberately.** No `disks` argument still
means every disk, because the ticket's scope names that default and the risk is
unestablished rather than established — narrowing the default would be acting on
the guess this decision refuses to make. If a live system ever settles it, the
default is the thing to revisit and the description is the thing to correct.

**This is the #102 rule about a field's MEANING, applied to a call's EFFECT.**
Reporting a guessed meaning is worse than omitting the field because a caller
cannot tell a reading from a guess; asserting a guessed side effect is worse
than saying nothing for the same reason, and worse still, because a caller acts
on "safe to call" in a way it never acts on a null.

### One read, two possible value shapes, and neither forwarded (#120)

`disk.temperatures` is declared `Record<string, unknown>` — once, in the oldest
directory, with no later one narrowing it — so the client says a record is there
and nothing about what its values are. The mapping reads BOTH shapes it could
plausibly be: a bare number is the temperature itself, which is what a system
carrying no thresholds is expected to answer with, and a record is read through
an allowlist of key names. **Handling two shapes is not defensive breadth here;
it is the same move `system_general_config`'s `ui_certificate` reduction makes
(#102)** — where a payload can arrive in more than one shape, a reading that both
shapes satisfy is worth more than a guard written to one of them.

**The `_celsius` suffixes are carried on #96's second ground, the domain rather
than the payload.** The API declares no unit for any of these numbers, exactly as
it declares none for `min_password_age`; the difference is that SMART and ATA
define a drive temperature in degrees Celsius and nothing else is an ordinary
answer for one, where days and seconds are both ordinary answers for a password
age. That is the same ground the boot pool's `size_bytes` stands on — a bare ZFS
`size` could not be counted in anything but bytes.

The key names inside the record are unconfirmed and get #98's treatment:
`unreported_fields` names every key an entry actually carried whose value is not
reported, built from the keys that produced a value. The one thing that shape
costs is a third meaning for a null: `unreported_fields` is null both where the
entry was a bare number and where there was no entry at all, so
`temperature_reported` is what separates them and the description says so.

**Three ways a temperature can be missing, and only two of them are separable.**
Not mentioned at all (`temperature_reported` false), mentioned with no readable
value (true, null temperature), and the whole read failing (`disks` null,
`unavailable` set). The SSD that publishes no temperature and the disk that was
asleep both land in the middle case and are NOT distinguishable from this
payload — which the description states outright rather than leaving a caller to
infer a cold disk.

### A tool named for a category may not accept a member of another one (#121)

`scheduled_task_set_enabled` switches one scheduled task on or off across six
kinds — periodic snapshot, cloud sync, replication, cron, rsync and cloud
backup — and it does **not** accept an init/shutdown script. That is the #97
naming rule one level down, and it is worth stating because the API does not
stop it: `InitShutdownScriptUpdate` declares `enabled?: boolean` exactly as the
other six do, checked rather than assumed. An init/shutdown script runs at a
point in the system's lifecycle, carries no cron fields and reports no
`schedule` at all, which is precisely why `automated_tasks_list` is not called
`scheduled_tasks_list`. Accepting one here would put the promise that tool's
name refuses back into a `kind` enum. **The reachable surface is not the scope —
ask what the tool's own name has already promised**, and where the two disagree
the missing kind is a tool whose name fits, not an argument to add.

**One tool over six kinds is not the #97 section decision, and the test is
different.** `automated_tasks_list` returns four sections because a caller
reaching three of them gets a confident answer with a category silently absent:
the missing kind is the finding. Nothing is missing from a mutation. What makes
this one tool is that the six calls are literally the same call — `(id, {
enabled })` in, the updated entity out — so six tools would be six copies of one
`plan`/`execute` pair differing in two strings, which is what `common.ts` was cut
to stop. **Ask whether the kinds differ in what the caller is TOLD (sections) or
only in which method is dialled (one tool with a discriminator).**

**The discriminator is required, and that is a safety property rather than
ergonomics.** Task ids are per-table integers, so id `3` exists under every kind
and names a different task under each; a tool taking an id alone would be
ambiguous in the one direction that matters, disabling the wrong task silently.
Every enum value names the tool its ids come from, in the description and in the
plan's failure — because a caller that reached the failure with the right id and
the wrong kind can check the id and cannot check the kind.

**A mutating tool's outcome is read from what came back, never from what was
asked.** These methods answer with the updated entity, so `resulting_enabled` is
read off the response through the same guard the row was read with, and
`changed` is `previously_enabled !== resulting_enabled` — two readings or null.
A `changed` derived from the request instead would report a call the system
accepted and did not apply as having changed something. `confirmed` is the
separate fact that the response agrees with the request, and **`confirmed: false`
is not a success**: the call did not reject and the task is not in the state that
was asked for. `alerts_dismiss` has no equivalent because `alert.dismiss` answers
nothing — where a method returns the entity, reading it back is owed.

**A filter is bandwidth; the check on the response is the control.** The read
passes `[['id', '=', id]]` and then finds the row by id anyway. An unrecognised
query parameter is dropped rather than refused (the same mechanism #115 states
for `select`), so a filter that did not apply comes back as the whole table and
is indistinguishable from one that matched everything — and the first row of that
is a different task. **Never act on the first row of a filtered read.**

**A cron job's `command` is reported by `automated_tasks_list` and is not
repeated in a plan.** It is the operator's own text and may hold a credential
someone inlined; the description and the user identify the job for approval
without it, and a plan is shown to a person and then recorded. Passing a field
through in a listing whose description warns about it is not the same act as
putting it in a mutating tool's approval text.

### A job-backed tool watches for a bounded time and reports what it has (#122)

`cloudsync_run` is the catalog's first tool that starts a job, and the shape it
takes is the one later job-backed tools should copy.

**The core needed nothing.** `ApiSurface` is `DefaultApiDirectory`, whose shape
is `{ call, job, event }`, so `system.client.api.job(method, params)` was
already available to every handler and already typed off the *job* directory —
a key space disjoint from the call directory, so a job method is unreachable
through `api.call` and vice versa. The client sends the request, correlates the
job id off the job events, tracks the job and completes the observable at a
terminal state. Earlier discussion here treated job support as a core
prerequisite; it was not.

**The duration decision is the one a job-backed tool actually has to make, and
awaiting completion is the wrong default.** A cloud sync is unbounded — minutes
for a delta, hours for a first upload — and awaiting it holds the MCP tool call
open for the whole thing. The host times out, and the call it times out on is
the only one that ever knew the job id, so the run continues with nothing able
to name it afterwards. So: **watch for a bounded time, then report either how
the job ended or that it is still going, with the job id either way.**

Starting the job and returning the id immediately is what that degrades to when
the bound passes, which makes it the floor rather than a third option — and it
is not the wait-free route it looks like, because the id itself arrives from the
first job event carrying the request's id and so waits on the network too. A
bound is owed either way; this spends it on an answer that is sometimes
complete.

**The bound is a ceiling on the tool's patience, not an estimate of the job.**
It has to sit comfortably inside the MCP host's own timeout, since a bound that
outlives the host's never gets to report anything at all — and the host's is not
readable from here, because `src/interfaces.ts` is the whole environment
boundary and carries no deadline. Thirty seconds is chosen to be shorter than
the shortest in ordinary use rather than tuned to any one of them, and it is
returned as `watched_seconds` so a caller never infers which bound applied, the
same way `snapshots_list` returns the `limit` it used.

**Ending the watch must not end the job, and that was established before the
route was taken.** `api.job` is `callAndGetJobId` piped into `trackJob`, and
`trackJob` only observes — it filters the job event stream and reads
`core.get_jobs`. Unsubscribing sends nothing to the middleware. A bound that
silently aborted a half-finished upload would be the worst defect such a tool
could have, so this is checked against the client rather than assumed of it.

**An error raised while FOLLOWING the job is not the call failing, and must not
be reported as one.** `trackJob` reads `core.get_jobs` and listens on a socket
that can drop, so the stream can error long after the mutation landed. Letting
that reject the handler tells the caller the sync failed when it is running, and
throws away the job id in the same act — the unnameable-run failure the bound
exists to prevent, reached from the other side. So an error after the client has
reported on the job ends the watch and the result says what was established,
which is `ended: false`. An error BEFORE the client has named the job still
fails: there is no id to keep and nothing to report. **A mutating tool that
follows its own effect has two failure eras, and only the first of them is the
call's.**

**Which is why this tool calls `callAndGetJobId` and `trackJob` apart rather
than `api.job`, which is those two piped together.** The two eras are divided by
the moment the client correlates the job id off the job event, and `api.job`
consumes that id inside its own `switchMap` — nothing of the job reaches the
caller's pipe until `trackJob` emits. But `trackJob` opens by dispatching
`core.get_jobs`, which can fail on its own, and by then the sync is running and
the client has its id. Through `api.job` that failure arrives as a rejection
carrying nothing: the caller is told the mutation failed, and the only number
that could still name the run is gone. **Where a client method pipes two stages
together and the seam between them is where a tool's own guard lives, call the
stages.** What that costs is the client's stated reason to prefer `api.job` — a
job typed `result: unknown` — and it costs nothing here, because `cloudsync.sync`
declares `response: null` and this tool never reads `result`.

`job_id` then comes from that correlation and NOT from the `id` on whatever the
tracking last reported. They are the same number, since the tracking filters on
it — and only the first survives a watch that established nothing else, which is
exactly when a caller most needs something to name the run with. **One fact, one
derivation**, the same rule `finished_at` follows above.

**Whether the job ended is read from the tracking COMPLETING, not from a state
list.** The client completes the stream on its own `isJobFinished`, so
completion moves with the middleware's terminal set instead of with a set
written down here. A completion carrying no emission is the client having found
no such job, which establishes nothing — so both halves are required before
anything is called ended.

**Every other field that means "the run is over" is then read off THAT, not off
a second list.** `finished_at` gates on `ended` rather than through
`jobFinishedAt`, whose `ENDED_JOB_STATES` is this repository's own set. The two
are **equal on the pinned client** — its `terminalStates`, which is what
`isJobFinished` tests and so what completes the tracking, holds exactly those
five states, read out of `dist/index.js` rather than assumed — so this is not a
bug being fixed. It is two independently maintained lists that happen to agree,
and a client release widening its own would have this result call a run ended
and refuse to say when it ended. **A tool with two derivations of one fact makes
one of them subordinate**, and the subordinate one is the local list. The
listings keep reading the set: none of them carries an `ended` to disagree with.

The trap that costs a round here is stating the divergence as something a later
**TrueNAS** release does. It is not: the terminal set is the CLIENT's, so only a
client bump moves it, and nothing a middleware adds reaches it on its own. A
job in a state neither list names does not complete the tracking at all — it
runs until the bound expires and reports `ended: false`.

**Terminal does not mean succeeded, and on this method there is nothing else to
read.** `cloudsync.sync` declares `response: null`, so the job's `result` is
null on success and on failure alike; the client says as much itself. The
outcome is read from `state` against the same success vocabulary the tasks
family already reads a run's state against, and `result` is not read at all — a
tool that awaited completion and reported success would have reported every
failed sync as a success. A terminal state this catalog does not recognise is
**not** read as a success, which is `tasks_recent_runs`'s direction: a run that
cannot be shown to have worked has not been shown to have worked.

**`ended: false` is "not established", and the description must not enumerate
it as a partition.** It covers a sync still going, a watch cut short by an
error, a state the client does not treat as terminal, an unreadable state, and
no job seen at all — and `state` and `job_id` narrow that without separating the
first three. Two review rounds were spent here on one sentence promising three
answers over four causes and then telling a caller which was which. **A
not-established field is not a status enum**; say what it rules out and name
what cannot be told apart. `succeeded` null is every one of those cases, and is
neither a failure nor a success. The tool reports no progress percentage and no
live status, and names `tasks_recent_runs` — whose `id` is this tool's `job_id`
— as where a still-running sync is followed up.

**A state that looks like a success does not make one, and that is the same
rule.** `succeeded` is null beside a `state` of `SUCCESS` where the run was not
established to be over, because the outcome is read off `ended` and a job can
move out of a state this tool merely saw. **Do not describe an unrecognised
terminal state as reporting `succeeded: false`** — the honest claim is the
weaker one this tool actually makes, that no state the catalog does not know is
ever read as a success, whichever way the watch ended.

**A plan names what the operation does to the data, not what the tool's name
suggests it does.** `cloudsync_run` starts a task whose own `transfer_mode` — a
required field on the pinned entity — decides whether the run DELETES anything:
`COPY` deletes nothing, `SYNC` removes whatever at the destination is not at the
source, and `MOVE` removes the source once the copy lands. A plan step reading
"this copies data" would have been true for one of the three and would have
hidden a deletion behind the word the tool is named for. The mode is named in
the plan, its effect is spelled out in the mode's own terms, and a mode this
catalog cannot read says so rather than defaulting to the harmless one — an
approver told nothing about deletion reads the silence as "nothing is deleted",
which is the one reading that costs data.

**A plan identifies an entity every way the listing it borrows its terms from
does.** A cloud sync task's `credentials` is declared a whole record and the
middleware also sends the id-only form, which is why `credentialId` exists and
why `cloudsync_tasks_list` reports `credential_id` beside `credential_name`. A
plan reading only the name renders "credential (the system reported none)" for
a task that named its credential perfectly well — **a reduced identification is
not a shorter answer but a STATED ABSENCE**, and it is stated in the one text a
person reads before approving. Both labels are carried, under the listing's own
field names so the two accounts cannot be read as two facts. This is #93's
direction rule reaching a plan: a field dropping towards a claim has to be
refused, and "no credential" is a claim.

**`destructiveness` is about the operation, not about the bytes, and it cannot
say both.** A cloud sync run can be stopped; what it has already written or
deleted is gone. The field is `reversible` because `irreversible` exists only so
the catalog can REJECT a tool — `catalog/catalog.ts` throws on registration — so
the other value would delete this tool rather than describe it more honestly.
**Where those two come apart, the field records the operation and the
description carries the account of the data**, and the description then may not
claim reversibility on the field's behalf.

What decides which value a triggering tool takes is **whether it authors the
destruction or only its timing.** Everything a cloud sync run deletes was
decided by whoever configured the task, and the system does the same thing
unattended at the next scheduled window; this tool moves the moment, not the
effect. A tool that composed a deletion of its own — chose the paths, or the
mode — would be the case the destructive-action policy is actually about, and
would not belong in the catalog at all. **Ask which of those two a new mutating
tool is before reaching for either value.**

**That rule is written at `Destructiveness`'s own declaration, and that is where
it had to go.** `ToolCatalog.list()` puts `destructiveness` into every
`AdvertisedTool`, so an adapter deciding how loudly to warn reads the field's
doc comment — which said only "how hard a mutating tool is to undo" while a
tool three fields away said `NOTHING HERE UNDOES ANY OF THAT`. A redefinition
that lives in one tool's comment and in this file is not one the next tool over
the seam inherits; a reviewer re-derives it per tool instead, which is what
happened here twice. **Where a field's declared meaning and a tool's use of it
come apart, fix the declaration** — the local comment then says which case the
tool is, not what the field means.

**The declaration was not the only place saying the old thing, and a rule is
only fixed where every statement of it is.** `ToolCatalog.register`'s rejection
message said the policy keeps irreversibly destructive *operations* out of the
catalog, and `README.md` said it again in the same words — a guarantee broader
than the check, which rejects a tool that COMPOSES such an operation and says
nothing about one that triggers an operation an operator authored. Both now say
the narrower true thing, and `AdvertisedTool.destructiveness` — the field an
adapter actually reads, which had no doc comment at all — carries the pointer to
`Destructiveness` and the warning not to read it alone. **When a redefinition
lands, grep for the sentence it replaces**: the enforcement point, the advertised
shape and the user-facing description each state a field's meaning
independently, and a reader reaches whichever one is nearest.

**The plan names one call, which is #119's distinction rather than a lapse.**
`scheduled_task_set_enabled` names its read as a step because `execute` makes
it; this tool reads only at plan time — to name the task, and to fail on an id
no task has — and `execute` re-reads nothing, exactly as `snapshots_create` does
not re-check its dataset. The `core.get_jobs` the client's tracking issues while
following the job is named in the step's *description* instead, because a step's
`params` are the exact params a call runs with and the job id does not exist
until the approved call has been made.

### A name broader than the tool is paid for in the description and the plan (#126)

`automated_task_set_enabled` switches an init/shutdown script on or off, and
that is the ONLY thing it does — while `automated_tasks_list`, the tool it takes
its name and its ids from, has four sections and three of them are switched by
`scheduled_task_set_enabled` instead. The name is therefore broader than the
tool, which is ordinarily the finding rather than the design: it is
`storage_scrub_history` promising history the data cannot hold, moved up from a
field to a tool name.

**It was taken deliberately, and what makes it survivable is worth naming
because a later tool will face the same choice.** #121 established that a tool
named for a category may not accept a member of another one, which left the
excluded kind needing a name that claims no schedule; `automated_task_set_enabled`
is that name, and the alternative — `init_shutdown_script_set_enabled` — says
exactly what the tool does and would need renaming the day a second
non-scheduled kind arrives. Breadth was chosen over precision, so three things
carry the scope the name does not:

- **The description states the boundary FIRST**, before anything about the
  outcome: which of the four sections the id comes from, and which tool takes
  the other three.
- **The `id` argument's own description repeats it**, because that is what a
  caller reads when it is choosing a number.
- **The plan is what actually stops a mis-aimed id.** Task ids are per-table
  integers, so a cron job's id 3 is also a script's id 3, and unlike #121 there
  is no discriminator to require — one kind means nothing to discriminate. What
  remains is that an approver reading *"the init/shutdown script with comment
  ..."* sees something that is not the cron job they meant. **Where a tool
  cannot detect the wrong argument, the plan has to make it recognisable**, and
  that is a reason for the plan to name an entity in human terms over and above
  #121's.

**Ask which way a name is wrong before accepting it.** A name promising a
category it does not cover is recoverable this way; a name promising a
GUARANTEE the normalization does not deliver is not, because no description
undoes a field that reads as established.

### Where a listing's own vocabulary runs out, point rather than re-gloss (#126)

The plan for this tool cannot end with `describeTask`'s schedule phrase — an
init/shutdown script carries no cron record, and rendering one would be the
tool's own fiction about when the work happens (#97). What replaces it is the
`when` the row actually carries, passed through as the system spelled it, plus a
pointer at `automated_tasks_list` as the place each lifecycle point is
described.

**The three points are deliberately NOT glossed a second time here.**
`automated_tasks_list`'s description already says what `PREINIT`, `POSTINIT` and
`SHUTDOWN` name; a second account written into a plan is a second opinion that
can drift from the first, which is the same argument `TRANSFER_ENDS` makes for
restating `cloudsync_tasks_list`'s reading of `direction` rather than deriving
its own, and the same argument `schedulePhrase` makes for pointing at the tool
that reports the cron fields it will not put into English.

**A lifecycle point that could not be read is stated, and NOT defaulted to
startup.** An approver told nothing reads the silence as "it runs at boot" — and
a `SHUTDOWN` script is the one where switching it off at the wrong moment costs
most, which is `transferModeSentence`'s refusal to default to the harmless mode
in a second family.

### Two values, because the data effect is not a property of the tool (#128)

`Destructiveness` stays `'reversible' | 'irreversible'`. #122 settled why
`cloudsync_run` takes the first — the field records the operation, the
description carries the account of the data, and the test for a triggering tool
is whether it authors the destruction or only its timing. What this ticket asked
was the next question: whether the TYPE should grow to say it, either as a third
value that registers like `reversible` and advertises differently, or as a
separate field for what the operation does to the data. Neither, and the reason
is one #122 never had to reach for.

**The data effect is not a property of the tool. It is a property of the entity
the caller names at call time.** `cloudsync_run`'s effect is the named task's own
`transfer_mode`, read at plan time: `COPY` deletes nothing, `SYNC` and `MOVE`
delete for good, and the same tool is all three across three ids. A value or a
field fixed at the tool's declaration has only two ways to be written and both
are wrong — worst case for every call, which tells an approver "may delete"
about a `COPY` task and teaches it to discount the warning, or a reading of
state a declaration cannot see. **The plan and the description are the only two
places a per-call fact can be stated**, and they already state it.

The kinds coming next sharpen that rather than strain it. `cronjob.run` executes
an arbitrary operator-written command, and the strongest true thing a static
field could say about one is "whatever the operator wrote" — which is prose, and
belongs where prose goes.

**A third value is also dearer than it looks, because exactly one value is
load-bearing.** `irreversible` is the only one that changes what
`ToolCatalog.register` does, so a `'triggers'` that registers like `reversible`
adds a case to a public-barrel type on which every consumer's switch gains a
branch the check ignores. Worse, it lands on `AdvertisedTool.destructiveness`,
whose doc comment exists to say the field must not be read alone — and a value
named for the case is an invitation to read it alone. **Do not widen a field to
carry a fact that is only true per call.**

So what this ticket changed is the tests, and the tests are the part that was
actually missing. `catalog.spec.ts` now covers the registration outcome for BOTH
values: `irreversible` rejected, asserted on the narrow wording — that the tool
*composes* such an operation — and `reversible` registering, retrievable and
advertised carrying the value. The narrowing #122 made to that rejection
message, to `README.md` and to the field's own declaration had **nothing
asserting it**, so a later edit restoring the broad promise (that the policy
keeps irreversibly destructive operations out of the catalog, which is a
guarantee this check cannot make) would have passed every test. **A redefinition
that lives only in prose is one edit away from being undone** — where the rule
is enforced by a message rather than by a type, pin the message.

### A credential is named by an allowlist, and that is what makes it readable (#132)

`replication_topology` reports the peer on the far end of each replication task,
which means reading a stored SSH credential — the thing `automated_tasks_list`
deliberately reads by `id` and `name` and no further, because its `attributes`
hold an SSH private key (#97). The ticket asked whether the host can be reached
without the key coming with it. It can, and the reason is the allowlist rather
than anything about this particular payload.

**The declared type is `SSHKeyPair | SSHCredentials`, and it is UNTAGGED.**
Nothing in the union says which arm a row is, and one of the two is
`{ private_key?: string, public_key?: string }`. What settles it is that the arm
a replication task actually uses declares `private_key` as a **number** — the id
of the separate `SSH_KEY_PAIR` credential that holds the key — so `host` and
`port` are ordinary fields on a record whose secret is a reference. Naming those
two BY NAME is what keeps that true whichever arm arrives, and what keeps the key
out if a release ever moves it. #97's account is unchanged: forwarding
`attributes`, or trimming the known secrets out of it, would still put a private
key in a tool result. **"This payload holds a secret" is a reason to name fields,
not a reason to refuse the read** — and the two are only the same answer for a
tool that had no use for the record.

**The join the ticket named is a FALLBACK, and it is made lazily.** A
`replication.query` row's `ssh_credentials` is declared a whole
`KeychainCredentialEntry`, so the common case carries the host inside the task
row and there is nothing to look up; the middleware also sends the id-only form,
which `tasks.ts` already reads for a cloud sync task's `credentials`. So both
shapes are read (#102's rule about a payload arriving more than one way), and
`keychaincredential.query` is called only where at least one task named its
credential by id alone. **A supporting read that was never made reports no reason
for not having been** — `credentials_unavailable` is null both where the listing
was read and where nothing needed it, and a section-style `unavailable` that
fired on a call this tool chose not to make would report a failure that did not
happen.

**One field, two tools, two readings — and #93 is what decides, not
consistency.** `source_datasets` is `textList`-shaped in `replication_status`,
which drops an entry it cannot read, and `strictTextList`-shaped here, which
nulls the whole list. This tool is asked which datasets go to a named peer, so a
list one name short says that dataset is not replicated there — a claim — while
in the status listing the same shortening understates a description. Two tools
reading one middleware field differently is the expected outcome of that rule
rather than drift; what would be drift is copying whichever sibling was read
first.

### The measured half of a question can be absent from the surface (#133)

`system_ntp_status` reports which NTP servers a system is configured to
discipline its clock against, and **nothing about whether the clock is actually
right** — no offset, no stratum, no last step. That is not a normalization this
tool declined to do. The pinned surface declares five methods under
`system.ntpserver` — `create`, `delete`, `get_instance`, `query`, `update` — and
`query` answers the stored configuration; nothing anywhere in the client's
declarations names a stratum, an offset, or the daemon behind them. **The
measured half is unreachable from this repository**, the same way
`filesystem.file_tail_follow` is unreachable in #72, and closing it is an
upstream change rather than something a tool here could compose.

**Say so in the description, and say it about the CATALOG rather than about the
tool.** A caller told only that *this* tool reports configuration will go
looking for the tool that reports the measurement, and there is not one. This is
#120's rule — a side effect that could not be established is stated, not settled
— reaching a fact that could not be READ at all: the honest answer is that the
question cannot be answered from here, and a tool whose subject is the
configuration must not let a caller infer the measurement from it.

**The empty list is the finding, and it is derived rather than reported beside
the list.** A system with no NTP server configured is a system with nothing
disciplining its clock, which is the one positive claim this read supports —
`servers_configured` is `servers.length > 0` for the reason `system_reboot_info`
derives `reboot_required` the same way: the middleware states the answer by the
length of a list and a caller should not have to know that. Two consequences
follow, and both are #93's direction rule:

- **An entry that could not be read is KEPT, as a row of nulls, and still
  counts.** Dropping it moves the list towards empty, and empty is the finding —
  a server this tool cannot read is not a server that is not there.
- **A payload that is not a list is fatal, not empty.** The client declares an
  array and #91 says a declared type is a claim about what arrives; a system
  answering with something else would otherwise reach `servers_configured` as a
  `false`, which is a positive claim about the clock that nothing established.

**An optional boolean the payload omits is null and never false** — `prefer`,
`burst` and `iburst` are all optional on the declared entry, and rendering an
absent one as `false` would report a choice nobody made. `minpoll` and `maxpoll`
carry no unit in their names under #96's first ground: the API declares none, and
nothing about a polling bound fixes one the way SMART fixes a drive temperature
in Celsius.

### A companion field is what separates two causes of one null (#134)

`privileges_list` reports `roles_reported` beside `roles`, and
`operator_defined` beside `builtin_name`. Neither is a second reading of the
same fact. Each is there because the field it sits beside answers null to
questions a caller has to tell apart.

`roles` is OPTIONAL on the entity — `roles?: string[]` — and it is read through
`strictTextList`, which nulls the whole list where any one name could not be
read (#93: a role list one name short says the group holds less authority than
it does). So one null covers three causes: a TrueNAS version that does not
report the field at all, a field that was there and was not a list, and a list
one of whose entries would not read. `roles_reported` — `Object.hasOwn` and not
`in`, which walks the prototype (#101) — separates the first from the other two,
and the description says outright that nothing separates the second from the
third.

`builtin_name` is the same shape one size smaller. It is declared
`string | null`, and null is the ticket's evidence that an operator created the
privilege — true of the explicit null and not of a value that arrived as
something else, since `textOrNull` answers null for both. `operator_defined`
carries that reading and leaves `builtin_name` reporting what was actually
there.

**A companion field earns its place only where the null it splits has causes a
caller would act on differently**, and it is reported BESIDE the field rather
than instead of it — which is where this differs from `system_general_config`'s
`ui_certificate` reduction (#102). There the record itself must not be
forwarded, so the fact replaces it; here the raw field is safe to report and is
the evidence for the companion's reading. Add the reading, keep the field, and
say in the description which combination means what.

### A read fails the tool only where the others describe its subject (#135)

`iscsi_list` and `nvmeof_list` each let ONE read fail the whole tool —
`iscsi.target.query` and `nvmet.subsys.query` — and catch the rest into a
`failures` list. `fc_list` catches all three of its reads and has no primary one.
That is not the new tool being more careful; it is the same test answered
differently by the subject.

**Ask what the other reads are ABOUT.** An extent and a session are both facts
about a target, so a listing with no targets has nothing for either to describe
and returning it would be returning a shape with nowhere to put anything. An FC
host adapter, an FC port and a port's link state are three facts about a
protocol rather than three parts of one entity: a system whose `fcport.query`
failed still has adapters worth reporting, and its status rows are still worth
reporting under `unattributed_status`. So no read there is entitled to fail the
tool, and the acceptance criterion that a system without the hardware answers
cleanly falls out of that rather than needing a check of its own.

**A `supported` field is a claim, and this tool does not make one.**
`nvmeof_list` reports `supported: false` off an absent-method rejection, which
is the strongest thing available to it. `fc.capable` — declared on the pinned
surface, `params: []`, `response: boolean` — would be a stronger and simpler
answer for FC, and it is NOT read here: #135's scope names three methods and a
fourth read is a decision a ticket should make deliberately. What the tool does
instead is refuse to imply one: its description says outright that the catalog
cannot say whether a system has FC hardware and that empty `hosts` and `ports`
do not distinguish absent hardware from unconfigured hardware. **Where a
question the API can answer is out of scope, say the catalog cannot answer it —
never let an empty list imply the answer.**

### An unconfirmed allowlist can reach the JOIN, not just the field names (#135)

`fcport.status` answers `unknown[]` — no declared row shape at all — so its four
reported fields are #98's considered guess, with `unreported_fields` built from
the keys that produced a value. What is new is that the guess extends to the key
the rows are ATTRIBUTED on: `port` is the only field the status rows and
`fcport.query` plausibly share, and if that is wrong nothing joins.

**Make a wrong join visible in the shape rather than in the field.** Every
status row that names no listed port goes to `unattributed_status` rather than
being dropped, so a join key that does not hold produces empty per-port `status`
lists beside a full `unattributed_status` — which reads as "this tool could not
place these" and not as "these ports report nothing about their links". Dropping
them, or filing them under a port anyway, both produce an answer that looks
correct and is not. This is `attribute`'s reason in `nvmeof_list` one level up:
there the unconfirmed part is whether an id answers to a listed subsystem, here
it is whether the key exists at all.

**What that costs is a cause added to every null downstream, and the description
owes all of them.** A port's `status` is null where the status read failed AND
where the port carries no name to be joined on — the first is in `failures` and
the second leaves it empty, so `port` and `failures` together separate them.
**A join whose key is a guess adds a cause to every null downstream of it**, and
naming one of them is this repository's most common finding wearing the join's
hat.

**Where the added causes stop being separable, say so instead of enumerating
them.** A full `unattributed_status` was first described as two readings split
by `ports` — a failed port read where `ports` is null, a join that does not hold
where `ports` is populated. It is three: an appliance that listed its ports and
has none mapped reads both lists cleanly and still attributes nothing, which is
neither. So the description now says what a full list RULES OUT (ports with
nothing to report; every row in it was read) and names what it cannot tell
apart, which is #122's rule about `ended: false` reaching a list. **Two review
rounds went on one sentence here and on the same sentence in `cloudsync_run` —
when a field's causes come from a guess, assume you have not enumerated them
all.**

### Where a service listens is reported beside what it serves, not under it (#138)

`iscsi_list` reports `portals` and `nvmeof_list` reports `ports`, each a
top-level list rather than a field on a target or a subsystem. Both are read
through `attempt`, so neither can fail its tool — which is #135's test answered
the way `fc_list` answers it: a listener is a fact about the PROTOCOL rather
than a part of the entity, so a system whose portals did not read still has
targets and sessions worth reporting.

**Only one of the two families can be joined, and the tool that cannot says so.**
`nvmet.port_subsys.query` embeds the port and the subsystem whole, so each port
carries the subsystems published through it — reduced to `subsystem_id` and
`subsystem` (#100), never forwarded, and the NQN deliberately not repeated
because it is reported once on the subsystem itself. iSCSI has the same
relationship in a target's own `groups[].portal` and **this catalog does not
read it**: `portal` sits beside `initiator` and `auth`, which are the initiator
allowlist and the CHAP credential, and reading the group was out of #138's
scope. So `iscsi_list` reports the portals and states outright that it does not
say which portal serves which target. **A tool reporting two lists a caller
would expect to be joined has to say it did not join them** — side by side is
what an implied join looks like from the outside.

**Closing a gap a description NAMES means editing that sentence, not appending
to it.** `nvmeof_list` said in its own description that it did not report which
ports a subsystem was published on; that sentence is now the opposite of the
tool, and it is replaced rather than qualified — with the direction the answer
is read in (`ports[].subsystems`, since the subsystem row still carries no port
field) and with what the absence of a subsystem there does NOT establish when
either read failed or a publication could not be placed.

**A wildcard listen address is the trap, and it is the description's to state.**
An iSCSI portal on `0.0.0.0` is bound to EVERY address, and `::` is the same
answer for IPv6 — the opposite of what a reader who sees a placeholder assumes.
The string is passed through as the system spelled it and the description says
what it means, which is the same division `addr_trsvcid` gets one tool over:
declared `number | string | null`, reported as whichever arrived, and never
converted, because fixing one spelling would assert a meaning the surface
refuses to (#96). A port's `address` is null both where the field could not be
read and where the system sent the empty address the middleware accepts on a
TCP port — stated, since **this catalog does not establish what an empty
address means** (#120), and a null there is not evidence a port listens nowhere.

### Two credentials on one payload, and what still gets passed through (#139)

`ups_config` reads `ups.config`, whose `UPSEntry` carries `monpwd` — the UPS
monitor password, declared a plain `string` with nothing in the type saying it is
a secret — and `extrausers`, free-form `upsd` user configuration, which is the
other place a monitoring credential is written. Naming the twelve reported fields
one by one is what keeps both out, and it is #97's rule rather than caution: a
tool result is recorded verbatim in the audit trail (S3.3), so a mapping written
by trimming would put both in one.

**`monpwd` is not reported as WHETHER ONE IS SET either**, which is the answer
#100 gave for `VMDisplayDevice.password` and is taken here deliberately rather
than reached by omission. `monuser` goes out with it: it is a username rather
than a secret and could be reported, but it answers nothing a reader would act
on, and **both halves of one credential outside the boundary is a line a later
edit is less likely to widen by accident than a line drawn through the middle of
one.**

**What decides the remaining fields is whether they answer the tool's own
question, and that cuts both ways on the same payload.** `shutdowncmd` is
operator-supplied shell text and it IS reported — it is the most direct answer
this tool has to "what does this system do on the way down", and #97 already
passes a cron job's `command` through in a listing whose description warns about
it, drawing the line at a mutating tool's approval text. `options` and
`optionsupsd` are operator-supplied text too and are NOT reported: they answer no
question this tool is asked, the surface states nothing about what goes in
either, and an option string is where a device credential gets inlined. **Two
free-form operator strings on one payload, opposite answers — the warning in a
description buys a field its place only where the field is load-bearing.**

`rmonitor`, `hostsync` and `complete_identifier` are left out under #102: a bare
boolean, a bare number, and a name that says "complete" with nothing on the
surface saying complete relative to what. Every one of those omissions is named
in the description, per that decision's corollary.

### A payload that answers whether or not the thing exists (#139)

`ups.config` returns a full configuration on a system that has never had a UPS —
every field declared and typed, none of them an `enabled`, defaults where nothing
was set. **No field distinguishes "configured" from "never set up"**, checked
against the declared entry rather than assumed, so the description says outright
that the tool reports configuration and does not establish that a UPS is
attached, reachable, or being monitored. That is #133's shape — the measured half
of the question is not on this surface — with `services_status` named as the
nearest answerable part rather than the caller being left to infer it.

**The consequence a description must state is that an empty-looking result is the
ORDINARY answer**, not a fault and not a failed read. Which is also why a payload
that is not a record is fatal here rather than mapped to nulls: a result of nulls
would be indistinguishable from the unconfigured system, and only one of the two
was actually read.

**`remote_host` and `remote_port` are not grouped under `mode`.** The obvious
description — "these describe the far end when the system is a slave" — is a
claim the surface does not make, exactly as `RsyncTaskEntry` ties no field to its
`mode` (#97). Each is described as what the configuration records, and a null in
them is not evidence the system owns its own UPS.

### One question with two sources on the surface reads the cheaper one first (#140)

`storage_pool_status` reports `feature_flags_current`, and the pinned surface
answers that question **twice**. A `pool.query` row declares
`is_upgraded?: boolean` — optional, so a system may or may not send it — and
`pool.is_upgraded` is a separate verb taking one pool id and answering a bare
boolean. The ticket named only the verb, and reading only the verb would have
been an N+1 fan-out over an answer that had usually already arrived; reading
only the row would have reported "not established" for every pool on a system
that omits an optional field, when a call could have settled it.

**So the row is read first and the verb is called only where the row carried no
boolean this file could read.** That is #102's rule — where a fact can arrive in
more than one shape, a reading that both shapes satisfy is worth more than a
guard written to one of them — plus #132's lazily-made fallback, where a
supporting read nothing needs is not issued at all. The fallbacks that ARE
needed go out together under one `Promise.all`, so the whole thing costs one
further round trip rather than one per pool, which is `reporting_app_vm_usage`'s
per-entity shape.

**An unreadable row value falls through to the verb rather than short-circuiting
to null.** A row that sent `is_upgraded` as something that is not a boolean has
not answered, and the verb is the authoritative source for this question either
way — so the fallback condition is "the row produced no boolean", never "the row
had no key". `false` is a value and not an absence, and the test pinning that is
the one worth keeping: `false` is the answer this tool exists to surface and it
is also falsy, so a fallback written as `carried || read()` asks a second
question about a pool that had already answered.

**Null is not a false, and the causes behind it are not separable — nor are they
enumerable, which is the part a first draft got wrong.** No readable flag beside
no readable pool id (nothing to aim the verb at), a verb that rejected, a verb
that answered with something that is not a boolean, and a verb whose observable
completed without emitting, which `firstValueFrom` raises as an error and the
same catch takes. The first three read as a partition and are not one; the
description now says what a null RULES OUT — that this tool read a boolean —
and says outright that it separates none of the causes, per #122. **No companion
field splits it**: #134's bar is that a companion earns its place where the
causes behind one null are ones a caller would act on differently, and every
cause here leaves the same course of action. The rejection text is dropped for
the same reason, and the rejection itself is caught per pool — this tool is
composed by `system_health_report` and, through it, by `fleet_health_rollup`, so
a flag it cannot read must not take down the catalog's most load-bearing read.

**`system_health_report` deliberately neither carries nor scores the field, and
that is stated rather than left to omission.** Its verdict is about health, which
this repository defines (#47); feature-flag currency is a NOTICE-level
configuration fact — the pool keeps working, which is why an un-upgraded one goes
unnoticed — and upgrading is ONE-WAY and can prevent a TrueNAS rollback, so it is
a fact to report and never a defect to fix implicitly. #46's rule is to summarise
by dropping fields and never by re-judging them, and #44's is that a composite
re-reads every field through its own guard by name — which is what kept the new
field out of `poolEntries` without a line changing there. The composite's spec
now asserts the pools entry's **exact key list**, so a field reaching it
unannounced fails a test rather than shipping — nothing can arrive there on its
own, so what that assertion pins is the decision. `storage_pool_status`'s own
description carries the pointer both ways: a pool that is behind is not a reason
that report is anything other than `OK`, and this field is where the answer
lives.

**Describing a NEIGHBOURING tool means reading its description, not recalling
it.** The first draft said `alerts_list` carries the `PoolUpgraded` alert only
until it is dismissed, which is what the ticket's own text says and is the
opposite of what that tool does — its description states outright that dismissed
alerts are still active conditions and are included. A pointer between tools is
a claim about the other tool, and it can be false the same way any description
can.

### Match a numbering by stating it, not by importing the family that renders it (#141)

`pool_resilver_config` reports `weekday` as the NUMBERS the middleware sent,
and the ticket asked for the numbering `tasks.ts` already settled for cron
day-of-week fields. Two things were in tension: #95 refuses to copy a family's
vocabulary into a second family — the cron rendering (`dayName`,
`describeSchedule`) is the tasks family's own — while a second, disagreeing
account of what day `1` is would be exactly the drift `common.ts` was cut to
stop.

**The way out was that there was nothing to choose between.** The surface
declares `weekday?: number[]` and states no numbering, so the reading is a
guess in the #98 sense; what makes it a checkable one is that the two candidate
numberings AGREE ON EVERY VALUE BOTH DEFINE. Cron runs 0 and 7 for Sunday with
1 Monday through 6 Saturday (`dayName` maps `n % 7` over a Sunday-first list);
ISO-8601 runs 1 Monday through 7 Sunday and has no 0. So 1–7 name the same day
under both, and 0 is cron's alone. The description states that agreement and
stops there — it does not claim the field IS cron-numbered — and `pools.ts`
imports nothing from `tasks.ts`. **Matching a convention is stating it; it is
not re-siting the code that implements it**, and where two readings coincide,
saying so is a stronger claim than picking one (#102's reduction that both
shapes satisfy, reached from the numbering instead of from the payload).

**The range check is what keeps that statement true**, which is why it is
all-or-nothing. An entry outside 0–7 is a day neither numbering names, so the
list has been misread rather than partially read — the same reading
`numberList` gives an out-of-range cron field — and under #93 a `weekday` one
day shorter would say the window does not apply on that day, which is a claim.
`[]` stays `[]`: the system reported a list and it names no day.

**"System-local" is itself an unconfirmed reading, and the ticket asking for it
does not make it a confirmed one.** `begin` and `end` are clock times with no
zone in them, and the surface states the zone for these no more than it does
for any other schedule the catalog reports. What is established is the
negative — nothing in the strings says which zone, so the instant either names
is not fixed by this read — and the local-time reading is carried as
`(unconfirmed)`, in `ups_config`'s form, with `system_general_config` named as
where to confirm it. **A ticket can ask for a sentence and still not supply the
evidence for it**; state what the read establishes, and mark the rest.

**A middleware field name inherits none of the tool's care, and `enabled` is
the case to watch.** `enabled: false` on this payload means the priority window
is not in force — the system still resilvers, at ordinary priority — so the
name promises a great deal more than it delivers, and the correction lives in
the description because the name is the middleware's to spell. That is
`storage_scrub_history`'s finding arriving through a field this repository did
not name, and it is why the description says what the flag does NOT mean before
it says anything else about it.

### The public barrel is pinned by identity, and its spec sits beside it (#151)

`src/index.ts` names every tool by hand and an export there is a contract, and
until #151 **nothing asserted that it did**. #141 registered a tool, re-exported
it from `src/tools/index.ts`, and left it out of the public barrel: typecheck,
lint, 1427 tests, the coverage floors and the build were all green, because the
exact-list assertion in `src/tools/index.spec.ts` reads
`createDefaultCatalog().list()` and that says nothing about what the package
exports. The failure is invisible from inside the repository and lands on a
consumer.

**The spec is `src/index.spec.ts`, beside the module, not a third block in
`src/tools/index.spec.ts`.** That is #87's own rule — a spec sits beside the
module it covers and is named for it — reaching the one module the rule had not
been applied to. `src/index.ts` being excluded from coverage is not a reason to
put its spec elsewhere: the exclusion is about a re-export barrel having no
lines worth counting, and the contract it carries is still a thing to pin.

**Every assertion is by IDENTITY, and that is what makes it worth having.**
`list()` advertises schema and metadata only, so it cannot answer an identity
question; `get()` returns the registered `Tool` itself. A name-string comparison
would pass on a barrel re-exporting a different tool under the right name, which
is the next shape of the same failure and the one a bulk refactor produces.

**Three assertions, because the catalog cannot answer the third.** Every
registered tool is exported (missing tools reported by catalog name); no
tool-shaped export is unregistered; and each tool export NAME is bound to the
same object `src/tools/index.ts` binds it to. The catalog holds no record of
which export name a tool belongs under — `poolStatus` is `storage_pool_status`
and nothing derives one from the other — so a pairwise SWAP of two export names
satisfies both directions of the catalog comparison. `src/tools/index.ts` is
where that mapping lives and is the module the barrel re-exports from, so
pinning the two by name and identity is what closes it.

**A tool export is told apart from the rest by `mutating`.** A tool is the only
non-null OBJECT in the barrel carrying a string `name`, a string `description`,
an object `inputSchema` and a boolean `mutating`; `Role`, `RESERVED_ARGS`,
`fullAccessRoleMapper`, `noopAuditSink` and `consoleAuditSink` are the other
object-valued exports and none declares it, and everything else is a function or
a class, which `typeof value === 'object'` excludes — a class would otherwise
slip past a `name` test, since every class has one. **The predicate must read
both arms of `Tool`**: one that tested for `handler` would silently stop checking
the mutating tools rather than fail. A predicate matching something that is not
a tool fails loudly instead — it lands in the unregistered list by name.

**The non-tool half is pinned by hand, because nothing else can pin it.** The
tool half has the catalog as its source of truth; the rest of the barrel has
none, so the export names are listed in the spec and compared sorted. Sorted
rather than in the file's own order: the key order of a module namespace object
is a property of the module system, not of `src/index.ts`, and pinning it would
assert something this repository does not decide.

### A field whose read costs more than the tool's own bound is opt-in (#155)

`snapshots_list` reports `held` and `scheduled_removal` only where the caller
passed `report_held` or `report_scheduled_removal`, and both default false.
That is not caution about a wider response — it is where the cost lands.
`holds` and `retention` on `pool.snapshot.query`'s `extra` set
`get_holds`/`get_user_properties` on the underlying ZFS query and add
zettarepl's annotation pass, and both apply to the WHOLE query before the
middleware's own `limit` reaches anything: a listing bounded to 100 snapshots
pays them over every snapshot the system holds. **Ask where a read's cost is
applied relative to the bound the tool advertises** — `select` (#115) narrows
what comes back and is bandwidth, and this is the other direction.

**The argument-was-not-passed cause of a null is NOT split off by a companion
field, and that is #134's bar being applied rather than skipped.** Null on
either field covers the argument not having been passed as well as a payload
that would not read — and on `scheduled_removal` a third, ordinary cause, no
enabled task owning the snapshot at all. That first cause is the two-cause null
`temperature_reported` exists to split in #120, and a companion for it earns
nothing here: the caller set the flag itself, so it already knows whether the
field was asked for, and a companion field earns its place only where the causes
are ones the caller cannot tell apart and would act on differently. What it
cannot tell apart — an unreadable retention from no removal scheduled — no flag
of the caller's own settles, so the description says outright that the tool does
not separate them. **A rule that adds a
field is still a rule about the CALLER's answer**, and an argument the caller
passed is part of what the caller knows.

**Inside a record, the direction rule (#93) points the other way from the field
that holds it.** `held: false` and `scheduled_removal: null` are both claims
that nothing is protecting or scheduling this snapshot, and a caller acting on
either prunes — so an unreadable holds payload is null and never false, while a
retention record whose `datetime` will not read KEEPS the object, with `at`
null, because nulling it would say no removal is scheduled when one is. The
same reading, applied one level in, produces opposite-looking answers.

**`held` is TrueNAS's own hold tag and the description says so before it says
anything else.** `_transform_snapshot_entry` reports `{ truenas: 1 }` where that
one tag is present and `{}` otherwise, normalising the count — so a ZFS hold
under any other tag is invisible to this field, and the name promises a great
deal more than the payload delivers. That is `pool_resilver_config`'s `enabled`
(#141) in a field this repository DID name: the correction still lives in the
description, because the honest name would be `truenas_hold_tag_present`.

**`scheduled_removal` does not account for holds**, and the two fields are
independent — `annotate_snapshots` never reads holds, so a held snapshot can
report a removal date it will survive. Stated in the description as the reading
a caller is most likely to get wrong, since side-by-side fields are what an
implied relationship looks like from the outside (#138).

### The read a plan names can come after the mutation (#153)

`snapshot_clone` returns two plan steps in the order `pool.snapshot.clone`,
then `pool.dataset.query` — the mutation first and the read second, where
`alerts_dismiss` and `scheduled_task_set_enabled` both read first. #119's rule
is unchanged and is what produces the difference: a `PlanStep` is a call
`execute` will make, so the steps are the calls in the order `execute` makes
them. Those tools read BEFORE the call because the fact they report — whether
the alert was already dismissed, whether the task was already enabled — is only
readable beforehand. `pool.snapshot.clone` answers a bare `true`, so the only
thing left to establish is whether the dataset is now there, and that is only
readable afterwards. **Ask when the fact the result reports is readable, and put
the step there** — a plan that lists a read first because the sibling tool does
is a plan describing an order that will not happen.

Half of that step's params are closed by construction and half are held by a
test, which is worth being exact about. The OPTIONS come from one hoisted
`const` the read and the step both name; the FILTER is written twice, because
written to a `const` it widens out of the filter tuple. So a test takes the
read step back out of the plan and asserts the `query` spy was called with it —
that assertion, and not the shared helper, is what keeps the filter halves in
step. Two hand-written copies of the same params is how a plan stops being true
one edit at a time, and **where construction cannot close a half, say which
half the test is holding** — a note claiming one helper covers both invites a
later reader to drop the assertion as redundant.

### An existence check reads the response, not the row count (#153)

`assertDatasetExists` counted rows: an empty list meant the dataset was not
there. It now finds a row whose `id` IS the name asked for, and `snapshot_clone`
reads its source the same way. This is #121's *never act on the first row of a
filtered read* applied to a guard rather than to a listing, and the guard is
where it bites hardest — an unrecognised query parameter is dropped rather than
refused, so a filter that did not apply comes back as the whole table, which a
count reads as "it exists". **That fails in opposite directions on one call**:
`snapshots_list` would stop reporting a dataset that is not there, and
`snapshot_clone` would refuse every destination on the system. Neither looks
like a filter problem from the outside.

**Both declared name fields are compared for the snapshot, and the read asks
both ways.** A snapshot row declares `id` and `name` as two separate required
strings and the surface states no relationship between them — the same shape as
an alert's `uuid` and `id` (#119) — so a match on either is what keeps the plan
from failing for a snapshot that is plainly there. #91's rule reaching an
equality nobody wrote down.

**A comparison over two fields needs a FILTER over both, or it rescues nothing
on the system it was written for.** Comparing `name` after filtering on `id`
alone reads as belt and braces and is not: where the two differ and the caller
passes the `name` — which is what the description asks for — a filter the
middleware honours answers with no row, and the second comparison has nothing to
run against. It is reachable only on the dropped-filter path, which is a
different case. The client declares the disjunction itself
(`['OR', QueryFilters<T>[]]`, each arm a filter LIST), so this is checkable
against the surface rather than guessed. **Ask which rows the filter can return
before deciding what comparing them establishes** — the filter and the
comparison do different jobs (#121: bandwidth versus the control) and a
mismatched pair silently covers neither case.

### `reversible` is not "this catalog can undo it" (#153)

`snapshot_clone` adds a dataset and removes nothing, so `destructiveness` is the
easy case — there is no account of the data to come apart from the field the way
`cloudsync_run`'s does (#122, #128). The trap is one level over: a field saying
`reversible` beside an operation that plainly removes nothing invites the
reading *undoing this is easy*, and undoing a clone means deleting the dataset
it made, which **no tool here does**. The description says that outright, next
to the field's own meaning. **Where a tool's operation is genuinely reversible
and the catalog still cannot reverse it, say so** — the field records the
operation, and a caller reads a reversal it could ask for into it otherwise.

The other half is the fact the operation's own shape hides. A clone shares
blocks with its source snapshot, so **creating one pins that snapshot
indefinitely** — it cannot be destroyed while the clone exists, and the space it
references stays in use, including where a `scheduled_removal` `snapshots_list`
reports would have taken it. An additive operation with a lasting consequence
elsewhere is exactly what a caller will not infer, so it is in the description
before anything about the result. How TrueNAS's retention path REPORTS a removal
that then fails is marked `(unconfirmed)`, in `pool_resilver_config`'s form
(#141): what is claimed is the pinning, which the ZFS semantics fix, and not the
error, which was not read off a live system.

### A triggering tool states the SCOPE of the effect it does not author (#154)

`snapshot_task_run` is the second job-backed tool and it copies `cloudsync_run`
whole — `callAndGetJobId` and `trackJob` apart, a bounded watch that does not
end the job, `ended` off the tracking completing, `job_id` off the correlation.
Nothing in #122 needed rethinking, and none of it is re-argued in the code. What
this ticket had to decide is the PLAN, and the decision generalises past this
tool.

**A run of a periodic snapshot task PRUNES, and the pruning reaches past the
task named.** `pool.snapshottask.run` interrupts zettarepl's scheduler with the
task, which goes round the same loop a scheduled fire goes round and ends in the
retention pass — and that pass builds its owners from *every* periodic snapshot
task on the system. So running task A can destroy snapshots owned by task B
whose retention had lapsed and whose own tick had not come round. A plan reading
"this takes a snapshot now" would omit a deletion, which is
`transferModeSentence`'s defect in a second family.

**So the plan states the MECHANISM and its SCOPE, and computes no outcome.** It
says the run applies retention, says the pass is system-wide in those words,
names the two protections that bound it — a snapshot whose name matches no
task's naming schema is skipped, and the newest snapshot for a schema is kept
where destroying it would leave none — and then points at `snapshots_list`'s
`report_scheduled_removal`. Enumerating instead would be a second opinion about
retention beside the middleware's own (#44), and it could not be sound anyway:
that listing is bounded, and its own description says a truncated list cannot
show a snapshot is absent. **Ask what an operation does and to what, and say
that; do not compute what it will hit.**

**The scope sentence needs the protections, and the protections need the scope
sentence.** "Retention runs across every task" alone reads as "anything may go"
and teaches an approver to discount the warning; the protections alone read as
"only stale scheduled snapshots go", which is the claim the first sentence
exists to refuse. Neither half is optional and they are one text
(`RETENTION_PASS`) so that no later edit can keep one and drop the other.

**A protection stated as a CONDITION may not be restated as a class of
snapshot, and this is where the description convention bites hardest.** The
first protection is about the NAME: a snapshot whose name matches no task's
naming schema is skipped. The first draft of both texts drew the obvious
inference from it — *so a snapshot taken by hand is not at risk* — and that is
false. `snapshots_create` takes the snapshot name straight from the caller
(`required: ['dataset', 'name']`) and checks it against no task's schema, so a
manual `tank/media@auto-2026-09-01_02-00` matches the periodic schema, is owned
by the retention pass, and is destroyed by it. **A condition rewritten as a
guarantee about who did something is a description promising more than the
normalization delivers** — reached through an inference rather than through a
field, which is why it survived a round. The failure direction is the costly
one: the reader is reassured about the exact case that is unsafe, in the one
text a person reads before approving. State the condition and say what does not
check it.

**None of that account is on the API surface, and the description says so.**
Nothing the client declares says a run applies retention, says it applies
system-wide, or says which snapshots survive — the reading comes from the
TrueNAS implementation. That is #133's shape (the measured half of a question
being unreachable from here) reaching an EFFECT rather than a fact, and #120's
rule pointed the other way: a side effect that could not be established is
stated rather than settled, and one that was established somewhere this
repository cannot check is stated *as that*. Silence would have been read as
"this only creates".

**Only an explicit `false` refuses the plan.** `enabled` is optional on the
entity and the middleware rejects a disabled task, so the plan reads it and
fails at plan time naming the task — but a null is "the system reported no
value", which is not the same answer as off, and failing on it would refuse a
plan the middleware would have accepted. The unreadable case says the call may
be rejected and names `scheduled_task_set_enabled` instead. That check is
plan-time only, as `snapshots_create`'s dataset check is (#119), so a task
disabled between plan and confirmation is refused by the middleware — stated in
the description rather than fixed by re-reading, because `execute` re-reading
would make it branch on state the confirmation token cannot bind.

**The two tools keep separate watch bounds, equal though they are.** The bound
is a ceiling on a TOOL's patience and not an estimate of its job (#122), so one
shared constant would assert that the two ceilings must move together, which
nothing requires. What IS shared is `schedulePhrase`, which now takes the
pointer rather than a whole `TaskKind` — a second spelling of "the schedule
could not be put into words" in one file is the drift `common.ts` was cut to
stop, one size down. **Share a SENTENCE, not a number.**

`tasks.spec.ts` was 1,352 lines and this block is several hundred more, so the
#87 exception is met and the tests took `snapshot-task-run.spec.ts`. Its fake
system is local, as `cloudsync-run.spec.ts`'s is: a job is a stream rather than
a response, and `src/testing/fake-systems.ts` stubs `call` and `query` off one
method→response map. Two copies now exist, which is when a shared fixture could
be designed from evidence — a later ticket's call, not a side effect of this one.

### One call made twice is named once, and the step says when (#156)

`snapshot_set_hold` returns **two** plan steps and `execute` makes **three**
calls. `pool.snapshot.hold` and `pool.snapshot.release` answer `null`, so there
is no updated entity to read the outcome off (#121) and the state has to be read
both before and after — which is `alerts_dismiss`'s position (#119) with a
second read on the far side of the mutation. Both reads are the SAME call: same
method, same params, from one helper. Listing it twice would show an approver
two entries it has no way to tell apart, so it is named once and that step's own
description says it runs again immediately after the call. That is the seam
`cloudsync_run` uses for the `core.get_jobs` its tracking issues (#122), reached
for a different reason — there the params do not exist until the approved call
has been made, here they are identical to a step already in the plan.

**#119 is unchanged and this is not an exception to it.** The rule is that
nothing `execute` calls may be missing from the approval; a repeated call is not
a further call to disclose, it is the same one happening twice, and the plan says
so in words. **Ask whether an approver reading the plan could be surprised by a
call `execute` makes** — that is the test, not whether the step count equals the
call count.

### The two directions of one mutation need not be symmetric (#156)

`held: true` places TrueNAS's own hold tag and only that tag; `held: false`
removes **every** hold tag on the snapshot, including any placed outside TrueNAS
that `snapshots_list` never reported — its `held` is the `truenas` tag alone
(#155). The middleware's own methods are what differ: `hold` names the tag,
`release` names none, and the second is documented as removing all of them.

**A tool with a discriminator must not describe one arm and let the other
inherit it.** The description and the plan step both state the asymmetry, and
the plan's already-in-the-target-state sentence refuses the obvious wording for
a release: *"it is not held, so this changes nothing"* is the tool claiming to
know about tags it never reads. What it says instead is that this is not an
error AND that a hold under another tag would still be removed.

That reaches the result, which is where it is easiest to miss. `changed`
compares the two readings, and both readings are the `truenas` tag — so
**`changed: false` on a release does not mean nothing was removed**. Said
outright, because side-by-side fields are what an implied completeness looks
like from the outside (#138), and a caller reading `changed: false` as "no
effect" is the one reading that costs a snapshot's protection.

**A sentence derived from a state read may not reach past what was read, and
`recursive` is where that bites.** `readHoldState` queries the one snapshot
named while the call reaches every child of it, so the plan's
already-in-the-target-state sentence — *"it already carries that tag, so this
changes nothing"* — was true of the snapshot and false of the operation, in the
reassuring direction, in the one text a person reads before approving. The
effect sentence therefore takes `recursive`: each arm names the snapshot it is
about and says outright that the children's hold state was not read, which is
all a read of one snapshot supports. The same scoping is owed by the result,
where the three readings above are the named snapshot's alone — so a recursive
hold of an already-held snapshot reports `changed: false` having placed holds on
children, which the description states beside the release reading it sits next
to.

**A scope sentence beside an effect sentence does not scope it.**
`recursiveSentence` already said the call reaches more than the snapshot named,
one clause earlier, and the no-op claim still read as being about the call —
adjacency is not qualification, which is #138's implied-join finding arriving in
a single paragraph of prose.

**`reversible` is #153's trap again, one tool over.** The operation destroys no
data — it changes what may destroy a snapshot later — but a release is not
undoable from here: setting the hold again places the `truenas` tag and only
that tag, so a foreign tag a release removed is restored by nothing in this
catalog. Where a tool's operation is reversible in principle and this catalog
still cannot reverse it, say so.

**Whether a hold actually stops retention destroying the snapshot is
`(unconfirmed)`**, in `pool_resilver_config`'s form (#141). What is claimed is
the ZFS mechanism — a hold makes the destroy itself fail, and
`annotate_snapshots` never reads holds, so `snapshots_list` can report a
`scheduled_removal` for a snapshot that survives it. How TrueNAS reports or
recovers from a destroy that fails was not read off a live system, and asserting
a guessed side effect is worse than saying nothing (#120).

## Conventions

- **A tool description must not promise more than the normalization delivers.**
  This is the single most common review finding in this repository. State what
  a nullable field means when it is null, keep "unreadable", "absent" and
  "empty" distinct, and keep that distinction consistent with the sibling
  fields in the same file.
- **Map API rows through an allowlist of named fields**, never by trimming: it
  is what keeps a field a later TrueNAS release adds out of a tool result.
- **Partial failure is data, not an exception** — see `fanOut` and the
  `failures` list several tools return.
- The API surface is `DefaultApiDirectory`, the client's *oldest* supported
  TrueNAS version. Widen it only alongside a decision about the minimum
  supported version.
