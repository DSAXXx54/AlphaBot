export type MarketCardLabel = '趋势' | '情绪' | '主线' | '赚钱效应';

export type MarketCardData = {
  facts: string[];
};

export type MarketGeeseStock = {
  name: string;
  code: string;
  change: string;
  note: string;
  result: 'success' | 'failed' | 'broken';
  plate?: string;
};

export type MarketGeeseRow = {
  progress: string;
  numerator: number;
  denominator: number;
  stocks: MarketGeeseStock[];
};

export type MarketBoardStock = {
  name: string;
  code: string;
};

export type MarketBoardLevel = {
  height: number;
  number: number;
  stocks: string[];
  code_list: MarketBoardStock[];
};

export type MarketEmotionPoint = {
  label: string;
  fullDate: string;
  maxHeight: number;
  secondHeight: number;
  maxCount: number;
  secondCount: number;
  maxNames: string[];
  secondNames: string[];
  allLevels: MarketBoardLevel[];
  geeseRows: MarketGeeseRow[];
};

export type MarketPayoffItem = {
  name: string;
  value: string;
  note: string;
  tone?: 'up' | 'down' | 'normal';
};

export type MarketMainlineStock = {
  name: string;
  code: string;
  lbc: number;
};

export type MarketMainlineLane = {
  name: string;
  value: string;
  change: number;
  netFlow: number;
  ztCount: number;
  maxHeight: number;
  upCount: number;
  downCount: number;
  leader: MarketMainlineStock | null;
  followers: MarketMainlineStock[];
};

export type TurnoverMinutePoint = {
  time: string;
  today: number | null;
  yesterday: number | null;
};

export type IntradayEmotionPoint = {
  time: string;
  positive: number | null;
  negative: number | null;
  index: number | null;
};

export type IntradayEmotionSnapshot = {
  positiveCurrent: number | null;
  negativeCurrent: number | null;
  indexCurrent: number | null;
  points: IntradayEmotionPoint[];
};

export type ShortEmotionMinutePoint = {
  time: string;
  value: number;
  turnover: number | null;
};

export type ShortEmotionDay = {
  date: string;
  points: ShortEmotionMinutePoint[];
};

export type ShortEmotionSnapshot = {
  latestValue: number | null;
  latestTurnover: number | null;
  zone: string;
  days: ShortEmotionDay[];
};

export type TurnoverSnapshot = {
  current: number | null;
  predict: number | null;
  previous: number | null;
  change: number | null;
  currentText: string;
  predictText: string;
  previousText: string;
  changeText: string;
  points: TurnoverMinutePoint[];
  emotion: IntradayEmotionSnapshot | null;
};

export type MarketTrendStage = '主升' | '发酵' | '分歧' | '震荡' | '退潮' | '冷却';

export type MarketTrendFlow = 'in' | 'out';

export type MarketTrendHighlightStock = {
  code: string;
  name: string;
  lbc: number;
};

export type MarketTrendTopic = {
  id: string;
  name: string;
  color: string;
  flow: MarketTrendFlow;
  date: string;
  score: number;
  changePct: number;
  turnover: number;
  moneyFlow: number;
  breadth: number;
  ztRatio: number;
  amountChange: number;
  phase: MarketTrendStage;
  highlightedStocks: MarketTrendHighlightStock[];
  /** 同题材被归并的板名（零请求名称粗筛），无归并时不出现 */
  relatedPlates?: string[];
};

export type MarketTrendStockTag = {
  lbc: number;
  status: string;
  analysis?: string;
  plate?: string;
};

export type MarketTrendSampleStats = {
  baseCount: number;
  eventAddedCount: number;
  finalCount: number;
};

export type MarketTrendPanelData = {
  range: 10 | 20 | 60;
  latestDay: string;
  topics: MarketTrendTopic[];
  stockTags: Record<string, MarketTrendStockTag>;
  sampleStats: MarketTrendSampleStats;
};

export type RelayLeader = {
  name: string;
  code: string;
  height: number;
};

/** 断板日首板的事后走势（回看确认） */
export type RelaySuccessor = {
  name: string;
  code: string;
  /** 首板之后达到的最高连板数 */
  maxHeight: number;
  /** 次日 1进2 确认 */
  confirmed: boolean;
  /** 走出 ≥3 板，成为接力龙头 */
  becameLeader: boolean;
};

/** 一次空间龙头断板事件（回看视角） */
export type RelayChainLink = {
  /** 断板日 YYYY-MM-DD */
  date: string;
  /** 当日断板的前高度龙头 */
  leaders: RelayLeader[];
  /** 断板日首板中事后晋级者（≥2板），按高度排序 */
  successors: RelaySuccessor[];
};

/** 今日断板的前高度龙头（盘中 = 暂未封板，盘后 = 断板确认） */
export type RelayBreak = {
  name: string;
  code: string;
  height: number;
  /** zb=今日已炸板（断板基本确认）；absent=暂未见涨停 */
  status: 'zb' | 'absent';
};

/** 断板日首板缩圈候选（盘中/盘后实时评分） */
export type RelayCandidate = {
  name: string;
  code: string;
  score: number;
  reasons: string[];
  sameTheme: boolean;
  sealTime: string;
  /** 亿元 */
  fund: number;
  price: number;
};

/** 今日反包股：前一轮 lbc≥2，断 ≥1 日后回封 */
export type ReboundStock = {
  name: string;
  code: string;
  /** 前一轮连板高度 */
  prevHeight: number;
  /** 距上次涨停的交易日数 */
  gapDays: number;
  sealTime: string;
  /** 亿元 */
  fund: number;
  price: number;
  /** 前轮曾是当日空间龙头 */
  wasLeader: boolean;
};

export type RelaySnapshot = {
  /** 统计窗口内交易日数 */
  days: number;
  /** 最近的断板→接力事件（回看，含失败接力） */
  chain: RelayChainLink[];
  /** 今日仍涨停的高位股（存活的潜在龙头） */
  aliveLeaders: RelayLeader[];
  /** 今日断板（或盘中未封板）的前高度龙头 */
  breaksToday: RelayBreak[];
  /** breaksToday 非空时的首板缩圈名单 */
  watchlist: RelayCandidate[];
  /** 今日反包股 */
  rebounds: ReboundStock[];
  /** 历史反包次日继续率（窗口内，不含今日） */
  reboundStats: {
    total: number;
    continued: number;
    oneDayGapTotal: number;
    oneDayGapContinued: number;
  };
  /** 今日晋级率（昨涨停→今仍涨停），0-100；无昨日数据为 null */
  promoteRate: number | null;
  /** 今日首板家数 */
  firstBoardCount: number;
};

export type MarketSnapshot = {
  diagnostics: Record<MarketCardLabel, MarketCardData>;
  emotionSeries: MarketEmotionPoint[];
  intradayEmotion: IntradayEmotionSnapshot | null;
  payoffLists: {
    strong: MarketPayoffItem[];
    hot: MarketPayoffItem[];
    bigface: MarketPayoffItem[];
  };
  shortEmotion: ShortEmotionSnapshot | null;
  mainlineLanes: MarketMainlineLane[];
  turnover: TurnoverSnapshot | null;
  sectorTrend: MarketTrendPanelData;
  relay: RelaySnapshot | null;
};

export const DEFAULT_MARKET_SNAPSHOT: MarketSnapshot = {
  diagnostics: {
    趋势: { facts: ['当前成交 --', '预估全天 --', '较昨日 --'] },
    情绪: { facts: ['最高板 --', '次高板 --', '最高板家数 --'] },
    主线: { facts: ['资金第一 --', '资金第二 --', '龙头股 --'] },
    赚钱效应: { facts: ['强势股 --', '热榜股 --', '大面代表 --'] },
  },
  emotionSeries: [],
  intradayEmotion: null,
  payoffLists: {
    strong: [],
    hot: [],
    bigface: [],
  },
  shortEmotion: null,
  mainlineLanes: [],
  turnover: null,
  sectorTrend: {
    range: 20,
    latestDay: '',
    topics: [],
    stockTags: {},
    sampleStats: {
      baseCount: 0,
      eventAddedCount: 0,
      finalCount: 0,
    },
  },
  relay: null,
};
