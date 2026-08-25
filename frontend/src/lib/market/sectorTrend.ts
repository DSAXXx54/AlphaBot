import type { MarketTrendPanelData, MarketTrendStage, MarketTrendTopic, MarketTrendStockTag } from './types';
import type { PlateFlow, SurgeLimitStock, TopicStock } from './api';
import { isoDate, matchPlate, normalizeCode, normalizePlateName } from './format';

const INFLOW_COLORS = ['#ff5a6f', '#5b8def', '#18b7d8', '#f59e0b', '#14b8a6'];
const OUTFLOW_COLORS = ['#f7bfc5', '#c8d4f2', '#b9e8ee', '#f6d8ae', '#cfe9df'];
const WEIGHTS = { change: 0.25, upRatio: 0.2, ztRatio: 0.25, amountChange: 0.1, netFlow: 0.2 };

export const EMPTY_SECTOR_TREND: MarketTrendPanelData = {
  range: 20,
  latestDay: '',
  topics: [],
  stockTags: {},
};

function clampScore(value: number): number {
  return Math.max(0, Math.min(100, value));
}

function plateSize(plate: PlateFlow): number {
  return plate.upCount + plate.downCount + plate.flatCount;
}

function strengthScore(input: {
  change: number;
  upRatio: number;
  ztRatio: number;
  amountChange: number;
  netFlow: number;
}): number {
  return clampScore(
    WEIGHTS.change * clampScore(50 + (input.change / 8) * 50) +
      WEIGHTS.upRatio * clampScore(input.upRatio * 100) +
      WEIGHTS.ztRatio * clampScore((input.ztRatio / 0.12) * 100) +
      WEIGHTS.amountChange * clampScore(50 + (input.amountChange / 0.8) * 50) +
      WEIGHTS.netFlow * clampScore(50 + (input.netFlow / 20) * 50)
  );
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

function toTopic(
  plate: PlateFlow,
  index: number,
  flow: MarketTrendTopic['flow'],
  colors: string[],
  date: string,
  meanAmount: number,
  ztList: TopicStock[],
  surge: SurgeLimitStock[]
): MarketTrendTopic {
  const size = Math.max(plateSize(plate), 1);
  const ztCount = ztCountForPlate(plate, ztList, surge);
  const ztRatio = ztCount / size;
  const breadth = plate.upCount / size;
  const amountChange = (plate.amount - meanAmount) / meanAmount;
  const score = strengthScore({
    change: plate.change,
    upRatio: breadth,
    ztRatio,
    amountChange,
    netFlow: plate.netFlow,
  });
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

function buildStockTags(ztList: TopicStock[]): Record<string, MarketTrendStockTag> {
  return Object.fromEntries(
    ztList.map((stock) => {
      const lbc = Math.max(1, stock.lbc || 1);
      return [normalizeCode(stock.code), { lbc, status: lbc <= 1 ? '首板' : `${lbc}板` }];
    })
  );
}

export function buildSectorTrendData(
  latestDay: string,
  inflowPlates: PlateFlow[],
  outflowPlates: PlateFlow[],
  ztList: TopicStock[],
  surge: SurgeLimitStock[] = []
): MarketTrendPanelData {
  const picked = [...inflowPlates, ...outflowPlates];
  if (picked.length === 0) return EMPTY_SECTOR_TREND;

  const meanAmount = picked.reduce((sum, plate) => sum + plate.amount, 0) / picked.length || 1;
  const date = isoDate(latestDay);
  const inflowTopics = inflowPlates.map((plate, index) =>
    toTopic(plate, index, 'in', INFLOW_COLORS, date, meanAmount, ztList, surge)
  );
  const outflowTopics = outflowPlates.map((plate, index) =>
    toTopic(plate, index, 'out', OUTFLOW_COLORS, date, meanAmount, ztList, surge)
  );

  return {
    range: 20,
    latestDay: date,
    topics: [...inflowTopics, ...outflowTopics].sort((a, b) => b.score - a.score || b.moneyFlow - a.moneyFlow),
    stockTags: buildStockTags(ztList),
  };
}
