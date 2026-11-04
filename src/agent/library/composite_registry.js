/**
 * 复合技能注册表 + `ctx` 工厂（M5，04_skills.md §4.4 / §4.6）。
 *
 * 要解决的问题：
 *   复合技能散在各模块里，模型**看不到有哪些技能、各自要什么参数**。
 *   以前这份说明书是从函数体里截 JSDoc 拼的，而截法有 bug（D24）：注释以单星号闭合时
 *   `indexOf` 找闭合注释符返回 -1，于是整段函数体被当成「文档」塞进上下文 ——
 *   实测 104 条里 36 条超长、合计 5.5 万字符，模型看到的是代码而不是说明。
 *   现在改成：每个流程**自己声明 manifest**，注册表统一校验、统一生成给模型看的清单。
 *
 * 三条硬约束（规范要求，别自作聪明）：
 *   1) **显式 import，不扫目录**：顺序确定，能逐个审。扫目录会让"漏写 manifest 就没注册上"
 *      变成静默失败 —— 那是最难查的一类 bug。
 *   2) **启动即校验，不合格就抛**：宁可启动崩，也不要带病跑到运行时再报一个离根因很远的错。
 *   3) `makeCtx().onEvent` 是**唯一**写 trace_bus 的地方（09 §2 / D10）。
 *      里面各层只调传进来的 `onEvent`；再开第二个写入口就变回"每个事件记两遍"。
 */
import { CODES } from './contract.js';
import { collectSilent } from './trace_bus.js';
// 本地绑定：`export { x } from './y.js'` 只转发、**不在本模块作用域建绑定**，
// 而 makeCtx 里要直接调 mapDirOf，所以必须单独 import 一次（2026-11-02 踩过）。
import { mapDirOf } from './bot_paths.js';

import { manifest as manifestCollect, collect as runCollect } from './flow_collect.js';
import { manifest as manifestFollow, follow as runFollow } from './flow_follow.js';
import { manifest as manifestPickup, collectDrops as runPickup } from './flow_pickup.js';
import { manifest as manifestPlatform, placePlatform as runPlatform } from './flow_platform.js';
import { manifest as manifestEscape, escapeUp as runEscapeUp } from './flow_escape.js';
// M7 P0（2026-11-02）：合成 / 熔炼 / 存取 三个流程。
import { manifest as manifestCraft, craft as runCraft } from './flow_craft.js';
import { manifest as manifestSmelt, smelt as runSmelt } from './flow_smelt.js';
import { manifestStore as manifestStore, manifestFetch as manifestFetch, store as runStore, fetch as runFetch } from './flow_store.js';
// M7 P0 第二批（2026-11-02）：吃 / 挖 / 农 / 打 / 建。
import { manifest as manifestEat, eatToFull as runEat } from './flow_eat.js';
import { manifest as manifestMine, mine as runMine } from './flow_mine.js';
import { manifest as manifestFarm, farm as runFarm } from './flow_farm.js';
import { manifest as manifestFight, fight as runFight } from './flow_fight.js';
import { manifest as manifestBuild, build as runBuild } from './flow_build.js';
import { manifest as manifestShelter, shelter as runShelter } from './flow_shelter.js';
// M10 策略层（04 §6.3）：只拆子单、不自己做动作。
import { manifestObtain, obtain as runObtain } from './strat_obtain.js';
import { manifestToolTier, toolTier as runToolTier } from './strat_tool_tier.js';
import { manifest as manifestFirstNight, firstNight as runFirstNight } from './strat_first_night.js';

/**
 * 注册项 = manifest + 执行入口。
 *
 * `run(bot, args, ctx)` 里的 `args` 已按 `manifest.params` 校验过（类型、范围、默认值都填好）。
 * 各流程原本的签名（如 `collect(bot, name, want, opts)`）由这里的适配层翻译 ——
 * **适配只搬参数，不改流程内部逻辑**。timeout 一律按 ctx.deadline 折算（07 §8：
 * 内层不超过外层剩余时间）。
 */
// 注册表的构成（**18 个**，都是"能自己跑完一件事"的流程）：
//   collect / follow / pickup / platform / escape（M5）
//   craft / smelt / store / fetch（M7 P0 第一批，2026-11-02）
//   eat / mine / farm / fight / build（M7 P0 第二批，2026-11-02）
//   shelter（M10，2026-11-03）—— flow；解锁 idle_planner 第 1 层的"天黑没地方待"
//   obtain / tool_tier / first_night（M10 策略层，2026-11-03）—— level:'strat'，只拆子单
// 没有进表的两个，都是**只有 plan、没有 run** 的内部帮手（04 §4.4 要求 manifest 描述的是
// "一个能执行并返回 ActionResult 的技能"）：
//   · flow_collect_plan —— flow_collect 的内部实现（planCollect / makeHandlers / climbByTunneling）
//   · flow_clear       —— 只产出"清障碍"的步骤序列，由 flow_collect 拼进自己的 plan
// 把它们登记进来会让模型看到"able to run"却调不动的东西。
const ENTRIES = [
    {
        manifest: manifestCollect,
        run: (bot, args, ctx) => runCollect(bot, args.block, args.count, {
            deadlineMs: remaining(ctx),
            radius: args.radius,
            mapDir: ctx.mapDir,
            onEvent: ctx.onEvent,
        }),
    },
    {
        manifest: manifestFollow,
        run: (bot, args, ctx) => runFollow(bot, args.player, {
            distance: args.distance,
            deadlineMs: remaining(ctx),
            mapDir: ctx.mapDir,
            onEvent: ctx.onEvent,
        }),
    },
    {
        manifest: manifestPickup,
        run: (bot, args, ctx) => runPickup(bot, args.at, {
            deadlineMs: remaining(ctx),
            mapDir: ctx.mapDir,
            onEvent: ctx.onEvent,
        }),
    },
    {
        manifest: manifestPlatform,
        run: (bot, args, ctx) => runPlatform(bot, args.item, args.at, {
            deadlineMs: remaining(ctx),
            onEvent: ctx.onEvent,
        }),
    },
    {
        manifest: manifestEscape,
        run: (bot, args, ctx) => runEscapeUp(bot, {
            deadlineMs: remaining(ctx),
            mapDir: ctx.mapDir,
            onEvent: ctx.onEvent,
        }),
    },
    // ── M7 P0：合成 / 熔炼 / 存取 ─────────────────────────────────────
    {
        manifest: manifestCraft,
        run: (bot, args, ctx) => runCraft(bot, args.item, args.count),
    },
    {
        manifest: manifestSmelt,
        run: (bot, args, ctx) => runSmelt(bot, args.input, args.count, {
            fuel: args.fuel,          // 'item?' —— 没给就由流程按 煤>木炭>木板>原木 挑
            ctx,
        }),
    },
    {
        manifest: manifestStore,
        run: (bot, args, ctx) => runStore(bot, args.item, args.count, { ctx }),
    },
    {
        manifest: manifestFetch,
        run: (bot, args, ctx) => runFetch(bot, args.item, args.count, { ctx }),
    },
    // ── M7 P0 第二批：吃 / 挖 / 农 / 打 / 建 ─────────────────────────
    {
        manifest: manifestEat,
        run: (bot, args, ctx) => runEat(bot, { food: args.food, targetFood: args.targetFood, ctx }),
    },
    {
        manifest: manifestMine,
        run: (bot, args, ctx) => runMine(bot, args.ore, args.count, { maxDepth: args.maxDepth, ctx }),
    },
    {
        manifest: manifestFarm,
        run: (bot, args, ctx) => runFarm(bot, args.area, { crop: args.crop, seed: args.seed, ctx }),
    },
    {
        manifest: manifestFight,
        run: (bot, args, ctx) => runFight(bot, args.target, { maxKills: args.maxKills, retreatHp: args.retreatHp, ctx }),
    },
    {
        // build 的参数是方块数组，`!do` 的 key=value 串表达不了（04 §4.5 不允许 JSON）——
        // 所以它**不经 !do 调用**，由流程/策略层直接传数组。这里保留注册项是为了
        // manifest 统一校验 + 让 !listSkills 能列出它（模型能知道有这个能力）。
        manifest: manifestBuild,
        run: (bot, args, ctx) => runBuild(bot, args.blocks, { ctx }),
    },
    // ── M10（2026-11-03）：小屋流程（strat_first_night 的前置）─────────────
    {
        manifest: manifestShelter,
        run: (bot, args, ctx) => runShelter(bot, { block: args.block, radius: args.radius, ctx }),
    },
    // ── M10 策略层：只拆子单、等结果，不自己做动作（04 §6.3）────────────
    //
    // ★★ 2026-11-03（t55）：三个策略的 `deps` **必须带 `board` 和 `ctx`**。
    //
    //   原来这里写的是 `{}` / `{ maxJobs: args.maxJobs }` —— **board 从未被传**。
    //   而策略层靠 `deps.board ?? agent?.board` 取板，`ctx?.agent ?? bot` 又只是
    //   mineflayer 的 bot（没有 `.board`）→ `board = null` → 走 noBoard 分支 →
    //   **返回 ok 但一张单都不建**，`!do` 印 "OK"，板上 0 张。
    //
    //   `ctx` 也要传：`strat_first_night` 读 `deps.ctx?.jobBudget`（A2 的共享预算），
    //   不传就等于 A2 经 runSkill 全线失效。
    {
        manifest: manifestObtain,
        run: (bot, args, ctx) => runObtain(ctx?.agent ?? bot, args.item, args.count, { board: ctx?.board ?? null, ctx }),
    },
    {
        manifest: manifestToolTier,
        // ★★ t96：**`deps.obtain` 必须注入。**
        //   control 扫出来的真 bug：`strat_tool_tier:124` 是 `const obtainFn = deps.obtain ?? null;`
        //   而这里原来只传 `{ board, ctx }` → `!obtainFn` 永远成立 →
        //   `return ok({ plan, note: '没有 obtain 注入，只返回计划' })`
        //   → **`!do tool_tier` 永远报 ok，却一件工具都不去弄。**
        //   旁证：`tools/strat_tool_tier_unit.mjs` 三处**都显式注入 `obtain`** ——
        //   **单测靠注入才测得到真分支，生产却没有**（"单测注入 → 生产不注入"这个口子）。
        //   ★ 不会递归：`obtain` 不会回调 `tool_tier`。
        run: (bot, args, ctx) => runToolTier(ctx?.agent ?? bot, args.target, {
            board: ctx?.board ?? null,
            ctx,
            // ★ t96：`deps.obtain` 必须注入 —— 否则 `strat_tool_tier:125` 永远走
            //   "没有 obtain 注入，只返回计划" 的早退分支 → **报 ok 却一件工具都不弄**。
            //   （control 的 `deps_injection_audit` 扫出来的 A 档死分支）
            obtain: (a, item, count) => runObtain(a, item, count, { board: ctx?.board ?? null, ctx }),
        }),
    },
    {
        manifest: manifestFirstNight,
        // ★ t55：`board` + `ctx` 必须传进去（原来只有 maxJobs → deps.board 是 undefined
        //   → firstNight 走 noBoard 分支 → 一张单不建却返回 ok）。
        //   `ctx` 一并传：`deps.ctx?.jobBudget` 是 A2 的共享预算，不传就等于 A2 失效。
        run: (bot, args, ctx) => runFirstNight(ctx?.agent ?? bot, { ...(ctx ?? {}), board: ctx?.board ?? null, maxJobs: args.maxJobs }),
    },
];

/** 这一层还能用多久（毫秒）。07 §8：内层永远不超过外层剩下的时间。 */
function remaining(ctx) {
    const left = (ctx?.deadline ?? 0) - Date.now();
    return Number.isFinite(left) && left > 0 ? left : 0;
}

// ── manifest 校验（§4.4 第 1、2 条 + params 可解析）────────────────────────

/** `params` 的每个值必须是一句能解析的类型描述（§4.5 的写法）。 */
const PARAM_RE = /^(block|item|int|float|pos|area|entity|enum|string)\b[^;]*$/;

/**
 * 校验一条 manifest，返回问题列表（空 = 合格）。
 *
 * 为什么写在函数里而不是"启动时 inline 一堆 if"：单元测试要能拿**坏 manifest**
 * 直接喂进来验证"它真的会被拒"，而不是只能靠"删掉一个字段再手动启动"。
 */
export function validateManifest(manifest) {
    const problems = [];
    const need = (cond, msg) => { if (!cond) problems.push(msg); };

    if (!manifest || typeof manifest !== 'object') return ['manifest 不是对象'];

    need(typeof manifest.name === 'string' && manifest.name.trim().length > 0,
        'name 缺失或不是非空字符串');
    need(manifest.level === 'flow' || manifest.level === 'strat',
        `level 必须是 'flow' 或 'strat'（现在是 ${JSON.stringify(manifest.level)}）`);
    need(typeof manifest.summary === 'string' && manifest.summary.trim().length > 0,
        'summary 缺失（给模型看的一句话，不能空）');
    need(manifest.params && typeof manifest.params === 'object' && !Array.isArray(manifest.params),
        'params 缺失或不是对象');
    need(Number.isFinite(manifest.timeoutMs) && manifest.timeoutMs > 0,
        `timeoutMs 必须是正数（现在是 ${JSON.stringify(manifest.timeoutMs)}）`);

    // params 能解析
    if (manifest.params && typeof manifest.params === 'object') {
        for (const [k, spec] of Object.entries(manifest.params)) {
            if (typeof spec !== 'string') {
                problems.push(`params.${k} 不是字符串描述（应按 §4.5 写 'int 1..64 = 1'）`);
                continue;
            }
            const opt = spec.endsWith('?');
            const body = opt ? spec.slice(0, -1) : spec;
            if (!PARAM_RE.test(body)) problems.push(`params.${k} 解析不了：${JSON.stringify(spec)}`);
            // int 的区间与默认值要能读出来
            if (body.startsWith('int') && /\.\./.test(body)) {
                const m = body.match(/(\d+)\s*\.\.\s*(\d+)/);
                if (!m || Number(m[1]) > Number(m[2])) {
                    problems.push(`params.${k} 的区间写反了或读不出：${JSON.stringify(spec)}`);
                }
            }
        }
    }

    // codes 必须都注册过（同 preflight 的错误码审计）
    const codes = manifest.codes ?? [];
    if (!Array.isArray(codes)) problems.push('codes 不是数组');
    else for (const c of codes) {
        if (typeof c !== 'string') problems.push(`codes 里有非字符串：${JSON.stringify(c)}`);
        else if (c !== 'OK' && !CODES.includes(c)) problems.push(`codes 里的 ${c} 没在 CODES 注册`);
    }

    return problems;
}

/**
 * 校验整张注册表：单条合法性 + 名字唯一 + 名字不能是文件名（防止同名不同义）。
 *
 * @returns {{ok:boolean, problems:string[], byName:Map<string,object>}}
 */
export function validateRegistry(entries = ENTRIES) {
    const problems = [];
    const byName = new Map();
    for (const e of entries) {
        const local = validateManifest(e.manifest);
        if (typeof e.run !== 'function') local.push('注册项缺少 run() 执行入口');
        for (const p of local) problems.push(`[${e.manifest?.name ?? '?'}] ${p}`);

        const name = e.manifest?.name;
        if (typeof name === 'string' && name) {
            if (byName.has(name)) problems.push(`[${name}] 名字重复（注册表里必须唯一）`);
            else byName.set(name, e);
        }
    }
    return { ok: problems.length === 0, problems, byName };
}

// 启动即校验：不合格直接抛，不等到运行时（§4.6 硬要求）
const STARTUP_CHECK = validateRegistry();
if (!STARTUP_CHECK.ok) {
    throw new Error(`复合技能注册表校验失败（${STARTUP_CHECK.problems.length} 处）：\n  `
        + STARTUP_CHECK.problems.join('\n  '));
}

/** 所有已注册技能名（顺序 = 给模型看的顺序）。 */
export const SKILL_NAMES = [...STARTUP_CHECK.byName.keys()];

/** 取一条注册项；没有返回 null。 */
export function getSkill(name) {
    return STARTUP_CHECK.byName.get(String(name ?? '').trim()) ?? null;
}

// ── 参数解析（§4.5：一个 key=value 串，空格分隔）────────────────────────────

/**
 * 把 `"block=oak_log count=16 at=120,64,-30"` 解析成对象，并按 manifest.params 校验。
 *
 * 校验不过就**不执行**，回一句"参数错：…" —— 不进任务板、不产生错误码（§4.5）。
 *
 * @returns {{ok:true, args:object} | {ok:false, error:string}}
 */
export function parseSkillArgs(manifest, argString) {
    const spec = manifest?.params ?? {};
    const args = {};
    const text = String(argString ?? '').trim();

    // 先填默认值
    for (const [k, desc] of Object.entries(spec)) {
        const d = defaultOf(desc);
        if (d !== undefined) args[k] = d;
    }

    if (text) {
        for (const token of text.split(/\s+/).filter(Boolean)) {
            const eq = token.indexOf('=');
            if (eq <= 0) return { ok: false, error: `参数要写成 key=value：${token}` };
            const k = token.slice(0, eq);
            const raw = token.slice(eq + 1);
            if (!(k in spec)) {
                return { ok: false, error: `不认识参数 ${k}（可用：${Object.keys(spec).join(' ')}）` };
            }
            const parsed = coerceParam(k, spec[k], raw);
            if (parsed.error) return { ok: false, error: parsed.error };
            args[k] = parsed.value;
        }
    }

    // 必填项没给
    for (const [k, desc] of Object.entries(spec)) {
        const optional = String(desc).trim().endsWith('?') || defaultOf(desc) !== undefined;
        if (!optional && args[k] === undefined) {
            return { ok: false, error: `缺少必填参数 ${k}（${desc}）` };
        }
    }
    return { ok: true, args };
}

/** 从 `'int 1..64 = 1'` 里取默认值 1；没有默认值返回 undefined。 */
function defaultOf(desc) {
    const m = String(desc ?? '').match(/=\s*(-?\d+(?:\.\d+)?|true|false)\s*$/);
    if (!m) return undefined;
    if (m[1] === 'true') return true;
    if (m[1] === 'false') return false;
    return Number(m[1]);
}

/** 按 §4.5 的类型描述把字符串转成值，并做范围/枚举校验。 */
function coerceParam(name, desc, raw) {
    const body = String(desc ?? '').trim().replace(/\?$/, '');

    if (body.startsWith('int') || body.startsWith('float')) {
        const n = Number(raw);
        if (!Number.isFinite(n)) return { error: `参数 ${name} 要是数字（现在 ${JSON.stringify(raw)}）` };
        if (body.startsWith('int') && !Number.isInteger(n)) return { error: `参数 ${name} 要是整数` };
        const m = body.match(/(\d+)\s*\.\.\s*(\d+)/);
        if (m && (n < Number(m[1]) || n > Number(m[2]))) {
            return { error: `参数 ${name} 要 ${m[1]}..${m[2]}（现在 ${n}）` };
        }
        return { value: n };
    }
    if (body.startsWith('enum')) {
        const m = body.match(/enum\(([^)]*)\)/);
        const allowed = m ? m[1].split(',').map((s) => s.trim()).filter(Boolean) : [];
        if (allowed.length && !allowed.includes(raw)) {
            return { error: `参数 ${name} 只能是 ${allowed.join('/')}（现在 ${JSON.stringify(raw)}）` };
        }
        return { value: raw };
    }
    if (body.startsWith('pos') || body.startsWith('area')) {
        // pos: x,y,z ；area: x,y,z:半径
        const mm = raw.match(/^(-?\d+),(-?\d+),(-?\d+)(?::(\d+))?$/);
        if (!mm) return { error: `参数 ${name} 要写成 x,y,z${body.startsWith('area') ? ':半径' : ''}` };
        const out = { x: Number(mm[1]), y: Number(mm[2]), z: Number(mm[3]) };
        if (mm[4] !== undefined) out.radius = Number(mm[4]);
        return { value: out };
    }
    // block / item / entity / string：原样给，名字校验交给流程（要查 minecraft-data）
    return { value: raw };
}

// ── ctx 工厂（§4.6）────────────────────────────────────────────────────────

/**
 * 拼 3D 地图目录 —— **2026-11-02 下沉**，实现搬到 `bot_paths.js`，这里只转发。
 *
 * 为什么要下沉：本文件显式 import 了 `flow_*`，而流程会 import `skills.js`；
 * 若 `skills.js` 反过来 import 本文件就是**循环依赖**，所以实现不能住在这里。
 *
 * 历史：`actions.js` 里同一行 `` `./bots/${...}/map` `` 曾抄 6 遍（全仓 11 处），
 * 谁改目录结构就得改 11 个地方。现在只留 `bot_paths.mapDirOf` 一个真相，
 * 流程与命令层**都不许自己拼**。
 */
export { mapDirOf, botDirOf, botNameOf } from './bot_paths.js';

/**
 * 造一份 ctx 交给流程用（§4.6）。
 *
 * @param {object} agent  agent 实例（要能拿到 bot）
 * @param {object} [job]  任务单；没有就是"直接从命令调用"（jobId 为 null）
 * @param {object} [manifest] 用来兜底 deadline（单子没给 deadline 时 now + timeoutMs）
 */
export function makeCtx(agent, job = null, manifest = null) {
    const bot = agent?.bot ?? agent;
    const jobId = job?.id ?? null;

    // ★★ 2026-11-03（t66）：把**当前任务单 id 写到 bot 上**，供导航层的
    //   "单一驱动者"闸使用（`nav_core.goTo` 默认从 `bot.__navJobId` 取 owner）。
    //
    //   为什么这样做：`goTo` 的调用点遍布所有 flow（几十处），逐个传 owner 不现实、
    //   也容易漏（今晚"传参漏了"已经 4 例）。写到 bot 上 = **所有 flow 自动生效**。
    //   和既有约定一致：`bot.interrupt_code` 也是挂在 bot 上的跨层信令。
    try { if (bot && jobId) bot.__navJobId = jobId; } catch { /* 假 bot 上写不进去就算了 */ }

    // deadline：单子给了就用单子的，否则 now + manifest.timeoutMs（07 §8）
    const jobDeadline = Number(job?.deadline);
    const deadline = Number.isFinite(jobDeadline) && jobDeadline > 0
        ? jobDeadline
        : Date.now() + (manifest?.timeoutMs ?? 10 * 60 * 1000);

    // 断点：有单走任务板客户端，没单存内存
    const mem = { checkpoint: null };
    // ★ B3 修：原来只认 `agent.boardClient`，而 `agent.js` 里存的是 `this.board` —— 两处字段名不一致，
    //   于是 `ctx.reserve/checkpoint` **永远走 no-board 分支**（恒成功/存内存），
    //   预约从来没真正经过任务板。这类"两个名字指同一个东西"的错在本项目反复出现。
    //   这里两个都认，以实际接上的那个为准。
    const board = agent?.boardClient ?? agent?.board ?? null;

    // ★★ 2026-11-04（t96）：**把 board 挂到 bot 上。**
    //
    //   control 扫出来的真 bug：`flow_store.boardOf(bot)` 读 `bot?.agent?.board ?? bot?.board ?? null`，
    //   而 flow 的调用约定是 `entry.run(agent?.bot ?? agent, …)` —— **收到的是 mineflayer bot**，
    //   全仓 `bot.agent =` 赋值 0 处、`bot.board` 也没人设 → **恒 null**
    //   → `rememberChest` 的 `if (!board?.sharedPut) return;` **永远早退**
    //   → **B4「箱子内容写进任务板库、全 bot 共享」在生产从不发生**
    //     （B4 真机 5/5 是直接调 board API，**没走 flow_store** —— 所以测不出来）。
    //
    //   和 t66 的 `bot.__navJobId` 同一个模式：flow 层拿不到 ctx，就把需要的句柄挂 bot 上。
    //
    //   ★ 注意：这段**必须放在 `board` 声明之后** —— 我第一版插在前面，
    //     `const` 暂时性死区抛错被 `catch` 吞掉 → **静默不生效**（又一个"容错不留痕"）。
    try { if (bot && board) bot.board = board; } catch { /* 假 bot 上写不进去就算了 */ }

    return {
        jobId,
        mapDir: mapDirOf(agent),
        deadline,

        // ★★ 2026-11-03（t55）：**把 `agent` 和 `board` 暴露到 ctx 上**。
        //
        // 为什么必须加（真机 bug，不是洁癖）：
        //   策略层 `strat_*` 的签名是 `(agent, ..., deps)`，从 `deps.board ?? agent?.board` 取任务板。
        //   但注册表里三个策略的适配器是：
        //     run: (bot, args, ctx) => runFirstNight(ctx?.agent ?? bot, { maxJobs: args.maxJobs })
        //   —— `ctx` 里**既没有 agent 也没有 board**（本函数原来只放 jobId/mapDir/deadline/jobBudget/onEvent），
        //   于是 `ctx?.agent ?? bot` 取到的是 **mineflayer 的 bot**（没有 `.board`），
        //   `deps.board` 也没有 → `board = null` → 走 `noBoard` 分支
        //   → **返回 `ok({noBoard:true})`、一张单都不建** → `!do first_night` 印 "OK" 但板上 0 张单。
        //
        //   离线实测（control 复核）：`runSkill` 路径 `add` 调用 **0 次**、`steps=5`；
        //   直调 `firstNight(agent, {board})` 时 `add` 调用 **7 次**、`steps=6**。
        //
        // 影响面：`strat_obtain` / `strat_first_night` 经 `runSkill` 全都拿不到板；
        //   `flow_*` 不受影响（它们的适配器本来就用 ctx 里已有的东西）。
        //
        // ★ 只**新增**两个字段，不动任何已有字段（ctx 是 M5 核心，所有流程都在用）。
        agent,
        board,

        /**
         * ★★ 2026-11-03（A2）：**子单预算，跨调用共享**。
         *
         * 解决什么问题：`strat_obtain` 的防展开闸（MAX_DEPTH=6 / MAX_JOBS=30）是
         * **per-call**（`plan`/`hitDepth`/`hitJobs` 都是 `planObtain` 的局部变量）。
         * 于是 `strat_first_night` 调 4 次 obtain → **理论可到 120 张子单**。
         * 以前靠 `strat_first_night` 自己数 12 兜住 —— 但那是**每个调用方的责任**，
         * 以后新策略忘了加就炸。
         *
         * 做法（借 GMP 的"全局兜底"思想）：预算对象挂在 ctx 上，`strat_*` 拆单时从这里扣。
         *   `limit` 由 `manifest.jobBudget` 声明（没声明就用默认 40）
         *   `used`  已用掉多少张
         *   `hitCap` 是否撞过上限（**要如实上报，不许静默截断**）
         *
         * ★ 只**新增**一个字段，不动任何已有字段的语义（ctx 是 M5 核心，所有流程都用它）。
         * ★ 没有 ctx 的旧路径（直接调 `planObtain(...)`）**行为完全不变** ——
         *   那种情况 strat_obtain 退回它自己的 MAX_JOBS=30，有用例守着。
         */
        jobBudget: {
            limit: Number.isFinite(Number(manifest?.jobBudget))
                ? Math.max(1, Math.floor(Number(manifest.jobBudget)))
                : 40,
            used: 0,
            hitCap: false,
        },

        /**
         * **唯一**写 trace_bus 的地方（09 §2）。
         * 自动带 jobId / skill，并且只放标量（09 §2：其余字段平铺、不超过 10 个）。
         */
        onEvent(e) {
            if (!e || typeof e !== 'object') return;
            const { jobId: _ignored, skill: _ignored2, ...rest } = e;
            collectSilent({
                ...rest,
                jobId,
                skill: manifest?.name ?? null,
            });
        },

        /** 读断点：有单走 board_client，没单读内存。 */
        async checkpoint(key = 'default') {
            if (board?.getCheckpoint) return board.getCheckpoint(jobId, key);
            return mem.checkpoint?.[key] ?? null;
        },

        /** 存断点：同上。resumable 的流程每完成一个计数单位就该调一次（§4.4 第 8 条）。 */
        async save(obj, key = 'default') {
            if (board?.saveCheckpoint) return board.saveCheckpoint(jobId, key, obj);
            mem.checkpoint = { ...(mem.checkpoint ?? {}), [key]: obj };
            return true;
        },

        /**
         * 资源预约（06 §9.2）：**没有任务板时恒成功**（M8 之前都走这条）。
         *
         * ★ 参数形状（2026-11-02 B3 真机 + 单测两处都抓到过）：
         *   单个 key 是**字符串**，而 `board_client.reserve(id, keys)` 要的是**数组**。
         *   原来直接 `board.reserve(jobId, _key)` → 字符串被当成 owner、keys 变 undefined
         *   → `normalizeClaimKeys` 报"claims 必须是数组" → INTERNAL（或静默 no-op）。
         *   这里统一包成数组，并且**同时接受**单个 key 与 key 数组两种入参。
         */
        async reserve(_key) {
            const keys = Array.isArray(_key) ? _key : [_key];
            if (board?.reserve) return board.reserve(jobId, keys);
            return { ok: true, code: 'OK', message: '', data: { jobId, keys, noBoard: true } };
        },

        /** 释放预约：同上（形状一致）。 */
        async release(_key) {
            const keys = Array.isArray(_key) ? _key : [_key];
            if (board?.release) return board.release(jobId, keys);
            return { ok: true, code: 'OK', message: '', data: { jobId, keys, noBoard: true } };
        },
    };
}

// ── 给模型看的两项（§5）────────────────────────────────────────────────────

/**
 * 列出所有复合技能：从 `manifest.summary` + `params` 自动生成。
 *
 * 这就是 D24 的正解 —— 不再从函数体截 JSDoc（那种做法会把整段代码当文档塞给模型）。
 */
export function listSkills() {
    const lines = [];
    for (const name of SKILL_NAMES) {
        const e = getSkill(name);
        const p = e.manifest.params ?? {};
        const params = Object.entries(p).map(([k, v]) => `${k}=${v}`).join(' ');
        lines.push(`${name}: ${e.manifest.summary}${params ? `\n    参数：${params}` : ''}`);
    }
    return lines;
}

/**
 * 执行一个复合技能（`!do` 的真实入口）。
 *
 * 参数校验不过 → 直接回"参数错"，**不执行、不产生错误码**（§4.5）。
 * 还没任务板（M8 / B1 之前）→ 这里就直接调用流程本体，job = null。
 *
 * @returns ActionResult（流程自己的返回值，或参数错时的 fail）
 */
/**
 * 跑一个复合技能。
 *
 * ★★ 2026-11-03（t63）：**第 4 个参数 `job` 必须真的传进来** ——
 *   否则 `makeCtx(agent, null, ...)` → `ctx.jobId` 恒 null →
 *   `strat_obtain` 里"我正被哪张单执行"的判断永远失效 → 每次都多建一张壳。
 *
 *   真机链条（verify 逐行钉死）：
 *     board_scheduler:636  runner(this.agent, job.skill, argsToString(job.args))   ← job 没传
 *     composite_registry:557  makeCtx(agent, null, entry.manifest)                ← 硬编码 null
 *     composite_registry:413  jobId = job?.id ?? null                             → 恒 null
 *     strat_obtain:417  const myJobId = deps.ctx?.jobId ?? null                   → 恒 null
 *
 *   这条属「传参漏了 → 分支永不走」家族（今晚第 4 例：`availableSkills`、
 *   `planNeeds` 5 字段、`ctx.board`、现在 `ctx.jobId`）。
 */
export async function runSkill(agent, name, argString, job = null) {
    const entry = getSkill(name);
    if (!entry) {
        // 同理：技能名写错 ≠ 目标找不到，不产生错误码
        return {
            ok: false, code: null, message: `没有叫 ${name} 的复合技能（可用：${SKILL_NAMES.join(' ')}）`,
            data: { paramError: true },
        };
    }
    const parsed = parseSkillArgs(entry.manifest, argString);
    if (!parsed.ok) {
        // 参数错**不是运行失败，不产生错误码**（§4.5）。所以 code 显式给 null：
        // 给 NO_TARGET 会被模型读成"目标找不到 → 换个目标重试"，而实际是"你参数写错了"。
        // 上层（!do）据 data.paramError 直接回人话，不经过 code 的语义。
        return { ok: false, code: null, message: `参数错：${parsed.error}`, data: { paramError: true } };
    }
    // ★ t63：`job` 要真的透传（原来硬编码 null → ctx.jobId 恒 null）
    const ctx = makeCtx(agent, job, entry.manifest);
    return entry.run(agent?.bot ?? agent, parsed.args, ctx);
}
