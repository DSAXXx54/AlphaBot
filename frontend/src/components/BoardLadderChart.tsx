'use client';

import React, { useState } from 'react';
import { buildLinePathFromBounds, pointX, pointY } from '@/lib/market/chartPath';
import type { MarketBoardLevel, MarketEmotionPoint } from '@/lib/market/types';

type BoardLadderChartProps = {
  series: MarketEmotionPoint[];
  selectedDate: string | null;
  onSelectDate: (fullDate: string) => void;
  onSelectStock?: (code: string, name: string) => void;
  framed?: boolean;
};

const MAX_STROKE = 'rgba(249,115,22,0.96)';
const SECOND_STROKE = 'rgba(251,191,36,0.95)';
const WIDTH = 1000;
const HEIGHT = 380;
const PAD = { top: 56, right: 28, bottom: 44, left: 48 };

function levelTone(height: number) {
  if (height >= 6) return 'text-orange-600 dark:text-orange-300';
  if (height >= 3) return 'text-amber-700 dark:text-amber-300';
  return 'text-muted-foreground';
}

function codesForHeight(point: MarketEmotionPoint, height: number) {
  return point.allLevels.find((level) => level.height === height)?.code_list || [];
}

function StockLabel({
  height,
  count,
  stocks,
  x,
  y,
  variant,
  compact,
  onSelectStock,
}: {
  height: number;
  count: number;
  stocks: Array<{ name: string; code: string }>;
  x: number;
  y: number;
  variant: 'max' | 'second';
  compact: boolean;
  onSelectStock?: (code: string, name: string) => void;
}) {
  if (count <= 0 || height <= 0) return null;
  const isMax = variant === 'max';
  const shown = stocks.slice(0, compact ? 1 : 4);
  return (
    <div
      className={`pointer-events-auto absolute w-[84px] rounded border px-1 py-0.5 text-[10px] leading-tight shadow-sm backdrop-blur-sm ${
        isMax
          ? 'border-orange-400/80 bg-white/95 dark:border-orange-500/70 dark:bg-slate-950/90'
          : 'border-amber-300/90 bg-white/95 dark:border-amber-400/70 dark:bg-slate-950/90'
      }`}
      style={{
        left: `${(x / WIDTH) * 100}%`,
        top: `${(y / HEIGHT) * 100}%`,
        transform: isMax ? 'translate(-50%, calc(-100% - 6px))' : 'translate(-50%, 10px)',
      }}
    >
      <div
        className={`flex items-center justify-between border-b pb-0.5 font-semibold ${
          isMax
            ? 'border-orange-200 text-orange-600 dark:border-orange-800 dark:text-orange-300'
            : 'border-amber-200 text-amber-700 dark:border-amber-800 dark:text-amber-300'
        }`}
      >
        <span>{height}连板</span>
        <span>[{count}]</span>
      </div>
      <div className="pt-0.5">
        {shown.map((stock) => (
          <button
            key={`${stock.code}-${stock.name}`}
            type="button"
            className="block w-full truncate text-left text-foreground hover:text-orange-600 dark:hover:text-orange-300"
            onClick={(event) => {
              event.stopPropagation();
              if (stock.code) onSelectStock?.(stock.code, stock.name);
            }}
          >
            {stock.name}
          </button>
        ))}
      </div>
    </div>
  );
}

export default function BoardLadderChart({
  series,
  selectedDate,
  onSelectDate,
  onSelectStock,
  framed = true,
}: BoardLadderChartProps) {
  const [hover, setHover] = useState<{ point: MarketEmotionPoint; x: number; y: number } | null>(null);

  const yMax = Math.max(...series.map((item) => Math.max(item.maxHeight, item.secondHeight)), 1) + 1;
  const plotLeft = PAD.left;
  const plotRight = WIDTH - PAD.right;
  const plotTop = PAD.top;
  const plotBottom = HEIGHT - PAD.bottom;
  const maxPath = buildLinePathFromBounds(
    series.map((item) => item.maxHeight),
    plotLeft,
    plotRight,
    plotTop,
    plotBottom,
    yMax
  );
  const secondPath = buildLinePathFromBounds(
    series.map((item) => item.secondHeight),
    plotLeft,
    plotRight,
    plotTop,
    plotBottom,
    yMax
  );
  const compact = series.length > 8;

  if (series.length === 0) {
    return (
      <div className="px-5 py-10 text-center text-sm text-muted-foreground">暂无连板数据</div>
    );
  }

  const chart = (
    <div className="relative" onMouseLeave={() => setHover(null)}>
      <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} className="h-auto w-full">
        {Array.from({ length: yMax + 1 }, (_, value) => {
          const y = pointY(value, yMax, plotTop, plotBottom);
          return (
            <g key={`y-${value}`}>
              <line
                x1={plotLeft}
                y1={y}
                x2={plotRight}
                y2={y}
                stroke="rgba(148,163,184,0.16)"
                strokeDasharray="4 6"
              />
              <text x="10" y={y + 4} fontSize="11" fill="currentColor" opacity="0.6">
                {value}板
              </text>
            </g>
          );
        })}
        <path d={secondPath} fill="none" stroke={SECOND_STROKE} strokeWidth="2" strokeLinecap="round" />
        <path d={maxPath} fill="none" stroke={MAX_STROKE} strokeWidth="2.4" strokeLinecap="round" />
        {series.map((point, index) => {
          const x = pointX(index, series.length, plotLeft, plotRight);
          const maxY = pointY(point.maxHeight, yMax, plotTop, plotBottom);
          const secondY = pointY(point.secondHeight, yMax, plotTop, plotBottom);
          const active = selectedDate === point.fullDate;
          const selectPoint = () => onSelectDate(point.fullDate);
          const showHover = () => setHover({ point, x, y: maxY });
          return (
            <g key={point.fullDate}>
              <line x1={x} y1={plotTop} x2={x} y2={plotBottom} stroke="rgba(148,163,184,0.08)" />
              <rect
                x={x - 18}
                y={plotTop}
                width={36}
                height={plotBottom - plotTop}
                fill="transparent"
                onMouseEnter={showHover}
                onClick={selectPoint}
              />
              {point.secondHeight > 0 ? (
                <circle
                  cx={x}
                  cy={secondY}
                  r={active ? 6 : 5}
                  fill={SECOND_STROKE}
                  stroke="white"
                  strokeWidth="1.5"
                  onMouseEnter={showHover}
                  onClick={selectPoint}
                />
              ) : null}
              <circle
                cx={x}
                cy={maxY}
                r={active ? 7 : 6}
                fill={MAX_STROKE}
                stroke="white"
                strokeWidth="1.6"
                onMouseEnter={showHover}
                onClick={selectPoint}
              />
              <text x={x} y={HEIGHT - 14} textAnchor="middle" fontSize="11" fill="currentColor" opacity="0.7">
                {point.label}
              </text>
            </g>
          );
        })}
      </svg>

      <div className="pointer-events-none absolute inset-0">
        {series.map((point, index) => {
          const x = pointX(index, series.length, plotLeft, plotRight);
          const maxY = pointY(point.maxHeight, yMax, plotTop, plotBottom);
          const secondY = pointY(point.secondHeight, yMax, plotTop, plotBottom);
          return (
            <React.Fragment key={`label-${point.fullDate}`}>
              <StockLabel
                height={point.maxHeight}
                count={point.maxCount}
                stocks={codesForHeight(point, point.maxHeight)}
                x={x}
                y={maxY}
                variant="max"
                compact={compact}
                onSelectStock={onSelectStock}
              />
              <StockLabel
                height={point.secondHeight}
                count={point.secondCount}
                stocks={codesForHeight(point, point.secondHeight)}
                x={x}
                y={secondY}
                variant="second"
                compact={compact}
                onSelectStock={onSelectStock}
              />
            </React.Fragment>
          );
        })}
      </div>

      {hover ? (
        <div
          className="absolute z-20 max-h-72 w-56 overflow-auto rounded-xl border border-orange-200/70 bg-white/95 px-3 py-2 text-xs shadow-[0_12px_30px_rgba(15,23,42,0.12)] dark:border-orange-800/40 dark:bg-slate-950/95"
          style={{
            left: `min(calc(${(hover.x / WIDTH) * 100}% + 12px), calc(100% - 15rem))`,
            top: `max(8px, calc(${(hover.y / HEIGHT) * 100}% - 24px))`,
          }}
        >
          <div className="font-medium text-foreground">
            {hover.point.fullDate} ({hover.point.label})
          </div>
          <div className="mt-2 space-y-2">
            {hover.point.allLevels.length > 0 ? (
              hover.point.allLevels.map((level: MarketBoardLevel) => (
                <div key={`${hover.point.fullDate}-${level.height}`}>
                  <div className={`font-semibold ${levelTone(level.height)}`}>
                    {level.height}连板 ({level.number}只)
                  </div>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {(level.code_list.length > 0
                      ? level.code_list
                      : level.stocks.map((name) => ({ name, code: '' }))
                    ).map((stock) => (
                      <button
                        key={`${level.height}-${stock.code || stock.name}`}
                        type="button"
                        className="rounded border border-border/60 bg-muted/30 px-1.5 py-0.5 text-[11px] text-foreground hover:border-orange-300 hover:text-orange-600"
                        onClick={(event) => {
                          event.stopPropagation();
                          if (stock.code) onSelectStock?.(stock.code, stock.name);
                        }}
                      >
                        {stock.name}
                      </button>
                    ))}
                  </div>
                </div>
              ))
            ) : (
              <div className="text-muted-foreground">无详细信息</div>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );

  if (!framed) {
    return (
      <div className="px-3 pb-3 pt-2">
        <div className="mb-2 flex items-center gap-4 px-2 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-2">
            <span className="h-2.5 w-2.5 rounded-full bg-orange-500" />
            最高板
          </span>
          <span className="inline-flex items-center gap-2">
            <span className="h-2.5 w-2.5 rounded-full bg-amber-300" />
            次高板
          </span>
        </div>
        {chart}
      </div>
    );
  }

  return (
    <div className="rounded-[24px] border border-border/70 bg-background/60 p-5">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div>
          <div className="text-sm font-semibold text-foreground">涨停板连板</div>
          <div className="mt-1 text-xs text-muted-foreground">最高板 / 次高板，点旁为当日梯队股票。</div>
        </div>
        <div className="flex items-center gap-4 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-2">
            <span className="h-2.5 w-2.5 rounded-full bg-orange-500" />
            最高板
          </span>
          <span className="inline-flex items-center gap-2">
            <span className="h-2.5 w-2.5 rounded-full bg-amber-300" />
            次高板
          </span>
        </div>
      </div>
      {chart}
    </div>
  );
}
