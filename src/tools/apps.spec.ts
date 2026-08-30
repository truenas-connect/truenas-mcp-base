import { describe, expect, it, vi } from 'vitest';
import { Observable, from, of, throwError } from 'rxjs';
import { SystemHandle, ToolContext } from '@/catalog/tool';
import { failingSystem, fakeSystem } from '@/testing/fake-systems';
import { appEngineStatus, appsList, appsUpdateSummary } from '@/tools/index';

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
    // The failure mode `select` introduces: middleware honours it on its
    // current api version, so a field named here can be ABSENT from the row
    // rather than null on it. `undefined` serializes to no key, so without the
    // fallback the caller would get an object missing fields the description
    // promises — which reads as a different shape rather than as a null.
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
