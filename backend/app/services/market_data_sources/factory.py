"""市场数据源工厂：数据集 → 数据源实例（per-dataset 绑定，配置驱动）。"""

from __future__ import annotations

import json
import os
from typing import Dict, Type

from app.core.config import settings
from app.services.market_data_sources.base import MarketDataSourceBase
from app.services.market_data_sources.eastmoney import EastmoneyMarketDataSource
from app.services.market_data_sources.ths import ThsMarketDataSource
from app.services.market_data_sources.xgb import XgbMarketDataSource


class MarketDataSourceFactory:
    """市场数据源工厂（对齐 stock 域 DataSourceFactory 惯例）。

    与 stock 域的唯一差异：get_data_source 按"数据集"解析而非全局源名——
    市场页面同时消费池子/宇宙/异动/资金流等多个数据集，允许混合绑定
    （如 pools 走 eastmoney、题材标签留 xgb）。绑定来自 settings.MARKET_DATA_BINDINGS。
    """

    _source_classes: Dict[str, Type[MarketDataSourceBase]] = {
        "xgb": XgbMarketDataSource,
        "eastmoney": EastmoneyMarketDataSource,
        "ths": ThsMarketDataSource,
    }

    _instances: Dict[str, MarketDataSourceBase] = {}

    # per-dataset 绑定（可用 settings.MARKET_DATA_BINDINGS / env 覆盖）
    _bindings: Dict[str, str] = {
        "pools": "xgb",
        "universe": "xgb",
        "surge": "xgb",
        "quotes": "xgb",
        "fundflow": "xgb",
        "trending": "xgb",
        "members": "xgb",
        "plate_index": "xgb",
        "payoff_strong": "xgb",
        "turnover": "ths",
        "payoff_hot": "ths",
        "payoff_drawdown": "ths",
    }

    @classmethod
    def get_data_source(cls, dataset: str) -> MarketDataSourceBase:
        """获取某数据集绑定的数据源实例（无效绑定回退默认源）。"""
        source_name = cls._bindings.get(dataset, settings.DEFAULT_MARKET_DATA_SOURCE)
        if source_name not in cls._source_classes:
            source_name = settings.DEFAULT_MARKET_DATA_SOURCE
        if source_name not in cls._instances:
            cls._instances[source_name] = cls._source_classes[source_name]()
        return cls._instances[source_name]

    @classmethod
    def reconfigure(cls, bindings: Dict[str, str]) -> None:
        """热更新绑定（双跑对比后灰度切换）；非法源名忽略。"""
        valid = {k: v for k, v in bindings.items() if v in cls._source_classes and k in cls._bindings}
        if valid:
            cls._bindings.update(valid)

    @classmethod
    def current_bindings(cls) -> Dict[str, str]:
        return dict(cls._bindings)


def _load_bindings_from_settings() -> None:
    raw = settings.MARKET_DATA_BINDINGS
    if not raw:
        return
    try:
        MarketDataSourceFactory.reconfigure(json.loads(raw))
    except ValueError:
        pass


_load_bindings_from_settings()
