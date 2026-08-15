"""Xuất wav2vec2 CTC tiếng Việt sang ONNX int8.

CHẠY MỘT LẦN TRÊN MÁY DEV (nơi có PyTorch), rồi copy 2 file sang máy chủ:
    models/wav2vec2-vi-int8.onnx
    models/vocab.json
Máy chủ production KHÔNG cần PyTorch — chỉ cần onnxruntime.

    pip install torch transformers onnx onnxruntime "optimum[onnxruntime]"
    python3 scripts/export_onnx.py
    scp models/wav2vec2-vi-int8.onnx models/vocab.json may-chu:~/kidsapp/models/

Tuỳ chọn:
    --model  tên model trên HuggingFace (mặc định nguyenvulebinh/wav2vec2-base-vietnamese-250h)
    --fp32   giữ nguyên fp32, không lượng tử hoá (để so sánh độ chính xác)
    --bench  đo tốc độ ngay sau khi xuất
"""
import argparse
import json
import shutil
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_MODEL = "nguyenvulebinh/wav2vec2-base-vietnamese-250h"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default=DEFAULT_MODEL)
    ap.add_argument("--out", default=str(ROOT / "models"))
    ap.add_argument("--fp32", action="store_true")
    ap.add_argument("--bench", action="store_true")
    ap.add_argument("--opset", type=int, default=14)
    args = ap.parse_args()

    try:
        import numpy as np
        import torch
        from transformers import Wav2Vec2ForCTC, Wav2Vec2Processor
    except ImportError:
        print("Thiếu thư viện. Chạy trên MÁY DEV:\n"
              "  pip install torch transformers onnx onnxruntime", file=sys.stderr)
        return 1

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    fp32_path = out / "wav2vec2-vi-fp32.onnx"
    final_path = out / ("wav2vec2-vi-fp32.onnx" if args.fp32 else "wav2vec2-vi-int8.onnx")

    print(f"Tải {args.model} …")
    processor = Wav2Vec2Processor.from_pretrained(args.model)
    model = Wav2Vec2ForCTC.from_pretrained(args.model).eval()

    # --- vocab: lõi chấm điểm CTC cần đúng bảng token này ---
    tok = processor.tokenizer
    vocab = tok.get_vocab()
    (out / "vocab.json").write_text(
        json.dumps({k: int(v) for k, v in vocab.items()}, ensure_ascii=False, indent=1), "utf-8")
    blank = tok.pad_token_id
    print(f"  vocab {len(vocab)} token, blank id = {blank}, "
          f"ký tự ngăn từ = {tok.word_delimiter_token!r}")
    if blank != 0:
        print(f"  ⚠️  blank id = {blank} chứ không phải 0 — đặt biến môi trường "
              f"hoặc sửa Lexicon.blank_id cho khớp.", file=sys.stderr)

    # --- xuất ONNX với trục thời gian động ---
    print("Xuất ONNX …")
    dummy = torch.zeros(1, 16000 * 2)
    torch.onnx.export(
        model, (dummy,), str(fp32_path),
        input_names=["input_values"], output_names=["logits"],
        dynamic_axes={"input_values": {0: "batch", 1: "time"},
                      "logits": {0: "batch", 1: "frames"}},
        opset_version=args.opset, do_constant_folding=True,
    )
    print(f"  {fp32_path.name}: {fp32_path.stat().st_size / 1e6:.0f} MB")

    if not args.fp32:
        print("Lượng tử hoá int8 …")
        from onnxruntime.quantization import QuantType, quantize_dynamic

        quantize_dynamic(str(fp32_path), str(final_path), weight_type=QuantType.QInt8)
        print(f"  {final_path.name}: {final_path.stat().st_size / 1e6:.0f} MB")

    # --- kiểm tra: ONNX phải khớp PyTorch ---
    print("Đối chiếu kết quả ONNX với PyTorch …")
    import onnxruntime as ort

    rng = np.random.default_rng(0)
    x = rng.normal(0, 0.1, 16000 * 2).astype(np.float32)
    xn = (x - x.mean()) / (x.std() + 1e-7)
    with torch.no_grad():
        ref = model(torch.from_numpy(xn)[None, :]).logits.numpy()[0]
    sess = ort.InferenceSession(str(final_path), providers=["CPUExecutionProvider"])
    got = sess.run(None, {"input_values": xn[None, :]})[0][0]
    agree = (ref.argmax(-1) == got.argmax(-1)).mean()
    print(f"  khung trùng khớp: {agree * 100:.1f}%  (sai lệch tuyệt đối tối đa "
          f"{np.abs(ref - got).max():.3f})")
    if agree < 0.9:
        print("  ⚠️  Lệch nhiều quá. Cân nhắc dùng bản fp32 (--fp32).", file=sys.stderr)

    if args.bench:
        print("Đo tốc độ (đây là con số cần kiểm trên chính con i3, không phải máy dev):")
        for sec in (1.0, 1.5, 2.0, 3.0):
            a = rng.normal(0, 0.1, int(16000 * sec)).astype(np.float32)
            a = (a - a.mean()) / (a.std() + 1e-7)
            sess.run(None, {"input_values": a[None, :]})
            t0 = time.perf_counter()
            for _ in range(5):
                sess.run(None, {"input_values": a[None, :]})
            ms = (time.perf_counter() - t0) / 5 * 1000
            flag = "  ✅" if ms < 800 else "  ⚠️ quá chậm"
            print(f"  clip {sec:.1f}s -> {ms:6.0f} ms/lượt{flag}")

    if not args.fp32 and fp32_path.exists():
        fp32_path.unlink()  # bản fp32 chỉ là trung gian
    shutil.rmtree(out / "__pycache__", ignore_errors=True)
    print(f"\nXong. Copy {final_path.name} và vocab.json sang thư mục models/ của máy chủ.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
