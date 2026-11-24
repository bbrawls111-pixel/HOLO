import { one, q, tx } from '../db.js';
import { config } from '../config.js';
import { HttpError, readJson, requireInt, requireString } from '../http.js';
import { emit } from '../realtime.js';
import { fileDto } from '../dto.js';
import {
  mimeFor, newStorageKey, normalizePath, openRead, splitPath, storageMode, storedSize, uploadGrant, writeLocal,
} from '../storage.js';

const getFile = async (id) => {
  const row = await one('SELECT * FROM files WHERE id = ? AND NOT deleted', id);
  if (!row) throw new HttpError(404, 'Файл не найден');
  return row;
};

/** Создаёт папку и её предков внутри транзакции. Возвращает пути новых папок. */
async function ensureFolder(t, folder, userId) {
  const created = [];
  if (!folder) return created;
  const parts = folder.split('/');
  for (let i = 1; i <= parts.length; i++) {
    const p = parts.slice(0, i).join('/');
    const r = await t.q(
      'INSERT INTO folders (path, created_by, created_at) VALUES (?, ?, ?) ON CONFLICT (path) DO NOTHING RETURNING path',
      p,
      userId,
      Date.now(),
    );
    if (r.length) created.push(p);
  }
  return created;
}

const emitFolders = async (paths, userId) => {
  for (const p of paths) await emit('folder.created', { path: p }, userId);
};

const isUnder = (p, folder) => p === folder || p.startsWith(folder + '/');

export default function register(router) {
  router.get('/api/tree', async () => ({
    folders: (await q('SELECT path FROM folders ORDER BY path')).map((r) => r.path),
    files: (await q('SELECT * FROM files WHERE NOT deleted ORDER BY path')).map(fileDto),
  }));

  router.post('/api/folders', async ({ req, user }) => {
    const body = await readJson(req, config.maxJsonBytes);
    const p = normalizePath(requireString(body.path, 'path', { max: 1000 }));
    if (await one('SELECT 1 FROM files WHERE path = ? AND NOT deleted', p)) {
      throw new HttpError(409, 'Уже есть файл с таким именем');
    }
    const created = await tx((t) => ensureFolder(t, p, user.id));
    await emitFolders(created, user.id);
    return { path: p };
  });

  router.delete('/api/folders', async ({ query, user }) => {
    const p = normalizePath(query.get('path') || '');
    const fileIds = await tx(async (t) => {
      const files = (await t.q('SELECT id, folder FROM files WHERE NOT deleted')).filter((f) => isUnder(f.folder, p));
      for (const f of files) await t.q('UPDATE files SET deleted = TRUE WHERE id = ?', f.id);
      for (const row of await t.q('SELECT path FROM folders')) {
        if (isUnder(row.path, p)) await t.q('DELETE FROM folders WHERE path = ?', row.path);
      }
      return files.map((f) => f.id);
    });
    await emit('folder.deleted', { path: p, fileIds }, user.id);
    return { ok: true };
  });

  // ---------------- Загрузка в 3 шага ----------------
  // 1) prepare: сервер выдаёт ключ и (для Vercel Blob) одноразовый токен загрузки;
  // 2) клиент заливает байты напрямую в хранилище;
  // 3) commit: сервер проверяет объект и записывает новую версию файла.
  router.post('/api/files/prepare', async ({ req, user }) => {
    const body = await readJson(req, config.maxJsonBytes);
    const p = normalizePath(requireString(body.path, 'path', { max: 1000 }));
    const size = Number(body.size) || 0;
    if (size > config.maxUploadBytes) {
      throw new HttpError(413, `Файл больше ${Math.round(config.maxUploadBytes / 1024 / 1024)} МБ`);
    }
    if (await one('SELECT 1 FROM folders WHERE path = ?', p)) throw new HttpError(409, 'Это папка');
    const key = newStorageKey();
    await q('INSERT INTO uploads (key, user_id, created_at) VALUES (?, ?, ?)', key, user.id, Date.now());
    return { path: p, ...(await uploadGrant(key, mimeFor(splitPath(p).name))) };
  });

  // Только локальный режим: приём байтов файла сервером.
  router.post('/api/storage/upload', async ({ req, query, user }) => {
    if (storageMode() !== 'local') throw new HttpError(400, 'Загрузка идёт напрямую в Vercel Blob');
    const key = String(query.get('key') || '');
    if (!(await one('SELECT 1 FROM uploads WHERE key = ? AND user_id = ?', key, user.id))) {
      throw new HttpError(403, 'Неизвестная загрузка');
    }
    return { size: await writeLocal(key, req) };
  });

  router.post('/api/files/commit', async ({ req, user }) => {
    const body = await readJson(req, config.maxJsonBytes);
    const key = requireString(body.key, 'key', { max: 100 });
    const p = normalizePath(requireString(body.path, 'path', { max: 1000 }));
    const pending = await one('DELETE FROM uploads WHERE key = ? AND user_id = ? RETURNING key', key, user.id);
    if (!pending) throw new HttpError(403, 'Неизвестная загрузка');
    const size = await storedSize(key);
    if (size === null) throw new HttpError(400, 'Файл не дошёл до хранилища');

    const { folder, name } = splitPath(p);
    const now = Date.now();
    const mime = mimeFor(name);
    const { fileId, created, folders } = await tx(async (t) => {
      const folders = await ensureFolder(t, folder, user.id);
      const existing = await t.one('SELECT * FROM files WHERE path = ? AND NOT deleted FOR UPDATE', p);
      let id;
      let version = 1;
      if (existing) {
        id = existing.id;
        version = existing.version + 1;
        await t.q('UPDATE files SET size = ?, mime = ?, version = ?, updated_by = ?, updated_at = ? WHERE id = ?',
          size, mime, version, user.id, now, id);
      } else {
        id = (await t.one(
          'INSERT INTO files (path, folder, name, size, mime, version, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?) RETURNING id',
          p, folder, name, size, mime, user.id, now,
        )).id;
      }
      await t.q('INSERT INTO file_versions (file_id, version, storage_key, size, user_id, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        id, version, key, size, user.id, now);
      return { fileId: id, created: !existing, folders };
    });

    await emitFolders(folders, user.id);
    const file = fileDto(await getFile(fileId));
    await emit(created ? 'file.created' : 'file.updated', { file }, user.id);
    return { file };
  });

  router.get('/api/files/:id/content', async ({ params, query, res }) => {
    const file = await getFile(requireInt(params.id, 'id'));
    const version = query.get('version') ? requireInt(query.get('version'), 'version') : file.version;
    const ver = await one('SELECT * FROM file_versions WHERE file_id = ? AND version = ?', file.id, version);
    if (!ver) throw new HttpError(404, 'Версия не найдена');
    const stream = await openRead(ver.storage_key);
    if (!stream) throw new HttpError(410, 'Данные файла потеряны');
    res.writeHead(200, {
      'Content-Type': file.mime,
      'Content-Length': ver.size,
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`,
      'Cache-Control': 'private, max-age=31536000, immutable',
    });
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  });

  router.get('/api/files/:id/versions', async ({ params }) => {
    const file = await getFile(requireInt(params.id, 'id'));
    return (await q('SELECT version, size, user_id, note, created_at FROM file_versions WHERE file_id = ? ORDER BY version DESC', file.id))
      .map((v) => ({ version: v.version, size: v.size, userId: v.user_id, note: v.note, createdAt: v.created_at }));
  });

  // Восстановление = новая версия с теми же данными (история не теряется).
  router.post('/api/files/:id/restore', async ({ req, params, user }) => {
    const body = await readJson(req, config.maxJsonBytes);
    const from = requireInt(body.version, 'version');
    const id = requireInt(params.id, 'id');
    await tx(async (t) => {
      const file = await t.one('SELECT * FROM files WHERE id = ? AND NOT deleted FOR UPDATE', id);
      if (!file) throw new HttpError(404, 'Файл не найден');
      const src = await t.one('SELECT * FROM file_versions WHERE file_id = ? AND version = ?', id, from);
      if (!src) throw new HttpError(404, 'Версия не найдена');
      const now = Date.now();
      const version = file.version + 1;
      await t.q('INSERT INTO file_versions (file_id, version, storage_key, size, user_id, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        id, version, src.storage_key, src.size, user.id, `Восстановлено из v${from}`, now);
      await t.q('UPDATE files SET size = ?, version = ?, updated_by = ?, updated_at = ? WHERE id = ?', src.size, version, user.id, now, id);
    });
    const file = fileDto(await getFile(id));
    await emit('file.updated', { file, restoredFrom: from }, user.id);
    return { file };
  });

  router.patch('/api/files/:id', async ({ req, params, user }) => {
    const body = await readJson(req, config.maxJsonBytes);
    const file = await getFile(requireInt(params.id, 'id'));
    const p = normalizePath(requireString(body.path, 'path', { max: 1000 }));
    if (p === file.path) return { file: fileDto(file) };
    if (await one('SELECT 1 FROM files WHERE path = ? AND NOT deleted', p)) {
      throw new HttpError(409, 'Файл с таким путём уже существует');
    }
    const { folder, name } = splitPath(p);
    const folders = await tx(async (t) => {
      const created = await ensureFolder(t, folder, user.id);
      await t.q('UPDATE files SET path = ?, folder = ?, name = ?, mime = ?, updated_by = ?, updated_at = ? WHERE id = ?',
        p, folder, name, mimeFor(name), user.id, Date.now(), file.id);
      return created;
    });
    await emitFolders(folders, user.id);
    const dto = fileDto(await getFile(file.id));
    await emit('file.moved', { file: dto, from: file.path }, user.id);
    return { file: dto };
  });

  router.delete('/api/files/:id', async ({ params, user }) => {
    const file = await getFile(requireInt(params.id, 'id'));
    await q('UPDATE files SET deleted = TRUE WHERE id = ?', file.id);
    await emit('file.deleted', { id: file.id, path: file.path }, user.id);
    return { ok: true };
  });

  // --- Комментарии к ресурсам ---------------------------------------------
  router.get('/api/files/:id/comments', async ({ params }) => {
    const file = await getFile(requireInt(params.id, 'id'));
    return (await q('SELECT * FROM file_comments WHERE file_id = ? ORDER BY id', file.id))
      .map((c) => ({ id: c.id, fileId: c.file_id, userId: c.user_id, text: c.text, createdAt: c.created_at }));
  });

  router.post('/api/files/:id/comments', async ({ req, params, user }) => {
    const body = await readJson(req, config.maxJsonBytes);
    const file = await getFile(requireInt(params.id, 'id'));
    const text = requireString(body.text, 'text', { max: 4000 });
    const now = Date.now();
    const { id } = await one('INSERT INTO file_comments (file_id, user_id, text, created_at) VALUES (?, ?, ?, ?) RETURNING id',
      file.id, user.id, text, now);
    const comment = { id, fileId: file.id, userId: user.id, text, createdAt: now };
    await emit('file.comment', { comment, path: file.path }, user.id);
    return comment;
  });
}
