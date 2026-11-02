/**
 * M9 code_hints 单测（08 §4）。
 *
 * 最重要的一条：**CODES 里每个码都必须有具体建议** —— 缺了不是"少一句话"，
 * 是模型收到一个它不知道怎么办的码。
 */
import { CODES } from '../src/agent/library/contract.js';
import { hintFor, hasHintFor, hintedCodes, formatOutcome } from '../src/agent/library/code_hints.js';

let pass = 0, fails = 0;
const ok = (n, e = '') => { pass++; console.log(`PASS ${n} ${e}`); };
const bad = (n, a) => { fails++; console.log(`FAIL ${n} ${JSON.stringify(a)}`); };

// ① ★ 全覆盖：每个 CODES 成员都有具体 hint（不是兜底）
{
    const missing = CODES.filter((c) => !hasHintFor(c));
    if (missing.length === 0) ok(`① 全部 ${CODES.length} 个码都有具体建议（不是兜底）`, `count=${CODES.length}`);
    else bad('① 有码没有具体建议', missing);
}

// ② hintFor 永不返回空（未知码走兜底）
{
    const unknown = hintFor('SOME_FUTURE_CODE');
    const empty = hintFor('');
    const nullish = hintFor(null);
    const good = unknown && unknown.length > 5 && empty && nullish
        && !CODES.some((c) => !hintFor(c) || hintFor(c) === 'undefined');
    if (good) ok('② hintFor 对未知/空码也有非空兜底（不会 undefined）', unknown.slice(0, 24));
    else bad('② hintFor 兜底', { unknown, empty, nullish });
}

// ③ 08 §4 表里点名的 8 个码，建议必须**可执行**（含动作或明确的下一步指令）
{
    const required = ['NO_TOOL', 'NO_ITEM', 'NO_TARGET', 'NO_PATH', 'STUCK', 'INVENTORY_FULL', 'TIMEOUT', 'CLAIM_CONFLICT'];
    const weak = required.filter((c) => {
        const h = hintFor(c);
        // 至少要有"做什么"的动词或 !do/换个 之类的指令
        return !/(!do|先|换|问玩家|不用管|报一下)/.test(h);
    });
    if (weak.length === 0) ok('③ 08 §4 点名的 8 个码建议都可执行', `${required.length} 个`);
    else bad('③ 建议不可执行', weak);
}

// ④ 格式：一行、≤200 字、含 code 与"建议"
{
    const long = 'x'.repeat(500);
    const s = formatOutcome({
        result: { ok: false, code: 'NO_TOOL', message: long, data: { count: 3, want: 16 } },
        job: { id: 'j_20261102_0012', skill: 'collect' },
    });
    const oneLine = !s.includes('\n');
    const short = s.length <= 200;
    const hasCode = s.includes('NO_TOOL');
    const hasAdvice = s.includes('建议');
    const hasJob = /#0012/.test(s);
    const hasProg = /3\/16/.test(s);
    if (oneLine && short && hasCode && hasAdvice && hasJob && hasProg) {
        ok('④ 格式：一行 ≤200 字，含 #单号/code/进度/建议', `len=${s.length}`);
    } else {
        bad('④ 格式', { oneLine, short, len: s.length, hasCode, hasAdvice, hasJob, hasProg });
    }
}

// ⑤ 成功时不带"建议"，带进度
{
    const s = formatOutcome({ result: { ok: true, code: 'OK', data: { count: 16, want: 16 } }, job: { id: 'j_1', skill: 'collect' } });
    if (s.includes('成功') && !s.includes('建议') && s.includes('16/16')) ok('⑤ 成功：报进度、不带建议', s.slice(0, 50));
    else bad('⑤ 成功格式', s);
}

// ⑥ 没有 count/want 时不编造进度
{
    const s = formatOutcome({ result: { ok: false, code: 'NO_PATH' }, label: '!walkTo' });
    if (!/采到/.test(s) && s.includes('NO_PATH') && s.includes('!walkTo')) ok('⑥ 没进度就不编造（不写"采到 x/y"）', s.slice(0, 60));
    else bad('⑥ 编造进度', s);
}

// ⑦ 每个码都能被 formatOutcome 正常格式化（不抛、不超长）
{
    const bads = [];
    for (const c of CODES) {
        try {
            const s = formatOutcome({ result: { ok: false, code: c, message: 'm'.repeat(300) } });
            if (s.length > 200 || !s.includes(c)) bads.push(c);
        } catch (e) { bads.push(c + ':' + e.message); }
    }
    if (bads.length === 0) ok('⑦ 全部 38 个码都能格式化且 ≤200 字', `count=${CODES.length}`);
    else bad('⑦ 格式化失败/超长', bads);
}

console.log('============================================');
console.log(`${pass}/${pass + fails} 个用例通过`);
console.log('============================================');
process.exit(fails === 0 ? 0 : 1);
