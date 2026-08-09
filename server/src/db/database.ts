import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from '../config';
import { SCHEMA } from './schema';

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });

export const db = new DatabaseSync(config.dbPath);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');
db.exec('PRAGMA synchronous = NORMAL;');

export function initDb() {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number };
  if (row.user_version < 1) {
    db.exec(SCHEMA);
    db.exec('PRAGMA user_version = 1');
  }
}

export function pruneMetrics(retentionDays: number) {
  const cutoff = Date.now() - retentionDays * 86400000;
  db.prepare('DELETE FROM node_metrics WHERE ts < ?').run(cutoff);
}

export function pruneHistory(retentionDays: number) {
  const oldestDay = Math.floor(Date.now() / 86400000) - retentionDays;
  db.prepare('DELETE FROM hourly_stats WHERE day < ?').run(oldestDay);
}

export function pruneTransfers(days: number) {
  const cutoff = Date.now() - days * 86400000;
  db.prepare("DELETE FROM transfers WHERE status IN ('done','failed') AND updated_at < ?").run(cutoff);
}

export function closeDb() {
  db.close();
}
