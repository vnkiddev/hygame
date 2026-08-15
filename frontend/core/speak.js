// TTS tiếng Việt. Web Speech Synthesis có nhiều bug ở Safari iOS
// (onend không bắn), nên luôn có hẹn giờ dự phòng để không kẹt Promise.

let viVoice = null;

function pickVoice() {
  if (!window.speechSynthesis) return;
  const vs = speechSynthesis.getVoices() || [];
  viVoice = vs.find((v) => /^vi/i.test(v.lang)) || null;
}

if (window.speechSynthesis) {
  pickVoice();
  speechSynthesis.onvoiceschanged = pickVoice;
}

export function hasVoice() { return !!viVoice; }

export function cancelSpeech() {
  try { speechSynthesis.cancel(); } catch (e) { /* không có TTS */ }
}

/**
 * Đọc `text` bằng giọng Việt.
 * @returns {Promise<void>} luôn resolve, không bao giờ reject hay treo.
 */
export function speak(text, opts = {}) {
  const { rate = 0.8, pitch = 1.1, interrupt = true } = opts;
  return new Promise((resolve) => {
    if (!window.speechSynthesis || !text) { setTimeout(resolve, 200); return; }
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    try {
      if (interrupt) speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(String(text));
      u.lang = 'vi-VN';
      u.rate = rate;
      u.pitch = pitch;
      if (viVoice) u.voice = viVoice;
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
