// P6-2：复刻 prompter.js:100-120 的路径拼接，证明 create-agent 的 profile.name 会解析到哪。
// **不落盘**：只打印 path.resolve / path.join 的结果，不 mkdir、不 writeFile。
// 运行：node docs/audit/probes/p6_path_traversal.mjs
import path from 'node:path';
import { mkdirSync, rmSync } from 'node:fs';

// ↓↓↓ 以下三行是从 mindcraft/src/models/prompter.js:110-111 原样抄的拼接方式
//     name 来自 settings.profile.name（客户端可控，validateNameFormat 在 agent.js:205 才跑，
//     而 Prompter 在 agent.js:147 就构造完了）
function whatItWouldDo(cwd, name) {
    const dir = `./bots/${name}`;
    const file = `./bots/${name}/last_profile.json`;
    return {
        mkdirArg: dir,
        mkdirResolved: path.resolve(cwd, dir),
        writeResolved: path.resolve(cwd, file),
    };
}

const MIND = path.resolve('mindcraft');   // 模拟 cwd = mindcraft/（npm start 的真实 cwd）
const cases = [
    'deepseek',                    // 正常名
    '../../pwn',                   // 跨两级 → 出 mindcraft/
    '../../../pwn2',               // 跨三级 → 出项目根
    '..\\..\\pwn_win',             // Windows 反斜杠写法
    'C:\\Windows\\Temp\\pwn_abs',  // 绝对路径（path.resolve 会直接采用）
];

console.log('cwd(mindcraft) =', MIND);
console.log('');
console.log('profile.name'.padEnd(30) + 'mkdir 解析到'.padEnd(52) + 'write 解析到');
const escapees = [];
for (const n of cases) {
    const r = whatItWouldDo(MIND, n);
    const outside = !r.writeResolved.startsWith(MIND + path.sep);
    console.log(String(n).padEnd(30) + r.mkdirResolved.padEnd(52) + r.writeResolved + (outside ? '   ← 逃出 mindcraft/' : ''));
    if (outside) escapees.push({ name: n, target: r.writeResolved });
}

console.log('\n=== 判定 ===');
if (escapees.length) {
    console.log(`✅ 已证明：${escapees.length}/${cases.length} 个 name 会把写入路径解析到 mindcraft/ 之外：`);
    for (const e of escapees) console.log(`   name=${JSON.stringify(e.name)} → ${e.target}`);
    console.log('\n注意：本探针**没有真的创建或写入任何文件**（只调用 path.resolve 计算字符串）。');
} else {
    console.log('❌ 没有逃出（拼接是安全的）');
}

// 对照组：validateNameFormat（agent.js:205 才会调用的那个）会不会拦住上面这些名字
const re = /^[a-zA-Z0-9_]{3,16}$/;
console.log('\n=== 对照：validateNameFormat 的判据（connection_handler.js:88）===');
for (const n of cases) console.log(`   ${JSON.stringify(n).padEnd(30)} ${re.test(n) ? 'PASS(合法)' : 'REJECT(会被 agent.js:205 拦)'}`);
