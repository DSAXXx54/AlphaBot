from datetime import date, datetime, timedelta

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.api.dependencies import check_usage_limit
from app.db.session import get_db
from app.schemas.sentiment import SentimentSyncDateRequest
from app.services.sentiment_service import SentimentService
from app.utils.response import api_response

router = APIRouter()


@router.get("/metrics", response_model=dict)
async def get_sentiment_metrics(
    start_date: date | None = Query(None),
    end_date: date | None = Query(None),
    db: Session = Depends(get_db),
    _: None = Depends(check_usage_limit),
):
    if end_date is None:
        end_date = datetime.now().date()
    if start_date is None:
        start_date = end_date - timedelta(days=120)
    if start_date > end_date:
        return api_response(success=False, error="start_date 不能晚于 end_date")

    metrics = await SentimentService.get_metrics(db, start_date, end_date)
    return api_response(data=metrics.model_dump())


@router.get("/calendar", response_model=dict)
async def get_sentiment_calendar(
    year: int = Query(..., ge=2000, le=2100),
    month: int = Query(..., ge=1, le=12),
    db: Session = Depends(get_db),
    _: None = Depends(check_usage_limit),
):
    calendar = await SentimentService.list_month_calendar(db, year, month)
    return api_response(data=calendar.model_dump())


@router.post("/sync/date", response_model=dict)
async def sync_sentiment_by_date(
    payload: SentimentSyncDateRequest,
    db: Session = Depends(get_db),
    _: None = Depends(check_usage_limit),
):
    result = await SentimentService.sync_sentiment_for_date(db, payload.trade_date, force=payload.force)
    if not result.success:
        return api_response(success=False, data=result.model_dump(), error=result.message)
    return api_response(data=result.model_dump())
