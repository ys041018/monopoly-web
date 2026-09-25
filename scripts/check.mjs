// 对所有前端/服务端脚本做语法检查（跨平台，不依赖 shell 通配符）
import { readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOTS = ['js', 'server', 'scripts', 'test'];
const files = [];
function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (['.js', '.mjs'].includes(extname(p))) files.push(p);
  }
}
for (const r of ROOTS) {
  try { walk(r); } catch { /* 目录不存在就跳过 */ }
}

let failed = 0;
for (const f of files) {
  try {
    execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
  } catch (e) {
    failed++;
    console.error('语法错误: ' + f + '\n' + (e.stderr ? e.stderr.toString() : e.message));
  }
}
console.log('语法检查: ' + files.length + ' 个文件，失败 ' + failed + ' 个');
process.exit(failed ? 1 : 0);
