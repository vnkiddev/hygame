// Tiện ích DOM + âm thanh hiệu ứng dùng chung cho mọi trò chơi.
// Game không tự tạo <audio>, không tự vẽ sao — gọi qua đây.

export const $ = (id) => document.getElementById(id);

export function el(tag, cls, html) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html != null) n.innerHTML = html;
  return n;
}

export function show(screenId) {
  document.querySelectorAll('.screen').forEach((s) => s.classList.remove('on'));
  const s = $(screenId);
  if (s) s.classList.add('on');
}

// --- âm thanh hiệu ứng (WebAudio, không cần file) ---------------------------
let actx = null;

export function audioCtx() {
  if (!actx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (AC) actx = new AC();
  }
  return actx;
}

function beep(freq, dur, type) {
  const ctx = audioCtx();
  if (!ctx) return;
  try {
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type || 'sine';
    o.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.25, ctx.currentTime + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + dur);
    o.connect(g);
    g.connect(ctx.destination);
    o.start();
    o.stop(ctx.currentTime + dur + 0.02);
  } catch (e) { /* thiết bị không cho phát — bỏ qua, không được ném lỗi */ }
}

export const sfx = {
  ding() { beep(680, 0.11); setTimeout(() => beep(900, 0.17), 95); },
  nope() { beep(200, 0.22, 'triangle'); },
  fanfare() { [523, 659, 784, 1047].forEach((f, i) => setTimeout(() => beep(f, 0.18), i * 120)); },
  tick() { beep(440, 0.05); },
};

// --- hiệu ứng phần tử -------------------------------------------------------
export function pop(node) {
  if (!node) return;
  node.classList.remove('fx-pop');
  void node.offsetWidth; // ép trình duyệt vẽ lại để animation chạy lần nữa
  node.classList.add('fx-pop');
  setTimeout(() => node.classList.remove('fx-pop'), 460);
}

export function shake(node) {
  if (!node) return;
  node.classList.remove('fx-shake');
  void node.offsetWidth;
  node.classList.add('fx-shake');
  setTimeout(() => node.classList.remove('fx-shake'), 420);
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export function reducedMotion() {
  return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

// --- mở khoá audio/video cho iOS --------------------------------------------
// PHẢI gọi trong cú chạm đầu tiên của người dùng (chọn bé), nếu không iOS
// chặn mọi tiếng về sau. Phát rồi tạm dừng cả <video> lẫn một utterance câm.
let unlocked = false;

export function unlockMedia(video) {
  if (unlocked) return;
  unlocked = true;
  const ctx = audioCtx();
  if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {});
  try {
    const u = new SpeechSynthesisUtterance(' ');
    u.volume = 0;
    speechSynthesis.speak(u);
  } catch (e) { /* trình duyệt không có TTS */ }
  if (video) {
    try {
      video.muted = true;
      const p = video.play();
      const rest = () => { video.pause(); video.currentTime = 0; video.muted = false; };
      if (p && p.then) p.then(rest).catch(() => { video.muted = false; });
      else rest();
    } catch (e) { /* chưa có nguồn video — không sao */ }
  }
}

export function isUnlocked() { return unlocked; }
