import test from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword, sessionCutoff } from '../server/db.js';

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
