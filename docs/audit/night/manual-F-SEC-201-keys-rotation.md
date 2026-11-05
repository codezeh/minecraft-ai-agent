# 用户手册 · `F-SEC-201` API key 轮换（三步，顺序不可颠倒）

> 起草：patch-smith（D2 修补轮）｜2026-11-06
> 状态：**待用户执行**（agent 不执行：`setx` 只对用户自己的新进程生效，且不得改真值）
> 对应 finding：`F-SEC-201`（`mindcraft/keys.json:2` 明文真实 key）

---

## 0. 为什么 agent 不能替你做

`mindcraft/src/utils/keys.js` 的读取顺序是**硬编码**的：

```js
第  5 行  readFileSync('./keys.json')      // keys.json 优先
第 14 行  ... 取不到才回落 process.env[name]
第 17 行  throw new Error("API key ... not found")   // ← 不是降级，是抛异常
```

⇒ 如果**先**把 `keys.json` 清空、而环境变量还没设好，**所有模型调用当场全部抛错**（不是"暂时不可用"，
是每次对话、每次任务规划都失败）。而 `setx` 只对**新开的进程**生效、且只能由你本人执行 ——
所以这三步必须由你按顺序做，顺序颠倒会直接把 bot 打死。

---

## 1. 三步（照抄，不要跳步）

```powershell
# 第 1 步：把真值写进用户级环境变量（在 PowerShell 里执行；值请从 keys.json 里自己复制）
setx OPENAI_API_KEY "<你的真值>"

# 第 2 步：验证（必须新开一个终端窗口 —— setx 对已开的窗口无效）
#   注意：keys.js 用 `readFileSync('./keys.json')`，路径是**相对 cwd** 的，所以必须先 cd 到 mindcraft/
cd E:\我的世界ai\mindcraft
node -e "import('./src/utils/keys.js').then(m=>console.log('len =', m.getKey('OPENAI_API_KEY').length))"
# 期望输出：len = 67   ← 与当前 keys.json 里那把 key 的长度一致

# 第 3 步：确认第 2 步输出 67 之后，**才**把 keys.json 的值改成占位符
#         把 mindcraft/keys.json 的 "OPENAI_API_KEY" 值替换为： CHANGE_ME
```

> 第 2 步用的是 `keys.js` 真实导出的 `getKey(name)`（已核：`src/utils/keys.js:11`）。
> 它在取不到 key 时会 **throw**（`:17`，不是降级）—— 所以"第 2 步输出 67"是**唯一**可以往下走的信号。
> 若第 2 步抛 `API key "OPENAI_API_KEY" not found`，说明 `setx` 还没生效（多半是没开新终端）⇒ 回到第 1 步，**不要**动 keys.json。

---

## 2. 还必须做的一件事：**轮换这把 key**

清理 `keys.json` **不等于**这把 key 安全了。它曾以明文形式存在于磁盘（`mindcraft/keys.json:2`），
虽然：

- `keys.json` 被 `mindcraft/.gitignore:9` 忽略、**从未进过 git 历史**（侦察兵已核）；
- 代码不打印它、`web/` 无硬编码（已核）；
- 但它就躺在磁盘上，任何能读该文件的本机进程（含被投毒依赖的安装脚本、见 `F-DEP-004/012`）都能取走。

⇒ **请到供应商控制台吊销旧 key 并新建一把**，新 key 直接写进环境变量（不要回填 `keys.json`）。

---

## 3. 现状核证（给你一个对照基准）

- 只有 `OPENAI_API_KEY` 有真值（长度 67）；其余 15 个键当前为空。
- 所以**只有一把 key 需要轮换**。
- `keys.json` 的路径：`E:\我的世界ai\mindcraft\keys.json`（第 2 行）。

---

## 4. 做完之后的验证

```bash
cd "E:/我的世界ai/mindcraft"
# 1) keys.json 里不应再有 sk- 开头的真值
grep -c "sk-" keys.json          # 期望 0
# 2) 环境变量已就位（新进程）
node -e "console.log((process.env.OPENAI_API_KEY||'').length)"   # 期望 67
# 3) bot 仍能起（模型调用不抛 key not found）
npm start                        # 起来后发一条对话，确认有正常回复
```

> 若第 3 步失败且报 `API key ... not found`，说明第 1/2 步没生效（多半是没开新终端）——
> 此时**先把它改回**：把 `CHANGE_ME` 换回原值，再去排查环境变量。
