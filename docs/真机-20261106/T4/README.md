# T4 真机验收 · Three 实机 GPU（WEB-004 / WEB-005 / WEB-010）

- 验收对象：`web/src/components/TerrainCanvas.vue`（`ensureCapacity` / `refreshBounds` / `disposeGroup` / 卸载 dispose）
- 真机环境：**Edge 156.0.4314.58**，有头模式，CDP 直驱（9222）；真 GPU：**NVIDIA GeForce RTX 4050 Laptop GPU**（ANGLE/D3D11）
- 面板：`http://localhost:8080/console`（**未重启**）；验收期间面板进程为 PID 4112、token 为 21:13 那版
- 执行者：web-probe（attempt 1，attempt_id `5ccbe736-e580-4e77-abde-766e474d0dd5`）

---

## 0. 结论（逐条）

| 项 | 结论 | 依据（本节内详述） |
|---|---|---|
| **WEB-004** 失败点实例容量按需扩 | **修复成立** | 3000 个失败点时：实例矩阵上传数组 **48000 float = 3000×16**（容量正好按需扩），**非有限值 0 个**，draw 的 `instanceCount=3000`，截图上 3000 个红球全部画出，侧栏计数 3000 |
| **WEB-005** 渲染资源不泄漏 | **修复成立（本窗口内）** | 75 秒曲线：预热期两次**一次性**跃升后，**连续 66 秒 buffers/programs/VAOs/textures 完全不变**；空转对照 6 秒全平；卸载后 buffers 23→**0**、programs 5→**0**、VAOs 6→**0** |
| **WEB-010** 复用实例时重算包围球 | **修复成立** | 同容量复用（面数 3999→2312，**没有新建实例矩阵缓冲**）+ 换到远处 (8000,60,8000)，仍出现 `instanceCount=2312` 的 draw ⇒ 没被视锥误裁；`topOnly` 下 count 变 900 仍照常绘制 |
| 新增观察（非本任务修复项） | 每次「卸载→重挂」**净增 4 个 texture** | `textures: 4 → 4（卸载）→ 8（重挂）`；buffer/program/VAO 无残留。判断为旧 renderer 的内部默认纹理要等 GL 上下文销毁才回收，**不是** WEB-005 里说的问题 |

---

## A. 到底哪块 GPU（必答）

`WEBGL_debug_renderer_info`（WebGL2 上下文）实测：

| 启动参数 | UNMASKED_VENDOR | UNMASKED_RENDERER |
|---|---|---|
| `--enable-gpu --use-angle=d3d11 --ignore-gpu-blocklist …`（本次所有测量都用这套） | `Google Inc. (NVIDIA)` | `ANGLE (NVIDIA, NVIDIA GeForce RTX 4050 Laptop GPU (0x000028E1) Direct3D11 vs_5_0 ps_5_0, D3D11)` |
| **默认参数**（对照，无 GPU 开关） | `Google Inc. (NVIDIA)` | **同一块 RTX 4050（同上）** |

- `WebGL 2.0 (OpenGL ES 3.0 Chromium)`、`WebGL GLSL ES 3.00`、`MAX_TEXTURE_SIZE=16384`、`antialias=true`
- **结论：本文所有结论建立在真 GPU（RTX 4050 / D3D11）上，不是 SwiftShader 软渲染。**
- 但要说清一点：任务书预期"默认常落 SwiftShader"**在本机不成立** —— 默认参数也直接落在同一块真 GPU 上，所以这两组之间**没有**软/硬对照可做。原始记录：`evidence/gpuinfo.json`

---

## B. WEB-005 资源曲线（75 秒，每秒 1 次）

采样方式：页面级包装 `WebGL2RenderingContext` 的 `create*/delete*`，取**存活数**（create−delete）；
另用 `requestAnimationFrame` 心跳与 `document.visibilityState` 自证"页面真的在渲染"（T3 学到的坑：页面 hidden 会停 RAF）。

- 采样窗口：`t=12.87s → 86.88s`，共 **75 个采样点**，期间以 1 Hz 推送位置（每次都会触发 `rebuildMarker`）
- RAF 心跳：`1831 → 8194`（≈86 帧/秒，全程在跑）；`visibilityState` 全程 `visible`
- 每秒数据：`evidence/current.curve.json`（75 条，含 gl 计数、live、instanceCount 集合、bufMeta）

| 指标 | 取值序列 | 说明 |
|---|---|---|
| live buffers | **6 → 18（第 1 秒）→ 23（第 9 秒）→ 23…（其后 66 秒不变）** | 两次一次性跃升后完全平坦 |
| live programs | 1 → 4（第 1 秒）→ 5（第 9 秒）→ 5…（不变） | 同上 |
| live VAOs | 1 → 5 → 6 → 6…（不变） | 同上 |
| live textures | **4 全程不变** | — |
| 空转对照（不推送位置，6 秒） | buffers 6/6/6/6/6/6，programs 1/1/1/1/1/1 | `evidence/current.idle-curve.json` |

两次跃升的解释（都在前 9 秒，属**一次性**成本，不是每帧/每秒增长）：
1. 第 1 秒 = 标记（球/杆/环）**第一次**建好（旧实现是每次位置推送都新建，正是 WEB-005 的缺陷）；
2. 第 9 秒 = 标记首次进入视锥时**编译它的着色器程序**（programs 4→5、buffers +5 与之一致）。

⇒ **判定：修复成立**。旧实现（每次 1 Hz 推送都 `clear()` + 新建 3 个 Mesh 且不 dispose）在这 75 次推送下会表现为 buffers/programs 随秒数单调增长；实测是建一次 + 平坦。

**卸载/重挂**：`buffers 23→0`、`programs 5→0`、`VAOs 6→0`（`onBeforeUnmount` 的 `dispose()` + `disposeGroup(markerGroup)` 生效）；重挂后 11 buffers / 2 programs（新数据面数更小）。

---

## C. WEB-004：3000 个失败点

场景：地形先到位，之后塞入 **3000** 个失败点（`mindserver_proxy.js` 的后端上限），再用产品自己的 `showFails` watcher 强制走一遍 `rebuildFails`（`props.data` 恒等不变时 watch 不触发，这点很关键）。

| 断言 | 实测 | 判定 |
|---|---|---|
| 失败点数进入模型 | `terrain.decoded.fails.length = 3000` | ✅ |
| `count ≤ instanceMatrix.count` | 实例矩阵上传数组长度 **48000 = 3000×16**（恰好等于需要量，`ensureCapacity` 按需重建）；`instanceCount` 实测 **3000** | ✅ |
| 每个矩阵值有限 | 该数组非有限值 **nonFinite = 0**；全量 bufMeta 里 `nonFinite` 最大值 **0** | ✅ |
| 无 WebGL 报错 | console/Log 中 **无任何** WebGL/INVALID_OPERATION/draw out of range 文本（`console_errors: []`）；页面异常 `pageErrors: []`；`webglcontextlost` 计数 **0** | ✅（见 §D 关于 `glGetError` 探针的说明） |
| 可见性 | `current-terrain-fails.png`：整片地形被红球覆盖，侧栏「失败点 **3000**」 | ✅ |

对照原缺陷（报告里写的是"count=2 / capacity=1"）：修复后容量会跟着失败点数扩到 3000，而不是停在初始值。

---

## D. WEB-010：同容量复用 + 包围球

| 断言 | 实测 |
|---|---|
| 复用（同容量）成立 | 面数 3999 → **2312**（cols 30），`bufMeta` 里**没有**出现 2312×16=36992 的新实例矩阵缓冲 ⇒ `ensureCapacity` 走的是"复用同一个 mesh"分支（这正是 WEB-010 的场景） |
| 矩阵/count 换了之后还能画出来 | 复用后出现 `instanceCount=2312` 的 instanced draw；`instanceCountSet: [3999,3000] → [3999,3000,2312]` |
| 没有被视锥误裁 | 若 `boundingSphere` 还停在旧位置，整张图会被判"视野外"（旧报告实测 visible=false、三角形 0）；实测复用后仍在绘制 |
| 再验证 count 变化 | `topOnly` 打开后 `instanceCount=900`（每列取最上层，1600 列→900 列在框内）仍照常绘制，`instanceCountSet` 出现 900 |

说明：`boundingSphere` **没有**直接被读取（它是组件闭包里的私有对象，生产构建拿不到），这里验的是它的**可观测后果**——复用后是否仍被绘制。这是本条的边界（见 §F）。

---

## E. 数据注入方式与保真度声明（必读）

**没有 agent**（面板 0 agent；T1/T2 的 bot 是裸 mineflayer、不经 mindserver）⇒ `loadTerrain()` 走 socket 永远拿不到数据。所以：

1. **夹具**（`fixture/main.ts`，不是产品代码）import **真实的** `TerrainView.vue` + `TerrainCanvas.vue` + 真实 `terrain` store，挂在最小宿主上；
2. **数据是合成的**：按**后端同格式**造 payload（`origin` + 交错 `int16` 坐标 base64 + `types` base64 + `bbox` + `fails`），然后**调产品自己的 `decodeTerrain()`** 解码 ⇒ 走的是产品真实解码路径，不是直接塞 typed array；
3. **保真度**：地形形状/高度分布/失败点坐标都是**程序生成**的，**不是真实飞行采集的地形**；面数（3999）与失败点数（3000）与真实上限同量级；
4. 面板的 socket 仍真实连接（同源、cookie 真实），但**地形不来自服务端**；
5. 观测手段：`three` 通过 vite alias 指到 `three-instrument.ts`（**原型级** patch `WebGLRenderer.prototype.render`，只记录不改变行为），另加页面级 GL 对象计数与 `drawElementsInstanced` 的 `instanceCount` 记录。

> 中间踩过的坑（写下来给后续用）：① 直接改 `terrain.decoded.fails` 不会触发组件 watcher（`props.data` 恒等），必须借产品自己的 `showFails` watcher；② 我注入的 1 Hz 状态第一次把 `dimension` 从 `unknown` 改成 `minecraft:overworld`，触发了 **WEB-007 的失效逻辑**把地形清空（这本身说明 WEB-007 生效），所以夹具必须一开始就把维度写死；③ `three` 的原型 patch 需要保证与组件**同一模块实例**，用子类包一层会被绕过（实测 render 计数为 0）。

---

## F. 本方法证明不了什么（显式声明）

1. **数据是合成的**（§E）：验证的是**渲染代码路径**在真 GPU 上的资源行为，不代表真实地形采集下的性能/显存曲线。
2. **不是完整的"飞行中"场景**：没有真实 `!terrain` 请求、没有 lod 切换下的长时间连续加载；75 秒窗口内只覆盖"一次加载 + 75 次位置推送 + 3000 失败点 + 一次复用 + 一次卸载重挂"。
3. **`glGetError()` 探针在本轮取不到上下文对象**（返回 `no-context`），所以"无 WebGL 错误"这条**不是**由 `glGetError` 直接证明的，而是由：console/Log 无任何 WebGL 报错 + `webglcontextlost=0` + 3000 个实例全部正确绘制（若实例数超过属性缓冲容量，WebGL 会报 INVALID_OPERATION 且该次 draw 失败，画面上不会有球）三者共同支撑。早期一轮探针曾直接读到 `glGetError() = NONE`，但那一轮的证据文件已被后续运行覆盖，故不单独引用。
4. **`boundingSphere` 未直接读取**（§D），WEB-010 是"可观测后果"级验证。
5. 只测了 **Edge 156 + RTX 4050(D3D11)** 这一套；未覆盖 Intel/AMD 核显、ANGLE 的 Vulkan/GL 后端、以及真实降频/低端机。
6. 每次「卸载→重挂」净增 4 个 texture 的观察（§0 末行）**只出现在一次重挂**，未做多轮循环统计，不能定性为"每次必泄漏"或"量级多大"。

---

## G. 复现

```bash
# 1) 构建夹具（只写 docs/真机-20261106/T4/，不碰 web/src）
cd 'E:\我的世界ai\web'
T4_VARIANT=current npx vite build --config 'E:\我的世界ai\docs\真机-20261106\T4\vite.fixture.mjs'

# 2) GPU 身份（带 GPU 参数 vs 默认参数）
node 'E:\我的世界ai\docs\真机-20261106\T4\t4-gpu.mjs' gpuinfo

# 3) 资源曲线 / WEB-004 / WEB-010（75 = 采样秒数）
node 'E:\我的世界ai\docs\真机-20261106\T4\t4-gpu.mjs' current 75
```

> 构建注意：本机 `%TEMP%` 下 esbuild 清理临时文件被拒（`Access is denied`，疑似杀软），所以构建时把 `TMP/TEMP` 指到 `T4/.esbuild-tmp`（该目录已删除，需要时重建即可）。

---

## H. 产物清单

| 文件 | 内容 |
|---|---|
| `evidence/gpuinfo.json` | 两套启动参数下的 GPU 字符串（含默认对照） |
| `evidence/current.summary.json` | 全流程断言汇总（GPU、空场景、加载、失败点、复用、topOnly、卸载、重挂） |
| `evidence/current.curve.json` | **75 条**逐秒资源采样（含 gl 计数/live/instanceCount 集合/bufMeta） |
| `evidence/current.idle-curve.json` | 空转对照（6 条） |
| `evidence/current.steps.jsonl` | 全部 CDP 请求/响应（token 打码） |
| `current-terrain-fails.png` | 地形 + **3000** 个失败点（侧栏计数 3000） |
| `current-reuse-far.png` | 复用到远处 (8000,60,8000) 后的地形 |
| `current-remount.png` | 卸载→重挂后重新灌入的地形 |

## I. 合规

- 只写 `docs/真机-20261106/T4/`；**未改** `web/src`；**未重建** `web/dist`；**未重启**面板/服务端（Paper/面板进程自始至终是外部那两份）。
- Edge `--user-data-dir` 放在 **`%TEMP%\t4-edge-profile-*`**，证据目录内**没有**浏览器缓存；`T4/.esbuild-tmp` 已清理。
- 证据内无 token 明文（全目录扫描 `token leaks = 0`），引用处打码。
- 端口只用 9222 / 8080；9222 跑完即释放。
