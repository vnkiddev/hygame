"""FastAPI app — khai báo route.

Đường đi chính: POST /api/recognize
  audio + tập ứng viên đóng -> 1 forward pass -> chấm điểm -> xếp hạng.

Ngoài ra có nhóm /api/admin/* cho trang quản trị: cấu hình video thưởng,
ngưỡng nhận diện và độ khó cho từng bé.
"""
from __future__ import annotations

import asyncio
import ipaddress
import json
import logging
import os
import time
import uuid

from fastapi import Body, FastAPI, File, Form, Header, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles

from . import config, db, profiles
from .asr import vad
from .asr.engine import engine
from .asr.whisper import whisper

logging.basicConfig(
    level=os.environ.get("LOG_LEVEL", "INFO"),
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
log = logging.getLogger("app")

app = FastAPI(title="Trò chơi học bằng giọng nói", docs_url=None, redoc_url=None)

_NETS = []
for part in config.ALLOWED_NETS.split(","):
    part = part.strip()
    if part and part != "*":
        try:
            _NETS.append(ipaddress.ip_network(part))
        except ValueError:
            log.warning("ALLOWED_NETS: bỏ qua dải không hợp lệ %r", part)


@app.middleware("http")
async def guard(request: Request, call_next):
    """Chặn theo IP nguồn (SPEC §5) — chỉ phục vụ máy trong nhà."""
    if _NETS and request.client:
        try:
            ip = ipaddress.ip_address(request.client.host)
            if not any(ip in n for n in _NETS):
                log.warning("Chặn IP lạ: %s", ip)
                return JSONResponse({"error": "forbidden"}, status_code=403)
        except ValueError:
            return JSONResponse({"error": "forbidden"}, status_code=403)
    return await call_next(request)


def require_admin(token: str | None) -> None:
    if config.ADMIN_TOKEN and token != config.ADMIN_TOKEN:
        raise HTTPException(401, "Sai mã quản trị")


@app.on_event("startup")
async def startup() -> None:
    db.init()
    config.CLIPS_DIR.mkdir(parents=True, exist_ok=True)
    config.KIDS_DIR.mkdir(parents=True, exist_ok=True)
    removed = db.purge_old_clips()
    if removed:
        log.info("Đã dọn %d ngày clip cũ", removed)
    # Nạp + làm nóng model ở luồng nền: /api/health trả warm=false trong lúc đó,
    # nhưng app đã phục vụ được ngay.
    loop = asyncio.get_event_loop()
    loop.run_in_executor(None, _boot_model)


def _boot_model() -> None:
    t0 = time.perf_counter()
    engine.load()
    engine.warmup()
    if engine.available:
        log.info("Model sẵn sàng sau %.1fs", time.perf_counter() - t0)
    else:
        log.warning("Chạy KHÔNG có ASR máy chủ: %s", engine.error)


# --- sức khoẻ ---------------------------------------------------------------

def _rss_mb() -> float:
    try:
        with open("/proc/self/status") as f:
            for line in f:
                if line.startswith("VmRSS:"):
                    return round(int(line.split()[1]) / 1024, 1)
    except OSError:
        pass
    return 0.0


@app.get("/api/health")
def health() -> dict:
    return {
        "ok": True,
        "model": engine.model_name or None,
        "warm": engine.warm,
        "rss_mb": _rss_mb(),
        "asr_available": engine.available,
        "whisper_loaded": whisper.loaded,
        "ffmpeg": vad.has_ffmpeg(),
        "error": engine.error or None,
        "kids": len(profiles.list_kid_ids()),
    }


# --- đường đi chính ---------------------------------------------------------

@app.post("/api/recognize")
async def recognize(
    audio: UploadFile = File(...),
    candidates: str = Form("[]"),
    expected: str = Form(""),
    kid_id: str = Form(""),
    game_id: str = Form(""),
    session_id: str = Form(""),
) -> JSONResponse:
    t_start = time.perf_counter()
    raw = await audio.read()

    try:
        cand_list = json.loads(candidates)
        if not isinstance(cand_list, list):
            raise ValueError
        cand_list = [str(c).strip() for c in cand_list if str(c).strip()]
    except (json.JSONDecodeError, ValueError):
        raise HTTPException(400, "candidates phải là mảng JSON các chuỗi")

    if expected and expected not in cand_list:
        cand_list.append(expected)
    if not cand_list:
        raise HTTPException(400, "Danh sách ứng viên rỗng")

    def work() -> dict:
        x, raw_ms, kept_ms = vad.prepare(raw)
        clip_path = _save_clip(x, kid_id, raw) if config.SAVE_CLIPS else None

        if x.size < config.SAMPLE_RATE * 0.15:
            return {
                "best": None, "best_prob": 0.0, "margin": 0.0, "ranking": [],
                "expected_prob": 0.0, "audio_ms": raw_ms, "kept_ms": kept_ms,
                "compute_ms": round((time.perf_counter() - t_start) * 1000, 1),
                "clip_id": clip_path, "reason": "too_short",
            }

        if not engine.available:
            return {
                "error": "model_unavailable", "detail": engine.error,
                "audio_ms": raw_ms, "kept_ms": kept_ms, "clip_id": clip_path,
                "compute_ms": round((time.perf_counter() - t_start) * 1000, 1),
            }

        res = engine.recognize(x, cand_list)
        rank = res["ranking"]
        best = rank[0] if rank else None
        second = rank[1]["prob"] if len(rank) > 1 else 0.0
        exp_prob = next((r["prob"] for r in rank if r["text"] == expected), 0.0)
        compute_ms = round((time.perf_counter() - t_start) * 1000, 1)

        out = {
            "best": best["text"] if best else None,
            "best_prob": round(best["prob"], 4) if best else 0.0,
            "margin": round((best["prob"] - second), 4) if best else 0.0,
            "ranking": [[r["text"], round(r["prob"], 4)] for r in rank[:5]],
            "expected_prob": round(exp_prob, 4),
            "audio_ms": raw_ms,
            "kept_ms": kept_ms,
            "compute_ms": compute_ms,
            "forward_ms": res["forward_ms"],
            "score_ms": res["score_ms"],
            "clip_id": clip_path,
            "variant": best["variant"] if best else None,
        }
        # Ghi lượt thử. accepted để client quyết theo ngưỡng của bé,
        # ở đây ghi so khớp thô để dữ liệu không rỗng.
        db.touch_session(session_id, kid_id, game_id)
        db.insert_attempt({
            "session_id": session_id, "kid_id": kid_id, "game_id": game_id,
            "expected": expected, "best": out["best"], "best_prob": out["best_prob"],
            "margin": out["margin"], "accepted": out["best"] == expected,
            "source": "server", "audio_ms": raw_ms, "compute_ms": compute_ms,
            "clip_path": clip_path,
        })
        return out

    result = await asyncio.get_event_loop().run_in_executor(None, work)
    status = 503 if result.get("error") == "model_unavailable" else 200
    return JSONResponse(result, status_code=status)


def _save_clip(x, kid_id: str, original: bytes) -> str | None:
    """Lưu audio đã cắt dưới dạng WAV 16k — tài sản quý nhất của dự án."""
    try:
        d = db.clip_dir_for_today()
        name = f"{(kid_id or 'unknown')}-{uuid.uuid4().hex[:8]}.wav"
        (d / name).write_bytes(vad.to_wav_bytes(x))
        return f"{d.name}/{name}"
    except Exception:  # noqa: BLE001 — mất clip không được làm hỏng lượt chơi
        log.exception("Lưu clip hỏng")
        del original
        return None


@app.post("/api/transcribe")
async def transcribe(audio: UploadFile = File(...)) -> dict:
    raw = await audio.read()

    def work() -> dict:
        x, raw_ms, _ = vad.prepare(raw)
        t0 = time.perf_counter()
        text = whisper.transcribe(x)
        return {"text": text, "audio_ms": raw_ms,
                "compute_ms": round((time.perf_counter() - t0) * 1000, 1)}

    try:
        return await asyncio.get_event_loop().run_in_executor(None, work)
    except RuntimeError as e:
        raise HTTPException(503, str(e))


@app.post("/api/debug/greedy")
async def debug_greedy(audio: UploadFile = File(...)) -> dict:
    """Giải mã tham lam để soi lỗi khi chỉnh ngưỡng. Không dùng lúc chơi."""
    if not engine.available:
        raise HTTPException(503, engine.error or "Model chưa sẵn sàng")
    raw = await audio.read()

    def work() -> dict:
        x, raw_ms, kept = vad.prepare(raw)
        t0 = time.perf_counter()
        return {"text": engine.greedy_text(x), "audio_ms": raw_ms, "kept_ms": kept,
                "compute_ms": round((time.perf_counter() - t0) * 1000, 1)}

    return await asyncio.get_event_loop().run_in_executor(None, work)


# --- hồ sơ trẻ --------------------------------------------------------------

@app.get("/api/kids")
def get_kids() -> dict:
    return {"kids": [profiles.public(p) for p in profiles.all_kids()]}


@app.get("/api/kids/{kid_id}")
def get_kid(kid_id: str) -> dict:
    p = profiles.load(kid_id)
    if not p:
        raise HTTPException(404, "Không có bé này")
    return profiles.public(p)


@app.get("/api/kids/{kid_id}/reward")
def get_reward(kid_id: str) -> dict:
    if not profiles.load(kid_id):
        raise HTTPException(404, "Không có bé này")
    r = profiles.pick_reward(kid_id)
    if not r:
        return {"url": None, "reason": "chưa có video thưởng nào"}
    return {"url": r["url"], "name": r["name"]}


@app.get("/media/rewards/{owner}/{name}")
def media_reward(owner: str, name: str, request: Request) -> FileResponse:
    p = profiles.reward_file(owner, name)
    if not p:
        raise HTTPException(404, "Không có video này")
    return FileResponse(p)  # FileResponse tự xử lý Range cho video


# --- ghi log ----------------------------------------------------------------

@app.post("/api/events")
def post_events(payload: dict | list = Body(...)) -> dict:
    events = payload.get("events") if isinstance(payload, dict) else payload
    if not isinstance(events, list):
        raise HTTPException(400, "Body phải là mảng sự kiện")
    for e in events:
        if isinstance(e, dict) and e.get("session_id"):
            db.touch_session(e["session_id"], e.get("kid_id", ""), e.get("game_id", ""))
    return {"saved": db.insert_events([e for e in events if isinstance(e, dict)])}


@app.post("/api/session/{session_id}/end")
def session_end(session_id: str) -> dict:
    db.end_session(session_id)
    return {"ok": True}


# --- quản trị: video thưởng + cấu hình từng bé ------------------------------

@app.get("/api/admin/kids")
def admin_kids(x_admin_token: str | None = Header(None)) -> dict:
    require_admin(x_admin_token)
    out = []
    for p in profiles.all_kids():
        out.append({**p, "reward_videos": profiles.list_rewards(p["id"])})
    return {
        "kids": out,
        "default_videos": [
            {"name": v["name"], "url": v["url"]}
            for v in profiles.list_rewards("_khong_ton_tai_")
        ],
        "admin_locked": bool(config.ADMIN_TOKEN),
        "max_upload_mb": config.MAX_UPLOAD_MB,
    }


@app.post("/api/admin/kids")
def admin_create_kid(
    body: dict = Body(...), x_admin_token: str | None = Header(None)
) -> dict:
    require_admin(x_admin_token)
    try:
        return profiles.create_kid(
            str(body.get("id", "")).strip().lower(),
            str(body.get("name", "")).strip(),
            str(body.get("avatar", "🚜")).strip(),
            int(body.get("age", 4)),
        )
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.put("/api/admin/kids/{kid_id}")
def admin_save_kid(
    kid_id: str, body: dict = Body(...), x_admin_token: str | None = Header(None)
) -> dict:
    require_admin(x_admin_token)
    cur = profiles.load(kid_id)
    if not cur:
        raise HTTPException(404, "Không có bé này")
    allowed = {"name", "age", "avatar", "praise", "tts_rate", "asr", "games", "rewards"}
    merged = {**cur, **{k: v for k, v in body.items() if k in allowed}}
    merged.pop("id", None)
    try:
        return profiles.save(kid_id, merged)
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.get("/api/admin/kids/{kid_id}/rewards")
def admin_list_rewards(kid_id: str, x_admin_token: str | None = Header(None)) -> dict:
    require_admin(x_admin_token)
    if not profiles.load(kid_id):
        raise HTTPException(404, "Không có bé này")
    return {"videos": profiles.list_rewards(kid_id)}


@app.post("/api/admin/kids/{kid_id}/rewards")
async def admin_upload_reward(
    kid_id: str, file: UploadFile = File(...), x_admin_token: str | None = Header(None)
) -> dict:
    require_admin(x_admin_token)
    if kid_id != "_default" and not profiles.load(kid_id):
        raise HTTPException(404, "Không có bé này")
    try:
        info = await asyncio.get_event_loop().run_in_executor(
            None, profiles.add_reward, kid_id, file.filename or "video.mp4", file.file
        )
    except ValueError as e:
        raise HTTPException(400, str(e))
    log.info("Thêm video thưởng cho %s: %s", kid_id, info["name"])
    return info


@app.delete("/api/admin/kids/{kid_id}/rewards/{name}")
def admin_delete_reward(
    kid_id: str, name: str, x_admin_token: str | None = Header(None)
) -> dict:
    require_admin(x_admin_token)
    if not profiles.delete_reward(kid_id, name):
        raise HTTPException(404, "Không có video này")
    return {"ok": True}


@app.get("/api/admin/stats/{kid_id}")
def admin_stats(kid_id: str, days: int = 14, x_admin_token: str | None = Header(None)) -> dict:
    require_admin(x_admin_token)
    return {"kid_id": kid_id, "days": days, "words": db.kid_stats(kid_id, days)}


# --- phục vụ tĩnh (chỉ dùng khi chạy không có Caddy) -------------------------

@app.get("/")
def index() -> RedirectResponse:
    return RedirectResponse("/app/")


if config.FRONTEND_DIR.exists():
    app.mount("/app", StaticFiles(directory=config.FRONTEND_DIR, html=True), name="app")
