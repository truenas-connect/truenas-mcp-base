import { ToolCatalog } from '@/catalog/catalog';
import { alertsList } from '@/tools/alerts';
import { createSnapshot } from '@/tools/snapshots';
import { listDatasets, poolStatus } from '@/tools/storage';
import { systemInfo } from '@/tools/system';

/** The sketch's catalog: four read-only tools plus one mutating tool. */
export function createDefaultCatalog(): ToolCatalog {
  const catalog = new ToolCatalog();
  catalog.register(systemInfo);
  catalog.register(poolStatus);
  catalog.register(listDatasets);
  catalog.register(alertsList);
  catalog.register(createSnapshot);
  return catalog;
}

export { alertsList, createSnapshot, listDatasets, poolStatus, systemInfo };
