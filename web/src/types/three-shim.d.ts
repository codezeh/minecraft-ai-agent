/**
 * three.js 类型垫片 —— F-WEB-102（2026-11-06）
 *
 * 为什么需要：`three@0.170.0` 的 package.json **没有 `types` 字段**，`exports` 里也没有
 * `types` 条件（实测：只有 import / require 指向 build/three.module.js），
 * three 官方**不自带 .d.ts** —— TypeScript 要找的是 DefinitelyTyped 的 `@types/three`。
 *
 * 而本仓红线是**不新增第三方依赖**，所以不能靠 `npm i -D @types/three` 解决。
 *
 * ─────────────────────────────────────────────────────────────
 * 2026-11-06 修正史（captain 收口 ⑥ 时逐版实测，记录踩过的三种错写法）：
 *
 * ① `declare module 'three';`（裸声明）
 *    → TS2694「Namespace 'three' has no exported member 'PerspectiveCamera'」
 *    原因：裸声明得到的是 any **值**，而源码在**类型位置**用 `THREE.PerspectiveCamera`。
 *
 * ② `export = (const THREE: any)`
 *    → TS2503「Cannot find namespace 'THREE'」：`import * as THREE` 要命名空间，给的是值。
 *
 * ③ 手写命名空间 + 逐个成员声明
 *    → TS2339「Property 'Mesh' does not exist on type 'typeof THREE'」
 *    原因：**穷举必然漏**。TerrainCanvas 用到 Mesh/CylinderGeometry/RingGeometry/Fog/
 *    HemisphereLight/DirectionalLight/DynamicDrawUsage… 补一个漏一个，
 *    这种垫片会变成"永远追不上"的债。
 *
 * ④ 本版：命名空间 + **索引签名**兜住任意成员。
 *    `[key: string]: any` 让任何 `THREE.XXX` 在值位置成立；
 *    同时把常用成员以 `type` 形式声明，让**类型位置**同样成立。
 *    ⇒ 不穷举、不漏、零依赖。
 *
 * 代价（如实写清，别让人以为这里"有真类型了"）：
 *   本仓 `three` 与 `three/addons/*` 的成员一律 **any**
 *   ⇒ 对 three API 的误用（拼错方法名、传错参数）**不会被类型系统挡住**。
 *   这层只解决"能不能通过编译"，不提供"用对了没有"的保障。
 *   **这也是为什么 skipLibCheck 必须保持 true**（否则要 @types/node = 新增依赖）。
 *
 * 什么时候该删掉本文件：将来允许加依赖、并装上 `@types/three` 之后 ——
 * 删掉它，真类型自动接管。
 * ─────────────────────────────────────────────────────────────
 */

declare namespace THREE {
    // ── 值位置：任意成员都成立（不穷举，避免"补一个漏一个"）──
    const __three_any: any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    type AnyThing = any;

    // ── 类型位置：源码里用到命名空间类型的那些 ──
    type PerspectiveCamera = any;
    type OrthographicCamera = any;
    type InstancedMesh = any;
    type Mesh = any;
    type Group = any;
    type Object3D = any;
    type Scene = any;
    type Color = any;
    type Material = any;
    type MeshStandardMaterial = any;
    type MeshBasicMaterial = any;
    type BufferGeometry = any;
    type BufferAttribute = any;
    type InstancedBufferAttribute = any;
    type InstancedBufferGeometry = any;
    type Texture = any;
    type CanvasTexture = any;
    type WebGLRenderer = any;
    type Raycaster = any;
    type Vector2 = any;
    type Vector3 = any;
    type Intersection = any;
    type Fog = any;
    type HemisphereLight = any;
    type DirectionalLight = any;
    type AmbientLight = any;
    type LineSegments = any;
    type EdgesGeometry = any;
    type LineBasicMaterial = any;
}

// 值位置兜底：让 THREE.Mesh / THREE.Fog / THREE.DynamicDrawUsage 等**任意**成员可用。
// 用 interface 的索引签名挂到命名空间上（TS 允许 namespaced interface 合并声明）。
declare namespace THREE {
    interface AnyMembers {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        [key: string]: any;
    }
    type __AnyAll = AnyMembers;
}

declare module 'three' {
    // 关键：把命名空间整体导出，值位置由索引签名兜住，类型位置由上面的 type 别名兜住
    const THREE_NS: typeof THREE & { [key: string]: any };
    export = THREE_NS;
}

// three/addons/* 要同时支持三种姿势（TerrainCanvas 实际用了前两种）：
//   ① import { OrbitControls } from 'three/addons/controls/OrbitControls.js'  ← 具名导入
//   ② let controls: OrbitControls | null                                        ← **当类型用**
//   ③ import * as X from 'three/addons/...'
// 只写 const 导出时②会报 TS2749「refers to a value, but is being used as a type」。
// 解法：给模块一个**命名空间**，里面同时有 const（值）与 type（类型）。
declare module 'three/addons/*' {
    namespace anyAddon {
        // 值
        const OrbitControls: any;
        const GLTFLoader: any;
        const EffectComposer: any;
        const RenderPass: any;
        const UnrealBloomPass: any;
        const OutputPass: any;
        // 类型（同名，供 type 位置使用）
        type OrbitControls = any;
        type GLTFLoader = any;
        type EffectComposer = any;
        type RenderPass = any;
        type UnrealBloomPass = any;
        type OutputPass = any;
    }
    export = anyAddon;
}
