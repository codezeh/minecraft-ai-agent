// 验证 skill_escape（复合层：从被困处挖上去）。
//
// 做法（用户 2026-10-27 定的）：
//   往头上挖 -> 跳一下 -> 在半空中往脚下垫方块 -> 落上去
// 关键是**先跳再垫**：跳起来那一瞬间她原来站的格子是空的，方块放得进去；
// 站着放会被自己的碰撞箱占住（那是之前的错）。
//
// 本测试只验「规划」（纯读世界、不改世界、可重复调用）。
import { planEscape, findScaffoldItem } from '../src/agent/library/skill_escape.js';

let passed = 0, failed = 0;
function check(name, cond, detail = '') {
    if (cond) { passed++; console.log(`  PASS  ${name}  ${detail}`); }
    else { failed++; console.log(`  FAIL  ${name}  ${detail}`); }
}

function fakeBot({ y = 42, solidAbove = 20, solidName = 'stone', items = [{ name: 'dirt', count: 64 }] } = {}) {
    return {
        entity: { position: { x: 10.5, y, z: 10.5 } },
        inventory: { items: () => items.map((it, i) => ({ ...it, type: i + 1 })) },
        blockAt: (pos) => {
            const by = Math.floor(pos.y);
            if (by <= y) return { name: 'stone', position: pos };
            if (by <= y + solidAbove) return { name: solidName, position: pos };
            return { name: 'air', position: pos };
        },
        dig: async () => true,
        interrupt_code: false,
    };
}

console.log('\n=== 1) 头顶 20 格实心岩石 ===');
{
    const bot = fakeBot({ y: 42, solidAbove: 20 });
    const plan = planEscape(bot, { maxBlocks: 6 });
    console.log(`  ${plan.why}`);
    console.log(`  步骤: ${plan.steps.map(s => s.act).join(' -> ')}`);

    check('能规划出步骤', plan.ok && plan.steps.length > 0, `${plan.steps.length} 步`);
    check('每层先挖头顶', plan.steps[0]?.act === 'dig', plan.steps[0]?.act);
    check('有 jumpPlace（跳+半空垫）', plan.steps.some(s => s.act === 'jumpPlace'), '');
    check('计划高度高于起点', plan.planToY > plan.fromY, `y ${plan.fromY} -> ${plan.planToY}`);
    const ups = plan.steps.filter(s => s.act === 'jumpPlace').length;
    check('层数 <= maxBlocks', ups <= 6 && ups >= 4, `${ups} 层`);
    // 2026-10-27 第五次修：每层要挖 2 格（y+1 和 y+2），否则跳跃空间不够。
    const digs = plan.steps.filter(s => s.act === 'dig').length;
    check('每层挖 2 格 + 1 跳垫 = 3 步', plan.steps.length === ups * 3 && digs === ups * 2,
        `${plan.steps.length} 步 / ${ups} 层 / ${digs} 挖`);
}

console.log('\n=== 2) 全是基岩（挖不动）===');
{
    const bot = fakeBot({ y: 42, solidAbove: 20, solidName: 'bedrock' });
    const plan = planEscape(bot, { maxBlocks: 6 });
    check('报 BLOCKED', plan.ok === false && plan.code === 'BLOCKED', plan.code ?? '-');
    check('说清是头顶挖不动', /头顶.*挖不动/.test(plan.why), plan.why);
}

console.log('\n=== 3) 背包没有垫脚方块 ===');
{
    const bot = fakeBot({ y: 42, solidAbove: 20, items: [{ name: 'iron_pickaxe', count: 1 }] });
    const plan = planEscape(bot, { maxBlocks: 6 });
    check('findScaffoldItem 返回 null', findScaffoldItem(bot) === null);
    // 规划阶段不管方块（方块是执行时的事），所以规划仍然成功
    check('规划仍能出（方块在 runEscape 里才检查）', plan.ok, `${plan.steps.length} 步`);
}

console.log('\n=== 4) 已经够高了 ===');
{
    const bot = fakeBot({ y: 80, solidAbove: 20 });
    const plan = planEscape(bot, { targetY: 79 });
    check('返回空计划', plan.ok && plan.steps.length === 0, plan.why);
}

console.log('\n=== 5) 规划不改世界（连算两次一致）===');
{
    const bot = fakeBot({ y: 42, solidAbove: 20 });
    const a = planEscape(bot, { maxBlocks: 5 });
    const b = planEscape(bot, { maxBlocks: 5 });
    check('两次步骤数一致', a.steps.length === b.steps.length, `${a.steps.length} vs ${b.steps.length}`);
    check('两次目标高度一致', a.planToY === b.planToY, `${a.planToY} vs ${b.planToY}`);
}

console.log('\n=== 6) 头顶就是空气 ===');
{
    const bot = fakeBot({ y: 42, solidAbove: 0 });
    const plan = planEscape(bot, { maxBlocks: 4 });
    const digs = plan.steps.filter(s => s.act === 'dig').length;
    const ups = plan.steps.filter(s => s.act === 'jumpPlace').length;
    check('不产生多余的挖', digs === 0, `${digs} 次挖`);
    check('仍然能往上走', ups > 0, `${ups} 层`);
}

console.log('\n=== 7) 垫脚方块识别 ===');
{
    for (const [name, expect] of [
        ['dirt', true], ['cobblestone', true], ['oak_planks', true],
        ['stone', true], ['torch', false], ['iron_pickaxe', false],
    ]) {
        const bot = { inventory: { items: () => [{ name, count: 1, type: 1 }] } };
        const got = findScaffoldItem(bot);
        check(`${name} -> ${expect ? '可用' : '不可用'}`, (got !== null) === expect, got ?? 'null');
    }
}

console.log('\n=== 8) 垂直挖（每层同一个 x/z）===');
{
    const bot = fakeBot({ y: 42, solidAbove: 20 });
    const plan = planEscape(bot, { maxBlocks: 4 });
    const ups = plan.steps.filter(s => s.act === 'jumpPlace');
    check('每层在同一 x/z（垂直，不是斜向）',
        ups.every(u => u.at.x === 10 && u.at.z === 10),
        `第一层 (${ups[0]?.at.x},${ups[0]?.at.z})`);
    const ys = ups.map(u => u.at.y);
    check('每层垫脚位置连续递增 1',
        ys.every((y, i) => i === 0 || y === ys[i - 1] + 1),
        ys.join(','));
}

console.log(`\n合计 ${passed} PASS / ${failed} FAIL`);
process.exit(failed ? 1 : 0);
