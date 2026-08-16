# Học cùng máy xúc

Bộ trò chơi học tập bằng giọng nói cho trẻ, chạy trong nhà (self-hosted).
Bé đọc to tiếng Việt, máy nghe và mở khoá phần thưởng.

- **`dem-so`** — đếm số 1..20, mở lần lượt các ô bê tông
- **`doc-cau`** — đọc câu ngắn, đọc đúng chữ nào thì chữ đó sáng lên
- **`chon-tu`** — nghe rồi chọn đúng từ; **không cần mic**, chơi được bằng
  điều khiển tivi (Android TV không cho trình duyệt dùng micro)

Chi tiết yêu cầu: [`SPEC.md`](SPEC.md). Cài đặt: [`deploy/install.md`](deploy/install.md).

---

## Ý tưởng cốt lõi

Đây **không phải** bài toán transcription. Hệ thống luôn biết trước bé cần nói gì.

Nên thay vì "nghe ra chữ gì rồi so chuỗi", máy chủ chạy **một** forward pass
wav2vec2 để lấy ma trận log-prob, rồi tính điểm CTC cho **từng ứng viên đã biết
trước** ngay trên ma trận đó. Toàn bộ chi phí nằm ở forward pass — chấm thêm
60 ứng viên nữa chỉ tốn ~20ms, nên cứ đưa cả dải số 1..20 vào, đừng dè sẻn.

Mỗi ứng viên còn nở ra các biến thể chính tả ("bốn"/"tư", mất thanh điệu,
lẫn n/ng — những lỗi trẻ hay mắc), lấy điểm cao nhất trong nhóm. Nhờ vậy bé
nói ngọng vẫn được tính đúng, mà không phải nới ngưỡng cho cả hệ thống.

Client chạy đua hai nguồn: Web Speech API của trình duyệt (nhanh, kém chính
xác) và máy chủ (chậm hơn, chính xác hơn). Bé đọc rõ thì thấy phản hồi tức
thì; bé nói ngọng thì máy chủ cứu. Máy chủ sập thì vẫn chơi được bằng trình
duyệt, có băng báo rõ ràng.

---

## Chạy thử tại chỗ

```bash
python3 -m venv .venv && .venv/bin/pip install -r backend/requirements.txt

# Chưa có model thật? Sinh model GIẢ để thử đường ống (kết quả vô nghĩa
# nhưng API, giao diện, lưu clip, ghi log đều chạy đúng)
python3 scripts/make_dummy_model.py

.venv/bin/uvicorn backend.main:app --port 8000
```

Mở `http://127.0.0.1:8000/app/` — màn chơi, và `/app/admin.html` — trang bố mẹ.

Micro cần secure origin: `localhost` thì được, vào bằng IP trong LAN thì
**bắt buộc HTTPS** (xem `deploy/install.md`).

Model thật: chạy `scripts/export_onnx.py` trên máy có PyTorch, copy 2 file
`.onnx` + `vocab.json` sang `models/`.

---

## Chơi trên tivi (Android TV)

Trình duyệt trên Android TV (Coocaa, Xiaomi...) **không cho dùng micro**, nên
`dem-so` và `doc-cau` không chạy được ở đó — chúng chờ bé nói mà mic thì không
bao giờ mở. `chon-tu` sinh ra cho tình huống này: cả trò chỉ cần 3 phím.

| Phím trên điều khiển | Việc |
|---|---|
| `◀` `▶` | đi giữa các ô (từ, tên bé, tên trò) |
| `OK` | chọn |
| `▲` `▼` | nghe lại đề |
| `Back` | lùi một bậc: màn chơi → chọn trò → chọn bé |

Cả màn chọn bé và chọn trò cũng đi được bằng điều khiển, nên không cần chuột.

Tivi thường **không có giọng đọc tiếng Việt** — lúc đó `chon-tu` tự đổi bong bóng
loa thành hình gợi ý để bé vẫn chơi được. Cài thêm giọng Việt cho máy (Cài đặt →
Text-to-speech) thì trò chơi tự dùng lại đường đọc.

Điểm tiện: trò này không đụng tới mic nên **không cần HTTPS** — trên tivi cứ mở
thẳng `http://<IP máy chủ>:8000/app/` là chơi được, khỏi cài chứng chỉ. Còn muốn
chơi `dem-so`/`doc-cau` trên thiết bị khác thì vẫn phải HTTPS như cũ.

## Kiểm thử

```bash
python3 -m tests.test_scorer                       # lõi CTC, không cần model
python3 -m tests.test_api http://127.0.0.1:8000    # toàn bộ API + tiêu chí §12
python3 -m tests.test_export                       # đường xuất ONNX (cần torch)
```

---

## Cấu trúc

```
backend/
  main.py            FastAPI: /api/recognize, /api/kids, /api/admin/*
  asr/engine.py      nạp ONNX, forward pass, làm nóng lúc khởi động
  asr/scorer.py      chấm điểm CTC tập ứng viên đóng  ← phần lõi
  asr/lexicon.py     chữ tiếng Việt -> token, sinh biến thể chính tả
  asr/vad.py         giải mã audio + cắt im lặng
  profiles.py        hồ sơ trẻ + kho video thưởng
  db.py              SQLite: sessions / attempts / events
frontend/
  index.html         chọn bé -> chọn trò chơi -> chơi
  admin.html         trang bố mẹ: video thưởng, ngưỡng, độ khó
  core/asr.js        chạy đua trình duyệt + máy chủ
  core/audio.js      thu PCM, VAD phía client, đóng gói WAV 16k
  core/keys.js       bàn phím + điều khiển tivi (mũi tên / OK / Back)
  games/<id>/        mỗi trò chơi một thư mục
kids/<id>/           hồ sơ + video thưởng (KHÔNG commit)
models/              file .onnx (KHÔNG commit)
data/                app.db + clip audio (KHÔNG commit)
```

## Thêm thứ mới

| Việc | Cách làm | Cần restart? |
|---|---|---|
| Thêm video thưởng cho bé | Kéo thả ở `admin.html`, hoặc copy vào `kids/<id>/rewards/` | Không |
| Đổi ngưỡng / độ khó / câu khen | `admin.html`, hoặc sửa `kids/<id>/profile.json` | Không |
| Thêm bé | `admin.html` → "Thêm bé mới" | Không |
| Thêm câu tập đọc | Sửa `frontend/games/doc-cau/data/cau.txt` | Không |
| Thêm từ cho "Chọn từ" | Sửa `frontend/games/chon-tu/data/tu.txt` (`từ\|emoji`) | Không |
| Thêm trò chơi | Copy `games/_template/` + thêm 1 dòng vào `games/index.json` — xem [README của template](frontend/games/_template/README.md) | Không |
| Đổi model ASR | Thay file trong `models/` | Có |

## Triển khai

| Đường | Lệnh | Chạy ở đâu |
|---|---|---|
| Máy chủ LAN trong nhà | `scripts/deploy-lan.sh` | máy Mac cùng LAN |
| Tên miền công cộng | `scripts/deploy.sh` | chính máy chủ |
| Gieo hồ sơ 3 bé mặc định | `scripts/seed_kids.py` | máy chủ |
| Xuất model ONNX | `scripts/export_onnx.py` | máy dev (có PyTorch) |

Chi tiết từng bước: [`deploy/install.md`](deploy/install.md).

Số đo với model đúng kích thước thật (110MB int8, Xeon 2.8GHz, 2 luồng):
clip 1.5s + 20 ứng viên → **392ms** (forward 382 + chấm điểm 9), RAM chững ở
380MB. Trên con i3 sẽ chậm hơn 1.5-2.5 lần — phải tự đo, xem `install.md`.

---

## Dữ liệu học tập

Mọi lượt thử ghi một dòng vào bảng `attempts` kèm clip audio trong
`data/clips/YYYY-MM-DD/` (tự dọn sau 90 ngày).

Sau vài tuần chỗ này thành bộ dữ liệu giọng riêng của bọn trẻ — dùng để
chỉnh lại ngưỡng cho từng bé (xem mục "Thống kê" trong `admin.html`), và về
sau có thể fine-tune. Audio **không bao giờ rời khỏi máy chủ trong nhà**:
không API trả tiền, không dịch vụ đám mây, font cũng tự host.
