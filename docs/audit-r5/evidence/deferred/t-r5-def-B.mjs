/**
 * t-r5-def-B —— R4 遗留条 B：13 个适配器未原生迁移，数字与"桥接层保证行为正确"是否仍成立？
 *
 * 三段：
 *   ① 盘点：src/models/*.js 里 19 个适配器，逐个判「原生返回 ModelResult」还是「返回裸字符串、
 *      由 prompter 侧 toModelResult 桥接」→ 表格 + 计数。
 *   ② 桥接语义：toModelResult 对 5 类输入（失败标记 / 截断标记 / 普通串 / 空串 / null）
 *      的归类，逐个打印 status / failed / truncated / content。
 *   ③ 对照实测：**真适配器、真调用、离线**（baseURL 指向 127.0.0.1:9，立刻 ECONNREFUSED）：
 *      · 未迁移代表 GPT（openai 系）：拿到的原始返回值是什么类型？
 *      · 原生代表 Ollama：拿到的返回值是什么类型？
 *      两者经各自路径后，status/failed/truncated 语义是否一致？
 *
 * 退出码：0 = 发现不一致（真缺陷）；1 = 一致（遗留表述仍成立）。
 */
import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(process.env.R5_MC || path.resolve(HERE, '../../../../mindcraft'));
const MODELS = path.join(ROOT, 'src/models');
const say = (...a) => console.log('[B]', ...a);
const url = (p) => pathToFileURL(p).href;

// ★ 必须在导入任何 models 之前切到仓库根：适配器用相对路径读 keys.json（cwd 相对）。
//   不切的话 GPT 会以 "API key not found" 构造失败，探针会得出错误的"不一致"（踩过）。
process.chdir(ROOT);

if (!fs.existsSync(MODELS)) { console.error('[B] CANNOT-RUN: no models dir'); process.exit(2); }

// ── ① 盘点 ──────────────────────────────────────────────────────────────────
const NON_ADAPTERS = new Set(['_model_map.js', '_shared.js', 'prompter.js', 'result.js']);
const files = fs.readdirSync(MODELS).filter((f) => f.endsWith('.js') && !NON_ADAPTERS.has(f)).sort();
const table = [];
for (const f of files) {
    const t = fs.readFileSync(path.join(MODELS, f), 'utf8');
    const native = /toModelResult\s*\(|new\s+ModelResult\s*\(/.test(t);
    table.push({ f, native });
}
const nativeList = table.filter((r) => r.native).map((r) => r.f.replace(/\.js$/, ''));
const bridgedList = table.filter((r) => !r.native).map((r) => r.f.replace(/\.js$/, ''));
say(`适配器总数 = ${table.length}；原生返回 ModelResult = ${nativeList.length}；走桥接 = ${bridgedList.length}`);
say('原生：', nativeList.join(', '));
say('桥接：', bridgedList.join(', '));

// ── ② 桥接语义 ──────────────────────────────────────────────────────────────
const result = await import(url(path.join(MODELS, 'result.js')));
const { toModelResult, STATUS } = result;
const shapes = [
    ['失败标记', '[LLM_ERROR] boom: 503'],
    ['截断标记', '正文[LLM_TRUNCATED]'],
    ['普通串', '正文'],
    ['空串', ''],
    ['null', null],
    ['ModelResult(原生)', new result.ModelResult({ status: STATUS.TRUNCATED, content: '原生截断' })],
];
const bridged = {};
say('桥接归类（toModelResult 对各类输入）：');
for (const [label, raw] of shapes) {
    const r = toModelResult(raw, { elapsedMs: 7 });
    const info = { status: r.status, failed: r.failed, truncated: r.truncated, content: r.content };
    bridged[label] = info;
    say(`  ${label.padEnd(18)} → ${JSON.stringify(info)}`);
}
/// 结构化截断（原生适配器把 finishReason 填进 meta）：靠字段判，不靠标记
const byFinish = toModelResult('正文', { finishReason: 'length' });
say('  finishReason=length   →', JSON.stringify({ status: byFinish.status, truncated: byFinish.truncated }));
bridged['结构化截断'] = { status: byFinish.status, truncated: byFinish.truncated };

// ── ③ 真适配器对照（离线：指向关闭的端口）────────────────────────────────────
const DEAD = 'http://127.0.0.1:9';
let gptRaw = null, ollamaRaw = null;
try {
    const { GPT } = await import(url(path.join(MODELS, 'gpt.js')));
    const g = new GPT('gpt-4o-mini', DEAD, {});
    gptRaw = await g.sendRequest([{ role: 'user', content: 'hi' }], 'sys', '***', {});
} catch (e) {
    say('GPT 驱动失败：', String(e?.message ?? e).slice(0, 120));
}
try {
    const { Ollama } = await import(url(path.join(MODELS, 'ollama.js')));
    const o = new Ollama('llama3', DEAD, {});
    ollamaRaw = await o.sendRequest([{ role: 'user', content: 'hi' }], 'sys', undefined, {});
} catch (e) {
    say('Ollama 驱动失败：', String(e?.message ?? e).slice(0, 120));
}

const rawKind = (v) => v == null ? String(v) : (v.constructor?.name ?? typeof v);
say('GPT  原始返回类型 =', rawKind(gptRaw), ' 值 =', JSON.stringify(String(gptRaw).slice(0, 70)));
say('Ollama 原始返回类型 =', rawKind(ollamaRaw), ' 值 =', JSON.stringify(String(ollamaRaw).slice(0, 70)));

// 未迁移适配器的原始串 → 走 prompter 实际用的那条桥
const gptBridged = toModelResult(gptRaw, { elapsedMs: 1 });
// 原生适配器已是 ModelResult → prompter 侧 toModelResult 会原样保留
const ollamaNative = toModelResult(ollamaRaw, { elapsedMs: 1 });
const cmp = (r) => ({ status: r.status, failed: r.failed, truncated: r.truncated, hasContent: r.hasContent, content: r.content });
const A = cmp(gptBridged), B = cmp(ollamaNative);
say('GPT(桥接后)   =', JSON.stringify(A));
say('Ollama(原生)  =', JSON.stringify(B));

const same = A.status === B.status && A.failed === B.failed && A.truncated === B.truncated
    && A.hasContent === B.hasContent && A.content === B.content;
say('两者语义一致：', same);

// ── 判定 ────────────────────────────────────────────────────────────────────
const countOk = bridgedList.length === 13;
say(`计数核对：未迁移 = ${bridgedList.length}（报告说 13）⇒ ${countOk ? '吻合' : '不吻合'}`);
say('截断识别：桥接靠 [LLM_TRUNCATED] 标记 / 原生靠 finishReason 字段 —— 两条都能到 truncated =',
    bridged['截断标记'].truncated && bridged['结构化截断'].truncated);

if (!same || !countOk) {
    say('Verdict=0 不一致：遗留表述需要更新（见上）');
    process.exit(0);
}
say('Verdict=1 遗留仍成立：13 个未迁移 + 桥接后语义与原生一致（至少 GPT↔Ollama 这一对）');
process.exit(1);
