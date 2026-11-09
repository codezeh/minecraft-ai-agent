// 独立实现的 source 指纹（语义对齐 release.ps1:419-435，但代码自写）
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const repo = process.argv[2];
const commit = process.argv[3];
const SOURCE_ENTRIES = ['src', 'index.html', 'vite.config.ts', 'tsconfig.json', 'package.json', 'package-lock.json'];

// 列出该 commit 下 web/ 内的文件
const ls = execFileSync('git', ['-C', repo, 'ls-tree', '-r', '--name-only', commit, '--', 'web/'], { encoding: 'utf8' })
  .split('\n').filter(Boolean);
const files = [];
for (const p of ls) {
  const rel = p.slice('web/'.length);
  const inEntry = SOURCE_ENTRIES.some((e) => rel === e || rel.startsWith(e + '/'));
  if (!inEntry) continue;
  const buf = execFileSync('git', ['-C', repo, 'show', `${commit}:${p}`], { maxBuffer: 64 * 1024 * 1024 });
  files.push({ rel, hash: createHash('sha256').update(buf).digest('hex'), crlf: buf.includes('\r\n') });
}
files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
const h = createHash('sha256');
for (const f of files) h.update(`${f.rel}\0${f.hash}\n`);
console.log(JSON.stringify({
  commit, fileCount: files.length,
  sourceHash: 'sha256:' + h.digest('hex'),
  crlfFiles: files.filter((f) => f.crlf).map((f) => f.rel),
}, null, 1));
