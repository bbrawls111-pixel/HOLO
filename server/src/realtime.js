import { WebSocketServer } from 'ws';
import { db } from './db.js';
import { getUserByToken } from './auth.js';
import { countOp } from './ops.js';

const clients = new Set();

export function attachRealtime(server) {
  // Сокет только для доставки событий от сервера. Клиент ничего не шлёт по нему,
  // все действия идут обычными HTTP-запросами — так их легко посчитать и ограничить.
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname !== '/ws') return socket.destroy();
    const user = getUserByToken(url.searchParams.get('token'));
    if (!user) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      return socket.destroy();
    }
    countOp();
    wss.handleUpgrade(req, socket, head, (ws) => {
      const client = { ws, userId: user.id, alive: true };
      clients.add(client);
      ws.on('pong', () => (client.alive = true));
      ws.on('close', () => clients.delete(client));
      ws.on('error', () => clients.delete(client));
      ws.send(JSON.stringify({ type: 'hello', lastSeq: lastSeq() }));
    });
  });

  // Пинг на уровне протокола WebSocket (не HTTP-запрос): выявляет оборванные соединения.
  setInterval(() => {
    for (const c of clients) {
      if (!c.alive) {
        c.ws.terminate();
        clients.delete(c);
        continue;
      }
      c.alive = false;
      c.ws.ping();
    }
  }, 90_000).unref();
}

function broadcast(message) {
  const data = JSON.stringify(message);
  for (const c of clients) if (c.ws.readyState === 1) c.ws.send(data);
}

export function lastSeq() {
  return db.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM events').get().seq;
}

/** Постоянное событие: сохраняется в журнал, клиент может догнать его после переподключения. */
export function emit(type, payload, userId = null) {
  const createdAt = Date.now();
  const r = db
    .prepare('INSERT INTO events (type, payload, user_id, created_at) VALUES (?, ?, ?, ?)')
    .run(type, JSON.stringify(payload), userId, createdAt);
  const event = { seq: Number(r.lastInsertRowid), type, payload, userId, createdAt };
  broadcast({ type: 'event', event });
  return event;
}

/** Временное событие (например, онлайн-статус): не пишется в журнал. */
export function emitEphemeral(type, payload) {
  broadcast({ type: 'ephemeral', event: { type, payload } });
}

export function eventsSince(since, limit) {
  const rows = db
    .prepare('SELECT * FROM events WHERE seq > ? ORDER BY seq ASC LIMIT ?')
    .all(since, limit + 1);
  const hasMore = rows.length > limit;
  return {
    events: rows.slice(0, limit).map((r) => ({
      seq: r.seq,
      type: r.type,
      payload: JSON.parse(r.payload),
      userId: r.user_id,
      createdAt: r.created_at,
    })),
    hasMore,
  };
}
