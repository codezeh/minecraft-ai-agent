// B6 验收：断线重连。
// 用 RCON 踢掉 deepseek，测：多久自动回来、回来后位置是否在断开处附近。
import { rcon } from './rcon.mjs';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const RC = (c) => rcon(c, { port: 25575 });

let passed = 0, failed = 0;
function check(name, cond, detail = '') {
    if (cond) { passed++; console.log(`  PASS  ${name}  ${detail}`); }
    else { failed++; console.log(`  FAIL  ${name}  ${detail}`); }
}

async function online() {
    const r = await RC('list');
    return /deepseek/.test(r);
}

async function pos() {
    const r = await RC('data get entity deepseek Pos');
    const m = r.match(/\[(-?[\d.]+)d?,\s*(-?[\d.]+)d?,\s*(-?[\d.]+)d?\]/);
    return m ? { x: +m[1], y: +m[2], z: +m[3] } : null;
}

(async () => {
    if (!(await online())) {
        console.log('  SKIP  deepseek 不在线，先启动 bot');
        process.exit(2);
    }
    const before = await pos();
    console.log(`        断开前位置 ${JSON.stringify(before)}`);

    const t0 = Date.now();
    await RC('kick deepseek 测试断线重连');
    await sleep(1500);
    const wentOffline = !(await online());
    check('被踢后确实离线', wentOffline);

    // 最多等 90 秒自动回来
    let back = false;
    let tBack = 0;
    while (Date.now() - t0 < 90000) {
        await sleep(2000);
        if (await online()) { back = true; tBack = Date.now() - t0; break; }
    }
    check('90 秒内自动重连成功', back, back ? `${(tBack / 1000).toFixed(1)}s 后回到服务器` : '超时未回来');

    if (back) {
        await sleep(3000);
        const after = await pos();
        const d = after && before
            ? Math.hypot(after.x - before.x, after.y - before.y, after.z - before.z)
            : Infinity;
        check('回来后位置在断开处附近（<32 格）', d < 32,
            `断开 ${JSON.stringify(before)} → 回来 ${JSON.stringify(after)}，距离 ${Number.isFinite(d) ? d.toFixed(1) : '未知'} 格`);
    }

    console.log(`\n合计 ${passed} PASS / ${failed} FAIL`);
    process.exit(failed ? 1 : 0);
})();
