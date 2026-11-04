#!/usr/bin/env node
/**
 * 「单测注入 → 生产不注入」静态审计。
 *
 * ★ 为什么要这个工具（2026-11-04，t70 结论 → t71 落地）：
 *   今晚同族已 6 例：`availableSkills`、`planNeeds` 5 字段、`ctx.board`、`ctx.jobId`、
 *   `strat_tool_tier.deps.obtain`、`flow_store.boardOf`。
 *   它们长得一模一样：**函数从 deps/ctx 里取一个字段 → 取不到就走早退分支 → 报 ok 或静默跳过**。
 *   单测里这个字段是**测试自己注入**的，所以单测全绿；生产绑定忘了注入，于是那条分支
 *   **永远走早退那一侧** —— 功能整条失效，而且**看起来完全正常**（报 ok / 静默 return）。
 *
 *   **推论（今晚最重要的一句）**：单测越绿，越可能说明生产那条路没人走。
 *
 * 本脚本把这件事变成可执行检查，两条规则：
 *   A. 策略层：`strat_*.js` 里 `deps.F` 有早退分支，而 `composite_registry.js` 的
 *      `run:` 绑定**没提供 F** → 生产永远走早退侧。
 *   B. ctx 层：flow/act/atom 里读 `ctx.F`，而 `makeCtx()` 返回对象**没有 F** → 恒 undefined。
 *
 * 判据保守：**只报"有早退分支"的字段**（没有早退分支的字段缺失可能是可接受的降级）。
 * 每条都打印**绑定原文**，人可复核；不猜、不静默。
 *
 * 用法：node tools/deps_injection_audit.mjs
 * 退出码：0 = 未发现（或只有提示级）；1 = 发现死分支（可接进 CI/preflight）
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const LIB = join(ROOT, 'src/agent/library');
const REGISTRY = join(LIB, 'composite_registry.js');

const read = (p) => readFileSync(p, 'utf8');
const lines = (p) => read(p).split('\n');
const isComment = (l) => /^\s*(\/\/|\*|\/\*)/.test(l);

// ───────────────────────────────────────────────────────────────────────────
// 0) 基础解析
// ───────────────────────────────────────────────────────────────────────────

/** `makeCtx()` 返回对象里的键（ctx 能提供什么，以它为准，不靠记忆）。 */
function ctxProvidedKeys(src = read(REGISTRY)) {
    const start = src.indexOf('export function makeCtx');
    if (start < 0) return { keys: [], src: null };
    const seg = src.slice(start);
    // 取 `return {` 到匹配的 `};`：从 return { 起做花括号配平
    const r = seg.search(/return\s*\{/);
    if (r < 0) return { keys: [], src: null };
    let i = seg.indexOf('{', r);
    let depth = 0, end = -1;
    for (let j = i; j < seg.length; j++) {
        const c = seg[j];
        if (c === '{') depth++;
        else if (c === '}') { depth--; if (depth === 0) { end = j; break; } }
    }
    const body = seg.slice(i + 1, end);
    // 顶层键：行首 `key:` 或 `key,`（缩进 <= 8 空格，避免抓到嵌套对象里的键）
    const keys = [...body.matchAll(/^\s{0,8}([a-zA-Z_$][\w$]*)\s*[:,]/gm)].map((m) => m[1]);
    // 方法简写 `async checkpoint(key) {` / `checkpoint(key) {` 也算（★ 必须容忍 async，
    //   第一版只写 `name(...)  {`，于是漏了 checkpoint/save/reserve/release 四个 —— 
    //   正是"扫描器比代码表达方式窄"那类错，见文件头）
    for (const m of body.matchAll(/^\s{0,8}(?:async\s+)?([a-zA-Z_$][\w$]*)\s*\([^)]*\)\s*\{/gm)) keys.push(m[1]);
    return { keys: [...new Set(keys)], src: `makeCtx @ composite_registry.js` };
}

/** 注册表里的 `import { x as runY } from './file.js'` → runY 属于哪个文件。 */
function importMap(src = read(REGISTRY)) {
    const map = new Map();           // runY → file base
    for (const m of src.matchAll(/import\s*\{([^}]+)\}\s*from\s*'\.\/([\w.]+)\.js'/g)) {
        const file = m[2];
        for (const part of m[1].split(',')) {
            const as = part.match(/(\w+)\s+as\s+(\w+)/);
            if (as) map.set(as[2], file);
        }
    }
    return map;
}

/**
 * 找某个 runY 的绑定：`run: (bot, args, ctx) => runY(... { k: v, ... })`。
 * 返回 { line, text, keys:Set, spreadCtx:boolean }。
 */
function bindingsFor(runY, src = read(REGISTRY)) {
    const out = [];
    const ls = src.split(/\r?\n/);
    for (let i = 0; i < ls.length; i++) {
        if (!ls[i].includes(`run:`) || !ls[i].includes(runY)) continue;
        // 绑定可能跨行：抓到出现 `}` 收尾为止（最多 6 行）
        let text = ls[i];
        let j = i;
        while (!/\)\s*,?\s*$/.test(text) && j - i < 6 && j + 1 < ls.length) {
            j++; text += '\n' + ls[j];
        }
        const keys = new Set();
        let spreadCtx = false;
        // ★ 取"绑定文本里出现的所有顶层键"。**不做花括号配平**：
        //   第一版用 `\{([^{}]*)\}` 匹配对象字面量，遇到**嵌套花括号**就崩 ——
        //   例如 `runToolTier(..., { board, ctx, obtain: (a,i,c) => runObtain(a,i,c,{ board, ctx }) })`
        //   里层 `{ board, ctx }` 会把外层的 `obtain:` 挡在外面，于是**误报"没提供 obtain"**。
        //   （又一次"扫描器比代码表达方式窄"——这次是嵌套花括号。）
        //   现在的判据：绑定文本里出现 `name:` 就算提供；出现裸标识符（简写属性）也算。
        //   宁可**过宽**（少报），因为审计工具的价值在于"报的都是真的"。
        for (const km of text.matchAll(/([a-zA-Z_$][\w$]*)\s*:/g)) keys.add(km[1]);
        for (const m of text.matchAll(/\{([^{}]*)\}/g)) {
            // 简写属性：`{ board: ctx?.board ?? null, ctx }` 里的 `ctx`
            for (const sm of m[1].matchAll(/(?:^|,)\s*([a-zA-Z_$][\w$]*)\s*(?=,|$)/g)) keys.add(sm[1]);
            if (/\.\.\.\s*\(?\s*ctx\b/.test(m[1])) spreadCtx = true;
        }
        if (/\.\.\.\s*\(?\s*ctx\b/.test(text)) spreadCtx = true;
        out.push({ line: i + 1, text: text.replace(/\s+/g, ' ').slice(0, 190), keys, spreadCtx });
    }
    return out;
}

// ───────────────────────────────────────────────────────────────────────────
// 1) 早退分支扫描
// ───────────────────────────────────────────────────────────────────────────

/**
 * 在一个文件里找"取某字段 + 早退"的模式：
 *   const A = deps.F ?? ...;  if (!A) return ok(...)   ← alias 形式
 *   if (!deps.F) return fail(...)                      ← 直接形式
 *
 * @returns {Array<{field, line, aliasLine, guardLine, action, ret}>}
 *   action: 'ok' | 'fail' | 'bare'（裸 return / continue，静默跳过）
 */
function earlyReturns(sourceText, { prefixes = ['deps', 'opts'] } = {}) {
    const ls = String(sourceText).split(/\r?\n/);
    const out = [];

    // alias 表：alias → { field, line }
    const alias = new Map();
    for (let i = 0; i < ls.length; i++) {
        if (isComment(ls[i])) continue;
        for (const m of ls[i].matchAll(/\b(?:const|let|var)\s+([a-zA-Z_$][\w$]*)\s*=\s*([^;]+);/g)) {
            const rhs = m[2];
            for (const p of prefixes) {
                // ★ 支持嵌套路径：`deps.ctx?.jobId` → field = `ctx.jobId`
                //   （第一版只取第一段，把 `deps.ctx?.jobId` 记成 `ctx` → 误报）
                const fm = rhs.match(new RegExp(`\\b${p}\\??\\.([a-zA-Z_$][\\w$]*)(?:\\??\\.([a-zA-Z_$][\\w$]*))?`));
                if (fm) {
                    alias.set(m[1], { field: fm[2] ? `${fm[1]}.${fm[2]}` : fm[1], line: i + 1, via: p });
                    break;
                }
            }
        }
    }

    for (let i = 0; i < ls.length; i++) {
        const ln = ls[i];
        if (isComment(ln)) continue;
        let hit = null;
        // 直接形式 if (!deps.F)
        for (const p of prefixes) {
            const dm = ln.match(new RegExp(`if\\s*\\(\\s*!\\s*${p}\\??\\.([a-zA-Z_$][\\w$]*)`));
            if (dm) { hit = { field: dm[1], via: p, aliasLine: null }; break; }
        }
        // alias 形式 if (!A) / if (A == null)
        if (!hit) {
            const am = ln.match(/if\s*\(\s*!\s*([a-zA-Z_$][\w$]*)\s*\)/) || ln.match(/if\s*\(\s*([a-zA-Z_$][\w$]*)\s*==?\s*null\s*\)/);
            if (am && alias.has(am[1])) {
                const a = alias.get(am[1]);
                hit = { field: a.field, via: a.via, aliasLine: a.line };
            }
        }
        if (!hit) continue;

        // 抓早退语句：本行剩余，或后 3 行内第一个 return
        let ret = ln.slice(ln.indexOf(')') + 1).trim();
        if (!/return|continue|break/.test(ret)) {
            for (let k = 1; k <= 3 && i + k < ls.length; k++) {
                if (/return|continue|break/.test(ls[i + k])) { ret = ls[i + k].trim(); break; }
            }
        }
        // ★ 守卫体内**没有** return/continue/break 的，是普通分支（例如"没有 job 上下文才建壳"），
        //   不是早退分支 → 跳过。第一版把 `if (!myJobId) { /* 建壳 */ }` 当成早退，误报。
        if (!/return|continue|break/.test(ret)) continue;
        const action = /\breturn\s+ok\(/.test(ret) ? 'ok'
            : /\breturn\s+fail\(/.test(ret) ? 'fail'
                : /\bcontinue\b|\bbreak\b/.test(ret) ? 'bare'
                    : /return\s*[{;]|return\s+\{/.test(ret) ? 'ok'      // 返回对象字面量（=? 当作"交回计划"）
                        : 'bare';
        out.push({ field: hit.field, via: hit.via, line: i + 1, guard: ln.trim().slice(0, 120), action, ret: ret.slice(0, 120) });
    }
    return out;
}

/** `deps.F ?? <fallback>` 里的 fallback 文本（只取到表达式边界，不吃过 `(` `)` `,` `;`）。 */
function fallbackOf(tailText) {
    const fb = String(tailText).match(/\?\?\s*([^\s;,()]+)/);
    return fb ? fb[1].trim().slice(0, 90) : null;
}

/**
 * `deps` 也可能是**局部数组变量**（strat_obtain 里 `deps` 是"依赖 key 列表"）。
 * `deps.push(k)` / `deps.length` 不是"从注入对象取字段" —— 第一版误报了这两条。
 */
const ARRAY_MEMBERS = new Set(['push', 'pop', 'shift', 'unshift', 'length', 'map', 'filter', 'forEach',
    'find', 'some', 'every', 'join', 'includes', 'indexOf', 'slice', 'concat', 'sort', 'reduce', 'flat']);

// ───────────────────────────────────────────────────────────────────────────
// ★★ --selftest：扫描器自测（**先证明工具看得见，再说"没有"**）
//
// 为什么必须有这个（2026-11-04）：本工具开发过程中我踩了 **7 次"扫描器比代码窄"** ——
// 方法简写、对象简写属性、嵌套花括号、嵌套字段、局部 `deps` 数组、裸标识符 fallback、
// fallback 正则吃过头。每一次都是"工具报了个可疑结果 → 回头怀疑工具"才发现的。
//
// 最危险的一次是「嵌套花括号」：它让工具**误报"`deps.obtain` 仍未注入"**，
// 而实际已经修好了 —— 差点让 captain 以为自己的修复白做。
//
// **所以：工具报 0 处时，我们必须能回答"是真的没有，还是它看不见"。**
// 这 6 条断言就是那个回答。全绿才谈得上"A 档 0 处"这个结论可信。
// ───────────────────────────────────────────────────────────────────────────
if (process.argv.includes('--selftest')) {
    let pass = 0, fail = 0;
    const ok = (name, ev = '') => { pass++; console.log(`  PASS  ${name}  ${ev}`); };
    const bad = (name, actual) => { fail++; console.log(`  FAIL  ${name}  ${JSON.stringify(actual)}`); };
    const chk = (name, cond, ev, actual) => cond ? ok(name, ev) : bad(name, actual);

    console.log('=== 扫描器自测（6 种代码形态，全绿才算可信）===');

    // ① 方法简写（`async checkpoint(...) {`）—— 第一版只认 `name(...) {`，丢了 4 个 ctx 键
    {
        // 夹具必须长得像真的：`makeCtx` 是 `return { … };`（第一版夹具漏了 `return {`，
        // 于是 keys=[] —— **自测当场抓到的是夹具的错，不是扫描器的错**，这也是自测的价值）
        const src = `export function makeCtx(a, b, m) {
    return {
        agent,
        board,
        async checkpoint(key = 'default') {
            return 1;
        },
        save(extra) {
            return 2;
        },
    };
}`;
        const keys = ctxProvidedKeys(src).keys;
        chk('① 方法简写（async checkpoint / save）能被识别',
            keys.includes('checkpoint') && keys.includes('save') && keys.includes('agent') && keys.includes('board'),
            `keys=${keys.join(',')}`, { keys });
    }

    // ② 对象**简写属性**（`{ board: …, ctx }`）—— 第一版只认 `key:`，把 deps.ctx 误报
    {
        const src = `const x = [
    {
        run: (bot, args, ctx) => runObtain(ctx?.agent ?? bot, args.item, args.count, { board: ctx?.board ?? null, ctx }),
    },
];`;
        const b = bindingsFor('runObtain', src)[0];
        chk('② 对象简写属性（裸 `ctx`）能被识别为已提供',
            !!b && b.keys.has('ctx') && b.keys.has('board'),
            `keys=${[...(b?.keys ?? [])].join(',')}`, { keys: [...(b?.keys ?? [])] });
    }

    // ③ 嵌套花括号（内层 `{ board, ctx }`）—— 第一版 `[^{}]*` 崩，把 obtain 误报成未注入
    {
        const src = `const x = [
    {
        run: (bot, args, ctx) => runToolTier(ctx?.agent ?? bot, args.target, {
            board: ctx?.board ?? null,
            ctx,
            obtain: (a, item, count) => runObtain(a, item, count, { board: ctx?.board ?? null, ctx }),
        }),
    },
];`;
        const b = bindingsFor('runToolTier', src)[0];
        chk('③ 嵌套花括号里的 `obtain:` 仍能被识别（不因内层 {} 而漏）',
            !!b && b.keys.has('obtain'),
            `keys=${[...(b?.keys ?? [])].join(',')}`, { keys: [...(b?.keys ?? [])] });
    }

    // ④ 嵌套字段路径（`deps.ctx?.jobId`）—— 第一版只取第一段，记成 `ctx`
    {
        const src = `const myJobId = deps.ctx?.jobId ?? null;
if (!myJobId) return ok({ note: '没有 job 上下文' });`;
        const ers = earlyReturns(src, { prefixes: ['deps'] });
        chk('④ 嵌套字段 deps.ctx?.jobId 记成 `ctx.jobId`（不是 `ctx`）',
            ers.length === 1 && ers[0].field === 'ctx.jobId',
            `field=${ers[0]?.field}`, ers);
    }

    // ⑤ 局部 `deps` 数组（`deps.push/length`）—— 第一版在 C 档误报成"注入字段缺失"
    {
        const src = `if (deps.length) s.dependsOnKeys = [...new Set(deps)];
if (byKey.has(k)) { deps.push(k); break; }`;
        const ers = earlyReturns(src, { prefixes: ['deps'] });
        // ① A 档不该误报：`if (deps.length)` 不是 `!` 守卫，且体内没有 return/continue/break 的早退
        chk('⑤ A 档不会把 `if (deps.length)` 误判成早退分支',
            ers.length === 0,
            `findings=${ers.length}`, ers);
        // ② C 档会看到 length/push（它有"任何 deps.F 读取"都会记），所以排除表是必需的
        const seenByC = [...src.matchAll(/\bdeps\??\.([a-zA-Z_$][\w$]*)/g)].map((m) => m[1]);
        chk('⑤b C 档会看到 length/push（故排除表必需），且排除表能挡住',
            seenByC.includes('length') && seenByC.includes('push')
            && ARRAY_MEMBERS.has('length') && ARRAY_MEMBERS.has('push'),
            `C 看到=[${seenByC.join(',')}] 排除表 size=${ARRAY_MEMBERS.size}`,
            { seenByC, size: ARRAY_MEMBERS.size });
    }

    // ⑥ 裸标识符 fallback（`deps.planObtain ?? planObtain` = 测试接缝）—— 第一版正则吃过头
    {
        const f1 = fallbackOf('deps.planObtain ?? planObtain)({');
        const f2 = fallbackOf('deps.inventory ?? countInventory(agent);');
        chk('⑥ fallback 只取到表达式边界（裸标识符不吃过 `)`）',
            f1 === 'planObtain' && f2 === 'countInventory',
            `planObtain=${f1} inventory=${f2}`, { f1, f2 });
    }

    console.log(`\n扫描器自测：${pass} passed, ${fail} failed`);
    process.exit(fail === 0 ? 0 : 1);
}

// ───────────────────────────────────────────────────────────────────────────
// 2) 两条检查
// ───────────────────────────────────────────────────────────────────────────
const { keys: CTX_KEYS } = ctxProvidedKeys();
const IMPORTS = importMap();
const findings = [];   // {family, file, line, field, action, ret, why, impact}

// —— A. 策略层：deps 字段有早退，但生产绑定没注入 ——
const stratFiles = readdirSync(LIB).filter((f) => /^strat_.*\.js$/.test(f));
for (const f of stratFiles) {
    const p = join(LIB, f);
    const ers = earlyReturns(read(p), { prefixes: ['deps'] });
    if (!ers.length) continue;
    // 该文件对应的 runY
    const runYs = [...IMPORTS.entries()].filter(([, file]) => file === f.replace(/\.js$/, '')).map(([runY]) => runY);
    const binds = runYs.flatMap((r) => bindingsFor(r));
    const provided = new Set(binds.flatMap((b) => [...b.keys]));
    const spreadsAll = binds.some((b) => b.spreadCtx);   // 展开 `...ctx` = ctx 的键都给了
    for (const er of ers) {
        const okDirect = provided.has(er.field);
        const okViaCtx = spreadsAll && CTX_KEYS.includes(er.field);
        if (okDirect || okViaCtx) continue;
        findings.push({
            family: 'A·策略 deps 未注入',
            file: `${f}:${er.line}`,
            field: `deps.${er.field}`,
            action: er.action,
            ret: er.ret,
            why: binds.length
                ? `绑定只提供 {${[...provided].join(', ') || '空'}}${spreadsAll ? ' + ...ctx' : ''}，没有 ${er.field}`
                : '该文件没有对应的 `run:` 绑定（可能未注册）',
            impact: er.action === 'ok'
                ? '生产永远走早退侧：**报 ok 但什么都没做**（假成功）'
                : er.action === 'fail'
                    ? '生产永远直接失败，功能不可用'
                    : '生产永远静默跳过（无痕）',
        });
    }
}

// —— B. ctx 层：读 ctx.F 有早退，但 makeCtx 不提供 ——
const scanFiles = readdirSync(LIB).filter((f) => /^(flow_|act_|atom_|query_|nav_|board_).*\.js$/.test(f));
for (const f of scanFiles) {
    const p = join(LIB, f);
    let ers = earlyReturns(read(p), { prefixes: ['ctx'] });
    // 也覆盖 `const A = ctx.F` 的 alias 形式里 field 来自 ctx 的（earlyReturns 已用 prefixes=['ctx'] 处理）
    if (!ers.length) continue;
    for (const er of ers) {
        if (CTX_KEYS.includes(er.field)) continue;
        findings.push({
            family: 'B·ctx 字段不存在',
            file: `${f}:${er.line}`,
            field: `ctx.${er.field}`,
            action: er.action,
            ret: er.ret,
            why: `makeCtx 只提供 {${CTX_KEYS.join(', ')}}，没有 ${er.field}`,
            impact: er.action === 'ok' ? '生产永远走早退侧：报 ok 但没做（假成功）'
                : er.action === 'fail' ? '生产永远直接失败' : '生产永远静默跳过（无痕）',
        });
    }
}

// —— C. 信息档：`deps.F` 被读取、生产不注入（**不一定有早退分支**）——
//
// 为什么要有这一档：A 档只看"有早退分支"的死分支，但同族还有一种更隐蔽的形态 ——
//   `const chests = deps.chests ?? countChestsFromBoard(deps.chestRows);`
//   `deps.chestRows` 生产从不注入 → `countChestsFromBoard(undefined)` → `for (const row of (rows ?? []))`
//   → **静默返回 `{}`** → 策略以为"一个箱子都不知道" → "箱子优先"这条路永远不走，但**没有任何报错**。
//   它不是死分支（没早退），是**静默降级**，比死分支更难发现。
//
// 这一档**不影响退出码**（信息），但要逐个判断：fallback 是"从 agent 现算"（安全）还是"退化成空"（可疑）。
const infoFindings = [];
for (const f of stratFiles) {
    const p = join(LIB, f);
    const ls = lines(p);
    const runYs = [...IMPORTS.entries()].filter(([, file]) => file === f.replace(/\.js$/, '')).map(([runY]) => runY);
    const binds = runYs.flatMap((r) => bindingsFor(r));
    const provided = new Set(binds.flatMap((b) => [...b.keys]));
    const spreadsAll = binds.some((b) => b.spreadCtx);

    for (let i = 0; i < ls.length; i++) {
        if (isComment(ls[i])) continue;
        for (const m of ls[i].matchAll(/\bdeps\??\.([a-zA-Z_$][\w$]*)/g)) {
            const field = m[1];
            if (ARRAY_MEMBERS.has(field)) continue;                       // 局部数组，不是注入对象
            if (provided.has(field)) continue;
            // `deps.ctx` 且绑定做了 `...ctx` 展开 → ctx 的键都已摊平进 deps，内层再取得到
            if (field === 'ctx' && spreadsAll) continue;
            if (spreadsAll && CTX_KEYS.includes(field)) continue;
            // 同一行里该字段的 fallback 表达式（`deps.F ?? ...` 的右半）
            // ★ 只取到"标识符/表达式边界"为止（不能在 `(` `)` `,` `;` 处吃过头，
            //   否则 `deps.planObtain ?? planObtain)({` 会被抓成 `planObtain)({`，
            //   于是"裸标识符=测试接缝"这条判据永远不成立）
            const tail = ls[i].slice(m.index);
            const fallback = fallbackOf(tail);
            // 形态：`name: deps.F,` = **入参透传**（不是 fallback 场景）→ 低危
            const passthrough = new RegExp(`[a-zA-Z_$][\\w$]*\\s*:\\s*deps\\??\\.${field}\\s*,`).test(ls[i]);
            // 形态：fallback 是**裸标识符**（`deps.planObtain ?? planObtain`）= 同名函数/测试接缝 → 安全
            const bareFnFallback = !!fallback && /^[a-zA-Z_$][\w$]*$/.test(fallback);
            // 形态：`let X = deps.F;` 之后**同函数内再赋值**（`X = await …` / `if (X == null && …) X = …`）
            //   = 运行时自取兜底（t97 修 `chestRows` 用的正是这个形态）→ 安全。
            //   不认这个形态，就会把"已经修好的代码"继续标成可疑 —— 那就是误报。
            const aliasM = ls[i].match(/\b(?:const|let|var)\s+([a-zA-Z_$][\w$]*)\s*=\s*deps\??\.\w+\s*;/);
            let laterAssign = false;
            if (aliasM) {
                const a = aliasM[1];
                for (let k = 1; k <= 20 && i + k < ls.length; k++) {
                    if (new RegExp(`\\b${a}\\s*(?:\\?\\?=|=)(?!=)`).test(ls[i + k])) { laterAssign = true; break; }
                }
            }
            infoFindings.push({
                file: `${f}:${i + 1}`,
                field: `deps.${field}`,
                fallback,
                passthrough,
                bareFnFallback,
                laterAssign,
                // 判"是否静默退化成空"：透传/裸函数/下游赋值兜底都不算；
                // 无 fallback = 缺了就是 undefined；fallback 不含 agent/bot = 不是"现算"
                silentEmpty: (passthrough || bareFnFallback || laterAssign) ? false
                    : (!fallback ? true : !/\bagent\b|\bbot\b/.test(fallback)),
                raw: ls[i].trim().slice(0, 120),
            });
        }
    }
}

// ───────────────────────────────────────────────────────────────────────────
// 3) 报告
// ───────────────────────────────────────────────────────────────────────────
console.log('=== deps/ctx 注入审计（「有早退分支但生产不提供」）===');
console.log(`扫描：${stratFiles.length} 个 strat_* + ${scanFiles.length} 个 ctx 消费文件`);
console.log(`makeCtx 提供 ${CTX_KEYS.length} 个键：${CTX_KEYS.join(', ')}\n`);

if (!findings.length) {
    console.log('✅ 未发现"有早退分支但生产不提供"的字段。');
} else {
    const byFam = {};
    for (const x of findings) (byFam[x.family] ??= []).push(x);
    for (const [fam, list] of Object.entries(byFam)) {
        console.log(`\n── ${fam}：${list.length} 处`);
        for (const x of list) {
            console.log(`  · ${x.file}  ${x.field}  → 早退行为=${x.action}`);
            console.log(`      守卫：${x.guard ?? ''}`);
            console.log(`      早退：${x.ret}`);
            console.log(`      原因：${x.why}`);
            console.log(`      影响：${x.impact}`);
        }
    }
    console.log(`\n合计 ${findings.length} 处。判据：这类地方 = 单测测得到、生产走不到的死分支。`);
    console.log('修法（任选）：① 生产绑定处补注入；② 挂到 bot 上（同 makeCtx 的 bot.__navJobId/board 做法）；③ 删掉该早退分支并让上游必传。');
}

// —— C 档信息（不影响退出码）——
if (infoFindings.length) {
    const susp = infoFindings.filter((x) => x.silentEmpty);
    console.log(`\n── C·信息档：deps 字段被读、生产绑定没提供（${infoFindings.length} 处，其中 ${susp.length} 处 fallback 可疑）`);
    console.log('   判据：A 档要求"有早退分支"；这里**不要求**，因为"静默降级"比死分支更难发现。');
    for (const x of infoFindings) {
        const mark = x.passthrough ? '⚪ 入参透传（缺失=undefined，策略层按"未知"处理）'
            : x.bareFnFallback ? '🟢 fallback 是同名函数/测试接缝，生产有默认实现'
                : x.laterAssign ? '🟢 下游有赋值兜底（运行时自取，如 `chestRows` 的 board.sharedList）'
                    : x.silentEmpty ? '🟡 可疑（fallback 不像"现算"，可能静默退化成空）'
                        : '🟢 fallback 从 agent 现算，可接受';
        console.log(`  · ${x.file}  ${x.field}  → ${mark}`);
        console.log(`      原文：${x.raw}`);
        if (x.fallback) console.log(`      fallback：${x.fallback}`);
        else console.log('      fallback：**无**（缺失即为 undefined/空）');
    }
    console.log('   注意：C 档要人判断 —— "退化成空"和"从 agent 现算"都可能是对的设计。');
}

process.exit(findings.length ? 1 : 0);
