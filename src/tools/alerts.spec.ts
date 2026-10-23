import { describe, expect, it, vi } from 'vitest';
import { of, throwError } from 'rxjs';
import { ToolCatalog } from '@/catalog/catalog';
import { MutatingTool, SystemHandle } from '@/catalog/tool';
import { ConfirmationService } from '@/execution/confirmation';
import { ToolExecutor } from '@/execution/executor';
import { Role } from '@/interfaces';
import { SystemRegistry } from '@/registry/system-registry';
import { fakeSystem, failingSystem } from '@/testing/fake-systems';
import { alertClassSet, alertsDismiss, alertSettings, alertsList, alertsRestore } from '@/tools/index';

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
        uuid: 'u1',
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
      'uuid',
      'id',
      'klass',
      'level',
      'formatted',
      'datetime',
      'dismissed',
    ]);
  });

  it('reports the uuid the mutating pair takes, beside the id it does not', async () => {
    // The two are separate required fields of the middleware's alert, and only
    // `uuid` addresses one alert on one system — so both are reported and the
    // description says which of them `alerts_dismiss` accepts.
    const { ctx } = fakeSystem({ ['alert.list']: [alert({ uuid: 'u9', id: 'a9' })] });
    const [row] = (await alertsList.handler(ctx, {})) as Record<string, unknown>[];
    expect(row).toMatchObject({ uuid: 'u9', id: 'a9' });
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

describe('alerts_dismiss and alerts_restore', () => {
  /** One alert as `alert.list` sends it, with the four fields these tools read. */
  const alert = (over: Record<string, unknown> = {}) => ({
    uuid: 'u1',
    id: 'a1',
    klass: 'ZpoolCapacityWarning',
    level: 'WARNING',
    formatted: 'Pool tank is 85% full.',
    datetime: '2026-08-28T12:00:00+00:00',
    dismissed: false,
    ...over,
  });

  /** A system listing those alerts, whose dismiss and restore both succeed. */
  const system = (alerts: unknown[] = [alert()]) =>
    fakeSystem({
      ['alert.list']: alerts,
      ['alert.dismiss']: null,
      ['alert.restore']: null,
    });

  /** The mutating step of a plan, which is the second of the two. */
  const mutationStep = async (tool: MutatingTool, alerts: unknown[] = [alert()]) =>
    (await tool.plan(system(alerts).ctx, { uuid: 'u1' }))[1];

  const both: [string, MutatingTool][] = [
    ['alerts_dismiss', alertsDismiss],
    ['alerts_restore', alertsRestore],
  ];

  describe.each(both)('%s', (name, tool) => {
    it('is a reversible mutating tool needing the full role', () => {
      expect(tool).toMatchObject({
        name,
        mutating: true,
        destructiveness: 'reversible',
        requiredRole: Role.Full,
      });
    });

    it('normalizes args: keeps the uuid and drops unknown keys', () => {
      expect(tool.normalizeArgs?.({ uuid: 'u1', extra: 1, systems: 'all' })).toEqual({
        uuid: 'u1',
      });
    });

    it('requires a non-empty string uuid, in normalizeArgs and in plan', async () => {
      const { ctx } = system();
      for (const bad of [undefined, null, '', 7, ['u1']]) {
        expect(() => tool.normalizeArgs?.({ uuid: bad })).toThrow(/"uuid" is required/);
        await expect(tool.plan(ctx, { uuid: bad })).rejects.toThrow(/"uuid" is required/);
      }
    });

    it('plans the read it makes as well as the mutation it makes', async () => {
      const steps = await tool.plan(system().ctx, { uuid: 'u1' });
      // Two steps because `execute` makes two calls. A plan naming only the
      // mutation would not be a true account of what runs.
      expect(steps.map((step) => step.method)).toEqual(['alert.list', tool.name.replace('alerts_', 'alert.')]);
      expect(steps[0]).toMatchObject({ params: [] });
      expect(steps[0].description).toMatch(/Changes nothing/);
      expect(steps[1]).toMatchObject({ params: ['u1'] });
    });

    it('names the alert by level, class and message rather than only by uuid', async () => {
      const step = await mutationStep(tool);
      expect(step.description).toContain('level WARNING');
      expect(step.description).toContain('class ZpoolCapacityWarning');
      expect(step.description).toContain('message "Pool tank is 85% full."');
      expect(step.description).toContain('uuid u1');
    });

    it('states a level, class or message the system reported as absent', async () => {
      // Dropping one silently would read as an alert that has none, and the
      // person approving the plan could not tell which.
      const step = await mutationStep(tool, [
        alert({ level: '', klass: null, formatted: null }),
      ]);
      expect(step.description).toContain('level (the system reported none)');
      expect(step.description).toContain('class (the system reported none)');
      expect(step.description).toContain('message (the system reported none)');
    });

    it('says so rather than claiming a change when the state cannot be read', async () => {
      const step = await mutationStep(tool, [alert({ dismissed: 'yes' })]);
      expect(step.description).toContain(
        'Whether it is dismissed could not be read, so this may change nothing.',
      );
    });

    it('fails the plan for a uuid no alert matches, naming the uuid supplied', async () => {
      await expect(tool.plan(system([]).ctx, { uuid: 'gone' })).rejects.toThrow(
        'No alert with uuid "gone" on this system',
      );
    });

    it('does not accept the id alerts_list also reports', async () => {
      // `id` is stable across systems for one condition, so a tool keyed on it
      // would be ambiguous under the fan-out. Planning on one has to fail.
      await expect(tool.plan(system().ctx, { uuid: 'a1' })).rejects.toThrow(
        'No alert with uuid "a1" on this system',
      );
    });

    it('executes exactly the two calls the plan named, in that order', async () => {
      const { ctx, call } = system();
      await tool.execute(ctx, { uuid: 'u1' });
      expect(call.mock.calls).toEqual([
        ['alert.list'],
        [tool.name.replace('alerts_', 'alert.'), ['u1']],
      ]);
    });

    it('still makes the call when the alert is no longer listed', async () => {
      // It cleared between the plan and the confirmation. Skipping the call
      // would be `execute` branching on state read at execution time.
      const { ctx, call } = system([]);
      expect(await tool.execute(ctx, { uuid: 'u1' })).toEqual({
        uuid: 'u1',
        lookup: 'NOT_FOUND',
        lookup_error: null,
        previously_dismissed: null,
        changed: null,
      });
      expect(call).toHaveBeenCalledWith(tool.name.replace('alerts_', 'alert.'), ['u1']);
    });

    it('still makes the call when the state read fails, and names why', async () => {
      const { ctx, call } = failingSystem(
        { ['alert.dismiss']: null, ['alert.restore']: null },
        { ['alert.list']: new Error('connection reset') },
      );
      expect(await tool.execute(ctx, { uuid: 'u1' })).toEqual({
        uuid: 'u1',
        lookup: 'UNREADABLE',
        lookup_error: 'connection reset',
        previously_dismissed: null,
        changed: null,
      });
      expect(call).toHaveBeenCalledWith(tool.name.replace('alerts_', 'alert.'), ['u1']);
    });

    it('reports a prior state it could not read as null rather than as unchanged', async () => {
      expect(
        await tool.execute(system([alert({ dismissed: null })]).ctx, { uuid: 'u1' }),
      ).toMatchObject({ lookup: 'FOUND', previously_dismissed: null, changed: null });
    });

    it('executes only against a confirmation token minted from its own plan', async () => {
      const { ctx, call } = system();
      const registry = new SystemRegistry();
      registry.add(ctx.system as SystemHandle);
      const catalog = new ToolCatalog();
      catalog.register(tool);
      const confirmations = new ConfirmationService();
      const executor = new ToolExecutor({ catalog, registry, confirmations });

      const first = await executor.execute(tool.name, { uuid: 'u1' });
      expect(first.type).toBe('PLAN');
      // The plan phase reads; nothing has mutated.
      expect(call.mock.calls).toEqual([['alert.list']]);

      await expect(
        executor.execute(tool.name, { uuid: 'u1', confirmation_token: 'forged' }),
      ).rejects.toThrow();
      expect(call.mock.calls).toEqual([['alert.list']]);

      const token = confirmations.mint(first.type === 'PLAN' ? first.key : '');
      const confirmed = await executor.execute(tool.name, {
        uuid: 'u1',
        confirmation_token: token,
      });
      expect(confirmed.type).toBe('RESULTS');
      expect(call).toHaveBeenCalledWith(tool.name.replace('alerts_', 'alert.'), ['u1']);
    });
  });

  it('dismisses an alert that was not dismissed, and reports that it changed', async () => {
    expect(await alertsDismiss.execute(system().ctx, { uuid: 'u1' })).toEqual({
      uuid: 'u1',
      lookup: 'FOUND',
      lookup_error: null,
      previously_dismissed: false,
      changed: true,
    });
  });

  it('accepts an already-dismissed alert and reports that nothing changed', async () => {
    const alerts = [alert({ dismissed: true })];
    expect(await alertsDismiss.execute(system(alerts).ctx, { uuid: 'u1' })).toEqual({
      uuid: 'u1',
      lookup: 'FOUND',
      lookup_error: null,
      previously_dismissed: true,
      changed: false,
    });
    expect((await mutationStep(alertsDismiss, alerts)).description).toContain(
      'It is already dismissed, so this changes nothing and is not an error.',
    );
  });

  it('restores a dismissed alert, and reports that it changed', async () => {
    const alerts = [alert({ dismissed: true })];
    expect(await alertsRestore.execute(system(alerts).ctx, { uuid: 'u1' })).toEqual({
      uuid: 'u1',
      lookup: 'FOUND',
      lookup_error: null,
      previously_dismissed: true,
      changed: true,
    });
    expect((await mutationStep(alertsRestore, alerts)).description).toContain(
      'It is dismissed, so this will restore it.',
    );
  });

  it('accepts an alert that was never dismissed and reports that nothing changed', async () => {
    expect(await alertsRestore.execute(system().ctx, { uuid: 'u1' })).toEqual({
      uuid: 'u1',
      lookup: 'FOUND',
      lookup_error: null,
      previously_dismissed: false,
      changed: false,
    });
    expect((await mutationStep(alertsRestore)).description).toContain(
      'It is not dismissed, so this changes nothing and is not an error.',
    );
  });

  it('says it will dismiss an alert that is not dismissed', async () => {
    expect((await mutationStep(alertsDismiss)).description).toContain(
      'It is not dismissed, so this will dismiss it.',
    );
  });

  it('takes the uuid alerts_list reports, on the same system', async () => {
    // The pairing that makes the mutation reachable at all: `alerts_list` is
    // where a caller gets the identifier these tools want.
    const { ctx } = system();
    const [row] = (await alertsList.handler(ctx, {})) as Record<string, unknown>[];
    const steps = await alertsDismiss.plan(ctx, { uuid: row['uuid'] });
    expect(steps[1].params).toEqual([row['uuid']]);
  });
});

describe('alert_class_set', () => {
  const categories = [
    {
      id: 'STORAGE',
      title: 'Storage',
      classes: [
        { id: 'ZpoolCapacityWarning', title: 'Pool Space Usage Is Above 80%', level: 'WARNING', proactive_support: false },
        { id: 'SMARTError', title: 'S.M.A.R.T. Error', level: 'CRITICAL', proactive_support: true },
      ],
    },
    { id: 'SYSTEM', title: 'System', classes: [{ id: 'UPSOnBattery', title: 'UPS On Battery', level: 'CRITICAL' }] },
  ];

  // A stored map with two other classes, one carrying a field this tool does
  // not name, so the write-back assertions show it surviving untouched.
  const stored = () => ({
    SMARTError: { level: 'ERROR', policy: 'DAILY', proactive_support: true, future_field: 'x' },
    UPSOnBattery: { policy: 'NEVER' },
  });

  // The rows object is read per call, so a test can change it between plan and
  // execute and see `execute` read the map again.
  const system = (
    classes: unknown = stored(),
    update?: unknown,
    failures: Partial<Record<string, unknown>> = {},
  ) => {
    const rows: Record<string, unknown> = {
      ['alert.list_categories']: categories,
      ['alertclasses.config']: { id: 1, classes },
    };
    const answer = (method: string, params?: unknown[]) => {
      if (method in failures) return throwError(() => failures[method]);
      if (method === 'alertclasses.update') {
        return of(update !== undefined ? update : { id: 1, ...(params?.[0] as object) });
      }
      return of(rows[method]);
    };
    const call = vi.fn(answer);
    const ctx = { system: { name: 'nas', client: { api: { call } } } as unknown as SystemHandle };
    return { ctx, call, rows };
  };

  const updateStep = async (args: Record<string, unknown>, classes?: unknown) =>
    (await alertClassSet.plan(system(classes).ctx, args))[1];

  it('is a full-role, reversible mutation', () => {
    expect(alertClassSet).toMatchObject({
      name: 'alert_class_set',
      mutating: true,
      destructiveness: 'reversible',
      requiredRole: Role.Full,
    });
  });

  it('advertises the declared Level and Policy unions as its enums', () => {
    const properties = alertClassSet.inputSchema['properties'] as Record<string, Record<string, unknown>>;
    expect(properties['level']['enum']).toEqual(['INFO', 'NOTICE', 'WARNING', 'ERROR', 'CRITICAL', 'ALERT', 'EMERGENCY']);
    expect(properties['policy']['enum']).toEqual(['IMMEDIATELY', 'HOURLY', 'DAILY', 'NEVER']);
    expect(alertClassSet.inputSchema['required']).toEqual(['class']);
  });

  it('normalizes args to what was passed, dropping unknown keys', () => {
    expect(alertClassSet.normalizeArgs?.({ class: 'SMARTError', policy: 'HOURLY', extra: 1 })).toEqual({
      class: 'SMARTError',
      policy: 'HOURLY',
    });
    expect(alertClassSet.normalizeArgs?.({ class: 'SMARTError', reset: true })).toEqual({
      class: 'SMARTError',
      reset: true,
    });
  });

  it.each([
    [{}, /"class" is required/],
    [{ class: '' }, /"class" is required/],
    [{ class: 7, level: 'INFO' }, /"class" is required/],
    [{ class: 'SMARTError' }, /Nothing to change/],
    [{ class: 'SMARTError', level: 'LOUD' }, /"level" must be one of INFO, NOTICE/],
    [{ class: 'SMARTError', level: 'constructor' }, /"level" must be one of/],
    [{ class: 'SMARTError', policy: 'WEEKLY' }, /"policy" must be one of IMMEDIATELY, HOURLY, DAILY, NEVER/],
    [{ class: 'SMARTError', reset: false }, /"reset" takes only true/],
    [{ class: 'SMARTError', reset: true, level: 'INFO' }, /cannot be combined/],
    [{ class: 'SMARTError', reset: true, policy: 'NEVER' }, /cannot be combined/],
  ])('refuses %j in normalizeArgs and in plan', async (args, error) => {
    expect(() => alertClassSet.normalizeArgs?.(args)).toThrow(error);
    await expect(alertClassSet.plan(system().ctx, args)).rejects.toThrow(error);
  });

  it('plans the read execute makes, then the update', async () => {
    const steps = await alertClassSet.plan(system().ctx, { class: 'ZpoolCapacityWarning', level: 'CRITICAL' });
    expect(steps.map((step) => [step.method, step.params])).toEqual([
      ['alertclasses.config', []],
      [
        'alertclasses.update',
        [{ classes: { ...stored(), ZpoolCapacityWarning: { level: 'CRITICAL' } } }],
      ],
    ]);
    expect(steps[0].description).toContain('Changes nothing');
  });

  it("names the class in words, its current and requested setting, and the system's default level", async () => {
    const step = await updateStep({ class: 'SMARTError', level: 'CRITICAL' });
    expect(step.description).toContain(
      'Change alert class "SMARTError" (S.M.A.R.T. Error; category Storage; the system lists its default level as CRITICAL).',
    );
    expect(step.description).toContain('Now it is stored with level ERROR, policy DAILY.');
    expect(step.description).toContain('This sets level CRITICAL. Its policy is kept as stored.');
  });

  it('says a class with no stored setting is at its defaults', async () => {
    const step = await updateStep({ class: 'ZpoolCapacityWarning', policy: 'HOURLY' });
    expect(step.description).toContain('Now it holds no stored setting, so it is at its defaults.');
    expect(step.description).toContain('This sets policy HOURLY. Its level is kept as stored.');
  });

  it('says in words what NEVER means where it is requested, and only there', async () => {
    const never = await updateStep({ class: 'SMARTError', policy: 'NEVER' });
    expect(never.description).toContain(
      'POLICY NEVER SILENCES THIS CLASS: its alerts are still raised and `alerts_list` still reports them, ' +
        'but none is sent to any destination.',
    );
    const daily = await updateStep({ class: 'SMARTError', policy: 'HOURLY' });
    expect(daily.description).not.toContain('NEVER SILENCES');
  });

  it('states that changes to other classes between the read and the write are overwritten', async () => {
    for (const args of [{ class: 'SMARTError', level: 'INFO' }, { class: 'SMARTError', reset: true }]) {
      const step = await updateStep(args);
      expect(step.description).toContain(
        'A CHANGE ANYONE ELSE MAKES TO ANOTHER CLASS BETWEEN THAT READ AND THIS WRITE IS OVERWRITTEN',
      );
    }
    expect(alertClassSet.description).toContain('BETWEEN THAT READ AND THE WRITE IS OVERWRITTEN');
  });

  it('says a setting the class already holds changes nothing and is not an error', async () => {
    const step = await updateStep({ class: 'SMARTError', level: 'ERROR', policy: 'DAILY' });
    expect(step.description).toContain('It already holds that, so this changes nothing for it and is not an error.');
  });

  it('plans a reset as removing the key, and names the proactive_support it also removes', async () => {
    const step = await updateStep({ class: 'SMARTError', reset: true });
    expect(step.params).toEqual([{ classes: { UPSOnBattery: { policy: 'NEVER' } } }]);
    expect(step.description).toContain('This removes its stored setting');
    expect(step.description).toContain('This also removes its stored proactive_support setting (true).');
  });

  it('says a reset of a class with no stored setting changes nothing', async () => {
    const step = await updateStep({ class: 'ZpoolCapacityWarning', reset: true });
    expect(step.params).toEqual([{ classes: stored() }]);
    expect(step.description).toContain('It holds no stored setting already, so this changes nothing for it');
  });

  it('refuses at plan time a class the system does not list, naming it', async () => {
    await expect(alertClassSet.plan(system().ctx, { class: 'NoSuchAlert', level: 'INFO' })).rejects.toThrow(
      'No alert class "NoSuchAlert" is listed on this system',
    );
  });

  it('refuses at plan time where the class list cannot be read or is not a list', async () => {
    const failed = system(stored(), undefined, { ['alert.list_categories']: new Error('timeout') });
    await expect(alertClassSet.plan(failed.ctx, { class: 'SMARTError', level: 'INFO' })).rejects.toThrow(
      'alert.list_categories failed: timeout',
    );
    const odd = system();
    odd.rows['alert.list_categories'] = { classes: [] };
    await expect(alertClassSet.plan(odd.ctx, { class: 'SMARTError', level: 'INFO' })).rejects.toThrow(
      'No alert class "SMARTError" is listed',
    );
  });

  it('refuses at plan time where the stored map cannot be read', async () => {
    const failed = system(stored(), undefined, { ['alertclasses.config']: new Error('denied') });
    await expect(alertClassSet.plan(failed.ctx, { class: 'SMARTError', level: 'INFO' })).rejects.toThrow(
      'alertclasses.config failed: denied',
    );
    await expect(alertClassSet.plan(system(['not', 'a', 'map']).ctx, { class: 'SMARTError', level: 'INFO' })).rejects.toThrow(
      'no per-class map',
    );
  });

  it('writes every other class back unchanged, and only changes the fields named', async () => {
    const { ctx, call } = system();
    await alertClassSet.execute(ctx, { class: 'SMARTError', policy: 'IMMEDIATELY' });
    expect(call.mock.calls).toEqual([
      ['alertclasses.config'],
      [
        'alertclasses.update',
        [
          {
            classes: {
              SMARTError: { level: 'ERROR', policy: 'IMMEDIATELY', proactive_support: true, future_field: 'x' },
              UPSOnBattery: { policy: 'NEVER' },
            },
          },
        ],
      ],
    ]);
  });

  it('reads the map again when it executes, so the write carries what is stored then', async () => {
    const { ctx, call, rows } = system();
    await alertClassSet.plan(ctx, { class: 'ZpoolCapacityWarning', level: 'INFO' });
    rows['alertclasses.config'] = { id: 1, classes: { DiskTemperature: { policy: 'HOURLY' } } };
    await alertClassSet.execute(ctx, { class: 'ZpoolCapacityWarning', level: 'INFO' });
    expect(call).toHaveBeenLastCalledWith('alertclasses.update', [
      { classes: { DiskTemperature: { policy: 'HOURLY' }, ZpoolCapacityWarning: { level: 'INFO' } } },
    ]);
  });

  it('sends nothing where the read in execute fails or answers no map', async () => {
    const failed = system(stored(), undefined, { ['alertclasses.config']: new Error('reset by peer') });
    await expect(alertClassSet.execute(failed.ctx, { class: 'SMARTError', level: 'INFO' })).rejects.toThrow(
      /alertclasses.config failed: reset by peer.*nothing was sent/,
    );
    expect(failed.call).not.toHaveBeenCalledWith('alertclasses.update', expect.anything());

    const empty = system(null);
    await expect(alertClassSet.execute(empty.ctx, { class: 'SMARTError', level: 'INFO' })).rejects.toThrow(/nothing was sent/);
    expect(empty.call).not.toHaveBeenCalledWith('alertclasses.update', expect.anything());
  });

  it('reports the before and after states, reading after off the response', async () => {
    expect(await alertClassSet.execute(system().ctx, { class: 'SMARTError', level: 'CRITICAL' })).toEqual({
      class: 'SMARTError',
      requested: { level: 'CRITICAL' },
      before: { stored: true, level: 'ERROR', policy: 'DAILY', proactive_support: true },
      after: { stored: true, level: 'CRITICAL', policy: 'DAILY', proactive_support: true },
      confirmed: true,
    });
  });

  it('reports confirmed false where the response holds something other than what was sent', async () => {
    const update = { id: 1, classes: { SMARTError: { level: 'ERROR', policy: 'DAILY' } } };
    expect(
      await alertClassSet.execute(system(stored(), update).ctx, { class: 'SMARTError', level: 'CRITICAL' }),
    ).toMatchObject({ after: { stored: true, level: 'ERROR' }, confirmed: false });
    const dropped = { id: 1, classes: {} };
    expect(
      await alertClassSet.execute(system(stored(), dropped).ctx, { class: 'SMARTError', level: 'CRITICAL' }),
    ).toMatchObject({ after: { stored: false, level: null, policy: null }, confirmed: false });
  });

  it('reports confirmed null where the response carries no readable map or field', async () => {
    expect(
      await alertClassSet.execute(system(stored(), null).ctx, { class: 'SMARTError', level: 'CRITICAL' }),
    ).toMatchObject({
      after: { stored: null, level: null, policy: null, proactive_support: null },
      confirmed: null,
    });
    const unreadable = { id: 1, classes: { SMARTError: { level: 3 } } };
    expect(
      await alertClassSet.execute(system(stored(), unreadable).ctx, { class: 'SMARTError', level: 'CRITICAL' }),
    ).toMatchObject({ after: { stored: true, level: null }, confirmed: null });
  });

  it('confirms a reset by the class being absent from the response, and not otherwise', async () => {
    expect(await alertClassSet.execute(system().ctx, { class: 'SMARTError', reset: true })).toEqual({
      class: 'SMARTError',
      requested: { reset: true },
      before: { stored: true, level: 'ERROR', policy: 'DAILY', proactive_support: true },
      after: { stored: false, level: null, policy: null, proactive_support: null },
      confirmed: true,
    });
    const kept = { id: 1, classes: stored() };
    expect(await alertClassSet.execute(system(stored(), kept).ctx, { class: 'SMARTError', reset: true })).toMatchObject({
      after: { stored: true },
      confirmed: false,
    });
  });

  it('executes only against a confirmation token minted from its own plan', async () => {
    const { ctx, call } = system();
    const registry = new SystemRegistry();
    registry.add(ctx.system);
    const catalog = new ToolCatalog();
    catalog.register(alertClassSet);
    const confirmations = new ConfirmationService();
    const executor = new ToolExecutor({ catalog, registry, confirmations });
    const args = { class: 'SMARTError', policy: 'NEVER' };

    const first = await executor.execute('alert_class_set', args);
    expect(first.type).toBe('PLAN');
    expect(call).not.toHaveBeenCalledWith('alertclasses.update', expect.anything());

    await expect(executor.execute('alert_class_set', { ...args, confirmation_token: 'forged' })).rejects.toThrow();
    expect(call).not.toHaveBeenCalledWith('alertclasses.update', expect.anything());

    const token = confirmations.mint(first.type === 'PLAN' ? first.key : '');
    const confirmed = await executor.execute('alert_class_set', { ...args, confirmation_token: token });
    expect(confirmed.type).toBe('RESULTS');
    expect(call).toHaveBeenCalledWith('alertclasses.update', expect.anything());
  });

  it('is pointed at from alert_settings and alerts_dismiss', () => {
    expect(alertSettings.description).toContain('`alert_class_set` changes one');
    expect(alertsDismiss.description).toContain('`alert_class_set` changes them');
  });
});
