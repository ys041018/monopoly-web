// ============================================================
// 前端主逻辑：WebSocket + 大厅/游戏 + 回合操作 + 盖房/抵押/交易
// ============================================================
import { render, animateMove } from './board2d.js';

window.addEventListener('error', (e) => {
  const t = document.getElementById('turn-sub');
  if (t) t.textContent = '⚠️ ' + (e.message || '未知错误') + ' @ ' + (e.filename||'').split('/').pop() + ':' + e.lineno;
});
import { TILES, GROUPS } from './data/tiles.js';

const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
const ws = new WebSocket(`${proto}//${location.host}`);

const $ = (id) => document.getElementById(id);
const lobby = $('lobby'), game = $('game');
const nameInput = $('name-input'), joinBtn = $('join-btn'), startBtn = $('start-btn'), lobbyBtn = $('lobby-btn');
const rollBtn = $('roll-btn'), buyBtn = $('buy-btn'), skipBuyBtn = $('skip-buy-btn'), endTurnBtn = $('end-turn-btn');
const buildBtn = $('build-btn'), mortgageBtn = $('mortgage-btn'), tradeBtn = $('trade-btn');
const buildPanel = $('build-panel'), mortgagePanel = $('mortgage-panel'), tradePanel = $('trade-panel'), tradeOffer = $('trade-offer');
const waitingTip = $('waiting-tip'), diceDisplay = $('dice-display');
const lobbyMsg = $('lobby-msg'), playerList = $('player-list'), playerCount = $('player-count');
const gamePlayerList = $('game-player-list'), gamePlayerCount = $('game-player-count');
const logList = $('log-list'), turnTitle = $('turn-title'), turnSub = $('turn-sub');

const DICE_FACES = ['⚀', '⚁', '⚂', '⚃', '⚄', '⚅'];

let myId = null, myIsHost = false, isSpectator = false;
let players = [], state = null;
let gotError = false, entered = false, animating = false;

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
  render(state);
  refresh();
}

function syncGame() {
  const lm = state.lastMove;
  if (lm && !animating) {
    animating = true;
    hideAllActions();
    render(state);
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
  [buildPanel, mortgagePanel, tradePanel].forEach(p => p.classList.add('hidden'));
  waitingTip.classList.add('hidden');
}

function updateActions() {
  hideAllActions();
  if (!state) return;
  if (state.phase === 'gameOver') { waitingTip.textContent = '游戏已结束'; waitingTip.classList.remove('hidden'); return; }
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
  playerCount.textContent = players.length + '/6';
  gamePlayerCount.textContent = players.length + '/6';
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



