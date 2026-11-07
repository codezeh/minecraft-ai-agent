// T0 local launcher: bring up ONLY the mindserver (panel/API) on 8080.
//
// Why this file exists (真机事实，不是偏好):
//   `node src/mindcraft/mindserver.js` is a **module**, not an entry point —
//   it only *exports* createMindServer(); running it directly prints nothing and
//   exits 0 (实测 2026-11-06 19:50, rc=0, 无任何输出).
//   真正的入口是 mindcraft/main.js → Mindcraft.init(...) → createMindServer(...)。
//   但 main.js 还会按 settings.profiles 拉起 agent 子进程（my-local.json → 远端收费端点），
//   T0 只需要「面板在 8080 上」，bot 用裸 mineflayer 连服，因此这里直接调 createMindServer。
//
// 这个文件只存在于 docs/真机-20261106/T0/，不改动产品源码。
import { pathToFileURL } from 'node:url';

const MIND = 'E:/我的世界ai/mindcraft/src/mindcraft/mindserver.js';
const PORT = Number(process.env.MIND_SERVER_PORT || 8080);

const mod = await import(pathToFileURL(MIND).href);
if (typeof mod.createMindServer !== 'function') {
    console.error('[T0] createMindServer not exported by mindserver.js — aborting');
    process.exit(1);
}
mod.createMindServer(false, PORT);
console.log(`[T0] createMindServer(false, ${PORT}) invoked`);
