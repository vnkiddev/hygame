// Trạng thái phiên chơi + gửi log theo lô.
// Trạng thái quan trọng nằm ở máy chủ, localStorage chỉ để nhớ bé vừa chơi.

const LS_KEY = 'kidsapp.lastKid';

export const session = {
  id: null,
  kidId: null,
  gameId: null,
  startedAt: 0,
};

let queue = [];
let flushTimer = null;

function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

export function start(kidId, gameId) {
  session.id = uuid();
  session.kidId = kidId;
  session.gameId = gameId;
  session.startedAt = Date.now();
  log('session_start', { game: gameId });
  return session.id;
}

export async function end() {
  if (!session.id) return;
  log('session_end', { ms: Date.now() - session.startedAt });
  const id = session.id;
  await flush();
  try {
    await fetch(`/api/session/${id}/end`, { method: 'POST', keepalive: true });
  } catch (e) { /* máy chủ không tới được — không sao, log sẽ mất */ }
  session.id = null;
}

/** Ghi một sự kiện. Gộp lô, tự gửi mỗi 10 sự kiện hoặc sau 8 giây. */
export function log(type, payload = {}, opts = {}) {
  queue.push({
    type,
    payload,
    session_id: session.id,
    kid_id: opts.kidId || session.kidId,
    game_id: opts.gameId || session.gameId,
    at: Date.now(),
  });
  if (queue.length >= 10) flush();
  else if (!flushTimer) flushTimer = setTimeout(flush, 8000);
}

export async function flush() {
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  if (!queue.length) return;
  const batch = queue;
  queue = [];
  try {
    await fetch('/api/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ events: batch }),
      keepalive: true,
    });
  } catch (e) {
    // Máy chủ chết: giữ lại tối đa 200 sự kiện để gửi sau, không phình bộ nhớ.
    queue = batch.concat(queue).slice(-200);
  }
}

window.addEventListener('pagehide', () => { flush(); });
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') flush();
});

export function rememberKid(id) {
  try { localStorage.setItem(LS_KEY, id); } catch (e) { /* chế độ riêng tư */ }
}

export function lastKid() {
  try { return localStorage.getItem(LS_KEY); } catch (e) { return null; }
}
