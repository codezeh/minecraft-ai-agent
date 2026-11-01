import * as skills from './skills.js';
import * as world from './world.js';


/**
 * 从函数源码里截 JSDoc，拼成给模型看的说明。
 *
 * D24（2026-11-02 修）：原来用 `indexOf` 找**双星号**闭合符，但本仓库两种闭合写法都有
 * （多数以双星号结尾，也有大量以单星号结尾）。后者找不到终点返回 -1，
 * 于是 `substring(起点, -1)` 把**整段函数体**一起截了进来 ——
 * 实测 104 条里 36 条超长、合计 5.5 万字符，模型看到的是代码而不是说明。
 *
 * 修法：用正则匹配注释块本身（非贪婪，两种闭合写法都能吃下）；
 * 没有注释的函数整条跳过（宁可少一条文档，也不要把一段代码塞进上下文）。
 */
const DOC_BLOCK_RE = /\/\*\*([\s\S]*?)\*\//;

export function docHelper(functions, module_name) {
    const docArray = [];
    for (const skillFunc of functions) {
        if (typeof skillFunc !== 'function') continue;
        const str = String(skillFunc.toString());
        const m = str.match(DOC_BLOCK_RE);
        if (!m) continue;
        const body = m[1]
            .split('\n')
            .map((line) => line.replace(/^\s*\*\s?/, ''))
            .join('\n')
            .trim();
        if (!body) continue;
        docArray.push(`${module_name}.${skillFunc.name}\n${body}`);
    }
    return docArray;
}

export function getSkillDocs() {
    let docArray = [];
    docArray = docArray.concat(docHelper(Object.values(skills), 'skills'));
    docArray = docArray.concat(docHelper(Object.values(world), 'world'));
    return docArray;
}
