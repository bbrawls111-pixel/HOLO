import crypto from 'node:crypto';
import { one, q, tx } from '../db.js';
import { config } from '../config.js';
import { HttpError, readBody, readJson, requireString } from '../http.js';
import {
  bearerToken, checkLoginRate, clientIp, createSession, deleteSession, hashPassword, recordFailedLogin, verifyPassword,
} from '../auth.js';

const safeEqual = (a, b) => {
  const x = crypto.createHash('sha256').update(a).digest();
  const y = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(x, y);
};
import { markOffline, markOnline, sweepPresence } from '../presence.js';
import { emit } from '../realtime.js';
import { allUsers, meDto, userDto } from '../dto.js';

const AVATAR_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

export default function register(router) {
  router.post(
    '/api/auth/login',
    async ({ req }) => {
      const ip = clientIp(req);
      if (!(await checkLoginRate(ip))) throw new HttpError(429, 'Слишком много попыток. Подождите 10 минут.');
      const body = await readJson(req, config.maxJsonBytes);
      const login = requireString(body.login, 'login', { max: 64 });
      const password = requireString(body.password, 'password', { max: 256 });
      const user = await one('SELECT * FROM users WHERE lower(login) = lower(?)', login);
      if (!user || !verifyPassword(password, user.pass_hash)) {
        await recordFailedLogin(ip);
        throw new HttpError(401, 'Неверный логин или пароль');
      }
      return { token: await createSession(user.id), user: meDto(user) };
    },
    { public: true },
  );

  // --- Регистрация по коду приглашения (пока аккаунтов меньше maxUsers) ----
  router.get(
    '/api/setup',
    async () => {
      const { n } = await one('SELECT COUNT(*)::int AS n FROM users');
      return { open: !!config.inviteCode && n < config.maxUsers, users: n, maxUsers: config.maxUsers };
    },
    { public: true },
  );

  router.post(
    '/api/setup/register',
    async ({ req }) => {
      const ip = clientIp(req);
      if (!(await checkLoginRate(ip))) throw new HttpError(429, 'Слишком много попыток. Подождите 10 минут.');
      const body = await readJson(req, config.maxJsonBytes);
      const code = String(body.code || '');
      if (!config.inviteCode || !safeEqual(code, config.inviteCode)) {
        await recordFailedLogin(ip);
        throw new HttpError(403, 'Неверный код приглашения');
      }
      const login = requireString(body.login, 'login', { min: 3, max: 32 });
      if (!/^[A-Za-z0-9_.-]+$/.test(login)) throw new HttpError(400, 'Логин: латиница, цифры, _ . -');
      const password = requireString(body.password, 'password', { min: 8, max: 256 });

      const user = await tx(async (t) => {
        await t.q('SELECT pg_advisory_xact_lock(724502)');
        const { n } = await t.one('SELECT COUNT(*)::int AS n FROM users');
        if (n >= config.maxUsers) throw new HttpError(403, 'Регистрация закрыта: оба аккаунта уже созданы');
        if (await t.one('SELECT 1 FROM users WHERE lower(login) = lower(?)', login)) {
          throw new HttpError(409, 'Такой логин уже занят');
        }
        return t.one(
          'INSERT INTO users (login, pass_hash, nickname, created_at) VALUES (?, ?, ?, ?) RETURNING *',
          login, hashPassword(password), login, Date.now(),
        );
      });
      return { token: await createSession(user.id), user: meDto(user) };
    },
    { public: true },
  );

  router.post('/api/auth/logout', async ({ req, user }) => {
    await deleteSession(bearerToken(req));
    await markOffline(user.id);
    return { ok: true };
  });

  // --- Присутствие -------------------------------------------------------
  // При входе клиент шлёт запрос → сервер показывает «онлайн». Дальше раз в 5 минут.
  // Этот же запрос проверяет остальных и возвращает актуальные статусы.
  router.post('/api/presence/online', async ({ user }) => {
    await markOnline(user.id);
    await sweepPresence();
    return { ok: true, intervalMs: config.presenceIntervalMs, users: await allUsers() };
  });

  router.post('/api/presence/offline', async ({ user }) => {
    await markOffline(user.id);
    return { ok: true };
  });

  // --- Профиль ------------------------------------------------------------
  router.get('/api/me', ({ user }) => meDto(user));

  router.get('/api/users', async () => {
    await sweepPresence();
    return allUsers();
  });

  router.patch('/api/me', async ({ req, user }) => {
    const body = await readJson(req, config.maxJsonBytes);
    const nickname = requireString(body.nickname, 'nickname', { min: 2, max: 32 });
    if (/[\x00-\x1f]/.test(nickname)) throw new HttpError(400, 'Недопустимые символы в нике');
    const taken = await one('SELECT id FROM users WHERE lower(nickname) = lower(?) AND id <> ?', nickname, user.id);
    if (taken) throw new HttpError(409, 'Этот ник уже занят');
    await q('UPDATE users SET nickname = ?, setup_done = TRUE WHERE id = ?', nickname, user.id);
    return publishUser(user.id);
  });

  router.post('/api/me/avatar', async ({ req, user }) => {
    const mime = String(req.headers['content-type'] || '').split(';')[0].trim();
    if (!AVATAR_TYPES.includes(mime)) throw new HttpError(415, 'Аватар: PNG, JPG, WEBP или GIF');
    const data = await readBody(req, config.maxAvatarBytes);
    if (!data.length) throw new HttpError(400, 'Пустой файл');
    await q(
      'UPDATE users SET avatar = ?, avatar_mime = ?, avatar_version = avatar_version + 1 WHERE id = ?',
      data,
      mime,
      user.id,
    );
    return publishUser(user.id);
  });

  router.delete('/api/me/avatar', async ({ user }) => {
    await q('UPDATE users SET avatar = NULL, avatar_mime = NULL, avatar_version = avatar_version + 1 WHERE id = ?', user.id);
    return publishUser(user.id);
  });

  router.get('/api/users/:id/avatar', async ({ params, res }) => {
    const row = await one('SELECT avatar, avatar_mime FROM users WHERE id = ?', Number(params.id) || 0);
    if (!row?.avatar_mime || !row.avatar) throw new HttpError(404, 'Нет аватара');
    const data = Buffer.from(row.avatar);
    res.writeHead(200, {
      'Content-Type': row.avatar_mime,
      'Content-Length': data.length,
      'Cache-Control': 'private, max-age=31536000',
    });
    res.end(data);
  });
}

async function publishUser(userId) {
  const row = await one('SELECT * FROM users WHERE id = ?', userId);
  await emit('user.updated', { user: userDto(row) }, userId);
  return meDto(row);
}
