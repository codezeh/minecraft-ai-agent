/**
 * OPS-005（2026-11-06 深度检查）—— Docker 构建上下文不得带入令牌与私有配置。
 *
 * 缺陷原貌：`.dockerignore` 只有 5 行，Dockerfile 是 `COPY . .`
 * ⇒ `.git` 全历史、`.mindserver-token`、`.env`、私有 `profiles/`、运行日志全进构建上下文；
 *   镜像层一旦写进历史就删不掉，等于把控制台令牌与模型 API Key 送出去。
 *
 * 修复：.dockerignore 覆盖全部敏感路径 + Dockerfile 改成显式 COPY 清单（不再 `COPY . .`）。
 *
 * 本测不跑 docker（本机没有，且真构建会拉网络），改为：
 *   A. 用一个**按 docker 语义**的小匹配器（后者覆盖前者、`!` 反向放行、`*` 不跨目录、`**` 跨目录）
 *      逐条断言"这个敏感路径会被排除"；
 *   B. 断言 Dockerfile 不再有 `COPY . .`，且 COPY 清单里的每个路径都真实存在；
 *   C. 反向断言：镜像**需要**的路径（main.js / src / settings.js …）没有被误排除，
 *      免得"为了安全把镜像搞坏"。
 *
 * 输出：PASS/FAIL 逐条，全过退出码 0。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..');
let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
    if (cond) { pass++; console.log(`PASS ${name} ${detail}`); }
    else { fail++; console.log(`FAIL ${name} ${detail}`); }
};

const ignoreText = fs.readFileSync(path.join(REPO, '.dockerignore'), 'utf8');
const dockerfile = fs.readFileSync(path.join(REPO, 'Dockerfile'), 'utf8');

/** 解析 .dockerignore：丢掉注释/空行，保序（后者覆盖前者）。 */
const rules = ignoreText
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('#'))
    .map(l => (l.startsWith('!')
        ? { negate: true, pattern: l.slice(1).trim() }
        : { negate: false, pattern: l }));

/** docker 风格的单条 pattern → 正则（`*` 不跨 `/`，`**` 跨，结尾 `/` 表示目录）。 */
function patternToRegex(pattern) {
    let p = pattern.replace(/^\.\//, '').replace(/\/+$/, '');
    let re = '';
    for (let i = 0; i < p.length; i++) {
        const c = p[i];
        if (c === '*') {
            if (p[i + 1] === '*') { re += '.*'; i++; }
            else re += '[^/]*';
        } else if (c === '?') {
            re += '[^/]';
        } else if ('\\^$.|+()[]{}'.includes(c)) {
            re += '\\' + c;
        } else {
            re += c;
        }
    }
    // 匹配该路径本身，或它作为目录前缀的任何子路径
    return new RegExp(`^${re}(/.*)?$`);
}

/** 这条路径会不会被排除（按 docker 的"最后一个匹配规则生效"）。 */
function isIgnored(relPath) {
    let ignored = false;
    for (const r of rules) {
        if (patternToRegex(r.pattern).test(relPath)) ignored = !r.negate;
    }
    return ignored;
}

console.log('—— A. 敏感路径必须被排除 ——');
const MUST_IGNORE = [
    '.git',
    '.git/config',
    '.git/objects/ab/cdef',
    '.mindserver-token',
    'keys.json',
    '.env',
    '.env.local',
    'deploy.pem',
    'server.key',
    'profiles',
    'profiles/andy-4.json',
    'profiles/defaults/assistant.json',
    'bots',
    'bots/deepseek/memory.json',
    'logs',
    'logs/mindserver.log',
    'run-live.log',
    'run-live.err.log',
    'tmp-t59-agent.log',
    'tmp',
    'tmp/whatever.json',
    'node_modules',
    'node_modules/express/index.js',
    'docs',
    'docs/audit/x.md',
    'tools',
    'tools/preflight.mjs',
    '.vscode',
    '.githooks',
].filter(Boolean);

for (const p of MUST_IGNORE) {
    check(`排除 ${p}`, isIgnored(p) === true, `→ ignored=${isIgnored(p)}`);
}

console.log('\n—— B. Dockerfile 不许再整目录 COPY ——');
check('Dockerfile 不再有 `COPY . .`', !/^\s*COPY\s+\.\s+\.\s*$/m.test(dockerfile),
    '→ 仍是整目录复制 = 敏感文件照样进层');
check('Dockerfile 不再有 `ADD . .`', !/^\s*ADD\s+\.\s+\.\s*$/m.test(dockerfile));

// COPY 清单里的路径必须真的存在（否则镜像构建会失败，而本机没 docker 试不出来）
const copyLines = dockerfile.split(/\r?\n/).filter(l => /^\s*COPY\s/.test(l));
check('Dockerfile 有显式 COPY 清单', copyLines.length >= 4, `→ ${copyLines.length} 行`);

const copyTargets = [];
for (const line of copyLines) {
    const parts = line.trim().split(/\s+/).slice(1);
    const dest = parts.pop();
    for (const src of parts) copyTargets.push({ src, dest });
}
for (const { src } of copyTargets) {
    if (src.includes('*')) continue;
    const exists = fs.existsSync(path.join(REPO, src.replace(/^\.\//, '')));
    check(`COPY 源存在：${src}`, exists, '→ 路径不存在会让 docker build 直接失败');
}

// 私有/凭据路径不许出现在 COPY 清单里
const FORBIDDEN_IN_COPY = ['profiles', 'keys.json', '.env', 'bots', '.git', '.mindserver-token', 'logs', 'tmp'];
for (const bad of FORBIDDEN_IN_COPY) {
    check(`COPY 清单不含 ${bad}`,
        !copyTargets.some(t => t.src === bad || t.src.startsWith(bad + '/')),
        `→ ${JSON.stringify(copyTargets.map(t => t.src))}`);
}

console.log('\n—— C. 镜像需要的文件不能被误排除 ——');
const MUST_KEEP = [
    'main.js',
    'settings.js',
    'package.json',
    'package-lock.json',
    'patches',
    'src/agent/agent.js',
    'src/mindcraft/mindserver.js',
    'src/mindcraft/public/settings_spec.json',
    'services',
    'tasks',
];
for (const p of MUST_KEEP) {
    check(`保留 ${p}`, isIgnored(p) === false, `→ ignored=${isIgnored(p)}`);
}

console.log('\n—— D. 陷阱复核（防止写得像但语义不对）——');
check('`*` 不跨目录：logs 排除但 src/agent/logs 之类不应被 *.log 误伤',
    isIgnored('src/agent/library/logs.js') === false, '→ *.log 不该命中 .js');
check('`**/*.log` 命中任意层级的 .log', isIgnored('src/whatever.log') === true,
    '→ 顶层用 *.log、深层用 **/*.log，两种实现语义都覆盖');
check('.gitignore 被排除', isIgnored('.gitignore') === true);
check('patches/ 不被误排除', isIgnored('patches/mineflayer+4.39.0.patch') === false);

console.log(`\n${fail === 0 ? 'ALL PASS' : 'HAS FAILURES'}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
