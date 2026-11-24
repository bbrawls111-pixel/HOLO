import { WebSocketServer } from 'ws';
import { listen, one, q } from './db.js';
import { getUserByToken } from './auth.js';
import { countOp } from './ops.js';

/*
 * На Vercel у каждого экземпляра функции свои WebSocket-клиенты, поэтому
 * события между экземплярами передаются через Postgres NOTIFY/LISTEN:
 *   действие → INSERT в events → pg_notify → все экземпляры → свои сокеты.
 * Слушатель БД открыт, только пока на экземпляре есть подключённые клиенты.
 */

const CHANNEL = 'holo_events';
const clients = new Set();
let listener = null; // Promise<{ closed, close }>
let idleTimer = null;

function broadcast(message) {
  const data = JSON.stringify(message);
  for (const c of clients) if (c.ws.readyState === 1) c.ws.send(data);
}

async function onNotify(payload) {
  let msg;
  try {
    msg = JSON.parse(payload);
  } catch {
    return;
  }
  if (msg.k === 'x') return broadcast({ type: 'ephemeral', event: msg.event });
  let event = msg.event;
  if (!event && msg.seq) {
    const row = await one('SELECT * FROM events WHERE seq = ?', msg.seq);
    if (!row) return;
    event = rowToEvent(row);
  }
  if (event) broadcast({ type: 'event', event });
}

function ensureListener() {
  clearTimeout(idleTimer);
  if (!listener) {
    listener = listen(CHANNEL, onNotify).then(
      (l) => {
        // Связь с БД оборвалась — откроем заново при следующем подключении.
        l.closed.then(() => {
          listener = null;
          if (clients.size) ensureListener();
        });
        return l;
      },
      (err) => {
        listener = null;
        throw err;
      },
    );
  }
  return listener;
}

function releaseListenerIfIdle() {
  if (clients.size) return;
  clearTimeout(idleTimer);
  idleTimer = setTimeout(async () => {
    if (clients.size || !listener) return;
    const l = listener;
    listener = null;
    (await l.catch(() => null))?.close();
  }, 30_000);
}

export function attachRealtime(server) {
  // Сокет только для доставки событий от сервера: все действия — обычные HTTP-запросы.
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 });

  server.on('upgrade', async (req, socket, head) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname !== '/ws') return socket.destroy();
      const user = await getUserByToken(url.searchParams.get('token'));
      if (!user) {
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
        return socket.destroy();
      }
      await Promise.all([countOp(), ensureListener()]);
      wss.handleUpgrade(req, socket, head, async (ws) => {
        const client = { ws, userId: user.id, alive: true };
        clients.add(client);
        const drop = () => {
          clients.delete(client);
          releaseListenerIfIdle();
        };
        ws.on('pong', () => (client.alive = true));
        ws.on('close', drop);
        ws.on('error', drop);
        ws.send(JSON.stringify({ type: 'hello', lastSeq: await lastSeq() }));
      });
    } catch (err) {
      console.error('[ws upgrade]', err);
      socket.destroy();
    }
  });

  // Пинг на уровне протокола WebSocket — не HTTP-запрос.
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
    releaseListenerIfIdle();
  }, 30_000).unref();
}

const rowToEvent = (r) => ({
  seq: r.seq,
  type: r.type,
  payload: JSON.parse(r.payload),
  userId: r.user_id,
  createdAt: r.created_at,
});

export async function lastSeq() {
  return (await one('SELECT COALESCE(MAX(seq), 0)::bigint AS seq FROM events')).seq;
}

/** Постоянное событие: пишется в журнал, клиент догонит его после переподключения. */
export async function emit(type, payload, userId = null) {
  const createdAt = Date.now();
  const json = JSON.stringify(payload);
  const row = await one(
    'INSERT INTO events (type, payload, user_id, created_at) VALUES (?, ?, ?, ?) RETURNING seq',
    type,
    json,
    userId,
    createdAt,
  );
  const event = { seq: row.seq, type, payload, userId, createdAt };
  // Лимит NOTIFY — 8000 байт: большое событие слушатели дочитают из журнала.
  const note = JSON.stringify({ k: 'e', event });
  await q('SELECT pg_notify(?, ?)', CHANNEL, note.length < 7500 ? note : JSON.stringify({ k: 'e', seq: row.seq }));
  return event;
}

/** Временное событие (онлайн-статус): в журнал не пишется. */
export async function emitEphemeral(type, payload) {
  await q('SELECT pg_notify(?, ?)', CHANNEL, JSON.stringify({ k: 'x', event: { type, payload } }));
}

export async function eventsSince(since, limit) {
  const rows = await q('SELECT * FROM events WHERE seq > ? ORDER BY seq ASC LIMIT ?', since, limit + 1);
  return { events: rows.slice(0, limit).map(rowToEvent), hasMore: rows.length > limit };
}

export { rowToEvent };
