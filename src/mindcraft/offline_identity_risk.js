/**
 * OPS-003（2026-11-06 深度检查）[P1] —— 离线局域网服的名字白名单可被冒用为主人。
 *
 * 缺陷本质（这条不是"代码写错了一行"，是**身份模型**缺一层）：
 *   `online-mode=false` 时服务端不做 Mojang 验证，只认客户端自报的名字；
 *   而 bot 的权限等级又是**按名字**算的（`resolveLevel` 的 `name === owner`）。
 *   于是「白名单 + 绑所有网卡」的组合只是**挡住了名单外的人**，
 *   挡不住有人把游戏名改成名单上那个名字 —— 那人进服即可拿到 bot 的 OWNER 级权限
 *   （含 `!newAction`，即沙箱内代码执行 = 本机 root）。
 *
 * 为什么这里只做"识别 + 告警"而不是自动改联机模式：
 *   报告的处置是**三选一，且必须用户拍板**（已记在 config/network.json 的 `_剩余风险`、
 *   docs/audit/night/queue/inbox/F-SEC-204.md）：
 *     A 收回监听（bind=localhost）—— 牺牲局域网/手机；
 *     B 加登录插件（离线模式 + 密码）—— 要装插件、改进服流程；
 *     C 维持现状并书面接受风险。
 *   三条都会改变用户的日常使用方式，悄悄替他选一条是不负责的；但**让风险不可忽视**是
 *   纯收益、零副作用 —— 这正是本模块干的事：把"你现在处在可被冒名提权的配置里"
 *   变成启动时的一条明确告警，而不是留在审计文档里。
 *
 * 这就是报告要求的「隔离认证前指令」里，能由代码单方面保证的那一半：
 *   **不在没有身份校验的前提下，把名字匹配当成可信身份，且让这件事每次启动都可见。**
 */

/**
 * 评估当前配置的风险。
 *
 * @param {object} p
 * @param {boolean} p.onlineMode      server.properties 的 online-mode
 * @param {string}  p.serverIp        server.properties 的 server-ip（'' / '0.0.0.0' = 监听所有网卡）
 * @param {boolean} [p.whiteList]     white-list 是否开启
 * @param {string[]} [p.ownerNames]   被按名字授予 OWNER 的名单（越具体，告警越能点名）
 * @returns {{atRisk:boolean, reachable:boolean, findings:string[], advice:string[]}}
 */
export function assessOfflineIdentityRisk({ onlineMode, serverIp, whiteList = false, ownerNames = [] } = {}) {
    const findings = [];
    const advice = [];
    const ip = String(serverIp ?? '').trim();
    // 空 / 0.0.0.0 / :: 都表示"所有网卡"
    const reachable = ip === '' || ip === '0.0.0.0' || ip === '::' || ip === '*';
    const offline = onlineMode === false || onlineMode === 'false';

    if (!offline) {
        // 正版校验开着：名字由 Mojang 背书，冒名这条路径不成立。
        return { atRisk: false, reachable, findings: [], advice: [] };
    }
    if (!reachable) {
        // 只绑回环：外部进不来，可以接受（单机模式）。
        return { atRisk: false, reachable, findings: [], advice: [] };
    }

    findings.push('online-mode=false 且服务端监听所有网卡：局域网内任何人都能连进来。');
    if (whiteList) {
        findings.push('white-list 只校验**名字**，挡得住名单外的人，挡不住有人把名字改成名单上那个。');
    } else {
        findings.push('white-list 未开启：连"名单外的人进不来"这一层都没有。');
    }
    if (ownerNames.length > 0) {
        findings.push(`这些名字会被按名字授予 bot 的 OWNER 级权限：${ownerNames.join('、')}。`);
    } else {
        findings.push('bot 的 owner 由 profile 的 permissions.owner 按名字决定；改个名字就能冒充。');
    }
    findings.push('拿到 OWNER 级就能用 !newAction 写并运行代码 —— 等于把本机 root 交出去。');

    advice.push('A 收回监听（不影响单人玩）：把 config/network.json 的 main.bind 改成 "localhost"，再跑 node tools/server-net.mjs apply');
    advice.push('B 加身份校验（保留局域网）：装一个离线模式可用的登录插件（AuthMe 之类），或改用正版校验 online-mode=true');
    advice.push('C 明确接受风险：什么都不改动，但请知道"白名单 ≠ 身份校验"');

    return { atRisk: true, reachable, findings, advice };
}

/**
 * 把评估结果渲染成启动告警（多行字符串）。atRisk 为假时返回 null（不刷屏）。
 * @param {ReturnType<typeof assessOfflineIdentityRisk>} r
 */
export function renderOfflineIdentityWarning(r) {
    if (!r?.atRisk) return null;
    const bar = '='.repeat(72);
    return [
        bar,
        '[安全][OPS-003] 当前配置允许**冒名拿 bot 的主人权限**',
        ...r.findings.map(f => '  · ' + f),
        '  处置三选一（需你拍板，三种都会改变日常用法，所以没有自动替你选）：',
        ...r.advice.map(a => '  ' + a),
        '  详情：config/network.json 的 _剩余风险；docs/audit/night/queue/inbox/F-SEC-204.md',
        bar,
    ].join('\n');
}

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 从 server.properties 文本里取一个键（不存在返回 null）。导出来便于单测。 */
export function readProperty(text, key) {
    const re = new RegExp(`^\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=(.*)$`, 'm');
    const m = re.exec(String(text ?? ''));
    return m ? m[1].trim() : null;
}

/**
 * 主服的 server.properties 路径（**唯一一处**算它）。
 *
 * 从本文件（`src/mindcraft/`）上溯三级 = 仓库根，再进 `server/`。
 * `MC_SERVER_PROPERTIES` 可覆盖（单测用临时文件，避免读真机配置）。
 */
export function serverPropertiesPath() {
    const override = process.env.MC_SERVER_PROPERTIES;
    if (typeof override === 'string' && override.trim()) return override.trim();
    const here = path.dirname(fileURLToPath(import.meta.url));
    return path.join(here, '..', '..', '..', 'server', 'server.properties');
}

/**
 * ★★★ R4 t27：读"这个服是不是正版验证"—— **全系统唯一判据入口**。
 *
 * 为什么必须只有一处：`online-mode` 同时决定两件互相牵连的事 ——
 *   ① 玩家 uuid 可不可信（离线模式下 uuid = MD5('OfflinePlayer:'+名字) ⇒ 同名同 uuid）；
 *   ② 身份绑定该不该持久授 owner。
 * 如果 mindserver 的启动告警、agent 的定级、面板的显示各算一次，迟早三处不一致
 * （项目里"三套 mode 列表 / 两套斜杠白名单"都是这么烂掉的）。
 *
 * @param {{propsPath?: string}} [opts]
 * @returns {{onlineMode: boolean|null, propsPath: string, source: 'file'|'missing'|'no-key'|'error', detail?: string}}
 *   `onlineMode=null` 表示**读不到**（没有文件 / 没有这个键 / 解析失败）——
 *   调用方必须按"未知"处理，**不能当正版**（fail-safe：未知按离线算，反而更严格）。
 */
export function readServerOnlineMode({ propsPath = serverPropertiesPath() } = {}) {
    try {
        if (!existsSync(propsPath)) return { onlineMode: null, propsPath, source: 'missing' };
        const text = readFileSync(propsPath, 'utf8');
        const raw = readProperty(text, 'online-mode');
        if (raw == null) return { onlineMode: null, propsPath, source: 'no-key' };
        return { onlineMode: String(raw).toLowerCase() !== 'false', propsPath, source: 'file' };
    } catch (e) {
        return { onlineMode: null, propsPath, source: 'error', detail: String(e?.message ?? e) };
    }
}

/**
 * ★★★ R4 t27：把「online-mode」与「offline_owner_mode」合成**一个**生效策略（纯函数）。
 *
 * 用户拍板是"允许离线，但保留正版验证开关"，所以两档必须自动对齐、不能互相矛盾：
 *
 *   · `online-mode=true`  ⇒ uuid 由 Mojang 签发、可信 ⇒ **无视 session 窗口，持久授 owner**；
 *     此时 `offline_owner_mode` 不参与判断（它管的是"离线时怎么办"）。
 *   · `online-mode=false` ⇒ 走 `offline_owner_mode`：
 *       `session`（默认，720 分钟）⇒ 只有刚 !claim 过的窗口内授 owner；
 *       `deny`                     ⇒ 一律只聊天。
 *   · 读不到 online-mode ⇒ 按**离线**处理（未知不当作可信），并沿用 offline_owner_mode。
 *
 * @param {object} p
 * @param {boolean|null} p.onlineMode   readServerOnlineMode().onlineMode
 * @param {'deny'|'session'} [p.offlineOwnerMode]
 * @param {number} [p.sessionMinutes]
 * @returns {{effective:'persistent'|'session'|'deny', uuidTrusted:boolean, sessionMinutes:number, reason:string}}
 */
export function resolveIdentityPolicy({ onlineMode = null, offlineOwnerMode = 'session', sessionMinutes = 720 } = {}) {
    const mins = Number.isFinite(Number(sessionMinutes)) && Number(sessionMinutes) > 0 ? Number(sessionMinutes) : 720;
    if (onlineMode === true) {
        return {
            effective: 'persistent', uuidTrusted: true, sessionMinutes: 0,
            reason: 'online-mode=true：uuid 由正版验证签发、可信 ⇒ 绑定持久有效（不受 session 窗口限制）',
        };
    }
    const mode = String(offlineOwnerMode ?? 'session').toLowerCase() === 'deny' ? 'deny' : 'session';
    return {
        effective: mode === 'deny' ? 'deny' : 'session',
        uuidTrusted: false,
        sessionMinutes: mode === 'deny' ? 0 : mins,
        reason: onlineMode === false
            ? `online-mode=false：uuid 由名字派生、不可信 ⇒ ${mode === 'deny' ? '一律只聊天' : `仅 claim 后 ${mins} 分钟内授 owner`}`
            : `读不到 online-mode（按离线处理）：${mode === 'deny' ? '一律只聊天' : `仅 claim 后 ${mins} 分钟内授 owner`}`,
    };
}

/**
 * 便捷入口：给一段 server.properties 文本 + owner 名单，直接给结论。
 * @param {string} propertiesText
 * @param {string[]} [ownerNames]
 */
export function assessFromProperties(propertiesText, ownerNames = []) {
    const onlineMode = String(readProperty(propertiesText, 'online-mode') ?? 'true').toLowerCase() !== 'false';
    const serverIp = readProperty(propertiesText, 'server-ip') ?? '';
    const whiteList = String(readProperty(propertiesText, 'white-list') ?? 'false').toLowerCase() === 'true';
    return assessOfflineIdentityRisk({ onlineMode, serverIp, whiteList, ownerNames });
}
