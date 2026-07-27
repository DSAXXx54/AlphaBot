from datetime import datetime

from sqlalchemy import Column, Date, DateTime, Float, Integer, String, Text, UniqueConstraint

from app.db.session import Base


class SentimentPoolRaw(Base):
    __tablename__ = "sentiment_pool_raw"
    __table_args__ = (
        UniqueConstraint("trade_date", "pool_type", "symbol", name="uq_sentiment_pool_raw_date_type_symbol"),
    )

    id = Column(Integer, primary_key=True, index=True)
    trade_date = Column(Date, nullable=False, index=True)
    pool_type = Column(String(16), nullable=False, index=True)
    symbol = Column(String(20), nullable=False, index=True)
    name = Column(String(100), nullable=True)
    board_height = Column(Integer, nullable=True)
    board_label = Column(String(32), nullable=True)
    first_limit_time = Column(String(16), nullable=True)
    last_limit_time = Column(String(16), nullable=True)
    limit_open_count = Column(Integer, nullable=True)
    reason = Column(Text, nullable=True)
    payload_json = Column(Text, nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False)


class SentimentDailyMetrics(Base):
    __tablename__ = "sentiment_daily_metrics"

    id = Column(Integer, primary_key=True, index=True)
    trade_date = Column(Date, nullable=False, unique=True, index=True)
    up_limit_count = Column(Integer, default=0, nullable=False)
    down_limit_count = Column(Integer, default=0, nullable=False)
    break_limit_count = Column(Integer, default=0, nullable=False)
    first_board_count = Column(Integer, default=0, nullable=False)
    second_board_count = Column(Integer, default=0, nullable=False)
    third_plus_board_count = Column(Integer, default=0, nullable=False)
    max_board_height = Column(Integer, default=0, nullable=False)
    advance_rate = Column(Float, default=0.0, nullable=False)
    breakout_rate = Column(Float, default=0.0, nullable=False)
    avg_return = Column(Float, default=0.0, nullable=False)
    median_return = Column(Float, default=0.0, nullable=False)
    max_return = Column(Float, default=0.0, nullable=False)
    turnover_amount = Column(Float, default=0.0, nullable=False)
    northbound_amount = Column(Float, default=0.0, nullable=False)
    main_force_amount = Column(Float, default=0.0, nullable=False)
    computed_at = Column(DateTime, default=datetime.utcnow, nullable=False)


class SentimentSyncStatus(Base):
    __tablename__ = "sentiment_sync_status"
    __table_args__ = (
        UniqueConstraint("trade_date", "pool_type", name="uq_sentiment_sync_status_date_type"),
    )

    id = Column(Integer, primary_key=True, index=True)
    trade_date = Column(Date, nullable=False, index=True)
    pool_type = Column(String(16), nullable=False, index=True)
    status = Column(String(16), nullable=False, default="pending")
    retry_count = Column(Integer, nullable=False, default=0)
    last_error = Column(Text, nullable=True)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False)
