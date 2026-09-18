// ============================================================
// 2D 棋盘渲染（Canvas，清晰大字 + 归属边框 + 房子 + 移动动画）
// ============================================================
import { TILES, GROUPS, BOARD_SIZE } from './data/tiles.js';

const SIZE = 900;
const CORNER = 117;
const EDGE = (SIZE - CORNER * 2) / 12;
const GAP = 2;

let canvas, ctx, dpr;

const TYPE_GRAD = {
  go:          ['#FF7043', '#E64A19'],
  chance:      ['#FFB74D', '#F57C00'],
  chest:       ['#4DB6AC', '#00897B'],
  tax:         ['#B39DDB', '#7E57C2'],
  railroad:    ['#78909C', '#455A64'],
  utility:     ['#90A4AE', '#546E7A'],
  jail:        ['#546E7A', '#37474F'],
  gotojail:    ['#37474F', '#1C262C'],
  freeparking: ['#81C784', '#43A047'],
  event:       ['#9575CD', '#6A4FB8'],
};

const ICON = {
  go: '🚩', chance: '❓', chest: '🍀', tax: '💰', railroad: '🚂',
  jail: '⛓️', gotojail: '🚔', freeparking: '🅿️',
  event: { lottery: '🎰', teleport: '✨', festival: '🎉', bonus: '🎁', shop: '🛍️', again: '🔁', fine: '💸', advance: '⏩', auction: '🔨', rest: '😴', bank: '🏦', backward: '⏪' },
};

// 棋子：playerId -> { color, x, y }
let tokens = new Map();

function tileRect(id) {
  const c = CORNER, e = EDGE;
  if (id === 0) return { x: SIZE - c, y: SIZE - c, w: c, h: c };
  if (id >= 1 && id <= 12) { const i = id; return { x: SIZE - c - i * e, y: SIZE - c, w: e, h: c }; }
  if (id === 13) return { x: 0, y: SIZE - c, w: c, h: c };
  if (id >= 14 && id <= 25) { const i = id - 13; return { x: 0, y: SIZE - c - i * e, w: c, h: e }; }
  if (id === 26) return { x: 0, y: 0, w: c, h: c };
  if (id >= 27 && id <= 38) { const i = id - 26; return { x: c + (i - 1) * e, y: 0, w: e, h: c }; }
  if (id === 39) return { x: SIZE - c, y: 0, w: c, h: c };
  if (id >= 40 && id <= 51) { const i = id - 39; return { x: SIZE - c, y: c + (i - 1) * e, w: c, h: e }; }
  return { x: 0, y: 0, w: 0, h: 0 };
}

export function render(state) {
  stateRef = state;
  const holder = document.getElementById('board');
  if (!canvas) {
    canvas = document.createElement('canvas');
    holder.appendChild(canvas);
  }
  ctx = ctx || canvas.getContext('2d');
  dpr = dpr || (window.devicePixelRatio || 1);
  const cssW = holder.clientWidth || SIZE;
  if (canvas.width !== Math.round(cssW * dpr)) {
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssW * dpr);
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    ctx.setTransform(dpr * cssW / SIZE, 0, 0, dpr * cssW / SIZE, 0, 0);
  }

  ctx.clearRect(0, 0, SIZE, SIZE);
  for (let i = 0; i < BOARD_SIZE; i++) drawTile(i, TILES[i], state);
  drawCenter(state);
  if (state) { updateTokens(state.players); drawTokens(); }
}

function roundRect(x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawTile(id, tile, state) {
  const r = tileRect(id);
  const vertical = r.h > r.w;
  const corner = (Math.round(r.w) === CORNER && Math.round(r.h) === CORNER);
  if (tile.type === 'property') drawProperty(id, tile, r, vertical, corner, state);
  else drawSpecial(id, tile, r, vertical, corner, state);
}

function drawProperty(id, tile, r, vertical, corner, state) {
  const g = GROUPS[tile.group];
  const x = r.x + GAP / 2, y = r.y + GAP / 2, w = r.w - GAP, h = r.h - GAP;

  const ownerId = state ? state.tileOwners[id] : null;
  const owner = ownerId ? state.players.find(p => p.id === ownerId) : null;

  // 底色：有主用所有者浅色（整块地产呈现所有者色调），无主白色
  ctx.fillStyle = owner ? mixWhite(owner.color, 0.78) : '#fdfefe';
  roundRect(x, y, w, h, 6);
  ctx.fill();

  // 组色条（保留地产色组，便于判断齐色）
  const band = vertical ? { x, y, w, h: h * 0.27 } : { x, y, w: w * 0.27, h };
  const bg = ctx.createLinearGradient(band.x, band.y, band.x + band.w, band.y + band.h);
  bg.addColorStop(0, g.color);
  bg.addColorStop(1, shade(g.color, -22));
  ctx.fillStyle = bg;
  roundRect(band.x, band.y, band.w, band.h, 4);
  ctx.fill();
  if (vertical) ctx.fillRect(band.x, band.y + band.h - 4, band.w, 4);
  else ctx.fillRect(band.x + band.w - 4, band.y, 4, band.h);

  drawIcon('🏠', band.x + band.w / 2, band.y + band.h / 2, corner ? 26 : 16);

  // 名字
  if (corner) {
    drawText(tile.name, r.x + r.w / 2, r.y + r.h * 0.62, 18, '#33404d');
  } else if (vertical) {
    drawVerticalText(tile.name, r.x + r.w / 2, r.y + r.h * 0.31, r.y + r.h * 0.83, 16, '#33404d');
  } else {
    drawText(tile.name, band.x + band.w + (r.w - band.w) / 2, r.y + r.h * 0.44, 13, '#33404d');
  }

  // 价格徽章
  const price = '¥' + tile.price;
  const badgeW = price.length * 8 + 14, badgeH = 18;
  const bx = r.x + r.w / 2 - badgeW / 2;
  const by = vertical ? r.y + r.h - badgeH - 6 : r.y + r.h * 0.68;
  ctx.fillStyle = g.color;
  roundRect(bx, by, badgeW, badgeH, 9);
  ctx.fill();
  drawText(price, bx + badgeW / 2, by + badgeH / 2 + 0.5, 12.5, '#fff', 'center', 'bold');

  // 归属：所有者颜色粗边框 + 房子
  if (owner) {
    ctx.strokeStyle = owner.color;
    ctx.lineWidth = 4;
    roundRect(x + 2, y + 2, w - 4, h - 4, 6);
    ctx.stroke();
    const houses = state.tileHouses[id] || 0;
    for (let hh = 0; hh < houses; hh++) {
      const isHotel = hh === 4;
      const hs = 8;
      const hx = r.x + r.w / 2 + (hh - (houses - 1) / 2) * (hs + 2);
      const hy = vertical ? r.y + r.h * 0.52 : r.y + r.h * 0.54;
      ctx.fillStyle = isHotel ? '#ef5350' : owner.color;
      ctx.fillRect(hx - hs / 2, hy - hs / 2, hs, hs);
      ctx.strokeStyle = 'rgba(0,0,0,0.25)';
      ctx.lineWidth = 1;
      ctx.strokeRect(hx - hs / 2, hy - hs / 2, hs, hs);
    }
  }
}

function drawSpecial(id, tile, r, vertical, corner, state) {
  const x = r.x + GAP / 2, y = r.y + GAP / 2, w = r.w - GAP, h = r.h - GAP;
  const [c1, c2] = TYPE_GRAD[tile.type] || ['#90A4AE', '#546E7A'];
  const bg = ctx.createLinearGradient(x, y, x + w, y + h);
  bg.addColorStop(0, c1);
  bg.addColorStop(1, c2);
  ctx.fillStyle = bg;
  roundRect(x, y, w, h, 6);
  ctx.fill();

  const hl = ctx.createLinearGradient(x, y, x, y + h * 0.5);
  hl.addColorStop(0, 'rgba(255,255,255,0.18)');
  hl.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = hl;
  roundRect(x, y, w, h, 6);
  ctx.fill();

  const icon = tile.type === 'utility' ? (tile.name.includes('电') ? '💡' : '💧')
    : tile.type === 'event' ? (ICON.event[tile.sub] || '🎲')
    : ICON[tile.type];

  if (corner) {
    drawIcon(icon, r.x + r.w / 2, r.y + r.h * 0.4, 30);
    drawText(tile.name, r.x + r.w / 2, r.y + r.h * 0.71, 18, '#fff', 'center', 'bold');
  } else if (vertical) {
    drawIcon(icon, r.x + r.w / 2, r.y + r.h * 0.16, 18);
    drawVerticalText(tile.name, r.x + r.w / 2, r.y + r.h * 0.34, r.y + r.h * 0.9, 15, '#fff');
  } else {
    drawIcon(icon, r.x + r.w * 0.24, r.y + r.h / 2, 18);
    drawText(tile.name, r.x + r.w * 0.58, r.y + r.h / 2, 13, '#fff', 'center', 'bold');
  }

  // 车站/公共事业归属边框
  const ownerId = state ? state.tileOwners[id] : null;
  if (ownerId && (tile.type === 'railroad' || tile.type === 'utility')) {
    const owner = state.players.find(p => p.id === ownerId);
    const color = owner ? owner.color : '#fff';
    ctx.strokeStyle = color;
    ctx.lineWidth = 3;
    roundRect(x + 1.5, y + 1.5, w - 3, h - 3, 6);
    ctx.stroke();
  }
}

function drawCenter(state) {
  const x = CORNER, y = CORNER, w = SIZE - CORNER * 2;
  const bg = ctx.createLinearGradient(x, y, x + w, y + w);
  bg.addColorStop(0, '#172231');
  bg.addColorStop(1, '#0f1924');
  ctx.fillStyle = bg;
  roundRect(x, y, w, w, 18);
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.06)';
  ctx.strokeRect(x + 10, y + 10, w - 20, w - 20);

  const gold = ctx.createLinearGradient(SIZE / 2 - 110, 0, SIZE / 2 + 110, 0);
  gold.addColorStop(0, '#f7d774'); gold.addColorStop(0.5, '#fff3c4'); gold.addColorStop(1, '#e8b84a');
  ctx.fillStyle = gold;
  ctx.font = '800 54px system-ui, "Microsoft YaHei", sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText('大富翁', SIZE / 2, SIZE / 2 - 76);
  ctx.fillStyle = 'rgba(255,255,255,0.45)';
  ctx.font = '17px system-ui, "Microsoft YaHei", sans-serif';
  ctx.fillText('52 格 · 经典地产大亨', SIZE / 2, SIZE / 2 - 30);

  if (state) {
    const cur = state.players[state.current];
    const cardW = 270, cardH = 62, cx = SIZE / 2 - cardW / 2, cy = SIZE / 2 + 8;
    ctx.fillStyle = 'rgba(255,255,255,0.07)';
    roundRect(cx, cy, cardW, cardH, 14);
    ctx.fill();
    ctx.strokeStyle = cur.color;
    ctx.lineWidth = 2;
    roundRect(cx, cy, cardW, cardH, 14);
    ctx.stroke();
    drawToken(cx + 30, cy + cardH / 2, 12, cur.color);
    ctx.fillStyle = '#fff';
    ctx.font = '700 19px system-ui, "Microsoft YaHei", sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText('轮到：' + cur.name, cx + 52, cy + cardH / 2 + 1);
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(255,255,255,0.4)';
    ctx.font = '15px system-ui, "Microsoft YaHei", sans-serif';
    ctx.fillText('第 ' + state.round + ' 回合', SIZE / 2, SIZE / 2 + 96);
  }
}

function updateTokens(players) {
  const ids = new Set(players.map(p => p.id));
  for (const id of tokens.keys()) if (!ids.has(id)) tokens.delete(id);
  players.forEach(p => {
    if (!tokens.has(p.id)) tokens.set(p.id, { color: p.color, x: 0, y: 0 });
    tokens.get(p.id).color = p.color;
  });
}

function drawTokens() {
  // 按格子分组错开
  const byTile = {};
  stateRef.players.forEach(p => { (byTile[p.position] ||= []).push(p); });
  const offsets = {};
  Object.entries(byTile).forEach(([tid, list]) => {
    list.forEach((item, i) => { offsets[item.id] = (i - (list.length - 1) / 2) * 18; });
  });
  stateRef.players.forEach(p => {
    const t = tokens.get(p.id);
    const r = tileRect(p.position);
    const off = offsets[p.id] || 0;
    const horizontal = r.w > r.h;
    const cx = horizontal ? r.x + r.w / 2 + off : r.x + r.w / 2;
    const cy = horizontal ? r.y + r.h / 2 : r.y + r.h / 2 + off;
    // 动画中跟随 t.x/t.y
    const px = animating && animating.id === p.id ? t.x : cx;
    const py = animating && animating.id === p.id ? t.y : cy;
    if (!animating || animating.id !== p.id) { t.x = cx; t.y = cy; }
    drawToken(px, py, 11, t.color);
  });
}

let stateRef = null;
let animating = null;

function drawToken(px, py, radius, color) {
  ctx.beginPath();
  ctx.ellipse(px, py + radius * 0.7, radius * 0.8, radius * 0.35, 0, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(0,0,0,0.28)';
  ctx.fill();
  const g = ctx.createRadialGradient(px - radius * 0.35, py - radius * 0.4, radius * 0.15, px, py, radius);
  g.addColorStop(0, lighten(color, 40));
  g.addColorStop(0.55, color);
  g.addColorStop(1, shade(color, -35));
  ctx.beginPath();
  ctx.arc(px, py, radius, 0, Math.PI * 2);
  ctx.fillStyle = g;
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.85)';
  ctx.lineWidth = 2;
  ctx.stroke();
}

export function animateMove(playerId, from, to, onDone) {
  const points = [];
  let i = from;
  while (true) {
    const r = tileRect(i);
    points.push({ x: r.x + r.w / 2, y: r.y + r.h / 2 });
    if (i === to) break;
    i = (i + 1) % BOARD_SIZE;
  }
  const t = tokens.get(playerId);
  if (!t || points.length <= 1) { if (onDone) onDone(); return; }
  animating = { id: playerId };
  const perStep = 150;
  const total = perStep * (points.length - 1);
  const start = performance.now();
  function frame() {
    const now = performance.now();
    let k = (now - start) / total;
    if (k >= 1) {
      t.x = points[points.length - 1].x;
      t.y = points[points.length - 1].y;
      animating = null;
      redraw();
      if (onDone) onDone();
      return;
    }
    if (k < 0) k = 0;
    const seg = k * (points.length - 1);
    const idx = Math.max(0, Math.min(Math.floor(seg), points.length - 2));
    const f = seg - idx;
    const a = points[idx], b = points[idx + 1];
    t.x = a.x + (b.x - a.x) * f;
    t.y = a.y + (b.y - a.y) * f;
    redraw();
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

function redraw() {
  if (stateRef) render(stateRef);
}

function drawIcon(emoji, x, y, size) {
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.font = size + 'px system-ui, "Segoe UI Emoji", "Apple Color Emoji", sans-serif';
  ctx.fillText(emoji, x, y);
}

function drawText(text, x, y, size, color, align, weight) {
  ctx.textAlign = align || 'center';
  ctx.textBaseline = 'middle';
  ctx.font = (weight || '600') + ' ' + size + 'px system-ui, "Microsoft YaHei", sans-serif';
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
}

function drawVerticalText(text, cx, topY, bottomY, size, color) {
  const chars = [...String(text)];
  const avail = bottomY - topY;
  const gapRatio = 0.16;
  const s = Math.min(size, avail / (chars.length * (1 + gapRatio) - gapRatio));
  const step = s * (1 + gapRatio);
  const totalH = chars.length * step - s * gapRatio;
  let y = (topY + bottomY) / 2 - totalH / 2 + s / 2;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.font = '800 ' + s + 'px system-ui, "Microsoft YaHei", sans-serif';
  ctx.fillStyle = color;
  chars.forEach(ch => { ctx.fillText(ch, cx, y); y += step; });
}

function mixWhite(hex, ratio) {
  const c = hex.replace('#', '');
  let r = parseInt(c.substring(0, 2), 16);
  let g = parseInt(c.substring(2, 4), 16);
  let b = parseInt(c.substring(4, 6), 16);
  r = Math.round(r + (255 - r) * ratio);
  g = Math.round(g + (255 - g) * ratio);
  b = Math.round(b + (255 - b) * ratio);
  return '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');
}

function shade(hex, amt) {
  const c = hex.replace('#', '');
  let r = parseInt(c.substring(0, 2), 16) + amt;
  let g = parseInt(c.substring(2, 4), 16) + amt;
  let b = parseInt(c.substring(4, 6), 16) + amt;
  r = Math.max(0, Math.min(255, r)); g = Math.max(0, Math.min(255, g)); b = Math.max(0, Math.min(255, b));
  return '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');
}
function lighten(hex, amt) { return shade(hex, amt); }
