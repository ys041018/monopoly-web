// ============================================================
// 前端主逻辑：WebSocket + 大厅/游戏 + 回合操作 + 盖房/抵押/交易
// ============================================================
import { render, animateMove, animateDice, onTileClick, setBoardTheme, setActiveMap } from './board2d.js';

// ---------- 前端错误上报 ----------
// 上报到服务端日志（Render 里可直接检索）+ 界面轻提示，不再把报错写进"轮到谁"那行
function reportClientError(message, where) {
  try { ws.send(JSON.stringify({ type: 'client_error', message: String(message || '').slice(0, 300), where: String(where || '').slice(0, 120) })); } catch {}
  let toast = document.getElementById('error-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'error-toast';
    toast.className = 'error-toast';
    document.body.appendChild(toast);
  }
  toast.textContent = '⚠️ 出现异常：' + message + (where ? '（' + where + '）' : '');
  toast.classList.remove('hidden');
  clearTimeout(reportClientError._timer);
  reportClientError._timer = setTimeout(() => toast.classList.add('hidden'), 6000);
}

window.addEventListener('error', (e) => {
  const where = ((e.filename || '').split('/').pop() || '') + ':' + (e.lineno || 0);
  reportClientError(e.message || '未知错误', where);
});
window.addEventListener('unhandledrejection', (e) => {
  reportClientError((e.reason && (e.reason.message || e.reason)) || '未处理的 Promise 异常', 'promise');
});

// E2E/调试用：向本机客户端注入一条服务端消息（不影响服务器状态）
window.__monopoly = {
  feed: (msg) => { try { ws.onmessage({ data: JSON.stringify(msg) }); } catch (e) { console.error(e); } },
};
import { GROUPS } from './data/tiles.js';
import { getMap } from './data/maps.js';
let activeTiles = getMap('standard').tiles;
import { playForLog, play, setSoundEnabled, isSoundEnabled } from './sound.js';
import { QUICK_PHRASES, QUICK_EMOJIS } from './data/chat.js';

const WS_URL = `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}`;

// ---------- 连接层：断线自动重连 ----------
// 保持 ws.send / ws.onmessage 等原有调用方式不变，内部换成可重连的壳
const conn = {
  socket: null,
  queue: [],
  retry: 0,
  retryTimer: null,
  listeners: { open: [], message: [], close: [] },
  onopen: null, onmessage: null, onclose: null,
  get readyState() { return this.socket ? this.socket.readyState : 3; },
  addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); },
  emit(type, arg) {
    const direct = this['on' + type];
    if (typeof direct === 'function') { try { direct(arg); } catch (e) { console.error(e); } }
    (this.listeners[type] || []).forEach((fn) => { try { fn(arg); } catch (e) { console.error(e); } });
  },
  send(text) {
    if (this.socket && this.socket.readyState === 1) { this.socket.send(text); return; }
    if (this.queue.length < 30) this.queue.push(text);   // 断线期间排队，重连后补发
  },
  connect() {
    if (this.socket && this.socket.readyState <= 1) return;
    let s;
    try { s = new WebSocket(WS_URL); } catch { this.scheduleRetry(); return; }
    this.socket = s;
    s.onopen = () => {
      const wasRetry = this.retry > 0;
      this.retry = 0;
      setConnStatus('');
      this.emit('open');
      const pending = this.queue.splice(0);
      pending.forEach((text) => { try { s.send(text); } catch {} });
      if (wasRetry) resumeAfterReconnect();
    };
    s.onmessage = (e) => { lastServerMsgAt = Date.now(); this.emit('message', e); };
    s.onclose = () => {
      if (this.socket === s) this.socket = null;
      this.emit('close');
      this.scheduleRetry();
    };
    s.onerror = () => { try { s.close(); } catch {} };
  },
  scheduleRetry() {
    if (this.retryTimer) return;
    const delay = Math.min(1000 * Math.pow(2, this.retry), 15000);
    this.retry++;
    setConnStatus('连接已断开，正在重连…（' + Math.round(delay / 1000) + 's）');
    this.retryTimer = setTimeout(() => { this.retryTimer = null; this.connect(); }, delay);
  },
};
const ws = conn;
let lastServerMsgAt = Date.now();

// 顶部断线提示条
function setConnStatus(text) {
  let el = document.getElementById('conn-banner');
  if (!text) { if (el) el.classList.add('hidden'); return; }
  if (!el) {
    el = document.createElement('div');
    el.id = 'conn-banner';
    el.className = 'conn-banner';
    document.body.appendChild(el);
  }
  el.textContent = text;
  el.classList.remove('hidden');
}

// 重连成功后恢复身份与房间
function resumeAfterReconnect() {
  // 游客（未登录）也要能恢复房间，所以不能因为没 token 就返回
  const savedId = sessionStorage.getItem('monopoly_player_id');
  const savedName = sessionStorage.getItem('monopoly_player_name');
  const savedRoom = sessionStorage.getItem('monopoly_room');
  gotError = false;
  if (authToken) ws.send(JSON.stringify({ type: 'auth', token: authToken }));
  if (savedId && savedName && savedRoom) {
    ws.send(JSON.stringify({ type: 'join', name: savedName, playerId: savedId, roomCode: savedRoom, token: authToken || undefined }));
    setMsg('已重连，正在恢复对局…');
  } else if (authToken) {
    setMsg('已重连');
  }
}

// 手机切网/飞行模式：浏览器不一定立刻关闭已有连接，主动断开并重连
window.addEventListener('offline', () => {
  setConnStatus('网络已断开，正在等待恢复…');
  if (ws.socket) { try { ws.socket.close(); } catch {} }
});
window.addEventListener('online', () => {
  if (ws.retryTimer) { clearTimeout(ws.retryTimer); ws.retryTimer = null; }
  ws.connect();
});

// 看门狗：75 秒收不到任何消息（含服务端心跳）就主动重连
setInterval(() => {
  if (Date.now() - lastServerMsgAt > 75000) {
    lastServerMsgAt = Date.now();
    if (ws.socket) { try { ws.socket.close(); } catch {} }
    else ws.scheduleRetry();
  }
}, 20000);

conn.connect();

// PWA：注册 Service Worker（仅 https / localhost 生效）
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((e) => console.warn('SW 注册失败', e.message));
  });
}

const $ = (id) => document.getElementById(id);
const lobby = $('lobby'), game = $('game');
const nameInput = $('name-input'), roomInput = $('room-input'), joinBtn = $('join-btn'), startBtn = $('start-btn'), lobbyBtn = $('lobby-btn');
const addAiBtn = $('add-ai-btn');
const hotkeyBtn = $('hotkey-btn'), hotkeyPanel = $('hotkey-panel');
const authScreen = $('auth-screen'), authPanel = $('auth-panel'), authInfo = $('auth-info'), authUser = $('auth-user'), authPass = $('auth-pass'), authNick = $('auth-nick'), authMsg = $('auth-msg'), authName = $('auth-name');
const authLoginBtn = $('auth-login-btn'), authRegisterBtn = $('auth-register-btn'), authLogoutBtn = $('auth-logout-btn'), authStats = $('auth-stats');
const createRoomBtn = $('create-room-btn');
const quickMatchBtn = $('quick-match-btn'), roomsBtn = $('rooms-btn');
const roomsModal = $('rooms-modal'), roomsList = $('rooms-list'), roomsClose = $('rooms-close');
const settingsBtn = $('settings-btn'), settingsClose = $('settings-close');
const profileBtn = $('profile-btn'), profileModal = $('profile-modal'), profileClose = $('profile-close'), profileBody = $('profile-body'), profileTitle = $('profile-title');
const leaderboardBtn = $('leaderboard-btn');
const themeSelect = $('theme-select');
const roomSettings = $('room-settings'), setMoney = $('set-money'), setRounds = $('set-rounds'), setHouse = $('set-house'), setMap = $('set-map');
const setFast = $('set-fast'), setTeam = $('set-team'), setInterest = $('set-interest');
const setAuction = $('set-auction'), setRandomLand = $('set-randomland'), setRandomMap = $('set-randommap');
const soundToggle = $('sound-toggle'), copyRoomBtn = $('copy-room-btn');
const rollBtn = $('roll-btn'), buyBtn = $('buy-btn'), skipBuyBtn = $('skip-buy-btn'), endTurnBtn = $('end-turn-btn');
const buildBtn = $('build-btn'), mortgageBtn = $('mortgage-btn'), tradeBtn = $('trade-btn'), stockBtn = $('stock-btn'), loanBtn = $('loan-btn');
const bailBtn = $('bail-btn'), jailcardBtn = $('jailcard-btn');
const buildPanel = $('build-panel'), mortgagePanel = $('mortgage-panel'), tradePanel = $('trade-panel'), tradeOffer = $('trade-offer'), auctionPanel = $('auction-panel'), stockPanel = $('stock-panel'), loanPanel = $('loan-panel');
const actionModal = $('action-modal'), drawerTitle = $('drawer-title'), drawerClose = $('drawer-close');
const waitingTip = $('waiting-tip'), diceDisplay = $('dice-display');
const lobbyMsg = $('lobby-msg'), playerList = $('player-list'), playerCount = $('player-count');
const gamePlayerList = $('game-player-list'), gamePlayerCount = $('game-player-count');
const logList = $('log-list'), turnTitle = $('turn-title'), turnSub = $('turn-sub');
const deedModal = $('deed-modal'), deedContent = $('deed-content'), deedClose = $('deed-close');
const cardPopup = $('card-popup'), cardPopupInner = $('card-popup-inner'), cardPopupTitle = $('card-popup-title'), cardPopupText = $('card-popup-text');

const DICE_FACES = ['⚀', '⚁', '⚂', '⚃', '⚄', '⚅'];

let myId = null, myIsHost = false, isSpectator = false;
let authToken = localStorage.getItem('monopoly_token') || null;
if (localStorage.getItem('monopoly_sound') === '0') { setSoundEnabled(false); }
let players = [], state = null;
let gotError = false, entered = false, animating = false;
let animatedMoveSeq = null;   // 已播放过的移动 seq，用于避免重复播放
let lastSoundLog = null;
let lastLogText = null;
let prevLastCard = null;
let roomSettingsData = null;
let cardTimer = null;

// ---------- 自动重连 ----------
(function autoRejoin() {
  if (!authToken) return;
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
// ---------- 快速匹配 / 公开房间 ----------
if (quickMatchBtn) quickMatchBtn.addEventListener('click', () => {
  const name = nameInput.value.trim();
  if (!name) { setMsg('请先输入昵称', true); return; }
  setMsg('正在匹配…');
  ws.send(JSON.stringify({ type: 'quick_match', name, token: authToken || undefined }));
});
if (roomsBtn) roomsBtn.addEventListener('click', () => {
  roomsModal.classList.remove('hidden');
  roomsList.innerHTML = '';
  ws.send(JSON.stringify({ type: 'list_rooms' }));
  if (!roomsTimer) roomsTimer = setInterval(() => ws.send(JSON.stringify({ type: 'list_rooms' })), 5000);
});
if (roomsClose) roomsClose.addEventListener('click', closeRoomsModal);
if (roomsModal) roomsModal.addEventListener('click', (e) => { if (e.target === roomsModal) closeRoomsModal(); });

let roomsTimer = null;

function closeRoomsModal() {
  if (roomsModal) roomsModal.classList.add('hidden');
  if (roomsTimer) { clearInterval(roomsTimer); roomsTimer = null; }
}

// ---------- 房间设置（房主，弹窗） ----------
if (settingsBtn) settingsBtn.addEventListener('click', () => {
  roomSettings.classList.remove('hidden');
  renderRoomSettings();
});
if (settingsClose) settingsClose.addEventListener('click', () => roomSettings.classList.add('hidden'));
if (roomSettings) roomSettings.addEventListener('click', (e) => { if (e.target === roomSettings) roomSettings.classList.add('hidden'); });

// ---------- 个人主页 / 排行榜 ----------
if (profileBtn) profileBtn.addEventListener('click', () => {
  if (profileTitle) profileTitle.textContent = '📊 个人主页';
  profileModal.classList.remove('hidden');
  profileBody.textContent = '加载中…';
  ws.send(JSON.stringify({ type: 'get_profile', token: authToken || undefined }));
});
if (leaderboardBtn) leaderboardBtn.addEventListener('click', () => {
  if (profileTitle) profileTitle.textContent = '🏆 排行榜';
  profileModal.classList.remove('hidden');
  profileBody.textContent = '加载中…';
  ws.send(JSON.stringify({ type: 'get_leaderboard', limit: 20 }));
});
if (profileClose) profileClose.addEventListener('click', () => profileModal.classList.add('hidden'));
if (profileModal) profileModal.addEventListener('click', (e) => { if (e.target === profileModal) profileModal.classList.add('hidden'); });

function rankRow(entry, myNickname) {
  const row = document.createElement('div');
  row.className = 'rank-row' + (myNickname && entry.nickname === myNickname ? ' me' : '');
  const no = document.createElement('span'); no.className = 'no'; no.textContent = '#' + entry.rank;
  const nick = document.createElement('span'); nick.className = 'nick'; nick.textContent = entry.nickname;
  const val = document.createElement('span'); val.className = 'val';
  val.textContent = entry.wins + ' 胜 · ' + (entry.games || 0) + ' 场 · 最高 ¥' + entry.maxAssets;
  row.appendChild(no); row.appendChild(nick); row.appendChild(val);
  return row;
}

function renderLeaderboardInto(container, rows, myNickname) {
  const list = document.createElement('div');
  list.className = 'rank-list';
  if (!rows || rows.length === 0) {
    const tipEl = document.createElement('div');
    tipEl.className = 'waiting-tip';
    tipEl.textContent = '还没有战绩数据，先玩一局吧';
    list.appendChild(tipEl);
  } else {
    rows.forEach(r => list.appendChild(rankRow(r, myNickname)));
  }
  container.appendChild(list);
}

function renderProfile(msg) {
  if (!profileBody) return;
  profileBody.innerHTML = '';
  if (msg.needLogin) {
    const d = document.createElement('div'); d.className = 'waiting-tip'; d.textContent = '请先登录后查看个人主页';
    profileBody.appendChild(d);
    return;
  }
  if (msg.unavailable) {
    const d = document.createElement('div'); d.className = 'waiting-tip'; d.textContent = '账号服务未配置，暂时无法查看战绩';
    profileBody.appendChild(d);
    return;
  }
  const st = msg.stats || {};
  const games = st.games || 0, wins = st.wins || 0;
  const rate = games > 0 ? Math.round(wins / games * 100) : 0;

  const head = document.createElement('div');
  head.className = 'profile-head';
  const name = document.createElement('span');
  name.className = 'profile-name';
  name.textContent = (msg.user && (msg.user.nickname || msg.user.username)) || '未登录';
  const rank = document.createElement('span');
  rank.className = 'profile-rank';
  rank.textContent = msg.rank ? ('排名 #' + msg.rank + (msg.total ? ' / ' + msg.total : '')) : '';
  head.appendChild(name); head.appendChild(rank);
  profileBody.appendChild(head);

  const grid = document.createElement('div');
  grid.className = 'profile-grid';
  [['总场次', games], ['胜 / 负', wins + ' / ' + (st.losses || 0)], ['胜率', rate + '%'], ['最高资产', '¥' + (st.max_assets || 0)]]
    .forEach(([k, v]) => {
      const cell = document.createElement('div');
      cell.className = 'profile-cell';
      const kk = document.createElement('div'); kk.className = 'k'; kk.textContent = k;
      const vv = document.createElement('div'); vv.className = 'v'; vv.textContent = String(v);
      cell.appendChild(kk); cell.appendChild(vv);
      grid.appendChild(cell);
    });
  profileBody.appendChild(grid);
  if (games === 0) {
    const tipEl = document.createElement('div');
    tipEl.className = 'trade-bal';
    tipEl.textContent = '还没有战绩：完成一局（有人获胜或到达回合上限结算）才会记录';
    profileBody.appendChild(tipEl);
  }

  const title = document.createElement('div');
  title.className = 'p-title';
  title.textContent = '排行榜 Top 10';
  profileBody.appendChild(title);
  renderLeaderboardInto(profileBody, msg.leaderboard, msg.user && msg.user.nickname);
}

function renderLeaderboardOnly(msg) {
  if (!profileBody) return;
  profileBody.innerHTML = '';
  const title = document.createElement('div');
  title.className = 'p-title';
  title.textContent = msg.unavailable ? '账号服务未配置' : '排行榜 Top 20';
  profileBody.appendChild(title);
  const note = document.createElement('div');
  note.className = 'trade-bal';
  note.textContent = '仅统计完成过对局的登录账号 · 人机/AI 不参与排行';
  profileBody.appendChild(note);
  renderLeaderboardInto(profileBody, msg.rows || [], null);
}

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
// ---------- 抽屉：同一时间只开一个功能面板 ----------
const DRAWERS = {
  build: { btn: buildBtn, panel: buildPanel, title: '🏗️ 房产 / 盖房', render: () => renderBuildPanel() },
  mortgage: { btn: mortgageBtn, panel: mortgagePanel, title: '🏦 抵押 / 赎回', render: () => renderMortgagePanel() },
  trade: { btn: tradeBtn, panel: tradePanel, title: '🤝 发起交易', render: () => renderTradePanel() },
  stock: { btn: stockBtn, panel: stockPanel, title: '📈 股市', render: () => renderStockPanel() },
  loan: { btn: loanBtn, panel: loanPanel, title: '🏦 银行贷款', render: () => renderLoanPanel() },
};
let openDrawerKind = null;

function openDrawer(kind) {
  const d = DRAWERS[kind];
  if (!d || !actionModal) return;
  openDrawerKind = kind;
  Object.values(DRAWERS).forEach((x) => x.panel && x.panel.classList.add('hidden'));
  if (d.panel) d.panel.classList.remove('hidden');
  if (drawerTitle) drawerTitle.textContent = d.title;
  actionModal.classList.remove('hidden');
  d.render();
}

function closeDrawer() {
  openDrawerKind = null;
  if (actionModal) actionModal.classList.add('hidden');
  Object.values(DRAWERS).forEach((x) => x.panel && x.panel.classList.add('hidden'));
}

// 状态更新后重绘当前抽屉，避免面板内容过期
function refreshDrawer() {
  if (!openDrawerKind) return;
  const d = DRAWERS[openDrawerKind];
  if (d && d.panel && !d.panel.classList.contains('hidden')) d.render();
}

Object.entries(DRAWERS).forEach(([kind, d]) => {
  if (d.btn) d.btn.addEventListener('click', () => openDrawer(kind));
});
if (drawerClose) drawerClose.addEventListener('click', closeDrawer);
if (actionModal) actionModal.addEventListener('click', (e) => { if (e.target === actionModal) closeDrawer(); });
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && openDrawerKind) closeDrawer();
});

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
  // 主动离开房间，否则下次登录/刷新会被自动拉回旧房间（含机器人）
  ws.send(JSON.stringify({ type: 'leave_room' }));
  authToken = null; localStorage.removeItem('monopoly_token');
  sessionStorage.removeItem('monopoly_player_id');
  sessionStorage.removeItem('monopoly_player_name');
  sessionStorage.removeItem('monopoly_room');
  players = []; myId = null; state = null; entered = false; myIsHost = false;
  if (roomInput) roomInput.value = '';
  authScreen.classList.remove('hidden');
  lobby.classList.add('hidden');
  game.classList.add('hidden');
  authInfo.classList.add('hidden');
  authMsg.textContent = ''; authPass.value = '';
});
ws.addEventListener('open', () => { if (authToken) ws.send(JSON.stringify({ type: 'auth', token: authToken })); });

function toggle(el) { el.classList.toggle('hidden'); }
hotkeyBtn.addEventListener('click', () => toggle(hotkeyPanel));

[setMoney, setRounds, setHouse, setMap, setFast, setTeam, setInterest, setAuction, setRandomLand, setRandomMap]
  .forEach(el => el && el.addEventListener('change', sendSettings));

if (authToken) { authMsg.textContent = '正在自动登录...'; }

// ---------- 棋盘主题 ----------
(function initTheme() {
  // 兼容旧主题名（旧存档里可能是 emerald/classic/warm/cool）
  const LEGACY_THEME = { emerald: 'candy', classic: 'sky', warm: 'sakura', cool: 'mint' };
  const raw = localStorage.getItem('monopoly_theme') || 'auto';
  const saved = LEGACY_THEME[raw] || raw;
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
ws.onclose = () => {
  // 断线由连接层自动重连，这里只提示，不再要求刷新页面
  setConnStatus('连接已断开，正在重连…');
};

ws.onmessage = (e) => {
  let msg;
  try { msg = JSON.parse(e.data); } catch { return; }
  switch (msg.type) {
    case 'welcome':
      myId = msg.playerId;
      // 记住房间码：快速匹配进已有房间、或刷新后自动重连都要用它
      if (msg.roomCode) {
        sessionStorage.setItem('monopoly_room', msg.roomCode);
        if (roomInput) roomInput.value = msg.roomCode;
      }
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
      authScreen.classList.add('hidden');
      lobby.classList.remove('hidden');
      authInfo.classList.remove('hidden');
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
      authScreen.classList.remove('hidden');
      lobby.classList.add('hidden');
      game.classList.add('hidden');
      authInfo.classList.add('hidden');
      break;
    case 'room_created':
      sessionStorage.setItem('monopoly_room', msg.roomCode);
      roomInput.value = msg.roomCode;
      gotError = false;
      // 必须带 token：否则服务端拿不到 userId，房主这一局不算战绩
      ws.send(JSON.stringify({ type: 'join', name: nameInput.value.trim(), roomCode: msg.roomCode, token: authToken || undefined }));
      joinBtn.disabled = true;
      setMsg('已创建房间 ' + msg.roomCode + '，正在加入...');
      break;
    case 'player_list':
      players = msg.players;
      // 房主可能已经转让给别人：每次名单更新都同步自己的房主状态
      const meInList = players.find(p => p.id === myId);
      if (meInList) myIsHost = !!meInList.isHost;
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
    case 'chat': showBubble(msg); break;
    case 'profile': renderProfile(msg); break;
    case 'leaderboard': renderLeaderboardOnly(msg); break;
    case 'kicked':
      // 被移出房间：清掉房间与身份记录，避免自动重连又加回去
      sessionStorage.removeItem('monopoly_room');
      sessionStorage.removeItem('monopoly_player_id');
      sessionStorage.removeItem('monopoly_player_name');
      state = null; entered = false; myId = null; myIsHost = false; players = [];
      if (roomInput) roomInput.value = '';
      game.classList.add('hidden');
      lobby.classList.remove('hidden');
      renderPlayers();
      setMsg(msg.message || '你被房主移出了房间', true);
      break;
    case 'room_list': renderRooms(msg.rooms); break;

    case 'back_to_lobby': backToLobby(); break;
    case 'error':
      gotError = true;
      setMsg(msg.message, true);
      joinBtn.disabled = false;
      // 记的房间已不存在：清掉本地存档，别让下次登录再撞一次
      if (msg.message && msg.message.indexOf('房间不存在') >= 0) {
        sessionStorage.removeItem('monopoly_room');
        sessionStorage.removeItem('monopoly_player_id');
        if (roomInput) roomInput.value = '';
      }
      break;
  }
};

// ---------- 视图同步 ----------
function enterGame() {
  lobby.classList.add('hidden');
  game.classList.remove('hidden');
  tradePanel.classList.add('hidden');
  const chatBox = document.getElementById('chat-box');
  if (chatBox) chatBox.classList.remove('hidden');
  closeDrawer();
  animatedMoveSeq = moveKey(state.lastMove);   // 进入/重连直接呈现当前局面，不重放本回合移动
  lastSoundLog = state.log && state.log.length ? state.log[state.log.length - 1] : null;
  render(state);
  refresh();
}

// 同一回合内买地/抵押/股市/交易都会广播新 state，用 seq 区分是否是新的一次移动
function moveKey(lm) {
  if (!lm) return null;
  if (lm.seq != null) return 'seq:' + lm.seq;
  return 'k:' + lm.playerIndex + ':' + lm.from + ':' + lm.to + ':' + (lm.dice ? lm.dice.join('-') : '') + ':' + state.round;
}

function syncGame() {
  const lm = state.lastMove;
  const key = moveKey(lm);
  if (lm && key !== animatedMoveSeq && !animating) {
    animatedMoveSeq = key;
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
  refreshDrawer();
  syncAuctionModal();
  detectSound();
  detectCard();
}

function backToLobby() {
  state = null; isSpectator = false; entered = false; animating = false;
  document.body.removeAttribute('data-map');   // 回大厅恢复默认背景
  const chatBox = document.getElementById('chat-box');
  if (chatBox) chatBox.classList.add('hidden');
  closeDrawer();
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

// 拍卖阶段自动弹出，结束自动关闭
function syncAuctionModal() {
  const modal = document.getElementById('auction-modal');
  if (!modal) return;
  const inAuction = !!(state && state.phase === 'auction' && state.auction);
  modal.classList.toggle('hidden', !inAuction);
}

function updateActions() {
  hideAllActions();
  if (!state) return;
  if (state.phase === 'gameOver') { waitingTip.textContent = '游戏已结束'; waitingTip.classList.remove('hidden'); return; }
  if (state.phase === 'auction') { renderAuctionPanel(); return; }
  const myTurn = !isSpectator && state.players[state.current].id === myId;
  // 交易 / 股市不受回合限制：非旁观者随时可打开（面板内自行判断是否轮到我）
  if (!isSpectator) {
    tradeBtn.classList.remove('hidden');
    stockBtn.classList.remove('hidden');
    if (loanBtn) loanBtn.classList.remove('hidden');
  }
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
  const fill = document.getElementById('auction-bar-fill');
  if (!state || !state.auction) return;
  const a = state.auction;
  const total = a.duration || 15000;
  const left = Math.max(0, a.deadline - Date.now());
  if (el) el.textContent = '⏳ 剩余 ' + Math.ceil(left / 1000) + ' 秒';
  if (fill) {
    const pct = Math.max(0, Math.min(100, (left / total) * 100));
    fill.style.width = pct.toFixed(1) + '%';
    fill.classList.toggle('urgent', pct < 34);
  }
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
    const giveValue = sumChecked(myBox) + gm;
    const getValue = sumChecked(theirBox) + rm;
    const diff = getValue - giveValue;
    const judge = Math.abs(diff) <= Math.max(50, getValue * 0.1)
      ? '大致公平'
      : (diff > 0 ? '你赚约 ¥' + diff : '你亏约 ¥' + (-diff));
    summary.textContent = '我给出 ' + gt + ' 块地 + ¥' + gm + '（约 ¥' + giveValue + '），换对方 '
      + rt + ' 块地 + ¥' + rm + '（约 ¥' + getValue + '）· ' + judge;
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
  title.textContent = '拍品：' + tile.name + '（原价 ¥' + tilePrice(tile) + '）';
  auctionPanel.appendChild(title);
  const info = document.createElement('div');
  info.className = 'offer-box';
  info.textContent = '当前价 ¥' + a.currentBid + (bidder ? '（' + bidder.name + ' 出价）' : '（无人出价）');
  auctionPanel.appendChild(info);
  // 倒计时进度条
  const barWrap = document.createElement('div');
  barWrap.className = 'auction-bar';
  const bar = document.createElement('div');
  bar.className = 'auction-bar-fill';
  bar.id = 'auction-bar-fill';
  barWrap.appendChild(bar);
  auctionPanel.appendChild(barWrap);

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
    input.value = String(a.currentBid + 10);
    input.placeholder = '出价（> ¥' + a.currentBid + '）';
    const btn = mkBtn('出价', 'start');
    btn.addEventListener('click', () => ws.send(JSON.stringify({ type: 'bid', amount: Number(input.value) })));
    row.appendChild(input); row.appendChild(btn);
    auctionPanel.appendChild(row);

    const quick = document.createElement('div');
    quick.className = 'auction-quick';
    [10, 50, 100].forEach((step) => {
      const b = mkBtn('+' + step, 'ghost');
      b.addEventListener('click', () => ws.send(JSON.stringify({ type: 'bid', amount: a.currentBid + step })));
      quick.appendChild(b);
    });
    auctionPanel.appendChild(quick);
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

// ---------- 股市面板 ----------
let stockQty = 1;   // 交易数量档位：1 / 5 / 10 / 'max'

function renderStockPanel() {
  if (!stockPanel || stockPanel.classList.contains('hidden')) return;
  stockPanel.innerHTML = '';
  if (!state || !state.stocks) { tip(stockPanel, '开局后才能交易股票'); return; }
  if (isSpectator) { tip(stockPanel, '旁观模式不能交易'); return; }
  const me = state.players.find(p => p.id === myId);
  const cur = state.players[state.current];
  const isMyTurn = !!(cur && cur.id === myId);

  // 数量档位
  const qtyRow = document.createElement('div');
  qtyRow.className = 'stock-qty';
  const qtyLabel = document.createElement('span');
  qtyLabel.className = 'p-title';
  qtyLabel.textContent = '每次数量';
  qtyRow.appendChild(qtyLabel);
  [1, 5, 10, 'max'].forEach((q) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'qty-btn' + (stockQty === q ? ' active' : '');
    b.textContent = q === 'max' ? '最大' : String(q);
    b.addEventListener('click', () => { stockQty = q; renderStockPanel(); });
    qtyRow.appendChild(b);
  });
  stockPanel.appendChild(qtyRow);

  let sumCost = 0, sumValue = 0, sumShort = 0, sumShortEntry = 0;
  state.stocks.forEach((s) => {
    const held = (me && me.stocks && me.stocks[s.id]) || 0;
    const cost = (me && me.stockCost && me.stockCost[s.id]) || 0;
    const avg = held > 0 ? Math.round(cost / held) : 0;
    const value = held * s.price;
    const pl = value - cost;
    const plPct = cost > 0 ? Math.round(pl / cost * 100) : 0;
    const shortN = (me && me.shorts && me.shorts[s.id]) || 0;
    const shortEntry = (me && me.shortEntry && me.shortEntry[s.id]) || 0;
    const shortAvg = shortN > 0 ? Math.round(shortEntry / shortN) : 0;
    const shortPl = shortEntry - shortN * s.price;      // 开仓所得 − 当前需买回成本
    sumCost += cost; sumValue += value; sumShort += shortN * s.price; sumShortEntry += shortEntry;
    const cash = me ? me.money : 0;
    const maxBuy = Math.max(0, Math.min(9999, Math.floor(cash / s.price)));
    const buyQty = stockQty === 'max' ? maxBuy : Math.min(stockQty, maxBuy);
    const sellQty = stockQty === 'max' ? held : Math.min(stockQty, held);
    const pct = s.prev ? Math.round((s.price - s.prev) / s.prev * 100) : 0;
    const arrow = pct > 0 ? '▲' : (pct < 0 ? '▼' : '—');
    const row = document.createElement('div');
    row.className = 'build-row';
    const info = document.createElement('span');
    info.className = 'stock-info';
    const nameLine = document.createElement('span');
    nameLine.className = 's-name';
    nameLine.textContent = s.name + ' ¥' + s.price + ' ' + arrow + (pct ? Math.abs(pct) + '%' : '');
    const subLine = document.createElement('span');
    subLine.className = 's-sub' + (held > 0 && pl > 0 ? ' win' : (held > 0 && pl < 0 ? ' lose' : ''));
    subLine.textContent = held > 0
      ? '持 ' + held + ' · 均价 ¥' + avg + ' · ' + (pl >= 0 ? '+' : '-') + '¥' + Math.abs(pl) + '（' + (pl >= 0 ? '+' : '') + plPct + '%）'
      : (shortN > 0 ? '' : '未持仓');
    if (shortN > 0) {
      subLine.textContent = (held > 0 ? subLine.textContent + ' · ' : '')
        + '空 ' + shortN + ' · 均价 ¥' + shortAvg + ' · ' + (shortPl >= 0 ? '+' : '-') + '¥' + Math.abs(shortPl);
      if (shortPl > 0) subLine.classList.add('win');
      else if (shortPl < 0) subLine.classList.add('lose');
    }
    info.appendChild(nameLine);
    info.appendChild(subLine);
    row.appendChild(info);
    const buy = mkBtn('买 ' + buyQty, 'start');
    buy.disabled = !isMyTurn || !me || buyQty < 1;
    if (!buy.disabled) buy.addEventListener('click', () => ws.send(JSON.stringify({ type: 'buy_stock', stockId: s.id, shares: buyQty })));
    const sell = mkBtn('卖 ' + sellQty, 'ghost');
    sell.disabled = !isMyTurn || sellQty < 1;
    if (!sell.disabled) sell.addEventListener('click', () => ws.send(JSON.stringify({ type: 'sell_stock', stockId: s.id, shares: sellQty })));
    const acts = document.createElement('div');
    acts.className = 'stock-actions';
    acts.appendChild(buy);
    acts.appendChild(sell);

    // 融券：最多还能卖空多少市值 = min(上限 − 已有空头, 现金 − 2×已有空头)
    // 服务端已把"还能做空多少市值"算好（shortCap），这里只做股数换算
    const shortCap = typeof me?.shortCap === 'number' ? me.shortCap : Math.min(2000 - sumShort, Math.max(0, cash - 2 * sumShort));
    const maxShortQty = Math.max(0, Math.floor(shortCap / s.price));
    const shortQty = stockQty === 'max' ? maxShortQty : Math.min(stockQty, maxShortQty);
    const coverQty = stockQty === 'max' ? shortN : Math.min(stockQty, shortN);
    const shortBtn = mkBtn('融券卖 ' + shortQty, 'primary');
    shortBtn.disabled = !isMyTurn || shortQty < 1;
    if (!shortBtn.disabled) shortBtn.addEventListener('click', () => ws.send(JSON.stringify({ type: 'short_sell', stockId: s.id, shares: shortQty })));
    const coverBtn = mkBtn('买回 ' + coverQty, 'ghost');
    coverBtn.disabled = !isMyTurn || coverQty < 1;
    if (!coverBtn.disabled) coverBtn.addEventListener('click', () => ws.send(JSON.stringify({ type: 'cover_short', stockId: s.id, shares: coverQty })));
    const shortActs = document.createElement('div');
    shortActs.className = 'stock-actions';
    shortActs.appendChild(shortBtn);
    shortActs.appendChild(coverBtn);

    row.appendChild(acts);
    row.appendChild(shortActs);
    stockPanel.appendChild(row);
  });
  const sum = document.createElement('div');
  const totalPL = sumValue - sumCost;
  const overall = totalPL + (sumShortEntry - sumShort);
  sum.className = 'stock-summary' + (overall > 0 ? ' win' : (overall < 0 ? ' lose' : ''));
  const shortPlTotal = sumShortEntry - sumShort;
  const lines = [];
  if (sumCost > 0 || sumShort > 0) {
    lines.push('持仓成本 ¥' + sumCost + ' · 市值 ¥' + sumValue + ' · 盈亏 ' + (totalPL >= 0 ? '+' : '-') + '¥' + Math.abs(totalPL));
  }
  if (sumShort > 0) {
    lines.push('空头市值 ¥' + sumShort + '（计入负债）· 浮动盈亏 ' + (shortPlTotal >= 0 ? '+' : '-') + '¥' + Math.abs(shortPlTotal));
  }
  sum.textContent = lines.length ? lines.join('　|　') : '还没有持仓，买入或融券卖出后这里汇总盈亏';
  stockPanel.appendChild(sum);
  const hint = document.createElement('div');
  hint.className = 'trade-bal';
  hint.textContent = isMyTurn
    ? '「最大」= 买入按现金 / 卖出按持股 / 融券按额度 · 融券每回合收 2% 费用，保证金不足会强制平仓'
    : '只能在自己回合买卖股票';
  stockPanel.appendChild(hint);
}

// ---------- 快捷语 / 表情弹幕 ----------
function showBubble(msg) {
  const layer = document.getElementById('bubble-layer');
  if (!layer) return;
  const el = document.createElement('div');
  el.className = 'bubble' + (msg.kind === 'emoji' ? ' emoji' : '');
  const body = document.createElement('span');
  body.className = 'bubble-text';
  body.textContent = msg.text;
  const who = document.createElement('span');
  who.className = 'bubble-name';
  who.textContent = msg.name;
  if (msg.color) who.style.color = msg.color;
  el.appendChild(body);
  el.appendChild(who);
  el.style.left = (12 + Math.random() * 64) + '%';
  layer.appendChild(el);
  setTimeout(() => el.remove(), 2900);
}

(function initChat() {
  const grid = document.getElementById('chat-grid');
  if (!grid) return;
  const items = QUICK_PHRASES.map(t2 => ({ kind: 'text', text: t2 }))
    .concat(QUICK_EMOJIS.map(e => ({ kind: 'emoji', text: e })));
  items.forEach((item) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chat-btn' + (item.kind === 'emoji' ? ' emoji' : '');
    b.textContent = item.text;
    b.addEventListener('click', () => ws.send(JSON.stringify({ type: 'quick_chat', text: item.text })));
    grid.appendChild(b);
  });
})();

// ---------- 贷款面板 ----------
function renderLoanPanel() {
  if (!loanPanel || loanPanel.classList.contains('hidden')) return;
  loanPanel.innerHTML = '';
  if (!state || !state.players) { tip(loanPanel, '开局后才能贷款'); return; }
  if (isSpectator) { tip(loanPanel, '旁观模式不能操作'); return; }
  const me = state.players.find(p => p.id === myId);
  if (!me) { tip(loanPanel, '找不到你的玩家数据'); return; }
  const cur = state.players[state.current];
  const myTurn = !!(cur && cur.id === myId);
  const rate = Math.round((state.loanRate || 0) * 100);

  const cap = typeof me.loanCap === 'number' ? me.loanCap : null;
  const info = document.createElement('div');
  info.className = 'stock-summary';
  info.textContent = cap == null
    ? '已借 ¥' + (me.loan || 0)
    : '额度 ¥' + cap + ' · 已借 ¥' + (me.loan || 0) + ' · 可借 ¥' + Math.max(0, cap - (me.loan || 0));
  loanPanel.appendChild(info);

  const rateLine = document.createElement('div');
  rateLine.className = 'trade-bal';
  rateLine.textContent = '每回合利息 ' + rate + '%（滚动计入本金）· 贷款会让总资产变负';
  loanPanel.appendChild(rateLine);

  const remain = cap == null ? 0 : Math.max(0, cap - (me.loan || 0));
  const actions = [
    { label: '借 500', amount: 500, fn: () => ws.send(JSON.stringify({ type: 'take_loan', amount: 500 })), disable: remain < 500 },
    { label: '借 1000', amount: 1000, fn: () => ws.send(JSON.stringify({ type: 'take_loan', amount: 1000 })), disable: remain < 1000 },
    { label: '借满 ' + remain, amount: remain, fn: () => ws.send(JSON.stringify({ type: 'take_loan', amount: remain })), disable: remain < 100 },
    { label: '还 500', fn: () => ws.send(JSON.stringify({ type: 'repay_loan', amount: 500 })), disable: (me.loan || 0) < 1 },
    { label: '还清 ' + (me.loan || 0), fn: () => ws.send(JSON.stringify({ type: 'repay_loan', amount: me.loan || 0 })), disable: (me.loan || 0) < 1 },
  ];
  actions.forEach((a) => {
    const b = mkBtn(a.label, a.label.startsWith('借') ? 'primary' : 'ghost');
    b.disabled = !myTurn || a.disable;
    b.addEventListener('click', a.fn);
    loanPanel.appendChild(b);
  });
  if (!myTurn) {
    const hint = document.createElement('div');
    hint.className = 'waiting-tip';
    hint.textContent = '只能在自己回合借贷';
    loanPanel.appendChild(hint);
  }
}

// 估算一组勾选地产的价值（地价 + 房屋投入，不含垄断溢价）
function sumChecked(box) {
  let sum = 0;
  box.querySelectorAll('input:checked').forEach((el) => {
    const id = Number(el.value);
    const t = activeTiles[id];
    if (!t) return;
    sum += tilePrice(t);
    sum += (state.tileHouses[id] || 0) * (GROUPS[t.group] ? GROUPS[t.group].houseCost : 100);
  });
  return sum;
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
  const modeChips = state
    ? ((state.fastMode ? ' ⚡' : '') + (state.teamMode ? ' 🤝' : '') + (state.randomLand ? ' 🎲' : '') + (state.randomMap ? ' 🗺️' : ''))
    : '';
  playerCount.textContent = players.length + '/8';
  gamePlayerCount.textContent = players.length + '/8' + modeChips;
  // 未登录（服务端拿不到 userId）时提示本局不计战绩
  const guestHint = document.getElementById('guest-hint');
  if (guestHint) {
    const meInState = state && state.players ? state.players.find(p => p.id === myId) : null;
    guestHint.classList.toggle('hidden', !(meInState && !meInState.userId));
  }
  playerList.innerHTML = '';
  gamePlayerList.innerHTML = '';
  const curId = state ? state.players[state.current].id : null;
  addAiBtn.classList.toggle('hidden', !myIsHost);
  players.forEach((p) => {
    const li = document.createElement('li');
    li.innerHTML = `<span class="dot" style="background:${p.color}"></span><span class="p-name">${escapeHtml(p.name)}</span>${p.isHost ? '<span class="tag">房主</span>' : ''}${p.isAI ? '<span class="tag">机器人</span>' : ''}${p.id === myId ? '<span class="tag me">我</span>' : ''}`;
    // 房主操作：转让房主 / 踢出房间（仅大厅、仅对其他人）
    if (myIsHost && p.id !== myId) {
      const pass = document.createElement('button');
      pass.type = 'button';
      pass.className = 'mini-btn';
      pass.title = '转让房主';
      pass.textContent = '👑';
      pass.addEventListener('click', () => ws.send(JSON.stringify({ type: 'transfer_host', playerId: p.id })));
      const kick = document.createElement('button');
      kick.type = 'button';
      kick.className = 'mini-btn danger';
      kick.title = p.isAI ? '移除机器人' : '踢出房间';
      kick.textContent = '✕';
      kick.addEventListener('click', () => ws.send(JSON.stringify({ type: 'kick_player', playerId: p.id })));
      li.appendChild(pass);
      li.appendChild(kick);
    }
    playerList.appendChild(li);
    const sp = state ? state.players.find(s => s.id === p.id) : null;
    const isCur = p.id === curId;
    const li2 = document.createElement('li');
    if (isCur) li2.classList.add('current');
    // 编号与棋盘徽章一致（棋盘上用这个数字标归属）
    const idx = state && sp ? state.players.indexOf(sp) + 1 : null;
    const numHtml = idx ? '<span class="p-index" style="background:' + p.color + '">' + idx + '</span>' : '';
    li2.innerHTML = `${numHtml}<span class="dot" style="background:${p.color}"></span><span class="p-name">${escapeHtml(p.name)}</span>${sp && sp.team ? '<span class="tag">' + sp.team + ' 队</span>' : ''}${sp && sp.bankrupt ? '<span class="tag">破产</span>' : ''}${isCur ? '<span class="tag turn">回合中</span>' : ''}<span class="p-money">¥${sp ? sp.money : 1500}</span>`;
    gamePlayerList.appendChild(li2);
  });
}

// 公开房间列表（大厅弹窗）
function renderRooms(rooms) {
  if (!roomsList) return;
  roomsList.innerHTML = '';
  if (!rooms || rooms.length === 0) {
    tip(roomsList, '暂时没有公开房间，点「创建房间」或「⚡ 快速匹配」开一局吧');
    return;
  }
  rooms.forEach((r) => {
    const row = document.createElement('div');
    row.className = 'room-row';
    const info = document.createElement('div');
    info.className = 'room-info';
    const title = document.createElement('div');
    title.className = 'room-code';
    title.textContent = r.code + (r.fastMode ? ' ⚡' : '') + (r.teamMode ? ' 🤝' : '');
    const sub = document.createElement('div');
    sub.className = 'room-sub';
    sub.textContent = r.host + ' 的房间 · ' + r.mapName + ' · ' + r.players + '/' + r.capacity + (r.started ? ' · 已开局（可旁观）' : '');
    info.appendChild(title);
    info.appendChild(sub);
    const btn = mkBtn(r.started ? '旁观' : '加入', r.started ? 'ghost' : 'start');
    btn.addEventListener('click', () => {
      const name = nameInput.value.trim();
      if (!name) { setMsg('请先输入昵称', true); return; }
      sessionStorage.setItem('monopoly_room', r.code);
      roomInput.value = r.code;
      closeRoomsModal();
      ws.send(JSON.stringify({ type: 'join', name, roomCode: r.code, token: authToken || undefined }));
    });
    row.appendChild(info);
    row.appendChild(btn);
    roomsList.appendChild(row);
  });
}

function renderRoomSettings() {
  const show = myIsHost && !state;
  if (settingsBtn) settingsBtn.classList.toggle('hidden', !show);   // 设置改为弹窗，这里控制入口按钮
  if (!show && roomSettings) roomSettings.classList.add('hidden');
  if (!roomSettings) return;
  if (!roomSettingsData) return;
  setMoney.value = String(roomSettingsData.startMoney);
  setRounds.value = String(roomSettingsData.maxRounds);
  setHouse.value = String(roomSettingsData.houseMultiplier);
  if (setMap) setMap.value = roomSettingsData.mapId || 'standard';
  if (setFast) setFast.checked = !!roomSettingsData.fastMode;
  if (setTeam) setTeam.checked = !!roomSettingsData.teamMode;
  if (setInterest) setInterest.value = String(roomSettingsData.interestRate != null ? roomSettingsData.interestRate : 0.01);
  if (setAuction) setAuction.checked = roomSettingsData.auctionOnClose !== false;
  if (setRandomLand) setRandomLand.checked = !!roomSettingsData.randomLand;
  if (setRandomMap) setRandomMap.checked = !!roomSettingsData.randomMap;
}

function sendSettings() {
  ws.send(JSON.stringify({ type: 'update_settings', settings: {
    startMoney: Number(setMoney.value), maxRounds: Number(setRounds.value), houseMultiplier: Number(setHouse.value), mapId: setMap ? setMap.value : 'standard',
    fastMode: !!(setFast && setFast.checked), teamMode: !!(setTeam && setTeam.checked),
    interestRate: Number(setInterest ? setInterest.value : 0.01),
    auctionOnClose: !!(setAuction && setAuction.checked),
    randomLand: !!(setRandomLand && setRandomLand.checked),
    randomMap: !!(setRandomMap && setRandomMap.checked),
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
      html += '<div class="deed-owner" style="background:' + owner.color + '33;color:' + owner.color + '">👤 ' + owner.name + '（' + (state.players.indexOf(owner) + 1) + ' 号）持有 · ' + houses + ' 房</div>';
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
    if (owner) html += '<div class="deed-owner" style="background:' + owner.color + '33;color:' + owner.color + '">👤 ' + owner.name + '（' + (state.players.indexOf(owner) + 1) + ' 号）持有</div>';
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
  if (cardPopupInner) cardPopupInner.style.backgroundImage = "url('assets/" + (isChance ? 'card-chance.webp' : 'card-chest.webp') + "')";
  cardPopupTitle.textContent = isChance ? '❓ 机会' : '🍀 命运';
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



