/**
 * 第10条回归：`step_runner.runSteps` 的"全部失败仍报成功" + `skills.digTunnel` 的必崩。
 *
 * 背景（报告 v2.1 第10条，已实测）：
 *   ① `skills.js:5750 return ok({...})` 而 `ok` 从来没 import（全文没有 contract.js）
 *      → digTunnel **只要正常返回就抛 ReferenceError**，这个技能从未成功返回过一次。
 *   ② `step_runner.js` 走到末尾无条件 `return ok({...})` —— 一个 3 步的序列
 *      可以三步全 FAIL、doneSteps=0，然后返回 ok:true，上层当成"做成了"。
 *
 * 不需要服务器：假 bot + 假原子处理器。
 * digTunnel 用的是"平地上一切皆空气、脚下一层石头"的假世界，
 * 足够让它走到真正的成功返回（也就是修复前会炸的那一行）。
 *
 * 输出格式：PASS <用例> <证据> / FAIL <用例> <实际>，全过退出码 0。
 */
import Vec3 from 'vec3';
import mcDataLoader from 'minecraft-data';
import { runSteps } from '../src/agent/library/step_runner.js';

// 只为「反向验证」用：把修复前的 skills.js 副本指进来，digTunnel 用例必须变红。
const MODULE = process.env.SKILLS_MODULE ?? '../src/agent/library/skills.js';
const skills = await import(MODULE);

let pass = 0, fail = 0;
const okCase = (name, ev = '') => { pass++; console.log(`PASS ${name} ${ev}`); };
const badCase = (name, actual) => { fail++; console.log(`FAIL ${name} ${actual}`); };

console.log(`被测 skills 模块：${MODULE}`);

/** 假原子：永远失败，带一个明确的码。
 *  同步返回对象即可 —— runSteps 里是 `await handler(...)`，非 Promise 也成立；
 *  写成 async 却没有 await 会踩本仓 require-await（lint 棘轮只许降不许升）。 */
const alwaysFail = () => ({ ok: false, code: 'NO_PATH', message: '假原子：就是走不到' });

/** 假 bot：够 runSteps 用（它只读 interrupt_code）。 */
const bareBot = () => ({ interrupt_code: false });

// ── ① 所有步骤都失败 + 没有 onFail 表 ⇒ 必须是 ok:false，不能是 ok:true ──
{
    const steps = [1, 2, 3].map((n) => ({ step: n, atom: 'fakeMove' }));
    const r = await runSteps(bareBot(), steps, { handlers: { fakeMove: alwaysFail } });
    if (r.ok === false && Array.isArray(r.data?.failed) && r.data.failed.length === 3 && r.data.doneSteps === 0) {
        okCase('① 三步全失败 ⇒ runSteps 返回 ok:false', `code=${r.code} doneSteps=${r.data.doneSteps} failed=${r.data.failed.length}`);
    } else {
        badCase('① 三步全失败 ⇒ runSteps 应返回 ok:false',
            `ok=${r.ok} code=${r.code} data=${JSON.stringify(r.data ?? null).slice(0, 200)}`);
    }
}

// ── ② 反向对照：只要有一步成功，就仍按 ok 返回（别把"部分成功"误判成失败）──
{
    let n = 0;
    const halfOk = () => (n++ === 0 ? { ok: true, code: 'OK' } : { ok: false, code: 'NO_PATH', message: '后一步失败' });
    const steps = [1, 2].map((i) => ({ step: i, atom: 'fakeMove' }));
    const r = await runSteps(bareBot(), steps, { handlers: { fakeMove: halfOk } });
    if (r.ok === true && r.data?.doneSteps === 1 && r.data?.failed?.length === 1) {
        okCase('② 部分成功仍返回 ok（判据只收窄"一步没成"）', `doneSteps=1 failed=1`);
    } else {
        badCase('② 部分成功应仍返回 ok', `ok=${r.ok} data=${JSON.stringify(r.data ?? null).slice(0, 200)}`);
    }
}

// ── ③ 全失败 + onFail 显式 abort ⇒ 早退路径不变（回归）──────────────────
{
    const steps = [{ step: 1, atom: 'fakeMove', onFail: [{ code: '*', action: 'abort' }] }];
    const r = await runSteps(bareBot(), steps, { handlers: { fakeMove: alwaysFail } });
    if (r.ok === false && r.code === 'NO_PATH') {
        okCase('③ onFail=abort 的早退路径不变', `code=${r.code}`);
    } else {
        badCase('③ onFail=abort 应早退 fail(NO_PATH)', `ok=${r.ok} code=${r.code}`);
    }
}

// ── ④ 中断优先：interrupt_code 为真 ⇒ INTERRUPTED（不被"全失败"吞掉）──────
{
    const steps = [{ step: 1, atom: 'fakeMove' }];
    const bot = { interrupt_code: true };
    const r = await runSteps(bot, steps, { handlers: { fakeMove: alwaysFail } });
    if (r.ok === false && r.code === 'INTERRUPTED') okCase('④ 中断优先返回 INTERRUPTED', `code=${r.code}`);
    else badCase('④ 中断应优先返回 INTERRUPTED', `ok=${r.ok} code=${r.code}`);
}

// ── ⑤ skills.digTunnel **正常返回**不得抛异常（第10条的必崩点）────────────
//
// 假世界：平地上全是空气、脚下一层石头（y=63）。
// tunnelStep 会挖 0 格、直接走到下一格 —— 也就是走完一步、runSteps 全成功。
// 修复前这里会走到 `return ok({steps:n, to})`，然后抛 ReferenceError: ok is not defined。
{
    const registry = mcDataLoader('1.21.8');
    const pos = new Vec3(0.5, 64, 0.5);
    const bot = {
        username: 'unit_digtunnel',
        registry,
        entity: { position: pos },
        game: { dimension: 'overworld' },
        inventory: { items: () => [], slots: [] },
        blockAt: (p) => {
            const y = Math.floor(p.y);
            return {
                name: y === 63 ? 'stone' : 'air',
                position: new Vec3(Math.floor(p.x), y, Math.floor(p.z)),
                boundingBox: 'block',
            };
        },
        pathfinder: {
            setMovements() { }, setGoal() { }, stop() { }, isMoving: () => false,
            // 真 pathfinder.goto() 返回 Promise；这里返回 Promise 但不用 async（没 await 可写）
            goto: () => { pos.x += 1; return Promise.resolve(); },
        },
        controlState: {},
        clearControlStates() { },
    };

    let threw = null, r = null;
    try {
        r = await skills.digTunnel(bot, 1, 0, 1);
    } catch (e) {
        threw = e;
    }
    const good = !threw && r && r.ok === true && r.data?.steps === 1;
    if (good) {
        okCase('⑤ skills.digTunnel 正常返回不抛异常（ok is not defined 已修）',
            `返回 ok=${r.ok} data=${JSON.stringify(r.data)}`);
    } else if (threw) {
        badCase('⑤ skills.digTunnel 正常返回不得抛异常',
            `抛了 ${threw.constructor?.name}: ${threw.message}`);
    } else {
        badCase('⑤ skills.digTunnel 应返回 ok:true', `r=${JSON.stringify(r)}`);
    }
}

console.log('============================================');
console.log(`${pass}/${pass + fail} 个用例通过`);
console.log('============================================');
process.exit(fail === 0 ? 0 : 1);
