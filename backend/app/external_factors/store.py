"""外部因子定义的独立 JSON 存储。"""
from __future__ import annotations

import json
import logging
from datetime import datetime
from pathlib import Path

from app.services.fs_utils import atomic_write_text

from .models import EXTERNAL_FACTOR_ID_PATTERN, ExternalFactorDefinition

logger = logging.getLogger(__name__)


class ExternalFactorStore:
    def __init__(self, data_dir: Path) -> None:
        self._base = Path(data_dir) / "user_data" / "external_factors"

    def _path(self, factor_id: str) -> Path:
        if not EXTERNAL_FACTOR_ID_PATTERN.fullmatch(factor_id):
            raise ValueError(f"非法 external factor id: {factor_id!r}")
        return self._base / f"{factor_id}.json"

    def load_all(self) -> list[ExternalFactorDefinition]:
        self._base.mkdir(parents=True, exist_ok=True)
        definitions: list[ExternalFactorDefinition] = []
        for path in sorted(self._base.glob("*.json")):
            try:
                definitions.append(ExternalFactorDefinition.from_dict(
                    json.loads(path.read_text(encoding="utf-8"))
                ))
            except Exception as exc:
                logger.warning("external factor load failed %s: %s", path.name, exc)
        return definitions

    def get(self, factor_id: str) -> ExternalFactorDefinition | None:
        try:
            path = self._path(factor_id)
        except ValueError:
            return None
        if not path.exists():
            return None
        try:
            return ExternalFactorDefinition.from_dict(
                json.loads(path.read_text(encoding="utf-8"))
            )
        except Exception as exc:
            logger.warning("external factor load failed %s: %s", path.name, exc)
            return None

    def save(self, definition: ExternalFactorDefinition) -> None:
        path = self._path(definition.id)
        path.parent.mkdir(parents=True, exist_ok=True)
        atomic_write_text(path, json.dumps(definition.to_dict(), ensure_ascii=False, indent=2))

    def delete(self, factor_id: str) -> bool:
        try:
            path = self._path(factor_id)
        except ValueError:
            return False
        if not path.exists():
            return False
        path.unlink()
        return True

    def signature(self) -> tuple:
        self._base.mkdir(parents=True, exist_ok=True)
        try:
            return tuple(
                (path.name, path.stat().st_mtime_ns, path.stat().st_size)
                for path in sorted(self._base.glob("*.json"))
            )
        except OSError:
            return ()


def now() -> str:
    return datetime.now().isoformat(timespec="seconds")
