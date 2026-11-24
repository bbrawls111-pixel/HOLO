import { BarChart3, BookOpen, Network } from 'lucide-react';
import { cx } from '../util';
import styles from './Settings.module.css';

const INFO = {
  charts: {
    icon: BarChart3,
    title: 'Graph Studio',
    text: 'Графики игровых показателей, баланса и статистики на Apache ECharts с совместным просмотром.',
  },
  structures: {
    icon: Network,
    title: 'Node Editor',
    text: 'Деревья игровых объектов, сущности, связи и зависимости на React Flow. Оба участника редактируют одну структуру и видят изменения сразу.',
  },
  docs: {
    icon: BookOpen,
    title: 'Документация',
    text: 'Заметки, технические документы, TODO и спецификации проекта.',
  },
};

/** Разделы второго этапа: сначала ядро (синхронизация, хранилище, общение). */
export function Placeholder({ kind }: { kind: keyof typeof INFO }) {
  const { icon: Icon, title, text } = INFO[kind];
  return (
    <div className={styles.page}>
      <section className={cx('card', styles.section)} style={{ alignItems: 'center', textAlign: 'center', padding: 60 }}>
        <Icon size={48} strokeWidth={1.3} style={{ color: 'var(--accent-2)' }} />
        <h2>{title}</h2>
        <p className="muted" style={{ maxWidth: 480, margin: 0 }}>
          {text}
        </p>
        <span className="label" style={{ marginTop: 8 }}>
          Этап 2 — после ядра
        </span>
      </section>
    </div>
  );
}
