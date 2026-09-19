// ============================================================
// 单房间游戏逻辑（服务端权威）
// 掷骰、移动、买地、收租、缴税、回合流转
// ============================================================
import {
  START_MONEY, MAX_PLAYERS, MIN_PLAYERS, PASS_GO_BONUS,
  JAIL_TILE_ID, GOTO_JAIL_TILE_ID,
  calcPropertyRent, calcRailroadRent, calcUtilityRent, getPropertyPrice, getHouseCost, HOTEL_LEVEL, DEFAULT_MAX_ROUNDS,
} from './rules.js';
import { TILES, BOARD_SIZE } from '../js/data/tiles.js';
import { CHANCE_CARDS, CHEST_CARDS } from '../js/data/cards.js';

const PLAYER_COLORS = ['#EF5350', '#FF9800', '#FDD835', '#66BB6A', '#4FC3F7', '#AB47BC', '#26C6DA', '#EC407A'];

function uid() { return Math.random().toString(36).slice(2, 10); }

export class GameRoom {
  constructor() {
    this.players = new Map();
    this.spectators = new Map();
    this.started = false;
    this.state = null;
    this._auctionTimer = null;
  }

  addPlayer(ws, name, playerId) {
    // 重连：大厅或游戏中，只要 playerId 匹配现有玩家，恢复其连接
    if (playerId && this.players.has(playerId)) {
      const p = this.players.get(playerId);
      if (p._discTimer) { clearTimeout(p._discTimer); p._discTimer = null; }
      p.ws = ws;
      this.broadcastPlayerList();
      return { id: playerId, player: { id: p.id, name: p.name, color: p.color, isHost: p.isHost } };
    }
    if (this.started) {
      const id = uid();
      this.spectators.set(id, ws);
      return { id, spectator: true };
    }
    if (this.players.size >= MAX_PLAYERS) return { error: '房间已满（最多8人）' };

    const cleanName = String(name || '').trim() || ('玩家' + (this.players.size + 1));
    const used = new Set([...this.players.values()].map(p => p.color));
    const color = PLAYER_COLORS.find(c => !used.has(c)) || PLAYER_COLORS[0];

    const id = uid();
    const player = { ws, id, name: cleanName, color, isHost: this.players.size === 0 };
    this.players.set(id, player);
    this.broadcastPlayerList();
    return { id, player: { id, name: cleanName, color, isHost: player.isHost } };
  }

  removePlayer(playerId) {
    const player = this.players.get(playerId);
    if (!player) return;
    player.ws = null;
    if (!this.started || !this.state) { this._deletePlayer(playerId); return; }
    if (player._discTimer) clearTimeout(player._discTimer);
    player._discTimer = setTimeout(() => { player._discTimer = null; this._deletePlayer(playerId); }, 60000);
    this.broadcastPlayerList();
  }

  _deletePlayer(playerId) {
    const player = this.players.get(playerId);
    if (!player) return;
    this.players.delete(playerId);

    if (this.started && this.state) {
      const online = [...this.players.values()].filter(p => p.ws && p.ws.readyState === 1).length;
      if (online < MIN_PLAYERS) {
        console.log('[自动结束] 在线人数不足，游戏回到大厅');
        this.resetToLobby();
        return;
      }
    }

    if (player.isHost && this.players.size > 0) {
      this.players.values().next().value.isHost = true;
    }
    this.broadcastPlayerList();
  }

  removeSpectator(id) { this.spectators.delete(id); }

  startGame(playerId) {
    const host = this.players.get(playerId);
    if (!host || !host.isHost) return { error: '只有房主可以开始游戏' };
    if (this.players.size < MIN_PLAYERS) return { error: '至少需要 2 名玩家' };
    if (this.started) return { error: '游戏已经开始' };

    this.started = true;
    const players = [...this.players.values()].map(p => ({
      id: p.id, name: p.name, color: p.color, isHost: p.isHost,
      position: 0, money: START_MONEY, inJail: false, jailedTurns: 0, outOfJailCards: 0, rest: false, bankrupt: false,
    }));

    this.state = {
      phase: 'rolling',
      players,
      current: 0,
      round: 1,
      dice: null,
      tileOwners: {},   // tileId -> playerId
      tileHouses: {},   // tileId -> level
      tileMortgaged: {}, // tileId -> true
      pendingTrade: null,
      auction: null,
      lastCard: null,
      pendingTile: null,
      lastMove: null,
      log: ['游戏开始！'],
    };

    this.broadcastState();
    return { ok: true };
  }

  // 当前玩家掷骰
  rollDice(playerId) {
    if (!this.state) return { error: '游戏未开始' };
    const ps = this.state.players;
    const cur = ps[this.state.current];
    if (cur.id !== playerId) return { error: '还没轮到你' };
    if (this.state.phase !== 'rolling') return { error: '当前阶段不能掷骰' };

    // 在狱中：自动跳过（简化）
    if (cur.inJail) {
      cur.jailedTurns = 0;
      cur.inJail = false;
      this.addLog(cur.name + ' 出狱');
      this.finishTurn();
      this.broadcastState();
      return { ok: true };
    }

    const d1 = 1 + Math.floor(Math.random() * 6);
    const d2 = 1 + Math.floor(Math.random() * 6);
    const steps = d1 + d2;
    const from = cur.position;
    let to = from + steps;
    let passedGo = false;
    if (to >= BOARD_SIZE) {
      to = to % BOARD_SIZE;
      passedGo = true;
      cur.money += PASS_GO_BONUS;
    }
    cur.position = to;

    const tile = TILES[to];
    let logMsg = cur.name + ' 掷出 ' + d1 + '+' + d2 + '，走到「' + tile.name + '」';
    if (passedGo) logMsg += '，经过起点 +¥' + PASS_GO_BONUS;

    let phase = 'after_move';
    let pendingTile = null;

    if (tile.type === 'property' || tile.type === 'railroad' || tile.type === 'utility') {
      const ownerId = this.state.tileOwners[to];
      if (!ownerId) {
        phase = 'buying';
        pendingTile = to;
        logMsg += '（无主，可购买 ¥' + getPropertyPrice(tile) + '）';
      } else if (ownerId !== cur.id) {
        const rent = this.calcRent(to, ownerId, steps);
        cur.money -= rent;
        const owner = ps.find(p => p.id === ownerId);
        if (owner) owner.money += rent;
        logMsg += '，支付租金 ¥' + rent + ' 给 ' + (owner ? owner.name : '?');
      } else {
        logMsg += '（自己的地产）';
      }
    } else if (tile.type === 'tax') {
      cur.money -= tile.amount;
      logMsg += '，缴税 ¥' + tile.amount;
    } else if (tile.type === 'gotojail') {
      cur.position = JAIL_TILE_ID;
      cur.inJail = true;
      cur.jailedTurns = 1;
      logMsg += '，被送进监狱！';
    } else if (tile.type === 'chance' || tile.type === 'chest') {
      const deck = tile.type === 'chance' ? CHANCE_CARDS : CHEST_CARDS;
      const card = deck[Math.floor(Math.random() * deck.length)];
      logMsg += '，抽到【' + card.text + '】';
      this.applyCard(cur, ps, card);
      this.state.lastCard = { type: tile.type, text: card.text };
    } else if (tile.type === 'event') {
      const r = this.applyEvent(cur, ps, tile);
      logMsg += '，' + r.text;
      if (r.again) phase = 'rolling';
    }

    this.state.dice = [d1, d2];
    this.state.lastMove = { playerIndex: this.state.current, from, to: cur.position, dice: [d1, d2] };
    this.addLog(logMsg);

    if (cur.money < 0) {
      this.bankrupt(cur);
      if (this.state.phase !== 'gameOver') this.finishTurn();
    } else {
      this.state.phase = phase;
      this.state.pendingTile = pendingTile;
    }

    this.broadcastState();
    return { ok: true };
  }

  // 购买当前地产
  buyProperty(playerId) {
    if (!this.state) return { error: '游戏未开始' };
    const cur = this.state.players[this.state.current];
    if (cur.id !== playerId) return { error: '还没轮到你' };
    if (this.state.phase !== 'buying' || this.state.pendingTile == null) return { error: '当前不能购买' };

    const tileId = this.state.pendingTile;
    const tile = TILES[tileId];
    const price = getPropertyPrice(tile);
    if (cur.money < price) return { error: '现金不足，无法购买' };

    cur.money -= price;
    this.state.tileOwners[tileId] = cur.id;
    this.state.tileHouses[tileId] = 0;
    this.addLog(cur.name + ' 购买了「' + tile.name + '」¥' + price);
    this.finishTurn();
    this.broadcastState();
    return { ok: true };
  }

  // 放弃购买 -> 进入公开拍卖
  skipBuy(playerId) {
    if (!this.state) return { error: '游戏未开始' };
    const cur = this.state.players[this.state.current];
    if (cur.id !== playerId) return { error: '还没轮到你' };
    if (this.state.phase !== 'buying' || this.state.pendingTile == null) return { error: '当前不能跳过' };
    const tileId = this.state.pendingTile;
    const tile = TILES[tileId];
    this.addLog(cur.name + ' 放弃购买，「' + tile.name + '」进入公开拍卖！');
    this.state.phase = 'auction';
    this.state.pendingTile = null;
    this.state.lastMove = null;
    this.state.auction = { tileId, currentBid: 0, currentBidder: null, deadline: Date.now() + 15000 };
    this.broadcastState();
    this.scheduleAuctionEnd();
    return { ok: true };
  }

  // 拍卖出价
  bid(playerId, amount) {
    if (!this.state || !this.state.auction) return { error: '没有进行中的拍卖' };
    if (this.state.phase !== 'auction') return { error: '不在拍卖中' };
    const bidAmount = Math.floor(Number(amount));
    if (!(bidAmount > this.state.auction.currentBid)) return { error: '出价需高于当前价' };
    const player = this.state.players.find(p => p.id === playerId);
    if (!player || player.bankrupt) return { error: '无法出价' };
    if (player.money < bidAmount) return { error: '现金不足' };
    this.state.auction.currentBid = bidAmount;
    this.state.auction.currentBidder = playerId;
    this.state.auction.deadline = Date.now() + 15000;
    this.addLog(player.name + ' 出价 ¥' + bidAmount);
    this.broadcastState();
    this.scheduleAuctionEnd();
    return { ok: true };
  }

  scheduleAuctionEnd() {
    if (this._auctionTimer) clearTimeout(this._auctionTimer);
    this._auctionTimer = setTimeout(() => {
      this._auctionTimer = null;
      if (this.state && this.state.phase === 'auction') this.endAuction();
    }, 15000);
  }

  endAuction() {
    if (!this.state || !this.state.auction) return;
    const auction = this.state.auction;
    const tile = TILES[auction.tileId];
    if (auction.currentBidder) {
      const winner = this.state.players.find(p => p.id === auction.currentBidder);
      if (winner) {
        winner.money -= auction.currentBid;
        this.state.tileOwners[auction.tileId] = winner.id;
        this.state.tileHouses[auction.tileId] = 0;
        this.addLog(winner.name + ' 以 ¥' + auction.currentBid + ' 拍得「' + tile.name + '」');
      }
    } else {
      this.addLog('「' + tile.name + '」无人出价，流拍');
    }
    this.state.auction = null;
    this.finishTurn();
    this.broadcastState();
  }

  // 结束回合（收租/缴税/事件后）
  endTurn(playerId) {
    if (!this.state) return { error: '游戏未开始' };
    const cur = this.state.players[this.state.current];
    if (cur.id !== playerId) return { error: '还没轮到你' };
    if (this.state.phase !== 'after_move') return { error: '当前不能结束回合' };
    this.finishTurn();
    this.broadcastState();
    return { ok: true };
  }

  // 建造/升级房屋（需垄断同色组 + 均匀建设）
  buildHouse(playerId, tileId) {
    if (!this.state) return { error: '游戏未开始' };
    const cur = this.state.players[this.state.current];
    if (cur.id !== playerId) return { error: '还没轮到你' };
    if (this.state.phase !== 'rolling' && this.state.phase !== 'after_move') return { error: '当前阶段不能盖房' };

    const tile = TILES[tileId];
    if (!tile || tile.type !== 'property') return { error: '只能在地产上盖房' };
    if (this.state.tileOwners[tileId] !== playerId) return { error: '这不是你的地' };
    if (this.state.tileMortgaged[tileId]) return { error: '抵押期间不能盖房' };

    const groupTiles = TILES.filter(t => t.type === 'property' && t.group === tile.group);
    const monopoly = groupTiles.every(t => this.state.tileOwners[t.id] === playerId);
    if (!monopoly) return { error: '需要集齐同色整组才能盖房' };

    const minHouses = Math.min(...groupTiles.map(t => this.state.tileHouses[t.id] || 0));
    const curHouses = this.state.tileHouses[tileId] || 0;
    if (curHouses > minHouses) return { error: '需要均匀盖房（先给房子少的地盖）' };
    if (curHouses >= HOTEL_LEVEL) return { error: '已建成旅馆，不能再盖' };

    const cost = getHouseCost(tile.group);
    if (cur.money < cost) return { error: '现金不足，无法盖房' };

    cur.money -= cost;
    this.state.tileHouses[tileId] = curHouses + 1;
    this.addLog(cur.name + ' 在「' + tile.name + '」盖房（' + (curHouses + 1) + ' 级，¥' + cost + '）');
    this.broadcastState();
    return { ok: true };
  }

  applyCard(cur, ps, card) {
    switch (card.action) {
      case 'gain':
        cur.money += card.amount;
        break;
      case 'lose':
        cur.money -= card.amount;
        break;
      case 'goto': {
        if (card.position < cur.position) cur.money += PASS_GO_BONUS;
        cur.position = card.position;
        break;
      }
      case 'gotoRailroad': {
        const railroads = TILES.filter(t => t.type === 'railroad').map(t => t.id);
        const next = railroads.find(r => r > cur.position) || railroads[0];
        if (next <= cur.position) cur.money += PASS_GO_BONUS;
        cur.position = next;
        break;
      }
      case 'move': {
        cur.position = (cur.position + card.steps + BOARD_SIZE) % BOARD_SIZE;
        break;
      }
      case 'jail':
        cur.position = JAIL_TILE_ID;
        cur.inJail = true;
        cur.jailedTurns = 1;
        break;
      case 'outOfJail':
        cur.outOfJailCards = (cur.outOfJailCards || 0) + 1;
        break;
    }
  }

  applyEvent(cur, ps, tile) {
    let text = '';
    let again = false;
    switch (tile.sub) {
      case 'lottery': {
        const win = Math.random() < 0.5;
        cur.money += win ? 100 : -100;
        text = win ? '中奖 +¥100' : '没中，-¥100';
        break;
      }
      case 'teleport': {
        const target = Math.floor(Math.random() * BOARD_SIZE);
        cur.position = target;
        text = '被传送到「' + TILES[target].name + '」';
        break;
      }
      case 'festival':
        ps.forEach(p => { p.money += 50; });
        text = '节日快乐，每人 +¥50';
        break;
      case 'bonus':
        cur.money += 100;
        text = '获得奖金 +¥100';
        break;
      case 'fine':
        cur.money -= 80;
        text = '缴纳罚款 -¥80';
        break;
      case 'advance':
        cur.position = (cur.position + 3) % BOARD_SIZE;
        text = '前进 3 步';
        break;
      case 'backward':
        cur.position = (cur.position - 3 + BOARD_SIZE) % BOARD_SIZE;
        text = '后退 3 步';
        break;
      case 'rest':
        cur.rest = true;
        text = '休息，下回合跳过';
        break;
      case 'bank':
        cur.money += 50;
        text = '存款利息 +¥50';
        break;
      case 'again':
        again = true;
        text = '再来一次！';
        break;
      case 'shop':
        cur.money += 80;
        text = '商店返现 +¥80';
        break;
      case 'auction':
        text = '拍卖行（后续版本开放）';
        break;
      default:
        text = '';
    }
    return { text, again };
  }

  calcRent(tileId, ownerId, diceTotal) {
    if (this.state.tileMortgaged[tileId]) return 0;
    const tile = TILES[tileId];
    const level = this.state.tileHouses[tileId] || 0;
    if (tile.type === 'property') {
      const groupTiles = TILES.filter(t => t.type === 'property' && t.group === tile.group);
      const monopoly = groupTiles.every(t => this.state.tileOwners[t.id] === ownerId);
      return calcPropertyRent(tile, level, monopoly);
    }
    if (tile.type === 'railroad') {
      const count = TILES.filter(t => t.type === 'railroad' && this.state.tileOwners[t.id] === ownerId).length;
      return calcRailroadRent(count);
    }
    if (tile.type === 'utility') {
      const count = TILES.filter(t => t.type === 'utility' && this.state.tileOwners[t.id] === ownerId).length;
      return calcUtilityRent(count, diceTotal);
    }
    return 0;
  }

  // 回合推进
  finishTurn() {
    const n = this.state.players.length;
    let guard = 0;
    do {
      this.state.current = (this.state.current + 1) % n;
      if (this.state.current === 0) this.state.round++;
      const p = this.state.players[this.state.current];
      if (p.rest) { p.rest = false; continue; }
      if (p.bankrupt) continue;
      break;
    } while (guard++ < n * 2);

    if (this.state.round > DEFAULT_MAX_ROUNDS) { this.settleByAssets(); return; }

    this.state.phase = 'rolling';
    this.state.pendingTile = null;
    this.state.dice = null;
    this.state.lastMove = null;
  }

  mortgageProperty(playerId, tileId) {
    if (!this.state) return { error: '游戏未开始' };
    const cur = this.state.players[this.state.current];
    if (cur.id !== playerId) return { error: '还没轮到你' };
    if (this.state.phase !== 'rolling' && this.state.phase !== 'after_move') return { error: '当前阶段不能抵押' };
    const tile = TILES[tileId];
    if (!tile || (tile.type !== 'property' && tile.type !== 'railroad' && tile.type !== 'utility')) return { error: '只能抵押地产/车站/公共事业' };
    if (this.state.tileOwners[tileId] !== playerId) return { error: '这不是你的地' };
    if ((this.state.tileHouses[tileId] || 0) > 0) return { error: '该地产上有房屋，需先卖房才能抵押' };
    if (this.state.tileMortgaged[tileId]) return { error: '已抵押' };
    const amount = Math.floor(getPropertyPrice(tile) / 2);
    cur.money += amount;
    this.state.tileMortgaged[tileId] = true;
    this.addLog(cur.name + ' 将「' + tile.name + '」抵押给银行，获得 ¥' + amount);
    this.broadcastState();
    return { ok: true };
  }

  unmortgageProperty(playerId, tileId) {
    if (!this.state) return { error: '游戏未开始' };
    const cur = this.state.players[this.state.current];
    if (cur.id !== playerId) return { error: '还没轮到你' };
    if (this.state.phase !== 'rolling' && this.state.phase !== 'after_move') return { error: '当前阶段不能赎回' };
    if (!this.state.tileMortgaged[tileId]) return { error: '该地产未抵押' };
    const tile = TILES[tileId];
    const base = Math.floor(getPropertyPrice(tile) / 2);
    const cost = Math.floor(base * 1.1);
    if (cur.money < cost) return { error: '现金不足，无法赎回' };
    cur.money -= cost;
    this.state.tileMortgaged[tileId] = false;
    this.addLog(cur.name + ' 赎回「' + tile.name + '」，支付 ¥' + cost);
    this.broadcastState();
    return { ok: true };
  }

  // 房屋/酒店半价卖回银行（需均匀拆除：先拆房子多的）
  sellHouse(playerId, tileId) {
    if (!this.state) return { error: '游戏未开始' };
    const cur = this.state.players[this.state.current];
    if (cur.id !== playerId) return { error: '还没轮到你' };
    if (this.state.phase !== 'rolling' && this.state.phase !== 'after_move') return { error: '当前阶段不能卖房' };
    const tile = TILES[tileId];
    if (!tile || tile.type !== 'property') return { error: '只能卖地产上的房屋' };
    if (this.state.tileOwners[tileId] !== playerId) return { error: '这不是你的地' };
    const houses = this.state.tileHouses[tileId] || 0;
    if (houses <= 0) return { error: '该地没有房屋' };
    const groupTiles = TILES.filter(t => t.type === 'property' && t.group === tile.group);
    const maxH = Math.max(...groupTiles.map(t => this.state.tileHouses[t.id] || 0));
    if (houses < maxH) return { error: '需要均匀拆除（先拆房子多的地）' };
    const refund = Math.floor(getHouseCost(tile.group) / 2);
    cur.money += refund;
    this.state.tileHouses[tileId] = houses - 1;
    this.addLog(cur.name + ' 将「' + tile.name + '」的房屋半价卖给银行，+¥' + refund);
    this.broadcastState();
    return { ok: true };
  }

  proposeTrade(playerId, proposal) {
    if (!this.state) return { error: '游戏未开始' };
    // 交易不受回合限制：任何未破产的玩家都能随时发起
    const from = this.state.players.find(p => p.id === playerId);
    if (!from || from.bankrupt) return { error: '无法发起交易' };
    const to = this.state.players.find(p => p.id === proposal.to);
    if (!to) return { error: '交易对象不存在' };
    const giveTiles = proposal.giveTiles || [];
    const getTiles = proposal.getTiles || [];
    const giveMoney = proposal.giveMoney || 0;
    const getMoney = proposal.getMoney || 0;
    // 验证地产归属与无房
    for (const t of giveTiles) {
      if (this.state.tileOwners[t] !== playerId) return { error: '要给出的地产不属于你' };
      if ((this.state.tileHouses[t] || 0) > 0) return { error: '有房屋的地产不能交易，需先卖房' };
    }
    for (const t of getTiles) {
      if (this.state.tileOwners[t] !== proposal.to) return { error: '要获得的地产不属于对方' };
      if ((this.state.tileHouses[t] || 0) > 0) return { error: '对方地产上有房屋，不能交易' };
    }
    if (giveMoney < 0 || getMoney < 0) return { error: '金额不能为负' };
    this.state.pendingTrade = { from: playerId, to: proposal.to, giveTiles, getTiles, giveMoney, getMoney };
    // 交易内容写入日志，所有玩家可见
    const giveDesc = [...giveTiles.map((id) => TILES[id].name), ...(giveMoney ? ['¥' + giveMoney] : [])].join('、') || '无';
    const getDesc = [...getTiles.map((id) => TILES[id].name), ...(getMoney ? ['¥' + getMoney] : [])].join('、') || '无';
    this.addLog(from.name + ' 提议与 ' + to.name + ' 交易：给[' + giveDesc + '] 换 [' + getDesc + ']');
    this.broadcastState();
    return { ok: true };
  }

  acceptTrade(playerId) {
    if (!this.state || !this.state.pendingTrade) return { error: '没有待处理的交易' };
    const t = this.state.pendingTrade;
    if (playerId !== t.to) return { error: '只有对方可以接受交易' };
    const A = this.state.players.find(p => p.id === t.from);
    const B = this.state.players.find(p => p.id === t.to);
    // 再次验证资金与地产
    if (A.money < t.giveMoney || B.money < t.getMoney) return { error: '现金不足，交易失败' };
    for (const id of t.giveTiles) if (this.state.tileOwners[id] !== t.from) return { error: '地产已变动，交易取消' };
    for (const id of t.getTiles) if (this.state.tileOwners[id] !== t.to) return { error: '地产已变动，交易取消' };
    // 执行
    t.giveTiles.forEach(id => { this.state.tileOwners[id] = t.to; });
    t.getTiles.forEach(id => { this.state.tileOwners[id] = t.from; });
    A.money -= t.giveMoney; B.money += t.giveMoney;
    B.money -= t.getMoney; A.money += t.getMoney;
    this.state.pendingTrade = null;
    this.addLog(A.name + ' 与 ' + B.name + ' 完成交易');
    this.broadcastState();
    return { ok: true };
  }

  rejectTrade(playerId) {
    if (!this.state || !this.state.pendingTrade) return { error: '没有待处理的交易' };
    const t = this.state.pendingTrade;
    if (playerId !== t.to && playerId !== t.from) return { error: '无权操作' };
    this.state.pendingTrade = null;
    this.addLog('交易提议被拒绝');
    this.broadcastState();
    return { ok: true };
  }

  backToLobby(playerId) {
    const host = this.players.get(playerId);
    if (!host || !host.isHost) return { error: '只有房主可以回到大厅' };
    console.log('[回大厅] 房主手动重置');
    this.resetToLobby();
    return { ok: true };
  }

  bankrupt(player) {
    player.bankrupt = true;
    Object.keys(this.state.tileOwners).forEach((tid) => {
      if (this.state.tileOwners[tid] === player.id) {
        delete this.state.tileOwners[tid];
        this.state.tileHouses[tid] = 0;
        this.state.tileMortgaged[tid] = false;
      }
    });
    this.addLog(player.name + ' 破产出局！');
    this.checkWinner();
  }

  checkWinner() {
    const alive = this.state.players.filter(p => !p.bankrupt);
    if (alive.length <= 1) {
      this.state.phase = 'gameOver';
      this.state.winner = alive.length === 1 ? alive[0].id : null;
      this.addLog(alive.length === 1 ? alive[0].name + ' 获胜！' : '游戏结束');
    }
  }

  settleByAssets() {
    const alive = this.state.players.filter(p => !p.bankrupt);
    const assets = alive.map((p) => {
      let value = p.money;
      TILES.forEach((t) => {
        if (this.state.tileOwners[t.id] === p.id) {
          value += getPropertyPrice(t);
          value += (this.state.tileHouses[t.id] || 0) * getHouseCost(t.group || 'brown');
        }
      });
      return { id: p.id, value };
    });
    assets.sort((a, b) => b.value - a.value);
    this.state.phase = 'gameOver';
    this.state.winner = assets[0] ? assets[0].id : null;
    if (assets[0]) this.addLog('回合结束，' + this.state.players.find(p => p.id === assets[0].id).name + ' 以总资产 ¥' + assets[0].value + ' 获胜！');
  }

  resetToLobby() {
    if (this._auctionTimer) { clearTimeout(this._auctionTimer); this._auctionTimer = null; }
    this.players.forEach((p) => { if (p._discTimer) { clearTimeout(p._discTimer); p._discTimer = null; } });
    this.started = false;
    this.state = null;
    this.spectators.forEach((ws) => { try { ws.close(); } catch {} });
    this.spectators.clear();
    this.broadcast(JSON.stringify({ type: 'back_to_lobby' }));
    this.broadcastPlayerList();
  }

  addLog(text) {
    if (!this.state) return;
    this.state.log.push(text);
    if (this.state.log.length > 100) this.state.log.shift();
  }

  broadcastPlayerList() {
    const players = [...this.players.values()].map(p => ({
      id: p.id, name: p.name, color: p.color, isHost: p.isHost,
    }));
    this.broadcast(JSON.stringify({
      type: 'player_list', players,
      canStart: this.players.size >= MIN_PLAYERS, started: this.started,
    }));
  }

  broadcastState() {
    this.broadcast(JSON.stringify({ type: 'game_state', state: this.state }));
  }

  broadcast(msg) {
    this.players.forEach(p => { if (p.ws && p.ws.readyState === 1) p.ws.send(msg); });
    this.spectators.forEach(s => { if (s && s.readyState === 1) s.send(msg); });
  }

  sendError(ws, message) {
    if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'error', message }));
  }
}

