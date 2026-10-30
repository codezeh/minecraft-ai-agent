/**
 * 启动自检：找出「模型看不见的技能」。
 *
 * 背景：`docHelper` 用 `skillFunc.toString()` 提取文档，而 `toString()` **不含函数上方的注释**。
 * 所以 JSDoc 必须写在函数**体内**（结尾用 `**\/`）。
 * 这是反直觉的约定 —— README 里记了 3 次还是被踩，代价是：
 * `tradeWithVillager` / `showVillagerTrades` 两个技能对模型**完全隐形**，
 * 她不是不会用，是压根不知道有这两个函数。
 *
 * 与其靠人记，不如启动时扫一遍：
 *   1) 有哪些导出函数体内没有 JSDoc（= 模型看不到）
 *   2) 其中哪些**确实被代码引用**（skills.xxx( 或 world.xxx( ）——
 *      这些才是"用户能用但模型不知道"的真问题
 *
 * 只告警、不阻塞启动。内部工具函数（log / 模式访问器等）默认白名单跳过。
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** 内部工具，本来就不该出现在技能目录里 */
const INTERNAL_OK = new Set([
    'skills.log',
    'skills.modesIsOn',
    'skills.modesPause',
    'skills.modesUnpause',
    'skills.facingName',
    'skills.resetHazardCache',
]);

/** 递归收集 .js 文件（跳过 node_modules / bots / tmp） */
function collectJs(dir, out = [], depth = 0) {
    if (depth > 6) return out;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return out; }
    for (const e of entries) {
        if (e.name === 'node_modules' || e.name === 'bots' || e.name === 'tmp' || e.name.startsWith('.')) continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) collectJs(full, out, depth + 1);
        else if (e.name.endsWith('.js')) out.push(full);
    }
    return out;
}

/**
 * 执行自检。
 * @param {string[]} skillDocs, getSkillDocs() 的结果
 * @param {string} srcRoot, 要扫描引用的源码根目录（默认 mindcraft/src）
 * @returns {{documented: number, invisible: string[], invisibleButUsed: string[]}}
 */
export function checkSkillDocs(skillDocs, srcRoot = null) {
    const root = srcRoot || path.resolve(__dirname, '../../');
    const documented = new Set((skillDocs || []).map(d => d.split('\n')[0].trim()));

    // 1) 扫源码里技能模块的导出函数，看谁体内没有 JSDoc
    const libFiles = [path.join(root, 'agent/library/skills.js'), path.join(root, 'agent/library/world.js')];
    const invisible = [];
    for (const file of libFiles) {
        let src;
        try { src = fs.readFileSync(file, 'utf8'); } catch (e) { continue; }
        const moduleName = path.basename(file, '.js');
        const re = /export\s+(?:async\s+)?function\s+(\w+)\s*\([^)]*\)\s*\{/g;
        let m;
        while ((m = re.exec(src)) !== null) {
            const name = `${moduleName}.${m[1]}`;
            // 注意：JS 的 RegExp match **没有 .end**（那是 .NET/Java 的 API）。
            // 我一开始写了 m.end，它恒为 undefined -> slice(undefined) 得到空串
            // -> 所有函数都被判成"体内没有文档"。必须用 index + 匹配长度。
            const matchEnd = m.index + m[0].length;
            const head = src.slice(matchEnd, matchEnd + 200);
            // docHelper 的判据：函数体内第一段是不是 /**
            if (!head.trimStart().startsWith('/**')) invisible.push(name);
        }
    }

    // 2) 扫所有源码，看哪些技能名真的被引用（skills.xxx( / world.xxx( ）
    const referenced = new Set();
    for (const file of collectJs(root)) {
        if (file.endsWith('skills.js') || file.endsWith('world.js')) {
            // 定义文件内部也会自调用，跳过自己，避免全算"被引用"
            continue;
        }
        let src;
        try { src = fs.readFileSync(file, 'utf8'); } catch (e) { continue; }
        const re2 = /\b(skills|world)\.(\w+)\s*\(/g;
        let m2;
        while ((m2 = re2.exec(src)) !== null) referenced.add(`${m2[1]}.${m2[2]}`);
    }
    // 技能之间互相调用也算（skills.js 内部）
    try {
        const libSrc = fs.readFileSync(path.join(root, 'agent/library/skills.js'), 'utf8');
        const re3 = /\b(?:skills|world)\.(\w+)\s*\(/g;
        let m3;
        while ((m3 = re3.exec(libSrc)) !== null) referenced.add(`skills.${m3[1]}`);
    } catch (e) { /* ignore */ }

    const invisibleButUsed = invisible.filter(
        n => referenced.has(n) && !INTERNAL_OK.has(n) && !documented.has(n));

    return { documented: documented.size, invisible, invisibleButUsed };
}

/** 跑自检并把结果打到控制台（只在有问题时说） */
export function reportSkillDocs(skillDocs, srcRoot = null) {
    try {
        const r = checkSkillDocs(skillDocs, srcRoot);
        if (r.invisibleButUsed.length) {
            console.warn(
                `[skill-docs] 有 ${r.invisibleButUsed.length} 个技能被代码用到、但模型看不到 ` +
                `（JSDoc 写在了函数上方？必须写在函数体内）:\n  ` +
                r.invisibleButUsed.join('\n  '));
        } else {
            console.log(`[skill-docs] 自检通过：${r.documented} 个技能文档模型可见，` +
                `没有"被用到却看不见"的技能。`);
        }
        return r;
    } catch (e) {
        console.warn('[skill-docs] 自检失败（不影响启动）:', e.message);
        return null;
    }
}
