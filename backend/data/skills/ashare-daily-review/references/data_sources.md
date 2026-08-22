# 数据来源与工具清单（ashare-daily-review）

本文件列出复盘流程（SKILL.md 第 3 节）可用的真实数据源及关键字段。
所有调用必须基于工具实际返回；字段名以下方为准，未返回即标【未获取】。

## A. westock-mcp（腾讯自选股，已连接）

### data_changedist — 沪深A股涨跌分布
- 参数：`type`（默认 0 = 沪深A股）
- 返回关键字段：
  - `upCount` / `downCount` / `flatCount`（涨跌平家数）
  - `upLimitCount` / `downLimitCount`（涨停/跌停数）
  - `totalAmount`（总成交额，元）；`amountChange`（环比，元，负=缩量）
  - `detail[]`：各涨幅区间（涨停 / >7% / 7~5% / 5~2% / 2~0% / 平 / 0~2% / 2~5% / 5~7% / 7<% / 跌停）及 count
- 用途：市场状态、涨跌停、量能。

### data_market_overview — 市场总览
- 参数：`type`（summary|trade|interval|technical|updown|margin|valuation|rotation|all），`date`
- 关键：`updown` 给涨跌比；`summary` 给市场画像评分（SENTIMENT_STATUS 情绪、TREND_SHORT/LONG 趋势、VALUATION 估值、VOLUME_ENERGE 量能、CAP_ROTATION 大小盘、SECTOR_ROTATION 行业轮动）
- ⚠️ 注意：该接口部分 type 返回的 `date` 可能是前一日（如 8-19），以 `data_changedist` 的实时值为当日广度权威。使用前核对 date 字段。

### data_index / data_quote / data_kline — 指数与行情
- `data_index`：主要指数行情（点位、涨跌幅）。
- `data_quote`（code=sh000001 等）：单指数/个股实时收盘。
- `data_kline`：历史K线（用于关键位置/均线研判）。
- 用途：市场状态中的指数精确涨跌幅；若返回为空，用新闻定性并标【未获取】。

### data_sector — 板块
- 参数：`mode`（list|search|constituent|info|ranking|oper），`scope`（sw1=申万一级），`code`，`query`，`date`，`limit`
- `mode=list, scope=sw1`：申万一级行业清单（配合其他接口取涨跌幅）。
- `mode=search, query=题材`：题材成分与领涨。
- 用途：资金结构、主线题材强弱。

### data_hot — 热搜/热度
- 参数：`kind`（stock|wechat|news|board|etf），`limit`
- `kind=board`：板块热度排名（含 `zdf` 涨跌幅）—— 主线题材强弱核心源。
- `kind=stock`：人气个股（含 `zdf`、`status`）—— 连板/涨停股候选。
- `kind=news`：热搜新闻（`news_title`/`source`/`publish_time`）—— 消息归因核心源。

### data_lhb — 龙虎榜
- 参数：`date`，`type`（jg=机构 / yzb=一线游资 / yyb=营业部 / gslmr / gslxw / hgt=沪股通 / sgt=深股通；逗号分隔，默认全部）
- `jg[]`：机构席位，`instBuyAmt`（机构买额，负=净卖）、`netBuyAmt`（净买额）、`tdDays`（上榜天数）
- `yyb[]`：`name`（营业部）、`stockName`、`buyAmt`（买入额）
- 用途：情绪周期——机构/游资合力与分歧、北向方向。

### data_fund_flow — 个股资金流
- 参数：`code`/`codes`（必填，sh600519 格式）、`date`
- 用途：验证主线个股的主力净流入/流出方向。

### data_stocklist — 股单
- 参数：`mode`（rank|detail），`id`，`limit`
- `mode=rank`：概念股单榜单，每条含 `avgChangePct`（股单平均涨幅）、`accChangePct1M`（近1月）—— 识别最强题材（如创新药 avgChangePct）。
- 用途：主线题材强度佐证。

### data_news / data_notice / data_report
- `data_news`：`symbol`（必填，如 sh600519）、`type`（0公告1研报2新闻3全部）、`mode`（list|detail）
- `data_notice`：公司公告。
- `data_report`：研报。
- 用途：消息归因的**个股级验证（步骤 D 强制）**。对当日主线/情绪锚点个股必拉，确认是否有当日公告/研报驱动，避免把行业新闻误当个股原因。

### data_calendar — 财经日历
- 参数：`date`、`market`（hs/hk/us）、`event`、`limit`
- 用途：消息归因的日程事件（政策/数据发布）。

### data_macro — 宏观（步骤 D 强制）
- 参数：`mode`（list|indicator|expect）、`names`、`region`、`start`/`end`
- `mode=list`：先看指标目录，确定可用 `names`。
- `mode=indicator` + `names`（如 CPI,PPI,PMI,社融,新增贷款）+ 日期范围：拉取实际值。
- `region`（如 us）：海外宏观与预期（`mode=expect`）。
- 用途：宏观背景定调（降息预期→贵金属、PMI→顺周期），与盘面印证，不孤立引用。

### 外围市场（海外/美股/港股/外盘期货/汇率）— 复盘第 1 段"市场状态·外围市场"专用

> **时差铁律**：复盘在当日 **21:30 之后**执行，此时美股已开盘但**未收盘**（北京时间约次日凌晨 4:00 收），港股与 A 股当日已收盘。因此：
> - 美股指数/ETF：必须标注"**当日盘中（截至复盘时刻 HH:MM，未收盘）**"，**严禁**当作 T-1 隔夜或当日收盘。
> - 港股：标注"**当日收盘**"。
> - 外盘期货：标注其交易时段与 `updateTime`/`isDelayed`。

**data_quote（美股/港股指数）— 代码实测可用**：
- 美股：`usIXIC`（纳斯达克综指）、`usDJI`（道琼斯）、`usSPY`（标普500 ETF，作标普代表）、`usQQQ`（纳指100 ETF）。
  - 调用：`data_quote` codes="usIXIC,usDJI,usSPY"。返回 `price`/`prev_close`/`change_percent`/`time`（time 为当日，即盘中实时）。
  - 注：`usSPX` 单个指数代码未返回，用 `usSPY`（标普500 ETF）替代标普。
- 港股：`hkHSI`（恒生指数，当日收盘）；可选 `hkHSCEI`（恒生科技/国企）。
- 用途：外围段的美股盘中强弱 + 港股收盘，映射次日 A 股风险偏好/北向预期。

**data_futures（外盘期货）**：
- 黄金 `fuGC`（COMEX黄金）、原油 `fuCL`（WTI）、`hf_OIL`（布伦特）、铜 `fuHG`（COMEX铜）、`hf_CAD`（LME铜）。
- 调用：`data_futures` mode=quote code="fuGC"。返回 `lastPrice`/`prevClose`/`changePct`/`high`/`low`/`updateTime`/`isDelayed`。
- 用途：大宗（金/油/铜）是 A 股有色/能源/贵金属板块的海外定价锚。

**data_forex（汇率，局限提示）**：
- 品种：`fxDINIW`（美元指数）、`fxCNH`（离岸人民币）、`fxUSDCNY`（美元人民币）等。
- 调用：`data_forex` mode=quote query="美元指数"。
- ⚠️ 实测该接口当前仅返回品种列表、不含实时价位；若取不到数值，外围段该维度标 **【未获取】**，不编造。可用 `data_macro`(region=us) 的美元/利率维度补充。

## B. tdx-connector（通达信，已连接）

用于补充行情/筛选：`tdx_quotes`（批量行情）、`tdx_kline`（K线）、
`tdx_lookup_stock`（代码查询）、`tdx_screener`（条件选股）、
`tdx_indicator_query` / `tdx_technical_indicator_query`（技术指标）。
当 westock-mcp 某项缺失或需交叉验证时使用。

## C. 持仓类工具（仅当用户授权）

`get_my_positions` / `get_my_trades` / `get_portfolio_summary` / `get_orders`。
无授权或用户未提供持仓时，报告第 6 段"持仓交易"整段标注"未提供持仓数据，跳过"。

## D. 字段速查：今日(2026-08-20)实测样例

- 广度（data_changedist）：up 4096 / down 1347 / flat 105，涨停 84 / 跌停 13，成交 ~2.08 万亿，环比 -432 亿（缩量）。
- 热点板块（data_hot board）：生物制品 +7.85%、创新药 +4.52%、贵金属 +5.50%、房地产开发 +1.11%；昨日涨停 -1.57%、航天装备 -5.66%。
- 龙虎榜主线：医药（石药创新/博腾股份/康泰生物/安科生物）获游资集中买入，机构对部分医药/化工高位净卖。
- 消息（data_hot news）：mRNA 癌症疫苗突破+政策两大利好引爆创新药；上海"沪八条"地产新政；商务部回应欧美关税；日韩反攻。
