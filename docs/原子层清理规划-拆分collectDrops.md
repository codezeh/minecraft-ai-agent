# 原子拆分规划：collectDrops 的二次拆分

> 起因（用户判断，2026-10-25 03:33）：
> 「那说明拆的还不够原子，你尝试拆一下，这样污染应该好查一些」
>
> 判断成立。实测症状就是证据：
> `★ 回收成功` 报 `TIMEOUT 2786ms`，紧接着 `★ 背包真的 +1` 却 PASS ——
> **东西捡到了，但原子说没捡到**。这种自相矛盾只有在"判定和动作混在一个原子"时才会出现。

---

## 1. 现状：`collectDrops` 一个原子干了五件事

| # | 职责 | 代码位置（拆前） |
|---|---|---|
| 1 | 等一会，看服务端有没有自动吸附 | 第 94-95 行 `waitGain(400)` / `waitGain(1200)` |
| 2 | 找地上的掉落物实体 | 第 104-109 行（遍历 `bot.entities`） |
| 3 | 走过去 / 往下找站位 | 第 114 行 `moveTo`、第 130 行循环 |
| 4 | 判断"捡到没有" | `gained()` 散布在 6 处 |
| 5 | 决定"往哪找"（逐层往下） | 第 130-136 行 |

**一个原子有 5 个职责 → 失败时无法归因**。这就是"污染"的来源。

## 2. 拆分方案

### 2.1 `findDrops` —— 纯查询，找地上的掉落物

```js
findDrops(bot, { near, radius }) -> {
  ok, data: { items: [{ pos, dist, name, id }], count }
}
```

- **只读**，不移动、不等待
- 能单独测（造几个掉落物，看能不能数出来）
- 失败码：`NO_TARGET`（附近没有）

### 2.2 `waitForItem` —— 只负责"等背包变化"

```js
waitForItem(bot, { countFn, until, timeoutMs, intervalMs }) -> {
  ok, data: { gained, waitedMs, polled }
}
```

- **只等，不动**，不找站位
- `until` 是判据函数（默认"数量增加"）
- 失败码：`TIMEOUT`（等到了但没变化）
- **这是关键修复**：现在"等"和"走"混在一起，走完最后一步的等待被算进了别的分支

### 2.3 `stepDown` —— 只负责"下到能站的层"

```js
stepDown(bot, { from, maxDrop, wantGround }) -> {
  ok, data: { from, to, dropped, standable, groundBlock }
}
```

- 只做垂直下降（不横向寻路）
- 复用 `findStandSpot` 和新的 `moveTo` 落脚契约
- 失败码：`NO_SUPPORT`（下面没有落脚点）

### 2.4 `collectDrops` 退化为 L2 复合

```js
// 只做编排，不做事
planPickup()  -> steps: [ waitForItem, findDrops, moveTo, waitForItem, stepDown, waitForItem ]
```

或者更简单：保留 `collectDrops` 作为**薄壳**，内部按固定顺序调上面三个原子。

## 3. 拆分收益（可验证）

| 症状 | 拆前 | 拆后 |
|---|---|---|
| `回收成功` 报 TIMEOUT 但背包 +1 | 不可能归因（等/走/判混在一起） | `waitForItem` 的 `waitedMs` + `gained` 直接给出答案 |
| 掉落物找不到 | 只能看到 `no-drop-entity` 一个事件 | `findDrops` 返回 `items:[]` + 半径，一眼看出是"真没有"还是"半径太小" |
| 站在树叶上捡不到 | `move-not-grounded` 事后才发现 | `stepDown` 的 `standable`/`groundBlock` 当场判定 |
| 测试用例互相污染 | bot 被留在半空，下一个用例无感知 | 每个原子都报告自己的落脚状态，污染点能定位到具体原子 |

## 4. 范围

| 步 | 内容 | 风险 |
|---|---|---|
| 1 | 新增 `atom_find_drops.js`（纯查询）+ 测试 | 低 |
| 2 | 新增 `atom_wait_item.js`（只等）+ 测试 | 低 |
| 3 | 新增 `atom_step_down.js`（只下降）+ 测试 | 中 |
| 4 | `collectDrops` 改为薄壳编排 | 中 |
| 5 | 全套验收 + `atom_drops` 那条转绿 | — |

**不做**：`moveTo`/`moveToXZ` 的合并（另一轮）。

## 5. 验收标准

| # | 判据 |
|---|---|
| 1 | 三个新原子各自的测试全过，且**能单独跑**（不依赖 `collectDrops`） |
| 2 | `atom_drops` 不再出现"报 TIMEOUT 但背包 +1" |
| 3 | 15/16 → **16/16** |
| 4 | 采集行为不退化（主服基线 ≥ 4/5） |

## 6. 拆分判断标准（固化进经验）

这次暴露的规则：

> **一个原子只做一件事，就是说：它的成功判据只能有一个来源。**

| 检查 | 不合格 |
|---|---|
| 成功判据 | 既要"背包增加"又要"走到位置"→ 拆 |
| 时间消耗 | 既"等待"又"移动"→ 拆（等待时长会被移动掩盖） |
| 可单独测 | 必须先调另一个原子才能测 → 不算原子 |
