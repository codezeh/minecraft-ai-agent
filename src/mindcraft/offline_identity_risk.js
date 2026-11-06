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

/** 从 server.properties 文本里取一个键（不存在返回 null）。导出来便于单测。 */
export function readProperty(text, key) {
    const re = new RegExp(`^\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=(.*)$`, 'm');
    const m = re.exec(String(text ?? ''));
    return m ? m[1].trim() : null;
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
