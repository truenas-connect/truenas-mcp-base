import { describe, expect, it } from 'vitest';
import { Role } from '@/interfaces';
import { createDefaultCatalog } from '@/tools/index';

describe('createDefaultCatalog', () => {
  it('registers the forty-four sketch tools', () => {
    expect(createDefaultCatalog().list(Role.Full).map((t) => t.name)).toEqual([
      'system_info',
      'system_update_status',
      'system_reboot_info',
      'audit_log_query',
      'audit_config',
      'security_config',
      'storage_pool_status',
      'storage_pool_topology',
      'storage_scrub_history',
      'boot_pool_status',
      'storage_list_datasets',
      'datasets_quota_report',
      'disks_list',
      'apps_list',
      'vms_list',
      'vm_logs',
      'alerts_list',
      'snapshots_list',
      'replication_status',
      'snapshot_tasks_list',
      'cloudsync_tasks_list',
      'automated_tasks_list',
      'tasks_recent_runs',
      'shares_list',
      'share_access',
      'iscsi_list',
      'nvmeof_list',
      'users_list',
      'directory_services_status',
      'network_interfaces',
      'network_config',
      'certificates_list',
      'cloud_credentials_list',
      'alert_settings',
      'reporting_utilisation',
      'reporting_disk_io',
      'reporting_space_trends',
      'reporting_app_vm_usage',
      'services_status',
      'ha_status',
      'system_health_report',
      'fleet_compliance_report',
      'fleet_health_rollup',
      'snapshots_create',
    ]);
  });

  it('advertises fleet_health_rollup to a read-only credential', () => {
    expect(createDefaultCatalog().list(Role.ReadOnly).map((t) => t.name)).toContain(
      'fleet_health_rollup',
    );
  });

  it('advertises audit_config to a read-only credential', () => {
    expect(createDefaultCatalog().list(Role.ReadOnly).map((t) => t.name)).toContain('audit_config');
  });

  it('advertises fleet_compliance_report to a read-only credential', () => {
    expect(createDefaultCatalog().list(Role.ReadOnly).map((t) => t.name)).toContain(
      'fleet_compliance_report',
    );
  });

  it('advertises system_health_report to a read-only credential', () => {
    expect(createDefaultCatalog().list(Role.ReadOnly).map((t) => t.name)).toContain(
      'system_health_report',
    );
  });

  it('advertises ha_status to a read-only credential', () => {
    expect(createDefaultCatalog().list(Role.ReadOnly).map((t) => t.name)).toContain('ha_status');
  });

  it('advertises reporting_utilisation to a read-only credential', () => {
    expect(createDefaultCatalog().list(Role.ReadOnly).map((t) => t.name)).toContain(
      'reporting_utilisation',
    );
  });

  it('advertises reporting_disk_io to a read-only credential', () => {
    expect(createDefaultCatalog().list(Role.ReadOnly).map((t) => t.name)).toContain(
      'reporting_disk_io',
    );
  });

  it('advertises reporting_space_trends to a read-only credential', () => {
    expect(createDefaultCatalog().list(Role.ReadOnly).map((t) => t.name)).toContain(
      'reporting_space_trends',
    );
  });

  it('advertises reporting_app_vm_usage to a read-only credential', () => {
    expect(createDefaultCatalog().list(Role.ReadOnly).map((t) => t.name)).toContain(
      'reporting_app_vm_usage',
    );
  });

  it('advertises system_update_status to a read-only credential', () => {
    expect(createDefaultCatalog().list(Role.ReadOnly).map((t) => t.name)).toContain(
      'system_update_status',
    );
  });

  it('advertises audit_log_query to a read-only credential', () => {
    expect(createDefaultCatalog().list(Role.ReadOnly).map((t) => t.name)).toContain(
      'audit_log_query',
    );
  });

  it('advertises alert_settings to a read-only credential', () => {
    expect(createDefaultCatalog().list(Role.ReadOnly).map((t) => t.name)).toContain(
      'alert_settings',
    );
  });

  it('advertises cloud_credentials_list to a read-only credential', () => {
    expect(createDefaultCatalog().list(Role.ReadOnly).map((t) => t.name)).toContain(
      'cloud_credentials_list',
    );
  });

  it('advertises certificates_list to a read-only credential', () => {
    expect(createDefaultCatalog().list(Role.ReadOnly).map((t) => t.name)).toContain(
      'certificates_list',
    );
  });

  it('advertises alerts_list to a read-only credential', () => {
    expect(createDefaultCatalog().list(Role.ReadOnly).map((t) => t.name)).toContain('alerts_list');
  });

  it('advertises disks_list to a read-only credential', () => {
    expect(createDefaultCatalog().list(Role.ReadOnly).map((t) => t.name)).toContain('disks_list');
  });

  it('advertises vms_list to a read-only credential', () => {
    expect(createDefaultCatalog().list(Role.ReadOnly).map((t) => t.name)).toContain('vms_list');
  });

  it('advertises vm_logs to a read-only credential', () => {
    expect(createDefaultCatalog().list(Role.ReadOnly).map((t) => t.name)).toContain('vm_logs');
  });

  it('advertises apps_list to a read-only credential', () => {
    expect(createDefaultCatalog().list(Role.ReadOnly).map((t) => t.name)).toContain('apps_list');
  });

  it('advertises storage_pool_topology to a read-only credential', () => {
    expect(createDefaultCatalog().list(Role.ReadOnly).map((t) => t.name)).toContain(
      'storage_pool_topology',
    );
  });

  it('advertises storage_scrub_history to a read-only credential', () => {
    expect(createDefaultCatalog().list(Role.ReadOnly).map((t) => t.name)).toContain(
      'storage_scrub_history',
    );
  });

  it('advertises datasets_quota_report to a read-only credential', () => {
    expect(createDefaultCatalog().list(Role.ReadOnly).map((t) => t.name)).toContain(
      'datasets_quota_report',
    );
  });

  it('advertises snapshots_list to a read-only credential', () => {
    expect(createDefaultCatalog().list(Role.ReadOnly).map((t) => t.name)).toContain(
      'snapshots_list',
    );
  });

  it('advertises replication_status to a read-only credential', () => {
    expect(createDefaultCatalog().list(Role.ReadOnly).map((t) => t.name)).toContain(
      'replication_status',
    );
  });

  it('advertises snapshot_tasks_list to a read-only credential', () => {
    expect(createDefaultCatalog().list(Role.ReadOnly).map((t) => t.name)).toContain(
      'snapshot_tasks_list',
    );
  });

  it('advertises cloudsync_tasks_list to a read-only credential', () => {
    expect(createDefaultCatalog().list(Role.ReadOnly).map((t) => t.name)).toContain(
      'cloudsync_tasks_list',
    );
  });

  it('advertises tasks_recent_runs to a read-only credential', () => {
    expect(createDefaultCatalog().list(Role.ReadOnly).map((t) => t.name)).toContain(
      'tasks_recent_runs',
    );
  });

  it('advertises shares_list to a read-only credential', () => {
    expect(createDefaultCatalog().list(Role.ReadOnly).map((t) => t.name)).toContain('shares_list');
  });

  it('advertises share_access to a read-only credential', () => {
    expect(createDefaultCatalog().list(Role.ReadOnly).map((t) => t.name)).toContain('share_access');
  });

  it('advertises iscsi_list to a read-only credential', () => {
    expect(createDefaultCatalog().list(Role.ReadOnly).map((t) => t.name)).toContain('iscsi_list');
  });

  it('advertises nvmeof_list to a read-only credential', () => {
    expect(createDefaultCatalog().list(Role.ReadOnly).map((t) => t.name)).toContain('nvmeof_list');
  });

  it('advertises users_list to a read-only credential', () => {
    expect(createDefaultCatalog().list(Role.ReadOnly).map((t) => t.name)).toContain('users_list');
  });

  it('advertises directory_services_status to a read-only credential', () => {
    expect(createDefaultCatalog().list(Role.ReadOnly).map((t) => t.name)).toContain(
      'directory_services_status',
    );
  });

  it('advertises network_interfaces to a read-only credential', () => {
    expect(createDefaultCatalog().list(Role.ReadOnly).map((t) => t.name)).toContain(
      'network_interfaces',
    );
  });

  it('advertises network_config to a read-only credential', () => {
    expect(createDefaultCatalog().list(Role.ReadOnly).map((t) => t.name)).toContain(
      'network_config',
    );
  });

  it('advertises services_status to a read-only credential', () => {
    expect(createDefaultCatalog().list(Role.ReadOnly).map((t) => t.name)).toContain(
      'services_status',
    );
  });

  it('advertises system_reboot_info to a read-only credential', () => {
    expect(createDefaultCatalog().list(Role.ReadOnly).map((t) => t.name)).toContain(
      'system_reboot_info',
    );
  });

  it('advertises boot_pool_status to a read-only credential', () => {
    expect(createDefaultCatalog().list(Role.ReadOnly).map((t) => t.name)).toContain(
      'boot_pool_status',
    );
  });

  it('advertises security_config to a read-only credential', () => {
    expect(createDefaultCatalog().list(Role.ReadOnly).map((t) => t.name)).toContain(
      'security_config',
    );
  });

  it('advertises automated_tasks_list to a read-only credential', () => {
    expect(createDefaultCatalog().list(Role.ReadOnly).map((t) => t.name)).toContain(
      'automated_tasks_list',
    );
  });
});
