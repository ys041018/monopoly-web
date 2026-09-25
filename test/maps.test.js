import test from 'node:test';
import assert from 'node:assert/strict';
import { MAP_LIST, getMap } from '../js/data/maps.js';
import { GROUPS } from '../js/data/tiles.js';

test('每张地图结构自洽（格数/角位/监狱位）', () => {
  for (const id of MAP_LIST) {
    const m = getMap(id);
    const n = m.perSide;
    assert.equal(m.size, 4 * (n + 1), id + ' 格数');
    assert.equal(m.tiles.length, m.size, id + ' tiles 长度');
    assert.deepEqual(m.tiles.map(t => t.id), [...Array(m.size).keys()], id + ' id 连续');
    assert.equal(m.tiles[0].type, 'go', id + ' 起点');
    assert.equal(m.tiles[2 * n + 2].type, 'freeparking', id + ' 免费停车');
    assert.equal(m.tiles[m.jailId].type, 'jail', id + ' jailId 指向监狱');
    assert.equal(m.tiles[m.gotoJailId].type, 'gotojail', id + ' gotoJailId 指向进监狱');
  }
});

test('地产数据完整，且每个色组至少 2 块（不会一块地就垄断）', () => {
  for (const id of MAP_LIST) {
    const m = getMap(id);
    const props = m.tiles.filter(t => t.type === 'property');
    assert.ok(props.length >= 10, id + ' 地产数量 ' + props.length);
    const byGroup = {};
    for (const t of props) {
      assert.ok(GROUPS[t.group], id + ' 未定义色组 ' + t.group);
      assert.ok(t.price > 0, id + ' ' + t.name + ' 价格');
      assert.equal(t.rent.length, 6, id + ' ' + t.name + ' 租金档位');
      assert.ok(t.rent.every((r, i) => i === 0 || r > t.rent[i - 1]), id + ' ' + t.name + ' 租金递增');
      byGroup[t.group] = (byGroup[t.group] || 0) + 1;
    }
    for (const [g, c] of Object.entries(byGroup)) {
      assert.ok(c >= 2, id + ' 色组 ' + g + ' 只有 ' + c + ' 块');
    }
  }
});

test('未知地图回退标准图', () => {
  assert.equal(getMap('no-such-map').id, 'standard');
  assert.equal(getMap(undefined).id, 'standard');
});
