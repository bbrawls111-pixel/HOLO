import { FilePlus2, FileText, FolderMinus, FolderPlus, Image, MessageSquare, MoveRight, RefreshCw, Trash2, User } from 'lucide-react';
import { openFile, useStore } from '../store';
import type { HoloEvent } from '../types';
import { formatBytes, timeAgo } from '../util';
import styles from './ActivityItem.module.css';

function describe(ev: HoloEvent) {
  const p = ev.payload;
  switch (ev.type) {
    case 'file.created':
      return { icon: p.file.mime.startsWith('image/') ? Image : FilePlus2, title: p.file.path, extra: 'новый файл', tone: 'add' };
    case 'file.updated':
      return {
        icon: RefreshCw,
        title: p.file.path,
        extra: p.restoredFrom ? `восстановлена v${p.restoredFrom}` : `v${p.file.version} · ${formatBytes(p.file.size)}`,
        tone: 'upd',
      };
    case 'file.moved':
      return { icon: MoveRight, title: p.file.path, extra: `из ${p.from}`, tone: 'upd' };
    case 'file.deleted':
      return { icon: Trash2, title: p.path, extra: 'удалён', tone: 'del' };
    case 'folder.created':
      return { icon: FolderPlus, title: p.path + '/', extra: 'новая папка', tone: 'add' };
    case 'folder.deleted':
      return { icon: FolderMinus, title: p.path + '/', extra: 'папка удалена', tone: 'del' };
    case 'file.comment':
      return { icon: MessageSquare, title: p.path, extra: `«${String(p.comment.text).slice(0, 60)}»`, tone: 'upd' };
    case 'message.created':
      return { icon: MessageSquare, title: `#${p.message.channelId}`, extra: String(p.message.text || p.message.file?.name || '').slice(0, 80), tone: 'upd' };
    case 'message.updated':
      return { icon: MessageSquare, title: `#${p.message.channelId}`, extra: 'сообщение изменено', tone: 'upd' };
    case 'message.deleted':
      return { icon: Trash2, title: `#${p.channelId}`, extra: 'сообщение удалено', tone: 'del' };
    case 'user.updated':
      return { icon: User, title: p.user.nickname, extra: 'обновил(а) профиль', tone: 'upd' };
    default:
      return { icon: FileText, title: ev.type, extra: '', tone: 'upd' };
  }
}

export function ActivityItem({ ev }: { ev: HoloEvent }) {
  const users = useStore((s) => s.users);
  const files = useStore((s) => s.files);
  const d = describe(ev);
  const Icon = d.icon;
  const fileId = ev.payload?.file?.id ?? ev.payload?.comment?.fileId;
  const file = fileId ? files[fileId] : undefined;
  const author = ev.userId ? users[ev.userId]?.nickname : 'Система';

  return (
    <button className={styles.item} disabled={!file} onClick={() => file && openFile(file)}>
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
