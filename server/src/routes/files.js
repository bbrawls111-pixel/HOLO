import { one, q, tx } from '../db.js';
import { config } from '../config.js';
import { HttpError, readJson, requireInt, requireString } from '../http.js';
import { emit } from '../realtime.js';
import { fileDto } from '../dto.js';
import { mimeFor, newStorageKey, openRead, storageMode, storedSize, uploadGrant, writeLocal } from '../storage.js';

/*
 * Файлы бывают двух видов:
 *  library — общая библиотека (коллекция с названием и описанием), синхронизируется между участниками;
 *  chat    — вложения сообщений: живут в мессенджере и в библиотеку не попадают,
 *            пока их явно не сохранят туда.
 */

const getFile = async (id) => {
  const row = await one('SELECT * FROM files WHERE id = ? AND NOT deleted', id);
  if (!row) throw new HttpError(404, 'Файл не найден');
  return row;
};

const cleanName = (input) => {
  const name = requireString(input, 'name', { max: 200 }).replace(/[\\/]/g, '_');
  if (/[\x00-\x1f]/.test(name) || name === '.' || name === '..') throw new HttpError(400, 'Недопустимое имя файла');
  return name;
};

const optText = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

export default function register(router) {
  router.get('/api/library', async () =>
    (await q("SELECT * FROM files WHERE NOT deleted AND scope = 'library' ORDER BY id DESC")).map(fileDto),
  );

  // ---------------- Загрузка в 3 шага ----------------
  // 1) prepare: сервер выдаёт ключ и (для Vercel Blob) одноразовый токен загрузки;
  // 2) клиент заливает байты напрямую в хранилище;
  // 3) commit: сервер проверяет объект и создаёт файл (или новую версию).
  router.post('/api/files/prepare', async ({ req, user }) => {
    const body = await readJson(req, config.maxJsonBytes);
    const name = cleanName(body.name);
    const size = Number(body.size) || 0;
    if (size > config.maxUploadBytes) {
      throw new HttpError(413, `Файл больше ${Math.round(config.maxUploadBytes / 1024 / 1024)} МБ`);
    }
    const key = newStorageKey();
    await q('INSERT INTO uploads (key, user_id, created_at) VALUES (?, ?, ?)', key, user.id, Date.now());
    return { name, ...(await uploadGrant(key, mimeFor(name))) };
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
    const name = cleanName(body.name);
    const scope = body.scope === 'chat' ? 'chat' : 'library';
    const fileId = body.fileId ? requireInt(body.fileId, 'fileId') : null;
    const pending = await one('DELETE FROM uploads WHERE key = ? AND user_id = ? RETURNING key', key, user.id);
    if (!pending) throw new HttpError(403, 'Неизвестная загрузка');
    const size = await storedSize(key);
    if (size === null) throw new HttpError(400, 'Файл не дошёл до хранилища');

    const now = Date.now();
    const mime = mimeFor(name);
    const id = await tx(async (t) => {
      if (fileId) {
        // Новая версия существующего файла библиотеки.
        const f = await t.one("SELECT * FROM files WHERE id = ? AND NOT deleted AND scope = 'library' FOR UPDATE", fileId);
        if (!f) throw new HttpError(404, 'Файл не найден');
        const version = f.version + 1;
        await t.q('UPDATE files SET name = ?, path = ?, size = ?, mime = ?, version = ?, updated_by = ?, updated_at = ? WHERE id = ?',
          name, name, size, mime, version, user.id, now, f.id);
        await t.q('INSERT INTO file_versions (file_id, version, storage_key, size, user_id, created_at) VALUES (?, ?, ?, ?, ?, ?)',
          f.id, version, key, size, user.id, now);
        return f.id;
      }
      const row = await t.one(
        `INSERT INTO files (path, folder, name, size, mime, version, updated_by, updated_at, scope, title, description)
         VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?) RETURNING id`,
        scope === 'chat' ? `chat/${name}` : name, scope === 'chat' ? 'chat' : '', name, size, mime, user.id, now,
        scope, optText(body.title, 200), optText(body.description, 4000),
      );
      await t.q('INSERT INTO file_versions (file_id, version, storage_key, size, user_id, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        row.id, 1, key, size, user.id, now);
      return row.id;
    });

    const file = fileDto(await getFile(id));
    if (scope === 'library') await emit(fileId ? 'file.updated' : 'file.created', { file }, user.id);
    return { file };
  });

  /** Сохранить вложение из чата (или любой файл) в общую библиотеку. */
  router.post('/api/files/:id/to-library', async ({ req, params, user }) => {
    const body = await readJson(req, config.maxJsonBytes);
    const src = await getFile(requireInt(params.id, 'id'));
    const ver = await one('SELECT * FROM file_versions WHERE file_id = ? AND version = ?', src.id, src.version);
    if (!ver) throw new HttpError(404, 'Версия не найдена');
    const now = Date.now();
    const id = await tx(async (t) => {
      const row = await t.one(
        `INSERT INTO files (path, folder, name, size, mime, version, updated_by, updated_at, scope, title, description)
         VALUES (?, '', ?, ?, ?, 1, ?, ?, 'library', ?, ?) RETURNING id`,
        src.name, src.name, src.size, src.mime, user.id, now, optText(body.title, 200), optText(body.description, 4000),
      );
      await t.q('INSERT INTO file_versions (file_id, version, storage_key, size, user_id, created_at) VALUES (?, 1, ?, ?, ?, ?)',
        row.id, ver.storage_key, ver.size, user.id, now);
      return row.id;
    });
    const file = fileDto(await getFile(id));
    await emit('file.created', { file }, user.id);
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

  // Название, описание, имя файла.
  router.patch('/api/files/:id', async ({ req, params, user }) => {
    const body = await readJson(req, config.maxJsonBytes);
    const file = await getFile(requireInt(params.id, 'id'));
    const name = body.name !== undefined ? cleanName(body.name) : file.name;
    const title = body.title !== undefined ? optText(body.title, 200) : file.title;
    const description = body.description !== undefined ? optText(body.description, 4000) : file.description;
    await q('UPDATE files SET name = ?, path = ?, mime = ?, title = ?, description = ?, updated_by = ?, updated_at = ? WHERE id = ?',
      name, file.scope === 'chat' ? `chat/${name}` : name, mimeFor(name), title, description, user.id, Date.now(), file.id);
    const dto = fileDto(await getFile(file.id));
    if (dto.scope === 'library') await emit('file.updated', { file: dto }, user.id);
    return { file: dto };
  });

  router.delete('/api/files/:id', async ({ params, user }) => {
    const file = await getFile(requireInt(params.id, 'id'));
    await q('UPDATE files SET deleted = TRUE WHERE id = ?', file.id);
    if (file.scope === 'library') await emit('file.deleted', { id: file.id, path: file.title || file.name }, user.id);
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
    await emit('file.comment', { comment, path: file.title || file.name }, user.id);
    return comment;
  });
}
