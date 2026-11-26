import { one, q } from '../db.js';
import { config } from '../config.js';
import { eventsSince, lastSeq, rowToEvent } from '../realtime.js';
import { getOpsThisMonth } from '../ops.js';
import { sweepPresence } from '../presence.js';
import { allUsers, fileDto, meDto } from '../dto.js';
import { storageMode } from '../storage.js';
import { listChannels } from './chat.js';
import { listBoards } from './boards.js';

const ACTIVITY_TYPES = ['file.created', 'file.updated', 'file.moved', 'file.deleted', 'file.comment', 'board.created', 'board.deleted'];

async function activity(limit, all = false) {
  const rows = all
    ? await q('SELECT * FROM events ORDER BY seq DESC LIMIT ?', limit)
    : await q('SELECT * FROM events WHERE type = ANY(?::text[]) ORDER BY seq DESC LIMIT ?', ACTIVITY_TYPES, limit);
  return rows.map(rowToEvent);
}

async function stats() {
  const [storage, files, messages, ops] = await Promise.all([
    // Только данные живых файлов (и лежащих в корзине): версии файлов, удалённых навсегда, уже стёрты
    // из хранилища — раньше они всё равно считались, и вес после удаления не уменьшался.
    one(
      `SELECT COALESCE(SUM(size), 0)::bigint AS bytes FROM (
         SELECT DISTINCT v.storage_key, v.size FROM file_versions v JOIN files f ON f.id = v.file_id WHERE NOT f.purged
       ) s`,
    ),
    one("SELECT COUNT(*)::int AS n FROM files WHERE NOT deleted AND scope = 'library'"),
    one('SELECT COUNT(*)::int AS n FROM messages'),
    getOpsThisMonth(),
  ]);
  return {
    month: new Date().toISOString().slice(0, 7),
    ops,
    opsLimit: config.monthlyOpsLimit,
    storageBytes: storage.bytes,
    files: files.n,
    messages: messages.n,
    presenceIntervalMs: config.presenceIntervalMs,
  };
}

export default function register(router) {
  // Один запрос при старте вместо десятка — экономит лимит операций.
  router.get('/api/bootstrap', async ({ user }) => {
    await sweepPresence();
    const [users, channels, files, boards, act, st, seq] = await Promise.all([
      allUsers(),
      listChannels(),
      q("SELECT * FROM files WHERE NOT deleted AND scope = 'library' ORDER BY id DESC"),
      listBoards(user.id),
      activity(30),
      stats(),
      lastSeq(),
    ]);
    return {
      me: meDto(user),
      users,
      channels,
      files: files.map(fileDto),
      boards,
      activity: act,
      stats: st,
      lastSeq: seq,
    };
  });

  // Догоняем пропущенные события после переподключения.
  router.get('/api/events', async ({ query }) => {
    const since = Math.max(0, Number(query.get('since')) || 0);
    const limit = Math.min(Number(query.get('limit')) || 500, 1000);
    return { ...(await eventsSince(since, limit)), lastSeq: await lastSeq() };
  });

  router.get('/api/activity', async ({ query }) => {
    const limit = Math.min(Number(query.get('limit')) || 50, 300);
    return activity(limit, query.get('all') === '1');
  });

  router.get('/api/stats', () => stats());

  router.get(
    '/api/health',
    async () => ({ ok: true, name: 'holo', storage: storageMode(), db: config.databaseUrl ? 'neon' : 'pglite' }),
    { public: true },
  );
}
