/**
 * SEC-002（2026-11-06 深度检查）—— 环境开关对未知非空值不得默认开启代码执行。
 *
 * 缺陷原貌（main.js）：`INSECURE_CODING` 用排除法判定，只把 0/false/no/off 当关闭，
 * 其它任何非空字符串都 `settings.allow_insecure_coding = true`。
 * 于是 `INSECURE_CODING=disabled`（明显想关）反而把**本机代码执行**打开。
 *
 * 修复：`src/utils/env_flags.js` 的 `parseInsecureCoding()` 改成白名单——
 *   开：1/true/yes/on（大小写、首尾空白不敏感）
 *   关：0/false/no/off
 *   未知（含 disabled/nope/空串/拼错/中文）→ **保持关闭** + 告警
 *   main.js 只在 explicit=true 时才打印开闸横幅并置位。
 *
 * 输出：PASS/FAIL 逐条，全过退出码 0。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    parseInsecureCoding, insecureCodingBanner, INSECURE_CODING_VALUES,
} from '../src/utils/env_flags.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
    if (cond) { pass++; console.log(`PASS ${name} ${detail}`); }
    else { fail++; console.log(`FAIL ${name} ${detail}`); }
};

// ════════════════════════════════════════════════════════════
// A. 显式开启值：必须开，且必须是 explicit
// ════════════════════════════════════════════════════════════
for (const v of ['1', 'true', 'yes', 'on', 'TRUE', 'YES', 'On', ' 1 ', '\ttrue\n']) {
    const r = parseInsecureCoding(v);
    check(`开启值 ${JSON.stringify(v)} → enabled`, r.enabled === true && r.explicit === true,
        `→ ${JSON.stringify(r)}`);
    check(`开启值 ${JSON.stringify(v)} 不产生告警`, r.warn === null);
}

// ════════════════════════════════════════════════════════════
// B. 显式关闭值：必须关
// ════════════════════════════════════════════════════════════
for (const v of ['0', 'false', 'no', 'off', 'FALSE', 'Off', ' 0 ']) {
    const r = parseInsecureCoding(v);
    check(`关闭值 ${JSON.stringify(v)} → disabled`, r.enabled === false && r.explicit === false,
        `→ ${JSON.stringify(r)}`);
}

// ════════════════════════════════════════════════════════════
// C. 未设置：不开、不刷告警（最常见路径，别制造噪音）
// ════════════════════════════════════════════════════════════
for (const v of [undefined, null]) {
    const r = parseInsecureCoding(v);
    check(`未设置 ${String(v)} → 关闭且静默`, r.enabled === false && r.warn === null,
        `→ ${JSON.stringify(r)}`);
}

// ════════════════════════════════════════════════════════════
// D. 未知值（SEC-002 的核心回归）：必须保持关闭 + 告警
// ════════════════════════════════════════════════════════════
const UNKNOWN = ['disabled', 'disable', 'nope', 'enable', 'y', 'n', '2', '-1', '随便', 'ture', '开'];
for (const v of UNKNOWN) {
    const r = parseInsecureCoding(v);
    check(`未知值 ${JSON.stringify(v)} → 保持关闭（不得开闸）`, r.enabled === false,
        `→ enabled=${r.enabled}`);
    check(`未知值 ${JSON.stringify(v)} → explicit=false`, r.explicit === false);
    check(`未知值 ${JSON.stringify(v)} → 有告警`, typeof r.warn === 'string' && r.warn.length > 0,
        `→ ${JSON.stringify(r.warn)}`);
}

const empty = parseInsecureCoding('');
check('空串 → 保持关闭 + 告警（不是「开启」）', empty.enabled === false && typeof empty.warn === 'string');

// 报告点名的那个值，单独钉死
const reported = parseInsecureCoding('disabled');
check('报告复现值 INSECURE_CODING=disabled → allow_insecure_coding 不置位',
    reported.enabled === false, `→ enabled=${reported.enabled}`);

// ════════════════════════════════════════════════════════════
// E. 常量表与横幅文案
// ════════════════════════════════════════════════════════════
check('开启值表只有 1/true/yes/on',
    JSON.stringify(INSECURE_CODING_VALUES.enable) === JSON.stringify(['1', 'true', 'yes', 'on']),
    `→ ${JSON.stringify(INSECURE_CODING_VALUES.enable)}`);
check('关闭值表只有 0/false/no/off',
    JSON.stringify(INSECURE_CODING_VALUES.disable) === JSON.stringify(['0', 'false', 'no', 'off']));
const banner = insecureCodingBanner();
check('横幅点明「本机 root 权限」', /root/.test(banner) && /代码执行已开启/.test(banner));

// ════════════════════════════════════════════════════════════
// F. 接线断言：main.js 必须真的用这个解析器，且不再有旧的排除法分支
// ════════════════════════════════════════════════════════════
const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
check('main.js 引入 parseInsecureCoding',
    /from '\.\/src\/utils\/env_flags\.js'/.test(mainSrc) && /parseInsecureCoding\(/.test(mainSrc));
check('main.js 不再包含旧的排除法（raw === \'0\' || … 后直接 else 开闸）',
    !/raw === '0' \|\| raw === 'false'/.test(mainSrc));
check('main.js 只在 flag.enabled 时置位 allow_insecure_coding',
    /if \(flag\.enabled\) \{\s*\n\s*settings\.allow_insecure_coding = true;/.test(mainSrc));

console.log(`\n${fail === 0 ? 'ALL PASS' : 'HAS FAILURES'}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
