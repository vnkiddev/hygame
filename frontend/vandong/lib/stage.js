// Sân khấu webcam dùng chung cho mọi trò vận động.
//
// Một canvas phủ kín màn hình; video webcam được vẽ lật gương (bé giơ tay
// phải thì thấy tay bên phải) và cắt kiểu "cover". Mọi toạ độ game đưa ra/nhận
// vào đều là pixel MÀN HÌNH — stage tự lo phép đổi sang toạ độ video.
//
// Ba chế độ, tự rơi xuống khi chế độ trên không chạy được:
//   pose   — MediaPipe Pose: biết cổ tay, hông của từng người (tối đa `people`)
//   motion — chỉ có camera, không tải được mô hình: biết "chỗ nào đang cử động"
//   mouse  — không có camera: con trỏ chuột/ngón tay đóng vai một người
// Thêm ?mouse vào URL để ép chế độ chuột (thử trên máy không có webcam).

const MP_VER = '0.10.14';
const MP_URL = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VER}`;
const MODEL = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task';

// Chỉ số điểm mốc MediaPipe Pose
const L = { nose: 0, lWrist: 15, rWrist: 16, lIndex: 19, rIndex: 20, lHip: 23, rHip: 24, lAnkle: 27, rAnkle: 28 };

const MW = 160, MH = 120;   // lưới phát hiện cử động — nhỏ cho máy i3

export async function createStage(canvas, { people = 2, onStatus = () => {} } = {}) {
  const ctx = canvas.getContext('2d');
  const video = document.createElement('video');
  video.playsInline = true;
  video.muted = true;
  video.setAttribute('playsinline', '');

  const st = {
    mode: 'mouse',
    canvas, ctx, video,
    W: 0, H: 0,
    persons: [],          // [{ hands:[{x,y}], body:{x,y}, head:{x,y} }]
    pointer: null,        // {x,y} chuột/ngón tay
  };

  // --- kích thước -----------------------------------------------------------
  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    st.W = window.innerWidth;
    st.H = window.innerHeight;
    canvas.width = Math.round(st.W * dpr);
    canvas.height = Math.round(st.H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  resize();
  window.addEventListener('resize', resize);

  // --- con trỏ (luôn bật, kể cả khi có camera — tiện cho bố mẹ thử) ---------
  const setPtr = (e) => { st.pointer = { x: e.clientX, y: e.clientY, t: performance.now() }; };
  canvas.addEventListener('pointermove', setPtr);
  canvas.addEventListener('pointerdown', setPtr);
  canvas.addEventListener('pointerleave', () => { st.pointer = null; });

  // --- camera ---------------------------------------------------------------
  const forceMouse = new URLSearchParams(location.search).has('mouse');
  if (!forceMouse && navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
    try {
      onStatus('Đang mở camera…');
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' },
        audio: false,
      });
      video.srcObject = stream;
      await video.play();
      st.mode = 'motion';
      st.stream = stream;
    } catch (e) {
      console.warn('Không mở được camera', e);
    }
  }

  // --- mô hình dáng người ---------------------------------------------------
  let landmarker = null;
  if (st.mode === 'motion') {
    try {
      onStatus('Đang tải bộ nhận dáng người…');
      const vision = await import(`${MP_URL}/vision_bundle.mjs`);
      const files = await vision.FilesetResolver.forVisionTasks(`${MP_URL}/wasm`);
      const make = (delegate) => vision.PoseLandmarker.createFromOptions(files, {
        baseOptions: { modelAssetPath: MODEL, delegate },
        runningMode: 'VIDEO',
        numPoses: people,
        minPoseDetectionConfidence: 0.5,
        minPosePresenceConfidence: 0.5,
        minTrackingConfidence: 0.5,
      });
      try { landmarker = await make('GPU'); } catch (e) { landmarker = await make('CPU'); }
      st.mode = 'pose';
    } catch (e) {
      console.warn('Không tải được MediaPipe — chuyển sang dò cử động', e);
    }
  }
  onStatus('');

  // --- phép đổi toạ độ (video chuẩn hoá u,v  <->  màn hình) ------------------
  function cover() {
    const vw = video.videoWidth || 16, vh = video.videoHeight || 9;
    const s = Math.max(st.W / vw, st.H / vh);
    const dw = vw * s, dh = vh * s;
    return { dw, dh, ox: (st.W - dw) / 2, oy: (st.H - dh) / 2 };
  }
  // u,v là toạ độ khung hình GỐC (chưa lật) — lật gương ở đây
  function toScreen(u, v) {
    const c = cover();
    return { x: c.ox + (1 - u) * c.dw, y: c.oy + v * c.dh };
  }
  function toVideo(x, y) {
    const c = cover();
    return { u: 1 - (x - c.ox) / c.dw, v: (y - c.oy) / c.dh };
  }

  // --- dò cử động (dùng ở chế độ motion, và làm phụ ở chế độ pose) ----------
  const mCanvas = document.createElement('canvas');
  mCanvas.width = MW; mCanvas.height = MH;
  const mCtx = mCanvas.getContext('2d', { willReadFrequently: true });
  let prevGray = null;
  const diff = new Uint8Array(MW * MH);

  function updateMotion() {
    mCtx.drawImage(video, 0, 0, MW, MH);
    const px = mCtx.getImageData(0, 0, MW, MH).data;
    const gray = new Uint8Array(MW * MH);
    for (let i = 0, j = 0; i < gray.length; i++, j += 4) {
      gray[i] = (px[j] * 77 + px[j + 1] * 150 + px[j + 2] * 29) >> 8;
    }
    if (prevGray) {
      for (let i = 0; i < gray.length; i++) diff[i] = Math.abs(gray[i] - prevGray[i]) > 28 ? 1 : 0;
    }
    prevGray = gray;
  }

  /** Tỉ lệ (0..1) điểm ảnh đang cử động trong một hình tròn trên màn hình. */
  st.motionAt = (cx, cy, r) => st.motionRect(cx - r, cy - r, cx + r, cy + r);

  /** Như motionAt nhưng cho một hình chữ nhật trên màn hình. */
  st.motionRect = function (x0, y0, x1, y1) {
    if (st.mode === 'mouse') return 0;
    const a = toVideo(x0, y0), b = toVideo(x1, y1);
    const u0 = Math.max(0, Math.floor(Math.min(a.u, b.u) * MW));
    const u1 = Math.min(MW - 1, Math.ceil(Math.max(a.u, b.u) * MW));
    const v0 = Math.max(0, Math.floor(Math.min(a.v, b.v) * MH));
    const v1 = Math.min(MH - 1, Math.ceil(Math.max(a.v, b.v) * MH));
    let n = 0, hit = 0;
    for (let v = v0; v <= v1; v++) {
      for (let u = u0; u <= u1; u++) { n++; hit += diff[v * MW + u]; }
    }
    return n ? hit / n : 0;
  };

  // --- cập nhật mỗi khung hình ----------------------------------------------
  let lastVideoTime = -1;
  st.update = function () {
    if (st.mode !== 'mouse' && video.readyState >= 2 && video.currentTime !== lastVideoTime) {
      lastVideoTime = video.currentTime;
      updateMotion();
      if (landmarker) {
        try {
          const res = landmarker.detectForVideo(video, performance.now());
          st.persons = (res.landmarks || []).map(personFrom);
        } catch (e) { /* khung lỗi, bỏ qua */ }
      }
    }
    // Con trỏ chuột là một "người" phụ: tay và thân đều ở chỗ con trỏ
    const ptrPersons = [];
    if (st.pointer && (st.mode === "mouse" || performance.now() - st.pointer.t < 4000)) {
      const p = { x: st.pointer.x, y: st.pointer.y };
      ptrPersons.push({ hands: [p], body: p, head: p, pointer: true });
    }
    st.all = (st.mode === 'pose' ? st.persons : []).concat(ptrPersons);
    return st.all;
  };

  function personFrom(lm) {
    const pt = (i) => (lm[i] && (lm[i].visibility ?? 1) > 0.35 ? toScreen(lm[i].x, lm[i].y) : null);
    const hands = [pt(L.lIndex) || pt(L.lWrist), pt(L.rIndex) || pt(L.rWrist)].filter(Boolean);
    // Thân = trung điểm hông; khuất hông (đứng gần quá) thì lấy mũi
    const lh = lm[L.lHip], rh = lm[L.rHip];
    let body = null;
    if (lh && rh) body = toScreen((lh.x + rh.x) / 2, (lh.y + rh.y) / 2);
    const head = toScreen(lm[L.nose].x, lm[L.nose].y);
    if (!body || body.y > st.H * 1.1) body = { x: head.x, y: Math.min(st.H * 0.9, head.y + st.H * 0.3) };
    return { hands, body, head };
  }

  // --- vẽ nền video ---------------------------------------------------------
  st.drawVideo = function (dim = 0.15) {
    ctx.clearRect(0, 0, st.W, st.H);
    if (st.mode !== 'mouse' && video.readyState >= 2) {
      const c = cover();
      ctx.save();
      ctx.translate(st.W, 0);
      ctx.scale(-1, 1);
      ctx.drawImage(video, c.ox, c.oy, c.dw, c.dh);
      ctx.restore();
      if (dim) { ctx.fillStyle = `rgba(0,0,0,${dim})`; ctx.fillRect(0, 0, st.W, st.H); }
    } else {
      const g = ctx.createLinearGradient(0, 0, 0, st.H);
      g.addColorStop(0, '#9BDCE8'); g.addColorStop(1, '#EAF8FB');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, st.W, st.H);
    }
  };

  st.stop = function () {
    window.removeEventListener('resize', resize);
    if (st.stream) st.stream.getTracks().forEach((t) => t.stop());
    if (landmarker) try { landmarker.close(); } catch (e) { /* kệ */ }
  };

  st.modeLabel = () => ({
    pose: '📷 Camera + nhận dáng người',
    motion: '📷 Camera (chế độ cử động — không tải được bộ nhận dáng)',
    mouse: '🖱️ Không có camera — dùng chuột/ngón tay để thử',
  })[st.mode];

  return st;
}
