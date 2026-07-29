import { ToolCatalog } from '@/catalog/catalog';
import { createSnapshot } from '@/tools/snapshots';
import { listDatasets, poolStatus } from '@/tools/storage';
import { systemInfo } from '@/tools/system';

/** The sketch's catalog: three read-only tools plus one mutating tool. */
export function createDefaultCatalog(): ToolCatalog {
  const catalog = new ToolCatalog();
  catalog.register(systemInfo);
  catalog.register(poolStatus);
  catalog.register(listDatasets);
  catalog.register(createSnapshot);
  return catalog;
}

export { createSnapshot, listDatasets, poolStatus, systemInfo };
