// T0 join-bot: connect ONE bot to 127.0.0.1:25565 with bare mineflayer.
//
// Why bare mineflayer instead of a mindcraft profile (真实差异，必须记录):
//   settings.js 的 profiles 只有 ./profiles/my-local.json，指向 https://api.llmgo.net/v1
//   （远端收费中转），本机没有任何本地模型服务在监听（11434/8000/1234 全空）。
//   T0 只需要「有一个 bot 在服里」，不需要模型推理 ⇒ 用裸 mineflayer，零费用。
//   代价：这个 bot 由本脚本直接持有，**不经过 mindserver**，所以
//   (a) 面板的 bot/agent 列表里看不到它；(b) 面板数据来源 = 服务器侧（RCON /list、/tps）。
//
// 这个文件只存在于 docs/真机-20261106/T0/，不改动产品源码。
// 用法: node join-bot.mjs [username]
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';

const MIND_PKG = 'E:/我的世界ai/mindcraft/package.json';
const require = createRequire(MIND_PKG);          // 复用 mindcraft/node_modules（mineflayer 4.39.0）
const mineflayer = require('mineflayer');

const USER = process.argv[2] || 'probe1';         // offline-mode：用户名即身份
const HOST = '127.0.0.1';
const PORT = 25565;
const T0 = 'E:/我的世界ai/docs/真机-20261106/T0';
const STAMP = () => new Date().toISOString();

function log(s) { console.log(`[${STAMP()}] ${s}`); }

const bot = mineflayer.createBot({
    host: HOST,
    port: PORT,
    username: USER,
    auth: 'offline',
    version: '1.21.8',
    chatLengthLimit: 256,
});

bot.once('spawn', () => {
    const p = bot.entity.position;
    const info = {
        joinedAt: STAMP(),
        username: bot.username,
        uuid: bot.player?.uuid ?? null,
        host: HOST,
        port: PORT,
        version: bot.version,
        spawn: { x: +p.x.toFixed(3), y: +p.y.toFixed(3), z: +p.z.toFixed(3) },
        yaw: +bot.entity.yaw.toFixed(4),
        dimension: bot.game?.dimension ?? null,
        health: bot.health,
        food: bot.food,
        gamemode: bot.game?.gameMode ?? null,
        ping: bot.player?.ping ?? null,
        serverBrand: bot.game?.serverBrand ?? null,
        pid: process.pid,
    };
    log('SPAWN OK ' + JSON.stringify(info));
    writeFileSync(T0 + '/bot-join.json', JSON.stringify(info, null, 2));
});

bot.on('spawn', () => {
    // 常驻：每 30s 刷新一次 ping/位置快照，供后续任务对照
    const t = setInterval(() => {
        if (!bot.entity) return;
        const p = bot.entity.position;
        const snap = {
            at: STAMP(),
            x: +p.x.toFixed(3), y: +p.y.toFixed(3), z: +p.z.toFixed(3),
            ping: bot.player?.ping ?? null,
            health: bot.health,
            food: bot.food,
            players: Object.keys(bot.players).filter(n => n !== bot.username),
        };
        log('SNAP ' + JSON.stringify(snap));
        try { writeFileSync(T0 + '/bot-last.json', JSON.stringify(snap, null, 2)); } catch { }
    }, 30000);
    t.unref?.();
});

bot.on('kicked', (reason) => {
    log('KICKED ' + JSON.stringify(reason));
    writeFileSync(T0 + '/bot-kicked.json', JSON.stringify({ at: STAMP(), reason }, null, 2));
    process.exit(10);
});
bot.on('error', (e) => log('ERROR ' + (e && e.message ? e.message : String(e))));
bot.on('end', (r) => { log('END ' + (r || '')); writeFileSync(T0 + '/bot-end.json', JSON.stringify({ at: STAMP(), reason: String(r || '') }, null, 2)); process.exit(11); });

process.on('SIGINT', () => { try { bot.quit('sigint'); } catch { } process.exit(0); });
