import { describe, expect, it } from 'vitest';
import {
  ConfirmationError,
  ConfirmationService,
  planKey,
  stableStringify,
} from '@/execution/confirmation';

describe('stableStringify', () => {
  it('is insensitive to object key order', () => {
    expect(stableStringify({ a: 1, b: [{ d: 2, c: 3 }] })).toBe(
      stableStringify({ b: [{ c: 3, d: 2 }], a: 1 }),
    );
  });

  it('drops undefined properties', () => {
    expect(stableStringify({ a: 1, b: undefined })).toBe(stableStringify({ a: 1 }));
  });

  it('encodes undefined array elements as null, never ambiguously', () => {
    expect(stableStringify([undefined])).toBe('[null]');
    expect(stableStringify([undefined])).not.toBe(stableStringify([]));
    expect(stableStringify([1, undefined])).toBe('[1,null]');
  });
});

describe('planKey', () => {
  const base = { tool: 'snapshots_create', args: { dataset: 'tank/a' }, systems: ['a'] };

  it('is stable for identical input', () => {
    expect(planKey(base)).toBe(planKey({ ...base }));
  });

  it('changes when args change', () => {
    expect(planKey(base)).not.toBe(
      planKey({ ...base, args: { dataset: 'tank/b' } }),
    );
  });

  it('changes when target systems change', () => {
    expect(planKey(base)).not.toBe(planKey({ ...base, systems: ['a', 'b'] }));
  });
});

describe('ConfirmationService', () => {
  const key = '{"tool":"snapshots_create"}';

  it('accepts a freshly minted token exactly once', () => {
    const service = new ConfirmationService();
    const token = service.mint(key);
    expect(() => service.consume(token, key)).not.toThrow();
    expect(() => service.consume(token, key)).toThrow(ConfirmationError);
  });

  it('rejects an unknown token', () => {
    const service = new ConfirmationService();
    expect(() => service.consume('nope', key)).toThrow(/unknown confirmation token/i);
  });

  it('rejects a token minted for a different plan', () => {
    const service = new ConfirmationService();
    const token = service.mint(key);
    expect(() => service.consume(token, '{"tool":"other"}')).toThrow(/does not match/i);
  });

  it('rejects an expired token', () => {
    let time = 0;
    const service = new ConfirmationService({ ttlMs: 1000, now: () => time });
    const token = service.mint(key);
    time = 1001;
    expect(() => service.consume(token, key)).toThrow(/expired/i);
  });

  it('evicts the oldest pending token when maxPending is exceeded', () => {
    let id = 0;
    const service = new ConfirmationService({
      maxPending: 2,
      randomId: () => `token-${id++}`,
    });
    const first = service.mint(key);
    const second = service.mint(key);
    const third = service.mint(key);
    expect(() => service.consume(first, key)).toThrow(/unknown confirmation token/i);
    expect(() => service.consume(second, key)).not.toThrow();
    expect(() => service.consume(third, key)).not.toThrow();
  });

  it('sweeps abandoned expired tokens on mint', () => {
    let time = 0;
    let id = 0;
    const service = new ConfirmationService({
      ttlMs: 1000,
      now: () => time,
      randomId: () => `token-${id++}`,
    });
    const abandoned = service.mint(key);
    time = 1001;
    service.mint(key);
    // The abandoned token was evicted, not merely lazily rejected as expired.
    expect(() => service.consume(abandoned, key)).toThrow(/unknown confirmation token/i);
  });
});
