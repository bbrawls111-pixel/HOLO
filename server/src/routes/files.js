import fs from 'node:fs';
import { db, transaction } from '../db.js';
import { config } from '../config.js';
import { HttpError, readJson, requireInt, requireString } from '../http.js';
import { emit } from '../realtime.js';
import { fileDto } from '../dto.js';
import { mimeFor, normalizePath, splitPath, storagePath, storeStream } from '../storage.js';

const getFile = (id) => {
  const row = db.prepare('SELECT * FROM files WHERE id = ? AND deleted = 0').get(id);
  if (!row) throw new HttpError(404, 'Файл не найден');
  return row;
};

/** Создаёт папку и всех её предков, если их нет. */
function ensureFolder(folder, userId) {
  if (!folder) return;
  const parts = folder.split('/');
  for (let i = 1; i <= parts.length; i++) {
    const p = parts.slice(0, i).join('/');
    const r = db
      .prepare('INSERT OR IGNORE INTO folders (path, created_by, created_at) VALUES (?, ?, ?)')
      .run(p, userId, Date.now());
    if (r.changes) emit('folder.created', { path: p }, userId);
  }
}

const isUnder = (p, folder) => p === folder || p.startsWith(folder + '/');

export default function register(router) {
  router.get('/api/tree', () => ({
    folders: db.prepare('SELECT path FROM folders ORDER BY path').all().map((r) => r.path),
    files: db.prepare('SELECT * FROM files WHERE deleted = 0 ORDER BY path').all().map(fileDto),
  }));

  router.post('/api/folders', async ({ req, user }) => {
    const body = await readJson(req, config.maxJsonBytes);
    const p = normalizePath(requireString(body.path, 'path', { max: 1000 }));
    if (db.prepare('SELECT 1 FROM files WHERE path = ? AND deleted = 0').get(p)) {
      throw new HttpError(409, 'Уже есть файл с таким именем');
    }
    ensureFolder(p, user.id);
    return { path: p };
  });

  router.delete('/api/folders', ({ query, user }) => {
    const p = normalizePath(query.get('path') || '');
    const files = db.prepare('SELECT * FROM files WHERE deleted = 0').all().filter((f) => isUnder(f.folder, p));
    transaction(() => {
      for (const f of files) db.prepare('UPDATE files SET deleted = 1 WHERE id = ?').run(f.id);
      for (const row of db.prepare('SELECT path FROM folders').all()) {
        if (isUnder(row.path, p)) db.prepare('DELETE FROM folders WHERE path = ?').run(row.path);
      }
    });
    emit('folder.deleted', { path: p, fileIds: files.map((f) => f.id) }, user.id);
    return { ok: true };
  });

  // Загрузка: тело запроса — сами байты файла, путь в заголовке X-File-Path.
  // Если файл с таким путём уже есть — создаётся новая версия.
  router.post('/api/files', async ({ req, user }) => {
    const raw = req.headers['x-file-path'];
    if (!raw) throw new HttpError(400, 'Нет заголовка X-File-Path');
    const p = normalizePath(decodeURIComponent(String(raw)));
    const { folder, name } = splitPath(p);
    if (db.prepare('SELECT 1 FROM folders WHERE path = ?').get(p)) throw new HttpError(409, 'Это папка');

    const stored = await storeStream(req, config.maxUploadBytes);
    const now = Date.now();
    const mime = mimeFor(name);

    const { fileId, created } = transaction(() => {
      ensureFolder(folder, user.id);
      const existing = db.prepare('SELECT * FROM files WHERE path = ? AND deleted = 0').get(p);
      let id, version;
      if (existing) {
        id = existing.id;
        version = existing.version + 1;
        db.prepare('UPDATE files SET size = ?, mime = ?, version = ?, updated_by = ?, updated_at = ? WHERE id = ?').run(
          stored.size, mime, version, user.id, now, id,
        );
      } else {
        version = 1;
        id = Number(
          db.prepare(
            'INSERT INTO files (path, folder, name, size, mime, version, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)',
          ).run(p, folder, name, stored.size, mime, user.id, now).lastInsertRowid,
        );
      }
      db.prepare(
        'INSERT INTO file_versions (file_id, version, storage_key, size, sha256, user_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).run(id, version, stored.key, stored.size, stored.sha256, user.id, now);
      return { fileId: id, created: !existing };
    });

    const file = fileDto(getFile(fileId));
    emit(created ? 'file.created' : 'file.updated', { file }, user.id);
    return { file };
  });

  router.get('/api/files/:id/content', ({ params, query, res }) => {
    const file = getFile(requireInt(params.id, 'id'));
    const version = query.get('version') ? requireInt(query.get('version'), 'version') : file.version;
    const ver = db.prepare('SELECT * FROM file_versions WHERE file_id = ? AND version = ?').get(file.id, version);
    if (!ver) throw new HttpError(404, 'Версия не найдена');
    const p = storagePath(ver.storage_key);
    if (!fs.existsSync(p)) throw new HttpError(410, 'Данные файла потеряны');
    res.writeHead(200, {
      'Content-Type': file.mime,
      'Content-Length': ver.size,
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`,
    });
    fs.createReadStream(p).pipe(res);
  });

  router.get('/api/files/:id/versions', ({ params }) => {
    const file = getFile(requireInt(params.id, 'id'));
    return db
      .prepare('SELECT version, size, user_id, note, created_at FROM file_versions WHERE file_id = ? ORDER BY version DESC')
      .all(file.id)
      .map((v) => ({ version: v.version, size: v.size, userId: v.user_id, note: v.note, createdAt: v.created_at }));
  });

  // Восстановление старой версии = новая версия с теми же данными (история не теряется).
  router.post('/api/files/:id/restore', async ({ req, params, user }) => {
    const body = await readJson(req, config.maxJsonBytes);
    const file = getFile(requireInt(params.id, 'id'));
    const from = requireInt(body.version, 'version');
    const src = db.prepare('SELECT * FROM file_versions WHERE file_id = ? AND version = ?').get(file.id, from);
    if (!src) throw new HttpError(404, 'Версия не найдена');
    const now = Date.now();
    const version = file.version + 1;
    transaction(() => {
      db.prepare(
        'INSERT INTO file_versions (file_id, version, storage_key, size, sha256, user_id, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(file.id, version, src.storage_key, src.size, src.sha256, user.id, `Восстановлено из v${from}`, now);
      db.prepare('UPDATE files SET size = ?, version = ?, updated_by = ?, updated_at = ? WHERE id = ?').run(
        src.size, version, user.id, now, file.id,
      );
    });
    const dto = fileDto(getFile(file.id));
    emit('file.updated', { file: dto, restoredFrom: from }, user.id);
    return { file: dto };
  });

  router.patch('/api/files/:id', async ({ req, params, user }) => {
    const body = await readJson(req, config.maxJsonBytes);
    const file = getFile(requireInt(params.id, 'id'));
    const p = normalizePath(requireString(body.path, 'path', { max: 1000 }));
    if (p === file.path) return { file: fileDto(file) };
    if (db.prepare('SELECT 1 FROM files WHERE path = ? AND deleted = 0').get(p)) {
      throw new HttpError(409, 'Файл с таким путём уже существует');
    }
    const { folder, name } = splitPath(p);
    transaction(() => {
      ensureFolder(folder, user.id);
      db.prepare('UPDATE files SET path = ?, folder = ?, name = ?, mime = ?, updated_by = ?, updated_at = ? WHERE id = ?').run(
        p, folder, name, mimeFor(name), user.id, Date.now(), file.id,
      );
    });
    const dto = fileDto(getFile(file.id));
    emit('file.moved', { file: dto, from: file.path }, user.id);
    return { file: dto };
  });

  router.delete('/api/files/:id', ({ params, user }) => {
    const file = getFile(requireInt(params.id, 'id'));
    db.prepare('UPDATE files SET deleted = 1 WHERE id = ?').run(file.id);
    emit('file.deleted', { id: file.id, path: file.path }, user.id);
    return { ok: true };
  });

  // --- Комментарии к ресурсам ---------------------------------------------
  router.get('/api/files/:id/comments', ({ params }) => {
    const file = getFile(requireInt(params.id, 'id'));
    return db
      .prepare('SELECT * FROM file_comments WHERE file_id = ? ORDER BY id')
      .all(file.id)
      .map((c) => ({ id: c.id, fileId: c.file_id, userId: c.user_id, text: c.text, createdAt: c.created_at }));
  });

  router.post('/api/files/:id/comments', async ({ req, params, user }) => {
    const body = await readJson(req, config.maxJsonBytes);
    const file = getFile(requireInt(params.id, 'id'));
    const text = requireString(body.text, 'text', { max: 4000 });
    const now = Date.now();
    const id = Number(
      db.prepare('INSERT INTO file_comments (file_id, user_id, text, created_at) VALUES (?, ?, ?, ?)').run(
        file.id, user.id, text, now,
      ).lastInsertRowid,
    );
    const comment = { id, fileId: file.id, userId: user.id, text, createdAt: now };
    emit('file.comment', { comment, path: file.path }, user.id);
    return comment;
  });
}
