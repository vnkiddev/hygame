'use strict';
// Vẽ khủng long dùng chung (Đua Khủng Long, Khủng Long Nhảy). Cần lib/core.js nạp trước.
// kind: 'rex' (T-rex) | 'long' (cổ dài). phase: pha bước chân, v: tốc độ (để nghiêng/đung đưa),
// done: há miệng gầm + cúp, flash: loé sáng khi vừa được tiếp sức.
function drawDino(x, y, s, c, phase, v, done, flash) {
  ctx.save();
  ctx.translate(x, y);
  const bob = Math.abs(Math.sin(phase * Math.PI)) * s * .06 * Math.min(1, v / 2);
  ctx.translate(0, -bob);
  ctx.rotate(Math.min(.18, v * .025));                     // chúi về trước khi chạy nhanh
  if (flash) { ctx.shadowColor = '#fff59d'; ctx.shadowBlur = s * .3; }
  // bóng
  ctx.save(); ctx.rotate(-Math.min(.18, v * .025)); ctx.fillStyle = 'rgba(0,0,0,.18)';
  ctx.beginPath(); ctx.ellipse(0, bob + s * .02, s * .5, s * .07, 0, 0, 7); ctx.fill(); ctx.restore();
  // chân (sau rồi trước)
  const leg = (ph, shade) => {
    const a = Math.sin(ph * Math.PI) * .7 * Math.min(1, v / 1.5 + .15);
    ctx.save(); ctx.translate(-s * .02, -s * .32); ctx.rotate(a);
    ctx.fillStyle = shade; roundRect(-s * .07, 0, s * .14, s * .32, s * .06); ctx.fill();
    ctx.beginPath(); ctx.ellipse(s * .04, s * .31, s * .11, s * .05, 0, 0, 7); ctx.fill();
    ctx.restore();
  };
  leg(phase + 1, c.dark);
  // đuôi
  ctx.fillStyle = c.body;
  ctx.beginPath(); ctx.moveTo(-s * .25, -s * .55); ctx.quadraticCurveTo(-s * .75, -s * .5 + Math.sin(phase * 3) * s * .04, -s * .9, -s * .3);
  ctx.quadraticCurveTo(-s * .6, -s * .32, -s * .2, -s * .3); ctx.fill();
  // thân
  ctx.beginPath(); ctx.ellipse(0, -s * .48, s * .33, s * .24, -.15, 0, 7); ctx.fill();
  ctx.fillStyle = c.belly; ctx.beginPath(); ctx.ellipse(s * .06, -s * .4, s * .2, s * .13, -.15, 0, 7); ctx.fill();
  // gai lưng
  ctx.fillStyle = c.dark;
  for (let k = 0; k < 4; k++) { const bx = -s * .26 + k * s * .14, byy = -s * .7 + Math.abs(k - 1.5) * s * .03; ctx.beginPath(); ctx.moveTo(bx - s * .05, byy + s * .03); ctx.lineTo(bx, byy - s * .08); ctx.lineTo(bx + s * .05, byy + s * .03); ctx.fill(); }
  // cổ + đầu
  ctx.fillStyle = c.body;
  let hx, hy;
  if (c.kind === 'long') {
    ctx.beginPath(); ctx.moveTo(s * .15, -s * .62); ctx.quadraticCurveTo(s * .3, -s * 1.15, s * .45, -s * 1.12); ctx.lineTo(s * .5, -s * 1.0);
    ctx.quadraticCurveTo(s * .38, -s * 1.0, s * .3, -s * .5); ctx.fill();
    hx = s * .52; hy = -s * 1.08;
    ctx.beginPath(); ctx.ellipse(hx, hy, s * .15, s * .1, .15, 0, 7); ctx.fill();
  } else {
    ctx.beginPath(); ctx.ellipse(s * .26, -s * .72, s * .13, s * .16, .4, 0, 7); ctx.fill();
    hx = s * .42; hy = -s * .86;
    ctx.beginPath(); ctx.ellipse(hx, hy, s * .22, s * .14, .1, 0, 7); ctx.fill();
    // tay ngắn
    ctx.strokeStyle = c.dark; ctx.lineWidth = s * .05; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(s * .25, -s * .52); ctx.lineTo(s * .36, -s * .45 + Math.sin(phase * Math.PI) * s * .03); ctx.stroke();
  }
  // mắt + miệng
  ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(hx + s * .02, hy - s * .04, s * .055, 0, 7); ctx.fill();
  ctx.fillStyle = '#222'; ctx.beginPath(); ctx.arc(hx + s * .035, hy - s * .04, s * .028, 0, 7); ctx.fill();
  ctx.strokeStyle = c.dark; ctx.lineWidth = s * .025;
  ctx.beginPath();
  if (done) { ctx.fillStyle = '#b71c1c'; ctx.ellipse(hx + s * .12, hy + s * .05, s * .07, s * .05, 0, 0, 7); ctx.fill(); }   // há miệng gầm
  else { ctx.arc(hx + s * .08, hy + s * .02, s * .07, .2, 1.3); ctx.stroke(); }
  leg(phase, c.body);
  ctx.restore();
  if (done) { ctx.font = emojiFont(s * .35); ctx.textAlign = 'center'; ctx.textBaseline = 'bottom'; ctx.fillText('🏆', x, y - s * 1.2); }
}

