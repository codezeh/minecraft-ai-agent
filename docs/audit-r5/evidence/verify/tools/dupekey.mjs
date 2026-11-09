// 复刻 flow_craft.js:402-418 的对象字面量语义，lastData 里带一个错误的 count
const produced = 3, want = 3, lastData = { count: 999, invAfter: ['x'] };
const withSecond = { craftedItem: 'oak_planks', count: produced, want, got: produced, ...(lastData ?? {}), count: produced };
const withoutSecond = { craftedItem: 'oak_planks', count: produced, want, got: produced, ...(lastData ?? {}) };
console.log('保留第二个 count ->', withSecond.count, '(正确)');
console.log('删掉第二个 count ->', withoutSecond.count, '(被 spread 覆盖，错误)');
console.log('结论:', withSecond.count === 3 && withoutSecond.count === 999 ? 'a) 是误报：第二个 count 是必要的' : '需复核');
