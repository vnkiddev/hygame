// Đọc câu ngắn 4-6 chữ, đọc đúng chữ nào thì chữ đó sáng lên.
// Bản port từ prototype doc-cau.html — giữ đường nhựa + máy xúc chạy theo
// tiến độ, thay lõi nghe bằng ctx.listen().

const FALLBACK = {
  vi: [
    'Con mèo đang ngủ|🐱', 'Bố lái xe đi làm|🚗', 'Mẹ nấu cơm rất ngon|🍚',
    'Bé ăn quả chuối vàng|🍌', 'Con chó chạy ra sân|🐶', 'Máy xúc xúc cát|🚜',
    'Trời mưa to quá|🌧️', 'Bé thích uống sữa|🥛', 'Mặt trời mọc rồi|🌞',
    'Con voi có vòi dài|🐘',
  ],
  en: [
    'The cat is sleeping|🐱', 'I like red apples|🍎', 'The dog runs fast|🐶',
    'The sun is hot|🌞', 'Fish swim in water|🐟', 'The car is blue|🚗',
    'The moon is bright|🌙', 'I drink cold milk|🥛', 'A frog can jump|🐸',
    'The digger moves sand|🚜',
  ],
};

// Chữ hiện trên màn hình, theo ngôn ngữ bé đang học.
const TEXT = {
  vi: {
    file: 'data/cau.txt',
    readEach: 'Đọc từng chữ nhé',
    good: 'Giỏi lắm! Chữ tiếp theo nào',
    done: 'Đọc xong cả câu rồi!',
    listenThen: 'Nghe rồi đọc theo nhé',
    thisWordIs: (w) => `Chữ này là ${w}`,
    notClear: 'Chưa nghe rõ. Đọc to lên nào!',
    wrong: (w, heard) => `Chưa đúng${heard}. Đọc chữ “${w}” nào!`,
    heardAs: (b) => ` (nghe thành “${b}”)`,
    sample: '🔊 Nghe mẫu',
    help: '👉 Mở giúp',
    switchTo: '🇬🇧 English',
    switched: 'Chuyển sang tiếng Anh',
  },
  en: {
    file: 'data/cau-en.txt',
    readEach: 'Read each word',
    good: 'Great! Next word',
    done: 'You read the whole sentence!',
    listenThen: 'Listen, then say it',
    thisWordIs: (w) => `This word is ${w}`,
    notClear: 'I did not hear you. Say it louder!',
    wrong: (w, heard) => `Not yet${heard}. Say “${w}”!`,
    heardAs: (b) => ` (I heard “${b}”)`,
    sample: '🔊 Listen',
    help: '👉 Open it',
    switchTo: '🇻🇳 Tiếng Việt',
    switched: 'Switched to Vietnamese',
  },
};

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
    // Ngôn ngữ KHÔNG khoá cứng theo bé: hồ sơ chỉ quyết định mở màn bằng
    // tiếng nào, còn bé nào cũng đổi qua lại được ngay trong lúc chơi.
    let lang = ctx.settings.lang === 'en' ? 'en' : 'vi';
    let T = TEXT[lang];
    const minW = ctx.settings.min_words || 3;
    const maxW = ctx.settings.max_words || 6;
    let alive = true;
    let pool = [];
    let cur = null;
    let words = [];
    let idx = 0;
    let wrong = 0;
    let listening = false;
    let switching = false;

    ctx.onExit(() => { alive = false; });

    // --- danh sách câu, nạp theo ngôn ngữ và nhớ lại để đổi qua lại cho nhanh ---
    const cache = {};
    let list = [];

    async function loadList(which) {
      if (cache[which]) return cache[which];
      let raw = [];
      try {
        const r = await fetch(ctx.assetUrl(TEXT[which].file), { cache: 'no-store' });
        if (!r.ok) throw new Error(r.status);
        raw = parseList(await r.text());
      } catch (e) {
        raw = parseList(FALLBACK[which].join('\n'));
      }
      const fits = (c) => {
        const n = c.s.split(/\s+/).length;
        return n >= minW && n <= maxW;
      };
      const filtered = raw.filter(fits);
      // Bố mẹ đặt khoảng độ dài quá hẹp thì đừng bỏ trắng trò chơi — dùng cả
      // danh sách còn hơn là không có câu nào.
      let out = filtered.length ? filtered : raw;
      if (!out.length) out = parseList(FALLBACK[which].join('\n'));
      cache[which] = out;
      ctx.log('sentence_pool', {
        lang: which, total: out.length, min_words: minW, max_words: maxW,
      });
      return out;
    }

    list = await loadList(lang);

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
      return b;
    };
    const sampleBtn = btn(T.sample, () => hint(true));
    const helpBtn = btn(T.help, () => { if (alive && idx < words.length) advanceTo(idx + 1); });
    const langBtn = btn(T.switchTo, () => switchLang());
    ctx.root.appendChild(bar);

    async function switchLang() {
      if (!alive || switching) return;
      switching = true;
      lang = lang === 'vi' ? 'en' : 'vi';
      T = TEXT[lang];
      sampleBtn.textContent = T.sample;
      helpBtn.textContent = T.help;
      langBtn.textContent = T.switchTo;
      ctx.status(T.switched);
      ctx.log('lang_switch', { to: lang });
      list = await loadList(lang);
      pool = [];
      switching = false;
      nextSentence();
    }

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
        d.onclick = async () => { await ctx.speak(w, { rate: 0.7, lang }); if (i === idx) loop(); };
        wordsEl.appendChild(d);
      });
      paint();
      ctx.log('sentence_start', { text: cur.s, words: words.length, lang });
      ctx.status(T.readEach);
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
      ctx.status(T.good);
      await ctx.sleep(350);
      loop();
    }

    async function finishSentence() {
      picEl.classList.add('reveal');
      ctx.status(T.done);
      await ctx.speak(cur.s, { rate: 0.75, lang });
      const done = await ctx.star();
      if (!alive) return;
      if (done) ctx.status('');
      nextSentence();
    }

    async function hint(manual) {
      const w = words[idx] || '';
      await ctx.speak(manual ? w : T.thisWordIs(w), { rate: 0.65, lang });
      if (!manual) ctx.status(T.listenThen);
      await ctx.sleep(250);
      loop();
    }

    async function loop() {
      if (!alive || listening || switching || idx >= words.length) return;
      listening = true;
      const want = words[idx];
      // Ứng viên: các chữ CÒN LẠI của câu. `sequence` cho phép bé đọc liền
      // nhiều chữ thì mở luôn nhiều chữ (ăn dần từ trái sang như prototype).
      const remaining = words.slice(idx);
      const candidates = Array.from(new Set(remaining));
      const langAtStart = lang;
      const r = await ctx.listen({ candidates, expected: want, sequence: remaining, lang });
      listening = false;
      // Bé bấm đổi ngôn ngữ trong lúc đang nghe -> kết quả này đã lạc hậu
      if (!alive || lang !== langAtStart) return;

      if (r.ok) { advanceTo(idx + Math.max(1, r.advance)); return; }

      wrong++;
      ctx.wrong(wordsEl.children[idx]);
      ctx.log('miss', { expected: want, heard: r.best || r.heard, prob: r.bestProb });

      if (r.silent) {
        ctx.status(T.notClear);
        await ctx.sleep(450);
        loop();
        return;
      }
      if (wrong >= ctx.maxWrongBeforeHint) {
        wrong = 0;
        hint(false);
        return;
      }
      const heard = r.best && r.best !== want ? T.heardAs(r.best) : '';
      ctx.status(T.wrong(want, heard));
      await ctx.sleep(500);
      loop();
    }

    nextSentence();
  },
};
