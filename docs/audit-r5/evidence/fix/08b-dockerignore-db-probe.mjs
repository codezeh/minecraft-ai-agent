// 复用 tools/dockerignore_coverage_unit.mjs **原文里的**匹配器（从源码切出来，不重写），
// 只是把它指向真实的 .dockerignore 并对新加的 *.db 规则做断言。
import fs from 'node:fs';
import path from 'node:path';

const src = fs.readFileSync(path.join('tools', 'dockerignore_coverage_unit.mjs'), 'utf8');
const start = src.indexOf('const ignoreText =');
const end = src.indexOf("console.log('—— A.");
if (start < 0 || end < 0) { console.error('切取失败'); process.exit(2); }
const block = src.slice(start, end);
const REPO = '.';
const fn = new Function('fs', 'path', 'REPO', block + '\nreturn { isIgnored, rules };');
const { isIgnored, rules } = fn(fs, path, REPO);

console.log('解析到的规则条数 =', rules.length);
const dbRules = rules.filter(r => /\.db$/.test(r.pattern));
console.log('其中 .db 相关规则 =', JSON.stringify(dbRules));
console.log('');
const cases = [
  ['.secrets.db', true,  '凭据保管库（根）'],
  ['services/vault/.secrets.db', true, '凭据库（嵌套目录）'],
  ['data/board.db', true, '任务板库'],
  ['Thumbs.db', true, '编辑器垃圾（原规则）'],
  ['main.js', false, '镜像必需：main.js'],
  ['src/agent/agent.js', false, '镜像必需：src/**'],
  ['src/mindcraft/mindserver.js', false, '镜像必需：mindserver'],
  ['web-dist/index.html', false, '镜像必需：web-dist'],
  ['patches/mineflayer+4.39.0.patch', false, '镜像必需：patches'],
  ['package-lock.json', false, '镜像必需：lock'],
  ['settings.js', false, '镜像必需：settings.js'],
];
let bad = 0;
for (const [p, want, why] of cases) {
  const got = isIgnored(p);
  const ok = got === want;
  if (!ok) bad++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${p.padEnd(38)} ignored=${String(got).padEnd(5)} 期望=${want}  (${why})`);
}
console.log('');
console.log(bad === 0 ? 'ALL PASS：*.db 命中凭据/板库，且未误伤镜像必需路径' : `有 ${bad} 条不符`);
process.exit(bad === 0 ? 0 : 1);
