// ============================================================
// Supabase（REST）账号存储：注册 / 登录 / 会话
// 凭据通过环境变量注入：SUPABASE_URL、SUPABASE_KEY
// ============================================================
import crypto from 'crypto';
import { promisify } from 'util';

const scryptAsync = promisify(crypto.scrypt);
const SESSION_TTL_DAYS = 30;

const SB_URL = process.env.SUPABASE_URL || '';
const SB_KEY = process.env.SUPABASE_KEY || '';

export function dbReady() { return !!(SB_URL && SB_KEY); }

function headers(extra = {}) {
  return Object.assign({
    apikey: SB_KEY,
    Authorization: 'Bearer ' + SB_KEY,
    'Content-Type': 'application/json',
  }, extra || {});
}

async function sb(path, options = {}) {
  const res = await fetch(SB_URL + path, Object.assign({}, options, { headers: headers(options.headers) }));
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { ok: res.ok, status: res.status, data, headers: res.headers };
}

// 异步哈希：scryptSync 会阻塞事件循环（并发登录时整服卡住），这里改成异步
export async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = await scryptAsync(String(password), salt, 64);
  return salt + ':' + hash.toString('hex');
}

export async function verifyPassword(password, stored) {
  const parts = String(stored || '').split(':');
  if (parts.length !== 2) return false;
  const [salt, hash] = parts;
  try {
    const test = await scryptAsync(String(password), salt, 64);
    const a = Buffer.from(hash, 'hex');
    return a.length === test.length && crypto.timingSafeEqual(a, test);
  } catch { return false; }
}

export async function findUserByUsername(username) {
  const r = await sb('/rest/v1/users?username=eq.' + encodeURIComponent(username) + '&select=*');
  if (!r.ok) return null;
  return (r.data && r.data[0]) || null;
}

export async function createUser(username, password, nickname) {
  const r = await sb('/rest/v1/users', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify([{ username, password_hash: await hashPassword(password), nickname }]),
  });
  if (!r.ok) return { error: '注册失败（用户名可能已存在）' };
  return { user: r.data && r.data[0] };
}

export async function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const r = await sb('/rest/v1/sessions', {
    method: 'POST',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify([{ token, user_id: userId }]),
  });
  if (!r.ok) return { error: '会话创建失败' };
  return { token };
}

export function sessionCutoff() {
  return new Date(Date.now() - SESSION_TTL_DAYS * 24 * 3600 * 1000).toISOString();
}

export async function findSession(token) {
  if (!token) return null;
  const r = await sb('/rest/v1/sessions?token=eq.' + encodeURIComponent(token)
    + '&created_at=gte.' + encodeURIComponent(sessionCutoff())
    + '&select=user_id,users(id,username,nickname)');
  if (!r.ok) return null;
  const row = (r.data && r.data[0]) || null;
  return row ? row.users : null;
}

// 定期清理过期会话（由服务端定时调用）
export async function pruneSessions() {
  const r = await sb('/rest/v1/sessions?created_at=lt.' + encodeURIComponent(sessionCutoff()), { method: 'DELETE' });
  return r.ok;
}

export async function deleteSession(token) {
  if (!token) return;
  await sb('/rest/v1/sessions?token=eq.' + encodeURIComponent(token), { method: 'DELETE' });
}
export async function getStats(userId) {
  if (!userId) return null;
  const r = await sb('/rest/v1/stats?user_id=eq.' + encodeURIComponent(userId) + '&select=*');
  return (r.data && r.data[0]) || { wins: 0, losses: 0, games: 0, max_assets: 0 };
}

async function getStatsRow(userId) {
  const r = await sb('/rest/v1/stats?user_id=eq.' + encodeURIComponent(userId) + '&select=*');
  return (r.data && r.data[0]) || null;
}

// 乐观锁：先读（含 updated_at），再用 updated_at 作条件写；被并发改过则重试
// 排行榜（默认前 20）：按胜场、最高资产排序
export async function getLeaderboard(limit = 20) {
  // games>0：只统计真正打过完整对局的账号（AI 玩家没有 userId，本来就不会进榜）
  const r = await sb('/rest/v1/stats?select=user_id,wins,losses,games,max_assets,users(username,nickname)'
    + '&games=gt.0&order=wins.desc,max_assets.desc&limit=' + Math.max(1, Math.min(50, Number(limit) || 20)));
  if (!r.ok || !Array.isArray(r.data)) return [];
  return r.data.map((row, i) => ({
    rank: i + 1,
    userId: row.user_id,
    nickname: (row.users && (row.users.nickname || row.users.username)) || '玩家',
    wins: row.wins || 0,
    losses: row.losses || 0,
    games: row.games || 0,
    maxAssets: row.max_assets || 0,
  }));
}

function countFromRange(headers) {
  const range = headers && headers.get ? headers.get('content-range') : '';
  const total = Number(String(range || '').split('/')[1]);
  return Number.isFinite(total) ? total : null;
}

// 排名 = 胜场比自己多的人数 + 1
export async function getRank(wins) {
  const r = await sb('/rest/v1/stats?select=user_id&wins=gt.' + Number(wins || 0), { headers: { Prefer: 'count=exact', Range: '0-0' } });
  const higher = countFromRange(r.headers);
  return higher == null ? null : higher + 1;
}

// 参与排行的总人数
export async function getPlayerCount() {
  const r = await sb('/rest/v1/stats?select=user_id&games=gt.0', { headers: { Prefer: 'count=exact', Range: '0-0' } });
  return countFromRange(r.headers);
}

export async function updateStats(userId, { win, assets }) {
  if (!userId) return false;
  for (let attempt = 0; attempt < 3; attempt++) {
    const cur = (await getStatsRow(userId)) || { wins: 0, losses: 0, games: 0, max_assets: 0, updated_at: null };
    const row = {
      wins: (cur.wins || 0) + (win ? 1 : 0),
      losses: (cur.losses || 0) + (win ? 0 : 1),
      games: (cur.games || 0) + 1,
      max_assets: Math.max(cur.max_assets || 0, Math.floor(assets || 0)),
      updated_at: new Date().toISOString(),
    };
    if (cur.updated_at) {
      const r = await sb('/rest/v1/stats?user_id=eq.' + encodeURIComponent(userId)
        + '&updated_at=eq.' + encodeURIComponent(cur.updated_at),
        { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify(row) });
      if (r.ok && Array.isArray(r.data) && r.data.length > 0) return true;
      if (r.ok && Array.isArray(r.data) && r.data.length === 0) continue;   // 并发冲突 → 重读重试
      if (!r.ok) return false;
    } else {
      const r = await sb('/rest/v1/stats', {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify([Object.assign({ user_id: userId }, row)]),
      });
      return r.ok;
    }
  }
  return false;
}
