# @truenas/mcp-base

Shared core library for TrueNAS MCP: the tool catalog, system registry, safety
model, and multi-system fan-out used by both the standalone community server
and the TrueNAS Connect browser adapter.

> **Status:** prototype sketch.

The core is a plain TypeScript library with no environment assumptions — no
filesystem, no process, no DOM. Everything environment-specific (credentials,
confirmation UX, audit sinks) enters through injected interfaces.

## What the sketch implements

- **Tool catalog** — curated tools with role metadata; a tool that composes an
  irreversibly destructive operation is rejected at registration by policy.
  Read-only family:
  `system_info`, `system_update_status`, `system_reboot_info`,
  `audit_log_query`, `audit_config`, `security_config`, `system_general_config`,
  `storage_pool_status`, `storage_pool_topology`, `storage_scrub_history`,
  `boot_pool_status`,
  `storage_list_datasets`, `datasets_quota_report`, `disks_list`,
  `disks_temperature`, `apps_list`,
  `app_engine_status`, `apps_update_summary`,
  `vms_list`, `vm_logs`, `vm_devices`, `alerts_list`, `snapshots_list`,
  `replication_status`,
  `snapshot_tasks_list`, `cloudsync_tasks_list`, `automated_tasks_list`,
  `tasks_recent_runs`,
  `shares_list`, `share_access`, `nfs_clients`, `iscsi_list`, `nvmeof_list`,
  `users_list`,
  `directory_services_status`, `network_interfaces`, `network_config`,
  `certificates_list`, `cloud_credentials_list`, `alert_settings`,
  `reporting_utilisation`, `reporting_disk_io`, `reporting_space_trends`,
  `reporting_app_vm_usage`, `services_status`, `ha_status`,
  `system_health_report`, `fleet_compliance_report`, `fleet_health_rollup`.
  Mutating family, all of them two-phase plan/confirm and all
  `destructiveness: 'reversible'`: `snapshots_create`, `alerts_dismiss`,
  `alerts_restore`, `scheduled_task_set_enabled`, `cloudsync_run`,
  `automated_task_set_enabled` — `cloudsync_run` the only one that starts a
  background job, which it watches for a bounded time and then reports on
  rather than waiting out. `destructiveness`
  is about a tool's own operation and not about the data that operation acts
  on: `cloudsync_run` starts a task whose own `transfer_mode` may delete data
  for good, which its description and its plan state and this field does not.
  `scheduled_task_set_enabled` and `automated_task_set_enabled` switch a task
  on or off between them and neither covers the other's kinds: the first takes
  the six that run on a schedule, and the second the init/shutdown scripts,
  which run at a point in the system's lifecycle instead.
- **System registry** — 1..N named systems, each owning its own
  `@truenas/api-client` instance and credentials; `systems` selector
  (name / list / `all`, defaulting when one system is registered).
- **Multi-system fan-out** — concurrent per-system execution with structured
  per-system results; partial failure is data, not an exception.
- **Plan/confirm** — mutating tools are two-phase: phase one returns a plan
  (the exact API calls to be made), phase two executes only with a single-use,
  expiring confirmation token bound to the plan's tool + arguments + targets.
  Exercised end to end by `snapshots_create`, `alerts_dismiss` and
  `alerts_restore`.
- **Bounded file content** — an optional `SystemHandle.files` reader giving a
  tool the last N lines of a path on one system, over `core.download` and an
  adapter-supplied `ContentFetcher`. The line and byte bounds are enforced on
  this side, and the minted download URL never reaches a tool. Absent unless
  `connectSystems` is given a `ContentReaderFactory`, and `vm_logs` — the one
  tool that reads through it — reports that rather than an empty log; see
  `CLAUDE.md`.
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
