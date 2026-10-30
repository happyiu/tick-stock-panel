"""Immutable SQLite snapshots, separate from market and strategy data."""

import hashlib
import json
import sqlite3
from contextlib import closing

from app.market_time import cn_now


def connect():
    from app.config import settings

    path = settings.data_dir / "user_data" / "wave_history.sqlite3"
    path.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(path, timeout=10)
    db.execute(
        "CREATE TABLE IF NOT EXISTS snapshots(id TEXT PRIMARY KEY,symbol TEXT,asset TEXT,cutoff TEXT,created TEXT,payload TEXT)"
    )
    return db


def save(payload):
    body = json.dumps(payload, sort_keys=True, ensure_ascii=False)
    identity = {k: payload.get(k) for k in ("symbol", "asset_type", "asOf", "version")}
    identity["inputs"] = {
        k: v.get("inputFingerprint", v.get("status")) for k, v in payload.get("periods", {}).items()
    }
    ident = hashlib.sha256(json.dumps(identity, sort_keys=True).encode()).hexdigest()
    with closing(connect()) as db, db:
        db.execute(
            "INSERT OR IGNORE INTO snapshots VALUES(?,?,?,?,?,?)",
            (
                ident,
                payload["symbol"],
                payload["asset_type"],
                payload["asOf"],
                cn_now().isoformat(),
                body,
            ),
        )
    return ident


def history(symbol, asset):
    with closing(connect()) as db, db:
        return [
            dict(id=r[0], asOf=r[1], createdAt=r[2])
            for r in db.execute(
                "SELECT id,cutoff,created FROM snapshots WHERE symbol=? AND asset=? ORDER BY cutoff DESC,created DESC LIMIT 100",
                (symbol, asset),
            )
        ]


def read(ident):
    with closing(connect()) as db, db:
        row = db.execute("SELECT payload FROM snapshots WHERE id=?", (ident,)).fetchone()
        return json.loads(row[0]) if row else None
