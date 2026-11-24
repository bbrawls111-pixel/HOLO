import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { config } from './config.js';
import { HttpError } from './http.js';

/** Потоково сохраняет тело запроса в хранилище. Возвращает ключ, размер и sha256. */
export async function storeStream(req, limit) {
  const declared = Number(req.headers['content-length'] || 0);
  if (declared > limit) throw new HttpError(413, 'Файл слишком большой');

  const key = crypto.randomBytes(16).toString('hex');
  const dest = path.join(config.storageDir, key);
  const hash = crypto.createHash('sha256');
  let size = 0;

  const meter = new Transform({
    transform(chunk, _enc, cb) {
      size += chunk.length;
      if (size > limit) return cb(new HttpError(413, 'Файл слишком большой'));
      hash.update(chunk);
      cb(null, chunk);
    },
  });

  try {
    await pipeline(req, meter, fs.createWriteStream(dest));
  } catch (err) {
    await fs.promises.rm(dest, { force: true });
    throw err instanceof HttpError ? err : new HttpError(400, 'Загрузка прервана');
  }
  return { key, size, sha256: hash.digest('hex') };
}

export const storagePath = (key) => path.join(config.storageDir, key);

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
