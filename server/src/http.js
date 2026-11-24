export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function createRouter() {
  const routes = [];
  const add = (method) => (pattern, handler, opts = {}) => {
    const keys = [];
    const re = new RegExp(
      '^' +
        pattern.replace(/:(\w+)/g, (_, k) => {
          keys.push(k);
          return '([^/]+)';
        }) +
        '$',
    );
    routes.push({ method, re, keys, handler, opts });
  };
  return {
    get: add('GET'),
    post: add('POST'),
    patch: add('PATCH'),
    delete: add('DELETE'),
    match(method, pathname) {
      for (const route of routes) {
        if (route.method !== method) continue;
        const m = route.re.exec(pathname);
        if (!m) continue;
        const params = {};
        route.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
        return { route, params };
      }
      return null;
    },
  };
}

export function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

export function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'] || 0);
    if (declared > limit) return reject(new HttpError(413, 'Слишком большой запрос'));
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new HttpError(413, 'Слишком большой запрос'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export async function readJson(req, limit) {
  const buf = await readBody(req, limit);
  if (!buf.length) return {};
  try {
    const data = JSON.parse(buf.toString('utf8'));
    if (!data || typeof data !== 'object') throw new Error();
    return data;
  } catch {
    throw new HttpError(400, 'Некорректный JSON');
  }
}

export function requireString(value, field, { min = 1, max = 10_000 } = {}) {
  if (typeof value !== 'string') throw new HttpError(400, `Поле «${field}» обязательно`);
  const v = value.trim();
  if (v.length < min || v.length > max) throw new HttpError(400, `Поле «${field}»: длина от ${min} до ${max}`);
  return v;
}

export function requireInt(value, field) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, `Некорректное поле «${field}»`);
  return n;
}
