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
  `pool_resilver_config`, `pool_scrub_tasks_list`, `boot_pool_status`,
  `storage_list_datasets`, `datasets_quota_report`, `dataset_permissions`,
  `system_dataset_config`,
  `disks_list`, `disks_temperature`, `apps_list`,
  `app_engine_status`, `apps_update_summary`,
  `vms_list`, `vm_logs`, `vm_devices`, `container_list`,
  `alerts_list`, `snapshots_list`,
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
  `alerts_restore`, `scheduled_task_set_enabled`,
  `scheduled_task_set_schedule`, `cloudsync_run`,
  `automated_task_set_enabled`, `snapshot_clone`, `snapshot_task_run`,
  `snapshot_set_hold`, `vm_start`, `vm_stop`, `vm_restart`, `vm_clone`,
  `service_control`, `container_start`, `container_stop`, `container_restart`,
  `pool_scrub_task_create`, `pool_scrub_task_update`, `share_set_enabled`,
  `smb_share_create`, `smb_share_update`, `nfs_share_create`,
  `nfs_share_update`, `iscsi_target_create`, `iscsi_target_update`,
  `nvmeof_subsystem_create`, `nvmeof_subsystem_update`, `user_create`,
  `user_set_locked`, `dataset_set_quota`, `pool_device_set_online`,
  `dataset_set_property`, `dataset_create`, `dataset_rename`, `disk_identify`,
  `certificate_csr_create`, `alert_class_set`, `app_upgrade`, `app_rollback`,
  `vm_create`, `vm_disk_image_import` —
  `cloudsync_run`, `snapshot_task_run`, `vm_stop`, `vm_restart`,
  `service_control`, `container_stop`, `container_restart`,
  `certificate_csr_create`, `app_upgrade`, `app_rollback` and
  `vm_disk_image_import` the eleven that start a background job,
  which each watches for a bounded time and then reports on rather than waiting
  out — and `container_start` the one whose answer depends on the version it is
  talking to, a job on TrueNAS 25.10 and a synchronous call on 26 and later,
  which its result says rather than flattening.
  The three VM power tools, `vm_clone` and `vm_create` are the catalog's only mutations
  over the older libvirt-backed `vm` stack, and the power tools between them are
  what makes
  `destructiveness: 'reversible'` true in the strong sense for the first time
  here: the reversal of a start is a stop, and both are tools rather than calls
  a reader has to go elsewhere for. What each still owes its description is what
  the field cannot say — a forced `vm_stop` destroys the domain with whatever
  the guest had not written, and `vm_restart` hides two decisions its own API
  params do not mention, forcing after the shutdown timeout and overcommitting
  memory on the way back up, neither of them the caller's to make.
  `vm_clone` copies a VM, its devices and the zvols behind its disks into a new
  machine, so it destroys nothing and still consumes pool space — its plan names
  the disks it read and what they come to, or says outright that it could not
  read them, which is not the same answer as a machine with no disks. A device
  it can neither read as a disk nor rule out as one makes that figure a floor
  rather than a total, and a `DISK` device that named no zvol is named as that
  rather than counted as one. It is
  `reversible` in the same narrow sense `snapshot_clone` is: nothing here
  deletes the machine it makes, or its zvols, and the description says so beside
  the field. Its method answers a bare boolean that does not name what it
  created, so the clone is identified by listing every VM before the call and
  again after it and taking the id that appeared — and where no name was given,
  the name the middleware derives is read back rather than predicted, since the
  rule it derives by is not on this API surface.
  `vm_create` makes a new machine with one disk on a new zvol, one NIC and an
  optional installer CDROM, and leaves it stopped: `autostart` and
  `ensure_display_device` are always sent as false. It is `vm.create` followed
  by one `vm.device.create` per device, and the plan names each call. Its plan
  fails on a zvol name that is taken, a parent dataset that is not there, a NIC
  interface the system does not list and an ISO path that does not stat, and
  states the zvol's size against the pool's free space. A device that fails
  after the machine is made is reported, with `complete` false, rather than
  thrown or rolled back, since nothing here deletes a VM or a zvol. The NIC's
  MAC is read back off the answer.
  `vm_disk_image_import` converts a qcow2, qed, raw, vdi, vhdx or vmdk image
  already on the system into a new zvol. The middleware converts only into a
  zvol that exists, so the tool makes it first with `pool.dataset.create` and
  then starts `vm.device.convert`, building `source` and `destination` itself.
  The caller gives the zvol's size, because the image's virtual size is not
  readable on this API surface; a zvol smaller than a raw image fails the
  plan, since there the file size is the virtual size. A conversion that fails after the zvol is made is reported with
  the zvol named, and the zvol is not deleted.
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
  `scheduled_task_set_schedule` changes when one of those six runs and sends
  nothing but the schedule — all five cron fields at once, never a partial
  one. Two consequences reach past "when": giving a replication task with no
  schedule of its own one changes what triggers it, and is not undoable from
  here; and a periodic snapshot task's schedule decides which existing
  snapshots its retention owns, so its plan reports what the middleware says
  the change does to them.
  `pool_scrub_task_create` and `pool_scrub_task_update` add a periodic scrub
  task to a data pool, named by the pool's name, and change one's schedule,
  threshold, description or enabled state; `pool_scrub_tasks_list` is where
  their ids come from, and is when a pool's next scrub is arranged where
  `storage_scrub_history` is when its last one ran. Schedules are sent as all
  five cron fields and stated in the plan exactly as sent, and `threshold`
  carries no unit because none is reported. Nothing here starts a scrub now or
  deletes a scrub task.
  `pool_device_set_online` takes one device in a data pool offline or brings it
  back, named by the pool's name and the `disk` `storage_pool_topology`
  reports. Taking a device offline is refused, at plan time and again when the
  call is made, wherever its vdev would be left unable to serve its data — a
  striped `data`, `special` or `dedup` device, the last ONLINE member of a
  mirror, a RAIDZ or dRAID member past its parity — and wherever that could not
  be read, or while a resilver is running on the pool; a `log`, `cache` or
  `spare` device is not refused. Its plan states the vdev's type and every
  member's state, and that bringing a device online does not repair it, saying
  whether a resilver follows. It does not replace or detach a
  device.
  `share_set_enabled` switches one SMB share or NFS export on or off, named by
  `protocol` and `id` together as `shares_list` reports them, and is the first
  mutating tool a `Sharing` credential reaches without full access. Disabling a
  share cuts off the clients connected to it, which its plan says; a share on a
  locked encrypted dataset serves nothing even when enabled, which its result
  reports as `locked`.
  `smb_share_create` makes one SMB share over a dataset's mountpoint or a
  directory inside one, always with the `DEFAULT_SHARE` purpose, and
  `smb_share_update` changes an existing one's name, path, comment, read-only,
  browsable or enabled setting. Neither touches a share's preset options or
  audit settings, and neither asks for any change to the dataset's ACL. The
  create plan names the dataset the path belongs to, every share already
  answering to the name in any letter case, and what the system's own pre-check
  said; the update plan states each value beside the one it replaces. Nothing
  here deletes an SMB share.
  `nfs_share_create` exports a dataset's mountpoint or a directory inside one
  over NFS, and `nfs_share_update` changes an existing export's path, comment,
  networks, hosts, read-only, identity mapping, security or enabled setting.
  Neither touches an export's aliases or snapshot directory, and neither asks
  for any change to the dataset's ACL. Both plans say in words which clients
  may mount the export — an empty `networks` beside an empty `hosts` is any
  client, not nobody — and what identity mapping applies; the create plan also
  names the dataset and every export already covering the same, a parent or a
  child path. Nothing here deletes an NFS export.
  `iscsi_target_create` makes one iSCSI target, always with mode `ISCSI`, and
  `iscsi_target_update` changes an existing one's name, alias, portal groups or
  authorised networks. Neither touches a target's mode or iSCSI parameters, and
  neither maps an extent, so a created target serves no storage — which its plan
  says. Every portal, initiator group and CHAP credential a group names is
  resolved when the plan is made and named in words, a CHAP credential by its
  tag and user only, never its secrets; `auth` is matched on the credential's
  tag rather than its id. Both plans say who may connect — a null initiator is
  any initiator, `NONE` is no CHAP. Nothing here deletes an iSCSI target.
  `nvmeof_subsystem_create` makes one NVMe-oF subsystem and
  `nvmeof_subsystem_update` changes an existing one's name, NQN or whether it
  admits any host. Neither touches a subsystem's tuning fields, and neither adds
  a namespace, allows a host or publishes on a port, so a created subsystem
  serves nothing — which its plan says. Where no NQN is given the system derives
  one, and the result reports it read back rather than predicted. Both plans say
  in words where any host reaching a published port may connect, and on a
  system without NVMe-oF both plans fail saying so. Nothing here deletes an
  NVMe-oF subsystem.
  `user_create` makes one local account with password login disabled and no
  password, in a primary group and any further groups that already exist,
  named and resolved to ids. It takes no password, sudo commands, uid or group
  creation, and SMB is always off for the account, since SMB authenticates with
  a password hash. A group that holds a privilege — read from
  `privileges_list`'s source — or that grants sudo commands is refused, at plan
  time and again when the account is created, because membership in either is
  administrative authority. Without an SSH key nobody can log in to the new
  account, which its plan says. Nothing here deletes a user.
  `user_set_locked` locks or unlocks one local account, named by the `id`
  `users_list` reports, and sends nothing but `locked`. Whether a lock revokes
  the account's API keys or ends its open sessions is not established, and its
  description and plan say so rather than promising either; it does neither
  itself. It refuses a directory, `builtin` or `immutable` account, and refuses
  to lock the account the catalog is itself signed in as. Its plan names the
  privileges the account's groups hold, since locking the last account holding
  one is a lockout.
  `dataset_set_quota` sets, changes or removes one dataset's `quota`, its
  `refquota`, or both, in bytes; `0` and null both remove a limit. It is the
  mutating half of `datasets_quota_report` and reads the limits the same way.
  Its plan states each limit as it is now and as it will be, beside the usage
  that limit caps. A limit below that usage fails the plan, because ZFS refuses
  one; a limit exactly at it is accepted, and the plan says writes will then
  fail. A volume is refused, since it has neither limit. It does not touch the quota
  alert thresholds, per-user or per-group quotas, reservations, or a volume's
  size.
  `dataset_set_property` sets one of `compression`, `atime`, `recordsize`,
  `snapdir`, `exec` and `readonly` on one dataset, or sets it back to
  inheriting. Those are the properties whose change loses no data and is undone
  by setting it back. `snapdir` can still expose data: anything but `DISABLED`
  leaves every snapshot's copy of the dataset readable under `.zfs/snapshot`,
  including through its shares, and the plan says so. `sync`, `deduplication`, `checksum`,
  `copies`, `acltype` and `aclmode` are deliberately not settable. A value is
  checked against the values the API declares for that property, and a
  `recordsize` against the system's own list of sizes. `recordsize` cannot be
  set to inherit, because the API does not say it accepts that. The plan states
  the current value and where it comes from. It says that `compression` and
  `recordsize` do not rewrite data already written, and that `readonly` on makes
  writes fail. The result reports the value and source before and after.
  `dataset_create` creates one filesystem dataset under a parent that must
  already exist; it never creates intermediate datasets, and refuses a name that
  exists, has a character ZFS does not accept, or is `ix-applications` or
  `.system`. Volumes are not created here. Encryption is inherited from the
  parent and no key or passphrase is taken; the plan says whether the new
  dataset will be encrypted, and under which encryption root. It can set
  `comments`, `compression`, `atime`, `recordsize`, a quota and a refquota, and
  a `share_type` of GENERIC, SMB or NFS, and the plan names each one sent. The
  result reports the new dataset through `storage_list_datasets`' fields. No
  tool here deletes a dataset, so undoing a create is a person's job.
  `dataset_rename` renames one dataset within its pool, children included,
  and refuses a pool's root dataset, the system dataset, another pool, a name
  that exists and a parent that does not. Its plan lists what
  `pool.dataset.attachments` reports refers to the dataset, by type and name,
  and does not claim those references will be updated. The result reports
  `renamed` from a read of both names after the call.
  `disk_identify` turns the locate light of the enclosure slot one disk sits in
  on or off. The slot is the one `enclosure2.query` lists the disk's device in,
  and a disk no slot lists fails the plan, as a system without a managed
  enclosure. The plan names the disk's serial, model and pool beside the
  enclosure and slot. The result reads the slot's locate state back where the
  slot reports one, and otherwise says no state was read.
  `certificate_csr_create` has the system generate a private key and a
  certificate signing request, and returns the CSR to send to a certificate
  authority. The key never leaves the system: no key, passphrase or certificate
  is taken, and the job's answer is read by named field so the key it carries
  is never returned. A name already in use fails the plan, and `key_length` and
  `ec_curve` are each accepted only beside the key type they describe. The plan
  states the subject and alternative names the request will carry. Its job is
  watched for a bounded time; where that ends first the CSR is not returned,
  and no tool here returns it later. Nothing here deletes a certificate.
  `alert_class_set` changes one alert class's severity level or notification
  policy, or removes the class's stored setting so it returns to its defaults.
  It is the mutating half of `alert_settings`' `class_overrides`. A class the
  system does not list fails the plan. The update takes the whole per-class
  map, so the call reads it immediately before writing and writes every other
  class back unchanged. The plan says that a change someone else makes to
  another class in between is overwritten, and says in words that `NEVER`
  sends the class nowhere. The result reads the class's setting back off the
  update's response. It does not change alert destinations.
  `app_upgrade` and `app_rollback` move one installed application to a named
  or latest catalog version, and back to a version the system lists among the
  ones it can roll back to. Both plans fail on an application the system does
  not list, and on an app engine reported as not running. The upgrade plan
  states the current and target versions and whether host paths are
  snapshotted, which they are by default. Neither takes `values`, and the
  rollback always sends `rollback_snapshot: false`, so it never restores the
  app's volume snapshot. A rollback restores the version and not the data an
  upgrade may have migrated, which both descriptions and plans say. The job's
  answer and the listing read after the watch are reported by named field, so
  the app's `config` is never returned. Nothing here installs, starts or stops
  an app.
  `container_list` and the three container power tools are the first family
  written against the client's `ops` layer rather than `api.call`, because every
  one of these operations changes SHAPE between TrueNAS versions and not just
  name — a query that moves method, a start that stops being a job, a restart
  that has no method at all on the newer versions and is composed from a stop
  and a start. What `ops` does not absorb is reported rather than hidden: the
  negotiated version is in every result and every plan, because two versions
  populate different fields of one container row and `force` reaches a different
  parameter on each. `container_delete` is deliberately absent — its `recursive`
  option destroys the container's dataset, its snapshots and clones of them
  wherever they live, which is the irreversible composition the catalog rejects
  at registration.
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
