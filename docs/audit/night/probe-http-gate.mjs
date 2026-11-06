// 复跑 captain 的真机 HTTP 门结论（进程内 fetch，不 spawn 子进程）
// 用法：cd mindcraft && MINDSERVER_TOKEN=<tok> node ../docs/audit/night/probe-http-gate.mjs
const PORT = 18099;
process.env.MINDSERVER_TOKEN = process.env.MINDSERVER_TOKEN || 'probe-token-0123456789abcdef';
const TOK = process.env.MINDSERVER_TOKEN;

const MOD = 'file:///E:/%E6%88%91%E7%9A%84%E4%B8%96%E7%95%8Cai/mindcraft/src/mindcraft/mindserver.js';
const { createMindServer } = await import(MOD);
const srv = createMindServer(false, PORT);

const base = `http://127.0.0.1:${PORT}`;
const results = [];
const ask = async (name, path, accept, method = 'GET') => {
    try {
        const r = await fetch(base + path, {
            method,
            redirect: 'manual',                     // 关键：不自动跟随，否则看不到 302
            headers: accept ? { accept } : {},
        });
        results.push({
            name, path, accept: accept || '(缺省)',
            status: r.status,
            location: r.headers.get('location') || '-',
            csp: !!r.headers.get('content-security-policy'),
            xfo: r.headers.get('x-frame-options') || '-',
            nosniff: r.headers.get('x-content-type-options') || '-',
            referrer: r.headers.get('referrer-policy') || '-',
            poweredBy: r.headers.get('x-powered-by') || '(已移除)',
        });
    } catch (e) {
        results.push({ name, path, accept: accept || '(缺省)', status: 'ERR:' + (e.code || e.name || String(e).slice(0, 40)) });
    }
};

await new Promise(r => setTimeout(r, 800));   // 等 listen 完成（否则第一个请求会 TypeError）
const HTML = 'text/html,application/xhtml+xml';
const JSON_ = 'application/json';

// A. 无 token → 数据接口应 401
await ask('A1 数据接口 无token', '/settings_spec.json', JSON_);
await ask('A2 页面导航 无token', '/console/', HTML);
// B. 带 token 的数据接口 → 200（不该 302）
await ask('B1 数据接口 带token', '/settings_spec.json?token=' + TOK, JSON_);
// C. 带 token 的页面导航 → 302（抹 token）
await ask('C1 页面导航 带token', '/?token=' + TOK, HTML);
// D. 安全头（带 token 的 200 响应）
await ask('D1 index 带token', '/?token=' + TOK, HTML);
// E. socket.io 是否被 HTTP 门误拦（应不是 401）
await ask('E1 socket.io 握手探测', '/socket.io/?EIO=4&transport=polling', '*/*');

console.log('name'.padEnd(24), 'status'.padEnd(7), 'location'.padEnd(28), 'csp', 'xfo', 'nosniff', 'referrer', 'x-powered-by');
for (const r of results) {
    console.log(
        String(r.name).padEnd(24),
        String(r.status).padEnd(7),
        String(r.location).slice(0, 27).padEnd(28),
        r.csp ? 'Y' : '-', String(r.xfo).padEnd(4), String(r.nosniff).padEnd(7),
        String(r.referrer).padEnd(8), r.poweredBy);
}
/* 不 close：socket.io/board 未拆完时 close 会触发 libuv assertion（探针假象） */
setTimeout(() => process.exit(0), 300);
