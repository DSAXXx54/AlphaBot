from __future__ import annotations

from typing import Optional

from app.core.config import settings
from app.services.redis_service import get_async_redis_client


class BatchAnalysisLimiter:
    RUNNING_TTL_SECONDS = settings.CELERY_TASK_TIME_LIMIT + 60
    COOLDOWN_SECONDS = 300
    _client = None

    @classmethod
    def _get_client(cls):
        if cls._client is None:
            cls._client = get_async_redis_client()
        return cls._client

    @classmethod
    def _running_key(cls, user_id: int) -> str:
        return f"batch_analysis:running:{user_id}"

    @classmethod
    def _cooldown_key(cls, user_id: int) -> str:
        return f"batch_analysis:cooldown:{user_id}"

    @classmethod
    async def get_running_task_id(cls, user_id: int) -> Optional[str]:
        value = await cls._get_client().get(cls._running_key(user_id))
        return value or None

    @classmethod
    async def get_cooldown_seconds(cls, user_id: int) -> int:
        ttl = await cls._get_client().ttl(cls._cooldown_key(user_id))
        return max(ttl, 0)

    @classmethod
    async def register_submission(cls, user_id: int, task_id: str) -> None:
        client = cls._get_client()
        await client.set(cls._running_key(user_id), task_id, ex=cls.RUNNING_TTL_SECONDS)
        await client.set(cls._cooldown_key(user_id), task_id, ex=cls.COOLDOWN_SECONDS)

    @classmethod
    async def clear_running_task(cls, user_id: int, task_id: Optional[str] = None) -> None:
        client = cls._get_client()
        running_key = cls._running_key(user_id)

        if task_id is None:
            await client.delete(running_key)
            return

        current_task_id = await client.get(running_key)
        if current_task_id == task_id:
            await client.delete(running_key)
