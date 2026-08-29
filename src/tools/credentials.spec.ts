import { describe, expect, it } from 'vitest';
import { fakeSystem } from '@/testing/fake-systems';
import { cloudCredentialsList, cloudsyncTasksList } from '@/tools/index';

describe('cloud_credentials_list', () => {
  /**
   * A cloud credential as `cloudsync.credentials.query` reports one on the
   * version the client's types describe: `provider` an object whose `type`
   * names the provider and whose other fields are the secret.
   *
   * The secret fields carry real-looking material for the reason the
   * certificate fixture carries a private key — the test that no secret
   * survives the mapping is only worth anything if some was there to survive.
   */
  const credential = (over: Record<string, unknown> = {}) => ({
    id: 3,
    name: 'offsite-backups',
    provider: {
      type: 'S3',
      access_key_id: 'SECRET-ACCESS-KEY-ID',
      secret_access_key: 'SECRET-SECRET-ACCESS-KEY',
      endpoint: 's3.example.invalid',
      region: 'us-east-1',
    },
    ...over,
  });

  const listed = async (rows: unknown[]): Promise<Record<string, unknown>[]> => {
    const { ctx } = fakeSystem({ ['cloudsync.credentials.query']: rows });
    return (await cloudCredentialsList.handler(ctx, {})) as Record<string, unknown>[];
  };

  /** One credential, differing only in the fields the case is about. */
  const one = async (over: Record<string, unknown>): Promise<Record<string, unknown>> =>
    (await listed([credential(over)]))[0];

  it('maps a credential to its id, name and provider type', async () => {
    expect(await listed([credential()])).toEqual([
      { id: 3, name: 'offsite-backups', provider: 'S3' },
    ]);
  });

  it('returns no key, token or other secret material, whatever the provider is', async () => {
    const rows = await listed([
      credential({
        provider: {
          type: 'SFTP',
          host: 'sftp.example.invalid',
          user: 'backup',
          pass: 'SECRET-PASSWORD',
          private_key: 'SECRET-PRIVATE-KEY',
        },
      }),
      credential({
        id: 4,
        provider: { type: 'AZUREBLOB', account: 'acct', key: 'SECRET-ACCOUNT-KEY' },
      }),
    ]);
    expect(JSON.stringify(rows)).not.toContain('SECRET');
    expect(rows.map((row) => row['provider'])).toEqual(['SFTP', 'AZUREBLOB']);
  });

  it('carries no field the tool does not name, including one a later release adds', async () => {
    const rows = await listed([
      credential({
        attributes: { token: 'SECRET-OAUTH-TOKEN' },
        // A provider TrueNAS has not shipped yet, spelling its secret a way
        // this file has never seen. An allowlist keeps it out; a copy with the
        // known secrets removed would not.
        provider: { type: 'FUTURE_PROVIDER', unheard_of_secret: 'SECRET-NEW-SHAPE' },
        renewable: true,
      }),
    ]);
    expect(Object.keys(rows[0])).toEqual(['id', 'name', 'provider']);
    expect(JSON.stringify(rows)).not.toContain('SECRET');
  });

  it('reads a provider the system named as a bare string, as older releases send it', async () => {
    expect(
      await one({ provider: 'GOOGLE_DRIVE', attributes: { token: 'SECRET-OAUTH-TOKEN' } }),
    ).toEqual({ id: 3, name: 'offsite-backups', provider: 'GOOGLE_DRIVE' });
  });

  it('reports a provider it could not read as null rather than as no provider', async () => {
    expect(await one({ provider: null })).toMatchObject({ provider: null });
    expect(await one({ provider: 42 })).toMatchObject({ provider: null });
    expect(await one({ provider: ['S3'] })).toMatchObject({ provider: null });
    expect(await one({ provider: {} })).toMatchObject({ provider: null });
    expect(await one({ provider: { type: '' } })).toMatchObject({ provider: null });
    expect(await one({ provider: { type: 7 } })).toMatchObject({ provider: null });
  });

  it('reports a name the system gave no value for as null', async () => {
    expect(await one({ name: '' })).toMatchObject({ name: null });
    expect(await one({ name: null })).toMatchObject({ name: null });
  });

  it('reports an id it could not read as null, so no task can be joined to it', async () => {
    expect(await one({ id: null })).toMatchObject({ id: null });
    expect(await one({ id: '3' })).toMatchObject({ id: null });
    expect(await one({ id: Number.NaN })).toMatchObject({ id: null });
  });

  it('reads the same id cloudsync_tasks_list joins on', async () => {
    // The point of the tool: a task names its credential by id, and this is
    // what that id is looked up in. A test that only asserted the shape of each
    // result separately would not notice the two reading that id differently.
    const { ctx } = fakeSystem({
      ['cloudsync.query']: [
        {
          id: 1,
          description: 'Nightly offsite',
          direction: 'PUSH',
          path: '/mnt/tank/media',
          attributes: {},
          credentials: { id: 3, name: 'offsite-backups' },
          schedule: null,
          job: null,
        },
      ],
      ['cloudsync.credentials.query']: [credential({ id: 3 })],
    });
    const tasks = (await cloudsyncTasksList.handler(ctx, {})) as Record<string, unknown>[];
    const credentials = (await cloudCredentialsList.handler(ctx, {})) as Record<
      string,
      unknown
    >[];
    expect(tasks[0]['credential_id']).toBe(3);
    expect(credentials.map((row) => row['id'])).toContain(tasks[0]['credential_id']);
  });

  it('returns nothing for a system holding no cloud credentials', async () => {
    expect(await listed([])).toEqual([]);
  });

  it('asks for the cloud credentials', async () => {
    const { ctx, query } = fakeSystem({ ['cloudsync.credentials.query']: [] });
    await cloudCredentialsList.handler(ctx, {});
    expect(query).toHaveBeenCalledWith('cloudsync.credentials.query');
  });
});
