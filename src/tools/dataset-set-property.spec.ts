import { describe, expect, it } from 'vitest';
import { failingSystem, fakeSystem } from '@/testing/fake-systems';
import { PlanStep } from '@/catalog/tool';
import { datasetSetProperty } from '@/tools/storage';

describe('dataset_set_property', () => {
  /** One `pool.dataset.query` row carrying the properties the tests read. */
  const logs = (over: Record<string, unknown> = {}) => ({
    id: 'tank/logs',
    pool: 'tank',
    type: 'FILESYSTEM',
    compression: { value: 'lz4', source: 'INHERITED' },
    recordsize: { value: '128K', source: 'DEFAULT' },
    readonly: { value: 'off', source: 'DEFAULT' },
    atime: { value: 'on', source: 'LOCAL' },
    ...over,
  });
  const CHOICES = ['512', '4K', '128K', '1M'];
  const system = (over: Record<string, unknown> = {}) =>
    fakeSystem({
      'pool.dataset.query': [logs()],
      'pool.dataset.update': logs(),
      'pool.dataset.recordsize_choices': CHOICES,
      ...over,
    });
  const plan = (args: Record<string, unknown>, over: Record<string, unknown> = {}) =>
    datasetSetProperty.plan(system(over).ctx, { dataset: 'tank/logs', ...args });
  const describeUpdate = async (args: Record<string, unknown>, over: Record<string, unknown> = {}) => {
    const steps = await plan(args, over);
    expect(steps).toHaveLength(2);
    return (steps[1] as PlanStep).description;
  };

  describe('arguments', () => {
    it('takes exactly the six settable properties, and names the excluded ones when refusing another', () => {
      const schema = datasetSetProperty.inputSchema['properties'] as Record<string, Record<string, unknown>>;
      expect(schema['property']?.['enum']).toEqual(['compression', 'atime', 'recordsize', 'snapdir', 'exec', 'readonly']);
      expect(datasetSetProperty.inputSchema['required']).toEqual(['dataset', 'property', 'value']);
      for (const excluded of ['sync', 'deduplication', 'checksum', 'copies', 'acltype', 'aclmode']) {
        expect(() =>
          datasetSetProperty.normalizeArgs?.({ dataset: 'tank/logs', property: excluded, value: 'OFF' }),
        ).toThrow(
          '"property" must be one of compression, atime, recordsize, snapdir, exec, readonly; sync, deduplication, ' +
            'checksum, copies, acltype and aclmode are deliberately not set by this tool',
        );
        expect(datasetSetProperty.description).toContain(`\`${excluded}\``);
      }
    });

    it('refuses a value outside the property\'s declared union, naming the accepted values', () => {
      expect(() =>
        datasetSetProperty.normalizeArgs?.({ dataset: 'tank/logs', property: 'atime', value: 'on' }),
      ).toThrow('"on" is not a value of `atime`; it accepts ON, OFF, INHERIT');
      expect(() =>
        datasetSetProperty.normalizeArgs?.({ dataset: 'tank/logs', property: 'snapdir', value: 'ON' }),
      ).toThrow('it accepts DISABLED, VISIBLE, HIDDEN, INHERIT');
      // A prototype key is not a declared value.
      expect(() =>
        datasetSetProperty.normalizeArgs?.({ dataset: 'tank/logs', property: 'exec', value: 'constructor' }),
      ).toThrow('"constructor" is not a value of `exec`');
      expect(
        datasetSetProperty.normalizeArgs?.({ dataset: 'tank/logs', property: 'compression', value: 'ZSTD-FAST-1000' }),
      ).toEqual({ dataset: 'tank/logs', property: 'compression', value: 'ZSTD-FAST-1000' });
    });

    it('accepts INHERIT on every property but recordsize, which is override-only', () => {
      for (const property of ['compression', 'atime', 'snapdir', 'exec', 'readonly']) {
        expect(datasetSetProperty.normalizeArgs?.({ dataset: 'tank/logs', property, value: 'INHERIT' })).toEqual({
          dataset: 'tank/logs',
          property,
          value: 'INHERIT',
        });
      }
      expect(() =>
        datasetSetProperty.normalizeArgs?.({ dataset: 'tank/logs', property: 'recordsize', value: 'INHERIT' }),
      ).toThrow('`recordsize` is override-only here');
    });

    it('requires a dataset and a value', () => {
      expect(() => datasetSetProperty.normalizeArgs?.({ property: 'atime', value: 'ON' })).toThrow(/"dataset" is required/);
      expect(() => datasetSetProperty.normalizeArgs?.({ dataset: 'tank/logs', property: 'atime' })).toThrow(
        '"value" is required',
      );
      expect(() => datasetSetProperty.normalizeArgs?.({ dataset: 'tank/logs', property: 'atime', value: '' })).toThrow(
        '"value" is required',
      );
    });

    it('is a full-access, reversible mutation', () => {
      expect(datasetSetProperty.mutating).toBe(true);
      expect(datasetSetProperty.destructiveness).toBe('reversible');
      expect(datasetSetProperty.description).toContain(datasetSetProperty.resultGuidance as string);
    });
  });

  describe('plan', () => {
    it('names the read execute makes, then the update with only the one property', async () => {
      const [read, update] = await plan({ property: 'compression', value: 'ZSTD' });
      expect(read).toMatchObject({
        method: 'pool.dataset.query',
        params: [[['id', '=', 'tank/logs']], { extra: { retrieve_children: false, properties: ['compression'] } }],
      });
      expect(read?.description).toContain('Changes nothing.');
      expect(update).toMatchObject({ method: 'pool.dataset.update', params: ['tank/logs', { compression: 'ZSTD' }] });
    });

    it('the read step is the call execute makes', async () => {
      const [read] = await plan({ property: 'readonly', value: 'ON' });
      const { ctx, query } = system();
      await datasetSetProperty.execute(ctx, { dataset: 'tank/logs', property: 'readonly', value: 'ON' });
      const params = read?.params as unknown[];
      expect(query).toHaveBeenCalledWith('pool.dataset.query', ...params);
    });

    it('fails naming a dataset the response does not list, compared on the id', async () => {
      const other = system({ 'pool.dataset.query': [logs({ id: 'tank/other' }), 'junk'] });
      await expect(
        datasetSetProperty.plan(other.ctx, { dataset: 'tank/logs', property: 'atime', value: 'OFF' }),
      ).rejects.toThrow('Dataset "tank/logs" does not exist on this system');
      const failing = failingSystem({}, { 'pool.dataset.query': new Error('busy') });
      await expect(
        datasetSetProperty.plan(failing.ctx, { dataset: 'tank/logs', property: 'atime', value: 'OFF' }),
      ).rejects.toThrow('Dataset "tank/logs" could not be read (pool.dataset.query failed: busy), so nothing is planned');
    });

    it('states the current value and source and the value requested', async () => {
      const text = await describeUpdate({ property: 'compression', value: 'ZSTD' });
      expect(text).toContain('Set `compression` on dataset "tank/logs". Now: lz4 (source INHERITED). Will be: ZSTD.');
      const unread = await describeUpdate(
        { property: 'compression', value: 'ZSTD' },
        { 'pool.dataset.query': [logs({ compression: 'x' })] },
      );
      expect(unread).toContain('Now: a value that could not be read (a source that could not be read).');
    });

    it('says what INHERIT resolves to without claiming to have read it', async () => {
      const text = await describeUpdate({ property: 'atime', value: 'INHERIT' });
      expect(text).toContain(
        "Will be: INHERIT: clear this dataset's own setting, so the value comes from its nearest ancestor that " +
          "sets one, or from ZFS's default, which this plan does not read.",
      );
    });

    it('says existing data is not rewritten for compression and recordsize only', async () => {
      expect(await describeUpdate({ property: 'compression', value: 'ZSTD' })).toContain(
        'EXISTING DATA IS NOT REWRITTEN: only blocks written after the change use the new `compression`',
      );
      expect(await describeUpdate({ property: 'recordsize', value: '1M' })).toContain(
        'EXISTING DATA IS NOT REWRITTEN: only blocks written after the change use the new `recordsize`',
      );
      expect(await describeUpdate({ property: 'atime', value: 'OFF' })).not.toContain('REWRITTEN');
    });

    it('says readonly ON makes writes fail, and that INHERIT may', async () => {
      expect(await describeUpdate({ property: 'readonly', value: 'ON' })).toContain(
        'WRITES TO THE DATASET WILL FAIL once this is applied — every application, share and client writing to ' +
          'it gets an error — until `readonly` is set back.',
      );
      expect(await describeUpdate({ property: 'readonly', value: 'INHERIT' })).toContain(
        "If the parent is read-only, WRITES TO THE DATASET WILL FAIL once this is applied; the parent's value is " +
          'not read here.',
      );
      expect(await describeUpdate({ property: 'readonly', value: 'OFF' })).not.toContain('WILL FAIL');
    });

    it('says a value already held locally, or an inheritance already in place, changes nothing', async () => {
      expect(await describeUpdate({ property: 'atime', value: 'ON' })).toContain(
        'It is already set to that on this dataset, so this changes nothing and is not an error.',
      );
      // The same value inherited is not the same state: setting it makes it local.
      expect(await describeUpdate({ property: 'compression', value: 'LZ4' })).not.toContain('changes nothing');
      expect(await describeUpdate({ property: 'compression', value: 'INHERIT' })).toContain(
        'It already inherits, so this changes nothing and is not an error.',
      );
      expect(await describeUpdate({ property: 'readonly', value: 'INHERIT' })).toContain('It already inherits');
      expect(await describeUpdate({ property: 'atime', value: 'INHERIT' })).not.toContain('changes nothing');
    });

    it('refuses a filesystem property on a volume, and states rather than refuses an unread type', async () => {
      const volume = { 'pool.dataset.query': [logs({ type: 'VOLUME' })] };
      for (const [property, value] of [['atime', 'OFF'], ['snapdir', 'HIDDEN'], ['exec', 'OFF']]) {
        await expect(plan({ property, value }, volume)).rejects.toThrow(
          `Dataset "tank/logs" is a volume, and \`${property}\` is a filesystem property that ZFS does not set on one`,
        );
      }
      await expect(plan({ property: 'recordsize', value: '1M' }, volume)).rejects.toThrow('is a volume');
      // compression and readonly are set on a volume as on a filesystem.
      expect(await describeUpdate({ property: 'compression', value: 'ZSTD' }, volume)).not.toContain('volume');
      const unread = await describeUpdate({ property: 'atime', value: 'OFF' }, { 'pool.dataset.query': [logs({ type: 7 })] });
      expect(unread).toContain(
        'Whether this dataset is a filesystem could not be read; ZFS does not set `atime` on a volume, so the ' +
          'call may be rejected.',
      );
      expect(await describeUpdate({ property: 'readonly', value: 'ON' }, { 'pool.dataset.query': [logs({ type: 7 })] }))
        .not.toContain('is a filesystem');
    });

    it('checks a recordsize against the system\'s own choices for the dataset\'s pool', async () => {
      const { ctx, call } = system();
      await datasetSetProperty.plan(ctx, { dataset: 'tank/logs', property: 'recordsize', value: '1M' });
      expect(call).toHaveBeenCalledWith('pool.dataset.recordsize_choices', ['tank']);
      await expect(plan({ property: 'recordsize', value: '3K' })).rejects.toThrow(
        '"3K" is not a record size this system accepts for dataset "tank/logs"; it accepts 512, 4K, 128K, 1M',
      );
      await expect(
        plan({ property: 'recordsize', value: '1M' }, { 'pool.dataset.recordsize_choices': [] }),
      ).rejects.toThrow('it accepts none it listed');
      // No pool on the row asks for the system-wide list.
      const noPool = system({ 'pool.dataset.query': [logs({ pool: undefined })] });
      await datasetSetProperty.plan(noPool.ctx, { dataset: 'tank/logs', property: 'recordsize', value: '1M' });
      expect(noPool.call).toHaveBeenCalledWith('pool.dataset.recordsize_choices', []);
    });

    it('refuses a recordsize it could not check', async () => {
      await expect(
        plan({ property: 'recordsize', value: '1M' }, { 'pool.dataset.recordsize_choices': 'nope' }),
      ).rejects.toThrow(
        'The record sizes this system accepts could not be read (pool.dataset.recordsize_choices answered with ' +
          'something that is not a list), so "1M" was not checked and nothing is planned',
      );
      const failing = failingSystem(
        { 'pool.dataset.query': [logs()] },
        { 'pool.dataset.recordsize_choices': new Error('busy') },
      );
      await expect(
        datasetSetProperty.plan(failing.ctx, { dataset: 'tank/logs', property: 'recordsize', value: '1M' }),
      ).rejects.toThrow('(pool.dataset.recordsize_choices failed: busy), so "1M" was not checked');
    });

    it('does not read the record size choices for any other property', async () => {
      const { ctx, call } = system();
      await datasetSetProperty.plan(ctx, { dataset: 'tank/logs', property: 'compression', value: 'ZSTD' });
      expect(call).not.toHaveBeenCalled();
    });
  });

  describe('execute', () => {
    it('sends what was planned and reports value and source before and after, read from rows', async () => {
      const { ctx, call } = system({ 'pool.dataset.update': logs({ compression: { value: 'zstd', source: 'LOCAL' } }) });
      const result = await datasetSetProperty.execute(ctx, { dataset: 'tank/logs', property: 'compression', value: 'ZSTD' });
      expect(call).toHaveBeenCalledWith('pool.dataset.update', ['tank/logs', { compression: 'ZSTD' }]);
      expect(result).toEqual({
        dataset: 'tank/logs',
        property: 'compression',
        requested: 'ZSTD',
        lookup: 'FOUND',
        lookup_error: null,
        previous_value: 'lz4',
        previous_source: 'INHERITED',
        resulting_value: 'zstd',
        resulting_source: 'LOCAL',
        changed: true,
        confirmed: true,
      });
    });

    it('confirms INHERIT on an inherited or default source, and refuses to on a local one', async () => {
      for (const source of ['INHERITED', 'DEFAULT', 'inherited']) {
        const { ctx } = system({ 'pool.dataset.update': logs({ atime: { value: 'on', source } }) });
        expect(
          await datasetSetProperty.execute(ctx, { dataset: 'tank/logs', property: 'atime', value: 'INHERIT' }),
        ).toMatchObject({ confirmed: true, changed: true });
      }
      const local = system();
      expect(
        await datasetSetProperty.execute(local.ctx, { dataset: 'tank/logs', property: 'atime', value: 'INHERIT' }),
      ).toMatchObject({ resulting_source: 'LOCAL', changed: false, confirmed: false });
      const received = system({ 'pool.dataset.update': logs({ atime: { value: 'on', source: 'RECEIVED' } }) });
      expect(
        await datasetSetProperty.execute(received.ctx, { dataset: 'tank/logs', property: 'atime', value: 'INHERIT' }),
      ).toMatchObject({ confirmed: null });
    });

    it('is not a success where the value or source came back as something else', async () => {
      const otherValue = system({ 'pool.dataset.update': logs({ compression: { value: 'gzip', source: 'LOCAL' } }) });
      expect(
        await datasetSetProperty.execute(otherValue.ctx, { dataset: 'tank/logs', property: 'compression', value: 'ZSTD' }),
      ).toMatchObject({ confirmed: false });
      // The value asked for, still inherited, is not a value set on this dataset.
      const inherited = system();
      expect(
        await datasetSetProperty.execute(inherited.ctx, { dataset: 'tank/logs', property: 'compression', value: 'LZ4' }),
      ).toMatchObject({ resulting_value: 'lz4', changed: false, confirmed: false });
    });

    it('leaves changed and confirmed unestablished where a reading is missing', async () => {
      const noSource = system({ 'pool.dataset.update': logs({ compression: { value: 'zstd' } }) });
      expect(
        await datasetSetProperty.execute(noSource.ctx, { dataset: 'tank/logs', property: 'compression', value: 'ZSTD' }),
      ).toMatchObject({ resulting_source: null, changed: null, confirmed: null });
      const noValue = system({ 'pool.dataset.update': logs({ compression: { source: 'LOCAL' } }) });
      expect(
        await datasetSetProperty.execute(noValue.ctx, { dataset: 'tank/logs', property: 'compression', value: 'ZSTD' }),
      ).toMatchObject({ resulting_value: null, changed: null, confirmed: null });
      const noInheritSource = system({ 'pool.dataset.update': logs({ atime: { value: 'on' } }) });
      expect(
        await datasetSetProperty.execute(noInheritSource.ctx, { dataset: 'tank/logs', property: 'atime', value: 'INHERIT' }),
      ).toMatchObject({ confirmed: null });
      const notRecord = system({ 'pool.dataset.update': true });
      expect(
        await datasetSetProperty.execute(notRecord.ctx, { dataset: 'tank/logs', property: 'atime', value: 'OFF' }),
      ).toMatchObject({ resulting_value: null, resulting_source: null, changed: null, confirmed: null });
    });

    it('makes the call whatever the read before it found', async () => {
      const missing = system({ 'pool.dataset.query': [logs({ id: 'tank/other' })] });
      expect(
        await datasetSetProperty.execute(missing.ctx, { dataset: 'tank/logs', property: 'atime', value: 'OFF' }),
      ).toMatchObject({ lookup: 'NOT_FOUND', previous_value: null, previous_source: null, changed: null });
      expect(missing.call).toHaveBeenCalledWith('pool.dataset.update', ['tank/logs', { atime: 'OFF' }]);
      const failing = failingSystem(
        { 'pool.dataset.update': logs({ atime: { value: 'off', source: 'LOCAL' } }) },
        { 'pool.dataset.query': new Error('busy') },
      );
      expect(
        await datasetSetProperty.execute(failing.ctx, { dataset: 'tank/logs', property: 'atime', value: 'OFF' }),
      ).toMatchObject({ lookup: 'UNREADABLE', lookup_error: 'busy', confirmed: true, changed: null });
    });
  });
});
