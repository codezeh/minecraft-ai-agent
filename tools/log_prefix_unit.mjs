/**
 * log_prefix 单元测试（T04 / 报告第12条）。
 *
 * 为什么要有这个文件：日志前缀这种东西"看起来装上了"最容易自欺 ——
 * 打一行看到有前缀就收工，然后漏掉幂等（重复 install 后 `ts ts msg`）、
 * 漏掉 printf 语义（`%s` 被当成字面量）、漏掉 stderr（只装了 log）。
 * 这些都是"装上之后才慢慢咬人"的类型，所以逐条锁死。
 *
 * 约定：打印行首 PASS/FAIL，`tools/unit_all.mjs` 会自动发现（*_unit.mjs）并计入。
 */
import { spawnSync } from 'node:child_process';
import { installLogPrefix, isLogPrefixInstalled } from '../src/infra/log_prefix.js';

let passed = 0;
let failed = 0;
// ★ 保存**安装前缀之前**的 console.log 用来输出测试结果。
//   否则 test 2 一装上前缀，后面的 `PASS` 行就变成 `2026-…Z   PASS …`，
//   而 tools/unit_all.mjs 是按行首 `^\s*PASS` 数用例的 —— 会把后面的用例漏掉。
const emit = console.log;
function check(name, cond, detail = '') {
    if (cond) { passed++; emit(`  PASS  ${name}${detail ? `  ${detail}` : ''}`); }
    else { failed++; emit(`  FAIL  ${name}${detail ? `  ${detail}` : ''}`); }
}

const ISO_PREFIX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z /;

/** 临时劫持 stdout/stderr 写口，拿到本进程 console 的真实输出。 */
function capture(fn) {
    const out = [];
    const err = [];
    const oWrite = process.stdout.write.bind(process.stdout);
    const eWrite = process.stderr.write.bind(process.stderr);
    process.stdout.write = (chunk, ...rest) => { out.push(String(chunk)); return true; };
    process.stderr.write = (chunk, ...rest) => { err.push(String(chunk)); return true; };
    try {
        fn();
    } finally {
        process.stdout.write = oWrite;
        process.stderr.write = eWrite;
    }
    return { out: out.join(''), err: err.join('') };
}

// ---------- 1) 真实子进程：stdout 与 stderr 都要带前缀 ----------
// 用子进程是刻意的：验收命令就是 `node -e "require(...).installLogPrefix(); ..."`，
// 这里跑的是同一条真实链路（含 require(ESM) 这一层）。
{
    const r = spawnSync(process.execPath, ['-e', [
        "require('./src/infra/log_prefix.js').installLogPrefix();",
        "console.log('probe-log');",
        "console.error('probe-err');",
    ].join(' ')], { encoding: 'utf8', cwd: process.cwd() });

    const outLines = String(r.stdout || '').trim().split('\n').filter(Boolean);
    const errLines = String(r.stderr || '').trim().split('\n').filter(Boolean);

    check('子进程 stdout 带 ISO 前缀', ISO_PREFIX.test(outLines[0] || ''), `「${outLines[0] || ''}」`);
    check('子进程 stderr 带 ISO 前缀（error 也装了）', ISO_PREFIX.test(errLines[0] || ''), `「${errLines[0] || ''}」`);
    check('前缀后面紧接原消息（没被吃掉/改写）',
        /Z probe-log$/.test(outLines[0] || '') && /Z probe-err$/.test(errLines[0] || ''));

    // 单调可排序：同一批输出里，前缀字符串按字典序 = 时间序
    const ts = [...outLines, ...errLines].map((l) => l.slice(0, 24)).filter((t) => ISO_PREFIX.test(t + ' '));
    const sorted = [...ts].sort();
    check('同批次前缀单调可排序（字典序 = 时间序）',
        ts.length >= 2 && ts.join() === sorted.join(), `${ts.length} 个前缀`);
    check('前缀是 UTC 定长毫秒格式（Z 结尾，24 字符）',
        ts.every((t) => t.length === 24 && t.endsWith('Z')));
}

// ---------- 2) 幂等：重复 install 不叠加前缀 ----------
{
    installLogPrefix();
    installLogPrefix();
    installLogPrefix();
    const { out } = capture(() => console.log('idem-probe'));
    const line = out.trim();
    const prefixCount = (line.match(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g) || []).length;
    check('重复 install 3 次后仍只有一个前缀', prefixCount === 1, `「${line}」`);
    check('isLogPrefixInstalled() 返回 true', isLogPrefixInstalled() === true);
}

// ---------- 3) printf 语义：%s/%d/%o 与对象展开必须和原来一致 ----------
{
    const { out } = capture(() => {
        console.log('%s 走了 %d 格', 'bot', 7);
        console.log({ a: 1, b: 'x' });
        console.log('a', 'b', 3);
    });
    const lines = out.trim().split('\n').map((l) => l.replace(/^\S+ /, ''));   // 剥掉前缀看正文

    check('printf %s/%d 语义保留', lines[0] === 'bot 走了 7 格', `「${lines[0]}」`);
    check('对象展开保留（util.inspect 形态）', lines[1] === "{ a: 1, b: 'x' }", `「${lines[1]}」`);
    check('多参数拼接保留', lines[2] === 'a b 3', `「${lines[2]}」`);
}

// ---------- 4) 空参数调用：只出时间戳，不出现 undefined ----------
{
    const { out } = capture(() => console.log());
    const line = out.trim();
    check('console.log() 空参数 → 只有时间戳', ISO_PREFIX.test(line + ' ') && !/undefined/.test(line), `「${line}」`);
}

// ---------- 5) 不改返回值 ----------
{
    // 注意：check() 必须在 capture 外面调用 —— capture 会把 stdout 劫持走，
    // 在里面 check 的话这条 PASS 行会被吞进捕获缓冲，既看不到也不被 unit_all 计数。
    let r;
    capture(() => { r = console.log('ret-probe'); });
    check('console.log 返回值仍是 undefined', r === undefined, `实际 ${String(r)}`);
}

// ---------- 6) 不吞异常：包装层不得 try/catch 兜住原函数的错 ----------
{
    const saved = console.log;
    let threw = false;
    try {
        console.log = () => { throw new Error('boom-from-original'); };
        // 把"会抛错的原函数"包一层，调用时错误必须冒出来
        const res = installLogPrefix({ methods: ['log'] });
        // 若上一行因为已包过而跳过，则这里再手动解绑标记不现实 —— 直接断言包装后仍抛
        if (res.skipped.includes('log')) {
            // 已装过：换成"包住一个会抛的原函数"的场景重新验证
            console.log = () => { throw new Error('boom-from-original'); };
            installLogPrefix({ methods: ['log'] });
        }
        try {
            console.log('x');
        } catch {
            threw = true;
        }
    } finally {
        console.log = saved;
    }
    check('原函数抛错时异常能冒出来（没被吞）', threw === true);
}

// ---------- 7) 只装 log/error/warn，不擅自扩大 ----------
{
    const before = { info: console.info, debug: console.debug };
    installLogPrefix();
    check('console.info 未被改动', console.info === before.info);
    check('console.debug 未被改动', console.debug === before.debug);
}

emit(`\n合计 ${passed} PASS / ${failed} FAIL`);
process.exit(failed ? 1 : 0);
