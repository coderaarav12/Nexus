import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db } from '../db/database';
import { getItem, buildItemPath } from '../services/storageService';
import { contentPath } from '../lib/paths';
import type { ItemRow } from '../types';

const toolDir = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.resolve(toolDir, '..', '..');

const safePart = (name: string) => name.replace(/[\\/\u0000-\u001f]/g, '_');
const isNotSafePart = (p: string) => p.length === 0 || p === '.' || p === '..';

function main() {
  const shareDir = process.env.SHARE_DIR
    ? path.resolve(process.env.SHARE_DIR)
    : path.join(serverDir, 'data', 'share');
  db.exec('PRAGMA busy_timeout = 5000;');

  const users = db.prepare('SELECT id, username FROM users').all() as { id: number; username: string }[];
  const usernameByUser = new Map(users.map((u) => [u.id, u.username]));
  const usernameSet = new Set(users.map((u) => u.username));

  const workspaces = db.prepare('SELECT id, name FROM workspaces').all() as { id: number; name: string }[];
  const wsNameCounts = new Map<string, number>();
  for (const w of workspaces) wsNameCounts.set(w.name, (wsNameCounts.get(w.name) ?? 0) + 1);
  const workspaceDir = new Map<number, string>();
  for (const w of workspaces) {
    const collides = (wsNameCounts.get(w.name) ?? 1) > 1 || usernameSet.has(w.name);
    workspaceDir.set(w.id, collides ? `${w.name} (${w.id})` : w.name);
  }

  const isChainClean = (item: ItemRow): boolean => {
    let cur: ItemRow | undefined = item;
    let guard = 0;
    while (cur && guard < 100) {
      if (cur.deleted) return false;
      cur = cur.parent_id ? getItem(cur.parent_id) : undefined;
      guard++;
    }
    return true;
  };

  const logicalPath = (item: ItemRow): string | null => {
    if (item.kind !== 'file' || item.deleted || !item.sha256) return null;
    if (!isChainClean(item)) return null;
    const parts = buildItemPath(item.id).split('/').map(safePart).filter((p) => !isNotSafePart(p));
    if (parts.length === 0) return null;
    if (item.workspace_id) {
      const top = workspaceDir.get(item.workspace_id);
      if (!top) return null;
      parts[0] = top;
      return parts.join('/');
    }
    const username = item.owner_id != null ? usernameByUser.get(item.owner_id) : undefined;
    if (!username) return null;
    return [safePart(username), ...parts].join('/');
  };

  const rows = db.prepare("SELECT * FROM items WHERE kind = 'file'").all() as unknown as ItemRow[];
  const targets = new Map<string, string>();
  let totalBytes = 0;
  for (const item of rows) {
    const rel = logicalPath(item);
    if (!rel || !item.sha256) continue;
    targets.set(rel, item.sha256);
    totalBytes += item.size;
  }

  const walkFiles = (dir: string): string[] => {
    const out: string[] = [];
    if (!fs.existsSync(dir)) return out;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) out.push(...walkFiles(abs));
      else if (entry.isFile()) out.push(path.relative(shareDir, abs));
    }
    return out;
  };

  let pruned = 0;
  for (const rel of walkFiles(shareDir)) {
    const norm = rel.replace(/\\/g, '/');
    if (!targets.has(norm)) {
      fs.unlinkSync(path.join(shareDir, norm));
      pruned++;
    }
  }

  let linked = 0;
  let copied = 0;
  let skipped = 0;
  let missing = 0;
  for (const [rel, sha] of targets) {
    const dest = path.join(shareDir, ...rel.split('/'));
    const blob = contentPath(sha);
    if (!fs.existsSync(blob)) {
      missing++;
      continue;
    }
    let upToDate = false;
    if (fs.existsSync(dest)) {
      try {
        const dst = fs.lstatSync(dest);
        const src = fs.statSync(blob);
        upToDate = dst.isFile() && src.isFile() && dst.dev === src.dev && dst.ino === src.ino;
      } catch {
        upToDate = false;
      }
    }
    if (upToDate) {
      skipped++;
      continue;
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    if (fs.existsSync(dest)) fs.unlinkSync(dest);
    try {
      fs.linkSync(blob, dest);
      linked++;
    } catch {
      fs.copyFileSync(blob, dest);
      copied++;
    }
  }

  console.log(`[nexus-export] share: ${shareDir}`);
  console.log(
    `[nexus-export] files: exported=${linked + copied} (linked=${linked}, copied=${copied}) skipped=${skipped} pruned=${pruned} missing=${missing}`,
  );
  console.log(`[nexus-export] total size: ${totalBytes} bytes`);
}

try {
  main();
} catch (err) {
  console.error('[nexus-export] failed:', err);
  process.exit(1);
}
