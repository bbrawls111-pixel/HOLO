import { create } from 'zustand';
import { api } from './api';
import notifySoundUrl from './assets/notify.mp3';
import type { Board, Bootstrap, Channel, HoloEvent, HoloFile, Me, Message, Stats, User } from './types';

export type Page = 'home' | 'library' | 'chat' | 'docs' | 'charts' | 'structures' | 'history' | 'trash' | 'settings';

/** Личка двух разработчиков — канал «general». */
export const DM_CHANNEL = 'general';

export type AiProvider = 'chatgpt' | 'gemini' | 'claude' | 'fish' | 'meshy' | 'mixamo';
export type ChatTarget = 'dm' | `ai:${AiProvider}`;

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

export interface LibraryForm {
  title: string;
  description: string;
}

type DialogState =
  | {
      kind: 'prompt' | 'confirm';
      title: string;
      message?: string;
      value?: string;
      confirmText?: string;
      danger?: boolean;
      resolve: (v: string | boolean | null) => void;
    }
  | {
      kind: 'library';
      title: string;
      message?: string;
      fileName: string;
      preview?: string | null;
      value: LibraryForm;
      confirmText?: string;
      resolve: (v: LibraryForm | null) => void;
    };

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
  chatTarget: ChatTarget;
  files: Record<number, HoloFile>;
  boards: Record<number, Board>;
  activity: HoloEvent[];
  stats: Stats | null;
  page: Page;
  visited: Partial<Record<Page, boolean>>;
  selectedFileId: number | null;
  openBoard: Partial<Record<'chart' | 'tree' | 'doc', number | null>>;
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
  chatTarget: 'dm',
  files: {},
  boards: {},
  activity: [],
  stats: null,
  page: 'home',
  visited: { home: true },
  selectedFileId: null,
  openBoard: {},
  toasts: [],
  dialog: null,
}));

const set = useStore.setState;
const get = useStore.getState;

/** Шина для компонентов, которым нужно реагировать на конкретные события. */
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

/** «Сохранить в библиотеку?» — название и описание можно оставить пустыми. */
export function askLibrary(opts: {
  fileName: string;
  title?: string;
  message?: string;
  preview?: string | null;
  initial?: Partial<LibraryForm>;
  confirmText?: string;
}): Promise<LibraryForm | null> {
  return new Promise((resolve) =>
    set({
      dialog: {
        kind: 'library',
        title: opts.title ?? 'Сохранить в библиотеку?',
        message: opts.message,
        fileName: opts.fileName,
        preview: opts.preview,
        value: { title: opts.initial?.title ?? '', description: opts.initial?.description ?? '' },
        confirmText: opts.confirmText ?? 'Сохранить',
        resolve,
      },
    }),
  );
}

export function navigate(page: Page) {
  set((s) => ({
    page,
    visited: { ...s.visited, [page]: true },
    unread: page === 'chat' && s.chatTarget === 'dm' ? { ...s.unread, [DM_CHANNEL]: 0 } : s.unread,
  }));
}

export function openChat(target: ChatTarget) {
  set((s) => ({
    chatTarget: target,
    unread: target === 'dm' ? { ...s.unread, [DM_CHANNEL]: 0 } : s.unread,
  }));
  navigate('chat');
}

export function openFile(file: Pick<HoloFile, 'id'>) {
  set({ selectedFileId: file.id });
  navigate('library');
}

export function openBoardPage(kind: 'chart' | 'tree' | 'doc', id: number) {
  set((s) => ({ openBoard: { ...s.openBoard, [kind]: id } }));
  navigate(kind === 'chart' ? 'charts' : kind === 'tree' ? 'structures' : 'docs');
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
  set({ me, serverUrl, phase: 'app', page: 'home', visited: { home: true } });
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
    boards: {},
    activity: [],
    stats: null,
    selectedFileId: null,
    openBoard: {},
  });
}

export async function loadAll() {
  try {
    const b = await api<Bootstrap>('GET', '/api/bootstrap');
    set({
      me: b.me,
      users: Object.fromEntries(b.users.map((u) => [u.id, u])),
      channels: b.channels,
      files: Object.fromEntries(b.files.map((f) => [f.id, f])),
      boards: Object.fromEntries(b.boards.map((x) => [x.id, x])),
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

export function upsertFile(f: HoloFile) {
  if (f.scope !== 'library') return;
  set((s) => ({ files: { ...s.files, [f.id]: f } }));
}

export function upsertBoard(b: Board) {
  set((s) => ({ boards: { ...s.boards, [b.id]: b } }));
}

export function removeBoard(id: number) {
  set((s) => {
    const boards = { ...s.boards };
    delete boards[id];
    return { boards };
  });
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
      const user = { ...p.user, online: prev?.online ?? p.user.online, lastSeen: prev?.lastSeen ?? p.user.lastSeen };
      set({ users: { ...s.users, [user.id]: user } });
      if (s.me && s.me.id === user.id) set({ me: { ...s.me, ...user, online: s.me.online } });
      break;
    }
    case 'message.created': {
      const m: Message = p.message;
      upsertMessage(m);
      if (m.userId !== s.me?.id) {
        playNotifySound();
        const viewing = s.page === 'chat' && s.chatTarget === 'dm' && m.channelId === DM_CHANNEL;
        if (!viewing) set((st) => ({ unread: { ...st.unread, [m.channelId]: (st.unread[m.channelId] || 0) + 1 } }));
        if (!viewing || !document.hasFocus()) notify(m);
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
    case 'file.moved':
      upsertFile(p.file);
      pushActivity(ev);
      break;
    case 'file.deleted':
      set((st) => {
        const files = { ...st.files };
        delete files[p.id];
        return { files, selectedFileId: st.selectedFileId === p.id ? null : st.selectedFileId };
      });
      pushActivity(ev);
      break;
    case 'file.comment':
      pushActivity(ev);
      break;
    case 'trash.changed':
      break;
    case 'board.created':
    case 'board.updated':
      upsertBoard(p.board);
      if (ev.type === 'board.created') pushActivity(ev);
      break;
    case 'board.deleted':
      removeBoard(p.id);
      pushActivity(ev);
      break;
  }
  eventBus.dispatchEvent(new CustomEvent(ev.type, { detail: ev }));
}

function pushActivity(ev: HoloEvent) {
  if (!ev.seq) return;
  set((s) => ({ activity: [ev, ...s.activity.filter((a) => a.seq !== ev.seq)].slice(0, 100) }));
}

// Звук входящего сообщения: громкость 30%.
let notifyAudio: HTMLAudioElement | null = null;
let lastSoundAt = 0;
export function playNotifySound() {
  const now = Date.now();
  if (now - lastSoundAt < 700) return; // пачка сообщений — один звук
  lastSoundAt = now;
  try {
    notifyAudio ??= new Audio(notifySoundUrl);
    notifyAudio.volume = 0.3;
    notifyAudio.currentTime = 0;
    void notifyAudio.play().catch(() => {});
  } catch {
    /* звук недоступен */
  }
}

function notify(m: Message) {
  const s = get();
  const author = s.users[m.userId]?.nickname || 'Сообщение';
  try {
    // Системный звук выключаем — играет свой, тише.
    const n = new Notification(author, { body: m.text || (m.file ? `📎 ${m.file.name}` : ''), silent: true });
    n.onclick = () => openChat('dm');
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
        refreshUsers();
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
