import { db } from '../db/database';
import type { ItemRow, UserRow } from '../types';
import { getItem, buildItemPath } from './storageService';
import { canAccessItem } from './sharingService';

export function indexItem(item: ItemRow, pathStr?: string) {
  db.prepare('DELETE FROM search_index WHERE item_id = ?').run(item.id);
  if (item.deleted) return;
  const path = pathStr ?? buildItemPath(item.id);
  db.prepare('INSERT INTO search_index (item_id, name, path) VALUES (?,?,?)').run(item.id, item.name, path);
}

export function removeFromIndex(itemId: number) {
  db.prepare('DELETE FROM search_index WHERE item_id = ?').run(itemId);
}

export function search(query: string, user: UserRow, limit = 100) {
  if (!query.trim()) return [];
  const safe = query.trim().replace(/"/g, ' ').split(/\s+/).map((t) => `"${t}"`).join(' ');
  let rows: { item_id: number }[];
  try {
    rows = db.prepare('SELECT item_id FROM search_index WHERE search_index MATCH ? LIMIT ?').all(safe, limit) as {
      item_id: number;
    }[];
  } catch {
    rows = db
      .prepare("SELECT item_id FROM search_index WHERE name LIKE ? OR path LIKE ? LIMIT ?")
      .all(`%${query.trim()}%`, `%${query.trim()}%`, limit) as { item_id: number }[];
  }
  const out: (ItemRow & { path: string })[] = [];
  for (const r of rows) {
    const item = getItem(r.item_id);
    if (!item || item.deleted) continue;
    if (!canAccessItem(item, user, 'viewer')) continue;
    out.push({ ...item, path: buildItemPath(item.id) });
    if (out.length >= limit) break;
  }
  return out;
}

export function reindexAll() {
  db.prepare('DELETE FROM search_index').run();
  const items = db.prepare('SELECT * FROM items WHERE deleted = 0').all() as unknown as ItemRow[];
  for (const item of items) indexItem(item);
}
