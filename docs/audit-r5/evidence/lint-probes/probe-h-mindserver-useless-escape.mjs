/**
 * 探针 h：src/mindcraft/mindserver.js:491 `no-useless-escape`
 *   '<ol><li>打开文件 <code>mindcraft\.mindserver-token</code>，复制里面的值</li>' +
 *
 * 关键判断：`\.` 在**单引号字符串**里同样是"非转义序列"⇒ 反斜杠被丢弃 ⇒ 输出 `mindcraft.mindserver-token`。
 *   于是要问：这一行**想显示什么**？同文件 499 行写的是 `mindcraft/.mindserver-token`（斜杠）。
 *   ⇒ 若两者本该一致，那这里输出的是**错误的文件名**（用户会去找一个不存在的文件）。
 *
 * 退出码：0 = 缺陷成立；1 = 不成立
 */
import { readFileSync } from 'node:fs';
const src = readFileSync('E:/我的世界ai/mindcraft/src/mindcraft/mindserver.js', 'utf8').split('\n');
console.log('[源码 491 行]', JSON.stringify(src[490].trim()));
console.log('[源码 499 行]', JSON.stringify(src[498].trim()));

// ① 单引号字符串里 `\.` 的真实结果
const rendered = 'mindcraft\.mindserver-token';
console.log('\n[①] `\'mindcraft\\.mindserver-token\'` 实际渲染 →', JSON.stringify(rendered));
console.log('[①] 与 `mindcraft.mindserver-token` 相等：', rendered === 'mindcraft.mindserver-token');
console.log('[①] 与 499 行那种 `mindcraft/.mindserver-token` 相等：', rendered === 'mindcraft/.mindserver-token');

// ② 真实文件是否存在（用户照 491 行的提示去找会怎样）
import { existsSync } from 'node:fs';
for (const p of ['E:/我的世界ai/mindcraft/mindcraft.mindserver-token', 'E:/我的世界ai/mindcraft/mindcraft/.mindserver-token',
                 'E:/我的世界ai/mindcraft/.mindserver-token']) {
    console.log('[②] 存在？', JSON.stringify(p), '→', existsSync(p));
}

// ③ 两份提示文案是否自相矛盾
const htmlLine = src[490];
const textLine = src[498];
console.log('\n[③] 401 HTML 提示的文件名写法：', /mindcraft\\\.mindserver-token/.test(htmlLine) ? '带反斜杠（渲染成点）' : '其它');
console.log('[③] 401 纯文本提示的文件名写法：', /mindcraft\/\.mindserver-token/.test(textLine) ? '带斜杠（mindcraft/.mindserver-token）' : '其它');

const mimatched = rendered !== 'mindcraft/.mindserver-token';
console.log('\n注意区分两层：规则本身（`\\.` 是冗余转义、不改变行为）vs 文案（渲染出的文件名与 499 行不一致）');
if (mimatched) {
    console.log('VERDICT: FALSE-POSITIVE（规则维度：转义冗余、行为无损）');
    console.log('         + 附注：文案渲染成 `mindcraft.mindserver-token`，与同函数 499 行的 `mindcraft/.mindserver-token` 不一致，');
    console.log('           属**低危文案不一致**，不是本规则造成的语义错误。');
    process.exit(1);
} else {
    console.log('VERDICT: REAL-DEFECT');
    process.exit(0);
}
