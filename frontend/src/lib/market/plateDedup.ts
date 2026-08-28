import type { PlateFlow } from './api';
import { normalizePlateName } from './format';

/**
 * 同题材归并（零请求名称粗筛）：
 * t:3 概念宇宙近义概念多（AI应用/AI智能体/AIGC概念… 实测两两成份股重叠系数 0.30–0.59），
 * 会挤占候选位。这里按名称把近义概念并成一组，只留一个代表板，其余进 relatedPlates 供展示。
 *
 * 规则（标准力度，对应实测重叠系数 ≥0.4 的聚类；交叉边如 AI应用~信创 0.44 不并——题材催化剂不同）：
 *  1. THEME_FAMILIES 词典——名称不相干但成份高度重叠的近义族；
 *  2. 名称互含——归一名互含且短名 ≥3 字（全 t:3 宇宙实测仅 6 对，误伤极低）。
 */
const THEME_FAMILIES: string[][] = [
  // AI 大模型应用系（实测两两 OC 0.30–0.59）
  ['AI应用', 'AI智能体', 'AIGC概念', 'ChatGPT概念', 'DeepSeek概念', 'Kimi概念', '多模态AI', '智谱AI概念'],
  // 信创/国产软件系（信创~国产软件 0.46、国产软件~财税数字化 0.44、数字经济~财税数字化 0.41）
  ['信创', '国产软件', '财税数字化', '数字经济'],
  // 机器人系（名称同含"机器人"，属同一题材车道）
  ['机器人概念', '人形机器人', '机器人执行器', '虚拟机器人'],
  // 存储系
  ['存储芯片', '高带宽内存'],
  // 光互连系（CPO 与光模块成份股高度重合）
  ['CPO概念', '光通信模块'],
  // 游戏文娱（网络游戏~文娱消费 0.42）
  ['网络游戏', '文娱消费'],
];

const FAMILY_INDEX = new Map<string, number>();
THEME_FAMILIES.forEach((family, index) => {
  family.forEach((name) => {
    const key = normalizePlateName(name);
    if (key && !FAMILY_INDEX.has(key)) FAMILY_INDEX.set(key, index);
  });
});

function familyKey(name: string): number | undefined {
  return FAMILY_INDEX.get(normalizePlateName(name));
}

function namesContainEachOther(a: string, b: string): boolean {
  const ka = normalizePlateName(a);
  const kb = normalizePlateName(b);
  if (!ka || !kb || ka === kb || ka.length < 3 || kb.length < 3) return false;
  return ka.includes(kb) || kb.includes(ka);
}

export type PlateGroup = {
  /** 代表板：涨停/强势背书最高，平手取主力净流入 */
  representative: PlateFlow;
  /** 组内全部板块（含代表），供涨停计数/高亮股按组匹配 */
  members: PlateFlow[];
  /** 被归并的板名，展示"同题材板块" */
  related: string[];
};

/** 对候选板块做同题材归并；backing 为板块的涨停/强势背书计数，用于选代表板。 */
export function dedupeCandidatePlates(plates: PlateFlow[], backing: (plate: PlateFlow) => number): PlateGroup[] {
  // 并查集：同词典族或名称互含 → 同组
  const parent = plates.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };

  for (let i = 0; i < plates.length; i += 1) {
    for (let j = i + 1; j < plates.length; j += 1) {
      const fa = familyKey(plates[i].name);
      const fb = familyKey(plates[j].name);
      if ((fa !== undefined && fa === fb) || namesContainEachOther(plates[i].name, plates[j].name)) {
        union(i, j);
      }
    }
  }

  const buckets = new Map<number, PlateFlow[]>();
  plates.forEach((plate, index) => {
    const root = find(index);
    const bucket = buckets.get(root) || [];
    bucket.push(plate);
    buckets.set(root, bucket);
  });

  return Array.from(buckets.values()).map((members) => {
    const sorted = [...members].sort(
      (a, b) => backing(b) - backing(a) || b.netFlow - a.netFlow || b.change - a.change
    );
    const [representative] = sorted;
    return {
      representative,
      members: sorted,
      related: sorted.slice(1).map((plate) => plate.name),
    };
  });
}
