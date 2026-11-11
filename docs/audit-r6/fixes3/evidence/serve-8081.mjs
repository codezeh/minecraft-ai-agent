/**
 * 冒烟用启动器（**非产品代码**，放在 tmp/ 下，只为 R6 控制面冒烟 #57/#66/#59/#30/#33/#68）。
 *
 * 为什么不直接 `node main.js`：
 *   main.js 末尾会对 settings.profiles 里**每一个 profile** 调 createAgent()，那会 spawn
 *   一个 agent 子进程并尝试连接 MC 服务器 —— 本线硬要求「只起 mindserver，不连真 MC 服」，
 *   而 25565 正被并行的「启动链」线占用，连上去就是跨线干扰。
 *   所以这里只调 Mindcraft.init()（= 只起 mindserver），一个 bot 都不起。
 *
 * 另外两点隔离（同样为了不动生产状态）：
 *   · MC_BOTS_ROOT 指到 tmp（任务板库 = 隔离库，不碰 mindcraft/bots/_board 生产库）
 *   · MC_VAULT_DB 指到 tmp（保管库 = 隔离库，不碰生产 keys）
 *
 * 假 agent：用导出的 registerAgent()/issueAgentToken() 造两个「存在但没有进程」的 bot 名
 * （smokeA/smokeB），用来验 #33 按 agent 分桶、#57 四类失败帧。不 spawn 任何子进程。
 */
import { writeFileSync } from 'node:fs';
import * as Mindcraft from '../../src/mindcraft/mindcraft.js';
import { registerAgent, issueAgentToken, getHandshakeToken } from '../../src/mindcraft/mindserver.js';

const PORT = Number(process.env.MINDSERVER_PORT || 8081);

await Mindcraft.init(false, PORT, false); // host_public=false, port, auto_open_ui=false

const fakeAgents = ['smokeA', 'smokeB'];
const tokens = {};
for (const name of fakeAgents) {
    registerAgent({ profile: { name, model: 'smoke', api: 'smoke' } }, 3000);
    tokens[name] = issueAgentToken(name);
}

// smokeB 额外注入一个「杀不掉」的假 AgentProcess（#57 destroy-agent-failed 用）：
//   stopAndWait() 明确回 exited:false ⇒ destroyAgent 保留注册表并回 ok:false
//   ⇒ 服务端应当发 destroy-agent-failed。不 spawn 任何进程。
Mindcraft.__test.set('smokeB', {
    running: true,
    process: { pid: -1 },
    stopAndWait: async () => ({ exited: false, escalated: false, reason: 'smoke-fake-refuses-to-die' }),
});

writeFileSync('./smoke-credentials.json', JSON.stringify({
    port: PORT,
    panelToken: getHandshakeToken(),
    agentTokens: tokens,
}, null, 2));

console.log(`[smoke] mindserver ready on :${PORT}（假 agent: ${fakeAgents.join(', ')}）`);

const bye = () => { console.log('[smoke] shutting down'); process.exit(0); };
process.on('SIGINT', bye);
process.on('SIGTERM', bye);
