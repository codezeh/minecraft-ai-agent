/**
 * 第22 / 28 / 8(J4) / 29 条的回归测试 —— 不需要服务器，全部用假 bot。
 *
 * 每条都对应报告里一个"恒真/恒假/绕过"的判据缺陷：
 *   22. giveToPlayer：`if (got)` 恒真 —— waitUntil 返回**对象**，物品掉地上玩家没捡也报成功
 *   28. useToolOn：`!x === 'creative'` 恒假 —— "你没有这件工具"的早退永不执行
 *   8.  breakBlockAt：唯一通用拆方块出口，零代码判定 —— 玩家建筑照样被拆
 *   29. breakBlockAt / buildFromSchematic：裸 bot.chat 拼 /setblock，绕过 command() 白名单
 *
 * 输出格式：PASS <用例> <证据> / FAIL <用例> <实际>，全过退出码 0。
 */
import { readFileSync } from 'node:fs';
import Vec3 from 'vec3';
import { waitUntil, useToolOn, breakBlockAt } from '../src/agent/library/skills.js';

let pass = 0, fail = 0;
const okCase = (name, evidence = '') => { pass++; console.log(`PASS ${name} ${evidence}`); };
const badCase = (name, actual) => { fail++; console.log(`FAIL ${name} ${actual}`); };

function makeBot({ blockName = 'air', gameMode = 'survival', cheat = false, slots = [], entities = {} } = {}) {
    const chats = [];
    const bot = {
        username: 'unit_skills_property_guard',
        entity: { position: new Vec3(0.5, 64, 0.5) },
        entities,
        game: { gameMode },
        inventory: {
            slots,
            items: () => slots,
            findInventoryItem: (n) => slots.find((s) => s && s.name === n) ?? null,
        },
        modes: { isOn: (n) => (n === 'cheat' ? cheat : false), pause: () => {}, unpause: () => {} },
        blockAt: () => ({ name: blockName, position: new Vec3(5, 64, 5) }),
        findBlocks: () => [],
        chat: (t) => { chats.push(t); },
        output: '',
    };
    return { bot, chats };
}

// ── 1.（第22条 机理）waitUntil 超时也返回**对象**，对象永远是真值 ──────────
//     这就是 `if (got)` 恒真的原因：判据必须是 got.ok。
{
    const { bot } = makeBot();
    const r = await waitUntil(bot, () => false, { timeoutMs: 30, intervalMs: 10, label: 'unit-never' });
    if (r && typeof r === 'object' && r.ok === false && Boolean(r) === true) {
        okCase('waitUntil 超时返回真值对象 {ok:false}', `ok=${r.ok} 真值=${Boolean(r)} reason=${r.reason}`);
    } else {
        badCase('waitUntil 超时返回真值对象 {ok:false}', JSON.stringify(r));
    }
}

// ── 2.（第22条 判据）giveToPlayer 的成功判据必须是 got.ok，不能是 got ──────
//     行为层面要真跑 giveToPlayer 得拉起 pathfinder（goToPlayer/moveAwayFromEntity），
//     远超单测范围。这里退一步做**结构断言**：源码里那一行必须是 `got && got.ok`，
//     且不许再出现裸 `if (got) return true`（否则就是退回恒真）。
{
    const src = readFileSync(new URL('../src/agent/library/skills.js', import.meta.url), 'utf8');
    const fixed = /if \(got && got\.ok\) return true;/.test(src);
    const regressed = /if \(got\) return true;/.test(src);
    if (fixed && !regressed) {
        okCase('giveToPlayer 成功判据是 got.ok', '命中 `if (got && got.ok) return true;`，且无裸 `if (got)`');
    } else {
        badCase('giveToPlayer 成功判据是 got.ok', `fixed=${fixed} regressed=${regressed}`);
    }
}

// ── 3.（第28条）生存模式、背包没这件工具 ⇒ 早退 false，并说清原因 ─────────
{
    const { bot } = makeBot({ gameMode: 'survival', slots: [] });
    const r = await useToolOn(bot, 'diamond_pickaxe', 'nothing');
    if (r === false && /You do not have any diamond_pickaxe to use\./.test(bot.output)) {
        okCase('useToolOn 生存模式缺工具直接早退', '返回 false + 日志 "You do not have any … to use."');
    } else {
        badCase('useToolOn 生存模式缺工具直接早退', `r=${r} output=${JSON.stringify(bot.output.slice(-120))}`);
    }
}

// ── 4.（第28条 反向对照）有这件工具时不走早退（改走"找不到目标"分支）──────
//     用来证明这行判据不是"永远早退"——修之前它恰恰**从不**早退。
{
    const { bot } = makeBot({ gameMode: 'survival', slots: [{ name: 'diamond_pickaxe', type: 1, count: 1 }] });
    const r = await useToolOn(bot, 'diamond_pickaxe', 'unobtainium_block_xyz');
    const earlyExit = /You do not have any/.test(bot.output);
    if (r === false && !earlyExit && /Could not find any unobtainium_block_xyz\./.test(bot.output)) {
        okCase('useToolOn 有工具时不误判"没有工具"', '返回 false 且日志是 "Could not find any …"');
    } else {
        badCase('useToolOn 有工具时不误判"没有工具"', `r=${r} earlyExit=${earlyExit}`);
    }
}

// ── 5.（第8条 J4）breakBlockAt 拒绝拆玩家建筑，且一条命令都不发 ───────────
{
    const { bot, chats } = makeBot({ blockName: 'oak_planks', cheat: true });
    const r = await breakBlockAt(bot, 5, 64, 5);
    if (r === false && /REFUSED/.test(bot.output) && chats.length === 0) {
        okCase('breakBlockAt 拒绝拆玩家建筑', `返回 false + REFUSED + 发命令 ${chats.length} 条`);
    } else {
        badCase('breakBlockAt 拒绝拆玩家建筑', `r=${r} chats=${JSON.stringify(chats)}`);
    }
}

// ── 6.（第8条 J4 反向对照）天然方块照样能拆 ───────────────────────────────
{
    const { bot, chats } = makeBot({ blockName: 'stone', cheat: true });
    const r = await breakBlockAt(bot, 5, 64, 5);
    if (r === true && chats.length === 1) {
        okCase('breakBlockAt 仍然能拆天然方块', `发命令 ${JSON.stringify(chats[0])}`);
    } else {
        badCase('breakBlockAt 仍然能拆天然方块', `r=${r} chats=${JSON.stringify(chats)}`);
    }
}

// ── 7.（第29条）拆方块走 command()：发出去的是规范的 `/setblock x y z air` ──
//     走 command() 意味着**过了 permissions.SLASH_COMMANDS 白名单**（setblock 需 cheat:true）。
{
    const { bot, chats } = makeBot({ blockName: 'sand', cheat: true });
    await breakBlockAt(bot, 5, 64, 5);
    const cmd = chats[0] ?? '';
    if (cmd === '/setblock 5 64 5 air') {
        okCase('breakBlockAt 的 /setblock 走 command()', `发出 ${cmd}`);
    } else {
        badCase('breakBlockAt 的 /setblock 走 command()', JSON.stringify(chats));
    }
}

// ── 8.（第29条 结构性）skills.js 代码里不再有任何裸 bot.chat( 调用 ─────────
//     注释里提到旧写法不算（先剥掉注释行）。这条挡的是"又有人拼一条 /… 塞给 bot.chat"。
//     buildFromSchematic 的 /setblock 也单独断言改成了 command()。
{
    const src = readFileSync(new URL('../src/agent/library/skills.js', import.meta.url), 'utf8');
    const codeLines = src.split('\n').filter((line) => {
        const t = line.trim();
        return t && !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    });
    const chatCalls = codeLines.filter((l) => /\bbot\.chat\s*\(/.test(l));
    const schemViaCommand = /await command\(bot, 'setblock', \[wx, wy, wz, blockStateToString\(plan\)\]/.test(src);
    if (chatCalls.length === 0 && schemViaCommand) {
        okCase('skills.js 无裸 bot.chat，buildFromSchematic 的 setblock 也走 command()', '命中 0 处 bot.chat(');
    } else {
        badCase('skills.js 无裸 bot.chat，buildFromSchematic 的 setblock 也走 command()',
            `bot.chat 处数=${chatCalls.length} buildFromSchematic 走 command=${schemViaCommand} ${JSON.stringify(chatCalls)}`);
    }
}

console.log('============================================');
console.log(`${pass}/${pass + fail} 个用例通过`);
console.log('============================================');
process.exit(fail === 0 ? 0 : 1);
