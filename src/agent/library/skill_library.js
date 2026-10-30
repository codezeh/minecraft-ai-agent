import { cosineSimilarity } from '../../utils/math.js';
import { getSkillDocs } from './index.js';
import { wordOverlapScore } from '../../utils/text.js';
import { reportSkillDocs } from '../../utils/skill_doc_check.js';

// 目录里每条技能摘要保留的字符数。够模型判断「这个函数是干这个的」即可，
// 详细参数/返回值/示例走 !skillDoc 按需取。
const SUMMARY_MAX = 100;

/**
 * 技能库：渐进披露（progressive disclosure）
 *
 * 参考 Agent Skills 规范的三层加载（https://agentskills.io/specification）：
 *   第 1 层 目录：只给 name + 一句话描述，几十个技能也只有几 KB；
 *   第 2 层 说明：模型真正要用时，用 !skillDoc("skills.foo") 取完整 JSDoc；
 *   第 3 层 资源：本项目的技能是函数，没有附加脚本/资源文件，这层不适用。
 *
 * 为什么不全部塞进 prompt：实测 87 个技能文档共 45k 字符，其中 always_show
 * 的 34 个就占 22.5k 字符，每次 !newAction 都要重复付一遍 token；而剩下 38 个
 * 技能模型根本看不见，只能瞎猜或自己拼循环。
 */
export class SkillLibrary {
    constructor(agent,embedding_model) {
        this.agent = agent;
        this.embedding_model = embedding_model;
        this.skill_docs_embeddings = {};
        this.skill_docs = null;
        this.skill_index = [];   // [{name, summary, doc}]

        // 只有「不看完整文档就一定会用错、而且用错代价大」的函数才全量注入。
        // 其余一律走目录 + 按需加载。判断标准：误用会造成破坏性后果或死循环。
        this.always_show_skills = [
            'skills.placeBlockWithoutBreaking', // 安全放置：绝不拆方块
            'skills.breakBlockAt',              // 破坏性：文档里带警告
            'skills.wait',                      // 等待，防止轮询空转
            'skills.surveyInventory',           // 干活前先看清自己有什么
            'skills.reportStatus',              // 如实汇报，别猜
            'skills.makeRoomForBot',            // 卡住时自己挖开，别死等
            'skills.surveyArea',                // 先探地形：3D 扫球 + ASCII 图
            'skills.planRoute',                 // 先规划后行动：只算下一段，不动身
            'skills.ensureNearbyBlock',         // 找/放工作台或熔炉（失败会说清断在哪步）
            'skills.checkItems',                // 动手前先确认身上材料够不够
            'skills.waitUntil',                 // 等条件成立（带超时），别自己写轮询
        ];

    }
    async initSkillLibrary() {
        const skillDocs = getSkillDocs();
        this.skill_docs = skillDocs;

        // 建索引：第一行是 skills.foo，后面正文取第一句做摘要
        this.skill_index = skillDocs.map(doc => {
            const lines = doc.split('\n');
            const name = lines[0].trim();
            // docHelper 是把 /** 之后的内容原样截出来的，所以每行开头带 "*"，
            // 末尾还有一堆 @param/@returns。做目录时只留人话描述。
            const body = lines.slice(1)
                .map(l => l.replace(/^\s*\*+\s?/, '').trim())
                .filter(l => l && !l.startsWith('@'))
                .join(' ')
                .replace(/\s+/g, ' ')
                .trim();
            return { name, summary: summarize(body), doc };
        });

        if (this.embedding_model) {
            try {
                const embeddingPromises = this.skill_index.map((entry) => {
                    return (async () => {
                        this.skill_docs_embeddings[entry.doc] = await this.embedding_model.embed(`${entry.name} ${entry.summary}`);
                    })();
                });
                await Promise.all(embeddingPromises);
            } catch (error) {
                console.warn('Error with embedding model, using word-overlap instead.');
                this.embedding_model = null;
            }
        }
        else {
            // 没有 embedding 时用词重叠兜底
            for (const entry of this.skill_index) {
                this.skill_docs_embeddings[entry.doc] = `${entry.name} ${entry.summary}`;
            }
        }

        this.always_show_skills_docs = {};
        for (const skillName of this.always_show_skills) {
            // 必须用「文档第一行精确匹配」。
            // 原来的 doc.includes(skillName) 会串味：
            // "skills.placeBlock" 是 "skills.placeBlockWithoutBreaking" 的前缀，
            // find() 会返回 placeBlock 的文档，导致配置了却选到错的那个。
            const found = this.skill_index.find(e => e.name === skillName)?.doc;
            this.always_show_skills_docs[skillName] = found;
            if (!found) {
                console.warn(`[skill_library] always_show_skills 里找不到文档: ${skillName}`);
            }
        }

        // 启动自检：找出"被代码用到、但文档写在函数上方所以模型看不见"的技能。
        // 约定反直觉（docHelper 用 toString()），靠人记会反复踩，所以让程序每次启动查一遍。
        this.docReport = reportSkillDocs(skillDocs);
    }

    async getAllSkillDocs() {
        return this.skill_docs;
    }

    /** 全量技能目录：name + 一句话说明。给模型判断「有没有现成函数可用」。 */
    getSkillCatalog() {
        if (!this.skill_index.length)
            return '';
        let out = '';
        for (const entry of this.skill_index) {
            out += `- ${entry.name} — ${entry.summary}\n`;
        }
        return out;
    }

    /** 按名字取完整文档（给 !skillDoc 命令用）。找不到时返回相近候选。 */
    getSkillDoc(name) {
        if (!name) return null;
        const wanted = String(name).trim();
        const exact = this.skill_index.find(e => e.name === wanted)
            || this.skill_index.find(e => e.name.toLowerCase() === wanted.toLowerCase());
        if (exact) return exact.doc;

        // 允许省略 skills./world. 前缀
        const withPrefix = this.skill_index.find(e => e.name.endsWith(`.${wanted}`));
        if (withPrefix) return withPrefix.doc;

        const suggestions = this.searchSkillNames(wanted, 5);
        return suggestions.length
            ? `没有找到 ${wanted}。你是不是想找：${suggestions.join(', ')}（用 !skillDoc("名字") 取文档）`
            : `没有找到 ${wanted}。用目录里出现过的完整名字，例如 skills.buildHouse。`;
    }

    /** 模糊找名字，给「你是不是想找…」用。 */
    searchSkillNames(query, limit = 5) {
        const q = String(query).toLowerCase();
        const words = q.split(/[^a-z0-9]+/).filter(w => w.length > 2);
        const scored = this.skill_index.map(e => {
            let score = 0;
            if (e.name.toLowerCase().includes(q)) score += 10;
            for (const w of words)
                if (e.name.toLowerCase().includes(w)) score += 2;
            return { name: e.name, score };
        }).filter(x => x.score > 0).sort((a, b) => b.score - a.score);
        return scored.slice(0, limit).map(x => x.name);
    }

    async getRelevantSkillDocs(message, select_num) {
        if(!message) // use filler message if none is provided
            message = '(no message)';

        // 1) 按相关度挑少量文档全量注入
        let ranked;
        if (select_num === -1 || !this.skill_index.length) {
            ranked = this.skill_index.map(e => e.doc);
        }
        else if (!this.embedding_model) {
            ranked = this.skill_index
                .map(e => ({ doc: e.doc, similarity_score: wordOverlapScore(message, this.skill_docs_embeddings[e.doc]) }))
                .sort((a, b) => b.similarity_score - a.similarity_score)
                .map(x => x.doc);
        }
        else {
            let latest_message_embedding = await this.embedding_model.embed(message);
            ranked = this.skill_index
                .map(e => ({ doc: e.doc, similarity_score: cosineSimilarity(latest_message_embedding, this.skill_docs_embeddings[e.doc]) }))
                .sort((a, b) => b.similarity_score - a.similarity_score)
                .map(x => x.doc);
        }

        let length = ranked.length;
        let limit = select_num === -1 ? length : Math.min(select_num, length);
        const selected_docs = new Set(ranked.slice(0, limit));
        Object.values(this.always_show_skills_docs).forEach(doc => {
            if (doc) selected_docs.add(doc);
        });

        // 2) 目录始终给全量，模型才知道还有什么函数存在
        let out = '#### SKILL CATALOG\n';
        out += 'Every function you may call in !newAction is listed below (name — what it does).\n';
        out += 'Prefer these existing functions over writing your own loops.\n';
        out += this.getSkillCatalog();
        out += '\n#### FULL DOCS (most relevant to this task)\n';
        out += Array.from(selected_docs).join('\n### ');
        out += '\n#### HOW TO USE\n';
        out += '- The catalog above is the complete list. Only the most relevant functions have full docs printed here.\n';
        out += '- If you need exact parameters/return value/examples for a function, call !skillDoc("skills.theName") first, then !newAction.\n';
        out += '- Do not invent function names. If a function is not in the catalog, it does not exist.\n';

        console.log('Selected skill docs:', Array.from(selected_docs).map(doc => {
            const first_line_break = doc.indexOf('\n');
            return first_line_break > 0 ? doc.substring(0, first_line_break) : doc;
        }));
        return out;
    }
}

/** 取正文第一句做摘要，过长截断。 */
function summarize(body) {
    if (!body) return '';
    // 中文句号/英文句号/分号都可以断句
    const m = body.match(/^.{0,100}?(?:[。；;]|\.(?:\s|$))/);
    let text = m ? m[0] : body.slice(0, SUMMARY_MAX);
    // 去掉可能混进来的 JSDoc 标记
    text = text.replace(/@\w+/g, '').replace(/\s+/g, ' ').trim();
    if (text.length > SUMMARY_MAX) text = text.slice(0, SUMMARY_MAX).trim() + '…';
    return text;
}
