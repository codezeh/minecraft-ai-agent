/**
 * t14 探针：harvestCrop 的后置失败码。
 *
 * 场景：作物熟了、dig 成功返回，但世界没变（方块还在）—— 这时它给什么码？
 * 疑点：代码里写的是 `fail('TIMEOUT', '收了但 xxx 还在')`，可是并没有超时发生。
 */
import { harvestCrop } from './src/agent/library/act_farm.js';
import Vec3 from 'vec3';

const POS = new Vec3(10, 64, 10);
const wheat = {
    name: 'wheat', position: POS,
    getProperties: () => ({ age: 7 }),
    digTime: () => 100,
};

const bot = {
    username: 'probe',
    interrupt_code: null,
    entity: { position: new Vec3(10, 64, 11) },
    heldItem: null,
    inventory: { items: () => [], slots: [], emptySlotCount: () => 5 },
    // 方块一直存在：dig 成功但世界不变（模拟"保护区域/工具不对/服务端吞包"）
    blockAt: () => wheat,
    dig: async () => { /* 成功返回，但世界不变 */ },
    stopDigging: () => {},
};

const r = await harvestCrop(bot, POS);
console.log('harvestCrop（熟了、dig 成功、方块还在）→', JSON.stringify({ ok: r.ok, code: r.code, message: r.message, data: r.data }));
console.log('CODES 里更贴切的用法应该是 DIG_FAIL（"挖了但没生效"），而不是 TIMEOUT（"没在时限内完成"）');
