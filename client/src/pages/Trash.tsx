import { BarChart3, BookOpen, CheckSquare, File as FileIcon, Loader2, Network, RotateCcw, Square, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';
import { api } from '../api';
import { confirmAction, eventBus, refreshStats, toast, useStore } from '../store';
import type { HoloFile } from '../types';
import { cx, formatBytes, timeAgo } from '../util';
import styles from './Trash.module.css';

interface TrashItem {
  type: 'file' | 'board';
  id: number;
  title: string;
  kind: string;
  private?: boolean;
  file?: HoloFile;
  deletedAt: number;
  deletedBy: number | null;
}

const KIND = {
  file: { icon: FileIcon, label: 'Файл' },
  doc: { icon: BookOpen, label: 'Документ' },
  chart: { icon: BarChart3, label: 'График' },
  tree: { icon: Network, label: 'Структура' },
} as const;

const keyOf = (i: Pick<TrashItem, 'type' | 'id'>) => `${i.type}:${i.id}`;

export function Trash() {
  const users = useStore((s) => s.users);
  const [items, setItems] = useState<TrashItem[] | null>(null);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const list = await api<TrashItem[]>('GET', '/api/trash');
      setItems(list);
      setSel((s) => new Set([...s].filter((k) => list.some((i) => keyOf(i) === k))));
    } catch (e) {
      toast((e as Error).message);
    }
  }, []);

  useEffect(() => {
    load();
    const types = ['trash.changed', 'file.deleted', 'board.deleted'];
    types.forEach((t) => eventBus.addEventListener(t, load));
    return () => types.forEach((t) => eventBus.removeEventListener(t, load));
  }, [load]);

  const selected = useMemo(() => (items ?? []).filter((i) => sel.has(keyOf(i))), [items, sel]);
  const totalSize = (items ?? []).reduce((s, i) => s + (i.file?.size ?? 0), 0);

  const run = async (path: string, body: object, done: string) => {
    setBusy(true);
    try {
      const r = await api<{ restored?: number; purged?: number }>('POST', path, body);
      toast(`${done}: ${r.restored ?? r.purged ?? 0}`, 'info');
      setSel(new Set());
      await load();
      refreshStats();
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const restore = (list: TrashItem[] | 'all') =>
    run('/api/trash/restore', list === 'all' ? { all: true } : { items: list.map(({ type, id }) => ({ type, id })) }, 'Восстановлено');

  const purge = async (list: TrashItem[] | 'all') => {
    const n = list === 'all' ? items?.length ?? 0 : list.length;
    const ok = await confirmAction(
      list === 'all' ? 'Очистить корзину?' : `Удалить навсегда (${n})?`,
      'Это нельзя отменить: элементы исчезнут у обоих участников, а данные файлов будут стёрты из хранилища.',
      'Удалить навсегда',
    );
    if (ok) run('/api/trash/purge', list === 'all' ? { all: true } : { items: list.map(({ type, id }) => ({ type, id })) }, 'Удалено навсегда');
  };

  const toggle = (i: TrashItem) =>
    setSel((s) => {
      const n = new Set(s);
      if (n.has(keyOf(i))) n.delete(keyOf(i));
      else n.add(keyOf(i));
      return n;
    });
  const allSelected = !!items?.length && sel.size === items.length;

  return (
    <div className={cx(styles.page, 'page-enter')}>
      <header className={styles.head}>
        <div>
          <h1>Корзина</h1>
          <p className="muted">
            Удалённые файлы, документы и графики. Их можно вернуть или удалить навсегда.
            {items?.length ? ` Сейчас: ${items.length} · ${formatBytes(totalSize)}` : ''}
          </p>
        </div>
        <div className={styles.actions}>
          {selected.length > 0 ? (
            <>
              <button className="btn" disabled={busy} onClick={() => restore(selected)}>
                <RotateCcw size={16} /> Вернуть ({selected.length})
              </button>
              <button className="btn danger" disabled={busy} onClick={() => purge(selected)}>
                <Trash2 size={16} /> Удалить навсегда
              </button>
            </>
          ) : (
            <>
              <button className="btn" disabled={busy || !items?.length} onClick={() => restore('all')}>
                <RotateCcw size={16} /> Вернуть всё
              </button>
              <button className="btn danger" disabled={busy || !items?.length} onClick={() => purge('all')}>
                <Trash2 size={16} /> Очистить корзину
              </button>
            </>
          )}
        </div>
      </header>

      <section className={cx('card', styles.list)}>
        {items === null ? (
          <div className="empty">
            <Loader2 className="spin" />
          </div>
        ) : items.length ? (
          <>
            <button className={styles.selectAll} onClick={() => setSel(allSelected ? new Set() : new Set(items.map(keyOf)))}>
              {allSelected ? <CheckSquare size={16} /> : <Square size={16} />} Выбрать всё
            </button>
            <div className="stagger">
              {items.map((i, idx) => {
                const K = i.type === 'file' ? KIND.file : KIND[i.kind as 'doc'] ?? KIND.file;
                const on = sel.has(keyOf(i));
                return (
                  <div key={keyOf(i)} className={cx(styles.row, on && styles.rowOn)} style={{ '--i': idx } as CSSProperties}>
                    <button className={styles.check} onClick={() => toggle(i)}>
                      {on ? <CheckSquare size={17} /> : <Square size={17} />}
                    </button>
                    <span className={styles.icon}>
                      <K.icon size={18} />
                    </span>
                    <div className={styles.info} onClick={() => toggle(i)}>
                      <div className={styles.title}>{i.title}</div>
                      <div className={styles.meta}>
                        {K.label}
                        {i.private ? ' · личный' : ''}
                        {i.file ? ` · ${formatBytes(i.file.size)}` : ''} · удалил(а) {users[i.deletedBy ?? 0]?.nickname ?? '—'}{' '}
                        {timeAgo(i.deletedAt)}
                      </div>
                    </div>
                    <button className="btn sm" disabled={busy} onClick={() => restore([i])}>
                      <RotateCcw size={14} /> Вернуть
                    </button>
                    <button className="btn sm icon ghost danger" disabled={busy} title="Удалить навсегда" onClick={() => purge([i])}>
                      <Trash2 size={15} />
                    </button>
                  </div>
                );
              })}
            </div>
          </>
        ) : (
          <div className={cx('empty', styles.empty)}>
            <Trash2 size={48} strokeWidth={1.1} />
            <div>Корзина пуста</div>
          </div>
        )}
      </section>
    </div>
  );
}
