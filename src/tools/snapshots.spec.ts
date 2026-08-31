import { describe, expect, it } from 'vitest';
import { fakeSystem } from '@/testing/fake-systems';
import { createSnapshot, snapshotsList } from '@/tools/index';

describe('snapshots_list', () => {
  /**
   * A snapshot row as `pool.snapshot.query` reports one. `id`, `pool`,
   * `snapshot_name`, `type` and `createtxg` are here to be dropped: they are
   * fields of the real payload the tool does not name.
   */
  const snapshot = (over: Record<string, unknown> = {}) => ({
    id: 'tank/media@nightly-1',
    name: 'tank/media@nightly-1',
    dataset: 'tank/media',
    pool: 'tank',
    snapshot_name: 'nightly-1',
    type: 'SNAPSHOT',
    createtxg: '12345',
    properties: {
      creation: { value: 'Thu Aug 28 02:00 2025', rawvalue: '1756346400', parsed: 1756346400 },
      referenced: { value: '96K', rawvalue: '98304', parsed: 98304 },
    },
    ...over,
  });

  /** The tool's own envelope, for the assertions below. */
  interface Listing {
    snapshots: Record<string, unknown>[];
    truncated: boolean;
    limit: number;
  }

  const listing = async (
    snapshots: unknown[],
    args: Record<string, unknown> = {},
    datasets: unknown[] = [],
  ): Promise<Listing> => {
    const { ctx } = fakeSystem({
      ['pool.snapshot.query']: snapshots,
      ['pool.dataset.query']: datasets,
    });
    return (await snapshotsList.handler(ctx, args)) as unknown as Listing;
  };

  it('maps a snapshot to its name, dataset, creation time and referenced size', async () => {
    const result = await listing([snapshot()]);
    expect(result).toEqual({
      snapshots: [
        {
          name: 'tank/media@nightly-1',
          dataset: 'tank/media',
          created: '2025-08-28T02:00:00.000Z',
          referenced_bytes: 98304,
          // Neither argument was passed, so neither field was asked of the
          // system and neither is reported.
          held: null,
          scheduled_removal: null,
        },
      ],
      truncated: false,
      limit: 100,
    });
  });

  it('surfaces no field a later release adds', async () => {
    const result = await listing([
      snapshot({
        future_field: 'added by a later TrueNAS release',
        // Sent by the system though nothing asked for them: a field is
        // reported because this tool names it, not because a row carried it.
        holds: { truenas: 1 },
        retention: { datetime: { $date: 1756346400000 }, source: 'property' },
      }),
    ]);
    expect(Object.keys(result.snapshots[0])).toEqual([
      'name',
      'dataset',
      'created',
      'referenced_bytes',
      'held',
      'scheduled_removal',
    ]);
    expect(result.snapshots[0]['held']).toBeNull();
    expect(result.snapshots[0]['scheduled_removal']).toBeNull();
  });

  it('asks for one more row than the bound, and for only the two properties it reports', async () => {
    const { ctx, query } = fakeSystem({ ['pool.snapshot.query']: [snapshot()] });
    await snapshotsList.handler(ctx, {});
    // No `order_by`: the system applies the bound, so an order asked for here
    // would choose which snapshots a truncated list holds, and no field of a
    // snapshot row orders it in time soundly — `createtxg` is a string, and it
    // counts transaction groups on the system holding the snapshot rather than
    // the one that took it. The extra row is what tells a complete list from a
    // truncated one.
    expect(query).toHaveBeenCalledWith('pool.snapshot.query', [], {
      limit: 101,
      extra: { properties: ['creation', 'referenced'] },
    });
  });

  it('passes a dataset filter to the query', async () => {
    const { ctx, query } = fakeSystem({ ['pool.snapshot.query']: [snapshot()] });
    await snapshotsList.handler(ctx, { dataset: 'tank/media' });
    expect(query).toHaveBeenCalledWith('pool.snapshot.query', [['dataset', '=', 'tank/media']], {
      limit: 101,
      extra: { properties: ['creation', 'referenced'] },
    });
    // The dataset plainly exists — it has snapshots — so nothing else is asked.
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('reports a dataset that exists and holds no snapshots as an empty list', async () => {
    expect(await listing([], { dataset: 'tank/empty' }, [{ id: 'tank/empty' }])).toEqual({
      snapshots: [],
      truncated: false,
      limit: 100,
    });
  });

  it('distinguishes a dataset that does not exist from one with no snapshots', async () => {
    // Same empty snapshot list as above; the dataset query is what differs.
    await expect(listing([], { dataset: 'tank/ghost' }, [])).rejects.toThrow(
      /Dataset "tank\/ghost" does not exist/,
    );
  });

  it('does not check for the dataset when none was named', async () => {
    const { ctx, query } = fakeSystem({ ['pool.snapshot.query']: [] });
    await expect(snapshotsList.handler(ctx, {})).resolves.toEqual({
      snapshots: [],
      truncated: false,
      limit: 100,
    });
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('rejects a dataset argument that is not a dataset name', async () => {
    // Ignoring it would answer with every snapshot on the system, which is a
    // wrong answer to the question asked rather than a broad one.
    for (const bad of [123, '', true, {}]) {
      await expect(listing([snapshot()], { dataset: bad })).rejects.toThrow(
        /"dataset" must be a non-empty string/,
      );
    }
  });

  it('bounds the list and says so when the system holds more', async () => {
    // Which two come back is the system's choice — the bound is applied there,
    // and this tool orders that window rather than choosing it. `truncated` is
    // what says the list is not the whole set.
    const result = await listing(
      [snapshot({ name: 'a' }), snapshot({ name: 'b' }), snapshot({ name: 'c' })],
      { limit: 2 },
    );
    expect(result.snapshots.map((row) => row['name'])).toEqual(['a', 'b']);
    expect(result.truncated).toBe(true);
    expect(result.limit).toBe(2);
  });

  it('is not truncated when the system holds exactly the bound', async () => {
    const result = await listing([snapshot({ name: 'a' }), snapshot({ name: 'b' })], { limit: 2 });
    expect(result.snapshots).toHaveLength(2);
    expect(result.truncated).toBe(false);
  });

  it('clamps the bound, and reports the one it applied', async () => {
    const applied = async (limit: unknown): Promise<number> => {
      const { ctx, query } = fakeSystem({ ['pool.snapshot.query']: [] });
      const result = (await snapshotsList.handler(ctx, { limit })) as unknown as Listing;
      // The bound reported and the bound asked of the middleware are the same
      // number, so a caller reading `limit` is reading what actually applied.
      expect(query).toHaveBeenCalledWith('pool.snapshot.query', [], {
        limit: result.limit + 1,
        extra: { properties: ['creation', 'referenced'] },
      });
      return result.limit;
    };
    expect(await applied(5000)).toBe(1000);
    // Zero would return nothing while reporting the system as holding more.
    expect(await applied(0)).toBe(1);
    expect(await applied(-3)).toBe(1);
    expect(await applied(2.7)).toBe(2);
    // Not a number, so not a bound: the default stands.
    expect(await applied('50')).toBe(100);
    expect(await applied(Number.NaN)).toBe(100);
    expect(await applied(undefined)).toBe(100);
  });

  it('orders newest first, and puts an unreadable creation time last', async () => {
    const result = await listing([
      snapshot({ name: 'older', properties: { creation: { rawvalue: '1000' } } }),
      snapshot({ name: 'unreadable', properties: { creation: { rawvalue: 'whenever' } } }),
      snapshot({ name: 'newest', properties: { creation: { rawvalue: '3000' } } }),
      snapshot({ name: 'middle', properties: { creation: { rawvalue: '2000' } } }),
      snapshot({ name: 'also-unreadable', properties: {} }),
    ]);
    expect(result.snapshots.map((row) => row['name'])).toEqual([
      'newest',
      'middle',
      'older',
      // Both unreadable, in the order the system sent them.
      'unreadable',
      'also-unreadable',
    ]);
  });

  it('reads the creation time ZFS reports rather than the middleware rendering', async () => {
    // `parsed` disagrees with `rawvalue` here: only a tool reading the raw
    // epoch seconds answers with the second timestamp.
    const result = await listing([
      snapshot({
        properties: { creation: { rawvalue: '1756346400', parsed: 'Aug 27 2019, sometime' } },
      }),
    ]);
    expect(result.snapshots[0]['created']).toBe('2025-08-28T02:00:00.000Z');
  });

  it('reports a creation time it cannot read as null rather than as the epoch', async () => {
    const unreadable = async (creation: unknown): Promise<unknown> => {
      const result = await listing([snapshot({ properties: { creation } })]);
      return result.snapshots[0]['created'];
    };
    // `Number('')` is 0, which would date every one of these to 1970.
    expect(await unreadable({ rawvalue: '' })).toBeNull();
    expect(await unreadable({ rawvalue: 'whenever' })).toBeNull();
    expect(await unreadable({ rawvalue: '17e8' })).toBeNull();
    expect(await unreadable({ rawvalue: null })).toBeNull();
    expect(await unreadable({})).toBeNull();
    expect(await unreadable(null)).toBeNull();
    expect(await unreadable(1756346400)).toBeNull();
    // Beyond what a Date can hold, where `toISOString` throws rather than
    // answering — one absurd row must not take the whole listing down.
    expect(await unreadable({ rawvalue: '999999999999999' })).toBeNull();
    expect(await unreadable({ rawvalue: '-999999999999999' })).toBeNull();
    expect(await unreadable({ rawvalue: Number.POSITIVE_INFINITY })).toBeNull();
    // A number the system did send, in the form it sends strings in.
    expect(await unreadable({ rawvalue: 1756346400 })).toBe('2025-08-28T02:00:00.000Z');
    expect(await unreadable({ rawvalue: '-1' })).toBe('1969-12-31T23:59:59.000Z');
  });

  it('reports an unreadable referenced size as null rather than as nothing referenced', async () => {
    const referenced = async (property: unknown): Promise<unknown> => {
      const result = await listing([
        snapshot({ properties: { creation: { rawvalue: '1' }, referenced: property } }),
      ]);
      return result.snapshots[0]['referenced_bytes'];
    };
    expect(await referenced({ parsed: 0 })).toBe(0);
    expect(await referenced({ parsed: Number.NaN })).toBeNull();
    expect(await referenced({ parsed: '98304' })).toBeNull();
    expect(await referenced({})).toBeNull();
    expect(await referenced(undefined)).toBeNull();
    expect(await referenced(98304)).toBeNull();
  });

  it('reports a name or dataset that is not a string as null', async () => {
    const result = await listing([snapshot({ name: 12345, dataset: null })]);
    expect(result.snapshots[0]['name']).toBeNull();
    expect(result.snapshots[0]['dataset']).toBeNull();
  });

  it('survives a row whose properties are not an object', async () => {
    const result = await listing([snapshot({ properties: 'unset' })]);
    expect(result.snapshots[0]).toEqual({
      name: 'tank/media@nightly-1',
      dataset: 'tank/media',
      created: null,
      referenced_bytes: null,
      held: null,
      scheduled_removal: null,
    });
  });

  describe('hold state and scheduled removal', () => {
    /** The two fields of one entry, for the assertions below. */
    const fields = async (
      row: Record<string, unknown>,
      args: Record<string, unknown>,
    ): Promise<Record<string, unknown>> => {
      const result = await listing([snapshot(row)], args);
      return result.snapshots[0];
    };

    it('asks the system for neither field unless the caller did', async () => {
      const { ctx, query } = fakeSystem({ ['pool.snapshot.query']: [snapshot()] });
      await snapshotsList.handler(ctx, { report_held: false, report_scheduled_removal: false });
      // No `holds` and no `retention`: both widen the read over every snapshot
      // on the system, before this tool's `limit` bounds anything.
      expect(query).toHaveBeenCalledWith('pool.snapshot.query', [], {
        limit: 101,
        extra: { properties: ['creation', 'referenced'] },
      });
    });

    it('asks for each flag only where its own argument was passed', async () => {
      // The option names are the middleware's own and the client types `extra`
      // as an open record, so nothing about them is compiler-checked: a
      // misspelling would be dropped rather than refused, and the field would
      // read null on every entry. This pins the spelling; the tests below pin
      // that what comes back is actually read.
      const asked = async (args: Record<string, unknown>, extra: Record<string, unknown>) => {
        const { ctx, query } = fakeSystem({ ['pool.snapshot.query']: [] });
        await snapshotsList.handler(ctx, args);
        expect(query).toHaveBeenCalledWith('pool.snapshot.query', [], { limit: 101, extra });
      };
      await asked(
        { report_held: true },
        { properties: ['creation', 'referenced'], holds: true },
      );
      await asked(
        { report_scheduled_removal: true },
        { properties: ['creation', 'referenced'], retention: true },
      );
      await asked({ report_held: true, report_scheduled_removal: true }, {
        properties: ['creation', 'referenced'],
        holds: true,
        retention: true,
      });
    });

    it('rejects an argument that is not a boolean rather than reading it as false', async () => {
      // Coerced, the flag would be false, the middleware would never be asked,
      // and every entry would report null — which is what a system that does
      // not report the field answers with, so a caller could not tell.
      for (const bad of ['true', 1, 0, 'yes', {}]) {
        await expect(listing([snapshot()], { report_held: bad })).rejects.toThrow(
          /"report_held" must be a boolean/,
        );
        await expect(listing([snapshot()], { report_scheduled_removal: bad })).rejects.toThrow(
          /"report_scheduled_removal" must be a boolean/,
        );
      }
    });

    it('reports the truenas hold tag as held, and its absence as not held', async () => {
      // `false` and null are different answers: the first is a hold state that
      // was read, the second is one that was not.
      expect(await fields({ holds: { truenas: 1 } }, { report_held: true })).toMatchObject({
        held: true,
      });
      expect(await fields({ holds: {} }, { report_held: true })).toMatchObject({ held: false });
      // The refcount the middleware normalises to 1, and the count of none.
      expect(await fields({ holds: { truenas: 3 } }, { report_held: true })).toMatchObject({
        held: true,
      });
      expect(await fields({ holds: { truenas: 0 } }, { report_held: true })).toMatchObject({
        held: false,
      });
      // A tag that is not TrueNAS's own is not this field's subject at all.
      expect(await fields({ holds: { keep: 1 } }, { report_held: true })).toMatchObject({
        held: false,
      });
    });

    it('reports a hold state it cannot read as null rather than as not held', async () => {
      // Null and never false: `false` says nothing is protecting the snapshot,
      // and a caller acting on that prunes it.
      for (const holds of [undefined, null, 'held', 7, [], { truenas: 'yes' }, { truenas: null }]) {
        expect(await fields({ holds }, { report_held: true })).toMatchObject({ held: null });
      }
    });

    it('reports the removal the system annotated, with the owning task', async () => {
      expect(
        await fields(
          {
            retention: {
              datetime: { $date: 1756346400000 },
              source: 'periodic_snapshot_task',
              periodic_snapshot_task_id: 4,
            },
          },
          { report_scheduled_removal: true },
        ),
      ).toMatchObject({
        scheduled_removal: {
          at: '2025-08-28T02:00:00.000Z',
          source: 'periodic_snapshot_task',
          periodic_snapshot_task_id: 4,
        },
      });
    });

    it('reports no task id where the removal comes from the property', async () => {
      expect(
        await fields(
          { retention: { datetime: { $date: 1756346400000 }, source: 'property' } },
          { report_scheduled_removal: true },
        ),
      ).toMatchObject({
        scheduled_removal: {
          at: '2025-08-28T02:00:00.000Z',
          source: 'property',
          periodic_snapshot_task_id: null,
        },
      });
    });

    it('reads the removal time as an envelope, a bare number or a zoned ISO string', async () => {
      const at = async (datetime: unknown): Promise<unknown> => {
        const row = await fields({ retention: { datetime, source: 'property' } }, {
          report_scheduled_removal: true,
        });
        return (row['scheduled_removal'] as Record<string, unknown>)['at'];
      };
      expect(await at({ $date: 1756346400000 })).toBe('2025-08-28T02:00:00.000Z');
      expect(await at(1756346400000)).toBe('2025-08-28T02:00:00.000Z');
      // The shape the client declares: a string. Only with a zone in it.
      expect(await at('2025-08-28T02:00:00Z')).toBe('2025-08-28T02:00:00.000Z');
      expect(await at('2025-08-28T04:00:00+02:00')).toBe('2025-08-28T02:00:00.000Z');
      expect(await at('2025-08-28T02:00:00.500Z')).toBe('2025-08-28T02:00:00.500Z');
      // No zone: reading it as UTC would be a guess off by hours.
      expect(await at('2025-08-28T02:00:00')).toBeNull();
      expect(await at('Thu Aug 28 02:00 2025')).toBeNull();
      expect(await at('2025-13-28T02:00:00Z')).toBeNull();
      expect(await at(undefined)).toBeNull();
      expect(await at(null)).toBeNull();
      expect(await at({ $date: 'soon' })).toBeNull();
      // Beyond what a Date can hold: one absurd row must not take the listing
      // down through `toISOString`.
      expect(await at({ $date: 1e16 })).toBeNull();
      expect(await at(Number.POSITIVE_INFINITY)).toBeNull();
    });

    it('keeps a removal whose time could not be read, rather than nulling it', async () => {
      // The opposite direction to a null: this snapshot IS scheduled for
      // removal and the time is what was unreadable.
      expect(
        await fields(
          { retention: { datetime: 'whenever', source: 'periodic_snapshot_task' } },
          { report_scheduled_removal: true },
        ),
      ).toMatchObject({
        scheduled_removal: {
          at: null,
          source: 'periodic_snapshot_task',
          periodic_snapshot_task_id: null,
        },
      });
    });

    it('passes an unfamiliar source through as the system spelled it', async () => {
      expect(
        await fields(
          { retention: { datetime: { $date: 1756346400000 }, source: 'something_later' } },
          { report_scheduled_removal: true },
        ),
      ).toMatchObject({
        scheduled_removal: { source: 'something_later', periodic_snapshot_task_id: null },
      });
      expect(
        await fields(
          { retention: { datetime: { $date: 1756346400000 }, source: 42 } },
          { report_scheduled_removal: true },
        ),
      ).toMatchObject({ scheduled_removal: { source: null } });
    });

    it('reports no scheduled removal where the system annotated none', async () => {
      // The ordinary answer for a snapshot taken by hand — it parses against
      // no task's naming schema — and the same answer an unreadable payload
      // gives, which is why the description says a null establishes nothing.
      for (const retention of [null, undefined, 'none', [], 5]) {
        expect(await fields({ retention }, { report_scheduled_removal: true })).toMatchObject({
          scheduled_removal: null,
        });
      }
    });

    it('reports each field only where its own argument was passed', async () => {
      const row = {
        holds: { truenas: 1 },
        retention: { datetime: { $date: 1756346400000 }, source: 'property' },
      };
      expect(await fields(row, { report_held: true })).toMatchObject({
        held: true,
        scheduled_removal: null,
      });
      expect(await fields(row, { report_scheduled_removal: true })).toMatchObject({
        held: null,
        scheduled_removal: { at: '2025-08-28T02:00:00.000Z' },
      });
    });

    it('surfaces no field of a retention record the tool does not name', async () => {
      const row = await fields(
        {
          retention: {
            datetime: { $date: 1756346400000 },
            source: 'periodic_snapshot_task',
            periodic_snapshot_task_id: 4,
            future_field: 'added by a later TrueNAS release',
          },
        },
        { report_scheduled_removal: true },
      );
      expect(Object.keys(row['scheduled_removal'] as Record<string, unknown>)).toEqual([
        'at',
        'source',
        'periodic_snapshot_task_id',
      ]);
    });
  });
});

describe('snapshots_create', () => {
  it('normalizes args: applies defaults and drops unknown keys', () => {
    expect(
      createSnapshot.normalizeArgs?.({ dataset: 'tank/media', name: 'before', extra: 1 }),
    ).toEqual({ dataset: 'tank/media', name: 'before', recursive: false });
  });

  it('rejects non-boolean recursive instead of silently coercing', () => {
    for (const bad of ['true', 1, 'yes', 0]) {
      expect(() =>
        createSnapshot.normalizeArgs?.({ dataset: 'tank/media', name: 'x', recursive: bad }),
      ).toThrow(/"recursive" must be a boolean/);
    }
    expect(
      createSnapshot.normalizeArgs?.({ dataset: 'tank/media', name: 'x', recursive: null }),
    ).toEqual({ dataset: 'tank/media', name: 'x', recursive: false });
  });

  it('plans the exact pool.snapshot.create call after verifying the dataset exists', async () => {
    const { ctx } = fakeSystem({ ['pool.dataset.query']: [{ id: 'tank/media' }] });
    const steps = await createSnapshot.plan(ctx, { dataset: 'tank/media', name: 'before' });
    expect(steps).toEqual([
      {
        method: 'pool.snapshot.create',
        params: [{ dataset: 'tank/media', name: 'before', recursive: false }],
        description: 'Create snapshot "tank/media@before"',
      },
    ]);
  });

  it('fails the plan when the dataset does not exist', async () => {
    const { ctx } = fakeSystem({ ['pool.dataset.query']: [] });
    await expect(
      createSnapshot.plan(ctx, { dataset: 'tank/nope', name: 'before' }),
    ).rejects.toThrow(/does not exist/);
  });

  it('requires dataset and name', async () => {
    const { ctx } = fakeSystem({});
    await expect(createSnapshot.plan(ctx, { name: 'x' })).rejects.toThrow(/"dataset"/);
    await expect(createSnapshot.plan(ctx, { dataset: 'tank' })).rejects.toThrow(/"name"/);
  });

  it('executes the same call the plan described', async () => {
    const { ctx, call } = fakeSystem({
      ['pool.snapshot.create']: { name: 'tank/media@before' },
    });
    const result = await createSnapshot.execute(ctx, { dataset: 'tank/media', name: 'before' });
    expect(call).toHaveBeenCalledWith('pool.snapshot.create', [
      { dataset: 'tank/media', name: 'before', recursive: false },
    ]);
    expect(result).toEqual({ created: 'tank/media@before' });
  });
});
