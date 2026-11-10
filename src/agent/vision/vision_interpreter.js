import { Vec3 } from 'vec3';
import { Camera } from "./camera.js";
// 2026-11-01（t6）：转头/看坐标改走输入原子（bot.look* 的唯一出口）。
import { setLook, lookAtPoint } from "../library/atom_input_mouse.js";
import fs from 'fs';
// R4 §7-⑤：`[LLM_ERROR]` 失败标记的判别（模型层契约）
// ★ t21（缺口 C）：除失败标记外，截断/无代码标记同样不许进上下文
import {
    isFailedReply, isTruncatedReply, isNoCodeReply,
    FAILED_REPLY, TRUNCATED_SUFFIX, NO_CODE_PREFIX,
} from "../../models/_shared.js";
// ★ t21（缺口 C 根治点）：视觉结果现在带类型 —— 必须**读 status**，不能只当字符串用
import { STATUS } from "../../models/result.js";

/**
 * ★ R6 #12：把「当前操作」折算成模型调用要的取消三件套 `{signal, deadline, operationId}`。
 *
 * 唯一取消源是 `ActionManager._executeAction` 建好并挂到 `agent.currentOperation`
 * 的那个 operation（`{ id, deadline, ac }`）。看图最贵也最慢（一次视觉调用最长 120s），
 * 而调用点以前只传 `(messages, imageBuffer)` ⇒ `prompter._callOptions({})` 得到
 * `signal=null` ⇒ `!stop` 之后这张图照样要"看完"。
 *
 * 没有在飞的操作时返回 `{}`：与接线前的缺省逐字一致。
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

export class VisionInterpreter {
    constructor(agent, allow_vision) {
        this.agent = agent;
        this.allow_vision = allow_vision;
        this.fp = './bots/'+agent.name+'/screenshots/';
        if (allow_vision) {
            this.camera = new Camera(agent.bot, this.fp);
        }
    }

    async lookAtPlayer(player_name, direction) {
        if (!this.allow_vision || !this.agent.prompter.vision_model.sendVisionRequest) {
            return "Vision is disabled. Use other methods to describe the environment.";
        }
        let result = "";
        const bot = this.agent.bot;
        const player = bot.players[player_name]?.entity;
        if (!player) {
            return `Could not find player ${player_name}`;
        }

        let filename;
        if (direction === 'with') {
            // 原来 bot.look(yaw, pitch)（force 默认 false）；setLook 默认 force=true，这里显式给 false 保持一致
            await setLook(bot, player.yaw, player.pitch, { force: false });
            result = `Looking in the same direction as ${player_name}\n`;
            filename = await this.camera.capture();
        } else {
            await lookAtPoint(bot, {
                x: player.position.x,
                y: player.position.y + player.height,
                z: player.position.z,
            }, { force: false });
            result = `Looking at player ${player_name}\n`;
            filename = await this.camera.capture();

        }

        return this._withAnalysis(result, await this.analyzeImage(filename));
    }

    async lookAtPosition(x, y, z) {
        if (!this.allow_vision || !this.agent.prompter.vision_model.sendVisionRequest) {
            return "Vision is disabled. Use other methods to describe the environment.";
        }
        let result = "";
        const bot = this.agent.bot;
        await lookAtPoint(bot, { x, y: y + 2, z }, { force: false });
        result = `Looking at coordinate ${x}, ${y}, ${z}\n`;

        let filename = await this.camera.capture();

        return this._withAnalysis(result, await this.analyzeImage(filename));
    }

    getCenterBlockInfo() {
        const bot = this.agent.bot;
        const maxDistance = 128; // Maximum distance to check for blocks
        const targetBlock = bot.blockAtCursor(maxDistance);
        
        if (targetBlock) {
            return `Block at center view: ${targetBlock.name} at (${targetBlock.position.x}, ${targetBlock.position.y}, ${targetBlock.position.z})`;
        } else {
            return "No block in center view";
        }
    }

    async analyzeImage(filename) {
        try {
            const imageBuffer = fs.readFileSync(`${this.fp}/${filename}.jpg`);
            const messages = this.agent.history.getHistory();

            const blockInfo = this.getCenterBlockInfo();
            // ★ R4 §7-⑤ + t21（缺口 C）：只有**可信正文**才拼进"图像分析"进上下文；
            //   失败/截断/取消一律 null，由调用方整段省略（宁可不给视觉结论，
            //   也不给一句假的/半截的/带内部标记的结论）。
            const analysis = await this._visionAnalysis(messages, imageBuffer);
            if (analysis === null) return null;
            return `${analysis}\n${blockInfo}`;
        } catch (error) {
            console.warn('Error reading image:', error);
            return null;   // 同上：错误文本不进上下文
        }
    }

    /**
     * 取一次视觉分析的**正文**。拿不到可信正文就返回 `null`（绝不返回标记或半截文本）。
     *
     * t2 把模型结果做成 `ModelResult`（`status` + `content`），并留了这个"步 1：读 status"
     * 的消费点给视觉链路。这里的顺序：
     *   ① **优先调带类型的新出口** `promptVisionResult()` —— `status === 'ok'` 才用 `content`；
     *      `truncated`（半截）/`error`/`cancelled`/`timeout` 一律不用（缺口 C 的根治点）。
     *   ② 兼容期退回旧字符串出口 `promptVision()`，但必须过 `isFailedReply()` /
     *      `isTruncatedReply()` 判断后再用（旧出口的标记语义见 `models/_shared.js`）。
     * 两条路径最后都过 `_cleanAnalysis()`：任何内部标记都不许流到 `_withAnalysis()`。
     */
    async _visionAnalysis(messages, imageBuffer) {
        const prompter = this.agent?.prompter;
        const tag = this.agent?.name ?? '?';

        if (typeof prompter?.promptVisionResult === 'function') {
            // ★ R6 #12：第 3 参 opts 接上取消链；取消时 status=cancelled ⇒ 下面按
            //   `status !== ok` 丢弃，不写上下文（用法不变，只是"停得下来"了）。
            const r = await prompter.promptVisionResult(messages, imageBuffer, operationCallOpts(this.agent));
            if (r && typeof r === 'object' && typeof r.status === 'string') {
                if (r.status !== STATUS.OK) {
                    console.warn(`[vision] ${tag} 视觉结果 status=${r.status}（${r.errorCode ?? '-'}），`
                        + `不写进上下文: ${String(r.errorMessage ?? '').slice(0, 120)}`);
                    return null;
                }
                return this._cleanAnalysis(r.content);
            }
            // 拿到了但不是带类型的结果 ⇒ 落到旧字符串路径（仍要过标记判断）
        }

        const raw = await prompter.promptVision(messages, imageBuffer, operationCallOpts(this.agent));
        return this._cleanAnalysis(raw);
    }

    /**
     * 视觉分析字符串兜底净化（暂替 t21 收口前的行为，保住旧出口的安全语义）。
     * 判别顺序：失败/截断/无代码 ⇒ 不可用；正文里夹带内部标记 ⇒ 同样不可用。
     */
    _cleanAnalysis(value) {
        if (typeof value !== 'string') return null;
        const text = value.trim();
        if (!text) return null;
        if (isFailedReply(text) || isTruncatedReply(text) || isNoCodeReply(text) || this._containsMarker(text)) {
            console.warn(`[vision] ${this.agent?.name ?? '?'} 视觉结果带内部标记/不可用，整段丢弃（不进上下文）`);
            return null;
        }
        return text;
    }

    /** 这段文本里是否夹带着模型层的内部标记（任一命中都算不可用）。 */
    _containsMarker(text) {
        return [FAILED_REPLY, TRUNCATED_SUFFIX, NO_CODE_PREFIX].some((m) => text.includes(m));
    }

    /**
     * 把「图像分析」拼成一句可进上下文的文本。
     *
     * 分析失败/截断（null）时**整段省略**，只留"看哪儿"的事实 ——
     * 宁可不给视觉结论，也不给一句假的/半截的结论。
     * ★ t21：这里是最后一关 —— 即便上游漏了净化，带内部标记的正文也不许被拼出去。
     */
    _withAnalysis(head, analysis) {
        if (typeof analysis !== 'string' || !analysis.trim()) return head;
        if (this._containsMarker(analysis)) return head;
        return `${head}Image analysis: "${analysis}"`;
    }
}