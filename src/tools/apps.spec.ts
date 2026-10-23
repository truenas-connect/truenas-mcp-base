import { describe, expect, it, vi } from 'vitest';
import { concat, NEVER, Observable, from, of, throwError } from 'rxjs';
import { Role } from '@/interfaces';
import { SystemHandle, ToolContext } from '@/catalog/tool';
import { failingSystem, fakeSystem } from '@/testing/fake-systems';
import { appEngineStatus, appRollback, appsList, appsUpdateSummary, appUpgrade } from '@/tools/index';

describe('apps_list', () => {
  // Every property the middleware's app row carries, so the assertions below
  // show what the tool drops as well as what it keeps. `portals`, `metadata`
  // and `active_workloads` are the bulky ones; `config` is the install-time
  // form the user filled in, and its `plex_claim_token` is a credential. All
  // four are here to be dropped.
  const app = (over: Record<string, unknown>) => ({
    name: 'plex',
    id: 'plex',
    state: 'RUNNING',
    upgrade_available: false,
    latest_version: '1.2.3',
    latest_app_version: '1.41.0.8994',
    image_updates_available: false,
    custom_app: false,
    migrated: false,
    human_version: '1.41.0.8994_1.2.3',
    version: '1.2.3',
    metadata: { app_version: '1.41.0.8994', capabilities: [], run_as_context: [] },
    active_workloads: {
      containers: 1,
      used_ports: [{ container_port: 32400, protocol: 'tcp' }],
      container_details: [{ id: 'abc', service_name: 'plex', image: 'plexinc/pms-docker' }],
      volumes: [{ source: '/mnt/tank/plex', destination: '/config' }],
    },
    notes: null,
    action_required: false,
    portals: { 'Web UI': 'http://nas:32400' },
    version_details: null,
    config: { plex_claim_token: 'claim-abc123' },
    ...over,
  });

  it('trims app.query to the named fields', async () => {
    const { ctx, query } = fakeSystem({ ['app.query']: [app({})] });
    expect(await appsList.handler(ctx, {})).toEqual([
      {
        name: 'plex',
        version: '1.2.3',
        latest_version: '1.2.3',
        state: 'RUNNING',
        upgrade_available: false,
        image_updates_available: false,
      },
    ]);
    // The tool reads the app list and nothing else. No filters — every
    // installed app is the subject — and the only option is the projection
    // below, which names exactly the six fields the mapping above reads.
    expect(query.mock.calls).toEqual([
      [
        'app.query',
        [],
        {
          select: [
            'name',
            'version',
            'latest_version',
            'state',
            'upgrade_available',
            'image_updates_available',
          ],
        },
      ],
    ]);
  });

  it('asks for no field it does not report, and reports every field it asks for', async () => {
    // The two halves of "names the fields its mapping reads", checked against
    // each other rather than against a list restated in this test: a `select`
    // that grew a field the mapping drops is bytes bought for nothing, and one
    // that lost a field the mapping reads is a null the caller cannot explain.
    const { ctx, query } = fakeSystem({ ['app.query']: [app({})] });
    const [result] = (await appsList.handler(ctx, {})) as Record<string, unknown>[];
    const [, , options] = query.mock.calls[0] as [string, unknown[], { select: string[] }];
    expect([...options.select].sort()).toEqual(Object.keys(result).sort());
  });

  it('reads a field the projection asked for and the row does not carry as null', async () => {
    // The failure mode `select` introduces: middleware that honours it returns
    // the named fields and no others, so a name the release answering does not
    // carry comes back ABSENT from the row rather than null on it. `undefined`
    // serializes to no key, so without the fallback the caller would get an
    // object missing fields the description promises — which reads as a
    // different shape rather than as a null.
    const { ctx } = fakeSystem({ ['app.query']: [{}] });
    expect(await appsList.handler(ctx, {})).toEqual([
      {
        name: null,
        version: null,
        latest_version: null,
        state: null,
        upgrade_available: null,
        image_updates_available: null,
      },
    ]);
  });

  it('surfaces neither the install-time config nor a field a later release adds', async () => {
    const { ctx } = fakeSystem({
      ['app.query']: [app({ future_field: 'added by a later TrueNAS release' })],
    });
    const [result] = (await appsList.handler(ctx, {})) as Record<string, unknown>[];
    expect(Object.keys(result)).toEqual([
      'name',
      'version',
      'latest_version',
      'state',
      'upgrade_available',
      'image_updates_available',
    ]);
  });

  it('includes apps that are not running, keeping stopped and crashed apart', async () => {
    const { ctx } = fakeSystem({
      ['app.query']: [
        app({ name: 'plex', state: 'RUNNING' }),
        app({ name: 'nextcloud', state: 'STOPPED' }),
        app({ name: 'jellyfin', state: 'CRASHED' }),
        app({ name: 'immich', state: 'DEPLOYING' }),
      ],
    });
    const result = (await appsList.handler(ctx, {})) as { name: string; state: string }[];
    expect(result.map((a) => [a.name, a.state])).toEqual([
      ['plex', 'RUNNING'],
      ['nextcloud', 'STOPPED'],
      ['jellyfin', 'CRASHED'],
      ['immich', 'DEPLOYING'],
    ]);
  });

  it('reports a waiting catalog upgrade and a waiting image update separately', async () => {
    // A custom app has no catalog version to move to, so `upgrade_available`
    // is permanently false and `image_updates_available` is the only signal
    // that it is out of date. Collapsing the two would report it up to date.
    const { ctx } = fakeSystem({
      ['app.query']: [
        app({
          name: 'sonarr',
          upgrade_available: true,
          latest_version: '2.0.0',
          version: '1.9.0',
          image_updates_available: false,
        }),
        app({
          name: 'my-own-thing',
          upgrade_available: false,
          latest_version: null,
          image_updates_available: true,
        }),
      ],
    });
    expect(await appsList.handler(ctx, {})).toEqual([
      {
        name: 'sonarr',
        version: '1.9.0',
        latest_version: '2.0.0',
        state: 'RUNNING',
        upgrade_available: true,
        image_updates_available: false,
      },
      {
        name: 'my-own-thing',
        version: '1.2.3',
        latest_version: null,
        state: 'RUNNING',
        upgrade_available: false,
        image_updates_available: true,
      },
    ]);
  });

  it('returns [] for a system with no apps installed', async () => {
    const { ctx } = fakeSystem({ ['app.query']: [] });
    expect(await appsList.handler(ctx, {})).toEqual([]);
  });
});

describe('app_engine_status', () => {
  const status = (over: Record<string, unknown>) => ({
    status: 'RUNNING',
    description: 'Docker service is running',
    ...over,
  });

  it('reports the engine as running, with the system\'s own words', async () => {
    const { ctx, call } = fakeSystem({ ['docker.status']: status({}) });
    expect(await appEngineStatus.handler(ctx, {})).toEqual({
      unavailable: null,
      running: true,
      status: 'RUNNING',
      description: 'Docker service is running',
    });
    // No arguments: the engine's status is a fact about the host.
    expect(call.mock.calls).toEqual([['docker.status']]);
  });

  it.each([
    ['STOPPED', 'the engine is down'],
    ['FAILED', 'the engine failed to come up'],
    ['UNCONFIGURED', 'apps have never been set up'],
    ['INITIALIZING', 'the engine is on its way up and not there yet'],
    ['PENDING', 'the engine has been asked for and is not there yet'],
    ['STOPPING', 'the engine is on its way down'],
  ])('reports %s as not running — %s', async (word) => {
    const { ctx } = fakeSystem({ ['docker.status']: status({ status: word }) });
    const result = (await appEngineStatus.handler(ctx, {})) as Record<string, unknown>;
    expect(result['running']).toBe(false);
    expect(result['status']).toBe(word);
  });

  it('reports a status word it has not read as UNKNOWN rather than as not running', async () => {
    // A later TrueNAS release adding a word must not be answered `false`, which
    // is the positive claim that nothing on the system can run. The word itself
    // is still passed through, so the caller sees what the system said.
    const { ctx } = fakeSystem({ ['docker.status']: status({ status: 'QUIESCED' }) });
    expect(await appEngineStatus.handler(ctx, {})).toEqual({
      unavailable: null,
      running: null,
      status: 'QUIESCED',
      description: 'Docker service is running',
    });
  });

  it('answers UNKNOWN for a status inherited from the prototype rather than reported', async () => {
    // `'constructor' in ENGINE_RUNNING` is true for any object literal, so a
    // membership test that walked the prototype would answer this one with
    // `undefined` — read back as a boolean the field cannot hold.
    const { ctx } = fakeSystem({ ['docker.status']: status({ status: 'constructor' }) });
    const result = (await appEngineStatus.handler(ctx, {})) as Record<string, unknown>;
    expect(result['running']).toBeNull();
  });

  it('reports the reason it could not read the engine, with every field null', async () => {
    // A system with no apps support rejects here; that is an answer about the
    // system rather than a fault, so the tool does not throw.
    const { ctx } = failingSystem({}, { ['docker.status']: new Error('Method not found') });
    expect(await appEngineStatus.handler(ctx, {})).toEqual({
      unavailable: 'Method not found',
      running: null,
      status: null,
      description: null,
    });
  });

  it('reads an answer that is not a status as unreadable rather than as stopped', async () => {
    const { ctx } = fakeSystem({ ['docker.status']: 'RUNNING' });
    expect(await appEngineStatus.handler(ctx, {})).toEqual({
      unavailable: 'the system did not answer with an app engine status',
      running: null,
      status: null,
      description: null,
    });
  });

  it('nulls a status and a description the system reported as something else', async () => {
    const { ctx } = fakeSystem({ ['docker.status']: status({ status: 7, description: '' }) });
    expect(await appEngineStatus.handler(ctx, {})).toEqual({
      unavailable: null,
      running: null,
      status: null,
      description: null,
    });
  });

  it('returns no field a later release adds to the status record', async () => {
    const { ctx } = fakeSystem({
      ['docker.status']: status({ container_count: 12, dataset: 'tank/ix-apps' }),
    });
    const result = (await appEngineStatus.handler(ctx, {})) as Record<string, unknown>;
    expect(Object.keys(result)).toEqual(['unavailable', 'running', 'status', 'description']);
  });
});

describe('apps_update_summary', () => {
  const app = (over: Record<string, unknown>) => ({
    name: 'plex',
    version: '1.2.3',
    human_version: '1.41.0.8994_1.2.3',
    upgrade_available: true,
    latest_version: '1.3.0',
    image_updates_available: false,
    config: { plex_claim_token: 'claim-abc123' },
    ...over,
  });

  const summary = (over: Record<string, unknown>) => ({
    latest_version: '1.3.0',
    latest_human_version: '1.42.0.9000_1.3.0',
    upgrade_version: '1.3.0',
    upgrade_human_version: '1.42.0.9000_1.3.0',
    available_versions_for_upgrade: [{ version: '1.3.0', human_version: '1.42.0.9000_1.3.0' }],
    changelog: '# 1.3.0\n\nBREAKING: the config format changed.',
    ...over,
  });

  /**
   * A system whose `app.upgrade_summary` answers per application name, which
   * neither shared fixture can do — both answer one canned value per METHOD,
   * and every test below that matters is about one application's summary
   * differing from another's.
   */
  const perApp = (
    rows: unknown,
    summaries: Record<string, unknown>,
    failures: Record<string, unknown> = {},
    respond: (value: unknown) => Observable<unknown> = of,
  ) => {
    const query = vi.fn(() => of(rows));
    const call = vi.fn((_method: string, args: unknown[]) => {
      const name = String(args[0]);
      return name in failures ? throwError(() => failures[name]) : respond(summaries[name]);
    });
    const system = { name: 'nas', client: { api: { query, call } } } as unknown as SystemHandle;
    return { ctx: { system } as ToolContext, query, call };
  };

  it('reports the version an update would move to, beside the installed one', async () => {
    const { ctx, call } = fakeSystem({
      ['app.query']: [app({})],
      ['app.upgrade_summary']: summary({}),
    });
    expect(await appsUpdateSummary.handler(ctx, {})).toEqual({
      unavailable: null,
      entries: [
        {
          app: 'plex',
          unavailable: null,
          installed_version: '1.2.3',
          installed_human_version: '1.41.0.8994_1.2.3',
          upgrade_version: '1.3.0',
          upgrade_human_version: '1.42.0.9000_1.3.0',
          latest_version: '1.3.0',
          latest_human_version: '1.42.0.9000_1.3.0',
        },
      ],
    });
    expect(call.mock.calls).toEqual([['app.upgrade_summary', ['plex']]]);
  });

  it('asks the listing for four fields, which is fewer than apps_list reads', async () => {
    // Not the same projection as `apps_list`, and deliberately so: this tool
    // reports neither `latest_version` from the listing nor
    // `image_updates_available` at all, and it needs `human_version`, which
    // `apps_list` drops. A `select` shared between the two would ask each path
    // for fields it has no mapping for.
    const { ctx, query } = fakeSystem({
      ['app.query']: [app({})],
      ['app.upgrade_summary']: summary({}),
    });
    await appsUpdateSummary.handler(ctx, {});
    expect(query.mock.calls).toEqual([
      ['app.query', [], { select: ['name', 'version', 'human_version', 'upgrade_available'] }],
    ]);
  });

  it('reads a row carrying none of the projected fields as unknown, not as up to date', async () => {
    // Same failure mode as `apps_list`'s, landing somewhere it matters more: a
    // row whose `upgrade_available` is ABSENT rather than false must stay in
    // the list saying so. Dropping it would report one fewer application as
    // having an update waiting than the read established.
    const { ctx, call } = perApp([{}], {});
    expect(await appsUpdateSummary.handler(ctx, {})).toEqual({
      unavailable: null,
      entries: [
        {
          app: null,
          unavailable:
            'the system did not report whether an update is waiting for this application, so no ' +
            'update summary was read',
          installed_version: null,
          installed_human_version: null,
          upgrade_version: null,
          upgrade_human_version: null,
          latest_version: null,
          latest_human_version: null,
        },
      ],
    });
    expect(call).not.toHaveBeenCalled();
  });

  it('reports neither the changelog nor the other versions available', async () => {
    // Both are dropped deliberately — see the tool's description. A trim would
    // have carried the changelog, which is unbounded upstream prose, and
    // `config`, which holds the install-time claim token.
    const { ctx } = fakeSystem({
      ['app.query']: [app({})],
      ['app.upgrade_summary']: summary({ future_field: 'added by a later release' }),
    });
    const { entries } = (await appsUpdateSummary.handler(ctx, {})) as {
      entries: Record<string, unknown>[];
    };
    expect(Object.keys(entries[0])).toEqual([
      'app',
      'unavailable',
      'installed_version',
      'installed_human_version',
      'upgrade_version',
      'upgrade_human_version',
      'latest_version',
      'latest_human_version',
    ]);
  });

  it('keeps upgrade_version and latest_version apart where the upgrade stops short', async () => {
    const { ctx } = fakeSystem({
      ['app.query']: [app({})],
      ['app.upgrade_summary']: summary({
        upgrade_version: '1.2.9',
        upgrade_human_version: '1.41.9.8999_1.2.9',
        latest_version: '2.0.0',
        latest_human_version: '2.0.0.1_2.0.0',
      }),
    });
    const { entries } = (await appsUpdateSummary.handler(ctx, {})) as {
      entries: Record<string, unknown>[];
    };
    expect([entries[0]['upgrade_version'], entries[0]['latest_version']]).toEqual([
      '1.2.9',
      '2.0.0',
    ]);
  });

  it('does not read a summary for an app with no update waiting, and leaves it out', async () => {
    const { ctx, call } = perApp(
      [app({ name: 'plex' }), app({ name: 'nextcloud', upgrade_available: false })],
      { plex: summary({}) },
    );
    const { entries } = (await appsUpdateSummary.handler(ctx, {})) as {
      entries: { app: string }[];
    };
    expect(entries.map((entry) => entry.app)).toEqual(['plex']);
    expect(call.mock.calls).toEqual([['app.upgrade_summary', ['plex']]]);
  });

  it('returns [] where every app is up to date, reading no summary at all', async () => {
    const { ctx, call } = perApp([app({ upgrade_available: false })], {});
    expect(await appsUpdateSummary.handler(ctx, {})).toEqual({ unavailable: null, entries: [] });
    expect(call).not.toHaveBeenCalled();
  });

  it('issues every per-app read together rather than one after another', async () => {
    // Nothing resolves until the gate opens, so a handler reading these in
    // sequence would never get past the first: the wait below is what
    // distinguishes issued-together from issued-one-at-a-time, and a `toEqual`
    // on the call count after the fact would pass either way.
    let open!: () => void;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const { ctx, call } = perApp(
      [app({ name: 'plex' }), app({ name: 'sonarr' }), app({ name: 'immich' })],
      { plex: summary({}), sonarr: summary({}), immich: summary({}) },
      {},
      (value) => from(gate.then(() => value)),
    );
    const pending = appsUpdateSummary.handler(ctx, {});
    await vi.waitFor(() => expect(call).toHaveBeenCalledTimes(3));
    open();
    const { entries } = (await pending) as { entries: { app: string }[] };
    expect(entries.map((entry) => entry.app)).toEqual(['plex', 'sonarr', 'immich']);
  });

  it('reports an app whose summary failed as unread, without losing the others', async () => {
    const { ctx } = perApp(
      [app({ name: 'plex' }), app({ name: 'sonarr' }), app({ name: 'immich' })],
      { plex: summary({}), immich: summary({ upgrade_version: '9.9.9' }) },
      { sonarr: { reason: 'catalog is unreachable' } },
    );
    const { entries } = (await appsUpdateSummary.handler(ctx, {})) as {
      entries: Record<string, unknown>[];
    };
    expect(
      entries.map((entry) => [entry['app'], entry['unavailable'], entry['upgrade_version']]),
    ).toEqual([
      ['plex', null, '1.3.0'],
      ['sonarr', 'catalog is unreachable', null],
      ['immich', null, '9.9.9'],
    ]);
  });

  it('keeps the installed version on an entry whose summary failed', async () => {
    // It came from the listing, which did not fail. Dropping it with the
    // summary would lose a fact the read established.
    const { ctx } = perApp([app({ version: '1.2.3' })], {}, { plex: new Error('timed out') });
    const { entries } = (await appsUpdateSummary.handler(ctx, {})) as {
      entries: Record<string, unknown>[];
    };
    expect(entries).toEqual([
      {
        app: 'plex',
        unavailable: 'timed out',
        installed_version: '1.2.3',
        installed_human_version: '1.41.0.8994_1.2.3',
        upgrade_version: null,
        upgrade_human_version: null,
        latest_version: null,
        latest_human_version: null,
      },
    ]);
  });

  it('reads a summary that is not a record as unreadable rather than as no update', async () => {
    const { ctx } = fakeSystem({
      ['app.query']: [app({})],
      ['app.upgrade_summary']: 'no upgrade available',
    });
    const { entries } = (await appsUpdateSummary.handler(ctx, {})) as {
      entries: Record<string, unknown>[];
    };
    expect(entries[0]['unavailable']).toBe('the system did not answer with an upgrade summary');
  });

  it('keeps an app whose update state could not be read, and does not ask about it', async () => {
    // Dropping it would say the system reported no update waiting, which is
    // more than the read established.
    const { ctx, call } = perApp([app({ upgrade_available: 'maybe' })], {});
    const { entries } = (await appsUpdateSummary.handler(ctx, {})) as {
      entries: Record<string, unknown>[];
    };
    expect([entries[0]['app'], entries[0]['unavailable']]).toEqual([
      'plex',
      'the system did not report whether an update is waiting for this application, so no ' +
        'update summary was read',
    ]);
    expect(call).not.toHaveBeenCalled();
  });

  it('keeps an app the system named nothing, and does not ask about it', async () => {
    const { ctx, call } = perApp([app({ name: '' })], {});
    const { entries } = (await appsUpdateSummary.handler(ctx, {})) as {
      entries: Record<string, unknown>[];
    };
    expect([entries[0]['app'], entries[0]['unavailable']]).toEqual([
      null,
      'the system reported no name for this application, so no update summary was read',
    ]);
    expect(call).not.toHaveBeenCalled();
  });

  it('reports the reason the app listing could not be read, with entries null', async () => {
    const { ctx } = failingSystem({}, { ['app.query']: { reason: 'connection reset' } });
    expect(await appsUpdateSummary.handler(ctx, {})).toEqual({
      unavailable: 'connection reset',
      entries: null,
    });
  });

  it('reads an answer that is not a list as unreadable rather than as no apps', async () => {
    const { ctx } = fakeSystem({ ['app.query']: { plex: {} } });
    expect(await appsUpdateSummary.handler(ctx, {})).toEqual({
      unavailable: 'the system did not answer with a list of applications',
      entries: null,
    });
  });

  it('reports a row it cannot walk as the listing being unreadable, rather than throwing', async () => {
    const { ctx } = perApp([null], {});
    const { unavailable, entries } = (await appsUpdateSummary.handler(ctx, {})) as {
      unavailable: string | null;
      entries: unknown;
    };
    expect(unavailable).not.toBeNull();
    expect(entries).toBeNull();
  });
});

/*
 * `app_upgrade` and `app_rollback`. The fake system is local, as the job-backed
 * specs' are: a job is a stream rather than a response, and these tools also
 * make three different calls a method→response map has to answer separately.
 */

const SECRET = 'SEEDED-CLAIM-TOKEN';

/** An application row as `app.query` or the job answers with one, secret-carrying `config` and all. */
const appRow = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  name: 'plex',
  id: 'plex',
  version: '1.2.3',
  human_version: '1.41.0_1.2.3',
  state: 'RUNNING',
  upgrade_available: true,
  config: { plex_claim_token: SECRET },
  metadata: { app_version: '1.41.0' },
  ...extra,
});

/** A job as the client's tracking emits one. */
const appJob = (state: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 77,
  state,
  result: state === 'SUCCESS' ? appRow({ version: '1.3.0', human_version: '1.42.0_1.3.0' }) : null,
  error: null,
  time_finished: { $date: 1_756_000_000_000 },
  ...extra,
});

type Answer = { value: unknown } | { fails: unknown };

const answer = (a: Answer): Observable<unknown> => ('fails' in a ? throwError(() => a.fails) : of(a.value));

function appJobSystem(
  options: {
    rows?: Answer | Answer[];
    engine?: Answer;
    summary?: Answer;
    versions?: Answer;
    started?: Observable<number>;
    job?: Observable<unknown>;
  } = {},
): {
  ctx: ToolContext;
  query: ReturnType<typeof vi.fn>;
  call: ReturnType<typeof vi.fn>;
  start: ReturnType<typeof vi.fn>;
  track: ReturnType<typeof vi.fn>;
} {
  // One answer per `app.query` read, in order; the last repeats.
  const reads = Array.isArray(options.rows) ? options.rows : [options.rows ?? { value: [appRow()] }];
  let read = 0;
  const query = vi.fn(() => answer(reads[Math.min(read++, reads.length - 1)]));
  const call = vi.fn((method: string) => {
    if (method === 'docker.status') return answer(options.engine ?? { value: { status: 'RUNNING' } });
    if (method === 'app.upgrade_summary') {
      return answer(options.summary ?? { value: { upgrade_version: '1.3.0', upgrade_human_version: '1.42.0_1.3.0' } });
    }
    if (method === 'app.rollback_versions') return answer(options.versions ?? { value: ['1.2.0', '1.1.0'] });
    return throwError(() => new Error(`unexpected ${method}`));
  });
  const start = vi.fn(() => options.started ?? of(77));
  const track = vi.fn(() => options.job ?? of(appJob('SUCCESS')));
  const system = {
    name: 'nas',
    client: { api: { query, call, callAndGetJobId: start, trackJob: track } },
  } as unknown as SystemHandle;
  return { ctx: { system }, query, call, start, track };
}

const SELECT = { select: ['name', 'version', 'human_version', 'state', 'upgrade_available'] };

describe.each([
  ['app_upgrade', appUpgrade, { app_name: 'plex' }],
  ['app_rollback', appRollback, { app_name: 'plex', app_version: '1.2.0' }],
] as const)('%s, what both tools share', (name, tool, args) => {
  it('is a reversible mutating tool needing the full role', () => {
    expect(tool).toMatchObject({ name, mutating: true, destructiveness: 'reversible', requiredRole: Role.Full });
  });

  it('says in its description that a rollback restores the version and not the data', () => {
    expect(tool.description).toContain('A ROLLBACK RESTORES THE VERSION AND NOT THE DATA');
  });

  it('requires an application name', () => {
    expect(() => tool.normalizeArgs?.({ ...args, app_name: '' })).toThrow('"app_name" is required');
  });

  it('fails the plan on an application the system does not list, naming it', async () => {
    const { ctx } = appJobSystem({ rows: { value: [appRow({ name: 'other' })] } });
    await expect(tool.plan(ctx, args)).rejects.toThrow('No application named "plex" is installed');
  });

  it('fails the plan where the listing could not be read', async () => {
    const { ctx } = appJobSystem({ rows: { fails: new Error('socket closed') } });
    await expect(tool.plan(ctx, args)).rejects.toThrow('app.query failed: socket closed');
    await expect(tool.plan(appJobSystem({ rows: { value: null } }).ctx, args)).rejects.toThrow(
      'the system did not answer with a list of applications',
    );
  });

  it('fails the plan where the app engine is not running, naming app_engine_status', async () => {
    const { ctx } = appJobSystem({ engine: { value: { status: 'STOPPED' } } });
    await expect(tool.plan(ctx, args)).rejects.toThrow(/reports STOPPED, not RUNNING.*`app_engine_status`/);
  });

  it('names the stopped engine, not a missing app, where a stopped engine lists no applications', async () => {
    const { ctx, query } = appJobSystem({ engine: { value: { status: 'STOPPED' } }, rows: { value: [] } });
    await expect(tool.plan(ctx, args)).rejects.toThrow(/reports STOPPED, not RUNNING.*`app_engine_status`/);
    expect(query).not.toHaveBeenCalled();
  });

  it('does not refuse an engine it could not read, and says the call may be rejected', async () => {
    const failed = await tool.plan(appJobSystem({ engine: { fails: new Error('no docker') } }).ctx, args);
    expect(failed[0].description).toContain('could not be read (no docker), so the call may be rejected');
    const unknown = await tool.plan(appJobSystem({ engine: { value: { status: 'MIGRATING' } } }).ctx, args);
    expect(unknown[0].description).toContain('the status MIGRATING, which this catalog does not know');
    const none = await tool.plan(appJobSystem({ engine: { value: {} } }).ctx, args);
    expect(none[0].description).toContain('no status this tool could read');
  });

  it('names the read after the watch as a step, with the params the read is made with', async () => {
    const { ctx, query } = appJobSystem();
    const steps = await tool.plan(ctx, args);
    expect(steps[1]).toMatchObject({ method: 'app.query', params: [[['name', '=', 'plex']], SELECT] });
    expect(steps[1].description).toContain('WHEN THE WATCH ENDS');
    expect(query).toHaveBeenCalledWith('app.query', [['name', '=', 'plex']], SELECT);
  });

  it('keeps config out of the result where the job answers with it and the read is padded', async () => {
    const result = await tool.execute(appJobSystem().ctx, args);
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(JSON.stringify(result)).not.toContain('config');
    const failed = await tool.execute(
      appJobSystem({ job: of(appJob('FAILED', { result: appRow(), error: 'pull failed' })) }).ctx,
      args,
    );
    expect(JSON.stringify(failed)).not.toContain(SECRET);
  });

  it('reports the job, its allowlisted answer and the state read after the watch', async () => {
    const { ctx, track } = appJobSystem({ rows: [{ value: [appRow()] }, { value: [appRow({ state: 'DEPLOYING' })] }] });
    await tool.plan(ctx, args);
    const result = (await tool.execute(ctx, args)) as Record<string, unknown>;
    expect(track).toHaveBeenCalledWith(77);
    expect(result).toMatchObject({
      app_name: 'plex',
      watched_seconds: 30,
      job_id: 77,
      ended: true,
      succeeded: true,
      job_state: 'SUCCESS',
      finished_at: new Date(1_756_000_000_000).toISOString(),
      answered: {
        name: 'plex',
        version: '1.3.0',
        human_version: '1.42.0_1.3.0',
        state: 'RUNNING',
        upgrade_available: true,
      },
      resulting_lookup: 'FOUND',
      resulting_read_error: null,
      resulting_state: 'DEPLOYING',
      resulting_version: '1.2.3',
    });
  });

  it('reports ended false, the job id and no answer where the watch ends first', async () => {
    vi.useFakeTimers();
    try {
      const job = concat(of(appJob('RUNNING', { result: appRow() })), NEVER);
      const pending = tool.execute(appJobSystem({ job }).ctx, args);
      await vi.advanceTimersByTimeAsync(30_000);
      const result = (await pending) as Record<string, unknown>;
      expect(result).toMatchObject({ ended: false, succeeded: null, job_id: 77, answered: null, finished_at: null });
      expect(JSON.stringify(result)).not.toContain(SECRET);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports a null answer where the job ended without answering with an application', async () => {
    const result = (await tool.execute(appJobSystem({ job: of(appJob('SUCCESS', { result: 'done' })) }).ctx, args)) as Record<
      string,
      unknown
    >;
    expect(result).toMatchObject({ ended: true, answered: null });
  });

  it('does not fail a call that landed where the read after it fails, or lists no such app', async () => {
    const failed = (await tool.execute(
      appJobSystem({ rows: { fails: new Error('socket closed') } }).ctx,
      args,
    )) as Record<string, unknown>;
    expect(failed).toMatchObject({
      ended: true,
      resulting_lookup: 'UNREADABLE',
      resulting_read_error: 'socket closed',
      resulting_state: null,
      resulting_version: null,
    });
    const gone = (await tool.execute(appJobSystem({ rows: { value: [] } }).ctx, args)) as Record<string, unknown>;
    expect(gone).toMatchObject({ resulting_lookup: 'NOT_FOUND', resulting_read_error: null, resulting_state: null });
  });

  it('fails where the call fails before any job was named', async () => {
    const started = throwError(() => new Error('[EINVAL] app_name: not found'));
    await expect(tool.execute(appJobSystem({ started }).ctx, args)).rejects.toThrow('EINVAL');
  });
});

describe('app_upgrade', () => {
  it('has no field for values', () => {
    const schema = appUpgrade.inputSchema as { properties: Record<string, unknown>; required: string[] };
    expect(Object.keys(schema.properties)).not.toContain('values');
    expect(schema.required).toEqual(['app_name']);
  });

  it('refuses values by name, without quoting them back', () => {
    expect(() => appUpgrade.normalizeArgs?.({ app_name: 'plex', values: { token: SECRET } })).toThrow(
      expect.objectContaining({ message: expect.stringContaining('"values" is not accepted') }),
    );
    expect(() => appUpgrade.normalizeArgs?.({ app_name: 'plex', values: { token: SECRET } })).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining(SECRET) }),
    );
  });

  it('defaults snapshot_hostpaths to true and drops executor arguments', () => {
    expect(appUpgrade.normalizeArgs?.({ app_name: 'plex', systems: 'all' })).toEqual({
      app_name: 'plex',
      app_version: null,
      snapshot_hostpaths: true,
    });
    expect(appUpgrade.normalizeArgs?.({ app_name: 'plex', app_version: '1.3.0', snapshot_hostpaths: false })).toEqual({
      app_name: 'plex',
      app_version: '1.3.0',
      snapshot_hostpaths: false,
    });
  });

  it('refuses a malformed version or snapshot flag', () => {
    expect(() => appUpgrade.normalizeArgs?.({ app_name: 'plex', app_version: '' })).toThrow('"app_version" must be');
    expect(() => appUpgrade.normalizeArgs?.({ app_name: 'plex', snapshot_hostpaths: 'yes' })).toThrow(
      '"snapshot_hostpaths" must be a boolean',
    );
  });

  it('states the current and target versions and that host paths are snapshotted', async () => {
    const { ctx, call } = appJobSystem();
    const steps = await appUpgrade.plan(ctx, { app_name: 'plex' });
    expect(steps[0]).toMatchObject({ method: 'app.upgrade', params: ['plex', { snapshot_hostpaths: true }] });
    expect(steps[0].description).toContain('now at version 1.2.3 (1.41.0_1.2.3)');
    expect(steps[0].description).toContain('It moves to version 1.3.0 (1.42.0_1.3.0)');
    expect(steps[0].description).toContain("A snapshot of the application's host-path volumes is taken");
    expect(steps[0].description).toContain('A ROLLBACK RESTORES THE VERSION AND NOT THE DATA');
    expect(call).toHaveBeenCalledWith('app.upgrade_summary', ['plex']);
  });

  it('sends a named version, asks the summary about it, and says where no snapshot is taken', async () => {
    const { ctx, call } = appJobSystem();
    const steps = await appUpgrade.plan(ctx, { app_name: 'plex', app_version: '1.3.0', snapshot_hostpaths: false });
    expect(steps[0].params).toEqual(['plex', { app_version: '1.3.0', snapshot_hostpaths: false }]);
    expect(steps[0].description).toContain('NO SNAPSHOT OF HOST-PATH VOLUMES IS TAKEN');
    expect(call).toHaveBeenCalledWith('app.upgrade_summary', ['plex', { app_version: '1.3.0' }]);
  });

  it('states a summary it could not read rather than failing the plan', async () => {
    const failed = await appUpgrade.plan(appJobSystem({ summary: { fails: new Error('no upgrade') } }).ctx, {
      app_name: 'plex',
    });
    expect(failed[0].description).toContain('the upgrade summary could not be read (no upgrade)');
    const empty = await appUpgrade.plan(appJobSystem({ summary: { value: {} } }).ctx, { app_name: 'plex' });
    expect(empty[0].description).toContain('named no target version this tool could read');
  });

  it('says where the system reports no upgrade waiting, and states an unreported version as that', async () => {
    const { ctx } = appJobSystem({ rows: { value: [appRow({ upgrade_available: false, version: null })] } });
    const [step] = await appUpgrade.plan(ctx, { app_name: 'plex' });
    expect(step.description).toContain('THE SYSTEM REPORTS NO UPGRADE WAITING');
    expect(step.description).toContain('now at a version the system reported no value for');
  });

  it('passes over a row it cannot read, and names a version reported without a human version', async () => {
    const { ctx } = appJobSystem({ rows: { value: [null, appRow({ human_version: null })] } });
    const [step] = await appUpgrade.plan(ctx, { app_name: 'plex' });
    expect(step.description).toContain('now at version 1.2.3.');
  });

  it('starts the job with the planned params and reports what was requested', async () => {
    const { ctx, start } = appJobSystem();
    const result = (await appUpgrade.execute(ctx, { app_name: 'plex' })) as Record<string, unknown>;
    expect(start).toHaveBeenCalledWith('app.upgrade', ['plex', { snapshot_hostpaths: true }]);
    expect(result).toMatchObject({ requested_version: null, requested_snapshot_hostpaths: true });
  });
});

describe('app_rollback', () => {
  it('has no field for rollback_snapshot, and requires a version', () => {
    const schema = appRollback.inputSchema as { properties: Record<string, unknown>; required: string[] };
    expect(Object.keys(schema.properties)).not.toContain('rollback_snapshot');
    expect(schema.required).toEqual(['app_name', 'app_version']);
    expect(() => appRollback.normalizeArgs?.({ app_name: 'plex' })).toThrow('"app_version" is required');
  });

  it.each([true, false])('refuses rollback_snapshot %s by name', (value) => {
    expect(() => appRollback.normalizeArgs?.({ app_name: 'plex', app_version: '1.2.0', rollback_snapshot: value })).toThrow(
      '"rollback_snapshot" is not accepted',
    );
  });

  it('sends rollback_snapshot false, in the plan and in the call', async () => {
    const { ctx, start } = appJobSystem();
    const steps = await appRollback.plan(ctx, { app_name: 'plex', app_version: '1.2.0' });
    expect(steps[0]).toMatchObject({
      method: 'app.rollback',
      params: ['plex', { app_version: '1.2.0', rollback_snapshot: false }],
    });
    expect(steps[0].description).toContain('from version 1.2.3 (1.41.0_1.2.3) to version 1.2.0');
    expect(steps[0].description).toContain("ix-volume snapshot is NOT restored");
    await appRollback.execute(ctx, { app_name: 'plex', app_version: '1.2.0' });
    expect(start).toHaveBeenCalledWith('app.rollback', ['plex', { app_version: '1.2.0', rollback_snapshot: false }]);
  });

  it('fails the plan on a version the system cannot roll back to, naming the ones it can', async () => {
    const { ctx, call } = appJobSystem();
    await expect(appRollback.plan(ctx, { app_name: 'plex', app_version: '0.9.0' })).rejects.toThrow(
      '"plex" cannot roll back to version 0.9.0; the system lists 1.2.0, 1.1.0',
    );
    expect(call).toHaveBeenCalledWith('app.rollback_versions', ['plex']);
    await expect(
      appRollback.plan(appJobSystem({ versions: { value: [] } }).ctx, { app_name: 'plex', app_version: '1.2.0' }),
    ).rejects.toThrow('the system lists no version it can roll back to');
  });

  it('fails the plan where the versions could not be read, or were not a list of names', async () => {
    await expect(
      appRollback.plan(appJobSystem({ versions: { fails: new Error('boom') } }).ctx, {
        app_name: 'plex',
        app_version: '1.2.0',
      }),
    ).rejects.toThrow('app.rollback_versions failed: boom');
    await expect(
      appRollback.plan(appJobSystem({ versions: { value: ['1.2.0', 3] } }).ctx, {
        app_name: 'plex',
        app_version: '1.2.0',
      }),
    ).rejects.toThrow('did not answer with a list of versions');
  });
});
