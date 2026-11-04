#!/usr/bin/env node
/**
 * 诊断字段命名审计 —— 「字段名不含口径」的机器判据。
 *
 * ★ 为什么有这个工具（2026-11-04，t113）：
 *   captain 两次因为 `data` 字段名不含口径，把 verify 带进了错方向：
 *
 *   | 字段名 | 实际存的 | 被读成 | 后果 |
 *   |---|---|---|---|
 *   | `matCounts: {[item]: after}` | **产出物**现在有几个 | "限制材料" | 按"取错原料"查了一轮（错） |
 *   | `recipesForCount: recipesFor(id,null,limit,null)` | **背包 2x2** 能合几条 | "查配方得 0 条 = 根因" | 3x3 物品**必然为 0**，是正常值 |
 *
 *   **共同点：字段名没说清口径，于是"正常值"看起来像"异常值"。**
 *   这和今晚 `gaps` 一个出口表示"环"和"缺料"两件事、`catch` 把错误吞成 null 是同一族：
 *   **一个名字承担了两种含义，读的人只能猜。**
 *
 * 本工具只**报告**，不改代码；三档：
 *   🔴 可疑      —— 名字像"计数/布尔"但缺口径限定，很可能误导人
 *   🟡 人工看    —— 判据太宽（位置类、布尔三态），只列清单
 *   🟢 合规      —— 带了口径限定词，或明显不是诊断字段
 *
 * 用法：
 *   node tools/diag_field_audit.mjs            # 扫 src/
 *   node tools/diag_field_audit.mjs --selftest # 自测（用内联假源码，证明判据看得见）
 *   node tools/diag_field_audit.mjs --file x.js
 *
 * 退出码：默认恒 0（本工具是"报告型"，接门禁前要先人工看误报）
 *        `--selftest` 时：自测失败 → 1
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// ───────────────────────────────────────────────────────────────────────────
// 判据
// ───────────────────────────────────────────────────────────────────────────

/**
 * ★★ 2026-11-04（t114）：**改成"歧义名白名单"制**。
 *
 * 起因（第一版实测）：全仓扫出 65 个 🔴，其中 **57 个是误报（88%）** ——
 *   43 处 `count` 是项目既有约定（与 `want` 配对 → 「完成 N/M」，`formatActionOutcome` 读它），
 *    6 处 `digCount`/`pillarCount` 名字其实已经说了"挖几个/垫几个"。
 *
 * 所以判据从"名字够不够清楚"改成"**这个名字是不是已知会误导人的**"：
 *   🔴 白名单命中 → 才判可疑（这些是**实证**把 verify 带偏过的名字）
 *   🟡 其它"看着像计数/布尔/位置"→ 只报告，人工看
 *   🟢 其余 → 合规
 *
 * 判据原则：**宁可漏报，不可误报** —— 高频误报会让人直接无视整个工具（今晚已见过一次）。
 */
const AMBIGUOUS_NAMES = new Set([
    // 实证过：同名跨文件兼"什么"和"几个"两种类型（`act_farm` 曾塞字符串）
    'got',
    // 实证过：名字像"材料数量"，实际是"产出物现在有几个"（captain t111 改名前）
    'matCounts',
    // 实证过：名字没说"哪个口径的配方数"（背包 2x2 vs 工作台 3x3），3x3 物品必然为 0 被当根因
    'recipesForCount',
    // 裸 `items`：既可能是"物品列表"也可能是"物品个数"
    'items',
]);

/** 「计数类」：说了"有几个"，但没说"数的是什么"。**白名单制下只降为人工看。** */
const BARE_COUNT = /^(count|num|n|qty|amount|made)$/i;

/** `*Count` 但一个口径限定词都没有（动作/位置/来源都没说）。 */
const QUALIFIERS = /(In|With|Before|After|Total|Craft|craft|Table|table|Inv|inv|Avail|Need|Want|Limit|Per|Delta|Missing|Required|Remain|Expect|Actual|Dig|dig|Pillar|pillar|Mine|mine|Mined|mined|Harvest|harvest|Kill|kill|Spawn|spawn|Row|row|Step|step|Slot|slot|Chest|chest)/;

/** 「布尔/状态类」：`hasX / isX / canX` 只有 true/false 时，"没检测"与"检测为否"混在一起（t98 族）。 */
const BOOL_LIKE = /^(has|is|can|should|did)[A-Z_]/;

/** 「位置类」：分不清面位/脚位。 */
const POS_LIKE = /^(pos|position|y|x|z|feet|surface|eye|head|blockPos|coord)$/i;

/**
 * 分类一个字段。
 * @param {string} key   字段名
 * @param {string} value 值表达式
 * @returns {'suspicious'|'manual'|'ok'}
 */
export function classifyField(key, value = '') {
    if (typeof key !== 'string' || !key) return 'ok';

    // 🔴 只有白名单命中才判可疑
    if (AMBIGUOUS_NAMES.has(key)) return 'suspicious';

    // 🟡 看着像计数/布尔/位置 → 只报告
    if (BARE_COUNT.test(key)) return 'manual';
    if (/Count$/.test(key) && !QUALIFIERS.test(key)) return 'manual';
    if (BOOL_LIKE.test(key)) {
        const hasNullFallback = /null/.test(value) || /\?\?/.test(value);
        return hasNullFallback ? 'ok' : 'manual';
    }
    if (POS_LIKE.test(key)) return 'manual';

    return 'ok';
}

/**
 * 从源码文本里抽出 `ok(...)` / `fail(...)` 的 data 字面量字段。
 * 做法：定位 `ok(` / `fail(`，找到匹配的右括号，再在参数里找 `{ key: value }` 顶层字段。
 * **不追求完整 AST** —— 这是"命名体检"，宁少报不错报错位置。
 *
 * @returns {Array<{key:string,value:string,line:number,call:string}>}
 */
export function extractDataFields(sourceText) {
    const text = String(sourceText ?? '');
    const out = [];
    const lineOf = (idx) => text.slice(0, idx).split('\n').length;

    // 先剥掉注释，避免把注释里的示例当真（今晚栽过：扫描器扫到自己写的注释）
    const code = maskComments(text);

    const CALL = /\b(ok|fail)\s*\(/g;
    let m;
    while ((m = CALL.exec(code)) !== null) {
        const callName = m[1];
        const open = code.indexOf('(', m.index);
        const close = matchParen(code, open);
        if (close < 0) continue;
        const argText = code.slice(open + 1, close);
        const argOffset = open + 1;
        // 找参数里的对象字面量（可能是 `{...}` 也可能是 `diag({...})`）
        for (const [oi, obj] of objectLiterals(argText).entries()) {
            for (const f of topLevelFields(obj.body)) {
                out.push({
                    key: f.key,
                    value: f.value,
                    line: lineOf(argOffset + obj.start + f.at),
                    call: callName,
                    objId: lineOf(argOffset + obj.start) + '#' + oi,   // 同对象内的字段共享
                });
            }
        }
    }
    return out;
}

// ── 小工具 ────────────────────────────────────────────────────────────────

/** 把 // 与 /* *\/ 注释替换成等长空白（保持偏移不变，行号才对得上）。 */
function maskComments(s) {
    let out = s.replace(/\/\*[\s\S]*?\*\//g, (x) => x.replace(/[^\n]/g, ' '));
    out = out.replace(/\/\/[^\n]*/g, (x) => ' '.repeat(x.length));
    return out;
}

/** 从 `(` 位置找匹配的 `)`，跳过字符串。 */
function matchParen(s, openIdx) {
    let depth = 0;
    let q = null;
    for (let i = openIdx; i < s.length; i++) {
        const c = s[i];
        if (q) {
            if (c === '\\') { i++; continue; }
            if (c === q) q = null;
            continue;
        }
        if (c === '"' || c === "'" || c === '`') { q = c; continue; }
        if (c === '(') depth++;
        else if (c === ')') { depth--; if (depth === 0) return i; }
    }
    return -1;
}

/** 在参数文本里找对象字面量 `{ ... }`（可嵌套，跳过字符串）。 */
function objectLiterals(argText) {
    const out = [];
    let i = 0;
    while (i < argText.length) {
        const c = argText[i];
        if (c === '"' || c === "'" || c === '`') { i = skipString(argText, i); continue; }
        if (c === '{') {
            const end = matchBrace(argText, i);
            if (end > 0) {
                out.push({ start: i, body: argText.slice(i + 1, end) });
                i = end + 1;
                continue;
            }
        }
        i++;
    }
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

/** 对象体里的**顶层**字段（只取 `key:` / `key,` 形式；不动嵌套里的键）。 */
function topLevelFields(body) {
    const out = [];
    let depth = 0;
    let seg = '';
    let segStart = 0;
    for (let i = 0; i < body.length; i++) {
        const c = body[i];
        if (c === '"' || c === "'" || c === '`') { const e = skipString(body, i); seg += body.slice(i, e); i = e - 1; continue; }
        if (c === '{' || c === '[' || c === '(') depth++;
        else if (c === '}' || c === ']' || c === ')') depth--;
        if (c === ',' && depth === 0) {
            pushSeg(seg, segStart);
            seg = ''; segStart = i + 1;
            continue;
        }
        seg += c;
    }
    pushSeg(seg, segStart);

    function pushSeg(s, at) {
        const km = s.match(/^\s*([a-zA-Z_$][\w$]*)\s*:\s*([\s\S]*)$/);
        if (km) out.push({ key: km[1], value: km[2].trim(), at });
        // 简写属性 `{ foo }` 也算字段（值为同名变量）
        else {
            const sm = s.match(/^\s*([a-zA-Z_$][\w$]*)\s*$/);
            if (sm) out.push({ key: sm[1], value: sm[1], at });
        }
    }
    return out;
}

// ───────────────────────────────────────────────────────────────────────────
// --selftest：先证明"判据看得见"，再谈"扫到 0 处"
// ───────────────────────────────────────────────────────────────────────────
if (process.argv.includes('--selftest')) {
    let pass = 0, fail = 0;
    const ok = (n, ev = '') => { pass++; console.log(`  PASS  ${n}${ev ? '  ' + ev : ''}`); };
    const bad = (n, a) => { fail++; console.log(`  FAIL  ${n}  ${JSON.stringify(a)}`); };
    const chk = (n, cond, ev, actual) => cond ? ok(n, ev) : bad(n, actual ?? ev);

    console.log('=== 诊断字段审计 · 自测 ===');

    // ① 计数类：2 正例（可疑）+ 2 反例（合规）
    {
        chk('① 白名单正例 matCounts → 可疑', classifyField('matCounts', '{x:1}') === 'suspicious');
        chk('① 白名单正例 recipesForCount → 可疑', classifyField('recipesForCount', '3') === 'suspicious');
        chk('① 白名单正例 got → 可疑（实证兼两种类型）', classifyField('got', '0') === 'suspicious');
        chk('① 白名单正例 items → 可疑', classifyField('items', 'x') === 'suspicious');
        chk('① 裸 count **不再判可疑**（项目约定，降为人工看）', classifyField('count', '1') === 'manual');
        chk('① 计数类 反例 craftedItemCount → 合规', classifyField('craftedItemCount', '1') === 'ok');
        chk('① 计数类 反例 recipesInInventory → 合规', classifyField('recipesInInventory', '3') === 'ok');
        chk('① 计数类 反例 recipesWithTable → 合规', classifyField('recipesWithTable', '9') === 'ok');
    }

    // ② 布尔三态：2 正例（人工看）+ 1 反例（有 null 兜底 → 合规）
    {
        chk('② 布尔 正例 hasShelter(无 null) → 人工看', classifyField('hasShelter', '!!x') === 'manual');
        chk('② 布尔 正例 isTree(无 null) → 人工看', classifyField('isTree', 'true') === 'manual');
        chk('② 布尔 反例 hasShelter ?? null → 合规', classifyField('hasShelter', 'x ?? null') === 'ok');
        chk('② 布尔 反例 canDig(含 null) → 合规', classifyField('canDig', 'v == null ? null : v') === 'ok');
    }

    // ③ 位置类：2 正例（人工看）+ 1 反例（targetFeetY 合规 —— 名字里说了脚位）
    {
        chk('③ 位置 正例 pos → 人工看', classifyField('pos', 'p') === 'manual');
        chk('③ 位置 正例 y → 人工看', classifyField('y', '1') === 'manual');
        chk('③ 位置 反例 targetFeetY → 合规', classifyField('targetFeetY', '1') === 'ok');
        chk('③ 位置 反例 surfaceY → 合规', classifyField('surfaceY', '1') === 'ok');
    }

    // ④ 抽取器：能从真实形状里抓到字段（含嵌套对象不误抓内层）
    {
        const src = `
            return fail('NO_ITEM', 'x', {
                item: itemName,
                count: 3,
                craftedItemCount: 1,
                inner: { matCounts: 5, deep: { zzz: 1 } },
            });
        `;
        const fs2 = extractDataFields(src);
        const keys = fs2.map((f) => f.key);
        chk('④ 抽取：抓到顶层字段 item / count / craftedItemCount / inner', keys.includes('item') && keys.includes('count') && keys.includes('craftedItemCount') && keys.includes('inner'), `keys=${keys.join(',')}`);
        chk('④ 抽取：**不**把嵌套里的 matCounts/zzz 当顶层', !keys.includes('zzz'), `keys=${keys.join(',')}`);
        chk('④ 抽取：value 能取到（count 的值是 3）', fs2.find((f) => f.key === 'count')?.value === '3');
    }

    // ⑤ 注释里的示例不该被扫到（今晚栽过"扫到自己写的注释"）
    {
        const src = `
            // fail('X','y',{ count: 1 })   ← 注释里的示例
            return ok({ realField: 1 });
        `;
        const fs2 = extractDataFields(src);
        const keys = fs2.map((f) => f.key);
        chk('⑤ 注释里的 ok/fail 示例不被扫到', !keys.includes('count') && keys.includes('realField'), `keys=${keys.join(',')}`);
    }

    console.log(`\n自测：${pass} passed, ${fail} failed`);
    process.exit(fail === 0 ? 0 : 1);
}

// ───────────────────────────────────────────────────────────────────────────
// 报告
// ───────────────────────────────────────────────────────────────────────────
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

const fileArg = (() => {
    const i = process.argv.indexOf('--file');
    return i >= 0 ? process.argv[i + 1] : null;
})();

function walk(dir, out = []) {
    for (const f of readdirSync(dir)) {
        const p = join(dir, f);
        if (statSync(p).isDirectory()) {
            if (f === 'node_modules' || f.startsWith('.')) continue;
            walk(p, out);
        } else if (f.endsWith('.js')) out.push(p);
    }
    return out;
}

const files = fileArg ? [fileArg] : walk(join(ROOT, 'src'));
const buckets = { suspicious: [], manual: [], ok: [] };

for (const f of files) {
    let src;
    try { src = readFileSync(f, 'utf8'); } catch { continue; }
    const rel = relative(ROOT, f).replace(/\\/g, '/');
    const fields = extractDataFields(src);
    // ★ 例外（实测误报的大头）：`count` 与 `want` 同在一个 data 对象里时，`count` 是**项目既有约定** ——
    //   `formatActionOutcome` 读 `data.count` + `data.want` 渲染成「完成 N/M」
    //   （`src/agent/commands/actions.js:96-97`）。单独看 `count` 像缺口径，
    //   但**与 `want` 配对后语义完整**：数的是"已完成数"，分母是 `want`。
    //   ★ 这也是本工具的第一条误报实证 —— 所以它**默认不接门禁**：先看误报率再决定。
    const wantByObj = new Set(fields.filter((x) => x.key === 'want').map((x) => x.objId));
    for (const field of fields) {
        let verdict = classifyField(field.key, field.value);
        if (verdict === 'suspicious' && field.key === 'count' && wantByObj.has(field.objId)) verdict = 'ok';
        buckets[verdict].push({ ...field, file: rel });
    }
}

const show = (title, list, note) => {
    console.log(`\n── ${title}：${list.length} 处`);
    if (note) console.log(`   ${note}`);
    for (const x of list) {
        console.log(`  · ${x.file}:${x.line}  ${x.call}(...)  ${x.key} = ${String(x.value).slice(0, 60)}`);
    }
};

console.log('=== 诊断字段命名审计（data 字面量里的字段名是否含口径）===');
console.log(`扫描 ${files.length} 个文件`);
show('🔴 可疑：名字像计数但没口径', buckets.suspicious, '要改：加限定词（In/With/Before/After/crafted/table…）');
show('🟡 人工看：布尔三态 / 位置口径', buckets.manual, '布尔类需确认能否表达"没检测"（null）；位置类需确认面位/脚位');
console.log(`\n🟢 合规：${buckets.ok.length} 处（略）`);
console.log('\n注：本工具**只报告**，默认退出码 0。接门禁前请先人工过一遍 🔴 清单（看误报率）。');
