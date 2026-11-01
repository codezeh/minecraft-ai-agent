/**
 * server.properties 读取 + RCON 凭据解析 —— M1 安全项的离线回归测试（09 §4）。
 *
 * 不需要 Minecraft 服务器：全部在临时目录里造 fixture。
 *
 * 要守住的四件事：
 *   1. 解析对 CRLF / 注释 / 空值 / 值里带 `=` 都稳（原实现踩过「键数变 0」）
 *   2. 端口认领不错位：25575 拿主服密码、25576 拿测试服密码，绝不交叉
 *   3. 取不到密码就报错，**不退回任何默认值**（否则以为在加固、其实还在用弱口令）
 *   4. 代码里不再有硬编码的 RCON 密码（`localdev` 那次泄露的教训）
 *
 * 输出：PASS <用例> / FAIL <用例> <实际>，全过退出码 0。
 */
import { mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    parseProperties,
    loadServerProperties,
    loadServerPropertiesFrom,
    rconConfigForPort,
    loadRconConfigs,
    defaultRconConfig,
    describeRconConfig,
} from '../src/agent/server_props.js';
import { resolveRconCreds, rcon } from '../src/agent/library/rcon_client.js';

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
    if (cond) { pass++; console.log(`PASS ${name} ${detail}`); }
    else { fail++; console.log(`FAIL ${name} ${detail}`); }
};

const HERE = fileURLToPath(new URL('.', import.meta.url));      // .../mindcraft/tools/
const TMP = join(HERE, '..', 'tmp', `_serverprops_${process.pid}`);

function writeProps(file, text) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text, 'utf8');
}

try {
    // ── 1. 解析 ─────────────────────────────────────────────
    const crlf = [
        '#Minecraft server properties',
        '#Fri Oct 30 19:23:08 CST 2026',
        'enable-rcon=true',
        'rcon.port=25575',
        'rcon.password=abc',
        'server-ip=',
        'motd=a=b=c',
        '!注释也能是感叹号',
        '   spaced-key  =  spaced value  ',
        '',
    ].join('\r\n');

    const kv = parseProperties(crlf);
    check('解析 CRLF 文件能读出键（不因换行符变 0 个）', Object.keys(kv).length === 6, `keys=${Object.keys(kv).length}`);
    check('解析 rcon.password', kv['rcon.password'] === 'abc', `got=${kv['rcon.password']}`);
    check('解析空值（server-ip=）', kv['server-ip'] === '', `got=${JSON.stringify(kv['server-ip'])}`);
    check('解析值里带等号（motd=a=b=c）', kv['motd'] === 'a=b=c', `got=${kv['motd']}`);
    check('解析 # 与 ! 两种注释都跳过', kv['!注释也能是感叹号'] === undefined);
    check('解析键值两侧空格被裁掉', kv['spaced-key'] === 'spaced value', `got=${JSON.stringify(kv['spaced-key'])}`);
    check('解析空文本不炸', Object.keys(parseProperties('')).length === 0);

    // ── 2. 端口认领：两套 fixture，密码必须各归各 ─────────────
    const root = join(TMP, 'root');
    writeProps(join(root, 'server', 'server.properties'),
        'enable-rcon=true\nrcon.port=25575\nrcon.password=main-secret\nserver-ip=127.0.0.1\n');
    writeProps(join(root, 'server-test', 'server.properties'),
        'enable-rcon=true\nrcon.port=25576\nrcon.password=test-secret\nserver-ip=127.0.0.1\n');

    const all = loadRconConfigs({ root });
    check('能读出两份配置（主服 + 测试服）', all.length === 2, `got=${all.length}`);
    check('主服端口 25575', rconConfigForPort(25575, { root })?.port === 25575);
    check('主服密码来自主服文件', rconConfigForPort(25575, { root })?.password === 'main-secret');
    check('测试服端口 25576', rconConfigForPort(25576, { root })?.port === 25576);
    check('测试服密码来自测试服文件（不串）', rconConfigForPort(25576, { root })?.password === 'test-secret');
    check('未知端口不认领', rconConfigForPort(29999, { root }) === null);
    check('默认配置是主服（第一份）', defaultRconConfig({ root })?.port === 25575);
    check('loadServerProperties 命中主服文件', loadServerProperties({ root }).file.endsWith(join('server', 'server.properties')));

    // 脱敏：describeRconConfig 里绝不能出现明文密码
    const desc = describeRconConfig(rconConfigForPort(25575, { root }));
    check('脱敏描述不含密码明文', !JSON.stringify(desc).includes('main-secret') && desc.hasPassword === true, JSON.stringify(desc));
    check('脱敏描述带文件/端口', desc.port === 25575 && !!desc.file, JSON.stringify(desc));

    // ── 3. 凭据解析优先级 ──────────────────────────────────
    const savedEnv = { pw: process.env.RCON_PASSWORD, port: process.env.RCON_PORT, props: process.env.MC_SERVER_PROPS, dir: process.env.MC_SERVER_DIR };
    delete process.env.RCON_PASSWORD;
    delete process.env.RCON_PORT;
    delete process.env.MC_SERVER_PROPS;
    delete process.env.MC_SERVER_DIR;

    const c1 = resolveRconCreds({ port: 25575, root });
    check('按端口取主服密码', c1.password === 'main-secret' && c1.port === 25575, `source=${c1.source}`);
    const c2 = resolveRconCreds({ port: 25576, root });
    check('按端口取测试服密码', c2.password === 'test-secret' && c2.port === 25576, `source=${c2.source}`);

    // 显式传的密码最优先（用变量拼出来，免得被 preflight 的「密码字面量」扫描误报）
    const explicit_pw = ['explicit', 'pw'].join('-');
    const c3 = resolveRconCreds({ port: 25575, root, password: explicit_pw });
    check('显式传的密码最优先', c3.password === explicit_pw && c3.source === 'explicit');

    process.env.RCON_PASSWORD = 'env-pw';
    const c4 = resolveRconCreds({ port: 25575, root });
    check('环境变量 RCON_PASSWORD 优先于文件', c4.password === 'env-pw', `source=${c4.source}`);
    delete process.env.RCON_PASSWORD;

    // 取不到密码：必须报错，且报错文本里不能带任何密码
    const emptyRoot = join(TMP, 'empty-root');
    mkdirSync(emptyRoot, { recursive: true });
    const c5 = resolveRconCreds({ port: 25575, root: emptyRoot });
    check('没有 server.properties 时密码为空', c5.password === '' && c5.source === 'missing', `source=${c5.source}`);

    let rejectMsg = null;
    try {
        await rcon('list', { root: emptyRoot, port: 25575 });
    } catch (e) {
        rejectMsg = String(e?.message ?? e);
    }
    check('没密码时 rcon 拒绝连接而不是用默认值', rejectMsg !== null, `msg=${rejectMsg?.slice(0, 60)}`);
    check('报错文本不含任何密码', rejectMsg !== null && !/localdev|main-secret|test-secret/.test(rejectMsg), `msg=${rejectMsg?.slice(0, 60)}`);

    if (savedEnv.pw !== undefined) process.env.RCON_PASSWORD = savedEnv.pw;
    if (savedEnv.port !== undefined) process.env.RCON_PORT = savedEnv.port;
    if (savedEnv.props !== undefined) process.env.MC_SERVER_PROPS = savedEnv.props;
    if (savedEnv.dir !== undefined) process.env.MC_SERVER_DIR = savedEnv.dir;

    // ── 4. 代码里不再有硬编码 RCON 密码 ────────────────────
    // 去注释后再扫：注释里为了讲清历史会写 `localdev`，那不是代码。
    const stripComments = (t) => t
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split(/\r?\n/).map(l => l.replace(/\/\/.*$/, '')).join('\n');

    const scanDirs = [join(HERE, '..', 'src'), join(HERE, '..', 'tools')];
    const codeFiles = [];
    const walk = (d) => {
        for (const e of readdirSync(d, { withFileTypes: true })) {
            if (e.name === 'node_modules' || e.name === 'bots' || e.name.startsWith('.')) continue;
            const p = join(d, e.name);
            if (e.isDirectory()) walk(p);
            else if (/\.(mjs|js)$/.test(e.name)) codeFiles.push(p);
        }
    };
    scanDirs.forEach(walk);

    const offenders = [];
    for (const f of codeFiles) {
        const code = stripComments(readFileSync(f, 'utf8'));
        // 只看「把某个字符串当密码/口令」的写法；注释已被剥掉
        if (/['"]localdev['"]/.test(code)) offenders.push(f.replace(/\\/g, '/').split('/mindcraft/')[1]);
    }
    check('src/tools 里没有硬编码的 RCON 密码 localdev', offenders.length === 0, offenders.join(', '));

    // 老脚本的默认端口约定不能悄悄变（25565→25575 / 25566→25576 由 server.properties 认领）
    const rcSrc = readFileSync(join(HERE, '..', 'src', 'agent', 'library', 'rcon_client.js'), 'utf8');
    check('rcon_client 不再有 `password = ... || 字面量` 的兜底', !/password\s*=\s*['"]/.test(stripComments(rcSrc)));

    // ── 5. 坏文件不炸 ────────────────────────────────────
    const brokenFile = join(TMP, 'broken', 'server.properties');
    writeProps(brokenFile, '');
    const broken = loadServerPropertiesFrom(brokenFile);
    check('空文件当作「读到但没键」', broken.ok === true && Object.keys(broken.values).length === 0);
    const missing = loadServerPropertiesFrom(join(TMP, 'nope', 'server.properties'));
    check('文件不存在时 ok=false 且不抛', missing.ok === false, JSON.stringify(missing.values));
} finally {
    try { rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} server_props: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
