id: F-REG-003
severity: medium
class: config
file: mindcraft/start.bat:76
evidence: |
  **完整性闸只拦"启动"，不拦"提交"；而且它要求 patch 与 SUMS 严格原子，
  任何一次只改一半都会让整台机器起不来（失败模式是"全断"，不是"降级"）。**

  ## 一、不对称接线（实测）
  `patch_integrity` 现在挂在**启动**路径上，一共两处：
  ```
  $ grep -n "patch_integrity" mindcraft/start.bat
  76:if exist tools\patch_integrity.mjs (
  77:    node tools\patch_integrity.mjs --no-version-check     ← 装之前先验内容（防"先执行后审计"）
  99:    if exist tools\patch_integrity.mjs (
  100:       node tools\patch_integrity.mjs                      ← 装之后验版本
  ```
  但它**不在提交门里**：
  ```
  $ node -e "const s=require('./package.json').scripts; console.log(/patch_integrity/.test(s.gate+s['gate:full']))"
  false
  gate     : node tools/settings_check.mjs && node tools/preflight_regex_unit.mjs && node tools/preflight.mjs && node tools/lint_hard.mjs
  gate:full: npm run gate && node tools/unit_all.mjs
  ```
  ⇒ **F-DEP-004 的"suggested_fix 第 3 条：接进 gate"仍未落地**（该 finding 在复核单里标着"未接线"，
  现状是"接了启动、没接提交"）。后果：错误**延迟到下一次启动才炸**，
  而且炸在用户点"启动"的那一刻，而不是 patch-smith 提交的那一刻。

  ## 二、原子性要求（这条是今天现场观察到的真实风险）
  完整性校验是 `sha256(patch) == SHA256SUMS 里记的值`。所以：
  - **只提交 patch、忘了 SUMS** → `start.bat:77` 判失败 → `exit /b 1`，**机器起不来**；
  - **只提交 SUMS、忘了 patch** → 同样失败。
  当前工作区正好处在这个状态（我审计时的实测）：
  ```
  $ git status --porcelain patches/ tools/patch_integrity.mjs
   M patches/SHA256SUMS
   M patches/mineflayer+4.39.0.patch
   M tools/patch_integrity.mjs
  ```
  patch-smith 在把复核席要求重建的 hunk 3（`place_block` 的 `timeout: 5000 → 500`）补回去，
  **工作区这一对是自洽的**（我跑过：`✓ 5 个补丁内容与基线一致`、`✓ patch_integrity 通过`，exit 0），
  但**只要这两个文件里有一个没进同一个 commit，下一次启动就是硬失败**。
  另外我也核了 **HEAD 自身是自洽的**，不会现在就炸：
  ```
  $ git show HEAD:patches/mineflayer+4.39.0.patch | sha256sum
  f46c3e04…00 *-
  $ git show HEAD:patches/SHA256SUMS | head -1
  f46c3e04374e677c15711436f296c4ffc5d5cd700c5ca53374081a5dc2a44700  mineflayer+4.39.0.patch   ← 完全一致
  $ git show HEAD:patches/mineflayer+4.39.0.patch | grep -cE "place_block|timeout: 500$"
  0                     ← HEAD 里还没有 hunk 3（那是工作区的在途工作）
  ```

  ## 三、错误信息把人引向错误的自由裁量
  `start.bat:79` 的提示是：
  > `[ERROR] patch integrity FAILED - patches/ may be tampered or missing. Aborting BEFORE install.`

  它无法区分两种完全不同的情况：
  - (a) 真被篡改（该报警，该停）；
  - (b) **只是有人改了 patch 忘了更新 SUMS**（正常的开发中间态，重跑 `--write` 即可）。
  两者都表现为"机器起不来 + 说你可能被投毒"，最容易诱发的自救是**把这段检查注释掉**——
  那等于把 F-DEP-004 的整个价值扔掉。
exploitability: |
  攻击者视角：无直接收益。
  开发/运维视角：这是一个**failure-mode 设计问题**——安全闸如果"误报一次就让人想关掉它"，
  它的长期存活率是零。今晚已经出现过一次同类（F-DEP-003 的 4.33.0 补丁不匹配 ⇒ `npm ci` 失败
  ⇒ 有人会想用 `--ignore-scripts` 绕过），本条是同一种东西换了个闸。
  影响半径：每次改补丁；触发即"启动不了"，且提示指向"可能被投毒"。
  定 medium：不是漏洞、不是数据风险，但它是**我们自己新加的、会拦住主路径的闸**，
  且当前工作区正处"必须原子提交"的时刻 —— 值得在提交前提醒一次。
suggested_fix: |
  1. **把 `patch_integrity` 接进 `gate`**（F-DEP-004 的原定修法，一行）：
     ```json
     "gate": "node tools/patch_integrity.mjs && node tools/settings_check.mjs && node tools/preflight_regex_unit.mjs && node tools/preflight.mjs && node tools/lint_hard.mjs"
     ```
     这样 pre-commit（`.githooks/pre-commit` 跑 `npm run gate`）会在**提交时**发现
     "patch 与 SUMS 不同步"，而不是等到用户启动时。
  2. **`start.bat` 的错误信息分类**（改文案，不改逻辑）：
     ```bat
     echo [ERROR] patch integrity FAILED.
     echo         若你刚改过 patches/ 却没更新基线，先跑： node tools\patch_integrity.mjs --write
     echo         若你没改过补丁，则 patches/ 可能被篡改 —— 请先 git diff patches/ 再决定。
     ```
     给"正常中间态"一条明确的出路，同时保留"可能被篡改"的告警。
  3. **给 patch_integrity 加一个一致性自检**：若 SUMS 里引用的文件名在 patches/ 下不存在，
     或 patches/ 下有 .patch 不在 SUMS 里，报"基线过期（需要 --write）"而不是"被篡改"。
     （这两种错误应该有不同的 error code，让上层能给不同建议。）
  4. 提交纪律（写进 manifest）：**patch 与其 SUMS 必须同一个 commit**，commit body 里写明
     "本 commit 同时更新 X.patch 与 SHA256SUMS"。
verify: |
  cd mindcraft
  # 1) 已接进 gate
  node -e "const s=require('./package.json').scripts; console.log('含 patch_integrity?', /patch_integrity/.test(s.gate))"
  # 期望 true
  # 2) 提交时会拦：故意只改 patch 不改 SUMS，然后跑 gate
  cp patches/protodef+1.19.0.patch /tmp/p.bak && printf '\n' >> patches/protodef+1.19.0.patch
  npm run gate; echo "gate exit=$? （期望非 0，且点名 protodef）"
  cp /tmp/p.bak patches/protodef+1.19.0.patch
  npm run gate; echo "gate exit=$? （期望 0）"
  # 3) 基线过期 vs 被篡改 能区分
  node tools/patch_integrity.mjs; echo "exit=$?"    # 正常态必须 0
  # 4) start.bat 的新提示能被读到（人工：临时篡改补丁后双击 start.bat，看提示是否给出 --write 出路）
discovered_by: recon-scout
dept: REG
