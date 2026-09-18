// ============================================================
// 52 格棋盘数据（前后端共用）
// 格号 0~51，顺时针，0 为起点
// ============================================================

export const BOARD_SIZE = 52;

// 8 个地产颜色组
export const GROUPS = {
  brown:     { name: '棕色', color: '#8D6E63', houseCost: 50  },
  lightblue: { name: '浅蓝', color: '#4FC3F7', houseCost: 50  },
  pink:      { name: '粉色', color: '#F06292', houseCost: 100 },
  orange:    { name: '橙色', color: '#FF9800', houseCost: 100 },
  red:       { name: '红色', color: '#EF5350', houseCost: 150 },
  yellow:    { name: '黄色', color: '#FDD835', houseCost: 150 },
  green:     { name: '绿色', color: '#66BB6A', houseCost: 200 },
  blue:      { name: '深蓝', color: '#1E5AA8', houseCost: 200 },
};

export const RAILROAD_PRICE = 200;
export const UTILITY_PRICE = 150;

// 52 个格子
export const TILES = [
  { id: 0,  type: 'go',          name: '起点',     sub: null },
  { id: 1,  type: 'property',    name: '海滨路',   group: 'brown',     price: 60,  baseRent: 6  },
  { id: 2,  type: 'chance',      name: '机会',     sub: null },
  { id: 3,  type: 'property',    name: '老街',     group: 'brown',     price: 60,  baseRent: 6  },
  { id: 4,  type: 'tax',         name: '所得税',   sub: 'income', amount: 200 },
  { id: 5,  type: 'railroad',    name: '中央车站', sub: null },
  { id: 6,  type: 'event',       name: '彩票',     sub: 'lottery' },
  { id: 7,  type: 'property',    name: '湖畔道',   group: 'lightblue', price: 100, baseRent: 10 },
  { id: 8,  type: 'chest',       name: '命运',     sub: null },
  { id: 9,  type: 'property',    name: '林荫街',   group: 'lightblue', price: 100, baseRent: 10 },
  { id: 10, type: 'event',       name: '传送',     sub: 'teleport' },
  { id: 11, type: 'property',    name: '清风路',   group: 'lightblue', price: 120, baseRent: 12 },
  { id: 12, type: 'utility',     name: '电力公司', sub: null },
  { id: 13, type: 'gotojail',    name: '进监狱',   sub: null },
  { id: 14, type: 'property',    name: '樱花街',   group: 'pink',      price: 140, baseRent: 14 },
  { id: 15, type: 'event',       name: '节日',     sub: 'festival' },
  { id: 16, type: 'property',    name: '梧桐路',   group: 'pink',      price: 140, baseRent: 14 },
  { id: 17, type: 'chest',       name: '命运',     sub: null },
  { id: 18, type: 'property',    name: '玫瑰巷',   group: 'pink',      price: 160, baseRent: 16 },
  { id: 19, type: 'railroad',    name: '南站',     sub: null },
  { id: 20, type: 'event',       name: '奖金',     sub: 'bonus' },
  { id: 21, type: 'property',    name: '阳光大道', group: 'orange',    price: 180, baseRent: 18 },
  { id: 22, type: 'chance',      name: '机会',     sub: null },
  { id: 23, type: 'property',    name: '金穗街',   group: 'orange',    price: 180, baseRent: 18 },
  { id: 24, type: 'event',       name: '商店',     sub: 'shop' },
  { id: 25, type: 'property',    name: '丰收路',   group: 'orange',    price: 200, baseRent: 20 },
  { id: 26, type: 'freeparking', name: '免费停车', sub: null },
  { id: 27, type: 'property',    name: '红枫街',   group: 'red',       price: 220, baseRent: 22 },
  { id: 28, type: 'event',       name: '再来一次', sub: 'again' },
  { id: 29, type: 'property',    name: '朱雀路',   group: 'red',       price: 220, baseRent: 22 },
  { id: 30, type: 'utility',     name: '水务公司', sub: null },
  { id: 31, type: 'property',    name: '丹霞道',   group: 'red',       price: 240, baseRent: 24 },
  { id: 32, type: 'railroad',    name: '西站',     sub: null },
  { id: 33, type: 'chance',      name: '机会',     sub: null },
  { id: 34, type: 'property',    name: '金龙街',   group: 'yellow',    price: 260, baseRent: 26 },
  { id: 35, type: 'event',       name: '罚款',     sub: 'fine' },
  { id: 36, type: 'property',    name: '锦鲤路',   group: 'yellow',    price: 260, baseRent: 26 },
  { id: 37, type: 'chest',       name: '命运',     sub: null },
  { id: 38, type: 'property',    name: '琥珀巷',   group: 'yellow',    price: 280, baseRent: 28 },
  { id: 39, type: 'jail',        name: '监狱',     sub: null },
  { id: 40, type: 'property',    name: '翡翠街',   group: 'green',     price: 300, baseRent: 30 },
  { id: 41, type: 'event',       name: '前进',     sub: 'advance' },
  { id: 42, type: 'property',    name: '碧波路',   group: 'green',     price: 300, baseRent: 30 },
  { id: 43, type: 'event',       name: '拍卖行',   sub: 'auction' },
  { id: 44, type: 'property',    name: '青松巷',   group: 'green',     price: 320, baseRent: 32 },
  { id: 45, type: 'railroad',    name: '北站',     sub: null },
  { id: 46, type: 'event',       name: '休息',     sub: 'rest' },
  { id: 47, type: 'property',    name: '天玺大道', group: 'blue',      price: 350, baseRent: 35 },
  { id: 48, type: 'tax',         name: '奢侈税',   sub: 'luxury', amount: 100 },
  { id: 49, type: 'event',       name: '银行',     sub: 'bank' },
  { id: 50, type: 'property',    name: '帝王路',   group: 'blue',      price: 400, baseRent: 40 },
  { id: 51, type: 'event',       name: '后退',     sub: 'backward' },
];
