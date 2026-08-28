import { firstValueFrom } from 'rxjs';
import { Role } from '@/interfaces';
import { ReadOnlyTool } from '@/catalog/tool';

/**
 * The system's own health verdict. `system_info` and the storage tools describe
 * what a system *is*; this reports what it is *complaining about*, already
 * computed by the middleware rather than inferred from capacity numbers.
 */
export const alertsList: ReadOnlyTool = {
  name: 'alerts_list',
  description:
    'Active alerts a TrueNAS system has raised: severity level, alert class, ' +
    'the message, when it fired, and whether it has been dismissed. Dismissed ' +
    'alerts are still active conditions and are included.',
  inputSchema: { type: 'object', properties: {} },
  requiredRole: Role.ReadOnly,
  mutating: false,
  async handler({ system }) {
    const alerts = await firstValueFrom(system.client.api.call('alert.list'));
    return alerts.map((alert) => ({
      id: alert.id,
      // The middleware's own class identifier, e.g. `ZpoolCapacityWarning`.
      klass: alert.klass,
      level: alert.level,
      // The rendered message. Null when the middleware could not format it;
      // the raw `text` template it falls back from carries unsubstituted
      // placeholders, so it is not a useful substitute and is not surfaced.
      formatted: alert.formatted,
      datetime: alert.datetime,
      dismissed: alert.dismissed,
    }));
  },
};
