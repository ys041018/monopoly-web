// ============================================================
// 52 格棋盘数据（正方形：每边 12 格，适配 8 人局）
// 格号 0~51，顺时针，0 为起点
// 地产 rent 为 6 档租金：[空地, 1房, 2房, 3房, 4房, 旅馆]
// ============================================================

export const BOARD_SIZE = 52;

// 10 个地产颜色组
export const GROUPS = {
  brown:     { name: '棕色', color: '#8D6E63', houseCost: 50  },
  lightblue: { name: '浅蓝', color: '#4FC3F7', houseCost: 50  },
  pink:      { name: '粉色', color: '#F06292', houseCost: 100 },
  orange:    { name: '橙色', color: '#FF9800', houseCost: 100 },
  red:       { name: '红色', color: '#EF5350', houseCost: 150 },
  yellow:    { name: '黄色', color: '#FDD835', houseCost: 150 },
  cyan:      { name: '青色', color: '#26C6DA', houseCost: 200 },
  green:     { name: '绿色', color: '#66BB6A', houseCost: 200 },
  blue:      { name: '深蓝', color: '#1E5AA8', houseCost: 200 },
  purple:    { name: '紫色', color: '#7E57C2', houseCost: 200 },
};

export const RAILROAD_PRICE = 200;
export const UTILITY_PRICE = 150;

export const TILES = [
  { id: 0,  type: 'go',          name: '起点',     sub: null },
  // 底边（1-12）
  { id: 1,  type: 'property',    name: '海滨路',   group: 'brown',     price: 60,  rent: [2, 10, 30, 90, 160, 250] },
  { id: 2,  type: 'chance',      name: '机会',     sub: null },
  { id: 3,  type: 'property',    name: '老街',     group: 'brown',     price: 60,  rent: [4, 20, 60, 180, 320, 450] },
  { id: 4,  type: 'tax',         name: '所得税',   sub: 'income', amount: 200 },
  { id: 5,  type: 'railroad',    name: '中央车站', sub: null },
  { id: 6,  type: 'event',       name: '彩票',     sub: 'lottery' },
  { id: 7,  type: 'property',    name: '湖畔道',   group: 'lightblue', price: 100, rent: [6, 30, 90, 270, 400, 550] },
  { id: 8,  type: 'chest',       name: '命运',     sub: null },
  { id: 9,  type: 'property',    name: '林荫街',   group: 'lightblue', price: 100, rent: [6, 30, 90, 270, 400, 550] },
  { id: 10, type: 'property',    name: '樱花街',   group: 'pink',      price: 140, rent: [10, 50, 150, 450, 625, 750] },
  { id: 11, type: 'property',    name: '清风路',   group: 'lightblue', price: 120, rent: [8, 40, 100, 300, 450, 600] },
  { id: 12, type: 'utility',     name: '电力公司', sub: null },
  { id: 13, type: 'gotojail',    name: '进监狱',   sub: null },
  // 左边（14-25）
  { id: 14, type: 'property',    name: '梧桐路',   group: 'pink',      price: 140, rent: [10, 50, 150, 450, 625, 750] },
  { id: 15, type: 'chest',       name: '命运',     sub: null },
  { id: 16, type: 'property',    name: '玫瑰巷',   group: 'pink',      price: 160, rent: [12, 60, 180, 500, 700, 900] },
  { id: 17, type: 'railroad',    name: '南站',     sub: null },
  { id: 18, type: 'event',       name: '奖金',     sub: 'bonus' },
  { id: 19, type: 'property',    name: '阳光大道', group: 'orange',    price: 180, rent: [14, 70, 200, 550, 750, 950] },
  { id: 20, type: 'chance',      name: '机会',     sub: null },
  { id: 21, type: 'property',    name: '金穗街',   group: 'orange',    price: 180, rent: [14, 70, 200, 550, 750, 950] },
  { id: 22, type: 'event',       name: '商店',     sub: 'shop' },
  { id: 23, type: 'property',    name: '丰收路',   group: 'orange',    price: 200, rent: [16, 80, 220, 600, 800, 1000] },
  { id: 24, type: 'property',    name: '红枫街',   group: 'red',       price: 220, rent: [18, 90, 250, 700, 875, 1050] },
  { id: 25, type: 'property',    name: '朱雀路',   group: 'red',       price: 220, rent: [18, 90, 250, 700, 875, 1050] },
  { id: 26, type: 'freeparking', name: '免费停车', sub: null },
  // 顶边（27-38）
  { id: 27, type: 'property',    name: '丹霞道',   group: 'red',       price: 240, rent: [20, 100, 300, 750, 925, 1100] },
  { id: 28, type: 'chance',      name: '机会',     sub: null },
  { id: 29, type: 'property',    name: '金龙街',   group: 'yellow',    price: 260, rent: [22, 110, 330, 800, 975, 1150] },
  { id: 30, type: 'event',       name: '银行',     sub: 'bank' },
  { id: 31, type: 'property',    name: '锦鲤路',   group: 'yellow',    price: 260, rent: [22, 110, 330, 800, 975, 1150] },
  { id: 32, type: 'railroad',    name: '西站',     sub: null },
  { id: 33, type: 'property',    name: '琥珀巷',   group: 'yellow',    price: 280, rent: [24, 120, 360, 850, 1025, 1200] },
  { id: 34, type: 'event',       name: '节日',     sub: 'festival' },
  { id: 35, type: 'property',    name: '碧空街',   group: 'cyan',      price: 300, rent: [26, 130, 390, 900, 1100, 1275] },
  { id: 36, type: 'property',    name: '沧海路',   group: 'cyan',      price: 300, rent: [26, 130, 390, 900, 1100, 1275] },
  { id: 37, type: 'property',    name: '星湖巷',   group: 'cyan',      price: 320, rent: [28, 150, 450, 1000, 1200, 1400] },
  { id: 38, type: 'utility',     name: '水务公司', sub: null },
  { id: 39, type: 'jail',        name: '监狱',     sub: null },
  // 右边（40-51）
  { id: 40, type: 'property',    name: '翡翠街',   group: 'green',     price: 340, rent: [30, 160, 480, 1050, 1300, 1500] },
  { id: 41, type: 'chest',       name: '命运',     sub: null },
  { id: 42, type: 'property',    name: '碧波路',   group: 'green',     price: 340, rent: [30, 160, 480, 1050, 1300, 1500] },
  { id: 43, type: 'property',    name: '青松巷',   group: 'green',     price: 360, rent: [32, 180, 520, 1150, 1400, 1600] },
  { id: 44, type: 'railroad',    name: '北站',     sub: null },
  { id: 45, type: 'property',    name: '天玺大道', group: 'blue',      price: 380, rent: [35, 200, 600, 1300, 1500, 1700] },
  { id: 46, type: 'event',       name: '传送',     sub: 'teleport' },
  { id: 47, type: 'property',    name: '帝王路',   group: 'blue',      price: 400, rent: [50, 200, 600, 1400, 1700, 2000] },
  { id: 48, type: 'tax',         name: '奢侈税',   sub: 'luxury', amount: 100 },
  { id: 49, type: 'property',    name: '紫檀街',   group: 'purple',    price: 460, rent: [60, 240, 700, 1600, 1900, 2200] },
  { id: 50, type: 'property',    name: '紫云路',   group: 'purple',    price: 480, rent: [65, 260, 750, 1700, 2000, 2300] },
  { id: 51, type: 'property',    name: '紫霞巷',   group: 'purple',    price: 500, rent: [70, 280, 800, 1800, 2100, 2400] },
];
