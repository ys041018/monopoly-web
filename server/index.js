// ============================================================
// 大富翁 - 服务端入口（HTTP 静态服务 + WebSocket）
// ============================================================
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import { readFile, stat } from 'fs';
import { extname, join, resolve, dirname, sep } from 'path';
import { gzipSync, deflateSync, brotliCompressSync, constants as zlibConstants } from 'zlib';
import { fileURLToPath } from 'url';
import os from 'os';
import { GameRoom } from './game-room.js';
import { getMap } from '../js/data/maps.js';
import { MAX_PLAYERS } from './rules.js';
import { QUICK_PHRASES, QUICK_EMOJIS, CHAT_COOLDOWN_MS } from '../js/data/chat.js';
import { dbReady, findUserByUsername, createUser, createSession, findSession, deleteSession, verifyPassword, getStats, pruneSessions, getLeaderboard, getRank, getPlayerCount } from './db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');
const assetsDir = join(rootDir, 'assets');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
};

// 文本类资源才压缩；结果按 路径|mtime|编码 缓存，避免每次请求重复压缩
const COMPRESSIBLE = /^(text\/|application\/(javascript|json)|image\/svg)/;
const compressCache = new Map();
const COMPRESS_CACHE_MAX = 64;

function acceptedEncodings(header) {
  const set = new Set();
  String(header || '').toLowerCase().split(',').forEach((part) => {
    const [name, ...params] = part.trim().split(';');
    if (!name) return;
    if (params.some((p) => /^q=0(\.0*)?$/.test(p.trim()))) return;
    set.add(name.trim());
  });
  return set;
}

function pickEncoding(req, type, length) {
  if (length < 1024 || !COMPRESSIBLE.test(type)) return null;
  const ok = acceptedEncodings(req.headers['accept-encoding']);
  if (ok.has('br')) return 'br';
  if (ok.has('gzip')) return 'gzip';
  if (ok.has('deflate')) return 'deflate';
  return null;
}

function compressBody(key, data, enc) {
  const cached = compressCache.get(key);
  if (cached) return cached;
  let out;
  try {
    if (enc === 'br') out = brotliCompressSync(data, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 5 } });
    else if (enc === 'gzip') out = gzipSync(data, { level: 6 });
    else out = deflateSync(data, { level: 6 });
  } catch { return null; }
  if (compressCache.size >= COMPRESS_CACHE_MAX) compressCache.clear();
  compressCache.set(key, out);
  return out;
}

const httpServer = createServer((req, res) => {
  const method = req.method || 'GET';
  if (method !== 'GET' && method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD', 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Method Not Allowed');
    return;
  }

  // Render 健康检查：不读文件、不写日志
  if ((req.url || '').split('?')[0] === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(method === 'HEAD' ? undefined : 'ok');
    return;
  }

  let urlPath;
  try {
    urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Bad Request');
    return;
  }
  if (urlPath === '/') urlPath = '/index.html';
  // 屏蔽点文件/点目录（.env、.git、.node-version 等）
  if (/(^|\/)\./.test(urlPath)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
    return;
  }

  // 只允许前端资源目录，服务端源码/配置文件一律不对外（顺带阻断 ../ 穿越）
  const ALLOWED = ['/index.html', '/css/', '/js/', '/assets/'];
  if (!ALLOWED.some((p) => (p.endsWith('/') ? urlPath.startsWith(p) : urlPath === p))) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
    return;
  }

  const filePath = resolve(rootDir, '.' + urlPath);
  if (filePath !== rootDir && !filePath.startsWith(rootDir + sep)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Forbidden');
    return;
  }

  stat(filePath, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
      return;
    }

    const type = MIME[extname(filePath).toLowerCase()] || 'application/octet-stream';
    const etag = 'W/"' + st.size.toString(16) + '-' + Math.floor(st.mtimeMs).toString(16) + '"';
    const headers = {
      'Content-Type': type,
      'Cache-Control': filePath.startsWith(assetsDir + sep) ? 'public, max-age=31536000, immutable' : 'no-cache',
      'ETag': etag,
      'Last-Modified': st.mtime.toUTCString(),
      'Vary': 'Accept-Encoding',
    };

    // 条件请求：命中即 304，回访时只传几百字节
    const since = Date.parse(req.headers['if-modified-since'] || '');
    if (req.headers['if-none-match'] === etag
      || (!req.headers['if-none-match'] && since && Math.floor(since / 1000) >= Math.floor(st.mtimeMs / 1000))) {
      res.writeHead(304, headers);
      res.end();
      return;
    }

    readFile(filePath, (readErr, data) => {
      if (readErr) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Server Error');
        return;
      }
      let body = data;
      const enc = pickEncoding(req, type, data.length);
      if (enc) {
        const packed = compressBody(filePath + '|' + Math.floor(st.mtimeMs) + '|' + enc, data, enc);
        if (packed && packed.length < data.length) {
          body = packed;
          headers['Content-Encoding'] = enc;
        }
      }
      headers['Content-Length'] = body.length;
      res.writeHead(200, headers);
      res.end(method === 'HEAD' ? undefined : body);
    });
  });
});

// 单条消息上限 64KB（默认是 100MB，容易被一条大消息打爆）
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map(x => x.trim()).filter(Boolean);
const wss = new WebSocketServer({ server: httpServer, maxPayload: 64 * 1024 });

// Origin 校验：默认只允许同源（防跨站 WebSocket 劫持）；可用 ALLOWED_ORIGINS 覆盖；无 Origin 的脚本客户端放行
function originAllowed(origin, host) {
  if (!origin) return true;
  if (ALLOWED_ORIGINS.length) return ALLOWED_ORIGINS.includes(origin);
  try { return new URL(origin).host === host; } catch { return false; }
}

// 登录/注册限流（内存计数，按 IP；AUTH_RATE_LIMIT 可覆盖）
const AUTH_RATE_LIMIT = Number(process.env.AUTH_RATE_LIMIT) || 20;
const AUTH_WINDOW_MS = 5 * 60 * 1000;
const authHits = new Map();
function authRateLimited(ip) {
  const now = Date.now();
  const rec = authHits.get(ip);
  if (!rec || now > rec.resetAt) { authHits.set(ip, { count: 1, resetAt: now + AUTH_WINDOW_MS }); return false; }
  rec.count += 1;
  return rec.count > AUTH_RATE_LIMIT;
}

// 昵称清洗：去掉控制字符、限长 12
function cleanNickname(raw) {
  const name = String(raw || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 12);
  return name || '玩家';
}

// 心跳探活：30 秒一轮，连续两轮没回应就断开
// 避免手机切网/锁屏产生的半开连接一直占着玩家位（服务端以为他还在线）
const HEARTBEAT_MS = Number(process.env.WS_HEARTBEAT_MS) || 30000;
const heartbeatTimer = setInterval(() => {
  wss.clients.forEach((client) => {
    if (client.isAlive === false) { try { client.terminate(); } catch {} return; }
    client.isAlive = false;
    try { client.ping(); } catch {}
  });
}, HEARTBEAT_MS);
wss.on('close', () => clearInterval(heartbeatTimer));
// 多房间：按房间码路由到独立 GameRoom
const rooms = new Map();
function genCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do { code = Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join(''); }
  while (rooms.has(code));
  return code;
}
function getRoom(code) {
  const key = String(code || '').trim().toUpperCase();
  return rooms.get(key) || null;
}

wss.on('connection', (ws, req) => {
  if (!originAllowed(req.headers.origin, req.headers.host)) {
    try { ws.close(1008, 'origin not allowed'); } catch {}
    return;
  }
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  let playerId = null;
  let isSpectator = false;
  let lastChatAt = 0;
  let room = null;
  let roomCode = null;
  const sendError = (m) => { try { ws.send(JSON.stringify({ type: 'error', message: m })); } catch {} };

  const sendJSON = (o) => { try { ws.send(JSON.stringify(o)); } catch {} };

  const handleAuth = async (msg) => {
    // 登录/注册限流（token 校验不算）——放在 dbReady 之前，未配置数据库时同样生效
    if (msg.type !== 'auth') {
      const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
      if (authRateLimited(ip)) { sendJSON({ type: 'auth_error', message: '尝试太频繁，请 5 分钟后再试' }); return; }
    }
    if (!dbReady()) { sendJSON({ type: 'auth_error', message: '账号服务未配置（缺少 SUPABASE_URL / SUPABASE_KEY）' }); return; }
    try {
      if (msg.type === 'register') {
        const username = String(msg.username || '').trim();
        const password = String(msg.password || '');
        const nickname = String(msg.nickname || '').trim() || username;
        if (username.length < 3 || password.length < 6) { sendJSON({ type: 'auth_error', message: '用户名至少 3 位，密码至少 6 位' }); return; }
        const exists = await findUserByUsername(username);
        if (exists) { sendJSON({ type: 'auth_error', message: '用户名已被注册' }); return; }
        const r = await createUser(username, password, nickname);
        if (r.error || !r.user) { sendJSON({ type: 'auth_error', message: r.error || '注册失败' }); return; }
        const sess = await createSession(r.user.id);
        sendJSON({ type: 'auth_ok', token: sess.token, user: { id: r.user.id, username: r.user.username, nickname: r.user.nickname } });
      } else if (msg.type === 'login') {
        const user = await findUserByUsername(String(msg.username || '').trim());
        if (!user || !(await verifyPassword(String(msg.password || ''), user.password_hash))) { sendJSON({ type: 'auth_error', message: '用户名或密码错误' }); return; }
        const sess = await createSession(user.id);
        sendJSON({ type: 'auth_ok', token: sess.token, user: { id: user.id, username: user.username, nickname: user.nickname } });
      } else if (msg.type === 'auth') {
        const user = await findSession(String(msg.token || ''));
        if (!user) { sendJSON({ type: 'auth_error', message: '登录已过期' }); return; }
        sendJSON({ type: 'auth_ok', token: msg.token, user: { id: user.id, username: user.username, nickname: user.nickname } });
      } else if (msg.type === 'logout') {
        await deleteSession(String(msg.token || ''));
        sendJSON({ type: 'auth_logout' });
      }
    } catch (e) {
      console.error('[auth]', e.message);
      sendJSON({ type: 'auth_error', message: '账号服务异常' });
    }
  };

  ws.on('message', async (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); }
    catch { sendError('消息格式错误'); return; }

    if (msg.type === 'register' || msg.type === 'login' || msg.type === 'auth' || msg.type === 'logout') {
      handleAuth(msg);
      return;
    }

    // 个人主页：资料 + 战绩 + 排名 + 排行榜
    if (msg.type === 'get_profile') {
      if (!dbReady()) { sendJSON({ type: 'profile', unavailable: true }); return; }
      try {
        const u = msg.token ? await findSession(String(msg.token)) : null;
        if (!u) { sendJSON({ type: 'profile', needLogin: true }); return; }
        const stats = (await getStats(u.id)) || { wins: 0, losses: 0, games: 0, max_assets: 0 };
        const rank = await getRank(stats.wins || 0);
        const total = await getPlayerCount();
        const leaderboard = await getLeaderboard(10);
        sendJSON({
          type: 'profile',
          user: { id: u.id, username: u.username, nickname: u.nickname },
          stats,
          rank,
          total,
          leaderboard,
        });
      } catch (e) {
        console.error('[profile]', e.message);
        sendJSON({ type: 'profile', unavailable: true });
      }
      return;
    }

    // 公开排行榜（无需登录）
    if (msg.type === 'get_leaderboard') {
      if (!dbReady()) { sendJSON({ type: 'leaderboard', rows: [], unavailable: true }); return; }
      try {
        sendJSON({ type: 'leaderboard', rows: await getLeaderboard(Number(msg.limit) || 20) });
      } catch (e) {
        console.error('[leaderboard]', e.message);
        sendJSON({ type: 'leaderboard', rows: [], unavailable: true });
      }
      return;
    }

    if (msg.type === 'get_stats') {
      try {
        const u = msg.token ? await findSession(String(msg.token)) : null;
        const stats = u ? await getStats(u.id) : null;
        sendJSON({ type: 'stats', stats: stats || { wins: 0, losses: 0, games: 0, max_assets: 0 } });
      } catch (e) { console.error('[stats]', e.message); }
      return;
    }

    // 入房逻辑（join / quick_match 共用）
    const joinRoom = async (codeRaw, name, savedPlayerId, token) => {
      let joinUserId = null;
      if (token) { const u = await findSession(String(token)); if (u) joinUserId = u.id; }
      const target = getRoom(codeRaw);
      if (!target) { sendError('房间不存在，请检查房间码'); return false; }
      room = target;
      roomCode = String(codeRaw || '').trim().toUpperCase();
      const result = room.addPlayer(ws, cleanNickname(name), savedPlayerId, joinUserId);
      console.log('[加入] ' + cleanNickname(name) + ' 房间=' + roomCode + ' -> ' +
        (result.error ? ('拒绝: ' + result.error) : (result.spectator ? '旁观' : '成功 id=' + result.id)));
      if (result.error) { room.sendError(ws, result.error); ws.close(); return false; }

      playerId = result.id;
      if (result.spectator) {
        isSpectator = true;
        ws.send(JSON.stringify({ type: 'welcome', playerId: result.id, player: null, spectator: true, roomCode }));
        if (room.state) ws.send(JSON.stringify({ type: 'game_state', state: room.state }));
        return true;
      }
      ws.send(JSON.stringify({ type: 'welcome', playerId: result.id, player: result.player, roomCode }));
      if (room.state) ws.send(JSON.stringify({ type: 'game_state', state: room.state }));
      return true;
    };

    if (msg.type === 'join') {
      if (playerId) return;
      await joinRoom(msg.roomCode, msg.name, msg.playerId, msg.token);
      return;
    }

    // 公开房间列表
    if (msg.type === 'list_rooms') {
      const list = [...rooms.entries()]
        .filter(([, r]) => r.players.size > 0)
        .map(([code, r]) => ({
          code,
          players: r.players.size,
          capacity: MAX_PLAYERS,
          started: !!r.started,
          mapId: r.settings.mapId,
          mapName: getMap(r.settings.mapId).name,
          host: ((r.players.values().next().value || {}).name) || '',
          fastMode: !!r.settings.fastMode,
          teamMode: !!r.settings.teamMode,
        }))
        .sort((a, b) => (a.started === b.started ? b.players - a.players : (a.started ? 1 : -1)))
        .slice(0, 30);
      ws.send(JSON.stringify({ type: 'room_list', rooms: list }));
      return;
    }

    // 快速匹配：优先进入「人最多但还能进」的房间，没有就新建
    if (msg.type === 'quick_match') {
      if (playerId) return;
      const open = [...rooms.entries()]
        .filter(([, r]) => !r.started && r.players.size > 0 && r.players.size < MAX_PLAYERS)
        .sort((a, b) => b[1].players.size - a[1].players.size);
      let code = open.length ? open[0][0] : null;
      if (code) {
        console.log('[快速匹配] 命中房间 ' + code + '（' + getRoom(code).players.size + ' 人）');
      } else {
        code = genCode();
        rooms.set(code, new GameRoom());
        ws.send(JSON.stringify({ type: 'room_created', roomCode: code }));
        console.log('[快速匹配] 无可用房间，新建 ' + code);
      }
      await joinRoom(code, msg.name, undefined, msg.token);
      return;
    }

    if (msg.type === 'create_room') {
      const code = genCode();
      rooms.set(code, new GameRoom());
      ws.send(JSON.stringify({ type: 'room_created', roomCode: code }));
      return;
    }

    // 主动离开房间（退出登录 / 回大厅）：解绑连接并回收空房间
    if (msg.type === 'leave_room') {
      if (room && playerId) {
        if (isSpectator) room.removeSpectator(playerId);
        else room.removePlayer(playerId);
        if (room.players.size === 0 && !room.started && roomCode) rooms.delete(roomCode);
      }
      playerId = null;
      isSpectator = false;
      room = null;
      roomCode = null;
      ws.send(JSON.stringify({ type: 'left_room' }));
      return;
    }

    if (room) room.lastActiveAt = Date.now();

    if (!playerId) { sendError('请先加入房间'); return; }

    // 局内快捷语 / 表情弹幕（白名单 + 冷却，避免刷屏）
    if (msg.type === 'quick_chat') {
      const now = Date.now();
      if (now - lastChatAt < CHAT_COOLDOWN_MS) return;      // 冷却期内静默丢弃
      const text = String(msg.text || '').slice(0, 20);
      const isEmoji = QUICK_EMOJIS.includes(text);
      const isPhrase = QUICK_PHRASES.includes(text);
      if (!isEmoji && !isPhrase) { sendError('快捷语不在可选列表里'); return; }
      lastChatAt = now;
      const me = room.players.get(playerId);
      room.broadcast(JSON.stringify({
        type: 'chat',
        kind: isEmoji ? 'emoji' : 'text',
        text,
        name: me ? me.name : '观众',
        color: me ? me.color : '#8a8ab0',
      }));
      return;
    }

    if (isSpectator) return;

    switch (msg.type) {
      case 'kick_player': {
        const r = room.kickPlayer(playerId, String(msg.playerId || ''));
        if (r.error) room.sendError(ws, r.error);
        else console.log('[踢人] ' + playerId + ' 踢出 ' + r.name);
        break;
      }
      case 'transfer_host': {
        const r = room.transferHost(playerId, String(msg.playerId || ''));
        if (r.error) room.sendError(ws, r.error);
        else console.log('[转让房主] ' + playerId + ' -> ' + r.name);
        break;
      }
      case 'update_settings': {
        const r = room.updateSettings(playerId, msg.settings);
        if (r.error) room.sendError(ws, r.error);
        break;
      }
      case 'add_ai': {
        const r = room.addAI(playerId);
        if (r.error) room.sendError(ws, r.error);
        break;
      }
      case 'start_game': {
        const r = room.startGame(playerId);
        console.log('[开局] ' + playerId + ' -> ' + (r.error ? ('拒绝: ' + r.error) : '成功'));
        if (r.error) room.sendError(ws, r.error);
        break;
      }
      case 'roll_dice': {
        const r = room.rollDice(playerId);
        if (r.error) room.sendError(ws, r.error);
        break;
      }
      case 'buy_property': {
        const r = room.buyProperty(playerId);
        if (r.error) room.sendError(ws, r.error);
        break;
      }
      case 'bid': {
        const r = room.bid(playerId, msg.amount);
        if (r.error) room.sendError(ws, r.error);
        break;
      }
      case 'skip_buy': {
        const r = room.skipBuy(playerId);
        if (r.error) room.sendError(ws, r.error);
        break;
      }
      case 'mortgage': {
        const r = room.mortgageProperty(playerId, msg.tileId);
        if (r.error) room.sendError(ws, r.error);
        break;
      }
      case 'sell_house': {
        const r = room.sellHouse(playerId, msg.tileId);
        if (r.error) room.sendError(ws, r.error);
        break;
      }
      case 'unmortgage': {
        const r = room.unmortgageProperty(playerId, msg.tileId);
        if (r.error) room.sendError(ws, r.error);
        break;
      }
      case 'propose_trade': {
        const r = room.proposeTrade(playerId, msg.proposal);
        if (r.error) room.sendError(ws, r.error);
        break;
      }
      case 'accept_trade': {
        const r = room.acceptTrade(playerId);
        if (r.error) room.sendError(ws, r.error);
        break;
      }
      case 'reject_trade': {
        const r = room.rejectTrade(playerId);
        if (r.error) room.sendError(ws, r.error);
        break;
      }
      case 'build_house': {
        const r = room.buildHouse(playerId, msg.tileId);
        if (r.error) room.sendError(ws, r.error);
        break;
      }
      case 'buy_stock': {
        const r = room.buyStock(playerId, msg.stockId, msg.shares);
        if (r.error) room.sendError(ws, r.error);
        break;
      }
      case 'short_sell': {
        const r = room.shortSell(playerId, msg.stockId, msg.shares);
        if (r.error) room.sendError(ws, r.error);
        break;
      }
      case 'cover_short': {
        const r = room.coverShort(playerId, msg.stockId, msg.shares);
        if (r.error) room.sendError(ws, r.error);
        break;
      }
      case 'take_loan': {
        const r = room.takeLoan(playerId, msg.amount);
        if (r.error) room.sendError(ws, r.error);
        break;
      }
      case 'repay_loan': {
        const r = room.repayLoan(playerId, msg.amount);
        if (r.error) room.sendError(ws, r.error);
        break;
      }
      case 'sell_stock': {
        const r = room.sellStock(playerId, msg.stockId, msg.shares);
        if (r.error) room.sendError(ws, r.error);
        break;
      }
      case 'pay_bail': {
        const r = room.payBail(playerId);
        if (r.error) room.sendError(ws, r.error);
        break;
      }
      case 'use_jail_card': {
        const r = room.useJailCard(playerId);
        if (r.error) room.sendError(ws, r.error);
        break;
      }
      case 'end_turn': {
        const r = room.endTurn(playerId);
        if (r.error) room.sendError(ws, r.error);
        break;
      }
      case 'back_to_lobby': {
        const r = room.backToLobby(playerId);
        console.log('[回大厅] ' + playerId + ' -> ' + (r.error ? ('拒绝: ' + r.error) : '成功'));
        if (r.error) room.sendError(ws, r.error);
        break;
      }
      default:
        room.sendError(ws, '未知消息类型: ' + msg.type);
    }
  });

  ws.on('close', () => {
    if (!playerId || !room) return;
    if (isSpectator) room.removeSpectator(playerId);
    else room.removePlayer(playerId);
    if (room.players.size === 0 && !room.started && roomCode) rooms.delete(roomCode);
  });
  ws.on('error', () => {});
});

// 定期清理：空房间 / 长期无人活动的大厅 / 过期会话
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    const idle = now - (room.lastActiveAt || now);
    const empty = room.players.size === 0;
    if (empty || (!room.started && idle > 30 * 60 * 1000)) {
      if (room._turnTimer) clearTimeout(room._turnTimer);
      if (room._aiTimer) clearTimeout(room._aiTimer);
      if (room._auctionTimer) clearTimeout(room._auctionTimer);
      rooms.delete(code);
    }
  }
}, Number(process.env.ROOM_GC_MS) || 5 * 60 * 1000).unref();

if (dbReady()) {
  pruneSessions().catch((e) => console.error('[prune]', e.message));
  setInterval(() => { pruneSessions().catch((e) => console.error('[prune]', e.message)); }, 6 * 3600 * 1000).unref();
}

const PORT = process.env.PORT || 4000;
httpServer.listen(PORT, '0.0.0.0', () => {
  console.log('========================================');
  console.log('  大富翁 - 网页联机版');
  console.log('========================================');
  console.log('  端口: ' + PORT);
  console.log('  本机访问: http://localhost:' + PORT);
  const ifaces = os.networkInterfaces();
  console.log('  局域网地址:');
  let found = false;
  Object.keys(ifaces).forEach((name) => {
    ifaces[name].forEach((iface) => {
      if (iface.family === 'IPv4' && !iface.internal) {
        console.log('    http://' + iface.address + ':' + PORT);
        found = true;
      }
    });
  });
  if (!found) console.log('    http://localhost:' + PORT);
  console.log('========================================');
});





