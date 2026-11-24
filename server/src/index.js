import http from 'node:http';
import { config } from './config.js';
import { one, ready } from './db.js';
import { createRouter, HttpError, sendJson } from './http.js';
import { bearerToken, getUserByToken } from './auth.js';
import { attachRealtime } from './realtime.js';
import { countOp } from './ops.js';
import authRoutes from './routes/auth.js';
import fileRoutes from './routes/files.js';
import chatRoutes from './routes/chat.js';
import systemRoutes from './routes/system.js';
import boardRoutes from './routes/boards.js';
import trashRoutes from './routes/trash.js';
import callRoutes from './routes/calls.js';

const router = createRouter();
[authRoutes, fileRoutes, chatRoutes, systemRoutes, boardRoutes, trashRoutes, callRoutes].forEach((register) => register(router));

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname === '/' || url.pathname === '/health') {
    return sendJson(res, 200, { ok: true, name: 'holo', hint: 'Это сервер Holo. Подключайтесь из приложения.' });
  }

  const match = router.match(req.method, url.pathname);
  if (!match) return sendJson(res, 404, { error: 'Не найдено' });

  try {
    await ready();
    const counted = countOp().catch((err) => console.error('[ops]', err.message));
    let user = null;
    if (!match.route.opts.public) {
      user = await getUserByToken(bearerToken(req));
      if (!user) throw new HttpError(401, 'Требуется вход');
    }
    const result = await match.route.handler({ req, res, url, query: url.searchParams, params: match.params, user });
    await counted;
    if (!res.headersSent) sendJson(res, 200, result ?? { ok: true });
  } catch (err) {
    const known = err instanceof HttpError || err.status === 503;
    if (!known) console.error(`[${req.method} ${url.pathname}]`, err);
    if (res.headersSent) return res.destroy();
    sendJson(res, known ? err.status : 500, { error: known ? err.message : 'Внутренняя ошибка сервера' });
  }
});

server.requestTimeout = 0;
attachRealtime(server);

// На Vercel сервер запускает платформа; локально слушаем порт сами.
if (!config.onVercel) {
  server.listen(config.port, config.host, async () => {
    console.log(`Holo server: http://${config.host}:${config.port}`);
    try {
      await ready();
      const { n } = await one('SELECT COUNT(*)::int AS n FROM users');
      console.log(`БД: ${config.databaseUrl ? 'Neon Postgres' : `локальный PGlite (${config.localDbDir})`}`);
      if (!n) console.log('Аккаунтов нет. Создайте: npm run create-user -- <логин> <пароль>');
    } catch (err) {
      console.error('Не удалось подключиться к БД:', err.message);
    }
  });
}

export default server;
