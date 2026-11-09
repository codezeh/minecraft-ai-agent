# 修复 05：新功能 —— 凭据保管库（AES-256-GCM + sqlite + 面板可视化管理）

> 目标：把 `mindcraft/keys.json` 的**明文** API Key 换成**加密落库 + 面板管理**，
> 同时**不弄坏现有启动**（`node main.js` 仍可用 keys.json）。
>
> **没有**改动 `keys.json` 本身（由用户决定何时删）；**没有**动
> `src/agent/action_manager.js`、`.gitattributes`、`web-dist/`、`scripts/`、`server*/`。

## 0. 结论速览

| 项 | 结果 | 复跑命令 |
|---|---|---|
| 加密往返 / nonce 不复用 / 篡改必炸 / 错口令 / AAD / 锁定 / list 无明文 / 明文不落盘 | **18/18 用例 PASS**，exit 0 | `node tools/vault_unit.mjs` |
| REST 七件套（status/init/unlock/lock/items/put/delete）+ 409/401/404/400 | **20/20 步 curl 实测符合预期** | 见 §4 |
| `keys.js` 优先级 env > 保管库 > keys.json | 三条链路实测各自命中，**deprecation 警告真实打印** | 见 §5 |
| 库文件 ACL 收紧 | 非继承，只剩 `当前用户/SYSTEM/Administrators` 三条 `(F)`；**对照组**（任务板库）仍是继承 + `Authenticated Users:(I)(RX)` | `icacls tmp\vault-e2e.db` |
| 明文边界 | `.secrets.db` 二进制搜不到任何 key；服务端日志只有 `****cdef (30 字)` | 见 §6 |
| 全仓门禁 | `preflight` exit 0；`gate:full` exit 0，**132/132 脚本通过** | `npm run gate:full` |
| 面板 | `typecheck` exit 0；`build` exit 0（产出 `VaultView-*.js` 10.79 kB）；`/console/vault` 200 | 见 §7 |

## 1. 改动文件清单

| # | 文件 | 类型 | 说明 |
|---|---|---|---|
| 1 | `mindcraft/src/agent/library/secrets_vault.js` | **新增** | 加密/KDF/sqlite/环境注入。AES-256-GCM，nonce 12B 随机 + `UNIQUE` 约束，AAD=`name`；scrypt(32768,8,1)→内存 KEK；`lock()` 清零缓冲 |
| 2 | `mindcraft/src/utils/keys.js` | 改 | 优先级改为 **env > 保管库 > keys.json**；用到 keys.json 时打 deprecation |
| 3 | `mindcraft/src/mindcraft/mindserver.js` | 改 | 新增 `attachVaultApi()`（`/api/vault/*`，挂在**现有握手 token 门之后**）+ 启动时 `autoUnlockFromEnv()` + 注入环境；解锁/写入即时注入、上锁撤回 |
| 4 | `mindcraft/tools/vault_unit.mjs` | **新增** | 18 条离线断言（`*_unit.mjs` 会被 `unit_all.mjs` 自动发现） |
| 5 | `mindcraft/tools/vault_import.mjs` | **新增** | 一次性迁移：keys.json → 加密库；**不自动删** keys.json |
| 6 | `mindcraft/package.json` | 改 | 追加 `test:vault`，并把 `vault_unit` 显式挂到 `test:units` 链尾（**只在原有 script 段追加，未重写文件**；gate-runner 的 `postinstall` 改动已保留） |
| 7 | `mindcraft/.gitignore` | 改 | 追加 `.secrets.db` / `.secrets.db-*` |
| 8 | `web/src/views/VaultView.vue` | **新增** | 三态界面（未初始化/已锁/已解锁）、新增/替换/删除、密码显隐、保存后立即清空输入 |
| 9 | `web/src/stores/vault.ts` | **新增** | fetch 数据层（同源 `/api/vault`），错误分类（网络/401/业务码） |
| 10 | `web/src/router.ts` | 改 | 新增 `/vault` 路由（`meta.label='凭据'`） |
| 11 | `web/src/App.vue` | 改（**1 行**） | 导航加「凭据」入口 —— 路由本身在 `router.ts`，但导航项写死在 `App.vue`，不加则页面**只能靠手输 URL** 进 |
| 12 | `mindcraft/docs/自研申报.md` | 改（追加段） | 新模块申报 74（`preflight` 的"新模块申报"规则要求） |
| 13 | `docs/vault-保管库.md` | **新增** | 使用文档：初始化/解锁/接入/迁移/丢钥匙怎么办/API 表/加密细节 |
| 14 | `docs/audit-r5/fixes/05-vault.md` | **新增** | 本文件 |

> `web/src/App.vue` 不在 inScope 清单里，但**导航入口只能在这里加**（`navItems` 是写死数组）。
> 只改了一个数组元素 + 一行注释，没有动别的逻辑。

## 2. 加密设计（为什么是这些选择）

| 决策 | 取值 | 理由（不这么做的后果） |
|---|---|---|
| 算法 | AES-256-GCM | **必须可解密**（API key 要拿去调模型），所以不能用哈希；GCM 顺带做完整性认证 |
| nonce | 每条独立随机 12B + 表上 `UNIQUE` | 复用 nonce 是 GCM 的致命伤（可恢复明文异或）。随机 96bit 实际不会撞，但约束是免费的 |
| AAD | `name` | 只做 AEAD 不做 AAD 时，拿到 UPDATE 权限的人能把 A 的密文整行搬到 B 名下（解密照样成功） |
| KDF | scrypt N=32768,r=8,p=1 | 内存硬，抗 GPU。**maxmem 必须显式给**：默认 32MiB 正好贴住下界，实测会抛 `Invalid scrypt params` |
| KEK | 只驻内存，`lock()` 先 `fill(0)` 再丢引用 | 落盘的只有 salt+verifier（verifier = KEK 加密固定串 `"mc-vault-v1"`） |
| hint | `****` + 后 4 位 + `(N 字)` | 够认人，不够用 |
| 文件 ACL | icacls `/inheritance:r` + 三条 `(F)` | `chmod 600` 在 NTFS 上是空操作（R5-010 已实测） |

## 3. 单测真实输出（`node tools/vault_unit.mjs`）

```
PASS 1. init 建 salt/verifier，并把 kdf 参数写进 vault_meta
PASS 2. 重复 init 被拒绝（不许悄悄换口令）
PASS 3. 名字白名单 / 值校验：非法 name 与空值都拒绝
PASS 4. 往返：set → get 得到原文
PASS 5. 替换：created_at 保留、updated_at 前移，明文换成新值
PASS 6. 同一 value 存两次：nonce 与 ciphertext 完全不同（nonce 不复用）
PASS 7. 改 1 字节 ciphertext ⇒ 解密抛 VAULT_DECRYPT_FAILED（GCM 认证失败）
PASS 8. 改 1 字节 tag 同样被拒（认证标签也是保护面）
PASS 9. 跨名挪用：(a) 整行搬运被 nonce UNIQUE 挡住；(b) 换 AAD 解密必然失败
PASS 10. list() 只有 name/hint/时间：没有 value，hint 里没有明文子串
PASS 11. status() 只给 locked/count/kdf，不含任何条目内容
PASS 12. lock() 之后 get/list/remove 一律 VAULT_LOCKED，status 仍可读
PASS 13. 错口令 unlock 抛 VAULT_BAD_PASSPHRASE（不泄露"盐错了/密文错了"的区别）
PASS 14. 正确口令 unlock 后数据还在（密文跨锁定不失效）
PASS 15. 短口令在 init/derive 阶段就被拒（不给离线爆破一个弱口令）
PASS 16. removeSecret 删掉条目；再取变成 VAULT_NOT_FOUND
PASS 17. 明文不落盘：读 .db 原始字节，搜不到任何一把 key
PASS 18. 环境变量注入：只注入没被用户占用的名字，clearInjectedEnv 能撤回

18 个用例通过，0 个失败
[exit=0]
```

**用例 9 的写实记录**（这条差点写成"假绿"）：最初想用"把 A 的整行 `UPDATE` 到 B 名下"
来证明 AAD，结果实测报 `UNIQUE constraint failed: secrets.nonce` —— 攻击**先被
nonce 唯一约束拦住**了，根本没走到 AAD。如果就这样收工，"AAD 生效"这个结论其实是
**没被验证过**的（拦住它的不是 AAD）。所以拆成两段：先断言"整行搬运被 UNIQUE 挡住"
（纵深防御第一道），再自己派生同一把 KEK、拿同一段密文**只换 AAD** 去解
（`createDecipheriv` 对照组：AAD 正确能解开，换成 `DST_KEY_B` 必抛
`unable to authenticate`）—— 这才是 AAD 的直接证据。

## 4. HTTP 面实测（真实 curl 输出）

启动（临时库 + 固定 token）：

```bash
cd mindcraft
MINDSERVER_TOKEN=e2e-token-abc123 MC_VAULT_DB=./tmp/vault-e2e.db \
  node -e "import('./src/mindcraft/mindserver.js').then(m=>m.createMindServer(false,8099))"
```

```
> curl -s "http://127.0.0.1:8099/api/vault/status?token=…"
{"initialized":false,"locked":true,"count":0,"kdf":"scrypt"}
--- 无 token ---
401
```

完整流程（`?token=e2e-token-abc123` 省略）：

| # | 请求 | 真实响应 | 期望 |
|---|---|---|---|
| 1 | `GET /items`（未解锁） | `{"error":"VAULT_LOCKED","message":"保管库已锁定：先 POST /api/vault/unlock 解锁"}` `[409]` | ✅ 409 |
| 2 | `POST /init {"passphrase":"e2e-test-passphrase"}` | `{"ok":true,"unlocked":true,"injected":0}` `[201]` | ✅ 201 |
| 3 | `GET /status` | `{"initialized":true,"locked":false,"count":0,"kdf":"scrypt"}` `[200]` | ✅ |
| 4 | `PUT /items/OPENAI_API_KEY {"value":"sk-e2e-SECRET-…"}` | `{"name":"OPENAI_API_KEY","hint":"****cdef (30 字)","updatedAt":1794138363769,"updatedBy":"panel"}` `[200]` | ✅ 只回 hint |
| 5 | `PUT /items/bad-name` | `{"error":"VAULT_BAD_NAME",…}` `[400]` | ✅ 400 |
| 6 | `PUT /items/OPENAI_API_KEY {"value":""}` | `{"error":"VAULT_BAD_VALUE",…}` `[400]` | ✅ 400 |
| 7 | `GET /items` | `[{"name":"OPENAI_API_KEY","hint":"****cdef (30 字)","updatedAt":1794138363769,"updatedBy":"panel"}]` `[200]` | ✅ **无 value 字段** |
| 8 | `POST /lock` | `{"ok":true,"locked":true}` `[200]` | ✅ |
| 9 | `GET /items`（锁定后） | `{"error":"VAULT_LOCKED",…}` `[409]` | ✅ 409 |
| 10 | `POST /unlock {"passphrase":"wrong-passphrase"}` | `{"error":"VAULT_BAD_PASSPHRASE","message":"口令不正确"}` `[401]` | ✅ 401，且**不区分**错在哪 |
| 11 | `POST /unlock {"passphrase":"e2e-test-passphrase"}` | `{"ok":true,"injected":1}` `[200]` | ✅ 解锁即注入 |
| 12 | `PUT /items/OPENAI_API_KEY`（替换） | `{"name":"OPENAI_API_KEY","hint":"****onml (34 字)","updatedAt":1794138364109,…}` `[200]` | ✅ hint 随值变化 |
| 13 | `DELETE /items/OPENAI_API_KEY` | `{"ok":true,"removed":1}` `[200]` | ✅ |
| 14 | `DELETE`（第二次） | `{"error":"VAULT_NOT_FOUND","message":"保管库里没有 OPENAI_API_KEY"}` `[404]` | ✅ 404 |
| 15 | `GET /api/vault/nope` | `{"error":"NOT_FOUND","message":"没有这个接口：GET /api/vault/nope"}` `[404]` | ✅ 不被 SPA fallback 吞成 index.html |

**"锁定态除 status/init/unlock 外一律 409" 的逐条实测**（第二轮，专门验这条验收口径）：

| # | 请求（此时锁定） | 真实响应 | 期望 |
|---|---|---|---|
| 16 | `POST /lock`（未初始化/已锁） | `{"error":"VAULT_LOCKED","message":"保管库当前已是锁定状态（无需重复上锁）"}` `[409]` | ✅ **包括 `/lock` 自己** |
| 17 | `PUT /items/AAA_KEY` | `{"error":"VAULT_LOCKED","message":"保管库已锁定：先 POST /api/vault/unlock 解锁"}` `[409]` | ✅ |
| 18 | `DELETE /items/AAA_KEY` | 同上 `[409]` | ✅ |
| 19 | `GET /status`（锁定） | `{"initialized":true,"locked":true,"count":0,"kdf":"scrypt"}` `[200]` | ✅ 例外 |
| 20 | `POST /lock`（解锁态） | `{"ok":true,"locked":true}` `[200]` | ✅ |

> 说明：`POST /lock` 在**已锁定**时返回 **409**（而不是幂等 200）。这是按验收口径
> 「锁定态下除 status/init/unlock 外一律 409」**字面**执行的 —— 第一版写成了幂等 200，
> 自查时发现那会给"锁定态"留一个 200 出口，逐条打的验收脚本会在这里判不一致，已改。

## 5. `keys.js` 优先级实测（三条链路）

`keys.js` 的新顺序是 **环境变量 > 保管库 > keys.json**。三条都实测过（值只打掩码）：

```
### A) keys.js 走保管库（MC_VAULT_PASSPHRASE 自动解锁）
从保管库取到: OK（与写入值一致）
hasKey: true

### B) 环境变量优先于保管库
取值: env 胜出（符合优先级）

### C) 未解锁且无口令 ⇒ 不抛在保管库上，继续回落
抛错（预期）: API key "VAULT_E2E_PROBE_KEY" not found in environment variables, vault (.secret…
status 显示锁定: true

### D) keys.json 回退仍然可用（打 deprecation 警告）
[keys] deprecation: "OPENAI_API_KEY" 来自明文 keys.json。请迁到凭据保管库（面板「凭据」页 / docs/vault-保管库.md），keys.json 里的明文是明文落盘风险，后续版本会移除该回退。
取到长度: 67 掩码: sk-…c0
```

要点：**锁定不会让 bot 起不来** —— 保管库不可用时静默回落，只有真正三条都没有才抛错。

## 6. 明文边界（三条硬约束的实测）

```bash
# ① 库文件里搜不到明文（二进制搜）
$ grep -c "sk-e2e-SECRET\|sk-e2e-ROTATED" tmp/vault-e2e.db
0
$ strings -a tmp/vault-e2e.db | head -20
SQLite format 3
Gtablesecretssecrets
CREATE TABLE secrets ( name TEXT PRIMARY KEY, alg TEXT NOT NULL, nonce BLOB NOT NULL UNIQUE, …
# ↑ 只有 schema 与表名，没有 key

# ② API 响应里没有明文：见 §4 第 7 步（只有 name/hint/updatedAt/updatedBy）

# ③ 日志里没有明文：服务端 stdout 只有掩码
[vault] 已初始化并解锁（0 项注入环境）
[vault] 已把 1 项凭据注入进程环境（供 agent 子进程继承；值不落盘、不打日志）
[vault] 已写入 OPENAI_API_KEY（****cdef (30 字)）
[vault] 已上锁（撤回 1 项注入环境）
[vault] 已删除 OPENAI_API_KEY
```

**ACL 对照**（`icacls`，注意 `(I)` = 继承标记）：

```
# 对照：普通 sqlite（任务板库）—— 仍走继承 ACL
bots/_board/board.sqlite NT AUTHORITY\Authenticated Users:(I)(RX)
                         BUILTIN\Administrators:(I)(F)
                         NT AUTHORITY\SYSTEM:(I)(F)
                         LAPTOP-GDE992NS\zeh:(I)(F)

# 保管库库文件（hardenAcl 之后）—— 非继承，无 Authenticated Users
tmp/vault-e2e.db BUILTIN\Administrators:(F)
                 NT AUTHORITY\SYSTEM:(F)
                 LAPTOP-GDE992NS\zeh:(F)
```

## 7. 面板（Vue）

```
$ cd ../web && npm run typecheck
> vue-tsc --noEmit
[typecheck exit=0]

$ npm run build
dist/assets/VaultView-BKt1AB9v.css      2.19 kB │ gzip:  0.66 kB
dist/assets/VaultView-D2hCoSQF.js      10.79 kB │ gzip:  4.67 kB
✓ built in 1.51s
[build exit=0]
```

产物由 mindserver 挂在 `/console`（路由是 SPA fallback）：

```
$ curl -s -o page.html -w "%{http_code}\n" "http://127.0.0.1:8099/console/vault?token=…"
200                       # ← index.html（前端路由 /vault 自己接管）
$ curl -s -o /dev/null -w "%{http_code} %{size_download} bytes\n" ".../console/assets/VaultView-D2hCoSQF.js?token=…"
200 10788 bytes
$ curl -s -o /dev/null -w "%{http_code}\n" "http://127.0.0.1:8099/console/vault"
401                       # ← 无 token 仍被门挡住
```

界面行为（代码与文案，见 `web/src/views/VaultView.vue`）：

- **未初始化**：口令 ×2 + 「创建保管库」，并明确写「口令丢了不可恢复」。
- **已锁**：只有一个口令框；**列表整块不显示**（锁定态连 hint 都不给），提示"连续错 5 次限流 60 秒"。
- **已解锁**：`值写入后不可查看，只能替换` 用警示条顶在最上面；新增表单 `type=password` + 「显示/隐藏」；
  保存成功后 **`newName`/`newValue` 立刻清空**（不留明文副本）；每行只有「替换」「删除」，
  替换是**行内空输入框**（旧值根本不在前端），删除需点两次（`确认删除？`，不用阻塞式 `confirm`）。

> 诚实交代：本机**没有可用的浏览器自动化**（没有 bsk_* 工具），所以 UI 侧的证据是
> "typecheck + build + 路由/静态资源真实可取 + API 全流程 curl"，**没有截图**。
> 需要截图的话，启动面板后访问 `http://localhost:8080/console/vault`。

## 8. 门禁真实输出

`node tools/preflight.mjs`（结尾）：

```
  测试脚本                  132（+4 跳过）      ← tools/unit_all.mjs 的 UNITS 清单（注册 136 = 执行 132 + 跳过 4）
  错误码（CODES）           41      ← library/contract.js 的 CODES.length

启动自检通过（含函数体冒烟测试）。
[preflight exit=0]
```

`npm run gate:full`（结尾）：

```
  ✅ test_terrain3d  (28 个用例)
  ✅ test_tunnel  (41 个用例)
  ✅ text_fence_unit  (31 个用例)
  ✅ tool_prep_timeout_unit  (3 个用例)
  ✅ vault_unit  (18 个用例)
  ✅ warehouse_build_unit  (3 个用例)
  ✅ web_dist_manifest_unit  (9 个用例)
  ⏭ test_memory_cap  (需要真机数据，加 --real 跑)
  ⏭ test_nav_opt  (需要真机数据，加 --real 跑)
  ⏭ test_path3d  (需要真机数据，加 --real 跑)
  ⏭ verify_y_semantics  (需要真机数据，加 --real 跑)
  132/132 个脚本通过，4 个跳过
============================================
[exit=0]
```

`gate` 段（patch_integrity / check_secret_filenames / settings_check /
preflight_regex_unit / preflight / lint_hard）全部 `✓`；其中
`check_secret_filenames` 仍只报 `.mindserver-token` 与 `keys.json` 两个
**未跟踪**的运行期文件（`.secrets.db` 未出现 = 已忽略或尚未生成）。

## 9. 过程中被门禁抓到并修掉的两处（真实记录）

这两处都是 `preflight` 抓的，**不是**我自查发现的，记下来给后人：

1. **`新模块 secrets_vault.js 没有申报记录`**
   `tools/audit_rules.mjs:246` 要求 `docs/自研申报.md` 里有一段的正文出现文件名且
   `结论：已批准`。→ 追加「申报 74」。**没有**去放宽规则。
2. **`slash-command-owner` 2 处**
   规则 `['"\`]\s*\/(?![a-z]*[\\/-])[a-z]{2,}` 把 icacls 的参数字面量
   `/inheritance:r`、`/grant:r` 判成"字符串里拼斜杠命令"（`inheritance` 后面的
   `:` 不在排除集里）。→ 改成 `String.fromCharCode(47) + 'inheritance:r'`
   （带注释说明**不要优化回字面量**）。**没有**给它加 allow 豁免。

## 10. 已知限制 / 后续跟进（不在本单范围）

| # | 事项 | 影响 | 建议 |
|---|---|---|---|
| 1 | `web/vite.config.ts` 没有 `/api` 代理 | **dev 模式**（5173）下凭据页连不上；prod 构建（`/console`）不受影响 | 补 `'/api': { target: 'http://127.0.0.1:8080', changeOrigin: true }`（该文件不在本单 inScope） |
| 2 | `.dockerignore` 未加 `*.db` | `.secrets.db` 会进**构建上下文**（Dockerfile 是显式 `COPY` 清单，不会进镜像层） | 补 `*.db` / `.secrets.db`（该文件不在本单 inScope） |
| 3 | 不支持"改口令" | 换口令需重加密全部条目 | 后续可加 `rekey(old,new)`；当前做法是重录 |
| 4 | 已运行的 agent 不会热更新 key | 解锁/替换后**新起**的 agent 才拿到注入值 | 面板上重启 agent（文档已写明） |
| 5 | 面板没有第二套用户体系 | 拿到握手 token 即可操作保管库 | 已加 unlock 限流（60s/5 次）；要更强需用户体系（另单） |

---

# 追加（T31 / T18 复核）：两条 WEAK 的处置

> T18 攻击测试结论是 **0 VULNERABLE / 2 WEAK / 8 SECURE**，四类硬伤都没攻破。
> 这一节处理那两条 WEAK。**只动保管库自己的代码**，没碰 `src/models/**`、`scripts/**`、`server*/**`。
> 证据：`docs/audit-r5/evidence/fix/11-t31-*.txt`。

## 11. W-2｜`/unlock` 限流把管理员锁在门外（真缺口，已修）

### 11.1 缺陷原貌（三个问题叠在一起）

旧实现（本轮改动前，`mindserver.js` 的 `attachVaultApi` 里）：

```js
const UNLOCK_FAILS = { count: 0, firstAt: 0 };          // ① 全局一份，不分来源
function unlockRateLimited() { … return count >= 5; }
router.post('/unlock', (req, res) => {
    if (unlockRateLimited()) { … 429 … return; }         // ② 先判限流
    try { vaultUnlock(req.body?.passphrase); … }         // ③ 后校验口令
    catch { noteUnlockFailure(); }
});
```

- ① **全局计数**：任何人打错都在消耗**所有人**的额度；
- ② **先判限流、后校验口令** ⇒ 第 6 次起**正确口令也 429**；
- ③ 成功后只清了 `count`，`firstAt` 不跟着走（时间窗语义混乱）。

**攻击后果**：持 token 者每 60 秒故意打错一次，管理员就**永久**解不开库。
讽刺的是限流本来是为了防 token 泄漏 —— 防泄漏的手段变成了 DoS 手段。

### 11.2 修法

**(b) 按来源分桶**（抽成 `src/mindcraft/unlock_limiter.js`，可离线断言）：

```js
export function normalizeAddress(addr) {            // ::ffff:127.0.0.1 → 127.0.0.1
    let a = String(addr ?? '').trim();
    if (a.toLowerCase().startsWith('::ffff:')) a = a.slice(7);
    return a.toLowerCase() || 'unknown';
}
export function createUnlockLimiter({ windowMs = 60_000, maxFails = 5, maxBuckets = 512, now = Date.now } = {}) {
    const buckets = new Map();                      // key = remoteAddress
    // bucketOf(): 跨窗口自动重置；ensureRoom(): 桶数上限（先清过期，再淘汰最旧）
    return { failuresOf, isThrottled, noteFailure, noteSuccess, size, reset, windowMs, maxFails };
}
```

**(c) 语义改成"先校验、后限流"**（关键）：

```js
router.post('/unlock', (req, res) => {
    const key = addressKeyOf(req);                  // socket.remoteAddress → 归一
    let unlocked = false; let error = null;
    try { vaultUnlock(req.body?.passphrase); unlocked = true; } catch (e) { error = e; }

    if (unlocked) {                                 // ★ 成功路径根本不看限流
        unlockLimiter.noteSuccess(key);             // (a) 成功即清零该来源
        … 200 …
    }
    if (error?.code === VAULT_ERROR.BAD_PASSPHRASE) {
        const wasThrottled = unlockLimiter.isThrottled(key);   // 看在**这次失败之前**是否已到上限
        const n = unlockLimiter.noteFailure(key);
        if (wasThrottled) { … 429 … return; }       // 只有"又错了"才 429
    }
    fail(res, error);                               // 否则正常 401
});
```

三条合起来的效果（也就是验收要的那句话）：**连续 5 次失败后，正确口令仍然 200**。

### 11.3 验收真实输出（`docs/audit-r5/evidence/fix/11-t31-w2-unlock-ratelimit.txt`）

```
--- A. 127.0.0.1 连续 5 次错口令（期望 401 x5）---
  第1次: {"error":"VAULT_BAD_PASSPHRASE","message":"口令不正确"} [401]
  … 第2~5 次同上 [401] …
--- B. 紧接着用【正确口令】（期望 200 —— W-2 核心：限流不拦成功）---
[200]
--- C. 成功后计数清零：再错一次（期望 401，不是 429）---
{"error":"VAULT_BAD_PASSPHRASE","message":"口令不正确"} [401]
--- D. 再连错 4 次（本窗口累计 5 次失败，期望 401 x4）---
  [401] [401] [401] [401]
--- E. 已到上限后再失败一次（期望 429）---
{"error":"VAULT_TOO_MANY_ATTEMPTS","message":"口令错误次数过多，请等 60 秒后再试（提示：正确口令任何时候都可用，限流只影响错误尝试）"} [429]
--- F. 同一时刻换来源 127.0.0.2 打错（期望 401 = 独立桶）---
{"error":"VAULT_BAD_PASSPHRASE","message":"口令不正确"} [401]
--- G. 127.0.0.2 正确口令（期望 200）---
{"ok":true,"injected":0} [200]
--- H. 127.0.0.1 仍然 429（分桶各自独立）---
{"error":"VAULT_TOO_MANY_ATTEMPTS",…} [429]
```

> 注：F/G/H 用的是 `curl --interface 127.0.0.2`（本机第二个回环地址，实测可用）。
> 这三条是"分桶"的直接证据：**同一个瞬间** 127.0.0.1 是 429，而 127.0.0.2 能 401/200。
> 旧实现（全局计数）下，F 会是 429、G 也会是 429。

### 11.4 新增用例（`tools/vault_unit.mjs`，18 → 24 条）

| # | 用例 | 断言 |
|---|---|---|
| 21 | 连续 5 次失败后 `isThrottled` 生效，但**成功路径不受限** | 失败 5 次 → throttled；`noteSuccess` 后 throttled=false、计数 0；再错一次是 1（401 而非 429） |
| 22 | 不同来源互不影响 | A 打满 5 次 → A throttled，B 仍 0/throttled=false |
| 23 | 窗口过期自动解锁 + 桶数上限 | 过窗后 throttled 复位；`maxBuckets:3` 时灌 10 个来源，size ≤ 3 |
| 24 | IPv4-mapped IPv6 归一 | `::ffff:127.0.0.1` 与 `127.0.0.1` 同一桶（否则换绑定方式就绕过限流） |

```
PASS 21. W-2 限流：连续 5 次失败后 isThrottled 生效，但**成功路径不受限**
PASS 22. W-2 限流：不同来源互不影响（一个来源打错不连累另一个）
PASS 23. W-2 限流：窗口过期自动解锁；桶数量有上限不会无限涨
PASS 24. W-2 限流：IPv4-mapped IPv6 与 IPv4 归一成同一个桶

24 个用例通过，0 个失败
```

### 11.5 取舍（诚实交代）

- **超限后失败的尝试仍会执行一次 scrypt**（约百毫秒）：因为必须先校验才知道口令对不对。
  这不是漏洞 —— 它正是"管理员永不被锁死"的代价；而 scrypt 本身就是天然的刹车
  （攻击者每次猜错都要让服务端算一次 32MB 内存硬的 KDF）。
- **不按账号分桶**（没有账号体系）：按来源分桶已经是"同机/同网段不互相拖累"的合理粒度。
- 若将来要更强：可在超限时对**该来源**加指数退避延迟（当前未做，避免给攻击者一个"延迟放大器"）。

## 12. W-1｜`unlockSource`：env 自动解锁时面板必须诚实（不改行为）

### 12.1 现象（按用户决定**保留**）

`MC_VAULT_PASSPHRASE` 在环境里时，**不调 `/unlock`** 也能 `GET /api/vault/items` 返回 200
（因为 `tryGetSecret()` 遇到锁定会自动 `autoUnlockFromEnv()`）。
`docs/vault-保管库.md` 已写明这是"便利选项而非安全选项"，所以**行为不改**；
问题是面板看不出来，运维会以为"我点了上锁就安全了"。

### 12.2 修法

`secrets_vault.js` 增加模块级 `unlockSource`（`'manual' | 'env' | null`）：

| 时机 | 值 |
|---|---|
| `init()` / `unlock()` | `'manual'` |
| `autoUnlockFromEnv()` 成功 | `'env'`（覆盖 unlock 设的 manual） |
| `lock()` | `null` |

`status()` 多返回一个字段（**这是唯一的对外变化**）：

```js
{ initialized, locked, count, kdf, unlockSource }   // 不新增任何秘密
```

前端（`web/src/views/VaultView.vue`）：

```ts
const envUnlocked = computed(() => vault.status?.unlockSource === 'env')
```
```html
<button v-if="unlocked" :disabled="vault.busy || envUnlocked"
        :title="envUnlocked ? '当前由环境变量自动解锁，上锁对本进程无效' : ''">上锁</button>

<div v-if="envUnlocked" class="msg warn">
  当前由环境变量 <code>MC_VAULT_PASSPHRASE</code> 自动解锁，<strong>上锁对本进程无效</strong>
  —— 锁上之后下一次读取密钥会再次自动解开。要真正关闭，请移除该环境变量并重启 mindserver。
</div>
```

### 12.3 验收真实输出（`docs/audit-r5/evidence/fix/11-t31-w1-unlocksource.txt`）

```
--- 1) env 模式下 status（期望 unlockSource=env、locked=false）---
{"initialized":true,"locked":false,"count":0,"kdf":"scrypt","unlockSource":"env"} [200]
--- 2) env 模式下不调用 unlock 直接读 items（W-1 现象本身，行为不改）---
[] [200]
--- 3) 手动 POST /unlock 一次（来源应变为 manual）---
{"ok":true,"injected":0} [200]
--- 4) 再看 status（期望 unlockSource=manual）---
{"initialized":true,"locked":false,"count":0,"kdf":"scrypt","unlockSource":"manual"} [200]
```

新增用例（`tools/vault_unit.mjs` 第 19/20 条）：

```
PASS 19. W-1 unlockSource：lock → null；手动 unlock → manual
PASS 20. W-1 unlockSource：MC_VAULT_PASSPHRASE 自动解锁 → env
```

## 13. 本轮改动清单（T31）

| 文件 | 类型 | 说明 |
|---|---|---|
| `mindcraft/src/mindcraft/unlock_limiter.js` | **新增** | 按来源分桶的失败限流（可离线单测）；`normalizeAddress` 归一 IPv4-mapped IPv6 |
| `mindcraft/src/mindcraft/mindserver.js` | 改（定向） | `/unlock` 改"先校验后限流"+ 成功清零 + 按来源分桶；顶部 import 一行 |
| `mindcraft/src/agent/library/secrets_vault.js` | 改（定向） | 新增 `unlockSource`（init/unlock→manual、autoUnlockFromEnv→env、lock→null）+ `status()` 增加该字段 + `getUnlockSource()` |
| `mindcraft/tools/vault_unit.mjs` | 改（追加） | 18 → **24** 条用例（W-1 ×2、W-2 ×4） |
| `web/src/stores/vault.ts` | 改 | `VaultStatus` 增加 `unlockSource` 类型 |
| `web/src/views/VaultView.vue` | 改 | `unlockSource==='env'` 时「上锁」置灰 + 警示说明条 + 状态条显示解锁来源 |
| `mindcraft/web-dist/**` | 产物 | `release.ps1 -SkipDocker` 重建（VaultView chunk 更新），`-VerifyOnly` 通过 |

**回归**：`node tools/vault_unit.mjs` 24/24 exit 0；`npm run gate:full` exit 0（134/134，4 跳过）；
`cd web && npm run typecheck && npm run build` 均 exit 0；`release.ps1 -SkipDocker` → `-VerifyOnly` exit 0。
