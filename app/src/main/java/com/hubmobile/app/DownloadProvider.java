package com.hubmobile.app;

import android.app.DownloadManager;
import android.content.ContentProvider;
import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;

import java.io.File;
import java.io.FileNotFoundException;

/**
 * 给外部应用（系统安装器、文件查看器）以及本应用自己，提供已下载文件的读权限。
 *
 * 为什么需要：Android 7.0 起禁止把 file:// 直接抛给外部应用，必须走 content://。
 * 下载的 APK 躺在 Download/githup/ 里 —— 之前直接拿 DownloadManager 给的
 * file:// 去拉安装器，新系统上会被静默拦掉，表现就是「下载完成了却装不了」。
 *
 * 与 ApkProvider 同样的思路：不引 androidx 的 FileProvider，几十行自足。
 * 只暴露下载目录里的文件，路径只取 URI 最后一段且禁止分隔符与「..」，
 * 不存在路径穿越风险。
 *
 * ============================================================
 * 2026-09-19 重要修复
 * ============================================================
 * 以前这里**自己拼路径**找文件：
 *
 *     Environment.getExternalStoragePublicDirectory(DOWNLOADS) + "/githup/" + name
 *
 * 这条路径在 Android 10 之前没问题，因为那时 App 有公共目录的直读权限。
 * 但从 Android 10（API 29）引入**分区存储**之后，App 用这条路径**看不到**
 * DownloadManager 写进去的文件 —— 目录还叫那个名字，看到的却是应用沙箱里的
 * 影子目录，里面是空的。
 *
 * 后果是连锁的，而且全都指向同一句报错：
 *
 *   下载完成 → installFinished() → verifySha() 读文件
 *     → openFile() → !f.exists() → throw FileNotFoundException
 *     → 用户看到「已阻止安装：校验失败：FileNotFoundException」
 *
 * **文件其实完好无损**（用户看到的 743.4 KB 就是完整包），只是读它的路走错了。
 * 「下载管理」里点打开、删除，走的也是同一个错路径，所以同样失灵。
 *
 * 现在改成向 DownloadManager 要文件位置 —— 它是下载的发起方，
 * {@link DownloadManager#getUriForDownloadedFile(long)} 拿到的地址
 * 在任何 Android 版本上都是权威、可读的。给不出时才退回老的公共目录路径，
 * 让 Android 9 及以下（以及外部直接传文件名进来的调用方）继续能用。
 */
public class DownloadProvider extends ContentProvider {

    /** 与 AndroidManifest 中 authorities 的后缀保持一致 */
    static final String AUTHORITY_SUFFIX = ".downloads";

    static Uri uriFor(String pkg, String fileName) {
        return Uri.parse("content://" + pkg + AUTHORITY_SUFFIX + "/" + Uri.encode(fileName));
    }

    /**
     * 文件在公共下载目录里的**名义**位置。
     *
     * 只作为兜底使用：Android 10+ 分区存储下 App 直接访问这个路径拿不到文件，
     * 优先用 {@link #resolve(Context, String)}。
     */
    static File fileFor(String fileName) {
        return new File(new File(android.os.Environment.getExternalStoragePublicDirectory(
                android.os.Environment.DIRECTORY_DOWNLOADS), JsBridge.DOWNLOAD_SUBDIR), fileName);
    }

    /**
     * 找名字叫 fileName 的已下载文件，返回真实可读的位置。
     *
     * 顺序：
     *   1) DownloadManager 的记录（权威，Android 10+ 唯一可靠的来源）
     *   2) 公共下载目录下的名义路径（Android 9 及以下兜底）
     *
     * @return 找到返回文件对象；彻底找不到返回 null。**不保证返回的文件此刻存在** ——
     *         调用方要么再判一次 exists()，要么直接用返回的地址去读并处理异常。
     */
    static File resolve(Context ctx, String fileName) {
        if (fileName == null || fileName.isEmpty()) return null;
        if (fileName.contains("/") || fileName.contains("\\") || fileName.contains("..")) return null;

        File fromDm = fromDownloadManager(ctx, fileName);
        if (fromDm != null) return fromDm;

        File legacy = fileFor(fileName);
        return legacy.exists() ? legacy : null;
    }

    /**
     * 从 DownloadManager 的历史记录里按文件名找最近一次下载的落盘位置。
     *
     * 为什么按名字而不是按 id：这个 Provider 是被系统安装器以外部的身份调用的，
     * 拿到的只有 URI 里的文件名（{@code content://…/githup-1.1.3.apk}），
     * 没有下载 id。按标题/文件名反查是这里唯一能走通的路。
     */
    private static File fromDownloadManager(Context ctx, String fileName) {
        if (ctx == null) return null;
        Cursor c = null;
        try {
            DownloadManager dm = (DownloadManager) ctx.getSystemService(Context.DOWNLOAD_SERVICE);
            if (dm == null) return null;
            c = dm.query(new DownloadManager.Query().setFilterByStatus(
                    DownloadManager.STATUS_SUCCESSFUL | DownloadManager.STATUS_RUNNING
                            | DownloadManager.STATUS_PAUSED | DownloadManager.STATUS_PENDING));
            if (c == null) return null;

            int iLocal = c.getColumnIndex(DownloadManager.COLUMN_LOCAL_URI);
            int iTitle = c.getColumnIndex(DownloadManager.COLUMN_TITLE);
            if (iTitle < 0) return null;

            File fallback = null;
            while (c.moveToNext()) {
                String title = c.getString(iTitle);
                if (title == null || !title.equals(fileName)) continue;

                /* 用 getUriForDownloadedFile 而不是去解 COLUMN_LOCAL_URI 字符串：
                 * 后者在 Android 10+ 可能给的是 content:// 形式的 MediaStore 地址，
                 * 各 ROM 写法还不一致；前者是官方 API，返回 file:// 或 content://
                 * 都能被 ContentResolver 正确打开。 */
                int iId = c.getColumnIndex(DownloadManager.COLUMN_ID);
                if (iId >= 0) {
                    long id = c.getLong(iId);
                    Uri u = null;
                    try { u = dm.getUriForDownloadedFile(id); } catch (Throwable ignored) { }
                    File f = fileOf(ctx, u);
                    if (f != null) return f;
                }

                if (iLocal >= 0) {
                    String local = c.getString(iLocal);
                    if (local != null && !local.isEmpty()) {
                        File f = fileOf(ctx, Uri.parse(local));
                        /* 同一文件名可能有多次下载记录：先记住一个存在的，
                         * 但继续往后找更新的记录，找不到更好的就用它。 */
                        if (f != null) { if (fallback == null) fallback = f; }
                    }
                }
            }
            return fallback;
        } catch (Throwable ignored) {
            return null;
        } finally {
            if (c != null) c.close();
        }
    }

    /** 把一个 file:// 或 content:// 地址还原成 File；还原不出或文件不存在则 null */
    private static File fileOf(Context ctx, Uri u) {
        if (u == null) return null;
        try {
            if ("file".equalsIgnoreCase(u.getScheme())) {
                File f = new File(u.getPath() == null ? "" : u.getPath());
                return f.exists() && f.isFile() ? f : null;
            }
            /* content:// 的写法各 ROM 不同，直接拿路径可能不是文件系统路径。
             * 不强行还原，交给调用方用 ContentResolver 打开 —— 这里只为
             * openFile() 服务，它有另外一条处理分支。 */
            return null;
        } catch (Throwable ignored) {
            return null;
        }
    }

    @Override
    public boolean onCreate() {
        return true;
    }

    @Override
    public ParcelFileDescriptor openFile(Uri uri, String mode) throws FileNotFoundException {
        String name = uri.getLastPathSegment();
        if (name == null || name.isEmpty() || name.contains("/") || name.contains("\\")) {
            throw new FileNotFoundException("bad name");
        }
        if (name.contains("..")) throw new FileNotFoundException("bad name");

        /* 第一优先：问 DownloadManager 要这个文件的读句柄。
         * 它在任何 Android 版本上都给得出可读的地址，也绕开了分区存储。 */
        ParcelFileDescriptor pfd = openViaDownloadManager(name);
        if (pfd != null) return pfd;

        /* 兜底：公共下载目录下的名义路径（Android 9 及以下，或外部传文件名进来） */
        File f = resolve(getContext(), name);
        if (f == null || !f.exists() || !f.isFile()) {
            throw new FileNotFoundException("找不到已下载的文件：" + name);
        }
        return ParcelFileDescriptor.open(f, ParcelFileDescriptor.MODE_READ_ONLY);
    }

    /** 通过 DownloadManager 打开指定文件名的已下载文件，拿不到返回 null */
    private ParcelFileDescriptor openViaDownloadManager(String fileName) {
        Context ctx = getContext();
        if (ctx == null) return null;
        Cursor c = null;
        try {
            DownloadManager dm = (DownloadManager) ctx.getSystemService(Context.DOWNLOAD_SERVICE);
            if (dm == null) return null;
            c = dm.query(new DownloadManager.Query());
            if (c == null) return null;
            int iTitle = c.getColumnIndex(DownloadManager.COLUMN_TITLE);
            int iId = c.getColumnIndex(DownloadManager.COLUMN_ID);
            if (iTitle < 0 || iId < 0) return null;

            while (c.moveToNext()) {
                String title = c.getString(iTitle);
                if (title == null || !title.equals(fileName)) continue;
                long id = c.getLong(iId);
                /* 官方 API：拿到的是「这个下载任务产出的文件」的地址，
                 * 分区存储与否都不影响可读性。 */
                try {
                    Uri u = dm.getUriForDownloadedFile(id);
                    if (u != null) {
                        ParcelFileDescriptor p = ctx.getContentResolver().openFileDescriptor(u, "r");
                        if (p != null) return p;
                    }
                } catch (Throwable ignored) { }
                /* 官方 API 在某些 ROM 上返回 null，退回 openDownloadedFile */
                try {
                    return dm.openDownloadedFile(id);
                } catch (Throwable ignored) { }
            }
        } catch (Throwable ignored) {
        } finally {
            if (c != null) c.close();
        }
        return null;
    }

    @Override
    public String getType(Uri uri) {
        return mimeFor(uri.getLastPathSegment());
    }

    @Override
    public Cursor query(Uri uri, String[] projection, String selection,
                        String[] selectionArgs, String sortOrder) {
        /* 返回 _data 列（文件绝对路径）：签名校验等逻辑拿到 content:// 后
         * 会按惯例查这一列来还原真实路径。之前这里返回 null，导致
         * 「无法验证安装包签名」的误报 —— 包明明是官方签的却被拦下。
         *
         * 注意：Android 10 起 _data 这一列对调用方的可见性变差，
         * 所以它只能算「尽力而为」的一路，真正的读取走 openFile()。 */
        String name = uri.getLastPathSegment();
        if (name == null || name.isEmpty()
                || name.contains("/") || name.contains("\\") || name.contains("..")) {
            return null;
        }
        File f = resolve(getContext(), name);
        if (f == null) return null;
        MatrixCursor c = new MatrixCursor(new String[]{"_data", "_size", "_display_name"}, 1);
        c.addRow(new Object[]{f.getAbsolutePath(), f.length(), name});
        return c;
    }

    @Override
    public Uri insert(Uri uri, ContentValues values) {
        return null;
    }

    @Override
    public int delete(Uri uri, String selection, String[] selectionArgs) {
        return 0;
    }

    @Override
    public int update(Uri uri, ContentValues values, String selection, String[] selectionArgs) {
        return 0;
    }

    /** 按扩展名猜 MIME，给「打开文件」用 */
    static String mimeFor(String name) {
        if (name == null) return "application/octet-stream";
        String n = name.toLowerCase();
        if (n.endsWith(".apk")) return "application/vnd.android.package-archive";
        if (n.endsWith(".zip")) return "application/zip";
        if (n.endsWith(".pdf")) return "application/pdf";
        if (n.endsWith(".png")) return "image/png";
        if (n.endsWith(".jpg") || n.endsWith(".jpeg")) return "image/jpeg";
        if (n.endsWith(".gif")) return "image/gif";
        if (n.endsWith(".webp")) return "image/webp";
        if (n.endsWith(".svg")) return "image/svg+xml";
        if (n.endsWith(".mp3")) return "audio/mpeg";
        if (n.endsWith(".ogg")) return "audio/ogg";
        if (n.endsWith(".wav")) return "audio/wav";
        if (n.endsWith(".mp4")) return "video/mp4";
        if (n.endsWith(".webm")) return "video/webm";
        if (n.endsWith(".txt") || n.endsWith(".log") || n.endsWith(".md")) return "text/plain";
        if (n.endsWith(".html") || n.endsWith(".htm")) return "text/html";
        if (n.endsWith(".json")) return "application/json";
        if (n.endsWith(".xml")) return "text/xml";
        if (n.endsWith(".csv")) return "text/csv";
        if (n.endsWith(".tgz") || n.endsWith(".gz")) return "application/gzip";
        if (n.endsWith(".tar")) return "application/x-tar";
        if (n.endsWith(".jar")) return "application/java-archive";
        return "application/octet-stream";
    }
}
