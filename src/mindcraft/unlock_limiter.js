/**
 * `/api/vault/unlock` 的失败限流（T31 / W-2）。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 为什么单独抽一个文件：这段逻辑有两个**必须能被离线证明**的性质 ——
 *   ① "连续失败到上限之后，**正确口令仍然能成功**"（不能把管理员锁在门外）；
 *   ② "两个来源的失败计数互不影响"（一个来源打错不会连累另一个）。
 * 写在 mindserver 的路由闭包里就只能靠起服务器 + 两个源地址去凑，抽出来之后
 * `tools/vault_unit.mjs` 可以直接逐条断言。
 *
 * ── 修的是什么（T18 攻击测试 W-2 实测结论）──────────────────────────────
 * 旧实现三个问题叠在一起：
 *   · 计数**全局一份**（不分来源）⇒ 任何人打错都能消耗掉别人的额度；
 *   · **先判限流、后校验口令** ⇒ 第 6 次起**正确口令也 429**；
 *   · 成功后只清零了 `count`，但 `firstAt` 没跟着走（时间窗语义混乱）。
 * 攻击后果：持 token 者每 60 秒故意打错一次 ⇒ 管理员**永久**解不开库。
 * 讽刺的是限流本身是为了防 token 泄漏 —— 防泄漏的手段成了 DoS 手段。
 *
 * ── 现在的语义（两条铁律）────────────────────────────────────────────────
 *   ① **先校验口令，再决定 429。** 也就是说：`isThrottled()` 只能影响
 *      "**失败**时回 401 还是 429"，**绝不能阻止一次正确的解锁**。
 *      代价是超限期间失败的尝试仍要付一次 scrypt（~百毫秒）—— 这正好是天然的刹车，
 *      换来的是"管理员永远不会被锁死"，这个取舍是刻意的。
 *   ② **按来源分桶**（`remoteAddress`，与 mindserver 其它限流器口径一致）。
 *      IPv4-mapped IPv6（`::ffff:127.0.0.1`）会归一成 `127.0.0.1`，
 *      否则同一个客户端会因为绑定方式不同被拆成两个桶。
 * ═══════════════════════════════════════════════════════════════════════════
 */

/** 把 `::ffff:127.0.0.1` 这类映射地址归一成 IPv4；其余小写化。 */
export function normalizeAddress(addr) {
    let a = String(addr ?? '').trim();
    if (!a) return 'unknown';
    // Node 在双栈监听时把 IPv4 客户端报成 ::ffff:a.b.c.d
    if (a.toLowerCase().startsWith('::ffff:')) a = a.slice(7);
    return a.toLowerCase();
}

/** 从 express 的 req 里取来源键（优先 socket 的真实地址，其次 req.ip）。 */
export function addressKeyOf(req) {
    return normalizeAddress(req?.socket?.remoteAddress ?? req?.ip ?? 'unknown');
}

/**
 * @param {{windowMs?:number, maxFails?:number, maxBuckets?:number, now?:()=>number}} [opts]
 */
export function createUnlockLimiter({
    windowMs = 60_000,
    maxFails = 5,
    maxBuckets = 512,
    now = Date.now,
} = {}) {
    /** @type {Map<string, {count:number, firstAt:number}>} */
    const buckets = new Map();

    /** 取桶；跨窗口就重置（同一处逻辑，避免"清零时忘记动时间戳"的老毛病）。 */
    function bucketOf(key, t) {
        let b = buckets.get(key);
        if (!b || t - b.firstAt > windowMs) {
            b = { count: 0, firstAt: t };
            buckets.set(key, b);
        }
        return b;
    }

    /** 桶满时清理：先清过期，再按插入顺序淘汰最旧（同 takeToken 的做法）。 */
    function ensureRoom(t) {
        if (buckets.size < maxBuckets) return;
        for (const [k, v] of buckets) {
            if (t - v.firstAt > windowMs) buckets.delete(k);
        }
        while (buckets.size >= maxBuckets) {
            const oldest = buckets.keys().next().value;
            if (oldest === undefined) break;
            buckets.delete(oldest);
        }
    }

    return {
        windowMs,
        maxFails,

        /** 这个来源**当前的失败次数**（测试/日志用）。 */
        failuresOf(key) {
            const b = buckets.get(key);
            if (!b) return 0;
            return now() - b.firstAt > windowMs ? 0 : b.count;
        },

        /**
         * 是否已超限。**只用于决定"失败"该回 401 还是 429** ——
         * 绝不能用它提前 return（那正是 W-2 的原样）。
         */
        isThrottled(key) {
            const b = buckets.get(key);
            if (!b) return false;
            const t = now();
            if (t - b.firstAt > windowMs) {
                buckets.delete(key);
                return false;
            }
            return b.count >= maxFails;
        },

        /** 记一次失败（口令错）。返回该来源累计失败次数。 */
        noteFailure(key) {
            const t = now();
            ensureRoom(t);
            const b = bucketOf(key, t);
            b.count += 1;
            return b.count;
        },

        /**
         * 记一次成功：**该来源的计数清零**，并让时间窗从现在重新起算。
         * 这样"成功后立刻再错一次"只会是第 1 次失败（401），不会直接 429。
         */
        noteSuccess(key) {
            buckets.delete(key);
        },

        /** 诊断用：桶数量。 */
        size() {
            return buckets.size;
        },

        /** 测试用：清空。 */
        reset() {
            buckets.clear();
        },
    };
}

/**
 * ★ R6 #30：**并发闸**（信号量），给"昂贵的同步算力"用（这里是 scrypt）。
 * `tryEnter()` 不排队（拿不到返回 null ⇒ 调用方回 429），release 幂等；只管"同时在算几个"。
 * 为什么需要：/unlock 刻意"先校验口令再看限流"，代价就是没有并发上限（CPU 可被打满）。
 * @param {{max?:number}} [opts]
 */
export function createConcurrencyGate({ max = 2 } = {}) {
    const limit = Number.isFinite(max) && max > 0 ? Math.floor(max) : 2;
    let active = 0;
    let peak = 0;
    return {
        max: limit,
        /** 当前在跑的数量（诊断/测试用）。 */
        get active() { return active; },
        /** 历史峰值（诊断用：真被压过没有）。 */
        get peak() { return peak; },
        /**
         * 尝试进入。成功返回 release()，失败返回 null（**不阻塞、不排队**）。
         * @returns {null|(()=>void)}
         */
        tryEnter() {
            if (active >= limit) return null;
            active += 1;
            if (active > peak) peak = active;
            let released = false;
            return () => {
                if (released) return;      // 幂等：调用方在 finally 里重复调用也只减一次
                released = true;
                active -= 1;
            };
        },
    };
}
