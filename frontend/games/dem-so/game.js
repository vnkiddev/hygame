// Đếm số 1..20, mở lần lượt các ô.
// Bản port từ prototype dem-so.html — giữ nguyên hình ảnh khối bê tông
// sọc cảnh báo lật ra số, thay lõi nghe bằng ctx.listen().

const WORD = ['', 'một', 'hai', 'ba', 'bốn', 'năm', 'sáu', 'bảy', 'tám', 'chín', 'mười'];

/** Số -> chữ tiếng Việt. */
export function say(n) {
  if (n <= 10) return WORD[n];
  if (n === 20) return 'hai mươi';
  const u = n - 10;
  if (u === 1) return 'mười một';
  if (u === 5) return 'mười lăm';
  return `mười ${WORD[u]}`;
}

/** Cách đọc khác mà trình duyệt hay trả về — dùng để so khớp nhanh ở client. */
function aliasesFor(n) {
  const a = [String(n)];
  if (n === 4) a.push('tư');
  if (n === 5) a.push('lăm');
  if (n > 10 && n < 20) {
    a.push(String(n), WORD[n - 10]);          // bé đọc tắt "ba" thay "mười ba"
    if (n === 14) a.push('mười tư');
    if (n === 15) a.push('mười năm');
    if (n === 11) a.push('mười mốt');
  }
  if (n === 20) a.push('hai chục');
  return a;
}

export default {
  id: 'dem-so',

  async setup(ctx) {
    const max = ctx.settings.max_number || 20;
    const cells = Math.min(ctx.settings.cells || 5, max);
    const name = ctx.kid.name;
    let start = 1;
    let idx = 1;
    let wrong = 0;
    let alive = true;

    ctx.onExit(() => { alive = false; });

    // --- dựng DOM ---
    const row = document.createElement('div');
    row.className = 'row';
    ctx.root.appendChild(row);

    const bar = document.createElement('div');
    bar.className = 'btns';
    bar.style.justifyContent = 'center';
    const btn = (label, fn) => {
      const b = document.createElement('button');
      b.className = 'ghost';
      b.textContent = label;
      b.onclick = fn;
      bar.appendChild(b);
      return b;
    };
    btn('🔊 Nghe mẫu', () => hint(true));
    // Bấm nhanh nhiều lần lúc vừa mở hết ô thì idx đã chạm mép — phải chặn,
    // nếu không cellAt(idx) là undefined.
    btn('👉 Mở giúp', () => { if (alive && idx < cells) reveal(); });
    ctx.root.appendChild(bar);

    function draw() {
      row.innerHTML = '';
      for (let i = 0; i < cells; i++) {
        const c = document.createElement('div');
        c.className = 'cell' + (i === 0 ? ' open first' : '');
        c.innerHTML = `<div class="face back"></div><div class="face front">${start + i}</div>`;
        row.appendChild(c);
      }
      markTarget();
    }
    const cellAt = (i) => row.children[i];
    function markTarget() {
      for (let i = 0; i < row.children.length; i++) row.children[i].classList.remove('target');
      if (idx < cells) cellAt(idx).classList.add('target');
    }
    const target = () => start + idx;

    // --- vòng chơi ---
    async function newRound() {
      if (!alive) return;
      start = 1 + Math.floor(Math.random() * Math.max(1, max - cells + 1));
      idx = 1;
      wrong = 0;
      draw();
      ctx.log('round_start', { start, cells });
      await ctx.speak(`Số đầu tiên là ${say(start)}. ${name} đếm tiếp nhé!`);
      loop();
    }

    async function reveal() {
      if (idx >= cells) return;
      const c = cellAt(idx);
      c.classList.remove('target');
      c.classList.add('open');
      ctx.correct(c);
      idx++;
      wrong = 0;
      markTarget();
      if (idx >= cells) {
        await ctx.sleep(700);
        ctx.status('Giỏi quá!');
        const done = await ctx.star();
        if (!alive) return;
        if (done) ctx.status('');
        newRound();
        return;
      }
      ctx.status('Giỏi lắm! Số tiếp theo nào?');
      await ctx.sleep(600);
      loop();
    }

    async function hint(manual) {
      const n = target();
      await ctx.speak(`Số này là ${say(n)}.${manual ? '' : ` ${name} đọc theo nhé.`}`);
      if (!manual) ctx.status('Nghe rồi đọc theo nhé');
      await ctx.sleep(300);
      loop();
    }

    // Tập ứng viên đóng: toàn bộ dải số của bé. Thêm ứng viên gần như miễn phí
    // vì chi phí nằm ở forward pass, không ở chấm điểm.
    const candidates = [];
    const aliases = {};
    for (let n = 1; n <= max; n++) {
      candidates.push(say(n));
      aliases[say(n)] = aliasesFor(n);
    }

    let listening = false;
    async function loop() {
      if (!alive || listening || idx >= cells) return;
      listening = true;
      const want = say(target());
      ctx.status('Đọc to số tiếp theo nhé');
      const r = await ctx.listen({ candidates, expected: want, aliases });
      listening = false;
      if (!alive) return;

      if (r.ok) { reveal(); return; }

      wrong++;
      ctx.wrong(cellAt(idx));
      ctx.log('miss', { expected: want, heard: r.best || r.heard, prob: r.bestProb });

      if (r.silent) {
        ctx.status('Chưa nghe rõ. Đọc to lên nào!');
        await ctx.sleep(500);
        loop();
        return;
      }
      if (wrong >= ctx.maxWrongBeforeHint) {
        wrong = 0;
        hint(false);
        return;
      }
      // Không nuốt lỗi: nghe thành số khác thì nói luôn cho bé biết.
      const heard = r.best && r.best !== want ? ` (nghe thành “${r.best}”)` : '';
      ctx.status(`Chưa đúng rồi${heard}. Thử lại nào!`);
      await ctx.sleep(500);
      loop();
    }

    newRound();
  },
};
