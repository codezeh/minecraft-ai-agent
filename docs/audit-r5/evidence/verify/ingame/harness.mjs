/**
 * 第五轮审计 · 游戏内真机实测 harness —— 起隔离 Paper 服 + 真 mineflayer bot。
 *
 * 为什么不直接用 scripts/e2e.ps1：
 *   e2e.ps1 只认 claims / restart 两个场景（ValidateSet），而本轮要跑的是
 *   BUG-001/002/003 回归 + 原子能力 + 寻路 + 停手，共 20+ 条断言。
 *   但**起服/停服/重置的机制一模一样**，这里照抄它的做法（见 scripts/e2e.ps1 的
 *   New-RunDir / Start-TestServer / Stop-TestServer）：
 *     · 一次性运行目录 tmp/r5-verify-ingame/<场景>/
 *     · server.properties 来自 test-template，__E2E_RCON_PASSWORD__ 换成每次随机的口令
 *     · world/ 从 test-template 拷（这就是"重置"的来源）
 *     · libraries/ versions/ cache/ 用 junction 指到 server-test（只读复用，绝不写）
 *     · 起服（JDK21 + server/server.jar），等日志出现 `Done (`，再 RCON `list` 探活
 *     · 停服 RCON `stop` → 等 java 退出 → 超时强杀**自己那个 pid**
 *
 * 纪律（与 e2e.ps1 一致）：
 *   · 绝不碰 server/ 与 server-test/ 的世界；server-test 只被 junction 只读复用
 *   · 绝不按名字扫 java 进程强杀（可能有人在跑主服）
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// docs/audit-r5/evidence/ingame → 仓库根
export const REPO_ROOT = 'E:/我的世界ai';
export const MIND_DIR = path.join(REPO_ROOT, 'mindcraft');
export const TEMPLATE_DIR = path.join(REPO_ROOT, 'test-template');
export const SERVER_JAR = path.join(REPO_ROOT, 'server/server.jar');
export const SRV_TEST_DIR = path.join(REPO_ROOT, 'server-test');
export const RUN_ROOT = path.join(REPO_ROOT, 'tmp/r5-verify-ingame');

export const MC_PORT = 25566;
export const RCON_PORT = 25576;

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const req = createRequire(path.join(MIND_DIR, 'package.json'));

/** 拿 mindcraft 的依赖（mineflayer 等是 CJS，用 createRequire 从它的 node_modules 取）。 */
export function dep(name) {
    return req(name);
}

/** 动态 import mindcraft 里的 ESM 源码模块。 */
export async function src(relPath) {
    return import(pathToFileURL(path.join(MIND_DIR, relPath)).href);
}

export function findJava() {
    const tools = path.join(REPO_ROOT, '.tools');
    const dirs = fs.readdirSync(tools).filter((d) => d.startsWith('jdk'));
    for (const d of dirs) {
        const exe = path.join(tools, d, 'bin', 'java.exe');
        if (fs.existsSync(exe)) return exe;
    }
    throw new Error('找不到 JDK：.tools/jdk*/bin/java.exe');
}

/** 递归目录指纹（sha256 逐文件），用于证明"起服前世界 = 模板世界"。 */
export function worldFingerprint(dir) {
    const lines = [];
    const walk = (d) => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
            const p = path.join(d, e.name);
            if (e.isDirectory()) walk(p);
            else if (e.isFile() && e.name !== 'session.lock') {
                const h = createHash('sha256').update(fs.readFileSync(p)).digest('hex');
                lines.push(`${path.relative(dir, p).replace(/\\/g, '/')} ${h}`);
            }
        }
    };
    walk(dir);
    return lines.sort().join('\n');
}

export function randomPassword() {
    const hex = 'abcdef0123456789';
    let s = '';
    for (let i = 0; i < 24; i++) s += hex[Math.floor(Math.random() * 16)];
    return s;
}

/** 建一次性运行目录（= e2e.ps1 的 New-RunDir）。 */
export function newRunDir({ scenario, levelType = 'flat', seed = '', copyWorld = true, propsOverrides = {} }) {
    const runDir = path.join(RUN_ROOT, scenario);
    if (fs.existsSync(runDir)) fs.rmSync(runDir, { recursive: true, force: true });
    fs.mkdirSync(runDir, { recursive: true });

    let props = fs.readFileSync(path.join(TEMPLATE_DIR, 'server.properties'), 'utf8');
    const password = randomPassword();
    props = props.replace('__E2E_RCON_PASSWORD__', password);
    const setProp = (key, value) => {
        const re = new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}=.*$`, 'm');
        if (re.test(props)) props = props.replace(re, `${key}=${value}`);
        else props += `\n${key}=${value}`;
    };
    if (levelType === 'flat') setProp('level-type', 'minecraft\\:flat');
    else setProp('level-type', 'minecraft\\:normal');
    if (seed !== '') setProp('level-seed', String(seed));
    for (const [k, v] of Object.entries(propsOverrides)) setProp(k, v);

    fs.writeFileSync(path.join(runDir, 'server.properties'), props, 'latin1');
    fs.writeFileSync(path.join(runDir, 'eula.txt'), 'eula=true', 'latin1');

    if (copyWorld) {
        fs.cpSync(path.join(TEMPLATE_DIR, 'world'), path.join(runDir, 'world'), { recursive: true });
    }

    for (const d of ['libraries', 'versions', 'cache']) {
        const srcDir = path.join(SRV_TEST_DIR, d);
        const dst = path.join(runDir, d);
        if (fs.existsSync(srcDir)) fs.symlinkSync(srcDir, dst, 'junction');
    }
    return { runDir, password };
}

/** 起服 + 等就绪 + 停服的完整生命周期。 */
export async function createHarness({ scenario, levelType = 'flat', seed = '', copyWorld = true, bootTimeoutMs = 300000 }) {
    const results = [];
    const { runDir, password } = newRunDir({ scenario, levelType, seed, copyWorld });
    const logPath = path.join(runDir, 'server.log');
    const errPath = path.join(runDir, 'server.err.log');

    let child = null;
    let logBuf = '';
    const rconClient = await src('src/agent/library/rcon_client.js');
    const rc = (cmd, opts = {}) => rconClient.rcon(cmd, { port: RCON_PORT, password, timeout: 8000, ...opts });

    const h = {
        scenario,
        runDir,
        logPath,
        errPath,
        password,
        results,
        rc,
        childPid: null,
        get log() { return logBuf; },

        boot: async () => {
            child = spawn(findJava(), ['-Xms512M', '-Xmx1024M', '-XX:+UseG1GC', '-jar', SERVER_JAR, 'nogui'], {
                cwd: runDir,
                stdio: ['pipe', 'pipe', 'pipe'],
                windowsHide: true,
            });
            h.childPid = child.pid;
            fs.writeFileSync(path.join(runDir, 'server.pid'), String(child.pid ?? ''), 'latin1');
            const out = fs.createWriteStream(logPath, { flags: 'w' });
            const err = fs.createWriteStream(errPath, { flags: 'w' });
            child.stdout.on('data', (b) => { logBuf += b.toString(); out.write(b); });
            child.stderr.on('data', (b) => { logBuf += b.toString(); err.write(b); });
            child.on('exit', (code) => { logBuf += `\n[java exited code=${code}]\n`; });

            const deadline = Date.now() + bootTimeoutMs;
            while (Date.now() < deadline) {
                await sleep(1000);
                if (!child || child.exitCode !== null) {
                    throw new Error(`java 提前退出（code=${child?.exitCode}），日志尾部：\n${logBuf.slice(-3000)}`);
                }
                if (logBuf.includes('Done (')) break;
            }
            if (!logBuf.includes('Done (')) {
                throw new Error(`${bootTimeoutMs}ms 内日志没出现 "Done ("，尾部：\n${logBuf.slice(-3000)}`);
            }
            const rDeadline = Date.now() + 60000;
            while (Date.now() < rDeadline) {
                try {
                    const probe = await rc('list');
                    if (/players online|There are/.test(String(probe))) return true;
                } catch { /* 还没准备好 */ }
                await sleep(1500);
            }
            throw new Error('RCON 60s 内没就绪');
        },

        stop: async (graceMs = 60000) => {
            if (!child || child.exitCode !== null) return true;
            try { await rc('stop'); } catch { /* 可能已经在停 */ }
            const deadline = Date.now() + graceMs;
            while (Date.now() < deadline) {
                if (child.exitCode !== null) return true;
                await sleep(500);
            }
            try { child.kill(); } catch { /* ignore */ }
            await sleep(2000);
            return child.exitCode !== null;
        },

        kill: () => {
            if (child && child.exitCode === null) {
                try { child.kill(); } catch { /* ignore */ }
            }
        },

        pass: (name, detail = '') => {
            results.push({ name, pass: true, detail });
            console.log(`PASS ${name}${detail ? ' —— ' + detail : ''}`);
        },
        fail: (name, detail = '') => {
            results.push({ name, pass: false, detail });
            console.log(`FAIL ${name}${detail ? ' —— ' + detail : ''}`);
        },
        check: (name, cond, detail = '') => {
            if (cond) h.pass(name, detail); else h.fail(name, detail);
            return !!cond;
        },
        summary: () => {
            const okCount = results.filter((r) => r.pass).length;
            const bad = results.filter((r) => !r.pass);
            console.log(`\n=== 小计：PASS ${okCount} / ${results.length}，FAIL ${bad.length} ===`);
            for (const b of bad) console.log(`  FAIL 原文：${b.name} —— ${b.detail}`);
            fs.writeFileSync(path.join(runDir, 'assertions.json'), JSON.stringify({ scenario, results }, null, 2), 'utf8');
            return { okCount, total: results.length, bad };
        },
    };
    return h;
}

// ── 通用工具 ────────────────────────────────────────────────────────

/** 从 `data get entity X Pos` 的返回里取坐标。 */
export function parsePos(text) {
    const s = String(text);
    const idx = s.indexOf('[');
    const tail = idx >= 0 ? s.slice(idx) : s;
    const t = tail.match(/-?\d+(?:\.\d+)?d?/g) ?? [];
    if (t.length < 3) return null;
    return t.slice(0, 3).map((x) => Number(x.replace('d', '')));
}

export const posStr = (p) => `${p[0]} ${p[1]} ${p[2]}`;

/** 服务端侧 item 实体计数（BUG-003 的关键证据之一）。 */
export async function serverItemCount(rc, pos, radius = 10) {
    await rc('scoreboard objectives add r5cnt dummy').catch(() => {});
    await rc(`execute positioned ${posStr(pos)} store result score #c r5cnt run execute if entity @e[type=item,distance=..${radius}]`);
    const out = String(await rc('scoreboard players get #c r5cnt'));
    const m = out.match(/has (\d+)/) || out.match(/: (\d+)/);
    return m ? Number(m[1]) : null;
}

/** 服务端侧某实体类型的数量。 */
export async function serverEntityCount(rc, type, pos, radius = 16) {
    await rc('scoreboard objectives add r5cnt dummy').catch(() => {});
    await rc(`execute positioned ${posStr(pos)} store result score #c r5cnt run execute if entity @e[type=${type},distance=..${radius}]`);
    const out = String(await rc('scoreboard players get #c r5cnt'));
    const m = out.match(/has (\d+)/) || out.match(/: (\d+)/);
    return m ? Number(m[1]) : null;
}

export function itemCount(bot, name) {
    return (bot.inventory?.items?.() ?? [])
        .filter((i) => i?.name === name)
        .reduce((n, i) => n + (i.count ?? 0), 0);
}

/** 等一个条件成立（轮询）。 */
export async function waitFor(fn, { timeoutMs = 15000, intervalMs = 250 } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try { if (await fn()) return true; } catch { /* ignore */ }
        await sleep(intervalMs);
    }
    return false;
}

/** 建一个真 bot 并等 spawn。 */
export async function makeBot({ name, version = '1.21.8' }) {
    const mineflayer = dep('mineflayer');
    const pf = dep('mineflayer-pathfinder');
    const guard = await src('src/sim/position_guard.js');
    const bot = mineflayer.createBot({
        host: '127.0.0.1', port: MC_PORT, username: name, auth: 'offline', version,
    });
    bot.loadPlugin(pf.pathfinder);
    if (typeof guard.installPositionGuard === 'function') guard.installPositionGuard(bot);
    bot.on('error', () => {});
    const kicks = [];
    bot.on('kicked', (r) => kicks.push(JSON.stringify(r).slice(0, 200)));
    await new Promise((res, rej) => {
        const t = setTimeout(() => rej(new Error('bot 30s 内没 spawn')), 30000);
        bot.once('spawn', () => { clearTimeout(t); res(); });
    });
    await sleep(1500);
    bot.__kicks = kicks;
    return bot;
}
