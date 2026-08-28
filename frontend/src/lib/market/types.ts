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
};
