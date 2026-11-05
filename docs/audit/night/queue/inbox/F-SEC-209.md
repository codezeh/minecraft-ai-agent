id: F-SEC-209
severity: low
class: config
file: server/server.properties:7
evidence: |
  `broadcast-rcon-to-ops=true`（第 7 行）会把**每一条 RCON 命令回显到所有 op 的聊天里**。
  本机 op 名单有 **341 个账号**（全 level 4，见 `F-SEC-204` 复核），也就是说：

  - 任何运维动作（`stop` / `op <名字>` / `whitelist off` / `fill` …）都会广播给 341 个账号；
  - 一旦 `F-SEC-204` 那条路被用上（离线模式冒用 op 名字进服，或白名单被临时关掉），
    冒名者不需要猜运维习惯 —— 聊天记录会直接告诉他管理员在做什么、用什么参数；
  - 与 `F-SEC-202`（RCON 对外暴露）叠加时，这条是"侦察便利"而非"入口"。

  实测：
  ```
  $ grep -nE "^broadcast-rcon-to-ops" server/server.properties
  7:broadcast-rcon-to-ops=true
  ```

  **前置核证（captain 要求）：`server-net.mjs apply` 会不会把它冲掉？——不会。**
  我读了 `tools/server-net.mjs` 的实现，`apply` 只改 4 个键：
  ```js
  function desiredProps(one) {
      return {
          'server-ip': ...,
          'white-list': ...,
          'enforce-whitelist': ...,
          'online-mode': ...,
      };
  }
  /** 只改指定键，其余行（含注释与顺序）原样保留。 */
  function patchProperties(text, kv) { ... }   // 只替换 kv 里出现的键
  ```
  ⇒ `broadcast-rcon-to-ops` **不在 `desiredProps` 里**，`patchProperties` 会原样保留该行。
  **所以本条不需要标 `blocked`，是可直接生效的配置修改。**

  ⚠️ 一个必须同时记录的副作用：`patchProperties` 用 `text.split(/\r?\n/)` 再 `join('\n')`，
  即**每跑一次 `apply` 都会把该文件的 CRLF 归一成 LF**（内容不变，行尾符变）。
  本仓刚因 `core.autocrlf` 吃过一次 CRLF 事故（见 `baseline.md` R0.6），所以：
  **如果同时要改 `server.properties`，优先手改这一行、不要为了它去跑 `apply`**，
  以免顺带把整个文件的换行符改掉、制造一个几百行的假 diff。

exploitability: |
  本身不构成入口，是**信息泄露放大器**：
  - 341 个 op 账号里绝大多数是测试 bot（`v57665` / `tgt2207` / `s2bench914` 之类），
    但它们**现在不在白名单里**，所以正常情况登不进来 —— 这条风险目前是**潜在**的；
  - 触发条件：白名单被关（`config/network.json` 的 test 段默认就是 `whiteList: false`，
    main→test 切换只要改一个字），或 `F-SEC-204` 的冒名路径被打通；
  - 一旦触发，运维动作对 341 个账号可见 ⇒ 攻击者知道何时动手、管理员在做什么。
  影响半径：信息面，不是控制面。

suggested_fix: |
  一行配置：

  ```properties
  # server/server.properties 第 7 行
  broadcast-rcon-to-ops=false
  ```

  - **手改这一行即可**，不要为此跑 `server-net.mjs apply`（理由见 evidence 里那条 CRLF 副作用）。
  - **不改 `enable-rcon`**、不改 `rcon.port`、**不改 `rcon.password`**（红线）。
  - 改完**无需重启**也可生效（该键在运行时由服务端读取；保守起见建议下次重启时一并生效并观察）。
  - 若用户确实需要"op 能在聊天里看到 RCON 回显"（例如自己看运维日志），则本条降级为
    "记录并接受"，在 `config/network.json` 的说明里加一句即可 —— **不要静默放着不管**。

verify: |
  1. **配置已改且未被冲掉**：
     ```bash
     grep -nE "^broadcast-rcon-to-ops" server/server.properties
     ```
     期望 `7:broadcast-rcon-to-ops=false`。
  2. **确认 apply 不会冲回去（回归）**：
     ```bash
     cd mindcraft && node tools/server-net.mjs apply --dry
     grep -nE "^broadcast-rcon-to-ops" ../server/server.properties
     ```
     期望 `--dry` 不写盘，且该行仍是 `false`。
     （若真的跑了 `apply`：再用 `git diff --stat server/server.properties` 确认**只有预期的键变化**，
      并检查是否出现"整个文件换行符变了"的假 diff。）
  3. **运行时确认（需重启服务器后）**：
     用本机 RCON 执行一条无害命令（如 `list`），观察 op 聊天里**不再出现**该命令回显。
     注意：本机 RCON 调用方式见 `F-SEC-202` 手册 §3（`rcon_client.js` 的 `rcon('list')`）。
  4. **反向验证（防"改了值但没生效"）**：
     临时改回 `true` → 确认 `list` 命令又出现在 op 聊天里 → 再改回 `false`。
     **不出现变化说明该键被别处覆盖**（例如 `server-net.mjs` 之外的脚本或 properties 有多份），要查清再说"修好"。

discovered_by: gate-keeper
note: |
  captain 要求的前置核证已做并写进 evidence：`server-net.mjs apply` **不会**冲掉本键
  （它只写 `server-ip` / `white-list` / `enforce-whitelist` / `online-mode` 四个键，
  其余行原样保留）⇒ **本条不标 blocked，可直接修**。

  但请把"apply 会归一 CRLF"这条副作用一并告知 patch-smith：本仓刚经历过一次 CRLF 事故，
  任何人跑 `apply` 都应对 `git diff --stat` 多看一眼。

---
resolution: delivered-on-disk（patch-smith · D2 修补）
已做: `server/server.properties:7` `broadcast-rcon-to-ops=true` → `false`（**手改，未跑 server-net.mjs apply**）。
自检: |
  $ grep -nE "^broadcast-rcon-to-ops" server/server.properties → 7:broadcast-rcon-to-ops=false
  行尾符未被改动：文件仍是 CRLF（64 行 / 64 个 CR 字节），改动只 +1 字节（true→false）。
  其余键未被触碰：enable-rcon=true / rcon.port=25575 / rcon.password=<未动> / server-ip=(空) —— 逐条核过。
⚠️ **重要：`server/server.properties` 被 `.gitignore:74` 排除 ⇒ 这次修改进不了 git**（与 F-DEP-103 同类）。
  它不是"被遗忘"，而是"含明文 RCON 口令所以刻意不入库"。代价：该配置**没有版本历史、不可回滚**，
  换机器/重装后这条修改就没了。建议在 `config/network.json` 或 README 的"暴露面清单"里记一句
  "broadcast-rcon-to-ops 应为 false（2026-11-06 审计）"，否则下次重建 server.properties 会回到 true。
未做（红线/需重启）: 未改 enable-rcon / rcon.password；生效需下次重启或服务端重读配置。

## review（gate-keeper · t14 · 2026-11-06 02:4x）
**结论：打回（needs_revision）。** 修复本身正确，但**在 git 里不可见，且唯一入库的参照仍指向危险值**。

我核证了"改对了"的部分：
```
rcon.password 与 11-02 备份逐字节相同（281687d797644ed3）⇒ 只动了目标键 ✅
CR 数 64 ⇒ 仍 CRLF，没顺手改行尾符 ✅
文件 1504 字节（true→false 正好 +1 字节）✅
```

**两个问题：**
1. `server/server.properties` 被 `.gitignore:74` 排除（`git check-ignore -v` 实命中）
   ⇒ **修复只存在于磁盘**，换机/重部署即丢，与 `F-DEP-103` 同类问题。
2. **更严重**：被 git 跟踪的 `server/server.properties.example` **仍写着 `broadcast-rcon-to-ops=true`**
   （我实测两文件：example:7 = `true`，实际:7 = `false`）⇒ 仓库里唯一可见的参照**指向危险值**，
   任何人照 example 建新环境都会把这条修复退回去。patch-smith 自己在交接里建议"同步进 example"，
   **但没有做**。

**requiredFix（一条，成本 1 行）**：把 `server/server.properties.example:7` 改成
`broadcast-rcon-to-ops=false` 并提交（该文件**是被跟踪的**，所以这条修复能真正入库）。
另建议在 example 里加一行注释说明"RCON 回显不要开给 op"。
> 说明：本条打回**不否定**磁盘上那次手改（它是对的），只否定"改完就算了"——因为它在版本控制里等于没改。
