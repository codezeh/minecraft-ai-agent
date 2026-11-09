# R5 交付说明（第五轮 · 实测型验证与修复）

> 基线：父仓 `9530741`／子仓 `aec9bc6`　环境：Windows 11 + node v24.16.0 + PowerShell 5.1（无 pwsh、无 docker）
> 原则：**只接受跑出来的证据**。清单里每条都有可粘贴命令与真实输出；先读 §0 的"怎么复核"。

## 0. 三条命令复核全部结论

```powershell
powershell -File scripts/release.ps1 -VerifyOnly   # 产物↔清单↔源码三方一致 → exit 0
cd mindcraft; npm run gate:full                    # 门禁 133/133 + 24 个 vault 用例 → exit 0
node scripts/tests/acl-regression.mjs              # ACL 回归 31/31 → exit 0（免 -Apply 即绿）
```

想从零验证"干净机器能不能跑"：
```powershell
powershell -File scripts/clone-all.ps1 -LocalSource -Dest tmp/check
cd tmp/check; powershell -File scripts/release.ps1 -VerifyOnly    # 应为 exit 0
```

## 1. 这一轮做了什么（四类）

### ① 缺陷清单（可复现）
`00-缺陷清单.md`：12 条实测缺陷（P0×1/P1×3/P2×7/P3×1），每条 6 字段（编号/严重度+影响面/说明含文件:行/**复现步骤**/**实际输出**/证据路径+环境前提）。
附三节：已修或误报 19 条、不可跑 5 条、与前四轮差异 17 行。

### ② 修掉的缺陷（9 条）
| 编号 | 修了什么 | 证据 |
|---|---|---|
| R5-001 | 面板 `启动面板.bat` 起不来（`af4aa22` 删 BOM 的回归）+ `.bat` 吞退出码 | `fixes/01-panel-bom.md` |
| R5-002 | `acl-regression` 把运行时 token 当仓库不变量，干净仓库必红 | 同上 |
| R5-003/011 | 产物与源码未绑定 + 换行未钉 → 干净克隆复现不出 | `fixes/04-release-binding.md` |
| R5-004 | 父仓不跟踪子仓 → 一条 `clone-all.ps1` 拉起两仓 | `fixes/07-clone-all.md` |
| R5-007 | 缺 `patches/` 时 `npm ci` 静默跳过 5 个补丁 | `fixes/02-code-r5-012-r5-007.md` |
| R5-008 | RCON 明文 + 全网卡监听 | `fixes/06-rcon.md` |
| R5-009/010 | `server-test` 配置继承 ACL；`mindcraft/` 目录可被替换 | `fixes/03-acl.md` |
| R5-012 | `action_manager.js:422` 异常堆栈恒 `undefined` | `fixes/02-…` |
| + | token ACL 随进程重建复发（产品代码级） | `fixes/08-收口三件.md` |

### ③ 新功能（两个）
- **凭据保管库**（`docs/vault-保管库.md`）：AES-256-GCM（每条独立 nonce + AAD=name）+ scrypt 口令派生，面板可增删改但**永不回显明文**。攻击测试 **0 VULNERABLE**（`09-保管库攻击测试.md`）。
- **设置中心**（`fixes/11-设置中心.md`）：网络/身份/备份/运行时四组，开关 14 / 滑块 5 / 单选 3 / 时间 1 / 数字 3 / 列表 1，每个控件标"生效方式"（立即/需重启服务器/需重启 agent）。

### ④ 新增测试（把缺陷钉住，防止复发）
- `tools/chest_withdraw_race_unit.mjs`：箱子取物竞态（真机探针，无服 SKIP）
- `tools/e2e_chest_store_live.mjs` + `e2e.ps1 -Scenario chest`：bot 主动存取 + 物品守恒 **← 第一天就抓到一个 P1**
- `tools/opts_cancel_unit.mjs`：三处模型调用的取消贯穿（14 用例）
- `tools/fix_r5_012_unit.mjs`、`tools/vault_unit.mjs`（24 用例）、`tools/verify_patches.mjs`

## 2. 被实测证伪的旧结论（别再引用）

| 旧结论 | 实测结果 |
|---|---|
| 「缺 `package-lock` ⇒ `npm ci` 必失败 ⇒ 无法从零部署」 | 干净克隆 `npm ci` **548 包 exit 0**，lock 已被 `.gitignore:137` 反向放行 |
| 「`gate:full` 因 `[6/6]` EPERM 红」 | 环境限制，零代码改动即绿；当时那道 fail-closed 设计**本身是对的** |
| 「`flow_craft.js:415` 重复键是真缺陷」 | 误报：第二次 `count` 是故意压住 `...(lastData)`，删掉反而变错值 999 |
| 「10 条运行时缺陷待修」 | 当前 HEAD **0/10 复现**、基线树 **10/10 复现** ⇒ 真缺陷且已修，探针留作护栏 |
| 「容器存取 E2E 未做」 | 表述不准：`restart` 早已断言箱子；真缺口是"bot 主动存取"（已补） |

## 3. 未闭合（如实写，不假装修完）

| 项 | 原因 / 下一步 |
|---|---|
| **chest `withdraw` 取物** | 见 §4（本文件随最终结果更新） |
| R5-005 子仓 302 提交未推送 / R5-006 父仓零远端 | 用户选择"只本地提交"；给远端地址即可推送 |
| BUG-003 主服自然森林不掉落 | 隔离服四条件（含自然森林）全部正常；需在主服只读取证（CoreProtect 日志、`spigot.yml` 的 `entity-activation-range`） |
| `docker build` | 本机无 docker；文件层与内联校验已核，镜像未实测 |
| RCON 防火墙规则 | `deny-rcon-25575-in` **不入库、换机失效**；新机器须重跑 `scripts/deny-rcon-25575-in.ps1` |
| **生产服未重启** | 配置改动未生效。开服后核对 `netstat -ano | findstr :25575` 只应有 `127.0.0.1:25575` |

## 4. chest 取物缺陷（已修复，提交 `82da3f3`）

详见 `fixes/09-chest-e2e.md`（959 行，含逐次表与点击级证据）。

**两条根因（点击级证据钉死）**
- mineflayer `putSelectedItemRange` 收尾依赖客户端快照，确认晚到就提前退出 ⇒ 余数滞留光标 ⇒ 关窗时被服务端退回背包 ⇒ 「要 8 搬 16」
- 旧 `returnCursorToOrigin(..., 'container')` 在**光标为空**时 `left-click` 的语义是「**拿起整摞**」 ⇒ 第 9 次点击出现在 settle 超时点 `+1278ms`，把余 8 又拿起来 ⇒ 凭空多搬

**修法（3 文件 +173/−17）**
1. 新增 `clickWithdrawExact()`：只右键拆半（拿 `ceil(摞/2)` → 右键逐件放下 → 余数放回同一源槽），**绝不整摞左键**
2. 成功/异常路径改用 `drainCursorToInventory()`：光标有件只往**背包**放，绝不点容器槽
3. 窗口点击走 `atom_input_inventory.clickSlot()`（`mouse-input-owner` 合规，第一版撞了 4 处）
4. `flow_store` 跨层取**服务端真值**：`withdraw` 后关窗 → 等 200ms → 重开同一容器 → 读 `containerItems()`，用 `chestBefore − chestAfter` 当 `taken`（标 `takenSource:'server'`）
5. 无 `clickWindow` 的假 bot 退回 `win.withdraw()`，保住 3 个容器单测

**验收**
| 版本 | e2e 绿率 | 失败性质 |
|---|---|---|
| HEAD（修复前）| 9/10 | 1 次整箱搬空（玩家丢物品）|
| t37g（只做 1+2）| 8/10 | 2 次仅 `taken=7`（物数量对）|
| **修复后** | **10/10**（每次 30/30）| **无** |

四种坏签名 `+16/-16`、`箱子→0`、`31≠32`、`taken=7` **全部 0 次**；反向用例 `NO_ITEM`/`INTERNAL`/`OUT_OF_REACH` 仍正确失败且背包不变；`gate:full` 133/133；smelt/craft/container 相关 9 个单测全过。
**我（队长）独立跑过一次 `-Scenario chest`：EXIT 0、30/30 PASS。**

> ⚠ 复现时注意：`gate:full` 与 `e2e -Scenario chest` **不能同时跑** —— 两者都占 25566/25576，会让 `chest_withdraw_race_unit` 误判「有服可用」而真跑并失败（我就踩过一次，串行重跑即 133/133）。

## 5. 操作手册（你会用到的）

```powershell
# 面板（现在有演练模式，验证面板不必真起服）
powershell -File scripts/start-panel.ps1 -DryRun
powershell -File scripts/start-panel.ps1          # 真启动

# 门禁
cd mindcraft; npm run gate:full        # 全量
cd mindcraft; npm run gate             # 快检（不含 unit_all）

# 隔离服 E2E（自己起服/断言/重置）
powershell -File scripts/e2e.ps1 -Scenario chest
powershell -File scripts/e2e.ps1 -Scenario all

# 备份与恢复
powershell -File scripts/backup-world.ps1
powershell -File scripts/verify-world-backup.ps1 -BackupDir backups/world-xxxx
```

## 6. 这一轮的方法学教训（写给自己和下一轮）

1. **单测绿 ≠ 真机绿**：t33 用一个"自己写的 fake"验证"自己写的假设"，在 fake 里成立、真机里方向是错的。凡是涉及外部协议行为的，必须真机验。
2. **独立复核能推翻同伴结论**：t35 终验独立跑出 `20/30`，推翻了 t33 的"10/10 已修好"。没有这一步，我们会带着"要 8 搬 11"的缺陷交付，文档里还写着已修好。
3. **环境限制不是缺陷**：本轮挡掉 4 次（EPERM、缺 docker、PATH 上的坏 java shim、并发抖动假红）。
4. **并发写同一文件必然互相覆盖**：真实发生两次。对策是每个任务写死"只许改这几个文件"。
5. **长文本不要塞进工具参数**：两次"活儿干完但任务标失败"（JSON 截断）。产物写文件，参数只留路径 + 三行结论。
6. **任务会静默停机**：任务挂 `in_progress` 而成员 idle 时调度器不会重派。队长每轮要查这个状态。
