// Đọc câu ngắn 4-6 chữ, đọc đúng chữ nào thì chữ đó sáng lên.
// Bản port từ prototype doc-cau.html — giữ đường nhựa + máy xúc chạy theo
// tiến độ, thay lõi nghe bằng ctx.listen().

const FALLBACK = [
  'Con mèo đang ngủ|🐱', 'Bố lái xe đi làm|🚗', 'Mẹ nấu cơm rất ngon|🍚',
  'Bé ăn quả chuối vàng|🍌', 'Con chó chạy ra sân|🐶', 'Máy xúc xúc cát|🚜',
  'Trời mưa to quá|🌧️', 'Bé thích uống sữa|🥛', 'Mặt trời mọc rồi|🌞',
  'Con voi có vòi dài|🐘',
];

function parseList(txt) {
  const out = [];
  txt.split(/\r?\n/).forEach((line) => {
    line = line.trim();
    if (!line || line.startsWith('#')) return;
    const p = line.split('|');
    const s = (p[0] || '').trim();
    const e = (p[1] || '📗').trim();
    if (s) out.push({ s, e });
  });
  return out;
}

export default {
  id: 'doc-cau',

  async setup(ctx) {
    const minW = ctx.settings.min_words || 3;
    const maxW = ctx.settings.max_words || 6;
    let alive = true;
    let pool = [];
    let cur = null;
    let words = [];
    let idx = 0;
    let wrong = 0;
    let listening = false;

    ctx.onExit(() => { alive = false; });

    // --- danh sách câu ---
    let list = [];
    try {
      const r = await fetch(ctx.assetUrl('data/cau.txt'), { cache: 'no-store' });
      if (!r.ok) throw new Error(r.status);
      list = parseList(await r.text());
    } catch (e) {
      list = parseList(FALLBACK.join('\n'));
    }
    list = list.filter((c) => {
      const n = c.s.split(/\s+/).length;
      return n >= minW && n <= maxW;
    });
    if (!list.length) list = parseList(FALLBACK.join('\n'));

    // --- dựng DOM ---
    const stage = document.createElement('div');
    stage.className = 'stage';
    stage.innerHTML = '<div class="pic"></div><div class="words"></div>'
      + '<div class="road"><div class="paved"></div><div class="dig">🚜</div></div>';
    ctx.root.appendChild(stage);
    const picEl = stage.querySelector('.pic');
    const wordsEl = stage.querySelector('.words');
    const pavedEl = stage.querySelector('.paved');
    const digEl = stage.querySelector('.dig');

    const bar = document.createElement('div');
    bar.className = 'btns';
    bar.style.justifyContent = 'center';
    const btn = (label, fn) => {
      const b = document.createElement('button');
      b.className = 'ghost';
      b.textContent = label;
      b.onclick = fn;
      bar.appendChild(b);
    };
    btn('🔊 Nghe mẫu', () => hint(true));
    btn('👉 Mở giúp', () => { if (alive && idx < words.length) advanceTo(idx + 1); });
    ctx.root.appendChild(bar);

    function paint() {
      for (let i = 0; i < wordsEl.children.length; i++) {
        wordsEl.children[i].className = 'w' + (i < idx ? ' done' : '') + (i === idx ? ' now' : '');
      }
      const pct = words.length ? (idx / words.length) * 100 : 0;
      pavedEl.style.width = `${pct}%`;
      digEl.style.left = `${Math.min(96, Math.max(4, pct + (idx < words.length ? 100 / words.length / 2 : 0)))}%`;
    }

    async function nextSentence() {
      if (!alive) return;
      if (!pool.length) {
        pool = list.slice();
        for (let i = pool.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [pool[i], pool[j]] = [pool[j], pool[i]];
        }
      }
      cur = pool.pop();
      words = cur.s.split(/\s+/);
      idx = 0;
      wrong = 0;
      picEl.textContent = cur.e;
      picEl.classList.remove('reveal');
      wordsEl.innerHTML = '';
      words.forEach((w, i) => {
        const d = document.createElement('div');
        d.className = 'w';
        d.textContent = w;
        // Chạm vào chữ để nghe máy đọc mẫu chữ đó.
        d.onclick = async () => { await ctx.speak(w, { rate: 0.7 }); if (i === idx) loop(); };
        wordsEl.appendChild(d);
      });
      paint();
      ctx.log('sentence_start', { text: cur.s, words: words.length });
      ctx.status('Đọc từng chữ nhé');
      await ctx.sleep(500);
      loop();
    }

    async function advanceTo(n) {
      if (n <= idx) return;
      for (let k = idx; k < n && k < wordsEl.children.length; k++) {
        ctx.correct(wordsEl.children[k]);
        await ctx.sleep(140);
      }
      idx = Math.min(n, words.length);
      wrong = 0;
      paint();
      if (idx >= words.length) { finishSentence(); return; }
      ctx.status('Giỏi lắm! Chữ tiếp theo nào');
      await ctx.sleep(350);
      loop();
    }

    async function finishSentence() {
      picEl.classList.add('reveal');
      ctx.status('Đọc xong cả câu rồi!');
      await ctx.speak(cur.s, { rate: 0.75 });
      const done = await ctx.star();
      if (!alive) return;
      if (done) ctx.status('');
      nextSentence();
    }

    async function hint(manual) {
      const w = words[idx] || '';
      await ctx.speak(manual ? w : `Chữ này là ${w}`, { rate: 0.65 });
      if (!manual) ctx.status('Nghe rồi đọc theo nhé');
      await ctx.sleep(250);
      loop();
    }

    async function loop() {
      if (!alive || listening || idx >= words.length) return;
      listening = true;
      const want = words[idx];
      // Ứng viên: các chữ CÒN LẠI của câu. `sequence` cho phép bé đọc liền
      // nhiều chữ thì mở luôn nhiều chữ (ăn dần từ trái sang như prototype).
      const remaining = words.slice(idx);
      const candidates = Array.from(new Set(remaining));
      const r = await ctx.listen({ candidates, expected: want, sequence: remaining });
      listening = false;
      if (!alive) return;

      if (r.ok) { advanceTo(idx + Math.max(1, r.advance)); return; }

      wrong++;
      ctx.wrong(wordsEl.children[idx]);
      ctx.log('miss', { expected: want, heard: r.best || r.heard, prob: r.bestProb });

      if (r.silent) {
        ctx.status('Chưa nghe rõ. Đọc to lên nào!');
        await ctx.sleep(450);
        loop();
        return;
      }
      if (wrong >= ctx.maxWrongBeforeHint) {
        wrong = 0;
        hint(false);
        return;
      }
      const heard = r.best && r.best !== want ? ` (nghe thành “${r.best}”)` : '';
      ctx.status(`Chưa đúng${heard}. Đọc chữ “${want}” nào!`);
      await ctx.sleep(500);
      loop();
    }

    nextSentence();
  },
};
