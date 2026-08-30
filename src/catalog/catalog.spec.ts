import { describe, expect, it } from 'vitest';
import { ToolCatalog } from '@/catalog/catalog';
import { MutatingTool, ReadOnlyTool } from '@/catalog/tool';
import { Role } from '@/interfaces';

const readOnly = (name: string, overrides: Partial<ReadOnlyTool> = {}): ReadOnlyTool => ({
  name,
  description: 'test tool',
  inputSchema: { type: 'object', properties: {} },
  requiredRole: Role.ReadOnly,
  mutating: false,
  handler: async () => 'ok',
  ...overrides,
});

const mutating = (name: string, overrides: Partial<MutatingTool> = {}): MutatingTool => ({
  name,
  description: 'test tool',
  inputSchema: { type: 'object', properties: {} },
  requiredRole: Role.Full,
  mutating: true,
  destructiveness: 'reversible',
  plan: async () => [],
  execute: async () => 'done',
  ...overrides,
});

describe('ToolCatalog', () => {
  it('rejects duplicate registration', () => {
    const catalog = new ToolCatalog();
    catalog.register(readOnly('a_b'));
    expect(() => catalog.register(readOnly('a_b'))).toThrow(/already registered/);
  });

  it('rejects irreversibly destructive tools by policy, on the narrow claim', () => {
    const catalog = new ToolCatalog();
    const register = () =>
      catalog.register(mutating('storage_delete_pool', { destructiveness: 'irreversible' }));
    expect(register).toThrow(/destructive-action policy/);
    // The message says COMPOSES on purpose (#122): the check rejects a tool that
    // chooses what is destroyed, and says nothing about one that triggers an
    // operation an operator authored. Nothing was asserting that wording, so a
    // message widened back to "keeps such operations out of the catalog" — a
    // guarantee this check cannot make — would have passed.
    expect(register).toThrow(/composes an irreversibly destructive operation/);
  });

  it('registers the reversible value, and advertises it', () => {
    // The other half of the registration outcome, and the value every tool in
    // the catalog carries — including one that only TRIGGERS an operation
    // configured elsewhere, which is `cloudsync_run` and is the case #128
    // decided not to give a value of its own. What such a run does to the data
    // is in the tool's description and its plan, never in this field.
    const catalog = new ToolCatalog();
    const tool = mutating('cloudsync_run', { destructiveness: 'reversible' });
    catalog.register(tool);
    expect(catalog.get('cloudsync_run')).toBe(tool);
    expect(catalog.list(Role.Full)).toEqual([
      expect.objectContaining({ name: 'cloudsync_run', destructiveness: 'reversible' }),
    ]);
  });

  it('rejects tools declaring reserved executor arguments', () => {
    const catalog = new ToolCatalog();
    expect(() =>
      catalog.register(
        readOnly('a_b', {
          inputSchema: { type: 'object', properties: { systems: { type: 'string' } } },
        }),
      ),
    ).toThrow(/reserved argument "systems"/);
  });

  it('filters the advertised list by role', () => {
    const catalog = new ToolCatalog();
    catalog.register(readOnly('read_tool'));
    catalog.register(mutating('write_tool'));
    expect(catalog.list(Role.ReadOnly).map((t) => t.name)).toEqual(['read_tool']);
    expect(catalog.list(Role.Full).map((t) => t.name)).toEqual(['read_tool', 'write_tool']);
  });

  it('advertises the systems argument on every tool and confirmation_token on mutating ones', () => {
    const catalog = new ToolCatalog();
    catalog.register(readOnly('read_tool'));
    catalog.register(mutating('write_tool'));
    const [read, write] = catalog.list(Role.Full);
    const props = (tool: typeof read) =>
      Object.keys(tool.inputSchema['properties'] as Record<string, unknown>);
    expect(props(read)).toContain('systems');
    expect(props(read)).not.toContain('confirmation_token');
    expect(props(write)).toContain('systems');
    expect(props(write)).toContain('confirmation_token');
  });

  it('advertises schema and metadata only — never the callable handlers', () => {
    const catalog = new ToolCatalog();
    catalog.register(readOnly('read_tool'));
    catalog.register(mutating('write_tool'));
    const [read, write] = catalog.list(Role.Full);
    expect(Object.keys(read).sort()).toEqual(['description', 'inputSchema', 'mutating', 'name']);
    expect(Object.keys(write).sort()).toEqual([
      'description',
      'destructiveness',
      'inputSchema',
      'mutating',
      'name',
    ]);
  });

  it('does not mutate the registered tool schema when advertising', () => {
    const catalog = new ToolCatalog();
    const tool = readOnly('read_tool');
    catalog.register(tool);
    catalog.list(Role.Full);
    expect(tool.inputSchema['properties']).toEqual({});
  });
});
