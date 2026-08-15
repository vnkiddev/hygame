"""Cắt im lặng + giải mã audio.

Chi phí CPU của forward pass tỉ lệ THẲNG với độ dài audio (SPEC §4.4),
nên cắt càng sát càng tốt. Client đã cắt một lần, server cắt lại lần nữa
vì không tin được client.
"""
from __future__ import annotations

import io
import shutil
import struct
import subprocess
import wave

import numpy as np

from .. import config

_FFMPEG = shutil.which("ffmpeg")


def has_ffmpeg() -> bool:
    return _FFMPEG is not None


def decode(data: bytes, sr: int = config.SAMPLE_RATE) -> np.ndarray:
    """bytes -> float32 mono [-1,1] ở tần số `sr`.

    WAV PCM giải mã thẳng bằng Python (đường đi chính — client tự đóng gói
    WAV 16k để server khỏi tốn CPU). Định dạng nén (webm/opus, ogg, mp4)
    cần ffmpeg.
    """
    if not data:
        return np.zeros(0, dtype=np.float32)
    if data[:4] == b"RIFF":
        try:
            return _decode_wav(data, sr)
        except Exception:
            pass
    if not _FFMPEG:
        raise RuntimeError(
            "Audio không phải WAV PCM và máy chủ không có ffmpeg. "
            "Cài ffmpeg hoặc để client gửi WAV 16kHz."
        )
    return _decode_ffmpeg(data, sr)


def _decode_wav(data: bytes, sr: int) -> np.ndarray:
    with wave.open(io.BytesIO(data), "rb") as w:
        n_ch, width, rate = w.getnchannels(), w.getsampwidth(), w.getframerate()
        raw = w.readframes(w.getnframes())
    if width == 2:
        x = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0
    elif width == 4:
        x = np.frombuffer(raw, dtype="<i4").astype(np.float32) / 2147483648.0
    elif width == 1:
        x = (np.frombuffer(raw, dtype=np.uint8).astype(np.float32) - 128) / 128.0
    else:
        raise ValueError(f"WAV {width * 8} bit chưa hỗ trợ")
    if n_ch > 1:
        x = x.reshape(-1, n_ch).mean(1)
    return resample(x, rate, sr)


def _decode_ffmpeg(data: bytes, sr: int) -> np.ndarray:
    p = subprocess.run(
        [_FFMPEG, "-hide_banner", "-loglevel", "error", "-i", "pipe:0",
         "-f", "s16le", "-acodec", "pcm_s16le", "-ac", "1", "-ar", str(sr), "pipe:1"],
        input=data, capture_output=True, timeout=20,
    )
    if p.returncode != 0 or not p.stdout:
        raise RuntimeError("ffmpeg không giải mã được audio: " + p.stderr.decode()[:200])
    return np.frombuffer(p.stdout, dtype="<i2").astype(np.float32) / 32768.0


def resample(x: np.ndarray, src: int, dst: int) -> np.ndarray:
    """Nội suy tuyến tính. Đủ tốt cho tiếng nói 16k, rẻ hơn scipy nhiều."""
    if src == dst or x.size == 0:
        return x.astype(np.float32)
    n = int(round(x.size * dst / src))
    if n <= 1:
        return np.zeros(0, dtype=np.float32)
    idx = np.linspace(0, x.size - 1, n, dtype=np.float64)
    return np.interp(idx, np.arange(x.size), x).astype(np.float32)


def trim(
    x: np.ndarray,
    sr: int = config.SAMPLE_RATE,
    frame_ms: int = 20,
    pad_ms: int = 120,
    rel_db: float = 26.0,
) -> np.ndarray:
    """Cắt im lặng hai đầu bằng năng lượng tương đối so với khung to nhất.

    Ngưỡng tương đối (không phải tuyệt đối) để không phụ thuộc vào việc
    bé nói to hay nhỏ, mic xa hay gần.
    """
    if x.size == 0:
        return x
    fl = max(1, int(sr * frame_ms / 1000))
    n = x.size // fl
    if n < 3:
        return x
    frames = x[: n * fl].reshape(n, fl)
    rms = np.sqrt((frames.astype(np.float64) ** 2).mean(1)) + 1e-10
    peak = rms.max()
    if peak < 1e-4:  # im lặng hoàn toàn
        return x
    thr = peak * (10 ** (-rel_db / 20))
    voiced = np.nonzero(rms > thr)[0]
    if voiced.size == 0:
        return x
    pad = max(1, int(pad_ms / frame_ms))
    a = max(0, voiced[0] - pad) * fl
    b = min(n, voiced[-1] + 1 + pad) * fl
    return x[a:b]


def prepare(data: bytes, sr: int = config.SAMPLE_RATE) -> tuple[np.ndarray, int, int]:
    """Giải mã -> cắt -> giới hạn độ dài. Trả (audio, ms_gốc, ms_sau_cắt)."""
    x = decode(data, sr)
    raw_ms = int(x.size / sr * 1000)
    x = trim(x, sr)
    limit = int(config.MAX_AUDIO_SEC * sr)
    if x.size > limit:
        x = x[:limit]
    return x, raw_ms, int(x.size / sr * 1000)


def to_wav_bytes(x: np.ndarray, sr: int = config.SAMPLE_RATE) -> bytes:
    """Đóng gói lại thành WAV 16-bit để lưu clip."""
    pcm = np.clip(x, -1, 1)
    pcm = (pcm * 32767).astype("<i2").tobytes()
    hdr = b"RIFF" + struct.pack("<I", 36 + len(pcm)) + b"WAVEfmt "
    hdr += struct.pack("<IHHIIHH", 16, 1, 1, sr, sr * 2, 2, 16)
    hdr += b"data" + struct.pack("<I", len(pcm))
    return hdr + pcm
