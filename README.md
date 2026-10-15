# githup

Android 上的第三方 GitHub 客户端。名字里的 `hup` 是 **hub**，它是你装在口袋里的 GitHub。

技术实现上有点意思：**WebView 承载一套纯前端单页应用，原生层只干 Web 干不了的事** —— 网络请求绕过跨域、系统文件选择器、二进制上传、下载并拉起安装器。所以整套东西压缩到 **350 KB 上下**，却覆盖了浏览仓库、看 Issue / PR、查 Actions、发 Release、上传文件，甚至让 GitHub Actions 云端帮你打包 APK。

每个版本改了什么，记在 [CHANGELOG.md](CHANGELOG.md)（从 v1.1.3 开始）。

打开软件的瞬间，它会自动跟本仓库对比是不是最新版：**已是最新版时完全静默，一点反应都没有；有新版本才按版本号规则提醒。** 版本号不动也能发新版 —— 新包传上去、改一下校验值，用户在下次打开时就收到提示（比对的是安装包指纹，不只是版本号）。详细规则见[更新机制](https://github.com/Buwrt/githup#更新机制)。

> 本应用为个人学习用途的第三方客户端，与 GitHub, Inc. 无隶属关系。所有数据均通过 GitHub 官方公开 API 获取，访问令牌仅保存在你的设备本机。

| | |
|---|---|
| **下载** | [最新版 Releases](https://github.com/Buwrt/githup/releases/latest) |
| **更新日志** | [CHANGELOG.md](CHANGELOG.md) —— 从 v1.1.3 开始，每个版本改了什么 |
| **QQ 群** | [806894257](https://github.com/Buwrt/githup#交流与反馈) |
| **反馈** | [Issues](https://github.com/Buwrt/githup/issues) |
| **赞赏** | [请我喝杯咖啡](https://github.com/Buwrt/githup#赞赏支持) |

---

## 一句话了解它能干什么

| 场景 | githup 能做的 |
|---|---|
| 通勤路上要看代码 | 仓库文件树、README 渲染、代码高亮（浅色 / 深色两套高亮主题） |
| 有人 @ 我 | 通知列表、未读角标、一键全部标已读、批量操作 |
| Review PR | Issue / PR 列表筛选、详情、评论、合并状态、diff 高亮 |
| CI 挂了 | Actions 运行列表、日志、下载构建产物 ZIP 并自动解压出 APK 安装 |
| 发版本 | 创建 Release、上传附件（APK 等），或让 Actions 云端打包 APK |
| 摸鱼 | Trending 仓库榜，按日 / 周 / 月和语言筛选 |

---

## 功能一览

### 登录
- Personal Access Token 登录，页面里直接跳到带好权限的 Token 创建页，不用自己勾 scope
- Token 只存在设备本机（系统 Keystore 保护的 SharedPreferences），退出登录即从本机移除

### 首页 / 通知 / 探索 / 搜索
- **首页**：活动时间线、仓库快捷入口、"我的主页"
- **通知**：未读角标、全部标为已读、批量选择处理
- **探索**：Trending 仓库榜，可切换日 / 周 / 月，按编程语言过滤
- **搜索**：仓库、用户/组织的结果检索；**也可以直接粘贴一条 GitHub 链接**
  （`https://github.com/owner/repo`、`.../issues/123`、`.../releases/tag/v1.2.7` 等），
  会识别出目标并跳到 App 里对应的那一页；下载地址交给内置下载管理

### 个人主页
- 仓库 / Star / 关注者 / 正在关注 列表（带筛选与排序）
- 关注 / 取关、编辑个人资料、复制主页链接、在浏览器打开

### 仓库
- **关于区**：简介、Star / Watching / Fork、Releases、Packages、语言占比
- **代码浏览**：文件树逐级展开、README 自动渲染、代码高亮、图片预览、原始文件查看
- **Issue / PR**：打开/关闭筛选、标签、评论、创建与关闭
- **Actions**：工作流列表、单次运行详情、**构建产物直接下载并解压安装 APK**
- **Releases**：版本列表、资产下载
- **Commits / Contributors / Branches / Tags / Stargazers / Watchers / Forks**
- **仓库设置**：改简介、改可见性（公开 ⇄ 私有，带方向校准的二次确认）、归档 / 取消归档、删除仓库

### 写操作
- **新建仓库**：表单实时预览克隆地址，创建成功后弹出可复制的克隆链接
- **上传文件**：从设备任意目录选文件上传到仓库指定路径
- **创建 Release**：填版本号与说明，附带本地文件（APK 等）

### 云端打包 APK
- 「一键打包」向导：给任意 Android 仓库自动生成 `.github/workflows/build-apk.yml`
- **本机生成签名**：内置 `keytool` 的纯 Java 实现（`KeyTool.java`），口令 → keystore → Base64，**不需要电脑上装 JDK**
- 自动写入仓库 Secrets，触发工作流，构建完成后回到 App 下载产物并解压安装

### 设置
- 主题外观：跟随系统 / 浅色 / 深色
- 代码字号：12 / 13 / 15 / 17 px
- 启动页：默认打开哪个标签页
- API 配额：实时查看剩余次数与重置时间
- 清除缓存
- **检查更新**：手动检查是否有新版本，见下面的更新机制

### 翻译本页（1.1.3 新增）

网页上的 GitHub 能用浏览器扩展翻译，App 里的 WebView 装不了扩展 —— 所以把翻译做进了 App 自己：

- 右上角地球图标是**总开关**，默认关。打开后当前页翻成中文，**换页继续翻**，关掉即还原原文
- **滚动驱动**：只翻屏幕上下各 600px 范围内的英文段，滚到哪译到哪，屏幕外的内容不翻
- 引擎挂了自动换下一个；某几段没翻出来会隔 4 秒自动重翻，最多 5 轮
- 自动跳过代码、仓库名、用户名、`@某人`、版本号这类不该翻的内容
- 译文缓存在本机，同一段不会重复请求

全部免费、开箱即用，不用注册不用 Key，默认**自动探测**谁最快：

| 引擎 | 特点 |
|---|---|
| 有道 | 国内直连最稳的免费引擎，无需 Key |
| 设备端翻译 | 系统内置，**离线、不联网、文本不出设备**；需装中英语言包 |
| DeepL | 质量最佳，公共 IP 偶尔限流 |
| Google | 老牌免费接口，需海外网络 |
| MyMemory | 兜底，全球可达，匿名有日配额 |
| ~~微软 Edge~~ | **已停用**：微软关闭了公开令牌接口（`edge.microsoft.com/translate/auth` 现返回 404），实现保留但已移出探测链 |

完整说明（怎么换引擎、为什么这么翻、踩过哪些坑）见 [docs/翻译本页.md](docs/翻译本页.md)。

### 平板 / 大屏（1.1.3 新增）

- 不再锁死竖屏：平板横持、分屏、折叠屏展开都跟随系统旋转，转屏不重建 Activity（登录态、翻译开关、滚动位置都不丢）
- 宽屏下内容限宽居中（900px），底部标签栏不再被拉成 1280px 平分
- 横屏时左右避开刘海 / 挖孔

---

## 更新机制（1.1.1 起内置）

> **两条原则**：打开软件自动查，已是最新版就**一点反应都没有**；手动点「检查更新」时，
> 即使已是最新版也要给个回应 —— 但只给**底部一条小提示**，两三秒自己消失，
> 不弹框、不打断你正在做的事。只有真的有更新，才会弹需要你点一下的更新窗。

版本号遵循 `x.y.z`，每一位有明确含义，**更新策略由「从高位往下第一个出现差异的那一位」决定**：

| 变化位 | 例子 | 行为 |
|---|---|---|
| 第一位 x（大版本） | `1.1.1` → `2.0.0` | **强制更新**。弹层不可关闭：没有关闭按钮、点遮罩无效、返回键也无法绕过，必须更新才能继续用 |
| 第二位 y（功能） | `1.1.1` → `1.2.0` | **强制更新**，同上。带了新功能，不装不让用 |
| 第三位 z（修复） | `1.1.1` → `1.1.2` | **可选更新**。只修 bug、不影响使用，弹窗给「立即更新 / 稍后提醒 / 跳过此版」 |

**一句话：前两位变了就必须装，只有第三位变了才由你决定。**

**什么时候会打扰你**：

| 时机 | 有更新 | 已是最新 | 检查失败 |
|---|---|---|---|
| 打开软件（自动） | 弹更新窗（前两位变化 = 强制） | **完全静默，毫无反应** | 静默 |
| 手动点「检查更新」 | 弹更新窗 | 底部正中弹出一条小提示「**您已是最新版本**」+ 当前版本号，**两三秒自动消失** | 小提示说明原因 |

### 版本号一样、但包已经换了，也能发现

上面这套只看版本号。可如果你**不想动版本号**（比如一直是 `1.1.1`，只是重新打了包），
版本号比对就永远判「无更新」，用户拿不到新包。所以还有第二条信号：

> **安装包指纹**：本机 App 会算出自己这个 APK 的 SHA-256，跟 `version.json` 里记的 `sha256` 对比。
> 只要不一致，就说明「版本号没变，但其实是新的包」→ 弹可选更新，标题写「有新内容可用」。

| 情况 | 版本号 | 安装包指纹 | 行为 |
|---|---|---|---|
| 完全没变 | 一致 | 一致 | **静默，毫无反应** |
| 版本号变了 | 变大 | 忽略 | 按上面 `x.y.z` 规则处理（前两位 = 强制，只有第三位可选） |
| 版本号没变、内容变了 | 一致 | 不一致 | 可选更新，「立即更新 / 稍后提醒 / 跳过此版」 |
| 本机读不到指纹 | — | 空 | 退回纯版本号比对，**绝不误报** |

点「跳过此版」时记的是**指纹**而不是版本号，所以这一版跳过只会屏蔽这一个包，
将来再换个包（哪怕版本号还是 `1.1.1`）照样会提醒。

**这意味着你可以一直不升版本号**：想发新版就把新包传上去、把 `version.json` 的 `size` 和
`sha256` 改成新包的值，老用户打开软件照样能收到更新提示。要不要改版本号由你决定，
代码不做任何自动递增。

### 其它规则

- **打开软件的瞬间就对比**：App 一启动立刻跟本仓库对比，不等延时、不做节流，**每次打开都会真的去查一次**，所以新版本随时能在下次打开时被发现
- **切回前台也查**：从后台切回来超过 30 分钟，再对比一次
- **跳过只对该版本生效**：记下被跳过的版本或指纹，但强制更新永远会拦 —— 也就是第一、二位变化时「跳过」不生效，仍会弹
- **版本号读不到时静默**：取不到 `x.y.z` 一律判为「无法比较」，**绝不编造 `0.0.0`** —— 假版本号会被当成「从 0.0.0 大版本升级」而误报强制更新（这是早期版本踩过的坑）
- **两条路并行查**：同一次检查会同时请求 Release 和 `version.json`，谁先有结果用谁；Release 负责 APK 附件与说明，`version.json` 负责那个 `sha256` 指纹
- **数据来源一（优先）**：本仓库的 `GET /repos/Buwrt/githup/releases/latest`，取最新一个正式版（跳过 draft 与 prerelease），从它的 `assets` 里挑 APK 附件
- **数据来源二（备用）**：仓库根目录的 [`version.json`](version.json)。Release 不存在、取不到 APK 附件、或网络异常时自动改读这个文件，所以**即使从没发过 Release，更新检测照样可用**
- **下载安装**：走系统 `DownloadManager`，下载完自动拉起系统安装器（`installApk`），不需要自己去下载目录里找文件

### 下载的东西存在哪

所有下载（仓库 ZIP、Release 资产、构建产物、App 更新包、WebView 里点链接触发的下载）
统一存到 **`Download/githup/`** 子目录，不再跟浏览器、微信、QQ 下的东西混在 `Download` 根目录。

- 落盘位置在代码里只有一处定义（`JsBridge.downloadSubPath`），两个下载入口共用
- Android 10 起是分区存储，App 自己建不了公共目录，交给 `DownloadManager`（系统组件）建
- 万一子目录建不起来（个别 ROM），会自动退回 `Download` 根目录重试 —— 位置不对也比下不到强
- 普通文件下载完成会提示保存位置；APK 仍然直接拉起安装器，不弹提示

`version.json` 长这样，发新版时改 `version` / `apk` / `notes` / `size` / `sha256` 即可
（`size` 和 `sha256` 就是新包的大小与 SHA-256，指纹比对靠它俩）：

```json
{
  "version": "1.1.3",
  "apk": "https://github.com/Buwrt/githup/releases/download/v1.1.3/githup-1.1.3.apk",
  "size": 714509,
  "sha256": "c4d99c0464463bca19fd70e12c2c0df365bf650140e721af0b0615db357ef5fb",
  "notes": "新增整页翻译（滚动驱动、多引擎自动切换），适配平板与折叠屏；修翻译拖慢页面加载"
}
```

`apk` 既可以写 Release 附件的直链（推荐，安装包不进仓库），也可以写仓库内的相对路径。

相关实现：`app/src/main/assets/web/js/updater.js`，手动检查的入口在「设置 → 检查更新」。

> 小提示：版本信息优先识别 Release 的 **tag**，发布时 tag 必须是 `v1.1.1` 这种三段号（也可以不带 `v`）。注意其中一条历史坑：「当前版本号读不到」时千万不要兜底成 `0.0.0`，那会被当成「从 0.0.0 升到大版本」而误弹强制更新 —— 现在的做法是判定为「无法比较」并静默。

---

## 目录结构

```
github-mobile/
├── app/
│   ├── build.gradle                     版本、签名、编译配置
│   └── src/main/
│       ├── AndroidManifest.xml
│       ├── java/com/hubmobile/app/
│       │   ├── MainActivity.java        启动 WebView，注入 NativeBridge
│       │   ├── JsBridge.java            原生能力总入口（HTTP / 文件 / 下载 / 安装 …）
│       │   ├── Http.java                HttpURLConnection 封装（支持二进制 body）
│       │   ├── FilePick.java            系统文件选择器 + 读取
│       │   ├── KeyTool.java             纯 Java 生成 keystore（免 JDK）
│       │   ├── ApkProvider.java         给安装器临时授予 APK 读权限
│       │   ├── SecurePrefs.java         Token 的安全存储（AndroidKeyStore + AES）
│       │   ├── App.java                 启动即自检（防护链埋点一）
│       │   ├── Guard.java               防护链：签名 / 链签名 / 资源 / 身份 / 环境五环
│       │   ├── GuardKeys.java           防护链常量（由 tools/gen-guard.py 用官方私钥生成）
│       │   ├── BlockedActivity.java     非官方包唯一能看到的界面
│       │   ├── SignCheck.java           装包前校验签名证书
│       │   └── WebViewActivity.java     应用内浏览器
│       ├── proguard-rules.pro           R8 混淆规则
│       └── res/xml/
│           ├── network_security_config.xml  只信任系统根证书，禁明文
│           └── data_extraction_rules.xml    禁止云端备份 / 换机转移
│       └── assets/web/                  前端单页应用
│           ├── index.html
│           ├── css/app.css
│           ├── js/
│           │   ├── api.js               REST 封装 + 原生桥通信
│           │   ├── app.js               路由、主题、返回键、下拉刷新
│           │   ├── ui.js                Toast / Sheet / Confirm / 图片查看器
│           │   ├── md.js                Markdown 渲染（marked + highlight.js）
│           │   ├── updater.js           ← 本次新增：版本检测与更新
│           │   ├── page-home.js         登录 / 首页 / 通知 / 探索 / 搜索
│           │   ├── page-repo.js         仓库全页 + 云端打包向导
│           │   ├── page-detail.js       文件 / 提交 / Issue / PR / Actions 详情
│           │   ├── page-user.js         个人主页 + 设置
│           │   └── translate.js         ← 1.1.3 新增：整页翻译（滚动驱动 / 多引擎）
│           ├── css/translate.css        翻译按钮样式
│           ├── guard/assets.sha         前端文件哈希清单（防护链第 3 环）
│           └── vendor/                  marked / highlight.js / DOMPurify（本地离线）
├── tools/gen-guard.py                   重新生成防护链常量与资源清单（换版本号时必跑）
├── version.json                         更新检测用的版本清单（Release 的备用来源）
├── CHANGELOG.md                         更新日志（从 v1.1.3 开始记录）
├── RELEASE_NOTES.md                     Release 说明正文
├── .github/workflows/publish-release.yml  打 tag 后自动发布 Release
├── gradlew, gradle/                     Gradle Wrapper（已指向国内镜像）
├── build-apk.sh                         打包脚本
├── release.sh                           发版脚本（打包→提交→打 tag，一条命令）
└── preview/                             功能截图
```

## 自己编译

两种方式，任选其一。

### 方式一：一键脚本

```bash
bash build-apk.sh              # 按现有版本打包
bash build-apk.sh 1.1.3        # 文件名 githup-v1.1.3.apk，版本 1.1.3
bash build-apk.sh V4 1.1.1     # 文件名用代号，内部版本另填
```

脚本会同步改三处（`app/build.gradle` 的 `versionCode` / `versionName`、前端 `APP_VERSION` 常量），
构建完成后输出到上层目录，并清掉旧的包，只留最新这一个。

### 方式二：Gradle

```bash
export ANDROID_HOME=$HOME/Android/Sdk
./gradlew assembleRelease      # 产物在 app/build/outputs/apk/release/
```

签名：`build.gradle` 里默认输出可被后续 `apksigner` 处理的 Release 构建，自行配置 signingConfig 即可打包。
`.gitignore` 已排除 `*.keystore`，签名文件不会被误提交。

### 版本号的换算

`versionCode` 必须单调递增，否则手机上已有的新版本会拒绝安装旧包：

```
x.y.z   ->   x*1000000 + y*1000 + z      例：1.1.1 -> 1001001
Vn      ->   10203 + n                   例：V3    -> 10206
```

两个体系互不冲突，1.1.1（1001001）比所有 V 系列代号都大，从 V3 直接升级安装没问题。

## 发一个新版本

一条命令：

```bash
bash release.sh 1.1.3 "新增整页翻译，适配平板"
bash release.sh 1.2.0 "支持 xxx" V5     # 文件名还想要代号时加第三个参数
```

它会依次做：改版本号 → 打包 → 把 APK 放进 `apk/` → 回填 `version.json` 的大小与校验值 → 提交推送 → 打 `v1.1.3` 并推送（打 tag 后由 Actions 自动发 Release）。
tag 推送后，`.github/workflows/publish-release.yml` 会自动建好 Release 并把 APK 挂成附件，过一两分钟就出现在 [Releases](https://github.com/Buwrt/githup/releases) 里。

**为什么发布要走 Actions 而不是直接调 API**：外部令牌对仓库通常只有拉取权限，调 Release 的写接口会被 GitHub 以
`Resource not accessible by personal access token`（403）拒绝，但同一个令牌却允许 `git push` 仓库内容。
所以让仓库自己的 Actions 去创建 Release —— 它的 `GITHUB_TOKEN` 天然带 `contents: write`，不需要任何人额外授权。
（`.github/workflows/publish-release.yml` 配了 `workflow_dispatch`，也可以在网页上手动点一次按钮重新发布。）

## 安全：官方包的身份怎么保证

这一节是给「不想自己装的包被人动过手脚」这件事准备的。

| 措施 | 作用 |
|---|---|
| 官方专属签名 | 4096 位 RSA，`CN=githup`。**不是** debug 默认密钥（那个口令是公开的 `android`） |
| 签名证书指纹钉扎 | 下载完 APK 后，原生层先比对安装包的签名证书指纹，不是官方签的**直接拦下并删除** |
| 启动时自检 | 每次打开都校验自身签名，被重打包的 App 弹窗提示后退出 |
| R8 混淆 | 代码混淆 + 资源压缩，反编译出来不再是原来的类名和结构 |
| Token 不落 WebView | 只存在原生侧 **AndroidKeyStore + AES** 加密区，`localStorage` 里没有明文 |
| 禁止备份导出 | `allowBackup=false` + `dataExtractionRules`，云端备份和换机转移都不带数据 |
| 只信系统根证书 | `networkSecurityConfig` 只信任系统预装 CA，用户自己装的抓包证书不生效，禁明文流量 |

**官方签名证书 SHA-256**（任何人都可以用它核对自己手上的包）：

```
863dd1cd3752e59165e152bc4ab35fde478fcd296d724a6bc58cec0368184927
```

```bash
apksigner verify --print-certs githup-1.1.3.apk
```

### 防护链：一环扣一环

校验不能只放一处 —— 放一处，别人反编译把那一处删掉就全没了。所以做成五环互相咬合：

```
第1环 签名 ──▶ 第2环 链签名 ──▶ 第3环 资源 ──▶ 第4环 身份 ──▶ 第5环 环境
  ▲                                                                  │
  └────────────────────── 闭环复检 ◀─────────────────────────────────┘
```

每环拿到上一环的令牌，先核对再干活，再算出自己的令牌交给下一环。
**删掉中间任何一环，下一环收到的令牌就对不上，整条链立刻断。**

| 环 | 校验什么 | 拦住什么 |
|---|---|---|
| 1 签名 | 安装包签名证书指纹 | 改任何内容后重签名（改一个标点也算） |
| 2 链签名 | 链的期望值是不是官方私钥签的 | 改代码常量（没有官方私钥签不出来） |
| 3 资源 | 前端 JS/HTML 哈希清单 | 只换前端文件塞广告、偷令牌 |
| 4 身份 | 包名 / 软件名 / 版本号 / 入口类 | 改软件名、改包名做共存版 |
| 5 环境 | 调试器、注入框架 | 动态扒、Hook |

埋点在五个地方：进程启动、主界面、切回前台、应用内浏览器、每次网络请求与令牌读写。
判定篡改后只能看到「下载官方版本 / 退出」一页，没有"继续使用"，返回键也退不回去。

链的常量由 `tools/gen-guard.py` 用官方私钥生成（打包时自动跑），
所以**换密钥后必须重新打包**，否则链的签名验不过。

说句实话：**不存在"绝对无法反编译"的安卓包**。APK 最终要交给系统执行，
只要有工具和时间，代码和资源总能被翻出来。真正能做到的是抬高成本 ——
把代码搅乱、把官方身份钉在签名证书上（改任何一个字节签名就废）、
让被改过的包在用户手机上跑不起来。这三件都做了。

## 安装要求

- Android **7.0**（API 24）及以上，`targetSdk 34`
- 首次安装未知来源 APK 时，系统会要求授权「允许来自此来源的应用」
- 用到的权限：`INTERNET`、`ACCESS_NETWORK_STATE`、`VIBRATE`、`READ_MEDIA_*`（上传文件）、`REQUEST_INSTALL_PACKAGES`（下载 APK 后直装）

## 截图

`preview/` 下放了 50 张真实截图，覆盖登录、首页、仓库、Issue、PR、Actions、Release、搜索、个人主页、设置、深色模式等界面。

## 下载安装

最新版在 [Releases](https://github.com/Buwrt/githup/releases) 里，下载 `githup-1.2.8.apk` 直接安装即可（v1.2.8，918,226 字节）。

| 项 | 值 |
|---|---|
| 文件名 | `githup-1.2.8.apk` |
| 大小 | 918,226 字节（约 0.9 MB） |
| SHA-256 | `c4c75504ab5c157c7cefa21a396e6c5f7c002075a46f829000bc01e0518c75ee` |
| 版本 | versionName `1.2.8` / versionCode `1002008` |
| 包名 | `com.hubmobile.app` |
| 最低系统 | Android 7.0（API 24） |

> 下载后想确认没被掉包，可以核对上面的 SHA-256 —— 与
> [version.json](version.json) 里的 `sha256` 是同一个值。

> App 内「设置 → 检查更新」也能一键下载安装；打开软件时它会自己比对一次，
> 有新版本会提示，已是最新版则完全静默。

## 交流与反馈

| 渠道 | 地址 |
|---|---|
| QQ 群 | **806894257** —— 使用问题、Bug 反馈、版本预告 |
| Issues | [github.com/Buwrt/githup/issues](https://github.com/Buwrt/githup/issues) |
| 源码 | [github.com/Buwrt/githup](https://github.com/Buwrt/githup) |

软件里「设置 → 关于 githup」可以直接看到以上全部信息，并支持一键加群 / 复制群号。

## 贡献者

感谢下面这些人为 githup 出过力。**提 issue、指出 bug 算贡献，写好 PR 更是** —— 名字按时间倒序排（最新的在最上面）。

| 贡献者 | 贡献内容 | 相关链接 |
|---|---|---|
| [@mymine](https://github.com/mymine) | 报了 Star 列表「超过 100 个只加载前 100 个」并在 issue 里一路追到根因（`sort=pushed` 对 `/starred` 无效，服务端静默忽略），随后直接提 PR 解决；同一个 PR 还补上了**撤销 / 回滚提交**，并成为全仓库第一个正确接上 `__bound` 委托约定的人 | [#5](https://github.com/Buwrt/githup/issues/5) · [PR #7](https://github.com/Buwrt/githup/pull/7) |

> 这一份改动落在 **v1.2.5**。合并时在其之上又补了三处结实性问题（文件 mode 不再写死 `100644`、改动文件超 300 个时拒绝静默截断、回滚门槛按 Maintain / Admin 判定），
> 详见 [CHANGELOG.md](CHANGELOG.md) 里的 v1.2.5 一节。

想让你的名字出现在这里，[Issues](https://github.com/Buwrt/githup/issues) 和 [Pull Requests](https://github.com/Buwrt/githup/pulls) 都开着。

## 赞赏支持

如果这个软件帮到了你，欢迎请我喝杯咖啡 —— **完全自愿，不打赏也一样能用全部功能**。

<p align="center">
  <a href="https://github.com/Buwrt/githup/blob/main/docs/tips.png">
    <img src="https://raw.githubusercontent.com/Buwrt/githup/main/docs/tips.png" alt="赞赏码（微信 / 支付宝）" width="320">
  </a>
</p>

> 微信或支付宝扫上面的码即可。**点图片可查看原图**。
> 软件内「设置 → 关于 githup → 赞赏支持」用的也是这张原图，长按可保存到相册。

### 赞赏码原图

上面那张就是原图（984 × 1398），点开即是大图，可直接另存：

| 文件 | 地址 |
|---|---|
| 仓库内路径 | [`docs/tips.png`](https://github.com/Buwrt/githup/blob/main/docs/tips.png) |
| 直链（可外链引用） | https://raw.githubusercontent.com/Buwrt/githup/main/docs/tips.png |
| App 内同一张图 | [`app/src/main/assets/web/img/tips.png`](https://github.com/Buwrt/githup/blob/main/app/src/main/assets/web/img/tips.png) |

仓库里 `docs/tips.png` 与 App 内那份是**同一个文件**，像素完全一致。

<p align="center">
  <a href="https://github.com/Buwrt/githup/blob/main/docs/tips.png">
    <img src="https://raw.githubusercontent.com/Buwrt/githup/main/docs/tips.png" alt="赞赏码原图" width="460">
  </a>
</p>

## 声明

本应用是个人学习目的的第三方客户端，与 GitHub, Inc. 没有隶属关系。所有数据都通过 GitHub 官方公开 REST API 获得，Token 只保存在你自己的设备上。

- 图标：[GitHub Octicons](https://github.com/primer/octicons)（MIT）
- 代码高亮：[highlight.js](https://github.com/highlightjs/highlight.js)（BSD-3-Clause）
- Markdown：[marked](https://github.com/markedjs/marked)（MIT）
- HTML 净化：[DOMPurify](https://github.com/cure53/DOMPurify)（Apache-2.0 / MPL-2.0）
