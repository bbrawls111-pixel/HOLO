import {
  ArrowRight, BarChart3, BookOpen, ChevronRight, FolderOpen, Image, MessagesSquare, Network, Sparkles,
} from 'lucide-react';
import { useEffect } from 'react';
import { ActivityItem } from '../components/ActivityItem';
import { Avatar } from '../components/Avatar';
import { navigate, refreshStats, setActiveChannel, useStore, type Page } from '../store';
import { cx, formatBytes, presenceText } from '../util';
import styles from './Home.module.css';

const QUICK: { page: Page; title: string; text: string; icon: typeof Image }[] = [
  { page: 'resources', title: 'Ресурсы', text: 'Изображения, звуки, шрифты и ассеты', icon: Image },
  { page: 'charts', title: 'Графики', text: 'Создание и просмотр графиков', icon: BarChart3 },
  { page: 'structures', title: 'Структуры', text: 'Деревья, JSON, связи объектов', icon: Network },
  { page: 'chat', title: 'Чат', text: 'Общение и обсуждение проекта', icon: MessagesSquare },
  { page: 'ai', title: 'ИИ', text: 'ChatGPT, Gemini, Claude — по сессиям', icon: Sparkles },
  { page: 'docs', title: 'Документация', text: 'Заметки, спецификации, TODO', icon: BookOpen },
];

export function Home() {
  const users = useStore((s) => s.users);
  const me = useStore((s) => s.me)!;
  const activity = useStore((s) => s.activity);
  const stats = useStore((s) => s.stats);
  const unread = useStore((s) => s.unread);
  const channels = useStore((s) => s.channels);

  useEffect(() => {
    refreshStats();
  }, []);

  const partner = Object.values(users).find((u) => u.id !== me.id);
  const pct = stats ? Math.min(100, (stats.ops / stats.opsLimit) * 100) : 0;
  const dayBudget = stats ? Math.round(stats.opsLimit / 30) : 0;

  return (
    <div className={styles.page}>
      <div className={styles.mainCol}>
        <section className={cx(styles.hero, 'card')}>
          <div className={styles.heroArt} aria-hidden>
            <div className={styles.shard1} />
            <div className={styles.shard2} />
            <div className={styles.shard3} />
          </div>
          <div className={styles.heroText}>
            <h1>Holo</h1>
            <p>Dev workspace. For you and your partner.</p>
          </div>
          <div className={styles.heroActions}>
            <button className={styles.heroBtn} onClick={() => navigate('resources')}>
              <FolderOpen size={20} />
              Открыть ресурсы
              <ChevronRight size={18} className={styles.chev} />
            </button>
            <button className={styles.heroBtn} onClick={() => navigate('chat')}>
              <MessagesSquare size={20} />
              Перейти в чат
              <ChevronRight size={18} className={styles.chev} />
            </button>
          </div>
        </section>

        <section>
          <div className={styles.sectionHead}>
            <h2>Быстрый доступ</h2>
          </div>
          <div className={styles.quick}>
            {QUICK.map(({ page, title, text, icon: Icon }) => (
              <button key={page} className={styles.tile} onClick={() => navigate(page)}>
                <Icon size={26} strokeWidth={1.6} className={styles.tileIcon} />
                <div>
                  <div className={styles.tileTitle}>{title}</div>
                  <div className={styles.tileText}>{text}</div>
                </div>
              </button>
            ))}
          </div>
        </section>

        <section className={cx('card', styles.recent)}>
          <div className={styles.sectionHead}>
            <h2>Последние изменения</h2>
            <button className="btn ghost sm" onClick={() => navigate('history')}>
              Показать все <ArrowRight size={14} />
            </button>
          </div>
          {activity.length ? (
            activity.slice(0, 6).map((ev) => <ActivityItem key={ev.seq} ev={ev} />)
          ) : (
            <div className="empty">Пока изменений нет. Перетащите файлы в «Ресурсы».</div>
          )}
        </section>
      </div>

      <aside className={styles.sideCol}>
        <section className={cx('card', styles.side)}>
          <div className="label">Команда</div>
          {[me, ...(partner ? [partner] : [])].map((u) => {
            const user = users[u.id] ?? u;
            return (
              <div key={u.id} className={styles.person}>
                <Avatar user={user} size={46} status />
                <div>
                  <div className={styles.personName}>{user.nickname}</div>
                  <div className={cx(styles.personStatus, user.online && styles.on)}>{presenceText(user)}</div>
                </div>
              </div>
            );
          })}
          {!partner && <div className="faint">Второй участник ещё не создан на сервере.</div>}
        </section>

        <section className={cx('card', styles.side)}>
          <div className="label">Каналы</div>
          {channels.map((c) => (
            <button
              key={c.id}
              className={styles.channel}
              onClick={() => {
                setActiveChannel(c.id);
                navigate('chat');
              }}
            >
              <span className="faint">#</span> {c.name}
              {!!unread[c.id] && <span className={styles.badge}>{unread[c.id]}</span>}
            </button>
          ))}
        </section>

        {stats && (
          <section className={cx('card', styles.side)}>
            <div className="label">Сервер · {stats.month}</div>
            <div className={styles.bigNum}>
              {stats.ops.toLocaleString('ru-RU')}
              <span className="faint"> / {stats.opsLimit.toLocaleString('ru-RU')}</span>
            </div>
            <div className={styles.meter}>
              <div style={{ width: `${pct}%` }} />
            </div>
            <div className={styles.statGrid}>
              <div>
                <span className="faint">Бюджет в день</span>
                <strong>{dayBudget.toLocaleString('ru-RU')}</strong>
              </div>
              <div>
                <span className="faint">Хранилище</span>
                <strong>{formatBytes(stats.storageBytes)}</strong>
              </div>
              <div>
                <span className="faint">Файлов</span>
                <strong>{stats.files}</strong>
              </div>
              <div>
                <span className="faint">Сообщений</span>
                <strong>{stats.messages}</strong>
              </div>
            </div>
          </section>
        )}
      </aside>
    </div>
  );
}
