'use client';

import type { ReactElement } from 'react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';

const EASTMONEY_PICTURE_TOKEN = '44c9d251add88e27b65ed86506f6e5da';
const EASTMONEY_PICTURE_RT = '1855';

function eastmoneyStockId(code: string): string | null {
  const normalized = (code || '').trim().toUpperCase().replace(/\.(SZ|SS|SH|BJ)$/, '');
  if (!/^\d{6}$/.test(normalized)) return null;
  if (/^(6|5|9)/.test(normalized)) return `${normalized}1`;
  if (/^(0|2|3)/.test(normalized)) return `${normalized}2`;
  if (/^(4|8)/.test(normalized)) return `${normalized}0`;
  return null;
}

function eastmoneyPictureUrl(code: string, imageType: 'KXL' | 'r'): string | null {
  const id = eastmoneyStockId(code);
  if (!id) return null;
  const base =
    imageType === 'KXL'
      ? 'https://webquoteklinepic.eastmoney.com/GetPic.aspx'
      : 'https://webquotepic.eastmoney.com/GetPic.aspx';
  const params = new URLSearchParams({
    id,
    formula: 'MACD',
    imageType,
    token: EASTMONEY_PICTURE_TOKEN,
    rt: EASTMONEY_PICTURE_RT,
  });
  return `${base}?${params.toString()}`;
}

type StockPreviewTooltipProps = {
  code?: string;
  name: string;
  summary?: string;
  children: ReactElement;
};

export function StockPreviewTooltip({ code, name, summary, children }: StockPreviewTooltipProps) {
  const dailyUrl = code ? eastmoneyPictureUrl(code, 'KXL') : null;
  const intradayUrl = code ? eastmoneyPictureUrl(code, 'r') : null;

  // Only stocks with a recognized code get the external chart preview.
  if (!dailyUrl || !intradayUrl) return children;

  return (
    <TooltipProvider delayDuration={160}>
      <Tooltip>
        <TooltipTrigger asChild>{children}</TooltipTrigger>
        <TooltipContent
          side="top"
          align="start"
          sideOffset={10}
          className="w-[720px] rounded-2xl border border-slate-200/75 bg-white/96 p-3 text-slate-700 shadow-[0_18px_36px_rgba(15,23,42,0.16)] backdrop-blur-sm dark:border-slate-800 dark:bg-slate-950/92 dark:text-slate-200"
        >
          {summary ? (
            <div className="mb-2 whitespace-pre-wrap text-[11px] leading-5 text-slate-600 dark:text-slate-300">
              {summary}
            </div>
          ) : null}
          <div className="grid grid-cols-2 gap-2">
            <div className="flex items-center justify-center rounded-xl border border-slate-200/70 bg-slate-50 dark:border-slate-800 dark:bg-slate-900">
              <img
                src={dailyUrl}
                alt={`${name} 日K预览`}
                className="h-[220px] w-full object-contain"
                loading="lazy"
                referrerPolicy="no-referrer"
              />
            </div>
            <div className="flex items-center justify-center rounded-xl border border-slate-200/70 bg-slate-50 dark:border-slate-800 dark:bg-slate-900">
              <img
                src={intradayUrl}
                alt={`${name} 分时预览`}
                className="h-[220px] w-full object-contain"
                loading="lazy"
                referrerPolicy="no-referrer"
              />
            </div>
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
