const { app, BrowserWindow, ipcMain, dialog, safeStorage, shell, powerMonitor, session, desktopCapturer } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const WebSocket = require('ws');

const isDev = process.argv.includes('--dev');
const PRESENCE_INTERVAL_MS = 5 * 60 * 1000; // запрос «я онлайн» раз в 5 минут

// Встроенные страницы ИИ лучше работают без «Electron» в User-Agent.
app.userAgentFallback = app.userAgentFallback.replace(/\s?Electron\/\S+/, '').replace(/\s?holo\/\S+/i, '');

let win = null;
const auth = { serverUrl: '', token: '' };

// ---------------------------------------------------------------- хранение сессии
const authFile = () => path.join(app.getPath('userData'), 'holo-auth.json');

const DEFAULT_SERVER = 'https://holo-phi-pied.vercel.app';
const OLD_DEFAULTS = ['http://localhost:4000', 'http://127.0.0.1:4000'];

function loadAuth() {
  try {
    const raw = JSON.parse(fs.readFileSync(authFile(), 'utf8'));
    auth.serverUrl = raw.serverUrl || '';
    // Прежний адрес по умолчанию (локальный сервер) без входа — переводим на Vercel.
    if (!raw.token && OLD_DEFAULTS.includes(auth.serverUrl)) auth.serverUrl = DEFAULT_SERVER;
    if (raw.token) {
      auth.token = raw.enc ? safeStorage.decryptString(Buffer.from(raw.token, 'base64')) : raw.token;
    }
  } catch {
    /* первый запуск */
  }
}

function saveAuth() {
  const enc = safeStorage.isEncryptionAvailable();
  const token = auth.token ? (enc ? safeStorage.encryptString(auth.token).toString('base64') : auth.token) : '';
  fs.writeFileSync(authFile(), JSON.stringify({ serverUrl: auth.serverUrl, enc, token }));
}

// ---------------------------------------------------------------- HTTP к серверу
async function rawRequest(method, p, { body, headers = {}, timeout = 30_000 } = {}) {
  if (!auth.serverUrl) throw new Error('Адрес сервера не задан');
  const h = { ...headers };
  if (auth.token) h.Authorization = `Bearer ${auth.token}`;
  const init = { method, headers: h, signal: AbortSignal.timeout(timeout) };
  if (body !== undefined) {
    init.body = body;
    if (body instanceof ReadableStream) init.duplex = 'half';
  }
  const res = await fetch(auth.serverUrl + p, init);
  // Выходим из аккаунта, только если 401 ответил наш API (JSON), а не страница защиты Vercel.
  if (res.status === 401 && isJson(res) && auth.token && p !== '/api/auth/login') handleUnauthorized();
  return res;
}

const isJson = (res) => (res.headers.get('content-type') || '').includes('application/json');

const VERCEL_PROTECTION_ERROR =
  'Сервер закрыт защитой Vercel. Отключите Settings → Deployment Protection → Vercel Authentication для проекта.';

async function readResult(res) {
  const text = await res.text();
  if (!isJson(res)) {
    if (res.ok) return { ok: true, status: res.status, data: text };
    if ((res.status === 401 || res.status === 403) && /vercel/i.test(text)) {
      return { ok: false, status: res.status, error: VERCEL_PROTECTION_ERROR };
    }
    if (res.status === 404 && /NOT_FOUND|DEPLOYMENT_NOT_FOUND/.test(text)) {
      return { ok: false, status: res.status, error: 'По этому адресу нет сервера Holo. Проверьте адрес или деплой на Vercel.' };
    }
    return { ok: false, status: res.status, error: `Ошибка сервера ${res.status}` };
  }
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) return { ok: false, status: res.status, error: data?.error || `Ошибка ${res.status}` };
  return { ok: true, status: res.status, data };
}

async function jsonRequest(method, p, body, opts = {}) {
  try {
    const res = await rawRequest(method, p, {
      ...opts,
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    });
    return await readResult(res);
  } catch (err) {
    return { ok: false, status: 0, error: networkError(err) };
  }
}

const networkError = (err) =>
  err?.name === 'TimeoutError'
    ? `Сервер ${auth.serverUrl} не отвечает`
    : `Нет связи с сервером ${auth.serverUrl} (${err?.cause?.code || err?.message || 'ошибка'})`;

const send = (channel, payload) => win && !win.isDestroyed() && win.webContents.send(channel, payload);

// ---------------------------------------------------------------- присутствие
let presenceTimer = null;

async function sendOnline() {
  if (!auth.token) return;
  // Ответ содержит актуальные статусы обоих участников — это и есть проверка онлайна раз в 5 минут.
  const r = await jsonRequest('POST', '/api/presence/online');
  if (r.ok && r.data?.users) send('holo:presence', r.data.users);
}

function startPresence() {
  stopPresence();
  sendOnline(); // при входе — сразу «онлайн»
  presenceTimer = setInterval(sendOnline, PRESENCE_INTERVAL_MS);
}

function stopPresence() {
  clearInterval(presenceTimer);
  presenceTimer = null;
}

// ---------------------------------------------------------------- WebSocket (только приём событий)
let ws = null;
let reconnectTimer = null;
let offlineTimer = null;
let backoff = 1000;
let lastSeq = 0;
let connState = 'connecting';
let queue = Promise.resolve();

function setConnection(state) {
  clearTimeout(offlineTimer);
  if (state === connState) return;
  connState = state;
  send('holo:connection', { state, lastSeq });
}

function connectRealtime({ quiet = false } = {}) {
  disconnectRealtime();
  if (!auth.token) return;
  if (!quiet) setConnection('connecting');
  const url = auth.serverUrl.replace(/^http/, 'ws') + '/ws?token=' + encodeURIComponent(auth.token);
  const sock = new WebSocket(url, { handshakeTimeout: 10_000 });
  const openedAt = Date.now();
  ws = sock;

  sock.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    queue = queue.then(() => handleMessage(msg)).catch(() => {});
  });
  sock.on('unexpected-response', (_req, res) => {
    // 401 от нашего сервера — токен недействителен; 401 с HTML — это защита Vercel.
    const html = String(res.headers['content-type'] || '').includes('text/html');
    if (res.statusCode === 401 && !html) handleUnauthorized();
    res.resume();
    sock.terminate();
  });
  sock.on('close', () => {
    if (ws !== sock) return;
    ws = null;
    // Vercel закрывает WebSocket по истечении времени функции (~5 мин) — это штатно:
    // переподключаемся сразу и не показываем «офлайн», если связь вернулась за пару секунд.
    if (connState === 'online' && Date.now() - openedAt > 30_000) {
      backoff = 1000;
      offlineTimer = setTimeout(() => setConnection('offline'), 8000);
      reconnectTimer = setTimeout(() => connectRealtime({ quiet: true }), 150);
      return;
    }
    setConnection('offline');
    scheduleReconnect();
  });
  sock.on('error', () => {});
}

async function handleMessage(msg) {
  if (msg.type === 'hello') {
    backoff = 1000;
    if (lastSeq && msg.lastSeq > lastSeq) await catchUp();
    if (!lastSeq) lastSeq = msg.lastSeq;
    setConnection('online');
    return;
  }
  if (msg.type === 'ephemeral') return send('holo:event', msg.event);
  if (msg.type === 'event') {
    const ev = msg.event;
    if (ev.seq <= lastSeq) return;
    if (ev.seq > lastSeq + 1) await catchUp();
    if (ev.seq <= lastSeq) return;
    lastSeq = ev.seq;
    send('holo:event', ev);
  }
}

/** Получить пропущенные события (после обрыва связи или сна компьютера). */
async function catchUp() {
  let latest = lastSeq;
  for (let page = 0; page < 5; page++) {
    const r = await jsonRequest('GET', `/api/events?since=${lastSeq}&limit=500`);
    if (!r.ok) return;
    latest = r.data.lastSeq;
    for (const ev of r.data.events) {
      lastSeq = ev.seq;
      send('holo:event', ev);
    }
    if (!r.data.hasMore) return;
  }
  // Пропущено слишком много — проще перезагрузить состояние целиком.
  lastSeq = latest;
  send('holo:resync');
}

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  if (!auth.token) return;
  reconnectTimer = setTimeout(connectRealtime, backoff);
  backoff = Math.min(backoff * 2, 60_000);
}

function disconnectRealtime() {
  clearTimeout(reconnectTimer);
  clearTimeout(offlineTimer);
  if (ws) {
    const s = ws;
    ws = null;
    s.removeAllListeners('close');
    s.terminate();
  }
}

// ---------------------------------------------------------------- сессия
function startSession() {
  lastSeq = 0;
  connState = 'offline'; // чтобы окно точно получило «подключение…» → «в сети»
  startPresence();
  connectRealtime();
}

function endSession() {
  stopPresence();
  disconnectRealtime();
  auth.token = '';
  saveAuth();
}

function handleUnauthorized() {
  if (!auth.token) return;
  endSession();
  send('holo:loggedOut');
}

// ---------------------------------------------------------------- IPC
function registerIpc() {
  ipcMain.handle('holo:getSession', async () => {
    if (!auth.token) return { serverUrl: auth.serverUrl, user: null };
    const r = await jsonRequest('GET', '/api/me');
    if (r.ok) {
      startSession();
      return { serverUrl: auth.serverUrl, user: r.data };
    }
    // Токен не удаляем при сетевой ошибке: после восстановления связи вход не понадобится.
    return { serverUrl: auth.serverUrl, user: null, error: r.status === 401 && !r.error?.includes('Vercel') ? null : r.error, offline: r.status === 0 };
  });

  ipcMain.handle('holo:login', async (_e, { serverUrl, login, password }) => {
    const url = String(serverUrl || '').trim().replace(/\/+$/, '');
    if (!/^https?:\/\/[^\s]+$/.test(url)) return { ok: false, error: 'Укажите адрес сервера, например http://localhost:4000' };
    endSession();
    auth.serverUrl = url;
    const r = await jsonRequest('POST', '/api/auth/login', { login, password });
    if (!r.ok) {
      saveAuth();
      return r;
    }
    auth.token = r.data.token;
    saveAuth();
    startSession();
    return { ok: true, data: r.data.user };
  });

  // Регистрация по коду приглашения — пока на сервере меньше двух аккаунтов.
  ipcMain.handle('holo:setupInfo', async (_e, { serverUrl }) => {
    const url = String(serverUrl || '').trim().replace(/\/+$/, '');
    if (!/^https?:\/\/[^\s]+$/.test(url)) return { ok: false };
    try {
      const res = await fetch(url + '/api/setup', { signal: AbortSignal.timeout(15_000) });
      return await readResult(res);
    } catch (err) {
      return { ok: false, status: 0, error: networkError(err) };
    }
  });

  ipcMain.handle('holo:register', async (_e, { serverUrl, code, login, password }) => {
    const url = String(serverUrl || '').trim().replace(/\/+$/, '');
    if (!/^https?:\/\/[^\s]+$/.test(url)) return { ok: false, error: 'Укажите адрес сервера' };
    endSession();
    auth.serverUrl = url;
    const r = await jsonRequest('POST', '/api/setup/register', { code, login, password });
    if (!r.ok) {
      saveAuth();
      return r;
    }
    auth.token = r.data.token;
    saveAuth();
    startSession();
    return { ok: true, data: r.data.user };
  });

  ipcMain.handle('holo:logout', async () => {
    await jsonRequest('POST', '/api/auth/logout', undefined, { timeout: 3000 });
    endSession();
    return { ok: true };
  });

  ipcMain.handle('holo:request', (_e, { method, path: p, body }) => {
    if (!/^\/api\//.test(p)) return { ok: false, error: 'Недопустимый путь' };
    return jsonRequest(method, p, body);
  });

  // Загрузка файла в 3 шага: prepare → байты напрямую в хранилище → commit.
  // На Vercel байты идут прямо в Vercel Blob по одноразовому токену, минуя функцию.
  ipcMain.handle('holo:upload', async (_e, { localPath, data, name, scope, title, description, fileId }) => {
    try {
      const size = localPath ? (await fs.promises.stat(localPath)).size : data.byteLength;
      const prep = await jsonRequest('POST', '/api/files/prepare', { name, size });
      if (!prep.ok) return prep;
      const grant = prep.data;

      if (grant.mode === 'blob') {
        const { put } = await import('@vercel/blob');
        await put(grant.key, localPath ? fs.createReadStream(localPath) : Buffer.from(data), {
          access: 'private',
          token: grant.clientToken,
          contentType: 'application/octet-stream',
          addRandomSuffix: false,
          multipart: size > 50 * 1024 * 1024,
        });
      } else {
        const res = await rawRequest('POST', `/api/storage/upload?key=${encodeURIComponent(grant.key)}`, {
          body: localPath ? Readable.toWeb(fs.createReadStream(localPath)) : new Blob([data]),
          timeout: 60 * 60 * 1000,
        });
        const r = await readResult(res);
        if (!r.ok) return r;
      }
      return await jsonRequest('POST', '/api/files/commit', {
        key: grant.key,
        name: grant.name,
        scope: scope === 'chat' ? 'chat' : 'library',
        title,
        description,
        fileId,
      });
    } catch (err) {
      return { ok: false, status: 0, error: err?.message?.startsWith('Vercel Blob') ? err.message : networkError(err) };
    }
  });

  ipcMain.handle('holo:uploadAvatar', async (_e, { data, mime }) => {
    try {
      const res = await rawRequest('POST', '/api/me/avatar', {
        body: new Blob([data]),
        headers: { 'Content-Type': mime },
      });
      return await readResult(res);
    } catch (err) {
      return { ok: false, status: 0, error: networkError(err) };
    }
  });

  ipcMain.handle('holo:fetchBinary', async (_e, { path: p }) => {
    if (!/^\/api\//.test(p)) return { ok: false, error: 'Недопустимый путь' };
    try {
      const res = await rawRequest('GET', p, { timeout: 5 * 60 * 1000 });
      if (!res.ok) return await readResult(res);
      const buf = new Uint8Array(await res.arrayBuffer());
      return { ok: true, mime: res.headers.get('content-type') || 'application/octet-stream', data: buf };
    } catch (err) {
      return { ok: false, status: 0, error: networkError(err) };
    }
  });

  ipcMain.handle('holo:download', async (_e, { fileId, name, version }) => {
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      defaultPath: path.join(app.getPath('downloads'), String(name).replace(/[\\/]/g, '_')),
    });
    if (canceled || !filePath) return { ok: false, canceled: true };
    try {
      const q = version ? `?version=${Number(version)}` : '';
      const res = await rawRequest('GET', `/api/files/${Number(fileId)}/content${q}`, { timeout: 60 * 60 * 1000 });
      if (!res.ok) return await readResult(res);
      await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(filePath));
      shell.showItemInFolder(filePath);
      return { ok: true, path: filePath };
    } catch (err) {
      return { ok: false, error: networkError(err) };
    }
  });

  ipcMain.handle('holo:openExternal', (_e, { url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
  });
}

// ---------------------------------------------------------------- окна
const AI_PARTITION = /^persist:ai-[a-z0-9-]+$/;

// Скачивания со страниц ИИ: файл сохраняется в «Загрузки/Holo», а окно спрашивает,
// добавить ли его в общую библиотеку (с названием и описанием).
const hookedSessions = new WeakSet();
// ---------------------------------------------------------------- «настоящий Chrome» для ИИ-страниц
// Google не пускает во встроенные браузеры: проверяет User-Agent и Client Hints
// (navigator.userAgentData и заголовки sec-ch-ua — у Electron в них нет марки «Google Chrome»).
// Для страниц ИИ и их окон входа подменяем всё это через DevTools-протокол целиком и согласованно.
// Настоящий User-Agent этого Chromium, только без «Electron/…» и имени приложения.
const PLAIN_UA = app.userAgentFallback.replace(/\s?Electron\/\S+/, '').replace(/\s?holo\/\S+/i, '');

// Как в Mono Browser: обычный User-Agent Chrome без «Electron» и без подключения отладчика —
// подключённый DevTools-протокол Google как раз и замечает.
function disguiseAsChrome(contents) {
  try {
    contents.setUserAgent(PLAIN_UA);
  } catch {
    /* contents уже закрыт */
  }
}

function hookAiDownloads(ses) {
  maskChromeHeaders(ses);
  if (hookedSessions.has(ses)) return;
  hookedSessions.add(ses);
  ses.setUserAgent(PLAIN_UA, 'ru-RU,ru,en-US,en');
  ses.on('will-download', (_event, item) => {
    const dir = path.join(app.getPath('downloads'), 'Holo');
    fs.mkdirSync(dir, { recursive: true });
    const base = item.getFilename().replace(/[\\/:*?"<>|]/g, '_') || 'file';
    const ext = path.extname(base);
    let target = path.join(dir, base);
    for (let i = 1; fs.existsSync(target); i++) target = path.join(dir, `${path.basename(base, ext)} (${i})${ext}`);
    item.setSavePath(target);
    item.once('done', (_e, state) => {
      if (state !== 'completed') return;
      send('holo:downloaded', { path: target, name: path.basename(target), size: item.getTotalBytes() });
      captureDownloadedModel(ses, target, item.getTotalBytes(), item.getURL());
    });
  });
}

// ---------------------------------------------------------------- захват 3D-моделей (Meshy)
// Страница Meshy сама загружает модель и текстуры для своего 3D-просмотра. Мы запоминаем
// эти файлы и по запросу скачиваем их заново через ту же сессию — целиком, со всеми текстурами.
const MODEL_RE = /\.(glb|gltf|fbx|obj|usdz|stl|3mf|blend|mtl)$/i;
const TEX_RE = /\.(png|jpe?g|webp|ktx2|tga|exr)$/i;
const TEX_HINT = /(texture|base_?colou?r|albedo|diffuse|normal|metallic|roughness|occlusion|emissive|_tex|basecolor|pbr)/i;
const captures = new Map(); // partition -> Map(id -> item)
const hookedCapture = new WeakSet();

function header(headers, name) {
  if (!headers) return '';
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name);
  return key ? String(headers[key][0] ?? '') : '';
}

function captureGroup(u) {
  // .../tasks/<id>/output/model.glb → группа по каталогу задачи
  const parts = u.pathname.split('/').filter(Boolean);
  parts.pop();
  const task = parts.find((p) => /^[0-9a-f-]{16,}$/i.test(p)) || parts[parts.length - 1] || u.hostname;
  return { key: u.hostname + '/' + parts.join('/'), label: task.slice(0, 12) };
}

/**
 * Модель, скачанная кнопкой «Скачать» на сайте (Meshy, Mixamo), попадает в панель 3D:
 * её можно сразу сконвертировать в другой формат и оптимизировать.
 */
const LOADABLE_RE = /\.(glb|gltf|fbx|obj|stl)$/i;
function captureDownloadedModel(ses, filePath, size, sourceUrl) {
  const partition = partitionBySession.get(ses);
  if (!partition || !/^persist:ai-(meshy|mixamo)-/.test(partition) || !LOADABLE_RE.test(filePath)) return;
  if (!captures.has(partition)) captures.set(partition, new Map());
  const map = captures.get(partition);
  // Ту же загрузку мог поймать и сетевой перехватчик — оставляем одну запись (локальный файл).
  try {
    const u = new URL(sourceUrl);
    map.delete(u.origin + u.pathname);
  } catch {
    /* blob: / data: — дубля нет */
  }
  const id = 'file:' + filePath;
  map.set(id, {
    id,
    url: '',
    localPath: filePath,
    name: path.basename(filePath),
    kind: 'model',
    size: size || fs.statSync(filePath).size,
    group: 'downloads',
    groupLabel: 'Скачано с сайта',
    at: Date.now(),
  });
  send('holo:captured', { partition, items: listCaptures(partition) });
}

function listCaptures(partition) {
  return [...(captures.get(partition)?.values() ?? [])].sort((a, b) => b.at - a.at);
}

function hookCapture(ses, partition) {
  if (!/^persist:ai-(meshy|mixamo)-/.test(partition) || hookedCapture.has(ses)) return;
  hookedCapture.add(ses);
  ses.webRequest.onCompleted({ urls: ['https://*/*'] }, (d) => {
    try {
      if (d.method !== 'GET' || d.statusCode < 200 || d.statusCode >= 300) return;
      const u = new URL(d.url);
      const file = decodeURIComponent(u.pathname.split('/').pop() || '');
      const ctype = header(d.responseHeaders, 'content-type');
      // Meshy отдаёт модель для просмотра зашифрованной (.meshy) — её не открыть; подсказываем «Скачать».
      const isLocked = /\.meshy$/i.test(file);
      const isModel = !isLocked && (MODEL_RE.test(file) || /^model\//i.test(ctype));
      const isTex = !isModel && !isLocked && TEX_RE.test(file) && TEX_HINT.test(u.pathname);
      if (!isModel && !isTex && !isLocked) return;
      if (!captures.has(partition)) captures.set(partition, new Map());
      const map = captures.get(partition);
      const id = u.origin + u.pathname; // без подписи в query — один файл не дублируется
      const group = captureGroup(u);
      map.set(id, {
        id,
        url: d.url,
        name: file || 'model.glb',
        kind: isLocked ? 'locked' : isModel ? 'model' : 'texture',
        size: Number(header(d.responseHeaders, 'content-length')) || 0,
        group: group.key,
        groupLabel: group.label,
        at: Date.now(),
      });
      send('holo:captured', { partition, items: listCaptures(partition) });
    } catch {
      /* ignore */
    }
  });
}

async function fetchTo(ses, url, dest) {
  const res = await ses.fetch(url);
  if (!res.ok) throw new Error(`Не удалось скачать ${path.basename(dest)} (${res.status}). Обновите страницу модели и попробуйте снова.`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(dest));
  return dest;
}

/** Для .gltf скачиваем и внешние зависимости (буферы, текстуры) с сохранением относительных путей. */
async function fetchGltfDeps(ses, gltfUrl, gltfPath, saved) {
  let json;
  try {
    json = JSON.parse(fs.readFileSync(gltfPath, 'utf8'));
  } catch {
    return;
  }
  const uris = [...(json.buffers ?? []), ...(json.images ?? [])].map((x) => x.uri).filter((x) => x && !x.startsWith('data:'));
  for (const rel of new Set(uris)) {
    const safe = decodeURIComponent(rel).replace(/\.\.[\\/]/g, '').replace(/^[\\/]+/, '');
    const dest = path.join(path.dirname(gltfPath), safe);
    if (!dest.startsWith(path.dirname(gltfPath))) continue;
    saved.push(await fetchTo(ses, new URL(rel, gltfUrl).toString(), dest));
  }
}

/**
 * OBJ: материал (.mtl) указан в самом файле (mtllib), текстуры — в .mtl (map_Kd, map_Bump, norm …).
 * Ищем .mtl среди пойманного или рядом с .obj по тому же адресу, затем качаем все текстуры из него.
 */
async function fetchObjDeps(ses, item, groupItems, objPath, saved) {
  const objText = fs.readFileSync(objPath, 'utf8');
  const dir = path.dirname(objPath);
  const mtlNames = [...objText.matchAll(/^mtllib\s+(.+)$/gm)].map((m) => m[1].trim());
  if (!mtlNames.length) mtlNames.push(path.basename(item.name, path.extname(item.name)) + '.mtl');
  for (const name of mtlNames) {
    const captured = groupItems.find((x) => x.name === path.basename(name));
    const url = captured ? captured.url : new URL(name, item.url).toString();
    const dest = path.join(dir, name.replace(/\.\.[\\/]/g, ''));
    try {
      saved.push(await fetchTo(ses, url, dest));
    } catch {
      continue; // .mtl может не существовать — тогда модель без материала
    }
    const mtl = fs.readFileSync(dest, 'utf8');
    const maps = [...mtl.matchAll(/^\s*(?:map_\w+|bump|norm|disp|refl)\s+(?:-\S+\s+\S+\s+)*(.+?)\s*$/gim)].map((m) => m[1]);
    for (const rel of new Set(maps)) {
      const texDest = path.join(dir, rel.replace(/\.\.[\\/]/g, '').replace(/^[\\/]+/, ''));
      if (saved.includes(texDest) || !texDest.startsWith(dir)) continue;
      const cap = groupItems.find((x) => x.name === path.basename(rel));
      try {
        saved.push(await fetchTo(ses, cap ? cap.url : new URL(rel, url).toString(), texDest));
      } catch {
        /* текстура недоступна — пропускаем */
      }
    }
  }
}

// ---------------------------------------------------------------- вход в отдельном окне
// Как в коннекторах Mono AI: сайт открывается в обычном окне с тем же профилем (partition),
// а не во встроенной странице. Окна входа Google открываются из него в том же профиле.
// Куки общие, поэтому после закрытия окна встроенная страница уже авторизована.
const loginWindows = new Map();
const partitionBySession = new WeakMap();
const GOOGLE_LOGIN_RE = /^https:\/\/accounts\.google\.com\//;

// Google пускает вход только «настоящим» браузерам. Окно входа представляется полноценным
// Google Chrome: бренд в заголовках Sec-CH-UA (здесь) и в странице (login-preload.cjs).
// Проверено на рандомном gmail: 9 из 9 попыток прошли, без этого — блок «небезопасный браузер».
const LOGIN_PRELOAD = path.join(__dirname, 'login-preload.cjs');
const loginContents = new Set(); // id webContents окон входа и их всплывающих окон
const maskedSessions = new WeakSet();
const CHROME_FULL = process.versions.chrome;
const CHROME_MAJOR = CHROME_FULL.split('.')[0];
const SEC_CH_UA = `"Google Chrome";v="${CHROME_MAJOR}", "Chromium";v="${CHROME_MAJOR}", "Not)A;Brand";v="24"`;
const SEC_CH_UA_FULL = `"Google Chrome";v="${CHROME_FULL}", "Chromium";v="${CHROME_FULL}", "Not)A;Brand";v="24.0.0.0"`;

/** Во всех ИИ-сессиях заголовки браузера — как у Google Chrome (у Electron там нет бренда Chrome). */
function maskChromeHeaders(ses) {
  if (maskedSessions.has(ses)) return;
  maskedSessions.add(ses);
  ses.webRequest.onBeforeSendHeaders((details, cb) => {
    const h = details.requestHeaders;
    for (const k of Object.keys(h)) {
      if (/^sec-ch-ua$/i.test(k)) h[k] = SEC_CH_UA;
      else if (/^sec-ch-ua-full-version-list$/i.test(k)) h[k] = SEC_CH_UA_FULL;
    }
    cb({ requestHeaders: h });
  });
}

function trackLoginContents(wc) {
  const id = wc.id;
  loginContents.add(id);
  wc.setUserAgent(PLAIN_UA);
  wc.once('destroyed', () => loginContents.delete(id));
}

function registerLoginWindow() {
  ipcMain.handle('holo:openLoginWindow', (_e, opts) => openLoginWindow(opts));
}

function openLoginWindow({ partition, url, title }) {
  {
    if (!AI_PARTITION.test(partition || '') || !/^https:\/\//.test(url || '')) return { ok: false };
    const existing = loginWindows.get(partition);
    if (existing && !existing.isDestroyed()) {
      existing.focus();
      return { ok: true };
    }
    const ses = session.fromPartition(partition);
    hookAiDownloads(ses);
    const w = new BrowserWindow({
      width: 1100,
      height: 820,
      title: `Вход — ${String(title || 'Holo').slice(0, 60)}`,
      autoHideMenuBar: true,
      backgroundColor: '#ffffff',
      parent: win ?? undefined,
      webPreferences: { partition, preload: LOGIN_PRELOAD, contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false },
    });
    maskChromeHeaders(ses);
    trackLoginContents(w.webContents);
    w.webContents.setWindowOpenHandler(({ url: u }) =>
      /^https:\/\//.test(u) || u === 'about:blank'
        ? {
            action: 'allow',
            overrideBrowserWindowOptions: {
              width: 520,
              height: 720,
              autoHideMenuBar: true,
              parent: w,
              webPreferences: { partition, preload: LOGIN_PRELOAD, contextIsolation: true, sandbox: true, nodeIntegration: false },
            },
          }
        : { action: 'deny' },
    );
    w.webContents.on('did-create-window', (child) => trackLoginContents(child.webContents));
    loginWindows.set(partition, w);
    w.on('closed', () => {
      loginWindows.delete(partition);
      send('holo:loginWindowClosed', { partition });
    });
    w.loadURL(url).catch(() => {});
    return { ok: true };
  }
}

function registerCaptureIpc() {
  // Байты пойманной модели — для конвертации в другой формат в окне Holo.
  ipcMain.handle('holo:capturedFetch', async (_e, { partition, id }) => {
    if (!AI_PARTITION.test(partition)) return { ok: false, error: 'Недопустимая сессия' };
    const item = captures.get(partition)?.get(id);
    if (!item) return { ok: false, error: 'Файл больше не найден — откройте модель на странице ещё раз' };
    if (item.kind === 'locked') return { ok: false, error: 'Эта модель зашифрована сайтом — нажмите «Скачать» на странице модели' };
    try {
      if (item.localPath) return { ok: true, name: item.name, data: new Uint8Array(fs.readFileSync(item.localPath)) };
      const res = await session.fromPartition(partition).fetch(item.url);
      if (!res.ok) return { ok: false, error: `Не удалось скачать (${res.status}). Обновите страницу модели.` };
      return { ok: true, name: item.name, data: new Uint8Array(await res.arrayBuffer()) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // Сохранить набор файлов (модель + материалы + текстуры) в «Загрузки/Holo/3D/<папка>».
  ipcMain.handle('holo:saveFiles', async (_e, { folder, files }) => {
    try {
      const dir = path.join(app.getPath('downloads'), 'Holo', '3D', String(folder).replace(/[\\/:*?"<>|]/g, '_').slice(0, 80) || 'model');
      const written = [];
      for (const f of files) {
        const rel = String(f.name).replace(/\.\.[\\/]/g, '').replace(/^[\\/]+/, '');
        const dest = path.join(dir, rel);
        if (!dest.startsWith(dir)) continue;
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, Buffer.from(f.data));
        written.push(dest);
      }
      if (written[0]) shell.showItemInFolder(written[0]);
      return { ok: true, path: written[0], dir, files: written.length };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('holo:capturedList', (_e, { partition }) => listCaptures(partition));
  ipcMain.handle('holo:capturedClear', (_e, { partition }) => {
    captures.delete(partition);
    send('holo:captured', { partition, items: [] });
  });
  ipcMain.handle('holo:capturedSave', async (_e, { partition, id }) => {
    if (!AI_PARTITION.test(partition)) return { ok: false, error: 'Недопустимая сессия' };
    const item = captures.get(partition)?.get(id);
    if (!item) return { ok: false, error: 'Файл больше не найден — откройте модель на странице ещё раз' };
    if (item.kind === 'locked') return { ok: false, error: 'Эта модель зашифрована сайтом — нажмите «Скачать» на странице модели' };
    if (item.localPath) {
      if (!fs.existsSync(item.localPath)) return { ok: false, error: 'Файл удалён из «Загрузки/Holo»' };
      shell.showItemInFolder(item.localPath);
      return { ok: true, path: item.localPath, dir: path.dirname(item.localPath), files: 1 };
    }
    const ses = session.fromPartition(partition);
    const groupItems = listCaptures(partition).filter((x) => x.group === item.group);
    const base = path.basename(item.name, path.extname(item.name));
    const dir = path.join(app.getPath('downloads'), 'Holo', '3D', `${item.groupLabel}-${base}`.replace(/[\\/:*?"<>|]/g, '_'));
    const saved = [];
    try {
      const main = await fetchTo(ses, item.url, path.join(dir, item.name));
      saved.push(main);
      if (/\.gltf$/i.test(item.name)) await fetchGltfDeps(ses, item.url, main, saved);
      if (/\.obj$/i.test(item.name)) await fetchObjDeps(ses, item, groupItems, main, saved);
      // Текстуры той же модели — рядом, в папке textures.
      for (const t of groupItems.filter((x) => x.kind === 'texture')) {
        const dest = path.join(dir, 'textures', t.name);
        if (!saved.includes(dest)) saved.push(await fetchTo(ses, t.url, dest));
      }
      shell.showItemInFolder(main);
      return { ok: true, path: main, dir, files: saved.length };
    } catch (err) {
      return { ok: false, error: err.message, files: saved.length };
    }
  });
}

app.on('session-created', (ses) => {
  // Разделы ИИ создаются при первом открытии webview.
  setImmediate(() => {
    try {
      if (ses.storagePath && /ai-/.test(ses.storagePath)) hookAiDownloads(ses);
    } catch {
      /* ignore */
    }
  });
});

app.on('web-contents-created', (_e, contents) => {
  // Встроенные страницы ИИ: только https и только изолированные разделы persist:ai-*.
  contents.on('will-attach-webview', (event, webPreferences, params) => {
    delete webPreferences.preload;
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
    webPreferences.sandbox = true;
    if (!AI_PARTITION.test(params.partition || '') || !/^https:\/\//.test(params.src || '')) return event.preventDefault();
    // Страница ИИ тоже выглядит как настоящий Google Chrome (кнопки Google One Tap и т.п.).
    webPreferences.preload = LOGIN_PRELOAD;
    const ses = session.fromPartition(params.partition);
    partitionBySession.set(ses, params.partition);
    hookAiDownloads(ses);
    hookCapture(ses, params.partition);
  });

  // Страница ИИ или её всплывающее окно (вход через Google/Microsoft и т.п.) — в разделе persist:ai-*.
  const isAiContents = () => contents.getType() === 'webview' || hookedSessions.has(contents.session);

  contents.setWindowOpenHandler(({ url }) => {
    // Окна входа (OAuth) открываем внутри той же ИИ-сессии — тогда вход сохранится.
    // Сайты часто открывают сначала свой адрес (auth.meshy.ai) или about:blank и уже потом ведут на Google,
    // поэтому маскировку под Chrome получает любое такое окно, а не только accounts.google.com.
    if (isAiContents() && (/^https:\/\//.test(url) || url === 'about:blank')) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 520,
          height: 720,
          backgroundColor: '#ffffff',
          autoHideMenuBar: true,
          webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, preload: LOGIN_PRELOAD },
        },
      };
    }
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  // Страницы ИИ (webview) — «настоящий Chrome» с первой же загрузки.
  if (contents.getType() === 'webview') disguiseAsChrome(contents);

  // Окна входа из window.open получают тот же User-Agent (перезагрузка не нужна —
  // она ломает окна, которые сайт сначала открывает как about:blank).
  contents.on('did-create-window', (child) => {
    if (isAiContents()) trackLoginContents(child.webContents);
  });

  // Главное окно Holo никуда не уходит со своей страницы (всплывающих окон ИИ это не касается).
  setImmediate(() => {
    if (contents !== win?.webContents) return;
    contents.on('will-navigate', (event, url) => {
      if (isDev && url.startsWith('http://127.0.0.1:5173')) return;
      if (!url.startsWith('file://')) event.preventDefault();
    });
  });
});

function createWindow() {
  win = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: '#07070c',
    title: 'Holo',
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#07070c', symbolColor: '#9a9ab0', height: 72 },
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: true,
      spellcheck: false,
    },
  });
  win.once('ready-to-show', () => win.show());
  if (isDev) win.loadURL('http://127.0.0.1:5173');
  else win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  win.on('closed', () => (win = null));
}

// ---------------------------------------------------------------- показ экрана в звонке
// Окно Holo само показывает выбор экрана/окна; выбранный источник запоминаем здесь
// и отдаём его в getDisplayMedia (со звуком системы — loopback на Windows).
let pendingScreenSource = null;

function registerScreenShare() {
  ipcMain.handle('holo:screenSources', async () => {
    const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 320, height: 180 }, fetchWindowIcons: true });
    return sources
      .filter((s) => !/^Holo$/.test(s.name))
      .map((s) => ({ id: s.id, name: s.name, screen: s.id.startsWith('screen:'), thumbnail: s.thumbnail.toDataURL(), icon: s.appIcon?.toDataURL() ?? null }));
  });
  ipcMain.handle('holo:setScreenSource', (_e, { id }) => {
    pendingScreenSource = id;
  });
  session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen', 'window'] });
      const source = sources.find((s) => s.id === pendingScreenSource) ?? sources.find((s) => s.id.startsWith('screen:'));
      pendingScreenSource = null;
      if (!source) return callback({});
      callback({ video: source, audio: source.id.startsWith('screen:') ? 'loopback' : undefined });
    } catch {
      callback({});
    }
  });
}

app.whenReady().then(() => {
  loadAuth();
  registerIpc();
  registerCaptureIpc();
  registerScreenShare();
  registerLoginWindow();
  ipcMain.handle('holo:appVersion', () => app.getVersion());
  createWindow();

  // После сна компьютера сразу сообщаем, что снова в сети.
  powerMonitor.on('resume', () => {
    if (!auth.token) return;
    sendOnline();
    if (!ws) connectRealtime();
  });
});

// При выходе — сообщаем серверу «офлайн», чтобы не ждать 5-минутной проверки.
let quitting = false;
app.on('before-quit', async (event) => {
  if (quitting || !auth.token) return;
  event.preventDefault();
  quitting = true;
  stopPresence();
  disconnectRealtime();
  await jsonRequest('POST', '/api/presence/offline', undefined, { timeout: 2000 });
  app.quit();
});

app.on('window-all-closed', () => app.quit());
