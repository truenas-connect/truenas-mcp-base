import { describe, expect, it } from 'vitest';
import { fakeSystem, failingSystem } from '@/testing/fake-systems';
import { replicationStatus, replicationTopology } from '@/tools/index';

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

describe('replication_topology', () => {
  /** The SSH private key a stored credential can hold, in the arm that holds one. */
  const PRIVATE_KEY = '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjE\n';

  /**
   * A stored SSH credential as `keychaincredential.query` reports one, and as a
   * replication task embeds one.
   *
   * `private_key` is a NUMBER on this arm — the id of the separate
   * `SSH_KEY_PAIR` credential that holds the key — and `remote_host_key`,
   * `username` and `connect_timeout` are here to be dropped: they are fields of
   * the real payload this tool does not name.
   */
  const credential = (over: Record<string, unknown> = {}) => ({
    id: 7,
    name: 'backup-node',
    type: 'SSH_CREDENTIALS',
    attributes: {
      host: 'backup.example.net',
      port: 2222,
      username: 'root',
      private_key: 3,
      remote_host_key: 'ssh-ed25519 AAAAC3Nza',
      connect_timeout: 10,
    },
    ...over,
  });

  /**
   * A replication task as `replication.query` reports one, carrying its
   * credential in full — the shape the pinned client declares.
   */
  const task = (over: Record<string, unknown> = {}) => ({
    id: 1,
    name: 'nightly-to-backup',
    direction: 'PUSH',
    transport: 'SSH',
    ssh_credentials: credential(),
    source_datasets: ['tank/media'],
    target_dataset: 'backup/media',
    recursive: true,
    auto: true,
    retention_policy: 'SOURCE',
    periodic_snapshot_tasks: [],
    has_encrypted_dataset_keys: false,
    state: { state: 'FINISHED', datetime: { $date: 1756346400000 } },
    job: null,
    ...over,
  });

  const answer = async (
    tasks: unknown[],
    credentials?: unknown,
  ): Promise<{ result: Record<string, unknown>; query: ReturnType<typeof fakeSystem>['query'] }> => {
    const { ctx, query } = fakeSystem({
      ['replication.query']: tasks,
      ['keychaincredential.query']: credentials,
    });
    const result = (await replicationTopology.handler(ctx, {})) as Record<string, unknown>;
    return { result, query };
  };

  const rows = async (tasks: unknown[], credentials?: unknown): Promise<Record<string, unknown>[]> =>
    (await answer(tasks, credentials)).result['tasks'] as Record<string, unknown>[];

  /** One task, differing only in what it says about its SSH credential. */
  const forCredential = async (
    ssh_credentials: unknown,
    credentials?: unknown,
  ): Promise<Record<string, unknown>> => (await rows([task({ ssh_credentials })], credentials))[0];

  it('names the peer from the credential the task carries', async () => {
    const { result, query } = await answer([task()]);
    expect(result).toEqual({
      credentials_unavailable: null,
      tasks: [
        {
          id: 1,
          name: 'nightly-to-backup',
          direction: 'PUSH',
          transport: 'SSH',
          source_datasets: ['tank/media'],
          target_dataset: 'backup/media',
          peer_status: 'NAMED',
          peer_host: 'backup.example.net',
          peer_port: 2222,
          credential_id: 7,
          credential_name: 'backup-node',
        },
      ],
    });
    // One call: the task row carried the whole credential, so there was
    // nothing to look up.
    expect(query).toHaveBeenCalledWith('replication.query');
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('surfaces no field a later release adds', async () => {
    const reported = await rows([
      task({
        future_field: 'added by a later TrueNAS release',
        ssh_credentials: credential({ future_field: 'added to a credential' }),
      }),
    ]);
    expect(Object.keys(reported[0])).toEqual([
      'id',
      'name',
      'direction',
      'transport',
      'source_datasets',
      'target_dataset',
      'peer_status',
      'peer_host',
      'peer_port',
      'credential_id',
      'credential_name',
    ]);
  });

  it('returns a clean empty answer for a system with no replication tasks', async () => {
    const { result, query } = await answer([]);
    expect(result).toEqual({ credentials_unavailable: null, tasks: [] });
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('reports a local task as local rather than as a failed peer lookup', async () => {
    const { result, query } = await answer([
      task({ transport: 'LOCAL', ssh_credentials: null, target_dataset: 'tank/copy' }),
    ]);
    const [local] = result['tasks'] as Record<string, unknown>[];
    expect(local['peer_status']).toBe('LOCAL');
    expect(local['peer_host']).toBeNull();
    expect(local['peer_port']).toBeNull();
    expect(local['credential_id']).toBeNull();
    expect(local['credential_name']).toBeNull();
    expect(result['credentials_unavailable']).toBeNull();
    // A local task needs no credential, so none is looked up for it.
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('does not read a transport it could not read as local', async () => {
    // Defaulting an unreadable transport to LOCAL would claim the task has no
    // peer, from a field that said nothing — and `local` is not `LOCAL`.
    for (const notLocal of [undefined, null, '', 42, 'local', 'SSH+NETCAT']) {
      const [row] = await rows([task({ transport: notLocal, ssh_credentials: null })]);
      expect(row['peer_status']).toBe('CREDENTIAL_NOT_REPORTED');
    }
    // The peer of a task that travels over netcat is still its SSH credential.
    const [netcat] = await rows([task({ transport: 'SSH+NETCAT' })]);
    expect(netcat['peer_status']).toBe('NAMED');
    expect(netcat['peer_host']).toBe('backup.example.net');
  });

  it('reports a task that names no credential it could read, rather than dropping it', async () => {
    for (const none of [undefined, null, 'backup-node', [], Number.NaN]) {
      const row = await forCredential(none);
      expect(row['peer_status']).toBe('CREDENTIAL_NOT_REPORTED');
      expect(row['peer_host']).toBeNull();
      expect(row['credential_id']).toBeNull();
      expect(row['credential_name']).toBeNull();
      // The task itself is still fully reported.
      expect(row['id']).toBe(1);
    }
  });

  it('looks the peer up where the task names its credential by id alone', async () => {
    const { result, query } = await answer([task({ ssh_credentials: 7 })], [credential()]);
    expect(result['tasks']).toEqual([
      expect.objectContaining({
        peer_status: 'NAMED',
        peer_host: 'backup.example.net',
        peer_port: 2222,
        credential_id: 7,
        credential_name: 'backup-node',
      }),
    ]);
    expect(result['credentials_unavailable']).toBeNull();
    expect(query).toHaveBeenCalledWith('keychaincredential.query');
  });

  it('reports a deleted credential as missing, keeping the task and the id', async () => {
    const row = await forCredential(7, [credential({ id: 9 })]);
    expect(row['peer_status']).toBe('CREDENTIAL_MISSING');
    expect(row['credential_id']).toBe(7);
    expect(row['credential_name']).toBeNull();
    expect(row['peer_host']).toBeNull();
    expect(row['peer_port']).toBeNull();
  });

  it('keeps a credential listing that failed separate from a credential that is gone', async () => {
    const { ctx } = failingSystem(
      { ['replication.query']: [task({ ssh_credentials: 7 })] },
      { ['keychaincredential.query']: new Error('connection reset') },
    );
    const result = (await replicationTopology.handler(ctx, {})) as Record<string, unknown>;
    expect(result['credentials_unavailable']).toBe('connection reset');
    const [row] = result['tasks'] as Record<string, unknown>[];
    expect(row['peer_status']).toBe('CREDENTIAL_UNREADABLE');
    expect(row['credential_id']).toBe(7);
    expect(row['credential_name']).toBeNull();
  });

  it('reads a credential listing that is not a list as unreadable', async () => {
    const { result } = await answer([task({ ssh_credentials: 7 })], { id: 7 });
    expect(result['credentials_unavailable']).toBe(
      'the system did not answer with a list of credentials',
    );
    const [row] = result['tasks'] as Record<string, unknown>[];
    expect(row['peer_status']).toBe('CREDENTIAL_UNREADABLE');
  });

  it('reports no reason where nothing needed looking up, and one where something did', async () => {
    // A read that never happened has no failure to report — the reason field
    // must not read as "the credentials could not be read" on a system whose
    // tasks all carried theirs.
    const { result } = await answer([task()], undefined);
    expect(result['credentials_unavailable']).toBeNull();
    const { result: looked } = await answer([task({ ssh_credentials: 7 })], undefined);
    expect(looked['credentials_unavailable']).toBe(
      'the system did not answer with a list of credentials',
    );
  });

  it('reports a credential that records no host it could read as host-not-reported', async () => {
    // The other arm of the credential's attributes union: a key pair carries a
    // key and no host at all.
    const keyPair = credential({
      name: 'replication-key',
      type: 'SSH_KEY_PAIR',
      attributes: { private_key: PRIVATE_KEY, public_key: 'ssh-ed25519 AAAAC3Nza' },
    });
    const row = await forCredential(keyPair);
    expect(row['peer_status']).toBe('HOST_NOT_REPORTED');
    expect(row['peer_host']).toBeNull();
    expect(row['peer_port']).toBeNull();
    // The credential was reached, so it is still identified.
    expect(row['credential_id']).toBe(7);
    expect(row['credential_name']).toBe('replication-key');
  });

  it('reports attributes it cannot read at all as host-not-reported', async () => {
    for (const attributes of [undefined, null, 'backup.example.net', ['backup.example.net']]) {
      const row = await forCredential(credential({ attributes }));
      expect(row['peer_status']).toBe('HOST_NOT_REPORTED');
      expect(row['peer_host']).toBeNull();
      expect(row['peer_port']).toBeNull();
    }
    // A record naming no host, or one this tool cannot read as a host.
    for (const host of [undefined, null, '', 42]) {
      const row = await forCredential(credential({ attributes: { host, port: 2222 } }));
      expect(row['peer_status']).toBe('HOST_NOT_REPORTED');
      expect(row['peer_host']).toBeNull();
      // The port is a fact the credential recorded; it is reported either way.
      expect(row['peer_port']).toBe(2222);
    }
  });

  it('reports a port only where the credential records one, and asserts no default', async () => {
    const ports = async (port: unknown): Promise<unknown> =>
      (await forCredential(credential({ attributes: { host: 'backup.example.net', port } })))[
        'peer_port'
      ];
    expect(await ports(2222)).toBe(2222);
    expect(await ports(22)).toBe(22);
    // Null is "the credential records no port", never "the port is 22".
    expect(await ports(undefined)).toBeNull();
    expect(await ports(null)).toBeNull();
    expect(await ports('2222')).toBeNull();
    expect(await ports(Number.NaN)).toBeNull();
  });

  it('identifies a credential whose own id it cannot read, without inventing one', async () => {
    const row = await forCredential(credential({ id: undefined }));
    expect(row['peer_status']).toBe('NAMED');
    expect(row['peer_host']).toBe('backup.example.net');
    expect(row['credential_id']).toBeNull();
    expect(row['credential_name']).toBe('backup-node');
  });

  it('never matches a task to a credential row whose id it could not read', async () => {
    // Such a row can never be the answer to a lookup by id, and keeping it
    // under a substitute key would name the wrong peer.
    const row = await forCredential(7, [
      'not a credential row',
      credential({ id: undefined }),
      credential({ id: '7' }),
    ]);
    expect(row['peer_status']).toBe('CREDENTIAL_MISSING');
    expect(row['peer_host']).toBeNull();
  });

  it('returns no key material under any input', async () => {
    // Both arms of the credential's attributes union, both reached: one
    // embedded in the task and one joined by id, each carrying a private key.
    const { result } = await answer(
      [
        task({
          id: 1,
          ssh_credentials: credential({
            attributes: {
              host: 'backup.example.net',
              port: 2222,
              private_key: PRIVATE_KEY,
              public_key: 'ssh-ed25519 AAAAC3Nza',
              remote_host_key: 'ssh-ed25519 AAAAC3NzaRemote',
              password: 'hunter2',
            },
          }),
        }),
        task({ id: 2, ssh_credentials: 9 }),
      ],
      [
        credential({
          id: 9,
          attributes: { host: 'offsite.example.net', private_key: PRIVATE_KEY },
        }),
      ],
    );
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('BEGIN OPENSSH PRIVATE KEY');
    expect(serialized).not.toContain('private_key');
    expect(serialized).not.toContain('public_key');
    expect(serialized).not.toContain('remote_host_key');
    expect(serialized).not.toContain('hunter2');
    // Reached, in both shapes: the hosts are reported and only the hosts.
    const reported = result['tasks'] as Record<string, unknown>[];
    expect(reported.map((row) => row['peer_host'])).toEqual([
      'backup.example.net',
      'offsite.example.net',
    ]);
  });

  it('refuses a source dataset list it could not read in full, rather than shortening it', async () => {
    const sources = async (value: unknown): Promise<unknown> =>
      (await rows([task({ source_datasets: value })]))[0]['source_datasets'];
    expect(await sources(['tank/media', 'tank/docs'])).toEqual(['tank/media', 'tank/docs']);
    // A list one name short would say that dataset is not replicated to this
    // peer, which is the claim this tool is asked to answer.
    expect(await sources(['tank/media', 7])).toBeNull();
    expect(await sources(['tank/media', ''])).toBeNull();
    expect(await sources(undefined)).toBeNull();
    expect(await sources('tank/media')).toBeNull();
    // An empty list is a different answer and is returned as itself.
    expect(await sources([])).toEqual([]);
  });

  it('reports a task field it could not read as null rather than omitting it', async () => {
    const [row] = await rows([
      task({ id: undefined, name: '', direction: null, target_dataset: 42, transport: undefined }),
    ]);
    expect(row).toEqual(
      expect.objectContaining({
        id: null,
        name: null,
        direction: null,
        transport: null,
        target_dataset: null,
      }),
    );
  });

  it('names the peer of a pull task the same way it names a push task', async () => {
    const [pull] = await rows([
      task({ direction: 'PULL', source_datasets: ['remote/media'], target_dataset: 'tank/media' }),
    ]);
    expect(pull['direction']).toBe('PULL');
    expect(pull['peer_host']).toBe('backup.example.net');
    expect(pull['source_datasets']).toEqual(['remote/media']);
  });

  it('resolves each task independently across the shapes and failures in one listing', async () => {
    const { result } = await answer(
      [
        task({ id: 1 }),
        task({ id: 2, ssh_credentials: 9 }),
        task({ id: 3, ssh_credentials: 99 }),
        task({ id: 4, transport: 'LOCAL', ssh_credentials: null }),
        task({ id: 5, ssh_credentials: null }),
      ],
      [credential({ id: 9, name: 'offsite', attributes: { host: 'offsite.example.net' } })],
    );
    const reported = result['tasks'] as Record<string, unknown>[];
    expect(reported.map((row) => [row['id'], row['peer_status'], row['peer_host']])).toEqual([
      [1, 'NAMED', 'backup.example.net'],
      [2, 'NAMED', 'offsite.example.net'],
      [3, 'CREDENTIAL_MISSING', null],
      [4, 'LOCAL', null],
      [5, 'CREDENTIAL_NOT_REPORTED', null],
    ]);
  });
});
