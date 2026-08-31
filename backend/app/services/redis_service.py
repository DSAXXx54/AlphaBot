from __future__ import annotations

from typing import Optional
from urllib.parse import urlparse

from redis import asyncio as redis_asyncio

from app.core.config import settings

_clients: dict[str, redis_asyncio.Redis] = {}


def resolve_redis_url(preferred_url: Optional[str] = None) -> str:
    candidates = [
        preferred_url,
        settings.CELERY_BROKER_URL,
        settings.CELERY_RESULT_BACKEND,
    ]
    for candidate in candidates:
        if candidate and urlparse(candidate).scheme.startswith("redis"):
            return candidate
    return preferred_url or settings.CELERY_BROKER_URL


def get_async_redis_client(preferred_url: Optional[str] = None) -> redis_asyncio.Redis:
    url = resolve_redis_url(preferred_url)
    client = _clients.get(url)
    if client is None:
        client = redis_asyncio.from_url(url, decode_responses=True)
        _clients[url] = client
    return client
