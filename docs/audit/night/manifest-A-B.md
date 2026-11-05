# manifest · 任务 A（F-WEB-202/203 精修）+ 任务 B（F-RT-001/003/005）

> patch-smith · 2026-11-06 02:5x｜依 captain ③ 的两个任务
> 改动文件：`mindcraft/src/mindcraft/mindserver.js`（A 全部 + B 的 003）、
> `mindcraft/src/agent/library/tool_prep.js`（B 的 005）、
> 新增 `docs/audit/night/manual-F-RT-001-token-acl.md`（B 的 001，手册）

---

## 任务 A

### `F-WEB-202` 贴图代理重活（按复核席裁决重做）

**复核席的裁决我采纳**：`import()` 本来就幂等，缓存它解决的是不存在的问题；真开销是
`mcAssetsFactory(ver)` 索引构建 + `readFileSync`，而**纯缓存在第一波并发上完全无效** ——
攻击形态恰恰是 20 个请求同时打同一个 `oak_planks.png`。

**改法（把 handler 拆成"干活"与"调度"两层）**
- 新增 `fetchTextureBuffer(itemName, candidates)` → `Buffer|null`，**不碰 res**（这样才能被复用）。
- 新增 `getTexture(itemName, candidates)`：
  1. **同 key 合并**：`TEX_INFLIGHT` 是 `Map<key, Promise>`，同 key 并发只跑一遍流水线，其余 `await` 同一个 Promise；
  2. **并发上限**：`TEX_INFLIGHT.size >= 4` → 抛 `TEX_BUSY` → 路由回 **503**；
  3. **8 秒硬超时**：`Promise.race([fetch, timeout])`，超时抛 `TEX_TIMEOUT` → 路由回 **504**（且**不缓存**，下次可重试）；
  4. **`finally` 清理**：`clearTimeout` + `TEX_INFLIGHT.delete(key)` —— **漏这行 = 该 key 永久 503 + 内存泄漏**；
  5. **结果缓存** `TEX_CACHE`（key 含版本串），上限 300 条，命中直接回 Buffer，并加 `Cache-Control: max-age=86400`。
- `task.catch(() => {})` 防 unhandled rejection 带走进程。

**自检**：`node --check` OK；`grep` 确认 `TEX_INFLIGHT.set/delete`、`TEX_TIMEOUT_MS`、`Promise.race`、`TEX_BUSY/TEX_TIMEOUT` 全在位；
`mindserver_gate_unit` 49/0。
**未真机验证**：并发压测（20 同 key）、8 秒超时实测 —— 需起服务，归 captain/用户。

### `F-WEB-203` 限流扩面（把桶抽成共用实现）

- 新增模块级 `takeToken(socket, label, capacity, windowMs)`：按**远端地址 + 事件 label** 分桶
  （挂 `socket.data` 时断开重连即清零，可无限绕过 —— 复核席指出；label 分桶是因为
  "聊天可以高频、重启一分钟三次就是攻击"）。
- 四个事件统一走它，容量按"正常使用频率"分别定：

| 事件 | 容量/窗口 | 为什么 |
|---|---|---|
| `send-message` | 30 次 / 10s | 聊天正常频率；原来内联实现，**本轮改成同一实现**（消除重复） |
| `restart-agent` | **3 次 / 60s** | 每点一次杀一个 bot 进程再拉起，反复点能把机器拖垮（比刷消息更伤可用性） |
| `create-agent` | **5 次 / 60s** | 会 **spawn 新 bot 进程**（连 MC、吃内存与 LLM 配额），原来完全无限流 |
| `listen-to-agents` | 10 次 / 60s | 订阅集合按 socket 计数起计时器，反复订阅推高服务端负载 |

**明确知道但不解决（captain 要求写明）**：**限流挡不住 `settings.max_commands = -1`** ——
一条消息就能让模型引爆无限命令。那是"单次请求内部的放大"，与"请求频率"正交，需另行处理。

**自检**：`node --check` OK；`grep takeToken(socket` → **4 处调用 + 1 处定义**；
内联旧块已删除（`grep rlKey` → 0 命中，只剩 helper 内的 `RATE_BUCKETS`）；`mindserver_gate_unit` 49/0。

---

## 任务 B

### `F-RT-003`（low，最便宜）`?token=` 进历史 + token 文件不清理  → **已改**

1. **302 抹掉 query**：种完 cookie 后，`GET` 请求 302 到**去掉 `token` 的同一路径**
   （保留其他 query 参数；POST 不重定向，交给下面的门判断）。
   ⇒ 地址栏/浏览器历史/书签同步里不再出现 token。
2. **退出时删文件**：`cleanupTokenFile()` 挂在 `process.once('exit')` 与 `SIGINT/SIGTERM` 上，
   退出即 `unlinkSync(TOKEN_FILE)`。
   - 为什么不在启动时删旧的：`start-panel` 要在**本次**启动后读它。
   - 这只是"缩短留存窗口"，**不是权限边界**（同机其他账户运行期仍可读 → 见 F-RT-001 手册）。

自检：`node --check` OK；`grep` 命中 `res.redirect(302` / `unlinkSync` / `F-RT-003`；`mindserver_gate_unit` 49/0。

### `F-RT-005`（low）`place_block` 超时缩短后的误判  → **已改**

`tool_prep.js` 的"自己放工作台"分支：原来 `if (!placed.ok) throw` 在**读回之前**。
而 `patches/` 把 `place_block` 的等待从 5000ms 压到 500ms（F-DEP-003 hunk 3）⇒ `placeAgainst` 可能
返回 `ok:false`（"没等到 blockUpdate"）**而方块其实已经放上去了** ⇒ 先 throw 就误判成"没有工作台"，
把刚放好的台子白扔。

改法：**先 `bot.blockAt(spot)` 读回** —— 方块在 → 照常 `recipesFor` + `craft` + `return true`；
读回也没有 → 才 `throw`。**自检**：`node --check` OK。

### `F-RT-001`（medium）token 文件 ACL  → **blocked（需用户/部署执行）**

已写手册 `manual-F-RT-001-token-acl.md`：
- 三步 `icacls`（关继承 → 只留 当前用户/SYSTEM/Administrators → 验收）
- **关键坑**：token 文件每次启动重建 ⇒ ACL 退回继承值。可持续做法二选一：
  A) 收紧父目录 `mindcraft`（副作用：其他账户读不到整个目录，需用户确认不打断备份/多账户用法）；
  B) 写 `scripts/tighten-token-acl.ps1` 在启动后重设 —— **我可以代写，等指示**。
- 关闭判据：(a) `icacls` 无 `Authenticated Users`/`Users` **且** (b) 另一本地账户 `type` 被拒。

---

## 自检汇总
| 命令 | 结果 |
|---|---|
| `node --check mindserver.js` / `tool_prep.js` | OK |
| `node tools/mindserver_gate_unit.mjs` | **49 passed / 0 failed** |
| `node tools/text_fence_unit.mjs` | 22 passed / 0 failed（未受影响） |
| `node tools/permissions_unit.mjs` | 68 passed / 0 failed（未受影响） |
| `npm run gate:full` | **本会话 node 不能 spawn，跑不了** ⇒ 归 captain |

## 未做 / 明确记账
- `F-WEB-202` 并发压测与 8s 超时的**真机实测**（需起服务）
- `F-RT-001` 的 icacls 执行（需管理员；手册已给）
- `F-RT-004` 不在 captain 指派范围内，**未动**
- `settings.max_commands = -1` 的放大问题（captain 明确"另行处理"）
- `F-AI-204` 保持 blocked；`F-EXEC-204`（guardedChat 下沉）标"待真机环境"

## 文件组通知（依 ⑤）
`mindcraft/src/mindcraft/mindserver.js`、`mindcraft/src/agent/library/tool_prep.js`、
`docs/audit/night/manual-F-RT-001-token-acl.md`(新) —— **这组是完成态**，可以跑 `lint_hard` + `gate:full` 后提交。
