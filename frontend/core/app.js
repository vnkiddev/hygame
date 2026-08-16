// Vỏ ứng dụng: chọn bé -> chọn trò chơi -> chạy game.
// Đây là nơi duy nhất dựng `ctx` — toàn bộ bề mặt tiếp xúc của game với lõi.

import { $, el, show, sfx, pop, shake, unlockMedia, sleep } from './ui.js';
import { speak, cancelSpeech, hasVoice } from './speak.js';
import { roving, onKey } from './keys.js';
import * as asr from './asr.js';
import * as reward from './reward.js';
import * as session from './session.js';
import { listGames, loadGame, enabledFor } from './registry.js';

let kids = [];
let games = [];
let kid = null;
let current = null;      // { game, cleanup[] }

// Con trỏ D-pad cho hai màn chọn. Màn chơi KHÔNG có con trỏ dùng chung —
// mỗi game tự lo phím của mình (xem core/keys.js).
const onScreen = (id) => () => $(id).classList.contains('on');
const navKids = roving({ enabled: onScreen('pick') });
const navGames = roving({ enabled: onScreen('games') });

// --- khởi động --------------------------------------------------------------
async function boot() {
  asr.onOfflineChange((off) => $('offline').classList.toggle('on', off));
  asr.pingServer();

  const [k, g] = await Promise.all([fetchKids(), listGames()]);
  kids = k;
  games = g;
  drawKids();
  show('pick');

  $('backToKids').onclick = () => exitGame(true);
  $('backToKidsPlay').onclick = () => exitGame(true);
  $('backToGames').onclick = () => { exitGame(false); drawGames(); show('games'); };

  // Nút Back của điều khiển tivi: lùi một bậc, đừng để nó thoát cả trang.
  onKey((k) => {
    if (k !== 'back' || $('win').classList.contains('on')) return false;
    if ($('play').classList.contains('on')) { $('backToGames').click(); return true; }
    if ($('games').classList.contains('on')) { $('backToKids').click(); return true; }
    return false;
  });
}

// Máy chủ là nguồn sự thật, nhưng phải giữ một bản sao để §12.6 chạy được:
// backend chết thì bé vẫn chọn được tên và chơi tiếp bằng Web Speech API.
const KIDS_CACHE = 'kidsapp.kids';

async function fetchKids() {
  try {
    const r = await fetch('/api/kids', { cache: 'no-store' });
    const d = await r.json();
    const list = d.kids || [];
    if (list.length) {
      try { localStorage.setItem(KIDS_CACHE, JSON.stringify(list)); } catch (e) { /* chế độ riêng tư */ }
    }
    return list;
  } catch (e) {
    let cached = [];
    try { cached = JSON.parse(localStorage.getItem(KIDS_CACHE) || '[]'); } catch (e2) { /* cache hỏng */ }
    $('pickHint').textContent = cached.length
      ? 'Máy chủ đang tắt — vẫn chơi được, nhưng máy nghe kém hơn và không có video thưởng.'
      : 'Không kết nối được máy chủ, mà máy này cũng chưa từng tải danh sách bé.';
    return cached;
  }
}

// --- màn chọn bé ------------------------------------------------------------
function drawKids() {
  const box = $('kidTiles');
  box.innerHTML = '';
  if (!kids.length) {
    box.appendChild(el('p', 'hint',
      'Chưa có bé nào. Mở <b>trang quản trị</b> để thêm bé và video thưởng.'));
  }
  kids.forEach((k) => {
    const b = el('button', 'tile');
    b.appendChild(el('span', 'emoji', k.avatar || '🚜'));
    b.appendChild(el('span', null, k.name));
    b.onclick = () => chooseKid(k);
    box.appendChild(b);
  });
  navKids.setItems(box.querySelectorAll('button'));
}

function chooseKid(k) {
  // Cú chạm ĐẦU TIÊN — bắt buộc mở khoá audio/video ở đây cho iOS.
  unlockMedia($('vid'));
  kid = k;
  session.rememberKid(k.id);
  sfx.tick();
  drawGames();
  show('games');
}

// --- màn chọn trò chơi ------------------------------------------------------
function drawGames() {
  $('gameWho').textContent = `${kid.avatar || ''} ${kid.name}`;
  const box = $('gameTiles');
  box.innerHTML = '';
  const usable = games.filter((m) => enabledFor(m, kid));
  if (!usable.length) {
    box.appendChild(el('p', 'hint', 'Bé chưa được bật trò chơi nào.'));
  }
  usable.forEach((m) => {
    const b = el('button', 'tile');
    b.appendChild(el('span', 'emoji', m.icon || '🎮'));
    b.appendChild(el('span', null, m.title || m.id));
    if (m.description) b.appendChild(el('span', 'sub', m.description));
    b.onclick = () => startGame(m);
    box.appendChild(b);
  });
  navGames.setItems(box.querySelectorAll('button'));
}

// --- chạy game --------------------------------------------------------------
async function startGame(manifest) {
  sfx.tick();
  let game;
  try {
    game = await loadGame(manifest);
  } catch (e) {
    console.warn('Không nạp được game', manifest.id, e);
    $('gameWho').textContent = 'Trò chơi này đang hỏng 😢';
    return;
  }

  session.start(kid.id, manifest.id);
  reward.mount($('stars'), (kid.rewards || {}).stars_needed || 3);

  const root = $('gameRoot');
  root.innerHTML = '';
  $('playWho').textContent = `${kid.avatar || ''} ${kid.name}`;
  $('status').textContent = '';
  setMic('idle');
  // Game không khai `needs: ["mic"]` thì giấu nút mic đi — chơi bằng chuột
  // hoặc điều khiển tivi, để nút mic ở đó chỉ tổ làm bé bấm nhầm.
  // Vẫn giữ nguyên dòng #status: game nào cũng cần nói chuyện với bé.
  $('mic').classList.toggle('hidden', !(manifest.needs || ['mic']).includes('mic'));
  show('play');

  current = { game, cleanup: [], manifest };
  try {
    await game.setup(makeCtx(manifest, root));
  } catch (e) {
    console.warn('Game lỗi lúc khởi tạo', manifest.id, e);
    $('status').textContent = 'Trò chơi gặp trục trặc. Bấm "Đổi trò" nhé.';
  }
}

function makeCtx(manifest, root) {
  const cfg = (kid.games || {})[manifest.id] || {};
  const rate = kid.tts_rate || 0.8;

  return {
    kid: Object.freeze({ ...kid }),
    settings: cfg,
    root,
    assetUrl: (p) => `${manifest.dir}/${String(p).replace(/^\/+/, '')}`,

    async listen(o = {}) {
      setMic('listening');
      $('mic').disabled = false;
      const res = await asr.listen({
        candidates: o.candidates || [],
        expected: o.expected,
        sequence: o.sequence,
        aliases: o.aliases,
        lang: o.lang || cfg.lang || 'vi',
        stream: o.stream,
        partialMs: o.partialMs,
        timeoutMs: o.timeoutMs || 5000,
        silenceMs: o.silenceMs,
        kid,
        gameId: manifest.id,
        sessionId: session.session.id,
        onState: (s) => setMic(s),
      });
      setMic('idle');
      if (res.degraded) {
        $('status').textContent = 'Máy chủ chưa trả lời — đang chạy chế độ đơn giản.';
      }
      return res;
    },

    speak: (text, opt = {}) => speak(text, {
      rate: opt.rate || rate, lang: opt.lang || cfg.lang || 'vi', ...opt,
    }),
    // Máy này đọc được thứ tiếng của trò chơi không? Game hỏi để còn bày cách
    // khác cho bé (Android TV thường có TTS nhưng KHÔNG có giọng Việt). Phải
    // là hàm: danh sách giọng nạp bất đồng bộ, hỏi lúc khởi động luôn ra rỗng.
    speech: {
      supported: () => !!window.speechSynthesis,
      hasVoice: (lang) => hasVoice(lang || cfg.lang || 'vi'),
    },
    status: (t) => { $('status').textContent = t || ''; },

    correct(node) { pop(node); sfx.ding(); },
    wrong(node) { shake(node); sfx.nope(); },

    async star() {
      const full = reward.addStar();
      if (full) {
        await reward.celebrate(kid, { againLabel: 'Chơi tiếp' });
        return true;
      }
      return false;
    },

    // Con trỏ D-pad cho game chơi bằng điều khiển tivi (mũi tên + OK).
    // Lõi tự tắt khi đang chiếu video thưởng hoặc khi bé đã rời màn chơi,
    // và tự gỡ listener lúc thoát — game không phải nhớ dọn.
    dpad(opt = {}) {
      const nav = roving({
        ...opt,
        enabled: () => $('play').classList.contains('on')
          && !$('win').classList.contains('on')
          && (!opt.enabled || opt.enabled()),
      });
      if (current) current.cleanup.push(() => nav.detach());
      return nav;
    },

    log: (type, payload) => session.log(type, payload, { gameId: manifest.id }),
    onExit: (fn) => current && current.cleanup.push(fn),
    sleep,
    maxWrongBeforeHint: (kid.asr || {}).max_wrong_before_hint || 2,
  };
}

async function exitGame(toKids) {
  if (current) {
    current.cleanup.forEach((fn) => { try { fn(); } catch (e) { /* dọn dẹp lỗi, kệ */ } });
    current = null;
  }
  asr.abort();
  cancelSpeech();
  await session.end();
  $('gameRoot').innerHTML = '';
  $('win').classList.remove('on');
  if (toKids) { kid = null; show('pick'); }
}

// --- nút mic dùng chung -----------------------------------------------------
function setMic(state) {
  const b = $('mic');
  const l = $('micLabel');
  b.classList.toggle('listening', state === 'listening');
  b.classList.toggle('thinking', state === 'thinking');
  if (state === 'listening') l.textContent = 'Đang nghe…';
  else if (state === 'thinking') l.textContent = 'Đang nghĩ…';
  else l.textContent = 'Con đọc đi';
}

$('mic').onclick = () => asr.abort();   // bấm để chốt sớm, không phải để bật

boot();
