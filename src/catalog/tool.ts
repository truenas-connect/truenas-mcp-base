import { TrueNasApiClient } from '@truenas/api-client';
import { Role } from '@/interfaces';

/** A named, connected, authenticated system from the registry. */
export interface SystemHandle {
  name: string;
  client: TrueNasApiClient;
}

/**
 * What a tool handler sees. Handlers are written single-system; the executor's
 * fan-out runs them once per target system (V5.5).
 */
export interface ToolContext {
  system: SystemHandle;
}

/**
 * One API call a mutating tool intends to make, as shown to the user in the
 * plan phase (A2.3).
 */
export interface PlanStep {
  /** TrueNAS API method, e.g. `pool.snapshot.create`. */
  method: string;
  /** Exact params the call will be made with. */
  params: unknown;
  /** One-line human description of the step. */
  description: string;
}

/**
 * How hard a mutating tool is to undo. `irreversible` exists only so the
 * catalog can reject it: per the destructive-action policy, irreversibly
 * destructive operations are absent from the catalog by construction.
 */
export type Destructiveness = 'reversible' | 'irreversible';

interface ToolBase {
  /**
   * Catalog name, `family_tool_name` (e.g. `storage_pool_status`). Underscores
   * only: the MCP spec permits dots, but LLM provider APIs restrict tool names
   * to `[a-zA-Z0-9_-]`, so dotted names only work if the host sanitizes them.
   */
  name: string;
  /** Natural-language description for the LLM. */
  description: string;
  /**
   * JSON Schema for the tool's own arguments. The executor-level arguments
   * (`systems`, `confirmation_token`) are reserved and injected into the
   * advertised schema by the catalog — do not declare them here.
   *
   * Arguments are recorded verbatim in the audit trail (S3.3), so tools must
   * not accept secrets as arguments. If a future tool genuinely needs one,
   * add a per-tool redaction hook first rather than weakening this rule.
   */
  inputSchema: Record<string, unknown>;
  /** Minimum role the credential needs for the tool to be advertised (S3.2). */
  requiredRole: Role;
}

/** A tool that only inspects state. Runs in a single phase. */
export interface ReadOnlyTool extends ToolBase {
  mutating: false;
  handler(ctx: ToolContext, args: Record<string, unknown>): Promise<unknown>;
}

/**
 * A tool that changes state. Two-phase (A2.3): `plan` runs read-only
 * inspection and returns the exact calls to be made; `execute` runs only after
 * the executor has validated a confirmation token minted from that plan.
 *
 * Contract: `execute` must be a pure function of (args, system) — the calls it
 * makes must be derivable from its arguments exactly as `plan` derived them.
 * The confirmation token binds tool + args + systems, not the plan steps, so
 * an `execute` that branches on state read at execution time weakens the
 * "what you approved is what runs" guarantee.
 */
export interface MutatingTool extends ToolBase {
  mutating: true;
  destructiveness: Destructiveness;
  /**
   * Optional argument canonicalization, applied by the executor before the
   * confirmation key is computed and before plan/execute run. LLM providers
   * reformat optional arguments between calls (omitted on one, explicit
   * default on the next); without normalization those two calls produce
   * different keys and a validly approved token is spuriously rejected.
   * Implementations should apply defaults and drop unknown keys, and may
   * throw on invalid arguments.
   */
  normalizeArgs?(args: Record<string, unknown>): Record<string, unknown>;
  plan(ctx: ToolContext, args: Record<string, unknown>): Promise<PlanStep[]>;
  execute(ctx: ToolContext, args: Record<string, unknown>): Promise<unknown>;
}

export type Tool = ReadOnlyTool | MutatingTool;
