import { BookmarkPlus, Box, Download, Image, Loader2, Lock, Trash2, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { askLibrary, toast } from '../store';
import type { Captured3D } from '../types';
import { uploadOne } from '../upload';
import { cx, formatBytes, timeAgo } from '../util';
import styles from './Capture3D.module.css';

type Fmt = 'original' | 'glb' | 'gltf' | 'fbx' | 'obj' | 'stl' | 'usdz';
const FMT_OPTIONS: { id: Fmt; label: string; hint: string }[] = [
  { id: 'original', label: 'Исходник', hint: 'Файл ровно как его загрузил сайт (+ текстуры рядом)' },
  { id: 'glb', label: 'GLB', hint: 'Один файл, текстуры внутри — Unity, Unreal, Godot, Blender' },
  { id: 'gltf', label: 'glTF', hint: 'JSON-вариант glTF, текстуры встроены' },
  { id: 'fbx', label: 'FBX', hint: 'Текстуры встроены в файл — Mixamo, Unity, Unreal, Blender, 3ds Max' },
  { id: 'obj', label: 'OBJ+MTL', hint: 'Геометрия, материал и текстуры отдельными PNG' },
  { id: 'stl', label: 'STL', hint: 'Только геометрия — для 3D-печати' },
  { id: 'usdz', label: 'USDZ', hint: 'Apple / AR' },
];
const FMT_KEY = 'holo.3d.format';
const OPT_KEY = 'holo.3d.optimize';
// Те же уровни, что в three3d.ts (сам модуль three грузится лениво, при скачивании).
type OptLevel = 'off' | 'auto' | '100k' | '20k' | '5k';
const OPT_OPTIONS: { id: OptLevel; label: string; hint: string }[] = [
  { id: 'off', label: 'Без', hint: 'Сетка как есть' },
  { id: 'auto', label: 'Авто', hint: 'До 50 000 треугольников — обычный игровой ассет' },
  { id: '100k', label: '100k', hint: 'До 100 000 — герой / крупный план' },
  { id: '20k', label: '20k', hint: 'До 20 000 — второстепенные объекты' },
  { id: '5k', label: '5k', hint: 'До 5 000 — мобильные игры, дальние LOD' },
];

/** Подписка на файлы 3D-моделей, которые загрузила страница в этой сессии. */
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

const stem = (name: string) => name.replace(/\.[^.]+$/, '');

/** Скачать модель в выбранном формате (и с оптимизацией). Возвращает путь к основному файлу. */
async function downloadAs(
  partition: string,
  item: Captured3D,
  fmtIn: Fmt,
  opt: OptLevel,
): Promise<{ path: string; files: number; tris?: [number, number] }> {
  // Оптимизация — это пересборка модели, поэтому «Исходник» тогда сохраняем как GLB.
  const fmt: Fmt = fmtIn === 'original' && opt !== 'off' ? 'glb' : fmtIn;
  if (fmt === 'original') {
    const r = await window.holo.capturedSave(partition, item.id);
    if (!r.ok || !r.path) throw new Error(r.error || 'Не удалось скачать модель');
    return { path: r.path, files: r.files ?? 1 };
  }
  const src = await window.holo.capturedFetch(partition, item.id);
  if (!src.ok || !src.data) throw new Error(src.error || 'Не удалось получить модель');
  const { loadModel, exportModel, optimizeModel, OPT_LEVELS } = await import('../three3d');
  const buf = src.data.buffer.slice(src.data.byteOffset, src.data.byteOffset + src.data.byteLength) as ArrayBuffer;
  const loaded = await loadModel(buf, item.name).catch((e) => {
    throw new Error(`Не удалось открыть ${item.name}: ${e.message}. Попробуйте «Исходник».`);
  });
  const target = OPT_LEVELS.find((o) => o.id === opt)?.target ?? Infinity;
  const { object, before, after } = await optimizeModel(loaded.object, target);
  const suffix = opt !== 'off' && after < before ? `-${opt}` : '';
  const out = await exportModel(object, loaded.animations, fmt, stem(item.name) + suffix);
  const saved = await window.holo.saveFiles(`${item.groupLabel}-${stem(item.name)}-${fmt}${suffix}`, out);
  if (!saved.ok || !saved.path) throw new Error(saved.error || 'Не удалось сохранить');
  return { path: saved.path, files: saved.files ?? out.length, tris: after < before ? [before, after] : undefined };
}

export function Capture3DPanel({ partition, onClose }: { partition: string; onClose: () => void }) {
  const items = useCaptured(partition);
  const [busy, setBusy] = useState<string | null>(null);
  const [fmt, setFmt] = useState<Fmt>(() => {
    try {
      return (localStorage.getItem(FMT_KEY) as Fmt) || 'original';
    } catch {
      return 'original';
    }
  });

  const [opt, setOpt] = useState<OptLevel>(() => {
    try {
      return (localStorage.getItem(OPT_KEY) as OptLevel) || 'off';
    } catch {
      return 'off';
    }
  });
  const pickOpt = (o: OptLevel) => {
    setOpt(o);
    try {
      localStorage.setItem(OPT_KEY, o);
    } catch {
      /* не критично */
    }
  };

  const pickFmt = (f: Fmt) => {
    setFmt(f);
    try {
      localStorage.setItem(FMT_KEY, f);
    } catch {
      /* не критично */
    }
  };

  const groups = useMemo(() => {
    const map = new Map<string, { label: string; models: Captured3D[]; textures: Captured3D[]; at: number }>();
    for (const it of items) {
      if (it.kind === 'locked') continue;
      const g = map.get(it.group) ?? { label: it.groupLabel, models: [], textures: [], at: 0 };
      (it.kind === 'model' ? g.models : g.textures).push(it);
      g.at = Math.max(g.at, it.at);
      map.set(it.group, g);
    }
    return [...map.values()].filter((g) => g.models.length).sort((a, b) => b.at - a.at);
  }, [items]);
  const looseTextures = items.filter((i) => i.kind === 'texture').length;
  const locked = items.filter((i) => i.kind === 'locked');

  const save = async (item: Captured3D, toLibrary: boolean) => {
    setBusy(item.id + toLibrary);
    try {
      const r = await downloadAs(partition, item, fmt, opt);
      const tri = r.tris ? ` · треугольников ${r.tris[0].toLocaleString('ru-RU')} → ${r.tris[1].toLocaleString('ru-RU')}` : '';
      toast(`Сохранено в «Загрузки/Holo/3D» — файлов: ${r.files}${tri}`, 'info');
      if (!toLibrary) return;
      const mainName = r.path.split(/[\\/]/).pop()!;
      const form = await askLibrary({
        fileName: mainName,
        title: 'Добавить модель в библиотеку',
        message:
          fmt === 'obj'
            ? 'В библиотеку попадёт .obj; .mtl и текстуры лежат рядом в папке на диске. Для одного файла с текстурами выберите GLB.'
            : 'Модель увидит напарник и сможет покрутить её в 3D прямо в библиотеке.',
        confirmText: 'Добавить',
      });
      if (form) await uploadOne(null, { localPath: r.path, name: mainName, scope: 'library', ...form });
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className={styles.panel}>
      <div className={styles.head}>
        <div>
          <div className={styles.title}>
            <Box size={16} /> 3D-модели
          </div>
          <div className={styles.sub}>Откройте или скачайте модель на странице — она появится здесь</div>
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

      <div className={styles.formats}>
        <div className={styles.formatsLabel}>Формат скачивания</div>
        <div className={styles.formatChips}>
          {FMT_OPTIONS.map((o) => (
            <button key={o.id} className={cx(styles.fmt, fmt === o.id && styles.fmtOn)} title={o.hint} onClick={() => pickFmt(o.id)}>
              {o.label}
            </button>
          ))}
        </div>
        <div className={styles.fmtHint}>{FMT_OPTIONS.find((o) => o.id === fmt)?.hint}</div>
        <div className={styles.formatsLabel} style={{ marginTop: 10 }}>
          Оптимизация (меньше треугольников)
        </div>
        <div className={styles.formatChips}>
          {OPT_OPTIONS.map((o) => (
            <button key={o.id} className={cx(styles.fmt, opt === o.id && styles.fmtOn)} title={o.hint} onClick={() => pickOpt(o.id)}>
              {o.label}
            </button>
          ))}
        </div>
        <div className={styles.fmtHint}>
          {OPT_OPTIONS.find((o) => o.id === opt)?.hint}
          {opt !== 'off' && fmt === 'original' ? ' · сохранится как GLB' : ''}
        </div>
      </div>

      {locked.length > 0 && (
        <div className={styles.locked}>
          <Lock size={15} />
          <div>
            <b>Модель в просмотре зашифрована Meshy</b>
            <div>
              Сайт отдаёт её в своём закрытом формате (.meshy). Нажмите «Скачать» на странице модели — файл появится
              здесь, и его можно будет сконвертировать и оптимизировать.
            </div>
          </div>
        </div>
      )}

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
                <button className="btn sm icon" title={`Скачать (${FMT_OPTIONS.find((o) => o.id === fmt)?.label})`} disabled={!!busy} onClick={() => save(m, false)}>
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
              Нажмите «Скачать» на странице модели (GLB, FBX, OBJ) — файл появится здесь. Модели, которые сайт
              загружает открыто, Holo ловит и без скачивания
              {looseTextures ? ` · текстур без модели: ${looseTextures}` : ''}.
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
