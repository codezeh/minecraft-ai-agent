/**
 * `board_client.add` 超时回查 离线回归（t65）—— 不需要服务器、不连 socket。
 *
 * 它是什么（`board_client.js:204` 的 `add`）：`board:add` **ack 超时 ≠ 没建成**。
 * 真机踩过：超时判失败 → 上层直接 return fail → 子单一张都不建 → 父单变孤儿 running。
 * 所以 `add()` 收到 TIMEOUT 会 `_findJustAdded(job)` 回查一次：
 *   · 找到同形状的单 → 按**成功**返回（带 `recoveredFromTimeout: true`）
 *   · 找不到 → **仍然返回 TIMEOUT**（宁可漏认，不许假装成功）
 *   · 不是 TIMEOUT（如 INTERNAL）→ **不回查**，原样返回
 *
 * 这一段原来零用例，这里钉住。做法：真 `BoardClient` + 假 socket（构造器对没 `on` 的假
 * socket 是容忍的，见源码注释），把 `_call` 打桩成指定结果，再看 `add()` 的结论。
 *
 * 输出：PASS <用例> / FAIL <用例> <实际>，全过退出码 0。
 */
import { BoardClient } from '../src/agent/library/board_client.js';
import { ok, fail } from '../src/agent/library/contract.js';

let pass = 0, fail_ = 0;
const check = (name, okFlag, detail = '') => {
    if (okFlag) { pass++; console.log(`PASS ${name} ${detail}`); }
    else { fail_++; console.log(`FAIL ${name} ${detail}`); }
};

/** 假 socket：只要有 emit/on 就行（`add` 走 `_call`，我们把它整个打桩掉）。 */
const fakeSocket = { emit: () => { }, on: () => { }, off: () => { } };

/** 刚下进去的那张单（回查的判据：skill + why + source + assignee 全同 + ready/running）。 */
const JOB = { skill: 'mine', args: { ore: 'iron_ore', count: 4 }, why: 'player-command', source: 'player', assignee: 'bot1' };

/**
 * 造一个客户端，`_call` 固定返回 callResult，并给 `_findJustAdded` 装一个计数器。
 * @returns {{c:BoardClient, recall:()=>number}}
 */
function makeClient(callResult, mirror = []) {
    const c = new BoardClient({ name: 'bot1', skills: ['mine'], socket: fakeSocket, timeoutMs: 50 });
    // 打桩：所有 ack 调用都返回指定结果（含 refreshAsync 内部那次 list）
    c._call = async () => callResult;
    // 铺本地镜像（回查读的就是这份镜像）
    for (const j of mirror) c._byId.set(String(j.id), j);
    // 计数器：回查到底有没有被调用（"把回查注释掉 → 这个数字变 0"）
    let n = 0;
    const real = c._findJustAdded.bind(c);
    c._findJustAdded = async (job) => { n++; return real(job); };
    return { c, recall: () => n };
}

const TIMEOUT = fail('TIMEOUT', 'board:add 5000ms 没有 ack', { retryable: true, event: 'board:add' });
const INTERNAL = fail('INTERNAL', '没有 socket 连接', { retryable: true, event: 'board:add' });

// ── ① TIMEOUT + 回查**找到**同形状单 → 当成功返回，并标明 recoveredFromTimeout ──
{
    const { c, recall } = makeClient(TIMEOUT, [
        { id: 'j1', ...JOB, state: 'ready', at: Date.now() / 1000 },
    ]);
    const r = await c.add(JOB);
    const good = r.ok === true && r.data?.recoveredFromTimeout === true
        && r.data?.id === 'j1' && r.data?.job?.id === 'j1'
        && recall() === 1;
    check('① TIMEOUT + 回查找到 → ok:true 且 recoveredFromTimeout:true（回查确实被调用 1 次）',
        good, `ok=${r.ok} recovered=${r.data?.recoveredFromTimeout} id=${r.data?.id} recall=${recall()}`);
}

// ── ② TIMEOUT + 回查**找不到** → 仍然 ok:false（不许假装成功）────────────────
{
    const { c, recall } = makeClient(TIMEOUT, []);          // 镜像空 = 服务端确实没建出来
    const r = await c.add(JOB);
    const good = r.ok === false && r.code === 'TIMEOUT'
        && r.data?.recoveredFromTimeout === undefined && recall() === 1;
    check('② TIMEOUT + 回查找不到 → 仍 ok:false / TIMEOUT（回查过，但没认）',
        good, `ok=${r.ok} code=${r.code} recovered=${r.data?.recoveredFromTimeout} recall=${recall()}`);
}

// ── ③ 非 TIMEOUT 的失败（INTERNAL）→ **不回查**，原样返回 ────────────────────
{
    const { c, recall } = makeClient(INTERNAL, [
        // 故意放一张"看起来能认"的同形状单：如果代码错在"任何失败都回查"，就会被认成功
        { id: 'j2', ...JOB, state: 'ready', at: Date.now() / 1000 },
    ]);
    const r = await c.add(JOB);
    const same = r === INTERNAL;
    const good = r.ok === false && r.code === 'INTERNAL' && recall() === 0 && same;
    check('③ INTERNAL 失败 → 不回查（recall=0）、原样返回（不是被"认"成成功）',
        good, `ok=${r.ok} code=${r.code} recall=${recall()} 同一对象=${same}`);
}

// ── ④ ★ 反向验证：回查认人的判据是"同形状"，形状不同就不许认 ────────────────
//     这一段是"回查"最容易写坏的地方：认错单 = 上层以为建成了，实际是别人的单。
{
    const cases = [
        [{ id: 'a', ...JOB, skill: 'collect', state: 'ready' }, 'skill 不同'],
        [{ id: 'b', ...JOB, why: 'other-reason', state: 'ready' }, 'why 不同'],
        [{ id: 'c', ...JOB, assignee: 'bot2', state: 'ready' }, 'assignee 不同'],
        [{ id: 'd', ...JOB, state: 'done' }, '状态是 done（已结束，不是刚建的）'],
    ];
    const results = [];
    for (const [row, why] of cases) {
        const { c } = makeClient(TIMEOUT, [row]);
        const r = await c.add(JOB);
        results.push({ why, ok: r.ok, code: r.code });
    }
    const good = results.every((x) => x.ok === false && x.code === 'TIMEOUT');
    check('④ 反向验证：形状对不上的单（skill/why/assignee/state）一律不认 → 仍 TIMEOUT',
        good, JSON.stringify(results));
}

// ── ⑤ 反向验证（行为差分）：把"回查"这条路径关掉 → ① 的断言必须变红 ─────────
//     做法：把 `_findJustAdded` 变成"永远找不到"（= 回查被注释掉的效果），
//     同样的 TIMEOUT + 镜像里明明有单，这里必须拿不到 recoveredFromTimeout。
{
    const { c } = makeClient(TIMEOUT, [{ id: 'j1', ...JOB, state: 'ready', at: Date.now() / 1000 }]);
    c._findJustAdded = async () => null;                    // ← 模拟"回查那段被注释掉/失效"
    const r = await c.add(JOB);
    const caseAWouldFail = !(r.ok === true && r.data?.recoveredFromTimeout === true);
    check('⑤ 反向验证：回查失效时 ① 的断言必然不成立（用例不是假绿）',
        caseAWouldFail && r.ok === false && r.code === 'TIMEOUT',
        `ok=${r.ok} code=${r.code} caseA会红=${caseAWouldFail}`);
}

// ── ⑥ 正常路径不受影响：ack 直接成功 → 写进镜像，不加 recoveredFromTimeout ────
{
    const ackJob = { id: 'j9', ...JOB, state: 'ready' };
    const { c, recall } = makeClient(ok({ id: 'j9', job: ackJob }), []);
    const r = await c.add(JOB);
    const good = r.ok === true && r.data?.id === 'j9'
        && r.data?.recoveredFromTimeout === undefined
        && c._byId.get('j9')?.id === 'j9' && recall() === 0;
    check('⑥ ack 正常成功 → 镜像写入、不回查、无 recoveredFromTimeout（原行为不变）',
        good, `ok=${r.ok} id=${r.data?.id} recall=${recall()}`);
}

console.log('============================================');
console.log(`${pass}/${pass + fail_} 个用例通过`);
console.log('============================================');
process.exit(fail_ === 0 ? 0 : 1);
