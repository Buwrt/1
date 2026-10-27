    /* ---------------- 应用库 ---------------- */

    private AppLibrary lib() {
        return AppLibrary.get(activity);
    }

    /** 台账全量（每行已并进本机真实状态）。 */
    @JavascriptInterface
    public String libList() {
        try {
            return lib().list();
        } catch (Throwable t) {
            return "[]";
        }
    }

    /** 枚举本机已装应用，供「关联」时挑选。需要 QUERY_ALL_PACKAGES 才完整。 */
    @JavascriptInterface
    public String libScan() {
        try {
            return lib().scan();
        } catch (Throwable t) {
            return "[]";
        }
    }

    @JavascriptInterface
    public boolean libAdd(String pkg, String owner, String repo, String name,
                          String tag, String asset, String url) {
        try {
            return lib().add(pkg, owner, repo, name, tag, asset, url);
        } catch (Throwable t) {
            return false;
        }
    }

    @JavascriptInterface
    public boolean libRemove(String pkg) {
        try {
            return lib().remove(pkg);
        } catch (Throwable t) {
            return false;
        }
    }

    /**
     * 前端查完 releases/latest 之后回填「最新版」这一半。
     * 传进来的 json：{tag, vName, vCode, asset, url, size, notes}
     */
    @JavascriptInterface
    public boolean libSetLatest(String pkg, String json) {
        try {
            return lib().setLatest(pkg, json);
        } catch (Throwable t) {
            return false;
        }
    }

    /** 装完了：把已装版本挪到最新那一档。 */
    @JavascriptInterface
    public boolean libMarkInstalled(String pkg, String tag, String vName, long vCode) {
        try {
            return lib().markInstalled(pkg, tag, vName, vCode);
        } catch (Throwable t) {
            return false;
        }
    }

    /** 已下载、还没装上。 */
    @JavascriptInterface
    public boolean libSetPending(String pkg, boolean pending) {
        try {
            return lib().markPending(pkg, pending);
        } catch (Throwable t) {
            return false;
        }
    }

    /** key：ignore / pre / skipped / regex */
    @JavascriptInterface
    public boolean libSetFlag(String pkg, String key, String value) {
        try {
            return lib().setFlag(pkg, key, value);
        } catch (Throwable t) {
            return false;
        }
    }

    /** 与 PackageManager 对账，返回 {dropped,resolved,changed}。 */
    @JavascriptInterface
    public String libSync() {
        try {
            return lib().sync();
        } catch (Throwable t) {
            return "{\"dropped\":0,\"resolved\":0,\"changed\":0}";
        }
    }

    @JavascriptInterface
    public String libExport() {
        try {
            return lib().exportJson();
        } catch (Throwable t) {
            return "[]";
        }
    }

    @JavascriptInterface
    public String libImport(String json) {
        try {
            return lib().importJson(json);
        } catch (Throwable t) {
            return "{\"imported\":0,\"skipped\":0,\"missing\":0}";
        }
    }

    /**
     * 下载并安装，同时记下「这个包来自哪个仓库」—— 装完自动进应用库。
     *
     * 这就是「在 githup 里下的应用会自动关联」的实现：下载时把
     * owner/repo/tag/asset 记在 URL 上，装之前读出 APK 包名，两者一合
     * 就落成台账一行。用户不用再手动填 owner/repo。
     */
    @JavascriptInterface
    public void installApkTracked(String url, String filename, String headersJson,
                                  String owner, String repo, String tag, String assetName,
                                  String category) {
        try {
            AppLibrary.noteTrack(url, owner, repo, tag, assetName);
        } catch (Throwable ignored) { }
        /* 走 7 参那个重载：参数位置写全，别让重载解析去猜。 */
        enqueueDownload(url, filename, headersJson, null, true, null, category);
    }

    /**
     * 用**已经下载好**的那个包直接拉起系统安装器，不再下一遍。
     *
     * 场景：用户在系统安装器上点了取消，回到应用库 —— 文件还在本地
     * （ApkProvider 目录里），再下一遍纯属浪费流量和时间。
     *
     * @return true 表示确实拉起了安装器；false 表示文件没了，调用方该重新下载。
     */
    @JavascriptInterface
    public boolean libInstallPending(String pkg) {
        if (pkg == null || pkg.isEmpty()) return false;
        try {
            String fileName = lib().pendingFile(pkg);
            if (fileName == null || fileName.isEmpty()) return false;
            Uri uri = ApkProvider.uriFor(
                    activity.getPackageName() + ApkProvider.AUTHORITY_SUFFIX, fileName);
            final Uri u = uri;
            activity.runOnUiThread(() -> openInstaller(u));
            return true;
        } catch (Throwable t) {
            return false;
        }
    }

    /** 改「这一行装的是哪个包」—— 一个仓库发多个包名时用来纠正错绑。 */
    @JavascriptInterface
    public boolean libSetInstalledAsset(String pkg, String assetName) {
        try {
            return lib().setInstalledAsset(pkg, assetName);
        } catch (Throwable t) {
            return false;
        }
    }

    /** 钉住变体（arm64 / foss 等），传 null 或空串表示不钉。 */
    @JavascriptInterface
    public boolean libSetVariant(String pkg, String variant) {
        try {
            return lib().setVariant(pkg, variant);
        } catch (Throwable t) {
            return false;
        }
    }

    /** 高级过滤：asset 正则 + 是否退到更旧的 release。 */
    @JavascriptInterface
    public boolean libSetAdvanced(String pkg, String regex, boolean fallbackOlder) {
        try {
            return lib().setAdvanced(pkg, regex, fallbackOlder);
        } catch (Throwable t) {
            return false;
        }
    }

    /** 对一批 asset 名试跑正则，返回匹配到的那些（存之前先核对）。 */
    @JavascriptInterface
    public String libPreviewMatch(String assetNamesJson, String regex) {
        try {
            return AppLibrary.previewMatch(new JSONArray(assetNamesJson), regex).toString();
        } catch (Throwable t) {
            return "[]";
        }
    }

    /** 下载完成、等待安装：记下文件路径，这一行就停在这。 */
    @JavascriptInterface
    public boolean libMarkPending(String pkg, String tag, String assetName, String filePath) {
        try {
            return lib().markPending(pkg, tag, assetName, filePath);
        } catch (Throwable t) {
            return false;
        }
    }

    /** 用存过的匹配下载失败一次 —— 下次别再信它，重新查 release。 */
    @JavascriptInterface
    public boolean libNotePendingFailure(String pkg) {
        try {
            return lib().notePendingFailure(pkg);
        } catch (Throwable t) {
            return false;
        }
    }

    /** 丢弃停放的安装（删文件 + 清状态）。 */
    @JavascriptInterface
    public boolean libDiscardPending(String pkg) {
        try {
            return lib().discardPending(pkg);
        } catch (Throwable t) {
            return false;
        }
    }

    /** 停放的安装包还在不在。 */
    @JavascriptInterface
    public boolean libPendingFileExists(String pkg) {
        try {
            return lib().pendingFileExists(pkg);
        } catch (Throwable t) {
            return false;
        }
    }

    /** 拉起应用。返回 false 说明没装 / 没有可启动的入口。 */
    @JavascriptInterface
    public boolean libOpen(String pkg) {
        try {
            Intent i = activity.getPackageManager().getLaunchIntentForPackage(pkg);
            if (i == null) return false;
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            activity.startActivity(i);
            return true;
        } catch (Throwable t) {
            return false;
        }
    }

    /**
     * 设备主 ABI，如 arm64-v8a。
     * 一个仓库发多个 APK 时用它挑对架构 —— 光按体积挑会挑到错的那一个。
     */
    @JavascriptInterface
    public String libAbi() {
        try {
            String[] abis = android.os.Build.SUPPORTED_ABIS;
            return (abis != null && abis.length > 0) ? abis[0] : "";
        } catch (Throwable t) {
            return "";
        }
    }

    /**
     * 拉起系统卸载界面。
     *
     * ⚠️ targetSdk >= 28 起，用 ACTION_DELETE 必须在 manifest 里声明
     *    REQUEST_DELETE_PACKAGES。缺了它系统**静默忽略**这条 Intent ——
     *    不抛异常、不弹窗、什么都不发生，从 App 这头看 startActivity 明明
     *    成功了。komi 的 manifest 里有这条，所以它能弹出来。
     *
     * 所以这里做两件事：
     *   1. 用 resolveActivity 先确认真有 Activity 接得住；
     *   2. 接不住就退到系统「应用信息」页（在那儿也能卸载），并且
     *      **如实返回**是否真的弹出了卸载框 —— 不能给前端一个假的成功。
     *
     * @JavascriptInterface 跑在 JavaBridge 线程，startActivity 必须回主线程，
     * 和项目里 share() / openInApp() 一致。
     */
    @JavascriptInterface
    public boolean libUninstall(String pkg) {
        if (pkg == null || pkg.isEmpty()) return false;
        try {
            Intent del = new Intent(Intent.ACTION_DELETE, Uri.parse("package:" + pkg));
            del.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            boolean ok = del.resolveActivity(activity.getPackageManager()) != null;
            activity.runOnUiThread(() -> {
                try {
                    if (ok) {
                        activity.startActivity(del);
                    } else {
                        // 没有能接 ACTION_DELETE 的：退到应用信息页
                        Intent info = new Intent(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                                Uri.parse("package:" + pkg));
                        info.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                        activity.startActivity(info);
                    }
                } catch (Throwable ignored) {
                }
            });
            return ok;
        } catch (Throwable t) {
            return false;
        }
    }

    /**
     * 立刻核对一遍下载历史：本地文件已经不在的，记录也清掉。
     *
     * 用在「用户在文件管理器里删了文件，App 里还留着记录」这个场景。
     * 平时 downloadHistory() 会自己核对，但有 5 秒节流，而且有一条
     * 安全网会拦 —— 所以给个手动入口，让用户可以当场核一次。
     *
     * @return 清掉了几条
     */
    @JavascriptInterface
    public int pruneDownloadHistory() {
        try {
            return pruneMissingNow();
        } catch (Throwable t) {
            return 0;
        }
    }

    /** 有多少个应用可更新。纯本地查表，秒回。 */
    @JavascriptInterface
    public int libUpdateCount() {
        try {
            return lib().updateCount();
        } catch (Throwable t) {
            return 0;
        }
    }

    /** 台账里最早一次检查时间（毫秒）。前端据此做节流。 */
    @JavascriptInterface
    public long libOldestCheckedAt() {
        try {
            return lib().oldestCheckedAt();
        } catch (Throwable t) {
            return 0L;
        }
    }

    /**
     * 确认这个包真的不在了，就删掉台账里那一行。
     *
     * 为什么需要单独一个方法，而不是靠 libSync()：
     *   libSync() 带「防误删护栏」——扫描结果残缺时一个都不删（防的是
     *   Android 11+ 包可见性把整个应用库清空，komi 的 GH#748）。
     *   但**用户刚主动卸载**这个场景不该被护栏拦：人是自己点的卸载，
     *   卸载完这行还在，看起来就像没删掉。
     *
     * 所以这一条是「显式确认」路径：只针对这一个包名单点查一次，
     * 不在就删。护栏管自动扫描，这里管用户意图，两条路互不干扰。
     */
    @JavascriptInterface
    public boolean libRemoveIfGone(String pkg) {
        if (pkg == null || pkg.isEmpty()) return false;
        try {
            if (AppLibrary.probe(activity, pkg).present) return false;
            lib().remove(pkg);
            return true;
        } catch (Throwable t) {
            return false;
        }
    }
