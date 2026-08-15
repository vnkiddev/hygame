"""Xuất wav2vec2 CTC tiếng Việt sang ONNX int8.

CHẠY MỘT LẦN TRÊN MÁY DEV (nơi có PyTorch), rồi copy 2 file sang máy chủ:
    models/wav2vec2-vi-int8.onnx
    models/vocab.json
Máy chủ production KHÔNG cần PyTorch — chỉ cần onnxruntime.

    pip install torch transformers onnx onnxruntime
    python3 scripts/export_onnx.py --bench
    scp models/wav2vec2-vi-int8.onnx models/vocab.json may-chu:~/apps/hygame/models/

Tuỳ chọn:
    --model  tên model trên HuggingFace (mặc định nguyenvulebinh/wav2vec2-base-vietnamese-250h)
    --fp32   giữ nguyên fp32, không lượng tử hoá (để so sánh độ chính xác)
    --bench  đo tốc độ ngay sau khi xuất

Phần export tách thành hàm export_model() để tests/test_export.py kiểm được
mà không cần tải trọng số về.
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_MODEL = "nguyenvulebinh/wav2vec2-base-vietnamese-250h"


def _external_data_of(path: Path) -> Path:
    """PyTorch mới ghi trọng số ra file .onnx.data riêng bên cạnh."""
    return path.with_name(path.name + ".data")


def _inline_weights(path: Path, quiet: bool = False) -> None:
    """Gộp trọng số vào chính file .onnx.

    Bản xuất của torch để trọng số ở file .onnx.data riêng. Nếu cứ thế đem
    đi thì copy mỗi file .onnx sang máy chủ là model HỎNG (file chỉ vài MB,
    không có trọng số). Gộp lại thành một file để lệnh copy trong install.md
    luôn đúng.
    """
    ext = _external_data_of(path)
    if not ext.exists():
        return
    import onnx

    m = onnx.load(str(path), load_external_data=True)
    onnx.save(m, str(path), save_as_external_data=False)
    ext.unlink()
    if not quiet:
        print(f"  đã gộp trọng số vào {path.name} ({path.stat().st_size / 1e6:.0f} MB)")


def export_model(model, vocab: dict, out_dir: Path, blank_id: int = 0,
                 fp32: bool = False, opset: int = 18, bench: bool = False,
                 quiet: bool = False) -> Path:
    """Xuất một Wav2Vec2ForCTC đã nạp sẵn ra ONNX (+ int8) và đối chiếu kết quả.

    Trả về đường dẫn file model cuối cùng.
    """
    import numpy as np
    import torch

    def log(*a):
        if not quiet:
            print(*a)

    out_dir.mkdir(parents=True, exist_ok=True)
    fp32_path = out_dir / "wav2vec2-vi-fp32.onnx"
    final_path = out_dir / ("wav2vec2-vi-fp32.onnx" if fp32 else "wav2vec2-vi-int8.onnx")

    (out_dir / "vocab.json").write_text(
        json.dumps({k: int(v) for k, v in vocab.items()}, ensure_ascii=False, indent=1),
        "utf-8")
    log(f"  vocab {len(vocab)} token, blank id = {blank_id}")
    if blank_id != 0:
        print(f"  ⚠️  blank id = {blank_id} chứ không phải 0 — lõi chấm điểm đọc "
              f"blank từ vocab.json nên vẫn đúng, nhưng hãy kiểm lại.", file=sys.stderr)

    model = model.eval()
    log("Xuất ONNX …")
    # Trục thời gian PHẢI động: mỗi lượt bé nói một độ dài khác nhau.
    dummy = torch.zeros(1, 16000 * 2)
    torch.onnx.export(
        model, (dummy,), str(fp32_path),
        input_names=["input_values"], output_names=["logits"],
        dynamic_axes={"input_values": {0: "batch", 1: "time"},
                      "logits": {0: "batch", 1: "frames"}},
        opset_version=opset, do_constant_folding=True,
    )
    _inline_weights(fp32_path, quiet)
    log(f"  {fp32_path.name}: {fp32_path.stat().st_size / 1e6:.0f} MB")

    if not fp32:
        log("Lượng tử hoá int8 …")
        from onnxruntime.quantization import QuantType, quantize_dynamic

        quantize_dynamic(str(fp32_path), str(final_path), weight_type=QuantType.QInt8)
        log(f"  {final_path.name}: {final_path.stat().st_size / 1e6:.0f} MB")

    # --- ONNX phải khớp PyTorch ---
    log("Đối chiếu kết quả ONNX với PyTorch …")
    import onnxruntime as ort

    rng = np.random.default_rng(0)
    x = rng.normal(0, 0.1, 16000 * 2).astype(np.float32)
    xn = (x - x.mean()) / (x.std() + 1e-7)
    with torch.no_grad():
        ref = model(torch.from_numpy(xn)[None, :]).logits.numpy()[0]
    sess = ort.InferenceSession(str(final_path), providers=["CPUExecutionProvider"])
    got = sess.run(None, {"input_values": xn[None, :]})[0][0]

    if ref.shape != got.shape:
        raise RuntimeError(f"Hình dạng lệch: PyTorch {ref.shape} vs ONNX {got.shape}")
    agree = float((ref.argmax(-1) == got.argmax(-1)).mean())
    log(f"  khung trùng khớp: {agree * 100:.1f}%  (sai lệch tuyệt đối tối đa "
        f"{np.abs(ref - got).max():.3f})")
    if agree < 0.9:
        print("  ⚠️  Lệch nhiều quá. Cân nhắc dùng bản fp32 (--fp32).", file=sys.stderr)

    # Trục thời gian động có thật sự động không — nếu không, clip dài/ngắn sẽ hỏng.
    for sec in (0.8, 3.1):
        a = rng.normal(0, 0.1, int(16000 * sec)).astype(np.float32)
        o = sess.run(None, {"input_values": a[None, :]})[0]
        assert o.shape[1] > 1, f"Clip {sec}s cho ra {o.shape} — trục thời gian bị cố định"
    log("  trục thời gian động: OK")

    if bench:
        log("Đo tốc độ (con số cần kiểm là trên chính con i3, không phải máy này):")
        for sec in (1.0, 1.5, 2.0, 3.0):
            a = rng.normal(0, 0.1, int(16000 * sec)).astype(np.float32)
            a = (a - a.mean()) / (a.std() + 1e-7)
            sess.run(None, {"input_values": a[None, :]})
            t0 = time.perf_counter()
            for _ in range(5):
                sess.run(None, {"input_values": a[None, :]})
            ms = (time.perf_counter() - t0) / 5 * 1000
            log(f"  clip {sec:.1f}s -> {ms:6.0f} ms/lượt" + ("  ✅" if ms < 800 else "  ⚠️ quá chậm"))

    if not fp32:
        # bản fp32 chỉ là trung gian — dọn cả file trọng số kèm theo,
        # nếu không sẽ đọng lại vài trăm MB rác trên máy dev
        fp32_path.unlink(missing_ok=True)
        _external_data_of(fp32_path).unlink(missing_ok=True)
    _inline_weights(final_path, quiet)
    if _external_data_of(final_path).exists():
        raise RuntimeError(f"{final_path.name} vẫn cần file trọng số rời — "
                           f"copy một mình nó sang máy chủ sẽ hỏng")
    return final_path


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default=DEFAULT_MODEL)
    ap.add_argument("--out", default=str(ROOT / "models"))
    ap.add_argument("--fp32", action="store_true")
    ap.add_argument("--bench", action="store_true")
    ap.add_argument("--opset", type=int, default=18)
    args = ap.parse_args()

    try:
        from transformers import Wav2Vec2ForCTC, Wav2Vec2Processor
    except ImportError:
        print("Thiếu thư viện. Chạy trên MÁY DEV:\n"
              "  pip install torch transformers onnx onnxruntime", file=sys.stderr)
        return 1

    print(f"Tải {args.model} …")
    processor = Wav2Vec2Processor.from_pretrained(args.model)
    model = Wav2Vec2ForCTC.from_pretrained(args.model)
    tok = processor.tokenizer
    print(f"  ký tự ngăn từ = {tok.word_delimiter_token!r}")

    final = export_model(model, tok.get_vocab(), Path(args.out),
                         blank_id=tok.pad_token_id, fp32=args.fp32,
                         opset=args.opset, bench=args.bench)
    print(f"\nXong. Copy {final.name} và vocab.json sang thư mục models/ của máy chủ.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
