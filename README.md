# TOTP 两步验证器（通知倒计时版）

Android 端两步验证器，针对 GitHub TOTP。通知栏常驻显示 **6 位验证码 + 30 秒倒计时**，到期自动刷新。

## 修复的问题
通知中曾出现**两排相同数字**（`GitHub 794 407` 出现两次），原因与修复：

| 原因 | 修复 |
|---|---|
| 每次发送用了不同通知 ID / Tag，系统并排展示 | 固定 `NOTIFICATION_ID = 1001`，新通知覆盖旧通知 |
| 同一账号重复触发发送 | 前台服务单例 + 去重，不再重复 notify |
| 每次刷新都响铃/震动 | `setOnlyAlertOnce(true)` |

## TOTP 参数（与 GitHub 一致）
- 算法：HMAC-SHA1
- 位数：6 位
- 周期：30 秒
- Base32 密钥解码后参与 HMAC 运算（RFC 6238）

## 目录
```
app/src/main/java/com/example/totp/
├── TOTPService.java   前台服务：TOTP 计算 + CountDownTimer 每秒刷新 + 通知倒计时
├── Prefs.java         密钥存储（SharedPreferences，可换 AndroidKeyStore）
└── MainActivity.java  界面：输入密钥 / 启动停止服务 / 实时显示验证码与倒计时
.github/workflows/build-apk.yml   云端编译 → APK 回传仓库 → 自动发布 Release
apk/totp-verifier-debug.apk       编译产物（含 .sha256 校验值）
```

## 下载安装
- 最新版 APK：Releases → `totp-verifier-debug.apk`
- 仓库内直取：`apk/totp-verifier-debug.apk`
- 最低系统：Android 7.0（API 24）

## 使用
1. 安装 APK，授予通知权限
2. 打开 App，粘贴 GitHub 两步验证的 Base32 密钥（GitHub → Settings → Password and authentication → 恢复/密钥）
3. 点「启动通知」，通知栏即显示 `验证码 · 剩余秒数`
4. 需要停止时点「停止」

## 云端编译
推送到 `main` 分支后，Actions 自动：
1. 准备 Android SDK + JDK 17 + Gradle 8.2
2. `gradle :app:assembleDebug` 编译
3. 把 APK 提交回仓库 `apk/` 目录
4. 发布 / 更新 Release 附件

## 安全提示
- 密钥当前存于 SharedPreferences，生产环境建议改存 `AndroidKeyStore` + AES（参考 githup 的 `SecurePrefs`）
- 通知内容含验证码，建议按需加生物识别锁、禁止截图、自动清除剪贴板
