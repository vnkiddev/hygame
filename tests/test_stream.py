"""Kiểm cơ chế chấm liên tục + ngôn ngữ trên máy chủ đang chạy.

    python3 -m tests.test_stream http://127.0.0.1:8011

Điều quan trọng nhất phải đúng: lượt chấm từng phần KHÔNG được lưu clip và
KHÔNG được ghi vào bảng attempts — một lần bé nói bắn ra nhiều lượt partial,
lưu hết thì rác đầy đĩa và thống kê đếm sai.
"""
import json
import sqlite3
import sys
import time
import urllib.error
import urllib.request
import uuid

sys.path.insert(0, ".")
import numpy as np  # noqa: E402

from backend import config  # noqa: E402
from backend.asr.vad import to_wav_bytes  # noqa: E402

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8011"
NUMBERS = ["một", "hai", "ba", "bốn", "năm", "sáu", "bảy", "tám", "chín", "mười"]
fails = []


def check(name, cond, detail=""):
    print(("PASS " if cond else "FAIL ") + name + (f" — {detail}" if detail else ""))
    if not cond:
        fails.append(name)


def clip(sec, seed=3):
    rng = np.random.default_rng(seed)
    x = np.concatenate([
        np.zeros(int(0.2 * 16000)),
        rng.normal(0, 0.15, int(sec * 16000)),
    ]).astype(np.float32)
    return to_wav_bytes(x)


def recognize(blob, partial=False, lang="vi", session_id="stream-test"):
    b = uuid.uuid4().hex
    fields = {
        "candidates": json.dumps(NUMBERS, ensure_ascii=False), "expected": "bảy",
        "kid_id": "min", "game_id": "dem-so", "session_id": session_id, "lang": lang,
    }
    if partial:
        fields["partial"] = "1"
    body = b""
    for k, v in fields.items():
        body += f'--{b}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n'.encode()
    body += (f'--{b}\r\nContent-Disposition: form-data; name="audio"; '
             f'filename="c.wav"\r\nContent-Type: audio/wav\r\n\r\n').encode() + blob + b"\r\n"
    body += f"--{b}--\r\n".encode()
    r = urllib.request.Request(BASE + "/api/recognize", data=body, method="POST")
    r.add_header("Content-Type", f"multipart/form-data; boundary={b}")
    try:
        with urllib.request.urlopen(r, timeout=60) as resp:
            return resp.status, json.loads(resp.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}")


def db_count(session_id):
    c = sqlite3.connect(config.DB_PATH)
    n = c.execute("SELECT COUNT(*) FROM attempts WHERE session_id=?", (session_id,)).fetchone()[0]
    c.close()
    return n


def clips_on_disk():
    if not config.CLIPS_DIR.exists():
        return 0
    return sum(1 for _ in config.CLIPS_DIR.rglob("*.wav"))


# --- 1. lượt partial: có chấm, nhưng không để lại dấu vết -------------------
sess = "stream-" + uuid.uuid4().hex[:8]
before_clips = clips_on_disk()

st, d = recognize(clip(0.6), partial=True, session_id=sess)
check("partial trả 200", st == 200, str(d)[:100])
check("partial có xếp hạng để client tự quyết", bool(d.get("ranking")), str(d.get("ranking"))[:60])
check("partial được đánh dấu rõ", d.get("partial") is True)
check("partial KHÔNG lưu clip", d.get("clip_id") is None, str(d.get("clip_id")))

for sec in (0.9, 1.2, 1.5):
    recognize(clip(sec), partial=True, session_id=sess)

check("partial KHÔNG ghi vào bảng attempts", db_count(sess) == 0, f"{db_count(sess)} dòng")
check("partial KHÔNG đẻ file clip nào",
      clips_on_disk() == before_clips, f"{clips_on_disk() - before_clips} file mới")

# --- 2. lượt đầy đủ: vẫn lưu như cũ ----------------------------------------
st, full = recognize(clip(1.5), partial=False, session_id=sess)
check("lượt đầy đủ vẫn lưu clip", bool(full.get("clip_id")), str(full.get("clip_id")))
check("lượt đầy đủ ghi đúng 1 dòng attempts", db_count(sess) == 1, f"{db_count(sess)} dòng")
check("lượt đầy đủ không bị đánh dấu partial", full.get("partial") is False)

# --- 3. chấm sớm phải rẻ hơn chấm cả câu -----------------------------------
t0 = time.perf_counter()
_, short = recognize(clip(0.6), partial=True, session_id=sess)
short_ms = (time.perf_counter() - t0) * 1000
t0 = time.perf_counter()
_, long_ = recognize(clip(2.5), partial=True, session_id=sess)
long_ms = (time.perf_counter() - t0) * 1000
check("đoạn ngắn chấm nhanh hơn đoạn dài (chi phí tỉ lệ độ dài)",
      short["compute_ms"] < long_["compute_ms"],
      f"0.6s={short['compute_ms']}ms · 2.5s={long_['compute_ms']}ms")
print(f"     HTTP: đoạn ngắn {short_ms:.0f}ms · đoạn dài {long_ms:.0f}ms")

# --- 4. ngôn ngữ ------------------------------------------------------------
h = json.loads(urllib.request.urlopen(BASE + "/api/health", timeout=20).read())
check("health liệt kê model theo ngôn ngữ", "langs" in h and "vi" in h["langs"], str(h.get("langs"))[:80])

st, en = recognize(clip(1.0), lang="en", session_id=sess)
if "en" in h.get("langs", {}):
    check("có model tiếng Anh -> chấm được", st == 200 and not en.get("lang_unsupported"))
else:
    check("chưa có model tiếng Anh -> báo rõ, không sập",
          st == 200 and en.get("lang_unsupported") is True, str(en)[:100])
    check("báo tiếng Anh vẫn kèm cờ để client tự xoay bằng trình duyệt",
          en.get("model_unavailable") is True)

st, vi = recognize(clip(1.0), lang="vi", session_id=sess)
check("tiếng Việt vẫn chấm bình thường", st == 200 and not vi.get("lang_unsupported"))
check("kết quả có ghi ngôn ngữ đã dùng", vi.get("lang") == "vi")

print("\n" + ("TẤT CẢ PASS" if not fails else f"{len(fails)} HỎNG: {fails}"))
sys.exit(1 if fails else 0)
