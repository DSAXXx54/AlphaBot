from __future__ import annotations

import json
import os
import re
import uuid
from datetime import datetime
from typing import Any, Dict, Optional

from sqlalchemy.orm import Session

from app.channels.base import ChannelMessage
from app.db.session import SessionLocal
from app.models.user import User
from app.services.agent_service import AgentService


def _slugify(value: str) -> str:
    normalized = re.sub(r"[^a-zA-Z0-9\u4e00-\u9fff]+", "-", value.strip()).strip("-").lower()
    return normalized or f"report-{uuid.uuid4().hex[:8]}"


def _render_template(value: str, now: datetime) -> str:
    return value.format(
        date=now.strftime("%Y-%m-%d"),
        date_compact=now.strftime("%Y%m%d"),
        datetime=now.strftime("%Y-%m-%d %H:%M:%S"),
        datetime_compact=now.strftime("%Y%m%d-%H%M%S"),
        brief="{brief}",
    )


class AutomationService:
    """自动化 Skill 任务与发布服务。"""

    DEFAULT_COLLECTION_SLUG = "daily-market-brief"

    @classmethod
    def published_dir(cls) -> str:
        from app.core.config import settings

        path = os.path.join(settings.BASE_DIR, "data", "published_reports")
        os.makedirs(path, exist_ok=True)
        return path

    @classmethod
    def write_published_report(
        cls,
        *,
        slug: str,
        title: str,
        content: str,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        payload = {
            "slug": slug,
            "title": title,
            "content": content,
            "metadata": metadata or {},
            "published_at": datetime.now().isoformat(),
        }
        path = os.path.join(cls.published_dir(), f"{slug}.json")
        with open(path, "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False, indent=2)
        return payload

    @classmethod
    def load_published_report(cls, slug: str) -> Optional[Dict[str, Any]]:
        path = os.path.join(cls.published_dir(), f"{slug}.json")
        if not os.path.exists(path):
            return None
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)

    @classmethod
    def build_collection_slug(cls, value: Optional[str]) -> str:
        normalized = _slugify(str(value or "").strip()) if value else ""
        return normalized or cls.DEFAULT_COLLECTION_SLUG

    @classmethod
    def build_entry_slug(cls, template: str, now: datetime) -> str:
        normalized = (template or "").strip()
        if normalized:
            if "{" in normalized and "}" in normalized:
                return _slugify(_render_template(normalized, now))
            return _slugify(f"{normalized}-{now.strftime('%Y%m%d')}")
        return _slugify(f"review-{now.strftime('%Y%m%d')}")

    @classmethod
    def build_storage_slug(cls, collection_slug: str, entry_slug: str) -> str:
        return _slugify(f"{collection_slug}--{entry_slug}")

    @classmethod
    def build_public_report_url(cls, collection_slug: str, entry_slug: str) -> str:
        return f"/published/{collection_slug}/{entry_slug}"

    @classmethod
    def ensure_unique_entry_slug(cls, collection_slug: str, entry_slug: str, now: datetime) -> str:
        candidate = entry_slug
        path = os.path.join(cls.published_dir(), f"{cls.build_storage_slug(collection_slug, candidate)}.json")
        if not os.path.exists(path):
            return candidate
        return _slugify(f"{entry_slug}-{now.strftime('%H%M%S')}")

    @classmethod
    def load_collection_entry(cls, collection_slug: str, entry_slug: str) -> Optional[Dict[str, Any]]:
        return cls.load_published_report(cls.build_storage_slug(collection_slug, entry_slug))

    @classmethod
    def list_collection_entries(cls, collection_slug: str) -> list[Dict[str, Any]]:
        items: list[Dict[str, Any]] = []
        if not os.path.exists(cls.published_dir()):
            return items

        for filename in os.listdir(cls.published_dir()):
            if not filename.endswith(".json"):
                continue
            path = os.path.join(cls.published_dir(), filename)
            try:
                with open(path, "r", encoding="utf-8") as f:
                    payload = json.load(f)
            except Exception:
                continue

            metadata = payload.get("metadata") or {}
            if (metadata.get("collection_slug") or "") != collection_slug:
                continue

            entry_slug = str(metadata.get("entry_slug") or "").strip()
            if not entry_slug:
                continue

            items.append(
                {
                    "entry_slug": entry_slug,
                    "title": payload.get("title"),
                    "published_at": payload.get("published_at"),
                    "url": cls.build_public_report_url(collection_slug, entry_slug),
                }
            )

        items.sort(key=lambda item: item.get("published_at") or "", reverse=True)
        return items

    @classmethod
    def extract_title_brief(cls, content: str) -> str:
        lines = [line.strip() for line in str(content or "").splitlines() if line.strip()]
        for line in lines:
            cleaned = re.sub(r"^#+\s*", "", line)
            cleaned = re.sub(r"^[\-\*\d\.\)\s]+", "", cleaned).strip()
            cleaned = re.sub(r"`+", "", cleaned)
            if not cleaned:
                continue
            if len(cleaned) > 42:
                cleaned = f"{cleaned[:42].rstrip('，。；：,: ')}..."
            return cleaned
        return "市场复盘简报"

    @classmethod
    def build_publish_title(cls, template: str, now: datetime, content: str) -> str:
        normalized = (template or "{date} · {brief}").strip()
        brief = cls.extract_title_brief(content)
        if "{" in normalized and "}" in normalized:
            rendered = _render_template(normalized, now).replace("{brief}", brief)
            return rendered.strip()
        return f"{now.strftime('%Y-%m-%d')} · {brief}"

    @classmethod
    def build_publish_slug(cls, template: str, title: str, now: datetime) -> str:
        normalized = (template or "").strip()
        if normalized:
            if "{" in normalized and "}" in normalized:
                return _slugify(_render_template(normalized, now))
            return _slugify(f"{normalized}-{now.strftime('%Y%m%d')}")
        return _slugify(title)

    @classmethod
    def ensure_unique_slug(cls, slug: str, now: datetime) -> str:
        candidate = slug
        path = os.path.join(cls.published_dir(), f"{candidate}.json")
        if not os.path.exists(path):
            return candidate
        return _slugify(f"{slug}-{now.strftime('%H%M%S')}")

    @classmethod
    async def execute_skill_publish_job(cls, *, task_id: str, params: Dict[str, Any]) -> Dict[str, Any]:
        db: Session = SessionLocal()
        try:
            user_id = params.get("user_id")
            if not user_id:
                raise ValueError("缺少 user_id，无法执行自动化任务")

            user = db.query(User).filter(User.id == int(user_id)).first()
            if not user:
                raise ValueError(f"用户不存在: {user_id}")

            skill_name = (params.get("skill_name") or "research").strip()
            prompt_template = (params.get("prompt_template") or "").strip()
            if not prompt_template:
                raise ValueError("缺少 prompt_template，无法执行自动化任务")

            now = datetime.now()
            collection_slug = cls.build_collection_slug(params.get("publish_collection_slug"))
            entry_slug = cls.ensure_unique_entry_slug(
                collection_slug,
                cls.build_entry_slug(str(params.get("publish_slug") or ""), now),
                now,
            )
            publish_slug = cls.build_storage_slug(collection_slug, entry_slug)
            publish_title_template = str(params.get("publish_title") or "{date} · {brief}")
            enable_web_search = bool(params.get("enable_web_search"))
            mcp_servers = params.get("mcp_servers") if isinstance(params.get("mcp_servers"), list) else []

            account_context = None
            account_id = params.get("account_id")
            account_provider = params.get("account_provider")
            if account_id is not None and account_provider:
                account_context = {
                    "account_id": account_id,
                    "provider": account_provider,
                    "name": params.get("account_name"),
                }

            user_prompt = prompt_template.format(
                date=now.strftime("%Y-%m-%d"),
                date_compact=now.strftime("%Y%m%d"),
                datetime=now.strftime("%Y-%m-%d %H:%M:%S"),
                datetime_compact=now.strftime("%Y%m%d-%H%M%S"),
            )

            automation_session_id = f"automation-{task_id}-{now.strftime('%Y%m%d')}"

            message = ChannelMessage(
                channel="web_chat",
                session_id=automation_session_id,
                user_id=user.id,
                content=user_prompt,
                metadata={
                    "forced_role": skill_name,
                    "account_context": account_context,
                    "automation": {
                        "task_id": task_id,
                        "mcp_servers": mcp_servers,
                        "publish_title_template": publish_title_template,
                    },
                },
            )

            reply = await AgentService.process_channel_message(
                message=message,
                db=db,
                user=user,
                enable_web_search=enable_web_search,
                model=params.get("model"),
            )

            publish_title = cls.build_publish_title(
                publish_title_template,
                now,
                reply.content,
            )

            published = cls.write_published_report(
                slug=publish_slug,
                title=publish_title,
                content=reply.content,
                metadata={
                    "task_id": task_id,
                    "skill_name": skill_name,
                    "mcp_servers": mcp_servers,
                    "tool_outputs": reply.tool_outputs or [],
                    "user_id": user.id,
                    "collection_slug": collection_slug,
                    "entry_slug": entry_slug,
                    "publish_title_template": params.get("publish_title"),
                    "publish_collection_slug": params.get("publish_collection_slug"),
                    "publish_slug_template": params.get("publish_slug"),
                },
            )

            return {
                "task_id": task_id,
                "session_id": automation_session_id,
                "status": "success",
                "skill_name": skill_name,
                "collection_slug": collection_slug,
                "entry_slug": entry_slug,
                "published_slug": publish_slug,
                "published_url": cls.build_public_report_url(collection_slug, entry_slug),
                "report_api_url": f"/api/v1/reports/collections/{collection_slug}/{entry_slug}",
                "title": published["title"],
                "content_preview": reply.content[:500],
                "tool_outputs": reply.tool_outputs or [],
                "published_at": published["published_at"],
            }
        finally:
            db.close()
