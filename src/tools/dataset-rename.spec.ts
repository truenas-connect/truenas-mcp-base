import { describe, expect, it, vi } from 'vitest';
import { of, throwError } from 'rxjs';
import { SystemHandle, ToolContext } from '@/catalog/tool';
import { datasetRename } from '@/tools/storage';

/**
 * A system whose `pool.dataset.query` honours the two filter shapes this tool
 * sends — `id =` and `id in` — and answers an empty filter with every dataset.
 * `fakeSystem` answers every read from one list, which cannot tell "the dataset
 * exists" from "the new name is free", and this tool asks both.
 */
function renameSystem(
  options: {
    datasets?: Record<string, unknown>[];
    calls?: Record<string, unknown>;
    failures?: Record<string, unknown>;
    queryFailure?: (filters: unknown[]) => unknown;
  } = {},
): { ctx: ToolContext; call: ReturnType<typeof vi.fn>; query: ReturnType<typeof vi.fn> } {
  const datasets = options.datasets ?? [
    { id: 'tank', type: 'FILESYSTEM' },
    { id: 'tank/projects', type: 'FILESYSTEM' },
    { id: 'tank/projects/a', type: 'FILESYSTEM' },
    { id: 'tank/projects/a/b', type: 'FILESYSTEM' },
    { id: 'tank/archive', type: 'FILESYSTEM' },
  ];
  const calls: Record<string, unknown> = {
    'systemdataset.config': { pool: 'tank', basename: 'tank/.system' },
    'pool.dataset.attachments': [],
    'pool.dataset.rename': null,
    ...options.calls,
  };
  const failures = options.failures ?? {};
  const call = vi.fn((method: string) =>
    method in failures ? throwError(() => failures[method]) : of(calls[method]),
  );
  const query = vi.fn((_method: string, filters: unknown[]) => {
    const failure = options.queryFailure?.(filters);
    if (failure !== undefined) return throwError(() => failure);
    const [filter] = filters as [string, string, unknown][];
    if (filter === undefined) return of(datasets);
    const [, op, value] = filter;
    const wanted = op === 'in' ? (value as unknown[]) : [value];
    return of(datasets.filter((row) => wanted.includes(row?.['id'])));
  });
  const system = { name: 'nas', client: { api: { call, query } } } as unknown as SystemHandle;
  return { ctx: { system }, call, query };
}

const ARGS = { dataset: 'tank/projects', new_name: 'tank/archive/projects' };

describe('dataset_rename', () => {
  const plan = (args: Record<string, unknown> = {}, system = renameSystem()) =>
    datasetRename.plan(system.ctx, { ...ARGS, ...args });
  const describeRename = async (args: Record<string, unknown> = {}, system = renameSystem()) => {
    const steps = await plan(args, system);
    return steps[0]?.description as string;
  };
  const normalize = (args: Record<string, unknown>) => datasetRename.normalizeArgs?.({ ...ARGS, ...args });

  describe('arguments', () => {
    it('takes dataset and new_name only, and refuses recursive and force by name', () => {
      const schema = datasetRename.inputSchema['properties'] as Record<string, unknown>;
      expect(Object.keys(schema)).toEqual(['dataset', 'new_name']);
      expect(datasetRename.inputSchema['required']).toEqual(['dataset', 'new_name']);
      expect(() => normalize({ recursive: true })).toThrow('"recursive" is not accepted by this tool');
      expect(() => normalize({ force: false })).toThrow('"force" is not accepted by this tool');
      expect(normalize({})).toEqual({ dataset: 'tank/projects', new_name: 'tank/archive/projects' });
    });

    it('requires both names, written plainly', () => {
      expect(() => datasetRename.normalizeArgs?.({ new_name: 'tank/x' })).toThrow('"dataset" is required');
      expect(() => datasetRename.normalizeArgs?.({ dataset: 'tank/x' })).toThrow('"new_name" is required');
      expect(() => normalize({ dataset: 'tank//x' })).toThrow('"tank//x" is not a dataset name');
      for (const newName of ['tank', 'tank/x/', '/tank/x']) {
        expect(() => normalize({ new_name: newName })).toThrow(`"${newName}" is not a dataset name under a parent`);
      }
    });

    it("refuses a pool's root dataset", () => {
      expect(() => normalize({ dataset: 'tank', new_name: 'tank/x' })).toThrow(
        '"tank" is a pool\'s root dataset, whose name is the pool\'s own; this tool does not rename a pool',
      );
    });

    it('refuses a new name in another pool, naming both pools', () => {
      expect(() => normalize({ new_name: 'other/projects' })).toThrow(
        '"other/projects" is in pool "other" and "tank/projects" is in pool "tank"; a rename stays in its pool',
      );
    });

    it('refuses the current name, a name beneath the dataset, a bad character and a reserved name', () => {
      expect(() => normalize({ new_name: 'tank/projects' })).toThrow('"tank/projects" is already the dataset\'s name');
      expect(() => normalize({ new_name: 'tank/projects/inner' })).toThrow(
        '"tank/projects/inner" is beneath "tank/projects" itself',
      );
      expect(() => normalize({ new_name: 'tank/new@x' })).toThrow('"new@x" has a character ZFS does not accept');
      for (const leaf of ['.', '..']) {
        expect(() => normalize({ new_name: `tank/archive/${leaf}` })).toThrow(
          `"${leaf}" names a directory, not a dataset, and ZFS does not accept it as a dataset name`,
        );
      }
      for (const leaf of ['ix-applications', '.system']) {
        expect(() => normalize({ new_name: `tank/${leaf}` })).toThrow(`"${leaf}" is a name TrueNAS reserves`);
      }
      // A sibling whose name merely starts with the dataset's is not beneath it.
      expect(normalize({ new_name: 'tank/projects-old' })).toEqual({
        dataset: 'tank/projects',
        new_name: 'tank/projects-old',
      });
    });

    it('is a full-access, reversible mutation whose description says what renaming back does not undo', () => {
      expect(datasetRename.mutating).toBe(true);
      expect(datasetRename.destructiveness).toBe('reversible');
      expect(datasetRename.description).toContain('BUT NOT WHAT BROKE IN BETWEEN');
      expect(datasetRename.description).toContain('DOES NOT CLAIM THE SYSTEM WILL');
      expect(datasetRename.description).toContain(datasetRename.resultGuidance as string);
    });
  });

  describe('plan', () => {
    it('is the rename sending new_name alone, then the read of both names', async () => {
      const steps = await plan();
      expect(steps).toEqual([
        expect.objectContaining({
          method: 'pool.dataset.rename',
          params: ['tank/projects', { new_name: 'tank/archive/projects' }],
        }),
        expect.objectContaining({
          method: 'pool.dataset.query',
          params: [
            [['id', 'in', ['tank/projects', 'tank/archive/projects']]],
            { extra: { retrieve_children: false, properties: [] } },
          ],
        }),
      ]);
      expect(steps[1]?.description).toContain('Changes nothing.');
    });

    it('the steps are the calls execute makes', async () => {
      const [rename, read] = await plan();
      const { ctx, call, query } = renameSystem();
      await datasetRename.execute(ctx, ARGS);
      expect(call).toHaveBeenCalledWith('pool.dataset.rename', rename?.params);
      const [filters, options] = read?.params as unknown[];
      expect(query).toHaveBeenCalledWith('pool.dataset.query', filters, options);
      expect(call).toHaveBeenCalledTimes(1);
      expect(query).toHaveBeenCalledTimes(1);
    });

    it('fails naming a dataset the system does not list, compared on the id', async () => {
      await expect(plan({ dataset: 'tank/missing', new_name: 'tank/x' })).rejects.toThrow(
        'Dataset "tank/missing" does not exist on this system',
      );
    });

    it('refuses the system dataset, a dataset holding it and one inside it', async () => {
      const system = () =>
        renameSystem({
          datasets: [
            { id: 'tank/sys' },
            { id: 'tank/sys/.system' },
            { id: 'tank/sys/.system/cores' },
          ],
          calls: { 'systemdataset.config': { basename: 'tank/sys/.system' } },
        });
      await expect(plan({ dataset: 'tank/sys/.system', new_name: 'tank/x' }, system())).rejects.toThrow(
        '"tank/sys/.system" is the system dataset "tank/sys/.system"',
      );
      await expect(plan({ dataset: 'tank/sys', new_name: 'tank/x' }, system())).rejects.toThrow(
        '"tank/sys" holds the system dataset "tank/sys/.system"',
      );
      await expect(plan({ dataset: 'tank/sys/.system/cores', new_name: 'tank/x' }, system())).rejects.toThrow(
        '"tank/sys/.system/cores" is inside the system dataset "tank/sys/.system"',
      );
    });

    it('refuses where the system dataset could not be read', async () => {
      await expect(plan({}, renameSystem({ failures: { 'systemdataset.config': new Error('busy') } }))).rejects.toThrow(
        'Whether "tank/projects" is or holds the system dataset could not be read (systemdataset.config failed: busy)',
      );
      await expect(plan({}, renameSystem({ calls: { 'systemdataset.config': { pool: 'tank' } } }))).rejects.toThrow(
        '(systemdataset.config named no dataset), so nothing is planned',
      );
      await expect(plan({}, renameSystem({ calls: { 'systemdataset.config': null } }))).rejects.toThrow(
        'systemdataset.config named no dataset',
      );
    });

    it('refuses a new name that exists, or whose existence could not be read', async () => {
      await expect(plan({ new_name: 'tank/archive' })).rejects.toThrow(
        'Dataset "tank/archive" already exists on this system',
      );
      const failing = renameSystem({
        queryFailure: (filters) =>
          JSON.stringify(filters) === JSON.stringify([['id', '=', 'tank/archive/projects']])
            ? new Error('busy')
            : undefined,
      });
      await expect(plan({}, failing)).rejects.toThrow(
        'Whether dataset "tank/archive/projects" already exists could not be read (pool.dataset.query failed: busy)',
      );
    });

    it('refuses a new parent that does not exist, is a volume, or could not be read', async () => {
      await expect(plan({ new_name: 'tank/nowhere/projects' })).rejects.toThrow(
        'New parent dataset "tank/nowhere" does not exist on this system, and this tool does not create it',
      );
      const withVolume = renameSystem({
        datasets: [{ id: 'tank/projects' }, { id: 'tank/vol', type: 'VOLUME' }],
      });
      await expect(plan({ new_name: 'tank/vol/projects' }, withVolume)).rejects.toThrow(
        'New parent dataset "tank/vol" is a volume',
      );
      const failing = renameSystem({
        queryFailure: (filters) =>
          JSON.stringify(filters) === JSON.stringify([['id', '=', 'tank/archive']]) ? new Error('busy') : undefined,
      });
      await expect(plan({}, failing)).rejects.toThrow(
        'New parent dataset "tank/archive" could not be read (pool.dataset.query failed: busy)',
      );
    });

    it('reads the descendants through the walk, every dataset with no property', async () => {
      // The fake answers an empty filter with every dataset whatever the
      // options, so this assertion is what holds the walk on (#168).
      const { ctx, query } = renameSystem();
      await datasetRename.plan(ctx, ARGS);
      expect(query).toHaveBeenCalledWith('pool.dataset.query', [], {
        extra: { retrieve_children: true, properties: [] },
      });
    });

    it('names the descendants that move, with their new names', async () => {
      expect(await describeRename()).toContain(
        '2 descendants move with it: "tank/projects/a" becomes "tank/archive/projects/a"; ' +
          '"tank/projects/a/b" becomes "tank/archive/projects/a/b".',
      );
      const alone = renameSystem({ datasets: [{ id: 'tank/projects' }, { id: 'tank/projects-old' }, { id: 'tank/archive' }] });
      expect(await describeRename({}, alone)).toContain('No descendant of it was listed, so it moves alone.');
      const one = renameSystem({ datasets: [{ id: 'tank/projects' }, { id: 'tank/projects/a' }, { id: 'tank/archive' }] });
      expect(await describeRename({}, one)).toContain('1 descendant moves with it: "tank/projects/a" becomes');
    });

    it('counts a listed dataset whose id could not be read, and never says it moves alone beside one', async () => {
      const alone = renameSystem({ datasets: [{ id: 'tank/projects' }, { id: 'tank/archive' }, { id: 7 }, null as never] });
      const text = await describeRename({}, alone);
      expect(text).toContain(
        'No descendant of it was listed by name. 2 listed datasets could not be read by name, and any of them ' +
          'may move with it too.',
      );
      expect(text).not.toContain('moves alone');
      const some = renameSystem({ datasets: [{ id: 'tank/projects' }, { id: 'tank/projects/a' }, { id: 'tank/archive' }, { id: 7 }] });
      expect(await describeRename({}, some)).toContain(
        '"tank/projects/a" becomes "tank/archive/projects/a". 1 listed dataset could not be read by name',
      );
    });

    it('caps the descendants it names and counts the rest', async () => {
      const children = Array.from({ length: 53 }, (_, index) => ({ id: `tank/projects/c${String(index).padStart(2, '0')}` }));
      const many = renameSystem({ datasets: [{ id: 'tank/projects' }, { id: 'tank/archive' }, ...children] });
      const text = await describeRename({}, many);
      expect(text).toContain('53 descendants move with it: "tank/projects/c00" becomes');
      expect(text).toContain('"tank/projects/c49" becomes "tank/archive/projects/c49"; and 3 more, not named here');
      expect(text).not.toContain('"tank/projects/c50"');
    });

    it('says the descendants could not be read rather than that there are none', async () => {
      const failing = renameSystem({ queryFailure: (filters) => (filters.length === 0 ? new Error('busy') : undefined) });
      expect(await describeRename({}, failing)).toContain(
        'Its descendants could not be read (pool.dataset.query failed: busy), so which datasets move with it is ' +
          'not stated here; every one of them does.',
      );
    });

    it('lists every attachment by type and name, and does not say they will be updated', async () => {
      const { ctx, call } = renameSystem({
        calls: {
          'pool.dataset.attachments': [
            { type: 'SMB Share', service: 'cifs', attachments: ['projects', 'team'] },
            { type: 'Periodic Snapshot Task', service: null, attachments: ['tank/projects - auto-%Y'] },
            { type: 'Rsync Task', service: null, attachments: [] },
          ],
        },
      });
      const [step] = await datasetRename.plan(ctx, ARGS);
      expect(call).toHaveBeenCalledWith('pool.dataset.attachments', ['tank/projects']);
      const text = step?.description as string;
      expect(text).toContain(
        'The system reports these referring to "tank/projects": SMB Share (service cifs): "projects", "team"; ' +
          'Periodic Snapshot Task: "tank/projects - auto-%Y"; Rsync Task: no name listed.',
      );
      expect(text).toContain(
        'WHAT HAPPENS TO EACH OF THESE ON RENAME IS NOT ESTABLISHED HERE: this tool does not update them',
      );
      expect(text).not.toMatch(/will be updated/i);
    });

    it('names what it could not read in the attachments rather than dropping it', async () => {
      const text = await describeRename(
        {},
        renameSystem({
          calls: {
            'pool.dataset.attachments': [
              { type: 7, service: 'nfs', attachments: ['/mnt/tank/projects', 3] },
              'junk',
            ],
          },
        }),
      );
      expect(text).toContain(
        'an entry of a type that could not be read (service nfs): names that could not be read; ' +
          '1 entry that could not be read.',
      );
    });

    it('says what refers to the dataset could not be established where that read fails, and still plans', async () => {
      const failing = await plan({}, renameSystem({ failures: { 'pool.dataset.attachments': new Error('busy') } }));
      expect(failing).toHaveLength(2);
      expect(failing[0]?.description).toContain(
        'WHAT REFERS TO "tank/projects" COULD NOT BE ESTABLISHED (pool.dataset.attachments failed: busy)',
      );
      expect(await describeRename({}, renameSystem({ calls: { 'pool.dataset.attachments': {} } }))).toContain(
        'WHAT REFERS TO "tank/projects" COULD NOT BE ESTABLISHED (pool.dataset.attachments did not answer with a list)',
      );
      expect(await describeRename()).toContain(
        'The system reports nothing referring to "tank/projects" (pool.dataset.attachments listed none)',
      );
    });
  });

  describe('execute', () => {
    it('reports renamed from the read after the call, not from the call returning', async () => {
      const { ctx, query } = renameSystem();
      // The rename has happened by the time the read runs.
      query.mockImplementationOnce(() => of([{ id: 'tank/archive/projects' }, { id: 'tank/other' }]));
      expect(await datasetRename.execute(ctx, ARGS)).toEqual({
        dataset: 'tank/projects',
        new_name: 'tank/archive/projects',
        lookup: 'READ',
        read_error: null,
        old_name_listed: false,
        new_name_listed: true,
        renamed: true,
      });
    });

    it('reports renamed false where the read still lists the old name', async () => {
      const result = await datasetRename.execute(renameSystem().ctx, ARGS);
      expect(result).toMatchObject({ old_name_listed: true, new_name_listed: false, renamed: false });
    });

    it('does not fail where the read after the call fails, and reports renamed as null', async () => {
      const failing = renameSystem({ queryFailure: () => new Error('busy') });
      expect(await datasetRename.execute(failing.ctx, ARGS)).toEqual({
        dataset: 'tank/projects',
        new_name: 'tank/archive/projects',
        lookup: 'UNREADABLE',
        read_error: 'busy',
        old_name_listed: null,
        new_name_listed: null,
        renamed: null,
      });
    });

    it('passes a rejected rename through, naming the dataset', async () => {
      const failing = renameSystem({ failures: { 'pool.dataset.rename': new Error('[EBUSY] dataset is busy') } });
      await expect(datasetRename.execute(failing.ctx, ARGS)).rejects.toThrow(
        'Renaming dataset "tank/projects" to "tank/archive/projects" failed: [EBUSY] dataset is busy',
      );
    });
  });
});
