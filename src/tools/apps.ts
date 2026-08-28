import { firstValueFrom } from 'rxjs';
import { Role } from '@/interfaces';
import { ReadOnlyTool } from '@/catalog/tool';

/** Applications installed on a system: what is deployed, what is running, and
 * what has an update waiting.
 *
 * Nothing else in the catalog knows an application exists, so "what is running
 * on this box" and "is anything out of date" are unanswerable without it — and
 * apps are where a home or small-business TrueNAS spends most of its
 * operational attention.
 *
 * The mapping is an allowlist rather than a trim, and here that is about size
 * rather than secrecy: an `app.query` row carries the app's full chart
 * metadata, its rendered portals, its `config` (the values the user filled in
 * at install time) and `active_workloads` — every container, port and volume.
 * Passing that through would make this the most expensive response in the
 * catalog, so naming the fields is the point of the tool rather than a nicety.
 */

export const appsList: ReadOnlyTool = {
  name: 'apps_list',
  description:
    'Applications installed on a TrueNAS system: name, installed version, ' +
    'running state, and whether an update is waiting. Apps that are not ' +
    'running are included — `state` distinguishes STOPPED from CRASHED, and ' +
    'from the transient DEPLOYING and STOPPING. `upgrade_available` means a ' +
    'newer catalog version exists (`latest_version` names it, and is null ' +
    'when the system does not know of one); `image_updates_available` is the ' +
    'separate question of whether the containers the app already runs have ' +
    'newer images, which is the only kind of update a custom app can have.',
  inputSchema: { type: 'object', properties: {} },
  requiredRole: Role.ReadOnly,
  mutating: false,
  async handler({ system }) {
    const apps = await firstValueFrom(system.client.api.query('app.query'));
    return apps.map((app) => ({
      name: app.name,
      // The catalog version of the app as installed. `human_version` is the
      // middleware's display string for the same thing and is deliberately
      // not surfaced: it splices the upstream software's version onto this
      // one, so the two read as disagreeing, and only `version` is comparable
      // with `latest_version`.
      version: app.version,
      latest_version: app.latest_version,
      state: app.state,
      upgrade_available: app.upgrade_available,
      image_updates_available: app.image_updates_available,
    }));
  },
};
