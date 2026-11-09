/**
 * 探针 b：src/agent/commands/index.js:204 `no-fallthrough`
 *
 * 源码（192-208）：
 *   switch(param.type) {
 *     case 'int': ... break;
 *     ...
 *     case 'BlockName':
 *     case 'BlockOrItemName':
 *     case 'ItemName':
 *         if (arg.endsWith('plank') || arg.endsWith('seed')) arg += 's';
 *     case 'string':            ← eslint 说这里少 break
 *         break;
 *     default: throw ...
 *   }
 *
 * 要判断：从 ItemName 掉进 'string' 分支**有没有副作用**。
 * 关键点：'string' 分支体里只有一条 `break;` —— 掉进去等于什么都不做。
 *
 * 退出码：0 = 缺陷成立；1 = 不成立
 */
function coerce(paramType, rawArg) {
    let arg = String(rawArg).trim();
    switch (paramType) {
        case 'int': arg = Number.parseInt(arg); break;
        case 'float': arg = Number.parseFloat(arg); break;
        case 'boolean': arg = (arg === 'true'); break;
        case 'BlockName':
        case 'BlockOrItemName':
        case 'ItemName':
            if (arg.endsWith('plank') || arg.endsWith('seed')) arg += 's';
        // fallthrough（无注释，eslint 在此报 no-fallthrough）
        case 'string':
            break;
        default:
            throw new Error(`unknown type: ${paramType}`);
    }
    return arg;
}

const cases = [
    ['ItemName', 'oak_plank', 'oak_planks'],
    ['BlockName', 'wheat_seed', 'wheat_seeds'],
    ['ItemName', 'diamond', 'diamond'],
    ['string', 'oak_plank', 'oak_plank'],   // string 不做补 's'
    ['int', '42', 42],
];
let bad = 0;
for (const [type, input, expect] of cases) {
    const got = coerce(type, input);
    const ok = got === expect;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${type}('${input}') → ${JSON.stringify(got)}（期望 ${JSON.stringify(expect)}）`);
    if (!ok) bad++;
}

// 语义对照：如果把 ItemName 分支改成"显式 break"，行为必须完全一样
function coerceExplicitBreak(paramType, rawArg) {
    let arg = String(rawArg).trim();
    switch (paramType) {
        case 'BlockName':
        case 'BlockOrItemName':
        case 'ItemName':
            if (arg.endsWith('plank') || arg.endsWith('seed')) arg += 's';
            break;                       // ← 显式 break
        case 'string':
            break;
        default: throw new Error('unknown');
    }
    return arg;
}
let diff = 0;
for (const t of ['BlockName', 'BlockOrItemName', 'ItemName']) {
    for (const v of ['oak_plank', 'wheat_seed', 'diamond', 'x']) {
        if (coerce(t, v) !== coerceExplicitBreak(t, v)) { diff++; console.log('!! 加 break 后行为改变:', t, v); }
    }
}
console.log('\n加显式 break 后行为差异数：', diff, '（0 = 掉进 string 分支无副作用）');

if (bad === 0 && diff === 0) {
    console.log('\nVERDICT: FALSE-POSITIVE —— 是有意的 fallthrough（落到只含 break 的 string 分支），行为与加显式 break 完全一致；');
    console.log('         问题只是缺一条 `// fallthrough` 注释让 eslint 闭嘴（风格）。');
    process.exit(1);
} else {
    console.log('\nVERDICT: REAL-DEFECT');
    process.exit(0);
}
