// ============================================================
// 身份卡：开局随机分配一个被动能力（前后端共用）
// 效果都做成数值系数，便于在现有逻辑里直接乘算
// ============================================================
export const IDENTITIES = [
  { id: 'tycoon',   name: '地产大亨', icon: '🏙️', desc: '买地 9 折',            effect: 'propertyDiscount' },
  { id: 'banker',   name: '银行家',   icon: '🏦', desc: '存款利息翻倍',          effect: 'interestMult' },
  { id: 'landlord', name: '铁公鸡',   icon: '🐓', desc: '收租 +20%',             effect: 'rentMult' },
  { id: 'gambler',  name: '赌徒',     icon: '🎲', desc: '掷出双数额外 +¥100',    effect: 'doublesBonus' },
  { id: 'engineer', name: '包工头',   icon: '🏗️', desc: '盖房 7 折',             effect: 'houseDiscount' },
  { id: 'broker',   name: '股神',     icon: '📈', desc: '做空额度翻倍',          effect: 'shortCapMult' },
  { id: 'generous', name: '慈善家',   icon: '🎁', desc: '经过起点额外 +¥100',    effect: 'passGoExtra' },
  { id: 'debtor',   name: '老赖',     icon: '💳', desc: '贷款利息减半',          effect: 'loanInterestMult' },
];

export const IDENTITY_MAP = Object.fromEntries(IDENTITIES.map(i => [i.id, i]));

export function getIdentity(id) { return IDENTITY_MAP[id] || null; }

// 洗牌发牌：人多于身份数时允许重复
export function dealIdentities(count) {
  const pool = IDENTITIES.slice();
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = pool[i]; pool[i] = pool[j]; pool[j] = t;
  }
  const out = [];
  for (let i = 0; i < count; i++) out.push(pool[i % pool.length].id);
  return out;
}

// 玩家当前生效的系数
export function identityMods(player) {
  const id = player && player.identity;
  return {
    propertyDiscount: id === 'tycoon' ? 0.9 : 1,
    interestMult: id === 'banker' ? 2 : 1,
    rentMult: id === 'landlord' ? 1.2 : 1,
    houseDiscount: id === 'engineer' ? 0.7 : 1,
    shortCapMult: id === 'broker' ? 2 : 1,
    passGoExtra: id === 'generous' ? 100 : 0,
    loanInterestMult: id === 'debtor' ? 0.5 : 1,
    doublesBonus: id === 'gambler' ? 100 : 0,
  };
}
