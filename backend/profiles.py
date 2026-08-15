"""Hồ sơ trẻ + kho video thưởng.

Quy tắc SPEC §6:
  - sửa profile.json có hiệu lực ở lần tải trang sau, KHÔNG restart service
    (đọc lại theo mtime)
  - thêm video = copy file vào kids/<id>/rewards/, KHÔNG restart
  - thư mục rỗng -> rơi về kids/_default/rewards/
"""
from __future__ import annotations

import json
import random
import re
import shutil
import threading
import time
import unicodedata
from pathlib import Path
from typing import Any

from . import config

DEFAULT_PROFILE: dict[str, Any] = {
    "name": "",
    "age": 4,
    "avatar": "🚜",
    "praise": "{name} giỏi quá!",
    "tts_rate": 0.8,
    "asr": {"threshold": 0.45, "margin": 0.12, "max_wrong_before_hint": 2},
    "games": {},
    "rewards": {"stars_needed": 3},
}

_cache: dict[str, tuple[float, dict[str, Any]]] = {}
_lock = threading.Lock()
# video vừa chiếu cho từng bé — để không lặp lại ngay
_last_reward: dict[str, str] = {}

_ID_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,31}$")


def valid_id(kid_id: str) -> bool:
    return bool(_ID_RE.match(kid_id or ""))


def _merge(base: dict, over: dict) -> dict:
    out = dict(base)
    for k, v in (over or {}).items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = _merge(out[k], v)
        else:
            out[k] = v
    return out


def kid_dir(kid_id: str) -> Path:
    return config.KIDS_DIR / kid_id


def profile_path(kid_id: str) -> Path:
    return kid_dir(kid_id) / "profile.json"


def rewards_dir(kid_id: str) -> Path:
    return kid_dir(kid_id) / "rewards"


def list_kid_ids() -> list[str]:
    if not config.KIDS_DIR.exists():
        return []
    ids = []
    for p in sorted(config.KIDS_DIR.iterdir()):
        if p.is_dir() and not p.name.startswith("_") and (p / "profile.json").exists():
            ids.append(p.name)
    return ids


def load(kid_id: str) -> dict[str, Any] | None:
    """Đọc hồ sơ, cache theo mtime nên sửa file là ăn ngay."""
    if not valid_id(kid_id):
        return None
    path = profile_path(kid_id)
    if not path.exists():
        return None
    mtime = path.stat().st_mtime
    with _lock:
        hit = _cache.get(kid_id)
        if hit and hit[0] == mtime:
            return hit[1]
    try:
        raw = json.loads(path.read_text("utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    prof = _merge(DEFAULT_PROFILE, raw)
    prof["id"] = kid_id
    if not prof.get("name"):
        prof["name"] = kid_id.capitalize()
    with _lock:
        _cache[kid_id] = (mtime, prof)
    return prof


def save(kid_id: str, data: dict[str, Any]) -> dict[str, Any]:
    """Ghi hồ sơ (dùng bởi trang quản trị). Ghi nguyên tử qua file tạm."""
    if not valid_id(kid_id):
        raise ValueError("kid_id không hợp lệ")
    d = kid_dir(kid_id)
    d.mkdir(parents=True, exist_ok=True)
    rewards_dir(kid_id).mkdir(exist_ok=True)
    data = dict(data)
    data["id"] = kid_id
    tmp = profile_path(kid_id).with_suffix(".json.tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), "utf-8")
    tmp.replace(profile_path(kid_id))
    with _lock:
        _cache.pop(kid_id, None)
    return load(kid_id) or data


def all_kids() -> list[dict[str, Any]]:
    out = []
    for kid_id in list_kid_ids():
        p = load(kid_id)
        if p:
            out.append(p)
    return out


def public(prof: dict[str, Any]) -> dict[str, Any]:
    """Bản gửi ra client — không lộ đường dẫn hệ thống."""
    return {
        "id": prof["id"],
        "name": prof.get("name"),
        "age": prof.get("age"),
        "avatar": prof.get("avatar"),
        "praise": prof.get("praise"),
        "tts_rate": prof.get("tts_rate"),
        "asr": prof.get("asr", {}),
        "games": prof.get("games", {}),
        "rewards": {
            "stars_needed": (prof.get("rewards") or {}).get("stars_needed", 3),
            "count": len(list_rewards(prof["id"])),
        },
    }


# --- video thưởng ------------------------------------------------------------

def _videos_in(d: Path) -> list[Path]:
    if not d.exists():
        return []
    return sorted(
        p for p in d.iterdir()
        if p.is_file() and p.suffix.lower() in config.VIDEO_EXT and not p.name.startswith(".")
    )


def list_rewards(kid_id: str) -> list[dict[str, Any]]:
    """Video của riêng bé. Rỗng -> danh sách mặc định."""
    vids = _videos_in(rewards_dir(kid_id))
    owner = kid_id
    if not vids:
        vids = _videos_in(config.KIDS_DIR / "_default" / "rewards")
        owner = "_default"
    return [
        {
            "name": v.name,
            "url": f"/media/rewards/{owner}/{v.name}",
            "size_mb": round(v.stat().st_size / 1048576, 1),
            "own": owner == kid_id,
        }
        for v in vids
    ]


def reward_file(owner: str, name: str) -> Path | None:
    """Giải đường dẫn file video, chống path traversal."""
    if owner != "_default" and not valid_id(owner):
        return None
    if "/" in name or "\\" in name or name.startswith("."):
        return None
    base = (config.KIDS_DIR / owner / "rewards").resolve()
    p = (base / name).resolve()
    if not str(p).startswith(str(base)) or not p.is_file():
        return None
    if p.suffix.lower() not in config.VIDEO_EXT:
        return None
    return p


def pick_reward(kid_id: str) -> dict[str, Any] | None:
    """Chọn ngẫu nhiên, tránh lặp lại video vừa chiếu."""
    vids = list_rewards(kid_id)
    if not vids:
        return None
    if len(vids) > 1:
        last = _last_reward.get(kid_id)
        pool = [v for v in vids if v["url"] != last] or vids
    else:
        pool = vids
    chosen = random.choice(pool)
    _last_reward[kid_id] = chosen["url"]
    return chosen


def safe_filename(name: str) -> str:
    """Tên file an toàn, giữ được chữ tiếng Việt bằng cách bỏ dấu."""
    name = Path(name or "").name
    stem, dot, ext = name.rpartition(".")
    if not dot:
        stem, ext = name, "mp4"
    stem = unicodedata.normalize("NFD", stem)
    stem = "".join(c for c in stem if unicodedata.category(c) != "Mn")
    stem = stem.replace("đ", "d").replace("Đ", "D")
    stem = re.sub(r"[^A-Za-z0-9._-]+", "-", stem).strip("-.") or "video"
    ext = re.sub(r"[^A-Za-z0-9]+", "", ext).lower() or "mp4"
    return f"{stem[:60]}.{ext}"


def add_reward(kid_id: str, filename: str, src: Any) -> dict[str, Any]:
    """Lưu file upload vào kho video của bé. src là file-like."""
    if not valid_id(kid_id) and kid_id != "_default":
        raise ValueError("kid_id không hợp lệ")
    d = rewards_dir(kid_id) if kid_id != "_default" else config.KIDS_DIR / "_default" / "rewards"
    d.mkdir(parents=True, exist_ok=True)
    name = safe_filename(filename)
    if Path(name).suffix.lower() not in config.VIDEO_EXT:
        raise ValueError("Chỉ nhận file video: " + ", ".join(sorted(config.VIDEO_EXT)))
    dest = d / name
    i = 1
    while dest.exists():
        dest = d / f"{Path(name).stem}-{i}{Path(name).suffix}"
        i += 1
    tmp = dest.with_suffix(dest.suffix + ".part")
    with tmp.open("wb") as f:
        shutil.copyfileobj(src, f, 1024 * 512)
    tmp.replace(dest)
    return {"name": dest.name, "url": f"/media/rewards/{kid_id}/{dest.name}"}


def delete_reward(kid_id: str, name: str) -> bool:
    p = reward_file(kid_id, name)
    if not p:
        return False
    p.unlink()
    return True


def create_kid(kid_id: str, name: str, avatar: str = "🚜", age: int = 4) -> dict[str, Any]:
    if not valid_id(kid_id):
        raise ValueError("Mã bé chỉ gồm chữ thường, số, gạch ngang")
    if profile_path(kid_id).exists():
        raise ValueError("Bé này đã có rồi")
    prof = json.loads(json.dumps(DEFAULT_PROFILE))
    prof.update({"id": kid_id, "name": name or kid_id.capitalize(),
                 "avatar": avatar or "🚜", "age": age})
    prof["games"] = {
        "dem-so": {"enabled": True, "max_number": 20, "cells": 5},
        "doc-cau": {"enabled": True, "min_words": 4, "max_words": 6},
    }
    return save(kid_id, prof)


def stamp() -> int:
    return int(time.time())
