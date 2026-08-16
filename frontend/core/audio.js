// Thu âm + VAD phía client + đóng gói WAV 16kHz.
//
// Vì sao tự thu PCM thay vì dùng MediaRecorder:
//   - MediaRecorder trên iOS Safari cho ra mp4/aac, Chrome cho webm/opus.
//     Máy chủ i3 sẽ phải gọi ffmpeg giải mã mỗi lượt -> tốn CPU quý giá.
//   - Có sẵn mẫu PCM thì VAD phía client dùng luôn chính mẫu đó, không phải
//     đoán qua analyser.
// Đổi lại ta gửi WAV to hơn, nhưng trong LAN thì không đáng kể.

import { audioCtx } from './ui.js';

const TARGET_SR = 16000;

let stream = null;      // giữ nguyên một stream cho cả phiên -> iOS chỉ hỏi
let source = null;      // quyền micro đúng một lần
let processor = null;
let sink = null;
let active = null;      // lượt thu đang chạy

export function supported() {
  return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia
    && (window.AudioContext || window.webkitAudioContext));
}

export async function ensureMic() {
  if (!supported()) throw new Error('Máy này không thu âm được');
  const ctx = audioCtx();
  if (!ctx) throw new Error('Không mở được AudioContext');
  if (ctx.state === 'suspended') await ctx.resume();
  if (stream && stream.active) return ctx;

  stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });
  source = ctx.createMediaStreamSource(stream);
  const bufSize = 2048;
  processor = (ctx.createScriptProcessor || ctx.createJavaScriptNode).call(ctx, bufSize, 1, 1);
  processor.onaudioprocess = (e) => {
    if (!active) return;
    feed(e.inputBuffer.getChannelData(0), ctx.sampleRate);
  };
  // Nối qua gain 0 vì vài trình duyệt không chạy ScriptProcessor nếu nó
  // không nằm trên đường tới destination. Gain 0 để không vọng tiếng.
  sink = ctx.createGain();
  sink.gain.value = 0;
  source.connect(processor);
  processor.connect(sink);
  sink.connect(ctx.destination);
  return ctx;
}

export function micReady() {
  return !!(stream && stream.active);
}

function feed(chunk, sr) {
  const a = active;
  if (!a) return;
  a.chunks.push(new Float32Array(chunk));
  a.samples += chunk.length;
  a.sampleRate = sr;

  // RMS của khung này -> VAD
  let sum = 0;
  for (let i = 0; i < chunk.length; i++) sum += chunk[i] * chunk[i];
  const rms = Math.sqrt(sum / chunk.length);
  const ms = (chunk.length / sr) * 1000;
  a.elapsed += ms;
  a.peak = Math.max(a.peak, rms);
  if (a.onLevel) a.onLevel(Math.min(1, rms * 8));

  // Ngưỡng động: nền ồn đo trong 300ms đầu, tiếng nói phải vượt hẳn nền.
  if (a.elapsed < 300) {
    a.noise = a.noise ? a.noise * 0.8 + rms * 0.2 : rms;
    return;
  }
  const thr = Math.max(0.012, (a.noise || 0.005) * 3.2);
  if (rms > thr) {
    a.voiced += ms;
    a.silence = 0;
    if (a.voiced > 120) a.gotSpeech = true;
  } else {
    a.silence += ms;
  }

  if (a.gotSpeech && a.silence >= a.silenceMs) finish('silence');
  else if (a.elapsed >= a.maxMs) finish(a.gotSpeech ? 'maxlen' : 'no-speech');
  else maybePartial(a);
}

// Chấm liên tục: cứ mỗi `partialMs` lại đưa ra bản chụp audio TỪ ĐẦU tới
// giờ để máy chủ chấm thử. Nhờ vậy bé đọc rõ là được chấp nhận NGAY trong
// lúc còn đang nói, khỏi phải đợi hết 700ms im lặng rồi mới bắt đầu tính.
function maybePartial(a) {
  if (!a.onPartial || !a.gotSpeech) return;
  if (a.elapsed < a.partialMinMs) return;
  if (a.elapsed - a.lastPartial < a.partialMs) return;
  a.lastPartial = a.elapsed;
  a.onPartial(snapshot(a), a.elapsed);
}

/** Bản chụp audio đã thu tới thời điểm này, đóng gói WAV 16k. */
function snapshot(a) {
  const pcm = merge(a.chunks, a.samples);
  return encodeWav(resample(pcm, a.sampleRate || TARGET_SR, TARGET_SR), TARGET_SR);
}

function finish(reason) {
  const a = active;
  if (!a || a.done) return;
  a.done = true;
  active = null;
  const pcm = merge(a.chunks, a.samples);
  const down = resample(pcm, a.sampleRate || TARGET_SR, TARGET_SR);
  a.resolve({
    reason,
    ms: Math.round((down.length / TARGET_SR) * 1000),
    gotSpeech: a.gotSpeech,
    peak: a.peak,
    samples: down,
    wav: encodeWav(down, TARGET_SR),
  });
}

/**
 * Thu một lượt. Tự dừng sau `silenceMs` im lặng, hoặc `maxMs` cứng.
 * @returns {Promise<{wav:Blob, samples:Float32Array, ms:number, reason:string, gotSpeech:boolean}>}
 */
export async function record(opts = {}) {
  const {
    silenceMs = 700, maxMs = 5000, onLevel = null,
    onPartial = null, partialMs = 350, partialMinMs = 450,
  } = opts;
  await ensureMic();
  if (active) stopRecording();
  return new Promise((resolve) => {
    active = {
      chunks: [], samples: 0, sampleRate: TARGET_SR, elapsed: 0, voiced: 0,
      silence: 0, peak: 0, noise: 0, gotSpeech: false, done: false,
      silenceMs, maxMs, onLevel, resolve,
      onPartial, partialMs, partialMinMs, lastPartial: 0,
    };
  });
}

export function stopRecording() {
  if (active) finish('manual');
}

export function releaseMic() {
  stopRecording();
  try { if (processor) processor.disconnect(); } catch (e) { /* đã ngắt */ }
  try { if (source) source.disconnect(); } catch (e) { /* đã ngắt */ }
  try { if (sink) sink.disconnect(); } catch (e) { /* đã ngắt */ }
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = source = processor = sink = null;
}

// --- xử lý mẫu --------------------------------------------------------------
function merge(chunks, total) {
  const out = new Float32Array(total);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

function resample(x, src, dst) {
  if (src === dst || x.length === 0) return x;
  const n = Math.round((x.length * dst) / src);
  const out = new Float32Array(n);
  const step = (x.length - 1) / Math.max(1, n - 1);
  for (let i = 0; i < n; i++) {
    const p = i * step;
    const j = Math.floor(p);
    const f = p - j;
    out[i] = j + 1 < x.length ? x[j] * (1 - f) + x[j + 1] * f : x[j];
  }
  return out;
}

function encodeWav(x, sr) {
  const buf = new ArrayBuffer(44 + x.length * 2);
  const v = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + x.length * 2, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true);
  v.setUint16(22, 1, true); v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true);
  v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, x.length * 2, true);
  let o = 44;
  for (let i = 0; i < x.length; i++, o += 2) {
    const s = Math.max(-1, Math.min(1, x[i]));
    v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buf], { type: 'audio/wav' });
}
