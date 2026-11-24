import type { HoloFile, User } from './types';

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} Б`;
  const units = ['КБ', 'МБ', 'ГБ', 'ТБ'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

export function timeAgo(ts: number | null | undefined): string {
  if (!ts) return 'давно';
  const diff = Date.now() - ts;
  const min = Math.floor(diff / 60_000);
  if (min < 1) return 'только что';
  if (min < 60) return `${min} мин назад`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} ч назад`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d} дн назад`;
  return new Date(ts).toLocaleDateString('ru-RU');
}

export const formatTime = (ts: number) =>
  new Date(ts).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });

export function formatDateTime(ts: number): string {
  const d = new Date(ts);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  return sameDay
    ? `сегодня, ${formatTime(ts)}`
    : d.toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

export function presenceText(u: User): string {
  return u.online ? 'Онлайн' : `Был(а) ${timeAgo(u.lastSeen)}`;
}

export function initials(name: string): string {
  const parts = name.trim().split(/[\s_\-.]+/).filter(Boolean);
  const s = parts.length > 1 ? parts[0][0] + parts[1][0] : name.slice(0, 2);
  return s.toUpperCase();
}

const GRADIENTS = [
  ['#7c5cff', '#c084fc'],
  ['#3b82f6', '#22d3ee'],
  ['#f43f5e', '#fb923c'],
  ['#10b981', '#84cc16'],
  ['#f59e0b', '#ef4444'],
  ['#8b5cf6', '#ec4899'],
  ['#06b6d4', '#6366f1'],
  ['#64748b', '#334155'],
];
export const AVATAR_GRADIENTS = GRADIENTS;
export const gradientFor = (id: number) => GRADIENTS[Math.abs(id) % GRADIENTS.length];

export const joinPath = (folder: string, name: string) => (folder ? `${folder}/${name}` : name);
export const parentOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
export const baseName = (p: string) => p.slice(p.lastIndexOf('/') + 1);
export const isUnder = (p: string, folder: string) => !folder || p === folder || p.startsWith(folder + '/');

export type FileKind = 'image' | 'audio' | 'video' | 'text' | 'font' | 'code' | 'other';

export function fileKind(f: Pick<HoloFile, 'mime' | 'name'>): FileKind {
  const ext = f.name.split('.').pop()?.toLowerCase() || '';
  if (f.mime.startsWith('image/')) return 'image';
  if (f.mime.startsWith('audio/')) return 'audio';
  if (f.mime.startsWith('video/')) return 'video';
  if (f.mime.startsWith('font/')) return 'font';
  if (['js', 'ts', 'tsx', 'jsx', 'css', 'html', 'json', 'xml', 'yaml', 'yml', 'cs', 'gd', 'lua', 'py'].includes(ext)) return 'code';
  if (f.mime.startsWith('text/') || ['md', 'txt', 'csv', 'ini', 'cfg', 'log'].includes(ext)) return 'text';
  return 'other';
}

export function cx(...names: (string | false | null | undefined)[]): string {
  return names.filter(Boolean).join(' ');
}
