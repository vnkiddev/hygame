# Cài đặt trên máy chủ trong nhà

Máy cũ Core i3, 8GB RAM, không GPU, Ubuntu/Debian. Không dùng Docker.

Toàn bộ quá trình khoảng 30 phút, phần lâu nhất là tải model trên máy dev.

---

## 1. Chuẩn bị máy chủ

```bash
sudo apt update
sudo apt install -y python3.11 python3.11-venv git
# ffmpeg chỉ cần nếu về sau có client gửi audio nén.
# Đường đi chính gửi WAV 16k nên KHÔNG bắt buộc.
sudo apt install -y ffmpeg

# Người dùng riêng, không phải root
sudo useradd -r -m -d /srv/kidsapp -s /bin/bash kidsapp
```

## 2. Lấy mã nguồn

```bash
sudo -u kidsapp -H bash
cd /srv/kidsapp
git clone <đường-dẫn-repo> .
python3.11 -m venv .venv
.venv/bin/pip install -U pip
.venv/bin/pip install -r backend/requirements.txt
mkdir -p models data kids
exit
```

## 3. Xuất model ONNX — làm trên MÁY DEV

Máy chủ không cần PyTorch. Chỉ máy dev cần, và chỉ một lần.

```bash
# trên máy dev (máy có sẵn python + đủ RAM)
# onnxscript là BẮT BUỘC với torch >= 2.6 — thiếu nó torch.onnx.export chết
pip install torch transformers onnx onnxruntime onnxscript
python3 scripts/export_onnx.py --bench

# kiểm luôn đường xuất mà không cần tải model (dựng kiến trúc tại chỗ)
python3 -m tests.test_export

# copy sang máy chủ
scp models/wav2vec2-vi-int8.onnx models/vocab.json \
    kidsapp@may-chu:/srv/kidsapp/models/
```

Model mặc định: `nguyenvulebinh/wav2vec2-base-vietnamese-250h` — 94.5 triệu
tham số, ra **một file ~110MB** sau int8 (script tự gộp trọng số vào trong
file; bản xuất thô của torch để trọng số ở file `.onnx.data` riêng, copy
thiếu là model hỏng).

Trong lúc xuất, torch 2.13 có in `UserWarning` về `dynamic_axes` — không sao,
script kiểm lại ngay sau đó rằng trục thời gian thật sự động.

**Con số tham chiếu** (đo trên Xeon 2.8GHz, 2 luồng ONNX, kiến trúc thật):

| Độ dài clip | forward pass | cả lượt (kèm chấm 20 ứng viên) |
|---|---|---|
| 1.0s | 157 ms | ~250 ms |
| 1.5s | 228 ms | 332 ms |
| 2.0s | 305 ms | ~410 ms |
| 3.0s | 451 ms | ~560 ms |

Đo qua cả đường HTTP thật (`/api/recognize`, model 110MB, 20 ứng viên,
clip 1.5s): `compute_ms` 392ms — forward 382ms + chấm điểm 9ms; độ trễ HTTP
p50 401ms, p95 411ms. RAM thường trú 312MB lúc khởi động, chững ở **380MB** và đứng yên suốt 300
request với clip dài ngắn khác nhau — phần tăng lúc đầu là ONNX Runtime cấp
phát buffer cho các cỡ đầu vào rồi thôi, không phải rò rỉ.

Con i3 sẽ **chậm hơn** — có thể gấp 1.5-2.5 lần. Vẫn nằm trong ngân sách
1 giây nếu VAD cắt gọn về 1-2 giây, nhưng phải tự đo, đừng tin bảng này.

**Kiểm tốc độ ngay trên con i3 trước khi đi tiếp** — SPEC §14.2:

```bash
sudo -u kidsapp /srv/kidsapp/.venv/bin/python -c "
import time, numpy as np, onnxruntime as ort
s = ort.InferenceSession('/srv/kidsapp/models/wav2vec2-vi-int8.onnx',
                         providers=['CPUExecutionProvider'])
x = np.random.randn(1, 16000*3).astype('float32')
s.run(None, {'input_values': x})
for sec in (1.0, 1.5, 2.0):
    a = np.random.randn(1, int(16000*sec)).astype('float32')
    t = time.perf_counter()
    for _ in range(5): s.run(None, {'input_values': a})
    print(f'{sec}s -> {(time.perf_counter()-t)/5*1000:.0f} ms')
"
```

Clip 1.5 giây phải dưới **800ms**. Nếu vượt 1 giây thì **dừng lại**, đừng xây
tiếp lên nền móng chậm — thử `ASR_THREADS=4`, hoặc model nhỏ hơn, hoặc chấp
nhận rằng máy này không kham nổi.

## 4. Hồ sơ trẻ + video thưởng

```bash
sudo -u kidsapp -H bash
cd /srv/kidsapp
cp -r kids/_example kids/min      # rồi sửa kids/min/profile.json
mkdir -p kids/min/rewards
exit
```

Nhanh hơn: bật dịch vụ trước, rồi vào `https://hocmayxuc.home/admin.html`
thêm bé và **kéo thả video thưởng** bằng chuột. Không cần chạm vào file.

Video dùng chung cho mọi bé thì để ở `kids/_default/rewards/`.

## 5. systemd

```bash
sudo cp /srv/kidsapp/deploy/kidsapp.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now kidsapp
sudo systemctl status kidsapp
curl -s localhost:8000/api/health | python3 -m json.tool
```

Phải thấy `"warm": true` trong vòng 30 giây. Chưa `warm` thì xem
`journalctl -u kidsapp -n 50`.

## 6. Caddy (HTTPS — bắt buộc, vì micro cần secure origin)

```bash
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
  | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
  | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install -y caddy

sudo cp /srv/kidsapp/deploy/Caddyfile /etc/caddy/Caddyfile
# SỬA: đổi 192.168.1.50 thành IP thật của máy chủ
sudo nano /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

Trỏ tên miền `hocmayxuc.home` về IP máy chủ: đặt ở router (DNS nội bộ),
hoặc thêm vào `/etc/hosts` của từng máy.

### Cho iPad tin cậy chứng chỉ (làm một lần)

```bash
sudo cat /var/lib/caddy/.local/share/caddy/pki/authorities/local/root.crt
```

Copy file `root.crt` sang iPad (AirDrop hoặc gửi mail), rồi:
Cài đặt → Cấu hình đã tải về → **Cài đặt** →
Cài đặt chung → Giới thiệu → **Tin cậy chứng chỉ** → bật công tắc.

Xong bước này Safari mới cho dùng micro mà không hỏi lại mỗi lần.

## 7. Kiểm tra

```bash
# trên máy chủ
python3 -m tests.test_scorer                       # lõi chấm điểm CTC
python3 -m tests.test_api http://127.0.0.1:8000    # toàn bộ API
```

Trên iPad, mở `https://hocmayxuc.home`:

1. Chọn tên bé → Safari hỏi quyền micro → **Cho phép** (chỉ hỏi một lần)
2. Chọn trò chơi → đọc thử → ô phải mở ra
3. Đủ sao → video thưởng phải chạy có tiếng

## 8. Cập nhật về sau

```bash
sudo -u kidsapp git -C /srv/kidsapp pull
sudo systemctl restart kidsapp
```

Không có bước build. Thêm game hoặc video thưởng thì **không cần restart**.

---

## Xử lý sự cố

| Hiện tượng | Nguyên nhân thường gặp |
|---|---|
| `warm: false` mãi | Chưa copy file `.onnx`/`vocab.json`. Xem `/api/health` field `error` |
| Safari không cho dùng micro | Đang vào bằng `http://`. Bắt buộc `https://` |
| Hỏi quyền micro mỗi lần | Chưa cài cert gốc của Caddy vào iPad (bước 6) |
| Băng "📴 chế độ đơn giản" | uvicorn chết. `systemctl status kidsapp` |
| Nhận diện chậm > 1.5s | Xem `compute_ms` trong `/api/recognize`. Cao thì tại model, không phải tại mạng |
| Bé đọc đúng mà máy vẫn báo sai | Hạ `threshold`/`margin` của bé đó ở trang quản trị |
| Máy nhận bừa, sai cũng cho qua | Nâng `threshold`/`margin` |
| Hết dung lượng đĩa | `data/clips/` — tự xoá sau 90 ngày, đổi bằng `CLIP_RETENTION_DAYS` |

### Biến môi trường

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `ASR_MODEL_PATH` | `models/wav2vec2-vi-int8.onnx` | File model |
| `ASR_VOCAB_PATH` | `models/vocab.json` | Bảng token, phải khớp model |
| `ASR_THREADS` | `2` | Số luồng ONNX |
| `ASR_SOFTMAX_T` | `1.0` | Nhiệt độ softmax. Nhỏ hơn = xác suất nhọn hơn |
| `SAVE_CLIPS` | `1` | Lưu audio để về sau chỉnh ngưỡng |
| `CLIP_RETENTION_DAYS` | `90` | Giữ clip bao lâu |
| `ALLOWED_NETS` | các dải LAN | Dải IP được phép gọi API. `*` để tắt |
| `ADMIN_TOKEN` | rỗng | Đặt để khoá trang quản trị |
| `WHISPER_ENABLED` | `0` | Bật đường phụ transcript tự do |
| `MAX_AUDIO_SEC` | `6` | Cắt cứng audio dài hơn mức này |

---

## Đẩy lên máy chủ trong LAN (đường dùng hằng ngày)

Chạy **trên máy Mac** (máy nằm cùng LAN với máy chủ):

```bash
curl -fsSL https://raw.githubusercontent.com/vnkiddev/hygame/claude/spec-video-rewards-5j3xrb/scripts/deploy-lan.sh | bash
```

Cần `sshpass` (`brew install hudochenkov/sshpass/sshpass`). Script tự chọn
cổng trống 6000-7000, clone/pull mã nguồn vào `~/apps/hygame`, dựng venv,
gieo sẵn hồ sơ 3 bé nếu máy chủ chưa có bé nào, chạy app bằng PM2 (hoặc
nohup), thêm ingress cloudflared, rồi in ra link LAN + mã quản trị.
Chạy lại nhiều lần vô hại — lần sau chính là lệnh cập nhật.

Đổi máy chủ hoặc subdomain thì đặt biến: `SERVER=... SUB=... bash ...`.

**Micro sẽ KHÔNG chạy qua link LAN** vì đó là `http://`, mà micro đòi
secure origin. Link LAN dùng để xem giao diện, sửa video thưởng, kiểm hồ
sơ. Muốn thử giọng nói thì vào bằng `https://<sub>.vnkid.dev`, hoặc bật cờ
`chrome://flags/#unsafely-treat-insecure-origin-as-secure` trên máy tính.

---

## Mở ra tên miền công cộng (vd. `hygame.vnkid.dev`)

Cách nhanh nhất — chạy **trên chính máy chủ**:

```bash
curl -fsSL https://raw.githubusercontent.com/vnkiddev/hygame/claude/spec-video-rewards-5j3xrb/scripts/deploy.sh \
  | sudo DOMAIN=hygame.vnkid.dev bash
```

Script tự làm hết: cài gói, clone/pull mã nguồn, tạo venv, sinh
`ADMIN_TOKEN` ngẫu nhiên ghi vào `/etc/kidsapp.env`, cài systemd, đợi
health check, rồi cài `deploy/Caddyfile.public`. Chạy lại nhiều lần vô hại
— lần sau chính là lệnh cập nhật.

Model ONNX vẫn phải tự copy sang `models/` (mục 3), script không tải hộ
được vì việc xuất model cần PyTorch.

### Khác biệt so với chạy trong LAN — đọc kỹ

**1. Bảo mật.** Trong LAN, SPEC §5 cho phép không cần auth. Ra internet thì
khác hẳn: trang quản trị cho tải lên/xoá video và xem dữ liệu học của trẻ,
còn `data/clips/` là giọng thật của bọn trẻ. `ADMIN_TOKEN` là cánh cửa duy
nhất — script tự sinh sẵn, đừng để trống.

Lọc theo dải IP (`ALLOWED_NETS`) **hết tác dụng** khi đứng sau proxy, vì
mọi request đều tới từ `127.0.0.1`. Đó là lý do script đặt `ALLOWED_NETS=*`
và dựa vào token.

Muốn chắc hơn nữa thì đặt thêm một lớp trước bằng Cloudflare Access, hoặc
`basic_auth` của Caddy cho riêng `/admin.html` và `/api/admin/*`.

**2. Giới hạn tải lên qua Cloudflare.** Gói miễn phí chặn body > 100MB, nên
video thưởng dài sẽ hỏng giữa chừng. Cách xử lý: nén video xuống dưới 100MB,
hoặc copy thẳng vào `kids/<id>/rewards/` bằng scp, hoặc dùng
Cloudflare Tunnel (`cloudflared`) — tunnel không dính giới hạn này.

**3. Micro.** Tên miền công cộng có cert Let's Encrypt thật, nên iPad
**không** phải cài chứng chỉ gốc nữa. Bỏ qua được bước 6 phần cert.
