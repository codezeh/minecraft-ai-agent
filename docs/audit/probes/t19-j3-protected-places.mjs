// t19：第 8 条 J3 端到端验证 —— rememberChest 之后 protectedPlaces 必须非空。
// 运行：cd E:\我的世界ai && node docs/audit/probes/t19-j3-protected-places.mjs
// 关键技巧：store 用的是**相对路径** `./bots/<name>/...`，主仓 bots/ 只读；
//   所以先 chdir 到可写的 os.tmpdir()/dsh-* 再跑，写入落在 tmp，不碰仓库。
import os from 'os';
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-t19-j3-'));
process.chdir(TMP);
console.log('[0] cwd =', process.cwd());

const LIB = pathToFileURL('E:/我的世界ai/mindcraft/src/agent/library/').href;
const lmMod = await import(LIB + 'landmarks.js');
const qc = await import(LIB + 'query_classify.js');

const bot = { username: '__t19_probe__' };

// 1) 用真实写入方 rememberChest（生产路径）
lmMod.resetProtectedCache?.(bot);
lmMod.rememberChest(bot, { x: 100, y: 64, z: -200 }, 't19 probe chest');

// 2) 落盘形状（确认写入端是扁平，没有 .pos 层）
const f = path.join(TMP, 'bots', bot.username, 'memory', 'chests.json');
const raw = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '(no file)';
console.log('[1] 写入端落盘:', raw.replace(/\s+/g, ' ').slice(0, 160));

// 3) 读端必须能识别
const spots = lmMod.protectedPlaces(bot);
console.log('[2] protectedPlaces 长度 =', spots.length, '内容:', JSON.stringify(spots).slice(0, 140));

const hit = spots.some((s) => s && s.x === 100 && s.z === -200);
console.log('[3] 判定:', hit ? 'PASS —— 非空且含该箱子（J3 真修好）' : 'FAIL —— 仍为空/不含（J3 没修好）');

// 4) isProtected 能否拦住
const ip = qc.isProtected({ x: 100, y: 64, z: -200 }, { spots, radius: 6 });
console.log('[4] isProtected:', JSON.stringify(ip.data));

// 清洁
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
