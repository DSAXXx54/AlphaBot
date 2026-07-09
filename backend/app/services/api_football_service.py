from __future__ import annotations

from copy import deepcopy
import asyncio
import logging
from typing import Any, Dict, List, Optional

import httpx

from app.core.config import settings

logger = logging.getLogger("uvicorn")

_api_football_memory_cache: Dict[str, Dict[str, Any]] = {}


class ApiFootballService:
    @staticmethod
    def enabled() -> bool:
        return settings.WORLDCUP_API_FOOTBALL_ENABLED and bool(settings.WORLDCUP_API_FOOTBALL_KEY)

    @staticmethod
    def _headers() -> Dict[str, str]:
        return {
            "x-apisports-key": settings.WORLDCUP_API_FOOTBALL_KEY,
            "x-rapidapi-host": settings.WORLDCUP_API_FOOTBALL_HOST,
        }

    @staticmethod
    async def _get(endpoint: str, params: Dict[str, Any]) -> List[Dict[str, Any]]:
        if not ApiFootballService.enabled():
            return []
        try:
            async with httpx.AsyncClient(
                base_url=settings.WORLDCUP_API_FOOTBALL_BASE_URL,
                headers=ApiFootballService._headers(),
                timeout=settings.WORLDCUP_API_FOOTBALL_TIMEOUT,
            ) as client:
                response = await client.get(endpoint, params=params)
                response.raise_for_status()
                payload = response.json()
        except Exception as exc:
            logger.warning(
                "worldcup.api_football endpoint=%s failed=%s detail=%s",
                endpoint,
                exc.__class__.__name__,
                exc,
            )
            return []
        data = payload.get("response") or []
        return data if isinstance(data, list) else []

    @staticmethod
    async def enrich_match_fundamentals(match: Dict[str, Any]) -> Dict[str, Any]:
        if not ApiFootballService.enabled():
            return match
        cache_key = str(match.get("match_id") or "")
        cached = _api_football_memory_cache.get(cache_key)
        if cached:
            enriched = deepcopy(match)
            enriched.setdefault("api_football_context", deepcopy(cached))
            return enriched

        fixture_id = ApiFootballService._extract_fixture_id(match)
        if not fixture_id:
            return match

        h2h = await ApiFootballService._get("fixtures/headtohead", {"h2h": ApiFootballService._h2h_key(match)})
        injuries = await ApiFootballService._get("injuries", {"fixture": fixture_id})
        lineups = await ApiFootballService._get("fixtures/lineups", {"fixture": fixture_id})
        statistics = await ApiFootballService._get("fixtures/statistics", {"fixture": fixture_id})
        home_team_id = ((match.get("team_context") or {}).get("home") or {}).get("team_id")
        away_team_id = ((match.get("team_context") or {}).get("away") or {}).get("team_id")
        recent_home = await ApiFootballService._get("fixtures", {"team": home_team_id, "last": 6}) if home_team_id else []
        recent_away = await ApiFootballService._get("fixtures", {"team": away_team_id, "last": 6}) if away_team_id else []

        context = {
            "fixture_id": fixture_id,
            "head_to_head": h2h[:6],
            "injuries": injuries,
            "lineups": lineups,
            "statistics": statistics,
            "recent_form": {
                "home": recent_home[:6],
                "away": recent_away[:6],
            },
        }
        _api_football_memory_cache[cache_key] = deepcopy(context)
        enriched = deepcopy(match)
        enriched["api_football_context"] = context
        return enriched

    @staticmethod
    async def enrich_matches_fundamentals(matches: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        if not ApiFootballService.enabled() or not matches:
            return matches

        semaphore = asyncio.Semaphore(4)

        async def _enrich(match: Dict[str, Any]) -> Dict[str, Any]:
            async with semaphore:
                return await ApiFootballService.enrich_match_fundamentals(match)

        enriched_matches = await asyncio.gather(*[_enrich(match) for match in matches])
        return list(enriched_matches)

    @staticmethod
    def _extract_fixture_id(match: Dict[str, Any]) -> Optional[int]:
        raw_id = match.get("match_id")
        try:
            return int(raw_id)
        except (TypeError, ValueError):
            return None

    @staticmethod
    def _h2h_key(match: Dict[str, Any]) -> Optional[str]:
        home_team = ((match.get("team_context") or {}).get("home") or {}).get("team_id")
        away_team = ((match.get("team_context") or {}).get("away") or {}).get("team_id")
        if not home_team or not away_team:
            return None
        return f"{home_team}-{away_team}"
