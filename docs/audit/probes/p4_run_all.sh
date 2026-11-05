#!/usr/bin/env bash
# P4：真实成绩单。逐个直跑（不经过 unit_all 的 spawn，因为沙箱里 spawn 被 EPERM 拦）。
# 运行：bash docs/audit/probes/p4_run_all.sh [> out.txt]
# 说明：cwd 用可写目录（mindcraft/tmp 在本沙箱只读），脚本用绝对路径。
set -u
MIND="/e/我的世界ai/mindcraft"
cd "/e/我的世界ai/docs/audit/probes/run" || exit 1
mkdir -p logs

printf '%-42s %6s %5s %5s %6s %8s\n' SCRIPT EXIT PASS FAIL MS RESULT
run_one() {
  local f="$1"; local t0 t1 ms out code pass fail
  t0=$(date +%s%N)
  out=$(timeout 240 node "$MIND/tools/$f" 2>&1); code=$?
  t1=$(date +%s%N); ms=$(( (t1 - t0) / 1000000 ))
  echo "$out" > "logs/$f.log"
  pass=$(echo "$out" | grep -cE '^\s*(PASS|✓|✅)' || true)
  fail=$(echo "$out" | grep -cE '^\s*(FAIL|✗|❌)' || true)
  local res="ok"
  if [ "$code" -ne 0 ]; then res="EXIT$code"; fi
  if echo "$out" | grep -qE 'EPERM|EACCES'; then res="$res:EPERM"; fi
  if echo "$out" | grep -q 'ERR_MODULE_NOT_FOUND\|Cannot find module'; then res="$res:MODULE"; fi
  if echo "$out" | grep -q 'ENOENT'; then res="$res:ENOENT"; fi
  if echo "$out" | grep -q 'requires.*Minecraft\|ECONNREFUSED\|25566'; then res="$res:NEEDS-SERVER"; fi
  printf '%-42s %6s %5s %5s %6s %8s\n' "$f" "$code" "$pass" "$fail" "$ms" "$res"
}

# 参数：要跑的 glob
PATTERN="${1:-*_unit.mjs}"
for f in $MIND/tools/$PATTERN; do
  run_one "$(basename "$f")"
done
