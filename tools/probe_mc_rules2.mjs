// 从 minecraft-data 1.21.8（与服务端同版本）提取"规划必须依赖的规则"。
// 目标：把原子的前置/后置条件建立在真实数据上，而不是我的猜测。
import mcData from 'minecraft-data';

const d = mcData('1.21.8');

const show = (title) => console.log(`\n${'='.repeat(60)}\n${title}\n${'='.repeat(60)}`);

// ---------------------------------------------------------------------------
show('1. 方块的关键属性（决定能不能挖/能不能放/能不能站）');
const probe = ['oak_log', 'jungle_log', 'stone', 'dirt', 'oak_leaves', 'vine',
    'oak_planks', 'crafting_table', 'furnace', 'chest', 'ladder', 'water', 'lava',
    'grass_block', 'sand', 'gravel', 'obsidian', 'bedrock', 'torch', 'scaffolding'];
console.log('方块名'.padEnd(18), '硬度', '可挖', '需要工具', '包围盒', '透明');
for (const n of probe) {
    const b = d.blocksByName[n];
    if (!b) { console.log(`  ${n}: 不存在`); continue; }
    console.log(
        `  ${n.padEnd(16)}`,
        String(b.hardness ?? '-').padEnd(5),
        String(b.diggable ?? '-').padEnd(5),
        String(!!b.harvestTools).padEnd(9),
        String(b.boundingBox ?? '-').padEnd(9),
        String(!!b.transparent),
    );
}

// ---------------------------------------------------------------------------
show('2. 挖掘时间公式（硬度 → 实际秒数）');
console.log('Minecraft 公式: 时间 = 硬度 × 1.5 / 工具速度（可正确收获时）');
console.log('工具速度: 手=1, 木=2, 石=4, 铁=6, 钻石=8, 下界合金=9\n');
const speed = { '手': 1, 木斧: 2, 石斧: 4, 铁斧: 6, 钻石斧: 8 };
for (const n of ['oak_log', 'jungle_log', 'oak_leaves', 'dirt', 'stone', 'obsidian']) {
    const b = d.blocksByName[n];
    if (!b) continue;
    const times = Object.entries(speed).map(([t, s]) => {
        // 无工具时不能正确收获 → 时间 = 硬度 × 5
        const canHarvest = !b.harvestTools;
        const sec = canHarvest ? (b.hardness * 1.5) / s : b.hardness * 5;
        return `${t}=${sec.toFixed(1)}s`;
    });
    console.log(`  ${n.padEnd(14)} 硬度${b.hardness}  ${times.join('  ')}`);
}

// ---------------------------------------------------------------------------
show('3. 树叶 / 原木的 block state（决定"是否自然树"能不能确定性判定）');
for (const n of ['oak_leaves', 'jungle_leaves', 'oak_log', 'jungle_log']) {
    const b = d.blocksByName[n];
    console.log(`  ${n}: ${JSON.stringify((b.states || []).map(s => s.name))}`);
}
console.log('\n  → leaves 有 distance(1..7) + persistent(bool)');
console.log('  → log 有 axis(x/y/z)');
console.log('  → 但实测：自然树叶也会 persistent=true，不能用来区分人造/自然');

// ---------------------------------------------------------------------------
show('4. 可交互方块（右键有作用）—— 决定"use"原子覆盖哪些');
// minecraft-data 里有 blocksByStateId，但交互性需分类
const interactable = {
    '容器（存/取）': ['chest', 'trapped_chest', 'barrel', 'shulker_box', 'hopper', 'dispenser', 'dropper'],
    '工作站（制作/烧炼）': ['crafting_table', 'furnace', 'blast_furnace', 'smoker', 'anvil', 'enchanting_table', 'brewing_stand', 'stonecutter', 'loom', 'cartography_table', 'smithing_table', 'grindstone'],
    '门类（开关）': ['oak_door', 'oak_trapdoor', 'oak_fence_gate', 'iron_door'],
    '开关（红石）': ['lever', 'stone_button', 'oak_button', 'oak_pressure_plate'],
    '床（睡觉）': ['red_bed', 'white_bed'],
    '农作物（收割）': ['wheat', 'carrots', 'potatoes', 'beetroots'],
    '其他': ['tnt', 'respawn_anchor', 'bell', 'composter', 'cauldron', 'lectern', 'campfire', 'beacon', 'jukebox', 'note_block'],
};
for (const [cat, list] of Object.entries(interactable)) {
    const exist = list.filter(n => d.blocksByName[n]);
    console.log(`  ${cat.padEnd(18)} ${exist.length} 个: ${exist.slice(0, 5).join(',')}${exist.length > 5 ? '…' : ''}`);
}
console.log('\n  → "use" 原子必须按方块类型分派，不能只有一个泛化实现');

// ---------------------------------------------------------------------------
show('5. 实体交互（右键/攻击的作用）');
const kinds = new Set(Object.values(d.entitiesByName).map(e => e.type));
console.log('  实体类型:', [...kinds].join(', '));
console.log('\n  交互分类:');
console.log('    攻击类   → mob/玩家：attack（伤害）');
console.log('    交易类   → villager/wandering_trader：右键开界面');
console.log('    骑乘类   → horse/pig/boat/minecart：右键上，需鞍/船');
console.log('    喂食类   → animal：手持食物右键');
console.log('    剪毛类   → sheep：手持剪刀右键');
console.log('    牵引类   → leashable：手持栓绳右键');
console.log('  → "entity" 原子也需要按类型分派');

// ---------------------------------------------------------------------------
show('6. 物理规则（哪些方块会掉落、哪些不会）');
const gravityBlocks = Object.values(d.blocksByName)
    .filter(b => ['sand', 'gravel', 'anvil', 'concrete_powder', 'dragon_egg', 'scaffolding'].some(g => b.name.includes(g)))
    .map(b => b.name).slice(0, 12);
console.log('  受重力影响的方块:', gravityBlocks.join(', '));
console.log('  原木: 不受重力 → 砍掉下面，上面悬空（不会塌）');
console.log('  → 所以"砍伐顺序"对完成度没有影响，只影响效率');

// ---------------------------------------------------------------------------
show('7. 挖掘工具的匹配规则（决定 NO_TOOL 判定）');
for (const n of ['oak_log', 'stone', 'iron_ore', 'diamond_ore', 'obsidian', 'dirt']) {
    const b = d.blocksByName[n];
    if (!b) continue;
    const tools = b.harvestTools ? Object.keys(b.harvestTools).map(id => {
        const it = d.items[id];
        return it?.name;
    }).filter(Boolean) : [];
    console.log(`  ${n.padEnd(14)} 可用工具: ${tools.length ? tools.slice(0, 6).join(',') : '（任何工具/手）'}`);
}

// ---------------------------------------------------------------------------
show('8. 玩家自身的物理常量（移动原子必须对齐）');
console.log('  身高 1.8 · 眼高 1.62 · 宽 0.6（mineflayer 硬编码）');
console.log('  交互距离: 生存 4.5 · 创造 5.0');
console.log('  行走速度: 4.317 格/秒（平地直走）');
console.log('  冲刺:   5.612 格/秒');
console.log('  跳跃高度: 1.25 格（能上 1 格台阶，上不了 2 格）');
console.log('  摔落:   3 格内不受伤，之后每格 1 点伤害');
