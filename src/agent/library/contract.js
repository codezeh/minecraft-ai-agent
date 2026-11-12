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
    // 载具的错误码（08 / 02 §3 的 mount·dismount 动作契约）
    //   原实现 atom_boat.js 已于 2026-11-01 删除（零调用方）；输入侧现由
    //   atom_input_misc.mountEntity / dismount 承接，动作层补 mount/dismount 时仍用这套码。
    //
    // ⚠️ 暂未产出（2026-11-03 t41 错误码使用审计）：下面 4 个载具码当前**全仓零产出** ——
    //   boat 已删、动作层 mount/dismount 还没建。**保留不删**（将来一定会用到；
    //   临时造码等于破坏契约），但审计时别再把这 4 个当"该用没用"的信号重复排查。
    //   （同段的 NO_PERMISSION **有**真实产出（权限/斜杠命令路径），不在此列。）
    'NO_VEHICLE',   // 附近没有可骑的船/矿车　（暂未产出）
    'RIDE_FAILED',  // 发了 /ride 但服务器没让她上船　（暂未产出）
    'NO_PERMISSION',// /ride 被拒（需要 op）
    'NOT_MOUNTED',  // 不在载具上　（暂未产出）
    'DRIVE_FAILED', // 在载具上但动不了（搁浅/陆地）　（暂未产出）
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
    // ── 2026-11-02 新增 7 个（02_actions.md §4；M6 的阻塞前置）──
    //
    // 为什么必须先注册：`fail()` 遇到 CODES 之外的码直接抛异常，而 M5 建好的
    // `composite_registry` 会在**模块加载时**校验 manifest 的 `codes` 字段 ——
    // 引用未注册的码 = 进程启动即崩。M5 就当场撞上过（collect 写了 INVENTORY_FULL）。
    //
    // 每一个都必须是"上层处理方式确实不同"才加，不是为了好看：

    // NOT_READY：东西在，时机不对（作物没熟 / 熔炉没烧完 / 白天睡不了）。
    //   与 BLOCKED 的区别：BLOCKED 是"路被挡住"，该绕；NOT_READY 是"等一会再来"，
    //   换目标就错了（别的地里也不熟）。
    'NOT_READY',
    // NO_RECIPE：没有这个配方。
    //   与 NO_ITEM 的区别：缺料可以去采；没配方采了也没用 —— 上层一个该去采集、
    //   一个该直接放弃。
    'NO_RECIPE',
    // NO_WORKSTATION：需要工作台 / 熔炉，附近没有。
    //   与 OUT_OF_REACH 的区别：OUT_OF_REACH 是"走近一点"，NO_WORKSTATION 是
    //   "得先放一个" —— 处理动作完全不同。
    'NO_WORKSTATION',
    // INVENTORY_FULL：背包满了。
    //   与 BLOCKED 的区别：BLOCKED 该绕路，背包满了该先去存箱子；换个目标没用。
    'INVENTORY_FULL',
    // PREEMPTED：被更高优先级任务挤掉。
    //   与 INTERRUPTED 的区别（07 §4）：INTERRUPTED 是玩家喊停 → 任务单
    //   cancelled/paused；PREEMPTED 是调度器抢占 → 任务单回 ready、之后接着做。
    //   注意：PREEMPTED **只由调度器写进任务单结果**，流程不管被谁打断一律返回
    //   INTERRUPTED（分层：流程不认识优先级）。
    'PREEMPTED',
    // CLAIM_CONFLICT：资源被别的 bot 预约了。
    //   与 OCCUPIED 的区别：OCCUPIED 是那格本身有东西（等它走开）；CLAIM_CONFLICT
    //   是"另一个 bot 已认领这块" —— 换一个目标，等是等不来的。
    'CLAIM_CONFLICT',
    // LEASE_LOST：任务单租约过期被收回。
    //   与 TIMEOUT 的区别：TIMEOUT 是"这次动作超时了"，重试可能成；
    //   LEASE_LOST 必须**立刻停且不写结果** —— 别人可能已经接手同一张单，
    //   写结果会把别人的进度覆盖掉。
    'LEASE_LOST',
    // ★★★ T6（架构收敛项 3）：**"没有任务板" / "不是任务单" ≠ 占位成功。**
    //   这两个码专门用来消灭两类 fail-open：
    //     NO_BOARD —— `composite_registry.reserve/release/reserveNow` 无板时原来返回
    //       `ok:true`（"恒成功"）。调用方以为占位成功，其实 `claims` 表一行都没有
    //       （真机事故：85 张单 done、claims 0 行）。现在返回这个码 + 一行 warn。
    //     NO_JOB   —— 执行期补占位需要一个**任务单 id** 作为预约归属
    //       （`claims.id`）；直接从命令调用（jobId=null）时没有归属，不能假装占上了。
    //   与 CLAIM_CONFLICT 的区别（三者处置完全不同）：
    //     CLAIM_CONFLICT = 有人真的占着 → **换目标**；
    //     NO_BOARD       = 没有协调设施  → 单机照常干 / 多机必须接线（是配置问题）；
    //     NO_JOB         = 这次不是任务单 → 不需要协调（正常路径，不是错误）。
    'NO_BOARD',
    'NO_JOB',
    // ★ A5-8（t5）：**"这一拍不续租"**（客户端主动停手，不是流程失败）。
    //   出现在 `board_client.heartbeat()`：客户端已 stop / 这张单已被暂停或取消。
    //   与 LEASE_LOST 的区别：LEASE_LOST 是"租约被别人拿走了"（要停手并让位）；
    //   HEARTBEAT_SKIPPED 是"我自己不续了"（正常停止路径，别人可以接手）。
    'HEARTBEAT_SKIPPED',
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

// R6 #77：逐分量 Number.isFinite，任一非法返回 null（原来 Math.floor('a') → NaN 还被判合法，
// 下游 path_3d 把这当成"目标合法但寻路失败"，报 NO_START/NO_PATH，把传参错误伪装成寻路问题）。
function floor3(p) {
    if (!p || typeof p !== 'object') return null;
    const x = Number(p.x), y = Number(p.y), z = Number(p.z);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
    return { x: Math.floor(x), y: Math.floor(y), z: Math.floor(z) };
}

function floorXZ(p) {
    if (!p || typeof p !== 'object') return null;
    const x = Number(p.x), z = Number(p.z);
    if (!Number.isFinite(x) || !Number.isFinite(z)) return null;
    return { x: Math.floor(x), z: Math.floor(z) };
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
        const lineTrimmed = [
            ...lines.slice(0, head),
            `……（共 ${lines.length} 行，省略 ${omitted} 行）`,
            ...lines.slice(-tail),
        ].join('\n');
        // R6 #76：行裁剪后可能仍然超字符（100 行 × 每行 5000 字符 → 50 行 × 5000 = 25 万字符，
        // 正好是它要防的场景的变体）。原来这里直接 return，字符裁剪被完全短路。
        if (lineTrimmed.length > maxChars) {
            // 提示语把"行数"和"字符数"都保住：只做字符裁剪会把"省略 N 行"一起切掉，模型就不知道被省了多少。
            const note = `\n……（共 ${lines.length} 行 / ${text.length} 字符，省略 ${omitted} 行，按 ${maxChars} 字符截断）`;
            const cut = Math.max(0, maxChars - note.length);
            return lineTrimmed.slice(0, cut) + note;
        }
        return lineTrimmed;
    }
    return text.slice(0, Math.max(0, maxChars - 40)) + `\n……（输出共 ${text.length} 字符，已截断）`;
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
