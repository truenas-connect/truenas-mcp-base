import { vi } from 'vitest';
import { of, throwError } from 'rxjs';
import { SystemHandle, ToolContext } from '@/catalog/tool';

/**
 * A SystemHandle answering from a canned method→response map. Both seams are
 * stubbed from the same map: `call` for plain verbs, `query` for the client's
 * query helpers, which return the list directly rather than the union `call`
 * would. Tools pick whichever fits the verb, so a test asserts on whichever
 * spy that tool used.
 */
export function fakeSystem(responses: Partial<Record<string, unknown>>): {
  ctx: ToolContext;
  call: ReturnType<typeof vi.fn>;
  query: ReturnType<typeof vi.fn>;
} {
  const call = vi.fn((method: string) => of(responses[method]));
  const query = vi.fn((method: string) => of(responses[method]));
  const system = { name: 'nas', client: { api: { call, query } } } as unknown as SystemHandle;
  return { ctx: { system }, call, query };
}

/**
 * A SystemHandle whose methods answer independently, either with rows or by
 * failing — `fakeSystem` answers every method from one map and has no way to
 * make a call fail, which the tools that read several methods and return a
 * partial answer are largely about.
 *
 * Both seams are stubbed from the same two maps, as `fakeSystem` stubs both
 * from its one: a tool picks `call` or `query` per verb, so a test asserts on
 * whichever spy its tool used and names its failures under the same method
 * either way.
 */
export function failingSystem(
  rows: Partial<Record<string, unknown>>,
  failures: Partial<Record<string, unknown>> = {},
): { ctx: ToolContext; query: ReturnType<typeof vi.fn>; call: ReturnType<typeof vi.fn> } {
  const answer = (method: string) =>
    method in failures ? throwError(() => failures[method]) : of(rows[method]);
  const query = vi.fn(answer);
  const call = vi.fn(answer);
  const system = { name: 'nas', client: { api: { query, call } } } as unknown as SystemHandle;
  return { ctx: { system }, query, call };
}
