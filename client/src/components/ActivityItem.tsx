import { BarChart3, BookOpen, FilePlus2, FileText, Image, MessageSquare, Network, RefreshCw, Trash2, User } from 'lucide-react';
import { openBoardPage, openFile, useStore } from '../store';
import type { HoloEvent } from '../types';
import { formatBytes, timeAgo } from '../util';
import styles from './ActivityItem.module.css';

const BOARD_ICON = { chart: BarChart3, tree: Network, doc: BookOpen } as const;
const BOARD_NAME = { chart: 'график', tree: 'структура', doc: 'документ' } as const;

function describe(ev: HoloEvent) {
  const p = ev.payload;
  const fileTitle = (f: { title?: string; name?: string; path?: string }) => f.title || f.name || f.path || '';
  switch (ev.type) {
    case 'file.created':
      return { icon: p.file.mime?.startsWith('image/') ? Image : FilePlus2, title: fileTitle(p.file), extra: 'в библиотеке', tone: 'add' };
    case 'file.updated':
      return {
        icon: RefreshCw,
        title: fileTitle(p.file),
        extra: p.restoredFrom ? `восстановлена v${p.restoredFrom}` : `v${p.file.version} · ${formatBytes(p.file.size)}`,
        tone: 'upd',
      };
    case 'file.deleted':
      return { icon: Trash2, title: p.path, extra: 'удалён', tone: 'del' };
    case 'file.comment':
      return { icon: MessageSquare, title: p.path, extra: `«${String(p.comment.text).slice(0, 60)}»`, tone: 'upd' };
    case 'board.created':
      return { icon: BOARD_ICON[p.board.kind as 'chart'] ?? FileText, title: p.board.title, extra: `новый ${BOARD_NAME[p.board.kind as 'chart'] ?? ''}`, tone: 'add' };
    case 'board.updated':
      return { icon: BOARD_ICON[p.board.kind as 'chart'] ?? FileText, title: p.board.title, extra: 'изменён', tone: 'upd' };
    case 'board.deleted':
      return { icon: Trash2, title: p.title, extra: `${BOARD_NAME[p.kind as 'chart'] ?? ''} удалён`, tone: 'del' };
    case 'message.created':
      return { icon: MessageSquare, title: 'Чат', extra: String(p.message.text || p.message.file?.name || '').slice(0, 80), tone: 'upd' };
    case 'message.updated':
      return { icon: MessageSquare, title: 'Чат', extra: 'сообщение изменено', tone: 'upd' };
    case 'message.deleted':
      return { icon: Trash2, title: 'Чат', extra: 'сообщение удалено', tone: 'del' };
    case 'user.updated':
      return { icon: User, title: p.user.nickname, extra: 'обновил(а) профиль', tone: 'upd' };
    default:
      return { icon: FileText, title: ev.type, extra: '', tone: 'upd' };
  }
}

export function ActivityItem({ ev }: { ev: HoloEvent }) {
  const users = useStore((s) => s.users);
  const files = useStore((s) => s.files);
  const boards = useStore((s) => s.boards);
  const d = describe(ev);
  const Icon = d.icon;
  const fileId = ev.payload?.file?.id ?? ev.payload?.comment?.fileId;
  const file = fileId ? files[fileId] : undefined;
  const board = ev.payload?.board?.id ? boards[ev.payload.board.id] : undefined;
  const author = ev.userId ? users[ev.userId]?.nickname : 'Система';

  return (
    <button
      className={styles.item}
      disabled={!file && !board}
      onClick={() => (file ? openFile(file) : board && openBoardPage(board.kind, board.id))}
    >
      <div className={styles.icon} data-tone={d.tone}>
        <Icon size={18} strokeWidth={1.7} />
      </div>
      <div className={styles.text}>
        <div className={styles.title}>{d.title}</div>
        <div className={styles.meta}>
          {author} · {timeAgo(ev.createdAt)}
        </div>
      </div>
      <div className={styles.extra} data-tone={d.tone}>
        {d.extra}
      </div>
    </button>
  );
}
