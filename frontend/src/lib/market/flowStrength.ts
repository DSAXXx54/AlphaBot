/**
 * 资金强度打分（趋势轨迹时序用）。
 *
 * 跨板块可比的统一口径：金额项按"同日候选板块"百分位归一（只表达相对地位，
 * 取代旧的"板块自身 10 日最大净流入"自归一），净占比/大单等比率项保持绝对口径。
 * 与 sectorTrend.candidateRpsScore、mainline 主线打分的跨板块项共用同一百分位习惯用法。
 * 权重与钳制阈值见 strategy.ts 的 flowStrength 节点。
 */
import { getStrategy } from './strategy';
import type { PlateFlowHistoryPoint } from './api';

/** 组内百分位（0~100，最高 100） */
export function percentileRank(values: number[], value: number): number {
  if (values.length <= 1) return 100;
  const ranked = [...values].sort((a, b) => b - a);
  const index = ranked.findIndex((item) => item === value);
  const rank = index === -1 ? ranked.length : index + 1;
  return Math.max(0, Math.min(100, ((ranked.length - rank) / (ranked.length - 1)) * 100));
}

function clamp1(value: number): number {
  return Math.max(-1, Math.min(1, value));
}

/**
 * 资金强度 0~100，基线 50：金额项（同日百分位）+ 净占比（主项）+ 大单 − 防守。
 * 权重为起点值，待次日溢价回测校准。
 */
export function flowStrengthScore(
  point: Pick<
    PlateFlowHistoryPoint,
    'mainNetInflowRatio' | 'superLargeNetInflowRatio' | 'largeNetInflowRatio' | 'midNetInflowRatio' | 'smallNetInflowRatio'
  >,
  amountPct: number
): number {
  const { amount, ratio, bigOrder, defensive, ratioClamp, bigClamp, defClamp } = getStrategy().flowStrength;
  const amountComponent = clamp1((amountPct - 50) / 50);
  const ratioComponent = clamp1(point.mainNetInflowRatio / ratioClamp);
  const bigOrderComponent = clamp1(
    (point.superLargeNetInflowRatio + point.largeNetInflowRatio) / bigClamp
  );
  const defensivePenalty = clamp1((point.midNetInflowRatio + point.smallNetInflowRatio) / defClamp);
  return Math.max(0, Math.min(100, 50 + amountComponent * amount + ratioComponent * ratio + bigOrderComponent * bigOrder - defensivePenalty * defensive));
}
