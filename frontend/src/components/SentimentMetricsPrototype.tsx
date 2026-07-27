'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  AlertTriangle,
  BarChart3,
  CalendarRange,
  CircleDollarSign,
  Gauge,
  Flame,
  CalendarDays,
  RefreshCw,
  Target,
  TrendingUp,
} from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card';
import { Button } from './ui/button';
import { Badge } from './ui/badge';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from './ui/dialog';
import { cn } from '@/lib/utils';
import { backfillSentimentRecentDays, getSentimentCalendar, getSentimentMetrics, syncSentimentByDate } from '@/lib/api';
import type { SentimentCalendarDay, SentimentMetricPoint, SentimentMetricsResponse } from '@/types';

type MetricKey = 'ratio' | 'returnRate' | 'count' | 'amount';
type PresetRange = 20 | 40 | 60 | 120;

type SeriesMeta = {
  key: keyof SentimentMetricPoint;
  name: string;
  color: string;
  isPrimary?: boolean;
};

type ChartDotProps = {
  cx?: number;
  cy?: number;
  payload?: SentimentMetricPoint;
};

type MetricConfig = {
  key: MetricKey;
  name: string;
  unit: '%' | '家' | '亿';
  icon: React.ComponentType<{ className?: string }>;
  threshold: number;
  description: string;
  series: SeriesMeta[];
};

type SummaryStats = {
  totalTradingDays: number;
  breakoutCount: number;
  breakoutRatio: number;
  latestBreakoutDate: string | null;
  maxValue: number;
  avgValue: number;
  currentValue: number;
};

const METRIC_CONFIGS: MetricConfig[] = [
  {
    key: 'ratio',
    name: '比率指标(%)',
    unit: '%',
    icon: Gauge,
    threshold: 6.5,
    description: '观察市场核心情绪比率，包含涨停总数占上涨家数比。',
    series: [
      { key: 'advanceRate', name: '涨停晋级率', color: '#3b82f6', isPrimary: true },
      { key: 'breakoutRate', name: '炸板率', color: '#f97316' },
      { key: 'upLimitToRisingRatio', name: '涨停占上涨比', color: '#10b981' },
    ],
  },
  {
    key: 'returnRate',
    name: '收益率(%)',
    unit: '%',
    icon: TrendingUp,
    threshold: 4.2,
    description: '用于观察强势股次日反馈与中位收益波动。',
    series: [
      { key: 'avgReturn', name: '平均收益', color: '#3b82f6', isPrimary: true },
      { key: 'maxReturn', name: '最大收益', color: '#ef4444' },
      { key: 'medianReturn', name: '中位收益', color: '#14b8a6' },
    ],
  },
  {
    key: 'count',
    name: '数量指标',
    unit: '家',
    icon: BarChart3,
    threshold: 42,
    description: '观察不同梯队个股数量变化与突破密集区。',
    series: [
      { key: 'firstBoardCount', name: '首板数量', color: '#3b82f6', isPrimary: true },
      { key: 'secondBoardCount', name: '二板数量', color: '#8b5cf6' },
      { key: 'breakoutCount', name: '炸板个股', color: '#f59e0b' },
    ],
  },
  {
    key: 'amount',
    name: '金额(亿)',
    unit: '亿',
    icon: CircleDollarSign,
    threshold: 180,
    description: '观察成交额与资金强弱，已接入真实市场成交与资金口径。',
    series: [
      { key: 'turnoverAmount', name: '总成交额', color: '#3b82f6', isPrimary: true },
      { key: 'northboundAmount', name: '北向资金', color: '#22c55e' },
      { key: 'mainForceAmount', name: '主力净流入', color: '#f97316' },
    ],
  },
];

const PRESET_RANGES: PresetRange[] = [20, 40, 60, 120];
const BACKFILL_DAY_OPTIONS = [5, 10, 20, 40, 60, 120];
const WEEK_HEADERS = ['一', '二', '三', '四', '五', '六', '日'];

function formatDate(date: Date) {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function parseDate(value: string) {
  return new Date(`${value}T00:00:00`);
}

function shiftDays(date: Date, days: number) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function formatXAxisLabel(value: string) {
  const [, month, day] = value.split('-');
  return `${month}.${day}`;
}

function formatValue(value: number, unit: MetricConfig['unit']) {
  if (unit === '%') return `${value.toFixed(2)}%`;
  if (unit === '亿') return `${value.toFixed(2)}亿`;
  return `${Math.round(value)}家`;
}

function getSummaryStats(points: SentimentMetricPoint[], metricConfig: MetricConfig): SummaryStats {
  const primarySeries = metricConfig.series.find((series) => series.isPrimary) ?? metricConfig.series[0];
  const values = points.map((point) => Number(point[primarySeries.key]));
  const breakoutPoints = points.filter((point) => Number(point[primarySeries.key]) >= metricConfig.threshold);
  const latestBreakout = breakoutPoints.length > 0 ? breakoutPoints[breakoutPoints.length - 1].date : null;
  const total = values.reduce((sum, value) => sum + value, 0);

  return {
    totalTradingDays: points.length,
    breakoutCount: breakoutPoints.length,
    breakoutRatio: points.length > 0 ? (breakoutPoints.length / points.length) * 100 : 0,
    latestBreakoutDate: latestBreakout,
    maxValue: values.length > 0 ? Math.max(...values) : 0,
    avgValue: values.length > 0 ? total / values.length : 0,
    currentValue: values.length > 0 ? values[values.length - 1] : 0,
  };
}

function getCalendarCells(days: SentimentCalendarDay[]) {
  if (days.length === 0) return [];
  const firstDate = parseDate(days[0].date);
  const leading = (firstDate.getDay() + 6) % 7;
  const cells: Array<SentimentCalendarDay | null> = [];
  for (let i = 0; i < leading; i += 1) {
    cells.push(null);
  }
  days.forEach((day) => cells.push(day));
  while (cells.length % 7 !== 0) {
    cells.push(null);
  }
  return cells;
}

function getStatusTone(day: SentimentCalendarDay) {
  if (!day.is_trading_day) return 'border-border bg-muted/20 text-muted-foreground';
  if (day.sync_status === 'success') return 'border-emerald-300 bg-emerald-50 text-emerald-900';
  if (day.sync_status === 'partial') return 'border-amber-300 bg-amber-50 text-amber-900';
  if (day.sync_status === 'failed') return 'border-red-300 bg-red-50 text-red-900';
  return 'border-border bg-background text-foreground';
}

function getStatusLabel(day: SentimentCalendarDay | null) {
  if (!day) return '未抓取';
  if (day.sync_status === 'success') return '已就绪';
  if (day.sync_status === 'partial') return '部分缺失';
  if (day.sync_status === 'failed') return '抓取失败';
  if (day.sync_status === 'non_trading') return '休市';
  return '未抓取';
}

function getStatusVariant(day: SentimentCalendarDay | null): 'success' | 'warning' | 'destructive' | 'outline' {
  if (!day) return 'outline';
  if (day.sync_status === 'success') return 'success';
  if (day.sync_status === 'partial') return 'warning';
  if (day.sync_status === 'failed') return 'destructive';
  return 'outline';
}

export default function SentimentMetricsPrototype() {
  const [metricKey, setMetricKey] = useState<MetricKey>('ratio');
  const [activeRange, setActiveRange] = useState<PresetRange>(120);
  const [metrics, setMetrics] = useState<SentimentMetricsResponse | null>(null);
  const [calendarDays, setCalendarDays] = useState<SentimentCalendarDay[]>([]);
  const [loading, setLoading] = useState(true);
  const [calendarLoading, setCalendarLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [backfilling, setBackfilling] = useState(false);
  const [calendarOpen, setCalendarOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [calendarError, setCalendarError] = useState<string | null>(null);
  const [calendarNotice, setCalendarNotice] = useState<string | null>(null);
  const [selectedDate, setSelectedDate] = useState(formatDate(new Date()));
  const [backfillDays, setBackfillDays] = useState(20);
  const [activeMonth, setActiveMonth] = useState(() => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), 1);
  });

  const metricConfig = useMemo(
    () => METRIC_CONFIGS.find((config) => config.key === metricKey) ?? METRIC_CONFIGS[0],
    [metricKey]
  );

  const loadMetrics = useCallback(async () => {
    setLoading(true);
    setError(null);
    const end = new Date();
    const start = shiftDays(end, -180);
    const response = await getSentimentMetrics(formatDate(start), formatDate(end));
    if (!response.success || !response.data) {
      setError(response.error || '加载情绪指标失败');
      setMetrics(null);
    } else {
      setMetrics(response.data);
    }
    setLoading(false);
  }, []);

  const loadCalendar = useCallback(async (monthDate: Date) => {
    setCalendarLoading(true);
    setCalendarError(null);
    const response = await getSentimentCalendar(monthDate.getFullYear(), monthDate.getMonth() + 1);
    if (!response.success || !response.data) {
      setCalendarError(response.error || '加载情绪数据日历失败');
      setCalendarDays([]);
    } else {
      setCalendarDays(response.data.days);
      setSelectedDate((currentSelectedDate) => {
        if (response.data?.days.find((day) => day.date === currentSelectedDate && day.is_trading_day)) {
          return currentSelectedDate;
        }
        const fallback = response.data?.days.find((day) => day.is_trading_day);
        return fallback?.date ?? currentSelectedDate;
      });
    }
    setCalendarLoading(false);
  }, []);

  useEffect(() => {
    void loadMetrics();
  }, [loadMetrics]);

  useEffect(() => {
    void loadCalendar(activeMonth);
  }, [activeMonth, loadCalendar]);

  const chartData = useMemo(() => {
    const points = metrics?.points ?? [];
    return points.slice(Math.max(0, points.length - activeRange));
  }, [activeRange, metrics]);

  const summary = useMemo(() => getSummaryStats(chartData, metricConfig), [chartData, metricConfig]);

  const primarySeries = useMemo(
    () => metricConfig.series.find((series) => series.isPrimary) ?? metricConfig.series[0],
    [metricConfig]
  );

  const highlightedDates = useMemo(() => {
    return new Set(
      chartData
        .filter((point) => Number(point[primarySeries.key]) >= metricConfig.threshold)
        .map((point) => point.date)
    );
  }, [chartData, metricConfig.threshold, primarySeries]);

  const latestBreakoutLabel = summary.latestBreakoutDate
    ? formatXAxisLabel(summary.latestBreakoutDate)
    : '--';
  const isAboveThreshold = summary.currentValue >= metricConfig.threshold;
  const thresholdGap = summary.currentValue - metricConfig.threshold;

  const chartDomain = useMemo(() => {
    if (chartData.length === 0) return [0, metricConfig.threshold * 1.2];
    const values = chartData.flatMap((point) =>
      metricConfig.series.map((series) => Number(point[series.key]))
    );
    values.push(metricConfig.threshold);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const padding = (max - min || 1) * 0.12;
    return [Math.max(0, min - padding), max + padding];
  }, [chartData, metricConfig]);

  const calendarCells = useMemo(() => getCalendarCells(calendarDays), [calendarDays]);
  const selectedCalendarDay = useMemo(
    () => calendarDays.find((day) => day.date === selectedDate) ?? null,
    [calendarDays, selectedDate]
  );
  const monthTradingDays = useMemo(
    () => calendarDays.filter((day) => day.is_trading_day).length,
    [calendarDays]
  );
  const monthReadyDays = useMemo(
    () => calendarDays.filter((day) => day.sync_status === 'success').length,
    [calendarDays]
  );
  const monthPendingDays = useMemo(
    () => calendarDays.filter((day) => day.is_trading_day && day.sync_status !== 'success').length,
    [calendarDays]
  );

  const handleSyncSelectedDate = async () => {
    if (!selectedDate) return;
    setSyncing(true);
    setCalendarError(null);
    setCalendarNotice(null);
    const response = await syncSentimentByDate(selectedDate, true);
    if (!response.success) {
      setCalendarError(response.error || '触发抓取失败');
    } else {
      setCalendarNotice(response.data?.message || `${selectedDate} 抓取完成`);
      await Promise.all([loadMetrics(), loadCalendar(activeMonth)]);
    }
    setSyncing(false);
  };

  const handleBackfillRecentDays = async () => {
    setBackfilling(true);
    setCalendarError(null);
    setCalendarNotice(null);
    const response = await backfillSentimentRecentDays(backfillDays, false, selectedDate || undefined);
    if (!response.success || !response.data) {
      setCalendarError(response.error || '批量回补失败');
    } else {
      setCalendarNotice(
        `近${backfillDays}个交易日回补完成，新增 ${response.data.success_count} 天，跳过 ${response.data.skipped_count} 天，失败 ${response.data.failed_count} 天`
      );
      await Promise.all([loadMetrics(), loadCalendar(activeMonth)]);
    }
    setBackfilling(false);
  };

  const monthLabel = `${activeMonth.getFullYear()}年${activeMonth.getMonth() + 1}月`;

  return (
    <div className="space-y-6">
      <Card className="bg-card">
        <CardHeader className="border-b border-border pb-4">
          <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
            <div>
              <div className="flex items-center gap-2">
                <Target className="h-5 w-5 text-primary" />
                <CardTitle>情绪指标统计</CardTitle>
              </div>
              <CardDescription className="mt-1">
                首屏展示真实情绪序列，日历负责补抓入口和数据状态反馈。
              </CardDescription>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <span>{metrics?.startDate ?? '--'} - {metrics?.endDate ?? '--'}</span>
                <span>共 {metrics?.summary.totalTradingDays ?? 0} 个交易日</span>
              </div>
              <Badge
                variant={getStatusVariant(selectedCalendarDay)}
              >
                {selectedDate}
                {' '}
                {getStatusLabel(selectedCalendarDay)}
              </Badge>
              <Dialog open={calendarOpen} onOpenChange={setCalendarOpen}>
                <DialogTrigger asChild>
                  <Button variant="outline" size="sm">
                    <CalendarDays className="mr-2 h-4 w-4" />
                    数据日历
                  </Button>
                </DialogTrigger>
                <DialogContent className="max-h-[88vh] max-w-[1120px] overflow-hidden p-0">
                  <DialogHeader className="border-b border-border px-5 py-4">
                    <DialogTitle className="text-[18px] font-semibold tracking-[-0.02em] text-foreground">情绪数据日历</DialogTitle>
                    <DialogDescription className="text-[13px] leading-6 text-muted-foreground">
                      围绕一个交易月完成选日、补抓和状态检查。
                    </DialogDescription>
                  </DialogHeader>
                  <div className="flex max-h-[calc(88vh-88px)] flex-col overflow-hidden">
                    <div className="border-b border-border bg-[radial-gradient(circle_at_top_left,rgba(59,130,246,0.10),transparent_42%),linear-gradient(180deg,rgba(248,250,252,0.9),rgba(248,250,252,0.4))] px-5 py-4">
                      <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
                        <div>
                          <div className="text-[10px] font-medium uppercase tracking-[0.28em] text-muted-foreground">当前选中</div>
                          <div className="mt-2 flex flex-wrap items-center gap-3">
                            <div className="text-[30px] font-semibold tracking-[-0.03em] text-foreground">{selectedDate || '--'}</div>
                            <Badge variant={getStatusVariant(selectedCalendarDay)}>{getStatusLabel(selectedCalendarDay)}</Badge>
                            <span className="text-[13px] leading-6 text-muted-foreground">
                              {selectedCalendarDay?.is_trading_day ? '可作为单日重抓或批量回补截止日。' : '非交易日仅用于浏览状态。'}
                            </span>
                          </div>
                        </div>
                        <div className="grid grid-cols-3 gap-3 xl:min-w-[420px]">
                          <div className="rounded-2xl border border-border bg-background/80 px-4 py-3">
                            <div className="text-[11px] text-muted-foreground">交易日</div>
                            <div className="mt-1 text-[26px] font-semibold tracking-[-0.03em] text-foreground">{monthTradingDays}</div>
                          </div>
                          <div className="rounded-2xl border border-emerald-200 bg-emerald-50/80 px-4 py-3">
                            <div className="text-[11px] text-muted-foreground">已就绪</div>
                            <div className="mt-1 text-[26px] font-semibold tracking-[-0.03em] text-emerald-700">{monthReadyDays}</div>
                          </div>
                          <div className="rounded-2xl border border-amber-200 bg-amber-50/80 px-4 py-3">
                            <div className="text-[11px] text-muted-foreground">待补抓</div>
                            <div className="mt-1 text-[26px] font-semibold tracking-[-0.03em] text-amber-700">{monthPendingDays}</div>
                          </div>
                        </div>
                      </div>
                    </div>

                    <div className="grid min-h-0 flex-1 overflow-hidden lg:grid-cols-[1fr_320px]">
                      <div className="flex min-h-0 flex-col border-b border-border bg-background lg:border-b-0 lg:border-r">
                        <div className="border-b border-border px-5 py-4">
                          <div className="flex flex-wrap items-center justify-between gap-3">
                            <div>
                              <div className="text-[10px] font-medium uppercase tracking-[0.28em] text-muted-foreground">交易月历</div>
                              <div className="mt-1 text-[20px] font-semibold tracking-[-0.02em] text-foreground">{monthLabel}</div>
                            </div>
                            <div className="flex items-center gap-2">
                              <Button variant="outline" size="sm" onClick={() => setActiveMonth(new Date(activeMonth.getFullYear(), activeMonth.getMonth() - 1, 1))}>
                                上月
                              </Button>
                              <Button variant="outline" size="sm" onClick={() => setActiveMonth(new Date(activeMonth.getFullYear(), activeMonth.getMonth() + 1, 1))}>
                                下月
                              </Button>
                            </div>
                          </div>
                        </div>
                        <div className="flex-1 overflow-y-auto px-5 py-4">
                          {calendarLoading && (
                            <div className="rounded-2xl border border-dashed border-border px-4 py-8 text-sm text-muted-foreground">
                              正在加载日历...
                            </div>
                          )}
                          {!calendarLoading && (
                            <div className="rounded-3xl border border-border bg-muted/10 p-4">
                              <div className="mb-3 grid grid-cols-7 gap-2">
                                {WEEK_HEADERS.map((header) => (
                                  <div key={header} className="px-2 text-center text-[11px] font-medium tracking-[0.08em] text-muted-foreground">
                                    {header}
                                  </div>
                                ))}
                              </div>
                              <div className="grid grid-cols-7 gap-2">
                                {calendarCells.map((day, index) => (
                                  <div key={day ? day.date : `blank-${index}`} className="min-h-[6rem]">
                                    {day ? (
                                      <button
                                        type="button"
                                        onClick={() => day.is_trading_day && setSelectedDate(day.date)}
                                        className={cn(
                                          'flex h-full w-full flex-col rounded-2xl border px-3 py-3 text-left transition-all',
                                          getStatusTone(day),
                                          selectedDate === day.date && day.is_trading_day ? 'border-primary shadow-[0_0_0_2px_rgba(59,130,246,0.18)]' : '',
                                          !day.is_trading_day ? 'cursor-not-allowed opacity-70' : 'hover:-translate-y-0.5 hover:border-primary/50'
                                        )}
                                      >
                                        <div className="flex items-center justify-between gap-2">
                                          <span className="text-[15px] font-semibold tracking-[-0.01em]">{parseDate(day.date).getDate()}</span>
                                          <span
                                            className={cn(
                                              'h-2.5 w-2.5 rounded-full',
                                              day.sync_status === 'success'
                                                ? 'bg-emerald-500'
                                                : day.sync_status === 'partial'
                                                  ? 'bg-amber-500'
                                                  : day.sync_status === 'failed'
                                                    ? 'bg-red-500'
                                                    : day.sync_status === 'non_trading'
                                                      ? 'bg-muted-foreground/40'
                                                      : 'bg-slate-300'
                                            )}
                                          />
                                        </div>
                                        <span className="mt-3 line-clamp-2 text-[11px] font-medium leading-4">{getStatusLabel(day)}</span>
                                        <span className="mt-auto pt-3 text-[10px] tracking-[0.04em] text-muted-foreground">
                                          {day.is_trading_day ? (selectedDate === day.date ? '当前选中' : '点击查看') : '休市'}
                                        </span>
                                      </button>
                                    ) : (
                                      <div className="h-full rounded-2xl" />
                                    )}
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}
                        </div>
                      </div>

                      <div className="overflow-y-auto bg-muted/10 px-5 py-4">
                        {calendarError && (
                          <div className="mb-4 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-[13px] leading-6 text-red-700">
                            {calendarError}
                          </div>
                        )}
                        {calendarNotice && (
                          <div className="mb-4 rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-[13px] leading-6 text-emerald-700">
                            {calendarNotice}
                          </div>
                        )}
                        <div className="space-y-4">
                          <div className="rounded-2xl border border-border bg-background p-4">
                            <div className="text-[15px] font-semibold tracking-[-0.01em] text-foreground">批量回补</div>
                            <div className="mt-2 text-[13px] leading-6 text-muted-foreground">
                              以当前选中日期为截止日，只补缺失数据，不重复覆盖已完成的交易日。
                            </div>
                            <div className="mt-4 grid grid-cols-3 gap-2">
                              {BACKFILL_DAY_OPTIONS.map((days) => (
                                <Button
                                  key={days}
                                  variant={backfillDays === days ? 'primary' : 'outline'}
                                  size="sm"
                                  onClick={() => setBackfillDays(days)}
                                  className="px-0 text-[12px] font-medium"
                                >
                                  {days}日
                                </Button>
                              ))}
                            </div>
                            <Button className="mt-4 w-full" variant="outline" onClick={handleBackfillRecentDays} isLoading={backfilling}>
                              <RefreshCw className="mr-2 h-4 w-4" />
                              回补近{backfillDays}个交易日
                            </Button>
                          </div>

                          <div className="rounded-2xl border border-border bg-background p-4">
                            <div className="text-[15px] font-semibold tracking-[-0.01em] text-foreground">单日重抓</div>
                            <div className="mt-2 text-[13px] leading-6 text-muted-foreground">
                              对当前选中交易日重新拉取池子数据，并覆盖当天聚合指标。
                            </div>
                            <Button className="mt-4 w-full" variant="primary" onClick={handleSyncSelectedDate} isLoading={syncing}>
                              <RefreshCw className="mr-2 h-4 w-4" />
                              重新抓取 {selectedDate || '所选日期'}
                            </Button>
                          </div>

                          <div className="rounded-2xl border border-border bg-background p-4">
                            <div className="text-[15px] font-semibold tracking-[-0.01em] text-foreground">状态图例</div>
                            <div className="mt-3 grid gap-2 text-[12px] leading-5 text-muted-foreground">
                              <div className="flex items-center justify-between"><span>成功</span><Badge variant="success">已就绪</Badge></div>
                              <div className="flex items-center justify-between"><span>部分缺失</span><Badge variant="warning">部分缺失</Badge></div>
                              <div className="flex items-center justify-between"><span>失败</span><Badge variant="destructive">抓取失败</Badge></div>
                              <div className="flex items-center justify-between"><span>未抓取</span><Badge variant="outline">未抓取</Badge></div>
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                </DialogContent>
              </Dialog>
            </div>
          </div>
        </CardHeader>
        <CardContent className="pt-4">
          <div className="grid gap-3 xl:grid-cols-[0.9fr_1.35fr]">
            <div>
              <div className="mb-2 flex items-center gap-2 text-sm font-medium text-foreground">
                <CalendarRange className="h-4 w-4 text-muted-foreground" />
                快捷区间
              </div>
              <div className="flex flex-wrap gap-2">
                {PRESET_RANGES.map((range) => (
                  <Button
                    key={range}
                    variant={activeRange === range ? 'primary' : 'outline'}
                    size="sm"
                    onClick={() => setActiveRange(range)}
                  >
                    近{range}日
                  </Button>
                ))}
              </div>
            </div>
            <div>
              <div className="mb-2 flex items-center gap-2 text-sm font-medium text-foreground">
                <Gauge className="h-4 w-4 text-muted-foreground" />
                指标切换
              </div>
              <div className="grid grid-cols-2 gap-2 xl:grid-cols-4">
                {METRIC_CONFIGS.map((config) => {
                  const Icon = config.icon;
                  const selected = config.key === metricKey;
                  return (
                    <button
                      key={config.key}
                      type="button"
                      onClick={() => setMetricKey(config.key)}
                      className={cn(
                        'rounded-md border px-3 py-2 text-left transition-colors',
                        selected ? 'border-primary bg-primary/10' : 'border-border bg-card hover:bg-muted/60'
                      )}
                    >
                      <div className="flex items-center gap-2">
                        <Icon className={cn('h-4 w-4', selected ? 'text-primary' : 'text-muted-foreground')} />
                        <span className="text-xs font-medium">{config.name}</span>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="border-b border-border pb-4">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <CardTitle className="text-base">{metricConfig.name}走势</CardTitle>
              <CardDescription className="mt-1">红线代表参考阈值，图表已切换到真实情绪聚合数据。</CardDescription>
            </div>
            <div className="flex flex-wrap gap-2">
              <Badge variant="outline">当前 {formatValue(summary.currentValue, metricConfig.unit)}</Badge>
              <Badge variant="warning">阈值 {formatValue(metricConfig.threshold, metricConfig.unit)}</Badge>
              <Badge variant={isAboveThreshold ? 'destructive' : 'success'}>
                {isAboveThreshold ? '高于阈值' : '低于阈值'}
              </Badge>
            </div>
          </div>
        </CardHeader>
        <CardContent className="pt-4">
          {error && (
            <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
              {error}
            </div>
          )}
          {loading && (
            <div className="mb-4 rounded-lg border border-dashed border-border px-4 py-6 text-sm text-muted-foreground">
              正在加载情绪指标...
            </div>
          )}
          {!loading && chartData.length === 0 && (
            <div className="mb-4 rounded-lg border border-dashed border-border px-4 py-6 text-sm text-muted-foreground">
              当前区间暂无可展示的情绪数据，请先在上方日历触发单日抓取。
            </div>
          )}
          {!loading && chartData.length > 0 && (
            <>
              <div className="mb-4 rounded-lg border border-primary/20 bg-primary/5 px-4 py-3">
                <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
                  <div className="flex items-center gap-2">
                    <Flame className="h-4 w-4 text-primary" />
                    <span className="text-muted-foreground">当前值</span>
                    <span className="font-semibold text-foreground">{formatValue(summary.currentValue, metricConfig.unit)}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-muted-foreground">阈值状态</span>
                    <span className={cn('font-semibold', isAboveThreshold ? 'text-red-500' : 'text-emerald-600')}>
                      {isAboveThreshold ? '高于阈值' : '低于阈值'}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-muted-foreground">差值</span>
                    <span className="font-semibold text-foreground">
                      {thresholdGap >= 0 ? '+' : '-'}{formatValue(Math.abs(thresholdGap), metricConfig.unit)}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-muted-foreground">最近突破</span>
                    <span className="font-semibold text-foreground">{latestBreakoutLabel}</span>
                  </div>
                </div>
              </div>

              <div className="h-[56vh] min-h-[420px] w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={chartData} margin={{ top: 10, right: 20, left: 0, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                    <XAxis
                      dataKey="date"
                      tickFormatter={formatXAxisLabel}
                      tick={{ fill: 'var(--muted-foreground)', fontSize: 12 }}
                      minTickGap={28}
                    />
                    <YAxis
                      domain={chartDomain}
                      tick={{ fill: 'var(--muted-foreground)', fontSize: 12 }}
                      tickFormatter={(value: number) => {
                        if (metricConfig.unit === '%') return `${value.toFixed(0)}%`;
                        if (metricConfig.unit === '亿') return `${value.toFixed(0)}`;
                        return `${Math.round(value)}`;
                      }}
                    />
                    <Tooltip
                      contentStyle={{
                        backgroundColor: 'var(--card)',
                        borderColor: 'var(--border)',
                        borderRadius: '0.5rem',
                      }}
                      formatter={(value: number, name: string) => [formatValue(Number(value), metricConfig.unit), name]}
                      labelFormatter={(label: string) => `日期: ${label}`}
                    />
                    <Legend />
                    <ReferenceLine
                      y={metricConfig.threshold}
                      stroke="#ef4444"
                      strokeWidth={2}
                      strokeDasharray="6 4"
                      label={{
                        value: `阈值 ${formatValue(metricConfig.threshold, metricConfig.unit)}`,
                        fill: '#ef4444',
                        position: 'insideTopRight',
                        fontSize: 12,
                      }}
                    />
                    {metricConfig.series.map((series) => (
                      <Line
                        key={series.key}
                        type="monotone"
                        dataKey={series.key}
                        name={series.name}
                        stroke={series.color}
                        strokeWidth={series.isPrimary ? 2.5 : 1.8}
                        dot={(props: ChartDotProps) => {
                          const { cx, cy, payload } = props;
                          if (typeof cx !== 'number' || typeof cy !== 'number' || !payload) {
                            return null;
                          }
                          if (!series.isPrimary || !highlightedDates.has(payload.date)) {
                            return <circle cx={cx} cy={cy} r={2.5} fill={series.color} stroke="none" />;
                          }
                          return (
                            <g>
                              <circle cx={cx} cy={cy} r={11} fill="rgba(239, 68, 68, 0.08)" />
                              <circle cx={cx} cy={cy} r={7} fill="#ffffff" stroke="#ef4444" strokeWidth={2} />
                              <circle cx={cx} cy={cy} r={3} fill="#ef4444" />
                            </g>
                          );
                        }}
                        activeDot={{ r: 6 }}
                      />
                    ))}
                  </LineChart>
                </ResponsiveContainer>
              </div>

              <div className="mt-6 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                <Card className="border-primary/20">
                  <CardContent className="p-5">
                    <div className="text-sm text-muted-foreground">当前观察值</div>
                    <div className="mt-2 text-2xl font-semibold text-foreground">
                      {formatValue(summary.currentValue, metricConfig.unit)}
                    </div>
                    <div className="mt-2 text-xs text-muted-foreground">
                      主观察指标：{primarySeries.name}
                    </div>
                  </CardContent>
                </Card>
                <Card>
                  <CardContent className="p-5">
                    <div className="text-sm text-muted-foreground">超阈值次数</div>
                    <div className="mt-2 text-2xl font-semibold text-red-500">
                      {summary.breakoutCount}
                    </div>
                    <div className="mt-2 text-xs text-muted-foreground">
                      阈值线：{formatValue(metricConfig.threshold, metricConfig.unit)}
                    </div>
                  </CardContent>
                </Card>
                <Card>
                  <CardContent className="p-5">
                    <div className="text-sm text-muted-foreground">超阈值占比</div>
                    <div className="mt-2 text-2xl font-semibold">
                      {summary.breakoutRatio.toFixed(1)}%
                    </div>
                    <div className="mt-2 text-xs text-muted-foreground">
                      用于判断情绪高位密度
                    </div>
                  </CardContent>
                </Card>
                <Card>
                  <CardContent className="p-5">
                    <div className="text-sm text-muted-foreground">最近一次突破</div>
                    <div className="mt-2 text-2xl font-semibold">
                      {latestBreakoutLabel}
                    </div>
                    <div className="mt-2 text-xs text-muted-foreground">
                      均值 {formatValue(summary.avgValue, metricConfig.unit)} / 峰值 {formatValue(summary.maxValue, metricConfig.unit)}
                    </div>
                  </CardContent>
                </Card>
              </div>

              <div className="mt-6 grid gap-4 lg:grid-cols-[1.1fr_0.9fr]">
                <div className="rounded-lg border border-border bg-background p-4">
                  <div className="flex items-center gap-2 text-sm font-medium">
                    <AlertTriangle className="h-4 w-4 text-red-500" />
                    读图重点
                  </div>
                  <ul className="mt-3 space-y-2 text-sm text-muted-foreground">
                    <li>先看当前值是否站上红线，这是页面最重要的判断。</li>
                    <li>再看红圈点是否集中出现，判断情绪高位是偶发还是持续。</li>
                    <li>最后结合最近突破日期，辅助判断市场是否刚进入活跃阶段。</li>
                  </ul>
                </div>
                <div className="rounded-lg border border-border bg-background p-4">
                  <div className="text-sm font-medium text-foreground">当前真实数据字段</div>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Badge variant="outline">advanceRate</Badge>
                    <Badge variant="outline">breakoutRate</Badge>
                    <Badge variant="outline">avgReturn</Badge>
                    <Badge variant="outline">breakoutCount</Badge>
                    <Badge variant="outline">turnoverAmount</Badge>
                    <Badge variant="outline">northboundAmount</Badge>
                    <Badge variant="outline">mainForceAmount</Badge>
                  </div>
                </div>
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
