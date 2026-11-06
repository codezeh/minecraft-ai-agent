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
// ★ D2（review-patch-integrity.md）：`--write` 必须显式解锁，否则就是"篡改完顺手重建基线"的洗白通道。
// 解锁方式只有环境变量（不给命令行开关，避免有人把 --write 习惯性塞进脚本/门禁）：
//   PATCH_INTEGRITY_ALLOW_WRITE=1 node tools/patch_integrity.mjs --write
const WRITE_REQUESTED = flag('--write');
const WRITE = WRITE_REQUESTED && process.env.PATCH_INTEGRITY_ALLOW_WRITE === '1';
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

if (WRITE_REQUESTED && !WRITE) {
    console.log('✗ 拒绝 --write：需要先设 PATCH_INTEGRITY_ALLOW_WRITE=1 才允许重建基线。');
    console.log('  为什么：否则"篡改补丁 → 顺手 --write 重建基线"就能把闸变成橡皮图章（review-patch-integrity.md D2）。');
    console.log('  合法用法：改完补丁后单独一次 `PATCH_INTEGRITY_ALLOW_WRITE=1 node tools/patch_integrity.mjs --write`，');
    console.log('           并把 patches/ 与 SHA256SUMS 放进**同一个 commit**（评审才看得见基线为什么变）。');
    process.exit(1);
}

// ★ D3（review-patch-integrity.md）：`patches/` 缺失**不能静默放行**。
// 最省力的攻击不是"植入补丁"，而是"把 patches/ 整个删掉"——那样闸不报错、postinstall 空跑、
// 5 个安全/兼容补丁全部消失而没人发现。所以：缺目录 = FAIL（确实想没有补丁的仓库请显式 --allow-no-patches）。
if (!existsSync(PATCH_DIR)) {
    if (flag('--allow-no-patches')) {
        console.log('  ~ patches/ 不存在，且已显式 --allow-no-patches ⇒ 跳过');
        process.exit(0);
    }
    console.log('✗ patches/ 目录不存在，但本仓的 postinstall 依赖它（patch-package）。');
    console.log('  这可能是"有人把补丁集整个删了"——那会让 5 个补丁静默消失（见 review-patch-integrity.md D3）。');
    console.log('  若这个仓库确实不需要补丁，请显式传 --allow-no-patches。');
    process.exit(1);
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
console.log('[1/3] 内容完整性（sha256 vs patches/SHA256SUMS）');
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
console.log('[2/3] 版本漂移（文件名里的版本 vs node_modules 实装版本）' + (CHECK_VERSIONS ? '' : '（已跳过）'));
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

// ── ③ 补丁哨兵：补丁**真的落到 node_modules 了吗**（R3-5）─────────────
//
// 为什么需要（终审实测）：① 比的是补丁文件的哈希、② 比的是"文件名版本 vs 实装版本"，
// 两者都**不证明补丁被套用过**。实测反例：`F-DEP-003` 的补丁已换成 4.39.0、版本号也对得上，
// 但本机 node_modules 从没重装 ⇒ `grep -c incorrect_for_wooden_tool` = 0，而本工具**报绿**。
// 这是"写了检查，但检查的不是那个东西"的变体病。所以补一条：**补丁引入的符号必须在实装文件里出现**。
//
// 每个补丁登记 1~2 个"只有打了补丁才会存在"的字符串（哨兵）。宁少勿滥：只登记确定性的。
console.log('[3/3] 补丁哨兵（补丁是否真的落到 node_modules）' + (CHECK_VERSIONS ? '' : '（仍会检查：与版本开关无关）'));
const SENTINELS = {
    'mineflayer+4.39.0.patch': [
        ['node_modules/mineflayer/lib/plugins/digging.js', 'incorrect_for_wooden_tool'],   // hunk 1
        ['node_modules/mineflayer/lib/plugins/place_block.js', 'timeout: 500,'],           // hunk 3
    ],
    'mineflayer-pathfinder+2.4.5.patch': [
        ['node_modules/mineflayer-pathfinder/lib/movements.js', 'updateLavaAvoidance'],
    ],
    'mineflayer-pvp+1.3.2.patch': [
        ['node_modules/mineflayer-pvp/lib/PVP.js', 'physicsTick'],
    ],
    'prismarine-viewer+1.33.0.patch': [
        ['node_modules/prismarine-viewer/viewer/lib/entity/Entity.js', 'if (!e) return; //throw new Error'],
    ],
    'protodef+1.19.0.patch': [
        ['node_modules/protodef/src/serializer.js', "// console.log('Chunk size is"],
    ],
};
{
    let probed = 0, unregistered = [];
    for (const f of patches) {
        const list = SENTINELS[f];
        if (!list) { unregistered.push(f); continue; }
        let anyFilePresent = false;
        for (const [rel, needle] of list) {
            const abs = path.join(ROOT, rel);
            if (!existsSync(abs)) continue;          // node_modules 没装 ⇒ 这一段没有可判的实体
            anyFilePresent = true;
            probed++;
            const src = readFileSync(abs, 'utf8');
            if (!src.includes(needle)) {
                fail(`${f} 的哨兵不在 ${rel} 里（缺 \`${needle}\`）—— ` +
                     `补丁**没有落到 node_modules**（跑一次 \`npm ci\` 才会生效）。` +
                     `注意：这不是"补丁写错了"，是"没装"。`);
            }
        }
        if (!anyFilePresent) skip(`${f}: node_modules 未安装，哨兵跳过`);
    }
    if (probed > 0 && failed === 0) pass(`${probed} 个哨兵全部命中（补丁确实落到 node_modules）`);
    if (unregistered.length) skip(`未登记哨兵的补丁：${unregistered.join(', ')}（新增补丁请顺手登记，否则这道检查对它是空的）`);
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
