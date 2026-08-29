import { describe, expect, it } from 'vitest';
import { fakeSystem } from '@/testing/fake-systems';
import { replicationStatus } from '@/tools/index';

describe('replication_status', () => {
  /**
   * A replication task as `replication.query` reports one. `recursive`, `auto`,
   * `retention_policy`, `periodic_snapshot_tasks`, `has_encrypted_dataset_keys`
   * and `job` are here to be dropped: they are fields of the real payload the
   * tool does not name.
   */
  const task = (over: Record<string, unknown> = {}) => ({
    id: 1,
    name: 'nightly-to-backup',
    direction: 'PUSH',
    transport: 'SSH',
    enabled: true,
    source_datasets: ['tank/media'],
    target_dataset: 'backup/media',
    recursive: true,
    auto: true,
    retention_policy: 'SOURCE',
    periodic_snapshot_tasks: [],
    has_encrypted_dataset_keys: false,
    state: { state: 'FINISHED', datetime: { $date: 1756346400000 }, error: null },
    job: null,
    ...over,
  });

  const statuses = async (tasks: unknown[]): Promise<Record<string, unknown>[]> => {
    const { ctx } = fakeSystem({ ['replication.query']: tasks });
    return (await replicationStatus.handler(ctx, {})) as Record<string, unknown>[];
  };

  /** One task, differing only in the state record the system holds for it. */
  const forState = async (state: unknown): Promise<Record<string, unknown>> =>
    (await statuses([task({ state })]))[0];

  it('maps a task to its endpoints, transport and last run', async () => {
    expect(await statuses([task()])).toEqual([
      {
        id: 1,
        name: 'nightly-to-backup',
        direction: 'PUSH',
        transport: 'SSH',
        enabled: true,
        source_datasets: ['tank/media'],
        target_dataset: 'backup/media',
        state: 'FINISHED',
        finished_at: '2025-08-28T02:00:00.000Z',
        error: null,
      },
    ]);
  });

  it('surfaces no field a later release adds', async () => {
    const rows = await statuses([task({ future_field: 'added by a later TrueNAS release' })]);
    expect(Object.keys(rows[0])).toEqual([
      'id',
      'name',
      'direction',
      'transport',
      'enabled',
      'source_datasets',
      'target_dataset',
      'state',
      'finished_at',
      'error',
    ]);
  });

  it('asks for every task, with no filters and no options', async () => {
    const { ctx, query } = fakeSystem({ ['replication.query']: [task()] });
    await replicationStatus.handler(ctx, {});
    expect(query).toHaveBeenCalledWith('replication.query');
  });

  it('returns [] for a system with no replication tasks', async () => {
    expect(await statuses([])).toEqual([]);
  });

  it('marks a task that has never run rather than omitting it or failing it', async () => {
    // What the system holds for a task created and not yet run: pending, with
    // no time recorded against it.
    const row = await forState({ state: 'PENDING' });
    expect(row['state']).toBe('NEVER_RUN');
    expect(row['finished_at']).toBeNull();
    expect(row['error']).toBeNull();
  });

  it('reads a task pending again after running as PENDING, not as never run', async () => {
    // The recorded time is the evidence that something has happened to this
    // task before; it is not a finish time, so it is not reported as one.
    const row = await forState({ state: 'PENDING', datetime: { $date: 1756346400000 } });
    expect(row['state']).toBe('PENDING');
    expect(row['finished_at']).toBeNull();
  });

  it('reports a state it cannot read as null rather than as never run', async () => {
    // A task nothing can be said about must not read as one known to have
    // never replicated: that is a fact about the task, not about this tool.
    for (const unreadable of [undefined, null, 'FINISHED', 42, {}, { state: null }, { state: '' }]) {
      const row = await forState(unreadable);
      expect(row['state']).toBeNull();
      expect(row['finished_at']).toBeNull();
      expect(row['error']).toBeNull();
    }
  });

  it('distinguishes a running task from a finished one, and gives it no finish time', async () => {
    // The system records one time per task, and under RUNNING it is when the
    // current run started — reporting it as `finished_at` would name a real
    // timestamp as something it is not.
    const running = await forState({ state: 'RUNNING', datetime: { $date: 1756346400000 } });
    expect(running['state']).toBe('RUNNING');
    expect(running['finished_at']).toBeNull();
    const held = await forState({ state: 'HOLD', datetime: { $date: 1756346400000 } });
    expect(held['state']).toBe('HOLD');
    expect(held['finished_at']).toBeNull();
  });

  it('passes through a state a later release adds', async () => {
    const row = await forState({ state: 'SUSPENDED', datetime: { $date: 1756346400000 } });
    expect(row['state']).toBe('SUSPENDED');
    // Not one of the two states that describe an ended run, so no finish time.
    expect(row['finished_at']).toBeNull();
  });

  it('reports the finish time of a run that ended, in either shape the time arrives in', async () => {
    const enveloped = await forState({ state: 'ERROR', datetime: { $date: 1756346400000 } });
    expect(enveloped['state']).toBe('ERROR');
    expect(enveloped['finished_at']).toBe('2025-08-28T02:00:00.000Z');
    // The envelope only tags a number as a date; a bare one is the same instant.
    const bare = await forState({ state: 'FINISHED', datetime: 1756346400000 });
    expect(bare['finished_at']).toBe('2025-08-28T02:00:00.000Z');
  });

  it('reports a finish time it cannot read as null rather than as the epoch', async () => {
    const finished = async (datetime: unknown): Promise<unknown> =>
      (await forState({ state: 'FINISHED', datetime }))['finished_at'];
    expect(await finished('2025-08-28T02:00:00Z')).toBeNull();
    expect(await finished({ $date: '1756346400000' })).toBeNull();
    expect(await finished({})).toBeNull();
    expect(await finished(null)).toBeNull();
    expect(await finished(Number.NaN)).toBeNull();
    expect(await finished(Number.POSITIVE_INFINITY)).toBeNull();
    // Beyond what a Date can hold, where `toISOString` throws rather than
    // answering — one absurd row must not take the whole listing down.
    expect(await finished({ $date: 8.64e15 + 1 })).toBeNull();
    expect(await finished({ $date: -8.64e15 - 1 })).toBeNull();
    expect(await finished({ $date: 0 })).toBe('1970-01-01T00:00:00.000Z');
  });

  it('carries the error text of a failed run, and reads an empty one as none', async () => {
    const failed = await forState({
      state: 'ERROR',
      datetime: { $date: 1756346400000 },
      error: 'ssh connection refused',
    });
    expect(failed['error']).toBe('ssh connection refused');
    // An empty string names nothing a caller could act on; the ERROR state is
    // what says the run failed either way.
    for (const none of ['', null, undefined, 42, { message: 'nope' }]) {
      const row = await forState({ state: 'ERROR', error: none });
      expect(row['state']).toBe('ERROR');
      expect(row['error']).toBeNull();
    }
  });

  it('lists a disabled task, and reports a switch it cannot read as null', async () => {
    const [disabled] = await statuses([task({ enabled: false })]);
    expect(disabled['enabled']).toBe(false);
    // Not defaulted either way: a task whose switch is unreadable must not be
    // presented as definitely on or definitely off.
    const [unreported] = await statuses([task({ enabled: undefined })]);
    expect(unreported['enabled']).toBeNull();
  });

  it('reports the source datasets, keeping only the names among them', async () => {
    const sources = async (value: unknown): Promise<unknown> =>
      (await statuses([task({ source_datasets: value })]))[0]['source_datasets'];
    expect(await sources(['tank/media', 'tank/docs'])).toEqual(['tank/media', 'tank/docs']);
    expect(await sources(['tank/media', 7, null])).toEqual(['tank/media']);
    expect(await sources(undefined)).toEqual([]);
    expect(await sources('tank/media')).toEqual([]);
  });
});
