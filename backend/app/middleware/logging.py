from fastapi import Request
import time
from typing import Callable
import logging
from datetime import datetime
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError
from app.core.config import settings
# 使用 uvicorn 的 logger
logger = logging.getLogger("uvicorn")


def _log_timezone() -> ZoneInfo:
    try:
        return ZoneInfo(settings.APP_TIMEZONE)
    except ZoneInfoNotFoundError:
        return ZoneInfo("Asia/Shanghai")

async def logging_middleware(request: Request, call_next: Callable):
    # 获取客户端IP
    client_host = request.client.host if request.client else "unknown"
    forwarded_for = request.headers.get("X-Forwarded-For")
    client_ip = forwarded_for.split(",")[0] if forwarded_for else client_host
    
    # 处理请求
    start_time = time.time()
    response = await call_next(request)
    process_time = (time.time() - start_time) * 1000
    
    # 记录访问日志
    logger.info(
        f"{datetime.now(_log_timezone()).strftime('%Y-%m-%d %H:%M:%S')} - "
        f"{request.method} {request.url.path} - "
        f"IP: {client_ip} - "
        f"Status: {response.status_code} - "
        f"Process Time: {process_time:.2f}ms"
    )
    
    return response 
