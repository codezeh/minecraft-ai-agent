// 由 scripts/release.ps1 现场写出的临时助手：给 web-dist/MANIFEST.json 打"发布元数据"并校验。
//   node <helper> <stamp|verify> <manifest 绝对路径> <web 源码目录绝对路径>
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const [mode, manifestPath, webSrc] = process.argv.slice(2);
if (!mode || !manifestPath || !webSrc) {
  console.error('用法: node helper <stamp|verify> <manifest> <webSrc>');
  process.exit(2);
}

const distDir = path.dirname(manifestPath);
const sha256Buf = (b) => crypto.createHash('sha256').update(b).digest('hex');
const sha256File = (p) => sha256Buf(fs.readFileSync(p));
let pass = 0;
const bad = (m, fix) => {
  console.error(`  FAIL  ${m}`);
  if (fix) console.error(`        修复：${fix}`);
  process.exit(1);
};
const ok = (m) => { pass++; console.log(`  PASS  ${m}`); };

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const files = manifest.files || {};
const names = Object.keys(files).sort();
if (names.length === 0) bad('MANIFEST.json 的 files 为空', '重新运行 scripts/release.ps1 生成产物。');

// ── 1. 逐文件核对（防手改 / 防漏拷） ──
for (const rel of names) {
  const abs = path.join(distDir, rel);
  if (!fs.existsSync(abs)) bad(`清单里有、磁盘上没有的文件: ${rel}`, '重新同步产物。');
  const got = sha256File(abs);
  if (got !== files[rel]) bad(`产物内容与清单不一致: ${rel}`, '产物被手改过；重新运行 scripts/release.ps1。');
}
ok(`${names.length} 个产物文件与清单逐条一致`);

// ── 2. 反向：不许有清单未记录的野文件（上一版残留最容易卡在这） ──
const walk = (dir, base = '') => {
  const out = [];
  for (const n of fs.readdirSync(dir)) {
    const abs = path.join(dir, n);
    const rel = base ? `${base}/${n}` : n;
    if (fs.statSync(abs).isDirectory()) out.push(...walk(abs, rel));
    else out.push(rel);
  }
  return out;
};
const SELF = new Set(['MANIFEST.json', 'README.md']);
const extras = walk(distDir).filter((f) => !SELF.has(f) && !names.includes(f));
if (extras.length) bad(`产物里有清单未记录的野文件: ${extras.join(', ')}`, '产物目录被污染；重新运行 scripts/release.ps1。');
ok('产物目录没有清单未记录的野文件');

// ── 3. index.html 引用的每个 /console/... 资源都必须真实存在 ──
const html = fs.readFileSync(path.join(distDir, 'index.html'), 'utf8');
const refs = [...new Set([...html.matchAll(/\/console\/([A-Za-z0-9._/-]+)/g)].map((m) => m[1]))].sort();
if (refs.length === 0) bad('index.html 里没有任何 /console/ 资源引用', 'web/vite.config.ts 的 base 必须是 /console/。');
for (const r of refs) {
  if (!fs.existsSync(path.join(distDir, r))) bad(`index.html 引用了产物里不存在的资源: ${r}`, '产物与源码不同步；重新构建。');
}
ok(`index.html 的 ${refs.length} 个入口引用都能在产物里找到`);

// ── 4. 源码 hash：把产物绑到"是哪一版 web/ 源码构建出来的" ──
//  只纳入真正影响产物的输入（src/** + 构建配置 + 锁定依赖）；node_modules/ dist/ 不算。
const SOURCE_ENTRIES = ['src', 'index.html', 'vite.config.ts', 'tsconfig.json', 'package.json', 'package-lock.json'];
const sourceFiles = [];
const collect = (abs, rel) => {
  const st = fs.statSync(abs);
  if (st.isDirectory()) {
    for (const n of fs.readdirSync(abs).sort()) collect(path.join(abs, n), `${rel}/${n}`);
  } else {
    sourceFiles.push({ rel, hash: sha256File(abs) });
  }
};
for (const entry of SOURCE_ENTRIES) {
  const abs = path.join(webSrc, entry);
  if (!fs.existsSync(abs)) bad(`找不到源码输入: web/${entry}`, 'web/ 目录不完整；确认在仓库根运行。');
  collect(abs, entry);
}
sourceFiles.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
const sourceHash = 'sha256:' + sha256Buf(sourceFiles.map((f) => `${f.rel}\0${f.hash}\n`).join(''));
ok(`源码指纹 ${sourceHash}（${sourceFiles.length} 个输入文件）`);

const artifactHash = 'sha256:' + sha256Buf(names.map((rel) => `${rel}\0${files[rel]}\n`).join(''));
ok(`产物指纹 ${artifactHash}（${names.length} 个产物文件）`);

// ── 5. verify 模式：与清单里记录的值比对（这就是"漂移检测"的绑定处） ──
if (mode === 'verify') {
  const rec = manifest.source && manifest.source.hash;
  const recArtifact = manifest.artifact && manifest.artifact.hash;
  if (!rec || !recArtifact) {
    bad('MANIFEST.json 里没有发布元数据（source.hash / artifact.hash / generatedAt）',
      '清单是旧格式；在仓库根运行 scripts/release.ps1（不要只跑 tools/sync_web_dist.mjs）。');
  }
  if (rec !== sourceHash) {
    bad(`产物与源码不一致：清单记录 ${rec}，当前 web/ 源码是 ${sourceHash}`,
      'web/ 改过但产物没重新生成 → 运行 scripts/release.ps1 重新构建并同步。');
  }
  ok('产物与 web/ 源码指纹一致（产物确实是这份源码构建出来的）');
  if (recArtifact !== artifactHash) {
    bad(`产物指纹与清单不一致：记录 ${recArtifact}，实际 ${artifactHash}`, '重新生成产物。');
  }
  ok('产物指纹与清单一致');
  const recRefs = Array.isArray(manifest.entryAssets) ? manifest.entryAssets.slice().sort() : [];
  if (recRefs.join('|') !== refs.join('|')) {
    bad(`index.html 入口引用与清单不一致：记录 [${recRefs.join(', ')}]，实际 [${refs.join(', ')}]`, '重新生成产物。');
  }
  ok('入口引用与清单一致');
  console.log(`  INFO  generatedAt = ${manifest.generatedAt || '(未记录)'}`);
  console.log(`\n  ALL PASS: ${pass} passed, 0 failed`);
  process.exit(0);
}

// ── 6. stamp 模式：写回元数据（保持 key 顺序可读） ──
const stamped = {
  schemaVersion: 2,
  generatedFrom: manifest.generatedFrom || 'web/dist (Vue3 + Vite console)',
  generatedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
  source: { root: 'web/', files: sourceFiles.length, hash: sourceHash, inputs: SOURCE_ENTRIES },
  artifact: { files: names.length, hash: artifactHash },
  entryAssets: refs,
  note: manifest.note || '镜像用的固化产物。改过 web/ 之后必须重新生成；本清单供 web_dist_manifest_unit 做漂移检测。',
  files,
};
fs.writeFileSync(manifestPath, JSON.stringify(stamped, null, 2) + '\n');
console.log(`  PASS  已写回发布元数据（generatedAt = ${stamped.generatedAt}）`);
console.log(`\n  ALL PASS: ${pass + 1} passed, 0 failed`);
