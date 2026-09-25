import test from 'node:test';
import assert from 'node:assert/strict';
import { GameRoom } from '../server/game-room.js';
import { IDENTITIES, identityMods } from '../js/data/identities.js';
import { getHouseCost } from '../server/rules.js';

const fakeWs = () => ({ readyState: 1, send() {} });

function setup(t, n = 4, settings = {}) {
  const room = new GameRoom();
  const host = room.addPlayer(fakeWs(), '房主', null, null);
  t.after(() => room.resetToLobby());
  room.updateSettings(host.id, settings);
  for (let i = 1; i < n; i++) room.addAI(host.id);
  const r = room.startGame(host.id);
  assert.ok(!r.error, r.error);
  return { room, hostId: host.id, S: room.state };
}

// 走到指定格：把玩家放在目标前一格，然后走 1 步
function stepOnto(room, player, tileId) {
  player.position = (tileId - 1 + room.map.size) % room.map.size;
  room.state.phase = 'rolling';
  room._moveAndResolve(player, room.state.players, 0, 1, 'test');
}

test('身份卡：开局每人一个合法身份，人少时不重复', (t) => {
  const { S } = setup(t, 4);
  const ids = S.players.map(p => p.identity);
  ids.forEach(id => assert.ok(IDENTITIES.some(x => x.id === id), '未知身份: ' + id));
  assert.equal(new Set(ids).size, 4, '4 人应拿到 4 个不同身份: ' + ids.join(','));
  const logs = S.log.filter(l => l.includes('【身份】'));
  assert.equal(logs.length, 4, '每人应有一条身份日志');
});

test('身份：地产大亨买地 9 折、包工头盖房 7 折', (t) => {
  const { room, S } = setup(t, 2, { interestRate: 0 });
  const p = S.players[0];
  const pid = p.id;
  S.current = 0;

  // 地产大亨
  p.identity = 'tycoon';
  p.money = 5000;
  const tileId = room.map.tiles.find(x => x.type === 'property').id;
  S.phase = 'buying';
  S.pendingTile = tileId;
  const before = p.money;
  assert.ok(!room.buyProperty(pid).error);
  const price = room.map.tiles[tileId].price;
  assert.equal(before - p.money, Math.round(price * 0.9), '买地应为 9 折');

  // 包工头
  const group = room.map.tiles[tileId].group;
  room.map.tiles.filter(x => x.type === 'property' && x.group === group)
    .forEach(x => { S.tileOwners[x.id] = pid; S.tileHouses[x.id] = 0; });
  p.identity = 'engineer';
  p.money = 5000;
  S.current = 0;          // 买地会结束回合，这里要切回自己
  S.phase = 'rolling';
  const cashBefore = p.money;
  assert.ok(!room.buildHouse(pid, tileId).error);
  const rawCost = Math.round(getHouseCost(group) * (S.houseMultiplier || 1));
  assert.equal(cashBefore - p.money, Math.round(rawCost * 0.7), '盖房应为 7 折');
});

test('身份：银行家存款利息翻倍、老赖贷款利息减半', (t) => {
  const { room, S } = setup(t, 2);
  const p = S.players[0];
  p.identity = 'banker';
  p.money = 1000;
  S.current = 0;
  room.finishTurn();
  assert.equal(p.money, 1020, '银行家 1% 应翻倍成 2%');

  const p2 = S.players[1];
  p2.identity = 'debtor';
  p2.loan = 1000;
  p2.money = 1000;
  S.current = 1;
  room.finishTurn();
  assert.equal(p2.loan, 1015, '老赖贷款利息应减半（30 → 15）');
});

test('身份：铁公鸡收租 +20%、慈善家过起点额外 +100', (t) => {
  const { room, S } = setup(t, 2);
  const owner = S.players[0];
  const mover = S.players[1];
  owner.identity = 'landlord';
  owner.money = 1000;
  const tileId = room.map.tiles.find(x => x.type === 'property' && x.rent).id;
  S.tileOwners[tileId] = owner.id;
  S.current = 1;
  mover.money = 3000;
  const base = room.calcRent(tileId, owner.id, 1);
  stepOnto(room, mover, tileId);
  assert.equal(owner.money - 1000, Math.round(base * 1.2), '铁公鸡应多收 20%');

  // 慈善家过起点
  const g = S.players[0];
  g.identity = 'generous';
  S.current = 0;
  g.money = 1000;
  g.position = room.map.size - 1;
  room.state.phase = 'rolling';
  room._moveAndResolve(g, S.players, 0, 1, 'test');
  assert.equal(g.money, 1000 + 300 + 100, '慈善家经过起点应为 300+100');
});

test('身份：股神做空额度翻倍', (t) => {
  const { room, S } = setup(t, 2);
  const p = S.players[0];
  const pid = p.id;
  S.current = 0; S.phase = 'rolling';
  p.money = 10000;
  p.identity = 'broker';
  const stock = S.stocks.find(s => s.id === 'bank');
  const want = Math.floor(3000 / stock.price);      // 目标市值 3000：股神上限 4000 可过，普通 2000 不行
  const brokerRes = room.shortSell(pid, 'bank', want);
  assert.ok(!brokerRes.error, '股神应能开到 3000 市值: ' + (brokerRes.error || ''));

  const p2 = S.players[1];
  p2.identity = 'tycoon';                          // 无做空加成
  p2.money = 10000;
  S.current = 1;
  const normalRes = room.shortSell(p2.id, 'bank', want);
  assert.ok(normalRes.error, '普通身份超过 ¥2000 额度应被拒');
});

test('公共基金池：税费进池、踩到免费停车全拿走；关闭后不进池', (t) => {
  const { room, S } = setup(t, 2);
  S.players.forEach(p => { p.identity = null; });

  const taxTile = room.map.tiles.find(x => x.type === 'tax');
  const parkTile = room.map.tiles.find(x => x.type === 'freeparking');
  const p = S.players[0];
  p.money = 5000;
  S.current = 0;
  stepOnto(room, p, taxTile.id);
  assert.equal(S.fund, taxTile.amount, '税款应进入公共基金池');

  const before = p.money;
  stepOnto(room, p, parkTile.id);
  assert.equal(S.fund, 0, '拿走基金后池子清零');
  assert.equal(p.money - before, taxTile.amount, '踩到免费停车应拿走全部基金');

  // 关闭基金池
  const off = setup(t, 2, { fundPool: false });
  const p2 = off.S.players[0];
  p2.money = 5000;
  off.S.current = 0;
  stepOnto(off.room, p2, off.room.map.tiles.find(x => x.type === 'tax').id);
  assert.equal(off.S.fund, 0, '关闭基金池时不应累积');
});

test('解说播报：破产时通过聊天气泡广播', (t) => {
  const sent = [];
  const room = new GameRoom();
  const host = room.addPlayer({ readyState: 1, send: (m) => sent.push(JSON.parse(m)) }, '房主', null, null);
  t.after(() => room.resetToLobby());
  room.updateSettings(host.id, {});
  room.addAI(host.id);
  room.addAI(host.id);
  room.startGame(host.id);
  sent.length = 0;
  room.bankrupt(room.state.players[0], null);
  const chat = sent.find(m => m.type === 'chat');
  assert.ok(chat, '应有解说气泡');
  assert.equal(chat.name, '解说');
  assert.match(chat.text, /破产/);
});

test('身份系数：8 个身份的效果都能取到', () => {
  IDENTITIES.forEach((idn) => {
    const mods = identityMods({ identity: idn.id });
    const changed = Object.entries(mods).some(([k, v]) => (k === 'doublesBonus' || k === 'passGoExtra' ? v > 0 : v !== 1));
    assert.ok(changed, idn.name + ' 应有实际效果');
  });
});
