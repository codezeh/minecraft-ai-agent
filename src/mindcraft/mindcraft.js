import { createMindServer, registerAgent, numStateListeners, getHandshakeToken } from './mindserver.js';
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

        const agentProcess = new AgentProcess(agent_name, mindserver_port);
        // ★ 第19条：让 AgentProcess 在"该摘掉自己"时（退出码>1 / 连续起不来）
        //   **只摘掉这个 agent**，而不是 process.exit 掉整个 mindserver。
        //   用注入而不是让 agent_process.js 反向 import 本文件：那会形成
        //   mindcraft → agent_process → mindcraft 的循环依赖。
        agentProcess.unregister = () => destroyAgent(agent_name);
        agentProcess.start(load_memory, init_message, agentIndex);
        agent_processes[settings.profile.name] = agentProcess;
    } catch (error) {
        console.error(`Error creating agent ${agent_name}:`, error);
        destroyAgent(agent_name);
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
    if (agent_processes[agentName]) {
        agent_processes[agentName].forceRestart();
    }
    else {
        console.error(`Cannot start agent ${agentName}; not found`);
    }
}

export function stopAgent(agentName) {
    if (agent_processes[agentName]) {
        agent_processes[agentName].stop();
    }
}

export function destroyAgent(agentName) {
    if (agent_processes[agentName]) {
        agent_processes[agentName].stop();
        delete agent_processes[agentName];
    }
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
