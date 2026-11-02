#!/usr/bin/env node
/**
 * 服务器网络与准入开关 —— 按 `config/network.json` 改 server.properties。
 *
 * 为什么要有这个工具（2026-11-02 用户要求）：
 *   原来只有 `server-ip=127.0.0.1` 一种写死状态。只绑本机最安全，但局域网/手机
 *   连不上，很多功能用不了；绑所有网卡方便，可是**离线模式下任何人都能冒用 op 名字进服**
 *   （ops.json 里有 341 个 bot 账号）。所以做成开关，由用户按需要切。
 *
 *   ★ 关键认知：**真正的安全边界是白名单，不是绑定地址。**
 *     离线模式（online-mode=false）下客户端不做 Mojang 验证，任何人可以用任意名字连；
 *     但开了 white-list 之后只有名单里的人能进 —— 冒用名字就没用了。
 *     所以「绑所有网卡 + 白名单」是安全且可用的组合，不必为了安全牺牲局域网。
 *
 *   ★ 主服与测试服要分开：测试服跑 atom_all/bench 时每轮新建 `ma<时间戳>` bot，
 *     开了白名单这些 bot 全被挡住、测试直接挂。所以测试服固定绑本机 + 不开白名单。
 *
 * 用法：
 *   node tools/server-net.mjs show          看配置与实际值
 *   node tools/server-net.mjs apply [--dry] 写入 server.properties（先备份）
 */
import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const MC_ROOT = join(HERE, '..');
const CFG_PATH = join(MC_ROOT, '..', 'config', 'network.json');

const SERVERS = {
    main: join(MC_ROOT, '..', 'server', 'server.properties'),
    test: join(MC_ROOT, '..', 'server-test', 'server.properties'),
};
const WHITELISTS = {
    main: join(MC_ROOT, '..', 'server', 'whitelist.json'),
    test: join(MC_ROOT, '..', 'server-test', 'whitelist.json'),
};

const BIND_MODES = ['localhost', 'all', 'custom'];

function loadCfg() {
    if (!existsSync(CFG_PATH)) throw new Error('找不到配置 ' + CFG_PATH);
    const cfg = JSON.parse(readFileSync(CFG_PATH, 'utf8'));
    if (!cfg || typeof cfg.servers !== 'object') throw new Error('配置里缺少 servers 段');
    for (const [name, one] of Object.entries(cfg.servers)) {
        if (name.startsWith('_')) continue;
        const mode = one.bind ?? 'localhost';
        if (!BIND_MODES.includes(mode)) {
            throw new Error('servers.' + name + '.bind 只能是 ' + BIND_MODES.join(' / ') + '（现在是 "' + mode + '"）');
        }
        if (mode === 'custom' && !String(one.nic ?? '').trim()) {
            throw new Error('servers.' + name + '.bind = custom 时必须填 nic（要绑的网卡地址，如 192.168.1.23）');
        }
        if (mode === 'all' && one.whiteList !== true) {
            console.warn('⚠️  servers.' + name + ' 绑所有网卡但没开白名单 ——');
            console.warn('    离线模式下任何人都能冒用任意名字（含 op 名）进服。强烈建议 whiteList = true。');
        }
    }
    return cfg;
}

function desiredProps(one) {
    const mode = one.bind ?? 'localhost';
    const serverIp = mode === 'localhost' ? '127.0.0.1'
        : mode === 'all' ? ''
            : String(one.nic).trim();
    return {
        'server-ip': serverIp,
        'white-list': one.whiteList ? 'true' : 'false',
        'enforce-whitelist': one.enforceWhiteList ? 'true' : 'false',
        'online-mode': one.onlineMode ? 'true' : 'false',
    };
}

/** 只改指定键，其余行（含注释与顺序）原样保留。 */
function patchProperties(text, kv) {
    const lines = text.split(/\r?\n/);
    const seen = new Set();
    const out = lines.map((line) => {
        const m = /^([A-Za-z0-9._-]+)\s*=/.exec(line);
        if (!m || !(m[1] in kv)) return line;
        seen.add(m[1]);
        return m[1] + '=' + kv[m[1]];
    });
    for (const k of Object.keys(kv)) {
        if (!seen.has(k)) out.push(k + '=' + kv[k]);
    }
    return out.join('\n');
}

function currentOf(file) {
    if (!existsSync(file)) return null;
    const text = readFileSync(file, 'utf8');
    const get = (k) => {
        // ★ 2026-11-02 修：等号后必须用 [ \t]* 而不是 \s* ——
        //   `\s` 能匹配换行，于是 `server-ip=`（空值）会把下一行的
        //   `server-port=25565` 当成自己的值读出来（实测显示成
        //   `server-ip=server-port=25565`）。这类"读错了还看起来很合理"
        //   的 bug 最难查，所以这里显式写清。
        const m = new RegExp('^' + k + '[ \\t]*=[ \\t]*(.*)$', 'm').exec(text);
        return m ? m[1].trim() : '(未设置)';
    };
    return {
        'server-ip': get('server-ip'),
        'white-list': get('white-list'),
        'enforce-whitelist': get('enforce-whitelist'),
        'online-mode': get('online-mode'),
    };
}

function whitelistNames(file) {
    if (!existsSync(file)) return null;
    try {
        const arr = JSON.parse(readFileSync(file, 'utf8'));
        return Array.isArray(arr) ? arr.map((x) => x && x.name).filter(Boolean) : [];
    } catch (e) {
        return null;
    }
}

function fmtIp(v) {
    return v === '' ? '(空=所有网卡)' : v;
}

function show() {
    const cfg = loadCfg();
    console.log('=== config/network.json -> 各服务器 ===');
    for (const name of Object.keys(SERVERS)) {
        const one = cfg.servers?.[name];
        if (!one) { console.log('\n  [' + name + '] 配置里没有这一段'); continue; }
        const want = desiredProps(one);
        console.log('\n  [' + name + ']  bind=' + (one.bind ?? 'localhost')
            + (one.bind === 'custom' ? '(' + one.nic + ')' : '')
            + '  whiteList=' + !!one.whiteList
            + '  enforce=' + !!one.enforceWhiteList
            + '  onlineMode=' + !!one.onlineMode);
        if (one.players && one.players.length) console.log('          名单: ' + one.players.join(', '));
        const cur = currentOf(SERVERS[name]);
        if (!cur) { console.log('          ✗ 找不到 ' + SERVERS[name]); continue; }
        const diff = Object.keys(want).filter((k) => cur[k] !== want[k]);
        console.log('          目标: server-ip=' + fmtIp(want['server-ip']) + ' white-list=' + want['white-list']
            + ' enforce=' + want['enforce-whitelist'] + ' online-mode=' + want['online-mode']);
        console.log('          实际: server-ip=' + fmtIp(cur['server-ip']) + ' white-list=' + cur['white-list']
            + ' enforce=' + cur['enforce-whitelist'] + ' online-mode=' + cur['online-mode']);
        console.log('          ' + (diff.length ? '← 需运行 apply (' + diff.join(', ') + ')' : '✓ 已一致'));
        if (one.whiteList) {
            const names = whitelistNames(WHITELISTS[name]);
            if (names === null) {
                console.log('          ⚠️  whitelist.json 不存在或格式不对 —— 开了白名单但没名单，谁都进不来');
            } else {
                const missing = (one.players || []).filter((n) => !names.includes(n));
                console.log('          whitelist.json: ' + names.length + ' 个名字'
                    + (names.length ? ' (' + names.slice(0, 8).join(', ') + (names.length > 8 ? ' …' : '') + ')' : ''));
                if (missing.length) console.log('          ⚠️  这些人不在名单里，进不来: ' + missing.join(', '));
            }
        }
    }
    console.log('\n改完要**重启服务器**才生效。');
}

function apply(dry) {
    const cfg = loadCfg();
    let changed = 0;
    for (const name of Object.keys(SERVERS)) {
        const one = cfg.servers?.[name];
        const file = SERVERS[name];
        if (!one) { console.log('  ' + name + ': 配置里没有这一段，跳过'); continue; }
        if (!existsSync(file)) { console.log('  ' + name + ': 找不到 ' + file + '，跳过'); continue; }
        const want = desiredProps(one);
        const before = readFileSync(file, 'utf8');
        const after = patchProperties(before, want);
        if (before === after) { console.log('  ' + name + ': 无变化'); continue; }
        console.log('  ' + name + ':');
        for (const k of Object.keys(want)) {
            // 同 currentOf：等号后用 [ 	]*，不能 \s*（会跨行读到下一行的值）
            const m = new RegExp('^' + k + '[ \t]*=[ \t]*(.*)$', 'm').exec(before);
            const old = (m ? m[1] : '(缺失)').trim();
            if (old !== want[k]) {
                console.log('      ' + k + ': ' + (old === '' ? '(空)' : old) + ' → ' + (want[k] === '' ? '(空)' : want[k]));
            }
        }
        if (!dry) {
            copyFileSync(file, file + '.bak-' + new Date().toISOString().slice(0, 19).replace(/[:T]/g, ''));
            writeFileSync(file, after, 'utf8');
        }
        changed++;
    }
    if (dry) console.log('\n(dry-run，未写盘)');
    else if (changed) console.log('\n已更新 ' + changed + ' 个文件（各自留了 .bak 备份）。**重启服务器**后生效。');
    else console.log('\n无需改动。');

    for (const name of Object.keys(cfg.servers || {})) {
        if (name.startsWith('_')) continue;
        const one = cfg.servers[name];
        if (!one || !one.whiteList) continue;
        const names = whitelistNames(WHITELISTS[name]);
        if (names === null) {
            console.log('\n⚠️  ' + name + ': 开了白名单但 whitelist.json 不存在/格式不对 —— 谁都进不来。');
            continue;
        }
        const missing = (one.players || []).filter((n) => !names.includes(n));
        if (missing.length) console.log('\n⚠️  ' + name + ': 这些人不在 whitelist.json 里，进不来: ' + missing.join(', '));
    }
}

const cmd = process.argv[2] || 'show';
try {
    if (cmd === 'show') show();
    else if (cmd === 'apply') apply(process.argv.includes('--dry'));
    else { console.log('用法: node tools/server-net.mjs [show|apply] [--dry]'); process.exit(1); }
} catch (e) {
    console.error('✗ ' + e.message);
    process.exit(1);
}
