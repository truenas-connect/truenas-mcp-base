import { ToolCatalog } from '@/catalog/catalog';
import { alertsList } from '@/tools/alerts';
import { appsList } from '@/tools/apps';
import { disksList } from '@/tools/disks';
import { poolTopology } from '@/tools/pools';
import { createSnapshot } from '@/tools/snapshots';
import { listDatasets, poolStatus } from '@/tools/storage';
import { systemInfo } from '@/tools/system';

/** The sketch's catalog: seven read-only tools plus one mutating tool. */
export function createDefaultCatalog(): ToolCatalog {
  const catalog = new ToolCatalog();
  catalog.register(systemInfo);
  catalog.register(poolStatus);
  catalog.register(poolTopology);
  catalog.register(listDatasets);
  catalog.register(disksList);
  catalog.register(appsList);
  catalog.register(alertsList);
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
  systemInfo,
};
