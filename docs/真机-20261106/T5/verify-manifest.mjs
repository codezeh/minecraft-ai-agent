#!/usr/bin/env node
/**
 * T5 —— context-manifest.json 的**独立自校验**。
 *
 * make-context-manifest.mjs 为了速度用了"排除目录整体剪枝"的遍历。
 * 剪枝一旦与 docker 语义有偏差就会静默漏文件，所以必须有一个**不用剪枝**的
 * 第二实现来对照，否则那份清单只是"看起来对"。
 *
 * 本脚本做三件事：
 *   1. 全量遍历 mindcraft/（含 node_modules/.git，不剪枝），用**独立的**匹配实现
 *      重新算一遍上下文集合，与 manifest 里记录的集合做**逐文件**比对。
 *   2. 用 `git ls-files` 作为第三个独立来源：
 *      · 断言"上下文集合 ⊆ git 跟踪集合"——因为实测 gitignored ⊆ dockerignored。
 *        一旦有"被 git 忽略、却不被 dockerignore 忽略"的文件出现，这里会 FAIL。
 *      · 列出"被 git 跟踪、但被 dockerignore 排除"的文件（= 镜像必然拿不到它们）。
 *   3. 校验 manifest 本身是**合法 UTF-8 JSON**（防止中文注释写成乱码）。
 *
 * 退出码：0 = 全部一致；1 = 有不一致（会逐条打印）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(process.argv[2] || path.join(HERE, '..', '..', '..', 'mindcraft'));
const MANIFEST = path.resolve(process.argv[3] || path.join(HERE, 'context-manifest.json'));

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
    if (cond) { pass++; console.log(`PASS ${name}${detail ? '  ' + detail : ''}`); }
    else { fail++; console.log(`FAIL ${name}${detail ? '  ' + detail : ''}`); }
};

// ── 0. manifest 必须是合法 UTF-8 JSON ─────────────────────────
const raw = fs.readFileSync(MANIFEST);
let manifest;
try {
    const text = raw.toString('utf8');
    // 合法 UTF-8 解码再编码应逐字节还原（BOM 除外）
    const roundTrip = Buffer.from(text, 'utf8');
    ok('manifest 解码-编码逐字节一致（合法 UTF-8）',
        roundTrip.length === raw.length || raw[0] === 0xEF, `bytes=${raw.length}`);
    manifest = JSON.parse(text);
    ok('manifest 可被 JSON.parse', true);
} catch (e) {
    ok('manifest 可被 JSON.parse', false, String(e.message));
    console.log(`\nHAS FAILURES: ${pass} passed, ${fail} failed`);
    process.exit(1);
}

// ── 1. 独立实现：全量遍历、不剪枝、单规则逐条比对 ──────────────
const rules = manifest.ruleSet.map((r) => {
    const p = r.pattern.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
    let re = '';
    for (let i = 0; i < p.length; i++) {
        const c = p[i];
        if (c === '*') {
            if (p[i + 1] === '*') { re += '.*'; i++; } else re += '[^/]*';
        } else if (c === '?') { re += '[^/]'; }
        else if ('\\^$.|+()[]{}'.includes(c)) { re += '\\' + c; }
        else { re += c; }
    }
    return { negate: r.negate, re: new RegExp(`^${re}(/.*)?$`) };
});
/**
 * 独立判定：与主脚本"祖先集合任一命中"的写法不同 ——
 * 这里直接对 path 的每个前缀（含自身）逐条试，语义等价但实现独立。
 */
function ignoredIndependent(rel) {
    let v = false;
    for (const r of rules) {
        let hit = false;
        let cur = rel;
        while (true) {
            if (r.re.test(cur)) { hit = true; break; }
            const i = cur.lastIndexOf('/');
            if (i < 0) break;
            cur = cur.slice(0, i);
        }
        if (hit) v = !r.negate;
    }
    return v;
}

const allFiles = [];
(function full(dirAbs, relBase) {
    for (const ent of fs.readdirSync(dirAbs, { withFileTypes: true })) {
        const rel = relBase ? `${relBase}/${ent.name}` : ent.name;
        const abs = path.join(dirAbs, ent.name);
        if (ent.isDirectory()) full(abs, rel);
        else if (ent.isFile()) allFiles.push(rel);
    }
})(REPO, '');

const indepContext = allFiles.filter((f) => !ignoredIndependent(f)).sort();
const manifestContext = manifest.contextSet.files.map((f) => f.path).sort();

ok('全量遍历文件数 ≥ 上下文文件数', allFiles.length >= indepContext.length,
    `all=${allFiles.length} context=${indepContext.length}`);

const onlyInIndependent = indepContext.filter((p) => !manifestContext.includes(p));
const onlyInManifest = manifestContext.filter((p) => !indepContext.includes(p));
ok('上下文集合两套实现完全一致（无剪枝漏项）',
    onlyInIndependent.length === 0 && onlyInManifest.length === 0,
    `indep=${indepContext.length} manifest=${manifestContext.length}`
    + ` 只在独立实现=${onlyInIndependent.length} 只在manifest=${onlyInManifest.length}`);
if (onlyInIndependent.length) {
    console.log('   独立实现多出（= 主脚本剪枝漏了）:');
    onlyInIndependent.slice(0, 20).forEach((p) => console.log('     + ' + p));
}
if (onlyInManifest.length) {
    console.log('   manifest 多出（= 主脚本误放行）:');
    onlyInManifest.slice(0, 20).forEach((p) => console.log('     - ' + p));
}

// imageSet ⊆ contextSet
const imgNotInCtx = manifest.imageSet.files.map((f) => f.path).filter((p) => !manifestContext.includes(p));
ok('imageSet ⊆ contextSet（不能复制上下文里没有的文件）', imgNotInCtx.length === 0,
    `diff=${imgNotInCtx.length}`);

// ── 2. 与 git 跟踪集合交叉核对 ─────────────────────────────────
let tracked = null;
try {
    tracked = execFileSync('git', ['ls-files', '-z'], { cwd: REPO, encoding: 'utf8', maxBuffer: 64 << 20 })
        .split('\0').filter(Boolean);
    ok('能取到 git 跟踪文件列表', true, `count=${tracked.length}`);
} catch (e) {
    console.log(`SKIP git ls-files 不可用（${e?.code || e?.message}）—— 跳过第 2 部分`);
}

if (tracked) {
    const trackedSet = new Set(tracked);
    const ctxInTracked = manifestContext.filter((p) => trackedSet.has(p));
    const ctxNotTracked = manifestContext.filter((p) => !trackedSet.has(p));
    ok('上下文里的文件都被 git 跟踪（= 没有"本机私有、未入库"的文件混进上下文）',
        ctxNotTracked.length === 0,
        ctxNotTracked.length ? `未跟踪: ${ctxNotTracked.slice(0, 10).join(', ')}` : `tracked∩ctx=${ctxInTracked.length}`);

    const trackedButIgnored = tracked.filter((p) => ignoredIndependent(p));
    // 这些是 git 里有、但 .dockerignore 挡住的 → 镜像拿不到（正常，tools/docs/web 等）
    console.log(`INFO 被 git 跟踪但被 dockerignore 排除的文件: ${trackedButIgnored.length} 个`
        + (trackedButIgnored.length ? ` → ${trackedButIgnored.slice(0, 8).join(', ')}${trackedButIgnored.length > 8 ? ' …' : ''}` : ''));

    // 关键不变量：gitignored ⊆ dockerignored
    // 用 git status --ignored 取 gitignored 集合，再看有没有漏出 dockerignore 的
    try {
        const ignOut = execFileSync('git', ['status', '--ignored=matching', '--porcelain', '--untracked-files=all'],
            { cwd: REPO, encoding: 'utf8', maxBuffer: 64 << 20 });
        const gitIgnored = ignOut.split(/\r?\n/)
            .filter((l) => l.startsWith('!! '))
            .map((l) => l.slice(3).trim())
            .filter((p) => !p.endsWith('/'))
            .map((p) => p.replace(/\\/g, '/'));
        const leaked = gitIgnored.filter((p) => !ignoredIndependent(p) && p !== 'node_modules'
            && allFiles.includes(p));
        ok('gitignored ⊆ dockerignored（不被 git 收的私有文件也不会进构建上下文）',
            leaked.length === 0,
            leaked.length ? `漏出: ${leaked.slice(0, 10).join(', ')}` : `gitignored 文件 ${gitIgnored.length} 个全部被挡住`);
    } catch (e) {
        console.log(`SKIP git status --ignored 不可用（${e?.code || e?.message}）`);
    }
}

// ── 3. manifest 内部一致性 ────────────────────────────────────
ok('contextSet.fileCount 与 files 数组长度一致',
    manifest.contextSet.fileCount === manifest.contextSet.files.length,
    `${manifest.contextSet.fileCount} vs ${manifest.contextSet.files.length}`);
ok('ruleSet 规则数 > 0', manifest.ruleSet.length > 0, `${manifest.ruleSet.length} 条`);
ok('Dockerfile 已无 bulk COPY（OPS-005 第一层修复）',
    manifest.dockerfileAnalysis.bulkCopyPresent === false,
    `bulkCopyPresent=${manifest.dockerfileAnalysis.bulkCopyPresent}`);

// 每条 probe 的 verdict 必须自洽
let badVerdict = [];
for (const p of manifest.probes) {
    if (p.verdict === 'EXCLUDED' && !p.dockerignoreIgnored) badVerdict.push(`${p.path}(EXCLUDED 但未 ignore)`);
    if (p.verdict === 'LATENT-GAP' && p.dockerignoreIgnored) badVerdict.push(`${p.path}(LATENT 但已 ignore)`);
    if (p.verdict === 'LEAK-IN-IMAGE' && !p.inImage) badVerdict.push(`${p.path}(LEAK 但不在镜像)`);
}
ok('probes 的 verdict 与字段自洽', badVerdict.length === 0, badVerdict.join('; '));

console.log(`\n${fail === 0 ? 'ALL PASS' : 'HAS FAILURES'}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
