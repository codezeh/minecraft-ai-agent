/**
 * 错误码 → 一句**可执行的建议**（M9，08 §4）。
 *
 * 为什么单独一个文件：模型看到 `NO_TOOL` 这种码，不知道该干什么；看到
 * "建议：先弄石镐 !do(\"obtain\", \"item=stone_pickaxe\")" 才知道下一步。
 * 放在 `contract.js` 旁边而不是塞进去：contract 是**契约**（改它要慎重），
 * 这里是**给人/模型看的文案**（会频繁改），两者的变更理由完全不同。
 *
 * ★ 硬要求（08 §4 + 用户 2026-11-03）：**CODES 里的每个码都必须有 hint**。
 *   缺了不是"少一句话"，是模型收到一个它不知道怎么办的码。
 *   所以有一条单测遍历 CODES 断言全覆盖；`hintFor()` 对未知码也有兜底（不会 undefined）。
 */

/** 具体建议（08 §4 表里点名要有的码都在这里，且都写成可直接执行的动作）。 */
const HINTS = {
    // ── 08 §4 表里明确要求的 8 个 ──────────────────────────────────
    NO_TOOL: '先弄到对应工具再试（例：!do "obtain" "item=stone_pickaxe"）',
    NO_ITEM: '缺材料，先补齐（缺什么见 missing）',
    NO_TARGET: '附近没有目标：换个地方，或者问玩家想让我做什么',
    NO_PATH: '过不去：换个目标；连着两次还是不行就问玩家',
    STUCK: '卡住了：换个目标；连着两次还是不行就问玩家',
    INVENTORY_FULL: '背包满了：先 !do "store" 把东西存起来',
    TIMEOUT: '没做完就超时了：报一下做到哪、问玩家要不要继续',
    CLAIM_CONFLICT: '别的 bot 正在做这块，不用管，换个目标',

    // ── 其余码（逐条给可执行建议，不留"未定义"）────────────────────
    OK: '成功，继续下一步',
    OUT_OF_REACH: '够不着：先走近一点再试',
    UNSAFE: '不安全（会掉下去/有危险）：换个落点',
    HEIGHT_MISS: '高度对不上：先调好站位或垫一下',
    NOT_CLIMBABLE: '这个爬不上去：换条路',
    OUT_OF_ZONE: '超出允许活动范围：先回来',
    TOO_MUCH: '数量超了：少拿/少做一点',
    NO_FLOOR: '脚下没地板：先垫一块再动',
    LIQUID_RISK: '下面是水/岩浆：别挖穿，换个方向',
    NO_DATA: '目标那片没加载、读不到方块：先走近让它加载',
    DIG_FAIL: '挖了但没生效（保护区/工具不对/服务端拒绝）：换目标或换工具',
    NO_MOVE: '动不了：先挪一下或换个方向',
    NO_START: '启动不了：检查前置条件',
    NO_VEHICLE: '附近没有可用的载具',
    RIDE_FAILED: '上不去：靠近一点再试',
    NO_PERMISSION: '没权限做这事：要主人才能做',
    NOT_MOUNTED: '还没坐上去：先骑上去',
    DRIVE_FAILED: '开着走不了：停下来重试',
    WINDOW_CLOSED: '容器窗口关了：重新打开再试',
    OCCUPIED: '有人占着（别人的熔炉/箱子/位置）：换一个',
    NO_SUPPORT: '要放的位置下面没支撑：先放下面那块',
    BLOCKED: '现在做不了（被挡住/状态没变）：换个办法',
    INTERRUPTED: '被打断了：这是正常的，没失败，可以接着做',
    INTERNAL: '内部错误：把 message 报给玩家',
    NO_REACH: '走不到：换条路或换目标',
    NOT_READY: '时机不对（比如作物还没熟、还没烧完）：等一会再试',
    NO_RECIPE: '没有这个配方：确认物品名，或先查 !craftable',
    NO_WORKSTATION: '缺工作站（工作台/熔炉）：先做一个或放一个',
    PREEMPTED: '被更高优先级的单抢了：正常，做完那件会回来继续',
    LEASE_LOST: '这个单已经被别人接手了：立刻停手，不要继续动',
};

/** 通用兜底（理论上不会用到，因为下面有用例断言全覆盖；但保证不会返回 undefined）。 */
const FALLBACK = '出错了：把 code 和 message 原样报给玩家';

/**
 * 取某个 code 的建议。
 * @param {string} code
 * @returns {string} 一定非空
 */
export function hintFor(code) {
    const c = String(code ?? '');
    return HINTS[c] ?? FALLBACK;
}

/** 有没有为这个码写过具体建议（不含兜底）。单测用它断言全覆盖。 */
export function hasHintFor(code) {
    return Object.prototype.hasOwnProperty.call(HINTS, String(code ?? ''));
}

/** 全部已写建议的码（诊断用）。 */
export function hintedCodes() {
    return Object.keys(HINTS);
}

/**
 * 把一次动作结果格式化成**一行 ≤200 字**的回执（08 §4）。
 *
 * 例：`[单 #12 collect oak_log] 失败 NO_TOOL：采到 3/16。建议：先弄到对应工具…`
 *
 * @param {object} args
 *   result    ActionResult
 *   job      任务单（可空；有就带 #id 和 skill）
 *   label    没单时的标签（如 '!collectBlocks'）
 * @returns {string}
 */
export function formatOutcome({ result = null, job = null, label = '' } = {}) {
    const code = String(result?.code ?? 'OK');
    const okFlag = result?.ok === true;

    // 头部：[单 #12 collect oak_log] / [!collectBlocks]
    let head = '';
    if (job?.id) {
        const shortId = String(job.id).split('_').pop();
        head = `[单 #${shortId}${job.skill ? ' ' + job.skill : ''}] `;
    } else if (label) {
        head = `[${label}] `;
    }

    // 进度：只在真的报了 count/want 时才写（不编造）
    const d = result?.data ?? null;
    const hasProg = d && Number.isFinite(d.count) && Number.isFinite(d.want);
    const prog = hasProg ? `采到 ${d.count}/${d.want}。` : '';

    if (okFlag) {
        const body = hasProg ? prog.replace(/。$/, '') : (result?.message || '完成');
        return clip(`${head}成功：${body}`);
    }

    // 失败：码 + message + 进度 + 建议
    //
    // ★ 顺序/预算有讲究（单测抓到的）：**建议是最有价值的部分，绝不能被截掉**。
    //   第一版直接拼完再 clip，结果 message 一长（>300 字）就把"建议：…"整段吃掉，
    //   模型又变回"看到一个不知道怎么办的码"。所以这里先给 head+code+进度+建议
    //   留足预算，**message 用剩余空间**。
    const advice = `建议：${hintFor(code)}`;
    const fixed = `${head}失败 ${code}。${prog}${advice}`;
    const budget = 200 - fixed.length - 1;              // 留 1 个分隔符
    let msg = String(result?.message ?? '').trim();
    if (budget <= 4) return clip(fixed);                // 预算不够就不放 message
    if (msg.length > budget) msg = msg.slice(0, Math.max(0, budget - 1)) + '…';
    const mid = msg ? `：${msg}` : '';
    return clip(`${head}失败 ${code}${mid}。${prog}${advice}`);
}

/** 截到 200 字（08 §4 要求一行不超过 200 字）。 */
function clip(s) {
    const str = String(s ?? '');
    return str.length <= 200 ? str : str.slice(0, 197) + '…';
}
