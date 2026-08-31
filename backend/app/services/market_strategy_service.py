from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path
from typing import Any

class MarketStrategyService:
    DEFAULT_VERSION = "defaults"
    DEFAULT_PRIVATE = {
        "mainline": {
            "weights": {
                "attackPerBoard": 0,
                "attackCap": 0,
                "maxHeight": 0,
                "heightSum": 0,
                "ladderCap": 0,
                "marketMaxBonus": 0,
                "marketSecondBonus": 0,
                "flowScale": 0,
                "flowNetShare": 0,
                "persistPerDay": 0,
                "persistZt": 0,
                "persistZtCap": 0,
                "earlyShare": 0,
                "sealFund": 0,
                "sealFundCap": 0,
                "breakPenalty": 0,
                "breakCap": 0,
            }
        },
        "rebound": {
            "weights": {
                "prevHeight": 0,
                "prevHeightFirst": 0,
                "prevHeightHigh": 0,
                "sweetMin": 0,
                "sweetMax": 0,
                "gap1Confirmed": 0,
                "gap1Watch": 0,
                "gap2": 0,
                "gapDeep": 0,
                "washReseal": 0,
                "earlySeal": 0,
                "fundStrong": 0,
                "fundStrongYi": 0,
                "fundMid": 0,
                "fundMidYi": 0,
                "turnoverBest": 0,
                "turnoverBestMin": 0,
                "turnoverBestMax": 0,
                "turnoverMid": 0,
                "turnoverMidMin": 0,
                "turnoverMidMax": 0,
                "turnoverHotPenalty": 0,
                "turnoverHotMin": 0,
                "zbcPenalty": 0,
                "zbcHigh": 0,
                "zbcMidPenalty": 0,
                "wasLeader": 0,
                "inMainline": 0,
                "leaderGrade": 0,
                "leaderGradeMaxGap": 0,
            }
        },
        "relay": {
            "firstBoard": {
                "theme": 0,
                "clusterTiers": [0, 0],
                "clusterScores": [0, 0, 0],
                "earlySeal": 0,
                "earlySealEnd": 0,
                "morningSeal": 0,
                "morningSealEnd": 0,
                "lowPrice": 0,
                "lowPriceMax": 0,
                "midPrice": 0,
                "midPriceMax": 0,
                "fundStrong": 0,
                "fundStrongYi": 0,
                "fundMid": 0,
                "fundMidYi": 0,
                "turnoverBest": 0,
                "turnoverBestMin": 0,
                "turnoverBestMax": 0,
                "turnoverMid": 0,
                "turnoverMidMin": 0,
                "turnoverMidMax": 0,
                "turnoverHotPenalty": 0,
                "turnoverHotMin": 0,
                "lowZbc": 0,
                "lowZbcMax": 0,
            }
        },
        "flowStrength": {
            "amount": 0,
            "ratio": 0,
            "bigOrder": 0,
            "defensive": 0,
            "ratioClamp": 0,
            "bigClamp": 0,
            "defClamp": 0,
        },
    }
    DEFAULT_PAYLOAD = {"version": DEFAULT_VERSION, "private": DEFAULT_PRIVATE}
    DEFAULTS_PATH = Path(__file__).resolve().parents[2] / "data/strategy/private.defaults.json"

    @classmethod
    def _normalize_payload(cls, payload: Any) -> dict[str, Any]:
        if not isinstance(payload, dict):
            return dict(cls.DEFAULT_PAYLOAD)
        private_section = payload.get("private")
        if not isinstance(private_section, dict):
            private_section = payload if isinstance(payload, dict) else {}
        version = payload.get("version")
        if not isinstance(version, str) or not version.strip():
            version = cls.DEFAULT_VERSION
        return {
            "version": version.strip(),
            "private": private_section,
        }

    @classmethod
    def _write_defaults_file(cls, payload: dict[str, Any]) -> None:
        cls.DEFAULTS_PATH.parent.mkdir(parents=True, exist_ok=True)
        cls.DEFAULTS_PATH.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    @classmethod
    def load_defaults_payload(cls) -> dict[str, Any]:
        if not cls.DEFAULTS_PATH.exists():
            payload = dict(cls.DEFAULT_PAYLOAD)
            cls._write_defaults_file(payload)
            return payload

        raw = cls.DEFAULTS_PATH.read_text(encoding="utf-8").strip()
        if not raw:
            payload = dict(cls.DEFAULT_PAYLOAD)
            cls._write_defaults_file(payload)
            return payload

        try:
            payload = cls._normalize_payload(json.loads(raw))
        except json.JSONDecodeError:
            payload = dict(cls.DEFAULT_PAYLOAD)
            cls._write_defaults_file(payload)
            return payload

        if payload["private"] == {} and raw not in ("{}", ""):
            return payload
        return payload

    @classmethod
    async def get_strategy(cls) -> dict[str, Any]:
        return cls.load_defaults_payload()

    @classmethod
    async def set_strategy(cls, private_section: dict[str, Any], version: str | None = None) -> dict[str, Any]:
        normalized_private = private_section if isinstance(private_section, dict) else {}
        normalized_version = (version or "").strip() or datetime.now().strftime("manual-%Y%m%d%H%M%S")
        payload = {
            "version": normalized_version,
            "private": normalized_private,
        }
        cls._write_defaults_file(payload)
        return payload
