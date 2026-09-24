// ============================================================
// 规则常量与租金计算（服务端权威逻辑使用）
// ============================================================
import { GROUPS, RAILROAD_PRICE, UTILITY_PRICE } from '../js/data/tiles.js';

export const START_MONEY = 2000;
export const PASS_GO_BONUS = 300;
export const JAIL_BAIL = 50;
export const JAIL_TILE_ID = 39;        // 监狱（探监/停留）
export const GOTO_JAIL_TILE_ID = 13;   // 进监狱
export const MAX_PLAYERS = 8;
export const MIN_PLAYERS = 2;
export const DEFAULT_MAX_ROUNDS = 60;

export const RAILROAD_RENT = [25, 50, 100, 200];  // 按持有车站数
export const UTILITY_MULT = [15, 40];              // 持有1个/2个公共事业时乘骰点
export const MAX_HOUSES = 4;                      // 每块地最多 4 房
export const HOTEL_LEVEL = 5;                     // level 5 = 旅馆
export const MORTGAGE_RATE = 0.5;                 // 抵押按半价
export const UNMORTGAGE_INTEREST = 0.1;           // 赎回 +10%

// 快速模式预设：高起点资金、租金加成、回合更少、倒计时更短
export const FAST_MODE = {
  startMoney: 3000,
  maxRounds: 30,
  houseMultiplier: 1.5,
  rentMultiplier: 1.5,
  turnTimeout: 25000,
};

// 银行利息：每回合结束时按现金结算
export const DEFAULT_INTEREST_RATE = 0.01;

// 股票定义（价格由服务端每回合波动）
export const STOCK_DEFS = [
  { id: 'bank',  name: '银行股', base: 120 },
  { id: 'power', name: '能源股', base: 90 },
  { id: 'tech',  name: '科技股', base: 150 },
  { id: 'land',  name: '地产股', base: 100 },
];

// 地产租金：baseRent × (level+1)，垄断（集齐同色组）翻倍
export function calcPropertyRent(tile, level, monopoly) {
  const l = Math.max(0, Math.min(level, HOTEL_LEVEL));
  const rent = tile.rent[l];
  if (monopoly && l === 0) return rent * 2;
  return rent;
}

// 车站租金：按持有车站数量
export function calcRailroadRent(ownedCount) {
  return RAILROAD_RENT[Math.max(0, Math.min(ownedCount - 1, RAILROAD_RENT.length - 1))];
}

// 公共事业租金：骰点 × 倍率（持有数量决定倍率）
export function calcUtilityRent(ownedCount, diceTotal) {
  const idx = ownedCount >= 2 ? 1 : 0;
  return diceTotal * UTILITY_MULT[idx];
}

// 建一栋房的花费（按组）
export function getHouseCost(group) {
  const g = GROUPS[group];
  return g ? g.houseCost : 100;
}

// 地产售价（空地价，用于拍卖起价等）
export function getPropertyPrice(tile) {
  if (tile.type === 'railroad') return RAILROAD_PRICE;
  if (tile.type === 'utility') return UTILITY_PRICE;
  return tile.price || 0;
}

