import test from 'node:test';
import assert from 'node:assert/strict';
import { GameRoom } from '../server/game-room.js';
import { getHouseCost } from '../server/rules.js';

const fakeWs = () => ({ readyState: 1, send() {} });

function setup(t, { bots = 3, settings = {} } = {}) {
  // 断言失败也必须清理计时器，否则回合定时器会让测试进程不退出
  t.after(() => room.resetToLobby());
  const room = new GameRoom();
  const host = room.addPlayer(fakeWs(), '房主', null, null);
  assert.ok(!host.error, host.error);
  room.updateSettings(host.id, settings);
  for (let i = 0; i < bots; i++) {
    const r = room.addAI(host.id);
    assert.ok(!r.error, r.error);
  }
  const started = room.startGame(host.id);
  assert.ok(!started.error, started.error);
  return { room, hostId: host.id, S: room.state };
}

const ownerCount = (S, pid) => Object.entries(S.tileOwners).filter(([, o]) => o === pid).length;

test('开局：4 人、第 1 回合、首回合倒计时已启动', (t) => {
  const { room, S } = setup(t);
  assert.equal(S.players.length, 4);
  assert.equal(S.round, 1);
  assert.equal(S.phase, 'rolling');
  const left = S.turnDeadline - Date.now();
  assert.ok(left > 40000 && left <= 45000, '首回合倒计时 ' + left);
});

test('快速模式：3000 资金 / 60 回合 / 45 秒 / 租金 1.5 倍 / 开局随机分地', (t) => {
  const { room, S } = setup(t, { settings: { fastMode: true } });
  assert.equal(S.fastMode, true);
  assert.equal(S.players[0].money, 3000);
  assert.equal(S.maxRounds, 60);
  assert.equal(S.turnTimeout, 45000);
  assert.equal(S.rentMultiplier, 1.5);
  const counts = S.players.map(p => ownerCount(S, p.id));
  assert.ok(counts[0] > 0, '应当分地');
  assert.ok(counts.every(c => c === counts[0]), '每人地数应相同: ' + counts.join(','));
  for (const tid of Object.keys(S.tileOwners)) {
    assert.equal(room.map.tiles[Number(tid)].type, 'property', '只分地产格');
  }
});

test('普通模式不分地', (t) => {
  const { room, S } = setup(t, { settings: { fastMode: false } });
  assert.equal(Object.keys(S.tileOwners).length, 0);
});

test('团队模式：需要偶数人数、ABAB 分队、队友免租、跨队收租乘倍率', (t) => {
  const room = new GameRoom();
  const host = room.addPlayer(fakeWs(), '房主', null, null);
  room.updateSettings(host.id, { teamMode: true });
  room.addAI(host.id);
  const solo = new GameRoom();
  const soloHost = solo.addPlayer(fakeWs(), '单', null, null);
  solo.updateSettings(soloHost.id, { teamMode: true });
  solo.addAI(soloHost.id);
  solo.addAI(soloHost.id);
  assert.ok(solo.startGame(soloHost.id).error, '3 人团队开局应被拒绝');

  for (let i = 0; i < 2; i++) room.addAI(host.id);
  assert.ok(!room.startGame(host.id).error);
  const S = room.state;
  assert.equal(S.teamMode, true);
  assert.equal(S.players.map(p => p.team).join(''), 'ABAB');

  // 同队免租
  S.tileOwners[1] = S.players[2].id;
  const mate = S.players[0];
  mate.position = 0; mate.money = 2000; S.players[2].money = 2000; S.phase = 'after_move';
  room._moveAndResolve(mate, S.players, 0, 1, 'test');
  assert.equal(mate.money, 2000, '队友免租');
  assert.equal(S.players[2].money, 2000);

  // 跨队收租（快速模式外倍率为 1）
  const foe = S.players[1];
  foe.position = 0; foe.money = 2000; S.players[2].money = 2000;
  const base = room.calcRent(1, S.players[2].id, 1);
  room._moveAndResolve(foe, S.players, 0, 1, 'test');
  assert.equal(2000 - foe.money, base, '跨队按基础租金');
  assert.equal(S.players[2].money, 2000 + base, '租金给地主');
});

test('股票：买卖、持仓成本（加权均价）、部分卖出、清仓归零、越权拒绝', (t) => {
  const { room, S } = setup(t);
  const pid = S.players[0].id;
  S.current = 0; S.phase = 'rolling';
  S.players[0].money = 100000;

  const bank = S.stocks.find(s => s.id === 'bank');
  const p1 = bank.price;
  assert.ok(!room.buyStock(pid, 'bank', 10).error);
  assert.equal(S.players[0].stocks.bank, 10);
  assert.equal(S.players[0].stockCost.bank, p1 * 10, '买入成本');
  assert.equal(S.players[0].money, 100000 - p1 * 10, '买入扣款');

  bank.price = 150;
  assert.ok(!room.buyStock(pid, 'bank', 10).error);
  const cost = p1 * 10 + 1500;
  assert.equal(S.players[0].stockCost.bank, cost, '成本累加');
  const avg = Math.round(cost / 20);

  assert.ok(!room.sellStock(pid, 'bank', 10).error);
  assert.equal(S.players[0].stocks.bank, 10);
  assert.equal(S.players[0].stockCost.bank, cost - avg * 10, '按均价扣成本');

  assert.ok(!room.sellStock(pid, 'bank', 10).error);
  assert.equal(S.players[0].stocks.bank, 0);
  assert.equal(S.players[0].stockCost.bank, 0, '清仓归零');

  assert.ok(room.sellStock(pid, 'bank', 1).error, '空仓不能卖');
  assert.ok(room.buyStock(pid, '不存在', 1).error, '未知股票');
  assert.ok(room.buyStock(pid, 'bank', 0).error, '股数必须为正');
  S.current = 1;
  assert.ok(room.buyStock(pid, 'bank', 1).error, '非自己回合不能交易');
  S.current = 0;
});

test('股票：购买阶段（待买地）也能交易', (t) => {
  const { room, S } = setup(t);
  const pid = S.players[0].id;
  S.current = 0; S.phase = 'buying'; S.pendingTile = 1;
  assert.ok(!room.buyStock(pid, 'bank', 1).error, 'buying 阶段应允许交易');
});

test('股票：价格每轮波动且不越界', (t) => {
  const { room, S } = setup(t);
  const before = S.stocks.map(s => s.price);
  for (let i = 0; i < 40; i++) room._updateStockPrices();
  S.stocks.forEach((s, i) => {
    assert.ok(s.price >= Math.round(s.base * 0.3), s.id + ' 下限');
    assert.ok(s.price <= Math.round(s.base * 2.5), s.id + ' 上限');
    assert.ok(Number.isFinite(s.price));
  });
  assert.ok(before.length === S.stocks.length);
});

test('融券做空：开仓得现金、按额度限制、平仓结算盈亏、计入负债', (t2) => {
  const { room, S } = setup(t2);
  const p = S.players[0];
  const pid = p.id;
  S.current = 0; S.phase = 'rolling';
  p.money = 4000;
  const bank = S.stocks.find(s => s.id === 'bank');
  const price = bank.price;

  // 开仓：卖出即得现金
  assert.ok(!room.shortSell(pid, 'bank', 5).error);
  assert.equal(p.shorts.bank, 5, '空头股数');
  assert.equal(p.money, 4000 + price * 5, '开仓所得现金');
  assert.equal(p.shortEntry.bank, price * 5, '开仓总额');

  // 超过额度被拒（额度上限 2000 或现金 50%）
  assert.ok(room.shortSell(pid, 'bank', 500).error, '超额度应被拒');
  assert.ok(room.shortSell(pid, 'bank', 0).error, '股数必须为正');

  // 空头计入负债（净资产扣除）
  assert.equal(room._calcAssets(p), room._grossAssets(p) - room.shortValue(p), '空头从净资产扣除');
  assert.equal(room.shortValue(p), price * 5);

  // 价格下跌 → 平仓后净赚价差
  bank.price = Math.round(price * 0.8);
  assert.ok(!room.coverShort(pid, 'bank', 5).error);
  assert.equal(p.shorts.bank, 0, '平仓后空头归零');
  const expectProfit = price * 5 - Math.round(price * 0.8) * 5;   // 开仓所得 − 买回成本
  assert.equal(p.money, 4000 + expectProfit, '下跌时净赚 ' + expectProfit);
  assert.ok(S.log.some(l => l.includes('盈利')), '日志应显示盈利');

  // 价格上涨 → 平仓后净亏
  const tech = S.stocks.find(s => s.id === 'tech');
  const techPrice = tech.price;
  const moneyBefore = p.money;
  assert.ok(!room.shortSell(pid, 'tech', 2).error);
  tech.price = Math.round(techPrice * 1.2);
  assert.ok(!room.coverShort(pid, 'tech', 2).error);
  assert.ok(p.money < moneyBefore, '上涨应净亏: ' + moneyBefore + ' -> ' + p.money);
  assert.ok(S.log.some(l => l.includes('亏损')), '日志应显示亏损');
});

test('融券费与强制平仓：每回合 2% 费用，空头超过现金会被强平', (t2) => {
  const { room, S } = setup(t2);
  const p = S.players[0];
  const pid = p.id;
  S.current = 0; S.phase = 'rolling';
  p.money = 3000;
  const bank = S.stocks.find(s => s.id === 'bank');
  room.shortSell(pid, 'bank', 5);

  // 融券费 = 空头市值 × 2%
  const sv = room.shortValue(p);
  const cashBefore = p.money;
  room.finishTurn();
  const fee = Math.max(1, Math.round(sv * S.shortFeeRate));
  assert.ok(S.log.some(l => l.includes('融券费')), '应记录融券费日志');

  // 强制平仓：把价格推到远超现金，回合结束时保证金不足
  S.current = 0; S.phase = 'rolling';
  p.money = 100;
  p.shorts = { bank: 5 }; p.shortEntry = { bank: 5 * bank.price };
  room.finishTurn();
  assert.equal(p.shorts.bank, 0, '保证金不足应被强制平仓');
  assert.ok(S.log.some(l => l.includes('强制平仓')), '应有强制平仓日志');
});

test('房规：开局随机分地开关', (t2) => {
  const off = setup(t2, { settings: { randomLand: false } });
  assert.equal(Object.keys(off.S.tileOwners).length, 0, '关闭时不分地');

  const on = setup(t2, { settings: { randomLand: true } });
  const assigned = Object.keys(on.S.tileOwners);
  assert.ok(assigned.length > 0, '开启时随机分地');
  const counts = on.S.players.map(p => Object.values(on.S.tileOwners).filter(o => o === p.id).length);
  assert.ok(counts.every(c => c === counts[0]), '每人地数相同: ' + counts.join(','));
});

test('房规：随机地图', (t2) => {
  const { room, S } = setup(t2, { settings: { randomMap: true } });
  assert.ok(['standard', 'classic', 'mini', 'metro', 'space'].includes(S.mapId), '地图应在可选列表内: ' + S.mapId);
  assert.equal(room.map.id, S.mapId, '服务端地图与 state 一致');
  assert.equal(room.map.tiles.length, room.map.size);
});

test('房规：关闭拍卖时破产地产直接回归银行', (t2) => {
  // 默认：走拍卖
  const withAuction = setup(t2, { settings: { auctionOnClose: true } });
  const A = withAuction.S;
  A.tileOwners[1] = A.players[0].id;
  A.players[0].money = -100;
  withAuction.room.bankrupt(A.players[0], null);
  assert.equal(A.phase, 'auction', '默认应进入拍卖阶段');

  // 关闭：不拍卖，地产变无主
  const noAuction = setup(t2, { settings: { auctionOnClose: false } });
  const B = noAuction.S;
  B.tileOwners[1] = B.players[0].id;
  B.players[0].money = -100;
  noAuction.room.bankrupt(B.players[0], null);
  assert.notEqual(B.phase, 'auction', '关闭拍卖时不应进入拍卖阶段');
  assert.equal(B.tileOwners[1], undefined, '地产应回归银行（无主）');
  assert.ok(B.log.some(l => l.includes('关闭拍卖')), '日志应说明房规');
});

test('指数基金：跟随个股表现且波动更平滑', (t2) => {
  const { room, S } = setup(t2);
  const index = S.stocks.find(s => s.id === 'index');
  assert.ok(index, '应存在指数基金');
  assert.equal(index.kind, 'index');
  assert.equal(index.price, index.base, '初始价等于基准价');

  // 把个股整体推到基准的 1.5 倍，指数应跟随上涨但更平滑
  S.stocks.filter(s => s.kind !== 'index').forEach(s => { s.price = Math.round(s.base * 1.5); });
  room._updateStockPrices();
  assert.ok(index.price > index.base, '指数应随个股上涨: ' + index.price);
  assert.ok(index.price <= Math.round(index.base * 1.5), '指数不应超过个股平均涨幅');
  assert.ok(Math.abs(index.price / index.base - 1) <= Math.abs(1.5 - 1) + 0.05, '指数偏离不应大于个股');

  // 个股腰斩，指数跟随下跌
  S.stocks.filter(s => s.kind !== 'index').forEach(s => { s.price = Math.round(s.base * 0.6); });
  room._updateStockPrices();
  assert.ok(index.price < index.base, '指数应随个股下跌: ' + index.price);
});

test('市场事件：股灾全跌、牛市全涨、价格不越界', (t2) => {
  const { room, S } = setup(t2);
  const snapshot = () => S.stocks.map(s => s.price);
  const before = snapshot();

  const crash = room._applyMarketEvent('crash');
  const afterCrash = snapshot();
  assert.equal(crash.kind, 'crash');
  assert.ok(afterCrash.every((v, i) => v < before[i]), '股灾应全市场下跌');
  assert.ok(S.log.some(l => l.includes('股灾')), '应记录日志');

  const beforeBoom = snapshot();
  room._applyMarketEvent('boom');
  const afterBoom = snapshot();
  assert.ok(afterBoom.every((v, i) => v > beforeBoom[i]), '牛市应全市场上涨');
  assert.ok(S.log.some(l => l.includes('牛市')));

  // 连续事件也不会突破价格边界
  for (let i = 0; i < 30; i++) room._applyMarketEvent(i % 2 ? 'boom' : 'crash');
  S.stocks.forEach((s) => {
    assert.ok(s.price >= Math.round(s.base * 0.3) - 1, s.id + ' 下限: ' + s.price);
    assert.ok(s.price <= Math.round(s.base * 2.5) + 1, s.id + ' 上限: ' + s.price);
  });
});

test('存款利息：回合结束按现金 1% 结算', (t) => {
  const { room, S } = setup(t);
  S.current = 0;
  S.players[0].money = 1000;
  room.finishTurn();
  assert.equal(S.players[0].money, 1010);
});

test('移动序号：买股票不会产生新的移动 seq', (t) => {
  const { room, S } = setup(t);
  const pid = S.players[0].id;
  S.current = 0; S.phase = 'rolling';
  room.rollDice(pid);
  const seq = S.lastMove.seq;
  assert.ok(typeof seq === 'number');
  room.buyStock(pid, 'bank', 1);
  assert.equal(S.lastMove.seq, seq, '同回合操作不应改变 seq');
});

test('胜负：仅剩一人时结束；团队模式按队伍判定', (t) => {
  const { room, S } = setup(t);
  S.players[1].bankrupt = true;
  S.players[2].bankrupt = true;
  S.players[3].bankrupt = true;
  room.checkWinner();
  assert.equal(S.phase, 'gameOver');
  assert.equal(S.winner, S.players[0].id);

  const team = setup(t, { settings: { teamMode: true } });
  const T = team.S;
  T.players[1].bankrupt = true;
  T.players[3].bankrupt = true;
  team.room.checkWinner();
  assert.equal(T.winnerTeam, 'A');
  assert.equal(T.phase, 'gameOver');
});

test('银行贷款：额度、借款、利息滚动、还款与净资产', (t2) => {
  const { room, S } = setup(t2);
  const p = S.players[0];
  const pid = p.id;
  S.current = 0; S.phase = 'rolling';

  // 额度 = 总资产 × 30%，上限 2500，按百元取整
  const net = room._calcAssets(p);
  const cap = room.loanCap(p);
  assert.equal(cap, Math.max(0, Math.min(Math.floor((net * 0.3) / 100) * 100, 2500)), '额度按净资产计算');
  assert.ok(cap > 0);

  // 借款到账 + 余额
  const cash0 = p.money;
  assert.ok(!room.takeLoan(pid, 500).error);
  assert.equal(p.loan, 500);
  assert.equal(p.money, cash0 + 500, '借款到账');
  assert.equal(room.loanCap(p), cap, '借款后额度不应变大（按净资产计算）');

  // 低于起借额 / 超过额度被拒
  assert.ok(room.takeLoan(pid, 50).error, '低于 ¥100 应被拒');
  assert.ok(room.takeLoan(pid, cap + 1000).error, '超过额度应被拒');

  // 净资产 = 毛资产 − 贷款
  assert.equal(room._calcAssets(p), room._grossAssets(p) - 500, '贷款从净资产扣除');

  // 每回合利息滚入本金
  p.loan = 1000;
  const before = p.loan;
  room.finishTurn();
  assert.ok(p.loan > before, '贷款利息应滚入本金: ' + before + ' -> ' + p.loan);
  const expected = before + Math.max(1, Math.round(before * S.loanRate));
  assert.equal(p.loan, expected, '利息按 3% 计算');

  // 还款
  S.current = 0; S.phase = 'rolling';
  const owed = p.loan;
  p.money = 5000;
  assert.ok(!room.repayLoan(pid, 300).error);
  assert.equal(p.loan, owed - 300, '还款减少余额');
  assert.equal(p.money, 4700, '还款扣现金');
  assert.ok(!room.repayLoan(pid, 99999).error, '超额还款按余额结清');
  assert.equal(p.loan, 0, '结清');
  assert.ok(room.repayLoan(pid, 100).error, '已结清不能再还');

  // 非自己回合被拒
  S.current = 1;
  assert.ok(room.takeLoan(pid, 500).error, '非自己回合不能贷款');
  S.current = 0;
});

test('资产统计含地产、房屋与股票市值', (t) => {
  const { room, S } = setup(t);
  const p = S.players[0];
  p.money = 1000; p.stocks = { bank: 2 };
  S.tileOwners[1] = p.id;
  S.tileHouses[1] = 2;
  const bank = S.stocks.find(s => s.id === 'bank');
  const expected = 1000 + room.map.tiles[1].price + 2 * getHouseCost('brown') + 2 * bank.price;
  assert.equal(room._calcAssets(p), expected);
});

test('房主权限：踢人（含机器人）、不能踢自己、开局后禁止', (t2) => {
  const room = new GameRoom();
  const sent = [];
  let closed = false;
  const hostWs = { readyState: 1, send() {}, close() {} };
  const guestWs = { readyState: 1, send(m) { sent.push(JSON.parse(m)); }, close() { closed = true; } };
  const host = room.addPlayer(hostWs, '房主', null, null);
  const guest = room.addPlayer(guestWs, '客人', null, null);
  assert.equal(host.player.isHost, true, '第一位应是房主');
  assert.equal(guest.player.isHost, false, '后加入的不能是房主');

  assert.ok(room.kickPlayer(guest.id, host.id).error, '非房主踢人应被拒');
  assert.ok(room.transferHost(guest.id, guest.id).error, '非房主转让应被拒');
  assert.ok(room.kickPlayer(host.id, host.id).error, '房主不能踢自己');

  const r = room.kickPlayer(host.id, guest.id);
  assert.ok(!r.error, r.error);
  assert.equal(room.players.has(guest.id), false, '被踢玩家应移出房间');
  assert.ok(sent.some(m => m.type === 'kicked'), '被踢者应收到 kicked 消息');
  assert.equal(closed, true, '被踢者的连接应被关闭');

  room.addAI(host.id);
  const bot = [...room.players.values()].find(p => p.isAI);
  assert.ok(!room.kickPlayer(host.id, bot.id).error, '应能移除机器人');
  assert.equal([...room.players.values()].filter(p => p.isAI).length, 0);

  const h2 = room.addPlayer({ readyState: 1, send() {}, close() {} }, '甲', null, null);
  const g2 = room.addPlayer({ readyState: 1, send() {}, close() {} }, '乙', null, null);
  room.startGame(h2.id);
  assert.ok(room.kickPlayer(h2.id, g2.id).error, '开局后不能踢人');
  assert.ok(room.transferHost(h2.id, g2.id).error, '开局后不能转让房主');
});

test('房主权限：转让房主与权限交接', (t2) => {
  const room = new GameRoom();
  const host = room.addPlayer({ readyState: 1, send() {}, close() {} }, '房主', null, null);
  const guest = room.addPlayer({ readyState: 1, send() {}, close() {} }, '客人', null, null);
  room.addAI(host.id);
  const bot = [...room.players.values()].find(p => p.isAI);

  assert.ok(room.transferHost(host.id, bot.id).error, '不能转让给机器人');
  assert.ok(room.transferHost(host.id, host.id).error, '不能转让给自己');

  assert.ok(!room.transferHost(host.id, guest.id).error, '应能转让给真人');
  assert.equal(room.players.get(guest.id).isHost, true, '新房主生效');
  assert.equal(room.players.get(host.id).isHost, false, '原房主降为普通玩家');
  assert.ok(!room.updateSettings(guest.id, { startMoney: 3000 }).error, '新房主可改设置');
  assert.ok(room.updateSettings(host.id, { startMoney: 1500 }).error, '原房主不能改设置');
});

test('大厅最后一个真人离开时，机器人与房间一起清空', (t) => {
  const room = new GameRoom();
  const host = room.addPlayer(fakeWs(), '房主', null, null);
  room.addAI(host.id);
  room.addAI(host.id);
  assert.equal(room.players.size, 3);
  room.removePlayer(host.id);
  assert.equal(room.players.size, 0, '机器人应被一起清理');
});

test('大厅还有真人时不清机器人', (t) => {
  const room = new GameRoom();
  const a = room.addPlayer(fakeWs(), '甲', null, null);
  const b = room.addPlayer(fakeWs(), '乙', null, null);
  room.addAI(a.id);
  assert.equal(room.players.size, 3);
  room.removePlayer(a.id);
  assert.equal(room.players.size, 2, '另一名真人还在，机器人与房间保留');
});
