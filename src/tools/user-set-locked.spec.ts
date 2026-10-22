import { describe, expect, it } from 'vitest';
import { Role } from '@/interfaces';
import { fakeSystem, failingSystem } from '@/testing/fake-systems';
import { userSetLocked } from '@/tools/index';

describe('user_set_locked', () => {
  /**
   * The account to lock, as `user.query` lists it. `unixhash`, `smbhash` and
   * `sshpubkey` are real fields of the row and are here to be kept out.
   */
  const sam = {
    id: 41,
    uid: 3010,
    username: 'sam',
    full_name: 'Sam Jones',
    local: true,
    builtin: false,
    immutable: false,
    locked: false,
    group: { id: 12, gid: 3001, name: 'projects' },
    groups: [13],
    api_keys: [7, 8],
    unixhash: '$6$salt$hash',
    smbhash: 'ABCDEF0123456789',
    sshpubkey: 'ssh-ed25519 AAAA key',
  };

  /** Every account the fake lists; it ignores the filter, as a dropped one would. */
  const accounts = [{ ...sam, id: 5, uid: 3000, username: 'someoneelse', full_name: 'Someone Else' }, sam];

  /** One privilege, granted to group 13 (`staff`). */
  const privileges = [
    { id: 1, name: 'Local Administrator', local_groups: [{ id: 1, gid: 544 }], ds_groups: [] },
    { id: 2, name: 'Ops', local_groups: [{ id: 13, gid: 3002 }], ds_groups: [] },
  ];

  /** The catalog is signed in as `admin`, uid 950. */
  const me = { pw_name: 'admin', pw_uid: 950 };

  /** What `user.update` answers with: the updated account, password fields and all. */
  const updated = { ...sam, locked: true, password: 'generated-secret' };

  const system = (overrides: Partial<Record<string, unknown>> = {}) =>
    fakeSystem({
      'user.query': accounts,
      'privilege.query': privileges,
      'auth.me': me,
      'user.update': updated,
      ...overrides,
    });

  const lock = { id: 41, locked: true };

  it('is a reversible mutating tool needing full access', () => {
    expect(userSetLocked).toMatchObject({
      name: 'user_set_locked',
      mutating: true,
      destructiveness: 'reversible',
      requiredRole: Role.Full,
    });
    expect((userSetLocked.inputSchema as { required: string[] }).required).toEqual(['id', 'locked']);
  });

  it('says a lock has not been shown to revoke API keys or sessions', () => {
    expect(userSetLocked.description).toContain(
      "WHETHER IT REVOKES THE ACCOUNT'S API KEYS OR ENDS ITS OPEN SESSIONS IS NOT ESTABLISHED",
    );
    expect(userSetLocked.resultGuidance).toContain('A LOCK HAS NOT BEEN SHOWN TO STOP THEM WORKING');
  });

  describe('argument validation', () => {
    const reject = (bad: Record<string, unknown>, message: RegExp) =>
      expect(() => userSetLocked.normalizeArgs?.(bad)).toThrow(message);

    it('requires a whole-number id and a boolean locked', () => {
      reject({ locked: true }, /"id" is required and must be a whole number/);
      reject({ id: 3.5, locked: true }, /"id" is required and must be a whole number/);
      reject({ id: '41', locked: true }, /"id" is required/);
      reject({ id: 41 }, /"locked" is required and must be a boolean/);
      reject({ id: 41, locked: 'false' }, /"locked" is required and must be a boolean/);
    });

    it('normalizes to the two arguments it takes, dropping unknown keys', () => {
      expect(userSetLocked.normalizeArgs?.({ locked: false, id: 41, systems: 'all' })).toEqual({ id: 41, locked: false });
    });
  });

  describe('the plan it returns', () => {
    it('is the read and the update, sending the locked flag alone', async () => {
      const { ctx, query } = system();
      const steps = await userSetLocked.plan(ctx, lock);
      expect(steps.map((step) => step.method)).toEqual(['user.query', 'user.update']);
      expect(steps[0].params).toEqual([[['id', '=', 41]], {}]);
      expect(query).toHaveBeenCalledWith('user.query', (steps[0].params as unknown[])[0]);
      expect(steps[1].params).toEqual([41, { locked: true }]);
    });

    it('names the account by username and full name, and its API keys', async () => {
      const [, step] = await userSetLocked.plan(system().ctx, lock);
      expect(step.description).toContain('Lock local user "sam" (full name "Sam Jones", id 41).');
      expect(step.description).toContain('It is unlocked, so this will lock it.');
      expect(step.description).toContain('It has 2 API keys.');
      expect(step.description).toContain('ENDS ITS OPEN SESSIONS IS NOT ESTABLISHED');
    });

    it('says when the account is already in the requested state, or its state is unread', async () => {
      const [, already] = await userSetLocked.plan(
        system({ 'user.query': [{ ...sam, locked: true }] }).ctx,
        lock,
      );
      expect(already.description).toContain('It is already locked, so this changes nothing and is not an error.');
      const [, unread] = await userSetLocked.plan(
        system({ 'user.query': [{ ...sam, locked: 'yes', api_keys: 'x', full_name: '' }] }).ctx,
        { id: 41, locked: false },
      );
      expect(unread.description).toContain('Unlock local user "sam" (full name (the system reported none), id 41).');
      expect(unread.description).toContain('Whether it is locked now could not be read');
      expect(unread.description).toContain('How many API keys it has could not be read.');
      expect(unread.description).not.toContain('NOT ESTABLISHED');
    });

    it('fails on an id no listed account has, comparing ids on the response', async () => {
      await expect(userSetLocked.plan(system().ctx, { id: 99, locked: true })).rejects.toThrow(
        /No user account with id 99 on this system/,
      );
      // A dropped filter returns every account; the first is not the one meant.
      const [, step] = await userSetLocked.plan(system().ctx, lock);
      expect(step.description).toContain('"sam"');
      expect(step.description).not.toContain('someoneelse');
    });

    it('fails when the account could not be read', async () => {
      const failing = failingSystem({}, { 'user.query': { reason: 'denied' } });
      await expect(userSetLocked.plan(failing.ctx, lock)).rejects.toThrow(
        'The account with id 41 could not be read (user.query failed: denied)',
      );
    });

    it('refuses a directory account, and a builtin or immutable one, naming which', async () => {
      await expect(
        userSetLocked.plan(system({ 'user.query': [{ ...sam, local: false }] }).ctx, lock),
      ).rejects.toThrow(/Account "sam" .* is not reported as a local account/);
      await expect(
        userSetLocked.plan(system({ 'user.query': [{ ...sam, builtin: true }] }).ctx, lock),
      ).rejects.toThrow(/is builtin \(builtin true\)/);
      await expect(
        userSetLocked.plan(system({ 'user.query': [{ ...sam, immutable: true }] }).ctx, { id: 41, locked: false }),
      ).rejects.toThrow(/is immutable \(immutable true\)/);
      await expect(
        userSetLocked.plan(system({ 'user.query': [{ ...sam, immutable: undefined }] }).ctx, lock),
      ).rejects.toThrow(/immutable could not be read/);
    });

    it("refuses to lock the catalog's own account, matched by username or uid", async () => {
      for (const self of [{ pw_name: 'sam', pw_uid: 1 }, { pw_name: 'other', pw_uid: 3010 }, { pw_uid: 3010 }]) {
        await expect(userSetLocked.plan(system({ 'auth.me': self }).ctx, lock)).rejects.toThrow(
          /is the account this catalog is signed in to this system as \(auth.me\), and the catalog will not lock its own account/,
        );
      }
    });

    it('refuses to lock where the signed-in account could not be read', async () => {
      const failing = failingSystem({ 'user.query': accounts }, { 'auth.me': new Error('gone') });
      await expect(userSetLocked.plan(failing.ctx, lock)).rejects.toThrow(
        /Which account this catalog is signed in as could not be read \(auth.me failed: gone\)/,
      );
      await expect(userSetLocked.plan(system({ 'auth.me': {} }).ctx, lock)).rejects.toThrow(/auth.me named no user/);
    });

    it('does not read auth.me to unlock, which cannot lock the catalog out', async () => {
      const { ctx, call } = system({ 'auth.me': { pw_name: 'sam' } });
      await userSetLocked.plan(ctx, { id: 41, locked: false });
      expect(call).not.toHaveBeenCalled();
    });

    it('names every privilege the account holds through its groups', async () => {
      const [, step] = await userSetLocked.plan(system().ctx, lock);
      expect(step.description).toContain(
        'Its groups hold 1 privilege "Ops". Locking it is understood to bar password login to an account ' +
          'holding that administrative access (unconfirmed); ITS API KEYS AND OPEN SESSIONS MAY KEEP IT.',
      );
      // The privilege sentence claims no more than the lock's reach does.
      expect(step.description).not.toMatch(/BARS THAT ADMINISTRATIVE ACCESS/i);
      // By the primary group's gid too, and unlocking says what it restores.
      const byGid = [{ id: 3, name: 'Projects Admin', local_groups: [{ gid: 3001 }] }];
      const [, unlock] = await userSetLocked.plan(system({ 'privilege.query': byGid }).ctx, { id: 41, locked: false });
      expect(unlock.description).toContain(
        'Its groups hold 1 privilege "Projects Admin". Unlocking it is understood to restore password login',
      );
      expect(unlock.description).not.toMatch(/restores that administrative access/i);
    });

    it('says none only where every group and privilege was read', async () => {
      const [, none] = await userSetLocked.plan(system({ 'privilege.query': [privileges[0]] }).ctx, lock);
      expect(none.description).toContain('None of its groups holds a privilege.');
      for (const over of [
        { 'privilege.query': [privileges[0], { id: 9, local_groups: 'x' }] },
        { 'privilege.query': [privileges[0], 'junk'] },
        { 'privilege.query': [{ id: 9, name: 'Odd', local_groups: [{ name: 'x' }] }] },
        { 'user.query': [{ ...sam, groups: undefined }], 'privilege.query': [privileges[0]] },
      ]) {
        const [, step] = await userSetLocked.plan(system(over).ctx, lock);
        expect(step.description).toContain('could not be read in full, so this plan does not say they hold none');
      }
      const [, partial] = await userSetLocked.plan(
        system({ 'privilege.query': [...privileges, { id: 9, name: 'Odd', local_groups: 'x' }] }).ctx,
        lock,
      );
      expect(partial.description).toContain('"Ops"');
      expect(partial.description).toContain('so others may be held too');
    });

    it('states rather than fails when the privileges could not be read', async () => {
      const failing = failingSystem({ 'user.query': accounts, 'auth.me': me }, { 'privilege.query': new Error('busy') });
      const [, step] = await userSetLocked.plan(failing.ctx, lock);
      expect(step.description).toContain('Whether its groups hold a privilege could not be read (privilege.query failed: busy)');
      const [, notList] = await userSetLocked.plan(system({ 'privilege.query': 1 }).ctx, lock);
      expect(notList.description).toContain('(privilege.query did not answer with a list)');
    });

    it('keeps the hashes and key out of the plan', async () => {
      const text = JSON.stringify(await userSetLocked.plan(system().ctx, lock));
      for (const secret of ['$6$salt$hash', 'ABCDEF0123456789', 'ssh-ed25519']) {
        expect(text).not.toContain(secret);
      }
    });
  });

  describe('what it reports', () => {
    it('reads, then sends exactly what the plan named', async () => {
      const { ctx, call, query } = system();
      const steps = await userSetLocked.plan(system().ctx, lock);
      await userSetLocked.execute(ctx, lock);
      expect(query).toHaveBeenCalledWith('user.query', (steps[0].params as unknown[])[0]);
      expect(call).toHaveBeenCalledTimes(1);
      expect(call).toHaveBeenCalledWith(steps[1].method, steps[1].params);
    });

    it('reports the move off the read and the response, with the API key count', async () => {
      const result = await userSetLocked.execute(system().ctx, lock);
      expect(result).toEqual({
        id: 41,
        requested_locked: true,
        lookup: 'FOUND',
        lookup_error: null,
        previously_locked: false,
        resulting_locked: true,
        changed: true,
        confirmed: true,
        api_key_count: 2,
      });
    });

    it('keeps every hash, password and key out of the result', async () => {
      const text = JSON.stringify(await userSetLocked.execute(system().ctx, lock));
      for (const secret of ['$6$salt$hash', 'ABCDEF0123456789', 'generated-secret', 'ssh-ed25519']) {
        expect(text).not.toContain(secret);
      }
      for (const key of ['unixhash', 'smbhash', 'password', 'sshpubkey']) {
        expect(text).not.toContain(`"${key}"`);
      }
    });

    it('reports an already-locked account as unchanged and confirmed', async () => {
      const result = await userSetLocked.execute(system({ 'user.query': [{ ...sam, locked: true }] }).ctx, lock);
      expect(result).toMatchObject({ previously_locked: true, resulting_locked: true, changed: false, confirmed: true });
    });

    it('reports a lock the system did not apply as unconfirmed, not as a success', async () => {
      const result = await userSetLocked.execute(system({ 'user.update': { ...updated, locked: false } }).ctx, lock);
      expect(result).toMatchObject({ resulting_locked: false, changed: false, confirmed: false });
    });

    it('updates anyway where the read fails, and reports what it could not establish', async () => {
      const failing = failingSystem({ 'user.update': { locked: true } }, { 'user.query': new Error('busy') });
      const result = await userSetLocked.execute(failing.ctx, lock);
      expect(failing.call).toHaveBeenCalledWith('user.update', [41, { locked: true }]);
      expect(result).toMatchObject({
        lookup: 'UNREADABLE',
        lookup_error: 'busy',
        previously_locked: null,
        changed: null,
        confirmed: true,
        api_key_count: null,
      });
    });
  });
});
