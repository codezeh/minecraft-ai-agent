#!/usr/bin/env node
/**
 * 凭据类**文件名**扫描（大小写无关 + 不受平台 core.ignorecase 影响）
 *
 * 为什么需要（2026-11-06 复核席实测）：
 *   `.gitignore` 的 glob **区分大小写**。`.ENV` 在本机显示"已忽略"，
 *   只是因为 Windows 上 `core.ignorecase=true` 让 ignore 匹配变成不区分大小写 ——
 *   **平台假绿**，换到 Linux/macOS 立刻漏。
 *   而一个文件名的 8 种大小写组合无法用 glob 穷举（`.eNv` 就漏了）。
 *
 * 所以真正的兜底不能靠 .gitignore，必须有一道**运行时扫描**：
 *   拿 `git ls-files`（已跟踪文件）与工作区的未跟踪文件，逐个做**小写化后**的模式匹配。
 *
 * 这查的是"仓库里到底有没有这类文件"，与 .gitignore 写没写对无关 —— 这才是判据本身正确。
 *
 * 用法：
 *   node tools/check_secret_filenames.mjs            # 扫当前仓库
 *   node tools/check_secret_filenames.mjs --root .   # 指定根
 *
 * 退出码：0 = 干净；1 = 发现可疑文件名（阻断 gate）
 */
import { execFileSync } from 'child_process';
import { existsSync, readdirSync, statSync } from 'fs';
import path from 'path';

const argv = process.argv.slice(2);
const rootFlag = argv.indexOf('--root');
const ROOT = rootFlag >= 0 ? argv[rootFlag + 1] : process.cwd();

// 小写化后匹配的模式（`*` = 任意字符）
const PATTERNS = [
    /^\.env(\..*)?$/,                 // .env / .env.local / .ENV / .Env ...
    /^\.?env\.example$/,              // 允许的示例文件（下面单独放行）
    /\.pem$/,
    /\.key$/,
    /\.pfx$/,
    /\.p12$/,
    /\.crt$/,
    /\.jks$/,
    /^id_rsa/,
    /^id_ed25519/,
    /credentials?.*\.json$/,
    /secrets?.*\.json$/,
    /\.token$/,
    /^keys\.json$/,
    /config\.local\.(js|ts|json)$/,
];

// 明确放行的：示例文件（不含真值）
const ALLOW = [
    /^\.env\.example$/,
    /^env\.example$/,
    /\.example$/,
];

const isAllowed = (lower) => ALLOW.some((re) => re.test(lower));
const matches = (lower) => PATTERNS.some((re) => re.test(lower));

function gitLsFiles() {
    try {
        return execFileSync('git', ['ls-files', '-z'], {
            cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
        }).split('\0').filter(Boolean);
    } catch (e) {
        console.error('[check_secret_filenames] git ls-files 失败：' + (e?.message ?? e));
        process.exit(1);
    }
}

/** 递归列工作区文件（跳过 .git / node_modules / 已知大目录），用于抓"还没被跟踪"的 */
function walk(dir, out = [], depth = 0) {
    if (depth > 6) return out;
    let entries;
    try { entries = readdirSync(dir); } catch { return out; }
    for (const name of entries) {
        if (name === '.git' || name === 'node_modules' || name === 'dist' || name === 'build') continue;
        const full = path.join(dir, name);
        let st;
        try { st = statSync(full); } catch { continue; }
        if (st.isDirectory()) walk(full, out, depth + 1);
        else out.push(path.relative(ROOT, full).replace(/\\/g, '/'));
    }
    return out;
}

const tracked = gitLsFiles();
const worktree = walk(ROOT);
const all = [...new Set([...tracked, ...worktree])];

const trackedHits = [];
const worktreeHits = [];

for (const rel of all) {
    const base = path.basename(rel).toLowerCase();
    if (!matches(base)) continue;
    if (isAllowed(base)) continue;
    if (tracked.includes(rel)) trackedHits.push(rel);
    else worktreeHits.push(rel);
}

console.log('凭据类文件名扫描（大小写无关；不依赖 .gitignore 与 core.ignorecase）');
console.log(`  仓库: ${ROOT}`);
console.log(`  已跟踪文件: ${tracked.length} ｜ 工作区文件: ${worktree.length}`);

let failed = false;

if (trackedHits.length) {
    failed = true;
    console.log('');
    console.log(`  ✗ 有 ${trackedHits.length} 个凭据类文件名**已被 git 跟踪**：`);
    for (const f of trackedHits) console.log('      ' + f);
    console.log('    ⇒ 这些文件的内容会进版本历史。归档方式：');
    console.log('      1) 把值搬进环境变量 / 密钥管理器');
    console.log('      2) git rm --cached <file>（保留本地文件）');
    console.log('      3) 确认 .gitignore 已覆盖（含大小写变体）');
}

if (worktreeHits.length) {
    // 未跟踪的只告警不阻断（它们可能还没写完，且不在版本库里）
    console.log('');
    console.log(`  ~ 工作区有 ${worktreeHits.length} 个凭据类文件名（**未被跟踪**，仅提醒）：`);
    for (const f of worktreeHits.slice(0, 10)) console.log('      ' + f);
    if (worktreeHits.length > 10) console.log(`      …另有 ${worktreeHits.length - 10} 个`);
    console.log('    这些不进版本库，属正常运行期文件；确认 .gitignore 覆盖即可。');
}

if (failed) {
    console.log('');
    console.log('✗ check_secret_filenames 失败：有凭据类文件被 git 跟踪。');
    process.exit(1);
}

console.log('');
console.log('✓ check_secret_filenames 通过：没有被跟踪的凭据类文件。');
process.exit(0);
