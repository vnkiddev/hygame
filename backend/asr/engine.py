"""Nạp model wav2vec2 CTC dạng ONNX, chạy forward pass, làm nóng lúc khởi động.

Nguyên tắc:
  - MỘT forward pass cho mỗi lượt nghe. Không decode, không beam search.
  - Không có model -> app vẫn chạy, chỉ là không có đường phụ server
    (client tự xoay bằng Web Speech API). Không được sập.
  - Làm nóng lúc khởi động: lượt đầu tiên không được chậm hơn lượt sau.
"""
from __future__ import annotations

import json
import logging
import threading
import time
from pathlib import Path

import numpy as np

from .. import config
from .lexicon import Lexicon
from .scorer import score_candidates

log = logging.getLogger("asr")


class ASREngine:
    def __init__(self, lang: str = "vi", model_path=None, vocab_path=None) -> None:
        self.lang = lang
        self.model_path = model_path or config.ASR_MODEL_PATH
        self.vocab_path = vocab_path or config.ASR_VOCAB_PATH
        self.session = None
        self.lexicon: Lexicon | None = None
        self.model_name = ""
        self.warm = False
        self.error = ""
        self.input_name = "input_values"
        self.output_name = ""
        self.warmup_ms = 0.0
        self._lock = threading.Lock()  # onnxruntime an toàn thread, nhưng
        # nối tiếp request để 2 luồng không tranh nhau 2 core của con i3

    # --- vòng đời ---------------------------------------------------------
    def load(self) -> None:
        mp, vp = self.model_path, self.vocab_path
        if not mp.exists():
            self.error = f"Chưa có model: {mp}. Chạy scripts/export_onnx.py rồi copy sang."
            log.warning(self.error)
            return
        if not vp.exists():
            self.error = f"Chưa có vocab: {vp}"
            log.warning(self.error)
            return
        try:
            import onnxruntime as ort
        except ImportError:
            self.error = "Chưa cài onnxruntime (pip install onnxruntime)"
            log.warning(self.error)
            return

        try:
            opts = ort.SessionOptions()
            opts.intra_op_num_threads = config.ASR_THREADS
            opts.inter_op_num_threads = 1
            opts.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
            self.session = ort.InferenceSession(
                str(mp), sess_options=opts, providers=["CPUExecutionProvider"]
            )
            self.input_name = self.session.get_inputs()[0].name
            self.output_name = self.session.get_outputs()[0].name
            vocab = json.loads(Path(vp).read_text("utf-8"))
            self.lexicon = Lexicon({k: int(v) for k, v in vocab.items()})
            self.model_name = mp.name
            log.info("Đã nạp %s cho tiếng %s (vocab %d token)",
                     mp.name, self.lang, len(vocab))
        except Exception as e:  # noqa: BLE001 — không được để sập app
            self.error = f"Nạp model hỏng: {e}"
            log.exception(self.error)
            self.session = None

    def warmup(self) -> None:
        """Chạy vài forward pass giả để ONNX cấp phát bộ nhớ, JIT xong xuôi."""
        if not self.session:
            return
        t0 = time.perf_counter()
        try:
            for sec in (1.0, 2.0):
                dummy = np.zeros(int(config.SAMPLE_RATE * sec), dtype=np.float32)
                self.logits(dummy)
            self.warm = True
            self.warmup_ms = (time.perf_counter() - t0) * 1000
            log.info("Làm nóng model xong trong %.0f ms", self.warmup_ms)
        except Exception as e:  # noqa: BLE001
            self.error = f"Làm nóng hỏng: {e}"
            log.exception(self.error)

    @property
    def available(self) -> bool:
        return self.session is not None and self.lexicon is not None

    # --- suy luận ---------------------------------------------------------
    def logits(self, audio: np.ndarray) -> np.ndarray:
        """[T] float32 -> log-prob [T', V]."""
        if not self.session:
            raise RuntimeError("Model chưa sẵn sàng")
        x = audio.astype(np.float32)
        # wav2vec2 chuẩn hoá zero-mean unit-variance trên từng clip
        x = (x - x.mean()) / (x.std() + 1e-7)
        with self._lock:
            out = self.session.run([self.output_name], {self.input_name: x[None, :]})[0]
        return log_softmax(np.asarray(out[0], dtype=np.float32))

    def recognize(self, audio: np.ndarray, candidates: list[str]) -> dict:
        """Đường đi chính: 1 forward pass + chấm điểm tập ứng viên đóng."""
        t0 = time.perf_counter()
        lp = self.logits(audio)
        fwd_ms = (time.perf_counter() - t0) * 1000
        t1 = time.perf_counter()
        ranking = score_candidates(
            lp, candidates, self.lexicon, softmax_t=config.ASR_SOFTMAX_T
        )
        return {
            "ranking": ranking,
            "forward_ms": round(fwd_ms, 1),
            "score_ms": round((time.perf_counter() - t1) * 1000, 2),
            "frames": int(lp.shape[0]),
        }

    def greedy_text(self, audio: np.ndarray) -> str:
        """Giải mã tham lam — CHỈ dùng để soi lỗi, không nằm ở đường chính."""
        lp = self.logits(audio)
        ids = lp.argmax(1)
        inv = {v: k for k, v in self.lexicon.vocab.items()}
        out, prev = [], -1
        for i in ids:
            i = int(i)
            if i != prev and i != self.lexicon.blank_id:
                out.append(inv.get(i, ""))
            prev = i
        return "".join(out).replace("|", " ").strip()


def log_softmax(x: np.ndarray) -> np.ndarray:
    m = x.max(axis=-1, keepdims=True)
    e = x - m
    return e - np.log(np.exp(e).sum(axis=-1, keepdims=True))


# Đường đi chính là tiếng Việt. Tiếng Anh là tuỳ chọn: chỉ có khi bố mẹ
# xuất thêm một model tiếng Anh và trỏ ASR_MODEL_EN_PATH vào đó. Không có
# thì game tiếng Anh vẫn chơi được bằng Web Speech API của trình duyệt.
engine = ASREngine("vi")

engines: dict[str, ASREngine] = {"vi": engine}
if config.ASR_MODEL_EN_PATH:
    engines["en"] = ASREngine("en", config.ASR_MODEL_EN_PATH, config.ASR_VOCAB_EN_PATH)


def get_engine(lang: str | None) -> ASREngine | None:
    """Engine cho ngôn ngữ này, hoặc None nếu chưa cấu hình."""
    return engines.get((lang or "vi").lower()[:2])


def boot_all() -> None:
    """Nạp + làm nóng mọi engine đã cấu hình."""
    for eng in engines.values():
        eng.load()
        eng.warmup()
