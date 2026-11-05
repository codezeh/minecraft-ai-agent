/**
 * 第1条 ④ 证据之一：仓库里的 `lockdown()` 有没有真的调用 SES 的全局 lockdown()？
 *
 * 结论（本探针的输出）：**没有**（修复前的状态）。
 *   `mindcraft/src/agent/library/lockdown.js` 里 `export function lockdown()` 在模块作用域建了
 *   一个同名绑定，函数体里的 `lockdown({...})` 解析到的是**它自己**；第一次调用已把
 *   `lockeddown = true`，于是自递归第一层就 return ⇒ SES 的 lockdown 配置从未生效。
 *   判据：`Object.isFrozen(Object.prototype)` 调用后仍是 false；只有直接调
 *   `globalThis.lockdown()` 才变 true。
 *
 * 用法（cwd 不限）：node docs/audit/probes/t10-lockdown-shadow-bug.mjs
 * 修复后的回归护栏：mindcraft/tools/ses_escape_unit.mjs
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MINDCRAFT = path.resolve(__dirname, '../../../mindcraft');

// 本探针住在根仓库的 docs/ 里，node_modules 在 mindcraft/ 下，所以 ses 不能用裸包名导入。
// 直接指到同一个文件（ses 的 ESM 入口），装到 globalThis 的效果与 `import 'ses'` 一致。
await import(pathToFileURL(path.join(MINDCRAFT, 'node_modules/ses/index.js')).href);

console.log('[probe] 调用前 Object.isFrozen(Object.prototype) =', Object.isFrozen(Object.prototype));

const mod = await import(pathToFileURL(path.join(MINDCRAFT, 'src/agent/library/lockdown.js')).href);
mod.lockdown();
console.log('[probe] 仓库 lockdown() 之后 Object.isFrozen(Object.prototype) =', Object.isFrozen(Object.prototype));

try {
    globalThis.lockdown({ consoleTaming: 'unsafe', errorTaming: 'unsafe', evalTaming: 'unsafeEval' });
    console.log('[probe] 直接调全局 lockdown 之后 Object.isFrozen(Object.prototype) =', Object.isFrozen(Object.prototype));
} catch (e) {
    console.log('[probe] 直接调全局 lockdown 抛:', e.message);
}

console.log('[probe] 判读：若"仓库 lockdown() 之后"仍为 false，说明那层是空转（修复前的状态）');
