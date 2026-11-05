id: F-DEP-007
severity: medium
class: deps
file: mindcraft/package-lock.json:node_modules/zod
evidence: |
  真实 lock 版本跑出来的 npm audit（**不是凭印象**）：

  $ cd mindcraft && npm audit --json --registry=https://registry.npmjs.org
  metadata.vulnerabilities = {"info":0,"low":0,"moderate":15,"high":13,"critical":1,"total":29}
  → critical 1 条是 tar（F-DEP-008），high 里与运行时相关的是 zod 这条：

  $ npm audit --json ... | node -e "..."      # 打印 high/critical 的 via 明细
  ===== zod [high] direct=false fix=false
  high Zod can exhaust memory while validating oversized constrained collections
       https://github.com/advisories/GHSA-mrhx-c7xc-m3w5  range=<4.6.6  cwe=CWE-770

  命中版本与依赖路径（prod，不是 dev）：
  $ node -e "..." # 读 lock
  zod 3.25.76  node_modules/zod  [prod]
  $ npm ls zod --all
  minecraft-ai-agent@
  +-- @mistralai/mistralai@1.15.1
  | +-- zod-to-json-schema@3.25.2
  | | `-- zod@3.25.76 deduped
  | `-- zod@3.25.76
  `-- openai@4.104.0
    `-- zod@3.25.76 deduped

  运行时确实在用（不是僵尸依赖）：
  $ grep -rn "from 'openai'" mindcraft/src/models/*.js | wc -l   → 9 个适配器
  $ grep -rn "@mistralai/mistralai" mindcraft/src/models/         → src/models/mistral.js:1

  注：npm audit 对这条给出 fixAvailable=false；advisory 的修复下界是 4.6.6，即**跨主版本**。
  （本机 `npm view zod versions` 被沙箱 EPERM 拦住，无法核实 3.25.x 是否有回补版本 —— 修补者如有网请自行确认。）
exploitability: |
  前置条件：能让 zod 去校验一个"带尺寸约束的集合"且输入超大 —— 在本仓就是 LLM 服务端返回体
  （openai / mistralai SDK 用 zod schema 解析响应）。攻击者模型：被投毒/伪造的 provider 端点
  （用户可自定义 baseURL：src/models/*.js 支持 openrouter/vllm/lmstudio 等任意端点）、
  或 outbound HTTPS 中间人。
  能拿到什么：进程内存耗尽 → 机器人进程 OOM/卡死 → 可用性丧失（CWE-770）。
  拿不到代码执行、拿不到密钥。
  影响半径：单机单进程，需重启；因为 bot 是 op 且面板与 bot 同机，长时间 DoS 会连带面板不可用。
  诚实降级理由：审计口径 high，但实际可达路径窄（需要恶意 provider 端点）且只是 DoS，
  故本条按 medium 排修补优先级。
suggested_fix: |
  1. **最小改动路径不存在**：advisory 修复下界 4.6.6 是 zod 4.x 主版本，而 openai@4.104.0、
     @mistralai/mistralai@1.15.1 都要求 zod ^3 —— 升 zod 会跨主版本并可能改动两套 SDK 的
     structured-output 解析行为，属 PLAYBOOK §3「不做大规模重构」范畴，**今晚不要动**。
  2. 可做的低成本缓解（不动依赖）：
     - 在模型适配层给响应体加尺寸上限（`src/models/*.js` 里 fetch 之后判断 `content-length` /
       实际 body 长度，超阈值直接抛错），把"超大输入"挡在 zod 之前；
     - 给 LLM 请求加 AbortSignal 超时，避免单次解析拖死进程。
  3. 记入 `docs/audit/night/deps-baseline.md`：zod 3.25.76 / GHSA-mrhx-c7xc-m3w5 / 接受风险 + 理由，
     等 openai SDK 支持 zod 4 时再一并对齐（届时用 `npm ls zod` 确认整树只剩一个版本）。
verify: |
  # 1) 缓解生效：伪造一个超大响应，机器人不应 OOM/挂死
  #    （在测试脚本里 mock openai 响应，返回 >10MB 的 JSON 数组，断言抛错且进程 RSS 有界）
  node -e "/* 见 tools/unit_all.mjs 里新增的 unit 用例 */"
  # 2) 现状基线记录后可复核
  cd mindcraft && npm audit --json --registry=https://registry.npmjs.org \
    | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const a=JSON.parse(s);
      const z=a.vulnerabilities.zod; console.log('zod', z&&z.severity, (z&&z.via||[]).map(v=>v.url).join(','))})"
  # 3) 门禁不回归
  npm run gate:full
discovered_by: recon-scout
dept: D1-DEP
