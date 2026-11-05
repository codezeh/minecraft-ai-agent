import 'ses';

// This sets up the secure environment
// We disable some of the taming to allow for more flexibility

// For configuration, see https://github.com/endojs/endo/blob/master/packages/ses/docs/lockdown.md

/**
 * ⚠️ 第一轮审查 第 1 条 ④ —— **这里原来有一个「看起来在设防、实际什么都没做」的 bug**。
 *
 * 原代码是：
 * ```js
 * export function lockdown() {          // ← 模块作用域里建了一个叫 lockdown 的绑定
 *   if (lockeddown) return; lockeddown = true;
 *   lockdown({ evalTaming: 'unsafeEval' });   // ← 解析到的是它自己，不是 SES 的全局 lockdown()
 * }
 * ```
 * 第一次调用先把 `lockeddown = true`，再「调用自己」，于是第二层立刻 return ——
 * **SES 的 lockdown 从来没跑过**。实测（`docs/audit/probes/t10-lockdown-shadow-bug.mjs`）：
 *   - 调用前 `Object.isFrozen(Object.prototype)` = false
 *   - 调用仓库的 `lockdown()` 之后 **仍然是 false**；只有直接调 `globalThis.lockdown()` 才变 true。
 *
 * 为什么这件事是第 1 条的核心：报告第三层说「SES 边界挡不住宿主 realm，代码三行就是本机 RCE」，
 * 复验（`docs/audit/probes/t10-ses-escape-ab.mjs`，同一份 `skills`/`world`/`Vec3` 注入面）：
 *   - **lockdown 没跑（= 仓库当前行为）**：`skills.log.constructor('return process.version')()`
 *     → `v24.16.0`（逃逸成立）
 *   - **lockdown 真跑了**：同一条 → `TypeError: Function.prototype.constructor is not a valid constructor`
 * 六个常见向量（`async`/生成器/数组方法/对象链/原型链取 constructor、`Reflect.construct` 新 newTarget）
 * 在真 lockdown 下**全部打不通**（`docs/audit/probes/t10-ses-escape-ab.mjs`、`tools/ses_escape_unit.mjs`）。
 * ⇒ 逃逸的**真原因是这个自引用遮蔽 bug**，不是 SES 本身的设计缺陷。
 *
 * 所以第 ④ 条按「真关」执行，不是按「声明它不是沙箱」执行：
 *   - 这里显式调 `globalThis.lockdown`（别名 `sesLockdown`，避免再被同名导出遮住），
 *     `coder.js` 那条路上 SES 的边界**第一次真正生效**；
 *   - `evalTaming` 仍是 `unsafeEval`，因为 `protodef` 的编译器硬依赖它（见下面注释与实测），
 *     但在真 lockdown 下它**不再是逃逸通道**：`.constructor` 已被驯化，拿不到宿主 `Function`。
 *
 * 代价（写清楚，别假装没有）：
 *   1. SES 会把内建对象冻住（`Object.prototype` 等）。**晚于 lockdown 才开始 monkeypatch 内建原型**的
 *      三方库会直接抛。本仓库的 `lockdown()` 是在第一次 `!newAction` 时才惰性调用的，
 *      此时依赖都已加载完 —— 但这条仍是"运行到那一刻才知道"的风险，真正的结构解是把 lockdown
 *      提到进程启动处（另案）。实测烟测：真 lockdown 下 mineflayer 建 bot + 协议编译 + TCP 连接正常
 *      （`docs/audit/probes/t10-lockdown-shadow-bug.mjs`，走到 ECONNREFUSED 说明协议栈没坏）。
 *   2. `evalTaming:'unsafeEval'` 是硬依赖不是偷懒：`protodef` 的编译器是
 *      `node_modules/protodef/src/compiler.js:262` 的 `eval(code)()`，**依赖模块局部变量 `native`**；
 *      `safeEval` 的 eval 看不见局部作用域 ⇒ `TypeError: ... reading 'i8'` ⇒ compiled 协议编不出来
 *      ⇒ bot 连不上服务器（`docs/audit/probes/t10-safeeval-protodef.mjs` 两个模式各跑一次可复现）。
 *   3. **这不是完整沙箱，也不该当成沙箱**：上面只证明了「本次测的 6 个 `.constructor` 向量已关」，
 *      逃逸对抗是个持续的活（第 1 条第三层级别的专项复核另案）。所以
 *      `settings.allow_insecure_coding` 默认仍是 `false`（第 ③ 条），README 也照实写。
 *
 * 回归护栏：`tools/ses_escape_unit.mjs`（这条 bug 曾经静默存在，必须有人看着它）。
 */

/** SES 的全局 `lockdown`。**必须取别名**：本模块导出的 `lockdown` 会遮住它（这就是原来的 bug）。 */
const sesLockdown = globalThis.lockdown;

/** 只 lock 一次（SES 的 lockdown 不可逆，重复调用会抛）。 */
let lockeddown = false;

export function lockdown() {
  if (lockeddown) return;
  lockeddown = true;
  if (typeof sesLockdown !== 'function') {
    // ses 没装上时 Compartment 也不存在，等于「隔离层完全不存在」——别静默
    console.warn('[安全] 找不到 SES 全局 lockdown()（ses 未加载？）—— 代码执行的隔离层不存在，按 root 对待');
    return;
  }
  sesLockdown({
    // basic devex and quality of life improvements
    localeTaming: 'unsafe',
    consoleTaming: 'unsafe',
    errorTaming: 'unsafe',
    stackFiltering: 'verbose',
    // allow eval outside of created compartments
    // (mineflayer dep "protodef" uses eval)
    //
    // 第1条 ④：这是**硬依赖**，不是图方便。protodef 的编译器 `eval(code)()` 依赖模块局部变量
    // `native`，safeEval 看不见局部作用域（实测 TypeError: reading 'i8'）⇒ compiled 协议编不出来
    // ⇒ bot 连不上服务器。真 lockdown 下它不再是逃逸通道（宿主 Function 已被驯化）。
    evalTaming: 'unsafeEval',
  });
}

export const makeCompartment = (endowments = {}) => {
  return new Compartment({
    // provide untamed Math, Date, etc
    Math,
    Date,
    // standard endowments
    ...endowments
  });
}
