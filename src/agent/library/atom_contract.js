/**
 * 动作原子统一返回契约。
 * 规则见 陪玩改造方案.md §3.2 与 原子动作规格.md §0.1–0.7。
 *
 * 约定：只有执行器读 .ok；其它地方一律不判断返回值。
 */

export const CODES = [
    'OK',
    'NO_TARGET',
    'NO_PATH',
    'OUT_OF_REACH',
    'NO_TOOL',
    'UNSAFE',       // 落点不安全（下方悬空/只有水面），不该走过去
    'HEIGHT_MISS',  // 垂直没到位（该降到 y 却停在原地）
    'NOT_CLIMBABLE',// 不在藤蔓/梯子上，爬不了
    // 掘进（atom_tunnel）的错误码
    'OUT_OF_ZONE',  // 目标格出了安全范围
    'TOO_MUCH',     // 一步要挖的格数超过上限
    'NO_FLOOR',     // 挖完脚下没地板，会掉下去
    'LIQUID_RISK',  // 周围有液体，挖了会灌进来
    'NO_DATA',      // 目标格未加载，读不到方块
    'DIG_FAIL',     // 挖方块失败
    'NO_MOVE',      // 挖通了但走不过去
    // 规划层（path_3d）的错误码 —— 之前没注册，靠"直接返回对象字面量"逃过去
    'NO_START',     // 起点周围找不到可站立面（数据缺失或她悬空）
    // 载具（atom_boat）的错误码
    'NO_VEHICLE',   // 附近没有可骑的船/矿车
    'RIDE_FAILED',  // 发了 /ride 但服务器没让她上船
    'NO_PERMISSION',// /ride 被拒（需要 op）
    'NOT_MOUNTED',  // 不在载具上
    'DRIVE_FAILED', // 在载具上但动不了（搁浅/陆地）
    'WINDOW_CLOSED',// 容器/窗口已关闭
    'NO_ITEM',
    'OCCUPIED',
    'NO_SUPPORT',
    'BLOCKED',
    'TIMEOUT',
    'INTERRUPTED',
    'INTERNAL',
    // ── 2026-10-26 新增（两处都是"必须区分"才加，不是为了好看）──
    // STUCK：走了但**原地不动**（连续 STALL_MS 秒没靠近）。
    //   与 NO_PATH 的区别：NO_PATH 是"算不出路"（该放弃/换目标），
    //   STUCK 是"路有但走不动"（该重试、换路、或搭方块）。
    //   降级策略完全不同，混成一个码上层就没法决定。
    'STUCK',
    // NO_REACH：坐标查到了、也走过去了，但停在还差一段的地方。
    //   与 NO_TARGET 的区别：NO_TARGET 是"不知道你在哪"，
    //   NO_REACH 是"知道你在哪、但这段路走不过去"。
    //   混用会让她反复问"你在哪"，而坐标一直是查得到的（实测踩过）。
    'NO_REACH',
];

export function ok(data = {}) {
    return Object.freeze({ ok: true, code: 'OK', message: '', data });
}

export function fail(code, message, data = {}) {
    if (!CODES.includes(code) || code === 'OK') {
        throw new Error(`fail(): 非法 code "${code}"`);
    }
    if (!message) {
        throw new Error('fail(): message 不能为空');
    }
    return Object.freeze({ ok: false, code, message, data });
}

export function isResult(r) {
    return !!r && typeof r === 'object'
        && typeof r.ok === 'boolean'
        && typeof r.code === 'string';
}

export function assertResult(r) {
    if (!isResult(r)) throw new Error('不是 ActionResult');
    if (!CODES.includes(r.code)) throw new Error(`未知 code ${r.code}`);
    if (!r.ok && !r.message) throw new Error('失败但没有 message');
    return r;
}

/** 旧调用方的唯一转换点。非 ActionResult 一律只认严格 true。 */
export function asBool(r) {
    if (isResult(r)) return r.ok;
    return r === true;
}

/**
 * 目标描述的归一化（见 原子接口标准.md §2）。
 *
 * 两种写法都接受：
 *   新：{ kind: 'point'|'block', pos: {x,y,z} } / { kind: 'point', posXZ: {x,z} }
 *       { kind: 'entity', entity } / { kind: 'player', name } / { kind: 'self' }
 *   旧：直接 { x, y, z } 或 { x, z }（存量 17 处调用方还在用）
 *
 * 为什么保留旧写法：字段标准里我们决定"不留旧名"，因为那只影响**读**（错了会静默）；
 * 而坐标传参影响**写**，改错会立刻报错，但 17 处一次全改无法定位。
 * 分两步：先让两种写法并存，调用方逐个迁完再删旧分支。
 *
 * @returns {{kind:string, pos?:object, posXZ?:object, entity?:object, name?:string}|null}
 */
/**
 * 目标描述的归一化与校验（见 原子接口标准.md §2）。
 *
 * 只接受描述对象：
 *   { kind: 'point'|'block', pos: {x,y,z} }       三维位置
 *   { kind: 'point', posXZ: {x,z} }                只给水平位置（自己找落脚高度）
 *   { kind: 'entity', entity } / { kind: 'player', name } / { kind: 'self' }
 *
 * 历史：B 步（2026-10-24）之前还兼容裸坐标 `{x,y,z}` / `{x,z}`，因为存量 17 处调用方
 * 需要分批迁。现在 14 处真实调用已全部迁完（另 3 处是注释），兼容分支已删——
 * 继续留着会让"两种写法"变成永久的技术债，而且新写的人不知道哪种是对的。
 *
 * @returns {{kind:string, pos?:object, posXZ?:object, entity?:object, name?:string}|null}
 */
export function normalizeTarget(t) {
    if (!t || typeof t !== 'object') return null;
    if (typeof t.kind !== 'string') return null;   // 裸坐标已不再支持

    if (t.kind === 'point' || t.kind === 'block') {
        const pos = t.pos ? floor3(t.pos) : null;
        const posXZ = t.posXZ ? floorXZ(t.posXZ) : null;
        if (!pos && !posXZ) return null;
        return { kind: t.kind, pos: pos ?? null, posXZ: posXZ ?? null, name: t.name ?? null };
    }
    if (t.kind === 'entity') return t.entity ? { kind: 'entity', entity: t.entity } : null;
    if (t.kind === 'player') return t.name ? { kind: 'player', name: String(t.name) } : null;
    if (t.kind === 'self') return { kind: 'self' };
    return null;
}

function floor3(p) {
    return { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) };
}

function floorXZ(p) {
    return { x: Math.floor(p.x), z: Math.floor(p.z) };
}

/**
 * 输出截断：给模型的输出最多 80 行 / 6000 字符。
 * 起因：一次采集把 229,629 字符的 "FAILED" 回灌给模型，模型据此判断"全程失败"。
 */
export function truncate(text, { maxLines = 80, maxChars = 6000, head = 25, tail = 25 } = {}) {
    if (typeof text !== 'string' || !text) return text ?? '';
    const lines = text.split('\n');
    const tooManyLines = lines.length > maxLines;
    const tooManyChars = text.length > maxChars;
    if (!tooManyLines && !tooManyChars) return text;

    if (tooManyLines) {
        const omitted = Math.max(0, lines.length - head - tail);
        return [
            ...lines.slice(0, head),
            `……（共 ${lines.length} 行，省略 ${omitted} 行）`,
            ...lines.slice(-tail),
        ].join('\n');
    }
    return text.slice(0, maxChars) + `\n……（输出共 ${text.length} 字符，已截断）`;
}

/**
 * 命令层格式化：ActionResult 压成一行；旧返回值退回日志摘要。
 * 这里是唯一一处把 ActionResult 变成人话的地方。
 */
export function formatActionResult(label, codeReturn, result) {
    if (isResult(result)) {
        const head = result.ok
            ? `${label}: OK`
            : `${label}: ${result.code}${result.message ? ' — ' + result.message : ''}`;
        const keys = result.data ? Object.keys(result.data) : [];
        const data = keys.length ? ' ' + JSON.stringify(result.data) : '';
        return truncate(head + data);
    }
    return truncate(codeReturn?.message ?? '');
}
