from __future__ import annotations

import asyncio
import json
import logging
import re
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from statistics import median
from typing import Any, Iterable

from sqlalchemy.orm import Session

from app.models.sentiment import SentimentDailyMetrics, SentimentPoolRaw, SentimentSyncStatus
from app.schemas.sentiment import (
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

    @staticmethod
    async def _run_sync(func, *args, **kwargs):
        return await asyncio.to_thread(func, *args, **kwargs)

    @staticmethod
    def _ak():
        try:
            import akshare as ak  # type: ignore
        except ModuleNotFoundError as exc:
            raise RuntimeError("akshare 未安装，无法执行情绪数据同步") from exc
        return ak

    @staticmethod
    def _pd():
        try:
            import pandas as pd  # type: ignore
        except ModuleNotFoundError as exc:
            raise RuntimeError("pandas 未安装，无法执行情绪数据同步") from exc
        return pd

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
            ak = cls._ak()
            calendar_df = ak.tool_trade_date_hist_sina()
            column = "trade_date" if "trade_date" in calendar_df.columns else calendar_df.columns[0]
            pd = cls._pd()
            return [pd.to_datetime(value).date() for value in calendar_df[column].tolist()]

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

        return SentimentCalendarResponse(year=year, month=month, days=days)

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
        if df is None or df.empty:
            return rows

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
        trade_date_str = trade_date.strftime("%Y%m%d")
        mapping = {
            "zt": cls._ak().stock_zt_pool_em,
            "dt": cls._ak().stock_zt_pool_dtgc_em,
            "zbgc": cls._ak().stock_zt_pool_zbgc_em,
            "zrzt": cls._ak().stock_zt_pool_previous_em,
            "strong": cls._ak().stock_zt_pool_strong_em,
        }
        fetcher = mapping[pool_type]
        return await cls._run_sync(fetcher, date=trade_date_str)

    @classmethod
    async def fetch_pool_data(cls, trade_date: date) -> list[PoolFetchResult]:
        results: list[PoolFetchResult] = []
        for pool_type in POOL_TYPES:
            df = await cls._fetch_pool_df(pool_type, trade_date)
            rows = cls._normalize_pool_rows(pool_type, trade_date, df)
            results.append(PoolFetchResult(pool_type=pool_type, rows=rows))
            await asyncio.sleep(1)
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

    @classmethod
    def persist_pool_data(cls, db: Session, trade_date: date, pool_type: str, rows: list[dict[str, Any]]) -> None:
        for row in rows:
            existing = (
                db.query(SentimentPoolRaw)
                .filter(
                    SentimentPoolRaw.trade_date == trade_date,
                    SentimentPoolRaw.pool_type == pool_type,
                    SentimentPoolRaw.symbol == row["symbol"],
                )
                .first()
            )
            if existing:
                existing.name = row["name"]
                existing.board_height = row["board_height"]
                existing.board_label = row["board_label"]
                existing.first_limit_time = row["first_limit_time"]
                existing.last_limit_time = row["last_limit_time"]
                existing.limit_open_count = row["limit_open_count"]
                existing.reason = row["reason"]
                existing.payload_json = row["payload_json"]
                existing.updated_at = datetime.utcnow()
            else:
                db.add(SentimentPoolRaw(**row))

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
        try:
            daily_df = await cls._run_sync(cls._ak().stock_zh_index_daily_em, symbol=symbol)
            if daily_df is None or daily_df.empty:
                return 0.0
            pd = cls._pd()
            working_df = daily_df.copy()
            date_col = "date" if "date" in working_df.columns else ("日期" if "日期" in working_df.columns else None)
            amount_col = "amount" if "amount" in working_df.columns else ("成交额" if "成交额" in working_df.columns else None)
            if date_col is None or amount_col is None:
                return 0.0
            working_df[date_col] = pd.to_datetime(working_df[date_col]).dt.date
            target = working_df[working_df[date_col] == trade_date]
            if target.empty:
                return 0.0
            return cls._to_float(target.iloc[-1].get(amount_col), 0.0)
        except Exception:
            return 0.0

    @classmethod
    async def fetch_market_daily_data(cls, trade_date: date) -> dict[str, float]:
        turnover_amount = 0.0
        main_force_amount = 0.0
        northbound_amount = 0.0

        try:
            today = datetime.now().date()
            if trade_date == today:
                ak = cls._ak()
                spot_func = getattr(ak, "stock_zh_a_spot_em", None) or getattr(ak, "stock_zh_a_spot", None)
                if spot_func is not None:
                    spot_df = await cls._run_sync(spot_func)
                    amount_column = "成交额" if "成交额" in spot_df.columns else None
                    if amount_column:
                        pd = cls._pd()
                        turnover_amount = float(pd.to_numeric(spot_df[amount_column], errors="coerce").fillna(0).sum())
            if turnover_amount <= 0:
                sh_amount, sz_amount, bj_amount = await asyncio.gather(
                    cls._fetch_index_turnover_for_date("sh000001", trade_date),
                    cls._fetch_index_turnover_for_date("sz399001", trade_date),
                    cls._fetch_index_turnover_for_date("bj899050", trade_date),
                )
                turnover_amount = sh_amount + sz_amount + bj_amount
        except Exception as exc:
            logger.warning("获取市场总成交额失败: %s", exc)

        try:
            flow_df = await cls._run_sync(cls._ak().stock_market_fund_flow)
            if not flow_df.empty:
                pd = cls._pd()
                working_df = flow_df.copy()
                if "日期" in working_df.columns:
                    working_df["日期"] = pd.to_datetime(working_df["日期"]).dt.date
                    target = working_df[working_df["日期"] == trade_date]
                    if not target.empty:
                        main_force_amount = float(target.iloc[-1].get("主力净流入-净额", 0) or 0)
        except Exception as exc:
            logger.warning("获取市场主力资金失败: %s", exc)

        try:
            north_df = await cls._run_sync(cls._ak().stock_hsgt_hist_em, symbol="北向资金")
            if not north_df.empty:
                pd = cls._pd()
                working_df = north_df.copy()
                if "日期" in working_df.columns:
                    working_df["日期"] = pd.to_datetime(working_df["日期"]).dt.date
                    target = working_df[working_df["日期"] == trade_date]
                    if not target.empty:
                        northbound_amount = float(target.iloc[-1].get("当日成交净买额", 0) or 0) * 100000000
        except Exception as exc:
            logger.warning("获取北向资金失败: %s", exc)

        return {
            "turnover_amount": turnover_amount,
            "main_force_amount": main_force_amount,
            "northbound_amount": northbound_amount,
        }

    @classmethod
    async def _fetch_returns_for_symbols(cls, symbols: Iterable[str], next_trade_date: date) -> list[float]:
        results: list[float] = []
        next_date_str = next_trade_date.strftime("%Y%m%d")
        prev_date_str = (next_trade_date - timedelta(days=10)).strftime("%Y%m%d")

        for symbol in symbols:
            try:
                hist_df = await cls._run_sync(
                    cls._ak().stock_zh_a_hist,
                    symbol=symbol,
                    period="daily",
                    start_date=prev_date_str,
                    end_date=next_date_str,
                    adjust="qfq",
                )
                if hist_df is None or hist_df.empty:
                    continue
                pd = cls._pd()
                working_df = hist_df.copy()
                date_col = "日期" if "日期" in working_df.columns else "date"
                close_col = "收盘" if "收盘" in working_df.columns else "close"
                working_df[date_col] = pd.to_datetime(working_df[date_col]).dt.date
                working_df = working_df.sort_values(date_col)
                target_idx = working_df.index[working_df[date_col] == next_trade_date]
                if len(target_idx) == 0:
                    continue
                idx = target_idx[0]
                position = working_df.index.get_loc(idx)
                if position == 0:
                    continue
                prev_row = working_df.iloc[position - 1]
                cur_row = working_df.iloc[position]
                prev_close = float(prev_row[close_col])
                cur_close = float(cur_row[close_col])
                if prev_close:
                    results.append((cur_close / prev_close - 1) * 100)
            except Exception:
                continue
            await asyncio.sleep(0.2)

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
        metrics.turnover_amount = market_data["turnover_amount"]
        metrics.northbound_amount = market_data["northbound_amount"]
        metrics.main_force_amount = market_data["main_force_amount"]
        metrics.computed_at = datetime.utcnow()

        return metrics

    @classmethod
    async def sync_sentiment_for_date(cls, db: Session, trade_date: date, force: bool = False) -> SentimentSyncDateResponse:
        if not await cls.is_trading_day(trade_date):
            return SentimentSyncDateResponse(
                trade_date=trade_date.isoformat(),
                success=False,
                synced_pools=[],
                metrics_ready=False,
                message="所选日期不是交易日",
            )

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
    async def get_metrics(cls, db: Session, start_date: date, end_date: date) -> SentimentMetricsResponse:
        rows = (
            db.query(SentimentDailyMetrics)
            .filter(SentimentDailyMetrics.trade_date >= start_date, SentimentDailyMetrics.trade_date <= end_date)
            .order_by(SentimentDailyMetrics.trade_date.asc())
            .all()
        )
        points: list[SentimentMetricPoint] = []
        for row in rows:
            market_heat = (
                row.up_limit_count * 1.6
                - row.down_limit_count * 1.2
                - row.break_limit_count * 0.8
                + row.advance_rate * 0.35
            )
            points.append(
                SentimentMetricPoint(
                    date=row.trade_date.isoformat(),
                    advanceRate=round(row.advance_rate, 2),
                    breakoutRate=round(row.breakout_rate, 2),
                    marketHeat=round(max(0.0, market_heat), 2),
                    avgReturn=round(row.avg_return, 2),
                    maxReturn=round(row.max_return, 2),
                    medianReturn=round(row.median_return, 2),
                    firstBoardCount=row.first_board_count,
                    secondBoardCount=row.second_board_count,
                    breakoutCount=row.break_limit_count,
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
