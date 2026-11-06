// 修：安全头中间件必须在 cookie/302 中间件之前，否则 302 提前 return 时没有安全头。
// 复核席实测：302 响应的 csp/xfo/nosniff/referrer 全是 "-"。
// 实际风险≈0（302 无响应体），但会让"四头齐全"在自动化验收里给出**假结论** ——
// 正是今晚一直在防的"检查对象不对"。修法是把安全头中间件整体前移。
const fs = require('fs');
const p = 'src/mindcraft/mindserver.js';
let s = fs.readFileSync(p, 'utf8');

// 1) 摘出安全头中间件（含其上方注释块）
const headerBlock = `    // ★ F-WEB-201 + F-WEB-204（2026-11-06）：HTTP 层也要有门 + 安全响应头。
    //
    // 原来的问题（侦察席实测）：\`/\`、\`/settings_spec.json\`、\`/console/\` 三个出口**无需任何 token**
    // 就返回 200；\`io.use(makeHandshakeGate)\` 只管 socket.io，管不到 HTTP。且零安全头、
    // 还带着 \`X-Powered-By: Express\`（版本指纹）。
    // 诚实边界：socket 事件仍需 token，所以这不是 RCE；但 \`/settings_spec.json\` 会把配置结构
    // （含 allow_insecure_coding / task 这类键名）交给任何本机进程或任意网页。
    //
    // 修法：**同一个 token**，两种携带方式（已种下的 cookie / 首屏的 ?token=）。不新增依赖。
    // 注意：socket.io 的 \`/socket.io/\` 请求由 engine.io 自己接管，不经 express 中间件，
    //      所以它仍由 \`allowRequest\` + \`io.use(makeHandshakeGate)\` 把关（两套门各管各的）。
    app.disable('x-powered-by');
    app.use((req, res, next) => {
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('X-Frame-Options', 'DENY');
        res.setHeader('Referrer-Policy', 'no-referrer');
        res.setHeader(
            'Content-Security-Policy',
            "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; " +
            "script-src 'self' 'unsafe-inline'; connect-src 'self' ws: wss:; frame-ancestors 'none'; base-uri 'none'"
        );
        next();
    });`;

if (!s.includes(headerBlock)) {
    console.error('❌ 安全头中间件原文未匹配（可能 patch-smith 同时改了这块）');
    process.exit(1);
}

// 2) 从原位置删除
s = s.replace(headerBlock + '\n\n', '');

// 3) 插到 cookie/302 中间件之前（即 "浏览器控制台：把 ?token=…" 注释之前）
const anchor = `    // 浏览器控制台：把 ?token=… 换成 HttpOnly + SameSite=Strict 的 cookie，之后同源握手自动带上。`;
if (!s.includes(anchor)) {
    console.error('❌ 锚点未找到');
    process.exit(1);
}

// 移动后的版本：加一行说明为什么必须在前
const movedBlock = headerBlock.replace(
    '    // ★ F-WEB-201 + F-WEB-204（2026-11-06）：HTTP 层也要有门 + 安全响应头。',
    '    // ★ F-WEB-201 + F-WEB-204（2026-11-06）：HTTP 层也要有门 + 安全响应头。\n' +
    '    // ⚠️ 顺序要求（2026-11-06 复核席实测后修正）：**必须注册在 cookie/302 中间件之前**。\n' +
    '    //    否则带 ?token= 的页面导航在下一个中间件里提前 res.redirect(302) return，\n' +
    '    //    安全头一个都设不上（实测 302 响应 csp/xfo/nosniff/referrer 全为 "-"）。\n' +
    '    //    实际风险≈0（302 无响应体），但会让"四头齐全"在自动化验收里给出假结论。'
);

s = s.replace(anchor, movedBlock + '\n\n' + anchor);

fs.writeFileSync(p, s);
console.log('✅ 安全头中间件已前移到 cookie/302 之前');
