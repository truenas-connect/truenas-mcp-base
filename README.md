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
  `system_ntp_status`, `ups_config`,
  `storage_pool_status`, `storage_pool_topology`, `storage_scrub_history`,
  `pool_resilver_config`, `boot_pool_status`,
  `storage_list_datasets`, `datasets_quota_report`, `dataset_permissions`,
  `system_dataset_config`,
  `disks_list`, `disks_temperature`, `apps_list`,
  `app_engine_status`, `apps_update_summary`,
  `vms_list`, `vm_logs`, `vm_devices`, `alerts_list`, `snapshots_list`,
  `replication_status`, `replication_topology`,
  `snapshot_tasks_list`, `cloudsync_tasks_list`, `automated_tasks_list`,
  `tasks_recent_runs`,
  `shares_list`, `share_access`, `nfs_clients`, `iscsi_list`, `nvmeof_list`,
  `fc_list`,
  `users_list`,
  `directory_services_status`, `privileges_list`, `network_interfaces`,
  `network_config`,
  `certificates_list`, `cloud_credentials_list`, `alert_settings`,
  `reporting_utilisation`, `reporting_disk_io`, `reporting_space_trends`,
  `reporting_app_vm_usage`, `services_status`, `ha_status`,
  `system_health_report`, `fleet_compliance_report`, `fleet_health_rollup`.
  Mutating family, all of them two-phase plan/confirm and all
  `destructiveness: 'reversible'`: `snapshots_create`, `alerts_dismiss`,
  `alerts_restore`, `scheduled_task_set_enabled`, `cloudsync_run`,
  `automated_task_set_enabled`, `snapshot_clone`, `snapshot_task_run`,
  `snapshot_set_hold`, `vm_start`, `vm_stop`, `vm_restart`, `service_control` —
  `cloudsync_run`, `snapshot_task_run`, `vm_stop`, `vm_restart` and
  `service_control` the five that start a background job,
  which each watches for a bounded time and then reports on rather than waiting
  out. The three VM power tools are the catalog's only mutations over the older
  libvirt-backed `vm` stack, and between them they are what makes
  `destructiveness: 'reversible'` true in the strong sense for the first time
  here: the reversal of a start is a stop, and both are tools rather than calls
  a reader has to go elsewhere for. What each still owes its description is what
  the field cannot say — a forced `vm_stop` destroys the domain with whatever
  the guest had not written, and `vm_restart` hides two decisions its own API
  params do not mention, forcing after the shutdown timeout and overcommitting
  memory on the way back up, neither of them the caller's to make.
  `snapshot_clone` is the additive route
  back to a snapshot's data: it deletes nothing and modifies no dataset that
  exists, which is what lets the catalog decline the rollback that answers the
  same question destructively — though the clone it adds does pin its source
  snapshot, which cannot then be destroyed while that clone is there, and its
  description leads with that. `snapshot_set_hold` is the one mutation that
  prevents data loss rather than risking it: it places TrueNAS's hold on a
  snapshot, or removes the holds on one, and since nothing here deletes a named
  snapshot it is the only protection the catalog can offer the snapshot an
  operator would recover from. The two directions are not symmetric — placing a
  hold adds the `truenas` tag alone, removing one removes every hold tag on the
  snapshot, including any this catalog never reported — which its description
  and its plan both state.
  `service_control` starts, stops or restarts one of the system's services, and
  is the mutating half of what `services_status` reads. It is ONE tool over
  three verbs where the VM power tools are three, because the middleware offers
  one method — `service.control(verb, service)` — rather than three; `RELOAD`
  is its fourth verb and is deliberately not offered, since a reload leaves the
  service running and is neither a start, a stop nor a restart. A service
  already in the state the verb aims at is planned and called like any other,
  and reported as having been there already. Neither it nor anything else in
  this catalog changes whether a service starts at boot, which is the other
  half of what `services_status` reports and stays read-only. `destructiveness`
  is about a tool's own operation and not about the data that operation acts
  on: `cloudsync_run` starts a task whose own `transfer_mode` may delete data
  for good, `snapshot_task_run` starts a run that ends in a system-wide
  retention pass that destroys snapshots belonging to every periodic snapshot
  task and not only the one being run, `vm_stop` and `vm_restart` can
  destroy a running domain outright, and a `service_control` stop or restart
  disconnects every client the service was serving, which can leave a file half
  written on the far side — which each tool's description and plan
  state and this field does not.
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
