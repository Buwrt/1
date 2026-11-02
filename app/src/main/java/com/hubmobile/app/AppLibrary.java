package com.hubmobile.app;

import android.content.Context;
import android.net.Uri;
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

import java.io.File;
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
    private static final int DB_VER = 3;
    private static final String T = "apps";

    /** 少于这个数就认为「这次扫描不可信」，绝不据此删台账（见 sync()） */
    private static final int MIN_PLAUSIBLE_SCAN_SIZE = 20;

    /** 待安装行的停放时限：超过就当那次安装没发生过，交回通用规则处置 */
    private static final long PENDING_KEEP_MS = 7L * 24 * 3600 * 1000;

    /** 来源记忆落在本机的哪个 preferences 里 */
    private static final String TRACK_PREF = "app_library_track";

    /** 来源记忆的有效期：比停放时限长一点，够覆盖一次完整的下载+安装 */
    private static final long TRACK_KEEP_MS = 7L * 24 * 3600 * 1000;

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
                + "pending_file TEXT,"            // 已下载待安装的文件路径
                + "pending_tag TEXT,"             // 待安装的那一版
                + "pending_asset TEXT,"
                + "pending_failed INTEGER DEFAULT 0," // 用存过的匹配下载失败过几次
                + "pinned_variant TEXT,"          // 钉住的变体（如 arm64）
                + "fallback_older INTEGER DEFAULT 0," // 最新版没匹配上就退到更旧的 release
                + "installed_at INTEGER DEFAULT 0,"
                + "updated_at INTEGER DEFAULT 0,"
                + "checked_at INTEGER DEFAULT 0)");
    }

    /**
     * 加列用 ALTER TABLE 逐条补，不重建表 —— 台账是用户一条条攒起来的，
     * 重建等于清空。每条都吞掉「列已存在」的异常，重复升级也不会炸。
     */
    @Override
    public void onUpgrade(SQLiteDatabase db, int oldV, int newV) {
        if (oldV < 2) {
            String[] adds = {
                    "ALTER TABLE " + T + " ADD COLUMN pending_file TEXT",
                    "ALTER TABLE " + T + " ADD COLUMN pending_tag TEXT",
                    "ALTER TABLE " + T + " ADD COLUMN pending_asset TEXT",
                    "ALTER TABLE " + T + " ADD COLUMN pending_failed INTEGER DEFAULT 0",
                    "ALTER TABLE " + T + " ADD COLUMN pinned_variant TEXT",
                    "ALTER TABLE " + T + " ADD COLUMN fallback_older INTEGER DEFAULT 0",
            };
            for (String sql : adds) {
                try {
                    db.execSQL(sql);
                } catch (Throwable ignored) {
                    // 列已存在
                }
            }
        }
        if (oldV < 3) {
            /* pending_at：那次「下载完、等用户装」是什么时候停下的。
               有了它才能判断停放是不是已经过期，没有就只能拍脑袋。 */
            try {
                db.execSQL("ALTER TABLE " + T + " ADD COLUMN pending_at INTEGER DEFAULT 0");
            } catch (Throwable ignored) {
                // 列已存在
            }
        }
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
                "latest_vname", "latest_asset", "latest_url", "notes", "skipped_tag",
                "asset_regex", "pending_file", "pending_tag", "pending_asset", "pinned_variant"
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
        o.put("fallbackOlder", c.getInt(c.getColumnIndex("fallback_older")) == 1);
        o.put("pendingFailed", c.getInt(c.getColumnIndex("pending_failed")));
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
    /**
     * 建立绑定。
     *
     * ⚠️ 两套版本号，别混着比 —— 这是最容易踩的坑：
     *
     *   - **Release tag**：GitHub 上发版时打的标签，如 V15 / 2.0.12
     *   - **versionName**：APK 里面写的版本号，如 1.1.1 / 2.0.11
     *
     *   它们是两个独立体系，**经常对不上**。开发者完全可能打 tag "V15"
     *   但 APK 里 versionName 还是 "1.1.1"。拿二者直接比就是苹果比橘子：
     *   用户明明装的就是 V15，系统却拿 versionName 1.1.1 去跟 tag V15 比，
     *   得出「有更新：1.1.1 → V15」—— 让用户去装一个他已经装着的版本。
     *
     * 所以比较**只在 tag 体系内进行**：
     *   - installed_tag = 我们记录的「装的是哪个 release」
     *   - latest_tag    = 仓库最新的 release
     *   两者同体系，可比。
     *
     * versionName（installed_vname）只用来**显示**给用户看，不参与比较。
     *
     * @param trustTag true 表示「确定装的就是 tag 这一版」（自动关联时成立，
     *                 是我们自己下载安装的）；false 表示不知道装的是哪版
     *                 （手动填 owner/repo 时成立，装的可能是任意旧版）
     */
    synchronized boolean add(String pkg, String owner, String repo, String appName,
                             String tag, String assetName, String assetUrl,
                             boolean trustTag) {
        if (pkg == null || pkg.isEmpty() || owner == null || repo == null) return false;
        SQLiteDatabase db = getWritableDatabase();
        try {
            DeviceInfo di = probe(pkg);
            String vname = di.present && di.versionName != null ? di.versionName : "";
            long instCode = di.present ? di.versionCode : 0L;

            /* 装的是哪一版：
               自动关联 → 就是这次下载的 tag，可信；
               手动关联 → 不知道，留空，比较时退回用 versionName 兜底。 */
            String instTag = trustTag && tag != null ? tag : "";

            boolean newer = false;
            if (trustTag && tag != null && !tag.isEmpty()) {
                // 装的就是这版，当然不算「有更新」
                newer = false;
            } else {
                long lc = codeOfTag(tag), cc = codeOfTag(vname);
                newer = (lc > 0 && cc > 0) ? lc > cc
                        : (lc > 0 && !tag.equals(vname));
            }

            /* ⚠️ 不能用 INSERT OR REPLACE：它会把整行换成默认+新值，
               用户钉的变体、asset 正则、忽略更新、跳过此版、预发布开关
               **全被冲掉**。自动更新走的正是这条路（pkg 已存在），
               用户钉的变体就没了。
               所以分两种：已存在就只更新「来源与版本」那几列。 */
            boolean exists = false;
            Cursor ex = null;
            try {
                ex = db.query(T, new String[]{"pkg"}, "pkg=?", new String[]{pkg},
                        null, null, null);
                exists = ex.moveToFirst();
            } finally {
                if (ex != null) try { ex.close(); } catch (Throwable ignored) { }
            }

            if (exists) {
                /* installed_asset 必须记下来。
                   一个仓库常常发多个包名（foss / premium、A / B），
                   没记住「这一行装的是哪个 asset」，下次挑更新就只会按
                   体积挑最大的 —— 于是点 A 的更新，下载并装上了 B。
                   用户看到的就是「我装的是 A，怎么绑成 B 了」。 */
                db.execSQL("UPDATE " + T + " SET owner=?, repo=?, app_name=?,"
                                + " installed_tag=?, installed_vname=?, installed_vcode=?,"
                                + " installed_asset=?,"
                                + " latest_tag=?, latest_asset=?, latest_url=?,"
                                + " fingerprint=?, has_update=?, checked_at=? WHERE pkg=?",
                        new Object[]{
                                owner, repo, appName == null ? pkg : appName,
                                instTag, vname, instCode,
                                assetName == null ? "" : assetName,
                                tag == null ? "" : tag, assetName, assetUrl,
                                di.present ? di.fingerprint : null,
                                newer ? 1 : 0, System.currentTimeMillis(), pkg
                        });
            } else {
                db.execSQL("INSERT INTO " + T + " (pkg,owner,repo,app_name,"
                                + "installed_tag,installed_vname,installed_vcode,"
                                + "installed_asset,"
                                + "latest_tag,latest_asset,latest_url,"
                                + "fingerprint,has_update,"
                                + "installed_at,updated_at,checked_at) "
                                + "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                        new Object[]{
                                pkg, owner, repo, appName == null ? pkg : appName,
                                instTag, vname, instCode,
                                assetName == null ? "" : assetName,
                                tag == null ? "" : tag, assetName, assetUrl,
                                di.present ? di.fingerprint : null,
                                newer ? 1 : 0,
                                System.currentTimeMillis(), System.currentTimeMillis(),
                                System.currentTimeMillis()
                        });
            }
            return true;
        } catch (Throwable t) {
            LogBook.error(ctx, "应用库写入失败", String.valueOf(t.getMessage()));
            return false;
        }
    }

    /** 手动关联：不知道装的是哪一版，trustTag=false。 */
    synchronized boolean add(String pkg, String owner, String repo, String appName,
                             String tag, String assetName, String assetUrl) {
        return add(pkg, owner, repo, appName, tag, assetName, assetUrl, false);
    }

    /**
     * 「已装是哪个 release」—— 一切比较的基准。
     *
     * installed_tag 可信就用它（tag 体系内比，同体系可比）；
     * 没有才退回 versionName（跨体系，可能误报，但总比不报强）。
     */
    private static String installedBase(String instTag, String vname) {
        if (instTag != null && !instTag.isEmpty()) return instTag;
        return vname == null ? "" : vname;
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
                /* ⚠️ baseline 必须是**系统读到的版本**，不是 installed_tag。
                   早期版本的 add() 把最新 tag 写进了 installed_tag，那批脏数据
                   会让「最新 2.0.12 vs 已装 2.0.12」永远相等 —— 一查就把
                   has_update 改成 0，角标随之消失。现在 vname 优先，
                   vname 没了才退回 tag。 */
                c = db.query(T, new String[]{"installed_vcode", "installed_tag",
                                "installed_vname", "skipped_tag", "ignore_update"},
                        "pkg=?", new String[]{pkg}, null, null, null);
                if (c.moveToFirst()) {
                    curCode = c.getLong(0);
                    String itag = c.getString(1);
                    String vname = c.getString(2);
                    // 基准：installed_tag 优先（同体系可比），没有才用 versionName
                    curTag = installedBase(itag, vname);
                    skipped = c.getString(3);
                    ignore = c.getInt(4);
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
     * 单项设置（对应 komi 的「每应用一套偏好」）
     * ============================================================ */

    /**
     * 改「这一行装的是哪个包」。
     *
     * 一个仓库发多个包名时自动挑可能挑错，或者用户换了另一个分支
     * （foss ↔ premium）。改掉 installed_asset，之后的更新就只认这一种身份。
     */
    synchronized boolean setInstalledAsset(String pkg, String assetName) {
        if (pkg == null || pkg.isEmpty()) return false;
        try {
            getWritableDatabase().execSQL(
                    "UPDATE " + T + " SET installed_asset=? WHERE pkg=?",
                    new Object[]{assetName == null ? "" : assetName, pkg});
            return true;
        } catch (Throwable t) {
            return false;
        }
    }

    /** 钉住变体：以后更新只认带这个串的 asset（如 arm64 / foss）。 */
    synchronized boolean setVariant(String pkg, String variant) {
        try {
            getWritableDatabase().execSQL("UPDATE " + T + " SET pinned_variant=?, pending_failed=0 WHERE pkg=?",
                    new Object[]{variant, pkg});
            return true;
        } catch (Throwable t) {
            return false;
        }
    }

    /** 高级过滤：asset 名正则 + 最新版没匹配上是否退到更旧的 release。 */
    synchronized boolean setAdvanced(String pkg, String regex, boolean fallbackOlder) {
        try {
            getWritableDatabase().execSQL("UPDATE " + T + " SET asset_regex=?, fallback_older=? WHERE pkg=?",
                    new Object[]{regex, fallbackOlder ? 1 : 0, pkg});
            return true;
        } catch (Throwable t) {
            return false;
        }
    }

    /**
     * 预览某个正则能匹配到哪些 asset。
     * 纯本地字符串匹配，不发请求 —— 前端拿到 release 列表后自己筛即可，
     * 这里只是把「存之前的核对」放在同一处，免得存进一条永远匹配不上的正则。
     */
    static JSONArray previewMatch(JSONArray assetNames, String regex) {
        JSONArray out = new JSONArray();
        if (assetNames == null) return out;
        try {
            java.util.regex.Pattern p = regex == null || regex.isEmpty()
                    ? null : java.util.regex.Pattern.compile(regex, java.util.regex.Pattern.CASE_INSENSITIVE);
            for (int i = 0; i < assetNames.length(); i++) {
                String n = assetNames.optString(i, "");
                if (!n.toLowerCase().endsWith(".apk")) continue;
                if (p == null || p.matcher(n).find()) out.put(n);
            }
        } catch (Throwable t) {
            try {
                // 正则写错了就把全部 APK 列出来，让用户自己看，而不是静默返回空
                for (int i = 0; i < assetNames.length(); i++) out.put(assetNames.optString(i, ""));
            } catch (Throwable ignored) { }
        }
        return out;
    }

    /* ============================================================
     * 待安装（parked install）
     * ============================================================ */

    /**
     * 下载完成、还没装上：这一行「停」在这，记住文件路径。
     * 装没装成不由这里判断 —— 下次 sync() 去问系统，别在回调里猜。
     */
    synchronized boolean markPending(String pkg, String tag, String assetName, String filePath) {
        try {
            getWritableDatabase().execSQL("UPDATE " + T + " SET pending=1, pending_tag=?,"
                            + " pending_asset=?, pending_file=?, pending_at=? WHERE pkg=?",
                    new Object[]{tag, assetName, filePath,
                            System.currentTimeMillis(), pkg});
            return true;
        } catch (Throwable t) {
            return false;
        }
    }

    /** 存过的匹配下载失败一次：下次别再信它，重新去查 release。 */
    synchronized boolean notePendingFailure(String pkg) {
        try {
            getWritableDatabase().execSQL("UPDATE " + T + " SET pending_failed=pending_failed+1 WHERE pkg=?",
                    new Object[]{pkg});
            return true;
        } catch (Throwable t) {
            return false;
        }
    }

    /**
     * 丢弃一次停放的安装：删文件、清状态。
     * 返回是否真的清掉了（文件已经没了也算清掉，不该让 UI 卡在这一步）。
     */
    synchronized boolean discardPending(String pkg) {
        try {
            SQLiteDatabase db = getWritableDatabase();
            String path = null;
            Cursor c = null;
            try {
                c = db.query(T, new String[]{"pending_file"}, "pkg=?", new String[]{pkg}, null, null, null);
                if (c.moveToFirst()) path = c.getString(0);
            } finally {
                if (c != null) try { c.close(); } catch (Throwable ignored) { }
            }
            if (path != null && path.length() > 0) {
                try {
                    File f = new File(path);
                    if (f.exists()) f.delete();
                } catch (Throwable ignored) { }
            }
            db.execSQL("UPDATE " + T + " SET pending=0, pending_tag=NULL, pending_asset=NULL,"
                    + " pending_file=NULL WHERE pkg=?", new Object[]{pkg});
            return true;
        } catch (Throwable t) {
            return false;
        }
    }

    /**
     * 已经下载好、还没装上的那个包的文件名（在 ApkProvider 目录里）。
     * 文件不在了返回 null —— 调用方据此决定是「直接装」还是「重新下」。
     */
    synchronized String pendingFile(String pkg) {
        try {
            Cursor c = null;
            String path = null;
            try {
                c = getReadableDatabase().query(T, new String[]{"pending_file"},
                        "pkg=?", new String[]{pkg}, null, null, null);
                if (c.moveToFirst()) path = c.getString(0);
            } finally {
                if (c != null) try { c.close(); } catch (Throwable ignored) { }
            }
            if (path == null || path.isEmpty()) return null;
            File f = new File(path);
            return f.exists() ? f.getName() : null;
        } catch (Throwable t) {
            return null;
        }
    }

    /** 文件还在不在（前端据此决定显示「安装」还是「重新下载」）。 */
    synchronized boolean pendingFileExists(String pkg) {
        try {
            Cursor c = null;
            String path = null;
            try {
                c = getReadableDatabase().query(T, new String[]{"pending_file"},
                        "pkg=?", new String[]{pkg}, null, null, null);
                if (c.moveToFirst()) path = c.getString(0);
            } finally {
                if (c != null) try { c.close(); } catch (Throwable ignored) { }
            }
            return path != null && path.length() > 0 && new File(path).exists();
        } catch (Throwable t) {
            return false;
        }
    }

    /* ============================================================
     * 「在 githup 里下载安装的应用」自动入账
     * ============================================================ */

    /**
     * 下载时先记一笔「这个 URL 装的是什么」。
     * url 作 key —— 装完才知道包名，中间只能靠 URL 对上号。
     */
    private static final java.util.Map<String, String[]> sTrack =
            new java.util.concurrent.ConcurrentHashMap<String, String[]>();

    private static android.content.SharedPreferences trackPrefs(Context ctx) {
        return ctx.getSharedPreferences(TRACK_PREF, Context.MODE_PRIVATE);
    }

    /**
     * 下载时先记一笔「这个 URL 装的是什么」。
     * url 作 key —— 装完才知道包名，中间只能靠 URL 对上号。
     *
     * ⚠️ 只存内存是不够的，这是「从 githup 里装的却记不上」的头号原因：
     *   下载是交给 DownloadManager 做的，期间本进程完全可能被系统回收。
     *   装完回调进来时进程是新起的，sTrack 是空的 —— 来源丢了，
     *   trackFromApk 拿不到 meta 就直接返回，一行都记不下。
     *   所以内存之外再往本机落一份，装完按同一个 URL 取回。
     */
    static void noteTrack(Context ctx, String url, String owner, String repo,
                          String tag, String asset) {
        if (ctx == null || url == null || url.isEmpty()
                || owner == null || repo == null) return;
        sTrack.put(url, new String[]{
                owner, repo,
                tag == null ? "" : tag,
                asset == null ? "" : asset
        });
        // 别让这张表无限长：下载多了一直堆着没意义
        if (sTrack.size() > 64) {
            String first = sTrack.keySet().iterator().next();
            if (first != null) sTrack.remove(first);
        }
        try {
            org.json.JSONObject o = new org.json.JSONObject();
            o.put("owner", owner);
            o.put("repo", repo);
            o.put("tag", tag == null ? "" : tag);
            o.put("asset", asset == null ? "" : asset);
            o.put("t", System.currentTimeMillis());
            trackPrefs(ctx).edit().putString(url, o.toString()).apply();
        } catch (Throwable ignored) {
            // 落盘失败还有内存那份兜着，不至于全丢
        }
    }

    /** 按 URL 取回来源。内存没有（进程重启过）就翻本机那份。 */
    private static String[] loadTrack(Context ctx, String url) {
        if (ctx == null || url == null) return null;
        try {
            String raw = trackPrefs(ctx).getString(url, null);
            if (raw == null) return null;
            org.json.JSONObject o = new org.json.JSONObject(raw);
            String owner = o.optString("owner", "");
            String repo = o.optString("repo", "");
            if (owner.isEmpty() || repo.isEmpty()) return null;
            long t = o.optLong("t", 0L);
            if (t > 0 && System.currentTimeMillis() - t > TRACK_KEEP_MS) return null;
            return new String[]{owner, repo,
                    o.optString("tag", ""), o.optString("asset", "")};
        } catch (Throwable t) {
            return null;
        }
    }

    /** 用掉就清，别让这张表一直堆着 */
    private static void clearTrack(Context ctx, String url) {
        if (ctx == null || url == null) return;
        try {
            trackPrefs(ctx).edit().remove(url).apply();
        } catch (Throwable ignored) { }
    }

    /**
     * APK 下完、还没交给安装器的时候调：读出包名，把这一笔落成台账的一行。
     *
     * 时机很关键 —— 必须**在拉起安装器之前**，因为这时候文件一定在，
     * 而且能读到确定无疑的包名。等用户装完再回头找文件，早被清掉了。
     *
     * 落库时置 pending：此刻还没装上，行先停在这，等下次 sync() 去
     * 问系统「到底装上没有」，不在这里猜。
     */
    static void trackFromApk(Context ctx, String url, File apk) {
        if (ctx == null || url == null || apk == null || !apk.exists()) return;
        String[] meta = sTrack.get(url);
        /* 内存里没有（进程重启过）就翻本机那份 —— 见 noteTrack 的注释 */
        if (meta == null) meta = loadTrack(ctx, url);
        if (meta == null) return;
        try {
            PackageManager pm = ctx.getPackageManager();
            PackageInfo pi = pm.getPackageArchiveInfo(
                    apk.getAbsolutePath(), PackageManager.GET_META_DATA);
            if (pi == null || pi.packageName == null || pi.packageName.isEmpty()) return;

            String appName = null;
            try {
                if (pi.applicationInfo != null) {
                    CharSequence lb = pi.applicationInfo.loadLabel(pm);
                    if (lb != null) appName = lb.toString();
                }
            } catch (Throwable ignored) { }
            if (appName == null || appName.isEmpty()) appName = pi.packageName;

            AppLibrary lib = get(ctx);
            /* trustTag=true：这个 APK 是我们自己下载安装的，装的就是 meta[2]
               这一版，确定无疑 —— 这正是后来比较的基准。 */
            lib.add(pi.packageName, meta[0], meta[1], appName, meta[2], meta[3], url, true);
            lib.markPending(pi.packageName, meta[2], meta[3], apk.getAbsolutePath());
            sTrack.remove(url);
            clearTrack(ctx, url);
        } catch (Throwable t) {
            // 入账失败不能影响安装本身，静默即可
        }
    }

    /**
     * 把一个 content:// / file:// 的 APK 读进 ApkProvider 目录，**顺便入账**。
     *
     * 为什么要有这个方法（而不是只在有 File 的地方入账）：
     *   DownloadManager 那条加速通道下完给的是 content:// 地址，不是 File，
     *   而 getPackageArchiveInfo 只认文件路径。所以先把内容落到自己的
     *   目录里，既能读包名，装的时候也用同一个地址 —— 一举两得。
     *
     * @return 落好的文件；失败返回 null（调用方照原样装就行，别因为入账失败
     *         就把安装也断了 —— 入账是顺手的事，安装才是用户要的）
     */
    static File stageApk(Context ctx, String url, Uri src, String name) {
        if (ctx == null || src == null) return null;
        try {
            File dir = new File(ctx.getFilesDir(), "apks");
            dir.mkdirs();
            String outName = safeFilePart(name == null || name.isEmpty()
                    ? "download.apk" : name);
            File dst = new File(dir, outName);
            boolean ok = false;
            java.io.InputStream in = null;
            java.io.OutputStream out = null;
            try {
                in = ctx.getContentResolver().openInputStream(src);
                if (in == null) return null;
                out = new java.io.FileOutputStream(dst);
                byte[] buf = new byte[64 * 1024];
                int n;
                while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
                out.flush();
                ok = true;
            } finally {
                if (in != null) try { in.close(); } catch (Throwable ignored) { }
                if (out != null) try { out.close(); } catch (Throwable ignored) { }
            }
            if (!ok || !dst.exists() || dst.length() <= 0) return null;
            trackFromApk(ctx, url, dst);
            return dst;
        } catch (Throwable t) {
            return null;
        }
    }

    /** 只取文件名那一段，挡掉路径分隔符和控制字符 */
    private static String safeFilePart(String raw) {
        String s = String.valueOf(raw);
        int i = s.lastIndexOf('/');
        if (i >= 0) s = s.substring(i + 1);
        /* 不用正则：\u0000 这类转义在 Java 里会被词法阶段先转成真实
         * 控制字符，直接写进正则就是「非法字符」。逐字符过滤没这个坑。 */
        StringBuilder sb = new StringBuilder();
        for (int k = 0; k < s.length(); k++) {
            char ch = s.charAt(k);
            if (ch == '/' || ch == '\\' || ch == ':' || ch == '*' || ch == '?'
                    || ch == '"' || ch == '<' || ch == '>' || ch == '|') {
                sb.append('_');
            } else if (ch < 0x20 || ch == 0x7f) {
                continue;                    // 控制字符直接丢掉
            } else {
                sb.append(ch);
            }
        }
        s = sb.toString();
        s = s.trim();
        if (s.isEmpty()) s = "download.apk";
        if (!s.toLowerCase().endsWith(".apk")) s += ".apk";
        return s;
    }

    /* ============================================================
     * 安装来源分类（komi 的 InstallerCategory，简化成本地实现）
     * ============================================================ */

    /** 按安装来源给设备应用排序：用户最可能想管的第三方侧载排最前。 */
    static int installerPriority(String installerPkg, boolean isUpdatedSystemApp, String pkg) {
        if (isUpdatedSystemApp) return 4;                       // SYSTEM_UPDATE
        if (installerPkg == null || installerPkg.isEmpty()) return 1;  // SIDELOADED
        if ("com.android.vending".equals(installerPkg)) return 2;      // PLAY_STORE
        if (SIDE_STORES.contains(installerPkg)) return 0;              // SIDE_STORE
        if (VENDOR_STORES.contains(installerPkg)) return 3;            // VENDOR_STORE
        if (pkg != null) {
            for (String pre : VENDOR_PREFIX) if (pkg.startsWith(pre)) return 3;
            for (String pre : SYSTEM_PREFIX) if (pkg.startsWith(pre)) return 4;
        }
        return 1;
    }

    static String installerLabel(int priority) {
        switch (priority) {
            case 0: return "侧载商店";
            case 1: return "侧载";
            case 2: return "Play";
            case 3: return "厂商商店";
            default: return "系统";
        }
    }

    private static final java.util.Set<String> SIDE_STORES = new java.util.HashSet<>();
    private static final java.util.Set<String> VENDOR_STORES = new java.util.HashSet<>();
    private static final String[] VENDOR_PREFIX = {
            "com.samsung.", "com.sec.", "com.huawei.", "com.hihonor.", "com.honor.",
            "com.xiaomi.", "com.miui.", "com.mi.", "com.heytap.", "com.oppo.",
            "com.coloros.", "com.oneplus.", "com.bbk.", "com.vivo.", "com.iqoo.",
            "com.amazon.", "com.motorola.", "com.lge.", "com.sonymobile."
    };
    private static final String[] SYSTEM_PREFIX = {
            "com.google.android.gms", "com.google.android.gsf", "com.android.", "android."
    };

    static {
        String[] side = {
                "org.fdroid.fdroid", "org.fdroid.basic", "dev.imranr.obtainium",
                "dev.imranr.obtainium.fdroid", "com.aurora.store", "com.looker.droidify",
                "com.machiav3lli.fdroid", "nya.kitsunyan.foxydroid", "com.hubmobile.app"
        };
        for (String s : side) SIDE_STORES.add(s);
        String[] vendor = {
                "com.sec.android.app.samsungapps", "com.huawei.appmarket", "com.xiaomi.market",
                "com.heytap.market", "com.oppo.market", "com.bbk.appstore",
                "com.hihonor.appmarket", "com.amazon.venezia"
        };
        for (String s : vendor) VENDOR_STORES.add(s);
    }

    /**
     * 可更新的数量。纯本地查表，不发请求 —— 这个数字要能在「我的」页
     * 秒回地显示出来，不能让人等着转圈。
     */
    /**
     * 可更新的数量。纯本地查表，不发请求 —— 这个数字要在「我的」页一进来
     * 就显示，不能让人等着转圈。
     *
     * ⚠️ 不直接读 has_update 那个标志位：它是 setLatest() 算完写进去的，
     *    一旦比较基准取错（见 setLatest 的注释）就会被写成 0 并把角标带走。
     *    这里拿最新 tag 跟**系统读到的版本**当场比一遍，标志位脏了也对。
     */
    synchronized int updateCount() {
        int n = 0;
        Cursor c = null;
        try {
            c = getReadableDatabase().query(T,
                    new String[]{"latest_tag", "installed_tag", "installed_vname",
                            "ignore_update", "pending", "skipped_tag"},
                    null, null, null, null, null);
            while (c.moveToNext()) {
                /* 只排除「忽略更新」。
                   ⚠️ 别把 pending（已下载待安装）也排除掉 —— 那正是
                   「点了更新、在系统安装器上取消」之后的状态，排除它，
                   用户一取消角标就消失，看起来像应用库把这条弄丢了。
                   pending 同样是「等用户处理」的事，就该继续提示。 */
                if (c.getInt(3) == 1) continue;
                String latest = c.getString(0);
                String itag = c.getString(1);
                String vname = c.getString(2);
                String cur = installedBase(itag, vname);
                String skipped = c.getString(5);
                if (latest == null || latest.isEmpty()) continue;
                if (skipped != null && skipped.equals(latest)) continue;
                long lc = codeOfTag(latest), cc = codeOfTag(cur);
                if (lc > 0 && cc > 0 ? lc > cc : !latest.equals(cur)) n++;
            }
        } catch (Throwable t) {
            return 0;
        } finally {
            if (c != null) try { c.close(); } catch (Throwable ignored) { }
        }
        return n;
    }

    /** 台账里最早一次 checked_at，前端据此决定要不要再查一轮。 */
    synchronized long oldestCheckedAt() {
        try {
            Cursor c = null;
            try {
                c = getReadableDatabase().rawQuery(
                        "SELECT MIN(checked_at) FROM " + T + " WHERE ignore_update=0", null);
                return (c != null && c.moveToFirst()) ? c.getLong(0) : 0L;
            } finally {
                if (c != null) try { c.close(); } catch (Throwable ignored) { }
            }
        } catch (Throwable t) {
            return 0L;
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

                /* 先把「是不是待安装、什么时候停下的」问出来 ——
                   下面「系统里没有」那支要靠它决定删不删。 */
                int pend = 0;
                long pendAt = 0;
                Cursor pc = null;
                try {
                    pc = db.query(T, new String[]{"pending", "pending_at"}, "pkg=?",
                            new String[]{p}, null, null, null);
                    if (pc.moveToFirst()) {
                        pend = pc.getInt(0);
                        pendAt = pc.getLong(1);
                    }
                } catch (Throwable ignored) {
                } finally {
                    if (pc != null) try { pc.close(); } catch (Throwable ignored) { }
                }

                if (!di.present) {
                    /*
                      ⚠️ 待安装的行**绝不能删**。

                      它是「下载完、还没装上」停在这儿的 —— 此刻系统上当然
                      还没有这个包。照「系统里没有就删」这条规矩处理，等于
                      用户下载完随手打开一次应用库，这一行就被抹掉了；等他
                      回去把包装上，台账里早就没了，再也不会记上来。

                      这正是「从 githup 里装的应用，应用库却不记录」的根：
                      记录是建了，转头被自己对账清掉了。

                      停放有时限：超过 PENDING_KEEP_MS 说明那次安装早没影了，
                      清掉标记，交回通用规则处置（该删就删）。
                    */
                    if (pend == 1 && pendAt > 0
                            && System.currentTimeMillis() - pendAt < PENDING_KEEP_MS) {
                        continue;
                    }
                    if (pend == 1) {
                        db.execSQL("UPDATE " + T + " SET pending=0, pending_tag=NULL,"
                                        + " pending_asset=NULL, pending_file=NULL WHERE pkg=?",
                                new Object[]{p});
                    }
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
                /* 顺手把 has_update 重算一遍：早期版本写进去的标志位可能是错的
                   （比较基准取了被污染的 installed_tag），这里按系统真值纠回来，
                   用户不用手动移除重加。 */
                try {
                    String lt = null, sk = null, base = null; int ig = 0;
                    Cursor q = null;
                    try {
                        q = db.query(T, new String[]{"latest_tag", "installed_tag",
                                        "skipped_tag", "ignore_update"},
                                "pkg=?", new String[]{p}, null, null, null);
                        if (q.moveToFirst()) {
                            lt = q.getString(0);
                            base = q.getString(1);
                            sk = q.getString(2);
                            ig = q.getInt(3);
                        }
                    } finally { if (q != null) try { q.close(); } catch (Throwable ignored) { } }
                    /* 基准优先 installed_tag；没有才用刚从系统读到的 versionName。
                       这样 APK 里 versionName 跟 release tag 对不上时（很常见），
                       也不会把「已装的这版」误判成「有更新」。 */
                    String cur = installedBase(base, di.versionName);
                    boolean newer = false;
                    if (lt != null && !lt.isEmpty() && ig == 0 && !(sk != null && sk.equals(lt))) {
                        long lc = codeOfTag(lt), cc = codeOfTag(cur);
                        newer = (lc > 0 && cc > 0) ? lc > cc
                                : (cc == 0 && !lt.equals(cur));
                    }
                    db.execSQL("UPDATE " + T + " SET has_update=? WHERE pkg=?",
                            new Object[]{newer ? 1 : 0, p});
                } catch (Throwable ignored) { }

                if (curCode != di.versionCode || fpChanged) {
                    /* 版本变了。但要看是**谁**装的：
                         pending=1 → 是我们自己下载安装的那次生效了，
                                     installed_tag 已被 trackFromApk 设成这一版，
                                     保留它，别清。
                         pending=0 → 用户在别处升/降过级，installed_tag 记的
                                     「我们装的哪一版」已经不准，清掉，
                                     让比较退回用 versionName 兜底。 */
                    if (pending == 1) {
                        db.execSQL("UPDATE " + T + " SET installed_vname=?, installed_vcode=?,"
                                        + " fingerprint=?, pending=0 WHERE pkg=?",
                                new Object[]{di.versionName, di.versionCode, di.fingerprint, p});
                    } else {
                        db.execSQL("UPDATE " + T + " SET installed_vname=?, installed_vcode=?,"
                                        + " fingerprint=?, installed_tag='', pending=0 WHERE pkg=?",
                                new Object[]{di.versionName, di.versionCode, di.fingerprint, p});
                    }
                    changed++;
                } else if (pending == 1) {
                    /* 版本没变却还标着 pending —— 说明上次那次安装没成
                       （用户在系统安装器上点了取消，或装失败了）。
                       清掉标记回到「有更新」，别让这一行永远卡在待安装。
                       文件也一并看一眼：留着占空间，丢了更不该再显示可装。 */
                    try {
                        Cursor pf = null;
                        String path = null;
                        try {
                            pf = db.query(T, new String[]{"pending_file"}, "pkg=?",
                                    new String[]{p}, null, null, null);
                            if (pf.moveToFirst()) path = pf.getString(0);
                        } finally { if (pf != null) try { pf.close(); } catch (Throwable ignored) { } }
                        if (path != null && path.length() > 0) {
                            File f = new File(path);
                            if (f.exists()) { try { f.delete(); } catch (Throwable ignored) { } }
                        }
                    } catch (Throwable ignored) { }
                    db.execSQL("UPDATE " + T + " SET pending=0, pending_tag=NULL,"
                                    + " pending_asset=NULL, pending_file=NULL WHERE pkg=?",
                            new Object[]{p});
                    resolved++;
                }
            }
        } catch (Throwable t) {
            LogBook.error(ctx, "应用库对账失败", String.valueOf(t.getMessage()));
        }
        return "{\"dropped\":" + dropped + ",\"resolved\":" + resolved + ",\"changed\":" + changed + "}";
    }

    /* ============================================================
     * 待安装的清理
     * ============================================================ */

    /**
     * 删掉停放的那个文件。文件已经没了也算删掉了 —— 不该让它卡住后面的动作。
     */
    private boolean deletePendingFile(String path) {
        if (path == null || path.isEmpty()) return false;
        try {
            File f = new File(path);
            if (!f.exists()) return true;
            return f.delete();
        } catch (Throwable t) {
            return false;
        }
    }

    /**
     * 把一行从「待安装」放下来：删掉停放的文件、清掉标记。
     * 这一行本身留着（应用可能早就装上了）。
     */
    private void releasePending(SQLiteDatabase db, String pkg) {
        try {
            Cursor c = null;
            String path = null;
            try {
                c = db.query(T, new String[]{"pending_file"}, "pkg=?",
                        new String[]{pkg}, null, null, null);
                if (c.moveToFirst()) path = c.getString(0);
            } finally { if (c != null) try { c.close(); } catch (Throwable ignored) { } }
            deletePendingFile(path);
        } catch (Throwable ignored) { }
        try {
            db.execSQL("UPDATE " + T + " SET pending=0, pending_tag=NULL,"
                            + " pending_asset=NULL, pending_file=NULL, pending_at=0 WHERE pkg=?",
                    new Object[]{pkg});
        } catch (Throwable ignored) { }
    }

    /**
     * 清掉**所有**停放中的安装。
     *
     * 用户清空下载记录时调：那次下载的记录都没了，停在「等安装」的这一行
     * 就失去了依托 —— 文件是我们替他暂存的，他清历史就等于说「这次下载
     * 作废」。留着会变成一堆永远停在待安装、点开又找不到文件的幽灵行。
     *
     * 分两种处置：
     *   · 这个包在设备上**还没有** → 那一行本就是「下载过但没装上」的临时
     *     记录，整行删掉。
     *   · 这个包**已经装上** → 只清标记，行保留。应用都装上了，台账里这条
     *     是有意义的，不能因为清下载历史就把整个应用库条目抹掉。
     *
     * @return [整行删掉的行数, 只清标记的行数]
     */
    synchronized int[] clearAllPending() {
        int dropped = 0, released = 0;
        try {
            SQLiteDatabase db = getWritableDatabase();
            List<String[]> rows = new ArrayList<>();
            Cursor c = null;
            try {
                c = db.query(T, new String[]{"pkg", "pending_file"}, "pending=1",
                        null, null, null, null);
                while (c.moveToNext()) rows.add(new String[]{c.getString(0), c.getString(1)});
            } finally { if (c != null) try { c.close(); } catch (Throwable ignored) { } }

            for (String[] r : rows) {
                String pkg = r[0];
                if (pkg == null || pkg.isEmpty()) continue;
                deletePendingFile(r[1]);
                /* 单点查一次系统：装上了就留行，没装上就整行删 */
                DeviceInfo di = probe(pkg);
                if (di.present) {
                    db.execSQL("UPDATE " + T + " SET pending=0, pending_tag=NULL,"
                                    + " pending_asset=NULL, pending_file=NULL, pending_at=0"
                                    + " WHERE pkg=?",
                            new Object[]{pkg});
                    released++;
                } else {
                    db.delete(T, "pkg=?", new String[]{pkg});
                    dropped++;
                }
            }
        } catch (Throwable t) {
            LogBook.error(ctx, "清理待安装失败", String.valueOf(t.getMessage()));
        }
        return new int[]{dropped, released};
    }

    /**
     * 按原始下载 URL 清掉对应的那一次停放。
     *
     * 用户在下载历史里**单条删除**时调：那一条记录没了，它对应的那次
     * 「下载完等安装」自然也该跟着作废 —— 跟清空全部是同一个道理，
     * 只是范围缩小到这一条。
     *
     * 只清「还没装上」的：已经装上的行是正常台账，删一条历史不该动它。
     *
     * @return 是否真的清掉了什么
     */
    synchronized boolean clearPendingByUrl(String url) {
        if (url == null || url.isEmpty()) return false;
        try {
            SQLiteDatabase db = getWritableDatabase();
            List<String[]> rows = new ArrayList<>();
            Cursor c = null;
            try {
                c = db.query(T, new String[]{"pkg", "pending_file"},
                        "pending=1 AND (installed_url=? OR latest_url=?)",
                        new String[]{url, url}, null, null, null);
                while (c.moveToNext()) rows.add(new String[]{c.getString(0), c.getString(1)});
            } finally { if (c != null) try { c.close(); } catch (Throwable ignored) { } }
            if (rows.isEmpty()) return false;

            for (String[] r : rows) {
                String pkg = r[0];
                if (pkg == null || pkg.isEmpty()) continue;
                deletePendingFile(r[1]);
                DeviceInfo di = probe(pkg);
                if (di.present) {
                    db.execSQL("UPDATE " + T + " SET pending=0, pending_tag=NULL,"
                                    + " pending_asset=NULL, pending_file=NULL, pending_at=0"
                                    + " WHERE pkg=?",
                            new Object[]{pkg});
                } else {
                    db.delete(T, "pkg=?", new String[]{pkg});
                }
            }
            return true;
        } catch (Throwable t) {
            return false;
        }
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
                // 安装来源：用户最可能想管的是自己侧载的那些，排在最前
                String ip = null;
                if (Build.VERSION.SDK_INT >= 30) {
                    try { ip = pm.getInstallSourceInfo(pkg).getInstallingPackageName(); } catch (Throwable ignored) { }
                }
                if (ip == null) {
                    try { ip = pm.getInstallerPackageName(pkg); } catch (Throwable ignored) { }
                }
                int pri = installerPriority(ip, isSystem, pkg);
                o.put("priority", pri);
                o.put("sourceLabel", installerLabel(pri));
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
