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
export type { SystemSelector, ClientFactory } from '@/registry/system-registry';

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
  poolStatus,
  listDatasets,
  createSnapshot,
} from '@/tools/index';
