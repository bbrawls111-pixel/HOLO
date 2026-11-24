import { Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api } from '../api';
import { ActivityItem } from '../components/ActivityItem';
import { toast, useStore } from '../store';
import type { HoloEvent } from '../types';
import { cx } from '../util';
import styles from './Settings.module.css';

export function HistoryPage() {
  const [all, setAll] = useState(false);
  const [items, setItems] = useState<HoloEvent[] | null>(null);
  const live = useStore((s) => s.activity);

  useEffect(() => {
    setItems(null);
    api<HoloEvent[]>('GET', `/api/activity?limit=200${all ? '&all=1' : ''}`)
      .then(setItems)
      .catch((e) => toast(e.message));
  }, [all]);

  // Новые события дописываем сверху без повторного запроса.
  const merged = items
    ? [...live.filter((ev) => !items.some((i) => i.seq === ev.seq) && ev.seq! > (items[0]?.seq ?? 0)), ...items]
    : null;

  return (
    <div className={styles.page} style={{ maxWidth: 980 }}>
      <section className={cx('card', styles.section)}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h2>История изменений</h2>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center' }} className="muted">
            <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} />
            Включая чат и профили
          </label>
        </div>
        {!merged ? (
          <div className="empty">
            <Loader2 className="spin" />
          </div>
        ) : merged.length ? (
          <div>
            {merged.map((ev) => (
              <ActivityItem key={ev.seq} ev={ev} />
            ))}
          </div>
        ) : (
          <div className="empty">Пока пусто.</div>
        )}
      </section>
    </div>
  );
}
