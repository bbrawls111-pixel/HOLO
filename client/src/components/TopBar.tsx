import { ChevronRight, Search, Zap } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { navigate, openChat, openFile, useStore, type Page } from '../store';
import { cx } from '../util';
import { Avatar } from './Avatar';
import styles from './TopBar.module.css';

const TITLES: Record<Page, string> = {
  home: 'Обзор',
  library: 'Библиотека',
  charts: 'Графики',
  structures: 'Структуры',
  chat: 'Чаты и ИИ',
  docs: 'Документы',
  history: 'История',
  settings: 'Настройки',
};

export function TopBar() {
  const page = useStore((s) => s.page);
  const me = useStore((s) => s.me);
  const files = useStore((s) => s.files);
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return Object.values(files)
      .filter((f) => `${f.title} ${f.description} ${f.name}`.toLowerCase().includes(q))
      .slice(0, 8);
  }, [query, files]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <header className={styles.bar}>
      <div className={styles.crumbs}>
        <span className="faint">Проект</span>
        <ChevronRight size={15} className="faint" />
        <span className={styles.current}>{TITLES[page]}</span>
      </div>

      <div className={styles.right}>
        <div className={styles.search}>
          <Search size={16} className="faint" />
          <input
            ref={inputRef}
            value={query}
            placeholder="Поиск по библиотеке  (Ctrl+K)"
            onChange={(e) => {
              setQuery(e.target.value);
              setOpen(true);
            }}
            onFocus={() => setOpen(true)}
            onBlur={() => setTimeout(() => setOpen(false), 150)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && results[0]) {
                openFile(results[0]);
                setQuery('');
                inputRef.current?.blur();
              }
              if (e.key === 'Escape') inputRef.current?.blur();
            }}
          />
          {open && query && (
            <div className={styles.results}>
              {results.length ? (
                results.map((f) => (
                  <button
                    key={f.id}
                    className={styles.result}
                    onMouseDown={() => {
                      openFile(f);
                      setQuery('');
                    }}
                  >
                    <span className={styles.resultName}>{f.title || f.name}</span>
                    <span className="faint">{f.title ? f.name : f.description.slice(0, 60)}</span>
                  </button>
                ))
              ) : (
                <div className={cx(styles.result, 'faint')}>Ничего не найдено</div>
              )}
            </div>
          )}
        </div>

        <button className="btn ghost icon" title="ИИ-помощник" onClick={() => openChat('ai:chatgpt')}>
          <Zap size={18} />
        </button>
        {me && (
          <button className={styles.me} onClick={() => navigate('settings')} title="Профиль">
            <Avatar user={me} size={34} />
          </button>
        )}
      </div>
    </header>
  );
}
