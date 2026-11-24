import * as THREE from 'three';

/*
 * Экспорт в бинарный FBX 7.4 (как у Autodesk FBX SDK / Blender).
 * Сетки, нормали, UV, материалы и текстуры — текстуры встраиваются прямо в файл (Video.Content),
 * поэтому FBX можно сразу закинуть в Mixamo, Unity, Unreal или Blender.
 * Положение объектов «запекается» в вершины, как в OBJ: так модель везде выглядит одинаково.
 */

type Prop =
  | ['I', number]
  | ['D', number]
  | ['L', bigint]
  | ['C', boolean]
  | ['S', string]
  | ['R', Uint8Array]
  | ['i', Int32Array]
  | ['d', Float64Array];

interface FbxNode {
  name: string;
  props: Prop[];
  children: FbxNode[];
}

const node = (name: string, props: Prop[] = [], children: FbxNode[] = []): FbxNode => ({ name, props, children });
const S = (v: string): Prop => ['S', v];
const I = (v: number): Prop => ['I', v];
const D = (v: number): Prop => ['D', v];
const L = (v: bigint): Prop => ['L', v];

/** Имя объекта в бинарном FBX: «Имя\0\1Класс». */
const objName = (name: string, cls: string) => `${name}\u0000\u0001${cls}`;

// P: "имя", "тип", "подтип", "флаги", значения…
const P = (...vals: (string | number | [number])[]) =>
  node(
    'P',
    vals.map((v, i): Prop => (typeof v === 'string' ? S(v) : Array.isArray(v) ? I(v[0]) : i >= 4 ? D(v) : S(String(v)))),
  );

// Фиксированные ID/время из Blender: их сочетание с подписью в конце файла проверяют некоторые программы.
const FILE_ID = new Uint8Array([0x28, 0xb3, 0x2a, 0xeb, 0xb6, 0x24, 0xcc, 0xc2, 0xbf, 0xc8, 0xb0, 0x2a, 0xa9, 0x2b, 0xfc, 0xf1]);
const TIME_ID = '1970-01-01 10:00:00:000';
const FOOT_ID = new Uint8Array([0xfa, 0xbc, 0xab, 0x09, 0xd0, 0xc8, 0xd4, 0x66, 0xb1, 0x76, 0xfb, 0x83, 0x1c, 0xf7, 0x26, 0x7e]);
const FOOT_MAGIC = new Uint8Array([0xf8, 0x5a, 0x8c, 0x6a, 0xde, 0xf5, 0xd9, 0x7e, 0xec, 0xe9, 0x0c, 0xe3, 0x75, 0x8f, 0x29, 0x0b]);
const VERSION = 7400;

// ------------------------------------------------------------------ двоичная запись
class Writer {
  buf = new Uint8Array(1 << 16);
  view = new DataView(this.buf.buffer);
  pos = 0;
  private enc = new TextEncoder();

  private ensure(n: number) {
    if (this.pos + n <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.pos + n) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buf.subarray(0, this.pos));
    this.buf = next;
    this.view = new DataView(next.buffer);
  }
  u8(v: number) {
    this.ensure(1);
    this.view.setUint8(this.pos, v);
    this.pos += 1;
  }
  u32(v: number) {
    this.ensure(4);
    this.view.setUint32(this.pos, v, true);
    this.pos += 4;
  }
  i32(v: number) {
    this.ensure(4);
    this.view.setInt32(this.pos, v, true);
    this.pos += 4;
  }
  f64(v: number) {
    this.ensure(8);
    this.view.setFloat64(this.pos, v, true);
    this.pos += 8;
  }
  i64(v: bigint) {
    this.ensure(8);
    this.view.setBigInt64(this.pos, v, true);
    this.pos += 8;
  }
  bytes(b: Uint8Array) {
    this.ensure(b.length);
    this.buf.set(b, this.pos);
    this.pos += b.length;
  }
  str(s: string) {
    this.bytes(this.enc.encode(s));
  }
  patchU32(at: number, v: number) {
    this.view.setUint32(at, v, true);
  }
  result() {
    return this.buf.slice(0, this.pos);
  }
}

function writeProp(w: Writer, p: Prop) {
  const [t, v] = p;
  w.u8(t.charCodeAt(0));
  switch (t) {
    case 'I':
      w.i32(v as number);
      break;
    case 'D':
      w.f64(v as number);
      break;
    case 'L':
      w.i64(v as bigint);
      break;
    case 'C':
      w.u8(v ? 1 : 0);
      break;
    case 'S': {
      const b = new TextEncoder().encode(v as string);
      w.u32(b.length);
      w.bytes(b);
      break;
    }
    case 'R':
      w.u32((v as Uint8Array).length);
      w.bytes(v as Uint8Array);
      break;
    case 'i':
    case 'd': {
      const arr = v as Int32Array | Float64Array;
      w.u32(arr.length);
      w.u32(0); // без сжатия
      w.u32(arr.byteLength);
      w.bytes(new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength));
      break;
    }
  }
}

function writeNode(w: Writer, n: FbxNode) {
  const start = w.pos;
  w.u32(0); // конец узла — допишем
  w.u32(n.props.length);
  w.u32(0); // длина свойств — допишем
  const name = new TextEncoder().encode(n.name);
  w.u8(name.length);
  w.bytes(name);
  const propsStart = w.pos;
  for (const p of n.props) writeProp(w, p);
  w.patchU32(start + 8, w.pos - propsStart);
  if (n.children.length || !n.props.length) {
    for (const c of n.children) writeNode(w, c);
    for (let i = 0; i < 13; i++) w.u8(0); // конец списка вложенных узлов
  }
  w.patchU32(start, w.pos);
}

function serialize(top: FbxNode[]): Uint8Array {
  const w = new Writer();
  w.str('Kaydara FBX Binary  ');
  w.u8(0);
  w.u8(0x1a);
  w.u8(0);
  w.u32(VERSION);
  for (const n of top) writeNode(w, n);
  for (let i = 0; i < 13; i++) w.u8(0);
  w.bytes(FOOT_ID);
  let pad = ((w.pos + 15) & ~15) - w.pos;
  if (pad === 0) pad = 16;
  for (let i = 0; i < pad; i++) w.u8(0);
  w.u32(0);
  w.u32(VERSION);
  for (let i = 0; i < 120; i++) w.u8(0);
  w.bytes(FOOT_MAGIC);
  return w.result();
}

// ------------------------------------------------------------------ сцена
export interface FbxTexture {
  /** путь файла рядом с FBX, напр. textures/x.png */
  file: string;
  png: Uint8Array;
}

export interface FbxBuildOptions {
  /** Сохранить текстуру в PNG; null — если её не удаётся прочитать (сжатая KTX2 и т.п.). */
  texture: (tex: THREE.Texture, kind: string) => Promise<FbxTexture | null>;
}

/** Слоты материалов: текстура → свойство FBX-материала. */
const SLOTS: { key: keyof THREE.MeshStandardMaterial; prop: string; kind: string }[] = [
  { key: 'map', prop: 'DiffuseColor', kind: 'basecolor' },
  { key: 'normalMap', prop: 'NormalMap', kind: 'normal' },
  { key: 'emissiveMap', prop: 'EmissiveColor', kind: 'emissive' },
  { key: 'alphaMap', prop: 'TransparencyFactor', kind: 'alpha' },
];

export async function exportFbx(root: THREE.Object3D, baseName: string, opts: FbxBuildOptions): Promise<Uint8Array> {
  root.updateMatrixWorld(true);
  let nextId = 1_000_000n;
  const id = () => nextId++;

  const objects: FbxNode[] = [];
  const conns: FbxNode[] = [];
  const OO = (child: bigint, parent: bigint) => conns.push(node('C', [S('OO'), L(child), L(parent)]));
  const OP = (child: bigint, parent: bigint, prop: string) => conns.push(node('C', [S('OP'), L(child), L(parent), S(prop)]));

  const matIds = new Map<THREE.Material, bigint>();
  const texIds = new Map<THREE.Texture, bigint>();
  const counts = { Model: 0, Geometry: 0, Material: 0, Texture: 0, Video: 0 };
  const v = new THREE.Vector3();
  const n = new THREE.Vector3();
  const nm = new THREE.Matrix3();

  const textureId = async (tex: THREE.Texture, kind: string): Promise<bigint | null> => {
    if (texIds.has(tex)) return texIds.get(tex)!;
    const t = await opts.texture(tex, kind);
    if (!t) return null;
    const name = t.file.split('/').pop()!.replace(/\.png$/, '');
    const vid = id();
    const tid = id();
    objects.push(
      node('Video', [L(vid), S(objName(name, 'Video')), S('Clip')], [
        node('Type', [S('Clip')]),
        node('Properties70', [], [P('Path', 'KString', 'XRefUrl', '', t.file)]),
        node('UseMipMap', [I(0)]),
        node('Filename', [S(t.file)]),
        node('RelativeFilename', [S(t.file)]),
        node('Content', [['R', t.png]]),
      ]),
      node('Texture', [L(tid), S(objName(name, 'Texture')), S('')], [
        node('Type', [S('TextureVideoClip')]),
        node('Version', [I(202)]),
        node('TextureName', [S(objName(name, 'Texture'))]),
        node('Properties70', [], [P('UseMaterial', 'bool', '', '', [1]), P('UseMipMap', 'bool', '', '', [0])]),
        node('Media', [S(objName(name, 'Video'))]),
        node('FileName', [S(t.file)]),
        node('RelativeFilename', [S(t.file)]),
        node('ModelUVTranslation', [D(0), D(0)]),
        node('ModelUVScaling', [D(1), D(1)]),
        node('Texture_Alpha_Source', [S('None')]),
        node('Cropping', [I(0), I(0), I(0), I(0)]),
      ]),
    );
    OO(vid, tid);
    counts.Video++;
    counts.Texture++;
    texIds.set(tex, tid);
    return tid;
  };

  const materialId = async (mat: THREE.MeshStandardMaterial): Promise<bigint> => {
    if (matIds.has(mat)) return matIds.get(mat)!;
    const mid = id();
    matIds.set(mat, mid);
    // В FBX цвета хранятся в sRGB (так их читают Unity, 3ds Max, Mixamo, three.js), в three.js — линейные.
    const c = (mat.color ?? new THREE.Color(1, 1, 1)).clone().convertLinearToSRGB();
    const e = (mat.emissive ?? new THREE.Color(0, 0, 0)).clone().convertLinearToSRGB();
    const opacity = mat.transparent || (mat.opacity ?? 1) < 1 ? mat.opacity ?? 1 : 1;
    const name = (mat.name || `material_${matIds.size}`).replace(/[\0\x01]/g, '');
    const props = [
      P('ShadingModel', 'KString', '', '', 'Phong'),
      P('DiffuseColor', 'Color', '', 'A', c.r, c.g, c.b),
      P('DiffuseFactor', 'Number', '', 'A', 1),
      P('EmissiveColor', 'Color', '', 'A', e.r, e.g, e.b),
      P('EmissiveFactor', 'Number', '', 'A', mat.emissiveIntensity ?? 1),
      P('AmbientColor', 'Color', '', 'A', 0, 0, 0),
      P('SpecularColor', 'Color', '', 'A', 0.2, 0.2, 0.2),
      // Blender переводит Shininess в шероховатость: чем глаже материал, тем выше значение.
      P('ShininessExponent', 'Number', '', 'A', Math.max(2, (1 - (mat.roughness ?? 0.5)) ** 2 * 100)),
      P('ReflectionFactor', 'Number', '', 'A', mat.metalness ?? 0),
      P('TransparencyFactor', 'Number', '', 'A', 1 - opacity),
      P('Opacity', 'Number', '', 'A', opacity),
    ];
    objects.push(
      node('Material', [L(mid), S(objName(name, 'Material')), S('')], [
        node('Version', [I(102)]),
        node('ShadingModel', [S('phong')]),
        node('MultiLayer', [I(0)]),
        node('Properties70', [], props),
      ]),
    );
    counts.Material++;
    for (const slot of SLOTS) {
      const tex = mat[slot.key] as THREE.Texture | null | undefined;
      if (!tex) continue;
      const tid = await textureId(tex, slot.kind);
      if (tid) OP(tid, mid, slot.prop);
    }
    return mid;
  };

  const meshes: THREE.Mesh[] = [];
  root.traverse((o) => (o as THREE.Mesh).isMesh && o.visible !== false && meshes.push(o as THREE.Mesh));

  for (const [mi, mesh] of meshes.entries()) {
    const geo = mesh.geometry;
    const pos = geo.getAttribute('position');
    if (!pos || pos.count < 3) continue;
    const uv = geo.getAttribute('uv');
    const nor = geo.getAttribute('normal');
    const index = geo.index ? Array.from(geo.index.array as ArrayLike<number>) : Array.from({ length: pos.count }, (_, i) => i);
    const triCount = Math.floor(index.length / 3);
    if (!triCount) continue;

    nm.getNormalMatrix(mesh.matrixWorld);
    const vertices = new Float64Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
      vertices[i * 3] = v.x;
      vertices[i * 3 + 1] = v.y;
      vertices[i * 3 + 2] = v.z;
    }
    // Треугольники; последний индекс полигона записывается как ~index (признак конца полигона).
    const polyIdx = new Int32Array(triCount * 3);
    for (let t = 0; t < triCount; t++) {
      polyIdx[t * 3] = index[t * 3];
      polyIdx[t * 3 + 1] = index[t * 3 + 1];
      polyIdx[t * 3 + 2] = ~index[t * 3 + 2];
    }

    const mats = (Array.isArray(mesh.material) ? mesh.material : [mesh.material]) as THREE.MeshStandardMaterial[];
    const layers: FbxNode[] = [];
    const layerRefs: FbxNode[] = [];

    if (nor) {
      const normals = new Float64Array(triCount * 9);
      for (let k = 0; k < triCount * 3; k++) {
        n.fromBufferAttribute(nor, index[k]).applyMatrix3(nm).normalize();
        normals[k * 3] = n.x;
        normals[k * 3 + 1] = n.y;
        normals[k * 3 + 2] = n.z;
      }
      layers.push(
        node('LayerElementNormal', [I(0)], [
          node('Version', [I(101)]),
          node('Name', [S('')]),
          node('MappingInformationType', [S('ByPolygonVertex')]),
          node('ReferenceInformationType', [S('Direct')]),
          node('Normals', [['d', normals]]),
        ]),
      );
      layerRefs.push(node('LayerElement', [], [node('Type', [S('LayerElementNormal')]), node('TypedIndex', [I(0)])]));
    }

    if (uv) {
      // UV в glTF идут сверху вниз (текстуры с flipY = false), в FBX — снизу вверх (как в OBJ).
      const gltfUv = mats.some((m) => m?.map && m.map.flipY === false) || (!mats.some((m) => m?.map) && root.userData.gltf === true);
      const uvs = new Float64Array(uv.count * 2);
      for (let i = 0; i < uv.count; i++) {
        uvs[i * 2] = uv.getX(i);
        uvs[i * 2 + 1] = gltfUv ? 1 - uv.getY(i) : uv.getY(i);
      }
      layers.push(
        node('LayerElementUV', [I(0)], [
          node('Version', [I(101)]),
          node('Name', [S('UVMap')]),
          node('MappingInformationType', [S('ByPolygonVertex')]),
          node('ReferenceInformationType', [S('IndexToDirect')]),
          node('UV', [['d', uvs]]),
          node('UVIndex', [['i', Int32Array.from(index.slice(0, triCount * 3))]]),
        ]),
      );
      layerRefs.push(node('LayerElement', [], [node('Type', [S('LayerElementUV')]), node('TypedIndex', [I(0)])]));
    }

    // Материал каждого треугольника — по группам геометрии.
    const perTri = new Int32Array(triCount);
    for (const g of geo.groups) {
      const from = Math.floor(g.start / 3);
      const to = Math.min(triCount, Math.floor((g.start + g.count) / 3));
      for (let t = from; t < to; t++) perTri[t] = g.materialIndex ?? 0;
    }
    const allSame = perTri.every((x) => x === perTri[0]);
    layers.push(
      node('LayerElementMaterial', [I(0)], [
        node('Version', [I(101)]),
        node('Name', [S('')]),
        node('MappingInformationType', [S(allSame ? 'AllSame' : 'ByPolygon')]),
        node('ReferenceInformationType', [S('IndexToDirect')]),
        node('Materials', [['i', allSame ? Int32Array.of(perTri[0] ?? 0) : perTri]]),
      ]),
    );
    layerRefs.push(node('LayerElement', [], [node('Type', [S('LayerElementMaterial')]), node('TypedIndex', [I(0)])]));

    const name = (mesh.name || `mesh_${mi}`).replace(/[\0\x01]/g, '');
    const gid = id();
    const modelId = id();
    objects.push(
      node('Geometry', [L(gid), S(objName(name, 'Geometry')), S('Mesh')], [
        node('Vertices', [['d', vertices]]),
        node('PolygonVertexIndex', [['i', polyIdx]]),
        node('GeometryVersion', [I(124)]),
        ...layers,
        node('Layer', [I(0)], [node('Version', [I(100)]), ...layerRefs]),
      ]),
      node('Model', [L(modelId), S(objName(name, 'Model')), S('Mesh')], [
        node('Version', [I(232)]),
        node('Properties70', [], [
          P('Lcl Translation', 'Lcl Translation', '', 'A', 0, 0, 0),
          P('Lcl Rotation', 'Lcl Rotation', '', 'A', 0, 0, 0),
          P('Lcl Scaling', 'Lcl Scaling', '', 'A', 1, 1, 1),
          P('DefaultAttributeIndex', 'int', 'Integer', '', [0]),
        ]),
        node('Shading', [['C', true]]),
        node('Culling', [S('CullingOff')]),
      ]),
    );
    counts.Geometry++;
    counts.Model++;
    OO(modelId, 0n);
    OO(gid, modelId);
    // Порядок подключения материалов = номера материалов в LayerElementMaterial.
    for (const m of mats) OO(await materialId(m ?? new THREE.MeshStandardMaterial()), modelId);
  }

  const now = new Date();
  const definitions = Object.entries(counts).filter(([, c]) => c > 0);
  const top: FbxNode[] = [
    node('FBXHeaderExtension', [], [
      node('FBXHeaderVersion', [I(1003)]),
      node('FBXVersion', [I(VERSION)]),
      node('EncryptionType', [I(0)]),
      node('CreationTimeStamp', [], [
        node('Version', [I(1000)]),
        node('Year', [I(now.getFullYear())]),
        node('Month', [I(now.getMonth() + 1)]),
        node('Day', [I(now.getDate())]),
        node('Hour', [I(now.getHours())]),
        node('Minute', [I(now.getMinutes())]),
        node('Second', [I(now.getSeconds())]),
        node('Millisecond', [I(0)]),
      ]),
      node('Creator', [S('Holo FBX Exporter')]),
    ]),
    node('FileId', [['R', FILE_ID]]),
    node('CreationTime', [S(TIME_ID)]),
    node('Creator', [S('Holo FBX Exporter')]),
    node('GlobalSettings', [], [
      node('Version', [I(1000)]),
      node('Properties70', [], [
        P('UpAxis', 'int', 'Integer', '', [1]),
        P('UpAxisSign', 'int', 'Integer', '', [1]),
        P('FrontAxis', 'int', 'Integer', '', [2]),
        P('FrontAxisSign', 'int', 'Integer', '', [1]),
        P('CoordAxis', 'int', 'Integer', '', [0]),
        P('CoordAxisSign', 'int', 'Integer', '', [1]),
        P('OriginalUpAxis', 'int', 'Integer', '', [1]),
        P('OriginalUpAxisSign', 'int', 'Integer', '', [1]),
        // 1 единица модели = 1 метр = 100 см.
        P('UnitScaleFactor', 'double', 'Number', '', 100),
        P('OriginalUnitScaleFactor', 'double', 'Number', '', 100),
      ]),
    ]),
    node('Documents', [], [
      node('Count', [I(1)]),
      node('Document', [L(id()), S('Scene'), S('Scene')], [
        node('Properties70', [], [P('SourceObject', 'object', '', ''), P('ActiveAnimStackName', 'KString', '', '', '')]),
        node('RootNode', [L(0n)]),
      ]),
    ]),
    node('References'),
    node('Definitions', [], [
      node('Version', [I(100)]),
      node('Count', [I(1 + definitions.reduce((a, [, c]) => a + c, 0))]),
      node('ObjectType', [S('GlobalSettings')], [node('Count', [I(1)])]),
      ...definitions.map(([type, c]) => node('ObjectType', [S(type)], [node('Count', [I(c)])])),
    ]),
    node('Objects', [], objects),
    node('Connections', [], conns),
    node('Takes', [], [node('Current', [S('')])]),
  ];
  void baseName;
  return serialize(top);
}
