# D1 依赖基线（依赖与供应链部 · patch-smith 修补轮产出）

> 采样：2026-11-06 ~01:40 +08:00，本机 Windows / `E:\我的世界ai`，Node v24.16.0 / npm 11.13.0
> 用途：D1 的"审计计数 + 接受风险 + 待办"唯一台账。**改动依赖后必须回来更新这里的数字**，否则下一个人没有比对基准。
> 相关 finding：`F-DEP-003/004/005/006/007/008/009/010/011/012`（recon-scout）+ `F-DEP-101/102`（patch-smith 历史转化）

---

## 0. 铁律：跑 audit 必须指定官方 registry

本机默认 registry 是 `registry.npmmirror.com`，**它不支持 npm audit 端点**（返回 `404 NOT_IMPLEMENTED`），
用默认源跑 audit 会得到"假失败/假结果"。统一用：

```bash
cd mindcraft && npm audit --json --registry=https://registry.npmjs.org
cd web       && npm audit --json --registry=https://registry.npmjs.org
```

若 `npm` 报 `EPERM ... npm-cache/_logs`（受限沙箱写不了用户 AppData），加一个工作区内的 cache：

```bash
npm audit --registry=https://registry.npmjs.org --cache "<repo>/.tmp_probe/npmcache"
```

---

## 1. 审计基线（**未修复前**的真值，可复跑）

| 目标 | critical | high | moderate | low | 合计 |
|---|---:|---:|---:|---:|---:|
| `mindcraft`（547 条 lock 条目） | **1** | **13** | 15 | 0 | **29** |
| `web`（112 条 lock 条目） | 0 | 0 | 3 | 0 | **3** |

`web` 侧 3 条 moderate 全在 devDependencies（`vue-tsc` → `@vue/language-core` → `minimatch`），不进构建产物。

> 复跑命令：见 §0。数值变化 = 依赖树变了，必须在本表更新并写明原因。

---

## 2. 接受风险清单（逐条带"为什么今晚不修"）

| 包 | 版本 | 编号 | 定级 | 为什么不修（已核实，非凭印象） |
|---|---|---|---|---|
| `zod` | 3.25.76 | GHSA-mrhx-c7xc-m3w5（CWE-770 内存耗尽） | 审计 high → **实际 medium** | 修复下界 4.6.6 = zod **4.x 主版本**。**本轮已核实 `npm view zod versions`：3.x 末尾只有 3.25.76 与 3.26.0-canary.\*，不存在 3.x 稳定回补版**。而 `openai@4.104.0` / `@mistralai/mistralai@1.15.1` 都要求 zod ^3 ⇒ 跨主版本 + 会改两个 SDK 的 structured-output 解析。可达性：需恶意/被投毒的 provider 端点（本仓支持自定义 baseURL），且只是 DoS。**等 SDK 支持 zod 4 时一并对齐**（届时 `npm ls zod` 必须只剩一个版本）。 |
| `tar` | 6.2.1 | GHSA-23hp-3jrh-7fpw（critical）+ 7 条 high | 审计 critical → **实际 low** | 只经 `gl → node-gyp@10.3.1 → make-fetch-happen/cacache` 在**构建/安装期**可达；`grep -rn "require('tar')" src main.js` **无输出**，运行时零入口。**本轮已核实 `npm view tar versions`：6.x 最大就是 6.2.1，没有 >6.2.1 的 6.x 版本** ⇒ 不存在"只升小版本"的修法；上 tar 7 需 node-gyp 11（跨主版本 + 动 native 构建链）。若将来 node-gyp 随 canvas/gl 升级自然到 11，tar 会跟到 7.x，那时才算收口。 |
| `glob` / `minimatch` | 10.4.5 / 9.0.9 | GHSA-5j98-mcp5-4vw2 / GHSA-g3hv-75wg-m249 | 审计 high/moderate → **实际 low** | 同挂在 node-gyp 下（构建期）；攻击面是 `glob -c '<cmd>'` 的 `shell:true`，而本仓**不调用 glob CLI**（`grep -rn "require('glob')\|from 'glob'" src main.js tools` 无输出，所有脚本用 fs/readdir 自己遍历）。单独 overrides 到 glob@10.5.0 会越过 node-gyp 的 caret 范围、在别的机器上产生 lock 漂移。 |
| `body-parser` | 1.20.8 | GHSA-27r3-jxmh-p828（压包尾部字节 DoS） | 审计 high → **实际 low（可修，但未落地）** | 本仓**没有任何 body 解析中间件**（`grep -rn "express.json\|bodyParser\|urlencoded" src main.js` 无输出），且 `mindserver` 只 `listen('localhost')` ⇒ 无入口。1.20.9 存在且满足 express 的 `~1.20.5`（本轮已核实 `npm view body-parser@1.20.9` → 1.20.9），属纯补丁级 —— **但落地需要 `npm ci`/`npm install`，本修补会话无安装权限 ⇒ 见 `F-DEP-010` blocked。** |
| `web` 3 条 moderate | — | vue-tsc / @vue/language-core / minimatch | moderate → **可接受** | 全 devDependencies，不进 `vite build` 产物、不随面板发布。修复需把 vue-tsc 提到 minimatch>=11 的版本线（跨 minor/major、改 typecheck 行为）。 |

**"接受风险"不等于"已修复"**：上表每一条在 morning report 里都必须原样列出，不许写成"已解决"。

---

## 3. 本轮真正落地的依赖侧改动（与 finding 一一对应）

| finding | 改动 | 落地状态 |
|---|---|---|
| `F-DEP-003` | 新增 `patches/mineflayer+4.39.0.patch`（只重建仍需要的 hunk 1：工具材质判定），删除 `patches/mineflayer+4.33.0.patch` | 补丁文件已写好并**实测可套用到 pristine 4.39.0**；**删除旧补丁需 captain 代做** ⇒ `fix-ready-awaiting-commit` |
| `F-DEP-004` | 新增 `tools/patch_integrity.mjs` + `patches/SHA256SUMS` | 已落地；**gate 接线待做**（必须等旧补丁删除后，否则会立刻把全队 pre-commit 打红） |
| `F-DEP-005` | `clean:modules` 不再删 `package-lock.json`；`reinstall` 改 `npm ci` | 已落地 |
| `F-DEP-006` | `package-lock.json` 的 `node_modules/gl` 补 `resolved` + `integrity`（**sha512 已用真实 tarball 下载+哈希验证**） | 已落地 → 全树 integrity 覆盖率 547/547 |
| `F-DEP-012` | `start.bat`：`npm install` → `npm ci`，失败 `exit /b 1` 不继续启动，并在 patch_integrity 存在时前置校验 | 已落地 |
| `F-DEP-007/008/009/011` | 不动代码 | `accepted-risk`（见 §2） |
| `F-DEP-010` | 不动（需安装权限） | `blocked` |
| `F-DEP-101` | 删除未使用的 `prismarine-schematic` | `blocked`（删依赖必须同步重建 lock，需安装权限） |
| `F-DEP-102` | 依赖审计落账 | **本文件即产出**；`audit` 脚本与 gate 接线待 captain 决定（§5） |

---

## 4. 补丁集现状与闸门

`patches/` 现有 5 个生效补丁（+1 个 `.disabled`）：

| 补丁 | 文件名版本 | 实装版本 | 状态 |
|---|---|---|---|
| `mineflayer+4.39.0.patch` | 4.39.0 | 4.39.0 | ✅ 本轮新建（替换 4.33.0 那个） |
| `mineflayer-pathfinder+2.4.5.patch` | 2.4.5 | 2.4.5 | ✅ |
| `mineflayer-pvp+1.3.2.patch` | 1.3.2 | 1.3.2 | ✅ |
| `prismarine-viewer+1.33.0.patch` | 1.33.0 | 1.33.0 | ✅ |
| `protodef+1.19.0.patch` | 1.19.0 | 1.19.0 | ✅ |
| `minecraft-data+3.97.0.patch.disabled` | 3.97.0 | — | ⚠️ 残留，不参与套用（`F-DEP-004⑤`），建议删或挪 `patches/disabled/` 并写清为什么留 |

**闸门**：`node tools/patch_integrity.mjs` —— 校验①每个补丁的 sha256 与 `patches/SHA256SUMS` 一致；②文件名版本 == node_modules 实装版本。
用法：改完补丁必须 `--write` 刷新基线并同 commit 提交。正反双向已实测（篡改补丁/改版本/删文件 三向必红）。

---

## 5. 待接线（下一批，需 captain 决策）

1. **`gate` 加一步**（`F-DEP-004` 核心要求）——**必须在 `patches/mineflayer+4.33.0.patch` 删除之后**再加，否则 pre-commit 全红：
   ```json
   "gate": "node tools/patch_integrity.mjs && node tools/settings_check.mjs && node tools/preflight_regex_unit.mjs && node tools/preflight.mjs && node tools/lint_hard.mjs"
   ```
2. **依赖审计进网关**（`F-DEP-102`）：
   ```json
   "audit": "npm audit --omit=dev --audit-level=high --registry=https://registry.npmjs.org"
   ```
   并决定是否进 `gate:full`（无网时应 fail-open 打印"未联网，跳过"而不是假绿 —— 与 preflight 的 fail-closed 哲学相反，需用户拍板）。
3. **`patch-package` 在 devDependencies 却挂在 `postinstall`**（`F-DEP-004④`）：`npm ci --omit=dev` 会因找不到它而失败。
   最小改法是把 `patch-package` 移到 `dependencies`（**不是新增依赖，是移动既有依赖**），但必须同步重建 lock，需安装权限 ⇒ 未做。
