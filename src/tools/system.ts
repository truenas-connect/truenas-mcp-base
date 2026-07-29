import { TrueNasEndpoint } from '@truenas/api-client';
import { firstValueFrom } from 'rxjs';
import { Role } from '@/interfaces';
import { ReadOnlyTool } from '@/catalog/tool';

/**
 * Grounds the LLM on what it is talking to — version, hostname, hardware —
 * before it reasons about anything else.
 */
export const systemInfo: ReadOnlyTool = {
  name: 'system_info',
  description:
    'Basic information about a TrueNAS system: hostname, version, uptime, ' +
    'hardware model, CPU and memory.',
  inputSchema: { type: 'object', properties: {} },
  requiredRole: Role.ReadOnly,
  mutating: false,
  async handler({ system }) {
    const info = await firstValueFrom(system.client.api.call(TrueNasEndpoint.SystemInfo));
    return {
      hostname: info.hostname,
      version: info.version,
      uptime: info.uptime,
      model: info.model,
      cores: info.cores,
      physical_cores: info.physical_cores,
      memory_bytes: info.physmem,
      timezone: info.timezone,
    };
  },
};
