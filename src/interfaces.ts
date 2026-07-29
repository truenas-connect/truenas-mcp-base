/**
 * Environment-specific concerns enter the core through the interfaces in this
 * file. The core itself makes no runtime assumptions — no filesystem, no
 * process, no DOM. Adapters (the standalone stdio server, the Connect browser
 * bridge) provide the implementations.
 */

/** How a system is reached and authenticated. Produced by a {@link CredentialProvider}. */
export interface SystemSpec {
  /** Registry name for the system — what the LLM uses to address it. */
  name: string;
  /** Hostnames to connect to — primary first, then fallbacks. */
  hostnames: string[];
  /** Username the API key belongs to (user-scoped keys only, per ER-172 A2.5). */
  username: string;
  /** TrueNAS API key. */
  apiKey: string;
  /** Optional stable UUID; defaults to the registry name. */
  uuid?: string;
}

/**
 * Source of system credentials. Standalone mode reads a local config file;
 * Connect mode reads the browser Keyring.
 */
export interface CredentialProvider {
  getSystems(): Promise<SystemSpec[]>;
}

/** Effective access level of a credential on one system, ordered weakest first. */
export enum Role {
  ReadOnly = 'read_only',
  Sharing = 'sharing',
  Full = 'full',
}

const roleRank: Record<Role, number> = {
  [Role.ReadOnly]: 0,
  [Role.Sharing]: 1,
  [Role.Full]: 2,
};

/** Whether a credential with role `have` may use a tool requiring role `need`. */
export function roleSatisfies(have: Role, need: Role): boolean {
  return roleRank[have] >= roleRank[need];
}

/**
 * Maps an authenticated session to a {@link Role} per system.
 *
 * The real implementation introspects the session's privileges after login
 * (architecture open question 4 — needs an API spike). The sketch ships only
 * {@link fullAccessRoleMapper}.
 *
 * The executor queries roleFor per system on every call. A role is a property
 * of the credential and does not change mid-session, so real implementations
 * should resolve it once at connect time and answer from cache — the
 * per-call query is deliberate in the core (cheap, and keeps the executor
 * stateless) but must not translate into per-call API round-trips.
 */
export interface RoleMapper {
  roleFor(systemName: string): Promise<Role>;
}

/** Prototype stub: every system is Full access. */
export const fullAccessRoleMapper: RoleMapper = {
  roleFor: () => Promise.resolve(Role.Full),
};

/** One tool execution, as reported to the {@link AuditSink} (ER-172 S3.3, V5.1). */
export interface AuditEvent {
  /** Milliseconds since epoch. */
  at: number;
  tool: string;
  /**
   * `plan` for phase-one of a mutating tool, `execute` for phase two, `read`
   * otherwise. `denied` records refused attempts — a role-denied mutating call
   * or a rejected confirmation token — which belong in the trail (S3.3).
   */
  phase: 'read' | 'plan' | 'execute' | 'denied';
  mutating: boolean;
  /** Tool arguments (reserved executor arguments stripped). */
  args: Record<string, unknown>;
  /** Per-system outcome: `ok` or the error message. */
  outcomes: { system: string; outcome: string }[];
}

export interface AuditSink {
  /**
   * May be async: durable sinks (DB, socket) can return a promise. Failures —
   * thrown or rejected — never alter tool-call control flow; the executor
   * routes them to its onAuditError handler instead. A sink error after a
   * mutating execute must not make an applied mutation look failed (the
   * caller would retry and double-apply).
   */
  record(event: AuditEvent): void | Promise<void>;
}

export const noopAuditSink: AuditSink = {
  record: () => undefined,
};

/** Development sink for the standalone sketch. */
export const consoleAuditSink: AuditSink = {
  record: (event) => {
    console.error(`[audit] ${JSON.stringify(event)}`);
  },
};
