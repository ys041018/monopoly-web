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
import { dbReady, findUserByUsername, createUser, createSession, findSession, deleteSession, verifyPassword, getStats } from './db.js';

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

const wss = new WebSocketServer({ server: httpServer });
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

wss.on('connection', (ws) => {
  let playerId = null;
  let isSpectator = false;
  let room = null;
  let roomCode = null;
  const sendError = (m) => { try { ws.send(JSON.stringify({ type: 'error', message: m })); } catch {} };

  const sendJSON = (o) => { try { ws.send(JSON.stringify(o)); } catch {} };

  const handleAuth = async (msg) => {
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
        if (!user || !verifyPassword(String(msg.password || ''), user.password_hash)) { sendJSON({ type: 'auth_error', message: '用户名或密码错误' }); return; }
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

    if (msg.type === 'get_stats') {
      try {
        const u = msg.token ? await findSession(String(msg.token)) : null;
        const stats = u ? await getStats(u.id) : null;
        sendJSON({ type: 'stats', stats: stats || { wins: 0, losses: 0, games: 0, max_assets: 0 } });
      } catch (e) { console.error('[stats]', e.message); }
      return;
    }

    if (msg.type === 'join') {
      if (playerId) return;
      let joinUserId = null;
      if (msg.token) { const u = await findSession(String(msg.token)); if (u) joinUserId = u.id; }
      room = getRoom(msg.roomCode);
      if (!room) { sendError('房间不存在，请检查房间码'); return; }
      roomCode = String(msg.roomCode || '').trim().toUpperCase();
      const result = room.addPlayer(ws, msg.name, msg.playerId, joinUserId);
      console.log('[加入] ' + (msg.name || '(空)') + ' 房间=' + (String(msg.roomCode || '').trim().toUpperCase() || '大厅') + ' -> ' +
        (result.error ? ('拒绝: ' + result.error) : (result.spectator ? '旁观' : '成功 id=' + result.id)));
      if (result.error) { room.sendError(ws, result.error); ws.close(); return; }

      playerId = result.id;
      if (result.spectator) {
        isSpectator = true;
        ws.send(JSON.stringify({ type: 'welcome', playerId: result.id, player: null, spectator: true }));
        if (room.state) ws.send(JSON.stringify({ type: 'game_state', state: room.state }));
        return;
      }
      ws.send(JSON.stringify({ type: 'welcome', playerId: result.id, player: result.player }));
      if (room.state) ws.send(JSON.stringify({ type: 'game_state', state: room.state }));
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

    if (!playerId) { sendError('请先加入房间'); return; }
    if (isSpectator) return;

    switch (msg.type) {
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





