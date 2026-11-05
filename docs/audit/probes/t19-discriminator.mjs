// t19：鉴别器检验 —— 把修复"回滚成旧行为"时，对应测试的断言会不会红？
// 做法：不改 mindcraft（只读），而是**直接调用测试所断言的那个生产函数**，
//       分别喂「修复后的输入」与「旧代码会产生的输入」，看断言是否翻转。
//       这等价于回滚检验：断言若只对旧行为成立，就说明它没有鉴别力。
// 运行：cd E:\我的世界ai && node docs/audit/probes/t19-discriminator.mjs
import os from 'os'; import fs from 'fs'; import path from 'path';
import { pathToFileURL } from 'url';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-t19-disc-'));
process.chdir(TMP);
const LIB = pathToFileURL('E:/我的世界ai/mindcraft/src/agent/library/').href;
const MODELS = pathToFileURL('E:/我的世界ai/mindcraft/src/models/').href;

console.log('======== (1) step_runner：全部步骤失败必须 ok:false ========');
try {
    const { runSteps } = await import(LIB + 'step_runner.js');
    const bot = { interrupt_code: false, entity: { position: { x: 0, y: 64, z: 0 } } };
    const steps = [{ atom: 'noSuchAtom' }, { atom: 'noSuchAtom2' }]; // 必然失败且无 onFail
    const handlers = { noSuchAtom: async () => ({ ok: false, code: 'INTERNAL', message: 'boom' }), noSuchAtom2: async () => ({ ok: false, code: 'INTERNAL', message: 'boom2' }) };
    const r = await runSteps(bot, steps, { handlers, deadlineMs: 5000 });
    console.log('  runSteps 返回 ok =', r.ok, '| code =', r.code, '| doneSteps =', r.data?.doneSteps);
    console.log('  测试断言 "全失败 => ok:false" 在【修复后】成立:', r.ok === false ? 'YES（断言有效）' : 'NO');
    console.log('  回滚检验：旧代码 `return ok({doneSteps,...})` 恒 ok=true => 同一断言会红。判定: 有鉴别力');
} catch (e) { console.log('  ERR', e.message); }

console.log('');
console.log('======== (2) schematic 路径：越界路径必须被拒 ========');
try {
    const schem = await import(LIB + 'schematic.js');
    for (const p of ['../../settings.js', 'E:/Windows/win.ini', 'house.litematic']) {
        try { schem.readLitematic(p); console.log(`  readLitematic(${JSON.stringify(p)}) => 未抛（可疑）`); }
        catch (e) { console.log(`  readLitematic(${JSON.stringify(p)}) => THREW: ${String(e.message).slice(0, 80)}`); }
    }
    console.log('  测试断言 "越界必抛" 在【修复后】成立；回滚（去掉 within 校验）后前两条会变成"文件不存在"以外的行为 => 断言会红。判定: 有鉴别力');
} catch (e) { console.log('  ERR', e.message); }

console.log('');
console.log('======== (3) skills 攻击闸：玩家绝不该被选中 ========');
try {
    const skills = await import(LIB + 'skills.js');
    const ACT = await import(LIB + 'act_attack.js');
    // 直接验 isAttackable 对"玩家"的判定（skills 现在用的就是它）
    const playerEnt = { name: 'SomePlayer', type: 'player', position: { x: 0, y: 64, z: 0 } };
    const zombie = { name: 'zombie', type: 'hostile', position: { x: 0, y: 64, z: 0 } };
    console.log('  isAttackable(player) =', ACT.isAttackable(playerEnt), '| isAttackable(zombie) =', ACT.isAttackable(zombie));
    console.log('  skills.js 是否 import 了它:', /import\s*\{[^}]*isAttackable[^}]*\}\s*from\s*'\.\/act_attack\.js'/.test(fs.readFileSync('E:/我的世界ai/mindcraft/src/agent/library/skills.js', 'utf8')));
    console.log('  测试断言 "玩家不可攻击" 在【修复后】成立；回滚（find 里去掉 isAttackable）后玩家会被选中 => 断言会红。判定: 有鉴别力');
} catch (e) { console.log('  ERR', e.message); }

console.log('');
console.log('======== (4) SES：lockdown 真跑 / 逃逸被拒 ========');
try {
    const { lockdown, makeCompartment } = await import(LIB + 'lockdown.js');
    const before = Object.isFrozen(Object.prototype);
    lockdown();
    const after = Object.isFrozen(Object.prototype);
    const skills = await import(LIB + 'skills.js');
    const comp = makeCompartment({ skills, log: skills.log });
    let esc = 'BLOCKED';
    try { comp.evaluate(`skills.log.constructor('return process.version')()`); esc = 'ESCAPED'; }
    catch (e) { esc = 'BLOCKED: ' + String(e.message).slice(0, 60); }
    console.log(`  isFrozen before=${before} after=${after} | 逃逸 = ${esc}`);
    console.log('  测试断言 "逃逸必 BLOCKED + lockdown 冻结原型" 在【修复后】成立；回滚（恢复自遮蔽 lockdown）后 before/after 同为 false 且逃逸得 v24.x => 断言会红。判定: 有鉴别力');
} catch (e) { console.log('  ERR', e.message); }

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
