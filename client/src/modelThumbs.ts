import { fileContentPath } from './api';
import type { HoloFile } from './types';

/*
 * Превью 3D-моделей для библиотеки.
 * Картинка рендерится один раз на версию файла: модель без сетки, на прозрачном фоне, тот же ракурс,
 * что в просмотре 3D. Готовое превью уходит на сервер — дальше его сразу видит и напарник.
 * Модели рендерятся строго по очереди: тяжёлые FBX/GLB параллельно грузить незачем.
 */

const SIZE = 640;
const queue: HoloFile[] = [];
const started = new Set<string>(); // id:version — уже делаем или сделали в этой сессии
let running = false;
let renderer: import('three').WebGLRenderer | null = null;

const key = (f: HoloFile) => `${f.id}:${f.version}`;
export const thumbPath = (f: HoloFile) => `/api/files/${f.id}/thumb?v=${f.thumbVersion}`;

/** Поставить модель в очередь на превью (повторные вызовы игнорируются). */
export function ensureModelThumb(file: HoloFile) {
  if (file.thumbVersion === file.version || started.has(key(file))) return;
  started.add(key(file));
  queue.push(file);
  void pump();
}

async function pump() {
  if (running) return;
  running = true;
  try {
    while (queue.length) {
      const file = queue.shift()!;
      try {
        const r = await window.holo.fetchBinary(fileContentPath(file));
        if (!r.ok || !r.data) throw new Error(r.error || 'нет данных');
        const image = await renderModelThumb(r.data, file.name);
        const res = await window.holo.uploadThumb(file.id, file.version, image, 'image/webp');
        if (!res.ok) throw new Error(res.error);
        // Сервер разошлёт file.thumb, но своё превью показываем сразу.
        const { upsertFile } = await import('./store');
        if (res.data?.file) upsertFile(res.data.file);
      } catch (e) {
        console.warn('[thumb]', file.name, (e as Error).message);
      }
      // Даём интерфейсу передохнуть между тяжёлыми моделями.
      await new Promise((r) => setTimeout(r, 150));
    }
  } finally {
    running = false;
  }
}

/** Дождаться картинок всех текстур модели (не дольше 10 секунд). */
async function waitForTextures(object: import('three').Object3D, timeoutMs = 10_000) {
  const textures: import('three').Texture[] = [];
  object.traverse((o) => {
    const m = o as import('three').Mesh;
    if (!m.isMesh) return;
    for (const mat of (Array.isArray(m.material) ? m.material : [m.material]) as unknown as Record<string, unknown>[]) {
      for (const v of Object.values(mat)) if (v && (v as import('three').Texture).isTexture) textures.push(v as import('three').Texture);
    }
  });
  const ready = (t: import('three').Texture) => {
    const img = t.image as { width?: number; complete?: boolean; data?: unknown } | undefined;
    if (!img) return false;
    if ('complete' in img && img.complete === false) return false;
    return !!(img.width || img.data);
  };
  const until = Date.now() + timeoutMs;
  while (textures.some((t) => !ready(t)) && Date.now() < until) await new Promise((r) => setTimeout(r, 100));
  for (const t of textures) if (ready(t)) t.needsUpdate = true;
}

/** Отрендерить модель в WEBP с прозрачным фоном. */
export async function renderModelThumb(bytes: Uint8Array, name: string): Promise<Uint8Array> {
  const [THREE, { RoomEnvironment }, m3d] = await Promise.all([
    import('three'),
    import('three/examples/jsm/environments/RoomEnvironment.js'),
    import('./three3d'),
  ]);
  const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const { object } = await m3d.loadModel(buf, name);
  // FBX/OBJ подгружают текстуры уже после геометрии — без ожидания превью выйдет чёрным.
  await waitForTextures(object);

  renderer ??= new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(1);
  renderer.setSize(SIZE, SIZE, false);
  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;

  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  const env = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environment = env;
  const hemi = new THREE.HemisphereLight(0xffffff, 0x222233, 1.2);
  const dir = new THREE.DirectionalLight(0xffffff, 1.6);
  dir.position.set(3, 5, 4);
  scene.add(hemi, dir);

  // Центрируем и ставим камеру так, чтобы модель целиком влезла в кадр (без сетки).
  const box = new THREE.Box3().setFromObject(object);
  const center = box.getCenter(new THREE.Vector3());
  const sphere = box.getBoundingSphere(new THREE.Sphere());
  const radius = sphere.radius || 1;
  object.position.sub(center);
  scene.add(object);
  const camera = new THREE.PerspectiveCamera(35, 1, radius / 100, radius * 100);
  const dirVec = new THREE.Vector3(0.7, 0.45, 0.9).normalize();
  const dist = radius / Math.sin(THREE.MathUtils.degToRad(35 / 2)) * 1.05;
  camera.position.copy(dirVec.multiplyScalar(dist));
  camera.lookAt(0, 0, 0);

  renderer.render(scene, camera);
  const blob = await new Promise<Blob | null>((r) => renderer!.domElement.toBlob(r, 'image/webp', 0.9));

  // Освобождаем память видеокарты: превью может быть много.
  object.traverse((o) => {
    const m = o as import('three').Mesh;
    if (!m.isMesh) return;
    m.geometry?.dispose();
    for (const mat of (Array.isArray(m.material) ? m.material : [m.material]) as import('three').MeshStandardMaterial[]) {
      for (const t of [mat.map, mat.normalMap, mat.roughnessMap, mat.metalnessMap, mat.emissiveMap, mat.aoMap, mat.alphaMap]) t?.dispose();
      mat.dispose();
    }
  });
  env.dispose();
  pmrem.dispose();
  if (!blob) throw new Error('не удалось сохранить картинку');
  return new Uint8Array(await blob.arrayBuffer());
}
