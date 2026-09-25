import test from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword, sessionCutoff, leaderboardFilters } from '../server/db.js';

test('密码哈希：异步版仍然兼容旧格式，且校验正确', async () => {
  const stored = await hashPassword('secret123');
  assert.match(stored, /^[0-9a-f]{32}:[0-9a-f]{128}$/, 'salt:hash 格式应保持不变');
  assert.equal(await verifyPassword('secret123', stored), true, '正确密码应通过');
  assert.equal(await verifyPassword('wrong', stored), false, '错误密码应失败');
  assert.equal(await verifyPassword('secret123', 'garbage'), false, '畸形存储值不应抛错');
  assert.equal(await verifyPassword('secret123', ''), false);
});

test('密码哈希：同一密码两次加盐结果不同', async () => {
  const a = await hashPassword('same');
  const b = await hashPassword('same');
  assert.notEqual(a, b, '应有随机盐');
  assert.equal(await verifyPassword('same', a), true);
  assert.equal(await verifyPassword('same', b), true);
});

test('会话有效期：cutoff 约为 30 天前', () => {
  const cutoff = Date.parse(sessionCutoff());
  const days = (Date.now() - cutoff) / 86400000;
  assert.ok(days > 29.9 && days < 30.1, '实际 ' + days.toFixed(2) + ' 天');
});

test('排行榜过滤：最少场次 + 隐藏名单', () => {
  delete process.env.LEADERBOARD_MIN_GAMES;
  delete process.env.LEADERBOARD_EXCLUDE;
  assert.equal(leaderboardFilters(), '&games=gt.0', '默认至少 1 场');

  process.env.LEADERBOARD_MIN_GAMES = '3';
  assert.match(leaderboardFilters(), /games=gt\.2/, '最少 3 场 → gt.2');

  process.env.LEADERBOARD_EXCLUDE = 'wa639166, wb639166';
  assert.match(leaderboardFilters(), /users\.username=not\.in\.\("wa639166","wb639166"\)/, '隐藏名单应拼接为 not.in');

  process.env.LEADERBOARD_MIN_GAMES = '0';
  assert.match(leaderboardFilters(), /games=gt\.-1/, '设为 0 时不限场次');

  delete process.env.LEADERBOARD_MIN_GAMES;
  delete process.env.LEADERBOARD_EXCLUDE;
});
