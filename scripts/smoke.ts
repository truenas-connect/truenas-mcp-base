/**
 * Manual smoke test against a live TrueNAS system. Not part of the test suite.
 *
 *   TRUENAS_HOST=nas.local TRUENAS_USERNAME=admin TRUENAS_API_KEY=... yarn smoke
 *   TRUENAS_HOST=nas.local TRUENAS_USERNAME=admin TRUENAS_PASSWORD=... yarn smoke
 *
 * Optional:
 *   SMOKE_SNAPSHOT_DATASET=tank/some/dataset   also exercise plan/confirm by
 *                                              creating a real snapshot there
 *   NODE_TLS_REJECT_UNAUTHORIZED=0             needed for self-signed certs
 *
 * Exercises: connect + auth, the three read-only tools, and (opt-in) the full
 * two-phase plan/confirm flow for snapshots_create.
 *
 * Password auth is a smoke-script convenience only — the core stays API-key
 * only (ER-172 A2.5), so the password path injects its own ClientFactory.
 */

import { createTrueNasClient } from '@truenas/api-client';
import { firstValueFrom } from 'rxjs';
import {
  ClientFactory,
  ConfirmationService,
  connectSystems,
  consoleAuditSink,
  createDefaultCatalog,
  SystemRegistry,
  ToolExecutor,
} from '../src/index';

const host = process.env['TRUENAS_HOST'];
const username = process.env['TRUENAS_USERNAME'];
const apiKey = process.env['TRUENAS_API_KEY'];
const password = process.env['TRUENAS_PASSWORD'];
if (!host || !username || (!apiKey && !password)) {
  console.error(
    'Set TRUENAS_HOST, TRUENAS_USERNAME and either TRUENAS_API_KEY or TRUENAS_PASSWORD',
  );
  process.exit(1);
}

// Fail fast on unreachable hosts and self-signed certificates — the client's
// connection layer would otherwise retry forever and the script appears to hang.
try {
  await fetch(`https://${host}/api/versions`, { signal: AbortSignal.timeout(10_000) });
} catch (error) {
  const cause = error instanceof Error ? (error.cause ?? error) : error;
  console.error(`Cannot reach https://${host}/api/versions: ${String(cause)}`);
  if (String(cause).includes('self-signed') || String(cause).includes('self signed')) {
    console.error('Self-signed certificate — rerun with NODE_TLS_REJECT_UNAUTHORIZED=0');
  }
  process.exit(1);
}

const registry = new SystemRegistry();
const confirmations = new ConfirmationService();
const executor = new ToolExecutor({
  catalog: createDefaultCatalog(),
  registry,
  confirmations,
  audit: consoleAuditSink,
});

function show(label: string, value: unknown): void {
  console.log(`\n=== ${label} ===`);
  console.log(JSON.stringify(value, null, 2));
}

// Same shape as the core's defaultClientFactory, but authenticating with
// username/password instead of an API key.
const passwordClientFactory: ClientFactory = async (spec) => {
  const client = await createTrueNasClient({
    uuid: spec.name,
    hostnames: spec.hostnames,
    enabled: true,
    systemName: spec.name,
  });
  try {
    const response = await firstValueFrom(
      client.authenticator.loginWithUserPass(spec.username, password as string),
    );
    if (String(response.response_type) !== 'SUCCESS') {
      throw new Error(`Authentication failed (${response.response_type})`);
    }
  } catch (error) {
    client.close();
    throw error;
  }
  return client;
};

try {
  await connectSystems(
    registry,
    {
      getSystems: async () => [
        { name: 'smoke', hostnames: [host], username, apiKey: apiKey ?? '' },
      ],
    },
    apiKey ? undefined : passwordClientFactory,
  );
  console.log(`Connected and authenticated to ${host} (${apiKey ? 'API key' : 'password'})`);

  show('system_info', await executor.execute('system_info'));
  show('storage_pool_status', await executor.execute('storage_pool_status'));
  show('storage_list_datasets', await executor.execute('storage_list_datasets'));

  const dataset = process.env['SMOKE_SNAPSHOT_DATASET'];
  if (dataset) {
    const name = `mcp-smoke-${new Date().toISOString().replaceAll(/[:.]/g, '-')}`;
    const args = { dataset, name };

    const outcome = await executor.execute('snapshots_create', args);
    show('snapshots_create (plan phase)', outcome);
    if (outcome.type !== 'PLAN') {
      throw new Error('expected a plan');
    }

    // In a real adapter this mint happens only on user approval in the host UI.
    const token = confirmations.mint(outcome.key);
    show(
      'snapshots_create (execute phase)',
      await executor.execute('snapshots_create', { ...args, confirmation_token: token }),
    );
  } else {
    console.log('\nSMOKE_SNAPSHOT_DATASET not set — skipping the plan/confirm flow');
  }
} finally {
  registry.closeAll();
}
