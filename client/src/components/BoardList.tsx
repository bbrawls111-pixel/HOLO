import { Lock, Plus, Search, Users } from 'lucide-react';
import { useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import { useStore } from '../store';
import type { Board, BoardKind } from '../types';
import { cx, timeAgo } from '../util';
import styles from './BoardList.module.css';

interface Props {
  kind: BoardKind;
  title: string;
  newLabel: string;
  onCreate: () => void;
  icon: ReactNode;
  tabs?: { id: string; label: string; filter: (b: Board) => boolean }[];
}

/** Левая колонка со списком досок (графики, деревья, документы). */
export function BoardList({ kind, title, newLabel, onCreate, icon, tabs }: Props) {
  const boards = useStore((s) => s.boards);
  const openId = useStore((s) => s.openBoard[kind]);
  const users = useStore((s) => s.users);
  const [query, setQuery] = useState('');
  const [tab, setTab] = useState(tabs?.[0].id);

  const list = useMemo(() => {
    const q = query.trim().toLowerCase();
    const f = tabs?.find((t) => t.id === tab)?.filter;
    return Object.values(boards)
      .filter((b) => b.kind === kind && (!f || f(b)) && (!q || b.title.toLowerCase().includes(q)))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }, [boards, kind, query, tab, tabs]);

  return (
    <aside className={cx('card', styles.list)}>
      <div className={styles.head}>
        <span>{title}</span>
        <button className="btn sm primary" onClick={onCreate}>
          <Plus size={15} /> {newLabel}
        </button>
      </div>
      {tabs && (
        <div className={styles.tabs}>
          {tabs.map((t) => (
            <button key={t.id} className={cx(tab === t.id && styles.tabOn)} onClick={() => setTab(t.id)}>
              {t.label}
            </button>
          ))}
        </div>
      )}
      <div className={styles.search}>
        <Search size={14} className="faint" />
        <input placeholder="Поиск" value={query} onChange={(e) => setQuery(e.target.value)} />
      </div>
      <div className={cx(styles.items, 'stagger')}>
        {list.map((b, i) => (
          <button
            key={b.id}
            className={cx(styles.item, b.id === openId && styles.itemOn)}
            style={{ '--i': i } as CSSProperties}
            onClick={() => useStore.setState((s) => ({ openBoard: { ...s.openBoard, [kind]: b.id } }))}
          >
            <span className={styles.icon}>{icon}</span>
            <div className={styles.text}>
              <div className={styles.title}>{b.title}</div>
              <div className={styles.meta}>
                {b.private ? <Lock size={11} /> : <Users size={11} />}
                {users[b.updatedBy ?? 0]?.nickname ?? ''} · {timeAgo(b.updatedAt)}
              </div>
            </div>
          </button>
        ))}
        {!list.length && <div className={styles.empty}>{query ? 'Ничего не найдено' : 'Пока пусто'}</div>}
      </div>
    </aside>
  );
}
