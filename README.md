# githup（两步验证器改动版）

本仓库存放 **Buwrt/githup** 修改两步验证器后的完整源码。

改动内容见 `修改说明.md`，一句话概括：
**修掉通知栏「两排一模一样的动态码」，并给常驻通知加上 30 秒倒计时。**

## 改了哪些文件

| 文件 | 改动 |
|---|---|
| `app/src/main/java/com/hubmobile/app/TotpService.java` | 去重 + 倒计时（主要改动） |
| `app/src/main/java/com/hubmobile/app/Totp.java` | 新增 `normalizeSecret()` |
| `app/src/main/java/com/hubmobile/app/JsBridge.java` | `totpSync()` 写入缓存前去重复 |
| `app/src/main/assets/web/js/page-totp.js` | `load()` / `save()` 两端去重 |

## 编译

```bash
python3 tools/gen-guard.py      # 改过前端文件，必须重算防护链常量与资源清单
bash build-apk.sh 1.2.9         # 产物输出到上层目录
```

一键发版：

```bash
bash release.sh 1.2.9 "修复验证器重复码 + 通知倒计时"
```

要求 Android 7.0（API 24）及以上，JDK 17 + Android SDK。

## 关于原仓库

原项目：https://github.com/Buwrt/githup
轻量 Android 第三方 GitHub 客户端，WebView 前端 + 原生扩展，约 350 KB。
本仓库仅在其基础上修改两步验证器部分，其余功能与结构保持原样。
