import type { MarketTrendPanelData, MarketTrendStage, MarketTrendTopic, MarketTrendStockTag } from './types';
import type { PlateFlow, SurgeLimitStock, TopicStock } from './api';
import { isoDate, matchPlate, normalizeCode, normalizePlateName } from './format';

const INFLOW_COLORS = ['#ff5a6f', '#5b8def', '#18b7d8', '#f59e0b', '#14b8a6'];
const OUTFLOW_COLORS = ['#f7bfc5', '#c8d4f2', '#b9e8ee', '#f6d8ae', '#cfe9df'];
const CANDIDATE_LIMIT = 32;

export const EMPTY_SECTOR_TREND: MarketTrendPanelData = {
  range: 20,
  latestDay: '',
  topics: [],
  stockTags: {},
  sampleStats: {
    baseCount: 0,
    eventAddedCount: 0,
    finalCount: 0,
  },
};

function clampScore(value: number): number {
  return Math.max(0, Math.min(100, value));
}

function plateSize(plate: PlateFlow): number {
  return plate.upCount + plate.downCount + plate.flatCount;
}

function percentileRank(values: number[], value: number): number {
  if (values.length <= 1) return 100;
  const ranked = [...values].sort((a, b) => b - a);
  const index = ranked.findIndex((item) => item === value);
  const rank = index === -1 ? ranked.length : index + 1;
  return clampScore(((ranked.length - rank) / (ranked.length - 1)) * 100);
}

function candidateRpsScore(input: {
  changeRank: number;
  netFlowRank: number;
  flowIntensityRank: number;
  breadthRank: number;
  amountRank: number;
}): number {
  const priceScore = input.changeRank;
  const flowScore = input.netFlowRank * 0.65 + input.flowIntensityRank * 0.35;
  const breadthScore = input.breadthRank;
  const activityScore = input.amountRank;
  return clampScore(flowScore * 0.35 + breadthScore * 0.3 + priceScore * 0.2 + activityScore * 0.15);
}

function inferPhase(score: number): MarketTrendStage {
  if (score >= 84) return '主升';
  if (score >= 72) return '发酵';
  if (score >= 58) return '分歧';
  if (score >= 35) return '震荡';
  if (score >= 20) return '退潮';
  return '冷却';
}

function ztCountForPlate(plate: PlateFlow, ztList: TopicStock[], surge: SurgeLimitStock[]): number {
  const byReason = ztList.filter(
    (stock) => matchPlate([plate], stock.reason)?.code === plate.code || normalizePlateName(stock.reason) === normalizePlateName(plate.name)
  ).length;
  const bySurge = surge.filter((stock) =>
    stock.plates.some((name) => name === plate.name || matchPlate([plate], name)?.code === plate.code)
  ).length;
  return Math.max(byReason, bySurge);
}

function highlightedStocksForPlate(plate: PlateFlow, ztList: TopicStock[]): MarketTrendTopic['highlightedStocks'] {
  return ztList
    .filter(
      (stock) => matchPlate([plate], stock.reason)?.code === plate.code || normalizePlateName(stock.reason) === normalizePlateName(plate.name)
    )
    .sort((a, b) => b.lbc - a.lbc || a.time - b.time)
    .slice(0, 8)
    .map((stock) => ({
      code: normalizeCode(stock.code),
      name: stock.name,
      lbc: Math.max(1, stock.lbc || 1),
    }));
}

function pickCandidatePlates(plates: PlateFlow[], ztList: TopicStock[], surge: SurgeLimitStock[]): PlateFlow[] {
  const matched = new Map<string, PlateFlow>();
  const push = (plate?: PlateFlow) => {
    if (!plate?.code || matched.has(plate.code)) return;
    matched.set(plate.code, plate);
  };

  ztList.forEach((stock) => push(matchPlate(plates, stock.reason || '')));
  surge.forEach((stock) => stock.plates.forEach((name) => push(matchPlate(plates, name))));

  const byFlow = [...plates].sort((a, b) => b.netFlow - a.netFlow || b.amount - a.amount).slice(0, 16);
  const byChange = [...plates].sort((a, b) => b.change - a.change || b.netFlow - a.netFlow).slice(0, 16);

  [...byFlow, ...byChange].forEach((plate) => push(plate));
  return Array.from(matched.values()).slice(0, CANDIDATE_LIMIT);
}

function toTopic(
  plate: PlateFlow,
  index: number,
  flow: MarketTrendTopic['flow'],
  colors: string[],
  date: string,
  ztList: TopicStock[],
  surge: SurgeLimitStock[],
  score: number,
  amountChange: number
): MarketTrendTopic {
  const size = Math.max(plateSize(plate), 1);
  const ztCount = ztCountForPlate(plate, ztList, surge);
  const ztRatio = ztCount / size;
  const breadth = plate.upCount / size;
  return {
    id: plate.code,
    name: plate.name,
    color: colors[index % colors.length],
    flow,
    date,
    score,
    changePct: plate.change,
    turnover: plate.amount,
    moneyFlow: plate.netFlow,
    breadth,
    ztRatio,
    amountChange: amountChange * 100,
    phase: inferPhase(score),
    highlightedStocks: highlightedStocksForPlate(plate, ztList),
  };
}

function buildStockTags(ztList: TopicStock[], surge: SurgeLimitStock[]): Record<string, MarketTrendStockTag> {
  const surgeByCode = new Map(surge.map((item) => [normalizeCode(item.code), item]));
  return Object.fromEntries(
    ztList.map((stock) => {
      const lbc = Math.max(1, stock.lbc || 1);
      const code = normalizeCode(stock.code);
      const surgeItem = surgeByCode.get(code);
      return [
        code,
        {
          lbc,
          status: lbc <= 1 ? '首板' : `${lbc}板`,
          analysis: surgeItem?.analysis || undefined,
          plate: stock.reason?.trim() || undefined,
        },
      ];
    })
  );
}

export function buildSectorTrendData(
  latestDay: string,
  plates: PlateFlow[],
  ztList: TopicStock[],
  surge: SurgeLimitStock[] = []
): MarketTrendPanelData {
  const picked = pickCandidatePlates(plates, ztList, surge);
  if (picked.length === 0) return EMPTY_SECTOR_TREND;

  const meanAmount = picked.reduce((sum, plate) => sum + plate.amount, 0) / picked.length || 1;
  const date = isoDate(latestDay);
  const metrics = picked.map((plate) => {
    const size = Math.max(plateSize(plate), 1);
    const breadth = plate.upCount / size;
    const amountChange = (plate.amount - meanAmount) / meanAmount;
    const flowIntensity = plate.amount > 0 ? plate.netFlow / plate.amount : 0;
    return {
      plate,
      breadth,
      amountChange,
      flowIntensity,
    };
  });

  const changeValues = metrics.map((item) => item.plate.change);
  const netFlowValues = metrics.map((item) => item.plate.netFlow);
  const flowIntensityValues = metrics.map((item) => item.flowIntensity);
  const breadthValues = metrics.map((item) => item.breadth);
  const amountValues = metrics.map((item) => item.plate.amount);

  const topics = metrics.map((item, index) => {
    const score = candidateRpsScore({
      changeRank: percentileRank(changeValues, item.plate.change),
      netFlowRank: percentileRank(netFlowValues, item.plate.netFlow),
      flowIntensityRank: percentileRank(flowIntensityValues, item.flowIntensity),
      breadthRank: percentileRank(breadthValues, item.breadth),
      amountRank: percentileRank(amountValues, item.plate.amount),
    });

    return toTopic(
      item.plate,
      index,
      item.plate.netFlow >= 0 ? 'in' : 'out',
      item.plate.netFlow >= 0 ? INFLOW_COLORS : OUTFLOW_COLORS,
      date,
      ztList,
      surge,
      score,
      item.amountChange
    );
  });

  return {
    range: 20,
    latestDay: date,
    topics: topics.sort((a, b) => b.score - a.score || b.moneyFlow - a.moneyFlow),
    stockTags: buildStockTags(ztList, surge),
    sampleStats: {
      baseCount: plates.length,
      eventAddedCount: 0,
      finalCount: topics.length,
    },
  };
}
