/**
 * @truenas/mcp-base — shared core for TrueNAS MCP.
 *
 * A plain TypeScript library with no environment assumptions. Adapters (the
 * standalone stdio server, the Connect browser bridge) inject credentials,
 * confirmation UX, and audit sinks through the exported interfaces.
 */

// ── Injected interfaces ──────────────────────────────────────────────────────
export {
  Role,
  roleSatisfies,
  fullAccessRoleMapper,
  noopAuditSink,
  consoleAuditSink,
} from '@/interfaces';
export type {
  SystemSpec,
  CredentialProvider,
  RoleMapper,
  AuditEvent,
  AuditSink,
  ContentByteReader,
  ContentFetchResponse,
  ContentFetcher,
  FileContentReader,
  FileTail,
} from '@/interfaces';

// ── Catalog ──────────────────────────────────────────────────────────────────
export { ToolCatalog, RESERVED_ARGS } from '@/catalog/catalog';
export type { AdvertisedTool } from '@/catalog/catalog';
export type {
  Tool,
  ReadOnlyTool,
  MutatingTool,
  ToolContext,
  SystemHandle,
  PlanStep,
  Destructiveness,
} from '@/catalog/tool';

// ── Registry ─────────────────────────────────────────────────────────────────
export {
  SystemRegistry,
  assertValidSystemName,
  connectSystems,
  defaultClientFactory,
} from '@/registry/system-registry';
export type {
  SystemSelector,
  ClientFactory,
  ContentReaderFactory,
  SystemTarget,
} from '@/registry/system-registry';

// ── Bounded file content ─────────────────────────────────────────────────────
export { createDownloadContentReader, FileContentError } from '@/content/file-content';
export type {
  DownloadContentReaderOptions,
  FileContentFailure,
} from '@/content/file-content';

// ── Execution ────────────────────────────────────────────────────────────────
export { ToolExecutor } from '@/execution/executor';
export type { Plan, ExecutionOutcome, ToolExecutorOptions } from '@/execution/executor';
export { fanOut } from '@/execution/fanout';
export type { SystemResult } from '@/execution/fanout';
export {
  ConfirmationService,
  ConfirmationError,
  planKey,
  stableStringify,
} from '@/execution/confirmation';
export type { ConfirmationGate, ConfirmationServiceOptions } from '@/execution/confirmation';

// ── Tools ────────────────────────────────────────────────────────────────────
export {
  createDefaultCatalog,
  systemInfo,
  updateStatus,
  rebootInfo,
  auditLogQuery,
  auditConfig,
  securityConfig,
  systemGeneralConfig,
  poolStatus,
  poolTopology,
  scrubHistory,
  bootPoolStatus,
  listDatasets,
  quotaReport,
  disksList,
  disksTemperature,
  appsList,
  appEngineStatus,
  appsUpdateSummary,
  vmsList,
  vmLogs,
  vmDevices,
  alertsList,
  alertSettings,
  snapshotsList,
  replicationStatus,
  snapshotTasksList,
  cloudsyncTasksList,
  automatedTasksList,
  tasksRecentRuns,
  sharesList,
  shareAccess,
  nfsClients,
  iscsiList,
  nvmeofList,
  usersList,
  directoryServicesStatus,
  networkInterfaces,
  networkConfig,
  certificatesList,
  cloudCredentialsList,
  reportingUtilisation,
  reportingDiskIo,
  reportingSpaceTrends,
  reportingAppVmUsage,
  servicesStatus,
  haStatus,
  systemHealthReport,
  fleetComplianceReport,
  fleetHealthRollup,
  createSnapshot,
  alertsDismiss,
  alertsRestore,
  scheduledTaskSetEnabled,
  cloudsyncRun,
} from '@/tools/index';
