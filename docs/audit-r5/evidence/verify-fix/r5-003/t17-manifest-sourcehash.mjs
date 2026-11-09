/**
 * t17 独立复算 —— 按**工作树磁盘字节**计算 web/ 源码指纹，用于核对
 * mindcraft/web-dist/MANIFEST.json 里的 source.hash 是不是"自己算出来的真值"，
 * 而不是"被改小了/写死了一个好看的数字"。
 *
 * 语义对齐 scripts/release.ps1 的 SOURCE_ENTRIES（同一组输入、同一拼接格式），
 * 但实现是独立写的：自己遍历、自己 sha256、自己拼 `${rel}\0${hash}\n`。
 *
 * 用法：node t17-manifest-sourcehash.mjs [仓库根]
 * 退出码：0 = 与 MANIFEST 一致；1 = 不一致（打印两边的值）。
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = process.argv[2] || 'E:/我的世界ai';
const WEB = path.join(ROOT, 'web');
const MANIFEST = path.join(ROOT, 'mindcraft/web-dist/MANIFEST.json');

// 与 release.ps1:419 相同的输入集合
const SOURCE_ENTRIES = ['src', 'index.html', 'vite.config.ts', 'tsconfig.json', 'package.json', 'package-lock.json'];

const sha256File = (abs) => createHash('sha256').update(readFileSync(abs)).digest('hex');

const files = [];
const walk = (abs, rel) => {
    const st = statSync(abs);
    if (st.isDirectory()) {
        for (const n of readdirSync(abs).sort()) walk(path.join(abs, n), `${rel}/${n}`);
    } else {
        files.push({ rel, hash: sha256File(abs), crlf: readFileSync(abs).includes(0x0d) });
    }
};
for (const e of SOURCE_ENTRIES) {
    const abs = path.join(WEB, e);
    if (!existsSync(abs)) { console.error('缺少源码输入: web/' + e); process.exit(2); }
    walk(abs, e);
}
files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));

const h = createHash('sha256');
for (const f of files) h.update(`${f.rel}\0${f.hash}\n`);
const computed = 'sha256:' + h.digest('hex');

const man = JSON.parse(readFileSync(MANIFEST, 'utf8'));
const recorded = man.source?.hash;
const recordedFiles = man.source?.files;

console.log('--- 独立复算（工作树磁盘字节）---');
console.log('输入文件数     :', files.length, '（MANIFEST 记', recordedFiles, '）');
console.log('含 CR 的文件   :', files.filter((f) => f.crlf).map((f) => f.rel).join(', ') || '(无)');
console.log('我算出的指纹   :', computed);
console.log('MANIFEST 记录  :', recorded);
console.log('产物文件数     :', Object.keys(man.files || {}).length);

const ok = computed === recorded && files.length === recordedFiles;
console.log(ok ? '\nEQUAL = true  （清单里的 source.hash 确实是这份源码算出来的）'
               : '\nEQUAL = false （清单与源码不一致！）');
process.exit(ok ? 0 : 1);
