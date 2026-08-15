"""Chữ tiếng Việt -> chuỗi token để chấm CTC, kèm sinh biến thể chính tả.

Cách sinh biến thể (SPEC §15): **kết hợp** bảng tay cho số đếm + quy tắc
âm vị chung. Bảng tay lo các cặp đọc khác nhau hoàn toàn ("bốn"/"tư"),
quy tắc lo lỗi phát âm hệ thống của trẻ (mất thanh, lẫn phụ âm cuối).
Mỗi ứng viên nở ra tối đa MAX_VARIANTS chuỗi; điểm của ứng viên là điểm
cao nhất trong nhóm.
"""
from __future__ import annotations

import re
import unicodedata
from functools import lru_cache

MAX_VARIANTS = 16

# --- bảng tay: các cách đọc khác nhau của cùng một chữ ------------------------
SYNONYMS: dict[str, list[str]] = {
    "bốn": ["tư"],
    "tư": ["bốn"],
    "năm": ["lăm"],
    "lăm": ["năm"],
    "mười": ["mươi"],
    "mười bốn": ["mười tư"],
    "mười lăm": ["mười năm"],
    "mười một": ["mười mốt"],
    "hai mươi": ["hai chục", "hai mười"],
    "một": ["mốt"],
}

# --- quy tắc âm vị: cặp phụ âm cuối hay lẫn ở giọng trẻ -----------------------
FINAL_SWAPS = [("ng", "n"), ("nh", "n"), ("c", "t"), ("ch", "t"), ("p", "m")]
# phụ âm đầu hay lẫn
INITIAL_SWAPS = [("tr", "ch"), ("s", "x"), ("r", "d"), ("gi", "d"), ("l", "n"), ("kh", "h")]

# chỉ 5 dấu thanh, KHÔNG đụng tới dấu mũ (U+0302), dấu trăng (U+0306),
# dấu móc (U+031B) vì đó là bộ phận của chữ cái chứ không phải thanh điệu
_TONE_RE = re.compile("[̣̀́̃̉]")


def strip_tone(s: str) -> str:
    """Bỏ dấu thanh, GIỮ dấu chữ (â, ê, ô, ơ, ư, ă) — ASR hay sai thanh điệu
    ở giọng trẻ nhưng nguyên âm gốc thường vẫn đúng."""
    d = unicodedata.normalize("NFD", s)
    d = _TONE_RE.sub("", d)
    return unicodedata.normalize("NFC", d)


def strip_all_marks(s: str) -> str:
    d = unicodedata.normalize("NFD", s)
    d = "".join(c for c in d if unicodedata.category(c) != "Mn")
    return unicodedata.normalize("NFC", d).replace("đ", "d")


def normalize(s: str) -> str:
    s = (s or "").lower().strip()
    s = re.sub(r"[^\w\sÀ-ỹđ]", " ", s, flags=re.UNICODE)
    return re.sub(r"\s+", " ", s).strip()


def _swap_finals(word: str) -> list[str]:
    out = []
    for a, b in FINAL_SWAPS:
        if word.endswith(a):
            out.append(word[: -len(a)] + b)
        if word.endswith(b):
            out.append(word[: -len(b)] + a)
    return out


def _swap_initials(word: str) -> list[str]:
    out = []
    for a, b in INITIAL_SWAPS:
        if word.startswith(a):
            out.append(b + word[len(a):])
        if word.startswith(b):
            out.append(a + word[len(b):])
    return out


@lru_cache(maxsize=4096)
def variants(phrase: str) -> tuple[str, ...]:
    """Sinh các biến thể chính tả của một ứng viên."""
    base = normalize(phrase)
    if not base:
        return ()
    words = base.split()

    # Vòng 1 — cách đọc khác (bảng tay). Đây là những chữ đọc lệch hẳn,
    # không suy ra được bằng quy tắc.
    spoken: dict[str, None] = {base: None}
    for alt in SYNONYMS.get(base, []):
        spoken[normalize(alt)] = None
    if len(words) > 1:
        for i, w in enumerate(words):
            for alt in SYNONYMS.get(w, []):
                spoken[normalize(" ".join(words[:i] + [alt] + words[i + 1:]))] = None

    # Vòng 2 — lỗi phát âm hệ thống, áp cho MỌI cách đọc ở vòng 1.
    seen: dict[str, None] = {}

    def add(v: str) -> None:
        v = normalize(v)
        if v and v not in seen and len(seen) < MAX_VARIANTS:
            seen[v] = None

    for form in spoken:
        add(form)
    for form in list(spoken):
        add(strip_tone(form))
        add(strip_all_marks(form))
        fw = form.split()
        if len(fw) <= 2:  # cụm dài thì thôi, tránh nở bung tổ hợp
            for i, w in enumerate(fw):
                for alt in _swap_finals(w) + _swap_initials(w):
                    add(" ".join(fw[:i] + [alt] + fw[i + 1:]))

    return tuple(seen.keys())


class Lexicon:
    """Ánh xạ văn bản -> id token theo vocab của model wav2vec2."""

    def __init__(self, vocab: dict[str, int]):
        self.vocab = vocab
        self.blank_id = vocab.get("<pad>", vocab.get("<blank>", 0))
        self.unk_id = vocab.get("<unk>", None)
        # ký tự ngăn từ: wav2vec2 tiếng Việt dùng "|"
        self.delim_id = vocab.get("|", vocab.get(" ", None))
        self.lower = all(not k.isupper() for k in vocab if len(k) == 1)

    def encode(self, text: str) -> list[int]:
        """Trả về chuỗi id. Ký tự lạ bị bỏ qua (không dùng unk, vì unk làm
        nhiễu điểm CTC)."""
        text = normalize(text)
        if not text:
            return []
        out: list[int] = []
        for ch in text:
            if ch == " ":
                if self.delim_id is not None and out and out[-1] != self.delim_id:
                    out.append(self.delim_id)
                continue
            i = self.vocab.get(ch)
            if i is None:
                i = self.vocab.get(ch.upper())
            if i is None:
                # thử bỏ dấu rồi tra lại
                alt = strip_all_marks(ch)
                i = self.vocab.get(alt) or self.vocab.get(alt.upper())
            if i is not None:
                out.append(i)
        while out and out[-1] == self.delim_id:
            out.pop()
        return out

    def encode_variants(self, phrase: str) -> list[tuple[str, list[int]]]:
        res = []
        for v in variants(phrase):
            ids = self.encode(v)
            if ids:
                res.append((v, ids))
        return res
