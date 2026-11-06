/**
 * OPS-003（2026-11-06 深度检查）[P1] —— 离线局域网服的名字白名单可被冒用为主人。
 *
 * 缺陷本质：`online-mode=false` 时服务端不验证"你是不是这个名字"，而 bot 的权限等级
 * 又是按名字算的 ⇒ 「绑所有网卡 + 白名单」只挡住名单外的人，挡不住有人改名成名单上那个，
 * 进服即拿 bot 的 OWNER 级权限（含 !newAction = 沙箱内代码执行）。
 *
 * 为什么本测断言的是"告警"而不是"自动改配置"：
 *   报告的处置是三选一且**需用户拍板**（A 收监听/B 加登录校验/C 书面接受），
 *   三条都会改变日常用法（局域网/手机能不能连）。所以代码侧只能做两件确定的事：
 *     ① 不在没有身份校验的前提下把"名字匹配"当可信身份（BOT-001 已收口）； 
 *     ② **让这个风险在每次启动时可见**，而不是只躺在审计文档里（本模块）。
 *
 * 断言：
 *   A. 风险判定的真值表（离线+监听所有网卡才算风险；正版校验/只绑回环都不算）；
 *   B. 告警文案必须点明"白名单≠身份校验"、必须给出三条处置、必须点到 !newAction；
 *   C. server.properties 解析（online-mode / server-ip / white-list）；
 *   D. 接线断言：mindserver 启动时真的调它（否则函数再对也没人用）；
 *   E. 用**真实仓库里的 server.properties** 跑一遍，结论与当前配置相符。
 *
 * 输出：PASS/FAIL 逐条，全过退出码 0。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    assessOfflineIdentityRisk, renderOfflineIdentityWarning, readProperty, assessFromProperties,
} from '../src/mindcraft/offline_identity_risk.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, '..');
let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
    if (cond) { pass++; console.log(`PASS ${name} ${detail}`); }
    else { fail++; console.log(`FAIL ${name} ${detail}`); }
};

// ════════════════════════════════════════════════════════════
// A. 真值表
// ════════════════════════════════════════════════════════════
const risky = { onlineMode: false, serverIp: '', whiteList: true, ownerNames: ['HEAVENZEH'] };
check('A 离线 + 空 server-ip（所有网卡）→ atRisk',
    assessOfflineIdentityRisk(risky).atRisk === true);
check('A 离线 + 0.0.0.0 → atRisk',
    assessOfflineIdentityRisk({ ...risky, serverIp: '0.0.0.0' }).atRisk === true);
check('A 离线 + :: → atRisk',
    assessOfflineIdentityRisk({ ...risky, serverIp: '::' }).atRisk === true);

check('A 离线 + 绑回环 → 不算风险（外部进不来）',
    assessOfflineIdentityRisk({ ...risky, serverIp: '127.0.0.1' }).atRisk === false);
check('A 正版校验开着 + 所有网卡 → 不算风险（名字由 Mojang 背书）',
    assessOfflineIdentityRisk({ ...risky, onlineMode: true }).atRisk === false);
check('A onlineMode 传字符串 "false" 也认（配置可能被读成字符串）',
    assessOfflineIdentityRisk({ ...risky, onlineMode: 'false' }).atRisk === true);
check('A onlineMode 缺省按 true（fail-safe：不乱报）',
    assessOfflineIdentityRisk({ serverIp: '' }).atRisk === false);

// ════════════════════════════════════════════════════════════
// B. 告警文案
// ════════════════════════════════════════════════════════════
const warn = renderOfflineIdentityWarning(assessOfflineIdentityRisk(risky));
check('B 有风险时给出告警文本', typeof warn === 'string' && warn.length > 100);
check('B 点明 OPS-003', /OPS-003/.test(warn));
check('B 点明"白名单只校验名字，挡不住改名"',
    /白名单/.test(warn) && /名字/.test(warn), '');
check('B 点明拿到 owner 就能 !newAction 写代码', /!newAction/.test(warn));
check('B 给出三条处置（A 收监听 / B 加校验 / C 接受）',
    /A 收回监听/.test(warn) && /B 加身份校验/.test(warn) && /C 明确接受风险/.test(warn));
check('B 指出需要用户拍板（没有自动替他选）', /拍板/.test(warn));
check('B 点名具体会被冒用的名字', /HEAVENZEH/.test(warn));
check('B 无风险时返回 null（不刷屏）',
    renderOfflineIdentityWarning(assessOfflineIdentityRisk({ onlineMode: true, serverIp: '' })) === null);
check('B 白名单未开时文案不同（点明连"名单外"都挡不住）',
    /white-list 未开启/.test(renderOfflineIdentityWarning(assessOfflineIdentityRisk({ ...risky, whiteList: false }))));

// ════════════════════════════════════════════════════════════
// C. server.properties 解析
// ════════════════════════════════════════════════════════════
const SAMPLE = [
    '#Minecraft server properties',
    'enable-rcon=true',
    'online-mode=false',
    'server-ip=',
    'white-list=true',
    'server-port=25565',
].join('\n');

check('C readProperty 取 online-mode', readProperty(SAMPLE, 'online-mode') === 'false');
check('C readProperty 取空值 server-ip', readProperty(SAMPLE, 'server-ip') === '');
check('C readProperty 缺失键 → null', readProperty(SAMPLE, 'no-such-key') === null);
check('C readProperty 不会把相似键搞混（server-port vs server-ip）',
    readProperty(SAMPLE, 'server-port') === '25565' && readProperty(SAMPLE, 'server-ip') === '');

const parsed = assessFromProperties(SAMPLE, ['HEAVENZEH']);
check('C assessFromProperties 判定为 atRisk', parsed.atRisk === true);
check('C 解析出 whiteList=true', parsed.atRisk === true && /white-list 只校验/.test(
    renderOfflineIdentityWarning(parsed)));

const secureProps = SAMPLE.replace('online-mode=false', 'online-mode=true').replace('server-ip=', 'server-ip=127.0.0.1');
check('C 安全配置（online-mode=true + 回环）→ 不报警',
    assessFromProperties(secureProps, ['HEAVENZEH']).atRisk === false);

// ════════════════════════════════════════════════════════════
// D. 接线：mindserver 启动时必须真的调用
// ════════════════════════════════════════════════════════════
const msSrc = fs.readFileSync(path.join(REPO, 'src', 'mindcraft', 'mindserver.js'), 'utf8');
check('D mindserver 引入风险模块',
    /from '\.\/offline_identity_risk\.js'/.test(msSrc));
check('D mindserver 里真的调用 assessFromProperties', /assessFromProperties\(/.test(msSrc));
check('D mindserver 里真的打印告警', /renderOfflineIdentityWarning\(/.test(msSrc));
check('D 自检失败不许挡住启动（有 try/catch 兜底）',
    /OPS-003 风险自检跳过/.test(msSrc));

// ════════════════════════════════════════════════════════════
// E. 用真实 server.properties 跑（结论必须与当前配置一致）
// ════════════════════════════════════════════════════════════
const realProps = path.join(REPO, '..', 'server', 'server.properties');
if (fs.existsSync(realProps)) {
    const txt = fs.readFileSync(realProps, 'utf8');
    const onlineMode = readProperty(txt, 'online-mode');
    const serverIp = readProperty(txt, 'server-ip');
    const expectRisk = String(onlineMode).toLowerCase() === 'false'
        && (serverIp === '' || serverIp === '0.0.0.0' || serverIp === null);
    const real = assessFromProperties(txt, ['HEAVENZEH']);
    check('E 真实配置的判定与它的实际值一致',
        real.atRisk === expectRisk,
        `→ online-mode=${onlineMode} server-ip=${JSON.stringify(serverIp)} atRisk=${real.atRisk}`);
    if (real.atRisk) {
        console.log('      （当前仍在"可被冒名提权"的配置里 —— 这是已知的、需用户拍板的部署决策）');
    }
} else {
    console.log('SKIP E 找不到 server/server.properties（不在主仓结构里？）');
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'HAS FAILURES'}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
