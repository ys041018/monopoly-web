import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calcPropertyRent, calcRailroadRent, calcUtilityRent, getHouseCost, getPropertyPrice,
  FAST_MODE, STOCK_DEFS, DEFAULT_INTEREST_RATE, PASS_GO_BONUS, JAIL_BAIL,
} from '../server/rules.js';

test('地产租金：等级与垄断翻倍', () => {
  const tile = { type: 'property', rent: [10, 50, 150, 450, 625, 750] };
  assert.equal(calcPropertyRent(tile, 0, false), 10);
  assert.equal(calcPropertyRent(tile, 0, true), 20, '垄断空地翻倍');
  assert.equal(calcPropertyRent(tile, 1, true), 50, '有房不翻倍');
  assert.equal(calcPropertyRent(tile, 9, false), 750, '超等级按最高档');
  assert.equal(calcPropertyRent(tile, -1, false), 10, '负等级按空地');
});

test('车站与公用事业租金', () => {
  assert.equal(calcRailroadRent(1), 25);
  assert.equal(calcRailroadRent(4), 200);
  assert.equal(calcRailroadRent(9), 200, '超过 4 个按最高档');
  assert.equal(calcUtilityRent(1, 8), 120);
  assert.equal(calcUtilityRent(2, 8), 320);
});

test('房价与售价', () => {
  assert.equal(getHouseCost('brown'), 50);
  assert.equal(getHouseCost('不存在'), 100, '未知组用兜底价');
  assert.equal(getPropertyPrice({ type: 'railroad' }), 200);
  assert.equal(getPropertyPrice({ type: 'utility' }), 150);
  assert.equal(getPropertyPrice({ type: 'property', price: 400 }), 400);
});

test('基础常量', () => {
  assert.equal(PASS_GO_BONUS, 300);
  assert.equal(JAIL_BAIL, 50);
  assert.equal(DEFAULT_INTEREST_RATE, 0.01);
});

test('快速模式预设：3000 起始 / 60 回合 / 45 秒 / 租金 1.5 倍', () => {
  assert.equal(FAST_MODE.startMoney, 3000);
  assert.equal(FAST_MODE.maxRounds, 60);
  assert.equal(FAST_MODE.turnTimeout, 45000);
  assert.equal(FAST_MODE.rentMultiplier, 1.5);
});

test('股票定义合法', () => {
  assert.ok(STOCK_DEFS.length >= 4);
  const ids = new Set();
  for (const s of STOCK_DEFS) {
    assert.ok(s.id && s.name && s.base > 0);
    assert.ok(!ids.has(s.id), '股票 id 重复: ' + s.id);
    ids.add(s.id);
  }
});
