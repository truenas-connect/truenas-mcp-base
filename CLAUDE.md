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
src/index.ts          the public barrel — an export here is a contract
```

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
