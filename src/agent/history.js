import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'fs';
import { NPCData } from './npc/data.js';
import settings from './settings.js';

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
        this.memory_fp = `./bots/${this.name}/memory.json`;
        this.full_history_fp = undefined;

        mkdirSync(`./bots/${this.name}/histories`, { recursive: true });

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
    }

    getHistory() { // expects an Examples object
        return JSON.parse(JSON.stringify(this.turns));
    }

    async summarizeMemories(turns) {
        console.log("Storing memories...");
        this.memory = await this.agent.prompter.promptMemSaving(turns);

        if (this.memory.length > 1500) {
            this.memory = this.memory.slice(0, 1500);
            this.memory += '...(Memory truncated to 1500 chars. Compress it more next time)';
        }

        console.log("Memory updated to: ", this.memory);
    }

    async appendFullHistory(to_store) {
        if (this.full_history_fp === undefined) {
            const string_timestamp = new Date().toLocaleString().replace(/[/:]/g, '-').replace(/ /g, '').replace(/,/g, '_');
            this.full_history_fp = `./bots/${this.name}/histories/${string_timestamp}.json`;
            writeFileSync(this.full_history_fp, '[]', 'utf8');
        }
        try {
            const data = readFileSync(this.full_history_fp, 'utf8');
            let full_history = JSON.parse(data);
            full_history.push(...to_store);
            writeFileSync(this.full_history_fp, JSON.stringify(full_history, null, 4), 'utf8');
        } catch (err) {
            console.error(`Error reading ${this.name}'s full history file: ${err.message}`);
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

            await this.summarizeMemories(chunk);
            await this.appendFullHistory(chunk);
        }
    }

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
                taskStart: this.agent.task.taskStartTime,
                last_sender: this.agent.last_sender,
                // 结构化的"记住的地点"（!rememberHere 存的坐标）。
                // 不加这一项的话，这些坐标只存在内存里，一重启就全丢。
                memory_bank: this.agent.memory_bank ? this.agent.memory_bank.getJson() : {},
            };
            writeFileSync(this.memory_fp, JSON.stringify(this.capSize(data), null, 2));
            console.log('Saved memory to:', this.memory_fp);
        } catch (error) {
            console.error('Failed to save history:', error);
            throw error;
        }
    }

    /**
     * memory.json 的硬上限（方案 §B6：上限 20 KB，超了按时间淘汰，不靠模型自觉）。
     *
     * 之前只靠 max_messages 控制条数，但单条可以很长（她一次写进几百行代码），
     * 实测 28 条就到 14 KB。这里按字符预算从旧到新丢弃，并给 memory 文本也设上限。
     */
    capSize(data) {
        const LIMIT = 20 * 1024;
        const out = { ...data };

        // 1) memory 文本先截到 4000 字符（保留开头：目标与地点通常在前半段）。
        //    这条独立于总大小：memory 是喂给模型的摘要，太长既没用又贵。
        if (typeof out.memory === 'string' && out.memory.length > 4000) {
            out.memory = out.memory.slice(0, 4000) + '…（已截断）';
        }
        if (JSON.stringify(out, null, 2).length <= LIMIT) return out;

        // 2) turns 从最旧的开始丢，直到进入预算（至少留 6 条，保证上下文连贯）
        const turns = [...(out.turns || [])];
        const MIN_TURNS = 6;
        while (turns.length > MIN_TURNS && JSON.stringify({ ...out, turns }, null, 2).length > LIMIT) {
            turns.shift();
        }
        // 3) 还超：把最旧的几条超长内容截断（只保留前 500 字符）
        let i = 0;
        while (JSON.stringify({ ...out, turns }, null, 2).length > LIMIT && i < turns.length) {
            const t = turns[i];
            if (typeof t.content === 'string' && t.content.length > 500) {
                turns[i] = { ...t, content: t.content.slice(0, 500) + '…（已截断）' };
            }
            i++;
        }
        out.turns = turns;
        return out;
    }

    load() {
        try {
            if (!existsSync(this.memory_fp)) {
                console.log('No memory file found.');
                return null;
            }
            const data = JSON.parse(readFileSync(this.memory_fp, 'utf8'));

            // 版本戳检查：关键判定逻辑改过之后，旧记忆里的「经验结论」不可信。
            // 只丢 memory 文本（里面混着「附近橡木多为建筑不可砍」这种基于 bug 的判断），
            // 保留 memory_bank（箱子/地点坐标，是事实，不受逻辑变化影响）。
            const savedVersion = Number(data.codeVersion ?? 0);
            if (savedVersion !== MEMORY_CODE_VERSION && data.memory) {
                console.log(`[memory] 代码版本变化（${savedVersion} → ${MEMORY_CODE_VERSION}），丢弃旧经验结论（保留地点/箱子）`);
                data.memory = '';
            }

            this.memory = data.memory || '';
            this.turns = data.turns || [];
            console.log('Loaded memory:', this.memory);
            return data;
        } catch (error) {
            console.error('Failed to load history:', error);
            throw error;
        }
    }

    clear() {
        this.turns = [];
        this.memory = '';
    }
}