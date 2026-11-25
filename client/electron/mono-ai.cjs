'use strict';
/*
 * Mono AI в документах Holo — так же, как в Mono Browser: ответы через бесплатный аккаунт DeepSeek
 * самого пользователя. Человек один раз входит в видимом окне (профиль persist:holo-mono-ai), дальше
 * каждый запрос уходит в скрытое окно chat.deepseek.com: новый чат, инструкция + задача одним
 * сообщением, ждём, пока ответ допишется, и забираем его текстом. Окно закрывается через 2 минуты простоя.
 */
const { BrowserWindow, session } = require('electron');
const fs = require('fs');
const path = require('path');

const HOME = 'https://chat.deepseek.com/';
const PARTITION = 'persist:holo-mono-ai';

/* ---------- скрипты внутри страницы DeepSeek ---------- */
const VISIBLE = `el => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 4 && r.height > 4 && cs.visibility !== 'hidden' && cs.display !== 'none'; }`;
const CAPTCHA = `(() => {
  const vis = ${VISIBLE};
  const re = /captcha|geetest|aliyun|nc_wrapper|turnstile|challenges\\.cloudflare|hcaptcha|recaptcha|tcaptcha|yidun/i;
  if ([...document.querySelectorAll('iframe')].some(f => vis(f) && re.test((f.src || '') + ' ' + f.id + ' ' + f.className + ' ' + (f.title || '')))) return true;
  if ([...document.querySelectorAll('[id*="captcha" i], [class*="captcha" i], [class*="geetest" i], [class*="slider-verify" i]')].some(vis)) return true;
  return /verify you are human|security (check|verification)|подтвердите, что вы (не робот|человек)|slide to (verify|complete)/i.test((document.body && document.body.innerText || '').slice(0, 6000));
})()`;
const FIND_INPUT = `(() => {
  const vis = ${VISIBLE};
  const list = [...document.querySelectorAll('textarea, [contenteditable="true"], [contenteditable=""], [role="textbox"]')]
    .filter(el => vis(el) && !el.closest('[aria-hidden="true"]') && !el.disabled && !el.readOnly);
  list.sort((a, b) => { const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect(); return rb.width * Math.max(rb.height, 30) - ra.width * Math.max(ra.height, 30); });
  return list[0] || null;
})()`;
const PAGE_STATE = `(() => {
  const vis = ${VISIBLE};
  const input = ${FIND_INPUT};
  const loginBtn = [...document.querySelectorAll('button, a, [role="button"]')].filter(vis)
    .some(b => /^(войти|вход|sign in|sign up|log in|login|регистрация)$/i.test((b.innerText || b.getAttribute('aria-label') || '').trim()));
  const text = (document.body && document.body.innerText || '').slice(0, 3000);
  return {
    hasInput: !!input,
    loginPage: /sign_in|sign_up|login/i.test(location.pathname) || loginBtn,
    blocked: /not available in your (country|region)|недоступ\\S* в ваш\\S* (стране|регионе)|access denied/i.test(text),
    captcha: ${CAPTCHA},
  };
})()`;
/* Отметить старые ответы на странице и поставить курсор в поле ввода. */
const PREPARE = `(() => {
  document.querySelectorAll('.ds-markdown, [class*="markdown"]').forEach(el => el.setAttribute('data-holo-seen', '1'));
  window.__holoLast = Date.now();
  if (!window.__holoObs) {
    window.__holoObs = new MutationObserver(() => { window.__holoLast = Date.now(); });
    window.__holoObs.observe(document.body, { subtree: true, childList: true, characterData: true });
  }
  const el = ${FIND_INPUT}; if (!el) return false;
  el.focus();
  return true;
})()`;
const CLICK_SEND = `(() => {
  const vis = ${VISIBLE};
  const input = ${FIND_INPUT}; if (!input) return false;
  let box = input; for (let i = 0; i < 5 && box.parentElement; i++) box = box.parentElement;
  const label = b => (b.getAttribute('aria-label') || '') + ' ' + (b.title || '');
  const buttons = [...box.querySelectorAll('button, [role="button"]')].filter(b => vis(b) && !b.disabled && b.getAttribute('aria-disabled') !== 'true'
    && !/attach|upload|file|файл|прикреп|загруз|deepthink|search|поиск|think|голос|voice|micro/i.test(label(b) + ' ' + (b.innerText || '')));
  const btn = buttons.find(b => /send|отправ|submit/i.test(label(b))) || buttons.find(b => b.getAttribute('type') === 'submit')
    || buttons.filter(b => b.querySelector('svg') && !(b.innerText || '').trim()).pop();
  if (btn) { btn.click(); return true; }
  return false;
})()`;
const isThinkJs = `el => { for (let p = el; p && p !== document.body; p = p.parentElement) if (/think/i.test(typeof p.className === 'string' ? p.className : '')) return true; return false; }`;
const STATUS = `(() => {
  const vis = ${VISIBLE};
  const isThink = ${isThinkJs};
  const md = [...document.querySelectorAll('.ds-markdown')].filter(e => !e.hasAttribute('data-holo-seen') && !isThink(e) && (e.innerText || '').trim()).length;
  const busy = [...document.querySelectorAll('button, [role="button"]')].some(b => vis(b) && /stop|останов|прерв/i.test((b.getAttribute('aria-label') || '') + ' ' + (b.title || '') + ' ' + (b.innerText || '')));
  return { md, busy, quiet: Date.now() - (window.__holoLast || 0), captcha: ${CAPTCHA} };
})()`;
/* Последний новый ответ — обычным текстом: абзацы, заголовки и списки сохраняются, разметка Markdown — нет. */
const EXTRACT = `(() => {
  const isThink = ${isThinkJs};
  const blocks = [...document.querySelectorAll('.ds-markdown, [class*="markdown"]')]
    .filter(el => !el.hasAttribute('data-holo-seen') && !isThink(el) && !el.parentElement.closest('.ds-markdown, [class*="markdown"]'));
  const root = blocks[blocks.length - 1];
  if (!root) return '';
  const out = [];
  const clean = s => (s || '').replace(/[ \\t]+\\n/g, '\\n').trim();
  const list = (el, depth) => {
    let i = parseInt(el.getAttribute('start') || '1', 10);
    for (const li of el.children) {
      if (li.tagName !== 'LI') continue;
      const own = li.cloneNode(true);
      own.querySelectorAll('ul, ol').forEach(n => n.remove());
      out.push('  '.repeat(depth) + (el.tagName === 'OL' ? (i++) + '. ' : '— ') + clean(own.innerText).replace(/\\s*\\n\\s*/g, ' '));
      li.querySelectorAll(':scope > ul, :scope > ol').forEach(n => list(n, depth + 1));
    }
  };
  const walk = el => {
    for (const n of el.children) {
      const t = n.tagName;
      if (/^(BUTTON|SVG|svg|STYLE|SCRIPT)$/.test(t)) continue;
      if (t === 'UL' || t === 'OL') { list(n, 0); out.push(''); }
      else if (t === 'PRE') out.push(clean((n.querySelector('code') || n).innerText), '');
      else if (t === 'HR') out.push('');
      else if (t === 'TABLE') { [...n.querySelectorAll('tr')].forEach(r => out.push([...r.children].map(c => clean(c.innerText)).join(' | '))); out.push(''); }
      else if (/^(P|H[1-6]|BLOCKQUOTE)$/.test(t)) out.push(clean(n.innerText), '');
      else if (n.querySelector('p, ul, ol, pre, table, h1, h2, h3, h4')) walk(n);
      else { const x = clean(n.innerText); if (x) out.push(x, ''); }
    }
  };
  walk(root);
  return out.join('\\n').replace(/\\n{3,}/g, '\\n\\n').trim() || clean(root.innerText);
})()`;

function registerMonoAi({ app, ipcMain, getWindow, send, prepareSession, trackContents, preload }) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const fail = (code, message) => {
    const e = new Error(message);
    e.code = code;
    throw e;
  };
  const flagFile = () => path.join(app.getPath('userData'), 'mono-ai.connected');
  const isConnected = () => {
    try {
      return fs.existsSync(flagFile());
    } catch {
      return false;
    }
  };
  const setConnected = (on) => {
    try {
      if (on) fs.writeFileSync(flagFile(), String(Date.now()));
      else fs.rmSync(flagFile(), { force: true });
    } catch {}
  };
  const ses = () => {
    const s = session.fromPartition(PARTITION);
    prepareSession(s);
    return s;
  };

  function makeWindow(show) {
    const w = new BrowserWindow({
      show,
      width: 1100,
      height: 820,
      title: 'Mono AI — вход в DeepSeek',
      autoHideMenuBar: true,
      backgroundColor: '#ffffff',
      parent: show ? getWindow() ?? undefined : undefined,
      webPreferences: { session: ses(), preload, contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false, backgroundThrottling: false },
    });
    trackContents(w.webContents);
    // Всплывающие окна входа (Google) — только в окне подключения и в том же профиле.
    w.webContents.setWindowOpenHandler(({ url }) =>
      show && /^https:\/\//.test(url)
        ? {
            action: 'allow',
            overrideBrowserWindowOptions: {
              width: 520,
              height: 720,
              autoHideMenuBar: true,
              parent: w,
              webPreferences: { session: ses(), preload, contextIsolation: true, sandbox: true, nodeIntegration: false },
            },
          }
        : { action: 'deny' },
    );
    w.webContents.on('did-create-window', (child) => trackContents(child.webContents));
    w.webContents.on('will-prevent-unload', (e) => e.preventDefault());
    if (!show) w.webContents.setAudioMuted(true);
    return w;
  }

  function js(w, code, ms = 6000) {
    if (!w || w.isDestroyed()) return Promise.reject(new Error('closed'));
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timeout')), ms);
      w.webContents.executeJavaScript(code, true).then(
        (v) => {
          clearTimeout(t);
          resolve(v);
        },
        (e) => {
          clearTimeout(t);
          reject(e);
        },
      );
    });
  }

  /* ---------- подключение аккаунта ---------- */
  let loginWin = null;
  async function connect() {
    if (loginWin && !loginWin.isDestroyed()) {
      loginWin.focus();
      return { connected: false, pending: true };
    }
    const w = (loginWin = makeWindow(true));
    w.loadURL(HOME).catch(() => {});
    let done = false;
    w.on('closed', () => {
      loginWin = null;
      done = true;
    });
    // Ждём, пока на странице чата появится поле ввода (вход завершён), и сами закрываем окно.
    while (!done) {
      await sleep(1000);
      const st = await js(w, PAGE_STATE, 3000).catch(() => null);
      if (st && st.hasInput && !st.loginPage && !st.captcha) {
        setConnected(true);
        await sleep(800);
        if (!w.isDestroyed()) w.close();
        return { connected: true };
      }
    }
    return { connected: isConnected() };
  }

  async function disconnect() {
    setConnected(false);
    if (worker && !worker.isDestroyed()) worker.destroy();
    await ses().clearStorageData().catch(() => {});
    return { connected: false };
  }

  /* ---------- скрытое окно чата ---------- */
  let worker = null;
  let parkTimer = null;
  function getWorker() {
    clearTimeout(parkTimer);
    if (!worker || worker.isDestroyed()) {
      worker = makeWindow(false);
      worker.on('closed', () => (worker = null));
    }
    return worker;
  }
  function park() {
    clearTimeout(parkTimer);
    parkTimer = setTimeout(() => {
      if (worker && !worker.isDestroyed() && !worker.isVisible()) worker.destroy();
    }, 120000);
    parkTimer.unref?.();
  }
  async function showForCaptcha(w) {
    if (w.isVisible()) return;
    w.setTitle('Mono AI — пройдите проверку, окно скроется само');
    w.center();
    w.show();
    w.focus();
  }

  async function openChat(w) {
    await w.loadURL(HOME).catch(() => {});
    let end = Date.now() + 30000;
    let shown = false;
    while (Date.now() < end) {
      const st = await js(w, PAGE_STATE, 3000).catch(() => null);
      if (st && st.captcha) {
        if (!shown) end = Date.now() + 180000;
        shown = true;
        await showForCaptcha(w);
      } else if (st && st.blocked) {
        fail('region', 'DeepSeek недоступен в вашем регионе — попробуйте с VPN или без него.');
      } else if (st && st.hasInput && !st.loginPage) {
        if (shown && !w.isDestroyed()) w.hide();
        return;
      } else if (st && st.loginPage && Date.now() > end - 22000) {
        setConnected(false);
        fail('login', 'Нужно войти в Mono AI заново.');
      }
      await sleep(450);
    }
    if (shown && !w.isDestroyed()) w.hide();
    fail('page', 'Страница DeepSeek не открылась — проверьте интернет и попробуйте ещё раз.');
  }

  const cancelled = new Set();
  async function exchange(w, id, text) {
    if (!(await js(w, PREPARE))) fail('page', 'Не нашёл поле ввода DeepSeek.');
    await w.webContents.insertText(String(text).slice(0, 30000));
    await sleep(400);
    if (!(await js(w, CLICK_SEND).catch(() => false))) {
      w.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
      w.webContents.sendInputEvent({ type: 'char', keyCode: '\r' });
      w.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
    }
    const started = Date.now();
    const end = started + 300000;
    let shown = false;
    let lastPush = 0;
    let lastText = '';
    for (;;) {
      if (cancelled.has(id)) fail('cancelled', 'Отменено');
      const st = await js(w, STATUS, 4000).catch(() => null);
      if (st && st.captcha) {
        shown = true;
        await showForCaptcha(w);
      } else if (shown) {
        shown = false;
        if (!w.isDestroyed()) w.hide();
      }
      if (st && st.md > 0 && Date.now() - lastPush > 500) {
        lastPush = Date.now();
        const part = await js(w, EXTRACT, 4000).catch(() => '');
        if (part && part !== lastText) {
          lastText = part;
          send('holo:monoAi:progress', { id, text: part });
        }
      }
      if (st && st.md > 0 && !st.busy && st.quiet > 2500) break;
      if (st && !st.md && Date.now() - started > 60000 && st.quiet > 30000) break;
      if (Date.now() > end) break;
      await sleep(450);
    }
    const answer = await js(w, EXTRACT, 10000).catch(() => '');
    if (!answer) fail('empty', 'Mono AI не прислал ответ — попробуйте ещё раз.');
    return answer;
  }

  // Запросы идут строго по очереди: окно чата одно.
  let chain = Promise.resolve();
  function ask(id, prompt) {
    const run = chain.then(async () => {
      if (cancelled.has(id)) fail('cancelled', 'Отменено');
      if (!isConnected()) fail('login', 'Сначала подключите Mono AI.');
      const w = getWorker();
      try {
        await openChat(w);
        return { text: await exchange(w, id, prompt) };
      } finally {
        cancelled.delete(id);
        park();
      }
    });
    chain = run.catch(() => {});
    return run;
  }

  const handle = (name, fn) =>
    ipcMain.handle(name, async (e, arg) => {
      const main = getWindow();
      if (!main || e.sender !== main.webContents) return { ok: false, code: 'denied', error: 'Нет доступа' };
      try {
        return { ok: true, ...(await fn(arg || {})) };
      } catch (err) {
        return { ok: false, code: err.code || 'error', error: err.message || String(err) };
      }
    });
  handle('holo:monoAi:status', async () => ({ connected: isConnected() }));
  handle('holo:monoAi:connect', connect);
  handle('holo:monoAi:disconnect', disconnect);
  handle('holo:monoAi:ask', ({ id, prompt }) => {
    if (typeof prompt !== 'string' || !prompt.trim()) fail('empty', 'Пустой запрос');
    return ask(String(id || Date.now()), prompt);
  });
  handle('holo:monoAi:cancel', async ({ id }) => {
    cancelled.add(String(id));
    return {};
  });
}

module.exports = { registerMonoAi, MONO_AI_PARTITION: PARTITION, _scripts: { PAGE_STATE, FIND_INPUT, STATUS, EXTRACT } };
