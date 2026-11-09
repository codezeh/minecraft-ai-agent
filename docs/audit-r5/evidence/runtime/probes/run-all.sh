#!/usr/bin/env bash
# t-r5 运行时探针批量跑：每项跑两遍 —— 当前工作树 / 修复前基线树。
# 退出码约定：0=缺陷复现，1=未复现，2=CANNOT-RUN。
# 期望的"探针有效"证据：基线树 0（复现），当前树 1（已修）。
set -u
cd "$(dirname "$0")/../../../../.." || exit 9   # → 仓库根（E:/我的世界ai）

PROBES=docs/audit-r5/evidence/runtime/probes
LOGS=docs/audit-r5/evidence/runtime/logs
mkdir -p "$LOGS"

BASE_PREFIX=E:/我的世界ai/mindcraft/tmp/r5-base-prefix/src          # R4 修复前（7524899）
BASE_LIMIT=E:/我的世界ai/mindcraft/tmp/r5-base-limit/src            # R3-2 修复前（4c91264）
PREFIX_WEB=docs/audit-r5/evidence/runtime/tmp/agents.prefix.ts      # t14 离线闸修复前

# 基线树是临时 worktree：跑之前先建，跑完可以删（不进版本库、也不让全仓 lint 扫到旧代码）
if [ ! -d "$BASE_PREFIX" ] || [ ! -d "$BASE_LIMIT" ]; then
  echo "基线树不存在。先建："
  echo "  cd mindcraft && git worktree add tmp/r5-base-prefix 7524899 && git worktree add tmp/r5-base-limit '6c8758e^'"
  echo "（只跑当前树可以忽略本提示；下面的基线步骤会记 CANNOT-RUN=125）"
fi

run() { # run <name> <label> <env-assignment...> --
  local n="$1" label="$2"; shift 2
  local log="$LOGS/$n.$label.log"
  env "$@" node "$PROBES/$n.mjs" > "$log" 2>&1
  local rc=$?
  printf '%-10s %-8s exit=%d  %s\n' "$n" "$label" "$rc" "$(grep -E "REPRODUCED|CANNOT-RUN" "$log" | tail -1 | cut -c1-120)"
  return $rc
}

printf '%-10s %-8s %s\n' PROBE TREE RESULT

for n in t-r5-1 t-r5-2 t-r5-4 t-r5-5 t-r5-6 t-r5-7 t-r5-9 t-r5-10; do
  run "$n" current
  run "$n" prefix R5_SRC="$BASE_PREFIX"
done

# 3：限流上界 —— 修复点是 R3-2，基线与上面不同
run t-r5-3 current
run t-r5-3 limit R5_SRC="$BASE_LIMIT"

# 8：前端离线闸 —— 基线是"修复前的 agents.ts"
run t-r5-8 current
run t-r5-8 prefix R5_WEB_FILE="$PREFIX_WEB"

rm -f docs/audit-r5/evidence/runtime/tmp/agents.bundle.*.mjs
echo '--- 完成'
