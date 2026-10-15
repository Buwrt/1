#!/usr/bin/env bash
# 「明明在下却弹速度太慢」——新旧两版下载换道判定的对照验证。
#
# 做法：把当前工作树和 git HEAD（改动前）的 JsBridge 各编译一份，
#      交给 SwitchSim 用反射读真常量、跑同一批场景，打印对照表。
#
# 说明：这是一个**纯 Java 的单测**，不起模拟器、不装 APK。
#      只依赖 javac 和 android.jar（用来解析 android.* 符号）。
#
#   OLD_REV 是「改动前」那一版，默认自动挑，不用手填：
#   顺着历史往前找，**最新一个 JsBridge.java 里还没有 firstDataAt 的提交**
#   —— 也就是把宽限期改成「从首字节算起」之前的最后一个版本。
#
#   为什么不直接用 HEAD：HEAD 里已经带着那次修复了，拿它当「改前」
#   时两边读出来的是同一套阈值，对照就没有意义了。
#
#   为什么不写死某个提交号：两个库的提交哈希不一样（历史不同），
#   写死就会在另一个库里直接跑挂。按「有没有这个字段」来找，两边通用，
#   下一轮改动也不用回来改脚本。
#
# 用法：bash tools/run-switch-sim.sh [OLD_REV]
#   OLD_REV 可选，覆盖上面的自动挑选。

set -euo pipefail

SRC="app/src/main/java/com/hubmobile/app/JsBridge.java"

# 基线：默认找到「宽限期改动」之前的最后一版；传参则按传的来
# 注意：SRC 必须在这上面赋值，pick_baseline() 里要用它。
pick_baseline() {
  local rev body
  for rev in $(git log --format=%H -- "$SRC"); do
    # 注意别写成 git show ... | grep -q：grep -q 一命中就关管道，
    # git show 会被 SIGPIPE 打死，再配上 set -o pipefail，
    # 整条管道就算「失败」，第一条提交会被误当成基线。
    body="$(git show "$rev:$SRC" 2>/dev/null || true)"
    case "$body" in
      *firstDataAt*) ;;
      *) echo "$rev"; return ;;
    esac
  done
  echo "HEAD"
}
OLD_REV="${1:-$(pick_baseline)}"
AJ="${ANDROID_HOME:-/opt/android-sdk}/platforms/android-34/android.jar"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

if [ ! -f "$AJ" ]; then
  echo "找不到 android.jar：$AJ（可以 export ANDROID_HOME=... 指定）" >&2
  exit 1
fi

echo "== 取出改动前的源码树（$OLD_REV）=="
mkdir -p "$WORK/oldsrc"
git archive "$OLD_REV" app/src/main/java | tar -x -C "$WORK/oldsrc"

echo "== 编译两版 JsBridge =="
# BuildConfig 是 Gradle 生成的，本地补一个占位（与下载判定无关）；
# DEBUG_BUILD 是 githup 公开库里 SignCheck 用到的，一并写上。
mkdir -p "$WORK/stub/com/hubmobile/app"
cat > "$WORK/stub/com/hubmobile/app/BuildConfig.java" <<'EOF'
package com.hubmobile.app;
public final class BuildConfig {
    public static final boolean DEBUG = false;
    public static final boolean DEBUG_BUILD = false;
    public static final String APPLICATION_ID = "com.hubmobile.app";
    public static final String BUILD_TYPE = "release";
    public static final String VERSION_NAME = "1.1.5";
    public static final int VERSION_CODE = 1001005;
}
EOF

echo "== 编译当前（改后）版本 =="
javac -nowarn -encoding UTF-8 -cp "$AJ" -d "$WORK/new" \
      -sourcepath app/src/main/java \
      "$WORK/stub/com/hubmobile/app/BuildConfig.java" "$SRC"

# 旧源码要连根
javac -nowarn -encoding UTF-8 -cp "$AJ" -d "$WORK/oldcls" \
      -sourcepath "$WORK/oldsrc/app/src/main/java" \
      "$WORK/stub/com/hubmobile/app/BuildConfig.java" \
      "$WORK/oldsrc/$SRC"

echo "== 运行对照 =="
javac -nowarn -encoding UTF-8 -cp "$AJ" -d "$WORK/sim" tools/SwitchSim.java
java -Dfile.encoding=UTF-8 -cp "$WORK/sim" SwitchSim "$WORK/new" "$WORK/oldcls" "$AJ"
