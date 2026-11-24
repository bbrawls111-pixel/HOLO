import { one, q } from './db.js';

// Счётчик серверных операций за месяц: HTTP-запросы и установка WebSocket-соединений.
const monthKey = () => new Date().toISOString().slice(0, 7);

export async function countOp() {
  await q(
    'INSERT INTO ops (month, count) VALUES (?, 1) ON CONFLICT (month) DO UPDATE SET count = ops.count + 1',
    monthKey(),
  );
}

export async function getOpsThisMonth() {
  return (await one('SELECT count FROM ops WHERE month = ?', monthKey()))?.count ?? 0;
}
