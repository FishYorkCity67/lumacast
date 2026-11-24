// Built-in animated avatars for the voice avatar source. Each style draws a
// head and returns its face geometry; the shared face (eyes that blink and look
// around, a mouth that follows the voice, blush) and accessories go on top.
import { clamp } from './util.js';

export const AVATAR_STYLES = ['blob', 'cat', 'fox', 'bunny', 'robot', 'ghost', 'slime'];
export const AVATAR_ACCESSORIES = ['none', 'headphones', 'crown', 'glasses', 'partyhat', 'bow'];

function shade(hex, f) {
  const n = parseInt(String(hex).replace('#', '').slice(0, 6), 16) || 0;
  const c = (v) => Math.round(clamp(f < 0 ? v * (1 + f) : v + (255 - v) * f, 0, 255));
  return `rgb(${c((n >> 16) & 255)},${c((n >> 8) & 255)},${c(n & 255)})`;
}

function ellipse(ctx, x, y, rx, ry, rot = 0) {
  ctx.beginPath();
  ctx.ellipse(x, y, Math.max(0.1, rx), Math.max(0.1, ry), rot, 0, Math.PI * 2);
}

function bodyGrad(ctx, cx, cy, R, col) {
  const g = ctx.createRadialGradient(cx - R * 0.35, cy - R * 0.45, R * 0.05, cx, cy, R * 1.15);
  g.addColorStop(0, shade(col, 0.55));
  g.addColorStop(0.35, col);
  g.addColorStop(1, shade(col, -0.25));
  return g;
}

// ---- heads -----------------------------------------------------------------------
const HEADS = {
  blob(ctx, a) {
    const { cx, cy, R, col } = a;
    ctx.fillStyle = bodyGrad(ctx, cx, cy, R, col);
    ellipse(ctx, cx, cy, R * (1 + a.squash * 0.04), R * (0.96 - a.squash * 0.04));
    ctx.fill();
    return { cx, cy, R, eyeY: cy - R * 0.12, eyeDX: R * 0.36, mouthY: cy + R * 0.33, top: cy - R };
  },

  cat(ctx, a) {
    const { cx, cy, R, col, t } = a;
    const twitch = Math.max(0, Math.sin(t * 0.9) * 8 - 7.4) * 0.5;
    for (const s of [-1, 1]) {
      const tilt = s * (0.12 + (s > 0 ? twitch : 0));
      ctx.save();
      ctx.translate(cx + s * R * 0.62, cy - R * 0.62);
      ctx.rotate(tilt);
      ctx.fillStyle = shade(col, -0.08);
      ctx.beginPath();
      ctx.moveTo(-R * 0.38, R * 0.22);
      ctx.quadraticCurveTo(-R * 0.08, -R * 0.62, R * 0.06, -R * 0.58);
      ctx.quadraticCurveTo(R * 0.2, -R * 0.2, R * 0.36, R * 0.24);
      ctx.fill();
      ctx.fillStyle = '#ffb3c7';
      ctx.beginPath();
      ctx.moveTo(-R * 0.2, R * 0.12);
      ctx.quadraticCurveTo(-R * 0.03, -R * 0.38, R * 0.05, -R * 0.36);
      ctx.quadraticCurveTo(R * 0.12, -R * 0.12, R * 0.2, R * 0.14);
      ctx.fill();
      ctx.restore();
    }
    ctx.fillStyle = bodyGrad(ctx, cx, cy, R, col);
    ellipse(ctx, cx, cy, R * 1.04, R * 0.9);
    ctx.fill();
    // nose + whiskers
    ctx.fillStyle = '#ff8fab';
    ctx.beginPath();
    ctx.moveTo(cx - R * 0.07, cy + R * 0.12);
    ctx.lineTo(cx + R * 0.07, cy + R * 0.12);
    ctx.lineTo(cx, cy + R * 0.2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(30,20,40,.45)';
    ctx.lineWidth = R * 0.025;
    ctx.lineCap = 'round';
    for (const s of [-1, 1]) {
      for (const dy of [-0.04, 0.06]) {
        ctx.beginPath();
        ctx.moveTo(cx + s * R * 0.42, cy + R * (0.18 + dy));
        ctx.lineTo(cx + s * R * 0.95, cy + R * (0.12 + dy * 2.2));
        ctx.stroke();
      }
    }
    return { cx, cy, R, eyeY: cy - R * 0.12, eyeDX: R * 0.38, mouthY: cy + R * 0.34, top: cy - R * 0.95 };
  },

  fox(ctx, a) {
    const { cx, cy, R, col } = a;
    for (const s of [-1, 1]) {
      ctx.save();
      ctx.translate(cx + s * R * 0.6, cy - R * 0.6);
      ctx.rotate(s * (0.28 + Math.sin(a.t * 2 + s) * 0.03));
      ctx.fillStyle = col;
      ctx.beginPath();
      ctx.moveTo(-R * 0.32, R * 0.25);
      ctx.lineTo(0, -R * 0.62);
      ctx.lineTo(R * 0.32, R * 0.25);
      ctx.fill();
      ctx.fillStyle = '#2a1b14';
      ctx.beginPath();
      ctx.moveTo(-R * 0.13, -R * 0.24);
      ctx.lineTo(0, -R * 0.62);
      ctx.lineTo(R * 0.13, -R * 0.24);
      ctx.fill();
      ctx.restore();
    }
    ctx.fillStyle = bodyGrad(ctx, cx, cy, R, col);
    ctx.beginPath();
    ctx.moveTo(cx - R, cy - R * 0.2);
    ctx.quadraticCurveTo(cx - R, cy - R * 0.95, cx, cy - R * 0.92);
    ctx.quadraticCurveTo(cx + R, cy - R * 0.95, cx + R, cy - R * 0.2);
    ctx.quadraticCurveTo(cx + R * 0.95, cy + R * 0.55, cx, cy + R * 0.82);
    ctx.quadraticCurveTo(cx - R * 0.95, cy + R * 0.55, cx - R, cy - R * 0.2);
    ctx.fill();
    ctx.fillStyle = '#fff6ee';
    ctx.beginPath();
    ctx.moveTo(cx - R * 0.95, cy + R * 0.02);
    ctx.quadraticCurveTo(cx - R * 0.4, cy + R * 0.05, cx, cy + R * 0.22);
    ctx.quadraticCurveTo(cx + R * 0.4, cy + R * 0.05, cx + R * 0.95, cy + R * 0.02);
    ctx.quadraticCurveTo(cx + R * 0.8, cy + R * 0.6, cx, cy + R * 0.82);
    ctx.quadraticCurveTo(cx - R * 0.8, cy + R * 0.6, cx - R * 0.95, cy + R * 0.02);
    ctx.fill();
    ctx.fillStyle = '#2a1b14';
    ellipse(ctx, cx, cy + R * 0.2, R * 0.09, R * 0.06);
    ctx.fill();
    return { cx, cy, R, eyeY: cy - R * 0.2, eyeDX: R * 0.38, mouthY: cy + R * 0.42, top: cy - R * 0.92, small: true };
  },

  bunny(ctx, a) {
    const { cx, cy, R, col, t, talk } = a;
    for (const s of [-1, 1]) {
      const flop = s * (0.12 + Math.sin(t * 3 + s) * 0.04 + talk * Math.sin(t * 14) * 0.06) + (s > 0 ? 0.18 : 0);
      ctx.save();
      ctx.translate(cx + s * R * 0.38, cy - R * 0.7);
      ctx.rotate(flop);
      ctx.fillStyle = shade(col, -0.05);
      ellipse(ctx, 0, -R * 0.62, R * 0.22, R * 0.7);
      ctx.fill();
      ctx.fillStyle = '#ffc2d4';
      ellipse(ctx, 0, -R * 0.58, R * 0.11, R * 0.52);
      ctx.fill();
      ctx.restore();
    }
    ctx.fillStyle = bodyGrad(ctx, cx, cy, R, col);
    ellipse(ctx, cx, cy, R, R * 0.88);
    ctx.fill();
    ctx.fillStyle = '#ff9bb8';
    ellipse(ctx, cx, cy + R * 0.14, R * 0.07, R * 0.05);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(cx - R * 0.07, cy + R * 0.4, R * 0.065, R * 0.1 + talk * R * 0.05);
    ctx.fillRect(cx + R * 0.005, cy + R * 0.4, R * 0.065, R * 0.1 + talk * R * 0.05);
    return { cx, cy, R, eyeY: cy - R * 0.1, eyeDX: R * 0.36, mouthY: cy + R * 0.32, top: cy - R * 0.88 };
  },

  robot(ctx, a) {
    const { cx, cy, R, col, t, level, talk } = a;
    // antenna
    ctx.strokeStyle = shade(col, -0.35);
    ctx.lineWidth = R * 0.06;
    ctx.beginPath();
    ctx.moveTo(cx, cy - R * 0.85);
    ctx.lineTo(cx, cy - R * 1.18);
    ctx.stroke();
    const on = Math.sin(t * 4) > 0 || talk > 0.5;
    ctx.fillStyle = on ? '#ff4d6d' : '#7a2a3a';
    ctx.shadowColor = '#ff4d6d';
    ctx.shadowBlur = on ? R * 0.3 : 0;
    ellipse(ctx, cx, cy - R * 1.22, R * 0.1, R * 0.1);
    ctx.fill();
    ctx.shadowBlur = 0;
    // head
    const g = ctx.createLinearGradient(cx, cy - R, cx, cy + R);
    g.addColorStop(0, shade(col, 0.45));
    g.addColorStop(0.5, col);
    g.addColorStop(1, shade(col, -0.35));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.roundRect(cx - R, cy - R * 0.85, R * 2, R * 1.7, R * 0.35);
    ctx.fill();
    // ear bolts
    ctx.fillStyle = shade(col, -0.3);
    for (const s of [-1, 1]) {
      ctx.beginPath();
      ctx.roundRect(cx + s * R * 1.0 - R * 0.09, cy - R * 0.2, R * 0.18, R * 0.4, R * 0.06);
      ctx.fill();
    }
    // visor
    ctx.fillStyle = '#0b1020';
    ctx.beginPath();
    ctx.roundRect(cx - R * 0.78, cy - R * 0.55, R * 1.56, R * 1.15, R * 0.22);
    ctx.fill();
    // equalizer mouth
    const bars = 7;
    for (let i = 0; i < bars; i++) {
      const v = talk * (0.25 + 0.75 * level) * (0.4 + 0.6 * Math.abs(Math.sin(t * 13 + i * 1.7)));
      const bh = R * (0.04 + 0.26 * v);
      ctx.fillStyle = `hsl(${170 + i * 12} 95% 60%)`;
      ctx.fillRect(cx - R * 0.42 + i * R * 0.125, cy + R * 0.33 - bh / 2, R * 0.08, bh);
    }
    return { cx, cy, R, eyeY: cy - R * 0.15, eyeDX: R * 0.36, mouthY: cy + R * 0.33, top: cy - R * 0.85, robot: true };
  },

  ghost(ctx, a) {
    const { cx, R, t } = a;
    const cy = a.cy - Math.sin(t * 1.8) * R * 0.06;
    ctx.save();
    ctx.globalAlpha *= 0.92;
    const g = ctx.createLinearGradient(cx, cy - R, cx, cy + R * 1.1);
    g.addColorStop(0, shade(a.col, 0.7));
    g.addColorStop(1, shade(a.col, 0.1));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(cx - R * 0.9, cy + R * 0.9);
    ctx.lineTo(cx - R * 0.9, cy - R * 0.1);
    ctx.arc(cx, cy - R * 0.1, R * 0.9, Math.PI, 0);
    ctx.lineTo(cx + R * 0.9, cy + R * 0.9);
    const waves = 4;
    for (let i = waves; i > 0; i--) {
      const x1 = cx - R * 0.9 + ((i - 0.5) / waves) * R * 1.8;
      const x0 = cx - R * 0.9 + ((i - 1) / waves) * R * 1.8;
      const wob = Math.sin(t * 5 + i) * R * 0.06;
      ctx.quadraticCurveTo(x1, cy + R * 1.12 + wob, x0, cy + R * 0.9);
    }
    ctx.closePath();
    ctx.fill();
    ctx.restore();
    return { cx, cy, R: R * 0.9, eyeY: cy - R * 0.2, eyeDX: R * 0.32, mouthY: cy + R * 0.25, top: cy - R };
  },

  slime(ctx, a) {
    const { cx, R, t, talk } = a;
    const jig = Math.sin(t * 6) * 0.03 + talk * Math.sin(t * 18) * 0.04;
    const w = R * (1.1 + jig);
    const hgt = R * (0.95 - jig);
    const base = a.cy + R * 0.85;
    ctx.fillStyle = bodyGrad(ctx, cx, base - hgt * 0.8, R, a.col);
    ctx.beginPath();
    ctx.moveTo(cx - w, base);
    ctx.bezierCurveTo(cx - w * 1.02, base - hgt * 1.4, cx + w * 1.02, base - hgt * 1.4, cx + w, base);
    ctx.quadraticCurveTo(cx, base + R * 0.08, cx - w, base);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,.55)';
    ellipse(ctx, cx - w * 0.45, base - hgt * 0.95, R * 0.16, R * 0.09, -0.5);
    ctx.fill();
    const cy = base - hgt * 0.55;
    return { cx, cy, R, eyeY: cy - R * 0.12, eyeDX: R * 0.34, mouthY: cy + R * 0.28, top: base - hgt * 1.05 };
  },
};

// ---- face -----------------------------------------------------------------------------
function drawFace(ctx, f, a) {
  const { R } = f;
  const er = R * (f.small ? 0.11 : 0.13);
  const happy = a.happy > 0.5;
  for (const s of [-1, 1]) {
    const ex = f.cx + s * f.eyeDX;
    const ey = f.eyeY;
    if (happy) {
      ctx.strokeStyle = f.robot ? '#7df9ff' : '#16121f';
      ctx.lineWidth = er * 0.45;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.arc(ex, ey + er * 0.3, er * 0.8, Math.PI * 1.15, Math.PI * 1.85);
      ctx.stroke();
      continue;
    }
    const open = 1 - a.blink;
    if (f.robot) {
      ctx.fillStyle = '#7df9ff';
      ctx.shadowColor = '#7df9ff';
      ctx.shadowBlur = R * 0.2;
      ctx.beginPath();
      ctx.roundRect(ex - er * 1.1 + a.lookX * er * 0.5, ey - er * open, er * 2.2, Math.max(er * 0.18, er * 2 * open), er * 0.4);
      ctx.fill();
      ctx.shadowBlur = 0;
      continue;
    }
    ctx.fillStyle = '#ffffff';
    ellipse(ctx, ex, ey, er * 1.05, Math.max(er * 0.1, er * 1.25 * open));
    ctx.fill();
    if (open > 0.25) {
      const px = ex + a.lookX * er * 0.35;
      const py = ey + a.lookY * er * 0.35;
      ctx.fillStyle = '#16121f';
      ellipse(ctx, px, py, er * 0.72, er * 0.85 * Math.min(1, open * 1.2));
      ctx.fill();
      ctx.fillStyle = '#ffffff';
      ellipse(ctx, px - er * 0.25, py - er * 0.3, er * 0.22, er * 0.22);
      ctx.fill();
    } else {
      ctx.strokeStyle = '#16121f';
      ctx.lineWidth = er * 0.3;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(ex - er, ey);
      ctx.quadraticCurveTo(ex, ey + er * 0.4, ex + er, ey);
      ctx.stroke();
    }
  }
  if (f.robot) return;
  // blush
  ctx.fillStyle = `rgba(255,110,150,${0.28 + a.happy * 0.25})`;
  for (const s of [-1, 1]) {
    ellipse(ctx, f.cx + s * f.eyeDX * 1.55, f.eyeY + R * 0.26, R * 0.13, R * 0.07);
    ctx.fill();
  }
  // mouth
  const openness = Math.max(a.mouth, a.happy * 0.35);
  ctx.fillStyle = '#3a1020';
  if (openness > 0.06) {
    ellipse(ctx, f.cx, f.mouthY, R * (0.13 + openness * 0.06), R * (0.03 + openness * 0.2));
    ctx.fill();
    ctx.fillStyle = '#ff6f91';
    ellipse(ctx, f.cx, f.mouthY + R * (0.02 + openness * 0.1), R * 0.08, R * 0.04 * openness + R * 0.01);
    ctx.fill();
  } else {
    ctx.strokeStyle = '#3a1020';
    ctx.lineWidth = R * 0.045;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(f.cx - R * 0.11, f.mouthY - R * 0.02);
    ctx.quadraticCurveTo(f.cx, f.mouthY + R * 0.07, f.cx + R * 0.11, f.mouthY - R * 0.02);
    ctx.stroke();
  }
}

// ---- accessories -------------------------------------------------------------------------
function drawAccessory(ctx, f, kind, t) {
  const { cx, R, top } = f;
  switch (kind) {
    case 'headphones': {
      ctx.strokeStyle = '#1d1f2e';
      ctx.lineWidth = R * 0.13;
      ctx.beginPath();
      ctx.arc(cx, f.cy - R * 0.05, R * 1.02, Math.PI * 1.08, Math.PI * 1.92);
      ctx.stroke();
      for (const s of [-1, 1]) {
        ctx.fillStyle = '#1d1f2e';
        ctx.beginPath();
        ctx.roundRect(cx + s * R * 1.0 - R * 0.16, f.cy - R * 0.25, R * 0.32, R * 0.55, R * 0.14);
        ctx.fill();
        ctx.fillStyle = `hsl(${(t * 60) % 360} 90% 60%)`;
        ctx.beginPath();
        ctx.roundRect(cx + s * R * 1.0 - R * 0.05, f.cy - R * 0.12, R * 0.1, R * 0.3, R * 0.05);
        ctx.fill();
      }
      break;
    }
    case 'crown': {
      const y = top + R * 0.05;
      const g = ctx.createLinearGradient(cx, y - R * 0.45, cx, y);
      g.addColorStop(0, '#fff3a0');
      g.addColorStop(1, '#f5b700');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.moveTo(cx - R * 0.42, y);
      ctx.lineTo(cx - R * 0.48, y - R * 0.4);
      ctx.lineTo(cx - R * 0.22, y - R * 0.18);
      ctx.lineTo(cx, y - R * 0.48);
      ctx.lineTo(cx + R * 0.22, y - R * 0.18);
      ctx.lineTo(cx + R * 0.48, y - R * 0.4);
      ctx.lineTo(cx + R * 0.42, y);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = '#ff3d71';
      ellipse(ctx, cx, y - R * 0.12, R * 0.06, R * 0.06);
      ctx.fill();
      break;
    }
    case 'glasses': {
      ctx.strokeStyle = '#1b1b24';
      ctx.lineWidth = R * 0.05;
      ctx.fillStyle = 'rgba(160,220,255,.18)';
      for (const s of [-1, 1]) {
        ctx.beginPath();
        ctx.roundRect(cx + s * f.eyeDX - R * 0.22, f.eyeY - R * 0.18, R * 0.44, R * 0.36, R * 0.1);
        ctx.fill();
        ctx.stroke();
      }
      ctx.beginPath();
      ctx.moveTo(cx - f.eyeDX + R * 0.22, f.eyeY);
      ctx.lineTo(cx + f.eyeDX - R * 0.22, f.eyeY);
      ctx.stroke();
      break;
    }
    case 'partyhat': {
      const y = top + R * 0.1;
      ctx.save();
      ctx.translate(cx + R * 0.15, y);
      ctx.rotate(0.18);
      const g = ctx.createLinearGradient(-R * 0.3, 0, R * 0.3, 0);
      g.addColorStop(0, '#22d3ee');
      g.addColorStop(1, '#7c5cff');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.moveTo(-R * 0.3, 0);
      ctx.lineTo(0, -R * 0.75);
      ctx.lineTo(R * 0.3, 0);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = '#ffe066';
      ellipse(ctx, 0, -R * 0.78, R * 0.09, R * 0.09);
      ctx.fill();
      ctx.restore();
      break;
    }
    case 'bow': {
      const y = top + R * 0.12;
      const x = cx + R * 0.45;
      ctx.fillStyle = '#ff5c8a';
      for (const s of [-1, 1]) {
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.quadraticCurveTo(x + s * R * 0.3, y - R * 0.25, x + s * R * 0.3, y);
        ctx.quadraticCurveTo(x + s * R * 0.3, y + R * 0.25, x, y);
        ctx.fill();
      }
      ctx.fillStyle = '#ff2e6e';
      ellipse(ctx, x, y, R * 0.08, R * 0.08);
      ctx.fill();
      break;
    }
    default:
      break;
  }
}

// a = { style, color, accessory, t, talk, level, mouth, blink, lookX, lookY, happy, squash }
export function drawAvatar(ctx, w, h, a) {
  const R = Math.min(w, h) * 0.34;
  const cx = w / 2;
  const cy = h - R * 1.12;
  const head = HEADS[a.style] || HEADS.blob;
  ctx.save();
  // soft floor shadow
  ctx.fillStyle = 'rgba(0,0,0,.18)';
  ellipse(ctx, cx, h - R * 0.08, R * 0.75 * (1 - a.jump * 0.3), R * 0.1);
  ctx.fill();
  ctx.translate(0, -a.jump * R * 0.5);
  const f = head(ctx, { cx, cy, R, col: a.color || '#7c5cff', t: a.t, talk: a.talk, level: a.level, squash: a.squash || 0 });
  drawFace(ctx, f, a);
  drawAccessory(ctx, f, a.accessory, a.t);
  if (a.happy > 0.05) {
    ctx.globalAlpha = a.happy;
    ctx.fillStyle = '#ffe066';
    for (let i = 0; i < 5; i++) {
      const ang = a.t * 2 + (i / 5) * Math.PI * 2;
      const sx = cx + Math.cos(ang) * R * 1.35;
      const sy = cy - R * 0.2 + Math.sin(ang) * R * 0.9;
      const s = R * 0.07 * (1 + 0.4 * Math.sin(a.t * 8 + i));
      ctx.beginPath();
      for (let k = 0; k < 8; k++) {
        const rr = k % 2 ? s * 0.4 : s;
        ctx.lineTo(sx + Math.cos((k * Math.PI) / 4) * rr, sy + Math.sin((k * Math.PI) / 4) * rr);
      }
      ctx.fill();
    }
  }
  ctx.restore();
}

export const AVATAR_COLORS = { blob: '#7c5cff', cat: '#9aa3b5', fox: '#ff8c42', bunny: '#f3eef8', robot: '#8fa3c7', ghost: '#c7d2fe', slime: '#4ade80' };
