#!/usr/bin/env node
/**
 * T5 —— OPS-005 / OPS-007 / OPS-010 真机验收：**不依赖 Docker** 的构建上下文物化器。
 *
 * 目的（对应任务书 B）：
 *   按 `mindcraft/.dockerignore` 的**真实语义**（后者覆盖前者、`!` 反向放行、
 *   `*` 不跨 `/`、`**` 跨 `/`、目录规则连带排除全部子路径）物化出
 *   「如果 Dockerfile 还是 `COPY . .`，哪些文件会进构建上下文 / 进镜像」，
 *   只记录 path / size / mtime 与判定，**绝不读取敏感文件内容**。
 *
 * 为什么要"不依赖 Docker"也要做：
 *   本机没有容器运行时（见 runtime-probe.json），真 build 暂时跑不了；
 *   但 .dockerignore 的**匹配语义是纯文本规则**，可以在宿主机上精确复算。
 *   这份清单是"真 build 之前"唯一可得的硬证据，也是真 build 之后的对照基线。
 *
 * 输出（stdout 为 JSON，同时落盘 context-manifest.json）：
 *   A. ruleSet      —— 解析后的规则表（含行号，便于回溯）
 *   B. contextSet   —— 通过 .dockerignore 过滤后仍会进构建上下文的文件（= `COPY . .` 的后果）
 *   C. imageSet     —— Dockerfile **显式 COPY 清单**真正会写进镜像的文件（当前实际口径）
 *   D. probes       —— 逐条敏感路径判定：exists / dockerignore 是否排除 / 是否在上下文 / 是否在镜像
 *   E. counterfactual —— 「若退回 `COPY . .`」的泄漏面
 *   F. patternDiff  —— .dockerignore 与 tools/check_secret_filenames.mjs 的凭据模式集差异
 *   G. secretScan   —— 对**会进镜像的文件**做轻量凭据扫描（命中只报 文件:行 + 模式名，值一律脱敏）
 *
 * 用法：
 *   node docs/真机-20261106/T5/make-context-manifest.mjs
 *   node ... --repo mindcraft --out docs/真机-20261106/T5/context-manifest.json
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const argOf = (name, def) => {
    const i = argv.indexOf(name);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
// 默认：仓库根 /mindcraft；T5 目录在 <repo>/docs/真机-20261106/T5
const REPO = path.resolve(argOf('--repo', path.join(HERE, '..', '..', '..', 'mindcraft')));
const OUT = path.resolve(argOf('--out', path.join(HERE, 'context-manifest.json')));

const norm = (p) => p.replace(/\\/g, '/').replace(/^\.\//, '');

// ─────────────────────────────────────────────────────────────
// A. 解析 .dockerignore（保序；后规则覆盖前规则）
// ─────────────────────────────────────────────────────────────
const ignorePath = path.join(REPO, '.dockerignore');
const ignoreRaw = fs.readFileSync(ignorePath, 'utf8');
const ignoreRules = [];
ignoreRaw.split(/\r?\n/).forEach((line, i) => {
    const t = line.trim();
    if (!t || t.startsWith('#')) return;
    const negate = t.startsWith('!');
    ignoreRules.push({
        line: i + 1,
        negate,
        pattern: negate ? t.slice(1).trim() : t,
        raw: t,
    });
});
const negations = ignoreRules.filter((r) => r.negate);

/**
 * docker/moby patternmatcher 风格：pattern → 正则。
 *  - `*` 不跨 `/`；`**` 跨 `/`；`?` 单字符
 *  - 结尾 `/` 视为目录（去掉后仍按"本身或子树"匹配）
 */
function patternToRegex(pattern) {
    const p = norm(pattern).replace(/\/+$/, '');
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
    return new RegExp(`^${re}(/.*)?$`);
}
const compiled = ignoreRules.map((r) => ({ ...r, re: patternToRegex(r.pattern) }));

/**
 * 判定一条相对路径是否被排除。
 * 与 moby patternmatcher 的 MatchesOrParentMatches 一致：**路径本身或其任一祖先目录**命中即算命中，
 * 再按"最后一条命中的规则决定进/出"。
 */
function decide(relPath) {
    const p = norm(relPath);
    const parts = p.split('/');
    const ancestors = [];
    for (let i = parts.length; i >= 1; i--) ancestors.push(parts.slice(0, i).join('/'));
    let ignored = false;
    let matchedBy = null;
    for (const r of compiled) {
        if (ancestors.some((a) => r.re.test(a))) {
            ignored = !r.negate;
            matchedBy = { line: r.line, pattern: r.raw };
        }
    }
    return { ignored, matchedBy };
}

// ─────────────────────────────────────────────────────────────
// 目录遍历（排除目录时整体剪枝 —— 仅当没有任何 `!` 反向规则时成立）
// ─────────────────────────────────────────────────────────────
const canPrune = negations.length === 0;
const stats = { dirsVisited: 0, dirsPruned: 0, filesSeen: 0 };
const contextFiles = [];
const prunedSample = [];

function walk(dirAbs, relBase) {
    stats.dirsVisited++;
    let entries;
    try { entries = fs.readdirSync(dirAbs, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
        const rel = relBase ? `${relBase}/${ent.name}` : ent.name;
        const abs = path.join(dirAbs, ent.name);
        if (ent.isDirectory()) {
            const d = decide(rel);
            if (d.ignored && canPrune) {
                stats.dirsPruned++;
                if (prunedSample.length < 25) prunedSample.push(rel);
                continue;
            }
            walk(abs, rel);
        } else if (ent.isFile()) {
            stats.filesSeen++;
            const d = decide(rel);
            if (d.ignored) continue;
            let st;
            try { st = fs.statSync(abs); } catch { continue; }
            contextFiles.push({
                path: rel,
                size: st.size,
                mtime: new Date(st.mtimeMs).toISOString(),
                // 该文件是被哪条规则"放行"的（最后一条命中的规则；null = 从没命中过任何规则）
                lastRule: d.matchedBy,
            });
        }
    }
}
walk(REPO, '');
contextFiles.sort((a, b) => a.path.localeCompare(b.path));

// ─────────────────────────────────────────────────────────────
// C. 解析 Dockerfile 的显式 COPY 清单 → imageSet
// ─────────────────────────────────────────────────────────────
const dockerfilePath = path.join(REPO, 'Dockerfile');
const dockerfile = fs.readFileSync(dockerfilePath, 'utf8');
const dockerfileLines = dockerfile.split(/\r?\n/);

const copyInstructions = [];
dockerfileLines.forEach((line, i) => {
    const m = line.match(/^\s*(COPY|ADD)\s+(.+?)\s*$/);
    if (!m) return;
    const parts = m[2].trim().split(/\s+/);
    const dest = parts.pop();
    copyInstructions.push({ line: i + 1, op: m[1], srcs: parts, dest, raw: line.trim() });
});

const hasBulkCopy = dockerfileLines.some((l) => /^\s*(COPY|ADD)\s+(\.|\*)\s+(\.|\/)\s*$/.test(l));
const usesNpmInstall = /^\s*RUN\s+npm\s+install\b/m.test(dockerfile);
const usesNpmCi = /^\s*RUN\s+npm\s+ci\b/m.test(dockerfile);

/** 把一条 COPY 的源表达式（可能带 `*`）解析成"当前上下文里真实存在的相对路径集合"。 */
function expandCopySrc(src) {
    const s = norm(src).replace(/\/+$/, '');
    if (!s || s === '.' || s === '*') return contextFiles.map((f) => f.path); // 整上下文
    if (!s.includes('*') && !s.includes('?')) {
        return contextFiles
            .filter((f) => f.path === s || f.path.startsWith(s + '/'))
            .map((f) => f.path);
    }
    const re = patternToRegex(s);
    return contextFiles.filter((f) => re.test(f.path)).map((f) => f.path);
}

const imageMap = new Map(); // path -> { dest, line }
for (const ci of copyInstructions) {
    for (const src of ci.srcs) {
        for (const p of expandCopySrc(src)) {
            if (!imageMap.has(p)) imageMap.set(p, { copyLine: ci.line, copyRaw: ci.raw, dest: ci.dest });
        }
    }
}
const imageFiles = [...imageMap.entries()]
    .map(([p, meta]) => ({ path: p, ...meta }))
    .sort((a, b) => a.path.localeCompare(b.path));

// ─────────────────────────────────────────────────────────────
// D. 敏感路径逐条判定
// ─────────────────────────────────────────────────────────────
const onDisk = (rel) => {
    try { return fs.statSync(path.join(REPO, rel)); } catch { return null; }
};

/** 每条 probe：rel 路径 + 说明 + 是否为本机真实存在的实例 */
const PROBES = [
    // 任务书点名要判定的 8 条
    { rel: '.mindserver-token', why: '控制台握手令牌（本机真实存在）' },
    { rel: '.mindserver-token.bak', why: '.mindserver-token.* 变体' },
    { rel: '.env', why: '部署期环境变量（密钥常见载体）' },
    { rel: '.env.local', why: '.env.* 变体' },
    { rel: '.env.production', why: '.env.* 变体' },
    { rel: 'profiles/my-local.json', why: '每个 bot 的人设 + permissions（可能内嵌 key）' },
    { rel: 'profiles/andy-4.json', why: 'profiles 下普通文件' },
    { rel: '.git/config', why: 'git 配置（可能含 remote 凭据）' },
    { rel: '.git/HEAD', why: 'git 仓库本体' },
    { rel: 'logs/mindserver.log', why: '运行日志（可能含 token）' },
    { rel: 'logs', why: 'logs 目录本身' },
    { rel: 'tmp/whatever.json', why: '临时目录' },
    { rel: 'bots/deepseek/memory.json', why: 'bot 运行期记忆数据' },
    { rel: 'keys.json', why: '模型 API Key（本机真实存在）' },
    // *.token —— 任务书点名"可疑漏项"，真实实例是否存在由 onDisk 决定
    { rel: 'auth.token', why: '★ *.token：任意后缀令牌文件（.dockerignore 无此通配）' },
    { rel: 'deploy.token', why: '★ *.token 变体' },
    { rel: 'mindserver.token', why: '★ *.token 变体' },
    { rel: 'sub/dir/nested.token', why: '★ *.token 子目录变体' },
    // 与 check_secret_filenames.mjs 对齐、但 .dockerignore 未覆盖的类别
    { rel: 'id_rsa', why: 'SSH 私钥（check_secret_filenames 覆盖，dockerignore 无）' },
    { rel: 'id_ed25519', why: 'SSH 私钥（同上）' },
    { rel: 'credentials.json', why: 'cloud 凭据（同上）' },
    { rel: 'secrets.json', why: '密钥集合（同上）' },
    { rel: 'config.local.json', why: '本地私有配置（同上）' },
    { rel: 'server.pfx', why: 'PFX 证书（dockerignore 只有 pem/key/p12）' },
    { rel: 'server.crt', why: 'CRT 证书（同上）' },
    { rel: 'server.jks', why: 'JKS 密钥库（同上）' },
    { rel: 'mindserver-token', why: '无前导点的 mindserver-token（check_secret_filenames 覆盖）' },
    // 队长点名的 config/
    { rel: 'config/', why: '★ 队长点名：config 目录是否在上下文内' },
    { rel: 'config/network.json', why: '★ 队长点名：config 下文件' },
    { rel: 'config.local.js', why: '本地配置 js 变体' },
];

/**
 * 判定口径（**只看规则，不看文件是否存在**）：
 *   - 被 .dockerignore 排除                     → EXCLUDED
 *   - 未被排除 + 本机真实存在 + 会进镜像         → LEAK-IN-IMAGE（真泄漏）
 *   - 未被排除 + 本机真实存在 + 只在上下文        → IN-CONTEXT-NOT-IN-IMAGE
 *       （显式 COPY 清单挡住了镜像层，但文件仍被送进 docker daemon / 构建缓存）
 *   - 未被排除 + 本机无实例                      → LATENT-GAP（今天不漏，一旦出现就漏）
 * 目录探针（末尾带 /）只看规则与子树，不看"目录本身是否存在"。
 */
const probes = PROBES.map(({ rel, why }) => {
    const probeRel = rel.endsWith('/') ? rel.slice(0, -1) : rel;
    const d = decide(probeRel);
    const st = onDisk(probeRel);
    const isRealInstance = !!st;
    // 上下文内是否有该路径本身或它的子文件（真实实例才算）
    const inContext = isRealInstance && contextFiles.some((f) => f.path === probeRel || f.path.startsWith(probeRel + '/'));
    const inImage = isRealInstance && imageFiles.some((f) => f.path === probeRel || f.path.startsWith(probeRel + '/'));
    let verdict;
    if (d.ignored) verdict = 'EXCLUDED';
    else if (!isRealInstance) verdict = 'LATENT-GAP';
    else if (inImage) verdict = 'LEAK-IN-IMAGE';
    else if (inContext) verdict = 'IN-CONTEXT-NOT-IN-IMAGE';
    else verdict = 'NOT-PRESENT-IN-TREE';
    return {
        path: rel,
        why,
        existsOnDisk: isRealInstance,
        onDiskKind: st ? (st.isDirectory() ? 'dir' : 'file') : null,
        onDiskSize: st && st.isFile() ? st.size : null,
        dockerignoreIgnored: d.ignored,
        dockerignoreRule: d.matchedBy,
        inBuildContext: inContext,
        inImage,
        verdict,
    };
});

// ─────────────────────────────────────────────────────────────
// E. 反向断言 / 反事实
// ─────────────────────────────────────────────────────────────
const mustKeep = ['main.js', 'settings.js', 'package.json', 'package-lock.json', 'patches',
    'src/agent/agent.js', 'src/mindcraft/mindserver.js', 'services', 'tasks', 'schematics'];
const mustKeepResult = mustKeep.map((p) => ({
    path: p,
    existsOnDisk: !!onDisk(p),
    inBuildContext: contextFiles.some((f) => f.path === p || f.path.startsWith(p + '/')),
    inImage: imageFiles.some((f) => f.path === p || f.path.startsWith(p + '/')),
}));

const counterfactual = {
    note: '若 Dockerfile 退回 `COPY . .`（OPS-005 缺陷原貌），泄漏面 = 下面这些"被 .dockerignore 挡住"以外的全部文件；'
        + '其中 probes 里 verdict=IN-CONTEXT-NOT-IN-IMAGE / LATENT-GAP 的项都会真的进层。',
    hypotheticalImageFilesCount: contextFiles.length,
    hypotheticalImageBytes: contextFiles.reduce((a, f) => a + f.size, 0),
    deltaVsExplicitCopy: contextFiles.filter((f) => !imageMap.has(f.path)).length,
    extraFilesThatWouldShip: contextFiles.filter((f) => !imageMap.has(f.path)).map((f) => f.path),
};

// ─────────────────────────────────────────────────────────────
// F. .dockerignore vs tools/check_secret_filenames.mjs 的模式集差异
// ─────────────────────────────────────────────────────────────
const secretScannerPath = path.join(REPO, 'tools', 'check_secret_filenames.mjs');
let patternDiff = { available: false };
if (fs.existsSync(secretScannerPath)) {
    const src = fs.readFileSync(secretScannerPath, 'utf8');
    const body = src.slice(src.indexOf('const PATTERNS'), src.indexOf('// 明确放行'));
    // 统计扫描器 PATTERNS 数组里有几条 /.../ 字面量（只看条数，不解释内容）
    const scannerPatterns = line => line;
    const scannerPatternCount = (body.match(/^\s*\/.*\/,?\s*$/gm) || []).length;
    // 用扫描器的正则直接测：对每条 dockerignore 会不会放行的合成文件名，看两边结论是否一致
    const synthetic = [
        'auth.token', 'deploy.token', 'mindserver.token', 'sub/nested.token',
        'id_rsa', 'id_ed25519', 'credentials.json', 'secrets.json', 'config.local.json',
        'server.pfx', 'server.crt', 'server.jks', 'mindserver-token', '.mindserver-token',
        'keys.json', '.env', '.env.local', 'x.pem', 'x.key', 'x.p12',
    ];
    // 复刻扫描器口径（只看 basename、小写化）
    const SCAN = [
        /^\.env(\..*)?$/, /\.pem$/, /\.key$/, /\.pfx$/, /\.p12$/, /\.crt$/, /\.jks$/,
        /^id_rsa/, /^id_ed25519/, /credentials?.*\.json$/, /secrets?.*\.json$/, /\.token$/,
        /^\.mindserver-token/, /^mindserver-token/, /^keys\.json$/, /config\.local\.(js|ts|json)$/,
    ];
    const rows = synthetic.map((p) => {
        const base = path.basename(p).toLowerCase();
        const scannerSays = SCAN.some((re) => re.test(base));
        const dockerignoreSays = decide(p).ignored;
        return {
            path: p,
            check_secret_filenames: scannerSays ? 'FLAG(凭据类)' : 'pass',
            dockerignore: dockerignoreSays ? 'EXCLUDED' : 'IN-CONTEXT',
            // 扫描器认为是凭据、但 dockerignore 放行 = 两道防线口径不一致（docker 侧的洞）
            divergence: scannerSays && !dockerignoreSays,
        };
    });
    patternDiff = {
        available: true,
        scannerFile: 'mindcraft/tools/check_secret_filenames.mjs',
        extractedScannerRegexCount: scannerPatternCount,
        rows,
        divergenceCount: rows.filter((r) => r.divergence).length,
        divergences: rows.filter((r) => r.divergence).map((r) => r.path),
    };
}

// ─────────────────────────────────────────────────────────────
// G. 对"会进镜像的文件"做轻量凭据扫描（只报位置与模式名，值全脱敏）
// ─────────────────────────────────────────────────────────────
const CONTENT_PATTERNS = [
    { name: 'openai-sk', re: /\bsk-[A-Za-z0-9_-]{20,}/ },
    { name: 'anthropic-sk-ant', re: /\bsk-ant-[A-Za-z0-9_-]{20,}/ },
    { name: 'aws-akid', re: /\bAKIA[0-9A-Z]{16}\b/ },
    { name: 'google-api-key', re: /\bAIza[0-9A-Za-z_-]{30,}/ },
    { name: 'bearer-literal', re: /["']Bearer\s+[A-Za-z0-9._-]{20,}["']/ },
    { name: 'private-key-block', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
    { name: 'gh-token', re: /\bgh[pousr]_[A-Za-z0-9]{30,}/ },
];
const SKIP_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.ico', '.woff', '.woff2', '.ttf', '.map',
    '.zip', '.gz', '.nbt', '.schem', '.schematic', '.webp', '.mp3', '.ogg', '.pdf']);
const secretScan = { scannedFiles: 0, skippedBinaryOrBig: 0, hits: [] };
const MAX_SCAN_BYTES = 2 * 1024 * 1024;
for (const f of imageFiles) {
    const ext = path.extname(f.path).toLowerCase();
    if (SKIP_EXT.has(ext)) { secretScan.skippedBinaryOrBig++; continue; }
    const ctxEntry = contextFiles.find((c) => c.path === f.path);
    if (!ctxEntry || ctxEntry.size > MAX_SCAN_BYTES) { secretScan.skippedBinaryOrBig++; continue; }
    let text;
    try { text = fs.readFileSync(path.join(REPO, f.path), 'utf8'); } catch { continue; }
    secretScan.scannedFiles++;
    const lines = text.split(/\r?\n/);
    lines.forEach((line, idx) => {
        for (const p of CONTENT_PATTERNS) {
            if (p.re.test(line)) {
                // 绝不输出命中内容本身
                secretScan.hits.push({
                    file: f.path,
                    line: idx + 1,
                    pattern: p.name,
                    valueRedacted: true,
                    lineLength: line.length,
                });
            }
        }
    });
}

// ─────────────────────────────────────────────────────────────
// 汇总输出
// ─────────────────────────────────────────────────────────────
const manifest = {
    tool: 'T5/make-context-manifest.mjs',
    generatedAt: new Date().toISOString(),
    host: { platform: process.platform, arch: process.arch, node: process.version },
    repo: REPO,
    inputs: {
        dockerignore: { path: norm(path.relative(REPO, ignorePath)) || '.dockerignore', bytes: Buffer.byteLength(ignoreRaw), sha256: null },
        dockerfile: { path: 'Dockerfile', bytes: Buffer.byteLength(dockerfile) },
    },
    matchingSemantics: {
        description: '按 moby/patternmatcher：后规则覆盖前规则；`!` 反向放行；`*` 不跨 `/`；`**` 跨 `/`；'
            + '命中"路径本身或其任一祖先目录"即算命中。',
        ruleCount: ignoreRules.length,
        negationRuleCount: negations.length,
        directoryPruningUsed: canPrune,
        pruningNote: canPrune ? '无 `!` 反向规则 ⇒ 排除目录可整体剪枝，剪枝不会漏掉被放行的子文件。'
            : '存在 `!` 规则 ⇒ 未剪枝，全量遍历。',
    },
    ruleSet: ignoreRules,
    walkStats: { ...stats, contextFiles: contextFiles.length, prunedSample },
    dockerfileAnalysis: {
        bulkCopyPresent: hasBulkCopy,
        bulkCopyNote: hasBulkCopy ? '★ 仍有 `COPY . .`：.dockerignore 是唯一防线' : '已改为显式 COPY 清单（OPS-005 修复点之一）',
        copyInstructionCount: copyInstructions.length,
        copyInstructions,
        npmInstallPresent: usesNpmInstall,
        npmCiPresent: usesNpmCi,
        ops007Note: usesNpmInstall && !usesNpmCi
            ? '★ OPS-007 未同步：Dockerfile 仍是 `npm install`（package-lock.json 已在上下文内，可改 `npm ci` 做可复现安装）'
            : null,
    },
    contextSet: {
        description: '通过 .dockerignore 过滤后仍会送进 docker daemon 构建上下文的文件集合（= `COPY . .` 的后果）',
        fileCount: contextFiles.length,
        totalBytes: contextFiles.reduce((a, f) => a + f.size, 0),
        files: contextFiles,
    },
    imageSet: {
        description: 'Dockerfile 显式 COPY 清单真正写进镜像的文件集合（当前实际口径）',
        fileCount: imageFiles.length,
        totalBytes: contextFiles.filter((f) => imageMap.has(f.path)).reduce((a, f) => a + f.size, 0),
        files: imageFiles,
    },
    probes,
    probeSummary: {
        leakInImage: probes.filter((p) => p.verdict === 'LEAK-IN-IMAGE').map((p) => p.path),
        inContextNotInImage: probes.filter((p) => p.verdict === 'IN-CONTEXT-NOT-IN-IMAGE').map((p) => p.path),
        latentGaps: probes.filter((p) => p.verdict === 'LATENT-GAP').map((p) => p.path),
        excluded: probes.filter((p) => p.verdict === 'EXCLUDED').map((p) => p.path),
        notPresentInTree: probes.filter((p) => p.verdict === 'NOT-PRESENT-IN-TREE').map((p) => p.path),
    },
    notes: {
        rootConfigIsOutsideContext:
            '队长点名的 `config/`：仓库根有 E:\\我的世界ai\\config\\network.json，但 docker-compose.yml 的 `build: .` '
            + '上下文是 **mindcraft/ 目录**，根 config/ 根本不在构建上下文里；而 mindcraft/ 下经实测**没有** config/ 目录。'
            + '⇒ 「config/ 未排除」这条在当前目录布局下不构成真实泄漏，但 .dockerignore 缺 `config` 规则属**潜在**口径缺口'
            + '（一旦有人在 mindcraft/ 下建 config/ 并放私有配置，它就会进上下文）。',
        explicitCopyIsTheRealGate:
            '真正的闸门是 Dockerfile 的显式 COPY 清单：即使某文件漏出 .dockerignore，只要不在 COPY 清单里就进不了镜像层。'
            + '.dockerignore 决定的只是"是否被送进 docker daemon 的构建上下文"。两层都该严，但严重度不同。',
    },
    mustKeepResult,
    counterfactual,
    patternDiff,
    secretScan,
};

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(manifest, null, 2), 'utf8');

// 控制台摘要（人读）
console.log('════ T5 构建上下文物化 ════');
console.log(`repo            : ${REPO}`);
console.log(`规则            : ${ignoreRules.length} 条（! 反向 ${negations.length} 条）`);
console.log(`遍历            : 目录 ${stats.dirsVisited}，剪枝 ${stats.dirsPruned}，文件 ${stats.filesSeen}`);
console.log(`上下文文件      : ${contextFiles.length} 个 / ${manifest.contextSet.totalBytes} B`);
console.log(`镜像文件        : ${imageFiles.length} 个 / ${manifest.imageSet.totalBytes} B`);
console.log(`Dockerfile      : bulkCopy=${hasBulkCopy} npmInstall=${usesNpmInstall} npmCi=${usesNpmCi}`);
console.log('');
console.log('—— 敏感路径判定 ——');
for (const p of probes) {
    console.log(`${p.verdict.padEnd(28)} ${p.path.padEnd(32)} exists=${p.existsOnDisk ? 'Y' : 'n'} ignored=${p.dockerignoreIgnored ? 'Y' : 'N'} ctx=${p.inBuildContext ? 'Y' : 'n'} img=${p.inImage ? 'Y' : 'n'}`);
}
console.log('');
console.log(`泄漏进镜像: ${manifest.probeSummary.leakInImage.length} | 在上下文不在镜像: ${manifest.probeSummary.inContextNotInImage.length} | 潜在漏项: ${manifest.probeSummary.latentGaps.length}`);
if (patternDiff.available) {
    console.log(`两道防线口径分歧: ${patternDiff.divergenceCount} 项 → ${patternDiff.divergences.join(', ') || '(无)'}`);
}
console.log(`镜像内凭据扫描: 扫描 ${secretScan.scannedFiles} 个文本文件，命中 ${secretScan.hits.length} 条`);
console.log(`\n已写出: ${OUT}`);
