import { normalizePlateName } from './format';
import type { PlateFlow } from './api';

const EXCLUDE_EXACT = new Set(
  [
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
  ].map((name) => normalizePlateName(name))
);

const EXCLUDE_PATTERNS = [
  /^昨日/,
  /含一字/,
  /热股/,
  /^最近多板$/,
  /风格/,
  /(?:19|20)\d{2}(?:一季报|中报|半年报|三季报|年报)/,
  /预减/,
  /预增/,
  /预亏/,
  /扭亏/,
  /续亏/,
  /首亏/,
  /略增/,
  /略减/,
  /大幅上升/,
  /大幅下降/,
  /摘帽/,
  /摘星/,
  /破净/,
  /低市净率/,
  /低价股/,
  /超跌股/,
  /新高/,
  /破增发价/,
  /MSCI/,
  /罗素/,
  /标普/,
  /沪股通/,
  /做市/,
  /股通/,
  /重仓/,
  /持股/,
  /转债/,
];

const DEWEIGHT_PATTERNS = [/参股/, /自贸/, /振兴/];

const WHITELIST_EXACT = new Set(['券商概念', '互联网金融'].map((name) => normalizePlateName(name)));

function plateNameKey(name: string) {
  return normalizePlateName(name || '');
}

export function isTrendExcludedPlate(name: string): boolean {
  const key = plateNameKey(name);
  if (!key) return true;
  if (WHITELIST_EXACT.has(key)) return false;
  if (EXCLUDE_EXACT.has(key)) return true;
  return EXCLUDE_PATTERNS.some((pattern) => pattern.test(name));
}

export function getTrendPlateWeight(name: string): number {
  const key = plateNameKey(name);
  if (!key) return 0;
  if (WHITELIST_EXACT.has(key)) return 1;
  if (isTrendExcludedPlate(name)) return 0;
  if (DEWEIGHT_PATTERNS.some((pattern) => pattern.test(name))) return 0.7;
  return 1;
}

export function filterTrendPlateUniverse(plates: PlateFlow[]): PlateFlow[] {
  return plates.filter((plate) => !isTrendExcludedPlate(plate.name));
}
