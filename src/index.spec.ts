import { describe, expect, it } from 'vitest';
import * as publicBarrel from '@/index';
import type { Tool } from '@/catalog/tool';
import { Role } from '@/interfaces';
import * as toolsBarrel from '@/tools/index';

/**
 * `src/index.ts` names every tool by hand, and an export there is a contract.
 * Nothing else asserts that the list is the catalog's: the exact-list assertion
 * in `src/tools/index.spec.ts` reads `createDefaultCatalog().list()`, which says
 * nothing about what the package exports, so a tool registered and left out of
 * the barrel passes typecheck, lint, the whole suite, coverage and build — and
 * fails only for a consumer, which is where #141 found it.
 *
 * How a tool export is told apart from the rest of the barrel: a tool is the
 * only non-null OBJECT here carrying a string `name`, a string `description`, an
 * object `inputSchema` and a boolean `mutating`. That last one is what the
 * non-tool objects lack — `Role`, `RESERVED_ARGS`, `fullAccessRoleMapper`,
 * `noopAuditSink` and `consoleAuditSink` are the barrel's other object-valued
 * exports, and none of them declares it. Everything else the barrel exports is a
 * function or a class, which `typeof value === 'object'` already excludes; a
 * class would otherwise slip past a `name` test, since every class has one.
 *
 * The predicate reads BOTH arms of `Tool` — it tests nothing a `ReadOnlyTool`
 * has that a `MutatingTool` does not — because a predicate that missed the
 * mutating arm would silently stop checking the mutating tools rather than fail.
 * A predicate that matched something that is not a tool fails loudly instead:
 * the second assertion below reports it by name as an unregistered tool.
 */
const isTool = (value: unknown): value is Tool => {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<Tool>;
  return (
    typeof candidate.name === 'string' &&
    typeof candidate.description === 'string' &&
    typeof candidate.inputSchema === 'object' &&
    candidate.inputSchema !== null &&
    typeof candidate.mutating === 'boolean'
  );
};

const toolExports = (module: object): [string, Tool][] =>
  Object.entries(module).filter((entry): entry is [string, Tool] => isTool(entry[1]));

/**
 * The tools the catalog actually registered, as the objects it holds. `list()`
 * advertises schema and metadata only, so it cannot answer an identity
 * question; `get()` returns the registered `Tool` itself, which is what every
 * assertion below compares against. Comparing names would pass on a barrel that
 * exported a different tool under the right name.
 */
const registeredTools = (): Tool[] => {
  const catalog = toolsBarrel.createDefaultCatalog();
  return catalog.list(Role.Full).map((advertised) => catalog.get(advertised.name));
};

describe('the public barrel', () => {
  it('exports every tool createDefaultCatalog registers', () => {
    const exported = new Set<unknown>(Object.values(publicBarrel));
    const missing = registeredTools()
      .filter((tool) => !exported.has(tool))
      .map((tool) => tool.name);

    expect(missing).toEqual([]);
  });

  it('exports no tool createDefaultCatalog does not register', () => {
    const registered = new Set<unknown>(registeredTools());
    const unregistered = toolExports(publicBarrel)
      .filter(([, tool]) => !registered.has(tool))
      .map(([exportName, tool]) => `${exportName} (${tool.name})`);

    expect(unregistered).toEqual([]);
  });

  /**
   * The two assertions above are identity checks against a catalog that holds no
   * record of which export NAME a tool belongs under — so a single wrong
   * re-export fails the first of them (the right tool is then exported nowhere)
   * and a pairwise SWAP of two export names fails neither. `src/tools/index.ts`
   * is where that mapping lives, and it is the module `src/index.ts` re-exports
   * from, so pinning the two together by name AND identity is what closes it.
   */
  it('binds each tool export name to the same tool src/tools/index.ts does', () => {
    const publicExports = new Map<string, unknown>(Object.entries(publicBarrel));
    const diverged = toolExports(toolsBarrel)
      .filter(([exportName, tool]) => publicExports.get(exportName) !== tool)
      .map(([exportName, tool]) => `${exportName} (${tool.name})`);

    expect(diverged).toEqual([]);
  });

  /**
   * The tool half of the barrel is pinned by the catalog above; the non-tool
   * half has no such source of truth, so it is pinned by hand. Sorted rather
   * than in the file's own order: the key order of a module namespace object is
   * a property of the module system rather than of `src/index.ts`, and pinning
   * it would assert something this repository does not decide.
   */
  it('still exports the non-tool half of its contract', () => {
    const nonTools = Object.entries(publicBarrel)
      .filter(([, value]) => !isTool(value))
      .map(([exportName]) => exportName);

    expect(nonTools.sort()).toEqual(
      [
        'ConfirmationError',
        'ConfirmationService',
        'FileContentError',
        'RESERVED_ARGS',
        'Role',
        'SystemRegistry',
        'ToolCatalog',
        'ToolExecutor',
        'assertValidSystemName',
        'connectSystems',
        'consoleAuditSink',
        'createDefaultCatalog',
        'createDownloadContentReader',
        'defaultClientFactory',
        'fanOut',
        'fullAccessRoleMapper',
        'noopAuditSink',
        'planKey',
        'roleSatisfies',
        'stableStringify',
      ].sort(),
    );
  });
});
