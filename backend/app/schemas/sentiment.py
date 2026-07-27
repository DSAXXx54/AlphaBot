from datetime import date, datetime

from pydantic import BaseModel, ConfigDict, Field


class SentimentMetricPoint(BaseModel):
    date: str
    advanceRate: float
    breakoutRate: float
    marketHeat: float
    avgReturn: float
    maxReturn: float
    medianReturn: float
    firstBoardCount: int
    secondBoardCount: int
    breakoutCount: int
    turnoverAmount: float
    northboundAmount: float
    mainForceAmount: float


class SentimentMetricsResponse(BaseModel):
    startDate: str
    endDate: str
    points: list[SentimentMetricPoint]
    summary: dict


class SentimentCalendarDay(BaseModel):
    date: str
    is_trading_day: bool
    sync_status: str
    metrics_ready: bool


class SentimentCalendarResponse(BaseModel):
    year: int
    month: int
    days: list[SentimentCalendarDay]


class SentimentSyncDateRequest(BaseModel):
    trade_date: date
    force: bool = Field(default=False)


class SentimentSyncDateResponse(BaseModel):
    trade_date: str
    success: bool
    synced_pools: list[str]
    metrics_ready: bool
    message: str


class SentimentPoolRawOut(BaseModel):
    trade_date: date
    pool_type: str
    symbol: str
    name: str | None = None
    board_height: int | None = None
    board_label: str | None = None
    first_limit_time: str | None = None
    last_limit_time: str | None = None
    limit_open_count: int | None = None
    reason: str | None = None
    payload_json: str
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)
