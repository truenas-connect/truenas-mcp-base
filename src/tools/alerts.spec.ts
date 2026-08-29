import { describe, expect, it } from 'vitest';
import { fakeSystem, failingSystem } from '@/testing/fake-systems';
import { alertSettings, alertsList } from '@/tools/index';

describe('alerts_list', () => {
  // Every property the middleware's Alert carries, so the assertions below show
  // what the tool drops as well as what it keeps.
  const alert = (over: Record<string, unknown>) => ({
    uuid: 'u1',
    source: 'AlertSource',
    klass: 'ZpoolCapacityWarning',
    args: { pool: 'tank' },
    node: 'A',
    key: '[]',
    datetime: '2026-08-28T12:00:00+00:00',
    last_occurrence: '2026-08-28T13:00:00+00:00',
    dismissed: false,
    mail: null,
    text: 'Pool %(pool)s is low on space.',
    id: 'a1',
    level: 'WARNING',
    formatted: 'Pool tank is low on space.',
    one_shot: false,
    ...over,
  });

  it('trims alert.list to the named fields', async () => {
    const { ctx, call } = fakeSystem({ ['alert.list']: [alert({})] });
    expect(await alertsList.handler(ctx, {})).toEqual([
      {
        id: 'a1',
        klass: 'ZpoolCapacityWarning',
        level: 'WARNING',
        formatted: 'Pool tank is low on space.',
        datetime: '2026-08-28T12:00:00+00:00',
        dismissed: false,
      },
    ]);
    // The tool reads the alert list and nothing else.
    expect(call.mock.calls).toEqual([['alert.list']]);
  });

  it('does not surface a field the middleware adds later', async () => {
    const { ctx } = fakeSystem({
      ['alert.list']: [alert({ future_field: 'added by a later TrueNAS release' })],
    });
    const [result] = (await alertsList.handler(ctx, {})) as Record<string, unknown>[];
    expect(Object.keys(result)).toEqual([
      'id',
      'klass',
      'level',
      'formatted',
      'datetime',
      'dismissed',
    ]);
  });

  it('returns dismissed alerts, distinguishable by the boolean', async () => {
    const { ctx } = fakeSystem({
      ['alert.list']: [alert({ id: 'a1' }), alert({ id: 'a2', dismissed: true })],
    });
    const result = (await alertsList.handler(ctx, {})) as { id: string; dismissed: boolean }[];
    expect(result.map((a) => [a.id, a.dismissed])).toEqual([
      ['a1', false],
      ['a2', true],
    ]);
  });

  it('returns [] for a system with no alerts', async () => {
    const { ctx } = fakeSystem({ ['alert.list']: [] });
    expect(await alertsList.handler(ctx, {})).toEqual([]);
  });
});

describe('alert_settings', () => {
  /**
   * A destination as `alertservice.query` reports one on the version the
   * client's types describe: the type inside `attributes`, beside the secret
   * the destination authenticates with.
   *
   * The secret fields carry real-looking material for the reason the cloud
   * credential fixture does — the test that no secret survives the mapping is
   * only worth anything if some was there to survive.
   */
  const destination = (over: Record<string, unknown> = {}) => ({
    id: 1,
    name: 'ops-mail',
    level: 'WARNING',
    enabled: true,
    type__title: 'Email',
    attributes: { type: 'Mail', email: 'ops@example.invalid' },
    ...over,
  });

  /** The per-class settings, as `alertclasses.config` sends them. */
  const CLASSES = {
    id: 1,
    classes: {
      ZpoolCapacityWarning: { policy: 'NEVER' },
      SMARTError: { level: 'CRITICAL', proactive_support: true },
    },
  };

  const read = async (
    services: unknown[] = [destination()],
    classes: unknown = CLASSES,
  ): Promise<Record<string, unknown>> => {
    const { ctx } = fakeSystem({
      ['alertservice.query']: services,
      ['alertclasses.config']: classes,
    });
    return (await alertSettings.handler(ctx, {})) as Record<string, unknown>;
  };

  /** The destinations of a result, which is what most cases are about. */
  const destinations = async (services: unknown[]): Promise<Record<string, unknown>[]> =>
    (await read(services))['destinations'] as Record<string, unknown>[];

  /** One destination, differing only in the fields the case is about. */
  const one = async (over: Record<string, unknown>): Promise<Record<string, unknown>> =>
    (await destinations([destination(over)]))[0];

  /** The same two reads, with `alertclasses.config` rejecting instead. */
  const readFailing = async (reason: unknown): Promise<Record<string, unknown>> => {
    const { ctx } = failingSystem(
      { ['alertservice.query']: [destination()], ['alertclasses.config']: CLASSES },
      { ['alertclasses.config']: reason },
    );
    return (await alertSettings.handler(ctx, {})) as Record<string, unknown>;
  };

  it('reports each destination and each overridden class', async () => {
    expect(await read()).toEqual({
      destinations: [
        { name: 'ops-mail', type: 'Mail', enabled: true, minimum_level: 'WARNING' },
      ],
      class_overrides: [
        { class: 'SMARTError', policy: null, level: 'CRITICAL', proactive_support: true },
        {
          class: 'ZpoolCapacityWarning',
          policy: 'NEVER',
          level: null,
          proactive_support: null,
        },
      ],
      failures: [],
    });
  });

  it('returns no webhook URL, key or token, whatever the destination type is', async () => {
    const rows = await destinations([
      destination({
        name: 'pager',
        attributes: { type: 'PagerDuty', service_key: 'SECRET-SERVICE-KEY' },
      }),
      destination({
        name: 'chat',
        attributes: { type: 'Slack', url: 'https://hooks.invalid/SECRET-WEBHOOK' },
      }),
      destination({
        name: 'sns',
        attributes: {
          type: 'AWSSNS',
          region: 'us-east-1',
          topic_arn: 'arn:aws:sns:us-east-1:1:alerts',
          aws_access_key_id: 'SECRET-ACCESS-KEY-ID',
          aws_secret_access_key: 'SECRET-SECRET-ACCESS-KEY',
        },
      }),
    ]);
    expect(JSON.stringify(rows)).not.toContain('SECRET');
    expect(rows.map((row) => row['type'])).toEqual(['PagerDuty', 'Slack', 'AWSSNS']);
  });

  it('carries no field the tool does not name, including one a later release adds', async () => {
    const rows = await destinations([
      destination({
        // A destination type TrueNAS has not shipped yet, spelling its secret a
        // way this file has never seen. An allowlist keeps it out; a copy with
        // the known secrets removed would not.
        attributes: { type: 'FUTURE_SERVICE', unheard_of_secret: 'SECRET-NEW-SHAPE' },
        send_test_alert: true,
      }),
    ]);
    expect(Object.keys(rows[0])).toEqual(['name', 'type', 'enabled', 'minimum_level']);
    expect(JSON.stringify(rows)).not.toContain('SECRET');
  });

  it('reads a type an older release sent beside the attributes rather than inside them', async () => {
    expect(
      await one({ type: 'Mattermost', attributes: { url: 'https://chat.invalid/SECRET-HOOK' } }),
    ).toMatchObject({ type: 'Mattermost' });
  });

  it('does not fall back to the display title, which is a different vocabulary', async () => {
    // `type__title` is on the fixture throughout; a null type has to stay null
    // rather than becoming `Email`, because a caller cannot tell the two
    // spellings apart once they share a field.
    expect(await one({ attributes: {} })).toMatchObject({ type: null });
  });

  it('reports a type it could not read as null rather than as no type', async () => {
    expect(await one({ attributes: null })).toMatchObject({ type: null });
    expect(await one({ attributes: ['Mail'] })).toMatchObject({ type: null });
    expect(await one({ attributes: 'Mail' })).toMatchObject({ type: null });
    expect(await one({ attributes: { type: '' } })).toMatchObject({ type: null });
    expect(await one({ attributes: { type: 7 } })).toMatchObject({ type: null });
  });

  it('reports an enabled state the system did not send as null rather than as disabled', async () => {
    expect(await one({ enabled: false })).toMatchObject({ enabled: false });
    expect(await one({ enabled: undefined })).toMatchObject({ enabled: null });
    expect(await one({ enabled: null })).toMatchObject({ enabled: null });
    expect(await one({ enabled: 'true' })).toMatchObject({ enabled: null });
  });

  it('reports a name or a minimum severity the system gave no value for as null', async () => {
    expect(await one({ name: '', level: '' })).toMatchObject({
      name: null,
      minimum_level: null,
    });
    expect(await one({ name: null, level: null })).toMatchObject({
      name: null,
      minimum_level: null,
    });
  });

  it('returns an empty destination list for a system that sends its alerts nowhere', async () => {
    expect(await read([])).toMatchObject({ destinations: [] });
  });

  it('returns an empty override list for a system that has changed no class', async () => {
    expect(await read([destination()], { id: 1, classes: {} })).toMatchObject({
      class_overrides: [],
      failures: [],
    });
  });

  it('reports a class setting it could not read as nulls rather than dropping the class', async () => {
    const result = await read([destination()], {
      id: 1,
      classes: { UPSBatteryLow: null, ZpoolCapacityWarning: { policy: 7, level: [] } },
    });
    expect(result['class_overrides']).toEqual([
      { class: 'UPSBatteryLow', policy: null, level: null, proactive_support: null },
      { class: 'ZpoolCapacityWarning', policy: null, level: null, proactive_support: null },
    ]);
  });

  it('reports settings it could not read at all as null, which is not "nothing overridden"', async () => {
    // Distinct from the empty list above: an unreadable response must not read
    // as a system whose classes are all at their defaults.
    expect(await read([destination()], { id: 1 })).toMatchObject({ class_overrides: null });
    expect(await read([destination()], { id: 1, classes: [] })).toMatchObject({
      class_overrides: null,
    });
    expect(await read([destination()], null)).toMatchObject({ class_overrides: null });
  });

  it('names the class settings read when it fails, and still reports the destinations', async () => {
    const result = await readFailing(new Error('connection reset'));
    expect(result['class_overrides']).toBeNull();
    expect(result['failures']).toEqual([
      { source: 'class_overrides', error: 'connection reset' },
    ]);
    expect(result['destinations']).toEqual([
      { name: 'ops-mail', type: 'Mail', enabled: true, minimum_level: 'WARNING' },
    ]);
  });

  it('names why a read failed from whatever the client rejected with', async () => {
    const reasons = async (reason: unknown): Promise<unknown> =>
      (await readFailing(reason))['failures'];
    expect(await reasons({ reason: 'method not found' })).toEqual([
      { source: 'class_overrides', error: 'method not found' },
    ]);
    expect(await reasons({ message: 'not authorised' })).toEqual([
      { source: 'class_overrides', error: 'not authorised' },
    ]);
    expect(await reasons('timed out')).toEqual([
      { source: 'class_overrides', error: 'timed out' },
    ]);
    // A failure with no text of its own still has to read as a failure.
    expect(await reasons(new Error(''))).toEqual([
      { source: 'class_overrides', error: 'the system reported no reason' },
    ]);
    expect(await reasons({})).toEqual([
      { source: 'class_overrides', error: 'the system reported no reason' },
    ]);
    expect(await reasons(42)).toEqual([
      { source: 'class_overrides', error: 'the system reported no reason' },
    ]);
  });

  it('joins the class identifier alerts_list reports', async () => {
    // The point of pairing the two: an alert names its class, and this is what
    // says whether that class is being sent anywhere.
    const { ctx } = fakeSystem({
      ['alert.list']: [
        {
          uuid: 'a',
          id: 'a',
          klass: 'ZpoolCapacityWarning',
          level: 'WARNING',
          formatted: 'Pool tank is 85% full.',
          datetime: { $date: 1 },
          dismissed: false,
        },
      ],
      ['alertservice.query']: [destination()],
      ['alertclasses.config']: CLASSES,
    });
    const alerts = (await alertsList.handler(ctx, {})) as Record<string, unknown>[];
    const settings = (await alertSettings.handler(ctx, {})) as Record<string, unknown>;
    const overrides = settings['class_overrides'] as Record<string, unknown>[];
    expect(overrides.map((row) => row['class'])).toContain(alerts[0]['klass']);
  });

  it('asks for the destinations and the class settings', async () => {
    const { ctx, call, query } = fakeSystem({
      ['alertservice.query']: [],
      ['alertclasses.config']: CLASSES,
    });
    await alertSettings.handler(ctx, {});
    expect(query).toHaveBeenCalledWith('alertservice.query');
    expect(call).toHaveBeenCalledWith('alertclasses.config');
  });
});
