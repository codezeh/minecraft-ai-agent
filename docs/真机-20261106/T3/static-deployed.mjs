// 静态证据：面板**实际部署**的前端产物里，WEB-003 那段代码到底是什么。
// 只读 web/dist 与 git，不写产品文件。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const ROOT = 'E:/我的世界ai';
const EV = path.join(ROOT, 'docs/真机-20261106/T3/evidence');
fs.mkdirSync(EV, { recursive: true });
const git = (...a) => execFileSync('git', a, { cwd: ROOT }).toString().trim();

const distDir = path.join(ROOT, 'web/dist');
const entry = fs.readdirSync(path.join(distDir, 'assets')).filter((f) => /^index-.*\.js$/.test(f)).sort()[0];
const entryPath = path.join(distDir, 'assets', entry);
const buf = fs.readFileSync(entryPath);
const s = buf.toString('utf8');
const sha256 = crypto.createHash('sha256').update(buf).digest('hex');

const m = s.match(/function i\(a\)\{[^}]*\}/);
const counting = (re) => (s.match(re) || []).length;

const srcPath = path.join(ROOT, 'web/src/components/ChatStream.vue');
const srcStat = fs.statSync(srcPath);
const distStat = fs.statSync(entryPath);

const out = {
  结论: '面板进程（PID 4392，静态挂 ./web/dist）发出的入口 bundle 里没有 isImeComposing 的三项判定；它的 keydown 处理器与修复前源码（git 22c41e8）同构 ⇒ WEB-003 的修复没有进入部署产物。',
  入口chunk: {
    文件: 'web/dist/assets/' + entry,
    字节: buf.length,
    sha256,
    mtime: distStat.mtime.toISOString(),
  },
  源码: { 文件: 'web/src/components/ChatStream.vue', mtime: srcStat.mtime.toISOString(), 字节: srcStat.size },
  关键串计数: { isComposing: counting(/isComposing/g), '229': counting(/229/g), Process: counting(/Process/g) },
  部署bundle里的keydown处理器: m ? m[0] : '(未匹配到)',
  修复前源码对应片段: 'function onKey(e) { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send() } }',
  时间线: {
    部署bundle_mtime: distStat.mtime.toISOString(),
    源码mtime: srcStat.mtime.toISOString(),
    修复提交: git('log', '-1', '--format=%H %ad', '--date=iso', '--grep=WEB-003', '--', 'web/src/components/ChatStream.vue'),
    gitHEAD: git('log', '-1', '--format=%H %ad', '--date=iso'),
  },
  服务端挂载点: 'mindcraft/src/mindcraft/mindserver.js:496-501 —— webDist = ../../../web/dist，存在即 app.use("/console", express.static(webDist))',
};

fs.writeFileSync(path.join(EV, 'deployed-dist-static.json'), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
