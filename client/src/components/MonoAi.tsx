import { BookOpen, Copy, FilePlus2, Loader2, PenLine, RotateCcw, X } from 'lucide-react';
import { useEffect, useRef, useState, type RefObject } from 'react';
import { createBoard } from '../boards';
import { continuePrompt, createPrompt, plainText, referencePrompt, splitTitle, type MonoMode } from '../monoAi';
import { toast } from '../store';
import type { DocData } from '../types';
import { cx } from '../util';
import styles from './MonoAi.module.css';

/** Четырёхконечная звезда Mono AI. */
export function MonoStar({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round">
      <path d="m12 3 2.2 6.8L21 12l-6.8 2.2L12 21l-2.2-6.8L3 12l6.8-2.2z" />
    </svg>
  );
}

const MODES: { id: MonoMode; label: string; hint: string; icon: typeof BookOpen }[] = [
  { id: 'ref', label: 'Референс', hint: 'Подскажет, на что посмотреть', icon: BookOpen },
  { id: 'create', label: 'Создание', hint: 'Напишет новый документ', icon: FilePlus2 },
  { id: 'continue', label: 'Додумывание', hint: 'Продолжит выделенный фрагмент', icon: PenLine },
];

type Sel = { start: number; end: number };

export function MonoAiButton(props: {
  title: string;
  text: string;
  textarea: RefObject<HTMLTextAreaElement>;
  onInsert: (at: number, text: string) => void;
}) {
  const [menu, setMenu] = useState(false);
  const [mode, setMode] = useState<MonoMode | null>(null);
  const [connected, setConnected] = useState<boolean | null>(null);
  const [connecting, setConnecting] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);

  const refreshStatus = async () => {
    const r = await window.holo.monoAi.status();
    setConnected(r.ok ? r.connected : false);
  };
  useEffect(() => {
    void refreshStatus();
  }, []);

  // Меню закрывается кликом мимо; окошко режима — только крестиком или Esc
  // (в «Додумывании» нужно кликать по документу).
  useEffect(() => {
    if (!menu) return;
    const close = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setMenu(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [menu]);

  const connect = async () => {
    setConnecting(true);
    try {
      const r = await window.holo.monoAi.connect();
      if (!r.ok) toast(r.error);
      else if (r.pending) toast('Окно входа уже открыто', 'info');
      else setConnected(r.connected);
    } finally {
      setConnecting(false);
    }
  };
  const disconnect = async () => {
    await window.holo.monoAi.disconnect();
    setConnected(false);
    setMenu(false);
    toast('Аккаунт Mono AI отключён', 'info');
  };

  return (
    <div className={styles.wrap} ref={wrap}>
      <button
        className={cx('btn sm icon', styles.star, (menu || mode) && styles.starOn)}
        title="Mono AI"
        onClick={() => setMenu((v) => !v)}
      >
        <MonoStar />
      </button>

      {menu && (
        <div className={styles.menu}>
          <div className={styles.menuHead}>
            <MonoStar size={15} /> Mono AI
          </div>
          {MODES.map((m) => (
            <button
              key={m.id}
              className={cx(styles.menuItem, mode === m.id && styles.menuItemOn)}
              onClick={() => {
                setMode(m.id);
                setMenu(false);
              }}
            >
              <m.icon size={16} />
              <span>
                <b>{m.label}</b>
                <small>{m.hint}</small>
              </span>
            </button>
          ))}
          <div className={styles.menuFoot}>
            {connected ? (
              <>
                <span className={styles.dotOn} /> Аккаунт подключён
                <button className={styles.link} onClick={disconnect}>
                  Отключить
                </button>
              </>
            ) : (
              <>
                <span className={styles.dotOff} /> Аккаунт не подключён
              </>
            )}
          </div>
        </div>
      )}

      {mode && (
        <MonoPanel
          key={mode}
          mode={mode}
          {...props}
          connected={!!connected}
          connecting={connecting}
          onConnect={connect}
          onClose={() => setMode(null)}
        />
      )}
    </div>
  );
}

function MonoPanel({
  mode,
  title,
  text,
  textarea,
  onInsert,
  connected,
  connecting,
  onConnect,
  onClose,
}: {
  mode: MonoMode;
  title: string;
  text: string;
  textarea: RefObject<HTMLTextAreaElement>;
  onInsert: (at: number, text: string) => void;
  connected: boolean;
  connecting: boolean;
  onConnect: () => void;
  onClose: () => void;
}) {
  const [input, setInput] = useState('');
  const [answer, setAnswer] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [sel, setSel] = useState<Sel | null>(null);
  const reqId = useRef('');
  const field = useRef<HTMLTextAreaElement>(null);
  const meta = MODES.find((m) => m.id === mode)!;

  // Ответ приходит по кусочкам, пока модель пишет.
  useEffect(
    () =>
      window.holo.on('holo:monoAi:progress', (p: { id: string; text: string }) => {
        if (p.id === reqId.current) setAnswer(plainText(p.text));
      }),
    [],
  );
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && !busy && onClose();
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [busy, onClose]);
  // Если ушли из панели во время запроса — отменяем его.
  useEffect(() => () => void (reqId.current && window.holo.monoAi.cancel(reqId.current)), []);

  // «Додумывание»: ждём, пока пользователь выделит фрагмент в документе.
  useEffect(() => {
    if (mode !== 'continue') return;
    const ta = textarea.current;
    if (!ta) return;
    const read = () => {
      if (ta.selectionEnd > ta.selectionStart) setSel({ start: ta.selectionStart, end: ta.selectionEnd });
    };
    read();
    ta.addEventListener('select', read);
    ta.addEventListener('mouseup', read);
    ta.addEventListener('keyup', read);
    return () => {
      ta.removeEventListener('select', read);
      ta.removeEventListener('mouseup', read);
      ta.removeEventListener('keyup', read);
    };
  }, [mode, textarea]);

  useEffect(() => {
    if (connected && (mode !== 'continue' || sel)) field.current?.focus();
  }, [connected, mode, sel]);

  const fragment = sel ? text.slice(sel.start, Math.min(sel.end, text.length)) : '';

  const run = async () => {
    if (busy) return;
    let prompt: string;
    if (mode === 'ref') {
      if (!input.trim()) return;
      prompt = referencePrompt(input, { title, text });
    } else if (mode === 'create') {
      if (!input.trim()) return;
      prompt = createPrompt(input);
    } else {
      if (!sel || !fragment.trim()) return;
      prompt = continuePrompt({ title, before: text.slice(0, sel.start), fragment, wish: input });
    }
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    reqId.current = id;
    setBusy(true);
    setError('');
    setAnswer('');
    try {
      const r = await window.holo.monoAi.ask(id, prompt);
      if (reqId.current !== id) return;
      if (!r.ok) {
        if (r.code !== 'cancelled') setError(r.error);
        if (r.code === 'login') onConnect();
        return;
      }
      const result = plainText(r.text);
      if (mode === 'create') {
        const doc = splitTitle(r.text);
        reqId.current = ''; // новый документ откроется вместо этого — панель закроется, отменять уже нечего
        await createBoard<DocData>('doc', doc.title, { text: doc.text }, true);
        toast(`Mono AI создал документ «${doc.title}»`, 'info');
        onClose();
        return;
      }
      setAnswer(result);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      if (reqId.current === id) {
        reqId.current = '';
        setBusy(false);
      }
    }
  };

  const cancel = () => {
    if (reqId.current) void window.holo.monoAi.cancel(reqId.current);
    reqId.current = '';
    setBusy(false);
  };

  const insert = () => {
    if (!sel || !answer) return;
    const at = Math.min(sel.end, text.length);
    const before = text.slice(0, at);
    const sep = !before || before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n';
    const piece = sep + answer + (text.slice(at).startsWith('\n') || at >= text.length ? '' : '\n\n');
    onInsert(at, piece);
    // Выделяем вставленное, чтобы было видно, что добавилось.
    requestAnimationFrame(() => {
      const ta = textarea.current;
      if (!ta) return;
      ta.focus();
      ta.setSelectionRange(at + sep.length, at + sep.length + answer.length);
    });
    toast('Продолжение вставлено', 'info');
    onClose();
  };

  const placeholder =
    mode === 'ref'
      ? 'Например: заброшенная станция в пустыне, мрачная атмосфера'
      : mode === 'create'
        ? 'Например: напиши сюжет хоррор-игры про маяк на 3 акта'
        : 'Пожелание (необязательно): например, «добавь неожиданный поворот»';

  return (
    <div className={styles.panel}>
      <div className={styles.panelHead}>
        <meta.icon size={16} />
        <b>{meta.label}</b>
        <span className={styles.panelSub}>Mono AI</span>
        <div className={styles.grow} />
        <button className="btn sm icon ghost" onClick={busy ? cancel : onClose} title={busy ? 'Остановить' : 'Закрыть'}>
          <X size={15} />
        </button>
      </div>

      {!connected ? (
        <div className={styles.connect}>
          <MonoStar size={26} />
          <p>
            Mono AI отвечает через ваш бесплатный аккаунт DeepSeek — как в Mono Browser. Войдите один раз, окно закроется
            само.
          </p>
          <button className="btn primary sm" onClick={onConnect} disabled={connecting}>
            {connecting ? <Loader2 size={15} className={styles.spin} /> : <MonoStar size={15} />}
            {connecting ? 'Ждём вход…' : 'Подключить Mono AI'}
          </button>
        </div>
      ) : (
        <>
          {mode === 'continue' && (
            <div className={cx(styles.pick, !sel && styles.pickWait)}>
              {sel && fragment.trim() ? (
                <>
                  <span className={styles.pickLabel}>Фрагмент · {fragment.length} симв.</span>
                  <span className={styles.pickText}>{fragment.length > 220 ? fragment.slice(0, 100) + ' … ' + fragment.slice(-100) : fragment}</span>
                </>
              ) : (
                <>
                  <PenLine size={15} /> Выделите мышью фрагмент в документе — Mono AI прочитает всё, что выше, и продолжит
                  по хронологии.
                </>
              )}
            </div>
          )}

          {(mode !== 'continue' || sel) && (
            <div className={styles.ask}>
              <textarea
                ref={field}
                className={styles.field}
                rows={mode === 'continue' ? 1 : 2}
                value={input}
                placeholder={placeholder}
                disabled={busy}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    void run();
                  }
                }}
              />
              <button
                className="btn primary sm"
                onClick={busy ? cancel : run}
                disabled={!busy && (mode === 'continue' ? !fragment.trim() : !input.trim())}
              >
                {busy ? <Loader2 size={15} className={styles.spin} /> : <MonoStar size={15} />}
                {busy ? 'Стоп' : mode === 'ref' ? 'Спросить' : mode === 'create' ? 'Создать' : 'Додумать'}
              </button>
            </div>
          )}

          {error && <div className={styles.error}>{error}</div>}

          {(answer || busy) && (
            <div className={styles.answer}>
              {answer ? (
                answer
              ) : (
                <span className={styles.thinking}>
                  {mode === 'create' ? 'Mono AI пишет документ' : 'Mono AI думает'}
                  <i />
                  <i />
                  <i />
                </span>
              )}
            </div>
          )}

          {!busy && answer && mode !== 'create' && (
            <div className={styles.actions}>
              {mode === 'continue' && (
                <button className="btn primary sm" onClick={insert}>
                  <PenLine size={15} /> Вставить после фрагмента
                </button>
              )}
              <button className="btn sm" onClick={run}>
                <RotateCcw size={14} /> Ещё вариант
              </button>
              <button
                className="btn sm ghost"
                onClick={() => {
                  void navigator.clipboard.writeText(answer);
                  toast('Скопировано', 'info');
                }}
              >
                <Copy size={14} /> Копировать
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
