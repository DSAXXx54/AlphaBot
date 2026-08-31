import { normalizePlateName } from './format';
import { getStrategy, type StrategyConfig } from './strategy';
import type { PlateFlow } from './api';

/** 板块过滤名单来自 strategy.ts 的 plateFilter 节点；按配置对象引用做惰性编译缓存 */
type CompiledFilter = {
  src: StrategyConfig['plateFilter'];
  excludeExact: Set<string>;
  excludePatterns: RegExp[];
  deweightPatterns: RegExp[];
  whitelist: Set<string>;
};
let compiled: CompiledFilter | null = null;

function compiledFilter(): CompiledFilter {
  const plateFilter = getStrategy().plateFilter;
  if (!compiled || compiled.src !== plateFilter) {
    compiled = {
      src: plateFilter,
      excludeExact: new Set(plateFilter.excludeExact.map((name) => normalizePlateName(name))),
      excludePatterns: plateFilter.excludePatterns.map((pattern) => new RegExp(pattern)),
      deweightPatterns: plateFilter.deweightPatterns.map((pattern) => new RegExp(pattern)),
      whitelist: new Set(plateFilter.whitelist.map((name) => normalizePlateName(name))),
    };
  }
  return compiled;
}

function plateNameKey(name: string) {
  return normalizePlateName(name || '');
}

export function isTrendExcludedPlate(name: string): boolean {
  const filter = compiledFilter();
  const key = plateNameKey(name);
  if (!key) return true;
  if (filter.whitelist.has(key)) return false;
  if (filter.excludeExact.has(key)) return true;
  return filter.excludePatterns.some((pattern) => pattern.test(name));
}

export function getTrendPlateWeight(name: string): number {
  const filter = compiledFilter();
  const key = plateNameKey(name);
  if (!key) return 0;
  if (filter.whitelist.has(key)) return 1;
  if (isTrendExcludedPlate(name)) return 0;
  if (filter.deweightPatterns.some((pattern) => pattern.test(name))) return getStrategy().plateFilter.deweight;
  return 1;
}

export function filterTrendPlateUniverse(plates: PlateFlow[]): PlateFlow[] {
  return plates.filter((plate) => !isTrendExcludedPlate(plate.name));
}
