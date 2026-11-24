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

/** Загрузка одного файла. С диска — потоком через главный процесс, иначе — из памяти. */
export async function uploadOne(file: File, remotePath: string): Promise<HoloFile | null> {
  const id = ++seq;
  useUploads.setState((s) => ({ jobs: [...s.jobs, { id, name: remotePath, status: 'uploading' }] }));
  const localPath = window.holo.pathForFile(file);
  const r = await window.holo.upload(
    localPath ? { localPath, remotePath } : { data: await file.arrayBuffer(), remotePath },
  );
  if (!r.ok || !r.data) {
    update(id, { status: 'error' });
    toast(`${file.name}: ${r.error || 'ошибка загрузки'}`);
    setTimeout(() => remove(id), 6000);
    return null;
  }
  update(id, { status: 'done' });
  setTimeout(() => remove(id), 2500);
  return r.data.file;
}

export interface DroppedFile {
  file: File;
  rel: string; // относительный путь, включая вложенные папки
}

/**
 * Собирает файлы из drag&drop, включая содержимое перетащенных папок.
 * Вызывать синхронно в обработчике drop: DataTransfer очищается после await.
 */
export function collectDropped(dt: DataTransfer): Promise<DroppedFile[]> {
  const entries = Array.from(dt.items)
    .map((i) => (i.kind === 'file' ? i.webkitGetAsEntry?.() : null))
    .filter((e): e is FileSystemEntry => !!e);
  const plain = Array.from(dt.files);

  return (async () => {
    if (!entries.length) return plain.map((file) => ({ file, rel: file.name }));
    const out: DroppedFile[] = [];
    const walk = async (entry: FileSystemEntry, prefix: string): Promise<void> => {
      if (entry.isFile) {
        const file = await new Promise<File>((res, rej) => (entry as FileSystemFileEntry).file(res, rej));
        out.push({ file, rel: prefix + entry.name });
      } else if (entry.isDirectory) {
        const reader = (entry as FileSystemDirectoryEntry).createReader();
        for (;;) {
          const batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej));
          if (!batch.length) break;
          for (const child of batch) await walk(child, prefix + entry.name + '/');
        }
      }
    };
    for (const e of entries) await walk(e, '');
    return out;
  })();
}
