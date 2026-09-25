// ============================================================
// 清理测试账号（默认试运行，加 --apply 才真正删除）
//   用法：
//     node scripts/cleanup-test-accounts.mjs
//     node scripts/cleanup-test-accounts.mjs --apply
//     node scripts/cleanup-test-accounts.mjs --users=wa639166,wb639166 --apply
// 匹配规则：账号名形如 test/qa/demo/tmp/wa/wb/wc/wd/dg + 4 位以上数字
// ============================================================
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');

function loadEnv() {
  try {
    const text = readFileSync(join(rootDir, '.env'), 'utf8');
    for (const line of text.split(/\r?\n/)) {
      if (!line.includes('=') || line.trim().startsWith('#')) continue;
      const i = line.indexOf('=');
      const k = line.slice(0, i).trim();
      const v = line.slice(i + 1).trim();
      if (!process.env[k]) process.env[k] = v;
    }
  } catch { /* 没有 .env 就用系统环境变量 */ }
}

loadEnv();
const URL_BASE = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_KEY;
if (!URL_BASE || !KEY) {
  console.error('缺少 SUPABASE_URL / SUPABASE_KEY');
  process.exit(1);
}
const H = { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' };

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const usersArg = args.find(a => a.startsWith('--users='));
const explicit = usersArg ? usersArg.slice('--users='.length).split(',').map(s => s.trim()).filter(Boolean) : [];
const DEFAULT_PATTERN = /^(test|qa|demo|tmp|wa|wb|wc|wd|dg)\d{4,}$/i;

async function api(path, options = {}) {
  const res = await fetch(URL_BASE + path, { ...options, headers: { ...H, ...(options.headers || {}) } });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { ok: res.ok, status: res.status, data };
}

async function main() {
  const all = await api('/rest/v1/users?select=id,username,nickname,created_at');
  if (!all.ok) {
    console.error('读取用户失败:', all.status, all.data);
    process.exitCode = 1;
    return;
  }
  const targets = all.data.filter(u => (explicit.length ? explicit.includes(u.username) : DEFAULT_PATTERN.test(u.username)));

  console.log('待处理账号:', targets.length);
  targets.forEach(u => console.log('  -', u.username, '(', u.nickname, ') 注册于', String(u.created_at).slice(0, 16)));

  if (!targets.length) return;
  if (!apply) {
    console.log('\n这是试运行，没有删除任何数据。确认后加 --apply 重跑。');
    return;
  }

  let removed = 0;
  for (const u of targets) {
    const stats = await api('/rest/v1/stats?user_id=eq.' + encodeURIComponent(u.id), { method: 'DELETE' });
    const sessions = await api('/rest/v1/sessions?user_id=eq.' + encodeURIComponent(u.id), { method: 'DELETE' });
    const user = await api('/rest/v1/users?id=eq.' + encodeURIComponent(u.id), { method: 'DELETE' });
    const ok = stats.ok && sessions.ok && user.ok;
    if (ok) removed += 1;
    console.log((ok ? '已删除 ' : '删除失败 ') + u.username + ' [stats ' + stats.status + ' / sessions ' + sessions.status + ' / user ' + user.status + ']');
  }
  console.log('\n完成：成功删除 ' + removed + ' / ' + targets.length + ' 个账号');
}

main().catch((e) => { console.error('执行失败:', e.message); process.exitCode = 1; });
