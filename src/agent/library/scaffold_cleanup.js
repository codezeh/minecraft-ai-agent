/**
 * 垫脚方块的记录与清理。
 *
 * 用户要求：「砍完树后，也得把垫脚的方块给清除了」。
 *
 * 场景：pathfinder 为了让路（`allow1by1towers`/scaffolding）会临时放方块，
 * 比如垫一格上去够树顶、或搭桥跨沟。这些方块留在世界里就是垃圾。
 *
 * ═══ D7 修复（2026-10-31）═══
 * 旧实现：监听 `blockUpdate`，把「air → 非空气」且在她 32 格内的方块都记下来。
 * 问题是**"air→实体"不等于"我放的"**——别的玩家在她旁边放方块、水变冰、
 * 藤蔓长出来、甚至她自己踩塌变成沙砾，全都符合这个条件。
 * 结果 cleanup 会去挖**别人放的方块**（多 Bot / 多人服上直接是事故）。
 *
 * 新实现：只记**她自己通过 `bot.placeBlock` 放出去的**。
 * 依据（实测 + 读源码）：
 *   - mineflayer 只有 `bot.placeBlock(referenceBlock, faceVector)` 这一条放置路径；
 *   - pathfinder 的垫脚也走它（`mineflayer-pathfinder/index.js:575`）；
 *   - 所以在这里拦一次，就恰好等于"她放的"。
 * `blockUpdate` 不再作为记录来源，只在放置后用来复核那格真的变成了方块。
 */

const MAX_TRACK = 64;

export class ScaffoldTracker {
    constructor(bot) {
        this.bot = bot;
        this.placed = [];        // [{x,y,z,block,at}]
        this._origPlace = null;  // 原始 bot.placeBlock
    }

    /** 开始追踪：包住 bot.placeBlock，只记她真正放成功的方块。 */
    start() {
        if (this._origPlace) return;
        const bot = this.bot;
        if (typeof bot.placeBlock !== 'function') return;

        const orig = bot.placeBlock.bind(bot);
        this._origPlace = bot.placeBlock;
        this._wrapped = (referenceBlock, faceVector, ...rest) => {
            const p = orig(referenceBlock, faceVector, ...rest);
            // 放置成功后再记录（失败会 throw，不记）
            return Promise.resolve(p).then((res) => {
                try { this._recordFromPlacement(referenceBlock, faceVector); } catch { /* 记录失败不影响放置 */ }
                return res;
            });
        };
        bot.placeBlock = this._wrapped;
    }

    /**
     * 由「参考方块 + 面法线」算出被放的那一格，并确认那里真的是实体方块。
     * 只在她附近（32 格）才记，避免远处误伤。
     */
    _recordFromPlacement(referenceBlock, faceVector) {
        if (!referenceBlock?.position || !faceVector) return;
        const base = referenceBlock.position;
        const x = Math.floor(base.x + faceVector.x);
        const y = Math.floor(base.y + faceVector.y);
        const z = Math.floor(base.z + faceVector.z);

        const me = this.bot.entity?.position;
        if (!me) return;
        if (Math.hypot(x - me.x, z - me.z) > 32) return;

        // 复核：那格现在必须是非空气实体（否则就是没放成/被立刻打掉）
        let name = null;
        try {
            const b = this.bot.blockAt?.({ x, y, z }, false);
            name = b?.name ?? null;
        } catch { return; }
        if (!name || name === 'air' || name === 'cave_air' || name === 'void_air') return;

        this._push({ x, y, z, block: name });
    }

    _push(item) {
        // 同一格重复记录只留一条（pathfinder 可能在同格重试）
        const i = this.placed.findIndex((p) => p.x === item.x && p.y === item.y && p.z === item.z);
        if (i >= 0) this.placed.splice(i, 1);
        this.placed.push({ ...item, at: Date.now() });
        if (this.placed.length > MAX_TRACK) this.placed.shift();
    }

    /** 停止追踪：恢复原始 bot.placeBlock。 */
    stop() {
        if (!this._origPlace) return;
        try { this.bot.placeBlock = this._origPlace; } catch { }
        this._origPlace = null;
        this._wrapped = null;
    }

    /** 还没清掉的垫脚方块数量。 */
    get size() { return this.placed.length; }

    /**
     * 清掉记录过的垫脚方块。
     * 只挖「现在还是那个方块」的（她可能后来又改过）。
     * @returns {{removed:number, skipped:number}}
     */
    async cleanup(digFn, opts = {}) {
        const { maxMs = 20000 } = opts;
        const t0 = Date.now();
        let removed = 0, skipped = 0;

        // 从后往前清（后放的更可能是最上面的垫脚块，先清高处更安全）
        const items = [...this.placed].reverse();
        this.placed = [];

        for (const it of items) {
            if (Date.now() - t0 > maxMs) { skipped++; continue; }
            if (this.bot.interrupt_code) { skipped++; continue; }
            try {
                const b = this.bot.blockAt?.({ x: it.x, y: it.y, z: it.z }, false);
                if (!b || b.name !== it.block) { skipped++; continue; }   // 已经变了
                const r = await digFn(this.bot, { kind: 'block', pos: { x: it.x, y: it.y, z: it.z } });
                if (r?.ok) removed++;
                else skipped++;
            } catch {
                skipped++;
            }
        }
        return { removed, skipped };
    }
}
