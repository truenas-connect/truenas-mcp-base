import { ApiCallParams, TrueNasEndpoint } from '@truenas/api-client';
import { firstValueFrom } from 'rxjs';
import { Role } from '@/interfaces';
import { MutatingTool, ToolContext } from '@/catalog/tool';

/**
 * The one mutating tool in the sketch — exists to exercise the two-phase
 * plan/confirm flow end to end. Snapshot creation is cheap and reversible
 * (snapshots can be deleted), making it the safest possible mutation.
 */

interface SnapshotArgs {
  dataset: string;
  name: string;
  recursive: boolean;
}

function parseArgs(args: Record<string, unknown>): SnapshotArgs {
  const dataset = args['dataset'];
  const name = args['name'];
  if (typeof dataset !== 'string' || dataset.length === 0) {
    throw new Error('"dataset" is required');
  }
  if (typeof name !== 'string' || name.length === 0) {
    throw new Error('"name" is required');
  }
  // Strict: silently coercing "true" or 1 to false would create a flat
  // snapshot the user approved as recursive (or vice versa) — the plan and
  // the execution must stay honestly aligned.
  const recursive = args['recursive'];
  if (recursive != null && typeof recursive !== 'boolean') {
    throw new Error('"recursive" must be a boolean');
  }
  return { dataset, name, recursive: recursive === true };
}

function createParams(args: SnapshotArgs): ApiCallParams<TrueNasEndpoint.SnapshotCreate> {
  return [{ dataset: args.dataset, name: args.name, recursive: args.recursive }];
}

/**
 * Plan-time existence check. Advisory by design: execute deliberately does
 * not re-check (the "pure function of (args, system)" contract), so a dataset
 * deleted between approval and confirm surfaces as a safe API error at
 * execute time.
 */
async function assertDatasetExists(ctx: ToolContext, dataset: string): Promise<void> {
  const matches = await firstValueFrom(
    ctx.system.client.api.call(TrueNasEndpoint.DatasetQuery, [
      [['id', '=', dataset]],
      { extra: { retrieve_children: false, properties: ['used'] } },
    ]),
  );
  if (matches.length === 0) {
    throw new Error(`Dataset "${dataset}" does not exist`);
  }
}

export const createSnapshot: MutatingTool = {
  name: 'snapshots_create',
  description:
    'Creates a ZFS snapshot of a dataset. Two-phase: called without a ' +
    'confirmation_token it returns a plan for user approval; called with one ' +
    'it creates the snapshot.',
  inputSchema: {
    type: 'object',
    properties: {
      dataset: {
        type: 'string',
        description: 'Dataset to snapshot, e.g. "tank/media".',
      },
      name: {
        type: 'string',
        description: 'Snapshot name, e.g. "before-cleanup".',
      },
      recursive: {
        type: 'boolean',
        description: 'Also snapshot child datasets. Default false.',
      },
    },
    required: ['dataset', 'name'],
  },
  requiredRole: Role.Full,
  mutating: true,
  destructiveness: 'reversible',
  normalizeArgs(rawArgs) {
    const args = parseArgs(rawArgs);
    return { dataset: args.dataset, name: args.name, recursive: args.recursive };
  },
  async plan(ctx, rawArgs) {
    const args = parseArgs(rawArgs);
    await assertDatasetExists(ctx, args.dataset);
    return [
      {
        method: TrueNasEndpoint.SnapshotCreate,
        params: createParams(args),
        description:
          `Create snapshot "${args.dataset}@${args.name}"` +
          (args.recursive ? ' recursively (including child datasets)' : ''),
      },
    ];
  },
  async execute(ctx, rawArgs) {
    const args = parseArgs(rawArgs);
    const snapshot = await firstValueFrom(
      ctx.system.client.api.call(TrueNasEndpoint.SnapshotCreate, createParams(args)),
    );
    return { created: snapshot.name };
  },
};
