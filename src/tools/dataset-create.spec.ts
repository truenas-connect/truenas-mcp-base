import { describe, expect, it } from 'vitest';
import { of, throwError } from 'rxjs';
import { failingSystem, fakeSystem } from '@/testing/fake-systems';
import { datasetCreate, listDatasets } from '@/tools/storage';

describe('dataset_create', () => {
  /** The parent row, as `pool.dataset.query` answers for it. */
  const projects = (over: Record<string, unknown> = {}) => ({
    id: 'tank/projects',
    pool: 'tank',
    type: 'FILESYSTEM',
    encrypted: false,
    encryption_root: null,
    locked: false,
    ...over,
  });
  /** The entry the create answers with. */
  const created = {
    id: 'tank/projects/new',
    pool: 'tank',
    type: 'FILESYSTEM',
    mountpoint: '/mnt/tank/projects/new',
    used: { parsed: 98304 },
    available: { parsed: 1000000 },
    encryption_root: null,
    user_properties: { secret: 'not reported' },
  };
  const CHOICES = ['512', '4K', '128K', '1M'];
  const system = (over: Record<string, unknown> = {}) =>
    fakeSystem({
      'pool.dataset.query': [projects()],
      'pool.dataset.create': created,
      'pool.dataset.recordsize_choices': CHOICES,
      ...over,
    });
  const plan = (args: Record<string, unknown> = {}, over: Record<string, unknown> = {}) =>
    datasetCreate.plan(system(over).ctx, { name: 'tank/projects/new', ...args });
  const describeCreate = async (args: Record<string, unknown> = {}, over: Record<string, unknown> = {}) => {
    const steps = await plan(args, over);
    expect(steps).toHaveLength(1);
    return steps[0]?.description as string;
  };
  const normalize = (args: Record<string, unknown>) =>
    datasetCreate.normalizeArgs?.({ name: 'tank/projects/new', ...args });

  describe('arguments', () => {
    it('has no volume, encryption or ancestor arguments in its schema, and refuses each by name', () => {
      const schema = datasetCreate.inputSchema['properties'] as Record<string, unknown>;
      expect(Object.keys(schema)).toEqual([
        'name',
        'comments',
        'compression',
        'atime',
        'recordsize',
        'quota_bytes',
        'refquota_bytes',
        'share_type',
      ]);
      expect(datasetCreate.inputSchema['required']).toEqual(['name']);
      for (const key of ['type', 'volsize', 'encryption', 'encryption_options', 'inherit_encryption', 'create_ancestors']) {
        expect(() => normalize({ [key]: true })).toThrow(`"${key}" is not accepted by this tool`);
      }
      expect(() => normalize({ encryption_options: { passphrase: 'x' } })).toThrow('a secret argument');
    });

    it('requires a name under a parent, with no empty part', () => {
      expect(() => datasetCreate.normalizeArgs?.({})).toThrow('"name" is required');
      for (const name of ['tank', '/tank/new', 'tank/new/', 'tank//new']) {
        expect(() => datasetCreate.normalizeArgs?.({ name })).toThrow(`"${name}" is not a dataset name under a parent`);
      }
    });

    it('refuses a character outside the ZFS set, naming the set', () => {
      for (const leaf of ['new@snap', 'new#1', 'naïve', 'a*b']) {
        expect(() => datasetCreate.normalizeArgs?.({ name: `tank/${leaf}` })).toThrow(
          `"${leaf}" has a character ZFS does not accept in a dataset name; it accepts letters, digits, "_", "-", ` +
            '".", ":" and space',
        );
      }
      expect(normalize({})).toEqual({ name: 'tank/projects/new' });
      expect(datasetCreate.normalizeArgs?.({ name: 'tank/My Data_1.v2:x-y' })).toEqual({ name: 'tank/My Data_1.v2:x-y' });
    });

    it('refuses the two names TrueNAS reserves', () => {
      for (const leaf of ['ix-applications', '.system']) {
        expect(() => datasetCreate.normalizeArgs?.({ name: `tank/${leaf}` })).toThrow(
          `"${leaf}" is a name TrueNAS reserves for its own datasets`,
        );
      }
    });

    it('checks compression and atime against the declared values', () => {
      expect(() => normalize({ compression: 'lz4' })).toThrow('"lz4" is not a value of `compression`');
      expect(() => normalize({ atime: 'YES' })).toThrow('"YES" is not a value of `atime`; it accepts ON, OFF, INHERIT');
      expect(() => normalize({ atime: 'constructor' })).toThrow('"constructor" is not a value of `atime`');
      expect(normalize({ compression: 'ZSTD', atime: 'OFF' })).toEqual({
        name: 'tank/projects/new',
        compression: 'ZSTD',
        atime: 'OFF',
      });
    });

    it('takes limits as whole bytes and the three share types only', () => {
      for (const bad of [-1, 1.5, '10']) {
        expect(() => normalize({ quota_bytes: bad })).toThrow('"quota_bytes" must be a whole number of bytes');
      }
      expect(() => normalize({ refquota_bytes: null })).toThrow('"refquota_bytes" must be a whole number of bytes');
      for (const shareType of ['MULTIPROTOCOL', 'APPS', 'smb']) {
        expect(() => normalize({ share_type: shareType })).toThrow(
          '"share_type" must be one of GENERIC, SMB, NFS; MULTIPROTOCOL and APPS are not sent by this tool',
        );
      }
      expect(() => normalize({ comments: 3 })).toThrow('"comments" must be text');
      expect(() => normalize({ recordsize: '' })).toThrow('"recordsize" must be a size');
      expect(normalize({ quota_bytes: 0, refquota_bytes: 1024, share_type: 'SMB', comments: '', recordsize: '1M' })).toEqual({
        name: 'tank/projects/new',
        comments: '',
        recordsize: '1M',
        quota_bytes: 0,
        refquota_bytes: 1024,
        share_type: 'SMB',
      });
    });

    it('is a full-access, reversible mutation whose description says nothing deletes a dataset', () => {
      expect(datasetCreate.mutating).toBe(true);
      expect(datasetCreate.destructiveness).toBe('reversible');
      expect(datasetCreate.description).toContain('NO TOOL IN THIS CATALOG DELETES A DATASET');
      expect(datasetCreate.description).toContain(datasetCreate.resultGuidance as string);
    });
  });

  describe('plan', () => {
    it('is one create step sending type FILESYSTEM and only what was passed', async () => {
      const steps = await plan({ compression: 'LZ4', quota_bytes: 2048, share_type: 'NFS' });
      expect(steps).toEqual([
        expect.objectContaining({
          method: 'pool.dataset.create',
          params: [{ name: 'tank/projects/new', type: 'FILESYSTEM', compression: 'LZ4', quota: 2048, share_type: 'NFS' }],
        }),
      ]);
      const [bare] = await plan();
      expect(bare?.params).toEqual([{ name: 'tank/projects/new', type: 'FILESYSTEM' }]);
    });

    it('the step is the call execute makes', async () => {
      const args = { name: 'tank/projects/new', atime: 'OFF', refquota_bytes: 0 };
      const [step] = await datasetCreate.plan(system().ctx, args);
      const { ctx, call } = system();
      await datasetCreate.execute(ctx, args);
      expect(call).toHaveBeenCalledWith('pool.dataset.create', step?.params);
    });

    it('reads the parent by id with the encryption properties, and the name with none', async () => {
      const { ctx, query } = system();
      await datasetCreate.plan(ctx, { name: 'tank/projects/new' });
      expect(query).toHaveBeenNthCalledWith(1, 'pool.dataset.query', [['id', '=', 'tank/projects']], {
        extra: { retrieve_children: false, properties: ['encryption', 'encryptionroot', 'keystatus'] },
      });
      expect(query).toHaveBeenNthCalledWith(2, 'pool.dataset.query', [['id', '=', 'tank/projects/new']], {
        extra: { retrieve_children: false, properties: [] },
      });
    });

    it('fails naming a parent the response does not list, compared on the id', async () => {
      await expect(plan({}, { 'pool.dataset.query': [projects({ id: 'tank/other' }), 'junk'] })).rejects.toThrow(
        'Parent dataset "tank/projects" does not exist on this system, and this tool does not create it',
      );
      const failing = failingSystem({}, { 'pool.dataset.query': new Error('busy') });
      await expect(datasetCreate.plan(failing.ctx, { name: 'tank/projects/new' })).rejects.toThrow(
        'Parent dataset "tank/projects" could not be read (pool.dataset.query failed: busy), so nothing is planned',
      );
    });

    it('fails where the name already exists, or where that could not be read', async () => {
      await expect(plan({}, { 'pool.dataset.query': [projects(), { id: 'tank/projects/new' }] })).rejects.toThrow(
        'Dataset "tank/projects/new" already exists on this system',
      );
      const { ctx, query } = system();
      query
        .mockImplementationOnce(() => of([projects()]))
        .mockImplementationOnce(() => throwError(() => new Error('busy')));
      await expect(datasetCreate.plan(ctx, { name: 'tank/projects/new' })).rejects.toThrow(
        'Whether dataset "tank/projects/new" already exists could not be read (pool.dataset.query failed: busy)',
      );
    });

    it('refuses a volume as the parent, and states an unreadable parent type', async () => {
      await expect(plan({}, { 'pool.dataset.query': [projects({ type: 'VOLUME' })] })).rejects.toThrow(
        'Parent dataset "tank/projects" is a volume, and ZFS does not create a dataset under one',
      );
      expect(await describeCreate({}, { 'pool.dataset.query': [projects({ type: 7 })] })).toContain(
        'Whether "tank/projects" is a filesystem could not be read; ZFS does not create a dataset under a volume, ' +
          'so the call may be rejected.',
      );
    });

    it('states whether the new dataset will be encrypted, and under which root', async () => {
      expect(await describeCreate()).toContain(
        'It will NOT be encrypted: encryption is inherited from the parent, and "tank/projects" is not encrypted.',
      );
      const encrypted = await describeCreate(
        {},
        { 'pool.dataset.query': [projects({ encrypted: true, encryption_root: 'tank/secure' })] },
      );
      expect(encrypted).toContain(
        'It WILL BE ENCRYPTED, inheriting the encryption of "tank/projects" under encryption root "tank/secure".',
      );
      expect(encrypted).not.toContain('LOCKED');
      const locked = await describeCreate(
        {},
        { 'pool.dataset.query': [projects({ encrypted: true, encryption_root: null, locked: true })] },
      );
      expect(locked).toContain('under an encryption root that could not be read.');
      expect(locked).toContain(
        '"tank/projects" IS LOCKED. Whether a dataset can be created under a locked encryption root is ' +
          '(unconfirmed), so the call may be rejected.',
      );
      expect(
        await describeCreate({}, { 'pool.dataset.query': [projects({ encrypted: true, locked: 'no' })] }),
      ).toContain('Whether "tank/projects" is locked could not be read.');
      expect(await describeCreate({}, { 'pool.dataset.query': [projects({ encrypted: 'yes' })] })).toContain(
        'Whether "tank/projects" is encrypted could not be read, so whether the new dataset will be is not stated',
      );
    });

    it('states the share_type requested, or that none is sent', async () => {
      expect(await describeCreate()).toContain(
        'No `share_type` is sent; the default is understood to be GENERIC (unconfirmed).',
      );
      expect(await describeCreate({ share_type: 'GENERIC' })).toContain(
        '`share_type` GENERIC is sent, which is understood to be the default (unconfirmed).',
      );
      expect(await describeCreate({ share_type: 'SMB' })).toContain(
        "`share_type` SMB is sent. It is understood to set the dataset's ACL type and mode for SMB",
      );
      expect(await describeCreate({ share_type: 'NFS' })).toContain(
        '`share_type` NFS is sent. What it changes is not stated by the API (unconfirmed).',
      );
    });

    it('names every setting it sends, and says the rest are inherited', async () => {
      expect(await describeCreate()).toContain(
        "No property is set, so every property is inherited from the parent or is ZFS's default.",
      );
      const text = await describeCreate({
        comments: 'Q3 "launch"',
        compression: 'ZSTD',
        atime: 'OFF',
        recordsize: '1M',
        quota_bytes: 1073741824,
        refquota_bytes: 0,
      });
      expect(text).toContain(
        'Set on it: `comments` "Q3 \\"launch\\""; `compression` ZSTD; `atime` OFF; `recordsize` 1M; ' +
          '`quota` 1073741824 bytes (1 GiB); `refquota` no limit (sent as 0). Every other property is inherited ' +
          "from the parent or is ZFS's default.",
      );
      expect(text).toContain('The parent and the name were read when this plan was made and are not read again.');
    });

    it("checks a recordsize against the parent pool's own choices", async () => {
      const { ctx, call } = system();
      await datasetCreate.plan(ctx, { name: 'tank/projects/new', recordsize: '128K' });
      expect(call).toHaveBeenCalledWith('pool.dataset.recordsize_choices', ['tank']);
      await expect(plan({ recordsize: '3K' })).rejects.toThrow(
        '"3K" is not a record size this system accepts for dataset "tank/projects/new"; it accepts 512, 4K, 128K, 1M',
      );
      const failing = failingSystem(
        { 'pool.dataset.query': [projects()] },
        { 'pool.dataset.recordsize_choices': new Error('busy') },
      );
      await expect(datasetCreate.plan(failing.ctx, { name: 'tank/projects/new', recordsize: '1M' })).rejects.toThrow(
        'The record sizes this system accepts could not be read (pool.dataset.recordsize_choices failed: busy)',
      );
    });
  });

  describe('execute', () => {
    it('reports the created dataset through the listing fields, read off the response', async () => {
      const result = await datasetCreate.execute(system().ctx, { name: 'tank/projects/new', quota_bytes: 0 });
      expect(result).toEqual({
        name: 'tank/projects/new',
        requested: { name: 'tank/projects/new', quota_bytes: 0 },
        created: {
          id: 'tank/projects/new',
          pool: 'tank',
          type: 'FILESYSTEM',
          mountpoint: '/mnt/tank/projects/new',
          used: 98304,
          available: 1000000,
        },
      });
    });

    it("reports exactly storage_list_datasets' fields", async () => {
      const listed = (await listDatasets.handler(system({ 'pool.dataset.query': [created] }).ctx, {})) as Record<
        string,
        unknown
      >[];
      const result = (await datasetCreate.execute(system().ctx, { name: 'tank/projects/new' })) as {
        created: Record<string, unknown>;
      };
      expect(Object.keys(result.created)).toEqual(Object.keys(listed[0] as Record<string, unknown>));
      expect(result.created).toEqual(listed[0]);
    });

    it('reports a field the response did not carry as null, and a response that is not a dataset as null', async () => {
      const sparse = (await datasetCreate.execute(system({ 'pool.dataset.create': { id: 'tank/projects/new' } }).ctx, {
        name: 'tank/projects/new',
      })) as { created: Record<string, unknown> };
      expect(sparse.created).toEqual({
        id: 'tank/projects/new',
        pool: null,
        type: null,
        mountpoint: null,
        used: null,
        available: null,
      });
      const empty = (await datasetCreate.execute(system({ 'pool.dataset.create': {} }).ctx, {
        name: 'tank/projects/new',
      })) as { created: Record<string, unknown> };
      expect(empty.created['id']).toBeNull();
      const none = (await datasetCreate.execute(system({ 'pool.dataset.create': true }).ctx, {
        name: 'tank/projects/new',
      })) as { created: unknown };
      expect(none.created).toBeNull();
    });

    it('lets a rejected create fail the call', async () => {
      const failing = failingSystem({}, { 'pool.dataset.create': new Error('[EEXIST] exists') });
      await expect(datasetCreate.execute(failing.ctx, { name: 'tank/projects/new' })).rejects.toThrow('[EEXIST] exists');
    });
  });
});
