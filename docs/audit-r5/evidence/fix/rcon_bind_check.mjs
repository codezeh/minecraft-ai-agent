/**
 * R5-008 绑定行为 A/B 验证（不改生产、不重启生产）。
 *
 * 目的：证明 server-ip 这一项真的决定 RCON 监听地址。
 *   A 组：用**改动前**的 server.properties（server-ip= 空）→ 期望 0.0.0.0:<port>
 *   B 组：用**改动后**的 server.properties（server-ip=127.0.0.1）→ 期望 127.0.0.1:<port>
 *
 * 为什么用临时端口：生产端口 25565/25575 属于生产服；本机随时可能有别的任务起服，
 * 抢端口会把"起不来"误判成"改坏了"。绑定地址与端口号无关，换端口不影响结论。
 *
 * 口令：从不打印。新口令直接从 B 组配置里读；旧口令从 /tmp/.r5-oldpw 读。
 *      RCON 输出只打印 PASS/FAIL 与"认证成功/失败"，不打印任何口令片段。
 */
import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const ROOT = 'E:/我的世界ai';
const SERVER_JAR = path.join(ROOT, 'server/server.jar');
const TEMPLATE = path.join(ROOT, 'test-template');
const SRV_TEST = path.join(ROOT, 'server-test');
const WORK = path.join(ROOT, 'tmp/r5-fix-rcon');
const PROD = path.join(ROOT, 'server/server.properties');
const BAK = fs.readdirSync(WORK).filter((f) => f.startsWith('server.properties.bak-')).sort().pop();

function findJava() {
  const tools = path.join(ROOT, '.tools');
  for (const d of fs.readdirSync(tools)) {
    if (!d.startsWith('jdk')) continue;
    const exe = path.join(tools, d, 'bin', 'java.exe');
    if (fs.existsSync(exe)) return exe;
  }
  throw new Error('no jdk');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 极简 RCON（自己实现，避免任何库把口令写进日志） */
function rconConnect(port, password, host = '127.0.0.1', timeout = 5000) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, host);
    let stage = 'connect';
    let settled = false;
    let buf = Buffer.alloc(0);
    const done = (err, val) => {
      if (settled) return;
      settled = true;
      clearTimeout(t);
      try { sock.destroy(); } catch { /* ignore */ }
      err ? reject(err) : resolve(val);
    };
    const t = setTimeout(() => done(new Error('timeout')), timeout);
    const send = (id, type, body) => {
      const b = Buffer.from(body, 'utf8');
      const pkt = Buffer.alloc(14 + b.length);
      pkt.writeInt32LE(10 + b.length, 0);
      pkt.writeInt32LE(id, 4);
      pkt.writeInt32LE(type, 8);
      b.copy(pkt, 12);
      pkt.write('\0\0', 12 + b.length, 'latin1');
      sock.write(pkt);
    };
    sock.on('connect', () => { stage = 'auth'; send(1, 3, password); });
    sock.on('error', (e) => done(new Error('connect-error:' + e.code)));
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      while (buf.length >= 12) {
        const len = buf.readInt32LE(0);
        if (buf.length < len + 4) break;
        const id = buf.readInt32LE(4);
        const pkt = buf.subarray(4, 4 + len);
        buf = buf.subarray(4 + len);
        if (id === -1) return done(new Error('auth-failed'));      // 认证失败
        if (stage === 'auth') { stage = 'cmd'; send(2, 2, 'list'); continue; }
        const body = pkt.subarray(8).toString('utf8').replace(/\0+$/, '');
        return done(null, body);
      }
    });
  });
}

function listening(port) {
  try {
    const out = execSync('netstat -ano', { encoding: 'latin1' });
    return out.split(/\r?\n/).filter((l) => new RegExp(':' + port + '\\s').test(l) && /LISTENING/i.test(l));
  } catch { return []; }
}

async function runVariant(label, propsSource, serverPort, rconPort, pwFile, negativePwFile = null) {
  const dir = path.join(WORK, 'run-' + label);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });

  let props = fs.readFileSync(propsSource, 'utf8');
  props = props.replace(/^server-port=.*$/m, 'server-port=' + serverPort);
  props = props.replace(/^rcon\.port=.*$/m, 'rcon.port=' + rconPort);
  props = props.replace(/^query\.port=.*$/m, 'query.port=' + serverPort);
  props = props.replace(/^level-type=.*$/m, 'level-type=minecraft\\:flat');
  fs.writeFileSync(path.join(dir, 'server.properties'), props, 'latin1');
  fs.writeFileSync(path.join(dir, 'eula.txt'), 'eula=true', 'latin1');
  fs.cpSync(path.join(TEMPLATE, 'world'), path.join(dir, 'world'), { recursive: true });
  for (const d of ['libraries', 'versions', 'cache']) {
    const src = path.join(SRV_TEST, d);
    if (fs.existsSync(src)) fs.symlinkSync(src, path.join(dir, d), 'junction');
  }

  const child = spawn(findJava(), ['-Xms512M', '-Xmx1024M', '-jar', SERVER_JAR, 'nogui'], {
    cwd: dir, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  });
  let log = '';
  child.stdout.on('data', (b) => { log += b.toString(); });
  child.stderr.on('data', (b) => { log += b.toString(); });

  const deadline = Date.now() + 240000;
  while (Date.now() < deadline && !log.includes('Done (')) await sleep(1000);
  if (!log.includes('Done (')) {
    try { child.kill(); } catch { /* ignore */ }
    console.log(`FAIL ${label} 起服超时 —— 日志尾部：${log.slice(-500)}`);
    return null;
  }

  const lines = listening(rconPort);
  console.log(`--- ${label}（server-port=${serverPort}, rcon.port=${rconPort}）`);
  console.log(`    netstat 中 ${rconPort} 的 LISTENING 行：`);
  for (const l of lines) console.log('      ' + l.trim().replace(/\s+/g, ' '));

  let authMsg = '';
  let authOk = false;
  try {
    const body = await rconConnect(rconPort, fs.readFileSync(pwFile, 'utf8').trim());
    authMsg = 'OK: ' + String(body).trim();
    authOk = true;
  } catch (e) { authMsg = 'ERR: ' + e.message; }
  console.log('    使用配置里的口令跑 list → ' + authMsg);

  let negMsg = '';
  let negRejected = null;
  if (negativePwFile && fs.existsSync(negativePwFile)) {
    try {
      const body = await rconConnect(rconPort, fs.readFileSync(negativePwFile, 'utf8').trim());
      negMsg = 'UNEXPECTED-OK: ' + String(body).trim().slice(0, 80);
      negRejected = false;
    } catch (e) {
      negMsg = 'rejected: ' + e.message;
      negRejected = e.message === 'auth-failed';
    }
    console.log('    用**旧口令**跑 list → ' + negMsg);
  }

  try { await new Promise((r) => { child.stdin.write('stop\n'); setTimeout(r, 100); }); } catch { /* ignore */ }
  const sd = Date.now() + 60000;
  while (Date.now() < sd && child.exitCode === null) await sleep(500);
  if (child.exitCode === null) { try { child.kill(); } catch { /* ignore */ } }
  await sleep(1500);
  return { lines, dir, authOk, negRejected };
}

const newPwFile = path.join(WORK, '.newpw');
const prodPw = fs.readFileSync(PROD, 'latin1').match(/^rcon\.password=(.*)$/m)[1].trim();
fs.writeFileSync(newPwFile, prodPw, 'utf8');

// A：改动前的配置（server-ip 空）
const OLD_PW = '/tmp/.r5-oldpw';
const A = await runVariant('A-old-empty-ip', path.join(WORK, BAK), 25580, 25590, OLD_PW);
// B：改动后的配置（server-ip=127.0.0.1），用配置里的新口令；再用旧口令做负向对照
const B = await runVariant('B-new-127', PROD, 25581, 25591, newPwFile, OLD_PW);

// 旧口令负向对照（在 B 组停服前做不了，单独再起一次太重 → 用 B 的端口重新连已停服，故此处只做记录）
fs.rmSync(newPwFile, { force: true });

const bindA = (A?.lines ?? []).join('\n');
const bindB = (B?.lines ?? []).join('\n');
console.log('\n=== 结论 ===');
console.log('A（server-ip= 空）绑定：' + (bindA ? bindA.split('\n')[0].trim().replace(/\s+/g, ' ') : '无监听行'));
console.log('B（server-ip=127.0.0.1）绑定：' + (bindB ? bindB.split('\n')[0].trim().replace(/\s+/g, ' ') : '无监听行'));
const aAll = /0\.0\.0\.0:25590|\[::\]:25590/.test(bindA);
const bLocal = /127\.0\.0\.1:25591/.test(bindB);
console.log(`A 为全网卡监听（0.0.0.0/[::]）: ${aAll ? 'PASS' : 'FAIL'}`);
console.log(`B 为仅本机监听（127.0.0.1）: ${bLocal ? 'PASS' : 'FAIL'}`);
console.log(`B 组新口令可通: ${B?.authOk ? 'PASS' : 'FAIL'}`);
console.log(`B 组旧口令被拒: ${B?.negRejected === true ? 'PASS' : 'FAIL'}`);
const ok = aAll && bLocal && B?.authOk === true && B?.negRejected === true;
console.log('RESULT=' + (ok ? 'ALL PASS' : 'HAS FAILURES'));
process.exit(ok ? 0 : 1);
