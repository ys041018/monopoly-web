// ============================================================
// 2D 棋盘渲染（Canvas，清晰大字 + 归属边框 + 房子 + 移动动画）
// ============================================================
import { GROUPS } from './data/tiles.js';
import { getMap } from './data/maps.js';

const CORNER = 92;
const EDGE = 72;
const GAP = 2;
let activeMap = getMap('standard');
let PER_SIDE = activeMap.perSide;
let SIZE = CORNER * 2 + EDGE * PER_SIDE;
export function setActiveMap(id) {
  activeMap = getMap(id);
  PER_SIDE = activeMap.perSide;
  SIZE = CORNER * 2 + EDGE * PER_SIDE;
}

// 棋盘主题
const BOARD_THEMES = {
  candy:  { paper: '#fffdf8', centerA: '#fff8e0', centerB: '#ffe4ab', boardBg: '#d9f2ff' },
  sakura: { paper: '#fffafc', centerA: '#ffe0ee', centerB: '#ffb9d6', boardBg: '#ffe6f0' },
  mint:   { paper: '#f9fffb', centerA: '#d3f7e5', centerB: '#a3ebc6', boardBg: '#ddf8ec' },
  sky:    { paper: '#f8fcff', centerA: '#d6ecff', centerB: '#a8d6ff', boardBg: '#e6f4ff' },
};
// 兼容旧主题名（本地存档里可能还是旧值）
BOARD_THEMES.emerald = BOARD_THEMES.candy;
BOARD_THEMES.classic = BOARD_THEMES.sky;
BOARD_THEMES.warm = BOARD_THEMES.sakura;
BOARD_THEMES.cool = BOARD_THEMES.mint;

// 卡通风格统一描边色
const INK = '#2f3265';
const INK_LABEL = '#4d5288';
const INK_SOFT = 'rgba(47,50,101,0.32)';
let boardTheme = BOARD_THEMES.candy;
export function setBoardTheme(name) { boardTheme = BOARD_THEMES[name] || BOARD_THEMES.candy; }

// 描边圆角矩形（卡通粗线条）
function strokeRound(x, y, w, h, r, color, lw) {
  roundRect(x, y, w, h, r);
  ctx.strokeStyle = color;
  ctx.lineWidth = lw;
  ctx.stroke();
}

let canvas, ctx, dpr;
let lastSizeKey = '';

const TYPE_GRAD = {
  go:          ['#ffe08a', '#ffb84d'],
  chance:      ['#ffd77a', '#ffb020'],
  chest:       ['#9df0d6', '#4fd6b4'],
  tax:         ['#d9c7ff', '#b394ff'],
  railroad:    ['#bfe0ff', '#7fbdf0'],
  utility:     ['#cdeaff', '#93cdf0'],
  jail:        ['#dfe5f0', '#b4c0d6'],
  gotojail:    ['#c3cbdd', '#95a1bd'],
  freeparking: ['#bdf3cd', '#6fdd91'],
  event:       ['#e5ccff', '#b98cff'],
};

const ICON = {
  go: '🚩', chance: '❓', chest: '🍀', tax: '💰', railroad: '🚂',
  jail: '⛓️', gotojail: '🚔', freeparking: '🅿️',
  event: { lottery: '🎰', teleport: '✨', festival: '🎉', bonus: '🎁', shop: '🛍️', again: '🔁', fine: '💸', advance: '⏩', auction: '🔨', rest: '😴', bank: '🏦', backward: '⏪' },
};

// 棋子：playerId -> { color, x, y }
let tokens = new Map();
let diceDisplay = null;

function tileRect(id) {
  const c = CORNER, e = EDGE, n = PER_SIDE, S = SIZE;
  if (id === 0) return { x: S - c, y: S - c, w: c, h: c };
  if (id >= 1 && id <= n) { const i = id; return { x: S - c - i * e, y: S - c, w: e, h: c }; }
  if (id === n + 1) return { x: 0, y: S - c, w: c, h: c };
  if (id >= n + 2 && id <= 2 * n + 1) { const i = id - (n + 1); return { x: 0, y: S - c - i * e, w: c, h: e }; }
  if (id === 2 * n + 2) return { x: 0, y: 0, w: c, h: c };
  if (id >= 2 * n + 3 && id <= 3 * n + 2) { const i = id - (2 * n + 2); return { x: c + (i - 1) * e, y: 0, w: e, h: c }; }
  if (id === 3 * n + 3) return { x: S - c, y: 0, w: c, h: c };
  if (id >= 3 * n + 4 && id <= 4 * n + 3) { const i = id - (3 * n + 3); return { x: S - c, y: c + (i - 1) * e, w: c, h: e }; }
  return { x: 0, y: 0, w: 0, h: 0 };
}

export function render(state) {
  stateRef = state;
  const holder = document.getElementById('board');
  holder.style.background = boardTheme.boardBg;
  if (!canvas) {
    canvas = document.createElement('canvas');
    holder.appendChild(canvas);
    bindTileClick();
  }
  ctx = ctx || canvas.getContext('2d');
  dpr = dpr || (window.devicePixelRatio || 1);
  const cssW = holder.clientWidth || SIZE;
  const scale = cssW / SIZE;
  const sizeKey = Math.round(cssW) + '|' + SIZE + '|' + dpr;
  if (sizeKey !== lastSizeKey) {
    lastSizeKey = sizeKey;
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssW * dpr);
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    ctx.setTransform(dpr * scale, 0, 0, dpr * scale, 0, 0);
  }

  ctx.clearRect(0, 0, SIZE, SIZE);
  for (let i = 0; i < activeMap.size; i++) drawTile(i, activeMap.tiles[i], state);
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

  // 底色：卡纸白 + 粗描边
  ctx.fillStyle = boardTheme.paper;
  roundRect(x, y, w, h, 10);
  ctx.fill();
  strokeRound(x, y, w, h, 10, INK, 3);

  // 组色条（保留地产色组，便于判断齐色）
  const band = vertical ? { x, y, w, h: h * 0.27 } : { x, y, w: w * 0.27, h };
  const bg = ctx.createLinearGradient(band.x, band.y, band.x + band.w, band.y + band.h);
  bg.addColorStop(0, g.color);
  bg.addColorStop(1, shade(g.color, -22));
  ctx.fillStyle = bg;
  roundRect(band.x, band.y, band.w, band.h, 8);
  ctx.fill();
  strokeRound(band.x, band.y, band.w, band.h, 8, INK, 2.5);

  if (!owner) {
    drawIcon('🏠', band.x + band.w / 2, band.y + band.h / 2, corner ? 26 : 16);
  }

  // 名字
  if (corner) {
    drawText(tile.name, r.x + r.w / 2, r.y + r.h * 0.62, 18, INK);
  } else if (vertical) {
    drawVerticalText(tile.name, r.x + r.w / 2, r.y + r.h * 0.31, r.y + r.h * 0.83, 16, INK);
  } else {
    drawText(tile.name, band.x + band.w + (r.w - band.w) / 2, r.y + r.h * 0.44, 13, INK);
  }

  // 价格徽章
  const price = '¥' + tile.price;
  const badgeW = price.length * 8 + 16, badgeH = 20;
  const bx = r.x + r.w / 2 - badgeW / 2;
  const by = vertical ? r.y + r.h - badgeH - 6 : r.y + r.h * 0.68;
  ctx.fillStyle = g.color;
  roundRect(bx, by, badgeW, badgeH, 10);
  ctx.fill();
  strokeRound(bx, by, badgeW, badgeH, 10, INK, 2);
  drawText(price, bx + badgeW / 2, by + badgeH / 2 + 0.5, 12.5, '#fff', 'center', 'bold');

  // 建筑：绿色小洋房（1-4 房），5 级进化为豪华旅馆
  if (owner) {
    const houses = state.tileHouses[id] || 0;
    const hy = vertical ? r.y + r.h * 0.52 : r.y + r.h * 0.54;
    if (houses >= 5) {
      drawHotel(r.x + r.w / 2, hy, 16);
    } else {
      const hs = 11;
      for (let hh = 0; hh < houses; hh++) {
        const hx = r.x + r.w / 2 + (hh - (houses - 1) / 2) * (hs + 2);
        drawHouse(hx, hy, hs);
      }
    }
    // 归属徽章：玩家色圆形 + 玩家序号，放在卡片右上角
    drawOwnerBadge(owner, x + w - 12, y + 12, 22, state.players.indexOf(owner) + 1);
  }
  if (state && state.tileMortgaged[id]) drawMortgageTag(r.x + r.w / 2, r.y + r.h / 2, Math.min(r.w, r.h) * 0.72);
}

function drawSpecial(id, tile, r, vertical, corner, state) {
  const x = r.x + GAP / 2, y = r.y + GAP / 2, w = r.w - GAP, h = r.h - GAP;
  const [c1, c2] = TYPE_GRAD[tile.type] || ['#dfe5f0', '#b4c0d6'];
  const bg = ctx.createLinearGradient(x, y, x + w, y + h);
  bg.addColorStop(0, c1);
  bg.addColorStop(1, c2);
  ctx.fillStyle = bg;
  roundRect(x, y, w, h, 10);
  ctx.fill();
  strokeRound(x, y, w, h, 10, INK, 3);

  const hl = ctx.createLinearGradient(x, y, x, y + h * 0.45);
  hl.addColorStop(0, 'rgba(255,255,255,0.42)');
  hl.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = hl;
  roundRect(x, y, w, h, 10);
  ctx.fill();

  const icon = tile.type === 'utility' ? (tile.name.includes('电') ? '💡' : '💧')
    : tile.type === 'event' ? (ICON.event[tile.sub] || '🎲')
    : ICON[tile.type];

  if (corner) {
    drawIcon(icon, r.x + r.w / 2, r.y + r.h * 0.4, 30);
    drawText(tile.name, r.x + r.w / 2, r.y + r.h * 0.71, 18, INK, 'center', 'bold');
  } else if (vertical) {
    drawIcon(icon, r.x + r.w / 2, r.y + r.h * 0.16, 18);
    drawVerticalText(tile.name, r.x + r.w / 2, r.y + r.h * 0.34, r.y + r.h * 0.9, 15, INK);
  } else {
    drawIcon(icon, r.x + r.w * 0.24, r.y + r.h / 2, 18);
    drawText(tile.name, r.x + r.w * 0.58, r.y + r.h / 2, 13, INK, 'center', 'bold');
  }

  // 车站/公共事业归属：与地产一致的玩家徽章
  const ownerId = state ? state.tileOwners[id] : null;
  if (ownerId && (tile.type === 'railroad' || tile.type === 'utility')) {
    const owner = state.players.find(p => p.id === ownerId);
    if (owner) drawOwnerBadge(owner, x + w - 12, y + 12, 22, state.players.indexOf(owner) + 1);
  }
  if (state && state.tileMortgaged[id]) drawMortgageTag(r.x + r.w / 2, r.y + r.h / 2, Math.min(r.w, r.h) * 0.72);
}

function drawCenter(state) {
  const x = CORNER, y = CORNER, w = SIZE - CORNER * 2, h = SIZE - CORNER * 2;
  const bg = ctx.createLinearGradient(x, y, x + w, y + h);
  bg.addColorStop(0, boardTheme.centerA);
  bg.addColorStop(1, boardTheme.centerB);
  ctx.fillStyle = bg;
  roundRect(x, y, w, h, 26);
  ctx.fill();
  strokeRound(x, y, w, h, 26, INK, 5);
  // 内圈虚线，贴纸感
  ctx.setLineDash([12, 9]);
  strokeRound(x + 15, y + 15, w - 30, h - 30, 18, INK_SOFT, 2);
  ctx.setLineDash([]);

  const cx = SIZE / 2;

  // 卡通云朵 + 糖果圆点
  const cloud = (bx, by, s) => {
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.beginPath();
    ctx.arc(bx, by, s * 0.52, 0, Math.PI * 2);
    ctx.arc(bx + s * 0.5, by - s * 0.2, s * 0.4, 0, Math.PI * 2);
    ctx.arc(bx + s * 0.95, by, s * 0.48, 0, Math.PI * 2);
    ctx.fill();
  };
  cloud(x + 74, y + 62, 46);
  cloud(x + w - 168, y + 78, 38);
  ['#ff6b6b', '#ffd23f', '#45d07a', '#46b5f5', '#a274ff', '#ff7ab8'].forEach((c, i, arr) => {
    const dx = (i - (arr.length - 1) / 2) * 30;
    ctx.beginPath();
    ctx.arc(cx + dx, y + h - 40, 9, 0, Math.PI * 2);
    ctx.fillStyle = c;
    ctx.fill();
    ctx.strokeStyle = INK;
    ctx.lineWidth = 2.5;
    ctx.stroke();
  });

  // 标题：粗描边漫画字
  const gold = ctx.createLinearGradient(cx - 100, 0, cx + 100, 0);
  gold.addColorStop(0, '#ffb84d'); gold.addColorStop(0.5, '#fff3c4'); gold.addColorStop(1, '#ff9f43');
  ctx.font = '900 46px "Baloo 2", "Microsoft YaHei", system-ui, sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.lineWidth = 11;
  ctx.strokeStyle = INK;
  ctx.strokeText('大富翁', cx, y + 52);
  ctx.fillStyle = gold;
  ctx.fillText('大富翁', cx, y + 52);

  // 骰子
  const d = diceDisplay || (state && state.dice ? { d1: state.dice[0], d2: state.dice[1] } : null);
  if (d) {
    drawDice(cx - 60, y + 130, 84, d.d1);
    drawDice(cx + 60, y + 130, 84, d.d2);
  } else {
    ctx.fillStyle = 'rgba(47,50,101,0.55)';
    ctx.font = '800 16px "Baloo 2", "Microsoft YaHei", system-ui, sans-serif';
    ctx.fillText('点击「掷骰子」开始', cx, y + 130);
  }

  // 当前玩家
  if (state) {
    const cur = state.players[state.current];
    const cardW = 240, cardH = 44, ccx = cx - cardW / 2, ccy = y + 200;
    ctx.fillStyle = '#ffffff';
    roundRect(ccx, ccy, cardW, cardH, 16);
    ctx.fill();
    strokeRound(ccx, ccy, cardW, cardH, 16, INK, 3);
    drawToken(ccx + 26, ccy + cardH / 2, 10, cur.color);
    ctx.fillStyle = INK;
    ctx.font = '800 16px "Baloo 2", "Microsoft YaHei", system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText('轮到：' + cur.name + ' · 第 ' + state.round + ' 回合', ccx + 46, ccy + cardH / 2 + 1);

    // 资产排行榜
    drawLeaderboard(state, y);
  }
}

function drawDice(cx, cy, size, value) {
  ctx.fillStyle = '#ffffff';
  roundRect(cx - size / 2, cy - size / 2, size, size, size * 0.28);
  ctx.fill();
  ctx.strokeStyle = INK;
  ctx.lineWidth = 4;
  ctx.stroke();
  const positions = {
    1: [[0, 0]],
    2: [[-1, -1], [1, 1]],
    3: [[-1, -1], [0, 0], [1, 1]],
    4: [[-1, -1], [1, -1], [-1, 1], [1, 1]],
    5: [[-1, -1], [1, -1], [0, 0], [-1, 1], [1, 1]],
    6: [[-1, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [1, 1]],
  };
  ctx.fillStyle = INK;
  const r = size * 0.13;
  (positions[value] || []).forEach(([dx, dy]) => {
    ctx.beginPath();
    ctx.arc(cx + dx * size * 0.26, cy + dy * size * 0.26, r, 0, Math.PI * 2);
    ctx.fill();
  });
}

function drawLeaderboard(state, topY) {
  const assets = state.players.map((p) => {
    let value = p.money;
    activeMap.tiles.forEach((t) => {
      if (state.tileOwners[t.id] === p.id) {
        value += (t.type === 'railroad' ? 200 : t.type === 'utility' ? 150 : (t.price || 0));
        value += (state.tileHouses[t.id] || 0) * (GROUPS[t.group] ? GROUPS[t.group].houseCost : 100);
      }
    });
    return { id: p.id, name: p.name, color: p.color, value, bankrupt: p.bankrupt };
  });
  assets.sort((a, b) => b.value - a.value);

  const x0 = CORNER + 40, w = SIZE - CORNER * 2 - 80;
  const rowH = 32;
  // 在剩余空间内垂直居中，人少时不会挤在顶部
  const availTop = topY + 270;
  const availBottom = topY + (SIZE - CORNER * 2) - 84;
  const blockH = assets.length * rowH;
  const y0 = availTop + Math.max(0, (availBottom - availTop - blockH) / 2) + rowH / 2;
  ctx.textBaseline = 'middle';
  assets.forEach((a, i) => {
    const ry = y0 + i * rowH;
    // 名次卡片
    ctx.fillStyle = i === 0 ? '#fff6d0' : '#ffffff';
    roundRect(x0 - 12, ry - rowH * 0.42, w + 24, rowH * 0.84, 14);
    ctx.fill();
    ctx.strokeStyle = i === 0 ? '#e0a800' : INK_SOFT;
    ctx.lineWidth = i === 0 ? 3 : 2;
    ctx.stroke();
    ctx.fillStyle = a.color;
    ctx.beginPath();
    ctx.arc(x0 + 8, ry, 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = INK;
    ctx.font = (i === 0 ? '800 ' : '700 ') + '15px "Baloo 2", "Microsoft YaHei", system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText((i + 1) + '. ' + a.name + (a.bankrupt ? '（破产）' : ''), x0 + 24, ry);
    ctx.textAlign = 'right';
    ctx.fillStyle = i === 0 ? '#c47a00' : INK_LABEL;
    ctx.font = '800 14px "Baloo 2", "Microsoft YaHei", system-ui, sans-serif';
    ctx.fillText('¥' + a.value, x0 + w, ry);
  });
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
    const idx = stateRef.players.indexOf(p);
    drawToken(px, py, 14, t.color, idx + 1, stateRef.current === idx);
  });
}

let stateRef = null;
let animating = null;

function drawToken(px, py, radius, color, label, highlight) {
  ctx.beginPath();
  ctx.ellipse(px, py + radius * 0.7, radius * 0.85, radius * 0.38, 0, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(0,0,0,0.32)';
  ctx.fill();
  if (highlight) {
    ctx.beginPath();
    ctx.arc(px, py, radius + 4, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255, 215, 116, 0.30)';
    ctx.fill();
    ctx.strokeStyle = '#f7d774';
    ctx.lineWidth = 2;
    ctx.stroke();
  }
  const g = ctx.createRadialGradient(px - radius * 0.35, py - radius * 0.4, radius * 0.15, px, py, radius);
  g.addColorStop(0, lighten(color, 40));
  g.addColorStop(0.55, color);
  g.addColorStop(1, shade(color, -35));
  ctx.beginPath();
  ctx.arc(px, py, radius, 0, Math.PI * 2);
  ctx.fillStyle = g;
  ctx.fill();
  // 卡通描边：深墨外圈 + 白色内圈
  ctx.strokeStyle = INK;
  ctx.lineWidth = 3.5;
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(px, py, Math.max(1, radius - 2.2), 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(255,255,255,0.9)';
  ctx.lineWidth = 1.8;
  ctx.stroke();
  if (label != null) {
    drawText(String(label), px, py + 0.5, Math.round(radius * 0.95), '#ffffff', 'center', 'bold');
  }
}

// 点击检测：把 canvas 点击坐标换算成逻辑坐标，找到对应格子
let tileClickCallback = null;
function bindTileClick() {
  if (!canvas || !tileClickCallback) return;
  canvas.addEventListener('click', (e) => {
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const scale = SIZE / rect.width;
    const x = (e.clientX - rect.left) * scale;
    const y = (e.clientY - rect.top) * scale;
    for (let i = 0; i < activeMap.size; i++) {
      const r = tileRect(i);
      if (x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h) {
        tileClickCallback(i);
        return;
      }
    }
  });
}
export function onTileClick(callback) {
  tileClickCallback = callback;
  bindTileClick();
}

export function animateDice(d1, d2) {
  const start = performance.now();
  function frame() {
    const now = performance.now();
    if (now - start >= 800) {
      diceDisplay = { d1, d2 };
      redraw();
      return;
    }
    diceDisplay = { d1: 1 + Math.floor(Math.random() * 6), d2: 1 + Math.floor(Math.random() * 6) };
    redraw();
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

export function animateMove(playerId, from, to, onDone) {
  const points = [];
  let i = from;
  while (true) {
    const r = tileRect(i);
    points.push({ x: r.x + r.w / 2, y: r.y + r.h / 2 });
    if (i === to) break;
    i = (i + 1) % activeMap.size;
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

function drawHouse(cx, cy, s) {
  const w = s, h = s;
  const x = cx - w / 2, y = cy - h / 2;
  // 主体
  ctx.fillStyle = '#4caf50';
  roundRect(x, y + h * 0.15, w, h * 0.85, 1.5);
  ctx.fill();
  ctx.strokeStyle = '#2e7d32';
  ctx.lineWidth = 1;
  ctx.stroke();
  // 屋顶
  ctx.beginPath();
  ctx.moveTo(x - 1, y + h * 0.18);
  ctx.lineTo(cx, y - h * 0.35);
  ctx.lineTo(x + w + 1, y + h * 0.18);
  ctx.closePath();
  ctx.fillStyle = '#8d4a2f';
  ctx.fill();
  ctx.strokeStyle = '#5d2e1b';
  ctx.lineWidth = 1;
  ctx.stroke();
  // 窗户
  ctx.fillStyle = '#ffd54f';
  ctx.fillRect(cx - 1.5, y + h * 0.45, 3, 3);
  // 高光
  ctx.fillStyle = 'rgba(255,255,255,0.25)';
  ctx.fillRect(x + 1.5, y + h * 0.2, w * 0.3, h * 0.3);
}

function drawHotel(cx, cy, s) {
  const w = s, h = s * 1.15;
  const x = cx - w / 2, y = cy - h / 2;
  // 主体渐变
  const g = ctx.createLinearGradient(x, y, x, y + h);
  g.addColorStop(0, '#e57373');
  g.addColorStop(1, '#c62828');
  ctx.fillStyle = g;
  roundRect(x, y + h * 0.12, w, h * 0.88, 2);
  ctx.fill();
  ctx.strokeStyle = '#b71c1c';
  ctx.lineWidth = 1.2;
  ctx.stroke();
  // 金色屋顶
  ctx.beginPath();
  ctx.moveTo(x - 1.5, y + h * 0.16);
  ctx.lineTo(cx, y - h * 0.4);
  ctx.lineTo(x + w + 1.5, y + h * 0.16);
  ctx.closePath();
  ctx.fillStyle = '#f7d774';
  ctx.fill();
  ctx.strokeStyle = '#c9a227';
  ctx.lineWidth = 1;
  ctx.stroke();
  // H 标识
  drawText('H', cx, y + h * 0.62, Math.round(s * 0.42), '#ffffff', 'center', 'bold');
  // 高光
  ctx.fillStyle = 'rgba(255,255,255,0.28)';
  ctx.fillRect(x + 1.5, y + h * 0.2, w * 0.28, h * 0.3);
}

function drawMortgageTag(cx, cy, size) {
  const w = size, h = size * 0.4;
  ctx.fillStyle = '#ff6b6b';
  roundRect(cx - w / 2, cy - h / 2, w, h, 10);
  ctx.fill();
  strokeRound(cx - w / 2, cy - h / 2, w, h, 10, INK, 2.5);
  drawText('已抵押', cx, cy + 0.5, Math.max(10, Math.round(h * 0.55)), '#ffffff', 'center', 'bold');
}

function drawOwnerBadge(owner, cx, cy, size, label) {
  const r = size / 2;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = owner.color;
  ctx.fill();
  ctx.lineWidth = 2.5;
  ctx.strokeStyle = INK;
  ctx.stroke();
  const text = String(label ?? [...String(owner.name)][0] ?? '?');
  drawText(text, cx, cy + 0.5, Math.round(r * 1.15), '#ffffff', 'center', 'bold');
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
