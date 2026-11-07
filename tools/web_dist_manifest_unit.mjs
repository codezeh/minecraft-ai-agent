/**
 * 控制台 UI 固化产物一致性 —— `mindcraft/web-dist/` 必须与它自己的清单一致。
 *
 * 为什么有这条（2026-11-07 复审 第4条）：
 *   Docker 的构建上下文是 `mindcraft/`，取不到仓库根的 `../web`；而把上下文改成仓库根会让
 *   `dockerignore_coverage_unit`（按 mindcraft 相对路径断言 COPY 源存在）全部变红。
 *   因此 UI 产物必须**固化在 mindcraft 内并纳入版本控制** —— 否则干净克隆
 *   （CI / 新机器）里没有 `web-dist/`，`docker build` 会在 `COPY web-dist` 那步直接失败。
 *
 * 这条门禁防的是另一半风险：**产物与源码漂移**。
 *   · 有人改了 `web/` 却忘了重新生成 → 镜像里的控制台是旧的；
 *   · 有人手改了 `web-dist/` 里的文件 → 与 `web/` 记载的构建结果不一致。
 *
 * 判据：`web-dist/MANIFEST.json` 记录了生成时每个文件的 sha256；这里逐条复核。
 *
 * 重新生成（改过 `web/` 之后**必须**跑）：
 *     cd web && npm ci && npm run build
 *     node ../mindcraft/tools/sync_web_dist.mjs          # 同步 + 重写 MANIFEST.json
 *
 * 输出：PASS/FAIL，全过退出码 0。
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'fs';
import { createHash } from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..');
const DIST = path.join(REPO, 'web-dist');
const MANIFEST = path.join(DIST, 'MANIFEST.json');

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
    if (cond) { pass++; console.log(`PASS ${name} ${detail}`); }
    else { fail++; console.log(`FAIL ${name} ${detail}`); }
};

// ── 1. 目录与清单必须存在（缺失 = 干净克隆里 docker build 必失败） ──
check('web-dist/ 存在（干净克隆可构建的前提）', existsSync(DIST), DIST);
check('web-dist/index.html 存在（面板入口）', existsSync(path.join(DIST, 'index.html')),
    path.join(DIST, 'index.html'));
check('web-dist/MANIFEST.json 存在（漂移检测的依据）', existsSync(MANIFEST), MANIFEST);

if (!existsSync(MANIFEST)) {
    console.log(`\nHAS FAILURES: ${pass} passed, ${fail} failed`);
    process.exit(1);
}

const manifest = JSON.parse(readFileSync(MANIFEST, 'utf-8'));
check('MANIFEST 有 files 字段', !!manifest.files && typeof manifest.files === 'object',
    `keys=${Object.keys(manifest || {}).join(',')}`);

// ── 2. 逐文件核对 sha256（防手改 / 防漏更新） ──
const sha256 = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');

let mismatch = [];
let missing = [];
for (const [rel, want] of Object.entries(manifest.files || {})) {
    const abs = path.join(DIST, rel);
    if (!existsSync(abs)) { missing.push(rel); continue; }
    const got = sha256(abs);
    if (got !== want) mismatch.push(`${rel}（期望 ${String(want).slice(0, 12)}，实际 ${got.slice(0, 12)}）`);
}
check('产物里没有缺失文件', missing.length === 0, missing.length ? `缺失: ${missing.join(', ')}` : '');
check('产物内容与 MANIFEST 完全一致（防止手改/漏更新）', mismatch.length === 0,
    mismatch.length ? `不一致: ${mismatch.join('; ')}` : `${Object.keys(manifest.files || {}).length} 个文件全对`);

// ── 3. 反向：目录里不许有 MANIFEST 未记录的"野文件" ──
const walk = (dir, base = '') => {
    const out = [];
    for (const name of readdirSync(dir)) {
        const abs = path.join(dir, name);
        const rel = base ? `${base}/${name}` : name;
        if (statSync(abs).isDirectory()) out.push(...walk(abs, rel));
        else out.push(rel);
    }
    return out;
};
const actual = walk(DIST).filter((f) => f !== 'MANIFEST.json' && f !== 'README.md').sort();
const expected = Object.keys(manifest.files || {}).sort();
const extra = actual.filter((f) => !expected.includes(f));
check('产物目录没有 MANIFEST 未记录的野文件', extra.length === 0,
    extra.length ? `多余: ${extra.join(', ')}` : '');

// ── 4. 关键内容自检：新构建的 index-*.js 必须在（避免把空壳提交进去） ──
const jsFiles = (manifest.files ? Object.keys(manifest.files) : []).filter((f) => /^assets\/.*\.js$/.test(f));
check('产物里至少有 1 个 assets/*.js（不是空壳）', jsFiles.length >= 1, `count=${jsFiles.length}`);
const hasIndexEntry = (manifest.files ? Object.keys(manifest.files) : []).some((f) => f === 'index.html');
check('index.html 已纳入清单', hasIndexEntry, '');

console.log(`\n${fail === 0 ? 'ALL PASS' : 'HAS FAILURES'}: ${pass} passed, ${fail} failed`);
if (fail !== 0) {
    console.log('\n提示：改过 web/ 之后必须重新生成产物：');
    console.log('  cd web && npm ci && npm run build');
    console.log('  node ../mindcraft/tools/sync_web_dist.mjs');
}
process.exit(fail === 0 ? 0 : 1);
