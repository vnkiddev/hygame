"""Chấm điểm CTC cho một tập ứng viên đóng.

Đây là điểm mấu chốt của cả dự án (SPEC §4.2). KHÔNG decode văn bản tự do.
Với ma trận log-prob [T, V] đã có sẵn, tính CTC forward score của từng chuỗi
ứng viên rồi xếp hạng.

Toàn bộ ứng viên (và mọi biến thể chính tả của chúng) được chấm trong MỘT
phép đệ quy vector hoá: vòng lặp chỉ chạy T lần trên ma trận [N, S], thay vì
N*T lần trên vector [S]. Trên clip 1.7 giây với 20 ứng viên (~300 chuỗi),
cách này nhanh hơn khoảng 40 lần — đủ rẻ để "thêm ứng viên gần như miễn phí"
đúng như SPEC nói.
"""
from __future__ import annotations

import numpy as np

NEG = -1e30


def ctc_logp_batch(
    log_probs: np.ndarray, seqs: list[list[int]], blank: int = 0
) -> np.ndarray:
    """CTC forward score (log) của NHIỀU chuỗi cùng lúc trên ma trận [T, V].

    Trả về mảng [N]. Chuỗi rỗng hoặc dài hơn số khung -> NEG.
    """
    n = len(seqs)
    out = np.full(n, NEG, dtype=np.float64)
    if n == 0:
        return out
    T = log_probs.shape[0]

    keep = [i for i, s in enumerate(seqs) if s and len(s) <= T]
    if not keep:
        return out

    lens = np.array([len(seqs[i]) for i in keep])
    S_max = int(2 * lens.max() + 1)
    S_n = 2 * lens + 1  # số trạng thái thật của từng chuỗi

    # Chuỗi mở rộng blank-xen-kẽ, phần thừa đệm blank (không ảnh hưởng kết
    # quả vì luồng alpha chỉ chảy theo chiều s tăng, không quay lại).
    ext = np.full((len(keep), S_max), blank, dtype=np.int64)
    for r, i in enumerate(keep):
        seq = seqs[i]
        ext[r, 1:2 * len(seq):2] = seq

    # Bước nhảy 2 chỉ hợp lệ khi ký tự không phải blank và khác ký tự cách 2.
    skip = np.zeros((len(keep), S_max), dtype=bool)
    if S_max > 2:
        skip[:, 2:] = (ext[:, 2:] != blank) & (ext[:, 2:] != ext[:, :-2])

    emit = log_probs[:, ext]  # [T, N, S] — tra sẵn, tránh fancy-index trong vòng lặp

    alpha = np.full((len(keep), S_max), NEG, dtype=np.float64)
    alpha[:, 0] = emit[0, :, 0]
    if S_max > 1:
        alpha[:, 1] = emit[0, :, 1]

    shifted1 = np.empty_like(alpha)
    shifted2 = np.empty_like(alpha)
    for t in range(1, T):
        shifted1[:, 0] = NEG
        shifted1[:, 1:] = alpha[:, :-1]
        shifted2[:, :2] = NEG
        shifted2[:, 2:] = alpha[:, :-2]
        np.copyto(shifted2, NEG, where=~skip)
        m = np.maximum(np.maximum(alpha, shifted1), shifted2)
        with np.errstate(invalid="ignore"):
            s = (np.exp(alpha - m) + np.exp(shifted1 - m) + np.exp(shifted2 - m))
        alpha = np.where(m <= NEG / 2, NEG, m + np.log(s)) + emit[t]

    rows = np.arange(len(keep))
    last = alpha[rows, S_n - 1]
    prev = alpha[rows, S_n - 2]
    out[keep] = np.logaddexp(last, prev)
    return out


def ctc_logp(log_probs: np.ndarray, labels: list[int], blank: int = 0) -> float:
    """CTC forward score của MỘT chuỗi. Dùng cho kiểm thử và soi lỗi."""
    return float(ctc_logp_batch(log_probs, [list(labels)], blank)[0])


def score_candidates(
    log_probs: np.ndarray,
    candidates: list[str],
    lexicon,
    blank: int | None = None,
    softmax_t: float = 1.0,
) -> list[dict]:
    """Xếp hạng tập ứng viên đóng.

    Mỗi ứng viên nở ra nhiều biến thể chính tả; điểm của ứng viên là điểm
    (đã chuẩn hoá độ dài) cao nhất trong nhóm biến thể của nó.

    Trả về danh sách dict đã sắp giảm dần:
      {text, prob, logp, norm, variant, n_tokens}
    """
    if blank is None:
        blank = lexicon.blank_id

    seqs: list[list[int]] = []
    owner: list[int] = []       # biến thể thứ k thuộc về ứng viên nào
    texts: list[str] = []
    for ci, cand in enumerate(candidates):
        for var_text, ids in lexicon.encode_variants(cand):
            seqs.append(ids)
            owner.append(ci)
            texts.append(var_text)

    rows = [{"text": c, "logp": NEG, "n_tokens": 1, "variant": ""} for c in candidates]
    if not seqs:
        return []

    logps = ctc_logp_batch(log_probs, seqs, blank)
    per_tok = logps / np.array([max(1, len(s)) for s in seqs], dtype=np.float64)

    best_per_tok = np.full(len(candidates), -np.inf)
    for k, ci in enumerate(owner):
        if per_tok[k] > best_per_tok[ci]:
            best_per_tok[ci] = per_tok[k]
            rows[ci].update(logp=float(logps[k]), n_tokens=len(seqs[k]), variant=texts[k])

    # Đưa điểm/token về thang "một chuỗi dài trung bình" rồi mới softmax,
    # nếu không phân bố sẽ quá phẳng.
    mean_len = max(1.0, float(np.mean([r["n_tokens"] for r in rows])))
    adj = best_per_tok * mean_len
    adj = np.where(np.isfinite(adj), adj, NEG)
    t = max(0.05, float(softmax_t))
    z = (adj - adj.max()) / t
    p = np.exp(z)
    total = p.sum()
    p = p / total if total > 0 else np.full(len(p), 1.0 / len(p))

    for r, pi, ai in zip(rows, p, adj):
        r["prob"] = float(pi)
        r["norm"] = float(ai)

    rows.sort(key=lambda r: r["prob"], reverse=True)
    return rows
