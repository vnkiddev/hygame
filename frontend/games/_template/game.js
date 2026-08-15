// Bộ khung game tối giản NHƯNG CHẠY ĐƯỢC — copy thư mục này để làm game mới.
// Trò chơi: máy hiện một con vật, bé đọc tên con vật đó.
//
// Nguyên tắc bất di bất dịch: game chỉ mô tả ĐANG CHỜ GÌ.
// Không đụng vào mic, fetch, video thưởng hay DB. Muốn đổi engine ASR thì
// sửa core/asr.js, không game nào phải thay đổi.

const ITEMS = [
  { word: 'mèo', emoji: '🐱' },
  { word: 'chó', emoji: '🐶' },
  { word: 'gà', emoji: '🐓' },
  { word: 'cá', emoji: '🐟' },
  { word: 'voi', emoji: '🐘' },
  { word: 'thỏ', emoji: '🐰' },
];

export default {
  id: '_template',

  async setup(ctx) {
    let alive = true;
    let cur = null;
    let wrong = 0;
    let listening = false;

    // ctx.onExit — dọn dẹp khi bé thoát. LUÔN đăng ký cờ alive như thế này,
    // nếu không vòng lặp nghe sẽ chạy tiếp sau khi đã rời màn hình.
    ctx.onExit(() => { alive = false; });

    // ctx.root là DOM đã dọn sẵn, game muốn vẽ gì thì vẽ.
    const card = document.createElement('div');
    card.style.cssText = 'font-size:clamp(80px,26vw,240px);line-height:1;cursor:pointer';
    ctx.root.appendChild(card);

    const label = document.createElement('div');
    label.style.cssText = 'font-size:clamp(20px,4vw,34px);font-weight:600;opacity:.5';
    label.textContent = 'Đây là con gì?';
    ctx.root.appendChild(label);

    card.onclick = () => ctx.speak(cur.word);   // chạm để nghe mẫu

    async function next() {
      if (!alive) return;
      cur = ITEMS[Math.floor(Math.random() * ITEMS.length)];
      wrong = 0;
      card.textContent = cur.emoji;
      ctx.log('round_start', { word: cur.word });
      await ctx.speak('Đây là con gì?');
      loop();
    }

    async function loop() {
      if (!alive || listening) return;
      listening = true;
      ctx.status('Con đọc tên con vật nhé');

      // ctx.listen lo trọn gói: mic, VAD, chạy đua trình duyệt + máy chủ,
      // áp ngưỡng theo hồ sơ bé, ghi log, lưu clip.
      const r = await ctx.listen({
        candidates: ITEMS.map((i) => i.word),   // tập ứng viên ĐÓNG
        expected: cur.word,                     // từ đang mong đợi
      });
      listening = false;
      if (!alive) return;

      if (r.ok) {
        ctx.correct(card);
        ctx.status('Giỏi quá!');
        await ctx.star();          // đủ sao thì lõi tự chiếu video thưởng
        if (alive) next();
        return;
      }

      wrong++;
      ctx.wrong(card);
      if (wrong >= ctx.maxWrongBeforeHint) {
        wrong = 0;
        ctx.status('Nghe rồi đọc theo nhé');
        await ctx.speak(`Đây là con ${cur.word}`);
      } else {
        // Không nuốt lỗi: nghe thành từ khác thì hiện ra cho bố mẹ thấy.
        const heard = r.best && r.best !== cur.word ? ` (nghe thành “${r.best}”)` : '';
        ctx.status(`Chưa đúng${heard}. Thử lại nào!`);
      }
      await ctx.sleep(500);
      loop();
    }

    next();
  },
};
