from datetime import datetime

from sqlalchemy import JSON, Boolean, Column, DateTime, Integer, String, Text

from app.db.session import Base


class ScheduledTask(Base):
    """定时任务持久化表。"""

    __tablename__ = "tasks"

    id = Column(Integer, primary_key=True, index=True)
    task_id = Column(String(64), unique=True, nullable=False, index=True)
    task_type = Column(String(32), nullable=False, default="generic", index=True)
    interval = Column(Integer, nullable=False, default=3600)
    next_run = Column(DateTime, nullable=True)
    description = Column(String(255), nullable=False, default="")
    is_enabled = Column(Boolean, nullable=False, default=True)
    params = Column(JSON, nullable=False, default=dict)
    last_run = Column(DateTime, nullable=True)
    run_count = Column(Integer, nullable=False, default=0)
    status = Column(String(32), nullable=False, default="pending")
    current_stage = Column(String(64), nullable=True)
    status_detail = Column(Text, nullable=True)
    stage_history = Column(JSON, nullable=False, default=list)
    last_result = Column(JSON, nullable=True)
    last_error = Column(Text, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False)
