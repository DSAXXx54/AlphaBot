/**
 * 策略配置树：市场卡片所有可调参数（权重/阈值/容量/名单）的唯一来源。
 *
 * 分层（public/private）：
 * - PUBLIC_STRATEGY：结构 + 展示/产品参数（开源仓库内，人人可自定义）；
 * - private 段（各评分 weights）：唯一一份在后端 Redis，
 *   由校准器写入后经 /market/strategy 下发，
 *   永不出现在前端仓库——参数保密与动态化由后端承担；
 * - 合并优先级：PUBLIC_STRATEGY < 后端 private < （将来）用户本地自定义；
 * - private 未加载（后端不可达且无 last-known-good）时，主线/反包评分不可用，
 *   调用方（snapshot 层）负责以空数据降级；public 参数始终可用。
 *
 * 联动参数必须在同一节点（如 flowStrength 权重与 trend 分区阈值各自成组），
 * 避免两处写死导致漂移。
 */

import { indexedDBCache } from '../indexedDBCache';
import { fetchStrategyPrivateOverrides } from './domain';

export type StrategyConfig = {
  version: number;
  /** 主线三卡（buildMainlineLanes） */
  mainline: {
    limit: number;
    followers: number;
    persistDays: number;
    earlySealMinutes: number;
    /** 一股多概念时次概念权重（主概念为 1） */
    secondaryWeight: number;
    catalystBonus: number;
    /** 题材组排除名单（宇宙过滤后仍会混入的纯事件/无效组） */
    exclude: string[];
    weights: {
      attackPerBoard: number;
      attackCap: number;
      maxHeight: number;
      heightSum: number;
      ladderCap: number;
      marketMaxBonus: number;
      marketSecondBonus: number;
      /** 资金项总分 = (净流入百分位×share + 户均百分位×(1−share)) × scale */
      flowScale: number;
      flowNetShare: number;
      persistPerDay: number;
      persistZt: number;
      persistZtCap: number;
      earlyShare: number;
      sealFund: number;
      sealFundCap: number;
      breakPenalty: number;
      breakCap: number;
    };
  };
  /** 异动反包（cycle.ts） */
  rebound: {
    lookback: number;
    confirmedLimit: number;
    watchLimit: number;
    nearSealPct: number;
    repairPct: number;
    earlySealMinutes: number;
    weights: {
      /** 前高甜区 [min,max] 得 prevHeight 分；首板 prevHeightFirst；高于甜区 prevHeightHigh */
      prevHeight: number;
      prevHeightFirst: number;
      prevHeightHigh: number;
      sweetMin: number;
      sweetMax: number;
      gap1Confirmed: number;
      gap1Watch: number;
      gap2: number;
      gapDeep: number;
      washReseal: number;
      earlySeal: number;
      fundStrong: number;
      fundStrongYi: number;
      fundMid: number;
      fundMidYi: number;
      zbcPenalty: number;
      zbcHigh: number;
      zbcMidPenalty: number;
      wasLeader: number;
      inMainline: number;
      /** 前高距当日市场最高板 ≤ leaderGradeMaxGap 板时的龙头级加成 */
      leaderGrade: number;
      leaderGradeMaxGap: number;
    };
  };
  /** 龙头接力首板缩圈（scoreFirstBoard） */
  relay: {
    chainLinkLimit: number;
    watchlistLimit: number;
    firstBoard: {
      theme: number;
      /** 集群度分档：家数 ≥ tiers[0] → scores[0]，≥ tiers[1] → scores[1]，≥2 → scores[2] */
      clusterTiers: [number, number];
      clusterScores: [number, number, number];
      earlySeal: number;
      earlySealEnd: number;
      morningSeal: number;
      morningSealEnd: number;
      lowPrice: number;
      lowPriceMax: number;
      midPrice: number;
      midPriceMax: number;
      fundStrong: number;
      fundStrongYi: number;
      fundMid: number;
      fundMidYi: number;
      lowZbc: number;
      lowZbcMax: number;
    };
  };
  /** 资金强度（flowStrength，趋势轨迹时序） */
  flowStrength: {
    amount: number;
    ratio: number;
    bigOrder: number;
    defensive: number;
    ratioClamp: number;
    bigClamp: number;
    defClamp: number;
  };
  /** 趋势候选与分区/脉冲（sectorTrend + 轨迹组件） */
  trend: {
    candidateLimit: number;
    slicePerSide: number;
    dropDays: number;
    rps: {
      flow: number;
      breadth: number;
      price: number;
      activity: number;
      flowNetShare: number;
      flowIntensityShare: number;
    };
    /** inferPhase 分档：主升/发酵/分歧/震荡/退潮 下限 */
    phase: [number, number, number, number, number];
    zones: { main: number; strong: number; watch: number };
    pulseDelta3d: number;
  };
  /** 板块宇宙过滤（plateFilter） */
  plateFilter: {
    excludeExact: string[];
    /** 正则 source 字符串，加载时编译 */
    excludePatterns: string[];
    deweightPatterns: string[];
    whitelist: string[];
    deweight: number;
  };
};

type DeepPartial<T> = { [K in keyof T]?: T[K] extends readonly unknown[] ? T[K] : DeepPartial<T[K]> };

export type StrategyOverrides = DeepPartial<StrategyConfig>;

/** 公开段：结构 + 展示/产品参数。private 权重节点不在前端仓库，见 PRIVATE_NODE_KEYS。 */
export const PUBLIC_STRATEGY: StrategyOverrides = {
  version: 1,
  mainline: {
    limit: 3,
    followers: 8,
    persistDays: 5,
    earlySealMinutes: 600,
    secondaryWeight: 0.5,
    catalystBonus: 12,
    exclude: ['其他', 'ST股', '业绩增长'],
  },
  rebound: {
    lookback: 6,
    confirmedLimit: 12,
    watchLimit: 16,
    nearSealPct: 7,
    repairPct: 3,
    earlySealMinutes: 600,
  },
  relay: {
    chainLinkLimit: 6,
    watchlistLimit: 5,
  },
  trend: {
    candidateLimit: 20,
    slicePerSide: 10,
    dropDays: 5,
    rps: {
      flow: 0.35,
      breadth: 0.3,
      price: 0.2,
      activity: 0.15,
      flowNetShare: 0.65,
      flowIntensityShare: 0.35,
    },
    phase: [84, 72, 58, 35, 20],
    zones: { main: 80, strong: 55, watch: 25 },
    pulseDelta3d: 30,
  },
  plateFilter: {
    excludeExact: [
      '昨日打二板以上表现',
      '昨日连板',
      '昨日连板_含一字',
      '昨日涨停',
      '昨日涨停_含一字',
      '昨日首板',
      '最近多板',
      '东方财富热股',
      'MSCI中国',
      'AH股',
      'AB股',
      'GDR',
      '权重股',
      '大盘股',
      '大盘价值',
      '中盘价值',
      '周期股',
      '题材股',
      '低价股',
      '超跌股',
      '低市净率',
      '长期破净',
      '破净股',
      '红利破净股',
      'ST股',
      'HS300_',
      '中证500',
      '上证50_',
      '上证180_',
      '深证100R',
      '深成500',
      '上证380',
      '富时罗素',
      '标准普尔',
      '沪股通',
      '科创板做市商',
      '科创板做市股',
      '科技风格',
      '医药医疗风格',
      '先进制造风格',
      '高成长股',
      '价值股',
      '中盘股',
      '大盘成长',
      '百日新高',
      '破增发价股',
      '证金持股',
      '行业龙头',
      '股权集中',
      '中特估',
      '新能源',
      '红利股',
      '融资融券',
      '融资融券标的',
      '转融券标的',
      '深股通',
      '机构重仓',
      '基金重仓',
      '社保重仓',
      '养老金',
      'QFII重仓',
      '转债标的',
      '含可转债',
      '百元股',
      // 风格/事件板
      '高价股',
      '破发次新',
      '定增破发',
      '高股息',
      '筹码集中',
      '密集调研',
      '业绩爆雷',
      '资产重组',
      '高管增持',
    ],
    excludePatterns: [
      '^昨日',
      '含一字',
      '热股',
      '^最近多板$',
      '风格',
      '(?:19|20)\\d{2}(?:一季报|中报|半年报|三季报|年报)',
      '预减',
      '预增',
      '预亏',
      '扭亏',
      '续亏',
      '首亏',
      '略增',
      '略减',
      '大幅上升',
      '大幅下降',
      '摘帽',
      '摘星',
      '破净',
      '低市净率',
      '低价股',
      '超跌股',
      '新高',
      '破增发价',
      'MSCI',
      '罗素',
      '标普',
      '沪股通',
      '做市',
      '股通',
      '重仓',
      '持股',
      '转债',
    ],
    deweightPatterns: ['参股', '自贸', '振兴'],
    whitelist: ['券商概念', '互联网金融'],
    deweight: 0.7,
  },
};

/** private 段节点（校准器拟合对象：各评分 weights），唯一一份在后端 */
const PRIVATE_NODE_KEYS = ['mainline', 'rebound', 'relay', 'flowStrength'] as const;

const IDB_LAST_GOOD_KEY = 'market:strategy:private-v1';

let current: StrategyConfig | null = null;
let loadPromise: Promise<boolean> | null = null;

/**
 * 当前生效配置。private 段仅在 isPrivateLoaded() 为 true 时完整；
 * public 参数任何时刻可用。
 */
export function getStrategy(): StrategyConfig {
  return (current ?? PUBLIC_STRATEGY) as StrategyConfig;
}

export function isPrivateLoaded(): boolean {
  return current != null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 校验并合并：只接受基结构中已知的键，数值/数组类型不匹配即丢弃（后端配置损坏时安全降级） */
function applyPrivateOverrides(privateSection: unknown): boolean {
  if (!isPlainObject(privateSection)) return false;
  const override: Record<string, unknown> = {};
  PRIVATE_NODE_KEYS.forEach((key) => {
    if (isPlainObject(privateSection[key])) override[key] = privateSection[key];
  });
  if (Object.keys(override).length === 0) return false;
  // private 节点按深合并：后端只覆盖 weights，其余字段保留 PUBLIC_STRATEGY 的公开值
  const base = (current ?? PUBLIC_STRATEGY) as Record<string, unknown>;
  const merged = { ...base };
  PRIVATE_NODE_KEYS.forEach((key) => {
    if (override[key] != null) merged[key] = mergeDeepNode(base[key], override[key]);
  });
  current = merged as StrategyConfig;
  return true;
}

function mergeDeepNode(base: unknown, override: unknown): unknown {
  if (isPlainObject(base) && isPlainObject(override)) {
    const out: Record<string, unknown> = { ...base };
    Object.entries(override).forEach(([key, value]) => {
      out[key] = mergeDeepNode(base[key], value);
    });
    return out;
  }
  return override; // 数组/标量整值替换
}

async function fetchPrivateOverrides(): Promise<unknown | null> {
  try {
    const result = await fetchStrategyPrivateOverrides();
    return result.private ?? null;
  } catch {
    return null;
  }
}

async function readLastGood(): Promise<unknown | null> {
  try {
    return await indexedDBCache.get<unknown>(IDB_LAST_GOOD_KEY);
  } catch {
    return null;
  }
}

/**
 * 确保策略已加载（幂等，会话内一次）：
 * 后端 → 失败回退 IDB last-known-good → 仍失败保持 public-only（调用方降级）。
 */
export async function ensurePrivateStrategy(): Promise<boolean> {
  if (isPrivateLoaded()) return true;
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    const fetched = await fetchPrivateOverrides();
    if (fetched && applyPrivateOverrides(fetched)) {
      try {
        await indexedDBCache.set(IDB_LAST_GOOD_KEY, fetched, 7 * 24 * 3600 * 1000);
      } catch {
        // 持久化失败不影响会话
      }
      return true;
    }
    const lastGood = await readLastGood();
    if (lastGood && applyPrivateOverrides(lastGood)) return true;
    return false;
  })();
  try {
    return await loadPromise;
  } finally {
    loadPromise = null;
  }
}

/** 测试/脚本用：直接注入 private 段 */
export function applyPrivateStrategy(privateSection: unknown): boolean {
  return applyPrivateOverrides(privateSection);
}
