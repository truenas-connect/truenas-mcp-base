import { createTrueNasClient, TrueNasApiClient } from '@truenas/api-client';
import { firstValueFrom } from 'rxjs';
import { SystemHandle } from '@/catalog/tool';
import { CredentialProvider, SystemSpec } from '@/interfaces';

/** How a tool call addresses systems: one name, a list of names, or `all`. */
export type SystemSelector = string | string[] | undefined;

/**
 * Holds 1..N named systems. Each entry owns its own client instance and
 * credentials — no shared state between systems (S3.6).
 */
/**
 * Rejects names the registry cannot accept. Shared by add() and the
 * connectSystems pre-connect validation so both enforce identical rules —
 * a name that passes pre-flight can never fail registration later.
 */
export function assertValidSystemName(name: string): void {
  if (name === 'all') {
    throw new Error('"all" is a reserved system name (the fan-out wildcard)');
  }
}

export class SystemRegistry {
  private systems = new Map<string, SystemHandle>();

  add(handle: SystemHandle): void {
    assertValidSystemName(handle.name);
    if (this.systems.has(handle.name)) {
      throw new Error(`System "${handle.name}" is already registered`);
    }
    this.systems.set(handle.name, handle);
  }

  get(name: string): SystemHandle {
    const handle = this.systems.get(name);
    if (!handle) {
      throw new Error(
        `Unknown system "${name}" — registered systems: ${this.names().join(', ') || '(none)'}`,
      );
    }
    return handle;
  }

  names(): string[] {
    return [...this.systems.keys()];
  }

  /**
   * Resolves a tool call's `systems` argument to registry entries. With a
   * single registered system the selector may be omitted; adapters that know
   * only one system is registered may drop `systems` from the advertised
   * schemas entirely. Accepts `unknown` because the value arrives
   * straight from the LLM; anything that is not a name, a list of names, or
   * `all` is rejected with a message the LLM can act on. Never resolves to
   * zero systems.
   */
  resolve(selector: unknown): SystemHandle[] {
    if (
      selector !== undefined &&
      typeof selector !== 'string' &&
      !(Array.isArray(selector) && selector.every((name) => typeof name === 'string'))
    ) {
      throw new Error(
        `Invalid "systems" value ${JSON.stringify(selector)} — ` +
          'must be a system name, a list of names, or "all"',
      );
    }
    if (this.systems.size === 0) {
      throw new Error('No systems are registered');
    }
    if (selector === undefined) {
      if (this.systems.size === 1) {
        return [...this.systems.values()];
      }
      throw new Error(
        `Multiple systems are registered (${this.names().join(', ')}); ` +
          'specify "systems" as a name, a list of names, or "all"',
      );
    }
    // The wildcard also matches inside the array form — LLMs reasonably emit
    // ["all"] since the schema advertises both shapes. "all" can never be a
    // real system name (add() reserves it).
    if (selector === 'all' || (Array.isArray(selector) && selector.includes('all'))) {
      return [...this.systems.values()];
    }
    // Dedupe so `["a", "a"]` cannot make a mutating tool execute twice
    // against the same system.
    const names = [...new Set(Array.isArray(selector) ? selector : [selector])];
    if (names.length === 0) {
      throw new Error('"systems" must name at least one system');
    }
    return names.map((name) => this.get(name));
  }

  /** Closes every client. One throwing close() never prevents closing the rest. */
  closeAll(): void {
    const errors: unknown[] = [];
    for (const { client } of this.systems.values()) {
      try {
        client.close();
      } catch (error) {
        errors.push(error);
      }
    }
    this.systems.clear();
    if (errors.length > 0) {
      throw new AggregateError(errors, `Failed to close ${errors.length} client(s)`);
    }
  }
}

/** Creates a connected, authenticated client for one spec. Injectable for tests. */
export type ClientFactory = (spec: SystemSpec) => Promise<TrueNasApiClient>;

export const defaultClientFactory: ClientFactory = async (spec) => {
  const client = await createTrueNasClient({
    uuid: spec.uuid ?? spec.name,
    hostnames: spec.hostnames,
    enabled: true,
    systemName: spec.name,
  });
  try {
    const response = await firstValueFrom(
      client.authenticator.loginWithApiKey({ username: spec.username, key: spec.apiKey }),
    );
    // The authenticator only throws on AUTH_ERR; EXPIRED / OTP_REQUIRED /
    // REDIRECT resolve normally and must not count as authenticated.
    if (String(response.response_type) !== 'SUCCESS') {
      throw new Error(`Authentication failed (${response.response_type})`);
    }
  } catch (error) {
    client.close();
    throw error;
  }
  return client;
};

/**
 * Populates a registry from a {@link CredentialProvider} — the standalone
 * server calls this at startup, the Connect adapter at session start.
 * Systems connect concurrently; one failure aborts the whole startup and
 * closes the clients that did connect.
 */
export async function connectSystems(
  registry: SystemRegistry,
  provider: CredentialProvider,
  clientFactory: ClientFactory = defaultClientFactory,
): Promise<void> {
  const specs = await provider.getSystems();
  // Both checks run before anything connects, so the add loop below cannot
  // throw and leave connected-but-unregistered clients leaking.
  const seen = new Set<string>(registry.names());
  for (const spec of specs) {
    assertValidSystemName(spec.name);
    if (seen.has(spec.name)) {
      throw new Error(`System name "${spec.name}" is duplicated or already registered`);
    }
    seen.add(spec.name);
  }
  const results = await Promise.allSettled(
    specs.map(async (spec) => ({ spec, client: await clientFactory(spec) })),
  );

  const failures = results.filter((r) => r.status === 'rejected');
  if (failures.length > 0) {
    for (const result of results) {
      if (result.status === 'fulfilled') {
        try {
          result.value.client.close();
        } catch {
          // Best-effort rollback: one throwing close must not leak the rest.
        }
      }
    }
    const reasons = results
      .map((result, i) =>
        result.status === 'rejected'
          ? `${specs[i].name}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`
          : undefined,
      )
      .filter(Boolean);
    throw new Error(`Failed to connect: ${reasons.join('; ')}`);
  }

  for (const result of results) {
    if (result.status === 'fulfilled') {
      registry.add({ name: result.value.spec.name, client: result.value.client });
    }
  }
}
