/**
 * 探针 g：src/agent/commands/queries.js:59 `no-useless-escape`
 *   res += `\- Current Action: ${action}`;
 *
 * 关键判断：`\-` 出现在**模板字符串**里（不是正则），模板里 `\-` 是"非转义序列"，
 *          JS 规定反斜杠被**丢弃**，结果就是 `-`。所以：
 *            · 若确实是模板字符串 ⇒ 输出与 `- Current Action` 逐字节相同 ⇒ 语义无损（误报/笔误）
 *            · 若被当正则会报错
 *
 * 退出码：0 = 缺陷成立；1 = 不成立
 */
import { readFileSync } from 'node:fs';
const line = readFileSync('E:/我的世界ai/mindcraft/src/agent/commands/queries.js', 'utf8')
    .split('\n')[58];   // 第 59 行（1-based）
console.log('[源码 59 行] ', JSON.stringify(line.trim()));

// ① 模板字符串里 `\-` 的真实结果
const withEscape = `\- Current Action: Idle`;
const withoutEscape = `- Current Action: Idle`;
console.log('[①] `\\- Current Action: Idle` →', JSON.stringify(withEscape));
console.log('[①] `-  Current Action: Idle` →', JSON.stringify(withoutEscape));
console.log('[①] 两者逐字节相等：', withEscape === withoutEscape);

// ② 反证：同样的 `\-` 放在正则里会怎样
let regexNote;
try { new RegExp('\\-'); regexNote = '正则里 `\\-` 合法（转义成字面量 -）'; } catch (e) { regexNote = 'Regex 构造失败: ' + e.message; }
console.log('[②] 若这段被当正则：', regexNote, '（本次是模板串，不是正则）');

// ③ 该行与相邻行的格式一致性（`- Time:` 那种写法）
const src = readFileSync('E:/我的世界ai/mindcraft/src/agent/commands/queries.js', 'utf8').split('\n');
const neighbours = src.slice(46, 60).filter(l => l.includes("res += '-") || l.includes('res += "-') || l.includes('`-'));
console.log('[③] 相邻同类行：', neighbours.length, '条，例：', JSON.stringify((neighbours[0] || '').trim()));

if (withEscape === withoutEscape) {
    console.log('\nVERDICT: FALSE-POSITIVE —— `\\-` 在模板字符串里被 JS 丢弃，输出与 `-` 逐字节相同；');
    console.log('         属"多余转义/笔误"，无行为影响（若真要改，删掉反斜杠即可，零风险）。');
    process.exit(1);
} else {
    console.log('\nVERDICT: REAL-DEFECT —— 反斜杠进入了输出文本');
    process.exit(0);
}
