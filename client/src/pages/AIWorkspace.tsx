import { ArrowLeft, ArrowRight, ExternalLink, Home, Pencil, Plus, RotateCw, Trash2, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { askText, confirmAction } from '../store';
import { cx } from '../util';
import styles from './AIWorkspace.module.css';

type ProviderId = 'chatgpt' | 'gemini' | 'claude';

const PROVIDERS: Record<ProviderId, { name: string; url: string; color: string }> = {
  chatgpt: { name: 'ChatGPT', url: 'https://chatgpt.com/', color: '#10a37f' },
  gemini: { name: 'Gemini', url: 'https://gemini.google.com/app', color: '#4f8df7' },
  claude: { name: 'Claude', url: 'https://claude.ai/new', color: '#d97757' },
};

interface AiSession {
  id: string;
  provider: ProviderId;
  name: string;
  /** Номер аккаунта: сессии с одним номером делят вход, разные номера полностью изолированы. */
  account: number;
}

const STORAGE_KEY = 'holo.ai.sessions.v1';

const DEFAULT_SESSIONS: AiSession[] = [
  { id: 'chatgpt-arch', provider: 'chatgpt', name: 'Архитектура игры', account: 1 },
  { id: 'chatgpt-bugs', provider: 'chatgpt', name: 'Исправление багов', account: 1 },
  { id: 'gemini-ideas', provider: 'gemini', name: 'Генерация идей', account: 1 },
  { id: 'gemini-mech', provider: 'gemini', name: 'Анализ игровых механик', account: 1 },
  { id: 'claude-main', provider: 'claude', name: 'Основная', account: 1 },
];

function loadSessions(): AiSession[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch {
    /* хранилище недоступно */
  }
  return DEFAULT_SESSIONS;
}

function saveSessions(list: AiSession[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  } catch {
    /* не критично */
  }
}

const partitionOf = (s: AiSession) => `persist:ai-${s.provider}-acc${s.account}`;

/* eslint-disable @typescript-eslint/no-explicit-any */
type WebviewEl = HTMLElement & {
  goBack(): void;
  goForward(): void;
  reload(): void;
  loadURL(url: string): void;
  getURL(): string;
  canGoBack(): boolean;
  canGoForward(): boolean;
};

export function AIWorkspace({ visible }: { visible: boolean }) {
  const [sessions, setSessions] = useState<AiSession[]>(loadSessions);
  const [activeId, setActiveId] = useState<string>(() => loadSessions()[0]?.id ?? '');
  const [opened, setOpened] = useState<Set<string>>(new Set());
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ provider: 'chatgpt' as ProviderId, name: '', account: 1 });
  const views = useRef<Record<string, WebviewEl | null>>({});

  useEffect(() => saveSessions(sessions), [sessions]);

  // Веб-страницу сессии создаём только при первом открытии, дальше держим в памяти.
  useEffect(() => {
    if (visible && activeId && !opened.has(activeId)) setOpened((s) => new Set(s).add(activeId));
  }, [visible, activeId, opened]);

  const active = sessions.find((s) => s.id === activeId);
  const view = () => (active ? views.current[active.id] : null);

  const create = () => {
    const name = form.name.trim() || `${PROVIDERS[form.provider].name} — новая`;
    const s: AiSession = { id: `${form.provider}-${Date.now().toString(36)}`, provider: form.provider, name, account: form.account };
    setSessions((list) => [...list, s]);
    setActiveId(s.id);
    setCreating(false);
    setForm((f) => ({ ...f, name: '' }));
  };

  const rename = async (s: AiSession) => {
    const name = await askText('Название сессии', s.name, 'Сохранить');
    if (name) setSessions((list) => list.map((x) => (x.id === s.id ? { ...x, name } : x)));
  };

  const remove = async (s: AiSession) => {
    if (!(await confirmAction(`Удалить сессию «${s.name}»?`, 'Вход в аккаунт сохранится для других сессий с этим номером.'))) return;
    setSessions((list) => list.filter((x) => x.id !== s.id));
    setOpened((o) => {
      const n = new Set(o);
      n.delete(s.id);
      return n;
    });
    if (activeId === s.id) setActiveId(sessions.find((x) => x.id !== s.id)?.id ?? '');
  };

  return (
    <div className={cx(styles.workspace, !visible && styles.hidden)}>
      <aside className={cx('card', styles.sessions)}>
        <div className={styles.sessionsHead}>
          <span>ИИ-сессии</span>
          <button className="btn ghost sm icon" title="Новая сессия" onClick={() => setCreating((v) => !v)}>
            {creating ? <X size={16} /> : <Plus size={16} />}
          </button>
        </div>

        {creating && (
          <div className={styles.form}>
            <div className={styles.providerPick}>
              {(Object.keys(PROVIDERS) as ProviderId[]).map((p) => (
                <button
                  key={p}
                  className={cx(styles.providerBtn, form.provider === p && styles.providerOn)}
                  onClick={() => setForm((f) => ({ ...f, provider: p }))}
                >
                  <span className={styles.dot} style={{ background: PROVIDERS[p].color }} />
                  {PROVIDERS[p].name}
                </button>
              ))}
            </div>
            <input
              className="input"
              placeholder="Название, напр. «Баланс оружия»"
              value={form.name}
              autoFocus
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              onKeyDown={(e) => e.key === 'Enter' && create()}
            />
            <label className={styles.accountRow}>
              <span className="faint">Аккаунт</span>
              <select
                className="input"
                value={form.account}
                onChange={(e) => setForm((f) => ({ ...f, account: Number(e.target.value) }))}
              >
                {[1, 2, 3, 4].map((n) => (
                  <option key={n} value={n}>
                    Аккаунт {n}
                  </option>
                ))}
              </select>
            </label>
            <button className="btn primary sm" onClick={create}>
              Создать сессию
            </button>
          </div>
        )}

        <div className={styles.list}>
          {(Object.keys(PROVIDERS) as ProviderId[]).map((p) => {
            const group = sessions.filter((s) => s.provider === p);
            if (!group.length) return null;
            return (
              <div key={p} className={styles.group}>
                <div className={styles.groupHead}>
                  <span className={styles.dot} style={{ background: PROVIDERS[p].color }} />
                  {PROVIDERS[p].name}
                </div>
                {group.map((s) => (
                  <div key={s.id} className={cx(styles.session, s.id === activeId && styles.sessionOn)} onClick={() => setActiveId(s.id)}>
                    <span className={styles.sessionName}>{s.name}</span>
                    <span className={styles.acc} title="Номер аккаунта">
                      #{s.account}
                    </span>
                    <span className={styles.sessionBtns}>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          rename(s);
                        }}
                      >
                        <Pencil size={13} />
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          remove(s);
                        }}
                      >
                        <Trash2 size={13} />
                      </button>
                    </span>
                  </div>
                ))}
              </div>
            );
          })}
        </div>
        <p className={styles.note}>
          Каждый номер аккаунта — отдельное изолированное хранилище входа. Ограничения самих сайтов сохраняются.
        </p>
      </aside>

      <section className={cx('card', styles.viewer)}>
        {active ? (
          <>
            <div className={styles.toolbar}>
              <button className="btn ghost sm icon" title="Назад" onClick={() => view()?.goBack()}>
                <ArrowLeft size={16} />
              </button>
              <button className="btn ghost sm icon" title="Вперёд" onClick={() => view()?.goForward()}>
                <ArrowRight size={16} />
              </button>
              <button className="btn ghost sm icon" title="Обновить" onClick={() => view()?.reload()}>
                <RotateCw size={15} />
              </button>
              <button className="btn ghost sm icon" title="Домой" onClick={() => view()?.loadURL(PROVIDERS[active.provider].url)}>
                <Home size={15} />
              </button>
              <div className={styles.title}>
                <span className={styles.dot} style={{ background: PROVIDERS[active.provider].color }} />
                {PROVIDERS[active.provider].name} · {active.name}
              </div>
              <button
                className="btn ghost sm icon"
                title="Открыть в браузере"
                onClick={() => window.holo.openExternal(view()?.getURL() || PROVIDERS[active.provider].url)}
              >
                <ExternalLink size={15} />
              </button>
            </div>
            <div className={styles.frames}>
              {sessions
                .filter((s) => opened.has(s.id))
                .map((s) => (
                  <webview
                    key={s.id}
                    ref={(el: any) => (views.current[s.id] = el)}
                    className={cx(styles.frame, s.id === activeId && styles.frameOn)}
                    src={PROVIDERS[s.provider].url}
                    partition={partitionOf(s)}
                    allowpopups="true"
                  />
                ))}
            </div>
          </>
        ) : (
          <div className="empty">Создайте ИИ-сессию слева.</div>
        )}
      </section>
    </div>
  );
}
