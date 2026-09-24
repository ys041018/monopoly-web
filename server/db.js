// ============================================================
// Supabase（REST）账号存储：注册 / 登录 / 会话
// 凭据通过环境变量注入：SUPABASE_URL、SUPABASE_KEY
// ============================================================
import crypto from 'crypto';

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
  return { ok: res.ok, status: res.status, data };
}

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return salt + ':' + hash;
}

export function verifyPassword(password, stored) {
  const parts = String(stored || '').split(':');
  if (parts.length !== 2) return false;
  const [salt, hash] = parts;
  try {
    const test = crypto.scryptSync(String(password), salt, 64).toString('hex');
    return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(test, 'hex'));
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
    body: JSON.stringify([{ username, password_hash: hashPassword(password), nickname }]),
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

export async function findSession(token) {
  if (!token) return null;
  const r = await sb('/rest/v1/sessions?token=eq.' + encodeURIComponent(token) + '&select=user_id,users(id,username,nickname)');
  if (!r.ok) return null;
  const row = (r.data && r.data[0]) || null;
  return row ? row.users : null;
}

export async function deleteSession(token) {
  if (!token) return;
  await sb('/rest/v1/sessions?token=eq.' + encodeURIComponent(token), { method: 'DELETE' });
}