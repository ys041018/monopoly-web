// ============================================================
// 多地图配置：标准 52 格 / 经典 40 格
// ============================================================
import { TILES as TILES52, GROUPS, BOARD_SIZE as SIZE52 } from './tiles.js';

// 经典 40 格（4 角落 + 每边 9 格，顺时针，0 为起点）
export const TILES40 = [
  { id: 0,  type: 'go',          name: '起点',         sub: null },
  { id: 1,  type: 'property',    name: '地中海大道',   group: 'brown',     price: 60,  rent: [2, 10, 30, 90, 160, 250] },
  { id: 2,  type: 'chest',       name: '命运',         sub: null },
  { id: 3,  type: 'property',    name: '波罗的海大道', group: 'brown',     price: 60,  rent: [4, 20, 60, 180, 320, 450] },
  { id: 4,  type: 'tax',         name: '所得税',       sub: 'income', amount: 200 },
  { id: 5,  type: 'railroad',    name: '中央车站',     sub: null },
  { id: 6,  type: 'property',    name: '东方大道',     group: 'lightblue', price: 100, rent: [6, 30, 90, 270, 400, 550] },
  { id: 7,  type: 'chance',      name: '机会',         sub: null },
  { id: 8,  type: 'property',    name: '佛蒙特大道',   group: 'lightblue', price: 100, rent: [6, 30, 90, 270, 400, 550] },
  { id: 9,  type: 'property',    name: '康涅狄格大道', group: 'lightblue', price: 120, rent: [8, 40, 100, 300, 450, 600] },
  { id: 10, type: 'jail',        name: '监狱',         sub: null },
  { id: 11, type: 'property',    name: '圣查尔斯街',   group: 'pink',      price: 140, rent: [10, 50, 150, 450, 625, 750] },
  { id: 12, type: 'utility',     name: '电力公司',     sub: null },
  { id: 13, type: 'property',    name: '州街',         group: 'pink',      price: 140, rent: [10, 50, 150, 450, 625, 750] },
  { id: 14, type: 'property',    name: '弗吉尼亚街',   group: 'pink',      price: 160, rent: [12, 60, 180, 500, 700, 900] },
  { id: 15, type: 'railroad',    name: '南站',         sub: null },
  { id: 16, type: 'property',    name: '圣詹姆斯街',   group: 'orange',    price: 180, rent: [14, 70, 200, 550, 750, 950] },
  { id: 17, type: 'chest',       name: '命运',         sub: null },
  { id: 18, type: 'property',    name: '田纳西街',     group: 'orange',    price: 180, rent: [14, 70, 200, 550, 750, 950] },
  { id: 19, type: 'property',    name: '纽约大道',     group: 'orange',    price: 200, rent: [16, 80, 220, 600, 800, 1000] },
  { id: 20, type: 'freeparking', name: '免费停车',     sub: null },
  { id: 21, type: 'property',    name: '肯塔基街',     group: 'red',       price: 220, rent: [18, 90, 250, 700, 875, 1050] },
  { id: 22, type: 'chance',      name: '机会',         sub: null },
  { id: 23, type: 'property',    name: '印第安纳街',   group: 'red',       price: 220, rent: [18, 90, 250, 700, 875, 1050] },
  { id: 24, type: 'property',    name: '伊利诺伊街',   group: 'red',       price: 240, rent: [20, 100, 300, 750, 925, 1100] },
  { id: 25, type: 'railroad',    name: '西站',         sub: null },
  { id: 26, type: 'property',    name: '大西洋街',     group: 'yellow',    price: 260, rent: [22, 110, 330, 800, 975, 1150] },
  { id: 27, type: 'property',    name: '文特诺街',     group: 'yellow',    price: 260, rent: [22, 110, 330, 800, 975, 1150] },
  { id: 28, type: 'utility',     name: '水务公司',     sub: null },
  { id: 29, type: 'property',    name: '马文花园',     group: 'yellow',    price: 280, rent: [24, 120, 360, 850, 1025, 1200] },
  { id: 30, type: 'gotojail',    name: '进监狱',       sub: null },
  { id: 31, type: 'property',    name: '太平洋街',     group: 'green',     price: 300, rent: [26, 130, 390, 900, 1100, 1275] },
  { id: 32, type: 'property',    name: '北卡罗来纳街', group: 'green',     price: 300, rent: [26, 130, 390, 900, 1100, 1275] },
  { id: 33, type: 'chest',       name: '命运',         sub: null },
  { id: 34, type: 'property',    name: '宾夕法尼亚大道', group: 'green',   price: 320, rent: [28, 150, 450, 1000, 1200, 1400] },
  { id: 35, type: 'railroad',    name: '北站',         sub: null },
  { id: 36, type: 'chance',      name: '机会',         sub: null },
  { id: 37, type: 'property',    name: '公园广场',     group: 'blue',      price: 350, rent: [35, 175, 500, 1100, 1300, 1500] },
  { id: 38, type: 'tax',         name: '奢侈税',       sub: 'luxury', amount: 100 },
  { id: 39, type: 'property',    name: '木板路',       group: 'blue',      price: 400, rent: [50, 200, 600, 1400, 1700, 2000] },
];

export const MAPS = {
  standard: { id: 'standard', name: '标准 52 格', size: SIZE52, perSide: 12, tiles: TILES52, groups: GROUPS, jailId: 39, gotoJailId: 13 },
  classic:  { id: 'classic',  name: '经典 40 格', size: 40,    perSide: 9,  tiles: TILES40,  groups: GROUPS, jailId: 10, gotoJailId: 30 },
};

export function getMap(id) { return MAPS[id] || MAPS.standard; }