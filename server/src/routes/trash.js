import { one, q, tx } from '../db.js';
import { config } from '../config.js';
import { HttpError, readJson } from '../http.js';
import { emit } from '../realtime.js';
import { boardDto, fileDto } from '../dto.js';
import { removeObject } from '../storage.js';

/*
 * Корзина. Удалённые файлы библиотеки и доски (документы, графики) лежат здесь,
 * пока их не вернут или не удалят навсегда. Личные документы видит только автор.
 */

async function listTrash(userId) {
  const files = await q(
    "SELECT * FROM files WHERE deleted AND NOT purged AND scope = 'library' ORDER BY COALESCE(deleted_at, updated_at) DESC",
  );
  const boards = await q(
    'SELECT * FROM boards WHERE deleted AND (owner_id IS NULL OR owner_id = ?) ORDER BY COALESCE(deleted_at, updated_at) DESC',
    userId,
  );
  return [
    ...files.map((f) => ({
      type: 'file',
      id: f.id,
      title: f.title || f.name,
      kind: 'file',
      file: fileDto(f),
      deletedAt: f.deleted_at ?? f.updated_at,
      deletedBy: f.deleted_by,
    })),
    ...boards.map((b) => ({
      type: 'board',
      id: b.id,
      title: b.title,
      kind: b.kind,
      private: b.owner_id !== null,
      deletedAt: b.deleted_at ?? b.updated_at,
      deletedBy: b.deleted_by,
    })),
  ].sort((a, b) => b.deletedAt - a.deletedAt);
}

/** Выбранные элементы корзины (или все), с проверкой доступа. */
async function pick(body, userId) {
  const all = await listTrash(userId);
  if (body.all === true) return all;
  const want = new Set((Array.isArray(body.items) ? body.items : []).map((i) => `${i.type}:${Number(i.id)}`));
  const found = all.filter((i) => want.has(`${i.type}:${i.id}`));
  if (!found.length) throw new HttpError(404, 'В корзине нет таких элементов');
  return found;
}

export default function register(router) {
  router.get('/api/trash', ({ user }) => listTrash(user.id));

  router.post('/api/trash/restore', async ({ req, user }) => {
    const items = await pick(await readJson(req, config.maxJsonBytes), user.id);
    for (const it of items) {
      if (it.type === 'file') {
        const row = await one('UPDATE files SET deleted = FALSE, deleted_at = NULL, deleted_by = NULL WHERE id = ? RETURNING *', it.id);
        if (row) await emit('file.created', { file: fileDto(row), restored: true }, user.id);
      } else {
        const row = await one('UPDATE boards SET deleted = FALSE, deleted_at = NULL, deleted_by = NULL WHERE id = ? RETURNING *', it.id);
        if (row && row.owner_id === null) await emit('board.created', { board: boardDto(row), restored: true }, user.id);
      }
    }
    await emit('trash.changed', { restored: items.length }, user.id);
    return { restored: items.length };
  });

  router.post('/api/trash/purge', async ({ req, user }) => {
    const items = await pick(await readJson(req, config.maxJsonBytes), user.id);
    const fileIds = items.filter((i) => i.type === 'file').map((i) => i.id);
    const boardIds = items.filter((i) => i.type === 'board').map((i) => i.id);

    const orphanKeys = await tx(async (t) => {
      if (boardIds.length) await t.q('DELETE FROM boards WHERE id = ANY(?::int[]) AND deleted', boardIds);
      if (!fileIds.length) return [];
      await t.q('UPDATE files SET purged = TRUE WHERE id = ANY(?::int[]) AND deleted', fileIds);
      // Данные удаляем, только если на них больше не ссылается ни один живой файл
      // (вложение, сохранённое в библиотеку, делит данные с оригиналом).
      const keys = await t.q(
        `SELECT DISTINCT v.storage_key FROM file_versions v WHERE v.file_id = ANY(?::int[])
         AND NOT EXISTS (SELECT 1 FROM file_versions v2 JOIN files f2 ON f2.id = v2.file_id
                         WHERE v2.storage_key = v.storage_key AND NOT f2.purged)`,
        fileIds,
      );
      return keys.map((k) => k.storage_key);
    });
    for (const key of orphanKeys) await removeObject(key);
    await emit('trash.changed', { purged: items.length }, user.id);
    return { purged: items.length, freedObjects: orphanKeys.length };
  });
}
