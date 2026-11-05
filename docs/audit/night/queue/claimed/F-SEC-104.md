id: F-SEC-104
severity: medium
class: path
file: mindcraft/src/mindcraft/mindserver.js:150,183-184
evidence: |
  贴图代理的路径参数只做了 `toLowerCase()`，没有任何字符集/前缀校验：
    :146  app.get('/assets/item/:agent/:name.png', async (req, res) => {
    :149      const rawName = req.params.name;
    :150      const itemName = String(rawName).toLowerCase();        ← 唯一处理
    :183      guessPaths.push(path.join(base, 'items', `${itemName}.png`));
    :184      guessPaths.push(path.join(base, 'blocks', `${itemName}.png`));
    :189-192  for (const p of guessPaths) { const buf = fsMod.readFileSync(p); … res.end(buf); }
  Express 会 `decodeURIComponent` 路由参数 → `..%2f..%2fsettings` 变成 `../../settings`，
  `path.join` 归一化后跳出 `assets.directory`。
  **本轮的一处口径修正（比 R2 更准确）**：R2 写"已部分缓解：端点现已在握手门后"——
  这句对 HTTP 路由不成立。`mindserver.js:85-92` 的 `app.use` 只做一件事：
  `?token=` 正确时 `Set-Cookie`，然后**无条件 `next()`**，从不拒绝请求；
  握手门 `io.use(makeHandshakeGate)`（`:103`）只管 socket.io。
  ⇒ 本条是**不需要任何认证**的 HTTP 端，攻击面仍是"本机任意进程/任意页面"。
  该文件另有一条同族旁证：`app.use(express.static(...))`（`:143`）与 `/console`（`:207`）同样无 token 校验。
  出处：docs/audit/03-interface-security.md I17；docs/audit/21-review-r2-verdict.md §3 R2-4（待修）；
  docs/audit/00-REPORT.md §四 4.1 I17「仍存在」。本轮复核：仍存在。
exploitability: |
  前置：能在本机发 HTTP 请求（任意脚本、任意 `http://localhost:<任意端口>` 的页面 —— 页面受同源限制拿不到响应体，
  但脚本/本机进程没有这层限制；`local_only.js` 的 Origin 判据只作用在 socket.io 的 `allowRequest`，不在 HTTP 上）。
  能拿到什么：**任意 `.png` 文件的字节**（扩展名被硬拼，所以只能读 png）；
  再加 `Content-Type: image/png` 的响应可被当作图片资源 → 可以读 `C:/Users/<me>/Pictures/**`、`web/dist/**` 里的 png。
  再看一层：`:167-176` 的 `assets.textureContent` 分支正常返回，走到 `:183` 的只有"包内找不到"的情况，
  所以这条路的**命中率**取决于 `itemName` 能否穿出 `assets.directory` —— 能穿出时就变成任意 png 读取。
  影响半径：中等（只限 png），但它是"面板 HTTP 端完全无鉴权"的第一个实证点，与 F-WEB-001 同源。
suggested_fix: |
  `:150` 之后加两行（并在两个出口共用）：
    ```js
    if (!/^[a-z0-9_]{1,64}$/.test(itemName)) { res.status(400).end(); return; }
    ```
  或更稳：拼完 `guessPaths` 后对每个 `p` 断言 `p.startsWith(path.resolve(base) + path.sep)`，不满足就跳过。
  两条都做最保险（前者挡注入形状，后者挡归一化绕过）。
  **顺带（同一处，可选但便宜）**：给 `app.use` 加一个"无 cookie 就 401"的中间件，只放行 `/`（带 `?token=`）
  与 `/console` 的入口页，能把"面板 HTTP 端零鉴权"这个更大的面一起收掉 —— 若要动，属另一个 finding，先别混在一起。
verify: |
  # 静态：正则或前缀断言在位
  cd mindcraft && grep -n "test(itemName)\|startsWith(path.resolve(base)" src/mindcraft/mindserver.js   # 期望 ≥1 命中
  # 行为：起服务后
  curl -s -o /dev/null -w "%{http_code}\n" "http://localhost:8080/assets/item/deepseek/..%2f..%2f..%2fsettings.png"   # 期望 400
  curl -s -o /dev/null -w "%{http_code}\n" "http://localhost:8080/assets/item/deepseek/stone.png"                       # 期望 200（正常路径不受影响）
discovered_by: patch-smith(from history)
dept: D2-SEC

---
status: fix-ready-awaiting-commit（patch-smith · D2 修补）
see: docs/audit/night/manifest-D2.md 的对应小节（改动清单 + commit message 草稿 + 自检证据 + 回滚）
