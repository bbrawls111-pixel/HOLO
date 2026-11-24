import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = process.env.HOLO_DATA_DIR || path.join(root, 'data');

export const config = {
  port: Number(process.env.HOLO_PORT || 4000),
  host: process.env.HOLO_HOST || '0.0.0.0',
  dataDir,
  storageDir: path.join(dataDir, 'storage'),
  avatarDir: path.join(dataDir, 'avatars'),
  dbFile: path.join(dataDir, 'holo.db'),

  // Закрытая регистрация: не больше двух аккаунтов.
  maxUsers: Number(process.env.HOLO_MAX_USERS || 2),

  // Присутствие: клиент шлёт запрос при входе и затем раз в 5 минут.
  // Сервер раз в 5 минут проверяет, кто не отметился, и переводит в офлайн.
  presenceIntervalMs: 5 * 60 * 1000,
  presenceGraceMs: 60 * 1000,

  monthlyOpsLimit: Number(process.env.HOLO_OPS_LIMIT || 500_000),

  maxUploadBytes: Number(process.env.HOLO_MAX_UPLOAD || 1024 * 1024 * 1024), // 1 ГБ
  maxAvatarBytes: 5 * 1024 * 1024,
  maxJsonBytes: 1024 * 1024,
};
