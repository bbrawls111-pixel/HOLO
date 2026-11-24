import {
  Background, Controls, Handle, MiniMap, Position, ReactFlow, ReactFlowProvider, useReactFlow, type Edge, type Node, type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {
  ArrowDownFromLine, ArrowRightFromLine, ChevronRight, CornerDownRight, FileInput, Loader2, Network, Plus, Tags, Trash2, X,
} from 'lucide-react';
import { memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { createBoard, STATUS_TEXT, useBoardEditor } from '../boards';
import { confirmAction, toast, useStore } from '../store';
import type { Board, TreeCategory, TreeData, TreeNode } from '../types';
import { cx, formatDateTime } from '../util';
import styles from './Structures.module.css';

/*
 * РћРґРЅРѕ РѕР±С‰РµРµ РґРµСЂРµРІРѕ РїСЂРѕРµРєС‚Р°. Р РµРґР°РєС‚РёСЂРѕРІР°С‚СЊ РµРіРѕ РјРѕР¶РµС‚ Р»СЋР±РѕР№ РёР· РґРІСѓС… СѓС‡Р°СЃС‚РЅРёРєРѕРІ:
 * РёР·РјРµРЅРµРЅРёСЏ СЃРѕС…СЂР°РЅСЏСЋС‚СЃСЏ Р°РІС‚РѕРјР°С‚РёС‡РµСЃРєРё Рё СЃСЂР°Р·Сѓ РїСЂРёС…РѕРґСЏС‚ РЅР°РїР°СЂРЅРёРєСѓ.
 */

const PALETTE = ['#4f8df7', '#3ddc97', '#f472b6', '#f5b84b', '#8b6dff', '#22d3ee', '#fb7185', '#a3e635', '#94a3b8'];

export const DEFAULT_CATEGORIES: TreeCategory[] = [
  { id: 'code', name: 'РџСЂРѕРіСЂР°РјРјРёСЂРѕРІР°РЅРёРµ', color: '#4f8df7' },
  { id: 'create', name: 'РЎРѕР·РґР°РЅРёРµ', color: '#3ddc97' },
  { id: 'gen', name: 'Р“РµРЅРµСЂР°С†РёСЏ', color: '#f472b6' },
  { id: 'think', name: 'РџСЂРѕРґСѓРјС‹РІР°РЅРёРµ', color: '#f5b84b' },
  { id: 'design', name: 'Р”РёР·Р°Р№РЅ', color: '#8b6dff' },
  { id: 'sound', name: 'Р—РІСѓРє', color: '#22d3ee' },
];

const SAMPLE = `Game
в”њв”Ђв”Ђ World
в”‚    в”њв”Ђв”Ђ Locations
в”‚    в”‚    в”њв”Ђв”Ђ Forest
в”‚    в”‚    в””в”Ђв”Ђ City
в”‚    в””в”Ђв”Ђ Environment
в”њв”Ђв”Ђ Characters
в”‚    в”њв”Ђв”Ђ Player
в”‚    в””в”Ђв”Ђ Enemies
в”њв”Ђв”Ђ Items
в””в”Ђв”Ђ Audio
     в”њв”Ђв”Ђ Music
     в””в”Ђв”Ђ SFX`;

const uid = () => Math.random().toString(36).slice(2, 10);

/** Р Р°Р·Р±РѕСЂ С‚РµРєСЃС‚Р° СЃ РѕС‚СЃС‚СѓРїР°РјРё РёР»Рё В«РїСЃРµРІРґРѕРіСЂР°С„РёРєРѕР№В» РґРµСЂРµРІР° (в”њв”Ђв”Ђ в””в”Ђв”Ђ в”‚). */
export function parseTreeText(text: string): TreeNode[] {
  const nodes: TreeNode[] = [];
  const stack: { indent: number; id: string }[] = [];
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim()) continue;
    const m = /^[\sв”‚в”њв””в”Ђ|`\-+*вЂў]*/.exec(raw)!;
    const indent = m[0].replace(/\t/g, '    ').length;
    const label = raw.slice(m[0].length).trim();
    if (!label) continue;
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
    const node: TreeNode = { id: uid(), parentId: stack.length ? stack[stack.length - 1].id : null, label };
    nodes.push(node);
    stack.push({ indent, id: node.id });
  }
  return nodes;
}

/** Р Р°СЃРєР»Р°РґРєР°: Р»РёСЃС‚СЊСЏ РїРѕ РїРѕСЂСЏРґРєСѓ, СЂРѕРґРёС‚РµР»СЊ вЂ” РїРѕ С†РµРЅС‚СЂСѓ РЅР°Рґ РґРµС‚СЊРјРё. */
function layout(nodes: TreeNode[], dir: 'TB' | 'LR') {
  const children = new Map<string | null, TreeNode[]>();
  const ids = new Set(nodes.map((n) => n.id));
  for (const n of nodes) {
    const p = n.parentId && ids.has(n.parentId) ? n.parentId : null;
    if (!children.has(p)) children.set(p, []);
    children.get(p)!.push(n);
  }
  const pos = new Map<string, { x: number; y: number }>();
  let leaf = 0;
  const place = (n: TreeNode, depth: number) => {
    const kids = children.get(n.id) ?? [];
    let slot: number;
    if (!kids.length) slot = leaf++;
    else {
      kids.forEach((k) => place(k, depth + 1));
      slot = (pos.get(kids[0].id)!.x + pos.get(kids[kids.length - 1].id)!.x) / 2;
    }
    pos.set(n.id, { x: slot, y: depth });
  };
  for (const r of children.get(null) ?? []) {
    place(r, 0);
    leaf += 0.6;
  }
  const out = new Map<string, { x: number; y: number }>();
  for (const [id, p] of pos) out.set(id, dir === 'TB' ? { x: p.x * 185, y: p.y * 135 } : { x: p.y * 250, y: p.x * 92 });
  return { pos: out, children };
}

interface NodeData extends Record<string, unknown> {
  node: TreeNode;
  category?: TreeCategory;
  root: boolean;
  count: number;
  dir: 'TB' | 'LR';
  dimmed: boolean;
}

const HoloNode = memo(function HoloNode({ data, selected }: NodeProps<Node<NodeData>>) {
  const { node, category, root, count, dir, dimmed } = data;
  const color = category?.color || node.color || (root ? '#8b6dff' : '');
  return (
    <div
      className={cx(styles.node, selected && styles.nodeSelected, root && styles.nodeRoot, dimmed && styles.nodeDim)}
      style={color ? ({ '--c': color } as CSSProperties) : undefined}
    >
      {!root && <Handle type="target" position={dir === 'TB' ? Position.Top : Position.Left} />}
      {category && <span className={styles.nodeCat}>{category.name}</span>}
      <div className={styles.nodeLabel}>{node.label || 'Р‘РµР· РЅР°Р·РІР°РЅРёСЏ'}</div>
      {node.note && <div className={styles.nodeNote}>{node.note.split('\n')[0]}</div>}
      {count > 0 && <span className={styles.nodeCount}>{count}</span>}
      <Handle type="source" position={dir === 'TB' ? Position.Bottom : Position.Right} />
    </div>
  );
});

const nodeTypes = { holo: HoloNode };

export function Structures() {
  const boards = useStore((s) => s.boards);
  const creating = useRef(false);
  // РћР±С‰РµРµ РґРµСЂРµРІРѕ вЂ” СЃР°РјРѕРµ РїРµСЂРІРѕРµ СЃРѕР·РґР°РЅРЅРѕРµ (РµСЃР»Рё РІРґСЂСѓРі РёС… РЅРµСЃРєРѕР»СЊРєРѕ).
  const tree = useMemo(
    () => Object.values(boards).filter((b) => b.kind === 'tree').sort((a, b) => a.id - b.id)[0] as Board<TreeData> | undefined,
    [boards],
  );

  useEffect(() => {
    if (tree || creating.current) return;
    creating.current = true;
    createBoard<TreeData>('tree', 'РЎС‚СЂСѓРєС‚СѓСЂР° РїСЂРѕРµРєС‚Р°', {
      nodes: parseTreeText(SAMPLE),
      direction: 'TB',
      categories: DEFAULT_CATEGORIES,
    })
      .catch((e) => toast(e.message))
      .finally(() => (creating.current = false));
  }, [tree]);

  return (
    <div className={cx(styles.page, 'page-enter')}>
      {tree ? (
        <ReactFlowProvider>
          <TreeEditor board={tree} />
        </ReactFlowProvider>
      ) : (
        <section className={cx('card', styles.loading)}>
          <Loader2 className="spin" /> РЎРѕР·РґР°С‘Рј РѕР±С‰РµРµ РґРµСЂРµРІРѕ РїСЂРѕРµРєС‚Р°вЂ¦
        </section>
      )}
    </div>
  );
}

function TreeEditor({ board }: { board: Board<TreeData> }) {
  const users = useStore((s) => s.users);
  const { draft, update, status } = useBoardEditor<TreeData>(board, 700);
  const [selected, setSelected] = useState<string | null>(null);
  const [filter, setFilter] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [catsOpen, setCatsOpen] = useState(false);
  const flow = useReactFlow();

  const tree = draft?.data ?? { nodes: [] };
  const dir = tree.direction ?? 'TB';
  const nodes = tree.nodes;
  const categories = tree.categories ?? DEFAULT_CATEGORIES;
  const catById = useMemo(() => new Map(categories.map((c) => [c.id, c])), [categories]);
  const setTree = useCallback((patch: Partial<TreeData>) => update({ data: { ...tree, categories, ...patch } }), [tree, categories, update]);
  const setNodes = useCallback((next: TreeNode[]) => setTree({ nodes: next }), [setTree]);

  const { pos, children } = useMemo(() => layout(nodes, dir), [nodes, dir]);

  const rfNodes: Node<NodeData>[] = useMemo(
    () =>
      nodes.map((n) => ({
        id: n.id,
        type: 'holo',
        position: pos.get(n.id) ?? { x: 0, y: 0 },
        selected: n.id === selected,
        draggable: false,
        data: {
          node: n,
          category: n.category ? catById.get(n.category) : undefined,
          root: !n.parentId,
          count: children.get(n.id)?.length ?? 0,
          dir,
          dimmed: !!filter && n.category !== filter,
        },
      })),
    [nodes, pos, children, selected, dir, catById, filter],
  );
  const rfEdges: Edge[] = useMemo(
    () =>
      nodes
        .filter((n) => n.parentId && pos.has(n.parentId))
        .map((n) => {
          const c = n.category ? catById.get(n.category)?.color : undefined;
          return {
            id: `${n.parentId}-${n.id}`,
            source: n.parentId!,
            target: n.id,
            type: 'smoothstep',
            animated: n.id === selected || n.parentId === selected,
            style: { stroke: c || '#3a3a55', strokeWidth: 1.6, opacity: filter && n.category !== filter ? 0.25 : 1 },
          };
        }),
    [nodes, pos, selected, catById, filter],
  );

  useEffect(() => {
    const t = setTimeout(() => flow.fitView({ padding: 0.12, duration: 400, minZoom: 0.8, maxZoom: 1.1 }), 80);
    return () => clearTimeout(t);
  }, [nodes.length, dir, flow]);

  const sel = nodes.find((n) => n.id === selected);
  const patchNode = (id: string, patch: Partial<TreeNode>) => setNodes(nodes.map((n) => (n.id === id ? { ...n, ...patch } : n)));

  const focusTitle = () => setTimeout(() => (document.getElementById('tree-label') as HTMLInputElement | null)?.select(), 60);

  const addChild = (parentId: string | null) => {
    const parent = nodes.find((n) => n.id === parentId);
    const n: TreeNode = { id: uid(), parentId, label: 'РќРѕРІС‹Р№ Р±Р»РѕРє', category: parent?.category };
    setNodes([...nodes, n]);
    setSelected(n.id);
    focusTitle();
  };

  const addSibling = () => {
    if (!sel) return addChild(null);
    if (!sel.parentId) return addChild(sel.id);
    const n: TreeNode = { id: uid(), parentId: sel.parentId, label: 'РќРѕРІС‹Р№ Р±Р»РѕРє', category: sel.category };
    const idx = nodes.findIndex((x) => x.id === sel.id);
    setNodes([...nodes.slice(0, idx + 1), n, ...nodes.slice(idx + 1)]);
    setSelected(n.id);
    focusTitle();
  };

  const removeNode = async () => {
    if (!sel) return;
    const doomed = new Set<string>([sel.id]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const n of nodes)
        if (n.parentId && doomed.has(n.parentId) && !doomed.has(n.id)) {
          doomed.add(n.id);
          grew = true;
        }
    }
    if (doomed.size > 1 && !(await confirmAction(`РЈРґР°Р»РёС‚СЊ В«${sel.label}В»?`, `Р’РјРµСЃС‚Рµ СЃ РЅРёРј СѓРґР°Р»СЏС‚СЃСЏ РІР»РѕР¶РµРЅРЅС‹Рµ Р±Р»РѕРєРё: ${doomed.size - 1}.`))) return;
    setNodes(nodes.filter((n) => !doomed.has(n.id)));
    setSelected(sel.parentId);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || importing || catsOpen) return;
      if (e.key === 'Tab') {
        e.preventDefault();
        addChild(sel?.id ?? null);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        addSibling();
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && sel) {
        e.preventDefault();
        removeNode();
      } else if (e.key === 'F2' && sel) {
        focusTitle();
      } else if (e.key === 'Escape') {
        setSelected(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  if (!draft) return null;

  // РџСѓС‚СЊ РѕС‚ РєРѕСЂРЅСЏ РґРѕ РІС‹Р±СЂР°РЅРЅРѕРіРѕ Р±Р»РѕРєР°.
  const path: TreeNode[] = [];
  for (let cur = sel; cur; cur = nodes.find((n) => n.id === cur!.parentId)) path.unshift(cur);
  const selKids = sel ? children.get(sel.id) ?? [] : [];
  const counts = new Map<string, number>();
  nodes.forEach((n) => n.category && counts.set(n.category, (counts.get(n.category) ?? 0) + 1));

  return (
    <section className={cx('card', styles.editor)}>
      <div className={styles.toolbar}>
        <Network size={18} className={styles.toolIcon} />
        <input className={styles.titleInput} value={draft.title} onChange={(e) => update({ title: e.target.value })} />
        <div className={styles.segment}>
          <button className={cx(dir === 'TB' && styles.segOn)} onClick={() => setTree({ direction: 'TB' })}>
            <ArrowDownFromLine size={15} /> РЎРІРµСЂС…Сѓ РІРЅРёР·
          </button>
          <button className={cx(dir === 'LR' && styles.segOn)} onClick={() => setTree({ direction: 'LR' })}>
            <ArrowRightFromLine size={15} /> РЎР»РµРІР° РЅР°РїСЂР°РІРѕ
          </button>
        </div>
        <button className="btn sm" onClick={() => setCatsOpen(true)}>
          <Tags size={15} /> РљР°С‚РµРіРѕСЂРёРё
        </button>
        <button className="btn sm" onClick={() => setImporting(true)}>
          <FileInput size={15} /> РР· С‚РµРєСЃС‚Р°
        </button>
        <div className={styles.spacer} />
        <span className={cx(styles.status, styles[status])}>{STATUS_TEXT[status]}</span>
        <span className={styles.edited}>
          {users[board.updatedBy ?? 0]?.nickname} В· {formatDateTime(board.updatedAt)}
        </span>
      </div>

      <div className={styles.body}>
        <div className={styles.flow}>
          <div className={styles.legend}>
            {categories.map((c) => (
              <button
                key={c.id}
                className={cx(styles.legendItem, filter === c.id && styles.legendOn)}
                style={{ '--c': c.color } as CSSProperties}
                onClick={() => setFilter(filter === c.id ? null : c.id)}
                title="РџРѕРґСЃРІРµС‚РёС‚СЊ Р±Р»РѕРєРё СЌС‚РѕР№ РєР°С‚РµРіРѕСЂРёРё"
              >
                <span className={styles.legendDot} />
                {c.name}
                <span className={styles.legendCount}>{counts.get(c.id) ?? 0}</span>
              </button>
            ))}
          </div>
          <ReactFlow
            nodes={rfNodes}
            edges={rfEdges}
            nodeTypes={nodeTypes}
            colorMode="dark"
            fitView
            fitViewOptions={{ padding: 0.12, minZoom: 0.8, maxZoom: 1.1 }}
            minZoom={0.15}
            nodesConnectable={false}
            proOptions={{ hideAttribution: true }}
            onNodeClick={(_, n) => setSelected(n.id)}
            onPaneClick={() => setSelected(null)}
          >
            <Background gap={22} size={1.2} color="#23233a" />
            <Controls showInteractive={false} />
            <MiniMap
              pannable
              zoomable
              nodeColor={(n) => (n.data as NodeData).category?.color || '#3a3a55'}
              maskColor="rgba(7,7,12,0.7)"
            />
          </ReactFlow>
          {!nodes.length && (
            <div className={styles.emptyCanvas}>
              <button className="btn primary" onClick={() => addChild(null)}>
                <Plus size={15} /> РџРµСЂРІС‹Р№ Р±Р»РѕРє
              </button>
            </div>
          )}
        </div>

        <aside className={styles.side} key={sel?.id ?? 'none'}>
          {sel ? (
            <>
              <div className={styles.crumbs}>
                {path.map((p, i) => (
                  <span key={p.id} className={styles.crumb}>
                    {i > 0 && <ChevronRight size={12} />}
                    <button onClick={() => setSelected(p.id)}>{p.label}</button>
                  </span>
                ))}
              </div>

              <div className={styles.field}>
                <span className="label">РљР°С‚РµРіРѕСЂРёСЏ</span>
                <div className={styles.catPick}>
                  <button className={cx(styles.catChip, !sel.category && styles.catChipOn)} onClick={() => patchNode(sel.id, { category: undefined })}>
                    Р‘РµР· РєР°С‚РµРіРѕСЂРёРё
                  </button>
                  {categories.map((c) => (
                    <button
                      key={c.id}
                      className={cx(styles.catChip, sel.category === c.id && styles.catChipOn)}
                      style={{ '--c': c.color } as CSSProperties}
                      onClick={() => patchNode(sel.id, { category: c.id })}
                    >
                      {c.name}
                    </button>
                  ))}
                </div>
              </div>

              <div className={styles.field}>
                <span className="label">РќР°Р·РІР°РЅРёРµ</span>
                <input
                  id="tree-label"
                  className={styles.bigTitle}
                  value={sel.label}
                  placeholder="РќР°Р·РІР°РЅРёРµ Р±Р»РѕРєР°"
                  onChange={(e) => patchNode(sel.id, { label: e.target.value })}
                  onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
                />
              </div>

              <div className={cx(styles.field, styles.grow)}>
                <span className="label">РћРїРёСЃР°РЅРёРµ Рё РїРѕРґСЂРѕР±РЅРѕСЃС‚Рё</span>
                <textarea
                  className={styles.desc}
                  value={sel.note ?? ''}
                  placeholder={'Р§С‚Рѕ СЌС‚Рѕ Р·Р° Р±Р»РѕРє, РєР°Рє СЂР°Р±РѕС‚Р°РµС‚, С‡С‚Рѕ РЅСѓР¶РЅРѕ СЃРґРµР»Р°С‚СЊ, СЃСЃС‹Р»РєРё, РёРґРµРёвЂ¦\n\nРџРµСЂРІР°СЏ СЃС‚СЂРѕРєР° РїРѕРєР°Р·С‹РІР°РµС‚СЃСЏ РїСЂСЏРјРѕ РЅР° СЃС…РµРјРµ.'}
                  onChange={(e) => patchNode(sel.id, { note: e.target.value })}
                />
              </div>

              {selKids.length > 0 && (
                <div className={styles.field}>
                  <span className="label">Р’Р»РѕР¶РµРЅРЅС‹Рµ Р±Р»РѕРєРё В· {selKids.length}</span>
                  <div className={styles.kids}>
                    {selKids.map((k) => {
                      const c = k.category ? catById.get(k.category) : undefined;
                      return (
                        <button key={k.id} className={styles.kid} onClick={() => setSelected(k.id)} style={{ '--c': c?.color ?? '#3a3a55' } as CSSProperties}>
                          <span className={styles.kidBar} />
                          {k.label}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              <div className={styles.btnRow}>
                <button className="btn sm primary" onClick={() => addChild(sel.id)}>
                  <CornerDownRight size={14} /> Р’Р»РѕР¶РµРЅРЅС‹Р№
                </button>
                <button className="btn sm" onClick={addSibling}>
                  <Plus size={14} /> Р СЏРґРѕРј
                </button>
                <div className={styles.spacer} />
                <button className="btn sm icon danger" onClick={removeNode} title="РЈРґР°Р»РёС‚СЊ Р±Р»РѕРє">
                  <Trash2 size={15} />
                </button>
              </div>
            </>
          ) : (
            <div className={styles.overview}>
              <h3>РЎС‚СЂСѓРєС‚СѓСЂР° РїСЂРѕРµРєС‚Р°</h3>
              <p className="muted">
                РћРґРЅРѕ РѕР±С‰РµРµ РґРµСЂРµРІРѕ РЅР° РґРІРѕРёС…. РќР°Р¶РјРёС‚Рµ РЅР° Р±Р»РѕРє, С‡С‚РѕР±С‹ СѓРІРёРґРµС‚СЊ Рё РёР·РјРµРЅРёС‚СЊ РµРіРѕ РєР°С‚РµРіРѕСЂРёСЋ, РЅР°Р·РІР°РЅРёРµ Рё РїРѕРґСЂРѕР±РЅРѕРµ РѕРїРёСЃР°РЅРёРµ.
              </p>
              <div className={styles.stats}>
                <div>
                  <strong>{nodes.length}</strong>
                  <span>Р±Р»РѕРєРѕРІ</span>
                </div>
                <div>
                  <strong>{categories.length}</strong>
                  <span>РєР°С‚РµРіРѕСЂРёР№</span>
                </div>
              </div>
              <button className="btn sm" onClick={() => addChild(null)}>
                <Plus size={14} /> РќРѕРІР°СЏ РІРµС‚РєР° СЃ РєРѕСЂРЅСЏ
              </button>
              <div className={styles.keys}>
                <div>
                  <kbd>Tab</kbd> РІР»РѕР¶РµРЅРЅС‹Р№ Р±Р»РѕРє
                </div>
                <div>
                  <kbd>Enter</kbd> Р±Р»РѕРє СЂСЏРґРѕРј
                </div>
                <div>
                  <kbd>Del</kbd> СѓРґР°Р»РёС‚СЊ РІРµС‚РєСѓ
                </div>
                <div>
                  <kbd>F2</kbd> РїРµСЂРµРёРјРµРЅРѕРІР°С‚СЊ В· <kbd>Esc</kbd> СЃРЅСЏС‚СЊ РІС‹Р±РѕСЂ
                </div>
              </div>
            </div>
          )}
        </aside>
      </div>

      {catsOpen && <CategoryDialog categories={categories} nodes={nodes} onClose={() => setCatsOpen(false)} onSave={(c, n) => setTree({ categories: c, nodes: n })} />}

      {importing && (
        <ImportDialog
          hasSelection={!!sel}
          onClose={() => setImporting(false)}
          onImport={(text, replace) => {
            const parsed = parseTreeText(text);
            if (!parsed.length) return toast('РќРµ РЅР°С€Р»РѕСЃСЊ РЅРё РѕРґРЅРѕРіРѕ Р±Р»РѕРєР°');
            if (!replace && sel) parsed.forEach((n) => !n.parentId && (n.parentId = sel.id));
            setNodes(replace ? parsed : [...nodes, ...parsed]);
            setImporting(false);
          }}
        />
      )}
    </section>
  );
}

function CategoryDialog({
  categories, nodes, onClose, onSave,
}: { categories: TreeCategory[]; nodes: TreeNode[]; onClose: () => void; onSave: (c: TreeCategory[], n: TreeNode[]) => void }) {
  const [list, setList] = useState<TreeCategory[]>(categories);
  const used = (id: string) => nodes.filter((n) => n.category === id).length;

  const save = () => {
    const clean = list.map((c) => ({ ...c, name: c.name.trim() || 'Р‘РµР· РЅР°Р·РІР°РЅРёСЏ' }));
    const ids = new Set(clean.map((c) => c.id));
    onSave(clean, nodes.map((n) => (n.category && !ids.has(n.category) ? { ...n, category: undefined } : n)));
    onClose();
  };

  return (
    <div className={styles.dialogBackdrop} onMouseDown={onClose}>
      <div className={cx('card', styles.dialog)} onMouseDown={(e) => e.stopPropagation()}>
        <div className={styles.dialogHead}>
          <h3>РљР°С‚РµРіРѕСЂРёРё</h3>
          <button className="btn ghost sm icon" onClick={onClose}>
            <X size={16} />
          </button>
        </div>
        <p className="muted">РќР°РїСЂРёРјРµСЂ: РџСЂРѕРіСЂР°РјРјРёСЂРѕРІР°РЅРёРµ, РЎРѕР·РґР°РЅРёРµ, Р“РµРЅРµСЂР°С†РёСЏ, РџСЂРѕРґСѓРјС‹РІР°РЅРёРµ. Р¦РІРµС‚ РєР°С‚РµРіРѕСЂРёРё РѕРєСЂР°С€РёРІР°РµС‚ Р±Р»РѕРєРё.</p>
        <div className={styles.catList}>
          {list.map((c, i) => (
            <div key={c.id} className={styles.catRow}>
              <span className={styles.catSwatch} style={{ background: c.color }} />
              <input
                className="input"
                value={c.name}
                onChange={(e) => setList(list.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))}
              />
              <div className={styles.colors}>
                {PALETTE.map((p) => (
                  <button
                    key={p}
                    className={cx(styles.color, c.color === p && styles.colorOn)}
                    style={{ background: p }}
                    onClick={() => setList(list.map((x, j) => (j === i ? { ...x, color: p } : x)))}
                  />
                ))}
              </div>
              <button
                className="btn ghost sm icon danger"
                title={used(c.id) ? `РСЃРїРѕР»СЊР·СѓРµС‚СЃСЏ РІ ${used(c.id)} Р±Р»РѕРєР°С… вЂ” РѕРЅРё СЃС‚Р°РЅСѓС‚ Р±РµР· РєР°С‚РµРіРѕСЂРёРё` : 'РЈРґР°Р»РёС‚СЊ'}
                onClick={() => setList(list.filter((_, j) => j !== i))}
              >
                <Trash2 size={15} />
              </button>
            </div>
          ))}
        </div>
        <button
          className="btn sm"
          style={{ alignSelf: 'flex-start' }}
          onClick={() => setList([...list, { id: uid(), name: 'РќРѕРІР°СЏ РєР°С‚РµРіРѕСЂРёСЏ', color: PALETTE[list.length % PALETTE.length] }])}
        >
          <Plus size={14} /> Р”РѕР±Р°РІРёС‚СЊ РєР°С‚РµРіРѕСЂРёСЋ
        </button>
        <div className={styles.dialogActions}>
          <button className="btn ghost" onClick={onClose}>
            РћС‚РјРµРЅР°
          </button>
          <button className="btn primary" onClick={save}>
            РЎРѕС…СЂР°РЅРёС‚СЊ
          </button>
        </div>
      </div>
    </div>
  );
}

function ImportDialog({ onClose, onImport, hasSelection }: { onClose: () => void; onImport: (t: string, replace: boolean) => void; hasSelection: boolean }) {
  const [text, setText] = useState(SAMPLE);
  return (
    <div className={styles.dialogBackdrop} onMouseDown={onClose}>
      <div className={cx('card', styles.dialog)} onMouseDown={(e) => e.stopPropagation()}>
        <div className={styles.dialogHead}>
          <h3>РРјРїРѕСЂС‚ РёР· С‚РµРєСЃС‚Р°</h3>
          <button className="btn ghost sm icon" onClick={onClose}>
            <X size={16} />
          </button>
        </div>
        <p className="muted">РћС‚СЃС‚СѓРїС‹ РёР»Рё СЃРёРјРІРѕР»С‹ в”њв”Ђв”Ђ в””в”Ђв”Ђ в”‚ Р·Р°РґР°СЋС‚ РІР»РѕР¶РµРЅРЅРѕСЃС‚СЊ вЂ” РјРѕР¶РЅРѕ РІСЃС‚Р°РІРёС‚СЊ РґРµСЂРµРІРѕ РїСЂСЏРјРѕ РёР· РґРѕРєСѓРјРµРЅС‚Р°.</p>
        <textarea className={cx('input', styles.importArea)} value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} />
        <div className={styles.dialogActions}>
          <button className="btn ghost" onClick={onClose}>
            РћС‚РјРµРЅР°
          </button>
          <button className="btn" onClick={() => onImport(text, false)}>
            {hasSelection ? 'Р”РѕР±Р°РІРёС‚СЊ РІ РІС‹Р±СЂР°РЅРЅС‹Р№ Р±Р»РѕРє' : 'Р”РѕР±Р°РІРёС‚СЊ'}
          </button>
          <button className="btn primary" onClick={() => onImport(text, true)}>
            Р—Р°РјРµРЅРёС‚СЊ РІСЃС‘
          </button>
        </div>
      </div>
    </div>
  );
}
