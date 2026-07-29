import { SystemHandle } from '@/catalog/tool';

/** Structured failure for one system's slice of an operation (V5.3). */
export interface SystemError {
  /** Human-readable, LLM-interpretable message. Always present. */
  message: string;
  /**
   * TrueNAS error name (e.g. `EINVAL`) when the failure carried one. Currently
   * null for API failures: @truenas/api-client flattens JSON-RPC errors to a
   * plain message before they reach the core — populating this needs the
   * client to expose the structured error (upstream change).
   */
  errname: string | null;
  /** Numeric errno when the failure carried one. See {@link SystemError.errname}. */
  errno: number | null;
}

/**
 * Outcome of one system's slice of a multi-system operation. Partial failure
 * is a first-class result, not an exception (V5.5): `A: created, B: failed
 * (parent dataset missing)` comes back as two entries.
 */
export type SystemResult<T> =
  | { system: string; status: 'SUCCESS'; value: T }
  | { system: string; status: 'ERROR'; error: SystemError };

function toSystemError(error: unknown): SystemError {
  const message = error instanceof Error ? error.message : String(error);
  const source = (
    typeof error === 'object' && error !== null ? error : {}
  ) as Record<string, unknown>;
  const errname = source['errname'];
  const errno = source['errno'];
  return {
    message,
    errname: typeof errname === 'string' ? errname : null,
    errno: typeof errno === 'number' ? errno : null,
  };
}

/** Runs `fn` once per system, concurrently, capturing per-system failures. */
export async function fanOut<T>(
  systems: SystemHandle[],
  fn: (system: SystemHandle) => Promise<T>,
): Promise<SystemResult<T>[]> {
  return Promise.all(
    systems.map(async (system): Promise<SystemResult<T>> => {
      try {
        return { system: system.name, status: 'SUCCESS', value: await fn(system) };
      } catch (error) {
        return { system: system.name, status: 'ERROR', error: toSystemError(error) };
      }
    }),
  );
}
