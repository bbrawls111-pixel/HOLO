import { BarChart3, BookOpen, FolderKanban, History, LayoutGrid, MessagesSquare, Network, Settings } from 'lucide-react';
import { navigate, useStore, type Page } from '../store';
import { cx, presenceText } from '../util';
import { Avatar } from './Avatar';
import { Logo } from './Logo';
import styles from './Sidebar.module.css';

const NAV: { page: Page; label: string; icon: typeof LayoutGrid }[] = [
  { page: 'home', label: 'Проект', icon: FolderKanban },
  { page: 'chat', label: 'Чаты и ИИ', icon: MessagesSquare },
  { page: 'library', label: 'Библиотека', icon: LayoutGrid },
  { page: 'docs', label: 'Документы', icon: BookOpen },
  { page: 'charts', label: 'Графики', icon: BarChart3 },
  { page: 'structures', label: 'Структуры', icon: Network },
  { page: 'history', label: 'История', icon: History },
  { page: 'settings', label: 'Настройки', icon: Settings },
];

export function Sidebar() {
  const page = useStore((s) => s.page);
  const users = useStore((s) => s.users);
  const me = useStore((s) => s.me);
  const unread = useStore((s) => s.unread);
  const connection = useStore((s) => s.connection);
  const totalUnread = Object.values(unread).reduce((a, b) => a + b, 0);

  // Себя показываем первым и всегда «онлайн» — клиент сам шлёт присутствие.
  const team = Object.values(users).sort((a, b) => (a.id === me?.id ? -1 : b.id === me?.id ? 1 : a.id - b.id));

  return (
    <aside className={styles.sidebar}>
      <div className={styles.brand}>
        <Logo />
        <span>Holo</span>
      </div>

      <div className={styles.team}>
        {team.map((u) => (
          <button key={u.id} className={styles.member} onClick={() => u.id === me?.id && navigate('settings')}>
            <Avatar user={u} size={40} status />
            <div className={styles.memberText}>
              <div className={styles.memberName}>
                {u.nickname}
                {u.id === me?.id && <span className={styles.you}>вы</span>}
              </div>
              <div className={cx(styles.memberStatus, u.online && styles.online)}>{presenceText(u)}</div>
            </div>
          </button>
        ))}
      </div>

      <nav className={styles.nav}>
        {NAV.map(({ page: p, label, icon: Icon }) => (
          <button key={p} className={cx(styles.navItem, page === p && styles.active)} onClick={() => navigate(p)}>
            <Icon size={19} strokeWidth={1.7} />
            <span>{label}</span>
            {p === 'chat' && totalUnread > 0 && <span className={styles.badge}>{totalUnread}</span>}
          </button>
        ))}
      </nav>

      <div className={styles.server}>
        <div className={styles.serverRow}>
          <span className={cx(styles.led, connection === 'online' ? styles.ledOn : connection === 'connecting' ? styles.ledWait : styles.ledOff)} />
          {connection === 'online' ? 'Сервер подключён' : connection === 'connecting' ? 'Подключение…' : 'Нет связи с сервером'}
        </div>
        <div className={styles.serverRow}>
          <span className={cx(styles.ring, connection === 'online' && styles.ringOn)} />
          Мгновенная синхронизация
        </div>
      </div>
    </aside>
  );
}
