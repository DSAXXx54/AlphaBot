from __future__ import annotations

import asyncio
from copy import deepcopy
from datetime import date, datetime, timedelta, timezone
import json
import logging
import time
import re
from typing import Any, Dict, List, Optional
from urllib.parse import urlparse

import httpx
from redis import asyncio as redis_asyncio

from app.core.config import settings
from app.services.api_football_service import ApiFootballService
from app.services.llm_registry import LLMRegistry, LLMProfileName
from app.services.the_odds_api_service import TheOddsApiService

logger = logging.getLogger("uvicorn")

INITIAL_BANKROLL = 10000.0
PREKICK_ENTRY_WINDOW = timedelta(hours=2)

TEAM_ALIASES: Dict[str, List[str]] = {
    "United States": ["united states", "usa", "u.s.a", "u.s.", "usmnt"],
    "Bosnia-Herzegovina": ["bosnia-herzegovina", "bosnia and herzegovina", "bosnia herzegovina", "bih"],
    "South Korea": ["south korea", "korea republic", "korea"],
    "Czech Republic": ["czech republic", "czechia"],
}

STAGE_LABELS = {
    "Group Stage": "小组赛",
    "Round of 32": "32强",
    "Round of 16": "16强",
    "Quarterfinals": "8强",
    "Semifinals": "半决赛",
    "3rd-Place Match": "季军赛",
    "Final": "决赛",
}

_polymarket_cache: Dict[str, Any] = {"expires_at": None, "events": []}
_bankroll_ledger_cache: Dict[str, Any] = {"bets": []}
_ai_analysis_cache: Dict[str, Dict[str, Any]] = {}


class WorldCupService:
    _redis_client: Optional[redis_asyncio.Redis] = None
    _polymarket_cache_key = "worldcup:polymarket:v2"
    _bankroll_ledger_key = "worldcup:bankroll:ledger:v1"
    _ai_analysis_cache_key_prefix = "worldcup:ai_analysis:"
    _matches_index_key = "worldcup:matches:index:v1"
    _match_key_prefix = "worldcup:match:v1:"
    _match_date_key_prefix = "worldcup:matches:date:v1:"
    _match_dates_index_key = "worldcup:matches:dates:v1"

    @staticmethod
    async def get_overview(refresh: bool = False) -> Dict[str, Any]:
        if refresh:
            await WorldCupService._refresh_window_data()
        matches = await WorldCupService._load_matches()
        if not matches:
            matches = await WorldCupService._refresh_all_data()
        ledger = await WorldCupService._get_bankroll_ledger()
        matches = WorldCupService._hydrate_matches_from_ledger(matches, ledger)
        bankroll_summary = WorldCupService._build_bankroll_summary(ledger)
        settled_matches = sum(1 for match in matches if match.get("status") == "settled")
        open_positions = bankroll_summary["open_positions"]
        next_match_at = next(
            (match["kickoff_at"] for match in matches if match["status"] != "settled"),
            datetime.now(timezone.utc).isoformat(),
        )
        featured_matches = [WorldCupService._summary(match) for match in matches[:3]]
        market_ready_matches = sum(1 for match in matches if match["key_market"]["options"])
        total_matches = len(matches)
        # logger.info(
        #     "worldcup.get_overview refresh=%s matches=%s elapsed_ms=%.2f",
        #     refresh,
        #     total_matches,
        #     (time.perf_counter() - started_at) * 1000,
        # )

        return {
            "tournament": "2026 FIFA World Cup",
            "bankroll": bankroll_summary["bankroll"],
            "initial_bankroll": INITIAL_BANKROLL,
            "settled_matches": settled_matches,
            "open_positions": open_positions,
            "roi": bankroll_summary["roi"],
            "max_drawdown": bankroll_summary["max_drawdown"],
            "next_match_at": next_match_at,
            "phase_breakdown": WorldCupService._build_phase_breakdown(matches, ledger),
            "featured_matches": featured_matches,
            "bankroll_curve": bankroll_summary["bankroll_curve"],
            "last_updated_at": datetime.now(timezone.utc).isoformat(),
            "market_heat": [
                {
                    "label": "已接市场覆盖率",
                    "value": round(market_ready_matches / total_matches * 100, 1) if total_matches else 0.0,
                },
                {
                    "label": "待同步盘口占比",
                    "value": round((total_matches - market_ready_matches) / total_matches * 100, 1) if total_matches else 0.0,
                },
                {
                    "label": "已完赛进度",
                    "value": round(settled_matches / total_matches * 100, 1) if total_matches else 0.0,
                },
            ],
        }

    @staticmethod
    async def run_daily_refresh() -> Dict[str, Any]:
        matches = await WorldCupService._refresh_all_data()
        return {
            "matches": len(matches),
            "settled": sum(1 for match in matches if match["status"] == "settled"),
            "updated_at": datetime.now(timezone.utc).isoformat(),
        }

    @staticmethod
    async def run_prekick_sync() -> Dict[str, Any]:
        cached_matches = await WorldCupService._load_matches()
        if not cached_matches:
            cached_matches = await WorldCupService._refresh_all_data()
        ledger = await WorldCupService._get_bankroll_ledger()
        now = datetime.now(timezone.utc)
        relevant_matches = [
            match for match in cached_matches
            if WorldCupService._needs_prekick_attention(match, now=now)
        ]
        open_bets = [bet for bet in ledger if bet.get("status") == "open"]
        if not relevant_matches and not open_bets:
            return {
                "skipped": True,
                "reason": "no_matches_in_window",
                "updated_at": datetime.now(timezone.utc).isoformat(),
            }

        refresh_match_ids = [match["match_id"] for match in relevant_matches]
        refresh_match_ids.extend(str(bet.get("match_id")) for bet in open_bets if bet.get("match_id"))
        matches = await WorldCupService._refresh_window_data(match_ids=refresh_match_ids)
        updated_ledger = await WorldCupService._get_bankroll_ledger()
        return {
            "skipped": False,
            "matches": len(matches),
            "window_matches": sum(
                1 for match in matches if WorldCupService._needs_prekick_attention(match, now=datetime.now(timezone.utc))
            ),
            "open_bets": sum(1 for bet in updated_ledger if bet.get("status") == "open"),
            "settled_bets": sum(1 for bet in updated_ledger if WorldCupService._is_bet_closed(bet)),
            "updated_at": datetime.now(timezone.utc).isoformat(),
        }

    @staticmethod
    async def list_matches(stage: Optional[str] = None, status: Optional[str] = None, refresh: bool = False) -> List[Dict[str, Any]]:
        if refresh:
            await WorldCupService._refresh_window_data()
        matches = await WorldCupService._load_matches()
        if not matches:
            matches = await WorldCupService._refresh_all_data()
        ledger = await WorldCupService._get_bankroll_ledger()
        matches = WorldCupService._hydrate_matches_from_ledger(matches, ledger)
        if stage:
            matches = [match for match in matches if match["stage"] == stage]
        if status:
            matches = [match for match in matches if match["status"] == status]
        return [WorldCupService._summary(match) for match in matches]

    @staticmethod
    async def get_match_detail(match_id: str, refresh: bool = False, ai_refresh: bool = False) -> Optional[Dict[str, Any]]:
        if refresh:
            await WorldCupService._refresh_match_data(match_id)
        match = await WorldCupService._get_stored_match(match_id)
        if not match:
            matches = await WorldCupService._load_matches()
            if not matches:
                await WorldCupService._refresh_all_data()
                match = await WorldCupService._get_stored_match(match_id)
            else:
                match = next((item for item in matches if item["match_id"] == match_id), None)
        if not match:
            return None
        detail = deepcopy(match)
        detail = await ApiFootballService.enrich_match_fundamentals(detail)
        detail = await WorldCupService._enrich_match_bookmaker_quotes(detail)
        await WorldCupService._persist_enriched_match_if_needed(match, detail)
        ledger = await WorldCupService._get_bankroll_ledger()
        detail = WorldCupService._hydrate_match_from_ledger(detail, ledger)
        WorldCupService._normalize_polymarket_state(detail)
        if detail.get("markets") or detail.get("polymarket_probabilities"):
            WorldCupService._refresh_featured_pick(detail)
        bet = next((item for item in ledger if str(item.get("match_id")) == match_id), None)
        detail["bankroll_bet"] = WorldCupService._serialize_bankroll_bet(bet)
        detail["ai_analysis"] = None
        detail["ai_analysis_error"] = None
        try:
            if ai_refresh:
                detail["ai_analysis"] = await WorldCupService._get_ai_analysis(detail, refresh=True)
            else:
                detail["ai_analysis"] = await WorldCupService._get_cached_ai_analysis(detail)
        except Exception as exc:
            detail["ai_analysis_error"] = str(exc) or "AI 解读生成失败"
        return detail

    @staticmethod
    async def _load_matches() -> List[Dict[str, Any]]:
        matches = await WorldCupService._load_stored_matches()
        if matches:
            return matches
        return []

    @staticmethod
    async def _enrich_match_bookmaker_quotes(match: Dict[str, Any]) -> Dict[str, Any]:
        if match.get("bookmaker_quotes"):
            return match
        quotes = await TheOddsApiService.get_match_bookmaker_quotes(match)
        if not quotes:
            return match
        enriched = deepcopy(match)
        enriched["bookmaker_quotes"] = quotes
        primary = quotes[0]
        markets = [
            primary.get("h2h_market"),
            primary.get("spread_market"),
            primary.get("totals_market"),
        ]
        normalized_markets = [market for market in markets if isinstance(market, dict)]
        if normalized_markets:
            enriched["markets"] = normalized_markets
            enriched["key_market"] = deepcopy(normalized_markets[0])
            WorldCupService._refresh_featured_pick(enriched)
        return enriched

    @staticmethod
    async def _persist_enriched_match_if_needed(original: Dict[str, Any], enriched: Dict[str, Any]) -> None:
        original_payload = json.dumps(original, ensure_ascii=False, sort_keys=True)
        enriched_payload = json.dumps(enriched, ensure_ascii=False, sort_keys=True)
        if original_payload == enriched_payload:
            return
        await WorldCupService._set_json_value(
            WorldCupService._match_key(str(enriched.get("match_id"))),
            enriched,
        )

    @classmethod
    async def _enrich_matches_external_sources(cls, matches: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        if not matches:
            return matches

        enriched_matches = [deepcopy(match) for match in matches]
        quotes_by_match = await TheOddsApiService.get_bookmaker_quotes_map(enriched_matches)

        for match in enriched_matches:
            match_id = str(match.get("match_id") or "")
            quotes = quotes_by_match.get(match_id) or []
            if not quotes:
                continue
            match["bookmaker_quotes"] = quotes
            primary = quotes[0]
            markets = [
                primary.get("h2h_market"),
                primary.get("spread_market"),
                primary.get("totals_market"),
            ]
            normalized_markets = [market for market in markets if isinstance(market, dict)]
            if normalized_markets:
                match["markets"] = normalized_markets
                match["key_market"] = deepcopy(normalized_markets[0])

        enriched_matches = await ApiFootballService.enrich_matches_fundamentals(enriched_matches)

        for match in enriched_matches:
            if match.get("markets") or match.get("polymarket_probabilities"):
                cls._refresh_featured_pick(match)

        return enriched_matches

    @classmethod
    def _match_key(cls, match_id: str) -> str:
        return f"{cls._match_key_prefix}{match_id}"

    @classmethod
    def _match_date_key(cls, date_key: str) -> str:
        return f"{cls._match_date_key_prefix}{date_key}"

    @staticmethod
    def _kickoff_date_key(kickoff_at: Optional[str]) -> Optional[str]:
        if not kickoff_at:
            return None
        try:
            kickoff_dt = datetime.fromisoformat(str(kickoff_at).replace("Z", "+00:00"))
        except ValueError:
            return None
        return kickoff_dt.date().isoformat()

    @staticmethod
    def _date_point_to_key(day: str) -> str:
        return f"{day[:4]}-{day[4:6]}-{day[6:8]}"

    @staticmethod
    def _date_key_to_point(day: str) -> str:
        return day.replace("-", "")

    @staticmethod
    def _window_date_points(now: Optional[datetime] = None) -> List[str]:
        anchor = now or datetime.now(timezone.utc)
        return [
            (anchor.date() + timedelta(days=offset)).strftime("%Y%m%d")
            for offset in (-1, 0, 1)
        ]

    @staticmethod
    def _dedupe_matches(matches: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        deduped: Dict[str, Dict[str, Any]] = {}
        for match in matches:
            match_id = str(match.get("match_id") or "")
            if not match_id:
                continue
            deduped[match_id] = match
        result = list(deduped.values())
        result.sort(key=WorldCupService._sort_key)
        return result

    @classmethod
    async def _get_json_value(cls, key: str) -> Any:
        try:
            payload = await cls._get_redis_client().get(key)
            if not payload:
                return None
            return json.loads(payload)
        except Exception:
            return None

    @classmethod
    async def _set_json_value(cls, key: str, value: Any, ttl_seconds: Optional[int] = None) -> None:
        try:
            kwargs: Dict[str, Any] = {}
            if ttl_seconds:
                kwargs["ex"] = ttl_seconds
            await cls._get_redis_client().set(
                key,
                json.dumps(value, ensure_ascii=False),
                **kwargs,
            )
        except Exception:
            return None

    @classmethod
    async def _load_stored_matches(cls) -> List[Dict[str, Any]]:
        index = await cls._get_json_value(cls._matches_index_key)
        index_ids = [str(match_id) for match_id in index] if isinstance(index, list) else []
        if not index_ids:
            index_ids = await cls._rebuild_matches_index()
            if not index_ids:
                return []

        matches = await cls._load_stored_matches_by_ids(index_ids)
        if len(matches) == len(index_ids):
            return matches

        rebuilt_ids = await cls._rebuild_matches_index()
        if not rebuilt_ids or rebuilt_ids == index_ids:
            return matches
        return await cls._load_stored_matches_by_ids(rebuilt_ids)

    @classmethod
    async def _load_stored_matches_by_ids(cls, match_ids: List[str]) -> List[Dict[str, Any]]:
        matches: List[Dict[str, Any]] = []
        seen = set()
        for match_id in match_ids:
            normalized = str(match_id)
            if not normalized or normalized in seen:
                continue
            seen.add(normalized)
            match = await cls._get_json_value(cls._match_key(normalized))
            if isinstance(match, dict):
                matches.append(match)
        return cls._dedupe_matches(matches)

    @classmethod
    async def _get_stored_match(cls, match_id: str) -> Optional[Dict[str, Any]]:
        match = await cls._get_json_value(cls._match_key(str(match_id)))
        if isinstance(match, dict):
            return match
        return None

    @classmethod
    async def _load_stored_matches_for_dates(cls, date_keys: List[str]) -> List[Dict[str, Any]]:
        match_ids: List[str] = []
        for date_key in date_keys:
            ids = await cls._get_json_value(cls._match_date_key(date_key))
            if isinstance(ids, list):
                match_ids.extend(str(item) for item in ids)
        return await cls._load_stored_matches_by_ids(match_ids)

    @classmethod
    async def _load_all_match_ids_from_dates(cls) -> List[str]:
        all_dates = await cls._get_json_value(cls._match_dates_index_key)
        if not isinstance(all_dates, list) or not all_dates:
            return []
        match_ids: List[str] = []
        seen = set()
        for date_key in all_dates:
            ids = await cls._get_json_value(cls._match_date_key(str(date_key)))
            if not isinstance(ids, list):
                continue
            for match_id in ids:
                normalized = str(match_id)
                if not normalized or normalized in seen:
                    continue
                seen.add(normalized)
                match_ids.append(normalized)
        return match_ids

    @classmethod
    async def _rebuild_matches_index(cls) -> List[str]:
        index = sorted(await cls._load_all_match_ids_from_dates())
        if index:
            await cls._set_json_value(cls._matches_index_key, index)
        return index

    @classmethod
    async def _store_matches(
        cls,
        matches: List[Dict[str, Any]],
        date_replacements: Optional[Dict[str, List[Dict[str, Any]]]] = None,
        full_replace: bool = False,
    ) -> None:
        matches = cls._dedupe_matches(matches)
        if date_replacements:
            date_replacements = {
                date_key: cls._dedupe_matches(date_matches)
                for date_key, date_matches in date_replacements.items()
            }
        if not matches and not date_replacements and not full_replace:
            return

        redis_client = cls._get_redis_client()
        existing_index_raw = await cls._get_json_value(cls._matches_index_key)
        existing_index = {str(item) for item in existing_index_raw} if isinstance(existing_index_raw, list) else set()
        for match in matches:
            await redis_client.set(
                cls._match_key(str(match["match_id"])),
                json.dumps(match, ensure_ascii=False),
            )

        if full_replace:
            new_index = {str(match["match_id"]) for match in matches}
            stale_match_keys = [cls._match_key(match_id) for match_id in (existing_index - new_index)]
            if stale_match_keys:
                await redis_client.delete(*stale_match_keys)
            all_dates = await cls._get_json_value(cls._match_dates_index_key)
            if isinstance(all_dates, list):
                old_date_keys = [cls._match_date_key(str(item)) for item in all_dates]
                if old_date_keys:
                    await redis_client.delete(*old_date_keys)
            grouped: Dict[str, List[str]] = {}
            for match in matches:
                date_key = cls._kickoff_date_key(match.get("kickoff_at"))
                if not date_key:
                    continue
                grouped.setdefault(date_key, []).append(str(match["match_id"]))
            for date_key, match_ids in grouped.items():
                await redis_client.set(
                    cls._match_date_key(date_key),
                    json.dumps(match_ids, ensure_ascii=False),
                )
            await redis_client.set(
                cls._match_dates_index_key,
                json.dumps(sorted(grouped.keys()), ensure_ascii=False),
            )
        elif date_replacements:
            known_dates_raw = await cls._get_json_value(cls._match_dates_index_key)
            known_dates = set(str(item) for item in known_dates_raw) if isinstance(known_dates_raw, list) else set()
            for date_key, date_matches in date_replacements.items():
                match_ids = [str(match["match_id"]) for match in date_matches]
                await redis_client.set(
                    cls._match_date_key(date_key),
                    json.dumps(match_ids, ensure_ascii=False),
                )
                known_dates.add(date_key)
            await redis_client.set(
                cls._match_dates_index_key,
                json.dumps(sorted(known_dates), ensure_ascii=False),
            )

        if full_replace:
            index = sorted({str(match["match_id"]) for match in matches}, key=str)
        else:
            index = await cls._rebuild_matches_index()
        await redis_client.set(
            cls._matches_index_key,
            json.dumps(index, ensure_ascii=False),
        )

    @staticmethod
    def _merge_day_matches(
        day_matches: List[Dict[str, Any]],
        existing_matches: List[Dict[str, Any]],
        existing_by_id: Dict[str, Dict[str, Any]],
        preserve_missing_existing: bool,
    ) -> List[Dict[str, Any]]:
        merged_matches = [
            WorldCupService._merge_preserved_match_state(match, existing_by_id.get(str(match["match_id"])))
            for match in day_matches
        ]
        if not preserve_missing_existing:
            return merged_matches

        merged_ids = {str(match["match_id"]) for match in merged_matches}
        preserved_matches = [
            deepcopy(match)
            for match in existing_matches
            if str(match.get("match_id")) not in merged_ids
        ]
        return WorldCupService._dedupe_matches(merged_matches + preserved_matches)

    @staticmethod
    def _merge_preserved_match_state(fresh_match: Dict[str, Any], existing_match: Optional[Dict[str, Any]]) -> Dict[str, Any]:
        if not existing_match:
            WorldCupService._normalize_polymarket_state(fresh_match)
            return fresh_match
        merged = deepcopy(fresh_match)
        for field in (
            "key_market",
            "markets",
            "line_movement",
            "polymarket_probabilities",
            "bookmaker_quotes",
            "team_context",
            "market_diagnostics",
            "fundamentals",
            "heat_profile",
        ):
            if existing_match.get(field):
                merged[field] = deepcopy(existing_match[field])
        if existing_match.get("source") == "polymarket_live" and merged.get("source") == "espn_schedule":
            merged["source"] = existing_match.get("source")
        if existing_match.get("external_url") and not merged.get("external_url"):
            merged["external_url"] = existing_match.get("external_url")
        WorldCupService._normalize_polymarket_state(merged)
        if merged.get("markets") or merged.get("polymarket_probabilities"):
            WorldCupService._refresh_featured_pick(merged)
        return merged

    @staticmethod
    def _market_snapshot_from_match(match: Dict[str, Any]) -> Dict[str, Any]:
        return {
            "featured_pick": deepcopy(match.get("featured_pick") or WorldCupService._pending_pick()),
            "key_market": deepcopy(match.get("key_market") or WorldCupService._pending_market()),
            "markets": deepcopy(match.get("markets") or []),
            "line_movement": deepcopy(match.get("line_movement") or []),
            "polymarket_probabilities": deepcopy(match.get("polymarket_probabilities") or {}),
            "bookmaker_quotes": deepcopy(match.get("bookmaker_quotes") or []),
            "team_context": deepcopy(match.get("team_context") or {}),
            "market_diagnostics": deepcopy(match.get("market_diagnostics") or WorldCupService._pending_market_diagnostics()),
            "fundamentals": deepcopy(match.get("fundamentals") or WorldCupService._pending_fundamentals()),
            "heat_profile": deepcopy(match.get("heat_profile") or WorldCupService._pending_heat_profile()),
            "source": match.get("source"),
            "external_url": match.get("external_url"),
        }

    @staticmethod
    def _match_has_real_market_data(match: Dict[str, Any]) -> bool:
        key_market = match.get("key_market") or {}
        return bool(
            key_market.get("options")
            or match.get("markets")
            or match.get("line_movement")
            or match.get("polymarket_probabilities")
        )

    @staticmethod
    def _apply_market_snapshot_to_match(match: Dict[str, Any], market_snapshot: Optional[Dict[str, Any]]) -> Dict[str, Any]:
        if not isinstance(market_snapshot, dict):
            return match
        hydrated = deepcopy(match)
        for field in (
            "featured_pick",
            "key_market",
            "markets",
            "line_movement",
            "polymarket_probabilities",
            "bookmaker_quotes",
            "team_context",
            "market_diagnostics",
            "fundamentals",
            "heat_profile",
        ):
            value = market_snapshot.get(field)
            if value:
                hydrated[field] = deepcopy(value)
        if market_snapshot.get("source") and not hydrated.get("source"):
            hydrated["source"] = market_snapshot.get("source")
        if market_snapshot.get("external_url") and not hydrated.get("external_url"):
            hydrated["external_url"] = market_snapshot.get("external_url")
        WorldCupService._normalize_polymarket_state(hydrated)
        return hydrated

    @staticmethod
    def _hydrate_match_from_ledger(match: Dict[str, Any], ledger: List[Dict[str, Any]]) -> Dict[str, Any]:
        if WorldCupService._match_has_real_market_data(match):
            return match
        bet = next((item for item in ledger if str(item.get("match_id")) == str(match.get("match_id"))), None)
        if not bet:
            return match
        return WorldCupService._apply_market_snapshot_to_match(match, bet.get("market_snapshot"))

    @staticmethod
    def _hydrate_matches_from_ledger(matches: List[Dict[str, Any]], ledger: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        if not matches or not ledger:
            return matches
        ledger_by_match = {
            str(item.get("match_id")): item
            for item in ledger
            if item.get("match_id")
        }
        hydrated_matches = []
        for match in matches:
            if WorldCupService._match_has_real_market_data(match):
                hydrated_matches.append(match)
                continue
            bet = ledger_by_match.get(str(match.get("match_id")))
            if not bet:
                hydrated_matches.append(match)
                continue
            hydrated_matches.append(
                WorldCupService._apply_market_snapshot_to_match(match, bet.get("market_snapshot"))
            )
        return hydrated_matches

    @classmethod
    async def _fetch_schedule_slice(cls, date_points: List[str]) -> Dict[str, Optional[List[Dict[str, Any]]]]:
        if not date_points:
            return {}
        async with httpx.AsyncClient(timeout=10.0) as client:
            tasks = [cls._fetch_schedule_day(client, day) for day in date_points]
            responses = await asyncio.gather(*tasks, return_exceptions=True)

        schedule_by_day: Dict[str, Optional[List[Dict[str, Any]]]] = {}
        for day, response in zip(date_points, responses):
            if isinstance(response, Exception):
                logger.warning("worldcup.schedule_slice day=%s failed=%s", day, response.__class__.__name__)
                schedule_by_day[day] = None
                continue
            if response is None:
                schedule_by_day[day] = None
                continue
            mapped_matches = [cls._map_espn_event(event) for event in response]
            schedule_by_day[day] = [match for match in mapped_matches if match]
        return schedule_by_day

    @classmethod
    async def _refresh_dates(
        cls,
        date_points: List[str],
        polymarket_refresh: bool = True,
        preserve_missing_existing: bool = False,
    ) -> List[Dict[str, Any]]:
        date_points = sorted({day for day in date_points if day})
        if not date_points:
            return await cls._load_matches()

        date_keys = [cls._date_point_to_key(day) for day in date_points]
        existing_matches = await cls._load_stored_matches_for_dates(date_keys)
        existing_by_id = {str(match["match_id"]): match for match in existing_matches}
        existing_by_date: Dict[str, List[Dict[str, Any]]] = {date_key: [] for date_key in date_keys}
        for match in existing_matches:
            date_key = cls._kickoff_date_key(match.get("kickoff_at"))
            if date_key:
                existing_by_date.setdefault(date_key, []).append(match)

        fetched_by_day = await cls._fetch_schedule_slice(date_points)
        updated_by_date: Dict[str, List[Dict[str, Any]]] = {}
        updated_matches: List[Dict[str, Any]] = []
        for date_point in date_points:
            date_key = cls._date_point_to_key(date_point)
            day_matches = fetched_by_day.get(date_point)
            if day_matches is None:
                updated_by_date[date_key] = deepcopy(existing_by_date.get(date_key, []))
                updated_matches.extend(updated_by_date[date_key])
                continue
            merged_matches = cls._merge_day_matches(
                day_matches,
                existing_by_date.get(date_key, []),
                existing_by_id,
                preserve_missing_existing,
            )
            updated_by_date[date_key] = merged_matches
            updated_matches.extend(merged_matches)

        if settings.WORLDCUP_POLYMARKET_ENABLED:
            events = await cls._fetch_polymarket_events(refresh=polymarket_refresh)
            if events:
                for match in updated_matches:
                    event = cls._match_polymarket_event(match, events)
                    if event:
                        cls._apply_polymarket_event(match, event)

        updated_matches = await cls._enrich_matches_external_sources(updated_matches)
        updated_by_date = {date_key: [] for date_key in date_keys}
        for match in updated_matches:
            date_key = cls._kickoff_date_key(match.get("kickoff_at"))
            if not date_key:
                continue
            updated_by_date.setdefault(date_key, []).append(match)

        all_matches = await cls._load_matches()
        retained_matches = [
            match for match in all_matches
            if cls._kickoff_date_key(match.get("kickoff_at")) not in updated_by_date
        ]
        merged_all_matches = cls._dedupe_matches(retained_matches + updated_matches)

        await cls._store_matches(merged_all_matches, date_replacements=updated_by_date)
        await cls._sync_bankroll_ledger(updated_matches)
        return merged_all_matches

    @classmethod
    async def _refresh_all_data(cls) -> List[Dict[str, Any]]:
        start = date.fromisoformat(settings.WORLDCUP_SCHEDULE_START_DATE)
        end = date.fromisoformat(settings.WORLDCUP_SCHEDULE_END_DATE)
        date_points = []
        cursor = start
        while cursor <= end:
            date_points.append(cursor.strftime("%Y%m%d"))
            cursor += timedelta(days=1)
        matches = await cls._refresh_dates(
            date_points,
            polymarket_refresh=True,
            preserve_missing_existing=False,
        )
        await cls._store_matches(matches, full_replace=True)
        return matches

    @classmethod
    async def _refresh_window_data(cls, match_ids: Optional[List[str]] = None) -> List[Dict[str, Any]]:
        date_points = set(cls._window_date_points())
        if match_ids:
            related_matches = await cls._load_stored_matches_by_ids([str(match_id) for match_id in match_ids])
            for match in related_matches:
                date_key = cls._kickoff_date_key(match.get("kickoff_at"))
                if date_key:
                    date_points.add(cls._date_key_to_point(date_key))
        return await cls._refresh_dates(
            sorted(date_points),
            polymarket_refresh=True,
            preserve_missing_existing=True,
        )

    @classmethod
    async def _refresh_match_data(cls, match_id: str) -> Optional[Dict[str, Any]]:
        match = await cls._get_stored_match(match_id)
        if not match:
            matches = await cls._refresh_all_data()
            return next((item for item in matches if item["match_id"] == match_id), None)
        date_key = cls._kickoff_date_key(match.get("kickoff_at"))
        if not date_key:
            return match
        await cls._refresh_dates(
            [cls._date_key_to_point(date_key)],
            polymarket_refresh=True,
            preserve_missing_existing=True,
        )
        return await cls._get_stored_match(match_id)

    @staticmethod
    async def _fetch_schedule_day(client: httpx.AsyncClient, day: str) -> Optional[List[Dict[str, Any]]]:
        started_at = time.perf_counter()
        try:
            response = await client.get(
                f"{settings.WORLDCUP_SCHEDULE_API_BASE}/scoreboard",
                params={"dates": day},
            )
            response.raise_for_status()
            payload = response.json()
            events = payload.get("events")
            if isinstance(events, list):
                logger.info(
                    "worldcup.schedule_day day=%s events=%s elapsed_ms=%.2f",
                    day,
                    len(events),
                    (time.perf_counter() - started_at) * 1000,
                )
                return events
        except Exception as exc:
            logger.warning(
                "worldcup.schedule_day day=%s failed=%s detail=%s elapsed_ms=%.2f",
                day,
                exc.__class__.__name__,
                exc,
                (time.perf_counter() - started_at) * 1000,
            )
            return None
        logger.warning(
            "worldcup.schedule_day day=%s empty_payload elapsed_ms=%.2f",
            day,
            (time.perf_counter() - started_at) * 1000,
        )
        return []

    @staticmethod
    async def _fetch_polymarket_events(refresh: bool = False) -> List[Dict[str, Any]]:
        started_at = time.perf_counter()
        now = datetime.now(timezone.utc)
        logger.info(
            "worldcup.polymarket_cache begin refresh=%s memory_events=%s redis_key=%s",
            refresh,
            len(_polymarket_cache["events"]),
            WorldCupService._polymarket_cache_key,
        )
        expires_at = _polymarket_cache["expires_at"]
        if not refresh and expires_at and expires_at > now:
            logger.info(
                "worldcup.polymarket_cache hit=memory events=%s elapsed_ms=%.2f",
                len(_polymarket_cache["events"]),
                (time.perf_counter() - started_at) * 1000,
            )
            return deepcopy(_polymarket_cache["events"])

        if not refresh:
            redis_started_at = time.perf_counter()
            cached_events = await WorldCupService._get_cached_json(WorldCupService._polymarket_cache_key)
            logger.info(
                "worldcup.polymarket_cache redis_lookup hit=%s elapsed_ms=%.2f",
                bool(cached_events),
                (time.perf_counter() - redis_started_at) * 1000,
            )
            if cached_events:
                _polymarket_cache["events"] = deepcopy(cached_events)
                _polymarket_cache["expires_at"] = now + timedelta(seconds=settings.WORLDCUP_SCHEDULE_CACHE_SECONDS)
                logger.info(
                    "worldcup.polymarket_cache hit=redis events=%s elapsed_ms=%.2f",
                    len(cached_events),
                    (time.perf_counter() - started_at) * 1000,
                )
                return cached_events

        try:
            fetch_started_at = time.perf_counter()
            async with httpx.AsyncClient(**WorldCupService._polymarket_client_kwargs()) as client:
                response = await client.get(
                    f"{settings.WORLDCUP_POLYMARKET_API_BASE}/events",
                    params={
                        "closed": "false",
                        "limit": settings.WORLDCUP_POLYMARKET_LIMIT,
                        "tag_slug": "fifa-world-cup",
                    },
                )
                response.raise_for_status()
                logger.info(
                    "worldcup.polymarket_http status=%s content_type=%s url=%s",
                    response.status_code,
                    response.headers.get("content-type"),
                    str(response.request.url),
                )
                payload = response.json()
                if isinstance(payload, list):
                    _polymarket_cache["events"] = deepcopy(payload)
                    _polymarket_cache["expires_at"] = now + timedelta(seconds=settings.WORLDCUP_SCHEDULE_CACHE_SECONDS)
                    logger.info(
                        "worldcup.polymarket_fetch events=%s sample_event_id=%s elapsed_ms=%.2f",
                        len(payload),
                        payload[0].get("id") if payload and isinstance(payload[0], dict) else None,
                        (time.perf_counter() - fetch_started_at) * 1000,
                    )
                    redis_store_started_at = time.perf_counter()
                    await WorldCupService._set_cached_json(
                        WorldCupService._polymarket_cache_key,
                        payload,
                        settings.WORLDCUP_SCHEDULE_CACHE_SECONDS,
                    )
                    logger.info(
                        "worldcup.polymarket_cache store=redis events=%s elapsed_ms=%.2f total_elapsed_ms=%.2f",
                        len(payload),
                        (time.perf_counter() - redis_store_started_at) * 1000,
                        (time.perf_counter() - started_at) * 1000,
                    )
                    return payload
                logger.warning(
                    "worldcup.polymarket_fetch unexpected_payload_type=%s body_preview=%s elapsed_ms=%.2f",
                    type(payload).__name__,
                    str(payload)[:300],
                    (time.perf_counter() - fetch_started_at) * 1000,
                )
        except json.JSONDecodeError as exc:
            logger.warning(
                "worldcup.polymarket_fetch failed=json_decode detail=%s elapsed_ms=%.2f",
                exc,
                (time.perf_counter() - started_at) * 1000,
            )
            return []
        except Exception as exc:
            logger.warning(
                "worldcup.polymarket_fetch failed=%s detail=%s elapsed_ms=%.2f",
                exc.__class__.__name__,
                exc,
                (time.perf_counter() - started_at) * 1000,
            )
            return []
        logger.warning(
            "worldcup.polymarket_fetch empty_result elapsed_ms=%.2f",
            (time.perf_counter() - started_at) * 1000,
        )
        return []

    @staticmethod
    def _polymarket_client_kwargs() -> Dict[str, Any]:
        kwargs: Dict[str, Any] = {"timeout": 10.0}
        proxy_url = WorldCupService._polymarket_proxy_url()
        if proxy_url:
            kwargs["proxy"] = proxy_url
            logger.info("worldcup.polymarket_proxy enabled=true proxy=%s", proxy_url)
        else:
            logger.info("worldcup.polymarket_proxy enabled=false")
        return kwargs

    @staticmethod
    def _polymarket_proxy_url() -> str:
        if not settings.WORLDCUP_POLYMARKET_USE_PROXY:
            return ""
        if settings.WORLDCUP_POLYMARKET_PROXY_URL:
            return settings.WORLDCUP_POLYMARKET_PROXY_URL
        if settings.AKSHARE_USE_PROXY and settings.AKSHARE_PROXY_URL:
            return settings.AKSHARE_PROXY_URL
        return ""

    @classmethod
    def _get_redis_url(cls) -> str:
        parsed = urlparse(settings.CELERY_BROKER_URL)
        if parsed.scheme.startswith("redis"):
            return settings.CELERY_BROKER_URL
        return settings.CELERY_RESULT_BACKEND

    @classmethod
    def _get_redis_client(cls) -> redis_asyncio.Redis:
        if cls._redis_client is None:
            cls._redis_client = redis_asyncio.from_url(
                cls._get_redis_url(),
                decode_responses=True,
            )
        return cls._redis_client

    @classmethod
    async def _get_cached_json(cls, key: str) -> Optional[List[Dict[str, Any]]]:
        started_at = time.perf_counter()
        try:
            payload = await cls._get_redis_client().get(key)
            if not payload:
                if key == cls._polymarket_cache_key:
                    logger.info(
                        "worldcup.redis_get key=%s hit=false elapsed_ms=%.2f",
                        key,
                        (time.perf_counter() - started_at) * 1000,
                    )
                return None
            parsed = json.loads(payload)
            if isinstance(parsed, list):
                if key == cls._polymarket_cache_key:
                    logger.info(
                        "worldcup.redis_get key=%s hit=true size=%s elapsed_ms=%.2f",
                        key,
                        len(parsed),
                        (time.perf_counter() - started_at) * 1000,
                    )
                return parsed
            if key == cls._polymarket_cache_key:
                logger.warning(
                    "worldcup.redis_get key=%s unexpected_type=%s elapsed_ms=%.2f",
                    key,
                    type(parsed).__name__,
                    (time.perf_counter() - started_at) * 1000,
                )
        except Exception as exc:
            if key == cls._polymarket_cache_key:
                logger.warning(
                    "worldcup.redis_get key=%s failed=%s elapsed_ms=%.2f",
                    key,
                    exc.__class__.__name__,
                    (time.perf_counter() - started_at) * 1000,
                )
            return None
        return None

    @classmethod
    async def _set_cached_json(cls, key: str, value: List[Dict[str, Any]], ttl_seconds: int) -> None:
        started_at = time.perf_counter()
        try:
            await cls._get_redis_client().set(
                key,
                json.dumps(value, ensure_ascii=False),
                ex=ttl_seconds,
            )
            if key == cls._polymarket_cache_key:
                logger.info(
                    "worldcup.redis_set key=%s size=%s ttl=%s elapsed_ms=%.2f",
                    key,
                    len(value),
                    ttl_seconds,
                    (time.perf_counter() - started_at) * 1000,
                )
        except Exception as exc:
            if key == cls._polymarket_cache_key:
                logger.warning(
                    "worldcup.redis_set key=%s failed=%s elapsed_ms=%.2f",
                    key,
                    exc.__class__.__name__,
                    (time.perf_counter() - started_at) * 1000,
                )
            return None

    @classmethod
    async def _get_bankroll_ledger(cls) -> List[Dict[str, Any]]:
        try:
            payload = await cls._get_redis_client().get(cls._bankroll_ledger_key)
            if payload:
                parsed = json.loads(payload)
                if isinstance(parsed, list):
                    _bankroll_ledger_cache["bets"] = deepcopy(parsed)
                    return deepcopy(parsed)
        except Exception:
            pass
        return deepcopy(_bankroll_ledger_cache["bets"])

    @classmethod
    async def _set_bankroll_ledger(cls, ledger: List[Dict[str, Any]]) -> None:
        _bankroll_ledger_cache["bets"] = deepcopy(ledger)
        try:
            await cls._get_redis_client().set(
                cls._bankroll_ledger_key,
                json.dumps(ledger, ensure_ascii=False),
            )
        except Exception:
            return None

    @classmethod
    async def _get_cached_object(cls, key: str) -> Optional[Dict[str, Any]]:
        try:
            payload = await cls._get_redis_client().get(key)
            if not payload:
                return None
            parsed = json.loads(payload)
            return parsed if isinstance(parsed, dict) else None
        except Exception:
            return None

    @classmethod
    async def _set_cached_object(cls, key: str, value: Dict[str, Any], ttl_seconds: int) -> None:
        try:
            await cls._get_redis_client().set(
                key,
                json.dumps(value, ensure_ascii=False),
                ex=ttl_seconds,
            )
        except Exception:
            return None

    @classmethod
    async def clear_cached_worldcup_data(cls) -> None:
        _polymarket_cache["events"] = []
        _polymarket_cache["expires_at"] = None
        _bankroll_ledger_cache["bets"] = []
        _ai_analysis_cache.clear()
        try:
            redis_client = cls._get_redis_client()
            await redis_client.delete(
                cls._polymarket_cache_key,
                cls._bankroll_ledger_key,
                cls._matches_index_key,
                cls._match_dates_index_key,
            )
            match_keys = [key async for key in redis_client.scan_iter(match=f"{cls._match_key_prefix}*")]
            if match_keys:
                await redis_client.delete(*match_keys)
            date_keys = [key async for key in redis_client.scan_iter(match=f"{cls._match_date_key_prefix}*")]
            if date_keys:
                await redis_client.delete(*date_keys)
            ai_keys = [key async for key in redis_client.scan_iter(match=f"{cls._ai_analysis_cache_key_prefix}*")]
            if ai_keys:
                await redis_client.delete(*ai_keys)
        except Exception:
            return None

    @staticmethod
    def _map_espn_event(event: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        competitions = event.get("competitions") or []
        if not competitions:
            return None

        competition = competitions[0]
        competitors = competition.get("competitors") or []
        home = next((item for item in competitors if item.get("homeAway") == "home"), None)
        away = next((item for item in competitors if item.get("homeAway") == "away"), None)
        if not home or not away:
            return None

        home_team = (home.get("team") or {}).get("displayName") or (home.get("team") or {}).get("name")
        away_team = (away.get("team") or {}).get("displayName") or (away.get("team") or {}).get("name")
        if not home_team or not away_team:
            return None

        stage_name = WorldCupService._extract_stage_name(event, competition)
        stage = STAGE_LABELS.get(stage_name, stage_name)
        group_name = WorldCupService._extract_group_name(competition.get("altGameNote"))
        links = event.get("links") or []
        odds = (competition.get("odds") or [])
        home_context = WorldCupService._extract_team_context(home, "home")
        away_context = WorldCupService._extract_team_context(away, "away")

        match = {
            "match_id": str(event.get("id")),
            "stage": stage,
            "group_name": group_name,
            "kickoff_at": event.get("date"),
            "home_team": home_team,
            "away_team": away_team,
            "venue": WorldCupService._extract_venue_name(competition, event),
            "status": WorldCupService._map_status((competition.get("status") or {}).get("type") or {}),
            "home_score": WorldCupService._to_int(home.get("score")),
            "away_score": WorldCupService._to_int(away.get("score")),
            "source": "espn_schedule",
            "external_url": WorldCupService._extract_external_url(links),
            "featured_pick": WorldCupService._pending_pick(),
            "key_market": WorldCupService._pending_market(),
            "markets": [],
            "line_movement": [],
            "polymarket_probabilities": {},
            "bookmaker_quotes": [],
            "team_context": {
                "home": home_context,
                "away": away_context,
            },
            "market_diagnostics": WorldCupService._pending_market_diagnostics(),
            "fundamentals": WorldCupService._pending_fundamentals(),
            "heat_profile": WorldCupService._pending_heat_profile(),
        }
        if isinstance(odds, list):
            WorldCupService._apply_espn_odds_feed(match, odds)
        return match

    @staticmethod
    def _build_phase_breakdown(matches: List[Dict[str, Any]], ledger: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        counts: Dict[str, int] = {}
        performance: Dict[str, Dict[str, float]] = {}
        for match in matches:
            counts[match["stage"]] = counts.get(match["stage"], 0) + 1
        for bet in ledger:
            if not WorldCupService._is_bet_closed(bet):
                continue
            stage = str(bet.get("stage") or "小组赛")
            bucket = performance.setdefault(stage, {"settled": 0.0, "wins": 0.0, "stake": 0.0, "pnl": 0.0})
            bucket["settled"] += 1
            bucket["stake"] += float(bet.get("stake_amount") or 0.0)
            bucket["pnl"] += float(bet.get("pnl") or 0.0)
            if bet.get("status") == "won":
                bucket["wins"] += 1
        ordered_stages = ["小组赛", "32强", "16强", "8强", "半决赛", "季军赛", "决赛"]
        return [
            {
                "phase": stage,
                "matches": counts.get(stage, 0),
                "roi": round(
                    performance.get(stage, {}).get("pnl", 0.0) / performance.get(stage, {}).get("stake", 1.0) * 100,
                    2,
                )
                if performance.get(stage, {}).get("stake")
                else 0.0,
                "hit_rate": round(
                    performance.get(stage, {}).get("wins", 0.0)
                    / performance.get(stage, {}).get("settled", 1.0)
                    * 100,
                    1,
                )
                if performance.get(stage, {}).get("settled")
                else 0.0,
            }
            for stage in ordered_stages
            if counts.get(stage, 0) or performance.get(stage) or stage in {"小组赛", "32强", "16强"}
        ]

    @staticmethod
    async def _sync_bankroll_ledger(matches: List[Dict[str, Any]]) -> None:
        ledger = await WorldCupService._get_bankroll_ledger()
        ledger_by_match = {str(item.get("match_id")): item for item in ledger}
        changed = False

        for match in sorted(matches, key=WorldCupService._sort_match_by_kickoff):
            existing = ledger_by_match.get(match["match_id"])
            if not existing:
                snapshot = WorldCupService._build_bet_snapshot(
                    match,
                    WorldCupService._build_bankroll_summary(ledger)["bankroll"],
                )
                if snapshot:
                    ledger.append(snapshot)
                    ledger_by_match[match["match_id"]] = snapshot
                    existing = snapshot
                    changed = True
            if existing and not isinstance(existing.get("market_snapshot"), dict) and WorldCupService._match_has_real_market_data(match):
                existing["market_snapshot"] = WorldCupService._market_snapshot_from_match(match)
                changed = True
            if existing and WorldCupService._settle_bet_snapshot(existing, match):
                changed = True

        if changed:
            ledger.sort(key=WorldCupService._ledger_sort_key)
            await WorldCupService._set_bankroll_ledger(ledger)

    @staticmethod
    def _build_bet_snapshot(match: Dict[str, Any], bankroll: float) -> Optional[Dict[str, Any]]:
        if not WorldCupService._is_match_ready_to_place(match):
            return None
        featured_pick = match.get("featured_pick") or {}
        bet_type = str(featured_pick.get("bet_type") or "")
        if bet_type not in {"h2h", "asian_handicap", "totals"}:
            return None
        stake_pct = float(featured_pick.get("stake_pct") or 0.0)
        signal_label = str(featured_pick.get("signal_label") or "").strip()
        if stake_pct <= 0 or not signal_label:
            return None
        if featured_pick.get("strategy") in {"待同步", "无优势"}:
            return None
        stake_amount = round(bankroll * stake_pct / 100, 2)
        if stake_amount <= 0:
            return None

        market = WorldCupService._find_market(match, bet_type)
        if not market:
            return None
        option = next((item for item in market.get("options", []) if item.get("label") == signal_label), None)
        if not option:
            return None

        return {
            "match_id": match["match_id"],
            "stage": match["stage"],
            "kickoff_at": match["kickoff_at"],
            "home_team": match["home_team"],
            "away_team": match["away_team"],
            "bet_type": bet_type,
            "side": featured_pick.get("side"),
            "signal_label": signal_label,
            "strategy": featured_pick.get("strategy"),
            "market_line": market.get("line"),
            "odds": float(option.get("odds") or 0.0),
            "stake_pct": stake_pct,
            "stake_amount": round(stake_amount, 2),
            "status": "open",
            "pnl": 0.0,
            "placed_at": datetime.now(timezone.utc).isoformat(),
            "settled_at": None,
            "result_label": None,
            "market_snapshot": WorldCupService._market_snapshot_from_match(match),
        }

    @staticmethod
    def _is_match_ready_to_place(match: Dict[str, Any]) -> bool:
        return WorldCupService._needs_prekick_attention(match, now=datetime.now(timezone.utc))

    @staticmethod
    def _needs_prekick_attention(match: Dict[str, Any], now: datetime) -> bool:
        if match.get("status") in {"live", "settled"}:
            return True
        kickoff_at = str(match.get("kickoff_at") or "")
        if not kickoff_at:
            return False
        try:
            kickoff_dt = datetime.fromisoformat(kickoff_at.replace("Z", "+00:00"))
        except ValueError:
            return False
        return kickoff_dt - PREKICK_ENTRY_WINDOW <= now

    @staticmethod
    def _settle_bet_snapshot(bet: Dict[str, Any], match: Dict[str, Any]) -> bool:
        if WorldCupService._is_bet_closed(bet):
            return False
        if match.get("status") != "settled":
            return False
        home_score = match.get("home_score")
        away_score = match.get("away_score")
        if home_score is None or away_score is None:
            return False

        if home_score > away_score:
            result_label = match["home_team"]
        elif away_score > home_score:
            result_label = match["away_team"]
        else:
            result_label = "平局"

        stake_amount = float(bet.get("stake_amount") or 0.0)
        odds = float(bet.get("odds") or 0.0)
        settlement = WorldCupService._settle_bet_outcome(
            bet=bet,
            match=match,
            home_score=home_score,
            away_score=away_score,
            result_label=result_label,
            stake_amount=stake_amount,
            odds=odds,
        )
        if not settlement:
            return False

        bet["status"] = settlement["status"]
        bet["pnl"] = settlement["pnl"]
        bet["result_label"] = result_label
        bet["settled_at"] = datetime.now(timezone.utc).isoformat()
        return True

    @staticmethod
    def _settle_bet_outcome(
        bet: Dict[str, Any],
        match: Dict[str, Any],
        home_score: int,
        away_score: int,
        result_label: str,
        stake_amount: float,
        odds: float,
    ) -> Optional[Dict[str, Any]]:
        bet_type = str(bet.get("bet_type") or "")
        signal_label = str(bet.get("signal_label") or "")

        if bet_type == "h2h":
            is_win = signal_label == result_label
            return {
                "status": "won" if is_win else "lost",
                "pnl": round(stake_amount * (odds - 1), 2) if is_win else round(-stake_amount, 2),
            }

        if bet_type == "asian_handicap":
            handicap = WorldCupService._extract_line_from_label(signal_label)
            if handicap is None:
                handicap = WorldCupService._to_float(bet.get("market_line"))
            if handicap is None:
                return None
            if signal_label.startswith(match["home_team"]):
                base_score = home_score
                opponent_score = away_score
            elif signal_label.startswith(match["away_team"]):
                base_score = away_score
                opponent_score = home_score
            else:
                return None
            return WorldCupService._settle_split_line_bet(
                stake_amount=stake_amount,
                odds=odds,
                lines=WorldCupService._split_asian_line(handicap),
                evaluator=lambda line: WorldCupService._grade_margin(base_score + line - opponent_score),
            )

        if bet_type == "totals":
            total_line = WorldCupService._extract_line_from_label(signal_label)
            if total_line is None:
                total_line = WorldCupService._to_float(bet.get("market_line"))
            if total_line is None:
                return None
            total_goals = home_score + away_score
            if signal_label.startswith("大"):
                return WorldCupService._settle_split_line_bet(
                    stake_amount=stake_amount,
                    odds=odds,
                    lines=WorldCupService._split_asian_line(total_line),
                    evaluator=lambda line: WorldCupService._grade_margin(total_goals - line),
                )
            if signal_label.startswith("小"):
                return WorldCupService._settle_split_line_bet(
                    stake_amount=stake_amount,
                    odds=odds,
                    lines=WorldCupService._split_asian_line(total_line),
                    evaluator=lambda line: WorldCupService._grade_margin(line - total_goals),
                )
            return None

        return None

    @staticmethod
    def _settle_split_line_bet(
        stake_amount: float,
        odds: float,
        lines: List[float],
        evaluator: Any,
    ) -> Dict[str, Any]:
        if not lines:
            return {"status": "void", "pnl": 0.0}
        stake_per_leg = stake_amount / len(lines)
        pnl = 0.0
        results: List[str] = []
        for line in lines:
            grade = evaluator(line)
            results.append(grade)
            if grade == "win":
                pnl += stake_per_leg * (odds - 1)
            elif grade == "loss":
                pnl -= stake_per_leg

        rounded_pnl = round(pnl, 2)
        if all(item == "push" for item in results):
            status = "push"
        elif rounded_pnl > 0:
            status = "won"
        elif rounded_pnl < 0:
            status = "lost"
        else:
            status = "push"
        return {"status": status, "pnl": rounded_pnl}

    @staticmethod
    def _split_asian_line(line: float) -> List[float]:
        scaled = int(round(line * 100))
        remainder = abs(scaled) % 100
        if remainder in {25, 75}:
            return [round(line - 0.25, 2), round(line + 0.25, 2)]
        return [round(line, 2)]

    @staticmethod
    def _grade_margin(margin: float) -> str:
        if margin > 0:
            return "win"
        if margin < 0:
            return "loss"
        return "push"

    @staticmethod
    def _extract_line_from_label(label: str) -> Optional[float]:
        matched = re.search(r"([+-]?\d+(?:\.\d+)?)\s*$", label.strip())
        if not matched:
            return None
        return WorldCupService._to_float(matched.group(1))

    @staticmethod
    def _build_bankroll_summary(ledger: List[Dict[str, Any]]) -> Dict[str, Any]:
        settled_bets = [bet for bet in ledger if WorldCupService._is_bet_closed(bet)]
        open_bets = [bet for bet in ledger if bet.get("status") == "open"]
        settled_bets.sort(key=WorldCupService._ledger_sort_key)

        bankroll = INITIAL_BANKROLL
        peak = INITIAL_BANKROLL
        max_drawdown = 0.0
        bankroll_curve = [{"label": "初始", "bankroll": INITIAL_BANKROLL, "pnl": 0.0}]

        for bet in settled_bets:
            bankroll = round(bankroll + float(bet.get("pnl") or 0.0), 2)
            peak = max(peak, bankroll)
            if peak > 0:
                max_drawdown = min(max_drawdown, (bankroll - peak) / peak * 100)
            bankroll_curve.append(
                {
                    "label": WorldCupService._curve_label(bet),
                    "bankroll": bankroll,
                    "pnl": round(bankroll - INITIAL_BANKROLL, 2),
                }
            )

        if len(bankroll_curve) == 1:
            bankroll_curve.append({"label": "当前", "bankroll": INITIAL_BANKROLL, "pnl": 0.0})

        realized_pnl = round(bankroll - INITIAL_BANKROLL, 2)
        return {
            "bankroll": bankroll,
            "roi": round(realized_pnl / INITIAL_BANKROLL * 100, 2),
            "max_drawdown": round(max_drawdown, 2),
            "settled_matches": len(settled_bets),
            "open_positions": len(open_bets),
            "bankroll_curve": bankroll_curve,
        }

    @staticmethod
    def _curve_label(bet: Dict[str, Any]) -> str:
        kickoff_at = str(bet.get("kickoff_at") or "")
        try:
            dt = datetime.fromisoformat(kickoff_at.replace("Z", "+00:00"))
            prefix = dt.strftime("%m-%d")
        except ValueError:
            prefix = "结算"
        return f'{prefix} {bet.get("home_team", "")} vs {bet.get("away_team", "")}'.strip()

    @staticmethod
    def _ledger_sort_key(bet: Dict[str, Any]) -> tuple[str, str]:
        return (str(bet.get("kickoff_at") or ""), str(bet.get("match_id") or ""))

    @staticmethod
    def _is_bet_closed(bet: Dict[str, Any]) -> bool:
        return str(bet.get("status") or "") in {"won", "lost", "push", "void"}

    @staticmethod
    def _serialize_bankroll_bet(bet: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
        if not bet:
            return None
        return {
            "bet_type": bet.get("bet_type"),
            "side": bet.get("side"),
            "signal_label": bet.get("signal_label"),
            "strategy": bet.get("strategy"),
            "odds": bet.get("odds"),
            "stake_pct": bet.get("stake_pct"),
            "stake_amount": bet.get("stake_amount"),
            "status": bet.get("status"),
            "pnl": bet.get("pnl"),
            "placed_at": bet.get("placed_at"),
            "settled_at": bet.get("settled_at"),
            "result_label": bet.get("result_label"),
        }

    @staticmethod
    async def _get_ai_analysis(match: Dict[str, Any], refresh: bool = False) -> Dict[str, Any]:
        cache_key = f'{WorldCupService._ai_analysis_cache_key_prefix}{match["match_id"]}'
        if not refresh and match["match_id"] in _ai_analysis_cache:
            return deepcopy(_ai_analysis_cache[match["match_id"]])
        if not refresh:
            cached = await WorldCupService._get_cached_object(cache_key)
            if cached:
                _ai_analysis_cache[match["match_id"]] = deepcopy(cached)
                return cached

        analysis = await WorldCupService._generate_ai_analysis(match)
        _ai_analysis_cache[match["match_id"]] = deepcopy(analysis)
        await WorldCupService._set_cached_object(cache_key, analysis, 6 * 60 * 60)
        return analysis

    @staticmethod
    async def _get_cached_ai_analysis(match: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        cache_key = f'{WorldCupService._ai_analysis_cache_key_prefix}{match["match_id"]}'
        if match["match_id"] in _ai_analysis_cache:
            return deepcopy(_ai_analysis_cache[match["match_id"]])
        cached = await WorldCupService._get_cached_object(cache_key)
        if cached:
            _ai_analysis_cache[match["match_id"]] = deepcopy(cached)
            return cached
        return None

    @staticmethod
    async def _generate_ai_analysis(match: Dict[str, Any]) -> Dict[str, Any]:
        client = LLMRegistry.get_client(LLMProfileName.RESEARCH)
        if not client.api_key:
            raise RuntimeError("未配置 AI 分析模型或 API Key")
        prompt = WorldCupService._worldcup_ai_prompt(match)
        try:
            response = await client.chat_completion(
                messages=[
                    {
                        "role": "system",
                        "content": (
                            "你是专业足球盘口分析师。你只能基于用户提供的结构化市场数据进行解释，"
                            "不能杜撰伤停、新闻或历史事实。输出必须是 JSON。"
                        ),
                    },
                    {"role": "user", "content": prompt},
                ],
                temperature=0.2,
                max_tokens=700,
            )
        except Exception as exc:
            raise RuntimeError(f"AI 分析请求失败: {exc}") from exc

        content = (response.get("choices", [{}])[0].get("message", {}) or {}).get("content")
        if isinstance(content, list):
            content = "".join(
                part.get("text", "") for part in content if isinstance(part, dict)
            )
        parsed = WorldCupService._parse_ai_analysis_content(content or "")
        if not parsed:
            raise RuntimeError("AI 分析返回内容无法解析为有效 JSON")
        parsed["source"] = "llm"
        parsed["generated_at"] = datetime.now(timezone.utc).isoformat()
        return parsed

    @staticmethod
    def _parse_ai_analysis_content(content: str) -> Optional[Dict[str, Any]]:
        text = content.strip()
        if text.startswith("```"):
            matched = re.search(r"```(?:json)?\s*(.*?)\s*```", text, re.DOTALL)
            if matched:
                text = matched.group(1).strip()
        try:
            parsed = json.loads(text)
        except json.JSONDecodeError:
            return None
        if not isinstance(parsed, dict):
            return None
        risk_flags = parsed.get("risk_flags")
        if not isinstance(risk_flags, list):
            risk_flags = []
        return {
            "summary": str(parsed.get("summary") or "").strip() or None,
            "bull_case": str(parsed.get("bull_case") or "").strip() or None,
            "bear_case": str(parsed.get("bear_case") or "").strip() or None,
            "market_note": str(parsed.get("market_note") or "").strip() or None,
            "confidence_note": str(parsed.get("confidence_note") or "").strip() or None,
            "risk_flags": [str(item) for item in risk_flags if str(item).strip()],
        }

    @staticmethod
    def _worldcup_ai_prompt(match: Dict[str, Any]) -> str:
        featured_pick = match.get("featured_pick") or {}
        markets = []
        for market in match.get("markets", []):
            markets.append(
                {
                    "market_type": market.get("market_type"),
                    "title": market.get("title"),
                    "line": market.get("line"),
                    "options": market.get("options"),
                }
            )
        payload = {
            "match": {
                "home_team": match.get("home_team"),
                "away_team": match.get("away_team"),
                "stage": match.get("stage"),
                "status": match.get("status"),
                "kickoff_at": match.get("kickoff_at"),
            },
            "featured_pick": featured_pick,
            "polymarket_probabilities": match.get("polymarket_probabilities"),
            "markets": markets,
            "market_diagnostics": match.get("market_diagnostics"),
            "fundamentals": match.get("fundamentals"),
            "heat_profile": match.get("heat_profile"),
            "bankroll_bet": match.get("bankroll_bet"),
        }
        return (
            "请基于以下世界杯比赛结构化数据，输出一个 JSON 对象，字段必须包含："
            "summary, bull_case, bear_case, market_note, confidence_note, risk_flags。"
            "risk_flags 必须是字符串数组。不要输出 markdown。\n\n"
            f"{json.dumps(payload, ensure_ascii=False)}"
        )

    @staticmethod
    def _extract_stage_name(event: Dict[str, Any], competition: Dict[str, Any]) -> str:
        season = event.get("season") or {}
        if isinstance(season, dict):
            season_type = season.get("type")
            if isinstance(season_type, dict):
                name = season_type.get("name")
                if isinstance(name, str) and name:
                    return name

        note = competition.get("altGameNote")
        if isinstance(note, str):
            if "Group" in note:
                return "Group Stage"
            if "Round of 32" in note:
                return "Round of 32"
            if "Round of 16" in note:
                return "Round of 16"
            if "Quarterfinal" in note:
                return "Quarterfinals"
            if "Semifinal" in note:
                return "Semifinals"
            if "3rd-Place" in note or "Third-Place" in note:
                return "3rd-Place Match"
            if note.strip().endswith("Final"):
                return "Final"

        return "Group Stage"

    @staticmethod
    def _extract_group_name(note: Optional[str]) -> Optional[str]:
        if not note:
            return None
        matched = re.search(r"Group\s+([A-L])", note, re.IGNORECASE)
        if matched:
            return f"{matched.group(1).upper()}组"
        return None

    @staticmethod
    def _map_status(status_type: Dict[str, Any]) -> str:
        state = status_type.get("state")
        if state == "post":
            return "settled"
        if state == "in":
            return "live"
        return "upcoming"

    @staticmethod
    def _pending_pick() -> Dict[str, Any]:
        return {
            "decision": "pass",
            "bet_type": "h2h",
            "strategy": "待同步",
            "side": "等待赔率同步",
            "signal_label": None,
            "signal_tier": None,
            "signal_grade": None,
            "warning_message": None,
            "book_probability": None,
            "fair_probability": None,
            "confidence": 0,
            "edge": 0.0,
            "stake_pct": 0.0,
            "stake_amount": 0.0,
            "rationale": [
                "已接入真实世界杯赛程。",
                "当前比赛的赔率/预测市场尚未完成同步。",
                "接入更多盘口后再生成正式推荐。",
            ],
        }

    @staticmethod
    def _pending_market() -> Dict[str, Any]:
        return {
            "market_type": "polymarket",
            "title": "待同步市场",
            "line": None,
            "options": [],
        }

    @staticmethod
    def _pending_market_diagnostics() -> Dict[str, Any]:
        return {
            "theoretical_handicap": None,
            "actual_handicap": None,
            "opening_handicap": None,
            "theoretical_home_water": None,
            "theoretical_away_water": None,
            "opening_home_water": None,
            "opening_away_water": None,
            "actual_home_water": None,
            "actual_away_water": None,
            "favorite_team": None,
            "favorite_side": None,
            "underdog_side": None,
            "pricing_signal": "unknown",
            "line_delta": None,
            "line_move_delta": None,
            "movement_signal": None,
            "consensus_score": 0,
            "consensus_pass": False,
            "consensus_notes": [
                "当前盘口诊断待更多机构与基础面数据补全。",
            ],
        }

    @staticmethod
    def _pending_fundamentals() -> Dict[str, Any]:
        return {
            "score": 50,
            "data_quality": "pending",
            "support_level": "unknown",
            "recent_form_score": 50,
            "motivation_score": 50,
            "squad_health_score": 50,
            "venue_fit_score": 50,
            "pedigree_score": 50,
            "head_to_head_score": 50,
            "summary_tags": [
                "当前版本以盘口数据为主，基础面因子待接入真实近况与伤停数据。",
            ],
        }

    @staticmethod
    def _pending_heat_profile() -> Dict[str, Any]:
        return {
            "trap_type": None,
            "heat_flags": [],
            "cold_flags": [],
        }

    @staticmethod
    def _match_polymarket_event(match: Dict[str, Any], events: List[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
        home_aliases = WorldCupService._team_aliases(match["home_team"])
        away_aliases = WorldCupService._team_aliases(match["away_team"])

        for event in events:
            teams = event.get("teams")
            if isinstance(teams, list):
                event_team_names = [
                    WorldCupService._normalize_text(str(team.get("name", "")))
                    for team in teams
                    if isinstance(team, dict) and team.get("name")
                ]
                if any(alias == team_name for alias in home_aliases for team_name in event_team_names) and any(
                    alias == team_name for alias in away_aliases for team_name in event_team_names
                ):
                    return event
            haystack = WorldCupService._normalize_text(
                " ".join(str(event.get(field, "")) for field in ("title", "slug", "description", "ticker"))
            )
            if any(alias in haystack for alias in home_aliases) and any(alias in haystack for alias in away_aliases):
                return event
        return None

    @staticmethod
    def _team_aliases(team_name: str) -> List[str]:
        base = WorldCupService._normalize_text(team_name)
        aliases = [base]
        aliases.extend(WorldCupService._normalize_text(item) for item in TEAM_ALIASES.get(team_name, []))
        return [alias for alias in aliases if alias]

    @staticmethod
    def _normalize_text(value: str) -> str:
        normalized = re.sub(r"[^a-z0-9]+", " ", value.lower())
        return re.sub(r"\s+", " ", normalized).strip()

    @staticmethod
    def _team_names_match(left: Optional[str], right: Optional[str]) -> bool:
        if not left or not right:
            return False
        left_aliases = set(WorldCupService._team_aliases(str(left)))
        right_aliases = set(WorldCupService._team_aliases(str(right)))
        return bool(left_aliases & right_aliases)

    @staticmethod
    def _extract_market_from_event(event: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        markets = event.get("markets")
        if not isinstance(markets, list) or not markets:
            return None

        sports_market = WorldCupService._extract_soccer_event_market(event, markets)
        if sports_market:
            return sports_market

        market = markets[0]
        outcomes = WorldCupService._json_list(market.get("outcomes"))
        prices = WorldCupService._json_list(market.get("outcomePrices"))
        if not outcomes or not prices:
            return None

        options = []
        for label, raw_prob in zip(outcomes[:3], prices[:3]):
            try:
                probability = float(raw_prob)
            except (TypeError, ValueError):
                continue
            if probability <= 0:
                continue
            options.append(
                {
                    "label": str(label),
                    "odds": round(1 / probability, 2),
                    "probability": probability,
                }
            )

        if not options:
            return None

        return {
            "market_type": "polymarket",
            "title": event.get("title") or market.get("question") or "Polymarket",
            "line": None,
            "options": options,
        }

    @staticmethod
    def _extract_soccer_event_market(event: Dict[str, Any], markets: List[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
        teams = event.get("teams")
        if not isinstance(teams, list) or len(teams) < 2:
            return None

        home_team = next(
            (
                str(team.get("name"))
                for team in teams
                if isinstance(team, dict) and str(team.get("ordering", "")).lower() == "home" and team.get("name")
            ),
            None,
        )
        away_team = next(
            (
                str(team.get("name"))
                for team in teams
                if isinstance(team, dict) and str(team.get("ordering", "")).lower() == "away" and team.get("name")
            ),
            None,
        )
        if not home_team or not away_team:
            return None

        raw_probabilities: Dict[str, float] = {}
        home_aliases = WorldCupService._team_aliases(home_team)
        away_aliases = WorldCupService._team_aliases(away_team)

        for market in markets:
            if not isinstance(market, dict):
                continue
            probability = WorldCupService._extract_binary_yes_probability(market)
            if probability is None:
                continue

            text = WorldCupService._normalize_text(
                " ".join(
                    str(market.get(field, ""))
                    for field in ("question", "groupItemTitle", "slug", "description")
                )
            )
            if any(alias in text for alias in home_aliases):
                raw_probabilities[home_team] = probability
                continue
            if any(alias in text for alias in away_aliases):
                raw_probabilities[away_team] = probability
                continue
            if "draw" in text or "tie" in text:
                raw_probabilities["平局"] = probability

        if len(raw_probabilities) < 2:
            return None

        total_probability = sum(raw_probabilities.values())
        if total_probability <= 0:
            return None

        options = []
        for label, probability in raw_probabilities.items():
            normalized_probability = probability / total_probability
            if normalized_probability <= 0:
                continue
            options.append(
                {
                    "label": label,
                    "odds": round(1 / normalized_probability, 2),
                    "probability": round(normalized_probability, 4),
                }
            )

        if not options:
            return None

        preferred_order = {home_team: 0, "平局": 1, away_team: 2}
        options.sort(key=lambda item: preferred_order.get(item["label"], 9))
        return {
            "market_type": "polymarket",
            "title": event.get("title") or "Polymarket",
            "line": None,
            "options": options,
        }

    @staticmethod
    def _extract_binary_yes_probability(market: Dict[str, Any]) -> Optional[float]:
        prices = WorldCupService._json_list(market.get("outcomePrices"))
        if prices:
            try:
                probability = float(prices[0])
            except (TypeError, ValueError):
                probability = None
            if probability is not None and probability > 0:
                return probability

        for field in ("lastTradePrice", "bestBid", "bestAsk"):
            try:
                probability = float(market.get(field))
            except (TypeError, ValueError):
                continue
            if probability > 0:
                return probability
        return None

    @staticmethod
    def _json_list(value: Any) -> List[Any]:
        if isinstance(value, list):
            return value
        if isinstance(value, str):
            try:
                parsed = json.loads(value)
                if isinstance(parsed, list):
                    return parsed
            except json.JSONDecodeError:
                return []
        return []

    @staticmethod
    def _apply_polymarket_event(match: Dict[str, Any], event: Dict[str, Any]) -> None:
        market = WorldCupService._extract_market_from_event(event)
        if not market:
            return

        match["source"] = "polymarket_live"
        slug = event.get("slug")
        if slug:
            match["external_url"] = f"https://polymarket.com/event/{slug}"
        match["key_market"] = deepcopy(market)
        match["markets"] = [item for item in match["markets"] if item.get("market_type") != "polymarket"]
        match["markets"].append(deepcopy(market))
        match["polymarket_probabilities"] = {
            option["label"]: option["probability"] for option in market["options"]
        }
        WorldCupService._normalize_polymarket_state(match)
        WorldCupService._refresh_featured_pick(match)

    @staticmethod
    def _apply_espn_odds_feed(match: Dict[str, Any], odds_feed: List[Dict[str, Any]]) -> None:
        valid_odds = [item for item in odds_feed if isinstance(item, dict)]
        if not valid_odds:
            return
        match["bookmaker_quotes"] = WorldCupService._build_bookmaker_quotes(match, valid_odds)
        first_valid_odds = valid_odds[0]
        WorldCupService._apply_espn_odds(match, first_valid_odds)

    @staticmethod
    def _apply_espn_odds(match: Dict[str, Any], odds: Dict[str, Any]) -> None:
        if not isinstance(odds, dict):
            return

        markets: List[Dict[str, Any]] = []

        h2h_market = WorldCupService._build_h2h_market(match, odds)
        if h2h_market:
            markets.append(h2h_market)

        spread_market = WorldCupService._build_spread_market(match, odds)
        if spread_market:
            markets.append(spread_market)

        totals_market = WorldCupService._build_totals_market(odds)
        if totals_market:
            markets.append(totals_market)

        if not markets:
            return

        match["markets"] = markets
        match["key_market"] = deepcopy(h2h_market or spread_market or totals_market)
        match["featured_pick"] = {
            "bet_type": "h2h" if h2h_market else "asian_handicap" if spread_market else "totals",
            "side": "待模型生成",
            "signal_tier": None,
            "signal_grade": None,
            "warning_message": None,
            "confidence": 0,
            "edge": 0.0,
            "stake_pct": 0.0,
            "stake_amount": 0.0,
            "rationale": [
                "真实赛程与 DraftKings 赔率已同步。",
                "当前页面先展示市场原始定价，不直接生成投注建议。",
                "下一步可在此基础上接入让球/大小球预测模型。",
            ],
        }
        line_movement = WorldCupService._build_line_movement(odds)
        if line_movement:
            match["line_movement"] = line_movement
        WorldCupService._refresh_featured_pick(match)

    @staticmethod
    def _build_bookmaker_quotes(match: Dict[str, Any], odds_feed: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        quotes: List[Dict[str, Any]] = []
        for odds in odds_feed:
            bookmaker = WorldCupService._extract_bookmaker_name(odds)
            h2h_market = WorldCupService._build_h2h_market(match, odds)
            spread_market = WorldCupService._build_spread_market(match, odds)
            totals_market = WorldCupService._build_totals_market(odds)
            if not h2h_market and not spread_market and not totals_market:
                continue
            quotes.append(
                {
                    "bookmaker": bookmaker,
                    "h2h_market": h2h_market,
                    "spread_market": spread_market,
                    "totals_market": totals_market,
                }
            )
        return quotes

    @staticmethod
    def _extract_bookmaker_name(odds: Dict[str, Any]) -> str:
        provider = odds.get("provider")
        if isinstance(provider, dict):
            for field in ("name", "displayName", "shortName"):
                value = provider.get(field)
                if isinstance(value, str) and value.strip():
                    return value.strip()
        for field in ("provider", "details", "name"):
            value = odds.get(field)
            if isinstance(value, str) and value.strip():
                return value.strip()
        return "ESPN"

    @staticmethod
    def _refresh_featured_pick(match: Dict[str, Any]) -> None:
        h2h_market = WorldCupService._find_market(match, "h2h")
        spread_market = WorldCupService._find_market(match, "asian_handicap")
        totals_market = WorldCupService._find_market(match, "totals")
        if match.get("bookmaker_quotes"):
            match["bookmaker_quotes"] = WorldCupService._decorate_bookmaker_quotes(match)
        diagnostics = WorldCupService._build_market_diagnostics(match, h2h_market, spread_market)
        fundamentals = WorldCupService._build_fundamentals_profile(match, diagnostics)
        heat_profile = WorldCupService._build_heat_profile(match, diagnostics, fundamentals)
        match["market_diagnostics"] = diagnostics
        match["fundamentals"] = fundamentals
        match["heat_profile"] = heat_profile
        recommendation = WorldCupService._build_recommendation(
            match,
            diagnostics,
            fundamentals,
            heat_profile,
            h2h_market,
            spread_market,
            totals_market,
        )
        match["featured_pick"] = recommendation
        market = WorldCupService._find_market(match, recommendation.get("bet_type") or "")
        if market and recommendation.get("signal_label"):
            match["key_market"] = deepcopy(market)

    @staticmethod
    def _build_recommendation(
        match: Dict[str, Any],
        diagnostics: Dict[str, Any],
        fundamentals: Dict[str, Any],
        heat_profile: Dict[str, Any],
        h2h_market: Optional[Dict[str, Any]],
        spread_market: Optional[Dict[str, Any]],
        totals_market: Optional[Dict[str, Any]],
    ) -> Dict[str, Any]:
        if not (h2h_market or spread_market or totals_market):
            return WorldCupService._pending_pick()

        candidate = (
            WorldCupService._build_spread_recommendation(match, diagnostics, fundamentals, heat_profile, spread_market)
            or WorldCupService._build_totals_recommendation(match, diagnostics, totals_market)
            or WorldCupService._build_h2h_recommendation(match, diagnostics, fundamentals, h2h_market)
        )
        if not candidate:
            return WorldCupService._build_pass_pick(diagnostics, fundamentals, heat_profile)

        confidence = WorldCupService._confidence_from_edge(candidate["edge"], candidate.get("strength", 0.0))
        signal_profile = WorldCupService._signal_profile(candidate, confidence)
        stake_pct = signal_profile["stake_pct"]
        return {
            "decision": signal_profile["decision"],
            "bet_type": candidate["bet_type"],
            "strategy": candidate["strategy"],
            "side": candidate["side"],
            "signal_label": candidate.get("signal_label"),
            "signal_tier": signal_profile["signal_tier"],
            "signal_grade": signal_profile["signal_grade"],
            "warning_message": signal_profile["warning_message"],
            "book_probability": candidate.get("book_probability"),
            "fair_probability": candidate.get("fair_probability"),
            "confidence": confidence,
            "edge": round(candidate["edge"] * 100, 2),
            "stake_pct": stake_pct,
            "stake_amount": round(INITIAL_BANKROLL * stake_pct / 100, 2),
            "rationale": candidate["rationale"],
        }

    @staticmethod
    def _build_spread_recommendation(
        match: Dict[str, Any],
        diagnostics: Dict[str, Any],
        fundamentals: Dict[str, Any],
        heat_profile: Dict[str, Any],
        spread_market: Optional[Dict[str, Any]],
    ) -> Optional[Dict[str, Any]]:
        if not spread_market or not spread_market.get("options"):
            return None
        options = {str(option.get("label")): option for option in spread_market.get("options", [])}
        favorite_side = str(diagnostics.get("favorite_side") or "")
        underdog_side = str(diagnostics.get("underdog_side") or "")
        pricing_signal = str(diagnostics.get("pricing_signal") or "")
        consensus_pass = bool(diagnostics.get("consensus_pass"))
        support_level = str(fundamentals.get("support_level") or "")
        trap_type = str(heat_profile.get("trap_type") or "")

        if pricing_signal == "favorite_discounted" and consensus_pass and support_level != "fragile" and favorite_side in options:
            option = options[favorite_side]
            probability = WorldCupService._to_float(option.get("probability")) or 0.0
            strategy = "主推方向" if support_level == "supportive" and fundamentals.get("score", 50) >= 60 else "机构共识"
            return {
                "bet_type": "asian_handicap",
                "strategy": strategy,
                "market_type": "asian_handicap",
                "side": favorite_side,
                "signal_label": favorite_side,
                "book_probability": round(probability, 4),
                "fair_probability": None,
                "edge": max(probability - 0.5, 0.055 if strategy == "主推方向" else 0.04),
                "strength": max(probability, fundamentals.get("score", 50) / 100),
                "rationale": [
                    "多机构理论盘口与实际盘口基本同档，热门方向通过了共识筛选。",
                    "热门一侧实际水位低于理论水位，机构在顺势避险而不是单纯造热。",
                    f"基础面评分 {fundamentals['score']}，近况 {fundamentals['recent_form_score']}，伤停 {fundamentals['squad_health_score']}。",
                ],
            }

        if pricing_signal == "favorite_overpriced" and underdog_side in options:
            option = options[underdog_side]
            probability = WorldCupService._to_float(option.get("probability")) or 0.0
            return {
                "bet_type": "asian_handicap",
                "strategy": "冷门预警",
                "market_type": "asian_handicap",
                "side": underdog_side,
                "signal_label": underdog_side,
                "book_probability": round(probability, 4),
                "fair_probability": None,
                "edge": 0.03 if trap_type in {"fake_deep", "fake_shallow"} else 0.02,
                "strength": probability,
                "rationale": [
                    "热门方向没有得到机构持续防守，实际水位高于理论水位。",
                    "当前更像诱盘或放冷环境，推荐仅作为冷门预警与防守信号。",
                    "这一类方向不与顺势主仓竞争，只保留轻仓或防守用途。",
                ],
            }
        return None

    @staticmethod
    def _build_totals_recommendation(
        match: Dict[str, Any],
        diagnostics: Dict[str, Any],
        totals_market: Optional[Dict[str, Any]],
    ) -> Optional[Dict[str, Any]]:
        if not totals_market or not totals_market.get("options"):
            return None
        if not diagnostics.get("consensus_pass"):
            return None
        strongest_total = max(totals_market["options"], key=lambda item: item["probability"])
        probability = WorldCupService._to_float(strongest_total.get("probability")) or 0.0
        if probability < 0.56:
            return None
        return {
            "bet_type": "totals",
            "strategy": "机构共识",
            "market_type": "totals",
            "side": strongest_total["label"],
            "signal_label": strongest_total["label"],
            "book_probability": round(probability, 4),
            "fair_probability": None,
            "edge": probability - 0.5,
            "strength": probability,
            "rationale": [
                "当前主胜负方向没有形成更优信号，回退为一致性更强的大小球方向。",
                "大小球一侧概率已经显著偏离均衡位，且当前盘口诊断没有出现严重分歧。",
                "这类信号优先作为次级执行方案，不抢占顺势让球单的优先级。",
            ],
        }

    @staticmethod
    def _build_h2h_recommendation(
        match: Dict[str, Any],
        diagnostics: Dict[str, Any],
        fundamentals: Dict[str, Any],
        h2h_market: Optional[Dict[str, Any]],
    ) -> Optional[Dict[str, Any]]:
        if not h2h_market or not h2h_market.get("options"):
            return None
        value_candidate = WorldCupService._aligned_polymarket_value(match, diagnostics, fundamentals, h2h_market)
        if value_candidate:
            return value_candidate
        if not diagnostics.get("consensus_pass"):
            return None
        leader = max(h2h_market["options"], key=lambda item: item["probability"])
        probability = WorldCupService._to_float(leader.get("probability")) or 0.0
        favorite_team = diagnostics.get("favorite_team")
        if probability < 0.5:
            return None
        if favorite_team and leader.get("label") not in {favorite_team, "平局"}:
            return None
        return {
            "bet_type": "h2h",
            "strategy": "市场共识",
            "market_type": "h2h",
            "side": f'{leader["label"]} 胜' if leader["label"] != "平局" else "平局",
            "signal_label": leader["label"],
            "book_probability": round(probability, 4),
            "fair_probability": None,
            "edge": max(probability - 0.48, 0.015),
            "strength": max(probability, fundamentals.get("score", 50) / 100),
            "rationale": [
                "当前没有更强的让球或大小球执行点，回退为与盘口主方向一致的胜平负共识。",
                "该方向只在盘口诊断没有明显反对意见时保留，避免与主方向冲突。",
                "胜平负共识仅作试探信号，不作为高优先级主仓。",
            ],
        }

    @staticmethod
    def _aligned_polymarket_value(
        match: Dict[str, Any],
        diagnostics: Dict[str, Any],
        fundamentals: Dict[str, Any],
        h2h_market: Dict[str, Any],
    ) -> Optional[Dict[str, Any]]:
        if not match.get("polymarket_probabilities"):
            return None
        bookmaker_probs = {option["label"]: option["probability"] for option in h2h_market.get("options", [])}
        polymarket_map = WorldCupService._normalize_probability_labels(match)
        favorite_team = diagnostics.get("favorite_team")
        pricing_signal = str(diagnostics.get("pricing_signal") or "")
        aligned_label: Optional[str] = None
        if favorite_team and pricing_signal != "favorite_overpriced":
            aligned_label = favorite_team
        elif pricing_signal == "favorite_overpriced":
            aligned_label = match["away_team"] if favorite_team == match["home_team"] else match["home_team"]
        if not aligned_label:
            return None

        label_map = {
            match["home_team"]: polymarket_map.get("home"),
            "平局": polymarket_map.get("draw"),
            match["away_team"]: polymarket_map.get("away"),
        }
        poly_prob = label_map.get(aligned_label)
        book_prob = bookmaker_probs.get(aligned_label)
        if poly_prob is None or book_prob is None:
            return None
        edge = poly_prob - book_prob
        if edge < 0.03:
            return None
        if fundamentals.get("support_level") == "fragile" and aligned_label == favorite_team:
            return None
        if pricing_signal == "favorite_discounted" and aligned_label != favorite_team:
            return None
        strategy = "价值单" if pricing_signal != "favorite_overpriced" else "冷门预警"
        rationale = [
            f"Polymarket 对 {aligned_label} 的概率高于传统赔率去水后结果 {edge * 100:.1f} 个百分点。",
            "该价值信号已经与当前盘口主方向完成对齐，不再和盘口诊断冲突。",
            f"基础面评分 {fundamentals['score']}，当前只在不违背主盘口结论时才允许进入主决策层。",
        ]
        return {
            "bet_type": "h2h",
            "strategy": strategy,
            "market_type": "h2h",
            "side": f"{aligned_label} 胜" if aligned_label != "平局" else "平局",
            "signal_label": aligned_label,
            "book_probability": round(book_prob, 4),
            "fair_probability": round(poly_prob, 4),
            "edge": edge,
            "strength": poly_prob,
            "rationale": rationale,
        }

    @staticmethod
    def _build_pass_pick(
        diagnostics: Dict[str, Any],
        fundamentals: Dict[str, Any],
        heat_profile: Dict[str, Any],
    ) -> Dict[str, Any]:
        pick = WorldCupService._pending_pick()
        pick["side"] = "观望"
        pick["decision"] = "pass"
        pick["strategy"] = "无优势"
        pick["warning_message"] = WorldCupService._pass_warning_message(diagnostics, fundamentals, heat_profile)
        pick["rationale"] = [
            "当前推荐引擎已先完成盘口诊断，再决定是否允许进入执行层。",
            f"机构共识评分 {diagnostics['consensus_score']}，基础面评分 {fundamentals['score']}，当前不足以形成清晰主推。",
            "建议等待盘口继续收敛，或补充更完整的基本面与多机构水位数据后再决定。",
        ]
        return pick

    @staticmethod
    def _decorate_bookmaker_quotes(match: Dict[str, Any]) -> List[Dict[str, Any]]:
        decorated: List[Dict[str, Any]] = []
        for quote in match.get("bookmaker_quotes", []):
            if not isinstance(quote, dict):
                continue
            item = deepcopy(quote)
            analysis = WorldCupService._analyze_bookmaker_quote(match, item)
            if analysis:
                item["diagnostics"] = {
                    "theoretical_handicap": WorldCupService._format_theoretical_handicap(
                        analysis["favorite_team"],
                        analysis["theoretical_line"],
                    ),
                    "actual_handicap": (
                        WorldCupService._format_theoretical_handicap(
                            analysis["favorite_team"],
                            analysis["actual_line"],
                        )
                        if analysis.get("actual_line") is not None
                        else None
                    ),
                    "theoretical_home_water": round(1 / analysis["theoretical_home_prob"], 2),
                    "theoretical_away_water": round(1 / analysis["theoretical_away_prob"], 2),
                    "actual_home_water": analysis.get("actual_home_water"),
                    "actual_away_water": analysis.get("actual_away_water"),
                    "pricing_signal": analysis.get("pricing_signal"),
                    "favorite_team": analysis.get("favorite_team"),
                }
            decorated.append(item)
        return decorated

    @staticmethod
    def _build_market_diagnostics(
        match: Dict[str, Any],
        h2h_market: Optional[Dict[str, Any]],
        spread_market: Optional[Dict[str, Any]],
    ) -> Dict[str, Any]:
        diagnostics = WorldCupService._pending_market_diagnostics()
        movement_snapshot = WorldCupService._build_line_movement_snapshot(match)
        bookmaker_quotes = [quote for quote in (match.get("bookmaker_quotes") or []) if isinstance(quote, dict)]
        if bookmaker_quotes:
            multi_bookmaker = WorldCupService._build_multi_bookmaker_diagnostics(match, bookmaker_quotes)
            if multi_bookmaker:
                multi_bookmaker.update(movement_snapshot)
                WorldCupService._append_movement_consensus_notes(multi_bookmaker)
                return multi_bookmaker
        if not h2h_market or not h2h_market.get("options"):
            diagnostics["consensus_notes"] = ["缺少胜平负市场，暂时无法推导理论盘口。"]
            return diagnostics

        probabilities = WorldCupService._extract_h2h_probabilities(match, h2h_market)
        home_prob = probabilities.get("home")
        draw_prob = probabilities.get("draw")
        away_prob = probabilities.get("away")
        if home_prob is None or away_prob is None:
            diagnostics["consensus_notes"] = ["当前胜平负市场不完整，暂时无法推导理论盘口。"]
            return diagnostics

        theoretical = WorldCupService._derive_theoretical_market_line(match, home_prob, draw_prob or 0.0, away_prob)
        favorite_team = str(theoretical["favorite_team"])
        theoretical_line = float(theoretical["theoretical_line"])
        theoretical_home_prob = float(theoretical["theoretical_home_prob"])
        theoretical_away_prob = float(theoretical["theoretical_away_prob"])

        actual_line = WorldCupService._to_float(spread_market.get("line")) if spread_market else None
        actual_home_option = (
            next((option for option in spread_market.get("options", []) if match["home_team"] in str(option.get("label") or "")), None)
            if spread_market
            else None
        )
        actual_away_option = (
            next((option for option in spread_market.get("options", []) if match["away_team"] in str(option.get("label") or "")), None)
            if spread_market
            else None
        )
        actual_home_water = WorldCupService._to_float((actual_home_option or {}).get("odds"))
        actual_away_water = WorldCupService._to_float((actual_away_option or {}).get("odds"))
        line_delta = None
        if actual_line is not None:
            line_delta = round(abs(actual_line - theoretical_line), 2)

        favorite_side = (
            (actual_home_option or {}).get("label")
            if favorite_team == match["home_team"]
            else (actual_away_option or {}).get("label")
        )
        underdog_side = (
            (actual_away_option or {}).get("label")
            if favorite_team == match["home_team"]
            else (actual_home_option or {}).get("label")
        )
        actual_favorite_water = actual_home_water if favorite_team == match["home_team"] else actual_away_water
        theoretical_favorite_water = (
            round(1 / theoretical_home_prob, 2)
            if favorite_team == match["home_team"]
            else round(1 / theoretical_away_prob, 2)
        )
        pricing_signal = "balanced"
        if actual_favorite_water is not None:
            if actual_favorite_water <= theoretical_favorite_water - 0.08:
                pricing_signal = "favorite_discounted"
            elif actual_favorite_water >= theoretical_favorite_water + 0.08:
                pricing_signal = "favorite_overpriced"

        consensus_notes = [
            (
                f"欧转亚理论盘口为 {WorldCupService._format_theoretical_handicap(favorite_team, theoretical_line)}，"
                f"理论水位主/客 {round(1 / theoretical_home_prob, 2)}/{round(1 / theoretical_away_prob, 2)}。"
            ),
        ]
        consensus_score = 35
        if actual_line is not None:
            consensus_notes.append(
                f"当前实际让球为 {WorldCupService._format_theoretical_handicap(favorite_team, actual_line)}。"
            )
            if line_delta is not None and line_delta <= 0.25:
                consensus_score += 30
                consensus_notes.append("理论盘口与实际盘口处于同档或相邻档，机构定价较为稳定。")
            elif line_delta is not None and line_delta <= 0.5:
                consensus_score += 15
                consensus_notes.append("理论盘口与实际盘口略有偏差，需结合水位判断是否人为调节。")
            else:
                consensus_notes.append("理论盘口与实际盘口跳档明显，优先视为信息混乱场。")
        else:
            consensus_notes.append("缺少让球盘口，暂时无法完成欧转亚检验。")

        if spread_market and actual_home_water and actual_away_water:
            if abs(actual_home_water - actual_away_water) <= 0.18:
                consensus_score += 15
                consensus_notes.append("两边水位仍处在可解释区间，未见极端单边挤压。")
            else:
                consensus_notes.append("水位分布已经明显偏斜，需要警惕机构在热门一侧做文章。")

        if pricing_signal == "favorite_discounted":
            consensus_score += 10
            consensus_notes.append("实际热门水位低于理论水位，热门一侧存在真实避险定价。")
        elif pricing_signal == "favorite_overpriced":
            consensus_notes.append("实际热门水位高于理论水位，热门方存在造热或放冷的风险。")
        else:
            consensus_score += 5
            consensus_notes.append("实际水位整体围绕理论值波动，暂未看到明显离谱偏移。")

        consensus_score = max(0, min(100, consensus_score))
        consensus_pass = (
            actual_line is not None
            and line_delta is not None
            and line_delta <= 0.25
            and pricing_signal != "favorite_overpriced"
        )
        diagnostics.update(
            {
                "theoretical_handicap": WorldCupService._format_theoretical_handicap(favorite_team, theoretical_line),
                "actual_handicap": (
                    WorldCupService._format_theoretical_handicap(favorite_team, actual_line)
                    if actual_line is not None
                    else None
                ),
                "theoretical_home_water": round(1 / theoretical_home_prob, 2),
                "theoretical_away_water": round(1 / theoretical_away_prob, 2),
                "actual_home_water": actual_home_water,
                "actual_away_water": actual_away_water,
                "favorite_team": favorite_team,
                "favorite_side": favorite_side,
                "underdog_side": underdog_side,
                "pricing_signal": pricing_signal,
                "line_delta": line_delta,
                "consensus_score": consensus_score,
                "consensus_pass": consensus_pass,
                "consensus_notes": consensus_notes,
            }
        )
        diagnostics.update(movement_snapshot)
        WorldCupService._append_movement_consensus_notes(diagnostics)
        return diagnostics

    @staticmethod
    def _build_multi_bookmaker_diagnostics(match: Dict[str, Any], bookmaker_quotes: List[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
        diagnostics = WorldCupService._pending_market_diagnostics()
        quote_analyses: List[Dict[str, Any]] = []
        for quote in bookmaker_quotes:
            analysis = WorldCupService._analyze_bookmaker_quote(match, quote)
            if analysis:
                quote_analyses.append(analysis)
        if not quote_analyses:
            return None

        favorite_counter: Dict[str, int] = {}
        line_votes: Dict[float, int] = {}
        pricing_counter: Dict[str, int] = {}
        consensus_notes: List[str] = []
        for analysis in quote_analyses:
            favorite_team = str(analysis["favorite_team"])
            favorite_counter[favorite_team] = favorite_counter.get(favorite_team, 0) + 1
            line_votes[analysis["theoretical_line"]] = line_votes.get(analysis["theoretical_line"], 0) + 1
            pricing_counter[analysis["pricing_signal"]] = pricing_counter.get(analysis["pricing_signal"], 0) + 1
            consensus_notes.append(
                f"{analysis['bookmaker']}：理论 {WorldCupService._format_theoretical_handicap(favorite_team, analysis['theoretical_line'])}，"
                f"实际 {WorldCupService._format_theoretical_handicap(favorite_team, analysis['actual_line']) if analysis['actual_line'] is not None else '--'}。"
            )

        favorite_team = max(favorite_counter, key=favorite_counter.get)
        theoretical_line = max(line_votes, key=line_votes.get)
        actual_quotes = [item for item in quote_analyses if item["favorite_team"] == favorite_team]
        actual_lines = [item["actual_line"] for item in actual_quotes if item["actual_line"] is not None]
        actual_line = round(sum(actual_lines) / len(actual_lines), 2) if actual_lines else None
        theoretical_home_probs = [
            item["theoretical_home_prob"] for item in actual_quotes if item.get("theoretical_home_prob") is not None
        ]
        theoretical_away_probs = [
            item["theoretical_away_prob"] for item in actual_quotes if item.get("theoretical_away_prob") is not None
        ]
        actual_home_waters = [item["actual_home_water"] for item in actual_quotes if item.get("actual_home_water") is not None]
        actual_away_waters = [item["actual_away_water"] for item in actual_quotes if item.get("actual_away_water") is not None]
        line_delta = round(abs(actual_line - theoretical_line), 2) if actual_line is not None else None
        pricing_signal = max(pricing_counter, key=pricing_counter.get) if pricing_counter else "balanced"

        consensus_score = 30
        if len(favorite_counter) == 1:
            consensus_score += 20
            consensus_notes.append("多家机构对强势一方判断一致。")
        else:
            consensus_notes.append("多家机构对强势一方存在分歧。")
        if len(line_votes) == 1:
            consensus_score += 20
            consensus_notes.append("理论盘口档位一致。")
        else:
            consensus_notes.append("理论盘口档位存在跳档。")
        if line_delta is not None and line_delta <= 0.25:
            consensus_score += 20
            consensus_notes.append("平均实际盘口与理论盘口仍在同档。")
        elif line_delta is not None and line_delta <= 0.5:
            consensus_score += 10
            consensus_notes.append("平均实际盘口与理论盘口存在半档偏差。")
        else:
            consensus_notes.append("平均实际盘口与理论盘口偏差明显。")
        if pricing_signal == "favorite_discounted":
            consensus_score += 10
            consensus_notes.append("多家机构在热门一侧共同压低水位。")
        elif pricing_signal == "balanced":
            consensus_score += 5
            consensus_notes.append("多家机构水位总体围绕理论值波动。")
        else:
            consensus_notes.append("多家机构未显著防守热门，热门一侧有造热风险。")

        consensus_score = max(0, min(100, consensus_score))
        consensus_pass = (
            len(quote_analyses) >= 3
            and len(favorite_counter) == 1
            and len(line_votes) == 1
            and line_delta is not None
            and line_delta <= 0.25
            and pricing_signal != "favorite_overpriced"
        )
        favorite_side = next((item.get("favorite_side") for item in actual_quotes if item.get("favorite_side")), None)
        underdog_side = next((item.get("underdog_side") for item in actual_quotes if item.get("underdog_side")), None)
        diagnostics.update(
            {
                "theoretical_handicap": WorldCupService._format_theoretical_handicap(favorite_team, theoretical_line),
                "actual_handicap": (
                    WorldCupService._format_theoretical_handicap(favorite_team, actual_line)
                    if actual_line is not None
                    else None
                ),
                "theoretical_home_water": (
                    round(1 / (sum(theoretical_home_probs) / len(theoretical_home_probs)), 2)
                    if theoretical_home_probs
                    else None
                ),
                "theoretical_away_water": (
                    round(1 / (sum(theoretical_away_probs) / len(theoretical_away_probs)), 2)
                    if theoretical_away_probs
                    else None
                ),
                "actual_home_water": round(sum(actual_home_waters) / len(actual_home_waters), 2) if actual_home_waters else None,
                "actual_away_water": round(sum(actual_away_waters) / len(actual_away_waters), 2) if actual_away_waters else None,
                "favorite_team": favorite_team,
                "favorite_side": favorite_side,
                "underdog_side": underdog_side,
                "pricing_signal": pricing_signal,
                "line_delta": line_delta,
                "consensus_score": consensus_score,
                "consensus_pass": consensus_pass,
                "consensus_notes": consensus_notes,
            }
        )
        return diagnostics

    @staticmethod
    def _build_line_movement_snapshot(match: Dict[str, Any]) -> Dict[str, Any]:
        movement = match.get("line_movement") or []
        if not isinstance(movement, list) or not movement:
            return {
                "opening_handicap": None,
                "opening_home_water": None,
                "opening_away_water": None,
                "line_move_delta": None,
                "movement_signal": None,
            }
        opening = next((item for item in movement if str(item.get("label") or "") == "开盘"), movement[0])
        latest = movement[-1]
        opening_line = WorldCupService._to_float(opening.get("line"))
        latest_line = WorldCupService._to_float(latest.get("line"))
        opening_home_water = WorldCupService._to_float(opening.get("home_odds"))
        opening_away_water = WorldCupService._to_float(opening.get("away_odds"))
        movement_signal = WorldCupService._movement_signal(match, opening, latest)
        line_move_delta = None
        if opening_line is not None and latest_line is not None:
            line_move_delta = round(latest_line - opening_line, 2)
        return {
            "opening_handicap": WorldCupService._format_handicap_from_home_line(match, opening_line),
            "opening_home_water": opening_home_water,
            "opening_away_water": opening_away_water,
            "line_move_delta": line_move_delta,
            "movement_signal": movement_signal,
        }

    @staticmethod
    def _movement_signal(match: Dict[str, Any], opening: Dict[str, Any], latest: Dict[str, Any]) -> Optional[str]:
        opening_line = WorldCupService._to_float(opening.get("line"))
        latest_line = WorldCupService._to_float(latest.get("line"))
        opening_home_water = WorldCupService._to_float(opening.get("home_odds"))
        opening_away_water = WorldCupService._to_float(opening.get("away_odds"))
        latest_home_water = WorldCupService._to_float(latest.get("home_odds"))
        latest_away_water = WorldCupService._to_float(latest.get("away_odds"))
        if opening_line is None or latest_line is None:
            return None

        favorite_opening_team = WorldCupService._favorite_team_from_home_line(match, opening_line)
        if not favorite_opening_team:
            return "平手震荡"
        favorite_opening_water = opening_home_water if favorite_opening_team == match.get("home_team") else opening_away_water
        favorite_latest_team = WorldCupService._favorite_team_from_home_line(match, latest_line)
        favorite_latest_water = latest_home_water if favorite_opening_team == match.get("home_team") else latest_away_water

        favorite_strengthened = WorldCupService._favorite_strengthened(
            match,
            favorite_opening_team,
            opening_line,
            latest_line,
        )
        water_drop = (
            favorite_opening_water is not None
            and favorite_latest_water is not None
            and favorite_latest_water <= favorite_opening_water - 0.05
        )
        water_rise = (
            favorite_opening_water is not None
            and favorite_latest_water is not None
            and favorite_latest_water >= favorite_opening_water + 0.05
        )

        if favorite_strengthened and water_drop:
            return "升盘降水"
        if favorite_strengthened and water_rise:
            return "升盘升水"
        if not favorite_strengthened and water_drop:
            return "降盘降水"
        if not favorite_strengthened and water_rise:
            return "降盘升水"
        if favorite_latest_team != favorite_opening_team:
            return "强弱反转"
        if abs((latest_line or 0.0) - (opening_line or 0.0)) <= 0.01:
            return "平盘调水"
        return "正常收敛"

    @staticmethod
    def _favorite_strengthened(
        match: Dict[str, Any],
        favorite_team: str,
        opening_line: float,
        latest_line: float,
    ) -> bool:
        if favorite_team == match.get("home_team"):
            return latest_line < opening_line
        return latest_line > opening_line

    @staticmethod
    def _favorite_team_from_home_line(match: Dict[str, Any], home_line: Optional[float]) -> Optional[str]:
        normalized = WorldCupService._to_float(home_line)
        if normalized is None:
            return None
        if normalized < 0:
            return str(match.get("home_team") or "")
        if normalized > 0:
            return str(match.get("away_team") or "")
        return None

    @staticmethod
    def _format_handicap_from_home_line(match: Dict[str, Any], home_line: Optional[float]) -> Optional[str]:
        normalized = WorldCupService._to_float(home_line)
        if normalized is None:
            return None
        favorite_team = WorldCupService._favorite_team_from_home_line(match, normalized)
        if not favorite_team:
            return "平手 0"
        signed_line = normalized if favorite_team == match.get("away_team") else normalized
        return WorldCupService._format_theoretical_handicap(favorite_team, signed_line)

    @staticmethod
    def _append_movement_consensus_notes(diagnostics: Dict[str, Any]) -> None:
        movement_signal = diagnostics.get("movement_signal")
        opening_handicap = diagnostics.get("opening_handicap")
        actual_handicap = diagnostics.get("actual_handicap")
        notes = diagnostics.get("consensus_notes")
        if not isinstance(notes, list) or not movement_signal:
            return
        if opening_handicap and actual_handicap:
            notes.append(f"盘口演化：{opening_handicap} -> {actual_handicap}，形态 {movement_signal}。")
        else:
            notes.append(f"盘口演化形态：{movement_signal}。")

    @staticmethod
    def _analyze_bookmaker_quote(match: Dict[str, Any], quote: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        h2h_market = quote.get("h2h_market") or {}
        spread_market = quote.get("spread_market") or {}
        if not h2h_market or not h2h_market.get("options"):
            return None
        probabilities = WorldCupService._extract_h2h_probabilities(match, h2h_market)
        home_prob = probabilities.get("home")
        draw_prob = probabilities.get("draw")
        away_prob = probabilities.get("away")
        if home_prob is None or away_prob is None:
            return None
        theoretical = WorldCupService._derive_theoretical_market_line(match, home_prob, draw_prob or 0.0, away_prob)
        favorite_team = str(theoretical["favorite_team"])
        theoretical_line = float(theoretical["theoretical_line"])
        theoretical_home_prob = float(theoretical["theoretical_home_prob"])
        theoretical_away_prob = float(theoretical["theoretical_away_prob"])

        actual_line = WorldCupService._to_float(spread_market.get("line")) if spread_market else None
        actual_home_option = (
            next((option for option in spread_market.get("options", []) if match["home_team"] in str(option.get("label") or "")), None)
            if spread_market
            else None
        )
        actual_away_option = (
            next((option for option in spread_market.get("options", []) if match["away_team"] in str(option.get("label") or "")), None)
            if spread_market
            else None
        )
        actual_home_water = WorldCupService._to_float((actual_home_option or {}).get("odds"))
        actual_away_water = WorldCupService._to_float((actual_away_option or {}).get("odds"))
        favorite_side = (
            (actual_home_option or {}).get("label")
            if favorite_team == match["home_team"]
            else (actual_away_option or {}).get("label")
        )
        underdog_side = (
            (actual_away_option or {}).get("label")
            if favorite_team == match["home_team"]
            else (actual_home_option or {}).get("label")
        )
        actual_favorite_water = actual_home_water if favorite_team == match["home_team"] else actual_away_water
        theoretical_favorite_water = (
            round(1 / theoretical_home_prob, 2)
            if favorite_team == match["home_team"]
            else round(1 / theoretical_away_prob, 2)
        )
        pricing_signal = "balanced"
        if actual_favorite_water is not None:
            if actual_favorite_water <= theoretical_favorite_water - 0.08:
                pricing_signal = "favorite_discounted"
            elif actual_favorite_water >= theoretical_favorite_water + 0.08:
                pricing_signal = "favorite_overpriced"

        return {
            "bookmaker": quote.get("bookmaker") or "ESPN",
            "favorite_team": favorite_team,
            "favorite_side": favorite_side,
            "underdog_side": underdog_side,
            "theoretical_line": theoretical_line,
            "theoretical_home_prob": theoretical_home_prob,
            "theoretical_away_prob": theoretical_away_prob,
            "actual_line": actual_line,
            "actual_home_water": actual_home_water,
            "actual_away_water": actual_away_water,
            "pricing_signal": pricing_signal,
        }

    @staticmethod
    def _build_fundamentals_profile(match: Dict[str, Any], diagnostics: Dict[str, Any]) -> Dict[str, Any]:
        home_context = ((match.get("team_context") or {}).get("home") or {})
        away_context = ((match.get("team_context") or {}).get("away") or {})
        api_football_context = match.get("api_football_context") or {}
        favorite_team = diagnostics.get("favorite_team")
        motivation_score = 70 if WorldCupService._is_knockout_stage(match.get("stage")) else 58
        recent_form_score = WorldCupService._recent_form_score(match, home_context, away_context, favorite_team)
        venue_fit_score = WorldCupService._venue_fit_score(match, home_context, away_context, favorite_team)
        pedigree_score = WorldCupService._pedigree_score(match, home_context, away_context, favorite_team)
        squad_health_score = WorldCupService._squad_health_score(match, home_context, away_context, favorite_team)
        head_to_head_score = WorldCupService._head_to_head_score(match, favorite_team, api_football_context)
        api_recent_form_score = WorldCupService._api_recent_form_score(match, favorite_team, api_football_context)
        if api_recent_form_score is not None:
            recent_form_score = api_recent_form_score
        api_squad_health_score = WorldCupService._api_squad_health_score(match, favorite_team, api_football_context)
        if api_squad_health_score is not None:
            squad_health_score = api_squad_health_score
        score = round(
            recent_form_score * 0.27
            + motivation_score * 0.25
            + squad_health_score * 0.18
            + venue_fit_score * 0.15
            + pedigree_score * 0.08
            + head_to_head_score * 0.07
        )
        support_level = "neutral"
        if (
            diagnostics.get("consensus_pass")
            and diagnostics.get("pricing_signal") != "favorite_overpriced"
            and score >= 60
            and recent_form_score >= 52
            and squad_health_score >= 48
        ):
            support_level = "supportive"
        elif (
            diagnostics.get("pricing_signal") == "favorite_overpriced"
            or score <= 48
            or recent_form_score <= 46
            or squad_health_score <= 44
        ):
            support_level = "fragile"
        tags = WorldCupService._fundamental_summary_tags(
            match,
            favorite_team,
            home_context,
            away_context,
            recent_form_score,
            squad_health_score,
            head_to_head_score,
            motivation_score,
            support_level,
            api_football_context,
        )
        return {
            "score": score,
            "data_quality": "enhanced" if api_football_context else "partial" if home_context or away_context else "pending",
            "support_level": support_level,
            "recent_form_score": recent_form_score,
            "motivation_score": motivation_score,
            "squad_health_score": squad_health_score,
            "venue_fit_score": venue_fit_score,
            "pedigree_score": pedigree_score,
            "head_to_head_score": head_to_head_score,
            "summary_tags": tags,
        }

    @staticmethod
    def _head_to_head_score(match: Dict[str, Any], favorite_team: Optional[str], api_football_context: Dict[str, Any]) -> int:
        if not favorite_team:
            return 50
        fixtures = api_football_context.get("head_to_head") or []
        if not isinstance(fixtures, list) or not fixtures:
            return 50
        favorite_results = 0.0
        counted = 0
        for item in fixtures[:3]:
            teams = (item.get("teams") or {})
            home = ((teams.get("home") or {}).get("name") or "").strip()
            away = ((teams.get("away") or {}).get("name") or "").strip()
            goals = item.get("goals") or {}
            home_goals = WorldCupService._to_int(goals.get("home"))
            away_goals = WorldCupService._to_int(goals.get("away"))
            if home_goals is None or away_goals is None:
                continue
            counted += 1
            if home_goals == away_goals:
                favorite_results += 0.5
                continue
            winner = home if home_goals > away_goals else away
            if winner == favorite_team:
                favorite_results += 1.0
        if counted == 0:
            return 50
        return max(35, min(75, int(round(40 + favorite_results / counted * 30))))

    @staticmethod
    def _recent_form_score(
        match: Dict[str, Any],
        home_context: Dict[str, Any],
        away_context: Dict[str, Any],
        favorite_team: Optional[str],
    ) -> int:
        home_recent = WorldCupService._record_strength(home_context.get("recent_record") or home_context.get("overall_record"))
        away_recent = WorldCupService._record_strength(away_context.get("recent_record") or away_context.get("overall_record"))
        if favorite_team is None or home_recent is None or away_recent is None:
            return 50
        is_home_favorite = favorite_team == match.get("home_team")
        favorite_recent = home_recent if is_home_favorite else away_recent
        underdog_recent = away_recent if is_home_favorite else home_recent
        return WorldCupService._pair_advantage_to_score(favorite_recent, underdog_recent, base=50, scale=40)

    @staticmethod
    def _api_recent_form_score(
        match: Dict[str, Any],
        favorite_team: Optional[str],
        api_football_context: Dict[str, Any],
    ) -> Optional[int]:
        if not favorite_team:
            return None
        recent_form = api_football_context.get("recent_form") or {}
        home_strength = WorldCupService._api_team_recent_strength(
            recent_form.get("home"),
            match.get("home_team"),
        )
        away_strength = WorldCupService._api_team_recent_strength(
            recent_form.get("away"),
            match.get("away_team"),
        )
        if home_strength is None or away_strength is None:
            return None
        if favorite_team == match.get("home_team"):
            return WorldCupService._pair_advantage_to_score(home_strength, away_strength, base=52, scale=34)
        return WorldCupService._pair_advantage_to_score(away_strength, home_strength, base=52, scale=34)

    @staticmethod
    def _venue_fit_score(
        match: Dict[str, Any],
        home_context: Dict[str, Any],
        away_context: Dict[str, Any],
        favorite_team: Optional[str],
    ) -> int:
        if favorite_team is None:
            return 50
        home_side = WorldCupService._record_strength(home_context.get("home_record") or home_context.get("overall_record"))
        away_side = WorldCupService._record_strength(away_context.get("away_record") or away_context.get("overall_record"))
        if home_side is None or away_side is None:
            return 50
        if favorite_team == match.get("home_team"):
            favorite_strength = home_side
            underdog_strength = away_side
        else:
            favorite_strength = away_side
            underdog_strength = home_side
        return WorldCupService._pair_advantage_to_score(favorite_strength, underdog_strength, base=50, scale=32)

    @staticmethod
    def _pedigree_score(
        match: Dict[str, Any],
        home_context: Dict[str, Any],
        away_context: Dict[str, Any],
        favorite_team: Optional[str],
    ) -> int:
        home_rank = home_context.get("rank")
        away_rank = away_context.get("rank")
        if favorite_team is None:
            return 50
        if home_rank is None or away_rank is None:
            return 55
        if favorite_team == match.get("home_team"):
            favorite_rank = home_rank
            underdog_rank = away_rank
        else:
            favorite_rank = away_rank
            underdog_rank = home_rank
        rank_gap = underdog_rank - favorite_rank
        return max(35, min(75, int(round(50 + rank_gap * 1.2))))

    @staticmethod
    def _squad_health_score(
        match: Dict[str, Any],
        home_context: Dict[str, Any],
        away_context: Dict[str, Any],
        favorite_team: Optional[str],
    ) -> int:
        if favorite_team is None:
            return 50
        favorite_injuries = (
            int(home_context.get("injury_count") or 0)
            if favorite_team == match.get("home_team")
            else int(away_context.get("injury_count") or 0)
        )
        underdog_injuries = (
            int(away_context.get("injury_count") or 0)
            if favorite_team == match.get("home_team")
            else int(home_context.get("injury_count") or 0)
        )
        return max(35, min(70, 50 + underdog_injuries * 4 - favorite_injuries * 5))

    @staticmethod
    def _api_squad_health_score(
        match: Dict[str, Any],
        favorite_team: Optional[str],
        api_football_context: Dict[str, Any],
    ) -> Optional[int]:
        if not favorite_team:
            return None
        impact = WorldCupService._injury_impact_by_team(match, api_football_context)
        if not impact:
            return None
        favorite_impact = impact.get(favorite_team)
        underdog_team = match.get("away_team") if favorite_team == match.get("home_team") else match.get("home_team")
        underdog_impact = impact.get(underdog_team)
        if favorite_impact is None or underdog_impact is None:
            return None
        score = 54 + underdog_impact * 4 - favorite_impact * 5
        return max(30, min(76, int(round(score))))

    @staticmethod
    def _api_team_recent_strength(fixtures: Any, team_name: Optional[str]) -> Optional[float]:
        if not isinstance(fixtures, list) or not fixtures or not team_name:
            return None
        points = 0.0
        goal_bonus = 0.0
        counted = 0
        for fixture in fixtures[:6]:
            teams = fixture.get("teams") or {}
            home = ((teams.get("home") or {}).get("name") or "").strip()
            away = ((teams.get("away") or {}).get("name") or "").strip()
            goals = fixture.get("goals") or {}
            home_goals = WorldCupService._to_int(goals.get("home"))
            away_goals = WorldCupService._to_int(goals.get("away"))
            if home_goals is None or away_goals is None:
                continue
            if WorldCupService._team_names_match(team_name, home):
                team_goals = home_goals
                opp_goals = away_goals
            elif WorldCupService._team_names_match(team_name, away):
                team_goals = away_goals
                opp_goals = home_goals
            else:
                continue
            counted += 1
            if team_goals > opp_goals:
                points += 3
            elif team_goals == opp_goals:
                points += 1
            goal_bonus += max(min((team_goals - opp_goals) * 0.08, 0.24), -0.24)
        if counted == 0:
            return None
        return max(0.0, min(1.0, points / (counted * 3) + goal_bonus / counted))

    @staticmethod
    def _injury_impact_by_team(match: Dict[str, Any], api_football_context: Dict[str, Any]) -> Dict[str, float]:
        injuries = api_football_context.get("injuries") or []
        if not isinstance(injuries, list):
            return {}
        impacts = {
            str(match.get("home_team") or ""): 0.0,
            str(match.get("away_team") or ""): 0.0,
        }
        for item in injuries:
            team_name = (((item.get("team") or {}).get("name")) or "").strip()
            matched_team = next((name for name in impacts if WorldCupService._team_names_match(team_name, name)), None)
            if not matched_team:
                continue
            player = item.get("player") or {}
            reason = str((player.get("reason") or item.get("reason") or "")).lower()
            position = str((player.get("type") or player.get("position") or "")).lower()
            weight = 1.0
            if "goal" in position or "keeper" in position:
                weight = 1.6
            elif "def" in position or "back" in position:
                weight = 1.25
            elif "mid" in position:
                weight = 1.15
            elif "att" in position or "forw" in position or "striker" in position:
                weight = 1.35
            if any(token in reason for token in ("doubt", "question", "suspended")):
                weight += 0.15
            impacts[matched_team] += weight
        return impacts

    @staticmethod
    def _record_strength(summary: Optional[str]) -> Optional[float]:
        if not summary or not isinstance(summary, str):
            return None
        numbers = [int(item) for item in re.findall(r"\d+", summary)]
        if not numbers:
            return None
        wins = numbers[0]
        losses = numbers[1] if len(numbers) > 1 else 0
        draws = numbers[2] if len(numbers) > 2 else 0
        total = wins + losses + draws
        if total <= 0:
            return None
        return (wins + draws * 0.5) / total

    @staticmethod
    def _pair_advantage_to_score(favorite_value: float, underdog_value: float, base: int, scale: int) -> int:
        delta = favorite_value - underdog_value
        return max(35, min(78, int(round(base + delta * scale))))

    @staticmethod
    def _fundamental_summary_tags(
        match: Dict[str, Any],
        favorite_team: Optional[str],
        home_context: Dict[str, Any],
        away_context: Dict[str, Any],
        recent_form_score: int,
        squad_health_score: int,
        head_to_head_score: int,
        motivation_score: int,
        support_level: str,
        api_football_context: Dict[str, Any],
    ) -> List[str]:
        tags: List[str] = []
        if favorite_team:
            tags.append(f"当前市场默认 {favorite_team} 为强势一方。")
        if home_context.get("recent_record") or away_context.get("recent_record"):
            tags.append(
                f"近期战绩摘要：主队 {home_context.get('recent_record') or home_context.get('overall_record') or '缺失'}，"
                f"客队 {away_context.get('recent_record') or away_context.get('overall_record') or '缺失'}。"
            )
        if home_context.get("home_record") or away_context.get("away_record"):
            tags.append(
                f"主客属性摘要：主队主场 {home_context.get('home_record') or '缺失'}，"
                f"客队客场 {away_context.get('away_record') or '缺失'}。"
            )
        if home_context.get("rank") or away_context.get("rank"):
            tags.append(
                f"排名参考：主队 {home_context.get('rank') or '--'}，客队 {away_context.get('rank') or '--'}。"
            )
        tags.append(
            f"五要素量化：近况 {recent_form_score}，伤停 {squad_health_score}，交手 {head_to_head_score}。"
        )
        if motivation_score >= 70:
            tags.append("淘汰赛阶段战意默认更强，盘口对强弱分层更值得尊重。")
        else:
            tags.append("当前仍以盘口数据为主，战意与伤停后续建议接入更细颗粒度数据源。")
        injuries = api_football_context.get("injuries") or []
        if isinstance(injuries, list) and injuries:
            impacts = WorldCupService._injury_impact_by_team(match, api_football_context)
            tags.append(
                f"API-Football 已同步伤停，主队影响 {impacts.get(match.get('home_team'), 0.0):.1f}，"
                f"客队影响 {impacts.get(match.get('away_team'), 0.0):.1f}。"
            )
        recent_form = api_football_context.get("recent_form") or {}
        if isinstance(recent_form, dict) and (recent_form.get("home") or recent_form.get("away")):
            home_strength = WorldCupService._api_team_recent_strength(recent_form.get("home"), match.get("home_team"))
            away_strength = WorldCupService._api_team_recent_strength(recent_form.get("away"), match.get("away_team"))
            if home_strength is not None and away_strength is not None:
                tags.append(
                    f"近6场强度：主队 {home_strength * 100:.0f}，客队 {away_strength * 100:.0f}。"
                )
        h2h = api_football_context.get("head_to_head") or []
        if isinstance(h2h, list) and h2h:
            tags.append(f"API-Football 已同步近端交手样本 {min(len(h2h), 3)} 场。")
        if support_level == "supportive":
            tags.append("现有基本面代理变量并未反驳盘口方向，可以视为顺势环境。")
        elif support_level == "fragile":
            tags.append("基础面代理变量对当前盘口支撑偏弱，需提高防诱盘意识。")
        return tags

    @staticmethod
    def _build_heat_profile(
        match: Dict[str, Any],
        diagnostics: Dict[str, Any],
        fundamentals: Dict[str, Any],
    ) -> Dict[str, Any]:
        heat_flags: List[str] = []
        cold_flags: List[str] = []
        pricing_signal = diagnostics.get("pricing_signal")
        line_delta = WorldCupService._to_float(diagnostics.get("line_delta"))

        if pricing_signal == "favorite_discounted":
            heat_flags.append("热门降水")
        elif pricing_signal == "favorite_overpriced":
            cold_flags.append("热门虚热")

        if line_delta is not None and line_delta >= 0.5:
            heat_flags.append("盘口跳档")
        if fundamentals.get("recent_form_score", 50) < 48 and fundamentals.get("pedigree_score", 50) >= 60:
            heat_flags.append("名气热")
        if fundamentals.get("squad_health_score", 50) <= 44:
            cold_flags.append("伤停冷")
        if fundamentals.get("support_level") == "fragile":
            cold_flags.append("基础面不稳")

        trap_type = None
        actual_handicap = str(diagnostics.get("actual_handicap") or "")
        theoretical_handicap = str(diagnostics.get("theoretical_handicap") or "")
        if pricing_signal == "favorite_overpriced" and actual_handicap and theoretical_handicap:
            trap_type = "fake_deep" if actual_handicap != theoretical_handicap else "fake_shallow"
        elif diagnostics.get("consensus_pass") and pricing_signal == "favorite_discounted":
            trap_type = "true_deep"
        elif diagnostics.get("consensus_pass"):
            trap_type = "true_shallow"

        return {
            "trap_type": trap_type,
            "heat_flags": heat_flags,
            "cold_flags": cold_flags,
        }

    @staticmethod
    def _pass_warning_message(
        diagnostics: Dict[str, Any],
        fundamentals: Dict[str, Any],
        heat_profile: Dict[str, Any],
    ) -> str:
        if heat_profile.get("trap_type") in {"fake_deep", "fake_shallow"}:
            return "盘口存在诱导嫌疑，当前更适合防守或放弃，而不是强行下注。"
        if not diagnostics.get("consensus_pass"):
            return "机构共识不够稳定，当前没有形成可执行的盘口信号。"
        if fundamentals.get("support_level") == "fragile":
            return "盘口与基础面并不完全匹配，当前建议保持观望。"
        return "当前没有形成足够清晰的下注优势，建议观望。"

    @staticmethod
    def _extract_h2h_probabilities(match: Dict[str, Any], h2h_market: Dict[str, Any]) -> Dict[str, Optional[float]]:
        home_prob = next(
            (option.get("probability") for option in h2h_market.get("options", []) if option.get("label") == match["home_team"]),
            None,
        )
        away_prob = next(
            (option.get("probability") for option in h2h_market.get("options", []) if option.get("label") == match["away_team"]),
            None,
        )
        draw_prob = next(
            (option.get("probability") for option in h2h_market.get("options", []) if str(option.get("label") or "") == "平局"),
            None,
        )
        return {
            "home": WorldCupService._to_float(home_prob),
            "draw": WorldCupService._to_float(draw_prob) or 0.0,
            "away": WorldCupService._to_float(away_prob),
        }

    @staticmethod
    def _derive_theoretical_market_line(
        match: Dict[str, Any],
        home_prob: float,
        draw_prob: float,
        away_prob: float,
    ) -> Dict[str, Any]:
        favorite_team = match["home_team"] if home_prob >= away_prob else match["away_team"]
        favorite_win_prob = max(home_prob, away_prob)
        candidates = [0.0, 0.25, 0.5, 0.75, 1.0, 1.25, 1.5]

        best_line = 0.0
        best_gap = float("inf")
        best_cover = 0.5
        for line in candidates:
            favorite_cover = WorldCupService._favorite_cover_probability(line, favorite_win_prob, draw_prob)
            gap = abs(favorite_cover - 0.5)
            if gap < best_gap:
                best_gap = gap
                best_line = line
                best_cover = favorite_cover

        signed_line = -best_line if favorite_team == match["home_team"] else best_line
        favorite_water = max(1.01, min(3.5, round(1 / max(best_cover, 0.01), 2)))
        underdog_cover = max(0.01, min(0.99, 1 - best_cover))
        underdog_water = max(1.01, min(3.5, round(1 / underdog_cover, 2)))
        if favorite_team == match["home_team"]:
            theoretical_home_prob = best_cover
            theoretical_away_prob = underdog_cover
        else:
            theoretical_home_prob = underdog_cover
            theoretical_away_prob = best_cover
        return {
            "favorite_team": favorite_team,
            "theoretical_line": signed_line,
            "theoretical_home_prob": theoretical_home_prob,
            "theoretical_away_prob": theoretical_away_prob,
            "theoretical_home_water": favorite_water if favorite_team == match["home_team"] else underdog_water,
            "theoretical_away_water": underdog_water if favorite_team == match["home_team"] else favorite_water,
        }

    @staticmethod
    def _favorite_cover_probability(line: float, favorite_win_prob: float, draw_prob: float) -> float:
        draw_prob = max(0.0, min(draw_prob, 0.45))
        favorite_win_prob = max(0.01, min(favorite_win_prob, 0.95))
        one_goal_share = WorldCupService._estimate_one_goal_share(favorite_win_prob, draw_prob)

        if line <= 0:
            return min(0.99, favorite_win_prob + draw_prob * 0.5)
        if line <= 0.25:
            return min(0.99, favorite_win_prob + draw_prob * 0.25)
        if line <= 0.5:
            return favorite_win_prob
        if line <= 0.75:
            return max(0.01, favorite_win_prob - one_goal_share * favorite_win_prob * 0.5)
        if line <= 1.0:
            return max(0.01, favorite_win_prob * (1 - one_goal_share))
        if line <= 1.25:
            return max(0.01, favorite_win_prob * (1 - one_goal_share) - one_goal_share * favorite_win_prob * 0.1)
        return max(0.01, favorite_win_prob * (1 - one_goal_share * 1.1))

    @staticmethod
    def _estimate_one_goal_share(favorite_win_prob: float, draw_prob: float) -> float:
        estimated = 0.62 - max(favorite_win_prob - 0.5, 0) * 0.8 + draw_prob * 0.3
        return max(0.32, min(0.78, estimated))

    @staticmethod
    def _format_theoretical_handicap(team: str, line: Optional[float]) -> Optional[str]:
        normalized = WorldCupService._to_float(line)
        if normalized is None:
            return None
        if abs(normalized) < 0.01:
            side = "0"
        else:
            side = f"-{abs(normalized):.2f}".replace(".00", "")
        return f"{team} {side}"

    @staticmethod
    def _is_knockout_stage(stage: Any) -> bool:
        normalized = str(stage or "")
        return normalized in {"32强", "16强", "8强", "半决赛", "季军赛", "决赛"}

    @staticmethod
    def _find_market(match: Dict[str, Any], market_type: str) -> Optional[Dict[str, Any]]:
        return next((item for item in match.get("markets", []) if item.get("market_type") == market_type), None)

    @staticmethod
    def _normalize_polymarket_state(match: Dict[str, Any]) -> None:
        polymarket_market = WorldCupService._find_market(match, "polymarket")
        if not polymarket_market:
            return
        if match.get("polymarket_probabilities"):
            return

        normalized: Dict[str, float] = {}
        for option in polymarket_market.get("options", []):
            label = str(option.get("label") or "").strip()
            probability = WorldCupService._to_float(option.get("probability"))
            if not label or probability is None or probability <= 0:
                continue
            normalized[label] = round(probability, 4)
        if normalized:
            match["polymarket_probabilities"] = normalized

    @staticmethod
    def _normalize_probability_labels(match: Dict[str, Any]) -> Dict[str, float]:
        normalized: Dict[str, float] = {}
        home_aliases = WorldCupService._team_aliases(match["home_team"])
        away_aliases = WorldCupService._team_aliases(match["away_team"])

        for raw_label, probability in (match.get("polymarket_probabilities") or {}).items():
            label = WorldCupService._normalize_text(raw_label)
            raw_lower = str(raw_label).lower()
            if any(alias in label for alias in home_aliases):
                normalized["home"] = probability
            elif any(alias in label for alias in away_aliases):
                normalized["away"] = probability
            elif any(token in label for token in ("draw", "tie")) or "平" in raw_lower:
                normalized["draw"] = probability
        return normalized

    @staticmethod
    def _signal_profile(candidate: Dict[str, Any], confidence: int) -> Dict[str, Any]:
        strategy = str(candidate.get("strategy") or "")
        edge = float(candidate.get("edge") or 0.0)
        book_probability = WorldCupService._to_float(candidate.get("book_probability")) or 0.0
        fair_probability = WorldCupService._to_float(candidate.get("fair_probability"))

        if strategy == "价值单":
            if edge >= 0.08:
                stake_pct = 1.0
            elif edge >= 0.05:
                stake_pct = 0.7
            else:
                stake_pct = 0.4
            signal_grade = "strong" if (fair_probability or 0.0) >= 0.5 and confidence >= 68 else "caution"
            warning_message = (
                "该单属于高赔率价值单，长期赔率价值更重要，但单场波动较大，请用卫星仓位参与。"
            )
            return {
                "decision": "bet",
                "signal_tier": "satellite",
                "signal_grade": signal_grade,
                "warning_message": warning_message,
                "stake_pct": stake_pct,
            }

        if strategy == "主推方向":
            if confidence >= 76 and book_probability >= 0.58:
                stake_pct = 4.0
                signal_grade = "strong"
            elif confidence >= 70:
                stake_pct = 3.0
                signal_grade = "strong"
            else:
                stake_pct = 2.0
                signal_grade = "caution"
            return {
                "decision": "bet",
                "signal_tier": "core",
                "signal_grade": signal_grade,
                "warning_message": None if signal_grade == "strong" else "盘口与基本面大体同向，但还没有强到满配主仓。",
                "stake_pct": stake_pct,
            }

        if strategy in {"一致性单", "机构共识"}:
            if confidence >= 74 and book_probability >= 0.60:
                stake_pct = 3.0
                signal_grade = "strong"
            elif confidence >= 68 and book_probability >= 0.56:
                stake_pct = 2.5
                signal_grade = "strong"
            else:
                stake_pct = 2.0
                signal_grade = "caution"
            warning_message = (
                None
                if signal_grade == "strong"
                else "该单以盘口一致性为主，确定性尚可，但缺少独立 fair price 验证。"
            )
            return {
                "decision": "bet",
                "signal_tier": "core",
                "signal_grade": signal_grade,
                "warning_message": warning_message,
                "stake_pct": stake_pct,
            }

        if strategy == "冷门预警":
            stake_pct = 0.4 if confidence >= 62 else 0.25
            return {
                "decision": "lean",
                "signal_tier": "probe",
                "signal_grade": "high_risk",
                "warning_message": "该单属于冷门预警信号，更多用于防守与降仓，不建议直接重仓逆热门。",
                "stake_pct": stake_pct,
            }

        if confidence >= 64 and book_probability >= 0.54:
            stake_pct = 0.5
        elif confidence >= 58:
            stake_pct = 0.4
        else:
            stake_pct = 0.25
        return {
            "decision": "lean",
            "signal_tier": "probe",
            "signal_grade": "high_risk",
            "warning_message": "该单主要来自市场共识，不代表存在明显赔率错误，请仅用试探仓位参与。",
            "stake_pct": stake_pct,
        }

    @staticmethod
    def _confidence_from_edge(edge: float, strength: float) -> int:
        score = 45 + edge * 500 + max(strength - 0.5, 0) * 60
        return max(52, min(82, int(round(score))))

    @staticmethod
    def _build_h2h_market(match: Dict[str, Any], odds: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        moneyline = odds.get("moneyline") or {}
        home_close = ((moneyline.get("home") or {}).get("close") or {}).get("odds")
        draw_close = ((moneyline.get("draw") or {}).get("close") or {}).get("odds")
        away_close = ((moneyline.get("away") or {}).get("close") or {}).get("odds")

        items = [
            (match["home_team"], home_close),
            ("平局", draw_close),
            (match["away_team"], away_close),
        ]
        options = WorldCupService._market_options_from_american(items)
        if not options:
            return None
        return {"market_type": "h2h", "title": "胜平负", "line": None, "options": options}

    @staticmethod
    def _build_spread_market(match: Dict[str, Any], odds: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        spread = odds.get("pointSpread") or {}
        home_close = (spread.get("home") or {}).get("close") or {}
        away_close = (spread.get("away") or {}).get("close") or {}
        line = home_close.get("line")

        items = [
            (f'{match["home_team"]} {home_close.get("line", "")}'.strip(), home_close.get("odds")),
            (f'{match["away_team"]} {away_close.get("line", "")}'.strip(), away_close.get("odds")),
        ]
        options = WorldCupService._market_options_from_american(items)
        if len(options) < 2:
            return None
        return {
            "market_type": "asian_handicap",
            "title": "让球",
            "line": str(line) if line is not None else None,
            "options": options,
        }

    @staticmethod
    def _build_totals_market(odds: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        total = odds.get("total") or {}
        over_close = (total.get("over") or {}).get("close") or {}
        under_close = (total.get("under") or {}).get("close") or {}
        over_line = WorldCupService._extract_total_line(over_close.get("line"))
        under_line = WorldCupService._extract_total_line(under_close.get("line"))
        line = over_line or under_line or odds.get("overUnder")

        items = [
            (f"大 {over_line or line}", over_close.get("odds")),
            (f"小 {under_line or line}", under_close.get("odds")),
        ]
        options = WorldCupService._market_options_from_american(items)
        if len(options) < 2:
            return None
        return {
            "market_type": "totals",
            "title": "大小球",
            "line": str(line) if line is not None else None,
            "options": options,
        }

    @staticmethod
    def _build_line_movement(odds: Dict[str, Any]) -> List[Dict[str, Any]]:
        spread = odds.get("pointSpread") or {}
        home = spread.get("home") or {}
        away = spread.get("away") or {}
        open_home = home.get("open") or {}
        open_away = away.get("open") or {}
        close_home = home.get("close") or {}
        close_away = away.get("close") or {}

        points = []
        if open_home or open_away:
            points.append(
                {
                    "label": "开盘",
                    "line": WorldCupService._to_float(open_home.get("line")) or 0.0,
                    "home_odds": WorldCupService._american_to_decimal(open_home.get("odds")) or 0.0,
                    "away_odds": WorldCupService._american_to_decimal(open_away.get("odds")) or 0.0,
                }
            )
        if close_home or close_away:
            points.append(
                {
                    "label": "即时",
                    "line": WorldCupService._to_float(close_home.get("line")) or 0.0,
                    "home_odds": WorldCupService._american_to_decimal(close_home.get("odds")) or 0.0,
                    "away_odds": WorldCupService._american_to_decimal(close_away.get("odds")) or 0.0,
                }
            )
        return points

    @staticmethod
    def _market_options_from_american(items: List[tuple[str, Any]]) -> List[Dict[str, Any]]:
        prepared = []
        for label, raw_odds in items:
            decimal_odds = WorldCupService._american_to_decimal(raw_odds)
            implied_probability = WorldCupService._american_to_implied(raw_odds)
            if decimal_odds is None or implied_probability is None:
                continue
            prepared.append((label, decimal_odds, implied_probability))

        probability_sum = sum(item[2] for item in prepared)
        if not prepared or probability_sum <= 0:
            return []

        return [
            {
                "label": label,
                "odds": decimal_odds,
                "probability": round(implied_probability / probability_sum, 4),
            }
            for label, decimal_odds, implied_probability in prepared
        ]

    @staticmethod
    def _american_to_decimal(value: Any) -> Optional[float]:
        american = WorldCupService._parse_american_odds(value)
        if american is None:
            return None
        if american > 0:
            return round(1 + american / 100, 2)
        return round(1 + 100 / abs(american), 2)

    @staticmethod
    def _american_to_implied(value: Any) -> Optional[float]:
        american = WorldCupService._parse_american_odds(value)
        if american is None:
            return None
        if american > 0:
            return 100 / (american + 100)
        return abs(american) / (abs(american) + 100)

    @staticmethod
    def _parse_american_odds(value: Any) -> Optional[int]:
        if value is None:
            return None
        if isinstance(value, int):
            return value
        if isinstance(value, str):
            normalized = value.strip()
            if not normalized:
                return None
            try:
                return int(normalized)
            except ValueError:
                return None
        return None

    @staticmethod
    def _extract_total_line(value: Any) -> Optional[str]:
        if not isinstance(value, str):
            return None
        return value[1:] if value[:1].lower() in {"o", "u"} else value

    @staticmethod
    def _extract_external_url(links: List[Dict[str, Any]]) -> Optional[str]:
        for link in links:
            href = link.get("href")
            if isinstance(href, str) and href:
                return href
        return None

    @staticmethod
    def _extract_venue_name(competition: Dict[str, Any], event: Dict[str, Any]) -> str:
        competition_venue = competition.get("venue") or {}
        if isinstance(competition_venue, dict):
            full_name = competition_venue.get("fullName")
            if isinstance(full_name, str) and full_name:
                return full_name

        event_venue = event.get("venue") or {}
        if isinstance(event_venue, dict):
            display_name = event_venue.get("displayName")
            if isinstance(display_name, str) and display_name:
                return display_name

        return "待定场地"

    @staticmethod
    def _extract_team_context(competitor: Dict[str, Any], side: str) -> Dict[str, Any]:
        records = competitor.get("records") or []
        rank = (
            (competitor.get("curatedRank") or {}).get("current")
            if isinstance(competitor.get("curatedRank"), dict)
            else competitor.get("curatedRank")
        )
        context = {
            "side": side,
            "team_id": WorldCupService._to_int((competitor.get("team") or {}).get("id")),
            "rank": WorldCupService._to_int(rank),
            "overall_record": WorldCupService._extract_record_summary(records, {"overall", "all"}),
            "home_record": WorldCupService._extract_record_summary(records, {"home"}),
            "away_record": WorldCupService._extract_record_summary(records, {"away", "road"}),
            "recent_record": WorldCupService._extract_record_summary(records, {"last five", "last 5", "last six", "last 6"}),
            "injury_count": WorldCupService._extract_injury_count(competitor),
        }
        return context

    @staticmethod
    def _extract_record_summary(records: Any, names: set[str]) -> Optional[str]:
        if not isinstance(records, list):
            return None
        for record in records:
            if not isinstance(record, dict):
                continue
            name = str(record.get("name") or record.get("displayName") or record.get("type") or "").strip().lower()
            if name in names:
                summary = record.get("summary")
                if isinstance(summary, str) and summary.strip():
                    return summary.strip()
        return None

    @staticmethod
    def _extract_injury_count(competitor: Dict[str, Any]) -> int:
        injuries = competitor.get("injuries")
        if isinstance(injuries, list):
            return len(injuries)
        return 0

    @staticmethod
    def _to_int(value: Any) -> Optional[int]:
        try:
            return int(value)
        except (TypeError, ValueError):
            return None

    @staticmethod
    def _to_float(value: Any) -> Optional[float]:
        try:
            return float(value)
        except (TypeError, ValueError):
            return None

    @staticmethod
    def _sort_key(match: Dict[str, Any]) -> tuple[int, float, str]:
        status = str(match.get("status") or "")
        status_rank = {"live": 0, "upcoming": 1, "settled": 2}
        kickoff_at = str(match.get("kickoff_at") or "")
        try:
            kickoff_ts = datetime.fromisoformat(kickoff_at.replace("Z", "+00:00")).timestamp()
        except ValueError:
            kickoff_ts = float("inf")

        if status == "settled":
            time_rank = -kickoff_ts
        else:
            time_rank = kickoff_ts

        return (status_rank.get(status, 9), time_rank, str(match.get("match_id") or ""))

    @staticmethod
    def _sort_match_by_kickoff(match: Dict[str, Any]) -> tuple[str, str]:
        return (str(match.get("kickoff_at") or ""), str(match.get("match_id") or ""))

    @staticmethod
    def _summary(match: Dict[str, Any]) -> Dict[str, Any]:
        return {
            "match_id": match["match_id"],
            "stage": match["stage"],
            "group_name": match.get("group_name"),
            "kickoff_at": match["kickoff_at"],
            "home_team": match["home_team"],
            "away_team": match["away_team"],
            "venue": match["venue"],
            "status": match["status"],
            "home_score": match.get("home_score"),
            "away_score": match.get("away_score"),
            "source": match.get("source"),
            "external_url": match.get("external_url"),
            "featured_pick": deepcopy(match["featured_pick"]),
            "key_market": deepcopy(match["key_market"]),
        }
