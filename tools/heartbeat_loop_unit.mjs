/**
 * 第32条：**心跳循环异常不许永久停摆** —— 离线，真驱动循环。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 缺陷原貌（`agent.js`）：
 *     setTimeout(async () => { while (true) { await this.update(start - last); ... } }, 300)
 *   整段**没有 try/catch**。`update()` 里随便一处抛一次（`modes.update()` 里一个
 *   ReferenceError 就够了）→ `while(true)` 被**彻底打死**，而**没有任何人会重启它**；
 *   偏偏聊天走 `handleMessage`、**不依赖**这个循环
 *   ⇒ bot 进入"只会聊天、不会做事"的半死状态：进程活着、面板在线、她再也不动。
 * ══════════════════════════════════════════════════════════════════════════
 *
 * 输出：PASS / FAIL，全过退出码 0。
 */
import { readFileSync } from 'node:fs';
import { runHeartbeatLoop, HEARTBEAT_INTERVAL_MS } from '../src/agent/library/heartbeat_loop.js';

/** 行分隔符（写成常量，免得同一段代码里出现裸控制字符/转义混淆） */
const NEWLINE = String.fromCharCode(10);

let pass = 0, fail = 0;
const okCase = (name, evidence = '') => { pass++; console.log(`PASS ${name} ${evidence}`); };
const badCase = (name, actual) => { fail++; console.log(`FAIL ${name} ${JSON.stringify(actual)}`); };

/** 不真睡：把 sleep 换成"立刻返回"，让用例毫秒级跑完 */
const noSleep = () => Promise.resolve();

// ══════════════════════════════════════════════════════════════════════════
// ① ★ 验收要的那条：**人工构造一次 modes.update() 抛异常** → 心跳继续、日志有告警
//
//    ★ 这里用的是**真的** `runHeartbeatLoop`（agent.js 生产里跑的就是它），
//      只有一个假 agent：它的 `bot.modes.update()` 在第 2 拍抛。
// ══════════════════════════════════════════════════════════════════════════
{
    const warns = [];
    let beats = 0;
    const fakeAgent = {
        bot: {
            modes: {
                update() {
                    beats += 1;
                    if (beats === 2) throw new ReferenceError('fake modes.update blew up');
                },
            },
        },
        async update() { await this.bot.modes.update(); },
    };

    const iterations = await runHeartbeatLoop({
        update: (deltaMs) => fakeAgent.update(deltaMs),
        sleep: noSleep,
        warn: (line) => warns.push(line),
        maxIterations: 6,
    });

    const warned = warns.some((w) => w.includes('心跳') && w.includes('fake modes.update blew up'));
    if (iterations === 6 && beats === 6 && warned) {
        okCase('★ ① modes.update() 在第 2 拍抛异常 → **心跳跑满 6 拍**，且日志里有告警',
            `迭代=${iterations} 实际拍数=${beats} 告警=${warns.length} 条：${warns[0]}`);
    } else {
        badCase('① 一次异常把心跳打死了（第32条回归）', { iterations, beats, warns });
    }
}

// ② 连续抛也不许停（每一拍都抛，仍然跑满）
{
    const warns = [];
    let beats = 0;
    const iterations = await runHeartbeatLoop({
        // ★ 不写 async：体内没有 await（require-await 会点名）。
        //   真实现里 update 是 async 的，所以这里**返回 rejected promise** 保持一致。
        update: () => { beats += 1; return Promise.reject(new Error(`beat-${beats} failed`)); },
        sleep: noSleep,
        warn: (line) => warns.push(line),
        maxIterations: 5,
    });
    if (iterations === 5 && warns.length === 5) {
        okCase('② 连续 5 拍全抛 → 仍然跑满 5 拍、告警 5 条（异常逐拍隔离）', `warns=${warns.length}`);
    } else {
        badCase('② 连续异常时循环没跑满', { iterations, warns: warns.length });
    }
}

// ③ 告警本身抛异常 → 也不许把心跳弄死（告警是次要通道）
{
    let beats = 0;
    const iterations = await runHeartbeatLoop({
        update: () => { beats += 1; return Promise.reject(new Error('boom')); },
        sleep: noSleep,
        warn: () => { throw new Error('warn 通道自己也坏了'); },
        maxIterations: 3,
    });
    if (iterations === 3 && beats === 3) okCase('③ warn 通道自己抛异常 → 心跳照旧跑满（告警不许反噬）', `iter=${iterations}`);
    else badCase('③ 告警失败把心跳带走了', { iterations, beats });
}

// ④ 全都没抛时行为不变：calm 情况不产生任何告警
{
    const warns = [];
    const iterations = await runHeartbeatLoop({
        update: async () => { /* 正常一拍 */ },
        sleep: noSleep,
        warn: (line) => warns.push(line),
        maxIterations: 4,
    });
    if (iterations === 4 && warns.length === 0) okCase('④ 正向对照：没有异常时不产生任何告警（不是无脑刷日志）', 'warns=0');
    else badCase('④ 正常情况也告警了', { iterations, warns });
}

// ⑤ 节拍仍是 300ms（不许"修 bug 顺手把心跳改慢/改快"）
{
    if (HEARTBEAT_INTERVAL_MS === 300) okCase('⑤ 节拍仍是 300ms（HEARTBEAT_INTERVAL_MS=300）', 'ok');
    else badCase('⑤ 节拍被改了', { HEARTBEAT_INTERVAL_MS });
}

// ══════════════════════════════════════════════════════════════════════════
// ⑥ ★★ 失败反证（改之前会怎样）：把老实现的 `while(true)` **原样复刻**跑同一场景
//    老实现 = 没有 try/catch 的循环 → 第 2 拍一抛，循环**当场停**，而且连一句日志都没有
//    （异常变成 unhandled rejection，只有 Node 进程层面的提示）。
// ══════════════════════════════════════════════════════════════════════════
{
    // ↓↓↓ 这是**旧代码的复刻**（只为反证，不参与生产路径）
    const oldStyleLoop = async (update, maxIterations) => {
        let iterations = 0;
        while (iterations < maxIterations) {
            iterations += 1;
            await update();          // ← 没有 try/catch：抛出去就把 while 打死
        }
        return iterations;
    };

    let beats = 0;
    const update = () => {
        beats += 1;
        // 第 2 拍返回 rejected promise（= 旧实现里 modes.update() 抛异常那一刻）
        if (beats === 2) return Promise.reject(new ReferenceError('fake modes.update blew up'));
        return Promise.resolve();
    };

    let reached = null;
    let threw = null;
    try {
        reached = await oldStyleLoop(update, 6);
    } catch (e) {
        threw = String(e?.message ?? e);
    }

    // 老实现：第 2 拍抛 → 循环结束在第 2 拍（reached 拿不到，因为异常冒出来了）
    if (threw != null && beats === 2) {
        okCase('★ ⑥ 失败反证：老实现同一场景在第 2 拍**当场停摆**（异常冒出 while、拍数停在 2） → 新实现跑满 6 拍',
            `旧：抛「${threw}」拍数=${beats}；新：6 拍继续`);
    } else {
        badCase('⑥ 反证不成立（旧实现居然没停）—— 用例本身要看', { reached, threw, beats });
    }
}

// ⑦ 接线守卫：agent.js 必须走 runHeartbeatLoop，且原来的裸 while(true) 已消失
{
    const src = readFileSync('src/agent/agent.js', 'utf8');
    // ★ 只看**代码**（去掉注释行）—— 第一版匹配到了我自己写的说明注释里的 `while (true) {`，
    //   差点把一个正确的修复判成回归（T31 在 b4 上踩过同一类：守卫要看行为，不看文案）。
    const code = src.split(NEWLINE).filter((l) => !/^\s*(\*|\/\/)/.test(l)).join(NEWLINE);
    const wired = code.includes('runHeartbeatLoop({');
    const bareWhile = /while\s*\(\s*true\s*\)\s*\{[\s\S]{0,200}this\.update\(/.test(code);
    if (wired && !bareWhile) okCase('⑦ 接线：agent.js 已改为 runHeartbeatLoop，裸 while(true)+this.update 已消失', 'ok');
    else badCase('⑦ 接线不对（要么没接上、要么还留着裸循环）', { wired, bareWhile });
}

console.log('============================================');
console.log(`${pass}/${pass + fail} 个用例通过`);
console.log('============================================');
process.exit(fail === 0 ? 0 : 1);
