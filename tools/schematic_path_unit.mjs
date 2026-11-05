/**
 * 蓝图路径穿越（第一轮审查 第 1 条 ⑥）—— 不需要 Minecraft 服务器。
 *
 * 缺陷原貌（报告第六层）：`skills.describeSchematic(bot, schematicFile)` →
 * `schematic.js:52 const abs = path.resolve(filePath)` → `:56 fs.readFileSync(abs)`，
 * **resolve 之后没有任何前缀校验**：`'../../settings.js'` 与绝对路径都照读。
 * `listBlueprints(dir)` → `:165 readdirSync(path.resolve(dir))` 同理 = 任意目录枚举。
 * 关键点：这条路**不需要** `allow_insecure_coding`，所以"关掉代码执行"挡不住它。
 *
 * 修复：`resolveSchemPath()` —— 解析后断言落在 `SCHEM_ROOT` 之内（默认 `cwd/schematics`）。
 *
 * 这里用临时目录当 SCHEM_ROOT，**不碰仓库里的真实 schematics/**。
 * 输出：PASS <用例> / FAIL <用例> <实际>，全过退出码 0。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
    if (cond) { pass++; console.log(`PASS ${name} ${detail}`); }
    else { fail++; console.log(`FAIL ${name} ${detail}`); }
};

// ── 造一个临时蓝图根目录：<tmp>/schematics，另有兄弟目录 <tmp>/schematics-evil（前缀陷阱）──
const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'schem-path-'));
const ROOT = path.join(tmpBase, 'schematics');
const EVIL = path.join(tmpBase, 'schematics-evil');     // 与 ROOT 共享字符串前缀
fs.mkdirSync(ROOT, { recursive: true });
fs.mkdirSync(EVIL, { recursive: true });
fs.mkdirSync(path.join(ROOT, 'sub'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'house.litematic'), 'not-a-real-blueprint');
fs.writeFileSync(path.join(EVIL, 'leak.litematic'), 'x');
process.env.SCHEM_ROOT = ROOT;

const schematic = await import('../src/agent/library/schematic.js');
const { resolveSchemPath, isUnder, schemRoot, readLitematic, listSchematics } = schematic;

const throws = (fn) => {
    try { return { threw: false, value: fn() }; }
    catch (e) { return { threw: true, value: e }; }
};
const isEscapeErr = (e) => String(e?.message ?? '').includes('越界');

// ── 1. 判据本身 ─────────────────────────────────────────────
check('SCHEM_ROOT 生效', path.resolve(schemRoot()) === path.resolve(ROOT), `→ ${schemRoot()}`);

check('isUnder: 根目录本身算在内', isUnder(ROOT, ROOT));
check('isUnder: 子路径算在内', isUnder(path.join(ROOT, 'sub', 'a.litematic'), ROOT));
check('isUnder: 前缀相同的兄弟目录**不算**（经典前缀 bug）',
    !isUnder(path.join(EVIL, 'leak.litematic'), ROOT), `evil=${path.join(EVIL, 'leak.litematic')}`);
check('isUnder: 父目录不算在内', !isUnder(path.dirname(ROOT), ROOT));
if (process.platform === 'win32') {
    check('isUnder: Windows 盘符/大小写不敏感',
        isUnder(String.raw`C:\x\y\z.litematic`, String.raw`c:\X\y`));
}

// ── 2. readLitematic：越界必须被拒（报告的原始利用方式）──────────
{
    const r = throws(() => readLitematic('../../settings.js'));
    check("readLitematic('../../settings.js') 被拒", r.threw && isEscapeErr(r.value), `→ ${r.value?.message}`);
}
{
    // 绝对路径：直接指向仓库里的真实文件（报告里就是这么读的）
    const realFile = path.resolve('settings.js');
    const r = throws(() => readLitematic(realFile));
    check(`readLitematic(绝对路径 ${path.basename(realFile)}) 被拒`, r.threw && isEscapeErr(r.value), `→ ${r.value?.message}`);
}
{
    const r = throws(() => readLitematic(path.join(EVIL, 'leak.litematic')));
    check('readLitematic(前缀相同的兄弟目录) 被拒', r.threw && isEscapeErr(r.value), `→ ${r.value?.message}`);
}
{
    const r = throws(() => readLitematic(path.join(ROOT, '..', 'schematics-evil', 'leak.litematic')));
    check('readLitematic(../ 绕一圈) 被拒', r.threw && isEscapeErr(r.value), `→ ${r.value?.message}`);
}
{
    const r = throws(() => readLitematic(path.join(ROOT, 'nope.litematic')));
    check('readLitematic(目录内但文件不存在) → 不是越界错（边界放行、交给后续逻辑）',
        r.threw && !isEscapeErr(r.value), `→ ${r.value?.message}`);
}
{
    // 目录内真实文件：边界放行（内容不是 NBT，解析才会失败 —— 那是另一层的事）
    const r = throws(() => readLitematic(path.join(ROOT, 'house.litematic')));
    check('readLitematic(目录内真实文件) 通过边界检查', r.threw && !isEscapeErr(r.value), `→ ${r.value?.message}`);
}
{
    const r = throws(() => readLitematic('house.litematic'));
    check('readLitematic(裸文件名) 按 SCHEM_ROOT 解析', r.threw && !isEscapeErr(r.value), `→ ${r.value?.message}`);
}

// ── 3. listSchematics：任意目录枚举必须被拒 ────────────────────
{
    const r = throws(() => listSchematics('../../'));
    check("listSchematics('../../') 被拒", r.threw && isEscapeErr(r.value), `→ ${r.value?.message}`);
}
{
    const r = throws(() => listSchematics(path.dirname(tmpBase)));
    check('listSchematics(绝对路径父目录) 被拒', r.threw && isEscapeErr(r.value), `→ ${r.value?.message}`);
}
{
    const r = throws(() => listSchematics(EVIL));
    check('listSchematics(前缀相同的兄弟目录) 被拒', r.threw && isEscapeErr(r.value), `→ ${r.value?.message}`);
}
{
    const r = throws(() => listSchematics(ROOT));
    const names = r.threw ? [] : r.value.map((x) => x.file);
    check('listSchematics(根目录) 正常返回蓝图列表', !r.threw && names.includes('house.litematic'), `→ ${JSON.stringify(names)}`);
}
{
    const r = throws(() => listSchematics(path.join(ROOT, 'sub')));
    check('listSchematics(根目录内的子目录) 允许', !r.threw, `→ ${r.threw ? r.value?.message : 'ok'}`);
}
{
    // 默认参数（skills.listBlueprints 的 './schematics' 走这条）
    const r = throws(() => listSchematics(undefined));
    check('listSchematics() 无参 → 用 SCHEM_ROOT', !r.threw, `→ ${r.threw ? r.value?.message : 'ok'}`);
}

// ── 4. 显式断言 resolveSchemPath 的返回形状 ───────────────────
{
    const p = resolveSchemPath('house.litematic');
    check('resolveSchemPath 返回绝对路径且在根内', path.isAbsolute(p) && isUnder(p, ROOT), `→ ${p}`);
}

// ── 5. 生产形态：SCHEM_ROOT 不设时 = cwd/schematics ─────────────
// （上面用临时目录当根，是为了不碰真实 schematics/；这里把 cwd 挪过去，验默认值那条路）
{
    const base = process.cwd();
    process.chdir(tmpBase);
    delete process.env.SCHEM_ROOT;
    check('默认 SCHEM_ROOT = cwd/schematics', path.resolve(schemRoot()) === path.resolve(ROOT), `→ ${schemRoot()}`);
    const p = resolveSchemPath('./schematics/house.litematic');
    check('默认根下「./schematics/xxx」精确落到文件本身（skills.js 的老写法）',
        path.resolve(p) === path.resolve(ROOT, 'house.litematic'), `→ ${p}`);
    const r = throws(() => readLitematic('../../../settings.js'));
    check('默认根下 ../../../settings.js 仍被拒', r.threw && isEscapeErr(r.value), `→ ${r.value?.message}`);
    process.chdir(base);
}

// ── 清场 ────────────────────────────────────────────────────
fs.rmSync(tmpBase, { recursive: true, force: true });

console.log(`\n${fail === 0 ? 'ALL PASS' : 'HAS FAILURES'}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
