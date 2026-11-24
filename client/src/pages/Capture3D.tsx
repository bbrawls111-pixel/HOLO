import { BookmarkPlus, Box, Download, Image, Loader2, Trash2, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { askLibrary, toast } from '../store';
import type { Captured3D } from '../types';
import { uploadOne } from '../upload';
import { cx, formatBytes, timeAgo } from '../util';
import styles from './Capture3D.module.css';

/** Подписка на файлы 3D-моделей, которые загрузила страница Meshy в этой сессии. */
export function useCaptured(partition: string) {
  const [items, setItems] = useState<Captured3D[]>([]);
  useEffect(() => {
    let alive = true;
    window.holo.capturedList(partition).then((l) => alive && setItems(l));
    const off = window.holo.on('holo:captured', (p: { partition: string; items: Captured3D[] }) => {
      if (p.partition === partition) setItems(p.items);
    });
    return () => {
      alive = false;
      off();
    };
  }, [partition]);
  return items;
}

export function Capture3DPanel({ partition, onClose }: { partition: string; onClose: () => void }) {
  const items = useCaptured(partition);
  const [busy, setBusy] = useState<string | null>(null);

  const groups = useMemo(() => {
    const map = new Map<string, { label: string; models: Captured3D[]; textures: Captured3D[]; at: number }>();
    for (const it of items) {
      const g = map.get(it.group) ?? { label: it.groupLabel, models: [], textures: [], at: 0 };
      (it.kind === 'model' ? g.models : g.textures).push(it);
      g.at = Math.max(g.at, it.at);
      map.set(it.group, g);
    }
    return [...map.values()].filter((g) => g.models.length).sort((a, b) => b.at - a.at);
  }, [items]);
  const looseTextures = items.filter((i) => i.kind === 'texture').length;

  const save = async (item: Captured3D, toLibrary: boolean) => {
    setBusy(item.id + toLibrary);
    const r = await window.holo.capturedSave(partition, item.id);
    setBusy(null);
    if (!r.ok || !r.path) return toast(r.error || 'Не удалось скачать модель');
    toast(`Сохранено в «Загрузки/Holo/3D» — файлов: ${r.files}`, 'info');
    if (!toLibrary) return;
    const form = await askLibrary({
      fileName: `${item.name}${item.size ? ' · ' + formatBytes(item.size) : ''}`,
      title: 'Добавить модель в библиотеку',
      message: /\.gltf$/i.test(item.name)
        ? 'Внимание: .gltf хранит текстуры отдельными файлами — в библиотеку попадёт только сам .gltf. Для полной модели лучше .glb.'
        : 'Модель увидит напарник. Текстуры лежат рядом в папке на диске.',
      confirmText: 'Добавить',
    });
    if (form) await uploadOne(null, { localPath: r.path, name: item.name, scope: 'library', ...form });
  };

  return (
    <div className={styles.panel}>
      <div className={styles.head}>
        <div>
          <div className={styles.title}>
            <Box size={16} /> 3D-модели
          </div>
          <div className={styles.sub}>Откройте модель на странице Meshy — она появится здесь</div>
        </div>
        <div className={styles.headBtns}>
          {items.length > 0 && (
            <button className="btn ghost sm icon" title="Очистить список" onClick={() => window.holo.capturedClear(partition)}>
              <Trash2 size={15} />
            </button>
          )}
          <button className="btn ghost sm icon" onClick={onClose}>
            <X size={16} />
          </button>
        </div>
      </div>

      <div className={styles.list}>
        {groups.map((g, gi) => (
          <div key={gi} className={styles.group}>
            {g.models.map((m) => (
              <div key={m.id} className={styles.item}>
                <span className={styles.icon}>
                  <Box size={18} />
                </span>
                <div className={styles.info}>
                  <div className={styles.name}>{m.name}</div>
                  <div className={styles.meta}>
                    {m.size ? formatBytes(m.size) + ' · ' : ''}
                    {g.textures.length ? `текстур: ${g.textures.length} · ` : ''}
                    {timeAgo(m.at)}
                  </div>
                </div>
                <button className="btn sm icon" title="Скачать с текстурами" disabled={!!busy} onClick={() => save(m, false)}>
                  {busy === m.id + 'false' ? <Loader2 size={15} className="spin" /> : <Download size={15} />}
                </button>
                <button className="btn sm icon primary" title="Скачать и добавить в библиотеку" disabled={!!busy} onClick={() => save(m, true)}>
                  {busy === m.id + 'true' ? <Loader2 size={15} className="spin" /> : <BookmarkPlus size={15} />}
                </button>
              </div>
            ))}
            {g.textures.length > 0 && (
              <div className={styles.textures}>
                {g.textures.slice(0, 6).map((t) => (
                  <span key={t.id} className={styles.tex} title={t.name}>
                    <Image size={11} /> {t.name.replace(/\.[^.]+$/, '').slice(0, 18)}
                  </span>
                ))}
                {g.textures.length > 6 && <span className={styles.tex}>+{g.textures.length - 6}</span>}
              </div>
            )}
          </div>
        ))}
        {!groups.length && (
          <div className={cx('empty', styles.empty)}>
            <Box size={36} strokeWidth={1.2} />
            <div>Пока ничего не поймано</div>
            <div className="faint" style={{ fontSize: 12 }}>
              Откройте свою модель в Meshy (просмотр 3D). Holo запомнит файлы модели и текстур, которые загрузит страница
              {looseTextures ? ` · текстур без модели: ${looseTextures}` : ''}.
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
