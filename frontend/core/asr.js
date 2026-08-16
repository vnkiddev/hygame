// Cổng nhận diện: chạy đua 2 nguồn (SPEC §8).
//
//   1. Web Speech API của trình duyệt — ~200-500ms, kém chính xác
//   2. Thu PCM -> POST /api/recognize — chậm hơn, chính xác hơn nhiều
//
// Trình duyệt khớp đúng -> nhận ngay, KHÔNG chờ máy chủ (nhưng vẫn gửi audio
// đi để lưu log). Trình duyệt sai hoặc không có -> chờ máy chủ quyết.
// Máy chủ chết -> chạy tiếp bằng trình duyệt, bật chỉ báo offline.
//
// Game không bao giờ gọi thẳng vào file này — chúng gọi ctx.listen().

import * as audio from './audio.js';
import { log as logEvent } from './session.js';

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

export const state = {
  browserOK: !!SR,
  serverOK: true,       // tắt khi máy chủ không trả lời
  micOK: audio.supported(),
  captureOK: true,      // tắt nếu thu PCM song song không ăn thua (iOS cũ)
  lastSource: null,
};

let onOffline = null;
export function onOfflineChange(fn) { onOffline = fn; }

// Khi máy chủ chết, tự dò lại mỗi 10 giây. Không có cái này thì chỉ báo
// "offline" dính mãi cho tới lượt nghe tiếp theo — mà bé có thể đã bỏ đi.
let watchdog = null;

function setServerOK(ok) {
  if (state.serverOK !== ok) {
    state.serverOK = ok;
    if (onOffline) onOffline(!ok);
  }
  if (!ok && !watchdog) {
    watchdog = setInterval(async () => {
      try {
        const r = await fetch('/api/health', { cache: 'no-store' });
        if (r.ok) setServerOK(true);
      } catch (e) { /* vẫn chưa sống lại */ }
    }, 10000);
  } else if (ok && watchdog) {
    clearInterval(watchdog);
    watchdog = null;
  }
}

// --- chuẩn hoá & so khớp ----------------------------------------------------
export function norm(s) {
  return (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd').replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Đếm xem transcript nuốt được bao nhiêu chữ đầu của `seq` (trái sang phải). */
export function consume(transcript, seq, aliases = {}) {
  const toks = norm(transcript).split(' ').filter(Boolean);
  let si = 0;
  let ti = 0;
  while (ti < toks.length && si < seq.length) {
    const want = seq[si];
    const forms = [norm(want)].concat((aliases[want] || []).map(norm));
    // ứng viên nhiều chữ: thử ghép nhiều token liền nhau
    let matched = 0;
    for (const f of forms) {
      const parts = f.split(' ').filter(Boolean);
      if (!parts.length) continue;
      if (toks.slice(ti, ti + parts.length).join(' ') === f) { matched = parts.length; break; }
    }
    if (matched) { si++; ti += matched; } else ti++;
  }
  return si;
}

function bestBrowserMatch(alternatives, expected, sequence, aliases) {
  let advance = 0;
  let heard = alternatives[0] || '';
  const seq = sequence && sequence.length ? sequence : [expected];
  for (const alt of alternatives) {
    const n = consume(alt, seq, aliases);
    if (n > advance) { advance = n; heard = alt; }
  }
  return { advance, heard };
}

// --- nguồn 1: Web Speech API ------------------------------------------------
function listenBrowser(timeoutMs, hooks, lang) {
  return new Promise((resolve) => {
    if (!SR) { resolve({ ok: false, alternatives: [], error: 'unsupported' }); return; }
    let rec;
    let done = false;
    const finish = (r) => { if (!done) { done = true; resolve(r); } };
    try {
      rec = new SR();
      rec.lang = lang === 'en' ? 'en-US' : 'vi-VN';
      rec.continuous = false;      // Safari iOS: bật continuous là mic không tự tắt
      rec.interimResults = false;
      rec.maxAlternatives = 6;
      rec.onstart = () => hooks.onStart && hooks.onStart();
      rec.onerror = (e) => finish({ ok: false, alternatives: [], error: e.error });
      rec.onend = () => finish({ ok: false, alternatives: [], error: 'end' });
      rec.onresult = (e) => {
        const alts = [];
        for (let i = 0; i < e.results.length; i++) {
          for (let j = 0; j < e.results[i].length; j++) alts.push(e.results[i][j].transcript);
        }
        finish({ ok: true, alternatives: alts });
      };
      rec.start();
    } catch (err) {
      finish({ ok: false, alternatives: [], error: 'start-failed' });
    }
    setTimeout(() => { try { rec && rec.abort(); } catch (e) { /* đã dừng */ } finish({ ok: false, alternatives: [], error: 'timeout' }); },
      timeoutMs + 1500);
    hooks.abort = () => { try { rec && rec.abort(); } catch (e) { /* đã dừng */ } };
  });
}

// --- nguồn 2: máy chủ -------------------------------------------------------
async function askServer(wav, req, signal) {
  const fd = new FormData();
  fd.append('audio', wav, 'clip.wav');
  fd.append('candidates', JSON.stringify(req.candidates));
  fd.append('expected', req.expected || '');
  fd.append('kid_id', req.kidId || '');
  fd.append('game_id', req.gameId || '');
  fd.append('session_id', req.sessionId || '');
  fd.append('lang', req.lang || 'vi');
  if (req.partial) fd.append('partial', '1');
  const res = await fetch('/api/recognize', { method: 'POST', body: fd, signal });
  const data = await res.json().catch(() => ({}));
  // Máy chủ chưa có model -> trả 200 kèm cờ model_unavailable, vẫn lưu clip.
  // Máy chủ vẫn sống, nên KHÔNG coi là offline, chỉ là không có đường phụ.
  if (!res.ok || data.model_unavailable) return { unavailable: true, ...data };
  return data;
}

/**
 * Nghe một lượt.
 *
 * @param {object} o
 *  - candidates  {string[]} tập ứng viên đóng
 *  - expected    {string}   từ đang mong đợi
 *  - sequence    {string[]} (tuỳ chọn) chuỗi chữ còn lại, cho phép ăn nhiều chữ một lượt
 *  - aliases     {object}   cách đọc khác chấp nhận từ trình duyệt, vd {'mười lăm':['15']}
 *  - kid, gameId, sessionId, timeoutMs
 *  - onState(s)  'listening' | 'thinking'
 * @returns {Promise<object>} { ok, best, bestProb, margin, ranking, advance, heard, source }
 */
export async function listen(o) {
  const kid = o.kid || {};
  let earlyDone = false;
  const asrCfg = kid.asr || {};
  const threshold = asrCfg.threshold != null ? asrCfg.threshold : 0.45;
  const marginMin = asrCfg.margin != null ? asrCfg.margin : 0.12;
  const timeoutMs = o.timeoutMs || 5000;
  const seq = o.sequence && o.sequence.length ? o.sequence : [o.expected];
  const aliases = o.aliases || {};
  const lang = o.lang || 'vi';
  const t0 = performance.now();

  const hooks = { onStart: () => o.onState && o.onState('listening') };
  const browserP = listenBrowser(timeoutMs, hooks, lang);

  // --- chấm liên tục ------------------------------------------------------
  // Khoản trễ to nhất KHÔNG phải model mà là quãng ngồi đợi im lặng. Nên vừa
  // thu vừa gửi từng đoạn lên chấm thử; hễ từ mong đợi vượt ngưỡng là nhận
  // ngay, không đợi bé nói xong. Đây là mẹo của Duolingo, chỉ khác là chấm ở
  // máy nhà chứ không phải ở thiết bị.
  let earlyResolve = null;
  const earlyP = new Promise((res) => { earlyResolve = res; });
  let inFlight = false;      // không xếp hàng chồng chất trên con i3
  let partialCount = 0;

  const onPartial = async (wavBlob, atMs) => {
    if (inFlight || !state.serverOK || earlyDone) return;
    inFlight = true;
    partialCount += 1;
    try {
      const d = await askServer(wavBlob, {
        candidates: o.candidates, expected: o.expected, kidId: kid.id,
        gameId: o.gameId, sessionId: o.sessionId, lang, partial: 1,
      });
      if (d && !d.unavailable && !earlyDone
          && d.best === o.expected && d.best_prob >= threshold && d.margin >= marginMin) {
        earlyDone = true;
        audio.stopRecording();     // chốt sớm, khỏi đợi hết im lặng
        earlyResolve({ data: d, atMs });
      }
    } catch (e) {
      // partial hỏng thì kệ, bản đầy đủ ở cuối vẫn chạy
    } finally {
      inFlight = false;
    }
  };

  // Thu PCM song song để gửi máy chủ.
  let recP = null;
  if (state.micOK && state.captureOK) {
    recP = audio.record({
      silenceMs: o.silenceMs || 700,
      maxMs: timeoutMs,
      onLevel: o.onLevel,
      onPartial: o.stream === false ? null : onPartial,
      partialMs: o.partialMs || 350,
    }).catch((e) => { state.micOK = false; return null; });
  }
  if (!SR) o.onState && o.onState('listening');

  // Cuộc đua bắt đầu.
  const serverBox = { promise: null, controller: null, settled: undefined };
  const startServer = async () => {
    if (!recP) return null;
    const rec = await recP;
    if (!rec) return null;
    if (!rec.gotSpeech && rec.reason === 'no-speech') return { silent: true, rec };
    o.onState && o.onState('thinking');
    serverBox.controller = new AbortController();
    try {
      const data = await askServer(rec.wav, {
        candidates: o.candidates, expected: o.expected, kidId: kid.id,
        gameId: o.gameId, sessionId: o.sessionId, lang,
      }, serverBox.controller.signal);
      if (!data.unavailable) setServerOK(true);
      return { data, rec };
    } catch (e) {
      if (e.name === 'AbortError') return { aborted: true, rec };
      setServerOK(false);
      return { failed: true, rec };
    }
  };
  serverBox.promise = startServer();

  // 1. Ai xong trước: trình duyệt, hay một lượt chấm từng phần vượt ngưỡng.
  // Trình duyệt trả lời trước, nhưng "không hỗ trợ" thì resolve NGAY lập tức.
  // Nếu để nó quyết cuộc đua thì vòng chấm liên tục không bao giờ kịp chạy —
  // nên chỉ nhận khi trình duyệt thật sự KHỚP, còn lại thì đua tiếp.
  const br = await browserP;
  const bm = br.ok ? bestBrowserMatch(br.alternatives, o.expected, seq, aliases)
    : { advance: 0, heard: '' };

  if (bm.advance === 0) {
    hooks.abort && hooks.abort();
  }

  if (bm.advance === 0) {
    // Đua giữa: một lượt chấm từng phần vượt ngưỡng, và bản đầy đủ cuối lượt.
    const winner = await Promise.race([
      earlyP.then((e) => ({ early: e })),
      serverBox.promise.then((s) => ({ full: s })),
    ]);
    if (winner.early) return acceptEarly(winner.early);
    serverBox.settled = winner.full;
  }

  function acceptEarly(e) {
    const d = e.data;
    state.lastSource = 'server-stream';
    // Vẫn để bản đầy đủ chạy nốt ở nền để lưu clip và ghi attempts —
    // audio của bọn trẻ là thứ quý nhất, đừng vì nhận sớm mà vứt đi.
    serverBox.promise.catch(() => {});
    const out = {
      ok: true, best: d.best, bestProb: d.best_prob, margin: d.margin,
      ranking: d.ranking || [], advance: 1, heard: d.best, source: 'server-stream',
      partials: partialCount, elapsedMs: Math.round(performance.now() - t0),
    };
    logEvent('decision', {
      expected: o.expected, best: d.best, best_prob: d.best_prob,
      margin: d.margin, accepted: 1, source: 'server-stream',
      partials: partialCount, at_ms: e.atMs, compute_ms: d.compute_ms,
    }, { gameId: o.gameId });
    return out;
  }

  if (bm.advance > 0) {
    // Vẫn để request máy chủ chạy nốt cho đủ dữ liệu, chỉ không chờ nữa.
    serverBox.promise.then((s) => {
      if (s && s.rec && !s.data) return;
    }).catch(() => {});
    state.lastSource = 'browser';
    const out = {
      ok: true, best: seq[bm.advance - 1], bestProb: 1, margin: 1, ranking: [],
      advance: bm.advance, heard: bm.heard, source: 'browser',
      elapsedMs: Math.round(performance.now() - t0),
    };
    logEvent('attempt', {
      expected: o.expected, best: out.best, best_prob: 1, margin: 1, accepted: 1,
      source: 'browser', audio_ms: null, compute_ms: out.elapsedMs, clip_path: null,
    }, { gameId: o.gameId });
    return out;
  }

  // 2. Trình duyệt sai/câm, cũng không có lượt partial nào vượt ngưỡng
  //    -> lấy kết quả bản đầy đủ (đã chờ xong ở vòng đua trên).
  const s = serverBox.settled !== undefined ? serverBox.settled : await serverBox.promise;

  if (!s || s.silent) {
    return {
      ok: false, best: null, bestProb: 0, margin: 0, ranking: [], advance: 0,
      heard: bm.heard, source: 'none', silent: true,
      elapsedMs: Math.round(performance.now() - t0),
    };
  }

  if (s.failed || s.aborted || !s.data || s.data.unavailable) {
    // Máy chủ không dùng được -> chỉ còn trình duyệt, mà trình duyệt đã sai.
    return {
      ok: false, best: null, bestProb: 0, margin: 0, ranking: [], advance: 0,
      heard: bm.heard, source: 'browser', degraded: true,
      elapsedMs: Math.round(performance.now() - t0),
    };
  }

  const d = s.data;
  const accepted = d.best === o.expected && d.best_prob >= threshold && d.margin >= marginMin;
  state.lastSource = 'server';
  // Máy chủ đã tự ghi attempt của lượt này, ở đây chỉ ghi quyết định cuối.
  logEvent('decision', {
    expected: o.expected, best: d.best, best_prob: d.best_prob, margin: d.margin,
    accepted: accepted ? 1 : 0, threshold, margin_min: marginMin,
    compute_ms: d.compute_ms, clip_id: d.clip_id,
  }, { gameId: o.gameId });

  return {
    ok: accepted,
    best: d.best,
    bestProb: d.best_prob,
    margin: d.margin,
    ranking: d.ranking || [],
    advance: accepted ? 1 : 0,
    heard: d.best || bm.heard,
    source: 'server',
    clipId: d.clip_id,
    computeMs: d.compute_ms,
    elapsedMs: Math.round(performance.now() - t0),
  };
}

export function abort() {
  audio.stopRecording();
}

export async function pingServer() {
  try {
    const r = await fetch('/api/health', { cache: 'no-store' });
    const d = await r.json();
    setServerOK(true);
    return d;
  } catch (e) {
    setServerOK(false);
    return null;
  }
}
