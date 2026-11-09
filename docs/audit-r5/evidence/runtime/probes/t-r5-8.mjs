/**
 * t-r5-8 —— 「refreshTerrain 绕过离线闸：断线时仍把 request-terrain 发出去（被缓存到重连）」
 *
 * 缺陷形态（老实现）：面板其它控制入口都改走 `emitControl()`（没连接就拒发），
 *   但 `refreshTerrain()` 里还是裸的 `socket.emit('request-terrain', …)`。
 *   `autoConnect:false` + 断线期间 socket.io 会把 emit **缓存**进 `socket.sendBuffer`：
 *   界面显示"超时(30s)"，而重连那一刻这个请求会被真发出去
 *   ⇒ 用户重连后地形被一条"早就失败了的旧请求"覆盖。
 *
 * 判定方式（不靠读码，靠跑）：把真实的 `web/src/stores/agents.ts` 用 esbuild 打成 node 可跑模块，
 *   只把 `../api/socket` 换成记账用的假实现（emit 照 socket.io 语义缓存、不抛错），
 *   然后在**未连接**状态下调用 `refreshTerrain()`：
 *     · 仍然 emit 了 'request-terrain'（进了 sendBuffer） → 缺陷复现，退出码 0；
 *     · 一个包都没发（返回 {ok:false, reason:…}） → 未复现，退出码 1。
 *
 * 用法：
 *   node .../t-r5-8.mjs                                    # 当前 web 源码
 *   R5_WEB_FILE=<pre-fix agents.ts 路径> node .../t-r5-8.mjs
 * 退出码：0=缺陷复现，1=未复现，2=CANNOT-RUN。
 */
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { pathToFileURL, fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.resolve(process.env.R5_WEB || path.resolve(HERE, '../../../../../web'));
const STORE = path.resolve(process.env.R5_WEB_FILE || path.join(WEB, 'src/stores/agents.ts'));
const FAKE_SOCKET = path.join(HERE, 'r5-fake-socket.mjs');
const say = (...a) => console.log('[t-r5-8]', ...a);

if (!fs.existsSync(STORE)) {
    console.error('[t-r5-8] CANNOT-RUN：找不到被测 store 文件：' + STORE);
    process.exit(2);
}

let esbuild;
try {
    esbuild = await import(pathToFileURL(path.join(WEB, 'node_modules/esbuild/lib/main.js')).href);
} catch (e) {
    console.error('[t-r5-8] CANNOT-RUN：拿不到 web/node_modules/esbuild：' + (e?.message ?? e));
    process.exit(2);
}

// 落盘位置：放在 evidence 目录下（本机沙箱对系统 temp 目录写受限，workspace 内可写）
const OUTDIR = path.join(HERE, '../tmp');
fs.mkdirSync(OUTDIR, { recursive: true });
const outfile = path.join(OUTDIR, `agents.bundle.${process.pid}.mjs`);
try {
    await esbuild.build({
        entryPoints: [STORE],
        bundle: true,
        format: 'esm',
        platform: 'node',
        outfile,
        logLevel: 'silent',
        // 裸模块（vue）从 web/node_modules 解析：被测文件可能在仓库外（对照组）
        nodePaths: [path.join(WEB, 'node_modules')],
        plugins: [{
            name: 'r5-alias-socket',
            setup(build) {
                // 只替换"面板 API 层"这一个边界，store 的业务判断原样跑。
                // 必须 `external: true` —— 否则假模块被**内联进包**，
                // 探针 import 到的就是另一个实例，看到的 emit 记录永远是空的（踩过）。
                build.onResolve({ filter: /^\.\.\/api\/socket$/ }, () => ({
                    // 必须是 file:// URL：Windows 绝对路径写成 'E:\...' 会被 Node 当成 scheme 'e:'
                    path: pathToFileURL(FAKE_SOCKET).href, external: true,
                }));
            },
        }],
    });
} catch (e) {
    console.error('[t-r5-8] CANNOT-RUN：esbuild 打包失败：' + (e?.message ?? e));
    process.exit(2);
}
say('被测源文件：', STORE);
say('打包产物：', outfile, `(${fs.statSync(outfile).size} 字节)`);

let storeMod, socketMod;
try {
    storeMod = await import(pathToFileURL(outfile).href);
    socketMod = await import(pathToFileURL(FAKE_SOCKET).href);
} catch (e) {
    console.error('[t-r5-8] CANNOT-RUN：导入打包产物失败：' + (e?.message ?? e));
    process.exit(2);
}
if (typeof storeMod.refreshTerrain !== 'function') {
    console.error('[t-r5-8] CANNOT-RUN：该 store 没有导出 refreshTerrain');
    process.exit(2);
}

// 选中一个 agent（currentAgent 是从 store.agents + store.current 派生的 computed）
const st = storeMod.store;
st.agents = [{ name: 'probe8', in_game: false }];
st.current = 'probe8';
try { storeMod.selectAgent?.('probe8'); } catch { /* 可选 */ }
if (!storeMod.currentAgent?.value) {
    console.error('[t-r5-8] CANNOT-RUN：无法让 currentAgent 指向 probe8（store 接口变了）');
    process.exit(2);
}
say('currentAgent =', JSON.stringify(storeMod.currentAgent.value?.name));

const before = socketMod.sent.length;
const bufferBefore = socketMod.socket.sendBuffer.length;
say('调用前：connected =', socketMod.socket.connected, ' 已发包 =', before, ' sendBuffer =', bufferBefore);

let ret;
try {
    ret = await storeMod.refreshTerrain({ mode: 'around', radius: 48 });
} catch (e) {
    say('refreshTerrain 抛错（也算"没发出去"，但要如实记录）：', e?.message ?? e);
    ret = null;
}

const afterEvents = socketMod.sent.slice(before);
const buffered = socketMod.socket.sendBuffer.slice(bufferBefore);
say('refreshTerrain 返回：', JSON.stringify(ret));
say('本次新增的 emit：', JSON.stringify(afterEvents));
say('本次新增的 sendBuffer（重连后会真发出去）：', JSON.stringify(buffered.map((b) => b[0])));

const terrainSent = afterEvents.includes('request-terrain') || buffered.some((b) => b[0] === 'request-terrain');
if (terrainSent) {
    say('REPRODUCED：未连接状态下 refreshTerrain 仍发出了 request-terrain'
        + '（进了 socket.sendBuffer ⇒ 重连那一刻会被真发出去；界面却显示"超时失败"）');
    process.exit(0);
}
say('NOT-REPRODUCED：未连接时没有发包（离线闸生效，如实返回失败）');
process.exit(1);
