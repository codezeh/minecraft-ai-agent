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
 * **bots 根目录** —— 所有 `bots/<name>/…` 的共同前缀，**唯一可取处**。
 *
 * ★★★ 为什么需要它（2026-11-05，T17）：测试并发跑时会**互删对方的地标文件**。
 *   现场：`atom_classify_unit` 三路并行 —— 单跑 6/6 绿，三路并行时
 *   `写入=true/true` 但读回 `A=[] B=[]`（或读到别人的）。
 *   根因：所有测试都把地标写进**同一个** `bots/<agent>/memory/*.json`，
 *   而每个测试开跑先 `rmSync('bots/<agent>')` —— 三个进程互相删。
 *
 *   正解不是改目录结构，而是让**每个进程能有自己的 bots 根**：
 *   `MC_BOTS_ROOT=<临时目录>` 即可（测试用 `mkdtempSync` 指过去）。
 *   生产不设这个变量，行为与以前**逐字节一致**（默认仍是 `./bots`）。
 *
 * @returns {string} 形如 `./bots`，或 `MC_BOTS_ROOT` 给的值
 */
export function botsRootOf() {
    const override = process.env.MC_BOTS_ROOT;
    if (typeof override === 'string' && override.trim()) return override.trim();
    return './bots';
}

/** 该 bot 的地形库目录（terrain3d / path_3d / scanSphere 都用它）。
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
    return `${botsRootOf()}/${botNameOf(agentOrBot)}/map`;
}

/**
 * 该 bot 的数据根目录（记忆、历史、日志都挂在它下面）。
 *
 * @param {object} agentOrBot Agent 实例或 bot
 * @returns {string} 形如 `./bots/HEAVENZEH`
 */
export function botDirOf(agentOrBot) {
    return `${botsRootOf()}/${botNameOf(agentOrBot)}`;
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
    return `${botsRootOf()}/_board`;
}

export { botNameOf };
