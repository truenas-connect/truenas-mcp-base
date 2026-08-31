import { describe, expect, it } from 'vitest';
import { Role } from '@/interfaces';
import { fakeSystem, failingSystem } from '@/testing/fake-systems';
import { upsConfig } from '@/tools/index';

/**
 * Its own spec rather than a block in `system.spec.ts`, per #87's split
 * trigger: that file was 1,348 lines and this block is around 300, so the
 * merged file would be about 1,650 and the exception is met. The other six
 * tools in `system.ts` stay where they are — the split is by tool, and
 * re-homing tests this ticket did not touch is a separate change (#121).
 */
describe('ups_config', () => {
  /**
   * A UPS configuration as `ups.config` reports one.
   *
   * Every field the pinned `UPSEntry` declares is here, including the four the
   * tool must never report: the tests below turn on what is absent from the
   * result, and a fixture that omitted them could not tell a boundary that
   * holds from one that was never exercised.
   */
  const config = (over: Record<string, unknown> = {}) => ({
    id: 1,
    powerdown: true,
    rmonitor: false,
    nocommwarntime: 300,
    remoteport: 3493,
    shutdowntimer: 30,
    hostsync: 15,
    description: 'rack UPS',
    driver: 'usbhid-ups',
    extrausers: 'watcher\npassword = extrausers-secret\n',
    identifier: 'ups',
    mode: 'MASTER',
    monpwd: 'monpwd-secret',
    monuser: 'upsmon',
    options: 'community=options-secret',
    optionsupsd: 'LISTEN 0.0.0.0 3493',
    port: '/dev/ttyUSB0',
    remotehost: '',
    shutdown: 'BATT',
    shutdowncmd: '/sbin/shutdown -h now',
    complete_identifier: 'ups@localhost:3493',
    ...over,
  });

  const reported = async (payload: unknown): Promise<Record<string, unknown>> => {
    const { ctx } = fakeSystem({ ['ups.config']: payload });
    return (await upsConfig.handler(ctx, {})) as Record<string, unknown>;
  };

  /** One configuration, differing only in the fields the case is about. */
  const one = async (over: Record<string, unknown>): Promise<Record<string, unknown>> =>
    reported(config(over));

  it('maps a configuration to the shutdown behaviour the tool exists for', async () => {
    expect(await reported(config())).toEqual({
      mode: 'MASTER',
      shutdown: 'BATT',
      shutdown_timer: 30,
      shutdown_command: '/sbin/shutdown -h now',
      powerdown: true,
      no_communication_warn_time: 300,
      identifier: 'ups',
      description: 'rack UPS',
      driver: 'usbhid-ups',
      port: '/dev/ttyUSB0',
      // The system reported empty text, which names no host a caller could
      // reach, so it reads as no value rather than as a host of no characters.
      remote_host: null,
      remote_port: 3493,
    });
  });

  it('carries no field the tool does not name, including one a later release adds', async () => {
    const result = await one({ upsmon_options: 'added by a later release' });
    expect(Object.keys(result)).toEqual([
      'mode',
      'shutdown',
      'shutdown_timer',
      'shutdown_command',
      'powerdown',
      'no_communication_warn_time',
      'identifier',
      'description',
      'driver',
      'port',
      'remote_host',
      'remote_port',
    ]);
  });

  it('never reports the UPS monitor password, in any form', async () => {
    // The acceptance criterion this tool turns on, and the reason the mapping
    // is an allowlist rather than a trim: a tool result is recorded verbatim in
    // the audit trail, so `monpwd` reaching one writes a credential into the
    // trail on every call. Asserted here so that a later edit widening the
    // mapping cannot reintroduce it silently.
    const result = await one({ monpwd: 'monpwd-secret' });
    expect(result).not.toHaveProperty('monpwd');
    expect(JSON.stringify(result)).not.toContain('monpwd-secret');
    // Not reported as WHETHER one is set either, which is #100's answer for the
    // display password and is taken here deliberately rather than by omission.
    expect(Object.keys(result).join(' ')).not.toContain('password');
    expect(Object.keys(result).join(' ')).not.toContain('monpwd');
    // A password of no characters must not turn into a reported field either —
    // the absence is of the field, not of the value.
    expect(await one({ monpwd: '' })).not.toHaveProperty('monpwd');
  });

  it('reports neither half of the monitor credential, nor the daemon user configuration', async () => {
    // `monuser` is a username rather than a secret and could be reported; it is
    // left out so that both halves of one credential are outside the boundary
    // rather than either side of it. `extrausers` is free-form `upsd` user
    // configuration and is where further monitoring credentials are written.
    const result = await one({});
    expect(result).not.toHaveProperty('monuser');
    expect(result).not.toHaveProperty('extrausers');
    expect(JSON.stringify(result)).not.toContain('upsmon');
    expect(JSON.stringify(result)).not.toContain('extrausers-secret');
  });

  it('reports neither option string, which is where a device credential gets inlined', async () => {
    const result = await one({});
    expect(result).not.toHaveProperty('options');
    expect(result).not.toHaveProperty('optionsupsd');
    expect(JSON.stringify(result)).not.toContain('options-secret');
    expect(JSON.stringify(result)).not.toContain('LISTEN');
  });

  it('reports no field whose meaning the API states nowhere, and no row id', async () => {
    // `rmonitor` and `hostsync` are the `ds_auth` case (#102) — a bare boolean
    // and a bare number the pinned surface declares and documents nowhere — and
    // `complete_identifier` is the same rule one step in, declared with nothing
    // saying what it is complete relative to. `id` is a middleware row id, which
    // nothing in this catalog takes: `ups.update` is mutating and is not here.
    const result = await one({ id: 7, hostsync: 15, complete_identifier: 'ups@localhost:3493' });
    for (const dropped of ['rmonitor', 'hostsync', 'complete_identifier', 'id']) {
      expect(result).not.toHaveProperty(dropped);
    }
    expect(JSON.stringify(result)).not.toContain('ups@localhost');
    expect(JSON.stringify(result)).not.toContain('7');
  });

  it('reads an unreported powerdown as null and never as false', async () => {
    // A null is not the system declining to cut the UPS afterwards — nothing
    // has been established about it.
    expect(await one({ powerdown: true })).toMatchObject({ powerdown: true });
    expect(await one({ powerdown: false })).toMatchObject({ powerdown: false });
    for (const unreadable of [undefined, null, 'true', 1, {}]) {
      expect(await one({ powerdown: unreadable })).toMatchObject({ powerdown: null });
    }
  });

  it('reports both timers as the bare numbers they arrive as, keeping a zero', async () => {
    // No unit is carried in either name, per #96: the API declares none, and a
    // suffix is a claim a caller converts on.
    expect(await one({ shutdowntimer: 0, nocommwarntime: 0 })).toMatchObject({
      shutdown_timer: 0,
      no_communication_warn_time: 0,
    });
    for (const unreadable of [undefined, null, '30', Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(await one({ shutdowntimer: unreadable })).toMatchObject({ shutdown_timer: null });
      expect(await one({ nocommwarntime: unreadable })).toMatchObject({
        no_communication_warn_time: null,
      });
      expect(await one({ remoteport: unreadable })).toMatchObject({ remote_port: null });
    }
  });

  it('collapses the explicit null the payload uses into the same unreadable answer', async () => {
    // `nocommwarntime` and `shutdowncmd` are the two fields declared nullable,
    // so on each the system CAN say it recorded no value — and nothing in this
    // result separates that from a value this tool could not read. The
    // description says so rather than offering a companion field for a
    // distinction a caller would not act on differently (#134).
    for (const unreadable of [null, 'soon']) {
      expect(await one({ nocommwarntime: unreadable })).toMatchObject({
        no_communication_warn_time: null,
      });
    }
    for (const unreadable of [null, 7]) {
      expect(await one({ shutdowncmd: unreadable })).toMatchObject({ shutdown_command: null });
    }
  });

  it('nulls text it could not read, including text of no characters', async () => {
    for (const field of [
      ['mode', 'mode'],
      ['shutdown', 'shutdown'],
      ['shutdowncmd', 'shutdown_command'],
      ['identifier', 'identifier'],
      ['description', 'description'],
      ['driver', 'driver'],
      ['port', 'port'],
      ['remotehost', 'remote_host'],
    ] as const) {
      const [sent, reportedAs] = field;
      for (const unreadable of [undefined, null, '', 7, {}]) {
        expect(await one({ [sent]: unreadable })).toMatchObject({ [reportedAs]: null });
      }
    }
  });

  it('passes a mode or a shutdown condition through as the system spelled it', async () => {
    // Both are reported as values rather than mapped through a table, so a
    // value outside the declared pair is answerable without a change here —
    // `ApiSurface` is the oldest supported directory (#101) and a later TrueNAS
    // can send a third.
    expect(await one({ mode: 'SLAVE', shutdown: 'LOWBATT' })).toMatchObject({
      mode: 'SLAVE',
      shutdown: 'LOWBATT',
    });
    expect(await one({ mode: 'ARBITER', shutdown: 'ONBATT' })).toMatchObject({
      mode: 'ARBITER',
      shutdown: 'ONBATT',
    });
  });

  it('reads the remote end as what the configuration records, not as a fact about the mode', async () => {
    // Nothing in the payload ties `remotehost`/`remoteport` to `mode`, so
    // neither is grouped under it: grouping fields under a discriminator the
    // surface does not state is the refusal `automated_tasks_list` makes about
    // an rsync task's remote end.
    expect(await one({ mode: 'MASTER', remotehost: 'peer.example.invalid' })).toMatchObject({
      mode: 'MASTER',
      remote_host: 'peer.example.invalid',
      remote_port: 3493,
    });
    expect(await one({ mode: 'SLAVE', remotehost: '', remoteport: undefined })).toMatchObject({
      mode: 'SLAVE',
      remote_host: null,
      remote_port: null,
    });
  });

  it('reads a system that has never been set up as the ordinary case, not a fault', async () => {
    // `ups.config` answers with a full configuration whether or not a UPS
    // exists, and no field of it says which — so a defaults-shaped payload is
    // the normal answer and must not read as a failed read.
    const untouched = await reported({
      id: 1,
      powerdown: false,
      rmonitor: false,
      nocommwarntime: null,
      remoteport: 3493,
      shutdowntimer: 30,
      hostsync: 15,
      description: '',
      driver: '',
      extrausers: '',
      identifier: 'ups',
      mode: 'MASTER',
      monpwd: 'fixmepass',
      monuser: 'upsmon',
      options: '',
      optionsupsd: '',
      port: '',
      remotehost: '',
      shutdown: 'BATT',
      shutdowncmd: null,
      complete_identifier: '',
    });
    expect(untouched).toEqual({
      mode: 'MASTER',
      shutdown: 'BATT',
      shutdown_timer: 30,
      shutdown_command: null,
      powerdown: false,
      no_communication_warn_time: null,
      identifier: 'ups',
      description: null,
      driver: null,
      port: null,
      remote_host: null,
      remote_port: 3493,
    });
    expect(JSON.stringify(untouched)).not.toContain('fixmepass');
  });

  it('fails rather than answering nulls when the payload is not a configuration', async () => {
    // Guarded rather than reached into, for the reason `audit_config` gives: a
    // result of nulls would read as a system that reported a configuration and
    // filled none of it in, which is exactly the ordinary unconfigured answer
    // above and is not what happened.
    for (const answer of [null, undefined, 'ups', 7, []]) {
      await expect(reported(answer)).rejects.toThrow(
        'ups.config did not answer with a UPS configuration',
      );
    }
  });

  it('fails rather than answering nulls when the read could not be made', async () => {
    const { ctx } = failingSystem({}, { ['ups.config']: new Error('connection reset') });
    await expect(upsConfig.handler(ctx, {})).rejects.toThrow('connection reset');
  });

  it('states that it does not establish a UPS is attached', async () => {
    // The tool's central limitation lives in prose, and prose is one edit away
    // from being undone — so the claim is pinned here (#128).
    expect(upsConfig.description).toContain('THIS IS THE CONFIGURATION AND NOTHING ELSE');
    expect(upsConfig.description).toContain('WHETHER OR NOT A UPS HAS EVER BEEN SET UP');
    expect(upsConfig.description).toContain('THE UPS MONITOR PASSWORD IS NOT RETURNED');
    // And that `shutdown_command` is operator-supplied text, which is the
    // condition #97 attaches to passing such a field through at all — and that
    // its null is not evidence the system runs no command, since the payload
    // declares the field nullable and the two causes collapse.
    expect(upsConfig.description).toContain('IT IS OPERATOR-SUPPLIED TEXT');
    expect(upsConfig.description).toContain(
      'A null `shutdown_command` is therefore NOT evidence that the system runs no command',
    );
  });

  it('asks for the configuration, and never mutates', async () => {
    const { ctx, call, query } = fakeSystem({ ['ups.config']: config() });
    await upsConfig.handler(ctx, {});
    expect(call).toHaveBeenCalledWith('ups.config');
    expect(query).not.toHaveBeenCalled();
    expect(upsConfig.mutating).toBe(false);
    expect(upsConfig.requiredRole).toBe(Role.ReadOnly);
  });
});
