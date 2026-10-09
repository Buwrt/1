package com.hubmobile.app;

import android.content.Context;
import android.os.Build;
import android.os.Environment;
import android.util.Log;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.List;
import java.util.Locale;

/**
 * 错误日志：把「用着用着出的毛病」记成一份谁都看得懂的小本子。
 *
 * 它和崩溃自记（CrashLog）的分工 ——
 *   CrashLog 只管「进程崩了没有」，记的是完整 Java 堆栈；
 *   LogBook 管「功能不好使了没有」——翻译引擎全挂、请求一直失败、
 *   页面脚本报错、关键操作，这些都不会让 App 崩，但都是用户真实碰到的问题。
 *
 * 为什么不用专业术语 ——
 *   这份日志是给普通用户看的，也是给帮忙排查的人 / AI 看的。
 *   写「翻译引擎全部不可用」比写「NoAvailableEngineException at
 *   TranslateService:2633」有用得多 —— 前者谁都能看懂，后者要人去翻代码。
 *
 * 存在哪 ——
 *   /storage/emulated/0/Download/githup/错误日志/错误日志-2026-10-01.txt
 *   放在公共目录，用户用手机自带的「文件管理」就能找到、直接发给别人，
 *   不用先学会「应用私有目录」这种东西。
 *
 * 按天清零 ——
 *   文件名带日期。第二天第一次写日志时，老文件原样留在那儿（用户想看还能看），
 *   但新的一天从空白开始 —— 「今天出过什么问题」一打开就是干净的。
 *   同时只保留最近 7 天，更早的自动删掉。
 *
 * 写失败怎么办 ——
 *   Android 10+ 的公共目录受分区存储限制。所以这里备了三级退路：
 *   公共 Download 目录 → 应用外部目录 → 应用内部目录。哪级能写用哪级；
 *   真的一处都写不进也绝不抛异常（用户不该因为记日志失败而受影响）。
 */
final class LogBook {

    private LogBook() { }

    /**
     * 公共目录里的子目录名（两个常量，用错一个文件就「消失」）——
     *
     *   File 直接写（Android 9 及以下）：父目录已经是 Download，
     *   这里只写 Download 下面的部分。
     *
     *   MediaStore（Android 10+）：RELATIVE_PATH 必须从存储根算起，
     *   且必须以 "Download/" 开头。传 "githup/错误日志" 会在 insert 时
     *   直接抛 IllegalArgumentException（Primary directory not allowed），
     *   而且写入失败被我们 catch 住了 —— 表现就是一切看着正常，
     *   文件却永远落不进公共目录，悄悄退到了私有目录。
     *   上一版「按路径找不到文件」就是这个原因。
     */
    private static final String PUBLIC_SUBDIR = "githup/错误日志";
    /** MediaStore 的 RELATIVE_PATH：从存储根算起，必须以 "Download/" 开头 */
    private static final String PUBLIC_RELATIVE = "Download/" + PUBLIC_SUBDIR;
    /** 日志文件名前缀与后缀 */
    private static final String FILE_PREFIX = "错误日志-";
    /** 保留最近几天 */
    private static final int KEEP_DAYS = 7;
    /** 单个文件上限，超了另起一个（免一天写到几十兆） */
    private static final long MAX_BYTES = 512L * 1024L;

    private static volatile boolean installed = false;
    private static volatile boolean sessionMarked = false;
    /** 已经探测出可写的目录，缓存起来省得每次写都探一遍 */
    private static volatile File resolvedDir = null;

    /* ==================================================================
     *  初始化
     * ================================================================== */

    /** App.onCreate 调一次：清掉过期日志。 */
    static void install(Context ctx) {
        if (ctx == null || installed) return;
        installed = true;
        try { cleanOld(ctx); } catch (Throwable ignored) { }
    }

    /**
     * 每个界面起来时调一次，保证热启动也有个起点。
     * （覆盖安装后系统常沿用旧进程，Application.onCreate 不再触发，
     *  不补这一条的话当天第一行日志会缺上下文。）
     */
    static void markSession(Context ctx, String where) {
        if (ctx == null || sessionMarked) return;
        sessionMarked = true;
        note(ctx, "打开应用（" + nz(where, "界面") + "）");
    }

    /* ==================================================================
     *  写日志（对外就这三个方法）
     * ================================================================== */

    /**
     * 记一条错误：功能出问题了。
     *
     * @param what 大白话描述，如「翻译引擎全部不可用」
     * @param why  补充原因（可为空），如「试了 5 个引擎都没响应」
     */
    static void error(Context ctx, String what, String why) {
        if (ctx == null || what == null) return;
        write(ctx, "【出错了】" + what + (isBlank(why) ? "" : "。" + why));
    }

    /**
     * 记一条普通记录：关键操作，用来还原「我当时在干什么」。
     *
     * @param what 如「开始翻译」/「退出登录」/「上传文件：xxx.zip」
     */
    static void note(Context ctx, String what) {
        if (ctx == null || what == null) return;
        write(ctx, "· " + what);
    }

    /**
     * 记崩溃：由 CrashLog 在最外层异常处理器里转交。
     * 这条路必须最省事、最不可能失败。
     *
     * @param brief 一句话摘要
     * @param stack 完整堆栈（可为空）
     */
    static void crash(Context ctx, String brief, String stack) {
        if (ctx == null) return;
        StringBuilder sb = new StringBuilder();
        sb.append("【闪退了】").append(nz(brief, "程序异常退出"));
        if (stack != null && !stack.isEmpty()) {
            sb.append("\n    详细堆栈（给开发者看）：");
            for (String l : stack.split("\n")) {
                if (l.trim().isEmpty()) continue;
                sb.append("\n      ").append(l.trim());
            }
        }
        write(ctx, sb.toString());
    }

    /* ==================================================================
     *  实际落盘
     * ================================================================== */

    private static void write(Context ctx, String text) {
        String line = stamp() + "  " + text + "\n";

        /* 首选：写公共 Download/githup/错误日志/（走 MediaStore，
         * 分区存储下唯一合法的写法）。用户用文件管理器能直接找到。 */
        if (appendToPublic(ctx, line)) return;

        /* 退路：写应用私有目录，至少把证据留住 */
        try {
            File dir = logDir(ctx);
            if (dir == null) return;
            if (!dir.exists() && !dir.mkdirs()) return;

            File f = todayFile(dir);
            f = rotateIfNeeded(f);   // 写满了就换下一个文件（必须接住返回值）

            FileOutputStream fos = null;
            try {
                fos = new FileOutputStream(f, true);
                fos.write(line.getBytes("UTF-8"));
                fos.flush();
            } finally {
                close(fos);
            }
        } catch (Throwable t) {
            // 记日志失败绝不能影响 App 本身
            try { Log.w("githup-log", "写日志失败: " + t); } catch (Throwable ignored) { }
        }
    }

    /* ---------------- 公共目录（MediaStore）----------------
     *
     * Android 10 起，App 不能再用 File 直接往公共 Download 目录写东西，
     * 必须通过 MediaStore 登记一个条目，再往里写数据流。
     * 这也是唯一能让用户「用文件管理器按平常路径找到」的合法做法。
     *
     * 两段式（API 29+）：
     *   1. 插入一条记录，IS_PENDING=1（表示「还在写，先别给别人看」）
     *   2. 写数据流
     *   3. 把 IS_PENDING 改回 0（提交，这时才真正出现在文件管理器里）
     *
     * Android 9 及以下没有分区存储，直接 File 写就行。
     */

    /** 追加一行到公共目录的当天日志；成功返回 true */
    private static boolean appendToPublic(Context ctx, String line) {
        try {
            if (Build.VERSION.SDK_INT < 29) return appendToPublicLegacy(ctx, line);
            return appendToPublicModern(ctx, line);
        } catch (Throwable t) {
            return false;
        }
    }

    /**
     * API 29+：把一行追加到公共目录里的当天日志。
     *
     * 关键点：MediaStore 每条记录就是「一个文件」，不能对同一条反复 insert
     * （那样文件管理器里会冒出一串同名文件）。所以是先按文件名查：
     *   找到今天那条 → 读出原内容 + 新行，用「wt」整份重写
     *   没找到        → 才新建一条
     * 无论哪条路，文件管理器里今天始终只有一个
     * 「错误日志-2026-10-01.txt」。
     */
    private static boolean appendToPublicModern(Context ctx, String line) {
        android.content.ContentResolver cr = ctx.getContentResolver();
        if (cr == null) return false;
        android.net.Uri parent = android.provider.MediaStore.Downloads.EXTERNAL_CONTENT_URI;
        String name = FILE_PREFIX + todayStr() + ".txt";

        android.net.Uri item = findPublicToday(ctx);

        android.content.ContentValues cv = new android.content.ContentValues();
        cv.put(android.provider.MediaStore.MediaColumns.DISPLAY_NAME, name);
        cv.put(android.provider.MediaStore.MediaColumns.MIME_TYPE, "text/plain");
        cv.put(android.provider.MediaStore.MediaColumns.RELATIVE_PATH, PUBLIC_RELATIVE);
        cv.put(android.provider.MediaStore.MediaColumns.IS_PENDING, 1);

        if (item == null) {
            item = cr.insert(parent, cv);
            if (item == null) return false;
        } else {
            // 已有：标回 pending，免得别人读到写一半的内容
            try { cr.update(item, cv, null, null); } catch (Throwable ignored) { }
        }

        java.io.OutputStream os = null;
        try {
            // 先读旧内容（刚新建的记录读出来是空的，正好）
            byte[] old = readPublic(ctx, item);
            os = cr.openOutputStream(item, "wt");
            if (os == null) return false;
            if (old != null && old.length > 0) os.write(old);
            os.write(line.getBytes("UTF-8"));
            os.flush();
        } catch (Throwable t) {
            return false;
        } finally {
            close(os);
        }

        // 提交：这一步之后文件才在文件管理器里可见
        android.content.ContentValues done = new android.content.ContentValues();
        done.put(android.provider.MediaStore.MediaColumns.IS_PENDING, 0);
        try { cr.update(item, done, null, null); } catch (Throwable ignored) { }

        return true;
    }

    /** API ≤28：没有分区存储，直接 File 写 */
    private static boolean appendToPublicLegacy(Context ctx, String line) {
        try {
            File pub = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS);
            if (pub == null) return false;
            File dir = new File(pub, PUBLIC_SUBDIR);
            if (!dir.exists() && !dir.mkdirs()) return false;
            File f = new File(dir, FILE_PREFIX + todayStr() + ".txt");
            FileOutputStream fos = null;
            try {
                fos = new FileOutputStream(f, true);
                fos.write(line.getBytes("UTF-8"));
                fos.flush();
            } finally {
                close(fos);
            }
            return true;
        } catch (Throwable t) {
            return false;
        }
    }

    /** 读公共目录里某个条目已有的内容 */
    private static byte[] readPublic(Context ctx, android.net.Uri item) {
        java.io.InputStream in = null;
        try {
            in = ctx.getContentResolver().openInputStream(item);
            if (in == null) return null;
            java.io.ByteArrayOutputStream bos = new java.io.ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int r;
            while ((r = in.read(buf)) > 0) bos.write(buf, 0, r);
            return bos.toByteArray();
        } catch (Throwable t) {
            return null;
        } finally {
            close(in);
        }
    }

    /**
     * 查公共目录里今天那个日志条目的 Uri。
     *
     * MediaStore 里同一个文件名会反复出现（每次 insert 都是一条新记录），
     * 所以按名字查最新的那条，用它来读/追加。
     */
    private static android.net.Uri findPublicToday(Context ctx) {
        try {
            if (Build.VERSION.SDK_INT < 29) {
                File pub = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS);
                if (pub == null) return null;
                File f = new File(new File(pub, PUBLIC_SUBDIR), FILE_PREFIX + todayStr() + ".txt");
                return f.exists() ? android.net.Uri.fromFile(f) : null;
            }
            String name = FILE_PREFIX + todayStr() + ".txt";
            android.database.Cursor c = ctx.getContentResolver().query(
                    android.provider.MediaStore.Downloads.EXTERNAL_CONTENT_URI,
                    new String[]{android.provider.MediaStore.MediaColumns._ID},
                    android.provider.MediaStore.MediaColumns.DISPLAY_NAME + "=?",
                    new String[]{name}, null);
            if (c == null) return null;
            try {
                if (c.moveToFirst()) {
                    long id = c.getLong(0);
                    return android.content.ContentUris.withAppendedId(
                            android.provider.MediaStore.Downloads.EXTERNAL_CONTENT_URI, id);
                }
            } finally {
                try { c.close(); } catch (Throwable ignored) { }
            }
        } catch (Throwable ignored) { }
        return null;
    }

    /**
     * 选一个能写的目录，三级退路。
     *
     * 【为什么不能只靠 File 直接写公共 Download】
     *   Android 10+ 分区存储禁止 App 直接 File 写公共目录。用户设备是
     *   Android 15，直接写必然失败 —— 之前那版会静默退到应用私有目录，
     *   用户按说的路径去找根本找不到。
     *   所以公共目录这条走 MediaStore（见 publicDownloadUri），
     *   这里只负责「探出私有退路」。
     *
     *  1) 公共 Download/githup/错误日志/ —— 走 MediaStore，用户最好找
     *  2) 应用外部目录 Android/data/<pkg>/files/错误日志/ —— 分区存储下一定可写
     *  3) 应用内部目录 files/错误日志/ —— 兜底，用户看不到但至少留住证据
     */
    private static File logDir(Context ctx) {
        File cached = resolvedDir;
        if (cached != null) return cached;

        List<File> candidates = new ArrayList<File>();
        try {
            File ext = ctx.getExternalFilesDir(null);
            if (ext != null) candidates.add(new File(ext, "错误日志"));
        } catch (Throwable ignored) { }
        try {
            candidates.add(new File(ctx.getFilesDir(), "错误日志"));
        } catch (Throwable ignored) { }

        for (File d : candidates) {
            try {
                if (!d.exists() && !d.mkdirs()) continue;
                if (!d.isDirectory()) continue;
                // 真写一个探针文件确认 —— canWrite() 在分区存储下会骗人
                File probe = new File(d, ".probe");
                FileOutputStream pout = null;
                try {
                    pout = new FileOutputStream(probe, false);
                    pout.write('x');
                    pout.flush();
                } finally {
                    close(pout);
                }
                probe.delete();
                resolvedDir = d;
                return d;
            } catch (Throwable ignored) { }
        }
        return null;
    }

    /** 当天的日志文件：错误日志-2026-10-01.txt */
    private static File todayFile(File dir) {
        return new File(dir, FILE_PREFIX + todayStr() + ".txt");
    }

    /**
     * 一天写满上限后，另起一个带序号的文件继续写。
     * 返回「接下来该写哪个文件」—— 调用方必须接收返回值。
     */
    private static File rotateIfNeeded(File f) {
        try {
            if (!f.exists() || f.length() < MAX_BYTES) return f;
            for (int i = 2; i < 100; i++) {
                File alt = new File(f.getParentFile(), FILE_PREFIX + todayStr() + "-" + i + ".txt");
                if (!alt.exists()) {
                    FileOutputStream fos = null;
                    try { fos = new FileOutputStream(alt, true); } finally { close(fos); }
                    return alt;
                }
                if (alt.length() < MAX_BYTES) return alt;
            }
        } catch (Throwable ignored) { }
        return f;
    }

    /** 删掉超过 KEEP_DAYS 天的日志文件 */
    private static void cleanOld(Context ctx) {
        try {
            File dir = logDir(ctx);
            if (dir == null) return;
            File[] all = dir.listFiles();
            if (all == null) return;
            long cutoff = System.currentTimeMillis() - KEEP_DAYS * 24L * 3600L * 1000L;
            for (File f : all) {
                try {
                    if (f.isFile() && f.lastModified() < cutoff) f.delete();
                } catch (Throwable ignored) { }
            }
        } catch (Throwable ignored) { }
    }

    /* ==================================================================
     *  读取
     * ================================================================== */

    /**
     * 把今天的日志整个读出来；没有就返回空串。
     * 优先读公共目录（那才是权威副本），读不到再退私有目录。
     */
    static String readToday(Context ctx) {
        try {
            // 1) 公共目录
            android.net.Uri u = findPublicToday(ctx);
            if (u != null) {
                byte[] b = readPublic(ctx, u);
                if (b != null && b.length > 0) return new String(b, "UTF-8");
            }
            // 2) 私有退路
            File dir = logDir(ctx);
            if (dir == null) return "";
            StringBuilder sb = new StringBuilder();
            for (File f : todayFiles(dir)) {
                String s = readAll(f);
                if (!s.isEmpty()) {
                    sb.append(s);
                    if (!s.endsWith("\n")) sb.append("\n");
                }
            }
            return sb.toString();
        } catch (Throwable t) {
            return "";
        }
    }

    /** 今天所有日志文件（含超限续写的 -2、-3…），按序号从早到晚 */
    private static List<File> todayFiles(File dir) {
        List<File> out = new ArrayList<File>();
        try {
            String base = FILE_PREFIX + todayStr();
            File[] all = dir.listFiles();
            if (all != null) {
                for (File f : all) {
                    String n = f.getName();
                    if (n.equals(base + ".txt") || n.startsWith(base + "-")) out.add(f);
                }
            }
            // 主文件（无序号）在最前，之后按 -2、-3… 排
            java.util.Collections.sort(out, new java.util.Comparator<File>() {
                @Override public int compare(File a, File b) {
                    return Integer.compare(seqOf(a), seqOf(b));
                }
            });
        } catch (Throwable ignored) { }
        return out;
    }

    /** 从 错误日志-2026-10-01-2.txt 里取出序号 2；主文件算 1 */
    private static int seqOf(File f) {
        try {
            String n = f.getName();
            int dot = n.lastIndexOf('.');
            if (dot > 0) n = n.substring(0, dot);
            int dash = n.lastIndexOf('-');
            if (dash > 10) {                       // 避开日期里的横线
                String tail = n.substring(dash + 1);
                if (tail.matches("\\d+")) return Integer.parseInt(tail);
            }
        } catch (Throwable ignored) { }
        return 1;
    }

    private static String readAll(File f) {
        FileInputStream in = null;
        try {
            in = new FileInputStream(f);
            byte[] buf = new byte[8192];
            StringBuilder sb = new StringBuilder();
            int r;
            while ((r = in.read(buf)) > 0) sb.append(new String(buf, 0, r, "UTF-8"));
            return sb.toString();
        } catch (Throwable t) {
            return "";
        } finally {
            close(in);
        }
    }

    /* ==================================================================
     *  导出（用户点按钮后，自己选「分享」还是「保存到本地」）
     * ================================================================== */

    /**
     * 把今天的日志拼成一份带抬头的可读文本。
     * 抬头补上「设备 / 版本 / 日期」—— 流水账只记「出了什么事」，
     * 发给别人时对方还需要知道「这是什么设备、什么版本」。
     */
    private static String buildExportText(Context ctx) {
        String today = readToday(ctx);
        StringBuilder sb = new StringBuilder();
        sb.append("githup 错误日志\n");
        sb.append("================\n");
        sb.append("这是今天（").append(todayStr()).append("）记下来的问题。\n");
        sb.append("只记今天，明天自动从头开始。\n\n");
        sb.append("设备：").append(Build.MANUFACTURER).append(" ").append(Build.MODEL)
                .append("，Android ").append(Build.VERSION.RELEASE).append("\n");
        sb.append("版本：").append(versionOf(ctx)).append("\n");
        sb.append("------------------------\n\n");

        if (today.trim().isEmpty()) {
            sb.append("今天没有记录到任何问题。\n");
        } else {
            sb.append(today);
            if (!today.endsWith("\n")) sb.append("\n");
        }
        return sb.toString();
    }

    /**
     * 「保存到本地」：把日志写成文件放进 Download/githup/错误日志/。
     * 写不进公共目录就退应用私有目录（至少把这份导出留住）。
     *
     * @return 成功落盘返回 true
     */
    static boolean save(Context ctx) {
        if (ctx == null) return false;
        try {
            String content = buildExportText(ctx);
            if (writeExportToPublic(ctx, content)) return true;

            File dir = logDir(ctx);
            if (dir == null) return false;
            if (!dir.exists() && !dir.mkdirs()) return false;
            File out = new File(dir, "错误日志导出-" + todayStr() + ".txt");
            FileOutputStream fos = null;
            try {
                fos = new FileOutputStream(out, false);
                fos.write(content.getBytes("UTF-8"));
                fos.flush();
            } finally {
                close(fos);
            }
            cleanExports(dir);
            return true;
        } catch (Throwable t) {
            return false;
        }
    }

    /**
     * 「分享」：准备一份可交给外部应用的副本，返回它的 content Uri。
     *
     * 为什么不直接把公共目录那份分享出去 ——
     *   Android 7 起 file:// 不能直接交给外部应用（FileUriExposedException），
     *   分享必须走 LogProvider（FileProvider），而它只暴露私有 exports/ 目录；
     *   另外 content uri 里带中文文件名，个别接收方处理不了，所以副本用纯
     *   ASCII 名 githup-errorlog-<日期>.txt。
     *
     * @return 分享用 Uri；写不出来返回 null。
     */
    static android.net.Uri share(Context ctx) {
        if (ctx == null) return null;
        try {
            return writeShareCopy(ctx, buildExportText(ctx));
        } catch (Throwable t) {
            return null;
        }
    }

    /**
     * 兼容旧调用：先保存、再返回分享 Uri（供「既存又分享」的场景）。
     */
    static android.net.Uri export(Context ctx) {
        if (ctx == null) return null;
        try {
            save(ctx);
            return share(ctx);
        } catch (Throwable t) {
            return null;
        }
    }

    /**
     * 把导出内容写进私有 exports/ 目录，返回 LogProvider 的分享 Uri。
     * 文件名用纯 ASCII：content uri 的 path 段里出现中文（未编码），
     * 微信、邮件这类接收方有的会直接拒收。
     */
    private static android.net.Uri writeShareCopy(Context ctx, String content) {
        FileOutputStream fos = null;
        try {
            File dir = new File(ctx.getFilesDir(), "exports");
            if (!dir.exists() && !dir.mkdirs()) return null;
            String name = "githup-errorlog-" + todayStr() + ".txt";
            File f = new File(dir, name);
            fos = new FileOutputStream(f, false);
            fos.write(content.getBytes("UTF-8"));
            fos.flush();
            return LogProvider.uriFor(
                    ctx.getPackageName() + LogProvider.AUTHORITY_SUFFIX, name);
        } catch (Throwable t) {
            return null;
        } finally {
            close(fos);
        }
    }

    /** 把导出文件写进公共目录（MediaStore） */
    private static boolean writeExportToPublic(Context ctx, String content) {
        try {
            if (Build.VERSION.SDK_INT < 29) {
                File pub = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS);
                if (pub == null) return false;
                File dir = new File(pub, PUBLIC_SUBDIR);
                if (!dir.exists() && !dir.mkdirs()) return false;
                File f = new File(dir, "错误日志导出-" + todayStr() + ".txt");
                FileOutputStream fos = null;
                try {
                    fos = new FileOutputStream(f, false);
                    fos.write(content.getBytes("UTF-8"));
                    fos.flush();
                } finally {
                    close(fos);
                }
                return true;
            }

            android.content.ContentResolver cr = ctx.getContentResolver();
            if (cr == null) return false;
            android.net.Uri parent = android.provider.MediaStore.Downloads.EXTERNAL_CONTENT_URI;
            String name = "错误日志导出-" + todayStr() + ".txt";

            /* 先删掉今天可能已存在的同名导出（重复点按钮时覆盖，
             * 而不是越攒越多）。 */
            try {
                cr.delete(parent,
                        android.provider.MediaStore.MediaColumns.DISPLAY_NAME + "=?",
                        new String[]{name});
            } catch (Throwable ignored) { }

            android.content.ContentValues cv = new android.content.ContentValues();
            cv.put(android.provider.MediaStore.MediaColumns.DISPLAY_NAME, name);
            cv.put(android.provider.MediaStore.MediaColumns.MIME_TYPE, "text/plain");
            cv.put(android.provider.MediaStore.MediaColumns.RELATIVE_PATH, PUBLIC_RELATIVE);
            cv.put(android.provider.MediaStore.MediaColumns.IS_PENDING, 1);

            android.net.Uri item = cr.insert(parent, cv);
            if (item == null) return false;

            java.io.OutputStream os = null;
            try {
                os = cr.openOutputStream(item, "wt");
                if (os == null) return false;
                os.write(content.getBytes("UTF-8"));
                os.flush();
            } finally {
                close(os);
            }

            android.content.ContentValues done = new android.content.ContentValues();
            done.put(android.provider.MediaStore.MediaColumns.IS_PENDING, 0);
            try { cr.update(item, done, null, null); } catch (Throwable ignored) { }
            return true;
        } catch (Throwable t) {
            return false;
        }
    }

    /** 导出文件只留最近 3 份 */
    private static void cleanExports(File dir) {
        try {
            File[] all = dir.listFiles();
            if (all == null) return;
            List<File> exps = new ArrayList<File>();
            for (File f : all) {
                if (f.isFile() && f.getName().startsWith("错误日志导出-")) exps.add(f);
            }
            if (exps.size() <= 3) return;
            java.util.Collections.sort(exps, new java.util.Comparator<File>() {
                @Override public int compare(File a, File b) {
                    return Long.compare(b.lastModified(), a.lastModified());
                }
            });
            for (int i = 3; i < exps.size(); i++) {
                try { exps.get(i).delete(); } catch (Throwable ignored) { }
            }
        } catch (Throwable ignored) { }
    }

    /* ==================================================================
     *  小工具
     * ================================================================== */

    private static String versionOf(Context ctx) {
        try {
            android.content.pm.PackageInfo pi =
                    ctx.getPackageManager().getPackageInfo(ctx.getPackageName(), 0);
            return pi.versionName + " (" + pi.versionCode + ")";
        } catch (Throwable t) {
            return "?";
        }
    }

    private static String todayStr() {
        return new SimpleDateFormat("yyyy-MM-dd", Locale.US).format(new Date());
    }

    private static String stamp() {
        return "[" + new SimpleDateFormat("HH:mm:ss", Locale.US).format(new Date()) + "]";
    }

    private static String nz(String s, String def) {
        return (s == null || s.isEmpty()) ? def : s;
    }

    private static boolean isBlank(String s) {
        return s == null || s.trim().isEmpty();
    }

    private static void close(java.io.Closeable c) {
        if (c == null) return;
        try { c.close(); } catch (Throwable ignored) { }
    }
}
