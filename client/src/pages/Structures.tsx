import {
  Background, Controls, Handle, MiniMap, Position, ReactFlow, ReactFlowProvider, useReactFlow, type Edge, type Node, type NodeChange, type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {
  ArrowDownFromLine, ArrowRightFromLine, ChevronRight, CornerDownRight, FileInput, Loader2, Move, Network, Plus, RotateCcw, Tags, Trash2, X,
} from 'lucide-react';
import { memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { createBoard, STATUS_TEXT, useBoardEditor } from '../boards';
import { confirmAction, toast, useStore } from '../store';
import type { Board, TreeCategory, TreeData, TreeNode } from '../types';
import { looksBroken, repairText } from '../repairText';
import { cx, formatDateTime } from '../util';
import styles from './Structures.module.css';

/*
 * Одно общее дерево проекта. Редактировать его может любой из двух участников:
 * изменения сохраняются автоматически и сразу приходят напарнику.
 */

const PALETTE = ['#4f8df7', '#3ddc97', '#f472b6', '#f5b84b', '#8b6dff', '#22d3ee', '#fb7185', '#a3e635', '#94a3b8'];

export const DEFAULT_CATEGORIES: TreeCategory[] = [
  { id: 'code', name: 'Программирование', color: '#4f8df7' },
  { id: 'create', name: 'Создание', color: '#3ddc97' },
  { id: 'gen', name: 'Генерация', color: '#f472b6' },
  { id: 'think', name: 'Продумывание', color: '#f5b84b' },
  { id: 'design', name: 'Дизайн', color: '#8b6dff' },
  { id: 'sound', name: 'Звук', color: '#22d3ee' },
];

const SAMPLE = `Game
├── World
│    ├── Locations
│    │    ├── Forest
│    │    └── City
│    └── Environment
├── Characters
│    ├── Player
│    └── Enemies
├── Items
└── Audio
     ├── Music
     └── SFX`;

const uid = () => Math.random().toString(36).slice(2, 10);

const FIT = { padding: 0.12, minZoom: 0.8, maxZoom: 1.1 };

/** Разбор текста с отступами или «псевдографикой» дерева (├── └── │). */
export function parseTreeText(text: string): TreeNode[] {
  const nodes: TreeNode[] = [];
  const stack: { indent: number; id: string }[] = [];
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim()) continue;
    const m = /^[\s│├└─|`\-+*•]*/.exec(raw)!;
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

/** Раскладка: листья по порядку, родитель — по центру над детьми. */
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
  // Ручные сдвиги: сдвиг блока применяется ко всей его ветке.
  const shift = (n: TreeNode, ox: number, oy: number) => {
    const sx = ox + (n.dx ?? 0);
    const sy = oy + (n.dy ?? 0);
    const p = out.get(n.id);
    if (p) out.set(n.id, { x: p.x + sx, y: p.y + sy });
    for (const k of children.get(n.id) ?? []) shift(k, sx, sy);
  };
  for (const r of children.get(null) ?? []) shift(r, 0, 0);
  return { pos: out, children };
}

/** Все потомки блока (вместе с ним). */
function subtree(id: string, children: Map<string | null, TreeNode[]>) {
  const out = new Set<string>([id]);
  const walk = (x: string) => (children.get(x) ?? []).forEach((k) => (out.add(k.id), walk(k.id)));
  walk(id);
  return out;
}

interface NodeData extends Record<string, unknown> {
  node: TreeNode;
  category?: TreeCategory;
  root: boolean;
  count: number;
  dir: 'TB' | 'LR';
  dimmed: boolean;
  moving: boolean;
}

const HoloNode = memo(function HoloNode({ data, selected }: NodeProps<Node<NodeData>>) {
  const { node, category, root, count, dir, dimmed, moving } = data;
  const color = category?.color || node.color || (root ? '#8b6dff' : '');
  return (
    <div
      className={cx(styles.node, selected && styles.nodeSelected, root && styles.nodeRoot, dimmed && styles.nodeDim, moving && styles.nodeMoving)}
      title={moving ? 'Перетащите блок. Двойной клик — закрепить' : 'Двойной клик — переместить блок'}
      style={color ? ({ '--c': color } as CSSProperties) : undefined}
    >
      {!root && <Handle type="target" position={dir === 'TB' ? Position.Top : Position.Left} />}
      {category && <span className={styles.nodeCat}>{category.name}</span>}
      <div className={styles.nodeLabel}>{node.label || 'Без названия'}</div>
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
  // Общее дерево — самое первое созданное (если вдруг их несколько).
  const tree = useMemo(
    () => Object.values(boards).filter((b) => b.kind === 'tree').sort((a, b) => a.id - b.id)[0] as Board<TreeData> | undefined,
    [boards],
  );

  useEffect(() => {
    if (tree || creating.current) return;
    creating.current = true;
    createBoard<TreeData>('tree', 'Структура проекта', {
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
          <Loader2 className="spin" /> Создаём общее дерево проекта…
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

  // Перемещение: двойной клик по блоку включает режим, затем блок (с веткой) тащится мышью.
  const [moveId, setMoveId] = useState<string | null>(null);
  const [drag, setDrag] = useState<{ ids: Set<string>; dx: number; dy: number } | null>(null);
  const dragRef = useRef<{ ids: Set<string>; dx: number; dy: number } | null>(null);
  const moving = useMemo(() => (moveId ? subtree(moveId, children) : new Set<string>()), [moveId, children]);

  const rfNodes: Node<NodeData>[] = useMemo(
    () =>
      nodes.map((n) => {
        const p = pos.get(n.id) ?? { x: 0, y: 0 };
        const shifted = drag?.ids.has(n.id) ? { x: p.x + drag.dx, y: p.y + drag.dy } : p;
        return {
          id: n.id,
          type: 'holo',
          position: shifted,
          selected: n.id === selected,
          draggable: n.id === moveId,
          data: {
            node: n,
            category: n.category ? catById.get(n.category) : undefined,
            root: !n.parentId,
            count: children.get(n.id)?.length ?? 0,
            dir,
            dimmed: !!filter && n.category !== filter,
            moving: moving.has(n.id),
          },
        };
      }),
    [nodes, pos, children, selected, dir, catById, filter, moveId, moving, drag],
  );

  const onNodesChange = useCallback(
    (changes: NodeChange<Node<NodeData>>[]) => {
      for (const c of changes) {
        if (c.type !== 'position' || c.id !== moveId) continue;
        const base = pos.get(c.id);
        if (!base) continue;
        if (c.position) {
          dragRef.current = { ids: moving, dx: c.position.x - base.x, dy: c.position.y - base.y };
          setDrag(dragRef.current);
        }
        if (c.dragging === false) {
          const d = dragRef.current;
          dragRef.current = null;
          setDrag(null);
          if (d && (d.dx || d.dy)) {
            setNodes(nodes.map((n) => (n.id === c.id ? { ...n, dx: Math.round((n.dx ?? 0) + d.dx), dy: Math.round((n.dy ?? 0) + d.dy) } : n)));
          }
        }
      }
    },
    [moveId, pos, moving, nodes, setNodes],
  );

  const hasManual = nodes.some((n) => n.dx || n.dy);
  const resetLayout = () => setNodes(nodes.map(({ dx: _dx, dy: _dy, ...n }) => n));
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

  // Подгонка вида — только при смене числа блоков или направления (объект flow нестабилен,
  // поэтому держим его в ref, иначе вид «уезжает» при каждой перерисовке и во время перетаскивания).
  const flowRef = useRef(flow);
  flowRef.current = flow;
  useEffect(() => {
    const t = setTimeout(() => flowRef.current.fitView({ ...FIT, duration: 400 }), 80);
    return () => clearTimeout(t);
  }, [nodes.length, dir]);

  // Однократный ремонт текста, испорченного неверной кодировкой (версия от 24.11).
  useEffect(() => {
    if (!draft) return;
    const d = draft.data;
    const broken =
      looksBroken(draft.title) ||
      (d.categories ?? []).some((c) => looksBroken(c.name)) ||
      d.nodes.some((n) => looksBroken(n.label) || looksBroken(n.note));
    if (!broken) return;
    update({
      title: repairText(draft.title),
      data: {
        ...d,
        categories: d.categories?.map((c) => ({ ...c, name: repairText(c.name) })),
        nodes: d.nodes.map((n) => ({ ...n, label: repairText(n.label), note: n.note ? repairText(n.note) : n.note })),
      },
    });
  }, [draft, update]);

  const sel = nodes.find((n) => n.id === selected);
  const patchNode = (id: string, patch: Partial<TreeNode>) => setNodes(nodes.map((n) => (n.id === id ? { ...n, ...patch } : n)));

  const focusTitle = () => setTimeout(() => (document.getElementById('tree-label') as HTMLInputElement | null)?.select(), 60);

  const addChild = (parentId: string | null) => {
    const parent = nodes.find((n) => n.id === parentId);
    const n: TreeNode = { id: uid(), parentId, label: 'Новый блок', category: parent?.category };
    setNodes([...nodes, n]);
    setSelected(n.id);
    focusTitle();
  };

  const addSibling = () => {
    if (!sel) return addChild(null);
    if (!sel.parentId) return addChild(sel.id);
    const n: TreeNode = { id: uid(), parentId: sel.parentId, label: 'Новый блок', category: sel.category };
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
    if (doomed.size > 1 && !(await confirmAction(`Удалить «${sel.label}»?`, `Вместе с ним удалятся вложенные блоки: ${doomed.size - 1}.`))) return;
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

  // Путь от корня до выбранного блока.
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
            <ArrowDownFromLine size={15} /> Сверху вниз
          </button>
          <button className={cx(dir === 'LR' && styles.segOn)} onClick={() => setTree({ direction: 'LR' })}>
            <ArrowRightFromLine size={15} /> Слева направо
          </button>
        </div>
        <button className="btn sm" onClick={() => setCatsOpen(true)}>
          <Tags size={15} /> Категории
        </button>
        <button className="btn sm" onClick={() => setImporting(true)}>
          <FileInput size={15} /> Из текста
        </button>
        {hasManual && (
          <button className="btn sm icon ghost" onClick={resetLayout} title="Сбросить расположение: вернуть автоматическую раскладку блоков">
            <RotateCcw size={15} />
          </button>
        )}
        <div className={styles.spacer} />
        <span className={cx(styles.status, styles[status])}>{STATUS_TEXT[status]}</span>
        <span className={styles.edited}>
          {users[board.updatedBy ?? 0]?.nickname} · {formatDateTime(board.updatedAt)}
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
                title="Подсветить блоки этой категории"
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
            minZoom={0.15}
            nodesConnectable={false}
            proOptions={{ hideAttribution: true }}
            onNodesChange={onNodesChange}
            zoomOnDoubleClick={false}
            onNodeClick={(_, n) => {
              setSelected(n.id);
              if (moveId && n.id !== moveId) setMoveId(null);
            }}
            onNodeDoubleClick={(_, n) => {
              setSelected(n.id);
              setMoveId((m) => (m === n.id ? null : n.id));
            }}
            onPaneClick={() => {
              setSelected(null);
              setMoveId(null);
            }}
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
          {moveId && (
            <div className={styles.moveHint}>
              <Move size={14} /> Перетащите «{nodes.find((n) => n.id === moveId)?.label}» — ветка двинется вместе с ним. Двойной клик — готово.
            </div>
          )}
          {!nodes.length && (
            <div className={styles.emptyCanvas}>
              <button className="btn primary" onClick={() => addChild(null)}>
                <Plus size={15} /> Первый блок
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
                <span className="label">Категория</span>
                <div className={styles.catPick}>
                  <button className={cx(styles.catChip, !sel.category && styles.catChipOn)} onClick={() => patchNode(sel.id, { category: undefined })}>
                    Без категории
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
                <span className="label">Название</span>
                <input
                  id="tree-label"
                  className={styles.bigTitle}
                  value={sel.label}
                  placeholder="Название блока"
                  onChange={(e) => patchNode(sel.id, { label: e.target.value })}
                  onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
                />
              </div>

              <div className={cx(styles.field, styles.grow)}>
                <span className="label">Описание и подробности</span>
                <textarea
                  className={styles.desc}
                  value={sel.note ?? ''}
                  placeholder={'Что это за блок, как работает, что нужно сделать, ссылки, идеи…\n\nПервая строка показывается прямо на схеме.'}
                  onChange={(e) => patchNode(sel.id, { note: e.target.value })}
                />
              </div>

              {selKids.length > 0 && (
                <div className={styles.field}>
                  <span className="label">Вложенные блоки · {selKids.length}</span>
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
                  <CornerDownRight size={14} /> Вложенный
                </button>
                <button className="btn sm" onClick={addSibling}>
                  <Plus size={14} /> Рядом
                </button>
                <div className={styles.spacer} />
                <button className="btn sm icon danger" onClick={removeNode} title="Удалить блок">
                  <Trash2 size={15} />
                </button>
              </div>
            </>
          ) : (
            <div className={styles.overview}>
              <h3>Структура проекта</h3>
              <p className="muted">
                Одно общее дерево на двоих. Нажмите на блок, чтобы увидеть и изменить его категорию, название и подробное описание.
              </p>
              <div className={styles.stats}>
                <div>
                  <strong>{nodes.length}</strong>
                  <span>блоков</span>
                </div>
                <div>
                  <strong>{categories.length}</strong>
                  <span>категорий</span>
                </div>
              </div>
              <button className="btn sm" onClick={() => addChild(null)}>
                <Plus size={14} /> Новая ветка с корня
              </button>
              <div className={styles.keys}>
                <div>
                  <kbd>Tab</kbd> вложенный блок
                </div>
                <div>
                  <kbd>Enter</kbd> блок рядом
                </div>
                <div>
                  <kbd>Del</kbd> удалить ветку
                </div>
                <div>
                  <kbd>2× клик</kbd> переместить блок
                </div>
                <div>
                  <kbd>F2</kbd> переименовать · <kbd>Esc</kbd> снять выбор
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
            if (!parsed.length) return toast('Не нашлось ни одного блока');
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
    const clean = list.map((c) => ({ ...c, name: c.name.trim() || 'Без названия' }));
    const ids = new Set(clean.map((c) => c.id));
    onSave(clean, nodes.map((n) => (n.category && !ids.has(n.category) ? { ...n, category: undefined } : n)));
    onClose();
  };

  return (
    <div className={styles.dialogBackdrop} onMouseDown={onClose}>
      <div className={cx('card', styles.dialog)} onMouseDown={(e) => e.stopPropagation()}>
        <div className={styles.dialogHead}>
          <h3>Категории</h3>
          <button className="btn ghost sm icon" onClick={onClose}>
            <X size={16} />
          </button>
        </div>
        <p className="muted">Например: Программирование, Создание, Генерация, Продумывание. Цвет категории окрашивает блоки.</p>
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
                title={used(c.id) ? `Используется в ${used(c.id)} блоках — они станут без категории` : 'Удалить'}
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
          onClick={() => setList([...list, { id: uid(), name: 'Новая категория', color: PALETTE[list.length % PALETTE.length] }])}
        >
          <Plus size={14} /> Добавить категорию
        </button>
        <div className={styles.dialogActions}>
          <button className="btn ghost" onClick={onClose}>
            Отмена
          </button>
          <button className="btn primary" onClick={save}>
            Сохранить
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
          <h3>Импорт из текста</h3>
          <button className="btn ghost sm icon" onClick={onClose}>
            <X size={16} />
          </button>
        </div>
        <p className="muted">Отступы или символы ├── └── │ задают вложенность — можно вставить дерево прямо из документа.</p>
        <textarea className={cx('input', styles.importArea)} value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} />
        <div className={styles.dialogActions}>
          <button className="btn ghost" onClick={onClose}>
            Отмена
          </button>
          <button className="btn" onClick={() => onImport(text, false)}>
            {hasSelection ? 'Добавить в выбранный блок' : 'Добавить'}
          </button>
          <button className="btn primary" onClick={() => onImport(text, true)}>
            Заменить всё
          </button>
        </div>
      </div>
    </div>
  );
}
