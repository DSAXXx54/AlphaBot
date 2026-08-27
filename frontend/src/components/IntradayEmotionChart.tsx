'use client';

import React, { useMemo, useState } from 'react';
import type { IntradayEmotionSnapshot } from '@/lib/market/types';

type IntradayEmotionChartProps = {
  data: IntradayEmotionSnapshot | null;
};

const PIN_PATH = 'M 0 24 C 3 16 14 10 14 -1 C 14 -10 8 -16 0 -16 C -8 -16 -14 -10 -14 -1 C -14 10 -3 16 0 24 Z';

function yFor(value: number, min: number, max: number, top: number, bottom: number) {
  if (max === min) return (top + bottom) / 2;
  return bottom - ((bottom - top) * (value - min)) / (max - min);
}

function nearestIndex(targetX: number, positions: number[]) {
  let bestIndex = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  positions.forEach((position, index) => {
    const distance = Math.abs(position - targetX);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = index;
    }
  });
  return bestIndex;
}

function minuteSlot(time: string) {
  const [hourText, minuteText] = time.split(':');
  const hour = Number(hourText);
  const minute = Number(minuteText);
  if (Number.isNaN(hour) || Number.isNaN(minute)) return 0;
  if (hour < 12) return (hour * 60 + minute) - (9 * 60 + 30);
  return 120 + (hour * 60 + minute) - (13 * 60);
}

function findLastCross(points: Array<{ positive: number | null; negative: number | null }>) {
  for (let index = points.length - 1; index > 0; index -= 1) {
    const current = points[index];
    const previous = points[index - 1];
    if (
      current.positive == null ||
      current.negative == null ||
      previous.positive == null ||
      previous.negative == null
    ) {
      continue;
    }
    const currentDiff = current.positive - current.negative;
    const previousDiff = previous.positive - previous.negative;
    if ((currentDiff >= 0 && previousDiff < 0) || (currentDiff <= 0 && previousDiff > 0)) {
      return {
        index,
        type: currentDiff >= 0 ? 'positive' : 'negative',
      } as const;
    }
  }
  return null;
}

export default function IntradayEmotionChart({ data }: IntradayEmotionChartProps) {
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const [hoverSeries, setHoverSeries] = useState<'positive' | 'negative'>('positive');
  const [hoverPointer, setHoverPointer] = useState<{ x: number; y: number } | null>(null);
  const chart = useMemo(() => {
    const points = (data?.points || []).filter((point) => point.time);
    const values = points
      .flatMap((point) => [point.positive, point.negative])
      .filter((value): value is number => value != null);
    const min = Math.min(...values, 0);
    const max = Math.max(...values, 1);
    const cross = findLastCross(points);
    return { points, min, max, cross };
  }, [data]);

  if (!data || chart.points.length === 0) {
    return <div className="px-5 py-10 text-center text-sm text-muted-foreground">暂无盘中情绪数据</div>;
  }

  const width = 1000;
  const height = 320;
  const left = 56;
  const right = 968;
  const top = 26;
  const bottom = 274;
  const { points, min, max, cross } = chart;
  const xFor = (index: number) => {
    const slot = Math.max(0, Math.min(239, minuteSlot(points[index]?.time || '09:30')));
    return left + ((right - left) * slot) / 239;
  };
  const xPositions = points.map((_, index) => xFor(index));
  const positivePath = points
    .map((point, index) =>
      point.positive == null ? null : `${index === 0 || points[index - 1]?.positive == null ? 'M' : 'L'} ${xFor(index)} ${yFor(point.positive, min, max, top, bottom)}`
    )
    .filter(Boolean)
    .join(' ');
  const negativePath = points
    .map((point, index) =>
      point.negative == null ? null : `${index === 0 || points[index - 1]?.negative == null ? 'M' : 'L'} ${xFor(index)} ${yFor(point.negative, min, max, top, bottom)}`
    )
    .filter(Boolean)
    .join(' ');
  const latest = points[points.length - 1];
  const tickTimes = new Set(['09:30', '10:30', '13:00', '14:00']);
  const labelPoint = cross ? points[cross.index] : null;

  const labelX = cross ? xFor(cross.index) : 0;
  const labelY = cross && labelPoint ? yFor(labelPoint[cross.type] || 0, min, max, top, bottom) : 0;
  const hovered = hoverIndex != null ? points[hoverIndex] : null;
  const hoveredX = hoverIndex != null ? xFor(hoverIndex) : null;
  const hoveredPositiveY = hoverIndex != null && hovered?.positive != null ? yFor(hovered.positive, min, max, top, bottom) : null;
  const hoveredNegativeY = hoverIndex != null && hovered?.negative != null ? yFor(hovered.negative, min, max, top, bottom) : null;
  const hoveredY =
    hoverSeries === 'positive' ? hoveredPositiveY ?? hoveredNegativeY : hoveredNegativeY ?? hoveredPositiveY;

  const handlePointerMove = (event: React.PointerEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const pointerX = event.clientX - rect.left;
    const pointerY = event.clientY - rect.top;
    const svgX = ((event.clientX - rect.left) / rect.width) * width;
    const svgY = ((event.clientY - rect.top) / rect.height) * height;
    const nextIndex = nearestIndex(svgX, xPositions);
    const point = points[nextIndex];
    const positiveY = point.positive != null ? yFor(point.positive, min, max, top, bottom) : null;
    const negativeY = point.negative != null ? yFor(point.negative, min, max, top, bottom) : null;
    if (positiveY != null && negativeY != null) {
      setHoverSeries(Math.abs(svgY - positiveY) <= Math.abs(svgY - negativeY) ? 'positive' : 'negative');
    } else if (positiveY != null) {
      setHoverSeries('positive');
    } else if (negativeY != null) {
      setHoverSeries('negative');
    }
    setHoverIndex(nextIndex);
    setHoverPointer({ x: pointerX, y: pointerY });
  };

  const tooltipWidth = 190;
  const tooltipHeight = 92;
  const tooltipLeft = hoverPointer ? Math.min(Math.max(hoverPointer.x + 14, 12), 1000) : 12;
  const tooltipTop = hoverPointer ? Math.max(10, hoverPointer.y - tooltipHeight - 14) : 10;

  return (
    <div className="px-3 pb-3 pt-2">
      <div className="mb-3 flex flex-wrap items-center gap-4 px-2 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-2">
          <span className="h-2.5 w-2.5 rounded-full bg-rose-500" />
          正情绪
          <span className="font-semibold text-rose-500">{data.positiveCurrent != null ? data.positiveCurrent.toFixed(0) : '--'}</span>
        </span>
        <span className="inline-flex items-center gap-2">
          <span className="h-2.5 w-2.5 rounded-full bg-emerald-500" />
          负情绪
          <span className="font-semibold text-emerald-500">{data.negativeCurrent != null ? data.negativeCurrent.toFixed(0) : '--'}</span>
        </span>
      </div>
      <div className="relative">
        <svg
          viewBox={`0 0 ${width} ${height}`}
          preserveAspectRatio="none"
          className="h-[320px] w-full"
          onPointerMove={handlePointerMove}
          onPointerLeave={() => {
            setHoverIndex(null);
            setHoverPointer(null);
          }}
        >
          {[0, 0.25, 0.5, 0.75, 1].map((ratio) => {
            const value = min + (max - min) * ratio;
            const y = yFor(value, min, max, top, bottom);
            return (
              <g key={`grid-${ratio}`}>
                <line x1={left} y1={y} x2={right} y2={y} stroke="rgba(148,163,184,0.16)" strokeDasharray="4 6" />
                <text x="8" y={y + 4} fontSize="10" fill="currentColor" opacity="0.55">
                  {value.toFixed(0)}
                </text>
              </g>
            );
          })}
          <path d={negativePath} fill="none" stroke="rgba(34,197,94,0.92)" strokeWidth="2.2" strokeLinecap="round" />
          <path d={positivePath} fill="none" stroke="rgba(239,68,68,0.98)" strokeWidth="2.6" strokeLinecap="round" />
          {hoveredX != null ? (
            <>
              <line x1={hoveredX} y1={top} x2={hoveredX} y2={bottom} stroke="rgba(100,116,139,0.5)" strokeDasharray="4 4" />
              {hoveredY != null ? (
                <line x1={left} y1={hoveredY} x2={right} y2={hoveredY} stroke="rgba(100,116,139,0.35)" strokeDasharray="4 4" />
              ) : null}
            </>
          ) : null}
          {latest ? (
            <>
              {latest.positive != null ? (
                <circle cx={xFor(points.length - 1)} cy={yFor(latest.positive, min, max, top, bottom)} r="6" fill="rgba(239,68,68,1)" stroke="white" strokeWidth="1.6" />
              ) : null}
              {latest.negative != null ? (
                <circle cx={xFor(points.length - 1)} cy={yFor(latest.negative, min, max, top, bottom)} r="5.5" fill="rgba(250,204,21,1)" stroke="white" strokeWidth="1.6" />
              ) : null}
            </>
          ) : null}
          {hovered && hoveredX != null ? (
            <>
              {hovered.positive != null && hoveredPositiveY != null ? (
                <circle cx={hoveredX} cy={hoveredPositiveY} r="4.8" fill="rgba(239,68,68,1)" stroke="white" strokeWidth="1.5" />
              ) : null}
              {hovered.negative != null && hoveredNegativeY != null ? (
                <circle cx={hoveredX} cy={hoveredNegativeY} r="4.8" fill="rgba(250,204,21,1)" stroke="white" strokeWidth="1.5" />
              ) : null}
            </>
          ) : null}
          {points.map((point, index) =>
            tickTimes.has(point.time) || index === 0 || index === points.length - 1 ? (
              <text key={point.time} x={xFor(index)} y="296" textAnchor="middle" fontSize="11" fill="currentColor" opacity="0.68">
                {point.time}
              </text>
            ) : null
          )}
        </svg>
        {cross && labelPoint ? (
          <svg
            className="pointer-events-none absolute inset-0 h-full w-full overflow-visible"
            viewBox={`0 0 ${width} ${height}`}
            preserveAspectRatio="none"
          >
            <g transform={`translate(${labelX}, ${labelY - 24})`}>
              <path
                d={PIN_PATH}
                transform="scale(0.78)"
                fill={cross.type === 'positive' ? 'rgba(239,68,68,0.96)' : 'rgba(250,204,21,0.96)'}
              />
              <text x="0" y="-2" textAnchor="middle" dominantBaseline="middle" fontSize="9" fontWeight="700" fill="#ffffff">
                {Number(labelPoint[cross.type] || 0).toFixed(0)}
              </text>
            </g>
          </svg>
        ) : null}
        {hovered && hoveredX != null ? (
          <div
            className="pointer-events-none absolute z-20 rounded-xl border px-4 py-3 text-sm shadow-[0_12px_28px_rgba(15,23,42,0.25)] backdrop-blur-md"
            style={{
              left: `min(${tooltipLeft}px, calc(100% - ${tooltipWidth}px - 12px))`,
              top: `${tooltipTop}px`,
              maxWidth: `${tooltipWidth}px`,
              backgroundColor: 'rgba(15, 23, 42, 0.82)',
              borderColor: 'rgba(255,255,255,0.10)',
              color: '#f8fafc',
            }}
          >
            <div className="font-semibold" style={{ color: '#f8fafc' }}>{hovered.time}</div>
            <div className="mt-2 space-y-1">
              <div className="flex items-center gap-2" style={{ color: 'rgba(248,250,252,0.78)' }}>
                <span className="h-2.5 w-2.5 rounded-full bg-orange-500" />
                <span>正情绪:</span>
                <span className="font-medium" style={{ color: '#ffffff' }}>{hovered.positive != null ? hovered.positive.toFixed(0) : '--'}</span>
              </div>
              <div className="flex items-center gap-2" style={{ color: 'rgba(248,250,252,0.78)' }}>
                <span className="h-2.5 w-2.5 rounded-full bg-emerald-500" />
                <span>负情绪:</span>
                <span className="font-medium" style={{ color: '#ffffff' }}>{hovered.negative != null ? hovered.negative.toFixed(0) : '--'}</span>
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
