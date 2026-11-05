id: F-DEP-009
severity: low
class: deps
file: mindcraft/package-lock.json:node_modules/glob
evidence: |
  $ cd mindcraft && npm audit --json --registry=https://registry.npmjs.org | node -e "..."   # high 明细
  ===== glob [high] direct=false fix=false
  nodes: node_modules/glob
  high glob CLI: Command injection via -c/--cmd executes matches with shell:true
       GHSA-5j98-mcp5-4vw2  range=>=10.2.0 <10.5.0  cwe=CWE-78
  moderate Glob: AbortSignal cancellation bypass allows post-timeout filesystem traversal
       GHSA-3g3m-2fjr-6pw4  range=>=9.0.0 <=14.0.1  cwe=CWE-400

  ===== minimatch [moderate]
  moderate minimatch has potential denial of service via globparts amplification
       GHSA-g3hv-75wg-m249  range=>=7.0.0 <11.0.1

  命中版本：
  $ node -e "..." # 读 lock
  glob      10.4.5  node_modules/glob                      [prod 树]
  minimatch  9.0.9  node_modules/glob/node_modules/minimatch [prod 树]
  minimatch  3.1.5  node_modules/minimatch                   [prod 树]

  路径（只有构建期，没有运行时）：
  $ npm ls glob --all
  minecraft-ai-agent@
  `-- node-canvas-webgl@0.3.0
    `-- gl@8.1.6
      `-- node-gyp@10.3.1
        +-- glob@10.4.5
        `-- make-fetch-happen@13.0.1
          `-- cacache@18.0.4
            `-- glob@10.4.5 deduped

  可达性核查（把 high 降到 low 的依据）：
  $ grep -rn "glob" mindcraft/tools/*.mjs mindcraft/package.json | grep -i "glob(" → 无
  $ grep -rn "require('glob')\|from 'glob'" mindcraft/src mindcraft/main.js mindcraft/tools → 无输出
  本仓所有脚本（tools/*.mjs、.githooks/*）都用 fs/readdir 自己遍历，**从不调用 glob CLI**，
  而这条 CVE 的攻击面正是 `glob -c '<cmd>'` 的 shell:true 执行。
exploitability: |
  GHSA-5j98-mcp5-4vw2 需要：攻击者能控制传给 glob CLI 的 `-c/--cmd` 参数，且本仓真的调用了该 CLI。
  两个条件都不成立（不调用 CLI、参数无外部输入）→ 实际可利用性 ≈ 0。
  minimatch 的中危是 ReDoS 型 globparts 放大，同样只在构建工具链内、输入为本地 glob 字符串。
  影响半径：仅 `npm install` / `npm rebuild` 期间，且需先有本地参数注入点。
suggested_fix: |
  1. 与 F-DEP-008 同一根：glob/minimatch 都挂在 node-gyp 下。修法统一在 node-gyp 层，
     **不要**单独 overrides 到 glob@10.5.0（glob 是 node-gyp 的直接依赖，越过它的 caret 范围
     会在其它机器上产生 lock 漂移）：
     `"overrides": { ..., "glob": "^10.5.0" }` 只有在 `npm ci && npm rebuild gl` 验证通过后才可以留。
  2. 更稳的做法：接受风险 + 记录（构建期-only、CLI 不被调用），把预算留给 F-DEP-003/004/005/006。
  3. 明确写进 deps-baseline：glob 10.4.5 / minimatch 9.0.9 / 仅构建期 / 不调用 glob CLI。
verify: |
  cd mindcraft
  # 1) 证明确实不调用 glob CLI（这条 finding 降级的依据，修完也要能复现这个结论）
  grep -rn "require('glob')\|from 'glob'" src main.js tools || echo "OK: no glob usage"
  node -e "const s=require('./package.json').scripts;const bad=Object.entries(s)
    .filter(([k,v])=>/glob\s+-c|glob\s+--cmd/.test(v));console.log(bad.length?('FAIL '+JSON.stringify(bad)):'OK: no glob CLI in scripts')"
  # 2) 若做了 overrides：构建与门禁仍绿
  node -e "console.log(require('./node_modules/glob/package.json').version)"
  npm rebuild gl 2>&1 | tail -3 && npm run gate:full
discovered_by: recon-scout
dept: D1-DEP
