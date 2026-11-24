import {
  ArrowLeft, ArrowRight, Asterisk, AudioLines, Bot, Box, Check, ChevronDown, ExternalLink, Home, Pencil, Plus, RotateCw, Sparkles, Trash2, UserRound,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import logoChatgpt from '../assets/ai/chatgpt.png';
import logoClaude from '../assets/ai/claude.png';
import logoFish from '../assets/ai/fish.png';
import logoGemini from '../assets/ai/gemini.png';
import logoMeshy from '../assets/ai/meshy.png';
import logoMixamo from '../assets/ai/mixamo.png';
import { askText, confirmAction, type AiProvider } from '../store';
import { Capture3DPanel, useCaptured } from './Capture3D';
import { cx } from '../util';
import styles from './AiPane.module.css';

interface ProviderInfo {
  name: string;
  url: string;
  color: string;
  icon: typeof Bot;
  tagline: string;
  logo: string;
  logoBg: string;
  logoPad: number; // отступ логотипа внутри круга, %
}

export const PROVIDERS: Record<AiProvider, ProviderInfo> = {
  chatgpt: { name: 'ChatGPT', url: 'https://chatgpt.com/', color: '#10a37f', icon: Bot, tagline: 'OpenAI', logo: logoChatgpt, logoBg: '#ffffff', logoPad: 18 },
  gemini: { name: 'Gemini', url: 'https://gemini.google.com/app', color: '#4f8df7', icon: Sparkles, tagline: 'Google', logo: logoGemini, logoBg: '#16162a', logoPad: 18 },
  claude: { name: 'Claude', url: 'https://claude.ai/new', color: '#d97757', icon: Asterisk, tagline: 'Anthropic', logo: logoClaude, logoBg: '#ffffff', logoPad: 14 },
  fish: { name: 'Fish Audio', url: 'https://fish.audio/', color: '#0ea5e9', icon: AudioLines, tagline: 'Голос и озвучка', logo: logoFish, logoBg: '#ffffff', logoPad: 6 },
  meshy: { name: 'Meshy', url: 'https://www.meshy.ai/ru', color: '#a3e635', icon: Box, tagline: '3D-модели', logo: logoMeshy, logoBg: '#1b1240', logoPad: 0 },
  mixamo: { name: 'Mixamo', url: 'https://www.mixamo.com/', color: '#ff7a1a', icon: Box, tagline: 'Риггинг и анимации', logo: logoMixamo, logoBg: '#1c1424', logoPad: 20 },
};

/** Круглая аватарка ИИ с настоящим логотипом сервиса. */
export function AiAvatar({ provider, size = 46 }: { provider: AiProvider; size?: number }) {
  const P = PROVIDERS[provider];
  return (
    <span
      className={styles.avatar}
      style={{ width: size, height: size, background: P.logoBg, padding: `${(size * P.logoPad) / 100}px` }}
    >
      <img src={P.logo} alt={P.name} draggable={false} />
    </span>
  );
}
export const PROVIDER_IDS = Object.keys(PROVIDERS) as AiProvider[];

export interface AiSession {
  id: string;
  provider: AiProvider;
  name: string;
  /** Сессии с одним номером делят вход; разные номера — полностью изолированные аккаунты. */
  account: number;
}

interface AiState {
  sessions: AiSession[];
  active: Record<AiProvider, string>;
}

const STORAGE_KEY = 'holo.ai.v2';
const DEFAULT: AiState = {
  sessions: [
    { id: 'chatgpt-main', provider: 'chatgpt', name: 'Основная', account: 1 },
    { id: 'gemini-main', provider: 'gemini', name: 'Основная', account: 1 },
    { id: 'claude-main', provider: 'claude', name: 'Основная', account: 1 },
    { id: 'fish-main', provider: 'fish', name: 'Основная', account: 1 },
    { id: 'meshy-main', provider: 'meshy', name: 'Основная', account: 1 },
    { id: 'mixamo-main', provider: 'mixamo', name: 'Основная', account: 1 },
  ],
  active: {
    chatgpt: 'chatgpt-main',
    gemini: 'gemini-main',
    claude: 'claude-main',
    fish: 'fish-main',
    meshy: 'meshy-main',
    mixamo: 'mixamo-main',
  },
};

function load(): AiState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const saved: AiState = JSON.parse(raw);
      // Новые ИИ (например, Fish Audio) добавляем к уже сохранённому списку.
      for (const d of DEFAULT.sessions) {
        if (!saved.sessions.some((s) => s.provider === d.provider)) {
          saved.sessions.push(d);
          saved.active[d.provider] = d.id;
        }
      }
      return saved;
    }
  } catch {
    /* хранилище недоступно */
  }
  return DEFAULT;
}

const listeners = new Set<() => void>();
let state: AiState = load();
function setAi(next: AiState) {
  state = next;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* не критично */
  }
  listeners.forEach((l) => l());
}

/** Состояние ИИ-сессий (локально на этом компьютере). */
export function useAi() {
  const [, force] = useState(0);
  useEffect(() => {
    const l = () => force((n) => n + 1);
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);
  return state;
}

export const activeSession = (s: AiState, p: AiProvider) =>
  s.sessions.find((x) => x.id === s.active[p]) ?? s.sessions.find((x) => x.provider === p);

const partitionOf = (s: AiSession) => `persist:ai-${s.provider}-acc${s.account}`;

type WebviewEl = HTMLElement & {
  goBack(): void;
  goForward(): void;
  reload(): void;
  loadURL(url: string): void;
  getURL(): string;
};

/** Все открытые ранее сессии остаются смонтированными — переключение мгновенное. */
export function AiPane({ provider, visible }: { provider: AiProvider; visible: boolean }) {
  const ai = useAi();
  const [opened, setOpened] = useState<Set<string>>(new Set());
  const [menu, setMenu] = useState(false);
  const [show3d, setShow3d] = useState(false);
  const views = useRef<Record<string, WebviewEl | null>>({});
  const session = activeSession(ai, provider);
  const P = PROVIDERS[provider];

  useEffect(() => {
    if (visible && session && !opened.has(session.id)) setOpened((s) => new Set(s).add(session.id));
  }, [visible, session, opened]);

  const view = () => (session ? views.current[session.id] : null);

  return (
    <section className={cx(styles.pane, !visible && styles.hidden)}>
      <header className={styles.head}>
        <div className={styles.ident}>
          <AiAvatar provider={provider} size={38} />
          <div>
            <div className={styles.name}>{P.name}</div>
            <div className={styles.sub}>
              {session?.name} · Аккаунт {session?.account}
            </div>
          </div>
        </div>
        <div className={styles.nav}>
          <button className="btn ghost sm icon" title="Назад" onClick={() => view()?.goBack()}>
            <ArrowLeft size={16} />
          </button>
          <button className="btn ghost sm icon" title="Вперёд" onClick={() => view()?.goForward()}>
            <ArrowRight size={16} />
          </button>
          <button className="btn ghost sm icon" title="Обновить" onClick={() => view()?.reload()}>
            <RotateCw size={15} />
          </button>
          <button className="btn ghost sm icon" title="Новый чат" onClick={() => view()?.loadURL(P.url)}>
            <Home size={15} />
          </button>
          <button
            className="btn ghost sm icon"
            title="Открыть в браузере"
            onClick={() => window.holo.openExternal(view()?.getURL() || P.url)}
          >
            <ExternalLink size={15} />
          </button>
          {(provider === 'meshy' || provider === 'mixamo') && session && <Capture3DButton partition={partitionOf(session)} open={show3d} onToggle={() => setShow3d((v) => !v)} />}
          <div className={styles.sessionWrap}>
            <button className={styles.sessionBtn} onClick={() => setMenu((m) => !m)}>
              <UserRound size={15} />
              <span>{session?.name}</span>
              <span className={styles.acc}>#{session?.account}</span>
              <ChevronDown size={15} className={cx(styles.chev, menu && styles.chevOpen)} />
            </button>
            {menu && <SessionMenu provider={provider} onClose={() => setMenu(false)} />}
          </div>
        </div>
      </header>

      <div className={styles.frames}>
        {ai.sessions
          .filter((s) => s.provider === provider && opened.has(s.id))
          .map((s) => (
            <webview
              key={s.id}
              ref={(el: unknown) => (views.current[s.id] = el as WebviewEl | null)}
              className={cx(styles.frame, s.id === session?.id && styles.frameOn)}
              src={PROVIDERS[s.provider].url}
              partition={partitionOf(s)}
              allowpopups="true"
            />
          ))}
        {(provider === 'meshy' || provider === 'mixamo') && session && show3d && <Capture3DPanel partition={partitionOf(session)} onClose={() => setShow3d(false)} />}
      </div>
    </section>
  );
}

function Capture3DButton({ partition, open, onToggle }: { partition: string; open: boolean; onToggle: () => void }) {
  const items = useCaptured(partition);
  const models = items.filter((i) => i.kind === 'model').length;
  return (
    <button className={cx(styles.capBtn, open && styles.capBtnOn, models > 0 && styles.capBtnHas)} onClick={onToggle} title="Скачать 3D-модели с текстурами">
      <Box size={15} /> 3D
      {models > 0 && <span className={styles.capCount}>{models}</span>}
    </button>
  );
}

function SessionMenu({ provider, onClose }: { provider: AiProvider; onClose: () => void }) {
  const ai = useAi();
  const [name, setName] = useState('');
  const [account, setAccount] = useState(1);
  const ref = useRef<HTMLDivElement>(null);
  const list = ai.sessions.filter((s) => s.provider === provider);
  const current = activeSession(ai, provider);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node) && !document.querySelector('[data-dialog-open]')) onClose();
    };
    setTimeout(() => window.addEventListener('mousedown', onDown), 0);
    return () => window.removeEventListener('mousedown', onDown);
  }, [onClose]);

  const pick = (id: string) => {
    setAi({ ...ai, active: { ...ai.active, [provider]: id } });
    onClose();
  };

  const create = () => {
    const s: AiSession = {
      id: `${provider}-${Date.now().toString(36)}`,
      provider,
      name: name.trim() || `Сессия ${list.length + 1}`,
      account,
    };
    setAi({ sessions: [...ai.sessions, s], active: { ...ai.active, [provider]: s.id } });
    onClose();
  };

  const rename = async (s: AiSession) => {
    const n = await askText('Название сессии', s.name, 'Сохранить');
    if (n) setAi({ ...state, sessions: state.sessions.map((x) => (x.id === s.id ? { ...x, name: n } : x)) });
  };

  const remove = async (s: AiSession) => {
    if (list.length <= 1) return;
    if (!(await confirmAction(`Удалить сессию «${s.name}»?`, 'Вход в аккаунт сохранится для других сессий с этим номером.'))) return;
    const rest = state.sessions.filter((x) => x.id !== s.id);
    const nextActive = state.active[provider] === s.id ? rest.find((x) => x.provider === provider)!.id : state.active[provider];
    setAi({ sessions: rest, active: { ...state.active, [provider]: nextActive } });
  };

  const accounts = [...new Set(list.map((s) => s.account))].sort();

  return (
    <div className={styles.menu} ref={ref}>
      <div className={styles.menuLabel}>Сессии {PROVIDERS[provider].name}</div>
      {list.map((s) => (
        <div key={s.id} className={cx(styles.menuItem, s.id === current?.id && styles.menuItemOn)} onClick={() => pick(s.id)}>
          <span className={styles.check}>{s.id === current?.id && <Check size={14} />}</span>
          <span className={styles.menuName}>{s.name}</span>
          <span className={styles.acc}>Аккаунт {s.account}</span>
          <span className={styles.menuBtns}>
            <button
              onClick={(e) => {
                e.stopPropagation();
                rename(s);
              }}
            >
              <Pencil size={13} />
            </button>
            {list.length > 1 && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  remove(s);
                }}
              >
                <Trash2 size={13} />
              </button>
            )}
          </span>
        </div>
      ))}
      <div className={styles.menuSep} />
      <div className={styles.menuLabel}>Новая сессия</div>
      <div className={styles.newForm}>
        <input
          className="input"
          placeholder="Название, напр. «Баги»"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && create()}
        />
        <div className={styles.accRow}>
          {[1, 2, 3, 4].map((n) => (
            <button key={n} className={cx(styles.accBtn, account === n && styles.accBtnOn)} onClick={() => setAccount(n)}>
              {n}
              {accounts.includes(n) && <span className={styles.dot} />}
            </button>
          ))}
        </div>
        <div className={styles.hint}>
          Номер аккаунта: одинаковый — общий вход, другой — можно войти в другой аккаунт {PROVIDERS[provider].name}.
        </div>
        <button className="btn primary sm" onClick={create}>
          <Plus size={14} /> Создать
        </button>
      </div>
    </div>
  );
}
