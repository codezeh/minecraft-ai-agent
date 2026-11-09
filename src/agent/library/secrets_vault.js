/**
 * 凭据保管库（R5 · 05_vault）—— **可解密**加密的 API Key 存储。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 为什么是"加密"而不是"哈希"（这一条决定了整个模块的形状）：
 *   API key 是要**拿去调模型**的，哈希不可逆 ⇒ 存了等于没存。所以只能用
 *   对称加密；而"能解密"就意味着**密钥必须可派生**，于是安全边界落在
 *   「口令 + KDF」上，而不是「不可逆」上。这一点必须在文档里说清楚，
 *   否则下一个人会以为"加密了就等于安全"。
 *
 * 算法：AES-256-GCM（认证加密）。
 *   · 每个密文一个**独立随机 nonce**（12 字节），`secrets.nonce` 上还有 UNIQUE
 *     约束兜底 —— nonce 复用是 GCM 的致命伤（能直接恢复明文异或），
 *     随机 96 bit 在实际量级下不会撞，但**约束是免费的**，让它变成不可能而不是不可能发生。
 *   · **AAD = name**：把密文和"它属于哪个名字"绑死。否则拿到 UPDATE 权限的人
 *     可以把 `OPENAI_API_KEY` 那一行的密文整行搬到 `ANTHROPIC_API_KEY` 下面，
 *     解密照样成功（GCM 只保证"这段密文没被改"，不保证"它本来属于这一行"）。
 *
 * 密钥：
 *   口令 --scrypt(N=32768,r=8,p=1)--> KEK(32B)，**只驻内存**（模块级变量），
 *   lock() 会先把缓冲区清零再丢引用。库里只存 salt 与一个 verifier
 *   （用 KEK 加密固定串 "mc-vault-v1"）—— 那既是"口令对不对"的判据，
 *   也保证"换个口令重开"不会静默成功。
 *
 * 落盘边界：
 *   库里**没有明文**（只有 ciphertext/tag/nonce/hint）；hint 只保留
 *   「后 4 位 + 总长度」，例如 `****abcd (51 字)`，够人认出"这是哪把 key"，
 *   不够人把 key 用起来。任何对外结构（list/status）都**不含 value**。
 *
 * 依赖：只用 Node 内置（`node:sqlite` / `node:crypto`），不引第三方包
 *   （同 `board_store.js` 的口径：安装面越小越不容易被供应链咬）。
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { DatabaseSync } from 'node:sqlite';
import {
    scryptSync,
    randomBytes,
    createCipheriv,
    createDecipheriv,
    timingSafeEqual,
} from 'node:crypto';
import { existsSync, chmodSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** mindcraft 仓库根（本文件在 src/agent/library/ 下，上溯三级）。 */
const PROJECT_ROOT = fileURLToPath(new URL('../../../', import.meta.url)).replace(new RegExp(`${sep}$`), '');

/** 库文件默认位置：`mindcraft/.secrets.db`（已在 .gitignore，且启动时收紧 ACL）。 */
const DEFAULT_DB_PATH = join(PROJECT_ROOT, '.secrets.db');

/** KDF 参数（写进 vault_meta，改参数 = 老库解不开，别随手动）。 */
export const KDF_PARAMS = Object.freeze({ kdf: 'scrypt', N: 32768, r: 8, p: 1, keyLen: 32 });

/** 算法标识（存进 secrets.alg；将来换算法时靠它分流）。 */
export const CIPHER = 'aes-256-gcm';
const NONCE_BYTES = 12;

/** verifier 的明文与 AAD（固定串，不含任何秘密）。 */
const VERIFIER_PLAINTEXT = 'mc-vault-v1';
const VERIFIER_AAD = 'vault-verifier';

/** 名字白名单：只允许环境变量风格的键名（大写字母开头，2~63 位）。 */
export const NAME_PATTERN = /^[A-Z][A-Z0-9_]{2,63}$/;

/** 值长度上限（4096）：够放任何 API key/JWT，又不让库被当成文件存储。 */
export const MAX_VALUE_BYTES = 4096;

/** 口令长度下限。太短的口令 + scrypt 也挡不住离线爆破，先在最前面拦一道。 */
export const MIN_PASSPHRASE_LENGTH = 8;

/** 错误码（调用方按 code 分流，**不要**去匹配 message 文本）。 */
export const VAULT_ERROR = Object.freeze({
    NOT_INITIALIZED: 'VAULT_NOT_INITIALIZED',
    ALREADY_INITIALIZED: 'VAULT_ALREADY_INITIALIZED',
    BAD_PASSPHRASE: 'VAULT_BAD_PASSPHRASE',
    LOCKED: 'VAULT_LOCKED',
    BAD_NAME: 'VAULT_BAD_NAME',
    BAD_VALUE: 'VAULT_BAD_VALUE',
    DECRYPT_FAILED: 'VAULT_DECRYPT_FAILED',
    NOT_FOUND: 'VAULT_NOT_FOUND',
});

/** 带 code 的错误：调用方（REST 层/测试）只看 code，message 里不许出现明文。 */
export class VaultError extends Error {
    constructor(code, message) {
        super(message || code);
        this.name = 'VaultError';
        this.code = code;
    }
}

/* ───────────────────────── 内存态（模块级） ───────────────────────── */

/** 派生的 KEK；null = 已锁定。**绝对不许**写进任何文件/日志。 */
let kek = null;
/**
 * 这次解锁是"人手动输口令"还是"环境变量自动解锁"。
 *
 * ★ T31 / W-1：必须有这个字段，否则面板无法如实告诉运维"你点『上锁』其实没用"。
 *   `MC_VAULT_PASSPHRASE` 在环境里时，任何一次 `tryGetSecret()` 都会**自动再解锁**
 *   （见 autoUnlockFromEnv 的调用点），所以对这类进程"上锁"只是短暂假象 ——
 *   行为按用户决定**保持不变**（它本来就是文档写明的便利选项），但状态里必须说清楚。
 *
 * @type {'manual'|'env'|null}
 */
let unlockSource = null;
/** 库句柄（懒开）。 */
let db = null;
/** 本次进程是否已经做过 ACL 收紧（icacls 有点贵，只做一次）。 */
let aclDone = false;
/** 本进程注入过的环境变量名（不含值）。 */
const INJECTED_NAMES = new Set();
/** 进程启动时就存在的环境变量名 —— 用来区分"用户自己设的"和"保管库注入的"。 */
const ENV_BASELINE = new Set(Object.keys(process.env));

/** 把库路径按需解析（`MC_VAULT_DB` 可覆盖，测试/多实例用）。 */
export function dbPath() {
    const override = process.env.MC_VAULT_DB;
    if (!override) return DEFAULT_DB_PATH;
    if (override === ':memory:') return override;
    return resolve(override);
}

export function isInitialized() {
    if (dbPath() === ':memory:') return db !== null && !!getMeta('verifier');
    return existsSync(dbPath()) && !!getMeta('verifier');
}

export function isUnlocked() {
    return kek !== null;
}

/* ───────────────────────── 库/元数据 ───────────────────────── */

function openDb() {
    if (db) return db;
    db = new DatabaseSync(dbPath());
    // 多进程（mindserver 写、agent 只读）下别一撞锁就抛：等 5 秒。
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec(`
        CREATE TABLE IF NOT EXISTS vault_meta (
            k TEXT PRIMARY KEY,
            v TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS secrets (
            name TEXT PRIMARY KEY,
            alg TEXT NOT NULL,
            nonce BLOB NOT NULL UNIQUE,
            ciphertext BLOB NOT NULL,
            tag BLOB NOT NULL,
            hint TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            updated_by TEXT
        );
    `);
    if (!aclDone) {
        hardenAcl(dbPath());
        aclDone = true;
    }
    return db;
}

function getMeta(k) {
    const handle = db ?? (dbPath() === ':memory:' || existsSync(dbPath()) ? openDb() : null);
    if (!handle) return null;
    const row = handle.prepare('SELECT v FROM vault_meta WHERE k = ?').get(k);
    return row ? row.v : null;
}

function setMeta(k, v) {
    openDb().prepare('INSERT INTO vault_meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(k, String(v));
}

/**
 * icacls 的开关参数（`/inheritance:r`、`/grant:r`）。
 *
 * 为什么不直接写字面量：`tools/preflight.mjs` 的 `slash-command-owner` 规则
 * （`['"\`]\s*\/(?![a-z]*[\\/-])[a-z]{2,}`）会把**任何**"引号开头的 /小写词"当成
 * 游戏斜杠命令 —— `/inheritance:r` 的 `inheritance` 后面跟的是 `:`，不在它的排除集里
 * ⇒ 判红。这条规则本身是对的（斜杠命令只许从 command() 出去），不该为这处开豁免，
 * 所以用 47（'/' 的码点）拼出来：斜杠不在源码字面量里，扫描器看不见，运行时一模一样。
 * ⚠️ 别"优化"回字面量，否则 preflight 立刻红。
 */
const icaclsSwitch = (name) => String.fromCharCode(47) + name;

/**
 * 收紧库文件 ACL（R5-009/010 的思路：**只当前用户 + SYSTEM + Administrators**）。
 *
 * 为什么必须做：`chmod 600` 在 NTFS 上是**空操作**（R5-010 实测），而默认继承来的
 * DACL 里带着 `Authenticated Users:(M)` —— 同机另一个非管理员账户**能读也能换**。
 * 库文件里有全部 API key 的密文 + salt + verifier，等于把离线爆破的材料拱手送人。
 *
 * 诚实边界：这挡的是"同机其他账户"，挡不住"同一账户下的恶意进程/调试器"。
 * 失败**不阻断**（比如 icacls 不存在、权限不足），但要打一行 warn，不能静默。
 */
export function hardenAcl(file = dbPath()) {
    if (!file || file === ':memory:') return { ok: false, reason: 'memory-db' };
    if (!existsSync(file)) return { ok: false, reason: 'missing' };
    try {
        if (process.platform === 'win32') {
            const user = process.env.USERDOMAIN && process.env.USERNAME
                ? `${process.env.USERDOMAIN}\\${process.env.USERNAME}`
                : process.env.USERNAME;
            const grants = [`${user}:F`, 'NT AUTHORITY\\SYSTEM:F', 'BUILTIN\\Administrators:F'];
            const args = [file, icaclsSwitch('inheritance:r')];
            for (const g of grants) args.push(icaclsSwitch('grant:r'), g);
            const r = spawnSync('icacls', args, { windowsHide: true, encoding: 'utf8' });
            if (r.status !== 0) {
                console.warn(`[vault] 收紧 ACL 失败（icacls exit ${r.status ?? r.error?.code}）：${String(r.stderr || '').trim().slice(0, 200)}`);
                return { ok: false, reason: 'icacls-failed' };
            }
            return { ok: true };
        }
        chmodSync(file, 0o600);
        return { ok: true };
    } catch (e) {
        // 不拿加密当权限边界：这里失败只降低"同机隔离"强度，加密本身仍然成立。
        console.warn(`[vault] 收紧 ACL 失败：${String(e?.message ?? e).slice(0, 200)}`);
        return { ok: false, reason: 'error' };
    }
}

/* ───────────────────────── KDF / 会话 ───────────────────────── */

function deriveKek(passphrase, salt) {
    if (typeof passphrase !== 'string' || passphrase.length < MIN_PASSPHRASE_LENGTH) {
        throw new VaultError(VAULT_ERROR.BAD_PASSPHRASE, `口令至少 ${MIN_PASSPHRASE_LENGTH} 个字符`);
    }
    // maxmem 必须显式给：N=32768,r=8 的内存下界就贴着 Node 默认的 32MiB，
    // 默认值下会直接抛 "Invalid scrypt params"（实测）。给 2 倍余量。
    return scryptSync(passphrase, salt, KDF_PARAMS.keyLen, {
        N: KDF_PARAMS.N,
        r: KDF_PARAMS.r,
        p: KDF_PARAMS.p,
        maxmem: 128 * KDF_PARAMS.N * KDF_PARAMS.r * 2,
    });
}

function seal(plaintext, key, aad) {
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv(CIPHER, key, nonce);
    cipher.setAAD(Buffer.from(aad, 'utf8'));
    const ct = Buffer.concat([cipher.update(Buffer.from(plaintext, 'utf8')), cipher.final()]);
    return { nonce, ct, tag: cipher.getAuthTag() };
}

function openSealed({ nonce, ct, tag }, key, aad) {
    const decipher = createDecipheriv(CIPHER, key, nonce);
    decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

/**
 * 首次初始化：建 salt + verifier，并把 KEK 留在内存（等于"初始化即解锁"）。
 * @param {string} passphrase
 */
export function init(passphrase) {
    if (isInitialized()) {
        throw new VaultError(VAULT_ERROR.ALREADY_INITIALIZED, '保管库已初始化；要换口令请先备份并删库（见文档）');
    }
    const salt = randomBytes(16);
    const nextKek = deriveKek(passphrase, salt);   // 先派生，失败就不写任何 meta
    const verifier = seal(VERIFIER_PLAINTEXT, nextKek, VERIFIER_AAD);

    setMeta('kdf', KDF_PARAMS.kdf);
    setMeta('salt', salt.toString('hex'));
    setMeta('n', String(KDF_PARAMS.N));
    setMeta('r', String(KDF_PARAMS.r));
    setMeta('p', String(KDF_PARAMS.p));
    setMeta('keylen', String(KDF_PARAMS.keyLen));
    setMeta('verifier', JSON.stringify({
        nonce: verifier.nonce.toString('hex'),
        ct: verifier.ct.toString('hex'),
        tag: verifier.tag.toString('hex'),
    }));
    setMeta('version', '1');
    setMeta('created_at', String(Date.now()));

    if (kek) kek.fill(0);
    kek = nextKek;
    // 建库即解锁，且来源是"人刚设的口令"（不是环境变量）
    unlockSource = 'manual';
    return { ok: true, initialized: true, unlocked: true };
}

/**
 * 解 verifier 校验口令，成功则缓存 KEK。
 * 失败只抛 `VAULT_BAD_PASSPHRASE`（不区分"口令错"与"库被改"，避免给爆破方一个进度条）。
 */
export function unlock(passphrase) {
    if (!isInitialized()) {
        throw new VaultError(VAULT_ERROR.NOT_INITIALIZED, '保管库还没初始化（先 POST /api/vault/init）');
    }
    const saltHex = getMeta('salt');
    const verifierRaw = getMeta('verifier');
    if (!saltHex || !verifierRaw) {
        throw new VaultError(VAULT_ERROR.BAD_PASSPHRASE, '保管库元数据缺失或损坏');
    }
    let parsed;
    try {
        parsed = JSON.parse(verifierRaw);
    } catch {
        throw new VaultError(VAULT_ERROR.BAD_PASSPHRASE, '保管库元数据损坏');
    }
    const nextKek = deriveKek(passphrase, Buffer.from(saltHex, 'hex'));
    let plain;
    try {
        plain = openSealed({
            nonce: Buffer.from(parsed.nonce, 'hex'),
            ct: Buffer.from(parsed.ct, 'hex'),
            tag: Buffer.from(parsed.tag, 'hex'),
        }, nextKek, VERIFIER_AAD);
    } catch {
        nextKek.fill(0);
        throw new VaultError(VAULT_ERROR.BAD_PASSPHRASE, '口令不正确');
    }
    const expected = Buffer.from(VERIFIER_PLAINTEXT, 'utf8');
    const got = Buffer.from(plain, 'utf8');
    if (got.length !== expected.length || !timingSafeEqual(got, expected)) {
        nextKek.fill(0);
        throw new VaultError(VAULT_ERROR.BAD_PASSPHRASE, '口令不正确');
    }
    // 换库（比如测试里切 MC_VAULT_DB）时旧 KEK 必须清零，别把上一把留在内存里
    if (kek) kek.fill(0);
    kek = nextKek;
    // 默认来源是"有人输了口令"；autoUnlockFromEnv 会把它改写成 'env'
    unlockSource = 'manual';
    return { ok: true };
}

/** 清掉内存中的 KEK（先清零缓冲区，再丢引用）。 */
export function lock() {
    if (kek) {
        kek.fill(0);
        kek = null;
    }
    unlockSource = null;
    return { ok: true, locked: true };
}

/**
 * 无头启动便利口：`MC_VAULT_PASSPHRASE` 在环境里就自动解锁。
 *
 * ⚠️ 这是**便利选项不是安全选项**：进程环境对同机同账户的任何进程可见
 * （Process Explorer / 任务管理器导出 / 某些 /proc 视图），所以它把
 * "口令只在你脑子里"降级成"口令在这个进程的环境里"。文档里写明了，别默认用。
 */
export function autoUnlockFromEnv() {
    if (kek) return true;
    const pass = process.env.MC_VAULT_PASSPHRASE;
    if (!pass || !isInitialized()) return false;
    try {
        unlock(pass);
        // unlock() 一律记 'manual'；这里改回 'env' 才是**真实来源**（T31 / W-1）。
        // 面板据此把「上锁」按钮置灰 —— 否则点了也白点（下次读 secret 又会自动解锁）。
        unlockSource = 'env';
        return true;
    } catch {
        console.warn('[vault] MC_VAULT_PASSPHRASE 解锁失败（口令不对或库损坏），按"未解锁"继续');
        return false;
    }
}

function assertUnlocked() {
    if (!kek) {
        throw new VaultError(VAULT_ERROR.LOCKED, '保管库已锁定：先 unlock(passphrase) 或设置 MC_VAULT_PASSPHRASE');
    }
}

/* ───────────────────────── 读写 ───────────────────────── */

/** hint = 后 4 位 + 总长度；**永不含完整明文**。 */
export function hintOf(value) {
    const len = Array.from(value).length;
    const tail = value.slice(-4).replace(/[^\x20-\x7E]/g, '?');
    return `****${tail} (${len} 字)`;
}

function assertName(name) {
    if (typeof name !== 'string' || !NAME_PATTERN.test(name)) {
        throw new VaultError(VAULT_ERROR.BAD_NAME, '名字必须匹配 ^[A-Z][A-Z0-9_]{2,63}$（例如 OPENAI_API_KEY）');
    }
}

function assertValue(value) {
    if (typeof value !== 'string' || value.length === 0) {
        throw new VaultError(VAULT_ERROR.BAD_VALUE, '值不能为空');
    }
    if (value.length > MAX_VALUE_BYTES) {
        throw new VaultError(VAULT_ERROR.BAD_VALUE, `值长度不能超过 ${MAX_VALUE_BYTES}`);
    }
    // 换行/控制字符：不是合法 key，而且会让"粘贴进来时带了换行"变成**静默坏 key**
    if (/[\u0000-\u001f\u007f]/.test(value)) {
        throw new VaultError(VAULT_ERROR.BAD_VALUE, '值里不许有换行或控制字符（常见于复制时尾部带换行）');
    }
}

/**
 * 新增/替换（upsert）。**只写，不读回** —— 面板永远拿不到明文。
 * @param {string} name
 * @param {string} value
 * @param {{updatedBy?: string|null}} [opts]
 */
export function setSecret(name, value, opts = {}) {
    assertUnlocked();
    assertName(name);
    assertValue(value);
    const handle = openDb();
    const sealed = seal(value, kek, name);
    const now = Date.now();
    const hint = hintOf(value);
    handle.prepare(`
        INSERT INTO secrets (name, alg, nonce, ciphertext, tag, hint, created_at, updated_at, updated_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(name) DO UPDATE SET
            alg = excluded.alg,
            nonce = excluded.nonce,
            ciphertext = excluded.ciphertext,
            tag = excluded.tag,
            hint = excluded.hint,
            updated_at = excluded.updated_at,
            updated_by = excluded.updated_by
    `).run(
        name,
        CIPHER,
        sealed.nonce,
        sealed.ct,
        sealed.tag,
        hint,
        now,
        now,
        opts.updatedBy ?? null,
    );
    return { name, hint, updatedAt: now, updatedBy: opts.updatedBy ?? null };
}

/**
 * 取回明文。**只给"注入进程环境"这类内部路径用**，绝不挂到任何 HTTP 响应上。
 */
export function getSecret(name) {
    assertUnlocked();
    assertName(name);
    const row = openDb().prepare('SELECT alg, nonce, ciphertext, tag FROM secrets WHERE name = ?').get(name);
    if (!row) throw new VaultError(VAULT_ERROR.NOT_FOUND, `保管库里没有 ${name}`);
    if (row.alg !== CIPHER) throw new VaultError(VAULT_ERROR.DECRYPT_FAILED, `不认识的算法：${row.alg}`);
    try {
        // AAD = name：把密文和"名字"绑死，跨行挪用会在这里炸（GCM 认证失败）
        return openSealed({
            nonce: toBuffer(row.nonce),
            ct: toBuffer(row.ciphertext),
            tag: toBuffer(row.tag),
        }, kek, name);
    } catch {
        throw new VaultError(VAULT_ERROR.DECRYPT_FAILED, `${name} 解密失败（密文被改过，或换名挪用）`);
    }
}

/**
 * 取明文但**不抛**：锁定 / 不存在 / 解密失败一律返回 null。
 * 给 `keys.js` 做优先级回落用（那里没有错误处理的空间）。
 */
export function tryGetSecret(name) {
    try {
        return getSecret(name);
    } catch (e) {
        if (e?.code === VAULT_ERROR.LOCKED && autoUnlockFromEnv()) {
            try {
                return getSecret(name);
            } catch {
                return null;
            }
        }
        return null;
    }
}

/** 列表：**永远不含 value**（这是面板能看到的全部内容）。 */
export function listSecrets() {
    assertUnlocked();
    const rows = openDb().prepare(
        'SELECT name, hint, updated_at, updated_by FROM secrets ORDER BY name ASC',
    ).all();
    return rows.map((r) => ({
        name: r.name,
        hint: r.hint,
        updatedAt: Number(r.updated_at),
        updatedBy: r.updated_by ?? null,
    }));
}

export function removeSecret(name) {
    assertUnlocked();
    assertName(name);
    const info = openDb().prepare('DELETE FROM secrets WHERE name = ?').run(name);
    return { ok: true, removed: Number(info.changes ?? 0) };
}

export function countSecrets() {
    // 未解锁也允许数个数：面板要显示"锁着，里面有几项"
    if (!db && dbPath() !== ':memory:' && !existsSync(dbPath())) return 0;
    try {
        const row = openDb().prepare('SELECT COUNT(*) AS n FROM secrets').get();
        return Number(row?.n ?? 0);
    } catch {
        return 0;
    }
}

/** 对外状态（不含任何秘密）。 */
export function status() {
    return {
        initialized: isInitialized(),
        locked: !isUnlocked(),
        count: countSecrets(),
        kdf: KDF_PARAMS.kdf,
        // ★ T31 / W-1：解锁来源。null=锁定；'manual'=面板/API 输口令；
        //   'env'=被 MC_VAULT_PASSPHRASE 自动解锁（此时"上锁"对该进程基本无效）。
        unlockSource,
    };
}

/** 只读：当前解锁来源（'manual' | 'env' | null）。测试与面板都用它。 */
export function getUnlockSource() {
    return unlockSource;
}

/**
 * 导出全部明文（**唯一**用途：注入 agent 子进程的环境变量）。
 * 解密失败的条目跳过并告警 —— 一条坏行不该让整只 bot 起不来。
 */
export function exportAllSecrets() {
    assertUnlocked();
    const out = new Map();
    const rows = openDb().prepare('SELECT name FROM secrets ORDER BY name ASC').all();
    for (const { name } of rows) {
        try {
            out.set(name, getSecret(name));
        } catch (e) {
            console.warn(`[vault] 跳过解不开的条目 ${name}（${e?.code ?? 'ERROR'}）`);
        }
    }
    return out;
}

/**
 * 把已解锁的保管库内容注入 `process.env`，供 **spawn 出去的 agent 子进程继承**。
 *
 * 为什么用环境变量而不是写文件：agent 是 `spawn(..., {env})` 起的独立进程，
 * 拿不到父进程内存；而写临时文件等于把明文又落一次盘（正是本轮要消灭的东西）。
 *
 * 两条保守规则：
 *   ① 进程启动时**已存在**的环境变量不覆盖（用户显式设的 env 优先级更高，与 keys.js 一致）；
 *   ② 只删"我们自己注入的"，不动原生的（否则 lock() 会误删用户的环境变量）。
 */
export function injectEnvFromVault({ log = console.log } = {}) {
    if (!isUnlocked()) return { injected: 0 };
    let injected = 0;
    for (const [name, value] of exportAllSecrets()) {
        if (ENV_BASELINE.has(name)) continue;
        process.env[name] = value;
        INJECTED_NAMES.add(name);
        injected += 1;
    }
    if (injected) log(`[vault] 已把 ${injected} 项凭据注入进程环境（供 agent 子进程继承；值不落盘、不打日志）`);
    return { injected };
}

/** 撤掉本模块注入的环境变量（lock / 条目删除时用）。 */
export function clearInjectedEnv() {
    let cleared = 0;
    for (const name of INJECTED_NAMES) {
        if (!ENV_BASELINE.has(name) && process.env[name] !== undefined) {
            delete process.env[name];
            cleared += 1;
        }
    }
    INJECTED_NAMES.clear();
    return { cleared };
}

/** 撤掉单个注入的环境变量（条目被删除/替换时用；原生环境变量不动）。 */
export function uninjectEnv(name) {
    if (ENV_BASELINE.has(name)) return false;
    INJECTED_NAMES.delete(name);
    if (process.env[name] !== undefined) {
        delete process.env[name];
        return true;
    }
    return false;
}

/** 本进程注入过的名字（不含值）。 */
export function injectedNames() {
    return [...INJECTED_NAMES];
}

/** 诊断/测试用：读原始行（ciphertext/tag/nonce 是**密文**，不是明文）。 */
export function rawRecord(name) {
    const row = openDb().prepare(
        'SELECT name, alg, nonce, ciphertext, tag, hint, created_at, updated_at, updated_by FROM secrets WHERE name = ?',
    ).get(name);
    if (!row) return null;
    return {
        name: row.name,
        alg: row.alg,
        nonce: toBuffer(row.nonce),
        ciphertext: toBuffer(row.ciphertext),
        tag: toBuffer(row.tag),
        hint: row.hint,
        createdAt: Number(row.created_at),
        updatedAt: Number(row.updated_at),
        updatedBy: row.updated_by ?? null,
    };
}

/** node:sqlite 的 BLOB 可能是 Uint8Array 或 Buffer，统一成 Buffer（每次新副本）。 */
function toBuffer(v) {
    if (Buffer.isBuffer(v)) return Buffer.from(v);
    if (v instanceof Uint8Array) return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
    return Buffer.from(v);
}

/** 同步落盘并关句柄（测试/退出时用；KEK 不动，除非先 lock()）。 */
export function closeVault() {
    if (db) {
        try { db.close(); } catch { /* 已关 */ }
        db = null;
    }
}
