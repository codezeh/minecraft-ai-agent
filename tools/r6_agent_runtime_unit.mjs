/**
 * R6 运行时清零回归（#35 / #36 / #37 / #38 / #39 / #40 / #41 / #42 / #43）+ Nice #78/#79/#80。
 *
 * 判据分两层：
 *   · **行为**（能直接跑的就跑）：`_callOptions` 超期短路、多行斜杠逐行安检、
 *     权限表登记⊆实现、任务单定级不绕身份、历史压缩不再逐条全量序列化；
 *   · **源码**（依赖链太重、离线只能看结构）：coder 模板读取/语法重试、启动日志、
 *     退出路径有界等待、routeResponse 显式 internal 标记 —— 每条都写明"改回去就红"的锚点。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '..', 'src');
const readSrc = (...p) => fs.readFileSync(path.join(SRC, ...p), 'utf8');

const {
    inspectChatText, canRunCommand, resolveLevel, LEVEL, commandLevel,
    TRUSTED_COMMANDS, OWNER_ONLY_COMMANDS, registeredButMissing,
    levelForJobSource, jobAuthorOf, jobPermissionGate, maxJobLevel,
} = await import('../src/agent/permissions.js');
const { Prompter } = await import('../src/models/prompter.js');

let pass = 0, fail = 0;
const ok = (name, evidence = '') => { pass++; console.log(`PASS ${name} ${evidence}`); };
const bad = (name, actual) => { fail++; console.log(`FAIL ${name} ${JSON.stringify(actual)}`); };
const check = (name, cond, evidence = '', actual = null) => {
    if (cond) ok(name, evidence);
    else bad(name, actual ?? evidence);
};

// ══ #35 启动日志 vs 真实权限语义 ═══════════════════════════════════
{
    const code = readSrc('agent', 'agent.js');
    check('#35 启动日志不再自称"人人信任级"', !/人人「信任级」/.test(code));
    check('#35 日志改为**问权限模块**再打印（resolveLevel + canRunCommand）',
        /\[权限\] 实测等级/.test(code)
        && /const level = resolveLevel\(\{\s*author: probe, permissions: perms\s*\}\)/.test(code)
        && /canRunCommand\(level, c\)/.test(code));
    // 行为印证：没配 owner ⇒ OTHER ⇒ 所有聊天命令都不响应（日志现在说的就是这个）
    const lv = resolveLevel({ author: 'AnyBody', permissions: null });
    check('★ #35 没配 owner ⇒ 等级 other 且 !collectBlocks 不被放行',
        lv === LEVEL.OTHER && canRunCommand(lv, '!collectBlocks') === false, `level=${lv}`);
}

// ══ #37 已过期操作不再发请求 ═══════════════════════════════════════
{
    const fakeThis = { last_convo_truncated: null, last_convo_error_code: null, last_convo_status: null };
    const callOpts = Prompter.prototype._callOptions.call(fakeThis, { deadline: Date.now() - 5_000 });
    check('★ #37 期限已过 ⇒ _callOptions.expired=true', callOpts.expired === true, JSON.stringify(callOpts));
    const future = Prompter.prototype._callOptions.call(fakeThis, { deadline: Date.now() + 8_000 });
    check('#37 未过期 ⇒ expired=false（不许误伤）', future.expired === false, JSON.stringify(future));
    const noDeadline = Prompter.prototype._callOptions.call(fakeThis, {});
    check('#37 没给 deadline ⇒ 不退化为"过期"', noDeadline.expired === false && noDeadline.timeoutMs > 0);

    // 行为：过期时不发请求（用假 chat_model 统计 sendRequest 调用次数）
    let sent = 0;
    const prompter = {
        agent: { name: 'x', history: { getHistory: () => [] } },
        profile: { conversing: 'hi' },
        chat_model: { sendRequest: async () => { sent += 1; return 'x'; } },
        most_recent_msg_time: 0,
        checkCooldown: async () => {},
        replaceStrings: async (s) => s,
        _callOptions: Prompter.prototype._callOptions,
        _convoResult: Prompter.prototype._convoResult,
        last_convo_truncated: null, last_convo_error_code: null, last_convo_status: null,
    };
    const r = await Prompter.prototype.promptConvoResult.call(prompter, [], { deadline: Date.now() - 1 });
    check('★ #37 期限已过 ⇒ **一次模型请求都没发**，直接 TIMEOUT',
        sent === 0 && r.status === 'timeout' && r.errorCode === 'TIMEOUT', `sent=${sent} status=${r.status}`);
}

// ══ #38 适配器遵守调用方期限 ══════════════════════════════════════
{
    const hf = readSrc('models', 'huggingface.js');
    const rp = readSrc('models', 'replicate.js');
    check('★ #38 huggingface 用 opts.timeoutMs（不再写死 120s）',
        /Number\(opts\?\.timeoutMs\) > 0 \? Number\(opts\.timeoutMs\) : LLM_MAX_CALL_MS/.test(hf));
    check('★ #38 replicate 用 opts.timeoutMs（不再写死 120s）',
        /Number\(opts\?\.timeoutMs\) > 0 \? Number\(opts\.timeoutMs\) : LLM_MAX_CALL_MS/.test(rp));
}

// ══ #39 多行文本的斜杠安检逐行判 ═════════════════════════════════
{
    const v = inspectChatText('/skin clear\n/op Someone');
    check('★ #39 第二行的 /op 必须被拦（原来只看整串第一个词）', v.allowed === false, JSON.stringify(v));
    check('#39 拒绝时带**正确的行号**（第 2 行）与 offending 原文',
        v.line === 2 && /\/op/.test(v.offending ?? ''));
    const okv = inspectChatText('/skin clear');
    check('#39 单行白名单命令仍放行（不误伤）', okv.allowed === true, JSON.stringify(okv));
    const okMulti = inspectChatText('你好\n/skin clear');
    check('#39 多行但只有一行是斜杠命令且合法 ⇒ 放行', okMulti.allowed === true, JSON.stringify(okMulti));
    const code = readSrc('agent', 'agent.js');
    check('★ #39 sendSlashCommand 拒绝含换行的文本（第二道）',
        /拒绝发送含换行的斜杠命令/.test(code) && /\/\\r\|\\n\/\.test\(raw\)/.test(code));
}

// ══ #40 / #41 coder ═════════════════════════════════════════════
{
    const code = readSrc('agent', 'coder.js');
    check('★ #40 模板读取改成 readFileSync + try/catch（回调里 throw 会带走进程）',
        /readFileSync\(path\.join\(__dirname, '\.\.\/\.\.\/bots\/', file\), 'utf8'\)/.test(code)
        && !/readFile\(path\.join\(__dirname, '\.\.\/\.\.\/bots\/execTemplate\.js'\)/.test(code));
    check('#40 读失败记 templateError，generateCode 入口直接返回明确失败串',
        /this\.templateError/.test(code) && /Code action unavailable: \$?\{?this\.templateError\}?/.test(code));
    const genAt = code.indexOf('async generateCode(');
    const genBody = code.slice(genAt, genAt + 900);
    check('★ #40 generateCode 一开始就查 templateError', /if \(this\.templateError\)/.test(genBody));
    check('★ #41 _stageCode / _lintCode 各自包在 try/catch 里（语法错要能重试）',
        /try \{\s*result = await this\._stageCode\(code\);\s*\} catch/.test(code)
        && /try \{\s*lintResult = await this\._lintCode\(result\.src_lint_copy\);\s*\} catch/.test(code));
    const stageAt = code.indexOf('result = await this._stageCode(code)');
    const afterStage = code.slice(stageAt, stageAt + 900);
    check('★ #41 staging 失败 ⇒ 把错误塞回 messages 并 continue（用上 MAX_ATTEMPTS 预算）',
        /messages\.push\(\{ role: 'system', content: errText/.test(afterStage)
        && /continue;/.test(afterStage));
}

// ══ #42 权限表登记 ⊆ 实现 ═══════════════════════════════════════
{
    const cmdsDir = path.join(SRC, 'agent', 'commands');
    const impl = [];
    for (const f of fs.readdirSync(cmdsDir).filter((n) => n.endsWith('.js'))) {
        const code = fs.readFileSync(path.join(cmdsDir, f), 'utf8');
        // 两种写法都认：`name: '!x'` 与 `name: "!x"`（queries.js 用的是双引号）
        for (const m of code.matchAll(/name:\s*['"](![A-Za-z]+)['"]/g)) impl.push(m[1]);
    }
    const uniq = [...new Set(impl)];
    check('#42 扫到命令实现（判据有效）', uniq.length >= 60, `→ ${uniq.length} 条`);
    const missing = registeredButMissing(uniq);
    check('★ #42 权限表里登记的命令**全部有实现**（反向自检）', missing.length === 0, `→ ${JSON.stringify(missing)}`);
    check('★ #42 !pauseJob / !resumeJob / !addSharedJob 已从权限表移除',
        !TRUSTED_COMMANDS.includes('!pauseJob')
        && !TRUSTED_COMMANDS.includes('!resumeJob')
        && !TRUSTED_COMMANDS.includes('!addSharedJob'));
    const dup = TRUSTED_COMMANDS.filter((n, i) => TRUSTED_COMMANDS.indexOf(n) !== i);
    check('★ #42 信任级清单无重复项（原来 !cancelJob 登记两次）', dup.length === 0, `→ ${JSON.stringify(dup)}`);
    check('#42 已实现的 !cancelJob / !jobs 仍在表里',
        commandLevel('!cancelJob') === LEVEL.TRUSTED && commandLevel('!jobs') === LEVEL.TRUSTED);
    check('#42 !addJob 仍是主人级', commandLevel('!addJob') === LEVEL.OWNER
        && OWNER_ONLY_COMMANDS.includes('!addJob'));
}

// ══ #43 任务单定级：接口不绕身份（**未接线**，见 agent.md） ═══════
{
    const perms = { owner: 'Zeh', trusted: ['Amy'] };
    const identity = {
        enabled: true, legacyNames: false,
        resolve: ({ uuid }) => {
            if (uuid === 'uuid-owner') return { level: LEVEL.OWNER };
            if (uuid === 'uuid-amy') return { level: LEVEL.TRUSTED };
            return null;
        },
    };
    check('#43 jobAuthorOf 认识 !addJob 写的 player:<名字> 形式',
        jobAuthorOf({ source: 'player:Zeh' }) === 'Zeh'
        && jobAuthorOf({ source: 'player', sourceName: 'Amy' }) === 'Amy');
    check('★ #43 带 uuid+identity ⇒ 按绑定表定级（owner）',
        levelForJobSource({ source: 'player:Zeh' }, perms, { uuid: 'uuid-owner', identity }) === LEVEL.OWNER);
    check('★ #43 **同名但拿不出已绑定 uuid ⇒ 只有 other**（名字不再换权限，这就是原来那条旁路）',
        levelForJobSource({ source: 'player:Zeh' }, perms, { uuid: null, identity }) === LEVEL.OTHER);
    check('#43 不传 identity（老调用方）仍按老口径（兼容，不是新接线）',
        levelForJobSource({ source: 'player:Zeh' }, perms) === LEVEL.OWNER);
    const gateDeny = jobPermissionGate(
        { id: 'j1', source: 'player:Amy', level: 9 }, perms, { uuid: 'uuid-amy', identity });
    check('★ #43 信任级下单人要 9 级 ⇒ 拒绝（上限 6 级）',
        gateDeny.allowed === false && gateDeny.level === LEVEL.TRUSTED && gateDeny.cap === maxJobLevel(LEVEL.TRUSTED),
        JSON.stringify(gateDeny));
    const gateOk = jobPermissionGate({ id: 'j2', source: 'player:Amy', level: 0 }, perms, { uuid: 'uuid-amy', identity });
    check('#43 不声明级别的单照旧放行（行为不变）', gateOk.allowed === true);
    const jobsrc = readSrc('agent', 'permissions.js');
    check('#43 文档明确标"未接线 + 接线前必须先拿 uuid/identity"',
        /未接线（刻意如此）/.test(jobsrc) && /不许用 `\{identity:null, uuid:null\}` 接线/.test(jobsrc));
}

// ══ #36 退出路径的有界等待 ═══════════════════════════════════════
{
    const code = readSrc('process', 'init_agent.js');
    check('#36 有界等待辅助（计时器 + Promise.race）',
        /const EXIT_RPC_TIMEOUT_MS = \d+;/.test(code) && /Promise\.race\(\[work, timeout\]\)/.test(code));
    check('★ #36 board.update / board.release 都走 waitBounded（不再裸 await 挂死退出）',
        (code.match(/await waitBounded\(/g) || []).length >= 2
        && !/await agent\?\.board\?\.update\?\.\(id,/.test(code)
        && !/await agent\?\.board\?\.release\?\.\(id\)/.test(code));
    check('#36 超时**留痕**（不是静默忽略）', /无 ack ⇒/.test(code) && /不再等它/.test(code));
}

// ══ Nice #78 / #79 / #80 ════════════════════════════════════════
{
    const promo = readSrc('models', 'prompter.js');
    check('★ #78 last_convo_* 改为全量赋值（不再只置位不复位）',
        /this\.last_convo_truncated = r\.truncated === true;/.test(promo)
        && /this\.last_convo_error_code = r\.failed \? \(r\.errorCode \?\? null\) : null;/.test(promo));

    const hist = readSrc('agent', 'history.js');
    check('★ #79 turns 裁剪改成"一次算该丢几条"（不再每丢一条全量 stringify）',
        /const perTurn = turns\.map/.test(hist) && !/while \(turns\.length > MIN_TURNS && byteLen\(\{ \.\.\.out, turns \}\) > LIMIT\)/.test(hist));

    const agentSrc = readSrc('agent', 'agent.js');
    // 只判**代码行**：注释里记录旧缺陷原文（`to_player === 'system' || …`）不算数
    const agentCode = agentSrc.split('\n')
        .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
        .join('\n');
    check('★ #80 routeResponse 的内部来源只认显式 internal 标记',
        /const self_prompt = opts\?\.internal === true;/.test(agentCode)
        && !/to_player === 'system' \|\| to_player === this\.name/.test(agentCode));
    const calls = (agentSrc.match(/this\.routeResponse\(source, [^;]*?\{ internal: is_internal \}\)/g) || []).length;
    check('#80 所有 routeResponse 调用点都显式传 internal 标记', calls >= 6, `→ ${calls} 处`);
}

console.log('\n============================================');
console.log(fail === 0 ? `ALL PASS: ${pass} passed` : `${pass} passed, ${fail} FAILED`);
console.log('============================================');
process.exit(fail === 0 ? 0 : 1);
