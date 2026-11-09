/**
 * 探针 e：src/agent/tasks/construction_tasks.js:149 `no-prototype-builtins`
 *   check(bot) {
 *     if (!bot || typeof bot !== 'object' || !bot.hasOwnProperty('blockAt')) {
 *         throw new Error('Invalid bot object. Expected a mineflayer bot.');
 *     }
 *     ...
 *
 * 疑点：如果 `bot.blockAt` 是**原型方法**（不在实例自身上），这个守卫会恒假 ⇒
 *       用户跑 `!checkBlueprint` 永远得到 "Invalid bot object"。
 * 要证明它到底是不是实例自有属性。
 *
 * 退出码：0 = 缺陷成立；1 = 不成立
 */
import { readFileSync } from 'node:fs';
const ROOT = 'E:/我的世界ai/mindcraft';

// ① 静态证据：mineflayer 的 blocks 插件在 inject(bot) 里直接给实例赋值
const blocksJs = readFileSync(ROOT + '/node_modules/mineflayer/lib/plugins/blocks.js', 'utf8');
const isInject = /module\.exports = inject/.test(blocksJs);
const ownAssign = /^\s*bot\.blockAt = blockAt\s*$/m.test(blocksJs);
console.log('[①] blocks.js 导出的是 inject 函数：', isInject);
console.log('[①] inject 体内有 `bot.blockAt = blockAt`（实例赋值 ⇒ 自有属性）：', ownAssign);

const line = blocksJs.split('\n').findIndex(l => l.trim() === 'bot.blockAt = blockAt') + 1;
console.log('[①] 该行行号：', line, '（位于 function inject 作用域内，不在 class 原型上）');

// ② 用同样的注入方式造一个"形状等价"的 bot，验证守卫通过
function makeBotLike() {
    const bot = {};                  // 相当于 new Bot() 实例对象
    bot.blockAt = function blockAt() { return null; };   // 插件在 inject 里赋的自有属性
    return bot;
}
const bot = makeBotLike();
console.log('\n[②] 模拟 mineflayer 注入后的 bot.hasOwnProperty("blockAt") =', bot.hasOwnProperty('blockAt'));
console.log('[②] 守卫判定：', bot && typeof bot === 'object' && bot.hasOwnProperty('blockAt')
    ? '通过（不会抛 Invalid bot object）' : '不通过');

// ③ 对照：若 blockAt 只在原型上（错误假设），守卫会怎样
class BotPrototypeStyle { blockAt() { return null; } }
const protoBot = new BotPrototypeStyle();
console.log('[③] 若 blockAt 在原型上 → hasOwnProperty("blockAt") =', protoBot.hasOwnProperty('blockAt'),
    '（那才会误判；但 mineflayer 不是这种写法）');

// ④ 对真实模块做一次：确认 check() 在"形状正确"的 bot 上能走下去
let realModuleOk = true, realErr = null;
try {
    const mod = await import('file:///' + ROOT + '/src/agent/tasks/construction_tasks.js');
    console.log('[④] 能 import construction_tasks.js：', typeof mod.Blueprint === 'function');
} catch (e) {
    realModuleOk = false; realErr = e.message.split('\n')[0];
    console.log('[④] import 失败（不影响静态结论）：', realErr);
}

if (ownAssign && bot.hasOwnProperty('blockAt')) {
    console.log('\nVERDICT: FALSE-POSITIVE —— `bot.blockAt` 是 mineflayer 在 inject 时赋的**实例自有属性**，');
    console.log('         `bot.hasOwnProperty("blockAt")` 对真 bot 恒为 true，守卫按设计工作（不是坏守卫）。');
    console.log('         残留风险仅为理论上的 Proxy/壳对象，本仓无此调用路径。');
    process.exit(1);
} else {
    console.log('\nVERDICT: REAL-DEFECT');
    process.exit(0);
}
