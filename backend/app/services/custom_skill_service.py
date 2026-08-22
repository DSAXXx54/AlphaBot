from __future__ import annotations

from dataclasses import dataclass
import json
from pathlib import Path
import re
from typing import Any, Dict, Iterable, List, Optional

import yaml
from app.core.config import settings


@dataclass
class CustomSkillInfo:
    name: str
    label: str
    description: str
    enabled: bool = True


class CustomSkillService:
    TEXT_EXTENSIONS = {".md", ".txt", ".json", ".yaml", ".yml"}
    MAX_REFERENCE_FILES = 12
    REGISTRY_FILENAME = "skill_registry.json"

    @classmethod
    def skills_root(cls) -> Path:
        return Path(settings.BASE_DIR).resolve() / "data" / "skills"

    @classmethod
    def skill_dir(cls, name: str) -> Path:
        return cls.skills_root() / name

    @classmethod
    def registry_path(cls) -> Path:
        return cls.skills_root() / cls.REGISTRY_FILENAME

    @classmethod
    def skill_exists(cls, name: str, include_disabled: bool = False) -> bool:
        skill_dir = cls.skill_dir(name)
        if not (skill_dir.is_dir() and (skill_dir / "SKILL.md").is_file()):
            return False
        if include_disabled:
            return True
        return cls.is_skill_enabled(name)

    @classmethod
    def is_skill_enabled(cls, name: str) -> bool:
        disabled_skills = set(cls._load_registry().get("disabled_skills") or [])
        return name not in disabled_skills

    @classmethod
    def set_skill_enabled(cls, name: str, enabled: bool) -> bool:
        if not cls.skill_exists(name, include_disabled=True):
            return False

        registry = cls._load_registry()
        disabled_skills = set(registry.get("disabled_skills") or [])
        if enabled:
            disabled_skills.discard(name)
        else:
            disabled_skills.add(name)

        registry["disabled_skills"] = sorted(disabled_skills)
        cls._save_registry(registry)
        return True

    @classmethod
    def list_skills(cls, include_disabled: bool = False) -> List[CustomSkillInfo]:
        root = cls.skills_root()
        if not root.exists():
            return []

        registry = cls._load_registry()
        disabled_skills = set(registry.get("disabled_skills") or [])
        skills: List[CustomSkillInfo] = []
        for item in sorted(root.iterdir()):
            if not item.is_dir():
                continue
            skill_md = item / "SKILL.md"
            if not skill_md.is_file():
                continue
            content = skill_md.read_text(encoding="utf-8")
            frontmatter, body = cls._parse_frontmatter(content)
            enabled = item.name not in disabled_skills
            if not include_disabled and not enabled:
                continue
            label = str(frontmatter.get("title") or frontmatter.get("name") or item.name).strip()
            description = str(frontmatter.get("description") or cls._extract_description(body or content) or "本地自定义 Skill").strip()
            skills.append(
                CustomSkillInfo(
                    name=item.name,
                    label=label or item.name,
                    description=description or "本地自定义 Skill",
                    enabled=enabled,
                )
            )
        return skills

    @classmethod
    def build_system_prompt(cls, name: str) -> Optional[str]:
        if not cls.skill_exists(name, include_disabled=False):
            return None

        skill_dir = cls.skill_dir(name)
        parts: List[str] = []

        skill_md = (skill_dir / "SKILL.md").read_text(encoding="utf-8").strip()
        if skill_md:
            parts.append(f"【自定义 Skill：{name}】\n{skill_md}")

        reference_blocks = cls._load_reference_blocks(skill_dir / "references")
        if reference_blocks:
            parts.append("【Skill References】\n" + "\n\n".join(reference_blocks))

        return "\n\n".join(parts).strip() or None

    @classmethod
    def match_skill(cls, user_message: str) -> Optional[str]:
        text = (user_message or "").strip().lower()
        if not text:
            return None

        for skill in cls.list_skills():
            for trigger in cls._collect_trigger_phrases(skill.name):
                if trigger and trigger.lower() in text:
                    return skill.name
        return None

    @classmethod
    def _load_reference_blocks(cls, references_dir: Path) -> List[str]:
        if not references_dir.is_dir():
            return []

        blocks: List[str] = []
        for path in cls._iter_reference_files(references_dir):
            try:
                content = path.read_text(encoding="utf-8").strip()
            except Exception:
                continue
            if not content:
                continue
            relative_name = path.relative_to(references_dir).as_posix()
            blocks.append(f"[{relative_name}]\n{content}")
            if len(blocks) >= cls.MAX_REFERENCE_FILES:
                break
        return blocks

    @classmethod
    def _iter_reference_files(cls, references_dir: Path) -> Iterable[Path]:
        for path in sorted(references_dir.rglob("*")):
            if path.is_file() and path.suffix.lower() in cls.TEXT_EXTENSIONS:
                yield path

    @classmethod
    def _load_registry(cls) -> Dict[str, Any]:
        path = cls.registry_path()
        if not path.exists():
            return {"disabled_skills": []}
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            return {"disabled_skills": []}
        disabled_skills = raw.get("disabled_skills")
        if not isinstance(disabled_skills, list):
            disabled_skills = []
        return {"disabled_skills": [str(item) for item in disabled_skills if str(item).strip()]}

    @classmethod
    def _save_registry(cls, payload: Dict[str, Any]) -> None:
        path = cls.registry_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )

    @classmethod
    def _parse_frontmatter(cls, content: str) -> tuple[Dict[str, Any], str]:
        if not content.startswith("---\n"):
            return {}, content

        end_marker = "\n---\n"
        end_index = content.find(end_marker, 4)
        if end_index == -1:
            return {}, content

        frontmatter_text = content[4:end_index]
        body = content[end_index + len(end_marker):]
        try:
            parsed = yaml.safe_load(frontmatter_text) or {}
        except Exception:
            parsed = {}
        if not isinstance(parsed, dict):
            parsed = {}
        return parsed, body

    @classmethod
    def _extract_description(cls, content: str) -> str:
        for line in content.splitlines():
            normalized = line.strip()
            if normalized and not normalized.startswith("#"):
                return normalized[:80]
        return ""

    @classmethod
    def _collect_trigger_phrases(cls, name: str) -> List[str]:
        skill_dir = cls.skill_dir(name)
        skill_md = skill_dir / "SKILL.md"
        if not skill_md.is_file():
            return [name]

        content = skill_md.read_text(encoding="utf-8")
        frontmatter, body = cls._parse_frontmatter(content)
        phrases: List[str] = [name]

        for raw in [
            str(frontmatter.get("name") or ""),
            str(frontmatter.get("title") or ""),
            str(frontmatter.get("description") or ""),
        ]:
            phrases.extend(cls._extract_quoted_phrases(raw))

        phrases.extend(cls._extract_usage_phrases(body))

        seen = set()
        normalized_phrases: List[str] = []
        for phrase in phrases:
            cleaned = phrase.strip().strip(".,;:()[]{}\"'`")
            if len(cleaned) < 2:
                continue
            key = cleaned.lower()
            if key in seen:
                continue
            seen.add(key)
            normalized_phrases.append(cleaned)
        return normalized_phrases

    @classmethod
    def _extract_quoted_phrases(cls, content: str) -> List[str]:
        if not content:
            return []
        results: List[str] = []
        results.extend(re.findall(r'"([^"]{2,40})"', content))
        results.extend(re.findall(r"'([^']{2,40})'", content))
        return results

    @classmethod
    def _extract_usage_phrases(cls, body: str) -> List[str]:
        if not body:
            return []

        match = re.search(r"##\s*2\.\s*何时使用(.*?)(?:\n##\s*3\.|\Z)", body, flags=re.S)
        if not match:
            return []

        block = match.group(1)
        phrases: List[str] = []
        for line in block.splitlines():
            normalized = line.strip().lstrip("-").strip()
            if not normalized:
                continue
            phrases.extend(cls._extract_quoted_phrases(normalized))
        return phrases
