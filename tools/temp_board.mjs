/**
 * 临时板库助手（R6 #1b，2026-11-10）。
 *
 * 背景：`openBoard()` 曾经默认指向 `bots/_board`（**生产库**），于是 live 实测工具
 * 无参调用就会直接操作线上数据 —— `tools/board_b3_live.mjs:128-131` 更是
 * `DELETE FROM jobs` / `DELETE FROM claims`，跑一次清空线上任务与预占，
 * 而正常 DELETE 不产生 `.corrupt-*` 备份（删了就是删了）。
 *
 * 现在 `openBoard(dir)` 必须显式传目录；**会写库的 live 工具一律用本助手**：
 * 每次运行新建一个独立临时目录，测试之间互不干扰，也永远碰不到生产库。
 *
 * 只读观察类工具不要用这个 —— 它们要看真实系统，应使用
 * `openBoard(resolveExistingBoardDir(), { readOnly: true })`（存档维度迁移前后都找到同一块真库）。
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openBoard } from '../src/agent/library/board_store.js';

/** 新建一个本次运行专用的板库目录（带 tag 便于排查残留）。 */
export function tempBoardDir(tag = 'live') {
    return mkdtempSync(join(tmpdir(), `mcboard-${tag}-`));
}

/** 打开一个全新的临时板库。返回值同 openBoard(dir)，额外带 dir。 */
export function openTempBoard(tag = 'live') {
    const dir = tempBoardDir(tag);
    return { ...openBoard(dir), dir };
}
