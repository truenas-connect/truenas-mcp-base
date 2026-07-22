# TrueNAS MCP Base — Prototype Implementation Plan

| | |
|---|---|
| **Status** | Draft |
| **Scope** | Minimal sketch of the core library (`truenas-mcp-base`) |
| **Date** | 2026-07-22 |

## Scope decisions

- **Core library only.** No stdio server or examples in this repo; end-to-end
  MCP-host validation waits for `truenas-mcp-server`. Validation here is unit
  tests plus a manual smoke script against a live system.
- **Read-only tools + plan/confirm shape.** A small read-only storage family
  working for real, plus **one** mutating tool exercising the two-phase
  plan/confirm flow — this validates the riskiest design idea early.
- **Stubbed, interfaces only:** role mapping (always Full), rate limiting
  (no-op), audit (console sink), coverage report.
- **Live TrueNAS system available** for the smoke script (host + API key via
  env vars, never committed).

## Tooling

Mirror `api-client-ts` so the repos feel like one project: Yarn 4 (corepack),
tsup (ESM + CJS + d.ts), vitest, eslint, `@/*` path alias, strict tsconfig.
`@truenas/api-client` and `rxjs` as peer dependencies. No dependency on the
MCP SDK — tool definitions are shaped so an adapter can map them 1:1 to MCP
`Tool` objects (name, description, JSON Schema input).

## Milestones

### 1. Scaffolding

`package.json`, `tsconfig.json`, tsup/vitest/eslint config, `src/index.ts`
barrel, CI-less for now.

### 2. Core types and injected interfaces

```
src/
  catalog/tool.ts        ToolDefinition: name, description, inputSchema,
                         metadata { mutating, destructiveness, requiredRole },
                         handler(ctx, args)
  registry/registry.ts   SystemRegistry: named systems, each owning its own
                         client + credentials (S3.6)
  interfaces.ts          CredentialProvider, ConfirmationGate, AuditSink,
                         MetricsSink (stubs shipped for the last two)
```

Registry entries are created from `CredentialProvider` output via
`createTrueNasClient({ uuid, hostnames, enabled: true })` followed by
`authenticator.loginWithApiKey({ username, key })`.

### 3. Multi-system fan-out

Resolve the `systems` tool parameter (one name | list | `all`; defaults when a
single system is registered), execute per-system concurrently, return
structured per-system results (`A: ok`, `B: failed (reason)`) with API errors
normalized via `getApiErrorMessage` (V5.3, V5.5).

### 4. Read-only storage tools

Two or three tools, hand-written, to set the catalog idiom:

- `storage.pool_status` — `pool.query`, health/topology/capacity summary
- `storage.list_datasets` — `pool.dataset.query`, trimmed fields
- `system.info` — `system.info`, grounds the LLM on version/hostname

Handlers use `client.api.call(...)` (rxjs → `firstValueFrom`).

### 5. Plan/confirm engine + one mutating tool

The heart of the sketch (A2.3):

- Executor treats mutating tools as two-phase. Phase 1 (no token): handler's
  `plan()` runs read-only inspection and returns affected systems/resources and
  the exact API calls to be made. Phase 2 requires a confirmation token minted
  by the injected `ConfirmationGate`; tokens are bound to a hash of the plan
  and expire.
- One low-risk mutating tool to prove it: `snapshots.create`
  (`zfs.snapshot.create`).

### 6. Validation

- Unit tests: mocked client; registry isolation, fan-out partial failure,
  plan/confirm token enforcement (wrong/expired/absent token never executes).
- `scripts/smoke.ts` (manual, live box via `TRUENAS_HOST` / `TRUENAS_API_KEY`):
  list pools and datasets, plan + confirm + create a snapshot, print per-system
  results.

## Explicitly out of scope

Role introspection/mapping (needs the API spike — open question 4), rate
limiting, real audit sinks, coverage report, MCP transport wiring, Connect
anything, catalog beyond the ~4 tools above.
