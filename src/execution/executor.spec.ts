import { describe, expect, it, vi } from 'vitest';
import { TrueNasApiClient } from '@truenas/api-client';
import { ToolCatalog } from '@/catalog/catalog';
import { MutatingTool, ReadOnlyTool, SystemHandle } from '@/catalog/tool';
import { ConfirmationError, ConfirmationService, planKey } from '@/execution/confirmation';
import { ToolExecutor } from '@/execution/executor';
import { AuditEvent, Role } from '@/interfaces';
import { SystemRegistry } from '@/registry/system-registry';

function setup(options: { systems?: string[]; role?: Role; roleFor?: (system: string) => Role } = {}) {
  const registry = new SystemRegistry();
  for (const name of options.systems ?? ['a', 'b']) {
    registry.add({ name, client: {} as TrueNasApiClient } as SystemHandle);
  }

  const executeSpy = vi.fn(async ({ system }: { system: SystemHandle }) => ({
    created: `${system.name}-snap`,
  }));
  const mutatingTool: MutatingTool = {
    name: 'snap_create',
    description: 'test',
    inputSchema: { type: 'object', properties: {} },
    requiredRole: Role.Full,
    mutating: true,
    destructiveness: 'reversible',
    normalizeArgs: (args) => {
      if (typeof args['dataset'] !== 'string') {
        throw new Error('"dataset" is required');
      }
      return { dataset: args['dataset'], recursive: args['recursive'] === true };
    },
    plan: async ({ system }, args) => [
      {
        method: 'snap_create',
        params: args,
        description: `create on ${system.name}`,
      },
    ],
    execute: executeSpy,
  };
  const readTool: ReadOnlyTool = {
    name: 'pool_status',
    description: 'test',
    inputSchema: { type: 'object', properties: {} },
    requiredRole: Role.Sharing,
    mutating: false,
    handler: async ({ system }) => `${system.name}-healthy`,
  };

  const catalog = new ToolCatalog();
  catalog.register(mutatingTool);
  catalog.register(readTool);

  const confirmations = new ConfirmationService();
  const events: AuditEvent[] = [];
  const executor = new ToolExecutor({
    catalog,
    registry,
    confirmations,
    audit: {
      record: (e) => {
        events.push(e);
      },
    },
    now: () => 12345,
    ...(options.role !== undefined || options.roleFor
      ? {
          roleMapper: {
            roleFor: async (system: string) =>
              options.roleFor ? options.roleFor(system) : (options.role as Role),
          },
        }
      : {}),
  });
  return { executor, confirmations, events, executeSpy };
}

describe('ToolExecutor — read-only tools', () => {
  it('fans out across the selected systems', async () => {
    const { executor } = setup();
    const outcome = await executor.execute('pool_status', { systems: 'all' });
    expect(outcome).toEqual({
      type: 'RESULTS',
      tool: 'pool_status',
      results: [
        { system: 'a', status: 'SUCCESS', value: 'a-healthy' },
        { system: 'b', status: 'SUCCESS', value: 'b-healthy' },
      ],
    });
  });

  it('rejects tools above the credential role', async () => {
    const { executor } = setup({ role: Role.ReadOnly });
    await expect(executor.execute('snap_create', { systems: 'a' })).rejects.toThrow(
      /requires role "full"/,
    );
  });

  it('reports role-denied systems as per-system errors instead of failing the fan-out', async () => {
    const { executor } = setup({
      roleFor: (system) => (system === 'a' ? Role.Full : Role.ReadOnly),
    });
    const outcome = await executor.execute('pool_status', { systems: 'all' });
    expect(outcome).toEqual({
      type: 'RESULTS',
      tool: 'pool_status',
      results: [
        { system: 'a', status: 'SUCCESS', value: 'a-healthy' },
        {
          system: 'b',
          status: 'ERROR',
          error: {
            message:
              'Tool "pool_status" requires role "sharing" but the credential for "b" has "read_only"',
            errname: null,
            errno: null,
          },
        },
      ],
    });
  });

  it('a throwing role lookup denies that system without failing the batch', async () => {
    const { executor } = setup({
      roleFor: (system) => {
        if (system === 'b') {
          throw new Error('introspection timed out');
        }
        return Role.Full;
      },
    });
    const outcome = await executor.execute('pool_status', { systems: 'all' });
    expect(outcome).toEqual({
      type: 'RESULTS',
      tool: 'pool_status',
      results: [
        { system: 'a', status: 'SUCCESS', value: 'a-healthy' },
        {
          system: 'b',
          status: 'ERROR',
          error: {
            message: 'Role lookup failed for "b": introspection timed out',
            errname: null,
            errno: null,
          },
        },
      ],
    });
  });

  it('emits no read audit event when every target is role-denied', async () => {
    const { executor, events } = setup({ role: Role.ReadOnly });
    await executor.execute('pool_status', { systems: 'all' });
    expect(events.map((e) => e.phase)).toEqual(['denied']);
  });

  it('mutating tools stay all-or-nothing when any target is role-denied', async () => {
    const { executor, executeSpy } = setup({
      roleFor: (system) => (system === 'a' ? Role.Full : Role.ReadOnly),
    });
    await expect(
      executor.execute('snap_create', { systems: 'all', dataset: 'tank/x' }),
    ).rejects.toThrow(/credential for "b" has "read_only"/);
    expect(executeSpy).not.toHaveBeenCalled();
  });
});

describe('ToolExecutor — plan/confirm', () => {
  it('returns a plan, not results, when no token is supplied', async () => {
    const { executor, executeSpy } = setup();
    const outcome = await executor.execute('snap_create', {
      systems: ['a', 'b'],
      dataset: 'tank/x',
    });
    expect(outcome.type).toBe('PLAN');
    if (outcome.type !== 'PLAN') return;
    expect(outcome.plan.systems).toEqual(['a', 'b']);
    expect(outcome.plan.steps).toHaveLength(2);
    expect(outcome.key).toBe(
      planKey({
        tool: 'snap_create',
        args: { dataset: 'tank/x', recursive: false },
        systems: ['a', 'b'],
      }),
    );
    expect(executeSpy).not.toHaveBeenCalled();
  });

  it('executes with a token minted for the plan key', async () => {
    const { executor, confirmations, executeSpy } = setup();
    const outcome = await executor.execute('snap_create', {
      systems: 'a',
      dataset: 'tank/x',
    });
    if (outcome.type !== 'PLAN') throw new Error('expected plan');

    const token = confirmations.mint(outcome.key);
    const executed = await executor.execute('snap_create', {
      systems: 'a',
      dataset: 'tank/x',
      confirmation_token: token,
    });
    expect(executed).toEqual({
      type: 'RESULTS',
      tool: 'snap_create',
      results: [{ system: 'a', status: 'SUCCESS', value: { created: 'a-snap' } }],
    });
    expect(executeSpy).toHaveBeenCalledTimes(1);
  });

  it('accepts a token when the confirm call adds an explicit default-valued optional arg', async () => {
    const { executor, confirmations, executeSpy } = setup();
    // Plan omits `recursive`; the confirm call sends it explicitly as its
    // default. normalizeArgs makes both produce the same key.
    const outcome = await executor.execute('snap_create', {
      systems: 'a',
      dataset: 'tank/x',
    });
    if (outcome.type !== 'PLAN') throw new Error('expected plan');
    const token = confirmations.mint(outcome.key);

    const executed = await executor.execute('snap_create', {
      systems: 'a',
      dataset: 'tank/x',
      recursive: false,
      confirmation_token: token,
    });
    expect(executed.type).toBe('RESULTS');
    expect(executeSpy).toHaveBeenCalledTimes(1);
  });

  it('treats an explicit null token as absent and returns a plan', async () => {
    const { executor, executeSpy } = setup();
    const outcome = await executor.execute('snap_create', {
      systems: 'a',
      dataset: 'tank/x',
      confirmation_token: null,
    });
    expect(outcome.type).toBe('PLAN');
    expect(executeSpy).not.toHaveBeenCalled();
  });

  it('treats an empty-string token as absent and returns a plan', async () => {
    const { executor, executeSpy } = setup();
    const outcome = await executor.execute('snap_create', {
      systems: 'a',
      dataset: 'tank/x',
      confirmation_token: '',
    });
    expect(outcome.type).toBe('PLAN');
    expect(executeSpy).not.toHaveBeenCalled();
  });

  it('returns RESULTS instead of a confirmable plan when planning fails everywhere', async () => {
    const failingPlan: MutatingTool = {
      name: 'doomed_create',
      description: 'test',
      inputSchema: { type: 'object', properties: {} },
      requiredRole: Role.Full,
      mutating: true,
      destructiveness: 'reversible',
      plan: async () => {
        throw new Error('dataset missing');
      },
      execute: async () => 'never',
    };
    const registry = new SystemRegistry();
    registry.add({ name: 'a', client: {} as TrueNasApiClient } as SystemHandle);
    registry.add({ name: 'b', client: {} as TrueNasApiClient } as SystemHandle);
    const catalog = new ToolCatalog();
    catalog.register(failingPlan);
    const executor = new ToolExecutor({
      catalog,
      registry,
      confirmations: new ConfirmationService(),
    });

    const outcome = await executor.execute('doomed_create', { systems: 'all' });
    expect(outcome.type).toBe('RESULTS');
    if (outcome.type !== 'RESULTS') return;
    expect(outcome.results.every((r) => r.status === 'ERROR')).toBe(true);
  });

  it('still returns a plan when only some systems fail to plan', async () => {
    const halfFailing: MutatingTool = {
      name: 'half_create',
      description: 'test',
      inputSchema: { type: 'object', properties: {} },
      requiredRole: Role.Full,
      mutating: true,
      destructiveness: 'reversible',
      plan: async ({ system }) => {
        if (system.name === 'b') {
          throw new Error('dataset missing');
        }
        return [{ method: 'x', params: {}, description: 'x' }];
      },
      execute: async () => 'done',
    };
    const registry = new SystemRegistry();
    registry.add({ name: 'a', client: {} as TrueNasApiClient } as SystemHandle);
    registry.add({ name: 'b', client: {} as TrueNasApiClient } as SystemHandle);
    const catalog = new ToolCatalog();
    catalog.register(halfFailing);
    const executor = new ToolExecutor({
      catalog,
      registry,
      confirmations: new ConfirmationService(),
    });

    const outcome = await executor.execute('half_create', { systems: 'all' });
    expect(outcome.type).toBe('PLAN');
    if (outcome.type !== 'PLAN') return;
    expect(outcome.message).toMatch(/Planning failed on b/);

    const confirmations2 = new ConfirmationService();
    const executor2 = new ToolExecutor({ catalog, registry, confirmations: confirmations2 });
    const outcome2 = await executor2.execute('half_create', { systems: 'all' });
    if (outcome2.type !== 'PLAN') throw new Error('expected plan');
    const token = confirmations2.mint(outcome2.key);

    // Confirming with the full target set — including the failed-to-plan
    // system — must be rejected: the token binds only the planned subset.
    await expect(
      executor2.execute('half_create', { systems: 'all', confirmation_token: token }),
    ).rejects.toThrow(/does not match/);

    // Confirming with exactly the planned subset succeeds.
    const outcome3 = await executor2.execute('half_create', { systems: ['a'] });
    if (outcome3.type !== 'PLAN') throw new Error('expected plan');
    const token3 = confirmations2.mint(outcome3.key);
    const executed = await executor2.execute('half_create', {
      systems: ['a'],
      confirmation_token: token3,
    });
    expect(executed.type).toBe('RESULTS');
  });

  it('a throwing audit sink never alters the tool-call outcome', async () => {
    const registry = new SystemRegistry();
    registry.add({ name: 'a', client: {} as TrueNasApiClient } as SystemHandle);
    const catalog = new ToolCatalog();
    catalog.register({
      name: 'ok_read',
      description: 'test',
      inputSchema: { type: 'object', properties: {} },
      requiredRole: Role.ReadOnly,
      mutating: false,
      handler: async () => 'fine',
    });
    const sinkErrors: unknown[] = [];
    const executor = new ToolExecutor({
      catalog,
      registry,
      confirmations: new ConfirmationService(),
      audit: {
        record: () => {
          throw new Error('audit db down');
        },
      },
      onAuditError: (error) => sinkErrors.push(error),
    });

    const outcome = await executor.execute('ok_read');
    expect(outcome.type).toBe('RESULTS');
    expect(sinkErrors).toHaveLength(1);
  });

  it('a rejecting async audit sink routes to onAuditError', async () => {
    const registry = new SystemRegistry();
    registry.add({ name: 'a', client: {} as TrueNasApiClient } as SystemHandle);
    const catalog = new ToolCatalog();
    catalog.register({
      name: 'ok_read',
      description: 'test',
      inputSchema: { type: 'object', properties: {} },
      requiredRole: Role.ReadOnly,
      mutating: false,
      handler: async () => 'fine',
    });
    const sinkErrors: unknown[] = [];
    const executor = new ToolExecutor({
      catalog,
      registry,
      confirmations: new ConfirmationService(),
      audit: { record: async () => Promise.reject(new Error('flush failed')) },
      onAuditError: (error) => sinkErrors.push(error),
    });

    const outcome = await executor.execute('ok_read');
    expect(outcome.type).toBe('RESULTS');
    await new Promise((resolve) => setImmediate(resolve));
    expect(sinkErrors).toHaveLength(1);
  });

  it('never executes with an unknown token', async () => {
    const { executor, executeSpy } = setup();
    await expect(
      executor.execute('snap_create', {
        systems: 'a',
        dataset: 'tank/x',
        confirmation_token: 'forged',
      }),
    ).rejects.toThrow(ConfirmationError);
    expect(executeSpy).not.toHaveBeenCalled();
  });

  it('rejects a token when the arguments drift after approval', async () => {
    const { executor, confirmations, executeSpy } = setup();
    const outcome = await executor.execute('snap_create', {
      systems: 'a',
      dataset: 'tank/x',
    });
    if (outcome.type !== 'PLAN') throw new Error('expected plan');
    const token = confirmations.mint(outcome.key);

    await expect(
      executor.execute('snap_create', {
        systems: 'a',
        dataset: 'tank/OTHER',
        confirmation_token: token,
      }),
    ).rejects.toThrow(/does not match/);
    expect(executeSpy).not.toHaveBeenCalled();
  });

  it('rejects a token when the target systems drift after approval', async () => {
    const { executor, confirmations, executeSpy } = setup();
    const outcome = await executor.execute('snap_create', {
      systems: 'a',
      dataset: 'tank/x',
    });
    if (outcome.type !== 'PLAN') throw new Error('expected plan');
    const token = confirmations.mint(outcome.key);

    await expect(
      executor.execute('snap_create', {
        systems: ['a', 'b'],
        dataset: 'tank/x',
        confirmation_token: token,
      }),
    ).rejects.toThrow(/does not match/);
    expect(executeSpy).not.toHaveBeenCalled();
  });

  it('tokens are single-use', async () => {
    const { executor, confirmations, executeSpy } = setup();
    const outcome = await executor.execute('snap_create', {
      systems: 'a',
      dataset: 'tank/x',
    });
    if (outcome.type !== 'PLAN') throw new Error('expected plan');
    const token = confirmations.mint(outcome.key);
    const args = { systems: 'a', dataset: 'tank/x', confirmation_token: token };

    await executor.execute('snap_create', args);
    await expect(executor.execute('snap_create', args)).rejects.toThrow(ConfirmationError);
    expect(executeSpy).toHaveBeenCalledTimes(1);
  });
});

describe('ToolExecutor — audit', () => {
  it('records read, plan, and execute phases with per-system outcomes', async () => {
    const { executor, confirmations, events } = setup();
    await executor.execute('pool_status', { systems: 'a' });
    const outcome = await executor.execute('snap_create', { systems: 'a', dataset: 'tank/x' });
    if (outcome.type !== 'PLAN') throw new Error('expected plan');
    const token = confirmations.mint(outcome.key);
    await executor.execute('snap_create', {
      systems: 'a',
      dataset: 'tank/x',
      confirmation_token: token,
    });

    expect(events.map((e) => e.phase)).toEqual(['read', 'plan', 'execute']);
    // Timestamps come from the injected clock, not ambient Date.now().
    expect(events.every((e) => e.at === 12345)).toBe(true);
    expect(events[2].outcomes).toEqual([{ system: 'a', outcome: 'ok' }]);
    // Reserved executor arguments never appear in the audit trail as tool
    // args; mutating phases record the normalized args — what actually ran.
    expect(events[2].args).toEqual({ dataset: 'tank/x', recursive: false });
  });

  it('records read-path role denials as a denied event, distinct from the read event', async () => {
    const { executor, events } = setup({
      roleFor: (system) => (system === 'a' ? Role.Full : Role.ReadOnly),
    });
    await executor.execute('pool_status', { systems: 'all' });

    expect(events.map((e) => e.phase)).toEqual(['denied', 'read']);
    expect(events[0].outcomes).toEqual([
      { system: 'b', outcome: expect.stringMatching(/requires role "sharing"/) },
    ]);
    // The read event covers only the systems that actually executed.
    expect(events[1].outcomes).toEqual([{ system: 'a', outcome: 'ok' }]);
  });

  it('records a denied event when mutating-tool argument validation fails', async () => {
    const { executor, events, executeSpy } = setup();
    await expect(executor.execute('snap_create', { systems: 'a' })).rejects.toThrow(
      /"dataset" is required/,
    );

    expect(events).toHaveLength(1);
    expect(events[0].phase).toBe('denied');
    expect(events[0].outcomes).toEqual([
      { system: 'a', outcome: expect.stringMatching(/"dataset" is required/) },
    ]);
    expect(executeSpy).not.toHaveBeenCalled();
  });

  it('records a denied event when a confirmation token is rejected', async () => {
    const { executor, events } = setup();
    await expect(
      executor.execute('snap_create', {
        systems: 'a',
        dataset: 'tank/x',
        confirmation_token: 'forged',
      }),
    ).rejects.toThrow(ConfirmationError);

    expect(events).toHaveLength(1);
    expect(events[0].phase).toBe('denied');
    expect(events[0].tool).toBe('snap_create');
    expect(events[0].outcomes).toEqual([
      { system: 'a', outcome: expect.stringMatching(/unknown confirmation token/i) },
    ]);
  });

  it('records a denied event when a mutating call is role-denied', async () => {
    const { executor, events } = setup({
      roleFor: (system) => (system === 'a' ? Role.Full : Role.ReadOnly),
    });
    await expect(
      executor.execute('snap_create', { systems: 'all', dataset: 'tank/x' }),
    ).rejects.toThrow(/credential for "b"/);

    expect(events).toHaveLength(1);
    expect(events[0].phase).toBe('denied');
    expect(events[0].outcomes).toEqual([
      { system: 'b', outcome: expect.stringMatching(/requires role "full"/) },
    ]);
  });
});
