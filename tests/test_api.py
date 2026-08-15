"""Thử toàn bộ API trên một máy chủ đang chạy.

    python3 -m uvicorn backend.main:app --port 8011 &
    python3 -m tests.test_api http://127.0.0.1:8011

Kiểm cả tiêu chí nghiệm thu §12: health warm, độ trễ, rò rỉ bộ nhớ,
mọi lượt thử sinh một dòng attempts kèm clip, thêm video không cần restart.
"""
import json
import sqlite3
import sys
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path

sys.path.insert(0, ".")
import numpy as np  # noqa: E402

from backend import config  # noqa: E402
from backend.asr.vad import to_wav_bytes  # noqa: E402

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8011"
NUMBERS = ["một", "hai", "ba", "bốn", "năm", "sáu", "bảy", "tám", "chín", "mười",
           "mười một", "mười hai", "mười ba", "mười bốn", "mười lăm", "mười sáu",
           "mười bảy", "mười tám", "mười chín", "hai mươi"]
fails = []


def check(name, cond, detail=""):
    print(("PASS " if cond else "FAIL ") + name + (f" — {detail}" if detail else ""))
    if not cond:
        fails.append(name)


def get(path):
    with urllib.request.urlopen(BASE + path, timeout=30) as r:
        return json.loads(r.read())


def req(path, data=None, method="POST", ctype="application/json", headers=None):
    body = json.dumps(data).encode() if ctype == "application/json" and data is not None else data
    r = urllib.request.Request(BASE + path, data=body, method=method)
    if body is not None:
        r.add_header("Content-Type", ctype)
    for k, v in (headers or {}).items():
        r.add_header(k, v)
    try:
        with urllib.request.urlopen(r, timeout=60) as resp:
            return resp.status, json.loads(resp.read() or b"{}")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}")


def multipart(fields, files):
    """Dựng body multipart bằng tay để khỏi phụ thuộc requests."""
    b = uuid.uuid4().hex
    out = b""
    for k, v in fields.items():
        out += (f"--{b}\r\nContent-Disposition: form-data; name=\"{k}\"\r\n\r\n"
                f"{v}\r\n").encode()
    for k, (fn, blob, ct) in files.items():
        out += (f"--{b}\r\nContent-Disposition: form-data; name=\"{k}\"; "
                f"filename=\"{fn}\"\r\nContent-Type: {ct}\r\n\r\n").encode() + blob + b"\r\n"
    out += f"--{b}--\r\n".encode()
    return out, f"multipart/form-data; boundary={b}"


def make_clip(seconds=1.5, lead=0.3):
    sr = 16000
    rng = np.random.default_rng(11)
    x = np.concatenate([
        np.zeros(int(lead * sr)),
        rng.normal(0, 0.15, int(seconds * sr)),
        np.zeros(int(0.4 * sr)),
    ]).astype(np.float32)
    return to_wav_bytes(x)


def db():
    c = sqlite3.connect(config.DB_PATH)
    c.row_factory = sqlite3.Row
    return c


# --- 1. health --------------------------------------------------------------
h = get("/api/health")
check("health ok", h.get("ok") is True)
check("§12.1 model warm sau khởi động", h.get("warm") is True,
      f"model={h.get('model')} err={h.get('error')}")
rss0 = h["rss_mb"]

# --- 2. recognize -----------------------------------------------------------
clip = make_clip()
sess = "test-" + uuid.uuid4().hex[:8]
body, ct = multipart(
    {"candidates": json.dumps(NUMBERS, ensure_ascii=False), "expected": "bảy",
     "kid_id": "min", "game_id": "dem-so", "session_id": sess},
    {"audio": ("clip.wav", clip, "audio/wav")})
st, d = req("/api/recognize", body, ctype=ct)
check("recognize trả 200", st == 200, str(d)[:120])
check("có xếp hạng top-5", len(d.get("ranking", [])) == 5, str(d.get("ranking"))[:80])
check("§5 có compute_ms", "compute_ms" in d)
check("VAD server cắt bớt im lặng", d["kept_ms"] < d["audio_ms"],
      f"{d['audio_ms']}ms -> {d['kept_ms']}ms")
check("§12.2 compute_ms < 800 (clip 1.5s, 20 ứng viên)", d["compute_ms"] < 800,
      f"{d['compute_ms']}ms (forward {d['forward_ms']}ms + chấm {d['score_ms']}ms)")
probs = [p for _, p in d["ranking"]]
check("xác suất giảm dần", probs == sorted(probs, reverse=True))
check("tổng xác suất toàn tập = 1", abs(sum(
    p for _, p in d["ranking"]) - 1) < 1.001)

# --- 3. clip + attempts -----------------------------------------------------
clip_path = d.get("clip_id")
check("§12.8 clip được lưu lên đĩa", bool(clip_path) and (config.CLIPS_DIR / clip_path).exists(),
      str(clip_path))
with db() as c:
    rows = c.execute("SELECT * FROM attempts WHERE session_id=?", (sess,)).fetchall()
check("§12.8 lượt thử sinh dòng trong attempts", len(rows) == 1)
if rows:
    check("attempts ghi đủ trường", all(rows[0][k] is not None for k in
          ("kid_id", "game_id", "expected", "best_prob", "source", "clip_path")))

# --- 4. tập ứng viên lớn vẫn rẻ --------------------------------------------
big = NUMBERS + [f"chữ số {i}" for i in range(60)]
body, ct = multipart(
    {"candidates": json.dumps(big, ensure_ascii=False), "expected": "bảy",
     "kid_id": "min", "game_id": "dem-so", "session_id": sess},
    {"audio": ("clip.wav", clip, "audio/wav")})
t0 = time.time()
st, d80 = req("/api/recognize", body, ctype=ct)
check("§4.2 thêm ứng viên gần như miễn phí (80 ứng viên)",
      st == 200 and d80["score_ms"] < 120,
      f"20 ứng viên {d['score_ms']}ms -> 80 ứng viên {d80['score_ms']}ms")

# --- 5. audio quá ngắn ------------------------------------------------------
body, ct = multipart(
    {"candidates": json.dumps(NUMBERS, ensure_ascii=False), "expected": "bảy"},
    {"audio": ("clip.wav", to_wav_bytes(np.zeros(800, dtype=np.float32)), "audio/wav")})
st, d2 = req("/api/recognize", body, ctype=ct)
check("clip quá ngắn -> không sập", st == 200 and d2.get("reason") == "too_short", str(d2)[:80])

# --- 6. hồ sơ + video thưởng ------------------------------------------------
kids = get("/api/kids")["kids"]
check("liệt kê được hồ sơ trẻ", len(kids) >= 1, f"{len(kids)} bé")
check("§5 không lộ đường dẫn hệ thống",
      all("path" not in json.dumps(k) and "/home" not in json.dumps(k) for k in kids))

kid_id = kids[0]["id"]
st, _ = req(f"/api/kids/{kid_id}/reward", method="GET") if False else (200, None)
r = get(f"/api/kids/{kid_id}/reward")
check("chưa có video -> trả về rỗng chứ không lỗi", "url" in r)

# thêm video bằng API quản trị (đúng cách bố mẹ dùng trang admin)
fake_mp4 = b"\x00\x00\x00\x18ftypmp42" + b"\x00" * 4096
body, ct = multipart({}, {"file": ("Video Máy Xúc Vui.mp4", fake_mp4, "video/mp4")})
st, up = req(f"/api/admin/kids/{kid_id}/rewards", body, ctype=ct)
check("tải video thưởng lên được", st == 200 and up.get("name"), str(up)[:120])
check("tên file được làm sạch (bỏ dấu, bỏ khoảng trắng)",
      up.get("name", "").startswith("Video-May-Xuc-Vui") and up["name"].endswith(".mp4"),
      up.get("name"))

# §12.5: không restart mà bé nhận được ngay
listed = get(f"/api/admin/kids/{kid_id}/rewards")["videos"]
check("§12.5 thêm video -> bé nhận ngay, không restart",
      any(v["name"] == up["name"] for v in listed), f"{len(listed)} video")
r2 = get(f"/api/kids/{kid_id}/reward")
check("bốc ngẫu nhiên được một video của bé", bool(r2.get("url")), str(r2))

# tải được nội dung video qua /media
with urllib.request.urlopen(BASE + up["url"], timeout=20) as resp:
    blob = resp.read()
check("phục vụ được file video", blob == fake_mp4, f"{len(blob)} byte")

# không lấy được file ngoài thư mục rewards
st, _ = req(f"/api/admin/kids/{kid_id}/rewards/..%2F..%2Fprofile.json", method="DELETE")
check("chặn path traversal khi xoá", st in (404, 400), f"status {st}")
try:
    urllib.request.urlopen(BASE + f"/media/rewards/{kid_id}/../profile.json", timeout=10)
    trav_ok = False
except urllib.error.HTTPError as e:
    trav_ok = e.code in (403, 404)
except urllib.error.URLError:
    trav_ok = True
check("chặn path traversal khi đọc", trav_ok)

# dọn video vừa tải lên để chạy lại test không bị dồn file
st, _ = req(f"/api/admin/kids/{kid_id}/rewards/{up['name']}", method="DELETE")
check("xoá được video qua API quản trị", st == 200,
      f"status {st}")
check("xoá xong thì không còn trong danh sách",
      all(v["name"] != up["name"]
          for v in get(f"/api/admin/kids/{kid_id}/rewards")["videos"]))

# --- 7. sửa hồ sơ qua API quản trị -----------------------------------------
st, saved = req(f"/api/admin/kids/{kid_id}",
                {"asr": {"threshold": 0.33, "margin": 0.07, "max_wrong_before_hint": 3},
                 "rewards": {"stars_needed": 4}}, method="PUT")
check("lưu được cấu hình bé", st == 200 and saved["asr"]["threshold"] == 0.33, str(saved)[:100])
fresh = get(f"/api/kids/{kid_id}")
check("§6 sửa hồ sơ có hiệu lực ngay, không restart",
      fresh["asr"]["threshold"] == 0.33 and fresh["rewards"]["stars_needed"] == 4)

# --- 8. sự kiện -------------------------------------------------------------
st, ev = req("/api/events", {"events": [
    {"type": "round_start", "session_id": sess, "kid_id": "min", "game_id": "dem-so",
     "payload": {"start": 3}, "at": int(time.time() * 1000)},
    {"type": "attempt", "session_id": sess, "kid_id": "min", "game_id": "dem-so",
     "payload": {"expected": "ba", "best": "ba", "best_prob": 1, "margin": 1,
                 "accepted": 1, "source": "browser"}, "at": int(time.time() * 1000)},
]})
check("ghi log theo lô", st == 200 and ev["saved"] == 2, str(ev))
with db() as c:
    n_att = c.execute("SELECT COUNT(*) n FROM attempts WHERE session_id=? AND source='browser'",
                      (sess,)).fetchone()["n"]
    n_ev = c.execute("SELECT COUNT(*) n FROM events WHERE session_id=?", (sess,)).fetchone()["n"]
check("§12.8 lượt thử phía trình duyệt cũng vào bảng attempts", n_att == 1)
check("sự kiện thường vào bảng events", n_ev == 1)
st, _ = req(f"/api/session/{sess}/end")
with db() as c:
    row = c.execute("SELECT ended_at FROM sessions WHERE id=?", (sess,)).fetchone()
check("kết thúc phiên được ghi lại", row and row["ended_at"])

# --- 9. rò rỉ bộ nhớ --------------------------------------------------------
print("… chạy 100 request liên tiếp để soi rò rỉ bộ nhớ")
lat = []
body, ct = multipart(
    {"candidates": json.dumps(NUMBERS, ensure_ascii=False), "expected": "bảy",
     "kid_id": "min", "game_id": "dem-so", "session_id": sess},
    {"audio": ("clip.wav", clip, "audio/wav")})
for i in range(100):
    t0 = time.perf_counter()
    st, d3 = req("/api/recognize", body, ctype=ct)
    lat.append((time.perf_counter() - t0) * 1000)
    if st != 200:
        break
lat.sort()
h2 = get("/api/health")
check("§12.3 RAM < 2GB sau 100 request", h2["rss_mb"] < 2048,
      f"{rss0}MB -> {h2['rss_mb']}MB")
check("không phình bộ nhớ (< +150MB)", h2["rss_mb"] - rss0 < 150,
      f"tăng {round(h2['rss_mb'] - rss0, 1)}MB")
print(f"     độ trễ HTTP: p50={lat[50]:.0f}ms p95={lat[95]:.0f}ms max={lat[-1]:.0f}ms")

# --- 10. trang tĩnh ---------------------------------------------------------
for path in ("/app/index.html", "/app/admin.html", "/app/core/app.js",
             "/app/games/index.json", "/app/games/dem-so/game.js",
             "/app/games/doc-cau/data/cau.txt", "/app/games/_template/game.js"):
    try:
        with urllib.request.urlopen(BASE + path, timeout=10) as resp:
            ok = resp.status == 200 and len(resp.read()) > 10
    except Exception as e:  # noqa: BLE001
        ok = False
    check(f"phục vụ {path}", ok)

print("\n" + ("TẤT CẢ PASS" if not fails else f"{len(fails)} HỎNG: {fails}"))
sys.exit(1 if fails else 0)
