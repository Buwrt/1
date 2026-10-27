package com.hubmobile.app;

import android.content.Context;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteOpenHelper;
import android.os.Build;

import org.json.JSONArray;
import org.json.JSONObject;

import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.List;

/**
 * 应用库台账。
 *
 * 一句话职责：把「这台手机上装了什么」和「它来自哪个仓库的哪个 Release」
 * 绑成一张表，剩下的（发请求、比对、画界面）全交给前端 JS。
 *
 * 为什么要落在 SQLite 而不是 SharedPreferences / localStorage：
 *   localStorage 在 WebView 里，清缓存就没了；而「我装过哪些应用」应该
 *   跟 App 数据一起走、能备份。SQLite 是 Android 框架自带，不引入第三方依赖。
 *
 * 分层上的取舍：更新检查所需的 GitHub 请求**不在这一层发**，由前端
 * page-library.js 调现有的 API.get('/repos/{o}/{r}/releases/latest')。
 * 原生只干 Web 干不了的三件事：读本机已装包信息、算签名指纹、拉起/卸载。
 * 这样网络层（含加速通道、令牌注入）完全复用既有实现，一处不改。
 */
public class AppLibrary extends SQLiteOpenHelper {

    private static final String DB_NAME = "app_library.db";
    private static final int DB_VER = 1;
    private static final String T = "apps";

    /** 少于这个数就认为「这次扫描不可信」，绝不据此删台账（见 sync()） */
    private static final int MIN_PLAUSIBLE_SCAN_SIZE = 20;

    private static AppLibrary sInst;
    private final Context ctx;

    static synchronized AppLibrary get(Context c) {
        if (sInst == null) sInst = new AppLibrary(c.getApplicationContext());
        return sInst;
    }

    private AppLibrary(Context c) {
        super(c, DB_NAME, null, DB_VER);
        this.ctx = c;
    }

    @Override
    public void onCreate(SQLiteDatabase db) {
        db.execSQL("CREATE TABLE IF NOT EXISTS " + T + " ("
                + "pkg TEXT PRIMARY KEY,"          // 包名，主键
                + "owner TEXT,"                     // 仓库 owner
                + "repo TEXT,"                      // 仓库名
                + "app_name TEXT,"                  // 应用名
                + "installed_tag TEXT,"             // 已装的 Release tag
                + "installed_vname TEXT,"           // 系统读到的 versionName
                + "installed_vcode INTEGER DEFAULT 0," // 系统读到的 versionCode
                + "installed_asset TEXT,"           // 已装的那个 asset 名
                + "installed_url TEXT,"             // 已装 asset 的下载直链
                + "fingerprint TEXT,"               // 已装包的签名证书 SHA-256
                + "latest_tag TEXT,"                // 上次查到的最新 tag
                + "latest_vname TEXT,"
                + "latest_vcode INTEGER DEFAULT 0,"
                + "latest_asset TEXT,"
                + "latest_url TEXT,"
                + "latest_size INTEGER DEFAULT 0,"
                + "notes TEXT,"                     // 最新版的更新说明
                + "has_update INTEGER DEFAULT 0,"   // 0/1 是否有更新
                + "pending INTEGER DEFAULT 0,"      // 0/1 待安装（下载完没装上）
                + "ignore_update INTEGER DEFAULT 0,"// 0/1 忽略此应用更新
                + "pre_release INTEGER DEFAULT 0,"  // 0/1 收预发布
                + "skipped_tag TEXT,"               // 跳过的那一版
                + "asset_regex TEXT,"               // asset 名正则过滤
                + "installed_at INTEGER DEFAULT 0,"
                + "updated_at INTEGER DEFAULT 0,"
                + "checked_at INTEGER DEFAULT 0)");
    }

    @Override
    public void onUpgrade(SQLiteDatabase db, int oldV, int newV) {
        // 第一版，暂无迁移
    }

    /* ============================================================
     * 读
     * ============================================================ */

    /**
     * 台账全量。每一行都会**现查一次系统**，把真实安装状态并进去返回。
     *
     * 为什么要现查：数据库里记的是「上次同步时的样子」，用户可能已经在
     * 系统设置里卸掉了、也可能手动装了新版。UI 要显示的是当下，不是历史。
     * 写回数据库留给 sync()，读路径不做副作用 —— 打开页面不该改数据。
     */
    synchronized String list() {
        JSONArray out = new JSONArray();
        SQLiteDatabase db = getReadableDatabase();
        Cursor c = null;
        try {
            c = db.query(T, null, null, null, null, null, "app_name COLLATE NOCASE ASC");
            while (c.moveToNext()) {
                JSONObject o = rowToJson(c);
                DeviceInfo di = probe(o.optString("pkg", ""));
                o.put("present", di.present);
                if (di.present) {
                    o.put("sysVName", di.versionName);
                    o.put("sysVCode", di.versionCode);
                    o.put("sysFingerprint", di.fingerprint);
                }
                out.put(o);
            }
        } catch (Throwable t) {
            LogBook.error(ctx, "应用库读取失败", String.valueOf(t.getMessage()));
        } finally {
            if (c != null) try { c.close(); } catch (Throwable ignored) { }
        }
        return out.toString();
    }

    private JSONObject rowToJson(Cursor c) throws Exception {
        JSONObject o = new JSONObject();
        String[] cols = new String[]{
                "pkg", "owner", "repo", "app_name", "installed_tag", "installed_vname",
                "installed_asset", "installed_url", "fingerprint", "latest_tag",
                "latest_vname", "latest_asset", "latest_url", "notes", "skipped_tag", "asset_regex"
        };
        for (String col : cols) {
            int i = c.getColumnIndex(col);
            if (i >= 0 && !c.isNull(i)) o.put(col, c.getString(i));
        }
        o.put("installedVCode", c.getLong(c.getColumnIndex("installed_vcode")));
        o.put("latestVCode", c.getLong(c.getColumnIndex("latest_vcode")));
        o.put("latestSize", c.getLong(c.getColumnIndex("latest_size")));
        o.put("hasUpdate", c.getInt(c.getColumnIndex("has_update")) == 1);
        o.put("pending", c.getInt(c.getColumnIndex("pending")) == 1);
        o.put("ignoreUpdate", c.getInt(c.getColumnIndex("ignore_update")) == 1);
        o.put("preRelease", c.getInt(c.getColumnIndex("pre_release")) == 1);
        o.put("checkedAt", c.getLong(c.getColumnIndex("checked_at")));
        return o;
    }

    /* ============================================================
     * 写
     * ============================================================ */

    /** 建立绑定（手动关联 / 自动关联都走这里）。 */
    /**
     * 建立绑定。
     *
     * ⚠️ 参数里的 tag / assetName / assetUrl 是**最新 Release** 的信息，
     *    不是「已装版本」。早期版本把它写进了 installed_* 列，于是
     *    「装的是 2.0.11、最新是 2.0.12」被显示成「已装 2.0.12、已是最新」——
     *    两头都错。现在已装那一半**只从系统读**，传进来的只落 latest_*。
     */
    synchronized boolean add(String pkg, String owner, String repo, String appName,
                             String tag, String assetName, String assetUrl) {
        if (pkg == null || pkg.isEmpty() || owner == null || repo == null) return false;
        SQLiteDatabase db = getWritableDatabase();
        try {
            DeviceInfo di = probe(pkg);
            // 已装版本就是系统说的那个；versionName 通常和 Release tag 同格式
            // （2.0.11 / v2.0.11），拿不到就留空，绝不拿 latest 顶替。
            String instName = di.present && di.versionName != null ? di.versionName : "";
            long instCode = di.present ? di.versionCode : 0L;

            // 传进来的这一份是最新 Release，直接算有没有更新
            long latestCode = codeOfTag(tag);
            long instTagCode = codeOfTag(instName);
            boolean newer = latestCode > 0 && latestCode > instTagCode;

            db.execSQL("INSERT OR REPLACE INTO " + T + " (pkg,owner,repo,app_name,"
                            + "installed_tag,installed_vname,installed_vcode,"
                            + "latest_tag,latest_asset,latest_url,"
                            + "fingerprint,has_update,"
                            + "installed_at,updated_at,checked_at) "
                            + "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    new Object[]{
                            pkg, owner, repo, appName == null ? pkg : appName,
                            instName, instName, instCode,
                            tag == null ? "" : tag, assetName, assetUrl,
                            di.present ? di.fingerprint : null,
                            newer ? 1 : 0,
                            System.currentTimeMillis(), System.currentTimeMillis(),
                            System.currentTimeMillis()
                    });
            return true;
        } catch (Throwable t) {
            LogBook.error(ctx, "应用库写入失败", String.valueOf(t.getMessage()));
            return false;
        }
    }

    /**
     * 版本号归一成可比较的 long：x.y.z -> x*1000000 + y*1000 + z。
     * 允许前置 v，允许只给前两位；解析不出来返回 0（调用方需按 0 处理，
     * 不能拿 0 当「很小」，那样会把「认不出来」误判成「有更新」）。
     *
     * 两边必须都走这个换算：
     *   Android 的 versionCode 是开发者自定义的整数，跟 x.y.z 毫无关系，
     *   拿它跟 tag 换算出来的数字比等于拿苹果比橘子。所以统一比
     *   versionName 与 tag 归一化后的值。
     */
    static long codeOfTag(String raw) {
        if (raw == null) return 0;
        String s = raw.trim();
        if (s.length() > 0 && (s.charAt(0) == 'v' || s.charAt(0) == 'V')) s = s.substring(1);
        String[] parts = s.split("\\.");
        try {
            long maj = Long.parseLong(parts[0]);
            long min = parts.length > 1 ? Long.parseLong(parts[1]) : 0L;
            long pat = parts.length > 2 ? Long.parseLong(parts[2]) : 0L;
            return maj * 1000000L + min * 1000L + pat;
        } catch (Throwable t) {
            return 0;
        }
    }

    synchronized boolean remove(String pkg) {
        try {
            getWritableDatabase().delete(T, "pkg=?", new String[]{pkg});
            return true;
        } catch (Throwable t) {
            return false;
        }
    }

    /**
     * 前端查完 Release 之后回填「最新版」这一半。
     *
     * 只在 versionCode 或 tag 真的前进了才算有更新 —— 降级包（比如开发者
     * 撤回了发布）不应该被当成更新推给用户。
     */
    synchronized boolean setLatest(String pkg, String json) {
        try {
            JSONObject o = new JSONObject(json);
            String tag = o.optString("tag", "");
            String vName = o.optString("vName", "");
            long vCode = o.optLong("vCode", 0L);
            String asset = o.optString("asset", "");
            String url = o.optString("url", "");
            long size = o.optLong("size", 0L);
            String notes = o.optString("notes", "");

            SQLiteDatabase db = getWritableDatabase();
            Cursor c = null;
            long curCode = 0;
            String curTag = "";
            String skipped = null;
            int ignore = 0;
            try {
                c = db.query(T, new String[]{"installed_vcode", "installed_tag", "skipped_tag", "ignore_update"},
                        "pkg=?", new String[]{pkg}, null, null, null);
                if (c.moveToFirst()) {
                    curCode = c.getLong(0);
                    curTag = c.getString(1) == null ? "" : c.getString(1);
                    skipped = c.getString(2);
                    ignore = c.getInt(3);
                }
            } finally {
                if (c != null) try { c.close(); } catch (Throwable ignored) { }
            }

            // 两边统一按 x.y.z 归一后再比；vCode 只是备用（个别仓库 tag 不规范，
            // 但 versionName 与 tag 恰好同构时用它兜底）。
            long latestCode = codeOfTag(tag);
            long instCode = codeOfTag(curTag);
            boolean newer = false;
            if (latestCode > 0 && instCode > 0) newer = latestCode > instCode;
            else if (latestCode > 0 && instCode == 0 && !curTag.isEmpty()) newer = vCode > curCode;
            else if (latestCode == 0 && instCode == 0) newer = !tag.equals(curTag) && !tag.isEmpty();
            if (skipped != null && skipped.equals(tag)) newer = false;
            if (ignore == 1) newer = false;

            db.execSQL("UPDATE " + T + " SET latest_tag=?, latest_vname=?, latest_vcode=?,"
                            + " latest_asset=?, latest_url=?, latest_size=?, notes=?,"
                            + " has_update=?, checked_at=? WHERE pkg=?",
                    new Object[]{tag, vName, vCode, asset, url, size, notes,
                            newer ? 1 : 0, System.currentTimeMillis(), pkg});
            return true;
        } catch (Throwable t) {
            LogBook.error(ctx, "应用库回填最新版失败", String.valueOf(t.getMessage()));
            return false;
        }
    }

    /** 装完了：把「已装版本」挪到最新那一档。 */
    synchronized boolean markInstalled(String pkg, String tag, String vName, long vCode) {
        try {
            DeviceInfo di = probe(pkg);
            getWritableDatabase().execSQL("UPDATE " + T + " SET installed_tag=?, installed_vname=?,"
                            + " installed_vcode=?, fingerprint=?, installed_asset=latest_asset,"
                            + " installed_url=latest_url, has_update=0, pending=0,"
                            + " updated_at=? WHERE pkg=?",
                    new Object[]{tag, di.present ? di.versionName : vName,
                            di.present ? di.versionCode : vCode,
                            di.present ? di.fingerprint : null,
                            System.currentTimeMillis(), pkg});
            return true;
        } catch (Throwable t) {
            return false;
        }
    }

    /** 已下载、还没装上。 */
    synchronized boolean markPending(String pkg, boolean pending) {
        try {
            getWritableDatabase().execSQL("UPDATE " + T + " SET pending=? WHERE pkg=?",
                    new Object[]{pending ? 1 : 0, pkg});
            return true;
        } catch (Throwable t) {
            return false;
        }
    }

    /** 改某一项的开关：ignore / pre / skipped / regex。 */
    synchronized boolean setFlag(String pkg, String key, String value) {
        String col;
        switch (key) {
            case "ignore": col = "ignore_update"; break;
            case "pre": col = "pre_release"; break;
            case "skipped": col = "skipped_tag"; break;
            case "regex": col = "asset_regex"; break;
            default: return false;
        }
        try {
            if ("skipped".equals(key) || "regex".equals(key)) {
                getWritableDatabase().execSQL("UPDATE " + T + " SET " + col + "=? WHERE pkg=?",
                        new Object[]{value, pkg});
            } else {
                getWritableDatabase().execSQL("UPDATE " + T + " SET " + col + "=? WHERE pkg=?",
                        new Object[]{"1".equals(value) ? 1 : 0, pkg});
            }
            return true;
        } catch (Throwable t) {
            return false;
        }
    }

    /* ============================================================
     * 与系统对账
     * ============================================================ */

    /**
     * 拿台账跟 PackageManager 的真实情况对一遍：
     *   - 系统上没了  -> 删这一行
     *   - 待安装且已装上 -> 落成已装
     *   - 版本号/签名变了 -> 记一笔，前端显示「外部更新 / 降级 / 换签名」
     *
     * ⚠️ 护栏（照抄 komi-store 的 GH#748 教训）：
     * Android 11 起的包可见性限制会让扫描结果**残缺不全**。如果没有这道闸，
     * 一次异常扫描就会把整个应用库清空。所以：
     *   1. 扫出来的包少于 20 个 -> 本次不做任何删除
     *   2. 认出来的不到台账一半 -> 同上
     *   3. 删之前还要逐个二次确认「确实不存在」，查不到的一律当未知、不删
     */
    synchronized String sync() {
        int dropped = 0, resolved = 0, changed = 0;
        try {
            List<String> pkgs = new ArrayList<>();
            SQLiteDatabase db = getWritableDatabase();
            Cursor c = null;
            try {
                c = db.query(T, new String[]{"pkg"}, null, null, null, null, null);
                while (c.moveToNext()) pkgs.add(c.getString(0));
            } finally {
                if (c != null) try { c.close(); } catch (Throwable ignored) { }
            }
            if (pkgs.isEmpty()) return "{\"dropped\":0,\"resolved\":0,\"changed\":0}";

            List<String> onSystem = installedPackageNames();
            boolean trustworthy = onSystem.size() >= MIN_PLAUSIBLE_SCAN_SIZE;
            if (trustworthy) {
                int recognized = 0;
                for (String p : pkgs) if (onSystem.contains(p)) recognized++;
                if (recognized * 2 < pkgs.size()) trustworthy = false;
            }
            if (!trustworthy) {
                LogBook.error(ctx, "应用库对账：本机应用扫描结果不可信",
                        "台账 " + pkgs.size() + " 个，只扫到 " + onSystem.size() + " 个，本次跳过删除");
            }

            for (String p : pkgs) {
                DeviceInfo di = probe(p);
                if (!di.present) {
                    if (trustworthy) {
                        db.delete(T, "pkg=?", new String[]{p});
                        dropped++;
                    }
                    continue;
                }
                Cursor r = null;
                String curName = null;
                long curCode = 0;
                String curFp = null;
                int pending = 0;
                try {
                    r = db.query(T, new String[]{"installed_vname", "installed_vcode", "fingerprint", "pending"},
                            "pkg=?", new String[]{p}, null, null, null);
                    if (r.moveToFirst()) {
                        curName = r.getString(0);
                        curCode = r.getLong(1);
                        curFp = r.getString(2);
                        pending = r.getInt(3);
                    }
                } finally {
                    if (r != null) try { r.close(); } catch (Throwable ignored) { }
                }
                boolean fpChanged = curFp != null && di.fingerprint != null && !curFp.equals(di.fingerprint);
                if (curCode != di.versionCode || fpChanged) {
                    db.execSQL("UPDATE " + T + " SET installed_vname=?, installed_vcode=?,"
                                    + " fingerprint=?, pending=0 WHERE pkg=?",
                            new Object[]{di.versionName, di.versionCode, di.fingerprint, p});
                    changed++;
                } else if (pending == 1) {
                    db.execSQL("UPDATE " + T + " SET pending=0 WHERE pkg=?", new Object[]{p});
                    resolved++;
                }
            }
        } catch (Throwable t) {
            LogBook.error(ctx, "应用库对账失败", String.valueOf(t.getMessage()));
        }
        return "{\"dropped\":" + dropped + ",\"resolved\":" + resolved + ",\"changed\":" + changed + "}";
    }

    /* ============================================================
     * 本机应用
     * ============================================================ */

    /** 枚举本机已装应用（需要 QUERY_ALL_PACKAGES，否则 Android 11+ 只能看到少数几个）。 */
    String scan() {
        JSONArray out = new JSONArray();
        try {
            PackageManager pm = ctx.getPackageManager();
            List<PackageInfo> list = pm.getInstalledPackages(0);
            List<String> tracked = trackedPackages();
            for (PackageInfo pi : list) {
                String pkg = pi.packageName;
                if (tracked.contains(pkg)) continue;   // 已在管的不重复出现
                ApplicationInfo ai = pi.applicationInfo;
                boolean isSystem = ai != null
                        && (ai.flags & (ApplicationInfo.FLAG_SYSTEM | ApplicationInfo.FLAG_UPDATED_SYSTEM_APP)) != 0;
                JSONObject o = new JSONObject();
                o.put("pkg", pkg);
                o.put("name", ai == null ? pkg : pm.getApplicationLabel(ai).toString());
                o.put("vName", pi.versionName);
                o.put("vCode", pi.versionCode);
                o.put("system", isSystem);
                out.put(o);
            }
        } catch (Throwable t) {
            LogBook.error(ctx, "扫描本机应用失败", String.valueOf(t.getMessage()));
        }
        return out.toString();
    }

    private List<String> trackedPackages() {
        List<String> r = new ArrayList<>();
        Cursor c = null;
        try {
            c = getReadableDatabase().query(T, new String[]{"pkg"}, null, null, null, null, null);
            while (c.moveToNext()) r.add(c.getString(0));
        } catch (Throwable ignored) {
        } finally {
            if (c != null) try { c.close(); } catch (Throwable ignored) { }
        }
        return r;
    }

    private List<String> installedPackageNames() {
        List<String> r = new ArrayList<>();
        try {
            for (PackageInfo pi : ctx.getPackageManager().getInstalledPackages(0)) r.add(pi.packageName);
        } catch (Throwable ignored) {
        }
        return r;
    }

    static class DeviceInfo {
        boolean present;
        String versionName;
        long versionCode;
        String fingerprint;
    }

    /**
     * 单点查一个包：在不在、什么版本、什么签名。
     *
     * 单点查询不需要 QUERY_ALL_PACKAGES —— 这是「不想加那个权限」时的退路：
     * 台账里登记过的包名都能查到，代价只是拿不到「本机全部应用」的自动发现。
     */
    static DeviceInfo probe(Context ctx, String pkg) {
        DeviceInfo d = new DeviceInfo();
        if (pkg == null || pkg.isEmpty()) return d;
        try {
            PackageManager pm = ctx.getPackageManager();
            PackageInfo pi;
            Signature[] arr = null;
            if (Build.VERSION.SDK_INT >= 28) {
                pi = pm.getPackageInfo(pkg, PackageManager.GET_SIGNING_CERTIFICATES);
                if (pi.signingInfo != null) arr = pi.signingInfo.getApkContentsSigners();
            } else {
                pi = pm.getPackageInfo(pkg, PackageManager.GET_SIGNATURES);
                arr = pi.signatures;
            }
            d.present = true;
            d.versionName = pi.versionName;
            d.versionCode = pi.versionCode;
            d.fingerprint = arr == null || arr.length == 0 ? null : sha256hex(arr[0].toByteArray());
        } catch (Throwable ignored) {
            // NameNotFoundException = 没装，present 保持 false
        }
        return d;
    }

    private DeviceInfo probe(String pkg) {
        return probe(ctx, pkg);
    }

    /** 签名证书的 SHA-256（小写十六进制，无分隔符）。和 SignCheck 同一口径。 */
    static String sha256hex(byte[] data) {
        try {
            byte[] d = MessageDigest.getInstance("SHA-256").digest(data);
            StringBuilder sb = new StringBuilder();
            for (byte b : d) sb.append(String.format("%02x", b));
            return sb.toString();
        } catch (Throwable t) {
            return null;
        }
    }

    /* ============================================================
     * 导入导出
     * ============================================================ */

    synchronized String exportJson() {
        JSONArray out = new JSONArray();
        Cursor c = null;
        try {
            c = getReadableDatabase().query(T, null, null, null, null, null, null);
            while (c.moveToNext()) {
                JSONObject o = new JSONObject();
                o.put("pkg", c.getString(c.getColumnIndex("pkg")));
                o.put("owner", c.getString(c.getColumnIndex("owner")));
                o.put("repo", c.getString(c.getColumnIndex("repo")));
                o.put("name", c.getString(c.getColumnIndex("app_name")));
                o.put("tag", c.getString(c.getColumnIndex("installed_tag")));
                o.put("asset", c.getString(c.getColumnIndex("installed_asset")));
                out.put(o);
            }
        } catch (Throwable ignored) {
        } finally {
            if (c != null) try { c.close(); } catch (Throwable ignored) { }
        }
        return out.toString();
    }

    /**
     * 导入。**本机没装的一律不导入** —— 一行就代表「装了」，
     * 导进来会变成能打开、能卸载的假行。
     */
    synchronized String importJson(String json) {
        int ok = 0, skip = 0, miss = 0;
        try {
            JSONArray arr = new JSONArray(json);
            for (int i = 0; i < arr.length(); i++) {
                JSONObject o = arr.getJSONObject(i);
                String pkg = o.optString("pkg", "");
                if (pkg.isEmpty()) { skip++; continue; }
                if (trackedPackages().contains(pkg)) { skip++; continue; }
                if (!probe(pkg).present) { miss++; continue; }
                if (add(pkg, o.optString("owner", ""), o.optString("repo", ""),
                        o.optString("name", pkg), o.optString("tag", ""),
                        o.optString("asset", ""), null)) ok++;
                else skip++;
            }
        } catch (Throwable t) {
            LogBook.error(ctx, "应用库导入失败", String.valueOf(t.getMessage()));
        }
        return "{\"imported\":" + ok + ",\"skipped\":" + skip + ",\"missing\":" + miss + "}";
    }
}
