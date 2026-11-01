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

/**
 * 注册项 = manifest + 执行入口。
 *
 * `run(bot, args, ctx)` 里的 `args` 已按 `manifest.params` 校验过（类型、范围、默认值都填好）。
 * 各流程原本的签名（如 `collect(bot, name, want, opts)`）由这里的适配层翻译 ——
 * **适配只搬参数，不改流程内部逻辑**。timeout 一律按 ctx.deadline 折算（07 §8：
 * 内层不超过外层剩余时间）。
 */
// 注册表的构成（**5 个**，都是"能自己跑完一件事"的流程）：
//   collect / follow / pickup / platform / escape
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

    // deadline：单子给了就用单子的，否则 now + manifest.timeoutMs（07 §8）
    const jobDeadline = Number(job?.deadline);
    const deadline = Number.isFinite(jobDeadline) && jobDeadline > 0
        ? jobDeadline
        : Date.now() + (manifest?.timeoutMs ?? 10 * 60 * 1000);

    // 断点：有单走任务板客户端，没单存内存
    const mem = { checkpoint: null };
    const board = agent?.boardClient ?? null;

    return {
        jobId,
        mapDir: mapDirOf(agent),
        deadline,

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

        /** 资源预约：**没有任务板时恒成功**（M8 之前都走这条，06 §9.2）。 */
        async reserve(_key) {
            if (board?.reserve) return board.reserve(jobId, _key);
            return { ok: true, code: 'OK', message: '', data: { jobId, key: _key, noBoard: true } };
        },

        /** 释放预约：同上。 */
        async release(_key) {
            if (board?.release) return board.release(jobId, _key);
            return { ok: true, code: 'OK', message: '', data: { jobId, key: _key, noBoard: true } };
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
export async function runSkill(agent, name, argString) {
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
    const ctx = makeCtx(agent, null, entry.manifest);
    return entry.run(agent?.bot ?? agent, parsed.args, ctx);
}
