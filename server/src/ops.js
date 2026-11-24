import { db } from './db.js';

// Счётчик серверных операций за месяц (HTTP-запросы + установка WebSocket-соединения).
// Пишется в БД пачками, чтобы не делать запись на каждый запрос.
let pending = 0;
const monthKey = () => new Date().toISOString().slice(0, 7);

export function countOp(n = 1) {
  pending += n;
}

export function flushOps() {
  if (!pending) return;
  db.prepare(
    'INSERT INTO ops (month, count) VALUES (?, ?) ON CONFLICT(month) DO UPDATE SET count = count + excluded.count',
  ).run(monthKey(), pending);
  pending = 0;
}

export function getOpsThisMonth() {
  const row = db.prepare('SELECT count FROM ops WHERE month = ?').get(monthKey());
  return (row?.count ?? 0) + pending;
}

setInterval(flushOps, 15_000).unref();
