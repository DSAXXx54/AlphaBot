'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useAuth } from '@/lib/contexts/AuthContext';
import { StockInfo } from '../types';
import { ChartLine, Search, Settings, Info, Bot, LogIn, User, LogOut, Key, Flame, Trophy, Sparkles, RefreshCw } from 'lucide-react';
import { Button } from '../components/ui/button';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import dynamic from 'next/dynamic';
import { useAccounts } from '@/lib/contexts/AccountContext';
import { isTradingTime } from '@/lib/market/format';
import { searchStocks } from '@/lib/api';
import { DEFAULT_MARKET_SNAPSHOT, loadMarketSnapshot } from '@/lib/market/snapshot';
import type { MarketCardLabel, MarketSnapshot } from '@/lib/market/types';
import { isAuthRequiredView, loginUrl, parseHomeView } from '@/lib/authRedirect';

const StockSearch = dynamic(() => import('../components/StockSearch'), { ssr: false });
const StockDetail = dynamic(() => import('../components/StockDetail'), { ssr: false });
const StockChart = dynamic(() => import('../components/StockChart'), { ssr: false });
const AIAnalysis = dynamic(() => import('../components/AIAnalysis'), { ssr: false });
const SavedStocks = dynamic(() => import('../components/SavedStocks'), { ssr: false });
const CacheControl = dynamic(() => import('../components/CacheControl'), { ssr: false });
const ChangePasswordDialog = dynamic(() => import('../components/ChangePasswordDialog'), { ssr: false });
const AccountSwitcher = dynamic(() => import('@/components/AccountSwitcher'), { ssr: false });
const TurnoverMinuteChart = dynamic(() => import('@/components/TurnoverMinuteChart'), { ssr: false });
const SectorTrendTrajectory = dynamic(() => import('@/components/SectorTrendTrajectory'), { ssr: false });
const ShortEmotionChart = dynamic(() => import('@/components/ShortEmotionChart'), { ssr: false });

type HomeViewMode = 'stock' | 'market' | 'topic';

const MODE_STORAGE_KEY = 'alphabot-home-view-mode';
const VIEW_MODE_ORDER: HomeViewMode[] = ['stock', 'market', 'topic'];

const HOME_VIEW_MODES: Record<HomeViewMode, {
  navLabel: string;
  title: string;
  description: string;
  primary: string;
  ring: string;
  accentSoft: string;
  panelClassName: string;
}> = {
  stock: {
    navLabel: '个股',
    title: '探索股票市场',
    description: '搜索股票，查看实时数据，获取 AI 分析和建议。',
    primary: '#2563eb',
    ring: '#2563eb',
    accentSoft: 'rgba(37, 99, 235, 0.12)',
    panelClassName: 'border-blue-200/70 bg-blue-50/70 dark:border-blue-400/20 dark:bg-blue-400/10',
  },
  market: {
    navLabel: '市场',
    title: '追踪市场主线',
    description: '从指数、情绪、题材和强势股切入，先看盘面，再找机会。',
    primary: '#ea580c',
    ring: '#ea580c',
    accentSoft: 'rgba(234, 88, 12, 0.14)',
    panelClassName: 'border-orange-200/70 bg-orange-50/70 dark:border-orange-400/20 dark:bg-orange-400/10',
  },
  topic: {
    navLabel: '专题',
    title: '浏览专题内容',
    description: '只承接独立专题，不混入市场栏目。',
    primary: '#c026d3',
    ring: '#c026d3',
    accentSoft: 'rgba(192, 38, 211, 0.16)',
    panelClassName: 'border-fuchsia-200/70 bg-gradient-to-r from-amber-50/80 via-rose-50/75 to-fuchsia-50/80 dark:border-fuchsia-400/20 dark:from-amber-400/10 dark:via-rose-400/10 dark:to-fuchsia-400/10',
  },
};

const MARKET_DIAGNOSTICS = [
  {
    label: '趋势',
    toneClassName: 'text-orange-600 dark:text-orange-300',
    borderClassName: 'border-orange-200/80 dark:border-orange-400/20',
  },
  {
    label: '情绪',
    toneClassName: 'text-rose-600 dark:text-rose-300',
    borderClassName: 'border-rose-200/80 dark:border-rose-400/20',
  },
  {
    label: '主线',
    toneClassName: 'text-amber-600 dark:text-amber-300',
    borderClassName: 'border-amber-200/80 dark:border-amber-400/20',
  },
  {
    label: '赚钱效应',
    toneClassName: 'text-fuchsia-600 dark:text-fuchsia-300',
    borderClassName: 'border-fuchsia-200/80 dark:border-fuchsia-400/20',
  },
] as const;

const MARKET_CARD_LABELS = MARKET_DIAGNOSTICS.map((item) => item.label);
const EMPTY_CARD_REFRESH: Record<MarketCardLabel, boolean> = {
  趋势: false,
  情绪: false,
  主线: false,
  赚钱效应: false,
};

function toneTextClassName(tone?: 'up' | 'down' | 'normal') {
  if (tone === 'down') return 'text-emerald-600 dark:text-emerald-300';
  if (tone === 'up') return 'text-orange-600 dark:text-orange-300';
  return 'text-foreground';
}

function signedToneClassName(value: number) {
  if (value > 0) return 'text-orange-600 dark:text-orange-300';
  if (value < 0) return 'text-emerald-600 dark:text-emerald-300';
  return 'text-muted-foreground';
}

function formatSignedPct(value: number) {
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`;
}

function boardHeightLabel(lbc: number) {
  if (lbc <= 1) return '首板';
  return `${lbc}板`;
}


export default function Home() {
  const router = useRouter();
  const { isAuthenticated, isReady, user, logout } = useAuth();
  const { selectedAccount } = useAccounts();
  const [selectedStock, setSelectedStock] = useState<StockInfo | null>(null);
  const [viewMode, setViewMode] = useState<HomeViewMode>('stock');
  const [modeReady, setModeReady] = useState(false);
  const [showUserMenu, setShowUserMenu] = useState(false);
  const [showChangePassword, setShowChangePassword] = useState(false);
  const [showTopicMenu, setShowTopicMenu] = useState(false);
  const [marketSnapshot, setMarketSnapshot] = useState<MarketSnapshot>(DEFAULT_MARKET_SNAPSHOT);
  const [marketLoading, setMarketLoading] = useState(false);
  const [cardRefreshing, setCardRefreshing] = useState<Record<MarketCardLabel, boolean>>(() => ({ ...EMPTY_CARD_REFRESH }));
  const [autoRefresh, setAutoRefresh] = useState<Record<MarketCardLabel, boolean>>(() => ({ ...EMPTY_CARD_REFRESH }));
  const [activeMarketCard, setActiveMarketCard] = useState<MarketCardLabel | null>(null);
  const [selectedEmotionDate, setSelectedEmotionDate] = useState<string | null>(null);
  const [emotionOverviewMode, setEmotionOverviewMode] = useState<'intraday' | 'short'>('short');
  const [shortEmotionCycle, setShortEmotionCycle] = useState<1 | 3 | 5 | 10 | 20>(5);
  const userMenuRef = useRef<HTMLDivElement>(null);
  const userButtonRef = useRef<HTMLButtonElement>(null);
  const topicMenuRef = useRef<HTMLDivElement>(null);
  const modeConfig = HOME_VIEW_MODES[viewMode];
  const emotionSeries = marketSnapshot.emotionSeries;
  const selectedEmotionPoint =
    emotionSeries.find((point) => point.fullDate === selectedEmotionDate) ??
    emotionSeries[emotionSeries.length - 1] ??
    null;

  useEffect(() => {
    if (!isReady) return;

    const viewParam = parseHomeView(new URLSearchParams(window.location.search).get('view'));
    const savedMode = parseHomeView(window.localStorage.getItem(MODE_STORAGE_KEY));
    const requested = viewParam ?? savedMode ?? 'stock';

    if (isAuthRequiredView(requested) && !isAuthenticated) {
      setViewMode('stock');
    } else {
      setViewMode(requested);
    }
    setModeReady(true);
  }, [isAuthenticated, isReady]);

  useEffect(() => {
    if (!modeReady || !isAuthenticated) return;
    window.localStorage.setItem(MODE_STORAGE_KEY, viewMode);
  }, [isAuthenticated, modeReady, viewMode]);

  useEffect(() => {
    if (!isReady || isAuthenticated) return;
    if (isAuthRequiredView(viewMode)) {
      setViewMode('stock');
    }
  }, [isAuthenticated, isReady, viewMode]);

  const refreshMarket = useCallback(async (labels: MarketCardLabel[] = MARKET_CARD_LABELS) => {
    setCardRefreshing((current) => {
      const next = { ...current };
      labels.forEach((label) => {
        next[label] = true;
      });
      return next;
    });
    try {
      const snapshot = await loadMarketSnapshot();
      setMarketSnapshot(snapshot);
    } catch (error: unknown) {
      console.error('加载市场总览失败:', error);
    } finally {
      setMarketLoading(false);
      setCardRefreshing((current) => {
        const next = { ...current };
        labels.forEach((label) => {
          next[label] = false;
        });
        return next;
      });
    }
  }, []);

  useEffect(() => {
    if (viewMode !== 'market' || !isAuthenticated) {
      return;
    }

    let active = true;
    setMarketLoading(true);
    loadMarketSnapshot()
      .then((snapshot) => {
        if (active) setMarketSnapshot(snapshot);
      })
      .catch((error: unknown) => {
        console.error('加载市场总览失败:', error);
        if (active) setMarketSnapshot(DEFAULT_MARKET_SNAPSHOT);
      })
      .finally(() => {
        if (active) setMarketLoading(false);
      });

    return () => {
      active = false;
    };
  }, [isAuthenticated, viewMode]);

  useEffect(() => {
    if (viewMode !== 'market' || !isAuthenticated) {
      return;
    }
    const enabled = MARKET_CARD_LABELS.filter((label) => autoRefresh[label]);
    if (enabled.length === 0) {
      return;
    }

    const timer = window.setInterval(() => {
      if (isTradingTime()) refreshMarket(enabled);
    }, 30000);

    return () => window.clearInterval(timer);
  }, [autoRefresh, isAuthenticated, refreshMarket, viewMode]);

  useEffect(() => {
    if (emotionSeries.length === 0) {
      setSelectedEmotionDate(null);
      return;
    }

    if (!selectedEmotionDate || !emotionSeries.some((point) => point.fullDate === selectedEmotionDate)) {
      setSelectedEmotionDate(emotionSeries[emotionSeries.length - 1].fullDate);
    }
  }, [emotionSeries, selectedEmotionDate]);

  // 处理点击外部关闭菜单
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        userMenuRef.current &&
        !userMenuRef.current.contains(event.target as Node) &&
        userButtonRef.current &&
        !userButtonRef.current.contains(event.target as Node)
      ) {
        setShowUserMenu(false);
      }
    };

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setShowUserMenu(false);
      }
    };

    if (showUserMenu) {
      document.addEventListener('mousedown', handleClickOutside);
      document.addEventListener('keydown', handleEscape);
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [showUserMenu]);

  useEffect(() => {
    if (!showTopicMenu) {
      return;
    }

    const handleClickOutside = (event: MouseEvent) => {
      if (topicMenuRef.current && !topicMenuRef.current.contains(event.target as Node)) {
        setShowTopicMenu(false);
      }
    };

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setShowTopicMenu(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [showTopicMenu]);

  // 处理退出登录
  const handleLogout = async () => {
    try {
      await logout();
      router.push('/login');
    } catch (error) {
      console.error('退出登录失败:', error);
    }
  };

  const handleSelectMarketStock = async (code: string, name: string) => {
    if (!code) return;
    const query = code.replace(/\.(SS|SZ|SH|BJ|HK|US)$/i, '').replace(/^(SH|SZ|BJ)/i, '');
    let stock: StockInfo | null = null;
    try {
      const response = await searchStocks(query);
      if (response.success && response.data && response.data.length > 0) {
        const digits = query.replace(/\D/g, '').padStart(6, '0').slice(-6);
        stock =
          response.data.find((item) => item.symbol.replace(/\D/g, '').includes(digits)) ||
          response.data.find((item) => item.name === name) ||
          response.data[0];
      }
    } catch (error) {
      console.error('搜索股票失败:', error);
    }
    if (!stock) {
      const digits = query.replace(/\D/g, '').padStart(6, '0').slice(-6);
      const suffix = digits.startsWith('6') || digits.startsWith('5') || digits.startsWith('9')
        ? 'SH'
        : digits.startsWith('4') || digits.startsWith('8')
          ? 'BJ'
          : 'SZ';
      stock = { symbol: `${digits}.${suffix}`, name, exchange: '', currency: 'CNY' };
    }
    setViewMode('stock');
    setSelectedStock(stock);
  };

  // 处理选择股票
  const handleSelectStock = (stock: StockInfo) => {
    setSelectedStock(stock);
    
    const detailsElement = document.getElementById('stock-details-section');
    if (detailsElement) {
      detailsElement.scrollIntoView({ behavior: 'smooth' });
    }
  };

  // 处理从收藏夹选择股票
  const handleSelectFromSaved = (symbol: string) => {
    // 这里简单处理，只设置symbol
    setSelectedStock({
      symbol,
      name: '',
      exchange: '',
      currency: '',
    });
  };

  const requestViewMode = (mode: HomeViewMode) => {
    if (!isReady) return;
    if (isAuthRequiredView(mode) && !isAuthenticated) {
      router.push(loginUrl('/', mode));
      return;
    }
    setViewMode(mode);
  };

  const cycleViewMode = () => {
    const currentIndex = VIEW_MODE_ORDER.indexOf(viewMode);
    const nextIndex = (currentIndex + 1) % VIEW_MODE_ORDER.length;
    requestViewMode(VIEW_MODE_ORDER[nextIndex]);
  };

  return (
    <div
      className="min-h-screen bg-background"
      style={
        {
          '--primary': modeConfig.primary,
          '--ring': modeConfig.ring,
        } as React.CSSProperties
      }
    >
      <header className="border-b border-border">
        <div className="container mx-auto px-4 py-4 flex items-center">
          <button
            type="button"
            onClick={cycleViewMode}
            className="group flex items-center gap-2 rounded-full px-1 py-1 text-left transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label={`切换首页视角，当前为 AlphaBot | ${modeConfig.navLabel}`}
          >
            <div className="flex items-center text-2xl font-bold text-primary">
              <ChartLine className="mr-2 h-6 w-6" />
              <span>AlphaBot</span>
            </div>
            <div className="flex flex-col leading-none">
              <div className="text-lg font-medium text-muted-foreground">
              <span className="mx-1 text-border">|</span>
              <span className="text-foreground">{modeConfig.navLabel}</span>
              </div>
            </div>
          </button>
          <div className="ml-auto flex items-center space-x-4">
            {isAuthenticated ? (
              <>
                <Link href="/agent">
                  <Button variant="ghost" className="flex items-center" size="sm">
                    <Bot className="h-5 w-5 mr-1" />
                    <span>智能助手</span>
                  </Button>
                </Link>
                <div className="relative">
                  <button
                    ref={userButtonRef}
                    onClick={() => setShowUserMenu(!showUserMenu)}
                    className="flex items-center text-muted-foreground hover:text-foreground"
                  >
                    <User className="h-5 w-5 mr-1" />
                    <span>{user?.username}</span>
                    {selectedAccount && (
                      <span className="ml-2 hidden rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600 md:inline">
                        {selectedAccount.name}
                      </span>
                    )}
                  </button>
                  {showUserMenu && (
                    <div
                      ref={userMenuRef}
                      className="absolute right-0 mt-2 w-48 py-2 bg-background border border-border rounded-md shadow-lg z-50"
                    >
                      <div className="px-4 py-2 border-b border-border">
                        <div className="text-sm font-medium">{user?.username}</div>
                        <div className="text-sm text-muted-foreground">积分: {user?.points}</div>
                        <div className="text-sm text-muted-foreground">
                          今日使用: {user?.daily_usage_count} / {user?.is_unlimited ? '无限制' : user?.daily_limit}
                        </div>
                      </div>
                      <AccountSwitcher />
                      <div
                        className="block px-4 py-2 text-sm text-foreground hover:bg-accent cursor-pointer"
                        onClick={() => {
                          setShowUserMenu(false);
                          setTimeout(() => router.push('/batch'), 10);
                        }}
                      >
                        <Bot className="h-4 w-4 inline mr-2" />
                        批量分析
                      </div>
                      <div
                        className="block px-4 py-2 text-sm text-foreground hover:bg-accent cursor-pointer"
                        onClick={() => {
                          setShowUserMenu(false);
                          setTimeout(() => router.push('/system'), 10);
                        }}
                      >
                        <Settings className="h-4 w-4 inline mr-2" />
                        系统管理
                      </div>
                      <button
                        onClick={() => {
                          setShowUserMenu(false);
                          setShowChangePassword(true);
                        }}
                        className="block w-full text-left px-4 py-2 text-sm text-foreground hover:bg-accent"
                      >
                        <Key className="h-4 w-4 inline mr-2" />
                        修改密码
                      </button>
                      <button
                        onClick={handleLogout}
                        className="block w-full text-left px-4 py-2 text-sm text-red-500 hover:bg-accent"
                      >
                        <LogOut className="h-4 w-4 inline mr-2" />
                        退出登录
                      </button>
                    </div>
                  )}
                </div>
              </>
            ) : (
              <Link
                href="/login"
                className="flex items-center text-muted-foreground hover:text-foreground"
              >
                <LogIn className="h-5 w-5 mr-1" />
                <span>登录</span>
              </Link>
            )}
            {/* <a
              href="https://www.jianshu.com/c/38a7568e2b6b"
              target="_blank"
              rel="noopener noreferrer"
              className="text-muted-foreground hover:text-foreground"
            >
              简书
            </a> */}
            <a
              href="https://github.com/x-pai/AlphaBot/discussions"
              target="_blank"
              rel="noopener noreferrer"
              className="text-muted-foreground hover:text-foreground"
            >
              讨论组
            </a>
            <a
              href="https://www.iwencai.com"
              target="_blank"
              rel="noopener noreferrer"
              className="text-muted-foreground hover:text-foreground"
            >
              问财
            </a>
            <Link
              href="/published/daily-market-brief"
              className="text-muted-foreground hover:text-foreground"
            >
              市场日报
            </Link>
            <a
              href="https://github.com/x-pai/alphabot"
              target="_blank"
              rel="noopener noreferrer"
              className="text-muted-foreground hover:text-foreground"
            >
              GitHub
            </a>
            <Link
              href="/about"
              className="flex items-center text-muted-foreground hover:text-foreground"
            >
              <Info className="h-5 w-5 mr-1" />
              <span>关于我们</span>
            </Link>
          </div>
        </div>
      </header>

      <main className="container mx-auto px-4 py-8">
        <div className="mb-8">
          <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4 mb-6">
            <div>
              <div className="mb-2 flex flex-wrap items-center gap-3">
                <h1 className="text-3xl font-bold">{modeConfig.title}</h1>
              </div>
              <p className="text-muted-foreground">
                {isAuthenticated ? 
                  modeConfig.description :
                  '登录后可获取更多功能，包括AI分析、个性化推荐等'
                }
              </p>
            </div>
            {isAuthenticated && (
              <div>
                <CacheControl />
              </div>
            )}
          </div>
          {viewMode === 'stock' ? (
            <StockSearch onSelectStock={handleSelectStock} />
          ) : !isAuthenticated ? (
            <div className="rounded-[24px] border border-dashed border-border/70 bg-background/60 px-6 py-12 text-center">
              <div className="text-lg font-semibold text-foreground">登录后查看{modeConfig.navLabel}</div>
              <p className="mt-2 text-sm text-muted-foreground">
                {viewMode === 'market' ? '市场主线、情绪和板块强度需要登录后使用。' : '专题内容需要登录后进入。'}
              </p>
              <Link href={loginUrl('/', viewMode === 'topic' ? 'topic' : 'market')} className="mt-5 inline-flex">
                <Button>立即登录</Button>
              </Link>
            </div>
          ) : viewMode === 'market' ? (
            <div className="space-y-6">
              <div className="grid gap-4 xl:grid-cols-4">
                {MARKET_DIAGNOSTICS.map((item) => {
                  const dynamicCard = marketSnapshot.diagnostics[item.label];
                  const isActive = activeMarketCard === item.label;
                  const refreshing = cardRefreshing[item.label];
                  const autoOn = autoRefresh[item.label];
                  return (
                    <div
                      key={item.label}
                      role="button"
                      tabIndex={0}
                      onClick={() => setActiveMarketCard((current) => (current === item.label ? null : item.label))}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault();
                          setActiveMarketCard((current) => (current === item.label ? null : item.label));
                        }
                      }}
                      className={`rounded-[22px] border bg-background/70 px-5 py-5 text-left transition-all hover:-translate-y-0.5 ${
                        item.borderClassName
                      } ${isActive ? 'border-primary/60 bg-primary/[0.05]' : ''}`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="text-sm font-medium text-foreground">{item.label}</div>
                        <div
                          className="flex items-center gap-1.5"
                          onClick={(event) => event.stopPropagation()}
                          onKeyDown={(event) => event.stopPropagation()}
                        >
                          <button
                            type="button"
                            title="刷新"
                            disabled={refreshing}
                            onClick={() => refreshMarket([item.label])}
                            className="rounded-full p-1 text-muted-foreground hover:bg-muted/70 hover:text-foreground disabled:opacity-50"
                          >
                            <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? 'animate-spin' : ''}`} />
                          </button>
                          <button
                            type="button"
                            role="switch"
                            aria-checked={autoOn}
                            title="自动刷新"
                            onClick={() =>
                              setAutoRefresh((current) => ({ ...current, [item.label]: !current[item.label] }))
                            }
                            className="inline-flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground"
                          >
                            <span>自动</span>
                            <span
                              className={`relative h-4 w-7 rounded-full transition-colors ${
                                autoOn ? 'bg-primary' : 'bg-muted'
                              }`}
                            >
                              <span
                                className={`absolute top-0.5 h-3 w-3 rounded-full bg-white shadow-sm transition-all ${
                                  autoOn ? 'left-3.5' : 'left-0.5'
                                }`}
                              />
                            </span>
                          </button>
                        </div>
                      </div>
                      <div className="mt-5 space-y-3">
                        {dynamicCard.facts.map((fact) => (
                          <div key={fact} className="flex items-start gap-3">
                            <span className="mt-2 h-1.5 w-1.5 rounded-full bg-primary" />
                            <span className="text-sm text-muted-foreground">{marketLoading ? '--' : fact}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>

              {!activeMarketCard ? (
                <div className="rounded-[24px] border border-dashed border-border/70 bg-background/35 px-5 py-4 text-sm text-muted-foreground">
                  点击上方卡片，查看对应图表与事实对比。
                </div>
              ) : (
                <>
                  {activeMarketCard === '趋势' ? (
                    <div className="space-y-4">
                      <TurnoverMinuteChart data={marketSnapshot.turnover} />
                      <SectorTrendTrajectory data={marketSnapshot.sectorTrend} onSelectStock={handleSelectMarketStock} />
                    </div>
                  ) : activeMarketCard === '情绪' ? (
                    <div className="space-y-4">
                      <div className="rounded-[24px] border border-border/70 bg-background/70 p-5">
                        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                          <div>
                            <div className="text-sm font-semibold text-foreground">
                              {emotionOverviewMode === 'intraday' ? '盘中情绪' : '连板天梯'}
                            </div>
                            <div className="mt-1 text-xs text-muted-foreground">
                              {emotionOverviewMode === 'intraday'
                                ? '跟踪盘中情绪波动节奏。'
                                : `观察近${shortEmotionCycle}日连板高度变化。`}
                            </div>
                          </div>
                          <div className="flex items-center justify-end gap-3 self-start">
                            {emotionOverviewMode === 'short' ? (
                              <div className="inline-flex rounded-full border border-border/60 bg-background/80 p-1">
                                {([1, 3, 5, 10, 20] as const).map((cycle) => {
                                  const active = shortEmotionCycle === cycle;
                                  return (
                                    <button
                                      key={cycle}
                                      type="button"
                                      onClick={() => setShortEmotionCycle(cycle)}
                                      className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                                        active ? 'bg-foreground text-background' : 'text-muted-foreground hover:text-foreground'
                                      }`}
                                    >
                                      {cycle}日
                                    </button>
                                  );
                                })}
                              </div>
                            ) : null}
                            <div className="inline-flex rounded-full border border-border/60 bg-muted/20 p-1">
                              {[
                                { key: 'intraday', label: '盘中情绪' },
                                { key: 'short', label: '连板天梯' },
                              ].map((item) => {
                                const active = emotionOverviewMode === item.key;
                                return (
                                  <button
                                    key={item.key}
                                    type="button"
                                    onClick={() => setEmotionOverviewMode(item.key as 'intraday' | 'short')}
                                    className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                                      active ? 'bg-orange-500 text-white' : 'text-muted-foreground hover:text-foreground'
                                    }`}
                                  >
                                    {item.label}
                                  </button>
                                );
                              })}
                            </div>
                          </div>
                        </div>
                        <div className="mt-4">
                          <ShortEmotionChart
                            mode={emotionOverviewMode}
                            cycle={shortEmotionCycle}
                            series={emotionSeries}
                            selectedDate={selectedEmotionDate}
                            onSelectDate={setSelectedEmotionDate}
                            onSelectStock={handleSelectMarketStock}
                          />
                        </div>
                      </div>

                      {selectedEmotionPoint && selectedEmotionPoint.geeseRows.length > 0 ? (
                        <div className="rounded-[24px] border border-border/70 bg-background/70 px-5 py-4">
                          <div className="mb-3 flex items-baseline justify-between gap-3">
                            <div className="text-sm font-semibold text-foreground">雁阵图</div>
                            <div className="text-xs text-muted-foreground">{selectedEmotionPoint.label}</div>
                          </div>
                          <div className="divide-y divide-border/50">
                            {selectedEmotionPoint.geeseRows.map((row) => {
                              const isFirst = row.progress === '首板';
                              const ratio = row.denominator > 0 ? Math.round((row.numerator / row.denominator) * 100) : 0;
                              const rateClass = isFirst
                                ? 'text-muted-foreground'
                                : ratio >= 60
                                  ? 'text-rose-600 dark:text-rose-300'
                                  : ratio >= 30
                                    ? 'text-amber-600 dark:text-amber-300'
                                    : 'text-emerald-600 dark:text-emerald-300';
                              return (
                                <div
                                  key={`${selectedEmotionPoint.fullDate}-${row.progress}`}
                                  className="grid grid-cols-1 gap-2 py-2.5 md:grid-cols-[64px_88px_minmax(0,1fr)] md:items-start"
                                >
                                  <div className="text-sm font-medium text-foreground">{row.progress}</div>
                                  <div className={`text-xs tabular-nums ${rateClass}`}>
                                    {isFirst ? `${row.numerator}只` : `${row.numerator}/${row.denominator} ${ratio}%`}
                                  </div>
                                  <div className="flex flex-wrap gap-1.5">
                                    {row.stocks.map((stock) => {
                                      const tone =
                                        stock.result === 'success'
                                          ? 'text-rose-700 dark:text-rose-300'
                                          : stock.result === 'broken'
                                            ? 'text-amber-700 dark:text-amber-300'
                                            : 'text-emerald-700 dark:text-emerald-300';
                                      const mark = isFirst ? '' : stock.result === 'success' ? '✓' : stock.result === 'broken' ? '⚡' : '✕';
                                      return (
                                        <button
                                          key={`${row.progress}-${stock.code || stock.name}`}
                                          type="button"
                                          onClick={() => handleSelectMarketStock(stock.code, stock.name)}
                                          className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs hover:bg-muted/60 ${tone}`}
                                        >
                                          {mark ? <span>{mark}</span> : null}
                                          <span>{stock.name}</span>
                                          {stock.plate ? (
                                            <span className="text-[10px] text-muted-foreground">{stock.plate}</span>
                                          ) : null}
                                        </button>
                                      );
                                    })}
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      ) : null}
                    </div>
                  ) : activeMarketCard === '主线' ? (
                    <div className="grid gap-4 lg:grid-cols-3">
                      {marketSnapshot.mainlineLanes.length === 0 ? (
                        <div className="rounded-[22px] border border-dashed border-border/70 bg-background/35 px-4 py-8 text-center text-sm text-muted-foreground lg:col-span-3">
                          暂无涨停主线
                        </div>
                      ) : null}
                      {marketSnapshot.mainlineLanes.map((lane) => {
                        const leader = lane.leader;
                        return (
                          <div key={lane.name} className="rounded-[22px] border border-border/70 bg-background/70 px-4 py-4">
                          <div className="flex items-start justify-between gap-3">
                            <div className="text-sm font-semibold text-foreground">{lane.name}</div>
                            {lane.value !== '--' ? (
                              <div className={`text-sm font-semibold tabular-nums ${signedToneClassName(lane.change)}`}>
                                {formatSignedPct(lane.change)}
                              </div>
                            ) : null}
                          </div>
                          <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                            {lane.value !== '--' ? (
                              <span className={`tabular-nums ${signedToneClassName(lane.netFlow)}`}>{lane.value}</span>
                            ) : null}
                            <span>涨停 {lane.ztCount}</span>
                            {lane.maxHeight > 0 ? <span>最高 {lane.maxHeight}板</span> : null}
                            {lane.upCount || lane.downCount ? (
                              <span>
                                涨{lane.upCount} 跌{lane.downCount}
                              </span>
                            ) : null}
                          </div>
                          <div className="mt-5 text-xs text-muted-foreground">龙头股</div>
                          {leader ? (
                            <button
                              type="button"
                              onClick={() => handleSelectMarketStock(leader.code, leader.name)}
                              className="mt-2 flex w-full items-center justify-between gap-3 rounded-xl bg-muted/25 px-3 py-2 text-left hover:bg-muted/40"
                            >
                              <span className="truncate text-sm font-medium text-foreground">{leader.name}</span>
                              <span className="shrink-0 text-xs font-semibold text-orange-600 dark:text-orange-300">
                                {boardHeightLabel(leader.lbc)}
                              </span>
                            </button>
                          ) : (
                            <div className="mt-2 text-sm text-muted-foreground">暂无涨停</div>
                          )}
                          <div className="mt-5 text-xs text-muted-foreground">跟随股</div>
                          {lane.followers.length > 0 ? (
                            <div className="mt-2 flex flex-wrap gap-1.5">
                              {lane.followers.map((stock, index) => (
                                <button
                                  key={`${lane.name}-${stock.code || stock.name}-${index}`}
                                  type="button"
                                  onClick={() => handleSelectMarketStock(stock.code, stock.name)}
                                  className="rounded-lg border border-border/60 bg-muted/20 px-2 py-1 text-xs text-foreground hover:border-orange-300 hover:text-orange-600"
                                >
                                  {stock.name}
                                  <span className="ml-1 text-orange-600/80 dark:text-orange-300">
                                    {boardHeightLabel(stock.lbc)}
                                  </span>
                                </button>
                              ))}
                            </div>
                          ) : (
                            <div className="mt-2 text-sm text-muted-foreground">暂无跟随</div>
                          )}
                        </div>
                        );
                      })}
                    </div>
                  ) : (
                    <div className="grid gap-4 lg:grid-cols-3">
                      {[
                        { title: '强势股', items: marketSnapshot.payoffLists.strong },
                        { title: '热榜', items: marketSnapshot.payoffLists.hot },
                        { title: '大面', items: marketSnapshot.payoffLists.bigface },
                      ].map((column) => (
                        <div key={column.title} className="rounded-[22px] border border-border/70 bg-background/70 px-4 py-4">
                          <div className="text-sm font-semibold text-foreground">{column.title}</div>
                          <div className="mt-4 space-y-3">
                            {column.items.length === 0 ? (
                              <div className="rounded-xl bg-muted/20 px-3 py-6 text-center text-xs text-muted-foreground">
                                暂无数据
                              </div>
                            ) : null}
                            {column.items.map((item) => (
                              <div key={`${column.title}-${item.name}`} className="rounded-xl bg-muted/20 px-3 py-3">
                                <div className="flex items-center justify-between gap-3">
                                  <div className="truncate text-sm font-medium text-foreground">{item.name}</div>
                                  <div className={`text-sm font-semibold ${toneTextClassName(item.tone)}`}>{item.value}</div>
                                </div>
                                <div className="mt-1 text-xs text-muted-foreground">{item.note}</div>
                              </div>
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>
          ) : (
            <div className="grid gap-4 lg:grid-cols-3">
              <Link
                href="/sentiment"
                className="group relative min-h-[280px] overflow-hidden rounded-[28px] border border-primary/15 bg-[radial-gradient(circle_at_top_left,_rgba(255,255,255,0.95),_rgba(255,255,255,0.82)_42%,_rgba(250,232,255,0.96))] p-6 transition-all hover:-translate-y-0.5 hover:border-primary/30 hover:shadow-[0_24px_44px_rgba(192,38,211,0.14)] dark:bg-[radial-gradient(circle_at_top_left,_rgba(88,28,135,0.42),_rgba(49,46,129,0.22)_45%,_rgba(76,29,149,0.32))]"
              >
                <div className="absolute -right-8 -top-8 h-32 w-32 rounded-full bg-primary/12 blur-3xl transition-transform group-hover:scale-125" />
                <div className="relative flex h-full flex-col justify-between gap-6">
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <div className="text-xs font-medium uppercase tracking-[0.24em] text-primary/80">Theme</div>
                      <h3 className="mt-3 text-2xl font-semibold tracking-tight text-foreground">情绪指标</h3>
                    </div>
                    <Flame className="mt-1 h-5 w-5 text-primary transition-transform group-hover:scale-110" />
                  </div>
                  <div>
                    <p className="max-w-xs text-sm leading-6 text-muted-foreground">
                      市场温度、风格切换、强弱节奏。
                    </p>
                    <div className="mt-6 inline-flex items-center rounded-full border border-primary/20 bg-background/80 px-3 py-1 text-sm text-foreground">
                      进入专题
                    </div>
                  </div>
                </div>
              </Link>
              <Link
                href="/worldcup"
                className="group relative min-h-[280px] overflow-hidden rounded-[28px] border border-primary/15 bg-[radial-gradient(circle_at_top_left,_rgba(255,255,255,0.94),_rgba(255,255,255,0.8)_42%,_rgba(254,242,242,0.96))] p-6 transition-all hover:-translate-y-0.5 hover:border-primary/30 hover:shadow-[0_24px_44px_rgba(192,38,211,0.14)] dark:bg-[radial-gradient(circle_at_top_left,_rgba(127,29,29,0.30),_rgba(88,28,135,0.22)_45%,_rgba(76,29,149,0.30))]"
              >
                <div className="absolute -right-8 -top-8 h-32 w-32 rounded-full bg-primary/10 blur-3xl transition-transform group-hover:scale-125" />
                <div className="relative flex h-full flex-col justify-between gap-6">
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <div className="text-xs font-medium uppercase tracking-[0.24em] text-primary/80">Event</div>
                      <h3 className="mt-3 text-2xl font-semibold text-foreground">世界杯专题</h3>
                    </div>
                    <Trophy className="mt-1 h-5 w-5 text-primary transition-transform group-hover:scale-110" />
                  </div>
                  <div>
                    <p className="max-w-xs text-sm leading-6 text-muted-foreground">
                      事件驱动内容与专题玩法入口。
                    </p>
                    <div className="mt-6 inline-flex items-center rounded-full border border-primary/20 bg-background/80 px-3 py-1 text-sm text-foreground">
                      进入专题
                    </div>
                  </div>
                </div>
              </Link>
              <div className="relative min-h-[280px] overflow-hidden rounded-[28px] border border-dashed border-primary/20 bg-background/70 p-6">
                <div className="absolute -right-8 -top-8 h-28 w-28 rounded-full bg-primary/8 blur-3xl" />
                <div className="relative flex h-full flex-col justify-between">
                  <div>
                    <div className="text-xs font-medium uppercase tracking-[0.24em] text-primary/80">More</div>
                    <h3 className="mt-3 text-2xl font-semibold tracking-tight text-foreground">更多专题</h3>
                  </div>
                  <p className="max-w-xs text-sm leading-6 text-muted-foreground">
                    预留给后续事件型、栏目型或阶段性专题。
                  </p>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* 修改密码对话框 */}
        <ChangePasswordDialog
          isOpen={showChangePassword}
          onClose={() => setShowChangePassword(false)}
        />

        {viewMode === 'stock' && selectedStock ? (
          <div id="stock-details-section" className="grid grid-cols-1 lg:grid-cols-3 gap-8 scroll-mt-8">
            <div className="lg:col-span-2 space-y-8">              
              <StockDetail symbol={selectedStock.symbol} />
              <StockChart symbol={selectedStock.symbol} />
              {isAuthenticated ? (
                <AIAnalysis symbol={selectedStock.symbol} />
              ) : (
                <div className="border border-border rounded-lg p-6 text-center">
                  <Bot className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
                  <h3 className="text-lg font-medium mb-2">AI 智能分析</h3>
                  <p className="text-muted-foreground mb-4">
                    登录后即可获取AI智能分析服务，包括：
                  </p>
                  <ul className="text-sm text-muted-foreground space-y-2 mb-6">
                    <li>• 技术指标分析</li>
                    <li>• 趋势预测</li>
                    <li>• 风险评估</li>
                    <li>• 个性化建议</li>
                  </ul>
                  <Link href="/login">
                    <Button>
                      立即登录
                    </Button>
                  </Link>
                </div>
              )}
            </div>
            <div>
              {isAuthenticated ? (
                <SavedStocks onSelectStock={handleSelectFromSaved} />
              ) : (
                <div className="border border-border rounded-lg p-6">
                  <h3 className="text-lg font-medium mb-2">收藏夹</h3>
                  <p className="text-muted-foreground mb-4">
                    登录后可以收藏关注的股票，随时查看最新动态
                  </p>
                  <Link href="/login">
                    <Button variant="outline" className="w-full">
                      登录以使用
                    </Button>
                  </Link>
                </div>
              )}
            </div>
          </div>
        ) : viewMode === 'stock' ? (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
            <div className="lg:col-span-2 flex items-center justify-center p-16 border border-dashed border-border rounded-lg">
              <div className="text-center">
                <Search className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
                <h2 className="text-xl font-medium mb-2">搜索股票</h2>
                <p className="text-muted-foreground">
                  输入股票代码或名称开始探索
                </p>
              </div>
            </div>
            <div>
              {isAuthenticated ? (
                <SavedStocks onSelectStock={handleSelectFromSaved} />
              ) : (
                <div className="border border-border rounded-lg p-6">
                  <h3 className="text-lg font-medium mb-2">收藏夹</h3>
                  <p className="text-muted-foreground mb-4">
                    登录后可以收藏关注的股票，随时查看最新动态
                  </p>
                  <Link href="/login">
                    <Button variant="outline" className="w-full">
                      登录以使用
                    </Button>
                  </Link>
                </div>
              )}
            </div>
          </div>
        ) : null}
      </main>

      <footer className="border-t border-border mt-16">
        <div className="container mx-auto px-4 py-8">
          <div className="text-center text-muted-foreground text-sm">
            <p>AlphaBot &copy; {new Date().getFullYear()}</p>
            <p className="mt-2">
              免责声明：本应用提供的数据和分析仅供参考，不构成投资建议。投资决策请结合个人风险承受能力和专业意见。
            </p>
          </div>
        </div>
      </footer>

      {isAuthenticated && viewMode !== 'topic' && (
        <div ref={topicMenuRef} className="fixed bottom-4 right-4 z-40 flex flex-col items-end gap-2 md:bottom-5 md:right-5">
          {showTopicMenu && (
            <>
              <Link
                href="/worldcup"
                className="flex items-center gap-2 rounded-2xl border border-border/70 bg-background/88 px-3.5 py-2.5 text-sm text-foreground shadow-[0_10px_24px_rgba(15,23,42,0.08)] backdrop-blur transition-all duration-200 hover:-translate-y-0.5 hover:border-emerald-500/25 hover:bg-emerald-500/[0.05] dark:border-border/70 dark:bg-card/88 dark:shadow-[0_14px_30px_rgba(2,6,23,0.28)] dark:hover:border-emerald-400/25 dark:hover:bg-emerald-400/[0.08]"
                onClick={() => setShowTopicMenu(false)}
              >
                <Trophy className="h-4 w-4 text-emerald-500 dark:text-emerald-300" />
                世界杯专题
              </Link>
              <Link
                href="/sentiment"
                className="flex items-center gap-2 rounded-2xl border border-border/70 bg-background/88 px-3.5 py-2.5 text-sm text-foreground shadow-[0_10px_24px_rgba(15,23,42,0.08)] backdrop-blur transition-all duration-200 hover:-translate-y-0.5 hover:border-amber-500/25 hover:bg-amber-500/[0.05] dark:border-border/70 dark:bg-card/88 dark:shadow-[0_14px_30px_rgba(2,6,23,0.28)] dark:hover:border-amber-400/25 dark:hover:bg-amber-400/[0.08]"
                onClick={() => setShowTopicMenu(false)}
              >
                <Flame className="h-4 w-4 text-amber-500 dark:text-amber-300" />
                情绪指标
              </Link>
            </>
          )}
          <button
            type="button"
            onClick={() => setShowTopicMenu((value) => !value)}
            aria-expanded={showTopicMenu}
            className={`flex items-center rounded-full border border-border/60 bg-background/88 text-foreground shadow-[0_10px_24px_rgba(15,23,42,0.10)] backdrop-blur transition-all duration-200 hover:-translate-y-0.5 hover:border-primary/20 hover:bg-card/96 dark:bg-slate-950/84 dark:text-white dark:shadow-[0_14px_34px_rgba(2,6,23,0.30)] dark:hover:border-cyan-400/15 dark:hover:bg-slate-950 ${
              showTopicMenu ? 'gap-2 px-3.5 py-2.5 text-sm font-medium' : 'h-11 w-11 justify-center'
            }`}
          >
            <Sparkles className={`h-4 w-4 text-cyan-500 transition-transform duration-200 dark:text-cyan-300 ${showTopicMenu ? 'rotate-45' : ''}`} />
            {showTopicMenu ? '收起专题' : <span className="sr-only">打开专题</span>}
          </button>
        </div>
      )}
    </div>
  );
}
