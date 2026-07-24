/**
 * Confirmation tokens for the plan/confirm flow (A2.3).
 *
 * A token binds to the canonical encoding of `{tool, args, systems}` — exactly
 * what phase two will execute. If the LLM changes any argument between plan and
 * execution the key no longer matches and the token is rejected. Tokens are
 * single-use and expire.
 */

import type { Plan } from '@/execution/executor';

export class ConfirmationError extends Error {}

/** Deterministic JSON with sorted object keys, so the plan key is stable. */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    // undefined has no JSON encoding; JSON.stringify coerces it to null in
    // arrays and this canonical form must not be more ambiguous than JSON
    // ([undefined] joining to "[]" would collide with the empty array).
    return `[${value.map((v) => (v === undefined ? 'null' : stableStringify(v))).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * The canonical string a token is bound to. Deliberately not a hash: the key
 * never leaves the process, so there is no size constraint to justify a lossy
 * encoding — exact string comparison leaves nothing to collide.
 */
export function planKey(input: { tool: string; args: unknown; systems: string[] }): string {
  return stableStringify(input);
}

export interface ConfirmationServiceOptions {
  /** Token lifetime in ms. Default 5 minutes. */
  ttlMs?: number;
  /**
   * Maximum simultaneously pending tokens. Default 100 — far above any real
   * human-approval flow. When exceeded, the oldest pending token is evicted
   * (fails closed: its plan needs re-approval), bounding the map even if an
   * adapter mints faster than tokens expire.
   */
  maxPending?: number;
  /** Injectable clock for tests. */
  now?: () => number;
  /** Injectable token generator for tests. */
  randomId?: () => string;
}

/**
 * Mints and validates confirmation tokens. The mint side is driven by the
 * environment's {@link ConfirmationGate} — i.e. by an actual user approval in
 * the host UI — never by the LLM. The executor only consumes.
 *
 * Tokens are held in memory on this instance — not a durable store. A restart
 * or a different instance cannot confirm a previously minted plan; that fails
 * closed (the LLM is told to request a fresh plan and approval), which suits
 * the single-process/browser deployment modes.
 */
export class ConfirmationService {
  private readonly ttlMs: number;
  private readonly maxPending: number;
  private readonly now: () => number;
  private readonly randomId: () => string;
  private pending = new Map<string, { key: string; expiresAt: number }>();

  constructor(options: ConfirmationServiceOptions = {}) {
    this.ttlMs = options.ttlMs ?? 5 * 60 * 1000;
    this.maxPending = options.maxPending ?? 100;
    this.now = options.now ?? (() => Date.now());
    this.randomId = options.randomId ?? (() => globalThis.crypto.randomUUID());
  }

  /**
   * Mints a single-use token for a plan key.
   *
   * ADAPTER CONTRACT: this is not a general-purpose helper. It must be called
   * from exactly one place — the adapter's {@link ConfirmationGate}
   * implementation, after a real user approved the plan in the host UI. The
   * core returns plans but never orchestrates the gate, so this boundary is
   * the one part of the A2.3 guarantee the core cannot enforce structurally:
   * an adapter that mints anywhere else silently removes the human from the
   * loop.
   */
  mint(key: string): string {
    this.sweep();
    // Bound the map: evict oldest-first (Map preserves insertion order) if an
    // adapter somehow mints faster than tokens expire or get consumed.
    while (this.pending.size >= this.maxPending) {
      const oldest = this.pending.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.pending.delete(oldest);
    }
    const token = this.randomId();
    this.pending.set(token, { key, expiresAt: this.now() + this.ttlMs });
    return token;
  }

  /** Evicts expired tokens so abandoned approvals don't accumulate forever. */
  private sweep(): void {
    const now = this.now();
    for (const [token, entry] of this.pending) {
      if (now > entry.expiresAt) {
        this.pending.delete(token);
      }
    }
  }

  /**
   * Validates and consumes a token. Throws {@link ConfirmationError} if the
   * token is unknown, expired, already used, or minted for a different plan.
   */
  consume(token: string, key: string): void {
    // Sweep after the lookup, so an expired token still reports "expired"
    // rather than "unknown", while abandoned entries are reclaimed on every
    // consume as well as on every mint.
    try {
      const entry = this.pending.get(token);
      if (!entry) {
        throw new ConfirmationError(
          'Unknown confirmation token — request a new plan and approval',
        );
      }
      // Deliberately consumed before the key comparison: a mismatch is either an
      // attack or LLM argument drift, and burning the token caps it at one
      // attempt — the cost is that recovery requires a fresh plan and approval.
      this.pending.delete(token);
      if (this.now() > entry.expiresAt) {
        throw new ConfirmationError(
          'Confirmation token expired — request a new plan and approval',
        );
      }
      if (entry.key !== key) {
        throw new ConfirmationError(
          'Confirmation token does not match this tool call — the arguments or target ' +
            'systems changed after the plan was approved; request a new plan',
        );
      }
    } finally {
      this.sweep();
    }
  }
}

/**
 * Where user approval happens. Implemented by the environment: the standalone
 * server maps it onto the MCP host's elicitation/permission prompt, Connect
 * onto its consent UI. Implementations mint via {@link ConfirmationService}
 * using the plan's key (delivered alongside the plan, not inside it) and
 * return the token, or return null if the user declined.
 */
export interface ConfirmationGate {
  requestApproval(plan: Plan, key: string): Promise<string | null>;
}
