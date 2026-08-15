"""SQLite (WAL) — phiên chơi, lượt thử, sự kiện.

Schema giữ đúng SPEC §9. Đây là nền cho dashboard bố mẹ ở giai đoạn sau,
nên đừng xoá cột, chỉ thêm.
"""
import sqlite3
import threading
import time
from pathlib import Path
from typing import Any, Iterable

from . import config

_local = threading.local()

SCHEMA = """
PRAGMA journal_mode=WAL;
PRAGMA synchronous=NORMAL;

CREATE TABLE IF NOT EXISTS sessions(
  id TEXT PRIMARY KEY, kid_id TEXT, game_id TEXT,
  started_at INTEGER, ended_at INTEGER
);

CREATE TABLE IF NOT EXISTS attempts(
  id INTEGER PRIMARY KEY,
  session_id TEXT, kid_id TEXT, game_id TEXT,
  expected TEXT, best TEXT,
  best_prob REAL, margin REAL,
  accepted INTEGER,
  source TEXT,
  audio_ms INTEGER, compute_ms INTEGER,
  clip_path TEXT,
  created_at INTEGER
);

CREATE TABLE IF NOT EXISTS events(
  id INTEGER PRIMARY KEY,
  session_id TEXT, kid_id TEXT, game_id TEXT,
  type TEXT, payload TEXT,
  created_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_attempts_kid_word ON attempts(kid_id, expected);
CREATE INDEX IF NOT EXISTS idx_attempts_session ON attempts(session_id);
CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id);
"""


def conn() -> sqlite3.Connection:
    """Một kết nối cho mỗi thread (uvicorn chạy sync route trong threadpool)."""
    c = getattr(_local, "conn", None)
    if c is None:
        config.DB_PATH.parent.mkdir(parents=True, exist_ok=True)
        c = sqlite3.connect(config.DB_PATH, timeout=10, check_same_thread=False)
        c.row_factory = sqlite3.Row
        c.execute("PRAGMA journal_mode=WAL")
        c.execute("PRAGMA synchronous=NORMAL")
        _local.conn = c
    return c


def init() -> None:
    config.DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    c = conn()
    c.executescript(SCHEMA)
    c.commit()


def now_ms() -> int:
    return int(time.time() * 1000)


def touch_session(session_id: str, kid_id: str, game_id: str) -> None:
    if not session_id:
        return
    c = conn()
    c.execute(
        "INSERT OR IGNORE INTO sessions(id,kid_id,game_id,started_at) VALUES(?,?,?,?)",
        (session_id, kid_id, game_id, now_ms()),
    )
    c.commit()


def end_session(session_id: str) -> None:
    c = conn()
    c.execute("UPDATE sessions SET ended_at=? WHERE id=? AND ended_at IS NULL",
              (now_ms(), session_id))
    c.commit()


def insert_attempt(row: dict[str, Any]) -> int:
    c = conn()
    cur = c.execute(
        """INSERT INTO attempts(session_id,kid_id,game_id,expected,best,best_prob,
             margin,accepted,source,audio_ms,compute_ms,clip_path,created_at)
           VALUES(:session_id,:kid_id,:game_id,:expected,:best,:best_prob,:margin,
             :accepted,:source,:audio_ms,:compute_ms,:clip_path,:created_at)""",
        {
            "session_id": row.get("session_id"),
            "kid_id": row.get("kid_id"),
            "game_id": row.get("game_id"),
            "expected": row.get("expected"),
            "best": row.get("best"),
            "best_prob": row.get("best_prob"),
            "margin": row.get("margin"),
            "accepted": int(bool(row.get("accepted"))),
            "source": row.get("source"),
            "audio_ms": row.get("audio_ms"),
            "compute_ms": row.get("compute_ms"),
            "clip_path": row.get("clip_path"),
            "created_at": row.get("created_at") or now_ms(),
        },
    )
    c.commit()
    return int(cur.lastrowid)


def insert_events(events: Iterable[dict[str, Any]]) -> int:
    import json

    c = conn()
    n = 0
    for e in events:
        etype = str(e.get("type", ""))[:64]
        if not etype:
            continue
        # Lượt thử phía trình duyệt cũng phải nằm trong bảng attempts
        # (SPEC §12.8: mọi lượt thử đều sinh một dòng).
        if etype == "attempt":
            p = e.get("payload") or {}
            insert_attempt(
                {
                    "session_id": e.get("session_id"),
                    "kid_id": e.get("kid_id"),
                    "game_id": e.get("game_id"),
                    "expected": p.get("expected"),
                    "best": p.get("best"),
                    "best_prob": p.get("best_prob"),
                    "margin": p.get("margin"),
                    "accepted": p.get("accepted"),
                    "source": p.get("source"),
                    "audio_ms": p.get("audio_ms"),
                    "compute_ms": p.get("compute_ms"),
                    "clip_path": p.get("clip_path"),
                    "created_at": e.get("at"),
                }
            )
            n += 1
            continue
        c.execute(
            "INSERT INTO events(session_id,kid_id,game_id,type,payload,created_at)"
            " VALUES(?,?,?,?,?,?)",
            (
                e.get("session_id"),
                e.get("kid_id"),
                e.get("game_id"),
                etype,
                json.dumps(e.get("payload"), ensure_ascii=False),
                e.get("at") or now_ms(),
            ),
        )
        n += 1
    c.commit()
    return n


def kid_stats(kid_id: str, days: int = 14) -> list[dict[str, Any]]:
    """Thống kê theo từ — để về sau chỉnh ngưỡng bằng dữ liệu thật."""
    since = now_ms() - days * 86400_000
    c = conn()
    rows = c.execute(
        """SELECT expected, COUNT(*) n, SUM(accepted) ok, AVG(best_prob) avg_prob
           FROM attempts WHERE kid_id=? AND created_at>=? AND expected IS NOT NULL
           GROUP BY expected ORDER BY n DESC LIMIT 200""",
        (kid_id, since),
    ).fetchall()
    return [dict(r) for r in rows]


def purge_old_clips() -> int:
    """Xoá clip cũ hơn CLIP_RETENTION_DAYS. Gọi lúc khởi động."""
    import datetime
    import shutil

    root = config.CLIPS_DIR
    if not root.exists():
        return 0
    cutoff = datetime.date.today() - datetime.timedelta(days=config.CLIP_RETENTION_DAYS)
    removed = 0
    for day in root.iterdir():
        if not day.is_dir():
            continue
        try:
            d = datetime.date.fromisoformat(day.name)
        except ValueError:
            continue
        if d < cutoff:
            shutil.rmtree(day, ignore_errors=True)
            removed += 1
    return removed


def clip_dir_for_today() -> Path:
    import datetime

    d = config.CLIPS_DIR / datetime.date.today().isoformat()
    d.mkdir(parents=True, exist_ok=True)
    return d
