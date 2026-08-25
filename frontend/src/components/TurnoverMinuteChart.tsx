'use client';

import React, { useMemo } from 'react';
import { formatAmount } from '@/lib/market/format';
import type { TurnoverSnapshot } from '@/lib/market/types';

type TurnoverMinuteChartProps = {
  data: TurnoverSnapshot | null;
};

function yFor(value: number, min: number, max: number, top: number, bottom: number) {
  if (max === min) return (top + bottom) / 2;
  return bottom - ((bottom - top) * (value - min)) / (max - min);
}

export default function TurnoverMinuteChart({ data }: TurnoverMinuteChartProps) {
  const chart = useMemo(() => {
    const points = (data?.points || []).filter((point) => point.time);
    const values = points.flatMap((point) => [point.today, point.yesterday]).filter((value): value is number => value != null);
    const max = Math.max(...values, 1);
    const min = Math.min(...values, 0);
    return { points, min, max };
  }, [data]);

  if (!data || chart.points.length === 0) {
    return (
      <div className="rounded-[24px] border border-dashed border-border/70 bg-background/35 px-5 py-10 text-center text-sm text-muted-foreground">
        暂无成交额分钟数据
      </div>
    );
  }

  const width = 1000;
  const height = 280;
  const left = 64;
  const right = 972;
  const top = 24;
  const bottom = 248;
  const { points, min, max } = chart;
  const xFor = (index: number) =>
    points.length === 1 ? (left + right) / 2 : left + ((right - left) * index) / (points.length - 1);
  const todayPath = points
    .map((point, index) =>
      point.today == null ? null : `${index === 0 || points[index - 1]?.today == null ? 'M' : 'L'} ${xFor(index)} ${yFor(point.today, min, max, top, bottom)}`
    )
    .filter(Boolean)
    .join(' ');
  const yesterdayPath = points
    .map((point, index) =>
      point.yesterday == null
        ? null
        : `${index === 0 || points[index - 1]?.yesterday == null ? 'M' : 'L'} ${xFor(index)} ${yFor(point.yesterday, min, max, top, bottom)}`
    )
    .filter(Boolean)
    .join(' ');
  const tickTimes = new Set(['09:30', '10:30', '11:30', '13:00', '14:00', '15:00']);

  return (
    <div className="rounded-[24px] border border-border/70 bg-background/70 p-5">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div>
          <div className="text-sm font-semibold text-foreground">两市成交额</div>
          <div className="mt-1 text-xs text-muted-foreground">今日 / 昨日分钟成交，数据来自同花顺。</div>
        </div>
        <div className="flex items-center gap-4 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-2">
            <span className="h-2.5 w-2.5 rounded-full bg-orange-500" />
            今日 {data.currentText}
          </span>
          <span className="inline-flex items-center gap-2">
            <span className="h-2.5 w-2.5 rounded-full bg-slate-400" />
            昨日 {data.previousText}
          </span>
        </div>
      </div>
      <svg viewBox={`0 0 ${width} ${height}`} className="h-[280px] w-full">
        {[0, 0.25, 0.5, 0.75, 1].map((ratio) => {
          const value = min + (max - min) * ratio;
          const y = yFor(value, min, max, top, bottom);
          return (
            <g key={`grid-${ratio}`}>
              <line x1={left} y1={y} x2={right} y2={y} stroke="rgba(148,163,184,0.16)" strokeDasharray="4 6" />
              <text x="8" y={y + 4} fontSize="10" fill="currentColor" opacity="0.55">
                {formatAmount(value)}
              </text>
            </g>
          );
        })}
        <path d={yesterdayPath} fill="none" stroke="rgba(148,163,184,0.85)" strokeWidth="2" />
        <path d={todayPath} fill="none" stroke="rgba(249,115,22,0.96)" strokeWidth="2.6" />
        {points.map((point, index) =>
          tickTimes.has(point.time) || index === 0 || index === points.length - 1 ? (
            <text key={point.time} x={xFor(index)} y="268" textAnchor="middle" fontSize="10" fill="currentColor" opacity="0.6">
              {point.time}
            </text>
          ) : null
        )}
      </svg>
    </div>
  );
}
