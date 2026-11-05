id: F-EXEC-107
severity: low
class: config
file: mindcraft/src/utils/loop_lag.js:28-48
evidence: |
  loop lag 探针只保留**历史最大值**，永不衰减：
    :28  let maxLagMs = 0;
    :36      const lag = now - lastTick - INTERVAL_MS;
    :39      if (lag > maxLagMs) { maxLagMs = lag; maxLagAt = new Date(now).toISOString(); }
    :55  export function loopLagStats() { return { maxLagMs, maxLagAt, samples, since: … }; }
    :58  `事件循环延迟最大 ${s.maxLagMs}ms`  + (maxLagMs >= 2000 ? '（该数值很大，说明主线程确实被占用）' : …)
  于是**一次** 2 秒以上的抖动之后，`describeLoopLag()` 永远输出"该数值很大，说明主线程确实被占用"。
  这条探针的存在理由（文件头 `:1-17`）是"下次出问题别再猜"，但它给出的稳态结论会一直是错的。
  出处：docs/audit/03-interface-security.md I15；docs/audit/21-review-r2-verdict.md §3 **R2-3（收录待修）**、§10 最小修法
  （"改用 `perf_hooks.monitorEventLoopDelay` + 滑动窗口（不取历史最大）"）；
  docs/audit/00-REPORT.md §四 4.1 I15「仍存在」。本轮复核：**仍在**（`maxLagMs` 仍单调）。
  旁证：mindcraft 的 `run-live.log:39` 那句"事件循环延迟最大 162ms（正常，不是阻塞导致）"就是本函数输出的，
  一旦那台机器曾抖过一次，这句话就再也不会出现。
exploitability: |
  无攻击面。危害是**诊断失能**：这条探针是"ping timeout → 断连 → 重启"那条链（第 7 条）唯一的量化依据；
  它一旦永久误报，下一次真出现主线程阻塞时，读日志的人会看到"（正常，不是阻塞导致）"或
  相反的"该数值很大"（实际是三天前的一次抖动），两个方向的误判都会把排查带偏。
  与第 26 条（preflight 假绿灯）是同一类"观测层说谎"，只是这里说的是"最大值"而不是"通过"。
suggested_fix: |
  `mindcraft/src/utils/loop_lag.js` 换成滑动窗口（不新增依赖，`perf_hooks` 是内置）：
  ```js
  import { monitorEventLoopDelay } from 'node:perf_hooks';
  const h = monitorEventLoopDelay({ resolution: 20 });   // 纳秒精度直方图
  export function startLoopLagWatch() { h.enable(); }
  export function loopLagStats() {
      // 取"最近 5 秒"的窗口：每秒拍一次快照后 reset，窗口内取最大
      const p95 = h.percentile(95) / 1e6, max = h.max / 1e6;
      return { p95Ms: Math.round(p95), maxMs: Math.round(max), samples: h.count };
  }
  ```
  若不想换实现，最小改法是：`setInterval` 里每 60 拍（30 秒）`maxLagMs = 0` 重置一次，
  并把字段名改成 `maxLagMsSinceResetMs` + 在 `describeLoopLag()` 里写出窗口长度（"最近 30 秒最大 …"）。
  两种都行，**关键是输出必须带上"窗口"**，否则读者无法判断这个最大值是什么时候的。
verify: |
  cd mindcraft
  grep -n "maxLagMs = 0" src/utils/loop_lag.js        # 改后期望 ≥2（声明处 + 重置处）
  # 行为：注入一次 300ms 阻塞 → 等 60 秒（或一个窗口）→ 报告值必须回落
  node -e "
    const m = await import('./src/utils/loop_lag.js'); m.startLoopLagWatch();
    const t=Date.now(); while(Date.now()-t<300){}         // 制造一次抖动
    setTimeout(()=>{ console.log(m.describeLoopLag()); }, 35000).unref();
  "
  # 期望：35 秒后输出不再是「该数值很大」
discovered_by: patch-smith(from history)
dept: D3-EXEC
