"""Kiểm chứng đường xuất ONNX + lõi ASR bằng model dựng tại chỗ.

Không tải trọng số từ mạng: dựng ĐÚNG kiến trúc wav2vec2-base (94.5M tham
số, stride 320) với trọng số ngẫu nhiên. Kết quả nhận diện dĩ nhiên vô
nghĩa, nhưng những thứ sau thì thật và đáng tin:

  - torch.onnx.export có chạy được với trục thời gian động không
  - quantize_dynamic int8 có ra file dùng được không
  - ONNX có khớp PyTorch không
  - engine.py có đọc đúng vocab/blank/hình dạng đầu ra không
  - ĐỘ TRỄ: thời gian forward pass phụ thuộc kiến trúc và kích thước,
    KHÔNG phụ thuộc giá trị trọng số -> con số đo được ở đây là thật

Cần torch + transformers, nên đây là test cho MÁY DEV, không phải máy chủ.

    python3 -m tests.test_export
"""
import shutil
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, ".")

fails = []


def check(name, cond, detail=""):
    print(("PASS " if cond else "FAIL ") + name + (f" — {detail}" if detail else ""))
    if not cond:
        fails.append(name)


def main() -> int:
    try:
        import numpy as np
        import torch  # noqa: F401
        from transformers import Wav2Vec2Config, Wav2Vec2ForCTC
    except ImportError as e:
        print(f"BỎ QUA: thiếu {e.name} — test này chỉ chạy trên máy dev")
        return 0

    from backend.asr.lexicon import Lexicon
    from backend.asr.scorer import score_candidates
    from scripts.export_onnx import export_model

    # Bảng token giống model tiếng Việt thật: <pad> làm blank, "|" ngăn từ,
    # chữ cái có dấu đầy đủ.
    chars = list("|abcdeghiklmnopqrstuvxyàáâãèéêìíòóôõùúýăđĩũơưạảấầẩậắằẳẵặẹẻẽ"
                 "ếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹ")
    vocab = {"<pad>": 0, "<s>": 1, "</s>": 2, "<unk>": 3}
    for i, c in enumerate(chars):
        vocab[c] = i + 4
    print(f"Dựng wav2vec2-base với vocab {len(vocab)} token …")

    cfg = Wav2Vec2Config(vocab_size=len(vocab))
    model = Wav2Vec2ForCTC(cfg)
    n_params = sum(p.numel() for p in model.parameters())
    check("kiến trúc đúng cỡ base (~95M tham số)", 90e6 < n_params < 100e6,
          f"{n_params / 1e6:.1f}M")
    check("tổng stride = 320 (16kHz -> 50 khung/giây)",
          int(np.prod(cfg.conv_stride)) == 320)

    out = Path(tempfile.mkdtemp())
    try:
        t0 = time.perf_counter()
        final = export_model(model, vocab, out, blank_id=0, bench=True)
        print(f"  (xuất mất {time.perf_counter() - t0:.0f}s)")
        check("xuất được file int8", final.exists() and final.name.endswith("int8.onnx"))
        size_mb = final.stat().st_size / 1e6
        check("file int8 nhỏ hơn 150MB", size_mb < 150, f"{size_mb:.0f} MB")
        check("có kèm vocab.json", (out / "vocab.json").exists())
        check("dọn file fp32 trung gian", not (out / "wav2vec2-vi-fp32.onnx").exists())

        # --- engine.py có nạp và dùng được file vừa xuất không ---
        from backend import config
        from backend.asr.engine import ASREngine

        config.ASR_MODEL_PATH = final
        config.ASR_VOCAB_PATH = out / "vocab.json"
        eng = ASREngine()
        eng.load()
        check("engine.py nạp được model vừa xuất", eng.available, eng.error)
        if not eng.available:
            return 1
        eng.warmup()
        check("làm nóng xong (§12.1)", eng.warm, f"{eng.warmup_ms:.0f} ms")
        check("engine đọc đúng blank id từ vocab", eng.lexicon.blank_id == 0)
        check("engine đọc đúng ký tự ngăn từ", eng.lexicon.delim_id == vocab["|"])

        # --- hình dạng đầu ra khớp giả định của lõi ---
        rng = np.random.default_rng(1)
        audio = rng.normal(0, 0.1, 16000 * 2).astype(np.float32)
        lp = eng.logits(audio)
        check("log-prob ra đúng [T, V]", lp.shape[1] == len(vocab), str(lp.shape))
        check("~50 khung/giây audio", 90 < lp.shape[0] < 110, f"{lp.shape[0]} khung / 2s")
        check("là log-prob thật (mỗi khung tổng xác suất = 1)",
              abs(float(np.exp(lp[0]).sum()) - 1.0) < 1e-4)

        # --- chấm điểm tập ứng viên đóng chạy trên đầu ra model thật ---
        numbers = ["một", "hai", "ba", "bốn", "năm", "sáu", "bảy", "tám", "chín",
                   "mười", "mười một", "mười hai", "mười ba", "mười bốn", "mười lăm",
                   "mười sáu", "mười bảy", "mười tám", "mười chín", "hai mươi"]
        rank = score_candidates(lp, numbers, eng.lexicon)
        check("xếp hạng đủ 20 ứng viên", len(rank) == 20)
        check("xác suất cộng lại bằng 1",
              abs(sum(r["prob"] for r in rank) - 1) < 1e-6)
        check("mọi ứng viên đều mã hoá được ra token (không có điểm vô cực)",
              all(np.isfinite(r["logp"]) for r in rank))

        # --- ĐỘ TRỄ THẬT: đây là con số đáng quan tâm nhất ---
        print("\n  Độ trễ đường đi chính (forward + chấm 20 ứng viên):")
        for sec in (1.0, 1.5, 2.0):
            a = rng.normal(0, 0.1, int(16000 * sec)).astype(np.float32)
            eng.recognize(a, numbers)
            t0 = time.perf_counter()
            for _ in range(3):
                res = eng.recognize(a, numbers)
            ms = (time.perf_counter() - t0) / 3 * 1000
            print(f"    clip {sec}s -> {ms:6.0f} ms  "
                  f"(forward {res['forward_ms']:.0f} + chấm {res['score_ms']:.1f})")
            if abs(sec - 1.5) < 0.01:
                check("§12.2 clip 1.5s, 20 ứng viên < 800ms trên máy này", ms < 800,
                      f"{ms:.0f} ms — con số trên con i3 sẽ CHẬM HƠN, phải đo lại ở đó")
    finally:
        shutil.rmtree(out, ignore_errors=True)

    print("\n" + ("TẤT CẢ PASS" if not fails else f"{len(fails)} HỎNG: {fails}"))
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
