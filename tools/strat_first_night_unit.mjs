/** t32 / M10：strat_first_night 离线用例（跳过已满足 / dependsOn / 嵌套闸 / 不碰身体）。 */
import { planFirstNight, firstNight, manifest, isNightFalling, isNight, FIRST_NIGHT } from '../src/agent/library/strat_first_night.js';
import { planObtain, MAX_DEPTH, MAX_JOBS } from '../src/agent/library/strat_obtain.js';
import { CODES } from '../src/agent/library/contract.js';
import { readFileSync } from 'node:fs';

let pass = 0, fails = 0;
const ok = (n, e = '') => { pass++; console.log(`PASS ${n} ${e}`); };
const bad = (n, a) => { fails++; console.log(`FAIL ${n} ${JSON.stringify(a)}`); };
const check = (n, c, e = '') => (c ? ok(n, e) : bad(n, e));

const keys = (r) => r.steps.map((s) => s.key);

// ① 空手开局 + 夜里 → 完整链（木头→工作台→木镐→石镐→遮蔽→吃）
{
    const r = planFirstNight({ inventory: {}, timeOfDay: 14000, foodCount: 0 });
    check('① 空手+夜里 → 拆出完整链 wood→table→wooden_pickaxe→stone_pickaxe→shelter→eat',
        keys(r).join(',') === 'wood,table,wooden_pickaxe,stone_pickaxe,shelter,eat',
        keys(r).join(' → '));
}

// ② 已有石镐 → 前面全跳过（只剩可能吃/遮蔽）
{
    const r = planFirstNight({ inventory: { stone_pickaxe: 1 }, timeOfDay: 14000, foodCount: 0 });
    const k = keys(r);
    const skippedKeys = r.skipped.map((s) => s.key);
    const toolStepsGone = !k.includes('wood') && !k.includes('table')
        && !k.includes('wooden_pickaxe') && !k.includes('stone_pickaxe');
    check('② 已有石镐 → 木头/工作台/木镐/石镐全部跳过（只可能剩 shelter+éat）',
        toolStepsGone && ['wood', 'table', 'wooden_pickaxe', 'stone_pickaxe'].every((x) => skippedKeys.includes(x)),
        `剩余=${k.join(',') || '(无)'} 跳过=${skippedKeys.join(',')}`);
}

// ②b 已有石镐 + 白天 + 吃饱 → 一步都不做（策略的核心价值）
{
    const r = planFirstNight({ inventory: { stone_pickaxe: 1 }, timeOfDay: 1000, foodCount: 20 });
    check('②b 石镐+白天+饱 → 0 张子单（什么都不用做）',
        r.steps.length === 0 && r.skipped.length === 6, `steps=${r.steps.length} skipped=${r.skipped.length}`);
}

// ③ 天还亮着 → 不拆 shelter
{
    const day = planFirstNight({ inventory: {}, timeOfDay: 1000, foodCount: 0 });
    const night = planFirstNight({ inventory: {}, timeOfDay: 14000, foodCount: 0 });
    const daySkip = day.skipped.find((s) => s.key === 'shelter');
    check('③ 白天不拆 shelter（且 why 里写明"天还亮着"）；夜里才拆',
        !keys(day).includes('shelter') && keys(night).includes('shelter')
        && /天还亮着/.test(daySkip?.why ?? ''),
        `白天=${keys(day).join(',')} 夜=${keys(night).join(',')} dayWhy=${daySkip?.why ?? '-'}`);
}

// ③b 有床 → 用 sleep 而不是 shelter（04 §6.3「flow_shelter 或 flow_sleep」）
{
    const r = planFirstNight({ inventory: {}, timeOfDay: 14000, hasBed: true, foodCount: 0 });
    check('③b 夜里且有床 → 出 sleep 而不是 shelter',
        keys(r).includes('sleep') && !keys(r).includes('shelter'), keys(r).join(','));
}

// ④ dependsOn 正确：石镐←木镐，木镐←工作台，工作台←木头
{
    const r = planFirstNight({ inventory: {}, timeOfDay: 14000, foodCount: 0 });
    const dep = Object.fromEntries(r.steps.map((s) => [s.key, s.dependsOnKeys]));
    check('④ ★ dependsOn：wood[] / table←wood / wooden_pickaxe←table / stone_pickaxe←wooden_pickaxe',
        JSON.stringify(dep.table) === '["wood"]'
        && JSON.stringify(dep.wooden_pickaxe) === '["table"]'
        && JSON.stringify(dep.stone_pickaxe) === '["wooden_pickaxe"]',
        JSON.stringify(dep));
}

// ⑤ ★★ 嵌套闸：planObtain 的闸是"每次调用各自算"还是"共享"？
{
    // 直接验证：同一个"永远缺料"的链连调两次，各自都能展开到 MAX_DEPTH →
    // 说明闸是 **per-call（各自算）**，不是共享的全局预算。
    let n = 0;
    const infinite = () => { n++; return [{ type: 'craft', recipe: { ['m' + n]: 1 }, cost: 1 }]; };
    const run1 = planObtain({ item: 'a', count: 1, inventory: {}, chests: {}, deps: { sourcesOf: infinite } });
    const run2 = planObtain({ item: 'b', count: 1, inventory: {}, chests: {}, deps: { sourcesOf: infinite } });
    const perCall = run1.plan.length <= MAX_JOBS && run2.plan.length <= MAX_JOBS
        && run1.plan.length > 0 && run2.plan.length > 0;

    // 所以 first_night 自己必须加一道**全局**闸：4 个 obtain 步 × 30 张 = 120 张是可能的。
    const unbounded = planFirstNight({ inventory: {}, timeOfDay: 14000, foodCount: 0, maxJobs: 99 });
    const bounded = planFirstNight({ inventory: {}, timeOfDay: 14000, foodCount: 0 });   // 默认 12
    check('⑤ ★★ planObtain 的闸是 per-call（各自算，非共享）→ first_night 必须自带全局闸',
        perCall && unbounded.steps.length === 6 && bounded.steps.length <= FIRST_NIGHT.MAX_TOTAL_JOBS,
        `run1=${run1.plan.length} run2=${run2.plan.length}（各 ≤${MAX_JOBS}，证明各自算）`
        + ` / first_night 默认上限=${FIRST_NIGHT.MAX_TOTAL_JOBS}`);
}

// ⑤b 全局闸真的会截断
{
    const r = planFirstNight({ inventory: {}, timeOfDay: 14000, foodCount: 0, maxJobs: 3 });
    check('⑤b first_night 的全局闸会截断（maxJobs=3 → 只剩 3 张且标记 hitJobCap）',
        r.steps.length === 3 && r.hitJobCap === true, `steps=${r.steps.length} hitJobCap=${r.hitJobCap}`);
}

// ⑤c 时间判定纯函数（可注入，不用等天黑）
{
    check('⑤c isNightFalling/isNight 可按注入时间判定（1000 白天 / 14000 夜）',
        isNightFalling(1000) === false && isNightFalling(14000) === true
        && isNight(1000) === false && isNight(14000) === true,
        `1000: falling=${isNightFalling(1000)} night=${isNight(1000)} / 14000: falling=${isNightFalling(14000)} night=${isNight(14000)}`);
}

// ⑥ ★ 源码级：策略文件不许有身体操作
{
    const files = ['src/agent/library/strat_first_night.js', 'src/agent/library/strat_obtain.js',
        'src/agent/library/strat_tool_tier.js'];
    const bads = [];
    for (const f of files) {
        let src;
        try { src = readFileSync(f, 'utf8'); } catch { continue; }
        const code = src.split('\n').filter((l) => !/^\s*(\*|\/\/)/.test(l)).join('\n');
        if (/\b(holdKey|digBlock|placeBlockAt|setControlState)\b/.test(code)) bads.push(f);
    }
    check('⑥ ★ 策略层源码无 holdKey/digBlock/placeBlockAt/setControlState', bads.length === 0, bads.join(',') || '干净');
}

// ⑦ manifest
{
    const codesOk = (manifest.codes ?? []).every((c) => c === 'OK' || CODES.includes(c));
    check('⑦ manifest name=first_night、level=strat、codes 全已注册',
        manifest.name === 'first_night' && manifest.level === 'strat' && codesOk,
        `name=${manifest.name} level=${manifest.level}`);
}

// ⑧ firstNight() 真的下带 parentId/why/dependsOn 的子单
{
    const added = [];
    const fakeBoard = {
        async add(job) {
            if (!job?.skill) return { ok: false, message: '缺少 skill' };   // 与真板同规则
            added.push(job);
            return { ok: true, data: { id: 'j_' + added.length } };
        },
    };
    const r = await firstNight({ name: 'tester' }, {
        board: fakeBoard, inventory: {}, timeOfDay: 14000, foodCount: 0,
    });
    const children = added.slice(1);
    const hasParent = children.length > 0 && children.every((c) => c.parentId === 'j_1');
    const hasWhy = children.every((c) => typeof c.why === 'string' && c.why.length > 0);
    const stoneDep = children.find((c) => c.skill === 'craft' && c.args?.item === 'stone_pickaxe');
    check('⑧ ★ 子单都带 parentId + why；石镐子单带 dependsOn（指向木镐的真实 job id）',
        r.ok && hasParent && hasWhy && Array.isArray(stoneDep?.dependsOn) && stoneDep.dependsOn.length === 1,
        `子单 ${children.length} 张，石镐 dependsOn=${JSON.stringify(stoneDep?.dependsOn)}`);
}

console.log('============================================');
console.log(`${pass}/${pass + fails} 个用例通过`);
console.log('============================================');
process.exit(fails === 0 ? 0 : 1);
