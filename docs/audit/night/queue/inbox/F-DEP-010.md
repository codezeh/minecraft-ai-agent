id: F-DEP-010
severity: low
class: deps
file: mindcraft/package-lock.json:node_modules/body-parser
evidence: |
  $ cd mindcraft && npm audit --json --registry=https://registry.npmjs.org | node -e "..."   # high 明细
  ===== body-parser [high] direct=false affects=["express"] fix=false
  high body-parser vulnerable to Denial of Service via trailing bytes after a compressed request body
       GHSA-27r3-jxmh-p828  range=<1.20.9  cwe=CWE-248
  ===== express [high] direct=true affects=["prismarine-viewer"]
  ===== prismarine-viewer [high] direct=true

  命中版本与范围：
  $ node -e "..." # 读 lock
  express      4.22.3   node_modules/express       [prod, 直接依赖]
  body-parser  1.20.8   node_modules/body-parser   [prod]
  $ node -p "require('./node_modules/express/package.json').dependencies['body-parser']"
  "~1.20.5"          # ← 1.20.9 落在 ~1.20.5 允许范围内，属纯补丁升级

  运行时可达性核查（**这是把 high 降成 low 的关键，别跳过**）：
  $ grep -rn "express.json\|bodyParser\|urlencoded" mindcraft/src mindcraft/main.js
  （无输出 —— 全仓没有任何 body 解析中间件）
  $ grep -n "app.use\|listen(" mindcraft/src/mindcraft/mindserver.js
  85:  app.use((req,res,next)=>{...})     # 只做 token/cookie 门
  143: app.use(express.static(...))      # 只发静态资源
  207: app.use('/console', express.static(webDist))
  489: server.listen(port, host, ...)    # 见下：host 固定 localhost
  $ sed -n '485,489p' mindcraft/src/mindcraft/mindserver.js
  const host = 'localhost';

  即：body-parser 虽在依赖树里（express 自带），但本仓**没有挂 json/urlencoded 中间件**，
  且 mindserver 只监听 localhost → CVE 描述的攻击面（压缩请求体尾部字节）在本仓没有入口。
  另：prismarine-viewer 依赖同一个 express（deduped），它起的 viewer server 也没挂 body 解析。
exploitability: |
  要触发需要：服务暴露到非本机 + 存在解析请求体的中间件。本仓两条都不满足
  （bind localhost；无 body parser 中间件）→ 实际可利用性 ≈ 0。
  影响半径：若将来有人给 mindserver 加 `express.json()` 并改成对外监听（settings.js 里
  `host_public` 有相关开关，当前只打印"不支持"），这条会立刻变成真实的 pre-auth DoS。
  诚实降级理由：审计口径 high，运行时不可达；保留低优先级修补是因为**改造成本几乎为零**。
suggested_fix: |
  纯补丁升级，不跨主版本、不动 express 大版本：
  `cd mindcraft && npm update body-parser`（把 1.20.8 → 1.20.9，满足 express 的 `~1.20.5`），
  或显式 `"overrides": { ..., "body-parser": "^1.20.9" }` 后在干净环境 `npm ci` 重建 lock。
  commit body 写：GHSA-27r3-jxmh-p828 / body-parser 1.20.8 → 1.20.9 / 仅补丁级。
  同时（真正的收益）：在 README 或 settings 注释里写明"mindserver 不得对外监听；
  如必须，先确认没有挂 body 解析中间件"。
verify: |
  cd mindcraft
  node -e "const v=require('./node_modules/body-parser/package.json').version;
           console.log(v); if(require('compare-versions')||1){ }" 2>/dev/null || true
  node -p "require('./node_modules/body-parser/package.json').version"    # 期望 >= 1.20.9
  npm ls body-parser                                                      # 期望 1.20.9 deduped
  npm audit --json --registry=https://registry.npmjs.org \
    | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const a=JSON.parse(s);
       const b=a.vulnerabilities['body-parser']; console.log('body-parser:', b?b.severity:'clean');
       if(a.vulnerabilities['body-parser']) process.exit(1)})"            # 期望 clean
  npm run gate:full                                                       # 不回归
discovered_by: recon-scout
dept: D1-DEP
