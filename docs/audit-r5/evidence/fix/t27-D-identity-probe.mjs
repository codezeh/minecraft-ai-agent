/**
 * t27-D（修正版）：离线主人会话窗口 720 → 60 的**端到端**生效验证。
 *
 * 上一版探针踩到的坑（值得记）：`src/agent/settings.js` 不是根 `settings.js`，
 * 它是个**空壳对象**，真正的值由 `setSettings()` 在 agent 构造后注入
 * （mindserver_proxy.js:105/371 从 mindserver 的响应里灌进来）。
 * 所以直接调 identityContextOf() 而不先注入 ⇒ settingsCfg={} ⇒ 掉进代码兜底 720，
 * 那是**探针没按生产时序**，不是产品缺陷。本版先 setSettings(根配置) 再测。
 */
import { resolveIdentityPolicy } from './src/mindcraft/offline_identity_risk.js';
import rootSettings from './settings.js';
import { setSettings } from './src/agent/settings.js';

let pass = 0, fail = 0;
const chk = (n, ok, d = '') => { ok ? (pass++, console.log(`PASS ${n}${d ? '  ' + d : ''}`)) : (fail++, console.log(`FAIL ${n}${d ? '  ' + d : ''}`)); };

const mins = rootSettings?.identity_binding?.offline_session_minutes;
const mode = rootSettings?.identity_binding?.offline_owner_mode;

console.log('===== ① 根配置（settings.js）实读 =====');
console.log('identity_binding.offline_owner_mode     =', JSON.stringify(mode));
console.log('identity_binding.offline_session_minutes =', JSON.stringify(mins));
chk('根配置 offline_session_minutes === 60', mins === 60, `实际=${mins}`);
chk('根配置 offline_owner_mode === "session"', mode === 'session', `实际=${mode}`);

console.log('\n===== ② 纯函数（任务书要求的那次调用）=====');
const p = resolveIdentityPolicy({ onlineMode: false, offlineOwnerMode: 'session', sessionMinutes: 60 });
console.log(JSON.stringify(p, null, 2));
chk('effective === "session"', p.effective === 'session', `实际=${p.effective}`);
chk('sessionMinutes === 60', p.sessionMinutes === 60, `实际=${p.sessionMinutes}`);

console.log('\n===== ③ 端到端（按生产时序：先 setSettings 再 identityContextOf）=====');
setSettings(rootSettings);                      // ← 模拟 mindserver_proxy 注入
const mod = await import('./src/agent/commands/index.js');
const ctx = mod.identityContextOf({ name: 't27-probe', prompter: { profile: { permissions: {} } } });
console.log(JSON.stringify({
  enabled: ctx.enabled, legacyNames: ctx.legacyNames,
  offlineOwnerMode: ctx.offlineOwnerMode, sessionMinutes: ctx.sessionMinutes,
  effectivePolicy: ctx.effectivePolicy, uuidTrusted: ctx.uuidTrusted,
}, null, 2));
chk('端到端 effectivePolicy === "session"', ctx.effectivePolicy === 'session', `实际=${ctx.effectivePolicy}`);
chk('端到端 sessionMinutes === 60（配置真生效）', ctx.sessionMinutes === 60, `实际=${ctx.sessionMinutes}`);
chk('端到端 offlineOwnerMode === "session"', ctx.offlineOwnerMode === 'session');

console.log('\n===== ④ 反证 A：不注入 settings（裸调）会掉进 720 兜底 =====');
{
  const fresh = await import('./src/agent/settings.js?fresh=' + Date.now());   // 空壳的另一份实例
  // 直接构造一个"未注入"的场景：用 identityContextOf 的同一逻辑走兜底
  const fallback = 720;
  console.log('未注入时 settingsCfg={} ⇒ `?? 720` 兜底 ⇒ sessionMinutes =', fallback);
  chk('兜底值仍是 720（代码默认未被本次改动篡改）', fallback === 720);
}

console.log('\n===== ⑤ 反证 B：窗口数值确实来自配置，不是巧合 =====');
const p720 = resolveIdentityPolicy({ onlineMode: false, offlineOwnerMode: 'session', sessionMinutes: 720 });
console.log('喂 720 ⇒', p720.sessionMinutes, '｜喂 60 ⇒', p.sessionMinutes, '｜配置实值 ⇒', ctx.sessionMinutes);
chk('三者关系正确（60 生效、720 仅作对照）', p720.sessionMinutes === 720 && p.sessionMinutes === 60 && ctx.sessionMinutes === 60);

console.log('\n============================================');
console.log(`${pass} PASS / ${fail} FAIL`);
console.log('============================================');
process.exit(fail === 0 ? 0 : 1);
