import { ToolCatalog } from '@/catalog/catalog';
import { alertsList } from '@/tools/alerts';
import { appsList } from '@/tools/apps';
import { disksList } from '@/tools/disks';
import { poolTopology, scrubHistory } from '@/tools/pools';
import { replicationStatus } from '@/tools/replication';
import { createSnapshot, snapshotsList } from '@/tools/snapshots';
import { listDatasets, poolStatus, quotaReport } from '@/tools/storage';
import { systemInfo } from '@/tools/system';

/** The sketch's catalog: eleven read-only tools plus one mutating tool. */
export function createDefaultCatalog(): ToolCatalog {
  const catalog = new ToolCatalog();
  catalog.register(systemInfo);
  catalog.register(poolStatus);
  catalog.register(poolTopology);
  catalog.register(scrubHistory);
  catalog.register(listDatasets);
  catalog.register(quotaReport);
  catalog.register(disksList);
  catalog.register(appsList);
  catalog.register(alertsList);
  catalog.register(snapshotsList);
  catalog.register(replicationStatus);
  catalog.register(createSnapshot);
  return catalog;
}

export {
  alertsList,
  appsList,
  createSnapshot,
  disksList,
  listDatasets,
  poolStatus,
  poolTopology,
  quotaReport,
  replicationStatus,
  scrubHistory,
  snapshotsList,
  systemInfo,
};
