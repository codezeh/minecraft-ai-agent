/**
 * 日志的唯一实现。
 *
 * 为什么单独放一个文件：`skills.log` 和（将来的）其它模块都要写日志，
 * 如果各写一份，"undefined 加固"这类细节就会分裂成两个真相。
 *
 * 加固的两点都是实测踩过的：
 * 1) `bot.output` 可能是 undefined —— `undefined + '文字'` 会静默产出
 *    "undefined文字"，把日志头污染成乱码（实测出现过）。
 * 2) `message` 可能是 undefined（调用方少传），同样会写出字面量 "undefined"。
 *
 * 历史注记：这个文件曾经还提供 fail()/runSkill()/asBool()，
 * 用来把技能返回值统一成 { ok, code, message, data }。
 * 后来实测发现按 .code 分支的调用方是 0 个（code 在命令层就被丢掉了），
 * 于是回滚，只保留日志实现。规则见 docs/技能返回值契约.md
 */

export function logLine(bot, message) {
    if (typeof bot.output !== 'string') bot.output = '';
    bot.output += (message === undefined ? '' : String(message)) + '\n';
}
