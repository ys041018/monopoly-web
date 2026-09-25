import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { WebSocket } from 'ws';

let child;
let port;

function freePort() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function waitHealthy(p, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const r = await fetch('http://127.0.0.1:' + p + '/healthz');
      if (r.ok) return true;
    } catch { /* 还没起来 */ }
    if (Date.now() > deadline) return false;
    await sleep(150);
  }
}

function connect() {
  return new Promise((resolve) => {
    const ws = new WebSocket('ws://127.0.0.1:' + port);
    const queue = [];
    const waiters = [];
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      const i = waiters.findIndex(w => w.type === m.type);
      if (i >= 0) { const w = waiters.splice(i, 1)[0]; clearTimeout(w.t); w.resolve(m); }
      else queue.push(m);
    });
    ws.on('open', () => resolve({
      ws,
      send: (o) => ws.send(JSON.stringify(o)),
      wait(type, timeout = 5000) {
        const i = queue.findIndex(m => m.type === type);
        if (i >= 0) return Promise.resolve(queue.splice(i, 1)[0]);
        return new Promise((resolve2, reject) => {
          const w = { type, resolve: resolve2 };
          w.t = setTimeout(() => reject(new Error('等待 ' + type + ' 超时')), timeout);
          waiters.push(w);
        });
      },
      close: () => ws.close(),
    }));
  });
}

before(async () => {
  port = await freePort();
  child = spawn(process.execPath, ['server/index.js'], {
    env: Object.assign({}, process.env, {
      PORT: String(port),
      SUPABASE_URL: '',
      SUPABASE_KEY: '',
      WS_HEARTBEAT_MS: '300',        // 心跳加速，便于测试
    }),
    stdio: 'ignore',
  });
  const okStart = await waitHealthy(port);
  assert.ok(okStart, '服务未能在 10 秒内启动（端口 ' + port + '）');
});

after(() => { if (child) child.kill('SIGKILL'); });

test('健康检查返回 ok', async () => {
  const r = await fetch('http://127.0.0.1:' + port + '/healthz');
  assert.equal(r.status, 200);
  assert.equal((await r.text()).trim(), 'ok');
});

test('静态资源：ETag 与条件请求 304 + 压缩', async () => {
  const first = await fetch('http://127.0.0.1:' + port + '/css/style.css', { headers: { 'Accept-Encoding': 'br' } });
  assert.equal(first.status, 200);
  const etag = first.headers.get('etag');
  assert.ok(etag, '应有 ETag');
  assert.equal(first.headers.get('cache-control'), 'no-cache');
  const second = await fetch('http://127.0.0.1:' + port + '/css/style.css', { headers: { 'If-None-Match': etag } });
  assert.equal(second.status, 304);
});

test('assets 目录使用长缓存', async () => {
  const r = await fetch('http://127.0.0.1:' + port + '/assets/card-chance.webp');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('cache-control') || '', /immutable/);
});

test('安全：点文件与目录穿越被拒', async () => {
  for (const p of ['/.env', '/.git/config', '/..%2fpackage.json', '/%2e%2e/package.json']) {
    const r = await fetch('http://127.0.0.1:' + port + p);
    assert.ok(r.status === 403 || r.status === 404, p + ' 应被拒绝，实际 ' + r.status);
  }
});

test('前端资源全部可访问（白名单不能误伤）', async () => {
  const files = ['/', '/index.html', '/css/style.css', '/js/client.js', '/js/board2d.js',
    '/js/sound.js', '/js/data/maps.js', '/js/data/tiles.js', '/js/data/cards.js',
    '/assets/logo-dice.svg', '/assets/card-chance.webp', '/assets/card-chest.webp'];
  for (const f of files) {
    const r = await fetch('http://127.0.0.1:' + port + f);
    assert.equal(r.status, 200, f + ' 应可访问，实际 ' + r.status);
  }
});

test('安全：服务端源码与配置文件不可下载', async () => {
  for (const p of ['/server/index.js', '/server/db.js', '/package.json', '/package-lock.json', '/.env', '/README.md']) {
    const r = await fetch('http://127.0.0.1:' + port + p);
    assert.equal(r.status, 404, p + ' 应为 404，实际 ' + r.status);
  }
});

test('WebSocket：建房→加入→加机器人→开局→掷骰 全链路', async () => {
  const a = await connect();
  a.send({ type: 'create_room' });
  const code = (await a.wait('room_created')).roomCode;
  assert.match(code, /^[A-Z0-9]{6}$/);
  a.send({ type: 'join', name: '甲', roomCode: code });
  await a.wait('welcome');
  a.send({ type: 'update_settings', settings: { fastMode: true } });
  await a.wait('player_list');
  a.send({ type: 'add_ai' });
  await sleep(150);
  a.send({ type: 'start_game' });
  const st = await a.wait('game_state');
  assert.equal(st.state.players.length, 2);
  assert.equal(st.state.fastMode, true);
  assert.equal(st.state.maxRounds, 60);
  assert.ok(Array.isArray(st.state.stocks) && st.state.stocks.length >= 4, '股票应随开局广播');
  assert.ok(Object.keys(st.state.tileOwners).length > 0, '快速模式应已分地');
  a.send({ type: 'roll_dice' });
  const after = await a.wait('game_state');
  assert.ok(after.state.lastMove && typeof after.state.lastMove.seq === 'number', '掷骰后应有 lastMove.seq');
  a.close();
});

test('心跳：服务端定期发 ping，不回应会被断开', async () => {
  // 正常客户端自动回 pong，应收到 ping 且保持连接
  const alive = new WebSocket('ws://127.0.0.1:' + port);
  let pings = 0;
  alive.on('ping', () => { pings++; });
  await new Promise((resolve) => {
    alive.on('open', resolve);
    setTimeout(resolve, 1500);
  });
  await sleep(800);
  assert.ok(pings >= 1, '应收到至少 1 次 ping，实际 ' + pings);
  assert.equal(alive.readyState, WebSocket.OPEN, '正常客户端不应被断开');
  alive.close();

  // 不自动回 pong 的客户端会被服务端判定为死连接并断开
  const zombie = new WebSocket('ws://127.0.0.1:' + port, { autoPong: false });
  const closed = await new Promise((resolve) => {
    let done = false;
    zombie.on('close', () => { if (!done) { done = true; resolve(true); } });
    zombie.on('open', () => setTimeout(() => { if (!done) { done = true; resolve(zombie.readyState === WebSocket.CLOSED); } }, 1500));
    setTimeout(() => { if (!done) { done = true; resolve(false); } }, 4000);
  });
  assert.ok(closed, '不回 pong 的半开连接应被服务端断开');
});

test('WebSocket：房间不存在时返回友好错误', async () => {
  const c = await connect();
  c.send({ type: 'join', name: '路人', roomCode: 'ZZZZZZ' });
  const err = await c.wait('error');
  assert.match(err.message, /房间不存在/);
  c.close();
});
