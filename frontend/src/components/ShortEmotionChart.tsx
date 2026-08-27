'use client';

import React, { useMemo, useState } from 'react';
import BoardLadderChart from '@/components/BoardLadderChart';
import type { MarketEmotionPoint, ShortEmotionSnapshot } from '@/lib/market/types';

type ShortEmotionChartProps = {
  mode: 'ladder' | 'short';
  cycle: 1 | 3 | 5 | 10 | 20;
  series: MarketEmotionPoint[];
  shortEmotion: ShortEmotionSnapshot | null;
  selectedDate?: string | null;
  onSelectDate?: (fullDate: string) => void;
  onSelectStock?: (code: string, name: string) => void;
};

const PIN_PATH = 'M 0 24 C 3 16 14 10 14 -1 C 14 -10 8 -16 0 -16 C -8 -16 -14 -10 -14 -1 C -14 10 -3 16 0 24 Z';

function yFor(value: number, min: number, max: number, top: number, bottom: number) {
  if (max === min) return (top + bottom) / 2;
  return bottom - ((bottom - top) * (value - min)) / (max - min);
}

function formatDateLabel(date: string) {
  if (!date || date.length !== 8) return date;
  return `${date.slice(4, 6)}/${date.slice(6, 8)}`;
}

function minuteSlot(time: string) {
  const [hourText, minuteText] = time.split(':');
  const hour = Number(hourText);
  const minute = Number(minuteText);
  if (Number.isNaN(hour) || Number.isNaN(minute)) return 0;
  if (hour < 12) return (hour * 60 + minute) - (9 * 60 + 30);
  return 120 + (hour * 60 + minute) - (13 * 60);
}

function zoneColor(value: number) {
  if (value > 1) return 'rgba(239,68,68,0.96)';
  if (value < -4) return 'rgba(34,197,94,0.96)';
  return 'rgba(245,245,245,0.96)';
}

function buildSegmentPaths(
  points: Array<{ value: number }>,
  xFor: (index: number) => number,
  yForValue: (value: number) => number
) {
  const paths = {
    active: '',
    neutral: '',
    ice: '',
  };
  const keyFor = (value: number): keyof typeof paths => (value > 1 ? 'active' : value < -4 ? 'ice' : 'neutral');

  for (let index = 0; index < points.length - 1; index += 1) {
    const current = points[index];
    const next = points[index + 1];
    const key = keyFor((current.value + next.value) / 2);
    const command = `${paths[key] ? ' M' : 'M'} ${xFor(index)} ${yForValue(current.value)} L ${xFor(index + 1)} ${yForValue(next.value)}`;
    paths[key] += command;
  }

  return paths;
}

export default function ShortEmotionChart({
  mode,
  cycle,
  series,
  shortEmotion,
  selectedDate,
  onSelectDate,
  onSelectStock,
}: ShortEmotionChartProps) {
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const shortChart = useMemo(() => {
    const days = (shortEmotion?.days || []).slice(-Math.min(cycle, shortEmotion?.days.length || 0));
    const merged = days.flatMap((day) =>
      day.points.map((point, index) => ({
        ...point,
        date: day.date,
        xLabel: `${day.date}-${point.time}`,
        isDayStart: index === 0,
      }))
    );
    const values = merged.map((point) => point.value);
    const turnovers = merged.map((point) => point.turnover ?? 0);
    const minValue = values.length > 0 ? Math.min(...values) : -10;
    const maxValue = values.length > 0 ? Math.max(...values) : 10;
    const span = Math.max(maxValue - minValue, 1.2);
    const padding = Math.max(span * 0.12, 0.35);
    const min = Math.floor((minValue - padding) * 100) / 100;
    const max = Math.ceil((maxValue + padding) * 100) / 100;
    const turnoverMax = turnovers.length > 0 ? Math.max(...turnovers, 1) : 1;
    let maxPointIndex = -1;
    let minPointIndex = -1;
    merged.forEach((point, index) => {
      if (maxPointIndex === -1 || point.value > merged[maxPointIndex].value) maxPointIndex = index;
      if (minPointIndex === -1 || point.value < merged[minPointIndex].value) minPointIndex = index;
    });
    return {
      days,
      merged,
      min,
      max,
      turnoverMax,
      maxPointIndex,
      minPointIndex,
      maxPoint: maxPointIndex >= 0 ? merged[maxPointIndex] : null,
      minPoint: minPointIndex >= 0 ? merged[minPointIndex] : null,
    };
  }, [cycle, shortEmotion]);

  if (mode === 'short') {
    if (shortChart.days.length === 0) {
      return <div className="px-5 py-10 text-center text-sm text-muted-foreground">暂无短线情绪数据</div>;
    }

    const width = 1000;
    const height = 320;
    const left = 56;
    const right = 950;
    const topLine = 24;
    const bottomLine = 188;
    const topBar = 232;
    const bottomBar = 284;
    const merged = shortChart.merged;
    const latest = shortChart.days[shortChart.days.length - 1];
    const dayWidth = (right - left) / Math.max(shortChart.days.length, 1);
    const xFor = (index: number) => {
      const point = merged[index];
      const dayIndex = shortChart.days.findIndex((day) => day.date === point.date);
      const slot = Math.max(0, Math.min(239, minuteSlot(point.time)));
      return left + dayWidth * dayIndex + (dayWidth * slot) / 239;
    };
    const yForValue = (value: number) => yFor(value, shortChart.min, shortChart.max, topLine, bottomLine);
    const segmentPaths = buildSegmentPaths(merged, xFor, yForValue);
    const hovered = hoverIndex != null ? merged[hoverIndex] : null;
    const hoveredX = hoverIndex != null ? xFor(hoverIndex) : null;
    const hoveredY = hoverIndex != null && hovered ? yForValue(hovered.value) : null;

    const handlePointerMove = (event: React.PointerEvent<SVGSVGElement>) => {
      const rect = event.currentTarget.getBoundingClientRect();
      const ratio = (event.clientX - rect.left) / rect.width;
      const nextIndex = Math.round(ratio * (merged.length - 1));
      setHoverIndex(Math.max(0, Math.min(merged.length - 1, nextIndex)));
    };

    return (
      <div className="px-3 pb-3 pt-2">
        <div className="mb-3 flex flex-wrap items-center gap-4 px-2 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-2">
            <span className="h-2.5 w-2.5 rounded-full bg-orange-500" />
            短线情绪值
          </span>
          <span className="inline-flex items-center gap-2">
            <span className="font-semibold text-foreground">{shortEmotion?.latestValue != null ? shortEmotion.latestValue.toFixed(2) : '--'}</span>
            <span className={shortEmotion?.latestValue != null && shortEmotion.latestValue > 0 ? 'text-orange-600' : shortEmotion?.latestValue != null && shortEmotion.latestValue < 0 ? 'text-amber-600' : 'text-muted-foreground'}>
              {shortEmotion?.zone || '--'}
            </span>
          </span>
        </div>
        <div className="relative">
          <svg
            viewBox={`0 0 ${width} ${height}`}
            className="h-[320px] w-full"
            onPointerMove={handlePointerMove}
            onPointerLeave={() => setHoverIndex(null)}
          >
            {[0, 0.25, 0.5, 0.75, 1].map((ratio) => {
              const value = shortChart.min + (shortChart.max - shortChart.min) * ratio;
              const y = yFor(value, shortChart.min, shortChart.max, topLine, bottomLine);
              return (
                <g key={`grid-${ratio}`}>
                  <line x1={left} y1={y} x2={right} y2={y} stroke="rgba(148,163,184,0.16)" strokeDasharray="4 6" />
                  <text x="10" y={y + 4} fontSize="10" fill="currentColor" opacity="0.55">
                    {value.toFixed(2)}
                  </text>
                </g>
              );
            })}
            {[1, -2, -4]
              .filter((threshold) => threshold >= shortChart.min && threshold <= shortChart.max)
              .map((threshold, index) => (
              <g key={`threshold-${threshold}`}>
                <line
                  x1={left}
                  y1={yForValue(threshold)}
                  x2={right}
                  y2={yForValue(threshold)}
                  stroke={index === 0 ? 'rgba(233,48,48,0.45)' : 'rgba(34,157,69,0.45)'}
                  strokeDasharray="3 4"
                />
                <text
                  x={right - 2}
                  y={yForValue(threshold) - 4}
                  textAnchor="end"
                  fontSize="10"
                  fill="currentColor"
                  opacity="0.6"
                >
                  {threshold === 1 ? '活跃区' : threshold === -2 ? '低迷区' : '冰点区'}
                </text>
              </g>
            ))}
            <path d={segmentPaths.active} fill="none" stroke="rgba(239,68,68,0.96)" strokeWidth="2.6" strokeLinecap="round" />
            <path d={segmentPaths.neutral} fill="none" stroke="rgba(71,85,105,0.96)" strokeWidth="2.6" strokeLinecap="round" />
            <path d={segmentPaths.ice} fill="none" stroke="rgba(34,197,94,0.96)" strokeWidth="2.6" strokeLinecap="round" />
            {hoveredX != null ? (
              <>
                <line x1={hoveredX} y1={topLine} x2={hoveredX} y2={bottomBar} stroke="rgba(100,116,139,0.5)" strokeDasharray="4 4" />
                {hoveredY != null ? (
                  <line x1={left} y1={hoveredY} x2={right} y2={hoveredY} stroke="rgba(100,116,139,0.35)" strokeDasharray="4 4" />
                ) : null}
              </>
            ) : null}
            {merged.map((point, index) => {
              const turnover = point.turnover ?? 0;
              const barHeight = ((bottomBar - topBar) * turnover) / shortChart.turnoverMax;
              const barY = bottomBar - barHeight;
              const barColor =
                point.value > 0 ? 'rgba(249,115,22,0.38)' : point.value < 0 ? 'rgba(250,204,21,0.45)' : 'rgba(148,163,184,0.28)';
              const showDate = point.isDayStart && point.date !== latest.date;
              return (
                <g key={point.xLabel}>
                  {(point.time === '09:30' || point.time === '10:30' || point.time === '13:00' || point.time === '14:00') ? (
                    <line x1={xFor(index)} y1={topLine} x2={xFor(index)} y2={bottomLine} stroke="rgba(148,163,184,0.16)" strokeDasharray="3 4" />
                  ) : null}
                  <rect x={xFor(index) - 1.25} y={barY} width="2.5" height={barHeight} fill={barColor} />
                  {showDate ? (
                    <text x={xFor(index)} y="307" textAnchor="middle" fontSize="10" fill="currentColor" opacity="0.6">
                      {formatDateLabel(point.date)}
                    </text>
                  ) : null}
                </g>
              );
            })}
            <line x1={left} y1={topBar} x2={right} y2={topBar} stroke="rgba(148,163,184,0.16)" />
            {hovered ? (
              <circle
                cx={hoveredX || 0}
                cy={hoveredY || 0}
                r="5.5"
                fill={zoneColor(hovered.value)}
                stroke="white"
                strokeWidth="1.6"
              />
            ) : null}
            {shortChart.maxPoint ? (
              <g transform={`translate(${xFor(shortChart.maxPointIndex)}, ${yForValue(shortChart.maxPoint.value) - 24})`}>
                <path d={PIN_PATH} transform="scale(0.78)" fill="rgba(239,68,68,0.96)" />
                <text x="0" y="-3" textAnchor="middle" fontSize="9" fontWeight="700" fill="#ffffff">
                  {shortChart.maxPoint.value.toFixed(2)}
                </text>
              </g>
            ) : null}
            {shortChart.minPoint ? (
              <g transform={`translate(${xFor(shortChart.minPointIndex)}, ${yForValue(shortChart.minPoint.value) - 24})`}>
                <path d={PIN_PATH} transform="scale(0.78)" fill="rgba(34,197,94,0.96)" />
                <text x="0" y="-3" textAnchor="middle" fontSize="9" fontWeight="700" fill="#ffffff">
                  {shortChart.minPoint.value.toFixed(2)}
                </text>
              </g>
            ) : null}
            {merged.map((point, index) =>
              (point.time === '09:30' || point.time === '10:30' || point.time === '13:00' || point.time === '14:00') ? (
                <text
                  key={`${point.date}-${point.time}`}
                  x={xFor(index)}
                  y="307"
                  textAnchor="middle"
                  fontSize="10"
                  fill="currentColor"
                  opacity="0.6"
                >
                  {point.time}
                </text>
              ) : null
            )}
          </svg>
          {hovered && hoveredX != null ? (
            <div
              className="pointer-events-none absolute z-20 rounded-xl border px-4 py-3 text-sm shadow-[0_12px_28px_rgba(15,23,42,0.25)] backdrop-blur-md"
              style={{
                left: `${Math.min((hoveredX / width) * 100 + 2, 74)}%`,
                top: '10px',
                backgroundColor: 'rgba(15, 23, 42, 0.82)',
                borderColor: 'rgba(255,255,255,0.10)',
                color: '#f8fafc',
              }}
            >
              <div className="font-semibold" style={{ color: '#f8fafc' }}>{`${hovered.date.slice(0, 4)}-${hovered.date.slice(4, 6)}-${hovered.date.slice(6, 8)} ${hovered.time}`}</div>
              <div className="mt-2 space-y-1">
                <div className="flex items-center gap-2" style={{ color: 'rgba(248,250,252,0.78)' }}>
                  <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: zoneColor(hovered.value) }} />
                  <span>短线情绪值:</span>
                  <span className="font-medium" style={{ color: '#ffffff' }}>{hovered.value.toFixed(2)}</span>
                </div>
                <div className="flex items-center gap-2" style={{ color: 'rgba(248,250,252,0.78)' }}>
                  <span className="h-2.5 w-2.5 rounded-full bg-orange-400/80" />
                  <span>成交额:</span>
                  <span className="font-medium" style={{ color: '#ffffff' }}>{hovered.turnover != null ? `${(hovered.turnover / 100000000).toFixed(2)}亿` : '--'}</span>
                </div>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div className="-mx-5 -mb-5">
      <BoardLadderChart
        series={series.slice(-Math.min(cycle, series.length))}
        selectedDate={selectedDate ?? null}
        onSelectDate={onSelectDate ?? (() => undefined)}
        onSelectStock={onSelectStock}
        framed={false}
      />
    </div>
  );
}
