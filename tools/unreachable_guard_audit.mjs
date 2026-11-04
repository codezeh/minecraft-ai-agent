#!/usr/bin/env node
/**
 * 「守卫不可达 / 上层遮住下层诊断」审计。
 *
 * ★ 为什么有这个工具（2026-11-04，t125；今晚第 4 例同族）：
 *   captain 在 `act_craft` 加了两道守卫（t121 `requiresTable && !tableBlock`、t122 诊断），
 *   **真机连续两轮，这些字段一次都没出现在 `data` 里** ——
 *   因为 `flow_craft` 在自己那一层先 `return fail(...)` 了，`act_craft` 从来没被调用。
 *
 *   **这一族（「防护装了但没生效」）今晚第 4 例**：
 *     ① `deps_injection_audit` 没接 preflight  ② `--selftest` 没接
 *     ③ `strat_cycles_unit` 没注册进 unit_all  ④ **守卫装在被上层遮住的层**
 *
 *   **共同点：它们都不会让任何东西变红。** 所以只能靠"结构扫描"发现。
 *
 * 三档判据（**只报告，不改代码，先看误报率**）：
 *   🔴 A 档：上层早退 `fail` 的 data 键数 **少于** 下层同码 `fail` 的键数 → 下层更精确的诊断被遮住
 *   🟡 B 档：「同一个判断写两处」（`recipesFor` / `missingFor` / `calculateLimitingResource` 等跨文件重复）
 *   ⚪ C 档：`diag({...})` 里定义了、但本文件任何 `fail` 都没用到的键（疑似死字段）
 *
 * 用法：
 *   node tools/unreachable_guard_audit.mjs                 # 扫 src/
 *   node tools/unreachable_guard_audit.mjs --selftest      # 自测（内联假源码）
 *   node tools/unreachable_guard_audit.mjs --file a.js     # 单文件
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// ───────────────────────────────────────────────────────────────────────────
// 解析：从源码里抽出 `fail(...)` / `ok(...)` 的 code 与 data 键数
// ───────────────────────────────────────────────────────────────────────────

/** 去注释（等长空白，保持行号/偏移不变）。★ 必须做 —— 今晚栽过"扫到自己写的注释"。 */
export function maskComments(s) {
    let out = String(s).replace(/\/\*[\s\S]*?\*\//g, (x) => x.replace(/[^\n]/g, ' '));
    out = out.replace(/\/\/[^\n]*/g, (x) => ' '.repeat(x.length));
    return out;
}

function skipString(s, i) {
    const q = s[i];
    for (let j = i + 1; j < s.length; j++) {
        if (s[j] === '\\') { j++; continue; }
        if (s[j] === q) return j + 1;
    }
    return s.length;
}

function matchParen(s, openIdx) {
    let depth = 0;
    for (let i = openIdx; i < s.length; i++) {
        const c = s[i];
        if (c === '"' || c === "'" || c === '`') { i = skipString(s, i) - 1; continue; }
        if (c === '(') depth++;
        else if (c === ')') { depth--; if (depth === 0) return i; }
    }
    return -1;
}

function matchBrace(s, openIdx) {
    let depth = 0;
    for (let i = openIdx; i < s.length; i++) {
        const c = s[i];
        if (c === '"' || c === "'" || c === '`') { i = skipString(s, i) - 1; continue; }
        if (c === '{') depth++;
        else if (c === '}') { depth--; if (depth === 0) return i; }
    }
    return -1;
}

/** 对象体的顶层键（`k:` 或简写 `k`），以及是否有展开（`...r.data`）。 */
function objectKeys(body) {
    const keys = [];
    let hasSpread = false;
    let depth = 0, seg = '';
    for (let i = 0; i < body.length; i++) {
        const c = body[i];
        if (c === '"' || c === "'" || c === '`') { const e = skipString(body, i); seg += body.slice(i, e); i = e - 1; continue; }
        if (c === '{' || c === '[' || c === '(') depth++;
        else if (c === '}' || c === ']' || c === ')') depth--;
        if (c === ',' && depth === 0) { take(seg); seg = ''; continue; }
        seg += c;
    }
    take(seg);
    function take(s) {
        if (/\.\.\./.test(s)) hasSpread = true;
        const km = s.match(/^\s*([a-zA-Z_$][\w$]*)\s*:/);
        if (km) keys.push(km[1]);
        else {
            const sm = s.match(/^\s*([a-zA-Z_$][\w$]*)\s*$/);
            if (sm) keys.push(sm[1]);
        }
    }
    return { keys, hasSpread };
}

/**
 * 抽出一个文件里所有 `return fail(...)` / `return ok(...)`：
 * { name:'fail'|'ok', code, line, keyCount, hasSpread, insideDiag }
 */
export function extractReturns(sourceText) {
    const text = String(sourceText ?? '');
    const code = maskComments(text);
    const lineOf = (i) => text.slice(0, i).split('\n').length;
    const out = [];
    const re = /\breturn\s+(fail|ok)\s*\(/g;
    let m;
    while ((m = re.exec(code)) !== null) {
        const open = code.indexOf('(', m.index);
        const close = matchParen(code, open);
        if (close < 0) continue;
        const args = code.slice(open + 1, close);
        // code = 第一个字符串字面量（fail('NO_ITEM', ...)）
        const cm = args.match(/^\s*['"`]([A-Za-z_]+)['"`]/);
        // 找 data 对象：最后一个 `{...}`（跳过嵌套）
        let best = null;
        for (let i = 0; i < args.length; i++) {
            const c = args[i];
            if (c === '"' || c === "'" || c === '`') { i = skipString(args, i) - 1; continue; }
            if (c === '{') {
                const end = matchBrace(args, i);
                if (end > 0) best = { body: args.slice(i + 1, end), at: i };
            }
        }
        const { keys, hasSpread } = best ? objectKeys(best.body) : { keys: [], hasSpread: false };
        // ★ 该 return 的 data 是否用 `diag(...)` 包裹（= 有集中的精细诊断）
        const hasDiag = args.includes('diag(') || args.includes('diag (');
        out.push({
            name: m[1],
            code: cm ? cm[1] : null,
            line: lineOf(m.index),
            keyCount: keys.length,
            keys,
            hasSpread,
            hasDiag,
        });
    }
    return out;
}

/** 抽 `diag({...})` 里的键（用来看"定义了但没进 fail"的死字段）。 */
export function extractDiagKeys(sourceText) {
    const text = maskComments(String(sourceText ?? ''));
    const out = [];
    const re = /\bdiag\s*\(\s*\{/g;
    let m;
    while ((m = re.exec(text)) !== null) {
        const open = text.indexOf('{', m.index);
        const close = matchBrace(text, open);
        if (close < 0) continue;
        const { keys } = objectKeys(text.slice(open + 1, close));
        for (const k of keys) out.push({ key: k, line: text.slice(0, m.index).split('\n').length });
    }
    return out;
}

/** 抽 `import { a, b as c } from './x.js'` → { a: 'x', c: 'x' }。 */
export function extractImports(sourceText) {
    const text = maskComments(String(sourceText ?? ''));
    const map = new Map();
    const re = /import\s*\{([^}]+)\}\s*from\s*['"]\.\/([\w.\-]+)(?:\.js)?['"]/g;
    let m;
    while ((m = re.exec(text)) !== null) {
        const file = m[2].replace(/\.js$/, '');   // ★ 必须去后缀：parsed 的键是 base（无 .js）
        for (const part of m[1].split(',')) {
            const as = part.match(/^\s*(\w+)\s+as\s+(\w+)\s*$/);
            if (as) map.set(as[2], file);
            else {
                const nm = part.match(/^\s*(\w+)\s*$/);
                if (nm) map.set(nm[1], file);
            }
        }
    }
    return map;
}

/** 抽 `await <name>(` 的行号（用于"早退在这句调用之前"）。 */
export function extractCalls(sourceText) {
    const text = maskComments(String(sourceText ?? ''));
    const out = [];
    const lineOf = (i) => text.slice(0, i).split('\n').length;
    for (const m of text.matchAll(/\bawait\s+([A-Za-z_$][\w$]*)\s*\(/g)) {
        out.push({ name: m[1], line: lineOf(m.index) });
    }
    return out;
}

// ───────────────────────────────────────────────────────────────────────────
// A 档判据：上层早退 fail 的键数 < 下层同码 fail 的键数
// ───────────────────────────────────────────────────────────────────────────
/**
 * @param {object} caller   { file, returns, calls, imports }
 * @param {Map}   calleeReturns  Map<fileBase, Array<return>>
 * @returns {Array<{line, code, callerKeys, calleeFile, calleeKeys}>}
 */
export function findShadowedGuards(caller, calleeMap) {
    const hits = [];
    for (const r of caller.returns) {
        if (r.name !== 'fail' || !r.code) continue;
        if (r.hasSpread) continue;                       // 已经转发下层 data 的不算遮挡
        // 这条 fail 之后，本文件是否 await 了某个 import 进来的函数？
        const laterCalls = caller.calls.filter((c) => c.line > r.line && caller.imports.has(c.name));
        if (!laterCalls.length) continue;
        // 取最近的那个被调方的 fail 集合
        const calleeFile = caller.imports.get(laterCalls[0].name);
        const calleeRs = (calleeMap.get(calleeFile) ?? []).filter((x) => x.name === 'fail' && x.code === r.code);
        if (!calleeRs.length) continue;
        const calleeMax = Math.max(...calleeRs.map((x) => x.keyCount));
        const calleeHasDiag = calleeRs.some((x) => x.hasDiag);
        // ★★ 判据二选一（后者是补的，因为前者在 `diag()` 包裹下会失效）：
        //   ① 键数：下层字面量键数 > 上层
        //   ② **diag 标记**：上层是裸对象、下层用了 `diag(...)` → 下层有集中精细诊断，被上层遮住
        //   （t121/t122 正是第 ② 种：`act_craft` 的 data 走 `diag()`，字面量键数甚至为 0）
        const shadowByKeys = calleeMax > r.keyCount;
        const shadowByDiag = calleeHasDiag && !r.hasDiag;
        if (shadowByKeys || shadowByDiag) {
            hits.push({
                line: r.line, code: r.code, callerKeys: r.keyCount,
                calleeFile, calleeKeys: calleeMax,
                via: shadowByDiag ? 'diag' : 'keys',
                calleeLine: calleeRs.sort((a, b) => b.keyCount - a.keyCount)[0].line,
            });
        }
    }
    return hits;
}

// ───────────────────────────────────────────────────────────────────────────
// --selftest
// ───────────────────────────────────────────────────────────────────────────
if (process.argv.includes('--selftest')) {
    let pass = 0, fail = 0;
    const ok = (n, ev = '') => { pass++; console.log(`  PASS  ${n}${ev ? '  ' + ev : ''}`); };
    const bad = (n, a) => { fail++; console.log(`  FAIL  ${n}  ${JSON.stringify(a)}`); };
    const chk = (n, cond, ev, actual) => cond ? ok(n, ev) : bad(n, actual ?? ev);

    console.log('=== 守卫可达性审计 · 自测 ===');

    // ① A 档：上层小 data 早退 + 下层同码大 data（2 正例）
    {
        const callerSrc = `
            import { craftOnce } from './act_craft.js';
            export async function craft(bot) {
                if (!hasRecipe) return fail('NO_ITEM', '料不够', { item, want });
                const r = await craftOnce(bot, item, 1, table);
                if (!r.ok) return fail(r.code, r.message, { ...r.data, item });
            }
        `;
        const calleeSrc = `
            export async function craftOnce(bot, item) {
                if (empty) return fail('NO_ITEM', '料不够', { item, want, got: 0, inv, limit, missing });
            }
        `;
        const caller = { file: 'flow_craft', returns: extractReturns(callerSrc), calls: extractCalls(callerSrc), imports: extractImports(callerSrc) };
        const calleeReturns = new Map([['act_craft', extractReturns(calleeSrc)]]);
        const hits = findShadowedGuards(caller, calleeReturns);
        chk('① A档 正例：上层 2 键早退 vs 下层 6 键 → 判定遮挡',
            hits.length === 1 && hits[0].callerKeys === 2 && hits[0].calleeKeys === 6, `hits=${JSON.stringify(hits)}`, hits);
    }
    {
        // 第二正例：键数差 1 也算（下层更全）
        const callerSrc = `
            import { doIt } from './x.js';
            function f() {
                if (bad) return fail('NO_TOOL', 'm', { item, want, got });
                await doIt();
            }
        `;
        const calleeSrc = `function doIt() { if (b) return fail('NO_TOOL', 'm', { item, want, got, inv }); }`;
        const caller = { returns: extractReturns(callerSrc), calls: extractCalls(callerSrc), imports: extractImports(callerSrc) };
        const hits = findShadowedGuards(caller, new Map([['x', extractReturns(calleeSrc)]]));
        chk('① A档 正例2：3 键 vs 4 键 → 也算遮挡', hits.length === 1, `hits=${hits.length}`, hits);
    }
    {
        // 反例：上层已转发 ...r.data → 不算遮挡
        const callerSrc = `
            import { doIt } from './x.js';
            function f() {
                if (bad) return fail('NO_ITEM', 'm', { ...r.data, item });
                await doIt();
            }
        `;
        const caller = { returns: extractReturns(callerSrc), calls: extractCalls(callerSrc), imports: extractImports(callerSrc) };
        const hits = findShadowedGuards(caller, new Map([['x', extractReturns(`function doIt(){ if(b) return fail('NO_ITEM','m',{item,want,inv,limit}); }`)]]));
        chk('① A档 反例：上层带 ...r.data → 不报', hits.length === 0, `hits=${hits.length}`, hits);
    }

    // ② B 档：同一判断写在两处（2 正例 1 反例）—— 用"关键函数名跨文件出现"判
    {
        const a = `const r = bot.recipesFor(id, null, 1, null);`;
        const b = `const r2 = bot.recipesFor(id, null, want, true);`;
        const c = `const x = 1;`;
        const has = (src) => /recipesFor|missingFor|calculateLimitingResource/.test(src);
        chk('② B档 正例：两文件都有 recipesFor → 可疑', has(a) && has(b));
        chk('② B档 正例2：missingFor 也算同一类', has(`const m = missingFor(bot, item);`));
        chk('② B档 反例：都没有 → 不报', !(has(c)));
    }

    // ③ C 档：diag 里定义了但没进任何 fail（2 正例 1 反例）
    {
        // 正例：diag 出现在**没有 return 的位置**（`const d = diag({...})` 后再没用）→ 真死字段
        const src = `
            function f() {
                const d = diag({ deadKey: 1 });
                if (a) return fail('X', 'm', { item });
            }
        `;
        const dks = extractDiagKeys(src).map((x) => x.key);
        const returns = extractReturns(src);
        const usedByReturn = new Set(returns.flatMap((r) => r.keys));
        chk('③ C档 正例：diag 在非 return 位置且无 return 用到 → 死字段',
            dks.includes('deadKey') && !usedByReturn.has('deadKey'), `diagKeys=${dks} returnKeys=${[...usedByReturn]}`, { dks });
        // 正例2：同样的 key 名出现在另一个 return 里 → 不算死
        const src1b = `function h(){ const d = diag({ k1: 1 }); if(a) return fail('X','m',{ k2: 2 }); }`;
        const d1b = extractDiagKeys(src1b).map((x) => x.key);
        const u1b = new Set(extractReturns(src1b).flatMap((r) => r.keys));
        chk('③ C档 正例2：diag 的 k1 没有任何 return 用到 → 死字段', d1b.includes('k1') && !u1b.has('k1'), `k1 in diag=${d1b.includes('k1')}`, { d1b });
        // 正例2：diag 里的键确实出现在 fail 里 → 合规（反例）
        const src2 = `function g(){ if(a) return fail('X','m', diag({ liveKey: 1 })); }`;   // diag 是这条 fail 的 data
        const dks2 = extractDiagKeys(src2).map((x) => x.key);
        const used2 = new Set(extractReturns(src2).flatMap((r) => r.keys));
        chk('③ C档 反例：diag 键同时出现在 fail 的 data 里 → 合规',
            dks2.includes('liveKey') && used2.has('liveKey'), `diagKeys=${dks2}`, { dks2, used: [...used2] });
    }

    // ④ 解析器基础：注释剥离 + 行号不漂
    {
        const src = `// return fail('FAKE','x',{a,b})\nreturn fail('REAL','y',{p,q,r});`;
        const rs = extractReturns(src);
        chk('④ 注释里的 fail 不扫；真实 fail 行号=2', rs.length === 1 && rs[0].code === 'REAL' && rs[0].line === 2 && rs[0].keyCount === 3,
            `returns=${JSON.stringify(rs)}`, rs);
    }

    console.log(`\n自测：${pass} passed, ${fail} failed`);
    process.exit(fail === 0 ? 0 : 1);
}

// ───────────────────────────────────────────────────────────────────────────
// 报告
// ───────────────────────────────────────────────────────────────────────────
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const LIB = join(ROOT, 'src/agent/library');

const fileArg = (() => {
    const i = process.argv.indexOf('--file');
    return i >= 0 ? process.argv[i + 1] : null;
})();

function collect(dir, out = []) {
    for (const f of readdirSync(dir)) {
        const p = join(dir, f);
        if (statSync(p).isDirectory()) { if (f !== 'node_modules' && !f.startsWith('.')) collect(p, out); }
        else if (f.endsWith('.js')) out.push(p);
    }
    return out;
}

// ★★ 修（自测暴露的窄）：`--file` 只应限制"**报告哪些文件**"，
//   但判断遮挡必须有**全量 callee 索引** —— 否则单文件模式永远找不到下层文件，
//   会出现"单文件扫 0 处、全仓扫一堆"的假象（我第一次跑 flow_craft 就是这样被误导的）。
const allFiles = collect(join(ROOT, 'src'));
const reportFiles = fileArg ? [fileArg] : allFiles;
const parsed = new Map();          // fileBase → { returns, calls, imports, rel }
for (const f of allFiles) {
    let src; try { src = readFileSync(f, 'utf8'); } catch { continue; }
    const base = f.replace(/\\/g, '/').split('/').pop().replace(/\.js$/, '');
    parsed.set(base, {
        rel: relative(ROOT, f).replace(/\\/g, '/'),
        src,
        returns: extractReturns(src),
        calls: extractCalls(src),
        imports: extractImports(src),
        diagKeys: extractDiagKeys(src),
    });
}

// A 档
const calleeReturns = new Map([...parsed].map(([base, v]) => [base, v.returns]));
const aHits = [];
const reportSet = new Set(reportFiles.map((f) => f.split(String.fromCharCode(92)).join('/').split('/').pop().split('.js')[0]));
for (const [base, v] of parsed) {
    if (!reportSet.has(base)) continue;
    for (const h of findShadowedGuards({ file: base, returns: v.returns, calls: v.calls, imports: v.imports }, calleeReturns)) {
        aHits.push({ ...h, file: v.rel, calleeRel: parsed.get(h.calleeFile)?.rel ?? h.calleeFile });
    }
}

// B 档：同一判断跨文件
const JUDGE = ['recipesFor', 'missingFor', 'calculateLimitingResource', 'getItemCraftingRecipes'];
const bHits = [];
for (const token of JUDGE) {
    const where = [...parsed].filter(([, v]) => new RegExp(`\\b${token}\\s*\\(`).test(maskComments(v.src))).map(([, v]) => v.rel);
    if (where.length >= 2) bHits.push({ token, where });
}

// C 档：diag 定义但没进任何 return 的键
const cHits = [];
for (const [, v] of parsed) {
    if (!/^.*(act_|strat_)/.test(v.rel.split('/').pop())) continue;
    const used = new Set(v.returns.flatMap((r) => r.keys));
    const seen = new Set();
    for (const d of v.diagKeys) {
        if (used.has(d.key) || seen.has(d.key)) continue;
        seen.add(d.key);
        cHits.push({ file: v.rel, line: d.line, key: d.key });
    }
}

console.log('=== 守卫可达性审计（上层遮住下层诊断 / 同一判断写两处 / 死诊断字段）===');
console.log(`扫描 ${reportFiles.length} 个文件（callee 索引 ${allFiles.length} 个）`);

console.log(`── 🔴 A 档：上层早退遮住下层更精确的诊断（${aHits.length} 处）`);
for (const h of aHits) {
    console.log(`  · ${h.file}:${h.line}  fail('${h.code}') 只有 ${h.callerKeys} 个 data 键`);
    console.log(`      → 但同一文件之后会调 ${h.calleeFile}，那里的 fail('${h.code}') 有 ${h.calleeKeys} 个键（:${h.calleeLine}）`);
}

console.log(`\n── 🟡 B 档：同一个判断写在两处（${bHits.length} 组）`);
for (const h of bHits) console.log(`  · \`${h.token}\` 出现在 ${h.where.length} 个文件：${h.where.join(', ')}`);

console.log(`\n── ⚪ C 档：diag 里定义、但本文件任何 return 没用到的键（${cHits.length} 处，需人判断）`);
for (const h of cHits.slice(0, 20)) console.log(`  · ${h.file}:${h.line}  ${h.key}`);
if (cHits.length > 20) console.log(`  …还有 ${cHits.length - 20} 处`);

console.log('\n注：本工具只报告，默认 exit 0。**未接 preflight**（先看误报率再定）。');
