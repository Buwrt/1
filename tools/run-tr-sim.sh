#!/usr/bin/env bash
# 翻译「改前 vs 改后」并排对照。
#
# 做法：把改动前的 translate.js 从 git 里取出来，和当前工作树这一份各跑一遍
#       tools/tr-sim.js 的四种场景，打印并排结果。
#
# 为什么基线不写死提交号：两个库的历史不同（提交哈希对不上），写死就在另一个
# 库里跑挂。这里按「有没有 abort 开关」自动挑——找不到就退回 HEAD。
#
# 依赖：node + jsdom（npm i jsdom）
#
# 用法：bash tools/run-tr-sim.sh [基线提交号]

set -uo pipefail

SRC="app/src/main/assets/web/js/translate.js"
SIM="$(cd "$(dirname "$0")" && pwd)/tr-sim.js"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

if ! node -e "require('jsdom')" 2>/dev/null; then
  echo "缺少 jsdom，先装一下：  npm i jsdom" >&2
  exit 2
fi

pick_baseline() {
  local rev body
  for rev in $(git log --format=%H -- "$SRC"); do
    # 别写成 git show ... | grep -q：grep -q 一命中就关管道，git show 被
    # SIGPIPE 打死退出码 141，配上 set -o pipefail 整条管道就算失败。
    body="$(git show "$rev:$SRC" 2>/dev/null || true)"
    case "$body" in
      *"opts.abort"*) ;;
      *) echo "$rev"; return ;;
    esac
  done
  echo "HEAD"
}

BASE="${1:-$(pick_baseline)}"
git show "$BASE:$SRC" > "$WORK/old-translate.js" 2>/dev/null || {
  echo "取不到基线 $BASE 的 $SRC" >&2; exit 1;
}

echo "基线（改动前）: $BASE"
echo

run_pair() {
  local mode="$1" title="$2"
  echo "── $title ──"
  node "$SIM" "$WORK/old-translate.js" "改前" "$mode"
  node "$SIM" "$SRC"                 "改后" "$mode"
  echo
}

echo "（假引擎固定往返 120ms；差异来自翻译模块本身）"
echo
run_pair search   "搜索页：换词 / 翻页都不走路由，#sres 是原地重建的"
run_pair leak     "同上，但连着重渲染 12 轮：看会不会一轮比一轮糟"
run_pair full     "一口气翻完 40 段：多久出第一个中文 / 多久全翻完"
run_pair big      "大页面 200 段：有道这一条路径扛不扛得住"
run_pair switch   "翻到 1.5 秒时换页：换页后还有多少请求在白跑"
run_pair regress  "回归：段数有没有被数成两倍 / 缓存还命中吗 / 还原干净吗"
run_pair throttle "并发突发时撞上 411：会不会卡死 / 能不能自己收回来"
