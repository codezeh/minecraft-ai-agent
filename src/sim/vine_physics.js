/**
 * 藤蔓：走路时当空气，要爬时当梯子。
 *
 * 用户判断（2026-10-25，两次修正）：
 *   1) 「藤蔓也可以爬呀，要爬的时候当梯子，不爬的时候当空气不就行了？」
 *   2) 「不允许爬藤蔓肯定是不行的，应该是移动规划有问题……
 *       很明显是技能作者把梯子和藤曼的逻辑搞一起了导致碰到藤曼就触发攀爬」
 *
 * 源码核实（prismarine-physics/index.js）：
 *   function isOnLadder (world, pos) {
 *       if (block.type === ladderId || block.type === vineId) { return true }   // ← 两者混在一起
 *   }
 *   if (isOnLadder(world, pos) && (entity.isCollidedHorizontally ||
 *       (supportFeature('climbUsingJump') && entity.control.jump))) {
 *       vel.y = physics.ladderClimbSpeed      // ← 横向受阻就上升，不需要按跳
 *   }
 *
 * 问题不在"藤蔓能爬"（那是游戏规则），而在**没有意图区分**：
 *   她只是路过藤蔓、横向蹭到树叶，物理就把她抬起来 → 表现为"一碰就爬"。
 *
 * 本模块：**按当前意图，决定物理把藤蔓当什么。**
 *   - 走路（默认）  → 藤蔓 = 空气（能穿过、不抬升）
 *   - 显式要爬      → 藤蔓 = 原样（当梯子，能爬）
 *
 * 实现锚点（为什么能精确做到）：
 *   mineflayer/lib/plugins/physics.js
 *     :19  const world = { getBlock: (pos) => bot.blockAt(pos, false) }
 *     :84  physics.simulatePlayer(new PlayerState(bot, controlState), world).apply(bot)
 *     :207 bot.physics = physics
 *
 *   `simulatePlayer` 是**同步**的，所以只要在它执行期间打开一个标记，
 *   物理问方块时就能看到"藤蔓=空气"，而业务代码（挖方块/寻路/判定）
 *   在这个窗口之外读到的仍是真藤蔓。粒度精确到一次物理计算。
 */
import Vec3 from 'vec3';

/** 藤蔓类（可以爬，但平时当空气） */
const VINE_NAMES = [
    'vine', 'weeping_vines', 'weeping_vines_plant',
    'twisting_vines', 'twisting_vines_plant',
    'cave_vines', 'cave_vines_plant',
];

/**
 * 给 bot 装上「藤蔓按意图对待」的物理层。
 *
 * @param {object} bot
 * @param {object} opts
 *   climbByDefault 初始是否把藤蔓当梯子（默认 false = 当空气）
 * @returns {{ setClimbing(v:boolean):void, isClimbing():boolean, uninstall():void }}
 */
export function installVinePhysics(bot, opts = {}) {
    const { climbByDefault = false } = opts;

    const vineIds = new Set();
    for (const n of VINE_NAMES) {
        const def = bot.registry?.blocksByName?.[n];
        if (def) vineIds.add(def.id);
    }
    if (!vineIds.size) {
        // 这个版本的注册表里没有藤蔓（注册表还没就绪 / 版本差异）。
        //
        // ★ 2026-11-02 修（verify 定位的偶发根因）：原来返回的空壳有两个毛病，
        //   合起来会把「补丁没装上」伪装成「她爬不上去」：
        //   ① `isClimbing()` 返回 `climbByDefault` —— 默认 true 时会**谎报正在爬**；
        //   ② 没有 `installed` 标记，调用方（测试）无法区分
        //      「装上了但爬不动」和「压根没装」。
        //   实测：`installVinePhysics({registry:{blocksByName:{}}})` 之后
        //   `setClimbing(true)`，`isClimbing()` 仍 false，返回对象只有 3 个键。
        //   这是"静默失败"，比抛错更难查 —— 表现是"前进距离恒 2.20、只有 dy 不同"。
        return {
            installed: false,
            setClimbing() { },
            // 没有补丁就绝不能说"正在爬"（旧实现返回 climbByDefault = 谎报）
            isClimbing() { return false; },
            uninstall() { },
        };
    }

    const airId = bot.registry?.blocksByName?.air?.id ?? 0;
    let climbing = climbByDefault;
    let inPhysics = false;       // 只在物理计算窗口内为 true

    // bot.blockAt 要等 mineflayer 的 blocks 插件加载完才有。
    // 如果还没就绪，等 login 后再装（login 一定在插件注入之后）。
    //
    // ⚠ 这里曾经有个真 bug（2026-10-25 修）：
    //   延迟安装时 `setClimbing(true)` 只写进了闭包的局部变量，
    //   而 login 之后重新创建实例时用的是 `opts.climbByDefault`（默认 false），
    //   于是**之前设的意图被丢掉**。后果：探针误判成"悬空藤蔓爬不上去"，
    //   其实是一直被当空气、压根没尝试爬。
    //   现在改成：用一个**共享状态对象**贯穿延迟安装，意图不丢。
    if (typeof bot.blockAt !== 'function') {
        const state = { climbing: climbByDefault };   // 共享意图，延迟安装也不会丢
        let api = null;
        const apply = () => { if (api) api.setClimbing(state.climbing); };
        bot.once('login', () => {
            api = installVinePhysics(bot, { climbByDefault: state.climbing });
            apply();
        });
        bot.once('spawn', apply);   // login 可能早于 blocks 插件就绪，spawn 再兜一次
        return {
            // ★ 2026-11-02：这条延迟安装路径原来**没有 installed**，于是调用方读到的
            //   是 `undefined` —— 与"没装"和"装了但爬不动"都无法区分。
            //   （vine_physics_test 就是卡在这里：报 `vine.installed=undefined`）
            get installed() { return api ? api.installed === true : false; },
            setClimbing(v) { state.climbing = !!v; apply(); },
            // 只有"真装上了 且 意图是爬"才算在爬。旧写法 `return state.climbing`
            // 返回的是**意图**而不是实际状态 —— 补丁没装时它会谎报正在爬。
            isClimbing() { return !!(api && api.installed === true && state.climbing); },
            uninstall() { if (api) api.uninstall(); },
        };
    }

    // ---- 1) 让物理看到"藤蔓=空气"（仅窗口内） ----
    const origBlockAt = bot.blockAt.bind(bot);
    bot.blockAt = function (pos, force) {
        const b = origBlockAt(pos, force);
        if (!b) return b;
        if (!inPhysics || climbing) return b;            // 业务调用 / 主动要爬：原样
        if (!vineIds.has(b.type)) return b;
        // 物理视角：伪装成空气
        const fake = Object.create(b);
        fake.type = airId;
        fake.name = 'air';
        fake.shapes = [];
        fake.boundingBox = 'empty';
        fake.diggable = false;
        return fake;
    };

    // ---- 2) 包住物理入口，精确控制窗口 ----
    // bot.physics 由插件在 :207 赋值。可能比本模块晚，所以延迟挂载。
    let installed = false;
    const wrapPhysics = () => {
        const ph = bot.physics;
        if (!ph || typeof ph.simulatePlayer !== 'function' || ph.__vineWrapped) return false;
        const orig = ph.simulatePlayer.bind(ph);
        ph.simulatePlayer = function (state, world) {
            inPhysics = true;
            try {
                return orig(state, world);
            } finally {
                inPhysics = false;      // 同步窗口：算完立刻关
            }
        };
        ph.__vineWrapped = true;
        installed = true;
        return true;
    };

    if (!wrapPhysics()) {
        // 物理还没就绪：等 login/spawn 后再试一次
        const tryLater = () => { wrapPhysics(); };
        bot.once('login', tryLater);
        bot.once('spawn', tryLater);
    }

    return {
        /** 装上了吗 —— 调用方用它区分「没装」与「装了但爬不动」 */
        get installed() { return installed; },
        /** 显式要爬藤蔓时打开（当梯子） */
        setClimbing(v) {
            climbing = !!v;
            // 迟到的物理对象也要挂上
            if (v && !installed) wrapPhysics();
        },
        isClimbing() { return climbing; },
        uninstall() {
            bot.blockAt = origBlockAt;
            const ph = bot.physics;
            if (ph && ph.__vineWrapped) {
                // 无法恢复原函数（已绑定的闭包），只能标记停用
                ph.__vineWrapped = false;
            }
        },
    };
}
