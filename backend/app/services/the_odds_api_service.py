from __future__ import annotations

from copy import deepcopy
import logging
from typing import Any, Dict, List, Optional

import httpx

from app.core.config import settings

logger = logging.getLogger("uvicorn")

_the_odds_cache: Dict[str, List[Dict[str, Any]]] = {}


class TheOddsApiService:
    @staticmethod
    def enabled() -> bool:
        return settings.WORLDCUP_ODDS_API_ENABLED and bool(settings.WORLDCUP_ODDS_API_KEY)

    @staticmethod
    async def get_match_bookmaker_quotes(match: Dict[str, Any]) -> List[Dict[str, Any]]:
        if not TheOddsApiService.enabled():
            return []
        cache_key = str(match.get("match_id") or "")
        cached = _the_odds_cache.get(cache_key)
        if cached:
            return deepcopy(cached)

        events = await TheOddsApiService._fetch_events()
        event = TheOddsApiService._match_event(match, events)
        if not event:
            return []
        quotes = TheOddsApiService._normalize_bookmaker_quotes(match, event)
        if quotes:
            _the_odds_cache[cache_key] = deepcopy(quotes)
        return quotes

    @staticmethod
    async def get_bookmaker_quotes_map(matches: List[Dict[str, Any]]) -> Dict[str, List[Dict[str, Any]]]:
        if not TheOddsApiService.enabled() or not matches:
            return {}
        events = await TheOddsApiService._fetch_events()
        if not events:
            return {}

        quotes_by_match: Dict[str, List[Dict[str, Any]]] = {}
        for match in matches:
            match_id = str(match.get("match_id") or "")
            if not match_id:
                continue
            event = TheOddsApiService._match_event(match, events)
            if not event:
                continue
            quotes = TheOddsApiService._normalize_bookmaker_quotes(match, event)
            if not quotes:
                continue
            quotes_by_match[match_id] = quotes
            _the_odds_cache[match_id] = deepcopy(quotes)
        return quotes_by_match

    @staticmethod
    async def _fetch_events() -> List[Dict[str, Any]]:
        params = {
            "apiKey": settings.WORLDCUP_ODDS_API_KEY,
            "regions": settings.WORLDCUP_ODDS_API_REGIONS,
            "markets": "h2h,spreads,totals",
            "oddsFormat": "decimal",
        }
        if settings.WORLDCUP_ODDS_API_BOOKMAKERS:
            params["bookmakers"] = settings.WORLDCUP_ODDS_API_BOOKMAKERS
        try:
            async with httpx.AsyncClient(
                base_url=settings.WORLDCUP_ODDS_API_BASE_URL,
                timeout=settings.WORLDCUP_ODDS_API_TIMEOUT,
            ) as client:
                response = await client.get(f"/sports/{settings.WORLDCUP_ODDS_API_SPORT}/odds", params=params)
                response.raise_for_status()
                payload = response.json()
        except Exception as exc:
            logger.warning(
                "worldcup.the_odds_api failed=%s detail=%s",
                exc.__class__.__name__,
                exc,
            )
            return []
        return payload if isinstance(payload, list) else []

    @staticmethod
    def _match_event(match: Dict[str, Any], events: List[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
        home_team = str(match.get("home_team") or "").strip().lower()
        away_team = str(match.get("away_team") or "").strip().lower()
        for event in events:
            event_home = str(event.get("home_team") or "").strip().lower()
            event_away = str(event.get("away_team") or "").strip().lower()
            if event_home == home_team and event_away == away_team:
                return event
            if event_home == away_team and event_away == home_team:
                return event
        return None

    @staticmethod
    def _normalize_bookmaker_quotes(match: Dict[str, Any], event: Dict[str, Any]) -> List[Dict[str, Any]]:
        quotes: List[Dict[str, Any]] = []
        for bookmaker in event.get("bookmakers") or []:
            markets = bookmaker.get("markets") or []
            normalized_markets = {str(market.get("key") or ""): market for market in markets if isinstance(market, dict)}
            h2h_market = TheOddsApiService._build_h2h_market(match, normalized_markets.get("h2h"))
            spread_market = TheOddsApiService._build_spread_market(match, normalized_markets.get("spreads"))
            totals_market = TheOddsApiService._build_totals_market(normalized_markets.get("totals"))
            if not h2h_market and not spread_market and not totals_market:
                continue
            quotes.append(
                {
                    "bookmaker": bookmaker.get("title") or bookmaker.get("key") or "The Odds API",
                    "h2h_market": h2h_market,
                    "spread_market": spread_market,
                    "totals_market": totals_market,
                }
            )
        return quotes

    @staticmethod
    def _build_h2h_market(match: Dict[str, Any], market: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
        outcomes = (market or {}).get("outcomes") or []
        items = []
        for outcome in outcomes:
            label = str(outcome.get("name") or "").strip()
            price = TheOddsApiService._to_float(outcome.get("price"))
            if not label or price is None:
                continue
            items.append((label, price))
        return TheOddsApiService._market_from_decimal(items, "h2h", "胜平负")

    @staticmethod
    def _build_spread_market(match: Dict[str, Any], market: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
        outcomes = (market or {}).get("outcomes") or []
        items = []
        line = None
        for outcome in outcomes:
            label = str(outcome.get("name") or "").strip()
            price = TheOddsApiService._to_float(outcome.get("price"))
            point = TheOddsApiService._to_float(outcome.get("point"))
            if not label or price is None:
                continue
            if label == match.get("home_team"):
                signed_line = point
            elif label == match.get("away_team"):
                signed_line = point
            else:
                signed_line = point
            display = f"{label} {signed_line:+.2f}".replace(".00", "") if signed_line is not None else label
            items.append((display, price))
            if label == match.get("home_team"):
                line = signed_line
        result = TheOddsApiService._market_from_decimal(items, "asian_handicap", "让球")
        if result and line is not None:
            result["line"] = str(line)
        return result

    @staticmethod
    def _build_totals_market(market: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
        outcomes = (market or {}).get("outcomes") or []
        items = []
        line = None
        for outcome in outcomes:
            label = str(outcome.get("name") or "").strip()
            price = TheOddsApiService._to_float(outcome.get("price"))
            point = TheOddsApiService._to_float(outcome.get("point"))
            if not label or price is None:
                continue
            display = f"{label} {point}" if point is not None else label
            items.append((display, price))
            if point is not None:
                line = point
        result = TheOddsApiService._market_from_decimal(items, "totals", "大小球")
        if result and line is not None:
            result["line"] = str(line)
        return result

    @staticmethod
    def _market_from_decimal(items: List[tuple[str, float]], market_type: str, title: str) -> Optional[Dict[str, Any]]:
        prepared = [(label, odds, 1 / odds) for label, odds in items if odds > 1]
        implied_sum = sum(item[2] for item in prepared)
        if not prepared or implied_sum <= 0:
            return None
        options = [
            {
                "label": label,
                "odds": round(odds, 2),
                "probability": round(implied / implied_sum, 4),
            }
            for label, odds, implied in prepared
        ]
        return {
            "market_type": market_type,
            "title": title,
            "line": None,
            "options": options,
        }

    @staticmethod
    def _to_float(value: Any) -> Optional[float]:
        try:
            return float(value)
        except (TypeError, ValueError):
            return None
