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

function connect(extraHeaders) {
  return new Promise((resolve) => {
    const ws = new WebSocket('ws://127.0.0.1:' + port, extraHeaders ? { headers: extraHeaders } : undefined);
    const queue = [];
    const waiters = [];
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      (ws._seen = ws._seen || []).push(m);
      const i = waiters.findIndex(w => w.type === m.type);
      if (i >= 0) { const w = waiters.splice(i, 1)[0]; clearTimeout(w.t); w.resolve(m); }
      else queue.push(m);
    });
    ws.on('open', () => resolve({
      ws,
      seen: () => ws._seen || [],
      send: (o) => ws.send(JSON.stringify(o)),
      sendRaw: (s) => ws.send(s),
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
      ROOM_GC_MS: '300',             // 房间回收加速
      AUTH_RATE_LIMIT: '3',          // 限流阈值调低，便于测试
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

test('快捷语：白名单校验 + 房间广播 + 冷却限流', async () => {
  const a = await connect();
  a.send({ type: 'create_room' });
  const code = (await a.wait('room_created')).roomCode;
  a.send({ type: 'join', name: '甲', roomCode: code });
  await a.wait('welcome');
  const b = await connect();
  b.send({ type: 'join', name: '乙', roomCode: code });
  await b.wait('welcome');

  const chatsOf = (c) => c.seen().filter(m => m.type === 'chat');
  const errorsOf = (c) => c.seen().filter(m => m.type === 'error');

  // 1) 快捷语广播给同房所有人
  a.send({ type: 'quick_chat', text: '手下留情！' });
  await sleep(400);
  const first = chatsOf(b)[0];
  assert.ok(first, '同伴应收到 chat');
  assert.equal(first.kind, 'text');
  assert.equal(first.text, '手下留情！');
  assert.equal(first.name, '甲');
  assert.ok(first.color, '应带玩家颜色标识');

  // 2) 表情走 emoji 类型（等过 700ms 冷却）
  await sleep(750);
  a.send({ type: 'quick_chat', text: '🎉' });
  await sleep(400);
  const second = chatsOf(b)[1];
  assert.ok(second && second.kind === 'emoji', '表情应以 emoji 类型广播');

  // 3) 冷却期内再发不广播（紧随第 2 条）
  const before = chatsOf(b).length;
  a.send({ type: 'quick_chat', text: '好耶！' });
  await sleep(300);
  assert.equal(chatsOf(b).length, before, '冷却期内不应再广播');

  // 4) 非白名单内容被拒（等冷却过去）
  await sleep(600);
  a.send({ type: 'quick_chat', text: '随便乱打的内容' });
  await sleep(400);
  const err = errorsOf(a).pop();
  assert.ok(err, '非白名单内容应收到错误');
  assert.match(err.message, /快捷语/);
  assert.equal(chatsOf(b).length, before, '被拒内容不应广播');

  a.close(); b.close();
});

test('公开房间列表：列出房间的人数、地图与状态', async () => {
  const a = await connect();
  a.send({ type: 'create_room' });
  const code = (await a.wait('room_created')).roomCode;
  a.send({ type: 'join', name: '甲', roomCode: code });
  await a.wait('welcome');

  const b = await connect();
  b.send({ type: 'join', name: '乙', roomCode: code });
  await b.wait('welcome');

  const viewer = await connect();
  viewer.send({ type: 'list_rooms' });
  const list = (await viewer.wait('room_list')).rooms;
  const mine = list.find(r => r.code === code);
  assert.ok(mine, '列表应包含刚创建的房间');
  assert.equal(mine.players, 2);
  assert.equal(mine.started, false);
  assert.ok(mine.mapName, '应带地图名');
  assert.equal(mine.host, '甲');
  a.close(); b.close(); viewer.close();
});

test('快速匹配：优先进入人数最多的未开局房间', async () => {
  // 房间 A：2 人；房间 B：1 人
  const a1 = await connect();
  a1.send({ type: 'create_room' });
  const codeA = (await a1.wait('room_created')).roomCode;
  a1.send({ type: 'join', name: 'A1', roomCode: codeA });
  await a1.wait('welcome');
  const a2 = await connect();
  a2.send({ type: 'join', name: 'A2', roomCode: codeA });
  await a2.wait('welcome');

  const b1 = await connect();
  b1.send({ type: 'create_room' });
  const codeB = (await b1.wait('room_created')).roomCode;
  b1.send({ type: 'join', name: 'B1', roomCode: codeB });
  await b1.wait('welcome');

  const m = await connect();
  m.send({ type: 'quick_match', name: '路人' });
  const w = await m.wait('welcome');
  assert.ok(w.playerId, '应成功加入某个房间');
  // 确认进入的是 A 房（人更多的那个）
  const probe = a1.seen().filter(x => x.type === 'player_list').pop();
  assert.ok(probe, 'A 房应收到玩家列表更新');
  const names = probe.players.map(p => p.name);
  assert.ok(names.includes('路人'), '快速匹配应加入 A 房，实际玩家: ' + names.join(','));
  a1.close(); a2.close(); b1.close(); m.close();
});

test('快速匹配：总能进入一个房间，且 welcome 带回房间码', async () => {
  const m = await connect();
  m.send({ type: 'quick_match', name: '独狼' });
  const w = await m.wait('welcome');
  assert.ok(w.playerId, '应成功进入房间');
  assert.ok(w.roomCode, 'welcome 应带回房间码（前端靠它记录房间、刷新后可重连）');
  assert.equal(w.spectator, undefined, '未开局的房间不应是旁观');
  m.close();
});

test('健壮性：单条消息超过 64KB 会被断开', async () => {
  const c = await connect();
  const closed = new Promise((resolve) => {
    c.ws.on('close', (code) => resolve(code));
    setTimeout(() => resolve(null), 3000);
  });
  c.sendRaw(JSON.stringify({ type: 'join', name: 'x'.repeat(70000), roomCode: 'AAAAAA' }));
  const code = await closed;
  assert.ok(code !== null, '超大消息应导致连接被断开（实际未断开）');
});

test('健壮性：跨站 Origin 被拒绝，同源放行', async () => {
  const bad = await new Promise((resolve) => {
    const ws = new WebSocket('ws://127.0.0.1:' + port, { headers: { Origin: 'https://evil.example.com' } });
    ws.on('close', (code) => resolve(code));
    ws.on('open', () => setTimeout(() => resolve('still-open'), 500));
    setTimeout(() => resolve('timeout'), 2500);
  });
  assert.equal(bad, 1008, '跨站 Origin 应以 1008 关闭，实际 ' + bad);

  const same = await new Promise((resolve) => {
    const ws = new WebSocket('ws://127.0.0.1:' + port, { headers: { Origin: 'http://127.0.0.1:' + port } });
    let opened = false;
    ws.on('message', () => { opened = true; });
    ws.on('open', () => { ws.send(JSON.stringify({ type: 'list_rooms' })); });
    ws.on('close', () => resolve('closed'));
    setTimeout(() => resolve(opened ? 'ok' : 'no-message'), 1500);
  });
  assert.equal(same, 'ok', '同源连接应正常工作，实际 ' + same);
});

test('健壮性：昵称在服务端被裁剪到 12 字', async () => {
  const a = await connect();
  a.send({ type: 'create_room' });
  const code = (await a.wait('room_created')).roomCode;
  a.send({ type: 'join', name: '超长昵称'.repeat(20), roomCode: code });
  await a.wait('welcome');
  const pl = a.seen().filter(m => m.type === 'player_list').pop();
  const name = pl.players[0].name;
  assert.ok(name.length <= 12, '昵称应被裁剪，实际长度 ' + name.length + ': ' + name);
  a.close();
});

test('健壮性：登录尝试过于频繁会被限流', async () => {
  const c = await connect();
  const results = [];
  for (let i = 0; i < 6; i++) {
    c.send({ type: 'login', username: 'nobody', password: 'whatever' });
    results.push(await c.wait('auth_error'));
  }
  const limited = results.filter(r => /频繁/.test(r.message));
  assert.ok(limited.length >= 1, '超过阈值后应出现限流提示，实际: ' + results.map(r => r.message).join(' | '));
  c.close();
});

test('健壮性：没人加入的房间会被回收', async () => {
  const c = await connect();
  c.send({ type: 'create_room' });
  const code = (await c.wait('room_created')).roomCode;
  c.send({ type: 'list_rooms' });
  const before = (await c.wait('room_list')).rooms.some(r => r.code === code);
  await sleep(900);                       // ROOM_GC_MS=300
  c.send({ type: 'list_rooms' });
  const after = (await c.wait('room_list')).rooms.some(r => r.code === code);
  assert.ok(!after, '空房间应被回收（回收前存在=' + before + '）');
  c.close();
});

test('WebSocket：房间不存在时返回友好错误', async () => {
  const c = await connect();
  c.send({ type: 'join', name: '路人', roomCode: 'ZZZZZZ' });
  const err = await c.wait('error');
  assert.match(err.message, /房间不存在/);
  c.close();
});
