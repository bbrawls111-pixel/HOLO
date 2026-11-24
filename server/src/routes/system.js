import { db } from '../db.js';
import { config } from '../config.js';
import { eventsSince, lastSeq } from '../realtime.js';
import { getOpsThisMonth } from '../ops.js';
import { allUsers, fileDto, meDto } from '../dto.js';

const ACTIVITY_TYPES = ['file.created', 'file.updated', 'file.moved', 'file.deleted', 'folder.created', 'folder.deleted', 'file.comment'];

function activity(limit, types = ACTIVITY_TYPES) {
  const marks = types.map(() => '?').join(',');
  return db
    .prepare(`SELECT * FROM events WHERE type IN (${marks}) ORDER BY seq DESC LIMIT ?`)
    .all(...types, limit)
    .map((r) => ({ seq: r.seq, type: r.type, payload: JSON.parse(r.payload), userId: r.user_id, createdAt: r.created_at }));
}

function stats() {
  const storage = db.prepare('SELECT COALESCE(SUM(size), 0) AS bytes FROM (SELECT DISTINCT storage_key, size FROM file_versions)').get();
  return {
    month: new Date().toISOString().slice(0, 7),
    ops: getOpsThisMonth(),
    opsLimit: config.monthlyOpsLimit,
    storageBytes: storage.bytes,
    files: db.prepare('SELECT COUNT(*) AS n FROM files WHERE deleted = 0').get().n,
    messages: db.prepare('SELECT COUNT(*) AS n FROM messages').get().n,
    presenceIntervalMs: config.presenceIntervalMs,
  };
}

export default function register(router) {
  // Один запрос при старте вместо десятка — экономит лимит операций.
  router.get('/api/bootstrap', ({ user }) => ({
    me: meDto(user),
    users: allUsers(),
    channels: db.prepare('SELECT id, name FROM channels ORDER BY position, name').all().map((c) => ({ ...c })),
    folders: db.prepare('SELECT path FROM folders ORDER BY path').all().map((r) => r.path),
    files: db.prepare('SELECT * FROM files WHERE deleted = 0 ORDER BY path').all().map(fileDto),
    activity: activity(30),
    stats: stats(),
    lastSeq: lastSeq(),
  }));

  // Догоняем пропущенные события после переподключения.
  router.get('/api/events', ({ query }) => {
    const since = Math.max(0, Number(query.get('since')) || 0);
    const limit = Math.min(Number(query.get('limit')) || 500, 1000);
    return { ...eventsSince(since, limit), lastSeq: lastSeq() };
  });

  router.get('/api/activity', ({ query }) => {
    const limit = Math.min(Number(query.get('limit')) || 50, 300);
    const all = query.get('all') === '1';
    return all
      ? db.prepare('SELECT * FROM events ORDER BY seq DESC LIMIT ?').all(limit).map((r) => ({
          seq: r.seq, type: r.type, payload: JSON.parse(r.payload), userId: r.user_id, createdAt: r.created_at,
        }))
      : activity(limit);
  });

  router.get('/api/stats', () => stats());
}
