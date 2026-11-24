import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from './api';
import { removeBoard, toast, upsertBoard, useStore } from './store';
import type { Board, BoardKind } from './types';

export async function createBoard<T>(kind: BoardKind, title: string, data: T, isPrivate = false): Promise<Board<T>> {
  const b = await api<Board<T>>('POST', '/api/boards', { kind, title, data, private: isPrivate });
  upsertBoard(b as Board);
  useStore.setState((s) => ({ openBoard: { ...s.openBoard, [kind]: b.id } }));
  return b;
}

export async function deleteBoard(b: Board) {
  await api('DELETE', `/api/boards/${b.id}`);
  removeBoard(b.id);
  useStore.setState((s) => ({ openBoard: { ...s.openBoard, [b.kind]: null } }));
}

/**
 * Редактор доски: локальный черновик + автосохранение с задержкой.
 * Если напарник поменял доску, а у нас нет несохранённых правок — подхватываем его версию.
 * Если правки пересеклись — сервер вернёт 409, и мы загрузим свежую версию.
 */
export function useBoardEditor<T>(board: Board<T> | undefined, delay = 900) {
  const [draft, setDraft] = useState<{ title: string; data: T } | null>(board ? { title: board.title, data: board.data } : null);
  const [status, setStatus] = useState<'saved' | 'dirty' | 'saving' | 'error'>('saved');
  const dirty = useRef(false);
  const version = useRef(board?.version ?? 0);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const latest = useRef(draft);
  latest.current = draft;

  // Переключение на другую доску.
  useEffect(() => {
    clearTimeout(timer.current);
    dirty.current = false;
    version.current = board?.version ?? 0;
    setDraft(board ? { title: board.title, data: board.data } : null);
    setStatus('saved');
  }, [board?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Обновление с сервера (своё сохранение или правка напарника).
  useEffect(() => {
    if (!board || board.version <= version.current) return;
    version.current = board.version;
    if (!dirty.current) setDraft({ title: board.title, data: board.data });
  }, [board?.version]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = useCallback(async () => {
    if (!board || !latest.current || !dirty.current) return;
    const snapshot = latest.current;
    dirty.current = false;
    setStatus('saving');
    try {
      const b = await api<Board<T>>('PATCH', `/api/boards/${board.id}`, {
        title: snapshot.title.trim() || 'Без названия',
        data: snapshot.data,
        baseVersion: version.current,
      });
      version.current = b.version;
      upsertBoard(b as Board);
      setStatus(dirty.current ? 'dirty' : 'saved');
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        toast(e.message, 'info');
        const fresh = await api<Board<T>>('GET', `/api/boards/${board.id}`);
        version.current = fresh.version;
        upsertBoard(fresh as Board);
        setDraft({ title: fresh.title, data: fresh.data });
        setStatus('saved');
      } else {
        dirty.current = true;
        setStatus('error');
        toast((e as Error).message);
      }
    }
  }, [board]);

  const update = useCallback(
    (patch: Partial<{ title: string; data: T }>) => {
      setDraft((d) => (d ? { ...d, ...patch } : d));
      dirty.current = true;
      setStatus('dirty');
      clearTimeout(timer.current);
      timer.current = setTimeout(save, delay);
    },
    [save, delay],
  );

  // Сохранить незаписанное при уходе со страницы/доски.
  useEffect(() => () => {
    clearTimeout(timer.current);
    if (dirty.current) void save();
  }, [save]);

  return { draft, update, status, saveNow: save };
}

export const STATUS_TEXT = { saved: 'Сохранено', dirty: 'Есть изменения…', saving: 'Сохранение…', error: 'Ошибка сохранения' };
