/**
 * t52 诊断：**`!do first_night` 到底返回了什么？**（不依赖 LLM）
 *
 * captain 的三个疑点：
 *   1. 返回文本里有没有 "没有任务板" / noBoard？（→ 说明 agent.board 是 null，走 noBoard 分支）
 *   2. mindserver / board_server 起来了吗？
 *   3. agent.board 是不是 null？
 *
 * 做法：起真 agent 进程 → 玩家 bot 发 `!do first_night` → **监听 deepseek 的聊天回话**
 *       （那就是命令的返回文本）+ 抓 agent stdout 里的 `[任务板]` 行。
 */
import { spawn } from 'node:child_process';
import mineflayer from 'mineflayer';
import { rcon } from './rcon.mjs';
import { openBoard } from '../src/agent/library/board_store.js';
import { boardDirOf } from '../src/agent/library/bot_paths.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RC = (c) => rcon(c, { port: 25576 });
const MC_PORT = 25566;
const MS_PORT = 18090;
const OWNER = 'HEAVENZEH';
const AGENT_NAME = 'deepseek';

const boardLines = [];
const chatFromAgent = [];

console.log('启动真 agent（MINECRAFT_PORT=' + MC_PORT + ', MINDSERVER_PORT=' + MS_PORT + '）…');
const proc = spawn(process.execPath, ['main.js'], {
    env: { ...process.env, MINECRAFT_PORT: String(MC_PORT), MINDSERVER_PORT: String(MS_PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
});
let all = '';
proc.stdout.on('data', (b) => {
    const s = String(b); all += s;
    for (const line of s.split('\n')) {
        const t = line.trim();
        if (/任务板|board|mindserver|MindServer running|Console UI/i.test(t) && t.length < 200) {
            boardLines.push(t);
            console.log('  [agent] ' + t.slice(0, 170));
        }
    }
});
proc.stderr.on('data', (b) => { const s = String(b).trim(); if (/board|任务板/i.test(s)) console.log('  [err] ' + s.slice(0, 160)); });

// 等 bot 进服
let joined = false;
for (let i = 0; i < 45; i++) {
    await sleep(2000);
    const list = String(await RC('list').catch(() => ''));
    if (new RegExp('\\b' + AGENT_NAME + '\\b').test(list)) { joined = true; break; }
}
console.log(joined ? '  ✅ agent bot 已进服' : '  ❌ agent bot 未进服');
await sleep(3000);

// 玩家 bot，监听 deepseek 的聊天（= 命令返回文本）
const playerBot = mineflayer.createBot({ host: '127.0.0.1', port: MC_PORT, username: OWNER, auth: 'offline', version: '1.21.8' });
playerBot.on('error', () => { });
playerBot.on('chat', (username, message) => {
    if (username === OWNER) return;
    chatFromAgent.push({ username, message });
    console.log(`  [chat] <${username}> ${String(message).slice(0, 300)}`);
});
await new Promise((res) => { const t = setTimeout(res, 30000); playerBot.once('spawn', () => { clearTimeout(t); res(); }); });
await sleep(2000);

// 找个平地站住（不需要森林，这条只验命令返回）
const p = playerBot.entity.position;
await RC(`tp ${AGENT_NAME} ${Math.floor(p.x) + 2} ${Math.floor(p.y)} ${Math.floor(p.z)}`).catch(() => { });
await sleep(2000);

const db = openBoard(boardDirOf(), { readOnly: true }).db;
const before = db.prepare('SELECT COUNT(*) c FROM jobs').get().c;
console.log(`\n发命令前：任务板总单数 = ${before}`);

console.log('\n发送: !do first_night');
playerBot.chat('!do first_night');
await sleep(20000);   // 20 秒足够看到返回文本

const after = db.prepare('SELECT COUNT(*) c FROM jobs').get().c;
console.log(`\n发命令后：任务板总单数 = ${after}（新增 ${after - before}）`);

// ── 结论 ────────────────────────────────────────────────────────────
console.log('\n════════ 诊断结论 ════════');
console.log('1) agent 的 [任务板] 日志行：');
if (boardLines.length) for (const l of boardLines.slice(0, 8)) console.log('   · ' + l);
else console.log('   （没抓到任何任务板相关日志）');

console.log('2) deepseek 的聊天回话（= 命令返回文本）：');
if (chatFromAgent.length) for (const c of chatFromAgent.slice(0, 8)) console.log(`   · <${c.username}> ${String(c.message).slice(0, 260)}`);
else console.log('   （它一句话都没回 —— 可能 403 卡在回复上，或命令静默返回）');

const txtAll = chatFromAgent.map((c) => String(c.message)).join(' ');
const saysNoBoard = /没有任务板|任务板没连上|noBoard/i.test(txtAll) || /没有任务板|noBoard/i.test(all);
console.log('3) 返回文本/日志里是否出现"没有任务板/noBoard"：' + (saysNoBoard ? '是 🔴' : '否'));
console.log('4) 任务板是否新增了单：' + (after > before ? `是（+${after - before}）` : '否 🔴'));
console.log('5) agent 日志里是否出现"[任务板] 已连接"：' + (/\[任务板\] 已连接/.test(all) ? '是 ✅（board 连上了）' : '否 🔴（board 没连上 → noBoard 分支成立）'));

try { playerBot.quit(); } catch { }
try { proc.kill('SIGTERM'); } catch { }
await sleep(500);
process.exit(0);
