'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { loadPlateDayKline, loadPlateMembers, type PlateDayBar, type PlateMember } from '@/lib/market/api';
import type { MarketTrendPanelData, MarketTrendStage, MarketTrendTopic } from '@/lib/market/types';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

type SectorTrendTrajectoryProps = {
  data: MarketTrendPanelData;
  onSelectStock?: (code: string, name: string) => void;
  refreshToken?: number;
};

type MemberSortKey = 'rank' | 'changePercent' | 'amount' | 'turnoverRate';

type TrendMember = {
  rank: number;
  code: string;
  name: string;
  changePercent: number;
  amount: number;
  netFlow: number;
  turnoverRate: number;
  status?: string;
  limitAnalysis?: string;
  limitPlate?: string;
};

type TopicHistoryPoint = {
  date: string;
  expmaValue: number;
  expmaDeltaPct: number;
  strengthScore: number;
  pct: number;
  open: number;
  high: number;
  low: number;
  close: number;
};

const SVG_WIDTH = 1000;
const SVG_HEIGHT = 372;
const PAD = { top: 20, right: 112, bottom: 34, left: 44 };
const Y_TICKS = [0, 35, 55, 75, 100];
const PHASE_STYLES: Record<MarketTrendStage, string> = {
  主升: 'bg-rose-100 text-rose-700 dark:bg-rose-950/40 dark:text-rose-200',
  发酵: 'bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-200',
  分歧: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-950/40 dark:text-yellow-200',
  震荡: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-200',
  退潮: 'bg-sky-100 text-sky-700 dark:bg-sky-950/40 dark:text-sky-200',
  冷却: 'bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-200',
};

const FLOW_META = {
  in: {
    label: '净流入',
    badge: 'bg-rose-50 text-rose-600 dark:bg-rose-950/20 dark:text-rose-300',
  },
  out: {
    label: '净流出',
    badge: 'bg-emerald-50 text-emerald-600 dark:bg-emerald-950/20 dark:text-emerald-300',
  },
} as const;

function shortDate(value: string) {
  if (!value || value.length < 8) return value;
  return `${value.slice(5, 7)}-${value.slice(8, 10)}`;
}

function formatPercent(value: number, digits = 2) {
  const amount = Number.isFinite(value) ? value : 0;
  return `${amount >= 0 ? '+' : ''}${amount.toFixed(digits)}%`;
}

function formatSignedYi(value: number) {
  const amount = Number.isFinite(value) ? value : 0;
  return `${amount >= 0 ? '+' : ''}${amount.toFixed(1)}亿`;
}

function formatYi(value: number) {
  const amount = Number.isFinite(value) ? value : 0;
  return `${amount.toFixed(1)}亿`;
}

function formatRatio(value: number) {
  if (!Number.isFinite(value)) return '--';
  return `${Math.round(value * 100)}%`;
}

function boardHeightLabel(lbc: number) {
  if (lbc <= 1) return '首板';
  return `${lbc}板`;
}

function yForStrength(value: number) {
  const plotHeight = SVG_HEIGHT - PAD.top - PAD.bottom;
  return PAD.top + ((100 - value) / 100) * plotHeight;
}

function barBaseY() {
  return SVG_HEIGHT - PAD.bottom;
}

function barTopFor(value: number) {
  return yForStrength(value);
}

function xFor(index: number, total: number) {
  const plotWidth = SVG_WIDTH - PAD.left - PAD.right;
  if (total <= 1) return PAD.left + plotWidth / 2;
  return PAD.left + (plotWidth * index) / (total - 1);
}

function stageForScore(score: number): MarketTrendStage {
  if (score >= 75) return '主升';
  if (score >= 55) return '发酵';
  if (score >= 35) return '震荡';
  return '退潮';
}

function calcExpma(values: number[], period = 3) {
  if (values.length === 0) return [];
  const alpha = 2 / (period + 1);
  const result: number[] = [values[0]];
  for (let i = 1; i < values.length; i += 1) {
    result.push(alpha * values[i] + (1 - alpha) * result[i - 1]);
  }
  return result;
}

function buildExpmaDomain(series: TopicHistoryPoint[][]) {
  const values = series.flatMap((points) => points.map((point) => point.expmaDeltaPct).filter((value) => Number.isFinite(value)));
  if (values.length === 0) return { min: -1, max: 1 };
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (min === max) {
    const padding = Math.max(0.4, Math.abs(min) * 0.2);
    return { min: min - padding, max: max + padding };
  }
  const padding = (max - min) * 0.08;
  return { min: min - padding, max: max + padding };
}

function buildNumericTicks(min: number, max: number, count = 5) {
  if (!Number.isFinite(min) || !Number.isFinite(max) || count <= 1) return [min, max];
  return Array.from({ length: count }, (_, index) => min + ((max - min) * index) / (count - 1));
}

function buildTopicHistory(bars: PlateDayBar[], topic: MarketTrendTopic): TopicHistoryPoint[] {
  if (bars.length === 0) {
    return [
      {
        date: topic.date,
        expmaValue: 0,
        expmaDeltaPct: 0,
        strengthScore: topic.score,
        pct: topic.changePct,
        open: 0,
        high: 0,
        low: 0,
        close: 0,
      },
    ];
  }
  const closes = bars.map((bar) => bar.close);
  const expma = calcExpma(closes, 3);
  const baseline = expma.reduce((sum, value) => sum + value, 0) / Math.max(expma.length, 1);
  return bars.map((bar, index) => {
    const expmaValue = expma[index] || bar.close || 0;
    const expmaDeltaPct = baseline > 0 ? ((expmaValue - baseline) / baseline) * 100 : 0;
    const strengthScore = Math.max(0, Math.min(100, 50 + bar.pct * 4));
    return {
      date: `${bar.date.slice(0, 4)}-${bar.date.slice(4, 6)}-${bar.date.slice(6, 8)}`,
      expmaValue,
      expmaDeltaPct,
      strengthScore,
      pct: bar.pct,
      open: bar.open,
      high: bar.high,
      low: bar.low,
      close: bar.close,
    };
  });
}

function linePath(points: TopicHistoryPoint[], yForExpma: (value: number) => number) {
  return points
    .map((point, index) => `${index === 0 ? 'M' : 'L'} ${xFor(index, points.length).toFixed(1)} ${yForExpma(point.expmaDeltaPct).toFixed(1)}`)
    .join(' ');
}

function endLabelPosition(index: number, values: Array<{ id: string; y: number }>) {
  const sorted = [...values].sort((a, b) => a.y - b.y);
  const gap = 14;
  for (let i = 1; i < sorted.length; i += 1) {
    if (sorted[i].y - sorted[i - 1].y < gap) {
      sorted[i].y = sorted[i - 1].y + gap;
    }
  }
  for (let i = sorted.length - 2; i >= 0; i -= 1) {
    if (sorted[i + 1].y > SVG_HEIGHT - PAD.bottom) {
      sorted[i + 1].y = SVG_HEIGHT - PAD.bottom;
    }
    if (sorted[i + 1].y - sorted[i].y < gap) {
      sorted[i].y = sorted[i + 1].y - gap;
    }
  }
  return sorted.find((item) => item.id === values[index].id)?.y ?? values[index].y;
}

export default function SectorTrendTrajectory({ data, onSelectStock, refreshToken = 0 }: SectorTrendTrajectoryProps) {
  const topics = useMemo(() => data.topics || [], [data.topics]);
  const [selectedId, setSelectedId] = useState<string | null>(topics[0]?.id ?? null);
  const [histories, setHistories] = useState<Record<string, TopicHistoryPoint[]>>({});
  const [membersById, setMembersById] = useState<Record<string, TrendMember[]>>({});
  const [sortBy, setSortBy] = useState<{ key: MemberSortKey; dir: 'asc' | 'desc' }>({ key: 'rank', dir: 'asc' });
  const [hover, setHover] = useState<{ topicId: string; pointIndex: number } | null>(null);

  useEffect(() => {
    if (topics.length === 0) {
      setSelectedId(null);
      return;
    }
    if (!selectedId || !topics.some((topic) => topic.id === selectedId)) {
      setSelectedId(topics[0].id);
    }
  }, [selectedId, topics]);

  useEffect(() => {
    if (refreshToken === 0) return;
    setHistories({});
    setMembersById({});
    setHover(null);
  }, [refreshToken]);

  useEffect(() => {
    const missing = topics.filter((topic) => !histories[topic.id]).map((topic) => topic.id);
    if (missing.length === 0) return;
    let active = true;
    Promise.all(missing.map((id) => loadPlateDayKline(id, data.range || 20)))
      .then((results) => {
        if (!active) return;
        setHistories((current) => {
          const next = { ...current };
          missing.forEach((id, index) => {
            const topic = topics.find((item) => item.id === id);
            if (!topic) return;
            next[id] = buildTopicHistory(results[index], topic);
          });
          return next;
        });
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [data.range, histories, refreshToken, topics]);

  useEffect(() => {
    if (!selectedId || membersById[selectedId]) return;
    let active = true;
    loadPlateMembers(selectedId)
      .then((members) => {
        if (!active) return;
        setMembersById((current) => ({
          ...current,
          [selectedId]: members.map((item: PlateMember, index) => ({
            rank: index + 1,
            code: item.code,
            name: item.name,
            changePercent: item.change,
            amount: item.amount,
            netFlow: item.netFlow,
            turnoverRate: item.turnoverRate,
            status: data.stockTags[item.code]?.status,
            limitAnalysis: data.stockTags[item.code]?.analysis,
            limitPlate: data.stockTags[item.code]?.plate,
          })),
        }));
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [data.stockTags, membersById, refreshToken, selectedId]);

  const selectedTopic = topics.find((topic) => topic.id === selectedId) || topics[0] || null;
  const activeHistory = selectedTopic
    ? histories[selectedTopic.id] || [
        {
          date: selectedTopic.date,
          expmaValue: 0,
          expmaDeltaPct: 0,
          strengthScore: selectedTopic.score,
          pct: selectedTopic.changePct,
          open: 0,
          high: 0,
          low: 0,
          close: 0,
        },
      ]
    : [];
  const inflowTopics = topics.filter((topic) => topic.flow === 'in');
  const outflowTopics = topics.filter((topic) => topic.flow === 'out');

  const chartTopics = useMemo(
    () =>
      topics.map((topic) => ({
        topic,
        points:
          histories[topic.id] || [
            {
              date: topic.date,
              expmaValue: 0,
              expmaDeltaPct: 0,
              strengthScore: topic.score,
              pct: topic.changePct,
              open: 0,
              high: 0,
              low: 0,
              close: 0,
            },
          ],
      })),
    [histories, topics]
  );

  const expmaDomain = useMemo(() => buildExpmaDomain(chartTopics.map((item) => item.points)), [chartTopics]);
  const expmaTicks = useMemo(() => buildNumericTicks(expmaDomain.min, expmaDomain.max), [expmaDomain]);
  const yForExpma = (value: number) => {
    const plotHeight = SVG_HEIGHT - PAD.top - PAD.bottom;
    const safeValue = Number.isFinite(value) ? value : expmaDomain.min;
    return PAD.top + ((expmaDomain.max - safeValue) / (expmaDomain.max - expmaDomain.min)) * plotHeight;
  };

  const xLabels = activeHistory.map((point) => point.date);

  const endPoints = chartTopics.map(({ topic, points }) => ({
    id: topic.id,
    y: yForExpma(points[points.length - 1]?.expmaDeltaPct ?? 0),
  }));

  const sortedMembers = useMemo(() => {
    const values = [...(membersById[selectedId || ''] || [])];
    values.sort((a, b) => {
      const left = a[sortBy.key];
      const right = b[sortBy.key];
      const delta = Number(left) - Number(right);
      return sortBy.dir === 'asc' ? delta : -delta;
    });
    return values;
  }, [membersById, selectedId, sortBy]);

  function toggleSort(key: MemberSortKey) {
    setSortBy((current) => (current.key === key ? { key, dir: current.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'desc' }));
  }

  if (topics.length === 0) {
    return (
      <div className="rounded-[24px] border border-dashed border-border/70 bg-background/35 px-5 py-10 text-center text-sm text-muted-foreground">
        暂无趋势题材数据
      </div>
    );
  }

  const hoverTopic = hover ? chartTopics.find((item) => item.topic.id === hover.topicId) : null;
  const hoverPoint = hover && hoverTopic ? hoverTopic.points[hover.pointIndex] : null;

  return (
    <section className="overflow-hidden rounded-[24px] border border-border/70 bg-background/70">
      <div className="border-b border-border/60 px-5 py-3.5">
        <div className="mb-2.5">
          <div className="text-sm font-semibold text-foreground">题材趋势</div>
          <div className="mt-1 text-xs text-muted-foreground">
            多题材趋势对比，点击题材切换下方个股明细。强度分 = 涨跌幅 25% + 上涨占比 20% + 涨停占比 25% + 成交额变化 10% + 资金流 20%。
          </div>
        </div>
        <div className="space-y-2">
          {([
            ['资金流入 Top5', inflowTopics],
            ['资金流出 Top5', outflowTopics],
          ] as const).map(([groupLabel, groupTopics]) =>
            groupTopics.length > 0 ? (
              <div key={groupLabel} className="flex flex-wrap items-center gap-2.5">
                <span className="text-xs font-medium text-muted-foreground">{groupLabel}</span>
                {groupTopics.map((topic) => {
                  const active = topic.id === selectedTopic?.id;
                  return (
                    <button
                      key={topic.id}
                      type="button"
                      onClick={() => setSelectedId(topic.id)}
                      className={cn(
                        'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium transition-colors',
                        active ? 'border-orange-300/90 bg-orange-50/85 text-orange-700 dark:border-orange-700 dark:bg-orange-950/20 dark:text-orange-200' : 'border-border/70 bg-background/65 text-muted-foreground hover:text-foreground'
                      )}
                    >
                      <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: topic.color }} />
                      <span>{topic.name}</span>
                    </button>
                  );
                })}
              </div>
            ) : null
          )}
        </div>
      </div>

      <div className="p-4">
        <div className="overflow-hidden rounded-[24px] border border-border/70 bg-background/65">
          <div className="relative overflow-x-auto">
            <svg viewBox={`0 0 ${SVG_WIDTH} ${SVG_HEIGHT}`} className="min-w-[980px] w-full" onMouseLeave={() => setHover(null)}>
              <rect x={PAD.left} y={PAD.top} width={SVG_WIDTH - PAD.left - PAD.right} height={yForStrength(75) - PAD.top} fill="rgba(255,110,128,0.04)" rx="24" />
              <rect x={PAD.left} y={yForStrength(75)} width={SVG_WIDTH - PAD.left - PAD.right} height={yForStrength(55) - yForStrength(75)} fill="rgba(251,146,60,0.045)" rx="24" />
              <rect x={PAD.left} y={yForStrength(55)} width={SVG_WIDTH - PAD.left - PAD.right} height={yForStrength(35) - yForStrength(55)} fill="rgba(250,204,21,0.04)" rx="24" />
              <rect x={PAD.left} y={yForStrength(35)} width={SVG_WIDTH - PAD.left - PAD.right} height={barBaseY() - yForStrength(35)} fill="rgba(148,163,184,0.04)" rx="24" />

              <text x={PAD.left + 10} y={PAD.top + 14} fontSize="9" fill="currentColor" opacity="0.46">主升区</text>
              <text x={PAD.left + 10} y={yForStrength(75) + 14} fontSize="9" fill="currentColor" opacity="0.42">强势区</text>
              <text x={PAD.left + 10} y={yForStrength(55) + 14} fontSize="9" fill="currentColor" opacity="0.38">观察区</text>
              <text x={PAD.left + 10} y={yForStrength(35) + 14} fontSize="9" fill="currentColor" opacity="0.36">冷却区</text>

              {Y_TICKS.map((value) => (
                <g key={value}>
                  <line x1={PAD.left} y1={yForStrength(value)} x2={SVG_WIDTH - PAD.right} y2={yForStrength(value)} stroke="rgba(148,163,184,0.18)" strokeDasharray="5 8" />
                  <text x={10} y={yForStrength(value) + 4} fontSize="9" fill="currentColor" opacity="0.52">
                    {value}
                  </text>
                </g>
              ))}

              {expmaTicks.map((value) => (
                <g key={`expma-${value.toFixed(4)}`}>
                  <text x={SVG_WIDTH - PAD.right + 12} y={yForExpma(value) + 4} fontSize="9" fill="#64748b" opacity="0.82">
                    {`${value >= 0 ? '+' : ''}${value.toFixed(1)}%`}
                  </text>
                </g>
              ))}

              {xLabels.map((label, index) => (
                <g key={label}>
                  <line x1={xFor(index, xLabels.length)} y1={PAD.top} x2={xFor(index, xLabels.length)} y2={SVG_HEIGHT - PAD.bottom} stroke="rgba(148,163,184,0.08)" />
                  {(index === 0 || index === xLabels.length - 1 || index % 4 === 0) && (
                    <text x={xFor(index, xLabels.length)} y={SVG_HEIGHT - 14} textAnchor="middle" fontSize="9" fill="currentColor" opacity="0.56">
                      {shortDate(label)}
                    </text>
                  )}
                </g>
              ))}

              {selectedTopic && activeHistory.length > 0
                ? activeHistory.map((point, index) => {
                    const width = Math.max(7, (SVG_WIDTH - PAD.left - PAD.right) / Math.max(activeHistory.length, 20) - 10);
                    const x = xFor(index, activeHistory.length) - width / 2;
                    const active = hover?.topicId === selectedTopic.id && hover.pointIndex === index;
                    return (
                      <rect
                        key={`bar-${point.date}`}
                        x={x}
                        y={barTopFor(point.strengthScore)}
                        width={width}
                        height={barBaseY() - barTopFor(point.strengthScore)}
                        rx="4"
                        fill={selectedTopic.color}
                        fillOpacity={active ? 0.24 : 0.1}
                        stroke={active ? 'rgba(255,255,255,0.75)' : 'none'}
                        strokeWidth={active ? 1 : 0}
                      />
                    );
                  })
                : null}

              {chartTopics.map(({ topic, points }) => {
                const active = topic.id === selectedTopic?.id;
                const path = linePath(points, yForExpma);
                return (
                  <g key={topic.id}>
                    <path
                      d={path}
                      fill="none"
                      stroke={topic.color}
                      strokeWidth={active ? 3.2 : 1.5}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeDasharray={active ? undefined : topic.flow === 'out' ? '10 10' : undefined}
                      opacity={active ? 0.98 : 0.22}
                    />
                    {points.map((point, index) => {
                      const isHover = hover?.topicId === topic.id && hover.pointIndex === index;
                      return (
                        <g key={`${topic.id}-${point.date}`}>
                          <circle
                            cx={xFor(index, points.length)}
                            cy={yForExpma(point.expmaDeltaPct)}
                            r={active ? (index === points.length - 1 ? 6.6 : 4.2) : 2.8}
                            fill={topic.color}
                            fillOpacity={active ? 1 : 0.42}
                            stroke="white"
                            strokeWidth={isHover || active ? 1.5 : 1}
                            onMouseEnter={() => setHover({ topicId: topic.id, pointIndex: index })}
                            onClick={() => setSelectedId(topic.id)}
                          />
                        </g>
                      );
                    })}
                  </g>
                );
              })}

              {chartTopics.map(({ topic }, index) => {
                const active = topic.id === selectedTopic?.id;
                const y = endLabelPosition(index, endPoints);
                return (
                  <g key={`${topic.id}-label`} onClick={() => setSelectedId(topic.id)}>
                    <text
                      x={SVG_WIDTH - PAD.right + 12}
                      y={y}
                      fontSize={active ? 11 : 10}
                      fill={topic.color}
                      opacity={active ? 1 : 0.34}
                      fontWeight={active ? 700 : 500}
                    >
                      {topic.name}
                    </text>
                  </g>
                );
              })}
            </svg>

            {hoverPoint && hoverTopic ? (
              <div className="pointer-events-none absolute right-3 top-3 rounded-2xl border border-border/70 bg-background px-3.5 py-3 text-xs shadow-[0_12px_28px_rgba(15,23,42,0.12)]">
                <div className="font-medium text-foreground">{hoverTopic.topic.name}</div>
                <div className="mt-1 text-muted-foreground">{hoverPoint.date}</div>
                <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5">
                  <div className="text-muted-foreground">EXPMA(3)</div>
                  <div className="text-right text-foreground">{hoverPoint.expmaValue.toFixed(2)}</div>
                  <div className="text-muted-foreground">偏离率</div>
                  <div className="text-right text-foreground">{formatPercent(hoverPoint.expmaDeltaPct, 1)}</div>
                  <div className="text-muted-foreground">日强度</div>
                  <div className="text-right text-foreground">{hoverPoint.strengthScore.toFixed(1)}</div>
                  <div className="text-muted-foreground">当日涨跌</div>
                  <div className={cn('text-right', hoverPoint.pct >= 0 ? 'text-rose-600' : 'text-emerald-600')}>{formatPercent(hoverPoint.pct)}</div>
                  <div className="text-muted-foreground">阶段</div>
                  <div className="text-right text-muted-foreground">{stageForScore(hoverPoint.strengthScore)}</div>
                </div>
                <div className="mt-3 border-t border-border/60 pt-2.5">
                  <div className="mb-1 text-[11px] uppercase tracking-[0.16em] text-muted-foreground">Daily K</div>
                  <div className="grid grid-cols-2 gap-x-4 gap-y-1.5">
                    <div className="text-muted-foreground">开</div>
                    <div className="text-right text-foreground">{hoverPoint.open.toFixed(2)}</div>
                    <div className="text-muted-foreground">高</div>
                    <div className="text-right text-foreground">{hoverPoint.high.toFixed(2)}</div>
                    <div className="text-muted-foreground">低</div>
                    <div className="text-right text-foreground">{hoverPoint.low.toFixed(2)}</div>
                    <div className="text-muted-foreground">收</div>
                    <div className="text-right text-foreground">{hoverPoint.close.toFixed(2)}</div>
                  </div>
                </div>
              </div>
            ) : null}
          </div>
        </div>
      </div>

      {selectedTopic ? (
        <div className="border-t border-border/60 px-5 py-4">
          <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-3">
                <span className="h-3.5 w-3.5 rounded-full" style={{ backgroundColor: selectedTopic.color }} />
                <div className="text-lg font-semibold text-foreground">
                  {selectedTopic.name} · {selectedTopic.date}
                </div>
              </div>
              <div className="mt-3 flex flex-wrap gap-2 text-sm">
                <span className={cn('rounded-full px-2.5 py-0.5 font-medium', FLOW_META[selectedTopic.flow].badge)}>
                  {FLOW_META[selectedTopic.flow].label}
                </span>
                <span className={cn('rounded-full px-2.5 py-0.5 font-medium', PHASE_STYLES[selectedTopic.phase])}>{selectedTopic.phase}</span>
                <span className="rounded-full bg-muted/30 px-2.5 py-0.5 text-muted-foreground">趋势强度 {selectedTopic.score.toFixed(1)}</span>
                <span className={cn('rounded-full px-2.5 py-0.5', selectedTopic.changePct >= 0 ? 'bg-rose-50 text-rose-600 dark:bg-rose-950/30 dark:text-rose-300' : 'bg-emerald-50 text-emerald-600 dark:bg-emerald-950/30 dark:text-emerald-300')}>
                  阶段涨跌 {formatPercent(selectedTopic.changePct)}
                </span>
              </div>
              {selectedTopic.highlightedStocks.length > 0 ? (
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {selectedTopic.highlightedStocks.map((stock) => (
                    <button
                      key={`${selectedTopic.id}-${stock.code}`}
                      type="button"
                      onClick={() => onSelectStock?.(stock.code, stock.name)}
                      className="inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-muted/20 px-2 py-0.5 text-xs text-foreground hover:border-orange-300 hover:text-orange-600"
                    >
                      <span>{stock.name}</span>
                      <span className="rounded-full bg-orange-100 px-1.5 py-0.5 text-[10px] text-orange-700 dark:bg-orange-950/30 dark:text-orange-300">
                        {boardHeightLabel(stock.lbc)}
                      </span>
                    </button>
                  ))}
                </div>
              ) : null}
            </div>

            <div className="grid w-full gap-3 text-sm sm:grid-cols-3 xl:max-w-[380px]">
              <div>
                <div className="text-muted-foreground">成交额</div>
                <div className="mt-1 text-sm font-semibold text-foreground">{formatYi(selectedTopic.turnover)}</div>
              </div>
              <div>
                <div className="text-muted-foreground">资金流</div>
                <div className={cn('mt-1 text-sm font-semibold', selectedTopic.moneyFlow >= 0 ? 'text-rose-600' : 'text-emerald-600')}>
                  {formatSignedYi(selectedTopic.moneyFlow)}
                </div>
              </div>
              <div>
                <div className="text-muted-foreground">上涨占比</div>
                <div className="mt-1 text-sm font-semibold text-foreground">{formatRatio(selectedTopic.breadth)}</div>
              </div>
            </div>
          </div>

          <div className="mt-4 overflow-hidden rounded-[20px] border border-border/60">
            <div className="max-h-[500px] overflow-auto">
            <table className="w-full text-left">
              <thead className="sticky top-0 bg-muted/20 text-muted-foreground backdrop-blur">
                <tr className="text-sm">
                  <th className="px-5 py-3.5 font-medium">
                    <button type="button" className="hover:text-foreground" onClick={() => toggleSort('rank')}>
                      排名
                    </button>
                  </th>
                  <th className="px-5 py-3.5 font-medium">代码</th>
                  <th className="px-5 py-3.5 font-medium">名称</th>
                  <th className="px-5 py-3.5 font-medium">
                    <button type="button" className="hover:text-foreground" onClick={() => toggleSort('changePercent')}>
                      涨跌幅
                    </button>
                  </th>
                  <th className="px-5 py-3.5 font-medium">
                    <button type="button" className="hover:text-foreground" onClick={() => toggleSort('amount')}>
                      成交额
                    </button>
                  </th>
                  <th className="px-5 py-3.5 font-medium">资金净流入</th>
                  <th className="px-5 py-3.5 font-medium">
                    <button type="button" className="hover:text-foreground" onClick={() => toggleSort('turnoverRate')}>
                      换手率
                    </button>
                  </th>
                </tr>
              </thead>
              <tbody>
                {sortedMembers.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="px-5 py-7 text-center text-sm text-muted-foreground">
                      加载成分股中…
                    </td>
                  </tr>
                ) : (
                  sortedMembers.map((member) => (
                    <tr
                      key={`${selectedTopic.id}-${member.code}`}
                      className="border-t border-border/50 text-sm hover:bg-muted/20"
                    >
                      <td className="px-5 py-3 text-foreground">{member.rank}</td>
                      <td className="px-5 py-3 text-muted-foreground">{member.code}</td>
                      <td className="px-5 py-3 font-medium text-foreground">
                        <button
                          type="button"
                          onClick={() => onSelectStock?.(member.code, member.name)}
                          className="cursor-pointer text-left text-foreground hover:text-orange-600"
                        >
                          {member.name}
                        </button>
                        {member.status ? (
                          <TooltipProvider>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <span className="ml-2 inline-flex rounded-full bg-orange-100 px-2 py-0.5 text-[10px] text-orange-700 dark:bg-orange-950/30 dark:text-orange-300">
                                  {member.status}
                                </span>
                              </TooltipTrigger>
                              <TooltipContent
                                side="top"
                                align="start"
                                sideOffset={8}
                                className="max-w-[280px] rounded-2xl border border-orange-200/55 bg-white/88 px-3 py-2.5 text-[12px] leading-5 text-slate-700 shadow-[0_14px_28px_rgba(15,23,42,0.10)] backdrop-blur-sm dark:border-orange-900/40 dark:bg-slate-950/84 dark:text-slate-200"
                              >
                                <div className="flex items-center gap-2">
                                  <span className="inline-flex rounded-full bg-orange-100/80 px-2 py-0.5 text-[10px] font-semibold text-orange-700 dark:bg-orange-950/30 dark:text-orange-200">
                                    {member.status}
                                  </span>
                                  {member.limitPlate ? (
                                    <span className="text-[11px] text-slate-500/90 dark:text-slate-400">{member.limitPlate}</span>
                                  ) : null}
                                </div>
                                <div className="mt-2 text-[10px] font-medium uppercase tracking-[0.14em] text-slate-400/90 dark:text-slate-500">
                                  涨停分析
                                </div>
                                <div className="mt-1 whitespace-pre-wrap text-[12px] leading-5 text-slate-700/95 dark:text-slate-200">
                                  {member.limitAnalysis || member.limitPlate || '暂无涨停分析'}
                                </div>
                              </TooltipContent>
                            </Tooltip>
                          </TooltipProvider>
                        ) : null}
                      </td>
                      <td className={cn('px-5 py-3 font-medium', member.changePercent >= 0 ? 'text-rose-600' : 'text-emerald-600')}>
                        {formatPercent(member.changePercent)}
                      </td>
                      <td className="px-5 py-3 text-foreground">{formatYi(member.amount)}</td>
                      <td className={cn('px-5 py-3 font-medium', member.netFlow >= 0 ? 'text-rose-600' : 'text-emerald-600')}>
                        {formatSignedYi(member.netFlow)}
                      </td>
                      <td className="px-5 py-3 text-foreground">{member.turnoverRate.toFixed(1)}%</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
