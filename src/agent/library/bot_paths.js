/**
 * 每只 bot 的磁盘路径 —— **唯一真相**。
 *
 * ═══════════════════════════════════════════════════════════════════
 * 为什么要有这个文件（2026-11-02）
 *
 * 同一个 map 目录拼接原来抄了 **11 遍**：
 *   `./bots/${bot.username || bot.entity?.name || 'agent'}/map`
 * 分布在 `commands/actions.js`（6 处）、`skills.js`（2 处）、
 * `mindserver_proxy.js`（2 处）、`map_query.js`（1 处）。
 * 谁改一次目录结构，就得改 11 个地方 —— 漏一个就是"她的记忆突然找不到了"。
 *
 * 这正是本项目反复出问题的根源（mode 列表三套、垫脚块四处、站立判据两份、
 * y 语义混用、斜杠白名单两张）。所以收到这里一份。
 *
 * ═══════════════════════════════════════════════════════════════════
 * 为什么不放进 `composite_registry.js`（那里原本有一个 `mapDirOf`）：
 * `composite_registry` 显式 import 了 `flow_collect` / `flow_follow` / …，
 * 而这些流程又会 import `skills.js`；如果 `skills.js` 反过来 import
 * `composite_registry`，就是**循环依赖**。所以下沉到本文件（零依赖）。
 *
 * 本文件属下表中的"**不带前缀 = 基础设施**"（02 §5），
 * 与 `contract` / `step_runner` / `trace_bus` / `terrain3d` 同级。
 */

/**
 * 取 bot 的名字。三层兜底沿用原写法，不要改语义：
 * `username`（已登录） → `entity.name`（登录瞬间可能还没有 username） → `'agent'`。
 */
function botNameOf(agentOrBot) {
    const bot = agentOrBot?.bot ?? agentOrBot;
    return bot?.username || bot?.entity?.name || 'agent';
}

/**
 * 该 bot 的地形库目录（terrain3d / path_3d / scanSphere 都用它）。
 *
 * @param {object} agentOrBot Agent 实例（带 `.bot`）或 bot 本身
 * @returns {string} 形如 `./bots/HEAVENZEH/map`
 */
export function mapDirOf(agentOrBot) {
    return `./bots/${botNameOf(agentOrBot)}/map`;
}

/**
 * 该 bot 的数据根目录（记忆、历史、日志都挂在它下面）。
 *
 * @param {object} agentOrBot Agent 实例或 bot
 * @returns {string} 形如 `./bots/HEAVENZEH`
 */
export function botDirOf(agentOrBot) {
    return `./bots/${botNameOf(agentOrBot)}`;
}

/**
 * 任务板库目录（**全系统同一个板库，不属于任何一只 bot**）。
 *
 * 为什么是 `bots/_board`：06 §3 定的位置。下划线开头表示"不是某只 bot 的名字"，
 * 免得跟 `bots/<botName>/` 混。加这个函数是为了不让板库路径散落成第三处
 * （前面已经有 mapDir 抄 11 遍、mode 列表三套的教训）。
 *
 * @returns {string} 形如 `./bots/_board`
 */
export function boardDirOf() {
    return './bots/_board';
}

export { botNameOf };
