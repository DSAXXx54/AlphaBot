import { loadBigFace, loadHot, loadPlateFlows, loadPlates, loadStrong, loadSurgeLimitUp, loadTopicPools, loadTradingDays, loadTurnover, type TopicStock } from './api';
import { clearMarketCache } from './client';
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

function buildMainlineLanes(plates: Awaited<ReturnType<typeof loadPlates>>, ztPool: TopicStock[]): MarketMainlineLane[] {
  const grouped = new Map<string, TopicStock[]>();
  ztPool.forEach((stock) => {
    const name = stock.reason?.trim();
    if (!name || name === '其他') return;
    const rows = grouped.get(name) || [];
    rows.push(stock);
    grouped.set(name, rows);
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
      const ztCount = sorted.length;
      const maxHeight = sorted[0] ? boardHeight(sorted[0]) : 0;
      const heightSum = sorted.reduce((sum, stock) => sum + boardHeight(stock), 0);
      const netFlow = plate?.netFlow || 0;
      return {
        name,
        plate,
        sorted,
        ztCount,
        maxHeight,
        score: ztCount * 12 + maxHeight * 18 + heightSum * 4 + netFlow * 0.8,
      };
    })
    .sort((a, b) => b.score - a.score || b.ztCount - a.ztCount || (b.plate?.netFlow || 0) - (a.plate?.netFlow || 0))
    .slice(0, MAINLINE_LIMIT)
    .map((item) => ({
      name: item.name,
      value: item.plate ? formatPlateFlow(item.plate.netFlow) : '--',
      change: item.plate?.change || 0,
      netFlow: item.plate?.netFlow || 0,
      ztCount: item.ztCount,
      maxHeight: item.maxHeight,
      upCount: item.plate?.upCount || 0,
      downCount: item.plate?.downCount || 0,
      leader: item.sorted[0] ? toMainlineStock(item.sorted[0]) : null,
      followers: item.sorted.slice(1, MAINLINE_FOLLOWERS + 1).map(toMainlineStock),
    }));
}

let inflight: Promise<MarketSnapshot> | null = null;

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
  const tradingDays = await loadTradingDays();
  const latestDay = tradingDays[tradingDays.length - 1] || '';

  const [turnoverResult, plateFlowResult, poolResult, surgeResult, strongResult, hotResult, bigFaceResult] = await Promise.allSettled([
    loadTurnover(),
    loadPlateFlows(),
    tradingDays.length > 0
      ? loadTopicPools(tradingDays)
      : Promise.resolve({
          ztByDate: new Map<string, TopicStock[]>(),
          zbByDate: new Map<string, TopicStock[]>(),
          dtByDate: new Map<string, TopicStock[]>(),
        }),
    loadSurgeLimitUp(),
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
  const plateFlows = settledValue(plateFlowResult, { inflow: [], outflow: [] });
  const latestZt = pools.ztByDate.get(latestDay) || [];
  const plates = [...plateFlows.inflow, ...plateFlows.outflow];

  snapshot.emotionSeries = tradingDays
    .map((day, index) => {
      const prev = index > 0 ? tradingDays[index - 1] : '';
      const zt = pools.ztByDate.get(day) || [];
      const geese = deriveGeese(prev ? pools.ztByDate.get(prev) || [] : [], zt, pools.zbByDate.get(day) || []);
      return emotionFromZt(day, zt, geese);
    })
    .filter((item): item is MarketEmotionPoint => item !== null);

  const latest = snapshot.emotionSeries[snapshot.emotionSeries.length - 1];
  if (latest) {
    snapshot.diagnostics.情绪.facts = [
      `最高板 ${joinNames(latest.maxNames, 2)} ${latest.maxHeight}板`,
      `次高板 ${joinNames(latest.secondNames, 2)} ${latest.secondHeight}板`,
      `最高板家数 ${latest.maxCount}只`,
    ];
  }

  const lanes = buildMainlineLanes(plates, latestZt);
  snapshot.mainlineLanes = lanes;
  if (lanes.length > 0) {
    const top = lanes[0];
    snapshot.diagnostics.主线.facts = [
      `${top.name} 涨停${top.ztCount}只${top.maxHeight > 0 ? ` 最高${top.maxHeight}板` : ''}`,
      `资金 ${lanes.slice(0, 2).map((lane) => `${lane.name} ${lane.value}`).join(' / ')}`,
      `龙头股 ${top.leader?.name || '--'}`,
    ];
  }

  snapshot.payoffLists.strong = settledValue(strongResult, []);
  snapshot.payoffLists.hot = settledValue(hotResult, []);
  snapshot.payoffLists.bigface = settledValue(bigFaceResult, []);
  snapshot.diagnostics.赚钱效应.facts = [
    `强势股 ${joinNames(snapshot.payoffLists.strong.map((item) => item.name))}`,
    `热榜股 ${joinNames(snapshot.payoffLists.hot.map((item) => item.name))}`,
    `大面代表 ${joinNames(snapshot.payoffLists.bigface.map((item) => item.name))}`,
  ];

  snapshot.sectorTrend = buildSectorTrendData(
    latestDay,
    plateFlows.inflow,
    plateFlows.outflow,
    latestZt,
    settledValue(surgeResult, [])
  );
  return snapshot;
}
