from datetime import date

from fastapi import APIRouter, Query

from app.services.trading_calendar_service import TradingCalendarService
from app.utils.response import api_response

router = APIRouter()


@router.get("/trading-calendar", response_model=dict)
async def get_trading_calendar(
    start_date: date | None = Query(None),
    end_date: date | None = Query(None),
    limit: int | None = Query(None, ge=1, le=365),
):
    calendar = await TradingCalendarService.get_trade_calendar()
    values = calendar
    if end_date is not None:
        values = [day for day in values if day <= end_date]
    if start_date is not None:
        values = [day for day in values if day >= start_date]
    if limit is not None:
        values = values[-limit:]

    latest = values[-1].isoformat() if values else None
    return api_response(
        data={
            "days": [day.isoformat() for day in values],
            "latest_trading_day": latest,
        }
    )
