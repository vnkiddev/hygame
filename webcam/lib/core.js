'use strict';
// =====================================================================
//  LÕI CHUNG cho mọi trò webcam (webcam.vnkid.dev)
//
//  Mỗi trò chỉ cần:
//    <link rel="stylesheet" href="../lib/core.css">
//    <script src="../lib/core.js"></script>
//    <script> const GAME = { title, desc, reset(N), update(dt), draw(dt), ... }; boot(GAME); </script>
//
//  Lõi lo: camera + MediaPipe (dáng người + cử chỉ tay), chọn 1–2 người,
//  nhạc nền nhẹ, màn chờ / đếm ngược / kết thúc, và điều khiển menu bằng
//  tay (đưa tay tới nút, nắm tay ✊ để bấm — không nắm được thì giữ yên).
//
//  Luật chung: chơi 1 hoặc 2 người, có nhạc khi chơi, KHÔNG dùng giọng đọc.
// =====================================================================

const COLORS = ['#ff5a5f', '#3d8bff'];
const DARKS  = ['#b83236', '#1f5fbf'];
const LIGHTS = ['#ffe3e3', '#dfeaff'];
const PNAME  = ['P1', 'P2'];
const MAXP = 2;
const $ = id => document.getElementById(id);
const rand = (a, b) => a + Math.random() * (b - a);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
};

// ---------- DOM dùng chung (tự dựng, trang trò chơi khỏi phải chép) ----------
function ensureDom() {
  if (!$('c')) { const c = document.createElement('canvas'); c.id = 'c'; document.body.prepend(c); }
  if (!$('v')) { const v = document.createElement('video'); v.id = 'v'; v.playsInline = true; v.muted = true; v.setAttribute('playsinline', ''); document.body.appendChild(v); }
  if (!$('hc')) { const h = document.createElement('canvas'); h.id = 'hc'; document.body.appendChild(h); }
}
ensureDom();

const cv = $('c'), ctx = cv.getContext('2d'), video = $('v');
const hcv = $('hc'), hctx = hcv.getContext('2d');
let W = 0, H = 0, DPR = 1;
function resize() {
  DPR = Math.min(window.devicePixelRatio || 1, 2);
  W = innerWidth; H = innerHeight;
  for (const [c, x] of [[cv, ctx], [hcv, hctx]]) { c.width = W * DPR; c.height = H * DPR; x.setTransform(DPR, 0, 0, DPR, 0, 0); }
}
addEventListener('resize', resize); resize();

// ---------- Âm thanh ----------
let AC = null, MASTER = null;
function audioInit() {
  if (!AC) {
    const A = window.AudioContext || window.webkitAudioContext;
    if (!A) return;
    AC = new A();
    MASTER = AC.createGain(); MASTER.gain.value = .9; MASTER.connect(AC.destination);
  }
  if (AC.state === 'suspended') AC.resume().catch(() => {});
}
// Trình duyệt chỉ cho phát tiếng sau một lần chạm/bấm phím — chạm đầu tiên ở đâu cũng mở khoá.
const audioUnlocked = () => !!AC && AC.state === 'running';
['pointerdown', 'keydown', 'touchstart'].forEach(ev => addEventListener(ev, () => {
  audioInit();
  if (BGM.wanted && !BGM.playing) BGM.play(BGM.wanted);
}, { passive: true }));

function toneAt(f, dur, t, type = 'sine', vol = .18, slide = null, dest = null) {
  if (!AC) return;
  const o = AC.createOscillator(), g = AC.createGain();
  o.type = type; o.frequency.setValueAtTime(f, t);
  if (slide) o.frequency.exponentialRampToValueAtTime(slide, t + dur);
  g.gain.setValueAtTime(.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + .01);
  g.gain.exponentialRampToValueAtTime(.0001, t + dur);
  o.connect(g).connect(dest || MASTER); o.start(t); o.stop(t + dur + .03);
}
function tone(f, dur, type, vol, slide, when = 0) { if (AC) toneAt(f, dur, AC.currentTime + when, type, vol, slide); }
function noiseAt(dur, t, vol = .2, freq = 1200, q = 1) {
  if (!AC) return;
  const b = AC.createBuffer(1, Math.ceil(AC.sampleRate * dur), AC.sampleRate), d = b.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  const s = AC.createBufferSource(); s.buffer = b;
  const f = AC.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = freq; f.Q.value = q;
  const g = AC.createGain(); g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(.0001, t + dur);
  s.connect(f).connect(g).connect(MASTER); s.start(t);
}
const SFX = {
  jump:  () => tone(300, .22, 'sine', .13, 600),
  eat:   () => { tone(880, .1, 'triangle', .18); tone(1320, .16, 'triangle', .18, null, .08); },
  pop:   () => { tone(900, .06, 'square', .07, 200); tone(1400, .08, 'triangle', .1, null, .03); },
  bonus: () => [0, 1, 2, 3].forEach(i => tone(660 * Math.pow(1.26, i), .14, 'triangle', .15, null, i * .07)),
  beep:  () => tone(660, .18, 'sine', .22),
  go:    () => tone(990, .4, 'sine', .25),
  bad:   () => tone(240, .4, 'sawtooth', .12, 110),
  step:  () => tone(160, .05, 'sine', .07, 90),
  click: () => { tone(700, .07, 'triangle', .16); tone(1050, .1, 'triangle', .14, null, .05); },
  hover: () => tone(1200, .04, 'sine', .05),
  heat:  (p) => tone(220 + p * 380, .1, 'triangle', .05 + p * .08),
  whoosh:() => { if (AC) { noiseAt(.8, AC.currentTime, .3, 400, .6); } tone(110, .7, 'sawtooth', .08, 60); },
  sizzle:() => { if (AC) noiseAt(.35, AC.currentTime, .25, 3500, .8); tone(700, .3, 'triangle', .1, 200); },
  safe:  () => { tone(660, .12, 'triangle', .16); tone(990, .2, 'triangle', .16, null, .1); },
  win:   () => [523, 659, 784, 1047].forEach((f, i) => tone(f, .3, 'triangle', .18, null, i * .15)),
};

// ---------- Nhạc nền (tự soạn, tiếng nhẹ: triangle + sine, không chói) ----------
function nf(n) {
  if (n === 'R') return 0;
  const m = /^([A-G])([#b]?)(\d)$/.exec(n);
  const base = { C: -9, D: -7, E: -5, F: -4, G: -2, A: 0, B: 2 }[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0);
  return 440 * Math.pow(2, (base + (+m[3] - 4) * 12) / 12);
}
function parseTune(s) {
  return s.replace(/\|/g, ' ').trim().split(/\s+/).map(t => { const [n, d] = t.split(':'); return { f: nf(n), d: d ? +d : 1 }; });
}
// beat: 'pop' = trống nhẹ có nhịp; 'soft' = chỉ bass; 'box' = hộp nhạc (lấp lánh, không trống)
const TUNES = {
  // Nhạc vui của Đập chuột chũi (giữ nguyên giai điệu, giảm tiếng chói)
  whack: { bpm: 126, fast: 148, beat: 'pop', bass: ['C3', 'A2', 'F2', 'G2'],
    notes: 'E5:.5 G5:.5 C6 G5:.5 E5:.5 G5 | A5:.5 G5:.5 E5:.5 C5:.5 E5 A4 | F5:.5 A5:.5 C6:.5 A5:.5 G5:.5 F5:.5 E5:.5 D5:.5 | D5:.5 G5:.5 B5:.5 G5:.5 D6 R | ' +
           'C6:.5 B5:.5 G5:.5 E5:.5 G5 C5 | E5:.5 A5:.5 C6:.5 A5:.5 E5 R | F5:.5 F5:.5 A5:.5 C6:.5 D6:.5 C6:.5 A5:.5 F5:.5 | G5:.5 B5:.5 D6:.5 B5:.5 G5 R:.5 G4:.5' },
  // Trang chủ: hộp nhạc chậm, êm
  home: { bpm: 84, fast: 84, beat: 'box', bass: ['C3', 'A2', 'F2', 'G2'],
    notes: 'E5 G5 C6 G5 | E5 A5 C6 A5 | F5 A5 C6 A5 | G5 B5 D6 B5 | ' +
           'C6:1.5 B5:.5 A5 G5 | A5:1.5 G5:.5 E5 C5 | F5 E5 D5 A5 | G5:2 R:2' },
  // Bóng bay: nhẹ, bồng bềnh
  balloon: { bpm: 108, fast: 128, beat: 'soft', bass: ['F2', 'D3', 'Bb2', 'C3'],
    notes: 'C5:.5 F5:.5 A5 G5:.5 F5:.5 | D5:.5 F5:.5 A5 D6 R | Bb4:.5 D5:.5 F5 Bb5:.5 A5:.5 G5 | C5:.5 E5:.5 G5 C6 R | ' +
           'A5:.5 G5:.5 F5 C5:.5 F5:.5 A5 | D6:.5 C6:.5 A5 F5 R | Bb5:.5 A5:.5 G5 D5:.5 G5:.5 | E5:.5 F5:.5 G5 C5 R' },
  // Dung nham: hơi hồi hộp nhưng vẫn vui; lúc ô cháy thì nhanh lên
  lava: { bpm: 112, fast: 138, beat: 'pop', bass: ['A2', 'F2', 'G2', 'E2'],
    notes: 'A4:.5 C5:.5 E5:.5 C5:.5 A5 E5 | F4:.5 A4:.5 C5:.5 A4:.5 F5 C5 | G4:.5 B4:.5 D5:.5 B4:.5 G5 D5 | E4:.5 G#4:.5 B4:.5 E5:.5 G#5 R | ' +
           'A5:.5 G5:.5 E5:.5 C5:.5 E5 A4 | F5:.5 E5:.5 C5:.5 A4:.5 C5 F4 | G5:.5 F5:.5 D5:.5 B4:.5 D5 G4 | E5:.5 D5:.5 B4:.5 G#4:.5 E5 R' },
  // Đua khủng long: phi nước đại, nhịp nhanh theo tốc độ chạy của bé
  dino: { bpm: 116, fast: 150, beat: 'pop', bass: ['G2', 'E2', 'C3', 'D3'],
    notes: 'G4:.5 B4:.5 D5:.5 G5:.5 D5:.5 B4:.5 D5 | E5:.5 G5:.5 E5:.5 B4:.5 E5 R | C5:.5 E5:.5 G5:.5 C6:.5 G5:.5 E5:.5 G5 | D5:.5 F#5:.5 A5:.5 D6:.5 A5 R | ' +
           'B5:.5 A5:.5 G5:.5 D5:.5 G5 B5 | E5:.5 F#5:.5 G5:.5 E5:.5 B4 R | C6:.5 B5:.5 A5:.5 G5:.5 E5:.5 G5:.5 C6 | D6:.5 C6:.5 A5:.5 F#5:.5 G5 R' },
  // Chém hoa quả: nhảy nhót, rộn ràng
  fruit: { bpm: 124, fast: 146, beat: 'pop', bass: ['D3', 'B2', 'G2', 'A2'],
    notes: 'D5:.5 F#5:.5 A5 F#5:.5 D5:.5 A5 | B4:.5 D5:.5 G5 D5:.5 B4:.5 G5 | G5:.5 A5:.5 B5:.5 G5:.5 E5 D5 | C#5:.5 E5:.5 A5:.5 E5:.5 A4 R | ' +
           'F#5:.5 A5:.5 D6:.5 A5:.5 F#5 D5 | G5:.5 B5:.5 D6:.5 B5:.5 G5 R | E5:.5 F#5:.5 G5:.5 B5:.5 A5:.5 G5:.5 F#5:.5 E5:.5 | D5:.5 E5:.5 F#5:.5 A5:.5 D5 R' },
};
for (const k in TUNES) { TUNES[k].seq = parseTune(TUNES[k].notes); TUNES[k].bassF = TUNES[k].bass.map(nf); }

const BGM = {
  mode: store.get('kg_bgm', 'builtin'),   // builtin | file | off
  fileEl: null, playing: false, wanted: null, tune: null, bpm: 120, timer: null, out: null,
  play(name) {
    this.wanted = name || this.wanted;
    audioInit();
    if (this.mode === 'off' || !AC) return;
    if (this.mode === 'file' && this.fileEl) { this.fileEl.currentTime = 0; this.fileEl.play().catch(() => {}); this.playing = true; return; }
    if (AC.state !== 'running') return;            // chưa mở khoá — chạm đầu tiên sẽ gọi lại
    const t = TUNES[this.wanted] || TUNES.whack;
    if (this.playing && this.tune === t) return;
    this.stop(true);
    this.tune = t; this.bpm = t.bpm;
    if (!this.out) { this.out = AC.createGain(); this.out.connect(MASTER); }
    this.out.gain.cancelScheduledValues(AC.currentTime);
    this.out.gain.setValueAtTime(.0001, AC.currentTime);
    this.out.gain.exponentialRampToValueAtTime(.75, AC.currentTime + .6);   // vào nhạc từ từ
    this.idx = 0; this.beat = 0; this.next = this.nextBeat = AC.currentTime + .08; this.playing = true;
    this.timer = setInterval(() => this.tick(), 25);
  },
  stop(keepWanted) {
    if (this.fileEl) this.fileEl.pause();
    if (this.out && AC) { this.out.gain.cancelScheduledValues(AC.currentTime); this.out.gain.setValueAtTime(0, AC.currentTime); }
    clearInterval(this.timer); this.timer = null; this.playing = false;
    if (!keepWanted) this.wanted = null;
  },
  setMode(m) { this.mode = m; if (m !== 'file') store.set('kg_bgm', m); },
  // tốc độ nhạc theo tỉ lệ (1 = bình thường), dùng cho trò muốn nhạc bám theo bé
  setRate(f) { if (this.tune) this.bpm = this.tune.bpm * clamp(f, .8, 1.4); if (this.fileEl) this.fileEl.playbackRate = clamp(f, .8, 1.25); },
  setFast(on) { if (this.tune) this.bpm = on ? this.tune.fast : this.tune.bpm; if (this.fileEl) this.fileEl.playbackRate = on ? 1.12 : 1; },
  tick() {
    const T = this.tune, spb = 60 / this.bpm, hz = AC.currentTime + .15, o = this.out;
    while (this.next < hz) {
      const n = T.seq[this.idx], dur = n.d * spb;
      if (n.f) {
        toneAt(n.f, dur * .9, this.next, 'triangle', .11, null, o);
        toneAt(n.f * (T.beat === 'box' ? 2 : .5), dur * .7, this.next, 'sine', T.beat === 'box' ? .035 : .05, null, o);
      }
      this.next += dur; this.idx = (this.idx + 1) % T.seq.length;
    }
    while (this.nextBeat < hz) {
      const b = this.beat, root = T.bassF[Math.floor(b / 4) % T.bassF.length], t = this.nextBeat;
      if (T.beat === 'box') {
        if (b % 2 === 0) toneAt(root, spb * 1.6, t, 'sine', .12, null, o);
      } else {
        toneAt(b % 2 === 0 ? root : root * 2, spb * .45, t, 'triangle', .16, null, o);
        if (T.beat === 'pop') {
          if (b % 2 === 0) toneAt(140, .1, t, 'sine', .22, 50, o);          // trống nhẹ
          toneAt(2600, .025, t + spb / 2, 'triangle', .012, null, o);      // hi-hat rất khẽ
        }
      }
      this.nextBeat += spb; this.beat++;
    }
  }
};

// ---------- Trạng thái chung ----------
const G = { N: 1, state: 'menu', stateT: 0, t: 0, sens: .20, showCam: true,
            camTried: false, camReady: false, camMsg: '', readyHold: 0, lastCount: null,
            bgCam: store.get('kg_bg', 'cam') === 'cam' };   // nền: hình camera (mặc định) hay nền vẽ của trò
const sensLevel = () => Math.round((.41 - G.sens) / .03);
function setState(s) { G.state = s; G.stateT = 0; }
let CUR = null;   // trò đang chạy (null ở trang chủ)

// ---------- Theo dõi từng người ----------
class Tracker {
  constructor() { this.reset(); }
  reset() {
    this.lm = null; this.seen = false; this.ok = false; this.seenSince = 0; this.cx = null;
    this.baseline = null; this.rise = 0; this.torso = .25; this.armed = true;
    this.bArmed = true; this.prev = null; this.motion = 0;
    this.kneeUp = [false, false]; this.thigh = [null, null]; this.kneesVisible = false;
  }
  miss() { this.seen = false; this.ok = false; this.prev = null; this.motion *= .5; }
  update(lm) {
    const ev = { jump: false, steps: 0, bounce: false };
    const now = performance.now() / 1000;
    if (!this.seen) this.seenSince = now;
    this.lm = lm; this.seen = true;
    this.cx = centerX(lm);
    const vis = i => (lm[i].visibility ?? 1) > .5;
    this.ok = vis(11) && vis(12) && vis(23) && vis(24);
    if (this.prev) {
      let s = 0, n = 0;
      for (const i of [0, 11, 12, 13, 14, 15, 16, 23, 24, 25, 26]) {
        if (vis(i)) { s += Math.hypot(lm[i].x - this.prev[i].x, lm[i].y - this.prev[i].y); n++; }
      }
      if (n) this.motion = this.motion * .55 + (s / n / this.torso) * .45;
    }
    this.prev = lm.map(p => ({ x: p.x, y: p.y }));
    if (!this.ok) { this.seenSince = now; return ev; }
    const shY = (lm[11].y + lm[12].y) / 2, hipY = (lm[23].y + lm[24].y) / 2;
    this.torso = this.torso * .9 + Math.max(.05, hipY - shY) * .1;
    if (this.baseline === null) this.baseline = hipY;
    this.rise = this.baseline - hipY;
    const th = this.torso * G.sens;
    if (Math.abs(this.rise) < this.torso * .08) this.baseline += (hipY - this.baseline) * .08;
    else if (this.rise < 0) this.baseline += (hipY - this.baseline) * .05;
    else this.baseline += (hipY - this.baseline) * .004;
    if (this.armed && this.rise > th) { ev.jump = true; this.armed = false; }
    if (!this.armed && this.rise < th * .35) this.armed = true;
    if (this.bArmed && this.rise > this.torso * .06) { ev.bounce = true; this.bArmed = false; }
    if (!this.bArmed && this.rise < this.torso * .02) this.bArmed = true;
    const kTh = G.sens * 1.75;
    this.kneesVisible = vis(25) && vis(26);
    [[0, 25, 23], [1, 26, 24]].forEach(([k, ki, hi]) => {
      if (!vis(ki)) return;
      const d = lm[ki].y - lm[hi].y;
      if (this.thigh[k] === null) this.thigh[k] = Math.max(d, this.torso * .5);
      const lift = 1 - d / Math.max(.02, this.thigh[k]);
      if (d > this.thigh[k]) this.thigh[k] += (d - this.thigh[k]) * .2;
      else if (lift < .12) this.thigh[k] += (d - this.thigh[k]) * .02;
      if (!this.kneeUp[k] && lift > kTh) { this.kneeUp[k] = true; ev.steps++; }
      else if (this.kneeUp[k] && lift < kTh * .45) this.kneeUp[k] = false;
    });
    return ev;
  }
  seenFor() { return this.seen && this.ok ? performance.now() / 1000 - this.seenSince : 0; }
}
const TR = [new Tracker(), new Tracker()];
// tâm thân người theo trục ngang, đã lật gương (0 = mép trái màn hình)
function centerX(lm) { return 1 - (lm[11].x + lm[12].x + lm[23].x + lm[24].x) / 4; }

// ---------- Camera + MediaPipe ----------
const MP = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14';
const MODEL = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task';
const GESTURE_MODEL = 'https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/1/gesture_recognizer.task';
let landmarker = null, gestureRec = null, lastVT = -1, allPoses = [], handsSeen = [], gFrame = 0;
let camPromise = null;
function initCam() {
  if (camPromise) return camPromise;
  G.camTried = true;
  camPromise = (async () => {
    const st = $('status') || { textContent: '' };
    if (new URLSearchParams(location.search).has('nocam') || !navigator.mediaDevices) {
      G.camMsg = 'Không có camera – đang chơi bằng chuột/bàn phím'; st.textContent = G.camMsg; return;
    }
    try {
      st.textContent = 'Đang bật camera…';
      const stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' }, audio: false });
      video.srcObject = stream; await video.play();
      st.textContent = 'Đang tải mô hình nhận diện (lần đầu hơi lâu)…';
      const V = await import(MP + '/vision_bundle.mjs');
      const fs = await V.FilesetResolver.forVisionTasks(MP + '/wasm');
      const opt = d => ({ baseOptions: { modelAssetPath: MODEL, delegate: d }, runningMode: 'VIDEO', numPoses: MAXP,
                          minPoseDetectionConfidence: .5, minPosePresenceConfidence: .5, minTrackingConfidence: .5 });
      try { landmarker = await V.PoseLandmarker.createFromOptions(fs, opt('GPU')); }
      catch (e) { landmarker = await V.PoseLandmarker.createFromOptions(fs, opt('CPU')); }
      G.camReady = true; st.textContent = '';
      // Nhận cử chỉ tay (nắm tay = bấm) — tải sau, hỏng thì vẫn chọn được bằng cách giữ tay yên
      const gopt = d => ({ baseOptions: { modelAssetPath: GESTURE_MODEL, delegate: d }, runningMode: 'VIDEO', numHands: 2,
                           minHandDetectionConfidence: .4, minHandPresenceConfidence: .4, minTrackingConfidence: .4 });
      try { gestureRec = await V.GestureRecognizer.createFromOptions(fs, gopt('GPU')); }
      catch (e) { try { gestureRec = await V.GestureRecognizer.createFromOptions(fs, gopt('CPU')); } catch (e2) { console.warn('Không tải được nhận cử chỉ tay', e2); } }
    } catch (e) {
      console.error(e);
      G.camMsg = G.camReady ? '' : 'Không bật được camera hoặc không tải được mô hình – đang chơi bằng chuột/bàn phím';
      st.textContent = G.camMsg;
    }
  })();
  return camPromise;
}

function detect() {
  if (!landmarker || video.readyState < 2 || video.currentTime === lastVT) return;
  lastVT = video.currentTime;
  const ts = performance.now();
  let res; try { res = landmarker.detectForVideo(video, ts); } catch (e) { return; }
  allPoses = (res && res.landmarks) || [];
  // Cử chỉ tay chỉ cần khi đang ở menu — cách 1 khung chạy 1 lần cho nhẹ máy
  if (gestureRec && HandNav.active() && (gFrame++ & 1) === 0) {
    try {
      const g = gestureRec.recognizeForVideo(video, ts + .5);
      handsSeen = (g.landmarks || []).map((lm, k) => {
        const top = (g.gestures[k] || [])[0];
        return { x: 1 - lm[0].x, y: lm[0].y, cx: 1 - lm[9].x, cy: lm[9].y, fist: !!top && top.categoryName === 'Closed_Fist' && top.score > .55 };
      });
    } catch (e) { handsSeen = []; }
  } else if (!HandNav.active()) handsSeen = [];
  if (CUR) assignPlayers();
}

function assignPlayers() {
  const N = G.N, best = new Array(N).fill(null);
  if (CUR.freeRoam) {
    // Trò chạy khắp màn hình (dung nham): bám theo người gần vị trí cũ nhất
    const ps = allPoses.map(lm => ({ lm, cx: centerX(lm) })), used = new Set();
    for (let i = 0; i < N; i++) {
      if (!TR[i].seen || TR[i].cx === null) continue;
      let bj = -1, bd = .35;
      ps.forEach((p, j) => { const d = Math.abs(p.cx - TR[i].cx); if (!used.has(j) && d < bd) { bd = d; bj = j; } });
      if (bj >= 0) { best[i] = ps[bj]; used.add(bj); }
    }
    const rest = ps.filter((p, j) => !used.has(j)).sort((a, b) => a.cx - b.cx);
    for (let i = 0; i < N; i++) if (!best[i] && rest.length) best[i] = rest.shift();
  } else {
    // Mỗi bé một ô: trái/phải
    for (const lm of allPoses) {
      const cx = centerX(lm);
      const z = clamp(Math.floor(cx * N), 0, N - 1);
      const d = Math.abs(cx - (z + .5) / N);
      if (!best[z] || d < best[z].d) best[z] = { lm, d };
    }
  }
  for (let i = 0; i < N; i++) {
    if (!best[i]) { TR[i].miss(); continue; }
    const ev = TR[i].update(best[i].lm);
    if (G.state === 'play') {
      if (ev.jump && CUR.onJump) CUR.onJump(i);
      if (CUR.onStep) {
        if (ev.steps) CUR.onStep(i, ev.steps);
        else if (ev.bounce && !TR[i].kneesVisible) CUR.onStep(i, 1);
      }
    }
  }
}

// ---------- Điều khiển menu bằng tay ----------
// Con trỏ = cổ tay đang giơ cao nhất (từ dáng người, bắt được cả khi đứng xa).
// Bấm = nắm tay ✊ (nhận cử chỉ). Camera xa quá không thấy rõ bàn tay thì
// giữ yên tay trên nút DWELL giây cũng bấm được.
const HandNav = {
  enabled: true, x: 0, y: 0, has: false, fist: false, fistFrames: 0, latched: false,
  hoverEl: null, hoverT: 0, lockEl: null, flash: 0, lostT: 0, DWELL: 2.0,
  active() { return this.enabled && G.camReady && (!CUR || G.state === 'menu' || G.state === 'end'); },
  pickHand() {
    // người gần camera nhất (thân to nhất)
    let best = null, bs = 0;
    for (const lm of allPoses) {
      const s = Math.abs(lm[23].y - lm[11].y) + Math.abs(lm[24].y - lm[12].y);
      if (s > bs) { bs = s; best = lm; }
    }
    if (best) {
      const vis = k => (best[k].visibility ?? 1) > .35;
      const sx = 1 - (best[11].x + best[12].x) / 2, sy = (best[11].y + best[12].y) / 2;
      const T = Math.max(.08, Math.abs(((best[23].y + best[24].y) / 2) - sy));
      const hipY = sy + T;
      let w = null;
      for (const [wr, ix] of [[15, 19], [16, 20]]) {
        if (!vis(wr)) continue;
        const f = vis(ix) ? { x: (best[wr].x + best[ix].x) / 2, y: (best[wr].y + best[ix].y) / 2 } : best[wr];
        if (f.y > hipY - T * .15) continue;                       // tay đang buông thõng — bỏ qua
        if (!w || f.y < w.y) w = { x: f.x, y: f.y, raw: best[wr] };
      }
      if (w) {
        // quy đổi theo tầm với của tay: cả màn hình nằm gọn trong vòng tay bé
        const nx = clamp(((1 - w.x) - (sx - 1.5 * T)) / (3.0 * T), 0, 1);
        const ny = clamp((w.y - (sy - 1.3 * T)) / (2.2 * T), 0, 1);
        return { nx, ny, ix: 1 - w.raw.x, iy: w.raw.y };
      }
    }
    // Không thấy dáng người (ngồi sát camera) — dùng thẳng bàn tay nhận được
    if (handsSeen.length) {
      const h = handsSeen.reduce((a, b) => (b.cy < a.cy ? b : a));
      return { nx: clamp((h.cx - .15) / .7, 0, 1), ny: clamp((h.cy - .1) / .7, 0, 1), ix: h.x, iy: h.y, fist: h.fist };
    }
    return null;
  },
  update(dt) {
    this.flash = Math.max(0, this.flash - dt);
    if (!this.active()) { this.has = false; this.setHover(null); return; }
    const p = this.pickHand();
    if (!p) {
      this.lostT += dt;
      if (this.lostT > .4) { this.has = false; this.setHover(null); }
      return;
    }
    this.lostT = 0;
    const tx = p.nx * W, ty = p.ny * H;
    if (!this.has) { this.x = tx; this.y = ty; }
    this.x += (tx - this.x) * .45; this.y += (ty - this.y) * .45;
    this.has = true;
    // nắm tay: lấy bàn tay nhận được gần cổ tay đang làm con trỏ nhất
    let fist = !!p.fist;
    if (p.fist === undefined && handsSeen.length) {
      let bd = .14;
      for (const h of handsSeen) { const d = Math.hypot(h.x - p.ix, h.y - p.iy); if (d < bd) { bd = d; fist = h.fist; } }
    }
    this.fistFrames = fist ? this.fistFrames + 1 : 0;
    this.fist = this.fistFrames >= 2;
    // phần tử dưới con trỏ
    const el = this.elementAt(this.x, this.y);
    this.setHover(el);
    if (!this.fist) this.latched = false;
    if (el && this.fist && !this.latched) { this.latched = true; this.press(el); return; }
    if (el && el !== this.lockEl) {
      this.hoverT += dt;
      if (this.hoverT >= this.DWELL) this.press(el);
    }
  },
  elementAt(x, y) {
    const e = document.elementFromPoint(x, y);
    const el = e && e.closest('button, a[href], [data-hand]');
    if (!el || el.disabled || el.offsetParent === null) return null;
    return el;
  },
  setHover(el) {
    if (el === this.hoverEl) return;
    if (this.hoverEl) this.hoverEl.classList.remove('hand-hover');
    this.hoverEl = el; this.hoverT = 0;
    if (el !== this.lockEl) this.lockEl = null;
    if (el) { el.classList.add('hand-hover'); SFX.hover(); }
  },
  press(el) {
    this.lockEl = el; this.hoverT = 0; this.flash = .35;
    SFX.click();
    el.click();
  },
  draw() {
    hctx.clearRect(0, 0, W, H);
    if (!this.has) return;
    const r = Math.min(W, H) * .045, x = this.x, y = this.y;
    // vòng đếm giữ yên
    if (this.hoverEl && this.hoverEl !== this.lockEl && this.hoverT > .15) {
      hctx.strokeStyle = '#ff8a3d'; hctx.lineWidth = r * .22; hctx.lineCap = 'round';
      hctx.beginPath(); hctx.arc(x, y, r * 1.35, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.min(1, this.hoverT / this.DWELL)); hctx.stroke();
    }
    hctx.fillStyle = this.flash > 0 ? 'rgba(255,235,59,.95)' : 'rgba(255,255,255,.85)';
    hctx.strokeStyle = '#ff8a3d'; hctx.lineWidth = r * .14;
    hctx.beginPath(); hctx.arc(x, y, r, 0, 7); hctx.fill(); hctx.stroke();
    hctx.font = emojiFont(r * 1.2); hctx.textAlign = 'center'; hctx.textBaseline = 'middle';
    hctx.fillText(this.fist ? '✊' : '✋', x, y + r * .05);
  }
};

// ---------- Vẽ chung ----------
const BONES = [[11,12],[11,13],[13,15],[12,14],[14,16],[11,23],[12,24],[23,24],[23,25],[25,27],[24,26],[26,28],[0,11],[0,12]];
function drawSkel(lm, map, color, lw, c = ctx) {
  c.strokeStyle = color; c.lineWidth = lw; c.lineCap = 'round';
  c.beginPath();
  for (const [a, b] of BONES) {
    if ((lm[a].visibility ?? 1) < .4 || (lm[b].visibility ?? 1) < .4) continue;
    const [x1, y1] = map(lm[a]), [x2, y2] = map(lm[b]);
    c.moveTo(x1, y1); c.lineTo(x2, y2);
  }
  c.stroke();
  const [hx, hy] = map(lm[0]);
  c.fillStyle = color; c.beginPath(); c.arc(hx, hy, lw * 2.2, 0, 7); c.fill();
}
function trackerIndexOf(lm) { for (let i = 0; i < G.N; i++) if (TR[i].seen && TR[i].lm === lm) return i; return -1; }

// camera thu nhỏ, đã lật gương, có chia ô (zones=false: không chia ô)
function drawCam(x, y, w, big = false, zones = true, c = ctx) {
  const h = w * .75;
  c.save();
  c.fillStyle = 'rgba(0,0,0,.45)'; c.fillRect(x - 4, y - 4, w + 8, h + 8);
  c.beginPath(); c.rect(x, y, w, h); c.clip();
  if (G.camReady && video.readyState >= 2) {
    c.save(); c.translate(x + w, y); c.scale(-1, 1); c.drawImage(video, 0, 0, w, h); c.restore();
  } else { c.fillStyle = '#333'; c.fillRect(x, y, w, h); }
  if (zones && CUR) {
    const N = G.N, zw = w / N;
    for (let i = 0; i < N; i++) {
      c.fillStyle = COLORS[i] + '22'; c.fillRect(x + i * zw, y, zw, h);
      c.strokeStyle = COLORS[i]; c.lineWidth = big ? 6 : 3;
      c.strokeRect(x + i * zw + 2, y + 2, zw - 4, h - 4);
      c.fillStyle = COLORS[i]; c.font = `bold ${big ? h * .07 : h * .13}px system-ui,sans-serif`;
      c.textAlign = 'center'; c.textBaseline = 'top';
      c.fillText(PNAME[i], x + (i + .5) * zw, y + 6);
    }
  }
  const map = p => [x + (1 - p.x) * w, y + p.y * h];
  for (const lm of allPoses) {
    const i = CUR ? trackerIndexOf(lm) : -1;
    drawSkel(lm, map, i >= 0 ? COLORS[i] : '#ffb74d', big ? 5 : 2.5, c);
  }
  c.restore();
}
function defaultCamRect() { const w = H * .16; return { x: W - w - H * .02, y: H * .012, w }; }

// ---------- Nền bằng hình camera ----------
// Đang dùng nền camera? (chọn ở menu, và camera phải đang chạy)
const useCamBG = () => G.bgCam && G.camReady && video.readyState >= 2;
// Video phủ kín màn hình kiểu "cover", lật gương
function camCover() {
  const vw = video.videoWidth || 4, vh = video.videoHeight || 3, s = Math.max(W / vw, H / vh);
  const dw = vw * s, dh = vh * s;
  return { dw, dh, ox: (W - dw) / 2, oy: (H - dh) / 2 };
}
// Điểm mốc MediaPipe -> toạ độ màn hình, khớp đúng với hình camera đang vẽ
function camToScreen(p) { const c = camCover(); return [c.ox + (1 - p.x) * c.dw, c.oy + p.y * c.dh]; }
function drawCamBG(dim = .12) {
  const c = camCover();
  ctx.save(); ctx.translate(W, 0); ctx.scale(-1, 1); ctx.drawImage(video, c.ox, c.oy, c.dw, c.dh); ctx.restore();
  if (dim) { ctx.fillStyle = `rgba(0,0,0,${dim})`; ctx.fillRect(0, 0, W, H); }
}

// ---------- Hiệu ứng ----------
let PARTS = [], TEXTS = [];
function burst(x, y, n = 14, colors = ['#ff5252', '#ffd740', '#69f0ae', '#40c4ff', '#ff80ab'], power = 1) {
  for (let i = 0; i < n; i++) {
    const a = Math.random() * 6.28, v = H * rand(.2, .6) * power;
    PARTS.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - H * .3, r: H * rand(.005, .012), life: rand(.6, 1.1), c: colors[i % colors.length] });
  }
}
function floatText(x, y, txt, color = '#ff6f00', size = .06) { TEXTS.push({ x, y, txt, color, size, life: 1 }); }
function drawFX(dt) {
  for (const p of PARTS) {
    p.x += p.vx * dt; p.y += p.vy * dt; p.vy += H * 1.2 * dt; p.life -= dt;
    ctx.globalAlpha = clamp(p.life, 0, 1); ctx.fillStyle = p.c;
    ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, 7); ctx.fill();
  }
  PARTS = PARTS.filter(p => p.life > 0);
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  for (const t of TEXTS) {
    t.y -= H * .12 * dt; t.life -= dt;
    ctx.globalAlpha = clamp(t.life * 1.5, 0, 1);
    ctx.font = `900 ${H * t.size}px system-ui,sans-serif`;
    ctx.lineWidth = H * .008; ctx.strokeStyle = '#fff'; ctx.fillStyle = t.color;
    ctx.strokeText(t.txt, t.x, t.y); ctx.fillText(t.txt, t.x, t.y);
  }
  TEXTS = TEXTS.filter(t => t.life > 0);
  ctx.globalAlpha = 1;
}
function outlined(txt, x, y, size, fill, stroke = '#fff', align = 'center', base = 'middle', weight = 900) {
  ctx.font = `${weight} ${size}px system-ui,sans-serif`; ctx.textAlign = align; ctx.textBaseline = base;
  ctx.lineWidth = size * .14; ctx.strokeStyle = stroke; ctx.lineJoin = 'round';
  ctx.strokeText(txt, x, y); ctx.fillStyle = fill; ctx.fillText(txt, x, y);
}
function roundRect(x, y, w, h, r) { ctx.beginPath(); ctx.roundRect ? ctx.roundRect(x, y, w, h, r) : ctx.rect(x, y, w, h); }
function emojiFont(px) { return `${px}px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif`; }

// ---------- Màn chờ & đếm ngược ----------
function updateReady(dt) {
  const all = TR.slice(0, G.N).every(t => t.seenFor() > .5);
  G.readyHold = all ? G.readyHold + dt : 0;
  if (G.readyHold > 1.2) { setState('countdown'); G.lastCount = null; }
}
function drawReady() {
  ctx.fillStyle = 'rgba(10,20,40,.75)'; ctx.fillRect(0, 0, W, H);
  const w = Math.min(W * .72, H * .92), h = w * .75, x = (W - w) / 2, y = H * .14;
  const msg = G.N === 1 ? 'Đứng vào giữa khung hình nhé!' : CUR.freeRoam ? 'Hai bé cùng đứng vào khung hình nhé!' : 'Mỗi bé đứng vào 1 ô màu của mình!';
  outlined(msg, W / 2, H * .07, H * .055, '#ffeb3b', '#000');
  drawCam(x, y, w, true, !CUR.freeRoam);
  const zw = w / G.N;
  for (let i = 0; i < G.N; i++) {
    const okp = TR[i].seenFor() > .5;
    ctx.font = emojiFont(h * .12); ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(okp ? '✅' : '⏳', x + (i + .5) * zw, y + h * .85);
  }
  outlined('Thấy đủ người sẽ tự bắt đầu · Enter để bắt đầu luôn', W / 2, y + h + H * .045, H * .03, '#fff', '#000', 'center', 'middle', 700);
}
function updateCountdown() {
  const n = 3 - Math.floor(G.stateT);
  if (n !== G.lastCount) {
    G.lastCount = n;
    if (n > 0) SFX.beep();
    else { SFX.go(); setState('play'); BGM.play(CUR.tune || 'whack'); CUR.start && CUR.start(); }
  }
}
function drawCountdown() {
  const n = 3 - Math.floor(G.stateT), f = G.stateT % 1;
  ctx.fillStyle = 'rgba(0,0,0,.25)'; ctx.fillRect(0, 0, W, H);
  outlined(n > 0 ? String(n) : 'BẮT ĐẦU!', W / 2, H / 2, H * (.3 - f * .08), '#ff8a3d', '#fff');
}

// ---------- Menu / kết thúc ----------
function buildOverlays(game) {
  const menu = document.createElement('div');
  menu.id = 'menu'; menu.className = 'ov';
  menu.innerHTML = `
    <a class="btn home" href="../">🏠 Trang chủ</a>
    <h1 id="mTitle"></h1>
    <p id="mDesc"></p>
    <div class="lbl">Số người chơi</div>
    <div class="row" id="pcRow">
      <button class="btn" data-n="1">🧒 1 người</button>
      <button class="btn" data-n="2">🧒🧒 2 người</button>
    </div>
    <div class="lbl">Nhạc nền</div>
    <div class="row" id="bgmRow">
      <button class="btn" data-b="builtin">🎵 Nhạc vui</button>
      <button class="btn" data-b="file" id="bgmFileBtn">📁 Nhạc của mình…</button>
      <button class="btn" data-b="off">🔇 Tắt nhạc</button>
    </div>
    <input type="file" id="bgmFile" accept="audio/*" style="display:none">
    <div class="lbl">Hình nền</div>
    <div class="row" id="bgRow">
      <button class="btn" data-bg="cam">📷 Hình camera</button>
      <button class="btn" data-bg="game">🎨 Nền trò chơi</button>
    </div>
    <div id="mExtra"></div>
    <button class="btn go" id="go">Bắt đầu ▶</button>
    <div id="status"></div>
    <p class="handhint" id="handHint"></p>
    <p class="keys" id="mKeys"></p>`;
  const end = document.createElement('div');
  end.id = 'end'; end.className = 'ov hidden';
  end.innerHTML = `
    <h1 id="eTitle"></h1>
    <div id="eBody" class="rank"></div>
    <div class="row">
      <button class="btn go" id="again">Chơi lại ↻</button>
      <button class="btn" id="back">Đổi số người</button>
      <a class="btn" href="../">🏠 Trang chủ</a>
    </div>
    <p class="handhint">✊ Nắm tay để chọn · Enter = chơi lại · Esc = về menu</p>`;
  document.body.append(menu, end);
}
function selectN(n) {
  G.N = clamp(n, 1, MAXP);
  document.querySelectorAll('#pcRow .btn').forEach(b => b.classList.toggle('sel', +b.dataset.n === G.N));
  store.set('kg_players', G.N);
  if (G.state === 'menu') CUR.reset(G.N);
}
function fullscreen() { if (!document.fullscreenElement) document.documentElement.requestFullscreen?.().catch(() => {}); }
async function startGame() {
  audioInit(); fullscreen();
  $('end').classList.add('hidden');
  $('go').disabled = true;
  await initCam();
  $('go').disabled = false;
  $('menu').classList.add('hidden');
  TR.forEach(t => t.reset());
  PARTS = []; TEXTS = []; G.readyHold = 0; G.lastCount = null;
  CUR.reset(G.N);
  BGM.stop();
  setState(G.camReady ? 'ready' : 'countdown');
}
function toMenu() {
  CUR.stop && CUR.stop();
  BGM.stop();
  setState('menu');
  $('end').classList.add('hidden'); $('menu').classList.remove('hidden');
  CUR.reset(G.N);
}
const MEDALS = ['🥇', '🥈'];
// rows: [{i, text}] đã sắp xếp
function endGame(title, rows, sub = '') {
  CUR.stop && CUR.stop();
  BGM.stop();
  setState('end'); SFX.win();
  for (let k = 0; k < 6; k++) burst(rand(W * .1, W * .9), rand(H * .1, H * .4), 20, undefined, 1.3);
  $('eTitle').textContent = title;
  $('eBody').innerHTML = rows.map((r, k) =>
    `<div>${rows.length > 1 ? (MEDALS[k] || '') : ''}<span class="chip" style="background:${COLORS[r.i]}"></span>` +
    `<span style="color:${DARKS[r.i]}">${G.N > 1 ? PNAME[r.i] + ':' : ''}</span> ${r.text}</div>`).join('') +
    (sub ? `<div class="sub">${sub}</div>` : '');
  setTimeout(() => { if (G.state === 'end') $('end').classList.remove('hidden'); }, 900);
}
function bestRows(scores, label) {
  return scores.map((s, i) => ({ i, s })).sort((a, b) => b.s - a.s).map(r => ({ i: r.i, text: label(r.s) }));
}
function endVersus(scores, label) {
  const rows = bestRows(scores, label);
  const mx = Math.max(...scores), ties = scores.filter(v => v === mx).length;
  endGame(ties > 1 ? '🤝 Hòa nhau rồi!' : `🏆 ${PNAME[rows[0].i]} thắng!`, rows);
}

// ---------- Vòng lặp ----------
let tPrev = performance.now();
function loop(now) {
  const dt = Math.min(.05, (now - tPrev) / 1000); tPrev = now;
  G.t += dt; G.stateT += dt;
  detect();
  HandNav.update(dt);
  if (CUR) {
    if (G.state === 'ready') updateReady(dt);
    if (G.state === 'countdown') updateCountdown();
    if (G.state === 'play') CUR.update(dt);
    ctx.clearRect(0, 0, W, H);
    CUR.draw(dt);
    if (G.state === 'play' && G.showCam && G.camReady && CUR.camRect !== null) {
      const r = (CUR.camRect || defaultCamRect)();
      drawCam(r.x, r.y, r.w, false, !CUR.freeRoam);
      if (CUR.usesSens) outlined(`Độ nhạy ${sensLevel()} (↑/↓)`, r.x + r.w, r.y + r.w * .75 + H * .018, H * .018, '#333', '#fff', 'right', 'middle', 700);
    }
    if (G.state === 'play' && G.camMsg) outlined(G.camMsg, W / 2, CUR.msgY ? CUR.msgY() : H - H * .03, H * .022, '#b23c00', '#fff', 'center', 'middle', 700);
    if (G.state === 'ready') drawReady();
    if (G.state === 'countdown') drawCountdown();
    drawFX(dt);
  } else if (window.HOME_FRAME) {
    window.HOME_FRAME(dt);
  }
  HandNav.draw();
  const hint = $('handHint');
  if (hint) hint.textContent = G.camReady ? '✋ Giơ tay lên để di chuyển · ✊ nắm tay (hoặc giữ yên 2 giây) để chọn' : '';
  requestAnimationFrame(loop);
}

// ---------- Phím ----------
addEventListener('keydown', e => {
  if (!CUR) return;
  if (['Space', 'ArrowUp', 'ArrowDown'].includes(e.code)) e.preventDefault();
  if (e.target && e.target.tagName === 'INPUT') return;
  if (G.state === 'menu') {
    if (/^Digit[1-2]$/.test(e.code)) selectN(+e.code.slice(5));
    if (e.code === 'Enter' && !$('go').disabled) startGame();
    if (e.code === 'Escape') location.href = '../';
    return;
  }
  if (G.state === 'end') {
    if (e.code === 'Enter') startGame();
    if (e.code === 'Escape') toMenu();
    return;
  }
  if (e.code === 'Escape') { toMenu(); return; }
  if (G.state === 'ready' && (e.code === 'Enter' || e.code === 'Space')) { setState('countdown'); G.lastCount = null; return; }
  if (e.code === 'ArrowUp') G.sens = Math.max(.08, +(G.sens - .03).toFixed(2));
  if (e.code === 'ArrowDown') G.sens = Math.min(.38, +(G.sens + .03).toFixed(2));
  if (e.code === 'KeyC') G.showCam = !G.showCam;
  if (e.code === 'KeyF') fullscreen();
  if (e.code === 'KeyM') { if (BGM.playing) BGM.stop(true); else BGM.play(); }
  if (G.state === 'play' && CUR.onKey) CUR.onKey(e.code);
});

// ---------- Khởi động một trò ----------
function boot(game) {
  CUR = game;
  buildOverlays(game);
  document.title = game.title;
  $('mTitle').textContent = game.title;
  $('mDesc').innerHTML = game.desc;
  $('mExtra').innerHTML = game.menuExtra || '';
  $('mKeys').innerHTML = (game.keys ? game.keys + '<br>' : '') + '1/2 = số người · Enter = bắt đầu · ↑/↓ = độ nhạy · C = ẩn/hiện camera · M = nhạc · F = toàn màn hình · Esc = menu';
  document.querySelectorAll('#pcRow .btn').forEach(b => b.onclick = () => selectN(+b.dataset.n));
  // nhạc nền: chọn kiểu nào thì nghe thử luôn 3 giây
  const selB = () => document.querySelectorAll('#bgmRow .btn').forEach(b => b.classList.toggle('sel', b.dataset.b === BGM.mode));
  document.querySelectorAll('#bgmRow .btn').forEach(b => b.onclick = () => {
    if (b.dataset.b === 'file') { $('bgmFile').click(); return; }
    BGM.stop(); BGM.setMode(b.dataset.b); selB();
    if (BGM.mode === 'builtin') { BGM.play(game.tune || 'whack'); setTimeout(() => { if (G.state === 'menu') BGM.stop(); }, 3000); }
  });
  $('bgmFile').onchange = e => {
    const f = e.target.files[0]; if (!f) return;
    BGM.stop(); BGM.fileEl = new Audio(URL.createObjectURL(f)); BGM.fileEl.loop = true; BGM.setMode('file');
    $('bgmFileBtn').textContent = '📁 ' + (f.name.length > 22 ? f.name.slice(0, 20) + '…' : f.name); selB();
  };
  const selBg = () => document.querySelectorAll('#bgRow .btn').forEach(b => b.classList.toggle('sel', (b.dataset.bg === 'cam') === G.bgCam));
  document.querySelectorAll('#bgRow .btn').forEach(b => b.onclick = () => { G.bgCam = b.dataset.bg === 'cam'; store.set('kg_bg', b.dataset.bg); selBg(); });
  selBg();
  if (BGM.mode === 'file') BGM.setMode('builtin');   // file nhạc không giữ được qua lần tải trang
  selB();
  $('go').onclick = startGame;
  $('again').onclick = startGame;
  $('back').onclick = toMenu;
  if (game.camOff) G.showCam = false;
  game.menuInit && game.menuInit();
  selectN(store.get('kg_players', 1));
  game.reset(G.N);
  initCam();              // bật camera ngay để chọn menu bằng tay được
  requestAnimationFrame(loop);
}

// ---------- Khởi động trang chủ ----------
function bootHome(frame) {
  window.HOME_FRAME = frame;
  initCam();
  BGM.play('home');
  requestAnimationFrame(loop);
}
