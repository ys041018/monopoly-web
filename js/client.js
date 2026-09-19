// ============================================================
// 前端主逻辑：WebSocket + 大厅/游戏 + 回合操作 + 盖房/抵押/交易
// ============================================================
import { render, animateMove, animateDice, onTileClick } from './board2d.js';

window.addEventListener('error', (e) => {
  const t = document.getElementById('turn-sub');
  if (t) t.textContent = '⚠️ ' + (e.message || '未知错误') + ' @ ' + (e.filename||'').split('/').pop() + ':' + e.lineno;
});
import { TILES, GROUPS } from './data/tiles.js';
import { playForLog } from './sound.js';

const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
const ws = new WebSocket(`${proto}//${location.host}`);

const $ = (id) => document.getElementById(id);
const lobby = $('lobby'), game = $('game');
const nameInput = $('name-input'), joinBtn = $('join-btn'), startBtn = $('start-btn'), lobbyBtn = $('lobby-btn');
const rollBtn = $('roll-btn'), buyBtn = $('buy-btn'), skipBuyBtn = $('skip-buy-btn'), endTurnBtn = $('end-turn-btn');
const buildBtn = $('build-btn'), mortgageBtn = $('mortgage-btn'), tradeBtn = $('trade-btn');
const buildPanel = $('build-panel'), mortgagePanel = $('mortgage-panel'), tradePanel = $('trade-panel'), tradeOffer = $('trade-offer'), auctionPanel = $('auction-panel');
const waitingTip = $('waiting-tip'), diceDisplay = $('dice-display');
const lobbyMsg = $('lobby-msg'), playerList = $('player-list'), playerCount = $('player-count');
const gamePlayerList = $('game-player-list'), gamePlayerCount = $('game-player-count');
const logList = $('log-list'), turnTitle = $('turn-title'), turnSub = $('turn-sub');
const deedModal = $('deed-modal'), deedContent = $('deed-content'), deedClose = $('deed-close');
const cardPopup = $('card-popup'), cardPopupTitle = $('card-popup-title'), cardPopupText = $('card-popup-text');

const DICE_FACES = ['⚀', '⚁', '⚂', '⚃', '⚄', '⚅'];

let myId = null, myIsHost = false, isSpectator = false;
let players = [], state = null;
let gotError = false, entered = false, animating = false;
let prevLogLength = 0;
let prevLastCard = null;
let cardTimer = null;

// ---------- 发送 ----------
joinBtn.addEventListener('click', () => {
  const name = nameInput.value.trim();
  if (!name) { setMsg('请输入昵称', true); return; }
  gotError = false;
  ws.send(JSON.stringify({ type: 'join', name }));
  joinBtn.disabled = true;
  setMsg('正在加入...');
});
startBtn.addEventListener('click', () => ws.send(JSON.stringify({ type: 'start_game' })));
lobbyBtn.addEventListener('click', () => ws.send(JSON.stringify({ type: 'back_to_lobby' })));

// 点击棋盘格子查看地契
onTileClick((id) => { if (state) renderDeed(id); });
deedClose.addEventListener('click', () => deedModal.classList.add('hidden'));
deedModal.addEventListener('click', (e) => { if (e.target === deedModal) deedModal.classList.add('hidden'); });
rollBtn.addEventListener('click', () => ws.send(JSON.stringify({ type: 'roll_dice' })));
buyBtn.addEventListener('click', () => ws.send(JSON.stringify({ type: 'buy_property' })));
skipBuyBtn.addEventListener('click', () => ws.send(JSON.stringify({ type: 'skip_buy' })));
endTurnBtn.addEventListener('click', () => ws.send(JSON.stringify({ type: 'end_turn' })));
buildBtn.addEventListener('click', () => { toggle(buildPanel); if (!buildPanel.classList.contains('hidden')) renderBuildPanel(); });
mortgageBtn.addEventListener('click', () => { toggle(mortgagePanel); if (!mortgagePanel.classList.contains('hidden')) renderMortgagePanel(); });
tradeBtn.addEventListener('click', () => { toggle(tradePanel); if (!tradePanel.classList.contains('hidden')) renderTradePanel(); });

function toggle(el) { el.classList.toggle('hidden'); }

// ---------- 接收 ----------
ws.onopen = () => setMsg('已连接服务器');
ws.onclose = () => { if (!gotError) setMsg('连接已断开，请刷新页面', true); };

ws.onmessage = (e) => {
  let msg;
  try { msg = JSON.parse(e.data); } catch { return; }
  switch (msg.type) {
    case 'welcome':
      myId = msg.playerId;
      isSpectator = !!msg.spectator;
      myIsHost = msg.player ? msg.player.isHost : false;
      break;
    case 'player_list':
      players = msg.players;
      renderPlayers();
      updateStartBtn(msg.canStart);
      break;
    case 'game_state':
      state = msg.state;
      if (!entered) { entered = true; enterGame(); }
      else syncGame();
      break;
    case 'back_to_lobby': backToLobby(); break;
    case 'error':
      gotError = true;
      setMsg(msg.message, true);
      joinBtn.disabled = false;
      break;
  }
};

// ---------- 视图同步 ----------
function enterGame() {
  lobby.classList.add('hidden');
  game.classList.remove('hidden');
  prevLogLength = state.log ? state.log.length : 0;
  render(state);
  refresh();
}

function syncGame() {
  const lm = state.lastMove;
  if (lm && !animating) {
    animating = true;
    hideAllActions();
    render(state);
    if (lm.dice) animateDice(lm.dice[0], lm.dice[1]);
    const moverId = state.players[lm.playerIndex].id;
    animateMove(moverId, lm.from, lm.to, () => { animating = false; refresh(); });
  } else if (!animating) {
    render(state);
    refresh();
  }
}

function refresh() {
  renderPlayers();
  renderLog();
  renderDice();
  updateTurnInfo();
  updateActions();
  renderTradeOffer();
  detectSound();
  detectCard();
}

function backToLobby() {
  state = null; isSpectator = false; entered = false; animating = false;
  game.classList.add('hidden');
  lobby.classList.remove('hidden');
  renderPlayers();
  updateStartBtn(players.length >= 2);
  setMsg('已回到大厅，可重新开始');
}

// ---------- 操作按钮 ----------
function hideAllActions() {
  [rollBtn, buyBtn, skipBuyBtn, endTurnBtn, buildBtn, mortgageBtn, tradeBtn].forEach(b => b.classList.add('hidden'));
  [buildPanel, mortgagePanel, tradePanel, auctionPanel].forEach(p => p.classList.add('hidden'));
  waitingTip.classList.add('hidden');
}

function updateActions() {
  hideAllActions();
  if (!state) return;
  if (state.phase === 'gameOver') { waitingTip.textContent = '游戏已结束'; waitingTip.classList.remove('hidden'); return; }
  if (state.phase === 'auction') { renderAuctionPanel(); return; }
  const myTurn = !isSpectator && state.players[state.current].id === myId;
  // 交易不受回合限制：任何时候（非旁观者）都能发起
  if (!isSpectator) tradeBtn.classList.remove('hidden');
  if (!myTurn) { waitingTip.classList.remove('hidden'); return; }

  if (state.phase === 'rolling') {
    rollBtn.classList.remove('hidden');
    if (getBuildableTiles().length > 0) buildBtn.classList.remove('hidden');
    mortgageBtn.classList.remove('hidden');
    tradeBtn.classList.remove('hidden');
  } else if (state.phase === 'after_move') {
    endTurnBtn.classList.remove('hidden');
    mortgageBtn.classList.remove('hidden');
    tradeBtn.classList.remove('hidden');
  } else if (state.phase === 'buying') {
    const t = TILES[state.pendingTile];
    buyBtn.textContent = '买下这块地（¥' + (t ? tilePrice(t) : 0) + '）';
    buyBtn.classList.remove('hidden');
    skipBuyBtn.classList.remove('hidden');
  }
}

function tilePrice(t) {
  if (t.type === 'railroad') return 200;
  if (t.type === 'utility') return 150;
  return t.price || 0;
}

function ownedByMe(t) {
  return state && state.tileOwners[t.id] === myId;
}

// ---------- 盖房 ----------
function getBuildableTiles() {
  if (!state) return [];
  const mine = TILES.filter(t => t.type === 'property' && ownedByMe(t));
  const groups = {};
  mine.forEach(t => { (groups[t.group] ||= []).push(t); });
  const result = [];
  Object.entries(groups).forEach(([group, tiles]) => {
    const all = TILES.filter(t => t.type === 'property' && t.group === group);
    if (!all.every(t => state.tileOwners[t.id] === myId)) return;
    const minH = Math.min(...tiles.map(t => state.tileHouses[t.id] || 0));
    tiles.forEach(t => {
      const h = state.tileHouses[t.id] || 0;
      if (h <= minH && h < 5 && !state.tileMortgaged[t.id]) result.push({ tile: t, houses: h, cost: GROUPS[group].houseCost });
    });
  });
  return result;
}

function renderBuildPanel() {
  buildPanel.innerHTML = '';
  const list = getBuildableTiles();
  if (list.length === 0) { tip(buildPanel, '暂无可盖房的地（需集齐同色整组）'); return; }
  list.forEach(({ tile, houses, cost }) => {
    const row = mkRow(tile.name, houses + ' 级');
    const btn = mkBtn('盖房 ¥' + cost, 'start');
    btn.addEventListener('click', () => ws.send(JSON.stringify({ type: 'build_house', tileId: tile.id })));
    row.appendChild(btn);
    buildPanel.appendChild(row);
  });
}

// ---------- 抵押 ----------
function renderMortgagePanel() {
  mortgagePanel.innerHTML = '';
  const mine = TILES.filter(t => (t.type === 'property' || t.type === 'railroad' || t.type === 'utility') && ownedByMe(t));
  if (mine.length === 0) { tip(mortgagePanel, '你还没有可抵押的地产'); return; }
  mine.forEach(t => {
    const mortgaged = state.tileMortgaged[t.id];
    const hasHouse = (state.tileHouses[t.id] || 0) > 0;
    const status = mortgaged ? '已抵押' : (hasHouse ? '有房' : '');
    const row = mkRow(t.name, status);
    const btn = document.createElement('button');
    btn.className = 'btn';
    if (mortgaged) {
      const cost = Math.floor(Math.floor(tilePrice(t) / 2) * 1.1);
      btn.textContent = '赎回 ¥' + cost;
      btn.addEventListener('click', () => ws.send(JSON.stringify({ type: 'unmortgage', tileId: t.id })));
    } else if (hasHouse) {
      const houses = state.tileHouses[t.id] || 0;
      const refund = Math.floor(GROUPS[t.group].houseCost / 2);
      btn.textContent = '卖房 +¥' + refund;
      btn.classList.add('ghost');
      btn.addEventListener('click', () => ws.send(JSON.stringify({ type: 'sell_house', tileId: t.id })));
    } else {
      const amount = Math.floor(tilePrice(t) / 2);
      btn.textContent = '抵押 ¥' + amount;
      btn.classList.add('ghost');
      btn.addEventListener('click', () => ws.send(JSON.stringify({ type: 'mortgage', tileId: t.id })));
    }
    row.appendChild(btn);
    mortgagePanel.appendChild(row);
  });
}

// ---------- 交易 ----------
function renderTradePanel() {
  tradePanel.innerHTML = '';
  const others = state.players.filter(p => p.id !== myId);
  if (others.length === 0) { tip(tradePanel, '没有可交易的对象'); return; }

  const sel = document.createElement('select');
  others.forEach(p => { const o = document.createElement('option'); o.value = p.id; o.textContent = p.name; sel.appendChild(o); });
  tradePanel.appendChild(mkTitle('交易对象'));
  tradePanel.appendChild(sel);

  tradePanel.appendChild(mkTitle('给对方的地产'));
  const myBox = document.createElement('div');
  TILES.filter(t => (t.type === 'property' || t.type === 'railroad' || t.type === 'utility') && ownedByMe(t)).forEach(t => {
    const hasHouse = (state.tileHouses[t.id] || 0) > 0;
    const lab = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox'; cb.value = t.id; cb.dataset.mine = '1';
    cb.disabled = hasHouse;
    lab.appendChild(cb);
    lab.appendChild(document.createTextNode(t.name + (hasHouse ? '（有房不可交易）' : '')));
    myBox.appendChild(lab);
  });
  tradePanel.appendChild(myBox);

  tradePanel.appendChild(mkTitle('要对方的地产'));
  const theirBox = document.createElement('div');
  function renderTheir() {
    theirBox.innerHTML = '';
    const toId = sel.value;
    TILES.filter(t => (t.type === 'property' || t.type === 'railroad' || t.type === 'utility') && state.tileOwners[t.id] === toId).forEach(t => {
      const hasHouse = (state.tileHouses[t.id] || 0) > 0;
      const lab = document.createElement('label');
      const cb = document.createElement('input');
      cb.type = 'checkbox'; cb.value = t.id; cb.dataset.theirs = '1';
      cb.disabled = hasHouse;
      lab.appendChild(cb);
      lab.appendChild(document.createTextNode(t.name + (hasHouse ? '（有房不可交易）' : '')));
      theirBox.appendChild(lab);
    });
  }
  renderTheir();
  sel.addEventListener('change', renderTheir);
  tradePanel.appendChild(theirBox);

  const moneyGive = mkMoneyInput('我给对方的现金');
  const moneyGet = mkMoneyInput('我要对方的现金');
  tradePanel.appendChild(moneyGive);
  tradePanel.appendChild(moneyGet);

  const submit = mkBtn('发起交易提议', 'primary');
  submit.addEventListener('click', () => {
    const giveTiles = [...myBox.querySelectorAll('input:checked')].map(i => Number(i.value));
    const getTiles = [...theirBox.querySelectorAll('input:checked')].map(i => Number(i.value));
    ws.send(JSON.stringify({
      type: 'propose_trade',
      proposal: { to: sel.value, giveTiles, getTiles, giveMoney: Number(moneyGive.value) || 0, getMoney: Number(moneyGet.value) || 0 }
    }));
    tradePanel.classList.add('hidden');
  });
  tradePanel.appendChild(submit);
}

function renderAuctionPanel() {
  auctionPanel.classList.remove('hidden');
  auctionPanel.innerHTML = '';
  const a = state.auction;
  if (!a) return;
  const tile = TILES[a.tileId];
  const bidder = a.currentBidder ? state.players.find(p => p.id === a.currentBidder) : null;
  const title = document.createElement('div');
  title.className = 'p-title';
  title.textContent = '🔨 公开拍卖：' + tile.name + '（原价 ¥' + tilePrice(tile) + '）';
  auctionPanel.appendChild(title);
  const info = document.createElement('div');
  info.className = 'offer-box';
  info.textContent = '当前价 ¥' + a.currentBid + (bidder ? '（' + bidder.name + ' 出价）' : '（无人出价）');
  auctionPanel.appendChild(info);
  if (!isSpectator) {
    const row = document.createElement('div');
    row.className = 'trade-row';
    const input = document.createElement('input');
    input.type = 'number';
    input.min = a.currentBid + 1;
    input.placeholder = '出价（> ¥' + a.currentBid + '）';
    const btn = mkBtn('出价', 'start');
    btn.addEventListener('click', () => ws.send(JSON.stringify({ type: 'bid', amount: Number(input.value) })));
    row.appendChild(input); row.appendChild(btn);
    auctionPanel.appendChild(row);
  }
}

function renderTradeOffer() {
  tradeOffer.innerHTML = '';
  const t = state && state.pendingTrade;
  if (!t) { tradeOffer.classList.add('hidden'); return; }
  tradeOffer.classList.remove('hidden');
  const from = state.players.find(p => p.id === t.from);
  const to = state.players.find(p => p.id === t.to);
  const box = document.createElement('div');
  box.className = 'offer-box';
  const parts = [];
  if (t.giveTiles.length) parts.push('给 ' + t.giveTiles.map(id => TILES[id].name).join('、'));
  if (t.getTiles.length) parts.push('要 ' + t.getTiles.map(id => TILES[id].name).join('、'));
  if (t.giveMoney) parts.push('给对方 ¥' + t.giveMoney);
  if (t.getMoney) parts.push('要对方 ¥' + t.getMoney);
  box.textContent = from.name + ' 提议 ' + (to ? to.name : '') + '：' + (parts.join('；') || '空交易');
  tradeOffer.appendChild(box);

  const acts = document.createElement('div');
  acts.className = 'offer-actions';
  if (t.to === myId) {
    const ok = mkBtn('接受', 'start');
    ok.addEventListener('click', () => ws.send(JSON.stringify({ type: 'accept_trade' })));
    const no = mkBtn('拒绝', 'ghost');
    no.addEventListener('click', () => ws.send(JSON.stringify({ type: 'reject_trade' })));
    acts.appendChild(ok); acts.appendChild(no);
  } else if (t.from === myId) {
    const cancel = mkBtn('取消提议', 'ghost');
    cancel.addEventListener('click', () => ws.send(JSON.stringify({ type: 'reject_trade' })));
    acts.appendChild(cancel);
  }
  tradeOffer.appendChild(acts);
}

// ---------- 工具 ----------
function mkRow(name, status) {
  const row = document.createElement('div');
  row.className = 'build-row';
  const n = document.createElement('span'); n.className = 'b-name'; n.textContent = name;
  const s = document.createElement('span'); s.className = 'b-level'; s.textContent = status || '';
  row.appendChild(n); row.appendChild(s);
  return row;
}
function mkBtn(text, cls) {
  const b = document.createElement('button');
  b.className = 'btn ' + (cls || '');
  b.textContent = text;
  return b;
}
function mkTitle(text) {
  const d = document.createElement('div');
  d.className = 'p-title'; d.textContent = text;
  return d;
}
function mkMoneyInput(placeholder) {
  const i = document.createElement('input');
  i.type = 'number'; i.min = '0'; i.placeholder = placeholder;
  return i;
}
function tip(el, text) {
  const d = document.createElement('div');
  d.className = 'waiting-tip'; d.textContent = text;
  el.appendChild(d);
}

// ---------- 渲染 ----------
function renderPlayers() {
  playerCount.textContent = players.length + '/8';
  gamePlayerCount.textContent = players.length + '/8';
  playerList.innerHTML = '';
  gamePlayerList.innerHTML = '';
  const curId = state ? state.players[state.current].id : null;
  players.forEach((p) => {
    const li = document.createElement('li');
    li.innerHTML = `<span class="dot" style="background:${p.color}"></span><span class="p-name">${escapeHtml(p.name)}</span>${p.isHost ? '<span class="tag">房主</span>' : ''}${p.id === myId ? '<span class="tag me">我</span>' : ''}`;
    playerList.appendChild(li);
    const sp = state ? state.players.find(s => s.id === p.id) : null;
    const isCur = p.id === curId;
    const li2 = document.createElement('li');
    if (isCur) li2.classList.add('current');
    li2.innerHTML = `<span class="dot" style="background:${p.color}"></span><span class="p-name">${escapeHtml(p.name)}</span>${sp && sp.bankrupt ? '<span class="tag">破产</span>' : ''}${isCur ? '<span class="tag turn">回合中</span>' : ''}<span class="p-money">¥${sp ? sp.money : 1500}</span>`;
    gamePlayerList.appendChild(li2);
  });
}

function updateStartBtn(canStart) {
  if (myIsHost) { startBtn.disabled = !canStart; startBtn.textContent = canStart ? '开始游戏' : '等待玩家加入（至少 2 人）'; }
  else { startBtn.disabled = true; startBtn.textContent = '等待房主开始...'; }
}

function updateTurnInfo() {
  if (!state) { turnTitle.textContent = '等待开始'; turnSub.textContent = ''; return; }
  if (isSpectator) { turnTitle.textContent = '👀 正在旁观'; turnSub.textContent = ''; return; }
  if (state.phase === 'gameOver') {
    const w = state.players.find(p => p.id === state.winner);
    turnTitle.textContent = '🏆 游戏结束';
    turnTitle.style.color = '#f7d774';
    turnSub.textContent = w ? (w.name + ' 获胜！') : '平局';
    return;
  }
  const cur = state.players[state.current];
  const me = state.players.find(p => p.id === myId);
  turnTitle.textContent = cur.id === myId ? '轮到你行动！' : ('轮到 ' + cur.name);
  turnTitle.style.color = cur.color;
  turnSub.textContent = '第 ' + state.round + ' 回合 · 你的资金 ¥' + (me ? me.money : 0);
}

function renderDice() {
  diceDisplay.textContent = state && state.dice ? state.dice.map(d => DICE_FACES[d - 1]).join(' ') : '';
}

const EVENT_DESC = {
  lottery: '🎰 彩票：随机中奖 +¥100 或亏 ¥100',
  teleport: '✨ 传送：被传送到随机一格',
  festival: '🎉 节日：全场每人 +¥50',
  bonus: '🎁 奖金：直接 +¥100',
  shop: '🛍️ 商店：返现 +¥80',
  again: '🔁 再来一次：额外再掷一次骰子',
  fine: '💸 罚款：缴纳 -¥80',
  advance: '⏩ 前进：额外前进 3 步',
  auction: '🔨 拍卖行：随机一块无主地进入拍卖',
  rest: '😴 休息：下回合跳过',
  bank: '🏦 银行：存款利息 +¥50',
  backward: '⏪ 后退：后退 3 步',
};

function renderDeed(tileId) {
  const tile = TILES[tileId];
  if (!tile) return;
  let html = '';
  const ownerId = state.tileOwners[tileId] || null;
  const owner = ownerId ? state.players.find(p => p.id === ownerId) : null;

  if (tile.type === 'property') {
    const g = GROUPS[tile.group];
    html += '<div class="deed-band" style="background:' + g.color + '"></div>';
    html += '<div class="deed-title">' + tile.name + '</div>';
    html += '<div class="deed-note">' + g.name + '组 · 地价 ¥' + tile.price + ' · 建一栋房 ¥' + g.houseCost + '</div>';
    if (owner) {
      const houses = state.tileHouses[tileId] || 0;
      html += '<div class="deed-owner" style="background:' + owner.color + '33;color:' + owner.color + '">👤 ' + owner.name + ' 持有 · ' + houses + ' 房</div>';
    }
    html += '<div class="deed-title" style="font-size:15px;margin-top:4px">过路费（租金）</div>';
    const names = ['空地', '1 房', '2 房', '3 房', '4 房', '旅馆'];
    for (let lv = 0; lv <= 5; lv++) {
      html += '<div class="deed-row"><span class="k">' + names[lv] + '</span><span class="v">¥' + tile.rent[lv] + '</span></div>';
    }
    html += '<div class="deed-note">集齐同色整组（垄断）后，空地过路费 ×2</div>';
    html += '<div class="deed-row"><span class="k">抵押价</span><span class="v">¥' + Math.floor(tile.price / 2) + '</span></div>';
    html += '<div class="deed-row"><span class="k">赎回价</span><span class="v">¥' + Math.floor(Math.floor(tile.price / 2) * 1.1) + '</span></div>';
  } else if (tile.type === 'railroad') {
    html += '<div class="deed-band" style="background:#78909C"></div>';
    html += '<div class="deed-title">' + tile.name + '（车站）</div>';
    html += '<div class="deed-note">地价 ¥200</div>';
    if (owner) html += '<div class="deed-owner" style="background:' + owner.color + '33;color:' + owner.color + '">👤 ' + owner.name + ' 持有</div>';
    html += '<div class="deed-title" style="font-size:15px;margin-top:4px">过路费（按持有车站数）</div>';
    [25, 50, 100, 200].forEach((r, i) => {
      html += '<div class="deed-row"><span class="k">持有 ' + (i + 1) + ' 个车站</span><span class="v">¥' + r + '</span></div>';
    });
    html += '<div class="deed-row"><span class="k">抵押价</span><span class="v">¥100</span></div>';
    html += '<div class="deed-row"><span class="k">赎回价</span><span class="v">¥110</span></div>';
  } else if (tile.type === 'utility') {
    html += '<div class="deed-band" style="background:#90A4AE"></div>';
    html += '<div class="deed-title">' + tile.name + '（公共事业）</div>';
    html += '<div class="deed-note">地价 ¥150</div>';
    if (owner) html += '<div class="deed-owner" style="background:' + owner.color + '33;color:' + owner.color + '">👤 ' + owner.name + ' 持有</div>';
    html += '<div class="deed-title" style="font-size:15px;margin-top:4px">过路费（按骰点 × 倍数）</div>';
    html += '<div class="deed-row"><span class="k">持有 1 个</span><span class="v">骰点 ×4</span></div>';
    html += '<div class="deed-row"><span class="k">持有 2 个</span><span class="v">骰点 ×10</span></div>';
    html += '<div class="deed-row"><span class="k">抵押价</span><span class="v">¥75</span></div>';
    html += '<div class="deed-row"><span class="k">赎回价</span><span class="v">¥83</span></div>';
  } else {
    const [c1] = { go: ['#FF7043'], chance: ['#FFB74D'], chest: ['#4DB6AC'], tax: ['#B39DDB'], jail: ['#546E7A'], gotojail: ['#37474F'], freeparking: ['#81C784'], event: ['#9575CD'] }[tile.type] || ['#90A4AE'];
    html += '<div class="deed-band" style="background:' + c1 + '"></div>';
    html += '<div class="deed-title">' + tile.name + '</div>';
    if (tile.type === 'tax') html += '<div class="deed-note">停在此格需缴纳 ¥' + tile.amount + '</div>';
    else if (tile.type === 'chance') html += '<div class="deed-note">抽一张机会卡，随机触发奖励或惩罚</div>';
    else if (tile.type === 'chest') html += '<div class="deed-note">抽一张命运卡，随机触发奖励或惩罚</div>';
    else if (tile.type === 'go') html += '<div class="deed-note">经过起点可获得 ¥200</div>';
    else if (tile.type === 'gotojail') html += '<div class="deed-note">停在此格会被送进监狱</div>';
    else if (tile.type === 'jail') html += '<div class="deed-note">监狱：路过探监，不影响行动</div>';
    else if (tile.type === 'freeparking') html += '<div class="deed-note">免费停车：在此休息，无任何效果</div>';
    else if (tile.type === 'event') html += '<div class="deed-note">' + (EVENT_DESC[tile.sub] || '趣味事件格') + '</div>';
  }

  deedContent.innerHTML = html;
  deedModal.classList.remove('hidden');
}

function detectCard() {
  if (!state || !state.lastCard) return;
  const key = state.lastCard.type + '|' + state.lastCard.text;
  if (prevLastCard === key) return;
  prevLastCard = key;
  showCard(state.lastCard);
}

function showCard(card) {
  const isChance = card.type === 'chance';
  cardPopupTitle.textContent = isChance ? '❓ 机会' : '🍀 命运';
  cardPopupTitle.style.color = isChance ? '#FFB74D' : '#4DB6AC';
  cardPopupText.textContent = card.text;
  cardPopup.classList.remove('hidden');
  if (cardTimer) clearTimeout(cardTimer);
  cardTimer = setTimeout(() => cardPopup.classList.add('hidden'), 2500);
}

function detectSound() {
  if (!state || !state.log) return;
  if (state.log.length <= prevLogLength) return;
  const newLogs = state.log.slice(prevLogLength);
  prevLogLength = state.log.length;
  newLogs.forEach((l) => playForLog(l));
}

function renderLog() {
  logList.innerHTML = '';
  if (!state || !state.log) return;
  state.log.slice(-30).forEach((line) => {
    const li = document.createElement('li');
    li.textContent = line;
    logList.appendChild(li);
  });
}

function setMsg(text, isError) { lobbyMsg.textContent = text; lobbyMsg.className = 'msg' + (isError ? ' error' : ''); }

function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }



