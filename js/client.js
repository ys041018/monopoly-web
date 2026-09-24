// ============================================================
// 前端主逻辑：WebSocket + 大厅/游戏 + 回合操作 + 盖房/抵押/交易
// ============================================================
import { render, animateMove, animateDice, onTileClick, setBoardTheme, setActiveMap } from './board2d.js';

window.addEventListener('error', (e) => {
  const t = document.getElementById('turn-sub');
  if (t) t.textContent = '⚠️ ' + (e.message || '未知错误') + ' @ ' + (e.filename||'').split('/').pop() + ':' + e.lineno;
});
import { GROUPS } from './data/tiles.js';
import { getMap } from './data/maps.js';
let activeTiles = getMap('standard').tiles;
import { playForLog, play, setSoundEnabled, isSoundEnabled } from './sound.js';

const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
const ws = new WebSocket(`${proto}//${location.host}`);

const $ = (id) => document.getElementById(id);
const lobby = $('lobby'), game = $('game');
const nameInput = $('name-input'), roomInput = $('room-input'), joinBtn = $('join-btn'), startBtn = $('start-btn'), lobbyBtn = $('lobby-btn');
const addAiBtn = $('add-ai-btn');
const hotkeyBtn = $('hotkey-btn'), hotkeyPanel = $('hotkey-panel');
const authPanel = $('auth-panel'), authInfo = $('auth-info'), authUser = $('auth-user'), authPass = $('auth-pass'), authNick = $('auth-nick'), authMsg = $('auth-msg'), authName = $('auth-name');
const authLoginBtn = $('auth-login-btn'), authRegisterBtn = $('auth-register-btn'), authLogoutBtn = $('auth-logout-btn'), authStats = $('auth-stats');
const createRoomBtn = $('create-room-btn');
const themeSelect = $('theme-select');
const roomSettings = $('room-settings'), setMoney = $('set-money'), setRounds = $('set-rounds'), setHouse = $('set-house'), setMap = $('set-map');
const soundToggle = $('sound-toggle'), copyRoomBtn = $('copy-room-btn');
const rollBtn = $('roll-btn'), buyBtn = $('buy-btn'), skipBuyBtn = $('skip-buy-btn'), endTurnBtn = $('end-turn-btn');
const buildBtn = $('build-btn'), mortgageBtn = $('mortgage-btn'), tradeBtn = $('trade-btn');
const bailBtn = $('bail-btn'), jailcardBtn = $('jailcard-btn');
const buildPanel = $('build-panel'), mortgagePanel = $('mortgage-panel'), tradePanel = $('trade-panel'), tradeOffer = $('trade-offer'), auctionPanel = $('auction-panel');
const waitingTip = $('waiting-tip'), diceDisplay = $('dice-display');
const lobbyMsg = $('lobby-msg'), playerList = $('player-list'), playerCount = $('player-count');
const gamePlayerList = $('game-player-list'), gamePlayerCount = $('game-player-count');
const logList = $('log-list'), turnTitle = $('turn-title'), turnSub = $('turn-sub');
const deedModal = $('deed-modal'), deedContent = $('deed-content'), deedClose = $('deed-close');
const cardPopup = $('card-popup'), cardPopupTitle = $('card-popup-title'), cardPopupText = $('card-popup-text');

const DICE_FACES = ['⚀', '⚁', '⚂', '⚃', '⚄', '⚅'];

let myId = null, myIsHost = false, isSpectator = false;
let authToken = localStorage.getItem('monopoly_token') || null;
if (localStorage.getItem('monopoly_sound') === '0') { setSoundEnabled(false); }
let players = [], state = null;
let gotError = false, entered = false, animating = false;
let lastSoundLog = null;
let lastLogText = null;
let prevLastCard = null;
let roomSettingsData = null;
let cardTimer = null;

// ---------- 自动重连 ----------
(function autoRejoin() {
  const savedId = sessionStorage.getItem('monopoly_player_id');
  const savedName = sessionStorage.getItem('monopoly_player_name');
  if (!savedId || !savedName) return;
  const savedRoom = sessionStorage.getItem('monopoly_room') || '';
  nameInput.value = savedName;
  if (roomInput) roomInput.value = savedRoom;
  const send = () => {
    gotError = false;
    ws.send(JSON.stringify({ type: 'join', name: savedName, playerId: savedId, roomCode: savedRoom, token: authToken || undefined }));
    joinBtn.disabled = true;
    setMsg('正在重连...');
  };
  if (ws.readyState === 1) send();
  else ws.addEventListener('open', send);
})();

// ---------- 发送 ----------
joinBtn.addEventListener('click', () => {
  const name = nameInput.value.trim();
  if (!name) { setMsg('请输入昵称', true); return; }
  const roomCode = roomInput.value.trim();
  sessionStorage.setItem('monopoly_room', roomCode);
  gotError = false;
  ws.send(JSON.stringify({ type: 'join', name, playerId: sessionStorage.getItem('monopoly_player_id') || undefined, roomCode, token: authToken || undefined }));
  joinBtn.disabled = true;
  setMsg('正在加入...');
});
startBtn.addEventListener('click', () => ws.send(JSON.stringify({ type: 'start_game' })));
addAiBtn.addEventListener('click', () => ws.send(JSON.stringify({ type: 'add_ai' })));
createRoomBtn.addEventListener('click', () => {
  const name = nameInput.value.trim();
  if (!name) { setMsg('请先输入昵称', true); return; }
  ws.send(JSON.stringify({ type: 'create_room' }));
});
soundToggle.addEventListener('click', () => { const on = !isSoundEnabled(); setSoundEnabled(on); soundToggle.textContent = on ? '🔊' : '🔇'; localStorage.setItem('monopoly_sound', on ? '1' : '0'); });
copyRoomBtn.addEventListener('click', async () => { try { await navigator.clipboard.writeText(roomInput.value.trim()); copyRoomBtn.textContent = '已复制'; setTimeout(() => copyRoomBtn.textContent = '复制', 1200); } catch {} });
lobbyBtn.addEventListener('click', () => ws.send(JSON.stringify({ type: 'back_to_lobby' })));

// 点击棋盘格子查看地契
onTileClick((id) => { if (state) renderDeed(id); });
deedClose.addEventListener('click', () => deedModal.classList.add('hidden'));
deedModal.addEventListener('click', (e) => { if (e.target === deedModal) deedModal.classList.add('hidden'); });
rollBtn.addEventListener('click', () => ws.send(JSON.stringify({ type: 'roll_dice' })));
bailBtn.addEventListener('click', () => ws.send(JSON.stringify({ type: 'pay_bail' })));
jailcardBtn.addEventListener('click', () => ws.send(JSON.stringify({ type: 'use_jail_card' })));
buyBtn.addEventListener('click', () => ws.send(JSON.stringify({ type: 'buy_property' })));
skipBuyBtn.addEventListener('click', () => ws.send(JSON.stringify({ type: 'skip_buy' })));
endTurnBtn.addEventListener('click', () => ws.send(JSON.stringify({ type: 'end_turn' })));
buildBtn.addEventListener('click', () => { toggle(buildPanel); if (!buildPanel.classList.contains('hidden')) renderBuildPanel(); });
mortgageBtn.addEventListener('click', () => { toggle(mortgagePanel); if (!mortgagePanel.classList.contains('hidden')) renderMortgagePanel(); });
tradeBtn.addEventListener('click', () => { toggle(tradePanel); if (!tradePanel.classList.contains('hidden')) renderTradePanel(); });

authLoginBtn.addEventListener('click', () => {
  if (!authUser.value.trim() || !authPass.value) { authMsg.textContent = '请输入用户名和密码'; authMsg.className = 'msg error'; return; }
  authMsg.textContent = '登录中...'; authMsg.className = 'msg';
  ws.send(JSON.stringify({ type: 'login', username: authUser.value.trim(), password: authPass.value }));
});
authRegisterBtn.addEventListener('click', () => {
  if (!authUser.value.trim() || !authPass.value) { authMsg.textContent = '请输入用户名和密码'; authMsg.className = 'msg error'; return; }
  authMsg.textContent = '注册中...'; authMsg.className = 'msg';
  ws.send(JSON.stringify({ type: 'register', username: authUser.value.trim(), password: authPass.value, nickname: authNick.value.trim() || authUser.value.trim() }));
});
authLogoutBtn.addEventListener('click', () => {
  if (authToken) ws.send(JSON.stringify({ type: 'logout', token: authToken }));
  authToken = null; localStorage.removeItem('monopoly_token');
  authPanel.classList.remove('hidden'); authInfo.classList.add('hidden');
  authMsg.textContent = ''; authPass.value = '';
});
ws.addEventListener('open', () => { if (authToken) ws.send(JSON.stringify({ type: 'auth', token: authToken })); });

function toggle(el) { el.classList.toggle('hidden'); }
hotkeyBtn.addEventListener('click', () => toggle(hotkeyPanel));

[setMoney, setRounds, setHouse, setMap].forEach(el => el && el.addEventListener('change', sendSettings));

if (authToken) { authPanel.classList.add('hidden'); authInfo.classList.remove('hidden'); }

// ---------- 棋盘主题 ----------
(function initTheme() {
  const saved = localStorage.getItem('monopoly_theme') || 'classic';
  if (themeSelect) themeSelect.value = saved;
  setBoardTheme(saved);
  if (themeSelect) themeSelect.addEventListener('change', () => {
    setBoardTheme(themeSelect.value);
    localStorage.setItem('monopoly_theme', themeSelect.value);
    if (state) render(state);
  });
})();

// ---------- 键盘快捷键 ----------
document.addEventListener('keydown', (e) => {
  const tag = (e.target && e.target.tagName) || '';
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
  const shown = (el) => el && !el.classList.contains('hidden');
  if (e.code === 'Space') { if (shown(rollBtn)) { e.preventDefault(); rollBtn.click(); } }
  else if (e.key === 'b' || e.key === 'B') { if (shown(buyBtn)) buyBtn.click(); }
  else if (e.key === 'e' || e.key === 'E') { if (shown(endTurnBtn)) endTurnBtn.click(); }
  else if (e.key === 'm' || e.key === 'M') { if (shown(mortgageBtn)) mortgageBtn.click(); }
  else if (e.key === 't' || e.key === 'T') { if (shown(tradeBtn)) tradeBtn.click(); }
  else if (e.key === 'g' || e.key === 'G') { if (shown(buildBtn)) buildBtn.click(); }
});

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
      if (!isSpectator && msg.player) {
        sessionStorage.setItem('monopoly_player_id', msg.player.id);
        sessionStorage.setItem('monopoly_player_name', msg.player.name);
      } else if (isSpectator) {
        sessionStorage.removeItem('monopoly_player_id');
        sessionStorage.removeItem('monopoly_player_name');
      }
      renderPlayers();
      renderRoomSettings();
      break;
    case 'auth_ok':
      authToken = msg.token; localStorage.setItem('monopoly_token', msg.token);
      authPanel.classList.add('hidden'); authInfo.classList.remove('hidden');
      authName.textContent = msg.user.nickname;
      nameInput.value = msg.user.nickname;
      authMsg.textContent = ''; authMsg.className = 'msg';
      ws.send(JSON.stringify({ type: 'get_stats', token: msg.token }));
      break;
    case 'auth_error':
      authMsg.textContent = msg.message; authMsg.className = 'msg error';
      break;
    case 'stats': {
      const st = msg.stats || {};
      if (authStats) authStats.textContent = ' · 战绩 ' + (st.wins || 0) + ' 胜 / ' + (st.losses || 0) + ' 负 · 最高资产 ¥' + (st.max_assets || 0);
      break;
    }
    case 'auth_logout':
      authPanel.classList.remove('hidden'); authInfo.classList.add('hidden');
      break;
    case 'room_created':
      sessionStorage.setItem('monopoly_room', msg.roomCode);
      roomInput.value = msg.roomCode;
      gotError = false;
      ws.send(JSON.stringify({ type: 'join', name: nameInput.value.trim(), roomCode: msg.roomCode }));
      joinBtn.disabled = true;
      setMsg('已创建房间 ' + msg.roomCode + '，正在加入...');
      break;
    case 'player_list':
      players = msg.players;
      if (msg.settings) roomSettingsData = msg.settings;
      renderPlayers();
      renderRoomSettings();
      updateStartBtn(msg.canStart);
      break;
    case 'game_state':
      state = msg.state;
      if (state.mapId) { setActiveMap(state.mapId); activeTiles = getMap(state.mapId).tiles; }
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
  tradePanel.classList.add('hidden');
  lastSoundLog = state.log && state.log.length ? state.log[state.log.length - 1] : null;
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
  render(state);
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
  [rollBtn, buyBtn, skipBuyBtn, endTurnBtn, buildBtn, mortgageBtn, tradeBtn, bailBtn, jailcardBtn].forEach(b => b.classList.add('hidden'));
  [buildPanel, mortgagePanel, auctionPanel].forEach(p => p.classList.add('hidden'));
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
    const me = state.players.find(p => p.id === myId);
    if (me && me.inJail) {
      rollBtn.textContent = '🎲 掷骰子（双数出狱）';
      rollBtn.classList.remove('hidden');
      if (me.money >= 50) bailBtn.classList.remove('hidden');
      if ((me.outOfJailCards || 0) > 0) jailcardBtn.classList.remove('hidden');
      tradeBtn.classList.remove('hidden');
      return;
    }
    rollBtn.textContent = '🎲 掷骰子';
    rollBtn.classList.remove('hidden');
    if (getBuildableTiles().length > 0) buildBtn.classList.remove('hidden');
    mortgageBtn.classList.remove('hidden');
    tradeBtn.classList.remove('hidden');
  } else if (state.phase === 'after_move') {
    endTurnBtn.classList.remove('hidden');
    mortgageBtn.classList.remove('hidden');
    tradeBtn.classList.remove('hidden');
  } else if (state.phase === 'buying') {
    const t = activeTiles[state.pendingTile];
    buyBtn.textContent = '买下这块地（¥' + (t ? tilePrice(t) : 0) + '）';
    buyBtn.classList.remove('hidden');
    skipBuyBtn.classList.remove('hidden');
  }
}

function updateAuctionTimer() {
  const el = document.getElementById('auction-timer');
  if (!el || !state || !state.auction) return;
  const remain = Math.max(0, Math.ceil((state.auction.deadline - Date.now()) / 1000));
  el.textContent = '⏳ 倒计时：' + remain + ' 秒';
}

setInterval(() => {
  if (state && state.phase === 'auction' && !auctionPanel.classList.contains('hidden')) updateAuctionTimer();
}, 500);

function tilePrice(t) {
  if (t.type === 'railroad') return 200;
  if (t.type === 'utility') return 300;
  return t.price || 0;
}

function ownedByMe(t) {
  return state && state.tileOwners[t.id] === myId;
}

// ---------- 盖房 ----------
function getBuildableTiles() {
  if (!state) return [];
  const mine = activeTiles.filter(t => t.type === 'property' && ownedByMe(t));
  const groups = {};
  mine.forEach(t => { (groups[t.group] ||= []).push(t); });
  const result = [];
  Object.entries(groups).forEach(([group, tiles]) => {
    const all = activeTiles.filter(t => t.type === 'property' && t.group === group);
    if (!all.every(t => state.tileOwners[t.id] === myId)) return;
    const minH = Math.min(...tiles.map(t => state.tileHouses[t.id] || 0));
    tiles.forEach(t => {
      const h = state.tileHouses[t.id] || 0;
      if (h <= minH && h < 5 && !state.tileMortgaged[t.id]) result.push({ tile: t, houses: h, cost: GROUPS[group].houseCost });
    });
  });
  return result;
}

function canBuildOn(tileId) {
  if (!state) return false;
  const tile = activeTiles[tileId];
  if (!tile || tile.type !== 'property') return false;
  if (state.tileOwners[tileId] !== myId) return false;
  if (state.tileMortgaged[tileId]) return false;
  const h = state.tileHouses[tileId] || 0;
  if (h >= 5) return false;
  const groupTiles = activeTiles.filter(t => t.type === 'property' && t.group === tile.group);
  if (!groupTiles.every(t => state.tileOwners[t.id] === myId)) return false;
  const minH = Math.min(...groupTiles.map(t => state.tileHouses[t.id] || 0));
  if (h > minH) return false;
  const myTurn = !isSpectator && state.players[state.current].id === myId;
  if (!myTurn) return false;
  return state.phase === 'rolling' || state.phase === 'after_move';
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
  const mine = activeTiles.filter(t => (t.type === 'property' || t.type === 'railroad' || t.type === 'utility') && ownedByMe(t));
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
  const others = state.players.filter(p => p.id !== myId && !p.bankrupt);
  if (others.length === 0) { tip(tradePanel, '没有可交易的对象'); return; }

  // 交易对象
  tradePanel.appendChild(mkTitle('交易对象'));
  const sel = document.createElement('select');
  others.forEach(p => { const o = document.createElement('option'); o.value = p.id; o.textContent = p.name + '（¥' + p.money + '）'; sel.appendChild(o); });
  tradePanel.appendChild(sel);

  // 我给对方的地产
  tradePanel.appendChild(mkTitle('我给对方的地产'));
  const myBox = document.createElement('div');
  myBox.className = 'trade-tiles';
  activeTiles.filter(t => (t.type === 'property' || t.type === 'railroad' || t.type === 'utility') && ownedByMe(t)).forEach(t => {
    const hasHouse = (state.tileHouses[t.id] || 0) > 0;
    const lab = document.createElement('label');
    lab.className = 'trade-tile';
    if (t.type === 'property') lab.style.borderLeftColor = GROUPS[t.group].color;
    const cb = document.createElement('input');
    cb.type = 'checkbox'; cb.value = t.id; cb.dataset.mine = '1';
    cb.disabled = hasHouse;
    lab.appendChild(cb);
    const info = document.createElement('span');
    info.className = 'trade-tile-info';
    info.innerHTML = '<b>' + escapeHtml(t.name) + '</b><i>¥' + tilePrice(t) + (hasHouse ? ' · 有房不可交易' : '') + '</i>';
    lab.appendChild(info);
    myBox.appendChild(lab);
  });
  tradePanel.appendChild(myBox);

  // 要对方的地产
  tradePanel.appendChild(mkTitle('要对方的地产'));
  const theirBox = document.createElement('div');
  theirBox.className = 'trade-tiles';
  function renderTheir() {
    theirBox.innerHTML = '';
    const toId = sel.value;
    activeTiles.filter(t => (t.type === 'property' || t.type === 'railroad' || t.type === 'utility') && state.tileOwners[t.id] === toId).forEach(t => {
      const hasHouse = (state.tileHouses[t.id] || 0) > 0;
      const lab = document.createElement('label');
      lab.className = 'trade-tile';
      if (t.type === 'property') lab.style.borderLeftColor = GROUPS[t.group].color;
      const cb = document.createElement('input');
      cb.type = 'checkbox'; cb.value = t.id; cb.dataset.theirs = '1';
      cb.disabled = hasHouse;
      lab.appendChild(cb);
      const info = document.createElement('span');
      info.className = 'trade-tile-info';
      info.innerHTML = '<b>' + escapeHtml(t.name) + '</b><i>¥' + tilePrice(t) + (hasHouse ? ' · 有房不可交易' : '') + '</i>';
      lab.appendChild(info);
      theirBox.appendChild(lab);
    });
    const to = state.players.find(p => p.id === toId);
    if (to) {
      const bal = document.createElement('div');
      bal.className = 'trade-bal';
      bal.textContent = to.name + ' 现金：¥' + to.money;
      theirBox.appendChild(bal);
    }
  }
  renderTheir();
  sel.addEventListener('change', renderTheir);
  tradePanel.appendChild(theirBox);

  // 现金
  tradePanel.appendChild(mkTitle('现金（可选）'));
  const me = state.players.find(p => p.id === myId);
  const bal = document.createElement('div');
  bal.className = 'trade-bal';
  bal.textContent = '我的现金：¥' + (me ? me.money : 0);
  tradePanel.appendChild(bal);
  const moneyGive = mkMoneyInput('我给对方现金');
  const moneyGet = mkMoneyInput('我要对方现金');
  moneyGive.className = 'money-input';
  moneyGet.className = 'money-input';
  tradePanel.appendChild(moneyGive);
  tradePanel.appendChild(moneyGet);

  // 实时汇总
  const summary = document.createElement('div');
  summary.className = 'trade-summary';
  const upd = () => {
    const gt = myBox.querySelectorAll('input:checked').length;
    const rt = theirBox.querySelectorAll('input:checked').length;
    const gm = Number(moneyGive.value) || 0;
    const rm = Number(moneyGet.value) || 0;
    summary.textContent = '我给出 ' + gt + ' 块地 + ¥' + gm + '，换对方 ' + rt + ' 块地 + ¥' + rm;
  };
  [myBox, theirBox, moneyGive, moneyGet].forEach(el => el.addEventListener('change', upd));
  upd();
  tradePanel.appendChild(summary);

  // 提交
  const submit = mkBtn('发起交易提议', 'start');
  submit.className = 'btn start trade-submit';
  submit.addEventListener('click', () => {
    const giveTiles = [...myBox.querySelectorAll('input:checked')].map(i => Number(i.value));
    const getTiles = [...theirBox.querySelectorAll('input:checked')].map(i => Number(i.value));
    const giveMoney = Number(moneyGive.value) || 0;
    const getMoney = Number(moneyGet.value) || 0;
    if (giveTiles.length === 0 && getTiles.length === 0 && giveMoney === 0 && getMoney === 0) {
      summary.textContent = '⚠️ 请至少选择一块地产或填写现金';
      return;
    }
    ws.send(JSON.stringify({
      type: 'propose_trade',
      proposal: { to: sel.value, giveTiles, getTiles, giveMoney, getMoney }
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
  const tile = activeTiles[a.tileId];
  const bidder = a.currentBidder ? state.players.find(p => p.id === a.currentBidder) : null;
  const title = document.createElement('div');
  title.className = 'p-title';
  title.textContent = '🔨 公开拍卖：' + tile.name + '（原价 ¥' + tilePrice(tile) + '）';
  auctionPanel.appendChild(title);
  const info = document.createElement('div');
  info.className = 'offer-box';
  info.textContent = '当前价 ¥' + a.currentBid + (bidder ? '（' + bidder.name + ' 出价）' : '（无人出价）');
  auctionPanel.appendChild(info);
  // 倒计时
  const timer = document.createElement('div');
  timer.className = 'auction-timer';
  timer.id = 'auction-timer';
  auctionPanel.appendChild(timer);
  updateAuctionTimer();

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
  if (t.giveTiles.length) parts.push('给 ' + t.giveTiles.map(id => activeTiles[id].name).join('、'));
  if (t.getTiles.length) parts.push('要 ' + t.getTiles.map(id => activeTiles[id].name).join('、'));
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
  addAiBtn.classList.toggle('hidden', !myIsHost);
  players.forEach((p) => {
    const li = document.createElement('li');
    li.innerHTML = `<span class="dot" style="background:${p.color}"></span><span class="p-name">${escapeHtml(p.name)}</span>${p.isHost ? '<span class="tag">房主</span>' : ''}${p.isAI ? '<span class="tag">机器人</span>' : ''}${p.id === myId ? '<span class="tag me">我</span>' : ''}`;
    playerList.appendChild(li);
    const sp = state ? state.players.find(s => s.id === p.id) : null;
    const isCur = p.id === curId;
    const li2 = document.createElement('li');
    if (isCur) li2.classList.add('current');
    li2.innerHTML = `<span class="dot" style="background:${p.color}"></span><span class="p-name">${escapeHtml(p.name)}</span>${sp && sp.bankrupt ? '<span class="tag">破产</span>' : ''}${isCur ? '<span class="tag turn">回合中</span>' : ''}<span class="p-money">¥${sp ? sp.money : 1500}</span>`;
    gamePlayerList.appendChild(li2);
  });
}

function renderRoomSettings() {
  if (!roomSettings) return;
  const show = myIsHost && !state;
  roomSettings.classList.toggle('hidden', !show);
  if (!roomSettingsData) return;
  setMoney.value = String(roomSettingsData.startMoney);
  setRounds.value = String(roomSettingsData.maxRounds);
  setHouse.value = String(roomSettingsData.houseMultiplier);
  if (setMap) setMap.value = roomSettingsData.mapId || 'standard';
}

function sendSettings() {
  ws.send(JSON.stringify({ type: 'update_settings', settings: {
    startMoney: Number(setMoney.value), maxRounds: Number(setRounds.value), houseMultiplier: Number(setHouse.value), mapId: setMap ? setMap.value : 'standard',
  } }));
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
  updateTurnTimer();
}

function updateTurnTimer() {
  if (!state || state.phase === 'gameOver' || isSpectator) return;
  const me = state.players.find(p => p.id === myId);
  const base = '第 ' + state.round + ' 回合 · 你的资金 ¥' + (me ? me.money : 0);
  if (state.turnDeadline) {
    const remain = Math.max(0, Math.ceil((state.turnDeadline - Date.now()) / 1000));
    const isMe = state.players[state.current] && state.players[state.current].id === myId;
    turnSub.textContent = base + (isMe ? ' · ⏳ 倒计时 ' + remain + ' 秒' : ' · ⏳ 对方剩余 ' + remain + ' 秒');
  } else {
    turnSub.textContent = base;
  }
}
setInterval(updateTurnTimer, 500);

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
  const tile = activeTiles[tileId];
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
    if (canBuildOn(tileId)) {
      html += '<button id="deed-build-btn" class="btn start big" style="width:100%;margin-top:10px">🏗️ 盖房 ¥' + g.houseCost + '</button>';
    }
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
    html += '<div class="deed-note">地价 ¥300</div>';
    if (owner) html += '<div class="deed-owner" style="background:' + owner.color + '33;color:' + owner.color + '">👤 ' + owner.name + ' 持有</div>';
    html += '<div class="deed-title" style="font-size:15px;margin-top:4px">过路费（按骰点 × 倍数）</div>';
    html += '<div class="deed-row"><span class="k">持有 1 个</span><span class="v">骰点 ×15</span></div>';
    html += '<div class="deed-row"><span class="k">持有 2 个</span><span class="v">骰点 ×40</span></div>';
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
  const buildBtnEl = deedContent.querySelector('#deed-build-btn');
  if (buildBtnEl) {
    buildBtnEl.addEventListener('click', () => {
      ws.send(JSON.stringify({ type: 'build_house', tileId }));
      deedModal.classList.add('hidden');
    });
  }
  deedModal.classList.remove('hidden');
}

function detectCard() {
  if (!state || !state.lastCard) return;
  const key = (state.lastCard.seq || 0) + '|' + state.lastCard.type + '|' + state.lastCard.text;
  if (prevLastCard === key) return;
  prevLastCard = key;
  // 命运 / 机会播放不同特殊音效
  play(state.lastCard.type === 'chance' ? 'chance' : 'chest');
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
  const all = state.log;
  if (lastSoundLog == null || !all.includes(lastSoundLog)) {
    lastSoundLog = all[all.length - 1] || null;
    return;
  }
  const idx = all.lastIndexOf(lastSoundLog);
  const newLogs = all.slice(idx + 1);
  if (newLogs.length > 0) {
    newLogs.forEach((l) => playForLog(l));
    lastSoundLog = all[all.length - 1] || null;
  }
}

const tileColorMap = new Map();
activeTiles.forEach(t => {
  if (t.type === 'property') tileColorMap.set(t.name, GROUPS[t.group].color);
  else if (t.type === 'railroad') tileColorMap.set(t.name, '#78909C');
  else if (t.type === 'utility') tileColorMap.set(t.name, '#90A4AE');
});

function colorizeLog(line) {
  let html = escapeHtml(line);
  tileColorMap.forEach((color, name) => {
    html = html.split(name).join('<span style="color:' + color + ';font-weight:700">' + name + '</span>');
  });
  return html;
}

function appendLog(line) {
  const li = document.createElement('li');
  li.innerHTML = colorizeLog(line);
  logList.appendChild(li);
}

function renderLog() {
  if (!state || !state.log) return;
  const all = state.log;
  if (logList.childElementCount === 0 || lastLogText == null || !all.includes(lastLogText)) {
    logList.innerHTML = '';
    const start = Math.max(0, all.length - 30);
    for (let i = start; i < all.length; i++) appendLog(all[i]);
    lastLogText = all[all.length - 1] || null;
  } else {
    const idx = all.lastIndexOf(lastLogText);
    for (let i = idx + 1; i < all.length; i++) appendLog(all[i]);
    while (logList.childElementCount > 30) logList.removeChild(logList.firstChild);
    lastLogText = all[all.length - 1] || null;
  }
  logList.scrollTop = logList.scrollHeight;
}

function setMsg(text, isError) { lobbyMsg.textContent = text; lobbyMsg.className = 'msg' + (isError ? ' error' : ''); }

function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }



