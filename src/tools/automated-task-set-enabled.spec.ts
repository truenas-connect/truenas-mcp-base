import { describe, expect, it } from 'vitest';
import { Role } from '@/interfaces';
import { fakeSystem, failingSystem } from '@/testing/fake-systems';
import { automatedTaskSetEnabled } from '@/tools/index';

/**
 * `automated_task_set_enabled`'s tests live here rather than in
 * `tasks.spec.ts`, which is the #87 split exception and is CHECKED rather than
 * felt: `tasks.spec.ts` is 1,352 lines and this block is several hundred more,
 * so the merged file crosses the 1,500-line trigger. The split is by tool, as
 * `scheduled-task-set-enabled.spec.ts` and `cloudsync-run.spec.ts` already are;
 * the four listing tools stay where they are.
 */

/** One init/shutdown script as `initshutdownscript.query` answers with it. */
const script = {
  id: 3,
  comment: 'mount the archive',
  type: 'COMMAND',
  when: 'POSTINIT',
  // Both of these are in the row and neither may reach the plan: the command is
  // whatever the operator typed, and the script path is not read.
  command: 'mount -t nfs backup:/vault /mnt/vault -o pass=hunter2',
  script: null,
  enabled: true,
  timeout: 10,
};

/** A `SHUTDOWN` script defined by a path rather than an inlined command. */
const shutdownScript = {
  id: 3,
  comment: 'flush the cache',
  type: 'SCRIPT',
  when: 'SHUTDOWN',
  command: null,
  script: '/mnt/tank/scripts/flush-cache.sh',
  enabled: true,
  timeout: 30,
};

/**
 * A system listing those rows and answering the update with the row as it would
 * be after the change — which is what `initshutdownscript.update` answers with.
 */
const system = (rows: unknown = [script], updated?: unknown) =>
  fakeSystem({
    'initshutdownscript.query': rows,
    'initshutdownscript.update': updated === undefined ? { ...script, enabled: false } : updated,
  });

/** The args for the ordinary case: switch script 3 off. */
const off = { id: 3, enabled: false };

describe('automated_task_set_enabled', () => {
  it('is a reversible mutating tool needing the full role', () => {
    expect(automatedTaskSetEnabled).toMatchObject({
      name: 'automated_task_set_enabled',
      mutating: true,
      destructiveness: 'reversible',
      requiredRole: Role.Full,
    });
  });

  it('takes an id and a state, and no kind', () => {
    const schema = automatedTaskSetEnabled.inputSchema as {
      properties: Record<string, unknown>;
      required: string[];
    };
    expect(schema.required).toEqual(['id', 'enabled']);
    // There is exactly one kind here, so there is nothing to discriminate — and
    // that is precisely why the description has to say which section the id
    // comes from, tested below.
    expect(Object.keys(schema.properties)).toEqual(['id', 'enabled']);
  });

  it('says which section its ids come from and which tool takes the other three', () => {
    // The name is broader than the tool — `automated_tasks_list` has four
    // sections and this acts on one — so the description is what carries the
    // scope. A caller reading only the name would reach it with a cron job's
    // id, and this tool cannot tell.
    const description = automatedTaskSetEnabled.description;
    expect(description).toContain('THIS TOOL ACTS ON INIT/SHUTDOWN SCRIPTS AND ON NOTHING ELSE');
    expect(description).toContain('`init_shutdown_scripts` SECTION ONLY');
    expect(description).toContain('`scheduled_task_set_enabled`');
    expect(description).toContain('CANNOT TELL THAT IT WAS HANDED AN id FROM THE WRONG SECTION');
    expect(description).toContain('ONLY THE `enabled` FIELD IS SENT');
  });

  it('says an init/shutdown script is not scheduled and states no schedule', () => {
    const description = automatedTaskSetEnabled.description;
    expect(description).toContain('an init/shutdown script IS NOT SCHEDULED');
    expect(description).toContain('NO SCHEDULE IS STATED ANYWHERE');
  });

  it('does not let `changed: false` claim the script was already in the requested state', () => {
    // `changed` compares the two READINGS, so false covers the unapplied call
    // as well as the no-op — the case at "does not report success when the
    // response disagrees with the request" below.
    const description = automatedTaskSetEnabled.description;
    expect(description).toContain('WHICH IS TWO OUTCOMES AND NOT ONE');
    expect(description).toContain('the call did not apply');
    expect(description).toContain('`changed` must not be read without it');
  });

  it('normalizes args: keeps the two and drops unknown keys', () => {
    expect(
      automatedTaskSetEnabled.normalizeArgs?.({
        id: 3,
        enabled: true,
        kind: 'cron',
        extra: 1,
        systems: 'all',
      }),
    ).toEqual({ id: 3, enabled: true });
  });

  describe('argument validation', () => {
    const ctx = system().ctx;

    it('requires a whole-number id', async () => {
      for (const bad of [undefined, null, '3', 3.5, Number.NaN]) {
        expect(() => automatedTaskSetEnabled.normalizeArgs?.({ id: bad, enabled: false })).toThrow(
          /"id" is required and must be a whole number/,
        );
        await expect(
          automatedTaskSetEnabled.plan(ctx, { id: bad, enabled: false }),
        ).rejects.toThrow(/"id" is required/);
      }
    });

    it('requires a boolean enabled and coerces nothing into one', async () => {
      // Coercing "false" to true would switch ON a script the caller asked to
      // switch off.
      for (const bad of [undefined, null, 'false', 0, 1]) {
        expect(() => automatedTaskSetEnabled.normalizeArgs?.({ id: 3, enabled: bad })).toThrow(
          /"enabled" is required and must be a boolean/,
        );
        await expect(automatedTaskSetEnabled.plan(ctx, { id: 3, enabled: bad })).rejects.toThrow(
          /"enabled" is required/,
        );
      }
    });

    it('executes nothing when an argument is unreadable', async () => {
      // The spy and the context have to come from the SAME fake system, or the
      // assertion is about a system `execute` never saw and cannot fail.
      const { ctx: own, query, call } = system();
      await expect(automatedTaskSetEnabled.execute(own, { id: 3, enabled: 'yes' })).rejects.toThrow(
        /"enabled" is required/,
      );
      expect(query).not.toHaveBeenCalled();
      expect(call).not.toHaveBeenCalled();
    });
  });

  describe('the plan it returns', () => {
    it('plans the read it makes as well as the mutation it makes', async () => {
      const steps = await automatedTaskSetEnabled.plan(system().ctx, off);
      // Two steps because `execute` makes two calls. A plan naming only the
      // mutation would not be a true account of what runs.
      expect(steps.map((step) => step.method)).toEqual([
        'initshutdownscript.query',
        'initshutdownscript.update',
      ]);
      // Two positional params, because `api.query(method, filters)` dispatches
      // `[filters ?? [], options ?? {}]` — the plan names the call that runs.
      expect(steps[0]).toMatchObject({ params: [[['id', '=', 3]], {}] });
      expect(steps[0].description).toMatch(/Changes nothing/);
    });

    it('sends only the enabled field, and sends the state that was asked for', async () => {
      const [, mutation] = await automatedTaskSetEnabled.plan(system().ctx, off);
      expect(mutation.params).toEqual([3, { enabled: false }]);
      const disabled = { ...script, enabled: false };
      const [, on] = await automatedTaskSetEnabled.plan(
        system([disabled], { ...disabled, enabled: true }).ctx,
        { id: 3, enabled: true },
      );
      expect(on.params).toEqual([3, { enabled: true }]);
      expect(mutation.description).toContain('Only the enabled flag is sent');
    });

    it('names the script by comment, when and type', async () => {
      const [, mutation] = await automatedTaskSetEnabled.plan(system().ctx, off);
      expect(mutation.description).toContain('Disable the init/shutdown script');
      expect(mutation.description).toContain('comment "mount the archive"');
      expect(mutation.description).toContain('when "POSTINIT"');
      expect(mutation.description).toContain('type "COMMAND"');
      expect(mutation.description).toContain('(id 3)');
    });

    it('states the lifecycle point and that there is no schedule', async () => {
      const [, mutation] = await automatedTaskSetEnabled.plan(system().ctx, off);
      expect(mutation.description).toContain('It runs at POSTINIT');
      expect(mutation.description).toContain('has no schedule at all');
      // The three points are not glossed a second time here: the listing tool
      // already describes them, and a second account can drift from the first.
      expect(mutation.description).toContain(
        '`automated_tasks_list` is where each lifecycle point is described',
      );
    });

    it('renders no schedule phrase, however the row is shaped', async () => {
      // `describeTask` ends every scheduled task with one; an init/shutdown
      // script has no cron record and a phrase in its place would be fiction.
      for (const rows of [[script], [shutdownScript], [{ ...script, when: null }]]) {
        const [, mutation] = await automatedTaskSetEnabled.plan(system(rows).ctx, off);
        // Neither a rendered schedule nor `schedulePhrase`'s stated-absence
        // fallback: there is no cron record here for either to be about. No
        // time of day appears at all, and the one mention of the word is the
        // statement that there is no schedule.
        expect(mutation.description).not.toMatch(/\d{1,2}:\d{2}/);
        expect(mutation.description).not.toContain('not rendered in words here');
        expect(mutation.description.match(/schedule/g)).toEqual(['schedule']);
      }
    });

    it('says the lifecycle point was not read rather than assuming startup', async () => {
      // Defaulting to a boot-time point would read as safe for a script that in
      // fact runs on the way down, which is where switching it off at the wrong
      // moment matters most.
      const { ctx } = system([{ ...script, when: 7 }]);
      const [, mutation] = await automatedTaskSetEnabled.plan(ctx, off);
      expect(mutation.description).toContain(
        'The system reported no lifecycle point for it this tool could read',
      );
      expect(mutation.description).not.toContain('It runs at');
      expect(mutation.description).toContain('when (the system reported none)');
    });

    it('states a field the system reported none of rather than dropping it', async () => {
      const { ctx } = system([{ ...script, comment: '', type: null }]);
      const [, mutation] = await automatedTaskSetEnabled.plan(ctx, off);
      expect(mutation.description).toContain('comment (the system reported none)');
      expect(mutation.description).toContain('type (the system reported none)');
    });

    it("does not repeat the script's command, which can hold an inlined secret", async () => {
      const [, mutation] = await automatedTaskSetEnabled.plan(system().ctx, off);
      expect(mutation.description).not.toContain('hunter2');
      expect(mutation.description).not.toContain('mount -t nfs');
      expect(mutation.description).toContain(
        "neither the script's command nor its path is repeated here",
      );
    });

    it('does not repeat the path of a SCRIPT-type entry either', async () => {
      const [, mutation] = await automatedTaskSetEnabled.plan(system([shutdownScript]).ctx, off);
      expect(mutation.description).not.toContain('flush-cache.sh');
      expect(mutation.description).toContain('type "SCRIPT"');
      expect(mutation.description).toContain('It runs at SHUTDOWN');
    });

    it('says which way the switch will move', async () => {
      const [, disabling] = await automatedTaskSetEnabled.plan(system().ctx, off);
      expect(disabling.description).toContain('It is enabled, so this will disable it.');
      const offRow = { ...script, enabled: false };
      const [, enabling] = await automatedTaskSetEnabled.plan(
        system([offRow], { ...offRow, enabled: true }).ctx,
        { id: 3, enabled: true },
      );
      expect(enabling.description).toContain('It is disabled, so this will enable it.');
    });

    it('says so when the script is already in the requested state', async () => {
      const already = { ...script, enabled: false };
      const [, mutation] = await automatedTaskSetEnabled.plan(
        system([already], already).ctx,
        off,
      );
      expect(mutation.description).toContain(
        'It is already disabled, so this changes nothing and is not an error.',
      );
    });

    it('refuses to claim a direction when the prior state is unreadable', async () => {
      const { ctx } = system([{ ...script, enabled: 'yes' }]);
      const [, mutation] = await automatedTaskSetEnabled.plan(ctx, off);
      expect(mutation.description).toContain(
        'Whether it is enabled could not be read, so this may change nothing.',
      );
    });

    it('fails when no init/shutdown script has that id, naming where ids come from', async () => {
      const { ctx } = system([{ ...script, id: 4 }]);
      await expect(automatedTaskSetEnabled.plan(ctx, off)).rejects.toThrow(
        /No init\/shutdown script with id 3 on this system — the ids this tool takes come from the `init_shutdown_scripts` section of `automated_tasks_list`/,
      );
    });
  });

  describe('the id it acts on', () => {
    it('re-checks the id on the response rather than trusting the filter', async () => {
      // An unrecognised query parameter is dropped rather than refused, so a
      // filter that did not apply comes back as the whole table — and its first
      // row is a different script.
      const whole = [{ ...script, id: 1, comment: 'first' }, { ...script, id: 2 }, script];
      const [, mutation] = await automatedTaskSetEnabled.plan(system(whole).ctx, off);
      expect(mutation.params).toEqual([3, { enabled: false }]);
      expect(mutation.description).toContain('comment "mount the archive"');
      expect(mutation.description).not.toContain('comment "first"');
    });

    it('treats an answer that is not a list as no script with that id', async () => {
      await expect(automatedTaskSetEnabled.plan(system(7).ctx, off)).rejects.toThrow(
        /No init\/shutdown script with id 3/,
      );
    });

    it('skips a listed row that is not a record', async () => {
      const { ctx } = system([null, 'a row', script]);
      const [, mutation] = await automatedTaskSetEnabled.plan(ctx, off);
      expect(mutation.description).toContain('comment "mount the archive"');
    });

    it('skips a listed row whose own id is not a number', async () => {
      const { ctx } = system([{ ...script, id: '3' }]);
      await expect(automatedTaskSetEnabled.plan(ctx, off)).rejects.toThrow(
        /No init\/shutdown script with id 3/,
      );
    });
  });

  describe('the outcome it reports', () => {
    it('executes the read and then the update the plan named', async () => {
      const { ctx, query, call } = system();
      await automatedTaskSetEnabled.execute(ctx, off);
      expect(query).toHaveBeenCalledWith('initshutdownscript.query', [['id', '=', 3]]);
      expect(call).toHaveBeenCalledWith('initshutdownscript.update', [3, { enabled: false }]);
    });

    it('reports a script it actually changed', async () => {
      expect(await automatedTaskSetEnabled.execute(system().ctx, off)).toEqual({
        id: 3,
        requested_enabled: false,
        lookup: 'FOUND',
        lookup_error: null,
        previously_enabled: true,
        resulting_enabled: false,
        changed: true,
        confirmed: true,
      });
    });

    it('reports a script already in the requested state as changing nothing', async () => {
      const already = { ...script, enabled: false };
      const result = await automatedTaskSetEnabled.execute(system([already], already).ctx, off);
      expect(result).toMatchObject({
        previously_enabled: false,
        resulting_enabled: false,
        changed: false,
        confirmed: true,
      });
    });

    it('reports FOUND with a null prior state when the script stated no enabled', async () => {
      // The fourth cause of a null `previously_enabled`, which `lookup` alone
      // does not separate from the other three.
      const { ctx } = system([{ ...script, enabled: 'yes' }]);
      expect(await automatedTaskSetEnabled.execute(ctx, off)).toMatchObject({
        lookup: 'FOUND',
        previously_enabled: null,
        resulting_enabled: false,
        changed: null,
      });
    });

    it('reports NOT_FOUND and still makes the update the plan named', async () => {
      const { ctx, call } = system([]);
      expect(await automatedTaskSetEnabled.execute(ctx, off)).toMatchObject({
        lookup: 'NOT_FOUND',
        lookup_error: null,
        previously_enabled: null,
        resulting_enabled: false,
        changed: null,
        confirmed: true,
      });
      // Unconditional: skipping it would be `execute` branching on state read
      // after the plan was approved.
      expect(call).toHaveBeenCalledWith('initshutdownscript.update', [3, { enabled: false }]);
    });

    it('reports UNREADABLE with the reason, and still makes the update', async () => {
      const { ctx, call } = failingSystem(
        { 'initshutdownscript.update': { ...script, enabled: false } },
        { 'initshutdownscript.query': new Error('websocket closed') },
      );
      expect(await automatedTaskSetEnabled.execute(ctx, off)).toMatchObject({
        lookup: 'UNREADABLE',
        lookup_error: 'websocket closed',
        previously_enabled: null,
        changed: null,
      });
      expect(call).toHaveBeenCalledWith('initshutdownscript.update', [3, { enabled: false }]);
    });

    it('does not report success when the response disagrees with the request', async () => {
      // The method answers with the updated script, so a response still
      // reporting the old state is the system not having applied the change.
      const { ctx } = system([script], { ...script, enabled: true });
      expect(await automatedTaskSetEnabled.execute(ctx, off)).toMatchObject({
        requested_enabled: false,
        previously_enabled: true,
        resulting_enabled: true,
        changed: false,
        confirmed: false,
      });
    });

    it('establishes nothing about the result when the response states no enabled', async () => {
      const { ctx } = system([script], { ...script, enabled: 'yes' });
      expect(await automatedTaskSetEnabled.execute(ctx, off)).toMatchObject({
        previously_enabled: true,
        resulting_enabled: null,
        changed: null,
        confirmed: null,
      });
    });

    it('establishes nothing about the result when the response is not a record', async () => {
      const { ctx } = system([script], true);
      expect(await automatedTaskSetEnabled.execute(ctx, off)).toMatchObject({
        resulting_enabled: null,
        changed: null,
        confirmed: null,
      });
    });

    it('fails the call when the update itself rejects', async () => {
      const { ctx } = failingSystem(
        { 'initshutdownscript.query': [script] },
        { 'initshutdownscript.update': { reason: 'script is locked' } },
      );
      await expect(automatedTaskSetEnabled.execute(ctx, off)).rejects.toEqual({
        reason: 'script is locked',
      });
    });
  });
});
