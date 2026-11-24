import { db } from '../db.js';
import { config } from '../config.js';
import { HttpError, readJson, requireInt, requireString } from '../http.js';
import { emit } from '../realtime.js';
import { messageDto } from '../dto.js';

const getChannel = (id) => {
  const row = db.prepare('SELECT * FROM channels WHERE id = ?').get(id);
  if (!row) throw new HttpError(404, 'Канал не найден');
  return row;
};

const getOwnMessage = (id, userId) => {
  const row = db.prepare('SELECT * FROM messages WHERE id = ?').get(id);
  if (!row) throw new HttpError(404, 'Сообщение не найдено');
  if (row.user_id !== userId) throw new HttpError(403, 'Можно менять только свои сообщения');
  return row;
};

export default function register(router) {
  router.get('/api/channels', () =>
    db.prepare('SELECT id, name FROM channels ORDER BY position, name').all().map((c) => ({ ...c })),
  );

  router.get('/api/channels/:id/messages', ({ params, query }) => {
    const channel = getChannel(params.id);
    const limit = Math.min(Number(query.get('limit')) || 50, 200);
    const before = Number(query.get('before')) || Number.MAX_SAFE_INTEGER;
    const rows = db
      .prepare('SELECT * FROM messages WHERE channel_id = ? AND id < ? ORDER BY id DESC LIMIT ?')
      .all(channel.id, before, limit + 1);
    return { messages: rows.slice(0, limit).reverse().map(messageDto), hasMore: rows.length > limit };
  });

  router.post('/api/channels/:id/messages', async ({ req, params, user }) => {
    const channel = getChannel(params.id);
    const body = await readJson(req, config.maxJsonBytes);
    const fileId = body.fileId ? requireInt(body.fileId, 'fileId') : null;
    const text = fileId && !body.text ? '' : requireString(body.text, 'text', { max: 8000 });
    if (fileId && !db.prepare('SELECT 1 FROM files WHERE id = ? AND deleted = 0').get(fileId)) {
      throw new HttpError(404, 'Вложение не найдено');
    }
    const r = db
      .prepare('INSERT INTO messages (channel_id, user_id, text, file_id, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(channel.id, user.id, text, fileId, Date.now());
    const message = messageDto(db.prepare('SELECT * FROM messages WHERE id = ?').get(Number(r.lastInsertRowid)));
    emit('message.created', { message }, user.id);
    return message;
  });

  router.patch('/api/messages/:id', async ({ req, params, user }) => {
    const row = getOwnMessage(requireInt(params.id, 'id'), user.id);
    const body = await readJson(req, config.maxJsonBytes);
    const text = requireString(body.text, 'text', { max: 8000 });
    db.prepare('UPDATE messages SET text = ?, edited_at = ? WHERE id = ?').run(text, Date.now(), row.id);
    const message = messageDto(db.prepare('SELECT * FROM messages WHERE id = ?').get(row.id));
    emit('message.updated', { message }, user.id);
    return message;
  });

  router.delete('/api/messages/:id', ({ params, user }) => {
    const row = getOwnMessage(requireInt(params.id, 'id'), user.id);
    db.prepare('DELETE FROM messages WHERE id = ?').run(row.id);
    emit('message.deleted', { id: row.id, channelId: row.channel_id }, user.id);
    return { ok: true };
  });
}
