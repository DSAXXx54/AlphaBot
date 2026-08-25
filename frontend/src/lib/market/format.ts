export function asNumber(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value !== '-' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

export function normalizeCode(code: string): string {
  return code.replace(/\.(SS|SZ|SH|BJ|HK|US)$/i, '').replace(/^(SH|SZ|BJ)/i, '').padStart(6, '0');
}

export function yyyymmdd(date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}

export function isoDate(value: string): string {
  if (!value || value.length < 8) return value;
  return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
}

export function formatShortDate(fullDateStr: string): string {
  if (!fullDateStr || fullDateStr.length < 8) return fullDateStr;
  return `${fullDateStr.slice(4, 6)}/${fullDateStr.slice(6, 8)}`;
}

export function formatAmount(val: number | null | undefined): string {
  if (val == null) return '--';
  const yi = Number(val) / 1e8;
  if (!Number.isFinite(yi)) return '--';
  if (yi >= 10000) return `${(yi / 10000).toFixed(1)}万亿`;
  if (yi >= 1000) return `${(yi / 1000).toFixed(1)}千亿`;
  return `${yi.toFixed(0)}亿`;
}

export function formatAmountChange(val: number | null | undefined): string {
  if (val == null) return '--';
  const yi = Number(val) / 1e8;
  return `${yi > 0 ? '+' : ''}${yi.toFixed(0)}亿`;
}

export function formatPlateFlow(netFlow: number): string {
  return `${netFlow >= 0 ? '+' : ''}${netFlow.toFixed(2)}亿`;
}

export function formatChange(value: number): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`;
}

export function isTradingTime(now = new Date()): boolean {
  const day = now.getDay();
  if (day === 0 || day === 6) return false;
  const cm = now.getHours() * 60 + now.getMinutes();
  return (cm >= 555 && cm <= 690) || (cm >= 780 && cm <= 900);
}

export function normalizePlateName(name: string): string {
  return name
    .normalize('NFKC')
    .replace(/[（(]申万[）)]/g, '')
    .replace(/申万/g, '')
    .replace(/[ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ]/g, '')
    .replace(/[IVX]+$/i, '')
    .replace(/[()（）\s]/g, '')
    .trim();
}

export function matchPlate<T extends { name: string }>(plates: T[], name: string): T | undefined {
  const raw = name.trim();
  if (!raw || raw === '其他') return undefined;
  const exact = plates.find((plate) => plate.name === raw);
  if (exact) return exact;
  const key = normalizePlateName(raw);
  if (!key) return undefined;
  const normalized = plates.find((plate) => normalizePlateName(plate.name) === key);
  if (normalized) return normalized;
  return plates
    .filter((plate) => {
      const plateKey = normalizePlateName(plate.name);
      return plateKey.length >= 2 && (key.startsWith(plateKey) || plateKey.startsWith(key));
    })
    .sort((a, b) => normalizePlateName(b.name).length - normalizePlateName(a.name).length)[0];
}
