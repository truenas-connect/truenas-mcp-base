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
`booleanOrNull`, `recordOrNull`, `textList` — and the same reading of a
rejection, `errorText`. The pinned client left many of those payloads as
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
- **The catalog-wide test is not any tool's.** The exact-list assertion over
  `createDefaultCatalog()` is about `src/tools/index.ts`, so it lives in
  `index.spec.ts` under the same rule as everything else. Registering a tool
  means editing that file and the module's own spec, and nothing else.

**`src/testing/` is test support, and is neither the library nor code under
test.** `fakeSystem` and `failingSystem` were declared once at the top of the
old file and used throughout it; they are now `src/testing/fake-systems.ts`, and
the directory is excluded from `tsconfig.json` (the library project must not
compile a file importing `vitest`) and from the coverage report. Counting it
would report 100% for fixtures and move the global percentages without a line of
the library being tested any better — the same reason `src/index.ts` is already
excluded there.

### An unreadable list entry is nulled or kept by which way it moves the summary (#93)

`audit_config`'s `scopeNames` nulls its WHOLE list when one entry cannot be read;
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
pinned client declares an eighth kind, `ISCSI_DISK`, on the device shape a
`vm.query` row embeds and the `vm.device` added/changed events carry, and leaves
it out of the one `vm.device.query` answers with — so a `dtype` an allowlist
does not map is what this surface already does, before any release moves. The
union a method answers with is not the union the same entity has elsewhere in
the client, and deriving the type off the call (#91) is what makes that visible.
`attributes` is null there and `dtype` is still reported, which is what lets a
caller tell an unmapped kind from a device whose configuration could not be read
at all (both null). Both readings have to be in the description: a null
`attributes` is a device that is there and configured, never one configured with
nothing.

The other half is where #97's credential rule lands when the credential is
inside an arm. `VMDisplayDevice.password` is the SPICE/VNC console passphrase,
declared a plain `string` beside ordinary display settings, and the DISPLAY
allowlist omits it — **not redacted, and not reported as whether one is set**,
since a tool result is recorded verbatim in the audit trail (S3.3). Naming the
arm's fields one by one is what keeps it out, and what keeps out a second
credential-shaped field a later release adds to any arm.

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
