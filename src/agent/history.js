import { writeFileSync, readFileSync, mkdirSync, existsSync, renameSync, promises as fsp } from 'fs';
import { NPCData } from './npc/data.js';
import settings from './settings.js';
// ★ T17：bots 根唯一可取处（默认 `./bots`；测试可用 `MC_BOTS_ROOT` 指到独立目录）
import { botsRootOf } from './library/bot_paths.js';
// F-AI-203：记忆落盘前净化（去控制字符/折叠空行，不删正文）
import { sanitizeExternalText } from '../utils/text.js';
// H4 第二道保险：摘要文本本身还带截断标记 = 当轮的摘要不完整（不依赖 prompter 的标志）
import { isTruncatedReply } from '../models/_shared.js';

/**
 * ★ R6 #12：把「当前操作」折算成模型调用要的取消三件套 `{signal, deadline, operationId}`。
 *
 * 唯一取消源是 `ActionManager._executeAction` 建好并挂到 `agent.currentOperation`
 * 的那个 operation（`{ id, deadline, ac }`）：`!stop` / 面板停止 / 动作总超时 /
 * 被新动作取代，走的是同一个 `abort`（action_manager.js:357-359 + `_abortCurrentOperation`）。
 *
 * 为什么这个折算必须出现在**调用点**：`prompter._callOptions({})` 的缺省是
 * `signal=null / timeoutMs=120000`，于是摘要请求只能等适配器自身的 120s 上限 ——
 * 玩家按停之后最长两分钟才停手，而且迟到的摘要还会照常落盘覆盖 memory.json。
 *
 * 没有在飞的操作时返回 `{}`（而不是三个 null 字段）：与接线前的缺省**逐字一致**，
 * 手动调用/离线测试拿到的行为不变。
 *
 * @param {{currentOperation?: {id:string, deadline:number|null, ac?:{signal:AbortSignal}|null}|null}} agent
 * @returns {{signal?:AbortSignal|null, deadline?:number|null, operationId?:string}}
 */
function operationCallOpts(agent) {
    const op = agent?.currentOperation ?? null;
    if (!op) return {};
    return {
        signal: op.ac?.signal ?? null,
        deadline: op.deadline ?? null,
        operationId: op.id,
    };
}

/**
 * 记忆的代码版本号。
 *
 * 当「关键判定逻辑」发生改变时 +1（例如修好了自然树误判、改了采集策略）。
 * 版本不符就丢弃 memory 里的经验结论，只保留事实（地点/箱子/死亡点）。
 *
 * 为什么要这个：记忆里会写下「附近橡木多为建筑不可砍」这种基于 bug 的结论，
 * 修好之后模型仍会照旧结论办事。手动删 JSON 能解决一次，但每次改逻辑都得人工介入。
 *
 * 注意：这个常量必须定义在这里（模块顶层）。上一次改的时候只加了引用没加定义，
 * 导致 agent 启动就 ReferenceError: MEMORY_CODE_VERSION is not defined 连崩 3 次。
 */
const MEMORY_CODE_VERSION = 5;
// 版本变更记录（每次改动「关键判定逻辑」时 +1，旧经验结论会被丢弃）：
//   2 — 自然树误判修复（树冠扫描窗口从 ±2 扩到 ±5）
//   3 — resolveCollectTarget 漏 import 修复
//   4 — 丛林采集修复（digBlock 可达判据从「距离+视线」改成只看距离）
//   5 — 采集重构（先侦察再动手 / 按树型分策略 / 缺工具自动造 / 清垫脚）
//       + 任务执行中不写记忆（避免把「命令刚发出」总结成「技能坏了」）


export class History {
    constructor(agent) {
        this.agent = agent;
        this.name = agent.name;
        // ★ T17：走 `botsRootOf()`，与 map/记忆/板库同一个根（可被 `MC_BOTS_ROOT` 覆盖）
        this.memory_fp = `${botsRootOf()}/${this.name}/memory.json`;
        this.full_history_fp = undefined;
        /**
         * ★ R6 #13：最近一次记忆落盘的失败原因（成功即清空）。
         * 为什么要有：`save()` 现在**不再向上抛**（见 save 的注释），不记下来就彻底看不见了。
         */
        this.saveError = null;
        /** ★ R6 #14：最近一次读记忆的失败原因（读/解析失败都会记，便于日志与面板排查）。 */
        this.loadError = null;
        /**
         * ★ R6 #14：坏文件被改名到哪了（`.corrupt-<ts>` 的完整路径）。
         * 为什么留这个字段：`memory.json` 是**她的人物记忆**，坏掉之后必须让
         * 日志/面板能说出"证据在哪、怎么修回去"，而不是只有一行 error。
         */
        this.corruptBackup = null;
        /** ★ R6 #14：本次启动的记忆是否来自"坏文件抢救"（true ⇒ 可能缺 turns / 版本未知）。 */
        this.recoveredFromCorrupt = false;

        mkdirSync(`${botsRootOf()}/${this.name}/histories`, { recursive: true });

        this.turns = [];

        // Natural language memory as a summary of recent messages + previous memory
        this.memory = '';

        // Maximum number of messages to keep in context before saving chunk to memory.
        // 注意：src/agent/settings.js 是个空壳，真正的值由 setSettings() 在构造之后注入。
        // 之前在构造函数里读一次，拿到的是 undefined，于是裁剪从来没生效过
        // （实测喂 100 条后 turns 仍是 100 条，全部落进 memory.json）。
        // 改成惰性读取，每次用的时候再取，取不到就用 30 兜底。
        this._defaultMaxMessages = 30;

        // Number of messages to remove from current history and save into memory
        this.summary_chunk_size = 5; 
        // chunking reduces expensive calls to promptMemSaving and appendFullHistory
        // and improves the quality of the memory summary

        /**
         * ★ BOT-007（2026-11-06 深度检查）：摘要必须**串行**。
         *
         * 缺陷原貌：`add()` 里 `turns.length >= max_messages` 就 splice 一批去
         * `await this.summarizeMemories(chunk)`，而 `summarizeMemories` 直接
         * `this.memory = await promptMemSaving(turns)`。两条 `add()` 并发（聊天处理本身是异步的）
         * 会各自 splice 一批、各自发一轮摘要请求 ⇒ **后发起的先返回就把 memory 覆盖成旧的**。
         * 报告实测：后请求先返回 newer-summary、旧请求后返回 older-summary，
         * 最终 memory=older-summary，而两批都已从 turns 删掉 ⇒ 新摘要永久丢失。
         *
         * 修法：把「摘要 + 归档」放进一条 promise 链（先到先跑），后一批一定基于
         * 前一批写完的 memory 再摘要。splice 仍按入队顺序发生，turns 时间序不会乱。
         */
        this._summaryChain = Promise.resolve();
    }

    /**
     * BOT-007：把一次「摘要 + 归档」排进串行队列。
     * @param {Array<{role:string, content:string}>} chunk 已经从 turns 摘出来的一批
     * @returns {Promise<void>}
     */
    _enqueueSummary(chunk) {
        const run = async () => {
            await this.summarizeMemories(chunk);
            await this.appendFullHistory(chunk);
        };
        // 上一批抛错也不能让整条链断掉（否则之后所有摘要都排在不执行的 promise 上）
        const next = this._summaryChain.then(run, run);
        this._summaryChain = next.catch(() => {});
        return next;
    }

    getHistory() { // expects an Examples object
        return JSON.parse(JSON.stringify(this.turns));
    }

    async summarizeMemories(turns) {
        console.log("Storing memories...");
        // ★★★ H4（第四轮复审）：**截断的摘要不许覆盖 memory.json**。
        //   生产端（prompter.promptMemSaving）已经改成"截断就返回旧摘要"，
        //   这里再做一次**事实校验**（第二道保险）：只要 prompter 报了截断，就根本不赋值。
        //   为什么要两道：摘要链是串行的（BOT-007），一旦有人以后在 prompter 里把截断分支
        //   改回"剥标记后照旧返回"，这边会把半截摘要写进长期记忆 —— 而 memory.json 跨重启存活，
        //   一次覆盖就是永久降级，且这批 turns 已经 splice 掉、没有重来的机会。
        // 架构收敛项(1) 步 1：优先读结果类型（status/errorCode），字符串判据只作未迁移路径的兜底。
        const prompter = this.agent.prompter;
        if (typeof prompter?.promptMemSavingResult === 'function') {
            // ★ R6 #12：第 2 参 opts 就是取消链的第 4 跳入口；不传它 = prompter 的
            //   t29 修复在生产里是死代码（signal 恒 null ⇒ abort 无路可走）。
            const typed = await prompter.promptMemSavingResult(turns, operationCallOpts(this.agent));
            if (typed.failed || typed.truncated || prompter.last_memory_summary_truncated) {
                console.warn('[memory] 本轮摘要不可用(' + typed.status
                    + (typed.errorCode ? '/' + typed.errorCode : '') + ') → 保留旧摘要，不覆盖 memory.json');
                return;
            }
            this.memory = typed.content;
        } else {
            const nextMemory = await prompter.promptMemSaving(turns, operationCallOpts(this.agent));
            if (prompter?.last_memory_summary_truncated || isTruncatedReply(nextMemory)) {
                console.warn('[memory] 本轮摘要被输出额度截断 → 保留旧摘要，不覆盖 memory.json');
                return;
            }
            this.memory = nextMemory;
        }

        // ★ F-AI-203（2026-11-06）：记忆是**数据不是命令**，执行侧没有判据可依赖，
        // 所以落盘前必须净化（只去控制字符/折叠空行，不删正文）；注入时再由 prompter 的
        // `$MEMORY` 用 fenceUntrusted 包一层。为什么在这里：`turns` 含玩家原始聊天，
        // 模型写回摘要时可能夹带注入文本，而 memory.json 跨重启存活 ⇒ 污染会长期生效。
        this.memory = sanitizeExternalText(this.memory, 1500);

        if (this.memory.length > 1500) {
            this.memory = this.memory.slice(0, 1500);
            this.memory += '...(Memory truncated to 1500 chars. Compress it more next time)';
        }

        console.log("Memory updated to: ", this.memory);
    }

    /**
     * 把这一批 turns **追写**进全程记录文件。
     *
     * ★ R4 §7-①（2026-11-07 第四轮审计）修复 —— 两个缺陷：
     *
     * ① **O(n²) 写盘**：原来是「每 5 条就把整个文件读进内存 → JSON.parse → push → 全量写回」。
     *    一次长会话的全程记录能到几十 MB，于是写第 N 条的成本是 O(N)，
     *    整场会话累计 O(N²)。现在只在**第一次**建文件，之后每次只改尾部。
     *
     * ② **一次截断就永久停写**：read/parse 失败被 `catch` 吞成一行日志 ⇒ 下次还在同一个
     *    坏文件上解析、还是失败 ⇒ 全程记录从那一刻起**永久空转**，而日志里只是一行 warn。
     *    现在：写失败会保留这一批（下次一起重试），并显式 `console.error` + 记到
     *    `this.fullHistoryError`；只有确认是「文件结构坏了」才换一个新文件（自愈），
     *    其它错误（磁盘满等）继续在同一文件上重试，不会造成"历史断掉还看不出来"。
     *
     * 文件格式**仍是合法 JSON 数组**（`histories/<时间戳>.json`），备份/外部查看脚本不用改：
     * 追写的方式是「退掉结尾的 `]` → 追加 `,{...}` → 补回 `]`」，单批成本 O(批大小)。
     *
     * 为什么这里**不向上抛**：`history.add()` 有 9 处是 fire-and-forget（不 await），
     * 抛出去就是 unhandled rejection —— 会直接带走整个 agent 进程。
     * 「写全程记录失败」不该有这种杀伤力，所以走"记错误 + 保住数据 + 下次重试"。
     */
    async appendFullHistory(to_store) {
        const batch = Array.isArray(to_store)
            ? to_store.filter((t) => t && typeof t === 'object')
            : [];
        if (batch.length === 0) return;

        // 上一次写失败的批次不丢：与本次合并重写，避免"错一次就永久少一段历史"
        const pending = Array.isArray(this._fullHistoryPending) ? this._fullHistoryPending : [];
        const all = pending.concat(batch);

        try {
            const fp = this._ensureFullHistoryFile();
            await this._appendJsonArray(fp, all);
            this._fullHistoryPending = [];
            this.fullHistoryError = null;
        } catch (err) {
            // 只保留最近 500 条，防止"持续失败 + 持续新消息"把内存拖爆
            this._fullHistoryPending = all.slice(-500);
            this.fullHistoryError = err;
            if (err?.code === 'FULL_HISTORY_CORRUPT') {
                // 文件被外部截断/改写：换一个新文件接着写（这是"永久停写"的自愈点）
                this.full_history_fp = undefined;
            }
            console.error(`[history] 写 ${this.name} 的全程记录失败（本批 ${all.length} 条已留待下次重试）: ${err?.message ?? err}`);
        }
    }

    /** 全程记录文件：只在第一次落盘时创建（`[\n]` 空数组骨架）。 */
    _ensureFullHistoryFile() {
        if (this.full_history_fp !== undefined) return this.full_history_fp;
        const string_timestamp = new Date().toLocaleString().replace(/[/:]/g, '-').replace(/ /g, '').replace(/,/g, '_');
        const dir = `${botsRootOf()}/${this.name}/histories`;
        let fp = `${dir}/${string_timestamp}.json`;
        // 同一秒内重启可能撞名：绝不覆盖已有文件，换个序号
        for (let n = 2; existsSync(fp); n++) fp = `${dir}/${string_timestamp}-${n}.json`;
        writeFileSync(fp, '[\n]\n', 'utf8');
        this.full_history_fp = fp;
        return fp;
    }

    /**
     * 把 items 追到一个 JSON 数组文件的尾部 —— **不重写已有内容**。
     *
     * 定位结尾 `]` → 截掉它 → 追加 `,\n{...}` → 补 `]`。只在文件尾部读写，
     * 因此单批成本与文件已有多大无关（修掉 O(n²)）。
     */
    async _appendJsonArray(fp, items) {
        const body = items.map((t) => JSON.stringify(t, null, 4)).join(',\n');
        const isWs = (c) => c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09;
        let fh;
        try {
            fh = await fsp.open(fp, 'r+');
            const { size } = await fh.stat();
            const tailLen = Math.min(size, 4096);
            if (tailLen === 0) {
                const err = new Error('全程记录文件是空的');
                err.code = 'FULL_HISTORY_CORRUPT';
                throw err;
            }
            const tail = Buffer.alloc(tailLen);
            await fh.read(tail, 0, tailLen, size - tailLen);

            // 从尾部往回跳空白，找数组结尾的 `]`
            let i = tailLen - 1;
            while (i >= 0 && isWs(tail[i])) i--;
            if (i < 0 || tail[i] !== 0x5d) {
                const err = new Error('全程记录文件结尾不是 JSON 数组的 “]”（文件可能被外部截断/改写）');
                err.code = 'FULL_HISTORY_CORRUPT';
                throw err;
            }
            const bracketAt = size - tailLen + i;

            // 再往前看一个非空白字符：是 `[` ⇒ 数组还是空的（不需要前置逗号）
            let j = i - 1;
            while (j >= 0 && isWs(tail[j])) j--;
            const isEmpty = j >= 0 && tail[j] === 0x5b;

            await fh.truncate(bracketAt);
            await fh.write(isEmpty ? `\n${body}\n]\n` : `,\n${body}\n]\n`, bracketAt, 'utf8');
        } finally {
            await fh?.close();
        }
    }

    /** 每次实时读取：settings 可能在构造之后才被 setSettings 注入。 */
    get max_messages() {
        const v = settings.max_messages;
        return Number.isFinite(v) && v > 0 ? v : this._defaultMaxMessages;
    }

    async add(name, content) {
        let role = 'assistant';
        if (name === 'system') {
            role = 'system';
        }
        else if (name !== this.name) {
            role = 'user';
            content = `${name}: ${content}`;
        }
        this.turns.push({role, content});

        if (this.turns.length >= this.max_messages) {
            // 关键：动作正在执行时不写记忆。
            // 实测问题：命令刚发出去、还没返回结果，turns 满了就触发摘要，
            // 模型看到「发出 collectBlocks 但没看到结果」，就总结成
            // 「collectBlocks 常中断拿不到木头，需换法」——而实际上那个命令 44 秒后
            // 成功返回了 OK。这种「把进行中当失败」的错误结论会让她越来越不敢用该技能。
            // 处理：动作执行中就先攒着，等下一次 add（通常是结果回来之后）再摘要。
            // 但要防「长期任务导致 turns 无限增长」：超过 2 倍上限就强制摘要。
            if (this.agent?.actions?.executing && this.turns.length < this.max_messages * 2) {
                return;
            }
            let chunk = this.turns.splice(0, this.summary_chunk_size);
            while (this.turns.length > 0 && this.turns[0].role === 'assistant')
                chunk.push(this.turns.shift()); // remove until turns starts with system/user message

            // ★ BOT-007：走串行队列，不再让两轮摘要互相覆盖 memory。
            await this._enqueueSummary(chunk);
        }
    }

    /**
     * 把记忆落盘到 `bots/<name>/memory.json`。
     *
     * ★ R6 #13（2026-11-10）：**落盘失败不许打挂进程。**
     *
     *   缺陷原貌：`writeFileSync` 失败（磁盘满、文件被面板/杀软占用、`bots/<name>/` 权限变更）
     *   → catch 里 `console.error` 后 **重新 throw**，而 3 个调用点
     *   （`agent.js` 的 handleMessage / 命令循环 / `cleanKill()`）**全都不 await**
     *   ⇒ unhandled rejection。Node 24 默认 `--unhandled-rejections=throw`
     *   ⇒ **整个 agent 进程崩溃**。最讽刺的是 `cleanKill()` 里也这么调：一次落盘失败
     *   把「正常重启」变成「异常崩溃」，退出码也不再是 planExit 期望的那个。
     *
     *   现在与同文件的 `appendFullHistory()` 同口径：**只记错误、不向上抛**。
     *   理由和那里一模一样 —— 「写记忆失败」不该有把进程带走的杀伤力。
     *   失败原因记在 `this.saveError`（调用方/日志可查），返回 `false` 而不是抛。
     *
     * 注意：本方法的写盘是**同步**的（`writeFileSync`），调用方即使 fire-and-forget，
     *      写入也在 `process.exit()` 之前完成（`cleanKill()` 依赖这一点）。
     *
     * @returns {Promise<boolean>} 是否真的写成功了
     */
    async save() {
        try {
            const data = {
                memory: this.memory,
                // 记忆的「代码版本戳」：当关键逻辑发生改变（例如修好了「自然树被
                // 误判成建筑」），旧记忆里的结论就不可信了 —— 它会让模型继续按
                // 错误结论行事（实测：她把「附近橡木多为建筑不可砍」写进记忆，
                // 修好判定后仍然绕远路）。
                // 读取时版本不符就丢弃 memory，只保留事实类数据（地点、箱子）。
                codeVersion: MEMORY_CODE_VERSION,
                turns: this.turns,
                self_prompting_state: this.agent.self_prompter.state,
                self_prompt: this.agent.self_prompter.isStopped() ? null : this.agent.self_prompter.prompt,
                // ★ 2026-11-01：目标是谁设的也要存 —— 自提示发出的命令按这个人定级（08 §5）。
                // 不存的话重启后等级会退回「信任」，等于升了权。
                self_prompt_author: this.agent.self_prompter.isStopped()
                    ? null : (this.agent.self_prompter.author ?? null),
                taskStart: this.agent.task.taskStartTime,
                last_sender: this.agent.last_sender,
                // 结构化的"记住的地点"（!rememberHere 存的坐标）。
                // 不加这一项的话，这些坐标只存在内存里，一重启就全丢。
                memory_bank: this.agent.memory_bank ? this.agent.memory_bank.getJson() : {},
            };
            writeFileSync(this.memory_fp, JSON.stringify(this.capSize(data), null, 2));
            console.log('Saved memory to:', this.memory_fp);
            this.saveError = null;
            return true;
        } catch (error) {
            // ★ R6 #13：**不抛**。抛出去就是 unhandled rejection ⇒ 整个进程被带走。
            this.saveError = error;
            console.error(
                `[memory] 保存 ${this.name} 的 memory.json 失败（本批记忆未落盘，进程继续运行）: `
                + `${error?.message ?? error}`,
            );
            return false;
        }
    }

    /**
     * memory.json 的硬上限（方案 §B6：上限 20 KB，超了按时间淘汰，不靠模型自觉）。
     *
     * 之前只靠 max_messages 控制条数，但单条可以很长（她一次写进几百行代码），
     * 实测 28 条就到 14 KB。这里按预算从旧到新丢弃，并给 memory 文本也设上限。
     *
     * ★ BOT-010（2026-11-06 深度检查）修复 —— 三件事：
     *
     * ① **按字节，不按字符**。原来是 `JSON.stringify(...).length`（UTF-16 码元数），
     *    而文件落盘是 UTF-8：一个汉字 3 字节、一个 emoji 4 字节，所以"20KB 的文件"
     *    实际能到 59KB（报告实测 59494 字节；纯中文例 6890 字符 = 20490 字节，
     *    明明超了 20480 却因为"字符数"没超而直接放行）。
     *    现在统一用 `Buffer.byteLength(..., 'utf8')`，与 writeFileSync 真正写出的字节对齐。
     *
     * ② **每个可变字段都有独立预算**，不再只盯 turns：
     *    memory（喂模型的摘要）、self_prompt（!goal 的文本，可任意长）、
     *    memory_bank（地点/箱子，随使用无限增长）、last_sender 等都是变量。
     *    只压 turns 的话，光 self_prompt 一条就能把文件顶爆。
     *
     * ③ **最后明确验证总量**：收尾再量一次，仍超限就继续退化（截断 → 丢最旧 turns →
     *    必要时清空可再生的文本），并把结果打日志。不允许"算完就假设它合格"。
     */
    capSize(data) {
        const LIMIT = 20 * 1024;
        /** 与落盘同一口径：UTF-8 字节数。 */
        const byteLen = (obj) => Buffer.byteLength(JSON.stringify(obj, null, 2), 'utf8');
        const out = { ...data };

        // ── 1) 各可变字段的独立预算（先各自收口，再谈总量）──────────────
        // memory：喂给模型的摘要，太长既没用又贵（保留开头：目标与地点通常在前半段）
        if (typeof out.memory === 'string' && out.memory.length > 4000) {
            out.memory = out.memory.slice(0, 4000) + '…（已截断）';
        }
        // self_prompt：!goal 的原文，没有长度上限（BOT-010 的实测爆点之一）
        if (typeof out.self_prompt === 'string' && out.self_prompt.length > 800) {
            out.self_prompt = out.self_prompt.slice(0, 800) + '…（已截断）';
        }
        // memory_bank：地点/箱子这类"事实"，随使用无限增长；按条数额度收口
        // ★ R4 §7-②：原来 `keys.slice(0, MAX_BANK)` 保留的是**最旧**的 120 条、
        //   把**最新**登记的地点/箱子扔掉 —— 而这正是最有用的那些（刚 !rememberHere 的坐标
        //   反而最先被淘汰，模型于是"刚记住就忘"）。改成保留**最新**登记的一批。
        if (out.memory_bank && typeof out.memory_bank === 'object') {
            const MAX_BANK = 120;
            const keys = Object.keys(out.memory_bank);
            if (keys.length > MAX_BANK) {
                const keep = new Set(keys.slice(-MAX_BANK));   // 最新的在后（插入序）
                const bank = {};
                for (const k of keys) if (keep.has(k)) bank[k] = out.memory_bank[k];
                out.memory_bank = bank;
                console.warn(`[memory] memory_bank 有 ${keys.length} 条，已保留最新 ${MAX_BANK} 条（旧的先淘汰）`);
            }
        }
        if (byteLen(out) <= LIMIT) return out;

        // ── 2) turns 从最旧的开始丢，直到进入预算（至少留 6 条，保证上下文连贯）──
        const turns = [...(out.turns || [])];
        const MIN_TURNS = 6;
        while (turns.length > MIN_TURNS && byteLen({ ...out, turns }) > LIMIT) {
            turns.shift();
        }
        // ── 3) 还超：把最旧的几条超长内容截断（先 500 字符，再 120 字符）──────
        for (const keep of [500, 120]) {
            let i = 0;
            while (byteLen({ ...out, turns }) > LIMIT && i < turns.length) {
                const t = turns[i];
                if (typeof t.content === 'string' && t.content.length > keep) {
                    turns[i] = { ...t, content: t.content.slice(0, keep) + '…（已截断）' };
                }
                i++;
            }
            if (byteLen({ ...out, turns }) <= LIMIT) break;
        }
        out.turns = turns;

        // ── 4) 最后明确验证总量：仍超限就退化可再生的文本（memory → self_prompt）──
        if (byteLen(out) > LIMIT && typeof out.memory === 'string' && out.memory.length > 0) {
            out.memory = '';
            console.warn('[memory] 预算仍超限：已清空 memory 文本（可从 turns/历史重建），保留地点与箱子等事实。');
        }
        if (byteLen(out) > LIMIT && typeof out.self_prompt === 'string' && out.self_prompt.length > 0) {
            out.self_prompt = out.self_prompt.slice(0, 200);
            console.warn('[memory] 预算仍超限：self_prompt 已截到 200 字符。');
        }
        // ── 5) 极端兜底：仍然超限就继续砍 turns，直到真的合格（不假设"应该够了"）
        while (turns.length > 1 && byteLen(out) > LIMIT) {
            turns.shift();
            out.turns = turns;
        }
        const finalBytes = byteLen(out);
        if (finalBytes > LIMIT) {
            // 到这一步说明数据本身有异常（比如某字段是超大对象），明确报出来而不是静默超标。
            console.error(`[memory] 无法压到 ${LIMIT} 字节以内：当前 ${finalBytes} 字节；`
                + '请检查 memory_bank / turns 里是否有异常大的字段。');
        }
        return out;
    }

    /**
     * 把损坏的 `memory.json` 改名留证（★ R6 #14）。
     *
     * 为什么是**改名**而不是删除：坏文件是证据（可能含用户手改的内容、或能看出是怎么坏的），
     * 与 `memory_store` / `board_store` 的 `.corrupt-<ts>` 口径一致。改名失败不抛，返回 null。
     *
     * @returns {string|null} 备份文件路径；没能留证时 null
     */
    _quarantineCorruptMemory() {
        const backup = `${this.memory_fp}.corrupt-${Date.now()}`;
        try {
            renameSync(this.memory_fp, backup);
            return backup;
        } catch (e) {
            console.error(`[memory] 备份坏文件失败（目标 ${backup}）: ${e?.message ?? e}`);
            return null;
        }
    }

    /**
     * 从损坏的 `memory.json` 里**尽力抢救**还能读出来的内容（★ R6 #14）。
     *
     * 为什么必须有这一步（队长复核意见）：`memory.json` 存的是**她的人物记忆** ——
     * 长期经验结论 + `!rememberHere` 记住的地点 / 箱子坐标。如果"坏文件 ⇒ 当没存过"
     * 就直接重建空记忆，等于**把用户攒了很久的记忆清零**，而且面板上完全看不出来
     * （比"起不来"更难发现）。所以顺序必须是：**先抢救，抢救不到才认输**，且认输要吵。
     *
     * 三层逐级降级（每层各自 try 包住，一层自己抛不影响下一层）：
     *   ① **结构修复**：文件被截断在某个 `}` 之后（写盘中断最常见的形态）
     *      ⇒ 截到最后一个 `}` 重解析，整份对象回来（记忆 + 地点 + 版本戳都在）；
     *   ② **单字段抢救**：正则取 `"memory"` 的 JSON 字符串字面量（`\\.` 转义原样还原）；
     *   ③ **结构块抢救**：从 `"memory_bank"` 的值起点做**大括号配平扫描**（字符串里的括号不计），
     *      取一个完整对象 —— 手改坏在文件尾部时，前半段的地点/箱子仍是好的。
     *
     * 抢救**不改变留证**：坏文件照样改名 `<file>.corrupt-<ts>`，证据永远在。
     *
     * @param {string} raw 坏文件原文
     * @returns {{data?:object, memory?:string, memory_bank?:object, via:string}|null}
     *          什么都没抢救出来时 null
     */
    _salvageFromCorruptMemory(raw) {
        if (typeof raw !== 'string' || raw.length === 0) return null;

        // ① 结构修复：截断在某个 `}` 之后 ⇒ 截到那里重解析
        const lastBrace = raw.lastIndexOf('}');
        if (lastBrace > 0) {
            try {
                const whole = JSON.parse(raw.slice(0, lastBrace + 1));
                if (whole && typeof whole === 'object' && !Array.isArray(whole)) {
                    return { data: whole, via: 'truncated-tail' };
                }
            } catch { /* 降级到字段抢救 */ }
        }

        const out = {};
        let found = false;

        // ② memory 正文（JSON 字符串字面量）
        try {
            const m = raw.match(/"memory"\s*:\s*"((?:[^"\\]|\\.)*)"/);
            if (m) {
                out.memory = JSON.parse(`"${m[1]}"`);
                found = true;
            }
        } catch { /* 忽略，继续抢救别的字段 */ }

        // ③ memory_bank（地点 / 箱子）：配平扫描，字符串里的 `{` `}` 不计
        try {
            const at = raw.search(/"memory_bank"\s*:\s*\{/);
            if (at >= 0) {
                const start = raw.indexOf('{', at);
                let depth = 0;
                let inStr = false;
                let esc = false;
                let end = -1;
                for (let i = start; i < raw.length; i++) {
                    const c = raw[i];
                    if (esc) { esc = false; continue; }
                    if (c === '\\') { if (inStr) esc = true; continue; }
                    if (c === '"') { inStr = !inStr; continue; }
                    if (inStr) continue;
                    if (c === '{') depth++;
                    else if (c === '}') { depth--; if (depth === 0) { end = i; break; } }
                }
                if (end > start) {
                    const bank = JSON.parse(raw.slice(start, end + 1));
                    if (bank && typeof bank === 'object' && !Array.isArray(bank)) {
                        out.memory_bank = bank;
                        found = true;
                    }
                }
            }
        } catch { /* 忽略 */ }

        return found ? { ...out, via: 'field-scan' } : null;
    }

    /**
     * 读取 `bots/<name>/memory.json`。
     *
     * ★ R6 #14（2026-11-10）：**坏文件不能让这只 bot 永久起不来，但也不许悄悄把记忆清零。**
     *
     *   缺陷原貌：`JSON.parse` 失败 → `catch { console.error; throw }` → `agent.start()` 抛
     *   → `init_agent` 兜底 `process.exit(1)` → `planExit` 判「起不足 10s 就退出」→ 退避重启
     *   → 连续 8 次后 `unregister` ⇒ **这只 bot 永久下线，只能人工删文件**。
     *   讽刺的是同一个文件里的全程记录写入早有 `FULL_HISTORY_CORRUPT` 自愈，这条更重要的路径反而没有。
     *
     *   现在的三级处理（**先抢救，再降级，最后才认输**）：
     *     ① 读不出来（EACCES 等）→ 不动文件、`return null` 让它继续启动
     *        （没有"文件坏了"的证据，也不该动别人的文件）；
     *     ② 解析失败 → **先 `_salvageFromCorruptMemory()` 抢救**：
     *        · 结构修复成功 ⇒ 整份记忆照常恢复（走下面的正常流程，含版本戳检查）
     *        · 只抢救出部分字段 ⇒ 用抢救结果建 `data`（`memory` / `memory_bank`），
     *          并**明说"代码版本无法确认"**（见下面分支里的注释）；
     *     ③ 一个字都抢救不出来 ⇒ 坏文件改名留证 + **吵闹地**报出去 + `return null`。
     *
     *   **产品语义（写清楚，别读成"静默修复"）**：如果最后落到 ③，这只 bot 会以
     *   "没有记忆"的状态起来（等价于新号），`memory.json` 由下一次 `save()` 重建；
     *   但坏文件**一定**留在 `memory.json.corrupt-<ts>`，人工修好后改名回去即可恢复 ——
     *   日志里点名了那个路径。这条路径**绝不静默**：console.error 会写清
     *   「抢救失败 / 留证在哪 / 会不会重建」，便于用户/面板判断"她的记忆是不是没了"。
     *
     * @returns {object|null} 记忆数据；文件不存在 / 读不出来 / 无法抢救时 null
     */
    load() {
        if (!existsSync(this.memory_fp)) {
            console.log('No memory file found.');
            return null;
        }

        let raw;
        try {
            raw = readFileSync(this.memory_fp, 'utf8');
        } catch (error) {
            // 读不出来 ≠ 文件坏了：不动它，按「没有记忆」继续（下一次 save 会重整这份文件）
            this.loadError = error;
            console.error(`[memory] 读取 ${this.memory_fp} 失败（按「没有记忆」继续启动，文件保持原样）: `
                + `${error?.message ?? error}`);
            return null;
        }

        let data = null;
        try {
            data = JSON.parse(raw);
            // 顶层不是对象（`null` / `"str"` / `[]`）与解析失败同等对待：
            // 后面 `data.memory` / `data.turns` 会直接 TypeError，症状一模一样。
            if (!data || typeof data !== 'object' || Array.isArray(data)) {
                const err = new Error('memory.json 的顶层不是 JSON 对象');
                err.code = 'MEMORY_CORRUPT';
                throw err;
            }
        } catch (error) {
            this.loadError = error;
            // ★ 无论抢救成败，先把坏文件改名留证（证据永远在，且不会被下一次 save 覆盖）
            this.corruptBackup = this._quarantineCorruptMemory();
            const backupNote = this.corruptBackup
                ? ` 原文件已留证: ${this.corruptBackup}（人工修好后改名回 memory.json 即可恢复）`
                : ' 原文件未能留证（改名失败，见上一行），请人工检查。';
            const why = `${this.memory_fp} 解析失败（${error?.message ?? error}）`;
            const salvaged = this._salvageFromCorruptMemory(raw);

            if (salvaged?.data) {
                // ① 结构修复：整份对象回来了 ⇒ 继续走正常流程（含版本戳检查）
                console.error(`[memory] ${why} ⇒ 已从坏文件**结构修复**整份记忆（方式 ${salvaged.via}），`
                    + '这只 bot 不会永久下线。' + backupNote);
                data = salvaged.data;
                this.recoveredFromCorrupt = true;
            } else if (salvaged) {
                // ② 只抢救出部分字段
                const got = [];
                if (typeof salvaged.memory === 'string') got.push('记忆摘要');
                if (salvaged.memory_bank && typeof salvaged.memory_bank === 'object') got.push('地点/箱子');
                console.error(`[memory] ${why} ⇒ 已从坏文件**部分抢救**出 ${got.join(' + ')}`
                    + `（方式 ${salvaged.via}），这只 bot 不会永久下线。` + backupNote
                    + '\n  ⚠ 代码版本戳无法确认（坏文件里读不出来）⇒ 这段记忆可能含旧版本的经验结论，'
                    + '已原样保留（宁可保留也不清零）；如结论明显不对，请人工核对上面那份留证文件。');
                const recovered = {
                    memory: typeof salvaged.memory === 'string' ? salvaged.memory : '',
                    memory_bank: salvaged.memory_bank && typeof salvaged.memory_bank === 'object'
                        ? salvaged.memory_bank : {},
                    // turns 是"最近几十条对话"，跨重启价值低，且坏文件里通常已截断 ⇒ 不抢救
                    turns: [],
                    self_prompt: null,
                    self_prompting_state: 'stopped',
                    self_prompt_author: null,
                    last_sender: null,
                    // 版本未知：写 0 会被下面的版本戳检查判"过时"而丢弃 memory
                    // ⇒ 这里直接返回，不落到那段检查上（理由见上面的日志）。
                    recoveredFromCorrupt: true,
                };
                this.recoveredFromCorrupt = true;
                this.memory = recovered.memory;
                this.turns = [];
                this.loadError = error;
                console.log('Loaded memory (partially recovered):', this.memory);
                return recovered;
            } else {
                // ③ 一个字都没抢救出来 ⇒ 认输，但**要吵**
                console.error(`[memory] ${why} ⇒ **抢救失败**（文件里没有可用的 memory / memory_bank 字段）。`
                    + ' 这只 bot 将以「没有记忆」的状态启动（等价新号），memory.json 会由下一次 save() 重建。'
                    + backupNote);
                return null;
            }
        }

        // 版本戳检查：关键判定逻辑改过之后，旧记忆里的「经验结论」不可信。
        // 只丢 memory 文本（里面混着「附近橡木多为建筑不可砍」这种基于 bug 的判断），
        // 保留 memory_bank（箱子/地点坐标，是事实，不受逻辑变化影响）。
        const savedVersion = Number(data.codeVersion ?? 0);
        if (savedVersion !== MEMORY_CODE_VERSION && data.memory) {
            console.log(`[memory] 代码版本变化（${savedVersion} → ${MEMORY_CODE_VERSION}），丢弃旧经验结论（保留地点/箱子）`);
            data.memory = '';
        }

        this.memory = data.memory || '';
        this.turns = Array.isArray(data.turns) ? data.turns : [];
        this.loadError = null;
        console.log('Loaded memory:', this.memory);
        return data;
    }

    clear() {
        this.turns = [];
        this.memory = '';
    }
}