# Làm một trò chơi mới

Bốn bước, không đụng vào file lõi nào.

## 1. Copy thư mục

```bash
cp -r frontend/games/_template frontend/games/ten-tro-choi
```

## 2. Sửa `manifest.json`

```json
{
  "id": "ten-tro-choi",
  "title": "Tên hiện trên màn chọn",
  "icon": "🎈",
  "description": "Một dòng mô tả",
  "min_age": 3,
  "needs": ["mic"],
  "asr_mode": "closed_set"
}
```

`asr_mode`:
- `closed_set` (mặc định) — luôn dùng cái này. Hệ thống biết trước bé cần nói
  gì, chỉ việc chọn trong danh sách. Nhanh và chính xác hơn hẳn.
- `free_text` — chỉ khi thật sự không đoán trước được bé sẽ nói gì. Chậm
  (1.5-3 giây trên máy i3) và cần bật `WHISPER_ENABLED=1` ở máy chủ.

`needs`:
- `["mic"]` — trò cần bé nói.
- `[]` — trò chơi bằng tay/điều khiển, lõi giấu nút mic đi. **Bắt buộc** dùng
  cái này nếu muốn chạy trên Android TV: tivi không cho trình duyệt mở micro.
  Xem `games/chon-tu/` làm mẫu.

## 3. Sửa `game.js`

Đổi `id` cho khớp manifest, viết vòng chơi. Bề mặt tiếp xúc với lõi:

| Gọi | Làm gì |
|---|---|
| `ctx.kid` | hồ sơ bé (chỉ đọc): `name`, `avatar`, `age`, `asr`, `tts_rate` |
| `ctx.settings` | `ctx.kid.games[<id game>]` — độ khó riêng của bé |
| `ctx.root` | phần tử DOM để vẽ, đã dọn sẵn |
| `ctx.assetUrl('data/x.txt')` | đường dẫn file trong thư mục game |
| `await ctx.listen({...})` | nghe một lượt → `{ ok, best, bestProb, margin, ranking, advance, source }` |
| `await ctx.speak(text, {rate})` | đọc tiếng Việt |
| `ctx.speech.supported()` / `.vietnamese()` | máy có TTS / có giọng **Việt** không |
| `ctx.dpad({...})` | con trỏ mũi tên + OK cho điều khiển tivi |
| `ctx.correct(el)` / `ctx.wrong(el)` | hiệu ứng + tiếng |
| `await ctx.star()` | cộng 1 sao; đủ sao thì lõi tự chiếu video thưởng, resolve khi bé bấm "Chơi tiếp" |
| `ctx.status(text)` | dòng chữ dưới nút mic |
| `ctx.log(type, payload)` | ghi sự kiện vào DB |
| `ctx.onExit(fn)` | dọn dẹp khi bé rời game |
| `ctx.maxWrongBeforeHint` | sai mấy lần thì đọc mẫu |
| `await ctx.sleep(ms)` | chờ |

### `ctx.listen` — tham số

```js
await ctx.listen({
  candidates: ['mèo', 'chó', 'gà'],   // BẮT BUỘC: tập ứng viên đóng
  expected: 'mèo',                    // BẮT BUỘC: từ đang mong đợi
  aliases: { 'mười lăm': ['15'] },    // cách đọc khác chấp nhận từ trình duyệt
  sequence: ['con', 'mèo', 'ngủ'],    // cho phép ăn nhiều chữ một lượt
  timeoutMs: 5000,
});
```

Thêm ứng viên gần như miễn phí: chi phí nằm ở forward pass, không ở chấm điểm.
Cứ đưa cả dải số 1..20 vào, đừng đưa mỗi 3 số.

### `ctx.dpad` — chơi bằng điều khiển tivi

```js
const nav = ctx.dpad({
  axis: 'x',                       // 'x' | 'y' | 'both'
  enabled: () => !dangKhen,        // lúc đang khen thì khoá phím lại
  onKey: (k) => {                  // chặn trước; trả true = đã xử lý xong
    if (k === 'up') { docLaiDe(); return true; }
    return false;
  },
});
nav.setItems(cacNut);              // gọi lại sau MỖI lần vẽ lại
nav.select(2);                     // dời con trỏ bằng tay
```

Mũi tên để đi, OK để bấm (mặc định gọi `el.click()`), nút `disabled` tự bị bỏ
qua. Lõi tự tắt con trỏ khi đang chiếu video thưởng và tự gỡ khi bé thoát.
Phím `Back` luôn thuộc về vỏ ứng dụng, game đừng giành.

Ô đang trỏ tới được gắn class `.sel` — **tô viền bằng class đó**, đừng chỉ dựa
vào `:focus-visible`, trình duyệt trên tivi đời cũ không có.

**Đừng bao giờ** tự gọi `getUserMedia`, `SpeechRecognition` hay `fetch`
trong game. Cần gì mà lõi chưa có thì thêm vào `core/`, đừng lách.

## 4. Đăng ký

Thêm id vào `frontend/games/index.json`:

```json
["dem-so", "doc-cau", "chon-tu", "ten-tro-choi"]
```

Tải lại trang là thấy. Muốn bật/tắt cho từng bé thì vào trang quản trị,
hoặc sửa `kids/<id>/profile.json`:

```json
"games": { "ten-tro-choi": { "enabled": true, "do_kho": 2 } }
```

Muốn có `style.css` riêng thì tạo file rồi khai báo `"style": true` trong
manifest — lõi chỉ nạp khi được bảo, không tự dò (dò mò sẽ để lại 404 đỏ
trong console). Chỉ dùng biến màu có sẵn trong `core/style.css`, đừng chế
màu mới.
