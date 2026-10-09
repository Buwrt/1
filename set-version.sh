#!/usr/bin/env bash
# 一键改版本号
#
# 用法：
#   bash set-version.sh 1.1.4
#   bash set-version.sh 1.1.4 1001006        # 内部号显式指定（回退版本时必须）
#
# 以前改版本号要人肉走四步，漏一步就出事故：
#   1. 改 version.lock
#   2. 改 app/build.gradle（versionName / versionCode）
#   3. 重跑 tools/gen-guard.py（防护链常量要跟着变）
#   4. 更新 version.json
# 第 3 步漏掉最要命：包内版本是 1.1.4、防护链常量还写着 1.1.3，
# 启动就被官方校验拦下（「版本号被改成了 1.1.4」）—— 1.1.4 那次就是这么炸的。
#
# 这个脚本把四步一次做完，并且**当场自检**：改完立刻把五处值拉出来对一遍，
# 任何一处不一致就红字报错、非零退出，绝不给你一个「看着改完了其实漏了」的状态。
#
# 为什么允许它改 version.lock（锁不是防这个的吗）：
#   锁防的是「顺手改」「脚本误传参」，防不住也不该防「我明确要发新版」。
#   改版本号的入口收敛到这里一处，本身就是那把锁。
set -e

ROOT="$(cd "$(dirname "$0")" && pwd)"
[ -f "$ROOT/app/build.gradle" ] || { echo "找不到 app/build.gradle（请在仓库根目录运行）"; exit 1; }

VER="$1"
CODE_ARG="$2"

if [ -z "$VER" ]; then
  echo "用法: bash set-version.sh <版本号> [versionCode]"
  echo "  bash set-version.sh 1.1.4           内部号按版本号换算 -> 1001004"
  echo "  bash set-version.sh 1.1.4 1001006   内部号显式指定（版本号往回调时必须）"
  exit 1
fi

# 版本号格式：三段数字 x.y.z，或代号 Vn
if ! echo "$VER" | grep -qE '^([0-9]+\.[0-9]+\.[0-9]+|[Vv][0-9]+)$'; then
  echo "版本号格式不对：要像 1.1.4（三段数字）或 V4 这样" >&2
  exit 1
fi

BASE_CODE=10203    # V 系列的基点，与 build-apk.sh 保持一致

code_of() {
  local v="$1"
  if echo "$v" | grep -qE '^[Vv][0-9]+$'; then
    echo $((BASE_CODE + $(echo "$v" | tr -d 'Vv')))
  else
    local maj min pat
    maj=$(echo "$v" | cut -d. -f1)
    min=$(echo "$v" | cut -d. -f2)
    pat=$(echo "$v" | cut -d. -f3)
    echo $((maj * 1000000 + min * 1000 + pat))
  fi
}

CODE="$CODE_ARG"
[ -n "$CODE" ] || CODE=$(code_of "$VER")

GRADLE="$ROOT/app/build.gradle"
LOCK="$ROOT/version.lock"
API_JS="$ROOT/app/src/main/assets/web/js/api.js"
VJSON="$ROOT/version.json"
GUARD_PY="$ROOT/tools/gen-guard.py"
GUARD_KEYS="$ROOT/app/src/main/java/com/hubmobile/app/GuardKeys.java"

# 当前锁里的值（用于提示「内部号不能倒退」）
old_code() { grep -E '^versionCode=' "$LOCK" 2>/dev/null | cut -d= -f2 | tr -d ' \r'; }
old_ver()  { grep -E '^version='     "$LOCK" 2>/dev/null | cut -d= -f2 | tr -d ' \r'; }
OLD_CODE="$(old_code)"
OLD_VER="$(old_ver)"

echo "目标版本: $VER（versionCode $CODE）"
[ -n "$OLD_VER" ] && echo "当前版本: $OLD_VER（versionCode $OLD_CODE）"

# ---- 内部号倒退提醒 ----
# Android 只许 versionCode 变大。往回调版本号（1.1.4 作废、回到 1.1.3）时
# 换算出来的内部号会更小 —— 那样手机不给覆盖安装。这种情况必须显式给更大的号。
if [ -n "$OLD_CODE" ] && [ "$CODE" -lt "$OLD_CODE" ]; then
  echo
  echo "  ⚠️  内部号从 $OLD_CODE 降到 $CODE，Android 会拒绝覆盖安装"
  echo "     建议：bash set-version.sh $VER $((OLD_CODE + 1))"
  echo "     （对外仍显示 $VER，内部号继续涨 —— 这两者允许不联动）"
  echo
fi

# ---------- 1. version.lock ----------
if [ -f "$LOCK" ]; then
  sed -i -E "s/^version=.*/version=$VER/" "$LOCK"
  sed -i -E "s/^versionCode=.*/versionCode=$CODE/" "$LOCK"
else
  cat > "$LOCK" <<EOF
# 版本锁定文件 —— 版本号由这里钉死，别处改不动
version=$VER
versionCode=$CODE
EOF
fi
echo "[1/4] version.lock        -> version=$VER versionCode=$CODE"

# ---------- 2. app/build.gradle ----------
sed -i -E "s/versionCode [0-9]+/versionCode $CODE/" "$GRADLE"
sed -i -E "s/versionName '[^']*'/versionName '$VER'/" "$GRADLE"
echo "[2/4] app/build.gradle    -> versionName '$VER' versionCode $CODE"

# 前端常量（App 里「关于/版本号」显示的就是它）
if [ -f "$API_JS" ]; then
  sed -i -E "s/APP_VERSION: '[^']*'/APP_VERSION: '$VER'/" "$API_JS"
  echo "      前端 APP_VERSION    -> '$VER'"
fi

# ---------- 3. 重跑防护链 ----------
# 这一步就是当年漏掉的那一步。GuardKeys 里的版本号是从 build.gradle 读的，
# 必须在改完 build.gradle 之后跑，否则烙进包里的还是旧版本号。
if [ -f "$GUARD_PY" ]; then
  python3 "$GUARD_PY" "$ROOT" >/dev/null || {
    echo "防护链常量生成失败（检查 keystore/ 在不在）" >&2; exit 1;
  }
  echo "[3/4] 防护链已重跑         GuardKeys 同步到 $VER"
else
  echo "[3/4] 本库没有防护链（未加固版本），跳过"
fi

# ---------- 4. version.json ----------
# size / sha256 要等打完包才知道，这里只更新版本相关的字段。
if [ -f "$VJSON" ]; then
  python3 - "$VJSON" "$VER" <<'PY'
import json, sys
path, ver = sys.argv[1], sys.argv[2]
d = {}
try:
    d = json.load(open(path, encoding='utf-8'))
except Exception:
    pass
d['version'] = ver
d['name'] = 'githup v' + ver
import datetime
d['published'] = datetime.date.today().isoformat()
# 旧指纹留着没意义（包还没打），清掉，避免更新检测拿旧哈希比对新包
d.pop('sha256', None)
d.pop('size', None)
json.dump(d, open(path, 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
open(path, 'a', encoding='utf-8').write('\n')
PY
  echo "[4/4] version.json        -> version=$VER（size/sha256 打包后回填）"
else
  echo "[4/4] 没有 version.json，跳过"
fi

# ---------- 自检 ----------
# 五处值拉出来对一遍。这一步不能省 —— 它就是把当年那次事故变成一条红字的开关。
echo
echo "自检："
fail=0
chk() {   # chk <说明> <期望> <实际>
  if [ "$2" = "$3" ]; then
    printf "  ✅ %-22s %s\n" "$1" "$3"
  else
    printf "  ❌ %-22s 期望 %s，实际 %s\n" "$1" "$2" "$3"
    fail=1
  fi
}

chk "version.lock"  "$VER"  "$(old_ver)"
chk "build.gradle"  "$VER"  "$(grep -oE "versionName '[^']+'" "$GRADLE" | head -1 | sed "s/versionName '//;s/'//")"
chk "version.json"  "$VER"  "$(python3 -c "import json;print(json.load(open('$VJSON',encoding='utf-8'))['version'])" 2>/dev/null || echo '')"

if [ -f "$API_JS" ]; then
  chk "前端 APP_VERSION" "$VER" "$(grep -oE "APP_VERSION: '[^']*'" "$API_JS" | head -1 | sed "s/APP_VERSION: '//;s/'//")"
fi

if [ -f "$GUARD_KEYS" ]; then
  gv=$(grep -oE 'VERSION_NAME = "[^"]*"' "$GUARD_KEYS" | head -1 | sed 's/.*= "//;s/"//')
  gc=$(grep -oE 'VERSION_CODE = [0-9]+' "$GUARD_KEYS" | head -1 | grep -oE '[0-9]+')
  chk "防护链 VERSION_NAME" "$VER"  "$gv"
  chk "防护链 VERSION_CODE" "$CODE" "$gc"
fi

echo
if [ "$fail" -ne 0 ]; then
  echo "❌ 有项目没同步上，别打包 —— 修好再跑一次" >&2
  exit 1
fi
echo "✅ 版本号已整体切到 $VER，四步全部完成"
echo "   下一步：bash build-apk.sh   （打包；size/sha256 会回填进 version.json）"
