#!/usr/bin/env bash
# githup 一键打包脚本
#
# 用法：
#   bash build-apk.sh              用 build.gradle 里现有的版本打包
#   bash build-apk.sh 1.1.1        三段式：文件名 githup-v1.1.1.apk，版本 1.1.1
#   bash build-apk.sh V4           代号式：文件名 githup-V4.apk，版本 V4
#   bash build-apk.sh V4 1.1.1     文件名用代号、内部版本另填（本次 V4 就是这么来的）
#   bash build-apk.sh V6 1.1.1 1001003
#                                  第三个参数显式指定 versionCode。版本号需要往回
#                                  调时（如从 1.1.2 回到 1.1.1）必须用它：versionCode
#                                  只许变大不许变小，否则手机拒绝覆盖安装。Android
#                                  允许 versionName 与 versionCode 不联动，所以
#                                  「对外显示 1.1.1 + 内部号 1001003」完全合法。
#
# 版本号的规矩（x.y.z）：
#   第一位 —— 变大就强制更新（客户端会弹不可关闭的更新提示）
#   第二位 —— 功能更新，可更可不更
#   第三位 —— 修复更新，可更可不更
#
# 版本号是用户说了算：说改才改，说不改就不改。脚本不替你做任何自动递增。
#
# 想让「版本号不变但内容更新」也能被检测到，别改版本号 —— 客户端会
# 比对安装包的 SHA-256，内容变了照样提示更新。详见 README 的更新机制。
#
# versionCode 的换算规则：
#   三段式 x.y.z  ->  x*1000000 + y*1000 + z     例：1.1.1 -> 1001001
#   代号式 Vn     ->  10203 + n                  例：V3    -> 10206
#
# 打包完成后，工作区里旧的 githup-*.apk 会被清掉，只留最新这一个，
# 免得出现一堆名字相近的文件分不清哪个是新的。
set -e

ROOT="$(cd "$(dirname "$0")" && pwd)"
PRJ="$ROOT"
# 脚本在仓库根目录、还是在工作区上一层，都要能找到项目
[ -f "$PRJ/app/build.gradle" ] || PRJ="$ROOT/github-mobile"
[ -f "$PRJ/app/build.gradle" ] || { echo "找不到项目目录（期望 $ROOT 或 $ROOT/github-mobile 下有 app/build.gradle）"; exit 1; }
GRADLE_CFG="$PRJ/app/build.gradle"
API_JS="$PRJ/app/src/main/assets/web/js/api.js"
OUT="$ROOT"

export ANDROID_HOME=/opt/android-sdk
export ANDROID_SDK_ROOT=/opt/android-sdk
GRADLE=/opt/gradle-8.2/bin/gradle

CODE_ARG="$1"      # 决定文件名的代号（没给第二个参数时，它同时也是版本号）
VER="$2"           # 可选：内部版本号，缺省就用代号
CODE_NUM="$3"      # 可选：显式 versionCode，缺省按版本号换算

BASE_CODE=10203    # V 系列的基点

# ---- 版本锁 ----
# 版本号由 version.lock 钉死。传进来的版本号和锁不一致就拒绝打包，
# 免得顺手一个 `bash build-apk.sh 1.1.4` 又做出一个装不上 / 被校验拦下的包。
# 真要发新版：改 version.lock，并同步改 app/build.gradle、重跑 tools/gen-guard.py。
# 紧急情况可以 ALLOW_VERSION_CHANGE=1 临时解锁，但那属于明知故犯，别常态化。
LOCK_FILE="$ROOT/version.lock"
lock_get() { grep -E "^$1=" "$LOCK_FILE" 2>/dev/null | cut -d= -f2- | tr -d ' \r'; }
LOCK_V="$(lock_get version)"
LOCK_C="$(lock_get versionCode)"

# 1. 算出 versionCode
code_of() {
  local v="$1"
  if echo "$v" | grep -qE '^[Vv][0-9]+$'; then
    echo $((BASE_CODE + $(echo "$v" | tr -d 'Vv')))
  elif echo "$v" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+$'; then
    local maj min pat
    maj=$(echo "$v" | cut -d. -f1)
    min=$(echo "$v" | cut -d. -f2)
    pat=$(echo "$v" | cut -d. -f3)
    echo $((maj * 1000000 + min * 1000 + pat))
  else
    echo "版本号格式不对：要像 1.1.1（三段数字）或 V4 这样" >&2; exit 1
  fi
}

if [ -n "$CODE_ARG" ]; then
  [ -n "$VER" ] || VER="$CODE_ARG"

  # 版本锁：和 version.lock 对不上就直接拒绝
  if [ -n "$LOCK_V" ] && [ "$ALLOW_VERSION_CHANGE" != "1" ] && [ "$VER" != "$LOCK_V" ]; then
    echo "版本号已锁定，不接受 '$VER'" >&2
    echo "  version.lock 里锁的是：$LOCK_V（versionCode $LOCK_C）" >&2
    echo "  确需发新版：改 version.lock -> 改 app/build.gradle -> 重跑 tools/gen-guard.py" >&2
    exit 1
  fi

  if echo "$CODE_NUM" | grep -qE '^[0-9]+$'; then
    CODE="$CODE_NUM"
    echo "版本: $VER（versionCode 显式指定为 $CODE）"
  else
    CODE=$(code_of "$VER")
    echo "版本: $VER（versionCode $CODE）"
  fi
  # 显式给了 versionCode 也要和锁对得上
  if [ -n "$LOCK_C" ] && [ "$ALLOW_VERSION_CHANGE" != "1" ] && [ "$CODE" != "$LOCK_C" ]; then
    echo "versionCode 已锁定，不接受 '$CODE'" >&2
    echo "  version.lock 里锁的是：$LOCK_C（versionName $LOCK_V）" >&2
    exit 1
  fi

  sed -i -E "s/versionCode [0-9]+/versionCode $CODE/" "$GRADLE_CFG"
  sed -i -E "s/versionName '[^']*'/versionName '$VER'/" "$GRADLE_CFG"
  sed -i -E "s/APP_VERSION: '[^']*'/APP_VERSION: '$VER'/" "$API_JS"
  echo "版本已改为 $VER（versionCode $CODE）"
fi

# 2. 读回版本；文件名由第一个参数（代号）决定
BUILD_VER=$(grep -oE "versionName '[^']+'" "$GRADLE_CFG" | head -1 | sed "s/versionName '//;s/'//")
[ -n "$BUILD_VER" ] || { echo "读不到 versionName"; exit 1; }
[ -n "$VER" ] || VER="$BUILD_VER"

# 代号本身带 V 就不重复加小写 v：V4 -> githup-V4.apk，1.1.1 -> githup-v1.1.1.apk
if echo "$CODE_ARG" | grep -qE '^[Vv]'; then NAME="githup-$CODE_ARG.apk"
elif echo "$VER" | grep -qE '^[Vv]'; then NAME="githup-$VER.apk"
else NAME="githup-v$VER.apk"; fi
echo "文件名: $NAME（包内版本 $VER）"

# 3. 生成源码指纹（必须在防护链**之前**跑，顺序不能反过来）
#
#     「这个包对应哪份源码」—— 版本号一样的两个包靠版本号分不出来，
#     靠这个能。写在构建前，是因为指纹要算进包里；api.js 自身被排除在计算外，
#     否则就成了自己算自己。
#
#     ⚠️ 它必须排在 gen-guard.py 前面：
#     gen-srcfingerprint.py 会**改写 api.js 里的 SRC_SHA256**，而 gen-guard.py
#     生成的 assets.sha 记的是「前端文件此刻的哈希」。先跑 guard 的话，
#     清单里烙的是改写**之前**那份 api.js —— 指纹一回填，文件哈希就变了，
#     第 3 环校验当场不通过，装上去直接被拦。**顺序反了必炸**。
#
#     同样按「文件在不在」决定跑不跑，两个库共用一份脚本。
if [ -f "$PRJ/tools/gen-srcfingerprint.py" ]; then
    python3 "$PRJ/tools/gen-srcfingerprint.py" "$PRJ" || { echo "源码指纹生成失败"; exit 1; }
fi

# 3b. 生成防护链常量（必须在构建前跑：它要把前端文件此刻的哈希清单写进 assets）
#     用签名密钥的私钥给防护链签名 —— 没有私钥的人改不动这些常量。
#     放在上一步之后：此时 api.js 已经是填好指纹的最终版本，
#     清单与包里的文件才能对得上。
#
#     未加固的那个库里没有 tools/gen-guard.py，也没有防护链，跳过即可：
#     同一份脚本在两个库里都能跑，区别由「文件在不在」自己决定。
if [ -f "$PRJ/tools/gen-guard.py" ]; then
    python3 "$PRJ/tools/gen-guard.py" "$PRJ" || { echo "防护链常量生成失败（检查 keystore/ 在不在）"; exit 1; }
else
    echo "本库没有防护链（未加固版本），跳过常量生成"
fi

# 4. 构建
cd "$PRJ"
"$GRADLE" assembleRelease --console=plain -q

# 5. 输出到工作区，并清掉旧的包，只留最新这一个
SRC="$PRJ/app/build/outputs/apk/release/app-release.apk"
[ -f "$SRC" ] || { echo "没找到构建产物"; exit 1; }
rm -f "$OUT"/githup-[vV]*.apk   # 大小写都清
cp -f "$SRC" "$OUT/$NAME"

echo
echo "完成: $OUT/$NAME"
ls -l "$OUT/$NAME"
sha256sum "$OUT/$NAME"

# 6. 把这一包的 size / sha256 回填进 version.json
#
#    更新检测是拿清单里的指纹跟「设备上已装包的哈希」比的。包换了、清单没换，
#    用户就会被反复提示更新（或者反过来，永远提示不了）。以前这一步靠人记，
#    现在打包顺手做掉 —— 指纹永远跟着包走。
#
#    直链文件名用不带 v 的（githup-1.1.3.apk），与 Release 附件名保持一致，
#    免得清单指到一个 404 的地址。
VJSON="$ROOT/version.json"
if [ -f "$VJSON" ]; then
  python3 - "$VJSON" "$OUT/$NAME" "$VER" "$ROOT/app/src/main/assets/web/js/api.js" <<'PY'
import json, sys, os, hashlib, datetime, re
path, apk_path, ver, api_js = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
d = {}
try:
    d = json.load(open(path, encoding='utf-8'))
except Exception:
    pass
data = open(apk_path, 'rb').read()
d.update({
    'version': ver,
    'name': 'githup v' + ver,
    'published': datetime.date.today().isoformat(),
    'size': len(data),
    'sha256': hashlib.sha256(data).hexdigest(),
    # 文件名必须带 v（githup-v1.2.14.apk）—— 附件就是这么上传的，
    # 少了这个 v 是 404。以前这里写成 githup-%s.apk，每次打包都把
    # 上一版手工修好的直链覆盖回错的那个，用户点「检查更新」拿到死链。
    'apk': 'https://github.com/Buwrt/githup/releases/download/v%s/githup-v%s.apk' % (ver, ver),
})
# src_sha256 也必须跟着包走 —— 只回填 size/sha256 而漏掉它，会出一个
# 「版本号变了、源码指纹还写着上一个包」的 version.json：App 比对时发现
# 指纹对不上，第 3 环校验不通过，装上去直接被自己拦下。
# 这个值由 gen-srcfingerprint 写进 api.js，从那里读回来最可靠。
try:
    m = re.search(r"SRC_SHA256\s*:\s*'([0-9a-f]{64})'", open(api_js, encoding='utf-8').read())
    if m:
        d['src_sha256'] = m.group(1)
except Exception:
    pass
with open(path, 'w', encoding='utf-8') as f:
    json.dump(d, f, ensure_ascii=False, indent=2)
    f.write('\n')
print('version.json 已回填: version=%s size=%d' % (ver, d['size']))
print('  sha256=%s' % d['sha256'])
print('  src_sha256=%s' % d.get('src_sha256', '(未取到)'))
PY
fi
