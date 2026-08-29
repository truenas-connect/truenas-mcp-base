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

/**
 * One chunk-at-a-time reader over a response body.
 *
 * Structurally what `ReadableStream.getReader()` returns, so an adapter over
 * `fetch` needs no wrapper beyond `response.body?.getReader() ?? null`. A
 * reader rather than an async iterable because `ReadableStream` is only
 * async-iterable in Node — browsers still require `getReader()`, and this
 * library runs in both.
 */
export interface ContentByteReader {
  /**
   * The next chunk, or `{ done: true }` at the end of the body. A chunk handed
   * out here belongs to the caller: a reader must not write into it again,
   * because the bytes are held as views until the whole window is assembled.
   */
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
  /**
   * Releases the underlying resource. Called once the byte bound has stopped
   * the read part-way through a body, so a bounded read does not leave the
   * rest of the file streaming.
   */
  cancel(): Promise<unknown>;
}

/** What a {@link ContentFetcher} answers. Headers are deliberately absent: see the fetcher. */
export interface ContentFetchResponse {
  /** HTTP status. Anything outside 200–299 is a failure. */
  status: number;
  /** The body, or null where the response carried none. */
  body: ContentByteReader | null;
}

/**
 * Performs one HTTP GET and hands back the body as a stream.
 *
 * Injected rather than defaulted to the global `fetch`: TrueNAS appliances
 * routinely present self-signed certificates, so TLS trust is a policy the
 * adapter holds and the core cannot choose (the README's own smoke test needs
 * `NODE_TLS_REJECT_UNAUTHORIZED=0`). The URL passed in is minted by the
 * middleware and carries a single-use download token in its query string —
 * an implementation must not log it.
 */
export type ContentFetcher = (url: string) => Promise<ContentFetchResponse>;

/** The last lines of one file on one system. */
export interface FileTail {
  /** The path that was read, echoed back. */
  path: string;
  /**
   * The lines, oldest first, at most the `maxLines` asked for. Never an error
   * and never a failure to read — those throw.
   *
   * Empty means no whole line was found in what was read, which is not the
   * same as a failure to read. With `truncated` false it is a file of no
   * content. With `truncated` true the window held no complete line — a line
   * longer than the reader's byte ceiling, or a file that shrank between being
   * measured and being fetched, among others.
   */
  lines: string[];
  /**
   * True when these lines are not the whole file: content was skipped before
   * them, the byte ceiling stopped the read, or the file held more lines than
   * `maxLines`.
   */
  truncated: boolean;
}

/**
 * Reads bounded file content from one system (route (a); see CLAUDE.md).
 *
 * The seam a tool sees is this reader and nothing else — no hostname, no
 * download URL, no credential — so a tool cannot put any of them into its
 * arguments or its result, where the audit trail records them verbatim (S3.3).
 */
export interface FileContentReader {
  /**
   * The last `maxLines` lines of `path`.
   *
   * Rejects with a `FileContentError` naming the path when the path cannot be
   * read at all; a file with no content resolves to an empty `lines` instead.
   */
  readTail(path: string, maxLines: number): Promise<FileTail>;
}

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
