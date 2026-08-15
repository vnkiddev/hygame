"""Sinh một model ONNX GIẢ có đúng hình dạng của wav2vec2 CTC.

Dùng để thử đường ống (API, VAD, chấm điểm, lưu clip, đo độ trễ) trên máy
không có PyTorch. Trọng số ngẫu nhiên nên kết quả nhận diện VÔ NGHĨA —
đừng bao giờ đem lên máy chủ thật.

    python3 scripts/make_dummy_model.py
"""
import json
import sys
from pathlib import Path

import numpy as np
import onnx
from onnx import TensorProto, helper, numpy_helper

ROOT = Path(__file__).resolve().parent.parent
CHARS = list("|abcdefghijklmnopqrstuvwxyzăâêôơưđ")
STRIDE = 320  # wav2vec2: 16000 Hz -> 50 khung/giây


def main() -> None:
    out_dir = ROOT / "models"
    out_dir.mkdir(exist_ok=True)

    vocab = {"<pad>": 0, "<s>": 1, "</s>": 2, "<unk>": 3}
    for i, c in enumerate(CHARS):
        vocab[c] = i + 4
    V = len(vocab)

    rng = np.random.default_rng(7)
    w = rng.normal(0, 0.3, (V, 1, STRIDE)).astype(np.float32)
    b = np.zeros(V, dtype=np.float32)

    nodes = [
        helper.make_node("Unsqueeze", ["input_values", "axis1"], ["x3"]),
        helper.make_node("Conv", ["x3", "W", "B"], ["conv"],
                         kernel_shape=[STRIDE], strides=[STRIDE]),
        helper.make_node("Transpose", ["conv"], ["logits"], perm=[0, 2, 1]),
    ]
    graph = helper.make_graph(
        nodes, "dummy_wav2vec2",
        [helper.make_tensor_value_info("input_values", TensorProto.FLOAT, [1, "T"])],
        [helper.make_tensor_value_info("logits", TensorProto.FLOAT, [1, "T2", V])],
        [numpy_helper.from_array(w, "W"), numpy_helper.from_array(b, "B"),
         numpy_helper.from_array(np.array([1], dtype=np.int64), "axis1")],
    )
    model = helper.make_model(graph, opset_imports=[helper.make_opsetid("", 13)])
    model.ir_version = 9
    onnx.checker.check_model(model)
    onnx.save(model, out_dir / "wav2vec2-vi-int8.onnx")
    (out_dir / "vocab.json").write_text(json.dumps(vocab, ensure_ascii=False, indent=1), "utf-8")
    print(f"Đã ghi model GIẢ vào {out_dir} (vocab {V} token). "
          f"CHỈ để thử đường ống, không dùng thật!", file=sys.stderr)


if __name__ == "__main__":
    main()
