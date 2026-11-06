/**
 * SEC-001（2026-11-06 深度检查）—— 畸形 Cookie 不得在鉴权前终止控制服务。
 *
 * 缺陷原貌：`cookieValue()` 直接 `decodeURIComponent(raw)`。客户端发
 * `Cookie: mindserver_token=%` 时抛 URIError；这条链跑在**鉴权判定期间**
 * （io.use(makeHandshakeGate) → tokenFromHandshake → cookieValue），
 * 同步异常逃出 Socket.IO 的 Namespace.run，**整个 mindserver 进程退出**。
 * 也就是说：不需要正确 token，一个畸形请求就能打掉控制面。
 *
 * 修复口径（`src/mindcraft/auth_gate.js`）：
 *   ① cookie 解码失败 = 没带这个 cookie（返回 null）→ 走「未授权」正常拒绝；
 *   ② 握手门自己兜住判定异常，只能变成一次 next(error) 拒绝。
 *
 * 本测分三层，全程不建真实 socket、不连 8080：
 *   A. cookieValue / tokenFromHandshake 对畸形输入的行为（不抛、判未授权）；
 *   B. makeHandshakeGate 用桩 socket/next 跑：畸形输入 ⇒ next(err)，绝不 throw；
 *   C. 进程级回归：把「中间件被畸形 Cookie 命中」跑在**子进程**里，
 *      断言子进程退出码 0 —— 直接对应报告里「服务退出码 1」的现象。
 *
 * 输出：PASS/FAIL 逐条，全过退出码 0。
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
    TOKEN_COOKIE, cookieValue, tokenFromHandshake, isAuthorizedHandshake, makeHandshakeGate,
} from '../src/mindcraft/auth_gate.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0, skipped = 0;
const check = (name, cond, detail = '') => {
    if (cond) { pass++; console.log(`PASS ${name} ${detail}`); }
    else { fail++; console.log(`FAIL ${name} ${detail}`); }
};
const skip = (name, why) => {
    skipped++; console.log(`SKIP ${name} → ${why}`);
};

const TOKEN = 'test-token-abcdefgh';

// ════════════════════════════════════════════════════════════
// A. cookieValue / tokenFromHandshake：畸形输入不抛、判未授权
// ════════════════════════════════════════════════════════════
const MALFORMED = [
    ['裸百分号', 'mindserver_token=%'],
    ['百分号后接非法十六进制', 'mindserver_token=%zz'],
    ['百分号截断', 'mindserver_token=%2'],
    ['非法 UTF-8 字节', 'mindserver_token=%FF'],
    ['非法 UTF-8 三字节', 'mindserver_token=%E0%A4'],
    ['多个百分号', 'mindserver_token=%%%%'],
];

for (const [label, cookie] of MALFORMED) {
    let threw = null;
    let value;
    try {
        value = cookieValue(cookie, TOKEN_COOKIE);
    } catch (err) {
        threw = err;
    }
    check(`cookieValue 畸形 Cookie 不抛异常：${label}`, threw === null,
        threw ? `→ threw ${threw.name}: ${threw.message}` : '');
    check(`cookieValue 畸形 Cookie 视为未携带：${label}`, value === null, `→ ${JSON.stringify(value)}`);

    let hs;
    let hsThrew = null;
    try {
        hs = tokenFromHandshake({ headers: { cookie } });
    } catch (err) {
        hsThrew = err;
    }
    check(`tokenFromHandshake 畸形 Cookie 不抛异常：${label}`, hsThrew === null,
        hsThrew ? `→ threw ${hsThrew.name}` : '');
    check(`tokenFromHandshake 畸形 Cookie 取不到 token：${label}`, hs === null, `→ ${JSON.stringify(hs)}`);
}

// 正常 cookie 仍然能解出来（别为了防畸形把正路堵死）
const goodCookie = `a=1; ${TOKEN_COOKIE}=${TOKEN}; b=2`;
check('正常 Cookie 仍能取出 token', cookieValue(goodCookie, TOKEN_COOKIE) === TOKEN);
check('正常 Cookie 握手判为已授权', isAuthorizedHandshake({ headers: { cookie: goodCookie } }, TOKEN));

// 编码过的 token（前端 Set-Cookie 走 encodeURIComponent）要能还原
check('percent-encoded 正常 Cookie 能还原',
    cookieValue(`${TOKEN_COOKIE}=${encodeURIComponent('a b%c')}`, TOKEN_COOKIE) === 'a b%c');

// 空 / 无等号 / 重名 / 别的名字
check('空 Cookie 头 → null', cookieValue('', TOKEN_COOKIE) === null);
check('非字符串 Cookie 头 → null', cookieValue(null, TOKEN_COOKIE) === null && cookieValue({}, TOKEN_COOKIE) === null);
check('无等号的片段被跳过', cookieValue('novalue; a=b', TOKEN_COOKIE) === null);
check('别的 cookie 名取不到', cookieValue('other=1', TOKEN_COOKIE) === null);
check('重名 cookie 取第一个（畸形在前 → null，不抛）',
    cookieValue(`${TOKEN_COOKIE}=%; ${TOKEN_COOKIE}=${TOKEN}`, TOKEN_COOKIE) === null);

// ════════════════════════════════════════════════════════════
// B. 握手门：畸形输入只能变成 next(error)，不能 throw
// ════════════════════════════════════════════════════════════
const gate = makeHandshakeGate(TOKEN);

const runGate = (handshake) => {
    const calls = [];
    let threw = null;
    try {
        gate({ handshake }, (err) => calls.push(err ?? 'next-ok'));
    } catch (err) {
        threw = err;
    }
    return { calls, threw };
};

for (const [label, cookie] of MALFORMED) {
    const r = runGate({ headers: { cookie } });
    check(`握手门畸形 Cookie 不 throw：${label}`, r.threw === null, r.threw ? `→ threw ${r.threw.message}` : '');
    check(`握手门畸形 Cookie 调用 next(err)：${label}`,
        r.calls.length === 1 && r.calls[0] !== 'next-ok', `→ calls=${r.calls.length}`);
    check(`握手门畸形 Cookie 错误码稳定：${label}`,
        r.calls[0]?.data?.code === 'AUTH_REQUIRED', `→ ${JSON.stringify(r.calls[0]?.data)}`);
}

// 畸形 token 本身（query / header / auth）也不许炸
const ODD_HANDSHAKES = [
    ['query 里是对象', { query: { token: { toString: () => '%' } } }],
    ['headers 是数组', { headers: [] }],
    ['auth 是字符串', { auth: 'x' }],
    ['cookie 是对象', { headers: { cookie: { evil: true } } }],
    ['handshake 缺失', undefined],
];
for (const [label, hs] of ODD_HANDSHAKES) {
    const r = runGate(hs);
    check(`握手门异常形状不 throw：${label}`, r.threw === null, r.threw ? `→ ${r.threw.message}` : '');
    check(`握手门异常形状仍拒绝：${label}`, r.calls.length === 1 && r.calls[0] !== 'next-ok');
}

// 正确 token 仍然放行
const ok = runGate({ headers: { cookie: `${TOKEN_COOKIE}=${TOKEN}` } });
check('握手门正确 Cookie → next() 放行', ok.calls.length === 1 && ok.calls[0] === 'next-ok');

// ════════════════════════════════════════════════════════════
// C. 进程级：鉴权路径吃畸形 Cookie 后，进程必须正常退出（不是崩溃退出）
// ════════════════════════════════════════════════════════════
const probe = `
import { makeHandshakeGate } from ${JSON.stringify(new URL('../src/mindcraft/auth_gate.js', import.meta.url).href)};
const gate = makeHandshakeGate('tok');
// 模拟 socket.io：一个连接用畸形 Cookie 握手，另一条正常握手。
let rejected = 0, accepted = 0;
const hammer = (cookie) => {
    gate({ handshake: { headers: { cookie, host: 'localhost:8080' } } }, (err) => {
        if (err) rejected++; else accepted++;
    });
};
for (const bad of ['mindserver_token=%', 'mindserver_token=%zz', 'mindserver_token=%FF']) {
    hammer(bad);
    hammer(bad + '; junk');
}
hammer('mindserver_token=tok');
process.stdout.write(JSON.stringify({ rejected, accepted }));
`;
const child = spawnSync(process.execPath, ['--input-type=module', '-e', probe], { encoding: 'utf8' });
// ★ 2026-11-06：本机 DSH 沙箱**禁止管道 stdio**（spawn 捕获 stdout 直接 EPERM），
//   子进程根本没跑起来。此时 child.status===null 且 stdout/stderr 全空 —— 这是**环境**
//   限制，不是 SEC-001 的回归。之前它会报两条假红，把"门禁红"和"真缺陷"混在一起。
//   处理：识别出来就明确 SKIP（并打原因），正常环境（普通 shell）仍照常断言。
const spawnBlocked = child.error?.code === 'EPERM'
    || (child.status === null && !child.stdout && !child.stderr);
if (spawnBlocked) {
    const why = `本环境禁止子进程管道 stdio（${child.error?.code ?? 'EPERM'}），这两条须在普通 shell 里跑`;
    skip('子进程：畸形 Cookie 风暴后正常退出（exit 0）', why);
    skip('子进程：畸形握手全部被拒、正常握手放行', why);
} else {
    check('子进程：畸形 Cookie 风暴后正常退出（exit 0）', child.status === 0,
        `→ status=${child.status} stderr=${(child.stderr || '').trim().slice(0, 200)}`);
    let summary = null;
    try { summary = JSON.parse((child.stdout || '').trim()); } catch { /* ignore */ }
    check('子进程：畸形握手全部被拒、正常握手放行',
        summary && summary.accepted === 1 && summary.rejected === 6,
        `→ ${JSON.stringify(summary)}`);
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'HAS FAILURES'}: ${pass} passed, ${fail} failed`
    + (skipped ? `, ${skipped} skipped（环境受限，非缺陷）` : ''));
process.exit(fail === 0 ? 0 : 1);
