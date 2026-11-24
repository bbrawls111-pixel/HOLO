import { db } from './db.js';
import { isOnline, presenceLastSeen } from './presence.js';

export function userDto(row) {
  return {
    id: row.id,
    nickname: row.nickname,
    hasAvatar: !!row.avatar_mime,
    avatarVersion: row.avatar_version,
    online: isOnline(row.id),
    lastSeen: presenceLastSeen(row.id) ?? row.last_seen ?? null,
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
  };
}

export function messageDto(row) {
  let file = null;
  if (row.file_id) {
    const f = db.prepare('SELECT * FROM files WHERE id = ? AND deleted = 0').get(row.file_id);
    if (f) file = fileDto(f);
  }
  return {
    id: row.id,
    channelId: row.channel_id,
    userId: row.user_id,
    text: row.text,
    file,
    createdAt: row.created_at,
    editedAt: row.edited_at,
  };
}

export function allUsers() {
  return db.prepare('SELECT * FROM users ORDER BY id').all().map(userDto);
}
