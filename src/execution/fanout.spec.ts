import { describe, expect, it } from 'vitest';
import { TrueNasApiClient } from '@truenas/api-client';
import { fanOut } from '@/execution/fanout';
import { SystemHandle } from '@/catalog/tool';

const system = (name: string): SystemHandle => ({
  name,
  client: {} as TrueNasApiClient,
});

describe('fanOut', () => {
  it('returns structured per-system results on partial failure', async () => {
    const results = await fanOut([system('a'), system('b')], async ({ name }) => {
      if (name === 'b') {
        throw new Error('parent dataset missing');
      }
      return 'created';
    });

    expect(results).toEqual([
      { system: 'a', status: 'SUCCESS', value: 'created' },
      {
        system: 'b',
        status: 'ERROR',
        error: { message: 'parent dataset missing', errname: null, errno: null },
      },
    ]);
  });

  it('stringifies non-Error throws', async () => {
    const results = await fanOut([system('a')], async () => {
      throw 'boom';
    });
    expect(results).toEqual([
      { system: 'a', status: 'ERROR', error: { message: 'boom', errname: null, errno: null } },
    ]);
  });

  it('extracts errname and errno when the thrown error carries them', async () => {
    const results = await fanOut([system('a')], async () => {
      throw Object.assign(new Error('Invalid argument'), { errname: 'EINVAL', errno: 22 });
    });
    expect(results).toEqual([
      {
        system: 'a',
        status: 'ERROR',
        error: { message: 'Invalid argument', errname: 'EINVAL', errno: 22 },
      },
    ]);
  });
});
