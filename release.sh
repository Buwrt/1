#!/usr/bin/env bash
# githup 发版脚本 —— 一条命令走完发版全过程
#
# 用法：
#   bash release.sh 1.1.4 "修了 issue 列表偶尔不刷新的问题"
#   bash release.sh 1.1.4 "支持 xxx" 1001006   # 内部号显式指定（版本回退时必须）
#
# 它会按顺序做完这些事：
#   1. 改版本号 —— 交给 set-version.sh：version.lock / build.gradle /
#      前端常量 / 防护链常量 / version.json 一处不落，改完当场自检
#   2. 打包 APK（并顺手把 size/sha256 回填进 version.json）
#   3. 把 APK 放进 apk/ 目录
#   4. 提交并推送 main
#   5. 打 tag v<版本> 并推送
#
# 第 5 步会触发 .github/workflows/publish-release.yml：
# 由 Actions 用仓库自己的 GITHUB_TOKEN 创建 Release 并上传 APK 附件。
#
# 为什么不直接用 API 发 Release：
#   外部令牌通常只有仓库的读/拉取权限，调 REST 的 Release 写接口会 403，
#   但 git 推送仓库内容是允许的。于是把「写 Release」这件事交给仓库自己的
#   Actions 去做 —— 它的令牌天然有 contents:write，不需要额外授权。
#
# 关于版本号：别再手动去改 build.gradle 了。版本号统一由 set-version.sh
# 切换（本脚本第 1 步就是调它），它会自动重跑防护链 —— 漏掉那一步，
# 做出来的包一启动就会被官方校验拦下（1.1.4 那次事故）。
set -e

ROOT="$(cd "$(dirname "$0")" && pwd)"
PRJ="$ROOT"
[ -f "$PRJ/app/build.gradle" ] || PRJ="$ROOT/github-mobile"
[ -f "$PRJ/app/build.gradle" ] || { echo "找不到项目目录（期望 $ROOT 或 $ROOT/github-mobile 下有 app/build.gradle）"; exit 1; }

VER="$1"
NOTES="$2"
CODE="$3"

[ -n "$VER" ] || { echo "用法: bash release.sh <版本号> [更新说明] [versionCode]"; exit 1; }

# ---------- 1. 改版本号（含防护链重跑 + 自检） ----------
# 这一步是全脚本的关键：改版本由一个脚本统一负责，不存在「忘了第 3 步」的可能。
bash "$ROOT/set-version.sh" "$VER" "$CODE"

# ---------- 2. 打包 ----------
# 版本号已经和锁一致了，build-apk.sh 不会被拦；它打完包会回填 version.json。
bash "$ROOT/build-apk.sh" "$VER" "$VER" ${CODE:+$CODE}

APK_SRC="$(ls -t "$ROOT"/githup-[vV]*.apk 2>/dev/null | head -1)"
[ -f "$APK_SRC" ] || { echo "没找到打包产物"; exit 1; }
echo
echo "打包产物: $APK_SRC"

# APK 也放一份到 apk/ 目录（历史习惯，方便直接从仓库取）
mkdir -p "$PRJ/apk"
rm -f "$PRJ"/apk/*.apk
cp -f "$APK_SRC" "$PRJ/apk/"
echo "APK 已同步到 apk/ 目录: $(basename "$APK_SRC")"

# ---------- 3. 提交 ----------
cd "$PRJ"
git add -A
MSG="发布 v$VER"
[ -n "$NOTES" ] && MSG="$MSG：$NOTES"
if git diff --cached --quiet; then
  echo "没有需要提交的改动"
else
  git -c user.name=aeroheaven -c user.email=aeroheaven@users.noreply.github.com \
      commit -q -m "$MSG"
  git push origin main
  echo "已推送 main"
fi

# ---------- 4. tag ----------
git tag -f -a "v$VER" -m "githup v$VER" 2>/dev/null || \
git -c user.name=aeroheaven -c user.email=aeroheaven@users.noreply.github.com \
    tag -f -a "v$VER" -m "githup v$VER"
GIT_TERMINAL_PROMPT=0 git push -f origin "v$VER"
echo
echo "tag v$VER 已推送，Actions 会自动创建 Release 并上传 APK"
echo "稍后可在这里查看：https://github.com/Buwrt/githup/releases"
