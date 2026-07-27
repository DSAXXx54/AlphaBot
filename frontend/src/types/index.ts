// 股票基本信息
export interface StockInfo {
  symbol: string;
  name: string;
  exchange: string;
  currency: string;
  price?: number;
  change?: number;
  changePercent?: number;
  marketCap?: number;
  volume?: number;
  marketStatus?: 'open' | 'closed' | 'pre' | 'after';
  pe?: number;
  dividend?: number;
}

// 股票历史价格数据点
export interface StockPricePoint {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

// 股票历史价格数据
export interface StockPriceHistory {
  symbol: string;
  data: StockPricePoint[];
}

// AI分析结果
export interface AIAnalysis {
  summary: string;
  sentiment: 'positive' | 'neutral' | 'negative';
  keyPoints: string[];
  recommendation: string;
  riskLevel: 'low' | 'medium' | 'high';
  analysisType?: 'rule' | 'ml' | 'llm';
}

// 从 user.ts 导入 SavedStock
export type { SavedStock } from './user';

// API响应
export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
}

export interface SentimentMetricPoint {
  date: string;
  advanceRate: number;
  breakoutRate: number;
  upLimitToRisingRatio: number;
  avgReturn: number;
  maxReturn: number;
  medianReturn: number;
  firstBoardCount: number;
  secondBoardCount: number;
  breakoutCount: number;
  risingStockCount: number;
  turnoverAmount: number;
  northboundAmount: number;
  mainForceAmount: number;
}

export interface SentimentMetricsResponse {
  startDate: string;
  endDate: string;
  points: SentimentMetricPoint[];
  summary: {
    totalTradingDays: number;
    latestTradeDate?: string | null;
    averageAdvanceRate: number;
    averageBreakoutRate: number;
  };
}

export interface SentimentCalendarDay {
  date: string;
  is_trading_day: boolean;
  sync_status: 'non_trading' | 'success' | 'failed' | 'partial' | 'missing';
  metrics_ready: boolean;
}

export interface SentimentCalendarResponse {
  year: number;
  month: number;
  days: SentimentCalendarDay[];
}

export interface SentimentSyncDateResponse {
  trade_date: string;
  success: boolean;
  synced_pools: string[];
  metrics_ready: boolean;
  message: string;
}

export interface SentimentBackfillResponse {
  requested_days: number;
  end_date: string;
  success_count: number;
  failed_count: number;
  skipped_count: number;
  trade_dates: string[];
  results: SentimentSyncDateResponse[];
  message: string;
}

// 缓存统计信息
export interface CacheStats {
  total_items: number;
  active_items: number;
  expired_items: number;
  cache_keys: string[];
}

// 任务基本信息
export interface TaskInfo {
  task_id: string;
  description: string;
  interval: number;
  next_run: string;
  last_run?: string;
  run_count: number;
  is_enabled: boolean;
}

// 创建任务请求
export interface TaskCreate {
  task_type: string;
  symbol?: string;
  interval: number;
  is_enabled: boolean;
}

// 更新任务请求
export interface TaskUpdate {
  interval?: number;
  is_enabled?: boolean;
}

export interface WorldCupMarketPrice {
  label: string;
  odds: number;
  probability: number;
}

export interface WorldCupMarket {
  market_type: 'h2h' | 'asian_handicap' | 'totals' | 'polymarket';
  title: string;
  line?: string;
  options: WorldCupMarketPrice[];
}

export interface WorldCupPick {
  decision?: 'bet' | 'lean' | 'pass';
  bet_type: 'h2h' | 'asian_handicap' | 'totals';
  strategy: string;
  side: string;
  signal_label?: string;
  signal_tier?: 'core' | 'satellite' | 'probe' | null;
  signal_grade?: 'strong' | 'caution' | 'high_risk' | null;
  warning_message?: string | null;
  book_probability?: number;
  fair_probability?: number;
  confidence: number;
  edge: number;
  stake_pct: number;
  stake_amount: number;
  rationale: string[];
}

export interface WorldCupMatchSummary {
  match_id: string;
  stage: string;
  group_name?: string;
  kickoff_at: string;
  home_team: string;
  away_team: string;
  venue: string;
  status: 'upcoming' | 'live' | 'settled';
  home_score?: number;
  away_score?: number;
  source?: string;
  external_url?: string;
  featured_pick: WorldCupPick;
  key_market: WorldCupMarket;
}

export interface WorldCupMarketDiagnostics {
  theoretical_handicap?: string | null;
  actual_handicap?: string | null;
  opening_handicap?: string | null;
  theoretical_home_water?: number | null;
  theoretical_away_water?: number | null;
  opening_home_water?: number | null;
  opening_away_water?: number | null;
  actual_home_water?: number | null;
  actual_away_water?: number | null;
  favorite_team?: string | null;
  favorite_side?: string | null;
  underdog_side?: string | null;
  pricing_signal?: string | null;
  line_delta?: number | null;
  line_move_delta?: number | null;
  movement_signal?: string | null;
  consensus_score: number;
  consensus_pass: boolean;
  consensus_notes: string[];
}

export interface WorldCupFundamentals {
  score: number;
  data_quality?: string | null;
  support_level?: string | null;
  recent_form_score: number;
  motivation_score: number;
  squad_health_score: number;
  venue_fit_score: number;
  pedigree_score: number;
  head_to_head_score?: number;
  summary_tags: string[];
}

export interface WorldCupHeatProfile {
  trap_type?: string | null;
  heat_flags: string[];
  cold_flags: string[];
}

export interface WorldCupBookmakerQuote {
  bookmaker: string;
  h2h_market?: WorldCupMarket | null;
  spread_market?: WorldCupMarket | null;
  totals_market?: WorldCupMarket | null;
  diagnostics?: {
    theoretical_handicap?: string | null;
    actual_handicap?: string | null;
    theoretical_home_water?: number | null;
    theoretical_away_water?: number | null;
    actual_home_water?: number | null;
    actual_away_water?: number | null;
    pricing_signal?: string | null;
    favorite_team?: string | null;
  } | null;
}

export interface WorldCupMatchDetail extends WorldCupMatchSummary {
  markets: WorldCupMarket[];
  line_movement: Array<{
    label: string;
    line: number;
    home_odds: number;
    away_odds: number;
  }>;
  polymarket_probabilities: Record<string, number>;
  bookmaker_quotes?: WorldCupBookmakerQuote[];
  market_diagnostics: WorldCupMarketDiagnostics;
  fundamentals: WorldCupFundamentals;
  heat_profile: WorldCupHeatProfile;
  bankroll_bet?: {
    bet_type?: string;
    side?: string;
    signal_label?: string;
    strategy?: string;
    odds?: number;
    stake_pct?: number;
    stake_amount?: number;
    status?: string;
    pnl?: number;
    placed_at?: string | null;
    settled_at?: string | null;
    result_label?: string | null;
  } | null;
  ai_analysis?: {
    summary?: string | null;
    bull_case?: string | null;
    bear_case?: string | null;
    market_note?: string | null;
    confidence_note?: string | null;
    risk_flags?: string[];
    source?: string | null;
    generated_at?: string | null;
  } | null;
  ai_analysis_error?: string | null;
}

export interface WorldCupBankrollPoint {
  label: string;
  bankroll: number;
  pnl: number;
}

export interface WorldCupOverview {
  tournament: string;
  bankroll: number;
  initial_bankroll: number;
  settled_matches: number;
  open_positions: number;
  roi: number;
  max_drawdown: number;
  next_match_at: string;
  last_updated_at?: string;
  phase_breakdown: Array<{
    phase: string;
    matches: number;
    roi: number;
    hit_rate: number;
  }>;
  featured_matches: WorldCupMatchSummary[];
  bankroll_curve: WorldCupBankrollPoint[];
  market_heat: Array<{
    label: string;
    value: number;
  }>;
}
