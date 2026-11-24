import { one, q } from '../db.js';
import { config } from '../config.js';
import { HttpError, readJson, requireInt, requireString } from '../http.js';
import { emit } from '../realtime.js';
import { messageDto, messagesDto } from '../dto.js';

const getChannel = async (id) => {
  const row = await one('SELECT * FROM channels WHERE id = ?', id);
  if (!row) throw new HttpError(404, 'Канал не найден');
  return row;
};

const getOwnMessage = async (id, userId) => {
  const row = await one('SELECT * FROM messages WHERE id = ?', id);
  if (!row) throw new HttpError(404, 'Сообщение не найдено');
  if (row.user_id !== userId) throw new HttpError(403, 'Можно менять только свои сообщения');
  return row;
};

export const listChannels = async () => (await q('SELECT id, name FROM channels ORDER BY position, name')).map((c) => ({ ...c }));

export default function register(router) {
  router.get('/api/channels', listChannels);

  router.get('/api/channels/:id/messages', async ({ params, query }) => {
    const channel = await getChannel(params.id);
    const limit = Math.min(Number(query.get('limit')) || 50, 200);
    const before = Number(query.get('before')) || 2147483647;
    const rows = await q('SELECT * FROM messages WHERE channel_id = ? AND id < ? ORDER BY id DESC LIMIT ?', channel.id, before, limit + 1);
    return { messages: await messagesDto(rows.slice(0, limit).reverse()), hasMore: rows.length > limit };
  });

  router.post('/api/channels/:id/messages', async ({ req, params, user }) => {
    const channel = await getChannel(params.id);
    const body = await readJson(req, config.maxJsonBytes);
    const fileId = body.fileId ? requireInt(body.fileId, 'fileId') : null;
    const text = fileId && !body.text ? '' : requireString(body.text, 'text', { max: 8000 });
    if (fileId && !(await one('SELECT 1 FROM files WHERE id = ? AND NOT deleted', fileId))) {
      throw new HttpError(404, 'Вложение не найдено');
    }
    const row = await one(
      'INSERT INTO messages (channel_id, user_id, text, file_id, created_at) VALUES (?, ?, ?, ?, ?) RETURNING *',
      channel.id, user.id, text, fileId, Date.now(),
    );
    const message = await messageDto(row);
    await emit('message.created', { message }, user.id);
    return message;
  });

  router.patch('/api/messages/:id', async ({ req, params, user }) => {
    const row = await getOwnMessage(requireInt(params.id, 'id'), user.id);
    const body = await readJson(req, config.maxJsonBytes);
    const text = requireString(body.text, 'text', { max: 8000 });
    const updated = await one('UPDATE messages SET text = ?, edited_at = ? WHERE id = ? RETURNING *', text, Date.now(), row.id);
    const message = await messageDto(updated);
    await emit('message.updated', { message }, user.id);
    return message;
  });

  router.delete('/api/messages/:id', async ({ params, user }) => {
    const row = await getOwnMessage(requireInt(params.id, 'id'), user.id);
    await q('DELETE FROM messages WHERE id = ?', row.id);
    await emit('message.deleted', { id: row.id, channelId: row.channel_id }, user.id);
    return { ok: true };
  });
}
