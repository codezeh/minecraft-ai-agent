#!/usr/bin/env node
/**
 * 补丁完整性闸（F-DEP-004）
 *
 * 为什么需要：`postinstall = patch-package` 是**npm 完整性校验之后**再往 node_modules 里
 * 写源码的通道 —— 跑起来的代码不是 npm 校验过的那份 tarball。本仓 `patches/` 有 ~14k 行 diff，
 * 在加这道闸之前**没有任何门禁看过它们**（`grep -rln 'patches/' tools/` → 空）。
 *
 * 本脚本只做两件事，都用 node 内置模块（**不新增任何依赖**）：
 *   ① 内容完整性：逐个 patch 算 sha256，与 `patches/SHA256SUMS` 比对 —— 谁改了补丁内容必被发现；
 *   ② 版本漂移：patch 文件名里的版本（`pkg+1.2.3.patch`）必须等于 node_modules 里**实装**版本
 *      —— 这条直接把 F-DEP-003 那类"补丁跟上一次装的版本早已分叉、没人知道"变成硬失败。
 *
 * 用法：
 *   node tools/patch_integrity.mjs                 # 校验（gate 用这个）
 *   node tools/patch_integrity.mjs --write         # 生成/刷新 patches/SHA256SUMS（**改完补丁必须重跑并提交**）
 *   node tools/patch_integrity.mjs --no-version-check   # 只校验内容（node_modules 未安装时降级用）
 *   node tools/patch_integrity.mjs --root <dir>    # 指定仓库根（自测/篡改演示用）
 *
 * 退出码：0 = 全过；1 = 有 FAIL。
 *
 * 注意（接线约定）：本脚本**故意不自己改 gate**。接进 `npm run gate` 由人来做，因为
 * 默认开启的版本漂移检查会在"旧补丁还没删"时把**全队**的 pre-commit 打红 ——
 * 那道红是对的（它就是在报 F-DEP-003），但要按"先修数据、再接判据"的顺序上。
 */

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);

const flag = (name) => argv.includes(name);
const opt = (name, dflt) => {
    const i = argv.indexOf(name);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};

const ROOT = path.resolve(opt('--root', path.join(__dirname, '..')));
const PATCH_DIR = path.join(ROOT, 'patches');
const SUMS = path.join(PATCH_DIR, 'SHA256SUMS');
const WRITE = flag('--write');
const CHECK_VERSIONS = !flag('--no-version-check');

let failed = 0;
const fail = (msg) => { failed++; console.log('  ✗ ' + msg); };
const pass = (msg) => console.log('  ✓ ' + msg);
const skip = (msg) => console.log('  ~ ' + msg);

function sha256(file) {
    return createHash('sha256').update(readFileSync(file)).digest('hex');
}

/** `@scope+name+1.2.3.patch` → { pkg:'@scope/name', version:'1.2.3' }；普通包同理。 */
function parsePatchName(file) {
    const base = file.replace(/\.patch$/, '');
    const parts = base.split('+');
    if (parts.length < 2) return null;
    const version = parts[parts.length - 1];
    const pkg = parts.slice(0, -1).join('/').replace(/^([^/]+)\/(.+)$/u, '@$1/$2');
    return { pkg, version };
}

if (!existsSync(PATCH_DIR)) {
    console.log('patches/ 不存在 —— 本仓没有补丁集，跳过。');
    process.exit(0);
}

const allEntries = readdirSync(PATCH_DIR).sort();
const patches = allEntries.filter((f) => f.endsWith('.patch'));
const disabled = allEntries.filter((f) => f.endsWith('.patch.disabled'));

console.log('补丁完整性检查' + (WRITE ? '（写入基线）' : ''));
console.log(`  补丁目录: ${path.relative(process.cwd(), PATCH_DIR) || '.'}`);

if (patches.length === 0) {
    console.log('  ✗ patches/ 里一个 *.patch 都没有 —— 这不可能是有意的（postinstall 会空跑）');
    process.exit(1);
}

const actual = new Map(patches.map((f) => [f, sha256(path.join(PATCH_DIR, f))]));

// ── ① 内容完整性 ────────────────────────────────────────────────
console.log('[1/2] 内容完整性（sha256 vs patches/SHA256SUMS）');
if (WRITE) {
    const lines = [...actual.entries()].map(([f, h]) => `${h}  ${f}`);
    writeFileSync(SUMS, lines.join('\n') + '\n', 'utf8');
    pass(`已写入 ${path.basename(SUMS)}（${lines.length} 条）—— 记得把补丁与它放同一个 commit`);
} else if (!existsSync(SUMS)) {
    fail(`${path.basename(SUMS)} 不存在 —— 先跑一次 \`node tools/patch_integrity.mjs --write\` 并提交`);
} else {
    const declared = new Map();
    for (const line of readFileSync(SUMS, 'utf8').split(/\r?\n/)) {
        const m = /^([0-9a-f]{64})\s{2}(.+)$/.exec(line.trim());
        if (m) declared.set(m[2], m[1]);
    }
    for (const [f, h] of actual) {
        if (!declared.has(f)) { fail(`${f} 不在 SHA256SUMS 里 —— 新增补丁必须同时写基线`); continue; }
        if (declared.get(f) !== h) {
            fail(`${f} 内容被改动（基线 ${declared.get(f).slice(0, 12)}… 现为 ${h.slice(0, 12)}…）`);
        }
    }
    for (const f of declared.keys()) {
        if (!actual.has(f)) fail(`${f} 在 SHA256SUMS 里但文件已不存在（基线过期，请 --write 刷新并说明为什么删）`);
    }
    if (failed === 0) pass(`${actual.size} 个补丁内容与基线一致`);
}

// ── ② 版本漂移 ──────────────────────────────────────────────────
console.log('[2/2] 版本漂移（文件名里的版本 vs node_modules 实装版本）' + (CHECK_VERSIONS ? '' : '（已跳过）'));
if (!CHECK_VERSIONS) {
    skip('--no-version-check');
} else {
    let checked = 0;
    for (const f of patches) {
        const parsed = parsePatchName(f);
        if (!parsed) { fail(`${f} 名字不是 \`包名+版本.patch\` 的形状，patch-package 无法正确套用`); continue; }
        const pkgJson = path.join(ROOT, 'node_modules', parsed.pkg, 'package.json');
        if (!existsSync(pkgJson)) {
            skip(`${parsed.pkg}: node_modules 未安装（版本检查跳过，文件名声明 ${parsed.version}）`);
            continue;
        }
        let installed;
        try {
            installed = JSON.parse(readFileSync(pkgJson, 'utf8')).version;
        } catch (e) {
            fail(`${parsed.pkg}: 读不了已装 package.json（${e.message}）`);
            continue;
        }
        checked++;
        if (installed !== parsed.version) {
            fail(`${f}：文件名写 ${parsed.version}，实装 ${installed}` +
                ` —— 补丁几乎必然套不上（这就是 F-DEP-003 的形状：postinstall 会在干净安装时失败）`);
        } else {
            pass(`${parsed.pkg}@${installed}`);
        }
    }
    if (checked > 0 && failed === 0) pass(`版本一一对应（${checked} 个包）`);
}

// ── 附带：.patch.disabled 残留（不参与判定，只提醒） ──────────────
if (disabled.length) {
    console.log(`  ~ 另有 ${disabled.length} 个 *.patch.disabled 不参与校验：${disabled.join(', ')}`);
    console.log('    （它们不会被 patch-package 套用；留着就得在 README 写清为什么留，否则就是 F-DEP-004⑤ 那笔债）');
}

if (failed > 0) {
    console.log(`\n✗ patch_integrity 失败：${failed} 处`);
    process.exit(1);
}
console.log('\n✓ patch_integrity 通过');
