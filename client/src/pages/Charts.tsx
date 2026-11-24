import { BarChart, LineChart, PieChart, RadarChart, ScatterChart } from 'echarts/charts';
import { GridComponent, LegendComponent, RadarComponent, TooltipComponent } from 'echarts/components';
import * as echarts from 'echarts/core';
import { CanvasRenderer } from 'echarts/renderers';
import { AreaChart, BarChart3, ChartLine, ChartPie, Minus, Plus, Radar, ScatterChart as ScatterIcon, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useRef } from 'react';
import { createBoard, deleteBoard, STATUS_TEXT, useBoardEditor } from '../boards';
import { BoardList } from '../components/BoardList';
import { confirmAction, toast, useStore } from '../store';
import type { Board, ChartData } from '../types';
import { cx } from '../util';
import styles from './Editors.module.css';

echarts.use([BarChart, LineChart, PieChart, RadarChart, ScatterChart, GridComponent, LegendComponent, RadarComponent, TooltipComponent, CanvasRenderer]);

const PALETTE = ['#8b6dff', '#3ddc97', '#4f8df7', '#f5b84b', '#f472b6', '#22d3ee', '#fb7185', '#a3e635'];

const TYPES: { id: ChartData['type']; label: string; icon: typeof BarChart3 }[] = [
  { id: 'line', label: 'Линия', icon: ChartLine },
  { id: 'area', label: 'Область', icon: AreaChart },
  { id: 'bar', label: 'Столбцы', icon: BarChart3 },
  { id: 'pie', label: 'Круговая', icon: ChartPie },
  { id: 'radar', label: 'Радар', icon: Radar },
  { id: 'scatter', label: 'Точки', icon: ScatterIcon },
];

const TEMPLATE: ChartData = {
  type: 'line',
  columns: ['Уровень', 'HP игрока', 'Урон врагов'],
  rows: [
    ['1', 100, 8],
    ['2', 120, 11],
    ['3', 145, 15],
    ['4', 175, 20],
    ['5', 210, 27],
    ['6', 250, 35],
  ],
};

const num = (v: string | number) => (typeof v === 'number' ? v : Number(String(v).replace(',', '.')) || 0);

function buildOption(d: ChartData): echarts.EChartsCoreOption {
  const labels = d.rows.map((r) => String(r[0] ?? ''));
  const series = d.columns.slice(1);
  const base = {
    color: PALETTE,
    backgroundColor: 'transparent',
    textStyle: { fontFamily: 'Segoe UI, system-ui, sans-serif', color: '#a4a4b9' },
    tooltip: {
      trigger: d.type === 'pie' || d.type === 'radar' ? 'item' : 'axis',
      backgroundColor: '#14141f',
      borderColor: '#29293b',
      textStyle: { color: '#ececf4' },
    },
    legend: { top: 4, textStyle: { color: '#a4a4b9' }, icon: 'roundRect' },
    animationDuration: 700,
    animationEasing: 'cubicOut' as const,
  };
  if (d.type === 'pie') {
    return {
      ...base,
      series: [
        {
          type: 'pie',
          radius: ['42%', '72%'],
          center: ['50%', '56%'],
          itemStyle: { borderRadius: 8, borderColor: '#0f0f18', borderWidth: 3 },
          label: { color: '#ececf4' },
          data: d.rows.map((r) => ({ name: String(r[0]), value: num(r[1] ?? 0) })),
        },
      ],
    };
  }
  if (d.type === 'radar') {
    const max = Math.max(1, ...d.rows.flatMap((r) => r.slice(1).map(num))) * 1.15;
    return {
      ...base,
      radar: {
        indicator: labels.map((name) => ({ name, max })),
        axisName: { color: '#a4a4b9' },
        splitLine: { lineStyle: { color: '#29293b' } },
        splitArea: { areaStyle: { color: ['transparent'] } },
        axisLine: { lineStyle: { color: '#29293b' } },
      },
      series: [
        {
          type: 'radar',
          areaStyle: { opacity: 0.2 },
          data: series.map((name, j) => ({ name, value: d.rows.map((r) => num(r[j + 1] ?? 0)) })),
        },
      ],
    };
  }
  const axis = { axisLine: { lineStyle: { color: '#29293b' } }, splitLine: { lineStyle: { color: '#1c1c2a' } } };
  return {
    ...base,
    grid: { left: 48, right: 24, top: 44, bottom: 32 },
    xAxis: { type: 'category', data: labels, boundaryGap: d.type === 'bar', ...axis },
    yAxis: { type: 'value', ...axis },
    series: series.map((name, j) => ({
      name,
      type: d.type === 'area' ? 'line' : d.type,
      smooth: d.type === 'line' || d.type === 'area',
      symbolSize: d.type === 'scatter' ? 12 : 7,
      barMaxWidth: 36,
      itemStyle: d.type === 'bar' ? { borderRadius: [6, 6, 0, 0] } : undefined,
      areaStyle:
        d.type === 'area'
          ? {
              opacity: 1,
              color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
                { offset: 0, color: PALETTE[j % PALETTE.length] + '66' },
                { offset: 1, color: PALETTE[j % PALETTE.length] + '00' },
              ]),
            }
          : undefined,
      data: d.rows.map((r) => num(r[j + 1] ?? 0)),
    })),
  };
}

function EChart({ data }: { data: ChartData }) {
  const ref = useRef<HTMLDivElement>(null);
  const chart = useRef<echarts.ECharts>();
  const option = useMemo(() => buildOption(data), [data]);

  useEffect(() => {
    chart.current = echarts.init(ref.current!, undefined, { renderer: 'canvas' });
    const ro = new ResizeObserver(() => chart.current?.resize());
    ro.observe(ref.current!);
    return () => {
      ro.disconnect();
      chart.current?.dispose();
    };
  }, []);

  useEffect(() => {
    chart.current?.setOption(option, { notMerge: true });
  }, [option]);

  return <div ref={ref} />;
}

export function Charts() {
  const openId = useStore((s) => s.openBoard.chart);
  const board = useStore((s) => (openId ? s.boards[openId] : undefined)) as Board<ChartData> | undefined;

  const create = async () => {
    try {
      await createBoard<ChartData>('chart', 'Новый график', TEMPLATE);
    } catch (e) {
      toast((e as Error).message);
    }
  };

  return (
    <div className={cx(styles.page, 'page-enter')}>
      <BoardList kind="chart" title="Графики" newLabel="Новый" icon={<BarChart3 size={17} />} onCreate={create} />
      {board ? (
        <ChartEditor key={board.id} board={board} />
      ) : (
        <section className={cx('card', styles.placeholder)}>
          <BarChart3 size={52} strokeWidth={1.1} />
          <h2>Graph Studio</h2>
          <p>Баланс, прогрессия, экономика, статистика — графики видны обоим и обновляются у напарника сразу после правки.</p>
          <button className="btn primary" onClick={create}>
            Создать график
          </button>
        </section>
      )}
    </div>
  );
}

function ChartEditor({ board }: { board: Board<ChartData> }) {
  const { draft, update, status } = useBoardEditor<ChartData>(board);
  if (!draft) return null;
  const d = draft.data;
  const setData = (patch: Partial<ChartData>) => update({ data: { ...d, ...patch } });

  const setCell = (ri: number, ci: number, value: string) => {
    const rows = d.rows.map((r) => [...r]);
    rows[ri][ci] = ci === 0 ? value : value === '' ? '' : (value as unknown as number);
    setData({ rows });
  };
  const setColumn = (ci: number, value: string) => setData({ columns: d.columns.map((c, i) => (i === ci ? value : c)) });
  const addRow = () => setData({ rows: [...d.rows, [String(d.rows.length + 1), ...d.columns.slice(1).map(() => 0)]] });
  const delRow = (ri: number) => setData({ rows: d.rows.filter((_, i) => i !== ri) });
  const addCol = () =>
    setData({ columns: [...d.columns, `Серия ${d.columns.length}`], rows: d.rows.map((r) => [...r, 0]) });
  const delCol = (ci: number) =>
    setData({ columns: d.columns.filter((_, i) => i !== ci), rows: d.rows.map((r) => r.filter((_, i) => i !== ci)) });

  const remove = async () => {
    if (!(await confirmAction(`Удалить «${board.title}»?`, 'График исчезнет у обоих участников.'))) return;
    deleteBoard(board).catch((e) => toast(e.message));
  };

  return (
    <section className={cx('card', styles.editor)}>
      <div className={styles.toolbar}>
        <input className={styles.titleInput} value={draft.title} onChange={(e) => update({ title: e.target.value })} />
        <div className={styles.segment}>
          {TYPES.map((t) => (
            <button key={t.id} className={cx(d.type === t.id && styles.segOn)} onClick={() => setData({ type: t.id })} title={t.label}>
              <t.icon size={15} /> {t.label}
            </button>
          ))}
        </div>
        <span className={cx(styles.status, styles[status])}>{STATUS_TEXT[status]}</span>
        <div className={styles.spacer} />
        <button className="btn sm icon ghost danger" onClick={remove} title="Удалить">
          <Trash2 size={16} />
        </button>
      </div>

      <div className={styles.chartLayout}>
        <div className={styles.chartCanvas}>
          <EChart data={d} />
        </div>
        <div className={styles.table}>
          <table>
            <thead>
              <tr>
                {d.columns.map((c, ci) => (
                  <th key={ci}>
                    <div className={styles.colHead}>
                      {ci > 0 && <span className={styles.colDot} style={{ background: PALETTE[(ci - 1) % PALETTE.length] }} />}
                      <input value={c} onChange={(e) => setColumn(ci, e.target.value)} />
                      {ci > 0 && d.columns.length > 2 && (
                        <button className={styles.mini} onClick={() => delCol(ci)} title="Удалить серию">
                          <Minus size={13} />
                        </button>
                      )}
                    </div>
                  </th>
                ))}
                <th />
              </tr>
            </thead>
            <tbody>
              {d.rows.map((r, ri) => (
                <tr key={ri}>
                  {d.columns.map((_, ci) => (
                    <td key={ci}>
                      <input
                        className={cx(ci > 0 && styles.num)}
                        value={String(r[ci] ?? '')}
                        inputMode={ci > 0 ? 'decimal' : undefined}
                        onChange={(e) => setCell(ri, ci, e.target.value)}
                      />
                    </td>
                  ))}
                  <td>
                    <button className={styles.mini} onClick={() => delRow(ri)} title="Удалить строку">
                      <Trash2 size={13} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className={styles.tableActions}>
            <button className="btn sm" onClick={addRow}>
              <Plus size={14} /> Строка
            </button>
            <button className="btn sm" onClick={addCol}>
              <Plus size={14} /> Серия
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}
