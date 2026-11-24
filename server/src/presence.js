import { db } from './db.js';
import { config } from './config.js';
import { emitEphemeral } from './realtime.js';

// userId -> время последнего запроса присутствия
const lastSeen = new Map();

export const isOnline = (userId) => lastSeen.has(userId);
export const presenceLastSeen = (userId) => lastSeen.get(userId) ?? null;

/** Клиент сообщил «я в сети» — при входе и затем раз в 5 минут. */
export function markOnline(userId) {
  const now = Date.now();
  const wasOnline = lastSeen.has(userId);
  lastSeen.set(userId, now);
  db.prepare('UPDATE users SET last_seen = ? WHERE id = ?').run(now, userId);
  if (!wasOnline) emitEphemeral('presence.changed', { userId, online: true, lastSeen: now });
}

export function markOffline(userId) {
  if (!lastSeen.has(userId)) return;
  const seen = lastSeen.get(userId);
  lastSeen.delete(userId);
  db.prepare('UPDATE users SET last_seen = ? WHERE id = ?').run(seen, userId);
  emitEphemeral('presence.changed', { userId, online: false, lastSeen: seen });
}

/** Раз в 5 минут: кто не отметился за интервал (+ запас), тот офлайн. */
export function startPresenceSweep() {
  setInterval(() => {
    const cutoff = Date.now() - (config.presenceIntervalMs + config.presenceGraceMs);
    for (const [userId, seen] of lastSeen) if (seen < cutoff) markOffline(userId);
  }, config.presenceIntervalMs).unref();
}
