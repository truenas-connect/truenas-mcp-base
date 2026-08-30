import type { DefaultApiDirectory, TrueNasApiClient } from '@truenas/api-client';
import { Role } from '@/interfaces';
import type { FileContentReader } from '@/interfaces';

/**
 * The API surface the tools are written against. `DefaultApiDirectory` is the
 * client's own default: the *oldest* supported TrueNAS version. That is the
 * conservative direction for a registry holding systems of differing versions
 * — against a newer server the types understate what is available, rather than
 * promising methods that are not there. Widen it only in step with a decision
 * about the minimum TrueNAS version this supports.
 */
export type ApiSurface = DefaultApiDirectory;

/** A named, connected, authenticated system from the registry. */
export interface SystemHandle {
  name: string;
  client: TrueNasApiClient<ApiSurface>;
  /**
   * Bounded file content, where the adapter wired one up. Optional because
   * reading content needs an HTTP fetch the core will not choose for itself
   * (see `ContentFetcher` in `@/interfaces`), so a registry built without one
   * has no reader to offer — a tool that needs content must say so when this
   * is absent rather than assume it is there.
   */
  files?: FileContentReader;
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
 * How hard a mutating tool's OWN operation is to undo — which is not the same
 * question as what that operation does to the data it acts on.
 *
 * `irreversible` exists only so the catalog can reject it: per the
 * destructive-action policy, a tool that COMPOSES an irreversibly destructive
 * operation is absent from the catalog by construction. That is narrower than
 * "nothing here can destroy data", and the difference is the paragraph below.
 * So the two values are not a scale with a safe end and a dangerous one; the
 * second is a rejection, and every tool that registers carries the first.
 *
 * What that leaves for a tool that TRIGGERS an operation someone else authored
 * is `reversible`, and the reason is the distinction above rather than a
 * loophole. `cloudsync_run` starts a cloud sync task whose own `transfer_mode`
 * may delete data for good; the mode, the paths and the direction were all
 * decided by whoever configured the task, and the system does the same thing
 * unattended at the next scheduled window. Such a tool moves the moment, not
 * the effect, and the operation it does author — the run — can be stopped. A
 * tool that composed a destruction of its own, choosing the paths or the mode,
 * is the case the policy is actually about and does not belong in the catalog
 * at all. **Ask which of those two a new mutating tool is** before reading this
 * field as a claim about the data.
 *
 * So an adapter deciding how loudly to warn cannot read this field alone: what
 * an operation does to the data is in the tool's `description`, which is where
 * such a tool is required to state it.
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
