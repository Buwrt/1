#!/usr/bin/env bash
# README 翻译仿真：改前 / 改后 对比跑
#
#   bash tools/run-readme-sim.sh [改前的 commit] [--all]
#
# 不带参数时，「改前」用 HEAD（即未改动的工作区版本）对照「改后」= 工作区，
# 那就是自己跟自己比 —— 所以正常用法是给一个基线 commit。
#
# 工作副本里只有一份 translate.js，所以做法是：
#   1) 把「改前」版本的 translate.js 从 git 里掏出来，放到临时目录；
#   2) 分别对这两个文件跑同一个 harness，除了文件路径一模一样。
# 这样两边量到的差异只可能来自代码，不可能来自环境。
set -u
cd "$(dirname "$0")/.." || exit 1

BASE="${1:-}"
ALL="${2:-}"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

JS=app/src/main/assets/web/js/translate.js
AFTER="$TMP/after.js"
cp "$JS" "$AFTER"

BEFORE="$TMP/before.js"
if [ -n "$BASE" ]; then
  git show "$BASE:$JS" > "$BEFORE" 2>/dev/null || { echo "拿不到 $BASE 的 $JS"; exit 1; }
else
  cp "$JS" "$BEFORE"
fi

FILES="donnemartin_system-design-primer"
[ "$ALL" = "--all" ] && FILES=$(ls tools/readme | sed 's/\.md$//')

for f in $FILES; do
  echo ""
  echo "════════════════════════════════════════════════════════════"
  echo "  $f"
  echo "════════════════════════════════════════════════════════════"
  echo "── 改前 ──"
  NODE_PATH=/tmp/work/.simdeps/node_modules TR_SIM_YD_LIMIT=900 \
    node tools/readme-sim.js "$BEFORE" 改前 "tools/readme/$f.md" 2>&1 | tail -20
  echo ""
  echo "── 改后 ──"
  NODE_PATH=/tmp/work/.simdeps/node_modules TR_SIM_YD_LIMIT=900 \
    node tools/readme-sim.js "$AFTER" 改后 "tools/readme/$f.md" 2>&1 | tail -20
done
