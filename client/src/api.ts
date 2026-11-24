import { useEffect, useState } from 'react';

export class ApiError extends Error {
  constructor(message: string, public status = 0) {
    super(message);
  }
}

export async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await window.holo.request<T>(method, path, body);
  if (!r.ok) throw new ApiError(r.error || 'Ошибка', r.status);
  return r.data as T;
}

// ---- бинарные данные (аватары, превью) — кэшируются как blob: URL ----
const cache = new Map<string, Promise<string>>();

export function binaryUrl(path: string): Promise<string> {
  let p = cache.get(path);
  if (!p) {
    p = window.holo.fetchBinary(path).then((r) => {
      if (!r.ok || !r.data) throw new ApiError(r.error || 'Не удалось загрузить');
      return URL.createObjectURL(new Blob([r.data as Uint8Array<ArrayBuffer>], { type: r.mime }));
    });
    p.catch(() => cache.delete(path));
    cache.set(path, p);
  }
  return p;
}

export async function binaryText(path: string, maxBytes = 512 * 1024): Promise<string> {
  const r = await window.holo.fetchBinary(path);
  if (!r.ok || !r.data) throw new ApiError(r.error || 'Не удалось загрузить');
  const slice = r.data.subarray(0, maxBytes);
  const text = new TextDecoder('utf-8', { fatal: false }).decode(slice);
  return r.data.length > maxBytes ? text + '\n\n… (показано начало файла)' : text;
}

export function useBinaryUrl(path: string | null): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    setUrl(null);
    if (path) binaryUrl(path).then((u) => alive && setUrl(u)).catch(() => {});
    return () => {
      alive = false;
    };
  }, [path]);
  return url;
}

export const avatarPath = (u: { id: number; hasAvatar: boolean; avatarVersion: number }) =>
  u.hasAvatar ? `/api/users/${u.id}/avatar?v=${u.avatarVersion}` : null;

export const fileContentPath = (f: { id: number; version: number }, version?: number) =>
  `/api/files/${f.id}/content?version=${version ?? f.version}`;
