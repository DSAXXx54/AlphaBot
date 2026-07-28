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
    def _mcp_client():
        try:
            from fastmcp import Client  # type: ignore
        except ModuleNotFoundError as exc:
            raise RuntimeError("fastmcp 未安装，无法执行 MCP 情绪数据同步") from exc
        if not settings.TXMCP_API_KEY:
            raise RuntimeError("未配置 TXMCP_API_KEY，无法执行 MCP 情绪数据同步")
        config = {
            "mcpServers": {
                "txmcp": {
                    "url": settings.TXMCP_HTTP_URL,
                    "transport": "streamable-http",
                    "headers": {
                        "Authorization": f"Bearer {settings.TXMCP_API_KEY}",
                    },
                }
            }
        }
        return Client(
            config,
            timeout=settings.TXMCP_TIMEOUT,
            init_timeout=settings.TXMCP_TIMEOUT,
        )

    @staticmethod
    def _extract_mcp_text(payload: Any) -> str:
        content = getattr(payload, "content", None) or []
        texts: list[str] = []
        for item in content:
            text = getattr(item, "text", None)
            if text:
                texts.append(text)
        return "\n".join(texts)

    @classmethod
    def _extract_mcp_payload(cls, payload: Any) -> Any:
        structured = getattr(payload, "structured_content", None)
        if structured is None:
            structured = getattr(payload, "data", None)
        if isinstance(structured, dict) and structured.get("ok") is False:
            error = structured.get("error") or {}
            raise RuntimeError(str(error.get("message") or "MCP 工具返回失败"))
        return structured if structured is not None else {"text": cls._extract_mcp_text(payload)}

    @classmethod
    async def _call_mcp_tool(cls, tool_name: str, params: dict[str, Any]) -> Any:
        client = cls._mcp_client()
        async with client:
            result = await client.call_tool(tool_name, params)
        return cls._extract_mcp_payload(result)

    @staticmethod
    def _screen_message(trade_date: date, keyword: str) -> str:
        return f"{trade_date.isoformat()} {keyword}"

    @classmethod
    async def _query_screener_page(
        cls,
        message: str,
        page_no: int = 1,
        page_size: int = 6000,
    ) -> dict[str, Any]:
        payload = await cls._call_mcp_tool(
            "tdx_screener",
            {
                "message": message,
                "rang": "AG",
                "pageNo": str(page_no),
                "pageSize": str(page_size),
            },
        )
        if not isinstance(payload, dict):
            raise RuntimeError("tdx_screener 返回格式异常")
        return payload

    @classmethod
    async def _query_screener_all(cls, message: str, page_size: int = 6000) -> list[dict[str, Any]]:
        rows: list[dict[str, Any]] = []
        page_no = 1
        total = None
        while total is None or len(rows) < total:
            payload = await cls._query_screener_page(message, page_no=page_no, page_size=page_size)
            meta = payload.get("meta") or {}
            data = payload.get("data") or []
            if not isinstance(data, list):
                break
            rows.extend([row for row in data if isinstance(row, dict)])
            total = int(meta.get("total") or len(rows))
            current_count = int(meta.get("currentPageCount") or len(data))
            if current_count <= 0 or len(data) == 0 or len(rows) >= total:
                break
            page_no += 1
        return rows

    @staticmethod
    def _market_to_setcode(market: Any, symbol: str) -> str:
        market_text = str(market or "").strip()
        if market_text in {"0", "1", "2"}:
            return market_text
        if symbol.startswith(("6", "5", "9")):
            return "1"
        if symbol.startswith(("4", "8")):
            return "2"
        return "0"

    @staticmethod
    def _first_matching_number(row: dict[str, Any], prefixes: tuple[str, ...]) -> float:
        for key, value in row.items():
            if any(str(key).startswith(prefix) for prefix in prefixes):
                try:
                    return float(str(value).replace(",", ""))
                except (TypeError, ValueError):
                    continue
        return 0.0

    @staticmethod
    def _extract_meta_total(payload: Any) -> int:
        if not isinstance(payload, dict):
            return 0
        meta = payload.get("meta") or {}
        try:
            return int(meta.get("total") or 0)
        except (TypeError, ValueError):
            return 0

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
            text = str(value).strip().replace(",", "").replace("%", "").replace("万", "")
            if not text or text in {"nan", "None", "--"}:
                return default
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
    def _parse_board_height(cls, row: dict[str, Any]) -> int:
        for key in ("连续涨停天数", "连板数", "连续跌停天数"):
            if key in row:
                parsed = int(cls._to_float(row.get(key), 0))
                if parsed:
                    return parsed

        board_text = str(row.get("几天几板") or "").strip()
        if board_text:
            match = re.search(r"(\d+)\s*天\s*(\d+)\s*板", board_text)
            if match:
                return int(match.group(2))

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
                    "board_label": str(record.get("板型") or "").strip() or None,
                    "first_limit_time": str(record.get("首次涨停时间") or "").strip() or None,
                    "last_limit_time": str(record.get("最后涨停时间") or record.get("最近涨停时间") or "").strip() or None,
                    "limit_open_count": int(cls._to_float(record.get("涨停打开次数") or record.get("涨停打开次数0#"), 0)),
                    "reason": str(record.get("涨停原因") or record.get("原因揭秘") or "").strip() or None,
                    "payload_json": json.dumps(record, ensure_ascii=False, default=str),
                }
            )
        return rows

    @classmethod
    async def _fetch_pool_df(cls, pool_type: str, trade_date: date) -> Any:
        mapping = {
            "zt": "涨停",
            "dt": "跌停",
            "zbgc": "炸板",
            "zrzt": "昨日涨停",
            "strong": "强势股",
        }
        query = cls._screen_message(trade_date, mapping[pool_type])
        rows = await cls._query_screener_all(query)
        return rows

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
    async def _fetch_index_turnover_for_date(cls, symbol: str, trade_date: date) -> float:
        setcode = "1" if symbol == "000001" else cls._market_to_setcode(None, symbol)
        try:
            payload = await cls._call_mcp_tool(
                "tdx_quotes",
                {
                    "code": symbol,
                    "setcode": setcode,
                    "hasCalcInfo": "1",
                    "hasCwInfo": "1",
                },
            )
            if not isinstance(payload, dict):
                return 0.0
            hq_info = payload.get("HQInfo") or {}
            return cls._sanitize_number(hq_info.get("Amount"), 0.0)
        except Exception:
            return 0.0

    @classmethod
    async def fetch_market_daily_data(cls, trade_date: date) -> dict[str, float]:
        turnover_amount = 0.0
        main_force_amount = 0.0
        northbound_amount = 0.0
        rising_stock_count = 0

        try:
            turnover_rows = await cls._query_screener_all(cls._screen_message(trade_date, "市场总成交额"))
            turnover_amount = sum(
                cls._first_matching_number(row, ("成交额(元)",))
                for row in turnover_rows
            )
        except Exception as exc:
            logger.warning("通过 MCP 获取市场总成交额失败，回退指数成交额求和: %s", exc)
            sh_amount, sz_amount = await asyncio.gather(
                cls._fetch_index_turnover_for_date("000001", trade_date),
                cls._fetch_index_turnover_for_date("399001", trade_date),
            )
            turnover_amount = cls._sanitize_number(sh_amount + sz_amount)

        try:
            flow_rows = await cls._query_screener_all(cls._screen_message(trade_date, "主力资金"))
            main_force_amount = sum(
                cls._first_matching_number(row, ("主力净额",))
                for row in flow_rows
            )
        except Exception as exc:
            logger.warning("通过 MCP 获取市场主力资金失败: %s", exc)

        try:
            north_rows = await cls._query_screener_all(cls._screen_message(trade_date, "北向资金"))
            northbound_amount = sum(
                cls._first_matching_number(row, ("陆股通成交额(元)",))
                for row in north_rows
            )
        except Exception as exc:
            logger.warning("通过 MCP 获取北向资金失败: %s", exc)

        try:
            rising_payload = await cls._query_screener_page(
                cls._screen_message(trade_date, "上涨家数"),
                page_no=1,
                page_size=1,
            )
            rising_stock_count = cls._extract_meta_total(rising_payload)
        except Exception as exc:
            logger.warning("通过 MCP 获取市场上涨家数失败: %s", exc)

        return {
            "rising_stock_count": float(rising_stock_count),
            "turnover_amount": cls._sanitize_number(turnover_amount),
            "main_force_amount": cls._sanitize_number(main_force_amount),
            "northbound_amount": cls._sanitize_number(northbound_amount),
        }

    @classmethod
    async def _fetch_returns_for_symbols(cls, symbols: Iterable[str], next_trade_date: date) -> list[float]:
        results: list[float] = []
        next_date_str = next_trade_date.strftime("%Y%m%d")

        for symbol in symbols:
            try:
                payload = await cls._call_mcp_tool(
                    "tdx_kline",
                    {
                        "code": symbol,
                        "setcode": cls._market_to_setcode(None, symbol),
                        "period": "4",
                        "wantNum": "80",
                        "tqFlag": "1",
                    },
                )
                if not isinstance(payload, dict):
                    continue
                rows = payload.get("Rows") or payload.get("rows") or []
                if not isinstance(rows, list) or not rows:
                    continue
                position = next((idx for idx, row in enumerate(rows) if str(row.get("Data")) == next_date_str), -1)
                if position == 0:
                    continue
                if position < 0:
                    continue
                prev_row = rows[position - 1]
                cur_row = rows[position]
                prev_close = cls._sanitize_number(prev_row.get("Close"))
                cur_close = cls._sanitize_number(cur_row.get("Close"))
                if prev_close > 0:
                    results.append((cur_close / prev_close - 1) * 100)
            except Exception:
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
