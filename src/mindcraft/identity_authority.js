/**
 * 身份权威判定（ADR 阶段 2 / 决策 A）：**people 是权威，identity.json 只是本 bot 的绑定缓存**。
 *
 * 为什么要有唯一入口：原来"谁是谁"有两处（`people.json` 与每 bot 的 `identity.json`），
 * 判定散在命令与权限里 ⇒ 撤销一个人之后，旧缓存里的 owner 仍然生效。
 * 这里把"以 people 校真 + 失败一律 fail-closed + 原因进日志"收成一处。
 * 长解释见 `docs/audit-r6/fixes4/identity.md`。
 */
import { identityFileOf, readStore, resolveBinding } from './identity_store.js';
import { peopleFileOf, readPeopleStore, personForAvatar, PERSON_STATE } from './people_store.js';

/** 已经打过的告警（按 agent+reason 去重：这条在每次发言的路径上，不能刷屏）。 */
const WARNED = new Set();

/** 单测用：清空告警去重表。 */
export function resetAuthorityWarnings() {
    WARNED.clear();
}

function note(agentName, reason, extra = '') {
    const key = `${agentName}:${reason}`;
    if (WARNED.has(key)) return;
    WARNED.add(key);
    console.warn(`[identity-authority] ${agentName} 的身份**不生效**（fail-closed）：${reason}`
        + (extra ? `（${extra}）` : ''));
}

/** 失败原因的人话（面板/命令话术共用一处，别各写一套）。 */
export function explainAuthorityReason(reason) {
    switch (String(reason ?? '')) {
        case 'unbound': return '这只分身还没绑定玩家';
        case 'expired': return '绑定已过期';
        case 'no-people': return '身份注册表（people）还没建立，按 fail-closed 不授权';
        case 'people-corrupt': return '身份注册表（people）损坏，已按空表 fail-closed 处理';
        case 'no-person': return '这只分身没有挂在任何人名下（people 里查不到）';
        case 'person-revoked': return '这个人已被撤销（state=revoked）';
        case 'person-mismatch': return '缓存里的绑定与 people 里的不是同一个人（缓存已过期）';
        default: return reason ? `未知原因：${reason}` : '未知原因';
    }
}

/**
 * 判定 `agentName` 这只分身上的 `uuid/name` 能不能按 identity.json 里的等级生效。
 *
 * 读 identity.json 快（每 bot 一份），但**以 people 校真**：人不在表里、人被撤、
 * 或缓存与权威对不上 ⇒ `level:null`（fail-closed），并把原因写进日志与返回值。
 *
 * @param {string} agentName bot 名（= people 里的 avatar 名）
 * @param {{uuid?:string|null, name?:string|null, now?:number}} [who]
 * @param {{identityFile?:string, peopleFile?:string}} [opts] 单测可指向临时文件
 * @returns {{level:string|null, binding:object|null, weak:boolean, reason:string,
 *   person:{id:string,name:string,state:string}|null, peopleState:string}}
 */
export function resolveIdentityAuthority(agentName, { uuid = null, name = null, now = Date.now() } = {}, opts = {}) {
    const agent = String(agentName ?? '').trim();
    if (!agent) {
        return { level: null, binding: null, weak: false, reason: 'no-agent', person: null, peopleState: 'unknown' };
    }
    const idRead = readStore(opts.identityFile ?? identityFileOf(agent));
    const hit = resolveBinding(idRead.store, { uuid, name, now });

    const peopleRead = readPeopleStore(opts.peopleFile ?? peopleFileOf());
    const peopleState = peopleRead.ok
        ? 'ok'
        : (peopleRead.corrupt ? 'corrupt' : (peopleRead.reason === 'missing' ? 'missing' : 'unreadable'));
    const owned = personForAvatar(peopleRead.store, agent);
    const person = owned?.person ?? null;
    const personInfo = person ? { id: person.id, name: person.name, state: person.state } : null;

    // ① 缓存里就没有可用绑定（未绑 / 过期）：不管 people 怎么写都不授级
    if (!hit.level) {
        return {
            level: null, binding: hit.binding, weak: hit.weak === true,
            reason: hit.reason === 'expired' ? 'expired' : 'unbound',
            person: personInfo, peopleState,
        };
    }
    // ② 权威读不到（缺失/损坏）：fail-closed —— 没有权威就不授权
    if (peopleState !== 'ok') {
        const reason = peopleState === 'corrupt' ? 'people-corrupt' : 'no-people';
        note(agent, reason, `people.json: ${peopleRead.reason ?? peopleState}`);
        return { level: null, binding: hit.binding, weak: hit.weak === true, reason, person: null, peopleState };
    }
    // ③ 这只 bot 没挂到任何人名下 ⇒ 缓存里的 owner 不生效
    if (!personInfo) {
        note(agent, 'no-person', 'people 里没有这只分身的 active avatar');
        return {
            level: null, binding: hit.binding, weak: hit.weak === true,
            reason: 'no-person', person: null, peopleState,
        };
    }
    // ④ 人被撤了 ⇒ 立刻失效（这是决策 A 的核心：撤销必须穿透缓存）
    if (personInfo.state === PERSON_STATE.REVOKED) {
        note(agent, 'person-revoked', `person=${personInfo.name}`);
        return {
            level: null, binding: hit.binding, weak: hit.weak === true,
            reason: 'person-revoked', person: personInfo, peopleState,
        };
    }
    // ⑤ 缓存绑定的玩家与权威里的人对不上 ⇒ 缓存过期，不生效
    const boundName = String(hit.binding?.name ?? '').trim().toLowerCase();
    if (boundName) {
        const names = [person.name, ...(person.aliases ?? [])]
            .map((n) => String(n ?? '').trim().toLowerCase());
        if (!names.includes(boundName)) {
            note(agent, 'person-mismatch', `缓存=${hit.binding?.name} / 人=${person.name}`);
            return {
                level: null, binding: hit.binding, weak: hit.weak === true,
                reason: 'person-mismatch', person: personInfo, peopleState,
            };
        }
    }
    return {
        level: hit.level, binding: hit.binding, weak: hit.weak === true,
        reason: 'ok', person: personInfo, peopleState,
    };
}
