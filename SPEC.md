# SPEC — Bộ trò chơi học tập bằng giọng nói cho trẻ (self-hosted)

Tài liệu này là hợp đồng kỹ thuật. Người thực thi: Claude Code.
Đọc hết trước khi viết dòng code đầu tiên. Nếu có mâu thuẫn, hỏi lại trước khi tự quyết.

---

## 0. Bối cảnh & mục tiêu

Bộ trò chơi web cho 3 đứa trẻ trong nhà (Min 4 tuổi, Ly 2 tuổi, An), học qua việc **đọc to bằng tiếng Việt**.
Đã có 2 prototype chạy được dạng HTML tĩnh dùng Web Speech API:
- `dem-so` — đếm số 1..20, mở lần lượt 5 ô
- `doc-cau` — đọc câu ngắn 4-6 chữ, đọc đúng chữ nào thì chữ đó sáng lên

Mục tiêu bản này:
1. Thay lõi nhận diện giọng nói bằng **ASR tự host**, chính xác hơn nhiều với giọng trẻ nói chưa rõ
2. **Module hoá** để thêm trò chơi mới = thả thêm 1 thư mục, không sửa lõi
3. **Cá nhân hoá** theo từng bé: video thưởng riêng, ngưỡng nhận diện riêng, độ khó riêng
4. Ghi lại dữ liệu học tập để về sau tinh chỉnh và làm dashboard cho bố mẹ

**Triết lý xuyên suốt — đọc kỹ, đây là điều quan trọng nhất trong tài liệu này:**

> Đây KHÔNG phải bài toán transcription. Đây là bài toán **verification với tập ứng viên đóng**.
> Hệ thống luôn biết trước bé cần nói gì. Nhiệm vụ không phải "nghe ra chữ gì" mà là
> "trong N ứng viên đã biết, cái nào khớp audio nhất, và có cách biệt đủ rõ không".
> Mọi quyết định thiết kế phải phục vụ điều này. Đừng bao giờ decode văn bản tự do rồi so chuỗi
> ở đường đi chính.

---

## 1. Ràng buộc cứng

| Hạng mục | Ràng buộc |
|---|---|
| Phần cứng | Máy cũ, Core i3, 8GB RAM, **không GPU** |
| Độ trễ | Từ lúc bé nói xong đến khi có phản hồi: **< 1 giây** (p95). Vượt 1.5s là hỏng trải nghiệm |
| RAM backend | Tổng < 2GB thường trú |
| Triển khai | `git pull` + restart service. **KHÔNG dùng Docker** (build torch/onnx trên i3 quá lâu) |
| Frontend | Vanilla JS ES modules, **không build step**, không npm ở phía server |
| Mạng | Chạy trong LAN. Bắt buộc HTTPS vì mic yêu cầu secure origin |
| Thiết bị | iPad (Safari — bắt buộc, Chrome iOS không có Web Speech API), Android Chrome, desktop |
| Chi phí vận hành | 0đ. Không phụ thuộc API trả tiền ở đường đi chính |
| Quyền riêng tư | Audio giọng trẻ **không được rời khỏi máy chủ trong nhà** |

---

## 2. Stack

- **Backend**: Python 3.11+, FastAPI, uvicorn
- **ASR**: ONNX Runtime (CPU, int8). KHÔNG cài PyTorch ở môi trường chạy production
- **DB**: SQLite (WAL mode)
- **Frontend**: Vanilla JS ES modules, không framework, không bundler
- **Reverse proxy / TLS**: Caddy (tự động cấp cert)
- **Process**: systemd unit
- **Repo**: GitHub, deploy bằng git pull

Cấm dùng: React/Vue, webpack/vite, Docker, Postgres, Redis, Celery. Quy mô 3 người dùng.

---

## 3. Cấu trúc thư mục

```
repo/
├─ backend/
│  ├─ main.py              # FastAPI app, khai báo route
│  ├─ asr/
│  │  ├─ engine.py         # nạp model ONNX, forward pass, cache
│  │  ├─ scorer.py         # chấm điểm CTC cho tập ứng viên đóng
│  │  ├─ vad.py            # cắt im lặng
│  │  └─ lexicon.py        # chữ tiếng Việt -> chuỗi ký tự/âm vị để chấm
│  ├─ db.py                # schema + truy vấn SQLite
│  ├─ profiles.py          # đọc/ghi hồ sơ trẻ
│  ├─ config.py            # cấu hình qua biến môi trường
│  └─ requirements.txt
├─ frontend/
│  ├─ index.html           # màn chọn bé -> chọn trò chơi
│  ├─ core/
│  │  ├─ registry.js       # dò và nạp game module
│  │  ├─ audio.js          # thu âm, VAD phía client, mở khoá audio iOS
│  │  ├─ asr.js            # cổng nhận diện (chạy đua 2 nguồn)
│  │  ├─ speak.js          # TTS
│  │  ├─ reward.js         # sao + video thưởng
│  │  ├─ ui.js             # tiện ích DOM dùng chung, hiệu ứng
│  │  ├─ keys.js           # bàn phím + điều khiển tivi (D-pad)
│  │  ├─ session.js        # trạng thái phiên chơi, gửi log
│  │  └─ style.css         # design tokens dùng chung
│  └─ games/
│     ├─ dem-so/
│     │  ├─ manifest.json
│     │  ├─ game.js
│     │  └─ style.css      # tuỳ chọn
│     ├─ doc-cau/
│     │  ├─ manifest.json
│     │  ├─ game.js
│     │  └─ data/cau.txt
│     ├─ chon-tu/          # không cần mic — chơi được trên tivi
│     │  ├─ manifest.json
│     │  ├─ game.js
│     │  └─ data/tu.txt
│     └─ _template/        # bộ khung để copy khi làm game mới
├─ kids/                   # DỮ LIỆU, không commit lên git
│  ├─ min/
│  │  ├─ profile.json
│  │  └─ rewards/*.mp4
│  ├─ ly/
│  └─ an/
├─ models/                 # file .onnx, không commit lên git
├─ data/
│  ├─ app.db
│  └─ clips/               # audio đã lưu, phân theo ngày
├─ deploy/
│  ├─ kidsapp.service
│  ├─ Caddyfile
│  └─ install.md
└─ SPEC.md
```

`kids/`, `models/`, `data/` nằm ngoài git. Commit `kids/_example/` làm mẫu cấu trúc.

---

## 4. Lõi ASR — phần khó nhất, làm cẩn thận

### 4.1 Chọn model

Dùng **wav2vec2 CTC tiếng Việt** làm đường đi chính. Gợi ý điểm khởi đầu:
`nguyenvulebinh/wav2vec2-base-vietnamese-250h`. Xuất sang ONNX, lượng tử hoá int8.

**Không dùng Whisper/PhoWhisper ở đường đi chính.** Whisper là seq2seq, phải decode tuần tự,
trên i3 mất 1.5-3 giây mỗi lượt — quá chậm. Wav2vec2 chỉ cần một forward pass,
mục tiêu 0.3-0.8 giây cho clip 1-2 giây.

Tuỳ chọn: PhoWhisper-base int8 làm đường phụ cho trò chơi cần transcript tự do.
Nạp lười (lazy), giải phóng sau 5 phút không dùng. Không nạp cùng lúc với wav2vec2 nếu RAM căng.

### 4.2 Chấm điểm tập ứng viên đóng — đây là điểm mấu chốt

Không decode. Quy trình:

1. Forward pass -> ma trận log-prob theo khung thời gian, kích thước `[T, V]`
2. Với **mỗi ứng viên** trong danh sách client gửi lên, tính CTC forward score của chuỗi ký tự đó
   trên chính ma trận đó (thuật toán CTC forward chuẩn, cộng log)
3. Chuẩn hoá theo độ dài chuỗi (nếu không, chuỗi ngắn luôn thắng)
4. Softmax trên tập ứng viên -> xác suất tương đối
5. Trả về xếp hạng đầy đủ

Bước 2-5 là phép toán vặt (< 5ms cho 20 ứng viên). Toàn bộ chi phí nằm ở bước 1.
Nghĩa là **thêm ứng viên gần như miễn phí**.

Sinh biến thể chính tả cho mỗi ứng viên và lấy điểm cao nhất trong nhóm:
- "bốn" và "tư"; "năm" và "lăm"; "mười bốn" và "mười tư"
- bỏ dấu thanh (ASR hay sai thanh điệu ở giọng trẻ)
- phụ âm cuối dễ lẫn: n/ng, t/c, m/p

### 4.3 Quyết định đúng/sai

Trả về cho client, để client quyết theo hồ sơ của bé:

```
best        = ứng viên điểm cao nhất
best_prob   = xác suất sau softmax
margin      = best_prob - prob của ứng viên hạng nhì
```

Cho qua khi: `best == từ mong đợi` VÀ `best_prob >= kid.threshold` VÀ `margin >= kid.margin`.

Giá trị khởi điểm: Min `threshold 0.45 / margin 0.12`; Ly `threshold 0.25 / margin 0.05`;
An dùng mặc định của Min. Đây là **con số đoán, phải chỉnh lại bằng dữ liệu thật** sau 2 tuần.

Không nuốt lỗi: nếu `best` không phải từ mong đợi nhưng nằm trong danh sách, trả luôn ra để
client hiển thị "nghe thành …" — cực kỳ hữu ích khi debug.

### 4.4 VAD

Cắt im lặng ở **cả hai phía**:
- Client: dừng thu sau ~700ms im lặng, timeout cứng 5 giây
- Server: cắt lại lần nữa trước khi forward pass

Chi phí CPU tỉ lệ thẳng với độ dài audio. Clip 4 giây tốn gấp 3 clip 1.3 giây.

---

## 5. API backend

Tất cả JSON trừ chỗ ghi rõ khác. Không cần auth (LAN nội bộ), nhưng chặn theo IP nguồn.

### `POST /api/recognize`
`multipart/form-data`:
- `audio`: webm/opus hoặc wav 16kHz mono
- `candidates`: mảng JSON các chuỗi ứng viên, ví dụ `["một","hai",...,"hai mươi"]`
- `expected`: chuỗi, từ đang mong đợi
- `kid_id`, `game_id`, `session_id`

Trả về:
```json
{
  "best": "bảy",
  "best_prob": 0.71,
  "margin": 0.34,
  "ranking": [["bảy",0.71],["tám",0.37],["sáu",0.11]],
  "expected_prob": 0.71,
  "audio_ms": 1240,
  "compute_ms": 480,
  "clip_id": "2026-08-13/abc123.webm"
}
```

`ranking` cắt còn top 5. Luôn kèm `compute_ms` để theo dõi hiệu năng.

### `POST /api/transcribe`
Đường phụ transcript tự do (Whisper). Chỉ dùng khi trò chơi khai báo cần.
Body: `audio`. Trả `{"text": "..."}`.

### `GET /api/kids`
Danh sách hồ sơ trẻ. Không trả đường dẫn hệ thống.

### `GET /api/kids/{id}/reward`
Trả về đường dẫn một video thưởng ngẫu nhiên của bé đó. Không có thì rơi về video mặc định.

### `POST /api/events`
Ghi log. Body: mảng sự kiện (gộp theo lô, client gửi mỗi 10 sự kiện hoặc cuối phiên).

### `GET /api/health`
`{"ok": true, "model": "...", "warm": true, "rss_mb": 612}`

**Yêu cầu quan trọng**: nạp và làm nóng model lúc khởi động (chạy một forward pass giả).
Lượt đầu tiên không được chậm hơn các lượt sau.

---

## 6. Hồ sơ trẻ

`kids/<id>/profile.json`:

```json
{
  "id": "min",
  "name": "Min",
  "age": 4,
  "avatar": "🚜",
  "praise": "{name} giỏi quá!",
  "tts_rate": 0.8,
  "asr": { "threshold": 0.45, "margin": 0.12, "max_wrong_before_hint": 2 },
  "games": {
    "dem-so":  { "enabled": true, "max_number": 20, "cells": 5 },
    "doc-cau": { "enabled": true, "min_words": 4, "max_words": 6 }
  },
  "rewards": { "stars_needed": 3 }
}
```

Video thưởng: mọi file trong `kids/<id>/rewards/`, chọn ngẫu nhiên, không lặp lại video vừa chiếu.
Thư mục rỗng -> dùng `kids/_default/rewards/`.
Thêm video = copy file vào thư mục, **không sửa code, không restart**.

Sửa `profile.json` phải có hiệu lực ở lần tải trang sau, không cần restart service.

---

## 7. Hợp đồng của một trò chơi

### 7.1 manifest.json

```json
{
  "id": "dem-so",
  "title": "Đếm số",
  "icon": "🚜",
  "description": "Đếm tiếp từ một số bất kỳ",
  "min_age": 3,
  "needs": ["mic"],
  "asr_mode": "closed_set"
}
```

`asr_mode`: `closed_set` (mặc định) hoặc `free_text`.

`needs`: `["mic"]` cho trò cần bé nói. Khai `[]` thì lõi giấu nút mic đi — dành cho
trò chơi bằng tay/điều khiển (xem §7.4).

### 7.2 game.js

```js
export default {
  id: 'dem-so',

  // Được gọi khi bé vào trò chơi.
  // ctx là toàn bộ bề mặt tiếp xúc với lõi — game KHÔNG được đụng
  // trực tiếp vào mic, fetch, video thưởng hay DB.
  async setup(ctx) {
    // ctx.kid            hồ sơ bé đang chơi (chỉ đọc)
    // ctx.settings       ctx.kid.games[this.id]
    // ctx.root           phần tử DOM để game vẽ vào, đã dọn sẵn
    // ctx.assetUrl(p)    đường dẫn tới file trong thư mục game

    // ctx.listen({ candidates, expected, timeoutMs })
    //     -> { ok, best, bestProb, margin, ranking, source }
    //     Lo trọn gói: mic, VAD, chạy đua nhiều nguồn nhận diện,
    //     áp ngưỡng theo hồ sơ bé, ghi log, lưu clip.
    //     `source` là 'browser' | 'server' — để debug.

    // ctx.speak(text, { rate })     -> Promise, TTS tiếng Việt
    // ctx.speech.supported()        máy có TTS không
    // ctx.speech.hasVoice(lang)     có giọng đọc thứ tiếng đó không
    // ctx.dpad({ axis, onKey })     con trỏ mũi tên + OK cho điều khiển tivi
    // ctx.correct(el)               hiệu ứng đúng + tiếng ding
    // ctx.wrong(el)                 hiệu ứng sai + tiếng báo
    // ctx.star()                    cộng 1 sao; đủ số sao thì lõi
    //                               tự chiếu video thưởng của bé
    // ctx.log(type, payload)        ghi sự kiện tuỳ ý
    // ctx.onExit(fn)                đăng ký dọn dẹp
  }
}
```

**Nguyên tắc bất di bất dịch**: game chỉ mô tả *đang chờ gì*, không bao giờ tự xử lý audio.
Muốn đổi engine ASR thì sửa `core/asr.js`, không đụng vào game nào cả.

`dem-so` gọi `ctx.listen({ candidates: ['một',...,'hai mươi'], expected: 'bảy' })`.
`doc-cau` truyền các chữ còn lại của câu làm ứng viên, `expected` là chữ kế tiếp.

### 7.3 Đăng ký game

`registry.js` nạp `frontend/games/*/manifest.json`. Thêm game = thả thư mục + khai báo
trong `games/index.json` (một mảng id — vì trình duyệt không liệt kê thư mục được).
Không sửa dòng code lõi nào.

Bàn giao kèm `games/_template/` chạy được ngay: một trò chơi tối giản minh hoạ đủ vòng đời.

### 7.4 Trò chơi trên tivi (không mic, điều khiển bằng D-pad)

Android TV (Coocaa, Xiaomi...) **không cho trình duyệt dùng micro** — mọi trò dựa trên
`ctx.listen()` đứng hình ở đó. Nên có thêm một nhánh trò chơi chơi bằng tay:

| Thứ | Luật |
|---|---|
| `manifest.needs` | `[]` -> lõi giấu nút mic. Dòng `#status` vẫn giữ. |
| Phím | `core/keys.js` quy mọi mã phím của mọi hãng về 6 tên: `left/right/up/down/ok/back` |
| Con trỏ | `ctx.dpad({ axis, enabled, onKey })` — mũi tên đi, OK bấm, tự bỏ qua ô đã khoá |
| Nút Back | Vỏ ứng dụng lo: màn chơi -> chọn trò -> chọn bé |
| Một phím một việc | Một `keydown` chỉ được MỘT chỗ xử lý (`keys.js` đánh dấu sự kiện đã dùng) |
| Vòng viền chọn | Class `.sel`, **không** chỉ dựa vào `:focus-visible` — trình duyệt tivi đời cũ chưa có |
| Không có giọng Việt | Hỏi `ctx.speech.hasVoice()`, thiếu thì phải bày cách chơi khác (hình gợi ý) |

Trò đầu tiên theo nhánh này là `chon-tu`: hiện 2-3 từ ngắn, đọc *"Bé hãy chọn đâu là …"*,
im lặng 5 giây thì đọc lại, bé chọn bằng chuột / chạm / `◀ ▶` + `OK`.
Số từ mỗi lượt lấy từ `profile.games["chon-tu"].so_lua_chon` (2 hoặc 3).

---

## 8. Chạy đua nhận diện (client)

`core/asr.js` khi được gọi `listen()` phải chạy **song song**:

1. Web Speech API của trình duyệt — miễn phí, trả về ~200-500ms, kém chính xác
2. Thu audio -> `POST /api/recognize` — chậm hơn 0.5-1.5s, chính xác hơn nhiều

Luật quyết định:
- Trình duyệt trả kết quả **khớp từ mong đợi** -> chấp nhận ngay, huỷ request server
  (vẫn gửi audio đi để lưu log, đừng huỷ phần ghi dữ liệu)
- Trình duyệt trả sai hoặc không hỗ trợ -> chờ server quyết
- Server không tới được -> chạy tiếp bằng mình trình duyệt, hiện chỉ báo "chế độ offline"

Kết quả: bé đọc rõ thấy phản hồi tức thì; bé nói ngọng được server cứu. Ứng dụng
không bao giờ chết hoàn toàn khi server sập.

Safari iOS: `continuous = false`, `interimResults = false`. Bật `continuous` có bug
không tự tắt mic.

---

## 9. Schema SQLite

```sql
CREATE TABLE sessions(
  id TEXT PRIMARY KEY, kid_id TEXT, game_id TEXT,
  started_at INTEGER, ended_at INTEGER
);

CREATE TABLE attempts(
  id INTEGER PRIMARY KEY,
  session_id TEXT, kid_id TEXT, game_id TEXT,
  expected TEXT, best TEXT,
  best_prob REAL, margin REAL,
  accepted INTEGER,          -- 0/1
  source TEXT,               -- browser | server
  audio_ms INTEGER, compute_ms INTEGER,
  clip_path TEXT,
  created_at INTEGER
);

CREATE INDEX idx_attempts_kid_word ON attempts(kid_id, expected);
```

Lưu clip audio vào `data/clips/YYYY-MM-DD/`. Đây là **tài sản quý nhất của dự án** —
sau vài tuần nó thành bộ dữ liệu giọng riêng của 3 đứa trẻ, dùng để chỉnh ngưỡng,
sinh template cá nhân hoá, hoặc fine-tune về sau. Tự dọn clip cũ hơn 90 ngày.

---

## 10. Frontend — thẩm mỹ và trải nghiệm

Giữ nguyên hướng thị giác của prototype: thế giới công trường, máy xúc vàng, sọc cảnh báo
đen-vàng, nền trời xanh, font Fredoka. Đọc `dem-so.html` và `doc-cau.html` hiện có
để lấy design token, đừng vẽ lại từ đầu.

Yêu cầu bắt buộc:
- Vùng bấm tối thiểu 44px. Người dùng là trẻ 2 tuổi
- Mọi thứ đọc được từ khoảng cách một sải tay trên iPad
- Mở khoá audio/video của iOS trong **cú chạm đầu tiên** (chọn bé) — phát rồi tạm dừng
  cả `<video>` lẫn một utterance câm, nếu không iOS sẽ chặn tiếng về sau
- Không bao giờ để bé kẹt: luôn có nút "nghe mẫu" và "mở giúp"
- Sai `max_wrong_before_hint` lần thì máy đọc mẫu cho bé đọc theo
- Tôn trọng `prefers-reduced-motion`
- Không dùng localStorage cho dữ liệu quan trọng — trạng thái nằm ở server

---

## 11. Triển khai

- `deploy/kidsapp.service` — systemd, `Restart=always`, chạy dưới user riêng không phải root
- `deploy/Caddyfile` — TLS, phục vụ `frontend/` tĩnh, proxy `/api/*` sang uvicorn
- `deploy/install.md` — các bước bằng tiếng Việt: tạo venv, tải model, xuất ONNX,
  cài systemd, cài Caddy, kiểm tra bằng health check
- Script `scripts/export_onnx.py` — chạy **một lần trên máy dev** (nơi có PyTorch),
  đẩy file `.onnx` sang server. Server production không cần PyTorch
- Đường đi deploy: `git pull && systemctl restart kidsapp`. Không build step

---

## 12. Tiêu chí nghiệm thu

1. `GET /api/health` trả `warm: true` trong vòng 30 giây sau khi khởi động
2. `POST /api/recognize` với clip 1.5 giây, 20 ứng viên: `compute_ms < 800` trên i3
3. RAM thường trú của backend < 2GB sau 100 request liên tiếp (kiểm tra rò rỉ bộ nhớ)
4. Thả một thư mục vào `frontend/games/` + thêm 1 dòng vào `index.json` -> game hiện ra,
   không sửa file lõi nào
5. Copy một `.mp4` vào `kids/ly/rewards/` -> Ly nhận được video đó, không restart
6. Ngắt mạng server -> ứng dụng vẫn chơi được bằng Web Speech API, có chỉ báo rõ ràng
7. Chơi trên iPad Safari qua HTTPS: mic hỏi quyền **đúng một lần**, sau đó nhớ vĩnh viễn
8. Mọi lượt thử đều sinh một dòng trong `attempts`, kèm clip lưu trên đĩa
9. `dem-so` và `doc-cau` chạy đúng như prototype, cộng thêm nhận diện từ server
10. Không có console.error nào khi chạy bình thường

---

## 13. Ngoài phạm vi (đừng làm ở giai đoạn này)

- Đăng nhập, phân quyền, multi-tenant
- Dashboard cho bố mẹ (giai đoạn sau, nhưng schema DB phải sẵn sàng cho nó)
- Sinh câu bằng LLM (giai đoạn sau)
- Fine-tune model
- Ứng dụng di động native
- Đồng bộ đám mây

---

## 14. Thứ tự thực hiện

1. Backend khung + `/api/health` + nạp và làm nóng model ONNX
2. `/api/recognize` với chấm điểm CTC tập đóng — **kiểm chứng độ trễ trên i3 trước khi
   đi tiếp**. Nếu quá 1 giây, dừng lại báo cáo, đừng xây tiếp lên nền móng chậm
3. `core/` frontend: audio, asr với cơ chế chạy đua, speak, reward, registry
4. Port `dem-so` sang dạng module
5. Port `doc-cau` sang dạng module
6. `_template/` + tài liệu viết game mới
7. Hồ sơ trẻ + video thưởng riêng
8. Ghi log + lưu clip
9. Script deploy + tài liệu cài đặt

Sau mỗi bước phải chạy được thật. Không dựng 9 bước rồi mới test lần đầu.

---

## 15. Điểm cần hỏi lại trước khi tự quyết

- Model wav2vec2 cụ thể nào, sau khi đã thử benchmark thực tế trên i3
- Định dạng audio client gửi lên (webm/opus của MediaRecorder vs wav thô) — cân nhắc
  chi phí giải mã phía server
- Cách sinh biến thể chính tả: bảng tay hay quy tắc âm vị
- Có tách quy trình cho `doc-cau` không (ứng viên là các chữ còn lại, khác với 20 số cố định)
