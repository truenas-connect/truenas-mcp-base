import { ToolCatalog } from '@/catalog/catalog';
import { directoryServicesStatus, usersList } from '@/tools/accounts';
import { alertSettings, alertsList } from '@/tools/alerts';
import { appsList } from '@/tools/apps';
import { iscsiList, nvmeofList } from '@/tools/block';
import { certificatesList } from '@/tools/certificates';
import { cloudCredentialsList } from '@/tools/credentials';
import { disksList } from '@/tools/disks';
import { networkConfig, networkInterfaces } from '@/tools/network';
import { poolTopology, scrubHistory } from '@/tools/pools';
import { replicationStatus } from '@/tools/replication';
import {
  reportingAppVmUsage,
  reportingDiskIo,
  reportingSpaceTrends,
  reportingUtilisation,
} from '@/tools/reporting';
import { shareAccess, sharesList } from '@/tools/shares';
import { createSnapshot, snapshotsList } from '@/tools/snapshots';
import { listDatasets, poolStatus, quotaReport } from '@/tools/storage';
import { auditLogQuery, systemInfo, updateStatus } from '@/tools/system';
import { cloudsyncTasksList, snapshotTasksList, tasksRecentRuns } from '@/tools/tasks';
import { vmsList } from '@/tools/vms';

/** The sketch's catalog: thirty-two read-only tools plus one mutating tool. */
export function createDefaultCatalog(): ToolCatalog {
  const catalog = new ToolCatalog();
  catalog.register(systemInfo);
  catalog.register(updateStatus);
  catalog.register(auditLogQuery);
  catalog.register(poolStatus);
  catalog.register(poolTopology);
  catalog.register(scrubHistory);
  catalog.register(listDatasets);
  catalog.register(quotaReport);
  catalog.register(disksList);
  catalog.register(appsList);
  catalog.register(vmsList);
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
  catalog.register(cloudCredentialsList);
  catalog.register(alertSettings);
  catalog.register(reportingUtilisation);
  catalog.register(reportingDiskIo);
  catalog.register(reportingSpaceTrends);
  catalog.register(reportingAppVmUsage);
  catalog.register(createSnapshot);
  return catalog;
}

export {
  alertSettings,
  alertsList,
  appsList,
  auditLogQuery,
  certificatesList,
  cloudCredentialsList,
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
  reportingAppVmUsage,
  reportingDiskIo,
  reportingSpaceTrends,
  reportingUtilisation,
  scrubHistory,
  shareAccess,
  sharesList,
  snapshotsList,
  snapshotTasksList,
  systemInfo,
  tasksRecentRuns,
  updateStatus,
  usersList,
  vmsList,
};
