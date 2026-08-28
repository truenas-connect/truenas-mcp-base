import { firstValueFrom } from 'rxjs';
import { Role } from '@/interfaces';
import { ReadOnlyTool } from '@/catalog/tool';

/** Hardware inventory: the physical disks under the pools.
 *
 * `storage_pool_status` reports pools as units and says nothing about the
 * devices beneath them, so "which disks are there", "what is unassigned" and
 * "which model and size is each" have no inventory to reason over without this.
 *
 * Physical placement is not among them: `enclosure` (the shelf and slot a disk
 * sits in) is dropped, so this cannot answer "do I have a spare bay". It
 * answers the weaker "do I have an unassigned disk", via `pool`.
 *
 * The mapping below is an allowlist rather than a trim, which matters more here
 * than for the other read-only tools: a `disk.query` row carries the SED
 * passphrase (`passwd`) and its KMIP key id, and naming the output fields
 * explicitly is what keeps them out of the tool result and so out of the
 * conversation. Serial numbers are identifying but not secret, and are response
 * data rather than arguments, so the "no secrets as arguments" rule in
 * `catalog/tool.ts` is not in play.
 */

export const disksList: ReadOnlyTool = {
  name: 'disks_list',
  description:
    'Physical disks attached to a TrueNAS system: device name, model, serial ' +
    'number, size in bytes, media type (HDD/SSD) and transfer mode, plus which ' +
    'ZFS pool each disk belongs to. `pool` is null when the disk belongs to no ' +
    'pool; the field is absent entirely when the system did not report pool ' +
    'membership, which is not the same as the disk being unassigned.',
  inputSchema: { type: 'object', properties: {} },
  requiredRole: Role.ReadOnly,
  mutating: false,
  async handler({ system }) {
    const disks = await firstValueFrom(
      // Filters and options are inlined so the call's own parameter types
      // apply, as in storage.ts. `extra.pools` is what makes the middleware
      // attach each disk's owning pool; the client types `extra` as an open
      // `Record<string, unknown>`, so it carries the key without confirming
      // it — which is why the mapping below treats an absent `pool` as its
      // own state rather than assuming the request was honoured.
      system.client.api.query('disk.query', [], { extra: { pools: true } }),
    );
    return disks.map((disk) => ({
      name: disk['name'],
      model: disk['model'],
      serial: disk['serial'],
      size_bytes: disk['size'],
      // Two distinct fields the middleware happens to name similarly: `type`
      // is the medium (HDD/SSD), `transfermode` is the link mode (e.g. Auto,
      // SATA300).
      type: disk['type'],
      transfermode: disk['transfermode'],
      // Spread rather than assigned: `pool: undefined` and no `pool` key are
      // the same after JSON serialization but not to a caller reading the
      // object, and the two states this has to keep apart are "in no pool"
      // (null) and "membership not reported" (absent).
      ...('pool' in disk ? { pool: disk['pool'] } : {}),
    }));
  },
};
