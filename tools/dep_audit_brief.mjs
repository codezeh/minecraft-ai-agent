/**
 * 依赖审计（OPS-011，2026-11-06 深度检查）—— **离线安全、绝不自动修**。
 *
 * 报告原话（最小修复）："先提交锁，逐项核对可达性；升级可兼容链并重放 patch 和离线测试，
 * 禁止盲用 audit fix --force"。以及"门禁没有依赖审计阶段"。
 *
 * 为什么**不**把它塞进会阻塞的 `gate`：
 *   1. `npm audit` 必须联网。把联网步骤放进本地门禁，会让"离线也能跑的门禁"变成
 *      "断网即红"——那正好违反本项目"门禁必须离线可跑"的前提（见 README 的门禁说明）；
 *   2. 报告里 25 条后端告警（1 critical / 9 high）主要在安装链（tar / node-gyp / gl），
 *      这些包的"可达性"必须逐项人判断，**不能**用一个退出码表示。
 * 所以这里做成：`npm run gate:audit` 单独一步、**只报告不修**，
 * 并在无法联网时明确 SKIP（而不是假装通过，也不是把门禁打红）。
 *
 * 用法：
 *   node tools/dep_audit_brief.mjs            # 后端依赖
 *   node tools/dep_audit_brief.mjs --web      # 前端依赖
 *   node tools/dep_audit_brief.mjs --strict   # 有 critical/high 时退出码 1（CI 可选，默认不启用）
 *
 * 退出码：0 = 干净或 SKIP（默认模式下即使有告警也返回 0）；--strict 时按高/严重告警返回 1。
 */
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

const argv = process.argv.slice(2);
const forWeb = argv.includes('--web');
const strict = argv.includes('--strict');
// ★ 默认 registry 是 npmmirror，它**没有实现** audit 接口 ⇒ 这里必须能指定官方源，
//   否则这个脚本在默认配置下永远只能 SKIP（那等于没有这个工具）。
//   两种写法都认：`--registry <url>` 与 `--registry=<url>`（后者是单 token，别只按下标取）。
const regEq = argv.find((a) => a.startsWith('--registry='));
const regIdx = argv.indexOf('--registry');
const registry = regEq ? String(regEq.slice('--registry='.length)).trim()
    : (regIdx >= 0 ? String(argv[regIdx + 1] ?? '').trim() : '');
const cwd = forWeb ? path.join(REPO_ROOT, '..', 'web') : REPO_ROOT;

if (!existsSync(path.join(cwd, 'package.json'))) {
    console.log(`SKIP 找不到 package.json：${cwd}`);
    process.exit(0);
}

let raw = null;
try {
    // ★ Windows 上 `npm` 是 .cmd 包装脚本：execFileSync('npm.cmd') 在部分环境直接 EINVAL，
    //   所以这里用**固定命令字符串**走 shell（registry 只接受本脚本内联的白名单值，见下）。
    // registry 值只允许 http(s) URL，避免把任意字符串拼进命令。
    const regArg = /^https?:\/\/[^\s"'&|<>]+$/.test(registry) ? ` --registry=${registry}` : '';
    if (registry && !regArg) {
        console.log(`SKIP --registry 只接受 http(s) URL，收到：${registry}`);
        process.exit(0);
    }
    raw = execSync(`npm audit --json${regArg}`, {
        cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
    });
} catch (e) {
    // npm audit 在"有漏洞"时退出码就是非零，stdout 仍是合法 JSON —— 先尝试解析
    raw = e?.stdout ?? null;
    if (!raw || !String(raw).trim().startsWith('{')) {
        const why = String(e?.code || e?.message || e);
        console.log(`SKIP npm audit 没能返回 JSON（多半是离线/registry 不可达）：${why}`);
        console.log('      —— 这不是"依赖干净"，只是本次没查成。联网后再跑一次。');
        process.exit(0);
    }
}

let parsed = null;
try { parsed = JSON.parse(raw); } catch { /* 交给下面的 SKIP */ }
if (!parsed) {
    console.log('SKIP npm audit 输出不是 JSON（registry 不可达或被代理改写）。');
    console.log('      —— 这不代表依赖干净。');
    process.exit(0);
}

// ★ 本项目实测的关键事实（2026-11-06）：默认 registry 是 **npmmirror**，
//   而它**没有实现** audit 接口（`/-/npm/v1/security/advisories/bulk` 返回
//   `[NOT_IMPLEMENTED]`）。所以在这台机器上 `npm audit` **永远拿不到告警数据** ——
//   这正是"门禁里没有依赖审计阶段"的客观原因之一，必须如实说出来，
//   而不是把它显示成"0 条漏洞"。
if (parsed?.message && /NOT_IMPLEMENTED|audit endpoint returned an error|404/i.test(String(parsed.message))) {
    console.log('SKIP 当前 registry 不支持 npm audit（镜像未实现安全公告接口）：');
    console.log(`      ${String(parsed.message).split('\n')[0].slice(0, 160)}`);
    console.log('      → 要用官方源查一次：');
    console.log('        npm audit --json --registry=https://registry.npmjs.org');
    console.log('      （报告里的 25 条后端告警就是这样在只读临时目录里查到的）');
    process.exit(0);
}

const v = parsed?.metadata?.vulnerabilities ?? null;
if (!v) {
    console.log('SKIP 输出里没有 metadata.vulnerabilities（npm 版本较旧？）');
    process.exit(0);
}

const order = ['critical', 'high', 'moderate', 'low', 'info'];
const total = Number(v.total ?? 0);
console.log(`依赖审计（${forWeb ? 'web/' : 'mindcraft/'}）：总计 ${total} 条`
    + order.filter(k => Number(v[k]) > 0).map(k => ` ${k}=${v[k]}`).join(''));

// 逐条列出 high/critical 的包名与可修路径（**不自动修**，按报告要求由人判断可达性）
const advs = parsed.vulnerabilities ?? {};
const rows = Object.entries(advs)
    .filter(([, a]) => ['critical', 'high'].includes(String(a?.severity)))
    .map(([name, a]) => ({
        name,
        severity: a?.severity,
        direct: a?.isDirect === true,
        fixAvailable: a?.fixAvailable === true ? 'yes'
            : (a?.fixAvailable?.isSemVerMajor ? 'major' : (a?.fixAvailable ? 'partial' : 'no')),
        via: Array.isArray(a?.via) ? a.via.filter(x => typeof x === 'string').slice(0, 2).join(',') : '',
    }));

if (rows.length) {
    console.log('  高/严重项（按可达性人工判断，禁止 audit fix --force）：');
    for (const r of rows) {
        console.log(`   - ${r.name} [${r.severity}] direct=${r.direct} fix=${r.fixAvailable}`
            + (r.via ? ` via=${r.via}` : ''));
    }
    console.log('  判断提示：安装链（tar/node-gyp/gl 等）只在 install 期有执行面，');
    console.log('  运行期是否可达要单独看；升级前必须重放 patches 与离线单测。');
} else {
    console.log('  没有 high/critical 项。');
}

if (strict && (Number(v.critical) > 0 || Number(v.high) > 0)) process.exit(1);
process.exit(0);
