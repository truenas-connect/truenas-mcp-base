import { PlanStep, SystemHandle, Tool } from '@/catalog/tool';
import { ToolCatalog } from '@/catalog/catalog';
import { ConfirmationService, planKey } from '@/execution/confirmation';
import { fanOut, SystemResult } from '@/execution/fanout';
import { SystemRegistry } from '@/registry/system-registry';
import {
  AuditEvent,
  AuditSink,
  fullAccessRoleMapper,
  noopAuditSink,
  RoleMapper,
  roleSatisfies,
} from '@/interfaces';

/**
 * Phase-one output of a mutating tool: what would happen, per system, and the
 * key a confirmation token must be minted against (A2.3).
 */
export interface Plan {
  tool: string;
  args: Record<string, unknown>;
  systems: string[];
  /** Per-system inspection outcome — a system can fail to plan (V5.5). */
  steps: SystemResult<PlanStep[]>[];
}

export type ExecutionOutcome =
  | {
      type: 'PLAN';
      plan: Plan;
      /**
       * Canonical key binding tool + args + systems; what
       * {@link ConfirmationService.mint} takes on user approval. Kept outside
       * {@link Plan} so adapters can serialize the descriptive plan to the LLM
       * without leaking the binding string.
       */
      key: string;
      message: string;
    }
  | { type: 'RESULTS'; tool: string; results: SystemResult<unknown>[] };

export interface ToolExecutorOptions {
  catalog: ToolCatalog;
  registry: SystemRegistry;
  confirmations: ConfirmationService;
  audit?: AuditSink;
  roleMapper?: RoleMapper;
  /** Injectable clock for audit timestamps; defaults to Date.now. */
  now?: () => number;
  /**
   * Receives audit-sink failures (throw or rejection). Sink errors never
   * alter control flow — without this hook they are reported via
   * console.error so they are at least visible. Adapters with a durable
   * trail should supply their own handler.
   */
  onAuditError?: (error: unknown, event: AuditEvent) => void;
}

/**
 * Dispatches tool calls: resolves target systems, enforces roles and the
 * plan/confirm gate, fans out, and audits. Both deployment modes drive their
 * MCP `tools/call` handling through this one class.
 */
export class ToolExecutor {
  private readonly catalog: ToolCatalog;
  private readonly registry: SystemRegistry;
  private readonly confirmations: ConfirmationService;
  private readonly audit: AuditSink;
  private readonly roleMapper: RoleMapper;
  private readonly now: () => number;
  private readonly onAuditError: (error: unknown, event: AuditEvent) => void;

  constructor(options: ToolExecutorOptions) {
    this.catalog = options.catalog;
    this.registry = options.registry;
    this.confirmations = options.confirmations;
    this.audit = options.audit ?? noopAuditSink;
    this.roleMapper = options.roleMapper ?? fullAccessRoleMapper;
    this.now = options.now ?? (() => Date.now());
    this.onAuditError =
      options.onAuditError ??
      ((error, event) => {
        console.error(`Audit sink failed for ${event.tool}/${event.phase}:`, error);
      });
  }

  async execute(
    toolName: string,
    rawArgs: Record<string, unknown> = {},
  ): Promise<ExecutionOutcome> {
    // Pre-flight failures below (unknown tool, invalid selector) throw before
    // any audit record. TODO: route these to the AuditSink with a dedicated
    // event shape in the real implementation (S3.3); for the prototype only
    // role and confirmation refusals are audited.
    const tool = this.catalog.get(toolName);
    const { systems: selector, confirmation_token: token, ...rawToolArgs } = rawArgs;
    const targets = this.registry.resolve(selector);
    const { allowed, denied } = await this.partitionByRole(tool, targets);

    if (!tool.mutating) {
      // Read-only fan-out: a role-denied system is per-system data (V5.5),
      // alongside whatever the allowed systems return. The denials also get
      // their own audit event, so the trail distinguishes "the credential
      // lacked the role" from "the system errored" (S3.3).
      if (denied.length > 0) {
        this.record(tool, 'denied', rawToolArgs, denied);
      }
      const fanned = await fanOut(allowed, (system) => tool.handler({ system }, rawToolArgs));
      const byName = new Map([...fanned, ...denied].map((r) => [r.system, r]));
      const results = targets.map((t): SystemResult<unknown> => {
        const result = byName.get(t.name);
        if (!result) {
          // allowed ∪ denied always covers targets; if that invariant breaks,
          // fail loudly here instead of crashing later in record().
          throw new Error(`Internal error: no result for system "${t.name}"`);
        }
        return result;
      });
      if (fanned.length > 0) {
        this.record(tool, 'read', rawToolArgs, fanned);
      }
      return { type: 'RESULTS', tool: tool.name, results };
    }

    // Mutating: the role gate is all-or-nothing — the plan the user approves
    // binds the full target set, and executing on a silently reduced subset
    // would run something other than what was approved. (Execution itself can
    // still partially fail per system; that stays data, V5.5.) Authorization
    // runs before argument validation, so this event records the raw args —
    // they were never validated for an unauthorized caller.
    if (denied.length > 0) {
      this.record(tool, 'denied', rawToolArgs, denied);
      throw new Error(denied.map((d) => d.error.message).join('; '));
    }

    // Canonicalize before the key is computed, so a token minted for a plan
    // survives LLM argument reformatting (omitted vs explicit-default) on the
    // confirm call. plan/execute receive the same normalized args. A
    // validation throw here is a refused mutating attempt and belongs in the
    // audit trail like any other denial.
    let args: Record<string, unknown>;
    try {
      args = tool.normalizeArgs ? tool.normalizeArgs(rawToolArgs) : rawToolArgs;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.record(
        tool,
        'denied',
        rawToolArgs,
        targets.map((t) => ({
          system: t.name,
          status: 'ERROR' as const,
          error: { message, errname: null, errno: null },
        })),
      );
      throw error;
    }
    const key = planKey({ tool: tool.name, args, systems: targets.map((t) => t.name).sort() });

    // == catches null as well as undefined, and '' is treated the same way:
    // LLM providers emit unset optional parameters as explicit null or empty
    // strings, and that first call must yield a plan, not a confusing
    // "unknown token" rejection.
    if (token == null || token === '') {
      const steps = await fanOut(targets, (system) => tool.plan({ system }, args));
      this.record(tool, 'plan', args, steps);
      // If planning failed everywhere there is nothing meaningful to approve —
      // returning a confirmable PLAN would let the LLM mint a token for an
      // execution the core already knows cannot proceed as planned.
      if (steps.every((step) => step.status === 'ERROR')) {
        return { type: 'RESULTS', tool: tool.name, results: steps };
      }
      const planned = steps
        .filter((step) => step.status === 'SUCCESS')
        .map((step) => step.system);
      const failed = targets
        .map((t) => t.name)
        .filter((name) => !planned.includes(name));
      const plan: Plan = {
        tool: tool.name,
        args,
        systems: targets.map((t) => t.name),
        steps,
      };
      return {
        type: 'PLAN',
        plan,
        // "What you approved is what runs": the key binds only the
        // successfully planned systems. A confirm call that still targets a
        // failed-to-plan system produces a different key and is rejected, so
        // execute can never run where no approved plan step exists.
        key: planKey({ tool: tool.name, args, systems: [...planned].sort() }),
        message:
          'This is a plan — nothing has been executed. Present it to the user; ' +
          'after they approve, call the tool again with the confirmation_token.' +
          (failed.length > 0
            ? ` Planning failed on ${failed.join(', ')} — the token is only valid ` +
              `for the successfully planned systems; the confirm call must set ` +
              `"systems" to exactly [${planned.join(', ')}].`
            : ''),
      };
    }

    try {
      this.confirmations.consume(String(token), key);
    } catch (error) {
      // A bad token (forged, expired, reused, drifted) is exactly the kind of
      // attempt the audit trail must show.
      const message = error instanceof Error ? error.message : String(error);
      this.record(
        tool,
        'denied',
        args,
        targets.map((t) => ({
          system: t.name,
          status: 'ERROR' as const,
          error: { message, errname: null, errno: null },
        })),
      );
      throw error;
    }
    const results = await fanOut(targets, (system) => tool.execute({ system }, args));
    this.record(tool, 'execute', args, results);
    return { type: 'RESULTS', tool: tool.name, results };
  }

  /** Splits targets into role-satisfying systems and structured denials. */
  private async partitionByRole(
    tool: Tool,
    targets: SystemHandle[],
  ): Promise<{ allowed: SystemHandle[]; denied: (SystemResult<never> & { status: 'ERROR' })[] }> {
    // A failed role lookup denies that one system (fail-closed) instead of
    // rejecting the whole batch — partial failure stays data (V5.5).
    const checks = await Promise.all(
      targets.map(async (system) => {
        try {
          return { system, role: await this.roleMapper.roleFor(system.name) };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return { system, lookupError: `Role lookup failed for "${system.name}": ${message}` };
        }
      }),
    );
    const allowed: SystemHandle[] = [];
    const denied: (SystemResult<never> & { status: 'ERROR' })[] = [];
    for (const check of checks) {
      if (check.lookupError === undefined && roleSatisfies(check.role, tool.requiredRole)) {
        allowed.push(check.system);
      } else {
        denied.push({
          system: check.system.name,
          status: 'ERROR',
          error: {
            message:
              check.lookupError ??
              `Tool "${tool.name}" requires role "${tool.requiredRole}" but the ` +
                `credential for "${check.system.name}" has "${check.role}"`,
            errname: null,
            errno: null,
          },
        });
      }
    }
    return { allowed, denied };
  }

  /**
   * Emits an audit event. Sink failures are routed to onAuditError and never
   * propagate: after a mutating execute the mutation has already been applied,
   * and a sink throw surfacing as a tool error would invite a double-applying
   * retry.
   */
  private record(
    tool: Tool,
    phase: 'read' | 'plan' | 'execute' | 'denied',
    args: Record<string, unknown>,
    results: SystemResult<unknown>[],
  ): void {
    const event: AuditEvent = {
      at: this.now(),
      tool: tool.name,
      phase,
      mutating: tool.mutating,
      args,
      outcomes: results.map((r) => ({
        system: r.system,
        outcome: r.status === 'SUCCESS' ? 'ok' : r.error.message,
      })),
    };
    try {
      const result = this.audit.record(event);
      if (result && typeof result.then === 'function') {
        result.then(undefined, (error) => this.onAuditError(error, event));
      }
    } catch (error) {
      this.onAuditError(error, event);
    }
  }
}
