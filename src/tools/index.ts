import { ToolCatalog } from '@/catalog/catalog';
import { directoryServicesStatus, usersList } from '@/tools/accounts';
import { alertSettings, alertsList } from '@/tools/alerts';
import { appsList } from '@/tools/apps';
import { iscsiList, nvmeofList } from '@/tools/block';
import { bootPoolStatus } from '@/tools/boot';
import { certificatesList } from '@/tools/certificates';
import { cloudCredentialsList } from '@/tools/credentials';
import { disksList } from '@/tools/disks';
import { fleetComplianceReport, fleetHealthRollup, haStatus } from '@/tools/fleet';
import { networkConfig, networkInterfaces } from '@/tools/network';
import { nfsClients } from '@/tools/nfs';
import { poolTopology, scrubHistory } from '@/tools/pools';
import { replicationStatus } from '@/tools/replication';
import {
  reportingAppVmUsage,
  reportingDiskIo,
  reportingSpaceTrends,
  reportingUtilisation,
  systemHealthReport,
} from '@/tools/reporting';
import { securityConfig } from '@/tools/security';
import { servicesStatus } from '@/tools/services';
import { shareAccess, sharesList } from '@/tools/shares';
import { createSnapshot, snapshotsList } from '@/tools/snapshots';
import { listDatasets, poolStatus, quotaReport } from '@/tools/storage';
import { auditConfig, auditLogQuery, rebootInfo, systemInfo, updateStatus } from '@/tools/system';
import {
  automatedTasksList,
  cloudsyncTasksList,
  snapshotTasksList,
  tasksRecentRuns,
} from '@/tools/tasks';
import { vmLogs, vmsList } from '@/tools/vms';

/** The sketch's catalog: forty-four read-only tools plus one mutating tool. */
export function createDefaultCatalog(): ToolCatalog {
  const catalog = new ToolCatalog();
  catalog.register(systemInfo);
  catalog.register(updateStatus);
  catalog.register(rebootInfo);
  catalog.register(auditLogQuery);
  catalog.register(auditConfig);
  catalog.register(securityConfig);
  catalog.register(poolStatus);
  catalog.register(poolTopology);
  catalog.register(scrubHistory);
  catalog.register(bootPoolStatus);
  catalog.register(listDatasets);
  catalog.register(quotaReport);
  catalog.register(disksList);
  catalog.register(appsList);
  catalog.register(vmsList);
  catalog.register(vmLogs);
  catalog.register(alertsList);
  catalog.register(snapshotsList);
  catalog.register(replicationStatus);
  catalog.register(snapshotTasksList);
  catalog.register(cloudsyncTasksList);
  catalog.register(automatedTasksList);
  catalog.register(tasksRecentRuns);
  catalog.register(sharesList);
  catalog.register(shareAccess);
  catalog.register(nfsClients);
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
  catalog.register(servicesStatus);
  catalog.register(haStatus);
  catalog.register(systemHealthReport);
  catalog.register(fleetComplianceReport);
  catalog.register(fleetHealthRollup);
  catalog.register(createSnapshot);
  return catalog;
}

export {
  alertSettings,
  alertsList,
  appsList,
  auditConfig,
  auditLogQuery,
  automatedTasksList,
  bootPoolStatus,
  certificatesList,
  cloudCredentialsList,
  cloudsyncTasksList,
  createSnapshot,
  directoryServicesStatus,
  disksList,
  fleetComplianceReport,
  fleetHealthRollup,
  haStatus,
  iscsiList,
  listDatasets,
  networkConfig,
  networkInterfaces,
  nfsClients,
  nvmeofList,
  poolStatus,
  poolTopology,
  quotaReport,
  rebootInfo,
  replicationStatus,
  reportingAppVmUsage,
  reportingDiskIo,
  reportingSpaceTrends,
  reportingUtilisation,
  scrubHistory,
  securityConfig,
  servicesStatus,
  shareAccess,
  sharesList,
  snapshotsList,
  snapshotTasksList,
  systemHealthReport,
  systemInfo,
  tasksRecentRuns,
  updateStatus,
  usersList,
  vmLogs,
  vmsList,
};
