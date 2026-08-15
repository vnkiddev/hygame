"""Tạo hồ sơ 3 bé mặc định nếu thư mục kids/ còn trống.

Thư mục kids/ không nằm trong git (chứa dữ liệu thật của trẻ), nên máy chủ
vừa clone về sẽ không có bé nào và màn chọn tên sẽ trống trơn. Script này
gieo sẵn Min / Ly / An để vào là chơi được ngay.

KHÔNG ghi đè hồ sơ đã có — chạy lại nhiều lần vô hại.

    python3 scripts/seed_kids.py
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
KIDS = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "kids"

# Ngưỡng khởi điểm theo SPEC §4.3 — con số đoán, phải chỉnh lại bằng dữ liệu
# thật sau vài tuần, qua trang quản trị.
SEED = [
    {"id": "min", "name": "Min", "age": 4, "avatar": "🚜", "tts_rate": 0.8,
     "asr": {"threshold": 0.45, "margin": 0.12, "max_wrong_before_hint": 2},
     "games": {"dem-so": {"enabled": True, "max_number": 20, "cells": 5},
               "doc-cau": {"enabled": True, "min_words": 4, "max_words": 6}},
     "rewards": {"stars_needed": 3}},
    {"id": "ly", "name": "Ly", "age": 2, "avatar": "🐣", "tts_rate": 0.7,
     "asr": {"threshold": 0.25, "margin": 0.05, "max_wrong_before_hint": 2},
     "games": {"dem-so": {"enabled": True, "max_number": 10, "cells": 3},
               "doc-cau": {"enabled": True, "min_words": 3, "max_words": 4}},
     "rewards": {"stars_needed": 2}},
    {"id": "an", "name": "An", "age": 4, "avatar": "🐤", "tts_rate": 0.8,
     "asr": {"threshold": 0.45, "margin": 0.12, "max_wrong_before_hint": 2},
     "games": {"dem-so": {"enabled": True, "max_number": 20, "cells": 5},
               "doc-cau": {"enabled": True, "min_words": 4, "max_words": 6}},
     "rewards": {"stars_needed": 3}},
]


def main() -> int:
    existing = [p.name for p in KIDS.glob("*/profile.json")]
    if existing:
        print(f"Đã có {len(existing)} bé, không gieo thêm.")
        return 0
    for kid in SEED:
        d = KIDS / kid["id"]
        (d / "rewards").mkdir(parents=True, exist_ok=True)
        kid = {**kid, "praise": "{name} giỏi quá!"}
        (d / "profile.json").write_text(
            json.dumps(kid, ensure_ascii=False, indent=2) + "\n", "utf-8")
    (KIDS / "_default" / "rewards").mkdir(parents=True, exist_ok=True)
    print(f"Đã tạo {len(SEED)} hồ sơ: " + ", ".join(k["name"] for k in SEED))
    print("Sửa lại tên/ngưỡng/video thưởng ở trang admin.html.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
