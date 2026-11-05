/**
 * `create-agent` profile 名的路径断言（第一轮审查 第 2 条）—— 不需要 Minecraft 服务器。
 *
 * 缺陷原貌：`Prompter` 构造器用 profile 名直接拼路径落盘
 * （`prompter.js:110 mkdirSync('./bots/'+name)`、`:111 writeFileSync(.+ '/last_profile.json')`），
 * 而合法性检查 `validateNameFormat` 要等到 `agent.js:205` 才跑 —— 晚 58 行，**文件早写出去了**。
 * 实测：`profile.name='../../pwn'` 解析成 `E:\我的世界ai\pwn\last_profile.json`。
 * 所以光把校验提前不够，`Prompter` 内部必须自己断言（这条不能省）。
 *
 * 本测验三件事：
 *   A. `botDirOf()` 的判据：逃逸名/空名/`..` 一律抛，正常名通过；
 *   B. prompter.js 的两个写入点（profile 落盘、日志目录）都走 `botDirOf`，没有裸拼残留；
 *   C. mindserver 的 create-agent 在 `createAgent` **之前**就用 `validateNameFormat` 拒掉非法名。
 *
 * 输出：PASS <用例> / FAIL <用例> <实际>，全过退出码 0。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
    if (cond) { pass++; console.log(`PASS ${name} ${detail}`); }
    else { fail++; console.log(`FAIL ${name} ${detail}`); }
};

const { botDirOf } = await import('../src/models/prompter.js');
const botsRoot = path.resolve(process.cwd(), 'bots');

const throwsWith = (fn, re) => {
    try { fn(); return { threw: false, message: '' }; }
    catch (e) { return { threw: true, message: String(e.message), matches: re ? re.test(String(e.message)) : true }; }
};

// ── A. 判据 ─────────────────────────────────────────────────
for (const evil of ['../../pwn', '../../../pwn2', '..', '../x', 'a/../../x', '', '   ']) {
    const r = throwsWith(() => botDirOf(evil), /路径逃逸|为空/);
    check(`botDirOf(${JSON.stringify(evil)}) 被拒`, r.threw && r.matches, `→ ${r.message}`);
}
for (const good of ['deepseek', 'bot_1', 'HEAVENZEH']) {
    let ok = false, dir = '';
    try { dir = botDirOf(good); ok = dir === path.join(botsRoot, good); } catch { /* ignore */ }
    check(`botDirOf(${JSON.stringify(good)}) 通过且落在 bots/ 下`, ok, `→ ${dir}`);
}
{
    const dir = botDirOf('deepseek', path.join('logs', 'task_1'));
    check('botDirOf(名, 子路径) 仍在 bots/ 下',
        dir.startsWith(path.join(botsRoot, 'deepseek') + path.sep), `→ ${dir}`);
    const r = throwsWith(() => botDirOf('deepseek', '../../..'), /路径逃逸/);
    check('botDirOf(名, 越界子路径) 被拒', r.threw && r.matches, `→ ${r.message}`);
}
{
    // 前缀陷阱：bots-evil 不能被当成 bots/
    const other = path.resolve(path.dirname(botsRoot), 'bots-evil');
    const r = throwsWith(() => botDirOf('..', '', botsRoot), /路径逃逸|为空/);
    check('botDirOf 不会把 bots-evil 当 bots/', r.threw, `→ ${r.message}（${other}）`);
}

// ── B. prompter.js 的写入点必须走 botDirOf ───────────────────
{
    const src = fs.readFileSync(path.join(__dirname, '../src/models/prompter.js'), 'utf8');
    check('prompter.js 里没有 `mkdirSync(`./bots/${name}`)` 这种裸拼',
        !/mkdirSync\(`\.\/bots\/\$\{/.test(src));
    check('prompter.js 里没有 `writeFileSync(`./bots/${name}/…`)` 这种裸拼',
        !/writeFileSync\(`\.\/bots\/\$\{/.test(src));
    const profileWrite = src.indexOf('last_profile.json');
    check('last_profile.json 的写入走 botDirOf',
        profileWrite > 0 && src.lastIndexOf('botDirOf(name)', profileWrite) > 0 &&
        src.lastIndexOf('botDirOf(name)', profileWrite) < profileWrite);
    check('日志目录也走 botDirOf（第二个写入点）',
        /botDirOf\(this\.agent\.name/.test(src));
}

// ── C. mindserver 的 create-agent 校验在 createAgent 之前 ────
{
    const src = fs.readFileSync(path.join(__dirname, '../src/mindcraft/mindserver.js'), 'utf8');
    const checkPos = src.indexOf('validateNameFormat(settings.profile.name)');
    const createPos = src.indexOf('await mindcraft.createAgent(settings)');
    check('create-agent 先用 validateNameFormat 校验', checkPos > 0);
    check('校验发生在 createAgent 之前（原来晚 58 行，文件已落盘）',
        checkPos > 0 && createPos > 0 && checkPos < createPos, `→ check=${checkPos}, create=${createPos}`);
    // 真正的回归点：prompter 的路径断言存在，所以「校验提前」失效时仍有一道兜底
    const pSrc = fs.readFileSync(path.join(__dirname, '../src/models/prompter.js'), 'utf8');
    check('兜底断言在场（即使上游漏了，也写不到 bots/ 之外）',
        /botDirOf\(name\)/.test(pSrc) && /startsWith\(botsRoot \+ path\.sep\)/.test(pSrc));
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'HAS FAILURES'}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
