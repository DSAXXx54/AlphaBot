import pytest

from app.services import market_cache


@pytest.mark.asyncio
async def test_client_raises_when_redis_ping_fails(monkeypatch):
    class BrokenRedis:
        async def ping(self):
            raise OSError("connection refused")

    monkeypatch.setattr(market_cache, "_redis", None)
    monkeypatch.setattr(market_cache, "_redis_failed_until", 0.0)
    monkeypatch.setattr(market_cache, "get_async_redis_client", lambda: BrokenRedis())

    with pytest.raises(market_cache.MarketCacheUnavailable):
        await market_cache._client()


@pytest.mark.asyncio
async def test_get_json_raises_when_redis_read_fails(monkeypatch):
    class BrokenRedis:
        async def get(self, _key):
            raise OSError("connection lost")

    monkeypatch.setattr(market_cache, "_redis", BrokenRedis())
    monkeypatch.setattr(market_cache, "_redis_failed_until", 0.0)

    with pytest.raises(market_cache.MarketCacheUnavailable):
        await market_cache.get_json("market:test")


@pytest.mark.asyncio
async def test_set_json_raises_when_redis_write_fails(monkeypatch):
    class BrokenRedis:
        async def set(self, *_args, **_kwargs):
            raise OSError("connection lost")

    monkeypatch.setattr(market_cache, "_redis", BrokenRedis())
    monkeypatch.setattr(market_cache, "_redis_failed_until", 0.0)

    with pytest.raises(market_cache.MarketCacheUnavailable):
        await market_cache.set_json("market:test", {"value": 1})
