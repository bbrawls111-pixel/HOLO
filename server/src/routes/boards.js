import { one, q } from '../db.js';
import { config } from '../config.js';
import { HttpError, readJson, requireInt, requireString } from '../http.js';
import { emit } from '../realtime.js';
import { boardDto } from '../dto.js';

/*
 * «Доски» — графики, деревья и документы. Данные — JSON.
 *  - Общие доски видят оба участника, изменения рассылаются событиями.
 *  - Личные документы (owner_id) видит только автор; события по ним не рассылаются.
 *  - Защита от затирания: клиент присылает baseVersion; если доску уже изменили — 409.
 */
const KINDS = ['chart', 'tree', 'doc'];
const MAX_DATA = 900 * 1024;

const visible = async (id, userId) => {
  const row = await one('SELECT * FROM boards WHERE id = ? AND NOT deleted', id);
  if (!row || (row.owner_id !== null && row.owner_id !== userId)) throw new HttpError(404, 'Не найдено');
  return row;
};

const serialize = (data) => {
  const json = JSON.stringify(data ?? {});
  if (json.length > MAX_DATA) throw new HttpError(413, 'Слишком много данных');
  return json;
};

export async function listBoards(userId) {
  return (await q('SELECT * FROM boards WHERE NOT deleted AND (owner_id IS NULL OR owner_id = ?) ORDER BY updated_at DESC', userId)).map(
    (r) => boardDto(r),
  );
}

export default function register(router) {
  router.get('/api/boards', async ({ user }) => listBoards(user.id));

  router.post('/api/boards', async ({ req, user }) => {
    const body = await readJson(req, config.maxJsonBytes);
    const kind = String(body.kind);
    if (!KINDS.includes(kind)) throw new HttpError(400, 'Неизвестный тип');
    const title = requireString(body.title, 'title', { max: 200 });
    const isPrivate = kind === 'doc' && body.private !== false;
    const now = Date.now();
    const row = await one(
      `INSERT INTO boards (kind, title, data, owner_id, created_by, created_at, updated_by, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
      kind, title, serialize(body.data), isPrivate ? user.id : null, user.id, now, user.id, now,
    );
    const board = boardDto(row);
    if (!board.private) await emit('board.created', { board }, user.id);
    return board;
  });

  router.get('/api/boards/:id', async ({ params, user }) => boardDto(await visible(requireInt(params.id, 'id'), user.id)));

  router.patch('/api/boards/:id', async ({ req, params, user }) => {
    const body = await readJson(req, config.maxJsonBytes);
    const id = requireInt(params.id, 'id');
    const cur = await visible(id, user.id);
    const baseVersion = Number(body.baseVersion);
    if (baseVersion && baseVersion !== cur.version) {
      throw new HttpError(409, 'Документ уже изменил другой участник — загружена свежая версия');
    }
    const title = body.title !== undefined ? requireString(body.title, 'title', { max: 200 }) : cur.title;
    const data = body.data !== undefined ? serialize(body.data) : cur.data;
    // Личный документ можно сделать общим (обратно — нельзя).
    const makeShared = body.shared === true && cur.owner_id !== null;
    const row = await one(
      `UPDATE boards SET title = ?, data = ?, owner_id = ?, version = version + 1, updated_by = ?, updated_at = ?
       WHERE id = ? AND version = ? RETURNING *`,
      title, data, makeShared ? null : cur.owner_id, user.id, Date.now(), id, cur.version,
    );
    if (!row) throw new HttpError(409, 'Документ уже изменил другой участник — загружена свежая версия');
    const board = boardDto(row);
    if (!board.private) await emit(makeShared ? 'board.created' : 'board.updated', { board }, user.id);
    return board;
  });

  router.delete('/api/boards/:id', async ({ params, user }) => {
    const cur = await visible(requireInt(params.id, 'id'), user.id);
    await q('UPDATE boards SET deleted = TRUE, deleted_at = ?, deleted_by = ? WHERE id = ?', Date.now(), user.id, cur.id);
    if (cur.owner_id === null) await emit('board.deleted', { id: cur.id, kind: cur.kind, title: cur.title }, user.id);
    return { ok: true };
  });
}
