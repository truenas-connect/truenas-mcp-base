import { describe, expect, it, vi } from 'vitest';
import { of } from 'rxjs';
import { createTrueNasClient, TrueNasApiClient } from '@truenas/api-client';
import { SystemHandle } from '@/catalog/tool';
import { SystemSpec } from '@/interfaces';
import {
  connectSystems,
  defaultClientFactory,
  SystemRegistry,
} from '@/registry/system-registry';

vi.mock('@truenas/api-client', () => ({ createTrueNasClient: vi.fn() }));

const handle = (name: string): SystemHandle => ({
  name,
  client: { close: vi.fn() } as unknown as TrueNasApiClient,
});

const spec = (name: string): SystemSpec => ({
  name,
  hostnames: [`${name}.local`],
  username: 'admin',
  apiKey: 'key',
});

describe('SystemRegistry', () => {
  it('reserves "all" as a system name', () => {
    const registry = new SystemRegistry();
    expect(() => registry.add(handle('all'))).toThrow(/reserved system name/);
  });

  it('treats ["all"] like the "all" wildcard', () => {
    const registry = new SystemRegistry();
    registry.add(handle('a'));
    registry.add(handle('b'));
    expect(registry.resolve(['all']).map((s) => s.name)).toEqual(['a', 'b']);
    expect(registry.resolve(['a', 'all']).map((s) => s.name)).toEqual(['a', 'b']);
  });

  it('rejects duplicate names', () => {
    const registry = new SystemRegistry();
    registry.add(handle('a'));
    expect(() => registry.add(handle('a'))).toThrow(/already registered/);
  });

  it('defaults to the single system when the selector is omitted', () => {
    const registry = new SystemRegistry();
    registry.add(handle('a'));
    expect(registry.resolve(undefined).map((s) => s.name)).toEqual(['a']);
  });

  it('requires a selector when several systems are registered', () => {
    const registry = new SystemRegistry();
    registry.add(handle('a'));
    registry.add(handle('b'));
    expect(() => registry.resolve(undefined)).toThrow(/specify "systems"/);
  });

  it('resolves "all", a single name, and a list of names', () => {
    const registry = new SystemRegistry();
    registry.add(handle('a'));
    registry.add(handle('b'));
    expect(registry.resolve('all').map((s) => s.name)).toEqual(['a', 'b']);
    expect(registry.resolve('b').map((s) => s.name)).toEqual(['b']);
    expect(registry.resolve(['b', 'a']).map((s) => s.name)).toEqual(['b', 'a']);
  });

  it('dedupes repeated names so a system is only targeted once', () => {
    const registry = new SystemRegistry();
    registry.add(handle('a'));
    registry.add(handle('b'));
    expect(registry.resolve(['a', 'a', 'b']).map((s) => s.name)).toEqual(['a', 'b']);
  });

  it('names unknown systems in the error', () => {
    const registry = new SystemRegistry();
    registry.add(handle('a'));
    expect(() => registry.resolve('nope')).toThrow(/Unknown system "nope"/);
  });

  it('never resolves to zero systems', () => {
    const registry = new SystemRegistry();
    expect(() => registry.resolve('all')).toThrow(/No systems are registered/);
    expect(() => registry.resolve(undefined)).toThrow(/No systems are registered/);
  });

  it('rejects selectors that are not names, lists of names, or "all"', () => {
    const registry = new SystemRegistry();
    registry.add(handle('a'));
    expect(() => registry.resolve(42)).toThrow(/Invalid "systems" value 42/);
    expect(() => registry.resolve({ name: 'a' })).toThrow(/Invalid "systems"/);
    expect(() => registry.resolve(['a', 7])).toThrow(/Invalid "systems"/);
  });

  it('closes every client on closeAll', () => {
    const registry = new SystemRegistry();
    const a = handle('a');
    const b = handle('b');
    registry.add(a);
    registry.add(b);
    registry.closeAll();
    expect(a.client.close).toHaveBeenCalled();
    expect(b.client.close).toHaveBeenCalled();
    expect(registry.names()).toEqual([]);
  });

  it('closes remaining clients and clears even when a close throws', () => {
    const registry = new SystemRegistry();
    const a = handle('a');
    const b = handle('b');
    vi.mocked(a.client.close).mockImplementation(() => {
      throw new Error('socket already gone');
    });
    registry.add(a);
    registry.add(b);
    expect(() => registry.closeAll()).toThrow(AggregateError);
    expect(b.client.close).toHaveBeenCalled();
    expect(registry.names()).toEqual([]);
  });
});

describe('connectSystems', () => {
  it('registers every system from the provider', async () => {
    const registry = new SystemRegistry();
    await connectSystems(
      registry,
      { getSystems: async () => [spec('a'), spec('b')] },
      async () => ({ close: vi.fn() }) as unknown as TrueNasApiClient,
    );
    expect(registry.names()).toEqual(['a', 'b']);
  });

  it('gives each system its own client instance', async () => {
    const registry = new SystemRegistry();
    await connectSystems(
      registry,
      { getSystems: async () => [spec('a'), spec('b')] },
      async () => ({ close: vi.fn() }) as unknown as TrueNasApiClient,
    );
    expect(registry.get('a').client).not.toBe(registry.get('b').client);
  });

  it('rejects a reserved system name before connecting anything', async () => {
    const registry = new SystemRegistry();
    registry.add(handle('a'));
    const factory = vi.fn();
    await expect(
      connectSystems(
        registry,
        { getSystems: async () => [spec('b'), spec('all')] },
        factory as unknown as Parameters<typeof connectSystems>[2],
      ),
    ).rejects.toThrow(/reserved system name/);
    // Nothing connected, nothing leaked, registry untouched.
    expect(factory).not.toHaveBeenCalled();
    expect(registry.names()).toEqual(['a']);
  });

  it('rejects duplicate system names before connecting anything', async () => {
    const registry = new SystemRegistry();
    const factory = vi.fn();
    await expect(
      connectSystems(
        registry,
        { getSystems: async () => [spec('a'), spec('a')] },
        factory as unknown as Parameters<typeof connectSystems>[2],
      ),
    ).rejects.toThrow(/"a" is duplicated or already registered/);
    expect(factory).not.toHaveBeenCalled();
  });

  it('rejects names already registered from a prior call before connecting anything', async () => {
    const registry = new SystemRegistry();
    registry.add(handle('a'));
    const factory = vi.fn();
    await expect(
      connectSystems(
        registry,
        { getSystems: async () => [spec('b'), spec('a')] },
        factory as unknown as Parameters<typeof connectSystems>[2],
      ),
    ).rejects.toThrow(/"a" is duplicated or already registered/);
    expect(factory).not.toHaveBeenCalled();
    expect(registry.names()).toEqual(['a']);
  });

  it('aborts startup and closes connected clients when one system fails', async () => {
    const registry = new SystemRegistry();
    const connected = { close: vi.fn() } as unknown as TrueNasApiClient;
    await expect(
      connectSystems(
        registry,
        { getSystems: async () => [spec('good'), spec('bad')] },
        async (s) => {
          if (s.name === 'bad') {
            throw new Error('auth failed');
          }
          return connected;
        },
      ),
    ).rejects.toThrow(/bad: auth failed/);
    expect(connected.close).toHaveBeenCalled();
    expect(registry.names()).toEqual([]);
  });
});

describe('defaultClientFactory', () => {
  const fakeClient = (responseType: string) => ({
    authenticator: {
      loginWithApiKey: vi.fn(() => of({ response_type: responseType })),
    },
    close: vi.fn(),
  });

  it('resolves when the login response is SUCCESS', async () => {
    const client = fakeClient('SUCCESS');
    vi.mocked(createTrueNasClient).mockResolvedValue(client as unknown as TrueNasApiClient);
    await expect(defaultClientFactory(spec('a'))).resolves.toBe(client);
    expect(client.close).not.toHaveBeenCalled();
  });

  it('rejects and closes the client on non-SUCCESS responses the authenticator does not throw on', async () => {
    const client = fakeClient('EXPIRED');
    vi.mocked(createTrueNasClient).mockResolvedValue(client as unknown as TrueNasApiClient);
    await expect(defaultClientFactory(spec('a'))).rejects.toThrow(
      /Authentication failed \(EXPIRED\)/,
    );
    expect(client.close).toHaveBeenCalled();
  });
});
