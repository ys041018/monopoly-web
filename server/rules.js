// ============================================================
// 规则常量与租金计算（服务端权威逻辑使用）
// ============================================================
import { GROUPS, RAILROAD_PRICE, UTILITY_PRICE } from '../js/data/tiles.js';

export const START_MONEY = 1500;
export const PASS_GO_BONUS = 200;
export const JAIL_BAIL = 50;
export const JAIL_TILE_ID = 39;        // 监狱（探监/停留）
export const GOTO_JAIL_TILE_ID = 13;   // 进监狱
export const MAX_PLAYERS = 8;
export const MIN_PLAYERS = 2;
export const DEFAULT_MAX_ROUNDS = 60;

export const RAILROAD_RENT = [25, 50, 100, 200];  // 按持有车站数
export const UTILITY_MULT = [4, 10];              // 持有1个/2个公共事业时乘骰点
export const MAX_HOUSES = 4;                      // 每块地最多 4 房
export const HOTEL_LEVEL = 5;                     // level 5 = 旅馆
export const MORTGAGE_RATE = 0.5;                 // 抵押按半价
export const UNMORTGAGE_INTEREST = 0.1;           // 赎回 +10%

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

