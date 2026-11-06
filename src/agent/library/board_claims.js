/**
 * 预约 key 的语义（M8 B3，06 §9.2，设计见 M8_实施设计.md §5）。
 *
 * **纯函数，不碰数据库** —— 这样"两个 key 算不算冲突"可以离线逐条验，
 * 不用起 bot、不用连 socket。真正的读写库在 `board_store.js` 的
 * `reserve/release/expireClaims`。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 六种 key（06 §9.2 原表 + 设计 §5 的 `item:`）：
 *
 *   block:x,y,z              一块方块      —— 防两个 bot 砍同一棵树/挖同一块矿
 *   area:x,y,z:r             一片圆形区域  —— 防在同一片地方建/挖
 *   container:x,y,z          一个容器      —— 防同时开同一个箱子导致计数对不上
 *   station:furnace@x,y,z    一台工作站    —— 防抢同一个熔炉
 *   entity:<uuid>            一个实体      —— 防打同一只怪/和同一个村民交易
 *   item:<name>[:n]          某种物品额度  —— 防两人抢同一份材料
 *
 * ★ **跨类型也要判**（这条最容易漏，但正是它的用途）：
 *   A 预约了 `area:0,64,0:16`，B 想挖 `block:3,64,3` —— 那个方块**就在 A 的圆里**，
 *   必须算冲突。只做"同类型精确匹配"等于没防住真正的撞车。
 * ═══════════════════════════════════════════════════════════════════════════
 */

/** 支持的 key 种类（06 §9.2 + item）。 */
export const CLAIM_KINDS = Object.freeze(['block', 'area', 'container', 'station', 'entity', 'item']);

/**
 * 解析一个 key。
 *
 * @param {string} raw
 * @returns {{ok:true, kind:string, raw:string, ...} | {ok:false, error:string}}
 */
export function parseClaimKey(raw) {
    const s = String(raw ?? '').trim();
    if (!s) return { ok: false, error: '空的预约 key' };
    const colon = s.indexOf(':');
    if (colon <= 0) return { ok: false, error: `key 必须形如 "kind:..."（收到 "${s}"）` };
    const kind = s.slice(0, colon);
    const body = s.slice(colon + 1);
    if (!CLAIM_KINDS.includes(kind)) {
        return { ok: false, error: `未知的预约种类 "${kind}"（可用：${CLAIM_KINDS.join('/')}）` };
    }

    // block / container: x,y,z
    if (kind === 'block' || kind === 'container') {
        const p = parseXYZ(body);
        if (!p) return { ok: false, error: `${kind} 需要 "x,y,z"（收到 "${body}"）` };
        return { ok: true, kind, raw: s, ...p };
    }

    // station: furnace@x,y,z（名字可选，缺省 station）
    if (kind === 'station') {
        const at = body.indexOf('@');
        const name = at >= 0 ? body.slice(0, at) : 'station';
        const p = parseXYZ(at >= 0 ? body.slice(at + 1) : body);
        if (!p) return { ok: false, error: `station 需要 "名字@x,y,z"（收到 "${body}"）` };
        return { ok: true, kind, raw: s, name: name || 'station', ...p };
    }

    // area: x,y,z:r
    if (kind === 'area') {
        const last = body.lastIndexOf(':');
        if (last < 0) return { ok: false, error: `area 需要 "x,y,z:半径"（收到 "${body}"）` };
        const p = parseXYZ(body.slice(0, last));
        const r = Number(body.slice(last + 1));
        if (!p || !Number.isFinite(r) || r <= 0) {
            return { ok: false, error: `area 的半径要是正数（收到 "${body.slice(last + 1)}"）` };
        }
        return { ok: true, kind, raw: s, ...p, r };
    }

    // entity: <id>
    if (kind === 'entity') {
        if (!body) return { ok: false, error: 'entity 需要实体 id/uuid' };
        return { ok: true, kind, raw: s, id: body };
    }

    // item: name[:n]
    {
        const last = body.lastIndexOf(':');
        let name = body, n = null;
        if (last > 0) {
            const maybe = Number(body.slice(last + 1));
            if (Number.isFinite(maybe)) { name = body.slice(0, last); n = maybe; }
        }
        if (!name) return { ok: false, error: 'item 需要物品名' };
        return { ok: true, kind, raw: s, name, n };
    }
}

/** "x,y,z" → {x,y,z}；不合法返回 null。 */
function parseXYZ(s) {
    const parts = String(s ?? '').split(',').map((v) => Number(v.trim()));
    if (parts.length !== 3 || parts.some((v) => !Number.isFinite(v))) return null;
    return { x: parts[0], y: parts[1], z: parts[2] };
}

/**
 * 两个 key 是否**真的冲突**（跨类型也判）。
 *
 * @returns {boolean}
 */
export function claimsConflict(a, b) {
    const A = typeof a === 'string' ? parseClaimKey(a) : a;
    const B = typeof b === 'string' ? parseClaimKey(b) : b;
    if (!A?.ok || !B?.ok) return false;      // 解析不了的不管（由校验层拒掉）

    // ── 方块 × 方块：同坐标才冲突 ──
    if (A.kind === 'block' && B.kind === 'block') return samePoint(A, B);

    // ── 容器 × 容器：同坐标 ──
    if (A.kind === 'container' && B.kind === 'container') return samePoint(A, B);

    // ── 工作站 × 工作站：同名**且**同坐标（不同熔炉不冲突）──
    if (A.kind === 'station' && B.kind === 'station') {
        return String(A.name ?? '') === String(B.name ?? '') && samePoint(A, B);
    }

    // ── 实体 × 实体：同 id ──
    if (A.kind === 'entity' && B.kind === 'entity') return String(A.id) === String(B.id);

    // ── 物品额度 × 物品额度：同名物品（额度是"谁能拿这份材料"，同名即冲突）──
    if (A.kind === 'item' && B.kind === 'item') return String(A.name) === String(B.name);

    // ── 区域 × 区域：两圆相交 ──
    if (A.kind === 'area' && B.kind === 'area') return circlesOverlap(A, B);

    // ── ★ 区域 × 点（block/container/station）：点在圆里就算冲突 ──
    if (A.kind === 'area' && hasPoint(B)) return pointInCircle(B, A);
    if (B.kind === 'area' && hasPoint(A)) return pointInCircle(A, B);

    // 其余组合（如 entity × block）语义上无关 → 不冲突
    return false;
}

function hasPoint(k) {
    return ['block', 'container', 'station'].includes(k?.kind);
}
function samePoint(a, b) {
    return a.x === b.x && a.y === b.y && a.z === b.z;
}
/**
 * 圆是否相交（按 06 §9.2 只看水平面）。
 *
 * ★ 用**严格小于**：两个网格**边界相切**不算冲突。
 *   实测（B3 拆区）：32×32 切成 4 块 16×16，圆心相距 16、半径各 8，
 *   正好 `d === r1+r2` —— 若用 `<=`，相邻两块永远"冲突"，
 *   于是**两个 bot 永远没法在同一片地里分块干活**，拆单等于白拆。
 *   相切=只是挨着，不是重叠。
 */
function circlesOverlap(a, b) {
    const d = Math.hypot(a.x - b.x, a.z - b.z);
    return d < (Number(a.r) + Number(b.r));
}
/** 点是否在圆内（同样用严格小于：正好在边界上的方块不算被占）。 */
function pointInCircle(pt, circle) {
    return Math.hypot(pt.x - circle.x, pt.z - circle.z) < Number(circle.r);
}

/**
 * 校验一批 key（格式 + 去重）。
 * @returns {{ok:true, keys:string[]} | {ok:false, error:string}}
 */
export function normalizeClaimKeys(keys) {
    if (keys == null) return { ok: true, keys: [] };
    if (!Array.isArray(keys)) return { ok: false, error: 'claims 必须是数组' };
    const out = [];
    for (const k of keys) {
        const p = parseClaimKey(k);
        if (!p.ok) return { ok: false, error: p.error };
        if (!out.includes(p.raw)) out.push(p.raw);
    }
    return { ok: true, keys: out };
}

/**
 * 从一张任务单里**推导**它默认要预约什么（06 §9.2 的落地）。
 *
 * 流程也可以显式给 `job.claims`；这里只覆盖"从 args 能一眼看出来"的常见情形，
 * 免得每个流程都手写。**推导不出来的就不预约**（不猜）。
 *
 * @param {object} job
 * @returns {string[]}
 */
export function deriveClaims(job) {
    if (Array.isArray(job?.claims) && job.claims.length) return job.claims;
    const args = job?.args ?? {};
    const out = [];
    // 明确的坐标目标 → 预约那个方块（采集/挖掘/放置）
    const t = args.target ?? args.pos ?? null;
    if (t && Number.isFinite(t.x) && Number.isFinite(t.y) && Number.isFinite(t.z)) {
        if (['collect', 'mine', 'dig'].includes(String(job?.skill ?? ''))) {
            out.push(`block:${Math.floor(t.x)},${Math.floor(t.y)},${Math.floor(t.z)}`);
        }
    }
    // 存取 → 预约容器
    if (['store', 'fetch'].includes(String(job?.skill ?? '')) && t && Number.isFinite(t.x)) {
        out.push(`container:${Math.floor(t.x)},${Math.floor(t.y)},${Math.floor(t.z)}`);
    }
    return out;
}

// ───────────────────────────────────────────────────────────────────────────
// 领单协议的两个共用纯函数（2026-11-06 深度检查 BOARD-002 / BOARD-003）
//
// ★ 为什么放在这个文件：`board_client.js`（agent 侧）与 `board_server.js`
//   （mindserver 侧）**都要用同样的规则**，而这里已经是"纯函数、不碰数据库"的
//   共用模块 —— 让 agent 侧 import 它不会把 `node:sqlite` 拖进子进程。
//   两边各写一份的实现迟早漂移（全仓反复出现的"两处都以为自己在管同一件事"）。
// ───────────────────────────────────────────────────────────────────────────

/**
 * 领单请求里最多上报多少个物品名（BOARD-002）。
 *
 * ★ 为什么要上限：`board:claim` 是 agent → mindserver 的**每条轮询**都会发的包，
 *   背包（尤其开了大箱子/创造模式）可能有几百个格子。我们只需要名字、且只需要
 *   "有没有某几样东西"，没有理由让无界的数组反复过网络。256 远大于任何
 *   `requires.items` 的规模，正常玩家背包也够用。
 */
export const MAX_REPORTED_ITEMS = 256;

/**
 * 归一化"我身上有什么"（BOARD-002）。
 *
 * 只保留**物品名**：`requires.items` 判的是"有没有"，不判数量 —— 这也是报告要求的
 * "取最小必要字段"（不把整个背包（含 count/durability/nbt）塞进每次领单请求）。
 *
 * 兼容：非数组 / 含非字符串 / 空串 → 安静丢弃（老客户端不带这个字段时不崩）。
 *
 * @param {any} raw agent 上报的物品名数组（也接受 `{name}` 对象数组）
 * @returns {string[]} 去重后的物品名（保持上报顺序，便于断言）
 */
export function normalizeReportedItems(raw) {
    if (!Array.isArray(raw)) return [];
    const out = [];
    const seen = new Set();
    for (const it of raw) {
        const name = typeof it === 'string' ? it : (it && typeof it.name === 'string' ? it.name : null);
        if (!name || name === '' || seen.has(name)) continue;
        seen.add(name);
        out.push(name);
        if (out.length >= MAX_REPORTED_ITEMS) break;
    }
    return out;
}

/**
 * 这张单现在是"第几次尝试"（BOARD-003）。
 *
 * ★ 唯一真相：`checkpoint.attemptSeq` —— `claimFor` 领单时 +1 写进去的那一个数。
 *   （2026-11-06 收敛：不要为它另建一列，否则同一件事有两个写入路径。）
 *
 * 没有这个字段（老行 / 还没被领过的单）→ `null`，表示"不知道是哪次尝试"，
 * 调用方**不要**据此拒绝任何人（拒绝只该发生在"明确不匹配"时）。
 *
 * @param {object} job
 * @returns {number|null}
 */
export function attemptSeqOfJob(job) {
    const m = Number(job?.checkpoint?.attemptSeq);
    return Number.isFinite(m) ? m : null;
}
