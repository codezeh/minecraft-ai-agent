/**
 * t-r5-3 —— 「面板限流硬上界不成立」
 *
 * 缺陷形态（老实现）：`if (RATE_BUCKETS.size > 512) { 删 ts 超过 60s 的 }` ——
 *   这是**清理触发条件**，不是上限：513 个**新鲜** key 时一条都删不掉，
 *   之后每条消息都要把整张表扫一遍，表本身还能无限长。
 *
 * 判定方式（不靠读码，靠跑）：用 600 个**互不相同**的远端地址各取一次令牌
 *   （即 600 个新鲜 key，ts 全是 now），然后读 RATE_BUCKETS.size：
 *     · size 超过 512 → 上界不成立，缺陷复现，退出码 0；
 *     · size 停在 512 以内 → 上界成立，退出码 1。
 *
 * 内部符号 `takeToken` / `RATE_BUCKETS` 用 r5-hooks.mjs 在加载期导出（被测逻辑未改一行）。
 *
 * 用法：
 *   node docs/audit-r5/evidence/runtime/probes/t-r5-3.mjs
 *   R5_SRC=<pre-fix>/src node .../t-r5-3.mjs
 * 退出码：0=缺陷复现，1=未复现，2=CANNOT-RUN。
 */
import path from 'node:path';
import { register } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(process.env.R5_SRC || path.resolve(HERE, '../../../../../mindcraft/src'));
const say = (...a) => console.log('[t-r5-3]', ...a);

register(pathToFileURL(path.join(HERE, 'r5-hooks.mjs')));

let mod;
try {
    mod = await import(pathToFileURL(path.join(SRC, 'mindcraft/mindserver.js')).href);
} catch (e) {
    console.error('[t-r5-3] CANNOT-RUN：导入 mindserver.js 失败：', e?.message ?? e);
    process.exit(2);
}

const rate = mod.__r5_rate;
if (!rate || typeof rate.takeToken !== 'function') {
    console.error('[t-r5-3] CANNOT-RUN：加载钩子没能从 mindserver.js 取到 takeToken/RATE_BUCKETS');
    process.exit(2);
}

const { takeToken, RATE_BUCKETS } = rate;
/** 声称的上界（老实现里是硬编码 512；新实现有常量）。 */
const CLAIMED_MAX = 512;
say('声称的桶上界：', CLAIMED_MAX, ' 观察到常量：', rate.RATE_BUCKETS_MAX ?? '(无)');

const N = 600;
let allowed = 0;
for (let i = 0; i < N; i++) {
    // 每个地址都是**新鲜**的：第一次出现，ts = 现在（所以"删 60s 以上的"一个都删不掉）
    const socket = { handshake: { address: `10.9.${Math.floor(i / 250)}.${i % 250}` } };
    if (takeToken(socket, 'flood', 5, 60000)) allowed++;
}

const size = RATE_BUCKETS.size;
say(`构造 ${N} 个新鲜 key 后：RATE_BUCKETS.size = ${size}，放行 ${allowed}/${N}`);
const maxTsAge = Math.max(...[...RATE_BUCKETS.values()].map((v) => Date.now() - (v.ts ?? 0)));
say('表内最旧条目年龄(ms)：', maxTsAge, '（全部新鲜 ⇒ 陈旧项清理不可能生效）');

if (size > CLAIMED_MAX) {
    say(`REPRODUCED：桶上界不成立 —— 声明上限 ${CLAIMED_MAX}，实际 ${size} 条，新鲜 key 一条也淘汰不掉`
        + `（超出 ${size - CLAIMED_MAX} 条）`);
    process.exit(0);
}
say(`NOT-REPRODUCED：上界成立 —— 实际 ${size} 条 <= 声明上限 ${CLAIMED_MAX}`);
process.exit(1);
