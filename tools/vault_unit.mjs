#!/usr/bin/env node
/**
 * 凭据保管库离线单测（R5 · 05_vault）
 *
 * 只验**能跑出来**的东西：每一条都对着真实 sqlite 文件 + 真实 AES-256-GCM 跑，
 * 不用桩、不连网。覆盖顺序按"攻击面"排：
 *   ① 往返（加密没把数据搞坏）          ⑤ 跨名挪用（AAD 生效）
 *   ② 同值两次密文不同（nonce 不复用）  ⑥ list 不含明文
 *   ③ 改 1 字节必炸（GCM 认证）        ⑦ 锁定后拒绝服务
 *   ④ 错口令必炸（verifier）           ⑧ **明文不落盘**（读原始字节搜）
 *
 * 用法：`node tools/vault_unit.mjs`，全过退出码 0。
 */
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createDecipheriv, scryptSync } from 'node:crypto';
// T31：限流逻辑抽在 src/mindcraft/unlock_limiter.js，这里直接驱动它做离线断言
import { createUnlockLimiter, normalizeAddress, addressKeyOf } from '../src/mindcraft/unlock_limiter.js';
import { readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const TMP_DB = join(tmpdir(), `mc-vault-unit-${process.pid}-${Date.now()}.db`);
const PASSPHRASE = 'correct horse battery staple';

// 必须在 import 之前把库指向临时文件：模块级没有缓存路径（dbPath() 每次读 env），
// 但 KEK/db 句柄是模块级状态，先定好路径省得测到一半换库。
delete process.env.MC_VAULT_PASSPHRASE;
const vault = await import('../src/agent/library/secrets_vault.js');
const { VAULT_ERROR } = vault;

// 默认库文件必须落在 mindcraft/.secrets.db（放错位置 = 不会被 .gitignore 和 ACL 覆盖）
{
    const saved = process.env.MC_VAULT_DB;
    delete process.env.MC_VAULT_DB;
    assert.ok(vault.dbPath().replace(/\\/g, '/').endsWith('mindcraft/.secrets.db'),
        `默认库路径不对：${vault.dbPath()}`);
    if (saved) process.env.MC_VAULT_DB = saved;
}
process.env.MC_VAULT_DB = TMP_DB;

let passed = 0;
let failed = 0;

function test(name, fn) {
    try {
        fn();
        passed += 1;
        console.log(`PASS ${passed}. ${name}`);
    } catch (e) {
        failed += 1;
        console.log(`FAIL ${passed + failed}. ${name}`);
        console.log(`      ${String(e?.message ?? e).split('\n').slice(0, 4).join('\n      ')}`);
    }
}

/** 期待一个错误码（并且**不许**把明文带进 message）。 */
function expectCode(fn, code, forbidden = []) {
    let thrown = null;
    try {
        fn();
    } catch (e) {
        thrown = e;
    }
    assert.ok(thrown, `应当抛 ${code}，实际没抛`);
    assert.equal(thrown.code, code, `错误码不对：期望 ${code}，实际 ${thrown.code}（${thrown.message}）`);
    for (const secret of forbidden) {
        assert.ok(!String(thrown.message).includes(secret), '错误信息里出现了明文');
    }
    return thrown;
}

/** 直接用第二条连接改库（模拟"拿到文件的人"篡改）。 */
function mutate(sql, ...params) {
    const db = new DatabaseSync(TMP_DB);
    db.exec('PRAGMA busy_timeout = 5000');
    try {
        db.prepare(sql).run(...params);
    } finally {
        db.close();
    }
}

const OPENAI = 'sk-proj-VERY-SECRET-OPENAI-KEY-0123456789abcdef';
const ANTHROPIC = 'sk-ant-api03-ANTHROPIC-SECRET-KEY-zyxwvutsrq';

try {
    /* ── 初始化 ─────────────────────────────────────────────────────── */
    test('init 建 salt/verifier，并把 kdf 参数写进 vault_meta', () => {
        assert.equal(vault.isInitialized(), false, '临时库不该已初始化');
        vault.init(PASSPHRASE);
        assert.equal(vault.isInitialized(), true);
        assert.equal(vault.isUnlocked(), true, 'init 之后应当直接是解锁态');
        const raw = readFileSync(TMP_DB);
        // 元数据用明文存（salt/参数不是秘密），验一下真的写进去了
        assert.ok(raw.includes(Buffer.from('scrypt')), 'vault_meta 里没有 kdf=scrypt');
        assert.ok(raw.includes(Buffer.from('verifier')), 'vault_meta 里没有 verifier');
        const meta = new DatabaseSync(TMP_DB);
        try {
            const rows = Object.fromEntries(meta.prepare('SELECT k, v FROM vault_meta').all().map((r) => [r.k, r.v]));
            assert.equal(rows.kdf, 'scrypt');
            assert.equal(rows.n, '32768');
            assert.equal(rows.r, '8');
            assert.equal(rows.p, '1');
            assert.match(rows.salt, /^[0-9a-f]{32}$/, 'salt 应当是 16 字节 hex');
            const verifier = JSON.parse(rows.verifier);
            assert.match(verifier.nonce, /^[0-9a-f]{24}$/, 'verifier nonce 应当是 12 字节 hex');
            assert.match(verifier.tag, /^[0-9a-f]{32}$/, 'verifier tag 应当是 16 字节 hex');
        } finally {
            meta.close();
        }
    });

    test('重复 init 被拒绝（不许悄悄换口令）', () => {
        expectCode(() => vault.init(PASSPHRASE), VAULT_ERROR.ALREADY_INITIALIZED);
    });

    test('名字白名单 / 值校验：非法 name 与空值都拒绝', () => {
        expectCode(() => vault.setSecret('openai_key', 'x'), VAULT_ERROR.BAD_NAME);
        expectCode(() => vault.setSecret('A', 'x'), VAULT_ERROR.BAD_NAME);
        expectCode(() => vault.setSecret('OPENAI-API-KEY', 'x'), VAULT_ERROR.BAD_NAME);
        expectCode(() => vault.setSecret('OPENAI_API_KEY', ''), VAULT_ERROR.BAD_VALUE);
        expectCode(() => vault.setSecret('OPENAI_API_KEY', 'x'.repeat(4097)), VAULT_ERROR.BAD_VALUE);
        expectCode(() => vault.setSecret('OPENAI_API_KEY', 'sk-abc\ndef'), VAULT_ERROR.BAD_VALUE);
    });

    /* ── ① 往返 ─────────────────────────────────────────────────────── */
    test('往返：set → get 得到原文', () => {
        const item = vault.setSecret('OPENAI_API_KEY', OPENAI, { updatedBy: 'unit' });
        assert.equal(item.name, 'OPENAI_API_KEY');
        assert.equal(vault.getSecret('OPENAI_API_KEY'), OPENAI);
        assert.equal(item.hint, `****${OPENAI.slice(-4)} (${OPENAI.length} 字)`);
        assert.equal(item.updatedBy, 'unit');
    });

    test('替换：created_at 保留、updated_at 前移，明文换成新值', () => {
        const first = vault.rawRecord('OPENAI_API_KEY');
        const next = `${OPENAI}-rotated`;
        vault.setSecret('OPENAI_API_KEY', next);
        const second = vault.rawRecord('OPENAI_API_KEY');
        assert.equal(vault.getSecret('OPENAI_API_KEY'), next);
        assert.equal(second.createdAt, first.createdAt, 'created_at 不该被替换改写');
        assert.ok(second.updatedAt >= first.updatedAt, 'updated_at 不该倒退');
        vault.setSecret('OPENAI_API_KEY', OPENAI);   // 复原给后面的用例用
    });

    /* ── ② 密文/ nonce 不复用 ───────────────────────────────────────── */
    test('同一 value 存两次：nonce 与 ciphertext 完全不同（nonce 不复用）', () => {
        vault.setSecret('DUP_TEST_KEY', OPENAI);
        const a = vault.rawRecord('DUP_TEST_KEY');
        vault.setSecret('DUP_TEST_KEY', OPENAI);
        const b = vault.rawRecord('DUP_TEST_KEY');
        assert.equal(a.nonce.length, 12, 'nonce 必须是 12 字节');
        assert.equal(a.tag.length, 16, 'tag 必须是 16 字节');
        assert.equal(a.alg, 'aes-256-gcm');
        assert.notEqual(a.nonce.toString('hex'), b.nonce.toString('hex'), 'nonce 复用了');
        assert.notEqual(a.ciphertext.toString('hex'), b.ciphertext.toString('hex'), '同一明文得到同一密文');
        assert.equal(vault.getSecret('DUP_TEST_KEY'), OPENAI, '重加密后仍能解回原文');
    });

    /* ── ③ 篡改检测 ─────────────────────────────────────────────────── */
    test('改 1 字节 ciphertext ⇒ 解密抛 VAULT_DECRYPT_FAILED（GCM 认证失败）', () => {
        vault.setSecret('TAMPER_TEST_KEY', OPENAI);
        const row = vault.rawRecord('TAMPER_TEST_KEY');
        const flipped = Buffer.from(row.ciphertext);
        flipped[0] = flipped[0] ^ 0x01;
        mutate('UPDATE secrets SET ciphertext = ? WHERE name = ?', flipped, 'TAMPER_TEST_KEY');
        expectCode(() => vault.getSecret('TAMPER_TEST_KEY'), VAULT_ERROR.DECRYPT_FAILED, [OPENAI]);
    });

    test('改 1 字节 tag 同样被拒（认证标签也是保护面）', () => {
        vault.setSecret('TAMPER_TAG_KEY', ANTHROPIC);
        const row = vault.rawRecord('TAMPER_TAG_KEY');
        const flipped = Buffer.from(row.tag);
        flipped[0] = flipped[0] ^ 0x80;
        mutate('UPDATE secrets SET tag = ? WHERE name = ?', flipped, 'TAMPER_TAG_KEY');
        expectCode(() => vault.getSecret('TAMPER_TAG_KEY'), VAULT_ERROR.DECRYPT_FAILED, [ANTHROPIC]);
    });

    /* ── ⑤ 跨名挪用（AAD） ─────────────────────────────────────────── */
    //
    // 这条要证明的是"**AAD = name** 真的把密文和名字绑死了"，所以不能只靠
    // "攻击失败了"来反推 —— 攻击失败可能只是撞上别的约束。实测就撞上了：
    // 整行搬到另一行时，`secrets.nonce UNIQUE` 先一步把它拦下来了
    // （这本身是好事，见下面的第一段断言）。所以分两层验：
    //   (a) 整行搬运被 nonce UNIQUE 挡住（纵深防御的第一道）；
    //   (b) 绕开那道约束（用同一把 KEK、同一段密文，只换 AAD）⇒ GCM 认证必须失败。
    //       (b) 才是 AAD 生效的**直接证据**。
    test('跨名挪用：(a) 整行搬运被 nonce UNIQUE 挡住；(b) 换 AAD 解密必然失败', () => {
        vault.setSecret('SRC_KEY_A', OPENAI);
        vault.setSecret('DST_KEY_B', ANTHROPIC);
        const src = vault.rawRecord('SRC_KEY_A');

        // (a) 第一道：nonce 是 UNIQUE 的，"整行复制"根本进不了库
        let uniqueBlocked = false;
        try {
            mutate(
                'UPDATE secrets SET nonce = ?, ciphertext = ?, tag = ? WHERE name = ?',
                src.nonce, src.ciphertext, src.tag, 'DST_KEY_B',
            );
        } catch (e) {
            uniqueBlocked = /UNIQUE/i.test(String(e?.message ?? e));
            if (!uniqueBlocked) throw e;
        }
        assert.equal(uniqueBlocked, true, '整行搬运居然写进去了：nonce UNIQUE 没起作用');

        // (b) 第二道（真正的 AAD 证据）：自己派生同一把 KEK，同一段密文换 AAD 解
        const meta = new DatabaseSync(TMP_DB);
        let saltHex;
        try {
            saltHex = meta.prepare("SELECT v FROM vault_meta WHERE k = 'salt'").get().v;
        } finally {
            meta.close();
        }
        const kek = scryptSync(PASSPHRASE, Buffer.from(saltHex, 'hex'), 32, {
            N: 32768, r: 8, p: 1, maxmem: 128 * 32768 * 8 * 2,
        });
        const decryptWithAad = (aad) => {
            const d = createDecipheriv('aes-256-gcm', kek, src.nonce);
            d.setAAD(Buffer.from(aad, 'utf8'));
            d.setAuthTag(src.tag);
            return Buffer.concat([d.update(src.ciphertext), d.final()]).toString('utf8');
        };
        assert.equal(decryptWithAad('SRC_KEY_A'), OPENAI, 'AAD 正确时应当解得开（对照组）');
        assert.throws(() => decryptWithAad('DST_KEY_B'), /unable to authenticate|bad decrypt/i,
            '换了 AAD 竟然还能解开 ⇒ AAD 没生效');

        // 库里那一行没被弄坏：解密失败是"名字不匹配"造成的，不是数据坏了
        assert.equal(vault.getSecret('SRC_KEY_A'), OPENAI);
        assert.equal(vault.getSecret('DST_KEY_B'), ANTHROPIC);
    });

    /* ── ⑥ list 不含明文 ───────────────────────────────────────────── */
    test('list() 只有 name/hint/时间：没有 value，hint 里没有明文子串', () => {
        const items = vault.listSecrets();
        assert.ok(items.length >= 3, `列表条数不对：${items.length}`);
        for (const it of items) {
            assert.deepEqual(Object.keys(it).sort(), ['hint', 'name', 'updatedAt', 'updatedBy']);
            assert.ok(!('value' in it), 'list() 返回了 value 字段');
            const json = JSON.stringify(it);
            for (const secret of [OPENAI, ANTHROPIC, `${OPENAI}-rotated`]) {
                assert.ok(!json.includes(secret), `list() 里出现了明文（${it.name}）`);
            }
            assert.match(it.hint, /^\*{4}.+ \(\d+ 字\)$/, `hint 形状不对：${it.hint}`);
            assert.ok(it.hint.length <= 32, `hint 过长，可能泄露原文：${it.hint}`);
        }
    });

    test('status() 只给 locked/count/kdf/unlockSource，不含任何条目内容', () => {
        const s = vault.status();
        // ★ T31 / W-1：多了 unlockSource（'manual' | 'env' | null）—— 面板据此把「上锁」置灰
        assert.deepEqual(Object.keys(s).sort(), ['count', 'initialized', 'kdf', 'locked', 'unlockSource']);
        assert.equal(s.kdf, 'scrypt');
        assert.equal(s.locked, false);
        assert.equal(s.unlockSource, 'manual', '手动 unlock/init 之后来源应当是 manual');
        assert.equal(s.count, vault.listSecrets().length);
        assert.ok(!JSON.stringify(s).includes(OPENAI));
    });

    /* ── ⑦ 锁定 ─────────────────────────────────────────────────────── */
    test('lock() 之后 get/list/remove 一律 VAULT_LOCKED，status 仍可读', () => {
        vault.lock();
        assert.equal(vault.isUnlocked(), false);
        expectCode(() => vault.getSecret('OPENAI_API_KEY'), VAULT_ERROR.LOCKED, [OPENAI]);
        expectCode(() => vault.listSecrets(), VAULT_ERROR.LOCKED);
        expectCode(() => vault.removeSecret('OPENAI_API_KEY'), VAULT_ERROR.LOCKED);
        const s = vault.status();
        assert.equal(s.locked, true);
        assert.ok(s.count >= 1, '锁定时也要能数出条数（面板要显示）');
    });

    /* ── ④ 错口令 ───────────────────────────────────────────────────── */
    test('错口令 unlock 抛 VAULT_BAD_PASSPHRASE（不泄露"盐错了/密文错了"的区别）', () => {
        expectCode(() => vault.unlock('wrong passphrase entirely'), VAULT_ERROR.BAD_PASSPHRASE);
        expectCode(() => vault.unlock(''), VAULT_ERROR.BAD_PASSPHRASE);
        assert.equal(vault.isUnlocked(), false, '错口令不许把库留在解锁态');
    });

    test('正确口令 unlock 后数据还在（密文跨锁定不失效）', () => {
        vault.unlock(PASSPHRASE);
        assert.equal(vault.getSecret('OPENAI_API_KEY'), OPENAI);
    });

    test('短口令在 init/derive 阶段就被拒（不给离线爆破一个弱口令）', () => {
        expectCode(() => vault.unlock('short'), VAULT_ERROR.BAD_PASSPHRASE);
    });

    /* ── 删除 & 计数 ────────────────────────────────────────────────── */
    test('removeSecret 删掉条目；再取变成 VAULT_NOT_FOUND', () => {
        vault.setSecret('TEMP_DELETE_KEY', 'x'.repeat(32));
        assert.equal(vault.removeSecret('TEMP_DELETE_KEY').removed, 1);
        expectCode(() => vault.getSecret('TEMP_DELETE_KEY'), VAULT_ERROR.NOT_FOUND);
        assert.equal(vault.removeSecret('TEMP_DELETE_KEY').removed, 0, '重复删除应当是 0 行');
    });

    /* ── ⑧ 明文不落盘 ───────────────────────────────────────────────── */
    test('明文不落盘：读 .db 原始字节，搜不到任何一把 key', () => {
        vault.setSecret('DISK_SCAN_KEY', 'sk-disk-scan-UNIQUE-MARKER-9f8e7d6c5b4a');
        vault.closeVault();     // 落盘并关句柄，别让缓存骗人
        assert.ok(existsSync(TMP_DB), '库文件不存在');
        const raw = readFileSync(TMP_DB);
        const decoder = new TextDecoder('latin1');   // 逐字节映射，不会漏掉 ASCII 子串
        const asText = decoder.decode(raw);
        for (const secret of [OPENAI, ANTHROPIC, 'sk-disk-scan-UNIQUE-MARKER-9f8e7d6c5b4a']) {
            assert.equal(asText.includes(secret), false, `库里出现了明文：${secret.slice(0, 12)}…`);
        }
        // 正面对照：hint 里的后 4 位**允许**存在（否则这条断言可能因为"文件根本没内容"而假绿）
        assert.ok(asText.includes(OPENAI.slice(-4)), '连 hint 都没有 ⇒ 这条扫描可能扫了个空文件');
    });

    test('环境变量注入：只注入没被用户占用的名字，clearInjectedEnv 能撤回', () => {
        delete process.env.VAULT_INJECT_TEST_KEY;
        vault.unlock(PASSPHRASE);
        vault.setSecret('VAULT_INJECT_TEST_KEY', 'sk-inject-me-123456');
        const { injected } = vault.injectEnvFromVault({ log: () => {} });
        assert.ok(injected >= 1, '一项都没注入');
        assert.equal(process.env.VAULT_INJECT_TEST_KEY, 'sk-inject-me-123456');
        vault.clearInjectedEnv();
        assert.equal(process.env.VAULT_INJECT_TEST_KEY, undefined, '注入的环境变量没被撤回');
    });

    /* ═══════════ T31 / W-1：unlockSource（面板据此把「上锁」置灰）═══════════ */

    test('W-1 unlockSource：lock → null；手动 unlock → manual', () => {
        vault.lock();
        assert.equal(vault.status().unlockSource, null, '上锁后来源必须是 null');
        assert.equal(vault.getUnlockSource(), null);
        vault.unlock(PASSPHRASE);
        assert.equal(vault.status().unlockSource, 'manual', '手动解锁后来源必须是 manual');
        assert.equal(vault.status().locked, false);
    });

    test('W-1 unlockSource：MC_VAULT_PASSPHRASE 自动解锁 → env', () => {
        vault.lock();
        process.env.MC_VAULT_PASSPHRASE = PASSPHRASE;
        try {
            assert.equal(vault.isUnlocked(), false, '前置：应当已上锁');
            assert.equal(vault.autoUnlockFromEnv(), true, '环境口令正确时应当自动解锁');
            // 这条是面板置灰「上锁」按钮的依据：不是人解锁的，上锁也会被环境变量再解开
            assert.equal(vault.status().unlockSource, 'env');
            assert.equal(vault.status().locked, false);
        } finally {
            delete process.env.MC_VAULT_PASSPHRASE;
        }
        // 撤掉环境变量后，手动路径恢复成 manual
        vault.lock();
        assert.equal(vault.status().unlockSource, null);
        vault.unlock(PASSPHRASE);
        assert.equal(vault.status().unlockSource, 'manual');
    });

    /* ═══════════ T31 / W-2：/unlock 限流（按来源分桶 + 成功清零）═══════════ */

    test('W-2 限流：连续 5 次失败后 isThrottled 生效，但**成功路径不受限**', () => {
        const limiter = createUnlockLimiter({ windowMs: 60_000, maxFails: 5 });
        const key = '127.0.0.1';
        for (let i = 0; i < 5; i += 1) {
            assert.equal(limiter.isThrottled(key), i >= 5, `第 ${i + 1} 次失败前不该被限流`);
            limiter.noteFailure(key);
        }
        assert.equal(limiter.failuresOf(key), 5);
        assert.equal(limiter.isThrottled(key), true, '5 次失败后该来源应进入限流');

        // ★ 这句是本条的核心：isThrottled 只用于"失败分支回 401 还是 429"。
        //   正确口令的路径完全不该看它 —— 旧实现（先判限流）在这里会把管理员锁死。
        //   验收要求的"第 6 次正确口令必须 200"就是这条性质在 HTTP 层的表现。
        limiter.noteSuccess(key);
        assert.equal(limiter.isThrottled(key), false, '成功必须清零，正确口令永远可用');
        assert.equal(limiter.failuresOf(key), 0);

        // 成功后**再错一次**只会是第 1 次失败（401），不是直接 429
        limiter.noteFailure(key);
        assert.equal(limiter.failuresOf(key), 1);
        assert.equal(limiter.isThrottled(key), false);
    });

    test('W-2 限流：不同来源互不影响（一个来源打错不连累另一个）', () => {
        const limiter = createUnlockLimiter({ windowMs: 60_000, maxFails: 5 });
        for (let i = 0; i < 5; i += 1) limiter.noteFailure('10.0.0.9');
        assert.equal(limiter.isThrottled('10.0.0.9'), true);
        assert.equal(limiter.isThrottled('127.0.0.1'), false, '别的来源不该被牵连（旧实现是全局计数）');
        limiter.noteFailure('127.0.0.1');
        assert.equal(limiter.failuresOf('127.0.0.1'), 1);
        assert.equal(limiter.failuresOf('10.0.0.9'), 5);
        assert.equal(limiter.size(), 2);
    });

    test('W-2 限流：窗口过期自动解锁；桶数量有上限不会无限涨', () => {
        let clock = 1_000_000;
        const limiter = createUnlockLimiter({ windowMs: 60_000, maxFails: 2, now: () => clock });
        limiter.noteFailure('a');
        limiter.noteFailure('a');
        assert.equal(limiter.isThrottled('a'), true);
        clock += 60_001;                        // 过窗
        assert.equal(limiter.isThrottled('a'), false, '窗口过后应当自动恢复');

        const capped = createUnlockLimiter({ windowMs: 60_000, maxFails: 5, maxBuckets: 3 });
        for (let i = 0; i < 10; i += 1) capped.noteFailure(`src-${i}`);
        assert.ok(capped.size() <= 3, `桶数量必须有上限（实际 ${capped.size()}）`);
    });

    test('W-2 限流：IPv4-mapped IPv6 与 IPv4 归一成同一个桶', () => {
        assert.equal(normalizeAddress('::ffff:127.0.0.1'), '127.0.0.1');
        assert.equal(normalizeAddress('::FFFF:127.0.0.1'), '127.0.0.1');
        assert.equal(normalizeAddress('127.0.0.1'), '127.0.0.1');
        assert.equal(normalizeAddress('::1'), '::1');
        assert.equal(normalizeAddress(''), 'unknown');
        assert.equal(addressKeyOf({ socket: { remoteAddress: '::ffff:10.1.2.3' } }), '10.1.2.3');
        assert.equal(addressKeyOf({ ip: '10.1.2.3' }), '10.1.2.3');

        const limiter = createUnlockLimiter({ windowMs: 60_000, maxFails: 2 });
        // 同一客户端两种写法必须共用一个桶，否则换个绑定方式就绕过限流
        limiter.noteFailure(normalizeAddress('::ffff:127.0.0.1'));
        limiter.noteFailure(normalizeAddress('127.0.0.1'));
        assert.equal(limiter.isThrottled('127.0.0.1'), true);
        assert.equal(limiter.size(), 1, '两种写法不该产生两个桶');
    });
} finally {
    try { vault.lock(); } catch { /* ignore */ }
    try { vault.closeVault(); } catch { /* ignore */ }
    for (const suffix of ['', '-journal']) {
        try { if (existsSync(TMP_DB + suffix)) rmSync(TMP_DB + suffix, { force: true }); } catch { /* ignore */ }
    }
}

console.log(`\n${passed} 个用例通过，${failed} 个失败`);
process.exit(failed === 0 ? 0 : 1);
