import { describe, expect, it, vi } from 'vitest';
import { concat, NEVER, Observable, of, throwError } from 'rxjs';
import { Role } from '@/interfaces';
import { SystemHandle, ToolContext } from '@/catalog/tool';
import { certificateCsrCreate } from '@/tools/index';

/**
 * `certificate_csr_create`'s tests, in a spec named for the tool as the ticket
 * asked (#87). The fake system is local for the reason `vm-stop.spec.ts` gives
 * about its own: a job is a stream rather than a response, so the correlation
 * and the tracking have to move independently of the one `certificate.query`
 * read.
 */

const PRIVATE_KEY = '-----BEGIN PRIVATE KEY-----\nSEEDED-SECRET\n-----END PRIVATE KEY-----';
const KEY_PATH = '/etc/certificates/web.key';
const CSR = '-----BEGIN CERTIFICATE REQUEST-----\nPUBLIC\n-----END CERTIFICATE REQUEST-----';

/** The new entry as the job answers with it, private key and all. */
const entry = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 9,
  name: 'web',
  CSR,
  privatekey: PRIVATE_KEY,
  privatekey_path: KEY_PATH,
  cert_type_CSR: true,
  ...extra,
});

/** A job as the client's tracking emits one. */
const jobAt = (state: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 41,
  method: 'certificate.create',
  state,
  result: state === 'SUCCESS' ? entry() : null,
  error: null,
  time_finished: { $date: 1_756_000_000_000 },
  ...extra,
});

/** One answer to the `certificate.query` read: the rows it listed, or the failure that stopped it. */
type Read = { rows: unknown } | { fails: unknown };

function jobSystem(options: { read?: Read; started?: Observable<number>; job?: Observable<unknown> } = {}): {
  ctx: ToolContext;
  query: ReturnType<typeof vi.fn>;
  start: ReturnType<typeof vi.fn>;
  track: ReturnType<typeof vi.fn>;
} {
  const read = options.read ?? { rows: [] };
  const query = vi.fn(() => ('fails' in read ? throwError(() => read.fails) : of(read.rows)));
  const start = vi.fn(() => options.started ?? of(41));
  const track = vi.fn(() => options.job ?? of(jobAt('SUCCESS')));
  const system = {
    name: 'nas',
    client: { api: { query, callAndGetJobId: start, trackJob: track } },
  } as unknown as SystemHandle;
  return { ctx: { system }, query, start, track };
}

const args = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  name: 'web',
  common: 'nas.example.com',
  san: ['nas.example.com', '10.0.0.5'],
  ...extra,
});

describe('certificate_csr_create', () => {
  it('is a reversible mutating tool needing the full role', () => {
    expect(certificateCsrCreate).toMatchObject({
      name: 'certificate_csr_create',
      mutating: true,
      destructiveness: 'reversible',
      requiredRole: Role.Full,
    });
  });

  it('has no field for a key, a passphrase, a certificate, the create type or ACME', () => {
    const schema = certificateCsrCreate.inputSchema as { properties: Record<string, unknown>; required: string[] };
    const fields = Object.keys(schema.properties);
    for (const field of ['privatekey', 'passphrase', 'certificate', 'create_type', 'CSR']) {
      expect(fields).not.toContain(field);
    }
    expect(fields.filter((field) => field.startsWith('acme'))).toEqual([]);
    expect(schema.required).toEqual(['name']);
  });

  it('says in its description that the private key never leaves the system', () => {
    expect(certificateCsrCreate.description).toContain('THE PRIVATE KEY NEVER LEAVES THE SYSTEM');
    expect(certificateCsrCreate.resultGuidance).toContain('THE PRIVATE KEY IS NEVER IN THIS RESULT');
  });

  describe('normalizeArgs', () => {
    it('keeps what was passed and drops the executor arguments', () => {
      expect(certificateCsrCreate.normalizeArgs?.({ ...args(), country: 'US', systems: 'all' })).toEqual({
        ...args(),
        country: 'US',
      });
    });

    it.each([
      ['privatekey', PRIVATE_KEY],
      ['passphrase', 'hunter2'],
      ['create_type', 'CERTIFICATE_CREATE_IMPORTED'],
      ['certificate', 'PEM'],
      ['acme_directory_uri', 'https://acme.example'],
      ['cert_extensions', {}],
    ])('refuses %s by name', (key, value) => {
      expect(() => certificateCsrCreate.normalizeArgs?.(args({ [key]: value }))).toThrow(`"${key}" is not accepted`);
    });

    it('never quotes a refused private key back', () => {
      expect(() => certificateCsrCreate.normalizeArgs?.(args({ privatekey: PRIVATE_KEY }))).toThrow(
        expect.objectContaining({ message: expect.not.stringContaining('SEEDED-SECRET') }),
      );
    });

    it('requires a name', () => {
      expect(() => certificateCsrCreate.normalizeArgs?.({ common: 'x' })).toThrow('"name" is required');
      expect(() => certificateCsrCreate.normalizeArgs?.({ name: '' })).toThrow('"name" is required');
    });

    it('refuses key_length beside EC, or with no key type named', () => {
      expect(() => certificateCsrCreate.normalizeArgs?.(args({ key_type: 'EC', key_length: 2048 }))).toThrow(
        '"key_length" applies to an RSA key only',
      );
      expect(() => certificateCsrCreate.normalizeArgs?.(args({ key_length: 2048 }))).toThrow(
        '"key_length" applies to an RSA key only',
      );
    });

    it('refuses ec_curve beside RSA, or with no key type named', () => {
      expect(() => certificateCsrCreate.normalizeArgs?.(args({ key_type: 'RSA', ec_curve: 'SECP384R1' }))).toThrow(
        '"ec_curve" applies to an EC key only',
      );
      expect(() => certificateCsrCreate.normalizeArgs?.(args({ ec_curve: 'SECP384R1' }))).toThrow(
        '"ec_curve" applies to an EC key only',
      );
    });

    it('accepts each key parameter beside its own key type', () => {
      expect(certificateCsrCreate.normalizeArgs?.(args({ key_type: 'RSA', key_length: 4096 }))).toMatchObject({
        key_type: 'RSA',
        key_length: 4096,
      });
      expect(certificateCsrCreate.normalizeArgs?.(args({ key_type: 'EC', ec_curve: 'ed25519' }))).toMatchObject({
        key_type: 'EC',
        ec_curve: 'ed25519',
      });
    });

    it.each([
      ['key_type', 'DSA'],
      ['key_length', 1024],
      ['ec_curve', 'P-256'],
      ['digest_algorithm', 'MD5'],
      ['digest_algorithm', true],
    ])('refuses %s %s, naming the accepted values', (key, value) => {
      const extra = key === 'key_length' ? { key_type: 'RSA' } : key === 'ec_curve' ? { key_type: 'EC' } : {};
      expect(() => certificateCsrCreate.normalizeArgs?.(args({ ...extra, [key]: value }))).toThrow(
        `is not a value of \`${key}\``,
      );
    });

    it('refuses a SAN list that is not a list of names', () => {
      expect(() => certificateCsrCreate.normalizeArgs?.(args({ san: 'nas.example.com' }))).toThrow('"san" must be');
      expect(() => certificateCsrCreate.normalizeArgs?.(args({ san: ['ok', ''] }))).toThrow('"san" must be');
      expect(() => certificateCsrCreate.normalizeArgs?.(args({ san: [3] }))).toThrow('"san" must be');
    });

    it('refuses an empty or non-text subject field', () => {
      expect(() => certificateCsrCreate.normalizeArgs?.(args({ country: '' }))).toThrow('"country" must be');
      expect(() => certificateCsrCreate.normalizeArgs?.(args({ common: 7 }))).toThrow('"common" must be');
    });

    it('treats a null optional argument as absent', () => {
      expect(
        certificateCsrCreate.normalizeArgs?.({ name: 'web', san: null, key_type: null, email: null, common: null }),
      ).toEqual({ name: 'web' });
    });
  });

  describe('plan', () => {
    it('reads the name through an allowlist, and checks it on the response', async () => {
      const { ctx, query } = jobSystem({ read: { rows: [] } });
      await certificateCsrCreate.plan(ctx, args());
      expect(query).toHaveBeenCalledWith('certificate.query', [['name', '=', 'web']], { select: ['id', 'name'] });
    });

    it('fails on a name already in use, without quoting the row', async () => {
      const { ctx } = jobSystem({ read: { rows: [{ id: 2, name: 'web', privatekey: PRIVATE_KEY }] } });
      const failure = certificateCsrCreate.plan(ctx, args());
      await expect(failure).rejects.toThrow('A certificate named "web" already exists');
      await expect(failure).rejects.toThrow(expect.objectContaining({ message: expect.not.stringContaining('SEEDED') }));
    });

    it('does not act on a row a dropped filter returned under another name', async () => {
      const { ctx } = jobSystem({ read: { rows: [{ id: 2, name: 'other' }] } });
      await expect(certificateCsrCreate.plan(ctx, args())).resolves.toHaveLength(1);
    });

    it('fails where whether the name is free could not be read', async () => {
      await expect(
        certificateCsrCreate.plan(jobSystem({ read: { fails: new Error('socket closed') } }).ctx, args()),
      ).rejects.toThrow('could not be read (certificate.query failed: socket closed)');
      await expect(certificateCsrCreate.plan(jobSystem({ read: { rows: null } }).ctx, args())).rejects.toThrow(
        'the response was not a list',
      );
    });

    it('names one call, always as a CSR, with exactly the fields passed', async () => {
      const steps = await certificateCsrCreate.plan(
        jobSystem().ctx,
        args({ key_type: 'RSA', key_length: 4096, digest_algorithm: 'SHA256', organization: 'Acme' }),
      );
      expect(steps).toHaveLength(1);
      expect(steps[0].method).toBe('certificate.create');
      expect(steps[0].params).toEqual([
        {
          name: 'web',
          create_type: 'CERTIFICATE_CREATE_CSR',
          common: 'nas.example.com',
          san: ['nas.example.com', '10.0.0.5'],
          key_type: 'RSA',
          key_length: 4096,
          digest_algorithm: 'SHA256',
          organization: 'Acme',
        },
      ]);
    });

    it('states the subject and every alternative name', async () => {
      const [step] = await certificateCsrCreate.plan(jobSystem().ctx, args({ country: 'US', email: 'ops@x.io' }));
      expect(step.description).toContain('common name "nas.example.com"');
      expect(step.description).toContain('country "US"');
      expect(step.description).toContain('email "ops@x.io"');
      expect(step.description).toContain('city not set');
      expect(step.description).toContain('Subject alternative names: "nas.example.com", "10.0.0.5".');
      expect(step.description).toContain('The private key stays on the system and is not returned.');
    });

    it('says where no alternative name is sent, and where an empty list is', async () => {
      const [none] = await certificateCsrCreate.plan(jobSystem().ctx, { name: 'web' });
      expect(none.description).toContain('No subject alternative name is sent.');
      expect(none.description).toContain('common name not set');
      const [empty] = await certificateCsrCreate.plan(jobSystem().ctx, { name: 'web', san: [] });
      expect(empty.description).toContain('An empty subject alternative name list is sent.');
    });

    it('names an omitted key setting as the unstated default rather than guessing it', async () => {
      const [step] = await certificateCsrCreate.plan(jobSystem().ctx, args());
      expect(step.description).toContain("Key type not sent, so the system's default applies");
      expect(step.description).toContain("Digest not sent, so the system's default applies");
      const [rsa] = await certificateCsrCreate.plan(jobSystem().ctx, args({ key_type: 'RSA' }));
      expect(rsa.description).toContain("An RSA key, length not sent, so the system's default applies");
      const [ec] = await certificateCsrCreate.plan(jobSystem().ctx, args({ key_type: 'EC' }));
      expect(ec.description).toContain("An EC key, curve not sent, so the system's default applies");
      const [named] = await certificateCsrCreate.plan(jobSystem().ctx, args({ key_type: 'EC', ec_curve: 'SECP384R1' }));
      expect(named.description).toContain('An EC key, curve SECP384R1.');
    });
  });

  describe('execute', () => {
    it('starts the job with the planned params and reports the CSR, id and name', async () => {
      const { ctx, start, track } = jobSystem();
      const result = (await certificateCsrCreate.execute(ctx, args())) as Record<string, unknown>;
      expect(start).toHaveBeenCalledWith('certificate.create', [
        {
          name: 'web',
          create_type: 'CERTIFICATE_CREATE_CSR',
          common: 'nas.example.com',
          san: ['nas.example.com', '10.0.0.5'],
        },
      ]);
      expect(track).toHaveBeenCalledWith(41);
      expect(result).toEqual({
        name: 'web',
        requested: args(),
        watched_seconds: 30,
        job_id: 41,
        ended: true,
        succeeded: true,
        job_state: 'SUCCESS',
        error: null,
        finished_at: new Date(1_756_000_000_000).toISOString(),
        certificate_id: 9,
        certificate_name: 'web',
        csr: CSR,
      });
    });

    it('never returns the private key or its path from the job result', async () => {
      const result = await certificateCsrCreate.execute(jobSystem().ctx, args());
      const text = JSON.stringify(result);
      expect(text).not.toContain('SEEDED-SECRET');
      expect(text).not.toContain(KEY_PATH);
      expect(text).not.toContain('privatekey');
    });

    it('keeps the key out where the job failed carrying one', async () => {
      const job = of(jobAt('FAILED', { result: entry(), error: 'openssl failed' }));
      const result = (await certificateCsrCreate.execute(jobSystem({ job }).ctx, args())) as Record<string, unknown>;
      expect(result).toMatchObject({ ended: true, succeeded: false, error: 'openssl failed' });
      expect(JSON.stringify(result)).not.toContain('SEEDED-SECRET');
      expect(JSON.stringify(result)).not.toContain(KEY_PATH);
    });

    it('reports ended false, the job id and no CSR where the watch ends first', async () => {
      vi.useFakeTimers();
      try {
        const job = concat(of(jobAt('RUNNING', { result: entry() })), NEVER);
        const pending = certificateCsrCreate.execute(jobSystem({ job }).ctx, args());
        await vi.advanceTimersByTimeAsync(30_000);
        const result = (await pending) as Record<string, unknown>;
        expect(result).toMatchObject({
          ended: false,
          succeeded: null,
          job_id: 41,
          job_state: 'RUNNING',
          finished_at: null,
          certificate_id: null,
          certificate_name: null,
          csr: null,
        });
        expect(JSON.stringify(result)).not.toContain('SEEDED-SECRET');
      } finally {
        vi.useRealTimers();
      }
    });

    it('reports nulls where the job ended and its answer was not an entry', async () => {
      const job = of(jobAt('SUCCESS', { result: 'done' }));
      const result = (await certificateCsrCreate.execute(jobSystem({ job }).ctx, args())) as Record<string, unknown>;
      expect(result).toMatchObject({ ended: true, certificate_id: null, certificate_name: null, csr: null });
    });

    it('keeps the job id where following the job fails after it was named', async () => {
      const job = throwError(() => new Error('connection dropped'));
      const result = (await certificateCsrCreate.execute(jobSystem({ job }).ctx, args())) as Record<string, unknown>;
      expect(result).toMatchObject({ ended: false, job_id: 41, csr: null });
    });

    it('fails where the call fails before any job was named', async () => {
      const started = throwError(() => new Error('[EINVAL] certificate_create.name: invalid'));
      await expect(certificateCsrCreate.execute(jobSystem({ started }).ctx, args())).rejects.toThrow('EINVAL');
    });
  });
});
