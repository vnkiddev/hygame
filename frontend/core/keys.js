// Điều khiển bằng bàn phím và ĐIỀU KHIỂN TIVI (D-pad).
//
// Vì sao cần file này: trên Android TV (Coocaa, Xiaomi...) không có chuột,
// không có mic dùng được, chỉ có 4 phím mũi tên + OK + Back. Mỗi hãng lại
// trả về mã phím một kiểu — có máy trả `e.key`, có máy chỉ trả `e.keyCode`,
// Tizen/webOS còn có mã Back riêng. Quy hết về 6 tên ở đây, phần còn lại
// của ứng dụng không phải biết máy nào ra máy nào.

const BY_KEY = {
  ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down',
  // Tên cũ của IE/Edge và vài trình duyệt TV đời đầu
  Left: 'left', Right: 'right', Up: 'up', Down: 'down',
  Enter: 'ok', ' ': 'ok', Spacebar: 'ok', Select: 'ok', Accept: 'ok',
  Escape: 'back', Esc: 'back', Backspace: 'back', BrowserBack: 'back', GoBack: 'back',
};

const BY_CODE = {
  37: 'left', 38: 'up', 39: 'right', 40: 'down',
  13: 'ok', 32: 'ok', 23: 'ok',   // 23 = DPAD_CENTER trong WebView Android
  27: 'back', 8: 'back', 4: 'back',   // 4 = KEYCODE_BACK của Android
  10009: 'back',                      // Samsung Tizen
  461: 'back',                        // LG webOS
};

/** Tên phím đã quy chuẩn: left | right | up | down | ok | back | null. */
export function keyName(e) {
  if (e.altKey || e.ctrlKey || e.metaKey) return null;
  return BY_KEY[e.key] || BY_CODE[e.keyCode || e.which] || null;
}

// Một lần bấm phím chỉ được một chỗ xử lý.
//
// Bẫy đã sập một lần: bấm OK chọn bé -> màn chọn trò hiện ra NGAY trong lúc
// sự kiện keydown còn đang chạy -> con trỏ của màn chọn trò thấy mình vừa
// được bật, cũng nhận luôn phím OK đó và mở đại trò đầu tiên. Đánh dấu sự
// kiện đã dùng rồi thì mọi listener sau tự tránh.
const USED = '__kidsKeyUsed';
const used = (e) => e[USED] === true;
const useUp = (e) => { e[USED] = true; };

/** Có đang gõ vào ô nhập liệu không — đừng cướp phím của người ta. */
function typing() {
  const a = document.activeElement;
  if (!a) return false;
  return /^(input|textarea|select)$/i.test(a.tagName) || a.isContentEditable;
}

/**
 * Con trỏ chạy trên một dãy nút: mũi tên để đi, OK để bấm.
 *
 * Không tự dò DOM — gọi `setItems()` mỗi khi vẽ lại danh sách. Nút đang chọn
 * được `focus()` và gắn class `sel` (TV cũ không có `:focus-visible`, phải
 * có class thì mới tô viền được).
 *
 * @param {object} o
 * @param {() => boolean} [o.enabled]  chỉ nhận phím khi hàm này trả true
 * @param {'x'|'y'|'both'} [o.axis]    trục di chuyển, mặc định 'both'
 * @param {(el, i) => void} [o.onPick] OK/click; mặc định gọi el.click()
 * @param {(name, e) => boolean} [o.onKey] chặn trước; trả true = đã xử lý xong
 */
export function roving(o = {}) {
  const axis = o.axis || 'both';
  let items = [];
  let idx = 0;

  const usable = (el) => el && !el.disabled && el.getAttribute('aria-hidden') !== 'true';

  function paint() {
    items.forEach((el, i) => el.classList.toggle('sel', i === idx));
    const el = items[idx];
    if (el) {
      try { el.focus({ preventScroll: true }); } catch (e) { el.focus(); }
      if (el.scrollIntoView) el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
  }

  /** Chọn ô thứ `i`; ô đang tắt thì trượt tiếp theo hướng `dir`. */
  function select(i, dir) {
    if (!items.length) return;
    const step = dir || 1;
    let n = ((i % items.length) + items.length) % items.length;
    for (let k = 0; k < items.length; k++) {
      if (usable(items[n])) break;
      n = ((n + step) % items.length + items.length) % items.length;
    }
    idx = n;
    paint();
  }

  function move(dir) {
    if (!items.length) return;
    select(idx + dir, dir);
  }

  function pick() {
    const el = items[idx];
    if (!usable(el)) return;
    if (o.onPick) o.onPick(el, idx);
    else el.click();
  }

  function handler(e) {
    if (used(e) || typing()) return;
    if (o.enabled && !o.enabled()) return;
    const k = keyName(e);
    if (!k) return;
    const done = () => { useUp(e); e.preventDefault(); };
    if (o.onKey && o.onKey(k, e) === true) { done(); return; }
    const prev = k === 'left' || (axis !== 'x' && k === 'up');
    const next = k === 'right' || (axis !== 'x' && k === 'down');
    if (axis === 'y' && (k === 'left' || k === 'right')) return;
    if (prev || next) { move(next ? 1 : -1); done(); return; }
    // Đánh dấu TRƯỚC khi bấm: cú bấm hay làm màn hình đổi, mà màn hình mới
    // cũng có con trỏ đang nghe cùng sự kiện này.
    if (k === 'ok') { done(); pick(); }
    // 'back' cố tình để lọt xuống dưới — vỏ ứng dụng lo việc quay lui.
  }

  document.addEventListener('keydown', handler);

  return {
    /** Gán lại dãy nút sau mỗi lần vẽ. Giữ nguyên ô đang chọn nếu còn hợp lệ. */
    setItems(list, startAt) {
      items = Array.from(list || []);
      items.forEach((el, i) => {
        if (el.tabIndex < 0) el.tabIndex = 0;
        // Bấm chuột cũng phải kéo con trỏ theo, không thì bấm xong ấn mũi tên
        // lại nhảy về chỗ cũ.
        el.addEventListener('pointerdown', () => { idx = i; paint(); });
      });
      idx = 0;
      if (items.length) select(startAt || 0, 1);
    },
    select: (i) => select(i, 1),
    index: () => idx,
    focus: () => paint(),
    detach() { document.removeEventListener('keydown', handler); items = []; },
  };
}

/** Nghe riêng một phím (dùng cho nút Back ở vỏ ứng dụng). */
export function onKey(fn) {
  const h = (e) => {
    if (used(e) || typing()) return;
    const k = keyName(e);
    if (k && fn(k, e) === true) { useUp(e); e.preventDefault(); }
  };
  document.addEventListener('keydown', h);
  return () => document.removeEventListener('keydown', h);
}
