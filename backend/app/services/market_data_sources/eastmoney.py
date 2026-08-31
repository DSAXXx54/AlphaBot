"""东方财富实现（骨架）：逐方法补齐后，通过 MarketDataSourceFactory.reconfigure 绑定切换。"""

from __future__ import annotations

from typing import Any, Dict, List, Optional

from app.services.market_data_sources.base import (
    FundflowRow, IndexBarItem, MarketDataSourceBase, MemberItem, PayoffRawItem,
    PlateItem, PoolItem, QuoteItem, SurgeItem, TrendingPlateItem, TurnoverData,
)


class EastmoneyMarketDataSource(MarketDataSourceBase):
    """东方财富数据源（骨架）。

    领域契约见 base.py；接入步骤：
    1. 逐方法实现（输出领域对象）；
    2. 双跑对比（与现源同日期落库，出覆盖率/口径差报告）；
    3. reconfigure 切换绑定 + 校准器对新源重拟合。
    """

    async def fetch_pool(self, kind: str, date: Optional[str] = None) -> List[PoolItem]:
        raise NotImplementedError("eastmoney fetch_pool 尚未实现")

    async def fetch_universe(self) -> List[PlateItem]:
        raise NotImplementedError("eastmoney fetch_universe 尚未实现")

    async def fetch_surge(self) -> List[SurgeItem]:
        raise NotImplementedError("eastmoney fetch_surge 尚未实现")

    async def fetch_quotes(self, codes: List[str]) -> Dict[str, QuoteItem]:
        raise NotImplementedError("eastmoney fetch_quotes 尚未实现")

    async def fetch_fundflow(self, codes: List[str], days: int) -> Dict[str, List[FundflowRow]]:
        raise NotImplementedError("eastmoney fetch_fundflow 尚未实现")

    async def fetch_members(self, plate_id: str) -> List[MemberItem]:
        raise NotImplementedError("eastmoney fetch_members 尚未实现")

    async def fetch_plate_index(self, plate_id: str, count: int) -> List[IndexBarItem]:
        raise NotImplementedError("eastmoney fetch_plate_index 尚未实现")

    async def fetch_payoff(self, kind: str, date: Optional[str] = None) -> List[PayoffRawItem]:
        raise NotImplementedError("eastmoney fetch_payoff 尚未实现")

    async def fetch_turnover(self) -> TurnoverData:
        raise NotImplementedError("eastmoney fetch_turnover 尚未实现")

    async def fetch_trending(self) -> List[TrendingPlateItem]:
        raise NotImplementedError("eastmoney fetch_trending 尚未实现")
