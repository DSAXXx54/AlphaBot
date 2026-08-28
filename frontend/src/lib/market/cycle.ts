import type { TopicStock } from './api';
import { normalizeCode } from './format';
import type {
  ReboundStock,
  ReboundWatchStock,
  RelayBreak,
  RelayCandidate,
  RelayChainLink,
  RelayLeader,
  RelaySnapshot,
  RelaySuccessor,
} from './types';

/**
 * 情绪周期衍生数据：龙头接力 + 断板反包。
 *
 * 数据全部来自东财涨停/炸板池的按日历史（loadTopicPools），零额外请求。
 * 东财池历史仅约 15 个交易日，窗口自然截断；池为空的日期（拉取失败或超出
 * 历史范围）整体剔除，避免把"无数据日"误判成断板事件。
 *
 * 两个口径均基于 /tmp 历史 15 日复盘：
 * - 接力：空间龙头断板日，同题材首板是新龙头的主要来源（百花→神奇→汉森→千金）；
 *   断板日首板按 同题材/早封/低价/大封单/低炸板 缩圈，次日 1进2 确认。
 * - 反包：前 lbc≥2 断 ≥1 日后回封。盲打很弱（次日继续率 ~17%），卡片定位是
 *   机会提示 + 退潮确认（反包集中出现且失败 ≈ 修复失败，退潮确认）。
 */

const CHAIN_LINK_LIMIT = 6;
const WATCHLIST_LIMIT = 5;
const REBOUND_LOOKBACK = 6;
/** 潜在反包观察池容量（批量行情一笔请求覆盖） */
const REBOUND_WATCH_LIMIT = 16;

function sealClock(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

function toLeader(stock: TopicStock): RelayLeader {
  return { name: stock.name, code: stock.code, height: Math.max(1, stock.lbc || 1) };
}

function dayLeaders(ztList: TopicStock[]): TopicStock[] {
  let maxHeight = 0;
  ztList.forEach((stock) => {
    maxHeight = Math.max(maxHeight, stock.lbc || 1);
  });
  if (maxHeight === 0) return [];
  return ztList.filter((stock) => (stock.lbc || 1) === maxHeight);
}

type DaySeries = {
  date: string;
  zt: TopicStock[];
  zbByCode: Set<string>;
  maxHeight: number;
  byCode: Map<string, TopicStock>;
  leaders: TopicStock[];
};

function buildDaySeries(days: string[], ztByDate: Map<string, TopicStock[]>, zbByDate: Map<string, TopicStock[]>): DaySeries[] {
  return days
    .map((date) => {
      const zt = ztByDate.get(date) || [];
      // 涨停池为空 = 拉取失败或超出东财历史范围，剔除该日
      if (zt.length === 0) return null;
      const zb = zbByDate.get(date) || [];
      return {
        date,
        zt,
        zbByCode: new Set(zb.map((stock) => normalizeCode(stock.code))),
        maxHeight: Math.max(...zt.map((stock) => stock.lbc || 1)),
        byCode: new Map(zt.map((stock) => [normalizeCode(stock.code), stock])),
        leaders: dayLeaders(zt),
      };
    })
    .filter((item): item is DaySeries => item !== null);
}

/** 断板日首板 → 事后最高板（回看确认用） */
function forwardMaxHeight(series: DaySeries[], fromIndex: number, code: string): number {
  let height = 1;
  for (let i = fromIndex; i < series.length; i += 1) {
    const stock = series[i].byCode.get(code);
    if (stock) height = Math.max(height, stock.lbc || 1);
  }
  return height;
}

/** 断板日首板缩圈评分：胜者共性 = 同题材 + 上午封 + 低价 + 封单实 + 低炸板 */
function scoreFirstBoard(stock: TopicStock, leaderReasons: Set<string>): RelayCandidate {
  const reasons: string[] = [];
  let score = 0;
  const sameTheme = leaderReasons.has((stock.reason || '').trim()) && leaderReasons.size > 0;
  if (sameTheme) {
    score += 30;
    reasons.push('同题材');
  }
  if (stock.time > 0 && stock.time <= 600) {
    score += 25;
    reasons.push('早封');
  } else if (stock.time > 0 && stock.time <= 630) {
    score += 15;
    reasons.push('上午封');
  }
  if (stock.price > 0 && stock.price <= 10) {
    score += 20;
    reasons.push('低价');
  } else if (stock.price > 0 && stock.price <= 15) {
    score += 12;
    reasons.push('低价');
  }
  const fund = (stock.fund || 0) / 1e8;
  if (fund >= 1) {
    score += 18;
    reasons.push('封单1亿+');
  } else if (fund >= 0.5) {
    score += 10;
    reasons.push('封单实');
  }
  if ((stock.zbc || 0) <= 1) {
    score += 10;
    reasons.push('低炸板');
  }
  return {
    name: stock.name,
    code: stock.code,
    score,
    reasons,
    sameTheme,
    sealTime: sealClock(stock.time),
    fund,
    price: stock.price,
  };
}

type ReboundInfo = { stock: ReboundStock; continuedNextDay: boolean | null };

/** dayIndex 当日反包股：前一轮 lbc≥2，断 ≥1 日后回封 */
function detectReboundsAt(series: DaySeries[], dayIndex: number): ReboundInfo[] {
  const current = series[dayIndex];
  const results: ReboundInfo[] = [];
  current.zt.forEach((stock) => {
    const code = normalizeCode(stock.code);
    // 找回看窗口内最近一次涨停
    let lastIdx = -1;
    for (let j = dayIndex - 1; j >= Math.max(0, dayIndex - REBOUND_LOOKBACK) && j >= 0; j -= 1) {
      if (series[j].byCode.has(code)) {
        lastIdx = j;
        break;
      }
    }
    if (lastIdx < 0) return;
    const lastStock = series[lastIdx].byCode.get(code);
    const prevHeight = lastStock?.lbc || 1;
    if (prevHeight < 2) return;
    const gapDays = dayIndex - lastIdx - 1;
    if (gapDays < 1) return;
    const nextDay = series[dayIndex + 1];
    results.push({
      stock: {
        name: stock.name,
        code: stock.code,
        prevHeight,
        gapDays,
        sealTime: sealClock(stock.time),
        fund: (stock.fund || 0) / 1e8,
        price: stock.price,
        wasLeader: prevHeight >= series[lastIdx].maxHeight,
      },
      continuedNextDay: nextDay ? nextDay.byCode.has(code) : null,
    });
  });
  return results;
}

/** 潜在反包观察池：前连板股断板后尚未回封（回封即转 rebounds），盘前即可算出 */
function buildReboundWatch(series: DaySeries[]): Omit<ReboundWatchStock, 'change' | 'price'>[] {
  const today = series[series.length - 1];
  const results: Omit<ReboundWatchStock, 'change' | 'price'>[] = [];
  const seen = new Set<string>();
  // 从最近的涨停日往回扫，首个命中即该股最近一轮的（最终）高度
  for (let j = series.length - 2; j >= 0 && j >= series.length - 1 - REBOUND_LOOKBACK; j -= 1) {
    series[j].zt.forEach((stock) => {
      const code = normalizeCode(stock.code);
      if (seen.has(code)) return;
      seen.add(code);
      const prevHeight = stock.lbc || 1;
      if (prevHeight < 2) return;
      const gapDays = series.length - 1 - j - 1;
      if (gapDays < 1) return;
      if (today.byCode.has(code)) return; // 已回封，在 rebounds 名单里
      results.push({
        name: stock.name,
        code: stock.code,
        prevHeight,
        gapDays,
        wasLeader: prevHeight >= series[j].maxHeight,
        brokeToday: today.zbByCode.has(code),
      });
    });
  }
  return results
    .sort(
      (a, b) =>
        (b.wasLeader ? 1 : 0) - (a.wasLeader ? 1 : 0) || b.prevHeight - a.prevHeight || a.gapDays - b.gapDays
    )
    .slice(0, REBOUND_WATCH_LIMIT);
}

export function buildRelaySnapshot(
  days: string[],
  ztByDate: Map<string, TopicStock[]>,
  zbByDate: Map<string, TopicStock[]>
): RelaySnapshot | null {
  const series = buildDaySeries(days, ztByDate, zbByDate);
  if (series.length < 2) return null;
  const lastIdx = series.length - 1;
  const today = series[lastIdx];
  const yesterday = series[lastIdx - 1];

  // ── 接力链（回看）：昨日高位龙头断板 → 当日首板中事后晋级者 ──
  const chain: RelayChainLink[] = [];
  for (let i = 1; i < lastIdx; i += 1) {
    const prevLeaders = series[i - 1].leaders;
    const broken = prevLeaders.filter((leader) => !series[i].byCode.has(normalizeCode(leader.code)));
    if (broken.length === 0) continue;
    const successors: RelaySuccessor[] = series[i].zt
      .filter((stock) => (stock.lbc || 1) === 1)
      .map((stock) => {
        const maxHeight = forwardMaxHeight(series, i, normalizeCode(stock.code));
        return {
          name: stock.name,
          code: stock.code,
          maxHeight,
          confirmed: maxHeight >= 2,
          becameLeader: maxHeight >= 3,
        };
      })
      .filter((item) => item.confirmed)
      .sort((a, b) => b.maxHeight - a.maxHeight)
      .slice(0, 3);
    chain.push({
      date: series[i].date,
      leaders: broken.map(toLeader),
      successors,
    });
  }
  const recentChain = chain.slice(-CHAIN_LINK_LIMIT);

  // ── 今日状态：存活高位股 / 断板龙头 ──
  const aliveLeaders = [...today.zt]
    .filter((stock) => (stock.lbc || 1) >= 2)
    .sort((a, b) => (b.lbc || 1) - (a.lbc || 1))
    .slice(0, 3)
    .map(toLeader);

  const breaksToday: RelayBreak[] = yesterday.leaders
    .filter((leader) => !today.byCode.has(normalizeCode(leader.code)))
    .map((leader) => ({
      name: leader.name,
      code: leader.code,
      height: leader.lbc || 1,
      status: today.zbByCode.has(normalizeCode(leader.code)) ? ('zb' as const) : ('absent' as const),
    }));

  // ── 断板日首板缩圈（仅断板发生时有意义）──
  let watchlist: RelayCandidate[] = [];
  if (breaksToday.length > 0) {
    const leaderReasons = new Set(yesterday.leaders.map((leader) => (leader.reason || '').trim()).filter(Boolean));
    watchlist = today.zt
      .filter((stock) => (stock.lbc || 1) === 1)
      .map((stock) => scoreFirstBoard(stock, leaderReasons))
      .sort((a, b) => b.score - a.score || (b.sameTheme ? 1 : 0) - (a.sameTheme ? 1 : 0))
      .slice(0, WATCHLIST_LIMIT);
  }

  // ── 反包：今日名单 + 窗口内次日继续率（不含今日）──
  const rebounds: ReboundStock[] = detectReboundsAt(series, lastIdx).map((item) => item.stock);
  const reboundWatch = buildReboundWatch(series).map((stock) => ({ ...stock, change: null, price: null }));
  let total = 0;
  let continued = 0;
  let oneDayGapTotal = 0;
  let oneDayGapContinued = 0;
  for (let i = 1; i < lastIdx; i += 1) {
    detectReboundsAt(series, i).forEach(({ stock, continuedNextDay }) => {
      if (continuedNextDay === null) return;
      total += 1;
      if (continuedNextDay) continued += 1;
      if (stock.gapDays === 1) {
        oneDayGapTotal += 1;
        if (continuedNextDay) oneDayGapContinued += 1;
      }
    });
  }

  // ── 情绪背景：晋级率 + 首板数 ──
  const prevCodes = new Set(yesterday.zt.map((stock) => normalizeCode(stock.code)));
  const promoted = today.zt.filter((stock) => prevCodes.has(normalizeCode(stock.code))).length;
  const promoteRate = prevCodes.size > 0 ? Math.round((promoted / prevCodes.size) * 100) : null;
  const firstBoardCount = today.zt.filter((stock) => (stock.lbc || 1) === 1).length;

  return {
    days: series.length,
    chain: recentChain,
    aliveLeaders,
    breaksToday,
    watchlist,
    rebounds,
    reboundWatch,
    reboundStats: { total, continued, oneDayGapTotal, oneDayGapContinued },
    promoteRate,
    firstBoardCount,
  };
}
