// 验收 !map：真实主世界，看它读出来的内容是不是「人话 + 有用」。
// 只读，不改方块。
import mineflayer from 'mineflayer';
import pf from 'mineflayer-pathfinder';
import { getCommand } from '../src/agent/commands/index.js';
import { setSettings } from '../src/agent/settings.js';
import settings from '../settings.js';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
setSettings(settings);

let passed = 0, failed = 0;
function check(name, cond, detail = '') {
    if (cond) { passed++; console.log(`  PASS  ${name}  ${detail}`); }
    else { failed++; console.log(`  FAIL  ${name}  ${detail}`); }
}

const bot = mineflayer.createBot({ host: '127.0.0.1', port: 25565, username: 'deepseek', auth: 'offline', version: '1.21.8' });
bot.loadPlugin(pf.pathfinder);
bot.on('error', (e) => { console.log('ERR', e.message); process.exit(1); });
bot.on('kicked', (r) => { console.log('KICKED', String(r).slice(0, 120)); process.exit(2); });

bot.once('spawn', async () => {
    await sleep(3000);
    const p = bot.entity.position;
    console.log(`  bot 在 ${p.floored()}`);

    const cmd = getCommand('!map');
    check('!map 命令已注册', !!cmd);

    // 1) 首次调用（不 refresh）：应该告诉她「都还没探索」
    const first = await cmd.perform({ bot }, false);
    console.log('\n--- 首次 !map（未扫描）---');
    console.log(first);
    check('首次能说明区块坐标', /区块 \(/.test(first), '');
    check('首次提示未探索或已有数据', /还没去过|附近已探索/.test(first), '');

    // 2) refresh 后
    const t0 = Date.now();
    const second = await cmd.perform({ bot }, true);
    const ms = Date.now() - t0;
    console.log('\n--- refresh 后 ---');
    console.log(second);
    check('refresh 会真的扫描并报告耗时', /刚扫了半径/.test(second), `${ms}ms`);
    check('refresh 后地形有内容', /地表 y=/.test(second), '');
    check('refresh 够快（<1s）', ms < 1000, `${ms}ms`);

    // 3) 带去目标的粗规划
    const third = await cmd.perform({ bot }, false, p.x + 200, p.z + 100);
    console.log('\n--- 带目标的粗规划 ---');
    console.log(third);
    check('能给出途经区块数', /要经过 \d+ 个区块/.test(third), '');

    // 4) 输出行数（不能太长，模型要读）
    const lines = third.split('\n').filter(Boolean).length;
    check('输出不超过 10 行', lines <= 10, `${lines} 行`);

    // 5) 二次 refresh 不应重复扫描浪费（数据已在，见 seenAt 更新）
    const t1 = Date.now();
    await cmd.perform({ bot }, true);
    const ms2 = Date.now() - t1;
    check('重复 refresh 依然够快', ms2 < 1000, `${ms2}ms`);

    console.log(`\n合计 ${passed} PASS / ${failed} FAIL`);
    bot.quit();
    process.exit(failed ? 1 : 0);
});
