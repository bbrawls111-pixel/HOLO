import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { config } from './config.js';
import { HttpError } from './http.js';

/*
 * Хранилище файлов.
 *  blob  — Vercel Blob (приватный). Клиент заливает файл напрямую в Blob по
 *          одноразовому токену: тело не проходит через функцию (её лимит 4,5 МБ).
 *  local — папка на диске, для локального запуска без Vercel.
 */
export const storageMode = () => (config.blobToken ? 'blob' : 'local');

export const newStorageKey = () => `files/${crypto.randomBytes(16).toString('hex')}`;

const localPath = (key) => {
  if (!/^files\/[0-9a-f]{32}$/.test(key)) throw new HttpError(400, 'Некорректный ключ');
  return path.join(config.localStorageDir, key.slice(6));
};

/** Данные для загрузки: для Blob — клиентский токен, ограниченный ключом и размером. */
export async function uploadGrant(key, contentType) {
  if (storageMode() === 'local') return { mode: 'local', key };
  const { generateClientTokenFromReadWriteToken } = await import('@vercel/blob/client');
  const clientToken = await generateClientTokenFromReadWriteToken({
    token: config.blobToken,
    pathname: key,
    maximumSizeInBytes: config.maxUploadBytes,
    allowedContentTypes: [contentType, 'application/octet-stream'],
    validUntil: Date.now() + 60 * 60 * 1000,
    addRandomSuffix: false,
  });
  return { mode: 'blob', key, clientToken, access: 'private' };
}

/** Размер загруженного объекта или null, если его нет. */
export async function storedSize(key) {
  if (storageMode() === 'local') {
    try {
      return (await fs.promises.stat(localPath(key))).size;
    } catch {
      return null;
    }
  }
  const { head } = await import('@vercel/blob');
  try {
    return (await head(key, { token: config.blobToken })).size;
  } catch {
    return null;
  }
}

/** Поток для чтения объекта (Node Readable) или null. */
export async function openRead(key) {
  if (storageMode() === 'local') {
    const p = localPath(key);
    return fs.existsSync(p) ? fs.createReadStream(p) : null;
  }
  const { get } = await import('@vercel/blob');
  const result = await get(key, { access: 'private', token: config.blobToken });
  if (!result || result.statusCode !== 200 || !result.stream) return null;
  return Readable.fromWeb(result.stream);
}

/** Локальный режим: приём тела загрузки на диск. */
export async function writeLocal(key, req) {
  const dest = localPath(key);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  let size = 0;
  const meter = new Transform({
    transform(chunk, _enc, cb) {
      size += chunk.length;
      if (size > config.maxUploadBytes) return cb(new HttpError(413, 'Файл слишком большой'));
      cb(null, chunk);
    },
  });
  try {
    await pipeline(req, meter, fs.createWriteStream(dest));
  } catch (err) {
    await fs.promises.rm(dest, { force: true });
    throw err instanceof HttpError ? err : new HttpError(400, 'Загрузка прервана');
  }
  return size;
}

const MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', svg: 'image/svg+xml',
  wav: 'audio/wav', mp3: 'audio/mpeg', ogg: 'audio/ogg', flac: 'audio/flac',
  mp4: 'video/mp4', webm: 'video/webm',
  txt: 'text/plain', md: 'text/markdown', json: 'application/json', xml: 'application/xml',
  js: 'text/javascript', ts: 'text/typescript', css: 'text/css', html: 'text/html',
  csv: 'text/csv', yaml: 'application/yaml', yml: 'application/yaml',
  ttf: 'font/ttf', otf: 'font/otf', woff: 'font/woff', woff2: 'font/woff2',
};

export function mimeFor(name) {
  const ext = name.includes('.') ? name.split('.').pop().toLowerCase() : '';
  return MIME[ext] || 'application/octet-stream';
}

/** Нормализует путь внутри проекта: a/b/c.png. Запрещает .., управляющие символы и т.п. */
export function normalizePath(input) {
  if (typeof input !== 'string') throw new HttpError(400, 'Некорректный путь');
  const parts = input
    .replace(/\\/g, '/')
    .split('/')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!parts.length) throw new HttpError(400, 'Пустой путь');
  for (const p of parts) {
    if (p === '.' || p === '..' || p.length > 200 || /[\x00-\x1f<>:"|?*]/.test(p)) {
      throw new HttpError(400, `Недопустимое имя: ${p}`);
    }
  }
  const out = parts.join('/');
  if (out.length > 1000) throw new HttpError(400, 'Слишком длинный путь');
  return out;
}

export function splitPath(p) {
  const i = p.lastIndexOf('/');
  return i === -1 ? { folder: '', name: p } : { folder: p.slice(0, i), name: p.slice(i + 1) };
}
