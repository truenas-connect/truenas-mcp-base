import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeSystem } from '@/testing/fake-systems';
import { certificatesList } from '@/tools/index';

describe('certificates_list', () => {
  /**
   * A fixed present, so a day count is a fixed number rather than one that
   * moves with the clock. Only `Date` is faked, as in `tasks_recent_runs`: the
   * tool reads the clock and nothing here schedules anything.
   */
  const NOW = 1_700_000_000_000; // 2023-11-14T22:13:20.000Z

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * A certificate as `certificate.query` reports one, valid until five days
   * after {@link NOW}.
   *
   * `certificate`, `privatekey` and `chain_list` carry real-looking material
   * for the reason the job fixture's arguments carry a password: the test that
   * no key material survives the mapping is only worth anything if some was
   * there to survive. `renew_days`, `key_length`, `DN`, `serial` and
   * `fingerprint` are fields of the real payload that the tool does not name.
   */
  const cert = (over: Record<string, unknown> = {}) => ({
    id: 1,
    type: 8,
    name: 'truenas_default',
    certificate: '-----BEGIN CERTIFICATE-----\nSECRET-CERTIFICATE-MATERIAL\n-----END-----',
    privatekey: '-----BEGIN PRIVATE KEY-----\nSECRET-PRIVATE-KEY-MATERIAL\n-----END-----',
    CSR: null,
    acme_uri: null,
    domains_authenticators: null,
    renew_days: 10,
    acme: null,
    add_to_trusted_store: false,
    root_path: '/etc/certificates',
    certificate_path: '/etc/certificates/truenas_default.crt',
    privatekey_path: '/etc/certificates/truenas_default.key',
    csr_path: null,
    cert_type: 'CERTIFICATE',
    cert_type_existing: true,
    cert_type_CSR: false,
    cert_type_CA: false,
    chain_list: ['-----BEGIN CERTIFICATE-----\nSECRET-CHAIN-MATERIAL\n-----END-----'],
    key_length: 2048,
    key_type: 'RSA',
    country: 'US',
    state: 'Tennessee',
    city: 'Maryville',
    organization: 'iXsystems',
    organizational_unit: '',
    common: 'truenas.local',
    san: ['DNS:truenas.local', 'DNS:nas.local'],
    email: 'info@example.invalid',
    DN: '/C=US/ST=Tennessee/CN=truenas.local',
    subject_name_hash: 123456,
    extensions: {},
    digest_algorithm: 'SHA256',
    lifetime: 397,
    from: 'Tue Nov 14 12:00:00 2023',
    until: 'Mon Nov 20 12:00:00 2023',
    serial: 1,
    chain: false,
    fingerprint: 'AA:BB:CC',
    expired: false,
    parsed: true,
    issuer: 'Lets Encrypt',
    ...over,
  });

  const listed = async (
    rows: unknown[],
    args: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>[]> => {
    const { ctx } = fakeSystem({ ['certificate.query']: rows });
    return (await certificatesList.handler(ctx, args)) as Record<string, unknown>[];
  };

  /** One certificate, differing only in the fields the case is about. */
  const one = async (over: Record<string, unknown>): Promise<Record<string, unknown>> =>
    (await listed([cert(over)]))[0];

  /** The day count of one certificate expiring at `until`. */
  const days = async (until: unknown): Promise<unknown> =>
    (await one({ until }))['days_until_expiry'];

  it('maps a certificate to its names, issuer, validity dates and days left', async () => {
    expect(await listed([cert()])).toEqual([
      {
        name: 'truenas_default',
        common_name: 'truenas.local',
        subject_alternative_names: ['DNS:truenas.local', 'DNS:nas.local'],
        issuer: 'Lets Encrypt',
        not_before: 'Tue Nov 14 12:00:00 2023',
        not_after: 'Mon Nov 20 12:00:00 2023',
        days_until_expiry: 5,
        expired: false,
      },
    ]);
  });

  it('returns no certificate or private key material, and no field a later release adds', async () => {
    const rows = await listed([
      cert({ renewable: true, signed_certificates: 3, extensions_thing: 'new' }),
    ]);
    expect(Object.keys(rows[0])).toEqual([
      'name',
      'common_name',
      'subject_alternative_names',
      'issuer',
      'not_before',
      'not_after',
      'days_until_expiry',
      'expired',
    ]);
    expect(JSON.stringify(rows)).not.toContain('SECRET');
  });

  it('reports a certificate with no alternative name as having none', async () => {
    expect(await one({ san: [] })).toMatchObject({ subject_alternative_names: [] });
  });

  it('reports alternative names the system did not send as a list as unread', async () => {
    // Null rather than the empty list of a certificate that was read and
    // carries no alternative name.
    expect(await one({ san: null })).toMatchObject({ subject_alternative_names: null });
  });

  it('drops an alternative name the system named with nothing', async () => {
    expect(await one({ san: ['DNS:nas.local', '', 7] })).toMatchObject({
      subject_alternative_names: ['DNS:nas.local'],
    });
  });

  it('reports an issuer the system named as an object by that object name', async () => {
    expect(await one({ issuer: { id: 4, name: 'internal-ca' } })).toMatchObject({
      issuer: 'internal-ca',
    });
  });

  it('reports an issuer object that names nothing as no issuer', async () => {
    expect(await one({ issuer: { id: 4 } })).toMatchObject({ issuer: null });
  });

  it('reports an issuer the system sent in a shape this tool cannot read as none', async () => {
    // A list is an object too, and reading one as a record would answer null
    // for its `name` anyway — this states that it is the null of "no issuer
    // reported" rather than an accident.
    expect(await one({ issuer: ['internal-ca'] })).toMatchObject({ issuer: null });
  });

  it('reports a release that sends no issuer at all as reporting none', async () => {
    const without: Record<string, unknown> = { ...cert() };
    delete without['issuer'];
    expect((await listed([without]))[0]).toMatchObject({ issuer: null });
  });

  it('reports a name, common name or validity date the system left empty as null', async () => {
    expect(await one({ name: '', common: '', from: '', until: '' })).toMatchObject({
      name: null,
      common_name: null,
      not_before: null,
      not_after: null,
      days_until_expiry: null,
    });
  });

  it('passes the validity dates through as the system formatted them', async () => {
    expect(await one({ from: '2023-11-14T12:00:00Z', until: '2023-11-20T12:00:00Z' })).toMatchObject(
      { not_before: '2023-11-14T12:00:00Z', not_after: '2023-11-20T12:00:00Z' },
    );
  });

  it('counts the days left from an expiry carrying an explicit zone', async () => {
    expect(await days('2023-11-15T22:13:20+00:00')).toBe(1);
  });

  it('reads an expiry carrying no zone as UTC rather than as local time', async () => {
    // Exactly thirty days after NOW when read as UTC. Read as local time it
    // would move by this machine's offset, which is what the test pins.
    expect(await days('2023-12-14 22:13:20')).toBe(30);
  });

  it('reads a date with no time at all as midnight UTC', async () => {
    // Under two hours away, which is nought whole days rather than one.
    expect(await days('2023-11-15')).toBe(0);
  });

  it('reads the padded single-digit day of the middleware date format', async () => {
    expect(await days('Sun Nov  5 12:00:00 2023')).toBe(-10);
  });

  it('reports an expiry in a form it cannot read as unknown', async () => {
    expect(await days('whenever')).toBeNull();
  });

  it('reports an expiry whose month is not a month as unknown', async () => {
    expect(await days('Mon Foo 20 12:00:00 2023')).toBeNull();
  });

  it('reports an unreadable expiry that ends in a zone as unknown', async () => {
    // The zone is what sends this one to Date.parse, which answers NaN.
    expect(await days('whenever+01:00')).toBeNull();
  });

  it('reports a certificate with no expiry date as unknown rather than as unexpiring', async () => {
    expect(await days(null)).toBeNull();
  });

  it('reports an expired certificate with a negative day count', async () => {
    expect(await one({ until: 'Fri Nov 10 12:00:00 2023', expired: true })).toMatchObject({
      days_until_expiry: -5,
      expired: true,
    });
  });

  it("reports the system's own expiry verdict where it gave none as null", async () => {
    expect(await one({ expired: null })).toMatchObject({ expired: null });
  });

  it('returns every certificate when no window is asked for', async () => {
    const rows = await listed([
      cert({ name: 'soon' }),
      cert({ name: 'later', until: '2024-11-20 12:00:00' }),
      cert({ name: 'unknown', until: null }),
    ]);
    expect(rows.map((row) => row['name'])).toEqual(['soon', 'later', 'unknown']);
  });

  it('restricts the result to certificates inside the window, expired ones included', async () => {
    const rows = await listed(
      [
        cert({ name: 'expired', until: 'Fri Nov 10 12:00:00 2023' }),
        cert({ name: 'five-days' }),
        cert({ name: 'on-the-boundary', until: '2023-12-14 22:13:20' }),
        cert({ name: 'past-the-boundary', until: '2023-12-15 22:13:20' }),
      ],
      { expiring_within_days: 30 },
    );
    expect(rows.map((row) => row['name'])).toEqual(['expired', 'five-days', 'on-the-boundary']);
  });

  it('leaves a certificate whose expiry could not be read out of a window', async () => {
    const rows = await listed([cert({ name: 'unknown', until: null })], {
      expiring_within_days: 30,
    });
    expect(rows).toEqual([]);
  });

  it('treats an absent window as no window rather than as zero days', async () => {
    expect(await listed([cert()], { expiring_within_days: null })).toHaveLength(1);
  });

  it('refuses a window it cannot read rather than answering about every certificate', async () => {
    const { ctx, query } = fakeSystem({ ['certificate.query']: [cert()] });
    await expect(certificatesList.handler(ctx, { expiring_within_days: '30' })).rejects.toThrow(
      'must be a number of days',
    );
    // Refused before the call is spent, not after.
    expect(query).not.toHaveBeenCalled();
  });

  it('refuses a window that is a number naming no quantity', async () => {
    await expect(listed([cert()], { expiring_within_days: Number.NaN })).rejects.toThrow(
      'must be a number of days',
    );
  });

  it('asks for the certificates', async () => {
    const { ctx, query } = fakeSystem({ ['certificate.query']: [] });
    await certificatesList.handler(ctx, {});
    expect(query).toHaveBeenCalledWith('certificate.query');
  });
});
