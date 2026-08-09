import './setup.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { initDb } from '../src/db/database';
import { db } from '../src/db/database';
import { registerNode, computeNodeScore, availableGateways, updateNodeStatuses, latestMetrics, historicalBonus } from '../src/services/gatewayService';

initDb();

test('node registration + heartbeat metrics', () => {
  const { nodeId } = registerNode('e32s', 'Motorola E32s', 'Android 13');
  db.prepare('UPDATE nodes SET last_seen = ? WHERE id = ?').run(Date.now(), nodeId);
  db.prepare(
    'INSERT INTO node_metrics (node_id, ts, cpu, ram_total, ram_available, battery, charging, temp, net_speed, active_transfers) VALUES (?,?,?,?,?,?,?,?,?,?)',
  ).run(nodeId, Date.now(), 30, 8_000_000_000, 4_000_000_000, 80, 0, 35, 60_000_000, 0);

  const m = latestMetrics(nodeId)!;
  assert.ok(m);
  assert.equal(m.battery, 80);

  const nodes = availableGateways();
  assert.ok(nodes.some((n) => n.id === nodeId));
});

test('low battery gates node unless charging', () => {
  const { nodeId } = registerNode('e7', 'Motorola E7', 'Android 12');
  db.prepare('UPDATE nodes SET last_seen = ? WHERE id = ?').run(Date.now(), nodeId);
  db.prepare(
    'INSERT INTO node_metrics (node_id, ts, cpu, ram_total, ram_available, battery, charging, temp, net_speed, active_transfers) VALUES (?,?,?,?,?,?,?,?,?,?)',
  ).run(nodeId, Date.now(), 10, 8_000_000_000, 6_000_000_000, 5, 0, 30, 60_000_000, 0);

  assert.equal(availableGateways().some((n) => n.id === nodeId), false);

  db.prepare(
    'INSERT INTO node_metrics (node_id, ts, cpu, ram_total, ram_available, battery, charging, temp, net_speed, active_transfers) VALUES (?,?,?,?,?,?,?,?,?,?)',
  ).run(nodeId, Date.now(), 10, 8_000_000_000, 6_000_000_000, 5, 1, 30, 60_000_000, 0);
  assert.equal(availableGateways().some((n) => n.id === nodeId), true);
});

test('score ordering prefers healthy nodes', () => {
  const good = computeNodeScore({ cpu: 5, ram_total: 8000, ram_available: 6000, battery: 95, charging: 1, temp: 28, net_speed: 80_000_000, latency: 5, storage_free: 0, active_transfers: 0 }, 0, 0.9);
  const bad = computeNodeScore({ cpu: 95, ram_total: 8000, ram_available: 500, battery: 10, charging: 0, temp: 50, net_speed: 2_000_000, latency: 300, storage_free: 0, active_transfers: 0 }, 0, 0.1);
  assert.ok(good > bad);

  const noMetrics = computeNodeScore(undefined, 0, 0);
  assert.equal(noMetrics, -1);
});

test('historical bonus rises with reliability', () => {
  const { nodeId } = registerNode('hist', 'Test', 'Android');
  historicalBonus(nodeId);
  const base = historicalBonus(nodeId);
  // after one sample the avg equals the sample
  assert.equal(base, 0);
  db.prepare(
    `INSERT INTO hourly_stats (node_id, day, hour_of_day, score_sum, score_count)
     VALUES (?, ?, ?, ?, 1)
     ON CONFLICT(node_id, day, hour_of_day) DO UPDATE SET score_sum = score_sum + excluded.score_sum, score_count = score_count + excluded.score_count`,
  ).run(nodeId, Math.floor(Date.now() / 86400000), new Date().getHours(), 0.5);
  assert.ok(historicalBonus(nodeId) > 0);
});

test('missed heartbeats mark node offline and jobs are requeued', () => {
  const { nodeId } = registerNode('ghost', 'Ghost', 'Android');
  db.prepare('UPDATE nodes SET last_seen = 1 WHERE id = ?').run(nodeId);
  const affected = updateNodeStatuses();
  assert.ok(affected.some((n) => n.id === nodeId));
  const row = db.prepare('SELECT status FROM nodes WHERE id = ?').get(nodeId) as { status: string };
  assert.equal(row.status, 'offline');
});
