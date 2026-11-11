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
 *     node ../mindcraft/tools/sync_web_dist.mjs            # 只同步产物文件
 *     node ../mindcraft/tools/sync_web_dist.mjs --check    # 只检查是否一致（CI 用）
 *
 * ★ R6 #50（2026-11-11）：**本工具不再写 `MANIFEST.json`**。
 *
 *   原来有两个写者、口径不同：本工具把清单重写成 `{generatedFrom, note, files}`，
 *   而 `scripts/release.ps1` 还会写 `schemaVersion/source.hash/artifact.hash/entryAssets/generatedAt`。
 *   于是按本文件头部的说明（"改过 web/ 之后必须跑"）单独执行一次，就会把发布元数据**抹掉**，
 *   此后 `release.ps1 -VerifyOnly` 直接红（"清单是旧格式"）——一条**合规**的同步命令
 *   能静默删掉漂移检测的绑定。
 *
 *   选定的修法：**单一写者 = scripts/release.ps1**（而不是"两边共用一个生成器"）。
 *   理由：
 *     1. 元数据里的 `source.hash` 必须由"构建源码树"算出来（-SourceRoot 时可以指向另一棵树），
 *        而本工具只看得见 `web/dist`，本来就缺这个输入 —— 让它写就等于让它猜；
 *     2. 清单要与 `release.ps1 -VerifyOnly` 的校验口径**同一处**实现，否则两边永远会漂；
 *     3. 本工具剩下的职责（拷文件、--check 比对）与清单无关，可以彻底解耦。
 *   所以：本工具只负责**产物**；它现在还会在清理目标目录时**保留**已有的 MANIFEST.json，
 *   避免"同步一次 = 清单消失"。
 *
 * 环境变量（仅供 scripts/tests/ops-regression.mjs 用夹具目录跑真身）：
 *     SYNC_WEB_DIST_SRC / SYNC_WEB_DIST_DEST —— 覆盖源/目标目录，默认是仓库里的那两个。
 *
 * 只读写 `web/dist` 与 `mindcraft/web-dist`，不碰源码。
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdirSync, rmSync, copyFileSync } from 'fs';
import { createHash } from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..');                 // mindcraft/
// 环境变量覆盖只服务于回归门禁（用临时夹具目录跑真身）；生产路径不变。
const DEST = process.env.SYNC_WEB_DIST_DEST
    ? path.resolve(process.env.SYNC_WEB_DIST_DEST)
    : path.join(REPO, 'web-dist');
const SRC = process.env.SYNC_WEB_DIST_SRC
    ? path.resolve(process.env.SYNC_WEB_DIST_SRC)
    : path.join(REPO, '..', 'web', 'dist');   // 仓库根的 web/dist
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

// 保留"不是产物"的两个文件：README.md（说明）与 MANIFEST.json（**发布元数据，归 release.ps1 写**）。
// ★ R6 #50：以前这里只 preserve README，然后 rmSync 整个目录并重写 MANIFEST —— 清单一消失，
//   release.ps1 的 source.hash/artifact.hash/generatedAt 就跟着被抹掉。
const keepNames = ['README.md', 'MANIFEST.json'];
const kept = {};
for (const name of keepNames) {
    const abs = path.join(DEST, name);
    if (existsSync(abs)) kept[name] = readFileSync(abs);
}
const hadManifest = Boolean(kept['MANIFEST.json']);

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

for (const name of keepNames) {
    if (kept[name]) writeFileSync(path.join(DEST, name), kept[name]);
}

console.log(`[sync] 已同步 ${Object.keys(files).length} 个文件到 ${DEST}`);
if (hadManifest) {
    console.log('[sync] 已保留原 MANIFEST.json（本工具不写清单：唯一写者是 scripts/release.ps1）');
} else {
    console.log('[sync] 目标目录里没有 MANIFEST.json —— 需要清单时请在仓库根跑 scripts/release.ps1');
}
console.log('[sync] 记得 git add web-dist');
