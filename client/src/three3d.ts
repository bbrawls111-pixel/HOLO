import * as THREE from 'three';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { STLExporter } from 'three/examples/jsm/exporters/STLExporter.js';
import { USDZExporter } from 'three/examples/jsm/exporters/USDZExporter.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';

/*
 * 3D-модели: загрузка (GLB/GLTF/FBX/OBJ/STL) и сохранение в выбранный формат.
 * Конвертация идёт локально, в окне Holo; текстуры берутся из самой модели целиком.
 */

export type ModelFormat = 'glb' | 'gltf' | 'fbx' | 'obj' | 'stl' | 'usdz';

export const FORMATS: { id: ModelFormat; label: string; hint: string }[] = [
  { id: 'glb', label: 'GLB', hint: 'Один файл, текстуры внутри — для Unity, Unreal, Godot, Blender' },
  { id: 'gltf', label: 'glTF', hint: 'JSON-версия glTF, текстуры встроены' },
  { id: 'fbx', label: 'FBX', hint: 'FBX 7.4, текстуры встроены в файл — для Mixamo, Unity, Unreal, Blender, 3ds Max' },
  { id: 'obj', label: 'OBJ + MTL', hint: 'Геометрия + материал + текстуры отдельными PNG' },
  { id: 'stl', label: 'STL', hint: 'Только геометрия — для 3D-печати' },
  { id: 'usdz', label: 'USDZ', hint: 'Для Apple / AR Quick Look' },
];

export interface OutFile {
  name: string;
  data: Uint8Array;
}

const base = () => new URL('./', document.baseURI).toString();
let renderer: THREE.WebGLRenderer | null = null;
function sharedRenderer() {
  renderer ??= new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
  return renderer;
}

export function makeGltfLoader() {
  const loader = new GLTFLoader();
  const draco = new DRACOLoader();
  draco.setDecoderPath(base() + 'draco/');
  loader.setDRACOLoader(draco);
  const ktx2 = new KTX2Loader();
  ktx2.setTranscoderPath(base() + 'basis/');
  ktx2.detectSupport(sharedRenderer());
  loader.setKTX2Loader(ktx2);
  loader.setMeshoptDecoder(MeshoptDecoder);
  return loader;
}

export const extOf = (name: string) => (name.split('.').pop() || '').toLowerCase();

/** Загрузить модель из байтов. */
export async function loadModel(data: ArrayBuffer, name: string): Promise<{ object: THREE.Object3D; animations: THREE.AnimationClip[] }> {
  const ext = extOf(name);
  if (ext === 'glb' || ext === 'gltf') {
    const gltf = await makeGltfLoader().parseAsync(data, '');
    gltf.scene.userData.gltf = true;
    return { object: gltf.scene, animations: gltf.animations };
  }
  if (ext === 'fbx') {
    const obj = new FBXLoader().parse(data, '');
    return { object: obj, animations: obj.animations ?? [] };
  }
  if (ext === 'obj') {
    return { object: new OBJLoader().parse(new TextDecoder().decode(data)), animations: [] };
  }
  if (ext === 'stl') {
    const geo = new STLLoader().parse(data);
    geo.computeVertexNormals();
    return { object: new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0xb8b8c8, roughness: 0.6 })), animations: [] };
  }
  throw new Error(`Формат .${ext} пока не открывается`);
}

// ------------------------------------------------------------------ текстуры → PNG
async function textureToPng(tex: THREE.Texture): Promise<Uint8Array | null> {
  const img = tex.image as (CanvasImageSource & { width: number; height: number }) | undefined;
  if (!img || !img.width || (tex as THREE.CompressedTexture).isCompressedTexture) return null;
  const canvas = document.createElement('canvas');
  canvas.width = img.width;
  canvas.height = img.height;
  // Картинку сохраняем как есть; ориентацию учитываем в UV (см. exportObj).
  canvas.getContext('2d')!.drawImage(img, 0, 0);
  const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/png'));
  return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
}

const safe = (s: string) => s.replace(/[^\w.-]+/g, '_').slice(0, 60) || 'mat';

/** OBJ + MTL + текстуры (map_Kd, нормали, шероховатость, металличность, свечение, AO, альфа). */
async function exportObj(root: THREE.Object3D, baseName: string): Promise<OutFile[]> {
  root.updateMatrixWorld(true);
  const lines: string[] = [`# Holo export`, `mtllib ${baseName}.mtl`];
  const mtl: string[] = ['# Holo export'];
  const files: OutFile[] = [];
  const texNames = new Map<THREE.Texture, string>();
  const matNames = new Map<THREE.Material, string>();
  let vOff = 1;
  let vtOff = 1;
  let vnOff = 1;
  const v = new THREE.Vector3();
  const n = new THREE.Vector3();
  const nm = new THREE.Matrix3();

  const texFile = async (tex: THREE.Texture | null | undefined, kind: string) => {
    if (!tex) return null;
    if (texNames.has(tex)) return texNames.get(tex)!;
    const png = await textureToPng(tex);
    if (!png) return null;
    const name = `textures/${safe(baseName)}_${kind}_${texNames.size}.png`;
    texNames.set(tex, name);
    files.push({ name, data: png });
    return name;
  };

  const meshes: THREE.Mesh[] = [];
  root.traverse((o) => (o as THREE.Mesh).isMesh && meshes.push(o as THREE.Mesh));

  for (const mesh of meshes) {
    const geo = mesh.geometry.index ? mesh.geometry.toNonIndexed() : mesh.geometry;
    const pos = geo.getAttribute('position');
    const uv = geo.getAttribute('uv');
    const nor = geo.getAttribute('normal');
    if (!pos) continue;
    nm.getNormalMatrix(mesh.matrixWorld);
    lines.push(`o ${safe(mesh.name || 'mesh')}`);
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
      lines.push(`v ${v.x.toFixed(6)} ${v.y.toFixed(6)} ${v.z.toFixed(6)}`);
    }
    // UV в glTF идут сверху вниз (текстуры с flipY = false), в OBJ — снизу вверх.
    const meshMats = (Array.isArray(mesh.material) ? mesh.material : [mesh.material]) as THREE.MeshStandardMaterial[];
    const gltfUv = meshMats.some((m) => m?.map && m.map.flipY === false) || (!meshMats.some((m) => m?.map) && root.userData.gltf === true);
    if (uv) for (let i = 0; i < uv.count; i++) lines.push(`vt ${uv.getX(i).toFixed(6)} ${(gltfUv ? 1 - uv.getY(i) : uv.getY(i)).toFixed(6)}`);
    if (nor)
      for (let i = 0; i < nor.count; i++) {
        n.fromBufferAttribute(nor, i).applyMatrix3(nm).normalize();
        lines.push(`vn ${n.x.toFixed(5)} ${n.y.toFixed(5)} ${n.z.toFixed(5)}`);
      }

    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const groups = geo.groups.length ? geo.groups : [{ start: 0, count: pos.count, materialIndex: 0 }];
    for (const g of groups) {
      const mat = mats[g.materialIndex ?? 0] as THREE.MeshStandardMaterial;
      if (mat && !matNames.has(mat)) {
        const name = safe(mat.name || `material_${matNames.size}`) + (matNames.size ? `_${matNames.size}` : '');
        matNames.set(mat, name);
        const c = mat.color ?? new THREE.Color(1, 1, 1);
        mtl.push('', `newmtl ${name}`, `Kd ${c.r.toFixed(4)} ${c.g.toFixed(4)} ${c.b.toFixed(4)}`, 'Ka 0 0 0', 'Ks 0.2 0.2 0.2');
        if (mat.opacity !== undefined && mat.opacity < 1) mtl.push(`d ${mat.opacity.toFixed(3)}`);
        if (mat.roughness !== undefined) mtl.push(`Pr ${mat.roughness.toFixed(3)}`);
        if (mat.metalness !== undefined) mtl.push(`Pm ${mat.metalness.toFixed(3)}`);
        const kd = await texFile(mat.map, 'basecolor');
        if (kd) mtl.push(`map_Kd ${kd}`);
        const nrm = await texFile(mat.normalMap, 'normal');
        if (nrm) mtl.push(`map_Bump -bm 1 ${nrm}`, `norm ${nrm}`);
        const rough = await texFile(mat.roughnessMap, 'roughness');
        if (rough) mtl.push(`map_Pr ${rough}`);
        const metal = await texFile(mat.metalnessMap, 'metallic');
        if (metal) mtl.push(`map_Pm ${metal}`);
        const em = await texFile(mat.emissiveMap, 'emissive');
        if (em) mtl.push(`map_Ke ${em}`);
        const ao = await texFile(mat.aoMap, 'ao');
        if (ao) mtl.push(`map_Ka ${ao}`);
        const alpha = await texFile(mat.alphaMap, 'alpha');
        if (alpha) mtl.push(`map_d ${alpha}`);
      }
      if (mat) lines.push(`usemtl ${matNames.get(mat)}`);
      for (let i = g.start; i < g.start + g.count; i += 3) {
        const f = [0, 1, 2].map((k) => {
          const idx = i + k;
          const a = idx + vOff;
          const t = uv ? idx + vtOff : '';
          const nn = nor ? idx + vnOff : '';
          return nor ? `${a}/${t}/${nn}` : uv ? `${a}/${t}` : `${a}`;
        });
        lines.push(`f ${f.join(' ')}`);
      }
    }
    vOff += pos.count;
    if (uv) vtOff += uv.count;
    if (nor) vnOff += nor.count;
  }

  const enc = new TextEncoder();
  return [{ name: `${baseName}.obj`, data: enc.encode(lines.join('\n')) }, { name: `${baseName}.mtl`, data: enc.encode(mtl.join('\n')) }, ...files];
}

/** Сохранить модель в выбранном формате. Первый файл — основной. */
export async function exportModel(
  object: THREE.Object3D,
  animations: THREE.AnimationClip[],
  format: ModelFormat,
  baseName: string,
): Promise<OutFile[]> {
  if (format === 'glb' || format === 'gltf') {
    const res = await new GLTFExporter().parseAsync(object, { binary: format === 'glb', animations, embedImages: true, onlyVisible: true });
    const data = res instanceof ArrayBuffer ? new Uint8Array(res) : new TextEncoder().encode(JSON.stringify(res));
    return [{ name: `${baseName}.${format}`, data }];
  }
  if (format === 'stl') {
    const res = new STLExporter().parse(object, { binary: true }) as unknown as DataView;
    return [{ name: `${baseName}.stl`, data: new Uint8Array(res.buffer) }];
  }
  if (format === 'usdz') {
    const res = await new USDZExporter().parseAsync(object);
    return [{ name: `${baseName}.usdz`, data: res }];
  }
  if (format === 'fbx') {
    const { exportFbx } = await import('./fbxExport');
    const pngs: OutFile[] = [];
    const data = await exportFbx(object, baseName, {
      texture: async (tex, kind) => {
        const png = await textureToPng(tex);
        if (!png) return null;
        const file = `textures/${safe(baseName)}_${kind}_${pngs.length}.png`;
        pngs.push({ name: file, data: png });
        return { file, png };
      },
    });
    // Текстуры уже внутри FBX; копии рядом — для программ, которые берут их из папки.
    return [{ name: `${baseName}.fbx`, data }, ...pngs];
  }
  return exportObj(object, baseName);
}

// ------------------------------------------------------------------ оптимизация (меньше треугольников)
export type OptLevel = 'off' | 'auto' | '100k' | '20k' | '5k';
export const OPT_LEVELS: { id: OptLevel; label: string; hint: string; target: number }[] = [
  { id: 'off', label: 'Без', hint: 'Сетка как есть', target: Infinity },
  { id: 'auto', label: 'Авто', hint: 'До 50 000 треугольников — обычный игровой ассет', target: 50_000 },
  { id: '100k', label: '100k', hint: 'До 100 000 — герой / крупный план', target: 100_000 },
  { id: '20k', label: '20k', hint: 'До 20 000 — второстепенные объекты', target: 20_000 },
  { id: '5k', label: '5k', hint: 'До 5 000 — мобильные игры, дальние LOD', target: 5_000 },
];

/** Убрать вершины, которые больше не используются ни одним треугольником. */
function compactGeometry(geo: THREE.BufferGeometry, index: Uint32Array) {
  const remap = new Int32Array(geo.getAttribute('position').count).fill(-1);
  let used = 0;
  for (let i = 0; i < index.length; i++) if (remap[index[i]] < 0) remap[index[i]] = used++;
  const out = new THREE.BufferGeometry();
  for (const [name, attr] of Object.entries(geo.attributes)) {
    const a = attr as THREE.BufferAttribute;
    const Ctor = (a.array as unknown as { constructor: new (n: number) => THREE.TypedArray }).constructor;
    const next = new THREE.BufferAttribute(new Ctor(used * a.itemSize), a.itemSize, a.normalized);
    for (let old = 0; old < remap.length; old++) {
      const j = remap[old];
      if (j < 0) continue;
      for (let c = 0; c < a.itemSize; c++) next.setComponent(j, c, a.getComponent(old, c));
    }
    out.setAttribute(name, next);
  }
  const newIndex = new Uint32Array(index.length);
  for (let i = 0; i < index.length; i++) newIndex[i] = remap[index[i]];
  out.setIndex(new THREE.BufferAttribute(used > 65535 ? newIndex : new Uint16Array(newIndex), 1));
  return out;
}

/**
 * Уменьшить число треугольников до бюджета. Упрощается каждая группа материала отдельно,
 * швы UV/нормалей сохраняются (meshoptimizer), вершины не двигаются — текстуры, скиннинг и
 * анимации остаются рабочими. Исходная модель не меняется — возвращается копия.
 */
export async function optimizeModel(
  root: THREE.Object3D,
  target: number,
): Promise<{ object: THREE.Object3D; before: number; after: number; limited: boolean }> {
  const before = modelStats(root).triangles;
  if (!Number.isFinite(target) || before <= target) return { object: root, before, after: before, limited: false };
  // Сначала аккуратно (форма уходит не больше чем на 1% размера модели); если до бюджета не дошли — 2%, затем 3%.
  // Дальше не идём: тонкие детали (клинки, пальцы, края) начинают рваться — лучше честно остановиться.
  for (const maxError of [0.01, 0.02, 0.03]) {
    const res = await simplifyOnce(root, target, before, maxError);
    if (res.after <= target * 1.1 || maxError === 0.03) return { ...res, before, limited: res.after > target * 1.1 };
  }
  throw new Error('unreachable');
}

async function simplifyOnce(root: THREE.Object3D, target: number, before: number, maxError: number) {
  const [{ MeshoptSimplifier }, { mergeVertices }, SkeletonUtils] = await Promise.all([
    import('meshoptimizer'),
    import('three/examples/jsm/utils/BufferGeometryUtils.js'),
    import('three/examples/jsm/utils/SkeletonUtils.js'),
  ]);
  await MeshoptSimplifier.ready;
  MeshoptSimplifier.useExperimentalFeatures = true;
  const ratio = target / before;
  // Ошибка задаётся относительно размера каждой сетки; приводим к размеру всей модели,
  // чтобы маленькие детали (гарда, рукоять) не «съедались» сильнее крупных.
  const modelSize = new THREE.Box3().setFromObject(root).getSize(new THREE.Vector3()).length() || 1;
  const object = SkeletonUtils.clone(root);
  object.userData = { ...root.userData };
  let after = 0;
  const meshes: THREE.Mesh[] = [];
  object.traverse((o) => (o as THREE.Mesh).isMesh && meshes.push(o as THREE.Mesh));

  for (const mesh of meshes) {
    let geo = mesh.geometry.clone();
    geo.morphAttributes = {};
    // Без индекса каждый треугольник «сам по себе» — сначала склеиваем одинаковые вершины.
    geo = mergeVertices(geo);
    const pos = geo.getAttribute('position');
    const positions = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) {
      positions[i * 3] = pos.getX(i);
      positions[i * 3 + 1] = pos.getY(i);
      positions[i * 3 + 2] = pos.getZ(i);
    }
    const index = Uint32Array.from(geo.index!.array as ArrayLike<number>);
    // Нормали и UV тоже учитываются: так не «ломается» освещение и не плывут текстуры.
    const nor = geo.getAttribute('normal');
    const uv = geo.getAttribute('uv');
    const stride = (nor ? 3 : 0) + (uv ? 2 : 0);
    const weights = [...(nor ? [0.5, 0.5, 0.5] : []), ...(uv ? [1, 1] : [])];
    const attrs = new Float32Array(Math.max(1, pos.count * stride));
    if (stride)
      for (let i = 0; i < pos.count; i++) {
        let o = i * stride;
        if (nor) {
          attrs[o++] = nor.getX(i);
          attrs[o++] = nor.getY(i);
          attrs[o++] = nor.getZ(i);
        }
        if (uv) {
          attrs[o++] = uv.getX(i);
          attrs[o++] = uv.getY(i);
        }
      }
    const meshSize = new THREE.Box3().setFromBufferAttribute(pos as THREE.BufferAttribute).getSize(new THREE.Vector3()).length() || 1;
    const error = Math.min(1, (maxError * modelSize) / (meshSize * Math.max(1e-6, mesh.matrixWorld.getMaxScaleOnAxis())));
    const groups = geo.groups.length ? geo.groups : [{ start: 0, count: index.length, materialIndex: 0 }];
    const parts: Uint32Array[] = [];
    const newGroups: { start: number; count: number; materialIndex: number }[] = [];
    let offset = 0;
    for (const g of groups) {
      const slice = index.slice(g.start, Math.min(index.length, g.start + g.count));
      const want = Math.max(3, Math.floor((slice.length / 3) * ratio) * 3);
      const [simplified] = stride
        ? MeshoptSimplifier.simplifyWithAttributes(slice, positions, 3, attrs, stride, weights, null, want, error)
        : MeshoptSimplifier.simplify(slice, positions, 3, want, error);
      parts.push(simplified);
      newGroups.push({ start: offset, count: simplified.length, materialIndex: g.materialIndex ?? 0 });
      offset += simplified.length;
    }
    const all = new Uint32Array(offset);
    let p = 0;
    for (const part of parts) {
      all.set(part, p);
      p += part.length;
    }
    const out = compactGeometry(geo, all);
    if (geo.groups.length) for (const g of newGroups) out.addGroup(g.start, g.count, g.materialIndex);
    out.computeBoundingBox();
    out.computeBoundingSphere();
    mesh.geometry = out;
    after += all.length / 3;
  }
  void before;
  return { object, after: Math.round(after) };
}

export function modelStats(object: THREE.Object3D) {
  let meshes = 0;
  let triangles = 0;
  const textures = new Set<THREE.Texture>();
  object.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    meshes++;
    const g = m.geometry;
    triangles += (g.index ? g.index.count : g.getAttribute('position')?.count ?? 0) / 3;
    const mats = Array.isArray(m.material) ? m.material : [m.material];
    for (const mat of mats as THREE.MeshStandardMaterial[]) {
      for (const t of [mat.map, mat.normalMap, mat.roughnessMap, mat.metalnessMap, mat.emissiveMap, mat.aoMap]) if (t) textures.add(t);
    }
  });
  return { meshes, triangles: Math.round(triangles), textures: textures.size };
}
