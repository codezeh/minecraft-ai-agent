/**
 * t-r5-7 —— 「self_prompter.startLoop 无 try/finally ⇒ 一次异常后循环永久死、state 仍 ACTIVE」
 *
 * 缺陷形态（老实现）：`startLoop()` 的 while 体里 `await agent.handleMessage(...)`
 *   一旦 reject，整个 `startLoop()` 就地中断：
 *     ① `this.loop_active` 永远停在 true ⇒ `update()` 的自动重启判据 `!this.loop_active`
 *        恒假 ⇒ 目标循环**永久不再启动**；
 *     ② `this.state` 仍是 ACTIVE ⇒ 界面/存档都说"目标在跑"，实际早就死了。
 *
 * 判定方式（不靠读码，靠跑）：让 handleMessage 抛一次，然后看两个内部量：
 *     · loop_active=true 且 state=ACTIVE（=1）→ 缺陷复现，退出码 0；
 *     · loop_active 已复位 → 未复现，退出码 1。
 *
 * 用法：node .../t-r5-7.mjs ；R5_SRC=<pre-fix>/src node .../t-r5-7.mjs
 * 退出码：0=缺陷复现，1=未复现，2=CANNOT-RUN。
 */
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(process.env.R5_SRC || path.resolve(HERE, '../../../../../mindcraft/src'));
const say = (...a) => console.log('[t-r5-7]', ...a);

let SelfPrompter;
try {
    ({ SelfPrompter } = await import(pathToFileURL(path.join(SRC, 'agent/self_prompter.js')).href));
} catch (e) {
    console.error('[t-r5-7] CANNOT-RUN：导入 self_prompter.js 失败：', e?.message ?? e);
    process.exit(2);
}

const calls = { handleMessage: 0 };
const agent = {
    name: 'probe7',
    roles: [],
    bot: { inventory: { items: () => [] } },
    actions: { stop: async () => {}, executing: false },
    history: { memory: '' },
    isIdle: () => true,
    openChat: () => Promise.resolve(),
    // 第一次就抛：模拟模型层/工具层向上抛错
    async handleMessage() {
        calls.handleMessage++;
        throw new Error('[t-r5-7] 故意制造的目标循环异常');
    },
    board: null,
};

const sp = new SelfPrompter(agent);
sp.state = 1;          // ACTIVE
sp.prompt = '把基地周围的树砍完';

let threw = null;
try {
    // startLoop 在老实现里会把异常直接抛给调用方（没有 try/finally）
    await sp.startLoop();
} catch (e) {
    threw = e;
}
// 老实现是 fire-and-forget 场景（start() 不 await），这里两种都覆盖：给一个微任务/宏任务窗口
await new Promise((r) => setTimeout(r, 100));

say('handleMessage 调用次数：', calls.handleMessage);
say('startLoop 是否把异常抛给调用方：', threw ? String(threw.message) : 'no');
say('循环结束后：loop_active =', sp.loop_active, ' state =', sp.state, '(1=ACTIVE, 0=STOPPED)');
say('连续失败计数 loop_errors =', sp.loop_errors ?? '(无此字段)');

const loopStuck = sp.loop_active === true;
const stillActive = sp.state === 1;
if (loopStuck && stillActive) {
    say('REPRODUCED：一次异常后 loop_active 永久卡 true + state 仍 ACTIVE'
        + ' —— update() 的"自动重启"判据 !loop_active 恒假，目标循环再也不会启动');
    process.exit(0);
}
say(`NOT-REPRODUCED：异常后状态被说明清楚（loop_active=${sp.loop_active}, state=${sp.state}），未出现"假装在跑"`);
process.exit(1);
