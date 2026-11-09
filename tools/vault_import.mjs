#!/usr/bin/env node
/**
 * 一次性迁移脚本：`keys.json`（明文）→ 凭据保管库（加密）
 *
 *   cd mindcraft
 *   set MC_VAULT_PASSPHRASE=你的口令        # PowerShell: $env:MC_VAULT_PASSPHRASE='…'
 *   node tools/vault_import.mjs             # 真导入
 *   node tools/vault_import.mjs --dry-run   # 只体检，不写库
 *
 * 三条刻意的设计（别"优化"掉）：
 *   ① **不自动删 keys.json**。删凭据是不可逆操作，要人看过"导入 N 项 + 抽查一条能用"
 *      之后自己删。脚本只打印"请自行删除"。
 *   ② **口令只从环境变量取**，不从命令行参数取：argv 在 `ps` / 任务管理器里对
 *      同机其他进程可见，`--passphrase=xxx` 等于把口令写在公告板上。
 *   ③ **失败不影响已导入的条目**。逐条报告 + 汇总；导入中途某条不合法不会回滚别的
 *      （保管库本来就是 upsert 语义，重跑一次是幂等的）。
 *
 * 幂等：重复跑会把同名条目**重新加密覆盖**（created_at 保留，updated_at 前移），
 * 所以"导入两次"不会产生重复条目，但也不会保底（旧值不在了 —— 这正是"只能替换"）。
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
    init, unlock, isInitialized, isUnlocked, setSecret, listSecrets,
    NAME_PATTERN, MAX_VALUE_BYTES, VAULT_ERROR,
} from '../src/agent/library/secrets_vault.js';

const argv = process.argv.slice(2);
const dryRun = argv.includes('--dry-run');
const keysFlag = argv.indexOf('--keys');
const keysPath = resolve(keysFlag >= 0 && argv[keysFlag + 1] ? argv[keysFlag + 1] : './keys.json');
const updatedBy = 'import(keys.json)';

function die(msg, code = 1) {
    console.error(`✗ ${msg}`);
    process.exit(code);
}

const passphrase = process.env.MC_VAULT_PASSPHRASE;
if (!passphrase) {
    die('缺少 MC_VAULT_PASSPHRASE。\n'
        + '  例（PowerShell）：$env:MC_VAULT_PASSPHRASE = \'你的口令\'; node tools/vault_import.mjs\n'
        + '  例（bash）      ：MC_VAULT_PASSPHRASE=你的口令 node tools/vault_import.mjs\n'
        + '  为什么不收 --passphrase：命令行参数对同机其他进程可见，等于把口令写出去。');
}

if (!existsSync(keysPath)) {
    die(`找不到 ${keysPath}（可用 --keys <路径> 指定）`);
}

let raw;
try {
    raw = JSON.parse(readFileSync(keysPath, 'utf8'));
} catch (e) {
    die(`${keysPath} 不是合法 JSON：${e.message}`);
}
if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    die(`${keysPath} 顶层应当是对象（扁平 {"NAME": "值"}）`);
}

const entries = Object.entries(raw);
if (!entries.length) die(`${keysPath} 里一条都没有`);

// ── 打开保管库（未初始化则顺手初始化）─────────────────────────────────
if (!isInitialized()) {
    if (dryRun) {
        console.log('· 保管库还没初始化（--dry-run 不建库，下面只做校验）');
    } else {
        init(passphrase);
        console.log('· 保管库不存在，已按该口令初始化（salt + verifier 已写入 .secrets.db）');
    }
} else if (!isUnlocked()) {
    try {
        unlock(passphrase);
        console.log('· 保管库已解锁');
    } catch (e) {
        die(e?.code === VAULT_ERROR.BAD_PASSPHRASE
            ? '口令不正确（VAULT_BAD_PASSPHRASE）'
            : `解锁失败：${e?.code ?? e?.message ?? e}`);
    }
}

// ── 逐条导入 ─────────────────────────────────────────────────────────
let imported = 0;
const skipped = [];

for (const [name, value] of entries) {
    if (!NAME_PATTERN.test(name)) {
        skipped.push(`${name}（名字不匹配 ^[A-Z][A-Z0-9_]{2,63}$）`);
        continue;
    }
    if (typeof value !== 'string' || value.length === 0) {
        skipped.push(`${name}（值不是非空字符串）`);
        continue;
    }
    if (value.length > MAX_VALUE_BYTES) {
        skipped.push(`${name}（值超过 ${MAX_VALUE_BYTES} 字符）`);
        continue;
    }
    if (/[\u0000-\u001f\u007f]/.test(value)) {
        skipped.push(`${name}（值里有换行/控制字符）`);
        continue;
    }
    if (dryRun) {
        // 只报"会导入"，**不打印值**（这脚本的输出经常被贴进 issue）
        console.log(`  [dry-run] 将导入 ${name}（${value.length} 字，****${value.slice(-4)}）`);
        imported += 1;
        continue;
    }
    try {
        const item = setSecret(name, value, { updatedBy });
        console.log(`  ✓ ${name}  ${item.hint}`);
        imported += 1;
    } catch (e) {
        skipped.push(`${name}（${e?.code ?? e?.message ?? e}）`);
    }
}

console.log('');
if (dryRun) {
    console.log(`[dry-run] 可导入 ${imported} 项，${skipped.length} 项会被跳过；没有写任何东西。`);
} else {
    console.log(`已导入 ${imported} 项，请自行删除 ${keysPath}`
        + '（脚本**不会**替你删：删凭据不可逆，确认 bot 能正常调模型后再删）。');
    if (imported > 0) {
        const total = listSecrets().length;
        console.log(`保管库现有 ${total} 项：${listSecrets().map((i) => i.name).join(', ')}`);
        console.log('提示：删掉 keys.json 后请重启 mindserver，让 agent 子进程改用注入的环境变量。');
    }
}
if (skipped.length) {
    console.log(`\n跳过 ${skipped.length} 项（不影响已导入的条目）：`);
    for (const s of skipped) console.log(`  · ${s}`);
}
process.exit(imported > 0 || dryRun ? 0 : 1);
