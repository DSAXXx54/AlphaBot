import { TTL, mapBatches, marketGet } from './client';
import { asNumber, formatAmount, formatAmountChange, formatChange, normalizeCode, yyyymmdd } from './format';
import type { MarketPayoffItem, TurnoverMinutePoint, TurnoverSnapshot } from './types';

export type PlateFlow = {
  code: string;
  name: string;
  change: number;
  netFlow: number;
  amount: number;
  upCount: number;
  downCount: number;
  flatCount: number;
};

export type TopicStock = {
  name: string;
  code: string;
  reason: string;
  lbc: number;
  time: number;
  type: 'zt' | 'zb' | 'dt';
  fund: number;
  price: number;
};

export type PlateMember = {
  code: string;
  name: string;
  price: number;
  change: number;
  amount: number;
  netFlow: number;
  turnoverRate: number;
};

export type SurgeLimitStock = {
  code: string;
  name: string;
  plates: string[];
  analysis?: string;
};

type ClistItem = {
  f2?: number | string;
  f3?: number | string;
  f6?: number | string;
  f8?: number | string;
  f12?: string;
  f14?: string;
  f62?: number | string;
  f104?: number | string;
  f105?: number | string;
  f106?: number | string;
};

type ClistResponse = { data?: { diff?: ClistItem[] | Record<string, ClistItem> } };
type KlineResponse = { data?: { klines?: string[] } };
type PoolItem = { n?: string; c?: string; hybk?: string; fbt?: number; lbc?: number; fund?: number; p?: number };
type TopicPoolResponse = { data?: { pool?: PoolItem[] } };
type ThsEnvelope<T> = { status_code?: number; data?: T };
type TurnoverCharts = {
  header?: Array<{ key?: string; val?: number }>;
  point_list?: Array<Array<number | null>>;
  x_label_list?: string[];
  charts?: TurnoverCharts;
};

const EM_UT = '7eea3edcaed734bea9cbfc24409ed989';
const LIST_LIMIT = 8;

function clistDiff(payload: ClistResponse | null | undefined): ClistItem[] {
  const diff = payload?.data?.diff;
  if (!diff) return [];
  return Array.isArray(diff) ? diff : Object.values(diff);
}

function parseTime(fbt: number | undefined): number {
  if (!fbt) return 565;
  const s = String(Math.round(fbt)).padStart(6, '0');
  return parseInt(s.slice(0, 2), 10) * 60 + parseInt(s.slice(2, 4), 10);
}

function mapPool(type: TopicStock['type'], item: PoolItem): TopicStock {
  return {
    name: item.n || '',
    code: item.c || '',
    reason: item.hybk || '其他',
    lbc: type === 'zt' ? item.lbc || 1 : 0,
    time: parseTime(item.fbt),
    type,
    fund: item.fund || 0,
    price: (item.p || 0) / 1000,
  };
}

function poolUrl(type: TopicStock['type'], dateStr: string): string {
  const path = type === 'zt' ? '/getTopicZTPool' : type === 'zb' ? '/getTopicZBPool' : '/getTopicDTPool';
  const sort = type === 'dt' ? 'fund:asc' : 'fbt:asc';
  return `https://push2ex.eastmoney.com${path}?ut=${EM_UT}&dpt=wz.ztzt&Pageindex=0&Pagesize=500&sort=${encodeURIComponent(sort)}&date=${dateStr.replace(/-/g, '')}&cb=__em`;
}

async function loadPool(type: TopicStock['type'], dateStr: string, latest: boolean): Promise<TopicStock[]> {
  const ttl = latest ? TTL.seconds(20) : TTL.hours(8);
  try {
    const data = await marketGet<TopicPoolResponse>(poolUrl(type, dateStr), ttl, !latest);
    return (data?.data?.pool || []).map((item) => mapPool(type, item));
  } catch {
    return [];
  }
}

export async function loadTradingDays(limit = 20): Promise<string[]> {
  const url =
    'https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=1.000001&fields1=f1,f2,f3,f4,f5,f6&fields2=f51&klt=101&fqt=1&end=20500101&lmt=30&cb=__em';
  try {
    const json = await marketGet<KlineResponse>(url, TTL.minutes(30), true);
    const days = (json.data?.klines || [])
      .map((line) => line.slice(0, 10).replace(/-/g, ''))
      .filter((day) => /^\d{8}$/.test(day));
    if (days.length > 0) return days.slice(-limit);
  } catch {
    // calendar fallback
  }
  const days: string[] = [];
  const cursor = new Date();
  while (days.length < limit) {
    const day = cursor.getDay();
    if (day !== 0 && day !== 6) days.unshift(yyyymmdd(cursor));
    cursor.setDate(cursor.getDate() - 1);
  }
  return days;
}

export async function loadTurnover(): Promise<TurnoverSnapshot | null> {
  const url = 'https://dq.10jqka.com.cn/fuyao/market_analysis_api/chart/v1/get_chart_data?chart_key=turnover_minute';
  try {
    const json = await marketGet<ThsEnvelope<TurnoverCharts>>(url, TTL.seconds(15));
    if (json.status_code !== 0 || !json.data) return null;
    const charts = json.data.charts ?? json.data;
    const pointList = charts.point_list || [];
    const labels = charts.x_label_list || [];
    const valid = pointList.filter((point) => point && point[1] != null);
    if (valid.length === 0) return null;
    const last = valid[valid.length - 1];
    const current = Number(last[1]);
    const previous = last[2] == null ? null : Number(last[2]);
    const predict = Number(charts.header?.find((item) => item.key === 'predict_turnover')?.val) || 0;
    const change = predict - (previous || 0);
    const points: TurnoverMinutePoint[] = pointList.map((point, index) => ({
      time: labels[index] || '',
      today: point?.[1] == null ? null : Number(point[1]),
      yesterday: point?.[2] == null ? null : Number(point[2]),
    }));
    return {
      current,
      predict,
      previous,
      change,
      currentText: formatAmount(current),
      predictText: formatAmount(predict),
      previousText: formatAmount(previous),
      changeText: formatAmountChange(change),
      points,
    };
  } catch {
    return null;
  }
}

function plateListUrl(po: 0 | 1, pz = 100) {
  return `https://push2.eastmoney.com/api/qt/clist/get?np=1&fltt=2&invt=2&fid=f62&fs=${encodeURIComponent('m:90+t:3')}&fields=f2,f3,f6,f12,f14,f62,f104,f105,f106&pn=1&pz=${pz}&po=${po}&cb=__em`;
}

function parsePlateList(payload: ClistResponse | null | undefined): PlateFlow[] {
  return clistDiff(payload)
    .filter((item) => item.f12)
    .map((item) => ({
      code: item.f12 || '',
      name: item.f14 || '',
      change: asNumber(item.f3),
      netFlow: asNumber(item.f62) / 1e8,
      amount: asNumber(item.f6) / 1e8,
      upCount: asNumber(item.f104),
      downCount: asNumber(item.f105),
      flatCount: asNumber(item.f106),
    }));
}

export async function loadPlateFlows(): Promise<{ inflow: PlateFlow[]; outflow: PlateFlow[] }> {
  try {
    const [inData, outData] = await Promise.all([
      marketGet<ClistResponse>(plateListUrl(1), TTL.seconds(20)),
      marketGet<ClistResponse>(plateListUrl(0), TTL.seconds(20)),
    ]);
    return {
      inflow: parsePlateList(inData).slice(0, 5),
      outflow: parsePlateList(outData).slice(0, 5),
    };
  } catch {
    return { inflow: [], outflow: [] };
  }
}

/** 合并流入/流出榜，供主线等板块名称匹配 */
export async function loadPlates(): Promise<PlateFlow[]> {
  const { inflow, outflow } = await loadPlateFlows();
  const merged = new Map<string, PlateFlow>();
  [...inflow, ...outflow].forEach((plate) => {
    if (!merged.has(plate.code)) merged.set(plate.code, plate);
  });
  return Array.from(merged.values()).sort((a, b) => b.netFlow - a.netFlow);
}

export async function loadTopicPools(days: string[]): Promise<{
  ztByDate: Map<string, TopicStock[]>;
  zbByDate: Map<string, TopicStock[]>;
  dtByDate: Map<string, TopicStock[]>;
}> {
  const ztByDate = new Map<string, TopicStock[]>();
  const zbByDate = new Map<string, TopicStock[]>();
  const dtByDate = new Map<string, TopicStock[]>();
  if (days.length === 0) return { ztByDate, zbByDate, dtByDate };

  const latest = days[days.length - 1];
  const rows = await mapBatches(days, 6, async (day) => {
    const latestDay = day === latest;
    const [zt, zb, dt] = await Promise.all([
      loadPool('zt', day, latestDay),
      loadPool('zb', day, latestDay),
      latestDay ? loadPool('dt', day, true) : Promise.resolve([] as TopicStock[]),
    ]);
    return { day, zt, zb, dt };
  });
  rows.forEach(({ day, zt, zb, dt }) => {
    ztByDate.set(day, zt);
    zbByDate.set(day, zb);
    if (dt.length > 0) dtByDate.set(day, dt);
  });
  return { ztByDate, zbByDate, dtByDate };
}

export async function loadPlateMembers(code: string): Promise<PlateMember[]> {
  const url = `https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=80&po=1&np=1&fltt=2&invt=2&fid=f3&fs=${encodeURIComponent(`b:${code}`)}&fields=f2,f3,f6,f8,f12,f14,f62&cb=__em`;
  try {
    const data = await marketGet<ClistResponse>(url, TTL.seconds(30));
    return clistDiff(data)
      .filter((item) => item.f12)
      .map((item) => ({
        code: item.f12 || '',
        name: item.f14 || '',
        price: asNumber(item.f2),
        change: asNumber(item.f3),
        amount: asNumber(item.f6) / 1e8,
        netFlow: asNumber(item.f62) / 1e8,
        turnoverRate: asNumber((item as ClistItem & { f8?: number | string }).f8),
      }));
  } catch {
    return [];
  }
}

export type PlateDayBar = {
  date: string;
  open: number;
  pct: number;
  close: number;
  high: number;
  low: number;
  amount: number;
};

function parseJsonOrJsonp<T>(payload: unknown): T {
  if (payload instanceof ArrayBuffer) {
    const text = new TextDecoder('utf-8').decode(new Uint8Array(payload));
    return parseJsonOrJsonp<T>(text);
  }
  if (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView(payload)) {
    const view = payload as ArrayBufferView;
    const text = new TextDecoder('utf-8').decode(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
    return parseJsonOrJsonp<T>(text);
  }
  if (payload && typeof payload === 'object') return payload as T;
  const text = typeof payload === 'string' ? payload : String(payload ?? '');
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) return JSON.parse(trimmed) as T;
  const left = trimmed.indexOf('(');
  const right = trimmed.lastIndexOf(')');
  if (left === -1 || right === -1 || right <= left) {
    throw new Error('invalid jsonp payload');
  }
  return JSON.parse(trimmed.slice(left + 1, right)) as T;
}

function parsePlateKlines(data: KlineResponse): PlateDayBar[] {
  return (data.data?.klines || [])
    .map((line) => {
      const parts = line.split(',');
      const date = (parts[0] || '').replace(/-/g, '');
      const open = Number(parts[1]);
      const close = Number(parts[2]);
      const high = Number(parts[3]);
      const low = Number(parts[4]);
      const amount = Number(parts[6]);
      const pct = Number(parts[8]);
      if (!date || Number.isNaN(pct)) return null;
      return {
        date,
        open: Number.isNaN(open) ? 0 : open,
        close: Number.isNaN(close) ? 0 : close,
        high: Number.isNaN(high) ? 0 : high,
        low: Number.isNaN(low) ? 0 : low,
        amount: Number.isNaN(amount) ? 0 : amount / 1e8,
        pct,
      };
    })
    .filter((bar): bar is PlateDayBar => bar !== null);
}

function foxAgentRequest(url: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (typeof window === 'undefined' || typeof window.foxAgentCrossRequest !== 'function') {
      reject(new Error('foxAgentCrossRequest unavailable'));
      return;
    }
    window.foxAgentCrossRequest({
      url,
      method: 'GET',
      success(body) {
        resolve(body);
      },
      error(error) {
        console.warn('[market] foxAgentCrossRequest error', error instanceof Error ? error.message : String(error));
        reject(error instanceof Error ? error : new Error(typeof error === 'string' ? error : JSON.stringify(error)));
      },
    });
  });
}

export async function loadPlateDayKline(code: string, limit = 12): Promise<PlateDayBar[]> {
  const secid = code.startsWith('90.') ? code : `90.${code}`;
  const baseQuery = `secid=${encodeURIComponent(secid)}&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61&klt=101&fqt=1&end=20500101&lmt=${limit}`;
  const url = `https://push2his.eastmoney.com/api/qt/stock/kline/get?${baseQuery}&cb=__em`;
  const foxUrl = `https://push2his.eastmoney.com/api/qt/stock/kline/get?${baseQuery}`;
  try {
    if (typeof window !== 'undefined' && typeof window.foxAgentCrossRequest === 'function') {
      const payload = await foxAgentRequest(foxUrl);
      return parsePlateKlines(parseJsonOrJsonp<KlineResponse>(payload));
    }
    console.info('[market] loadPlateDayKline fallback to marketGet', { code, secid, limit });
    const data = await marketGet<KlineResponse>(url, TTL.minutes(5), true);
    return parsePlateKlines(data);
  } catch (error) {
    console.warn('[market] loadPlateDayKline failed', {
      code,
      secid,
      limit,
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

export async function loadSurgeLimitUp(): Promise<SurgeLimitStock[]> {
  const url = `https://flash-api.xuangubao.com.cn/api/surge_stock/stocks?normal=true&uplimit=true&_=${Date.now()}`;
  try {
    const data = await marketGet<{ code?: number; data?: { items?: Array<Array<unknown>> } }>(url, TTL.seconds(30));
    if (data.code !== 20000 || !data.data?.items) return [];
    return data.data.items
      .map((item) => {
        const symbol = String(item[0] || '');
        const plates = Array.isArray(item[8])
          ? item[8]
              .map((plate) => (plate && typeof plate === 'object' ? String((plate as { name?: string }).name || '') : ''))
              .filter(Boolean)
          : [];
        return {
          code: normalizeCode(symbol),
          name: String(item[1] || ''),
          plates,
          analysis: String(item[5] || '').trim() || undefined,
        };
      })
      .filter((item) => item.code && item.code !== '000000');
  } catch {
    return [];
  }
}

export async function loadIndustryPlateCodes(): Promise<Map<string, string>> {
  const url = `https://push2.eastmoney.com/api/qt/simple/screen?fltt=2&invt=2&fields=f57,f58,f116&secids=${encodeURIComponent('m:90+t:3')}&cb=__em`;
  const map = new Map<string, string>();
  try {
    const data = await marketGet<{ data?: { diff?: Array<{ f57?: string; f58?: string }> | Record<string, { f57?: string; f58?: string }> } }>(
      url,
      TTL.hours(8),
      true
    );
    const diff = data?.data?.diff;
    const rows = Array.isArray(diff) ? diff : diff ? Object.values(diff) : [];
    rows.forEach((item) => {
      if (item.f58 && item.f57) map.set(item.f58, item.f57);
    });
  } catch {
    // keep empty map
  }
  return map;
}

export async function searchPlateCodeByName(name: string): Promise<string | null> {
  const map = await loadIndustryPlateCodes();
  return map.get(name) || null;
}

export async function loadStrong(): Promise<MarketPayoffItem[]> {
  const url = 'https://flash-api.xuangubao.com.cn/api/pool/detail?pool_name=super_stock';
  try {
    const data = await marketGet<{
      code?: number;
      data?: Array<{
        stock_chi_name?: string;
        change_percent?: number;
        surge_reason?: { related_plates?: Array<{ plate_name?: string }> };
        m_days_n_boards_days?: number;
        m_days_n_boards_boards?: number;
      }>;
    }>(url, TTL.minutes(1));
    if (data.code !== 20000 || !data.data) return [];
    return data.data
      .filter((item) => {
        const name = item.stock_chi_name || '';
        return name && !name.includes('ST');
      })
      .map((item) => {
        const change = item.change_percent ? Number((item.change_percent * 100).toFixed(2)) : 0;
        const plate = item.surge_reason?.related_plates?.[0]?.plate_name || '';
        const days = item.m_days_n_boards_days || 0;
        const boards = item.m_days_n_boards_boards || 0;
        return {
          name: item.stock_chi_name || '--',
          value: formatChange(change),
          note: [plate, `${days}天${boards}板`].filter(Boolean).join(' / '),
          tone: (change >= 0 ? 'up' : 'down') as 'up' | 'down',
          change,
        };
      })
      .sort((a, b) => b.change - a.change)
      .slice(0, LIST_LIMIT)
      .map(({ change: _change, ...item }) => item);
  } catch {
    return [];
  }
}

export async function loadHot(): Promise<MarketPayoffItem[]> {
  const url = 'https://dq.10jqka.com.cn/fuyao/hot_list_data/out/hot_list/v1/stock?stock_type=a&type=hour&list_type=normal';
  try {
    const data = await marketGet<
      ThsEnvelope<{
        stock_list?: Array<{
          name?: string;
          rise_and_fall?: number;
          rate?: string | number;
          tag?: { popularity_tag?: string; concept_tag?: string[] };
          analyse_title?: string;
        }>;
      }>
    >(url, TTL.minutes(1));
    if (data.status_code !== 0 || !data.data?.stock_list) return [];
    return data.data.stock_list.slice(0, LIST_LIMIT).map((item) => {
      const change = item.rise_and_fall || 0;
      const hotRate = item.rate ? `${(parseFloat(String(item.rate)) / 10000).toFixed(1)}万` : '0万';
      const tag = item.tag?.popularity_tag || item.tag?.concept_tag?.[0] || item.analyse_title || '';
      return {
        name: item.name || '--',
        value: formatChange(change),
        note: tag ? `${hotRate}热度 / ${tag}` : `${hotRate}热度`,
        tone: (change >= 0 ? 'up' : 'down') as 'up' | 'down',
      };
    });
  } catch {
    return [];
  }
}

export async function loadBigFace(days: string[]): Promise<MarketPayoffItem[]> {
  const candidates = days.length > 0 ? days.slice(-3).reverse() : [yyyymmdd()];
  for (const dateStr of candidates) {
    const url = `https://data.10jqka.com.cn/mobileapi/hotspot_focus/stock_pool/v1/get_drawdown_stocks?date=${dateStr}&cate=limit_up&sort_field=max_drawdown&sort_dir=asc&page=1&size=200`;
    try {
      const data = await marketGet<
        ThsEnvelope<{
          stock_list?: Array<{
            is_st?: boolean;
            stock_name?: string;
            change?: string | number;
            max_drawdown?: string | number;
            industry_block?: string;
          }>;
        }>
      >(url, TTL.minutes(5), true);
      const rows = data.data?.stock_list?.filter((item) => !item.is_st) || [];
      if (rows.length === 0) continue;
      return rows
        .map((item) => {
          const change = parseFloat(String(item.change)) || 0;
          const drawdown = parseFloat(String(item.max_drawdown)) || 0;
          return {
            name: item.stock_name || '--',
            value: formatChange(change),
            note: `回撤 ${drawdown.toFixed(2)}%${item.industry_block ? ` / ${item.industry_block}` : ''}`,
            tone: (change >= 0 ? 'up' : 'down') as 'up' | 'down',
            max_drawdown: drawdown,
          };
        })
        .sort((a, b) => a.max_drawdown - b.max_drawdown)
        .slice(0, LIST_LIMIT)
        .map(({ max_drawdown: _drawdown, ...item }) => item);
    } catch {
      // try older trading day
    }
  }
  return [];
}
