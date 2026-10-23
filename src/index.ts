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
  systemNtpStatus,
  upsConfig,
  poolStatus,
  poolTopology,
  scrubHistory,
  poolResilverConfig,
  poolScrubTasksList,
  bootPoolStatus,
  listDatasets,
  quotaReport,
  datasetSetQuota,
  datasetSetProperty,
  datasetCreate,
  datasetRename,
  datasetPermissions,
  systemDatasetConfig,
  diskIdentify,
  disksList,
  disksTemperature,
  appsList,
  appEngineStatus,
  appsUpdateSummary,
  vmsList,
  vmLogs,
  vmDevices,
  containerList,
  alertsList,
  alertSettings,
  snapshotsList,
  replicationStatus,
  replicationTopology,
  snapshotTasksList,
  cloudsyncTasksList,
  automatedTasksList,
  tasksRecentRuns,
  sharesList,
  shareAccess,
  shareSetEnabled,
  smbShareCreate,
  smbShareUpdate,
  nfsShareCreate,
  nfsShareUpdate,
  nfsClients,
  iscsiList,
  iscsiTargetCreate,
  iscsiTargetUpdate,
  nvmeofList,
  nvmeofSubsystemCreate,
  nvmeofSubsystemUpdate,
  fcList,
  usersList,
  userCreate,
  userSetLocked,
  directoryServicesStatus,
  privilegesList,
  networkInterfaces,
  networkConfig,
  certificatesList,
  certificateCsrCreate,
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
  alertClassSet,
  scheduledTaskSetEnabled,
  scheduledTaskSetSchedule,
  cloudsyncRun,
  automatedTaskSetEnabled,
  snapshotClone,
  snapshotTaskRun,
  snapshotSetHold,
  vmStart,
  vmStop,
  vmRestart,
  vmClone,
  serviceControl,
  containerStart,
  containerStop,
  containerRestart,
  poolScrubTaskCreate,
  poolScrubTaskUpdate,
  poolDeviceSetOnline,
} from '@/tools/index';
