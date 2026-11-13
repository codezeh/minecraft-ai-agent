import { createMindServer, registerAgent, numStateListeners, getHandshakeToken, issueAgentToken, revokeAgentTokenByName } from './mindserver.js';
import { AgentProcess } from '../process/agent_process.js';
import { getServer } from './mcserver.js';
import open from 'open';

let mindserver;
let connected = false;
let agent_processes = {};
let agent_count = 0;
let mindserver_port = 8080;

export async function init(host_public=false, port=8080, auto_open_ui=true) {
    if (connected) {
        console.error('Already initiliazed!');
        return;
    }
    mindserver = createMindServer(host_public, port);
    mindserver_port = port;
    connected = true;
    if (auto_open_ui) {
        setTimeout(() => {
            // check if browser listener is already open
            if (numStateListeners() === 0) {
                // 第1条 ①：带 token 打开，否则控制台自己会被握手门挡住
                const token = getHandshakeToken();
                open('http://localhost:' + port + (token ? `/?token=${encodeURIComponent(token)}` : ''));
            }
        }, 3000);
    }
}

export async function createAgent(settings) {
    if (!settings.profile.name) {
        console.error('Agent name is required in profile');
        return {
            success: false,
            error: 'Agent name is required in profile'
        };
    }
    // ★ R4 S1#3：同名 agent 的**旧进程还活着**时不许再创建一个。
    //   原来这里只看 agent_connections（面板侧的表），而 destroyAgent 未确认退出时会留下
    //   agent_processes 条目 —— 于是"删了再建"能造出两个同名进程（双开）。
    //   现在把"进程表里还有人"当成硬拒绝，并说清该做什么。
    if (agent_processes[settings.profile.name]?.running && agent_processes[settings.profile.name]?.process) {
        console.error(`[create] ${settings.profile.name} 的进程仍在运行，拒绝重复创建（会双开）`);
        return {
            success: false,
            error: `agent "${settings.profile.name}" 的进程仍在运行；请先 destroy-agent 并确认它已退出`
        };
    }
    settings = JSON.parse(JSON.stringify(settings));
    let agent_name = settings.profile.name;
    const agentIndex = agent_count++;
    const viewer_port = 3000 + agentIndex;
    registerAgent(settings, viewer_port);
    let load_memory = settings.load_memory || false;
    let init_message = settings.init_message || null;

    try {
        try {
            const server = await getServer(settings.host, settings.port, settings.minecraft_version);
            settings.host = server.host;
            settings.port = server.port;
            settings.minecraft_version = server.version;
        } catch (error) {
            console.warn(`Error getting server:`, error);
            if (settings.minecraft_version === "auto") {
                settings.minecraft_version = null;
            }
            console.warn(`Attempting to connect anyway...`);
        }

        // ★ ADR 阶段 1（2026-11-11）：每只 bot 一条**独立凭据**，随 spawn 的 env 传下去。
        //   原来所有子进程共用一条 agentToken ⇒ 持它的进程能 login-agent 抢任意名字。
        //   发不出来（名字非法等）就退回共享凭据并在日志里点名，不让 bot 起不来。
        const agentToken = issueAgentToken(agent_name);
        if (!agentToken) {
            console.warn(`[agent:${agent_name}] 未能签发独立凭据，退回共享 agent 凭据（该进程仍可抢名字，见 ADR 阶段 1 残留）`);
        }
        const agentProcess = new AgentProcess(agent_name, mindserver_port, { agentToken });
        // ★ 第19条：让 AgentProcess 在"该摘掉自己"时（退出码>1 / 连续起不来）
        //   **只摘掉这个 agent**，而不是 process.exit 掉整个 mindserver。
        //   用注入而不是让 agent_process.js 反向 import 本文件：那会形成
        //   mindcraft → agent_process → mindcraft 的循环依赖。
        //   ★ R4 S1#4：destroyAgent 现在是异步的（要等子进程确认退出）⇒ 注入的函数
        //   必须自己接住拒绝，不能让一个未处理的 Promise 把控制面带走。
        agentProcess.unregister = () => {
            destroyAgent(agent_name).catch((e) => console.error(`[agent:${agent_name}] 摘除失败：`, e));
        };
        agentProcess.start(load_memory, init_message, agentIndex);
        agent_processes[settings.profile.name] = agentProcess;
    } catch (error) {
        console.error(`Error creating agent ${agent_name}:`, error);
        await destroyAgent(agent_name);   // ★ R4 S1#4：等它确认退出，别留下半个进程
        return {
            success: false,
            error: error.message
        };
    }
    return {
        success: true,
        error: null
    };
}

export function getAgentProcess(agentName) {
    return agent_processes[agentName];
}

export function startAgent(agentName) {
    const ap = agent_processes[agentName];
    if (!ap) {
        console.error(`Cannot start agent ${agentName}; not found`);
        return { started: false, exited: true, reason: 'not-found' };
    }
    // ★ R4 S1#3：forceRestart 现在是**异步**的（先等旧子进程确认退出，再拉起新进程）。
    //   原来这里是同步调用、结果被丢掉 ⇒ 面板连点时两个 spawn 并发 = 同一个 bot 双开。
    //   返回 Promise 让 mindserver 能等到结果并如实告诉面板「这次没起来 / 正在重启中」。
    if (typeof ap.forceRestart === 'function') return ap.forceRestart();
    // 兜底：老对象没有 forceRestart（不该发生，但别因此把启动变成静默失败）
    const started = typeof ap.start === 'function' ? ap.start(true, 'Agent process restarted.', ap.count_id) : false;
    return { started: started !== false, exited: true, reason: 'no-forceRestart' };
}

export function stopAgent(agentName) {
    const ap = agent_processes[agentName];
    if (!ap) {
        console.error(`Cannot stop agent ${agentName}; not found`);
        return { exited: true, sent: false, reason: 'not-found' };
    }
    return ap.stop();
}

/**
 * ★★★ R4 S1#4：删掉一个 agent —— **未确认退出就不删表**。
 *
 * 缺陷原貌（`mindcraft.js:103-108`）：`stop()`（fire-and-forget，只发 SIGINT）+ 立刻
 * `delete agent_processes[agentName]`。于是：
 *   · 忽略 SIGINT 的子进程仍在跑（孤儿），**继续持有 board 连接、继续领单 + 续租**；
 *   · 而控制面这边已经把句柄删了 ⇒ 再也管不到它（面板看不到、`!stop` 到不了、重启也拉不回）。
 * 面板上表现为"这个 bot 明明删掉了却还在干活"，任务板上一张单被一个不存在的人长期占着。
 *
 * 现在：`stopAndWait()`（SIGINT → 等 graceMs → SIGKILL → 再等）确认退出之后才删表；
 * 没确认退出就**保留注册表条目**并返回 `{ok:false}` —— 让调用方如实告诉用户
 * （"还在跑，请查进程表"），而不是把问题变成不可见的孤儿。
 *
 * @returns {Promise<{ok:boolean, removed:boolean, exited:boolean, escalated?:boolean, reason:string}>}
 */
export async function destroyAgent(agentName) {
    const ap = agent_processes[agentName];
    if (!ap) {
        // 没有进程条目也照样撤凭据（幂等）：这只 bot 已经不在了，旧 token 不该还能过握手门。
        const cred0 = revokeAgentTokenByName(agentName);
        return { ok: true, removed: false, exited: true, reason: 'not-found', credential: cred0 };
    }

    let r;
    if (typeof ap.stopAndWait === 'function') {
        r = await ap.stopAndWait({ graceMs: 5000, killGraceMs: 3000 });
    } else {
        // 兜底：老对象只有 stop()（不该发生）。它不能证明"退了"，所以按未确认处理。
        ap.stop?.();
        r = { exited: false, escalated: false, reason: 'no-stopAndWait' };
    }

    if (!r.exited) {
        console.error(`[destroy] ${agentName} 未确认退出（${r.reason}）—— **保留注册表条目**：` +
            `否则它会变成再也管不到的孤儿（继续领单/续租），面板也看不到它。`);
        return { ok: false, removed: false, exited: false, escalated: !!r.escalated, reason: r.reason };
    }
    delete agent_processes[agentName];
    // ★ P2-5：**确认退出之后**才撤凭据 + 断开仍持旧 token 的连接。撤早了会让还在跑（未确认退出）的
    //   进程失联；撤晚了（原来根本不撤）旧 token 在 mindserver 存活期间一直有效，同名重建也复用不到名字。
    const cred = revokeAgentTokenByName(agentName);
    return { ok: true, removed: true, exited: true, escalated: !!r.escalated, reason: r.reason, credential: cred };
}

/**
 * ★ F-EXEC-102（2026-11-06）：关停必须**等子进程真的退出**，不能发完信号就 `process.exit`。
 *
 * 原来的实现是 `stop()` 循环 + `setTimeout(2000) → process.exit(0)`：
 * 2 秒内没退干净的 agent 会变成**孤儿** —— 它仍持有 `board_client`，继续领单 + 续租，
 * 面板看着"正常在干活"、`!stop` 到不了它、任务板第 4/6 条的防护在孤儿场景全部失效。
 *
 * 现在：逐个 `stopAndWait()`（SIGINT → 等 graceMs → SIGKILL → 再等），**全部有结果之后**才 exit。
 * 返回值便于断言/日志：每个 agent 一条 {name, exited, escalated, reason}。
 * 注意：这就是"崩溃退出"之外的"正常关停"路径；父进程被硬杀（SIGKILL/断电）那条由
 * agent 子进程自己的**孤儿自杀**兜底（见 src/process/proc_lifecycle.js 的 makeParentWatcher）。
 */
export async function shutdownAndWait({ graceMs = 5000, killGraceMs = 3000, exitAfter = true } = {}) {
    console.log('Shutting down');
    const names = Object.keys(agent_processes);
    const results = await Promise.all(names.map(async (name) => {
        const ap = agent_processes[name];
        try {
            if (typeof ap.stopAndWait === 'function') {
                const r = await ap.stopAndWait({ graceMs, killGraceMs });
                return { name, ...r };
            }
            // 兜底：老对象只有 stop()（不该发生，但别因此卡住关停）
            ap.stop?.();
            return { name, exited: false, escalated: false, reason: 'no-stopAndWait' };
        } catch (e) {
            return { name, exited: false, escalated: false, reason: 'throw:' + (e?.message ?? e) };
        }
    }));

    const bad = results.filter(r => !r.exited);
    for (const r of results) {
        const tag = r.exited ? (r.escalated ? '强杀后退了' : '自己退了') : '未确认退出';
        console.log(`[shutdown] ${r.name}: ${tag}（${r.reason}）`);
    }
    if (bad.length) {
        console.error(`[shutdown] ${bad.length} 个 agent 未确认退出：${bad.map(b => b.name).join(', ')}` +
            ` —— 它们可能成为孤儿（继续领单/续租），请检查进程表`);
    }

    if (exitAfter) {
        console.log('Exiting MindServer');
        process.exit(0);
    }
    return results;
}

export function shutdown() {
    // 兼容旧调用点：语义不变（发信号并最终退出），但改成"等确认"的实现
    return shutdownAndWait();
}

/**
 * ★ 仅测试用：`agent_processes` 是模块私有表，离线用例要能注入"假 AgentProcess"
 * 才验得了 `destroyAgent` 的「未确认退出不删表」与 `startAgent` 的双开闸。
 *
 * 生产代码不得使用（表的所有权只属于本模块的 createAgent/destroyAgent）。
 * 单独命名成 __test 而不是散落的 setter，是为了 grep 就能查清"谁在动这张表"。
 */
export const __test = {
    names: () => Object.keys(agent_processes),
    get: (agentName) => agent_processes[agentName],
    set: (agentName, ap) => { agent_processes[agentName] = ap; },
    remove: (agentName) => { delete agent_processes[agentName]; },
};
