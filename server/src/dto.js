import { q } from './db.js';
import { isFresh } from './presence.js';

export function userDto(row) {
  return {
    id: row.id,
    nickname: row.nickname,
    hasAvatar: !!row.avatar_mime,
    avatarVersion: row.avatar_version,
    online: isFresh(row),
    lastSeen: row.last_seen ?? null,
  };
}

export function meDto(row) {
  return { ...userDto(row), login: row.login, needsSetup: !row.setup_done };
}

export function fileDto(row) {
  return {
    id: row.id,
    path: row.path,
    folder: row.folder,
    name: row.name,
    size: row.size,
    mime: row.mime,
    version: row.version,
    updatedBy: row.updated_by,
    updatedAt: row.updated_at,
    scope: row.scope ?? 'library',
    title: row.title ?? '',
    description: row.description ?? '',
  };
}

export function boardDto(row, withData = true) {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    data: withData ? JSON.parse(row.data) : undefined,
    private: row.owner_id !== null && row.owner_id !== undefined,
    ownerId: row.owner_id ?? null,
    version: row.version,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedBy: row.updated_by,
    updatedAt: row.updated_at,
  };
}

const USER_COLUMNS = 'id, login, nickname, setup_done, avatar_mime, avatar_version, online, last_seen';

export async function allUsers() {
  return (await q(`SELECT ${USER_COLUMNS} FROM users ORDER BY id`)).map(userDto);
}

export async function messagesDto(rows) {
  const fileIds = [...new Set(rows.map((r) => r.file_id).filter(Boolean))];
  const files = new Map();
  if (fileIds.length) {
    const found = await q('SELECT * FROM files WHERE id = ANY(?::int[]) AND NOT deleted', fileIds);
    found.forEach((f) => files.set(f.id, fileDto(f)));
  }
  return rows.map((row) => ({
    id: row.id,
    channelId: row.channel_id,
    userId: row.user_id,
    text: row.text,
    file: row.file_id ? files.get(row.file_id) ?? null : null,
    createdAt: row.created_at,
    editedAt: row.edited_at,
  }));
}

export async function messageDto(row) {
  return (await messagesDto([row]))[0];
}
