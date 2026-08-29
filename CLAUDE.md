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

### The shared guards live in `src/tools/common.ts` (#86)

Every tool file reads middleware payloads whose fields arrive as `unknown`, so
each needed the same narrowings — `textOrNull`, `numberOrNull`, `booleanOrNull`,
`recordOrNull`, `textList` — and the same reading of a rejection, `errorText`.
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
