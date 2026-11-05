id: F-EXEC-102
severity: high
class: config
file: mindcraft/src/mindcraft/mindserver.js:438-447
evidence: |
  mindserver 退出时不回收 agent 子进程，也不等它们真退出：
    :438  socket.on('shutdown', () => {
    :440      for (let agentName in agent_connections) { mindcraft.stopAgent(agentName); }
    :444      setTimeout(() => { console.log('Exiting MindServer'); globalThis.process.exit(0); }, 2000);
  实测两条：
    $ grep -rn "process.on('exit'\|process.on('SIGINT'\|process.on('SIGTERM'" mindcraft/src --include=*.js
    （0 命中 → 没有任何信号处理器走"优雅回收子进程"这条路；Ctrl-C 直接死）
  `stopAgent` 只发 SIGINT，**不 await 子进程 exit**，2 秒后硬 `process.exit(0)`。
  出处：docs/audit/03-interface-security.md I7；docs/audit/21-review-r2-verdict.md §3 **R2-1（收录待修，Should）**，
  §10 给出最小修法；docs/audit/00-REPORT.md §四 4.1 I7「仍存在」；两轮复核（t25/t26）都判"仍存在"。
  本轮在当前代码复核：**仍在**（`setTimeout(2000)` 与 `process.exit(0)` 逐字未变，`process.on` 仍 0 处）。
exploitability: |
  不需要攻击者 —— 这是**运维必然触发的缺陷**，后果落在任务板上：
  主控（mindserver）被杀/崩溃后，agent 子进程变成孤儿继续跑；它手上还握着 `board_client`
  的租约与心跳（`heartbeat()` 会续租），于是：
  ① 面板已经连不上、显示"离线"，但**单子仍在被孤儿领走并执行**；
  ② 第 4 条（finish 校验租约）与第 6 条（`!stop`）的防护在"没有主控"的场景下全部失效 ——
     玩家按停、面板停单都到不了孤儿；
  ③ 再启动一个 mindserver 时，两个进程争同一份 `board.sqlite` 与同一只 MC bot 的会话。
  影响半径：整晚挂机任务的正确性（"面板看着正常但停不掉"）。
suggested_fix: |
  `mindserver.js:438-447` 改成（≈5 行）：
  ```js
  socket.on('shutdown', async () => {
      const exits = Object.keys(agent_connections).map(n => mindcraft.stopAgent(n));
      await Promise.race([Promise.allSettled(exits), new Promise(r => setTimeout(r, 5000))]);
      console.log('Exiting MindServer'); globalThis.process.exit(0);
  });
  // 同一路径接上信号：
  for (const sig of ['SIGINT', 'SIGTERM']) globalThis.process.on(sig, () => { /* 复用上面的 shutdown */ });
  ```
  前提：`stopAgent` 需要返回一个"子进程 exit 时才 resolve"的 promise（或额外暴露 `waitAgentExit(name)`）。
  若今晚不想改 `stopAgent` 的签名，最小版：把 `setTimeout(2000)` 提到 `8000` 并在每个 agent 的
  `child.on('exit')` 里减计数器，计数器归零即 exit。
verify: |
  cd mindcraft
  grep -c "process.on('SIGINT'" src/mindcraft/mindserver.js     # 期望 ≥1
  # 真实回收：起 mindserver + 1 agent，Ctrl-C（或发 shutdown）后
  node -e "require('child_process').execSync('tasklist /FI \"IMAGENAME eq node.exe\" /FO CSV',{stdio:'inherit'})"
  # 期望只剩 0~1 个 node（= 刚启动的那个查询进程），没有残留的 agent
  npm run gate                                                  # 与基线一致
discovered_by: patch-smith(from history)
dept: D3-EXEC
