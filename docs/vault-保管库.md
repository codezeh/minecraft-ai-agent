# 凭据保管库（加密存 API Key）

> 一句话：把 `mindcraft/keys.json` 里的**明文** API Key 换成 **AES-256-GCM 加密的 sqlite**
> （`mindcraft/.secrets.db`），面板上增删改、**永不回显明文**；agent 侧通过环境变量取用。
>
> 相关代码：`mindcraft/src/agent/library/secrets_vault.js`（密码学/存储）、
> `mindcraft/src/mindcraft/mindserver.js`（HTTP 面）、`mindcraft/src/utils/keys.js`（读取优先级）、
> `web/src/views/VaultView.vue` + `web/src/stores/vault.ts`（面板）。
> 测试：`mindcraft/tools/vault_unit.mjs`（18 条）。

---

## 1. 它和 keys.json 的区别（先理解这个，再决定要不要迁）

| | `keys.json`（旧） | 保管库（新） |
|---|---|---|
| 落盘形态 | **明文**，`cat` 就能看 | 密文 + nonce + tag；库文件里搜不到明文（有单测断言） |
| 防护 | 全靠文件 ACL | 文件 ACL **+ 口令派生密钥**（口令他不知道，拿到文件也解不开） |
| 查看已存的值 | 随时能看 | **永远看不到**，只有 `****abcd (51 字)`，要改只能整体替换 |
| 记录 | 无 | 每条有 `updated_at` / `updated_by` |
| 换机器 | 拷文件即可 | 拷 `.secrets.db` **+ 记得口令**（口令丢了就没了） |

### 它**不是**什么（诚实边界，别把它当银弹）

- **不是"装了就不用管口令"**：安全边界从"文件权限"移到了"口令强度 + KDF"。
  口令弱，拿到库文件的人可以离线爆破（scrypt N=32768 只是把每次尝试变贵，不是不可能）。
- **挡不住同账户的恶意进程**：能读 `mindserver` 进程内存的东西（调试器、注入）照样能拿 KEK。
  ACL 收紧挡的是**同机其他 Windows 账户**。
- **挡不住"面板被别人看到"**：面板过了握手 token 门，谁拿到 token 谁能操作保管库。
  本轮没有引入第二套用户体系 —— 这也是为什么 unlock 加了"60 秒 5 次失败"的限流。
- **不是哈希**：哈希不可逆，API Key 要拿去调模型，存了等于没存。所以这里必须是**可解密**加密，
  这是需求决定的，不是安全性上的让步。

---

## 2. 初始化（第一次用）

**方式 A：面板（推荐）**

1. 打开控制台 → 顶部导航「凭据」。
2. 状态显示「未初始化」时，输入**主口令**两次 → 「创建保管库」。
3. 口令要求 ≥ 8 位。**它不会被存下来**，系统只用它经 scrypt 派生出解密密钥。

**方式 B：命令行**

```bash
cd mindcraft
# 未初始化时初始化 + 解锁（二选一：已有库就只 unlock）
node -e "import('./src/agent/library/secrets_vault.js').then(v=>{v.init('你的口令');console.log(v.status())})"
```

> ⚠️ **口令丢了不可恢复**。保管库不存口令、也不存任何"找回"通道 ——
> 这是特性不是缺陷（能找回就等于能被人找回）。丢了只能删掉 `.secrets.db` 重新录入所有 key。

---

## 3. 解锁 / 上锁

- 面板：锁定态输入口令 → 「解锁」；解锁后右上角「上锁」。
- REST：

  ```bash
  TOKEN=$(cat mindcraft/.mindserver-token)      # 每次启动都会变
  curl -s -X POST "http://127.0.0.1:8080/api/vault/unlock?token=$TOKEN" \
       -H 'Content-Type: application/json' -d '{"passphrase":"你的口令"}'
  # → {"ok":true,"injected":16}
  ```

- 上锁会做两件事：把内存里的 KEK **清零并丢弃**；把注入过的**环境变量撤回**
  （否则"锁了但子进程还拿着 key"是假的锁）。

### 无头启动：`MC_VAULT_PASSPHRASE`

```bash
MC_VAULT_PASSPHRASE='你的口令' node main.js
```

启动时若库已存在，会自动解锁并把条目注入进程环境。

> ⚠️ **这是便利选项，不是安全选项**。进程环境对同机同账户的任何进程可见
> （Process Explorer / 任务管理器导出等）。把它等同于"把口令写在启动脚本里"。

**不带这个变量时**：保管库保持锁定，`keys.js` 会自动回落到 `keys.json` / 环境变量，
于是 `node main.js` 照常能跑 —— 未解锁**不会**让 bot 起不来。

---

## 4. 接入方（agent）怎么拿到 key

三层优先级（`mindcraft/src/utils/keys.js`）：

```
环境变量  >  保管库（.secrets.db）  >  keys.json（兼容，每次用都打 deprecation 警告）
```

**为什么"环境变量"排第一**：agent 是 mindserver `spawn` 出去的**子进程**，
拿不到父进程内存。mindserver 解锁时把解密后的 key 写进**自己的** `process.env`
（`src/agent/library/secrets_vault.js` 的 `injectEnvFromVault()`），
子进程启动时 `env: { ...process.env }` 自然继承 —— **全程不写盘**。

所以：

| 场景 | key 从哪来 | 要注意 |
|---|---|---|
| 面板启动 agent（vault 已解锁） | 父进程环境变量（注入） | 已运行的 agent 要**重启**才拿到新 key |
| 面板启动 agent（vault 锁定） | `keys.json` → 环境变量 | 日志里有 deprecation 警告 |
| `node main.js` 单进程直跑 | `keys.js` 直接读保管库（需解锁 / `MC_VAULT_PASSPHRASE`） | 向后兼容，行为不变 |

注入时**不会覆盖**进程启动时就已存在的环境变量（用户显式设的 env 优先，与读取优先级一致）。

---

## 5. 迁移：把现有 `keys.json` 导入

一次性脚本 `tools/vault_import.mjs`。**它不会删 `keys.json`**（删凭据不可逆，由你决定）。

```bash
cd mindcraft

# 先干跑：只看会导入什么，不写库
# PowerShell: $env:MC_VAULT_PASSPHRASE='你的口令'
MC_VAULT_PASSPHRASE='你的口令' node tools/vault_import.mjs --dry-run

# 真导入（库不存在会顺手初始化）
MC_VAULT_PASSPHRASE='你的口令' node tools/vault_import.mjs
```

输出形如：

```
  ✓ OPENAI_API_KEY  ****cdef (51 字)
  ✓ GEMINI_API_KEY  ****9f2a (39 字)

已导入 2 项，请自行删除 E:\...\mindcraft\keys.json（脚本**不会**替你删：…）
```

建议顺序：**导入 → 重启一个 agent 验证能正常调模型 → 再删 `keys.json`**。

- 脚本**只从环境变量取口令**（`--passphrase` 这类参数在 `ps`/任务管理器里对同机可见）。
- 名字不合法（不是 `^[A-Z][A-Z0-9_]{2,63}$`）、值为空/超长/含换行的条目会被跳过并逐条报告，
  **不影响**已导入的条目；重跑是幂等的（同名覆盖，`created_at` 保留）。
- 支持 `--keys <路径>` 指定别的文件。

---

## 6. HTTP API

全部在**现有握手 token 门之后**（无 token 一律 401，没有新增鉴权面）。

| 方法 | 路径 | 说明 | 锁定态 |
|---|---|---|---|
| GET | `/api/vault/status` | `{initialized, locked, count, kdf}` | 200（锁定也能看） |
| POST | `/api/vault/init` | `{passphrase}` 首次建库（salt + verifier） | 201 / 已初始化 409 |
| POST | `/api/vault/unlock` | `{passphrase}` → `{ok, injected}` | 200 / 口令错 401 / 限流 429 |
| POST | `/api/vault/lock` | 清 KEK + 撤回注入的环境变量 | 200（已锁时 409） |
| GET | `/api/vault/items` | `[{name, hint, updatedAt, updatedBy}]`（**永不含 value**） | **409** |
| PUT | `/api/vault/items/:name` | `{value}` 新增或替换；name `^[A-Z][A-Z0-9_]{2,63}$`、value ≤ 4096 | **409** |
| DELETE | `/api/vault/items/:name` | 删除；不存在 404 | **409** |

错误体统一 `{error: <CODE>, message: <人话>}`，错误码：
`VAULT_LOCKED` / `VAULT_BAD_PASSPHRASE` / `VAULT_BAD_NAME` / `VAULT_BAD_VALUE` /
`VAULT_NOT_FOUND` / `VAULT_DECRYPT_FAILED` / `VAULT_NOT_INITIALIZED` / `VAULT_ALREADY_INITIALIZED`。

> 锁定态除 `status` / `init` / `unlock` 外一律 **409** —— 这是刻意的：
> 409 表示"状态不对，改完再来"，而不是 403"你没权限"（会不会 403 取决于 token，与锁无关）。
> 按字面理解，这条**也包括 `/lock` 自己**：已锁定时再 `POST /lock` 返回 409，
> 而不是幂等的 200（否则"锁定态"会多出一个 200 出口，验收逐条打时会判不一致）。

---

## 7. 加密细节（给要改代码的人）

| 项 | 值 |
|---|---|
| 算法 | AES-256-GCM（认证加密，改 1 字节即失败） |
| nonce | 每条 **独立随机 12 字节**；表上 `UNIQUE` 约束兜底（复用会直接写不进库） |
| AAD | **`name`**（把密文和名字绑死：把 A 的密文挪到 B 名下会解密失败） |
| KDF | `scrypt(passphrase, salt, 32, {N:32768, r:8, p:1})` → KEK，**只驻内存** |
| verifier | 用 KEK 加密固定串 `"mc-vault-v1"`，用于校验口令（解不开 = 口令错） |
| 落盘 | `secrets(name, alg, nonce, ciphertext, tag, hint, created_at, updated_at, updated_by)` |
| `hint` | `****` + 后 4 位 + ` (N 字)`，例如 `****abcd (51 字)` |
| 文件 | `mindcraft/.secrets.db`（`.gitignore`；创建时用 icacls 收成"只当前用户 + SYSTEM + Administrators"） |

单测 `tools/vault_unit.mjs` 对这 8 件事都有断言（含"读 `.db` 原始字节搜不到明文"）。

---

## 8. 常见问题

**Q：忘了口令怎么办？**
删 `mindcraft/.secrets.db`（库里全是解不开的密文），重新初始化，把 key 重新录一遍。
**没有**任何绕过方式 —— 能绕过就说明加密是假的。

**Q：能换口令吗？**
当前版本不支持直接改口令（改 salt 就要重加密全部条目）。做法：用旧口令导出重录 →
或直接重新录入。若确有需要，可作为后续增量（`rekey(old, new)`）。

**Q：能不能再加"显示原值"？**
不行，这是产品约束不是待办：**写了就不可查看**，要改只能整体替换。
理由：面板一旦能回显，明文就会出现在浏览器内存/截图/剪贴板里，等于把落盘风险换个地方发生。

**Q：面板上一片空白 / 报"net"错？**
只用 prod 构建（`web/dist`，由 mindserver 挂到 `/console`）时正常。
`vite dev`（5173）目前只代理 `/socket.io` 与 `/assets`，**没有代理 `/api`** ⇒
开发模式下凭据页会连不上。要么用 prod 构建调，要么在 `web/vite.config.ts` 的
`server.proxy` 里补一条（本单未改该文件，属后续跟进）：

```ts
'/api': { target: 'http://127.0.0.1:8080', changeOrigin: true },
```

**Q：`.secrets.db` 能进 docker 镜像吗？**
不能（本单未改 `.dockerignore`，属后续跟进）：现有 Dockerfile 用显式 `COPY` 清单，
不会拷到它；但构建**上下文**里仍会带上它。建议在 `.dockerignore` 补 `*.db` / `.secrets.db`。

---

## 9. 相关文件

| 文件 | 作用 |
|---|---|
| `mindcraft/src/agent/library/secrets_vault.js` | 加密、KDF、sqlite 存储、环境注入 |
| `mindcraft/src/utils/keys.js` | 读取优先级：env > 保管库 > keys.json（deprecation） |
| `mindcraft/src/mindcraft/mindserver.js` | `/api/vault/*` 路由（token 门之后） |
| `mindcraft/tools/vault_unit.mjs` | 18 条离线单测（`node tools/vault_unit.mjs`） |
| `mindcraft/tools/vault_import.mjs` | 一次性迁移脚本（不自动删 keys.json） |
| `web/src/views/VaultView.vue` / `web/src/stores/vault.ts` | 面板 |
| `docs/audit-r5/fixes/05-vault.md` | 本轮的改动清单与实测证据 |
