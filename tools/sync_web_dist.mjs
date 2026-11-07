/**
 * 把 `web/dist`（Vue 控制台的构建输出）同步成 `mindcraft/web-dist`（镜像用的固化产物），
 * 并重写 `MANIFEST.json`（逐文件 sha256，供 `web_dist_manifest_unit` 做漂移检测）。
 *
 * 为什么需要它（2026-11-07 复审 第4条）：
 *   Docker 的构建上下文是 `mindcraft/`，取不到仓库根的 `../web`。所以 UI 产物必须固化
 *   在 `mindcraft/web-dist/` 并**纳入版本控制**，否则干净克隆里 `docker build` 会在
 *   `COPY web-dist` 那步失败（之前正是这个状态：产物只在开发者本地、未被 git 跟踪）。
 *
 * 用法（改过 `web/` 之后必须跑）：
 *     cd web && npm ci && npm run build
 *     node ../mindcraft/tools/sync_web_dist.mjs            # 同步 + 重写清单
 *     node ../mindcraft/tools/sync_web_dist.mjs --check    # 只检查是否一致（CI 用）
 *
 * 只读写 `web/dist` 与 `mindcraft/web-dist`，不碰源码。
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdirSync, rmSync, copyFileSync } from 'fs';
import { createHash } from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..');                 // mindcraft/
const DEST = path.join(REPO, 'web-dist');
const SRC = path.join(REPO, '..', 'web', 'dist');   // 仓库根的 web/dist
const MANIFEST = path.join(DEST, 'MANIFEST.json');
const CHECK_ONLY = process.argv.includes('--check');

const sha256 = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');

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

const SKIP = new Set(['MANIFEST.json', 'README.md']);   // 产物目录自己的说明文件

// ── --check：只比对 src/dist 与已固化的 web-dist 是否一致 ──
if (CHECK_ONLY) {
    if (!existsSync(SRC)) {
        console.error(`[sync] 找不到 ${SRC}（先 cd web && npm run build）`);
        process.exit(2);
    }
    let diff = 0;
    const srcFiles = walk(SRC).sort();
    for (const rel of srcFiles) {
        const a = path.join(SRC, rel);
        const b = path.join(DEST, rel);
        if (!existsSync(b)) { console.log(`MISSING  ${rel}`); diff++; continue; }
        if (sha256(a) !== sha256(b)) { console.log(`DIFFERS  ${rel}`); diff++; }
    }
    const destFiles = walk(DEST).filter((f) => !SKIP.has(f)).sort();
    for (const rel of destFiles) {
        if (!srcFiles.includes(rel)) { console.log(`EXTRA    ${rel}`); diff++; }
    }
    console.log(diff === 0 ? '[sync] 一致' : `[sync] 有 ${diff} 处差异：请运行不带 --check 的同步`);
    process.exit(diff === 0 ? 0 : 1);
}

// ── 同步 ──
if (!existsSync(SRC)) {
    console.error(`[sync] 找不到 ${SRC}（先 cd web && npm run build）`);
    process.exit(2);
}

// 保留 README.md（说明文件，不是产物）
const keepReadme = path.join(DEST, 'README.md');
const readme = existsSync(keepReadme) ? readFileSync(keepReadme) : null;

if (existsSync(DEST)) rmSync(DEST, { recursive: true, force: true });
mkdirSync(DEST, { recursive: true });

const files = {};
for (const rel of walk(SRC)) {
    const from = path.join(SRC, rel);
    const to = path.join(DEST, rel);
    mkdirSync(path.dirname(to), { recursive: true });
    copyFileSync(from, to);
    files[rel] = sha256(to);
}

if (readme) writeFileSync(keepReadme, readme);

const manifest = {
    generatedFrom: 'web/dist (Vue3 + Vite console)',
    note: '镜像用的固化产物。改过 web/ 之后必须重新生成；本清单供 web_dist_manifest_unit 做漂移检测。',
    files,
};
writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + '\n');

console.log(`[sync] 已同步 ${Object.keys(files).length} 个文件到 ${DEST}`);
console.log(`[sync] MANIFEST.json 已重写`);
console.log('[sync] 记得 git add web-dist');
