import { Camera, Download, Loader2, Pause, Play, RotateCw, Sun } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type * as THREEns from 'three';
import { fileContentPath } from '../api';
import { askLibrary, toast } from '../store';
import { uploadOne } from '../upload';
import type { HoloFile } from '../types';
import { cx } from '../util';
import styles from './ModelViewer.module.css';

type Fmt = 'glb' | 'gltf' | 'fbx' | 'obj' | 'stl' | 'usdz';
const FORMATS: { id: Fmt; label: string }[] = [
  { id: 'glb', label: 'GLB' },
  { id: 'gltf', label: 'glTF' },
  { id: 'fbx', label: 'FBX' },
  { id: 'obj', label: 'OBJ+MTL' },
  { id: 'stl', label: 'STL' },
  { id: 'usdz', label: 'USDZ' },
];

/** 3D-просмотр модели из библиотеки: вращение, масштаб, свет, анимации, экспорт в другой формат. */
export function ModelViewer({ file }: { file: HoloFile }) {
  const host = useRef<HTMLDivElement>(null);
  const loaded = useRef<{ object: THREEns.Object3D; animations: THREEns.AnimationClip[] } | null>(null);
  const controlsRef = useRef<{ autoRotate: boolean } | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState('');
  const [stats, setStats] = useState<{ meshes: number; triangles: number; textures: number } | null>(null);
  const [spin, setSpin] = useState(true);
  const [bright, setBright] = useState(1);
  const lights = useRef<THREEns.Light[]>([]);
  const [exporting, setExporting] = useState<Fmt | 'snap' | null>(null);
  const snapRef = useRef<(() => Promise<Uint8Array>) | null>(null);

  const snapshot = async () => {
    if (!snapRef.current) return;
    setExporting('snap');
    try {
      const png = await snapRef.current();
      const stem = (file.title || file.name.replace(/\.[^.]+$/, '')).replace(/[^\p{L}\p{N}._-]+/gu, '_');
      const name = `${stem}-снимок.png`;
      const r = await window.holo.saveFiles(`${stem}-снимки`, [{ name, data: png }]);
      if (!r.ok || !r.path) throw new Error(r.error || 'Не удалось сохранить снимок');
      toast('Снимок сохранён в «Загрузки/Holo/3D»', 'info');
      const form = await askLibrary({
        fileName: name,
        title: 'Снимок модели — в библиотеку?',
        message: 'PNG с прозрачным фоном: удобно для документов, чата и девлогов.',
        confirmText: 'Добавить',
      });
      if (form) await uploadOne(null, { localPath: r.path, name, scope: 'library', ...form });
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setExporting(null);
    }
  };

  useEffect(() => {
    let disposed = false;
    let raf = 0;
    let cleanup = () => {};
    (async () => {
      try {
        const [THREE, { OrbitControls }, { RoomEnvironment }, m3d] = await Promise.all([
          import('three'),
          import('three/examples/jsm/controls/OrbitControls.js'),
          import('three/examples/jsm/environments/RoomEnvironment.js'),
          import('../three3d'),
        ]);
        const r = await window.holo.fetchBinary(fileContentPath(file));
        if (!r.ok || !r.data) throw new Error(r.error || 'Не удалось загрузить модель');
        const buf = r.data.buffer.slice(r.data.byteOffset, r.data.byteOffset + r.data.byteLength) as ArrayBuffer;
        const model = await m3d.loadModel(buf, file.name);
        if (disposed) return;
        loaded.current = model;
        setStats(m3d.modelStats(model.object));

        const el = host.current!;
        const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
        renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
        renderer.setSize(el.clientWidth, el.clientHeight);
        renderer.outputColorSpace = THREE.SRGBColorSpace;
        renderer.toneMapping = THREE.ACESFilmicToneMapping;
        el.appendChild(renderer.domElement);

        const scene = new THREE.Scene();
        const pmrem = new THREE.PMREMGenerator(renderer);
        scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
        const hemi = new THREE.HemisphereLight(0xffffff, 0x222233, 1.2);
        const dir = new THREE.DirectionalLight(0xffffff, 1.6);
        dir.position.set(3, 5, 4);
        scene.add(hemi, dir);
        lights.current = [hemi, dir];

        // Центрируем и подгоняем камеру под размер модели.
        const obj = model.object;
        const box = new THREE.Box3().setFromObject(obj);
        const size = box.getSize(new THREE.Vector3()).length() || 1;
        const center = box.getCenter(new THREE.Vector3());
        obj.position.sub(center);
        scene.add(obj);
        const grid = new THREE.GridHelper(size * 1.2, 20, 0x3a3a55, 0x1f1f2e);
        grid.position.y = -box.getSize(new THREE.Vector3()).y / 2;
        scene.add(grid);

        const camera = new THREE.PerspectiveCamera(40, el.clientWidth / el.clientHeight, size / 100, size * 100);
        camera.position.set(size * 0.7, size * 0.45, size * 0.9);
        const controls = new OrbitControls(camera, renderer.domElement);
        controls.enableDamping = true;
        controls.autoRotate = true;
        controls.autoRotateSpeed = 1.2;
        controlsRef.current = controls;

        const mixer = model.animations.length ? new THREE.AnimationMixer(obj) : null;
        if (mixer) mixer.clipAction(model.animations[0]).play();
        const clock = new THREE.Clock();

        const ro = new ResizeObserver(() => {
          renderer.setSize(el.clientWidth, el.clientHeight);
          camera.aspect = el.clientWidth / el.clientHeight;
          camera.updateProjectionMatrix();
        });
        ro.observe(el);

        const loop = () => {
          raf = requestAnimationFrame(loop);
          mixer?.update(clock.getDelta());
          controls.update();
          renderer.render(scene, camera);
        };
        // Снимок: тот же ракурс, ~2048 px по ширине, без сетки, прозрачный фон.
        snapRef.current = async () => {
          const ratio = renderer.getPixelRatio();
          renderer.setPixelRatio(Math.max(ratio, 2048 / Math.max(1, el.clientWidth)));
          renderer.setSize(el.clientWidth, el.clientHeight, false);
          grid.visible = false;
          renderer.render(scene, camera);
          const blob = await new Promise<Blob | null>((res) => renderer.domElement.toBlob(res, 'image/png'));
          grid.visible = true;
          renderer.setPixelRatio(ratio);
          renderer.setSize(el.clientWidth, el.clientHeight, false);
          if (!blob) throw new Error('Не удалось сделать снимок');
          return new Uint8Array(await blob.arrayBuffer());
        };
        loop();
        setState('ready');
        cleanup = () => {
          ro.disconnect();
          controls.dispose();
          renderer.dispose();
          pmrem.dispose();
          renderer.domElement.remove();
        };
      } catch (e) {
        if (!disposed) {
          setError((e as Error).message);
          setState('error');
        }
      }
    })();
    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      cleanup();
    };
  }, [file.id, file.version, file.name]);

  useEffect(() => {
    if (controlsRef.current) controlsRef.current.autoRotate = spin;
  }, [spin]);

  useEffect(() => {
    const [hemi, dir] = lights.current;
    if (hemi) hemi.intensity = 1.2 * bright;
    if (dir) dir.intensity = 1.6 * bright;
  }, [bright]);

  const exportAs = async (fmt: Fmt) => {
    if (!loaded.current) return;
    setExporting(fmt);
    try {
      const { exportModel } = await import('../three3d');
      const stem = file.name.replace(/\.[^.]+$/, '');
      const out = await exportModel(loaded.current.object, loaded.current.animations, fmt, stem);
      const r = await window.holo.saveFiles(`${file.title || stem}-${fmt}`, out);
      if (!r.ok) throw new Error(r.error);
      toast(`Сохранено в «Загрузки/Holo/3D» — файлов: ${r.files}`, 'info');
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setExporting(null);
    }
  };

  return (
    <div className={styles.wrap} onClick={(e) => e.stopPropagation()}>
      <div ref={host} className={styles.canvas} />
      {state === 'loading' && (
        <div className={styles.center}>
          <Loader2 className="spin" /> Загружаем модель…
        </div>
      )}
      {state === 'error' && <div className={styles.center}>{error}</div>}
      {state === 'ready' && (
        <>
          <div className={styles.toolbar}>
            <button className={cx(styles.tb, spin && styles.tbOn)} onClick={() => setSpin((s) => !s)} title="Автовращение">
              {spin ? <Pause size={15} /> : <Play size={15} />}
            </button>
            <button className={styles.tb} onClick={() => setBright((b) => (b >= 2 ? 0.5 : b + 0.5))} title="Яркость света">
              <Sun size={15} /> {bright}×
            </button>
            <button className={styles.tb} onClick={snapshot} disabled={!!exporting} title="Снимок модели в PNG (прозрачный фон)">
              {exporting === 'snap' ? <Loader2 size={15} className="spin" /> : <Camera size={15} />} Снимок
            </button>
            <span className={styles.tip}>
              <RotateCw size={13} /> мышь — вращать, колесо — масштаб, ПКМ — сдвиг
            </span>
          </div>
          <div className={styles.export}>
            <span>
              <Download size={13} /> Скачать как
            </span>
            {FORMATS.map((f) => (
              <button key={f.id} className={styles.fmt} disabled={!!exporting} onClick={() => exportAs(f.id)}>
                {exporting === f.id ? <Loader2 size={12} className="spin" /> : f.label}
              </button>
            ))}
          </div>
          {stats && (
            <div className={styles.stats}>
              {stats.meshes} мешей · {stats.triangles.toLocaleString('ru-RU')} треуг. · {stats.textures} текстур
              {loaded.current?.animations.length ? ` · анимаций: ${loaded.current.animations.length}` : ''}
            </div>
          )}
        </>
      )}
    </div>
  );
}
