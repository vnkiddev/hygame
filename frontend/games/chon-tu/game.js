// Chọn từ — máy hiện 2-3 từ ngắn, đọc "Bé hãy chọn đâu là <từ>", bé chọn.
//
// Trò DUY NHẤT không cần mic: chơi được bằng chuột, bằng chạm, và bằng
// điều khiển tivi (◀ ▶ để đi, OK để chọn, ▲▼ để nghe lại). Sinh ra vì
// Android TV (Coocaa) không cho dùng micro của trình duyệt — mấy trò kia
// đứng hình ở đó, trò này thì chạy.

const REPEAT_MS = 5000;        // im lặng 5 giây thì đọc lại đề

const FALLBACK = [
  'mèo|🐱', 'chó|🐶', 'gà|🐓', 'cá|🐟', 'voi|🐘', 'thỏ|🐰',
  'táo|🍎', 'chuối|🍌', 'sữa|🥛', 'bánh|🍰',
  'xe|🚗', 'tàu|🚂', 'bóng|⚽', 'mũ|🧢',
  'mưa|🌧️', 'nắng|🌞', 'sao|⭐', 'hoa|🌸', 'cây|🌳', 'tay|✋',
];

function parseList(txt) {
  const out = [];
  txt.split(/\r?\n/).forEach((line) => {
    line = line.trim();
    if (!line || line.startsWith('#')) return;
    const p = line.split('|');
    const word = (p[0] || '').trim();
    const emoji = (p[1] || '🎈').trim();
    if (word) out.push({ word, emoji });
  });
  return out;
}

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const initial = (w) => w.trim().charAt(0).toLowerCase();

export default {
  id: 'chon-tu',

  async setup(ctx) {
    let alive = true;
    let locked = false;      // đang khen / đang chuyển vòng: khoá phím lại
    let token = 0;           // hủy vòng đọc-lặp cũ
    let cur = null;
    let cards = [];
    let pool = [];
    let wrong = 0;
    let revealed = false;
    let lastWord = null;

    ctx.onExit(() => { alive = false; token++; });

    // --- danh sách từ ---
    let list = [];
    try {
      const r = await fetch(ctx.assetUrl('data/tu.txt'), { cache: 'no-store' });
      if (!r.ok) throw new Error(r.status);
      list = parseList(await r.text());
    } catch (e) {
      list = parseList(FALLBACK.join('\n'));
    }
    if (list.length < 2) list = parseList(FALLBACK.join('\n'));

    // Số ô mỗi lượt: bé 3 tuổi trở xuống thì 2 ô cho dễ, lớn hơn thì 3.
    const want = ctx.settings.so_lua_chon || ((ctx.kid.age || 4) <= 3 ? 2 : 3);
    const nOpt = Math.max(2, Math.min(3, Math.min(want, list.length)));

    // --- dựng DOM ---
    const stage = document.createElement('div');
    stage.className = 'chontu';
    stage.innerHTML = `
      <button type="button" class="ask"><span class="face">🔊</span><span class="lbl">Nghe lại</span></button>
      <div class="row"></div>
      <p class="cach">Chạm vào từ — hoặc bấm <b>◀ ▶</b> rồi <b>OK</b> trên điều khiển</p>`;
    ctx.root.appendChild(stage);
    const askEl = stage.querySelector('.ask');
    const faceEl = stage.querySelector('.face');
    const rowEl = stage.querySelector('.row');

    askEl.onclick = () => { if (!locked) sayPrompt(); };

    // Con trỏ điều khiển tivi. Chỉ chạy trên hàng từ; ▲▼ để nghe lại đề.
    const nav = ctx.dpad({
      axis: 'x',
      enabled: () => alive && !locked,
      onKey: (k) => {
        if (k !== 'up' && k !== 'down') return false;
        sayPrompt();
        return true;
      },
    });

    // --- một lượt chơi ---
    function pickRound() {
      if (!pool.length) pool = shuffle(list.slice());
      let target = pool.pop();
      // Đừng ra lại đúng từ vừa chơi (hay xảy ra ở chỗ nối hai lượt xáo bài).
      if (target.word === lastWord && pool.length) {
        const swap = pool.pop();
        pool.unshift(target);
        target = swap;
      }
      lastWord = target.word;

      const rest = shuffle(list.filter((w) => w.word !== target.word));
      const others = [];
      // Ưu tiên từ khác chữ cái đầu: bé mới tập nhìn mặt chữ, đặt "cá" cạnh
      // "cam" là đánh đố chứ không phải dạy.
      const used = new Set([initial(target.word)]);
      for (const w of rest) {
        if (others.length >= nOpt - 1) break;
        if (used.has(initial(w.word))) continue;
        used.add(initial(w.word));
        others.push(w);
      }
      for (const w of rest) {
        if (others.length >= nOpt - 1) break;
        if (!others.includes(w)) others.push(w);
      }
      return { word: target.word, emoji: target.emoji, choices: shuffle([target, ...others]) };
    }

    function paintAsk() {
      // Máy không đọc được tiếng Việt (Android TV rất hay thiếu giọng Việt)
      // thì nghe cũng bằng thừa — hiện hình gợi ý để bé vẫn chơi được.
      const mute = !ctx.speech.supported() || !ctx.speech.hasVoice();
      faceEl.textContent = mute ? cur.emoji : '🔊';
      askEl.classList.toggle('mute', mute);
    }

    function render() {
      rowEl.innerHTML = '';
      cards = cur.choices.map((c, i) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'tu';
        b.textContent = c.word;
        b.onclick = () => choose(i);
        rowEl.appendChild(b);
        return b;
      });
      nav.setItems(cards);
    }

    function nextRound() {
      if (!alive) return;
      cur = pickRound();
      wrong = 0;
      revealed = false;
      render();
      paintAsk();
      ctx.log('round_start', { word: cur.word, choices: cur.choices.map((c) => c.word) });
      ctx.status('Đâu là từ đúng nào?');
      sayPrompt();
    }

    function stopPrompt() { token++; }

    /** Đọc đề, rồi cứ 5 giây im lặng lại đọc một lần cho tới khi bé chọn. */
    async function sayPrompt() {
      const my = ++token;
      const word = cur.word;
      while (alive && my === token) {
        askEl.classList.add('on');
        paintAsk();
        await ctx.speak(`Bé hãy chọn đâu là ${word}`, { rate: 0.7 });
        askEl.classList.remove('on');
        if (!alive || my !== token) return;
        await ctx.sleep(REPEAT_MS);
      }
    }

    function leftCount() { return cards.filter((c) => !c.disabled).length; }

    function dimOthers(keep) {
      cards.forEach((c, i) => {
        if (i === keep) return;
        c.disabled = true;
        c.classList.add('off');
      });
    }

    async function choose(i) {
      if (!alive || locked) return;
      const card = cards[i];
      if (!card || card.disabled) return;
      const picked = cur.choices[i].word;
      stopPrompt();

      // --- chọn sai ---
      if (picked !== cur.word) {
        wrong++;
        ctx.wrong(card);
        card.disabled = true;
        card.classList.add('off');
        ctx.log('miss', { expected: cur.word, chose: picked });
        if (wrong >= ctx.maxWrongBeforeHint || leftCount() <= 1) { reveal(); return; }
        ctx.status(`Chưa đúng, đây là “${picked}”. Nghe lại nhé!`);
        nav.select(i);          // trượt con trỏ sang ô còn chọn được
        sayPrompt();
        return;
      }

      // --- chọn đúng ---
      locked = true;
      dimOthers(i);
      card.classList.add('right');
      card.textContent = `${cur.emoji} ${cur.word}`;
      ctx.correct(card);
      ctx.status('Giỏi quá!');
      ctx.log('hit', { word: cur.word, wrong, revealed });
      await ctx.speak(`Đúng rồi! ${cur.word}`, { rate: 0.7 });
      if (!alive) return;
      const done = await ctx.star();
      if (!alive) return;
      if (done) ctx.status('');
      locked = false;
      await ctx.sleep(400);
      nextRound();
    }

    /** Hết lượt đoán: chỉ chừa lại ô đúng, chỉ cho bé, để bé tự bấm. */
    async function reveal() {
      locked = true;
      const k = cur.choices.findIndex((c) => c.word === cur.word);
      dimOthers(k);
      cards[k].classList.add('show');
      revealed = true;
      wrong = 0;
      ctx.status('Từ này đây, bé bấm vào nhé');
      await ctx.speak(`Từ ${cur.word} đây này`, { rate: 0.65 });
      if (!alive) return;
      locked = false;
      nav.select(k);
      sayPrompt();
    }

    nextRound();
  },
};
