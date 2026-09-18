// ============================================================
// 机会卡 / 命运卡（前后端共用）
// action: gain(得钱) lose(付钱) goto(移动到指定格)
//         gotoRailroad(前进到最近车站) move(前进/后退) jail(进监狱) outOfJail(出狱卡)
// ============================================================

export const CHANCE_CARDS = [
  { id: 'c1', text: '前进到起点，领取 ¥200', action: 'goto', position: 0 },
  { id: 'c2', text: '银行发红利，获得 ¥150', action: 'gain', amount: 150 },
  { id: 'c3', text: '前进到最近的车站', action: 'gotoRailroad' },
  { id: 'c4', text: '后退 3 步', action: 'move', steps: -3 },
  { id: 'c5', text: '超速被罚 ¥50', action: 'lose', amount: 50 },
  { id: 'c6', text: '彩票中奖 ¥100', action: 'gain', amount: 100 },
  { id: 'c7', text: '被送进监狱！', action: 'jail' },
  { id: 'c8', text: '获得出狱卡', action: 'outOfJail' },
  { id: 'c9', text: '缴纳修路费 ¥80', action: 'lose', amount: 80 },
  { id: 'c10', text: '前进 2 步', action: 'move', steps: 2 },
];

export const CHEST_CARDS = [
  { id: 'd1', text: '生日收到礼金 ¥100', action: 'gain', amount: 100 },
  { id: 'd2', text: '医院账单 ¥120', action: 'lose', amount: 120 },
  { id: 'd3', text: '退税获得 ¥80', action: 'gain', amount: 80 },
  { id: 'd4', text: '被送进监狱！', action: 'jail' },
  { id: 'd5', text: '获得出狱卡', action: 'outOfJail' },
  { id: 'd6', text: '获得奖学金 ¥150', action: 'gain', amount: 150 },
  { id: 'd7', text: '缴纳学费 ¥100', action: 'lose', amount: 100 },
  { id: 'd8', text: '前进到免费停车', action: 'goto', position: 26 },
  { id: 'd9', text: '彩票中奖 ¥200', action: 'gain', amount: 200 },
  { id: 'd10', text: '缴纳水电费 ¥60', action: 'lose', amount: 60 },
];
