import type { SurgeLimitStock, TopicStock } from './api';
import { stockConcepts } from './api';
import { normalizeCode, normalizePlateName } from './format';
import { getStrategy } from './strategy';
import type {
  ReboundPick,
  ReboundPattern,
  ReboundTierStats,
  RelayBreak,
  RelayCandidate,
  RelayChainLink,
  RelayLeader,
  RelaySnapshot,
  RelaySuccessor,
} from './types';

/**
 * 情绪周期衍生数据：龙头接力 + 异动反包。
 *
 * 数据全部来自 xgb 涨停/炸板池的按日历史（loadTopicPools，date 参数支持
 * 任意交易日回看）+ 当日异动池（surge_stock，锁定候选范围）+ 异动池自带
 * analysis 文案。零新增请求。回看窗口由交易日历决定；池为空的日期
 * （拉取失败）整体剔除，避免把"无数据日"误判成断板事件。
 *
 * 两个口径均基于历史复盘：
 * - 接力：空间龙头断板日，同题材首板是新龙头的主要来源（百花→神奇→汉森→千金）；
 *   断板日首板按 同题材/早封/低价/大封单/低炸板 缩圈，次日 1进2 确认。
 * - 异动反包：范围 = 当日异动池 ∪ 当日炸板池（不再全市场扫），从里找三类
 *   形态——连板反包（前高≥2 断≥1日回封）、首板反包（前高=1）、炸板回封
 *   （当日炸板后回封）。按参与价值评分分级：确认组（已回封）/ 观察池
 *   （临封 ≥7% / 修复 3~7%）。盲打成功率低（连板反包次日继续率 ~17%），
 *   卡片定位是范围锁定 + 分级提示 + 退潮确认。
 */


function sealClock(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/** 退市风险股（ST/*ST/退市整理）：涨跌幅规则与流动性都不同，接力/反包两张卡片均剔除 */
function isDelistingRisk(name: string): boolean {
  return /ST/i.test(name) || /退$/.test(name);
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
  zb: TopicStock[];
  zbByCode: Set<string>;
  maxHeight: number;
  byCode: Map<string, TopicStock>;
  leaders: TopicStock[];
};

function buildDaySeries(days: string[], ztByDate: Map<string, TopicStock[]>, zbByDate: Map<string, TopicStock[]>): DaySeries[] {
  return days
    .map((date) => {
      const zt = ztByDate.get(date) || [];
      // 涨停池为空 = 拉取失败，剔除该日
      if (zt.length === 0) return null;
      const zb = zbByDate.get(date) || [];
      return {
        date,
        zt,
        zb,
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

/** 断板日首板缩圈评分：胜者共性 = 同题材集群 + 上午封 + 低价 + 封单实 + 低炸板 */
function scoreFirstBoard(
  stock: TopicStock,
  leaderConcepts: Set<string>,
  themeCounts: Map<string, number>
): RelayCandidate {
  const reasons: string[] = [];
  const breakdown: Record<string, number> = {};
  let score = 0;
  const fb = getStrategy().relay.firstBoard;
  // breakdown 键 = firstBoard 权重键名，值为该分项对总分的贡献
  const add = (key: string, value: number, label: string) => {
    score += value;
    breakdown[key] = value;
    reasons.push(label);
  };
  // 同题材：与断板龙头概念全列表求交集（归一化），替代主概念字符串精确匹配——
  // xgb related_plates 顺序易变，精确匹配会让主导项无声丢失
  const concepts = stockConcepts(stock).map((name) => normalizePlateName(name));
  const sameTheme = concepts.some((name) => leaderConcepts.has(name));
  if (sameTheme) {
    add('theme', fb.theme, '同题材');
  }
  // 题材集群度：首板所属题材的今日涨停家数（含自身），衡量借势大小
  const cluster = Math.max(0, ...concepts.map((name) => themeCounts.get(name) || 0));
  if (cluster >= fb.clusterTiers[0]) {
    add('clusterScores', fb.clusterScores[0], `题材${cluster}板集群`);
  } else if (cluster >= fb.clusterTiers[1]) {
    add('clusterScores', fb.clusterScores[1], `题材${cluster}板集群`);
  } else if (cluster >= 2) {
    add('clusterScores', fb.clusterScores[2], '题材共振');
  }
  if (stock.time > 0 && stock.time <= fb.earlySealEnd) {
    add('earlySeal', fb.earlySeal, '早封');
  } else if (stock.time > 0 && stock.time <= fb.morningSealEnd) {
    add('morningSeal', fb.morningSeal, '上午封');
  }
  if (stock.price > 0 && stock.price <= fb.lowPriceMax) {
    add('lowPrice', fb.lowPrice, '低价');
  } else if (stock.price > 0 && stock.price <= fb.midPriceMax) {
    add('midPrice', fb.midPrice, '低价');
  }
  const fund = (stock.fund || 0) / 1e8;
  if (fund >= fb.fundStrongYi) {
    add('fundStrong', fb.fundStrong, '封单1亿+');
  } else if (fund >= fb.fundMidYi) {
    add('fundMid', fb.fundMid, '封单实');
  }
  if ((stock.zbc || 0) <= fb.lowZbcMax) {
    add('lowZbc', fb.lowZbc, '低炸板');
  }
  return {
    breakdown,
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

type ReboundEvent = { pick: ReboundPick; continuedNextDay: boolean | null };

/** 回看窗口内最近一次涨停；找不到返回 null */
function lastSeal(series: DaySeries[], dayIndex: number, code: string): { idx: number; stock: TopicStock } | null {
  const lookback = getStrategy().rebound.lookback;
  for (let j = dayIndex - 1; j >= Math.max(0, dayIndex - lookback) && j >= 0; j -= 1) {
    const stock = series[j].byCode.get(code);
    if (stock) return { idx: j, stock };
  }
  return null;
}

/** 参与价值评分：断板间隔/前高/回封质量/炸板惩罚/龙头与主线加成 */
function scoreReboundPick(input: {
  pattern: ReboundPattern;
  prevHeight: number;
  gapDays: number;
  zbc: number;
  wasLeader: boolean;
  inMainline: boolean;
  isConfirmed: boolean;
  marketMaxHeight?: number;
  sealTimeMin?: number;
  fundYi?: number;
}): { score: number; reasons: string[]; breakdown: Record<string, number> } {
  const reasons: string[] = [];
  const breakdown: Record<string, number> = {};
  let score = 0;
  // 权重来自后端下发的 private 段（本函数仅在 isPrivateLoaded() 后被调用）
  const w = getStrategy().rebound.weights;
  // breakdown 键 = weights 键名，值为该分项对总分的贡献（带符号）——校准器据此拟合新权重
  const add = (key: string, value: number, label: string) => {
    score += value;
    breakdown[key] = value;
    reasons.push(label);
  };
  if (input.prevHeight >= w.sweetMin && input.prevHeight <= w.sweetMax) {
    add('prevHeight', w.prevHeight, `前高${input.prevHeight}板`);
  } else if (input.prevHeight === 1) {
    add('prevHeightFirst', w.prevHeightFirst, '首板');
  } else if (input.prevHeight > w.sweetMax) {
    add('prevHeightHigh', w.prevHeightHigh, `前高${input.prevHeight}板`);
  }
  if (input.pattern === '炸板回封') {
    add('washReseal', w.washReseal, '当日炸板洗盘');
  } else if (input.gapDays === 1) {
    add(input.isConfirmed ? 'gap1Confirmed' : 'gap1Watch', input.isConfirmed ? w.gap1Confirmed : w.gap1Watch, '断1日');
  } else if (input.gapDays === 2) {
    add('gap2', w.gap2, '断2日');
  } else if (input.gapDays >= 3) {
    add('gapDeep', w.gapDeep, '断板多日');
  }
  if (
    input.sealTimeMin != null &&
    input.sealTimeMin > 0 &&
    input.sealTimeMin <= getStrategy().rebound.earlySealMinutes
  ) {
    add('earlySeal', w.earlySeal, '早封');
  }
  if (input.fundYi != null && input.fundYi >= w.fundStrongYi) {
    add('fundStrong', w.fundStrong, '封单1亿+');
  } else if (input.fundYi != null && input.fundYi >= w.fundMidYi) {
    add('fundMid', w.fundMid, '封单实');
  }
  if (input.zbc >= w.zbcHigh) {
    add('zbcPenalty', -w.zbcPenalty, `${input.zbc}次炸板`);
  } else if (input.zbc === w.zbcHigh - 1) {
    add('zbcMidPenalty', -w.zbcMidPenalty, '炸板2次');
  }
  if (input.wasLeader) {
    add('wasLeader', w.wasLeader, '曾空间龙头');
  }
  if (input.inMainline) {
    add('inMainline', w.inMainline, '主线题材');
  }
  // 龙头级反包：前高紧贴当日市场最高板（回封后即站上/贴近市场顶端）
  if (
    input.marketMaxHeight != null &&
    input.prevHeight >= w.sweetMin &&
    input.prevHeight >= input.marketMaxHeight - w.leaderGradeMaxGap
  ) {
    add('leaderGrade', w.leaderGrade, '龙头级反包');
  }
  return { score, reasons, breakdown };
}

/**
 * dayIndex 已回封确认组：当日涨停池 ∩ 断板/炸板历史。
 * 连板反包（gap≥1 且前高≥2）/ 首板反包（gap≥1 且前高=1）/ 炸板回封（gap<1 但当日 zbc≥1）。
 * gap=0 且无炸板 = 连续板，不属于反包形态。
 */
function detectResealsAt(series: DaySeries[], dayIndex: number, mainlineThemes: Set<string>): ReboundEvent[] {
  const current = series[dayIndex];
  const results: ReboundEvent[] = [];
  current.zt.forEach((stock) => {
    if (isDelistingRisk(stock.name)) return;
    const code = normalizeCode(stock.code);
    const prior = lastSeal(series, dayIndex, code);
    const prevHeight = prior?.stock.lbc || 1;
    const gapDays = prior ? dayIndex - prior.idx - 1 : 0;
    const zbc = stock.zbc || 0;
    let pattern: ReboundPattern | null = null;
    if (gapDays >= 1) pattern = prevHeight >= 2 ? '连板反包' : '首板反包';
    else if (zbc >= 1) pattern = '炸板回封';
    if (!pattern) return;
    const wasLeader = Boolean(prior && prevHeight >= series[prior.idx].maxHeight);
    const inMainline = stockConcepts(stock).some((name) => mainlineThemes.has(name));
    const fundYi = (stock.fund || 0) / 1e8;
    // 炸板回封的洗盘时长 = 最后回封时刻 − 首次炸板时刻
    const washMinutes =
      pattern === '炸板回封' && stock.firstBreak && stock.lastSealTs && stock.lastSealTs > stock.firstBreak
        ? Math.max(1, Math.round((stock.lastSealTs - stock.firstBreak) / 60))
        : undefined;
    const { score, reasons, breakdown } = scoreReboundPick({
      pattern,
      prevHeight,
      gapDays,
      zbc,
      wasLeader,
      inMainline,
      isConfirmed: true,
      marketMaxHeight: current.maxHeight,
      sealTimeMin: stock.time,
      fundYi,
    });
    const nextDay = series[dayIndex + 1];
    results.push({
      pick: {
        name: stock.name,
        code,
        pattern,
        prevHeight,
        gapDays,
        score,
        reasons,
        wasLeader,
        inMainline,
        sealTime: sealClock(stock.time),
        fund: fundYi,
        price: stock.price,
        zbc,
        washMinutes,
        breakdown,
      },
      continuedNextDay: nextDay ? nextDay.byCode.has(code) : null,
    });
  });
  return results;
}

/**
 * 观察池：范围内（当日异动池 ∪ 当日炸板池）尚未回封的断板/炸板股。
 * 异动池锁定范围——当日无异动的断板股不再列出。昨日涨停今日断板记 gapDays=1。
 */
function buildReboundWatching(
  series: DaySeries[],
  surge: SurgeLimitStock[],
  mainlineThemes: Set<string>
): ReboundPick[] {
  const today = series[series.length - 1];
  const surgeByCode = new Map<string, SurgeLimitStock>();
  surge.forEach((stock) => {
    const code = normalizeCode(stock.code);
    if (code && !surgeByCode.has(code)) surgeByCode.set(code, stock);
  });
  const universe = new Map<string, { name: string; concepts: string[]; analysis?: string }>();
  surgeByCode.forEach((stock, code) => {
    universe.set(code, { name: stock.name, concepts: stock.plates || [], analysis: stock.analysis });
  });
  today.zb.forEach((stock) => {
    const code = normalizeCode(stock.code);
    if (!universe.has(code)) {
      universe.set(code, { name: stock.name, concepts: stockConcepts(stock) });
    }
  });

  const results: ReboundPick[] = [];
  universe.forEach((meta, code) => {
    if (isDelistingRisk(meta.name)) return; // 退市风险股剔除
    if (today.byCode.has(code)) return; // 已回封，在确认组
    const prior = lastSeal(series, series.length - 1, code);
    let prevHeight = 1;
    let gapDays: number;
    if (prior) {
      prevHeight = prior.stock.lbc || 1;
      gapDays = series.length - 1 - prior.idx;
    } else if (today.zbByCode.has(code)) {
      gapDays = 1; // 今日首板炸板：今日首次冲板失败
    } else {
      return; // 无涨停史且非当日炸板 → 不属于断板/炸板形态
    }
    const wasLeader = Boolean(prior && prevHeight >= series[prior.idx].maxHeight);
    const inMainline = meta.concepts.some((name) => mainlineThemes.has(name));
    const zbc = today.zb.find((stock) => normalizeCode(stock.code) === code)?.zbc || 0;
    const pattern: ReboundPattern = prevHeight >= 2 ? '连板反包' : '首板反包';
    const { score, reasons, breakdown } = scoreReboundPick({
      pattern,
      prevHeight,
      gapDays,
      zbc,
      wasLeader,
      inMainline,
      isConfirmed: false,
      marketMaxHeight: today.maxHeight,
    });
    results.push({
      name: meta.name,
      code,
      pattern,
      prevHeight,
      gapDays,
      score,
      reasons,
      wasLeader,
      inMainline,
      brokeToday: today.zbByCode.has(code),
      change: null,
      price: null,
      analysis: meta.analysis,
      zbc,
    });
  });
  return results
    .sort((a, b) => b.score - a.score || a.gapDays - b.gapDays)
    .slice(0, getStrategy().rebound.watchLimit);
}

export function buildRelaySnapshot(params: {
  days: string[];
  ztByDate: Map<string, TopicStock[]>;
  zbByDate: Map<string, TopicStock[]>;
  surge: SurgeLimitStock[];
  mainlineThemes: Set<string>;
}): RelaySnapshot | null {
  const { days, ztByDate, zbByDate, surge, mainlineThemes } = params;
  const series = buildDaySeries(days, ztByDate, zbByDate);
  if (series.length < 2) return null;
  const lastIdx = series.length - 1;
  const today = series[lastIdx];
  const yesterday = series[lastIdx - 1];

  // ── 接力链（回看）：昨日高位龙头断板 → 当日首板中事后晋级者 ──
  const chain: RelayChainLink[] = [];
  for (let i = 1; i < lastIdx; i += 1) {
    const prevLeaders = series[i - 1].leaders;
    const broken = prevLeaders.filter(
      (leader) => !series[i].byCode.has(normalizeCode(leader.code)) && !isDelistingRisk(leader.name)
    );
    if (broken.length === 0) continue;
    const successors: RelaySuccessor[] = series[i].zt
      .filter((stock) => (stock.lbc || 1) === 1 && !isDelistingRisk(stock.name))
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
  const recentChain = chain.slice(-getStrategy().relay.chainLinkLimit);

  // ── 今日状态：存活高位股 / 断板龙头 ──
  const aliveLeaders = [...today.zt]
    .filter((stock) => (stock.lbc || 1) >= 2 && !isDelistingRisk(stock.name))
    .sort((a, b) => (b.lbc || 1) - (a.lbc || 1))
    .slice(0, 3)
    .map(toLeader);

  const breaksToday: RelayBreak[] = yesterday.leaders
    .filter(
      (leader) => !today.byCode.has(normalizeCode(leader.code)) && !isDelistingRisk(leader.name)
    )
    .map((leader) => ({
      name: leader.name,
      code: leader.code,
      height: leader.lbc || 1,
      status: today.zbByCode.has(normalizeCode(leader.code)) ? ('zb' as const) : ('absent' as const),
    }));

  // ── 断板日首板缩圈（仅断板发生时有意义）──
  let watchlist: RelayCandidate[] = [];
  if (breaksToday.length > 0) {
    // 龙头概念全列表（归一化）+ 各题材今日涨停家数（集群度）
    const leaderConcepts = new Set(
      yesterday.leaders
        .flatMap((leader) => stockConcepts(leader).map((name) => normalizePlateName(name)))
        .filter(Boolean)
    );
    const themeCounts = new Map<string, number>();
    today.zt.forEach((stock) => {
      stockConcepts(stock).forEach((name) => {
        const key = normalizePlateName(name);
        if (key) themeCounts.set(key, (themeCounts.get(key) || 0) + 1);
      });
    });
    watchlist = today.zt
      .filter((stock) => (stock.lbc || 1) === 1 && !isDelistingRisk(stock.name))
      .map((stock) => scoreFirstBoard(stock, leaderConcepts, themeCounts))
      .sort((a, b) => b.score - a.score || (b.sameTheme ? 1 : 0) - (a.sameTheme ? 1 : 0))
      .slice(0, getStrategy().relay.watchlistLimit);
  }

  // ── 异动反包：确认组（已回封）+ 观察池（范围内未回封）+ 分形态历史继续率 ──
  const reboundConfirmed = detectResealsAt(series, lastIdx, mainlineThemes)
    .map((item) => item.pick)
    .sort((a, b) => b.score - a.score)
    .slice(0, getStrategy().rebound.confirmedLimit);
  const reboundWatching = buildReboundWatching(series, surge, mainlineThemes);
  const reboundStats: { rebreak: ReboundTierStats; firstBoard: ReboundTierStats; reseal: ReboundTierStats } = {
    rebreak: { total: 0, continued: 0 },
    firstBoard: { total: 0, continued: 0 },
    reseal: { total: 0, continued: 0 },
  };
  for (let i = 1; i < lastIdx; i += 1) {
    detectResealsAt(series, i, mainlineThemes).forEach(({ pick, continuedNextDay }) => {
      if (continuedNextDay === null) return;
      const bucket =
        pick.pattern === '连板反包'
          ? reboundStats.rebreak
          : pick.pattern === '首板反包'
            ? reboundStats.firstBoard
            : reboundStats.reseal;
      bucket.total += 1;
      if (continuedNextDay) bucket.continued += 1;
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
    reboundConfirmed,
    reboundWatching,
    reboundStats,
    promoteRate,
    firstBoardCount,
  };
}

// ── 校准样本收集（供 scripts/calibrate.ts 回放拟合）──

export type CalibrationSample = {
  /** 样本所属交易日 */
  date: string;
  kind: 'rebound' | 'firstBoard';
  pattern?: string;
  name: string;
  code: string;
  /** 因子分项分值（键 = weights 键名，带符号） */
  breakdown: Record<string, number>;
  /** 次日结果：反包=次日仍涨停；首板=次日晋级 ≥2 板 */
  success: boolean;
};

/**
 * 校准样本收集：回放池历史，输出每个反包/首板候选的因子分项与次日结果。
 * 反包样本 = 每个历史日的已回封确认组；首板样本 = 断板日首板（次日 1进2 为标签）。
 */
export function collectCalibrationSamples(params: {
  days: string[];
  ztByDate: Map<string, TopicStock[]>;
  zbByDate: Map<string, TopicStock[]>;
  mainlineThemes?: Set<string>;
}): CalibrationSample[] {
  const series = buildDaySeries(params.days, params.ztByDate, params.zbByDate);
  const themes = params.mainlineThemes ?? new Set<string>();
  const samples: CalibrationSample[] = [];

  for (let i = 1; i < series.length - 1; i += 1) {
    const day = series[i];
    const next = series[i + 1];

    // 反包样本：确认组三形态（breakdown 来自评分函数）
    detectResealsAt(series, i, themes).forEach((event) => {
      samples.push({
        date: day.date,
        kind: 'rebound',
        pattern: event.pick.pattern,
        name: event.pick.name,
        code: event.pick.code,
        breakdown: event.pick.breakdown ?? {},
        success: event.continuedNextDay === true,
      });
    });

    // 首板样本：断板日首板 → 次日晋级 ≥2 板
    const leaderConcepts = new Set(
      series[i - 1].leaders.flatMap((leader) => stockConcepts(leader).map((n) => normalizePlateName(n))).filter(Boolean)
    );
    const themeCounts = new Map<string, number>();
    day.zt.forEach((stock) => {
      stockConcepts(stock).forEach((name) => {
        const key = normalizePlateName(name);
        if (key) themeCounts.set(key, (themeCounts.get(key) || 0) + 1);
      });
    });
    day.zt.forEach((stock) => {
      if ((stock.lbc || 1) !== 1 || isDelistingRisk(stock.name)) return;
      const code = normalizeCode(stock.code);
      const nextStock = next.byCode.get(code);
      const scored = scoreFirstBoard(stock, leaderConcepts, themeCounts);
      samples.push({
        date: day.date,
        kind: 'firstBoard',
        name: stock.name,
        code,
        breakdown: scored.breakdown ?? {},
        success: Boolean(nextStock && (nextStock.lbc || 1) >= 2),
      });
    });
  }
  return samples;
}
