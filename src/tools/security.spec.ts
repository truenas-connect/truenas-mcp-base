import { describe, expect, it } from 'vitest';
import { fakeSystem, failingSystem } from '@/testing/fake-systems';
import { securityConfig } from '@/tools/index';

describe('security_config', () => {
  /** A `system.security.config` payload, complete unless overridden. */
  const security = (over: Record<string, unknown> = {}) => ({
    id: 1,
    enable_fips: true,
    enable_gpos_stig: false,
    min_password_age: 1,
    max_password_age: 60,
    password_complexity_ruleset: ['UPPER', 'LOWER', 'NUMBER', 'SPECIAL'],
    min_password_length: 12,
    password_history_length: 5,
    ...over,
  });

  /** An `auth.twofactor.config` payload, complete unless overridden. */
  const twoFactor = (over: Record<string, unknown> = {}) => ({
    id: 1,
    enabled: true,
    services: { ssh: true },
    window: 30,
    ...over,
  });

  const reported = async (
    securityPayload: unknown = security(),
    twoFactorPayload: unknown = twoFactor(),
  ): Promise<Record<string, unknown>> => {
    const { ctx } = fakeSystem({
      ['system.security.config']: securityPayload,
      ['auth.twofactor.config']: twoFactorPayload,
    });
    return (await securityConfig.handler(ctx, {})) as Record<string, unknown>;
  };

  const posture = async (over: Record<string, unknown> = {}) =>
    (await reported(security(over)))['security'] as Record<string, unknown>;

  const factor = async (over: Record<string, unknown> = {}) =>
    (await reported(security(), twoFactor(over)))['two_factor'] as Record<string, unknown>;

  it('is read-only and requires no arguments', () => {
    expect(securityConfig.mutating).toBe(false);
    expect(securityConfig.inputSchema).toEqual({ type: 'object', properties: {} });
  });

  it('reports the security settings and the password policy', async () => {
    expect(await posture()).toEqual({
      unavailable: null,
      fips_enabled: true,
      stig_enabled: false,
      min_password_age: 1,
      max_password_age: 60,
      min_password_length: 12,
      password_history_length: 5,
      password_complexity_ruleset: ['UPPER', 'LOWER', 'NUMBER', 'SPECIAL'],
    });
  });

  it('reports the two-factor settings', async () => {
    expect(await factor()).toEqual({
      unavailable: null,
      enabled: true,
      services: [{ service: 'ssh', enabled: true }],
      window: 30,
    });
  });

  it('states no verdict, on either section or the result', async () => {
    const result = await reported();
    for (const section of [result, result['security'], result['two_factor']]) {
      const fields = Object.keys(section as Record<string, unknown>);
      expect(fields).not.toContain('verdict');
      expect(fields).not.toContain('compliant');
      expect(fields).not.toContain('secure');
      expect(fields).not.toContain('passed');
    }
  });

  it('never reports the middleware row id, from either read', async () => {
    const result = await reported();
    expect((result['security'] as Record<string, unknown>)['id']).toBeUndefined();
    expect((result['two_factor'] as Record<string, unknown>)['id']).toBeUndefined();
  });

  it('reports STIG mode off as false rather than as unreported', async () => {
    expect(await posture({ enable_fips: false, enable_gpos_stig: false })).toMatchObject({
      fips_enabled: false,
      stig_enabled: false,
    });
  });

  it('reports a mode the system did not state as a boolean as null, not as off', async () => {
    const section = await posture({ enable_fips: 'yes', enable_gpos_stig: null });
    expect(section['fips_enabled']).toBeNull();
    expect(section['stig_enabled']).toBeNull();
    expect(section['fips_enabled']).not.toBe(false);
  });

  it('keeps a password-policy zero distinct from a policy field the system unset', async () => {
    expect(
      await posture({ min_password_length: 0, password_history_length: null }),
    ).toMatchObject({ min_password_length: 0, password_history_length: null });
  });

  it('reports a password-policy field this version does not send as null', async () => {
    // Deleted rather than set to undefined: every password-policy field is
    // optional in the payload, and a system on a version that does not report
    // one sends no key at all.
    const withoutPolicy: Record<string, unknown> = security();
    delete withoutPolicy['min_password_length'];
    delete withoutPolicy['max_password_age'];
    const section = (await reported(withoutPolicy))['security'] as Record<string, unknown>;
    expect(section['min_password_length']).toBeNull();
    expect(section['max_password_age']).toBeNull();
    expect(section['min_password_length']).not.toBe(0);
  });

  it('reports a password-policy field that is not a finite number as null', async () => {
    expect(
      await posture({ min_password_age: '1', max_password_age: Number.NaN }),
    ).toMatchObject({ min_password_age: null, max_password_age: null });
  });

  it('reports a system requiring no character classes as an empty ruleset, not as unread', async () => {
    expect(await posture({ password_complexity_ruleset: [] })).toMatchObject({
      password_complexity_ruleset: [],
    });
  });

  it('passes a character class it does not recognise through as the system spelled it', async () => {
    expect(await posture({ password_complexity_ruleset: ['UPPER', 'EMOJI'] })).toMatchObject({
      password_complexity_ruleset: ['UPPER', 'EMOJI'],
    });
  });

  it('nulls the whole ruleset rather than reporting one it had to shorten', async () => {
    // A ruleset one class short would say the policy requires less than it
    // does, so the unreadable entry nulls the list instead of being dropped.
    expect(await posture({ password_complexity_ruleset: ['UPPER', 7] })).toMatchObject({
      password_complexity_ruleset: null,
    });
  });

  it('reports a ruleset that is not a list at all as null', async () => {
    expect(await posture({ password_complexity_ruleset: 'UPPER' })).toMatchObject({
      password_complexity_ruleset: null,
    });
  });

  it('reports two-factor switched on and covering nothing as exactly that', async () => {
    expect(await factor({ enabled: true, services: {} })).toMatchObject({
      enabled: true,
      services: [],
    });
  });

  it('reports a service the system named but switched off as false', async () => {
    expect(await factor({ enabled: true, services: { ssh: false } })).toMatchObject({
      services: [{ service: 'ssh', enabled: false }],
    });
  });

  it('sorts the services by name and passes a later one through', async () => {
    expect(await factor({ services: { ssh: true, api: false } })).toMatchObject({
      services: [
        { service: 'api', enabled: false },
        { service: 'ssh', enabled: true },
      ],
    });
  });

  it('keeps a service whose value it cannot read, as a named entry saying nothing', async () => {
    expect(await factor({ services: { ssh: 'on' } })).toMatchObject({
      services: [{ service: 'ssh', enabled: null }],
    });
  });

  it('nulls the whole service list where a service could not be named', async () => {
    expect(await factor({ services: { '': true, ssh: true } })).toMatchObject({ services: null });
  });

  it('reports the services as null where the system sent no service configuration', async () => {
    expect(await factor({ services: ['ssh'] })).toMatchObject({ services: null });
  });

  it('reports a two-factor field the system did not state as null', async () => {
    expect(await factor({ enabled: 1, window: null })).toMatchObject({
      enabled: null,
      window: null,
    });
  });

  it('reports the security section as unread where the system answered with no configuration', async () => {
    const section = (await reported('hardened'))['security'] as Record<string, unknown>;
    expect(section).toEqual({
      unavailable: 'the system did not answer with a security configuration',
      fips_enabled: null,
      stig_enabled: null,
      min_password_age: null,
      max_password_age: null,
      min_password_length: null,
      password_history_length: null,
      password_complexity_ruleset: null,
    });
  });

  it('reports the two-factor section as unread where the system answered with no configuration', async () => {
    const section = (await reported(security(), []))['two_factor'] as Record<string, unknown>;
    expect(section).toEqual({
      unavailable: 'the system did not answer with a two-factor configuration',
      enabled: null,
      services: null,
      window: null,
    });
  });

  it('still answers the two-factor settings where the security read failed', async () => {
    const { ctx } = failingSystem(
      { ['auth.twofactor.config']: twoFactor() },
      { ['system.security.config']: new Error('unknown method') },
    );
    const result = (await securityConfig.handler(ctx, {})) as Record<string, unknown>;
    expect(result['security']).toMatchObject({
      unavailable: 'unknown method',
      fips_enabled: null,
      min_password_length: null,
    });
    expect(result['two_factor']).toMatchObject({ unavailable: null, enabled: true });
  });

  it('still answers the security settings where the two-factor read failed', async () => {
    const { ctx } = failingSystem(
      { ['system.security.config']: security() },
      { ['auth.twofactor.config']: { reason: 'not authorised' } },
    );
    const result = (await securityConfig.handler(ctx, {})) as Record<string, unknown>;
    expect(result['two_factor']).toEqual({
      unavailable: 'not authorised',
      enabled: null,
      services: null,
      window: null,
    });
    expect(result['security']).toMatchObject({ unavailable: null, fips_enabled: true });
  });

  it('names a failure that carried no text of its own rather than reporting nothing', async () => {
    const { ctx } = failingSystem(
      { ['system.security.config']: security() },
      { ['auth.twofactor.config']: {} },
    );
    const result = (await securityConfig.handler(ctx, {})) as Record<string, unknown>;
    expect((result['two_factor'] as Record<string, unknown>)['unavailable']).toBe(
      'the system reported no reason',
    );
  });
});
