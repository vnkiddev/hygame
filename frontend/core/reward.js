// Sao + video thưởng.
// Game chỉ gọi ctx.star(); đủ số sao thì lõi tự lo phần chiếu video.

import { $, sfx, unlockMedia } from './ui.js';
import { speak } from './speak.js';

let starsEl = null;
let count = 0;
let goal = 3;

export function mount(container, starsNeeded) {
  goal = Math.max(1, starsNeeded || 3);
  count = 0;
  starsEl = container;
  paint();
}

export function reset() { count = 0; paint(); }
export function stars() { return count; }
export function goalCount() { return goal; }

function paint() {
  if (!starsEl) return;
  starsEl.innerHTML = '';
  for (let i = 0; i < goal; i++) {
    const s = document.createElement('span');
    s.textContent = '⭐';
    if (i < count) s.className = 'on';
    starsEl.appendChild(s);
  }
}

/** Cộng 1 sao. Trả về true nếu vừa đủ số sao để nhận thưởng. */
export function addStar() {
  count = Math.min(goal, count + 1);
  paint();
  sfx.ding();
  return count >= goal;
}

/** Lấy video thưởng của bé từ máy chủ (ngẫu nhiên, không lặp video vừa chiếu). */
export async function fetchReward(kidId) {
  try {
    const r = await fetch(`/api/kids/${encodeURIComponent(kidId)}/reward`, { cache: 'no-store' });
    if (!r.ok) return null;
    const d = await r.json();
    return d.url ? d : null;
  } catch (e) {
    return null;
  }
}

/**
 * Chiếu màn thưởng. Trả về Promise resolve khi bé bấm "Chơi tiếp".
 * Không có video nào -> vẫn có màn khen bằng sọc công trường + emoji.
 */
export async function celebrate(kid, opts = {}) {
  const win = $('win');
  const vid = $('vid');
  const praise = $('praise');
  const again = $('again');
  const fallback = $('winFallback');
  const text = (kid.praise || '{name} giỏi quá!').replace('{name}', kid.name || '');

  unlockMedia(vid);
  praise.textContent = text;
  again.textContent = opts.againLabel || 'Chơi tiếp';
  again.classList.remove('show');
  win.classList.add('on');
  sfx.fanfare();

  const showFallback = () => {
    vid.removeAttribute('src');
    vid.style.display = 'none';
    fallback.style.display = 'flex';
    fallback.textContent = kid.avatar || '🎉';
  };

  const reward = await fetchReward(kid.id);
  if (reward && reward.url) {
    fallback.style.display = 'none';
    vid.style.display = '';
    // File hỏng hoặc định dạng máy không mở được -> rơi về màn khen,
    // tuyệt đối không để bé nhìn màn hình đen.
    vid.onerror = () => { console.warn('Không mở được video thưởng', reward.url); showFallback(); };
    vid.src = reward.url;
    vid.currentTime = 0;
    vid.volume = 0.55;
    vid.muted = false;
    try {
      const p = vid.play();
      if (p && p.catch) {
        p.catch(() => {
          // iOS chặn phát có tiếng -> thử lại câm; vẫn hỏng thì màn khen.
          vid.muted = true;
          vid.play().catch(showFallback);
        });
      }
    } catch (e) { showFallback(); }
  } else {
    showFallback();
  }

  setTimeout(() => speak(text, { rate: kid.tts_rate || 0.8 }), 900);
  // Hiện nút "Chơi tiếp" và ĐƯA CON TRỎ VÀO nó — trên tivi không có chuột,
  // không focus thì bé bấm OK cũng không có gì xảy ra.
  const showAgain = () => {
    again.classList.add('show');
    try { again.focus({ preventScroll: true }); } catch (e) { /* trình duyệt cũ */ }
  };
  const timer = setTimeout(showAgain, 2500);
  vid.onended = showAgain;

  await new Promise((resolve) => {
    again.onclick = () => {
      clearTimeout(timer);
      try { vid.pause(); } catch (e) { /* không có video */ }
      win.classList.remove('on');
      again.onclick = null;
      vid.onended = null;
      resolve();
    };
  });
  count = 0;
  paint();
}
