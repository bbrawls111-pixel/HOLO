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
