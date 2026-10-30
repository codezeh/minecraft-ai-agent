/**
 * 垫脚方块的记录与清理。
 *
 * 用户要求：「砍完树后，也得把垫脚的方块给清除了」。
 *
 * 场景：pathfinder 为了让路（`allow1by1towers`/scaffolding）会临时放方块，
 * 比如垫一格上去够树顶、或搭桥跨沟。这些方块留在世界里就是垃圾。
 *
 * 实现：监听 `blockUpdate`，把「air → 非空气」且发生在她附近（32 格内）
 * 的方块记下来。任务结束时逐个挖掉——但只挖「自己放的」，不碰别人的。
 *
 * 实测依据：bot.placeBlock 会触发 blockUpdate，事件里能拿到
 *   oldBlock.name='air' → newBlock.name='dirt'
 * 这就是「她自己放的」的可靠信号（自然生成的方块不会这样出现）。
 */

const MAX_TRACK = 64;

export class ScaffoldTracker {
    constructor(bot) {
        this.bot = bot;
        this.placed = [];      // [{x,y,z,block,at}]
        this.listener = null;
    }

    start() {
        if (this.listener) return;
        this.listener = (oldBlock, newBlock) => {
            try {
                if (!newBlock || !newBlock.position) return;
                const from = oldBlock?.name ?? 'air';
                const to = newBlock.name;
                // 只记「从空气变成实体」的（放置），且排除水和火焰这类自然流动
                if (from !== 'air' || to === 'air' || to === 'water' || to === 'lava') return;
                // 只记她附近的（远处别人的操作不记）
                const p = this.bot.entity.position;
                const d = Math.hypot(newBlock.position.x - p.x, newBlock.position.z - p.z);
                if (d > 32) return;
                this.placed.push({
                    x: newBlock.position.x,
                    y: newBlock.position.y,
                    z: newBlock.position.z,
                    block: to,
                    at: Date.now(),
                });
                if (this.placed.length > MAX_TRACK) this.placed.shift();
            } catch { /* 事件回调里不抛 */ }
        };
        this.bot.on('blockUpdate', this.listener);
    }

    stop() {
        if (!this.listener) return;
        try { this.bot.removeListener('blockUpdate', this.listener); } catch { }
        this.listener = null;
    }

    /** 还没清掉的垫脚方块数量。 */
    get size() { return this.placed.length; }

    /**
     * 清掉记录过的垫脚方块。
     * 只挖「现在还是那个方块」的（她可能后来又改过），并且不挖有支撑作用的。
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
