// t29 R3①：F-EXEC-201 注入实测 —— 证明「spawn + stdin」结构上不可注入，
// 且**不是假绿**（先证明同一载荷在旧的 exec+拼接写法下真的会执行）。
// 运行：cd E:\我的世界ai && node docs/audit/probes/t29-exec201-injection.mjs
// 判据：A 组（旧写法）应至少有一条真被执行（证明载荷是活的）；
//       B 组（speak.js 现写法）应 0 条被执行。
import { exec, spawn } from 'child_process';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

const MARK = path.join(os.tmpdir(), `dsh-t29-pwn-${Date.now()}.txt`);
const isWin = process.platform === 'win32';

// 6 种载荷：反引号 / $() / 分号 / 管道 / 换行 / 单引号闭合
const PAYLOADS = [
    ['反引号', `\`echo ${MARK} > ${MARK}\``],
    ['$() 子命令', `$(type nul > "${MARK}")`],
    ['分号链', `hi${isWin ? '" ; type nul > "' : '"; touch "'}${MARK}${isWin ? '' : '"'}`],
    ['管道', `hi | type nul > "${MARK}"`],
    ['换行注入', `line1\r\n& type nul > "${MARK}"`],
    ['单引号闭合', `hi'; type nul > '${MARK}'; echo '`],
];

const exists = async () => { try { await fs.access(MARK); return true; } catch { return false; } };
const cleanup = async () => { try { await fs.unlink(MARK); } catch {} };

// speak.js 现在的 argv（照抄 src/agent/speak.js:126-133）
const PS_ARGV = ['-NoProfile', '-NonInteractive', '-Command',
    'Add-Type -AssemblyName System.Speech; ' +
    '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer; ' +
    '$s.Rate = 2; ' +
    '$t = [Console]::In.ReadToEnd(); ' +
    '$s.Speak($t); $s.Dispose()'];

console.log('平台 =', process.platform, '| 标记文件 =', MARK);
console.log('');

// ── A 组：旧写法（exec + 字符串拼接）—— 只对 Windows 复刻旧 cmd 的拼接语义 ──
console.log('===== A 组：旧写法 exec(拼接) —— 证明载荷是「活的」 =====');
let aliveCount = 0;
for (const [name, payload] of PAYLOADS) {
    await cleanup();
    // 旧代码大意：powershell -Command "... '$txt' ..."，即文本拼进命令行
    const oldCmd = `powershell -NoProfile -NonInteractive -Command "Add-Type -AssemblyName System.Speech; Write-Output '${payload}'"`;
    await new Promise((res) => { exec(oldCmd, { timeout: 8000 }, () => res()); });
    const hit = await exists();
    if (hit) aliveCount++;
    console.log(`  ${hit ? 'EXECUTED ' : 'inert    '} ${name}`);
    await cleanup();
}
console.log(`  ⇒ 旧写法下有 ${aliveCount}/${PAYLOADS.length} 条真被执行（说明载荷不是死的）`);
console.log('');

// ── B 组：现写法（spawn + argv 字面量 + stdin）—— 应 0 条 ──
console.log('===== B 组：现写法 spawn(argv) + stdin —— speak.js 的实际结构 =====');
let hitCount = 0;
for (const [name, payload] of PAYLOADS) {
    await cleanup();
    await new Promise((res) => {
        let child;
        try {
            child = spawn(isWin ? 'powershell' : 'echo', PS_ARGV, { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true });
        } catch { return res(); }
        child.on('error', () => res());
        child.on('close', () => res());
        if (child.stdin) { child.stdin.on('error', () => {}); child.stdin.end(String(payload)); }
        setTimeout(res, 8000);
    });
    const hit = await exists();
    if (hit) hitCount++;
    console.log(`  ${hit ? '⚠ EXECUTED' : 'blocked  '} ${name}   ← payload=${JSON.stringify(payload).slice(0, 46)}`);
    await cleanup();
}
console.log('');

console.log('===== 结论 =====');
console.log(`A 组（旧 exec 拼接）被执行 ${aliveCount}/${PAYLOADS.length}`);
console.log(`B 组（现 spawn+stdin）被执行 ${hitCount}/${PAYLOADS.length}`);
if (aliveCount > 0 && hitCount === 0) {
    console.log('判定：PASS —— 载荷确实能执行（A 组>0），而现写法全部挡住（B 组=0）。F-EXEC-201 结构性修复成立。');
} else if (aliveCount === 0) {
    console.log('判定：**本探针失效**（A 组 0 条被执行 ⇒ 载荷在本机是死的，B 组的 0 不能证明任何事）。不要拿这个结果当"修好了"。');
} else {
    console.log('判定：FAIL —— B 组仍有载荷被执行，注入未堵死。');
}
