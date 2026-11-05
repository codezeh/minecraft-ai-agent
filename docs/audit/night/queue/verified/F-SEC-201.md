id: F-SEC-201
severity: high
class: secret
file: mindcraft/keys.json:2
evidence: |
  工作区里有**明文真实凭据**：`mindcraft/keys.json` 第 2 行，`OPENAI_API_KEY` 非空。

  $ cd mindcraft && node -e "const j=require('./keys.json');
      const k=j.OPENAI_API_KEY;
      console.log('非空键数:', Object.entries(j).filter(([a,b])=>b).length,
                  '| 长度:', k.length, '| 前缀:', k.slice(0,7)+'…', '| 尾4:', k.slice(-4));"
  非空键数: 1 | 长度: 67 | 前缀: sk-0aa7… | 尾4: 93c0
  指纹（便于核对同一把钥匙，不必抄明文）: sha256 前 16 位 = 7396a9cbdd8e0227
  其余 15 个键（GEMINI/ANTHROPIC/DEEPSEEK/...）全为空串。

  这把 key 是 openai 协议的**中转站凭据**：`profiles/my-local.json` 里
  `"api": "openai"` + `"url": "https://api.llmgo.net/v1"`，而 `src/models/openai.js` 走
  `getKey('OPENAI_API_KEY')`。即它直接对应一个付费/可计费账号。

  **好消息（已核实的负面结论，别重复排查）**：
  1) 未被 git 跟踪：`git -C mindcraft check-ignore -v keys.json` → `.gitignore:9:keys.json`；
     `git -C mindcraft ls-files | grep keys` → 只有 `keys.example.json`。
  2) 未进历史：`git -C mindcraft log --all --oneline -S"0aa74b14"` → 空；
     `git -C mindcraft log --all --oneline -- keys.json` → 空（从未提交过该文件）。
     根仓也搜了：`git log --all -p -S"OPENAI_API_KEY" | grep -oE "sk-[A-Za-z0-9]{20,}"` → 空。
  3) 代码不打印密钥：`grep -rnE "console\.(log|warn|error)\([^)]*getKey" mindcraft/src` → 空。
  4) 前端无硬编码凭据：`grep -rInE "sk-[A-Za-z0-9]{16,}|api[_-]?key[[:space:]]*[:=]" web/src` → 空；
     `grep -roE "sk-[A-Za-z0-9]{20,}" web/dist` → 空。
  所以风险不是"已泄露到 GitHub"，而是**明文落盘的暴露面**。
exploitability: |
  能读到这把 key 的人/进程，就能以这个账号的身份调用中转站 API（直接产生费用 / 被封号 / 冒充本机）。
  谁能读到：
  - **任何在本机执行的代码**。本部门 D1 已实证两条安装期执行路径：`postinstall: patch-package`
    （F-DEP-004，14k 行补丁 diff 无闸）与 `start.bat` 自动 `npm install`（F-DEP-012）。
    恶意 postinstall 拿到 shell 后第一件事就是读 `keys.json`。
  - 任何以当前用户身份运行的进程（无 ACL 隔离，`ls -la` 显示 644 普通权限）。
  - 备份/同步盘/压缩包：`backups/`、`.atom-v2-backup/`、`tmp/` 里都有工作区副本形成习惯，
    `keys.json` 一旦被顺手拷进这类目录（或发人排查），就脱离 .gitignore 的保护。
  影响半径：一个计费账号 + 可被冒用的模型调用额度；不涉及 Minecraft 服务器控制权。
suggested_fix: |
  **只做外部化 + 忽略 + 提醒轮换，绝不改真值**，而且本仓已经支持，零代码改动：
  1. `mindcraft/src/utils/keys.js` 的读取顺序是 `keys.json` → `process.env[name]`（第 12-15 行），
     所以把值搬到环境变量即可，不用改任何代码。
  2. 具体改法（patch-smith 执行）：
     a. 在 `mindcraft/keys.json` 里把 `OPENAI_API_KEY` 清空为 `""`（与其它 15 个键一致，
        文件本身继续被 .gitignore 忽略）；
     b. 把真值写进**用户级**环境变量（Windows）：`setx OPENAI_API_KEY "<原值>"`（由用户本人执行，
        不要把值写进任何入库文件、不要写进 .bat）；
     c. 在 `docs/audit/night/` 或 README 里写清"`keys.json` 只放空壳，真值走环境变量"。
  3. 在 `patch_integrity`/README 里明确：**永不**把 `keys.json` 拷进 backups/、tmp/、logs/。
  4. **提醒用户轮换这把 key**（本文件已被审计、已被多次读取；且 D1 存在安装期执行面）。
     轮换属于用户动作，patch-smith 不做。
  5. 顺带记录：`profiles/my-local.json`（中转站 URL + owner 名单）**已被 gitignore**（`profiles/*-local.json`），
     且里面**不含** key —— 不用动。
verify: |
  cd mindcraft
  # 1) 文件里不再有明文（值应为空串）
  node -e "const k=require('./keys.json').OPENAI_API_KEY; if(k.length){console.log('FAIL 仍有明文 len='+k.length);process.exit(1)} console.log('OK 空壳')"
  # 2) 但仍然能取到 key（来自环境变量）
  OPENAI_API_KEY=test-key node -e "import('./src/utils/keys.js').then(m=>console.log('getKey ->', m.getKey('OPENAI_API_KEY')))"
  # 期望 "getKey -> test-key"（证明外部化没把功能弄坏）
  # 3) 仍然被忽略、未入库
  git check-ignore -v keys.json && git ls-files keys.json; echo "exit=$?"
  # 4) 确认历史仍然干净（轮换后再核一次）
  git log --all --oneline -S"0aa74b14" | head -3    # 期望空
discovered_by: recon-scout
dept: D2-SEC

---
resolution: blocked（需用户先执行 setx 并验证；patch-smith · D2 修补）
原因（captain 亲自核证，我采纳）: |
  `src/utils/keys.js` 第 5 行 `readFileSync('./keys.json')` **优先**，第 14 行才回落 `process.env[name]`，
  第 17 行**取不到就 throw**（不是降级）。⇒ 若先清空 keys.json 而用户还没 setx
  （(`setx` 只对**新进程**生效且只能用户本人执行），**所有模型调用当场全崩**，不是"暂时不可用"。
  因此**今晚绝不修改 keys.json 的任何真值**。
必须由用户执行的三步（顺序不可颠倒，已写进 docs/audit/night/manual-F-SEC-201-keys-rotation.md）:
  1. setx OPENAI_API_KEY "<真值>"
  2. 新开一个进程验证: node -e "console.log(require('./src/utils/keys.js').getKey('OPENAI_API_KEY').length)" → 应返回 67
  3. 验证通过后，才允许把 keys.json 的值清成 CHANGE_ME
当前状态核证: 只有 OPENAI_API_KEY 有真值（len=67），其余 15 个键全空 ⇒ 只有一把真 key 需要轮换。
**历史泄漏提醒**: 该 key 以明文形式在磁盘上存在过（`mindcraft/keys.json:2`）。虽然 git 从未提交、代码不打印，
  但"清理代码不等于密钥安全"——**请用户轮换这把 key**（新 key 写进环境变量，旧 key 在供应商侧吊销）。

## review（gate-keeper · t14 · 2026-11-06 02:4x）
**结论：通过（blocked 成立；轮换已诚实标记）。** commit：无（需用户 setx，红线禁止 agent 改真值）。

红线核证（最高优先）：
```
node -e 读 keys.json → 长度 67 | 非空键数 1 | sha256 前16 = 7396a9cbdd8e0227
```
**与 finding 记录的指纹逐字符相同** ⇒ **真值未被动过** ✅。文件 mtime = 2026-10-18 18:42（早于今晚全部工作）⇒ 今晚无人写过它。

诚实性核证（任务点名"历史泄漏是否被标为需用户手动轮换"）：
第 82 行原文——"但'清理代码不等于密钥安全'——**请用户轮换这把 key**（新 key 写进环境变量，
旧 key 在供应商侧吊销）" ✅ **明确标了要轮换，且说明清理≠安全**，没有把遗留风险藏起来。
第 71-80 行把"为什么不能先清 keys.json"（keys.js:17 取不到就 throw）写成三步不可颠倒，与我 t13 的独立结论一致。
裁定：**通过**。轮换属用户动作，agent 不做是对的。
