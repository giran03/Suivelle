import { expect, test } from 'vitest';
import { handle } from './backend';

const read = (cmd: string, args = {}): Promise<any> => handle(cmd, args);
async function snapshot() {
  const workspace = await read('workspace_get');
  const pages = await read('page_list_children', { parentPageId: null });
  const database = await read('database_get', { pageId: 'pg_sprint' });
  const records = await read('query_records', { input: { databaseId: 'db_sprint', viewId: 'v_table', limit: 100 } });
  const blocks = await read('block_list', { pageId: 'pg_home' });
  const dashboard = await read('dashboard_get', { pageId: 'pg_pulse' });
  return { workspace, pages, database, records, blocks, dashboard };
}

test('all content mutations and unknown commands are rejected without changing the workspace', async () => {
  const before = await snapshot();
  for (const cmd of [
    'workspace_create', 'workspace_update', 'workspace_delete', 'page_create', 'page_update', 'page_delete',
    'page_restore', 'page_move', 'page_duplicate', 'page_delete_permanent', 'block_apply_batch',
    'database_create', 'record_create', 'record_set_value', 'record_bulk_set', 'record_duplicate',
    'property_create', 'property_update', 'property_delete', 'view_create', 'view_delete', 'dashboard_create',
    'dashboard_save', 'attachment_import_bytes', 'attachment_delete_unused', 'import_pick', 'import_apply',
    'export_write', 'backup_create', 'backup_restore', 'backup_set_auto', 'automation_run_now', 'button_press',
    'quick_capture', 'history_restore', 'search_rebuild', 'maintenance_sweep', 'maintenance_compact',
    'maintenance_check', 'backup_mirror_choose', 'backup_mirror_clear', 'future_write_command',
  ]) await expect(read(cmd, { input: {} })).rejects.toMatchObject({ code: 'read_only' });
  await read('page_touch', { id: 'pg_home' });
  await read('history_checkpoint', { pageId: 'pg_home' });
  expect(await snapshot()).toEqual(before);
});

test('read results cannot be used to mutate titles, blocks, record values, or dashboard layout', async () => {
  const before = await snapshot();
  const copy = await snapshot();
  copy.pages[0].title = 'Changed';
  copy.blocks[0].dataJson = '{}';
  copy.records.rows[0].values.p_status = 'changed';
  copy.database.properties[0].name = 'Changed';
  copy.dashboard.layout.widgets.length = 0;
  expect(await snapshot()).toEqual(before);
});

test('temporary view and theme preferences work while content and schema stay unchanged', async () => {
  const before = await snapshot();
  const updated = await read('view_update', { input: { viewId: 'v_table', config: { sorts: [{ propertyId: 'p_title', direction: 'desc' }], chart: { unsafe: true } } } });
  expect(updated.config.sorts).toHaveLength(1);
  expect(updated.config.chart).toBeUndefined();
  await expect(read('view_update', { input: { viewId: 'v_table', name: 'Changed', config: {} } })).rejects.toMatchObject({ code: 'read_only' });
  const ws = await read('workspace_update_settings', { input: { settingsJson: JSON.stringify({ theme: 'light', description: 'Changed', autoBackup: false }) } });
  expect(JSON.parse(ws.settingsJson).theme).toBe('light');
  expect(JSON.parse(ws.settingsJson).description).toBe(JSON.parse(before.workspace.settingsJson).description);
  const after = await snapshot();
  expect(after.blocks).toEqual(before.blocks);
  expect(after.pages).toEqual(before.pages);
  expect(after.database.properties).toEqual(before.database.properties);
  expect(after.records.rows.map((r: any) => r.id).sort()).toEqual(before.records.rows.map((r: any) => r.id).sort());
});
