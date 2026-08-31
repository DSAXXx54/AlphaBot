# Strategy Files

本目录用于存放 market 模块的私有策略权重文件。**核心策略 = 各评分的 fitted 权重，不属于开源内容**，因此真实权重不入库，仓库内只保留可替换的默认文件与说明。

## 文件角色

- `private.defaults.json`
  实际使用的私有默认策略文件（真实权重），**已加入 `.gitignore`，永不入库**。
  缺失时服务会按后端内置结构骨架自动生成一个空文件；你可以直接替换成自己的版本，或由校准器产出
  （校准器产物 `private.calibrated*.json` 同样不入库）。

## 运行链路

1. `GET /market/strategy` 时，后端直接读取 `private.defaults.json`。
2. 如果 `private.defaults.json` 不存在、为空或损坏，后端按代码里的 `DEFAULT_PRIVATE` 结构骨架自动生成一个全 0 占位文件，再写回 `private.defaults.json`。
3. `PUT /market/strategy` 也直接改写 `private.defaults.json`。
4. 因此文件是当前唯一真相源，文件变更会在下次读取时立即生效。

> 注意：首次部署自动生成得到的是**全 0 占位权重**（各评分得 0 分），不是可用策略。
> 上线前必须写入真实权重，见下方「运维」。

## private / public

- `private`
  后端下发的私有覆盖段，只放各评分的 fitted 权重（本文件介绍的字段）。
  当前唯一真相源就是 `private.defaults.json`，经 `/market/strategy` 下发，不出现在前端仓库。
- `public`
  结构、展示参数、容量限制和公开名单，定义在
  [frontend/src/lib/market/strategy.ts](/Users/ben/Workspace/Git/x-pai.com/AlphaBot/frontend/src/lib/market/strategy.ts:1)
  的 `PUBLIC_STRATEGY`。前端各评分代码从 `getStrategy()` 读权重，
  不允许硬编码（主线/接力首板/资金强度/反包均已接入）。

前端实际合并顺序：`PUBLIC_STRATEGY` < 后端 `/market/strategy` 返回的 `private`。
private 未加载时，主线/反包/接力评分整体降级为空（snapshot 层守卫），public 参数始终可用。

## 顶层结构

```json
{
  "version": "defaults",          // 默认版本标记；
                                  // PUT /market/strategy 手动写入且未指定 version 时为 manual-YYYYmmddHHMMSS
  "private": { ... }              // 四个私有节点：mainline / rebound / relay / flowStrength
}
```

## 字段介绍

单位约定：封单/资金为**亿元**，封板时刻为**开盘起分钟数**，股价为**元**，其余为分数或次数。

### mainline.weights —— 主线三卡评分（`mainline.ts`）

总分 = attack + ladder + position + flow + persistence + quality + catalyst（catalyst 为 public 段的 `catalystBonus`）。

| 字段 | 含义 | 参与公式 |
|---|---|---|
| attackPerBoard | 每单位有效涨停的攻击分 | attack = min(有效涨停数, attackCap) × attackPerBoard |
| attackCap | 攻击项的有效涨停数上限 | 同上 |
| maxHeight | 组内最高板的每板分 | ladder = min(maxHeight×maxHeight + 板高加权和×heightSum, ladderCap) |
| heightSum | 组内各股板高（按概念权重折算）和的每板分 | 同上 |
| ladderCap | 梯队项封顶 | 同上 |
| marketMaxBonus | 组最高板 = 全市场最高板的加成 | position |
| marketSecondBonus | 组最高板 = 市场第二高板的加成 | position |
| flowScale | 资金项整体缩放 | flow = (净流入额百分位×flowNetShare + 单位家数净流入百分位×(1−flowNetShare)) × flowScale |
| flowNetShare | 净流入额百分位在资金项里的占比（余下给强度百分位） | 同上 |
| persistPerDay | 题材每个活跃日加分 | persistence = min(活跃天数, public.persistDays) × persistPerDay + min(历史涨停家数累计, persistZtCap) × persistZt |
| persistZt | 历史每日涨停家数累计的每家加分 | 同上 |
| persistZtCap | persistZt 累计家数封顶 | 同上 |
| earlyShare | 早封（封板时刻 ≤ public.earlySealMinutes）成员占比的每 1% 加分 | quality = 早封占比×earlyShare + min(封单合计亿, sealFundCap)×sealFund − min(炸板次数, breakCap)×breakPenalty，下限 0 |
| sealFund | 封单合计每亿元的加分 | 同上 |
| sealFundCap | 封单合计计分封顶（亿元） | 同上 |
| breakPenalty | 每次炸板扣分 | 同上 |
| breakCap | 炸板扣分次数封顶 | 同上 |

### rebound.weights —— 异动反包评分（`cycle.ts` scoreReboundPick）

| 字段 | 含义 |
|---|---|
| sweetMin / sweetMax | 前高"甜区"边界（板数）：前高落在 [sweetMin, sweetMax] 得 prevHeight 分 |
| prevHeight | 前高在甜区内的得分 |
| prevHeightFirst | 首板反包（前高 = 1）得分 |
| prevHeightHigh | 前高高于甜区（> sweetMax）得分 |
| gap1Confirmed / gap1Watch | 断 1 日的得分：确认组（已回封）/ 观察池各一档 |
| gap2 | 断 2 日得分 |
| gapDeep | 断 ≥3 日得分 |
| washReseal | 炸板回封（当日炸板洗盘后回封）得分 |
| earlySeal | 回封时刻 ≤ public.rebound.earlySealMinutes 的得分 |
| fundStrong / fundStrongYi | 封单 ≥ fundStrongYi 亿时的得分档 |
| fundMid / fundMidYi | 封单 ≥ fundMidYi 亿（不足强档）时的得分档 |
| turnoverBest / turnoverBestMin / turnoverBestMax | 换手率落在甜区 [min,max] 的加分 |
| turnoverMid / turnoverMidMin / turnoverMidMax | 换手率落在次优区间 [min,max) 的加分 |
| turnoverHotPenalty / turnoverHotMin | 换手率 ≥ turnoverHotMin% 视为过热，触发扣分 |
| zbcHigh | 炸板次数"高位"阈值：次数 ≥ zbcHigh 触发重罚 |
| zbcPenalty | 炸板次数 ≥ zbcHigh 的扣分 |
| zbcMidPenalty | 炸板次数 = zbcHigh − 1 的中档扣分 |
| wasLeader | 曾空间龙头（前高 ≥ 当时市场最高板）加成 |
| inMainline | 属于主线题材加成 |
| leaderGrade / leaderGradeMaxGap | 龙头级反包：前高 ≥ sweetMin 且 ≥ 当日市场最高板 − leaderGradeMaxGap 时的加成 |

### relay.firstBoard —— 龙头接力首板缩圈评分（`cycle.ts` scoreFirstBoard）

| 字段 | 含义 |
|---|---|
| theme | 与断板龙头概念有交集（同题材）得分 |
| clusterTiers | 题材集群度分档阈值 [高, 低]（今日涨停家数） |
| clusterScores | 集群度得分 [≥tiers[0], ≥tiers[1], ≥2] 三档 |
| earlySeal / earlySealEnd | 封板时刻 ≤ earlySealEnd 分钟（约 10:00）得分 |
| morningSeal / morningSealEnd | 封板时刻 ≤ morningSealEnd 分钟（约 10:30）的次档得分 |
| lowPrice / lowPriceMax | 股价 ≤ lowPriceMax 元的得分档 |
| midPrice / midPriceMax | 股价 ≤ midPriceMax 元（不足低价档）的次档得分 |
| fundStrong / fundStrongYi | 封单 ≥ fundStrongYi 亿的得分档 |
| fundMid / fundMidYi | 封单 ≥ fundMidYi 亿的次档得分 |
| turnoverBest / turnoverBestMin / turnoverBestMax | 换手率落在甜区 [min,max] 的加分 |
| turnoverMid / turnoverMidMin / turnoverMidMax | 换手率落在次优区间 [min,max) 的加分 |
| turnoverHotPenalty / turnoverHotMin | 换手率 ≥ turnoverHotMin% 视为过热，触发扣分 |
| lowZbc / lowZbcMax | 炸板次数 ≤ lowZbcMax 的"低炸板"加分 |

### flowStrength —— 资金强度（`flowStrength.ts`）

结果 = clamp(50 + amount分量×amount + ratio分量×ratio + bigOrder分量×bigOrder − defensive分量×defensive, 0, 100)，各分量先按对应 clamp 归一到 [0,1]。

| 字段 | 含义 |
|---|---|
| amount | 成交额百分位分量的权重 |
| ratio / ratioClamp | 主力净流入占比分量权重 / 归一分母（%） |
| bigOrder / bigClamp | 超大单+大单净占比分量权重 / 归一分母（%） |
| defensive / defClamp | 中单+小单净占比（防守盘）惩罚权重 / 归一分母（%） |

## 运维

- **写入真实权重**：直接编辑 `private.defaults.json`，或 `PUT /market/strategy`
  （body：`{"private": {...}, "version": "..."}`）。两者都会直接改写文件，下一次请求立即生效。
- **校准器**（规划中）：产出的 `private.calibrated*.json` 同样不入库，
  写入方式同上（写文件 + 刷 Redis，或 PUT 接口）。
- **改字段结构**：权重键必须与前端 `StrategyConfig` 的节点结构一致
  （见 `frontend/src/lib/market/strategy.ts` 的类型定义）；结构变更需同步：
  前端类型 + `PRIVATE_NODE_KEYS` + `DEFAULT_PRIVATE` 骨架 + 后端无结构假设（透传 dict）。
