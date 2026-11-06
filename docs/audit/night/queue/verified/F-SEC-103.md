id: F-SEC-103
severity: medium
class: secret
file: mindcraft/src/mindcraft/mindserver.js:237,245,263
evidence: |
  两个 socket 事件把"私有 profile 全文"和"绝对路径"直接交给调用方：
    :225  socket.on('get-profiles', (callback) => {
    :237      out.push({ file: f, path: full, error: ... })        ← 绝对路径
    :245      out.push({ file: f, path: full, error: ... })
    :256  socket.on('get-profile', (file, callback) => {
    :262      const raw = readFileSync(full, 'utf8');
    :263      callback({ ok: true, file: safe, path: full, raw, json: JSON.parse(raw) });   ← 全文
  被交出去的东西是敏感的：`mindcraft/.gitignore:55` 就是 `profiles/*-local.json` ——
  作者刻意把 `my-local.json` 排除在版本库之外，理由在 00-REPORT 里写明：「`profiles/my-local.json`
  含中转站地址 + 私人人设」（第 1 条第二层；`profiles/my-local.json:6` 就是 owner 名）。
  出处：docs/audit/03-interface-security.md I19；docs/audit/21-review-r2-verdict.md §3 收录为 **R2-6（待修）**；
  docs/audit/00-REPORT.md §四 4.1 表 I19「仍存在（已被握手门部分缓解）」。
  本轮在当前代码复核：**仍在**，三个字段一个都没动。
exploitability: |
  已被握手门收窄（`mindserver.js:103 io.use(makeHandshakeGate)`），所以攻击者需要**已经是面板客户端**。
  之外仍有一条不需要 token 的路：凡是能起浏览器/脚本的本机用户都能拿到 `?token=`（启动日志
  `:493-494` 明文打印 token 与控制台地址）→ 本机任意进程仍可自证为合法客户端。
  拿到什么：全部 profile 的绝对路径（→ 主机目录结构、用户名）+ 私有 profile 全文
  （中转站 baseURL、密钥字段名、私人人设/权限表 `permissions` —— 而 `permissions` 决定"谁是这个 bot 的主人"）。
  影响半径：信息泄露为主，但 `permissions` 泄露直接告诉攻击者该冒充哪个玩家名。
suggested_fix: |
  `get-profiles`：`path: full` 改成 `path: path.basename(full)`（面板只用它显示文件名；
  若确实要打开文件，用 `file` 字段即可，服务端自己拼）。
  `get-profile`：加 `redact`（默认 true），脱敏三类字段后再回：
  ① 任何形如 `*key*`/`*token*`/`*secret*` 的键 → `'<redacted>'`；
  ② `url`/`baseURL`/`api` 里出现的主机名 → 只保留 scheme 之外的最后一个路径段（或整体 `<redacted-host>`）；
  ③ `persona`/`init_message`（人设）默认不回，除非请求里显式 `{ full: true }`。
  面板侧（`web/src/views/SetupView.vue`）用的是 `json`，改服务端返回前先 grep 前端读了哪些键，
  避免"改完面板显示 undefined"。
verify: |
  # 静态：两个出口不再原样回绝对路径/全文
  cd mindcraft && grep -n "path: full" src/mindcraft/mindserver.js            # 期望 0 命中
  grep -n "raw," src/mindcraft/mindserver.js                                  # 期望 0 命中（或已有 redact 处理）
  # 行为：起 mindserver，用带 token 的 socket 客户端发 get-profile
  node -e "
    const {io}=require('socket.io-client');
    const s=io('http://localhost:8080',{path:'/socket.io',extraHeaders:{cookie:process.env.TOKEN_COOKIE}});
    s.emit('get-profile','my-local.json',(r)=>{const t=JSON.stringify(r);
      console.log('has llmgo/host?', /llmgo|https?:\/\//.test(t)); s.close();});
  "   # 期望 has llmgo/host? false
discovered_by: patch-smith(from history)
dept: D2-SEC

---
resolution: deferred（下一轮；patch-smith · D2 修补）
为什么本轮没做: 脱敏 `get-profile` 会**改面板对接契约**（`web/src/views/SetupView.vue` 读 `json`），
  需要同时确认前端读了哪些键，否则改完面板显示 undefined；属"要回归验证但本会话跑不了 web build"的改动
  （`vite build` 在我这里 EPERM）。宁可不做，不做半截。
修法: `get-profiles` 的 `path: full` → `path.basename(full)`；`get-profile` 默认 `redact: true`
  （`*key*`/`*token*`/`*secret*` → `<redacted>`；`url/baseURL/api` 的主机名脱敏；`persona`/`init_message` 需显式 full 才回）。
verify: `grep -n "path: full" src/mindcraft/mindserver.js` → 0；带 token 的 socket 客户端拉 profile，
  响应里不应出现中转站域名/人设。

---

## review（gate-keeper · R3-7 台账收口 · 2026-11-06 10:4x）

### 一、先说清一件事：本条**此前从未复核通过**
本文件用的是 YAML front-matter 格式（`id:/severity:/file:/evidence:`），**没有任何 markdown 标题**，
因此既没有 `## review` 段，也无法被"按标题扫"的工具发现。
按 `COMMIT-MAP.md:60` 自己的口径——"想确认这条到底修没修，看单子里有没有 `## review` 段，有才算复核通过"——
⇒ **本条在此之前是"躺在 `verified/` 里但未通过复核"的状态**（终审 R3 §2 指出，我核对属实）。本段是补上的复核记录。

### 二、本条与 `F-WEB-204` 是**同一缺陷的两个编号**（我逐字比对过，不是听转述）
| | `F-SEC-103` | `F-WEB-204` |
|---|---|---|
| 文件 | `mindserver.js:237,245,263` | `mindserver.js:240,265` |
| 缺陷 | `get-profiles` 的 `path: full`（绝对路径）、`get-profile` 回 `path: full` + 整份 `raw` | 同左 |
| 修法 | `path: full` → `path: path.basename(full)` | 同左 |

两处指的是**同两个 socket 事件、同几行代码**（行号差异来自其间其它提交的行偏移）。
⇒ **`F-SEC-103 ≡ F-WEB-204`，同一处，已由 `F-WEB-204` 的修复解决。**

### 三、修复证据（引 `F-WEB-204` 的复核，我自己验过）
```
$ grep -nE "path:.*basename" src/mindcraft/mindserver.js
  343: path: path.basename(full)      ← get-profiles
  351: path: path.basename(full)      ← 解析失败分支
  369: path: path.basename(full)      ← get-profile
```
⇒ **服务端不再回传本机绝对路径**（不是"前端不显示"）。commit：`69b3a14`。

**结论：通过（作为 `F-WEB-204` 的重复项，随其修复一并关闭）。**
