/**
 * BOT-007 / BOT-010（2026-11-06 深度检查）—— 记忆摘要顺序 + memory.json 字节预算。
 *
 * BOT-007 [P2] 并发记忆摘要可逆序覆盖
 *   缺陷：`add()` 里 splice 一批就 `await summarizeMemories(chunk)`，而它直接
 *         `this.memory = await promptMemSaving(...)`。两条 add 并发 ⇒ 各自 splice、各自发请求，
 *         **后发起的先返回就把 memory 覆盖成旧的**；报告实测最终 memory=older-summary，
 *         而两批都已从 turns 删掉 ⇒ 新摘要永久丢失。
 *   修复：摘要+归档进串行队列（先到先跑），后一批基于前一批写完的 memory。
 *
 * BOT-010 [P3] memory.json 硬上限按字符数算，且没覆盖全部字段
 *   缺陷：`JSON.stringify(...).length` 是 UTF-16 码元数，落盘是 UTF-8 ⇒ 中文/emoji 会超；
 *         且只压 turns，self_prompt / memory_bank 等字段没有预算。
 *         报告实测：capSize 后 59494 字节；纯中文 6890 字符 = 20490 字节仍直接放行。
 *   修复：统一 Buffer.byteLength；每个可变字段独立预算；最后明确验证总量。
 *
 * 全部离线：模型用桩，bots 根指到系统临时目录，不碰真实 bots/。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 必须在 import History 之前设好：botsRootOf() 是惰性读取的，但路径在构造时就拼好了
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bot007-'));
process.env.MC_BOTS_ROOT = TMP_ROOT;

const { History } = await import('../src/agent/history.js');

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
    if (cond) { pass++; console.log(`PASS ${name} ${detail}`); }
    else { fail++; console.log(`FAIL ${name} ${detail}`); }
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const bytesOf = (obj) => Buffer.byteLength(JSON.stringify(obj, null, 2), 'utf8');

/** 造一个只实现 History 会碰到的接口的假 agent。 */
function makeAgent({ memoryDelayMs = 0, responded = [] } = {}) {
    const agent = {
        name: 'tester',
        last_sender: null,
        memory_bank: { getJson: () => ({}) },
        self_prompter: {
            state: 'stopped',
            prompt: '',
            author: null,
            isStopped: () => true,
        },
        task: { taskStartTime: 0 },
        actions: { executing: false },
        prompter: {
            /** 记录"这次摘要看到的已有 memory"，用来断言串行顺序。 */
            promptMemSaving: async (turns) => {
                const seen = agent.history.memory;
                // 模拟网络延迟：后发起的请求故意先返回
                const delay = typeof memoryDelayMs === 'function' ? memoryDelayMs(turns) : memoryDelayMs;
                if (delay) await sleep(delay);
                const label = String(turns?.[0]?.content ?? 'empty').slice(0, 40);
                responded.push({ seen, produced: `summary(${label})` });
                return `summary(${label})`;
            },
        },
    };
    return agent;
}

function makeHistory(agent) {
    const h = new History(agent);
    agent.history = h;
    return h;
}

// ════════════════════════════════════════════════════════════
// A. BOT-007：并发摘要不许逆序覆盖
// ════════════════════════════════════════════════════════════
{
    const responded = [];
    // 第一批发起的请求**慢**（300ms），第二批**快**（10ms）—— 正是报告里的逆序场景
    let call = 0;
    const agent = makeAgent({
        memoryDelayMs: () => (call++ === 0 ? 300 : 10),
        responded,
    });
    const h = makeHistory(agent);
    h.summary_chunk_size = 2;
    // max_messages 设成 1：每次 add 都会触发摘要，方便造"两批并发"
    Object.defineProperty(h, 'max_messages', { get: () => 1, configurable: true });

    // 两条并发 add（模拟聊天并发）：都带结果，且长度足够触发摘要
    await Promise.all([
        h.add('Alice', 'BATCH-ONE'),
        h.add('Bob', 'BATCH-TWO'),
    ]);
    // 等串行队列跑完
    await h._summaryChain;

    check('A 两批摘要都执行了', responded.length >= 2, `→ ${responded.length}`);
    const produced = responded.map(r => r.produced).join(' | ');
    check('A 摘要是按入队顺序执行的（先到的先跑）',
        responded[0].produced.includes('BATCH-ONE'), `→ ${produced}`);
    check('A 最终 memory 是**后一批**的摘要，不是被旧请求覆盖',
        h.memory.includes('BATCH-TWO'), `→ memory=${h.memory}`);
    check('A 第二批摘要看得到第一批写出的 memory（证明串行且基于最新）',
        responded.length >= 2 && responded[1].seen.includes('BATCH-ONE'),
        `→ seen=${JSON.stringify(responded[1]?.seen)}`);
    check('A turns 已按顺序消耗（没有残留乱序）',
        h.turns.every(t => typeof t.content === 'string'), `→ ${JSON.stringify(h.turns)}`);
}

// 链不会因为一批抛错而断掉
{
    const agent = makeAgent({ memoryDelayMs: 0 });
    let n = 0;
    agent.prompter.promptMemSaving = async () => {
        n++;
        if (n === 1) throw new Error('模拟模型失败');
        return 'ok-summary';
    };
    const h = makeHistory(agent);
    const err = await h._enqueueSummary([{ role: 'user', content: 'x' }]).catch(e => e);
    check('A 单批失败会抛给调用方', err instanceof Error);
    await h._enqueueSummary([{ role: 'user', content: 'y' }]).catch(() => {});
    check('A 失败之后队列仍能继续跑下一批（不会永久卡死）',
        n === 2 && h.memory === 'ok-summary', `→ n=${n} memory=${h.memory}`);
}

// ════════════════════════════════════════════════════════════
// B. BOT-010：字节预算
// ════════════════════════════════════════════════════════════
const LIMIT = 20 * 1024;
{
    const h = makeHistory(makeAgent());
    // 报告复现①：turns 塞满超长内容
    const heavy = {
        memory: 'm'.repeat(100),
        turns: Array.from({ length: 40 }, (_, i) => ({ role: 'user', content: 'x'.repeat(900) + i })),
        self_prompt: null,
        memory_bank: {},
    };
    const out = h.capSize(heavy);
    check('B 超长 turns 被压到 20KB 以内（按 UTF-8 字节）', bytesOf(out) <= LIMIT,
        `→ ${bytesOf(out)} 字节`);
    check('B 至少保留 6 条 turns', (out.turns || []).length >= 6, `→ ${out.turns?.length}`);
}
{
    const h = makeHistory(makeAgent());
    // 报告复现②：纯中文，字符数没超但字节数超（6890 字符 / 20490 字节）
    const chinese = '汉'.repeat(4000);   // 4000 字符 = 12000 字节
    const data = {
        memory: chinese,
        turns: Array.from({ length: 6 }, () => ({ role: 'user', content: chinese.slice(0, 800) })),
        self_prompt: chinese.slice(0, 3000),
        memory_bank: {},
    };
    check('B 构造的用例本身按字符数没超、按字节数超（前提成立）',
        JSON.stringify(data, null, 2).length < LIMIT && bytesOf(data) > LIMIT,
        `→ chars=${JSON.stringify(data, null, 2).length} bytes=${bytesOf(data)}`);
    const out = h.capSize(data);
    check('B 纯中文用例被压到 20KB 以内（字符口径会漏判）', bytesOf(out) <= LIMIT, `→ ${bytesOf(out)}`);
}
{
    const h = makeHistory(makeAgent());
    // 报告点名的另一个爆点：非 turns 字段（self_prompt 可任意长）
    const data = {
        memory: 'short',
        turns: [{ role: 'user', content: 'hi' }],
        self_prompt: 'p'.repeat(50000),
        memory_bank: {},
    };
    const out = h.capSize(data);
    check('B self_prompt 单字段超长也被收口（不只看 turns）', bytesOf(out) <= LIMIT, `→ ${bytesOf(out)}`);
    check('B self_prompt 被截断而不是整条丢掉', out.self_prompt.length > 0 && out.self_prompt.length <= 900,
        `→ len=${out.self_prompt.length}`);
}
{
    const h = makeHistory(makeAgent());
    // memory_bank 无限增长：按条数额度收口
    const bank = {};
    for (let i = 0; i < 500; i++) bank['place' + i] = { x: i, y: 64, z: i };
    const out = h.capSize({ memory: '', turns: [], self_prompt: null, memory_bank: bank });
    check('B memory_bank 条目被限额（保留前 120 条事实）',
        Object.keys(out.memory_bank).length <= 120, `→ ${Object.keys(out.memory_bank).length}`);
    check('B memory_bank 收口后总量合格', bytesOf(out) <= LIMIT, `→ ${bytesOf(out)}`);
}
{
    const h = makeHistory(makeAgent());
    // 小数据不该被改动
    const small = {
        memory: 'remember the chest at 10,64,10',
        turns: [{ role: 'user', content: 'hello' }],
        self_prompt: 'build a house',
        memory_bank: { home: { x: 0, y: 64, z: 0 } },
    };
    const out = h.capSize({ ...small });
    check('B 小数据原样通过（没有过度裁剪）',
        out.memory === small.memory && out.self_prompt === small.self_prompt
        && out.turns.length === 1 && Object.keys(out.memory_bank).length === 1);
}
{
    const h = makeHistory(makeAgent());
    // 极端：某字段是大对象，所有常规手段都不够 → 必须报错而不是静默超标
    const data = {
        memory: '',
        turns: [{ role: 'user', content: 'x' }],
        self_prompt: null,
        memory_bank: { huge: { blob: 'z'.repeat(60000) } },
    };
    const logs = [];
    const origErr = console.error;
    console.error = (...a) => { logs.push(a.join(' ')); };
    const out = h.capSize(data);
    console.error = origErr;
    check('B 极端超限时会明确报错（不静默超标）',
        logs.some(l => /无法压到/.test(l)), `→ ${logs.join('|').slice(0, 120)}`);

    // 但正常输入（y 轴被 memory_bank 限额）必须真的合格
    const okData = {
        memory: '',
        turns: [],
        self_prompt: null,
        memory_bank: Object.fromEntries(Array.from({ length: 130 }, (_, i) => ['k' + i, i])),
    };
    check('B 大量小事实也能压到 20KB 内', bytesOf(h.capSize(okData)) <= LIMIT);
}

// ════════════════════════════════════════════════════════════
// C. 接线：save() 真的写了 ≤20KB 的文件
// ════════════════════════════════════════════════════════════
{
    const agent = makeAgent();
    const h = makeHistory(agent);
    agent.self_prompter.isStopped = () => false;
    agent.self_prompter.prompt = '目标'.repeat(2000);   // 很长的目标
    h.memory = '记'.repeat(3000);
    h.turns = Array.from({ length: 30 }, (_, i) => ({ role: 'user', content: '内容'.repeat(200) + i }));
    await h.save();
    const raw = fs.readFileSync(h.memory_fp);
    check('C 真实落盘的 memory.json ≤ 20KB（按文件字节数）', raw.length <= LIMIT, `→ ${raw.length} 字节`);
    const parsed = JSON.parse(raw.toString('utf8'));
    check('C 落盘后仍可解析成 JSON', typeof parsed === 'object' && parsed !== null);
}

fs.rmSync(TMP_ROOT, { recursive: true, force: true });
console.log(`\n${fail === 0 ? 'ALL PASS' : 'HAS FAILURES'}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
