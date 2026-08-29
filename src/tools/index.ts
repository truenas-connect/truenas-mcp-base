import { ToolCatalog } from '@/catalog/catalog';
import { directoryServicesStatus, usersList } from '@/tools/accounts';
import { alertsList } from '@/tools/alerts';
import { appsList } from '@/tools/apps';
import { iscsiList, nvmeofList } from '@/tools/block';
import { certificatesList } from '@/tools/certificates';
import { disksList } from '@/tools/disks';
import { networkConfig, networkInterfaces } from '@/tools/network';
import { poolTopology, scrubHistory } from '@/tools/pools';
import { replicationStatus } from '@/tools/replication';
import { shareAccess, sharesList } from '@/tools/shares';
import { createSnapshot, snapshotsList } from '@/tools/snapshots';
import { listDatasets, poolStatus, quotaReport } from '@/tools/storage';
import { systemInfo } from '@/tools/system';
import { cloudsyncTasksList, snapshotTasksList, tasksRecentRuns } from '@/tools/tasks';

/** The sketch's catalog: twenty-three read-only tools plus one mutating tool. */
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
  catalog.register(snapshotTasksList);
  catalog.register(cloudsyncTasksList);
  catalog.register(tasksRecentRuns);
  catalog.register(sharesList);
  catalog.register(shareAccess);
  catalog.register(iscsiList);
  catalog.register(nvmeofList);
  catalog.register(usersList);
  catalog.register(directoryServicesStatus);
  catalog.register(networkInterfaces);
  catalog.register(networkConfig);
  catalog.register(certificatesList);
  catalog.register(createSnapshot);
  return catalog;
}

export {
  alertsList,
  appsList,
  certificatesList,
  cloudsyncTasksList,
  createSnapshot,
  directoryServicesStatus,
  disksList,
  iscsiList,
  listDatasets,
  networkConfig,
  networkInterfaces,
  nvmeofList,
  poolStatus,
  poolTopology,
  quotaReport,
  replicationStatus,
  scrubHistory,
  shareAccess,
  sharesList,
  snapshotsList,
  snapshotTasksList,
  systemInfo,
  tasksRecentRuns,
  usersList,
};
