# @truenas/mcp-base

Shared core library for TrueNAS MCP: the tool catalog, system registry, safety
model, and multi-system fan-out used by both the standalone community server
and the TrueNAS Connect browser adapter.

> **Status:** prototype sketch. See [docs/architecture-proposal.md](docs/architecture-proposal.md)
> for the design and [docs/prototype-plan.md](docs/prototype-plan.md) for what
> this sketch covers.

The core is a plain TypeScript library with no environment assumptions — no
filesystem, no process, no DOM. Everything environment-specific (credentials,
confirmation UX, audit sinks) enters through injected interfaces.

## What the sketch implements

- **Tool catalog** — curated tools with role metadata; irreversibly destructive
  operations are rejected at registration by policy. Read-only family:
  `system_info`, `storage_pool_status`, `storage_list_datasets`.
- **System registry** — 1..N named systems, each owning its own
  `@truenas/api-client` instance and credentials; `systems` selector
  (name / list / `all`, defaulting when one system is registered).
- **Multi-system fan-out** — concurrent per-system execution with structured
  per-system results; partial failure is data, not an exception.
- **Plan/confirm** — mutating tools are two-phase: phase one returns a plan
  (the exact API calls to be made), phase two executes only with a single-use,
  expiring confirmation token bound to the plan's tool + arguments + targets.
  Exercised end to end by `snapshots_create`.
- **Stubs** — role mapping (always Full), audit sinks (console/noop).

## Usage sketch

```ts
import {
  ConfirmationService, SystemRegistry, ToolExecutor,
  connectSystems, createDefaultCatalog,
} from '@truenas/mcp-base';

const registry = new SystemRegistry();
await connectSystems(registry, credentialProvider); // adapter-supplied

const confirmations = new ConfirmationService();
const executor = new ToolExecutor({
  catalog: createDefaultCatalog(),
  registry,
  confirmations,
});

const outcome = await executor.execute('storage_pool_status', { systems: 'all' });
```

For mutating tools the first call returns `{ type: 'PLAN', plan }`; after the
user approves, the adapter mints a token with `confirmations.mint(outcome.key)`
and the tool is called again with `confirmation_token`.

> **Adapter contract:** `mint` must only ever be called from the adapter's
> `ConfirmationGate` implementation, after a real user approval in the host
> UI. The core cannot enforce this boundary — an adapter that mints anywhere
> else removes the human from the loop.

## Development

```bash
corepack enable          # once, to enable Yarn 4
yarn install
yarn build               # bundle to dist/ (ESM + CJS + .d.ts) via tsup
yarn typecheck           # tsc --noEmit
yarn test                # vitest
yarn lint                # eslint
```

### Smoke test against a live system

```bash
TRUENAS_HOST=nas.local TRUENAS_USERNAME=admin TRUENAS_API_KEY=... yarn smoke
# or, script-only convenience (the core itself is API-key only):
TRUENAS_HOST=nas.local TRUENAS_USERNAME=admin TRUENAS_PASSWORD=... yarn smoke
```

Set `SMOKE_SNAPSHOT_DATASET=tank/some/dataset` to also exercise the
plan/confirm flow (creates a real snapshot). Self-signed certificates need
`NODE_TLS_REJECT_UNAUTHORIZED=0`.
