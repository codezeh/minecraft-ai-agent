// 验证 atom_move.makeMovements 的垫脚方块清单（2026-10-26 修的 bug）。
//
// 修的是什么：
//   原来 makeMovements 从不设置 scafoldingBlocks → 用 pathfinder 默认的
//   [dirt, cobblestone]。她背包里的木板/原木不在清单里，就等于"没材料"，
//   于是 A* 认为搭不了桥（remainingBlocks=0），白白绕开本可以搭过去的地形。
//
// 期望行为：
//   1) 背包有 oak_planks → 清单里有 planks 的方块 id，allow1by1towers 保持 true
//   2) 背包什么都没有  → allow1by1towers 变 false，清单为空
//   3) 背包有 dirt      → 清单里有 dirt（兼容旧行为）
//   4) scaffold=false   → 永远不搭（不受清单影响）
import pf from 'mineflayer-pathfinder';
import mcDataFactory from 'minecraft-data';
import { makeMovements } from '../src/agent/library/atom_move.js';

const mcData = mcDataFactory('1.21.8');

let passed = 0, failed = 0;
function check(name, cond, detail = '') {
    if (cond) { passed++; console.log(`  PASS  ${name}  ${detail}`); }
    else { failed++; console.log(`  FAIL  ${name}  ${detail}`); }
}

function fakeBot(items) {
    return {
        registry: mcData,
        entity: { isInLava: false, position: { x: 0, y: 64, z: 0 }, effects: {} },
        inventory: { items: () => items },
        game: { dimension: 'overworld' },
    };
}

const idOf = (name) => mcData.blocksByName[name]?.id;

// ---------- 1) 只有木板 ----------
{
    const m = makeMovements(fakeBot([{ name: 'oak_planks', count: 5, type: 5 }]), { scaffold: true });
    const expectId = idOf('oak_planks');
    check('木板：清单含 oak_planks', m.scafoldingBlocks.includes(expectId), `ids=${JSON.stringify(m.scafoldingBlocks)}`);
    check('木板：allow1by1towers 仍为 true', m.allow1by1towers === true, `= ${m.allow1by1towers}`);
    check('木板：不再只含默认的泥土/圆石',
        m.scafoldingBlocks.length >= 1 && m.scafoldingBlocks.every(id => id === expectId),
        `ids=${JSON.stringify(m.scafoldingBlocks)}`);
}

// ---------- 2) 背包空的 ----------
{
    const m = makeMovements(fakeBot([]), { scaffold: true });
    check('空背包：allow1by1towers 被关掉', m.allow1by1towers === false, `= ${m.allow1by1towers}`);
    check('空背包：清单为空', m.scafoldingBlocks.length === 0, `len=${m.scafoldingBlocks.length}`);
}

// ---------- 3) 只有泥土 ----------
{
    const m = makeMovements(fakeBot([{ name: 'dirt', count: 3, type: 3 }]), { scaffold: true });
    check('泥土：清单含 dirt', m.scafoldingBlocks.includes(idOf('dirt')), `ids=${JSON.stringify(m.scafoldingBlocks)}`);
    check('泥土：allow1by1towers 为 true', m.allow1by1towers === true);
}

// ---------- 4) scaffold=false ----------
{
    const m = makeMovements(fakeBot([{ name: 'oak_planks', count: 5, type: 5 }]), { scaffold: false });
    check('scaffold=false：不搭塔', m.allow1by1towers === false, `= ${m.allow1by1towers}`);
}

// ---------- 5) 混装：木板 + 圆石 ----------
{
    const m = makeMovements(fakeBot([
        { name: 'oak_planks', count: 2, type: 5 },
        { name: 'cobblestone', count: 9, type: 4 },
    ]), { scaffold: true });
    check('混装：两种都在清单里',
        m.scafoldingBlocks.includes(idOf('oak_planks')) && m.scafoldingBlocks.includes(idOf('cobblestone')),
        `ids=${JSON.stringify(m.scafoldingBlocks)}`);
}

console.log(`\n合计 ${passed} PASS / ${failed} FAIL`);
process.exit(failed ? 1 : 0);
