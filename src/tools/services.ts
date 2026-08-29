import { firstValueFrom } from 'rxjs';
import { Role } from '@/interfaces';
import { ReadOnlyTool } from '@/catalog/tool';
import { booleanOrNull, textOrNull } from '@/tools/common';

/**
 * Services family: which of the system's services are meant to run, and which
 * are running.
 *
 * Every other tool that touches a served protocol reports the CONFIGURATION and
 * stops there — `shares_list` says an SMB share exists, `iscsi_list` says a
 * target and its extents exist, `network_config` says which addresses the box
 * answers on. None of them can say whether the daemon serving any of it is up,
 * which is the first thing "why can't I reach my share?" turns on.
 *
 * `service.query` answers exactly that and nothing else: one row per service,
 * carrying whether it starts at boot and what state it is in now. The two are
 * independent facts and the interesting reading is where they disagree, so they
 * are reported as two fields and never folded into one verdict — see the
 * description.
 *
 * WHAT THIS FAMILY DELIBERATELY DOES NOT DO:
 *
 * - **It does not start, stop or restart anything.** `service.start`,
 *   `service.stop` and `service.restart` exist and are mutating; no tool here
 *   is.
 * - **It does not remap the service names.** The middleware calls SMB `cifs`
 *   and iSCSI `iscsitarget`, which is not what a person calls them, and the
 *   description carries those examples so a caller can match. A translation
 *   table here would be a second vocabulary to keep in step with TrueNAS's
 *   own, and the allowlist convention is to report what the API reports.
 * - **It does not read a service's own configuration.** `smb.config`,
 *   `nfs.config` and `ssh.config` answer a different question and are not
 *   called.
 */

/** One service, as this tool reports it. */
interface ServiceStatus {
  service: string | null;
  start_on_boot: boolean | null;
  state: string | null;
}

export const servicesStatus: ReadOnlyTool = {
  name: 'services_status',
  description:
    'Every service on a TrueNAS system, whether it is set to start at boot, ' +
    'and what state it is in right now. This is what says whether the daemon ' +
    'behind a configured share, export or target is actually up: `shares_list` ' +
    'and `iscsi_list` report what is configured, and neither reports whether ' +
    'anything is serving it. `service` IS THE MIDDLEWARE\'S OWN INTERNAL NAME ' +
    'FOR THE SERVICE, NOT THE NAME THE WEB UI SHOWS — SMB is `cifs` and iSCSI ' +
    'is `iscsitarget`, and NFS, SSH and the rest read `nfs`, `ssh` and so on. ' +
    'The names are reported exactly as the system spells them and are not ' +
    'translated, so match on the internal name rather than on the protocol as ' +
    'a person would say it. `service` is null where the system reported no ' +
    'name this tool could read, and such a row cannot be matched to a protocol ' +
    'from here. `start_on_boot` is the service\'s `enable` setting: true means ' +
    'the system is configured to start it at boot, false means it is not. IT ' +
    'IS NOT WHETHER THE SERVICE IS RUNNING. `state` is that — the run state ' +
    'the system reported, as the word the system itself used. `RUNNING` and ' +
    '`STOPPED` are the two words seen in practice, but THE SET IS NOT CLOSED: ' +
    'any other value is reported verbatim rather than coerced into one of ' +
    'those two, and a word not listed here means the system said something ' +
    'this tool has no reading of, not that the service is stopped. THE TWO ' +
    'FIELDS ARE INDEPENDENT AND THE MISMATCH IS THE POINT. `start_on_boot` ' +
    'true with a `state` that is not `RUNNING` is a service that is supposed ' +
    'to be up and is not, which is the finding worth acting on; ' +
    '`start_on_boot` false with `STOPPED` is just a service nobody turned on. ' +
    'Both fields are null where the system reported no value this tool could ' +
    'read, which is never the same as a service configured not to start or ' +
    'one that is not running — a null is a row to look at directly, not an ' +
    'answer about the service. AN EMPTY LIST IS A SYSTEM THAT REPORTED NO ' +
    'SERVICES AT ALL, not a failure to read them: a read that fails raises ' +
    'rather than returning nothing. This tool does not say WHY a service is ' +
    'not running, does not report its process ids, and does not report its ' +
    'configuration — `smb.config`, `nfs.config` and the like are a different ' +
    'question and are not read here. It does not start, stop, restart or ' +
    'change any service, or change whether one starts at boot. NO field ' +
    'beyond the three named here is returned, whatever a later TrueNAS ' +
    'release adds to a service record.',
  inputSchema: { type: 'object', properties: {} },
  requiredRole: Role.ReadOnly,
  mutating: false,
  async handler({ system }) {
    // No filters and no options: a system holds a few dozen services at most,
    // all three fields reported are part of a service row as it stands, and the
    // question this answers is about all of them rather than a named one —
    // there is nothing to bound and no option that changes how they arrive.
    const services = await firstValueFrom(system.client.api.query('service.query'));
    return services.map(
      (service): ServiceStatus => ({
        service: textOrNull(service.service),
        start_on_boot: booleanOrNull(service.enable),
        state: textOrNull(service.state),
        // `id` is a middleware row id with nothing on the other side of it to
        // join to, and `pids` is process detail that says nothing a caller
        // reasoning about availability can use — `state` already carries that.
        // Both are dropped by being absent from this allowlist rather than by
        // being removed from a copy, so a field a later release adds cannot
        // reach a caller without a change here.
      }),
    );
  },
};
