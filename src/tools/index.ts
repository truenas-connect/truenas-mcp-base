import { ToolCatalog } from '@/catalog/catalog';
import { directoryServicesStatus, privilegesList, usersList } from '@/tools/accounts';
import { alertsDismiss, alertSettings, alertsList, alertsRestore } from '@/tools/alerts';
import { appEngineStatus, appsList, appsUpdateSummary } from '@/tools/apps';
import { iscsiList, nvmeofList } from '@/tools/block';
import { bootPoolStatus } from '@/tools/boot';
import { certificatesList } from '@/tools/certificates';
import { cloudCredentialsList } from '@/tools/credentials';
import { disksList, disksTemperature } from '@/tools/disks';
import { fleetComplianceReport, fleetHealthRollup, haStatus } from '@/tools/fleet';
import { networkConfig, networkInterfaces } from '@/tools/network';
import { nfsClients } from '@/tools/nfs';
import { poolTopology, scrubHistory } from '@/tools/pools';
import { replicationStatus, replicationTopology } from '@/tools/replication';
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
import {
  auditConfig,
  auditLogQuery,
  rebootInfo,
  systemGeneralConfig,
  systemInfo,
  systemNtpStatus,
  updateStatus,
} from '@/tools/system';
import {
  automatedTaskSetEnabled,
  automatedTasksList,
  cloudsyncRun,
  cloudsyncTasksList,
  scheduledTaskSetEnabled,
  snapshotTasksList,
  tasksRecentRuns,
} from '@/tools/tasks';
import { vmDevices, vmLogs, vmsList } from '@/tools/vms';

/** The sketch's catalog: fifty-two read-only tools plus six mutating tools. */
export function createDefaultCatalog(): ToolCatalog {
  const catalog = new ToolCatalog();
  catalog.register(systemInfo);
  catalog.register(updateStatus);
  catalog.register(rebootInfo);
  catalog.register(auditLogQuery);
  catalog.register(auditConfig);
  catalog.register(securityConfig);
  catalog.register(systemGeneralConfig);
  catalog.register(systemNtpStatus);
  catalog.register(poolStatus);
  catalog.register(poolTopology);
  catalog.register(scrubHistory);
  catalog.register(bootPoolStatus);
  catalog.register(listDatasets);
  catalog.register(quotaReport);
  catalog.register(disksList);
  catalog.register(disksTemperature);
  catalog.register(appsList);
  catalog.register(appEngineStatus);
  catalog.register(appsUpdateSummary);
  catalog.register(vmsList);
  catalog.register(vmLogs);
  catalog.register(vmDevices);
  catalog.register(alertsList);
  catalog.register(snapshotsList);
  catalog.register(replicationStatus);
  catalog.register(replicationTopology);
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
  catalog.register(privilegesList);
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
  catalog.register(alertsDismiss);
  catalog.register(alertsRestore);
  catalog.register(scheduledTaskSetEnabled);
  catalog.register(cloudsyncRun);
  catalog.register(automatedTaskSetEnabled);
  return catalog;
}

export {
  alertsDismiss,
  alertSettings,
  alertsList,
  alertsRestore,
  appEngineStatus,
  appsList,
  appsUpdateSummary,
  auditConfig,
  auditLogQuery,
  automatedTaskSetEnabled,
  automatedTasksList,
  bootPoolStatus,
  certificatesList,
  cloudCredentialsList,
  cloudsyncRun,
  cloudsyncTasksList,
  createSnapshot,
  directoryServicesStatus,
  disksList,
  disksTemperature,
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
  privilegesList,
  quotaReport,
  rebootInfo,
  replicationStatus,
  replicationTopology,
  reportingAppVmUsage,
  reportingDiskIo,
  reportingSpaceTrends,
  reportingUtilisation,
  scheduledTaskSetEnabled,
  scrubHistory,
  securityConfig,
  servicesStatus,
  shareAccess,
  sharesList,
  snapshotsList,
  snapshotTasksList,
  systemGeneralConfig,
  systemHealthReport,
  systemInfo,
  systemNtpStatus,
  tasksRecentRuns,
  updateStatus,
  usersList,
  vmDevices,
  vmLogs,
  vmsList,
};
