/**
 * 场景 S4：F 聊天取消 —— 真机触发一次长动作，然后走**产品代码的 `!stop`**
 * （src/agent/commands/actions.js 里 commandMap 用的同一个对象），断言 bot 真的停手。
 *
 * 为什么不用 LLM：`!stop` 的 perform 只依赖 agent 的 actions/noteCancel/clearBotLogs/self_prompter，
 * 与模型无关；用它自己那份实现（不是复刻一份）就能验证"停"这条链路。
 *
 * 断言：
 *   F-1 长动作在停之前**确实在动**（位置在推进）—— 否则"停了"没有意义
 *   F-2 `!stop` 返回 'Agent stopped.' 且 actions.executing 变 false
 *   F-3 长动作被标成 interrupted（runAction 返回值）
 *   F-4 停手后 bot 位置稳定（1.5s 内水平位移 <0.5 格）
 *   F-5 stop 在 10s 内完成（没走到"僵尸动作重启"那条路）
 */
import { createHarness, makeBot, sleep, waitFor, dep, src } from './harness.mjs';
import path from 'node:path';
import fs from 'node:fs';

const SCENARIO = 's4-stop';
const NAME = 'r5e' + (Date.now() % 100000);
const log = (s) => console.log(s);

const h = await createHarness({ scenario: SCENARIO, levelType: 'flat' });

try {
    await h.boot();
    h.check('S4 起服：Done ( + RCON 就绪', true, h.logPath);

    process.env.MC_BOTS_ROOT = path.join(h.runDir, 'bots');
    fs.mkdirSync(path.join(h.runDir, 'bots', NAME, 'map'), { recursive: true });
    const bot = await makeBot({ name: NAME });
    h.check('S4 真 bot 已连上隔离服', !!bot.entity, `bot=${NAME}`);

    const Vec3 = dep('vec3');
    const { ActionManager } = await src('src/agent/action_manager.js');
    const { collect } = await src('src/agent/library/flow_collect.js');
    // ★ 必须从 commands/index.js 取（那是正常入口）；直接 import actions.js 会撞上
    //   index.js 的顶层 `actionsList` 初始化顺序问题（ReferenceError，见 06-ingame.md §F 备注）。
    const { getCommand } = await src('src/agent/commands/index.js');

    // 摆一棵树（让 collect 有真活干）
    const p = bot.entity.position.floored();
    await h.rc(`fill ${p.x - 4} ${p.y - 1} ${p.z - 4} ${p.x + 24} ${p.y - 1} ${p.z + 24} grass_block`);
    await h.rc(`fill ${p.x - 4} ${p.y} ${p.z - 4} ${p.x + 24} ${p.y + 8} ${p.z + 24} air`);
    for (const [tx, tz] of [[p.x + 12, p.z + 4], [p.x + 18, p.z + 14]]) {
        await h.rc(`fill ${tx - 2} ${p.y + 2} ${tz - 2} ${tx + 2} ${p.y + 5} ${tz + 2} oak_leaves`);
        for (let i = 0; i < 4; i++) await h.rc(`setblock ${tx} ${p.y + i} ${tz} oak_log`);
    }
    for (const g of ['iron_axe 1', 'cobblestone 32']) await h.rc(`give ${NAME} ${g}`);
    await sleep(1200);

    // ── 组一个"够真"的 agent：真 ActionManager + !stop 需要的那几个钩子 ──
    const cancels = [];
    const stubAgent = {
        bot,
        actions: null,
        noteCancel: (why) => cancels.push(why),
        clearBotLogs: () => {},
        self_prompter: { isActive: () => false },
        requestInterrupt: () => { bot.interrupt_code = true; },
    };
    stubAgent.actions = new ActionManager(stubAgent);

    const stopCmd = getCommand('!stop');
    h.check('S4 找到产品代码里的 !stop 命令实现', !!stopCmd, stopCmd ? "commands/index.js getCommand('!stop')" : '缺失');

    // ── 触发长动作（真流程 collect，8 个原木，够跑十几秒）──
    const start = bot.entity.position.clone();
    const samples = [];
    const sampler = setInterval(() => samples.push(bot.entity.position.clone()), 300);
    let actionReturn = null;
    const running = stubAgent.actions.runAction('action:collectBlocks', async () => {
        await collect(bot, 'oak_log', 8, { radius: 32, deadlineMs: 60000, onEvent: () => {} });
    }, { timeout: -1 }).then((r) => { actionReturn = r; });

    // 等它真的动起来（位置有推进），最多 15s
    const moved = await waitFor(() => {
        const cur = bot.entity.position;
        return Math.hypot(cur.x - start.x, cur.z - start.z) > 2.0;
    }, { timeoutMs: 15000, intervalMs: 300 });
    h.check('F-1 停之前长动作确实在动（位置推进 >2 格）', moved,
        `起点 ${start.toString()} → 现在 ${bot.entity.position.toString()}`);

    // ── 发 !stop ──
    const tStop = Date.now();
    const reply = await stopCmd.perform(stubAgent);
    const stopMs = Date.now() - tStop;
    await running.catch(() => {});
    clearInterval(sampler);

    const executingAfter = stubAgent.actions.executing;
    h.check('F-2 !stop 返回 "Agent stopped."', /Agent stopped/i.test(String(reply)), `返回：${String(reply)}`);
    h.check('F-2 !stop 后 actions.executing 变 false', executingAfter === false, `executing=${executingAfter}`);
    h.check('F-3 被停的长动作标记为 interrupted', actionReturn?.interrupted === true,
        `runAction 返回 ${JSON.stringify(actionReturn)?.slice(0, 200)}`);
    h.check('F-3 !stop 记了取消原因（agent.noteCancel 被调用）', cancels.length > 0, `cancels=${JSON.stringify(cancels)}`);
    h.check('F-5 stop 在 10s 内完成（没走僵尸动作重启）', stopMs < 10000, `耗时 ${stopMs}ms`);

    // ── 停手后真的不动了 ──
    await sleep(600);
    const pa = bot.entity.position.clone();
    await sleep(1500);
    const pb = bot.entity.position.clone();
    const drift = Math.hypot(pb.x - pa.x, pb.z - pa.z);
    h.check('F-4 停手后位置稳定（1.5s 内水平位移 <0.5 格）', drift < 0.5,
        `${pa.toString()} → ${pb.toString()}，位移 ${drift.toFixed(3)} 格`);

    // 反向对照：没有这次 !stop 的话，动作会跑完（用背包增量证明它本来能继续干）
    log(`[S4] 停手时背包 oak_log=${(bot.inventory.items().filter((i) => i.name === 'oak_log').reduce((n, i) => n + i.count, 0))}`);

} catch (e) {
    h.fail('S4 场景执行未抛异常', String(e?.stack ?? e).slice(0, 1500));
} finally {
    const stopped = await h.stop();
    h.check('S4 停服：RCON stop → java 进程退出', stopped === true, `java pid ${h.childPid}`);
    const s = h.summary();
    console.log(`\n[证据] server.log: ${h.logPath}`);
    process.exit(s.bad.length ? 1 : 0);
}
