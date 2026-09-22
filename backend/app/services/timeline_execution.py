"""时间轴定时任务执行记录的 SQLite 持久化。"""
from __future__ import annotations

import json
import sqlite3
import threading
import uuid
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Literal

from app.config import settings
from app.market_time import cn_now

TimelineStatus = Literal["running", "succeeded", "failed", "skipped"]


class TimelineExecutionStore:
    """独立的时间轴任务记录库,每次读写使用独立连接。"""

    def __init__(self, data_dir: Path | None = None) -> None:
        root = (data_dir or settings.data_dir) / "user_data"
        root.mkdir(parents=True, exist_ok=True)
        self.path = root / "timeline.sqlite3"
        self._lock = threading.RLock()
        self._init_schema()

    @contextmanager
    def connection(self) -> Iterator[sqlite3.Connection]:
        with self._lock:
            con = sqlite3.connect(self.path, timeout=10)
            con.row_factory = sqlite3.Row
            con.execute("PRAGMA journal_mode=WAL")
            try:
                with con:
                    yield con
            finally:
                con.close()

    def _init_schema(self) -> None:
        with self.connection() as con:
            con.executescript(
                """
                CREATE TABLE IF NOT EXISTS timeline_task_runs (
                  id TEXT PRIMARY KEY,
                  timeline_date TEXT NOT NULL,
                  scheduled_time TEXT NOT NULL,
                  task_name TEXT NOT NULL,
                  method TEXT NOT NULL,
                  status TEXT NOT NULL CHECK(status IN ('running','succeeded','failed','skipped')),
                  started_at TEXT NOT NULL,
                  finished_at TEXT,
                  session_id TEXT,
                  result_json TEXT,
                  error TEXT
                );
                CREATE INDEX IF NOT EXISTS timeline_task_runs_date
                  ON timeline_task_runs(timeline_date, scheduled_time);
                CREATE INDEX IF NOT EXISTS timeline_task_runs_method
                  ON timeline_task_runs(method, started_at);
                """,
            )

    def start(
        self,
        *,
        task_name: str,
        method: str,
        timeline_date: str | None = None,
        scheduled_time: str | None = None,
        session_id: str | None = None,
    ) -> str:
        now = cn_now()
        run_id = f"tl_{uuid.uuid4().hex[:16]}"
        with self.connection() as con:
            con.execute(
                """INSERT INTO timeline_task_runs(
                   id,timeline_date,scheduled_time,task_name,method,status,started_at,session_id
                ) VALUES (?,?,?,?,?,?,?,?)""",
                (
                    run_id,
                    timeline_date or now.date().isoformat(),
                    scheduled_time or now.strftime("%H:%M"),
                    task_name.strip() or method.strip(),
                    method.strip(),
                    "running",
                    now.isoformat(timespec="seconds"),
                    session_id,
                ),
            )
        return run_id

    def finish(
        self,
        run_id: str,
        *,
        status: TimelineStatus,
        result: Any = None,
        error: str | None = None,
        session_id: str | None = None,
    ) -> None:
        finished_at = cn_now().isoformat(timespec="seconds")
        result_json = json.dumps(result, ensure_ascii=False, default=str) if result is not None else None
        with self.connection() as con:
            con.execute(
                """UPDATE timeline_task_runs
                   SET status=?,finished_at=?,session_id=COALESCE(?,session_id),
                       result_json=?,error=?
                   WHERE id=?""",
                (status, finished_at, session_id, result_json, error, run_id),
            )

    def restart(self, run_id: str) -> bool:
        """复用原记录重试,覆盖上一次执行内容。"""
        started_at = cn_now().isoformat(timespec="seconds")
        with self.connection() as con:
            cursor = con.execute(
                """UPDATE timeline_task_runs
                   SET status='running',started_at=?,finished_at=NULL,
                       session_id=NULL,result_json=NULL,error=NULL
                   WHERE id=?""",
                (started_at, run_id),
            )
        return cursor.rowcount > 0

    def get(self, run_id: str) -> dict[str, Any] | None:
        with self.connection() as con:
            row = con.execute(
                """SELECT id,timeline_date,scheduled_time,task_name,method,status,
                          started_at,finished_at,session_id,result_json,error
                   FROM timeline_task_runs WHERE id=?""",
                (run_id,),
            ).fetchone()
        return self._decode_row(row) if row else None

    def list(
        self,
        *,
        timeline_date: str | None = None,
        method: str | None = None,
        limit: int = 100,
    ) -> list[dict[str, Any]]:
        clauses: list[str] = []
        params: list[Any] = []
        if timeline_date:
            clauses.append("timeline_date=?")
            params.append(timeline_date)
        if method:
            clauses.append("method=?")
            params.append(method.strip())
        where = f" WHERE {' AND '.join(clauses)}" if clauses else ""
        params.append(max(1, min(int(limit), 500)))
        with self.connection() as con:
            rows = con.execute(
                """SELECT id,timeline_date,scheduled_time,task_name,method,status,
                          started_at,finished_at,session_id,result_json,error
                   FROM timeline_task_runs"""
                + where
                + " ORDER BY timeline_date DESC, scheduled_time DESC, started_at DESC LIMIT ?",
                params,
            ).fetchall()
        return [self._decode_row(row) for row in rows]

    @staticmethod
    def _decode_row(row: sqlite3.Row) -> dict[str, Any]:
        item = dict(row)
        raw_result = item.pop("result_json", None)
        if raw_result:
            try:
                item["result"] = json.loads(raw_result)
            except (TypeError, ValueError):
                item["result"] = raw_result
        else:
            item["result"] = None
        return item


timeline_execution_store = TimelineExecutionStore()
