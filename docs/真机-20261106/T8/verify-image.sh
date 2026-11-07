#!/usr/bin/env bash
# T8 真镜像验证脚本 —— 在 WSL(Ubuntu-24.04) 里跑，驱动容器内检查。
#
# 分两个容器，避免"运行期才出现的文件"污染镜像级结论：
#   A) 镜像级检查：`docker run --rm --entrypoint sh <img>`（**不挂载任何宿主目录、不启动应用**）
#        → 查凭据/私有目录是否真的不在镜像里 + bots 模板是否存在 + *.token 通配探测
#   B) 运行级检查：带 MIND_SERVER_HOST=0.0.0.0 + 挂载 keys.json/profiles 起服务
#        → curl /console?token=… 期望 200，并取到 assets/index-*.js
#
# 用法：bash verify-image.sh <image> [host_port]
set -u
IMG="${1:-mc-ai-audit:fix}"
HOSTPORT="${2:-18080}"
TOKEN="t8-verify-token-20261107"
NAME="t8-verify"
ROOT="/mnt/e/我的世界ai/mindcraft"
PASS=0; FAIL=0
ok(){ PASS=$((PASS+1)); echo "PASS  $*"; }
bad(){ FAIL=$((FAIL+1)); echo "FAIL  $*"; }

cleanup(){ docker rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT
cleanup

echo "════════ A. 镜像级检查（不挂载、不启动应用）════════"
echo "--- A1. /app 顶层 ---"
docker run --rm --entrypoint sh "$IMG" -c 'ls -la /app'

echo
echo "--- A2. F2：bots 源码模板必须在镜像里 ---"
for f in /app/bots/execTemplate.js /app/bots/lintTemplate.js; do
  if docker run --rm --entrypoint sh "$IMG" -c "[ -f $f ]" >/dev/null 2>&1; then
    ok "存在 $f ($(docker run --rm --entrypoint sh "$IMG" -c "stat -c %s $f") B)"
  else
    bad "缺失 $f"
  fi
done

echo
echo "--- A3. OPS-005 不回归：凭据/私有目录必须全部不存在 ---"
SENS="/app/.mindserver-token /app/keys.json /app/.env /app/.env.local /app/profiles /app/.git /app/bots/_board /app/logs /app/tmp"
for p in $SENS; do
  if docker run --rm --entrypoint sh "$IMG" -c "[ -e $p ]" >/dev/null 2>&1; then
    bad "镜像内存在 $p"
  else
    ok "镜像内不存在 $p"
  fi
done

echo
echo "--- A4. G1：*.token 通配探测（全镜像）---"
TOKHITS=$(docker run --rm --entrypoint sh "$IMG" -c \
  "find / -xdev -name '*.token' -printf '%p\n' 2>/dev/null | sort" || true)
if [ -z "$TOKHITS" ]; then ok "整镜像无任何 *.token"; else bad "发现 *.token: $TOKHITS"; fi

echo
echo "--- A5. 其它私钥/凭据形态 ---"
OTHERS=$(docker run --rm --entrypoint sh "$IMG" -c \
  "find / -xdev \( -name '*.pem' -o -name '*.key' -o -name '*.p12' -o -name '*.pfx' -o -name '*.crt' -o -name '*.jks' -o -name 'id_rsa*' \) -printf '%p\n' 2>/dev/null | sort" || true)
if [ -z "$OTHERS" ]; then ok "无 pem/key/p12/pfx/crt/jks/id_rsa"; else echo "INFO 命中（多为 node_modules 里的测试夹具）:"; echo "$OTHERS" | head -10; fi

echo
echo "--- A6. F1：控制台 UI 产物在镜像里 ---"
docker run --rm --entrypoint sh "$IMG" -c 'ls -la /app/web-dist; echo "---"; ls /app/web-dist/assets | head'

echo
echo "════════ B. 运行级检查（MIND_SERVER_HOST=0.0.0.0）════════"
docker run -d --name "$NAME" \
  -e MIND_SERVER_HOST=0.0.0.0 \
  -e MINDSERVER_TOKEN="$TOKEN" \
  -p "127.0.0.1:${HOSTPORT}:8080" \
  -v "$ROOT/keys.json:/app/keys.json:ro" \
  -v "$ROOT/profiles:/app/profiles:ro" \
  "$IMG" >/dev/null
echo "container started: $NAME"

echo "--- 等 HTTP 就绪（最多 90s）---"
CODE=""
for i in $(seq 1 90); do
  CODE=$(curl -s -o /dev/null -m 3 -w '%{http_code}' "http://127.0.0.1:${HOSTPORT}/" 2>/dev/null || true)
  [ "$CODE" = "200" ] && break
  sleep 1
done
echo "根路径 / → HTTP $CODE"

echo
echo "--- B1. F1 验收：GET /console?token=… 期望 200 ---"
CCODE=$(curl -s -o /tmp/t8-console.html -m 10 -w '%{http_code}' \
  "http://127.0.0.1:${HOSTPORT}/console?token=${TOKEN}")
echo "   /console?token=…  → HTTP $CCODE"
[ "$CCODE" = "200" ] && ok "/console 返回 200（不再是 404）" || bad "/console 返回 $CCODE"

echo "--- 浏览器式导航（Accept: text/html，会 302 种 cookie 再跳转）---"
rm -f /tmp/t8-jar
NAV=$(curl -s -L -c /tmp/t8-jar -b /tmp/t8-jar -m 10 -o /tmp/t8-console-nav.html -w '%{http_code}' \
  -H 'Accept: text/html' "http://127.0.0.1:${HOSTPORT}/console?token=${TOKEN}")
echo "   followed → HTTP $NAV"
[ "$NAV" = "200" ] && ok "浏览器导航路径 200" || bad "浏览器导航路径 $NAV"

echo
echo "--- B2. 取 assets/index-*.js ---"
ASSET=$(grep -oE '/console/assets/index-[A-Za-z0-9_-]+\.js' /tmp/t8-console.html | head -1)
echo "   index.html 里的入口: ${ASSET:-<未找到>}"
if [ -n "${ASSET:-}" ]; then
  ACODE=$(curl -s -o /tmp/t8-asset.js -m 20 -w '%{http_code}' "http://127.0.0.1:${HOSTPORT}${ASSET}")
  ASIZE=$(wc -c < /tmp/t8-asset.js)
  echo "   GET $ASSET → HTTP $ACODE，$ASIZE B"
  [ "$ACODE" = "200" ] && [ "$ASIZE" -gt 1000 ] && ok "入口 JS 可取到（$ACODE，$ASIZE B）" || bad "入口 JS 异常（$ACODE，$ASIZE B）"
else
  bad "index.html 里没有 /console/assets/index-*.js"
fi

echo
echo "--- B3. 容器日志（看 UI 挂载行 + 有无 warn）---"
docker logs "$NAME" 2>&1 | grep -iE "console|web-dist|warn|listening|MindServer|token" | head -15
echo "--- 是否出现「未找到控制台 UI」warn ---"
if docker logs "$NAME" 2>&1 | grep -q "未找到控制台 UI"; then
  bad "出现「未找到控制台 UI」warn（UI 未被找到）"
else
  ok "无「未找到控制台 UI」warn"
fi
echo "--- 是否打印了挂载来源（应为 /app/web-dist）---"
docker logs "$NAME" 2>&1 | grep -o "Console UI mounted.*" | head -2

echo
echo "════════ 汇总 ════════"
echo "PASS=$PASS  FAIL=$FAIL"
[ "$FAIL" -eq 0 ] && { echo "ALL PASS"; exit 0; } || { echo "HAS FAILURES"; exit 1; }
