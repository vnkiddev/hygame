"""Đường phụ transcript tự do (PhoWhisper ONNX), nạp lười, tự giải phóng.

CHỈ dùng cho trò chơi khai báo asr_mode="free_text". Không bao giờ nằm ở
đường đi chính vì decode tuần tự trên i3 mất 1.5-3 giây (SPEC §4.1).
"""
from __future__ import annotations

import logging
import threading
import time

import numpy as np

from .. import config

log = logging.getLogger("whisper")


class WhisperSide:
    def __init__(self) -> None:
        self._pipe = None
        self._last_used = 0.0
        self._lock = threading.Lock()

    @property
    def loaded(self) -> bool:
        return self._pipe is not None

    def _ensure(self):
        if self._pipe is not None:
            return self._pipe
        if not config.WHISPER_ENABLED:
            raise RuntimeError("Đường phụ Whisper đang tắt (WHISPER_ENABLED=0)")
        try:
            from optimum.onnxruntime import ORTModelForSpeechSeq2Seq
            from transformers import AutoProcessor
        except ImportError as e:
            raise RuntimeError(
                "Cần optimum[onnxruntime] + transformers cho đường phụ Whisper"
            ) from e
        path = str(config.WHISPER_MODEL_PATH)
        log.info("Nạp lười Whisper từ %s", path)
        proc = AutoProcessor.from_pretrained(path)
        model = ORTModelForSpeechSeq2Seq.from_pretrained(path)
        self._pipe = (proc, model)
        return self._pipe

    def transcribe(self, audio: np.ndarray) -> str:
        with self._lock:
            proc, model = self._ensure()
            self._last_used = time.time()
            feats = proc(
                audio, sampling_rate=config.SAMPLE_RATE, return_tensors="pt"
            ).input_features
            ids = model.generate(feats, max_new_tokens=48)
            return proc.batch_decode(ids, skip_special_tokens=True)[0].strip()

    def maybe_unload(self) -> bool:
        """Gọi định kỳ: rảnh quá lâu thì trả RAM lại cho máy."""
        with self._lock:
            if self._pipe is None:
                return False
            if time.time() - self._last_used < config.WHISPER_IDLE_UNLOAD_SEC:
                return False
            self._pipe = None
            import gc

            gc.collect()
            log.info("Đã giải phóng Whisper vì rảnh quá lâu")
            return True


whisper = WhisperSide()
