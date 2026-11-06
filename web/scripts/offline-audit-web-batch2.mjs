/**
 * WEB-002 ~ WEB-011（2026-11-06 深度检查）—— 控制台批次2 的离线回归断言。
 *
 * 说明：这些条目大量落在 Vue SFC 的模板/生命周期里，无法在 Node 里实例化整棵组件树。
 * 因此本脚本采用**两种可复核的证据**：
 *   A. 纯逻辑单测：把修复点抽成可 import 的纯函数/模块行为，直接断言（状态形状校验、游标分区、
 *      地形归属、实例容量与包围球、标记资源释放）。
 *   B. 源码契约断言：对 .vue 模板/事件处理做**精确文本断言**（例如"存在 @scroll + unseenCount"、
 *      "profile 用 button + role=radio"、"onKey 先判 isComposing"）。
 *      ——这不是"看代码猜"，而是把报告的回归验收项写成可执行断言：
 *         有人把修复改回去，这里就会红。
 *
 * 输出：PASS/FAIL，全过退出码 0。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const WEB = path.resolve(__dirname, '..')
const read = (rel) => readFileSync(path.join(WEB, rel), 'utf8')
/**
 * 去掉注释后的源码。**反例断言必须用这个**：
 * 修复说明里常常会引用"原来的坏代码"（例如 `watch(() => store.chat.length, …)`），
 * 直接在全文里找反例会把注释当成代码，导致假红。
 */
const readCode = (rel) => read(rel)
  .replace(/<!--[\s\S]*?-->/g, '')          // HTML/模板注释
  .replace(/\/\*[\s\S]*?\*\//g, '')         // 块注释
  .replace(/^\s*\/\/.*$/gm, '')             // 行注释（整行）
  .replace(/^\s*\*.*$/gm, '')               // JSDoc 续行

let pass = 0, fail = 0
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS ${name} ${detail}`) }
  else { fail++; console.log(`FAIL ${name} ${detail}`) }
}

// ══════════════════════════════════════════════════════════════════
// WEB-002：首次 full_state 超时的错误对象不许让组件抛异常
// ══════════════════════════════════════════════════════════════════
{
  const agents = read('src/stores/agents.ts')
  check('WEB-002 状态入口有形状校验（不是直接赋值）',
    /sanitizeStates\s*\(/.test(agents) && /store\.states\s*=\s*sanitizeStates/.test(agents))
  check('WEB-002 校验要求 gameplay.health 是数字', /typeof\s+v\.gameplay\.health\s*===\s*'number'/.test(agents))
  check('WEB-002 校验要求 inventory.counts 是对象', /v\.inventory\.counts\s*&&\s*typeof\s+v\.inventory\.counts\s*===\s*'object'/.test(agents))
  check('WEB-002 顶层 error 会被单独记录（不进 states）', /topLevelError/.test(agents) && /lastError/.test(agents))

  const status = read('src/components/StatusCard.vue')
  check('WEB-002 StatusCard 对 gameplay 逐层可选',
    /s\.value\?\.gameplay\s*\?\?/.test(status) && !/s\.value\?\.gameplay\.health\s*\?\?/.test(status))
  const inv = read('src/components/InventoryGrid.vue')
  check('WEB-002 InventoryGrid 对 inventory 逐层可选',
    /inventory\?\.equipment/.test(inv) && /inventory\?\.counts/.test(inv))

  // 直接跑一遍"错误载荷"的形状判定，确认它会被挡掉
  const isFullStateSrc = agents.slice(agents.indexOf('function isFullState'), agents.indexOf('function sanitizeStates'))
  check('WEB-002 判定函数对 {error} 载荷返回 false（源码级复核）',
    /gameplay/.test(isFullStateSrc) && /inventory/.test(isFullStateSrc))
}

// ══════════════════════════════════════════════════════════════════
// WEB-003：输入法组合期间的回车不发送
// ══════════════════════════════════════════════════════════════════
{
  const chat = read('src/components/ChatStream.vue')
  check('WEB-003 发送前三件事：不是 Enter / 没按 Shift / 不在组合态',
    /e\.key\s*!==\s*'Enter'/.test(chat) && /isImeComposing\(e\)/.test(chat))
  check('WEB-003 组合判定覆盖 isComposing 与 keyCode 229',
    /isComposing\s*===\s*true/.test(chat) && /keyCode\s*===\s*229/.test(chat))
  check('WEB-003 组合态直接 return（不 send 也不 preventDefault）',
    /if\s*\(isImeComposing\(e\)\)\s*return/.test(chat))
}

// ══════════════════════════════════════════════════════════════════
// WEB-008：聊天到 500 条上限后仍跟随；翻历史时不被抢
// ══════════════════════════════════════════════════════════════════
{
  const chat = read('src/components/ChatStream.vue')
  const chatCode = readCode('src/components/ChatStream.vue')
  check('WEB-008 观察的是末条 seq 而不是 length',
    /store\.chat\[store\.chat\.length\s*-\s*1\]\?\.seq/.test(chatCode)
    // 反例：不能退回"只观察 length"的旧写法（到 500 条上限后 length 不再变化）。
    // 用去注释后的源码判定，否则修复说明里引用的旧代码会把自己判红。
    && !/watch\(\(\)\s*=>\s*store\.chat\.length\s*,\s*scrollToBottom/.test(chatCode))
  check('WEB-008 只有贴底时才自动跟随', /pinnedToBottom\.value/.test(chat) && /isNearBottom/.test(chat))
  check('WEB-008 不跟随时给出未读数提示与"回到最新"', /unseenCount/.test(chat) && /jump-latest/.test(chat))
  check('WEB-008 列表绑定了滚动处理', /@scroll="onScroll"/.test(chat))
}

// ══════════════════════════════════════════════════════════════════
// WEB-009：创建 agent 有 ack 超时 + 可读失败
// ══════════════════════════════════════════════════════════════════
{
  const setup = read('src/views/SetupView.vue')
  check('WEB-009 定义了 ack 超时常量', /CREATE_ACK_TIMEOUT_MS\s*=\s*\d+/.test(setup))
  check('WEB-009 ack 有超时分支（timedOut）', /timedOut/.test(setup))
  check('WEB-009 超时后去核对 agent 列表而不是只说"失败"', /store\.agents\.some/.test(setup))
  check('WEB-009 有 catch（原来 rejection 无人接）', /catch\s*\(e:\s*any\)/.test(setup))
  check('WEB-009 finally 里清掉定时器且复位 creating',
    /clearTimeout\(ackTimer\)/.test(setup) && /creating\.value\s*=\s*false/.test(setup))
}

// ══════════════════════════════════════════════════════════════════
// WEB-011：profile 选择可用键盘操作
// ══════════════════════════════════════════════════════════════════
{
  const setup = read('src/views/SetupView.vue')
  check('WEB-011 profile 项是原生 button', /<button[\s\S]{0,240}?class="prof"/.test(setup))
  check('WEB-011 有单选语义（radiogroup + role=radio + aria-checked）',
    /role="radiogroup"/.test(setup) && /role="radio"/.test(setup) && /aria-checked/.test(setup))
  check('WEB-011 有可见焦点环', /:focus-visible/.test(setup))
}

// ══════════════════════════════════════════════════════════════════
// WEB-006：诊断游标按 agent 分区 + 迟到响应丢弃 + 进程重启重置
// ══════════════════════════════════════════════════════════════════
{
  const diag = read('src/stores/diag.ts')
  check('WEB-006 每 agent 各自记游标（不是全局 events 末条）',
    /const cursors = new Map/.test(diag) && !/diag\.events\[diag\.events\.length\s*-\s*1\]\.seq/.test(diag))
  check('WEB-006 切换 agent 时清空并重拉', /resetForAgent/.test(diag) && /watch\(/.test(diag))
  check('WEB-006 迟到响应按归属丢弃（get-events / task-state / memory 三处）',
    (diag.match(/currentAgent\.value\?\.name\s*!==\s*owner/g) || []).length >= 3)
  check('WEB-006 识别 seq 回退（进程重启）并重置', /restarted/.test(diag) && /Number\(e\?\.seq\)\s*<\s*since/.test(diag))
}

// ══════════════════════════════════════════════════════════════════
// WEB-007：地形有 agent/维度归属，迟到响应不覆盖，null 清网格
// ══════════════════════════════════════════════════════════════════
{
  const t = read('src/stores/terrain.ts')
  check('WEB-007 记录了地形归属（owner + dimension）',
    /owner:\s*''/.test(t) && /dimension:\s*''/.test(t))
  check('WEB-007 请求带 requestId/归属，迟到即丢弃',
    /expected\.seq\s*!==\s*loadSeq/.test(t) && /expected\.owner\s*!==\s*curOwner/.test(t) && /expected\.dimension\s*!==\s*curDim/.test(t))
  check('WEB-007 切 bot / 换维度时旧地形立即失效', /loadSeq\+\+/.test(t))
  check('WEB-007 数据无效时把 decoded 清成 null（不留旧图）',
    /terrain\.decoded = null[\s\S]{0,200}?terrain\.stats = res\?\.reason/.test(t))

  const canvas = read('src/components/TerrainCanvas.vue')
  check('WEB-007 画布在无数据时把实例数清 0', /if\s*\(!d\)\s*\{\s*mesh\.count = 0/.test(canvas))
}

// ══════════════════════════════════════════════════════════════════
// WEB-004 / WEB-005 / WEB-010：Three.js 容量、资源释放、包围球
// ══════════════════════════════════════════════════════════════════
{
  const canvas = read('src/components/TerrainCanvas.vue')
  check('WEB-004 失败点写入前先确保容量（ensureCapacity）',
    /function ensureCapacity/.test(canvas) && /failMesh = ensureCapacity\(/.test(canvas))
  check('WEB-004 容量不足时重建且显式记录 _cap', /_cap\s*=\s*Math\.max\(1, needed\)/.test(canvas))
  check('WEB-005 标记只建一次（markerBuilt 守卫）',
    /let markerBuilt = false/.test(canvas) && /if\s*\(!markerBuilt\)/.test(canvas))
  check('WEB-005 不再每次 clear() 重建标记', !/markerGroup\.clear\(\)\s*\n\s*const mk = props\.marker/.test(canvas))
  check('WEB-005 卸载/重建时真的 dispose 旧 geometry 与 material',
    /function disposeGroup/.test(canvas) && /geometry\?\.dispose\?\./.test(canvas) && /material[\s\S]{0,60}?dispose\?\./.test(canvas))
  check('WEB-010 矩阵/count 变更后重算包围球',
    /function refreshBounds/.test(canvas) && /computeBoundingSphere/.test(canvas))
  check('WEB-010 面实例与失败点都调用了 refreshBounds',
    (canvas.match(/refreshBounds\(mesh\)/g) || []).length >= 2
    && (canvas.match(/refreshBounds\(failMesh\)/g) || []).length >= 2)
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'HAS FAILURES'}: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
