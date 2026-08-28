import {
  buildXgbConceptIndex,
  loadBigFace,
  loadHot,
  loadIntradayEmotion,
  loadPlateUniverse,
  loadPlates,
  loadShortEmotion,
  loadStrong,
  loadSurgeLimitUp,
  loadTopicPools,
  loadTradingDays,
  loadTurnover,
  loadXgbLimitUpPool,
  stockConcepts,
  type TopicStock,
} from './api';
import { clearMarketCache } from './client';
import { buildRelaySnapshot } from './cycle';
import { formatPlateFlow, formatShortDate, matchPlate, normalizeCode } from './format';
import { buildSectorTrendData } from './sectorTrend';
import {
  DEFAULT_MARKET_SNAPSHOT,
  type MarketBoardLevel,
  type MarketEmotionPoint,
  type MarketGeeseRow,
  type MarketGeeseStock,
  type MarketMainlineLane,
  type MarketMainlineStock,
  type MarketSnapshot,
} from './types';

export { DEFAULT_MARKET_SNAPSHOT } from './types';
export type { MarketSnapshot } from './types';

const MAINLINE_LIMIT = 3;
const MAINLINE_FOLLOWERS = 8;
const DEFAULT_EMOTION_DAYS = 5;
const FULL_EMOTION_DAYS = 20;

export type MarketEmotionSnapshot = {
  emotionSeries: MarketEmotionPoint[];
  intradayEmotion: MarketSnapshot['intradayEmotion'];
  shortEmotion: MarketSnapshot['shortEmotion'];
  facts: string[];
};

export type MarketTrendSnapshot = {
  turnover: MarketSnapshot['turnover'];
  sectorTrend: MarketSnapshot['sectorTrend'];
  facts: string[];
};

export type MarketMainlineSnapshot = {
  mainlineLanes: MarketMainlineLane[];
  facts: string[];
};

export type MarketPayoffSnapshot = {
  payoffLists: MarketSnapshot['payoffLists'];
  facts: string[];
};

type TopicPoolsBundle = {
  ztByDate: Map<string, TopicStock[]>;
  zbByDate: Map<string, TopicStock[]>;
  dtByDate: Map<string, TopicStock[]>;
};

type LatestMarketContext = {
  latestDay: string;
  pools: TopicPoolsBundle;
  latestZt: TopicStock[];
  latestZb: TopicStock[];
  latestDt: TopicStock[];
  surge: Awaited<ReturnType<typeof loadSurgeLimitUp>>;
  conceptIndex: Map<string, string[]>;
  priorityNames: string[];
  baseUniverse: Awaited<ReturnType<typeof loadPlateUniverse>>;
  trendUniverse: Awaited<ReturnType<typeof loadPlateUniverse>>;
};

function joinNames(names: Array<string | undefined>, limit = 2): string {
  const values = names.filter((name): name is string => Boolean(name)).slice(0, limit);
  return values.length > 0 ? values.join('、') : '--';
}

function settledValue<T>(result: PromiseSettledResult<T>, fallback: T): T {
  return result.status === 'fulfilled' ? result.value : fallback;
}

function boardHeight(stock: TopicStock): number {
  return Math.max(1, stock.lbc || 1);
}

function groupZtByHeight(list: TopicStock[]): Map<number, TopicStock[]> {
  const grouped = new Map<number, TopicStock[]>();
  list.forEach((stock) => {
    const height = boardHeight(stock);
    const rows = grouped.get(height) || [];
    rows.push(stock);
    grouped.set(height, rows);
  });
  grouped.forEach((rows) => rows.sort((a, b) => a.time - b.time));
  return grouped;
}

function attachConcepts(list: TopicStock[], index: Map<string, string[]>): TopicStock[] {
  if (index.size === 0) return list;
  return list.map((stock) => {
    const concepts = index.get(normalizeCode(stock.code));
    return concepts && concepts.length > 0 ? { ...stock, concepts } : stock;
  });
}

function plateOf(stock: TopicStock): string | undefined {
  const name = stock.reason?.trim();
  if (!name || name === '其他') return undefined;
  return name.split(/[、,/|]/)[0]?.trim() || undefined;
}

function toGeeseStock(stock: TopicStock, result: MarketGeeseStock['result'], note: string): MarketGeeseStock {
  return { name: stock.name, code: stock.code, change: '', note, result, plate: plateOf(stock) };
}

function deriveGeese(prevZt: TopicStock[], currZt: TopicStock[], zbList: TopicStock[]): MarketGeeseRow[] {
  const prevByHeight = groupZtByHeight(prevZt);
  const currByHeight = groupZtByHeight(currZt);
  const currByCode = new Map(currZt.map((stock) => [normalizeCode(stock.code), stock]));
  const zbByCode = new Map(zbList.map((stock) => [normalizeCode(stock.code), stock]));
  const rows: MarketGeeseRow[] = [...prevByHeight.keys()]
    .sort((a, b) => b - a)
    .map((height) => {
      const prevStocks = prevByHeight.get(height) || [];
      const nextCodes = new Set((currByHeight.get(height + 1) || []).map((stock) => normalizeCode(stock.code)));
      const stocks = prevStocks.map((stock) => {
        const code = normalizeCode(stock.code);
        const today = currByCode.get(code);
        if (nextCodes.has(code) || (today && boardHeight(today) > height)) {
          return toGeeseStock(today || stock, 'success', '晋级');
        }
        const broken = zbByCode.get(code);
        if (broken) return toGeeseStock(broken, 'broken', '炸板');
        return toGeeseStock(stock, 'failed', '断板');
      });
      return {
        progress: `${height}进${height + 1}`,
        numerator: stocks.filter((stock) => stock.result === 'success').length,
        denominator: stocks.length,
        stocks,
      };
    });

  const firstBoard = currByHeight.get(1) || [];
  if (firstBoard.length > 0) {
    rows.push({
      progress: '首板',
      numerator: firstBoard.length,
      denominator: firstBoard.length,
      stocks: firstBoard.map((stock) => toGeeseStock(stock, 'success', '涨停')),
    });
  }
  return rows.filter((row) => row.denominator > 0);
}

function emotionFromZt(date: string, ztList: TopicStock[], geeseRows: MarketGeeseRow[]): MarketEmotionPoint | null {
  const grouped = groupZtByHeight(ztList);
  const heights = [...grouped.keys()].sort((a, b) => b - a);
  const maxHeight = heights[0] || 0;
  if (maxHeight === 0) return null;
  const allLevels: MarketBoardLevel[] = heights.map((height) => {
    const stocks = grouped.get(height) || [];
    return {
      height,
      number: stocks.length,
      stocks: stocks.map((stock) => stock.name),
      code_list: stocks.map((stock) => ({ name: stock.name, code: stock.code })),
    };
  });
  const maxData = allLevels[0];
  const secondData = allLevels[1] || { height: 0, number: 0, stocks: [], code_list: [] };
  return {
    label: formatShortDate(date).replace('/', '-'),
    fullDate: date,
    maxHeight,
    secondHeight: secondData.height,
    maxCount: maxData.number,
    secondCount: secondData.number,
    maxNames: maxData.stocks,
    secondNames: secondData.stocks,
    allLevels,
    geeseRows,
  };
}

function toMainlineStock(stock: TopicStock): MarketMainlineStock {
  return { name: stock.name, code: stock.code, lbc: boardHeight(stock) };
}

function buildTopicFundMap(...groups: TopicStock[][]): Map<string, number> {
  const funds = new Map<string, number>();
  groups.flat().forEach((stock) => {
    stockConcepts(stock).forEach((name) => {
      funds.set(name, (funds.get(name) || 0) + (stock.fund || 0) / 1e8);
    });
  });
  return funds;
}

function buildMainlineLanes(
  plates: Awaited<ReturnType<typeof loadPlates>>,
  ztPool: TopicStock[],
  topicFunds: Map<string, number>
): MarketMainlineLane[] {
  const grouped = new Map<string, TopicStock[]>();
  ztPool.forEach((stock) => {
    stockConcepts(stock).forEach((name) => {
      const rows = grouped.get(name) || [];
      rows.push(stock);
      grouped.set(name, rows);
    });
  });

  return [...grouped.entries()]
    .map(([name, stocks]) => {
      const unique = new Map<string, TopicStock>();
      stocks.forEach((stock) => {
        const code = normalizeCode(stock.code) || stock.name;
        if (!unique.has(code)) unique.set(code, stock);
      });
      const sorted = [...unique.values()].sort((a, b) => b.lbc - a.lbc || a.time - b.time);
      const plate = matchPlate(plates, name);
      const fallbackNetFlow = topicFunds.get(name) || 0;
      const ztCount = sorted.length;
      const maxHeight = sorted[0] ? boardHeight(sorted[0]) : 0;
      const heightSum = sorted.reduce((sum, stock) => sum + boardHeight(stock), 0);
      const netFlow = plate?.netFlow || fallbackNetFlow;
      return {
        name,
        plate,
        sorted,
        netFlow,
        ztCount,
        maxHeight,
        score: ztCount * 12 + maxHeight * 18 + heightSum * 4 + netFlow * 0.8,
      };
    })
    .sort((a, b) => b.score - a.score || b.ztCount - a.ztCount || b.netFlow - a.netFlow)
    .slice(0, MAINLINE_LIMIT)
    .map((item) => ({
      name: item.name,
      value: item.netFlow !== 0 ? formatPlateFlow(item.netFlow) : '--',
      change: item.plate?.change || 0,
      netFlow: item.netFlow,
      ztCount: item.ztCount,
      maxHeight: item.maxHeight,
      upCount: item.plate?.upCount || 0,
      downCount: item.plate?.downCount || 0,
      leader: item.sorted[0] ? toMainlineStock(item.sorted[0]) : null,
      followers: item.sorted.slice(1, MAINLINE_FOLLOWERS + 1).map(toMainlineStock),
    }));
}

let inflight: Promise<MarketSnapshot> | null = null;

function emotionFacts(series: MarketEmotionPoint[]): string[] {
  const latest = series[series.length - 1];
  if (!latest) return DEFAULT_MARKET_SNAPSHOT.diagnostics.情绪.facts;
  return [
    `最高板 ${joinNames(latest.maxNames, 2)} ${latest.maxHeight}板`,
    `次高板 ${joinNames(latest.secondNames, 2)} ${latest.secondHeight}板`,
    `最高板家数 ${latest.maxCount}只`,
  ];
}

function trendFacts(turnover: MarketSnapshot['turnover']): string[] {
  if (!turnover) return DEFAULT_MARKET_SNAPSHOT.diagnostics.趋势.facts;
  return [
    `当前成交 ${turnover.currentText}`,
    `预估全天 ${turnover.predictText}`,
    `较昨日 ${turnover.changeText}`,
  ];
}

function mainlineFacts(lanes: MarketMainlineLane[]): string[] {
  if (lanes.length === 0) return DEFAULT_MARKET_SNAPSHOT.diagnostics.主线.facts;
  const top = lanes[0];
  return [
    `${top.name} 涨停${top.ztCount}只${top.maxHeight > 0 ? ` 最高${top.maxHeight}板` : ''}`,
    `资金 ${lanes.slice(0, 2).map((lane) => `${lane.name} ${lane.value}`).join(' / ')}`,
    `龙头股 ${top.leader?.name || '--'}`,
  ];
}

function payoffFacts(payoffLists: MarketSnapshot['payoffLists']): string[] {
  return [
    `强势股 ${joinNames(payoffLists.strong.map((item) => item.name))}`,
    `热榜股 ${joinNames(payoffLists.hot.map((item) => item.name))}`,
    `大面代表 ${joinNames(payoffLists.bigface.map((item) => item.name))}`,
  ];
}

function priorityPlateNames(...groups: TopicStock[][]): string[] {
  const seen = new Set<string>();
  groups.flat().forEach((stock) => {
    stockConcepts(stock).forEach((name) => {
      if (seen.has(name)) return;
      seen.add(name);
    });
  });
  return Array.from(seen);
}

function appendPriorityNames(base: string[], extras: string[]): string[] {
  const seen = new Set(base);
  extras.forEach((name) => {
    const value = name.trim();
    if (!value || value === '其他' || seen.has(value)) return;
    seen.add(value);
    base.push(value);
  });
  return base;
}

function emptyPools(): TopicPoolsBundle {
  return {
    ztByDate: new Map<string, TopicStock[]>(),
    zbByDate: new Map<string, TopicStock[]>(),
    dtByDate: new Map<string, TopicStock[]>(),
  };
}

async function loadLatestMarketContext(force = false): Promise<LatestMarketContext> {
  const tradingDays = await loadTradingDays(1, force);
  const latestDay = tradingDays[tradingDays.length - 1] || '';
  const [pools, surge, xgbLimitUp, baseUniverse] = await Promise.all([
    latestDay ? loadTopicPools([latestDay], force) : Promise.resolve(emptyPools()),
    loadSurgeLimitUp(force),
    loadXgbLimitUpPool(force),
    loadPlateUniverse({ force }),
  ]);
  const conceptIndex = buildXgbConceptIndex(xgbLimitUp);
  const latestZt = latestDay
    ? attachConcepts(pools.ztByDate.get(latestDay) || [], conceptIndex)
    : [];
  const latestZb = latestDay ? pools.zbByDate.get(latestDay) || [] : [];
  const latestDt = latestDay ? pools.dtByDate.get(latestDay) || [] : [];
  const priorityNames = appendPriorityNames(
    priorityPlateNames(latestZt),
    surge.flatMap((item) => item.plates)
  );
  const trendUniverse =
    priorityNames.length === 0 || priorityNames.every((name) => matchPlate(baseUniverse, name))
      ? baseUniverse
      : await loadPlateUniverse({ priorityNames, force });

  return {
    latestDay,
    pools,
    latestZt,
    latestZb,
    latestDt,
    surge,
    conceptIndex,
    priorityNames,
    baseUniverse,
    trendUniverse,
  };
}

async function buildEmotionSnapshot(limit: number, force = false): Promise<MarketEmotionSnapshot> {
  const [tradingDays, intradayEmotion, shortEmotion] = await Promise.all([
    loadTradingDays(limit, force),
    loadIntradayEmotion(force),
    loadShortEmotion(limit, force),
  ]);
  const pools =
    tradingDays.length > 0
      ? await loadTopicPools(tradingDays, force)
      : {
          ztByDate: new Map<string, TopicStock[]>(),
          zbByDate: new Map<string, TopicStock[]>(),
          dtByDate: new Map<string, TopicStock[]>(),
        };

  const emotionSeries = tradingDays
    .map((day, index) => {
      const prev = index > 0 ? tradingDays[index - 1] : '';
      const zt = pools.ztByDate.get(day) || [];
      const geese = deriveGeese(prev ? pools.ztByDate.get(prev) || [] : [], zt, pools.zbByDate.get(day) || []);
      return emotionFromZt(day, zt, geese);
    })
    .filter((item): item is MarketEmotionPoint => item !== null);

  return {
    emotionSeries,
    intradayEmotion,
    shortEmotion,
    facts: emotionFacts(emotionSeries),
  };
}

export async function loadEmotionSnapshot(limit = FULL_EMOTION_DAYS, force = false): Promise<MarketEmotionSnapshot> {
  return buildEmotionSnapshot(limit, force);
}

export async function loadTrendSnapshot(force = false): Promise<MarketTrendSnapshot> {
  const [turnover, context] = await Promise.all([loadTurnover(force), loadLatestMarketContext(force)]);
  const eventAddedCount = context.trendUniverse.filter((plate) => !context.baseUniverse.some((base) => base.code === plate.code)).length;
  const trendData = buildSectorTrendData(context.latestDay, context.trendUniverse, context.latestZt, context.surge);
  return {
    turnover,
    sectorTrend: {
      ...trendData,
      sampleStats: {
        baseCount: context.baseUniverse.length,
        eventAddedCount,
        finalCount: trendData.topics.length,
      },
    },
    facts: trendFacts(turnover),
  };
}

export async function loadMainlineSnapshot(force = false): Promise<MarketMainlineSnapshot> {
  const context = await loadLatestMarketContext(force);
  const mainlineLanes = buildMainlineLanes(
    context.trendUniverse,
    context.latestZt,
    buildTopicFundMap(context.latestZt, context.latestZb, context.latestDt)
  );
  return {
    mainlineLanes,
    facts: mainlineFacts(mainlineLanes),
  };
}

export async function loadPayoffSnapshot(force = false): Promise<MarketPayoffSnapshot> {
  const tradingDays = await loadTradingDays(FULL_EMOTION_DAYS, force);
  const [strong, hot, bigface] = await Promise.all([
    loadStrong(force),
    loadHot(force),
    loadBigFace(tradingDays, force),
  ]);
  const payoffLists = { strong, hot, bigface };
  return {
    payoffLists,
    facts: payoffFacts(payoffLists),
  };
}

export async function loadMarketSummarySnapshot(force = false): Promise<MarketSnapshot> {
  const snapshot: MarketSnapshot = JSON.parse(JSON.stringify(DEFAULT_MARKET_SNAPSHOT));
  const tradingDays = await loadTradingDays(FULL_EMOTION_DAYS, force);
  const emotionDays = tradingDays.slice(-DEFAULT_EMOTION_DAYS);
  const [turnoverResult, contextResult, strongResult, hotResult, bigFaceResult] = await Promise.allSettled([
    loadTurnover(force),
    loadLatestMarketContext(force),
    loadStrong(force),
    loadHot(force),
    loadBigFace(tradingDays, force),
  ]);

  const turnover = settledValue(turnoverResult, null);
  if (turnover) {
    snapshot.turnover = turnover;
    snapshot.diagnostics.趋势.facts = trendFacts(turnover);
  }

  const context = settledValue(contextResult, null);
  if (context) {
    const latestEmotion = emotionFromZt(
      context.latestDay,
      context.latestZt,
      deriveGeese([], context.latestZt, context.pools.zbByDate.get(context.latestDay) || [])
    );
    snapshot.diagnostics.情绪.facts = emotionFacts(latestEmotion ? [latestEmotion] : []);

    const lanes = buildMainlineLanes(
      context.trendUniverse,
      context.latestZt,
      buildTopicFundMap(context.latestZt, context.latestZb, context.latestDt)
    );
    snapshot.mainlineLanes = lanes;
    snapshot.diagnostics.主线.facts = mainlineFacts(lanes);
  }

  snapshot.payoffLists.strong = settledValue(strongResult, []);
  snapshot.payoffLists.hot = settledValue(hotResult, []);
  snapshot.payoffLists.bigface = settledValue(bigFaceResult, []);
  snapshot.diagnostics.赚钱效应.facts = payoffFacts(snapshot.payoffLists);

  if (emotionDays.length === 0) {
    snapshot.diagnostics.情绪.facts = DEFAULT_MARKET_SNAPSHOT.diagnostics.情绪.facts;
  }

  return snapshot;
}

export async function loadMarketSnapshot(force = false): Promise<MarketSnapshot> {
  if (force) {
    await clearMarketCache();
    return buildSnapshot();
  }
  if (inflight) return inflight;
  inflight = buildSnapshot().finally(() => {
    inflight = null;
  });
  return inflight;
}

async function buildSnapshot(): Promise<MarketSnapshot> {
  const snapshot: MarketSnapshot = JSON.parse(JSON.stringify(DEFAULT_MARKET_SNAPSHOT));
  const tradingDays = await loadTradingDays(FULL_EMOTION_DAYS);
  const latestDay = tradingDays[tradingDays.length - 1] || '';
  const emotionDays = tradingDays.slice(-DEFAULT_EMOTION_DAYS);

  const [turnoverResult, plateUniverseResult, poolResult, surgeResult, xgbLimitUpResult, strongResult, hotResult, bigFaceResult] = await Promise.allSettled([
    loadTurnover(),
    loadPlateUniverse({ priorityNames: [] }),
    tradingDays.length > 0
      ? loadTopicPools(tradingDays)
      : Promise.resolve({
          ztByDate: new Map<string, TopicStock[]>(),
          zbByDate: new Map<string, TopicStock[]>(),
          dtByDate: new Map<string, TopicStock[]>(),
        }),
    loadSurgeLimitUp(),
    loadXgbLimitUpPool(),
    loadStrong(),
    loadHot(),
    loadBigFace(tradingDays),
  ]);

  const turnover = settledValue(turnoverResult, null);
  if (turnover) {
    snapshot.turnover = turnover;
    snapshot.diagnostics.趋势.facts = [
      `当前成交 ${turnover.currentText}`,
      `预估全天 ${turnover.predictText}`,
      `较昨日 ${turnover.changeText}`,
    ];
  }

  const pools = settledValue(poolResult, {
    ztByDate: new Map<string, TopicStock[]>(),
    zbByDate: new Map<string, TopicStock[]>(),
    dtByDate: new Map<string, TopicStock[]>(),
  });
  const plateUniverse = settledValue(plateUniverseResult, []);
  const conceptIndex = buildXgbConceptIndex(settledValue(xgbLimitUpResult, []));
  const latestZt = attachConcepts(pools.ztByDate.get(latestDay) || [], conceptIndex);
  const latestZb = pools.zbByDate.get(latestDay) || [];
  const latestDt = pools.dtByDate.get(latestDay) || [];
  const surge = settledValue(surgeResult, []);
  const priorityNames = appendPriorityNames(
    priorityPlateNames(latestZt),
    surge.flatMap((item) => item.plates)
  );
  const plates = plateUniverse.length > 0 ? plateUniverse : await loadPlateUniverse({ priorityNames });
  const trendUniverse =
    priorityNames.length === 0 || priorityNames.every((name) => matchPlate(plates, name))
      ? plates
      : await loadPlateUniverse({ priorityNames });

  snapshot.emotionSeries = emotionDays
    .map((day, index) => {
      const prev = index > 0 ? emotionDays[index - 1] : '';
      const zt = pools.ztByDate.get(day) || [];
      const geese = deriveGeese(prev ? pools.ztByDate.get(prev) || [] : [], zt, pools.zbByDate.get(day) || []);
      return emotionFromZt(day, zt, geese);
    })
    .filter((item): item is MarketEmotionPoint => item !== null);
  snapshot.diagnostics.情绪.facts = emotionFacts(snapshot.emotionSeries);

  snapshot.relay = buildRelaySnapshot(tradingDays, pools.ztByDate, pools.zbByDate);

  const lanes = buildMainlineLanes(plates, latestZt, buildTopicFundMap(latestZt, latestZb, latestDt));
  snapshot.mainlineLanes = lanes;
  snapshot.diagnostics.主线.facts = mainlineFacts(lanes);

  snapshot.payoffLists.strong = settledValue(strongResult, []);
  snapshot.payoffLists.hot = settledValue(hotResult, []);
  snapshot.payoffLists.bigface = settledValue(bigFaceResult, []);
  snapshot.diagnostics.赚钱效应.facts = payoffFacts(snapshot.payoffLists);

  const trendData = buildSectorTrendData(latestDay, trendUniverse, latestZt, surge);
  const eventAddedCount = trendUniverse.filter((plate) => !plateUniverse.some((base) => base.code === plate.code)).length;
  snapshot.sectorTrend = {
    ...trendData,
    sampleStats: {
      baseCount: plateUniverse.length,
      eventAddedCount,
      finalCount: trendData.topics.length,
    },
  };
  snapshot.diagnostics.趋势.facts = trendFacts(turnover);
  return snapshot;
}
