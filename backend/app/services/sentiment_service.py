from __future__ import annotations

import asyncio
import json
import logging
import math
import re
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from statistics import median
from typing import Any, Iterable

import httpx
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.orm import Session

from app.core.config import settings
from app.models.sentiment import SentimentDailyMetrics, SentimentPoolRaw, SentimentSyncStatus
from app.schemas.sentiment import (
    SentimentBackfillResponse,
    SentimentCalendarResponse,
    SentimentCalendarDay,
    SentimentMetricPoint,
    SentimentMetricsResponse,
    SentimentSyncDateResponse,
)
from app.services.data_sources.tdx import TDXDataSource

logger = logging.getLogger("uvicorn")


POOL_TYPES = ("zt", "dt", "zbgc", "zrzt", "strong")


@dataclass
class PoolFetchResult:
    pool_type: str
    rows: list[dict[str, Any]]


class SentimentService:
    _trade_calendar_cache: list[date] | None = None
    _trade_calendar_loaded_at: datetime | None = None
    _sync_lock_guard: asyncio.Lock = asyncio.Lock()
    _sync_locks: dict[str, asyncio.Lock] = {}
    _tdx_source: TDXDataSource | None = None

    @staticmethod
    async def _run_sync(func, *args, **kwargs):
        return await asyncio.to_thread(func, *args, **kwargs)

    @classmethod
    async def _try_acquire_sync_lock(cls, trade_date: date) -> asyncio.Lock | None:
        key = trade_date.isoformat()
        async with cls._sync_lock_guard:
            lock = cls._sync_locks.get(key)
            if lock is None:
                lock = asyncio.Lock()
                cls._sync_locks[key] = lock
            if lock.locked():
                return None
            await lock.acquire()
            return lock

    @classmethod
    async def _release_sync_lock(cls, trade_date: date, lock: asyncio.Lock) -> None:
        key = trade_date.isoformat()
        async with cls._sync_lock_guard:
            if lock.locked():
                lock.release()
            current = cls._sync_locks.get(key)
            if current is lock and not lock.locked():
                cls._sync_locks.pop(key, None)

    @staticmethod
    def _load_akshare():
        try:
            import akshare as ak  # type: ignore
        except ModuleNotFoundError as exc:
            raise RuntimeError("akshare 未安装，无法执行情绪数据同步") from exc
        return ak

    @staticmethod
    def _format_pool_date(trade_date: date) -> str:
        return trade_date.strftime("%Y%m%d")

    @classmethod
    def _get_tdx_source(cls) -> TDXDataSource:
        if cls._tdx_source is None:
            cls._tdx_source = TDXDataSource()
        return cls._tdx_source

    @classmethod
    async def _request_tdx_http(cls, path: str, params: dict[str, Any]) -> Any:
        base_url = settings.TDX_API_BASE_URL.strip().rstrip("/")
        if not base_url:
            raise RuntimeError("未配置 TDX_API_BASE_URL，无法获取 TDX 行情数据")

        async with httpx.AsyncClient(timeout=settings.TDX_TIMEOUT) as client:
            response = await client.get(f"{base_url}{path}", params=params)
            response.raise_for_status()
            payload = response.json()

        if payload.get("code") != 0:
            raise RuntimeError(str(payload.get("message") or "TDX HTTP 请求失败"))
        return payload.get("data")

    @classmethod
    def _pick_dataframe_date_row(cls, df: Any, trade_date: date) -> dict[str, Any] | None:
        if getattr(df, "empty", False):
            logger.warning("情绪数据日期匹配失败: DataFrame 为空, trade_date=%s", trade_date.isoformat())
            return None

        target_dates = {
            trade_date.isoformat(),
            trade_date.strftime("%Y-%m-%d"),
            trade_date.strftime("%Y%m%d"),
        }
        records = df.to_dict(orient="records")
        date_keys = ("日期", "交易日期", "trade_date", "date")

        for record in reversed(records):
            for key in date_keys:
                value = record.get(key)
                if value is None:
                    continue
                if hasattr(value, "strftime"):
                    normalized = value.strftime("%Y-%m-%d")
                else:
                    normalized = str(value).strip()
                if normalized in target_dates:
                    logger.info(
                        "情绪数据日期匹配成功: trade_date=%s, date_key=%s, matched_value=%s",
                        trade_date.isoformat(),
                        key,
                        normalized,
                    )
                    return record
        sample_keys = list(records[-1].keys())[:10] if records else []
        logger.warning(
            "情绪数据日期匹配失败: trade_date=%s, target_dates=%s, total_rows=%s, sample_keys=%s",
            trade_date.isoformat(),
            sorted(target_dates),
            len(records),
            sample_keys,
        )
        return None

    @classmethod
    async def get_trade_calendar(cls) -> list[date]:
        now = datetime.utcnow()
        if (
            cls._trade_calendar_cache is not None
            and cls._trade_calendar_loaded_at is not None
            and (now - cls._trade_calendar_loaded_at) < timedelta(hours=6)
        ):
            return cls._trade_calendar_cache

        def _load_calendar() -> list[date]:
            try:
                import akshare as ak  # type: ignore
            except ModuleNotFoundError as exc:
                raise RuntimeError("akshare 未安装，无法加载交易日历") from exc

            calendar_df = ak.tool_trade_date_hist_sina()
            column = "trade_date" if "trade_date" in calendar_df.columns else calendar_df.columns[0]
            return [
                value.date() if hasattr(value, "date") else datetime.strptime(str(value), "%Y-%m-%d").date()
                for value in calendar_df[column].tolist()
            ]

        try:
            cls._trade_calendar_cache = await cls._run_sync(_load_calendar)
            cls._trade_calendar_loaded_at = now
        except Exception as exc:
            logger.warning("加载交易日历失败，回退到工作日判断: %s", exc)
            cls._trade_calendar_cache = []
            cls._trade_calendar_loaded_at = now

        return cls._trade_calendar_cache

    @classmethod
    async def is_trading_day(cls, trade_date: date) -> bool:
        calendar = await cls.get_trade_calendar()
        if calendar:
            return trade_date in calendar
        return trade_date.weekday() < 5

    @classmethod
    async def list_month_calendar(cls, db: Session, year: int, month: int) -> SentimentCalendarResponse:
        start = date(year, month, 1)
        if month == 12:
            end = date(year + 1, 1, 1) - timedelta(days=1)
        else:
            end = date(year, month + 1, 1) - timedelta(days=1)

        calendar = set(await cls.get_trade_calendar())
        metrics_rows = {
            row.trade_date: row
            for row in db.query(SentimentDailyMetrics)
            .filter(SentimentDailyMetrics.trade_date >= start, SentimentDailyMetrics.trade_date <= end)
            .all()
        }
        status_rows = {}
        for row in (
            db.query(SentimentSyncStatus)
            .filter(SentimentSyncStatus.trade_date >= start, SentimentSyncStatus.trade_date <= end)
            .all()
        ):
            status_rows.setdefault(row.trade_date, []).append(row.status)

        latest_failed_status = (
            db.query(SentimentSyncStatus)
            .filter(
                SentimentSyncStatus.trade_date >= start,
                SentimentSyncStatus.trade_date <= end,
                SentimentSyncStatus.status == "failed",
                SentimentSyncStatus.last_error.isnot(None),
            )
            .order_by(SentimentSyncStatus.updated_at.desc())
            .first()
        )

        days: list[SentimentCalendarDay] = []
        current = start
        while current <= end:
            is_trading_day = current in calendar if calendar else current.weekday() < 5
            metrics_ready = current in metrics_rows
            statuses = status_rows.get(current, [])
            if not is_trading_day:
                sync_status = "non_trading"
            elif metrics_ready and statuses and all(status == "success" for status in statuses):
                sync_status = "success"
            elif any(status == "failed" for status in statuses):
                sync_status = "failed"
            elif statuses and any(status == "success" for status in statuses):
                sync_status = "partial"
            else:
                sync_status = "missing"

            days.append(
                SentimentCalendarDay(
                    date=current.isoformat(),
                    is_trading_day=is_trading_day,
                    sync_status=sync_status,
                    metrics_ready=metrics_ready,
                )
            )
            current += timedelta(days=1)

        return SentimentCalendarResponse(
            year=year,
            month=month,
            days=days,
            sync_warning=latest_failed_status.last_error if latest_failed_status else None,
        )

    @staticmethod
    def _to_float(value: Any, default: float = 0.0) -> float:
        try:
            if value is None:
                return default
            text = str(value).strip().replace(",", "").replace("%", "")
            if not text or text in {"nan", "None", "--"}:
                return default
            multiplier = 1.0
            if text.endswith("亿"):
                multiplier = 100000000.0
                text = text[:-1]
            elif text.endswith("万"):
                multiplier = 10000.0
                text = text[:-1]
            return float(text)
        except (TypeError, ValueError):
            return default

    @classmethod
    def _sanitize_number(cls, value: Any, default: float = 0.0) -> float:
        parsed = cls._to_float(value, default)
        if not math.isfinite(parsed):
            return default
        return parsed

    @classmethod
    def _normalize_tdx_amount_to_yuan(cls, value: Any, default: float = 0.0) -> float:
        amount = cls._sanitize_number(value, default)
        if amount <= 0:
            return default
        # TDX K 线成交额字段单位是厘，入库前统一换算成元。
        return amount / 1000.0

    @classmethod
    def _parse_board_height(cls, row: dict[str, Any]) -> int:
        for key in ("连续涨停天数", "连板数", "连续跌停天数", "最高连板数"):
            if key in row:
                parsed = int(cls._to_float(row.get(key), 0))
                if parsed:
                    return parsed

        board_text = str(row.get("几天几板") or row.get("涨停统计") or "").strip()
        if board_text:
            match = re.search(r"(\d+)\s*天\s*(\d+)\s*板", board_text)
            if match:
                return int(match.group(2))
            number_match = re.search(r"(\d+)", board_text)
            if number_match:
                return int(number_match.group(1))

        return 0

    @staticmethod
    def _parse_symbol(row: dict[str, Any]) -> str:
        for key in ("代码", "股票代码", "证券代码", "code", "symbol"):
            if key in row and row.get(key):
                raw = str(row.get(key)).strip()
                if raw.isdigit() and len(raw) < 6:
                    return raw.zfill(6)
                return raw
        return ""

    @staticmethod
    def _parse_name(row: dict[str, Any]) -> str | None:
        for key in ("名称", "股票简称", "简称", "name"):
            if key in row and row.get(key):
                return str(row.get(key)).strip()
        return None

    @classmethod
    def _normalize_pool_rows(cls, pool_type: str, trade_date: date, df: Any) -> list[dict[str, Any]]:
        rows: list[dict[str, Any]] = []
        if df is None:
            return rows
        if isinstance(df, list):
            records = df
        elif getattr(df, "empty", False):
            return rows
        else:
            records = df.to_dict(orient="records")
        for record in records:
            symbol = cls._parse_symbol(record)
            if not symbol:
                continue
            rows.append(
                {
                    "trade_date": trade_date,
                    "pool_type": pool_type,
                    "symbol": symbol,
                    "name": cls._parse_name(record),
                    "board_height": cls._parse_board_height(record),
                    "board_label": str(record.get("板型") or record.get("涨停统计") or "").strip() or None,
                    "first_limit_time": str(record.get("首次涨停时间") or record.get("首次封板时间") or "").strip() or None,
                    "last_limit_time": str(record.get("最后涨停时间") or record.get("最后封板时间") or record.get("最近涨停时间") or "").strip() or None,
                    "limit_open_count": int(
                        cls._to_float(
                            record.get("涨停打开次数")
                            or record.get("涨停打开次数0#")
                            or record.get("炸板次数"),
                            0,
                        )
                    ),
                    "reason": str(
                        record.get("涨停原因")
                        or record.get("原因揭秘")
                        or record.get("涨停原因类别")
                        or record.get("所属行业")
                        or ""
                    ).strip() or None,
                    "payload_json": json.dumps(record, ensure_ascii=False, default=str),
                }
            )
        return rows

    @classmethod
    async def _fetch_pool_df(cls, pool_type: str, trade_date: date) -> Any:
        ak = cls._load_akshare()
        query_date = cls._format_pool_date(trade_date)
        mapping = {
            "zt": ak.stock_zt_pool_em,
            "dt": ak.stock_zt_pool_dtgc_em,
            "zbgc": ak.stock_zt_pool_zbgc_em,
            "zrzt": ak.stock_zt_pool_previous_em,
            "strong": ak.stock_zt_pool_strong_em,
        }
        result = await cls._run_sync(mapping[pool_type], date=query_date)
        row_count = len(result) if isinstance(result, list) else (0 if getattr(result, "empty", False) else len(result))
        logger.info(
            "情绪池取数完成: pool_type=%s, trade_date=%s, row_count=%s",
            pool_type,
            trade_date.isoformat(),
            row_count,
        )
        return result

    @classmethod
    async def fetch_pool_data(cls, trade_date: date) -> list[PoolFetchResult]:
        results: list[PoolFetchResult] = []
        for pool_type in POOL_TYPES:
            raw_rows = await cls._fetch_pool_df(pool_type, trade_date)
            rows = cls._normalize_pool_rows(pool_type, trade_date, raw_rows)
            results.append(PoolFetchResult(pool_type=pool_type, rows=rows))
        return results

    @staticmethod
    def _get_or_create_status(db: Session, trade_date: date, pool_type: str) -> SentimentSyncStatus:
        status = (
            db.query(SentimentSyncStatus)
            .filter(SentimentSyncStatus.trade_date == trade_date, SentimentSyncStatus.pool_type == pool_type)
            .first()
        )
        if status is None:
            status = SentimentSyncStatus(trade_date=trade_date, pool_type=pool_type, status="pending", retry_count=0)
            db.add(status)
        return status

    @staticmethod
    def _dedupe_pool_rows(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
        deduped: dict[str, dict[str, Any]] = {}
        for row in rows:
            symbol = row.get("symbol")
            if not symbol:
                continue
            deduped[str(symbol)] = row
        return list(deduped.values())

    @classmethod
    def persist_pool_data(cls, db: Session, trade_date: date, pool_type: str, rows: list[dict[str, Any]]) -> None:
        deduped_rows = cls._dedupe_pool_rows(rows)
        if deduped_rows:
            now = datetime.utcnow()
            payload_rows = []
            for row in deduped_rows:
                payload_rows.append(
                    {
                        **row,
                        "created_at": now,
                        "updated_at": now,
                    }
                )

            insert_stmt = sqlite_insert(SentimentPoolRaw).values(payload_rows)
            update_columns = {
                "name": insert_stmt.excluded.name,
                "board_height": insert_stmt.excluded.board_height,
                "board_label": insert_stmt.excluded.board_label,
                "first_limit_time": insert_stmt.excluded.first_limit_time,
                "last_limit_time": insert_stmt.excluded.last_limit_time,
                "limit_open_count": insert_stmt.excluded.limit_open_count,
                "reason": insert_stmt.excluded.reason,
                "payload_json": insert_stmt.excluded.payload_json,
                "updated_at": now,
            }
            db.execute(
                insert_stmt.on_conflict_do_update(
                    index_elements=["trade_date", "pool_type", "symbol"],
                    set_=update_columns,
                )
            )

        status = cls._get_or_create_status(db, trade_date, pool_type)
        status.status = "success"
        status.last_error = None
        status.updated_at = datetime.utcnow()

    @classmethod
    def mark_pool_failed(cls, db: Session, trade_date: date, pool_type: str, error: str) -> None:
        status = cls._get_or_create_status(db, trade_date, pool_type)
        status.status = "failed"
        status.retry_count = (status.retry_count or 0) + 1
        status.last_error = error
        status.updated_at = datetime.utcnow()

    @classmethod
    async def _fetch_index_kline_point(cls, symbol: str, trade_date: date) -> dict[str, Any] | None:
        rows = await cls._get_tdx_source().get_index_kline_rows(symbol, kline_type="day", limit=240)
        target_dates = {
            trade_date.isoformat(),
            trade_date.strftime("%Y-%m-%d"),
        }
        normalized_dates: list[str] = []
        for row in rows:
            raw_time = row.get("Time")
            if raw_time is None:
                continue
            normalized_dates.append(str(raw_time).split("T", 1)[0])

        for row in reversed(rows):
            raw_time = row.get("Time")
            if raw_time is None:
                continue
            normalized = str(raw_time).split("T", 1)[0]
            if normalized in target_dates:
                logger.info(
                    "TDX 指数日线匹配成功: code=%s, trade_date=%s, matched_time=%s, amount=%s, up_count=%s, down_count=%s",
                    symbol,
                    trade_date.isoformat(),
                    normalized,
                    row.get("Amount"),
                    row.get("UpCount"),
                    row.get("DownCount"),
                )
                return row

        date_span = None
        if normalized_dates:
            date_span = f"{normalized_dates[0]} ~ {normalized_dates[-1]}"
        logger.warning(
            "TDX 指数日线匹配失败: code=%s, trade_date=%s, total_rows=%s, date_span=%s",
            symbol,
            trade_date.isoformat(),
            len(rows),
            date_span,
        )
        raise RuntimeError(
            f"TDX 指数日线缺少 {trade_date.isoformat()} 的数据"
            + (f"，当前返回范围为 {date_span}" if date_span else "")
        )

    @classmethod
    async def fetch_market_daily_data(cls, trade_date: date) -> dict[str, float]:
        turnover_amount = 0.0
        main_force_amount = 0.0
        northbound_amount = 0.0
        rising_stock_count = 0

        try:
            sh_row, sz_row = await asyncio.gather(
                cls._fetch_index_kline_point("sh000001", trade_date),
                cls._fetch_index_kline_point("sz399001", trade_date),
            )
            sh_amount = cls._normalize_tdx_amount_to_yuan(sh_row.get("Amount"))
            sz_amount = cls._normalize_tdx_amount_to_yuan(sz_row.get("Amount"))
            sh_up_count = int(cls._sanitize_number(sh_row.get("UpCount")))
            sz_up_count = int(cls._sanitize_number(sz_row.get("UpCount")))
            sh_down_count = int(cls._sanitize_number(sh_row.get("DownCount")))
            sz_down_count = int(cls._sanitize_number(sz_row.get("DownCount")))
            turnover_amount = sh_amount + sz_amount
            rising_stock_count = sh_up_count + sz_up_count
            logger.info(
                "情绪市场数据: trade_date=%s, source=tdx_index_market, sh_amount_raw=%s, sz_amount_raw=%s, turnover_amount=%s, sh_up_count=%s, sz_up_count=%s, rising_stock_count=%s, sh_down_count=%s, sz_down_count=%s",
                trade_date.isoformat(),
                sh_row.get("Amount"),
                sz_row.get("Amount"),
                turnover_amount,
                sh_up_count,
                sz_up_count,
                rising_stock_count,
                sh_down_count,
                sz_down_count,
            )
        except Exception as exc:
            raise RuntimeError(f"通过 TDX HTTP 获取市场日线数据失败: {exc}") from exc

        try:
            ak = cls._load_akshare()
            flow_df = await cls._run_sync(ak.stock_market_fund_flow)
            flow_row = cls._pick_dataframe_date_row(flow_df, trade_date)
            if flow_row:
                main_force_amount = cls._sanitize_number(
                    flow_row.get("主力净流入-净额")
                    or flow_row.get("主力净流入")
                    or flow_row.get("主力净额")
                )
                logger.info(
                    "情绪市场数据: trade_date=%s, source=ak_main_force, matched_row=%s, main_force_amount=%s",
                    trade_date.isoformat(),
                    json.dumps(flow_row, ensure_ascii=False, default=str),
                    main_force_amount,
                )
        except Exception as exc:
            logger.warning("通过 AKShare 获取市场主力资金失败: %s", exc)

        try:
            ak = cls._load_akshare()
            north_df = await cls._run_sync(ak.stock_hsgt_hist_em, symbol="北向资金")
            north_row = cls._pick_dataframe_date_row(north_df, trade_date)
            if north_row:
                northbound_amount = cls._sanitize_number(
                    north_row.get("当日成交净买额")
                    or north_row.get("历史累计净买额")
                    or north_row.get("净买额")
                )
                logger.info(
                    "情绪市场数据: trade_date=%s, source=ak_northbound, matched_row=%s, northbound_amount=%s",
                    trade_date.isoformat(),
                    json.dumps(north_row, ensure_ascii=False, default=str),
                    northbound_amount,
                )
        except Exception as exc:
            logger.warning("通过 AKShare 获取北向资金失败: %s", exc)

        return {
            "rising_stock_count": float(rising_stock_count),
            "turnover_amount": cls._sanitize_number(turnover_amount),
            "main_force_amount": cls._sanitize_number(main_force_amount),
            "northbound_amount": cls._sanitize_number(northbound_amount),
        }

    @classmethod
    async def _fetch_returns_for_symbols(cls, symbols: Iterable[str], next_trade_date: date) -> list[float]:
        results: list[float] = []
        target_dates = {
            next_trade_date.isoformat(),
            next_trade_date.strftime("%Y-%m-%d"),
        }

        for symbol in symbols:
            try:
                payload = await cls._request_tdx_http(
                    "/api/kline-all/tdx",
                    {"code": symbol, "type": "day", "limit": 80},
                )
                rows = payload.get("list") or payload.get("List") or []
                if not isinstance(rows, list) or not rows:
                    continue
                position = next(
                    (
                        idx
                        for idx, row in enumerate(rows)
                        if str(row.get("Time", "")).split("T", 1)[0] in target_dates
                    ),
                    -1,
                )
                if position == 0:
                    continue
                if position < 0:
                    continue
                prev_row = rows[position - 1]
                cur_row = rows[position]
                prev_close = cls._sanitize_number(prev_row.get("Close"))
                cur_close = cls._sanitize_number(cur_row.get("Close"))
                if prev_close > 1000:
                    prev_close /= 1000.0
                if cur_close > 1000:
                    cur_close /= 1000.0
                if prev_close > 0:
                    day_return = (cur_close / prev_close - 1) * 100
                    results.append(day_return)
                    logger.info(
                        "昨日涨停收益计算: symbol=%s, trade_date=%s, prev_close=%s, cur_close=%s, day_return=%s",
                        symbol,
                        next_trade_date.isoformat(),
                        prev_close,
                        cur_close,
                        round(day_return, 4),
                    )
                else:
                    logger.warning(
                        "昨日涨停收益跳过: symbol=%s, trade_date=%s, prev_close=%s, cur_close=%s",
                        symbol,
                        next_trade_date.isoformat(),
                        prev_close,
                        cur_close,
                    )
            except Exception as exc:
                logger.warning(
                    "昨日涨停收益获取失败: symbol=%s, trade_date=%s, error=%s",
                    symbol,
                    next_trade_date.isoformat(),
                    exc,
                )
                continue
            await asyncio.sleep(0.05)

        return results

    @classmethod
    async def compute_daily_metrics(cls, db: Session, trade_date: date) -> SentimentDailyMetrics:
        raw_rows = (
            db.query(SentimentPoolRaw)
            .filter(SentimentPoolRaw.trade_date == trade_date)
            .all()
        )
        grouped: dict[str, list[SentimentPoolRaw]] = {pool_type: [] for pool_type in POOL_TYPES}
        for row in raw_rows:
            grouped.setdefault(row.pool_type, []).append(row)

        up_limit_count = len(grouped["zt"])
        down_limit_count = len(grouped["dt"])
        break_limit_count = len(grouped["zbgc"])
        first_board_count = sum(1 for row in grouped["zt"] if (row.board_height or 0) == 1)
        second_board_count = sum(1 for row in grouped["zt"] if (row.board_height or 0) == 2)
        third_plus_board_count = sum(1 for row in grouped["zt"] if (row.board_height or 0) >= 3)
        max_board_height = max((row.board_height or 0 for row in grouped["zt"]), default=0)

        prev_trade_date = await cls.get_previous_trading_day(trade_date)
        prev_first_board_count = 0
        if prev_trade_date is not None:
            prev_metrics = (
                db.query(SentimentDailyMetrics)
                .filter(SentimentDailyMetrics.trade_date == prev_trade_date)
                .first()
            )
            if prev_metrics is not None:
                prev_first_board_count = prev_metrics.first_board_count
            else:
                prev_first_board_count = sum(
                    1
                    for row in db.query(SentimentPoolRaw)
                    .filter(
                        SentimentPoolRaw.trade_date == prev_trade_date,
                        SentimentPoolRaw.pool_type == "zt",
                    )
                    .all()
                    if (row.board_height or 0) == 1
                )

        advance_rate = (second_board_count + third_plus_board_count) / prev_first_board_count * 100 if prev_first_board_count else 0.0
        breakout_rate = break_limit_count / (up_limit_count + break_limit_count) * 100 if (up_limit_count + break_limit_count) else 0.0

        market_data = await cls.fetch_market_daily_data(trade_date)

        returns: list[float] = []
        symbols = [row.symbol for row in grouped["zrzt"]]
        if symbols:
            returns = await cls._fetch_returns_for_symbols(symbols, trade_date)

        avg_return = sum(returns) / len(returns) if returns else 0.0
        median_return = median(returns) if returns else 0.0
        max_return = max(returns) if returns else 0.0

        logger.info(
            "情绪指标计算完成: trade_date=%s, up_limit_count=%s, down_limit_count=%s, break_limit_count=%s, first_board_count=%s, second_board_count=%s, third_plus_board_count=%s, max_board_height=%s, advance_rate=%s, breakout_rate=%s, avg_return=%s, median_return=%s, max_return=%s, rising_stock_count=%s, turnover_amount=%s, northbound_amount=%s, main_force_amount=%s",
            trade_date.isoformat(),
            up_limit_count,
            down_limit_count,
            break_limit_count,
            first_board_count,
            second_board_count,
            third_plus_board_count,
            max_board_height,
            round(advance_rate, 4),
            round(breakout_rate, 4),
            round(avg_return, 4),
            round(median_return, 4),
            round(max_return, 4),
            int(cls._sanitize_number(market_data["rising_stock_count"])),
            cls._sanitize_number(market_data["turnover_amount"]),
            cls._sanitize_number(market_data["northbound_amount"]),
            cls._sanitize_number(market_data["main_force_amount"]),
        )

        metrics = (
            db.query(SentimentDailyMetrics)
            .filter(SentimentDailyMetrics.trade_date == trade_date)
            .first()
        )
        if metrics is None:
            metrics = SentimentDailyMetrics(trade_date=trade_date)
            db.add(metrics)

        metrics.up_limit_count = up_limit_count
        metrics.down_limit_count = down_limit_count
        metrics.break_limit_count = break_limit_count
        metrics.first_board_count = first_board_count
        metrics.second_board_count = second_board_count
        metrics.third_plus_board_count = third_plus_board_count
        metrics.max_board_height = max_board_height
        metrics.advance_rate = round(advance_rate, 4)
        metrics.breakout_rate = round(breakout_rate, 4)
        metrics.avg_return = round(avg_return, 4)
        metrics.median_return = round(median_return, 4)
        metrics.max_return = round(max_return, 4)
        metrics.rising_stock_count = int(cls._sanitize_number(market_data["rising_stock_count"]))
        metrics.turnover_amount = cls._sanitize_number(market_data["turnover_amount"])
        metrics.northbound_amount = cls._sanitize_number(market_data["northbound_amount"])
        metrics.main_force_amount = cls._sanitize_number(market_data["main_force_amount"])
        metrics.computed_at = datetime.utcnow()

        return metrics

    @classmethod
    async def sync_sentiment_for_date(cls, db: Session, trade_date: date, force: bool = False) -> SentimentSyncDateResponse:
        acquired_lock = await cls._try_acquire_sync_lock(trade_date)
        if acquired_lock is None:
            return SentimentSyncDateResponse(
                trade_date=trade_date.isoformat(),
                success=False,
                synced_pools=[],
                metrics_ready=False,
                message="该交易日正在同步中，请稍后重试",
            )

        if not await cls.is_trading_day(trade_date):
            await cls._release_sync_lock(trade_date, acquired_lock)
            return SentimentSyncDateResponse(
                trade_date=trade_date.isoformat(),
                success=False,
                synced_pools=[],
                metrics_ready=False,
                message="所选日期不是交易日",
            )

        try:
            existing_metrics = (
                db.query(SentimentDailyMetrics)
                .filter(SentimentDailyMetrics.trade_date == trade_date)
                .first()
            )
            if existing_metrics is not None and not force:
                statuses = (
                    db.query(SentimentSyncStatus)
                    .filter(SentimentSyncStatus.trade_date == trade_date)
                    .all()
                )
                if statuses and all(status.status == "success" for status in statuses):
                    return SentimentSyncDateResponse(
                        trade_date=trade_date.isoformat(),
                        success=True,
                        synced_pools=[status.pool_type for status in statuses],
                        metrics_ready=True,
                        message="该交易日数据已存在",
                    )

            synced_pools: list[str] = []
            for pool_type in POOL_TYPES:
                status = cls._get_or_create_status(db, trade_date, pool_type)
                status.status = "pending"
                status.last_error = None
                status.updated_at = datetime.utcnow()
            db.commit()

            try:
                fetch_results = await cls.fetch_pool_data(trade_date)
                for result in fetch_results:
                    cls.persist_pool_data(db, trade_date, result.pool_type, result.rows)
                    synced_pools.append(result.pool_type)
                    logger.info(
                        "情绪池写入完成: trade_date=%s, pool_type=%s, row_count=%s",
                        trade_date.isoformat(),
                        result.pool_type,
                        len(result.rows),
                    )
                    db.commit()
                await cls.compute_daily_metrics(db, trade_date)
                db.commit()
                return SentimentSyncDateResponse(
                    trade_date=trade_date.isoformat(),
                    success=True,
                    synced_pools=synced_pools,
                    metrics_ready=True,
                    message="同步完成",
                )
            except Exception as exc:
                logger.exception("同步情绪数据失败: %s", exc)
                db.rollback()
                for pool_type in POOL_TYPES:
                    cls.mark_pool_failed(db, trade_date, pool_type, str(exc))
                db.commit()
                return SentimentSyncDateResponse(
                    trade_date=trade_date.isoformat(),
                    success=False,
                    synced_pools=synced_pools,
                    metrics_ready=False,
                    message=f"同步失败: {exc}",
                )
        finally:
            await cls._release_sync_lock(trade_date, acquired_lock)

    @classmethod
    async def sync_today(cls, db: Session | None = None, trade_date: date | None = None, force: bool = False):
        from app.db.session import SessionLocal

        owned_db = db is None
        session = db or SessionLocal()
        target_date = trade_date or datetime.now().date()
        try:
            return await cls.sync_sentiment_for_date(session, target_date, force=force)
        finally:
            if owned_db:
                session.close()

    @classmethod
    async def retry_today_if_needed(cls):
        from app.db.session import SessionLocal

        db = SessionLocal()
        target_date = datetime.now().date()
        try:
            if not await cls.is_trading_day(target_date):
                return None
            statuses = (
                db.query(SentimentSyncStatus)
                .filter(SentimentSyncStatus.trade_date == target_date)
                .all()
            )
            metrics = (
                db.query(SentimentDailyMetrics)
                .filter(SentimentDailyMetrics.trade_date == target_date)
                .first()
            )
            should_retry = metrics is None or any(status.status != "success" for status in statuses)
            if not should_retry:
                return None
            return await cls.sync_sentiment_for_date(db, target_date, force=True)
        finally:
            db.close()

    @classmethod
    async def get_previous_trading_day(cls, trade_date: date) -> date | None:
        calendar = await cls.get_trade_calendar()
        if calendar:
            candidates = [day for day in calendar if day < trade_date]
            return candidates[-1] if candidates else None
        current = trade_date - timedelta(days=1)
        while current.weekday() >= 5:
            current -= timedelta(days=1)
        return current

    @classmethod
    async def get_next_trading_day(cls, trade_date: date) -> date | None:
        calendar = await cls.get_trade_calendar()
        if calendar:
            candidates = [day for day in calendar if day > trade_date]
            return candidates[0] if candidates else None
        current = trade_date + timedelta(days=1)
        while current.weekday() >= 5:
            current += timedelta(days=1)
        return current

    @classmethod
    async def list_recent_trading_days(cls, end_date: date, days: int) -> list[date]:
        calendar = await cls.get_trade_calendar()
        if calendar:
            trading_days = [day for day in calendar if day <= end_date]
            return trading_days[-days:]

        results: list[date] = []
        current = end_date
        while len(results) < days:
            if current.weekday() < 5:
                results.append(current)
            current -= timedelta(days=1)
        results.reverse()
        return results

    @classmethod
    async def backfill_recent_trading_days(
        cls,
        db: Session,
        days: int,
        end_date: date | None = None,
        force: bool = False,
    ) -> SentimentBackfillResponse:
        target_end_date = end_date or datetime.now().date()
        trade_dates = await cls.list_recent_trading_days(target_end_date, days)
        results: list[SentimentSyncDateResponse] = []

        for trade_date in trade_dates:
            results.append(await cls.sync_sentiment_for_date(db, trade_date, force=force))

        success_count = sum(1 for result in results if result.success and result.message != "该交易日数据已存在")
        failed_count = sum(1 for result in results if not result.success)
        skipped_count = sum(1 for result in results if result.success and result.message == "该交易日数据已存在")

        return SentimentBackfillResponse(
            requested_days=days,
            end_date=target_end_date.isoformat(),
            success_count=success_count,
            failed_count=failed_count,
            skipped_count=skipped_count,
            trade_dates=[trade_date.isoformat() for trade_date in trade_dates],
            results=results,
            message=f"批量回补完成，共处理 {len(trade_dates)} 个交易日",
        )

    @classmethod
    async def get_metrics(cls, db: Session, start_date: date, end_date: date) -> SentimentMetricsResponse:
        rows = (
            db.query(SentimentDailyMetrics)
            .filter(SentimentDailyMetrics.trade_date >= start_date, SentimentDailyMetrics.trade_date <= end_date)
            .order_by(SentimentDailyMetrics.trade_date.asc())
            .all()
        )
        points: list[SentimentMetricPoint] = []
        for row in rows:
            up_limit_to_rising_ratio = (
                row.up_limit_count / row.rising_stock_count * 100
                if row.rising_stock_count
                else 0.0
            )
            points.append(
                SentimentMetricPoint(
                    date=row.trade_date.isoformat(),
                    advanceRate=round(row.advance_rate, 2),
                    breakoutRate=round(row.breakout_rate, 2),
                    upLimitToRisingRatio=round(up_limit_to_rising_ratio, 2),
                    avgReturn=round(row.avg_return, 2),
                    maxReturn=round(row.max_return, 2),
                    medianReturn=round(row.median_return, 2),
                    firstBoardCount=row.first_board_count,
                    secondBoardCount=row.second_board_count,
                    breakoutCount=row.break_limit_count,
                    risingStockCount=row.rising_stock_count,
                    turnoverAmount=round(row.turnover_amount / 100000000, 2),
                    northboundAmount=round(row.northbound_amount / 100000000, 2),
                    mainForceAmount=round(row.main_force_amount / 100000000, 2),
                )
            )

        summary = {
            "totalTradingDays": len(points),
            "latestTradeDate": points[-1].date if points else None,
            "averageAdvanceRate": round(sum(point.advanceRate for point in points) / len(points), 2) if points else 0.0,
            "averageBreakoutRate": round(sum(point.breakoutRate for point in points) / len(points), 2) if points else 0.0,
        }

        return SentimentMetricsResponse(
            startDate=start_date.isoformat(),
            endDate=end_date.isoformat(),
            points=points,
            summary=summary,
        )
