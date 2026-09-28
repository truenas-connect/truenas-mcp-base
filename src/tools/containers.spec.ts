import { afterEach, describe, expect, it, vi } from 'vitest';
import { Role } from '@/interfaces';
import { PlanStep } from '@/catalog/tool';
import { containerList, containerRestart, containerStart, containerStop } from '@/tools/index';
import { opsSystem, opsSystemWithoutVersion } from '@/testing/ops-systems';
import type { OpsAnswers, OpsVersion } from '@/testing/ops-systems';

/**
 * These specs drive the CLIENT'S OWN version mapping over a fake `api` seam —
 * #173's option 2 — rather than faking `client.ops`. The reasoning is in
 * `containers.ts`'s header and in `src/testing/ops-systems.ts`; what it buys is
 * visible in three places below, each marked, where the shape the tool has to
 * read is produced by the real mapping and is not what a hand-written fake would
 * have been written to emit.
 *
 * The fixture is local to the `ops` seam and NOT in `fake-systems.ts`, which
 * every other tool spec imports.
 */

/** A `virt.instance.query` row, as TrueNAS 25.10 answers with one. */
const virtRow = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'web',
  name: 'web',
  type: 'CONTAINER',
  status: 'RUNNING',
  cpu: '2-4',
  memory: 2048,
  autostart: true,
  image: {
    architecture: 'amd64',
    description: 'Debian 12',
    os: 'Debian',
    release: 'bookworm',
    serial: '20250101',
    type: 'container',
    variant: 'default',
    secureboot: null,
  },
  ...extra,
});

/** A `container.query` row, as TrueNAS 26 and later answer with one. */
const containerRow = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 7,
  uuid: 'c0ffee',
  name: 'web',
  description: 'the web container',
  autostart: true,
  dataset: 'tank/containers/web',
  status: { state: 'RUNNING', pid: 1234, domain_state: 'running' },
  ...extra,
});

/** A job record as the middleware reports one mid-run. */
const runningJob = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 11,
  state: 'RUNNING',
  ...extra,
});

/** A job record as the middleware reports a finished run. */
const finishedJob = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 11,
  state: 'SUCCESS',
  error: null,
  time_finished: { $date: 1_700_000_000_000 },
  ...extra,
});

/** The query method each version's mapping dials. */
const QUERY: Record<OpsVersion, string> = {
  'v25.10.0': 'virt.instance.query',
  'v26.0.0': 'container.query',
  'v27.0.0': 'container.query',
};

/** A row of the kind the named version's query answers with. */
const rowFor = (version: OpsVersion, extra: Record<string, unknown> = {}): Record<string, unknown> =>
  version === 'v25.10.0' ? virtRow(extra) : containerRow(extra);

/** A system of that version listing one container, plus whatever else is asked for. */
const listing = (version: OpsVersion, answers: OpsAnswers = {}): OpsAnswers => ({
  [QUERY[version]]: { emits: [[rowFor(version)]] },
  ...answers,
});

afterEach(() => {
  vi.useRealTimers();
});

describe('container_list', () => {
  it('is a read-only tool any credential may use, and takes no arguments', () => {
    expect(containerList).toMatchObject({
      name: 'container_list',
      mutating: false,
      requiredRole: Role.ReadOnly,
    });
    expect(containerList.inputSchema).toEqual({ type: 'object', properties: {} });
  });

  it('reaches the version-agnostic query and never a named container method', async () => {
    const { ctx, query } = opsSystem('v25.10.0', listing('v25.10.0'));
    await containerList.handler(ctx, {});
    expect(query.mock.calls).toEqual([['virt.instance.query', [['type', '=', 'CONTAINER']]]]);
  });

  it('reaches container.query on the newer versions, from the same tool', async () => {
    const { ctx, query } = opsSystem('v26.0.0', listing('v26.0.0'));
    await containerList.handler(ctx, {});
    expect(query.mock.calls).toEqual([['container.query']]);
  });

  it('reports the fields TrueNAS 25.10 populates, and nulls the ones it does not', async () => {
    // WHAT OPTION 2 BUYS (1/3). The split below is the real mapping's, not this
    // spec's: `toContainer` sets cpu, memory and image and never description.
    const { ctx } = opsSystem('v25.10.0', listing('v25.10.0'));
    expect(await containerList.handler(ctx, {})).toEqual({
      api_version: 'v25.10.0',
      containers: [
        {
          id: 'web',
          name: 'web',
          status: 'RUNNING',
          autostart: true,
          description: null,
          cpu: '2-4',
          memory: 2048,
          image_description: 'Debian 12',
        },
      ],
    });
  });

  it('reports the fields TrueNAS 26 populates, which are the other ones', async () => {
    const { ctx } = opsSystem('v26.0.0', listing('v26.0.0'));
    expect(await containerList.handler(ctx, {})).toEqual({
      api_version: 'v26.0.0',
      containers: [
        {
          id: '7',
          name: 'web',
          status: 'RUNNING',
          autostart: true,
          description: 'the web container',
          cpu: null,
          memory: null,
          image_description: null,
        },
      ],
    });
  });

  it('answers the same way on v27 as on v26', async () => {
    const { ctx } = opsSystem('v27.0.0', listing('v27.0.0'));
    expect(await containerList.handler(ctx, {})).toMatchObject({
      api_version: 'v27.0.0',
      containers: [{ id: '7', description: 'the web container', cpu: null }],
    });
  });

  it('reads one field out of the image record and forwards none of the rest', async () => {
    // `Container.image` is DECLARED as `{ description }` and the 25.10 mapping
    // spreads the whole `VirtInstanceImage` into it. Nothing but the description
    // may reach a result, whatever else the record carried.
    const { ctx } = opsSystem('v25.10.0', listing('v25.10.0'));
    const result = (await containerList.handler(ctx, {})) as {
      containers: Record<string, unknown>[];
    };
    expect(Object.keys(result.containers[0]).sort()).toEqual([
      'autostart',
      'cpu',
      'description',
      'id',
      'image_description',
      'memory',
      'name',
      'status',
    ]);
    expect(JSON.stringify(result)).not.toContain('secureboot');
  });

  it('passes the normalized state word through, including UNKNOWN', async () => {
    // The mapping answers `UNKNOWN` for a word it has none for, and that is not
    // a container at rest — so it is reported as itself rather than folded.
    const { ctx } = opsSystem('v25.10.0', {
      'virt.instance.query': { emits: [[virtRow({ status: 'SOMETHING_NEW' })]] },
    });
    expect(await containerList.handler(ctx, {})).toMatchObject({
      containers: [{ status: 'UNKNOWN' }],
    });
  });

  it('reports an empty list as itself', async () => {
    const { ctx } = opsSystem('v26.0.0', { 'container.query': { emits: [[]] } });
    expect(await containerList.handler(ctx, {})).toEqual({
      api_version: 'v26.0.0',
      containers: [],
    });
  });

  it('fails inside the client where the payload is not a list of rows', async () => {
    // Nothing in this file guards the list shape, because the mapping `map`s the
    // payload before anything here sees it — so a payload that is not a list
    // fails there rather than reaching a tool that could report it as empty.
    const { ctx } = opsSystem('v26.0.0', { 'container.query': { emits: [{ oops: true }] } });
    await expect(containerList.handler(ctx, {})).rejects.toThrow('is not a function');
  });

  it('fails the whole listing where one state word cannot be read at all', async () => {
    // `status` is never null, and this is why: the client's state mapping is
    // total over strings and throws on anything else, so the failure is the
    // read's rather than one row's.
    const { ctx } = opsSystem('v26.0.0', {
      'container.query': { emits: [[containerRow({ status: { state: 42 } })]] },
    });
    await expect(containerList.handler(ctx, {})).rejects.toThrow('toUpperCase is not a function');
  });

  it('nulls a field whose value the middleware sent in a form it could not read', async () => {
    // The mapping copies these across without narrowing them, so the guards
    // here are what stand between a middleware value and a tool result.
    const { ctx } = opsSystem('v25.10.0', {
      'virt.instance.query': {
        emits: [[virtRow({ id: 42, name: '', autostart: 'yes', cpu: null, memory: null })]],
      },
    });
    expect(await containerList.handler(ctx, {})).toMatchObject({
      containers: [{ id: null, name: null, autostart: null, cpu: null, memory: null }],
    });
  });

  it('nulls the image description where the system reported none', async () => {
    const { ctx } = opsSystem('v25.10.0', {
      'virt.instance.query': {
        emits: [[virtRow({ image: { architecture: 'amd64', description: null } })]],
      },
    });
    expect(await containerList.handler(ctx, {})).toMatchObject({
      containers: [{ image_description: null }],
    });
  });

  it('nulls a description the newer versions did not report', async () => {
    const { ctx } = opsSystem('v26.0.0', {
      'container.query': { emits: [[containerRow({ description: undefined })]] },
    });
    expect(await containerList.handler(ctx, {})).toMatchObject({
      containers: [{ description: null }],
    });
  });

  it('lets a failed read fail the tool, since an unread list is not an empty one', async () => {
    const { ctx } = opsSystem('v26.0.0', {
      'container.query': { fails: new Error('middleware is down') },
    });
    await expect(containerList.handler(ctx, {})).rejects.toThrow('middleware is down');
  });

  it('reports a null api_version where the version could not be read', async () => {
    const { ctx } = opsSystemWithoutVersion('v26.0.0', listing('v26.0.0'));
    expect(await containerList.handler(ctx, {})).toMatchObject({ api_version: null });
  });

  describe('description', () => {
    it('says which nulls are the version rather than the container', () => {
      expect(containerList.description).toContain('CANNOT BE READ WITHOUT IT');
      expect(containerList.description).toContain('AND THIS TOOL DOES NOT SEPARATE THEM');
    });

    it('says UNKNOWN is not a container at rest', () => {
      expect(containerList.description).toContain('NOT a container at rest');
    });

    it('points at vms_list for the machines this does not list', () => {
      expect(containerList.description).toContain('IT DOES NOT LIST VIRTUAL MACHINES OF ANY KIND');
    });

    it('carries the guidance as a suffix of the description, one copy of the prose', () => {
      expect(containerList.description.endsWith(containerList.resultGuidance ?? '')).toBe(true);
    });
  });
});

describe('the container power tools', () => {
  const tools = [containerStart, containerStop, containerRestart];

  it('are reversible mutating tools needing the full role', () => {
    for (const tool of tools) {
      expect(tool).toMatchObject({
        mutating: true,
        destructiveness: 'reversible',
        requiredRole: Role.Full,
      });
    }
  });

  it('take a string id and refuse a number, naming the tools that take one', () => {
    for (const tool of tools) {
      expect(() => tool.normalizeArgs?.({ id: 7, force: false })).toThrow(
        'must be a non-empty STRING',
      );
      expect(() => tool.normalizeArgs?.({ id: 7, force: false })).toThrow('`vm_start`');
    }
  });

  it.each([{}, { id: '' }, { id: null }, { id: ['web'] }])(
    'refuses an id it cannot read: %o',
    (args) => {
      for (const tool of tools) {
        expect(() => tool.normalizeArgs?.({ ...args, force: false })).toThrow('"id" is required');
      }
    },
  );

  it('carry the guidance as a suffix of the description, one copy of the prose', () => {
    for (const tool of tools) {
      expect(tool.description.endsWith(tool.resultGuidance ?? '')).toBe(true);
    }
  });

  it('name the container stack and the tools for the other one', () => {
    for (const tool of tools) {
      expect(tool.description).toContain('THIS IS THE INCUS-BACKED CONTAINER STACK');
      expect(tool.description).toContain('`vm_start`, `vm_stop` and `vm_restart` power the');
    }
  });

  it('say the already-in-target-state case is unconfirmed rather than guessing', () => {
    for (const tool of tools) {
      expect(tool.description).toContain(
        'ALREADY IN THE STATE IT AIMS AT IS (unconfirmed) HERE',
      );
    }
  });

  it.each(tools)('fails the plan naming the id where no container has it', async (tool) => {
    const { ctx } = opsSystem('v26.0.0', { 'container.query': { emits: [[]] } });
    await expect(tool.plan(ctx, { id: '7', force: false })).rejects.toThrow(
      'No container with id `7` on this system',
    );
  });

  it.each(tools)('checks the id on the response rather than taking the first row', async (tool) => {
    // The query takes no filter at all, so the whole list comes back and finding
    // the row is this file's own work — taking the first would name a different
    // container.
    const { ctx } = opsSystem('v26.0.0', {
      'container.query': { emits: [[containerRow({ id: 9, name: 'other' })]] },
    });
    await expect(tool.plan(ctx, { id: '7', force: false })).rejects.toThrow(
      'No container with id `7`',
    );
  });

  it.each(tools)('names the read once and says when it runs again', async (tool) => {
    const { ctx } = opsSystem('v26.0.0', listing('v26.0.0'));
    const [read] = await tool.plan(ctx, { id: '7', force: false });
    expect(read.method).toBe('ops.containerQuery');
    expect(read.params).toEqual([]);
    expect(read.description).toContain('Changes nothing');
    expect(read.description).toContain('THIS SAME READ IS MADE AGAIN WHEN THE WATCH BELOW ENDS');
    expect(read.description).toContain('one call made twice');
  });

  it.each(tools)('names both middleware methods the read can reach', async (tool) => {
    const { ctx } = opsSystem('v26.0.0', listing('v26.0.0'));
    const [read] = await tool.plan(ctx, { id: '7', force: false });
    expect(read.description).toContain('`virt.instance.query` filtered to containers');
    expect(read.description).toContain('`container.query` on 26 and later');
  });

  it.each(tools)('names the version the system negotiated in the plan', async (tool) => {
    const { ctx } = opsSystem('v25.10.0', listing('v25.10.0'));
    const steps = await tool.plan(ctx, { id: 'web', force: false });
    expect(steps[1].description).toContain('negotiated with this system is `v25.10.0`');
  });

  it.each(tools)('says so where the negotiated version could not be read', async (tool) => {
    const { ctx } = opsSystemWithoutVersion('v25.10.0', listing('v25.10.0'));
    const steps = await tool.plan(ctx, { id: 'web', force: false });
    expect(steps[1].description).toContain('COULD NOT BE READ');
  });

  it.each(tools)('rejects arguments it cannot read before making any call', async (tool) => {
    const { ctx, query } = opsSystem('v26.0.0', listing('v26.0.0'));
    await expect(tool.plan(ctx, { id: 7, force: false })).rejects.toThrow('"id" is required');
    expect(query).not.toHaveBeenCalled();
  });
});

describe('container_start', () => {
  const started = (version: OpsVersion, answers: OpsAnswers = {}): OpsAnswers =>
    listing(version, answers);

  it('takes the id and nothing else', () => {
    const schema = containerStart.inputSchema as {
      properties: Record<string, unknown>;
      required: string[];
    };
    expect(Object.keys(schema.properties)).toEqual(['id']);
    expect(schema.required).toEqual(['id']);
  });

  it('plans the operation rather than a middleware method, and names both', async () => {
    const { ctx } = opsSystem('v25.10.0', started('v25.10.0'));
    const steps: PlanStep[] = await containerStart.plan(ctx, { id: 'web' });
    expect(steps).toHaveLength(2);
    expect(steps[1].method).toBe('ops.containerStart');
    expect(steps[1].params).toEqual(['web']);
    expect(steps[1].description).toContain('Start the container "web" (id `web`)');
    expect(steps[1].description).toContain('Its state read as `RUNNING`');
    expect(steps[1].description).toContain('`virt.instance.start` — a background job');
    expect(steps[1].description).toContain('`container.start` on 26 and later');
  });

  it('says so where the container reported no name', async () => {
    const { ctx } = opsSystem('v26.0.0', {
      'container.query': { emits: [[containerRow({ name: '' })]] },
    });
    const steps = await containerStart.plan(ctx, { id: '7' });
    expect(steps[1].description).toContain('the container (the system reported no name)');
  });

  it('reports a job on 25.10, where the operation is a job', async () => {
    const { ctx, job } = opsSystem('v25.10.0', {
      'virt.instance.query': [
        { emits: [[virtRow({ status: 'STOPPED' })]] },
        { emits: [[virtRow()]] },
      ],
      'virt.instance.start': { emits: [runningJob(), finishedJob()] },
    });
    expect(await containerStart.execute(ctx, { id: 'web' })).toEqual({
      container_id: 'web',
      api_version: 'v25.10.0',
      previous_lookup: 'FOUND',
      previous_read_error: null,
      previously_status: 'STOPPED',
      resulting_lookup: 'FOUND',
      resulting_read_error: null,
      resulting_status: 'RUNNING',
      changed: true,
      watched_seconds: 30,
      dispatch: 'JOB',
      job_id: 11,
      job_state: 'SUCCESS',
      job_succeeded: true,
      job_error: null,
      job_finished_at: '2023-11-14T22:13:20.000Z',
      operation_ended: true,
    });
    expect(job.mock.calls).toEqual([['virt.instance.start', ['web']]]);
  });

  it('reports no job on 26, where the operation is synchronous', async () => {
    // WHAT OPTION 2 BUYS (2/3). That this emits `null` and never a job record is
    // the real mapping's behaviour — `container.start` piped through `map(() =>
    // null)` — and it is the fact the `SYNCHRONOUS` dispatch exists for.
    const { ctx, call, job } = opsSystem('v26.0.0', {
      'container.query': [
        { emits: [[containerRow({ status: { state: 'STOPPED' } })]] },
        { emits: [[containerRow()]] },
      ],
      'container.start': { emits: [null] },
    });
    expect(await containerStart.execute(ctx, { id: '7' })).toMatchObject({
      dispatch: 'SYNCHRONOUS',
      job_id: null,
      job_state: null,
      job_succeeded: null,
      job_error: null,
      job_finished_at: null,
      operation_ended: true,
      previously_status: 'STOPPED',
      resulting_status: 'RUNNING',
      changed: true,
    });
    expect(call.mock.calls).toEqual([['container.start', [7]]]);
    expect(job).not.toHaveBeenCalled();
  });

  it('separates a synchronous version from an operation nothing was seen of', async () => {
    const { ctx } = opsSystem('v25.10.0', {
      'virt.instance.query': { emits: [[virtRow()]] },
      'virt.instance.start': { emits: [] },
    });
    expect(await containerStart.execute(ctx, { id: 'web' })).toMatchObject({
      dispatch: 'UNESTABLISHED',
      job_id: null,
      operation_ended: false,
    });
  });

  it('reports an answer it could read as neither a job nor a synchronous one', async () => {
    const { ctx } = opsSystem('v25.10.0', {
      'virt.instance.query': { emits: [[virtRow()]] },
      'virt.instance.start': { emits: [42] },
    });
    expect(await containerStart.execute(ctx, { id: 'web' })).toMatchObject({
      dispatch: 'UNREADABLE',
      job_id: null,
      operation_ended: true,
    });
  });

  it('reports a job whose id it could not read as a job all the same', async () => {
    const { ctx } = opsSystem('v25.10.0', {
      'virt.instance.query': { emits: [[virtRow()]] },
      'virt.instance.start': { emits: [finishedJob({ id: 'eleven' })] },
    });
    expect(await containerStart.execute(ctx, { id: 'web' })).toMatchObject({
      dispatch: 'JOB',
      job_id: null,
      job_state: 'SUCCESS',
      job_succeeded: true,
    });
  });

  it('calls the operation even where the read before it failed, and reports why', async () => {
    const { ctx, job } = opsSystem('v25.10.0', {
      'virt.instance.query': [{ fails: new Error('read refused') }, { emits: [[virtRow()]] }],
      'virt.instance.start': { emits: [finishedJob()] },
    });
    expect(await containerStart.execute(ctx, { id: 'web' })).toMatchObject({
      previous_lookup: 'UNREADABLE',
      previous_read_error: 'read refused',
      previously_status: null,
      changed: null,
    });
    expect(job).toHaveBeenCalledTimes(1);
  });

  it('does not fail the tool where the read after the call failed', async () => {
    const { ctx } = opsSystem('v25.10.0', {
      'virt.instance.query': [{ emits: [[virtRow()]] }, { fails: new Error('connection dropped') }],
      'virt.instance.start': { emits: [finishedJob()] },
    });
    expect(await containerStart.execute(ctx, { id: 'web' })).toMatchObject({
      resulting_lookup: 'UNREADABLE',
      resulting_read_error: 'connection dropped',
      resulting_status: null,
      changed: null,
    });
  });

  it('reports a read that completed and listed no such container as NOT_FOUND', async () => {
    const { ctx } = opsSystem('v25.10.0', {
      'virt.instance.query': { emits: [[]] },
      'virt.instance.start': { emits: [finishedJob()] },
    });
    expect(await containerStart.execute(ctx, { id: 'web' })).toMatchObject({
      previous_lookup: 'NOT_FOUND',
      previous_read_error: null,
      previously_status: null,
      changed: null,
    });
  });

  it('lets a failure before anything was seen of the operation fail the call', async () => {
    const { ctx } = opsSystem('v25.10.0', {
      'virt.instance.query': { emits: [[virtRow()]] },
      'virt.instance.start': { fails: new Error('not authorised') },
    });
    await expect(containerStart.execute(ctx, { id: 'web' })).rejects.toThrow('not authorised');
  });

  it('reports what it has where the watch ran out with the job still going', async () => {
    const { ctx } = opsSystem('v25.10.0', {
      'virt.instance.query': { emits: [[virtRow()]] },
      'virt.instance.start': { emits: [runningJob()], completes: false },
    });
    vi.useFakeTimers();
    const running = containerStart.execute(ctx, { id: 'web' });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await running).toMatchObject({
      dispatch: 'JOB',
      job_id: 11,
      job_state: 'RUNNING',
      job_succeeded: null,
      operation_ended: false,
    });
  });

  it('does not fail the call where the failure came after a job was seen', async () => {
    // The operation is under way by then, so rejecting would report a failure
    // that did not happen and lose the job id in the same act. It keeps the id
    // and reports what was established.
    const { ctx } = opsSystem('v25.10.0', {
      'virt.instance.query': { emits: [[virtRow()]] },
      'virt.instance.start': { emits: [runningJob()], thenFails: new Error('socket dropped') },
    });
    expect(await containerStart.execute(ctx, { id: 'web' })).toMatchObject({
      dispatch: 'JOB',
      job_id: 11,
      job_state: 'RUNNING',
      job_succeeded: null,
      operation_ended: false,
    });
  });

  it('normalizes to the id alone', () => {
    expect(containerStart.normalizeArgs?.({ id: 'web', systems: 'all' })).toEqual({ id: 'web' });
  });
});

describe('container_stop', () => {
  it('takes a required force and an optional timeout', () => {
    const schema = containerStop.inputSchema as {
      properties: Record<string, unknown>;
      required: string[];
    };
    expect(Object.keys(schema.properties)).toEqual(['id', 'force', 'timeout']);
    expect(schema.required).toEqual(['id', 'force']);
  });

  it('refuses a missing force rather than defaulting it', () => {
    expect(() => containerStop.normalizeArgs?.({ id: 'web' })).toThrow('"force" is required');
  });

  it('refuses a force it cannot read rather than coercing it', () => {
    expect(() => containerStop.normalizeArgs?.({ id: 'web', force: 'true' })).toThrow(
      '"force" is required and must be a boolean',
    );
  });

  it.each([1.5, -1, 'ten'])('refuses a timeout it cannot read: %o', (timeout) => {
    expect(() => containerStop.normalizeArgs?.({ id: 'web', force: false, timeout })).toThrow(
      '"timeout" must be a whole number',
    );
  });

  it('normalizes an omitted timeout to an absent key, not to a value', () => {
    expect(containerStop.normalizeArgs?.({ id: 'web', force: false })).toEqual({
      id: 'web',
      force: false,
    });
    expect(containerStop.normalizeArgs?.({ id: 'web', force: true, timeout: 10 })).toEqual({
      id: 'web',
      force: true,
      timeout: 10,
    });
  });

  it('names the operation and the arguments it is called with', async () => {
    const { ctx } = opsSystem('v25.10.0', listing('v25.10.0'));
    const steps = await containerStop.plan(ctx, { id: 'web', force: false, timeout: 10 });
    expect(steps[1].method).toBe('ops.containerStop');
    expect(steps[1].params).toEqual(['web', { force: false, timeout: 10 }]);
  });

  it('omits the timeout from the arguments where none was named', async () => {
    const { ctx } = opsSystem('v25.10.0', listing('v25.10.0'));
    const steps = await containerStop.plan(ctx, { id: 'web', force: true });
    expect(steps[1].params).toEqual(['web', { force: true }]);
    expect(steps[1].description).toContain('No timeout was named');
  });

  it('states what a forced stop does on each version, and that data can be lost', async () => {
    const { ctx } = opsSystem('v25.10.0', listing('v25.10.0'));
    const steps = await containerStop.plan(ctx, { id: 'web', force: true });
    expect(steps[1].description).toContain('FORCE IS TRUE FOR THIS CALL');
    expect(steps[1].description).toContain('sets BOTH `container.stop`\'s `force`');
    expect(steps[1].description).toContain('NOT WRITTEN TO DISK CAN BE LOST');
  });

  it('states that the graceful path has no established fallback', async () => {
    const { ctx } = opsSystem('v25.10.0', listing('v25.10.0'));
    const steps = await containerStop.plan(ctx, { id: 'web', force: false });
    expect(steps[1].description).toContain('Force is false for this call');
    expect(steps[1].description).toContain('(unconfirmed) here');
  });

  it('states that a named timeout is not sent on the newer versions', async () => {
    const { ctx } = opsSystem('v26.0.0', listing('v26.0.0'));
    const steps = await containerStop.plan(ctx, { id: '7', force: false, timeout: 10 });
    expect(steps[1].description).toContain('A timeout of 10 was named');
    expect(steps[1].description).toContain('THE API DECLARES NO UNIT FOR THAT NUMBER');
    expect(steps[1].description).toContain('THIS NUMBER IS NOT SENT');
  });

  it('sends the caller\'s options whole on 25.10, where the API takes them', async () => {
    const { ctx, job } = opsSystem('v25.10.0', {
      'virt.instance.query': { emits: [[virtRow()]] },
      'virt.instance.stop': { emits: [finishedJob()] },
    });
    await containerStop.execute(ctx, { id: 'web', force: false, timeout: 10 });
    expect(job.mock.calls).toEqual([['virt.instance.stop', ['web', { force: false, timeout: 10 }]]]);
  });

  it('doubles force and drops the timeout on 26, because the API has no timeout', async () => {
    // WHAT OPTION 2 BUYS (3/3). Both halves of this are the real mapping's:
    // `force` is written into `force_after_timeout` as well, and `timeout` never
    // reaches the wire. A faked `ops` would have asserted neither.
    const { ctx, job } = opsSystem('v26.0.0', {
      'container.query': { emits: [[containerRow()]] },
      'container.stop': { emits: [finishedJob()] },
    });
    await containerStop.execute(ctx, { id: '7', force: true, timeout: 10 });
    expect(job.mock.calls).toEqual([
      ['container.stop', [7, { force: true, force_after_timeout: true }]],
    ]);
  });

  it('reports the job, the two readings and what was asked for', async () => {
    const { ctx } = opsSystem('v26.0.0', {
      'container.query': [
        { emits: [[containerRow()]] },
        { emits: [[containerRow({ status: { state: 'STOPPED' } })]] },
      ],
      'container.stop': { emits: [runningJob(), finishedJob()] },
    });
    expect(await containerStop.execute(ctx, { id: '7', force: false })).toEqual({
      container_id: '7',
      api_version: 'v26.0.0',
      previous_lookup: 'FOUND',
      previous_read_error: null,
      previously_status: 'RUNNING',
      resulting_lookup: 'FOUND',
      resulting_read_error: null,
      resulting_status: 'STOPPED',
      changed: true,
      requested_force: false,
      requested_timeout: null,
      watched_seconds: 30,
      dispatch: 'JOB',
      job_id: 11,
      job_state: 'SUCCESS',
      job_succeeded: true,
      job_error: null,
      job_finished_at: '2023-11-14T22:13:20.000Z',
      operation_ended: true,
    });
  });

  it('does not read a terminal-looking state as a success where nothing ended', async () => {
    const { ctx } = opsSystem('v26.0.0', {
      'container.query': { emits: [[containerRow()]] },
      'container.stop': { emits: [finishedJob()], completes: false },
    });
    vi.useFakeTimers();
    const running = containerStop.execute(ctx, { id: '7', force: false });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await running).toMatchObject({
      job_state: 'SUCCESS',
      job_succeeded: null,
      job_finished_at: null,
      operation_ended: false,
    });
  });

  it('reports a job that ended in a state this catalog does not count as success', async () => {
    const { ctx } = opsSystem('v26.0.0', {
      'container.query': { emits: [[containerRow()]] },
      'container.stop': { emits: [finishedJob({ state: 'FAILED', error: 'container is busy' })] },
    });
    expect(await containerStop.execute(ctx, { id: '7', force: true })).toMatchObject({
      job_state: 'FAILED',
      job_succeeded: false,
      job_error: 'container is busy',
      operation_ended: true,
    });
  });

  it('reports the timeout it was asked for', async () => {
    const { ctx } = opsSystem('v25.10.0', {
      'virt.instance.query': { emits: [[virtRow()]] },
      'virt.instance.stop': { emits: [finishedJob()] },
    });
    expect(await containerStop.execute(ctx, { id: 'web', force: false, timeout: 10 })).toMatchObject(
      { requested_timeout: 10, requested_force: false },
    );
  });
});

describe('container_restart', () => {
  it('takes the same three arguments a stop does', () => {
    const schema = containerRestart.inputSchema as {
      properties: Record<string, unknown>;
      required: string[];
    };
    expect(Object.keys(schema.properties)).toEqual(['id', 'force', 'timeout']);
    expect(schema.required).toEqual(['id', 'force']);
  });

  it('normalizes the same way a stop does, keeping an omitted timeout absent', () => {
    expect(containerRestart.normalizeArgs?.({ id: '7', force: false, systems: 'all' })).toEqual({
      id: '7',
      force: false,
    });
    expect(containerRestart.normalizeArgs?.({ id: '7', force: true, timeout: 5 })).toEqual({
      id: '7',
      force: true,
      timeout: 5,
    });
    expect(() => containerRestart.normalizeArgs?.({ id: '7' })).toThrow('"force" is required');
  });

  it('states the composition rather than reading as a stop then a start', async () => {
    const { ctx } = opsSystem('v26.0.0', listing('v26.0.0'));
    const steps = await containerRestart.plan(ctx, { id: '7', force: false });
    expect(steps[1].method).toBe('ops.containerRestart');
    expect(steps[1].description).toContain(
      'INCLUDING WHERE THE STOP JOB COMPLETED IN A FAILED STATE',
    );
    expect(steps[1].description).toContain('NOTHING IS REPORTED ABOUT THE OPERATION UNTIL THE STOP');
    expect(steps[1].description).toContain('NOT something this catalog can check');
  });

  it('is one middleware job on 25.10', async () => {
    const { ctx, job, call } = opsSystem('v25.10.0', {
      'virt.instance.query': { emits: [[virtRow()]] },
      'virt.instance.restart': { emits: [runningJob(), finishedJob()] },
    });
    expect(await containerRestart.execute(ctx, { id: 'web', force: true, timeout: 5 })).toMatchObject(
      { dispatch: 'JOB', job_id: 11, job_succeeded: true, operation_ended: true },
    );
    expect(job.mock.calls).toEqual([
      ['virt.instance.restart', ['web', { force: true, timeout: 5 }]],
    ]);
    expect(call).not.toHaveBeenCalled();
  });

  it('is a stop job and then a synchronous start on 26', async () => {
    const { ctx, job, call } = opsSystem('v26.0.0', {
      'container.query': { emits: [[containerRow()]] },
      'container.stop': { emits: [runningJob(), finishedJob()] },
      'container.start': { emits: [null] },
    });
    expect(await containerRestart.execute(ctx, { id: '7', force: false })).toMatchObject({
      // The trailing `null` the start half emits does not make the whole
      // operation read as synchronous — the stop half's job is what `dispatch`
      // is about, and the description says the job fields are the stop's.
      dispatch: 'JOB',
      job_id: 11,
      job_state: 'SUCCESS',
      job_succeeded: true,
      operation_ended: true,
    });
    expect(job.mock.calls).toEqual([
      ['container.stop', [7, { force: false, force_after_timeout: false }]],
    ]);
    expect(call.mock.calls).toEqual([['container.start', [7]]]);
  });

  it('starts the container even where the stop job ended in a failed state', async () => {
    const { ctx, call } = opsSystem('v26.0.0', {
      'container.query': { emits: [[containerRow()]] },
      'container.stop': { emits: [finishedJob({ state: 'FAILED', error: 'would not stop' })] },
      'container.start': { emits: [null] },
    });
    expect(await containerRestart.execute(ctx, { id: '7', force: false })).toMatchObject({
      job_state: 'FAILED',
      job_succeeded: false,
      job_error: 'would not stop',
    });
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('reports nothing at all on 26 while the stop is still running', async () => {
    // The composition buffers the stop's updates before re-emitting them, so a
    // watch that runs out mid-stop sees nothing — where the very same answer
    // reaches `container_stop` as a job in progress. This is the difference the
    // real-mapping seam exists to pin.
    const answers = {
      'container.query': { emits: [[containerRow()]] },
      'container.stop': { emits: [runningJob()], completes: false as const },
      'container.start': { emits: [null] },
    };
    vi.useFakeTimers();
    const restarting = containerRestart.execute(opsSystem('v26.0.0', answers).ctx, {
      id: '7',
      force: false,
    });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await restarting).toMatchObject({
      dispatch: 'UNESTABLISHED',
      job_id: null,
      job_state: null,
      operation_ended: false,
    });

    const stopping = containerStop.execute(opsSystem('v26.0.0', answers).ctx, {
      id: '7',
      force: false,
    });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await stopping).toMatchObject({
      dispatch: 'JOB',
      job_id: 11,
      job_state: 'RUNNING',
      operation_ended: false,
    });
  });

  it('says a changed of false is the ordinary answer for a restart that worked', () => {
    expect(containerRestart.description).toContain(
      'A `changed: false` ACROSS A RESTART IS THE ORDINARY ANSWER FOR ONE THAT WORKED',
    );
    expect(containerRestart.description).toContain('DOES NOT SEPARATE THE TWO');
  });

  it('says the job fields are about the stop half', () => {
    expect(containerRestart.description).toContain('ALL ABOUT THE STOP HALF');
  });

  it('reports a restart that left the container running as changed false', async () => {
    const { ctx } = opsSystem('v26.0.0', {
      'container.query': { emits: [[containerRow()]] },
      'container.stop': { emits: [finishedJob()] },
      'container.start': { emits: [null] },
    });
    expect(await containerRestart.execute(ctx, { id: '7', force: false })).toMatchObject({
      previously_status: 'RUNNING',
      resulting_status: 'RUNNING',
      changed: false,
      job_succeeded: true,
    });
  });
});
