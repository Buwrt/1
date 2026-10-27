# githup · 应用库版

轻量 Android 第三方 GitHub 客户端，附加一个 **应用库（App Library）** 模块：
把本机应用与 GitHub 仓库/Release 关联起来，跟踪更新、一键下载安装。

- 上游：`Buwrt/githup`
- 本仓库存的是**改好的完整源码**与构建产物
- APK：`githup-v1.2.16-library.apk`（官方签名，可直接覆盖安装）

---

## 一、加了这个功能

### 应用库（入口：我的 → 应用库）

| 能力 | 说明 |
|---|---|
| 台账 | 把「包名 ↔ owner/repo ↔ Release」持久化在本地 SQLite |
| 三段分组 | 待安装 / 有更新 / 已是最新，段头可折叠 |
| 组卡 | 同一仓库下的多个应用合并成一张卡片 |
| 更新检查 | 存储匹配优先，省 GitHub 配额 |
| 一键更新 | 自动挑合适架构的 APK，下载后拉起系统安装器 |
| 卸载 | 确认弹层 → 系统卸载界面 → 自动对账清行 |
| 单项设置 | 钉住变体 / asset 正则 / 忽略更新 / 跳过此版 / 收预发布 |
| 待安装停放 | 下载完没装上，行停在这，可重新装或丢弃 |
| 导入导出 | 支持复制清单到剪贴板 |

### 自动关联

在 githup 里下载安装 APK 会自动进应用库，不用手填 `owner/repo`：

- Release 详情页点 `.apk` 附件
- Actions 构建产物（解压出 APK 后安装）
- 应用库里点「更新」

来源**钉在下载按钮上**（`data-repo`），不是全局变量 —— 所以不会出现
「装了 B 的软件却绑成 A 的仓库」这种串味。入账用的是实际 APK 里读出的
包名，不是文件名猜的。

### 更新提示

- 底部「我的」标签：红底数字角标
- 「我的」页「应用库」行：同样的数字
- 刷新时机：启动 / 切回前台 / 每 30 分钟；先按本地台账秒画，再静默查一轮

### 下载历史核对

本地文件在文件管理器里被删了，下载管理里的记录会跟着清掉。
「历史记录」标题栏新增「核对本地文件」按钮，可手动当场核一次。

---

## 二、改了哪些文件

| 文件 | 改动 |
|---|---|
| `app/src/main/java/com/hubmobile/app/AppLibrary.java` | **新增**。SQLite 台账、系统包查询、对账、自动入账 |
| `app/src/main/assets/web/js/page-library.js` | **新增**。应用库页面 |
| `app/src/main/java/com/hubmobile/app/JsBridge.java` | 追加 `lib*` / `installApkTracked` / `pruneDownloadHistory` 等桥接方法；安装前入账；下载历史核对 |
| `app/src/main/assets/web/js/page-detail.js` | Release 附件、Actions 产物走 tracked 安装（来源钉在按钮上） |
| `app/src/main/assets/web/js/page-downloads.js` | 加「核对本地文件」按钮 |
| `app/src/main/assets/web/js/page-user.js` | 「我的」页加应用库入口 + 角标 |
| `app/src/main/assets/web/js/app.js` | 路由白名单加 `library`；底栏角标方法与刷新时机 |
| `app/src/main/assets/web/index.html` | 引入 `page-library.js`；「我的」tab 加角标元素 |
| `app/src/main/AndroidManifest.xml` | 加 `REQUEST_DELETE_PACKAGES`（卸载必需） |

---

## 三、怎么构建

```bash
unzip githup-source.zip
cd githup
bash build-apk.sh
```

⚠️ 顺序不能乱：`build-apk.sh` 内部按
`gen-srcfingerprint.py → gen-guard.py → gradlew` 排列。
反过来 `assets.sha` 烙的是改写前的 `api.js`，装上直接被防护链第 3 环拦下。

签名密钥**不在仓库里**，构建前放到 `keystore/` 或配好环境变量。

---

## 四、几个已知的坑

1. **`REQUEST_DELETE_PACKAGES` 必须声明** —— targetSdk ≥ 28 起用
   `ACTION_DELETE` 缺了它，系统**静默忽略**，不抛异常也不弹窗。
   部分 ROM 还会拦，已做「应用信息页」兜底。

2. **别提前置 pending** —— 点了更新就标「待安装」，用户在系统安装器上
   点取消，行会永远卡住、角标也消失。真正的时机是「下完、拉起安装器之前」。

3. **比较基准要取系统真值** —— `installed_vname` 优先于 `installed_tag`。
   早期版本把最新 tag 写进了 `installed_tag`，会让「有更新」被算成「已是最新」。

4. **历史核对的安全网要有下限** —— 记录少于 3 条时不启用「全军覆没」
   保护，否则只有 1 条且用户删了文件，会被当成查询失效而跳过剔除。
