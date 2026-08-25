'use client';

import React from 'react';
import BoardLadderChart from '@/components/BoardLadderChart';
import type { MarketEmotionPoint } from '@/lib/market/types';

type ShortEmotionChartProps = {
  mode: 'intraday' | 'short';
  cycle: 1 | 3 | 5 | 10 | 20;
  series: MarketEmotionPoint[];
  selectedDate?: string | null;
  onSelectDate?: (fullDate: string) => void;
  onSelectStock?: (code: string, name: string) => void;
};

const QXZB_SRC =
  'http://hot.icfqs.com:7615/site/tdx-pc-pcwebcall/page-qxzb.html?color=0&bkcolor=000000';

export default function ShortEmotionChart({
  mode,
  cycle,
  series,
  selectedDate,
  onSelectDate,
  onSelectStock,
}: ShortEmotionChartProps) {
  if (mode === 'intraday') {
    return (
      <div className="-mx-5 -mb-5">
        <iframe
          className="block w-full border-0 bg-black"
          src={QXZB_SRC}
          title="情绪行情"
          style={{ height: 400 }}
        />
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
