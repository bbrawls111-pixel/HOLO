import { create } from 'zustand';
import { api } from './api';
import type { Bootstrap, Channel, HoloEvent, HoloFile, Me, Message, Stats, User } from './types';
import { isUnder } from './util';

export type Page = 'home' | 'resources' | 'charts' | 'structures' | 'chat' | 'ai' | 'docs' | 'history' | 'settings';

interface ChannelMessages {
  items: Message[];
  hasMore: boolean;
  loaded: boolean;
}

interface Toast {
  id: number;
  text: string;
  kind: 'error' | 'info';
}

interface DialogState {
  kind: 'prompt' | 'confirm';
  title: string;
  message?: string;
  value?: string;
  confirmText?: string;
  danger?: boolean;
  resolve: (v: string | boolean | null) => void;
}

interface State {
  phase: 'boot' | 'login' | 'app';
  serverUrl: string;
  me: Me | null;
  connection: 'connecting' | 'online' | 'offline';
  loaded: boolean;
  users: Record<number, User>;
  channels: Channel[];
  messages: Record<string, ChannelMessages>;
  unread: Record<string, number>;
  activeChannel: string;
  folders: string[];
  files: Record<number, HoloFile>;
  activity: HoloEvent[];
  stats: Stats | null;
  page: Page;
  resourceFolder: string;
  selectedFileId: number | null;
  search: string;
  toasts: Toast[];
  dialog: DialogState | null;
}

export const useStore = create<State>(() => ({
  phase: 'boot',
  serverUrl: '',
  me: null,
  connection: 'connecting',
  loaded: false,
  users: {},
  channels: [],
  messages: {},
  unread: {},
  activeChannel: 'general',
  folders: [],
  files: {},
  activity: [],
  stats: null,
  page: 'home',
  resourceFolder: '',
  selectedFileId: null,
  search: '',
  toasts: [],
  dialog: null,
}));

const set = useStore.setState;
const get = useStore.getState;

/** Шина для компонентов, которым нужно реагировать на конкретные события (комментарии, версии). */
export const eventBus = new EventTarget();

// ------------------------------------------------------------------ UI helpers
let toastId = 0;
export function toast(text: string, kind: Toast['kind'] = 'error') {
  const id = ++toastId;
  set((s) => ({ toasts: [...s.toasts, { id, text, kind }] }));
  setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), 4500);
}

export function askText(title: string, value = '', confirmText = 'OK'): Promise<string | null> {
  return new Promise((resolve) =>
    set({ dialog: { kind: 'prompt', title, value, confirmText, resolve: (v) => resolve(v as string | null) } }),
  );
}

export function confirmAction(title: string, message: string, confirmText = 'Удалить'): Promise<boolean> {
  return new Promise((resolve) =>
    set({ dialog: { kind: 'confirm', title, message, confirmText, danger: true, resolve: (v) => resolve(!!v) } }),
  );
}

export function navigate(page: Page) {
  set((s) => ({
    page,
    unread: page === 'chat' ? { ...s.unread, [s.activeChannel]: 0 } : s.unread,
  }));
}

export function openFile(file: HoloFile) {
  set({ page: 'resources', resourceFolder: file.folder, selectedFileId: file.id, search: '' });
}

// ------------------------------------------------------------------ сессия
export async function boot() {
  const s = await window.holo.getSession();
  if (s.user) {
    set({ serverUrl: s.serverUrl, me: s.user, phase: 'app' });
    await loadAll();
  } else {
    set({ serverUrl: s.serverUrl, phase: 'login' });
    if (s.error) toast(s.error);
  }
}

export function enterApp(me: Me, serverUrl: string) {
  set({ me, serverUrl, phase: 'app', page: 'home' });
  loadAll();
}

export async function logout() {
  await window.holo.logout();
  resetSession();
}

export function resetSession() {
  set({
    phase: 'login',
    me: null,
    loaded: false,
    users: {},
    messages: {},
    unread: {},
    files: {},
    folders: [],
    activity: [],
    stats: null,
    selectedFileId: null,
  });
}

export async function loadAll() {
  try {
    const b = await api<Bootstrap>('GET', '/api/bootstrap');
    set({
      me: b.me,
      users: Object.fromEntries(b.users.map((u) => [u.id, u])),
      channels: b.channels,
      folders: b.folders,
      files: Object.fromEntries(b.files.map((f) => [f.id, f])),
      activity: b.activity,
      stats: b.stats,
      messages: {},
      loaded: true,
    });
  } catch (e) {
    toast((e as Error).message);
  }
}

export async function refreshUsers() {
  try {
    const users = await api<User[]>('GET', '/api/users');
    set({ users: Object.fromEntries(users.map((u) => [u.id, u])) });
  } catch {
    /* повторим при следующем подключении */
  }
}

export async function refreshStats() {
  try {
    set({ stats: await api<Stats>('GET', '/api/stats') });
  } catch {
    /* не критично */
  }
}

// ------------------------------------------------------------------ чат
export async function loadMessages(channelId: string, older = false) {
  const cur = get().messages[channelId];
  if (!older && cur?.loaded) return;
  const before = older && cur?.items.length ? `&before=${cur.items[0].id}` : '';
  const r = await api<{ messages: Message[]; hasMore: boolean }>(
    'GET',
    `/api/channels/${encodeURIComponent(channelId)}/messages?limit=50${before}`,
  );
  set((s) => {
    const existing = s.messages[channelId]?.items ?? [];
    const known = new Set(existing.map((m) => m.id));
    const items = older ? [...r.messages.filter((m) => !known.has(m.id)), ...existing] : mergeMessages(r.messages, existing);
    return { messages: { ...s.messages, [channelId]: { items, hasMore: r.hasMore, loaded: true } } };
  });
}

function mergeMessages(a: Message[], b: Message[]) {
  const map = new Map<number, Message>();
  [...a, ...b].forEach((m) => map.set(m.id, m));
  return [...map.values()].sort((x, y) => x.id - y.id);
}

function upsertMessage(m: Message) {
  set((s) => {
    const ch = s.messages[m.channelId];
    if (!ch?.loaded) return {};
    return { messages: { ...s.messages, [m.channelId]: { ...ch, items: mergeMessages(ch.items, [m]) } } };
  });
}

export function addOwnMessage(m: Message) {
  upsertMessage(m);
}

export function setActiveChannel(id: string) {
  set((s) => ({ activeChannel: id, unread: { ...s.unread, [id]: 0 } }));
}

// ------------------------------------------------------------------ события с сервера
export function applyEvent(ev: HoloEvent) {
  const p = ev.payload;
  const s = get();
  switch (ev.type) {
    case 'presence.changed': {
      const u = s.users[p.userId];
      if (u) set({ users: { ...s.users, [u.id]: { ...u, online: p.online, lastSeen: p.lastSeen } } });
      break;
    }
    case 'user.updated': {
      const prev = s.users[p.user.id];
      // онлайн-статус не меняется событием профиля
      const user = { ...p.user, online: prev?.online ?? p.user.online, lastSeen: prev?.lastSeen ?? p.user.lastSeen };
      set({ users: { ...s.users, [user.id]: user } });
      if (s.me && s.me.id === user.id) set({ me: { ...s.me, ...user, online: s.me.online } });
      break;
    }
    case 'message.created': {
      const m: Message = p.message;
      upsertMessage(m);
      const viewing = s.page === 'chat' && s.activeChannel === m.channelId && document.hasFocus();
      if (m.userId !== s.me?.id) {
        if (!(s.page === 'chat' && s.activeChannel === m.channelId)) {
          set((st) => ({ unread: { ...st.unread, [m.channelId]: (st.unread[m.channelId] || 0) + 1 } }));
        }
        if (!viewing) notify(m);
      }
      break;
    }
    case 'message.updated':
      upsertMessage(p.message);
      break;
    case 'message.deleted':
      set((st) => {
        const ch = st.messages[p.channelId];
        if (!ch) return {};
        return { messages: { ...st.messages, [p.channelId]: { ...ch, items: ch.items.filter((m) => m.id !== p.id) } } };
      });
      break;
    case 'file.created':
    case 'file.updated':
    case 'file.moved': {
      const f: HoloFile = p.file;
      set((st) => ({ files: { ...st.files, [f.id]: f } }));
      pushActivity(ev);
      break;
    }
    case 'file.deleted':
      set((st) => {
        const files = { ...st.files };
        delete files[p.id];
        return { files, selectedFileId: st.selectedFileId === p.id ? null : st.selectedFileId };
      });
      pushActivity(ev);
      break;
    case 'folder.created':
      set((st) => (st.folders.includes(p.path) ? {} : { folders: [...st.folders, p.path].sort() }));
      break;
    case 'folder.deleted':
      set((st) => {
        const files = { ...st.files };
        (p.fileIds as number[]).forEach((id) => delete files[id]);
        return {
          files,
          folders: st.folders.filter((f) => !isUnder(f, p.path)),
          resourceFolder: isUnder(st.resourceFolder, p.path) ? '' : st.resourceFolder,
          selectedFileId: st.selectedFileId && files[st.selectedFileId] ? st.selectedFileId : null,
        };
      });
      pushActivity(ev);
      break;
    case 'file.comment':
      pushActivity(ev);
      break;
  }
  eventBus.dispatchEvent(new CustomEvent(ev.type, { detail: ev }));
}

function pushActivity(ev: HoloEvent) {
  if (!ev.seq) return;
  set((s) => ({ activity: [ev, ...s.activity.filter((a) => a.seq !== ev.seq)].slice(0, 100) }));
}

function notify(m: Message) {
  const s = get();
  if (document.hasFocus() && s.page === 'chat') return;
  const author = s.users[m.userId]?.nickname || 'Сообщение';
  const channel = s.channels.find((c) => c.id === m.channelId)?.name || m.channelId;
  try {
    const n = new Notification(`${author} · #${channel}`, { body: m.text || (m.file ? `📎 ${m.file.name}` : ''), silent: false });
    n.onclick = () => {
      setActiveChannel(m.channelId);
      navigate('chat');
    };
  } catch {
    /* уведомления недоступны */
  }
}

// ------------------------------------------------------------------ подписка на главный процесс
export function connectBridge() {
  let wasOffline = false;
  const offs = [
    window.holo.on('holo:event', applyEvent),
    window.holo.on('holo:connection', ({ state }: { state: State['connection'] }) => {
      set({ connection: state });
      if (state === 'offline') wasOffline = true;
      if (state === 'online' && wasOffline) {
        wasOffline = false;
        refreshUsers(); // статусы присутствия не журналируются — обновим разом
      }
    }),
    window.holo.on('holo:resync', () => loadAll()),
    window.holo.on('holo:presence', (users: User[]) =>
      set((s) => ({ users: { ...s.users, ...Object.fromEntries(users.map((u) => [u.id, u])) } })),
    ),
    window.holo.on('holo:loggedOut', () => {
      resetSession();
      toast('Сессия завершена. Войдите снова.');
    }),
  ];
  return () => offs.forEach((off) => off());
}
