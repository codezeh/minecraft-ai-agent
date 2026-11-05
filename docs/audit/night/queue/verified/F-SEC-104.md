id: F-SEC-104
severity: medium
class: path
file: src/mindcraft/mindserver.js:171
dept: D2-SEC

# ⚠️ 本文件由复核席重建（gate-keeper · t14 · 2026-11-06 02:4x）
# 原 finding 文件在收尾时被清空。落地见 commit 62a93a5（与 F-SEC-205 同一提交，按 id 分列）。

## review（裁决：**通过**）

### 一、修法本身（白名单）逐字符核过

```js
const itemName = String(rawName).toLowerCase();
if (!/^[a-z0-9_]{1,64}$/.test(itemName)) {
    res.status(400).json({ ok: false, error: 'invalid texture name' });
    return;
}
```
- 校验发生在 `toLowerCase()` **之后**、在 `path.join` 拼路径**之前** ✅ 顺序正确。
- 攻击面（Express 解码后的 `..%2f..%2fsettings`）会被 `[a-z0-9_]` 拦掉 ✅
  面板侧 `InventoryGrid.vue:26` 用 `encodeURIComponent(name)`，`../settings` 会变成 `..%2Fsettings`，
  服务端解码后含 `.` 与 `/` ⇒ 400。

### 二、我独立跑了正则的正反用例（12 条，全对）

| 输入 | 结果 | 期望 |
|---|---|---|
| `stone` / `oak_planks` / `diamond_sword` / `grass_block` | 放行 | 放行 ✅ |
| `../settings` / `..%2f..%2fsettings` | 400 | 400 ✅ |
| `minecraft:stone` | 400 | 400（见下"误伤评估"）|
| 空串 / 65 字符 / `item.png` / `Stone` / `a b` | 400 | 400 ✅ |

### 三、误伤评估（这是我最担心的一点，结论：无真机误伤）

- `InventoryGrid.vue` 的 `name` 来自 `currentState.inventory.counts` 的键，即 mineflayer 的
  **物品/方块裸名**（`oak_planks`、`stone`，无 `minecraft:` 命名空间、无大写、无空格）⇒ 全部落在白名单内。
- 服务端原本就是拿 `assets.items[itemName]` / `assets.blocks[itemName]` 去查表，
  **也是按裸名查**的 ⇒ 白名单与既有查表口径一致，不存在"能查到但被 400"的情况。
- 即使某个奇特名字被拒，前端有 `onImgError` 回落成首字母，**不会出现破图**。
- `minecraft:stone` 被拒是**有意的**：该路由本就不接受带命名空间的名字（查表查不到）。

### 四、未验证的边界（诚实声明）
我没有真机起 mindserver 去发 HTTP 请求（本会话 node 不能 spawn / 也不能监听端口），
所以"5 非法全拒 / 4 合法全放行"是**静态推演 + 正则实测**，不是端到端 HTTP 实测。
端到端确认需 captain 起面板后在浏览器里看一眼装备图标是否仍正常显示。

**结论：通过。**
