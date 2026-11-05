"""Atomic storage scoped to rotation; no existing strategy/backtest files are touched."""

import json
import os
import re
import threading
import uuid
from pathlib import Path


class Store:
    def __init__(self, data_dir):
        self.root = Path(data_dir) / "etf_rotation"
        self.root.mkdir(parents=True, exist_ok=True)
        self.lock = threading.RLock()

    def path(self, kind, identifier):
        if kind not in {"configs", "jobs", "inputs", "results"} or not re.fullmatch(
            r"[a-f0-9]{32}", identifier
        ):
            raise ValueError("非法记录ID")
        path = self.root / kind / (identifier + ".json")
        if path.is_symlink() or path.parent.is_symlink():
            raise ValueError("禁止访问符号链接")
        return path

    def read(self, kind, identifier):
        path = self.path(kind, identifier)
        if not path.exists():
            raise FileNotFoundError("记录不存在")
        return json.loads(path.read_text(encoding="utf-8"))

    def write(self, kind, identifier, payload):
        path = self.path(kind, identifier)
        path.parent.mkdir(parents=True, exist_ok=True)
        temp = path.with_suffix("." + uuid.uuid4().hex + ".tmp")
        try:
            temp.write_text(
                json.dumps(payload, ensure_ascii=False, allow_nan=False), encoding="utf-8"
            )
            os.replace(temp, path)
        finally:
            temp.unlink(missing_ok=True)

    def list(self, kind):
        root = self.root / kind
        if root.is_symlink():
            raise ValueError("禁止访问符号链接")
        return [
            self.read(kind, p.stem)
            for p in sorted(root.glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True)
        ]
