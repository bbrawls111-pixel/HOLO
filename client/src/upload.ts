import { create } from 'zustand';
import { toast } from './store';
import type { HoloFile } from './types';

export interface UploadJob {
  id: number;
  name: string;
  status: 'uploading' | 'done' | 'error';
}

export const useUploads = create<{ jobs: UploadJob[] }>(() => ({ jobs: [] }));

let seq = 0;
const update = (id: number, patch: Partial<UploadJob>) =>
  useUploads.setState((s) => ({ jobs: s.jobs.map((j) => (j.id === id ? { ...j, ...patch } : j)) }));
const remove = (id: number) => useUploads.setState((s) => ({ jobs: s.jobs.filter((j) => j.id !== id) }));

export interface UploadOptions {
  scope?: 'library' | 'chat';
  title?: string;
  description?: string;
  fileId?: number; // новая версия существующего файла
  localPath?: string; // путь на диске (если файла нет в виде File)
  name?: string;
}

/** Загрузка одного файла. С диска — потоком через главный процесс, иначе — из памяти. */
export async function uploadOne(file: File | null, opts: UploadOptions = {}): Promise<HoloFile | null> {
  const id = ++seq;
  const name = opts.name || file?.name || 'file';
  useUploads.setState((s) => ({ jobs: [...s.jobs, { id, name, status: 'uploading' }] }));
  const localPath = opts.localPath || (file ? window.holo.pathForFile(file) : null);
  const r = await window.holo.upload({
    ...(localPath ? { localPath } : { data: await file!.arrayBuffer() }),
    name,
    scope: opts.scope,
    title: opts.title,
    description: opts.description,
    fileId: opts.fileId,
  });
  if (!r.ok || !r.data) {
    update(id, { status: 'error' });
    toast(`${name}: ${r.error || 'ошибка загрузки'}`);
    setTimeout(() => remove(id), 6000);
    return null;
  }
  update(id, { status: 'done' });
  setTimeout(() => remove(id), 2500);
  return r.data.file;
}

/**
 * Собирает файлы из drag&drop, включая содержимое перетащенных папок.
 * Вызывать синхронно в обработчике drop: DataTransfer очищается после await.
 */
export function collectDropped(dt: DataTransfer): Promise<File[]> {
  const entries = Array.from(dt.items)
    .map((i) => (i.kind === 'file' ? i.webkitGetAsEntry?.() : null))
    .filter((e): e is FileSystemEntry => !!e);
  const plain = Array.from(dt.files);

  return (async () => {
    if (!entries.length) return plain;
    const out: File[] = [];
    const walk = async (entry: FileSystemEntry): Promise<void> => {
      if (entry.isFile) {
        out.push(await new Promise<File>((res, rej) => (entry as FileSystemFileEntry).file(res, rej)));
      } else if (entry.isDirectory) {
        const reader = (entry as FileSystemDirectoryEntry).createReader();
        for (;;) {
          const batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej));
          if (!batch.length) break;
          for (const child of batch) await walk(child);
        }
      }
    };
    for (const e of entries) await walk(e);
    return out;
  })();
}
