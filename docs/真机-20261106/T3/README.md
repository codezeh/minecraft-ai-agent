# T3 真机验收 · WEB-003（中文输入法组合中的回车不要当发送）

- 验收对象：`web/src/components/ChatStream.vue` 的 `onKey` / `isImeComposing`
- 真机环境：**Edge 156.0.4314.58**（`Edg/156.0.4314.58`，内核 `Chrome/156.0.0.0`），有头模式，CDP 直驱（9222）
- 面板：`http://localhost:8080/console`（mindserver，**未重启**；注：验收期间环境被外部重启过一次，面板 PID 4392→4112、token 亦随之更换，`web/dist` 哈希未变）
- 执行者：web-probe（attempt 3，attempt_id `82aa99d8-9b4f-43dc-94ab-5c68d05ae214`）

---

## 0. 结论

**修复在浏览器事件语义下成立**：组合期间的回车既不发送、也不 `preventDefault`（输入法默认行为不被抢）；组合结束后回车 / 普通回车 / 上屏后立刻回车各**只发送一次**，不丢字。

**同时有一个必须一起报的部署事实**：面板**实际部署**的前端产物（`web/dist`，13:05 构建）里**不含这段修复** —— 在真浏览器里它表现的就是"修复前"的行为。修复只到源码，没进这次部署。

---

## 1. 逐条对 WEB-003 期望

| 序列 | 期望 | 当前源码 `current` | 修复前 `old`（= 部署产物行为） |
|---|---|---|---|
| ① 组合中回车 | **不发送** | ✅ 未发送、`defaultPrevented=false`、输入框内容保留 | ⚠️ **分两种形态**，见 §3：只抢 `preventDefault`（纯组合）／**真的提前发送**（已有上屏文字 + 续输组合） |
| ② 组合结束再回车 | **发送一次** | ✅ 1 次，发出「你好世界」 | ✅ 1 次，同上 |
| ③ 普通回车 | **发送一次** | ✅ 1 次，发出「普通回车测试」 | ✅ 1 次，同上 |
| ④ 直接上屏后立刻回车 | 不丢字 | ✅ 1 次，发出「上屏即回车」 | ✅ 1 次，同上 |
| 附 Shift+Enter | 不发送 | ✅ 未发送 | ✅ 未发送（sanity） |

---

## 2. 新发现（F-WEB-003-deploy）：修复没进部署产物

静态证据：`evidence/deployed-dist-static.json`（只读，不改产品文件）

| 项 | 值 |
|---|---|
| 面板静态挂载点 | `mindcraft/src/mindcraft/mindserver.js:496-501` → `app.use('/console', express.static('../../../web/dist'))` |
| 部署入口 chunk | `web/dist/assets/index-BfjaJXlW.js`，155370 B，`sha256=e9056410d20e1a94e067ea56365cced7c14810bde0e1b63c7d7a0a7eb77174b9`，mtime **2026-11-06 05:05:03Z（13:05+08）** |
| 源码 mtime | `web/src/components/ChatStream.vue` **10:37:53Z（18:37+08）**；修复提交 `57499b7 18:42:22+08` |
| 部署 bundle 里 `isComposing`/`229`/`Process` 计数 | **0 / 0 / 0** |
| 部署 bundle 真正的 keydown 处理器 | `function i(a){a.key==="Enter"&&!a.shiftKey&&(a.preventDefault(),r())}` |
| 修复前源码（git `22c41e8`） | `if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() }` |

⇒ 部署 bundle 的处理器与**修复前源码同构**、且完全没有三项判定。要真修，必须重新构建 `web/dist`（`cd web && npm run build`，面板静态挂载即时生效，不必重启 mindserver）。属于改产品产物，本任务不做。

另两条环境事实（决定了"不能直接开面板测"）：

- **面板 0 agent** ⇒ `ConsoleView` 走 `v-if="!store.agents.length"` 的 empty 分支，**ChatStream 不挂载**，没有输入框（实测 placeholder「agent 离线，无法发送」、输入框 `disabled=true`）。
- **生产构建里摸不到 store**：Vue 3.5 prod 不挂 `app._instance`、元素上无 `__vueParentComponent`、`setupState` 为空（`evidence/probe-deep.json`、`probe-router.json`：`instanceNull=true`、`setupKeys=[]`）⇒ 无法在页面里补一条 agent。

---

## 3. 正面回答「旧版 `prevented=true` 却没发出去」——根因、证据、结论收窄

这是本次最需要说清的一处，**不是探针漏统计**，而是旧代码真的进了 `send()` 却又被 `send()` 自己挡回来。

### 3.1 根因

`send()` 的第一行是 `const text = input.value.trim(); if (!text) return;` —— 这里的 `input` 是 `ref('')`，**不是** DOM。

而 Vue 的 `vModelText`（`onUpdate:modelValue` 那条）在组合期间**不会把 DOM 值写回 ref**（`if (e.target.composing) return`），
所以「组合中、尚未上屏」时：**DOM 里有字，ref 是空串** ⇒ `send()` 在 `if (!text) return` 空转：既没 `say()`、也没清空。

旧代码的 `preventDefault()` 是在 `send()` **之前**无条件执行的 ⇒ 于是出现「抢了输入法默认行为，却没发出消息」这一组合。

### 3.2 证据（页面可观测，不靠猜）

`evidence/diag-1b1c.json` + `evidence/diag-1b1c.steps.jsonl`（`diag-1b-1c.mjs`，跑的是**旧版**夹具）：

判据取自产品自己的模板：发送按钮是 `:disabled="!currentAgent?.in_game || !input.trim()"` ⇒ **按钮的 `disabled` 直接反映 ref 是否为空**，与 DOM 输入框里显示什么无关。

| 阶段 | DOM 输入框 | 发送按钮 disabled | 聊天区 |
|---|---|---|---|
| 组合中（`nihaoshijie` 未上屏） | `nihaoshijie` | **true** ← ref 是空串 | `[]` |
| 组合中**点一下发送按钮** | `nihaoshijie` | true（点不动） | `[]` |
| 组合中回车（VK13） | `nihaoshijie` | true | `[]`（`prevented=true`，事件里能看到） |
| 先上屏「你好」（无组合） | `你好` | **false** ← ref 非空 | `[]` |
| 在其上再起组合（`你好shijie`） | `你好shijie` | **false** | `[]` |
| 此时回车 | `你好shijie` | true（发送后 ref 清空） | **`["你好"]`** ← 真的发了 |

同一份旧代码、同一个键（VK13）、同样 `isComposing=true`，**唯一变量是 ref 空不空**，而 ref 空不空被"发送按钮 disabled"独立印证。
⇒ ①-b / ①-c（纯组合、还没上屏）发不出去，是 `send()` 的空文本短路；①-f（已有上屏文字）才真的提前发送。

### 3.3 结论收窄（按 Lead 要求）

- 旧版在**纯组合、尚未上屏**时：只 `preventDefault()`（抢候选确认/输入法默认行为），**不会**发消息。
- 旧版在**已有上屏文本 + 续输组合**时：`preventDefault()` **+ 真的把已上屏那半句发出去**（①-f 实测发出「你好」，聊天区新增 1 行）。
- 因此本报告**不笼统写"旧版会把半句拼音发出去"**；准确表述是：**"旧版在'已上屏中文 + 续输组合'时会提前发送已上屏部分，并且在任何组合态回车都会抢掉输入法的默认行为"**。
- 这也解释了为什么必须补 ①-f：任务书原始的"组合中回车"若只是刚起组合，旧代码根本发不出东西，**只有 preventDefault 这一半伤害可观测**。

---

## 4. 方法：同一台真机、同一套键序，唯一变量是被验文件

| 臂 | 被验组件 | 产物 | 含修复判定 |
|---|---|---|---|
| `current` | `web/src/components/ChatStream.vue`（**原文未改**） | `dist-current/assets/t3-index-C0upAQu5.js` 115000 B | ✅ 三个判定串都在 |
| `old` | `git show 22c41e8:...ChatStream.vue`（修复前，仅改 1 行 import 路径） | `dist-old/assets/t3-index-ae67x63V.js` 114514 B | ❌ 三个判定串均 0 |

每臂的 `summary.json` 里都有 `fixture.bundleMark`（从页面里 `fetch` 回自己执行的 bundle 再正则判定）——**证明两臂跑的是真不同的构建**，不是同一个包跑两遍。

夹具（`fixture/*/main.ts`，**不是产品代码**）只做三件事：import 产品组件与 store；往 `store.agents` 预置 1 条 stub（`initStore()` 会用服务端空数组**整体覆盖** `store.agents`，所以 stub 必须在它之后补回）；把组件挂到最小宿主上。

呈现：先用 `?token=` 正常导航种 HttpOnly cookie，再 `Fetch.enable` 只拦 `*/console*`，用 `Fetch.fulfillRequest` 把文档与 `assets/*` 换成夹具产物 ⇒ 页面源仍是 `http://localhost:8080`，**cookie 与 socket.io 都是真的**（实测 `store.connected=true`）。

### 4.1 可见性/焦点（本轮新增的硬前置）

窗口被遮挡或后台化时，Chromium 会把页面标成 `visibilityState="hidden"` 并**丢弃 CDP 派发的键事件**（实测：hidden 时 `keydown` 观测到 0 条，同一脚本 visible 时全部正常；本轮就踩过一次，早期步骤全空、后面步骤正常）。
所以驱动里加了：`--disable-backgrounding-occluded-windows --disable-renderer-backgrounding --disable-background-timer-throttling --disable-features=CalculateNativeWinOcclusion`，并在开跑前做**焦点+可见性自检**（发一个无副作用的 Shift，必须被观测器收到且 `visibilityState==='visible'`，否则直接失败、不产出证据），每条序列再用 `mustObserve()` 卡一道"这条按键必须被页面看到"。
两臂实测自检结果：`{"attempts":1,"seen":1,"visibilityState":"visible"}`，`headless=false`。

---

## 5. 四组序列的原始证据

| 文件 | 内容 |
|---|---|
| `evidence/current.steps.jsonl` / `old.steps.jsonl` | 每臂 **40 条**原始 CDP 请求/响应（token 打码 `4031****cb`；现 token 已因外部重启更换为 `f211****e4`，两处均已打码） |
| `evidence/current.snapshots.json` / `old.snapshots.json` | 每臂 **18 个** DOM 快照（含 `keydown@capture`/`keydown@settled`、composition、input、beforeinput 逐条 + `chatMeTexts`） |
| `evidence/current.summary.json` / `old.summary.json` | 断言汇总 + `bundleMark` + 焦点自检 + `headless` 标记 |
| `evidence/current-1f-composing-enter.png` / `old-1f-composing-enter.png` | ①-f 同步对比截图：修复版聊天区仍空；修复前已出现「我 你好」 |
| `evidence/current-3-plain-enter.png` / `old-3-plain-enter.png` | 序列③ 普通回车后（两臂都发一次） |
| `evidence/diag-1b1c.json` / `.steps.jsonl` | §3 的根因诊断（发送按钮 disabled ↔ ref 空） |
| `evidence/deployed-dist-static.json` | §2 部署产物静态证据 |
| `evidence/probe-deep.json`、`probe-router.json`、`probe-store.json`、`debug-page.json` | 探索留档：为什么必须用夹具（prod 拿不到 store、0 agent 不渲染 ChatStream） |

### 序列① 分支隔离（DOM 侧只读观测）

| 子序列 | 实际事件 | current | old |
|---|---|---|---|
| ①-a `key=Process, VK=229` | `key=Process kc=229 isComposing=true` | 不发、`prevented=false` | 不发、`prevented=false`（旧码在 `key!=='Enter'` 先返回，**无差异**） |
| ①-b `key=Enter, VK=229` | `key=Enter kc=229 isComposing=true` | 不发、`prevented=false` | 不发、`prevented=true` |
| ①-c `key=Enter, VK=13` | `key=Enter kc=13 isComposing=true` | 不发、`prevented=false` | 不发、`prevented=true` |
| ①-d `key=Process, VK=65` | `key=Process kc=65 isComposing=true` | 不发、`prevented=false` | 不发、`prevented=false`（同 ①-a） |
| ①-e 合成 `KeyboardEvent{isComposing:true}` | `key=Enter kc=13 isComposing=true` | 不发、`prevented=false` | 不发、`prevented=true` |
| **①-f 已上屏「你好」+ 组合「shijie」+ 回车** | `key=Enter kc=13 isComposing=true` | **不发**、`prevented=false`、输入框保留 | **发出「你好」**、`prevented=true` |

### 关于 ①-e（`synthReturn`）——更正 Lead 的读数并说明它能证明什么

Lead 记的是"旧版 `defaultPrevented:false`、当前版也是 `false`"。**实测相反**，两臂 `synthReturn` 分别是：

- `old`：`{"key":"Enter","keyCode":13,"isComposing":true,"defaultPrevented":true}`
- `current`：`{"key":"Enter","keyCode":13,"isComposing":true,"defaultPrevented":false}`

这也与 ①-e 的 `settled.prevented`（old `[true]` / current `[false]`）一致。
但要说清它的**性质**：`isImeComposing()` 是模块作用域里的函数、**没有导出**，页面侧无法直接调用它，因此 ①-e **只是"事件级"验证**（造一个带 `isComposing:true` 的 `KeyboardEvent` 看最终有没有被 `preventDefault`），**不是"函数级单测"**；而且真实浏览器在组合中本来就会给 keydown 带上 `isComposing=true`（①-a/b/c 实测都是 `true`），所以 ①-e 只是把"仅 isComposing 一条成立"的情形单独走了一遍，不代表真实输入路径。

---

## 6. 「发送」的判定口径（避免自欺）

1. **`say()` 真把一行「me」推进了 store.chat**（`.chat .line.me` 行数 + 行文本）⇒ 主判据，证明 `send()` 走到了 `pushChat`。
2. **输入框被清空**（`HTMLInputElement.prototype.value` 的 setter 探针，记录"非空→`''`"及旧文本）⇒ 辅证；**组合期会失真**（Vue 组合期不同步 DOM），所以不能单用。①-f 旧版 `sendCount=0` 但 `sentText=["你好"]` 就是这个失真。
3. **`defaultPrevented` 终值**（window 捕获后 `setTimeout(0)` 读）⇒ 输入法默认行为有没有被抢。

控制组 0：把输入框 `disabled=true` 后按 Enter → keydown 只落到 `BODY`、应用处理器没触发、`clears=0` ⇒ 后续各序列的输入框确实被显式启用过，观测不是空转。

### 关于序列④ 的"before 是空串"（Lead 第 3 点）

`seq4` 的 `inputValueBefore: ""` 是**故意**的：`④-before-insertText` 快照取在 `Input.insertText` **之前**（此时确实还没打字），随后 `insertText('上屏即回车')` 上屏、紧接着同一批里发 Enter。
所以：`inputValueBefore=""`（打字前）→ `beforeinput`/`input` → `clearedTexts=["上屏即回车"]`（Enter 时输入框里就是这四个字，被 `send()` 清空并发出）。
**不是"空输入框也发送了"**：那条序列 `compositionEvents` 只有 `evt:beforeinput`/`evt:input`，没有 composition，`settled.key=Enter/kc=13/isComposing=false`，`chatMeTextsAdded=["上屏即回车"]`。

---

## 7. 本方法证明不了什么（显式声明）

1. **不是物理键盘、不是真输入法**：键序由 `Input.imeSetComposition` / `Input.insertText` / `Input.dispatchKeyEvent` 合成。能证"浏览器事件语义下修复有效"，**不能**代表真人用微软拼音按候选窗、按空格选词、按回车确认的完整体验（候选窗 UI、组词上屏时序、`compositionupdate` 抖动都没覆盖）。
2. **`keyCode===229` 兜底分支未被独立证明**：本机所有组合中 keydown 都同时 `isComposing=true`，无法拆开"只有 229、没有 isComposing"的老浏览器情形。
3. **不是产品完整页面**：ChatStream 挂在最小夹具上，没有 `ConsoleView` 路由/布局/`StatusCard`；`store.agents` 是**预置 stub**（真实由 mindserver 推送）。
4. **服务端没有这个 agent**：`say()` 只在客户端成功（`emitControl` 只查 socket 连接），消息会被 mindserver 丢弃（按 `mindserver.js` 的 `if (!agent_connections[agentName]) { console.warn(...); return; }`）——"发到服务端/到 bot"这一步本次**未观测**（服务端日志目录不在 T3 权限内，也未去翻）。
5. **`current` 臂验证的是"源码修复"，不是"部署产物"**：线上跑的还是 §2 那份有 bug 的 `web/dist`。
6. 单机、单浏览器版本、单次运行；未覆盖 Firefox/Safari 的 `key`/`isComposing` 上报差异。
7. 有头模式下需要窗口未被遮挡（见 §4.1）；本轮实测 `visibilityState=visible` 且自检通过，但这依赖运行环境的前台状态。

---

## 8. 复现

```bash
# 1) 构建两臂夹具（只写 docs/真机-20261106/T3/，不碰 web/src、不碰 web/dist）
cd 'E:\我的世界ai\web'
T3_VARIANT=current npx vite build --config 'E:\我的世界ai\docs\真机-20261106\T3\vite.fixture.mjs'
T3_VARIANT=old     npx vite build --config 'E:\我的世界ai\docs\真机-20261106\T3\vite.fixture.mjs'

# 2) 真机键序（自起 Edge 9222、自收尾；不重启面板/服务端）
#    若窗口被遮挡导致自检失败，可加 T3_HEADLESS=1
cd 'E:\我的世界ai'
node docs/真机-20261106/T3/t3-ime.mjs current
node docs/真机-20261106/T3/t3-ime.mjs old

# 3) 根因诊断 与 部署产物静态证据
node docs/真机-20261106/T3/diag-1b-1c.mjs
node docs/真机-20261106/T3/static-deployed.mjs
```

真正修好部署（本任务不做，需 Lead 拍板，因为是改产品产物）：`cd web && npm run build`。

---

## 9. 未改产品代码 / 环境卫生

- `git status` 全程只有 `?? docs/真机-20261106/`；`web/src` 未改；`web/dist` 未重建（入口 chunk 哈希仍是 `e9056410…`）。
- 面板/Paper/bot **未重启**（验收期间被外部重启过一次，非本任务所为；本任务只做了 HTTP 导航与同一个 8080 的面板交互）；9222 跑完即释放。
- 证据内无 token 明文（全目录扫描 `token leaks = 0`），引用一律打码。
- **Edge 用户目录放 `%TEMP%`**（`t3-edge-profile-{old,current}`），不进证据目录；此前几轮留在 `T3/edge-profile-*` 的缓存**已删除**（本目录现在没有浏览器缓存文件）。
- 新增文件都在 `docs/真机-20261106/T3/`：驱动 `t3-ime.mjs`、夹具构建 `vite.fixture.mjs`、夹具 `fixture/`、产物 `dist-current/`、`dist-old/`、诊断 `diag-1b-1c.mjs`、静态证据 `static-deployed.mjs`、探索留档 `probe-*.mjs`/`debug-page.mjs`、`evidence/`。
