import { db } from '../db/database';
import { config } from '../config';
import { randomToken, hashToken } from '../lib/crypto';
import { isLanAddress } from '../lib/system';
import type { RouteInfo } from '../types';

export interface NodeRow {
  id: number;
  name: string;
  model: string | null;
  os_version: string | null;
  token_hash: string;
  status: string;
  lan_ip: string | null;
  lan_port: number | null;
  last_seen: number;
  first_seen: number;
  created_at: number;
}

export interface MetricsRow {
  cpu: number | null;
  ram_total: number | null;
  ram_available: number | null;
  battery: number | null;
  charging: number | null;
  temp: number | null;
  net_speed: number | null;
  latency: number | null;
  storage_free: number | null;
  active_transfers: number | null;
}

// ---------- registry ----------

export function registerNode(name: string, model?: string, osVersion?: string): { nodeId: number; token: string } {
  const token = randomToken(32);
  const now = Date.now();
  const info = db
    .prepare(
      `INSERT INTO nodes (name, model, os_version, token_hash, status, last_seen, first_seen, created_at)
       VALUES (?,?,?,?, 'online', ?, ?, ?)`,
    )
    .run(name, model ?? null, osVersion ?? null, hashToken(token), now, now, now);
  return { nodeId: Number(info.lastInsertRowid), token };
}

export function findNodeByToken(token: string): NodeRow | undefined {
  return db.prepare('SELECT * FROM nodes WHERE token_hash = ?').get(hashToken(token)) as unknown as NodeRow | undefined;
}

export function latestMetrics(nodeId: number): MetricsRow | undefined {
  return db.prepare('SELECT * FROM node_metrics WHERE node_id = ? ORDER BY ts DESC LIMIT 1').get(nodeId) as
    | MetricsRow
    | undefined;
}

export function countActiveTransfers(nodeId: number): number {
  const row = db.prepare(
    "SELECT COUNT(*) AS c FROM transfers WHERE node_id = ? AND status IN ('queued','running')",
  ).get(nodeId) as { c: number };
  return Number(row.c);
}

// ---------- scoring ----------

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export function computeNodeScore(m: MetricsRow | undefined, activeTransfers: number, historicalAvg: number): number {
  if (!m) return -1;
  const net = clamp((m.net_speed ?? 0) / 50_000_000, 0, 1);
  const ram = m.ram_total ? clamp((m.ram_available ?? 0) / m.ram_total, 0, 1) : 0;
  const battery = clamp((m.battery ?? 0) / 100, 0, 1);
  const charging = m.charging ? 1 : 0;
  const cpu = clamp((m.cpu ?? 0) / 100, 0, 1);
  const load = clamp(activeTransfers / 10, 0, 1);
  const temp = clamp((m.temp ?? 0) / 60, 0, 1);
  const hist = clamp(historicalAvg, 0, 1);
  return (
    0.25 * net +
    0.15 * ram +
    0.2 * battery +
    0.05 * charging -
    0.15 * cpu -
    0.15 * load -
    0.05 * temp +
    0.1 * hist
  );
}

export function recordScoreSample(nodeId: number, score: number, now = Date.now()) {
  const day = Math.floor(now / 86400000);
  const hour = new Date(now).getHours();
  db.prepare(
    `INSERT INTO hourly_stats (node_id, day, hour_of_day, score_sum, score_count)
     VALUES (?,?,?,?,1)
     ON CONFLICT(node_id, day, hour_of_day)
     DO UPDATE SET score_sum = score_sum + excluded.score_sum,
                   score_count = score_count + excluded.score_count`,
  ).run(nodeId, day, hour, score);
}

export function historicalBonus(nodeId: number, now = Date.now()): number {
  const hour = new Date(now).getHours();
  const oldestDay = Math.floor(now / 86400000) - 7;
  const row = db
    .prepare(
      'SELECT SUM(score_sum) AS s, SUM(score_count) AS c FROM hourly_stats WHERE node_id = ? AND hour_of_day = ? AND day >= ?',
    )
    .get(nodeId, hour, oldestDay) as { s: number | null; c: number | null };
  if (!row || !row.c) return 0;
  return Math.max(0, Math.min(1, (row.s ?? 0) / row.c));
}

// ---------- health / availability ----------

export function updateNodeStatuses(now = Date.now()): NodeRow[] {
  const cutoff = now - config.heartbeatIntervalMs * config.nodeTimeoutMultiplier;
  const affected = db
    .prepare("SELECT * FROM nodes WHERE status != 'offline' AND last_seen < ?")
    .all(cutoff) as unknown as NodeRow[];
  db.prepare("UPDATE nodes SET status = 'offline' WHERE status != 'offline' AND last_seen < ?").run(cutoff);
  return affected;
}

export function availableGateways(): NodeRow[] {
  updateNodeStatuses();
  const cutoff = Date.now() - config.heartbeatIntervalMs * config.nodeTimeoutMultiplier;
  const nodes = db.prepare("SELECT * FROM nodes WHERE status = 'online' AND last_seen >= ?").all(cutoff) as unknown as NodeRow[];
  const out: NodeRow[] = [];
  for (const node of nodes) {
    const m = latestMetrics(node.id);
    const battery = m?.battery ?? 0;
    const charging = m?.charging ?? 0;
    const temp = m?.temp ?? 0;
    const active = countActiveTransfers(node.id);
    if (battery < config.batteryMin && !charging) continue;
    if (temp > config.tempMaxC) continue;
    if (active >= config.maxConcurrentTransfers) continue;
    out.push(node);
  }
  return out;
}

export function pickBestGateway(): (NodeRow & { score: number }) | null {
  const candidates = availableGateways();
  let best: (NodeRow & { score: number }) | null = null;
  for (const node of candidates) {
    const m = latestMetrics(node.id);
    const active = countActiveTransfers(node.id);
    const score = computeNodeScore(m, active, historicalBonus(node.id));
    if (!best || score > best.score) best = { ...node, score };
  }
  return best;
}

// ---------- adaptive routing ----------

export function chooseRoute(remoteIp?: string): RouteInfo {
  if (isLanAddress(remoteIp)) {
    return { mode: 'direct', reason: 'device on LAN' };
  }
  const best = pickBestGateway();
  if (best && best.lan_ip && best.lan_port) {
    return {
      mode: 'gateway',
      node: { id: best.id, name: best.name, ip: best.lan_ip, port: best.lan_port, score: best.score },
      reason: 'remote device; best gateway selected',
    };
  }
  return { mode: 'direct', reason: 'no gateway available; direct fallback' };
}
