/**
 * t-r5-10 —— 「AgentProcess 的 spawn 'error' 不置 running=false」
 *
 * 缺陷形态（老实现）：`agentProcess.on('error', err => console.error(...))` 只打一行日志。
 *   spawn 失败（ENOENT / EACCES / 资源不足）时子进程**根本不会跑**，`exit` 事件也永远不会来
 *   ⇒ `running` 永远停在 true ⇒ start/stop/forceRestart 全都以为"它还在跑"，
 *   退避重启也不会被触发（面板上留一条永不消失的"运行中"）。
 *
 * 判定方式（不靠读码，靠跑）：把 `child_process.spawn` 换成假子进程
 *   （EventEmitter，支持 on/kill/pid），start() 之后让它 emit('error')，然后读 `ap.running`：
 *     · running 仍为 true → 缺陷复现，退出码 0；
 *     · running 落回 false → 未复现，退出码 1。
 *
 * 边界说明：探针在**导入被测模块之前**用 createRequire 把 `child_process.spawn` 换掉
 *   （老实现直接调全局 spawn，这是唯一能离线注入的口子）；如果该版本还有可注入的
 *   `this._spawn`，探针同时接管它。被测逻辑（错误处理器）一行未改。
 *
 * 用法：node .../t-r5-10.mjs ；R5_SRC=<pre-fix>/src node .../t-r5-10.mjs
 * 退出码：0=缺陷复现，1=未复现，2=CANNOT-RUN。
 */
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(process.env.R5_SRC || path.resolve(HERE, '../../../../../mindcraft/src'));
const say = (...a) => console.log('[t-r5-10]', ...a);

// ── 假子进程（必须在导入被测模块之前装好：老实现直接 import 具名 spawn）──────
const children = [];
function makeFakeChild() {
    const child = new EventEmitter();
    child.pid = 424242;
    child.killed = false;
    child.kill = () => { child.killed = true; return true; };
    child.stdout = null;
    child.stderr = null;
    child.unref = () => child;
    children.push(child);
    return child;
}
const fakeSpawn = (...args) => {
    say('fake spawn 被调用：', String(args[0]).slice(-24), args[1]?.slice?.(0, 4)?.join(' ') ?? '');
    return makeFakeChild();
};
globalThis.__r5_spawn = fakeSpawn;
const require_ = createRequire(import.meta.url);
require_('child_process').spawn = fakeSpawn;   // 必须在第一次 ESM 导入 child_process 之前

let AgentProcess;
try {
    ({ AgentProcess } = await import(pathToFileURL(path.join(SRC, 'process/agent_process.js')).href));
} catch (e) {
    console.error('[t-r5-10] CANNOT-RUN：导入 agent_process.js 失败：', e?.message ?? e);
    process.exit(2);
}

const ap = new AgentProcess('probe10', 65535);
if (typeof ap._spawn === 'function') {
    ap._spawn = fakeSpawn;          // 新实现的可注入口子也一并接管（否则它用真 spawn）
} else {
    say('（该版本没有可注入的 _spawn，已靠 child_process 模块级替换接管）');
}
// 不触发退避重启定时器：把注入的定时器换成立即记录
const timers = [];
ap._setTimeout = (fn, ms) => { timers.push(ms); return { fn, ms }; };

const started = ap.start(false, null, 0);
say('start() 返回：', started, ' running=', ap.running, ' 假子进程数=', children.length);

const child = children[0] ?? ap.process;
// spawn 失败：真实 Node 在这种情况下发出 'error'，且**不会**发 'exit'
child.emit('error', new Error('spawn ENOENT（假）'));
await new Promise((r) => setTimeout(r, 50));

const runningAfterError = ap.running;   // ★ 必须在这里取：下面再 start() 会把 running 重新置 true
say("emit('error') 之后：running =", runningAfterError, ' 排队的重启定时器 =', JSON.stringify(timers));
const restartStarted = ap.start(false, null, 0);
say('再次 start() 返回：', restartStarted, ' 假子进程总数=', children.length);

if (runningAfterError === true) {
    say('REPRODUCED：spawn 失败后 running 仍为 true —— 状态机认为"它还在跑"，'
        + '退避重启/面板启停全部失真（老实现的 error 处理器只打日志）');
    process.exit(0);
}
say('NOT-REPRODUCED：spawn 失败后 running 已落回 false（状态与现实一致）');
process.exit(1);
