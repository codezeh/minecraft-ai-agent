/**
 * R5-007（2026-11-08）—— **缺 `patches/` 不许静默跳过**。
 *
 * 缺陷原貌：仓库里没有 `patches/` 时，`npm ci` 仍然 **EXIT 0**，
 * `postinstall` 里的 patch-package 只打印一句 `No patch files found` 就跳过全部补丁
 * （其中 `mineflayer+4.39.0.patch` 是 BUG-001 的修复前提之一）。
 * 结果：装出来的 `node_modules` **看起来正常、跑起来行为不对**，而且没有任何红灯。
 *
 * 本脚本是 `postinstall` 的第二道闸：patch-package 跑完立刻校验"补丁**真的存在**"。
 * 缺目录 / 目录空 / 补丁文件是空的 / 补丁不像补丁 → **exit 1** 并喊出后果。
 *
 * 为什么不顺便校验"补丁是否已套用到 node_modules"：那是 `tools/patch_integrity.mjs` 的活
 * （它比对内容哈希 + 版本对应 + 6 个哨兵）。这里只管**源头**是否还在，
 * 两件事分开，谁红了就指向谁，不用在一个脚本里猜。
 *
 * 用法：
 *   node tools/verify_patches.mjs            # 校验脚本所在仓库（postinstall 用这一条）
 *   node tools/verify_patches.mjs --quiet    # 成功时不打印（给 npm 输出减噪）
 *
 * 退出码：0 = 补丁目录健康；1 = 缺失/空/不像补丁（**这会让安装失败，是有意的**）。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join, basename } from 'path';

const HERE = dirname(fileURLToPath(import.meta.url));
/** 仓库根 = 本脚本所在 `tools/` 的上一级。这样把脚本拷进假项目里测也照样工作。 */
const ROOT = dirname(HERE);
const PATCH_DIR = join(ROOT, 'patches');
const QUIET = process.argv.includes('--quiet');

const FAIL_MSG =
    '缺少 patches/ ⇒ mineflayer 行为补丁未应用（BUG-001 会复发）';

function die(reason, detail = '') {
    console.error('');
    console.error('✗ verify_patches 失败：' + reason);
    if (detail) console.error('  ' + detail);
    console.error('  ' + FAIL_MSG);
    console.error('  修复：确认 patches/ 与 *.patch 已随仓库检出（它们本该被 git 跟踪）；');
    console.error('        然后 npm run reinstall 重新套补丁，并跑 node tools/patch_integrity.mjs 复验。');
    console.error('');
    process.exit(1);
}

// ① 目录必须存在
if (!existsSync(PATCH_DIR)) {
    die('仓库里没有 patches/ 目录', 'path=' + PATCH_DIR);
}
if (!statSync(PATCH_DIR).isDirectory()) {
    die('patches 不是目录', 'path=' + PATCH_DIR);
}

// ② 必须至少有一个 .patch（.patch.disabled 不算：patch-package 不会套用它）
const all = readdirSync(PATCH_DIR);
const patches = all.filter(f => f.endsWith('.patch'));
if (patches.length === 0) {
    die('patches/ 里没有任何 .patch 文件',
        '目录内容=[' + all.join(', ') + ']' +
        (all.some(f => f.endsWith('.patch.disabled')) ? '（只有 .patch.disabled，不会被套用）' : ''));
}

// ③ 每个补丁必须非空、且看起来是 diff（有 --- / +++ 头）。
//    防的是"占位空文件"这种更隐蔽的静默跳过。
const bad = [];
for (const f of patches) {
    const full = join(PATCH_DIR, f);
    let text = '';
    try {
        const st = statSync(full);
        if (!st.isFile() || st.size === 0) { bad.push([f, '空文件或不是普通文件']); continue; }
        text = readFileSync(full, 'utf8');
    } catch (e) {
        bad.push([f, '读不了：' + e.message]);
        continue;
    }
    const hasHunkHead = /^---\s+\S+/m.test(text) && /^\+\+\+\s+\S+/m.test(text);
    if (!hasHunkHead) bad.push([f, '不像补丁（缺 ---/+++ 文件头）']);
}
if (bad.length) {
    die(`${bad.length} 个补丁不可用：` + bad.map(([f, why]) => `${f}（${why}）`).join('；'));
}

// ④ 全绿：给一行可读的确认（postinstall 输出里能看见"套了几个"）
if (!QUIET) {
    const list = patches.map(f => {
        const pkg = basename(f).replace(/\.patch$/, '');
        return pkg;
    }).join(', ');
    const disabled = all.filter(f => f.endsWith('.patch.disabled'));
    console.log(`✓ verify_patches 通过：patches/ 有 ${patches.length} 个补丁待套用 —— ${list}`);
    if (disabled.length) {
        console.log(`  ~ 另有 ${disabled.length} 个 *.patch.disabled 不参与套用：${disabled.join(', ')}`);
    }
}
// 源码树完整性提示（不判失败）：patch_integrity 才是套用后的复验
{
    const pi = join(ROOT, 'tools', 'patch_integrity.mjs');
    if (existsSync(pi) && !QUIET) {
        console.log('  套用后的深度复验请跑：node tools/patch_integrity.mjs');
    }
}
process.exit(0);
