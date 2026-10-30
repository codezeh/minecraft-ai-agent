// 验收：类别解析（木头 → 所有原木）+ collect 支持多类型。
import { resolveCollectTarget, WOOD_TYPES } from '../src/agent/library/collect_targets.js';

let passed = 0, failed = 0;
function check(name, cond, detail = '') {
    if (cond) { passed++; console.log(`  PASS  ${name}  ${detail}`); }
    else { failed++; console.log(`  FAIL  ${name}  ${detail}`); }
}

// 用真实的 bot.registry（从 minecraft-data 加载）
const mcData = (await import('minecraft-data')).default;
const registry = mcData('1.21.8');

// 1) 类别解析：木头 → 所有存在的原木
const wood = resolveCollectTarget('木头', registry);
check('「木头」解析成类别', wood?.kind === 'category', wood ? `${wood.names.length} 种` : 'null');
check('木头包含橡木', wood?.names.includes('oak_log'));
check('木头包含丛林木', wood?.names.includes('jungle_log'), '这是用户最关心的');
check('木头包含白桦/云杉', wood?.names.includes('birch_log') && wood?.names.includes('spruce_log'));
check('木头展开的种类数 > 5', wood?.names.length > 5, `${wood?.names.length} 种`);

// 2) 英文类别
const woodEn = resolveCollectTarget('wood', registry);
check('「wood」也解析成类别', woodEn?.kind === 'category' && woodEn.names.length === wood.names.length);

// 3) 精确树种
const jungle = resolveCollectTarget('丛林木', registry);
check('「丛林木」只解析成 jungle_log', jungle?.kind === 'single' && jungle.names[0] === 'jungle_log',
    JSON.stringify(jungle?.names));
const oak = resolveCollectTarget('橡木', registry);
check('「橡木」只解析成 oak_log', oak?.names[0] === 'oak_log' && oak.names.length === 1);

// 4) 精确 ID 直接通过
const raw = resolveCollectTarget('oak_log', registry);
check('精确 ID 直接识别', raw?.kind === 'single' && raw.names[0] === 'oak_log');

// 5) 其他常见物品
check('「石头」→ stone', resolveCollectTarget('石头', registry)?.names[0] === 'stone');
check('「铁矿」→ iron_ore', resolveCollectTarget('铁矿', registry)?.names[0] === 'iron_ore');
check('「钻石」→ diamond_ore', resolveCollectTarget('钻石', registry)?.names[0] === 'diamond_ore');

// 6) 不认识的东西返回 null（让她问，而不是瞎砍）
check('不认识的返回 null', resolveCollectTarget('彩虹', registry) === null);
check('空输入返回 null', resolveCollectTarget('', registry) === null);

// 7) 多类型合并：模拟 findAny 的去重效果
const names = wood.names;
check('木头的名字都是合法方块', names.every(n => registry.blocksByName[n]), `${names.filter(n => !registry.blocksByName[n]).join(',') || '全部合法'}`);

console.log(`\n合计 ${passed} PASS / ${failed} FAIL`);
process.exit(failed ? 1 : 0);
