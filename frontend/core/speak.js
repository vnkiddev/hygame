// TTS tiếng Việt. Web Speech Synthesis có nhiều bug ở Safari iOS
// (onend không bắn), nên luôn có hẹn giờ dự phòng để không kẹt Promise.

const voices = { vi: null, en: null };

function pickVoice() {
  if (!window.speechSynthesis) return;
  const vs = speechSynthesis.getVoices() || [];
  voices.vi = vs.find((v) => /^vi/i.test(v.lang)) || null;
  // Ưu tiên giọng en-US/en-GB, tránh vớ phải en-IN nghe lạ tai với trẻ.
  voices.en = vs.find((v) => /^en[-_](US|GB)/i.test(v.lang))
    || vs.find((v) => /^en/i.test(v.lang)) || null;
}

if (window.speechSynthesis) {
  pickVoice();
  speechSynthesis.onvoiceschanged = pickVoice;
}

export function hasVoice(lang) { return !!voices[lang === 'en' ? 'en' : 'vi']; }

export function cancelSpeech() {
  try { speechSynthesis.cancel(); } catch (e) { /* không có TTS */ }
}

/**
 * Đọc `text` bằng giọng Việt.
 * @returns {Promise<void>} luôn resolve, không bao giờ reject hay treo.
 */
export function speak(text, opts = {}) {
  const { rate = 0.8, pitch = 1.1, interrupt = true, lang = 'vi' } = opts;
  const isEn = lang === 'en';
  return new Promise((resolve) => {
    if (!window.speechSynthesis || !text) { setTimeout(resolve, 200); return; }
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    try {
      if (interrupt) speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(String(text));
      u.lang = isEn ? 'en-US' : 'vi-VN';
      u.rate = rate;
      u.pitch = pitch;
      const v = voices[isEn ? 'en' : 'vi'];
      if (v) u.voice = v;
      u.onend = finish;
      u.onerror = finish;
      speechSynthesis.speak(u);
      // Dự phòng: ước lượng thời lượng theo độ dài câu.
      setTimeout(finish, 500 + String(text).length * 140 / Math.max(0.5, rate));
    } catch (e) {
      finish();
    }
  });
}
