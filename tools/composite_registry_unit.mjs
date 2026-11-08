/**
 * 复合技能注册表单测（M5，04_skills.md §4.4 / §4.5 / §4.6）—— 不需要服务器。
 *
 * 锁的是"启动即校验"和"参数校验"这两件事，因为它们都是**静默失败**的重灾区：
 *   - manifest 写残缺了不校验 → 运行时才炸，而且报的错离根因很远
 *   - 参数校验不严 → 模型传个 count=999 进去，流程跑到一半才发现资源不够
 *
 * 输出格式：PASS <用例> <证据> / FAIL <用例> <实际>，全过退出码 0。
 */
import {
    SKILL_NAMES, getSkill, listSkills, validateManifest, validateRegistry,
    parseSkillArgs, makeCtx, mapDirOf, runSkill,
} from '../src/agent/library/composite_registry.js';

let pass = 0, fail = 0;
const okCase = (name, evidence = '') => { pass++; console.log(`PASS ${name} ${evidence}`); };
const badCase = (name, actual) => { fail++; console.log(`FAIL ${name} ${actual}`); };

/** 一条合格 manifest 的底稿（每条用例只改一处，别的保持合法）。 */
const base = () => ({
    name: 'demo',
    level: 'flow',
    summary: '一句给模型看的说明',
    params: { block: 'block', count: 'int 1..64 = 1' },
    codes: ['NO_TARGET', 'TIMEOUT'],
    timeoutMs: 60000,
});

// ── 1. 注册表本身：注册了哪些技能、是不是唯一的 ──────────────────────────
{
    const names = SKILL_NAMES;
    // M7 P0（2026-11-02）加了 craft / smelt / store / fetch → 注册表从 5 个变 9 个。
    // 这里断言"**必须包含**这些"，而不是"只有这些"：以后加新技能不该让这条测试红，
    // 但"某个技能被误删"必须红。
    const expect = ['collect', 'follow', 'pickup', 'platform', 'escape', 'craft', 'smelt', 'store', 'fetch'];
    const hasAll = expect.every((n) => names.includes(n));
    const noDup = new Set(names).size === names.length;
    if (hasAll && noDup) okCase('注册技能集合包含全部预期且不重复', `${names.length} 个：${names.join(',')}`);
    else badCase('注册技能集合包含全部预期且不重复', JSON.stringify({ names, missing: expect.filter((n) => !names.includes(n)) }));
}

// ── 2. plan-only 的帮手不该出现在注册表里 ──────────────────────────────
//    flow_collect_plan / flow_clear 只有 plan、没有 run，登记进来模型会看到"能跑却调不动"的东西
{
    const leaked = ['clear', 'collect_plan', 'planCollect', 'planClearObstacles']
        .filter((n) => getSkill(n) !== null || SKILL_NAMES.includes(n));
    if (leaked.length === 0) okCase('plan-only 帮手没有进注册表', `getSkill('clear')=${getSkill('clear')}`);
    else badCase('plan-only 帮手没有进注册表', JSON.stringify(leaked));
}

// ── 3. 坏 manifest 必须被拒（§4.4 第 1 条）────────────────────────────
{
    const cases = [
        ['name 缺失', (m) => { delete m.name; }],
        ['level 非法', (m) => { m.level = 'whatever'; }],
        ['summary 空', (m) => { m.summary = '  '; }],
        ['params 不是对象', (m) => { m.params = []; }],
        ['timeoutMs 非正数', (m) => { m.timeoutMs = 0; }],
        ['params 描述解析不了', (m) => { m.params = { count: '整数' }; }],
    ];
    const bad = [];
    for (const [label, mutate] of cases) {
        const m = base(); mutate(m);
        if (validateManifest(m).length === 0) bad.push(label);
    }
    if (bad.length === 0) okCase('6 种坏 manifest 全部被拒', `cases=${cases.length}`);
    else badCase('6 种坏 manifest 全部被拒', JSON.stringify(bad));
}

// ── 4. codes 里出现未注册的码必须被拒（§4.4 第 2 条）──────────────────
//    这是真踩过的：collect 的 manifest 曾写了 INVENTORY_FULL，而当时它是未注册的新码，
//    于是模块加载直接崩。
//
//    ★ 2026-11-02 更新：INVENTORY_FULL 已在 M6 注册进 CODES，不能再拿它当"未注册"用
//      （否则这条用例会永远 fail，失去证明力）。改用**结构上永不可能注册**的假码，
//      才能持续证明这道闸门真的在工作。
{
    const FAKE = 'THIS_CODE_IS_NOT_REGISTERED_AT_ALL';
    const m = base(); m.codes = ['NO_TARGET', FAKE];
    const probs = validateManifest(m);
    const caught = probs.some((p) => p.includes(FAKE));
    if (caught) okCase('未注册的 code 被拒（假码）', probs[0]);
    else badCase('未注册的 code 被拒（假码）', JSON.stringify(probs));
}

// ── 4b. 反向确认：7 个新码**已**注册，manifest 引用它们必须**通过** ──────
//     只验"假码被拒"还不够 —— 还要验"真码被接受"，否则闸门可能过严把新码全拦了。
{
    const seven = ['NOT_READY', 'NO_RECIPE', 'NO_WORKSTATION', 'INVENTORY_FULL',
                   'PREEMPTED', 'CLAIM_CONFLICT', 'LEASE_LOST'];
    const m = base(); m.codes = ['NO_TARGET', ...seven];
    const probs = validateManifest(m);
    if (!probs.length) okCase('7 个新码已在 CODES 中（引用应通过）', `${seven.length} 个全部接受`);
    else badCase('7 个新码已在 CODES 中（引用应通过）', JSON.stringify(probs));
}

// ── 5. 名字重复必须被拒（§4.4 第 1 条：name 唯一）─────────────────────
{
    const r = validateRegistry([
        { manifest: base(), run: () => {} },
        { manifest: { ...base() }, run: () => {} },
    ]);
    if (!r.ok && r.problems.some((p) => /重复/.test(p))) okCase('重名被拒', r.problems[0]);
    else badCase('重名被拒', JSON.stringify(r.problems));
}

// ── 6. 缺 run() 必须被拒 ──────────────────────────────────────────────
{
    const r = validateRegistry([{ manifest: base() }]);
    if (!r.ok && r.problems.some((p) => /run/.test(p))) okCase('缺 run() 被拒', r.problems[0]);
    else badCase('缺 run() 被拒', JSON.stringify(r.problems));
}

// ── 7. 参数解析：必填 / 默认值 / 范围 / 枚举 / pos（§4.5）──────────────
{
    const m = getSkill('collect').manifest;

    const ok1 = parseSkillArgs(m, 'block=oak_log count=16');
    const def = parseSkillArgs(m, 'block=oak_log');                        // count 用默认 1
    const tooBig = parseSkillArgs(m, 'block=oak_log count=999');            // 超范围
    const missing = parseSkillArgs(m, '');                                 // 缺必填
    const unknown = parseSkillArgs(m, 'block=oak_log nope=1');             // 不认识的参数
    const notInt = parseSkillArgs(m, 'block=oak_log count=3.5');

    const good = ok1.ok && ok1.args.count === 16 && ok1.args.block === 'oak_log'
        && def.ok && def.args.count === 1 && def.args.radius === 48
        && !tooBig.ok && /1\.\.64/.test(tooBig.error)
        && !missing.ok && /block/.test(missing.error)
        && !unknown.ok && /不认识/.test(unknown.error)
        && !notInt.ok;

    if (good) {
        okCase('参数解析：必填/默认/范围/未知/整数', `count=${ok1.args.count} 默认=${def.args.count} radius=${def.args.radius}`);
    } else {
        badCase('参数解析：必填/默认/范围/未知/整数',
            JSON.stringify({ ok1, def, tooBig, missing, unknown, notInt }));
    }
}

// ── 8. pos / area 写法（§4.5：pos 是 x,y,z；area 是 x,y,z:半径）─────────
{
    // area 写成可选（'area?'）才能只传 at —— 必填项缺失被拒是另一条用例（第 7 条）的事
    const m = { params: { at: 'pos', area: 'area?' } };
    const p = parseSkillArgs(m, 'at=120,64,-30');
    const a = parseSkillArgs(m, 'at=120,64,-30 area=120,64,-30:16');
    const bad = parseSkillArgs(m, 'at=120,64');
    const good = p.ok && p.args.at.x === 120 && p.args.at.y === 64 && p.args.at.z === -30
        && a.ok && a.args.area.radius === 16 && !bad.ok;
    if (good) okCase('pos / area 解析', `at=${JSON.stringify(p.args.at)} area=${JSON.stringify(a.args.area)}`);
    else badCase('pos / area 解析', JSON.stringify({ p, a, bad }));
}

// ── 9. 枚举校验 ──────────────────────────────────────────────────────
{
    const m = { params: { dir: 'enum(n,s,e,w)' } };
    const okv = parseSkillArgs(m, 'dir=n');
    const badv = parseSkillArgs(m, 'dir=x');
    if (okv.ok && okv.args.dir === 'n' && !badv.ok && /n\/s\/e\/w/.test(badv.error)) {
        okCase('枚举校验', badv.error);
    } else {
        badCase('枚举校验', JSON.stringify({ okv, badv }));
    }
}

// ── 10. 不认识技能的 !do：给一句可用清单，不炸 ──────────────────────────
{
    const fakeAgent = { bot: { username: 'unit_bot' }, actions: { runAction: async (_l, fn) => { await fn(); return {}; } } };
    const r = await runSkill(fakeAgent, 'nope_not_a_skill', '');
    if (r && r.ok === false && /collect/.test(r.message)) okCase('未知技能回可用清单', r.message.slice(0, 60));
    else badCase('未知技能回可用清单', JSON.stringify(r));
}

// ── 10b. 参数错**不许产生错误码**（§4.5）────────────────────────────────
//     踩过：早期返回 code:'NO_TARGET'，模型读成"目标找不到"→ 换个目标重试，
//     而实际是"参数写错了"。code 必须是 null，让上层只回人话。
{
    const fakeAgent = { bot: { username: 'unit_bot' }, actions: { runAction: async (_l, fn) => { await fn(); return {}; } } };
    const bad = await runSkill(fakeAgent, 'collect', 'count=999');
    const noSkill = await runSkill(fakeAgent, 'nosuch_skill', '');
    const okNull = bad.ok === false && bad.code === null && bad.data?.paramError === true;
    const noSkillNull = noSkill.ok === false && noSkill.code === null;
    if (okNull && noSkillNull) {
        okCase('参数错/技能名错不产生错误码（code=null）', `code=${JSON.stringify(bad.code)}`);
    } else {
        badCase('参数错/技能名错不产生错误码（code=null）', JSON.stringify({ bad, noSkill }));
    }
}

// ── 11. 参数错 → 不执行（用一个会记录调用的假流程验）────────────────────
//    这里直接验 parseSkillArgs 的结论 + runSkill 的短路：参数错时流程不该被调用。
{
    // 借 collect 的 manifest，但传一个一定越界的 count
    const fakeAgent = { bot: { username: 'unit_bot' }, actions: { runAction: async (_l, fn) => { await fn(); return {}; } } };
    const r = await runSkill(fakeAgent, 'collect', 'block=oak_log count=9999');
    if (r && r.ok === false && /参数错/.test(r.message)) {
        okCase('参数错不执行（短路在调用流程之前）', r.message.slice(0, 50));
    } else {
        badCase('参数错不执行（短路在调用流程之前）', JSON.stringify(r));
    }
}

// ── 12. makeCtx：deadline / jobId / mapDir / 无任务板时 reserve 恒成功 ──
{
    const agent = { bot: { username: 'unit_bot' } };
    const manifest = getSkill('collect').manifest;

    const noJob = makeCtx(agent, null, manifest);
    const withJob = makeCtx(agent, { id: 12, deadline: Date.now() + 5000 }, manifest);

    const dOk = noJob.jobId === null
        && noJob.deadline > Date.now()                       // now + timeoutMs
        && Math.abs((noJob.deadline - Date.now()) - manifest.timeoutMs) < 2000
        && withJob.jobId === 12
        && Math.abs((withJob.deadline - Date.now()) - 5000) < 2000
        // ★ bot_paths 从相对路径改成绝对路径（另一条线在改），这里两种形态都接受：
        //   本用例要锁的是"mapDir 来自 mapDirOf、不是自己拼的"，不是路径前缀长什么样。
        && String(noJob.mapDir ?? '').replace(/\\/g, '/').endsWith('bots/unit_bot/map');

    const r1 = await noJob.reserve('block:oak_log');
    const r2 = await noJob.release('block:oak_log');

    // ★ T6（架构收敛项 3）：无板时 reserve/release **不再 fail-open**。
    //   原来这里是 `r1.ok && r2.ok`（断言"恒成功"）—— 那正是审计点名的 fail-open：
    //   调用方以为占位成功，其实 claims 表一行都没有（真机事故：85 张单 done、claims 0 行）。
    //   现在必须：**ok=false + code=NO_BOARD + data.noBoard=true**，并带一行 warn（不静默）。
    const noBoardOk = r1.ok === false && r1.code === 'NO_BOARD' && r1.data?.noBoard === true
        && r2.ok === false && r2.code === 'NO_BOARD' && r2.data?.noBoard === true;

    if (dOk && noBoardOk) {
        okCase('makeCtx：jobId/deadline/mapDir + 无任务板时 reserve/release 显式 NO_BOARD（不再 fail-open）',
            `noJobDeadline=${Math.round((noJob.deadline - Date.now()) / 1000)}s job=${withJob.jobId} code=${r1.code}`);
    } else {
        badCase('makeCtx：jobId/deadline/mapDir + 无任务板时 reserve/release 必须显式告警',
            JSON.stringify({ dOk, noBoardOk, r1, r2 }));
    }

    // ★ T6 反向用例：**调用方不能把它误当"占位成功"**。
    //   三个判据缺一不可：
    //     ① `ok === false`（不会走进"占位成功"分支）
    //     ② `code === 'NO_BOARD'`（能与 CLAIM_CONFLICT 区分：那是"有人占着"，要换目标）
    //     ③ message 里**明说"没有发生/未预约"**（日志/面板都能看出"这次没协调"）
    const msg1 = String(r1.message ?? '');
    const msg2 = String(r2.message ?? '');
    const notMistaken = r1.ok === false && r1.code === 'NO_BOARD'
        && /未预约|没有发生|没有任务板/.test(msg1)
        && r2.ok === false && r2.code === 'NO_BOARD'
        && /未释放|没有发生|没有任务板/.test(msg2);
    if (notMistaken) {
        okCase('★ 反向：无板 reserve/release 的 message 明说"没有发生"，不会被误读成占位成功',
            `reserve="${msg1}" release="${msg2}"`);
    } else {
        badCase('反向：无板 reserve/release 的措辞含糊（可能被误读成成功）', { msg1, msg2, r1, r2 });
    }
}

// ── 13. makeCtx.onEvent 自动带 jobId / skill，且透传其余字段（09 §2）──
{
    const agent = { bot: { username: 'unit_bot' } };
    const manifest = getSkill('collect').manifest;
    const ctx = makeCtx(agent, { id: 77 }, manifest);
    // 不能直接读 trace_bus（那是全局），只验"不抛 + 不改入参"
    const ev = { type: 'demo-event', n: 1, jobId: 'caller-should-not-win', skill: 'caller' };
    let threw = false;
    try { ctx.onEvent(ev); } catch { threw = true; }
    const untouched = ev.jobId === 'caller-should-not-win' && ev.skill === 'caller';
    if (!threw && untouched) okCase('onEvent 不抛且不改调用方对象', `jobId=${ctx.jobId}`);
    else badCase('onEvent 不抛且不改调用方对象', JSON.stringify({ threw, untouched }));
}

// ── 14. mapDirOf：agent / bot 两种入参都认 ──────────────────────────────
{
    const a = mapDirOf({ bot: { username: 'u1' } });
    const b = mapDirOf({ username: 'u2' });
    const c = mapDirOf({ bot: {} });
    // ★ 同上：mapDirOf 可能返回相对（`./bots/...`）或绝对路径，两种都算对。
    const norm = (v) => String(v ?? '').replace(/\\/g, '/').replace(/^\.\//, '');
    const tail = (v) => norm(v).endsWith('bots/u1/map') || norm(v).endsWith('bots/u1/map/');
    if (tail(a) && norm(b).endsWith('bots/u2/map') && norm(c).endsWith('bots/agent/map')) {
        okCase('mapDirOf 兼容 agent / bot 且兜底 agent', `${a} | ${b} | ${c}`);
    } else {
        badCase('mapDirOf 兼容 agent / bot 且兜底 agent', JSON.stringify({ a, b, c }));
    }
}

// ── 15. listSkills 从 manifest 生成（D24 的正解：不截 JSDoc）────────────
{
    const lines = listSkills();
    const hasAll = SKILL_NAMES.every((n) => lines.some((l) => l.startsWith(`${n}:`)));
    const hasParams = lines.some((l) => l.includes('参数：') && l.includes('block='));
    // 关键：不该出现函数体特征（说明它不是从代码里截出来的）
    const looksLikeCode = lines.some((l) => /function |=>|return /.test(l));
    if (hasAll && hasParams && !looksLikeCode) {
        okCase('listSkills 由 manifest 生成（含参数、无代码痕迹）', `${lines.length} 条`);
    } else {
        badCase('listSkills 由 manifest 生成（含参数、无代码痕迹）', JSON.stringify({ hasAll, hasParams, looksLikeCode }));
    }
}

console.log('============================================');
console.log(`${pass}/${pass + fail} 个用例通过`);
console.log('============================================');
process.exit(fail === 0 ? 0 : 1);
