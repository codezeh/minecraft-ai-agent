import { readFileSync } from 'fs';
import { isInitialized, tryGetSecret } from '../agent/library/secrets_vault.js';

/**
 * API Key 解析 —— **唯一入口**（所有 model adapter 都从这里取 key）。
 *
 * ★ R5 / 05_vault：优先级改成 **环境变量 > 保管库 > keys.json（兼容）**。
 *
 * 为什么是这个顺序（而不是"保管库优先"）：
 *   · **环境变量第一**：它是运维/CI 的显式覆盖手段，也必须是 mindserver 把
 *     保管库内容注入 agent 子进程后的**实际生效路径**（子进程拿不到父进程内存，
 *     注入方式就是 env）。如果保管库优先，注入进来的值反而会被 keys.json 盖掉。
 *   · **保管库第二**：单进程直跑（`node main.js`）时没有"注入"这一步，
 *     这里直接读解密值 —— 前提是保管库已解锁（或设了 `MC_VAULT_PASSPHRASE`）。
 *   · **keys.json 最后且打 deprecation**：向后兼容不能弄坏现有启动，
 *     但要在每次真的用到它时提醒"这是明文，该迁了"（静默兼容 = 永远不会迁）。
 *
 * 锁定时**不报错**：`tryGetSecret` 返回 null，继续往下落到 keys.json/env，
 * 于是"保管库还没解锁"不会让 bot 起不来（面板会明确显示锁定态）。
 */

const KEYS_FILE = './keys.json';

let keys = {};
let keysFileError = null;
try {
    const data = readFileSync(KEYS_FILE, 'utf8');
    keys = JSON.parse(data);
} catch (err) {
    keysFileError = err;
}

// 只在"三条路全都没有"时才提示：既有保管库也没 keys.json，那真的只能靠环境变量
// （把这条 warn 留在 import 期是为了保持原有诊断习惯：启动就能看见）
if (keysFileError && !isInitialized()) {
    console.warn('keys.json not found. Defaulting to environment variables.'); // still works with local models
}

/** 已经提醒过 deprecation 的键名（一种键只吵一次，别把日志刷成噪音）。 */
const deprecatedWarned = new Set();

function warnDeprecated(name) {
    if (deprecatedWarned.has(name)) return;
    deprecatedWarned.add(name);
    console.warn(
        `[keys] deprecation: "${name}" 来自明文 keys.json。`
        + '请迁到凭据保管库（面板「凭据」页 / docs/vault-保管库.md），'
        + 'keys.json 里的明文是明文落盘风险，后续版本会移除该回退。',
    );
}

/** 保管库里有没有这个 key（未初始化/锁定/不存在一律 undefined，不抛）。 */
function fromVault(name) {
    if (!isInitialized()) return undefined;
    return tryGetSecret(name) ?? undefined;
}

export function getKey(name) {
    // ① 环境变量（含 mindserver 注入的保管库内容）
    let key = process.env[name];
    if (key) return key;

    // ② 保管库（单进程直跑时走这条）
    key = fromVault(name);
    if (key) return key;

    // ③ keys.json —— 兼容保留，但每次用都提醒
    key = keys[name];
    if (key) {
        warnDeprecated(name);
        return key;
    }

    throw new Error(`API key "${name}" not found in environment variables, vault (.secrets.db) or keys.json!`);
}

export function hasKey(name) {
    if (process.env[name]) return true;
    if (fromVault(name)) return true;
    if (keys[name]) {
        warnDeprecated(name);
        return true;
    }
    return false;
}
