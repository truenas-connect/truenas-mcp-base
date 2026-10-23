import { ToolCatalog } from '@/catalog/catalog';
import {
  directoryServicesStatus,
  privilegesList,
  userCreate,
  userSetLocked,
  usersList,
} from '@/tools/accounts';
import { alertClassSet, alertsDismiss, alertSettings, alertsList, alertsRestore } from '@/tools/alerts';
import { appEngineStatus, appRollback, appsList, appsUpdateSummary, appUpgrade } from '@/tools/apps';
import {
  fcList,
  iscsiList,
  iscsiTargetCreate,
  iscsiTargetUpdate,
  nvmeofList,
  nvmeofSubsystemCreate,
  nvmeofSubsystemUpdate,
} from '@/tools/block';
import { bootPoolStatus } from '@/tools/boot';
import { certificateCsrCreate, certificatesList } from '@/tools/certificates';
import {
  containerList,
  containerRestart,
  containerStart,
  containerStop,
} from '@/tools/containers';
import { cloudCredentialsList } from '@/tools/credentials';
import { diskIdentify, disksList, disksTemperature } from '@/tools/disks';
import { fleetComplianceReport, fleetHealthRollup, haStatus } from '@/tools/fleet';
import { networkConfig, networkInterfaces } from '@/tools/network';
import { nfsClients } from '@/tools/nfs';
import {
  poolDeviceSetOnline,
  poolResilverConfig,
  poolScrubTaskCreate,
  poolScrubTasksList,
  poolScrubTaskUpdate,
  poolTopology,
  scrubHistory,
} from '@/tools/pools';
import { replicationStatus, replicationTopology } from '@/tools/replication';
import {
  reportingAppVmUsage,
  reportingDiskIo,
  reportingSpaceTrends,
  reportingUtilisation,
  systemHealthReport,
} from '@/tools/reporting';
import { securityConfig } from '@/tools/security';
import { serviceControl, servicesStatus } from '@/tools/services';
import {
  nfsShareCreate,
  nfsShareUpdate,
  shareAccess,
  shareSetEnabled,
  sharesList,
  smbShareCreate,
  smbShareUpdate,
} from '@/tools/shares';
import {
  createSnapshot,
  snapshotClone,
  snapshotSetHold,
  snapshotsList,
} from '@/tools/snapshots';
import {
  datasetCreate,
  datasetPermissions,
  datasetRename,
  datasetSetProperty,
  datasetSetQuota,
  listDatasets,
  poolStatus,
  quotaReport,
  systemDatasetConfig,
} from '@/tools/storage';
import {
  auditConfig,
  auditLogQuery,
  rebootInfo,
  systemGeneralConfig,
  systemInfo,
  systemNtpStatus,
  systemReboot,
  systemUpdateApply,
  updateStatus,
  upsConfig,
} from '@/tools/system';
import {
  automatedTaskSetEnabled,
  automatedTasksList,
  cloudsyncRun,
  cloudsyncTasksList,
  scheduledTaskSetEnabled,
  scheduledTaskSetSchedule,
  snapshotTaskRun,
  snapshotTasksList,
  tasksRecentRuns,
} from '@/tools/tasks';
import {
  vmClone,
  vmCreate,
  vmDevices,
  vmDiskImageImport,
  vmLogs,
  vmRestart,
  vmsList,
  vmStart,
  vmStop,
} from '@/tools/vms';

/** The sketch's catalog: fifty-nine read-only tools plus forty-four mutating tools. */
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
  catalog.register(upsConfig);
  catalog.register(poolStatus);
  catalog.register(poolTopology);
  catalog.register(scrubHistory);
  catalog.register(poolResilverConfig);
  catalog.register(poolScrubTasksList);
  catalog.register(bootPoolStatus);
  catalog.register(listDatasets);
  catalog.register(quotaReport);
  catalog.register(datasetPermissions);
  catalog.register(systemDatasetConfig);
  catalog.register(disksList);
  catalog.register(disksTemperature);
  catalog.register(appsList);
  catalog.register(appEngineStatus);
  catalog.register(appsUpdateSummary);
  catalog.register(vmsList);
  catalog.register(vmLogs);
  catalog.register(vmDevices);
  catalog.register(containerList);
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
  catalog.register(fcList);
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
  catalog.register(scheduledTaskSetSchedule);
  catalog.register(cloudsyncRun);
  catalog.register(automatedTaskSetEnabled);
  catalog.register(snapshotClone);
  catalog.register(snapshotTaskRun);
  catalog.register(snapshotSetHold);
  catalog.register(vmStart);
  catalog.register(vmStop);
  catalog.register(vmRestart);
  catalog.register(vmClone);
  catalog.register(serviceControl);
  catalog.register(containerStart);
  catalog.register(containerStop);
  catalog.register(containerRestart);
  catalog.register(poolScrubTaskCreate);
  catalog.register(poolScrubTaskUpdate);
  catalog.register(shareSetEnabled);
  catalog.register(smbShareCreate);
  catalog.register(smbShareUpdate);
  catalog.register(nfsShareCreate);
  catalog.register(nfsShareUpdate);
  catalog.register(iscsiTargetCreate);
  catalog.register(iscsiTargetUpdate);
  catalog.register(nvmeofSubsystemCreate);
  catalog.register(nvmeofSubsystemUpdate);
  catalog.register(userCreate);
  catalog.register(userSetLocked);
  catalog.register(datasetSetQuota);
  catalog.register(poolDeviceSetOnline);
  catalog.register(datasetSetProperty);
  catalog.register(datasetCreate);
  catalog.register(datasetRename);
  catalog.register(diskIdentify);
  catalog.register(certificateCsrCreate);
  catalog.register(alertClassSet);
  catalog.register(appUpgrade);
  catalog.register(appRollback);
  catalog.register(vmCreate);
  catalog.register(vmDiskImageImport);
  catalog.register(systemUpdateApply);
  catalog.register(systemReboot);
  return catalog;
}

export {
  alertClassSet,
  alertsDismiss,
  alertSettings,
  alertsList,
  alertsRestore,
  appEngineStatus,
  appRollback,
  appsList,
  appsUpdateSummary,
  appUpgrade,
  auditConfig,
  auditLogQuery,
  automatedTaskSetEnabled,
  automatedTasksList,
  bootPoolStatus,
  certificateCsrCreate,
  certificatesList,
  cloudCredentialsList,
  cloudsyncRun,
  cloudsyncTasksList,
  containerList,
  containerRestart,
  containerStart,
  containerStop,
  createSnapshot,
  datasetCreate,
  datasetPermissions,
  datasetRename,
  datasetSetProperty,
  datasetSetQuota,
  directoryServicesStatus,
  diskIdentify,
  disksList,
  disksTemperature,
  fcList,
  fleetComplianceReport,
  fleetHealthRollup,
  haStatus,
  iscsiList,
  iscsiTargetCreate,
  iscsiTargetUpdate,
  listDatasets,
  networkConfig,
  networkInterfaces,
  nfsClients,
  nfsShareCreate,
  nfsShareUpdate,
  nvmeofList,
  nvmeofSubsystemCreate,
  nvmeofSubsystemUpdate,
  poolDeviceSetOnline,
  poolResilverConfig,
  poolScrubTaskCreate,
  poolScrubTasksList,
  poolScrubTaskUpdate,
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
  scheduledTaskSetSchedule,
  scrubHistory,
  securityConfig,
  serviceControl,
  servicesStatus,
  shareAccess,
  shareSetEnabled,
  sharesList,
  smbShareCreate,
  smbShareUpdate,
  snapshotClone,
  snapshotSetHold,
  snapshotsList,
  snapshotTaskRun,
  snapshotTasksList,
  systemDatasetConfig,
  systemGeneralConfig,
  systemHealthReport,
  systemInfo,
  systemNtpStatus,
  systemReboot,
  systemUpdateApply,
  tasksRecentRuns,
  updateStatus,
  upsConfig,
  userCreate,
  userSetLocked,
  usersList,
  vmClone,
  vmCreate,
  vmDevices,
  vmDiskImageImport,
  vmLogs,
  vmRestart,
  vmsList,
  vmStart,
  vmStop,
};
