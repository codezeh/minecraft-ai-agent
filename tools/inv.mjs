// 查她的背包（命令行工具）。
//
// 为什么需要单独一个：Paper 1.21.8 的 `data get entity ... Inventory` 输出格式是
//   [{Slot: 0b, id: "minecraft:iron_axe", count: 1, components: {...}}, ...]
// 用 `{[^{}]*id:...}` 这种朴素正则会因为 components 里的嵌套花括号而匹配失败，
// 表现是"物品明明给了但读出来是空的"——排查时极易误判成"give 没生效"。
//
// 用法: node tools/inv.mjs [玩家名]
import { rcon } from './rcon.mjs';

const R = (c) => rcon(c, { port: 25575, password: 'localdev' });
const who = process.argv[2] ?? 'deepseek';

const raw = String(await R(`data get entity ${who} Inventory`));
// 只匹配 id + count 这一对，不受 components 里嵌套内容影响
const items = [...raw.matchAll(/id:\s*"([^"]+)",\s*count:\s*(\d+)/g)];

if (!items.length) {
    console.log(`${who} 背包: 空`);
} else {
    const m = {};
    for (const [, id, n] of items) {
        const name = id.replace('minecraft:', '');
        m[name] = (m[name] || 0) + Number(n);
    }
    console.log(`${who} 背包: ${Object.entries(m).map(([k, v]) => `${k}x${v}`).join(', ')}`);
}
