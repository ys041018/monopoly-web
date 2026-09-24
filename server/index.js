// ============================================================
// 大富翁 - 服务端入口（HTTP 静态服务 + WebSocket）
// ============================================================
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import { readFile, existsSync } from 'fs';
import { extname, join, dirname } from 'path';
import { fileURLToPath } from 'url';
import os from 'os';
import { GameRoom } from './game-room.js';
import { dbReady, findUserByUsername, createUser, createSession, findSession, deleteSession, verifyPassword } from './db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const httpServer = createServer((req, res) => {
  let urlPath = req.url.split('?')[0];
  if (urlPath === '/') urlPath = '/index.html';

  const filePath = join(rootDir, urlPath);
  if (!filePath.startsWith(rootDir)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  if (!existsSync(filePath)) {
    res.writeHead(404); res.end('Not Found'); return;
  }
  const ext = extname(filePath).toLowerCase();
  readFile(filePath, (err, data) => {
    if (err) { res.writeHead(500); res.end('Server Error'); return; }
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
    });
    res.end(data);
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

  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); }
    catch { sendError('消息格式错误'); return; }

    if (msg.type === 'register' || msg.type === 'login' || msg.type === 'auth' || msg.type === 'logout') {
      handleAuth(msg);
      return;
    }

    if (msg.type === 'join') {
      if (playerId) return;
      room = getRoom(msg.roomCode);
      if (!room) { sendError('房间不存在，请检查房间码'); return; }
      roomCode = String(msg.roomCode || '').trim().toUpperCase();
      const result = room.addPlayer(ws, msg.name, msg.playerId);
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





