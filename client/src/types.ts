import type React from 'react';

export interface User {
  id: number;
  nickname: string;
  hasAvatar: boolean;
  avatarVersion: number;
  online: boolean;
  lastSeen: number | null;
}

export interface Me extends User {
  login: string;
  needsSetup: boolean;
}

export interface HoloFile {
  id: number;
  path: string;
  folder: string;
  name: string;
  size: number;
  mime: string;
  version: number;
  updatedBy: number | null;
  updatedAt: number;
  scope: 'library' | 'chat';
  title: string;
  description: string;
}

export type BoardKind = 'chart' | 'tree' | 'doc';

export interface ChartData {
  type: 'line' | 'bar' | 'area' | 'pie' | 'radar' | 'scatter';
  columns: string[]; // [подпись, серия1, серия2…]
  rows: (string | number)[][];
}

export interface TreeNode {
  id: string;
  parentId: string | null;
  label: string;
  /** Подробное описание блока. */
  note?: string;
  category?: string;
  color?: string;
  /** Ручной сдвиг относительно автоматической раскладки (двигает и всю ветку). */
  dx?: number;
  dy?: number;
}

export interface TreeCategory {
  id: string;
  name: string;
  color: string;
}

export interface TreeData {
  nodes: TreeNode[];
  direction?: 'TB' | 'LR';
  categories?: TreeCategory[];
}

export interface DocData {
  text: string;
}

export interface Board<T = unknown> {
  id: number;
  kind: BoardKind;
  title: string;
  data: T;
  private: boolean;
  ownerId: number | null;
  version: number;
  createdBy: number | null;
  createdAt: number;
  updatedBy: number | null;
  updatedAt: number;
}

export interface FileVersion {
  version: number;
  size: number;
  userId: number | null;
  note: string | null;
  createdAt: number;
}

export interface FileComment {
  id: number;
  fileId: number;
  userId: number;
  text: string;
  createdAt: number;
}

export interface Channel {
  id: string;
  name: string;
}

export interface Message {
  id: number;
  channelId: string;
  userId: number;
  text: string;
  file: HoloFile | null;
  createdAt: number;
  editedAt: number | null;
}

export interface HoloEvent {
  seq?: number;
  type: string;
  payload: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  userId?: number | null;
  createdAt?: number;
}

export interface Stats {
  month: string;
  ops: number;
  opsLimit: number;
  storageBytes: number;
  files: number;
  messages: number;
  presenceIntervalMs: number;
}

export interface Bootstrap {
  me: Me;
  users: User[];
  channels: Channel[];
  files: HoloFile[];
  boards: Board[];
  activity: HoloEvent[];
  stats: Stats;
  lastSeq: number;
}

export interface Result<T> {
  ok: boolean;
  status?: number;
  data?: T;
  error?: string;
  canceled?: boolean;
}

export interface Captured3D {
  id: string;
  url: string;
  name: string;
  /** locked — сайт отдал модель зашифрованной (Meshy .meshy), открыть её нельзя */
  kind: 'model' | 'texture' | 'locked';
  /** модель, скачанная кнопкой «Скачать» на сайте (лежит в «Загрузки/Holo») */
  localPath?: string;
  size: number;
  group: string;
  groupLabel: string;
  at: number;
}

export interface HoloBridge {
  getSession(): Promise<{ serverUrl: string; user: Me | null; error?: string | null; offline?: boolean }>;
  login(serverUrl: string, login: string, password: string): Promise<Result<Me>>;
  logout(): Promise<Result<unknown>>;
  setupInfo(serverUrl: string): Promise<Result<{ open: boolean; users: number; maxUsers: number }>>;
  register(serverUrl: string, code: string, login: string, password: string): Promise<Result<Me>>;
  request<T>(method: string, path: string, body?: unknown): Promise<Result<T>>;
  upload(opts: {
    localPath?: string | null;
    data?: ArrayBuffer;
    name: string;
    scope?: 'library' | 'chat';
    title?: string;
    description?: string;
    fileId?: number;
  }): Promise<Result<{ file: HoloFile }>>;
  uploadAvatar(data: ArrayBuffer, mime: string): Promise<Result<Me>>;
  fetchBinary(path: string): Promise<{ ok: boolean; mime?: string; data?: Uint8Array; error?: string }>;
  download(fileId: number, name: string, version?: number): Promise<Result<unknown> & { path?: string }>;
  openExternal(url: string): Promise<void>;
  capturedList(partition: string): Promise<Captured3D[]>;
  capturedSave(partition: string, id: string): Promise<Result<unknown> & { path?: string; dir?: string; files?: number }>;
  capturedClear(partition: string): Promise<void>;
  capturedFetch(partition: string, id: string): Promise<{ ok: boolean; name?: string; data?: Uint8Array; error?: string }>;
  openLoginWindow(partition: string, url: string, title?: string): Promise<{ ok: boolean }>;
  appVersion(): Promise<string>;
  screenSources(): Promise<{ id: string; name: string; screen: boolean; thumbnail: string; icon: string | null }[]>;
  setScreenSource(id: string): Promise<void>;
  saveFiles(folder: string, files: { name: string; data: Uint8Array }[]): Promise<{ ok: boolean; path?: string; dir?: string; files?: number; error?: string }>;
  pathForFile(file: File): string | null;
  on(channel: string, handler: (payload: any) => void): () => void; // eslint-disable-line @typescript-eslint/no-explicit-any
}

declare global {
  interface Window {
    holo: HoloBridge;
  }
}

declare module 'react' {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace JSX {
    interface IntrinsicElements {
      webview: React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement> & {
        src?: string;
        partition?: string;
        allowpopups?: string;
      };
    }
  }
}
