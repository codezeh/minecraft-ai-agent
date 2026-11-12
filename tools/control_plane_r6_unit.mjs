/**
 * R6 控制面清零批（#21 #23 #25 #26 #27 #28 #29 #30 #31 #32 #33 #72 #74 #75）—— **离线**。
 *
 * 为什么单独一个文件：这批改动大多是"收窄边界"（鉴权、限流桶、并发闸、写前 CAS、
 * 资源上限），它们的**失败形态是静默的** —— 放开一点也照样跑，只是把口子留回去。
 * 所以每条都要有一个"改回去就会红"的断言，而不是只在文档里写"已修"。
 *
 * 判据分三类：
 *   A. 纯逻辑（可在本文件里直接驱动）：并发闸、Host 白名单、限流桶主体键；
 *   B. 行为（会真的碰 fs / 网络，但有界）：`findServers` 的 try/finally 与总预算；
 *   C. 接线（源码断言）：函数改对了还得**真的接上**（防"改了但没人调用"）。
 *
 * 输出：PASS / FAIL，全过退出码 0（unit_all 按 PASS 行数判"真的跑了用例"）。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createConcurrencyGate, createUnlockLimiter } from '../src/mindcraft/unlock_limiter.js';
import { configuredHosts, isLocalRequest } from '../src/mindcraft/local_only.js';
import { findServers } from '../src/mindcraft/mcserver.js';
import { rateBucketKeyOf } from '../src/mindcraft/mindserver.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
    if (cond) { pass++; console.log(`PASS ${name} ${detail}`); }
    else { fail++; console.log(`FAIL ${name} ${detail}`); }
};

// ════════════════════════════════════════════════════════════════════════════
// A1. #30：scrypt 并发闸（管"同时在算几个"，不管"错了多少次"）
// ════════════════════════════════════════════════════════════════════════════
{
    const gate = createConcurrencyGate({ max: 2 });
    const r1 = gate.tryEnter();
    const r2 = gate.tryEnter();
    const r3 = gate.tryEnter();
    check('A1 并发闸：max=2 时前两个进得去、第三个**立刻**被拒（不排队）',
        typeof r1 === 'function' && typeof r2 === 'function' && r3 === null, `active=${gate.active}`);
    check('A1b 并发闸：peak 记到 2（证明真的并发过，而不是串行）', gate.peak === 2);
    r1();
    const r4 = gate.tryEnter();
    check('A1c 释放一个之后又能进一个', typeof r4 === 'function' && gate.active === 2);
    r1();
    check('A1d release 是**幂等**的（finally 里重复调用不会把计数减成负数）', gate.active === 2, `active=${gate.active}`);
    r2(); r4();
    check('A1e 全部释放后归零', gate.active === 0, `active=${gate.active}`);
    // 闸与失败限流是**两件事**：闸不管错了几次
    const limiter = createUnlockLimiter({ windowMs: 60_000, maxFails: 5 });
    for (let i = 0; i < 5; i++) limiter.noteFailure('127.0.0.1');
    check('A1f 限流与并发闸互不影响（限流超限时闸仍然放行 —— 正确口令不能被"额度"否决）',
        limiter.isThrottled('127.0.0.1') === true
        && typeof createConcurrencyGate({ max: 2 }).tryEnter() === 'function');
}

// ════════════════════════════════════════════════════════════════════════════
// A2. #23：MIND_SERVER_ALLOWED_HOSTS —— HTTP 放开了，socket 也得放开
// ════════════════════════════════════════════════════════════════════════════
{
    const req = (host, origin) => ({ headers: { host, ...(origin === undefined ? {} : { origin }) } });
    const defaultHosts = configuredHosts({});      // 不设 MIND_SERVER_ALLOWED_HOSTS

    check('A2 默认（不设 env）：外网 Host 仍被拒（安全默认不变）',
        isLocalRequest(req('evil.example:8080'), defaultHosts) === false
        && isLocalRequest(req('localhost:8080'), defaultHosts) === true);

    const env = { MIND_SERVER_ALLOWED_HOSTS: '192.168.1.23, my-host.lan' };
    const hosts = configuredHosts(env);
    check('A2b 设了 env：列出的 Host 被接受（容器/局域网部署不再"页面能开、连不上"）',
        isLocalRequest(req('192.168.1.23:8080'), hosts) === true
        && isLocalRequest(req('my-host.lan:8080'), hosts) === true);
    check('A2c 设了 env 也**没有**变成"谁都能连"：没列出的 Host 照样拒',
        isLocalRequest(req('evil.example:8080'), hosts) === false);
    check('A2d 本机名在加开之后仍然放行（不回归）',
        isLocalRequest(req('localhost:8080'), hosts) === true
        && isLocalRequest(req('[::1]:8080'), hosts) === true);
    check('A2e Origin 判据同样按加开后的集合判（带 Origin 的必须也是白名单里的页面）',
        isLocalRequest(req('192.168.1.23:8080', 'http://192.168.1.23:5173'), hosts) === true
        && isLocalRequest(req('192.168.1.23:8080', 'https://evil.example'), hosts) === false);
    check('A2f 空/空白 env 不会把白名单清空（仍是本机名，且没有加开）',
        configuredHosts({ MIND_SERVER_ALLOWED_HOSTS: ' , ' }).has('localhost') === true
        && isLocalRequest(req('evil.example:8080'), configuredHosts({ MIND_SERVER_ALLOWED_HOSTS: ' , ' })) === false);
}

// ════════════════════════════════════════════════════════════════════════════
// A3. #33 / ADR §10.2-5：限流桶**按 agent 分**（不再共用单一全局桶）
// ════════════════════════════════════════════════════════════════════════════
{
    const mk = (role, agentName, addr = '127.0.0.1', token = null) => ({
        data: role ? { role, ...(agentName ? { agentName } : {}) } : undefined,
        handshake: { address: addr, auth: token ? { token } : undefined },
    });

    const a = mk('agent', 'alice');
    const b = mk('agent', 'bob');
    const panel = mk('panel');
    const keyA = rateBucketKeyOf(a, 'create-agent');
    const keyB = rateBucketKeyOf(b, 'create-agent');
    const keyP = rateBucketKeyOf(panel, 'create-agent');

    check('A3 两只 agent 落在**不同**桶（一只刷 create-agent 不再替另一只把额度耗光）',
        keyA !== keyB, `${keyA} vs ${keyB}`);
    check('A3b agent 与面板落在不同桶（面板自己的配额不被 agent 吃掉）',
        keyA !== keyP && keyB !== keyP, `${keyP}`);
    check('A3c 同一个 agent 的同一个事件仍然是**同一条桶**（限流真的会累加，不是每次新建）',
        rateBucketKeyOf(mk('agent', 'alice'), 'create-agent') === keyA);
    check('A3d 不同事件仍分开计（label 在键里）',
        rateBucketKeyOf(a, 'restart-agent') !== keyA);
    check('A3e 未绑定名字的 agent 退回**凭据指纹**（每只 bot 一条独立凭据 ⇒ 仍能分开）',
        rateBucketKeyOf(mk('agent', null, '127.0.0.1', 'token-aaaa'), 'create-agent')
        !== rateBucketKeyOf(mk('agent', null, '127.0.0.1', 'token-bbbb'), 'create-agent'));
    check('A3f 面板的键**不含** agent 名（面板不是 agent 主体）',
        !/agent:/.test(keyP), keyP);
}

// ════════════════════════════════════════════════════════════════════════════
// B. #32：findServers 的 try/finally 与总预算（会真的碰网络，但有界）
// ════════════════════════════════════════════════════════════════════════════
{
    const original = console.log;
    const t0 = Date.now();
    // 端口范围故意只留 4 个 + 极小超时：本机这些端口几乎肯定拒绝，逐批并发很快就结束。
    const out = await findServers('127.0.0.1', true, 20, {
        startPort: 1, endPort: 4, concurrency: 4, totalBudgetMs: 2000,
    });
    const elapsed = Date.now() - t0;
    check('B1 findServers 正常返回（不再逐端口串行 49000→65000）', Array.isArray(out));
    check('B2 findServers **无论如何**都还原 console.log（原来中途抛错就永久静默）',
        console.log === original, `console.log === original: ${console.log === original}`);
    check('B3 findServers 受总预算约束（不会跑 27 分钟）', elapsed < 5000, `elapsed=${elapsed}ms`);

    // 预算耗尽路径：给一个必然不够的预算，确认它**提前结束**而不是扫完整个范围
    const t1 = Date.now();
    const out2 = await findServers('127.0.0.1', false, 20, {
        startPort: 1, endPort: 65000, concurrency: 1, totalBudgetMs: 30,
    });
    const elapsed2 = Date.now() - t1;
    check('B4 预算耗尽时提前结束并返回（并留下 warn 说明扫描被截断）',
        Array.isArray(out2) && elapsed2 < 5000, `elapsed=${elapsed2}ms, found=${out2.length}`);
    check('B5 预算路径也还原了 console.log', console.log === original);
}

// ════════════════════════════════════════════════════════════════════════════
// C. 接线断言：改对了还得真的接上
// ════════════════════════════════════════════════════════════════════════════
{
    const read = (p) => readFileSync(path.join(__dirname, p), 'utf8');
    const ms = read('../src/mindcraft/mindserver.js');
    const code = ms.split('\n').filter((l) => !/^\s*(\*|\/\/)/.test(l)).join('\n');
    const cc = read('../src/mindcraft/config_center.js');

    // ── #33：桶键必须走主体 ──
    check('C1 takeToken 的键走了 rateSubjectOf（按 agent 分桶，§10.2-5）',
        /const subject = rateSubjectOf\(socket\)/.test(ms)
        && /const key = rateBucketKeyOf\(socket, label\)/.test(ms));

    // ── #26：chat-message 有身份校验 ──
    const chatPos = ms.indexOf("socket.on('chat-message'");
    const chatBlock = chatPos === -1 ? '' : ms.slice(chatPos, chatPos + 1600);
    check('C2 chat-message 要求 agent 身份（原来任何持 token 连接都能向任意 bot 注入消息）',
        /isAgentIdentity\(socket\)/.test(chatBlock));
    check('C2b chat-message 目标经过 knownAgent（原型链键不再是 agent 名）',
        /knownAgent\(agentName\)/.test(chatBlock));

    // ── #27：get-settings 限流 + 只读自己 ──
    const gsPos = ms.indexOf("socket.on('get-settings'");
    const gsBlock = gsPos === -1 ? '' : ms.slice(gsPos, gsPos + 1800);
    check('C3 get-settings 有限流（原来可高频拉取）',
        /takeToken\(socket, 'get-settings'/.test(gsBlock));
    check('C3b get-settings 对 agent 连接做"只读自己"判定（凭据归属/通道绑定）',
        /ROLE_AGENT/.test(gsBlock) && /credentialAgent\(/.test(gsBlock) && /identity-only/.test(gsBlock));
    check('C3c get-settings 不再用 `if (agent_connections[agentName])` 这种原型链判据',
        !/if \(agent_connections\[agentName\]\) \{/.test(code));

    // ── #25：原型链键在四个 handler 里都被 knownAgent 挡住 ──
    for (const ev of ['set-agent-settings', 'stop-agent', 'restart-agent', 'destroy-agent']) {
        const pos = ms.indexOf(`socket.on('${ev}'`);
        const blk = pos === -1 ? '' : ms.slice(pos, pos + 2000);
        check(`C4 ${ev} 用 knownAgent 收口（原型链键不再能当 agent 名）`, /knownAgent\(agentName\)/.test(blk));
    }
    check('C4b stop-all-agents 用自有键枚举（不再 for...in 带上原型链）',
        /for \(const name of Object\.keys\(agent_connections\)\)/.test(ms));

    // ── #31：1 Hz 轮询并发 ──
    check('C5 1 Hz 轮询改成并发（Promise.all + 每只独立超时），不再串行 await',
        /Promise\.all\(targets\.map\(\(\[name, agent\]\) => fetchOne\(name, agent\)\)\)/.test(ms)
        && /Promise\.race\(/.test(ms));

    // ── #21：身份表写操作走写前 CAS ──
    // ★ ADR 阶段 1 收尾：身份写入的并发保护从"内容哈希 CAS"统一到
    //   identity_store 的 `mutateStore`（真进程间文件锁 + rev）。断言随之升级：
    //   仍要求 3 个调用点走同一个入口，且该入口必须**委托**给 mutateStore，
    //   不能退回到自己算哈希（否则又变成两套锁并存）。
    check('C6 身份码/身份表的写操作走 mutateStoreFile（统一委托 mutateStore 真文件锁）',
        (ms.match(/mutateStoreFile\(/g) || []).length >= 4      // 定义 + 3 个调用点
        && /mutateStore\(file, \(store\) => mutate\(store\)/.test(ms)
        && !/function fileHashOf/.test(ms));

    // ── #28：配置中心写前 CAS + 条件回滚 + 毫秒级备份名 ──
    check('C7 config_center 写前做 CAS（哈希不一致 → CONFLICT/409）',
        /CONFLICT: 'CONFIG_CONFLICT'/.test(cc)
        && /if \(currentHash !== expectedHash\)/.test(cc)
        && /CONFIG_ERROR\.CONFLICT/.test(cc));
    check('C8 config_center 的回滚只在"当前内容仍是我们写的那份"时执行',
        /hashOfText\(currentRaw\) === hashOfText\(after\)/.test(cc));
    check('C9 备份名带毫秒 + 序号（同秒两次写不再互相覆盖）',
        /getMilliseconds\(\), 3/.test(cc) && /backupSeq/.test(cc));

    // ── #29：危险开关要二次确认 ──
    check('C10 allow_insecure_coding 从 false 打开需要 confirm（与 socket 那扇门的口径对齐）',
        /CONFIG_ERROR\.CONFIRM_REQUIRED/.test(cc)
        && /applied\.allow_insecure_coding === true && oldInsecure !== true && !confirmed/.test(cc));
    check('C10b /api/config 的 PUT 把 confirm 与 patch 分开传（confirm 不是配置项，不能混进 SCHEMA 校验）',
        /body\.confirm === true/.test(ms) && /delete body\.confirm/.test(ms));

    // ── #30：/unlock 先过并发闸 ──
    check('C11 /unlock 路由先拿并发闸再进 scrypt（超出立刻 429，不排队）',
        /unlockScryptGate\.tryEnter\(\)/.test(ms) && /'VAULT_BUSY'/.test(ms));

    // ── #72：残留注册项不挡重建 ──
    // ★ S-3 收尾：摘注册项统一走 forgetAgentConn（连输出缓冲一起清），
    //   断言随之升级：原来只钉 `delete agent_connections[...]`，现在要求走 helper，
    //   且 helper 必须同时清 botOutputBuffers（否则又回到"自杀后缓冲残留"）。
    check('C12 create-agent 遇到"无进程无通道"的残留注册项先摘掉再重建',
        /isStaleAgentConn\(settings\.profile\.name\)/.test(ms)
        && /forgetAgentConn\(settings\.profile\.name\)/.test(ms)
        && /function forgetAgentConn\(name\)/.test(ms)
        && /botOutputBuffers\.delete\(name\)/.test(ms));

    // ── #74 / #75 ──
    check('C13 identity-status 读策略失败时带回原因（不再是裸 catch 变成 mode:null）',
        /modeError = String\(e\?\.message \?\? e\)/.test(ms) && /modeError,/.test(ms));
    check('C14 agentsStatusUpdate 用自有键枚举',
        /for \(const agentName of Object\.keys\(agent_connections\)\)/.test(ms));
}

// ════════════════════════════════════════════════════════════════════════════
// D. t2 移交残留：!claim 走原子核销 + identity-status 透出 corrupt/backup
// ════════════════════════════════════════════════════════════════════════════
{
    const { mkdtempSync, writeFileSync: wf, closeSync, openSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const root = mkdtempSync(path.join(tmpdir(), 'mc-r6-t8-'));
    const prevRoot = process.env.MC_BOTS_ROOT;
    process.env.MC_BOTS_ROOT = root;      // bot_paths.botsRootOf() 是**调用时**读 env
    try {
        const store = await import('../src/mindcraft/identity_store.js');
        const { identityList } = await import('../src/agent/commands/identity.js');
        const AGENT = 'botT8';
        const cmd = identityList.find((c) => c.name === '!claim');
        const mkAgent = (name, uuid) => ({
            name: AGENT, command_author: name,
            bot: { username: AGENT, players: { [name]: { uuid } } },
        });
        const codesFile = () => store.codesFileOf(AGENT);

        // D1 接线：核销必须走原子版（有锁 + rev 乐观锁 + 重试），且不再自己 writeStore(consumed.store)
        const identSrc = readFileSync(path.join(__dirname, '../src/agent/commands/identity.js'), 'utf8');
        check('D1 !claim 走 consumeCodeAtomic（不再"读→算→写"三步裸跑）',
            /consumeCodeAtomic\(codesPath, raw\)/.test(identSrc)
            && !/writeStore\(codesPath, consumed\.store\)/.test(identSrc));

        // D2 成功路径行为不变：签发 → 核销成功 → 落绑定
        const issued = store.issueCodeAtomic(codesFile(), { code: 'AAAA-BBBB', agent: AGENT, sessionId: 's1' });
        const okMsg = cmd.perform(mkAgent('Zeh', 'uuid-owner'), 'aaaa bbbb');
        check('D2 成功路径不变：码核销 + 绑定落盘 + 提示"绑定成功"',
            issued.ok === true && /绑定成功/.test(okMsg)
            && store.readStore(store.identityFileOf(AGENT)).store.bindings.length === 1
            && store.readStore(codesFile()).store.codes.length === 0, okMsg.slice(0, 40));

        // D3 单次性不变：表里还有别的码时，重复使用同一码 ⇒ "无效或已被使用"
        //    （若表已空，consumeCode 会回 no-codes ⇒ 文案是"没有可用的绑定码"——与改前逐字一致）
        store.issueCodeAtomic(codesFile(), { code: 'CCCC-DDDD', agent: AGENT, sessionId: 's2' });
        store.issueCodeAtomic(codesFile(), { code: 'GGGG-HHHH', agent: AGENT, sessionId: 's2b' });
        cmd.perform(mkAgent('Zeh', 'uuid-owner'), 'CCCC-DDDD');
        const reuse = cmd.perform(mkAgent('Zeh', 'uuid-owner'), 'CCCC-DDDD');
        check('D3 码单次性不变：重复使用 ⇒ "无效或已被使用"（表非空时）',
            /无效或已被使用/.test(reuse), reuse.slice(0, 40));

        // D4 锁被占（= 面板正在签发/作废）：给**可理解**的原因，且**没有**核销任何码
        store.issueCodeAtomic(codesFile(), { code: 'EEEE-FFFF', agent: AGENT, sessionId: 's3' });
        const lockPath = `${codesFile()}.lock`;
        closeSync(openSync(lockPath, 'wx'));            // 持锁（fresh mtime ⇒ 不会被当陈旧锁）
        const t0 = Date.now();
        const busy = cmd.perform(mkAgent('Zeh', 'uuid-owner'), 'EEEE-FFFF');
        const waited = Date.now() - t0;
        const stillThere = store.readStore(codesFile()).store.codes.some((c) => c.code === 'EEEE-FFFF');
        const leftovers = store.readStore(codesFile()).store.codes.length;
        try { (await import('node:fs')).unlinkSync(lockPath); } catch { /* ignore */ }
        check('D4 锁忙：给"被占用/请重试"这种可理解的原因，而不是"码文件写不回去"',
            /占用/.test(busy) && /重试/.test(busy) && !/写不回去/.test(busy), busy.slice(0, 50));
        check('D4b 锁忙**没有核销任何码**（失败不改状态：码还在表里，退出锁后仍可用）',
            stillThere === true && leftovers >= 1 && waited >= 1000, `waited=${waited}ms codes=${leftovers}`);
        // 拿到锁之后同一个码必须还能用（证明 D4 是"没做任何事"而不是"吞掉了码"）
        const retry = cmd.perform(mkAgent('Zeh', 'uuid-owner'), 'EEEE-FFFF');
        check('D4c 退出锁之后同一个码仍可核销（失败路径确实没消耗码）', /绑定成功/.test(retry));

        // D5 identity-status 透出 corrupt/backup（缺失时 false / null）
        const ms2 = readFileSync(path.join(__dirname, '../src/mindcraft/mindserver.js'), 'utf8');
        const pos = ms2.indexOf("socket.on('identity-status'");
        const blk = pos === -1 ? '' : ms2.slice(pos, pos + 3000);
        check('D5 identity-status 返回 corrupt / backup（面板能显示"身份表损坏、已留证 <路径>"）',
            /corrupt: idRead\.corrupt === true/.test(blk) && /backup: idRead\.backup \?\? null/.test(blk));
        // 行为：真损坏的表 → readStore 报 corrupt 并留证（面板字段的数据来源）
        const idFile = store.identityFileOf(AGENT);
        wf(idFile, '{ this is not json', 'utf8');
        const bad = store.readStore(idFile);
        check('D5b 损坏的身份表：readStore 带回 corrupt:true + backup 路径（面板据此显示留证位置）',
            bad.ok === false && bad.corrupt === true && typeof bad.backup === 'string' && bad.backup.length > 0,
            String(bad.backup ?? ''));
    } finally {
        if (prevRoot === undefined) delete process.env.MC_BOTS_ROOT;
        else process.env.MC_BOTS_ROOT = prevRoot;
    }
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'HAS FAILURES'}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
