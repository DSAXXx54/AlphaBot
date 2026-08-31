/**
 * 策略权重校准器：回放池历史 → 收集反包/首板样本 → 触发组 vs 基线成功率差 → 写 calibrated。
 *
 * 运行：node_modules/.bin/jiti scripts/calibrate.ts [交易日数=60]
 * 输出：backend/data/strategy/private.calibrated.json（/market/strategy 自动合并下发）
 *
 * 拟合（每因子）：触发组成功率 p1 vs 基线 p0，delta = p1 - p0；
 *   惩罚项（分项贡献为负）方向翻转：被罚组成功率更低 = 惩罚有效 = 加权。
 *   new = clamp(old + round(effect × 30), 0.5×old, 1.5×old)，触发样本 <30 或未触发 <30 不动。
 * 数据：直接从选股宝上游拉取历史池（校准器为离线工具，不走后端）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { applyPrivateStrategy, getStrategy } from '../src/lib/market/strategy';
import { collectCalibrationSamples } from '../src/lib/market/cycle';
import { normalizeCode } from '../src/lib/market/format';

const FLASH = 'https://flash-api.xuangubao.com.cn/api';
const NATURAL_DAYS = Number(process.argv[2] || 90) + 30;
const REPO = path.resolve(__dirname, '..');
const OUT = path.join(REPO, '..', 'backend', 'data', 'strategy', 'private.calibrated.json');

type TopicStock = {
  name: string; code: string; reason: string; concepts?: string[];
  lbc: number; time: number; type: 'zt' | 'zb' | 'dt'; fund: number; price: number; zbc: number;
};
type WeightedSample = { breakdown: Record<string, number>; success: boolean };

async function getJson<T>(url: string): Promise<T> {
  let lastErr: Error | null = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const res = await fetch(url, { headers: { Accept: 'application/json' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()) as T;
    } catch (err) {
      lastErr = err as Error;
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    }
  }
  throw lastErr ?? new Error('fetch failed');
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function cstSealMinutes(ts?: number): number {
  if (!ts) return 565;
  return Math.floor(((ts + 8 * 3600) % 86400) / 60);
}

function mapPool(kind: 'zt' | 'zb' | 'dt', item: any): TopicStock {
  const plates = (item.surge_reason?.related_plates || []).map((p: any) => (p.plate_name || '').trim()).filter(Boolean);
  const ratio = Number(item.buy_lock_volume_ratio) || 0;
  const capital = Number(item.non_restricted_capital || item.total_capital) || 0;
  return {
    name: item.stock_chi_name || '',
    code: normalizeCode(String(item.symbol || '')) || '000000',
    reason: plates[0] || '其他',
    concepts: plates.length > 0 ? plates : undefined,
    lbc: kind === 'zt' ? Number(item.limit_up_days) || 1 : 0,
    time: cstSealMinutes(item.first_limit_up),
    type: kind,
    fund: Math.round(ratio * capital),
    price: Number(item.price) || 0,
    zbc: Number(item.break_limit_up_times) || 0,
  };
}

async function fetchPool(kind: 'zt' | 'zb' | 'dt', hyphen: string): Promise<TopicStock[]> {
  const poolName = kind === 'zt' ? 'limit_up' : kind === 'zb' ? 'limit_up_broken' : 'limit_down';
  const res = await getJson<any>(`${FLASH}/pool/detail?pool_name=${poolName}&date=${hyphen}`);
  if (res.code !== 20000 || !Array.isArray(res.data)) return [];
  return res.data.map((item: any) => mapPool(kind, item)).filter((s: TopicStock) => s.code !== '000000');
}

/**
 * 拟合：触发组成功率 p1 vs 基线 p0，delta = p1 - p0。
 * 惩罚项（分项贡献为负）方向翻转：被罚组成功率更低 = 惩罚有效 = 加权。
 */
function fitBinary(
  triggeredSuccess: number,
  triggeredN: number,
  baseline: { success: number; n: number },
  old: number,
  isPenalty: boolean,
): { newWeight: number; delta: number } | null {
  const othersSuccess = baseline.success - triggeredSuccess;
  const othersN = baseline.n - triggeredN;
  if (triggeredN < 30 || othersN < 30) return null; // 样本门槛
  const p1 = triggeredSuccess / triggeredN;
  const p0 = othersSuccess / othersN;
  const delta = p1 - p0;
  const effect = isPenalty ? -delta : delta;
  const raw = old + Math.round(effect * 30);
  const lo = Math.max(1, Math.round(old * 0.5));
  const hi = Math.round(old * 1.5);
  return { newWeight: Math.min(hi, Math.max(lo, raw)), delta };
}

function fitGroup(
  group: WeightedSample[],
  weights: Record<string, number>,
  label: string,
  report: Array<Record<string, unknown>>,
): void {
  const totalSuccess = group.filter((s) => s.success).length;
  const baseline = { success: totalSuccess, n: group.length };
  const factorKeys = new Set<string>();
  group.forEach((sample) => Object.keys(sample.breakdown).forEach((key) => factorKeys.add(key)));

  factorKeys.forEach((key) => {
    if (!(key in weights)) return;
    const old = weights[key];
    const triggered = group.filter((s) => s.breakdown[key] !== undefined);
    const isPenalty = (triggered[0]?.breakdown[key] ?? 0) < 0;
    const triggeredSuccess = triggered.filter((s) => s.success).length;
    const fit = fitBinary(triggeredSuccess, triggered.length, baseline, old, isPenalty);
    if (!fit) return;
    if (fit.newWeight !== old) weights[key] = fit.newWeight;
    report.push({ label, key, old, new: fit.newWeight, delta: Number(fit.delta.toFixed(3)), n: triggered.length });
  });
}

async function main() {
  // 基线权重：现有 calibrated 优先，否则出厂默认
  const defaultsPath = path.join(REPO, '..', 'backend', 'data', 'strategy', 'private.defaults.json');
  const defaults = JSON.parse(fs.readFileSync(defaultsPath, 'utf-8'));
  const baseline = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf-8')) : defaults;
  applyPrivateStrategy(baseline.private ?? baseline);
  console.log(`◆ 基线权重：${baseline.version || 'defaults'}`);

  // 交易日序列：近 NATURAL_DAYS 自然日的工作日（假期池为空自动跳过）
  const days: string[] = [];
  const today = new Date();
  for (let i = NATURAL_DAYS; i >= 1; i -= 1) {
    const d = new Date(today.getTime() - i * 86400000);
    if (d.getDay() !== 0 && d.getDay() !== 6) days.push(d.toISOString().slice(0, 10).replace(/-/g, ''));
  }
  console.log(`◆ 校准窗口：${days[0]} ~ ${days[days.length - 1]}（${days.length} 个工作日）`);

  // 拉取池历史
  const ztByDate = new Map<string, TopicStock[]>();
  const zbByDate = new Map<string, TopicStock[]>();
  for (const day of days) {
    const hyphen = `${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6, 8)}`;
    const [zt, zb] = await Promise.all([fetchPool('zt', hyphen), fetchPool('zb', hyphen)]);
    if (zt.length > 0) ztByDate.set(day, zt);
    if (zb.length > 0) zbByDate.set(day, zb);
    await sleep(800);
  }
  const validDays = days.filter((day) => (ztByDate.get(day) || []).length > 0);
  console.log(`◆ 池历史：${validDays.length} 个交易日有效（zt 总样本 ${[...ztByDate.values()].reduce((s, v) => s + v.length, 0)}）`);

  // 样本收集（复用现有评分函数链路；mainline 因子校准期无法回放，权重保持不变）
  const samples = collectCalibrationSamples({ days: validDays, ztByDate, zbByDate });
  const reboundSamples = samples.filter((s) => s.kind === 'rebound');
  const boardSamples = samples.filter((s) => s.kind === 'firstBoard');
  console.log(`◆ 样本：反包 ${reboundSamples.length}（成功 ${reboundSamples.filter((s) => s.success).length}）｜首板 ${boardSamples.length}（成功 ${boardSamples.filter((s) => s.success).length}）`);

  const report: Array<Record<string, unknown>> = [];
  const strategy = getStrategy();

  const reboundWeights = { ...strategy.rebound.weights };
  fitGroup(reboundSamples, reboundWeights, 'rebound', report);
  const firstBoardWeights = { ...strategy.relay.firstBoard } as unknown as Record<string, number>;
  fitGroup(boardSamples, firstBoardWeights, 'firstBoard', report);

  const output = {
    version: new Date().toISOString().slice(0, 10).replace(/-/g, ''),
    private: {
      rebound: { weights: reboundWeights },
      relay: { firstBoard: firstBoardWeights as unknown as Record<string, number> },
    },
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(output, null, 2));
  console.log(`\n◆ 已写入 ${OUT}`);
  const changed = report.filter((row) => row.old !== row.new);
  console.log(`◆ 权重变化（${changed.length}/${report.length} 项）：`);
  changed.forEach((row) => {
    console.log(`  ${row.label}.${row.key}: ${row.old} → ${row.new}（delta=${row.delta}, n=${row.n}）`);
  });
  if (changed.length === 0) console.log('  （全部因子无显著变化）');
}

main().catch((err) => { console.error(err); process.exit(1); });
