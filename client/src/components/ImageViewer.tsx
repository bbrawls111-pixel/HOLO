import { ChevronLeft, ChevronRight, Download, Maximize, RotateCw, X, ZoomIn, ZoomOut } from 'lucide-react';
import { useEffect, useRef, useState, type CSSProperties, type WheelEvent as ReactWheelEvent } from 'react';
import { create } from 'zustand';
import { fileContentPath, useBinaryUrl } from '../api';
import type { HoloFile } from '../types';
import { cx, formatBytes } from '../util';
import styles from './ImageViewer.module.css';

const useViewer = create<{ files: HoloFile[]; index: number; open: boolean }>(() => ({ files: [], index: 0, open: false }));

/** Открыть просмотр картинок (список и номер текущей). */
export function openImageViewer(files: HoloFile[], index = 0) {
  if (!files.length) return;
  useViewer.setState({ files, index, open: true });
}

const MIN = 0.1;
const MAX = 12;

export function ImageViewer() {
  const { files, index, open } = useViewer();
  const file = files[index];
  const url = useBinaryUrl(open && file ? fileContentPath(file) : null);
  const [view, setView] = useState({ scale: 1, x: 0, y: 0, rot: 0 });
  const [fit, setFit] = useState(1);
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const stage = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; vx: number; vy: number } | null>(null);

  const close = () => useViewer.setState({ open: false });
  const go = (d: number) => useViewer.setState((s) => ({ index: (s.index + d + s.files.length) % s.files.length }));

  // Вписать картинку в экран.
  const computeFit = (n = natural, rot = view.rot) => {
    const el = stage.current;
    if (!el || !n) return 1;
    const rotated = rot % 180 !== 0;
    const w = rotated ? n.h : n.w;
    const h = rotated ? n.w : n.h;
    return Math.min(1, (el.clientWidth - 80) / w, (el.clientHeight - 140) / h);
  };

  useEffect(() => {
    setNatural(null);
    setView({ scale: 1, x: 0, y: 0, rot: 0 });
  }, [file?.id]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
      if (e.key === 'ArrowRight') go(1);
      if (e.key === 'ArrowLeft') go(-1);
      if (e.key === '+' || e.key === '=') zoomBy(1.25);
      if (e.key === '-') zoomBy(0.8);
      if (e.key === '0') reset();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  if (!open || !file) return null;

  const reset = () => {
    const f = computeFit();
    setFit(f);
    setView((v) => ({ ...v, scale: f, x: 0, y: 0 }));
  };

  const zoomBy = (k: number, cx = 0, cy = 0) =>
    setView((v) => {
      const scale = Math.min(MAX, Math.max(MIN, v.scale * k));
      const r = scale / v.scale;
      // Масштаб относительно курсора: точка под курсором остаётся на месте.
      return { ...v, scale, x: cx - (cx - v.x) * r, y: cy - (cy - v.y) * r };
    });

  const onWheel = (e: ReactWheelEvent) => {
    const r = stage.current!.getBoundingClientRect();
    zoomBy(e.deltaY < 0 ? 1.15 : 1 / 1.15, e.clientX - r.left - r.width / 2, e.clientY - r.top - r.height / 2);
  };

  return (
    <div className={styles.backdrop}>
      <div className={styles.top}>
        <div className={styles.name}>
          <strong>{file.title || file.name}</strong>
          <span>
            {natural ? `${natural.w}×${natural.h} · ` : ''}
            {formatBytes(file.size)}
            {files.length > 1 ? ` · ${index + 1} из ${files.length}` : ''}
          </span>
        </div>
        <div className={styles.tools}>
          <button onClick={() => zoomBy(0.8)} title="Уменьшить (−)">
            <ZoomOut size={18} />
          </button>
          <span className={styles.zoom}>{Math.round(view.scale * 100)}%</span>
          <button onClick={() => zoomBy(1.25)} title="Увеличить (+)">
            <ZoomIn size={18} />
          </button>
          <button onClick={reset} title="Вписать (0)">
            <Maximize size={17} />
          </button>
          <button
            onClick={() => {
              const rot = (view.rot + 90) % 360;
              const f = computeFit(natural, rot);
              setFit(f);
              setView({ scale: f, x: 0, y: 0, rot });
            }}
            title="Повернуть"
          >
            <RotateCw size={17} />
          </button>
          <button onClick={() => window.holo.download(file.id, file.name)} title="Скачать">
            <Download size={17} />
          </button>
          <button onClick={close} title="Закрыть (Esc)">
            <X size={20} />
          </button>
        </div>
      </div>

      <div
        ref={stage}
        className={styles.stage}
        onWheel={onWheel}
        onMouseDown={(e) => {
          if (e.button !== 0) return;
          drag.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y };
        }}
        onMouseMove={(e) => {
          const d = drag.current;
          if (d) setView((v) => ({ ...v, x: d.vx + e.clientX - d.x, y: d.vy + e.clientY - d.y }));
        }}
        onMouseUp={() => (drag.current = null)}
        onMouseLeave={() => (drag.current = null)}
        onDoubleClick={(e) => {
          const r = stage.current!.getBoundingClientRect();
          if (Math.abs(view.scale - fit) < 0.01) {
            const k = 1 / view.scale;
            zoomBy(Math.max(k, 2), e.clientX - r.left - r.width / 2, e.clientY - r.top - r.height / 2);
          } else reset();
        }}
        onClick={(e) => e.target === stage.current && !drag.current && Math.abs(view.scale - fit) < 0.01 && close()}
      >
        {url && (
          <img
            src={url}
            alt=""
            draggable={false}
            className={styles.img}
            style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale}) rotate(${view.rot}deg)` } as CSSProperties}
            onLoad={(e) => {
              const n = { w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight };
              setNatural(n);
              const f = computeFit(n, 0);
              setFit(f);
              setView({ scale: f, x: 0, y: 0, rot: 0 });
            }}
          />
        )}
        {files.length > 1 && (
          <>
            <button className={cx(styles.nav, styles.prev)} onClick={() => go(-1)}>
              <ChevronLeft size={28} />
            </button>
            <button className={cx(styles.nav, styles.next)} onClick={() => go(1)}>
              <ChevronRight size={28} />
            </button>
          </>
        )}
      </div>

      {files.length > 1 && (
        <div className={styles.strip}>
          {files.map((f, i) => (
            <Thumb key={f.id} file={f} active={i === index} onClick={() => useViewer.setState({ index: i })} />
          ))}
        </div>
      )}
    </div>
  );
}

function Thumb({ file, active, onClick }: { file: HoloFile; active: boolean; onClick: () => void }) {
  const url = useBinaryUrl(fileContentPath(file));
  return (
    <button className={cx(styles.thumb, active && styles.thumbOn)} onClick={onClick}>
      {url && <img src={url} alt="" draggable={false} />}
    </button>
  );
}

