import { describe, expect, it } from 'vitest';
import { Role } from '@/interfaces';
import { fakeSystem, failingSystem } from '@/testing/fake-systems';
import { scheduledTaskSetSchedule } from '@/tools/index';

/**
 * `scheduled_task_set_schedule`'s tests live here rather than in
 * `tasks.spec.ts`, which is the #87 split exception CHECKED rather than felt:
 * `tasks.spec.ts` is 1,352 lines and this block is several hundred more, so the
 * merged file would cross the 1,500-line trigger. The split is by tool, as
 * `scheduled-task-set-enabled.spec.ts` already is.
 */

const RETENTION = 'pool.snapshottask.update_will_change_retention_for';

/** Every task row's stored schedule: 02:00 every day. */
const AT_TWO = { minute: '0', hour: '2', dom: '*', month: '*', dow: '*' };

/** The schedule the ordinary case asks for: 03:00 every day. */
const AT_THREE = { minute: '0', hour: '3', dom: '*', month: '*', dow: '*' };

/** The kinds, with the two methods each and a row shaped the way its table is. */
const kinds = [
  {
    kind: 'periodic_snapshot',
    noun: 'periodic snapshot task',
    listedBy: 'snapshot_tasks_list',
    read: 'pool.snapshottask.query',
    update: 'pool.snapshottask.update',
    window: true,
    row: { id: 3, dataset: 'tank/media', enabled: true, schedule: AT_TWO },
    named: 'dataset "tank/media"',
  },
  {
    kind: 'cloud_sync',
    noun: 'cloud sync task',
    listedBy: 'cloudsync_tasks_list',
    read: 'cloudsync.query',
    update: 'cloudsync.update',
    window: false,
    row: {
      id: 3,
      description: 'Nightly Backblaze',
      path: '/mnt/tank/media',
      direction: 'PUSH',
      enabled: true,
      schedule: AT_TWO,
    },
    named: 'description "Nightly Backblaze", path "/mnt/tank/media", direction "PUSH"',
  },
  {
    kind: 'replication',
    noun: 'replication task',
    listedBy: 'replication_status',
    read: 'replication.query',
    update: 'replication.update',
    window: true,
    row: {
      id: 3,
      name: 'media to backup',
      target_dataset: 'backup/media',
      enabled: true,
      schedule: AT_TWO,
    },
    named: 'name "media to backup", target dataset "backup/media"',
  },
  {
    kind: 'cron',
    noun: 'cron job',
    listedBy: 'automated_tasks_list',
    read: 'cronjob.query',
    update: 'cronjob.update',
    window: false,
    row: {
      id: 3,
      description: 'prune logs',
      user: 'root',
      command: 'curl -u admin:hunter2 https://example.test/ping',
      enabled: true,
      schedule: AT_TWO,
    },
    named: 'description "prune logs", user "root"',
  },
  {
    kind: 'rsync',
    noun: 'rsync task',
    listedBy: 'automated_tasks_list',
    read: 'rsynctask.query',
    update: 'rsynctask.update',
    window: false,
    row: {
      id: 3,
      desc: 'offsite copy',
      path: '/mnt/tank/docs',
      direction: 'PUSH',
      enabled: true,
      schedule: AT_TWO,
    },
    named: 'description "offsite copy", path "/mnt/tank/docs", direction "PUSH"',
  },
  {
    kind: 'cloud_backup',
    noun: 'cloud backup task',
    listedBy: 'automated_tasks_list',
    read: 'cloud_backup.query',
    update: 'cloud_backup.update',
    window: false,
    row: {
      id: 3,
      description: 'restic to B2',
      path: '/mnt/tank/vault',
      password: 'repository-passphrase',
      enabled: true,
      schedule: AT_TWO,
    },
    named: 'description "restic to B2", path "/mnt/tank/vault"',
  },
] as const;

type Kind = (typeof kinds)[number];

const [snapshots, cloudSync, replication, cron] = kinds;

/**
 * A system listing that kind's row and answering its update with the row as it
 * would be after the change — which is what these methods answer with — and
 * reporting that a periodic snapshot change touches no snapshot's retention.
 */
const system = (
  spec: Kind,
  rows: unknown = [spec.row],
  updated: unknown = { ...spec.row, schedule: AT_THREE },
  retention: unknown = {},
) => fakeSystem({ [spec.read]: rows, [spec.update]: updated, [RETENTION]: retention });

/** The args for the ordinary case: move that kind's task 3 to 03:00. */
const toThree = (spec: Kind, schedule: Record<string, unknown> = AT_THREE) => ({
  kind: spec.kind,
  id: 3,
  schedule,
});

/** The mutation step's description, for the plan made against `ctx`. */
const mutationText = async (
  ctx: ReturnType<typeof system>['ctx'],
  args: Record<string, unknown>,
): Promise<string> => {
  const steps = await scheduledTaskSetSchedule.plan(ctx, args);
  return steps[1].description;
};

describe('scheduled_task_set_schedule', () => {
  it('is a reversible mutating tool needing the full role', () => {
    expect(scheduledTaskSetSchedule).toMatchObject({
      name: 'scheduled_task_set_schedule',
      mutating: true,
      destructiveness: 'reversible',
      requiredRole: Role.Full,
    });
  });

  it('advertises the same six kinds as scheduled_task_set_enabled, and requires all five cron fields', () => {
    const schema = scheduledTaskSetSchedule.inputSchema as {
      properties: {
        kind: { enum: string[] };
        schedule: { required: string[]; properties: Record<string, unknown> };
      };
      required: string[];
    };
    expect(schema.properties.kind.enum).toEqual(kinds.map((spec) => spec.kind));
    expect(schema.required).toEqual(['kind', 'id', 'schedule']);
    // Refused by the schema itself, not only by the parser behind it.
    expect(schema.properties.schedule.required).toEqual(['minute', 'hour', 'dom', 'month', 'dow']);
    expect(Object.keys(schema.properties.schedule.properties)).toEqual([
      'minute',
      'hour',
      'dom',
      'month',
      'dow',
      'begin',
      'end',
    ]);
  });

  it('names each kind and the tool its ids come from', () => {
    for (const spec of kinds) {
      expect(scheduledTaskSetSchedule.description).toContain(`\`${spec.kind}\``);
      expect(scheduledTaskSetSchedule.description).toContain(`\`${spec.listedBy}\``);
    }
  });

  it('states the two effects that reach past "when", and the one-way replication change', () => {
    const description = scheduledTaskSetSchedule.description;
    expect(description).toContain('ONLY THE `schedule` FIELD IS SENT');
    expect(description).toContain('THIS TOOL CANNOT SET A SCHEDULE BACK TO NONE');
    expect(description).toContain('WHICH EXISTING SNAPSHOTS ITS RETENTION OWNS');
    expect(description).toContain('`pool.snapshottask.update_will_change_retention_for`');
    expect(description).toContain('`scheduled_task_set_enabled`');
  });

  it('delivers the result account with the result, and still carries it in the description', () => {
    const guidance = scheduledTaskSetSchedule.resultGuidance ?? '';
    expect(guidance).toContain('WHICH IS TWO OUTCOMES AND NOT ONE');
    expect(guidance).toContain('FALSE IS NOT A SUCCESS');
    expect(guidance).toContain('`previously_unscheduled`');
    expect(scheduledTaskSetSchedule.description.endsWith(guidance)).toBe(true);
  });

  it('normalizes args: keeps the three, and only the schedule fields it sends', () => {
    expect(
      scheduledTaskSetSchedule.normalizeArgs?.({
        kind: 'cron',
        id: 3,
        schedule: { ...AT_THREE, timezone: 'UTC' },
        extra: 1,
      }),
    ).toEqual({ kind: 'cron', id: 3, schedule: AT_THREE });
  });

  describe('argument validation', () => {
    const ctx = system(cloudSync).ctx;
    const plan = (args: Record<string, unknown>) => scheduledTaskSetSchedule.plan(ctx, args);

    it('requires a kind it knows, naming the ones it does', async () => {
      for (const bad of [undefined, 'init_shutdown_script', 'CRON', 7]) {
        await expect(plan({ kind: bad, id: 3, schedule: AT_THREE })).rejects.toThrow(
          /"kind" is required and must be one of .*periodic_snapshot/,
        );
      }
    });

    it('requires a whole-number id', async () => {
      for (const bad of [undefined, '3', 3.5]) {
        await expect(plan({ kind: 'cloud_sync', id: bad, schedule: AT_THREE })).rejects.toThrow(
          /"id" is required and must be a whole number/,
        );
      }
    });

    it('requires a schedule object', async () => {
      for (const bad of [undefined, null, '0 3 * * *', [AT_THREE]]) {
        await expect(plan({ kind: 'cloud_sync', id: 3, schedule: bad })).rejects.toThrow(
          /"schedule" is required and must be an object/,
        );
      }
    });

    it('refuses a schedule missing any of the five cron fields, naming it', async () => {
      for (const field of ['minute', 'hour', 'dom', 'month', 'dow']) {
        for (const bad of [undefined, '', 3]) {
          await expect(
            plan(toThree(cloudSync, { ...AT_THREE, [field]: bad })),
          ).rejects.toThrow(new RegExp(`"schedule\\.${field}" is required`));
        }
      }
    });

    it('accepts a window for periodic snapshot and replication tasks only', async () => {
      for (const spec of [cloudSync, cron, kinds[4], kinds[5]]) {
        await expect(
          scheduledTaskSetSchedule.plan(
            system(spec).ctx,
            toThree(spec, { ...AT_THREE, begin: '09:00', end: '17:00' }),
          ),
        ).rejects.toThrow(
          /accepted only for periodic_snapshot and replication — a .* has no daily window/,
        );
      }
      for (const spec of [snapshots, replication]) {
        await expect(
          scheduledTaskSetSchedule.plan(
            system(spec).ctx,
            toThree(spec, { ...AT_THREE, begin: '09:00', end: '17:00' }),
          ),
        ).resolves.toHaveLength(2);
      }
    });

    it('refuses half a window, or a window not written as HH:MM', async () => {
      const ownCtx = system(snapshots).ctx;
      for (const window of [
        { begin: '09:00' },
        { end: '17:00' },
        { begin: '9:00', end: '17:00' },
        { begin: '09:00', end: '24:00' },
        { begin: 900, end: '17:00' },
      ]) {
        await expect(
          scheduledTaskSetSchedule.plan(ownCtx, toThree(snapshots, { ...AT_THREE, ...window })),
        ).rejects.toThrow(/must be given together, each as HH:MM/);
      }
    });

    it('executes nothing when an argument is unreadable', async () => {
      const { ctx: own, query, call } = system(cron);
      await expect(
        scheduledTaskSetSchedule.execute(own, toThree(cron, { ...AT_THREE, hour: '' })),
      ).rejects.toThrow(/"schedule\.hour" is required/);
      expect(query).not.toHaveBeenCalled();
      expect(call).not.toHaveBeenCalled();
    });
  });

  describe.each(kinds.map((spec) => [spec.kind, spec] as const))('%s', (_name, spec) => {
    it('plans the read it makes as well as the mutation it makes', async () => {
      const steps = await scheduledTaskSetSchedule.plan(system(spec).ctx, toThree(spec));
      expect(steps.map((step) => step.method)).toEqual([spec.read, spec.update]);
      expect(steps[0]).toMatchObject({ params: [[['id', '=', 3]], {}] });
      expect(steps[0].description).toMatch(/Changes nothing/);
    });

    it('sends only the schedule, exactly as asked', async () => {
      const [, mutation] = await scheduledTaskSetSchedule.plan(system(spec).ctx, toThree(spec));
      expect(mutation.params).toEqual([3, { schedule: AT_THREE }]);
      expect(mutation.description).toContain('Only the schedule is sent.');
    });

    it('names the task in human terms, with the current and requested schedules in the same words', async () => {
      const text = await mutationText(system(spec).ctx, toThree(spec));
      expect(text).toContain(
        `Change when the ${spec.noun} with ${spec.named} (id 3) runs, to at 03:00, every day.`,
      );
      expect(text).toContain('Its schedule now is at 02:00, every day.');
    });

    it('fails when no task of that kind has that id, naming the kind searched', async () => {
      const { ctx } = system(spec, [{ ...spec.row, id: 4 }]);
      await expect(scheduledTaskSetSchedule.plan(ctx, toThree(spec))).rejects.toThrow(
        `No ${spec.noun} with id 3 on this system — the kind searched was ` +
          `"${spec.kind}", whose ids come from \`${spec.listedBy}\``,
      );
    });

    it('executes the read and then the update the plan named', async () => {
      const { ctx, query, call } = system(spec);
      await scheduledTaskSetSchedule.execute(ctx, toThree(spec));
      expect(query).toHaveBeenCalledWith(spec.read, [['id', '=', 3]]);
      expect(call).toHaveBeenCalledWith(spec.update, [3, { schedule: AT_THREE }]);
      // The retention read is plan-time only, so `execute` never makes it.
      expect(call).not.toHaveBeenCalledWith(RETENTION, expect.anything());
    });

    it('reports a window only for a kind that has one', async () => {
      const result = (await scheduledTaskSetSchedule.execute(
        system(spec).ctx,
        toThree(spec),
      )) as { resulting_schedule: Record<string, unknown> };
      expect(Object.keys(result.resulting_schedule)).toEqual(
        spec.window
          ? ['minute', 'hour', 'dom', 'month', 'dow', 'begin', 'end']
          : ['minute', 'hour', 'dom', 'month', 'dow'],
      );
    });
  });

  describe('the outcome it reports', () => {
    it('reports a schedule it actually changed', async () => {
      expect(await scheduledTaskSetSchedule.execute(system(cloudSync).ctx, toThree(cloudSync))).toEqual({
        kind: 'cloud_sync',
        id: 3,
        requested_schedule: AT_THREE,
        lookup: 'FOUND',
        lookup_error: null,
        previous_schedule: AT_TWO,
        previously_unscheduled: false,
        resulting_schedule: AT_THREE,
        changed: true,
        confirmed: true,
      });
    });

    it('reports a task already on the requested schedule as unchanged, and says so in the plan', async () => {
      const already = { ...cloudSync.row, schedule: AT_THREE };
      const ctx = system(cloudSync, [already], already).ctx;
      expect(await mutationText(ctx, toThree(cloudSync))).toContain(
        'Every field this sends already has that value on the task, which is not an error.',
      );
      expect(await scheduledTaskSetSchedule.execute(ctx, toThree(cloudSync))).toMatchObject({
        changed: false,
        confirmed: true,
      });
    });

    it('does not say a task is already there when it is not', async () => {
      expect(await mutationText(system(cloudSync).ctx, toThree(cloudSync))).not.toContain(
        'already has that value',
      );
    });

    it('reads the outcome off the response, never off the request', async () => {
      // The method answers with the updated task, so a response still carrying
      // the old schedule is the system not having applied the change.
      const { ctx } = system(cloudSync, [cloudSync.row], cloudSync.row);
      expect(await scheduledTaskSetSchedule.execute(ctx, toThree(cloudSync))).toMatchObject({
        resulting_schedule: AT_TWO,
        changed: false,
        confirmed: false,
      });
    });

    it('reads a response storing no schedule at all as not the one requested', async () => {
      const { ctx } = system(replication, [replication.row], { ...replication.row, schedule: null });
      expect(await scheduledTaskSetSchedule.execute(ctx, toThree(replication))).toMatchObject({
        resulting_schedule: null,
        changed: null,
        confirmed: false,
      });
    });

    it('establishes nothing when the response is not a record', async () => {
      const { ctx } = system(cloudSync, [cloudSync.row], true);
      expect(await scheduledTaskSetSchedule.execute(ctx, toThree(cloudSync))).toMatchObject({
        resulting_schedule: null,
        changed: null,
        confirmed: null,
      });
    });

    it('establishes nothing when the response carries a field it could not read', async () => {
      const { ctx } = system(cloudSync, [cloudSync.row], {
        ...cloudSync.row,
        schedule: { ...AT_THREE, dow: 7 },
      });
      expect(await scheduledTaskSetSchedule.execute(ctx, toThree(cloudSync))).toMatchObject({
        resulting_schedule: { ...AT_THREE, dow: null },
        changed: null,
        confirmed: null,
      });
    });

    it('reports NOT_FOUND and still makes the update the plan named', async () => {
      const { ctx, call } = system(cloudSync, []);
      expect(await scheduledTaskSetSchedule.execute(ctx, toThree(cloudSync))).toMatchObject({
        lookup: 'NOT_FOUND',
        previous_schedule: null,
        previously_unscheduled: null,
        changed: null,
        confirmed: true,
      });
      expect(call).toHaveBeenCalledWith('cloudsync.update', [3, { schedule: AT_THREE }]);
    });

    it('reports UNREADABLE with the reason, and still makes the update', async () => {
      const { ctx, call } = failingSystem(
        { ['cloudsync.update']: { ...cloudSync.row, schedule: AT_THREE } },
        { ['cloudsync.query']: new Error('websocket closed') },
      );
      expect(await scheduledTaskSetSchedule.execute(ctx, toThree(cloudSync))).toMatchObject({
        lookup: 'UNREADABLE',
        lookup_error: 'websocket closed',
        previous_schedule: null,
        previously_unscheduled: null,
      });
      expect(call).toHaveBeenCalledWith('cloudsync.update', [3, { schedule: AT_THREE }]);
    });

    it('fails the call when the update itself rejects', async () => {
      const { ctx } = failingSystem(
        { ['cloudsync.query']: [cloudSync.row] },
        { ['cloudsync.update']: { reason: 'invalid cron' } },
      );
      await expect(scheduledTaskSetSchedule.execute(ctx, toThree(cloudSync))).rejects.toEqual({
        reason: 'invalid cron',
      });
    });

    it('re-checks the id on the response rather than trusting the filter', async () => {
      const whole = [{ ...cloudSync.row, id: 1, description: 'not this one' }, cloudSync.row];
      const text = await mutationText(system(cloudSync, whole).ctx, toThree(cloudSync));
      expect(text).toContain('description "Nightly Backblaze"');
      expect(text).not.toContain('not this one');
    });
  });

  describe('a replication task with no schedule of its own', () => {
    const unscheduled = { ...replication.row, schedule: null };

    it('says in the plan that this changes what triggers it', async () => {
      const text = await mutationText(system(replication, [unscheduled]).ctx, toThree(replication));
      expect(text).toContain('It has no schedule of its own now (its `schedule` is null)');
      expect(text).toContain('running after its periodic snapshot task (unconfirmed');
      expect(text).toContain('changes what triggers it and not only when it runs');
    });

    it('reports it as previously unscheduled, and the change as a change', async () => {
      const result = await scheduledTaskSetSchedule.execute(
        system(replication, [unscheduled], { ...unscheduled, schedule: { ...AT_THREE, begin: '00:00', end: '23:59' } }).ctx,
        toThree(replication),
      );
      expect(result).toMatchObject({
        previous_schedule: null,
        previously_unscheduled: true,
        changed: true,
        confirmed: true,
      });
    });

    it('does not call the change established when the response could not be read in full', async () => {
      const result = await scheduledTaskSetSchedule.execute(
        system(replication, [unscheduled], { ...unscheduled, schedule: { ...AT_THREE, hour: 3 } }).ctx,
        toThree(replication),
      );
      expect(result).toMatchObject({ previously_unscheduled: true, changed: null, confirmed: null });
    });

    it('is a stored null only on that kind: elsewhere it is a schedule not rendered', async () => {
      const text = await mutationText(
        system(cloudSync, [{ ...cloudSync.row, schedule: null }]).ctx,
        toThree(cloudSync),
      );
      expect(text).toContain(
        'Its schedule now is (not rendered in words here; `cloudsync_tasks_list` reports its cron fields).',
      );
    });
  });

  describe('the daily window', () => {
    it('sends a window that was asked for, and renders it', async () => {
      const asked = { ...AT_THREE, begin: '09:00', end: '17:00' };
      const [, mutation] = await scheduledTaskSetSchedule.plan(
        system(snapshots).ctx,
        toThree(snapshots, asked),
      );
      expect(mutation.params).toEqual([3, { schedule: asked }]);
      expect(mutation.description).toContain('runs, to at 03:00, every day, between 09:00 and 17:00.');
      expect(mutation.description).not.toContain('No daily window is sent');
    });

    it('says where none was sent that the stored one may not survive, naming it', async () => {
      const windowed = { ...snapshots.row, schedule: { ...AT_TWO, begin: '09:00', end: '17:00' } };
      expect(await mutationText(system(snapshots, [windowed]).ctx, toThree(snapshots))).toContain(
        'No daily window is sent, and its current window is between 09:00 and 17:00; whether ' +
          'the system keeps the stored window or resets it to the whole day is (unconfirmed)',
      );
    });

    it('names a whole-day window as that, and an unreadable one as unreadable', async () => {
      const whole = { ...replication.row, schedule: { ...AT_TWO, begin: '00:00', end: '23:59' } };
      expect(await mutationText(system(replication, [whole]).ctx, toThree(replication))).toContain(
        'its current window is the whole day',
      );
      expect(await mutationText(system(replication).ctx, toThree(replication))).toContain(
        'its current window could not be read',
      );
    });

    it('says nothing about a window for a kind that has none', async () => {
      expect(await mutationText(system(cloudSync).ctx, toThree(cloudSync))).not.toContain('window');
    });

    it('confirms on the fields sent, while `changed` still compares the window it reads', async () => {
      const before = { ...snapshots.row, schedule: { ...AT_TWO, begin: '09:00', end: '17:00' } };
      const after = { ...snapshots.row, schedule: { ...AT_THREE, begin: '00:00', end: '23:59' } };
      expect(
        await scheduledTaskSetSchedule.execute(system(snapshots, [before], after).ctx, toThree(snapshots)),
      ).toMatchObject({
        previous_schedule: { ...AT_TWO, begin: '09:00', end: '17:00' },
        resulting_schedule: { ...AT_THREE, begin: '00:00', end: '23:59' },
        changed: true,
        confirmed: true,
      });
    });

    it('does not confirm a window that came back different from the one sent', async () => {
      const asked = { ...AT_THREE, begin: '09:00', end: '17:00' };
      const after = { ...snapshots.row, schedule: { ...AT_THREE, begin: '00:00', end: '23:59' } };
      expect(
        await scheduledTaskSetSchedule.execute(
          system(snapshots, [snapshots.row], after).ctx,
          toThree(snapshots, asked),
        ),
      ).toMatchObject({ confirmed: false });
    });
  });

  describe('what a periodic snapshot change does to retention', () => {
    it('asks the middleware with the schedule being sent, at plan time only', async () => {
      const { ctx, call } = system(snapshots);
      const steps = await scheduledTaskSetSchedule.plan(ctx, toThree(snapshots));
      expect(call).toHaveBeenCalledWith(RETENTION, [3, { schedule: AT_THREE }]);
      // Not a step: `execute` does not make it (#119).
      expect(steps.map((step) => step.method)).not.toContain(RETENTION);
    });

    it('is asked for no other kind', async () => {
      const { ctx, call } = system(replication);
      await scheduledTaskSetSchedule.plan(ctx, toThree(replication));
      expect(call).not.toHaveBeenCalledWith(RETENTION, expect.anything());
    });

    it('says when no existing snapshot is affected', async () => {
      for (const answer of [{}, { 'tank/media': [] }]) {
        expect(
          await mutationText(system(snapshots, undefined, undefined, answer).ctx, toThree(snapshots)),
        ).toContain(
          'TrueNAS reports, through `pool.snapshottask.update_will_change_retention_for`, ' +
            'that this changes the retention of no existing snapshot.',
        );
      }
    });

    it('counts what is affected, by dataset, and does not claim to know what happens to each', async () => {
      const answer = {
        'tank/media': ['auto-2026-10-01_02-00', 'auto-2026-10-02_02-00'],
        'tank/media/raw': ['auto-2026-10-01_02-00'],
      };
      const text = await mutationText(system(snapshots, undefined, undefined, answer).ctx, toThree(snapshots));
      expect(text).toContain(
        'that this changes the retention of 3 existing snapshots on 2 datasets — ' +
          'tank/media (2), tank/media/raw (1).',
      );
      expect(text).toContain('It names them and not what happens to each');
      expect(text).toContain('`snapshots_list` with `report_scheduled_removal`');
    });

    it('names at most five datasets and counts the rest', async () => {
      const answer = Object.fromEntries(
        Array.from({ length: 7 }, (_, index) => [`tank/d${index}`, ['auto-1']]),
      );
      const text = await mutationText(system(snapshots, undefined, undefined, answer).ctx, toThree(snapshots));
      expect(text).toContain('7 existing snapshots on 7 datasets');
      expect(text).toContain('tank/d4 (1) and 2 more.');
      expect(text).not.toContain('tank/d5');
    });

    it('uses the singular for one snapshot on one dataset', async () => {
      const text = await mutationText(
        system(snapshots, undefined, undefined, { 'tank/media': ['auto-1'] }).ctx,
        toThree(snapshots),
      );
      expect(text).toContain('1 existing snapshot on 1 dataset — tank/media (1).');
    });

    it('states an answer it cannot read in full as unread, never as a smaller count', async () => {
      for (const answer of [null, ['tank/media'], { 'tank/media': ['a'], 'tank/other': 'b' }, { x: [1] }]) {
        const text = await mutationText(
          system(snapshots, undefined, undefined, answer).ctx,
          toThree(snapshots),
        );
        expect(text).toContain(
          'Whether this changes the retention of existing snapshots could not be established: ' +
            '`pool.snapshottask.update_will_change_retention_for` answered with something this ' +
            'tool could not read.',
        );
      }
    });

    it('does not fail the plan when the read fails, and says why', async () => {
      const { ctx } = failingSystem(
        { [snapshots.read]: [snapshots.row] },
        { [RETENTION]: new Error('zettarepl is busy') },
      );
      const steps = await scheduledTaskSetSchedule.plan(ctx, toThree(snapshots));
      expect(steps).toHaveLength(2);
      expect(steps[1].description).toContain(
        '`pool.snapshottask.update_will_change_retention_for` failed (zettarepl is busy).',
      );
    });
  });

  describe('what the plan and the result leave out', () => {
    it("does not repeat a cron job's command, which can hold an inlined secret", async () => {
      const { ctx } = system(cron);
      expect(await mutationText(ctx, toThree(cron))).not.toContain('hunter2');
      expect(JSON.stringify(await scheduledTaskSetSchedule.execute(ctx, toThree(cron)))).not.toContain(
        'hunter2',
      );
    });

    it("does not repeat a cloud backup task's repository passphrase", async () => {
      const backup = kinds[5];
      const { ctx } = system(backup);
      expect(await mutationText(ctx, toThree(backup))).not.toContain('repository-passphrase');
      expect(
        JSON.stringify(await scheduledTaskSetSchedule.execute(ctx, toThree(backup))),
      ).not.toContain('repository-passphrase');
    });

    it('states a requested schedule it cannot put into words by its fields, as sent', async () => {
      const odd = { minute: '*/7', hour: '*', dom: '*', month: '*', dow: '*' };
      expect(await mutationText(system(cloudSync).ctx, toThree(cloudSync, odd))).toContain(
        'runs, to (not rendered in words here) minute "*/7", hour "*", dom "*", month "*", dow "*".',
      );
      const windowed = { ...odd, begin: '09:00', end: '17:00' };
      expect(await mutationText(system(snapshots).ctx, toThree(snapshots, windowed))).toContain(
        'dow "*", begin "09:00", end "17:00".',
      );
    });
  });
});
