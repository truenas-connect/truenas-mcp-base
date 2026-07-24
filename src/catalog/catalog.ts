import { Role, roleSatisfies } from '@/interfaces';
import { Destructiveness, Tool } from '@/catalog/tool';

/**
 * What `list` advertises: schema and metadata only, no callable handlers.
 * Handing adapters the handlers would invite calling them directly, bypassing
 * the executor's role and confirmation gates.
 */
export interface AdvertisedTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  mutating: boolean;
  destructiveness?: Destructiveness;
}

/** Executor-level argument names; tools may not declare properties with these names. */
export const RESERVED_ARGS = ['systems', 'confirmation_token'] as const;

const systemsSchema = {
  description:
    'Target system(s): a registry name, a list of names, or "all". ' +
    'May be omitted when exactly one system is registered.',
  oneOf: [
    { type: 'string' },
    { type: 'array', items: { type: 'string' } },
  ],
};

const confirmationTokenSchema = {
  type: 'string',
  description:
    'Confirmation token for a previously returned plan. Omit to get a plan; ' +
    'call again with the token after the user approves it.',
};

/**
 * The curated tool catalog. Hand-designed tools only — never auto-generated
 * wrappers over the middleware surface.
 */
export class ToolCatalog {
  private tools = new Map<string, Tool>();

  register(tool: Tool): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool "${tool.name}" is already registered`);
    }
    if (tool.mutating && tool.destructiveness === 'irreversible') {
      throw new Error(
        `Tool "${tool.name}" is irreversibly destructive; the destructive-action ` +
          'policy keeps such operations out of the catalog — direct users to the web UI',
      );
    }
    const properties = tool.inputSchema['properties'];
    for (const reserved of RESERVED_ARGS) {
      if (properties && typeof properties === 'object' && reserved in properties) {
        throw new Error(`Tool "${tool.name}" declares reserved argument "${reserved}"`);
      }
    }
    this.tools.set(tool.name, tool);
  }

  get(name: string): Tool {
    const tool = this.tools.get(name);
    if (!tool) {
      throw new Error(`Unknown tool "${name}"`);
    }
    return tool;
  }

  /**
   * Tools visible to a credential with the given role, with the reserved
   * executor arguments merged into each advertised schema. This is the list an
   * adapter converts 1:1 into MCP `Tool` objects — the LLM never sees a tool
   * the role cannot use (S3.2). The role is deliberately required: this is a
   * safety filter, and a permissive default would fail open.
   */
  list(role: Role): AdvertisedTool[] {
    return [...this.tools.values()]
      .filter((tool) => roleSatisfies(role, tool.requiredRole))
      .map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: this.advertisedSchema(tool),
        mutating: tool.mutating,
        ...(tool.mutating ? { destructiveness: tool.destructiveness } : {}),
      }));
  }

  private advertisedSchema(tool: Tool): Record<string, unknown> {
    const schema = tool.inputSchema;
    const properties = {
      ...(schema['properties'] as Record<string, unknown> | undefined),
      systems: systemsSchema,
      ...(tool.mutating ? { confirmation_token: confirmationTokenSchema } : {}),
    };
    return { ...schema, properties };
  }
}
