// ============================================================
// 单房间游戏逻辑（服务端权威）
// 掷骰、移动、买地、收租、缴税、回合流转
// ============================================================
import {
  START_MONEY, MAX_PLAYERS, MIN_PLAYERS, PASS_GO_BONUS,
  JAIL_BAIL,
  calcPropertyRent, calcRailroadRent, calcUtilityRent, getPropertyPrice, getHouseCost, HOTEL_LEVEL, DEFAULT_MAX_ROUNDS,
  FAST_MODE, STOCK_DEFS, DEFAULT_INTEREST_RATE,
  LOAN_RATE, LOAN_MAX, LOAN_ASSET_RATIO, LOAN_MIN, MARKET_EVENT_CHANCE,
  SHORT_FEE_RATE, SHORT_MAX_VALUE, SHORT_CASH_RATIO, SHORT_MARGIN_RATIO,
} from './rules.js';
import { getMap, MAP_LIST } from '../js/data/maps.js';
import { updateStats } from './db.js';
import { CHANCE_CARDS, CHEST_CARDS } from '../js/data/cards.js';

const PLAYER_COLORS = ['#EF5350', '#FF9800', '#FDD835', '#66BB6A', '#4FC3F7', '#AB47BC', '#26C6DA', '#EC407A'];
const TURN_TIMEOUT = 45000; // 回合倒计时（毫秒）
// 全市场事件概率（可用环境变量覆盖，便于测试与调平衡）
const EVENT_CHANCE = Number(process.env.MARKET_EVENT_CHANCE != null ? process.env.MARKET_EVENT_CHANCE : MARKET_EVENT_CHANCE);

function uid() { return Math.random().toString(36).slice(2, 10); }

export class GameRoom {
  constructor() {
    this.players = new Map();
    this.spectators = new Map();
    this.started = false;
    this.state = null;
    this._auctionTimer = null;
    this._turnTimer = null;
    this.settings = {
      startMoney: START_MONEY, maxRounds: DEFAULT_MAX_ROUNDS, houseMultiplier: 1, mapId: 'standard',
      fastMode: false, teamMode: false, interestRate: DEFAULT_INTEREST_RATE,
      auctionOnClose: true,   // 破产时是否走银行拍卖（关闭则地产直接回归银行）
      randomLand: false,      // 开局随机分地（普通模式也可用）
      randomMap: false,       // 开局随机地图
    };
    this.map = getMap(this.settings.mapId);
    this.lastActiveAt = Date.now();   // 房间 GC 用
    this.eventChance = EVENT_CHANCE;   // 市场事件概率（测试可置 0）
  }

  updateSettings(playerId, settings) {
    const host = this.players.get(playerId);
    if (!host || !host.isHost) return { error: '只有房主可以修改设置' };
    if (this.started) return { error: '游戏已开始' };
    const v = settings || {};
    if (v.startMoney != null) this.settings.startMoney = Math.max(500, Math.min(10000, Math.floor(Number(v.startMoney)) || START_MONEY));
    if (v.maxRounds != null) this.settings.maxRounds = Math.max(10, Math.min(200, Math.floor(Number(v.maxRounds)) || DEFAULT_MAX_ROUNDS));
    if (v.houseMultiplier != null) this.settings.houseMultiplier = Math.max(0.5, Math.min(3, Number(v.houseMultiplier) || 1));
    if (v.mapId) this.settings.mapId = getMap(v.mapId).id;
    if (v.fastMode != null) this.settings.fastMode = !!v.fastMode;
    if (v.teamMode != null) this.settings.teamMode = !!v.teamMode;
    if (v.interestRate != null) this.settings.interestRate = Math.max(0, Math.min(0.05, Number(v.interestRate) || 0));
    if (v.auctionOnClose != null) this.settings.auctionOnClose = !!v.auctionOnClose;
    if (v.randomLand != null) this.settings.randomLand = !!v.randomLand;
    if (v.randomMap != null) this.settings.randomMap = !!v.randomMap;
    this.map = getMap(this.settings.mapId);
    this.broadcastPlayerList();
    return { ok: true };
  }

  addPlayer(ws, name, playerId, userId) {
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
    const hasHumanHost = [...this.players.values()].some(p => p.isHost && !p.isAI && p.ws && p.ws.readyState === 1);
    const player = { ws, id, name: cleanName, color, isHost: !hasHumanHost, userId: userId || null };
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
      const sp = this.state.players.find(p => p.id === playerId);
      if (sp && !sp.bankrupt) { sp.bankrupt = true; this.addLog(sp.name + ' 掉线退出'); }
      const online = [...this.players.values()].filter(p => p.isAI || (p.ws && p.ws.readyState === 1)).length;
      if (online < MIN_PLAYERS) {
        console.log('[自动结束] 在线人数不足，游戏回到大厅');
        this.resetToLobby();
        return;
      }
    }

    if (player.isHost) {
      const nextHuman = [...this.players.values()].find(p => !p.isAI);
      if (nextHuman) nextHuman.isHost = true;
    }

    // 大厅里最后一个真人离开时，连机器人一起清掉
    // 否则会残留一间“只有机器人、但仍在 rooms 里”的房间，房主重连时会被拉回去
    if (!this.started && ![...this.players.values()].some(p => !p.isAI)) {
      this.players.clear();
    }
    this.broadcastPlayerList();
  }

  removeSpectator(id) { this.spectators.delete(id); }

  // 房主踢人（仅大厅，可踢机器人）
  kickPlayer(hostId, targetId) {
    const host = this.players.get(hostId);
    if (!host || !host.isHost) return { error: '只有房主可以踢人' };
    if (this.started) return { error: '游戏已开始，不能踢人' };
    if (targetId === hostId) return { error: '不能踢自己，可以直接退出房间' };
    const target = this.players.get(targetId);
    if (!target) return { error: '该玩家已不在房间' };

    this.players.delete(targetId);
    if (target.ws) {
      try { target.ws.send(JSON.stringify({ type: 'kicked', message: '你被房主移出了房间' })); } catch {}
      try { target.ws.close(); } catch {}
    }
    this.broadcastPlayerList();
    return { ok: true, name: target.name, isAI: !!target.isAI };
  }

  // 转让房主（仅大厅，且只能转给真人）
  transferHost(hostId, targetId) {
    const host = this.players.get(hostId);
    if (!host || !host.isHost) return { error: '只有房主可以转让房主' };
    if (this.started) return { error: '游戏已开始，不能转让房主' };
    if (targetId === hostId) return { error: '你已经是房主了' };
    const target = this.players.get(targetId);
    if (!target) return { error: '该玩家已不在房间' };
    if (target.isAI) return { error: '不能把房主转让给机器人' };

    host.isHost = false;
    target.isHost = true;
    this.broadcastPlayerList();
    return { ok: true, name: target.name };
  }

  startGame(playerId) {
    const host = this.players.get(playerId);
    if (!host || !host.isHost) return { error: '只有房主可以开始游戏' };
    if (this.players.size < MIN_PLAYERS) return { error: '至少需要 2 名玩家' };
    if (this.started) return { error: '游戏已经开始' };
    if (this.settings.teamMode && this.players.size < 4) return { error: '团队模式至少需要 4 名玩家（2v2）' };
    if (this.settings.teamMode && this.players.size % 2 !== 0) return { error: '团队模式需要偶数人数（2v2 / 3v3）' };

    this.started = true;
    if (this.settings.randomMap) {
      const others = MAP_LIST.filter(id => id !== this.settings.mapId);
      this.settings.mapId = others[Math.floor(Math.random() * others.length)] || this.settings.mapId;
    }
    this.map = getMap(this.settings.mapId);
    // 快速模式：套用预设（高起点资金、租金加成、回合更少、倒计时更短）
    const fast = !!this.settings.fastMode;
    const startMoney = fast ? FAST_MODE.startMoney : this.settings.startMoney;
    const maxRounds = fast ? FAST_MODE.maxRounds : this.settings.maxRounds;
    const houseMultiplier = fast ? FAST_MODE.houseMultiplier : this.settings.houseMultiplier;
    let teamIdx = 0;
    const players = [...this.players.values()].map(p => ({
      id: p.id, name: p.name, color: p.color, isHost: p.isHost, isAI: !!p.isAI, userId: p.userId || null,
      position: 0, money: startMoney, inJail: false, jailedTurns: 0, outOfJailCards: 0, rest: false, bankrupt: false,
      team: this.settings.teamMode ? (teamIdx++ % 2 === 0 ? 'A' : 'B') : null,
      stocks: {},
      stockCost: {},   // 各股持仓总成本（移动加权平均法算盈亏）
      loan: 0,         // 银行贷款余额（计入总资产时为负数）
      shorts: {},      // 融券做空持仓：stockId -> 股数
      shortEntry: {},  // 空头开仓总额（算开仓均价与平仓盈亏）
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
      auctionQueue: null,
      lastCard: null,
      pendingTile: null,
      lastMove: null,
      turnDeadline: null,
      maxRounds,
      houseMultiplier,
      mapId: this.settings.mapId,
      fastMode: fast,
      teamMode: !!this.settings.teamMode,
      rentMultiplier: fast ? FAST_MODE.rentMultiplier : 1,
      interestRate: this.settings.interestRate || 0,
      loanRate: LOAN_RATE,
      auctionOnClose: this.settings.auctionOnClose !== false,
      randomLand: !!this.settings.randomLand,
      randomMap: !!this.settings.randomMap,
      shortFeeRate: SHORT_FEE_RATE,
      turnTimeout: fast ? FAST_MODE.turnTimeout : TURN_TIMEOUT,
      stocks: STOCK_DEFS.map(d => ({ id: d.id, name: d.name, base: d.base, price: d.base, prev: d.base, kind: d.kind || 'stock' })),
      log: ['游戏开始！'],
    };

    // 快速模式或"随机分地"房规：开局分地
    if (fast || this.settings.randomLand) this._distributeProperties();

    // 开局就启动第一回合倒计时（此前首回合没有 deadline，界面不显示秒数）
    this._resetTurnTimer();

    this.broadcastState();
    return { ok: true };
  }

  // 快速模式开局分地：数量随人数自适应，同一人尽量不拿同色组（避免开局白送垄断）
  _distributeProperties() {
    const props = this.map.tiles.filter(t => t.type === 'property');
    const players = this.state.players;
    if (!props.length || !players.length) return 0;
    const perPlayer = Math.max(1, Math.min(3, Math.floor(props.length / players.length / 2)));

    const pool = props.slice();
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const tmp = pool[i]; pool[i] = pool[j]; pool[j] = tmp;
    }

    const owned = new Map(players.map(p => [p.id, new Set()]));
    const picked = new Map(players.map(p => [p.id, []]));
    for (let round = 0; round < perPlayer; round++) {
      players.forEach((p) => {
        if (!pool.length) return;
        let idx = pool.findIndex(t => !owned.get(p.id).has(t.group));
        if (idx < 0) idx = 0;
        const tile = pool.splice(idx, 1)[0];
        this.state.tileOwners[tile.id] = p.id;
        owned.get(p.id).add(tile.group);
        picked.get(p.id).push(tile.name);
      });
    }

    players.forEach((p) => {
      const names = picked.get(p.id);
      if (names && names.length) this.addLog('【开局分地】' + p.name + ' 分到 ' + names.join('、'));
    });
    return perPlayer;
  }

  // 当前玩家掷骰
  rollDice(playerId) {
    if (!this.state) return { error: '游戏未开始' };
    const ps = this.state.players;
    const cur = ps[this.state.current];
    if (cur.id !== playerId) return { error: '还没轮到你' };
    if (this.state.phase !== 'rolling') return { error: '当前阶段不能掷骰' };

    const d1 = 1 + Math.floor(Math.random() * 6);
    const d2 = 1 + Math.floor(Math.random() * 6);

    if (cur.inJail) {
      if (d1 === d2) {
        cur.inJail = false;
        cur.jailedTurns = 0;
        this.addLog(cur.name + ' 掷出双数 ' + d1 + '+' + d2 + '，成功出狱！');
        this._moveAndResolve(cur, ps, d1, d2, cur.name + ' 掷出 ' + d1 + '+' + d2);
      } else {
        cur.jailedTurns = (cur.jailedTurns || 0) + 1;
        if (cur.jailedTurns >= 3) {
          cur.inJail = false;
          cur.jailedTurns = 0;
          cur.money -= JAIL_BAIL;
          this.addLog(cur.name + ' 已在监狱满 3 回合，支付 ¥' + JAIL_BAIL + ' 出狱');
          this._moveAndResolve(cur, ps, d1, d2, cur.name + ' 掷出 ' + d1 + '+' + d2);
        } else {
          this.addLog(cur.name + ' 掷出 ' + d1 + '+' + d2 + '，不是双数，继续关押（' + cur.jailedTurns + '/3）');
          this.state.dice = [d1, d2];
          this.finishTurn();
          this.broadcastState();
        }
      }
      return { ok: true };
    }

    this._moveAndResolve(cur, ps, d1, d2, cur.name + ' 掷出 ' + d1 + '+' + d2);
    return { ok: true };
  }

  // 付保释金出狱
  payBail(playerId) {
    if (!this.state) return { error: '游戏未开始' };
    const ps = this.state.players;
    const cur = ps[this.state.current];
    if (cur.id !== playerId) return { error: '还没轮到你' };
    if (this.state.phase !== 'rolling') return { error: '当前阶段不能操作' };
    if (!cur.inJail) return { error: '你不在监狱' };
    if (cur.money < JAIL_BAIL) return { error: '现金不足，无法保释' };

    cur.money -= JAIL_BAIL;
    cur.inJail = false;
    cur.jailedTurns = 0;
    this.addLog(cur.name + ' 支付 ¥' + JAIL_BAIL + ' 出狱');
    const d1 = 1 + Math.floor(Math.random() * 6);
    const d2 = 1 + Math.floor(Math.random() * 6);
    this._moveAndResolve(cur, ps, d1, d2, cur.name + ' 出狱后掷出 ' + d1 + '+' + d2);
    return { ok: true };
  }

  // 使用出狱卡出狱
  useJailCard(playerId) {
    if (!this.state) return { error: '游戏未开始' };
    const ps = this.state.players;
    const cur = ps[this.state.current];
    if (cur.id !== playerId) return { error: '还没轮到你' };
    if (this.state.phase !== 'rolling') return { error: '当前阶段不能操作' };
    if (!cur.inJail) return { error: '你不在监狱' };
    if ((cur.outOfJailCards || 0) <= 0) return { error: '没有出狱卡' };

    cur.outOfJailCards--;
    cur.inJail = false;
    cur.jailedTurns = 0;
    this.addLog(cur.name + ' 使用出狱卡出狱');
    const d1 = 1 + Math.floor(Math.random() * 6);
    const d2 = 1 + Math.floor(Math.random() * 6);
    this._moveAndResolve(cur, ps, d1, d2, cur.name + ' 出狱后掷出 ' + d1 + '+' + d2);
    return { ok: true };
  }

  // 掷骰后移动并结算（rollDice / payBail / useJailCard 共用）
  _moveAndResolve(cur, ps, d1, d2, logMsg) {
    const steps = d1 + d2;
    const from = cur.position;
    let to = from + steps;
    let passedGo = false;
    if (to >= this.map.size) {
      to = to % this.map.size;
      passedGo = true;
      cur.money += PASS_GO_BONUS;
    }
    cur.position = to;

    const tile = this.map.tiles[to];
    if (passedGo) logMsg += '，经过起点 +¥' + PASS_GO_BONUS;
    logMsg += '，走到「' + tile.name + '」';

    let phase = 'after_move';
    let pendingTile = null;
    let creditor = null;

    if (tile.type === 'property' || tile.type === 'railroad' || tile.type === 'utility') {
      const ownerId = this.state.tileOwners[to];
      if (!ownerId) {
        phase = 'buying';
        pendingTile = to;
        logMsg += '（无主，可购买 ¥' + getPropertyPrice(tile) + '）';
      } else if (ownerId !== cur.id) {
        const owner = ps.find(p => p.id === ownerId);
        if (this.state.teamMode && owner && owner.team && owner.team === cur.team) {
          logMsg += '（队友的地产，免租）';
        } else {
          const rent = Math.round(this.calcRent(to, ownerId, steps) * (this.state.rentMultiplier || 1));
          cur.money -= rent;
          if (owner) owner.money += rent;
          logMsg += '，支付租金 ¥' + rent + ' 给 ' + (owner ? owner.name : '?');
          if (cur.money < 0) creditor = ownerId;
        }
      } else {
        logMsg += '（自己的地产）';
      }
    } else if (tile.type === 'tax') {
      cur.money -= tile.amount;
      logMsg += '，缴税 ¥' + tile.amount;
    } else if (tile.type === 'gotojail') {
      cur.position = this.map.jailId;
      cur.inJail = true;
      cur.jailedTurns = 1;
      logMsg += '，被送进监狱！';
    } else if (tile.type === 'chance' || tile.type === 'chest') {
      const deck = tile.type === 'chance' ? CHANCE_CARDS : CHEST_CARDS;
      const card = deck[Math.floor(Math.random() * deck.length)];
      logMsg += '，抽到【' + card.text + '】';
      this.applyCard(cur, ps, card);
      this.state.lastCard = { type: tile.type, text: card.text, seq: (this.state.lastCard && this.state.lastCard.seq || 0) + 1 };
    } else if (tile.type === 'event') {
      const r = this.applyEvent(cur, ps, tile);
      logMsg += '，' + r.text;
      if (r.again) phase = 'rolling';
    }

    this.state.dice = [d1, d2];
    // seq：让前端能判断"这是新的一次移动"，同一回合内的买地/抵押/股市操作不再重放动画
    this.state.moveSeq = (this.state.moveSeq || 0) + 1;
    this.state.lastMove = { seq: this.state.moveSeq, playerIndex: this.state.current, from, to: cur.position, dice: [d1, d2] };
    this.addLog(logMsg);

    if (cur.money < 0) {
      this.settleDebt(cur, creditor);
    } else {
      this.state.phase = phase;
      this.state.pendingTile = pendingTile;
    }

    this._resetTurnTimer();
    this.broadcastState();
  }

  // 购买当前地产
  buyProperty(playerId) {
    if (!this.state) return { error: '游戏未开始' };
    const cur = this.state.players[this.state.current];
    if (cur.id !== playerId) return { error: '还没轮到你' };
    if (this.state.phase !== 'buying' || this.state.pendingTile == null) return { error: '当前不能购买' };

    const tileId = this.state.pendingTile;
    const tile = this.map.tiles[tileId];
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
    const tile = this.map.tiles[tileId];
    this.addLog(cur.name + ' 放弃购买，「' + tile.name + '」进入公开拍卖！');
    this.state.phase = 'auction';
    this.state.pendingTile = null;
    this.state.lastMove = null;
    this.state.auctionQueue = null;
    this.state.auction = { tileId, currentBid: 0, currentBidder: null, deadline: Date.now() + 15000, duration: 15000 };
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
    this.state.auction.deadline = Date.now() + 15000;   // 每次出价重置倒计时
    this.state.auction.duration = 15000;
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
    const tile = this.map.tiles[auction.tileId];
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
    if (this.state.auctionQueue && this.state.auctionQueue.length > 0) {
      this._startNextAuction();
    } else {
      this.finishTurn();
    }
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

    const tile = this.map.tiles[tileId];
    if (!tile || tile.type !== 'property') return { error: '只能在地产上盖房' };
    if (this.state.tileOwners[tileId] !== playerId) return { error: '这不是你的地' };
    if (this.state.tileMortgaged[tileId]) return { error: '抵押期间不能盖房' };

    const groupTiles = this.map.tiles.filter(t => t.type === 'property' && t.group === tile.group);
    const monopoly = groupTiles.every(t => this.state.tileOwners[t.id] === playerId);
    if (!monopoly) return { error: '需要集齐同色整组才能盖房' };

    const minHouses = Math.min(...groupTiles.map(t => this.state.tileHouses[t.id] || 0));
    const curHouses = this.state.tileHouses[tileId] || 0;
    if (curHouses > minHouses) return { error: '需要均匀盖房（先给房子少的地盖）' };
    if (curHouses >= HOTEL_LEVEL) return { error: '已建成旅馆，不能再盖' };

    const cost = Math.round(getHouseCost(tile.group) * (this.state.houseMultiplier || 1));
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
        const target = card.gotoType ? (this.map.tiles.find(t => t.type === card.gotoType) || {}).id : card.position;
        if (target != null && target < cur.position) cur.money += PASS_GO_BONUS;
        if (target != null) cur.position = target;
        break;
      }
      case 'gotoRailroad': {
        const railroads = this.map.tiles.filter(t => t.type === 'railroad').map(t => t.id);
        const next = railroads.find(r => r > cur.position) || railroads[0];
        if (next <= cur.position) cur.money += PASS_GO_BONUS;
        cur.position = next;
        break;
      }
      case 'move': {
        cur.position = (cur.position + card.steps + this.map.size) % this.map.size;
        break;
      }
      case 'jail':
        cur.position = this.map.jailId;
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
        const target = Math.floor(Math.random() * this.map.size);
        cur.position = target;
        text = '被传送到「' + this.map.tiles[target].name + '」';
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
        cur.position = (cur.position + 3) % this.map.size;
        text = '前进 3 步';
        break;
      case 'backward':
        cur.position = (cur.position - 3 + this.map.size) % this.map.size;
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
    const tile = this.map.tiles[tileId];
    const level = this.state.tileHouses[tileId] || 0;
    if (tile.type === 'property') {
      const groupTiles = this.map.tiles.filter(t => t.type === 'property' && t.group === tile.group);
      const monopoly = groupTiles.every(t => this.state.tileOwners[t.id] === ownerId);
      return calcPropertyRent(tile, level, monopoly);
    }
    if (tile.type === 'railroad') {
      const count = this.map.tiles.filter(t => t.type === 'railroad' && this.state.tileOwners[t.id] === ownerId).length;
      return calcRailroadRent(count);
    }
    if (tile.type === 'utility') {
      const count = this.map.tiles.filter(t => t.type === 'utility' && this.state.tileOwners[t.id] === ownerId).length;
      return calcUtilityRent(count, diceTotal);
    }
    return 0;
  }

  // ---------- 股市 ----------
  _updateStockPrices() {
    const S = this.state;
    if (!S || !S.stocks) return;
    const regular = S.stocks.filter(s => s.kind !== 'index');
    const index = S.stocks.find(s => s.kind === 'index');

    // 1) 个股：均值回归 + 随机波动
    regular.forEach((s) => {
      s.prev = s.price;
      const drift = ((s.base - s.price) / s.base) * 0.12;
      const noise = (Math.random() - 0.5) * 0.16;
      const next = Math.round(s.price * (1 + drift + noise));
      s.price = Math.max(Math.round(s.base * 0.3), Math.min(Math.round(s.base * 2.5), next));
    });

    // 2) 指数基金：跟随四支个股的平均相对表现（波动更平滑，适合稳健玩法）
    if (index) {
      index.prev = index.price;
      const avgRatio = regular.reduce((sum, s) => sum + s.price / s.base, 0) / regular.length;
      index.price = Math.max(Math.round(index.base * 0.4), Math.min(Math.round(index.base * 2.2), Math.round(index.base * avgRatio)));
    }

    // 3) 小概率全市场事件
    if (Math.random() < this.eventChance) {
      this._applyMarketEvent(Math.random() < 0.5 ? 'crash' : 'boom');
    }
  }

  // 全市场事件：股灾 / 牛市（会被广播成气泡提示 + 记日志）
  _applyMarketEvent(kind) {
    const S = this.state;
    if (!S || !S.stocks) return null;
    const drop = kind === 'crash';
    const pct = drop ? -(0.12 + Math.random() * 0.08) : (0.10 + Math.random() * 0.06);
    S.stocks.forEach((s) => {
      const next = Math.round(s.price * (1 + pct));
      s.price = Math.max(Math.round(s.base * 0.3), Math.min(Math.round(s.base * 2.5), next));
    });
    const label = (drop ? '📉 股灾！全市场大跌 ' : '📈 牛市！全市场大涨 +') + Math.abs(Math.round(pct * 100)) + '%';
    this.addLog(label);
    this.broadcast(JSON.stringify({ type: 'chat', kind: 'text', text: label, name: '市场', color: drop ? '#c62828' : '#1a7f37' }));
    return { kind, pct };
  }

  _stockGuard(playerId, stockId) {
    if (!this.state || !this.state.stocks) return { error: '游戏未开始' };
    const cur = this.state.players[this.state.current];
    if (!cur || cur.id !== playerId) return { error: '还没轮到你' };
    if (!['rolling', 'buying', 'after_move'].includes(this.state.phase)) return { error: '只能在自己回合买卖股票' };
    const stock = this.state.stocks.find(s => s.id === stockId);
    if (!stock) return { error: '没有这支股票' };
    return { cur, stock };
  }

  buyStock(playerId, stockId, shares) {
    const g = this._stockGuard(playerId, stockId);
    if (g.error) return g;
    const { cur, stock } = g;
    const n = Math.floor(Number(shares) || 0);
    if (n <= 0 || n > 9999) return { error: '买入股数需在 1~9999 之间' };
    const cost = stock.price * n;
    if (cur.money < cost) return { error: '现金不足，需要 ¥' + cost };
    cur.money -= cost;
    cur.stocks[stock.id] = (cur.stocks[stock.id] || 0) + n;
    if (!cur.stockCost) cur.stockCost = {};
    cur.stockCost[stock.id] = (cur.stockCost[stock.id] || 0) + cost;
    const avgAfterBuy = Math.round((cur.stockCost[stock.id] || 0) / cur.stocks[stock.id]);
    this.addLog(cur.name + ' 买入「' + stock.name + '」' + n + ' 股（¥' + stock.price + '/股，共 ¥' + cost + '，持仓均价 ¥' + avgAfterBuy + '）');
    this.broadcastState();
    return { ok: true };
  }

  sellStock(playerId, stockId, shares) {
    const g = this._stockGuard(playerId, stockId);
    if (g.error) return g;
    const { cur, stock } = g;
    const n = Math.floor(Number(shares) || 0);
    const held = cur.stocks[stock.id] || 0;
    if (n <= 0) return { error: '卖出股数不正确' };
    if (held < n) return { error: '持股不足（当前 ' + held + ' 股）' };
    const gain = stock.price * n;
    cur.money += gain;
    if (!cur.stockCost) cur.stockCost = {};
    const totalCost = cur.stockCost[stock.id] || 0;
    const avgCost = held > 0 ? totalCost / held : 0;
    cur.stocks[stock.id] = held - n;
    cur.stockCost[stock.id] = cur.stocks[stock.id] > 0 ? Math.max(0, Math.round(totalCost - avgCost * n)) : 0;
    const plAfterSell = gain - Math.round(avgCost * n);
    this.addLog(cur.name + ' 卖出「' + stock.name + '」' + n + ' 股，得到 ¥' + gain + '（本次' + (plAfterSell >= 0 ? '盈利' : '亏损') + ' ¥' + Math.abs(plAfterSell) + '）');
    this.broadcastState();
    return { ok: true };
  }

  // ---------- 融券做空 ----------
  shortSell(playerId, stockId, shares) {
    const g = this._stockGuard(playerId, stockId);
    if (g.error) return g;
    const { cur, stock } = g;
    const n = Math.floor(Number(shares) || 0);
    if (n <= 0 || n > 9999) return { error: '股数不正确' };

    const value = stock.price * n;
    const cashAfter = cur.money + value;
    const limit = Math.min(SHORT_MAX_VALUE, Math.floor(cashAfter * SHORT_CASH_RATIO));
    if (this.shortValue(cur) + value > limit) {
      return { error: '做空额度不足（上限 ¥' + limit + '，当前空头 ¥' + this.shortValue(cur) + '）' };
    }

    if (!cur.shorts) cur.shorts = {};
    if (!cur.shortEntry) cur.shortEntry = {};
    cur.money += value;
    cur.shorts[stock.id] = (cur.shorts[stock.id] || 0) + n;
    cur.shortEntry[stock.id] = (cur.shortEntry[stock.id] || 0) + value;
    const avg = Math.round(cur.shortEntry[stock.id] / cur.shorts[stock.id]);
    this.addLog(cur.name + ' 融券卖出「' + stock.name + '」' + n + ' 股（¥' + stock.price + '/股，开仓均价 ¥' + avg + '）');
    this.broadcastState();
    return { ok: true };
  }

  coverShort(playerId, stockId, shares) {
    const g = this._stockGuard(playerId, stockId);
    if (g.error) return g;
    const { cur, stock } = g;
    const held = (cur.shorts && cur.shorts[stock.id]) || 0;
    if (held < 1) return { error: '没有该股的空头持仓' };
    const n = Math.min(Math.floor(Number(shares) || 0), held);
    if (n < 1) return { error: '股数不正确' };

    const entryTotal = (cur.shortEntry && cur.shortEntry[stock.id]) || 0;
    const avgEntry = held > 0 ? entryTotal / held : 0;
    const cost = stock.price * n;
    const entryPart = Math.round(avgEntry * n);
    cur.money -= cost;
    cur.shorts[stock.id] = held - n;
    cur.shortEntry[stock.id] = cur.shorts[stock.id] > 0 ? Math.max(0, entryTotal - entryPart) : 0;
    const pl = entryPart - cost;
    this.addLog(cur.name + ' 买回「' + stock.name + '」' + n + ' 股平仓（本次' + (pl >= 0 ? '盈利' : '亏损') + ' ¥' + Math.abs(pl) + '）');
    if (cur.money < 0) this.settleDebt(cur, null);
    else this.broadcastState();
    return { ok: true };
  }

  // 强制平仓（保证金不足时，按现价全部买回，允许现金转负 → 走破产清算）
  _forceCover(player) {
    if (!player || !player.shorts) return;
    let cost = 0;
    this.state.stocks.forEach((s) => {
      const n = player.shorts[s.id] || 0;
      if (n > 0) { cost += s.price * n; player.shorts[s.id] = 0; player.shortEntry[s.id] = 0; }
    });
    if (cost > 0) {
      player.money -= cost;
      this.addLog(player.name + ' 保证金不足，被强制平仓（支付 ¥' + cost + '）');
    }
  }

  // 回合推进
  finishTurn() {
    const n = this.state.players.length;
    // 回合结束结算存款利息
    const ending = this.state.players[this.state.current];
    const rate = this.state.interestRate || 0;
    if (ending && !ending.bankrupt && rate > 0 && ending.money > 0) {
      const interest = Math.floor(ending.money * rate);
      if (interest > 0) {
        ending.money += interest;
        this.addLog(ending.name + ' 存款利息 +¥' + interest);
      }
    }
    // 融券费与保证金
    if (ending && !ending.bankrupt && this.shortValue(ending) > 0) {
      const sv = this.shortValue(ending);
      const fee = Math.max(1, Math.round(sv * (this.state.shortFeeRate || SHORT_FEE_RATE)));
      ending.money -= fee;
      this.addLog(ending.name + ' 融券费 −¥' + fee + '（空头市值 ¥' + sv + '）');
      if (sv > ending.money * SHORT_MARGIN_RATIO) {
        this._forceCover(ending);
      }
      if (ending.money < 0) {
        this.settleDebt(ending, null);
        if (this.state && this.state.phase === 'gameOver') return;
      }
    }

    // 贷款利息滚入本金
    if (ending && !ending.bankrupt && (ending.loan || 0) > 0) {
      const loanInterest = Math.max(1, Math.round(ending.loan * (this.state.loanRate || 0)));
      ending.loan += loanInterest;
      this.addLog(ending.name + ' 贷款利息 +¥' + loanInterest + '（余额 ¥' + ending.loan + '）');
    }
    let guard = 0;
    do {
      this.state.current = (this.state.current + 1) % n;
      if (this.state.current === 0) { this.state.round++; this._updateStockPrices(); }
      const p = this.state.players[this.state.current];
      if (p.rest) { p.rest = false; continue; }
      if (p.bankrupt) continue;
      const conn = this.players.get(p.id);
      if (conn && !conn.isAI && (!conn.ws || conn.ws.readyState !== 1)) continue;
      break;
    } while (guard++ < n * 2);

    if (this.state.round > (this.state.maxRounds || DEFAULT_MAX_ROUNDS)) { this.settleByAssets(); return; }

    this.state.phase = 'rolling';
    this.state.pendingTile = null;
    this.state.dice = null;
    this.state.lastMove = null;
    this._resetTurnTimer();

    const next = this.state.players[this.state.current];
    if (next && next.isAI && !next.bankrupt && this.state.phase !== 'gameOver') {
      this._scheduleAI(next.id);
    }
  }

  // 添加机器人玩家
  addAI(playerId) {
    const host = this.players.get(playerId);
    if (!host || !host.isHost) return { error: '只有房主可以添加机器人' };
    if (this.started) return { error: '游戏已开始' };
    if (this.players.size >= MAX_PLAYERS) return { error: '房间已满（最多8人）' };

    const cleanName = '机器人' + (this.players.size + 1);
    const used = new Set([...this.players.values()].map(p => p.color));
    const color = PLAYER_COLORS.find(c => !used.has(c)) || PLAYER_COLORS[0];
    const id = uid();
    const player = { ws: null, id, name: cleanName, color, isHost: false, isAI: true };
    this.players.set(id, player);
    this.broadcastPlayerList();
    return { ok: true };
  }

  _resetTurnTimer() {
    if (this._turnTimer) { clearTimeout(this._turnTimer); this._turnTimer = null; }
    if (!this.state || this.state.phase === 'gameOver' || this.state.phase === 'auction') {
      if (this.state) this.state.turnDeadline = null;
      return;
    }
    const cur = this.state.players[this.state.current];
    if (!cur || cur.bankrupt || cur.isAI) { this.state.turnDeadline = null; return; }
    const timeout = this.state.turnTimeout || TURN_TIMEOUT;
    this.state.turnDeadline = Date.now() + timeout;
    this._turnTimer = setTimeout(() => { this._turnTimer = null; this._onTurnTimeout(); }, timeout);
  }

  _onTurnTimeout() {
    if (!this.state || this.state.phase === 'gameOver' || this.state.phase === 'auction') return;
    const cur = this.state.players[this.state.current];
    if (!cur || cur.bankrupt || cur.isAI) return;
    if (this.state.phase === 'rolling') this.rollDice(cur.id);
    else if (this.state.phase === 'buying') this.skipBuy(cur.id);
    else if (this.state.phase === 'after_move') this.endTurn(cur.id);
  }

  _scheduleAI(playerId) {
    if (this._aiTimer) clearTimeout(this._aiTimer);
    this._aiTimer = setTimeout(() => {
      this._aiTimer = null;
      this._aiAct(playerId);
    }, 1600);
  }

  _aiAct(playerId) {
    if (!this.state || this.state.phase === 'gameOver') return;
    const ps = this.state.players;
    const cur = ps[this.state.current];
    if (!cur || cur.id !== playerId || !cur.isAI || cur.bankrupt) return;

    if (this.state.phase === 'rolling') {
      if (cur.inJail) {
        if ((cur.outOfJailCards || 0) > 0) this.useJailCard(playerId);
        else if (cur.money >= JAIL_BAIL) this.payBail(playerId);
        else this.rollDice(playerId);
      } else {
        this.rollDice(playerId);
      }
      // 掷骰后若仍轮到该 AI，继续下一步（购买 / 结束回合 / 再来一次）
      const n = this.state.players[this.state.current];
      if (this.state.phase !== 'gameOver' && n && n.id === playerId && n.isAI && !n.bankrupt) {
        this._scheduleAI(playerId);
      }
    } else if (this.state.phase === 'buying') {
      const t = this.map.tiles[this.state.pendingTile];
      const price = getPropertyPrice(t);
      if (cur.money >= price) this.buyProperty(playerId);
      else this.skipBuy(playerId);
    } else if (this.state.phase === 'after_move') {
      this.endTurn(playerId);
    }
  }

  mortgageProperty(playerId, tileId) {
    if (!this.state) return { error: '游戏未开始' };
    const cur = this.state.players[this.state.current];
    if (cur.id !== playerId) return { error: '还没轮到你' };
    if (this.state.phase !== 'rolling' && this.state.phase !== 'after_move') return { error: '当前阶段不能抵押' };
    const tile = this.map.tiles[tileId];
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
    const tile = this.map.tiles[tileId];
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
    const tile = this.map.tiles[tileId];
    if (!tile || tile.type !== 'property') return { error: '只能卖地产上的房屋' };
    if (this.state.tileOwners[tileId] !== playerId) return { error: '这不是你的地' };
    const houses = this.state.tileHouses[tileId] || 0;
    if (houses <= 0) return { error: '该地没有房屋' };
    const groupTiles = this.map.tiles.filter(t => t.type === 'property' && t.group === tile.group);
    const maxH = Math.max(...groupTiles.map(t => this.state.tileHouses[t.id] || 0));
    if (houses < maxH) return { error: '需要均匀拆除（先拆房子多的地）' };
    const refund = Math.floor(getHouseCost(tile.group) * (this.state.houseMultiplier || 1) / 2);
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
    const giveDesc = [...giveTiles.map((id) => this.map.tiles[id].name), ...(giveMoney ? ['¥' + giveMoney] : [])].join('、') || '无';
    const getDesc = [...getTiles.map((id) => this.map.tiles[id].name), ...(getMoney ? ['¥' + getMoney] : [])].join('、') || '无';
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

  // 欠款结算：自动变卖房屋、抵押地产，仍不足则宣告破产
  settleDebt(cur, creditorId) {
    this._autoSellHouses(cur);
    if (cur.money >= 0) {
      this.state.phase = 'after_move';
      this.state.pendingTile = null;
      this.addLog(cur.name + ' 变卖房屋后还清债务');
      return;
    }
    this._autoMortgage(cur);
    if (cur.money >= 0) {
      this.state.phase = 'after_move';
      this.state.pendingTile = null;
      this.addLog(cur.name + ' 抵押地产后还清债务');
      return;
    }
    this.bankrupt(cur, creditorId);
    if (this.state.phase === 'gameOver') return;
    if (this.state.phase !== 'auction') this.finishTurn();
  }

  _autoSellHouses(cur) {
    if (cur.money >= 0) return;
    let changed = true;
    while (changed && cur.money < 0) {
      changed = false;
      let best = null;
      for (const t of this.map.tiles) {
        if (t.type !== 'property') continue;
        if (this.state.tileOwners[t.id] !== cur.id) continue;
        const h = this.state.tileHouses[t.id] || 0;
        if (h <= 0) continue;
        if (best == null || h > (this.state.tileHouses[best] || 0)) best = t.id;
      }
      if (best == null) break;
      const refund = Math.floor(getHouseCost(this.map.tiles[best].group) / 2);
      this.state.tileHouses[best] -= 1;
      cur.money += refund;
      this.addLog(cur.name + ' 变卖「' + this.map.tiles[best].name + '」房屋，获得 ¥' + refund);
      changed = true;
    }
  }

  _autoMortgage(cur) {
    if (cur.money >= 0) return;
    for (const t of this.map.tiles) {
      if (cur.money >= 0) break;
      if (t.type !== 'property' && t.type !== 'railroad' && t.type !== 'utility') continue;
      if (this.state.tileOwners[t.id] !== cur.id) continue;
      if (this.state.tileMortgaged[t.id]) continue;
      const amount = Math.floor(getPropertyPrice(t) / 2);
      cur.money += amount;
      this.state.tileMortgaged[t.id] = true;
      this.addLog(cur.name + ' 将「' + t.name + '」抵押给银行，获得 ¥' + amount);
    }
  }

  bankrupt(player, creditorId) {
    player.bankrupt = true;
    const ownedTiles = Object.keys(this.state.tileOwners)
      .filter(tid => this.state.tileOwners[tid] === player.id)
      .map(Number);
    const cash = Math.max(0, player.money);
    player.money = 0;

    const creditor = creditorId ? this.state.players.find(p => p.id === creditorId) : null;
    if (creditor) {
      creditor.money += cash;
      ownedTiles.forEach(tid => { this.state.tileOwners[tid] = creditor.id; });
      this.addLog(player.name + ' 宣告破产，资产全部归 ' + creditor.name);
    } else {
      ownedTiles.forEach(tid => {
        delete this.state.tileOwners[tid];
        this.state.tileHouses[tid] = 0;
        this.state.tileMortgaged[tid] = false;
      });
      this.addLog(this.state.auctionOnClose === false
        ? player.name + ' 宣告破产，地产被银行收回（房规：关闭拍卖）'
        : player.name + ' 宣告破产，地产由银行拍卖');
    }

    this.checkWinner();
    if (this.state.phase === 'gameOver') return;

    if (!creditor && ownedTiles.length > 0 && this.state.auctionOnClose !== false) {
      this.state.auctionQueue = ownedTiles;
      this._startNextAuction();
    }
  }

  _startNextAuction() {
    if (!this.state.auctionQueue || this.state.auctionQueue.length === 0) return;
    const tileId = this.state.auctionQueue.shift();
    this.state.auction = { tileId, currentBid: 0, currentBidder: null, deadline: Date.now() + 15000 };
    this.state.phase = 'auction';
    this.state.pendingTile = null;
    this.addLog('银行拍卖「' + this.map.tiles[tileId].name + '」');
    this.scheduleAuctionEnd();
  }

  // 毛资产（不含贷款），贷款额度按它计算
  _grossAssets(p) {
    let v = p.money || 0;
    for (const t of this.map.tiles) {
      if (this.state.tileOwners[t.id] === p.id) {
        v += getPropertyPrice(t);
        v += (this.state.tileHouses[t.id] || 0) * getHouseCost(t.group || 'brown');
      }
    }
    v += this.stockValue(p);
    return v;
  }

  // 空头市值（做空是负债，按现价计）
  shortValue(player) {
    if (!this.state || !this.state.stocks || !player || !player.shorts) return 0;
    return this.state.stocks.reduce((sum, s) => sum + (player.shorts[s.id] || 0) * s.price, 0);
  }

  // 净资产 = 毛资产 − 贷款 − 空头市值
  _calcAssets(p) {
    return this._grossAssets(p) - (p.loan || 0) - this.shortValue(p);
  }

  // 贷款额度：按【净资产】的 30% 计算（上限 ¥2500，按百元取整）
  // 用净资产而不是毛资产，否则借钱→现金变多→额度跟着涨，可以无限套娃
  loanCap(player) {
    if (!this.state) return 0;
    const net = this._calcAssets(player);
    const raw = Math.floor((Math.max(0, net) * LOAN_ASSET_RATIO) / 100) * 100;
    return Math.max(0, Math.min(raw, LOAN_MAX));
  }

  _loanGuard(playerId) {
    if (!this.state) return { error: '游戏未开始' };
    const cur = this.state.players[this.state.current];
    if (!cur || cur.id !== playerId) return { error: '还没轮到你' };
    if (!['rolling', 'buying', 'after_move'].includes(this.state.phase)) return { error: '只能在自己回合操作贷款' };
    return { cur };
  }

  takeLoan(playerId, amount) {
    const g = this._loanGuard(playerId);
    if (g.error) return g;
    const cur = g.cur;
    const n = Math.floor(Number(amount) || 0);
    if (n < LOAN_MIN) return { error: '单次贷款至少 ¥' + LOAN_MIN };
    const cap = this.loanCap(cur);
    if ((cur.loan || 0) + n > cap) return { error: '超出贷款额度（可借 ¥' + Math.max(0, cap - (cur.loan || 0)) + '）' };
    cur.loan = (cur.loan || 0) + n;
    cur.money += n;
    this.addLog(cur.name + ' 向银行贷款 ¥' + n + '（余额 ¥' + cur.loan + '，每回合利息 ' + Math.round(this.state.loanRate * 100) + '%）');
    this.broadcastState();
    return { ok: true };
  }

  repayLoan(playerId, amount) {
    const g = this._loanGuard(playerId);
    if (g.error) return g;
    const cur = g.cur;
    const owed = cur.loan || 0;
    if (owed <= 0) return { error: '你没有未还贷款' };
    const n = Math.min(Math.floor(Number(amount) || 0), owed);
    if (n < 1) return { error: '还款金额不正确' };
    if (cur.money < n) return { error: '现金不足，无法还款 ¥' + n };
    cur.loan = owed - n;
    cur.money -= n;
    this.addLog(cur.name + ' 还款 ¥' + n + (cur.loan > 0 ? '（剩余 ¥' + cur.loan + '）' : '，贷款已结清'));
    this.broadcastState();
    return { ok: true };
  }

  // 持股总市值
  stockValue(player) {
    if (!this.state || !this.state.stocks || !player || !player.stocks) return 0;
    return this.state.stocks.reduce((sum, s) => sum + (player.stocks[s.id] || 0) * s.price, 0);
  }

  _recordStats() {
    if (!this.state || !this.state.players) return;
    const winner = this.state.winner;
    for (const p of this.state.players) {
      if (!p.userId) continue;
      const assets = this._calcAssets(p);
      // 团队模式下整队记胜
      const won = this.state.winnerTeam ? p.team === this.state.winnerTeam : winner === p.id;
      updateStats(p.userId, { win: won, assets }).catch((e) => console.error('[stats]', e.message));
    }
  }

  checkWinner() {
    const alive = this.state.players.filter(p => !p.bankrupt);
    if (this.state.teamMode) {
      const teams = [...new Set(this.state.players.map(p => p.team || 'A'))];
      const aliveTeams = teams.filter(t => alive.some(p => (p.team || 'A') === t));
      if (aliveTeams.length <= 1) {
        this.state.phase = 'gameOver';
        this.state.winnerTeam = aliveTeams[0] || null;
        const rep = alive.find(p => (p.team || 'A') === this.state.winnerTeam);
        this.state.winner = rep ? rep.id : null;
        this.addLog(this.state.winnerTeam ? (this.state.winnerTeam + ' 队获胜！') : '游戏结束');
        this._recordStats();
      }
      return;
    }
    if (alive.length <= 1) {
      this.state.phase = 'gameOver';
      this.state.winner = alive.length === 1 ? alive[0].id : null;
      this.addLog(alive.length === 1 ? alive[0].name + ' 获胜！' : '游戏结束');
      this._recordStats();
    }
  }

  settleByAssets() {
    const alive = this.state.players.filter(p => !p.bankrupt);
    const assets = alive.map(p => ({ id: p.id, team: p.team || null, value: this._calcAssets(p) }));
    assets.sort((a, b) => b.value - a.value);
    this.state.phase = 'gameOver';
    if (this.state.teamMode) {
      const byTeam = {};
      assets.forEach(a => { const t = a.team || 'A'; byTeam[t] = (byTeam[t] || 0) + a.value; });
      const winnerTeam = Object.keys(byTeam).sort((a, b) => byTeam[b] - byTeam[a])[0];
      this.state.winnerTeam = winnerTeam;
      const rep = alive.find(p => (p.team || 'A') === winnerTeam);
      this.state.winner = rep ? rep.id : null;
      this.addLog('回合结束，' + winnerTeam + ' 队以总资产 ¥' + byTeam[winnerTeam] + ' 获胜！');
      this._recordStats();
      return;
    }
    this.state.winner = assets[0] ? assets[0].id : null;
    if (assets[0]) this.addLog('回合结束，' + this.state.players.find(p => p.id === assets[0].id).name + ' 以总资产 ¥' + assets[0].value + ' 获胜！');
    this._recordStats();
  }

  resetToLobby() {
    if (this._auctionTimer) { clearTimeout(this._auctionTimer); this._auctionTimer = null; }
    if (this._turnTimer) { clearTimeout(this._turnTimer); this._turnTimer = null; }
    if (this._aiTimer) { clearTimeout(this._aiTimer); this._aiTimer = null; }
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
      id: p.id, name: p.name, color: p.color, isHost: p.isHost, isAI: !!p.isAI,
    }));
    this.broadcast(JSON.stringify({
      type: 'player_list', players,
      canStart: this.players.size >= MIN_PLAYERS, started: this.started,
      settings: this.settings,
    }));
  }

  broadcastState() {
    // loanCap 随资产变化，这里按最新资产算好一起发（前端只负责展示）
    if (this.state && this.state.players) {
      this.state.players.forEach((p) => {
        p.loanCap = this.loanCap(p);
        p.shortCap = Math.min(SHORT_MAX_VALUE, Math.max(0, Math.floor(p.money * SHORT_CASH_RATIO - this.shortValue(p))));
      });
    }
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

