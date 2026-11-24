const { app, BrowserWindow, ipcMain, dialog, safeStorage, shell, powerMonitor } = require('electron');
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

function loadAuth() {
  try {
    const raw = JSON.parse(fs.readFileSync(authFile(), 'utf8'));
    auth.serverUrl = raw.serverUrl || '';
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
  if (res.status === 401 && auth.token && p !== '/api/auth/login') handleUnauthorized();
  return res;
}

async function readResult(res) {
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { error: text };
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
  err?.name === 'TimeoutError' ? 'Сервер не отвечает' : `Нет связи с сервером (${err?.cause?.code || err?.message || 'ошибка'})`;

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
let backoff = 1000;
let lastSeq = 0;
let queue = Promise.resolve();

function connectRealtime() {
  disconnectRealtime();
  if (!auth.token) return;
  send('holo:connection', { state: 'connecting' });
  const url = auth.serverUrl.replace(/^http/, 'ws') + '/ws?token=' + encodeURIComponent(auth.token);
  const sock = new WebSocket(url, { handshakeTimeout: 10_000 });
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
    if (res.statusCode === 401) handleUnauthorized();
  });
  sock.on('close', () => {
    if (ws !== sock) return;
    ws = null;
    send('holo:connection', { state: 'offline' });
    scheduleReconnect();
  });
  sock.on('error', () => {});
}

async function handleMessage(msg) {
  if (msg.type === 'hello') {
    backoff = 1000;
    if (lastSeq && msg.lastSeq > lastSeq) await catchUp();
    if (!lastSeq) lastSeq = msg.lastSeq;
    send('holo:connection', { state: 'online', lastSeq });
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
    return { serverUrl: auth.serverUrl, user: null, error: r.status === 401 ? null : r.error, offline: r.status === 0 };
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
  ipcMain.handle('holo:upload', async (_e, { localPath, data, remotePath }) => {
    try {
      const size = localPath ? (await fs.promises.stat(localPath)).size : data.byteLength;
      const prep = await jsonRequest('POST', '/api/files/prepare', { path: remotePath, size });
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
      return await jsonRequest('POST', '/api/files/commit', { key: grant.key, path: grant.path });
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
      return { ok: true };
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

app.on('web-contents-created', (_e, contents) => {
  // Встроенные страницы ИИ: только https и только изолированные разделы persist:ai-*.
  contents.on('will-attach-webview', (event, webPreferences, params) => {
    delete webPreferences.preload;
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
    webPreferences.sandbox = true;
    if (!AI_PARTITION.test(params.partition || '') || !/^https:\/\//.test(params.src || '')) event.preventDefault();
  });

  contents.setWindowOpenHandler(({ url }) => {
    // Всплывающие окна входа (Google/Microsoft OAuth) внутри ИИ-сессии оставляем в её же разделе.
    if (contents.getType() === 'webview' && /^https:\/\//.test(url)) return { action: 'allow' };
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  if (contents.getType() === 'window') {
    contents.on('will-navigate', (event, url) => {
      if (isDev && url.startsWith('http://127.0.0.1:5173')) return;
      if (!url.startsWith('file://')) event.preventDefault();
    });
  }
});

function createWindow() {
  win = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: '#07070c',
    title: 'Holo',
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

app.whenReady().then(() => {
  loadAuth();
  registerIpc();
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
