import { describe, expect, it } from 'vitest';
import { Role } from '@/interfaces';
import { fakeSystem, failingSystem } from '@/testing/fake-systems';
import { scheduledTaskSetEnabled } from '@/tools/index';

/**
 * `scheduled_task_set_enabled`'s tests live here rather than in
 * `tasks.spec.ts`, which is the #87 split exception and is CHECKED rather than
 * felt: `tasks.spec.ts` was 1,352 lines before this ticket and this block is
 * several hundred more, so the merged file crosses the 1,500-line trigger where
 * #97's fourth tool did not. The split is by tool, so the filename says exactly
 * what is in it; the four listing tools stay where they are.
 */

/** The kinds, with the two methods each and a row shaped the way its table is. */
const kinds = [
  {
    kind: 'periodic_snapshot',
    noun: 'periodic snapshot task',
    listedBy: 'snapshot_tasks_list',
    read: 'pool.snapshottask.query',
    update: 'pool.snapshottask.update',
    row: {
      id: 3,
      dataset: 'tank/media',
      enabled: true,
      schedule: { minute: '0', hour: '2', dom: '*', month: '*', dow: '*' },
    },
    named: ['dataset "tank/media"'],
  },
  {
    kind: 'cloud_sync',
    noun: 'cloud sync task',
    listedBy: 'cloudsync_tasks_list',
    read: 'cloudsync.query',
    update: 'cloudsync.update',
    row: {
      id: 3,
      description: 'Nightly Backblaze',
      path: '/mnt/tank/media',
      direction: 'PUSH',
      enabled: true,
      schedule: { minute: '0', hour: '2', dom: '*', month: '*', dow: '*' },
    },
    named: ['description "Nightly Backblaze"', 'path "/mnt/tank/media"', 'direction "PUSH"'],
  },
  {
    kind: 'replication',
    noun: 'replication task',
    listedBy: 'replication_status',
    read: 'replication.query',
    update: 'replication.update',
    row: {
      id: 3,
      name: 'media to backup',
      target_dataset: 'backup/media',
      enabled: true,
      schedule: { minute: '0', hour: '2', dom: '*', month: '*', dow: '*' },
    },
    named: ['name "media to backup"', 'target dataset "backup/media"'],
  },
  {
    kind: 'cron',
    noun: 'cron job',
    listedBy: 'automated_tasks_list',
    read: 'cronjob.query',
    update: 'cronjob.update',
    row: {
      id: 3,
      description: 'prune logs',
      user: 'root',
      command: 'curl -u admin:hunter2 https://example.test/ping',
      enabled: true,
      schedule: { minute: '0', hour: '2', dom: '*', month: '*', dow: '*' },
    },
    named: ['description "prune logs"', 'user "root"'],
  },
  {
    kind: 'rsync',
    noun: 'rsync task',
    listedBy: 'automated_tasks_list',
    read: 'rsynctask.query',
    update: 'rsynctask.update',
    row: {
      id: 3,
      desc: 'offsite copy',
      path: '/mnt/tank/docs',
      direction: 'PUSH',
      enabled: true,
      schedule: { minute: '0', hour: '2', dom: '*', month: '*', dow: '*' },
    },
    named: ['description "offsite copy"', 'path "/mnt/tank/docs"', 'direction "PUSH"'],
  },
  {
    kind: 'cloud_backup',
    noun: 'cloud backup task',
    listedBy: 'automated_tasks_list',
    read: 'cloud_backup.query',
    update: 'cloud_backup.update',
    row: {
      id: 3,
      description: 'restic to B2',
      path: '/mnt/tank/vault',
      password: 'repository-passphrase',
      enabled: true,
      schedule: { minute: '0', hour: '2', dom: '*', month: '*', dow: '*' },
    },
    named: ['description "restic to B2"', 'path "/mnt/tank/vault"'],
  },
] as const;

type Kind = (typeof kinds)[number];

/**
 * A system listing that kind's row and answering its update with the row as it
 * would be after the change — which is what these methods actually answer with.
 */
const system = (spec: Kind, rows: unknown = [spec.row], updated?: unknown) =>
  fakeSystem({
    [spec.read]: rows,
    [spec.update]: updated === undefined ? { ...spec.row, enabled: false } : updated,
  });

/** The args for the ordinary case: switch that kind's task 3 off. */
const off = (spec: Kind) => ({ kind: spec.kind, id: 3, enabled: false });

describe('scheduled_task_set_enabled', () => {
  it('is a reversible mutating tool needing the full role', () => {
    expect(scheduledTaskSetEnabled).toMatchObject({
      name: 'scheduled_task_set_enabled',
      mutating: true,
      destructiveness: 'reversible',
      requiredRole: Role.Full,
    });
  });

  it('advertises exactly the six kinds it can reach, and not init/shutdown scripts', () => {
    const schema = scheduledTaskSetEnabled.inputSchema as {
      properties: { kind: { enum: string[] } };
      required: string[];
    };
    expect(schema.properties.kind.enum).toEqual([
      'periodic_snapshot',
      'cloud_sync',
      'replication',
      'cron',
      'rsync',
      'cloud_backup',
    ]);
    // An init/shutdown script is not scheduled — it runs at a point in the
    // system's lifecycle — so a tool named for scheduled tasks must not accept
    // one, whatever its update type declares.
    expect(schema.properties.kind.enum).not.toContain('init_shutdown_script');
    expect(schema.required).toEqual(['kind', 'id', 'enabled']);
  });

  it('names each kind, the tool that lists its ids, and the init/shutdown gap', () => {
    const description = scheduledTaskSetEnabled.description;
    for (const spec of kinds) {
      expect(description).toContain(`\`${spec.kind}\``);
      expect(description).toContain(`\`${spec.listedBy}\``);
    }
    expect(description).toContain('INIT/SHUTDOWN SCRIPTS ARE NOT COVERED');
    expect(description).toContain('ONLY THE `enabled` FIELD IS SENT');
  });

  it('normalizes args: keeps the three and drops unknown keys', () => {
    expect(
      scheduledTaskSetEnabled.normalizeArgs?.({
        kind: 'cron',
        id: 3,
        enabled: true,
        extra: 1,
        systems: 'all',
      }),
    ).toEqual({ kind: 'cron', id: 3, enabled: true });
  });

  describe('argument validation', () => {
    const ctx = system(kinds[0]).ctx;

    it('requires a kind it knows, naming the ones it does', async () => {
      for (const bad of [undefined, null, '', 'init_shutdown_script', 'CRON', 7]) {
        expect(() =>
          scheduledTaskSetEnabled.normalizeArgs?.({ kind: bad, id: 3, enabled: false }),
        ).toThrow(/"kind" is required and must be one of .*periodic_snapshot/);
        await expect(
          scheduledTaskSetEnabled.plan(ctx, { kind: bad, id: 3, enabled: false }),
        ).rejects.toThrow(/"kind" is required/);
      }
    });

    it('requires a whole-number id', async () => {
      for (const bad of [undefined, null, '3', 3.5, Number.NaN]) {
        expect(() =>
          scheduledTaskSetEnabled.normalizeArgs?.({
            kind: 'periodic_snapshot',
            id: bad,
            enabled: false,
          }),
        ).toThrow(/"id" is required and must be a whole number/);
        await expect(
          scheduledTaskSetEnabled.plan(ctx, { kind: 'periodic_snapshot', id: bad, enabled: false }),
        ).rejects.toThrow(/"id" is required/);
      }
    });

    it('requires a boolean enabled and coerces nothing into one', async () => {
      // Coercing "false" to true would switch ON a backup task the caller
      // asked to switch off.
      for (const bad of [undefined, null, 'false', 0, 1]) {
        expect(() =>
          scheduledTaskSetEnabled.normalizeArgs?.({
            kind: 'periodic_snapshot',
            id: 3,
            enabled: bad,
          }),
        ).toThrow(/"enabled" is required and must be a boolean/);
        await expect(
          scheduledTaskSetEnabled.plan(ctx, { kind: 'periodic_snapshot', id: 3, enabled: bad }),
        ).rejects.toThrow(/"enabled" is required/);
      }
    });

    it('executes nothing when an argument is unreadable', async () => {
      const { call } = system(kinds[0]);
      await expect(
        scheduledTaskSetEnabled.execute(ctx, { kind: 'cron', id: 3, enabled: 'yes' }),
      ).rejects.toThrow(/"enabled" is required/);
      expect(call).not.toHaveBeenCalled();
    });
  });

  describe.each(kinds.map((spec) => [spec.kind, spec] as const))('%s', (_name, spec) => {
    it('plans the read it makes as well as the mutation it makes', async () => {
      const steps = await scheduledTaskSetEnabled.plan(system(spec).ctx, off(spec));
      // Two steps because `execute` makes two calls. A plan naming only the
      // mutation would not be a true account of what runs.
      expect(steps.map((step) => step.method)).toEqual([spec.read, spec.update]);
      expect(steps[0]).toMatchObject({ params: [[['id', '=', 3]]] });
      expect(steps[0].description).toMatch(/Changes nothing/);
    });

    it('sends only the enabled field, and sends the state that was asked for', async () => {
      const [, mutation] = await scheduledTaskSetEnabled.plan(system(spec).ctx, off(spec));
      expect(mutation.params).toEqual([3, { enabled: false }]);
      const [, on] = await scheduledTaskSetEnabled.plan(system(spec).ctx, {
        kind: spec.kind,
        id: 3,
        enabled: true,
      });
      expect(on.params).toEqual([3, { enabled: true }]);
      expect(mutation.description).toContain('Only the enabled flag is sent');
    });

    it('names the task in human terms, with its schedule in words', async () => {
      const [, mutation] = await scheduledTaskSetEnabled.plan(system(spec).ctx, off(spec));
      expect(mutation.description).toContain(`Disable the ${spec.noun}`);
      for (const part of spec.named) {
        expect(mutation.description).toContain(part);
      }
      expect(mutation.description).toContain('schedule at 02:00, every day');
      expect(mutation.description).toContain('(id 3)');
    });

    it('fails when no task of that kind has that id, naming the kind searched', async () => {
      const { ctx } = system(spec, [{ ...spec.row, id: 4 }]);
      await expect(scheduledTaskSetEnabled.plan(ctx, off(spec))).rejects.toThrow(
        new RegExp(
          `No ${spec.noun} with id 3 on this system — the kind searched was ` +
            `"${spec.kind}", whose ids come from \`${spec.listedBy}\``,
        ),
      );
    });

    it('executes the read and then the update the plan named', async () => {
      const { ctx, query, call } = system(spec);
      await scheduledTaskSetEnabled.execute(ctx, off(spec));
      expect(query).toHaveBeenCalledWith(spec.read, [['id', '=', 3]]);
      expect(call).toHaveBeenCalledWith(spec.update, [3, { enabled: false }]);
    });
  });

  describe('the outcome it reports', () => {
    const cloudSync = kinds[1];

    it('reports a task it actually changed', async () => {
      const { ctx } = system(cloudSync);
      expect(await scheduledTaskSetEnabled.execute(ctx, off(cloudSync))).toEqual({
        kind: 'cloud_sync',
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

    it('reports a task already in the requested state as changing nothing', async () => {
      const already = { ...cloudSync.row, enabled: false };
      const { ctx } = system(cloudSync, [already], already);
      const result = await scheduledTaskSetEnabled.execute(ctx, off(cloudSync));
      expect(result).toMatchObject({
        previously_enabled: false,
        resulting_enabled: false,
        changed: false,
        confirmed: true,
      });
    });

    it('says so in the plan when the task is already in the requested state', async () => {
      const already = { ...cloudSync.row, enabled: false };
      const [, mutation] = await scheduledTaskSetEnabled.plan(
        system(cloudSync, [already], already).ctx,
        off(cloudSync),
      );
      expect(mutation.description).toContain(
        'It is already disabled, so this changes nothing and is not an error.',
      );
    });

    it('says in the plan which way the switch will move', async () => {
      const [, disabling] = await scheduledTaskSetEnabled.plan(
        system(cloudSync).ctx,
        off(cloudSync),
      );
      expect(disabling.description).toContain('It is enabled, so this will disable it.');
      const offRow = { ...cloudSync.row, enabled: false };
      const [, enabling] = await scheduledTaskSetEnabled.plan(
        system(cloudSync, [offRow], { ...offRow, enabled: true }).ctx,
        { kind: 'cloud_sync', id: 3, enabled: true },
      );
      expect(enabling.description).toContain('It is disabled, so this will enable it.');
    });

    it('refuses to claim a direction when the prior state is unreadable', async () => {
      const unreadable = { ...cloudSync.row, enabled: 'yes' };
      const [, mutation] = await scheduledTaskSetEnabled.plan(
        system(cloudSync, [unreadable]).ctx,
        off(cloudSync),
      );
      expect(mutation.description).toContain(
        'Whether it is enabled could not be read, so this may change nothing.',
      );
    });

    it('reports FOUND with a null prior state when the task stated no enabled', async () => {
      const { ctx } = system(cloudSync, [{ ...cloudSync.row, enabled: 'yes' }]);
      // The fourth cause of a null `previously_enabled`, which `lookup` alone
      // does not separate from the other three.
      expect(await scheduledTaskSetEnabled.execute(ctx, off(cloudSync))).toMatchObject({
        lookup: 'FOUND',
        previously_enabled: null,
        resulting_enabled: false,
        changed: null,
      });
    });

    it('reports NOT_FOUND and still makes the update the plan named', async () => {
      const { ctx, call } = system(cloudSync, []);
      expect(await scheduledTaskSetEnabled.execute(ctx, off(cloudSync))).toMatchObject({
        lookup: 'NOT_FOUND',
        lookup_error: null,
        previously_enabled: null,
        resulting_enabled: false,
        changed: null,
        confirmed: true,
      });
      // Unconditional: skipping it would be `execute` branching on state read
      // after the plan was approved.
      expect(call).toHaveBeenCalledWith('cloudsync.update', [3, { enabled: false }]);
    });

    it('reports UNREADABLE with the reason, and still makes the update', async () => {
      const { ctx, call } = failingSystem(
        { ['cloudsync.update']: { ...cloudSync.row, enabled: false } },
        { ['cloudsync.query']: new Error('websocket closed') },
      );
      expect(await scheduledTaskSetEnabled.execute(ctx, off(cloudSync))).toMatchObject({
        lookup: 'UNREADABLE',
        lookup_error: 'websocket closed',
        previously_enabled: null,
        changed: null,
      });
      expect(call).toHaveBeenCalledWith('cloudsync.update', [3, { enabled: false }]);
    });

    it('does not report success when the response disagrees with the request', async () => {
      // The method answers with the updated task, so a response still reporting
      // the old state is the system not having applied the change.
      const { ctx } = system(cloudSync, [cloudSync.row], { ...cloudSync.row, enabled: true });
      expect(await scheduledTaskSetEnabled.execute(ctx, off(cloudSync))).toMatchObject({
        requested_enabled: false,
        previously_enabled: true,
        resulting_enabled: true,
        changed: false,
        confirmed: false,
      });
    });

    it('establishes nothing about the result when the response states no enabled', async () => {
      const { ctx } = system(cloudSync, [cloudSync.row], { ...cloudSync.row, enabled: 'yes' });
      expect(await scheduledTaskSetEnabled.execute(ctx, off(cloudSync))).toMatchObject({
        previously_enabled: true,
        resulting_enabled: null,
        changed: null,
        confirmed: null,
      });
    });

    it('establishes nothing about the result when the response is not a record', async () => {
      const { ctx } = system(cloudSync, [cloudSync.row], true);
      expect(await scheduledTaskSetEnabled.execute(ctx, off(cloudSync))).toMatchObject({
        resulting_enabled: null,
        changed: null,
        confirmed: null,
      });
    });

    it('fails the call when the update itself rejects', async () => {
      const { ctx } = failingSystem(
        { ['cloudsync.query']: [cloudSync.row] },
        { ['cloudsync.update']: { reason: 'task is locked' } },
      );
      await expect(scheduledTaskSetEnabled.execute(ctx, off(cloudSync))).rejects.toEqual({
        reason: 'task is locked',
      });
    });
  });

  describe('the id it acts on', () => {
    const cloudSync = kinds[1];

    it('re-checks the id on the response rather than trusting the filter', async () => {
      // An unrecognised query parameter is dropped rather than refused, so a
      // filter that did not apply comes back as the whole table — and its first
      // row is a different task.
      const whole = [{ ...cloudSync.row, id: 1 }, { ...cloudSync.row, id: 2 }, cloudSync.row];
      const [, mutation] = await scheduledTaskSetEnabled.plan(
        system(cloudSync, whole).ctx,
        off(cloudSync),
      );
      expect(mutation.params).toEqual([3, { enabled: false }]);
      expect(mutation.description).toContain('(id 3)');
    });

    it('treats an answer that is not a list as no task of that kind', async () => {
      const { ctx } = system(cloudSync, 7);
      await expect(scheduledTaskSetEnabled.plan(ctx, off(cloudSync))).rejects.toThrow(
        /No cloud sync task with id 3/,
      );
    });

    it('skips a listed row that is not a record', async () => {
      const { ctx } = system(cloudSync, [null, 'a row', cloudSync.row]);
      const [, mutation] = await scheduledTaskSetEnabled.plan(ctx, off(cloudSync));
      expect(mutation.description).toContain('description "Nightly Backblaze"');
    });

    it('skips a listed row whose own id is not a number', async () => {
      const { ctx } = system(cloudSync, [{ ...cloudSync.row, id: '3' }]);
      await expect(scheduledTaskSetEnabled.plan(ctx, off(cloudSync))).rejects.toThrow(
        /No cloud sync task with id 3/,
      );
    });
  });

  describe('what the plan says about the task', () => {
    const cloudSync = kinds[1];

    it('states a field the system reported none of rather than dropping it', async () => {
      const { ctx } = system(cloudSync, [
        { ...cloudSync.row, description: '', path: null, direction: 7 },
      ]);
      const [, mutation] = await scheduledTaskSetEnabled.plan(ctx, off(cloudSync));
      expect(mutation.description).toContain('description (the system reported none)');
      expect(mutation.description).toContain('path (the system reported none)');
      expect(mutation.description).toContain('direction (the system reported none)');
    });

    it('says a schedule it cannot render is one it cannot render, not one that is absent', async () => {
      const { ctx } = system(cloudSync, [
        { ...cloudSync.row, schedule: { minute: '*/7', hour: '*', dom: '*', month: '*', dow: '*' } },
      ]);
      const [, mutation] = await scheduledTaskSetEnabled.plan(ctx, off(cloudSync));
      expect(mutation.description).toContain(
        'schedule (not rendered in words here; `cloudsync_tasks_list` reports its cron fields)',
      );
    });

    it('says the same for a task carrying no readable schedule at all', async () => {
      const { ctx } = system(cloudSync, [{ ...cloudSync.row, schedule: null }]);
      const [, mutation] = await scheduledTaskSetEnabled.plan(ctx, off(cloudSync));
      expect(mutation.description).toContain('schedule (not rendered in words here');
    });

    it("renders a periodic snapshot task's daily window, which only it carries", async () => {
      const snapshots = kinds[0];
      const { ctx } = system(snapshots, [
        {
          ...snapshots.row,
          schedule: {
            minute: '0',
            hour: '2',
            dom: '*',
            month: '*',
            dow: '*',
            begin: '09:00',
            end: '17:00',
          },
        },
      ]);
      const [, mutation] = await scheduledTaskSetEnabled.plan(ctx, off(snapshots));
      expect(mutation.description).toContain(
        'schedule at 02:00, every day, between 09:00 and 17:00',
      );
    });

    it("does not repeat a cron job's command, which can hold an inlined secret", async () => {
      const cron = kinds[3];
      const [, mutation] = await scheduledTaskSetEnabled.plan(system(cron).ctx, off(cron));
      expect(mutation.description).not.toContain('hunter2');
      expect(mutation.description).not.toContain('curl');
    });

    it("does not repeat a cloud backup task's repository passphrase", async () => {
      const backup = kinds[5];
      const [, mutation] = await scheduledTaskSetEnabled.plan(system(backup).ctx, off(backup));
      expect(mutation.description).not.toContain('repository-passphrase');
    });
  });
});
