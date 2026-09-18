import { describe, expect, it, vi } from 'vitest';
import { concat, EMPTY, NEVER, Observable, of, throwError } from 'rxjs';
import { Role } from '@/interfaces';
import { PlanStep, SystemHandle, ToolContext } from '@/catalog/tool';
import { fakeSystem } from '@/testing/fake-systems';
import { serviceControl, servicesStatus } from '@/tools/index';

describe('services_status', () => {
  /** A service row as `service.query` reports one. */
  const service = (over: Record<string, unknown> = {}) => ({
    id: 4,
    service: 'cifs',
    enable: true,
    state: 'RUNNING',
    pids: [2451, 2452],
    ...over,
  });

  const listed = async (rows: unknown[]): Promise<Record<string, unknown>[]> => {
    const { ctx } = fakeSystem({ ['service.query']: rows });
    return (await servicesStatus.handler(ctx, {})) as Record<string, unknown>[];
  };

  /** One service, differing only in the fields the case is about. */
  const one = async (over: Record<string, unknown>): Promise<Record<string, unknown>> =>
    (await listed([service(over)]))[0];

  it('maps a service to its name, boot setting and run state', async () => {
    expect(await listed([service()])).toEqual([
      { service: 'cifs', start_on_boot: true, state: 'RUNNING' },
    ]);
  });

  it('reports the middleware name rather than the protocol as a person says it', async () => {
    // The whole reason the description carries the `cifs`/`iscsitarget`
    // examples: a caller matching on "SMB" finds nothing, and a remapping here
    // would be a second vocabulary to keep in step with TrueNAS's own.
    const rows = await listed([
      service({ service: 'cifs' }),
      service({ id: 5, service: 'iscsitarget' }),
      service({ id: 6, service: 'nfs' }),
    ]);
    expect(rows.map((row) => row['service'])).toEqual(['cifs', 'iscsitarget', 'nfs']);
  });

  it('carries no field the tool does not name, including one a later release adds', async () => {
    const rows = await listed([service({ ha_propagate: true })]);
    expect(Object.keys(rows[0])).toEqual(['service', 'start_on_boot', 'state']);
  });

  it('does not report a service\'s process ids', async () => {
    const rows = await listed([service({ pids: [2451, 2452] })]);
    expect(rows[0]).not.toHaveProperty('pids');
    expect(JSON.stringify(rows)).not.toContain('2451');
  });

  it('does not report the middleware row id', async () => {
    const rows = await listed([service({ id: 4 })]);
    expect(rows[0]).not.toHaveProperty('id');
  });

  it('keeps the boot setting and the run state apart', async () => {
    // The mismatch is the finding the tool exists for, so the two fields have
    // to disagree where the system says they disagree rather than being folded
    // into one reading.
    expect(await one({ enable: true, state: 'STOPPED' })).toEqual({
      service: 'cifs',
      start_on_boot: true,
      state: 'STOPPED',
    });
    expect(await one({ enable: false, state: 'RUNNING' })).toEqual({
      service: 'cifs',
      start_on_boot: false,
      state: 'RUNNING',
    });
  });

  it('reports a state outside the known set as the word the system used', async () => {
    // `state` is typed `string` rather than a union, so a release that grows a
    // third word must not have it coerced into one of the two known ones.
    expect(await one({ state: 'STARTING' })).toMatchObject({ state: 'STARTING' });
    expect(await one({ state: 'FAILED' })).toMatchObject({ state: 'FAILED' });
  });

  it('reports a state it could not read as null rather than as stopped', async () => {
    expect(await one({ state: '' })).toMatchObject({ state: null });
    expect(await one({ state: null })).toMatchObject({ state: null });
    expect(await one({ state: 0 })).toMatchObject({ state: null });
  });

  it('reports a boot setting it could not read as null rather than as false', async () => {
    expect(await one({ enable: null })).toMatchObject({ start_on_boot: null });
    expect(await one({ enable: 'true' })).toMatchObject({ start_on_boot: null });
    expect(await one({ enable: 1 })).toMatchObject({ start_on_boot: null });
  });

  it('reports a name it could not read as null, so the row matches no protocol', async () => {
    expect(await one({ service: '' })).toMatchObject({ service: null });
    expect(await one({ service: null })).toMatchObject({ service: null });
    expect(await one({ service: 7 })).toMatchObject({ service: null });
  });

  it('returns nothing for a system that reported no services', async () => {
    expect(await listed([])).toEqual([]);
  });

  it('asks for the services', async () => {
    const { ctx, query } = fakeSystem({ ['service.query']: [] });
    await servicesStatus.handler(ctx, {});
    expect(query).toHaveBeenCalledWith('service.query');
  });

  it('points at the tool that changes a service, since this one changes nothing', () => {
    expect(servicesStatus.description).toContain('`service_control` is what starts, stops or');
  });
});

/**
 * `service_control`'s tests live here under #87's default: `services.spec.ts` is
 * a few hundred lines with this block in it, well under the 1,500-line split
 * trigger, so the tests go in the spec named for the module they cover.
 *
 * The fake system is local rather than `fakeSystem`, for the reason
 * `snapshot-task-run.spec.ts` and `vm-stop.spec.ts` give about theirs: a job is a
 * stream rather than a response, `src/testing/fake-systems.ts` stubs `call` and
 * `query` off one method→response map, and this one has to move the correlation
 * and the tracking independently AND answer two reads of `service.query`
 * differently. That is a fourth caller for a shared job fixture rather than a
 * reason to design one here.
 */
describe('service_control', () => {
  /** A service row as `service.query` answers with one. */
  const row = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: 4,
    service: 'cifs',
    enable: true,
    state: 'RUNNING',
    pids: [2451],
    ...over,
  });

  /** A job as the client's tracking emits one. */
  const jobAt = (state: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: 88,
    method: 'service.control',
    state,
    // A boolean on this method, unlike `vm.stop` and `cloudsync.sync` — which is
    // why `control_result` exists at all.
    result: true,
    error: null,
    time_finished: { $date: 1_756_000_000_000 },
    ...extra,
  });

  /** One answer to a `service.query` read: the rows it listed, or the failure that stopped it. */
  type Read = { rows: unknown[] } | { fails: unknown };

  /**
   * A system answering `service.query` from a queue, correlating a started job's
   * id through `callAndGetJobId` and following it through `trackJob`.
   */
  function jobSystem(
    options: { reads?: Read[]; started?: Observable<number>; job?: Observable<unknown> } = {},
  ): {
    ctx: ToolContext;
    query: ReturnType<typeof vi.fn>;
    start: ReturnType<typeof vi.fn>;
    track: ReturnType<typeof vi.fn>;
  } {
    const reads = options.reads ?? [{ rows: [row()] }];
    let index = 0;
    const query = vi.fn(() => {
      const read = reads[Math.min(index, reads.length - 1)];
      index += 1;
      return 'fails' in read ? throwError(() => read.fails) : of(read.rows);
    });
    const start = vi.fn(() => options.started ?? of(88));
    const track = vi.fn(() => options.job ?? of(jobAt('SUCCESS')));
    const system = {
      name: 'nas',
      client: { api: { query, callAndGetJobId: start, trackJob: track } },
    } as unknown as SystemHandle;
    return { ctx: { system }, query, start, track };
  }

  const startArgs = { service: 'cifs', verb: 'START' };

  /** The two steps the plan returns, typed. */
  const planSteps = async (
    ctx: ToolContext,
    args: Record<string, unknown> = startArgs,
  ): Promise<PlanStep[]> => {
    const steps = await serviceControl.plan(ctx, args);
    expect(steps).toHaveLength(2);
    return steps;
  };

  /** The mutation step's description, which is what most of the plan tests read. */
  const planText = async (
    rows: unknown[],
    args: Record<string, unknown> = startArgs,
  ): Promise<string> =>
    (await planSteps(jobSystem({ reads: [{ rows }] }).ctx, args))[1].description;

  it('is a reversible mutating tool needing the full role', () => {
    expect(serviceControl).toMatchObject({
      name: 'service_control',
      mutating: true,
      // The operation is undone by the opposite verb of this same tool. What a
      // stop does to the clients that were connected is not, and this field
      // cannot say both: the description carries that account.
      destructiveness: 'reversible',
      requiredRole: Role.Full,
    });
  });

  it('takes the service name and the verb, and offers three verbs', () => {
    const schema = serviceControl.inputSchema as {
      properties: Record<string, { enum?: string[] }>;
      required: string[];
    };
    expect(Object.keys(schema.properties)).toEqual(['service', 'verb']);
    expect(schema.required).toEqual(['service', 'verb']);
    // RELOAD is the fourth verb the method declares and is deliberately absent:
    // the reachable surface is not the scope.
    expect(schema.properties['verb'].enum).toEqual(['START', 'STOP', 'RESTART']);
  });

  describe('description', () => {
    it('says RELOAD is not offered, rather than leaving it unmentioned', () => {
      expect(serviceControl.description).toContain(
        'THE MIDDLEWARE ALSO DEFINES `RELOAD` AND THIS TOOL DOES NOT OFFER IT',
      );
    });

    it('says a service already in the requested state is not an error', () => {
      expect(serviceControl.description).toContain(
        'A SERVICE ALREADY IN THE STATE THE VERB AIMS AT IS NOT AN ERROR HERE',
      );
      expect(serviceControl.description).toContain('(unconfirmed)');
    });

    it('says stopping or restarting disconnects every client using the service', () => {
      expect(serviceControl.description).toContain(
        'STOPPING OR RESTARTING A SERVICE DISCONNECTS EVERY CLIENT USING IT',
      );
    });

    it('says the state is read back rather than inferred from the call being accepted', () => {
      expect(serviceControl.description).toContain(
        'THE STATES ARE READ BACK FROM THE SYSTEM RATHER THAN INFERRED FROM THE CALL BEING ACCEPTED',
      );
    });

    it('says it does not change whether a service starts at boot', () => {
      expect(serviceControl.description).toContain(
        'THIS TOOL DOES NOT CHANGE WHETHER A SERVICE STARTS AT BOOT',
      );
    });

    it('does not partition a false ended', () => {
      expect(serviceControl.description).toContain('FALSE MEANS NOTHING WAS ESTABLISHED');
      expect(serviceControl.description).toContain('DO NOT PARTITION IT');
    });

    it('says a changed of false across a restart is the ordinary answer', () => {
      expect(serviceControl.description).toContain(
        'A `changed: false` ACROSS A RESTART IS THE ORDINARY ANSWER FOR A SUCCESSFUL ONE',
      );
    });
  });

  describe('normalizeArgs', () => {
    it('drops the executor arguments and keeps the two it takes', () => {
      expect(serviceControl.normalizeArgs?.({ ...startArgs, systems: 'all' })).toEqual({
        service: 'cifs',
        verb: 'START',
      });
    });

    it.each([{}, { verb: 'START' }, { service: '', verb: 'START' }, { service: 7, verb: 'START' }])(
      'refuses a service name it cannot read: %o',
      (args) => {
        expect(() => serviceControl.normalizeArgs?.(args)).toThrow('"service" is required');
      },
    );

    it.each([{ service: 'cifs' }, { service: 'cifs', verb: 'RELOAD' }])(
      'refuses a verb it does not offer: %o',
      (args) => {
        expect(() => serviceControl.normalizeArgs?.(args)).toThrow(
          '"verb" is required and must be one of START, STOP, RESTART',
        );
      },
    );

    it('refuses a lower-case verb rather than folding its case', () => {
      // A caller spelling it `start` is working from a different vocabulary, and
      // answering silently leaves them believing this tool takes words it does
      // not.
      expect(() => serviceControl.normalizeArgs?.({ service: 'cifs', verb: 'start' })).toThrow(
        '"verb" is required',
      );
    });

    it('names RELOAD in the refusal, so a caller can tell an omission from an oversight', () => {
      expect(() => serviceControl.normalizeArgs?.({ service: 'cifs', verb: 'RELOAD' })).toThrow(
        'a reload leaves the service running',
      );
    });
  });

  describe('plan', () => {
    it('names the read and the mutation, in the order execute makes them', async () => {
      const steps = await planSteps(jobSystem().ctx);
      expect(steps.map((step) => step.method)).toEqual(['service.query', 'service.control']);
      // The verb first and the service second, which is the order the method
      // declares — and no options record, since this tool offers none.
      expect(steps[1].params).toEqual(['START', 'cifs']);
    });

    it("makes every read with the params the plan's read step named", async () => {
      // Two halves, each against its own literal: the step names the two
      // positional params the call reaches the middleware with, since
      // `api.query(method, filters)` dispatches `[filters ?? [], options ?? {}]`,
      // and the JS call passes neither.
      const { ctx, query } = jobSystem();
      const [read] = await planSteps(ctx);
      await serviceControl.execute(ctx, startArgs);
      expect(read.params).toEqual([[], {}]);
      expect(query.mock.calls).toEqual([
        ['service.query'],
        ['service.query'],
        ['service.query'],
      ]);
    });

    it('says the second read happens when the watch ends, not immediately', async () => {
      const [read] = await planSteps(jobSystem().ctx);
      expect(read.description).toContain('Changes nothing');
      expect(read.description).toContain(
        'WHEN THE WATCH BELOW ENDS — UP TO 30 SECONDS AFTER THIS CALL IS MADE, AND NOT WHEN THE OPERATION FINISHES',
      );
    });

    it('fails naming a service the system does not have, and lists the ones it does', async () => {
      const { ctx } = jobSystem({
        reads: [{ rows: [row(), row({ id: 5, service: 'nfs' }), row({ id: 6, service: 'ssh' })] }],
      });
      await expect(serviceControl.plan(ctx, { service: 'smb', verb: 'START' })).rejects.toThrow(
        'No service named "smb" on this system. The names that would have worked are: cifs, nfs, ssh',
      );
    });

    it('says so rather than offering an empty list where the system listed nothing', async () => {
      const { ctx } = jobSystem({ reads: [{ rows: [] }] });
      await expect(serviceControl.plan(ctx, startArgs)).rejects.toThrow(
        'This system listed no services at all',
      );
    });

    it('leaves a row whose name could not be read out of the names that would have worked', async () => {
      // A null name matches nothing and naming it would offer a caller a name
      // that cannot be passed.
      const { ctx } = jobSystem({ reads: [{ rows: [row({ service: null }), row({ id: 5, service: 'nfs' })] }] });
      await expect(serviceControl.plan(ctx, { service: 'smb', verb: 'START' })).rejects.toThrow(
        'would have worked are: nfs.',
      );
    });

    it('matches the middleware name exactly rather than the protocol as a person says it', async () => {
      const { ctx } = jobSystem({ reads: [{ rows: [row({ service: 'cifs' })] }] });
      await expect(serviceControl.plan(ctx, { service: 'CIFS', verb: 'START' })).rejects.toThrow(
        'No service named "CIFS"',
      );
    });

    it('states the state read at plan time and that it is not re-checked', async () => {
      expect(await planText([row()])).toContain(
        'Its state read as `RUNNING` when this plan was made',
      );
      expect(await planText([row()])).toContain('IS NOT RE-CHECKED');
    });

    it('says what a state it could not read leaves unestablished', async () => {
      expect(await planText([row({ state: null })])).toContain(
        'The state it is in could not be read when this plan was made',
      );
    });

    it('does not refuse a service already in the state the verb aims at', async () => {
      const text = await planText([row({ state: 'RUNNING' })]);
      expect(text).toContain('IT ALREADY READ AS `RUNNING` WHEN THIS PLAN WAS MADE');
      expect(text).toContain('THIS PLAN DOES NOT REFUSE THAT');
      expect(text).toContain('(unconfirmed)');
    });

    it('does not predict what the result will say about a service already in that state', async () => {
      // `previously_state` and `changed` are read at execute time, so a plan
      // promising `changed: false` is false for a service someone moves between
      // the plan and its confirmation — and false again where that read cannot
      // be made at all, which `starts the job where the read before it failed`
      // below exercises.
      const text = await planText([row({ state: 'RUNNING' })]);
      expect(text).toContain('WHAT THE RESULT WILL SAY IS NOT PREDICTED FROM THE READING ABOVE');
      expect(text).toContain('a FRESH read made immediately before the call');
      expect(text).not.toContain('`changed` comes back false');
    });

    it('says the same of a stop against a service already stopped', async () => {
      const text = await planText([row({ state: 'STOPPED' })], { service: 'cifs', verb: 'STOP' });
      expect(text).toContain('IT ALREADY READ AS `STOPPED` WHEN THIS PLAN WAS MADE');
    });

    it('makes no already-in-state claim for a restart, whatever the state', async () => {
      // A restart aims at RUNNING and a running service is still restarted, so
      // the sentence would be false of the operation.
      const text = await planText([row({ state: 'RUNNING' })], {
        service: 'cifs',
        verb: 'RESTART',
      });
      expect(text).not.toContain('ALREADY READ AS');
    });

    it('states what a stop takes off the network and what it interrupts', async () => {
      const text = await planText([row()], { service: 'cifs', verb: 'STOP' });
      expect(text).toContain('STOPPING THIS SERVICE TAKES IT OFF THE NETWORK');
      expect(text).toContain('EVERY CLIENT CONNECTED THROUGH THIS SERVICE IS DISCONNECTED');
      expect(text).toContain('NOTHING HERE RECOVERS THAT');
    });

    it('says a restart is not a reload and that the stop half happens first', async () => {
      const text = await planText([row()], { service: 'cifs', verb: 'RESTART' });
      expect(text).toContain('A RESTART STOPS THE SERVICE AND STARTS IT AGAIN');
      expect(text).toContain('the stop half happens first');
    });

    it('says a start interrupts nothing that is already running', async () => {
      expect(await planText([row()])).toContain('Starting a service interrupts nothing');
    });

    it('says the boot setting is not changed, whichever way it reads', async () => {
      expect(await planText([row({ enable: true })])).toContain(
        'This service IS set to start at boot, and THIS CALL DOES NOT CHANGE THAT',
      );
      expect(await planText([row({ enable: false })])).toContain(
        'This service is NOT set to start at boot, and THIS CALL DOES NOT CHANGE THAT',
      );
      expect(await planText([row({ enable: null })])).toContain(
        'could not be read, and THIS CALL DOES NOT CHANGE IT EITHER WAY',
      );
    });

    it('names the watch and says the operation continues past it', async () => {
      expect(await planText([row()])).toContain(
        'for at most 30 seconds. The operation continues after that',
      );
    });

    it('lets a plan-time read failure fail the plan', async () => {
      const { ctx } = jobSystem({ reads: [{ fails: new Error('middleware is down') }] });
      await expect(serviceControl.plan(ctx, startArgs)).rejects.toThrow('middleware is down');
    });

    it('rejects arguments it cannot read before making any call', async () => {
      const { ctx, query } = jobSystem();
      await expect(serviceControl.plan(ctx, { service: 'cifs', verb: 'RELOAD' })).rejects.toThrow(
        '"verb" is required',
      );
      expect(query).not.toHaveBeenCalled();
    });
  });

  describe('execute', () => {
    it('starts the job through the job surface, with the params the plan named', async () => {
      const { ctx, start, track } = jobSystem();
      await serviceControl.execute(ctx, startArgs);
      expect(start).toHaveBeenCalledWith('service.control', ['START', 'cifs']);
      // And follows the job the client correlated, rather than one it named.
      expect(track).toHaveBeenCalledWith(88);
    });

    it('reports the two readings, the job and the bound that applied', async () => {
      const { ctx } = jobSystem({
        reads: [{ rows: [row({ state: 'RUNNING' })] }, { rows: [row({ state: 'STOPPED' })] }],
      });
      expect(await serviceControl.execute(ctx, { service: 'cifs', verb: 'STOP' })).toEqual({
        service: 'cifs',
        verb: 'STOP',
        expected_state: 'STOPPED',
        previous_lookup: 'FOUND',
        previous_read_error: null,
        previously_state: 'RUNNING',
        resulting_lookup: 'FOUND',
        resulting_read_error: null,
        resulting_state: 'STOPPED',
        changed: true,
        watched_seconds: 30,
        job_id: 88,
        ended: true,
        succeeded: true,
        job_state: 'SUCCESS',
        error: null,
        finished_at: '2025-08-24T01:46:40.000Z',
        control_result: true,
      });
    });

    it('succeeds and reports a service that was already running as already running', async () => {
      // #164's first acceptance criterion, and it falls out of the read-back
      // rather than being special-cased: both readings are RUNNING.
      expect(await serviceControl.execute(jobSystem().ctx, startArgs)).toMatchObject({
        previously_state: 'RUNNING',
        resulting_state: 'RUNNING',
        expected_state: 'RUNNING',
        changed: false,
      });
    });

    it('succeeds and reports a service that was already stopped as already stopped', async () => {
      const { ctx } = jobSystem({ reads: [{ rows: [row({ state: 'STOPPED' })] }] });
      expect(await serviceControl.execute(ctx, { service: 'cifs', verb: 'STOP' })).toMatchObject({
        previously_state: 'STOPPED',
        resulting_state: 'STOPPED',
        changed: false,
      });
    });

    it('reports a restart as running only where the system said it is', async () => {
      const { ctx } = jobSystem({
        reads: [{ rows: [row({ state: 'RUNNING' })] }, { rows: [row({ state: 'RUNNING' })] }],
      });
      expect(await serviceControl.execute(ctx, { service: 'cifs', verb: 'RESTART' })).toMatchObject({
        resulting_state: 'RUNNING',
        // Which is the ordinary answer for a restart that worked.
        changed: false,
      });
    });

    it('fails naming the state the service is in where the job ended somewhere else', async () => {
      const { ctx } = jobSystem({
        reads: [{ rows: [row({ state: 'STOPPED' })] }, { rows: [row({ state: 'STOPPED' })] }],
        job: of(jobAt('FAILED', { error: 'cifs refused to start', result: false })),
      });
      await expect(serviceControl.execute(ctx, startArgs)).rejects.toThrow(
        'The START of "cifs" on this system finished and the service did NOT reach `RUNNING`: it is in `STOPPED` instead',
      );
    });

    it('carries the job id and what the job recorded into that failure', async () => {
      const { ctx } = jobSystem({
        reads: [{ rows: [row({ state: 'STOPPED' })] }],
        job: of(jobAt('FAILED', { error: 'cifs refused to start', result: false })),
      });
      const failure = serviceControl.execute(ctx, startArgs);
      await expect(failure).rejects.toThrow('job id 88');
      await expect(failure).rejects.toThrow('The job recorded: cifs refused to start');
      await expect(failure).rejects.toThrow('The middleware answered `false`');
      await expect(failure).rejects.toThrow('Read `services_status`');
    });

    it('names only what the job actually recorded in that failure', async () => {
      // No id this tool could read, no error text, no readable control boolean:
      // each clause is left out rather than reported as a null.
      const { ctx } = jobSystem({
        reads: [{ rows: [row({ state: 'STOPPED' })] }],
        started: of('eighty-eight' as unknown as number),
        job: of(jobAt('SUCCESS', { error: null, result: 'yes' })),
      });
      const message = await serviceControl
        .execute(ctx, startArgs)
        .then(() => 'it did not fail')
        .catch((reason: unknown) => (reason as Error).message);
      expect(message).toContain('the job ended in state `SUCCESS`. Read `services_status`');
      expect(message).not.toContain('job id');
      expect(message).not.toContain('The job recorded');
      expect(message).not.toContain('The middleware answered');
    });

    it('does not call a service still on its way a failure when the watch ran out', async () => {
      vi.useFakeTimers();
      try {
        const { ctx } = jobSystem({
          reads: [{ rows: [row({ state: 'RUNNING' })] }, { rows: [row({ state: 'STOPPING' })] }],
          job: concat(of(jobAt('RUNNING')), NEVER),
        });
        const pending = serviceControl.execute(ctx, { service: 'cifs', verb: 'STOP' });
        await vi.advanceTimersByTimeAsync(30_000);
        expect(await pending).toMatchObject({
          ended: false,
          resulting_state: 'STOPPING',
          expected_state: 'STOPPED',
          changed: true,
          control_result: null,
        });
      } finally {
        vi.useRealTimers();
      }
    });

    it('does not fail where the read after the watch could not be made', async () => {
      const { ctx } = jobSystem({
        reads: [{ rows: [row()] }, { fails: new Error('connection dropped') }],
      });
      expect(await serviceControl.execute(ctx, startArgs)).toMatchObject({
        resulting_lookup: 'UNREADABLE',
        resulting_read_error: 'connection dropped',
        resulting_state: null,
        changed: null,
        // And the job it started is still reported.
        ended: true,
      });
    });

    it('does not fail where the read completed and listed no such service', async () => {
      // Which is this tool being unable to say, not the system saying the
      // service is in the wrong state.
      const { ctx } = jobSystem({ reads: [{ rows: [row()] }, { rows: [] }] });
      expect(await serviceControl.execute(ctx, startArgs)).toMatchObject({
        resulting_lookup: 'NOT_FOUND',
        resulting_state: null,
        changed: null,
      });
    });

    it('does not fail where the service reported a state it could not read', async () => {
      const { ctx } = jobSystem({ reads: [{ rows: [row()] }, { rows: [row({ state: '' })] }] });
      expect(await serviceControl.execute(ctx, startArgs)).toMatchObject({
        resulting_lookup: 'FOUND',
        resulting_state: null,
        changed: null,
      });
    });

    it('starts the job where the read before it failed, and reports why', async () => {
      const { ctx, start } = jobSystem({
        reads: [{ fails: new Error('read refused') }, { rows: [row()] }],
      });
      expect(await serviceControl.execute(ctx, startArgs)).toMatchObject({
        previous_lookup: 'UNREADABLE',
        previous_read_error: 'read refused',
        previously_state: null,
        changed: null,
      });
      expect(start).toHaveBeenCalledTimes(1);
    });

    it('counts FINISHED as success too', async () => {
      const { ctx } = jobSystem({ job: of(jobAt('FINISHED')) });
      expect(await serviceControl.execute(ctx, startArgs)).toMatchObject({ succeeded: true });
    });

    it('reads a terminal state this catalog does not know as ended and not a success', async () => {
      const { ctx } = jobSystem({ job: of(jobAt('SUPERSEDED')) });
      expect(await serviceControl.execute(ctx, startArgs)).toMatchObject({
        ended: true,
        succeeded: false,
        job_state: 'SUPERSEDED',
      });
    });

    it('reports the control boolean the middleware answered, where the job ended', async () => {
      const { ctx } = jobSystem({ job: of(jobAt('SUCCESS', { result: false })) });
      // False beside a state that IS the expected one is the two disagreeing,
      // and the state is what the outcome is taken from — so this is reported
      // rather than raised.
      expect(await serviceControl.execute(ctx, startArgs)).toMatchObject({
        control_result: false,
        resulting_state: 'RUNNING',
      });
    });

    it('reports no control result for a boolean it could not read', async () => {
      const { ctx } = jobSystem({ job: of(jobAt('SUCCESS', { result: 'yes' })) });
      expect(await serviceControl.execute(ctx, startArgs)).toMatchObject({ control_result: null });
    });

    it('reports no finish time for an ended job that recorded none it can read', async () => {
      const { ctx } = jobSystem({ job: of(jobAt('SUCCESS', { time_finished: 'yesterday' })) });
      expect(await serviceControl.execute(ctx, startArgs)).toMatchObject({ finished_at: null });
    });

    it('reports no error text where the job recorded an empty one', async () => {
      const { ctx } = jobSystem({ job: of(jobAt('SUCCESS', { error: '' })) });
      expect(await serviceControl.execute(ctx, startArgs)).toMatchObject({ error: null });
    });

    it('establishes nothing from a job it never saw, and does not call that a failure', async () => {
      const { ctx, track } = jobSystem({ started: EMPTY });
      expect(await serviceControl.execute(ctx, startArgs)).toMatchObject({
        job_id: null,
        ended: false,
        succeeded: null,
        job_state: null,
        control_result: null,
      });
      expect(track).not.toHaveBeenCalled();
    });

    it('keeps the id of a job the client named and then reported nothing about', async () => {
      const { ctx } = jobSystem({ job: EMPTY });
      expect(await serviceControl.execute(ctx, startArgs)).toMatchObject({
        job_id: 88,
        ended: false,
        job_state: null,
      });
    });

    it('establishes nothing from an emission carrying no readable state', async () => {
      const { ctx } = jobSystem({ job: of(jobAt('SUCCESS', { state: 42 })) });
      expect(await serviceControl.execute(ctx, startArgs)).toMatchObject({
        job_id: 88,
        ended: false,
        succeeded: null,
        job_state: null,
      });
    });

    it('reports no job id where the event carried none this tool can read', async () => {
      const { ctx } = jobSystem({ started: of('eighty-eight' as unknown as number) });
      expect(await serviceControl.execute(ctx, startArgs)).toMatchObject({
        job_id: null,
        succeeded: true,
      });
    });

    it('lets a rejected call fail, since there is then no operation to report on', async () => {
      const { ctx } = jobSystem({ started: throwError(() => new Error('not authorised')) });
      await expect(serviceControl.execute(ctx, startArgs)).rejects.toThrow('not authorised');
    });

    it('does not fail the call when the FOLLOW-UP READ fails before reporting anything', async () => {
      // `trackJob` starts by dispatching `core.get_jobs`, which can fail on its
      // own — after the event correlated the id, so the operation is going.
      const { ctx } = jobSystem({ job: throwError(() => new Error('core.get_jobs failed')) });
      expect(await serviceControl.execute(ctx, startArgs)).toMatchObject({
        job_id: 88,
        ended: false,
        job_state: null,
      });
    });

    it('keeps the job id when following the job fails after it has been seen', async () => {
      const { ctx } = jobSystem({
        job: concat(of(jobAt('RUNNING')), throwError(() => new Error('connection dropped'))),
      });
      expect(await serviceControl.execute(ctx, startArgs)).toMatchObject({
        job_id: 88,
        ended: false,
        succeeded: null,
        job_state: 'RUNNING',
      });
    });

    it('does not report a job as ended because following it stopped', async () => {
      const { ctx } = jobSystem({
        job: concat(of(jobAt('SUCCESS')), throwError(() => new Error('connection dropped'))),
      });
      expect(await serviceControl.execute(ctx, startArgs)).toMatchObject({
        job_state: 'SUCCESS',
        ended: false,
        succeeded: null,
        finished_at: null,
        control_result: null,
      });
    });

    it('rejects arguments it cannot read before making any call', async () => {
      const { ctx, start } = jobSystem();
      await expect(serviceControl.execute(ctx, { service: '', verb: 'START' })).rejects.toThrow(
        '"service" is required',
      );
      expect(start).not.toHaveBeenCalled();
    });
  });
});
