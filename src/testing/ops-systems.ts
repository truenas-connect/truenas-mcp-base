import { vi } from 'vitest';
import { concat, EMPTY, NEVER, Observable, of, throwError } from 'rxjs';
import {
  TrueNasApiClientV2510,
  TrueNasApiClientV26,
  TrueNasApiClientV27,
} from '@truenas/api-client';
import type { ApiVersion, OperationMappings } from '@truenas/api-client';
import type { SystemHandle, ToolContext } from '@/catalog/tool';

/**
 * A `SystemHandle` whose `ops` is the CLIENT'S OWN version mapping, running over
 * a faked `api` seam.
 *
 * This is option 2 of #173's test-seam decision, and the reason it is a separate
 * file from `fake-systems.ts` rather than a mode of it: `fakeSystem` is imported
 * by every tool spec in the repository, and nothing about the `ops` seam belongs
 * in the blast radius of a file that wide. Nothing here is imported by a tool
 * that does not go through `ops`.
 *
 * WHY THE REAL MAPPING RUNS. `containers.ts` is written against
 * `Observable<Job | null>` and reads WHICH of the two arrived, so a spec that
 * faked `client.ops` would be asserting the tool against this repository's own
 * belief about what each version emits. Three of those beliefs are not obvious
 * and one is counter-intuitive: v26+ `containerStart` emits `null` and never a
 * job, v26+ `containerRestart` emits the stop job's updates and THEN a `null`,
 * and it buffers those updates through `toArray()` so nothing at all is emitted
 * until the stop job has finished. A hand-written fake gets to be wrong about
 * all three and still pass.
 *
 * THE CLIENT IS CLOSED BEFORE IT IS HANDED BACK, and that is not tidiness.
 * `TrueNasConnection`'s constructor subscribes a 20-second ping `interval`,
 * which is an active timer for the life of the object and is released only by
 * `close()`. Left running, every fixture a spec builds holds the vitest worker's
 * event loop open. Closing changes nothing about `ops`: the mappings read
 * `this.api`, which is the fake installed below, and `close()` only pushes to
 * the connection's own `closeConnection`.
 *
 * NO SOCKET IS EVER OPENED. The connection's lifecycle is a cold observable
 * gated on an `enabled` flag, and these clients are constructed with it false.
 */

/** The versions whose `ops` mapping this fixture can drive. */
export type OpsVersion = 'v25.10.0' | 'v26.0.0' | 'v27.0.0';

/**
 * One answer from the faked `api` seam.
 *
 * `hangs` is not `emits: []`: an operation that completes without emitting and
 * one that never completes at all are different things to a bounded watch, and
 * only the second reaches the bound.
 *
 * `completes: false` is the third of those and is what the v26 restart
 * composition needs — a job that has reported progress and not finished. Only
 * that shape shows the buffering: the same answer reaches `container_stop` as
 * progress and reaches `container_restart` as nothing at all.
 */
export type OpsAnswer =
  | { emits: unknown[]; completes?: boolean; thenFails?: unknown }
  | { fails: unknown }
  | { hangs: true };

/**
 * What each method answers, in order, keyed by the middleware method the
 * mapping dials.
 *
 * A queue rather than one answer because every mutating tool here reads the
 * container list before its call and again after it, and half of what those
 * results report is the two readings differing. A queue shorter than the number
 * of reads repeats its last entry, so a spec that does not care gives one.
 */
export type OpsAnswers = Partial<Record<string, OpsAnswer | OpsAnswer[]>>;

/** What `opsSystem` hands back: the context, and the three spies under `ops`. */
export interface OpsSystem {
  ctx: ToolContext;
  /** `api.query`, which `containerQuery` dials on every version. */
  query: ReturnType<typeof vi.fn>;
  /** `api.call`, which v26+ dials for the synchronous `container.start`. */
  call: ReturnType<typeof vi.fn>;
  /** `api.job`, which every other operation dials. */
  job: ReturnType<typeof vi.fn>;
}

/** The parsed version record the client is constructed with. */
function apiVersion(version: OpsVersion): ApiVersion {
  const [year, minor, patch] = version.slice(1).split('.');
  return {
    version,
    year: Number(year),
    minor: Number(minor),
    patch: Number(patch),
    websocketPath: `/api/${version}`,
  };
}

/** The observable one queued answer becomes. */
function answerOf(answer: OpsAnswer): Observable<unknown> {
  if ('fails' in answer) return throwError(() => answer.fails);
  if ('hangs' in answer) return NEVER;
  const emitted = answer.emits.length === 0 ? EMPTY : of(...answer.emits);
  if ('thenFails' in answer) {
    return concat(
      emitted,
      throwError(() => answer.thenFails),
    );
  }
  return answer.completes === false ? concat(emitted, NEVER) : emitted;
}

/**
 * A client of the version named, with the real `ops` mapping over a fake `api`.
 *
 * Unanswered methods reach `EMPTY`, which is a read that completed and said
 * nothing — never a hang, so a spec that forgets one fails rather than timing
 * out.
 */
export function opsSystem(version: OpsVersion, answers: OpsAnswers = {}): OpsSystem {
  const taken: Record<string, number> = {};
  const answer = (method: string): Observable<unknown> => {
    const queued = answers[method];
    if (queued === undefined) return EMPTY;
    const queue = Array.isArray(queued) ? queued : [queued];
    const index = Math.min(taken[method] ?? 0, queue.length - 1);
    taken[method] = (taken[method] ?? 0) + 1;
    return answerOf(queue[index]);
  };
  const query = vi.fn((method: string) => answer(method));
  const call = vi.fn((method: string) => answer(method));
  const job = vi.fn((method: string) => answer(method));

  const spec = apiVersion(version);
  const client =
    version === 'v25.10.0'
      ? new TrueNasApiClientV2510('test-uuid', ['nas.example'], spec, false, 'nas')
      : version === 'v26.0.0'
        ? new TrueNasApiClientV26('test-uuid', ['nas.example'], spec, false, 'nas')
        : new TrueNasApiClientV27('test-uuid', ['nas.example'], spec, false, 'nas');

  // `api` is `readonly` on the class, and the mappings read it at call time
  // rather than capturing it, so replacing it here is what puts the fake
  // underneath the real `ops`.
  Object.defineProperty(client, 'api', { value: { query, call, job }, writable: true });
  client.close();

  const system = { name: 'nas', client } as unknown as SystemHandle;
  return { ctx: { system }, query, call, job };
}

/**
 * The `ops` mapping alone, for the one thing a real client cannot express: a
 * system whose negotiated version this tool could not read.
 *
 * `container_list` reports the version because four of its fields are populated
 * on one version and absent on the other, so the null it answers when the
 * version is unreadable is a case with its own meaning and needs a fixture.
 */
export function opsSystemWithoutVersion(version: OpsVersion, answers: OpsAnswers = {}): OpsSystem {
  const built = opsSystem(version, answers);
  const client = built.ctx.system.client as unknown as { ops: OperationMappings };
  const system = { name: 'nas', client: { ops: client.ops } } as unknown as SystemHandle;
  return { ...built, ctx: { system } };
}
