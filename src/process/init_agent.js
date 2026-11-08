import { Agent } from '../agent/agent.js';
import { serverProxy } from '../agent/mindserver_proxy.js';
import yargs from 'yargs';
import { installLogPrefix } from '../infra/log_prefix.js';
// F-EXEC-102：父进程消失时自行退出（孤儿自杀）
import { makeParentWatcher } from './proc_lifecycle.js';

// ★ 第12条（T04）：本进程所有 console 输出加 ISO8601 前缀。
//   必须在任何输出之前调用 —— 下面那条 Usage 提示也要带时间戳。
//   放在 import 之后是因为 ESM 的 import 提升：本模块之前被 import 的模块在**求值期**打的日志
//   抓不到（那是模块各自的事）；但本文件之后的一切（含 argv 解析、agent 启动）都覆盖到了。
//   幂等：重复调用不会叠加前缀。
installLogPrefix();

const args = process.argv.slice(2);
if (args.length < 1) {
    console.log('Usage: node init_agent.js -n <agent_name> -p <port> -l <load_memory> -m <init_message> -c <count_id>');
    process.exit(1);
}

const argv = yargs(args)
    .option('name', {
        alias: 'n',
        type: 'string',
        description: 'name of agent'
    })
    .option('load_memory', {
        alias: 'l',
        type: 'boolean',
        description: 'load agent memory from file on startup'
    })
    .option('init_message', {
        alias: 'm',
        type: 'string',
        description: 'automatically prompt the agent on startup'
    })
    .option('count_id', {
        alias: 'c',
        type: 'number',
        default: 0,
        description: 'identifying count for multi-agent scenarios',
    })
    .option('port', {
        alias: 'p',
        type: 'number',
        description: 'port of mindserver'
    })
    .argv;

(async () => {
    try {
        console.log('Connecting to MindServer');
        await serverProxy.connect(argv.name, argv.port);
        console.log('Starting agent');
        const agent = new Agent();
        serverProxy.setAgent(agent);

        // ★ F-EXEC-102（2026-11-06）：**孤儿自杀** —— 枪2（父进程被 SIGKILL）唯一有效的兜底。
        //
        // 为什么必须有这一层：父被强杀（任务管理器/SIGKILL/断电）时**没有任何机会**执行清理，
        // 所以"只改 mindserver 侧"的修法在枪2 上必挂。
        // 为什么不用 process.ppid：Windows 上父死后 ppid 不会变成 1（可能被复用），判不准；
        // 且 agent 用 stdio:'inherit' 起、**没有 IPC**，拿不到 'disconnect'。
        // ⇒ 用父进程传下来的 MINDSERVER_PID，定期 `kill(pid, 0)` 问一声。
        //
        // 判据#2（退出前不持 board 租约）：发现父没了 → 先**停自动领单 + 断开任务板连接**
        // （断连即停止心跳 ⇒ 租约自然过期、不再续租），再退出。
        const watcher = makeParentWatcher({
            parentPid: process.env.MINDSERVER_PID,
            intervalMs: 5000,
            onOrphan: (ppid) => {
                console.error(`[agent:${argv.name}] 检测到父进程（mindserver pid=${ppid}）已消失 ⇒ 孤儿自杀。`);
                console.error('[agent] 先停自动领单 + 断开任务板连接（不再续租），然后退出。');
                try { agent?.board?.setAutoClaim?.(false); } catch { /* ignore */ }
                try { agent?.scheduler?.stop?.(); } catch { /* ignore */ }
                try { agent?.board?.socket?.disconnect?.(); } catch { /* ignore */ }
                try { watcher?.stop?.(); } catch { /* ignore */ }
                // 给上面几个 best-effort 一点落地时间就退出（不无限等：父已经没了）
                setTimeout(() => process.exit(0), 200).unref?.();
            },
        });

        // ═══ R4：**先摘租约/放预约，再退出**（这是父进程杀进程前的"停手"契约）
        //  父进程（agent_process.stop()/stopAndWait()）一律**先发 SIGINT、等 graceMs、才 SIGKILL**；
        //  本进程收到 SIGINT 后必须在退出之前把"我手上那张单"交还共享池，否则：
        //  租约还挂着 → 别的 bot 在这 30 秒里拿不到单；而进程一死就**没人能摘了**。
        //  注意顺序：**摘租约（步骤 ④⑤）必须在断开连接/退出之前**，所以这里是 await 到底再 exit。
        let graceful = false;
        const gracefulStop = async (trigger) => {
            if (graceful) return false;
            graceful = true;
            console.log(`[agent:${argv.name}] 收到 ${trigger} ⇒ 先摘租约/放预约，再退出`);
            try { agent?.board?.setAutoClaim?.(false); } catch { /* ignore */ }
            // 'preempt' = control.STOP_REASONS.PREEMPT（"回 ready，放掉租约和预约"）
            try { agent?.scheduler?.stop?.('preempt'); } catch { /* ignore */ }
            try { agent?.board?.stop?.('preempt'); } catch { /* 心跳从此一拍都不发 */ }
            const id = agent?.scheduler?.currentJobId ?? agent?.actions?.currentJobId ?? null;
            if (id != null) {
                try {
                    // ④ 单回共享池：一次性把 state/租约/assignee 都清掉。
                    //    ★ 为什么不能只 `releaseLease()`（只清 lease）：`expireLeases` 只回收
                    //    `lease_until IS NOT NULL` 的单 ⇒ 租约清成 NULL 而状态还留在 claimed
                    //    就**再也不会被回收**（比过期更糟：永久僵尸单）。而 assignee 不清，
                    //    `claimFor` 的候选条件（assignee IS NULL OR = 我）也让别人抢不到。
                    await agent?.board?.update?.(id, {
                        state: 'ready', lease_owner: null, lease_until: null, assignee: null,
                    });
                } catch { /* 交还失败也要继续退出：别把退出路径挂死 */ }
                try { await agent?.board?.release?.(id); } catch { /* 放预约 */ }
            }
            // ⑤ 最后才断板连接 + 退出（顺序反了就等于"先死再摘"）
            try { agent?.board?.socket?.disconnect?.(); } catch { /* ignore */ }
            try { watcher?.stop?.(); } catch { /* ignore */ }
            return true;
        };
        for (const sig of ['SIGINT', 'SIGTERM']) {
            process.once(sig, () => {
                void gracefulStop(`signal:${sig}`).finally(() => {
                    // 给上面几次 ack 一点落地时间再退（父进程在 stopAndWait 里等这一下）
                    setTimeout(() => process.exit(0), 50).unref?.();
                });
            });
        }

        // ⑥ 还有一条**不走信号**的退出路径：`agent.cleanKill()`（被踢 / 断线超时 / 缺玩家）
        //    它内部直接 `process.exit(code)`，绕过上面的 SIGINT 处理器。这里包一层：
        //    **先摘租约再让它退出**（顺序与信号路径一致）。agent.js 本体一行不动。
        if (typeof agent?.cleanKill === 'function') {
            const originalCleanKill = agent.cleanKill.bind(agent);
            agent.cleanKill = (msg, code) => {
                // 不返回 Promise（调用点都是同步的），但两侧都接住 —— 退出路径不许再抛
                gracefulStop(`cleanKill:${code ?? 1}`).then(
                    () => originalCleanKill(msg, code),
                    () => originalCleanKill(msg, code),
                ).catch(() => { /* ignore */ });
            };
        }

        await agent.start(argv.load_memory, argv.init_message, argv.count_id);
    } catch (error) {
        console.error('Failed to start agent process:');
        console.error(error.message);
        console.error(error.stack);
        process.exit(1);
    }
})().catch((e) => {
    // ★ T32 顺手清掉（这条原文出现在 T04 的交接里，标的是 T20 的领地）：
    //   这个 IIFE 内部已有完整 try/catch，只有 catch 块自身抛（或 process.exit 被 stub）
    //   才会走到这里 —— 但"浮空"就意味着万一抛了是 unhandled rejection。
    //   补一行显式边界，让 T90 的 no-floating-promise 硬指标归零。
    console.error('[init_agent] 顶层异步启动异常（已兜住）：', e);
});
