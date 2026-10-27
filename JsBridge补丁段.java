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

    /** 拉起系统卸载界面。卸载结果由下次 libSync() 对账时落到台账。 */
    @JavascriptInterface
    public void libUninstall(String pkg) {
        try {
            Intent i = new Intent(Intent.ACTION_DELETE, Uri.parse("package:" + pkg));
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            activity.startActivity(i);
        } catch (Throwable ignored) {
        }
    }
