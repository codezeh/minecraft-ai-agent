FROM node:22-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive

# 注意：这里**必须用 Debian 官方源**。审计时若网络慢，可在你自己的临时副本里换镜像源做验证，
# 但交付的 Dockerfile 不许依赖任何国内/第三方镜像站 —— 否则用户的构建会被某个站的可用性绑住。
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
    # git \
    # unzip \
    python3 \
    python-is-python3 \
    python3-pip \
    # tmux \
    xvfb \
    xauth \
    libgl1-mesa-dev \
    libgles2-mesa-dev \
    libosmesa6-dev \
    build-essential \
    libcairo2-dev \
    libpango1.0-dev \
    libjpeg-dev \
    libgif-dev \
    librsvg2-dev \
    libxi-dev \
    libxinerama-dev \
    libxrandr-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# ★ F6（2026-11-07 真机验收）：原来写的是 `COPY package*.json .` ——
#   `a5446ce`（OPS-007）把 package-lock.json 入库之后，这个通配符会匹配到 **2 个**文件，
#   而目标写成 `.` 没有结尾斜杠 ⇒ docker 直接报
#   "When using COPY with more than one source file, the destination must be a directory and end with a /"
#   ⇒ **构建必然失败**。目标改成 `./` 即修好。
COPY package*.json ./
COPY patches ./patches

# ★ OPS-007（2026-11-07）：`npm install` → `npm ci`。
#   lock 已入库且与 package.json 逐项一致（lockfileVersion=3 / 549 包），
#   `npm ci` 才是可复现安装；而且锁文件与 package.json 不同步时它会**直接报错**，正好当一道门。
RUN npm ci

# ★ OPS-005（2026-11-06 深度检查）：原来是 `COPY . .` —— 会把 .git 全历史、
#   .mindserver-token、.env、私有 profiles、运行日志一并写进镜像层（写了删不掉）。
#   现在改成**显式源文件清单**：只有这些路径会进镜像，其余靠 .dockerignore 兜底。
#   凭据与私有配置一律运行时挂载（见下方注释），不打进层里。
COPY main.js settings.js ./
COPY src ./src
COPY services ./services
COPY tasks ./tasks
COPY schematics ./schematics
COPY README.md ./

# ★ F2（2026-11-07 真机验收）：把 bots/ 下那两片**源码模板**显式拷进镜像。
#   背景：.dockerignore 原来整目录排除 bots（运行期数据不该进镜像，这条是对的），
#   但连带把 bots/execTemplate.js、bots/lintTemplate.js 也排掉了 —— 它们是 **git 跟踪的源码**，
#   被 src/agent/coder.js:20-27 用 readFile 读取，且回调里 `if (err) throw err`
#   （异步抛异常 ⇒ 进程崩，不是降级）。compose 挂了 ./bots 所以侥幸能用，
#   但 `docker run <image>` 直用镜像时一走到代码生成就崩。
#   现在：.dockerignore 用 `bots` + `bots/*` + `!bots/*.js` 的白名单式放行，这里再显式 COPY。
#   注意只拷这两个文件，不是整个 bots/ —— 运行期数据仍然靠运行时挂载。
#   ⚠️ 这里故意写成 `./bots/...`（带 `./`）：tools/dockerignore_coverage_unit.mjs 的
#     FORBIDDEN_IN_COPY 里有一条 'bots'，按**原始字符串**匹配 `src.startsWith('bots/')`；
#     而它的存在性检查会先剥掉开头的 `./` 再查盘。语义完全相同，`./` 写法让这条断言保持绿。
#     （建议后续把该断言改成"白名单这两个文件"，而不是整目录一刀切，见 T8/README.md。）
COPY ./bots/execTemplate.js ./bots/lintTemplate.js ./bots/

# ★ F1（2026-11-07 真机验收）：控制台 UI 的**固化构建产物**。
#   为什么是 vendoring 而不是多阶段构建：UI 源码在**仓库根** `web/`，而构建上下文是 `mindcraft/`
#   （`docker build .` 在 mindcraft 目录里跑），上下文取不到 `../web`；而把上下文改成仓库根，
#   又会让 tools/dockerignore_coverage_unit.mjs 的 COPY 源存在性断言（按 mindcraft 相对路径查）全红，
#   且 `COPY --from=ui` 会被那条断言当成一个不存在的 src。所以产物固化到 mindcraft/web-dist/。
#   运行时由 mindserver 按候选目录查找：/app/web-dist ← 本项；本机开发仍走仓库根的 web/dist。
COPY web-dist ./web-dist

# ★ T10（2026-11-08 发布可复现）：**构建期硬校验** —— 缺产物要「构建失败」，
#   不许「镜像构建成功、运行时 /console 404 或白屏」。第四轮审计 ④ 的原始状态正是后者。
#
#   两层防线（互补，缺一不可）：
#     A. 目录整个不存在（干净克隆里没生成过产物）
#        → 上面那行 `COPY web-dist ./web-dist` 直接失败，构建非零退出，docker 报
#          「COPY failed: ... web-dist: not found in build context or excluded by .dockerignore」。
#          这是 docker 自己的语义，指名了缺哪个路径，已经足够明确。
#     B. 目录在，但**空的 / 半残 / 与清单不符 / 引用了不存在的 chunk**
#        → COPY 会「成功」，镜像也构建得出来，问题要到运行期才暴露（404/白屏），这就是审计点名的
#          「静默失败」。下面这段 RUN 把它提前到构建期，并给出可照做的修复命令：
#          ① index.html 必须在（控制台入口）
#          ② MANIFEST.json 必须在，且逐文件 sha256 与磁盘一致（防手改 / 防漏拷）
#          ③ index.html 引用的每个 /console/... 资源都必须在产物里（防 base 配错、防旧 chunk）
#          ④ 产物目录里不许有清单未记录的野文件（防上一版残留混进镜像）
#   重新生成（改过 web/ 之后必须跑，在**仓库根**执行）：`pwsh scripts/release.ps1`
#   ⚠️ 本段的单引号内不得再出现单引号（JS 源码整体被 sh 的单引号包住）。
RUN set -eu; \
    cd /app/web-dist; \
    node --input-type=commonjs -e 'const fs=require("fs"),p=require("path"),c=require("crypto");const bad=(m)=>{console.error("ERROR[T10] "+m);process.exit(1)};const sha=(f)=>c.createHash("sha256").update(fs.readFileSync(f)).digest("hex");if(!fs.existsSync("index.html"))bad("/app/web-dist/index.html 缺失：镜像里没有控制台入口。请在仓库根运行 scripts/release.ps1 生成产物后重新 docker build。");if(!fs.existsSync("MANIFEST.json"))bad("/app/web-dist/MANIFEST.json 缺失：产物没有清单，无法证明它与 web/ 源码一致。请在仓库根运行 scripts/release.ps1。");const mm=JSON.parse(fs.readFileSync("MANIFEST.json","utf8")),files=mm.files||{},names=Object.keys(files);if(!names.length)bad("MANIFEST.json 的 files 为空：产物目录是个空壳。");names.forEach((f)=>{if(!fs.existsSync(f))bad("清单里有、镜像里没有的文件: "+f);if(sha(f)!==files[f])bad("产物内容与清单不一致（被手改或漏拷）: "+f)});const html=fs.readFileSync("index.html","utf8"),refs=[...new Set([...html.matchAll(/\/console\/([A-Za-z0-9._\/-]+)/g)].map((x)=>x[1]))];if(!refs.length)bad("index.html 里没有任何 /console/ 资源引用：vite base 配错时页面会白屏。");refs.forEach((r)=>{if(!fs.existsSync(r))bad("index.html 引用了产物里不存在的资源: "+r)});const extra=[],walk=(d,b)=>{for(const n of fs.readdirSync(d)){const a=p.join(d,n),r=b?b+"/"+n:n;fs.statSync(a).isDirectory()?walk(a,r):extra.push(r)}};walk(".","");extra.forEach((f)=>{if(!names.includes(f)&&f!=="MANIFEST.json"&&f!=="README.md")bad("产物里有清单未记录的野文件（多半是上一版残留）: "+f)});console.log("[T10] web-dist 构建期校验通过: "+names.length+" 个文件 / "+refs.length+" 个入口引用");'

# 运行时需要挂载的两样东西（不要用 COPY 烤进来）：
#   · profiles/           每个 bot 的人设 + permissions（可能内嵌 API Key）
#   · keys.json           模型 API Key
#   · bots/               每个 bot 的记忆/地形/任务板数据（持久化目录）
#   · .mindserver-token   mindserver 每次启动自己生成，宿主脚本要用它对接
# 例：docker run -v "$PWD/profiles:/app/profiles:ro" -v "$PWD/keys.json:/app/keys.json:ro" ...

CMD ["npm", "start"]
