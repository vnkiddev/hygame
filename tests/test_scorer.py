"""Kiểm chứng lõi chấm điểm CTC bằng ma trận log-prob dựng tay.

Chạy: python3 -m tests.test_scorer   (từ gốc repo, không cần model)
"""
import math
import sys

import numpy as np

sys.path.insert(0, ".")
from backend.asr.lexicon import Lexicon  # noqa: E402
from backend.asr.scorer import ctc_logp, score_candidates  # noqa: E402

CHARS = "|abcdefghijklmnopqrstuvwxyzăâêôơưđ"
VOCAB = {"<pad>": 0}
for i, c in enumerate(CHARS):
    VOCAB[c] = i + 1
LEX = Lexicon(VOCAB)


def synth(spoken: str, T_per_char: int = 4, sharpness: float = 6.0, noise=0.0):
    """Dựng ma trận log-prob giả lập việc phát âm chuỗi `spoken`."""
    rng = np.random.default_rng(0)
    ids = LEX.encode(spoken)
    V = len(VOCAB)
    frames = []
    for i in ids:
        for _ in range(T_per_char):
            logits = rng.normal(0, noise, V) if noise else np.zeros(V)
            logits[i] += sharpness
            frames.append(logits)
        blank = np.zeros(V)
        blank[0] += sharpness
        frames.append(blank)
    x = np.array(frames)
    x = x - x.max(1, keepdims=True)
    return x - np.log(np.exp(x).sum(1, keepdims=True))


def approx(a, b, tol=1e-6):
    return abs(a - b) <= tol


def test_ctc_basic():
    """Chuỗi đúng phải có log-prob cao hơn hẳn chuỗi sai."""
    lp = synth("ba")
    good = ctc_logp(lp, LEX.encode("ba"))
    bad = ctc_logp(lp, LEX.encode("tam"))
    assert good > bad, (good, bad)
    assert good > -5, good
    print(f"  ctc ba={good:.3f} tam={bad:.3f}")


def test_ctc_impossible():
    """Chuỗi dài hơn số khung -> vô nghĩa."""
    lp = synth("ba")
    assert ctc_logp(lp, LEX.encode("mot hai ba bon nam sau bay tam chin muoi")) < -100


def test_ctc_repeated_chars():
    """Ký tự lặp cần blank chen giữa — công thức phải xử lý đúng."""
    lp = synth("aa")
    assert ctc_logp(lp, LEX.encode("aa")) > ctc_logp(lp, LEX.encode("ab"))


def test_ctc_sums_to_one():
    """Tổng xác suất của mọi chuỗi độ dài <=1 trên vocab 3 ký tự phải <= 1."""
    V = 3
    lp = np.log(np.array([[0.5, 0.3, 0.2], [0.4, 0.4, 0.2]]))
    lex = Lexicon({"<pad>": 0, "a": 1, "b": 2})
    total = math.exp(ctc_logp(lp, [], 0)) if False else 0.0
    # chuỗi rỗng: cả 2 khung đều blank
    total += 0.5 * 0.4
    for seq in ([1], [2], [1, 1], [1, 2], [2, 1], [2, 2]):
        total += math.exp(ctc_logp(lp, seq, 0))
    assert approx(total, 1.0, 1e-9), total
    print(f"  tổng xác suất mọi chuỗi = {total:.9f}")
    del lex, V


def test_closed_set_ranking():
    """Ứng viên đúng phải thắng trong tập 20 số."""
    numbers = ["mot", "hai", "ba", "bon", "nam", "sau", "bay", "tam", "chin", "muoi",
               "muoi mot", "muoi hai", "muoi ba", "muoi bon", "muoi lam", "muoi sau",
               "muoi bay", "muoi tam", "muoi chin", "hai muoi"]
    for spoken in ("bay", "muoi lam", "hai muoi", "ba"):
        lp = synth(spoken, noise=0.4)
        rank = score_candidates(lp, numbers, LEX)
        best = rank[0]
        assert best["text"] == spoken, (spoken, [(r["text"], round(r["prob"], 3)) for r in rank[:3]])
        margin = best["prob"] - rank[1]["prob"]
        print(f"  nói '{spoken}' -> best={best['text']} p={best['prob']:.3f} margin={margin:.3f}")
        assert best["prob"] > 0.4 and margin > 0.1


def test_variant_rescue():
    """Bé nói 'tư' nhưng ứng viên ghi 'bốn' — biến thể phải cứu được."""
    lp = synth("tu", noise=0.3)
    rank = score_candidates(lp, ["bốn", "năm", "sáu", "một"], LEX)
    assert rank[0]["text"] == "bốn", [(r["text"], round(r["prob"], 3)) for r in rank]
    print(f"  'tư' -> {rank[0]['text']} qua biến thể '{rank[0]['variant']}' p={rank[0]['prob']:.3f}")


def test_tone_rescue():
    """Sai thanh điệu ('meo' thay 'mèo') vẫn phải khớp."""
    lp = synth("meo", noise=0.3)
    rank = score_candidates(lp, ["mèo", "chó", "cá", "gà"], LEX)
    assert rank[0]["text"] == "mèo", [(r["text"], round(r["prob"], 3)) for r in rank]
    print(f"  'meo' -> {rank[0]['text']} p={rank[0]['prob']:.3f}")


def test_wrong_word_is_reported():
    """Nói sai từ khác trong tập -> best là từ đã nói, không nuốt lỗi."""
    lp = synth("cho", noise=0.3)
    rank = score_candidates(lp, ["mèo", "chó", "cá", "gà"], LEX)
    assert rank[0]["text"] == "chó"


def test_speed():
    import time

    lp = synth("muoi lam", noise=0.3)
    cands = [f"ung vien {i}" for i in range(20)]
    t0 = time.perf_counter()
    for _ in range(20):
        score_candidates(lp, cands, LEX)
    dt = (time.perf_counter() - t0) / 20 * 1000
    print(f"  chấm 20 ứng viên: {dt:.2f} ms/lượt")
    assert dt < 60, dt


if __name__ == "__main__":
    fails = 0
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            try:
                fn()
                print(f"PASS {name}")
            except AssertionError as e:
                fails += 1
                print(f"FAIL {name}: {e}")
    print("---", "tất cả PASS" if not fails else f"{fails} test hỏng")
    sys.exit(1 if fails else 0)
