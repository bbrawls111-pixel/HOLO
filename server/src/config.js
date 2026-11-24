import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const localDir = process.env.HOLO_DATA_DIR || path.join(root, 'data');

export const config = {
  port: Number(process.env.HOLO_PORT || process.env.PORT || 4000),
  host: process.env.HOLO_HOST || '0.0.0.0',
  onVercel: !!process.env.VERCEL,

  // Neon Postgres (подключается через Vercel → Storage). Без него — локальный PGlite.
  databaseUrl: process.env.DATABASE_URL || process.env.POSTGRES_URL || '',
  // Для LISTEN нужен прямой (не через пулер) адрес.
  databaseUrlUnpooled:
    process.env.DATABASE_URL_UNPOOLED || process.env.POSTGRES_URL_NON_POOLING || process.env.DATABASE_URL || process.env.POSTGRES_URL || '',

  // Vercel Blob (приватное хранилище). Без него — файлы на локальном диске.
  blobToken: process.env.BLOB_READ_WRITE_TOKEN || '',

  localDir,
  localDbDir: path.join(localDir, 'pglite'),
  localStorageDir: path.join(localDir, 'storage'),

  // Закрытая регистрация: не больше двух аккаунтов.
  maxUsers: Number(process.env.HOLO_MAX_USERS || 2),
  // Код приглашения для первых аккаунтов (из приложения). Пусто — регистрация только через CLI.
  inviteCode: process.env.HOLO_INVITE_CODE || '',

  // Присутствие: клиент шлёт запрос при входе и затем раз в 5 минут.
  // Каждый такой запрос заодно проверяет, кто не отметился, и переводит его в офлайн.
  presenceIntervalMs: 5 * 60 * 1000,
  presenceGraceMs: 60 * 1000,

  monthlyOpsLimit: Number(process.env.HOLO_OPS_LIMIT || 500_000),

  // Без практического лимита: верхняя граница самого Vercel Blob — 5 ТБ на файл.
  maxUploadBytes: Number(process.env.HOLO_MAX_UPLOAD || 5 * 1024 ** 4),
  maxAvatarBytes: 1024 * 1024,
  maxJsonBytes: 1024 * 1024,
};
