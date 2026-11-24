import { one, q } from './db.js';
import { config } from './config.js';
import { emitEphemeral } from './realtime.js';

/*
 * Присутствие без фонового процесса (на Vercel его нет):
 *  - при входе клиент шлёт «я в сети» → online = true;
 *  - дальше клиент повторяет запрос раз в 5 минут;
 *  - каждый такой запрос (и загрузка списка пользователей) проверяет остальных:
 *    кто не отметился за 5 минут + запас, тот переводится в офлайн.
 */

const cutoff = () => Date.now() - (config.presenceIntervalMs + config.presenceGraceMs);

export const isFresh = (row) => !!row.online && (row.last_seen ?? 0) >= cutoff();

export async function markOnline(userId) {
  const now = Date.now();
  const prev = await one('SELECT online, last_seen FROM users WHERE id = ?', userId);
  await q('UPDATE users SET online = TRUE, last_seen = ? WHERE id = ?', now, userId);
  if (!prev || !isFresh(prev)) await emitEphemeral('presence.changed', { userId, online: true, lastSeen: now });
}

export async function markOffline(userId) {
  const row = await one('UPDATE users SET online = FALSE WHERE id = ? AND online RETURNING last_seen', userId);
  if (row) await emitEphemeral('presence.changed', { userId, online: false, lastSeen: row.last_seen });
}

/** Проверка онлайна: снимает статус с тех, кто не отметился вовремя. */
export async function sweepPresence() {
  const stale = await q('UPDATE users SET online = FALSE WHERE online AND last_seen < ? RETURNING id, last_seen', cutoff());
  for (const r of stale) await emitEphemeral('presence.changed', { userId: r.id, online: false, lastSeen: r.last_seen });
}
