import { one, q } from '../db.js';
import { config } from '../config.js';
import { HttpError, readJson, requireInt } from '../http.js';
import { emitEphemeral } from '../realtime.js';

/*
 * Сигнализация звонков. Звук и видео идут напрямую между компьютерами (WebRTC),
 * сервер только передаёт короткие сообщения: вызов, принять, SDP, ICE-кандидаты.
 * Сообщения кладутся в таблицу и анонсируются через WebSocket (id + от кого) —
 * так их не теряем, даже если сокет как раз переподключался: клиент дочитает «входящие».
 */

const SIGNAL_TTL = 10 * 60 * 1000;

async function iceServers() {
  const servers = [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
    { urls: 'stun:stun.cloudflare.com:3478' },
  ];
  // TURN-ретранслятор — если прямое соединение не проходит (строгий NAT у провайдера).
  // Вариант 1: Cloudflare Realtime TURN (бесплатный лимит), короткоживущие ключи.
  const keyId = process.env.CF_TURN_KEY_ID;
  const keyToken = process.env.CF_TURN_KEY_API_TOKEN;
  if (keyId && keyToken) {
    try {
      const r = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${keyId}/credentials/generate-ice-servers`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${keyToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ttl: 86400 }),
      });
      if (r.ok) {
        const j = await r.json();
        const list = Array.isArray(j.iceServers) ? j.iceServers : [j.iceServers];
        servers.push(...list.filter(Boolean));
      }
    } catch {
      /* без TURN — только прямое соединение */
    }
  }
  // Вариант 2: любой TURN-сервер со статичными логином и паролем.
  if (process.env.HOLO_TURN_URLS) {
    servers.push({
      urls: process.env.HOLO_TURN_URLS.split(',').map((s) => s.trim()).filter(Boolean),
      username: process.env.HOLO_TURN_USERNAME || '',
      credential: process.env.HOLO_TURN_CREDENTIAL || '',
    });
  }
  return servers;
}

export default function register(router) {
  router.get('/api/call/ice', async () => {
    const servers = await iceServers();
    return { iceServers: servers, turn: servers.some((s) => [s.urls].flat().some((u) => String(u).startsWith('turn'))) };
  });

  router.post('/api/call/signal', async ({ req, user }) => {
    const body = await readJson(req, config.maxJsonBytes);
    const to = body.to ? requireInt(body.to, 'to') : (await one('SELECT id FROM users WHERE id <> ? ORDER BY id LIMIT 1', user.id))?.id;
    if (!to || to === user.id || !(await one('SELECT 1 FROM users WHERE id = ?', to))) throw new HttpError(404, 'Собеседник не найден');
    const payload = JSON.stringify(body.payload ?? {});
    if (payload.length > 200_000) throw new HttpError(413, 'Слишком большой сигнал');
    const now = Date.now();
    const row = await one(
      'INSERT INTO call_signals (from_user, to_user, payload, created_at) VALUES (?, ?, ?, ?) RETURNING id',
      user.id, to, payload, now,
    );
    // В анонс кладём и сам сигнал, если он маленький — тогда лишний запрос не нужен.
    const small = payload.length < 6000 ? JSON.parse(payload) : undefined;
    await emitEphemeral('call.signal', { id: row.id, from: user.id, to, payload: small });
    if (Math.random() < 0.05) await q('DELETE FROM call_signals WHERE created_at < ?', now - SIGNAL_TTL);
    return { id: row.id };
  });

  router.get('/api/call/signal/:id', async ({ params, user }) => {
    const row = await one('SELECT * FROM call_signals WHERE id = ? AND to_user = ?', requireInt(params.id, 'id'), user.id);
    if (!row) throw new HttpError(404, 'Сигнал не найден');
    return { id: row.id, from: row.from_user, payload: JSON.parse(row.payload) };
  });

  // «Входящие» за последние 2 минуты — догоняем после переподключения.
  router.get('/api/call/inbox', async ({ query, user }) => {
    const since = Math.max(0, Number(query.get('since')) || 0);
    const rows = await q(
      'SELECT * FROM call_signals WHERE to_user = ? AND id > ? AND created_at > ? ORDER BY id LIMIT 200',
      user.id, since, Date.now() - 120_000,
    );
    return rows.map((r) => ({ id: r.id, from: r.from_user, payload: JSON.parse(r.payload), createdAt: r.created_at, now: Date.now() }));
  });
}
