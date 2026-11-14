// Âm thanh tổng hợp bằng WebAudio (không cần file mp3), giọng đọc, hạt hiệu ứng.

let ac = null;
export function unlockAudio() {
  if (!ac) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (AC) ac = new AC();
  }
  if (ac && ac.state === 'suspended') ac.resume();
}

function tone(freq, dur, { type = 'sine', vol = 0.25, slide = 0, delay = 0 } = {}) {
  if (!ac) return;
  const t = ac.currentTime + delay;
  const o = ac.createOscillator();
  const g = ac.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(30, freq + slide), t + dur);
  g.gain.setValueAtTime(vol, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + dur);
  o.connect(g).connect(ac.destination);
  o.start(t);
  o.stop(t + dur + 0.02);
}

function noise(dur, { vol = 0.2, freq = 1200, q = 1, delay = 0 } = {}) {
  if (!ac) return;
  const t = ac.currentTime + delay;
  const buf = ac.createBuffer(1, Math.ceil(ac.sampleRate * dur), ac.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  const src = ac.createBufferSource();
  src.buffer = buf;
  const f = ac.createBiquadFilter();
  f.type = 'bandpass'; f.frequency.value = freq; f.Q.value = q;
  const g = ac.createGain();
  g.gain.setValueAtTime(vol, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + dur);
  src.connect(f).connect(g).connect(ac.destination);
  src.start(t);
}

export const sfx = {
  whack() { tone(180, 0.18, { type: 'square', vol: 0.3, slide: -120 }); noise(0.08, { vol: 0.35, freq: 900 }); },
  pop() { tone(500, 0.12, { type: 'sine', vol: 0.15, slide: 500 }); },
  gold() { [880, 1108, 1318, 1760].forEach((f, i) => tone(f, 0.15, { type: 'triangle', vol: 0.2, delay: i * 0.07 })); },
  beep(hi) { tone(hi ? 1046 : 523, hi ? 0.4 : 0.18, { type: 'triangle', vol: 0.25 }); },
  fanfare() { [523, 659, 784, 1046, 784, 1046].forEach((f, i) => tone(f, 0.22, { type: 'triangle', vol: 0.22, delay: i * 0.13 })); },
  heat(level) { tone(200 + level * 400, 0.12, { type: 'sawtooth', vol: 0.05 + level * 0.07 }); },
  whoosh() { noise(0.7, { vol: 0.4, freq: 400, q: 0.6 }); tone(90, 0.7, { type: 'sawtooth', vol: 0.12, slide: 60 }); },
  sizzle() { noise(0.35, { vol: 0.3, freq: 3500, q: 0.8 }); tone(700, 0.3, { type: 'square', vol: 0.08, slide: -500 }); },
  safe() { tone(660, 0.12, { type: 'triangle', vol: 0.2 }); tone(990, 0.2, { type: 'triangle', vol: 0.2, delay: 0.1 }); },
};

// --- giọng đọc tiếng Việt ----------------------------------------------------
let viVoice;
function pickVoice() {
  const vs = (window.speechSynthesis && speechSynthesis.getVoices()) || [];
  viVoice = vs.find((v) => /^vi/i.test(v.lang)) || null;
}
if (window.speechSynthesis) {
  pickVoice();
  speechSynthesis.onvoiceschanged = pickVoice;
}
export function say(text, rate = 1) {
  if (!window.speechSynthesis) return;
  try {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'vi-VN';
    if (viVoice) u.voice = viVoice;
    u.rate = rate;
    speechSynthesis.speak(u);
  } catch (e) { /* máy không có TTS */ }
}

// --- hạt hiệu ứng (vẽ lên canvas của stage) ----------------------------------
export class Particles {
  constructor() { this.list = []; }
  burst(x, y, { n = 14, colors = ['#FFD45E', '#F5B21E', '#fff'], speed = 6, size = 6, gravity = 0.25, life = 40, text = null } = {}) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, s = speed * (0.4 + Math.random());
      this.list.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s - speed * 0.4, g: gravity,
        life, max: life, size: size * (0.6 + Math.random() * 0.8), c: colors[i % colors.length], text });
    }
  }
  text(x, y, str, color = '#fff', size = 48) {
    this.list.push({ x, y, vx: 0, vy: -1.6, g: 0, life: 45, max: 45, size, c: color, label: str });
  }
  draw(ctx) {
    this.list = this.list.filter((p) => p.life > 0);
    for (const p of this.list) {
      p.x += p.vx; p.y += p.vy; p.vy += p.g; p.life--;
      const a = Math.min(1, p.life / (p.max * 0.5));
      ctx.globalAlpha = a;
      if (p.label) {
        ctx.font = `800 ${p.size}px 'Baloo 2', system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.lineWidth = p.size / 7;
        ctx.strokeStyle = '#2B2A28';
        ctx.strokeText(p.label, p.x, p.y);
        ctx.fillStyle = p.c;
        ctx.fillText(p.label, p.x, p.y);
      } else if (p.text) {
        ctx.font = `${p.size * 3}px system-ui`;
        ctx.textAlign = 'center';
        ctx.fillText(p.text, p.x, p.y);
      } else {
        ctx.fillStyle = p.c;
        ctx.beginPath(); ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2); ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
