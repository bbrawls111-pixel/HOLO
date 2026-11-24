import {
  ArrowRight, BarChart3, BookOpen, ChevronRight, LayoutGrid, MessagesSquare, Network, Sparkles,
} from 'lucide-react';
import { useEffect, type CSSProperties } from 'react';
import { ActivityItem } from '../components/ActivityItem';
import { Avatar } from '../components/Avatar';
import { DM_CHANNEL, navigate, openChat, refreshStats, useStore } from '../store';
import { cx, formatBytes, presenceText } from '../util';
import { AiAvatar, PROVIDER_IDS, PROVIDERS } from './AiPane';
import styles from './Home.module.css';

const QUICK: { go: () => void; title: string; text: string; icon: typeof LayoutGrid }[] = [
  { go: () => navigate('library'), title: 'Библиотека', text: 'Изображения, звуки, шрифты и ассеты', icon: LayoutGrid },
  { go: () => navigate('charts'), title: 'Графики', text: 'Баланс, прогрессия, статистика', icon: BarChart3 },
  { go: () => navigate('structures'), title: 'Структуры', text: 'Деревья объектов и связей', icon: Network },
  { go: () => openChat('dm'), title: 'Чат', text: 'Личка с напарником', icon: MessagesSquare },
  { go: () => openChat('ai:chatgpt'), title: 'ИИ', text: 'ChatGPT, Gemini, Claude — по сессиям', icon: Sparkles },
  { go: () => navigate('docs'), title: 'Документы', text: 'Личные и общие заметки', icon: BookOpen },
];

export function Home() {
  const users = useStore((s) => s.users);
  const me = useStore((s) => s.me)!;
  const activity = useStore((s) => s.activity);
  const stats = useStore((s) => s.stats);
  const unread = useStore((s) => s.unread[DM_CHANNEL] || 0);

  useEffect(() => {
    refreshStats();
  }, []);

  const partner = Object.values(users).find((u) => u.id !== me.id);
  const boards = useStore((s) => s.boards);

  return (
    <div className={cx(styles.page, 'page-enter')}>
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
            <button className={styles.heroBtn} onClick={() => navigate('library')}>
              <LayoutGrid size={20} />
              Открыть библиотеку
              <ChevronRight size={18} className={styles.chev} />
            </button>
            <button className={styles.heroBtn} onClick={() => openChat('dm')}>
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
          <div className={cx(styles.quick, 'stagger')}>
            {QUICK.map(({ go, title, text, icon: Icon }, i) => (
              <button key={title} className={cx(styles.tile, 'lift')} style={{ '--i': i } as CSSProperties} onClick={go}>
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
          <div className="label">Чаты</div>
          <button className={styles.channel} onClick={() => openChat('dm')}>
            <MessagesSquare size={15} className="faint" /> {partner?.nickname ?? 'Напарник'}
            {unread > 0 && <span className={styles.badge}>{unread}</span>}
          </button>
          {PROVIDER_IDS.map((p) => {
            const P = PROVIDERS[p];
            return (
              <button key={p} className={styles.channel} onClick={() => openChat(`ai:${p}`)}>
                <AiAvatar provider={p} size={20} /> {P.name}
              </button>
            );
          })}
        </section>

        {stats && (
          <section className={cx('card', styles.side)}>
            <div className="label">Проект</div>
            <div className={styles.statGrid}>
              <div>
                <span className="faint">Документов</span>
                <strong>{Object.values(boards).filter((b) => b.kind === 'doc').length}</strong>
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
