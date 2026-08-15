// Dò và nạp game module.
//
// Trình duyệt không liệt kê được thư mục, nên danh sách nằm ở
// games/index.json (một mảng id). Thêm game = thả thư mục + thêm 1 dòng.
// KHÔNG sửa file lõi nào.

const cache = new Map();

export async function listGames() {
  let ids = [];
  try {
    const r = await fetch('games/index.json', { cache: 'no-store' });
    ids = await r.json();
  } catch (e) {
    console.warn('Không đọc được games/index.json', e);
    return [];
  }
  const manifests = await Promise.all(ids.map(loadManifest));
  return manifests.filter(Boolean);
}

async function loadManifest(id) {
  try {
    const r = await fetch(`games/${id}/manifest.json`, { cache: 'no-store' });
    if (!r.ok) throw new Error(r.status);
    const m = await r.json();
    m.id = m.id || id;
    m.dir = `games/${id}`;
    return m;
  } catch (e) {
    console.warn(`Bỏ qua game "${id}": không đọc được manifest`, e);
    return null;
  }
}

/** Nạp module game (kèm style riêng nếu có). Chỉ nạp một lần. */
export async function loadGame(manifest) {
  if (cache.has(manifest.id)) return cache.get(manifest.id);
  // Nạp style riêng chỉ khi manifest khai báo "style": true. Không đoán mò
  // rồi để trình duyệt kêu 404 đỏ lòm trong console.
  if (manifest.style) injectStyle(manifest);
  const mod = await import(`../${manifest.dir}/game.js`);
  const game = mod.default;
  if (!game || typeof game.setup !== 'function') {
    throw new Error(`Game "${manifest.id}" thiếu export default { setup }`);
  }
  game.manifest = manifest;
  cache.set(manifest.id, game);
  return game;
}

function injectStyle(manifest) {
  const href = `${manifest.dir}/style.css`;
  if (document.querySelector(`link[href="${href}"]`)) return;
  const l = document.createElement('link');
  l.rel = 'stylesheet';
  l.href = href;
  document.head.appendChild(l);
}

/** Game có hợp với bé này không: bật trong hồ sơ + đủ tuổi. */
export function enabledFor(manifest, kid) {
  const cfg = (kid.games || {})[manifest.id];
  if (cfg && cfg.enabled === false) return false;
  if (manifest.min_age && kid.age && kid.age < manifest.min_age) return false;
  return true;
}
