// 验证 skill_escape（复合层：从被困处挖上去）。
//
// 做法（用户 2026-10-27 定的）：
//   往头上挖 -> 跳一下 -> 在半空中往脚下垫方块 -> 落上去
// 关键是**先跳再垫**：跳起来那一瞬间她原来站的格子是空的，方块放得进去；
// 站着放会被自己的碰撞箱占住（那是之前的错）。
//
// 本测试只验「规划」（纯读世界、不改世界、可重复调用）。
//
// ★ 2026-11-01 随 skill_escape 规范整改同步更新：
//   - 返回契约改为 ok()/fail() 信封 → 断言从 plan.steps/plan.why 改为 plan.data.steps/plan.message
//   - 步骤名 jumpPlace → pillar（现在这一步就是调 atom_pillar.pillarUpOnce）
//   - 新增：头顶第二格挖不动只降空间、不致命；第一格挖不动才 BLOCKED
import { planEscape } from '../src/agent/library/flow_escape.js';
import { findScaffoldItem } from '../src/agent/library/scaffold_blocks.js';

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
            if (by <= y) return { name: 'stone', position: pos, diggable: true };
            if (by <= y + solidAbove) return { name: solidName, position: pos, diggable: solidName !== 'bedrock' };
            return { name: 'air', position: pos, diggable: false };
        },
        dig: async () => true,
        interrupt_code: false,
    };
}

console.log('\n=== 1) 头顶 20 格实心岩石 ===');
{
    const bot = fakeBot({ y: 42, solidAbove: 20 });
    const plan = planEscape(bot, { maxBlocks: 6 });
    const steps = plan.data?.steps ?? [];
    console.log(`  步骤: ${steps.map(s => s.act).join(' -> ')}`);

    check('能规划出步骤', plan.ok && steps.length > 0, `${steps.length} 步`);
    check('每层先挖头顶', steps[0]?.act === 'dig', steps[0]?.act);
    check('有 pillar（跳+半空垫）', steps.some(s => s.act === 'pillar'), '');
    check('计划高度高于起点', plan.data.planToY > plan.data.fromY, `y ${plan.data.fromY} -> ${plan.data.planToY}`);
    const ups = steps.filter(s => s.act === 'pillar').length;
    check('层数 <= maxBlocks', ups <= 6 && ups >= 4, `${ups} 层`);
    // 2026-10-27 第五次修：每层要挖 2 格（y+1 和 y+2），否则跳跃空间不够。
    const digs = steps.filter(s => s.act === 'dig').length;
    check('每层挖 2 格 + 1 跳垫 = 3 步', steps.length === ups * 3 && digs === ups * 2,
        `${steps.length} 步 / ${ups} 层 / ${digs} 挖`);
}

console.log('\n=== 2) 全是基岩（挖不动）===');
{
    const bot = fakeBot({ y: 42, solidAbove: 20, solidName: 'bedrock' });
    const plan = planEscape(bot, { maxBlocks: 6 });
    check('报 BLOCKED（码在白名单内）', plan.ok === false && plan.code === 'BLOCKED', plan.code ?? '-');
    check('说清是头顶挖不动', /头顶.*挖不动/.test(plan.message), plan.message);
}

console.log('\n=== 3) 背包没有垫脚方块 ===');
{
    const bot = fakeBot({ y: 42, solidAbove: 20, items: [{ name: 'iron_pickaxe', count: 1 }] });
    const plan = planEscape(bot, { maxBlocks: 6 });
    check('findScaffoldItem 返回 null', findScaffoldItem(bot) === null);
    // 规划阶段不管方块（方块是执行时的事），所以规划仍然成功
    check('规划仍能出（方块在 runEscape 里才检查）', plan.ok, `${plan.data?.steps?.length ?? 0} 步`);
}

console.log('\n=== 4) 已经够高了 ===');
{
    const bot = fakeBot({ y: 80, solidAbove: 20 });
    const plan = planEscape(bot, { targetY: 79 });
    check('返回空计划且 ok（不是失败）', plan.ok && plan.data.steps.length === 0, `${plan.data.steps.length} 步`);
}

console.log('\n=== 5) 规划不改世界（连算两次一致）===');
{
    const bot = fakeBot({ y: 42, solidAbove: 20 });
    const a = planEscape(bot, { maxBlocks: 5 });
    const b = planEscape(bot, { maxBlocks: 5 });
    check('两次步骤数一致', a.data.steps.length === b.data.steps.length, `${a.data.steps.length} vs ${b.data.steps.length}`);
    check('两次目标高度一致', a.data.planToY === b.data.planToY, `${a.data.planToY} vs ${b.data.planToY}`);
}

console.log('\n=== 6) 头顶就是空气 ===');
{
    const bot = fakeBot({ y: 42, solidAbove: 0 });
    const plan = planEscape(bot, { maxBlocks: 4 });
    const steps = plan.data?.steps ?? [];
    const digs = steps.filter(s => s.act === 'dig').length;
    const ups = steps.filter(s => s.act === 'pillar').length;
    check('不产生多余的挖', digs === 0, `${digs} 次挖`);
    check('仍然能往上走', ups > 0, `${ups} 层`);
}

console.log('\n=== 7) 垫脚方块识别（唯一清单 scaffold_blocks）===');
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
    const ups = plan.data.steps.filter(s => s.act === 'pillar');
    check('每层在同一 x/z（垂直，不是斜向）',
        ups.every(u => u.at.x === 10 && u.at.z === 10),
        `第一层 (${ups[0]?.at.x},${ups[0]?.at.z})`);
    const ys = ups.map(u => u.at.y);
    check('每层垫脚位置连续递增 1',
        ys.every((y, i) => i === 0 || y === ys[i - 1] + 1),
        ys.join(','));
}

console.log('\n=== 9) 第二格挖不动只降空间、不致命（第一格才致命）===');
{
    // 头顶 y+1 可挖（stone），y+2 是基岩
    const bot = {
        entity: { position: { x: 10.5, y: 42.5, z: 10.5 } },
        inventory: { items: () => [{ name: 'dirt', count: 64, type: 1 }] },
        blockAt: (pos) => {
            const by = Math.floor(pos.y);
            if (by <= 42) return { name: 'stone', position: pos, diggable: true };
            if (by === 43) return { name: 'stone', position: pos, diggable: true };
            if (by === 44) return { name: 'bedrock', position: pos, diggable: false };
            return { name: 'air', position: pos, diggable: false };
        },
        interrupt_code: false,
    };
    const plan = planEscape(bot, { maxBlocks: 1 });
    const steps = plan.data?.steps ?? [];
    const digs = steps.filter(s => s.act === 'dig').length;
    check('只挖第一格就够（y+2 挖不动不致命）', plan.ok && digs === 1, `${digs} 次挖 / ok=${plan.ok}`);
}

console.log(`\n合计 ${passed} PASS / ${failed} FAIL`);
process.exit(failed ? 1 : 0);
