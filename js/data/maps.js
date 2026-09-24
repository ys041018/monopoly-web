// ============================================================
// 多地图配置
//   standard 标准 52 格 / classic 经典 40 格（手工数据）
//   mini 迷你 32 格 / metro 都市 44 格 / space 星际 48 格（由 makeMap 生成）
// 约定：4 个角固定顺序 = 起点 / 进监狱 / 免费停车 / 监狱，
//       每边 perSide 格，总格数 = 4 * (perSide + 1)
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
// ---------- 生成工具 ----------
// 租金按地价推导：空地约地价 10%，后续档位固定倍率（量级与手工地图一致）
function rentFor(price) {
  const base = Math.max(2, Math.round(price * 0.1));
  return [base, base * 5, base * 15, base * 40, base * 50, base * 60];
}
const P = (name, group, price) => ({ type: 'property', name, group, price, rent: rentFor(price) });
const RR = (name) => ({ type: 'railroad', name, sub: null });
const UT = (name) => ({ type: 'utility', name, sub: null });
const TAX = (name, amount) => ({ type: 'tax', name, sub: 'income', amount });
const EV = (name, sub) => ({ type: 'event', name, sub });
const CHANCE = () => ({ type: 'chance', name: '机会', sub: null });
const CHEST = () => ({ type: 'chest', name: '命运', sub: null });

// 组一张地图：sides 必须是 4 条长度等于 perSide 的边
// 格数写错就直接抛错——宁可启动失败，也不要发出去一张错位棋盘
function makeMap(id, name, perSide, sides, cornerNames) {
  const corners = [
    { type: 'go', name: cornerNames[0] || '起点', sub: null },
    { type: 'gotojail', name: '进监狱', sub: null },
    { type: 'freeparking', name: '免费停车', sub: null },
    { type: 'jail', name: '监狱', sub: null },
  ];
  const tiles = [];
  const put = (t) => tiles.push(Object.assign({ id: tiles.length }, t));
  put(corners[0]);
  for (let i = 0; i < 4; i++) {
    if (sides[i].length !== perSide) {
      throw new Error('地图 ' + id + ' 第 ' + (i + 1) + ' 边应为 ' + perSide + ' 格，实际 ' + sides[i].length);
    }
    sides[i].forEach(put);
    if (i < 3) put(corners[i + 1]);
  }
  return {
    id, name, perSide, size: tiles.length, tiles, groups: GROUPS,
    jailId: 3 * (perSide + 1),
    gotoJailId: 1 * (perSide + 1),
  };
}

// ---------- 迷你 32 格：7 组 × 2 块地，节奏快，适合 2~4 人 ----------
const MINI = makeMap('mini', '迷你 32 格', 7, [
  [P('咖啡馆', 'brown', 60), CHEST(), P('面包店', 'brown', 60), RR('小镇车站'), P('花店', 'lightblue', 100), CHANCE(), P('书店', 'lightblue', 100)],
  [P('唱片行', 'pink', 140), TAX('营业税', 100), P('电影院', 'pink', 140), UT('自来水厂'), P('餐厅', 'orange', 180), CHANCE(), P('甜品店', 'orange', 180)],
  [P('服装店', 'red', 220), CHANCE(), P('珠宝店', 'red', 220), RR('东站'), P('学校', 'yellow', 260), CHEST(), P('医院', 'yellow', 260)],
  [RR('北站'), P('公园', 'green', 300), CHEST(), P('广场', 'green', 300), EV('彩票', 'lottery'), TAX('所得税', 150), CHANCE()],
], ['起点']);

// ---------- 都市 44 格：8 组，地产更贵，特殊格更多 ----------
const METRO = makeMap('metro', '都市 44 格', 10, [
  [P('老街', 'brown', 60), CHEST(), P('集市', 'brown', 60), TAX('所得税', 200), P('地铁口', 'brown', 80), RR('中央车站'), P('步行街', 'lightblue', 100), CHANCE(), P('书城', 'lightblue', 100), P('美术馆', 'lightblue', 120)],
  [P('奶茶街', 'pink', 140), UT('电力公司'), P('夜市', 'pink', 140), CHANCE(), P('电影院', 'pink', 160), RR('南站'), P('美食城', 'orange', 180), CHEST(), P('体育馆', 'orange', 180), P('音乐厅', 'orange', 200)],
  [P('金融街', 'red', 220), EV('彩票', 'lottery'), P('写字楼', 'red', 220), CHANCE(), P('购物中心', 'red', 240), UT('水务公司'), P('酒店', 'yellow', 260), CHEST(), P('度假村', 'yellow', 260), P('游乐园', 'yellow', 280)],
  [RR('西站'), P('科技园', 'green', 300), TAX('奢侈税', 100), P('大学城', 'green', 300), CHANCE(), P('金融塔', 'green', 320), EV('节日庆典', 'festival'), RR('北站'), P('云端大厦', 'blue', 350), P('天空之城', 'blue', 400)],
], ['起点']);

// ---------- 星际 48 格：目前最大的图，9 个色组，车站=跳跃门 ----------
const SPACE = makeMap('space', '星际 48 格', 11, [
  [P('月球基地', 'brown', 80), CHANCE(), P('环形山矿场', 'brown', 80), RR('跳跃门 α'), P('火星港口', 'lightblue', 120), CHEST(), P('水冰矿', 'lightblue', 120), TAX('补给费', 150), P('小行星带', 'lightblue', 140), EV('传送', 'teleport'), P('木星哨站', 'pink', 160)],
  [P('土星环城', 'pink', 160), UT('太阳能站'), P('泰坦基地', 'pink', 180), CHANCE(), P('天王星冰城', 'orange', 200), RR('跳跃门 β'), P('海王星站', 'orange', 200), CHEST(), P('柯伊伯带', 'orange', 220), EV('彩票', 'lottery'), P('深空观测站', 'red', 240)],
  [P('银河港口', 'red', 240), CHANCE(), P('星云矿脉', 'red', 260), UT('反物质站'), P('黑洞观测塔', 'yellow', 280), RR('跳跃门 γ'), P('虫洞枢纽', 'yellow', 280), CHEST(), P('超新星城', 'yellow', 300), EV('节日庆典', 'festival'), P('机器人城', 'green', 320)],
  [P('量子塔', 'green', 320), P('空间站环', 'green', 340), RR('跳跃门 δ'), P('星际议会', 'blue', 360), TAX('关税', 200), P('曲速引擎厂', 'blue', 380), CHEST(), P('银河皇宫', 'purple', 400), P('星海圣殿', 'purple', 450), CHANCE(), EV('奖金', 'bonus')],
], ['地球起点']);

export const MAPS = {
  standard: { id: 'standard', name: '标准 52 格', size: SIZE52, perSide: 12, tiles: TILES52, groups: GROUPS, jailId: 39, gotoJailId: 13 },
  classic:  { id: 'classic',  name: '经典 40 格', size: 40,    perSide: 9,  tiles: TILES40,  groups: GROUPS, jailId: 10, gotoJailId: 30 },
  mini:     Object.assign({}, MINI,  { name: '迷你 32 格' }),
  metro:    Object.assign({}, METRO, { name: '都市 44 格' }),
  space:    Object.assign({}, SPACE, { name: '星际 48 格' }),
};

export const MAP_LIST = ['standard', 'classic', 'mini', 'metro', 'space'];

export function getMap(id) { return MAPS[id] || MAPS.standard; }
