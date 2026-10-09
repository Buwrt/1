# githup（官方基线 · 改动版）

本仓库是官方发布仓库 `Buwrt/githup-release` 应用改动后的完整源码。

**基线已切换**：此前基于公开库 `Buwrt/githup`，现改为官方发布仓库 `githup-release` ——
它自带官方签名配置（`app/build.gradle` 从 `keystore/` 读取），打包即通过签名校验。

---

## 本次改了什么

| # | 问题 | 改法 |
|---|---|---|
| 1 | 通知栏两步验证出现**两排一模一样的动态码** | 去重 + 第一个账户只进标题行，不再重复进展开列表 |
| 2 | 常驻通知只有一句「还剩 N 秒」，看不出倒计时 | 加 30 秒倒计时：系统进度条 / 剩余秒数 / 方块进度条 |
| 3 | **编辑账户后多出一条** | 编辑改为按 id 原地替换（原为追加，所以条目 +1） |
| 4 | 改名后判重失效 | 判重指纹改成「密钥 + 算法参数」，改名绕不过去重 |
| 5 | 议题数 = 真实议题 + PR；拉取请求栏没数 | 议题数 = 总数 − PR 数；PR 数单独取并补上计数 |
| 6 | **下载完一个 APK 再下另一个，上一个被覆盖** | 落盘前先让开重名（自动改名 `xxx-2.apk`） |
| 7 | 给作者仓库点过 Star 后，仓库发新版想要通知 | 新增 `RepoWatchService`，在**系统通知栏**提醒（非 App 内弹层） |

详见 `修改说明.md`。

### 第 7 项：Star 后仓库更新提醒

用户给 `Buwrt/githup` 点过 Star → 该仓库发布新版本 → **手机系统通知栏**弹出提醒，
点进去直达仓库页面。

三道不打扰的闸：没登录不检查 / 没点 Star 不发 / 同一版本只通知一次。
第一次运行只记下当前版本、不发通知（避免刚装上就被旧版本通知砸中）。

通知渠道 `githup_repo_update` 为 `IMPORTANCE_DEFAULT`（**状态栏有图标、通知栏可见**），
但关闭了声音与振动；服务保命用的 `githup_watch_quiet` 才是 `IMPORTANCE_MIN`（完全无感）。

检查时机：App 回到前台时立刻查一次（最小间隔 10 分钟），之后每 30 分钟轮询；
开机后由 `BootReceiver` 恢复。

## 打包

```bash
# 用官方密钥（推荐，需本地有 keystore/）
bash build-apk.sh 1.2.15

# 或直接
./gradlew assembleRelease
```

**签名密钥不进仓库** —— `keystore/` 被 `.gitignore` 排除。
CI 里以加密的 Repository Secret（`KEYSTORE_B64` / `KEYSTORE_PASS`）在构建时还原，
见 `.github/workflows/official-release.yml`。
详见 `官方打包说明.md`。

## 文件导航

| 文件 | 内容 |
|---|---|
| `修改说明.md` | 六项修复的根因与改法 |
| `官方打包说明.md` | 官方密钥打包流程、Secret 配置、指纹核对 |
| `apk/` | 官方签名的 Release 安装包 |
| `ci/` | 云端构建日志 |

## 关于原仓库

- 公开源码库：https://github.com/Buwrt/githup
- 官方发布库：https://github.com/Buwrt/githup-release（私有，含签名配置）

本仓库基于后者，仅应用上述修复，其余结构与功能保持原样。
