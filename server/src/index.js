import http from 'node:http';
import { config } from './config.js';
import { db } from './db.js';
import { createRouter, HttpError, sendJson } from './http.js';
import { bearerToken, getUserByToken } from './auth.js';
import { attachRealtime } from './realtime.js';
import { countOp, flushOps } from './ops.js';
import { startPresenceSweep } from './presence.js';
import authRoutes from './routes/auth.js';
import fileRoutes from './routes/files.js';
import chatRoutes from './routes/chat.js';
import systemRoutes from './routes/system.js';

const router = createRouter();
[authRoutes, fileRoutes, chatRoutes, systemRoutes].forEach((register) => register(router));

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname === '/health') return sendJson(res, 200, { ok: true, name: 'holo' });

  countOp();
  const match = router.match(req.method, url.pathname);
  if (!match) return sendJson(res, 404, { error: 'Не найдено' });

  try {
    let user = null;
    if (!match.route.opts.public) {
      user = getUserByToken(bearerToken(req));
      if (!user) throw new HttpError(401, 'Требуется вход');
    }
    const result = await match.route.handler({ req, res, url, query: url.searchParams, params: match.params, user });
    if (!res.headersSent) sendJson(res, 200, result ?? { ok: true });
  } catch (err) {
    if (!(err instanceof HttpError)) console.error(`[${req.method} ${url.pathname}]`, err);
    if (res.headersSent) return res.destroy();
    const status = err instanceof HttpError ? err.status : 500;
    sendJson(res, status, { error: err instanceof HttpError ? err.message : 'Внутренняя ошибка сервера' });
  }
});

server.requestTimeout = 0; // большие загрузки не обрываем по таймауту
attachRealtime(server);
startPresenceSweep();

server.listen(config.port, config.host, () => {
  const users = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  console.log(`Holo server: http://${config.host}:${config.port}  (данные: ${config.dataDir})`);
  if (!users) console.log('Аккаунтов нет. Создайте: npm run create-user -- <логин> <пароль>');
});

function shutdown() {
  flushOps();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
