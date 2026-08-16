"""Cấu hình toàn cục, đọc từ biến môi trường.

Mọi đường dẫn đều tuyệt đối, tính từ gốc repo để service systemd chạy ở
thư mục nào cũng đúng.
"""
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def _path(env: str, default: str) -> Path:
    return Path(os.environ.get(env, ROOT / default)).resolve()


def _int(env: str, default: int) -> int:
    try:
        return int(os.environ.get(env, default))
    except ValueError:
        return default


def _float(env: str, default: float) -> float:
    try:
        return float(os.environ.get(env, default))
    except ValueError:
        return default


def _bool(env: str, default: bool) -> bool:
    v = os.environ.get(env)
    if v is None:
        return default
    return v.strip().lower() in ("1", "true", "yes", "on")


# --- thư mục dữ liệu ---------------------------------------------------------
KIDS_DIR = _path("KIDS_DIR", "kids")
MODELS_DIR = _path("MODELS_DIR", "models")
DATA_DIR = _path("DATA_DIR", "data")
CLIPS_DIR = DATA_DIR / "clips"
DB_PATH = Path(os.environ.get("DB_PATH", DATA_DIR / "app.db")).resolve()
FRONTEND_DIR = _path("FRONTEND_DIR", "frontend")

# --- model ASR ---------------------------------------------------------------
ASR_MODEL_PATH = Path(
    os.environ.get("ASR_MODEL_PATH", MODELS_DIR / "wav2vec2-vi-int8.onnx")
).resolve()
ASR_VOCAB_PATH = Path(
    os.environ.get("ASR_VOCAB_PATH", MODELS_DIR / "vocab.json")
).resolve()
# Model tiếng Anh (tuỳ chọn) — trò chơi đọc câu có thể đặt lang="en" cho
# từng bé. Không đặt biến này thì phần tiếng Anh chạy bằng trình duyệt.
_en_model = os.environ.get("ASR_MODEL_EN_PATH", "").strip()
ASR_MODEL_EN_PATH = Path(_en_model).resolve() if _en_model else None
_en_vocab = os.environ.get("ASR_VOCAB_EN_PATH", "").strip()
ASR_VOCAB_EN_PATH = (
    Path(_en_vocab).resolve() if _en_vocab
    else (ASR_MODEL_EN_PATH.with_name("vocab-en.json") if ASR_MODEL_EN_PATH else None)
)

ASR_THREADS = _int("ASR_THREADS", 2)
# Nhiệt độ softmax khi xếp hạng ứng viên. Nhỏ -> phân bố nhọn hơn.
ASR_SOFTMAX_T = _float("ASR_SOFTMAX_T", 1.0)
SAMPLE_RATE = 16000
# Cắt cứng audio dài quá — chi phí CPU tỉ lệ thẳng với độ dài.
MAX_AUDIO_SEC = _float("MAX_AUDIO_SEC", 6.0)

# Đường phụ transcript tự do (Whisper). Tắt mặc định vì tốn RAM.
WHISPER_MODEL_PATH = Path(
    os.environ.get("WHISPER_MODEL_PATH", MODELS_DIR / "phowhisper-base-int8")
).resolve()
WHISPER_ENABLED = _bool("WHISPER_ENABLED", False)
WHISPER_IDLE_UNLOAD_SEC = _int("WHISPER_IDLE_UNLOAD_SEC", 300)

# --- lưu trữ -----------------------------------------------------------------
SAVE_CLIPS = _bool("SAVE_CLIPS", True)
CLIP_RETENTION_DAYS = _int("CLIP_RETENTION_DAYS", 90)

# --- mạng --------------------------------------------------------------------
HOST = os.environ.get("HOST", "127.0.0.1")
PORT = _int("PORT", 8000)
# Chỉ cho phép các dải IP nội bộ. Đặt "*" để tắt kiểm tra.
ALLOWED_NETS = os.environ.get(
    "ALLOWED_NETS", "127.0.0.0/8,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,::1/128,fc00::/7"
)
# Token cho trang quản trị. Rỗng = không yêu cầu (mặc định, mạng LAN nhà).
ADMIN_TOKEN = os.environ.get("ADMIN_TOKEN", "").strip()

VIDEO_EXT = {".mp4", ".m4v", ".webm", ".mov", ".ogv"}
MAX_UPLOAD_MB = _int("MAX_UPLOAD_MB", 512)
