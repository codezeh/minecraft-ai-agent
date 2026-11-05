id: F-EXEC-110
severity: low
class: config
file: mindcraft/src/agent/tasks/construction_tasks.js:738,741
evidence: |
  `embellishments()` 把 z 轴参数当成 x 轴喂给了开窗函数，所以程序化生成的房子**没有窗户**：
    :731  function embellishments(carpet, windowStyle, matrix, newX, newY, newZ, newLength, newWidth, newDepth, material) {
    :738      addWindowsAsSquares(matrix, newZ, newY, newZ, newLength, newWidth, newDepth, material)
    :741      addWindowsAsPlane(matrix,   newZ, newY, newZ, newLength, newWidth, newDepth, material)
  第 2 个坐标参数应为 `newX`（对比同函数 `:749`/`:752` 的 `addCarpet` **传的是 `newX`**，写法正确）。
  于是两处开窗都被算到错误的轴上：窗户要么整体落在墙体范围外（被后续方块覆盖）、要么偏到相邻墙面上，
  最终表现"所有程序化生成的房子都没有窗户"。
  出处：docs/audit/08-deep-executor-flows.md §6 Should **E4**；
  docs/audit/00-REPORT.md §十二 第 11 项（v2.1 登记，写明 `:738`/`:741` 两侧行号对照）；
  docs/audit/12-world-storage-schematic.md §6.2「E4 维持」复核意见。
  本轮在当前代码复核：**仍存在**（`:738`/`:741` 逐字为 `newZ, newY, newZ`）。
exploitability: |
  无攻击面，是输出质量缺陷：建造任务生成的房子没有窗户（功能性/美观性损失），
  而且**不报错**（`addWindows*` 照常执行、方块照常写进 matrix），所以只能靠人肉看结果发现。
  影响半径：`construction_tasks.js` 的程序化建房（离线生成器，跑一次即结束，不在常驻链路）→ low。
  但它与本单的邻条（F-EXEC-109/F-EXEC-111）同属"这个 1104 行文件基本没被门禁覆盖"这一结构事实。
suggested_fix: |
  `:738` / `:741` 的第 2 个坐标参数 `newZ` → `newX`（两处各改一个标识符）：
  ```js
  addWindowsAsSquares(matrix, newX, newY, newZ, newLength, newWidth, newDepth, material)
  addWindowsAsPlane(matrix,   newX, newY, newZ, newLength, newWidth, newDepth, material)
  ```
  **改前先确认 `addWindowsAsSquares/Plane` 的签名**（第一个坐标参数到底是 x 还是"沿哪条轴的起点"）：
  `grep -n "function addWindowsAsSquares" -A6`。若它的语义是"沿 matrix 第一维"，则修法是把调用改成
  传 `newX` 并同时核对 `newLength/newWidth` 的顺序 —— 这一步必须看函数体，不要只靠本单的推测。
verify: |
  cd mindcraft
  grep -n "addWindowsAsSquares(matrix, newZ\|addWindowsAsPlane(matrix, newZ" src/agent/tasks/construction_tasks.js
  # 期望 0 命中（改后）
  # 行为（离线生成）：生成一栋 windowStyle=1 的房子 → 统计玻璃块数量
  node -e "
    const m = await import('./src/agent/tasks/construction_tasks.js');
    // 按本文件已有入口生成一次 → 打印统计里的玻璃块数
  "
  # 期望：玻璃块数 > 0（改前为 0）
discovered_by: patch-smith(from history)
dept: D3-EXEC
