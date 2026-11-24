import fs from 'node:fs';
import path from 'node:path';
import { db } from '../db.js';
import { config } from '../config.js';
import { HttpError, readBody, readJson, requireString } from '../http.js';
import {
  bearerToken, checkLoginRate, createSession, deleteSession, recordFailedLogin, verifyPassword,
} from '../auth.js';
import { markOffline, markOnline } from '../presence.js';
import { emit } from '../realtime.js';
import { allUsers, meDto, userDto } from '../dto.js';

const AVATAR_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };

export default function register(router) {
  router.post(
    '/api/auth/login',
    async ({ req }) => {
      const ip = req.socket.remoteAddress || 'unknown';
      if (!checkLoginRate(ip)) throw new HttpError(429, 'Слишком много попыток. Подождите 10 минут.');
      const body = await readJson(req, config.maxJsonBytes);
      const login = requireString(body.login, 'login', { max: 64 });
      const password = requireString(body.password, 'password', { max: 256 });
      const user = db.prepare('SELECT * FROM users WHERE login = ?').get(login);
      if (!user || !verifyPassword(password, user.pass_hash)) {
        recordFailedLogin(ip);
        throw new HttpError(401, 'Неверный логин или пароль');
      }
      return { token: createSession(user.id), user: meDto(user) };
    },
    { public: true },
  );

  router.post('/api/auth/logout', ({ req, user }) => {
    deleteSession(bearerToken(req));
    markOffline(user.id);
    return { ok: true };
  });

  // --- Присутствие -------------------------------------------------------
  // При входе клиент отправляет запрос → сервер показывает «онлайн».
  // Дальше клиент повторяет запрос раз в 5 минут; сервер раз в 5 минут
  // снимает онлайн с тех, кто не отметился.
  router.post('/api/presence/online', ({ user }) => {
    markOnline(user.id);
    return { ok: true, intervalMs: config.presenceIntervalMs };
  });

  router.post('/api/presence/offline', ({ user }) => {
    markOffline(user.id);
    return { ok: true };
  });

  // --- Профиль ------------------------------------------------------------
  router.get('/api/me', ({ user }) => meDto(user));

  router.get('/api/users', () => allUsers());

  router.patch('/api/me', async ({ req, user }) => {
    const body = await readJson(req, config.maxJsonBytes);
    const nickname = requireString(body.nickname, 'nickname', { min: 2, max: 32 });
    if (/[\x00-\x1f]/.test(nickname)) throw new HttpError(400, 'Недопустимые символы в нике');
    const taken = db
      .prepare('SELECT id FROM users WHERE nickname = ? COLLATE NOCASE AND id != ?')
      .get(nickname, user.id);
    if (taken) throw new HttpError(409, 'Этот ник уже занят');
    db.prepare('UPDATE users SET nickname = ?, setup_done = 1 WHERE id = ?').run(nickname, user.id);
    return publishUser(user.id);
  });

  router.post('/api/me/avatar', async ({ req, user }) => {
    const mime = String(req.headers['content-type'] || '').split(';')[0].trim();
    const ext = AVATAR_TYPES[mime];
    if (!ext) throw new HttpError(415, 'Аватар: PNG, JPG, WEBP или GIF');
    const data = await readBody(req, config.maxAvatarBytes);
    if (!data.length) throw new HttpError(400, 'Пустой файл');
    removeAvatarFiles(user.id);
    fs.writeFileSync(path.join(config.avatarDir, `${user.id}.${ext}`), data);
    db.prepare('UPDATE users SET avatar_mime = ?, avatar_version = avatar_version + 1 WHERE id = ?').run(
      mime,
      user.id,
    );
    return publishUser(user.id);
  });

  router.delete('/api/me/avatar', ({ user }) => {
    removeAvatarFiles(user.id);
    db.prepare('UPDATE users SET avatar_mime = NULL, avatar_version = avatar_version + 1 WHERE id = ?').run(
      user.id,
    );
    return publishUser(user.id);
  });

  router.get('/api/users/:id/avatar', ({ params, res }) => {
    const row = db.prepare('SELECT id, avatar_mime FROM users WHERE id = ?').get(Number(params.id));
    if (!row?.avatar_mime) throw new HttpError(404, 'Нет аватара');
    const file = path.join(config.avatarDir, `${row.id}.${AVATAR_TYPES[row.avatar_mime]}`);
    if (!fs.existsSync(file)) throw new HttpError(404, 'Нет аватара');
    const data = fs.readFileSync(file);
    res.writeHead(200, { 'Content-Type': row.avatar_mime, 'Content-Length': data.length, 'Cache-Control': 'private, max-age=31536000' });
    res.end(data);
  });
}

function removeAvatarFiles(userId) {
  for (const ext of Object.values(AVATAR_TYPES)) {
    fs.rmSync(path.join(config.avatarDir, `${userId}.${ext}`), { force: true });
  }
}

function publishUser(userId) {
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  emit('user.updated', { user: userDto(row) }, userId);
  return meDto(row);
}
